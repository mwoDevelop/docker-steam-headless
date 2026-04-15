import base64
import gzip
import logging
import os
import secrets
import time
from functools import lru_cache
from typing import Any

import google.auth
from flask import Flask, jsonify, make_response, request
from google.auth.transport.requests import AuthorizedSession, Request
from google.oauth2 import id_token
import requests


app = Flask(__name__)
logging.basicConfig(level=logging.INFO)


class ApiError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def csv_env(name: str) -> list[str]:
    raw = os.environ.get(name, "")
    return [value.strip() for value in raw.split(",") if value.strip()]


def normalize_duckdns_domains(raw_domains: list[str]) -> list[str]:
    domains: list[str] = []
    for value in raw_domains:
        value = value.strip()
        if not value:
            continue
        value = value.removesuffix(".duckdns.org")
        value = value.removeprefix("https://")
        value = value.removeprefix("http://")
        value = value.split("/", 1)[0]
        value = value.split(":", 1)[0]
        if value:
            domains.append(f"{value}.duckdns.org")
    return domains


CONFIG = {
    "project": os.environ.get("GCP_PROJECT", ""),
    "zone": os.environ.get("GCP_ZONE", ""),
    "instance": os.environ.get("GCE_NAME", ""),
    "machine_type": os.environ.get("MACHINE_TYPE", "n1-standard-4"),
    "gpu_type": os.environ.get("GPU_TYPE", "nvidia-tesla-t4"),
    "gpu_count": int(os.environ.get("GPU_COUNT", "1") or "1"),
    "boot_disk_size": os.environ.get("BOOT_DISK_SIZE", "120GB"),
    "boot_disk_type": os.environ.get("BOOT_DISK_TYPE", "pd-ssd"),
    "data_disk_size": os.environ.get("DATA_DISK_SIZE", "300GB"),
    "data_disk_type": os.environ.get("DATA_DISK_TYPE", "pd-balanced"),
    "data_disk_device_name": os.environ.get("DATA_DISK_DEVICE_NAME", "steam-state"),
    "data_disk_mount_root": os.environ.get("DATA_DISK_MOUNT_ROOT", "/mnt/state"),
    "vm_image_family": os.environ.get("VM_IMAGE_FAMILY", "ubuntu-2204-lts"),
    "vm_image_project": os.environ.get("VM_IMAGE_PROJECT", "ubuntu-os-cloud"),
    "vm_network": os.environ.get("VM_NETWORK", "default"),
    "vm_subnet": os.environ.get("VM_SUBNET", ""),
    "vm_tags": csv_env("VM_TAGS") or csv_env("TAGS"),
    "vm_service_account_email": os.environ.get("VM_SERVICE_ACCOUNT_EMAIL", ""),
    "gdrive_folder_id": os.environ.get("GDRIVE_FOLDER_ID", ""),
    "gdrive_state_root": os.environ.get("GDRIVE_STATE_ROOT", "steam-vm-state"),
    "gdrive_owner_email": os.environ.get("GDRIVE_OWNER_EMAIL", "mwodevelop@gmail.com"),
    "gdrive_oauth_token_secret_name": os.environ.get("GDRIVE_OAUTH_TOKEN_SECRET_NAME", ""),
    "vm_startup_script_b64": os.environ.get("VM_STARTUP_SCRIPT_B64", ""),
    "vm_shutdown_script_b64": os.environ.get("VM_SHUTDOWN_SCRIPT_B64", ""),
    "vm_persist_script_b64": os.environ.get("VM_PERSIST_SCRIPT_B64", ""),
    "vm_power_action_script_b64": os.environ.get("VM_POWER_ACTION_SCRIPT_B64", ""),
    "vm_steam_env_b64": os.environ.get("VM_STEAM_ENV_B64", ""),
    "allowed_origins": csv_env("ALLOWED_ORIGINS"),
    "google_client_ids": csv_env("GOOGLE_CLIENT_IDS") or csv_env("GOOGLE_CLIENT_ID"),
    "allowed_google_emails": {value.lower() for value in csv_env("ALLOWED_GOOGLE_EMAILS")},
    "allowed_google_domains": {value.lower() for value in csv_env("ALLOWED_GOOGLE_DOMAINS")},
    "duckdns_domains": normalize_duckdns_domains(csv_env("DUCKDNS_DOMAINS")),
    "duckdns_token": os.environ.get("DUCKDNS_TOKEN", ""),
    "novnc_port": os.environ.get("VM_NOVNC_PORT", "8083"),
    "sunshine_port": os.environ.get("VM_SUNSHINE_PORT", "47990"),
}

AUTO_STOP_METADATA_KEY = "vm-auto-shutdown-hours"
STEAM_ENV_METADATA_KEY = "steam-headless-env"
SUNSHINE_STATUS_METADATA_KEY = "vm-sunshine-status"
SUNSHINE_STATUS_DETAIL_METADATA_KEY = "vm-sunshine-status-detail"
POWER_ACTION_METADATA_KEY = "vm-pending-power-action"
POWER_ACTION_STATUS_METADATA_KEY = "vm-power-action-status"
RESTORE_MODE_METADATA_KEY = "vm-restore-mode"
RESTORE_STATUS_METADATA_KEY = "vm-restore-status"
RESTORE_DETAIL_METADATA_KEY = "vm-restore-detail"
DATA_DISK_STATUS_METADATA_KEY = "vm-data-disk-status"
DATA_DISK_DETAIL_METADATA_KEY = "vm-data-disk-detail"
LAST_HOME_BACKUP_AT_METADATA_KEY = "vm-last-home-backup-at"
LAST_GAMES_ARCHIVE_AT_METADATA_KEY = "vm-last-games-archive-at"
GAMES_ARCHIVE_STATUS_METADATA_KEY = "vm-games-archive-status"
GAMES_ARCHIVE_DETAIL_METADATA_KEY = "vm-games-archive-detail"
BACKUP_READY_AT_METADATA_KEY = "vm-backup-ready-at"
SUNSHINE_USERNAME = "admin"
MIN_AUTO_STOP_HOURS = 1
MAX_AUTO_STOP_HOURS = 24
STATUS_NOT_FOUND = "NOT_FOUND"


