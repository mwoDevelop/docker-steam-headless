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
                ["chrome"],
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
                ["prism", "chrome"],
            )

    def test_steam_is_a_native_core_component_not_an_optional_flatpak(self):
        self.assertNotIn("steam", vm_control.APPLICATION_IDS)
        self.assertFalse(any(item.get("id") == "steam" for item in vm_control.APPLICATION_CATALOG))
        root = os.path.dirname(os.path.dirname(__file__))
        with open(os.path.join(root, "gcp-vm", "power-action.sh"), encoding="utf-8") as source:
            script = source.read()
        self.assertIn('update_sunshine_apps install Steam "/usr/games/steam -silent"', script)
        self.assertIn("/home/default/.steam/ubuntu12_32/steam", script)
        self.assertNotIn("/home/default/.steam/steam/ubuntu12_32/steam", script)
        self.assertNotIn("install_flatpak_application com.valvesoftware.Steam", script)

        with open(os.path.join(root, "gcp-vm", "startup.sh"), encoding="utf-8") as source:
            startup_script = source.read()
        self.assertIn("detect_steam_version()", startup_script)
        self.assertIn('docker exec -i --user root "$container_id" bash -s', startup_script)
        self.assertIn(".local/share/Steam/package/steam_client_ubuntu12.installed", startup_script)
        self.assertIn("logs/bootstrap_log.txt", startup_script)
        self.assertIn("awk '$0 !~ /^0([.]0)*$/'", startup_script)
        self.assertIn("preserving the previously published version", startup_script)

    def test_gui_waits_for_delayed_sunshine_version_metadata(self):
        root = os.path.dirname(os.path.dirname(__file__))
        with open(os.path.join(root, "docs", "vm-control", "app.js"), encoding="utf-8") as source:
            javascript = source.read()
        self.assertIn("Date.now() + 120000", javascript)

    def test_vm_agent_restores_parent_status_and_tracks_inventory(self):
        root = os.path.dirname(os.path.dirname(__file__))
        with open(os.path.join(root, "gcp-vm", "power-action.sh"), encoding="utf-8") as source:
            script = source.read()
        self.assertIn('INSTALLED_APPLICATION_IDS_METADATA_KEY="vm-installed-application-ids"', script)
        self.assertIn('update_installed_applications_metadata "$action" "$app_id"', script)
        self.assertIn('run_application_action "install-app" "$token" "$action"', script)
        self.assertIn('visible_action="${parent_action:-$action}"', script)
        self.assertIn('[[ -n "$parent_action" ]] && failure_phase="running"', script)

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
