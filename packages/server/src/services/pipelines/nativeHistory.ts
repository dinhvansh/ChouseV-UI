import { clientForConnection } from "../scheduledQueries/chClient";
import type { VisualPipelineDeploymentRow } from "./types";
import * as store from "./store";

interface QueryViewLogRow {
  view_uuid: string;
  initial_query_id: string;
  event_time_ms: number | string;
  type: string;
  duration_ms?: number | string;
  read_rows?: number | string;
  written_rows?: number | string;
  exception_code?: number | string;
  exception?: string;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reconciles incremental materialized-view executions from ClickHouse's native
 * query_views_log into the control-plane history. The unique key makes this
 * safe to call whenever the history screen is opened.
 */
export async function syncNativeRunHistory(deployment: VisualPipelineDeploymentRow): Promise<number> {
  if (!deployment.nativeObjectUuid) return 0;
  const client = await clientForConnection(
    deployment.connectionId,
    JSON.stringify({ source: "visual_pipeline_native_history", pipeline_id: deployment.pipelineId }),
  );
  const result = await client.query({
    query: `SELECT
      toString(view_uuid) AS view_uuid,
      initial_query_id,
      toUnixTimestamp64Milli(event_time_microseconds) AS event_time_ms,
      type,
      view_duration_ms AS duration_ms,
      read_rows,
      written_rows,
      exception_code,
      exception
    FROM system.query_views_log
    WHERE view_uuid = {viewUuid:UUID}
    ORDER BY event_time_microseconds DESC
    LIMIT 200`,
    format: "JSON",
    query_params: { viewUuid: deployment.nativeObjectUuid },
    clickhouse_settings: { readonly: "1", max_execution_time: 10, max_result_rows: "200" },
  });
  const json = await result.json() as { data?: QueryViewLogRow[] };
  let created = 0;
  for (const row of json.data ?? []) {
    const success = row.type === "QueryFinish" || row.type === "ViewProcessingSuccess";
    if (await store.recordNativeRun({
      deploymentId: deployment.id,
      connectionId: deployment.connectionId,
      viewUuid: row.view_uuid,
      initialQueryId: row.initial_query_id,
      eventTimeMs: Number(row.event_time_ms),
      status: success ? "success" : "failed",
      durationMs: nullableNumber(row.duration_ms),
      readRows: nullableNumber(row.read_rows),
      writtenRows: nullableNumber(row.written_rows),
      errorCode: success ? null : String(row.exception_code ?? ""),
      errorMessage: success ? null : row.exception ?? "ClickHouse materialized view execution failed",
    })) created += 1;
  }
  return created;
}
