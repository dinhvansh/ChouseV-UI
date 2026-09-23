# 0015 — Visual ClickHouse Transformation Pipelines

- **Status:** Accepted
- **Date:** 2026-09-23
- **Deciders:** CHouse UI maintainers (approved 2026-09-23)
- **Tags:** dataops, pipelines, clickhouse, materialized-views, rbac, ai, ui

## Context

CHouse UI already provides most of the control-plane primitives needed for a
visual transformation product:

- `DataOps` is a top-level product area with permission-gated feature tabs.
- Scheduled Queries (ADR 0002) owns durable scheduling, row leases, retries,
  crash recovery, materialization, run history, lineage, and write modes.
- Data Health (ADRs 0003 and 0006) demonstrates how another feature can build on
  the Scheduled Queries runtime instead of creating a second scheduler.
- ClickHouse connections, encrypted credentials, data-access policy, audit logs,
  multi-replica metadata storage, and provider-neutral AI already exist.
- React Flow and Dagre are already dependencies. `PipelineView.tsx` proves they
  work in the application, although that component visualizes `EXPLAIN PIPELINE`
  output and is not an editable transformation graph.

The requested feature is a visual SQL DAG which compiles to ClickHouse SQL and
deploys to native ClickHouse capabilities. It must support manual, scheduled,
webhook, refreshable-materialized-view, and incremental-materialized-view
execution without turning CHouse UI into a general-purpose worker engine.

Building a standalone pipeline scheduler, execution table, connection layer, or
AI provider stack would duplicate mature subsystems and introduce conflicting
lease, retry, authorization, and audit semantics. Conversely, storing a visual
definition directly in `scheduled_queries.query` would lose versioning, typed
graph validation, reproducible deployments, and safe AI patches.

Incremental materialized views create a special observability constraint:
ClickHouse executes them synchronously for each inserted block. CHouse UI does
not initiate those executions, and per-block history is only available when the
target ClickHouse instance records `system.query_views_log`. The UI must not
pretend that a control-plane runner can provide authoritative history for native
MV execution.

This decision crosses UI, RBAC, metadata persistence, ClickHouse DDL, scheduler,
webhooks, and AI security boundaries, so an ADR is required before code changes.

## Decision

Add **Visual Pipelines** as a DataOps feature. A pipeline is a versioned, typed
DAG compiled by CHouse UI into a deployment artifact. ClickHouse remains the
data execution engine. Control-plane execution reuses Scheduled Queries; native
MV execution is deployed and observed as a ClickHouse object.

### D1 — Product surface and module boundaries

Add a third DataOps feature at `/dataops/pipelines/:sub?` with these sub-views:

- Overview
- Designer
- Runs
- Versions
- Metadata

The implementation is a feature module, not additions to the existing
`workspace/PipelineView.tsx`. That view remains a read-only rendering of physical
`EXPLAIN PIPELINE` stages. Shared React Flow primitives may be extracted only
where their semantics and styles genuinely match.

Server code lives under:

```text
packages/server/src/routes/pipelines.ts
packages/server/src/services/pipelines/
  types.ts
  definition.ts
  compiler.ts
  diagnostics.ts
  deployment.ts
  runtime.ts
  store.ts
  webhook.ts
  aiContext.ts
```

Frontend code lives under:

```text
src/api/pipelines.ts
src/features/pipelines/
```

The first implementation remains part of the existing modular monolith. No new
microservice, broker, distributed data worker, Python runtime, or plugin runtime
is introduced.

### D2 — Versioned DAG contract

The canonical definition is a graph, not a linear `source + steps` array:

```json
{
  "schemaVersion": 1,
  "nodes": [
    {
      "id": "source_part_tran",
      "type": "source",
      "position": { "x": 80, "y": 120 },
      "config": {
        "database": "raw",
        "table": "PartTran"
      }
    },
    {
      "id": "filter_company",
      "type": "filter",
      "position": { "x": 360, "y": 120 },
      "config": {
        "expression": {
          "kind": "binary",
          "operator": "eq",
          "left": { "kind": "column", "name": "Company" },
          "right": { "kind": "literal", "value": "VN", "dataType": "String" }
        }
      }
    },
    {
      "id": "destination_ods",
      "type": "destination",
      "position": { "x": 640, "y": 120 },
      "config": {
        "database": "ods",
        "table": "PartTran",
        "writeMode": "append"
      }
    }
  ],
  "edges": [
    { "id": "edge_1", "from": "source_part_tran", "to": "filter_company", "input": "main" },
    { "id": "edge_2", "from": "filter_company", "to": "destination_ods", "input": "main" }
  ]
}
```

