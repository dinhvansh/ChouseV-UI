import type { ColumnInfo } from "@/api/explorer";
import type {
  PipelineCastType,
  PipelineDefinition,
  PipelineExpression,
  PipelineNode,
  VisualPipelineDetail,
} from "@/api/pipelines";

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
] as const satisfies readonly PipelineCastType[];

export const FILTER_OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];
export type DestinationMode = "existing" | "new";

export interface DesignerFields {
  name: string;
  description: string;
  sourceDatabase: string;
  sourceTable: string;
  filterColumn: string;
  filterOperator: FilterOperator;
  filterValue: string;
  selectedColumns: string[];
  columnAliases: Record<string, string>;
  castColumn: string;
  castType: PipelineCastType;
  destinationMode: DestinationMode;
  destinationDatabase: string;
  destinationTable: string;
  writeMode: "append" | "replace" | "upsert";
}

export const EMPTY_FIELDS: DesignerFields = {
  name: "",
  description: "",
  sourceDatabase: "",
  sourceTable: "",
  filterColumn: "",
  filterOperator: "eq",
  filterValue: "",
  selectedColumns: [],
  columnAliases: {},
  castColumn: "",
  castType: "String",
  destinationMode: "existing",
  destinationDatabase: "",
  destinationTable: "",
  writeMode: "append",
};

function isFilterOperator(value: string): value is FilterOperator {
  return FILTER_OPERATORS.some((operator) => operator === value);
}

function isPipelineCastType(value: string | undefined): value is PipelineCastType {
  return value !== undefined && PIPELINE_CAST_TYPES.some((type) => type === value);
}

export function fieldsFromPipeline(pipeline: VisualPipelineDetail): DesignerFields {
  const nodes = pipeline.draft?.definition.nodes ?? [];
  const source = nodes.find((node) => node.type === "source");
  const filter = nodes.find((node) => node.type === "filter");
  const select = nodes.find((node) => node.type === "select");
  const cast = nodes.find((node) => node.type === "cast");
  const destination = nodes.find((node) => node.type === "destination");
  const expression = filter?.type === "filter" ? filter.config.expression : undefined;
  const filterOperator = expression?.kind === "binary" && isFilterOperator(expression.operator)
    ? expression.operator
    : "eq";
  const simpleFilter = expression?.kind === "binary" && isFilterOperator(expression.operator) ? expression : undefined;
  const filterColumn = simpleFilter?.left.kind === "column" ? simpleFilter.left.name : "";
  const filterValue = simpleFilter?.right.kind === "literal" ? String(simpleFilter.right.value ?? "") : "";
  const selectedColumns = select?.type === "select"
    ? select.config.columns.map((column) => column.source)
    : [];
  const columnAliases = select?.type === "select"
    ? Object.fromEntries(select.config.columns.filter((column) => column.alias).map((column) => [column.source, column.alias ?? ""]))
    : {};
  const castType = cast?.type === "cast" && isPipelineCastType(cast.config.columns[0]?.dataType)
    ? cast.config.columns[0].dataType
    : "String";

  return {
    ...EMPTY_FIELDS,
    name: pipeline.name,
    description: pipeline.description ?? "",
    sourceDatabase: source?.type === "source" ? source.config.database : "",
    sourceTable: source?.type === "source" ? source.config.table : "",
    filterColumn,
    filterOperator,
    filterValue,
    selectedColumns,
    columnAliases,
    castColumn: cast?.type === "cast" ? cast.config.columns[0]?.column ?? "" : "",
    castType,
    destinationMode: destination?.type === "destination" && destination.config.createIfMissing ? "new" : "existing",
    destinationDatabase: destination?.type === "destination" ? destination.config.database : "",
    destinationTable: destination?.type === "destination" ? destination.config.table : "",
    writeMode: destination?.type === "destination" ? destination.config.writeMode : "append",
  };
}

function baseClickHouseType(type: string): string {
  let current = type.trim();
  for (;;) {
    const wrapper = current.match(/^(?:Nullable|LowCardinality)\((.+)\)$/);
    if (!wrapper) return current;
    current = wrapper[1].trim();
  }
}

export function literalTypeForColumn(type: string): PipelineCastType {
  const base = baseClickHouseType(type);
  const name = base.match(/^([A-Za-z0-9]+)/)?.[1] ?? "String";
  if (isPipelineCastType(name)) return name;
  if (name.startsWith("Decimal")) return "Float64";
  return "String";
}

export function literalInputType(type: string): "text" | "number" | "date" | "datetime-local" | "boolean" {
  const literalType = literalTypeForColumn(type);
  if (literalType === "Bool") return "boolean";
  if (literalType === "Date" || literalType === "Date32") return "date";
  if (literalType === "DateTime" || literalType === "DateTime64") return "datetime-local";
  if (/^(?:U?Int|Float)/.test(literalType)) return "number";
  return "text";
}

export function literalExpression(rawValue: string, columnType: string): Extract<PipelineExpression, { kind: "literal" }> {
  const dataType = literalTypeForColumn(columnType);
  if (dataType === "Bool") {
    return { kind: "literal", value: rawValue === "true", dataType };
  }
  if (/^Float/.test(dataType)) {
    return { kind: "literal", value: Number(rawValue), dataType };
  }
  const value = dataType === "DateTime" || dataType === "DateTime64"
    ? rawValue.replace("T", " ")
    : rawValue;
  return { kind: "literal", value, dataType };
}

