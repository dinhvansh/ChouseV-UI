import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { closeDatabase } from "../../rbac/db";
import { runMigrations } from "../../rbac/db/migrations";
import { freshDatabase } from "../../rbac/db/migrationTestHarness";
import type { PipelineDefinition } from "./definition";
import * as store from "./store";

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

beforeEach(async () => {
  await freshDatabase("sqlite");
  await runMigrations({ skipSeed: true });
});

afterEach(async () => {
  await closeDatabase();
});

describe("visual pipeline store", () => {
  it("creates a pipeline with an initial version and scopes listings by owner", async () => {
    const first = await store.createPipeline({
      name: "Clean events",
      description: "First draft",
      connectionId: "connection-1",
      definition,
      createdBy: "owner-1",
    });
    await store.createPipeline({
      name: "Other owner",
      description: null,
      connectionId: "connection-2",
      definition,
      createdBy: "owner-2",
    });

    expect(first.draft?.versionNumber).toBe(1);
    expect(first.draft?.status).toBe("DRAFT");
    expect(first.draft?.definition).toEqual(definition);
    expect((await store.listPipelines("owner-1")).map((pipeline) => pipeline.id)).toEqual([first.id]);
    expect(await store.listPipelines(null)).toHaveLength(2);
  });

  it("updates only a draft, freezes validation artifacts, and archives the pipeline", async () => {
    const pipeline = await store.createPipeline({
      name: "Clean events",
      description: null,
      connectionId: "connection-1",
      definition,
      createdBy: "owner-1",
    });
    const draftId = pipeline.draft?.id;
    expect(draftId).toBeDefined();
    if (!draftId) throw new Error("Expected an initial draft");

    const movedDefinition: PipelineDefinition = {
      ...definition,
      nodes: definition.nodes.map((node) => ({ ...node, position: { x: node.position.x + 10, y: node.position.y } })),
    };
    const updated = await store.updateDraft(pipeline.id, draftId, movedDefinition, "Clean events v2", "Updated");
    expect(updated?.name).toBe("Clean events v2");
    expect(updated?.description).toBe("Updated");
    expect(updated?.draft?.definition).toEqual(movedDefinition);

    const validated = await store.markVersionValidated(draftId, {
      definitionHash: "validated-hash",
      compilerVersion: "test-compiler",
      generatedSql: "INSERT INTO analytics.events_clean SELECT * FROM analytics.events",
      outputSchema: [{ name: "event_id", type: "UInt64" }],
      lineage: [{ outputColumn: "event_id", sourceColumn: "event_id" }],
      diagnostics: [],
    });
    expect(validated?.status).toBe("VALIDATED");
    expect(validated?.generatedSql).toContain("INSERT INTO");
    expect(validated?.validatedAt).not.toBeNull();
    expect(await store.updateDraft(pipeline.id, draftId, definition)).toBeNull();
    expect(await store.markVersionValidated(draftId, {
      definitionHash: "second-attempt",
      compilerVersion: "test-compiler",
      generatedSql: "SELECT 1",
      outputSchema: [],
      lineage: [],
      diagnostics: [],
    })).toEqual(validated);

    const tested = await store.markVersionTested(draftId);
    expect(tested?.status).toBe("TESTED");
    expect(tested?.testedAt).not.toBeNull();

    const nextDraft = await store.createNextDraft(pipeline.id, "owner-1");
    expect(nextDraft?.draft?.status).toBe("DRAFT");
    expect(nextDraft?.draft?.versionNumber).toBe(2);
    expect(nextDraft?.draft?.definition).toEqual(movedDefinition);
    expect(await store.createNextDraft(pipeline.id, "owner-1")).toBeNull();

    await store.archivePipeline(pipeline.id);
    expect(await store.getPipeline(pipeline.id)).toBeNull();
    expect(await store.listPipelines("owner-1")).toEqual([]);
    expect(await store.listVersions(pipeline.id)).toHaveLength(2);
  });

  it("manages deployments, distributed leases, idempotent events, metadata, and native history", async () => {
    const pipeline = await store.createPipeline({
      name: "Runtime pipeline",
      description: null,
      connectionId: "connection-1",
      definition,
      createdBy: "owner-1",
    });
    const versionId = pipeline.draft?.id;
    if (!versionId) throw new Error("Expected an initial draft");
    await store.markVersionValidated(versionId, {
      definitionHash: "validated-hash",
      compilerVersion: "1.0.0",
      generatedSql: "SELECT event_id FROM analytics.events",
      outputSchema: [{ name: "event_id", type: "UInt64" }],
      lineage: [],
      diagnostics: [],
    });
    await store.markVersionTested(versionId);
    const artifact = {
      compilerVersion: "1.0.0",
      definitionHash: "validated-hash",
      sql: "SELECT event_id FROM analytics.events",
      runtimeSql: "SELECT event_id FROM analytics.events",
      parameters: [],
      outputColumns: [{ name: "event_id", type: "UInt64" }],
      lineage: [],
      destination: { database: "analytics", table: "events_clean", writeMode: "append" as const },
    };
    const deployment = await store.activateDeployment({
      pipelineId: pipeline.id,
      versionId,
      connectionId: pipeline.connectionId,
      triggerType: "incremental_mv",
      triggerConfig: { concurrencyPolicy: "queue_one" },
      artifact,
      artifactChecksum: "checksum-1",
      runtimeJobId: null,
      nativeObjectName: "vp_runtime",
      nativeObjectUuid: "11111111-1111-4111-8111-111111111111",
      webhookSecretEncrypted: "encrypted-secret",
      deployedBy: "owner-1",
    });
    expect((await store.getActiveDeployment(pipeline.id))?.id).toBe(deployment.id);
    expect(await store.getDeploymentWebhookSecret(deployment.id)).toBe("encrypted-secret");

    const leaseToken = "lease-1";
    expect(await store.acquireRunLease(pipeline.id, leaseToken, Date.now() + 60_000)).toBe("acquired");
    expect(await store.acquireRunLease(pipeline.id, "lease-2", Date.now() + 60_000)).toBe("busy");
    expect(await store.acquireRunLease(pipeline.id, "lease-3", Date.now() + 60_000, { triggerType: "webhook" })).toBe("queued");
    expect(await store.acquireRunLease(pipeline.id, "lease-4", Date.now() + 60_000, { triggerType: "manual" })).toBe("busy");
    expect(await store.releaseRunLease(pipeline.id, leaseToken)).toEqual({ triggerType: "webhook" });

    const firstEvent = await store.recordExternalEvent({
      pipelineId: pipeline.id,
      source: "airbyte",
      externalEventId: "job-42",
      payloadHash: "hash",
      payload: { status: "succeeded" },
      signatureValid: true,
    });
    const duplicateEvent = await store.recordExternalEvent({
      pipelineId: pipeline.id,
      source: "airbyte",
      externalEventId: "job-42",
      payloadHash: "hash",
      payload: { status: "succeeded" },
      signatureValid: true,
    });
    expect(firstEvent.created).toBe(true);
    expect(duplicateEvent).toEqual({ id: firstEvent.id, created: false, status: "RECEIVED" });
    const failedEvent = await store.recordExternalEvent({
      pipelineId: pipeline.id,
      source: "airbyte",
      externalEventId: "job-43",
      payloadHash: "failed-hash",
      payload: { status: "failed" },
      signatureValid: true,
    });
    await store.updateExternalEventStatus(failedEvent.id, "IGNORED");
    expect(await store.claimIgnoredExternalEvent(failedEvent.id, "success-hash", { status: "succeeded" })).toBe(true);
    expect(await store.claimIgnoredExternalEvent(failedEvent.id, "success-hash", { status: "succeeded" })).toBe(false);

    const metadata = await store.upsertBusinessMetadata({
      pipelineId: pipeline.id,
      entityType: "column",
      entityKey: "analytics.events.event_id",
      description: "Business event identifier",
      businessOwner: "Operations",
      dataOwner: null,
      sensitivity: "internal",
      sourceSystem: "ERP",
      refreshFrequency: "streaming",
      businessDefinition: null,
    });
    expect((await store.listBusinessMetadata(pipeline.id))[0]?.description).toBe("Business event identifier");
    const updatedMetadata = await store.upsertBusinessMetadata({
      pipelineId: pipeline.id,
      entityType: "column",
      entityKey: "analytics.events.event_id",
      description: "Canonical event identifier",
      businessOwner: "Operations",
      dataOwner: null,
      sensitivity: "internal",
      sourceSystem: "ERP",
      refreshFrequency: "streaming",
      businessDefinition: null,
    });
    expect(updatedMetadata.id).toBe(metadata.id);
    expect(updatedMetadata.description).toBe("Canonical event identifier");

    const nativeInput = {
      deploymentId: deployment.id,
      connectionId: pipeline.connectionId,
      viewUuid: deployment.nativeObjectUuid ?? "",
      initialQueryId: "query-1",
      eventTimeMs: 1234,
      status: "success",
      durationMs: 15,
      readRows: 10,
      writtenRows: 10,
      errorCode: null,
      errorMessage: null,
    };
    expect(await store.recordNativeRun(nativeInput)).toBe(true);
    expect(await store.recordNativeRun(nativeInput)).toBe(false);
    expect((await store.listNativeRuns(deployment.id))[0]?.initialQueryId).toBe("query-1");
    expect(await store.deleteBusinessMetadata(pipeline.id, metadata.id)).toBe(true);
    expect(await store.listBusinessMetadata(pipeline.id)).toEqual([]);

    await store.retireDeployment(deployment.id, "owner-1");
    expect((await store.getDeployment(deployment.id))?.status).toBe("RETIRED");
    expect((await store.getPipeline(pipeline.id))?.activeDeploymentId).toBeNull();
  });
});
