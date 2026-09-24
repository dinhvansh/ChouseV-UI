import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import { checkTableAccess } from "../middleware/dataAccess";
import { rbacAuthMiddleware, requirePermission, getRbacUser } from "../rbac/middleware/rbacAuth";
import { AUDIT_ACTIONS, PERMISSIONS, SYSTEM_ROLES } from "../rbac/schema/base";
import { getUserConnections } from "../rbac/services/connections";
import { decryptSecret, encryptSecret } from "../rbac/services/connections";
import { createAuditLogWithContext } from "../rbac/services/rbac";
import { compilePipeline, PipelineCompileError, renderPipelineRuntimeSql } from "../services/pipelines/compiler";
import { pipelineDefinitionHash } from "../services/pipelines/canonical";
import { pipelineDefinitionSchema, type PipelineColumn, type PipelineDefinition } from "../services/pipelines/definition";
import * as store from "../services/pipelines/store";
import * as pipelineRuntime from "../services/pipelines/runtime";
import { syncNativeRunHistory } from "../services/pipelines/nativeHistory";
import type { PipelineArtifact, PipelineConcurrencyPolicy, PipelineTriggerType, VisualPipelineDeploymentRow, VisualPipelineVersionRow } from "../services/pipelines/types";
import { clientForConnection } from "../services/scheduledQueries/chClient";
import * as scheduledStore from "../services/scheduledQueries/store";
import { escapeIdentifier, escapeQualifiedIdentifier, validateColumnType } from "../utils/sqlIdentifier";
import { logger } from "../utils/logger";
import { AppError, requireParam } from "../types";

const pipelines = new Hono();

pipelines.post("/:id/webhook/airbyte", async (c) => handleAirbyteWebhook(c));

// The webhook is authenticated with its deployment secret instead of a user
// session. Register it before the RBAC middleware so machine callbacks can use
// this one narrowly scoped route.
pipelines.post("/:id/webhook", async (c) => handlePipelineWebhook(c));

pipelines.use("*", rbacAuthMiddleware);

const createPipelineSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullish(),
  connectionId: z.string().uuid(),
  definition: pipelineDefinitionSchema,
}).strict();

const updateDraftSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  definition: pipelineDefinitionSchema,
}).strict();

const testSampleSchema = z.object({
  limit: z.number().int().min(1).max(1000).default(100),
}).strict();

const deploymentSchema = z.object({
  versionId: z.string().uuid(),
  triggerType: z.enum(["manual", "schedule", "webhook", "incremental_mv", "refreshable_mv"]),
  concurrencyPolicy: z.enum(["do_not_overlap", "queue_one", "allow_parallel"]).default("do_not_overlap"),
  frequency: z.enum(["daily", "weekly", "monthly", "cron"]).optional(),
  hour: z.number().int().min(0).max(23).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  cronExpr: z.string().trim().min(1).max(200).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  timeoutSecs: z.number().int().min(5).max(3600).default(300),
  maxAttempts: z.number().int().min(1).max(10).default(2),
  retentionDays: z.number().int().min(1).max(3650).default(90),
}).strict();

const rollbackSchema = z.object({ deploymentId: z.string().uuid() }).strict();

const businessMetadataSchema = z.object({
  entityType: z.enum(["pipeline", "table", "column"]),
  entityKey: z.string().trim().min(1).max(500),
  description: z.string().trim().max(4000).nullable().optional(),
  businessOwner: z.string().trim().max(300).nullable().optional(),
  dataOwner: z.string().trim().max(300).nullable().optional(),
  sensitivity: z.string().trim().max(100).nullable().optional(),
  sourceSystem: z.string().trim().max(300).nullable().optional(),
  refreshFrequency: z.string().trim().max(300).nullable().optional(),
  businessDefinition: z.string().trim().max(8000).nullable().optional(),
}).strict();

const webhookPayloadSchema = z.object({
  source: z.string().trim().min(1).max(100),
  status: z.enum(["succeeded", "failed", "cancelled", "incomplete"]),
  external_job_id: z.union([z.string().trim().min(1).max(300), z.number().finite()]).optional(),
  job_id: z.union([z.string().trim().min(1).max(300), z.number().finite()]).optional(),
}).passthrough().refine((value) => value.external_job_id !== undefined || value.job_id !== undefined, {
  message: "external_job_id or job_id is required",
});

const airbytePayloadSchema = z.object({
  data: z.object({
    jobId: z.union([z.string().trim().min(1).max(300), z.number().finite()]),
    success: z.boolean(),
    connection: z.object({ id: z.string().trim().min(1).max(300) }).passthrough().optional(),
  }).passthrough(),
}).passthrough();

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

interface WebhookContext {
  pipelineId: string;
  deployment: VisualPipelineDeploymentRow;
  secret: string;
}

async function loadWebhookContext(c: Context): Promise<WebhookContext> {
  const pipelineId = requireParam(c, "id");
  const deployment = await store.getActiveDeployment(pipelineId);
  if (!deployment || deployment.triggerType !== "webhook" || !deployment.runtimeJobId) {
    throw AppError.notFound("Active webhook pipeline not found");
  }
  const encryptedSecret = await store.getDeploymentWebhookSecret(deployment.id);
  if (!encryptedSecret) throw AppError.unauthorized("Webhook authentication failed");
  return { pipelineId, deployment, secret: decryptSecret(encryptedSecret) };
}

