from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class GpuScanCancelContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.javascript = (ROOT / "docs" / "vm-control" / "app.js").read_text(encoding="utf-8")
        cls.html = (ROOT / "docs" / "vm-control" / "admin.html").read_text(encoding="utf-8")
        cls.backend = (ROOT / "cloud-run-vm-control" / "app.py").read_text(encoding="utf-8")

    def test_start_scan_label_is_not_limited_to_first_result(self):
        self.assertIn("Start selected VM using reserved GPU capacity", self.html)
        self.assertNotIn("Start selected VM after first available GPU", self.html)

    def test_cancel_aborts_active_request_and_clears_current_target(self):
        body = self.javascript.split("function cancelGpuAvailabilityScan() {", 1)[1].split(
            "\n  async function ", 1
        )[0]
        self.assertIn("run.abortController.abort()", body)
        self.assertIn('run.currentZone = ""', body)
        self.assertIn("run.currentTarget = null", body)
        self.assertIn("run.currentProfile = null", body)

    def test_cancel_releases_now_and_retries_cleanup_later(self):
        self.assertIn("releaseCancelledGpuScanReservations(run)", self.javascript)
        self.assertIn("GPU_SCAN_CANCEL_CLEANUP_DELAYS_MS = [10000, 60000]", self.javascript)
        self.assertIn('fetchApi("/api/capacity-reservations/release"', self.javascript)

    def test_cancelled_scan_is_not_reported_as_success(self):
        body = self.javascript.split("function gpuScanCompletionTone(run) {", 1)[1].split(
            "\n  function ", 1
        )[0]
        self.assertIn('run.cancelRequested ? "warning" : "success"', body)

    def test_release_all_cancels_scan_workflows_before_gce_reservations(self):
        body = self.backend.split("def release_all_managed_gpu_capacity()", 1)[1].split(
            "\ndef ", 1
        )[0]
        self.assertLess(
            body.index("release_cancel_safe_gpu_workflows()"),
            body.index("release_managed_capacity_reservations()"),
        )
        route = self.backend.split('if request.path == "/api/capacity-reservations/release":', 1)[1].split(
            "\n    if request.path", 1
        )[0]
        self.assertIn("release_all_managed_gpu_capacity()", route)

    def test_cancel_message_does_not_claim_cleanup_is_already_complete(self):
        self.assertIn("Managed reservation cleanup was requested and is being verified", self.javascript)


if __name__ == "__main__":
    unittest.main()
