import { z } from "zod";

export const PIPELINE_DEFINITION_SCHEMA_VERSION = 1;

const nodeIdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,49}$/, "Node IDs must start with a letter and contain only letters, numbers, and underscores");

const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
}).strict();

export const pipelineColumnSchema = z.object({
  name: z.string().min(1).max(64),
  type: z.string().min(1).max(255),
}).strict();

export type PipelineColumn = z.infer<typeof pipelineColumnSchema>;

export const PIPELINE_CAST_TYPES = [
  "String",
  "Bool",
  "Int8",
  "Int16",
  "Int32",
  "Int64",
  "UInt8",
  "UInt16",
  "UInt32",
  "UInt64",
  "Float32",
  "Float64",
  "Date",
  "Date32",
  "DateTime",
  "DateTime64",
  "UUID",
] as const;

export const pipelineCastTypeSchema = z.enum(PIPELINE_CAST_TYPES);
export type PipelineCastType = z.infer<typeof pipelineCastTypeSchema>;

export const PIPELINE_BINARY_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "and",
  "or",
  "add",
  "subtract",
  "multiply",
  "divide",
] as const;

export type PipelineBinaryOperator = (typeof PIPELINE_BINARY_OPERATORS)[number];

export interface PipelineColumnExpression {
  kind: "column";
  name: string;
}

export interface PipelineLiteralExpression {
  kind: "literal";
  value: string | number | boolean | null;
  dataType?: PipelineCastType;
}

export interface PipelineBinaryExpression {
  kind: "binary";
  operator: PipelineBinaryOperator;
  left: PipelineExpression;
  right: PipelineExpression;
}

export type PipelineExpression =
  | PipelineColumnExpression
  | PipelineLiteralExpression
  | PipelineBinaryExpression;

export const pipelineExpressionSchema: z.ZodType<PipelineExpression> = z.lazy(() => z.union([
  z.object({
    kind: z.literal("column"),
    name: z.string().min(1).max(64),
  }).strict(),
  z.object({
    kind: z.literal("literal"),
    value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
    dataType: pipelineCastTypeSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("binary"),
    operator: z.enum(PIPELINE_BINARY_OPERATORS),
    left: pipelineExpressionSchema,
    right: pipelineExpressionSchema,
  }).strict(),
]));

const sourceNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("source"),
  position: positionSchema,
  config: z.object({
    database: z.string().min(1).max(64),
    table: z.string().min(1).max(64),
  }).strict(),
}).strict();

const filterNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("filter"),
  position: positionSchema,
  config: z.object({
    expression: pipelineExpressionSchema,
  }).strict(),
}).strict();

const selectNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("select"),
  position: positionSchema,
  config: z.object({
    columns: z.array(z.object({
      source: z.string().min(1).max(64),
      alias: z.string().min(1).max(64).optional(),
    }).strict()).min(1),
  }).strict(),
}).strict();

const castNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("cast"),
  position: positionSchema,
  config: z.object({
    columns: z.array(z.object({
      column: z.string().min(1).max(64),
      dataType: pipelineCastTypeSchema,
    }).strict()).min(1),
  }).strict(),
}).strict();

const calculatedNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("calculated"),
  position: positionSchema,
  config: z.object({
    columns: z.array(z.object({
      name: z.string().min(1).max(64),
      dataType: pipelineCastTypeSchema,
      expression: pipelineExpressionSchema,
    }).strict()).min(1),
  }).strict(),
}).strict();

const joinNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("join"),
  position: positionSchema,
  config: z.object({
    joinType: z.enum(["inner", "left", "right", "full"]),
    conditions: z.array(z.object({
      left: z.string().min(1).max(64),
      right: z.string().min(1).max(64),
    }).strict()).min(1),
    rightColumns: z.array(z.object({
      source: z.string().min(1).max(64),
      alias: z.string().min(1).max(64).optional(),
    }).strict()),
  }).strict(),
}).strict();

const unionNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("union"),
  position: positionSchema,
  config: z.object({ mode: z.enum(["all", "distinct"]) }).strict(),
}).strict();

const deduplicateNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("deduplicate"),
  position: positionSchema,
  config: z.object({
    keys: z.array(z.string().min(1).max(64)).min(1),
    orderBy: z.array(z.object({
      column: z.string().min(1).max(64),
      direction: z.enum(["asc", "desc"]),
    }).strict()).min(1),
  }).strict(),
}).strict();

const aggregateNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("aggregate"),
  position: positionSchema,
  config: z.object({
    groupBy: z.array(z.string().min(1).max(64)),
    aggregates: z.array(z.object({
      function: z.enum(["count", "sum", "avg", "min", "max", "uniq", "uniqExact"]),
      source: z.string().min(1).max(64).optional(),
      alias: z.string().min(1).max(64),
    }).strict()).min(1),
  }).strict(),
}).strict();

const sortColumnSchema = z.object({
  column: z.string().min(1).max(64),
  direction: z.enum(["asc", "desc"]),
}).strict();

const sortNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("sort"),
  position: positionSchema,
  config: z.object({ columns: z.array(sortColumnSchema).min(1) }).strict(),
}).strict();

const windowNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("window"),
  position: positionSchema,
  config: z.object({
    columns: z.array(z.object({
      function: z.enum(["row_number", "rank", "dense_rank", "sum", "avg", "min", "max"]),
      source: z.string().min(1).max(64).optional(),
      alias: z.string().min(1).max(64),
      partitionBy: z.array(z.string().min(1).max(64)),
      orderBy: z.array(sortColumnSchema),
    }).strict()).min(1),
  }).strict(),
}).strict();

export const PIPELINE_WRITE_MODES = ["append", "replace", "upsert"] as const;

const destinationNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("destination"),
  position: positionSchema,
  config: z.object({
    database: z.string().min(1).max(64),
    table: z.string().min(1).max(64),
    writeMode: z.enum(PIPELINE_WRITE_MODES),
  }).strict(),
}).strict();

export const pipelineNodeSchema = z.discriminatedUnion("type", [
  sourceNodeSchema,
  filterNodeSchema,
  selectNodeSchema,
  castNodeSchema,
  calculatedNodeSchema,
  joinNodeSchema,
  unionNodeSchema,
  deduplicateNodeSchema,
  aggregateNodeSchema,
  sortNodeSchema,
  windowNodeSchema,
  destinationNodeSchema,
]);

export type PipelineNode = z.infer<typeof pipelineNodeSchema>;
export type PipelineSourceNode = Extract<PipelineNode, { type: "source" }>;
export type PipelineDestinationNode = Extract<PipelineNode, { type: "destination" }>;

export const pipelineEdgeSchema = z.object({
  id: z.string().min(1).max(100),
  from: nodeIdSchema,
  to: nodeIdSchema,
  input: z.enum(["main", "left", "right"]),
}).strict();

export type PipelineEdge = z.infer<typeof pipelineEdgeSchema>;

export const pipelineDefinitionSchema = z.object({
  schemaVersion: z.literal(PIPELINE_DEFINITION_SCHEMA_VERSION),
  nodes: z.array(pipelineNodeSchema).min(2),
  edges: z.array(pipelineEdgeSchema).min(1),
}).strict();

export type PipelineDefinition = z.infer<typeof pipelineDefinitionSchema>;

export type PipelineDiagnosticSeverity = "error" | "warning";

