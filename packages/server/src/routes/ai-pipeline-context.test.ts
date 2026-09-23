import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono, type Context, type Next } from "hono";

const getPipelineDetail = mock();
const listPipelineRuns = mock();
const listBusinessMetadata = mock();
const getActiveDeployment = mock();
const getUserConnections = mock();
const checkTableAccess = mock();
const clickHouseQuery = mock();

mock.module("./query", () => ({
  queryAuthMiddleware: async (c: Context, next: Next) => {
    c.set("rbacUserId", "user-1");
    c.set("isRbacAdmin", false);
    c.set("rbacPermissions", ["pipelines:view", "pipelines:ai_suggest"]);
    await next();
  },
}));
mock.module("../services/pipelines/store", () => ({
  getPipelineDetail,
  listPipelineRuns,
  listBusinessMetadata,
  getActiveDeployment,
}));
mock.module("../rbac/services/connections", () => ({
  getUserConnections,
  listConnections: mock(),
  getConnectionWithPassword: mock(),
  getConnectionById: mock(),
  encryptSecret: (value: string) => value,
  decryptSecret: (value: string) => value,
  encryptPassword: (value: string) => value,
  decryptPassword: (value: string) => value,
}));
mock.module("../middleware/dataAccess", () => ({
  checkTableAccess,
  checkDatabaseAccess: mock(),
  filterDatabases: mock(),
  filterTables: mock(),
  extractTablesFromQuery: mock(),
  getQueryAccessType: mock(),
  validateQueryAccess: mock(),
  extractTablesFromExplainEstimate: mock(),
  optionalRbacMiddleware: async (_c: Context, next: Next) => next(),
}));
mock.module("../services/scheduledQueries/chClient", () => ({ clientForConnection: async () => ({ query: clickHouseQuery }) }));

const { errorHandler } = await import("../middleware/error");
const { default: aiRoute } = await import("./ai");

describe("pipeline AI context", () => {
  beforeEach(() => {
    for (const fn of [getPipelineDetail, listPipelineRuns, listBusinessMetadata, getActiveDeployment, getUserConnections, checkTableAccess, clickHouseQuery]) fn.mockReset();
    getUserConnections.mockResolvedValue([{ id: "connection-1" }]);
    checkTableAccess.mockResolvedValue(true);
    clickHouseQuery.mockResolvedValue({ json: async () => ({ data: [{ name: "event_id", type: "UInt64" }] }) });
    getPipelineDetail.mockResolvedValue({
      id: "pipeline-1",
      name: "Events",
      description: "Clean events",
      connectionId: "connection-1",
      activeDeploymentId: "deployment-1",
      createdBy: "user-1",
      draft: {
        id: "version-1",
        versionNumber: 1,
        status: "DEPLOYED",
        definitionHash: "hash",
        compilerVersion: "1",
        generatedSql: "SELECT event_id FROM raw.events",
        outputSchema: [{ name: "event_id", type: "UInt64" }],
        lineage: [],
        diagnostics: [],
        definition: {
          schemaVersion: 1,
          nodes: [
            { id: "source", type: "source", position: { x: 0, y: 0 }, config: { database: "raw", table: "events" } },
            { id: "destination", type: "destination", position: { x: 1, y: 0 }, config: { database: "ods", table: "events", writeMode: "append" } },
          ],
          edges: [{ id: "edge", from: "source", to: "destination", input: "main" }],
        },
      },
    });
    listBusinessMetadata.mockResolvedValue([{ id: "metadata-1", description: "Business-safe description" }]);
    listPipelineRuns.mockResolvedValue([{
      id: "run-1",
      versionId: "version-1",
      deploymentId: "deployment-1",
      triggerType: "webhook",
      externalEventId: "job-1",
      status: "failed",
      rowCount: null,
      writtenRows: null,
      durationMs: 20,
      errorMessage: "Type mismatch",
      startedAt: 1,
      finishedAt: 2,
      triggerPayload: { password: "DO_NOT_EXPOSE" },
      result: { token: "DO_NOT_EXPOSE" },
      generatedSql: "SELECT 1",
    }]);
    getActiveDeployment.mockResolvedValue({
      id: "deployment-1",
      versionId: "version-1",
      triggerType: "webhook",
      triggerConfig: { concurrencyPolicy: "queue_one" },
      artifactChecksum: "checksum",
      status: "ACTIVE",
      deployedAt: 1,
      webhookSecretEncrypted: "DO_NOT_EXPOSE",
    });
  });

  afterAll(() => mock.restore());

  it("returns allowlisted schemas and diagnostics without connection or payload secrets", async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.route("/ai", aiRoute);
    const response = await app.request("/ai/context/pipelines/pipeline-1");
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.data.sourceSchemas[0].columns).toEqual([{ name: "event_id", type: "UInt64" }]);
    expect(body.data.lastError.errorMessage).toBe("Type mismatch");
    expect(serialized).not.toContain("DO_NOT_EXPOSE");
    expect(serialized).not.toContain("connectionConfig");
    expect(body.data.lastExecution.triggerPayload).toBeUndefined();
  });
});
