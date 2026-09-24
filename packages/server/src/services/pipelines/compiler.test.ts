import { describe, expect, it } from "bun:test";

import { compilePipeline, PipelineCompileError, renderPipelineRuntimeSql } from "./compiler";
import { validatePipelineDefinition } from "./definition";

const definition = {
  schemaVersion: 1,
  nodes: [
    {
      id: "source_part_tran",
      type: "source",
      position: { x: 0, y: 0 },
      config: { database: "raw", table: "PartTran" },
    },
    {
      id: "filter_company",
      type: "filter",
      position: { x: 200, y: 0 },
      config: {
        expression: {
          kind: "binary",
          operator: "eq",
          left: { kind: "column", name: "Company" },
          right: { kind: "literal", value: "VN", dataType: "String" },
        },
      },
    },
    {
      id: "select_columns",
      type: "select",
      position: { x: 400, y: 0 },
      config: {
        columns: [
          { source: "Company" },
          { source: "PartNum", alias: "PartNumber" },
          { source: "SysDate" },
        ],
      },
    },
    {
      id: "cast_date",
      type: "cast",
      position: { x: 600, y: 0 },
      config: { columns: [{ column: "SysDate", dataType: "Date" }] },
    },
    {
      id: "destination_ods",
      type: "destination",
      position: { x: 800, y: 0 },
      config: { database: "ods", table: "PartTran", writeMode: "append" },
    },
  ],
  edges: [
    { id: "edge_1", from: "source_part_tran", to: "filter_company", input: "main" },
    { id: "edge_2", from: "filter_company", to: "select_columns", input: "main" },
    { id: "edge_3", from: "select_columns", to: "cast_date", input: "main" },
    { id: "edge_4", from: "cast_date", to: "destination_ods", input: "main" },
  ],
};

const sourceSchemas = {
  source_part_tran: [
    { name: "Company", type: "String" },
    { name: "PartNum", type: "String" },
    { name: "SysDate", type: "DateTime" },
  ],
};

