import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { getDatabase, getDatabaseType, type PostgresDb, type SqliteDb } from "../../rbac/db";
import { validatePipelineDefinition } from "./definition";
import { pipelineDefinitionHash } from "./canonical";
import type {
  CreateVisualPipelineInput,
  ValidatedVersionUpdate,
  VisualPipelineDetail,
  VisualPipelineRow,
  VisualPipelineVersionRow,
  PipelineVersionStatus,
  CreateDeploymentInput,
  PipelineDeploymentStatus,
  PipelineTriggerType,
  PipelineBusinessMetadataRow,
  UpsertPipelineBusinessMetadataInput,
  VisualPipelineDeploymentRow,
  VisualPipelineNativeRunRow,
  VisualPipelineRunRow,
} from "./types";
import type { PipelineDefinition, PipelineDiagnostic, PipelineColumn } from "./definition";

async function all(statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  const db = getDatabase();
  if (getDatabaseType() === "sqlite") {
    return (db as SqliteDb).all(statement) as Array<Record<string, unknown>>;
  }
  const result = await (db as PostgresDb).execute(statement);
  const response = result as unknown as { rows?: Array<Record<string, unknown>> };
  return Array.isArray(result) ? result as unknown as Array<Record<string, unknown>> : response.rows ?? [];
}

async function run(statement: ReturnType<typeof sql>): Promise<void> {
  const db = getDatabase();
  if (getDatabaseType() === "sqlite") {
    (db as SqliteDb).run(statement);
    return;
  }
  await (db as PostgresDb).execute(statement);
}

async function execChanges(statement: ReturnType<typeof sql>): Promise<number> {
  const db = getDatabase();
  if (getDatabaseType() === "sqlite") {
    const result = (db as SqliteDb).run(statement) as unknown as { changes?: number };
    return Number(result?.changes ?? 0);
  }
  const result = await (db as PostgresDb).execute(statement);
  const response = result as unknown as { count?: number; rowCount?: number };
  return Number(response.count ?? response.rowCount ?? 0);
}

function stringOrNull(value: unknown): string | null {
  return value == null ? null : String(value);
}

