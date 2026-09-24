import { escapeIdentifier, escapeQualifiedIdentifier } from "../../utils/sqlIdentifier";
import {
  validatePipelineDefinition,
  type PipelineColumn,
  type PipelineDefinition,
  type PipelineDestinationNode,
  type PipelineDiagnostic,
  type PipelineExpression,
  type PipelineFunction,
  type PipelineLiteralExpression,
  type PipelineNode,
} from "./definition";

export const PIPELINE_COMPILER_VERSION = "1";

export type PipelineParameterValue = string | number | boolean | null;

export interface PipelineParameter {
  name: string;
  type: string;
  value: PipelineParameterValue;
}

export interface PipelineLineageSource {
  nodeId: string;
  column: string;
}

export interface PipelineLineageEntry {
  outputColumn: string;
  sources: PipelineLineageSource[];
}

export interface PipelineCompileOptions {
  sourceSchemas: Record<string, PipelineColumn[]>;
}

export interface CompiledPipeline {
  compilerVersion: string;
  sql: string;
  parameters: PipelineParameter[];
  outputColumns: PipelineColumn[];
  lineage: PipelineLineageEntry[];
  destination: PipelineDestinationNode["config"];
  diagnostics: PipelineDiagnostic[];
}

function clickHouseLiteral(parameter: PipelineParameter): string {
  if (parameter.value === null) return `CAST(NULL, 'Nullable(${parameter.type})')`;
  if (typeof parameter.value === "boolean") return `CAST(${parameter.value ? 1 : 0}, '${parameter.type}')`;
  if (typeof parameter.value === "number") return `CAST(${String(parameter.value)}, '${parameter.type}')`;
  const escaped = parameter.value.replace(/\\/g, "\\\\").replace(/'/g, "''");
  return `CAST('${escaped}', '${parameter.type}')`;
}

export function renderPipelineRuntimeSql(compiled: Pick<CompiledPipeline, "sql" | "parameters">): string {
  let sql = compiled.sql;
  for (const parameter of compiled.parameters) {
    sql = sql.split(`{${parameter.name}:${parameter.type}}`).join(clickHouseLiteral(parameter));
  }
  return sql;
}

interface CompiledStage {
  cteName: string;
  columns: PipelineColumn[];
  lineage: PipelineLineageEntry[];
}

interface RenderContext {
  columns: PipelineColumn[];
  parameters: PipelineParameter[];
  nodeId: string;
}

const BINARY_SQL: Record<Extract<PipelineExpression, { kind: "binary" }>["operator"], string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  and: "AND",
  or: "OR",
  add: "+",
  subtract: "-",
  multiply: "*",
  divide: "/",
};

export class PipelineCompileError extends Error {
  readonly diagnostics: PipelineDiagnostic[];

  constructor(diagnostics: PipelineDiagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join("; "));
    this.name = "PipelineCompileError";
    this.diagnostics = diagnostics;
  }
}

function compileError(code: string, message: string, nodeId?: string): PipelineCompileError {
  return new PipelineCompileError([{ code, severity: "error", message, nodeId }]);
}

function inferredLiteralType(expression: PipelineLiteralExpression, nodeId: string): string {
  if (expression.dataType) return expression.dataType;
  if (expression.value === null) {
    throw compileError("expression.null_type", "Null literals require an explicit dataType", nodeId);
  }
  if (typeof expression.value === "string") return "String";
  if (typeof expression.value === "boolean") return "Bool";
  return Number.isInteger(expression.value) ? "Int64" : "Float64";
}

function validateLiteralValue(expression: PipelineLiteralExpression, dataType: string, nodeId: string): void {
  if (expression.value === null) return;
  const numeric = /^(?:U?Int(?:8|16|32|64)|Float(?:32|64))$/.test(dataType);
  if (numeric && typeof expression.value !== "number") {
    throw compileError("expression.literal_type", `Literal for ${dataType} must be a number`, nodeId);
  }
  if (dataType === "Bool" && typeof expression.value !== "boolean") {
    throw compileError("expression.literal_type", "Literal for Bool must be a boolean", nodeId);
  }
  if (["String", "Date", "Date32", "DateTime", "DateTime64", "UUID"].includes(dataType) && typeof expression.value !== "string") {
    throw compileError("expression.literal_type", `Literal for ${dataType} must be a string`, nodeId);
  }
}

