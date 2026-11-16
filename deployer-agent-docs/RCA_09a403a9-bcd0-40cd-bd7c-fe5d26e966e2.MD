# RCA — iqfoam-business data / multi-company DB investigation (READ-ONLY)

Deployment: iqfoam-business (dbb69438-5a91-48fa-b52a-f7f69ab24638)
Live URL: https://iqfoam-business.emergent.host (health check 200 OK)
Active run: 09a403a9-bcd0-40cd-bd7c-fe5d26e966e2 (redeploy, success, 2026-11-16 14:29Z)
Resolved production DB: `iqfoam-business-test_database`

## (1) Which commit is live + did backend start cleanly
- I cannot map the run to a git SHA — `pull_source` excludes `.git`, and no tool exposes the commit hash. The live RUN is `09a403a9`. The exact SHA (401ef07 or later) is not retrievable from my tools.
- BEHAVIORAL confirmation it is the post-migration code: the live run's logs only touch the main DB `iqfoam-business-test_database` and filter by a `company_id` FIELD (e.g. `GET /api/access/workers?company_id=iqfoam-whole-sallers` 200). It never opens any per-company suffixed database. The earlier FAILED run `4efd4a1f` (13:26Z) still did, and crashed on it (see §3). So the live code is the "all companies in main DB, filtered by company_id" version.
- Backend started cleanly on the active run: `INFO: Application startup complete.` + `Uvicorn running on http://0.0.0.0:8001`. It currently serves 200/401/400 normally. (Older crash lines in the 24h window belong to the two preceding FAILED runs, not the active one.)

## (2) Main DB `iqfoam-business-test_database` counts by company_id
Verified via mongo_query count/distinct. Companies: superiqfoam | iqfoam-manufactoring | iqfoam-whole-sallers | imraan-plastics

| collection        | superiqfoam | iqfoam-manufactoring | iqfoam-whole-sallers | imraan-plastics |
|-------------------|-------------|----------------------|----------------------|-----------------|
| invoices          | 69          | 0                    | 0                    | 0               |
| payments          | 64          | 0                    | 0                    | 0               |
| customers         | 278         | 0                    | 0                    | 0               |
| employees         | 30          | 0                    | 0                    | 0               |
| attendance        | 741         | 0                    | 0                    | 0               |
| stock             | 73          | 89                   | 56                   | 0               |
| buyings           | 5           | 0                    | 0                    | 0               |
| expenses          | 79          | 0                    | 0                    | 0               |
| orders            | 27          | 0                    | 0                    | 0               |
| grvs              | 3           | 0                    | 0                    | 0               |
| suppliers         | 3           | 0                    | 0                    | 0               |
| production_daily  | 4           | 0                    | 0                    | 0               |

Method note: `distinct(company_id)` returned only `["superiqfoam"]` for every collection EXCEPT `stock`, which returned `["iqfoam-manufactoring","iqfoam-whole-sallers","superiqfoam"]`. So the 0s above are proven by distinct, not just inferred. `imraan-plastics` has NO data in any collection (it is a freshly-initialized empty profile — log warning: `Initial profile IMRAAN PLASTICS is waiting for a secure server-side password configuration`).

KEY FINDING: In the main production DB, only `superiqfoam` has transactional data. `iqfoam-manufactoring` and `iqfoam-whole-sallers` appear ONLY in `stock` (89 / 56 rows — most likely default stock seeded by `initialize_empty_company`), and have ZERO invoices, payments, customers, employees, attendance, buyings, expenses, orders, grvs, suppliers, production_daily.

## (3) Do the two separate databases exist + their counts / authorization
- I CANNOT read them. `mongo_query` is scoped server-side to the active run's resolved DB (`iqfoam-business-test_database`) only; it cannot target another database name.
- AUTHORIZATION — proven from logs: failed run `4efd4a1f` backend crashed on startup with:
  `pymongo.errors.OperationFailure: not authorized on iqfoam-business-test_database__imraan-plastics to execute command { aggregate: "settings" ... } ... 'code': 13, 'codeName': 'Unauthorized'`
  => The production Mongo user is NOT authorized on the per-company suffixed databases (`iqfoam-business-test_database__<company>`). By the identical naming/scoping this applies to `__iqfoam-manufactoring` and `__iqfoam-whole-sallers` as well.
- EXISTENCE: cannot be confirmed in production. On the INITIAL deploy, `provision_mongo` migrates only the single configured DB (`db_name`), not extra per-company databases. So the separate DBs were most likely never migrated into production (they would live in the PREVIEW cluster). Even if copies exist on the prod cluster, the prod user cannot read them (code 13 above). Either way the Manufacturing/Wholesalers historical records are NOT accessible from production today.

## (4) Log evidence the LIVE app ever saved Manufacturing/Wholesalers invoices or customers
- None found. Across the 24h window the only invoice writes were `POST /api/invoices 400 Bad Request` (×4) — rejected, not saved. No successful invoice/customer POST for `iqfoam-manufactoring` or `iqfoam-whole-sallers`. Observed Manufacturing/Wholesalers traffic was read-only (`GET /api/access/workers?company_id=iqfoam-whole-sallers` 200, `GET /api/interface-settings?company_id=iqfoam-whole-sallers` 200).
- Consistent with the data: 0 invoices / 0 customers for both companies in the main DB.
- Scope caveat: log retention is limited (~24h visible); this is not proof of "never in all history", only that no such writes are visible in the available logs, and no such rows exist in the main DB now.

## Bottom line (no data was deleted by me — read-only)
The live app is healthy and reading all companies from the main DB by `company_id`. superiqfoam data is fully present. Manufacturing and Wholesalers have ONLY seeded stock in the main DB and NO invoices/payments/customers/etc.; their historical records are not in the main production DB. If that history exists, it is in the old separate per-company databases, which the production Mongo user is not authorized to read (and which were likely never migrated to production). Those records need to be migrated into the main DB tagged with the correct `company_id` before they will appear.

## Suggested actions (NOT performed)
1. USER / change_mongo_data: Recover the Manufacturing & Wholesalers history from the separate `..__iqfoam-manufactoring` / `..__iqfoam-whole-sallers` databases (on the preview/source cluster) and migrate it into the main `iqfoam-business-test_database`, stamping each document with `company_id`. Do this BEFORE relying on prod, since nothing currently reads those separate DBs.
2. CODE (E1): The consolidation is best done by a one-time migration script that reads the per-company DBs and upserts into the main collections with `company_id`. Needed because the running code no longer reads the separate DBs.
3. Authorization: the prod Mongo user lacks privileges on the suffixed DBs (Atlas/platform-managed). A direct prod-to-prod copy from them is blocked; migrate from the source/preview cluster instead.
