/**
 * Unified AI route — the single entry point for the query-scoped structured
 * capabilities (optimize-query, debug-query, check-optimize, optimize-log,
 * diagnose-error, diagnose-parts, diagnose-schema).
 *
 * Frontend calls POST /ai/invoke with { capability, input, modelId }. The route
 * looks the capability up in the registry, enforces its permission, validates
 * input, and runs it through the shared engine. Audit + permission live here.
 *
 * Streaming chat (/ai-chat) and the fleet doctor scan (/fleet/doctor) keep
 * their dedicated routes — different auth surfaces — but share the same engine.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { AppError } from "../types";
import { queryAuthMiddleware, type Variables } from "./query";
import { getCapability, CAPABILITIES, CAPABILITY_IDS } from "../services/ai/capabilities";
import { runStructuredCapability, isStructured } from "../services/ai/engine";
import { isAIEnabled } from "../services/aiConfig";
import type { AgentRunContext } from "../services/ai/types";
import { createAuditLogWithContext, userHasPermission } from "../rbac/services/rbac";
import { AUDIT_ACTIONS, PERMISSIONS } from "../rbac/schema/base";
import type { Permission } from "../rbac/schema/base";
import { getClientIp } from "../rbac/middleware/rbacAuth";
import { requestLogger } from "../utils/logger";
import { getUserConnections } from "../rbac/services/connections";
import { checkTableAccess } from "../middleware/dataAccess";
import { clientForConnection } from "../services/scheduledQueries/chClient";
import * as pipelineStore from "../services/pipelines/store";

const ai = new Hono<{ Variables: Variables }>();

ai.use("*", queryAuthMiddleware);

/** Enforce a capability's RBAC permission against the authenticated user. */
async function requireCapabilityPermission(
  c: Context<{ Variables: Variables }>,
  permission: Permission,
): Promise<void> {
  if (c.get("isRbacAdmin")) return;
  const userId = c.get("rbacUserId");
  if (!userId) throw AppError.unauthorized("RBAC authentication is required.");
  if (c.get("rbacPermissions")?.includes(permission)) return;
  if (await userHasPermission(userId, permission)) return;
  throw AppError.forbidden(`Permission '${permission}' required for this action`);
}

/** Build the engine run context from the authenticated request. */
function buildRunContext(
  c: Context<{ Variables: Variables }>,
  modelId?: string,
): AgentRunContext {
  const session = c.get("session");
  return {
    userId: c.get("rbacUserId"),
    isAdmin: c.get("isRbacAdmin"),
    permissions: c.get("rbacPermissions"),
    connectionId: session?.rbacConnectionId ?? c.get("rbacConnectionId"),
    clickhouseService: c.get("service"),
    defaultDatabase: session?.connectionConfig?.database,
    modelId,
  };
}

/**
 * POST /ai/invoke — run a structured capability.
 * Body: { capability: string, input: object, modelId?: string }
 */
ai.post("/invoke", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { capability?: string; input?: unknown; modelId?: string }
    | null;

  const capId = body?.capability;
  if (!capId) throw AppError.badRequest("'capability' is required");

  const cap = getCapability(capId);
  if (!cap) throw AppError.badRequest(`Unknown capability: ${capId}`);
  if (!isStructured(cap)) {
    throw AppError.badRequest(`Capability '${capId}' is streaming; use its dedicated endpoint.`);
  }

  // Gate optimizer-family capabilities on whether an active AI model is configured.
  // check-optimize degrades softly; debug-query throws — matching prior behavior.
  if ((capId === "check-optimize" || capId === "debug-query") && !(await isAIEnabled().catch(() => false))) {
    if (capId === "check-optimize") {
      return c.json({ success: true, data: { canOptimize: false, reason: "No AI model configured" } });
    }
    throw AppError.badRequest("AI Optimizer is not available — no AI model configured.");
  }

  await requireCapabilityPermission(c, cap.permission);

  const parsedInput = cap.inputSchema.parse(body?.input ?? {});
  const ctx = buildRunContext(c, body?.modelId);

  const result = await runStructuredCapability(cap, parsedInput, ctx);

  // Audit (best-effort, mirrors the old per-route logging).
  const userId = c.get("rbacUserId");
  if (userId) {
    createAuditLogWithContext(c, AUDIT_ACTIONS.CH_QUERY_EXECUTE, userId, {
      resourceType: "ai",
      resourceId: capId,
      details: { capability: capId, connectionId: ctx.connectionId, timestamp: Date.now() },
      ipAddress: getClientIp(c),
      status: "success",
    }).catch((err: unknown) => {
      requestLogger(c.get("requestId")).error(
        { module: "AI", capability: capId, err: err instanceof Error ? err.message : String(err) },
        "Failed to create AI audit log",
      );
    });
  }

  return c.json({ success: true, data: result });
});

