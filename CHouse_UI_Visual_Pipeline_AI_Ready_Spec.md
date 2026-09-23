# CHouse UI – Visual Pipeline & AI-Ready Design Specification

## 1. Mục tiêu

Mở rộng **CHouse UI** thành một workspace quản trị ClickHouse có thêm **Visual Transformation Pipeline**, tận dụng tối đa các cơ chế native của ClickHouse thay vì xây một ETL engine mới.

Mục tiêu chính:

- Giữ kiến trúc gọn, không thêm Mage / Airflow / NiFi nếu chưa cần.
- Dùng ClickHouse làm **execution engine** cho transform.
- CHouse UI chỉ đảm nhiệm:
  - thiết kế pipeline trực quan;
  - sinh SQL;
  - deploy cấu hình vào ClickHouse;
  - trigger pipeline;
  - theo dõi trạng thái;
  - quản lý version;
  - expose metadata để AI hỗ trợ.
- Hỗ trợ AI từ đầu theo hướng **AI-ready**, nhưng AI không tự ý deploy production.

---

## 2. Kiến trúc tổng thể

```text
SQL Server / ERP
      │
      ▼
   Airbyte
      │
      ▼
ClickHouse RAW
      │
      │
      ▼
┌──────────────────────────────┐
│           CHouse UI          │
│                              │
│ Database / Table / Query     │
│ Users / Permissions          │
│ Monitoring                   │
│ Visual Pipeline              │
│ SQL Generator                │
│ Trigger Manager              │
│ Execution History            │
│ Version / Deploy             │
│ AI Context API               │
└──────────────┬───────────────┘
               │
       ┌───────┼────────┐
       ▼       ▼        ▼
 Incremental  Refresh   Webhook
     MV         MV       Trigger
       │       │        │
       └───────┼────────┘
               ▼
        ClickHouse ODS
               │
               ▼
        ClickHouse MART
               │
               ▼
      Metabase / Superset
```

### Core stack

1. **Airbyte**
   - Extract / Load
   - Full refresh / Incremental
   - Source → ClickHouse RAW

2. **ClickHouse OSS**
   - Storage
   - SQL transform
   - Incremental Materialized View
   - Refreshable Materialized View
   - ODS / MART

3. **CHouse UI**
   - Admin UI
   - Visual pipeline
   - Trigger abstraction
   - SQL preview
   - Pipeline lifecycle
   - AI context

4. **Metabase / Superset**
   - Reporting / dashboard / BI

> CHouse UI không trở thành một data-processing engine riêng.
> ClickHouse vẫn là nơi thực thi transform.

---

## 3. Triết lý Pipeline

Pipeline được xây theo mô hình **Visual SQL DAG**.

Ví dụ:

```text
[raw.PartTran]
       │
       ▼
   [Filter]
       │
       ▼
[Select / Rename]
       │
       ▼
 [Deduplicate]
       │
       ├──────────────┐
       ▼              ▼
     [Join]      [raw.Part]
       │
       ▼
  [Aggregate]
       │
       ▼
[ods.PartTranSummary]
```

CHouse UI lưu pipeline dưới dạng JSON và generate ClickHouse SQL.

Ví dụ pipeline definition:

```json
{
  "name": "PartTran ODS",
  "source": "raw.PartTran",
  "steps": [
    {
      "type": "filter",
      "condition": "Company = 'VN'"
    },
    {
      "type": "deduplicate",
      "key": ["SysRowID"],
      "order_by": "SysDate DESC"
    }
  ],
  "destination": "ods.PartTran"
}
```

Generated SQL:

```sql
INSERT INTO ods.PartTran
SELECT *
FROM raw.PartTran
WHERE Company = 'VN'
ORDER BY SysDate DESC
LIMIT 1 BY SysRowID;
```

---

## 4. Các Node V1

V1 chỉ tập trung vào transform SQL.

### Source