describe("compilePipeline", () => {
  it("compiles the vertical slice into deterministic parameterized ClickHouse SQL", () => {
    const compiled = compilePipeline(definition, { sourceSchemas });

    expect(compiled.sql).toBe("WITH\n" +
      "  `vp_source_part_tran` AS (\n" +
      "  SELECT\n" +
      "    `Company`,\n" +
      "    `PartNum`,\n" +
      "    `SysDate`\n" +
      "  FROM `raw`.`PartTran`\n" +
      "),\n" +
      "  `vp_filter_company` AS (\n" +
      "  SELECT\n" +
      "    `Company`,\n" +
      "    `PartNum`,\n" +
      "    `SysDate`\n" +
      "  FROM `vp_source_part_tran`\n" +
      "  WHERE (`Company` = {vp_1:String})\n" +
      "),\n" +
      "  `vp_select_columns` AS (\n" +
      "  SELECT\n" +
      "    `Company`,\n" +
      "    `PartNum` AS `PartNumber`,\n" +
      "    `SysDate`\n" +
      "  FROM `vp_filter_company`\n" +
      "),\n" +
      "  `vp_cast_date` AS (\n" +
      "  SELECT\n" +
      "    `Company`,\n" +
      "    `PartNumber`,\n" +
      "    CAST(`SysDate`, 'Date') AS `SysDate`\n" +
      "  FROM `vp_select_columns`\n" +
      ")\n" +
      "SELECT\n" +
      "    `Company`,\n" +
      "    `PartNumber`,\n" +
      "    `SysDate`\n" +
      "FROM `vp_cast_date`");
    expect(compiled.parameters).toEqual([{ name: "vp_1", type: "String", value: "VN" }]);
    expect(renderPipelineRuntimeSql(compiled)).toContain("WHERE (`Company` = CAST('VN', 'String'))");
    expect(compiled.outputColumns).toEqual([
      { name: "Company", type: "String" },
      { name: "PartNumber", type: "String" },
      { name: "SysDate", type: "Date" },
    ]);
    expect(compiled.destination).toEqual({ database: "ods", table: "PartTran", writeMode: "append" });
    expect(compiled.lineage).toContainEqual({
      outputColumn: "PartNumber",
      sources: [{ nodeId: "source_part_tran", column: "PartNum" }],
    });
  });

  it("rejects cycles before compilation", () => {
    const cyclic = structuredClone(definition);
    cyclic.edges.push({ id: "edge_cycle", from: "cast_date", to: "filter_company", input: "main" });
    const result = validatePipelineDefinition(cyclic);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "graph.cycle")).toBe(true);
  });

  it("rejects unknown filter columns", () => {
    const invalid = structuredClone(definition);
    const filter = invalid.nodes.find((node) => node.id === "filter_company");
    if (!filter || filter.type !== "filter") throw new Error("Test fixture is missing filter_company");
    filter.config.expression.left = { kind: "column", name: "DoesNotExist" };

    expect(() => compilePipeline(invalid, { sourceSchemas })).toThrow(PipelineCompileError);
    try {
      compilePipeline(invalid, { sourceSchemas });
    } catch (error) {
      if (!(error instanceof PipelineCompileError)) throw error;
      expect(error.diagnostics[0]?.code).toBe("expression.unknown_column");
    }
  });

  it("rejects duplicate output aliases", () => {
    const invalid = structuredClone(definition);
    const select = invalid.nodes.find((node) => node.id === "select_columns");
    if (!select || select.type !== "select") throw new Error("Test fixture is missing select_columns");
    select.config.columns[1].alias = "Company";

    expect(() => compilePipeline(invalid, { sourceSchemas })).toThrow("Duplicate output column: Company");
  });

  it("rejects arbitrary fields instead of accepting raw SQL escape hatches", () => {
    const invalid = structuredClone(definition);
    const filter = invalid.nodes.find((node) => node.id === "filter_company");
    if (!filter || filter.type !== "filter") throw new Error("Test fixture is missing filter_company");
    Object.assign(filter.config, { rawSql: "1 = 1; DROP TABLE raw.PartTran" });

    const result = validatePipelineDefinition(invalid);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("definition.invalid");
  });

  it("renders allow-listed function expressions for advanced transforms", () => {
    const transformed = structuredClone(definition);
    const calculated = {
      id: "normalized",
      type: "calculated" as const,
      position: { x: 600, y: 0 },
      config: {
        columns: [{
          name: "NormalizedCompany",
          dataType: "String" as const,
          expression: {
            kind: "function" as const,
            function: "upper" as const,
            args: [{ kind: "function" as const, function: "trim" as const, args: [{ kind: "column" as const, name: "Company" }] }],
          },
        }],
      },
    };
    const destination = transformed.nodes.find((node) => node.type === "destination");
    if (!destination) throw new Error("Test fixture is missing destination");
    transformed.nodes.splice(transformed.nodes.length - 1, 0, calculated);
    transformed.edges.splice(transformed.edges.length - 1, 0, { id: "edge_function", from: "cast_date", to: "normalized", input: "main" });
    transformed.edges[transformed.edges.length - 1] = { id: "edge_destination", from: "normalized", to: destination.id, input: "main" };
    const compiled = compilePipeline(transformed, { sourceSchemas });
    expect(compiled.sql).toContain("CAST(upper(trim(`Company`)), 'String') AS `NormalizedCompany`");
  });

  it("requires a source schema", () => {
    expect(() => compilePipeline(definition, { sourceSchemas: {} })).toThrow("Source schema is required");
  });

  it("requires an explicit type for null literals", () => {
    const invalid = structuredClone(definition);
    const filter = invalid.nodes.find((node) => node.id === "filter_company");
    if (!filter || filter.type !== "filter") throw new Error("Test fixture is missing filter_company");
    filter.config.expression.right = { kind: "literal", value: null };

    expect(() => compilePipeline(invalid, { sourceSchemas })).toThrow("Null literals require an explicit dataType");
  });

  it("compiles multi-source joins and advanced V1 transforms with lineage", () => {
    const advanced = {
      schemaVersion: 1,
      nodes: [
        { id: "orders", type: "source", position: { x: 0, y: 0 }, config: { database: "raw", table: "Orders" } },
        { id: "parts", type: "source", position: { x: 0, y: 200 }, config: { database: "raw", table: "Part" } },
        {
          id: "join_part",
          type: "join",
          position: { x: 200, y: 100 },
          config: { joinType: "left", conditions: [{ left: "PartNum", right: "PartNum" }], rightColumns: [{ source: "Description", alias: "PartDescription" }] },
        },
        {
          id: "amount",
          type: "calculated",
          position: { x: 400, y: 100 },
          config: { columns: [{ name: "Amount", dataType: "Float64", expression: { kind: "binary", operator: "multiply", left: { kind: "column", name: "Qty" }, right: { kind: "literal", value: 2, dataType: "Float64" } } }] },
        },
        { id: "latest", type: "deduplicate", position: { x: 600, y: 100 }, config: { keys: ["SysRowID"], orderBy: [{ column: "SysDate", direction: "desc" }] } },
        {
          id: "totals",
          type: "aggregate",
          position: { x: 800, y: 100 },
          config: { groupBy: ["Company", "PartNum", "PartDescription"], aggregates: [{ function: "sum", source: "Amount", alias: "TotalAmount" }, { function: "count", alias: "Rows" }] },
        },
        {
          id: "ranked",
          type: "window",
          position: { x: 1000, y: 100 },
          config: { columns: [{ function: "row_number", alias: "Rank", partitionBy: ["Company"], orderBy: [{ column: "TotalAmount", direction: "desc" }] }] },
        },
        { id: "sorted", type: "sort", position: { x: 1200, y: 100 }, config: { columns: [{ column: "Rank", direction: "asc" }] } },
        { id: "destination", type: "destination", position: { x: 1400, y: 100 }, config: { database: "mart", table: "PartTotals", writeMode: "replace" } },
      ],
      edges: [
        { id: "e1", from: "orders", to: "join_part", input: "left" },
        { id: "e2", from: "parts", to: "join_part", input: "right" },
        { id: "e3", from: "join_part", to: "amount", input: "main" },
        { id: "e4", from: "amount", to: "latest", input: "main" },
        { id: "e5", from: "latest", to: "totals", input: "main" },
        { id: "e6", from: "totals", to: "ranked", input: "main" },
        { id: "e7", from: "ranked", to: "sorted", input: "main" },
        { id: "e8", from: "sorted", to: "destination", input: "main" },
      ],
    };
    const compiled = compilePipeline(advanced, {
      sourceSchemas: {
        orders: [
          { name: "Company", type: "String" }, { name: "PartNum", type: "String" },
          { name: "Qty", type: "Float64" }, { name: "SysDate", type: "DateTime" }, { name: "SysRowID", type: "UUID" },
        ],
        parts: [{ name: "PartNum", type: "String" }, { name: "Description", type: "String" }],
      },
    });

    expect(compiled.sql).toContain("LEFT JOIN `vp_parts` AS r ON l.`PartNum` = r.`PartNum`");
    expect(compiled.sql).toContain("LIMIT 1 BY `SysRowID`");
    expect(compiled.sql).toContain("sum(`Amount`) AS `TotalAmount`");
    expect(compiled.sql).toContain("row_number() OVER (PARTITION BY `Company` ORDER BY `TotalAmount` DESC) AS `Rank`");
    expect(compiled.destination).toEqual({ database: "mart", table: "PartTotals", writeMode: "replace" });
    expect(compiled.outputColumns.at(-1)).toEqual({ name: "Rank", type: "UInt64" });
    expect(compiled.lineage.find((entry) => entry.outputColumn === "TotalAmount")?.sources).toContainEqual({ nodeId: "orders", column: "Qty" });
  });

  it("compiles compatible unions and rejects schema mismatches", () => {
    const union = {
      schemaVersion: 1,
      nodes: [
        { id: "a", type: "source", position: { x: 0, y: 0 }, config: { database: "raw", table: "A" } },
        { id: "b", type: "source", position: { x: 0, y: 200 }, config: { database: "raw", table: "B" } },
        { id: "combined", type: "union", position: { x: 200, y: 100 }, config: { mode: "all" } },
        { id: "destination", type: "destination", position: { x: 400, y: 100 }, config: { database: "ods", table: "Combined", writeMode: "append" } },
      ],
      edges: [
        { id: "e1", from: "a", to: "combined", input: "main" },
        { id: "e2", from: "b", to: "combined", input: "main" },
        { id: "e3", from: "combined", to: "destination", input: "main" },
      ],
    };
    const schemas = { a: [{ name: "id", type: "UInt64" }], b: [{ name: "id", type: "UInt64" }] };
    expect(compilePipeline(union, { sourceSchemas: schemas }).sql).toContain("UNION ALL");
    expect(() => compilePipeline(union, { sourceSchemas: { ...schemas, b: [{ name: "id", type: "String" }] } })).toThrow(PipelineCompileError);
  });

  it("requires explicit left and right join ports", () => {
    const invalidJoin = {
      schemaVersion: 1,
      nodes: [
        { id: "a", type: "source", position: { x: 0, y: 0 }, config: { database: "raw", table: "A" } },
        { id: "b", type: "source", position: { x: 0, y: 100 }, config: { database: "raw", table: "B" } },
        { id: "joined", type: "join", position: { x: 200, y: 50 }, config: { joinType: "inner", conditions: [{ left: "id", right: "id" }], rightColumns: [] } },
        { id: "destination", type: "destination", position: { x: 400, y: 50 }, config: { database: "ods", table: "AB", writeMode: "append" } },
      ],
      edges: [
        { id: "e1", from: "a", to: "joined", input: "main" },
        { id: "e2", from: "b", to: "joined", input: "main" },
        { id: "e3", from: "joined", to: "destination", input: "main" },
      ],
    };
    const result = validatePipelineDefinition(invalidJoin);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "graph.join_inputs")).toBe(true);
  });
});