/**
 * GET /ai/capabilities — capabilities the caller may use, so the UI can show or
 * hide AI buttons. Returns id + permission + delivery for each.
 */
ai.get("/capabilities", async (c) => {
  const isAdmin = c.get("isRbacAdmin") ?? false;
  const perms = c.get("rbacPermissions") ?? [];
  const list = CAPABILITY_IDS.map((id) => {
    const cap = CAPABILITIES[id];
    return {
      id,
      permission: cap.permission,
      delivery: cap.delivery,
      allowed: isAdmin || perms.includes(cap.permission),
    };
  });
  return c.json({ success: true, data: list });
});

/**
 * GET /ai/models — active AI deployments for the model picker (no secrets).
 * Unifies the old /query/optimize-models, /ai-chat/models, /fleet/doctor/models.
 */
ai.get("/models", async (c) => {
  try {
    const { listAiConfigs } = await import("../rbac/services/aiModels");
    const { configs } = await listAiConfigs({ activeOnly: true });
    return c.json({
      success: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: configs.map((cfg: any) => ({
        id: cfg.id,
        label: cfg.name,
        model: cfg.model?.modelId ?? cfg.model?.name ?? "",
        provider: cfg.provider?.name ?? cfg.provider?.providerType ?? "",
        isDefault: Boolean(cfg.isDefault),
      })),
    });
  } catch {
    return c.json({ success: true, data: [] });
  }
});

/**
 * A field-allowlisted, credential-free context bundle for pipeline assistants.
 * This endpoint only exposes metadata, immutable definitions/SQL, and run
 * diagnostics; it never returns connection configuration or sample rows.
 */