export function projectedColumns(fields: DesignerFields, sourceColumns: ColumnInfo[]): ColumnInfo[] {
  if (fields.selectedColumns.length === 0) return sourceColumns;
  return fields.selectedColumns.flatMap((source) => {
    const column = sourceColumns.find((candidate) => candidate.name === source);
    if (!column) return [];
    const alias = fields.columnAliases[source]?.trim();
    return [{ ...column, name: alias || source }];
  });
}

export function buildDefinition(fields: DesignerFields, sourceColumns: ColumnInfo[]): PipelineDefinition {
  const nodes: PipelineNode[] = [];
  const edges: PipelineDefinition["edges"] = [];
  const add = (node: PipelineNode): void => {
    const previous = nodes[nodes.length - 1];
    nodes.push(node);
    if (previous) edges.push({ id: `edge_${edges.length + 1}`, from: previous.id, to: node.id, input: "main" });
  };

  add({ id: "source_main", type: "source", position: { x: 0, y: 80 }, config: { database: fields.sourceDatabase, table: fields.sourceTable } });
  if (fields.filterColumn && fields.filterValue.trim()) {
    const column = sourceColumns.find((candidate) => candidate.name === fields.filterColumn);
    add({
      id: "filter_main",
      type: "filter",
      position: { x: nodes.length * 240, y: 80 },
      config: {
        expression: {
          kind: "binary",
          operator: fields.filterOperator,
          left: { kind: "column", name: fields.filterColumn },
          right: literalExpression(fields.filterValue, column?.type ?? "String"),
        },
      },
    });
  }
  if (fields.selectedColumns.length > 0) {
    add({
      id: "select_main",
      type: "select",
      position: { x: nodes.length * 240, y: 80 },
      config: {
        columns: fields.selectedColumns.map((source) => {
          const alias = fields.columnAliases[source]?.trim();
          return alias ? { source, alias } : { source };
        }),
      },
    });
  }
  if (fields.castColumn) {
    add({ id: "cast_main", type: "cast", position: { x: nodes.length * 240, y: 80 }, config: { columns: [{ column: fields.castColumn, dataType: fields.castType }] } });
  }
  add({
    id: "destination_main",
    type: "destination",
    position: { x: nodes.length * 240, y: 80 },
    config: {
      database: fields.destinationDatabase,
      table: fields.destinationTable.trim(),
      writeMode: fields.writeMode,
      createIfMissing: fields.destinationMode === "new",
    },
  });
  return { schemaVersion: 1, nodes, edges };
}

function validIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
}

interface DestinationOptions {
  databases: string[];
  tables: string[];
}

export function validateGuidedFields(
  fields: DesignerFields,
  sourceColumns: ColumnInfo[],
  destinationOptions: DestinationOptions,
): string | null {
  if (!fields.name.trim()) return "Pipeline name is required";
  if (!fields.sourceDatabase || !fields.sourceTable) return "Choose a source database and table";
  if (sourceColumns.length === 0) return "The selected source table has no available columns";
  const sourceNames = new Set(sourceColumns.map((column) => column.name));
  if (fields.filterColumn && !sourceNames.has(fields.filterColumn)) return "Choose a valid filter column";
  if (fields.filterColumn && !fields.filterValue.trim()) return "Enter a filter value";
  if (fields.filterColumn) {
    const column = sourceColumns.find((candidate) => candidate.name === fields.filterColumn);
    if (column && literalInputType(column.type) === "number" && !Number.isFinite(Number(fields.filterValue))) {
      return "Enter a valid numeric filter value";
    }
  }
  if (fields.selectedColumns.some((column) => !sourceNames.has(column))) return "Choose only columns from the selected source table";
  for (const source of fields.selectedColumns) {
    const alias = fields.columnAliases[source]?.trim();
    if (alias && !validIdentifier(alias)) return `Alias for ${source} must be a valid ClickHouse identifier`;
  }
  const projected = projectedColumns(fields, sourceColumns);
  const outputNames = new Set(projected.map((column) => column.name));
  if (outputNames.size !== projected.length) return "Output column names must be unique";
  if (fields.castColumn && !outputNames.has(fields.castColumn)) return "Choose a valid cast column";
  if (!fields.destinationDatabase || !destinationOptions.databases.includes(fields.destinationDatabase)) {
    return "Choose a valid destination database";
  }
  if (!fields.destinationTable.trim()) {
    return fields.destinationMode === "new" ? "Enter a name for the new destination table" : "Choose a destination table";
  }
  if (fields.destinationMode === "new" && !validIdentifier(fields.destinationTable.trim())) {
    return "New table name must start with a letter or underscore and contain only letters, numbers, and underscores";
  }
  if (fields.destinationMode === "existing" && !destinationOptions.tables.includes(fields.destinationTable)) {
    return "Choose a valid existing destination table";
  }
  if (fields.destinationMode === "new" && fields.writeMode !== "append") {
    return "New destination tables currently support append mode";
  }
  return null;
}