def require_env(name: str) -> str:
    value = CONFIG.get(name) if name in CONFIG else os.environ.get(name, "")
    if not value:
        raise ApiError(f"Service is missing required configuration: {name}", 500)
    return value


@lru_cache(maxsize=1)
def compute_session() -> AuthorizedSession:
    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    return AuthorizedSession(credentials)


def instance_url() -> str:
    project = require_env("project")
    zone = require_env("zone")
    instance = require_env("instance")
    return (
        "https://compute.googleapis.com/compute/v1/"
        f"projects/{project}/zones/{zone}/instances/{instance}"
    )


def instances_collection_url() -> str:
    project = require_env("project")
    zone = require_env("zone")
    return f"https://compute.googleapis.com/compute/v1/projects/{project}/zones/{zone}/instances"


def zone_region(zone: str) -> str:
    if zone.count("-") >= 2:
        return zone.rsplit("-", 1)[0]
    return zone


def machine_type_path() -> str:
    return f"zones/{require_env('zone')}/machineTypes/{CONFIG['machine_type']}"


def accelerator_type_path() -> str:
    return f"zones/{require_env('zone')}/acceleratorTypes/{CONFIG['gpu_type']}"


def disk_type_path() -> str:
    return f"zones/{require_env('zone')}/diskTypes/{CONFIG['boot_disk_type']}"


def data_disk_type_path() -> str:
    return f"zones/{require_env('zone')}/diskTypes/{CONFIG['data_disk_type']}"


def network_path() -> str:
    value = CONFIG["vm_network"].strip()
    if not value:
        return f"projects/{require_env('project')}/global/networks/default"
    if "/" in value:
        return value
    return f"projects/{require_env('project')}/global/networks/{value}"


def subnet_path() -> str:
    value = CONFIG["vm_subnet"].strip()
    if not value:
        return ""
    if "/" in value:
        return value
    return (
        f"projects/{require_env('project')}/regions/{zone_region(require_env('zone'))}/subnetworks/{value}"
    )


def parse_disk_size_gb(raw_value: str) -> str:
    digits = "".join(ch for ch in raw_value if ch.isdigit())
    if not digits:
        raise ApiError("BOOT_DISK_SIZE must include a numeric size.", 500)
    return digits


def decode_config_b64(name: str) -> str:
    raw_value = str(CONFIG.get(name, "") or "")
    if not raw_value:
        raise ApiError(f"Service is missing required configuration: {name}", 500)
    try:
        payload = base64.b64decode(raw_value)
        if payload.startswith(b"\x1f\x8b"):
            payload = gzip.decompress(payload)
        return payload.decode("utf-8")
    except Exception as error:
        raise ApiError(f"Service has invalid base64 configuration for {name}: {error}", 500) from error


def allowed_origin() -> str | None:
    origin = request.headers.get("Origin", "").strip()
    allowed = CONFIG["allowed_origins"]
    if not origin:
        return None
    if "*" in allowed:
        return origin
    return origin if origin in allowed else None


@app.before_request
def enforce_origin() -> None:
    if request.method == "OPTIONS":
        return

    origin = request.headers.get("Origin", "").strip()
    if origin and not allowed_origin():
        raise ApiError("Origin is not allowed.", 403)


@app.after_request
def add_cors_headers(response):  # type: ignore[override]
    origin = allowed_origin()
    if origin:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


@app.errorhandler(ApiError)
def handle_api_error(error: ApiError):
    response = jsonify({"error": error.message})
    response.status_code = error.status_code
    return response


@app.errorhandler(Exception)
def handle_unexpected_error(error: Exception):
    logging.exception("Unexpected error")
    response = jsonify({"error": str(error) or "Unexpected server error."})
    response.status_code = 500
    return response


@app.route("/healthz", methods=["GET", "OPTIONS"])
@app.route("/api/config", methods=["GET", "OPTIONS"])
@app.route("/api/me", methods=["GET", "OPTIONS"])
@app.route("/api/status", methods=["GET", "OPTIONS"])
@app.route("/api/command", methods=["POST", "OPTIONS"])
def options_passthrough():
    if request.method == "OPTIONS":
        return make_response(("", 204))

    if request.path == "/healthz":
        return jsonify({"ok": True})

    if request.path == "/api/config":
        return jsonify(
            {
                "service": "cloud-run-vm-control",
                "googleClientId": CONFIG["google_client_ids"][0] if CONFIG["google_client_ids"] else "",
                "target": {
                    "project": CONFIG["project"],
                    "zone": CONFIG["zone"],
                    "instance": CONFIG["instance"],
                },
                "duckdnsDomains": CONFIG["duckdns_domains"],
                "ports": {
                    "novnc": CONFIG["novnc_port"],
                    "sunshine": CONFIG["sunshine_port"],
                },
            }
        )

    if request.path == "/api/me":
        return jsonify({"user": require_user()})

    if request.path == "/api/status":
        user = require_user()
        instance = get_instance_or_none()
        return jsonify(build_status_payload(instance, user=user, command="status"))

    if request.path == "/api/command":
        user = require_user()
        payload = request.get_json(silent=True) or {}
        command = str(payload.get("command", "")).strip().lower()
        if command not in {"status", "start", "stop", "restart", "create", "delete"}:
            raise ApiError("Unsupported command.", 400)
        result = execute_command(command, user, payload)
        return jsonify(result)

    raise ApiError("Not found.", 404)