async function dispatchWebhookEvent(
  c: Context,
  context: WebhookContext,
  decoded: Record<string, unknown>,
  payload: z.infer<typeof webhookPayloadSchema>,
  hashMaterial = JSON.stringify(decoded),
): Promise<Response> {
  const { pipelineId, deployment } = context;
  const externalEventId = String(payload.external_job_id ?? payload.job_id);
  const payloadHash = createHash("sha256").update(hashMaterial).digest("hex");
  const source = payload.source.toLowerCase();
  const event = await store.recordExternalEvent({
    pipelineId,
    source,
    externalEventId,
    payloadHash,
    payload: decoded,
    signatureValid: true,
  });
  if (!event.created) {
    const promoted = payload.status === "succeeded" && event.status === "IGNORED"
      ? await store.claimIgnoredExternalEvent(event.id, payloadHash, decoded)
      : false;
    if (!promoted) {
      await store.recordWebhookDelivery({ eventId: event.id, pipelineId, source, externalEventId, payloadHash, outcome: "DUPLICATE" });
      return c.json({ success: true, data: { accepted: false, duplicate: true, externalEventId } });
    }
  }
  if (payload.status !== "succeeded") {
    await store.updateExternalEventStatus(event.id, "IGNORED");
    await store.recordWebhookDelivery({ eventId: event.id, pipelineId, source, externalEventId, payloadHash, outcome: "IGNORED" });
    return c.json({ success: true, data: { accepted: false, duplicate: false, reason: `status_${payload.status}` } });
  }
  await store.recordWebhookDelivery({ eventId: event.id, pipelineId, source, externalEventId, payloadHash, outcome: "ACCEPTED" });
  try {
    const result = await pipelineRuntime.executeDeployment(deployment, {
      actorId: null,
      triggerType: "webhook",
      triggerPayload: decoded,
      externalEventId,
      externalEventRecordId: event.id,
    });
    return c.json({ success: true, data: { accepted: true, duplicate: false, queued: result.queued, runId: result.run?.id ?? null } }, result.queued ? 202 : 200);
  } catch (error) {
    await store.updateExternalEventStatus(event.id, error instanceof pipelineRuntime.PipelineBusyError ? "SKIPPED" : "FAILED");
    if (error instanceof pipelineRuntime.PipelineBusyError) throw AppError.conflict(error.message);
    throw error;
  }
}

async function handlePipelineWebhook(c: Context) {
  const context = await loadWebhookContext(c);
  const { secret } = context;
  const timestampText = c.req.header("x-chouse-timestamp")?.trim() ?? "";
  const timestamp = Number(timestampText);
  if (!Number.isFinite(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) {
    throw AppError.unauthorized("Webhook timestamp is missing or outside the five-minute window");
  }
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
    throw AppError.badRequest("Webhook payload exceeds the 64 KiB limit");
  }
  const rawBody = await c.req.text();
  if (Buffer.byteLength(rawBody, "utf8") > 64 * 1024) {
    throw AppError.badRequest("Webhook payload exceeds the 64 KiB limit");
  }
  const apiKey = c.req.header("x-chouse-api-key")?.trim();
  const suppliedSignature = c.req.header("x-chouse-signature")?.trim().replace(/^sha256=/i, "");
  const expectedSignature = createHmac("sha256", secret).update(`${timestampText}.${rawBody}`).digest("hex");
  const authenticated = Boolean(
    (apiKey && constantTimeTextEqual(apiKey, secret))
    || (suppliedSignature && constantTimeTextEqual(suppliedSignature.toLowerCase(), expectedSignature)),
  );
  if (!authenticated) throw AppError.unauthorized("Webhook authentication failed");

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    throw AppError.badRequest("Webhook body must be valid JSON");
  }
  const payload = webhookPayloadSchema.parse(decoded);
  return dispatchWebhookEvent(c, context, payload, payload, rawBody);
}

async function handleAirbyteWebhook(c: Context) {
  const context = await loadWebhookContext(c);
  const token = c.req.query("token")?.trim() ?? "";
  if (!token || !constantTimeTextEqual(token, context.secret)) {
    throw AppError.unauthorized("Airbyte webhook authentication failed");
  }
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 64 * 1024) throw AppError.badRequest("Webhook payload exceeds the 64 KiB limit");
  const rawBody = await c.req.text();
  if (Buffer.byteLength(rawBody, "utf8") > 64 * 1024) throw AppError.badRequest("Webhook payload exceeds the 64 KiB limit");
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    throw AppError.badRequest("Webhook body must be valid JSON");
  }
  const airbyte = airbytePayloadSchema.parse(decoded);
  const connectionId = airbyte.data.connection?.id ?? "unknown-connection";
  const externalJobId = `airbyte:${connectionId}:${String(airbyte.data.jobId)}`;
  const normalized = webhookPayloadSchema.parse({
    source: "airbyte",
    status: airbyte.data.success ? "succeeded" : "failed",
    external_job_id: externalJobId,
    payload: decoded,
  });
  return dispatchWebhookEvent(c, context, normalized, normalized);
}

