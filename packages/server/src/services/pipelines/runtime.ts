import { randomUUID } from "node:crypto";

import { logger } from "../../utils/logger";
import * as scheduledRunner from "../scheduledQueries/runner";
import * as scheduledStore from "../scheduledQueries/store";
import type { JobInput } from "../scheduledQueries/store";
import type { PipelineConcurrencyPolicy, PipelineTriggerType, VisualPipelineDeploymentRow } from "./types";
import * as pipelineStore from "./store";

export class PipelineBusyError extends Error {
  constructor(message = "A pipeline execution is already running") {
    super(message);
    this.name = "PipelineBusyError";
  }
}

function numberConfig(config: Record<string, unknown> | null, key: string, fallback: number): number {
  const value = config?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringConfig(config: Record<string, unknown> | null, key: string, fallback: string): string {
  const value = config?.[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function deploymentConcurrencyPolicy(deployment: VisualPipelineDeploymentRow): PipelineConcurrencyPolicy {
  const value = deployment.triggerConfig?.concurrencyPolicy;
  return value === "queue_one" || value === "allow_parallel" ? value : "do_not_overlap";
}

export function runtimeJobInput(
  name: string,
  description: string | null,
  deployment: Pick<VisualPipelineDeploymentRow, "connectionId" | "triggerType" | "triggerConfig" | "artifact">,
): JobInput {
  const scheduled = deployment.triggerType === "schedule" || deployment.triggerType === "refreshable_mv";
  const configuredFrequency = stringConfig(deployment.triggerConfig, "frequency", "cron");
  const frequency: JobInput["frequency"] = scheduled && ["daily", "weekly", "monthly", "cron"].includes(configuredFrequency)
    ? configuredFrequency as JobInput["frequency"]
    : scheduled ? "cron" : "manual";
  return {
    name: `[Pipeline] ${name}`,
    description,
    connectionId: deployment.connectionId,
    query: deployment.artifact.runtimeSql,
    enabled: scheduled,
    frequency,
    hour: numberConfig(deployment.triggerConfig, "hour", 0),
    dayOfWeek: numberConfig(deployment.triggerConfig, "dayOfWeek", 1),
    dayOfMonth: numberConfig(deployment.triggerConfig, "dayOfMonth", 1),
    cronExpr: frequency === "cron" ? stringConfig(deployment.triggerConfig, "cronExpr", "0 * * * *") : null,
    timezone: stringConfig(deployment.triggerConfig, "timezone", "UTC"),
    outputMode: deployment.artifact.destination.writeMode,
    destDatabase: deployment.artifact.destination.database,
    destTable: deployment.artifact.destination.table,
    outputConfig: { expectedSchema: deployment.artifact.outputColumns },
    maxRows: 1000,
    timeoutSecs: Math.min(3600, Math.max(5, numberConfig(deployment.triggerConfig, "timeoutSecs", 300))),
    useFinal: false,
    seqConsistency: false,
    maxAttempts: Math.min(10, Math.max(1, numberConfig(deployment.triggerConfig, "maxAttempts", 2))),
    retentionDays: Math.min(3650, Math.max(1, numberConfig(deployment.triggerConfig, "retentionDays", 90))),
  };
}

export async function createRuntimeJob(
  name: string,
  description: string | null,
  deployment: Pick<VisualPipelineDeploymentRow, "connectionId" | "triggerType" | "triggerConfig" | "artifact">,
  actorId: string | null,
): Promise<string> {
  return scheduledStore.createJob(runtimeJobInput(name, description, deployment), actorId, "visual_pipeline");
}

export interface PipelineExecutionRequest {
  actorId: string | null;
  triggerType: PipelineTriggerType | "scheduled";
  triggerPayload: Record<string, unknown> | null;
  externalEventId: string | null;
  externalEventRecordId?: string | null;
  slotAt?: number;
  attempt?: number;
}

export interface PipelineExecutionResult {
  queued: boolean;
  run: Awaited<ReturnType<typeof scheduledRunner.execute>>;
}

export async function executeDeployment(
  deployment: VisualPipelineDeploymentRow,
  request: PipelineExecutionRequest,
): Promise<PipelineExecutionResult> {
  if (!deployment.runtimeJobId) throw new Error("This deployment has no executable runtime job");
  const job = await scheduledStore.getJob(deployment.runtimeJobId);
  if (!job) throw new Error("The pipeline runtime job no longer exists");
  const policy = deploymentConcurrencyPolicy(deployment);
  const token = randomUUID();
  const queuedPayload = policy === "queue_one" ? {
    actorId: request.actorId,
    triggerType: request.triggerType,
    triggerPayload: request.triggerPayload,
    externalEventId: request.externalEventId,
    externalEventRecordId: request.externalEventRecordId,
    slotAt: request.slotAt,
    attempt: request.attempt,
  } : null;
  if (policy !== "allow_parallel") {
    const lease = await pipelineStore.acquireRunLease(
      deployment.pipelineId,
      token,
      Date.now() + job.timeoutSecs * 2 * 1000,
      queuedPayload,
    );
    if (lease === "queued") {
      if (request.externalEventRecordId) await pipelineStore.updateExternalEventStatus(request.externalEventRecordId, "QUEUED");
      return { queued: true, run: null };
    }
    if (lease === "busy") throw new PipelineBusyError();
  }

  let queued: Record<string, unknown> | null = null;
  try {
    const trigger = request.triggerType === "scheduled" ? "scheduled" : request.triggerType === "webhook" ? "event" : "manual";
    const run = await scheduledRunner.execute(job, { trigger, slotAt: request.slotAt ?? Date.now(), attempt: request.attempt ?? 1 });
    if (run) {
      await pipelineStore.linkRun({
        runId: run.id,
        pipelineId: deployment.pipelineId,
        versionId: deployment.versionId,
        deploymentId: deployment.id,
        actorId: request.actorId,
        triggerType: request.triggerType,
        triggerPayload: request.triggerPayload,
        externalEventId: request.externalEventId,
        generatedSql: deployment.artifact.sql,
      });
      if (request.externalEventRecordId) {
        await pipelineStore.updateExternalEventStatus(request.externalEventRecordId, run.status === "success" ? "PROCESSED" : "FAILED");
      }
    }
    return { queued: false, run };
  } finally {
    if (policy !== "allow_parallel") queued = await pipelineStore.releaseRunLease(deployment.pipelineId, token);
    if (queued) {
      const next: PipelineExecutionRequest = {
        actorId: typeof queued.actorId === "string" ? queued.actorId : null,
        triggerType: typeof queued.triggerType === "string" ? queued.triggerType as PipelineExecutionRequest["triggerType"] : "manual",
        triggerPayload: queued.triggerPayload && typeof queued.triggerPayload === "object" ? queued.triggerPayload as Record<string, unknown> : null,
        externalEventId: typeof queued.externalEventId === "string" ? queued.externalEventId : null,
        externalEventRecordId: typeof queued.externalEventRecordId === "string" ? queued.externalEventRecordId : null,
        slotAt: typeof queued.slotAt === "number" ? queued.slotAt : undefined,
        attempt: typeof queued.attempt === "number" ? queued.attempt : undefined,
      };
      void executeDeployment(deployment, next).catch((error) => {
        logger.error({ module: "VisualPipelines", pipelineId: deployment.pipelineId, error: error instanceof Error ? error.message : String(error) }, "Queued pipeline run failed");
      });
    }
  }
}
