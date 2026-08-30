from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ReservedGpuModalContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.javascript = (ROOT / "docs" / "vm-control" / "app.js").read_text(encoding="utf-8")
        cls.html = (ROOT / "docs" / "vm-control" / "admin.html").read_text(encoding="utf-8")
        cls.backend = (ROOT / "cloud-run-vm-control" / "app.py").read_text(encoding="utf-8")

    def test_backend_carries_canonical_hardware_label_in_reserved_target(self):
        workflow = self.backend.split("def begin_gpu_hold_workflow(", 1)[1].split("\ndef transition_gpu_workflow", 1)[0]
        self.assertIn('"hardwareLabel": str(profile.get("label") or profile["id"])', workflow)

    def test_create_and_start_modals_render_the_same_reserved_gpu_details(self):
        create_modal = self.javascript.split("function selectPostCreateApplications(target, options = {}) {", 1)[1].split(
            "\n  function ", 1
        )[0]
        start_modal = self.javascript.split("function selectReservedStart(target, prepared) {", 1)[1].split(
            "\n  function ", 1
        )[0]
        self.assertIn("renderReservedGpuSummary(", create_modal)
        self.assertIn("renderReservedGpuSummary(", start_modal)

    def test_reserved_gpu_card_shows_name_type_zone_expiry_and_reservation(self):
        renderer = self.javascript.split("function renderReservedGpuSummary(", 1)[1].split("\n  function ", 1)[0]
        for label in ("Reserved GPU", "GPU type", "Zone", "Reserved until", "Reservation"):
            self.assertIn(label, renderer)
        self.assertIn('class="reserved-gpu-card"', renderer)
        self.assertRegex(self.html, r'app\.js\?v=[a-z0-9-]+')

    def test_held_gpu_target_is_applied_after_zone_options_are_rendered(self):
        selector = self.javascript.split("function applyHeldGpuTargetSelection(target) {", 1)[1].split(
            "\n  function ", 1
        )[0]
        self.assertLess(selector.index("renderHardwareOptions(state.hardwarePayload);"), selector.index("elements.zoneSelect.value = zone;"))
        self.assertIn("elements.zoneSelect.add(new Option(zoneDisplayLabel(zone), zone));", selector)
        self.assertIn("saveConfig();", selector)

    def test_reserved_create_target_uses_workflow_endpoint_not_stale_selection(self):
        create_modal = self.javascript.split("function selectPostCreateApplications(target, options = {}) {", 1)[1].split(
            "\n  function ", 1
        )[0]
        self.assertIn("heldWorkflow.endpoint && heldWorkflow.endpoint.domain", create_modal)

    def test_reserved_relocation_persists_auto_stop_before_migration_start(self):
        workflow = self.javascript.split("async function handleHeldGpuCapacity(run, prepared) {", 1)[1].split(
            "\n  function ", 1
        )[0]
        self.assertIn("const autoStopHours = readAutoStopHours(operation);", workflow)
        self.assertIn("migrationPrepareBody.autoStopHours = autoStopHours", workflow)
        self.assertIn("body: JSON.stringify(migrationPrepareBody)", workflow)

    def test_backend_uses_persisted_auto_stop_for_relocated_vm(self):
        migration = self.backend.split("def execute_admin_migration_action(", 1)[1].split(
            "\ndef ", 1
        )[0]
        self.assertIn('auto_stop_hours = parse_auto_stop_hours(payload) if mode == "relocate-start" else None', migration)
        self.assertIn('"autoStopHours": auto_stop_hours', migration)
        self.assertIn('auto_stop_hours=target.get("autoStopHours")', migration)


if __name__ == "__main__":
    unittest.main()
