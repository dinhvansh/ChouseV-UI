import { api } from "./client";

export type PipelineCastType =
  | "String" | "Bool"
  | "Int8" | "Int16" | "Int32" | "Int64"
  | "UInt8" | "UInt16" | "UInt32" | "UInt64"
  | "Float32" | "Float64"
  | "Date" | "Date32" | "DateTime" | "DateTime64" | "UUID";

export type PipelineExpression =
  | { kind: "column"; name: string }
  | { kind: "literal"; value: string | number | boolean | null; dataType?: PipelineCastType }
  | {
      kind: "binary";
      operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "and" | "or" | "add" | "subtract" | "multiply" | "divide";
      left: PipelineExpression;
      right: PipelineExpression;
    };

export interface PipelinePosition {
  x: number;
  y: number;
}

export type PipelineNode =
  | { id: string; type: "source"; position: PipelinePosition; config: { database: string; table: string } }
  | { id: string; type: "filter"; position: PipelinePosition; config: { expression: PipelineExpression } }
  | { id: string; type: "select"; position: PipelinePosition; config: { columns: Array<{ source: string; alias?: string }> } }
  | { id: string; type: "cast"; position: PipelinePosition; config: { columns: Array<{ column: string; dataType: PipelineCastType }> } }
  | { id: string; type: "calculated"; position: PipelinePosition; config: { columns: Array<{ name: string; dataType: PipelineCastType; expression: PipelineExpression }> } }
  | { id: string; type: "join"; position: PipelinePosition; config: { joinType: "inner" | "left" | "right" | "full"; conditions: Array<{ left: string; right: string }>; rightColumns: Array<{ source: string; alias?: string }> } }
  | { id: string; type: "union"; position: PipelinePosition; config: { mode: "all" | "distinct" } }
  | { id: string; type: "deduplicate"; position: PipelinePosition; config: { keys: string[]; orderBy: PipelineSortColumn[] } }
  | { id: string; type: "aggregate"; position: PipelinePosition; config: { groupBy: string[]; aggregates: Array<{ function: "count" | "sum" | "avg" | "min" | "max" | "uniq" | "uniqExact"; source?: string; alias: string }> } }
  | { id: string; type: "sort"; position: PipelinePosition; config: { columns: PipelineSortColumn[] } }
  | { id: string; type: "window"; position: PipelinePosition; config: { columns: Array<{ function: "row_number" | "rank" | "dense_rank" | "sum" | "avg" | "min" | "max"; source?: string; alias: string; partitionBy: string[]; orderBy: PipelineSortColumn[] }> } }
  | { id: string; type: "destination"; position: PipelinePosition; config: { database: string; table: string; writeMode: "append" | "replace" | "upsert" } };

export interface PipelineSortColumn {
  column: string;
  direction: "asc" | "desc";
}

export interface PipelineDefinition {
  schemaVersion: 1;
  nodes: PipelineNode[];
  edges: Array<{ id: string; from: string; to: string; input: "main" | "left" | "right" }>;
}

