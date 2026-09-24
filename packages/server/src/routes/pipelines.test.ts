import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono, type Context, type Next } from "hono";

import type { PipelineDefinition } from "../services/pipelines/definition";
import { pipelineDefinitionHash } from "../services/pipelines/canonical";
import { compilePipeline } from "../services/pipelines/compiler";
import type { VisualPipelineDeploymentRow, VisualPipelineDetail, VisualPipelineVersionRow } from "../services/pipelines/types";
import { AppError } from "../types";

const definition: PipelineDefinition = {
  schemaVersion: 1,
  nodes: [
    {
      id: "source",
      type: "source",
      position: { x: 0, y: 0 },
      config: { database: "analytics", table: "events" },
    },
    {
      id: "destination",
      type: "destination",
      position: { x: 320, y: 0 },
      config: { database: "analytics", table: "events_clean", writeMode: "append" },
    },
  ],
  edges: [{ id: "source_destination", from: "source", to: "destination", input: "main" }],
};

const frozenCompilation = compilePipeline(definition, {
  sourceSchemas: { source: [{ name: "event_id", type: "UInt64" }] },
});

const draft: VisualPipelineVersionRow = {
  id: "version-1",
  pipelineId: "pipeline-1",
  versionNumber: 1,
  schemaVersion: 1,
  definition,
  definitionHash: "draft-hash",
  compilerVersion: null,
  generatedSql: null,
  outputSchema: null,
  lineage: null,
  diagnostics: null,
  status: "DRAFT",
  createdBy: "user-1",
  createdAt: 1,
  validatedAt: null,
  testedAt: null,
};

const pipeline: VisualPipelineDetail = {
  id: "pipeline-1",
  name: "Clean events",
  description: null,
  connectionId: "11111111-1111-4111-8111-111111111111",
  currentDraftVersionId: draft.id,
  activeDeploymentId: null,
  createdBy: "user-1",
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
  draft,
};

let auth = {
  sub: "user-1",
  roles: ["developer"],
  permissions: ["pipelines:view", "pipelines:edit", "pipelines:test", "pipelines:delete"],
};

const listPipelines = mock();
const createPipeline = mock();
const getPipelineDetail = mock();
const listVersions = mock();
const updateDraft = mock();
const createNextDraft = mock();
const markVersionValidated = mock();
const markVersionTested = mock();
const archivePipeline = mock();
const getVersion = mock();
const getActiveDeployment = mock();
const getDeploymentWebhookSecret = mock();
const activateDeployment = mock();
const recordExternalEvent = mock();
const recordWebhookDelivery = mock();
const updateExternalEventStatus = mock();
const listDeployments = mock();
const listPipelineRuns = mock();
const listWebhookDeliveries = mock();
const listNativeRuns = mock();
const listBusinessMetadata = mock();
const getUserConnections = mock();
const createAuditLogWithContext = mock();
const checkTableAccess = mock();
const clickHouseQuery = mock();
const clickHouseCommand = mock();
const createRuntimeJob = mock();
const executeDeployment = mock();

class PipelineBusyError extends Error {}

mock.module("../rbac/middleware/rbacAuth", () => ({
  rbacAuthMiddleware: async (c: Context, next: Next) => {
    c.set("rbacUser", auth);
    c.set("rbacUserId", auth.sub);
    c.set("rbacRoles", auth.roles);
    c.set("rbacPermissions", auth.permissions);
    await next();
  },
  requirePermission: (permission: string) => async (_c: Context, next: Next) => {
    if (!auth.permissions.includes(permission)) throw AppError.forbidden(`Permission '${permission}' required`);
    await next();
  },
  getRbacUser: () => auth,
}));

mock.module("../services/pipelines/store", () => ({
  listPipelines,
  createPipeline,
  getPipelineDetail,
  listVersions,
  updateDraft,
  createNextDraft,
  markVersionValidated,
  markVersionTested,
  archivePipeline,
  getVersion,
  getActiveDeployment,
  getDeploymentWebhookSecret,
  activateDeployment,
  recordExternalEvent,
  recordWebhookDelivery,
  updateExternalEventStatus,
  listDeployments,
  listPipelineRuns,
  listWebhookDeliveries,
  listNativeRuns,
  listBusinessMetadata,
}));