function userId(c: Context): string | undefined {
  try {
    return getRbacUser(c).sub;
  } catch {
    return undefined;
  }
}

function isAdmin(c: Context): boolean {
  try {
    const roles = getRbacUser(c).roles;
    return roles.includes(SYSTEM_ROLES.SUPER_ADMIN) || roles.includes(SYSTEM_ROLES.ADMIN);
  } catch {
    return false;
  }
}

function canViewAll(c: Context): boolean {
  if (isAdmin(c)) return true;
  try {
    return getRbacUser(c).permissions.includes(PERMISSIONS.PIPELINES_VIEW_ALL);
  } catch {
    return false;
  }
}

function ownerScope(c: Context): string | null {
  return canViewAll(c) ? null : userId(c) ?? "__none__";
}

async function assertConnectionAccess(c: Context, connectionId: string): Promise<void> {
  if (isAdmin(c)) return;
  const uid = userId(c);
  if (!uid) throw AppError.unauthorized("No authenticated user");
  const connections = await getUserConnections(uid);
  if (!connections.some((connection) => connection.id === connectionId)) {
    throw AppError.forbidden("You do not have access to this connection");
  }
}

async function loadVisiblePipeline(c: Context, id: string) {
  const pipeline = await store.getPipelineDetail(id);
  if (!pipeline || (!canViewAll(c) && pipeline.createdBy !== userId(c))) {
    throw AppError.notFound("Visual pipeline not found");
  }
  return pipeline;
}

async function sourceSchemas(
  c: Context,
  connectionId: string,
  definition: PipelineDefinition,
): Promise<Record<string, PipelineColumn[]>> {
  await assertConnectionAccess(c, connectionId);
  const client = await clientForConnection(
    connectionId,
    JSON.stringify({ rbac_user_id: userId(c) ?? null, source: "visual_pipeline_validation" }),
  );
  const schemas: Record<string, PipelineColumn[]> = {};
  for (const node of definition.nodes) {
    if (node.type !== "source") continue;
    const allowed = await checkTableAccess(
      userId(c),
      isAdmin(c),
      node.config.database,
      node.config.table,
      connectionId,
      "read",
    );
    if (!allowed) throw AppError.forbidden(`Access denied to ${node.config.database}.${node.config.table}`);
    const result = await client.query({
      query: "SELECT name, type FROM system.columns WHERE database = {database:String} AND table = {table:String} ORDER BY position",
      format: "JSON",
      query_params: { database: node.config.database, table: node.config.table },
    });
    const json = await result.json() as { data?: Array<{ name: string; type: string }> };
    const columns = json.data ?? [];
    if (columns.length === 0) {
      throw AppError.badRequest(`Source table ${node.config.database}.${node.config.table} does not exist or has no visible columns`);
    }
    schemas[node.id] = columns;
  }
  return schemas;
}

type DeploymentInput = z.infer<typeof deploymentSchema>;

function triggerConfig(body: DeploymentInput): Record<string, unknown> {
  return {
    concurrencyPolicy: body.concurrencyPolicy,
    timeoutSecs: body.timeoutSecs,
    maxAttempts: body.maxAttempts,
    retentionDays: body.retentionDays,
    ...(body.triggerType === "schedule" || body.triggerType === "refreshable_mv" ? {
      frequency: body.frequency ?? "cron",
      hour: body.hour ?? 0,
      dayOfWeek: body.dayOfWeek ?? 1,
      dayOfMonth: body.dayOfMonth ?? 1,
      cronExpr: body.cronExpr ?? "0 * * * *",
      timezone: body.timezone ?? "UTC",
      implementation: body.triggerType === "refreshable_mv" ? "scheduled_fallback" : "scheduler",
    } : {}),
  };
}

async function cleanupDeploymentRuntime(deployment: VisualPipelineDeploymentRow): Promise<void> {
  if (deployment.runtimeJobId) await scheduledStore.setJobEnabled(deployment.runtimeJobId, false);
  if (deployment.nativeObjectName) {
    const client = await clientForConnection(deployment.connectionId, JSON.stringify({ source: "visual_pipeline_retire", pipeline_id: deployment.pipelineId }));
    await client.command({
      query: `DROP VIEW IF EXISTS ${escapeQualifiedIdentifier([deployment.artifact.destination.database, deployment.nativeObjectName])}`,
    });
  }
}

function createDestinationTableSql(artifact: PipelineArtifact): string {
  if (artifact.outputColumns.length === 0) throw AppError.badRequest("A destination table cannot be created without output columns");
  const columns = artifact.outputColumns.map((column) => {
    if (!validateColumnType(column.type)) {
      throw AppError.badRequest(`Unsupported generated destination type: ${column.type}`);
    }
    return `  ${escapeIdentifier(column.name)} ${column.type}`;
  });
  return `CREATE TABLE IF NOT EXISTS ${escapeQualifiedIdentifier([artifact.destination.database, artifact.destination.table])} (\n${columns.join(",\n")}\n) ENGINE = MergeTree\nORDER BY tuple()`;
}