def require_user() -> dict[str, Any]:
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise ApiError("Missing Google token.", 401)

    token = auth_header.removeprefix("Bearer ").strip()
    if not token:
        raise ApiError("Missing Google token.", 401)

    client_ids = CONFIG["google_client_ids"]
    if not client_ids:
        raise ApiError("Service is missing GOOGLE_CLIENT_ID configuration.", 500)

    verifier = Request()
    try:
        if len(client_ids) == 1:
            info = id_token.verify_oauth2_token(token, verifier, client_ids[0])
        else:
            info = id_token.verify_oauth2_token(token, verifier)
            if info.get("aud") not in client_ids:
                raise ValueError("Token audience is not allowed.")
    except ValueError:
        info = google_userinfo(token)

    email = str(info.get("email", "")).lower()
    hd = str(info.get("hd", "")).lower()
    email_domain = email.split("@", 1)[1] if "@" in email else ""
    email_verified = bool(info.get("email_verified"))
    if not email_verified or not email:
        raise ApiError("Google account email is not verified.", 403)

    allowed_emails = CONFIG["allowed_google_emails"]
    allowed_domains = CONFIG["allowed_google_domains"]
    if allowed_emails or allowed_domains:
        allowed = (
            email in allowed_emails
            or (hd and hd in allowed_domains)
            or (email_domain and email_domain in allowed_domains)
        )
        if not allowed:
            raise ApiError(f"Google account {email} is not allowed.", 403)

    return {
        "email": email,
        "name": info.get("name", ""),
        "picture": info.get("picture", ""),
        "sub": info.get("sub", ""),
        "hd": hd,
    }


def google_userinfo(token: str) -> dict[str, Any]:
    response = requests.get(
        "https://openidconnect.googleapis.com/v1/userinfo",
        headers={"Authorization": f"Bearer {token}"},
        timeout=10,
    )
    if response.status_code != 200:
        raise ApiError("Invalid Google token.", 401)

    info = response.json()
    if not isinstance(info, dict):
        raise ApiError("Invalid Google token.", 401)
    return info


def compute_request(method: str, url: str, *, allow_404: bool = False, **kwargs) -> dict[str, Any] | None:
    response = compute_session().request(method=method, url=url, timeout=30, **kwargs)
    if response.status_code == 404:
        if allow_404:
            return None
        raise ApiError(
            f"Instance '{CONFIG['instance']}' was not found in {CONFIG['project']}/{CONFIG['zone']}.",
            404,
        )
    if response.status_code >= 400:
        raise ApiError(response.text or f"Compute API returned {response.status_code}.", 502)
    return response.json()


def wait_for_zone_operation(operation: dict[str, Any], timeout_seconds: int = 90) -> None:
    operation_name = str(operation.get("name", "") or "")
    if not operation_name:
        return

    url = (
        "https://compute.googleapis.com/compute/v1/"
        f"projects/{CONFIG['project']}/zones/{CONFIG['zone']}/operations/{operation_name}"
    )
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        data = compute_request("GET", url)
        if data is None:
            raise ApiError(f"Operation {operation_name} was not found.", 404)
        if str(data.get("status", "")).upper() == "DONE":
            if data.get("error"):
                raise ApiError(str(data["error"]), 502)
            return
        time.sleep(2)
    raise ApiError(f"Timed out waiting for operation {operation_name}.", 504)


def get_instance() -> dict[str, Any]:
    data = compute_request("GET", instance_url())
    if data is None:
        raise ApiError("Instance was not found.", 404)
    return data


def get_instance_or_none() -> dict[str, Any] | None:
    data = compute_request("GET", instance_url(), allow_404=True)
    return data if isinstance(data, dict) else None


def extract_external_ip(instance: dict[str, Any]) -> str:
    network_interfaces = instance.get("networkInterfaces", []) or []
    if not network_interfaces:
        return ""
    access_configs = network_interfaces[0].get("accessConfigs", []) or []
    if not access_configs:
        return ""
    return str(access_configs[0].get("natIP", "") or "")


def instance_metadata_items(instance: dict[str, Any]) -> list[dict[str, str]]:
    metadata = instance.get("metadata", {}) or {}
    items = metadata.get("items", []) or []
    return [item for item in items if isinstance(item, dict)]


def metadata_value(instance: dict[str, Any], key: str) -> str:
    for item in instance_metadata_items(instance):
        if item.get("key") == key:
            return str(item.get("value", "") or "")
    return ""