export interface PipelineDiagnostic {
  code: string;
  severity: "error" | "warning";
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface VisualPipelineVersion {
  id: string;
  pipelineId: string;
  versionNumber: number;
  schemaVersion: number;
  definition: PipelineDefinition;
  definitionHash: string;
  compilerVersion: string | null;
  generatedSql: string | null;
  outputSchema: Array<{ name: string; type: string }> | null;
  lineage: unknown[] | null;
  diagnostics: PipelineDiagnostic[] | null;
  status: "DRAFT" | "VALIDATED" | "TESTED" | "DEPLOYED" | "ARCHIVED";
  createdBy: string | null;
  createdAt: number;
  validatedAt: number | null;
  testedAt: number | null;
}

export interface VisualPipeline {
  id: string;
  name: string;
  description: string | null;
  connectionId: string;
  currentDraftVersionId: string | null;
  activeDeploymentId: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface VisualPipelineDetail extends VisualPipeline {
  draft: VisualPipelineVersion | null;
}

export interface CompiledPipeline {
  compilerVersion: string;
  sql: string;
  parameters: Array<{ name: string; type: string; value: string | number | boolean | null }>;
  outputColumns: Array<{ name: string; type: string }>;
  destination: { database: string; table: string; writeMode: "append" | "replace" | "upsert" };
  diagnostics: PipelineDiagnostic[];
}

export interface PipelineSampleResult {
  version: VisualPipelineVersion;
  columns: Array<{ name: string; type: string }>;
  rows: Array<Record<string, unknown>>;
  limit: number;
  truncated: boolean;
}

export type PipelineTriggerType = "manual" | "schedule" | "webhook" | "incremental_mv" | "refreshable_mv";
export type PipelineConcurrencyPolicy = "do_not_overlap" | "queue_one" | "allow_parallel";

export interface PipelineDeployment {
  id: string;
  pipelineId: string;
  versionId: string;
  connectionId: string;
  triggerType: PipelineTriggerType;
  triggerConfig: Record<string, unknown> | null;
  artifact: CompiledPipeline & { runtimeSql: string; definitionHash: string; lineage: unknown[] };
  artifactChecksum: string;
  runtimeJobId: string | null;
  nativeObjectName: string | null;
  nativeObjectUuid: string | null;
  hasWebhookSecret: boolean;
  status: "ACTIVE" | "RETIRED" | "FAILED";
  deployedBy: string | null;
  deployedAt: number;
  retiredBy: string | null;
  retiredAt: number | null;
}

export interface DeployPipelineInput {
  versionId: string;
  triggerType: PipelineTriggerType;
  concurrencyPolicy: PipelineConcurrencyPolicy;
  frequency?: "daily" | "weekly" | "monthly" | "cron";
  hour?: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  cronExpr?: string;
  timezone?: string;
  timeoutSecs?: number;
  maxAttempts?: number;
  retentionDays?: number;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  versionId: string;
  deploymentId: string | null;
  actorId: string | null;
  triggerType: string;
  triggerPayload: Record<string, unknown> | null;
  externalEventId: string | null;
  generatedSql: string;
  status: string;
  rowCount: number | null;
  writtenRows: number | null;
  result: unknown;
  durationMs: number | null;
  errorMessage: string | null;
  startedAt: number;
  finishedAt: number | null;
  historySource?: "control_plane";
}

export interface PipelineNativeRun {
  id: string;
  deploymentId: string;
  connectionId: string;
  viewUuid: string;
  initialQueryId: string;
  eventTimeMs: number;
  status: string;
  durationMs: number | null;
  readRows: number | null;
  writtenRows: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  observedAt: number;
  historySource?: "clickhouse_query_views_log";
}

export interface PipelineBusinessMetadata {
  id: string;
  pipelineId: string;
  entityType: "pipeline" | "table" | "column";
  entityKey: string;
  description: string | null;
  businessOwner: string | null;
  dataOwner: string | null;
  sensitivity: string | null;
  sourceSystem: string | null;
  refreshFrequency: string | null;
  businessDefinition: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PipelineSchemaMapping {
  outputColumns: Array<{ name: string; type: string }>;
  destinationColumns: Array<{ name: string; type: string }>;
  mapping: Array<{
    source: { name: string; type: string };
    destination: { name: string; type: string } | null;
    status: "matched" | "missing" | "type_mismatch";
    suggestedCast: string | null;
  }>;
}

export async function listPipelines(): Promise<VisualPipeline[]> {
  const response = await api.get<{ pipelines: VisualPipeline[] }>("/pipelines");
  return response.pipelines;
}

export function getPipeline(id: string): Promise<VisualPipelineDetail> {
  return api.get<VisualPipelineDetail>(`/pipelines/${id}`);
}

export function createPipeline(input: {
  name: string;
  description?: string | null;
  connectionId: string;
  definition: PipelineDefinition;
}): Promise<VisualPipelineDetail> {
  return api.post<VisualPipelineDetail>("/pipelines", input);
}

export function updatePipelineDraft(
  id: string,
  input: { name?: string; description?: string | null; definition: PipelineDefinition },
): Promise<VisualPipelineDetail> {
  return api.patch<VisualPipelineDetail>(`/pipelines/${id}/draft`, input);
}

export function createNextPipelineDraft(id: string): Promise<VisualPipelineDetail> {
  return api.post<VisualPipelineDetail>(`/pipelines/${id}/draft`);
}

export function validatePipeline(id: string): Promise<{ version: VisualPipelineVersion; compiled: CompiledPipeline }> {
  return api.post<{ version: VisualPipelineVersion; compiled: CompiledPipeline }>(`/pipelines/${id}/validate`);
}

export function testPipelineSample(id: string, limit = 100): Promise<PipelineSampleResult> {
  return api.post<PipelineSampleResult>(`/pipelines/${id}/test`, { limit });
}

export async function listPipelineVersions(id: string): Promise<VisualPipelineVersion[]> {
  const response = await api.get<{ versions: VisualPipelineVersion[] }>(`/pipelines/${id}/versions`);
  return response.versions;
}

export async function archivePipeline(id: string): Promise<void> {
  await api.delete<{ archived: boolean }>(`/pipelines/${id}`);
}

export async function listPipelineDeployments(id: string): Promise<PipelineDeployment[]> {
  const response = await api.get<{ deployments: PipelineDeployment[] }>(`/pipelines/${id}/deployments`);
  return response.deployments;
}

export function deployPipeline(id: string, input: DeployPipelineInput): Promise<{ deployment: PipelineDeployment; webhookSecret: string | null; warnings: string[] }> {
  return api.post(`/pipelines/${id}/deploy`, input);
}

export function rollbackPipeline(id: string, deploymentId: string): Promise<{ deployment: PipelineDeployment; webhookSecret: string | null; warnings: string[] }> {
  return api.post(`/pipelines/${id}/rollback`, { deploymentId });
}

export function runPipeline(id: string): Promise<{ queued: boolean; run: PipelineRun | null }> {
  return api.post(`/pipelines/${id}/run`);
}

export async function retirePipeline(id: string): Promise<boolean> {
  const response = await api.post<{ retired: boolean }>(`/pipelines/${id}/retire`);
  return response.retired;
}

export async function listPipelineRuns(id: string): Promise<{ runs: PipelineRun[]; nativeRuns: PipelineNativeRun[] }> {
  return api.get(`/pipelines/${id}/runs`);
}

export async function listPipelineMetadata(id: string): Promise<PipelineBusinessMetadata[]> {
  const response = await api.get<{ metadata: PipelineBusinessMetadata[] }>(`/pipelines/${id}/metadata`);
  return response.metadata;
}

export function savePipelineMetadata(
  id: string,
  input: Omit<PipelineBusinessMetadata, "id" | "pipelineId" | "createdAt" | "updatedAt">,
): Promise<PipelineBusinessMetadata> {
  return api.put(`/pipelines/${id}/metadata`, input);
}

export async function deletePipelineMetadata(id: string, metadataId: string): Promise<void> {
  await api.delete(`/pipelines/${id}/metadata/${metadataId}`);
}

export function getPipelineSchemaMapping(id: string): Promise<PipelineSchemaMapping> {
  return api.get(`/pipelines/${id}/schema-mapping`);
}