async function ensureManagedDestination(c: Context, connectionId: string, artifact: PipelineArtifact): Promise<void> {
  if (artifact.destination.createIfMissing !== true) return;
  const user = getRbacUser(c);
  if (!isAdmin(c) && !user.permissions.includes(PERMISSIONS.TABLE_CREATE)) {
    throw AppError.forbidden("Creating a pipeline destination requires the table:create permission");
  }
  const client = await clientForConnection(
    connectionId,
    JSON.stringify({ rbac_user_id: userId(c) ?? null, source: "visual_pipeline_destination_create" }),
  );
  await client.command({ query: createDestinationTableSql(artifact) });
}

async function deployPipelineVersion(
  c: Context,
  pipeline: Awaited<ReturnType<typeof loadVisiblePipeline>>,
  version: VisualPipelineVersionRow,
  body: DeploymentInput,
  artifactOverride?: PipelineArtifact,
): Promise<{ deployment: VisualPipelineDeploymentRow; webhookSecret: string | null; warnings: string[] }> {
  if (!version || version.pipelineId !== pipeline.id) throw AppError.notFound("Pipeline version not found");
  if (!["TESTED", "DEPLOYED"].includes(version.status)) {
    throw AppError.conflict("Only a tested pipeline version can be deployed");
  }
  const currentDefinitionHash = pipelineDefinitionHash(version.definition);
  if (currentDefinitionHash !== version.definitionHash) {
    throw AppError.conflict("Pipeline version integrity check failed; create and validate a new draft");
  }
  const destination = version.definition.nodes.find((node) => node.type === "destination");
  if (!destination || destination.type !== "destination") throw AppError.badRequest("Pipeline destination is missing");
  const destinationAllowed = await checkTableAccess(
    userId(c),
    isAdmin(c),
    destination.config.database,
    destination.config.table,
    pipeline.connectionId,
    "write",
  );
  if (!destinationAllowed) throw AppError.forbidden(`Write access denied to ${destination.config.database}.${destination.config.table}`);
  if (body.triggerType === "incremental_mv") {
    const unsafe = version.definition.nodes.find((node) => ["join", "union", "deduplicate", "sort", "window"].includes(node.type));
    if (unsafe) throw AppError.badRequest(`${unsafe.type} is not safe for inserted-block incremental materialized view semantics`);
    if (destination.config.writeMode !== "append") {
      throw AppError.badRequest("Incremental materialized views require append write mode");
    }
  }
  const artifact: PipelineArtifact = artifactOverride ?? await (async () => {
    const schemas = await sourceSchemas(c, pipeline.connectionId, version.definition);
    const compiled = compilePipeline(version.definition, { sourceSchemas: schemas });
    if (
      compiled.compilerVersion !== version.compilerVersion
      || compiled.sql !== version.generatedSql
      || JSON.stringify(compiled.outputColumns) !== JSON.stringify(version.outputSchema)
    ) {
      throw AppError.conflict("Source schema or compiler output changed after testing; create and validate a new draft");
    }
    return {
      compilerVersion: compiled.compilerVersion,
      definitionHash: version.definitionHash,
      sql: compiled.sql,
      runtimeSql: renderPipelineRuntimeSql(compiled),
      parameters: compiled.parameters,
      outputColumns: compiled.outputColumns,
      lineage: compiled.lineage,
      destination: compiled.destination,
    };
  })();
  if (artifact.definitionHash !== version.definitionHash) {
    throw AppError.conflict("Deployment artifact does not match the selected pipeline version");
  }
  await ensureManagedDestination(c, pipeline.connectionId, artifact);
  const artifactChecksum = createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
  const config = triggerConfig(body);
  let runtimeJobId: string | null = null;
  let nativeObjectName: string | null = null;
  let nativeObjectUuid: string | null = null;
  let webhookSecret: string | null = null;
  const runtimeShape = {
    connectionId: pipeline.connectionId,
    triggerType: body.triggerType as PipelineTriggerType,
    triggerConfig: config,
    artifact,
  };
  if (body.triggerType === "incremental_mv") {
    nativeObjectName = `vp_${pipeline.id.replace(/-/g, "").slice(0, 12)}_v${version.versionNumber}`;
    const client = await clientForConnection(pipeline.connectionId, JSON.stringify({ rbac_user_id: userId(c) ?? null, source: "visual_pipeline_deploy", pipeline_id: pipeline.id }));
    await client.command({
      query: `CREATE MATERIALIZED VIEW ${escapeQualifiedIdentifier([artifact.destination.database, nativeObjectName])} TO ${escapeQualifiedIdentifier([artifact.destination.database, artifact.destination.table])} AS\n${artifact.runtimeSql}`,
    });
    const uuidResult = await client.query({
      query: "SELECT toString(uuid) AS uuid FROM system.tables WHERE database = {database:String} AND name = {name:String} LIMIT 1",
      format: "JSON",
      query_params: { database: artifact.destination.database, name: nativeObjectName },
    });
    const uuidJson = await uuidResult.json() as { data?: Array<{ uuid?: string }> };
    nativeObjectUuid = uuidJson.data?.[0]?.uuid ?? null;
  } else {
    runtimeJobId = await pipelineRuntime.createRuntimeJob(pipeline.name, pipeline.description, runtimeShape, userId(c) ?? null);
  }
  if (body.triggerType === "webhook") webhookSecret = randomBytes(32).toString("hex");
  const previous = await store.getActiveDeployment(pipeline.id);
  let deployment: VisualPipelineDeploymentRow;
  try {
    deployment = await store.activateDeployment({
      pipelineId: pipeline.id,
      versionId: version.id,
      connectionId: pipeline.connectionId,
      triggerType: body.triggerType,
      triggerConfig: config,
      artifact,
      artifactChecksum,
      runtimeJobId,
      nativeObjectName,
      nativeObjectUuid,
      webhookSecretEncrypted: webhookSecret ? encryptSecret(webhookSecret) : null,
      deployedBy: userId(c) ?? null,
    });
  } catch (error) {
    if (runtimeJobId) await scheduledStore.deleteJob(runtimeJobId);
    if (nativeObjectName) {
      const client = await clientForConnection(pipeline.connectionId);
      await client.command({ query: `DROP VIEW IF EXISTS ${escapeQualifiedIdentifier([artifact.destination.database, nativeObjectName])}` });
    }
    throw error;
  }
  const warnings: string[] = [];
  if (previous) {
    try {
      await cleanupDeploymentRuntime(previous);
    } catch (error) {
      const message = "The new deployment is active, but cleanup of the previous runtime failed; retire the old runtime manually.";
      warnings.push(message);
      logger.error({
        module: "VisualPipelines",
        pipelineId: pipeline.id,
        deploymentId: deployment.id,
        previousDeploymentId: previous.id,
        error: error instanceof Error ? error.message : String(error),
      }, message);
    }
  }
  return { deployment, webhookSecret, warnings };
}

