import contextlib
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("clawville.py")
SPEC = importlib.util.spec_from_file_location("clawville_hermes_test", SCRIPT)
assert SPEC and SPEC.loader
clawville = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(clawville)


def configure_home(home: str) -> None:
    clawville.HERMES_HOME = home
    clawville.SKILLS_DIR = os.path.join(home, "skills")
    clawville.STATE_DIR = os.path.join(home, "clawville")
    clawville.STATE_FILE = os.path.join(clawville.STATE_DIR, "state.json")
    clawville.COOKIE_FILE = os.path.join(clawville.STATE_DIR, "cookies.txt")
    clawville.DAEMON_LOG = os.path.join(clawville.STATE_DIR, "daemon.log")
    clawville.INSTALL_AGENT_ID_FILE = os.path.join(
        clawville.STATE_DIR, "install-agent-id"
    )


class StableHermesAgentIdTest(unittest.TestCase):
    def test_same_install_is_stable_and_file_is_private(self) -> None:
        with tempfile.TemporaryDirectory() as home, patch.dict(
            os.environ, {"CLAWVILLE_AGENT_ID": ""}, clear=False
        ):
            configure_home(home)
            first = clawville._stable_hermes_agent_id()
            second = clawville._stable_hermes_agent_id()
            self.assertEqual(first, second)
            self.assertRegex(first, r"^hermes-[0-9a-f]{32}$")
            if os.name != "nt":
                self.assertEqual(
                    stat.S_IMODE(os.stat(clawville.INSTALL_AGENT_ID_FILE).st_mode),
                    0o600,
                )

    def test_fresh_installs_are_distinct(self) -> None:
        with tempfile.TemporaryDirectory() as first_home, tempfile.TemporaryDirectory() as second_home, patch.dict(
            os.environ, {"CLAWVILLE_AGENT_ID": ""}, clear=False
        ):
            configure_home(first_home)
            first = clawville._stable_hermes_agent_id()
            configure_home(second_home)
            second = clawville._stable_hermes_agent_id()
            self.assertNotEqual(first, second)

    def test_existing_state_then_explicit_env_take_precedence(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            configure_home(home)
            clawville.save_state({"agentId": "hermes-from-state"})
            with patch.dict(
                os.environ, {"CLAWVILLE_AGENT_ID": "hermes-from-env"}, clear=False
            ):
                self.assertEqual(
                    clawville._stable_hermes_agent_id(), "hermes-from-state"
                )

        with tempfile.TemporaryDirectory() as home, patch.dict(
            os.environ, {"CLAWVILLE_AGENT_ID": "hermes-from-env"}, clear=False
        ):
            configure_home(home)
            self.assertEqual(
                clawville._stable_hermes_agent_id(), "hermes-from-env"
            )


class PairSelfTest(unittest.TestCase):
    """`pair --self` called an undefined `_pair_self` (NameError)."""

    def test_pair_self_sends_and_keeps_one_identity_key(self) -> None:
        sent = []

        def fake_request_json(method, path, body=None, bearer=None, **_):
            # The key must be on disk BEFORE the request goes out.
            self.assertEqual(clawville.load_state().get("identityKey"), body["identityKey"])
            sent.append((method, path, body))
            identity = {"userId": "u-1", "publicKey": "pk"}
            if len(sent) == 1:
                identity["secretKey"] = "first-pair-identity-secret"
            return {
                "status": 200,
                "body": {"sessionId": f"s-{len(sent)}", "agentId": body["agentId"], "identity": identity},
            }

        meta = {"userId": "u-1", "avatarId": "a-1", "avatarName": "hermes", "walletAddress": None}
        with tempfile.TemporaryDirectory() as home, patch.dict(
            os.environ, {"CLAWVILLE_AGENT_ID": ""}, clear=False
        ), patch.object(clawville, "_request_json", side_effect=fake_request_json), patch.object(
            clawville, "_resolve_pair_metadata", return_value=meta
        ), patch.object(clawville, "sync_owned"), patch.object(clawville, "emit"):
            configure_home(home)
            # argparse stores `--self` as attribute "self" (not a kwarg name).
            args = clawville.argparse.Namespace(magic_link=None)
            setattr(args, "self", True)
            clawville.cmd_pair(args)
            clawville.cmd_pair(args)

            self.assertEqual(len(sent), 2)
            first, second = sent[0][2], sent[1][2]
            self.assertEqual(sent[0][:2], ("POST", "/api/agent/connect"))
            self.assertEqual(first["identityType"], "hermes")
            self.assertGreaterEqual(len(first["identityKey"]), 32)
            self.assertEqual(second["identityKey"], first["identityKey"])
            self.assertEqual(second["agentId"], first["agentId"])
            state = clawville.load_state()
            self.assertEqual(state["identityKey"], first["identityKey"])
            self.assertEqual(state["pairedVia"], "self")
            # The reconnect omitted identity.secretKey; the first one is kept.
            self.assertEqual(state["identity"]["secretKey"], "first-pair-identity-secret")


WALLET_SECRET = "wallet-secret-test-only-5f2c"
IDENTITY_SECRET = "identity-secret-test-only-9a1b"
WALLET_ADDRESS = "WalletAddrTestOnly111"
PAIR_META = {
    "userId": "u-1",
    "avatarId": "a-1",
    "avatarName": "hermes",
    "walletAddress": WALLET_ADDRESS,
}


def first_connect_body(agent_id: str) -> dict:
    return {
        "sessionId": "s-1",
        "agentId": agent_id,
        "identity": {"userId": "u-1", "publicKey": "pk", "secretKey": IDENTITY_SECRET},
        "walletAddress": WALLET_ADDRESS,
        "wallet": {"address": WALLET_ADDRESS, "chain": "solana", "secretKey": WALLET_SECRET},
    }


def pair_args(magic_link=None, self_flag=False):
    args = clawville.argparse.Namespace(magic_link=magic_link)
    setattr(args, "self", self_flag)
    return args


CONNECT_TOKEN_URL = "https://api.clawville.world/api/skills/connect?token=ct-abc"
MAGIC_LINK_URL = "https://clawville.world/enter?t=sess-abc"
FLOW_B_REPLIES = {
    "/api/auth/me": {"user": {"id": "u-1", "email": "human@example.invalid"}},
    "/api/avatars/me": {"avatar": {"id": "a-1", "name": "hermes"}},
    "/api/agent/connect-token": {"token": "ct-xyz"},
}


class TempHomeTest(unittest.TestCase):
    """A private HERMES_HOME per test, and no secret state left over in memory."""

    def setUp(self) -> None:
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        self.home = home.name
        configure_home(self.home)
        env = patch.dict(os.environ, {"CLAWVILLE_AGENT_ID": "hermes-test"}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        clawville._pending_wallet_recovery = None
        clawville._legacy_recovery = None
        clawville._legacy_shown = set()

    def run_status(self, out) -> None:
        def request_json(method, path, body=None, bearer=None, **_):
            return {"status": 200, "headers": {}, "body": {"connected": True}}

        with patch.object(clawville, "_request_json", side_effect=request_json), contextlib.redirect_stdout(out):
            clawville.cmd_status(clawville.argparse.Namespace())

    def assert_stored_nowhere(self, secret: str = None) -> None:
        secret = secret or WALLET_SECRET
        for root, _, files in os.walk(self.home):
            for name in files:
                with open(os.path.join(root, name), "rb") as f:
                    self.assertNotIn(secret.encode(), f.read(), name)


class WalletSecretRelayTest(TempHomeTest):
    """Phase 5.1: wallet.secretKey is relayed ONCE to the human, never stored."""

    def run_pair(self, args, request_json, request=None, sync_error=None) -> str:
        out = self.stdout = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(clawville, "_request_json", side_effect=request_json))
            stack.enter_context(patch.object(clawville, "_resolve_pair_metadata", return_value=PAIR_META))
            stack.enter_context(patch.object(clawville, "sync_owned", side_effect=sync_error))
            if request is not None:
                stack.enter_context(patch.object(clawville, "_request", side_effect=request))
            stack.enter_context(contextlib.redirect_stdout(out))
            clawville.cmd_pair(args)
        return out.getvalue()

    def assert_relayed_once(self, stdout: str) -> None:
        self.assertEqual(stdout.count(WALLET_SECRET), 1, stdout)
        self.assertIn("It is shown once and is not stored", stdout)

    def assert_public_state(self) -> None:
        state = clawville.load_state()
        self.assertEqual(state["wallet"], {"address": WALLET_ADDRESS})
        # The identity secret is the agent's own credential: kept, as intended.
        self.assertEqual(state["identity"]["secretKey"], IDENTITY_SECRET)

    def test_flow_a_connect_token(self) -> None:
        def request_json(method, path, body=None, bearer=None, **_):
            self.assertEqual((method, path), ("POST", "/api/agent/connect"))
            return {"status": 200, "headers": {}, "body": first_connect_body(body["agentId"])}

        stdout = self.run_pair(
            pair_args("https://api.clawville.world/api/skills/connect?token=ct-abc"), request_json
        )
        self.assert_relayed_once(stdout)
        self.assertEqual(json.loads(stdout)["walletRecovery"]["secretKey"], WALLET_SECRET)
        self.assert_stored_nowhere()
        self.assert_public_state()

    def test_flow_b_magic_link(self) -> None:
        replies = {
            "/api/auth/me": {"user": {"id": "u-1", "email": "human@example.invalid"}},
            "/api/avatars/me": {"avatar": {"id": "a-1", "name": "hermes"}},
            "/api/agent/connect-token": {"token": "ct-xyz"},
        }

        def request_json(method, path, body=None, bearer=None, **_):
            if path == "/api/agent/connect":
                return {"status": 200, "headers": {}, "body": first_connect_body(body["agentId"])}
            return {"status": 200, "headers": {}, "body": replies[path]}

        stdout = self.run_pair(
            pair_args("https://clawville.world/enter?t=sess-abc"),
            request_json,
            request=lambda *a, **k: (302, {}, b""),
        )
        # Old code saved the whole connect `wallet` object, secret included.
        self.assert_stored_nowhere()
        self.assert_relayed_once(stdout)
        self.assertEqual(json.loads(stdout)["walletRecovery"]["secretKey"], WALLET_SECRET)
        self.assert_public_state()

    def test_flow_c_self(self) -> None:
        def request_json(method, path, body=None, bearer=None, **_):
            return {"status": 200, "headers": {}, "body": first_connect_body(body["agentId"])}

        stdout = self.run_pair(pair_args(self_flag=True), request_json)
        self.assert_relayed_once(stdout)
        self.assert_stored_nowhere()
        self.assertEqual(clawville.load_state()["wallet"], {"address": WALLET_ADDRESS})

    def test_secret_still_shown_once_when_a_later_step_fails(self) -> None:
        def request_json(method, path, body=None, bearer=None, **_):
            return {"status": 200, "headers": {}, "body": first_connect_body(body["agentId"])}

        with self.assertRaises(urllib.error.URLError):
            self.run_pair(
                pair_args("https://api.clawville.world/api/skills/connect?token=ct-abc"),
                request_json,
                sync_error=urllib.error.URLError("network down"),
            )
        self.assert_relayed_once(self.stdout.getvalue())
        self.assertFalse(json.loads(self.stdout.getvalue())["ok"])
        self.assert_stored_nowhere()

    def test_legacy_secret_is_shown_once_in_the_one_result_document(self) -> None:
        # What an older magic-link pair wrote: the whole wallet object.
        clawville.save_state({
            "sessionId": "s-1",
            "agentId": "hermes-test",
            "wallet": {"address": WALLET_ADDRESS, "chain": "solana", "secretKey": WALLET_SECRET},
        })
        first, second = io.StringIO(), io.StringIO()
        self.run_status(first)
        self.run_status(second)
        # Exactly one JSON document per run (the old code printed a second one).
        doc = json.loads(first.getvalue())
        self.assertTrue(doc["connected"])
        self.assertEqual(doc["legacyWalletRecovery"]["secretKey"], WALLET_SECRET)
        self.assertEqual(doc["legacyWalletRecovery"]["address"], WALLET_ADDRESS)
        self.assertIn("removes it from state.json", doc["legacyWalletNotice"])
        self.assert_relayed_once(first.getvalue())
        self.assertNotIn(WALLET_SECRET, second.getvalue())
        self.assertNotIn("legacyWalletNotice", json.loads(second.getvalue()))
        self.assert_stored_nowhere()
        state = clawville.load_state()
        self.assertEqual(state["wallet"]["address"], WALLET_ADDRESS)
        self.assertEqual(state["sessionId"], "s-1")

    def test_legacy_secret_never_goes_to_a_stdout_file(self) -> None:
        # The documented daemon start sends stdout to daemon.log.
        clawville.save_state({
            "sessionId": "s-1",
            "agentId": "hermes-test",
            "wallet": {"address": WALLET_ADDRESS, "secretKey": WALLET_SECRET},
        })
        log_path = os.path.join(self.home, "daemon.log")
        with open(log_path, "w", encoding="utf-8") as log:
            self.run_status(log)
        with open(log_path, "r", encoding="utf-8") as f:
            text = f.read()
        self.assertNotIn(WALLET_SECRET, text)
        self.assertIn("stdout is a file", json.loads(text)["legacyWalletNotice"])
        # Not removed unseen: the next run with a terminal or pipe shows it.
        with open(clawville.STATE_FILE, "r", encoding="utf-8") as f:
            self.assertEqual(json.load(f)["wallet"]["secretKey"], WALLET_SECRET)

    def test_pair_to_a_stdout_file_keeps_an_unshown_legacy_secret(self) -> None:
        old_address = "OldWalletAddrTestOnly222"
        clawville.save_state({
            "sessionId": "s-0",
            "agentId": "hermes-test",
            "wallet": {"address": old_address, "chain": "solana", "secretKey": WALLET_SECRET},
        })

        def request_json(method, path, body=None, bearer=None, **_):
            # A returning connect: no wallet secret and no identity secret.
            return {"status": 200, "headers": {}, "body": {
                "sessionId": "s-1",
                "agentId": body["agentId"],
                "identity": {"userId": "u-1", "publicKey": "pk"},
                "wallet": {"address": WALLET_ADDRESS, "chain": "solana"},
            }}

        with open(clawville.STATE_FILE, "rb") as f:
            state_before = f.read()

        # pair refuses a stdout file before any request: state.json stays as it was.
        out_path = os.path.join(self.home, "pair-output.json")
        with open(out_path, "w", encoding="utf-8") as out, contextlib.ExitStack() as stack:
            sent = stack.enter_context(patch.object(clawville, "_request_json", side_effect=request_json))
            stack.enter_context(contextlib.redirect_stdout(out))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            with self.assertRaises(SystemExit):
                clawville.cmd_pair(pair_args(CONNECT_TOKEN_URL))
        sent.assert_not_called()
        with open(out_path, "r", encoding="utf-8") as f:
            self.assertEqual(f.read(), "")
        os.remove(out_path)
        with open(clawville.STATE_FILE, "rb") as f:
            self.assertEqual(f.read(), state_before)

        # A pair on a pipe that fails after it rewrote state.json (before its
        # output) keeps the unshown secret.
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(clawville, "_request_json", side_effect=request_json))
            stack.enter_context(patch.object(clawville, "_resolve_pair_metadata", return_value=PAIR_META))
            stack.enter_context(patch.object(
                clawville, "sync_owned", side_effect=urllib.error.URLError("network down")
            ))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            with self.assertRaises(urllib.error.URLError):
                clawville.cmd_pair(pair_args(CONNECT_TOKEN_URL))
        state = clawville.load_state()
        self.assertEqual(state["sessionId"], "s-1")
        self.assertEqual(state["wallet"], {"address": WALLET_ADDRESS})
        self.assertIn(WALLET_SECRET, json.dumps(state))
        # The next run on a pipe shows it once, with its own address, then removes it.
        shown = io.StringIO()
        self.run_status(shown)
        doc = json.loads(shown.getvalue())
        self.assertEqual(doc["legacyWalletRecovery"]["secretKey"], WALLET_SECRET)
        self.assertEqual(doc["legacyWalletRecovery"]["address"], old_address)
        self.assert_relayed_once(shown.getvalue())
        self.assert_stored_nowhere()
        self.assertEqual(clawville.load_state()["wallet"], {"address": WALLET_ADDRESS})


