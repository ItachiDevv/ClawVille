#!/usr/bin/env python3
"""
ClawVille → Hermes integration.

Single-file Python stdlib client that pairs Hermes with a ClawVille account,
buys + reads knowledge books, listens for "skill ready" events over SSE, and
auto-installs purchased skills as native Hermes skills under ~/.hermes/skills/.

Usage:
  python3 clawville.py pair --magic-link <URL>
  python3 clawville.py pair --self          # direct self-registration, no human account
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
Every command prints exactly one JSON document to stdout.
A first-connect wallet.secretKey is printed once to stdout for the human and
is never written to state.json or any other file. identity.secretKey is the
agent's own credential: it is saved once and signs `reconnect`.
"""

import argparse
import hashlib
import http.cookiejar
import json
import os
import os.path
import secrets
import stat
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


def _read_state_file() -> dict:
    if not os.path.exists(STATE_FILE):
        return {}
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            state = json.load(f)
    except Exception:
        return {}
    return state if isinstance(state, dict) else {}


def load_state() -> dict:
    state = _read_state_file()
    _note_legacy_wallet_secret(state)
    return state


def save_state(state: dict) -> None:
    _ensure_state_dir()
    state = _keep_unshown_legacy_secret(state)
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
    """Print the one JSON result document of this run. An unshown legacy
    wallet secret rides along in it once (never into a file), then leaves
    state.json."""
    global _legacy_recovery
    shown = None
    if _legacy_recovery and isinstance(payload, dict):
        payload = dict(payload)
        if _stdout_is_file():
            payload["legacyWalletNotice"] = LEGACY_WALLET_SECRET_PENDING
        else:
            shown = _legacy_recovery
            payload["legacyWalletNotice"] = LEGACY_WALLET_SECRET_NOTICE
            payload["legacyWalletRecovery"] = _wallet_recovery(shown["address"], shown["secretKey"])
    sys.stdout.write(json.dumps(payload, indent=2) + "\n")
    if shown:
        # Print before the save: if the save fails, the next run shows it again,
        # which is better than removing the only copy before the human sees it.
        sys.stdout.flush()
        _legacy_shown.add(shown["secretKey"])
        _legacy_recovery = None
        save_state(_read_state_file())


# ───────────────────────────────────────────────────────────────────────
# One-time wallet secret (Phase 5.1): relay once to the human, never store
# ───────────────────────────────────────────────────────────────────────

WALLET_SECRET_MESSAGE = (
    "SAVE THIS NOW. This is the secret key of your ClawVille avatar wallet "
    "(your self-custody backup). It is shown once and is not stored: this "
    "script does not save it, and ClawVille cannot show it again."
)
WALLET_SECRET_RELAY = (
    "Show address, secretKey and message to your human one time, now. "
    "Do not save secretKey in a file or in agent config. Do not log it."
)
LEGACY_WALLET_SECRET_NOTICE = (
    "An older version of this script saved your wallet secret key in "
    "state.json. This is the last time it is shown: the script removes it "
    "from state.json right after this output."
)
LEGACY_WALLET_SECRET_PENDING = (
    "An older version of this script saved your wallet secret key in "
    "state.json. It is not shown here because stdout is a file, so it stays "
    "in state.json. Run `clawville.py status` with stdout on a terminal or "
    "pipe to show it once; the script then removes it."
)
# state.json key that keeps an unshown legacy wallet secret when a new pair
# replaces the old `wallet` object.
LEGACY_WALLET_KEY = "legacyWallet"

# A first-connect wallet.secretKey, held in memory only until it is printed
# once. It is never written to state.json or to any other file.
_pending_wallet_recovery = None
# An older wallet secret found in state.json and not shown yet in this run.
_legacy_recovery = None
# Older wallet secrets shown in this run. save_state removes them from state.json.
_legacy_shown = set()


def _stdout_is_file() -> bool:
    """True when stdout goes to a regular file (the documented
    `daemon > daemon.log`). A wallet secret must never go into a file."""
    try:
        return stat.S_ISREG(os.fstat(sys.stdout.fileno()).st_mode)
    except (AttributeError, OSError, ValueError):
        return False


def _wallet_recovery(address, secret_key: str) -> dict:
    return {
        "message": WALLET_SECRET_MESSAGE,
        "relay": WALLET_SECRET_RELAY,
        "address": address,
        "secretKey": secret_key,
    }


