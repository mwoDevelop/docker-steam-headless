from pathlib import Path
import inspect
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cloud-run-vm-control"))

import app as vm_control  # noqa: E402


class MinecraftContentProgressTests(unittest.TestCase):
    def test_request_contains_provider_neutral_operation_fields(self):
        request = vm_control.minecraft_content_sync_request(
            [],
            operation_id="operation_1234567890",
            kind="install",
            target="Example content",
            provider="future-provider",
        )
        self.assertEqual("operation_1234567890", request["id"])
        self.assertEqual("content-sync", request["action"])
        self.assertEqual("install", request["kind"])
        self.assertEqual("Example content", request["target"])
        self.assertEqual("future-provider", request["provider"])
        self.assertEqual(7, request["stageCount"])

    def test_agent_reports_all_generic_stages(self):
        script = (ROOT / "gcp-vm" / "minecraft-management.sh").read_text(encoding="utf-8")
        positions = [script.index(f'"{stage}"') for stage in (
            "preparing",
            "applying",
            "restarting",
            "health-check",
            "verifying",
            "finalizing",
        )]
        self.assertEqual(sorted(positions), positions)
        self.assertIn("publish_content_progress", script)
        self.assertIn("publish_content_result", script)
        self.assertIn('kill -0 "$reconcile_pid"', script)
        self.assertIn('stageCount:(if $action == "content-sync" then 7', script)

    def test_frontend_polls_and_resumes_content_operation(self):
        javascript = (ROOT / "docs" / "vm-control" / "minecraft-admin.js").read_text(encoding="utf-8")
        self.assertIn("pollContentOperation", javascript)
        self.assertIn("startContentTracking", javascript)
        self.assertIn("isActiveContentResult", javascript)
        self.assertIn("Content operation is still running", javascript)
        self.assertIn("contentOperationSnapshot", javascript)

    def test_start_refreshes_management_agent_for_existing_vm(self):
        source = inspect.getsource(vm_control.start_metadata_updates)
        self.assertIn('updates["vm-minecraft-management-script"]', source)
        self.assertIn('decode_config_b64("vm_minecraft_management_script_b64")', source)

    def test_progress_ui_is_not_modrinth_specific(self):
        html = (ROOT / "docs" / "vm-control" / "minecraft-admin.html").read_text(encoding="utf-8")
        javascript = (ROOT / "docs" / "vm-control" / "minecraft-admin.js").read_text(encoding="utf-8")
        self.assertIn('id="content-operation-progress"', html)
        self.assertIn("CONTENT OPERATION", javascript)
        self.assertIn("Applying content", javascript)
        self.assertNotIn("Applying Modrinth content and restarting Minecraft", javascript)


if __name__ == "__main__":
    unittest.main()