function renderExpression(expression: PipelineExpression, context: RenderContext): string {
  if (expression.kind === "column") {
    if (!context.columns.some((column) => column.name === expression.name)) {
      throw compileError("expression.unknown_column", `Unknown column: ${expression.name}`, context.nodeId);
    }
    return escapeIdentifier(expression.name);
  }
  if (expression.kind === "literal") {
    const type = inferredLiteralType(expression, context.nodeId);
    validateLiteralValue(expression, type, context.nodeId);
    const name = `vp_${context.parameters.length + 1}`;
    context.parameters.push({ name, type, value: expression.value });
    return `{${name}:${type}}`;
  }
  if (expression.kind === "function") {
    const args = expression.args.map((argument) => renderExpression(argument, context));
    const arity = expression.args.length;
    const unary = new Set<PipelineFunction>(["lower", "upper", "trim", "length", "abs", "toDate", "toDateTime"]);
    if (unary.has(expression.function) && arity !== 1) {
      throw compileError("expression.function_arity", `${expression.function} expects exactly one argument`, context.nodeId);
    }
    if (expression.function === "ifNull" && arity !== 2) {
      throw compileError("expression.function_arity", "ifNull expects exactly two arguments", context.nodeId);
    }
    if (expression.function === "round" && (arity < 1 || arity > 2)) {
      throw compileError("expression.function_arity", "round expects one or two arguments", context.nodeId);
    }
    if (expression.function === "concat" && arity < 1) {
      throw compileError("expression.function_arity", "concat expects at least one argument", context.nodeId);
    }
    if (expression.function === "coalesce" && arity < 1) {
      throw compileError("expression.function_arity", "coalesce expects at least one argument", context.nodeId);
    }
    return `${expression.function}(${args.join(", ")})`;
  }
  const left = renderExpression(expression.left, context);
  const right = renderExpression(expression.right, context);
  return `(${left} ${BINARY_SQL[expression.operator]} ${right})`;
}

function projection(columns: PipelineColumn[]): string {
  return columns.map((column) => `    ${escapeIdentifier(column.name)}`).join(",\n");
}

function cteName(node: PipelineNode): string {
  return `vp_${node.id}`;
}

function inputStage(
  definition: PipelineDefinition,
  stages: Map<string, CompiledStage>,
  node: PipelineNode,
): CompiledStage {
  const edge = definition.edges.find((candidate) => candidate.to === node.id);
  if (!edge) throw compileError("compiler.missing_input", `Missing input for node ${node.id}`, node.id);
  const stage = stages.get(edge.from);
  if (!stage) throw compileError("compiler.input_not_compiled", `Input ${edge.from} was not compiled`, node.id);
  return stage;
}

function inputStageForPort(
  definition: PipelineDefinition,
  stages: Map<string, CompiledStage>,
  node: PipelineNode,
  port: "left" | "right",
): CompiledStage {
  const edge = definition.edges.find((candidate) => candidate.to === node.id && candidate.input === port);
  if (!edge) throw compileError("compiler.missing_input", `Missing ${port} input for node ${node.id}`, node.id);
  const stage = stages.get(edge.from);
  if (!stage) throw compileError("compiler.input_not_compiled", `Input ${edge.from} was not compiled`, node.id);
  return stage;
}

function inputStages(
  definition: PipelineDefinition,
  stages: Map<string, CompiledStage>,
  node: PipelineNode,
): CompiledStage[] {
  return definition.edges
    .filter((edge) => edge.to === node.id)
    .sort((left, right) => left.from.localeCompare(right.from) || left.id.localeCompare(right.id))
    .map((edge) => {
      const stage = stages.get(edge.from);
      if (!stage) throw compileError("compiler.input_not_compiled", `Input ${edge.from} was not compiled`, node.id);
      return stage;
    });
}