- ClickHouse table
- ClickHouse view

### Transform

- Select Columns
- Rename Column
- Filter
- Cast / Convert Type
- Calculated Column
- Join
- Union
- Deduplicate
- Group By
- Aggregate
- Sort
- Window Function

### Destination

- Table
- Materialized View target
- Refreshable Materialized View target

### Không làm trong V1

- Python node
- Shell script
- External API call
- Email / Teams node
- ML node
- Arbitrary plugin runtime
- Distributed worker engine
- Kafka runtime
- Complex workflow branching

Mục tiêu V1 là:

> **Visual ClickHouse Transformation Pipeline**

---

## 5. Ba chế độ Trigger

### 5.1 Incremental Materialized View

Dùng khi transform cần chạy ngay khi có dữ liệu mới được INSERT.

```text
Airbyte
   │
   ▼
INSERT raw.PartTran
   │
   ▼
Incremental MV
   │
   ▼
Transform block mới
   │
   ▼
ODS
```

Đặc điểm:

- Trigger theo từng inserted block.
- Không chờ Airbyte sync hoàn tất.
- Nếu insert 1 row thì có thể chạy trên 1 row.
- Nếu Airbyte insert batch 10,000 row thì MV chạy trên batch đó.
- Chỉ thấy block mới vừa insert.
- Không tự quét lại toàn bộ source table.

Phù hợp:

- clean;
- cast;
- filter;
- column mapping;
- simple calculation;
- simple aggregate;
- RAW → ODS.

Không phù hợp cho các phép cần nhìn toàn bộ lịch sử để quyết định kết quả cuối cùng.

---

### 5.2 Refreshable Materialized View

Dùng khi transform cần chạy theo lịch.

Ví dụ:

```text
Every 30 minutes
Every 1 hour
Daily
```

Flow:

```text
RAW / ODS
   │
   ▼
Scheduled Refresh
   │
   ▼
Run query over current dataset
   │
   ▼
MART
```

Phù hợp:

- join nhiều bảng;
- deduplicate toàn dataset;
- aggregate toàn cục;
- rebuild mart;
- transform cần dữ liệu đầy đủ.

UI:

```text
Trigger Type: Schedule

Every:
[ 30 ] [ Minutes ]
```

---

### 5.3 Webhook Trigger

Dùng khi muốn chạy pipeline sau khi hệ thống ngoài hoàn tất một event.

Use case chính:

```text
Airbyte sync
   │
   ▼
SYNC SUCCESS
   │
   ▼
Webhook
   │
   ▼
CHouse UI
   │
   ▼
Execute Pipeline
```

Ví dụ endpoint:

```http
POST /api/pipelines/{pipeline_id}/run
```

Payload:

```json
{
  "source": "airbyte",
  "connection": "ERP-to-ClickHouse",
  "status": "succeeded",
  "job_id": 12345
}
```

Condition:

```text
status == succeeded
```

Nếu:

```text
failed
cancelled
incomplete
```

thì không chạy pipeline.

---

## 6. Idempotency cho Webhook

Webhook có thể bị retry.

Do đó hệ thống phải lưu `job_id`.

Ví dụ:

```text
Airbyte Job ID = 12345
```

Logic:

```text
job_id đã xử lý?
   │
   ├─ Yes → Ignore
   │
   └─ No  → Run pipeline
```

Bảng ví dụ:

```sql
pipeline_external_events
- id
- pipeline_id
- source
- external_job_id
- status
- received_at
- processed_at
```

Unique key logic:

```text
(source, external_job_id, pipeline_id)
```

---

## 7. Concurrency Control

Không cho pipeline production chạy chồng ngoài ý muốn.

Mode:

```text
Concurrency Policy

● Do not overlap
○ Queue next run
○ Allow parallel
```

Khuyến nghị mặc định V1:

```text
Do not overlap
```

Hoặc tốt hơn:

```text
Current execution running
        │
New request arrives
        │
        ▼
Queue one execution
```

---

## 8. SQL Preview & Test

Pipeline không được deploy mù.

Các action bắt buộc:

```text
[Validate SQL]
[Test Sample]
[Run]
[Deploy]
```

SQL Preview:

```sql
SELECT
    Company,
    PartNum,
    sum(TranQty) AS TotalQty
FROM raw.PartTran
WHERE Company = 'VN'
GROUP BY
    Company,
    PartNum;
```

Test Sample nên có limit mặc định:

```sql
LIMIT 1000
```

---

## 9. Schema Mapping

Khi nối source → destination, UI tự đọc metadata từ ClickHouse.

Ví dụ:

```text
Source                Destination
---------------------------------------------
Company String        Company String       ✓
PartNum String        PartNum String       ✓
TranQty Decimal       TranQty Decimal      ✓
SysDate DateTime      TranDate Date        ⚠ cast
```

Hệ thống nên:

- tự match column cùng tên;
- highlight type mismatch;
- gợi ý cast;
- cho rename;
- cho ignore column;
- cho thêm calculated field.

---

## 10. Destination Write Mode

Pipeline phải khai báo cách ghi dữ liệu.

V1:

```text
Append
Replace
Deduplicate / Upsert Strategy
```

### Append

Phù hợp:

```text
Incremental MV
RAW → ODS
```

### Replace

Phù hợp:

```text
Refreshable MART
```

### Deduplicate Strategy

Có thể dựa trên:

```text
ReplacingMergeTree
Version Column
ORDER BY Key
LIMIT 1 BY
Refresh logic
```

Không tự động đoán.

User phải chọn rõ strategy.

---

## 11. Execution History

Màn hình lịch sử:

| Pipeline | Trigger | Start | Duration | Status |
|---|---|---|---|---|
| Sales Mart | Webhook | 10:21:03 | 12s | Success |
| Inventory ODS | Incremental | 10:25:18 | 1.4s | Success |
| AR Mart | Refresh | 11:00:00 | 8s | Failed |

Chi tiết execution:

```text
Execution ID
Pipeline Version
Trigger Type
Trigger Payload
Generated SQL
Start Time
End Time
Duration
Rows Affected
Status
ClickHouse Error
External Job ID
```

---

## 12. Version / Draft / Deploy

Production pipeline không bị sửa trực tiếp.

Lifecycle:

```text
Production v12
      │
      ▼
Edit
      │
      ▼
Draft v13
      │
      ▼
Validate
      │
      ▼
Test
      │
      ▼
Deploy
```

Nếu v13 lỗi:

```text
Rollback → v12
```

Status:

```text
DRAFT
TESTED
DEPLOYED
ARCHIVED
```

---

## 13. Pipeline Data Model

### pipelines

```text
id
name
description
status
current_version_id
created_by
created_at
updated_at
```

### pipeline_versions

```text
id
pipeline_id
version_number
definition_json
generated_sql
trigger_type
trigger_config_json
write_mode
status
created_by
created_at
deployed_at
```

### pipeline_executions

```text
id
pipeline_id
pipeline_version_id
trigger_type
trigger_payload_json
external_job_id
generated_sql
started_at
finished_at
duration_ms
rows_affected
status
error_code
error_message
```

### pipeline_external_events

```text
id
pipeline_id
source
external_job_id
payload_json
received_at
processed_at
status
```

---

# 14. AI-Ready Architecture

AI support phải được tính từ đầu nhưng không được gắn chặt với một model provider.

CHouse UI expose metadata thông qua một lớp **AI Context API**.

```text
CHouse UI
│
├── Database Metadata
├── Table Metadata
├── Pipeline Metadata
├── Execution History
├── Errors
├── Business Metadata
└── AI Context API
```

---

## 15. AI Context API

Ví dụ endpoint:

```http
GET /api/ai/context/pipelines/{pipeline_id}
```

Response:

```json
{
  "pipeline": {},
  "pipeline_version": {},
  "source_schema": {},
  "destination_schema": {},
  "business_metadata": {},
  "generated_sql": "",
  "last_execution": {},
  "last_error": null
}
```

AI không cần tự query metadata lung tung.

Backend chuẩn bị sẵn context an toàn.

---

## 16. Business Metadata

Schema kỹ thuật chưa đủ cho AI.

Admin có thể bổ sung semantic description.

Ví dụ:

```text
Table: raw.PartTran

Description:
Epicor inventory transaction history.
Contains warehouse transaction movement.
```

Column:

```text
PartNum
Description: ERP product code

TranQty
Description: Transaction quantity

SysRowID
Description: Unique transaction row identifier

SysDate
Description: Transaction date from Epicor
```

Có thể bổ sung:

```text
Business Owner
Data Owner
Sensitivity
Refresh Frequency
Source System
Business Definition
```

---

## 17. AI Use Cases

### 17.1 Create Pipeline

User:

> Tạo pipeline từ raw.PartTran sang ods.PartTran, bỏ duplicate theo SysRowID.

AI đọc:

```text
source schema
business metadata
existing pipeline patterns
```

AI trả pipeline definition:

```json
{
  "source": "raw.PartTran",
  "steps": [
    {
      "type": "deduplicate",
      "key": ["SysRowID"],
      "order_by": "SysDate DESC"
    }
  ],
  "destination": "ods.PartTran"
}
```

UI render pipeline.

---

### 17.2 Modify Current Pipeline

User:

> thêm filter chỉ lấy Company = ANDROS

AI nhận context pipeline hiện tại và trả patch:

```json
{
  "operation": "add_node",
  "node": {
    "type": "filter",
    "condition": "Company = 'ANDROS'"
  }
}
```

---

### 17.3 Fix Pipeline Error

Error:

```text
TYPE_MISMATCH
InvoiceDate
String → Date
```

AI context:

```text
Pipeline JSON
Generated SQL
Source Schema
Destination Schema
ClickHouse Error
```

AI đề xuất:

```sql
toDateOrNull(InvoiceDate)
```

UI:

```text
[Apply Suggestion]
[Ignore]
```

---

### 17.4 Suggest Join

User:

> join Part để lấy PartDescription

AI search metadata:

```text
raw.Part
- PartNum
- PartDescription
```

AI đề xuất:

```text
LEFT JOIN raw.Part p
ON t.PartNum = p.PartNum
```

---

### 17.5 Explain Pipeline

User:

> pipeline này đang làm gì?

AI dùng pipeline JSON + SQL + metadata để trả lời theo business language.

---

## 18. AI Permission Model

AI mặc định không có quyền production write.

Permission:

```text
✓ Read metadata
✓ Read pipeline definition
✓ Read generated SQL
✓ Read execution history
✓ Read errors
✓ Generate SQL
✓ Suggest pipeline changes

○ Read sample data
○ Execute test query
○ Save draft
○ Deploy pipeline
○ Modify production
```

Recommended default:

```text
AI Suggest
    │
    ▼
SQL Preview
    │
    ▼
User Review
    │
    ▼
User Approve
    │
    ▼
Deploy
```

---

## 19. AI Provider Abstraction

Không hard-code OpenAI / Claude / Gemini.

Interface:

```text
AI Provider
│
├── OpenAI
├── Claude
├── Gemini
└── Local LLM
```

Backend chung:

```text
AI Context Builder
       │
       ▼
Provider Adapter
       │
       ▼
Model
```

Sau này đổi model không ảnh hưởng pipeline architecture.

---

## 20. Security

### Database Access

CHouse UI dùng ClickHouse account theo principle of least privilege.

Ví dụ role:

```text
chouse_reader
chouse_pipeline_editor
chouse_pipeline_deployer
chouse_admin
```

