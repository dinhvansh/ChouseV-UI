import type { PipelineDefinition, PipelineDiagnostic, PipelineColumn } from "./definition";

export type PipelineVersionStatus = "DRAFT" | "VALIDATED" | "TESTED" | "DEPLOYED" | "ARCHIVED";

export interface VisualPipelineRow {
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

export interface VisualPipelineVersionRow {
  id: string;
  pipelineId: string;
  versionNumber: number;
  schemaVersion: number;
  definition: PipelineDefinition;
  definitionHash: string;
  compilerVersion: string | null;
  generatedSql: string | null;
  outputSchema: PipelineColumn[] | null;
  lineage: unknown[] | null;
  diagnostics: PipelineDiagnostic[] | null;
  status: PipelineVersionStatus;
  createdBy: string | null;
  createdAt: number;
  validatedAt: number | null;
  testedAt: number | null;
}

export interface VisualPipelineDetail extends VisualPipelineRow {
  draft: VisualPipelineVersionRow | null;
}

export interface CreateVisualPipelineInput {
  name: string;
  description: string | null;
  connectionId: string;
  definition: PipelineDefinition;
  createdBy: string | null;
}

export interface ValidatedVersionUpdate {
  definitionHash: string;
  compilerVersion: string;
  generatedSql: string;
  outputSchema: PipelineColumn[];
  lineage: unknown[];
  diagnostics: PipelineDiagnostic[];
}

export type PipelineTriggerType = "manual" | "schedule" | "webhook" | "incremental_mv" | "refreshable_mv";
export type PipelineConcurrencyPolicy = "do_not_overlap" | "queue_one" | "allow_parallel";
export type PipelineDeploymentStatus = "ACTIVE" | "RETIRED" | "FAILED";

export interface PipelineArtifact {
  compilerVersion: string;
  definitionHash: string;
  sql: string;
  runtimeSql: string;
  parameters: Array<{ name: string; type: string; value: string | number | boolean | null }>;
  outputColumns: PipelineColumn[];
  lineage: unknown[];
  destination: { database: string; table: string; writeMode: "append" | "replace" | "upsert" };
}

export interface VisualPipelineDeploymentRow {
  id: string;
  pipelineId: string;
  versionId: string;
  connectionId: string;
  triggerType: PipelineTriggerType;
  triggerConfig: Record<string, unknown> | null;
  artifact: PipelineArtifact;
  artifactChecksum: string;
  runtimeJobId: string | null;
  nativeObjectName: string | null;
  nativeObjectUuid: string | null;
  hasWebhookSecret: boolean;
  status: PipelineDeploymentStatus;
  deployedBy: string | null;
  deployedAt: number;
  retiredBy: string | null;
  retiredAt: number | null;
}

export interface CreateDeploymentInput {
  pipelineId: string;
  versionId: string;
  connectionId: string;
  triggerType: PipelineTriggerType;
  triggerConfig: Record<string, unknown> | null;
  artifact: PipelineArtifact;
  artifactChecksum: string;
  runtimeJobId: string | null;
  nativeObjectName: string | null;
  nativeObjectUuid: string | null;
  webhookSecretEncrypted: string | null;
  deployedBy: string | null;
}

export interface VisualPipelineRunRow {
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
}

export type PipelineMetadataEntityType = "pipeline" | "table" | "column";

export interface PipelineBusinessMetadataRow {
  id: string;
  pipelineId: string;
  entityType: PipelineMetadataEntityType;
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

export interface UpsertPipelineBusinessMetadataInput {
  pipelineId: string;
  entityType: PipelineMetadataEntityType;
  entityKey: string;
  description: string | null;
  businessOwner: string | null;
  dataOwner: string | null;
  sensitivity: string | null;
  sourceSystem: string | null;
  refreshFrequency: string | null;
  businessDefinition: string | null;
}

export interface VisualPipelineNativeRunRow {
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
}
