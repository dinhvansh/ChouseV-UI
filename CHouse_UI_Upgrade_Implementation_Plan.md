# Kế hoạch nâng cấp CHouse UI

Tài liệu này chuyển `CHouse_UI_Visual_Pipeline_AI_Ready_Spec.md` thành kế hoạch triển khai có thể chia thành epic, sprint và tiêu chí nghiệm thu.

## 1. Kết luận và phạm vi

CHouse UI nên được phát triển như một **control plane** cho ClickHouse:

- CHouse UI quản lý metadata, thiết kế DAG, sinh và kiểm tra SQL, deploy, trigger, lịch sử chạy và phân quyền.
- ClickHouse tiếp tục là execution engine duy nhất cho transform.
- Airbyte tiếp tục phụ trách extract/load.
- V1 không đưa thêm worker xử lý dữ liệu, Python runtime hoặc workflow engine tổng quát.

Source code CHouse UI đã được khảo sát ở commit `757c8e1` trên branch `main`. Dự án là monorepo React 19 + Vite 7 và Bun + Hono, lưu control-plane metadata trên SQLite/PostgreSQL bằng Drizzle. Repo đã có Scheduled Queries, Data Health, RBAC, audit, ClickHouse connection proxy, provider-neutral AI, React Flow và Dagre. Vì vậy kế hoạch không còn là greenfield: Visual Pipelines sẽ mở rộng DataOps và tái sử dụng Scheduled Queries làm runtime thay vì tạo scheduler/execution subsystem mới.

Thiết kế chi tiết và các quyết định ràng buộc nằm tại `docs/adr/0015-visual-transformation-pipelines.md`. Theo quy ước repo, ADR phải được duyệt từ `Proposed` sang `Accepted` trước khi triển khai code đa thành phần.

### 1.1 Ánh xạ vào codebase hiện tại

| Nhu cầu | Thành phần tái sử dụng/mở rộng |
|---|---|
| DataOps navigation | `src/pages/DataOps.tsx` |
| Editable visual DAG | feature mới `src/features/pipelines/`; dùng dependency `reactflow`/`dagre` hiện có |
| API client | `src/api/pipelines.ts` theo pattern `src/api/scheduledQueries.ts` |
| API routes | `packages/server/src/routes/pipelines.ts` |
| Scheduler, lease, retry, run history | `packages/server/src/services/scheduledQueries/` |
| Materialize append/replace/upsert | `scheduledQueries/materialize.ts` |
| Read-only validation and ClickHouse parameters | `scheduledQueries/validation.ts` và SQL parser middleware |
| Metadata database | migration tiếp theo trong `packages/server/src/rbac/db/migrations.ts` |
| Migration verification | `packages/server/src/rbac/db/migrations.test.ts`, chạy cả SQLite/PostgreSQL |
| RBAC | `packages/server/src/rbac/schema/base.ts` + route middleware |
| Audit | audit actions/store hiện có |
| AI provider/structured output | `packages/server/src/services/ai/` |
| Existing read-only physical pipeline visual | `src/features/workspace/components/PipelineView.tsx`; không dùng làm editor |

## 2. Các quyết định cần chốt trước khi code

### 2.1 Nền tảng hiện tại

Xác nhận:

- frontend framework, backend framework và cơ chế authentication hiện tại;
- database đang lưu control-plane metadata;
- cách CHouse UI kết nối ClickHouse và quản lý credentials;
- ClickHouse server/version, topology single-node hay cluster;
- môi trường `dev`, `staging`, `production` và quy trình release.

### 2.2 Control-plane storage

Ưu tiên tái sử dụng database giao dịch hiện tại của CHouse UI nếu nó hỗ trợ transaction, unique constraint và migration. Nếu chưa có, PostgreSQL phù hợp hơn ClickHouse để lưu draft, version, lock, idempotency và hàng đợi nhỏ. Không lưu secret trực tiếp trong JSON pipeline.

### 2.3 Khả năng tương thích ClickHouse

Lập capability matrix theo phiên bản thực tế:

| Capability | Cần xác minh |
|---|---|
| Incremental Materialized View | DDL, quyền tạo/xóa, hành vi khi source insert theo block |
| Refreshable Materialized View | phiên bản hỗ trợ, cú pháp refresh, dependency và quyền hệ thống |
| Atomic replace | staging table, `EXCHANGE TABLES` hoặc chiến lược tương đương |
| Query tracking | `query_id`, `system.query_log`, độ trễ flush log |
| Cluster deploy | `ON CLUSTER`, distributed DDL queue, replicated database |