### AI

Không gửi:

- password;
- secret;
- connection string chứa credentials;
- unrestricted production data;

sang AI provider.

AI context phải filter secret trước.

### Webhook

Webhook cần:

```text
Secret token
HMAC signature hoặc API key
Timestamp validation
Replay protection
Idempotency
```

---

## 21. V1 Scope

### Must Have

- Pipeline Designer
- Source node
- Filter
- Select / Rename
- Cast
- Join
- Deduplicate
- Aggregate
- Destination
- SQL Preview
- Validate SQL
- Test Sample
- Incremental MV Trigger
- Refreshable MV Trigger
- Webhook Trigger
- Execution History
- Error Detail
- Concurrency Lock
- Webhook Idempotency
- Draft / Deploy
- Version History
- Rollback
- Schema Mapping
- AI Context API
- Business Metadata

### Nice to Have

- AI Assistant panel
- AI pipeline generator
- AI fix suggestion
- visual lineage
- diff between pipeline versions

### Not V1

- Python runtime
- external worker engine
- Kafka engine
- ML pipeline
- arbitrary scripts
- email/Teams orchestration
- complex workflow IF/ELSE
- multi-engine execution

---

## 22. Development Priority

### Phase 1 – Pipeline Core

1. Pipeline metadata model
2. Pipeline Designer
3. SQL Generator
4. SQL Preview
5. Validate / Test

### Phase 2 – Trigger

1. Incremental MV
2. Refreshable MV
3. Webhook
4. Manual Run

### Phase 3 – Runtime

1. Execution History
2. Error logs
3. Concurrency
4. Idempotency

### Phase 4 – Lifecycle

1. Draft
2. Version
3. Deploy
4. Rollback

### Phase 5 – AI Ready

1. Business Metadata
2. AI Context API
3. Permission layer
4. AI Assistant panel
5. Generate / Fix / Explain Pipeline

---

## 23. Design Principle

Không build:

> “Một Mage / Airflow / NiFi mới.”

Build:

> **Một visual management layer cho native ClickHouse transformation capabilities.**

CHouse UI chịu trách nhiệm:

```text
Design
Generate
Validate
Deploy
Trigger
Monitor
Explain
```

ClickHouse chịu trách nhiệm:

```text
Execute
Transform
Store
Aggregate
Refresh
Materialize
```

Airbyte chịu trách nhiệm:

```text
Extract
Load
Incremental Sync
```

BI chịu trách nhiệm:

```text
Report
Dashboard
Analytics
```

---

## 24. Target Architecture

```text
              SQL SERVER / ERP
                     │
                     ▼
                  AIRBYTE
                     │
                     ▼
              CLICKHOUSE RAW
                     │
                     ▼
        ┌─────────────────────────┐
        │        CHouse UI        │
        │                         │
        │ Visual Pipeline         │
        │ SQL Generator           │
        │ Schema Mapping          │
        │ Trigger Manager         │
        │ Version / Deploy        │
        │ Execution History       │
        │ AI Context API          │
        └────────────┬────────────┘
                     │
          ┌──────────┼───────────┐
          ▼          ▼           ▼
    Incremental   Refreshable   Webhook
        MV            MV        Trigger
          │          │           │
          └──────────┼───────────┘
                     ▼
               CLICKHOUSE ODS
                     │
                     ▼
               CLICKHOUSE MART
                     │
                     ▼
          METABASE / SUPERSET
```

---

## 25. Tóm tắt

Mục tiêu cuối cùng:

```text
Airbyte
   ↓
ClickHouse
   ↑
CHouse UI Pipeline
   ↓
Metabase / Superset
```

Trong đó CHouse UI được nâng từ admin UI thành:

> **ClickHouse Data Workspace + Visual ELT + AI-Ready Copilot Layer**

mà không tạo thêm một execution engine mới.
