# Functional check of migrate_legacy_company_collection / migrate_legacy_company_databases using throwaway DBs only
import asyncio
import logging
import os
import sys
from dotenv import load_dotenv

sys.path.insert(0, "/app/backend")
load_dotenv("/app/backend/.env")
import server  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

CID = "iqfoam-manufactoring"
results = []


def check(name, cond, info=""):
    results.append(cond)
    print(("PASS " if cond else "FAIL ") + name, info)


async def batch_test(client):
    src_db, tgt_db = client["tmp_mig_src"], client["tmp_mig_tgt"]
    await client.drop_database("tmp_mig_src")
    await client.drop_database("tmp_mig_tgt")
    try:
        tgt = tgt_db["attendance"]
        await tgt.create_index([("company_id", 1), ("employee_id", 1), ("date", 1)], unique=True)
        await tgt.insert_one({"id": "a-0", "company_id": CID, "employee_id": "E0", "date": "2026-01-00"})
        docs = []
        for i in range(1200):
            docs.append({"id": f"a-{i}", "employee_id": f"E{i}", "date": "2026-01-00" if i < 1 else f"2026-01-{i}"})
        # 10 docs violating unique index (same employee/date as an earlier doc, new id)
        for i in range(1, 11):
            docs.append({"id": f"dup-{i}", "employee_id": f"E{i}", "date": f"2026-01-{i}"})
        # duplicate id within source
        docs.append({"id": "a-5", "employee_id": "EX", "date": "x"})
        await src_db["attendance"].insert_many(docs)
        src_before = await src_db["attendance"].count_documents({})
        s1 = await server.migrate_legacy_company_collection(src_db["attendance"], tgt, CID)
        print("run1", s1)
        # a-0 existing, a-5 dup existing; 1199 inserted; 10 conflicts
        check("run1 inserted 1199", s1["inserted"] == 1199, s1)
        check("run1 conflicts 10", s1["conflicts"] == 10, s1)
        check("run1 existing 2", s1["existing"] == 2, s1)
        check("target count 1200", await tgt.count_documents({"company_id": CID}) == 1200)
        s2 = await server.migrate_legacy_company_collection(src_db["attendance"], tgt, CID)
        print("run2", s2)
        check("run2 inserted 0", s2["inserted"] == 0, s2)
        check("source unchanged", await src_db["attendance"].count_documents({}) == src_before)
        # counters without id + docs without id
        await src_db["counters"].insert_many([{"_id": "invoice-sequence-2026", "seq": 7}])
        await src_db["misc"].insert_many([{"name": "noid1"}, {"name": "noid2"}])
        c1 = await server.migrate_legacy_company_collection(src_db["counters"], tgt_db["counters"], CID)
        c2 = await server.migrate_legacy_company_collection(src_db["counters"], tgt_db["counters"], CID)
        doc = await tgt_db["counters"].find_one({"_id": f"{CID}:invoice-sequence-2026"})
        check("counter namespaced", doc is not None and doc["seq"] == 7 and doc["company_id"] == CID, (c1, c2))
        check("counter idempotent", c2["inserted"] == 0 and c2["existing"] == 1)
        m1 = await server.migrate_legacy_company_collection(src_db["misc"], tgt_db["misc"], CID)
        m2 = await server.migrate_legacy_company_collection(src_db["misc"], tgt_db["misc"], CID)
        check("no-id docs idempotent", m1["inserted"] == 2 and m2["inserted"] == 0, (m1, m2))
    finally:
        await client.drop_database("tmp_mig_src")
        await client.drop_database("tmp_mig_tgt")


async def failing_collection_test(client):
    # Point server.base_db at throwaway DB whose name maps to throwaway legacy DBs
    main_name = "tmp_mig_main"
    for n in [main_name, f"{main_name}__iqfoam-manufactoring", f"{main_name}__iqfoam-whole-sallers"]:
        await client.drop_database(n)
    orig_base, orig_fn = server.base_db, server.migrate_legacy_company_collection
    try:
        main = client[main_name]
        for cid in server.LEGACY_COMPANY_DATABASES:
            ldb = client[f"{main_name}__{cid}"]
            for coll in ["aaa_fail", "attendance", "invoices"]:
                await ldb[coll].insert_one({"id": f"{cid}-{coll}-1"})
        server.base_db = main

        async def flaky(source, target, company_id):
            if source.name == "aaa_fail":
                raise RuntimeError("simulated failure")
            return await orig_fn(source, target, company_id)

        server.migrate_legacy_company_collection = flaky
        await server.migrate_legacy_company_databases()
        for cid in server.LEGACY_COMPANY_DATABASES:
            m = await main.legacy_migrations.find_one({"company_id": cid})
            ok = m and "error" in m["collections"]["aaa_fail"] and m["collections"]["attendance"]["inserted"] == 1 \
                and m["collections"]["invoices"]["inserted"] == 1
            check(f"failing coll isolated for {cid}", bool(ok), m and m["collections"])
        check("one marker per source", await main.legacy_migrations.count_documents({}) == 2)
    finally:
        server.base_db, server.migrate_legacy_company_collection = orig_base, orig_fn
        for n in [main_name, f"{main_name}__iqfoam-manufactoring", f"{main_name}__iqfoam-whole-sallers"]:
            await client.drop_database(n)


async def main():
    logging.basicConfig(level=logging.ERROR)
    client = server.client
    await batch_test(client)
    await failing_collection_test(client)
    print(f"RESULT {sum(results)}/{len(results)} passed")


asyncio.run(main())