Nếu phiên bản production chưa hỗ trợ Refreshable MV ổn định, V1 dùng scheduler của control plane để chạy câu lệnh `INSERT ... SELECT`/atomic replace; đây chỉ là cơ chế điều phối, không phải data-processing engine mới.

## 3. Kiến trúc đề xuất

```text
Browser
  -> Pipeline Designer / SQL Preview / Runs / Versions
  -> CHouse API
       -> AuthZ + Audit
       -> Pipeline Definition Service
       -> Schema Introspection Service
       -> SQL Compiler + Validator
       -> Deployment Service
       -> Trigger / Run Coordinator
       -> AI Context Builder
       -> Control-plane DB
       -> ClickHouse
```

Tách các trách nhiệm thành module ngay cả khi V1 vẫn là một modular monolith. Chưa cần microservice hoặc message broker. Run Coordinator có thể chạy dưới dạng background process cùng codebase nhưng phải có lease/lock trong database để hỗ trợ nhiều backend instance.

### 3.1 Hợp đồng pipeline

Không dùng cấu trúc `source + steps` tuyến tính làm model chuẩn vì Join/Union cần nhiều nhánh. Model chuẩn nên là DAG có version:

```json
{
  "schemaVersion": 1,
  "nodes": [
    {"id": "source_1", "type": "source", "config": {}},
    {"id": "filter_1", "type": "filter", "config": {}},
    {"id": "target_1", "type": "destination", "config": {}}
  ],
  "edges": [
    {"from": "source_1", "to": "filter_1", "input": "main"},
    {"from": "filter_1", "to": "target_1", "input": "main"}
  ]
}
```

Yêu cầu bắt buộc:

- JSON Schema cho từng `schemaVersion` và từng node type;
- node ID ổn định để diff và AI patch;
- kiểm tra cycle, orphan node, port cardinality và type compatibility;
- migration function khi definition schema thay đổi;
- canonical JSON để hash, audit và chống deploy nhầm version.

### 3.2 SQL compiler

Pipeline đi qua các bước cố định:

```text
Definition JSON
  -> structural validation
  -> DAG/type validation
  -> logical plan
  -> ClickHouse SQL AST
  -> rendered SQL + bound parameters
  -> EXPLAIN/validation
  -> deployment artifact
```

Không ghép trực tiếp identifier hoặc expression từ chuỗi UI. Identifier phải quote/validate; literal dùng parameter; calculated expression cần parser/allowlist. Compiler trả về cả SQL, diagnostics, lineage và output schema để UI/AI cùng sử dụng.

### 3.3 Runtime và deployment

Mỗi lần chạy có `execution_id` nội bộ và `query_id` riêng gửi sang ClickHouse. Deployment phải lưu immutable artifact gồm pipeline version, generated SQL, object names, checksum, actor và timestamp.

Concurrency policy:

- `do_not_overlap`: request mới bị từ chối/đánh dấu skipped;
- `queue_one`: chỉ giữ một pending run, các request tiếp theo được coalesce;
- `parallel`: chỉ bật khi người có quyền deploy xác nhận.

Lock phải là distributed lease có expiry/heartbeat, không dùng biến trong memory.

## 4. Data model V1

Giữ bốn bảng trong đặc tả và bổ sung các trường/bảng sau:

### Bảng chính

- `pipelines`: thêm `environment_id`, `owner_id`, `archived_at`.
- `pipeline_versions`: thêm `schema_version`, `definition_hash`, `validation_status`, `test_status`, `created_from_version_id`.
- `pipeline_deployments`: version nào đang chạy ở môi trường nào, deployment artifact, actor, deployed/rolled-back time.
- `pipeline_executions`: thêm `request_id`, `query_id`, `deployment_id`, `queued_at`, `attempt`, `cancel_requested_at`.
- `pipeline_external_events`: lưu `signature_valid`, `event_timestamp`; unique `(source, external_job_id, pipeline_id)`.
- `pipeline_run_requests`: hàng đợi/lease nhỏ cho manual, webhook và schedule.
- `business_metadata`: entity type/id, description, owner, sensitivity, source system, refresh frequency.
- `audit_events`: actor, action, resource, before/after hash, timestamp, correlation ID.

### Trạng thái

Version:

```text
DRAFT -> VALIDATED -> TESTED -> DEPLOYED -> ARCHIVED
```

Execution:

```text
QUEUED -> RUNNING -> SUCCEEDED
                  -> FAILED
                  -> CANCELED
        -> SKIPPED
```

State transition phải được backend kiểm soát; client không được tự gán trạng thái.

## 5. Lộ trình triển khai

Estimate dùng đơn vị tuần công của một nhóm nhỏ và chỉ được chốt lại sau Phase 0.

