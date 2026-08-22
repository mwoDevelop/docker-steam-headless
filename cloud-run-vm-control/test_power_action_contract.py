from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class PowerActionContractTests(unittest.TestCase):
    def test_guest_power_actions_do_not_create_implicit_drive_backup(self):
        source = (ROOT / "gcp-vm" / "power-action.sh").read_text(encoding="utf-8")
        body = source.split("perform_action() {", 1)[1].split("\n}\n", 1)[0]

        self.assertNotIn("run_backup", body)
        self.assertIn("stop|auto-stop)", body)
        self.assertIn("powering off without creating a Drive backup", body)

    def test_backend_stop_does_not_wait_for_backup(self):
        source = (ROOT / "cloud-run-vm-control" / "app.py").read_text(encoding="utf-8")
        body = source.split('if command == "stop":', 1)[1].split(
            '\n    if command == "restart":', 1
        )[0]

        self.assertNotIn("require_live_backup_ready", body)
        self.assertNotIn("poll_power_action_backup", body)
        self.assertIn('target_phase="stopping"', body)
        self.assertIn('poll_instance_status("TERMINATED", timeout_seconds=300)', body)

    def test_running_vm_allows_stop_before_backup_readiness(self):
        source = (ROOT / "cloud-run-vm-control" / "app.py").read_text(encoding="utf-8")
        body = source.split("def allowed_commands(", 1)[1].split("\ndef ", 1)[0]

        self.assertIn('["status", "set-auto-stop", "stop", "delete"]', body)

    def test_tokenless_refresh_cannot_hide_active_command_loader(self):
        source = (ROOT / "docs" / "vm-control" / "app.js").read_text(encoding="utf-8")
        body = source.split("function markPageReady(message, token) {", 1)[1].split(
            "\n  function ", 1
        )[0]

        self.assertIn("if (!token && state.activeCommand)", body)

    def test_stop_progress_does_not_claim_drive_backup(self):
        source = (ROOT / "docs" / "vm-control" / "app.js").read_text(encoding="utf-8")
        body = source.split('if (command === "stop") {', 1)[1].split("\n    }", 1)[0]

        self.assertNotIn("Google Drive", body)
        self.assertIn("Flushing local disk writes", body)


if __name__ == "__main__":
    unittest.main()
