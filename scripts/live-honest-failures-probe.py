import json, sys, urllib.request, urllib.error

BASE = "http://127.0.0.1:47731"
H = {"Authorization": "Bearer development-local-only", "Content-Type": "application/json"}

def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers=H, method="POST")
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.status, json.loads(r.read().decode())

def log(*a):
    print(*a, flush=True)

s, st = post("/agent/sessions", {
    "goal": "Осмотри окно CorelDRAW и одним предложением опиши, что сейчас на экране.",
    "mode": "autonomous",
    "windowHandle": 590866,
})
sid = st["sessionId"]
log("SESSION", sid, "status", st.get("state", {}).get("status"))

for turn in range(1, 9):
    try:
        code, resp = post("/agent/sessions/next", {"sessionId": sid})
    except urllib.error.HTTPError as e:
        log(f"turn {turn}: HTTP {e.code} {e.read().decode()[:300]}")
        break
    kind = resp.get("kind")
    dec = resp.get("decision") or {}
    res = resp.get("results") or [{}]
    r0 = res[0] if res else {}
    state = resp.get("state") or {}
    log(f"turn {turn}: kind={kind} tool={dec.get('tool')} args={json.dumps(dec.get('arguments'), ensure_ascii=False)} "
        f"r0.status={r0.get('status')} err={(r0.get('error') or {}).get('message')} state={state.get('status')}")
    tr = state.get("terminalReason")
    if tr:
        log("   terminalReason:", tr)
    if kind in ("final", "terminal", "cancelled", "user_question"):
        break

log("DONE", sid)
