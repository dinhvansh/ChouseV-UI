import { describe, expect, it } from "vitest";

import type { ColumnInfo } from "@/api/explorer";
import type { PipelineNode, VisualPipelineDetail } from "@/api/pipelines";
import {
  buildDefinition,
  EMPTY_FIELDS,
  fieldsFromPipeline,
  literalExpression,
  literalInputType,
  projectedColumns,
  validateGuidedFields,
} from "./designerModel";
import type { DesignerFields } from "./designerModel";

const columns: ColumnInfo[] = [
  { name: "order_id", type: "UInt64", default_kind: "", default_expression: "", comment: "" },
  { name: "status", type: "LowCardinality(String)", default_kind: "", default_expression: "", comment: "" },
  { name: "created_at", type: "DateTime64(3)", default_kind: "", default_expression: "", comment: "" },
];

const destinationOptions = {
  databases: ["ods"],
  tables: ["orders_clean"],
};

function completeFields(overrides: Partial<DesignerFields> = {}): DesignerFields {
  return {
    ...EMPTY_FIELDS,
    name: "Orders pipeline",
    sourceDatabase: "raw",
    sourceTable: "orders",
    destinationDatabase: "ods",
    destinationTable: "orders_clean",
    ...overrides,
  };
}

describe("pipeline guided designer model", () => {
  it("builds a typed definition only from selected source metadata", () => {
    const definition = buildDefinition(completeFields({
      filterColumn: "order_id",
      filterOperator: "gte",
      filterValue: "1000",
      selectedColumns: ["order_id", "status"],
      columnAliases: { status: "order_status" },
      castColumn: "order_id",
      castType: "String",
      destinationMode: "new",
    }), columns);

    const filter = definition.nodes.find((node): node is Extract<PipelineNode, { type: "filter" }> => node.type === "filter");
    const select = definition.nodes.find((node): node is Extract<PipelineNode, { type: "select" }> => node.type === "select");
    const destination = definition.nodes.find((node): node is Extract<PipelineNode, { type: "destination" }> => node.type === "destination");

    expect(filter?.config.expression).toEqual({
      kind: "binary",
      operator: "gte",
      left: { kind: "column", name: "order_id" },
      right: { kind: "literal", value: "1000", dataType: "UInt64" },
    });
    expect(select?.config.columns).toEqual([
      { source: "order_id" },
      { source: "status", alias: "order_status" },
    ]);
    expect(destination?.config.createIfMissing).toBe(true);
  });

  it("derives literal controls and values from ClickHouse column types", () => {
    expect(literalInputType("Nullable(Float64)")).toBe("number");
    expect(literalInputType("LowCardinality(String)")).toBe("text");
    expect(literalInputType("DateTime64(3)")).toBe("datetime-local");
    expect(literalExpression("false", "Bool")).toEqual({ kind: "literal", value: false, dataType: "Bool" });
    expect(literalExpression("2026-09-24T10:30", "DateTime")).toEqual({ kind: "literal", value: "2026-09-24 10:30", dataType: "DateTime" });
  });

  it("projects selected aliases and validates new destination names", () => {
    const fields = completeFields({
      selectedColumns: ["status"],
      columnAliases: { status: "state" },
      destinationMode: "new",
      destinationTable: "bad table",
    });
    expect(projectedColumns(fields, columns).map((column) => column.name)).toEqual(["state"]);
    expect(validateGuidedFields(fields, columns, destinationOptions)).toContain("New table name");
    expect(validateGuidedFields({ ...fields, destinationTable: "orders_v2" }, columns, destinationOptions)).toBeNull();
  });

  it("rejects stale destination metadata that is no longer selectable", () => {
    expect(validateGuidedFields(completeFields({ destinationDatabase: "missing" }), columns, destinationOptions))
      .toBe("Choose a valid destination database");
    expect(validateGuidedFields(completeFields({ destinationTable: "missing" }), columns, destinationOptions))
      .toBe("Choose a valid existing destination table");
  });

  it("restores guided fields from a stored definition", () => {
    const definition = buildDefinition(completeFields({
      selectedColumns: ["status"],
      columnAliases: { status: "state" },
      destinationMode: "new",
    }), columns);
    const pipeline = {
      id: "pipeline-1",
      name: "Orders pipeline",
      description: "Test",
      connectionId: "connection-1",
      currentDraftVersionId: "version-1",
      activeDeploymentId: null,
      createdBy: "user-1",
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      draft: {
        id: "version-1",
        pipelineId: "pipeline-1",
        versionNumber: 1,
        schemaVersion: 1,
        definition,
        definitionHash: "hash",
        compilerVersion: null,
        generatedSql: null,
        outputSchema: null,
        lineage: null,
        diagnostics: null,
        status: "DRAFT",
        createdBy: "user-1",
        createdAt: 1,
        validatedAt: null,
        testedAt: null,
      },
    } satisfies VisualPipelineDetail;

    expect(fieldsFromPipeline(pipeline)).toEqual(expect.objectContaining({
      selectedColumns: ["status"],
      columnAliases: { status: "state" },
      destinationMode: "new",
      destinationTable: "orders_clean",
    }));
  });
});