### Phase 0 — Discovery và technical spike (1–2 tuần)

Deliverables:

- inventory codebase, auth, database và deployment hiện tại;
- ClickHouse capability matrix;
- ADR cho control-plane DB, pipeline JSON, SQL parser/compiler và scheduler fallback;
- threat model sơ bộ;
- prototype compile một pipeline `Source -> Filter -> Select -> Destination`;
- test kết nối, `EXPLAIN`, `query_id` và đọc `system.query_log`.

Exit criteria: sinh được SQL hợp lệ trên đúng phiên bản ClickHouse mục tiêu và đã chốt cách deploy cho cả single-node/cluster.

### Phase 1 — Vertical slice khả dụng (2–3 tuần)

Scope:

- migrations cho pipeline/version/execution/audit;
- danh sách pipeline, tạo draft và editor canvas cơ bản;
- Source, Filter, Select/Rename, Cast, Destination;
- schema introspection và schema mapping;
- SQL preview, validate và test sample read-only;
- manual run;
- execution history và error detail;
- role `reader`, `editor`, `deployer`, `admin`.

Exit criteria:

- user tạo được pipeline RAW -> ODS không viết SQL tay;
- invalid DAG/type bị chặn trước khi gửi ClickHouse;
- test sample không thể mutate dữ liệu;
- mọi run có version, SQL, query ID, actor, duration và trạng thái.

### Phase 2 — DAG và transform đầy đủ V1 (2–3 tuần)

Scope:

- Join, Union, Deduplicate, Group By/Aggregate, Sort, Window Function, Calculated Column;
- multi-input ports, type propagation và output-schema inference;
- cảnh báo semantic theo trigger;
- lineage cấp table/column;
- unit/golden tests cho compiler.

Guardrail quan trọng:

- incremental MV chỉ nhìn inserted block;
- Join trong incremental MV không tự chạy lại khi lookup table thay đổi;
- global dedup/global aggregate không được gợi ý cho incremental MV nếu semantics không đúng;
- Sort không đảm bảo thứ tự lưu trữ cuối cùng nếu table engine không hỗ trợ theo cách mong đợi.

Exit criteria: tất cả node V1 có fixture JSON -> expected SQL và chạy integration test trên ClickHouse mục tiêu.

### Phase 3 — Trigger, write mode và concurrency (2–3 tuần)

Scope:

- incremental MV deployment;
- refreshable MV hoặc scheduler fallback đã chốt ở Phase 0;
- webhook có HMAC/API key, timestamp window và idempotency;
- manual run;
- Append, Replace, Deduplicate strategy;
- distributed lease, `do_not_overlap` và `queue_one`;
- retry có phân loại lỗi và exponential backoff cho lỗi tạm thời.

Exit criteria:

- webhook retry cùng external job ID không tạo run trùng;
- restart backend không làm mất lock hoặc run request;
- replace không để bảng đích ở trạng thái rỗng/nửa chừng;
- deploy/delete MV có dry-run và audit log.

### Phase 4 — Lifecycle và vận hành production (2 tuần)

Scope:

- Draft/Validate/Test/Deploy;
- immutable version và version diff;
- rollback bằng deployment artifact đã kiểm chứng;
- retention/cleanup execution history;
- health metrics, structured log, correlation ID và alert hooks;
- cancel/timeout và giới hạn tài nguyên query;
- backup/restore metadata.

Exit criteria:

- production version không sửa trực tiếp;
- rollback không regenerate SQL từ compiler mới mà dùng artifact đã lưu;
- dashboard quan sát được queue depth, success rate, latency, stuck run và webhook reject;
- hoàn thành restore drill cho control-plane database.

### Phase 5 — AI-ready, chưa cho autonomous deploy (1–2 tuần)

Scope:

- business metadata editor;
- AI Context API có field allowlist và redaction;
- permission riêng cho metadata, sample data, test query và save draft;
- JSON Patch/node-operation contract cho AI suggestion;
- Explain, Generate Draft và Fix Suggestion;
- provider adapter, quota, timeout và audit.

Exit criteria:

- context không chứa credential/secret/sample data nếu chưa được cấp quyền;
- output AI luôn qua JSON Schema, compiler validation và user review;
- AI không thể deploy hoặc sửa production bằng endpoint suggestion;
- lưu model/provider, prompt-template version và user decision để audit, không lưu secret.

## 6. Backlog ưu tiên

### P0 — Bắt buộc để pilot