PAIR_MODES = (
    ("connect-token", pair_args(CONNECT_TOKEN_URL)),
    ("magic-link", pair_args(MAGIC_LINK_URL)),
    ("self", pair_args(self_flag=True)),
)


class PairStdoutFileTest(TempHomeTest):
    """A first connect returns the one-time wallet secret, and pair prints it.
    With stdout on a regular file, pair stops before any HTTP request."""

    def test_stdout_file_is_refused_before_any_http_request(self) -> None:
        out_path = os.path.join(self.home, "pair-output.json")
        calls = [(name, lambda a=args: clawville.cmd_pair(a)) for name, args in PAIR_MODES]
        calls.append(("_pair_self direct", lambda: clawville._pair_self(pair_args(self_flag=True))))
        for name, call in calls:
            with self.subTest(mode=name):
                err = io.StringIO()
                with open(out_path, "w", encoding="utf-8") as out, contextlib.ExitStack() as stack:
                    request_json = stack.enter_context(patch.object(clawville, "_request_json"))
                    request = stack.enter_context(patch.object(clawville, "_request"))
                    stack.enter_context(contextlib.redirect_stdout(out))
                    stack.enter_context(contextlib.redirect_stderr(err))
                    with self.assertRaises(SystemExit) as raised:
                        call()
                self.assertEqual(raised.exception.code, 1)
                request_json.assert_not_called()
                request.assert_not_called()
                message = json.loads(err.getvalue())
                self.assertEqual(message["error"], "stdout_is_file")
                self.assertIn("terminal or through a pipe", message["hint"])
                with open(out_path, "r", encoding="utf-8") as f:
                    self.assertEqual(f.read(), "")
                # No state.json, no identityKey, no install id: nothing was started.
                self.assertEqual(os.listdir(self.home), ["pair-output.json"])

    def pair_through_a_pipe(self, args) -> str:
        def request_json(method, path, body=None, bearer=None, **_):
            if path == "/api/agent/connect":
                return {"status": 200, "headers": {}, "body": first_connect_body(body["agentId"])}
            return {"status": 200, "headers": {}, "body": FLOW_B_REPLIES[path]}

        read_fd, write_fd = os.pipe()
        chunks = []
        with open(read_fd, "rb") as reader:
            # Read while pair writes, so a full pipe buffer cannot block it.
            thread = threading.Thread(target=lambda: chunks.append(reader.read()))
            thread.start()
            try:
                with open(write_fd, "w", encoding="utf-8") as pipe, contextlib.ExitStack() as stack:
                    stack.enter_context(patch.object(clawville, "_request_json", side_effect=request_json))
                    stack.enter_context(patch.object(clawville, "_request", return_value=(302, {}, b"")))
                    stack.enter_context(patch.object(clawville, "_resolve_pair_metadata", return_value=PAIR_META))
                    stack.enter_context(patch.object(clawville, "sync_owned"))
                    stack.enter_context(contextlib.redirect_stdout(pipe))
                    self.assertFalse(clawville._stdout_is_file())
                    clawville.cmd_pair(args)
            finally:
                thread.join(timeout=30)
        return chunks[0].decode("utf-8")

    def test_pipe_is_allowed_and_relays_the_secret_once(self) -> None:
        for name, args in PAIR_MODES:
            with self.subTest(mode=name):
                clawville._pending_wallet_recovery = None
                stdout = self.pair_through_a_pipe(args)
                self.assertEqual(stdout.count(WALLET_SECRET), 1, stdout)
                doc = json.loads(stdout)
                self.assertTrue(doc["ok"])
                self.assertEqual(doc["walletRecovery"]["secretKey"], WALLET_SECRET)
                self.assert_stored_nowhere()
                self.assertEqual(clawville.load_state()["wallet"], {"address": WALLET_ADDRESS})