mock.module("../services/pipelines/runtime", () => ({ createRuntimeJob, executeDeployment, PipelineBusyError }));
mock.module("../services/pipelines/nativeHistory", () => ({ syncNativeRunHistory: mock() }));
mock.module("../services/scheduledQueries/store", () => ({ setJobEnabled: mock(), deleteJob: mock() }));
mock.module("../rbac/services/connections", () => ({
  getUserConnections,
  encryptSecret: (value: string) => `enc:${value}`,
  decryptSecret: (value: string) => value.replace(/^enc:/, ""),
}));
mock.module("../rbac/services/rbac", () => ({ createAuditLogWithContext }));
mock.module("../middleware/dataAccess", () => ({ checkTableAccess, validateQueryAccess: mock() }));
mock.module("../services/scheduledQueries/chClient", () => ({
  clientForConnection: async () => ({ query: clickHouseQuery, command: clickHouseCommand }),
}));

const { errorHandler } = await import("../middleware/error");
const { default: pipelinesRoute } = await import("./pipelines");

describe("Visual Pipelines routes", () => {
  let app: Hono;

  beforeEach(() => {
    auth = {
      sub: "user-1",
      roles: ["developer"],
      permissions: ["pipelines:view", "pipelines:edit", "pipelines:test", "pipelines:delete"],
    };
    for (const fn of [
      listPipelines,
      createPipeline,
      getPipelineDetail,
      listVersions,
      updateDraft,
      createNextDraft,
      markVersionValidated,
      markVersionTested,
      archivePipeline,
      getVersion,
      getActiveDeployment,
      getDeploymentWebhookSecret,
      activateDeployment,
      recordExternalEvent,
      recordWebhookDelivery,
      updateExternalEventStatus,
      listDeployments,
      listPipelineRuns,
      listWebhookDeliveries,
      listNativeRuns,
      listBusinessMetadata,
      getUserConnections,
      createAuditLogWithContext,
      checkTableAccess,
      clickHouseQuery,
      clickHouseCommand,
      createRuntimeJob,
      executeDeployment,
    ]) fn.mockReset();

    getUserConnections.mockResolvedValue([{ id: pipeline.connectionId }]);
    createAuditLogWithContext.mockResolvedValue(undefined);
    checkTableAccess.mockResolvedValue(true);
    listDeployments.mockResolvedValue([]);
    listPipelineRuns.mockResolvedValue([]);
    listWebhookDeliveries.mockResolvedValue([]);
    listBusinessMetadata.mockResolvedValue([]);
    app = new Hono();
    app.onError(errorHandler);
    app.route("/pipelines", pipelinesRoute);
  });

  afterAll(() => {
    mock.restore();
  });

  it("scopes listings to the owner unless view-all is granted", async () => {
    listPipelines.mockResolvedValue([pipeline]);
    let response = await app.request("/pipelines");
    expect(response.status).toBe(200);
    expect(listPipelines).toHaveBeenLastCalledWith("user-1");

    auth.permissions.push("pipelines:view_all");
    response = await app.request("/pipelines");
    expect(response.status).toBe(200);
    expect(listPipelines).toHaveBeenLastCalledWith(null);
  });

  it("routes the versions endpoint independently from pipeline detail", async () => {
    getPipelineDetail.mockResolvedValue(pipeline);
    listVersions.mockResolvedValue([draft]);
    const response = await app.request("/pipelines/pipeline-1/versions");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.versions).toEqual([draft]);
    expect(listVersions).toHaveBeenCalledWith("pipeline-1");
  });

  it("returns webhook delivery attempts alongside execution history", async () => {
    getPipelineDetail.mockResolvedValue(pipeline);
    listDeployments.mockResolvedValue([]);
    listPipelineRuns.mockResolvedValue([]);
    listWebhookDeliveries.mockResolvedValue([{ id: "delivery-1", outcome: "DUPLICATE" }]);

    const response = await app.request("/pipelines/pipeline-1/runs");

    expect(response.status).toBe(200);
    expect((await response.json()).data.webhookDeliveries).toEqual([{ id: "delivery-1", outcome: "DUPLICATE" }]);
  });

  it("creates an owner-scoped draft only when the connection is accessible", async () => {
    createPipeline.mockResolvedValue(pipeline);
    const response = await app.request("/pipelines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: pipeline.name,
        connectionId: pipeline.connectionId,
        definition,
      }),
    });

    expect(response.status).toBe(201);
    expect(createPipeline).toHaveBeenCalledWith(expect.objectContaining({
      name: pipeline.name,
      connectionId: pipeline.connectionId,
      createdBy: "user-1",
      definition,
    }));
    expect(createAuditLogWithContext).toHaveBeenCalledTimes(1);
  });

  it("hides another owner's pipeline and refuses to edit immutable versions", async () => {
    getPipelineDetail.mockResolvedValue({ ...pipeline, createdBy: "user-2" });
    let response = await app.request("/pipelines/pipeline-1");
    expect(response.status).toBe(404);

    getPipelineDetail.mockResolvedValue({
      ...pipeline,
      draft: {
        ...draft,
        status: "VALIDATED",
        compilerVersion: frozenCompilation.compilerVersion,
        generatedSql: frozenCompilation.sql,
        outputSchema: frozenCompilation.outputColumns,
      },
    });
    response = await app.request("/pipelines/pipeline-1/draft", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ definition }),
    });
    expect(response.status).toBe(409);
    expect(updateDraft).not.toHaveBeenCalled();
  });

  it("creates the next editable version from an immutable pipeline", async () => {
    const validatedPipeline = { ...pipeline, draft: { ...draft, status: "VALIDATED" as const } };
    const nextDraftPipeline = {
      ...pipeline,
      currentDraftVersionId: "version-2",
      draft: { ...draft, id: "version-2", versionNumber: 2, status: "DRAFT" as const },
    };
    getPipelineDetail.mockResolvedValue(validatedPipeline);
    createNextDraft.mockResolvedValue(nextDraftPipeline);

    const response = await app.request("/pipelines/pipeline-1/draft", { method: "POST" });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data.draft.versionNumber).toBe(2);
    expect(createNextDraft).toHaveBeenCalledWith("pipeline-1", "user-1");
  });

  it("validates source access and freezes compiled SQL on the draft", async () => {
    getPipelineDetail.mockResolvedValue(pipeline);
    clickHouseQuery.mockResolvedValue({
      json: async () => ({ data: [{ name: "event_id", type: "UInt64" }] }),
    });
    markVersionValidated.mockImplementation(async (_id: string, update: Record<string, unknown>) => ({
      ...draft,
      ...update,
      status: "VALIDATED",
      validatedAt: 2,
    }));

    const response = await app.request("/pipelines/pipeline-1/validate", { method: "POST" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.version.status).toBe("VALIDATED");
    expect(body.data.compiled.sql).toContain("FROM `analytics`.`events`");
    expect(body.data.compiled.destination).toEqual({
      database: "analytics",
      table: "events_clean",
      writeMode: "append",
    });
    expect(checkTableAccess).toHaveBeenCalledWith(
      "user-1",
      false,
      "analytics",
      "events",
      pipeline.connectionId,
      "read",
    );
    expect(markVersionValidated).toHaveBeenCalledWith(
      draft.id,
      expect.objectContaining({ generatedSql: body.data.compiled.sql }),
    );
  });

  it("runs a bounded read-only sample and marks the version tested", async () => {
    getPipelineDetail.mockResolvedValue({
      ...pipeline,
      draft: {
        ...draft,
        status: "VALIDATED",
        compilerVersion: frozenCompilation.compilerVersion,
        generatedSql: frozenCompilation.sql,
        outputSchema: frozenCompilation.outputColumns,
      },
    });
    clickHouseQuery
      .mockResolvedValueOnce({ json: async () => ({ data: [{ name: "event_id", type: "UInt64" }] }) })
      .mockResolvedValueOnce({ json: async () => ({ meta: [{ name: "event_id", type: "UInt64" }], data: [{ event_id: 42 }] }) });
    markVersionTested.mockResolvedValue({ ...draft, status: "TESTED", testedAt: 2 });

    const response = await app.request("/pipelines/pipeline-1/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 25 }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.rows).toEqual([{ event_id: 42 }]);
    expect(markVersionTested).toHaveBeenCalledWith(draft.id);
    expect(clickHouseQuery).toHaveBeenLastCalledWith(expect.objectContaining({
      query_params: expect.objectContaining({ vp_sample_limit: 25 }),
      clickhouse_settings: expect.objectContaining({ readonly: "1", max_result_rows: "25" }),
    }));
  });

  it("deploys only a tested version and freezes a scheduled runtime artifact", async () => {
    auth.permissions.push("pipelines:deploy");
    const tested = {
      ...draft,
      id: "22222222-2222-4222-8222-222222222222",
      status: "TESTED" as const,
      definitionHash: pipelineDefinitionHash(definition),
      compilerVersion: frozenCompilation.compilerVersion,
      generatedSql: frozenCompilation.sql,
      outputSchema: frozenCompilation.outputColumns,
    };
    getPipelineDetail.mockResolvedValue({ ...pipeline, draft: tested });
    getVersion.mockResolvedValue(tested);
    getActiveDeployment.mockResolvedValue(null);
    clickHouseQuery.mockResolvedValue({ json: async () => ({ data: [{ name: "event_id", type: "UInt64" }] }) });
    createRuntimeJob.mockResolvedValue("job-1");
    activateDeployment.mockImplementation(async (input: Record<string, unknown>) => ({
      id: "deployment-1",
      ...input,
      hasWebhookSecret: false,
      status: "ACTIVE",
      deployedAt: 10,
      retiredBy: null,
      retiredAt: null,
    }));

    const response = await app.request("/pipelines/pipeline-1/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ versionId: tested.id, triggerType: "schedule", frequency: "cron", cronExpr: "*/15 * * * *" }),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data.deployment.runtimeJobId).toBe("job-1");
    expect(createRuntimeJob).toHaveBeenCalledWith(
      pipeline.name,
      pipeline.description,
      expect.objectContaining({ triggerType: "schedule", artifact: expect.objectContaining({ runtimeSql: expect.any(String) }) }),
      "user-1",
    );
    expect(activateDeployment).toHaveBeenCalledWith(expect.objectContaining({
      artifactChecksum: expect.any(String),
      triggerConfig: expect.objectContaining({ concurrencyPolicy: "do_not_overlap" }),
    }));
  });

  it("requires table-create permission and creates a managed destination at deployment", async () => {
    auth.permissions.push("pipelines:deploy");
    const managedDefinition: PipelineDefinition = {
      ...definition,
      nodes: definition.nodes.map((node) => node.type === "destination"
        ? { ...node, config: { ...node.config, writeMode: "append", createIfMissing: true } }
        : node),
    };
    const managedCompilation = compilePipeline(managedDefinition, {
      sourceSchemas: { source: [{ name: "event_id", type: "UInt64" }] },
    });
    const tested = {
      ...draft,
      id: "33333333-3333-4333-8333-333333333333",
      definition: managedDefinition,
      status: "TESTED" as const,
      definitionHash: pipelineDefinitionHash(managedDefinition),
      compilerVersion: managedCompilation.compilerVersion,
      generatedSql: managedCompilation.sql,
      outputSchema: managedCompilation.outputColumns,
    };
    getPipelineDetail.mockResolvedValue({ ...pipeline, draft: tested });
    getVersion.mockResolvedValue(tested);
    getActiveDeployment.mockResolvedValue(null);
    clickHouseQuery.mockResolvedValue({ json: async () => ({ data: [{ name: "event_id", type: "UInt64" }] }) });
    createRuntimeJob.mockResolvedValue("job-managed");
    activateDeployment.mockImplementation(async (input: Record<string, unknown>) => ({
      id: "deployment-managed",
      ...input,
      hasWebhookSecret: false,
      status: "ACTIVE",
      deployedAt: 10,
      retiredBy: null,
      retiredAt: null,
    }));
    const request = (): Promise<Response> => app.request("/pipelines/pipeline-1/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ versionId: tested.id, triggerType: "manual" }),
    });

    let response = await request();
    expect(response.status).toBe(403);
    expect(clickHouseCommand).not.toHaveBeenCalled();

    auth.permissions.push("table:create");
    response = await request();
    expect(response.status).toBe(201);
    expect(clickHouseCommand).toHaveBeenCalledWith(expect.objectContaining({
      query: "CREATE TABLE IF NOT EXISTS `analytics`.`events_clean` (\n  `event_id` UInt64\n) ENGINE = MergeTree\nORDER BY tuple()",
    }));
  });

  it("authenticates, deduplicates, and executes successful webhooks", async () => {
    const deployment = {
      id: "deployment-1",
      pipelineId: pipeline.id,
      versionId: draft.id,
      connectionId: pipeline.connectionId,
      triggerType: "webhook",
      triggerConfig: { concurrencyPolicy: "queue_one" },
      artifact: {
        compilerVersion: "1",
        definitionHash: "hash",
        sql: "SELECT 1",
        runtimeSql: "SELECT 1",
        parameters: [],
        outputColumns: [],
        lineage: [],
        destination: { database: "analytics", table: "events_clean", writeMode: "append" },
      },
      artifactChecksum: "checksum",
      runtimeJobId: "job-1",
      nativeObjectName: null,
      nativeObjectUuid: null,
      hasWebhookSecret: true,
      status: "ACTIVE",
      deployedBy: "user-1",
      deployedAt: 1,
      retiredBy: null,
      retiredAt: null,
    } satisfies VisualPipelineDeploymentRow;
    getActiveDeployment.mockResolvedValue(deployment);
    getDeploymentWebhookSecret.mockResolvedValue("enc:webhook-secret");
    recordExternalEvent.mockResolvedValue({ id: "event-row-1", created: true });
    executeDeployment.mockResolvedValue({ queued: false, run: { id: "run-1" } });
    const payload = JSON.stringify({ source: "airbyte", status: "succeeded", job_id: 12345 });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", "webhook-secret").update(`${timestamp}.${payload}`).digest("hex");

    const response = await app.request("/pipelines/pipeline-1/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-chouse-timestamp": timestamp,
        "x-chouse-signature": `sha256=${signature}`,
      },
      body: payload,
    });
    expect(response.status).toBe(200);
    expect(recordExternalEvent).toHaveBeenCalledWith(expect.objectContaining({ externalEventId: "12345", signatureValid: true }));
    expect(executeDeployment).toHaveBeenCalledWith(deployment, expect.objectContaining({
      triggerType: "webhook",
      externalEventId: "12345",
      externalEventRecordId: "event-row-1",
    }));
    expect(recordWebhookDelivery).toHaveBeenLastCalledWith(expect.objectContaining({
      externalEventId: "12345",
      outcome: "ACCEPTED",
    }));

    recordExternalEvent.mockResolvedValue({ id: "event-row-1", created: false });
    const duplicate = await app.request("/pipelines/pipeline-1/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-chouse-timestamp": timestamp, "x-chouse-signature": signature },
      body: payload,
    });
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).data.duplicate).toBe(true);
    expect(executeDeployment).toHaveBeenCalledTimes(1);
    expect(recordWebhookDelivery).toHaveBeenLastCalledWith(expect.objectContaining({
      externalEventId: "12345",
      outcome: "DUPLICATE",
    }));
  });

  it("accepts Airbyte completion payloads through the URL adapter", async () => {
    const deployment = {
      id: "deployment-airbyte",
      pipelineId: pipeline.id,
      versionId: draft.id,
      connectionId: pipeline.connectionId,
      triggerType: "webhook",
      triggerConfig: { concurrencyPolicy: "queue_one" },
      artifact: { compilerVersion: "1", definitionHash: "hash", sql: "SELECT 1", runtimeSql: "SELECT 1", parameters: [], outputColumns: [], lineage: [], destination: { database: "analytics", table: "events_clean", writeMode: "append" } },
      artifactChecksum: "checksum",
      runtimeJobId: "job-airbyte",
      nativeObjectName: null,
      nativeObjectUuid: null,
      hasWebhookSecret: true,
      status: "ACTIVE",
      deployedBy: "user-1",
      deployedAt: 1,
      retiredBy: null,
      retiredAt: null,
    } satisfies VisualPipelineDeploymentRow;
    getActiveDeployment.mockResolvedValue(deployment);
    getDeploymentWebhookSecret.mockResolvedValue("enc:webhook-secret");
    recordExternalEvent.mockResolvedValue({ id: "airbyte-event", created: true });
    executeDeployment.mockResolvedValue({ queued: false, run: { id: "airbyte-run" } });
    const body = JSON.stringify({
      data: {
        connection: { id: "connection-123" },
        jobId: 9988,
        success: true,
        recordsCommitted: 89,
      },
    });

    const unauthorized = await app.request("/pipelines/pipeline-1/webhook/airbyte?token=wrong-secret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(unauthorized.status).toBe(401);
    expect(recordExternalEvent).not.toHaveBeenCalled();

    const response = await app.request("/pipelines/pipeline-1/webhook/airbyte?token=webhook-secret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(response.status).toBe(200);
    expect(recordExternalEvent).toHaveBeenCalledWith(expect.objectContaining({
      source: "airbyte",
      externalEventId: "airbyte:connection-123:9988",
      payload: expect.objectContaining({ source: "airbyte", status: "succeeded" }),
    }));
    expect(executeDeployment).toHaveBeenCalledWith(deployment, expect.objectContaining({
      externalEventId: "airbyte:connection-123:9988",
      triggerPayload: expect.objectContaining({ payload: expect.objectContaining({ data: expect.any(Object) }) }),
    }));
    expect(recordWebhookDelivery).toHaveBeenLastCalledWith(expect.objectContaining({
      externalEventId: "airbyte:connection-123:9988",
      outcome: "ACCEPTED",
    }));
  });
});
