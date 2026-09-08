import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PowerActionReloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = (ROOT / "gcp-vm/power-action.sh").read_text()
        body = source.split("refresh_power_action_daemon() {", 1)[1].split("\n}\n", 1)[0]
        cls.function = "refresh_power_action_daemon() {" + body + "\n}\n"

    def run_reload(self, original, payload):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "agent"
            target.write_text(original)
            target.chmod(0o755)
            digest = hashlib.sha256(original.encode()).hexdigest()
            shell = self.function + '''
metadata_get() { printf '%s' "$TEST_PAYLOAD"; }
log() { printf '%s\n' "$*"; }
refresh_power_action_daemon "$TEST_TARGET" "$TEST_HASH"
'''
            result = subprocess.run(["bash", "-e"], input=shell, text=True,
                                    env=dict(os.environ, TEST_TARGET=str(target),
                                             TEST_HASH=digest, TEST_PAYLOAD=payload),
                                    capture_output=True)
            return result, target.read_text(), list(Path(directory).glob("agent.*"))

    def test_new_agent_is_executed_before_the_pending_action(self):
        payload = '#!/usr/bin/env bash\nprintf "new-agent:%s\\n" "$1"\n'
        result, content, leftovers = self.run_reload("#!/bin/bash\nexit 0\n", payload)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("new-agent:daemon", result.stdout)
        self.assertEqual(content, payload)
        self.assertEqual(leftovers, [])

    def test_same_agent_is_not_executed_again(self):
        payload = "#!/bin/bash\nexit 19\n"
        result, content, _ = self.run_reload(payload, payload)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(content, payload)
        self.assertNotIn("Reloading", result.stdout)

    def test_invalid_update_preserves_installed_agent(self):
        original = "#!/bin/bash\nexit 0\n"
        result, content, leftovers = self.run_reload(original, "#!/bin/bash\nif then\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(content, original)
        self.assertEqual(leftovers, [])

    def test_startup_restarts_daemon_after_installing_script(self):
        source = (ROOT / "gcp-vm/startup.sh").read_text()
        self.assertIn("systemctl restart vm-power-action-daemon.service", source)
        self.assertNotIn("enable --now vm-power-action-daemon.service", source)


if __name__ == "__main__":
    unittest.main()
