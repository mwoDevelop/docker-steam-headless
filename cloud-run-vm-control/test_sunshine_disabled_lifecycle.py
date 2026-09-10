import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
import app as vm_control


class SunshineDisabledLifecycleTests(unittest.TestCase):
    def test_cpu_capability_takes_precedence_over_guest_and_action_status(self):
        actions = ["", "start", "restart", "stop", "auto-stop", "delete",
                   "create-backup", "restore-backup", "install-app",
                   "apply-sunshine-password", "update-runtime-image"]
        for guest_state in ["", "starting", "ready", "error", "disabled"]:
            for action in actions:
                with self.subTest(state=guest_state, action=action):
                    instance = {"status": "RUNNING", "metadata": {"items": [
                        {"key": vm_control.SUNSHINE_STATUS_METADATA_KEY, "value": guest_state},
                        {"key": vm_control.SUNSHINE_STATUS_DETAIL_METADATA_KEY, "value": "VM startup in progress."},
                    ]}}
                    with (
                        patch.object(vm_control, "is_gpu_disabled_for_instance", return_value=True),
                        patch.object(vm_control, "parse_power_action_status", return_value=("running", action, "")) as parse,
                    ):
                        payload = vm_control.build_sunshine_status(instance)
                    self.assertEqual(payload["state"], "disabled")
                    self.assertEqual(payload["label"], "Disabled")
                    self.assertNotIn("startup in progress", payload["detail"])
                    parse.assert_not_called()

    def test_stopped_and_missing_vm_keep_their_lifecycle_status(self):
        with patch.object(vm_control, "is_gpu_disabled_for_instance", return_value=True) as disabled:
            self.assertEqual(vm_control.build_sunshine_status(None)["state"], "not_created")
            for state in ["TERMINATED", "STOPPING", "PROVISIONING", "STAGING"]:
                with self.subTest(state=state):
                    self.assertEqual(vm_control.build_sunshine_status({"status": state})["state"], "stopped")
            disabled.assert_not_called()

    def test_gpu_restart_still_reports_restarting(self):
        with (
            patch.object(vm_control, "is_gpu_disabled_for_instance", return_value=False),
            patch.object(vm_control, "parse_power_action_status", return_value=("running", "restart", "")),
        ):
            payload = vm_control.build_sunshine_status({"status": "RUNNING"})
        self.assertEqual(payload["state"], "starting")
        self.assertEqual(payload["label"], "Restarting")

    def test_gpu_ready_detection_is_preserved(self):
        with (
            patch.object(vm_control, "is_gpu_disabled_for_instance", return_value=False),
            patch.object(vm_control, "parse_power_action_status", return_value=("", "", "")),
            patch.object(vm_control, "instance_accelerator_summary", return_value=("nvidia-l4", 1)),
            patch.object(vm_control, "is_sunshine_started", return_value=True),
        ):
            payload = vm_control.build_sunshine_status({"status": "RUNNING"})
        self.assertEqual(payload["state"], "ready")
        self.assertEqual(payload["label"], "Ready")


if __name__ == "__main__":
    unittest.main()
