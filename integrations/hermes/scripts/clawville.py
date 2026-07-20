#!/usr/bin/env python3
"""
ClawVille → Hermes integration.

Single-file Python stdlib client that pairs Hermes with a ClawVille account,
buys + reads knowledge books, listens for "skill ready" events over SSE, and
auto-installs purchased skills as native Hermes skills under ~/.hermes/skills/.

Usage:
  python3 clawville.py pair --magic-link <URL>
  python3 clawville.py sync
  python3 clawville.py daemon              # SSE auto-install loop
  python3 clawville.py status
  python3 clawville.py shop <buildingId>
  python3 clawville.py buy <itemId>
  python3 clawville.py read <bookId>
  python3 clawville.py inventory
  python3 clawville.py chat <buildingId> <message>
  python3 clawville.py guide <message>
  python3 clawville.py visit <buildingId>
  python3 clawville.py move <x> <y>
  python3 clawville.py balance
  python3 clawville.py tool <buildingId> <toolName> --json '<input-json>'
  python3 clawville.py reconnect
  python3 clawville.py disconnect

Stdlib only. Reads/writes ~/.hermes/clawville/state.json (chmod 0600).
"""

import argparse
import http.cookiejar
import json
import os
import os.path
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get("CLAWVILLE_API", "https://api.clawville.world")
WEB = os.environ.get("CLAWVILLE_WEB", "https://clawville.world")
HERMES_HOME = os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes"))
SKILLS_DIR = os.path.join(HERMES_HOME, "skills")
STATE_DIR = os.path.join(HERMES_HOME, "clawville")
STATE_FILE = os.path.join(STATE_DIR, "state.json")
COOKIE_FILE = os.path.join(STATE_DIR, "cookies.txt")
DAEMON_LOG = os.path.join(STATE_DIR, "daemon.log")
INSTALL_AGENT_ID_FILE = os.path.join(STATE_DIR, "install-agent-id")


# ───────────────────────────────────────────────────────────────────────
# State + HTTP helpers
# ───────────────────────────────────────────────────────────────────────

def _ensure_state_dir() -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    os.makedirs(SKILLS_DIR, exist_ok=True)
    try:
        os.chmod(STATE_DIR, 0o700)
    except Exception:
        pass


def load_state() -> dict:
    if not os.path.exists(STATE_FILE):
        return {}
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state: dict) -> None:
    _ensure_state_dir()
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_FILE)
    try:
        os.chmod(STATE_FILE, 0o600)
    except Exception:
        pass