def _take_wallet_secret(body: dict) -> None:
    """Remove a first-connect wallet.secretKey from the connect response and
    hold it in memory, so no later step can save it. `_emit_pair_result`
    prints it once."""
    global _pending_wallet_recovery
    wallet = body.get("wallet")
    if isinstance(wallet, dict) and wallet.get("secretKey"):
        secret_key = wallet.pop("secretKey")
        _pending_wallet_recovery = _wallet_recovery(
            wallet.get("address") or body.get("walletAddress"), secret_key
        )


def _emit_pair_result(summary: dict) -> None:
    """Emit the pair result, with the held wallet secret attached one time."""
    global _pending_wallet_recovery
    if _pending_wallet_recovery:
        summary["walletRecovery"] = _pending_wallet_recovery
    emit(summary)
    _pending_wallet_recovery = None


def _find_legacy_wallet_secret(state: dict):
    """Older magic-link pairs saved the whole connect `wallet` object, secret
    included, in state.json and never showed the secret to the human. Return
    the first such secret that this run has not shown, or None."""
    for key in ("wallet", LEGACY_WALLET_KEY):
        wallet = state.get(key)
        if (isinstance(wallet, dict) and wallet.get("secretKey")
                and wallet["secretKey"] not in _legacy_shown):
            return {"address": wallet.get("address"), "secretKey": wallet["secretKey"]}
    return None


def _note_legacy_wallet_secret(state: dict) -> None:
    """Hold an unshown legacy secret; `emit` shows it once in the one result
    document of this run, and only when stdout is not a regular file."""
    global _legacy_recovery
    found = _find_legacy_wallet_secret(state)
    if found:
        _legacy_recovery = found


def _keep_unshown_legacy_secret(state: dict) -> dict:
    """Return the dict to write. A legacy secret shown in this run is removed.
    An unshown one stays in state.json, also when a new pair replaces `wallet`,
    so it is never lost before the human sees it."""
    out = dict(state)
    for key in ("wallet", LEGACY_WALLET_KEY):
        wallet = out.get(key)
        if isinstance(wallet, dict) and wallet.get("secretKey") in _legacy_shown:
            if key == "wallet":
                out[key] = {k: v for k, v in wallet.items() if k != "secretKey"}
            else:
                out.pop(key)
    unshown = _find_legacy_wallet_secret(_read_state_file()) or _legacy_recovery
    held = {w.get("secretKey") for w in (out.get("wallet"), out.get(LEGACY_WALLET_KEY))
            if isinstance(w, dict)}
    if unshown and unshown["secretKey"] not in held:
        out[LEGACY_WALLET_KEY] = dict(unshown)
    return out


# ───────────────────────────────────────────────────────────────────────
# Identity key (agent's own credential): ed25519 (RFC 8032) + base58
# ───────────────────────────────────────────────────────────────────────
# Stdlib only. The server verifies with tweetnacl `nacl.sign.detached.verify`
# over `bs58.decode(nonce)` against users.identity_pubkey. This follows the
# RFC 8032 section 6 reference code; it is not constant-time, and it only signs
# a one-time server nonce on the agent's own machine.

_ED_P = 2 ** 255 - 19
_ED_L = 2 ** 252 + 27742317777372353535851937790883648493
_ED_D = -121665 * pow(121666, _ED_P - 2, _ED_P) % _ED_P
_ED_GX = 15112221349535400772501151409588531511454012693041857206046113283949847762202
_ED_GY = 4 * pow(5, _ED_P - 2, _ED_P) % _ED_P
_ED_G = (_ED_GX, _ED_GY, 1, _ED_GX * _ED_GY % _ED_P)
_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _ed_add(p1, p2):
    """Point addition in extended coordinates (RFC 8032 section 6)."""
    x1, y1, z1, t1 = p1
    x2, y2, z2, t2 = p2
    a = (y1 - x1) * (y2 - x2) % _ED_P
    b = (y1 + x1) * (y2 + x2) % _ED_P
    c = 2 * t1 * t2 * _ED_D % _ED_P
    d = 2 * z1 * z2 % _ED_P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % _ED_P, g * h % _ED_P, f * g % _ED_P, e * h % _ED_P)


def _ed_mul(scalar: int, point):
    result = (0, 1, 1, 0)
    while scalar:
        if scalar & 1:
            result = _ed_add(result, point)
        point = _ed_add(point, point)
        scalar >>= 1
    return result


def _ed_compress(point) -> bytes:
    x, y, z, _ = point
    z_inv = pow(z, _ED_P - 2, _ED_P)
    x, y = x * z_inv % _ED_P, y * z_inv % _ED_P
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def _ed_expand(seed: bytes):
    digest = hashlib.sha512(seed).digest()
    scalar = int.from_bytes(digest[:32], "little")
    scalar &= (1 << 254) - 8
    scalar |= 1 << 254
    return scalar, digest[32:]