pipelines.get("/", requirePermission(PERMISSIONS.PIPELINES_VIEW), async (c) => {
  const rows = await store.listPipelines(ownerScope(c));
  return c.json({ success: true, data: { pipelines: rows } });
});

pipelines.post(
  "/",
  requirePermission(PERMISSIONS.PIPELINES_EDIT),
  zValidator("json", createPipelineSchema),
  async (c) => {
    const body = c.req.valid("json");
    await assertConnectionAccess(c, body.connectionId);
    const created = await store.createPipeline({
      name: body.name,
      description: body.description ?? null,
      connectionId: body.connectionId,
      definition: body.definition,
      createdBy: userId(c) ?? null,
    });
    await createAuditLogWithContext(c, AUDIT_ACTIONS.PIPELINE_CREATE, userId(c), {
      resourceType: "visual_pipeline",
      resourceId: created.id,
      details: { connectionId: created.connectionId, definitionHash: created.draft?.definitionHash },
    });
    return c.json({ success: true, data: created }, 201);
  },
);

pipelines.get("/:id", requirePermission(PERMISSIONS.PIPELINES_VIEW), async (c) => {
  const pipeline = await loadVisiblePipeline(c, requireParam(c, "id"));
  return c.json({ success: true, data: pipeline });
});

pipelines.get("/:id/versions", requirePermission(PERMISSIONS.PIPELINES_VIEW), async (c) => {
  const pipeline = await loadVisiblePipeline(c, requireParam(c, "id"));
  const versions = await store.listVersions(pipeline.id);
  return c.json({ success: true, data: { versions } });
});

pipelines.get("/:id/deployments", requirePermission(PERMISSIONS.PIPELINES_VIEW), async (c) => {
  const pipeline = await loadVisiblePipeline(c, requireParam(c, "id"));
  return c.json({ success: true, data: { deployments: await store.listDeployments(pipeline.id) } });
});

pipelines.get("/:id/schema-mapping", requirePermission(PERMISSIONS.PIPELINES_VIEW), async (c) => {
  const pipeline = await loadVisiblePipeline(c, requireParam(c, "id"));
  const version = pipeline.draft;
  if (!version) throw AppError.notFound("Pipeline version not found");
  const destination = version.definition.nodes.find((node) => node.type === "destination");
  if (!destination || destination.type !== "destination") throw AppError.badRequest("Pipeline destination is missing");
  const allowed = await checkTableAccess(userId(c), isAdmin(c), destination.config.database, destination.config.table, pipeline.connectionId, "write");
  if (!allowed) throw AppError.forbidden(`Write access denied to ${destination.config.database}.${destination.config.table}`);
  const client = await clientForConnection(pipeline.connectionId, JSON.stringify({ source: "visual_pipeline_schema_mapping", pipeline_id: pipeline.id }));
  const result = await client.query({
    query: "SELECT name, type FROM system.columns WHERE database = {database:String} AND table = {table:String} ORDER BY position",
    format: "JSON",
    query_params: { database: destination.config.database, table: destination.config.table },
    clickhouse_settings: { readonly: "1", max_execution_time: 10, max_result_rows: "10000" },
  });
  const json = await result.json() as { data?: PipelineColumn[] };
  const destinationColumns = json.data ?? [];
  const outputColumns = version.outputSchema ?? [];
  const willCreate = destination.config.createIfMissing === true && destinationColumns.length === 0;
  const mapping = outputColumns.map((column) => {
    const target = willCreate ? column : destinationColumns.find((candidate) => candidate.name === column.name);
    return {
      source: column,
      destination: target ?? null,
      status: willCreate ? "will_create" : !target ? "missing" : target.type === column.type ? "matched" : "type_mismatch",
      suggestedCast: target && target.type !== column.type ? target.type : null,
    };
  });
  return c.json({ success: true, data: { outputColumns, destinationColumns, mapping } });
});

