"""Measure a Supabase project's live database egress rate (read-only).

Scrapes the project's Prometheus endpoint twice (node_network_transmit_bytes_total on
ens5 matched the invoice's egress within 1% on 2026-09-25) and diffs pg_stat_statements
to name the queries that returned the most rows in the window.

Usage: SUPABASE_ACCESS_TOKEN=... python supabase-egress-probe.py [seconds=300] [project_ref]
Never prints secrets: the service_role key is fetched through the Management API and used
only for the Basic-auth metrics request.
"""
import json, os, re, sys, time, urllib.request, base64

REF = sys.argv[2] if len(sys.argv) > 2 else "wheuidgiyyccqyoppxoa"  # ClawVille prod
TOK = os.environ["SUPABASE_ACCESS_TOKEN"]
WAIT = int(sys.argv[1]) if len(sys.argv) > 1 else 300


def mgmt(path, body=None):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {TOK}", "Content-Type": "application/json",
                 "User-Agent": "egress-audit/1.0"},
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


keys = mgmt("/api-keys?reveal=true")
srk = next(k["api_key"] for k in keys if k["name"] == "service_role")
auth = base64.b64encode(f"service_role:{srk}".encode()).decode()


def metrics():
    req = urllib.request.Request(
        f"https://{REF}.supabase.co/customer/v1/privileged/metrics",
        headers={"Authorization": f"Basic {auth}", "User-Agent": "egress-audit/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode()


def net(text):
    out = {}
    for line in text.splitlines():
        m = re.match(r'^(node_network_(?:transmit|receive)_bytes_total)\{([^}]*)\}\s+([0-9.e+]+)', line)
        if m:
            dev = re.search(r'device="([^"]+)"', m.group(2)).group(1)
            out[(m.group(1), dev)] = float(m.group(3))
    return out


PSS = """select queryid::text as id, calls, rows,
 left(regexp_replace(query,'\\s+',' ','g'), 160) as q
from pg_stat_statements"""


def pss():
    return {r["id"]: r for r in mgmt("/database/query", {"query": PSS})}


m1 = metrics()
names = sorted({l.split("{")[0].split(" ")[0] for l in m1.splitlines() if l and not l.startswith("#")})
print("metric families:", len(names))
n1, p1, t1 = net(m1), pss(), time.time()
print(f"sleeping {WAIT}s ...", flush=True)
time.sleep(WAIT)
m2 = metrics()
n2, p2, t2 = net(m2), pss(), time.time()
dt = t2 - t1
print(f"\nwindow {dt:.0f}s")
for k in sorted(n2):
    if k in n1:
        rate = (n2[k] - n1[k]) / dt
        print(f"{k[0]:<38} {k[1]:<10} {rate/1e6:8.3f} MB/s  -> {rate*86400*30/1e9:8.1f} GB / 30d")

rows = []
for qid, r in p2.items():
    o = p1.get(qid, {"calls": 0, "rows": 0})
    dc, dr = r["calls"] - o["calls"], r["rows"] - o["rows"]
    if dc or dr:
        rows.append((dr, dc, r["q"]))
rows.sort(reverse=True)
print("\ntop queries by rows returned in window (rows/day projection):")
for dr, dc, q in rows[:25]:
    print(f"{dr:>9} rows {dc:>7} calls  {dr/dt*86400:>12.0f} rows/day  {q}")