export interface PipelineDiagnostic {
  code: string;
  severity: PipelineDiagnosticSeverity;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface PipelineValidationResult {
  ok: boolean;
  definition?: PipelineDefinition;
  diagnostics: PipelineDiagnostic[];
}

function zodDiagnostics(error: z.ZodError): PipelineDiagnostic[] {
  return error.issues.map((issue) => ({
    code: "definition.invalid",
    severity: "error",
    message: `${issue.path.join(".") || "definition"}: ${issue.message}`,
  }));
}

function duplicateValues(values: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

export function validatePipelineGraph(definition: PipelineDefinition): PipelineDiagnostic[] {
  const diagnostics: PipelineDiagnostic[] = [];
  const duplicateNodeIds = duplicateValues(definition.nodes.map((node) => node.id));
  const duplicateEdgeIds = duplicateValues(definition.edges.map((edge) => edge.id));

  for (const nodeId of duplicateNodeIds) {
    diagnostics.push({ code: "graph.duplicate_node", severity: "error", message: `Duplicate node ID: ${nodeId}`, nodeId });
  }
  for (const edgeId of duplicateEdgeIds) {
    diagnostics.push({ code: "graph.duplicate_edge", severity: "error", message: `Duplicate edge ID: ${edgeId}`, edgeId });
  }

  const nodesById = new Map(definition.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const node of definition.nodes) {
    incoming.set(node.id, 0);
    outgoing.set(node.id, 0);
  }

  for (const edge of definition.edges) {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from) {
      diagnostics.push({ code: "graph.unknown_source", severity: "error", message: `Edge references unknown source node: ${edge.from}`, edgeId: edge.id });
    }
    if (!to) {
      diagnostics.push({ code: "graph.unknown_target", severity: "error", message: `Edge references unknown target node: ${edge.to}`, edgeId: edge.id });
    }
    if (!from || !to) continue;
    outgoing.set(from.id, (outgoing.get(from.id) ?? 0) + 1);
    incoming.set(to.id, (incoming.get(to.id) ?? 0) + 1);
  }

  const sources = definition.nodes.filter((node) => node.type === "source");
  const destinations = definition.nodes.filter((node) => node.type === "destination");
  if (sources.length < 1) {
    diagnostics.push({ code: "graph.source_count", severity: "error", message: "Expected at least one source node" });
  }
  if (destinations.length !== 1) {
    diagnostics.push({ code: "graph.destination_count", severity: "error", message: `Expected exactly one destination node, found ${destinations.length}` });
  }

  for (const node of definition.nodes) {
    const inputCount = incoming.get(node.id) ?? 0;
    const outputCount = outgoing.get(node.id) ?? 0;
    if (node.type === "source" && inputCount !== 0) {
      diagnostics.push({ code: "graph.source_has_input", severity: "error", message: "Source nodes cannot have incoming edges", nodeId: node.id });
    }
    if (node.type === "join") {
      const edges = definition.edges.filter((edge) => edge.to === node.id);
      if (inputCount !== 2 || edges.filter((edge) => edge.input === "left").length !== 1 || edges.filter((edge) => edge.input === "right").length !== 1) {
        diagnostics.push({ code: "graph.join_inputs", severity: "error", message: "Join nodes require exactly one left and one right input", nodeId: node.id });
      }
    } else if (node.type === "union") {
      if (inputCount < 2) diagnostics.push({ code: "graph.union_inputs", severity: "error", message: "Union nodes require at least two inputs", nodeId: node.id });
    } else if (node.type !== "source" && inputCount !== 1) {
      diagnostics.push({ code: "graph.input_count", severity: "error", message: `${node.type} node must have exactly one incoming edge`, nodeId: node.id });
    }
    if (node.type === "destination" && outputCount !== 0) {
      diagnostics.push({ code: "graph.destination_has_output", severity: "error", message: "Destination nodes cannot have outgoing edges", nodeId: node.id });
    }
    if (node.type !== "destination" && outputCount < 1) {
      diagnostics.push({ code: "graph.output_count", severity: "error", message: `${node.type} node must have at least one outgoing edge`, nodeId: node.id });
    }
  }

  if (duplicateNodeIds.size === 0) {
    const remainingIncoming = new Map(incoming);
    const ready = definition.nodes
      .filter((node) => (remainingIncoming.get(node.id) ?? 0) === 0)
      .map((node) => node.id)
      .sort();
    let visited = 0;
    while (ready.length > 0) {
      const nodeId = ready.shift();
      if (!nodeId) break;
      visited += 1;
      for (const edge of definition.edges.filter((candidate) => candidate.from === nodeId)) {
        if (!nodesById.has(edge.to)) continue;
        const nextCount = (remainingIncoming.get(edge.to) ?? 0) - 1;
        remainingIncoming.set(edge.to, nextCount);
        if (nextCount === 0) {
          ready.push(edge.to);
          ready.sort();
        }
      }
    }
    if (visited !== definition.nodes.length) {
      diagnostics.push({ code: "graph.cycle", severity: "error", message: "Pipeline graph contains a cycle" });
    }
  }

  return diagnostics;
}

export function validatePipelineDefinition(input: unknown): PipelineValidationResult {
  const parsed = pipelineDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, diagnostics: zodDiagnostics(parsed.error) };
  }
  const diagnostics = validatePipelineGraph(parsed.data);
  return {
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    definition: parsed.data,
    diagnostics,
  };
}