pipelines.get("/:id/runs", requirePermission(PERMISSIONS.PIPELINES_VIEW), async (c) => {
  const pipeline = await loadVisiblePipeline(c, requireParam(c, "id"));
  const limit = Math.min(200, Math.max(1, Number.parseInt(c.req.query("limit") ?? "50", 10) || 50));
  const offset = Math.max(0, Number.parseInt(c.req.query("offset") ?? "0", 10) || 0);
  const deployments = await store.listDeployments(pipeline.id);
  await Promise.all(deployments.filter((deployment) => deployment.nativeObjectUuid).map(async (deployment) => {
    try {
      await syncNativeRunHistory(deployment);
    } catch {
      // Query-view logging can be disabled or unavailable on older ClickHouse
      // releases. Existing observations remain readable in that case.
    }
  }));
  const nativeRuns = (await Promise.all(
    deployments.filter((deployment) => deployment.nativeObjectName).map((deployment) => store.listNativeRuns(deployment.id, limit)),
  )).flat().sort((left, right) => right.eventTimeMs - left.eventTimeMs).slice(0, limit);
  const runs = (await store.listPipelineRuns(pipeline.id, limit, offset)).map((run) => ({ ...run, historySource: "control_plane" as const }));
  const webhookDeliveries = await store.listWebhookDeliveries(pipeline.id, limit, offset);
  return c.json({
    success: true,
    data: { runs, webhookDeliveries, nativeRuns: nativeRuns.map((run) => ({ ...run, historySource: "clickhouse_query_views_log" as const })) },
  });
});

pipelines.get("/:id/metadata", requirePermission(PERMISSIONS.PIPELINES_VIEW), async (c) => {
  const pipeline = await loadVisiblePipeline(c, requireParam(c, "id"));
  return c.json({ success: true, data: { metadata: await store.listBusinessMetadata(pipeline.id) } });
});

pipelines.put(
  "/:id/metadata",
  requirePermission(PERMISSIONS.PIPELINES_METADATA),
  zValidator("json", businessMetadataSchema),
  async (c) => {
    const pipeline = await loadVisiblePipeline(c, requireParam(c, "id"));
    const body = c.req.valid("json");
    const metadata = await store.upsertBusinessMetadata({
      pipelineId: pipeline.id,
      entityType: body.entityType,
      entityKey: body.entityKey,
      description: body.description ?? null,
      businessOwner: body.businessOwner ?? null,
      dataOwner: body.dataOwner ?? null,
      sensitivity: body.sensitivity ?? null,
      sourceSystem: body.sourceSystem ?? null,
      refreshFrequency: body.refreshFrequency ?? null,
      businessDefinition: body.businessDefinition ?? null,
    });
    await createAuditLogWithContext(c, AUDIT_ACTIONS.PIPELINE_METADATA_UPDATE, userId(c), {
      resourceType: "visual_pipeline_metadata",
      resourceId: metadata.id,
      details: { pipelineId: pipeline.id, entityType: metadata.entityType, entityKey: metadata.entityKey },
    });
    return c.json({ success: true, data: metadata });
  },
);

pipelines.delete("/:id/metadata/:metadataId", requirePermission(PERMISSIONS.PIPELINES_METADATA), async (c) => {
  const pipeline = await loadVisiblePipeline(c, requireParam(c, "id"));
  const metadataId = requireParam(c, "metadataId");
  const deleted = await store.deleteBusinessMetadata(pipeline.id, metadataId);
  if (!deleted) throw AppError.notFound("Pipeline metadata not found");
  await createAuditLogWithContext(c, AUDIT_ACTIONS.PIPELINE_METADATA_UPDATE, userId(c), {
    resourceType: "visual_pipeline_metadata",
    resourceId: metadataId,
    details: { pipelineId: pipeline.id, deleted: true },
  });
  return c.json({ success: true, data: { deleted: true } });
});

pipelines.patch(
  "/:id/draft",
  requirePermission(PERMISSIONS.PIPELINES_EDIT),
  zValidator("json", updateDraftSchema),
  async (c) => {
    const pipeline = await loadVisiblePipeline(c, requireParam(c, "id"));
    if (!pipeline.draft || pipeline.draft.status !== "DRAFT") {
      throw AppError.conflict("The current pipeline version is immutable; create a new draft before editing");
    }
    const body = c.req.valid("json");
    const updated = await store.updateDraft(
      pipeline.id,
      pipeline.draft.id,
      body.definition,
      body.name,
      body.description,
    );
    if (!updated) throw AppError.conflict("The pipeline draft changed while it was being saved");
    await createAuditLogWithContext(c, AUDIT_ACTIONS.PIPELINE_DRAFT_UPDATE, userId(c), {
      resourceType: "visual_pipeline",
      resourceId: pipeline.id,
      details: { versionId: pipeline.draft.id, definitionHash: updated.draft?.definitionHash },
    });
    return c.json({ success: true, data: updated });
  },
);

