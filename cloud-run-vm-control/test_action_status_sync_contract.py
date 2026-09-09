from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ActionStatusSyncContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin_javascript = (ROOT / "docs" / "vm-control" / "admin.js").read_text(encoding="utf-8")
        cls.app_javascript = (ROOT / "docs" / "vm-control" / "app.js").read_text(encoding="utf-8")
        cls.html = (ROOT / "docs" / "vm-control" / "admin.html").read_text(encoding="utf-8")

    def test_admin_broadcasts_action_status_across_tabs_and_window(self):
        self.assertIn('new BroadcastChannel("vm-control-action-status")', self.admin_javascript)
        self.assertIn('function broadcastActionStatus(type, command, endpointId)', self.admin_javascript)
        self.assertIn('window.dispatchEvent(new CustomEvent("vm-control:action-status"', self.admin_javascript)

    def test_admin_operations_notify_action_lifecycle(self):
        for op in ('updateRuntimeImages', 'updateSoftware', 'updateMigration'):
            body = self.admin_javascript.split(f"async function {op}(", 1)[1].split("\n  async function ", 1)[0]
            self.assertIn('broadcastActionStatus("started"', body)
            self.assertIn('broadcastActionStatus("settled"', body)
            self.assertIn('broadcastActionStatus("failed"', body)

    def test_app_listens_to_cross_tab_and_same_window_action_notifications(self):
        self.assertIn('new BroadcastChannel("vm-control-action-status")', self.app_javascript)
        self.assertIn('window.addEventListener("vm-control:action-status"', self.app_javascript)
        self.assertIn('function handleActionStatusNotification(data)', self.app_javascript)
        self.assertIn('schedulePassiveStatusRefresh(250)', self.app_javascript)

    def test_passive_refresh_clears_progress_and_updates_settled_status(self):
        refresh = self.app_javascript.split("async function runPassiveStatusRefresh() {", 1)[1].split(
            "\n  function handleActionStatusNotification", 1
        )[0]
        self.assertIn("state.passiveRunningAction = action;", refresh)
        self.assertIn("clearOperationProgress();", refresh)
        self.assertIn('setCommandStatus(statusBannerMessage("VM status loaded", payload), statusMessageTone(payload));', refresh)

    def test_admin_tab_switch_fast_refreshes_status(self):
        tab_switch = self.app_javascript.split('event.detail.tab === "vm-control"', 1)[1].split(
            "\n    });", 1
        )[0]
        self.assertIn("schedulePassiveStatusRefresh(50);", tab_switch)

    def test_script_cache_keys_are_versioned(self):
        self.assertRegex(self.html, r'admin\.js\?v=[a-z0-9-]+')
        self.assertRegex(self.html, r'app\.js\?v=[a-z0-9-]+')


if __name__ == "__main__":
    unittest.main()