def _ed25519_public_key(seed: bytes) -> bytes:
    scalar, _ = _ed_expand(seed)
    return _ed_compress(_ed_mul(scalar, _ED_G))


def _ed25519_sign(seed: bytes, message: bytes) -> bytes:
    """Detached ed25519 signature (64 bytes) of `message` with a 32-byte seed."""
    scalar, prefix = _ed_expand(seed)
    public_key = _ed_compress(_ed_mul(scalar, _ED_G))
    r = int.from_bytes(hashlib.sha512(prefix + message).digest(), "little") % _ED_L
    r_point = _ed_compress(_ed_mul(r, _ED_G))
    k = int.from_bytes(hashlib.sha512(r_point + public_key + message).digest(), "little") % _ED_L
    return r_point + ((r + k * scalar) % _ED_L).to_bytes(32, "little")


def _b58encode(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, rem = divmod(n, 58)
        out = _B58_ALPHABET[rem] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


def _b58decode(text: str) -> bytes:
    n = 0
    for ch in text:
        index = _B58_ALPHABET.find(ch)
        if index < 0:
            raise ValueError("invalid base58 character")
        n = n * 58 + index
    body = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\0" * (len(text) - len(text.lstrip("1"))) + body


def _identity_seed(identity: dict) -> bytes:
    """Return the ed25519 seed of the saved identity.secretKey (base58 of the
    64-byte tweetnacl key: seed, then public key). Raise ValueError when the
    key is malformed or does not match identity.publicKey."""
    raw = _b58decode(str(identity["secretKey"]))
    if len(raw) != 64:
        raise ValueError("identity.secretKey is not a 64-byte ed25519 key")
    seed, public_key = raw[:32], raw[32:]
    if _ed25519_public_key(seed) != public_key:
        raise ValueError("identity.secretKey is not a valid ed25519 key pair")
    if identity.get("publicKey") and identity["publicKey"] != _b58encode(public_key):
        raise ValueError("identity.secretKey does not match identity.publicKey")
    return seed


IDENTITY_MISMATCH_WARNING = (
    "This connect returned a different identity than the identity.secretKey "
    "saved by an earlier pair. The script kept the saved key, so `reconnect` "
    "signs for the earlier account. Tell your human now."
)


def _keep_identity_secret(saved_state: dict, identity):
    """identity.secretKey comes once per user; a returning connect omits it.
    Never overwrite a saved secret with a response that has none (protocol
    manual: do not overwrite your saved identity). Return (identity to save,
    warning or None)."""
    fresh = identity if isinstance(identity, dict) else {}
    saved = saved_state.get("identity")
    if fresh.get("secretKey") or not isinstance(saved, dict) or not saved.get("secretKey"):
        return identity, None
    for field in ("userId", "publicKey"):
        if fresh.get(field) and saved.get(field) and fresh[field] != saved[field]:
            return saved, IDENTITY_MISMATCH_WARNING
    return saved, None


def _relay_fields(summary: dict, body: dict, identity_warning) -> dict:
    """Add what the agent must pass to its human: the single-use
    sessionTicket.url control link, and an identity mismatch warning."""
    if body.get("sessionTicket"):
        summary["sessionTicket"] = body["sessionTicket"]
    if identity_warning:
        summary["identityWarning"] = identity_warning
    return summary


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
    try:
        _pair(args)
    finally:
        # A step after the connect failed (network error, die()) before the
        # result was printed: still show the one-time wallet secret.
        if _pending_wallet_recovery:
            _emit_pair_result({"ok": False})


def _pair(args):
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
        _take_wallet_secret(body)
        # Resolve user/avatar from the linked openclaw_bots row — the connect
        # response carries avatarId via state, but we also need the human-
        # facing email/avatarName for the success summary.
        sid = body["sessionId"]
        meta = _resolve_pair_metadata(sid, body)
        saved = load_state()
        identity, identity_warning = _keep_identity_secret(saved, body.get("identity"))
        state = {
            "userId": meta["userId"],
            "avatarId": meta["avatarId"],
            "avatarName": meta["avatarName"],
            "agentId": body["agentId"],
            "sessionId": sid,
            # Keep a `pair --self` account credential from an earlier pair.
            **({"identityKey": saved["identityKey"]} if saved.get("identityKey") else {}),
            "ownedSkills": body.get("ownedSkills", []),
            "gameTools": body.get("gameTools"),
            "identity": identity,
            "wallet": {"address": meta["walletAddress"]} if meta["walletAddress"] else None,
            "pairedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "pairedVia": "connect-token",
        }
        save_state(state)
        sync_owned(state)
        _emit_pair_result(_relay_fields({
            "ok": True,
            "avatarName": state["avatarName"],
            "agentId": body["agentId"],
            "sessionId": sid,
            "ownedSkillCount": len(body.get("ownedSkills", [])),
            "pairedVia": "connect-token",
        }, body, identity_warning))
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
    _take_wallet_secret(body)
    # Store only the public wallet address, never the whole wallet object.
    wallet_address = (body.get("wallet") or {}).get("address")
    saved = load_state()
    identity, identity_warning = _keep_identity_secret(saved, body.get("identity"))
    state = {
        "userId": user["id"],
        "avatarId": avatar_row["id"],
        "avatarName": avatar_row["name"],
        "agentId": body["agentId"],
        "sessionId": body["sessionId"],
        # Keep a `pair --self` account credential from an earlier pair.
        **({"identityKey": saved["identityKey"]} if saved.get("identityKey") else {}),
        "ownedSkills": body.get("ownedSkills", []),
        "gameTools": body.get("gameTools"),
        "identity": identity,
        "wallet": {"address": wallet_address} if wallet_address else None,
        "pairedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "pairedVia": "magic-link",
    }
    save_state(state)

    # Also install owned skills + game tools immediately so the user's
    # next prompt sees everything.
    sync_owned(state)

    _emit_pair_result(_relay_fields({
        "ok": True,
        "avatarName": avatar_row["name"],
        "userEmail": user.get("email"),
        "agentId": body["agentId"],
        "sessionId": body["sessionId"],
        "ownedSkillCount": len(body.get("ownedSkills", [])),
    }, body, identity_warning))


def _pair_self(args):
    """Flow C: direct self-registration (`pair --self`), no URL, no human account.

    Sends a long random identityKey on the FIRST connect (protocol manual §1),
    so the server binds this agentId to the account derived from that key. The
    key is the account credential: it is saved to state.json (0600) BEFORE the
    request, so a lost response cannot orphan the agentId, and every later
    `pair --self` reuses it. Never log or print it.
    """
    state = load_state()
    identity_key = state.get("identityKey")
    if not identity_key:
        identity_key = secrets.token_urlsafe(32)
        state["identityKey"] = identity_key
        save_state(state)

    conn = _request_json(
        "POST",
        "/api/agent/connect",
        body={
            "agentId": _stable_hermes_agent_id(),
            "identityType": "hermes",
            "identityKey": identity_key,
            # Internal self-managed pull wire; not an identity type.
            "protocol": "nanoclaw",
            "name": "hermes",
        },
    )
    if conn["status"] != 200:
        die("connect_failed", json.dumps(conn["body"]))
    body = conn["body"]
    _take_wallet_secret(body)
    sid = body["sessionId"]
    meta = _resolve_pair_metadata(sid, body)
    # A reconnect omits identity.secretKey; keep the one saved at first pair.
    identity, identity_warning = _keep_identity_secret(state, body.get("identity"))
    state = {
        "userId": meta["userId"],
        "avatarId": meta["avatarId"],
        "avatarName": meta["avatarName"],
        "agentId": body["agentId"],
        "sessionId": sid,
        "identityKey": identity_key,
        "ownedSkills": body.get("ownedSkills", []),
        "gameTools": body.get("gameTools"),
        "identity": identity,
        "wallet": {"address": meta["walletAddress"]} if meta["walletAddress"] else None,
        "pairedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "pairedVia": "self",
    }
    save_state(state)
    sync_owned(state)
    _emit_pair_result(_relay_fields({
        "ok": True,
        "avatarName": state["avatarName"],
        "agentId": body["agentId"],
        "sessionId": sid,
        "ownedSkillCount": len(body.get("ownedSkills", [])),
        "pairedVia": "self",
    }, body, identity_warning))


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


RECONNECT_WAYS_BACK = (
    "Two ways back: (1) run the signed /api/agent/reconnect from a client that "
    "holds this account's identity.secretKey; (2) ask the owner for a fresh "
    "magic link from the ClawVille game UI, then run "
    "`clawville.py pair --magic-link <URL>`."
)


def cmd_reconnect(args):
    """Signed-challenge reconnect (protocol manual: GET /api/agent/challenge,
    then POST /api/agent/reconnect { userId, nonce, signature } with a base58
    ed25519 signature over the raw decoded nonce). The saved identity.secretKey
    proves the account; no session bearer is sent. Saves the fresh sessionId."""
    state = load_state()
    identity = state.get("identity")
    identity = identity if isinstance(identity, dict) else {}
    user_id = identity.get("userId") or state.get("userId")
    if not identity.get("secretKey") or not user_id:
        die("no_identity_keypair",
            "This install has no saved identity.secretKey, so it cannot sign "
            "/api/agent/reconnect. " + RECONNECT_WAYS_BACK)
    try:
        seed = _identity_seed(identity)
    except ValueError as e:
        die("identity_key_invalid", f"{e}. {RECONNECT_WAYS_BACK}")

    challenge = _request_json("GET", "/api/agent/challenge")
    nonce = challenge["body"].get("nonce") if isinstance(challenge["body"], dict) else None
    if challenge["status"] != 200 or not isinstance(nonce, str) or not nonce:
        die("challenge_failed", json.dumps({"status": challenge["status"], "body": challenge["body"]}))
    try:
        nonce_bytes = _b58decode(nonce)
    except ValueError:
        die("challenge_failed", "The server nonce is not base58.")
    signature = _b58encode(_ed25519_sign(seed, nonce_bytes))

    conn = _request_json("POST", "/api/agent/reconnect",
                         body={"userId": user_id, "nonce": nonce, "signature": signature})
    if conn["status"] != 200:
        die("reconnect_failed", json.dumps({"status": conn["status"], "body": conn["body"]}))
    body = conn["body"] if isinstance(conn["body"], dict) else {}
    # /reconnect never returns a wallet secret; if one ever comes, it is
    # shown once and not stored, like on pair.
    _take_wallet_secret(body)
    sid = body.get("sessionId")
    if sid:
        state["sessionId"] = sid
        state["sessionExpiresAt"] = body.get("expiresAt")
    state["userId"] = user_id
    if body.get("avatarId"):
        state["avatarId"] = body["avatarId"]
    wallet_address = (body.get("wallet") or {}).get("address")
    if wallet_address:
        state["wallet"] = {"address": wallet_address}
    state["reconnectedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    save_state(state)

    summary = _relay_fields({
        "ok": bool(sid),
        "sessionId": sid,
        "expiresAt": body.get("expiresAt"),
        "dormant": bool(body.get("dormant")),
    }, body, None)
    if not sid:
        summary["hint"] = (
            "The server accepted the signature but minted no agent session "
            "(no agent row for this account, or a mint failure). Run "
            "`clawville.py reconnect` again. If it repeats: " + RECONNECT_WAYS_BACK
        )
    _emit_pair_result(summary)
    if not sid:
        sys.exit(2)


def cmd_disconnect(args):
    die("disconnect_not_implemented",
        "This script does not implement the signed /api/agent/disconnect yet. "
        "Sessions self-expire after 24h idle.")


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
    ap = argparse.ArgumentParser(prog="clawville", description="ClawVille to Hermes integration")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("pair", help="One-time pairing via Connect Agent URL.")
    p.add_argument("--magic-link", required=False, help="Connect URL from the in-game modal (Moltbook flow): https://api.clawville.world/api/skills/connect?token=ct-... OR magic-link https://clawville.world/enter?t=sess-...")
    p.add_argument("--self", action="store_true", help="Direct agent self-registration: no URL, no human account, server auto-mints user+avatar.")
    p.set_defaults(func=cmd_pair)

    p = sub.add_parser("status", help="Show current session + ownership.")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("sync", help="Re-pull owned skills + game tools, write to ~/.hermes/skills/.")
    p.set_defaults(func=cmd_sync)

    p = sub.add_parser("daemon", help="Background SSE listener: auto-installs purchased skills.")
    p.set_defaults(func=cmd_daemon)

    p = sub.add_parser("shop", help="List books at a building.")
    p.add_argument("building_id")
    p.set_defaults(func=cmd_shop)

    p = sub.add_parser("buy", help="Buy a book.")
    p.add_argument("item_id")
    p.set_defaults(func=cmd_buy)

    p = sub.add_parser("read", help="Read a book: triggers auto-install if daemon is running.")
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

    p = sub.add_parser("reconnect", help="Get a fresh session with the saved identity key (signed /api/agent/reconnect).")
    p.set_defaults(func=cmd_reconnect)

    p = sub.add_parser("disconnect", help="Not implemented yet: sessions self-expire after 24h idle.")
    p.set_defaults(func=cmd_disconnect)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