pipelines.post("/:id/draft", requirePermission(PERMISSIONS.PIPELINES_EDIT), async (c) => {
  const pipeline = await loadVisiblePipeline(c, requireParam(c, "id"));
  if (pipeline.draft?.status === "DRAFT") {
    throw AppError.conflict("This pipeline already has an editable draft");
  }
  const updated = await store.createNextDraft(pipeline.id, userId(c) ?? null);
  if (!updated?.draft) throw AppError.conflict("A new draft could not be created from the current version");
  await createAuditLogWithContext(c, AUDIT_ACTIONS.PIPELINE_VERSION_CREATE, userId(c), {
    resourceType: "visual_pipeline",
    resourceId: pipeline.id,
    details: { versionId: updated.draft.id, versionNumber: updated.draft.versionNumber },
  });
  return c.json({ success: true, data: updated }, 201);
});

pipelines.post("/:id/validate", requirePermission(PERMISSIONS.PIPELINES_TEST), async (c) => {
  const pipeline = await loadVisiblePipeline(c, requireParam(c, "id"));
  if (!pipeline.draft || pipeline.draft.status !== "DRAFT") {
    throw AppError.conflict("Only a draft pipeline can be validated");
  }
  let compiled;
  try {
    const schemas = await sourceSchemas(c, pipeline.connectionId, pipeline.draft.definition);
    compiled = compilePipeline(pipeline.draft.definition, { sourceSchemas: schemas });
  } catch (error) {
    if (error instanceof PipelineCompileError) {
      throw AppError.badRequest("Pipeline validation failed", { diagnostics: error.diagnostics });
    }
    throw error;
  }
  const version = await store.markVersionValidated(pipeline.draft.id, {
    definitionHash: pipelineDefinitionHash(pipeline.draft.definition),
    compilerVersion: compiled.compilerVersion,
    generatedSql: compiled.sql,
    outputSchema: compiled.outputColumns,
    lineage: compiled.lineage,
    diagnostics: compiled.diagnostics,
  });
  if (!version || version.status !== "VALIDATED") {
    throw AppError.conflict("The pipeline draft changed while it was being validated");
  }
  await createAuditLogWithContext(c, AUDIT_ACTIONS.PIPELINE_VALIDATE, userId(c), {
    resourceType: "visual_pipeline",
    resourceId: pipeline.id,
    details: { versionId: version.id, definitionHash: version.definitionHash },
  });
  return c.json({ success: true, data: { version, compiled } });
});

pipelines.post(
  "/:id/test",
  requirePermission(PERMISSIONS.PIPELINES_TEST),
  zValidator("json", testSampleSchema),
  async (c) => {
    const pipeline = await loadVisiblePipeline(c, requireParam(c, "id"));
    if (!pipeline.draft || !["VALIDATED", "TESTED"].includes(pipeline.draft.status)) {
      throw AppError.conflict("Validate and freeze the pipeline version before testing sample data");
    }
    const body = c.req.valid("json");
    const schemas = await sourceSchemas(c, pipeline.connectionId, pipeline.draft.definition);
    const compiled = compilePipeline(pipeline.draft.definition, { sourceSchemas: schemas });
    if (
      compiled.compilerVersion !== pipeline.draft.compilerVersion
      || compiled.sql !== pipeline.draft.generatedSql
      || JSON.stringify(compiled.outputColumns) !== JSON.stringify(pipeline.draft.outputSchema)
    ) {
      throw AppError.conflict("Source schema or compiler output changed after validation; create and validate a new draft");
    }
    const client = await clientForConnection(
      pipeline.connectionId,
      JSON.stringify({ rbac_user_id: userId(c) ?? null, source: "visual_pipeline_sample", pipeline_id: pipeline.id }),
    );
    const queryParams = Object.fromEntries(compiled.parameters.map((parameter) => [parameter.name, parameter.value]));
    const result = await client.query({
      query: `SELECT * FROM (\n${compiled.sql}\n) AS __vp_sample LIMIT {vp_sample_limit:UInt64}`,
      format: "JSON",
      query_params: { ...queryParams, vp_sample_limit: body.limit },
      clickhouse_settings: {
        readonly: "1",
        max_execution_time: 30,
        max_result_rows: String(body.limit),
        max_result_bytes: String(10 * 1024 * 1024),
        max_rows_to_read: "100000000",
        result_overflow_mode: "break",
      },
    });
    const json = await result.json() as {
      data?: Array<Record<string, unknown>>;
      meta?: Array<{ name: string; type: string }>;
      rows?: number;
    };
    const version = await store.markVersionTested(pipeline.draft.id);
    await createAuditLogWithContext(c, AUDIT_ACTIONS.PIPELINE_TEST, userId(c), {
      resourceType: "visual_pipeline",
      resourceId: pipeline.id,
      details: { versionId: pipeline.draft.id, limit: body.limit, returnedRows: json.data?.length ?? 0 },
    });
    return c.json({
      success: true,
      data: {
        version,
        columns: json.meta ?? compiled.outputColumns,
        rows: json.data ?? [],
        limit: body.limit,
        truncated: (json.data?.length ?? 0) >= body.limit,
      },
    });
  },
);

