# Read-only check of legacy per-company DB migration into main DB (snapshot / verify)
import json
import os
import sys
from pymongo import MongoClient

MAIN = "test_database"
LEGACY = ["iqfoam-whole-sallers", "iqfoam-manufactoring"]
SKIP = {"users", "companies", "user_sessions", "user_devices", "company_admin_counts",
        "login_attempts", "backup_locks", "backup_operations", "legacy_migrations"}
COLLS = ["invoices", "customers", "payments", "counters", "stock", "expenses", "audit_log"]
c = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
main = c[MAIN]


def snapshot():
    snap = {"main": {}, "legacy": {}, "super_counters": {}}
    for coll in COLLS:
        for cid in ["superiqfoam"] + LEGACY:
            snap["main"][f"{coll}:{cid}"] = main[coll].count_documents({"company_id": cid})
    for cid in LEGACY:
        ldb = c[f"{MAIN}__{cid}"]
        snap["legacy"][cid] = {n: ldb[n].count_documents({}) for n in ldb.list_collection_names()}
    for _id in ["invoice-sequence-2026", "express-invoice-sequence-2026"]:
        d = main.counters.find_one({"_id": _id})
        snap["super_counters"][_id] = d and {"seq": d.get("seq"), "company_id": d.get("company_id")}
    return snap


def verify_copies():
    missing = {}
    for cid in LEGACY:
        ldb = c[f"{MAIN}__{cid}"]
        for n in ldb.list_collection_names():
            if n.startswith("system.") or n in SKIP:
                continue
            for d in ldb[n].find({"id": {"$exists": True, "$ne": None}}, {"id": 1}):
                if not main[n].find_one({"company_id": cid, "id": d["id"]}, {"_id": 1}):
                    missing.setdefault(f"{cid}.{n}", []).append(d["id"])
            if n == "counters":
                for d in ldb[n].find({"id": {"$exists": False}}):
                    m = main.counters.find_one({"_id": f"{cid}:{d['_id']}"})
                    if not m or m.get("company_id") != cid:
                        missing.setdefault(f"{cid}.counters(_id)", []).append(str(d["_id"]))
                    else:
                        print(f"counter {cid}:{d['_id']} legacy seq={d.get('seq')} main seq={m.get('seq')}")
    return missing


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "snap":
        json.dump(snapshot(), open(sys.argv[2], "w"), indent=1, default=str)
    elif mode == "verify":
        miss = verify_copies()
        print("MISSING:", {k: (len(v), v[:5]) for k, v in miss.items()} or "none")
        for m in main.legacy_migrations.find({}, {"_id": 0}).sort("ran_at", -1).limit(2):
            ins = {k: v["inserted"] for k, v in m["collections"].items() if v["inserted"]}
            conf = {k: v["conflicts"] for k, v in m["collections"].items() if v["conflicts"]}
            print(m["company_id"], m["ran_at"], "inserted:", ins or 0, "conflicts:", conf)
    elif mode == "diff":
        a, b = json.load(open(sys.argv[2])), json.load(open(sys.argv[3]))
        for k in a:
            print(k, "IDENTICAL" if a[k] == b[k] else f"DIFF {a[k]} vs {b[k]}")
        print("super_counters:", b["super_counters"])