function numberOrNull(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function isVersionStatus(value: string): value is PipelineVersionStatus {
  return ["DRAFT", "VALIDATED", "TESTED", "DEPLOYED", "ARCHIVED"].includes(value);
}

function isTriggerType(value: string): value is PipelineTriggerType {
  return ["manual", "schedule", "webhook", "incremental_mv", "refreshable_mv"].includes(value);
}

function isDeploymentStatus(value: string): value is PipelineDeploymentStatus {
  return ["ACTIVE", "RETIRED", "FAILED"].includes(value);
}

function toPipelineRow(row: Record<string, unknown>): VisualPipelineRow {
  return {
    id: String(row.id),
    name: String(row.name),
    description: stringOrNull(row.description),
    connectionId: String(row.connection_id),
    currentDraftVersionId: stringOrNull(row.current_draft_version_id),
    activeDeploymentId: stringOrNull(row.active_deployment_id),
    createdBy: stringOrNull(row.created_by),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    archivedAt: numberOrNull(row.archived_at),
  };
}

function toVersionRow(row: Record<string, unknown>): VisualPipelineVersionRow {
  const parsedDefinition = parseJson<unknown>(row.definition_json);
  const validated = validatePipelineDefinition(parsedDefinition);
  if (!validated.definition) throw new Error(`Stored pipeline version ${String(row.id)} has an invalid definition`);
  const status = String(row.status);
  return {
    id: String(row.id),
    pipelineId: String(row.pipeline_id),
    versionNumber: Number(row.version_number),
    schemaVersion: Number(row.schema_version),
    definition: validated.definition,
    definitionHash: String(row.definition_hash),
    compilerVersion: stringOrNull(row.compiler_version),
    generatedSql: stringOrNull(row.generated_sql),
    outputSchema: parseJson<PipelineColumn[]>(row.output_schema_json),
    lineage: parseJson<unknown[]>(row.lineage_json),
    diagnostics: parseJson<PipelineDiagnostic[]>(row.diagnostics_json),
    status: isVersionStatus(status) ? status : "DRAFT",
    createdBy: stringOrNull(row.created_by),
    createdAt: Number(row.created_at ?? 0),
    validatedAt: numberOrNull(row.validated_at),
    testedAt: numberOrNull(row.tested_at),
  };
}

function toDeploymentRow(row: Record<string, unknown>): VisualPipelineDeploymentRow {
  const triggerType = String(row.trigger_type);
  const status = String(row.status);
  const artifact = parseJson<VisualPipelineDeploymentRow["artifact"]>(row.artifact_json);
  if (!artifact) throw new Error(`Stored pipeline deployment ${String(row.id)} has no artifact`);
  return {
    id: String(row.id),
    pipelineId: String(row.pipeline_id),
    versionId: String(row.version_id),
    connectionId: String(row.connection_id),
    triggerType: isTriggerType(triggerType) ? triggerType : "manual",
    triggerConfig: parseJson<Record<string, unknown>>(row.trigger_config_json),
    artifact,
    artifactChecksum: String(row.artifact_checksum),
    runtimeJobId: stringOrNull(row.runtime_job_id),
    nativeObjectName: stringOrNull(row.native_object_name),
    nativeObjectUuid: stringOrNull(row.native_object_uuid),
    hasWebhookSecret: Boolean(stringOrNull(row.webhook_secret_encrypted)),
    status: isDeploymentStatus(status) ? status : "FAILED",
    deployedBy: stringOrNull(row.deployed_by),
    deployedAt: Number(row.deployed_at ?? 0),
    retiredBy: stringOrNull(row.retired_by),
    retiredAt: numberOrNull(row.retired_at),
  };
}

export async function listPipelines(ownerId?: string | null): Promise<VisualPipelineRow[]> {
  const rows = ownerId
    ? await all(sql`SELECT * FROM visual_pipelines WHERE archived_at IS NULL AND created_by = ${ownerId} ORDER BY updated_at DESC`)
    : await all(sql`SELECT * FROM visual_pipelines WHERE archived_at IS NULL ORDER BY updated_at DESC`);
  return rows.map(toPipelineRow);
}

export async function getPipeline(id: string): Promise<VisualPipelineRow | null> {
  const rows = await all(sql`SELECT * FROM visual_pipelines WHERE id = ${id} AND archived_at IS NULL LIMIT 1`);
  return rows[0] ? toPipelineRow(rows[0]) : null;
}

export async function getVersion(id: string): Promise<VisualPipelineVersionRow | null> {
  const rows = await all(sql`SELECT * FROM visual_pipeline_versions WHERE id = ${id} LIMIT 1`);
  return rows[0] ? toVersionRow(rows[0]) : null;
}

export async function getPipelineDetail(id: string): Promise<VisualPipelineDetail | null> {
  const pipeline = await getPipeline(id);
  if (!pipeline) return null;
  const draft = pipeline.currentDraftVersionId ? await getVersion(pipeline.currentDraftVersionId) : null;
  return { ...pipeline, draft };
}

export async function listVersions(pipelineId: string): Promise<VisualPipelineVersionRow[]> {
  const rows = await all(sql`SELECT * FROM visual_pipeline_versions WHERE pipeline_id = ${pipelineId} ORDER BY version_number DESC`);
  return rows.map(toVersionRow);
}

export async function getDeployment(id: string): Promise<VisualPipelineDeploymentRow | null> {
  const rows = await all(sql`SELECT * FROM visual_pipeline_deployments WHERE id = ${id} LIMIT 1`);
  return rows[0] ? toDeploymentRow(rows[0]) : null;
}

export async function getDeploymentWebhookSecret(id: string): Promise<string | null> {
  const rows = await all(sql`SELECT webhook_secret_encrypted FROM visual_pipeline_deployments WHERE id = ${id} LIMIT 1`);
  return rows[0] ? stringOrNull(rows[0].webhook_secret_encrypted) : null;
}

export async function getActiveDeployment(pipelineId: string): Promise<VisualPipelineDeploymentRow | null> {
  const rows = await all(sql`
    SELECT * FROM visual_pipeline_deployments
    WHERE pipeline_id = ${pipelineId} AND status = 'ACTIVE'
    ORDER BY deployed_at DESC LIMIT 1
  `);
  return rows[0] ? toDeploymentRow(rows[0]) : null;
}

export async function getDeploymentByRuntimeJobId(runtimeJobId: string): Promise<VisualPipelineDeploymentRow | null> {
  const rows = await all(sql`SELECT * FROM visual_pipeline_deployments WHERE runtime_job_id = ${runtimeJobId} ORDER BY deployed_at DESC LIMIT 1`);
  return rows[0] ? toDeploymentRow(rows[0]) : null;
}

export async function listDeployments(pipelineId: string): Promise<VisualPipelineDeploymentRow[]> {
  const rows = await all(sql`SELECT * FROM visual_pipeline_deployments WHERE pipeline_id = ${pipelineId} ORDER BY deployed_at DESC`);
  return rows.map(toDeploymentRow);
}

export async function activateDeployment(input: CreateDeploymentInput): Promise<VisualPipelineDeploymentRow> {
  const id = randomUUID();
  const now = Date.now();
  await run(sql`
    INSERT INTO visual_pipeline_deployments
      (id, pipeline_id, version_id, connection_id, trigger_type, trigger_config_json, artifact_json,
       artifact_checksum, runtime_job_id, native_object_name, native_object_uuid, webhook_secret_encrypted,
       status, deployed_by, deployed_at)
    VALUES
      (${id}, ${input.pipelineId}, ${input.versionId}, ${input.connectionId}, ${input.triggerType},
       ${input.triggerConfig ? JSON.stringify(input.triggerConfig) : null}, ${JSON.stringify(input.artifact)},
       ${input.artifactChecksum}, ${input.runtimeJobId}, ${input.nativeObjectName}, ${input.nativeObjectUuid},
       ${input.webhookSecretEncrypted}, 'ACTIVE', ${input.deployedBy}, ${now})
  `);
  await run(sql`
    UPDATE visual_pipeline_deployments
    SET status = 'RETIRED', retired_by = ${input.deployedBy}, retired_at = ${now}
    WHERE pipeline_id = ${input.pipelineId} AND id <> ${id} AND status = 'ACTIVE'
  `);
  await run(sql`
    UPDATE visual_pipelines SET active_deployment_id = ${id}, updated_at = ${now}
    WHERE id = ${input.pipelineId} AND archived_at IS NULL
  `);
  await run(sql`UPDATE visual_pipeline_versions SET status = 'DEPLOYED' WHERE id = ${input.versionId}`);
  const deployment = await getDeployment(id);
  if (!deployment) throw new Error("Failed to read the active pipeline deployment");
  return deployment;
}

export async function retireDeployment(id: string, actorId: string | null): Promise<void> {
  const deployment = await getDeployment(id);
  if (!deployment || deployment.status !== "ACTIVE") return;
  const now = Date.now();
  await run(sql`UPDATE visual_pipeline_deployments SET status = 'RETIRED', retired_by = ${actorId}, retired_at = ${now} WHERE id = ${id} AND status = 'ACTIVE'`);
  await run(sql`UPDATE visual_pipelines SET active_deployment_id = NULL, updated_at = ${now} WHERE id = ${deployment.pipelineId} AND active_deployment_id = ${id}`);
}

export async function createPipeline(input: CreateVisualPipelineInput): Promise<VisualPipelineDetail> {
  const pipelineId = randomUUID();
  const versionId = randomUUID();
  const now = Date.now();
  const definitionJson = JSON.stringify(input.definition);
  const definitionHash = pipelineDefinitionHash(input.definition);
  await run(sql`
    INSERT INTO visual_pipelines
      (id, name, description, connection_id, current_draft_version_id, created_by, created_at, updated_at)
    VALUES
      (${pipelineId}, ${input.name}, ${input.description}, ${input.connectionId}, ${versionId}, ${input.createdBy}, ${now}, ${now})
  `);
  try {
    await run(sql`
      INSERT INTO visual_pipeline_versions
        (id, pipeline_id, version_number, schema_version, definition_json, definition_hash, status, created_by, created_at)
      VALUES
        (${versionId}, ${pipelineId}, 1, ${input.definition.schemaVersion}, ${definitionJson}, ${definitionHash}, 'DRAFT', ${input.createdBy}, ${now})
    `);
  } catch (error) {
    await run(sql`DELETE FROM visual_pipelines WHERE id = ${pipelineId}`);
    throw error;
  }
  const created = await getPipelineDetail(pipelineId);
  if (!created) throw new Error("Failed to read the created pipeline");
  return created;
}

export async function updateDraft(
  pipelineId: string,
  versionId: string,
  definition: PipelineDefinition,
  name?: string,
  description?: string | null,
): Promise<VisualPipelineDetail | null> {
  const version = await getVersion(versionId);
  if (!version || version.pipelineId !== pipelineId || version.status !== "DRAFT") return null;
  const now = Date.now();
  await run(sql`
    UPDATE visual_pipeline_versions
    SET definition_json = ${JSON.stringify(definition)},
        definition_hash = ${pipelineDefinitionHash(definition)},
        compiler_version = NULL,
        generated_sql = NULL,
        output_schema_json = NULL,
        lineage_json = NULL,
        diagnostics_json = NULL,
        validated_at = NULL,
        tested_at = NULL
    WHERE id = ${versionId} AND pipeline_id = ${pipelineId} AND status = 'DRAFT'
  `);
  if (name !== undefined || description !== undefined) {
    const pipeline = await getPipeline(pipelineId);
    if (!pipeline) return null;
    await run(sql`
      UPDATE visual_pipelines
      SET name = ${name ?? pipeline.name}, description = ${description === undefined ? pipeline.description : description}, updated_at = ${now}
      WHERE id = ${pipelineId}
    `);
  } else {
    await run(sql`UPDATE visual_pipelines SET updated_at = ${now} WHERE id = ${pipelineId}`);
  }
  return getPipelineDetail(pipelineId);
}

export async function createNextDraft(pipelineId: string, createdBy: string | null): Promise<VisualPipelineDetail | null> {
  const pipeline = await getPipelineDetail(pipelineId);
  if (!pipeline?.draft || pipeline.draft.status === "DRAFT") return null;
  const versions = await listVersions(pipelineId);
  const versionNumber = Math.max(0, ...versions.map((version) => version.versionNumber)) + 1;
  const versionId = randomUUID();
  const now = Date.now();
  await run(sql`
    INSERT INTO visual_pipeline_versions
      (id, pipeline_id, version_number, schema_version, definition_json, definition_hash, status, created_by, created_at)
    VALUES
      (${versionId}, ${pipelineId}, ${versionNumber}, ${pipeline.draft.definition.schemaVersion},
       ${JSON.stringify(pipeline.draft.definition)}, ${pipelineDefinitionHash(pipeline.draft.definition)}, 'DRAFT', ${createdBy}, ${now})
  `);
  await run(sql`
    UPDATE visual_pipelines
    SET current_draft_version_id = ${versionId}, updated_at = ${now}
    WHERE id = ${pipelineId} AND current_draft_version_id = ${pipeline.draft.id} AND archived_at IS NULL
  `);
  const updated = await getPipelineDetail(pipelineId);
  if (updated?.currentDraftVersionId === versionId) return updated;
  await run(sql`DELETE FROM visual_pipeline_versions WHERE id = ${versionId}`);
  return null;
}

export async function markVersionValidated(versionId: string, update: ValidatedVersionUpdate): Promise<VisualPipelineVersionRow | null> {
  const now = Date.now();
  await run(sql`
    UPDATE visual_pipeline_versions
    SET definition_hash = ${update.definitionHash},
        compiler_version = ${update.compilerVersion},
        generated_sql = ${update.generatedSql},
        output_schema_json = ${JSON.stringify(update.outputSchema)},
        lineage_json = ${JSON.stringify(update.lineage)},
        diagnostics_json = ${JSON.stringify(update.diagnostics)},
        status = 'VALIDATED',
        validated_at = ${now}
    WHERE id = ${versionId} AND status = 'DRAFT'
  `);
  return getVersion(versionId);
}

export async function markVersionTested(versionId: string): Promise<VisualPipelineVersionRow | null> {
  const now = Date.now();
  await run(sql`
    UPDATE visual_pipeline_versions
    SET status = 'TESTED', tested_at = ${now}
    WHERE id = ${versionId} AND status IN ('VALIDATED', 'TESTED')
  `);
  return getVersion(versionId);
}

export async function archivePipeline(id: string): Promise<void> {
  const now = Date.now();
  await run(sql`UPDATE visual_pipelines SET archived_at = ${now}, updated_at = ${now} WHERE id = ${id} AND archived_at IS NULL`);
}

export async function linkRun(input: {
  runId: string;
  pipelineId: string;
  versionId: string;
  deploymentId: string | null;
  actorId: string | null;
  triggerType: string;
  triggerPayload: Record<string, unknown> | null;
  externalEventId: string | null;
  generatedSql: string;
}): Promise<void> {
  await run(sql`
    INSERT INTO visual_pipeline_run_links
      (run_id, pipeline_id, version_id, deployment_id, actor_id, trigger_type,
       trigger_payload_json, external_event_id, generated_sql, created_at)
    VALUES
      (${input.runId}, ${input.pipelineId}, ${input.versionId}, ${input.deploymentId}, ${input.actorId},
       ${input.triggerType}, ${input.triggerPayload ? JSON.stringify(input.triggerPayload) : null},
       ${input.externalEventId}, ${input.generatedSql}, ${Date.now()})
    ON CONFLICT (run_id) DO NOTHING
  `);
}

export async function listPipelineRuns(pipelineId: string, limit = 50, offset = 0): Promise<VisualPipelineRunRow[]> {
  const rows = await all(sql`
    SELECT l.*, r.status, r.row_count, r.written_rows, r.result_json, r.duration_ms,
           r.message, r.started_at, r.finished_at
    FROM visual_pipeline_run_links l
    JOIN scheduled_query_runs r ON r.id = l.run_id
    WHERE l.pipeline_id = ${pipelineId}
    ORDER BY r.started_at DESC LIMIT ${limit} OFFSET ${offset}
  `);
  return rows.map((row) => ({
    id: String(row.run_id),
    pipelineId: String(row.pipeline_id),
    versionId: String(row.version_id),
    deploymentId: stringOrNull(row.deployment_id),
    actorId: stringOrNull(row.actor_id),
    triggerType: String(row.trigger_type),
    triggerPayload: parseJson<Record<string, unknown>>(row.trigger_payload_json),
    externalEventId: stringOrNull(row.external_event_id),
    generatedSql: String(row.generated_sql),
    status: String(row.status),
    rowCount: numberOrNull(row.row_count),
    writtenRows: numberOrNull(row.written_rows),
    result: parseJson<unknown>(row.result_json),
    durationMs: numberOrNull(row.duration_ms),
    errorMessage: stringOrNull(row.message),
    startedAt: Number(row.started_at ?? 0),
    finishedAt: numberOrNull(row.finished_at),
  }));
}

export async function acquireRunLease(
  pipelineId: string,
  token: string,
  expiresAt: number,
  queuedPayload: Record<string, unknown> | null = null,
): Promise<"acquired" | "queued" | "busy"> {
  const now = Date.now();
  await run(sql`DELETE FROM visual_pipeline_run_leases WHERE pipeline_id = ${pipelineId} AND expires_at <= ${now}`);
  const changes = await execChanges(sql`
    INSERT INTO visual_pipeline_run_leases (pipeline_id, token, expires_at, queued_payload_json, updated_at)
    VALUES (${pipelineId}, ${token}, ${expiresAt}, NULL, ${now})
    ON CONFLICT (pipeline_id) DO NOTHING
  `);
  if (changes === 1) return "acquired";
  if (!queuedPayload) return "busy";
  const queued = await execChanges(sql`
    UPDATE visual_pipeline_run_leases
    SET queued_payload_json = ${JSON.stringify(queuedPayload)}, updated_at = ${now}
    WHERE pipeline_id = ${pipelineId} AND queued_payload_json IS NULL
  `);
  return queued === 1 ? "queued" : "busy";
}

export async function releaseRunLease(pipelineId: string, token: string): Promise<Record<string, unknown> | null> {
  const rows = await all(sql`SELECT queued_payload_json FROM visual_pipeline_run_leases WHERE pipeline_id = ${pipelineId} AND token = ${token} LIMIT 1`);
  const queued = rows[0] ? parseJson<Record<string, unknown>>(rows[0].queued_payload_json) : null;
  await run(sql`DELETE FROM visual_pipeline_run_leases WHERE pipeline_id = ${pipelineId} AND token = ${token}`);
  return queued;
}

export async function recordExternalEvent(input: {
  pipelineId: string;
  source: string;
  externalEventId: string;
  payloadHash: string;
  payload: Record<string, unknown>;
  signatureValid: boolean;
}): Promise<{ id: string; created: boolean; status: string }> {
  const id = randomUUID();
  const changes = await execChanges(sql`
    INSERT INTO visual_pipeline_external_events
      (id, pipeline_id, source, external_event_id, payload_hash, payload_json, signature_valid, received_at, status)
    VALUES
      (${id}, ${input.pipelineId}, ${input.source}, ${input.externalEventId}, ${input.payloadHash},
       ${JSON.stringify(input.payload)}, ${input.signatureValid ? 1 : 0}, ${Date.now()}, 'RECEIVED')
    ON CONFLICT (pipeline_id, source, external_event_id) DO NOTHING
  `);
  if (changes === 1) return { id, created: true, status: "RECEIVED" };
  const rows = await all(sql`
    SELECT id, status FROM visual_pipeline_external_events
    WHERE pipeline_id = ${input.pipelineId} AND source = ${input.source} AND external_event_id = ${input.externalEventId}
    LIMIT 1
  `);
  return { id: String(rows[0]?.id ?? ""), created: false, status: String(rows[0]?.status ?? "") };
}

export async function claimIgnoredExternalEvent(
  id: string,
  payloadHash: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const changes = await execChanges(sql`
    UPDATE visual_pipeline_external_events
    SET payload_hash = ${payloadHash}, payload_json = ${JSON.stringify(payload)},
        status = 'RECEIVED', processed_at = NULL, received_at = ${Date.now()}
    WHERE id = ${id} AND status = 'IGNORED'
  `);
  return changes === 1;
}

export async function updateExternalEventStatus(id: string, status: string): Promise<void> {
  await run(sql`UPDATE visual_pipeline_external_events SET status = ${status}, processed_at = ${Date.now()} WHERE id = ${id}`);
}

function toBusinessMetadataRow(row: Record<string, unknown>): PipelineBusinessMetadataRow {
  const entityType = String(row.entity_type);
  if (!["pipeline", "table", "column"].includes(entityType)) {
    throw new Error(`Stored pipeline metadata ${String(row.id)} has an invalid entity type`);
  }
  return {
    id: String(row.id),
    pipelineId: String(row.pipeline_id),
    entityType: entityType as PipelineBusinessMetadataRow["entityType"],
    entityKey: String(row.entity_key),
    description: stringOrNull(row.description),
    businessOwner: stringOrNull(row.business_owner),
    dataOwner: stringOrNull(row.data_owner),
    sensitivity: stringOrNull(row.sensitivity),
    sourceSystem: stringOrNull(row.source_system),
    refreshFrequency: stringOrNull(row.refresh_frequency),
    businessDefinition: stringOrNull(row.business_definition),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

export async function listBusinessMetadata(pipelineId: string): Promise<PipelineBusinessMetadataRow[]> {
  const rows = await all(sql`
    SELECT * FROM visual_pipeline_business_metadata
    WHERE pipeline_id = ${pipelineId}
    ORDER BY entity_type, entity_key
  `);
  return rows.map(toBusinessMetadataRow);
}

export async function upsertBusinessMetadata(input: UpsertPipelineBusinessMetadataInput): Promise<PipelineBusinessMetadataRow> {
  const existing = await all(sql`
    SELECT id, created_at FROM visual_pipeline_business_metadata
    WHERE pipeline_id = ${input.pipelineId} AND entity_type = ${input.entityType} AND entity_key = ${input.entityKey}
    LIMIT 1
  `);
  const id = existing[0] ? String(existing[0].id) : randomUUID();
  const now = Date.now();
  await run(sql`
    INSERT INTO visual_pipeline_business_metadata
      (id, pipeline_id, entity_type, entity_key, description, business_owner, data_owner,
       sensitivity, source_system, refresh_frequency, business_definition, created_at, updated_at)
    VALUES
      (${id}, ${input.pipelineId}, ${input.entityType}, ${input.entityKey}, ${input.description},
       ${input.businessOwner}, ${input.dataOwner}, ${input.sensitivity}, ${input.sourceSystem},
       ${input.refreshFrequency}, ${input.businessDefinition}, ${existing[0] ? Number(existing[0].created_at) : now}, ${now})
    ON CONFLICT (pipeline_id, entity_type, entity_key) DO UPDATE SET
      description = excluded.description,
      business_owner = excluded.business_owner,
      data_owner = excluded.data_owner,
      sensitivity = excluded.sensitivity,
      source_system = excluded.source_system,
      refresh_frequency = excluded.refresh_frequency,
      business_definition = excluded.business_definition,
      updated_at = excluded.updated_at
  `);
  const rows = await all(sql`SELECT * FROM visual_pipeline_business_metadata WHERE id = ${id} LIMIT 1`);
  if (!rows[0]) throw new Error("Failed to read the saved pipeline metadata");
  return toBusinessMetadataRow(rows[0]);
}

export async function deleteBusinessMetadata(pipelineId: string, metadataId: string): Promise<boolean> {
  return (await execChanges(sql`
    DELETE FROM visual_pipeline_business_metadata WHERE id = ${metadataId} AND pipeline_id = ${pipelineId}
  `)) > 0;
}

function toNativeRunRow(row: Record<string, unknown>): VisualPipelineNativeRunRow {
  return {
    id: String(row.id),
    deploymentId: String(row.deployment_id),
    connectionId: String(row.connection_id),
    viewUuid: String(row.view_uuid),
    initialQueryId: String(row.initial_query_id),
    eventTimeMs: Number(row.event_time_ms ?? 0),
    status: String(row.status),
    durationMs: numberOrNull(row.duration_ms),
    readRows: numberOrNull(row.read_rows),
    writtenRows: numberOrNull(row.written_rows),
    errorCode: stringOrNull(row.error_code),
    errorMessage: stringOrNull(row.error_message),
    observedAt: Number(row.observed_at ?? 0),
  };
}

export async function recordNativeRun(input: Omit<VisualPipelineNativeRunRow, "id" | "observedAt">): Promise<boolean> {
  const changes = await execChanges(sql`
    INSERT INTO visual_pipeline_native_runs
      (id, deployment_id, connection_id, view_uuid, initial_query_id, event_time_ms, status,
       duration_ms, read_rows, written_rows, error_code, error_message, observed_at)
    VALUES
      (${randomUUID()}, ${input.deploymentId}, ${input.connectionId}, ${input.viewUuid},
       ${input.initialQueryId}, ${input.eventTimeMs}, ${input.status}, ${input.durationMs},
       ${input.readRows}, ${input.writtenRows}, ${input.errorCode}, ${input.errorMessage}, ${Date.now()})
    ON CONFLICT (connection_id, view_uuid, initial_query_id, event_time_ms) DO NOTHING
  `);
  return changes === 1;
}

export async function listNativeRuns(deploymentId: string, limit = 50): Promise<VisualPipelineNativeRunRow[]> {
  const rows = await all(sql`
    SELECT * FROM visual_pipeline_native_runs
    WHERE deployment_id = ${deploymentId}
    ORDER BY event_time_ms DESC LIMIT ${limit}
  `);
  return rows.map(toNativeRunRow);
}
