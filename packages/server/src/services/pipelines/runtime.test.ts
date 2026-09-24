import { describe, expect, it } from "bun:test";

import { deploymentConcurrencyPolicy, runtimeJobInput } from "./runtime";
import type { VisualPipelineDeploymentRow } from "./types";

const deployment: VisualPipelineDeploymentRow = {
  id: "deployment-1",
  pipelineId: "pipeline-1",
  versionId: "version-1",
  connectionId: "connection-1",
  triggerType: "schedule",
  triggerConfig: {
    concurrencyPolicy: "queue_one",
    frequency: "cron",
    cronExpr: "*/15 * * * *",
    timezone: "Asia/Ho_Chi_Minh",
    timeoutSecs: 120,
    maxAttempts: 3,
    retentionDays: 30,
  },
  artifact: {
    compilerVersion: "1.0.0",
    definitionHash: "hash",
    sql: "SELECT event_id FROM analytics.events",
    runtimeSql: "SELECT event_id FROM analytics.events",
    parameters: [],
    outputColumns: [{ name: "event_id", type: "UInt64" }],
    lineage: [],
    destination: { database: "analytics", table: "events_clean", writeMode: "replace" },
  },
  artifactChecksum: "checksum",
  runtimeJobId: "job-1",
  nativeObjectName: null,
  nativeObjectUuid: null,
  hasWebhookSecret: false,
  status: "ACTIVE",
  deployedBy: "owner-1",
  deployedAt: 1,
  retiredBy: null,
  retiredAt: null,
};

describe("pipeline runtime mapping", () => {
  it("maps deployment scheduling, materialization, retries, and retention to a hidden scheduled job", () => {
    const input = runtimeJobInput("Sales mart", "Build mart", deployment);
    expect(input).toEqual(expect.objectContaining({
      name: "[Pipeline] Sales mart",
      enabled: true,
      frequency: "cron",
      cronExpr: "*/15 * * * *",
      timezone: "Asia/Ho_Chi_Minh",
      outputMode: "replace",
      destDatabase: "analytics",
      destTable: "events_clean",
      timeoutSecs: 120,
      maxAttempts: 3,
      retentionDays: 30,
    }));
    expect(deploymentConcurrencyPolicy(deployment)).toBe("queue_one");
  });

  it("keeps webhook/manual jobs disabled and clamps unsafe runtime limits", () => {
    const input = runtimeJobInput("Webhook", null, {
      ...deployment,
      triggerType: "webhook",
      triggerConfig: { concurrencyPolicy: "invalid", timeoutSecs: 1, maxAttempts: 99, retentionDays: 9999 },
    });
    expect(input.enabled).toBe(false);
    expect(input.frequency).toBe("manual");
    expect(input.timeoutSecs).toBe(5);
    expect(input.maxAttempts).toBe(10);
    expect(input.retentionDays).toBe(3650);
    expect(deploymentConcurrencyPolicy({ ...deployment, triggerConfig: null })).toBe("do_not_overlap");
  });

  it("carries managed-destination creation into the materialization runtime", () => {
    const input = runtimeJobInput("Managed output", null, {
      ...deployment,
      artifact: {
        ...deployment.artifact,
        destination: {
          database: "analytics",
          table: "managed_output",
          writeMode: "append",
          createIfMissing: true,
        },
      },
    });

    expect(input.outputConfig).toEqual({
      expectedSchema: [{ name: "event_id", type: "UInt64" }],
      createIfMissing: true,
    });
  });
});
