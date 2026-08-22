import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import app as vm_control


class GpuScanCreateContractTests(unittest.TestCase):
    def setUp(self):
        self.original_secret = vm_control.CONFIG["session_token_secret"]
        self.original_project = vm_control.CONFIG["project"]
        vm_control.CONFIG["session_token_secret"] = "unit-test-session-secret-at-least-32-bytes"
        vm_control.CONFIG["project"] = "unit-test-project"

    def tearDown(self):
        vm_control.CONFIG["session_token_secret"] = self.original_secret
        vm_control.CONFIG["project"] = self.original_project

    def test_scan_create_token_carries_held_workflow_identity(self):
        token, expires_at = vm_control.create_scan_create_token(
            user={"email": "admin@example.com"},
            endpoint_id="mwo-vm2",
            hardware_id="l4",
            zone="europe-west3-a",
            workflow_id="gpu-workflow-1",
            reservation_name="gpu-reservation-1",
        )

        payload = vm_control.decode_scan_create_token(token)

        self.assertEqual(payload["workflowId"], "gpu-workflow-1")
        self.assertEqual(payload["reservationName"], "gpu-reservation-1")
        self.assertEqual(payload["endpointId"], "mwo-vm2")
        self.assertGreater(expires_at, int(datetime.now(timezone.utc).timestamp()))

    def test_held_probe_does_not_release_successful_reservation(self):
        profile = {
            "id": "l4",
            "machineType": "g2-standard-4",
            "gpuType": "nvidia-l4",
            "gpuCount": 1,
            "acceleratorMode": "embedded",
        }
        workflow = {
            "workflowId": "gpu-workflow-1",
            "reservationName": "gpu-reservation-1",
        }
        transitioned = {**workflow, "state": "HELD"}
        with (
            patch.object(vm_control, "compute_request", return_value={"name": "operation-1"}),
            patch.object(vm_control, "wait_for_zone_operation"),
            patch.object(vm_control, "transition_gpu_workflow", return_value=transitioned) as transition,
            patch.object(vm_control, "delete_capacity_reservation") as delete_reservation,
        ):
            result = vm_control.probe_gpu_capacity_zone(
                profile,
                "europe-west3-a",
                "token",
                hold_workflow=workflow,
            )

        self.assertTrue(result["available"])
        self.assertTrue(result["heldForCreate"])
        self.assertFalse(result["releasedReservation"])
        transition.assert_called_once()
        delete_reservation.assert_not_called()

    def test_validate_preparation_requires_matching_held_workflow(self):
        token, _ = vm_control.create_scan_create_token(
            user={"email": "admin@example.com"},
            endpoint_id="mwo-vm2",
            hardware_id="l4",
            zone="europe-west3-a",
            workflow_id="gpu-workflow-1",
            reservation_name="gpu-reservation-1",
        )
        workflow = {
            "workflowId": "gpu-workflow-1",
            "owner": "admin@example.com",
            "state": "HELD",
            "expiresAt": datetime.now(timezone.utc) + timedelta(minutes=4),
            "reservationName": "gpu-reservation-1",
            "target": {
                "endpointId": "mwo-vm2",
                "hardwareId": "l4",
                "zone": "europe-west3-a",
            },
        }
        with (
            patch.object(vm_control, "selected_endpoint_id", return_value="mwo-vm2"),
            patch.object(vm_control, "selected_hardware_id", return_value="l4"),
            patch.object(vm_control, "selected_zone", return_value="europe-west3-a"),
            patch.object(vm_control, "selected_endpoint", return_value={"id": "mwo-vm2"}),
            patch.object(vm_control, "endpoint_available_for_scan_create", return_value=True),
            patch.object(vm_control, "get_gpu_workflow", return_value=workflow),
        ):
            result = vm_control.validate_scan_create_preparation(
                {
                    "scanCreateToken": token,
                    "gpuWorkflowId": "gpu-workflow-1",
                },
                {"email": "admin@example.com"},
            )

        self.assertEqual(result, workflow)

    def test_expired_workflow_is_not_createable(self):
        self.assertTrue(vm_control.gpu_workflow_expired({
            "expiresAt": datetime.now(timezone.utc) - timedelta(seconds=1),
        }))


if __name__ == "__main__":
    unittest.main()
