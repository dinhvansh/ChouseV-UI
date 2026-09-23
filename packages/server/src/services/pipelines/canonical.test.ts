import { describe, expect, it } from "bun:test";

import { pipelineDefinitionHash, semanticPipelineJson } from "./canonical";
import { pipelineDefinitionSchema } from "./definition";

const base = pipelineDefinitionSchema.parse({
  schemaVersion: 1,
  nodes: [
    { id: "source_a", type: "source", position: { x: 0, y: 0 }, config: { database: "raw", table: "events" } },
    { id: "destination_a", type: "destination", position: { x: 200, y: 0 }, config: { database: "ods", table: "events", writeMode: "append" } },
  ],
  edges: [{ id: "edge_a", from: "source_a", to: "destination_a", input: "main" }],
});

describe("pipelineDefinitionHash", () => {
  it("ignores canvas positions", () => {
    const moved = structuredClone(base);
    moved.nodes[0].position = { x: 999, y: -50 };
    expect(pipelineDefinitionHash(moved)).toBe(pipelineDefinitionHash(base));
  });

  it("is stable when semantic collections are reordered", () => {
    const reordered = structuredClone(base);
    reordered.nodes.reverse();
    expect(pipelineDefinitionHash(reordered)).toBe(pipelineDefinitionHash(base));
  });

  it("changes when transform semantics change", () => {
    const changed = structuredClone(base);
    const destination = changed.nodes.find((node) => node.type === "destination");
    if (!destination) throw new Error("Fixture destination is missing");
    destination.config.writeMode = "replace";
    expect(pipelineDefinitionHash(changed)).not.toBe(pipelineDefinitionHash(base));
  });

  it("renders a canonical representation without presentation data", () => {
    expect(semanticPipelineJson(base)).not.toContain("position");
    expect(semanticPipelineJson(base)).toContain("source_a");
  });
});