SAVED_IDENTITY_KEY = "saved-identity-key-test-only"


class RepairKeepsIdentitySecretTest(TempHomeTest):
    """A returning connect omits identity.secretKey: a re-pair must not drop the saved one."""

    def save_paired_state(self) -> None:
        clawville.save_state({
            "agentId": "hermes-test",
            "sessionId": "s-0",
            "userId": "u-1",
            "identityKey": SAVED_IDENTITY_KEY,
            "identity": {"userId": "u-1", "publicKey": "pk", "secretKey": IDENTITY_SECRET},
        })

    def repair(self, url: str, identity: dict) -> dict:
        def request_json(method, path, body=None, bearer=None, **_):
            if path == "/api/agent/connect":
                return {"status": 200, "headers": {}, "body": {
                    "sessionId": "s-2",
                    "agentId": body["agentId"],
                    "identity": identity,
                    "sessionTicket": {"url": "https://clawville.world/enter?t=sess-relay"},
                }}
            return {"status": 200, "headers": {}, "body": FLOW_B_REPLIES[path]}

        out = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(clawville, "_request_json", side_effect=request_json))
            stack.enter_context(patch.object(clawville, "_request", return_value=(302, {}, b"")))
            stack.enter_context(patch.object(clawville, "_resolve_pair_metadata", return_value=PAIR_META))
            stack.enter_context(patch.object(clawville, "sync_owned"))
            stack.enter_context(contextlib.redirect_stdout(out))
            clawville.cmd_pair(pair_args(url))
        return json.loads(out.getvalue())

    def test_flows_a_and_b_keep_the_saved_identity_secret(self) -> None:
        returning = (
            {"userId": "u-1", "publicKey": "pk", "isFirstTime": False, "secretIncluded": False},
            {"userId": "u-1", "publicKey": "pk", "isFirstTime": False, "secretKey": ""},
        )
        for url in (CONNECT_TOKEN_URL, MAGIC_LINK_URL):
            for identity in returning:
                with self.subTest(url=url, identity=identity):
                    self.save_paired_state()
                    doc = self.repair(url, dict(identity))
                    state = clawville.load_state()
                    self.assertEqual(state["sessionId"], "s-2")
                    self.assertEqual(state["identity"]["secretKey"], IDENTITY_SECRET)
                    self.assertEqual(state["identityKey"], SAVED_IDENTITY_KEY)
                    self.assertNotIn("sessionTicket", state)
                    self.assertTrue(doc["ok"])
                    self.assertNotIn("identityWarning", doc)
                    self.assertEqual(doc["sessionTicket"]["url"], "https://clawville.world/enter?t=sess-relay")
                    self.assertNotIn(IDENTITY_SECRET, json.dumps(doc))

    def test_a_different_account_keeps_the_saved_secret_and_warns(self) -> None:
        self.save_paired_state()
        doc = self.repair(CONNECT_TOKEN_URL, {"userId": "u-9", "publicKey": "pk-9"})
        self.assertIn("identityWarning", doc)
        self.assertEqual(clawville.load_state()["identity"]["secretKey"], IDENTITY_SECRET)