pipelines.post(
  "/:id/deploy",
  requirePermission(PERMISSIONS.PIPELINES_DEPLOY),
  zValidator("json", deploymentSchema),
  async (c) => {
    const pipeline = await loadVisiblePipeline(c, requireParam(c, "id"));
    const body = c.req.valid("json");
    const version = await store.getVersion(body.versionId);
    if (!version) throw AppError.notFound("Pipeline version not found");
    const result = await deployPipelineVersion(c, pipeline, version, body);
    await createAuditLogWithContext(c, AUDIT_ACTIONS.PIPELINE_DEPLOY, userId(c), {
      resourceType: "visual_pipeline",
      resourceId: pipeline.id,
      details: { deploymentId: result.deployment.id, versionId: version.id, triggerType: body.triggerType, artifactChecksum: result.deployment.artifactChecksum },
    });
    return c.json({ success: true, data: result }, 201);
  },
);

pipelines.post(
  "/:id/rollback",
  requirePermission(PERMISSIONS.PIPELINES_DEPLOY),
  zValidator("json", rollbackSchema),
  async (c) => {
    const pipeline = await loadVisiblePipeline(c, requireParam(c, "id"));
    const target = await store.getDeployment(c.req.valid("json").deploymentId);
    if (!target || target.pipelineId !== pipeline.id) throw AppError.notFound("Rollback deployment not found");
    if (target.status === "ACTIVE") throw AppError.conflict("The selected deployment is already active");
    const version = await store.getVersion(target.versionId);
    if (!version) throw AppError.notFound("Rollback version not found");
    const config = target.triggerConfig ?? {};
    const rollbackInput = deploymentSchema.parse({
      versionId: version.id,
      triggerType: target.triggerType,
      concurrencyPolicy: config.concurrencyPolicy ?? "do_not_overlap",
      frequency: config.frequency,
      hour: config.hour,
      dayOfWeek: config.dayOfWeek,
      dayOfMonth: config.dayOfMonth,
      cronExpr: config.cronExpr,
      timezone: config.timezone,
      timeoutSecs: config.timeoutSecs ?? 300,
      maxAttempts: config.maxAttempts ?? 2,
      retentionDays: config.retentionDays ?? 90,
    });
    const checksum = createHash("sha256").update(JSON.stringify(target.artifact)).digest("hex");
    if (checksum !== target.artifactChecksum) throw AppError.conflict("Rollback artifact checksum verification failed");
    const result = await deployPipelineVersion(c, pipeline, version, rollbackInput, target.artifact);
    await createAuditLogWithContext(c, AUDIT_ACTIONS.PIPELINE_ROLLBACK, userId(c), {
      resourceType: "visual_pipeline",
      resourceId: pipeline.id,
      details: { fromDeploymentId: pipeline.activeDeploymentId, targetDeploymentId: target.id, deploymentId: result.deployment.id, versionId: version.id },
    });
    return c.json({ success: true, data: result }, 201);
  },
);

pipelines.post("/:id/run", requirePermission(PERMISSIONS.PIPELINES_RUN), async (c) => {
  const pipeline = await loadVisiblePipeline(c, requireParam(c, "id"));
  const deployment = await store.getActiveDeployment(pipeline.id);
  if (!deployment) throw AppError.conflict("Deploy a tested pipeline version before running it");
  if (!deployment.runtimeJobId) throw AppError.conflict("Incremental materialized views run on inserted blocks and cannot be started manually");
  let result;
  try {
    result = await pipelineRuntime.executeDeployment(deployment, {
      actorId: userId(c) ?? null,
      triggerType: "manual",
      triggerPayload: null,
      externalEventId: null,
    });
  } catch (error) {
    if (error instanceof pipelineRuntime.PipelineBusyError) throw AppError.conflict(error.message);
    throw error;
  }
  await createAuditLogWithContext(c, AUDIT_ACTIONS.PIPELINE_RUN, userId(c), {
    resourceType: "visual_pipeline",
    resourceId: pipeline.id,
    details: { deploymentId: deployment.id, runId: result.run?.id, queued: result.queued },
  });
  return c.json({ success: true, data: result }, result.queued ? 202 : 200);
});

pipelines.post("/:id/retire", requirePermission(PERMISSIONS.PIPELINES_DEPLOY), async (c) => {
  const pipeline = await loadVisiblePipeline(c, requireParam(c, "id"));
  const deployment = await store.getActiveDeployment(pipeline.id);
  if (!deployment) return c.json({ success: true, data: { retired: false } });
  await cleanupDeploymentRuntime(deployment);
  await store.retireDeployment(deployment.id, userId(c) ?? null);
  await createAuditLogWithContext(c, AUDIT_ACTIONS.PIPELINE_DEPLOY, userId(c), {
    resourceType: "visual_pipeline",
    resourceId: pipeline.id,
    details: { deploymentId: deployment.id, retired: true },
  });
  return c.json({ success: true, data: { retired: true } });
});

pipelines.delete("/:id", requirePermission(PERMISSIONS.PIPELINES_DELETE), async (c) => {
  const pipeline = await loadVisiblePipeline(c, requireParam(c, "id"));
  if (pipeline.activeDeploymentId) throw AppError.conflict("Retire the active deployment before archiving this pipeline");
  await store.archivePipeline(pipeline.id);
  await createAuditLogWithContext(c, AUDIT_ACTIONS.PIPELINE_DELETE, userId(c), {
    resourceType: "visual_pipeline",
    resourceId: pipeline.id,
  });
  return c.json({ success: true, data: { archived: true } });
});

export default pipelines;
