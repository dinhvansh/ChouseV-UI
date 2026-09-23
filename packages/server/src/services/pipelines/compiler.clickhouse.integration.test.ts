import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createClient, type ClickHouseClient } from "@clickhouse/client";

import { compilePipeline, renderPipelineRuntimeSql } from "./compiler";
import type { PipelineDefinition } from "./definition";

const clickHouseUrl = process.env.CLICKHOUSE_INTEGRATION_URL;
const describeClickHouse = clickHouseUrl ? describe : describe.skip;
const suffix = `vp_it_${Date.now().toString(36)}`;
const rawDb = `${suffix}_raw`;
const odsDb = `${suffix}_ods`;

describeClickHouse("pipeline compiler · ClickHouse integration", () => {
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = createClient({
      url: clickHouseUrl!,
      username: process.env.CLICKHOUSE_INTEGRATION_USER ?? "default",
      password: process.env.CLICKHOUSE_INTEGRATION_PASSWORD ?? "",
    });
    await client.command({ query: `CREATE DATABASE \`${rawDb}\`` });
    await client.command({ query: `CREATE DATABASE \`${odsDb}\`` });
  });

  afterAll(async () => {
    if (!client) return;
    await client.command({ query: `DROP DATABASE IF EXISTS \`${rawDb}\` SYNC` });
    await client.command({ query: `DROP DATABASE IF EXISTS \`${odsDb}\` SYNC` });
    await client.close();
  });

  it("executes an advanced multi-source V1 DAG", async () => {
    await client.command({ query: `CREATE TABLE \`${rawDb}\`.orders (Company String, PartNum String, Qty Float64, SysDate DateTime, SysRowID UUID) ENGINE = MergeTree ORDER BY (Company, PartNum)` });
    await client.command({ query: `CREATE TABLE \`${rawDb}\`.parts (PartNum String, Description String) ENGINE = MergeTree ORDER BY PartNum` });
    await client.insert({ table: `${rawDb}.orders`, values: [
      { Company: "VN", PartNum: "P1", Qty: 2, SysDate: "2026-01-01 00:00:00", SysRowID: "11111111-1111-4111-8111-111111111111" },
      { Company: "VN", PartNum: "P1", Qty: 3, SysDate: "2026-01-02 00:00:00", SysRowID: "11111111-1111-4111-8111-111111111111" },
    ], format: "JSONEachRow" });
    await client.insert({ table: `${rawDb}.parts`, values: [{ PartNum: "P1", Description: "Part one" }], format: "JSONEachRow" });
    const definition: PipelineDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: "orders", type: "source", position: { x: 0, y: 0 }, config: { database: rawDb, table: "orders" } },
        { id: "parts", type: "source", position: { x: 0, y: 100 }, config: { database: rawDb, table: "parts" } },
        { id: "joined", type: "join", position: { x: 200, y: 50 }, config: { joinType: "left", conditions: [{ left: "PartNum", right: "PartNum" }], rightColumns: [{ source: "Description", alias: "PartDescription" }] } },
        { id: "amount", type: "calculated", position: { x: 400, y: 50 }, config: { columns: [{ name: "Amount", dataType: "Float64", expression: { kind: "binary", operator: "multiply", left: { kind: "column", name: "Qty" }, right: { kind: "literal", value: 2, dataType: "Float64" } } }] } },
        { id: "latest", type: "deduplicate", position: { x: 600, y: 50 }, config: { keys: ["SysRowID"], orderBy: [{ column: "SysDate", direction: "desc" }] } },
        { id: "totals", type: "aggregate", position: { x: 800, y: 50 }, config: { groupBy: ["Company", "PartNum", "PartDescription"], aggregates: [{ function: "sum", source: "Amount", alias: "TotalAmount" }] } },
        { id: "ranked", type: "window", position: { x: 1000, y: 50 }, config: { columns: [{ function: "row_number", alias: "Rank", partitionBy: ["Company"], orderBy: [{ column: "TotalAmount", direction: "desc" }] }] } },
        { id: "sorted", type: "sort", position: { x: 1200, y: 50 }, config: { columns: [{ column: "Rank", direction: "asc" }] } },
        { id: "destination", type: "destination", position: { x: 1400, y: 50 }, config: { database: odsDb, table: "part_totals", writeMode: "replace" } },
      ],
      edges: [
        { id: "e1", from: "orders", to: "joined", input: "left" }, { id: "e2", from: "parts", to: "joined", input: "right" },
        { id: "e3", from: "joined", to: "amount", input: "main" }, { id: "e4", from: "amount", to: "latest", input: "main" },
        { id: "e5", from: "latest", to: "totals", input: "main" }, { id: "e6", from: "totals", to: "ranked", input: "main" },
        { id: "e7", from: "ranked", to: "sorted", input: "main" }, { id: "e8", from: "sorted", to: "destination", input: "main" },
      ],
    };
    const compiled = compilePipeline(definition, { sourceSchemas: {
      orders: [{ name: "Company", type: "String" }, { name: "PartNum", type: "String" }, { name: "Qty", type: "Float64" }, { name: "SysDate", type: "DateTime" }, { name: "SysRowID", type: "UUID" }],
      parts: [{ name: "PartNum", type: "String" }, { name: "Description", type: "String" }],
    } });
    const result = await client.query({ query: renderPipelineRuntimeSql(compiled), format: "JSONEachRow" });
    const rows = await result.json<Array<{ Company: string; PartNum: string; PartDescription: string; TotalAmount: number; Rank: number }>>();
    expect(rows).toEqual([{ Company: "VN", PartNum: "P1", PartDescription: "Part one", TotalAmount: 6, Rank: 1 }]);
  });

  it("deploys and fires compiler output as an incremental materialized view", async () => {
    await client.command({ query: `CREATE TABLE \`${rawDb}\`.events (id UInt64, company String) ENGINE = MergeTree ORDER BY id` });
    await client.command({ query: `CREATE TABLE \`${odsDb}\`.events (id UInt64, company String) ENGINE = MergeTree ORDER BY id` });
    const definition: PipelineDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: "source", type: "source", position: { x: 0, y: 0 }, config: { database: rawDb, table: "events" } },
        { id: "filter", type: "filter", position: { x: 200, y: 0 }, config: { expression: { kind: "binary", operator: "eq", left: { kind: "column", name: "company" }, right: { kind: "literal", value: "VN", dataType: "String" } } } },
        { id: "destination", type: "destination", position: { x: 400, y: 0 }, config: { database: odsDb, table: "events", writeMode: "append" } },
      ],
      edges: [{ id: "e1", from: "source", to: "filter", input: "main" }, { id: "e2", from: "filter", to: "destination", input: "main" }],
    };
    const compiled = compilePipeline(definition, { sourceSchemas: { source: [{ name: "id", type: "UInt64" }, { name: "company", type: "String" }] } });
    await client.command({ query: `CREATE MATERIALIZED VIEW \`${odsDb}\`.events_mv TO \`${odsDb}\`.events AS\n${renderPipelineRuntimeSql(compiled)}` });
    await client.insert({ table: `${rawDb}.events`, values: [{ id: 1, company: "VN" }, { id: 2, company: "US" }], format: "JSONEachRow" });
    const result = await client.query({ query: `SELECT id, company FROM \`${odsDb}\`.events ORDER BY id`, format: "JSONEachRow" });
    expect(await result.json()).toEqual([{ id: 1, company: "VN" }]);
  });
});
