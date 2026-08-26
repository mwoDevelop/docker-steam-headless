import os
import inspect
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import app as vm_control


class GpuQuotaScanContractTests(unittest.TestCase):
    def setUp(self):
        self.original_project = vm_control.CONFIG["project"]
        vm_control.CONFIG["project"] = "unit-test-project"

    def tearDown(self):
        vm_control.CONFIG["project"] = self.original_project

    def test_quota_failure_stops_scan_and_is_not_capacity_failure(self):
        result = vm_control.gpu_capacity_failure_details(
            vm_control.ApiError("Quota exceeded for quota metric 'GPUs (all regions)'.", 403)
        )
        self.assertEqual(result["failureCode"], "GPU_QUOTA_EXHAUSTED")
        self.assertTrue(result["scanFatal"])
        self.assertTrue(result["quotaBlocked"])

    def test_rate_limit_stops_scan_without_requesting_vm_stop(self):
        result = vm_control.gpu_capacity_failure_details(
            vm_control.ApiError("RATE_LIMIT_EXCEEDED: GlobalReadsPerMinutePerProject", 403)
        )
        self.assertEqual(result["failureCode"], "COMPUTE_API_RATE_LIMITED")
        self.assertTrue(result["scanFatal"])
        self.assertFalse(result["quotaBlocked"])

    def test_capacity_exhaustion_allows_next_zone(self):
        result = vm_control.gpu_capacity_failure_details(
            vm_control.ApiError("ZONE_RESOURCE_POOL_EXHAUSTED: currently unavailable", 409)
        )
        self.assertEqual(result["failureCode"], "GPU_CAPACITY_UNAVAILABLE")
        self.assertFalse(result["scanFatal"])

    def test_probe_rejects_reservation_consumed_by_existing_vm(self):
        profile = {
            "id": "t4",
            "machineType": "n1-standard-4",
            "gpuType": "nvidia-tesla-t4",
            "gpuCount": 1,
            "acceleratorMode": "attached",
        }
        workflow = {
            "workflowId": "gpu-workflow-1",
            "reservationName": "gpu-reservation-1",
            "operation": "create",
        }
        responses = [
            {"name": "operation-1"},
            {"specificReservation": {"inUseCount": "1"}},
        ]
        with (
            patch.object(vm_control, "compute_request", side_effect=responses),
            patch.object(vm_control, "wait_for_zone_operation"),
            patch.object(vm_control, "release_gpu_workflow"),
            patch.object(vm_control, "safe_running_gpu_instance_payloads", return_value=[{"name": "running-gpu"}]),
        ):
            result = vm_control.probe_gpu_capacity_zone(
                profile,
                "europe-central2-b",
                "token",
                hold_workflow=workflow,
            )

        self.assertFalse(result["available"])
        self.assertEqual(result["failureCode"], "GPU_RESERVATION_ALREADY_CONSUMED")
        self.assertTrue(result["scanFatal"])
        self.assertEqual(result["runningGpuInstances"][0]["name"], "running-gpu")

    def test_frontend_routes_every_zone_probe_through_quota_recovery(self):
        root = os.path.dirname(os.path.dirname(__file__))
        with open(os.path.join(root, "docs", "vm-control", "app.js"), encoding="utf-8") as source:
            javascript = source.read()
        self.assertEqual(javascript.count("const data = await scanGpuZoneWithQuotaRecovery("), 4)
        self.assertIn('/api/capacity-reservations/prepare-scan', javascript)
        self.assertIn('GPU capacity scan stopped without changing the running VM.', javascript)
        self.assertIn(': String(value && value.message || "");', javascript)
        self.assertIn('setCapacityButtonResult(elements.checkGpuCapacity, "GPU Reservation Cancelled", "neutral")', javascript)
        self.assertIn('if (quotaRecoveryPerformed) {', javascript)
        self.assertIn('mergeCurrentStatus: false', javascript)
        self.assertIn('function activeGpuAvailabilityScanRun()', javascript)
        self.assertIn('dataset.scanActionActive === "true"', javascript)
        self.assertIn('const cancellingScan = action === "cancel-scan";', javascript)
        self.assertIn('window.setTimeout(() => abortController.abort(), 20000)', javascript)
        self.assertIn('const explicitlySelected = instances.find(', javascript)
        self.assertIn('String(endpoint && endpoint.id || "") === endpointId', javascript)

    def test_standalone_capacity_probe_does_not_depend_on_hold_workflow(self):
        source = inspect.getsource(vm_control.create_capacity_reservation_probe)
        self.assertNotIn("hold_workflow", source)

    def test_running_gpu_payload_maps_endpoint_by_instance_and_zone(self):
        instance = {
            "name": "running-p100",
            "zone": "projects/unit-test-project/zones/europe-west1-b",
        }
        with (
            patch.object(
                vm_control,
                "instance_hardware_selection",
                return_value={"id": "p100", "label": "GPU P100", "gpuType": "nvidia-tesla-p100", "gpuCount": 1},
            ),
            patch.object(
                vm_control,
                "read_endpoint_records",
                return_value=[
                    {"id": "wrong-zone", "instanceName": "running-p100", "zone": "europe-west1-c"},
                    {"id": "mwo-vm2", "instanceName": "running-p100", "zone": "europe-west1-b"},
                ],
            ),
        ):
            result = vm_control.running_gpu_instance_public_payload(instance)

        self.assertEqual(result["endpointId"], "mwo-vm2")
        self.assertEqual(result["zone"], "europe-west1-b")

    def test_standalone_capacity_probe_rejects_reservation_consumed_by_running_vm(self):
        responses = [
            None,
            {"name": "operation-1"},
            {
                "name": "steam-gpu-capacity-probe",
                "specificReservation": {"inUseCount": "1"},
            },
        ]
        with (
            patch.object(vm_control, "selected_gpu_count", return_value=1),
            patch.object(vm_control, "selected_gpu_type", return_value="nvidia-tesla-p100"),
            patch.object(vm_control, "selected_machine_type", return_value="n1-standard-4"),
            patch.object(vm_control, "selected_accelerator_mode", return_value="attached"),
            patch.object(vm_control, "selected_zone", return_value="europe-west1-b"),
            patch.object(vm_control, "capacity_reservation_name", return_value="steam-gpu-capacity-probe"),
            patch.object(vm_control, "compute_request", side_effect=responses),
            patch.object(vm_control, "wait_for_zone_operation"),
            patch.object(vm_control, "delete_capacity_reservation") as delete_reservation,
            patch.object(vm_control, "safe_running_gpu_instance_payloads", return_value=[{"name": "running-p100"}]),
        ):
            with self.assertRaises(vm_control.ApiError) as raised:
                vm_control.create_capacity_reservation_probe()

        self.assertEqual(raised.exception.details["failureCode"], "GPU_RESERVATION_ALREADY_CONSUMED")
        self.assertEqual(raised.exception.details["runningGpuInstances"][0]["name"], "running-p100")
        delete_reservation.assert_called_once()


if __name__ == "__main__":
    unittest.main()
