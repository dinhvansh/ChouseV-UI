import { describe, expect, it } from "vitest";

import {
  buildAirbyteWebhookUrl,
  buildBashWebhookExample,
  buildPowerShellWebhookExample,
  buildWebhookUrl,
} from "./webhookSetup";

describe("pipeline webhook setup", () => {
  it("builds an absolute encoded endpoint", () => {
    expect(buildWebhookUrl("https://chouse.example/", "pipeline/id"))
      .toBe("https://chouse.example/api/pipelines/pipeline%2Fid/webhook");
  });

  it("builds an Airbyte URL with an encoded token", () => {
    expect(buildAirbyteWebhookUrl("https://chouse.example/", "pipeline/id", "secret/value"))
      .toBe("https://chouse.example/api/pipelines/pipeline%2Fid/webhook/airbyte?token=secret%2Fvalue");
  });

  it("builds a runnable Bash API-key example with a unique event id", () => {
    const example = buildBashWebhookExample("https://chouse.example/hook", "secret-1");
    expect(example).toContain("timestamp=$(date +%s)");
    expect(example).toContain("X-CHouse-API-Key: secret-1");
    expect(example).toContain("manual-test-$timestamp");
    expect(example).toContain('--data "{\\"source\\":\\"manual-test\\"');
  });

  it("builds a runnable PowerShell API-key example", () => {
    const example = buildPowerShellWebhookExample("https://chouse.example/hook", "secret-1");
    expect(example).toContain("[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()");
    expect(example).toContain('"X-CHouse-API-Key" = "secret-1"');
    expect(example).toContain("Invoke-RestMethod");
  });
});
