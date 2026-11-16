# RCA — iqfoam-business redeploy (run 6b191d00-fabe-46a4-b775-c4a0feca492f)

## Symptom
Deploy failed at **health_check**: `frontend unhealthy at /: status 503` after 3 attempts.

## What actually happened
The 503 is a downstream symptom, not the cause. The backend **crash-loops on startup**, so nginx has no live upstream to proxy `/` to and returns 503. Pod events confirm it:
- `BackOff restarting failed container` (counts 20–22)
- `Startup probe failed: ... connect: connection refused` on :8080

## Root cause (fatal, backend exits on startup)
During the FastAPI startup handler chain:
`on_startup` → `initialize_multi_company` → `ensure_performance_indexes` → `create_collection_indexes` (server.py ~17959–18114)

the app tries to create an index on the **`grvs`** collection and MongoDB rejects it:

```
pymongo.errors.OperationFailure: An existing index has the same name as the requested index.
Requested index: { company_id: 1, source_buying_id: 1 }, name: "grv_source_buying_once", sparse: true, unique: true
existing index:  { source_buying_id: 1 },               name: "grv_source_buying_once", sparse: true, unique: true
code: 86, codeName: IndexKeySpecsConflict
```

This is an **unhandled** exception → `Application startup failed. Exiting.` → `Backend failed to start at initialization, exiting` → container exits 1 → CrashLoopBackOff → health_check 503.

### Verified against the production DB (read-only)
`list_indexes` on `iqfoam-business-test_database.grvs` shows the pre-existing index:
```
{ "key": { "source_buying_id": 1 }, "name": "grv_source_buying_once", "unique": true, "sparse": true }
```
The code now wants the SAME name with key `{ company_id: 1, source_buying_id: 1 }`. Same name + different key spec = IndexKeySpecsConflict. The index definition was changed in code without migrating the already-existing index.

## Secondary (non-fatal) findings
The logs also show `E11000 duplicate key` **warnings** (caught, logged, index skipped) on these collections for `company_id: "superiqfoam"`:
- `expenses`  → index `company_id_1_source_key_1`, dup `{company_id:"superiqfoam", source_key:null}`
- `stock_movements` → index `company_id_1_dedupe_key_1`, dup `{company_id:"superiqfoam", dedupe_key:null}`
- `payments` → index `company_id_1_idempotency_key_1`, dup `{company_id:"superiqfoam", idempotency_key:null}`

These do NOT crash startup (they are `WARNING:root:Index on ... not created`), but they mean those unique indexes are not being created because existing docs violate uniqueness (multiple docs with the key field null). Worth cleaning up, but not the deploy blocker.

Note: an earlier run (4efd4a1f) failed with a different Mongo error — `not authorized on iqfoam-business-test_database__imraan-plastics` during a multi-company init path — indicating the multi-company startup logic also reaches databases the connection user isn't authorized on. Not the cause of this run's failure, but the same startup-init code area is fragile.

## Fix (Code — E1)
Make the startup index creation resilient to a changed index definition. Options, in order of preference:
1. In `create_collection_indexes`/`ensure_performance_indexes`, before creating `grv_source_buying_once`, **drop the existing index if its key spec differs** (catch code 86 / detect existing key `{source_buying_id:1}` and `drop_index("grv_source_buying_once")`, then recreate with `{company_id:1, source_buying_id:1}`). 
2. Or give the new index a **new, distinct name** so it doesn't collide with the legacy one, and drop the old one in a migration.
3. Wrap index creation so an `OperationFailure` (code 86 IndexKeySpecsConflict, like the existing E11000 handling) is caught and logged as a warning instead of being fatal — so a definition change never crashes startup.

Also address the E11000 duplicates (backfill/clean null key fields for `company_id:"superiqfoam"` in expenses/stock_movements/payments) so those unique indexes can build.

## Why no pipeline resume
The broken logic is baked into the app image and the conflicting index still sits in the production DB; a plain resume_pipeline would re-run the identical startup and crash again. This needs a source fix (and/or dropping the legacy `grv_source_buying_once` index). Not manifest-related. `mongo_query` is read-only, so the deployer agent cannot drop the index itself.
