import { createHash } from "node:crypto";

import type { PipelineDefinition } from "./definition";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalValue(child)]);
  return Object.fromEntries(entries);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function semanticPipelineJson(definition: PipelineDefinition): string {
  const nodes = definition.nodes
    .map((node) => Object.fromEntries(Object.entries(node).filter(([key]) => key !== "position")))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const edges = [...definition.edges].sort((left, right) => left.id.localeCompare(right.id));
  return canonicalJson({ schemaVersion: definition.schemaVersion, nodes, edges });
}

export function pipelineDefinitionHash(definition: PipelineDefinition): string {
  return createHash("sha256").update(semanticPipelineJson(definition)).digest("hex");
}