function columnByName(stage: CompiledStage, name: string, nodeId: string): PipelineColumn {
  const column = stage.columns.find((candidate) => candidate.name === name);
  if (!column) throw compileError("schema.unknown_column", `Unknown column: ${name}`, nodeId);
  return column;
}

function expressionColumns(expression: PipelineExpression): string[] {
  if (expression.kind === "column") return [expression.name];
  if (expression.kind === "literal") return [];
  if (expression.kind === "function") return expression.args.flatMap(expressionColumns);
  return [...expressionColumns(expression.left), ...expressionColumns(expression.right)];
}

function lineageForColumns(stage: CompiledStage, names: string[]): PipelineLineageSource[] {
  const unique = new Map<string, PipelineLineageSource>();
  for (const name of names) {
    const entry = stage.lineage.find((candidate) => candidate.outputColumn === name);
    for (const source of entry?.sources ?? []) unique.set(`${source.nodeId}:${source.column}`, source);
  }
  return [...unique.values()];
}

function aggregateType(fn: "count" | "sum" | "avg" | "min" | "max" | "uniq" | "uniqExact", source?: PipelineColumn): string {
  if (["count", "uniq", "uniqExact"].includes(fn)) return "UInt64";
  if (fn === "avg") return "Float64";
  return source?.type ?? "UInt64";
}

function windowType(fn: "row_number" | "rank" | "dense_rank" | "sum" | "avg" | "min" | "max", source?: PipelineColumn): string {
  if (["row_number", "rank", "dense_rank"].includes(fn)) return "UInt64";
  if (fn === "avg") return "Float64";
  return source?.type ?? "UInt64";
}

function topologicalNodes(definition: PipelineDefinition): PipelineNode[] {
  const nodesById = new Map(definition.nodes.map((node) => [node.id, node]));
  const incoming = new Map(definition.nodes.map((node) => [node.id, 0]));
  for (const edge of definition.edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const ready = definition.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id).sort();
  const ordered: PipelineNode[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (!id) break;
    const node = nodesById.get(id);
    if (!node) continue;
    ordered.push(node);
    for (const edge of definition.edges.filter((candidate) => candidate.from === id)) {
      const count = (incoming.get(edge.to) ?? 0) - 1;
      incoming.set(edge.to, count);
      if (count === 0) {
        ready.push(edge.to);
        ready.sort();
      }
    }
  }
  return ordered;
}

function assertDistinctColumnNames(columns: PipelineColumn[], nodeId: string): void {
  const names = new Set<string>();
  for (const column of columns) {
    if (names.has(column.name)) {
      throw compileError("schema.duplicate_column", `Duplicate output column: ${column.name}`, nodeId);
    }
    names.add(column.name);
  }
}

