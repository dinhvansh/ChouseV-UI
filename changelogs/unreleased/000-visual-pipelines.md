type: minor

### Added
- **Visual ClickHouse Pipelines** — adds a permission-gated DataOps designer with versioned typed DAGs, all V1 SQL transform nodes, safe parameterized SQL preview, read-only sample tests, schema mapping, column lineage, immutable deployments, manual/scheduled/webhook/refreshable/incremental-MV triggers, distributed concurrency control, execution history, rollback, and encrypted webhook secrets with HMAC/replay/idempotency protection.
- **AI-ready pipeline context** — adds business metadata management and an allowlisted `/api/ai/context/pipelines/:id` projection that excludes credentials, secrets, sample rows, trigger payloads, and connection configuration.
- **Pipeline runtime verification** — adds SQLite/PostgreSQL migration coverage, compiler/runtime/store/route/API tests, and optional live ClickHouse integration tests for advanced DAG SQL and native materialized views.

### Changed
- **Schema-driven pipeline editor** — constrains source, column, operator, cast, and destination choices to live ClickHouse metadata, provides structured column selection and renaming, and supports permission-gated creation of a named destination table from the validated output schema.
