import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import app as vm_control


class ApplicationInventoryContractTests(unittest.TestCase):
    def test_explicit_installed_application_metadata_is_normalized(self):
        values = {
            vm_control.INSTALLED_APPLICATION_IDS_METADATA_KEY: "steam,chrome,steam,unsupported",
        }
        with patch.object(vm_control, "metadata_value", side_effect=lambda _instance, key: values.get(key, "")):
            self.assertEqual(
                vm_control.installed_application_ids_from_instance({}),
                ["steam", "chrome"],
            )

    def test_completed_post_create_list_is_backward_compatible(self):
        values = {
            vm_control.INSTALLED_APPLICATION_IDS_METADATA_KEY: "",
            vm_control.POST_CREATE_APPLICATION_IDS_METADATA_KEY: "steam,prism,chrome",
            vm_control.POST_CREATE_APPLICATIONS_RESULT_METADATA_KEY: "completed:3/3",
        }
        with patch.object(vm_control, "metadata_value", side_effect=lambda _instance, key: values.get(key, "")):
            self.assertEqual(
                vm_control.installed_application_ids_from_instance({}),
                ["steam", "prism", "chrome"],
            )

    def test_vm_agent_restores_parent_status_and_tracks_inventory(self):
        root = os.path.dirname(os.path.dirname(__file__))
        with open(os.path.join(root, "gcp-vm", "power-action.sh"), encoding="utf-8") as source:
            script = source.read()
        self.assertIn('INSTALLED_APPLICATION_IDS_METADATA_KEY="vm-installed-application-ids"', script)
        self.assertIn('update_installed_applications_metadata "$action" "$app_id"', script)
        self.assertGreaterEqual(
            script.count('set_power_action_status "$action" "$token" "running" "${action}:${token}"'),
            2,
        )

    def test_admin_gui_renders_and_enforces_application_inventory(self):
        root = os.path.dirname(os.path.dirname(__file__))
        with open(os.path.join(root, "docs", "vm-control", "admin.js"), encoding="utf-8") as source:
            javascript = source.read()
        with open(os.path.join(root, "docs", "vm-control", "admin.html"), encoding="utf-8") as source:
            html = source.read()
        self.assertIn('softwareApplicationState: document.querySelector("#software-application-state")', javascript)
        self.assertIn('Applications ${installedApplications.size}/${applications.length} installed', javascript)
        self.assertIn('command === "install-app" && selectedApplicationInstalled', javascript)
        self.assertIn('command === "uninstall-app" && !selectedApplicationInstalled', javascript)
        self.assertIn('id="software-application-state"', html)


if __name__ == "__main__":
    unittest.main()
