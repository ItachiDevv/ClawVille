import importlib.util
import os
import stat
import tempfile
import unittest
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


if __name__ == "__main__":
    unittest.main()