def _stable_hermes_agent_id() -> str:
    """Return one stable public agent id for this Hermes installation."""
    state_agent_id = load_state().get("agentId")
    if state_agent_id:
        return str(state_agent_id)
    configured = os.environ.get("CLAWVILLE_AGENT_ID", "").strip()
    if configured:
        if len(configured) > 200:
            die("agent_id_too_long", "CLAWVILLE_AGENT_ID must be at most 200 characters.")
        return configured

    _ensure_state_dir()
    try:
        with open(INSTALL_AGENT_ID_FILE, "r", encoding="utf-8") as f:
            persisted = f.read().strip()
        if persisted and len(persisted) <= 200:
            return persisted
    except FileNotFoundError:
        pass

    generated = f"hermes-{secrets.token_hex(16)}"
    try:
        fd = os.open(
            INSTALL_AGENT_ID_FILE,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
    except FileExistsError:
        # Another process won first-install creation. Give its exclusive writer
        # a moment to flush, then consume the one canonical install id.
        for _ in range(5):
            try:
                with open(INSTALL_AGENT_ID_FILE, "r", encoding="utf-8") as f:
                    persisted = f.read().strip()
                if persisted and len(persisted) <= 200:
                    return persisted
            except FileNotFoundError:
                pass
            time.sleep(0.01)
        die("install_agent_id_invalid", "Hermes install agent-id file is empty or invalid.")

    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(generated + "\n")
        f.flush()
        os.fsync(f.fileno())
    try:
        os.chmod(INSTALL_AGENT_ID_FILE, 0o600)
    except Exception:
        pass
    return generated


def _cookie_jar() -> http.cookiejar.MozillaCookieJar:
    _ensure_state_dir()
    jar = http.cookiejar.MozillaCookieJar(COOKIE_FILE)
    if os.path.exists(COOKIE_FILE):
        try:
            jar.load(ignore_discard=True, ignore_expires=True)
        except Exception:
            pass
    return jar


def _opener(jar: http.cookiejar.MozillaCookieJar):
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def _request(method: str, url: str, *, body=None, bearer: str = None,
             extra_headers: dict = None, allow_redirects: bool = True,
             timeout: float = 30.0):
    """Perform an HTTP request and return (status, headers, body_bytes)."""
    jar = _cookie_jar()
    opener = _opener(jar)

    data = None
    headers = {"User-Agent": "clawville-hermes-skill/0.1.0", "Accept": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if bearer:
        # Send both auth headers — `Authorization: Bearer` for endpoints that
        # consume it directly (agent-gateway domain tools), and the
        # X-Clawville-Agent-Session header for endpoints behind
        # requireAuthOrAgentSession middleware (items/buy, items/learn,
        # items/inventory, items/shop, etc).
        headers["Authorization"] = f"Bearer {bearer}"
        headers["X-Clawville-Agent-Session"] = bearer

    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with opener.open(req, timeout=timeout) as resp:
            jar.save(ignore_discard=True, ignore_expires=True)
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read()


def _request_json(method: str, path: str, body=None, bearer: str = None,
                  extra_headers: dict = None) -> dict:
    url = path if path.startswith("http") else API + path
    status, headers, raw = _request(method, url, body=body, bearer=bearer,
                                    extra_headers=extra_headers)
    text = raw.decode("utf-8", errors="replace") if raw else ""
    try:
        parsed = json.loads(text) if text else {}
    except json.JSONDecodeError:
        parsed = {"raw": text}
    return {"status": status, "headers": headers, "body": parsed}


def _bearer() -> str:
    s = load_state()
    sid = s.get("sessionId")
    if not sid:
        die("no_session", "Run `clawville.py pair --magic-link <URL>` first.")
    return sid


def die(error: str, hint: str = "", code: int = 1) -> "None":
    msg = {"error": error}
    if hint:
        msg["hint"] = hint
    sys.stderr.write(json.dumps(msg) + "\n")
    sys.exit(code)


def emit(payload) -> None:
    sys.stdout.write(json.dumps(payload, indent=2) + "\n")


# ───────────────────────────────────────────────────────────────────────
# Skill folder install
# ───────────────────────────────────────────────────────────────────────

def install_building_skill(building_id: str, skill_md: str, tools_json: list) -> str:
    """Write a per-building skill into ~/.hermes/skills/clawville-<building>/."""
    folder = os.path.join(SKILLS_DIR, f"clawville-{building_id}")
    os.makedirs(os.path.join(folder, "scripts"), exist_ok=True)

    # 1. SKILL.md — the agent's prose entrypoint
    with open(os.path.join(folder, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write(skill_md)

    # 2. tools manifest — for transparency / re-install
    with open(os.path.join(folder, "tools.json"), "w", encoding="utf-8") as f:
        json.dump(tools_json, f, indent=2)

    # 3. run.py — thin shim that points back at the master clawville.py
    # so the per-building skill can invoke domain tools without re-implementing
    # auth.
    master = os.path.abspath(__file__)
    run_py = f'''#!/usr/bin/env python3
"""Auto-generated dispatcher for clawville-{building_id}.

Calls the master clawville.py with `tool {building_id} <name> --json <json>`.
Re-installed every time the daemon receives a knowledge_added event for
this building, so the master path stays current after Hermes upgrades.
"""
import os, sys, subprocess, json

MASTER = {master!r}
BUILDING = {building_id!r}

def main():
    if len(sys.argv) < 2:
        print(json.dumps({{"error": "usage: run.py <tool_name> [json_input]"}}), file=sys.stderr)
        sys.exit(2)
    tool = sys.argv[1]
    payload = sys.argv[2] if len(sys.argv) >= 3 else "{{}}"
    proc = subprocess.run(
        [sys.executable, MASTER, "tool", BUILDING, tool, "--json", payload],
        capture_output=True, text=True,
    )
    sys.stdout.write(proc.stdout)
    sys.stderr.write(proc.stderr)
    sys.exit(proc.returncode)

if __name__ == "__main__":
    main()
'''
    run_path = os.path.join(folder, "scripts", "run.py")
    with open(run_path, "w", encoding="utf-8") as f:
        f.write(run_py)
    try:
        os.chmod(run_path, 0o755)
    except Exception:
        pass

    return folder


# ───────────────────────────────────────────────────────────────────────
# Pairing — magic link + agent connect
# ───────────────────────────────────────────────────────────────────────

def cmd_pair(args):
    """One-time pairing. Three modes:
      A) connect-token URL from the in-game "Connect Agent" modal:
         https://api.clawville.world/api/skills/connect?token=ct-xxx
         (the human-pastes-into-Hermes flow — attaches the agent to the
         human's existing avatar)
      B) magic-link URL from an existing agent session's sessionTicket:
         https://clawville.world/enter?t=sess-xxx
         (agent-already-connected, log-in-as-them flow — needs Lucia cookie)
      C) `--self` flag — direct agent self-registration with no URL, no
         human account, no avatar to create first. Server auto-mints a user
         + avatar for the agent based on its identity. This is the "open
         agent onboarding" path called out in the brand spec.
    """
    # `--self` is declared optional on the parser; treat missing attr as False.
    if getattr(args, "self", False):
        return _pair_self(args)
    url = getattr(args, "magic_link", None)
    if not url:
        die(
            "url_or_self_required",
            "Provide either --magic-link <URL> (from Connect Agent modal) or --self for direct agent registration with no human account.",
        )
    parsed = urllib.parse.urlparse(url)
    qs = urllib.parse.parse_qs(parsed.query)

    connect_token = qs.get("token", [None])[0]
    magic_ticket = qs.get("t", [None])[0]

    if connect_token and connect_token.startswith("ct-"):
        # Flow A: connect-token (Moltbook). The agent claims a pending
        # connection that the human just generated in the UI.
        conn = _request_json(
            "POST",
            "/api/agent/connect",
            body={
                "connectionToken": connect_token,
                "agentId": _stable_hermes_agent_id(),
                "identityType": "hermes",
                # Internal self-managed pull wire; not an identity type.
                "protocol": "nanoclaw",
                "name": "hermes",
            },
        )
        if conn["status"] != 200:
            die("connect_failed", json.dumps(conn["body"]))
        body = conn["body"]
        # Resolve user/avatar from the linked openclaw_bots row — the connect
        # response carries avatarId via state, but we also need the human-
        # facing email/avatarName for the success summary.
        sid = body["sessionId"]
        meta = _resolve_pair_metadata(sid, body)
        state = {
            "userId": meta["userId"],
            "avatarId": meta["avatarId"],
            "avatarName": meta["avatarName"],
            "agentId": body["agentId"],
            "sessionId": sid,
            "ownedSkills": body.get("ownedSkills", []),
            "gameTools": body.get("gameTools"),
            "identity": body.get("identity"),
            "wallet": {"address": meta["walletAddress"]} if meta["walletAddress"] else None,
            "pairedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "pairedVia": "connect-token",
        }
        save_state(state)
        sync_owned(state)
        emit({
            "ok": True,
            "avatarName": state["avatarName"],
            "agentId": body["agentId"],
            "sessionId": sid,
            "ownedSkillCount": len(body.get("ownedSkills", [])),
            "pairedVia": "connect-token",
        })
        return

    if not magic_ticket or not magic_ticket.startswith("sess-"):
        die(
            "invalid_url",
            f"Expected either ?token=ct-... (Connect Agent URL) or "
            f"?t=sess-... (magic-link URL), got: {url}",
        )

    # Flow B: magic-link → consume the session ticket via /api/auth/enter,
    # which sets the Lucia cookie. Then mint our own agent session via the
    # connect-token round-trip.
    enter = _request(
        "GET",
        f"{API}/api/auth/enter?t={urllib.parse.quote(magic_ticket)}",
        allow_redirects=False,
        timeout=15,
    )
    status = enter[0]
    if status not in (302, 303, 307, 200):
        die("magic_link_failed", f"/api/auth/enter returned {status}")

    me = _request_json("GET", "/api/auth/me")
    if me["status"] != 200:
        die("auth_check_failed", "Magic-link consumed but /api/auth/me did not authenticate.")
    user = me["body"]["user"]

    avatar = _request_json("GET", "/api/avatars/me")
    if avatar["status"] != 200:
        die("no_avatar", "Authenticated but no active avatar found. Create an avatar at clawville.world first.")
    avatar_row = avatar["body"]["avatar"]

    tok = _request_json("POST", "/api/agent/connect-token",
                        body={
                            "avatarId": avatar_row["id"],
                            "avatarName": avatar_row["name"],
                            "userId": user["id"],
                        })
    if tok["status"] != 200:
        die("connect_token_failed", json.dumps(tok["body"]))

    conn = _request_json("POST", "/api/agent/connect",
                        body={
                            "connectionToken": tok["body"]["token"],
                            "agentId": _stable_hermes_agent_id(),
                            "identityType": "hermes",
                            # Internal self-managed pull wire; not an identity type.
                            "protocol": "nanoclaw",
                            "name": "hermes",
                        })
    if conn["status"] != 200:
        die("connect_failed", json.dumps(conn["body"]))

    body = conn["body"]
    state = {
        "userId": user["id"],
        "avatarId": avatar_row["id"],
        "avatarName": avatar_row["name"],
        "agentId": body["agentId"],
        "sessionId": body["sessionId"],
        "ownedSkills": body.get("ownedSkills", []),
        "gameTools": body.get("gameTools"),
        "identity": body.get("identity"),
        "wallet": body.get("wallet"),
        "pairedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "pairedVia": "magic-link",
    }
    save_state(state)

    # Also install owned skills + game tools immediately so the user's
    # next prompt sees everything.
    sync_owned(state)

    emit({
        "ok": True,
        "avatarName": avatar_row["name"],
        "userEmail": user.get("email"),
        "agentId": body["agentId"],
        "sessionId": body["sessionId"],
        "ownedSkillCount": len(body.get("ownedSkills", [])),
        "warning_about_secrets": (
            "wallet.secretKey shown ONCE in this response — display to the user, do NOT log it. "
            "After this pairing, only wallet.address is stored."
        ) if body.get("wallet", {}).get("secretKey") else None,
    })


def _resolve_pair_metadata(sid: str, body: dict) -> dict:
    """Single round-trip resolver for the connect-token pair flow. Pulls
    avatarId/avatarName/walletAddress from /api/agent/wallet (which is bearer-
    authed on the new sessionId) and userId from the connect response's
    identity block (always present on first-time connect)."""
    wal = _request_json("GET", f"/api/agent/wallet?sessionId={urllib.parse.quote(sid)}", bearer=sid)
    wbody = wal.get("body") or {}
    ident = body.get("identity") or {}
    return {
        "userId": ident.get("userId", ""),
        "avatarId": wbody.get("avatarId", ""),
        "avatarName": wbody.get("avatarName", ""),
        "walletAddress": (wbody.get("wallet") or {}).get("address"),
    }


def cmd_status(args):
    state = load_state()
    if not state.get("sessionId"):
        emit({"connected": False, "hint": "Run `clawville.py pair --magic-link <URL>` first."})
        return
    s = _request_json("GET", f"/api/agent/session-status?agentId={urllib.parse.quote(state['agentId'])}")
    emit({
        "connected": s["body"].get("connected", False),
        "expiresAt": s["body"].get("expiresAt"),
        "lastSeenAt": s["body"].get("lastSeenAt"),
        "avatarName": state.get("avatarName"),
        "ownedSkillCount": len(state.get("ownedSkills", [])),
        "rawStatus": s["body"],
    })


def cmd_reconnect(args):
    state = load_state()
    if not state.get("identity", {}).get("secretKey"):
        die("no_identity_keypair",
            "Cannot reconnect without the identity secret saved at pair time. Run `pair` again.")
    # TODO: the signed-challenge reconnect requires ed25519 sign() — Python
    # stdlib has no ed25519. For now, surface the error so the agent does
    # `pair` again. (Future: bundle nacl shim or shell out to `openssl`.)
    die("reconnect_not_implemented",
        "Signed-challenge reconnect needs ed25519 (not in stdlib). Re-pair with a fresh magic link.")


def cmd_disconnect(args):
    die("disconnect_not_implemented",
        "Signed disconnect needs ed25519. Sessions self-expire after 24h idle.")


# ───────────────────────────────────────────────────────────────────────
# Sync — pull owned skills + game tools, write to ~/.hermes/skills/
# ───────────────────────────────────────────────────────────────────────

def sync_owned(state: dict) -> dict:
    sid = state["sessionId"]

    # Game tools — universal play-the-game capabilities, not gated.
    gt = state.get("gameTools") or {}
    game_tools_url = gt.get("toolsUrl")
    if game_tools_url:
        gt_resp = _request_json("GET", game_tools_url, bearer=sid)
        if gt_resp["status"] == 200:
            gt_dir = os.path.join(SKILLS_DIR, "clawville-play")
            os.makedirs(gt_dir, exist_ok=True)
            with open(os.path.join(gt_dir, "tools.json"), "w", encoding="utf-8") as f:
                json.dump(gt_resp["body"], f, indent=2)
        # Pull the public clawville-play SKILL.md as the entry-point skill
        play_md = _request_json("GET", "/api/skills/clawville-play/skill.md", bearer=sid)
        if play_md["status"] == 200:
            md = play_md["body"].get("raw") if isinstance(play_md["body"], dict) else play_md["body"]
            if isinstance(md, str):
                gt_dir = os.path.join(SKILLS_DIR, "clawville-play")
                os.makedirs(gt_dir, exist_ok=True)
                with open(os.path.join(gt_dir, "SKILL.md"), "w", encoding="utf-8") as f:
                    f.write(md)

    # Re-pull the latest owned-skills snapshot from the server (the
    # connect-time list might be stale if the user bought from another
    # machine since).
    owned = _request_json("GET", f"/api/agent/{sid}/owned-skills", bearer=sid)
    if owned["status"] == 200:
        state["ownedSkills"] = owned["body"].get("ownedSkills", [])
        save_state(state)

    installed = []
    for s in state.get("ownedSkills", []):
        skill_md = fetch_skill_md(sid, s["skillUrl"])
        tools_json = fetch_tools_json(sid, s["toolsUrl"])
        if skill_md is None or tools_json is None:
            continue
        folder = install_building_skill(s["buildingId"], skill_md, tools_json)
        installed.append({"buildingId": s["buildingId"], "folder": folder, "toolCount": len(tools_json)})

    return {"installed": installed, "ownedCount": len(state.get("ownedSkills", []))}


def fetch_skill_md(sid: str, url: str):
    resp = _request("GET", API + url, bearer=sid)
    status, _, raw = resp
    if status != 200:
        return None
    return raw.decode("utf-8", errors="replace")


def fetch_tools_json(sid: str, url: str):
    resp = _request_json("GET", url, bearer=sid)
    if resp["status"] != 200:
        return None
    return resp["body"]


def cmd_sync(args):
    state = load_state()
    if not state.get("sessionId"):
        die("no_session", "Run `clawville.py pair --magic-link <URL>` first.")
    result = sync_owned(state)
    emit({"ok": True, **result})


# ───────────────────────────────────────────────────────────────────────
# Daemon — SSE listener that auto-installs new buys
# ───────────────────────────────────────────────────────────────────────

def cmd_daemon(args):
    state = load_state()
    if not state.get("sessionId"):
        die("no_session", "Run `clawville.py pair --magic-link <URL>` first.")
    sid = state["sessionId"]

    sys.stderr.write(f"[clawville daemon] watching events for session {sid[:18]}...\n")
    sys.stderr.flush()

    backoff = 2.0
    while True:
        try:
            consume_sse(sid)
            backoff = 2.0
        except KeyboardInterrupt:
            sys.stderr.write("[clawville daemon] interrupted.\n")
            return
        except Exception as e:
            sys.stderr.write(f"[clawville daemon] stream error: {e!r}; reconnecting in {backoff:.0f}s\n")
            sys.stderr.flush()
            time.sleep(backoff)
            backoff = min(backoff * 2, 60.0)


def consume_sse(sid: str):
    """Block on the SSE stream and process knowledge_added events as they arrive."""
    url = f"{API}/api/agent/{sid}/events"
    req = urllib.request.Request(url, headers={
        "User-Agent": "clawville-hermes-daemon/0.1.0",
        "Accept": "text/event-stream",
        "Authorization": f"Bearer {sid}",
        "Cache-Control": "no-cache",
    })
    with urllib.request.urlopen(req, timeout=None) as resp:
        if resp.status != 200:
            raise RuntimeError(f"SSE handshake failed: {resp.status}")
        event = None
        data_lines = []
        for raw in resp:
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if not line:  # blank line dispatches the event
                if event and data_lines:
                    handle_sse_event(sid, event, "\n".join(data_lines))
                event = None
                data_lines = []
                continue
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
            # Ignore comments/keepalives starting with `:`


def handle_sse_event(sid: str, event: str, data: str):
    if event != "knowledge_added":
        return
    try:
        payload = json.loads(data)
    except json.JSONDecodeError:
        return

    building_id = payload.get("buildingId")
    if not building_id:
        return

    skill_md = fetch_skill_md(sid, payload["skillUrl"])
    tools_json = fetch_tools_json(sid, payload["toolsUrl"])
    if skill_md is None or tools_json is None:
        sys.stderr.write(f"[clawville daemon] failed to fetch skill/tools for {building_id}\n")
        return

    folder = install_building_skill(building_id, skill_md, tools_json)
    sys.stderr.write(
        f"[clawville daemon] INSTALLED {payload.get('skillName', 'clawville-' + building_id)} "
        f"({len(tools_json)} tools) → {folder}\n"
    )
    sys.stderr.flush()

    # Update local state so `status` reflects the new ownership immediately.
    state = load_state()
    owned = state.get("ownedSkills") or []
    if not any(s.get("buildingId") == building_id for s in owned):
        owned.append({
            "buildingId": building_id,
            "skillName": payload.get("skillName", f"clawville-{building_id}"),
            "suggestedFilename": payload.get("suggestedFilename", f"clawville-{building_id}.md"),
            "skillUrl": payload["skillUrl"],
            "toolsUrl": payload["toolsUrl"],
            "toolsFilename": payload.get("toolsFilename", f"clawville-{building_id}.tools.json"),
        })
        state["ownedSkills"] = owned
        save_state(state)

    # Hermes auto-rescans ~/.hermes/skills/ at next prompt; nothing else to do.


# ───────────────────────────────────────────────────────────────────────
# Game-action subcommands (wrap existing endpoints)
# ───────────────────────────────────────────────────────────────────────

def cmd_shop(args):
    sid = _bearer()
    r = _request_json("GET", f"/api/items/shop/{urllib.parse.quote(args.building_id)}", bearer=sid)
    emit(r["body"])


def cmd_buy(args):
    sid = _bearer()
    r = _request_json("POST", "/api/items/buy", bearer=sid, body={"itemId": args.item_id})
    emit(r["body"])


def cmd_read(args):
    sid = _bearer()
    r = _request_json("POST", "/api/items/learn", bearer=sid, body={"bookId": args.book_id})
    emit(r["body"])


def cmd_inventory(args):
    sid = _bearer()
    r = _request_json("GET", "/api/items/inventory", bearer=sid)
    emit(r["body"])


def cmd_balance(args):
    """Balance + XP + level. /api/avatars/me is Lucia-only (browser path),
    so we compose from two bearer-authed agent endpoints instead:
      - /api/agent/wallet?sessionId=X  → balances.clawTokens + walletAddress
      - /api/agent/:sid/stats          → xp, level, kills, knowledgeLearned[]"""
    sid = _bearer()
    wallet = _request_json("GET", f"/api/agent/wallet?sessionId={urllib.parse.quote(sid)}", bearer=sid)
    stats = _request_json("GET", f"/api/agent/{sid}/stats", bearer=sid)
    wb = wallet.get("body") or {}
    sb = stats.get("body") or {}
    emit({
        "avatarName": wb.get("avatarName"),
        "avatarId": wb.get("avatarId"),
        "walletAddress": (wb.get("wallet") or {}).get("address"),
        "clawTokens": (wb.get("balances") or {}).get("clawTokens"),
        "level": sb.get("level"),
        "xp": sb.get("xp"),
        "knowledgeLearnedCount": len(sb.get("knowledgeLearned") or []) if isinstance(sb.get("knowledgeLearned"), list) else None,
        "totalMessages": sb.get("totalMessages"),
    })


def cmd_chat(args):
    """Chat with a building teacher via the agent-side endpoint (Bearer-authed,
    no Lucia cookie required). The /api/chat/:id/chat alternate path requires
    a Lucia session — that's the human's browser path, not ours."""
    sid = _bearer()
    r = _request_json(
        "POST",
        f"/api/agent/{sid}/building/{urllib.parse.quote(args.building_id)}/chat",
        bearer=sid,
        body={"message": args.message},
    )
    emit(r["body"])


def cmd_guide(args):
    """Chat with Nori. Note: the system-agent route is currently Lucia-only
    server-side, so this command requires a magic-link-paired session
    (which carries cookies) rather than a connect-token-paired one. For
    Hermes-style flows, talk to building teachers via `chat` instead until
    the system-agent route gains Bearer auth."""
    sid = _bearer()
    r = _request_json("POST", "/api/chat/system/town-guide", bearer=sid,
                      body={"content": args.message})
    emit(r["body"])


def cmd_visit(args):
    sid = _bearer()
    r = _request_json("POST", f"/api/agent/{sid}/visit-building", bearer=sid,
                      body={"buildingId": args.building_id})
    emit(r["body"])


def cmd_move(args):
    sid = _bearer()
    r = _request_json("POST", f"/api/agent/{sid}/move", bearer=sid,
                      body={"targetX": int(args.x), "targetY": int(args.y)})
    emit(r["body"])


def cmd_tool(args):
    sid = _bearer()
    try:
        payload = json.loads(args.json) if args.json else {}
    except json.JSONDecodeError as e:
        die("invalid_json_input", str(e))
    path = f"/api/agent/{sid}/skills/{urllib.parse.quote(args.building_id)}/tools/{urllib.parse.quote(args.tool_name)}"
    r = _request_json("POST", path, bearer=sid, body=payload)
    if r["status"] == 200 and isinstance(r["body"], dict):
        emit(r["body"])
    else:
        emit({"status": r["status"], "body": r["body"]})
        sys.exit(2 if r["status"] >= 400 else 0)


# ───────────────────────────────────────────────────────────────────────
# Argparse wiring
# ───────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(prog="clawville", description="ClawVille → Hermes integration")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("pair", help="One-time pairing via Connect Agent URL.")
    p.add_argument("--magic-link", required=False, help="Connect URL from the in-game modal (Moltbook flow) — https://api.clawville.world/api/skills/connect?token=ct-... OR magic-link https://clawville.world/enter?t=sess-...")
    p.add_argument("--self", action="store_true", help="Direct agent self-registration — no URL, no human account, server auto-mints user+avatar.")
    p.set_defaults(func=cmd_pair)

    p = sub.add_parser("status", help="Show current session + ownership.")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("sync", help="Re-pull owned skills + game tools, write to ~/.hermes/skills/.")
    p.set_defaults(func=cmd_sync)

    p = sub.add_parser("daemon", help="Background SSE listener — auto-installs purchased skills.")
    p.set_defaults(func=cmd_daemon)

    p = sub.add_parser("shop", help="List books at a building.")
    p.add_argument("building_id")
    p.set_defaults(func=cmd_shop)

    p = sub.add_parser("buy", help="Buy a book.")
    p.add_argument("item_id")
    p.set_defaults(func=cmd_buy)

    p = sub.add_parser("read", help="Read a book — triggers auto-install if daemon is running.")
    p.add_argument("book_id")
    p.set_defaults(func=cmd_read)

    p = sub.add_parser("inventory", help="List bought-but-unread books.")
    p.set_defaults(func=cmd_inventory)

    p = sub.add_parser("chat", help="Chat with a building teacher.")
    p.add_argument("building_id")
    p.add_argument("message")
    p.set_defaults(func=cmd_chat)

    p = sub.add_parser("guide", help="Chat with Nori the Town Guide.")
    p.add_argument("message")
    p.set_defaults(func=cmd_guide)

    p = sub.add_parser("visit", help="Move + enter a building.")
    p.add_argument("building_id")
    p.set_defaults(func=cmd_visit)

    p = sub.add_parser("move", help="Move agent to (x, y) world coords.")
    p.add_argument("x", type=int)
    p.add_argument("y", type=int)
    p.set_defaults(func=cmd_move)

    p = sub.add_parser("balance", help="Avatar balance + xp + level + knowledge count.")
    p.set_defaults(func=cmd_balance)

    p = sub.add_parser("tool", help="Invoke a building's domain tool.")
    p.add_argument("building_id")
    p.add_argument("tool_name")
    p.add_argument("--json", default="{}", help="JSON input for the tool (default: {}).")
    p.set_defaults(func=cmd_tool)

    p = sub.add_parser("reconnect", help="Re-establish session via signed challenge.")
    p.set_defaults(func=cmd_reconnect)

    p = sub.add_parser("disconnect", help="Clean shutdown via signed nonce.")
    p.set_defaults(func=cmd_disconnect)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
