# RCA — iqfoam-business: Legacy migration copied Wholesale but not Manufacturing

Scope: READ-ONLY investigation. Nothing was deployed or modified.

## Important context on WHICH run produced the logs
- Active/live run = `09a403a9-...` (redeploy, success, 2026-11-16 14:29Z). Its own startup is outside the Loki retention window — a log read on it returned only `/api/auth/me` and `/api/auth/login` 401s, no migration lines.
- The migration log evidence and the `legacy_migrations` marker (ran_at **2026-11-16T17:06:25Z**) were produced by failed redeploy run **`5a5cec64-...`** (status failed, backend unhealthy /health 503). All runs share the same production DB `iqfoam-business-test_database`, so that pod's migration attempt is what wrote the current DB/marker state. Three later rollback/redeploy runs (`782f4555`, `4de047d5`, `5a5cec64`) all CrashLoopBackOff on the same startup index error (see below).

## (1) Startup log lines (verbatim, from run 5a5cec64)
Whole-sallers — completion summary present (two instances across restarts; trimmed to per-collection numbers):
```
INFO:root:Legacy migration iqfoam-business-test_database__iqfoam-whole-sallers -> iqfoam-business-test_database: {
 audit_log: inserted 1979/existing 0/conflicts 0, buyings 19/0/0, counters 5/0/0, customers 52/0/0,
 expenses 68/0/0, grvs 21/0/0, invoice_edit_authorizations 2/0/0, invoice_share_links 2/0/0,
 invoices 311/0/0, payments 302/0/0, prices 300/0/44, production_daily 1/0/0, settings 0/existing 1/0,
 stock 418/0/0, stock_movements 408/existing 230/conflicts 54, suppliers 3/existing 1/0 ... }
(second instance: all collections inserted 0 / existing = full counts / conflicts 0 — i.e. idempotent re-run skip; stock_movements 287/363/42, suppliers 4/0/0, prices 0/300/44)
```
Manufacturing — NO completion summary line exists. The ONLY manufactoring migration lines are attendance conflict warnings, e.g.:
```
WARNING:root:Legacy iqfoam-manufactoring.attendance record not copied (conflict): {'company_id': 'iqfoam-manufactoring', 'employee_id': '693e8d7e-...', 'date': '2026-11-16'}
WARNING:root:Legacy iqfoam-manufactoring.attendance record not copied (conflict): {'company_id': 'iqfoam-manufactoring', 'employee_id': '12639a8c-...', 'date': '2026-11-16'}
... (several more attendance-only conflicts) ...
```
- A targeted search for `Legacy migration ...__iqfoam-manufactoring -> ...` returned **0 lines** (no per-company summary).
- A targeted search for any non-"record not copied" manufactoring line returned **0 lines**.
- NO lines containing `not readable`, `not authorized`, `Unauthorized`, `code 13`, `OperationFailure`, or `Legacy company database migration did not complete` were found for the migration.
- Chronology (Loki newest-first): whole-sallers summary is the OLDEST migration activity; manufactoring attendance conflicts are the NEWEST — i.e. the pod processed manufactoring attendance and then died before finishing manufactoring (no summary, no marker).

## (2) legacy_migrations collection (main DB)
Exactly ONE document — for Wholesale only. NO document for `iqfoam-manufactoring`.
```
company_id:       iqfoam-whole-sallers
source_database:  iqfoam-business-test_database__iqfoam-whole-sallers
ran_at:           2026-11-16T17:06:25.894183+00:00
collections (per-collection inserted/existing/conflicts):
  audit_log 1979/0/0, buyings 19/0/0, counters 5/0/0, customers 52/0/0, expenses 68/0/0,
  grvs 21/0/0, invoice_edit_authorizations 2/0/0, invoice_share_links 2/0/0, invoices 311/0/0,
  payments 302/0/0, prices 300/0/44, production_daily 1/0/0, settings 0/1/0, stock 418/0/0,
  stock_movements 408/230/54, suppliers 3/1/0  (all other collections 0/0/0)
```

## (3) Main DB counts by company_id
| collection | iqfoam-manufactoring | iqfoam-whole-sallers |
|---|---|---|
| invoices  | 0    | 311 |
| customers | 0    | 52  |
| payments  | 0    | 302 |
| expenses  | 0    | 68  |
| stock     | 89   | 474 |
| buyings   | 2    | 19  |
| counters  | 0    | 5   |
| audit_log | 1234 | 1979 |

Manufacturing has ZERO invoices/customers/payments/expenses/counters. It has some stock(89)/buyings(2)/audit_log(1234) — these are NOT attributable to the legacy migration (no manufactoring marker/summary); most likely pre-existing/native production data.

## (4) Can the prod Mongo user read the Manufacturing legacy DB? (code 13?)
Yes — readable. The migration successfully READ `...__iqfoam-manufactoring` (manufactoring.attendance records were read and evaluated, producing conflict warnings). NO authorization errors (code 13 / "not authorized" / "Unauthorized" / "not readable") appear anywhere in the logs. Note: I could not directly query the legacy DB (mongo_query resolves only to the main DB `iqfoam-business-test_database`), so this is inferred from the migration log evidence, not a direct read of the legacy DB.

## Root cause
The Manufacturing legacy migration never completed: it read manufactoring.attendance (so the source DB is readable and the Mongo user is authorized), but it never emitted a per-company completion summary and never wrote a `legacy_migrations` marker, and the main DB has no manufactoring invoices/customers/payments/expenses/counters. This is NOT a Mongo permission/code-13 problem.

This correlates with the backend startup crash-loop seen on runs 5a5cec64/782f4555/4de047d5:
```
pymongo.errors.OperationFailure: An existing index has the same name as the requested index...
Requested index: { v:2, unique:true, key:{ invoice_id:1 }, name:"invoice_share_once" }
existing index:  { v:2, unique:true, key:{ company_id:1, invoice_id:1 }, name:"invoice_share_once" }
code 86 IndexKeySpecsConflict   (backend/server.py:17738 initialize_multi_company -> on_startup)
```
plus a non-fatal prices index warning:
```
WARNING:root:Index on prices not created: E11000 duplicate key ... zone_1_category_1_size_1 dup key { zone:1, category:"Ribbon Black", size:"1070x100" }
```
Startup aborts (`Application startup failed. Exiting` / CrashLoopBackOff), so the migration does not run to completion for the second company each time.

## Suggested fixes (not applied — read-only)
- CODE (E1): Resolve the `invoice_share_links` "invoice_share_once" index conflict in `backend/server.py` (drop/rename the old `{company_id:1,invoice_id:1}` index or request a distinct name/key) so startup no longer crashes; and make `migrate_legacy_company_databases` complete the Manufacturing company (write its summary + `legacy_migrations` marker) rather than aborting after attendance. Also deconflict the `prices` `zone_1_category_1_size_1` unique index duplicate.
- After the code fix, re-run so Manufacturing migrates (insert-only; it should add the missing manufactoring invoices/customers/payments/expenses/counters). Verify a `legacy_migrations` doc for `iqfoam-manufactoring` appears afterward.
