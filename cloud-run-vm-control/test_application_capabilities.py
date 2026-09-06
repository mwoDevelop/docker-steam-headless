import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import app as vm_control


class ApplicationCapabilitiesTests(unittest.TestCase):
    def test_cpu_vm_has_no_sunshine_credentials_capability(self):
        instance = {"status": "TERMINATED"}
        with (
            patch.object(vm_control, "is_gpu_disabled_for_instance", return_value=True),
            patch.object(vm_control, "sunshine_credentials_from_instance", return_value={"username": "admin", "password": "secret-value"}),
            patch.object(vm_control, "selected_endpoint", return_value={}),
            patch.object(vm_control, "endpoint_public_payload", return_value={"id": "mwo-vm1"}),
            patch.object(vm_control, "build_sunshine_status", return_value={"state": "disabled"}),
        ):
            payload = vm_control.build_admin_sunshine_credentials_payload(
                admin_user={"email": "admin@example.com"},
                instance=instance,
                include_password=True,
            )

        self.assertFalse(payload["sunshineAvailable"])
        self.assertFalse(payload["canUpdate"])
        self.assertFalse(payload["passwordAvailable"])
        self.assertEqual(payload["credentials"]["password"], "")

    def test_runtime_image_capabilities_follow_installed_components(self):
        instance = {"status": "RUNNING"}
        runtime_state = {
            "steam-headless": {"previousRef": "steam-previous"},
            "minecraft": {"previousRef": "minecraft-previous"},
        }
        with (
            patch.object(vm_control, "runtime_image_agent_ready", return_value=True),
            patch.object(vm_control, "active_power_action", return_value=None),
            patch.object(vm_control, "is_live_backup_ready", return_value=True),
            patch.object(vm_control, "is_gpu_disabled_for_instance", return_value=True),
            patch.object(vm_control, "minecraft_runtime_available", return_value=False),
            patch.object(vm_control, "minecraft_state", return_value="not_installed"),
            patch.object(vm_control, "runtime_image_instance_payload", return_value=runtime_state),
        ):
            capabilities = vm_control.runtime_image_capabilities(instance)

        self.assertFalse(capabilities["steam-headless"]["canPull"])
        self.assertFalse(capabilities["steam-headless"]["canApply"])
        self.assertFalse(capabilities["minecraft"]["canPull"])
        self.assertFalse(capabilities["minecraft"]["canRollback"])


if __name__ == "__main__":
    unittest.main()
