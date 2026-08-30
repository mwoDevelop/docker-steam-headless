from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class AdminAccessContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.javascript = (ROOT / "docs" / "vm-control" / "admin.js").read_text(encoding="utf-8")
        cls.vm_control_javascript = (ROOT / "docs" / "vm-control" / "app.js").read_text(encoding="utf-8")
        cls.readonly_javascript = (ROOT / "docs" / "vm-control" / "readonly.js").read_text(encoding="utf-8")
        cls.html = (ROOT / "docs" / "vm-control" / "admin.html").read_text(encoding="utf-8")
        cls.backend = (ROOT / "cloud-run-vm-control" / "app.py").read_text(encoding="utf-8")

    def test_admin_controls_are_hidden_until_role_is_verified(self):
        self.assertIn('id="admin-protected-content" hidden', self.html)
        self.assertIn('id="admin-access-denied"', self.html)
        self.assertIn("elements.adminProtectedContent.hidden = !authorized", self.javascript)

    def test_frontend_checks_current_user_before_loading_admin_data(self):
        verification = self.javascript.split("async function verifyAdminSession(options) {", 1)[1].split(
            "\n  async function loadUsers", 1
        )[0]
        self.assertIn('fetchApi("/api/me"', verification)
        self.assertIn("!viewer.isAdmin", verification)
        self.assertIn("return loadUsers(options)", verification)
        session_message_handler = self.javascript.split('window.addEventListener("message"', 1)[1].split(
            "\n  function clearSession", 1
        )[0]
        shared_session_handler = self.javascript.split("async function acceptSharedSession(data) {", 1)[1].split(
            "\n  function requestSessionFromOtherTabs", 1
        )[0]
        self.assertIn("await verifyAdminSession()", shared_session_handler)
        self.assertIn("void acceptSharedSession(event.data)", session_message_handler)
        self.assertNotIn("await loadUsers()", session_message_handler)

    def test_non_admin_gets_dedicated_denied_state(self):
        self.assertIn("state.accessDenied = true", self.javascript)
        self.assertIn("Administrator permission required", self.html)
        self.assertIn("Use another Google account", self.html)

    def test_direct_admin_tab_requests_short_lived_session_from_same_origin_tabs(self):
        self.assertIn('new BroadcastChannel("vm-control-session-sync")', self.javascript)
        self.assertIn("requestSessionFromOtherTabs();", self.javascript)
        self.assertIn("sessionSyncRequestId", self.javascript)
        self.assertIn("void acceptSharedSession(event.data)", self.javascript)
        for responder in (self.readonly_javascript, self.vm_control_javascript):
            self.assertIn('new BroadcastChannel("vm-control-session-sync")', responder)
            self.assertIn("currentSharedSession()", responder)
            self.assertIn("expiresAt", responder)

    def test_shared_session_remains_tab_scoped_and_expiry_aware(self):
        self.assertIn("window.sessionStorage.setItem(storageKeys.sessionToken", self.javascript)
        self.assertNotIn("window.localStorage.setItem(storageKeys.sessionToken", self.javascript)
        self.assertIn("state.tokenExpiresAt <= Date.now()", self.javascript)
        self.assertIn("expiresAt && expiresAt <= Date.now()", self.javascript)
        self.assertIn("cross-tab-admin-session-20260830", self.html)

    def test_backend_still_guards_every_admin_route(self):
        route = self.backend.split('if request.path == "/api/admin/users":', 1)[1].split(
            'if request.path == "/api/admin/sunshine-credentials":', 1
        )[0]
        self.assertIn("admin_user = require_admin_user()", route)
        require_admin = self.backend.split("def require_admin_user()", 1)[1].split("\ndef ", 1)[0]
        self.assertIn('raise ApiError(f"Google account {email} is not an administrator.", 403)', require_admin)


if __name__ == "__main__":
    unittest.main()
