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
        self.assertIn("gpu-scan-dialog-20260827", self.html)

    def test_reserved_create_target_uses_workflow_endpoint_not_stale_selection(self):
        create_modal = self.javascript.split("function selectPostCreateApplications(target, options = {}) {", 1)[1].split(
            "\n  function ", 1
        )[0]
        self.assertIn("heldWorkflow.endpoint && heldWorkflow.endpoint.domain", create_modal)


if __name__ == "__main__":
    unittest.main()
