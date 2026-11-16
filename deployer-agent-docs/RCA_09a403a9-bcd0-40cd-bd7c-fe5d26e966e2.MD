# iqfoam-business — READ-ONLY Production Audit

Audit timestamp: ~2026-11-16T15:45Z (UTC, approximate — based on latest observed run/log activity; no wall-clock tool available).
Mode: READ-ONLY. No deploy, restore, index change, or config write was performed.
Scope note: reports counts, aggregate dates, and technical source names only. No personal data, invoice content, URIs, or secrets included.

Deployment: iqfoam-business (deployment_id dbb69438-5a91-48fa-b52a-f7f69ab24638)
Active/serving run: 09a403a9-bcd0-40cd-bd7c-fe5d26e966e2 (type=redeploy, success, completed 2026-11-16T14:29:04Z)

---

## (1) Databases / clusters visible to tooling

Main production DB (resolved server-side by mongo_query): **iqfoam-business-test_database**
- Accessible: **YES**. How I know: mongo_query resolved and returned this db_name and successfully ran list_collections (61 collections) + counts against it.

Per-company suffixed DBs (naming pattern `iqfoam-business-test_database__<company>`). The `companies` collection in the main DB lists 4 company ids: `superiqfoam`, `iqfoam-whole-sallers`, `iqfoam-manufactoring`, `imraan-plastics`. Under the app's one-DB-per-company model that implies:
- `iqfoam-business-test_database__iqfoam-whole-sallers` — Accessible: **NO / NOT VERIFIED**
- `iqfoam-business-test_database__iqfoam-manufactoring` — Accessible: **NO / NOT VERIFIED**
- `iqfoam-business-test_database__imraan-plastics` — Accessible: **NO / NOT VERIFIED**

How I know: the mongo_query tool is pinned server-side to the deployment's resolved main db_name and accepts no database parameter, so I cannot target any suffixed DB. Independent corroboration that these DBs exist but are permission-restricted: the failed redeploy run 4efd4a1f recorded `OperationFailure: not authorized on iqfoam-business-test_database__imraan-plastics to execute command {aggregate: "settings"...}` (code 13, Unauthorized) — i.e. the app's OWN DB user lacked privileges on that suffixed DB during startup.

No other clusters are visible to my tools (a single MONGO_URL / cluster backs this deployment).

---

## (2) `invoices` collection audit — per ACCESSIBLE DB

### iqfoam-business-test_database (ACCESSIBLE)
- invoices total: **69**
- company_id = 'iqfoam-whole-sallers': **0**
- company_id missing or null: **0** (filter {company_id: null} matched 0; no documents lack the field)
- breakdown by company_id: distinct(company_id) = **['superiqfoam']** → superiqfoam: 69 (100%); all other companies: 0 in this DB
- date fields present: both **`created_at`** (ISO datetime) and **`date`** (YYYY-MM-DD string)
  - created_at min: 2026-10-31T18:28:21Z ; max: 2026-11-16T14:02:40Z
  - date min: 2026-10-31 ; max: 2026-11-16

Interpretation (not verified): the main DB holds only superiqfoam's invoices. Any iqfoam-whole-sallers invoices would live in the separate `..__iqfoam-whole-sallers` DB, which is NOT accessible to this audit.

### iqfoam-business-test_database__iqfoam-whole-sallers (INACCESSIBLE)
- invoices total / wholesale count / null count / breakdown / date range: **NOT VERIFIED**

### iqfoam-business-test_database__iqfoam-manufactoring (INACCESSIBLE)
- all metrics: **NOT VERIFIED**

### iqfoam-business-test_database__imraan-plastics (INACCESSIBLE)
- all metrics: **NOT VERIFIED**

---

## (3) Platform snapshots / backups / checkpoints

No backup/snapshot/checkpoint listing capability is exposed to this agent's tools. Therefore:
- Visible snapshots: **NONE VISIBLE / NOT VERIFIED** (absence of a listing tool, not proof none exist).
- Per-snapshot invoice counts (total/wholesale) and date ranges: **NOT VERIFIED**.
(Atlas backups, if any, must be checked in the MongoDB Atlas console by the account owner.)

---

## (4) Production logs — POST /api/invoices success while active company = iqfoam-whole-sallers

Window: last 1440 min (24h) of the active run's pods — the maximum log retention available; this run's pods started ~2026-11-16T14:22Z, so the window effectively covers ~14:22Z→now only.

Findings (filter "invoices" on active run logs):
- POST /api/invoices observed: **4 occurrences, ALL HTTP 400 Bad Request**.
- POST /api/invoices with 200/201: **0** in the retained window.
- GET /api/invoices (list reads): 200 OK (multiple).

Company attribution: the access logs do **not** carry the active-company context, so no POST can be tied to `iqfoam-whole-sallers` (or any company) from logs alone. Combined with the zero successful creates in-window, there is **no evidence of a successful invoice creation under iqfoam-whole-sallers**, and anything older than the ~24h retention is **NOT VERIFIED**.

---

## Current live status

- The deployed URL returns **HTTP 200 (healthy)**. The **previous good version is still serving** — active_run_id = 09a403a9 (success, 2026-11-16T14:29:04Z).
- The most recent deploy attempts all FAILED and were never promoted (no traffic switch):
  - run 4de047d5 (rollback, 15:42Z) — FAILED: backend startup crash, `pymongo OperationFailure IndexKeySpecsConflict` (code 86) creating index **`invoice_share_once`** on `invoice_share_links`: requested `{invoice_id:1} unique name "invoice_share_once"` conflicts with existing `{company_id:1, invoice_id:1} unique name "invoice_share_once"`. Also a secondary warning: index `zone_1_category_1_size_1` on `prices` failed to build with E11000 duplicate key (zone/category/size dup, e.g. "Ribbon Black"/"1070x100").
  - run 8c4f9a57 (rollback, 15:37Z) — FAILED: frontend unhealthy at / status 503.
  - run 6b191d00 (redeploy, 13:50Z) — FAILED health_check: frontend 503.
  - run 4efd4a1f (redeploy, 13:26Z) — FAILED: backend startup crash, `not authorized on ..__imraan-plastics` (code 13) during per-company init.
- Net: the index conflict crash is confined to the FAILED runs; the live version is unaffected and up.

---

## Root cause of the failed deploys (for reference; NOT fixed per read-only scope)

The startup routine `initialize_multi_company` (backend/server.py ~line 17738) calls `base_db.invoice_share_links.create_index(..., name="invoice_share_once")` requesting key `{invoice_id:1}`, but an index already exists on `{company_id:1, invoice_id:1}` under that same name. MongoDB rejects same-name/different-spec (code 86). Because this runs in the FastAPI lifespan startup and raises, the backend exits → CrashLoopBackOff → deploy never becomes ready. A separate startup path also assumes auth on every per-company DB (`..__imraan-plastics` returned Unauthorized, code 13) which crashed an earlier attempt.

These are application/startup-code issues (and a DB index/privilege state issue), not a platform/manifest fault.