export function compilePipeline(input: unknown, options: PipelineCompileOptions): CompiledPipeline {
  const validation = validatePipelineDefinition(input);
  if (!validation.ok || !validation.definition) throw new PipelineCompileError(validation.diagnostics);
  const definition = validation.definition;
  const parameters: PipelineParameter[] = [];
  const stages = new Map<string, CompiledStage>();
  const ctes: string[] = [];
  let destination: PipelineDestinationNode["config"] | undefined;
  let finalStage: CompiledStage | undefined;

  for (const node of topologicalNodes(definition)) {
    if (node.type === "source") {
      const columns = options.sourceSchemas[node.id];
      if (!columns || columns.length === 0) {
        throw compileError("schema.source_missing", `Source schema is required for node ${node.id}`, node.id);
      }
      assertDistinctColumnNames(columns, node.id);
      const name = cteName(node);
      const lineage = columns.map((column) => ({
        outputColumn: column.name,
        sources: [{ nodeId: node.id, column: column.name }],
      }));
      ctes.push(`${escapeIdentifier(name)} AS (\n  SELECT\n${projection(columns)}\n  FROM ${escapeQualifiedIdentifier([node.config.database, node.config.table])}\n)`);
      stages.set(node.id, { cteName: name, columns, lineage });
      continue;
    }

    if (node.type === "destination") {
      const input = inputStage(definition, stages, node);
      destination = node.config;
      finalStage = input;
      continue;
    }

    const name = cteName(node);
    if (node.type === "join") {
      const left = inputStageForPort(definition, stages, node, "left");
      const right = inputStageForPort(definition, stages, node, "right");
      const joinType = node.config.joinType.toUpperCase();
      const conditions = node.config.conditions.map((condition) => {
        columnByName(left, condition.left, node.id);
        columnByName(right, condition.right, node.id);
        return `l.${escapeIdentifier(condition.left)} = r.${escapeIdentifier(condition.right)}`;
      });
      const columns: PipelineColumn[] = [...left.columns];
      const lineage: PipelineLineageEntry[] = left.lineage.map((entry) => ({ ...entry, sources: [...entry.sources] }));
      const selectSql = left.columns.map((column) => `    l.${escapeIdentifier(column.name)}`);
      for (const selected of node.config.rightColumns) {
        const source = columnByName(right, selected.source, node.id);
        const outputName = selected.alias ?? selected.source;
        columns.push({ name: outputName, type: source.type });
        lineage.push({ outputColumn: outputName, sources: lineageForColumns(right, [selected.source]) });
        selectSql.push(`    r.${escapeIdentifier(selected.source)}${outputName === selected.source ? "" : ` AS ${escapeIdentifier(outputName)}`}`);
      }
      assertDistinctColumnNames(columns, node.id);
      ctes.push(`${escapeIdentifier(name)} AS (\n  SELECT\n${selectSql.join(",\n")}\n  FROM ${escapeIdentifier(left.cteName)} AS l\n  ${joinType} JOIN ${escapeIdentifier(right.cteName)} AS r ON ${conditions.join(" AND ")}\n)`);
      stages.set(node.id, { cteName: name, columns, lineage });
      continue;
    }

    if (node.type === "union") {
      const inputs = inputStages(definition, stages, node);
      const first = inputs[0];
      if (!first) throw compileError("compiler.missing_input", `Missing inputs for node ${node.id}`, node.id);
      for (const candidate of inputs.slice(1)) {
        const compatible = candidate.columns.length === first.columns.length && candidate.columns.every((column, index) => {
          const expected = first.columns[index];
          return expected?.name === column.name && expected.type === column.type;
        });
        if (!compatible) throw compileError("schema.union_mismatch", "Union inputs must have identical ordered columns and types", node.id);
      }
      const operator = node.config.mode === "all" ? "UNION ALL" : "UNION DISTINCT";
      const parts = inputs.map((stage) => `  SELECT\n${projection(stage.columns)}\n  FROM ${escapeIdentifier(stage.cteName)}`);
      const lineage = first.columns.map((column) => ({
        outputColumn: column.name,
        sources: inputs.flatMap((stage) => lineageForColumns(stage, [column.name])),
      }));
      ctes.push(`${escapeIdentifier(name)} AS (\n${parts.join(`\n  ${operator}\n`)}\n)`);
      stages.set(node.id, { cteName: name, columns: first.columns, lineage });
      continue;
    }

    const input = inputStage(definition, stages, node);
    if (node.type === "filter") {
      const expression = renderExpression(node.config.expression, { columns: input.columns, parameters, nodeId: node.id });
      ctes.push(`${escapeIdentifier(name)} AS (\n  SELECT\n${projection(input.columns)}\n  FROM ${escapeIdentifier(input.cteName)}\n  WHERE ${expression}\n)`);
      stages.set(node.id, { cteName: name, columns: input.columns, lineage: input.lineage });
      continue;
    }

    if (node.type === "select") {
      const inputByName = new Map(input.columns.map((column) => [column.name, column]));
      const columns: PipelineColumn[] = [];
      const lineage: PipelineLineageEntry[] = [];
      const selectSql: string[] = [];
      for (const selected of node.config.columns) {
        const source = inputByName.get(selected.source);
        if (!source) throw compileError("schema.unknown_column", `Unknown selected column: ${selected.source}`, node.id);
        const outputName = selected.alias ?? selected.source;
        columns.push({ name: outputName, type: source.type });
        const sourceLineage = input.lineage.find((entry) => entry.outputColumn === selected.source);
        lineage.push({ outputColumn: outputName, sources: sourceLineage?.sources ?? [] });
        const alias = outputName === selected.source ? "" : ` AS ${escapeIdentifier(outputName)}`;
        selectSql.push(`    ${escapeIdentifier(selected.source)}${alias}`);
      }
      assertDistinctColumnNames(columns, node.id);
      ctes.push(`${escapeIdentifier(name)} AS (\n  SELECT\n${selectSql.join(",\n")}\n  FROM ${escapeIdentifier(input.cteName)}\n)`);
      stages.set(node.id, { cteName: name, columns, lineage });
      continue;
    }

    if (node.type === "calculated") {
      const columns = [...input.columns];
      const lineage = input.lineage.map((entry) => ({ ...entry, sources: [...entry.sources] }));
      const calculatedSql: string[] = [];
      for (const calculated of node.config.columns) {
        if (columns.some((column) => column.name === calculated.name)) {
          throw compileError("schema.duplicate_column", `Duplicate output column: ${calculated.name}`, node.id);
        }
        const expression = renderExpression(calculated.expression, { columns: input.columns, parameters, nodeId: node.id });
        columns.push({ name: calculated.name, type: calculated.dataType });
        lineage.push({ outputColumn: calculated.name, sources: lineageForColumns(input, expressionColumns(calculated.expression)) });
        calculatedSql.push(`    CAST(${expression}, '${calculated.dataType}') AS ${escapeIdentifier(calculated.name)}`);
      }
      ctes.push(`${escapeIdentifier(name)} AS (\n  SELECT\n${projection(input.columns)},\n${calculatedSql.join(",\n")}\n  FROM ${escapeIdentifier(input.cteName)}\n)`);
      stages.set(node.id, { cteName: name, columns, lineage });
      continue;
    }

    if (node.type === "deduplicate") {
      for (const key of node.config.keys) columnByName(input, key, node.id);
      for (const order of node.config.orderBy) columnByName(input, order.column, node.id);
      const orderSql = node.config.orderBy.map((order) => `${escapeIdentifier(order.column)} ${order.direction.toUpperCase()}`).join(", ");
      const keysSql = node.config.keys.map(escapeIdentifier).join(", ");
      ctes.push(`${escapeIdentifier(name)} AS (\n  SELECT\n${projection(input.columns)}\n  FROM ${escapeIdentifier(input.cteName)}\n  ORDER BY ${orderSql}\n  LIMIT 1 BY ${keysSql}\n)`);
      stages.set(node.id, { cteName: name, columns: input.columns, lineage: input.lineage });
      continue;
    }

    if (node.type === "aggregate") {
      const columns: PipelineColumn[] = [];
      const lineage: PipelineLineageEntry[] = [];
      const selectSql: string[] = [];
      for (const group of node.config.groupBy) {
        const column = columnByName(input, group, node.id);
        columns.push(column);
        lineage.push({ outputColumn: group, sources: lineageForColumns(input, [group]) });
        selectSql.push(`    ${escapeIdentifier(group)}`);
      }
      for (const aggregate of node.config.aggregates) {
        if (aggregate.function !== "count" && !aggregate.source) {
          throw compileError("aggregate.source_required", `${aggregate.function} requires a source column`, node.id);
        }
        const source = aggregate.source ? columnByName(input, aggregate.source, node.id) : undefined;
        const expression = aggregate.function === "count"
          ? "count()"
          : `${aggregate.function}(${escapeIdentifier(aggregate.source ?? "")})`;
        columns.push({ name: aggregate.alias, type: aggregateType(aggregate.function, source) });
        lineage.push({ outputColumn: aggregate.alias, sources: aggregate.source ? lineageForColumns(input, [aggregate.source]) : [] });
        selectSql.push(`    ${expression} AS ${escapeIdentifier(aggregate.alias)}`);
      }
      assertDistinctColumnNames(columns, node.id);
      const groupSql = node.config.groupBy.length > 0 ? `\n  GROUP BY ${node.config.groupBy.map(escapeIdentifier).join(", ")}` : "";
      ctes.push(`${escapeIdentifier(name)} AS (\n  SELECT\n${selectSql.join(",\n")}\n  FROM ${escapeIdentifier(input.cteName)}${groupSql}\n)`);
      stages.set(node.id, { cteName: name, columns, lineage });
      continue;
    }

    if (node.type === "sort") {
      for (const order of node.config.columns) columnByName(input, order.column, node.id);
      const orderSql = node.config.columns.map((order) => `${escapeIdentifier(order.column)} ${order.direction.toUpperCase()}`).join(", ");
      ctes.push(`${escapeIdentifier(name)} AS (\n  SELECT\n${projection(input.columns)}\n  FROM ${escapeIdentifier(input.cteName)}\n  ORDER BY ${orderSql}\n)`);
      stages.set(node.id, { cteName: name, columns: input.columns, lineage: input.lineage });
      continue;
    }

    if (node.type === "window") {
      const columns = [...input.columns];
      const lineage = input.lineage.map((entry) => ({ ...entry, sources: [...entry.sources] }));
      const windowSql: string[] = [];
      for (const window of node.config.columns) {
        const ranking = ["row_number", "rank", "dense_rank"].includes(window.function);
        if (!ranking && !window.source) throw compileError("window.source_required", `${window.function} requires a source column`, node.id);
        const source = window.source ? columnByName(input, window.source, node.id) : undefined;
        for (const partition of window.partitionBy) columnByName(input, partition, node.id);
        for (const order of window.orderBy) columnByName(input, order.column, node.id);
        const args = ranking ? "" : escapeIdentifier(window.source ?? "");
        const partitionSql = window.partitionBy.length > 0 ? `PARTITION BY ${window.partitionBy.map(escapeIdentifier).join(", ")}` : "";
        const orderSql = window.orderBy.length > 0 ? `ORDER BY ${window.orderBy.map((order) => `${escapeIdentifier(order.column)} ${order.direction.toUpperCase()}`).join(", ")}` : "";
        const over = [partitionSql, orderSql].filter(Boolean).join(" ");
        columns.push({ name: window.alias, type: windowType(window.function, source) });
        lineage.push({ outputColumn: window.alias, sources: window.source ? lineageForColumns(input, [window.source]) : [] });
        windowSql.push(`    ${window.function}(${args}) OVER (${over}) AS ${escapeIdentifier(window.alias)}`);
      }
      assertDistinctColumnNames(columns, node.id);
      ctes.push(`${escapeIdentifier(name)} AS (\n  SELECT\n${projection(input.columns)},\n${windowSql.join(",\n")}\n  FROM ${escapeIdentifier(input.cteName)}\n)`);
      stages.set(node.id, { cteName: name, columns, lineage });
      continue;
    }

    const casts = new Map(node.config.columns.map((column) => [column.column, column.dataType]));
    for (const column of casts.keys()) {
      if (!input.columns.some((candidate) => candidate.name === column)) {
        throw compileError("schema.unknown_column", `Unknown cast column: ${column}`, node.id);
      }
    }
    const columns = input.columns.map((column) => ({
      name: column.name,
      type: casts.get(column.name) ?? column.type,
    }));
    const castSql = input.columns.map((column) => {
      const type = casts.get(column.name);
      return type
        ? `    CAST(${escapeIdentifier(column.name)}, '${type}') AS ${escapeIdentifier(column.name)}`
        : `    ${escapeIdentifier(column.name)}`;
    });
    ctes.push(`${escapeIdentifier(name)} AS (\n  SELECT\n${castSql.join(",\n")}\n  FROM ${escapeIdentifier(input.cteName)}\n)`);
    stages.set(node.id, { cteName: name, columns, lineage: input.lineage });
  }

  if (!destination || !finalStage) throw compileError("compiler.destination_missing", "Pipeline destination was not compiled");
  const sql = `WITH\n${ctes.map((cte) => `  ${cte}`).join(",\n")}\nSELECT\n${projection(finalStage.columns)}\nFROM ${escapeIdentifier(finalStage.cteName)}`;

  return {
    compilerVersion: PIPELINE_COMPILER_VERSION,
    sql,
    parameters,
    outputColumns: finalStage.columns,
    lineage: finalStage.lineage,
    destination,
    diagnostics: validation.diagnostics,
  };
}