def set_instance_metadata_values(instance: dict[str, Any], updates: dict[str, str | None]) -> None:
    metadata = instance.get("metadata", {}) or {}
    fingerprint = str(metadata.get("fingerprint", "") or "")
    if not fingerprint:
        raise ApiError("Instance metadata fingerprint is missing.", 502)

    update_keys = set(updates)
    items = [item for item in instance_metadata_items(instance) if item.get("key") not in update_keys]
    for key, value in updates.items():
        if value is not None:
            items.append({"key": key, "value": value})

    operation = compute_request(
        "POST",
        f"{instance_url()}/setMetadata",
        json={
            "fingerprint": fingerprint,
            "items": items,
        },
    )
    wait_for_zone_operation(operation)


def set_instance_metadata_value(instance: dict[str, Any], key: str, value: str | None) -> None:
    set_instance_metadata_values(instance, {key: value})


def parse_auto_stop_hours(payload: dict[str, Any]) -> int | None:
    raw = payload.get("autoStopHours")
    if raw in (None, "", False):
        return None

    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ApiError("Auto-stop hours must be a whole number.", 400)

    if value < MIN_AUTO_STOP_HOURS or value > MAX_AUTO_STOP_HOURS:
        raise ApiError(
            f"Auto-stop hours must be between {MIN_AUTO_STOP_HOURS} and {MAX_AUTO_STOP_HOURS}.",
            400,
        )
    return value


def metadata_env_value(raw_env: str, key: str) -> str:
    for line in raw_env.splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1]
    return ""


def upsert_metadata_env_value(raw_env: str, key: str, value: str) -> str:
    lines = raw_env.splitlines()
    output: list[str] = []
    replaced = False
    for line in lines:
        if line.startswith(f"{key}="):
            if not replaced:
                output.append(f"{key}={value}")
                replaced = True
            continue
        output.append(line)

    if not replaced:
        output.append(f"{key}={value}")

    return "\n".join(output)


def generate_sunshine_password() -> str:
    return secrets.token_hex(12)


def update_steam_env_metadata(instance: dict[str, Any], values: dict[str, str]) -> tuple[dict[str, Any], str]:
    current_env = metadata_value(instance, STEAM_ENV_METADATA_KEY)
    updated_env = current_env
    for key, value in values.items():
        updated_env = upsert_metadata_env_value(updated_env, key, value)

    if updated_env == current_env:
        return instance, current_env

    set_instance_metadata_value(instance, STEAM_ENV_METADATA_KEY, updated_env)
    return get_instance(), updated_env


def sunshine_credentials_from_env(raw_env: str) -> dict[str, str]:
    return {
        "username": metadata_env_value(raw_env, "SUNSHINE_USER") or SUNSHINE_USERNAME,
        "password": metadata_env_value(raw_env, "SUNSHINE_PASS"),
    }


def sunshine_credentials_from_instance(instance: dict[str, Any]) -> dict[str, str]:
    return sunshine_credentials_from_env(metadata_value(instance, STEAM_ENV_METADATA_KEY))


