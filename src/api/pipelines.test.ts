import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { server } from "@/test/mocks/server";
import {
  archivePipeline,
  createNextPipelineDraft,
  createPipeline,
  deployPipeline,
  getPipeline,
  listPipelineDeployments,
  listPipelineMetadata,
  listPipelineRuns,
  listPipelines,
  listPipelineVersions,
  runPipeline,
  savePipelineMetadata,
  testPipelineSample,
  updatePipelineDraft,
  validatePipeline,
  type PipelineDefinition,
} from "./pipelines";

const definition: PipelineDefinition = {
  schemaVersion: 1,
  nodes: [
    { id: "source_a", type: "source", position: { x: 0, y: 0 }, config: { database: "raw", table: "events" } },
    { id: "destination_a", type: "destination", position: { x: 300, y: 0 }, config: { database: "ods", table: "events", writeMode: "append" } },
  ],
  edges: [{ id: "edge_a", from: "source_a", to: "destination_a", input: "main" }],
};

const version = {
  id: "version-1",
  pipelineId: "pipeline-1",
  versionNumber: 1,
  schemaVersion: 1,
  definition,
  definitionHash: "hash-1",
  compilerVersion: null,
  generatedSql: null,
  outputSchema: null,
  lineage: null,
  diagnostics: null,
  status: "DRAFT" as const,
  createdBy: "user-1",
  createdAt: 1,
  validatedAt: null,
  testedAt: null,
};

const pipeline = {
  id: "pipeline-1",
  name: "Events ODS",
  description: null,
  connectionId: "11111111-1111-4111-8111-111111111111",
  currentDraftVersionId: "version-1",
  activeDeploymentId: null,
  createdBy: "user-1",
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
  draft: version,
};

describe("Visual Pipelines API", () => {
  it("lists and reads pipelines", async () => {
    server.use(
      http.get("/api/pipelines", () => HttpResponse.json({ success: true, data: { pipelines: [pipeline] } })),
      http.get("/api/pipelines/pipeline-1", () => HttpResponse.json({ success: true, data: pipeline })),
    );
    expect(await listPipelines()).toHaveLength(1);
    expect((await getPipeline("pipeline-1")).draft?.definitionHash).toBe("hash-1");
  });

  it("creates and updates a draft with the expected request shape", async () => {
    const methods: string[] = [];
    server.use(
      http.post("/api/pipelines", async ({ request }) => {
        methods.push(request.method);
        const body = await request.json() as { definition?: PipelineDefinition };
        expect(body.definition?.schemaVersion).toBe(1);
        return HttpResponse.json({ success: true, data: pipeline }, { status: 201 });
      }),
      http.patch("/api/pipelines/pipeline-1/draft", async ({ request }) => {
        methods.push(request.method);
        return HttpResponse.json({ success: true, data: pipeline });
      }),
    );
    await createPipeline({ name: "Events ODS", connectionId: pipeline.connectionId, definition });
    await updatePipelineDraft("pipeline-1", { definition });
    expect(methods).toEqual(["POST", "PATCH"]);
  });

  it("validates a draft and lists immutable versions", async () => {
    server.use(
      http.post("/api/pipelines/pipeline-1/validate", () => HttpResponse.json({
        success: true,
        data: { version: { ...version, status: "VALIDATED", generatedSql: "SELECT 1" }, compiled: { compilerVersion: "1", sql: "SELECT 1", parameters: [], outputColumns: [], diagnostics: [] } },
      })),
      http.get("/api/pipelines/pipeline-1/versions", () => HttpResponse.json({ success: true, data: { versions: [version] } })),
    );
    expect((await validatePipeline("pipeline-1")).compiled.sql).toBe("SELECT 1");
    expect(await listPipelineVersions("pipeline-1")).toHaveLength(1);
  });

  it("creates the next draft version", async () => {
    server.use(http.post("/api/pipelines/pipeline-1/draft", () => HttpResponse.json({
      success: true,
      data: { ...pipeline, currentDraftVersionId: "version-2", draft: { ...version, id: "version-2", versionNumber: 2 } },
    })));

    const result = await createNextPipelineDraft("pipeline-1");
    expect(result.draft?.versionNumber).toBe(2);
  });

  it("tests a bounded sample", async () => {
    server.use(http.post("/api/pipelines/pipeline-1/test", async ({ request }) => {
      expect(await request.json()).toEqual({ limit: 25 });
      return HttpResponse.json({
        success: true,
        data: { version: { ...version, status: "TESTED" }, columns: [{ name: "event_id", type: "UInt64" }], rows: [{ event_id: 42 }], limit: 25, truncated: false },
      });
    }));

    const result = await testPipelineSample("pipeline-1", 25);
    expect(result.rows).toEqual([{ event_id: 42 }]);
  });

  it("archives a pipeline", async () => {
    server.use(http.delete("/api/pipelines/pipeline-1", () => HttpResponse.json({ success: true, data: { archived: true } })));
    await expect(archivePipeline("pipeline-1")).resolves.toBeUndefined();
  });

  it("manages deployment, execution history, and business metadata", async () => {
    const requests: string[] = [];
    server.use(
      http.post("/api/pipelines/pipeline-1/deploy", async ({ request }) => {
        const body = await request.json() as { triggerType?: string };
        expect(body.triggerType).toBe("webhook");
        requests.push("deploy");
        return HttpResponse.json({ success: true, data: { deployment: { id: "deployment-1" }, webhookSecret: "one-time" } }, { status: 201 });
      }),
      http.get("/api/pipelines/pipeline-1/deployments", () => HttpResponse.json({ success: true, data: { deployments: [{ id: "deployment-1" }] } })),
      http.post("/api/pipelines/pipeline-1/run", () => HttpResponse.json({ success: true, data: { queued: false, run: { id: "run-1" } } })),
      http.get("/api/pipelines/pipeline-1/runs", () => HttpResponse.json({ success: true, data: { runs: [{ id: "run-1" }], nativeRuns: [] } })),
      http.put("/api/pipelines/pipeline-1/metadata", async ({ request }) => {
        requests.push("metadata");
        return HttpResponse.json({ success: true, data: { id: "metadata-1", ...(await request.json() as object) } });
      }),
      http.get("/api/pipelines/pipeline-1/metadata", () => HttpResponse.json({ success: true, data: { metadata: [{ id: "metadata-1" }] } })),
    );

    const deployed = await deployPipeline("pipeline-1", { versionId: "version-1", triggerType: "webhook", concurrencyPolicy: "queue_one" });
    expect(deployed.webhookSecret).toBe("one-time");
    expect(await listPipelineDeployments("pipeline-1")).toHaveLength(1);
    expect((await runPipeline("pipeline-1")).run?.id).toBe("run-1");
    expect((await listPipelineRuns("pipeline-1")).runs).toHaveLength(1);
    await savePipelineMetadata("pipeline-1", { entityType: "pipeline", entityKey: "pipeline", description: "Orders mart", businessOwner: null, dataOwner: null, sensitivity: "internal", sourceSystem: "ERP", refreshFrequency: "hourly", businessDefinition: null });
    expect(await listPipelineMetadata("pipeline-1")).toHaveLength(1);
    expect(requests).toEqual(["deploy", "metadata"]);
  });
});