Requirements:

- Zod v3 validates server definitions; Zod v4 mirrors the public contract on the
  client where runtime validation is needed.
- Each definition has an explicit `schemaVersion` and migration function.
- Node IDs remain stable across edits so diffs and AI patches are deterministic.
- Edges address named input ports; Join and Union never infer inputs from canvas
  position.
- Positions are presentation metadata and do not affect generated SQL or the
  definition hash used for deployment safety.
- Canonical JSON sorts object keys and semantic collections before hashing.
- Validation rejects cycles, disconnected destinations, orphan transforms,
  duplicate IDs, invalid port cardinality, unresolved columns, incompatible
  unions/joins, and multiple destinations in the first release.

V1 node types are Source, Select/Rename, Filter, Cast, Calculated Column, Join,
Union, Deduplicate, Group/Aggregate, Sort, Window, and Destination. The initial
vertical slice implements Source, Filter, Select/Rename, Cast, and Destination.

### D3 — Safe expression and SQL compiler

The compiler is a pure, deterministic pipeline:

```text
definition
  -> structural validation
  -> graph validation
  -> schema/type propagation
  -> logical plan
  -> ClickHouse SQL AST/render model
  -> SQL + output schema + lineage + diagnostics
```

Node configuration does not accept arbitrary SQL fragments by default.
Expressions use a typed model with allowlisted operators and ClickHouse
functions. Identifiers pass through the existing `sqlIdentifier` utilities;
literals become native ClickHouse query parameters when executed. A future
advanced raw-expression mode requires a separate permission and parser-based
validation and is not part of V1.

Compiler output includes:

- generated source `SELECT`;
- parameter schema, never credentials or values that belong in secret storage;
- inferred output columns and ClickHouse types;
- table/column lineage;
- warnings and blocking diagnostics with node IDs;
- compiler version and definition hash.

Golden tests pin definition JSON to generated SQL. Integration tests execute the
SQL against the minimum and target supported ClickHouse versions.

### D4 — Control-plane metadata

Migration `1.53.0` adds normalized pipeline metadata to the existing SQLite or
PostgreSQL RBAC database. Both dialects are implemented and tested through the
mandatory migration harness.

Tables:

1. `visual_pipelines`
   - identity, name, description, connection ID, owner, timestamps, archive time;
   - pointer to the editable draft and active deployment;
   - the connection is fixed after creation because it is an authorization boundary.
2. `visual_pipeline_versions`
   - pipeline ID, monotonically increasing version number, definition schema
     version, canonical definition JSON, definition hash, compiler version,
     generated SQL, inferred schema/lineage/diagnostics JSON, lifecycle status,
     actor and timestamps;
   - a `DRAFT` row may change; once `VALIDATED`, it is immutable.
3. `visual_pipeline_deployments`
   - pipeline/version/connection, trigger type and config, immutable deployment
     artifact/checksum, optional Scheduled Query runtime job ID, native object
     identity, status, deploy/retire actor and timestamps;
   - every deploy and rollback creates a new deployment row.
4. `visual_pipeline_external_events`
   - pipeline, source, external event ID, payload hash, signature result,
     received/processed timestamps and status;
   - unique `(pipeline_id, source, external_event_id)`.
5. `visual_pipeline_business_metadata`
   - entity type/key, description, business/data owner, sensitivity, source
     system, refresh frequency, and business definition.

Control-plane runs use `scheduled_query_runs` and map to the immutable deployment
through `visual_pipeline_deployments.runtime_job_id`. Native MV observations use
`visual_pipeline_native_runs`, keyed by connection, view UUID, initial query ID,
and event timestamp. The public Runs API normalizes both sources and clearly
labels `historySource` as `control_plane` or `clickhouse_query_views_log`.

### D5 — Reuse Scheduled Queries for control-plane execution

Manual, scheduler-backed refresh, and webhook runs use the existing Scheduled
Queries runner, leases, retry rules, result guardrails, materialization code, and
run history. Extend `SqKind` with `visual_pipeline`; do not create a second job
scheduler or run queue.

Each deployment gets a new immutable runtime job. Deploying a newer version
disables the older job rather than mutating it, preserving the version-to-run
relationship. Rollback deploys the saved artifact/checksum; it never recompiles
an old definition with a newer compiler.