- capability matrix và ADR;
- versioned DAG schema;
- compiler an toàn và diagnostic model;
- Source/Filter/Select/Rename/Cast/Destination;
- schema introspection;
- preview/validate/test sample/manual run;
- execution history;
- RBAC và audit;
- draft/deploy/version/rollback;
- một trigger production được chọn theo use case pilot;
- concurrency `do_not_overlap`;
- webhook idempotency nếu pilot dùng Airbyte callback.

### P1 — Hoàn thiện V1

- Join/Union/Deduplicate/Aggregate/Window;
- đủ ba trigger;
- đủ ba write mode;
- queue one, retry, timeout/cancel;
- version diff và lineage;
- business metadata và AI Context API.

### P2 — Sau khi V1 ổn định

- AI assistant Generate/Fix/Explain;
- pipeline templates;
- impact analysis nâng cao;
- promotion giữa dev/staging/prod;
- policy-as-code và approval nhiều bước;
- cost/query-plan recommendations.

## 7. Chiến lược kiểm thử

- **Unit:** graph validation, type inference, identifier escaping, state transition, permission checks.
- **Golden:** mỗi pipeline JSON cố định phải sinh đúng SQL snapshot theo compiler version.
- **Integration:** ClickHouse container/server đúng phiên bản production; test DDL, MV, refresh, query log và lỗi thật.
- **Property/security:** fuzz expression/identifier, SQL injection, HMAC replay, cross-project authorization.
- **Migration:** đọc được mọi definition schema cũ và rollback metadata migration.
- **E2E:** create draft -> validate -> sample -> deploy -> trigger -> history -> rollback.
- **Failure:** backend restart, ClickHouse timeout, duplicate webhook, expired lease, partial cluster DDL.

Không chỉ dựa vào `LIMIT 1000` để bảo vệ Test Sample. Backend phải chỉ cho phép read-only SELECT, đặt quota/timeout/max rows/max bytes và bọc query theo AST an toàn.

## 8. Chỉ số sẵn sàng phát hành

- 100% node V1 có unit và integration fixture.
- Không có đường API nào cho editor bypass validate/test để deploy.
- Duplicate webhook test tạo đúng một accepted run.
- Không có secret trong pipeline JSON, AI context, log hoặc execution error.
- Audit bao phủ create/edit/test/deploy/rollback/run/cancel và thay đổi quyền.
- Pilot pipeline chạy ổn định qua tối thiểu một chu kỳ dữ liệu thực và rollback drill thành công.
- Tỷ lệ run thành công, p95 queue time và p95 execution time có baseline trước khi mở rộng pilot.

## 9. Rủi ro chính và cách giảm thiểu

| Rủi ro | Tác động | Giảm thiểu |
|---|---|---|
| Hiểu sai incremental MV | dữ liệu ODS/MART sai âm thầm | semantic validator, cảnh báo bắt buộc, integration test theo block |
| Feature lệch phiên bản ClickHouse | deploy thất bại | capability matrix và version-gated compiler |
| String-based SQL generation | SQL injection hoặc SQL sai | AST/compiler, identifier validation, parameters |
| Replace không atomic | mất/thiếu dữ liệu | staging + atomic swap theo capability thực tế |
| Lock trong memory | chạy chồng khi scale/restart | DB lease có heartbeat/expiry |
| Rollback regenerate SQL | artifact khác bản từng deploy | lưu immutable deployment artifact/checksum |
| AI lộ dữ liệu hoặc sửa production | sự cố bảo mật/vận hành | redaction, least privilege, schema validation, human approval |
| `rows_affected` không chính xác tức thời | history gây hiểu nhầm | ghi rõ nguồn metric, reconcile từ query log, cho phép trạng thái pending |

## 10. Pilot đề xuất

Chọn một pipeline RAW -> ODS có volume vừa phải và logic đơn giản:

```text
raw.PartTran
  -> Filter Company
  -> Select/Rename
  -> Cast
  -> Deduplicate theo SysRowID
  -> ods.PartTran
```

Nếu deduplicate cần nhìn toàn bộ lịch sử, pilot dùng schedule/refresh hoặc ReplacingMergeTree strategy đã được người dùng chọn rõ; không mặc định dùng incremental MV. Sau khi pilot đạt tiêu chí phát hành, mới mở Join/Aggregate cho MART và AI assistant.

## 11. Việc cần cung cấp để chuyển sang kế hoạch theo codebase

- source code CHouse UI hoặc đường dẫn repository;
- framework/runtime và database hiện dùng;
- ClickHouse version/topology;
- phương thức authentication/RBAC hiện tại;
- pipeline pilot và DDL/schema của source/destination;
- yêu cầu môi trường deploy và CI/CD.

Khi có các dữ liệu trên, Phase 0 có thể được chuyển thành danh sách ticket theo module/file, dependency, owner và estimate cụ thể.
