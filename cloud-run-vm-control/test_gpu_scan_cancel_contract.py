from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class GpuScanCancelContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.javascript = (ROOT / "docs" / "vm-control" / "app.js").read_text(encoding="utf-8")
        cls.html = (ROOT / "docs" / "vm-control" / "admin.html").read_text(encoding="utf-8")

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


if __name__ == "__main__":
    unittest.main()