The pipeline runtime may call exported Scheduled Query service functions but may
not bypass connection access, data-access policy, or ClickHouse guardrails.

Concurrency policy maps to durable runtime state:

- `do_not_overlap`: reject/mark skipped while the deployment has an active lease;
- `queue_one`: retain at most one coalesced pending request;
- `parallel`: allowed only with a dedicated deploy permission and explicit choice.

The initial vertical slice supports `do_not_overlap`. `queue_one` and `parallel`
ship only after multi-replica and restart tests pass.

### D6 — Trigger semantics

Trigger types have explicit, non-interchangeable semantics:

#### Manual

Calls the Scheduled Queries runner and records a normal control-plane run.

#### Schedule

Uses the existing scheduler. It is the compatibility fallback for deployments
that need a full-dataset refresh and for ClickHouse versions without a supported
Refreshable Materialized View capability.

#### Webhook

Adds `POST /api/pipelines/:id/webhook`. Requests require a per-deployment
secret stored through the existing encrypted-secret mechanism, HMAC-SHA256,
constant-time comparison, a timestamp acceptance window, and a unique external
event ID. Signature and idempotency are committed before the runner is invoked.
Duplicate accepted events return the original outcome and never start a second
run. The payload is size-limited and redacted in logs and AI context.

#### Refreshable Materialized View

The deployment service first queries a capability matrix for the selected
connection. When the target version and topology are supported, it may deploy a
native Refreshable MV artifact. Otherwise the UI explains the fallback and uses
the existing scheduler/materializer. Capability detection is version-gated and
covered by ClickHouse integration tests; it is never inferred from a failed
production DDL attempt.

#### Incremental Materialized View

Always deploys a native ClickHouse Materialized View. The compiler rejects graph
semantics that require a full historical scan. In particular:

- the trigger only sees each newly inserted block;
- changing a joined lookup table does not replay source rows;
- global deduplication and global aggregate claims are blocking diagnostics
  unless the selected destination engine makes the intended semantics explicit;
- the user must choose the destination engine/write strategy; CHouse UI does not
  guess it.

Per-block history is collected from `system.query_views_log` when enabled. If it
is unavailable, the UI shows deployment health and an explicit “native run
history unavailable” state rather than manufacturing success records.

### D7 — Validate, sample, test, and deploy lifecycle

The lifecycle is:

```text
DRAFT -> VALIDATED -> TESTED -> DEPLOYED -> ARCHIVED
```

- `Validate` performs structural, semantic, schema, permission, capability, and
  ClickHouse parse/`EXPLAIN` validation without mutating user data.
- `Test Sample` executes only the generated source `SELECT`, with read-only mode,
  timeout, memory/read-byte/row limits, and a bounded snapshot. Appending
  `LIMIT 1000` alone is not considered a safety boundary.
- `Test Write` is a separate, permission-gated action against an explicitly
  named disposable/staging destination; it is not required for the first slice.
- `Deploy` accepts the exact validated/tested version hash. If the draft changed,
  deployment fails closed and requires re-validation.
- production versions are never edited in place.
- rollback creates a deployment from the previous saved artifact and records a
  full audit event.

### D8 — API and RBAC

API prefix: `/api/pipelines`.

Initial endpoints:

```text
GET    /api/pipelines
POST   /api/pipelines
GET    /api/pipelines/:id
PATCH  /api/pipelines/:id/draft
POST   /api/pipelines/:id/validate
POST   /api/pipelines/:id/test
POST   /api/pipelines/:id/deploy
POST   /api/pipelines/:id/run
POST   /api/pipelines/:id/rollback
GET    /api/pipelines/:id/runs
GET    /api/pipelines/:id/versions
GET    /api/pipelines/:id/schema-mapping
GET    /api/pipelines/:id/metadata
PUT    /api/pipelines/:id/metadata
GET    /api/ai/context/pipelines/:id
POST   /api/pipelines/:id/webhook
```

New permissions:

```text
pipelines:view
pipelines:view_all
pipelines:edit
pipelines:test
pipelines:run
pipelines:deploy
pipelines:delete
pipelines:metadata
pipelines:ai_suggest
```

`deploy` is distinct from `edit` and `run`. AI endpoints never acquire deploy
authority transitively. Routes use `rbacAuthMiddleware`, `requirePermission`,
connection authorization, and data-access checks. Every create/edit/validate/
test/deploy/run/rollback/webhook-secret action is audited.

