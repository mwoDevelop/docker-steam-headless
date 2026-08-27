import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class MigrationUiContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.javascript = (ROOT / "docs/vm-control/admin.js").read_text(encoding="utf-8")
        cls.html = (ROOT / "docs/vm-control/admin.html").read_text(encoding="utf-8")
        cls.backend = (ROOT / "cloud-run-vm-control/app.py").read_text(encoding="utf-8")

    def test_active_migration_blocks_source_and_target_endpoint(self):
        renderer = self.javascript.split("function renderMigrations() {", 1)[1].split("\n  function ", 1)[0]
        self.assertIn('new Set(["preparing", "prepared", "starting", "failed", "cleanup_pending"])', renderer)
        self.assertIn("!blockedSourceIds.has", renderer)
        self.assertIn("!blockedEndpointIds.has", renderer)
        self.assertIn('{"preparing", "prepared", "starting", "failed", "cleanup_pending"}', self.backend)

    def test_specific_admin_loader_message_is_not_overwritten(self):
        loader = self.javascript.split("function setAdminPageLoading(nextBusy, message) {", 1)[1].split("\n  function ", 1)[0]
        self.assertIn("if (loaderMessage && message)", loader)
        self.assertIn("Preparing migration snapshot and target state disk...", self.javascript)

    def test_admin_javascript_cache_key_is_versioned(self):
        self.assertRegex(self.html, r'admin\.js\?v=[a-z0-9-]+')


if __name__ == "__main__":
    unittest.main()
