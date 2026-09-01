from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cloud-run-vm-control"))

import app as vm_control  # noqa: E402


class MinecraftModrinthEnvironmentTests(unittest.TestCase):
    @staticmethod
    def candidate(identifier: str, environment: object, loader: str = "fabric") -> dict:
        return {
            "id": identifier,
            "environment": environment,
            "loaders": [loader],
            "files": [
                {
                    "filename": f"{identifier}.jar",
                    "primary": True,
                    "hashes": {"sha512": "a" * 128},
                }
            ],
        }

    def test_current_environment_values_are_classified(self):
        self.assertEqual("blocked", vm_control.modrinth_environment_details(self.candidate("client", "client_only"))["status"])
        self.assertEqual("blocked", vm_control.modrinth_environment_details(self.candidate("solo", "singleplayer_only"))["status"])
        self.assertEqual("compatible", vm_control.modrinth_environment_details(self.candidate("server", "server_only"))["status"])
        details = vm_control.modrinth_environment_details(self.candidate("both", "client_and_server"))
        self.assertEqual("warning", details["status"])
        self.assertTrue(details["clientRequired"])

    def test_missing_or_future_environment_is_warning_not_blocked(self):
        for environment in (None, "future_environment"):
            details = vm_control.modrinth_environment_details(self.candidate("unknown", environment))
            self.assertEqual("unknown", details["environment"])
            self.assertEqual("warning", details["status"])

    def test_legacy_environment_object_remains_supported(self):
        self.assertEqual(
            "client_only",
            vm_control.normalize_modrinth_environment(self.candidate("legacy-client", {"client": "required", "server": "unsupported"})),
        )
        self.assertEqual(
            "client_and_server",
            vm_control.normalize_modrinth_environment(self.candidate("legacy-both", {"client": "required", "server": "required"})),
        )

    def test_selector_skips_client_only_candidate(self):
        blocked = self.candidate("blocked", "client_only")
        compatible = self.candidate("compatible", "server_only")
        selected = vm_control.select_compatible_modrinth_version([blocked, compatible], ["fabric"])
        self.assertIsNotNone(selected)
        self.assertEqual("compatible", selected[0]["id"])

    def test_paper_does_not_automatically_accept_purpur_only_plugin(self):
        self.assertNotIn("purpur", vm_control.MINECRAFT_SERVER_TYPES["paper"]["modrinthLoaders"])
        self.assertIn("purpur", vm_control.MINECRAFT_SERVER_TYPES["purpur"]["modrinthLoaders"])

    def test_frontend_renders_environment_and_warnings(self):
        javascript = (ROOT / "docs" / "vm-control" / "minecraft-admin.js").read_text(encoding="utf-8")
        self.assertIn("Environment:", javascript)
        self.assertIn("matching client installation required", javascript)
        self.assertIn("compatibilityWarnings", javascript)


if __name__ == "__main__":
    unittest.main()