ai.get("/context/pipelines/:id", async (c) => {
  await requireCapabilityPermission(c, PERMISSIONS.PIPELINES_VIEW);
  await requireCapabilityPermission(c, PERMISSIONS.PIPELINES_AI_SUGGEST);
  const id = c.req.param("id");
  const pipeline = await pipelineStore.getPipelineDetail(id);
  const userId = c.get("rbacUserId");
  const isAdmin = c.get("isRbacAdmin") ?? false;
  const canViewAll = isAdmin || (c.get("rbacPermissions") ?? []).includes(PERMISSIONS.PIPELINES_VIEW_ALL);
  if (!pipeline || (!canViewAll && pipeline.createdBy !== userId)) {
    throw AppError.notFound("Visual pipeline not found");
  }
  if (!isAdmin) {
    if (!userId) throw AppError.unauthorized("RBAC authentication is required.");
    const connections = await getUserConnections(userId);
    if (!connections.some((connection) => connection.id === pipeline.connectionId)) {
      throw AppError.forbidden("You do not have access to this pipeline connection");
    }
  }

  const version = pipeline.draft;
  const client = await clientForConnection(
    pipeline.connectionId,
    JSON.stringify({ rbac_user_id: userId ?? null, source: "pipeline_ai_context", pipeline_id: pipeline.id }),
  );
  const schemaFor = async (database: string, table: string, access: "read" | "write") => {
    const allowed = await checkTableAccess(userId, isAdmin, database, table, pipeline.connectionId, access);
    if (!allowed) return { database, table, accessible: false, columns: [] as Array<{ name: string; type: string }> };
    const result = await client.query({
      query: "SELECT name, type FROM system.columns WHERE database = {database:String} AND table = {table:String} ORDER BY position",
      format: "JSON",
      query_params: { database, table },
      clickhouse_settings: { readonly: "1", max_execution_time: 10, max_result_rows: "10000" },
    });
    const json = await result.json() as { data?: Array<{ name: string; type: string }> };
    return { database, table, accessible: true, columns: json.data ?? [] };
  };
  const sources = version?.definition.nodes.filter((node) => node.type === "source") ?? [];
  const destination = version?.definition.nodes.find((node) => node.type === "destination");
  const sourceSchemas = await Promise.all(sources.map((node) => schemaFor(node.config.database, node.config.table, "read")));
  const destinationSchema = destination?.type === "destination"
    ? await schemaFor(destination.config.database, destination.config.table, "write")
    : null;
  const runs = await pipelineStore.listPipelineRuns(pipeline.id, 20, 0);
  const safeRun = (run: (typeof runs)[number] | undefined) => run ? {
    id: run.id,
    versionId: run.versionId,
    deploymentId: run.deploymentId,
    triggerType: run.triggerType,
    externalEventId: run.externalEventId,
    status: run.status,
    rowCount: run.rowCount,
    writtenRows: run.writtenRows,
    durationMs: run.durationMs,
    errorMessage: run.errorMessage,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  } : null;
  const lastExecution = safeRun(runs[0]);
  const lastError = safeRun(runs.find((run) => run.status === "failed" || run.errorMessage));
  const metadata = await pipelineStore.listBusinessMetadata(pipeline.id);
  const deployment = await pipelineStore.getActiveDeployment(pipeline.id);

  return c.json({
    success: true,
    data: {
      pipeline: {
        id: pipeline.id,
        name: pipeline.name,
        description: pipeline.description,
        activeDeploymentId: pipeline.activeDeploymentId,
      },
      pipelineVersion: version ? {
        id: version.id,
        versionNumber: version.versionNumber,
        status: version.status,
        definitionHash: version.definitionHash,
        compilerVersion: version.compilerVersion,
        definition: version.definition,
        outputSchema: version.outputSchema,
        lineage: version.lineage,
        diagnostics: version.diagnostics,
      } : null,
      sourceSchemas,
      destinationSchema,
      businessMetadata: metadata,
      generatedSql: version?.generatedSql ?? null,
      deployment: deployment ? {
        id: deployment.id,
        versionId: deployment.versionId,
        triggerType: deployment.triggerType,
        triggerConfig: deployment.triggerConfig,
        artifactChecksum: deployment.artifactChecksum,
        status: deployment.status,
        deployedAt: deployment.deployedAt,
      } : null,
      lastExecution,
      lastError,
    },
  });
});

ai.post("/feedback", async (c) => {
  await requireCapabilityPermission(c, PERMISSIONS.AI_OPTIMIZE);
  const schema = z.object({
    capability: z.string().min(1).max(100),
    objectType: z.enum(["scheduled_query", "scheduled_run", "data_health_promise", "data_health_incident"]),
    objectId: z.string().min(1).max(200),
    rating: z.enum(["useful", "not_useful", "accepted", "edited", "rejected"]),
    comment: z.string().trim().max(500).optional(),
  });
  const body = schema.parse(await c.req.json().catch(() => null));
  const userId = c.get("rbacUserId");
  if (userId) {
    await createAuditLogWithContext(c, AUDIT_ACTIONS.CH_QUERY_EXECUTE, userId, {
      resourceType: "dataops_ai_feedback",
      resourceId: body.objectId,
      details: body,
      ipAddress: getClientIp(c),
      status: "success",
    });
  }
  return c.json({ success: true, data: { recorded: true } });
});

export default ai;
