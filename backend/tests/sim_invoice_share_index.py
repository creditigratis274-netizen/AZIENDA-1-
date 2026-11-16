# Simulates prod index states for invoice_share_once on throwaway DB tmp_prod_idx_sim
import asyncio, logging, sys
sys.path.insert(0, "/app/backend")
from dotenv import load_dotenv
load_dotenv("/app/backend/.env")
import server
from motor.motor_asyncio import AsyncIOMotorClient

logging.basicConfig(level=logging.WARNING)
DB = "tmp_prod_idx_sim"


async def run_case(name, setup):
    client = AsyncIOMotorClient("mongodb://localhost:27017")
    coll = client[DB].invoice_share_links
    await coll.drop()
    await setup(coll)
    before = await coll.index_information()
    try:
        await server.create_company_unique_index(coll, "invoice_id", unique=True, name="invoice_share_once")
        res = "NO EXCEPTION"
    except Exception as e:
        res = f"EXCEPTION {type(e).__name__}: {e}"
    after = await coll.index_information()
    fmt = lambda d: {k: (v["key"], v.get("unique")) for k, v in d.items()}
    print(f"[{name}] {res}\n  before={fmt(before)}\n  after ={fmt(after)}")


async def main():
    async def prod(c):
        await c.create_index([("company_id", 1), ("invoice_id", 1)], unique=True, name="invoice_share_once")

    async def legacy(c):
        await c.create_index([("invoice_id", 1)], unique=True, name="invoice_share_once")
        # legacy unique on invoice_id prevents two docs with same invoice_id; insert distinct then attempt dup
        await c.insert_one({"invoice_id": "INV1", "company_id": "A"})
        try:
            await c.insert_one({"invoice_id": "INV1", "company_id": "B"})
            print("  (legacy) second doc inserted")
        except Exception as e:
            print(f"  (legacy) second doc rejected by legacy index as expected: {type(e).__name__}")

    async def legacy_then_dup(c):
        await c.insert_many([{"invoice_id": "INV1", "company_id": "A"}, {"invoice_id": "INV1", "company_id": "B"}])
        await c.create_index([("invoice_id", 1)], name="invoice_share_once")  # non-unique legacy w/ dup data

    async def conflict(c):
        await c.create_index([("token_hash", 1)], name="invoice_share_once")

    async def conflict_unique(c):
        await c.create_index([("token_hash", 1)], unique=True, name="invoice_share_once")

    await run_case("1 prod state", prod)
    await run_case("2 legacy unique {invoice_id}", legacy)
    await run_case("2b legacy non-unique {invoice_id} + dup docs", legacy_then_dup)
    await run_case("3 conflict {token_hash} non-unique", conflict)
    await run_case("3b conflict {token_hash} unique", conflict_unique)
    # Case 2 after: verify two companies can share invoice_id
    client = AsyncIOMotorClient("mongodb://localhost:27017")
    c = client[DB].invoice_share_links
    await c.drop()
    await legacy(c)
    await server.create_company_unique_index(c, "invoice_id", unique=True, name="invoice_share_once")
    await c.insert_one({"invoice_id": "INV1", "company_id": "B"})
    print("[2 post] same invoice_id different company inserted OK; count=", await c.count_documents({}))
    await client.drop_database(DB)
    print("dbs contain tmp:", DB in await client.list_database_names())


asyncio.run(main())