# RFC 8032 section 7.1 TEST 1 (seed, public key, signature of the empty message).
RFC_SEED = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
RFC_PUB = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
RFC_SIG_EMPTY = bytes.fromhex(
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
)
# Made with the server's own libraries (tweetnacl nacl.sign.detached, bs58.encode)
# for the nonce bytes 00..1f. Both the nonce and the signature start with a 0x00
# byte, so they also test base58 leading zeros.
NONCE = bytes(range(32))
NONCE_B58 = "1thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE"
SIG_NONCE_B58 = "1svzg2dsN3g4MRDS9KqSZeTQ5TwnGkCrtVZ3JHD2gEB5sXrMGwNYmsyWGXRUbVnqgfW5m12E7Hkv6y5Ma1SChq2"
SECRET_B58 = "49W385L4rePHy6PAaQUovbD2aacgN4HsKXSMeUzRg4fmwXszN91JuMFrQRj3vMDpZuRF3ZknQBuRBoWQJEfXstMw"
PUB_B58 = "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z"
USER_ID = "00000000-0000-4000-8000-000000000001"


class ReconnectTest(TempHomeTest):
    """`reconnect` crashed on a null identity and did not sign /api/agent/reconnect."""

    def test_ed25519_and_base58_match_rfc8032_and_the_server_libraries(self) -> None:
        self.assertEqual(clawville._ed25519_public_key(RFC_SEED), RFC_PUB)
        self.assertEqual(clawville._ed25519_sign(RFC_SEED, b""), RFC_SIG_EMPTY)
        self.assertEqual(clawville._b58encode(clawville._ed25519_sign(RFC_SEED, NONCE)), SIG_NONCE_B58)
        self.assertEqual(clawville._b58decode(NONCE_B58), NONCE)
        self.assertEqual(clawville._b58encode(NONCE), NONCE_B58)
        self.assertEqual(clawville._b58encode(RFC_SEED + RFC_PUB), SECRET_B58)
        self.assertEqual(clawville._b58decode(SECRET_B58), RFC_SEED + RFC_PUB)

    def test_null_identity_fails_with_both_ways_back(self) -> None:
        clawville.save_state({"sessionId": "s-1", "agentId": "hermes-test", "identity": None})
        err = io.StringIO()
        with patch.object(clawville, "_request_json") as request_json, contextlib.redirect_stderr(err):
            with self.assertRaises(SystemExit) as raised:
                clawville.cmd_reconnect(clawville.argparse.Namespace())
        self.assertEqual(raised.exception.code, 1)
        request_json.assert_not_called()
        message = json.loads(err.getvalue())
        self.assertEqual(message["error"], "no_identity_keypair")
        self.assertIn("/api/agent/reconnect", message["hint"])
        self.assertIn("magic link", message["hint"])

    def test_signed_reconnect_saves_the_new_session(self) -> None:
        clawville.save_state({
            "sessionId": "s-old",
            "agentId": "hermes-test",
            "userId": USER_ID,
            "identity": {"userId": USER_ID, "publicKey": PUB_B58, "secretKey": SECRET_B58},
            "wallet": {"address": WALLET_ADDRESS},
        })
        calls = []

        def request_json(method, path, body=None, bearer=None, **_):
            calls.append((method, path, body, bearer))
            if path == "/api/agent/challenge":
                return {"status": 200, "headers": {}, "body": {"nonce": NONCE_B58, "expiresAt": "x"}}
            return {"status": 200, "headers": {}, "body": {
                "sessionId": "ag-new",
                "expiresAt": "2026-10-02T00:00:00.000Z",
                "sessionTicket": {"url": "https://clawville.world/enter?t=sess-relay"},
                "avatarId": "a-1",
                "walletAddress": WALLET_ADDRESS,
                "wallet": {"address": WALLET_ADDRESS, "chain": "solana"},
            }}

        out = io.StringIO()
        with patch.object(clawville, "_request_json", side_effect=request_json), contextlib.redirect_stdout(out):
            clawville.cmd_reconnect(clawville.argparse.Namespace())
        self.assertEqual(
            [call[:2] for call in calls],
            [("GET", "/api/agent/challenge"), ("POST", "/api/agent/reconnect")],
        )
        # Identity-signed, not bearer-scoped: no session bearer goes on the wire.
        self.assertEqual([call[3] for call in calls], [None, None])
        self.assertEqual(
            calls[1][2], {"userId": USER_ID, "nonce": NONCE_B58, "signature": SIG_NONCE_B58}
        )
        doc = json.loads(out.getvalue())
        self.assertTrue(doc["ok"])
        self.assertEqual(doc["sessionTicket"]["url"], "https://clawville.world/enter?t=sess-relay")
        self.assertNotIn(SECRET_B58, out.getvalue())
        state = clawville.load_state()
        self.assertEqual(state["sessionId"], "ag-new")
        self.assertEqual(state["identity"]["secretKey"], SECRET_B58)
        self.assertNotIn("sessionTicket", state)


class HelpEncodingTest(unittest.TestCase):
    def test_help_prints_on_a_cp1252_pipe(self) -> None:
        commands = (
            [], ["pair"], ["status"], ["sync"], ["daemon"], ["shop"], ["buy"], ["read"],
            ["inventory"], ["chat"], ["guide"], ["visit"], ["move"], ["balance"], ["tool"],
            ["reconnect"], ["disconnect"],
        )
        with tempfile.TemporaryDirectory() as home:
            env = dict(os.environ, PYTHONIOENCODING="cp1252", HERMES_HOME=home)
            for command in commands:
                with self.subTest(command=command):
                    proc = subprocess.run(
                        [sys.executable, str(SCRIPT), *command, "--help"],
                        env=env, capture_output=True, timeout=60,
                    )
                    self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace"))


if __name__ == "__main__":
    unittest.main()