### D9 — AI-ready but human-controlled

The AI Context API is a server-built allowlisted projection containing:

- pipeline and immutable version metadata;
- redacted source/destination schemas;
- business metadata allowed for the caller;
- generated SQL and diagnostics;
- bounded recent execution summaries and the last error.

It excludes connection strings, credentials, webhook secrets, unrestricted
sample rows, raw trigger payloads, and data the caller cannot access.

AI operations return schema-validated node operations against a base definition
hash, for example `add_node`, `update_node`, `remove_node`, and `connect_nodes`.
They may create a draft suggestion only when the caller has `pipelines:edit`.
They cannot validate, test, deploy, roll back, or modify a deployed version.
Provider, model, prompt-template version, base hash, proposed patch, and the
user's accept/reject decision are audited.

The existing provider abstraction and structured-output helpers are reused.

### D10 — Delivery order

Implementation follows review and acceptance of this ADR:

1. **Compiler slice:** definition schemas, graph validation, Source/Filter/
   Select-Rename/Cast/Destination compiler, golden tests.
2. **Metadata slice:** migration `1.53.0`, dual-dialect tests, store, RBAC and
   audit actions.
3. **Usable vertical slice:** list/designer, schema mapping, SQL preview,
   validate, read-only sample, manual run, run history.
4. **Lifecycle:** immutable versions, deploy artifacts, version diff, rollback.
5. **Full DAG:** Join/Union/Deduplicate/Aggregate/Sort/Window and lineage.
6. **Triggers:** schedule reuse, webhook/idempotency, capability-gated refreshable
   MV, native incremental MV and query-views-log observation.
7. **AI-ready:** business metadata, context API and suggestion workflow.

Each slice is independently reviewable. User-visible slices include changelog
fragments. Any migration change includes `VERSION_CHECKS` and passes SQLite and
PostgreSQL upgrade-path tests.

## Consequences

### Positive

- CHouse UI gains a visual ELT layer without becoming a data worker engine.
- Existing scheduler correctness, ClickHouse materialization, RBAC, connection,
  audit, lineage, and AI abstractions are reused.
- Immutable artifacts make deploy and rollback reproducible.
- A typed DAG and compiler produce actionable node-level diagnostics and safe AI
  patches.
- Trigger-specific semantic validation prevents common incremental MV data bugs.
- The feature remains usable without AI and without native Refreshable MV support.

### Negative

- Scheduled Queries becomes a shared runtime dependency and needs a small public
  service boundary instead of feature-internal assumptions.
- Native MV history cannot be guaranteed when ClickHouse query-view logging is
  disabled or has expired.
- Supporting both SQLite and PostgreSQL makes the metadata migration and lease
  behavior more expensive to test.
- Safe typed expressions initially expose fewer ClickHouse functions than a raw
  SQL editor.
- Deployments spanning a ClickHouse cluster require explicit capability and
  partial-DDL recovery tests.

### Neutral / operational

- Scheduled Queries stays visible as its own feature for users who prefer SQL.
- A visual pipeline deployment may create one internal Scheduled Query job; that
  job is hidden from ordinary Scheduled Queries lists unless an operator asks to
  include internal jobs.
- `system.query_views_log` is an optional observability dependency, not an
  execution dependency.

## Alternatives considered

### Build a separate pipeline scheduler and execution subsystem

Rejected. It duplicates leases, retry, reaper, materialization, run history,
multi-replica behavior, connection security, and audit semantics already shipped
by Scheduled Queries.

### Store the visual graph directly on `scheduled_queries`

Rejected. It conflates editable design state with runtime jobs, provides no
immutable version/deployment boundary, and cannot represent native MV artifacts
or safe rollback cleanly.

### Compile every trigger to a native Materialized View

Rejected. Incremental and refreshable MVs have different semantics and version
availability. Manual/webhook execution also needs durable control-plane history
and idempotency.

### Use raw SQL strings in every node

Rejected for V1. It makes type propagation, identifier safety, column lineage,
diagnostics, and constrained AI patches unreliable. An advanced permission-gated
escape hatch can be proposed later.

### Introduce Airflow, Mage, NiFi, or a message broker

Rejected. They broaden deployment and operational scope while ClickHouse and the
existing Scheduled Queries runtime already execute the required transformations.