def prepare_sunshine_credentials(instance: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    password = generate_sunshine_password()
    updated_instance, _ = update_steam_env_metadata(
        instance,
        {
            "SUNSHINE_USER": SUNSHINE_USERNAME,
            "SUNSHINE_PASS": password,
        },
    )
    return updated_instance, {"username": SUNSHINE_USERNAME, "password": password}


def generate_action_token() -> str:
    return secrets.token_hex(8)


def parse_power_action_status(raw_status: str) -> tuple[str, str, str]:
    parts = raw_status.split(":", 2)
    if len(parts) != 3:
        return "", "", ""
    return parts[0], parts[1], parts[2]


def request_live_power_action(
    instance: dict[str, Any],
    *,
    action: str,
    status_detail: str,
) -> tuple[dict[str, Any], str]:
    token = generate_action_token()
    set_instance_metadata_values(
        instance,
        {
            POWER_ACTION_METADATA_KEY: f"{action}:{token}",
            POWER_ACTION_STATUS_METADATA_KEY: f"requested:{action}:{token}",
            SUNSHINE_STATUS_METADATA_KEY: "starting",
            SUNSHINE_STATUS_DETAIL_METADATA_KEY: status_detail,
        },
    )
    return get_instance(), token


def poll_power_action_backup(
    *,
    action: str,
    token: str,
    timeout_seconds: int = 1800,
) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        instance = get_instance()
        phase, status_action, status_token = parse_power_action_status(
            metadata_value(instance, POWER_ACTION_STATUS_METADATA_KEY)
        )
        if phase == "backed-up" and status_action == action and status_token == token:
            return instance
        if phase == "failed" and status_action == action and status_token == token:
            raise ApiError(f"Live backup failed before {action}.", 502)
        time.sleep(5)
    raise ApiError(f"Timed out waiting for live backup before {action}.", 504)


def poll_instance_restarted(previous_start_timestamp: str, timeout_seconds: int = 600) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_instance: dict[str, Any] | None = None
    while time.time() < deadline:
        last_instance = get_instance()
        current_status = str(last_instance.get("status", "")).upper()
        current_start_timestamp = str(last_instance.get("lastStartTimestamp", "") or "")
        if current_status == "RUNNING" and current_start_timestamp and current_start_timestamp != previous_start_timestamp:
            return last_instance
        time.sleep(5)

    if last_instance:
        return last_instance
    raise ApiError("Timed out waiting for instance restart.", 504)


def build_steam_env_value(overrides: dict[str, str]) -> str:
    raw_env = decode_config_b64("vm_steam_env_b64")
    updated_env = raw_env
    for key, value in overrides.items():
        updated_env = upsert_metadata_env_value(updated_env, key, value)
    return updated_env


def build_instance_metadata_items(
    *,
    auto_stop_hours: int | None,
    sunshine_credentials: dict[str, str],
    restore_mode: str | None = None,
) -> list[dict[str, str]]:
    items = [
        {"key": "startup-script", "value": decode_config_b64("vm_startup_script_b64")},
        {"key": "shutdown-script", "value": decode_config_b64("vm_shutdown_script_b64")},
        {"key": "vm-persist-script", "value": decode_config_b64("vm_persist_script_b64")},
        {"key": "vm-power-action-script", "value": decode_config_b64("vm_power_action_script_b64")},
        {"key": "vm-data-disk-device-name", "value": CONFIG["data_disk_device_name"]},
        {"key": "vm-data-disk-mount-root", "value": CONFIG["data_disk_mount_root"]},
        {
            "key": STEAM_ENV_METADATA_KEY,
            "value": build_steam_env_value(
                {
                    "SUNSHINE_USER": sunshine_credentials["username"],
                    "SUNSHINE_PASS": sunshine_credentials["password"],
                }
            ),
        },
        {"key": SUNSHINE_STATUS_METADATA_KEY, "value": "starting"},
        {"key": SUNSHINE_STATUS_DETAIL_METADATA_KEY, "value": "VM booting. Waiting for Sunshine Web UI."},
        {"key": DATA_DISK_STATUS_METADATA_KEY, "value": "pending"},
        {"key": DATA_DISK_DETAIL_METADATA_KEY, "value": "Waiting for shared data disk mount."},
    ]

    if restore_mode:
        items.append({"key": RESTORE_MODE_METADATA_KEY, "value": restore_mode})
        items.append({"key": RESTORE_STATUS_METADATA_KEY, "value": "pending"})
        items.append({"key": RESTORE_DETAIL_METADATA_KEY, "value": "Waiting for create-time restore."})

    if CONFIG["gdrive_folder_id"]:
        items.append({"key": "gdrive-folder-id", "value": CONFIG["gdrive_folder_id"]})
        items.append({"key": "gdrive-state-root", "value": CONFIG["gdrive_state_root"]})
        items.append({"key": "gdrive-owner-email", "value": CONFIG["gdrive_owner_email"]})
    if CONFIG["gdrive_oauth_token_secret_name"]:
        items.append(
            {
                "key": "gdrive-oauth-token-secret-name",
                "value": CONFIG["gdrive_oauth_token_secret_name"],
            }
        )
    if auto_stop_hours is not None:
        items.append({"key": AUTO_STOP_METADATA_KEY, "value": str(auto_stop_hours)})
    return items


def build_instance_create_request(
    *,
    auto_stop_hours: int | None,
    sunshine_credentials: dict[str, str],
) -> dict[str, Any]:
    network_interface: dict[str, Any] = {
        "network": network_path(),
        "accessConfigs": [{"name": "External NAT", "type": "ONE_TO_ONE_NAT"}],
    }
    subnet = subnet_path()
    if subnet:
        network_interface["subnetwork"] = subnet

    service_account_email = CONFIG["vm_service_account_email"].strip()
    if not service_account_email:
        raise ApiError("Service is missing required configuration: vm_service_account_email", 500)

    request_body: dict[str, Any] = {
        "name": CONFIG["instance"],
        "machineType": machine_type_path(),
        "disks": [
            {
                "boot": True,
                "autoDelete": True,
                "initializeParams": {
                    "sourceImage": (
                        f"projects/{CONFIG['vm_image_project']}/global/images/family/{CONFIG['vm_image_family']}"
                    ),
                    "diskSizeGb": parse_disk_size_gb(CONFIG["boot_disk_size"]),
                    "diskType": disk_type_path(),
                },
            },
            {
                "boot": False,
                "autoDelete": True,
                "deviceName": CONFIG["data_disk_device_name"],
                "initializeParams": {
                    "diskName": f"{CONFIG['instance']}-state",
                    "diskSizeGb": parse_disk_size_gb(CONFIG["data_disk_size"]),
                    "diskType": data_disk_type_path(),
                },
            }
        ],
        "networkInterfaces": [network_interface],
        "serviceAccounts": [
            {
                "email": service_account_email,
                "scopes": ["https://www.googleapis.com/auth/cloud-platform"],
            }
        ],
        "scheduling": {
            "onHostMaintenance": "TERMINATE",
            "automaticRestart": True,
        },
        "metadata": {
            "items": build_instance_metadata_items(
                auto_stop_hours=auto_stop_hours,
                sunshine_credentials=sunshine_credentials,
                restore_mode="create",
            )
        },
    }

    if CONFIG["vm_tags"]:
        request_body["tags"] = {"items": CONFIG["vm_tags"]}
    if CONFIG["gpu_count"] > 0:
        request_body["guestAccelerators"] = [
            {
                "acceleratorType": accelerator_type_path(),
                "acceleratorCount": CONFIG["gpu_count"],
            }
        ]
    return request_body


def build_urls(external_ip: str) -> dict[str, Any]:
    urls: dict[str, Any] = {
        "novnc": "",
        "sunshine": "",
        "moonlightHost": external_ip,
        "duckdns": [],
    }
    if external_ip:
        urls["novnc"] = f"http://{external_ip}:{CONFIG['novnc_port']}/"
        urls["sunshine"] = f"https://{external_ip}:{CONFIG['sunshine_port']}/"

    duckdns_entries = []
    for domain in CONFIG["duckdns_domains"]:
        duckdns_entries.append(
            {
                "domain": domain,
                "novnc": f"http://{domain}:{CONFIG['novnc_port']}/",
                "sunshine": f"https://{domain}:{CONFIG['sunshine_port']}/",
            }
        )
    urls["duckdns"] = duckdns_entries
    return urls


def build_sunshine_status(instance: dict[str, Any] | None) -> dict[str, str]:
    if instance is None:
        return {
            "state": "not_created",
            "label": "VM not created",
            "detail": "",
        }

    vm_status = str(instance.get("status", "UNKNOWN")).upper()
    if vm_status != "RUNNING":
        return {
            "state": "stopped",
            "label": "VM not running",
            "detail": "",
        }

    state = metadata_value(instance, SUNSHINE_STATUS_METADATA_KEY).strip().lower() or "starting"
    detail = metadata_value(instance, SUNSHINE_STATUS_DETAIL_METADATA_KEY).strip()
    labels = {
        "ready": "Ready",
        "starting": "Starting",
        "error": "Error",
    }
    return {
        "state": state,
        "label": labels.get(state, state.title()),
        "detail": detail,
    }


def has_attached_data_disk(instance: dict[str, Any] | None) -> bool:
    if instance is None:
        return False

    expected_device_name = CONFIG["data_disk_device_name"].strip()
    for disk in instance.get("disks", []) or []:
        if not isinstance(disk, dict):
            continue
        if disk.get("boot") is True:
            continue
        if expected_device_name and str(disk.get("deviceName", "") or "") == expected_device_name:
            return True
        if expected_device_name and expected_device_name in str(disk.get("source", "") or ""):
            return True
    return False


def build_persistence_status(instance: dict[str, Any] | None) -> dict[str, Any]:
    if instance is None:
        return {
            "dataDisk": {
                "attached": False,
                "state": "not_created",
                "label": "VM not created",
                "detail": "",
            },
            "restore": {
                "mode": "",
                "state": "",
                "label": "",
                "detail": "",
            },
            "homeBackup": {
                "lastAt": "",
            },
            "gamesArchive": {
                "lastAt": "",
                "state": "",
                "label": "",
                "detail": "",
            },
        }

    data_disk_state = metadata_value(instance, DATA_DISK_STATUS_METADATA_KEY).strip().lower()
    restore_mode = metadata_value(instance, RESTORE_MODE_METADATA_KEY).strip().lower()
    restore_state = metadata_value(instance, RESTORE_STATUS_METADATA_KEY).strip().lower()
    games_archive_state = metadata_value(instance, GAMES_ARCHIVE_STATUS_METADATA_KEY).strip().lower()

    data_disk_labels = {
        "ready": "Ready",
        "missing": "Missing",
        "error": "Error",
        "pending": "Pending",
    }
    restore_labels = {
        "pending": "Pending",
        "running": "Running",
        "restored": "Restored",
        "no-backup": "No backup",
        "failed": "Failed",
    }
    games_archive_labels = {
        "ready": "Ready",
        "running": "Running",
        "missing": "Missing",
        "failed": "Failed",
        "legacy": "Legacy",
    }

    return {
        "dataDisk": {
            "attached": has_attached_data_disk(instance),
            "state": data_disk_state,
            "label": data_disk_labels.get(data_disk_state, data_disk_state.title() if data_disk_state else ""),
            "detail": metadata_value(instance, DATA_DISK_DETAIL_METADATA_KEY),
        },
        "restore": {
            "mode": restore_mode,
            "state": restore_state,
            "label": restore_labels.get(restore_state, restore_state.title() if restore_state else ""),
            "detail": metadata_value(instance, RESTORE_DETAIL_METADATA_KEY),
        },
        "homeBackup": {
            "lastAt": metadata_value(instance, LAST_HOME_BACKUP_AT_METADATA_KEY),
        },
        "gamesArchive": {
            "lastAt": metadata_value(instance, LAST_GAMES_ARCHIVE_AT_METADATA_KEY),
            "state": games_archive_state,
            "label": games_archive_labels.get(
                games_archive_state, games_archive_state.title() if games_archive_state else ""
            ),
            "detail": metadata_value(instance, GAMES_ARCHIVE_DETAIL_METADATA_KEY),
        },
    }


def allowed_commands(instance: dict[str, Any] | None) -> list[str]:
    if instance is None:
        return ["create"]

    status = str(instance.get("status", "UNKNOWN")).upper()
    if status == "RUNNING":
        return ["status", "restart", "stop", "delete"]
    if status == "TERMINATED":
        return ["status", "start", "delete"]
    return ["status", "delete"]


def build_status_payload(
    instance: dict[str, Any] | None,
    *,
    user: dict[str, Any],
    command: str,
    duckdns_updated: bool | None = None,
    sunshine_credentials: dict[str, str] | None = None,
) -> dict[str, Any]:
    if instance is None:
        payload = {
            "command": command,
            "target": {
                "project": CONFIG["project"],
                "zone": CONFIG["zone"],
                "instance": CONFIG["instance"],
            },
            "status": STATUS_NOT_FOUND,
            "instanceExists": False,
            "allowedCommands": allowed_commands(None),
            "externalIp": "",
            "duckdnsDomains": CONFIG["duckdns_domains"],
            "urls": build_urls(""),
            "user": user,
            "autoStopHours": "",
            "sunshineCredentials": {
                "username": SUNSHINE_USERNAME,
                "password": "",
            },
            "sunshineStatus": build_sunshine_status(None),
            "persistence": build_persistence_status(None),
        }
        if duckdns_updated is not None:
            payload["duckdnsUpdated"] = duckdns_updated
        return payload

    external_ip = extract_external_ip(instance)
    status = str(instance.get("status", "UNKNOWN"))
    credentials = sunshine_credentials or sunshine_credentials_from_instance(instance)
    if status != "RUNNING":
        credentials = {
            "username": credentials.get("username", SUNSHINE_USERNAME) or SUNSHINE_USERNAME,
            "password": "",
        }
    payload = {
        "command": command,
        "target": {
            "project": CONFIG["project"],
            "zone": CONFIG["zone"],
            "instance": CONFIG["instance"],
        },
        "status": status,
        "instanceExists": True,
        "allowedCommands": allowed_commands(instance),
        "externalIp": external_ip,
        "duckdnsDomains": CONFIG["duckdns_domains"],
        "urls": build_urls(external_ip),
        "user": user,
        "autoStopHours": metadata_value(instance, AUTO_STOP_METADATA_KEY),
        "sunshineCredentials": credentials,
        "sunshineStatus": build_sunshine_status(instance),
        "persistence": build_persistence_status(instance),
    }
    if duckdns_updated is not None:
        payload["duckdnsUpdated"] = duckdns_updated
    return payload


def poll_instance_status(target_status: str, timeout_seconds: int = 300) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_instance: dict[str, Any] | None = None
    while time.time() < deadline:
        last_instance = get_instance()
        if str(last_instance.get("status", "")).upper() == target_status.upper():
            return last_instance
        time.sleep(3)

    if last_instance:
        return last_instance
    raise ApiError(f"Timed out waiting for instance to reach {target_status}.", 504)


def poll_instance_deleted(timeout_seconds: int = 300) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if get_instance_or_none() is None:
            return
        time.sleep(3)
    raise ApiError("Timed out waiting for instance deletion.", 504)


def wait_for_external_ip(timeout_seconds: int = 90) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_instance = get_instance()
    while time.time() < deadline:
        if extract_external_ip(last_instance):
            return last_instance
        time.sleep(3)
        last_instance = get_instance()
    return last_instance


def poll_backup_ready(timeout_seconds: int = 900, previous_timestamp: str = "") -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_instance: dict[str, Any] | None = None
    while time.time() < deadline:
        last_instance = get_instance()
        backup_ready_at = metadata_value(last_instance, BACKUP_READY_AT_METADATA_KEY).strip()
        if (
            str(last_instance.get("status", "")).upper() == "RUNNING"
            and backup_ready_at
            and backup_ready_at != previous_timestamp
        ):
            return last_instance
        time.sleep(5)

    if last_instance:
        return last_instance
    raise ApiError("Timed out waiting for VM backup readiness.", 504)


def update_duckdns(external_ip: str) -> bool:
    if not external_ip or not CONFIG["duckdns_domains"] or not CONFIG["duckdns_token"]:
        return False

    updated = True
    for domain in CONFIG["duckdns_domains"]:
        subdomain = domain.removesuffix(".duckdns.org")
        response = requests.get(
            "https://www.duckdns.org/update",
            params={
                "domains": subdomain,
                "token": CONFIG["duckdns_token"],
                "ip": external_ip,
            },
            timeout=15,
        )
        if response.text.strip() != "OK":
            logging.warning("DuckDNS update failed for %s: %s", domain, response.text.strip())
            updated = False
        else:
            logging.info("DuckDNS updated for %s -> %s", domain, external_ip)
    return updated


def execute_command(command: str, user: dict[str, Any], payload: dict[str, Any] | None = None) -> dict[str, Any]:
    logging.info("VM command=%s user=%s", command, user.get("email", "<unknown>"))
    payload = payload or {}
    current_instance = get_instance_or_none()
    current_status = str(current_instance.get("status", STATUS_NOT_FOUND)) if current_instance else STATUS_NOT_FOUND

    if command == "status":
        return build_status_payload(current_instance, user=user, command=command)

    if command == "create":
        if current_instance is not None:
            raise ApiError("Instance already exists.", 400)
        auto_stop_hours = parse_auto_stop_hours(payload)
        sunshine_credentials = {
            "username": SUNSHINE_USERNAME,
            "password": generate_sunshine_password(),
        }
        operation = compute_request(
            "POST",
            instances_collection_url(),
            json=build_instance_create_request(
                auto_stop_hours=auto_stop_hours,
                sunshine_credentials=sunshine_credentials,
            ),
        )
        if not isinstance(operation, dict):
            raise ApiError("Failed to create instance.", 502)
        wait_for_zone_operation(operation, timeout_seconds=180)
        poll_instance_status("RUNNING", timeout_seconds=240)
        final_instance = wait_for_external_ip(timeout_seconds=180)
        updated = update_duckdns(extract_external_ip(final_instance))
        return build_status_payload(
            final_instance,
            user=user,
            command=command,
            duckdns_updated=updated,
            sunshine_credentials=sunshine_credentials,
        )

    if command == "start":
        if current_instance is None:
            raise ApiError("Instance does not exist. Use Create first.", 400)
        auto_stop_hours = parse_auto_stop_hours(payload)
        if auto_stop_hours is not None and current_status == "RUNNING":
            raise ApiError("Auto-stop can only be scheduled while starting a stopped VM.", 400)

        sunshine_credentials = sunshine_credentials_from_instance(current_instance)
        if current_status != "RUNNING":
            current_instance, sunshine_credentials = prepare_sunshine_credentials(current_instance)
            set_instance_metadata_values(
                current_instance,
                {
                    AUTO_STOP_METADATA_KEY: str(auto_stop_hours) if auto_stop_hours is not None else None,
                    SUNSHINE_STATUS_METADATA_KEY: "starting",
                    SUNSHINE_STATUS_DETAIL_METADATA_KEY: "VM booting. Waiting for Sunshine Web UI.",
                },
            )
            current_instance = get_instance()

        if current_status != "RUNNING":
            compute_request("POST", f"{instance_url()}/start")
            poll_instance_status("RUNNING")
            final_instance = wait_for_external_ip(timeout_seconds=120)
        else:
            final_instance = wait_for_external_ip()
        updated = update_duckdns(extract_external_ip(final_instance))
        return build_status_payload(
            final_instance,
            user=user,
            command=command,
            duckdns_updated=updated,
            sunshine_credentials=sunshine_credentials,
        )

    if command == "stop":
        if current_instance is None:
            raise ApiError("Instance does not exist.", 400)
        if current_status != "TERMINATED":
            current_instance, token = request_live_power_action(
                current_instance,
                action="stop",
                status_detail="VM stopping after a live backup.",
            )
            poll_power_action_backup(action="stop", token=token)
            final_instance = poll_instance_status("TERMINATED", timeout_seconds=900)
        else:
            final_instance = current_instance
        set_instance_metadata_values(
            final_instance,
            {
                AUTO_STOP_METADATA_KEY: None,
                SUNSHINE_STATUS_METADATA_KEY: "stopped",
                SUNSHINE_STATUS_DETAIL_METADATA_KEY: None,
            },
        )
        final_instance = get_instance()
        return build_status_payload(final_instance, user=user, command=command)

    if command == "restart":
        if current_instance is None:
            raise ApiError("Instance does not exist. Use Create first.", 400)
        current_instance, sunshine_credentials = prepare_sunshine_credentials(current_instance)
        set_instance_metadata_values(
            current_instance,
            {
                SUNSHINE_STATUS_METADATA_KEY: "starting",
                SUNSHINE_STATUS_DETAIL_METADATA_KEY: "VM restarting. Waiting for Sunshine Web UI.",
            },
        )
        current_instance = get_instance()
        if current_status == "RUNNING":
            previous_start_timestamp = str(current_instance.get("lastStartTimestamp", "") or "")
            current_instance, token = request_live_power_action(
                current_instance,
                action="restart",
                status_detail="VM restarting after a live backup.",
            )
            poll_power_action_backup(action="restart", token=token)
            poll_instance_restarted(previous_start_timestamp, timeout_seconds=900)
            final_instance = wait_for_external_ip(timeout_seconds=180)
            updated = update_duckdns(extract_external_ip(final_instance))
            return build_status_payload(
                final_instance,
                user=user,
                command=command,
                duckdns_updated=updated,
                sunshine_credentials=sunshine_credentials,
            )
        compute_request("POST", f"{instance_url()}/start")
        poll_instance_status("RUNNING")
        final_instance = wait_for_external_ip(timeout_seconds=120)
        updated = update_duckdns(extract_external_ip(final_instance))
        return build_status_payload(
            final_instance,
            user=user,
            command=command,
            duckdns_updated=updated,
            sunshine_credentials=sunshine_credentials,
        )

    if command == "delete":
        if current_instance is None:
            raise ApiError("Instance does not exist.", 400)
        confirmed = bool(payload.get("confirmDelete"))
        if not confirmed:
            raise ApiError("Delete requires confirmation.", 400)

        if current_status == "TERMINATED":
            previous_backup_ready_at = metadata_value(current_instance, BACKUP_READY_AT_METADATA_KEY).strip()
            set_instance_metadata_values(
                current_instance,
                {
                    BACKUP_READY_AT_METADATA_KEY: None,
                    SUNSHINE_STATUS_METADATA_KEY: "starting",
                    SUNSHINE_STATUS_DETAIL_METADATA_KEY: "VM starting to run the final delete backup.",
                },
            )
            compute_request("POST", f"{instance_url()}/start")
            poll_instance_status("RUNNING", timeout_seconds=900)
            current_instance = poll_backup_ready(
                timeout_seconds=900,
                previous_timestamp=previous_backup_ready_at,
            )

        current_instance, token = request_live_power_action(
            current_instance,
            action="delete",
            status_detail="VM deleting after a live backup and games archive.",
        )
        poll_power_action_backup(action="delete", token=token)
        poll_instance_status("TERMINATED", timeout_seconds=900)
        operation = compute_request("DELETE", instance_url())
        if not isinstance(operation, dict):
            raise ApiError("Failed to delete instance.", 502)
        wait_for_zone_operation(operation, timeout_seconds=180)
        poll_instance_deleted(timeout_seconds=120)
        return build_status_payload(None, user=user, command=command)

    raise ApiError("Unsupported command.", 400)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
