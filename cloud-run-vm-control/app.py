import base64
import gzip
import json
import logging
import os
import secrets
import time
from typing import Final
from functools import lru_cache
from typing import Any

import google.auth
from flask import Flask, jsonify, make_response, request, g, has_request_context
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
    "firewall_source_ranges": csv_env("FIREWALL_SOURCE_RANGES") or csv_env("ALLOW_CIDR") or ["0.0.0.0/0"],
    "firewall_rule_web": os.environ.get("FIREWALL_RULE_WEB", "allow-steam-headless-web"),
    "firewall_rule_sunshine": os.environ.get("FIREWALL_RULE_SUNSHINE", "allow-sunshine"),
    "firewall_rule_minecraft": os.environ.get("FIREWALL_RULE_MINECRAFT", "allow-minecraft-server"),
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
    "minecraft_port": os.environ.get("VM_MINECRAFT_PORT", "25565"),
}

SUNSHINE_HEALTHCHECK_TIMEOUT_SECONDS: Final = 8

AUTO_STOP_METADATA_KEY = "vm-auto-shutdown-hours"
STEAM_ENV_METADATA_KEY = "steam-headless-env"
SUNSHINE_STATUS_METADATA_KEY = "vm-sunshine-status"
SUNSHINE_STATUS_DETAIL_METADATA_KEY = "vm-sunshine-status-detail"
MINECRAFT_STATUS_METADATA_KEY = "vm-minecraft-status"
MINECRAFT_STATUS_DETAIL_METADATA_KEY = "vm-minecraft-status-detail"
POWER_ACTION_METADATA_KEY = "vm-pending-power-action"
POWER_ACTION_STATUS_METADATA_KEY = "vm-power-action-status"
RESTORE_MODE_METADATA_KEY = "vm-restore-mode"
RESTORE_STATUS_METADATA_KEY = "vm-restore-status"
RESTORE_DETAIL_METADATA_KEY = "vm-restore-detail"
SELECTED_BACKUP_METADATA_KEY = "vm-selected-backup-id"
SELECTED_APPLICATION_METADATA_KEY = "vm-selected-application-id"
BACKUPS_JSON_METADATA_KEY = "vm-backups-json"
DATA_DISK_STATUS_METADATA_KEY = "vm-data-disk-status"
DATA_DISK_DETAIL_METADATA_KEY = "vm-data-disk-detail"
LAST_HOME_BACKUP_AT_METADATA_KEY = "vm-last-home-backup-at"
LAST_GAMES_ARCHIVE_AT_METADATA_KEY = "vm-last-games-archive-at"
GAMES_ARCHIVE_STATUS_METADATA_KEY = "vm-games-archive-status"
GAMES_ARCHIVE_DETAIL_METADATA_KEY = "vm-games-archive-detail"
BACKUP_READY_AT_METADATA_KEY = "vm-backup-ready-at"
DELETE_SKIP_HOME_BACKUP_METADATA_KEY = "vm-delete-skip-home-backup"
SUNSHINE_USERNAME = "admin"
SUNSHINE_PASSWORD_MIN_LENGTH = 8
SUNSHINE_PASSWORD_MAX_LENGTH = 128
MIN_AUTO_STOP_HOURS = 1
MAX_AUTO_STOP_HOURS = 24
STATUS_NOT_FOUND = "NOT_FOUND"
DEFAULT_CPU_MACHINE_TYPE = "n1-standard-4"
DEFAULT_T4_MACHINE_TYPE = "n1-standard-4"
DEFAULT_L4_MACHINE_TYPE = "g2-standard-4"
CPU_HARDWARE_ID = "cpu"
FIREWALL_WEB_ALLOWED: Final = [{"IPProtocol": "tcp", "ports": ["22", "8083"]}]
FIREWALL_SUNSHINE_ALLOWED: Final = [
    {"IPProtocol": "tcp", "ports": ["47984", "47989", "47990", "48010", "27036-27037"]},
    {"IPProtocol": "udp", "ports": ["47998", "47999", "48000", "48002", "48010", "27031-27036"]},
]
FIREWALL_MINECRAFT_ALLOWED: Final = [{"IPProtocol": "tcp", "ports": [CONFIG["minecraft_port"]]}]
APPLICATION_CATALOG: Final = [
    {
        "id": "prism",
        "label": "PrismLauncher",
        "description": "Minecraft launcher installed via Flatpak and added to Sunshine applications.",
    },
    {
        "id": "chrome",
        "label": "Google Chrome",
        "description": "Google Chrome browser installed as a user Flatpak and added to Sunshine applications.",
    },
]
APPLICATION_IDS: Final = {str(app["id"]) for app in APPLICATION_CATALOG}


def require_env(name: str) -> str:
    value = CONFIG.get(name) if name in CONFIG else os.environ.get(name, "")
    if not value:
        raise ApiError(f"Service is missing required configuration: {name}", 500)
    return value


@lru_cache(maxsize=1)
def compute_session() -> AuthorizedSession:
    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    return AuthorizedSession(credentials)


def request_override(name: str, fallback: Any) -> Any:
    if not has_request_context():
        return fallback
    return getattr(g, name, fallback)


def selected_zone() -> str:
    return str(request_override("target_zone", CONFIG["zone"]))


def selected_machine_type() -> str:
    return str(request_override("target_machine_type", CONFIG["machine_type"]))


def selected_gpu_type() -> str:
    return str(request_override("target_gpu_type", CONFIG["gpu_type"]))


def selected_gpu_count() -> int:
    return int(request_override("target_gpu_count", CONFIG["gpu_count"]) or 0)


def selected_accelerator_mode() -> str:
    return str(request_override("target_accelerator_mode", "attached"))


def selected_hardware_id() -> str:
    return str(request_override("target_hardware_id", default_hardware_selection()["id"]))


def instance_url() -> str:
    project = require_env("project")
    zone = selected_zone()
    instance = require_env("instance")
    return (
        "https://compute.googleapis.com/compute/v1/"
        f"projects/{project}/zones/{zone}/instances/{instance}"
    )


def instances_collection_url() -> str:
    project = require_env("project")
    zone = selected_zone()
    return f"https://compute.googleapis.com/compute/v1/projects/{project}/zones/{zone}/instances"


def firewalls_collection_url() -> str:
    project = require_env("project")
    return f"https://compute.googleapis.com/compute/v1/projects/{project}/global/firewalls"


def firewall_url(name: str) -> str:
    return f"{firewalls_collection_url()}/{name}"


def zone_region(zone: str) -> str:
    if zone.count("-") >= 2:
        return zone.rsplit("-", 1)[0]
    return zone


def machine_type_path() -> str:
    return f"zones/{selected_zone()}/machineTypes/{selected_machine_type()}"


def accelerator_type_path() -> str:
    return f"zones/{selected_zone()}/acceleratorTypes/{selected_gpu_type()}"


def disk_type_path() -> str:
    return f"zones/{selected_zone()}/diskTypes/{CONFIG['boot_disk_type']}"


def data_disk_type_path() -> str:
    return f"zones/{selected_zone()}/diskTypes/{CONFIG['data_disk_type']}"


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
        f"projects/{require_env('project')}/regions/{zone_region(selected_zone())}/subnetworks/{value}"
    )


def parse_disk_size_gb(raw_value: str) -> str:
    digits = "".join(ch for ch in raw_value if ch.isdigit())
    if not digits:
        raise ApiError("BOOT_DISK_SIZE must include a numeric size.", 500)
    return digits


def default_hardware_selection() -> dict[str, Any]:
    gpu_count = int(CONFIG["gpu_count"] or 0)
    gpu_type = str(CONFIG["gpu_type"] or "")
    if gpu_count <= 0:
        return {
            "id": CPU_HARDWARE_ID,
            "label": "CPU",
            "zone": CONFIG["zone"],
            "machineType": CONFIG["machine_type"] or DEFAULT_CPU_MACHINE_TYPE,
            "gpuType": "",
            "gpuCount": 0,
            "acceleratorMode": "none",
        }
    return {
        "id": gpu_type,
        "label": gpu_type,
        "zone": CONFIG["zone"],
        "machineType": CONFIG["machine_type"],
        "gpuType": gpu_type,
        "gpuCount": gpu_count,
        "acceleratorMode": "builtin" if gpu_type == "nvidia-l4" else "attached",
    }


def parse_int_payload_value(raw: Any, default: int) -> int:
    if raw in (None, ""):
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise ApiError("Hardware GPU count must be an integer.", 400)


def clean_target_text(raw: Any, default: str) -> str:
    value = str(raw or "").strip()
    return value or default


def apply_target_overrides(source: Any) -> None:
    default = default_hardware_selection()
    zone = clean_target_text(source.get("zone") if hasattr(source, "get") else None, default["zone"])
    machine_type = clean_target_text(
        source.get("machineType") if hasattr(source, "get") else None,
        str(default["machineType"]),
    )
    gpu_type = clean_target_text(
        source.get("gpuType") if hasattr(source, "get") else None,
        str(default["gpuType"]),
    )
    hardware_id = clean_target_text(
        source.get("hardwareId") if hasattr(source, "get") else None,
        str(default["id"]),
    )
    accelerator_mode = clean_target_text(
        source.get("acceleratorMode") if hasattr(source, "get") else None,
        str(default["acceleratorMode"]),
    )
    gpu_count = parse_int_payload_value(
        source.get("gpuCount") if hasattr(source, "get") else None,
        int(default["gpuCount"]),
    )

    if not zone.replace("-", "").isalnum():
        raise ApiError("Zone contains unsupported characters.", 400)
    if not machine_type.replace("-", "").isalnum():
        raise ApiError("Machine type contains unsupported characters.", 400)
    if gpu_type and not gpu_type.replace("-", "").isalnum():
        raise ApiError("GPU type contains unsupported characters.", 400)
    if accelerator_mode not in {"none", "attached", "builtin"}:
        raise ApiError("Accelerator mode is invalid.", 400)
    if gpu_count < 0 or gpu_count > 16:
        raise ApiError("GPU count is invalid.", 400)
    if gpu_count == 0:
        gpu_type = ""
        accelerator_mode = "none"
        hardware_id = CPU_HARDWARE_ID

    g.target_zone = zone
    g.target_machine_type = machine_type
    g.target_gpu_type = gpu_type
    g.target_gpu_count = gpu_count
    g.target_accelerator_mode = accelerator_mode
    g.target_hardware_id = hardware_id


def compute_collection(url: str) -> list[dict[str, Any]]:
    data = compute_request("GET", url)
    if not isinstance(data, dict):
        return []
    items = data.get("items", []) or []
    return [item for item in items if isinstance(item, dict)]


def list_available_zones() -> list[str]:
    project = require_env("project")
    zones = []
    for zone in compute_collection(f"https://compute.googleapis.com/compute/v1/projects/{project}/zones"):
        if str(zone.get("status", "")).upper() != "UP":
            continue
        name = str(zone.get("name", ""))
        if name:
            zones.append(name)
    return sorted(zones)


def accelerator_zones(zones: list[str]) -> dict[str, list[str]]:
    project = require_env("project")
    result: dict[str, list[str]] = {}
    zone_set = set(zones)
    data = compute_request(
        "GET",
        f"https://compute.googleapis.com/compute/v1/projects/{project}/aggregated/acceleratorTypes",
    )
    if not isinstance(data, dict):
        return result
    items = data.get("items", {}) or {}
    if not isinstance(items, dict):
        return result
    for scoped_name, scoped_data in items.items():
        if not isinstance(scoped_data, dict):
            continue
        zone = str(scoped_name).rsplit("/", 1)[-1]
        if zone not in zone_set:
            continue
        for accelerator in scoped_data.get("acceleratorTypes", []) or []:
            if not isinstance(accelerator, dict):
                continue
            name = str(accelerator.get("name", ""))
            if name:
                result.setdefault(name, []).append(zone)
    return {name: sorted(values) for name, values in sorted(result.items())}


def hardware_profile(
    *,
    hardware_id: str,
    label: str,
    machine_type: str,
    gpu_type: str,
    gpu_count: int,
    accelerator_mode: str,
    zones: list[str],
) -> dict[str, Any]:
    return {
        "id": hardware_id,
        "label": label,
        "machineType": machine_type,
        "gpuType": gpu_type,
        "gpuCount": gpu_count,
        "acceleratorMode": accelerator_mode,
        "zones": zones,
    }


def build_hardware_payload() -> dict[str, Any]:
    zones = list_available_zones()
    by_accelerator = accelerator_zones(zones)
    profiles = [
        hardware_profile(
            hardware_id=CPU_HARDWARE_ID,
            label="CPU",
            machine_type=DEFAULT_CPU_MACHINE_TYPE,
            gpu_type="",
            gpu_count=0,
            accelerator_mode="none",
            zones=zones,
        ),
        hardware_profile(
            hardware_id="nvidia-tesla-t4",
            label="GPU T4",
            machine_type=DEFAULT_T4_MACHINE_TYPE,
            gpu_type="nvidia-tesla-t4",
            gpu_count=1,
            accelerator_mode="attached",
            zones=by_accelerator.get("nvidia-tesla-t4", []),
        ),
        hardware_profile(
            hardware_id="nvidia-l4",
            label="GPU L4",
            machine_type=DEFAULT_L4_MACHINE_TYPE,
            gpu_type="nvidia-l4",
            gpu_count=1,
            accelerator_mode="builtin",
            zones=by_accelerator.get("nvidia-l4", []),
        ),
    ]

    known = {str(profile["id"]) for profile in profiles}
    for accelerator_name, accelerator_zone_list in by_accelerator.items():
        if accelerator_name in known:
            continue
        profiles.append(
            hardware_profile(
                hardware_id=accelerator_name,
                label=accelerator_name,
                machine_type=DEFAULT_T4_MACHINE_TYPE,
                gpu_type=accelerator_name,
                gpu_count=1,
                accelerator_mode="attached",
                zones=accelerator_zone_list,
            )
        )

    return {
        "refreshedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "project": CONFIG["project"],
        "scope": "global-zones",
        "defaultSelection": default_hardware_selection(),
        "zones": zones,
        "accelerators": by_accelerator,
        "profiles": profiles,
    }


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
@app.route("/api/hardware", methods=["GET", "OPTIONS"])
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
                "applicationCatalog": APPLICATION_CATALOG,
                "defaultHardware": default_hardware_selection(),
                "target": {
                    "project": CONFIG["project"],
                    "zone": CONFIG["zone"],
                    "instance": CONFIG["instance"],
                },
                "duckdnsDomains": CONFIG["duckdns_domains"],
                "ports": {
                    "novnc": CONFIG["novnc_port"],
                    "sunshine": CONFIG["sunshine_port"],
                    "minecraft": CONFIG["minecraft_port"],
                },
            }
        )

    if request.path == "/api/hardware":
        require_user()
        return jsonify(build_hardware_payload())

    if request.path == "/api/me":
        return jsonify({"user": require_user()})

    if request.path == "/api/status":
        user = require_user()
        apply_target_overrides(request.args)
        instance = get_instance_or_none()
        return jsonify(build_status_payload(instance, user=user, command="status"))

    if request.path == "/api/command":
        user = require_user()
        payload = request.get_json(silent=True) or {}
        apply_target_overrides(payload)
        command = str(payload.get("command", "")).strip().lower()
        if command not in {
            "status",
            "start",
            "stop",
            "restart",
            "create",
            "delete",
            "create-backup",
            "restore-backup",
            "remove-backup",
            "set-sunshine-password",
            "install-app",
            "uninstall-app",
            "install-minecraft",
            "start-minecraft",
            "stop-minecraft",
            "restart-minecraft",
            "remove-minecraft",
        }:
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
        f"projects/{CONFIG['project']}/zones/{selected_zone()}/operations/{operation_name}"
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


def wait_for_global_operation(operation: dict[str, Any], timeout_seconds: int = 90) -> None:
    operation_name = str(operation.get("name", "") or "")
    if not operation_name:
        return

    url = (
        "https://compute.googleapis.com/compute/v1/"
        f"projects/{CONFIG['project']}/global/operations/{operation_name}"
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


def parse_sunshine_password(payload: dict[str, Any]) -> str:
    raw = payload.get("sunshinePassword")
    if not isinstance(raw, str):
        raise ApiError("sunshinePassword must be a non-empty text field.", 400)

    password = raw.strip()
    if len(password) < SUNSHINE_PASSWORD_MIN_LENGTH:
        raise ApiError(
            f"Sunshine password must be at least {SUNSHINE_PASSWORD_MIN_LENGTH} characters.",
            400,
        )
    if len(password) > SUNSHINE_PASSWORD_MAX_LENGTH:
        raise ApiError(
            f"Sunshine password must be at most {SUNSHINE_PASSWORD_MAX_LENGTH} characters.",
            400,
        )
    return password


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


def normalize_sunshine_credentials_for_response(raw: dict[str, str]) -> dict[str, str]:
    return {
        "username": raw.get("username") or SUNSHINE_USERNAME,
        "password": "",
    }


def ensure_sunshine_credentials(instance: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    credentials = sunshine_credentials_from_instance(instance)
    password = credentials.get("password", "").strip()
    if password and password != "change-me":
        return instance, credentials

    password = generate_sunshine_password()
    updated_instance, _ = update_steam_env_metadata(
        instance,
        {
            "SUNSHINE_USER": SUNSHINE_USERNAME,
            "SUNSHINE_PASS": password,
        },
    )
    return updated_instance, {"username": SUNSHINE_USERNAME, "password": password}


def set_sunshine_password(
    instance: dict[str, Any],
    password: str,
) -> tuple[dict[str, Any], dict[str, str]]:
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
    extra_metadata: dict[str, str | None] | None = None,
    sunshine_state: str | None = "starting",
) -> tuple[dict[str, Any], str]:
    token = generate_action_token()
    updates: dict[str, str | None] = {
        "vm-power-action-script": decode_config_b64("vm_power_action_script_b64"),
        POWER_ACTION_METADATA_KEY: f"{action}:{token}",
        POWER_ACTION_STATUS_METADATA_KEY: f"requested:{action}:{token}",
    }
    if sunshine_state is not None:
        updates[SUNSHINE_STATUS_METADATA_KEY] = sunshine_state
        updates[SUNSHINE_STATUS_DETAIL_METADATA_KEY] = status_detail
    if extra_metadata:
        updates.update(extra_metadata)
    set_instance_metadata_values(instance, updates)
    return get_instance(), token


def wait_for_power_action_phase(
    *,
    action: str,
    token: str,
    target_phase: str,
    timeout_seconds: int = 300,
) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_instance: dict[str, Any] | None = None
    while time.time() < deadline:
        last_instance = get_instance()
        phase, status_action, status_token = parse_power_action_status(
            metadata_value(last_instance, POWER_ACTION_STATUS_METADATA_KEY)
        )
        if status_action == action and status_token == token:
            if phase == target_phase:
                return last_instance
            if phase == "failed":
                raise ApiError(f"VM action {action} failed.", 502)
        time.sleep(4)

    if last_instance:
        return last_instance
    raise ApiError(f"Timed out waiting for VM action {action}.", 504)


def parse_backup_id(payload: dict[str, Any]) -> str:
    raw = str(payload.get("backupId", "") or "").strip()
    if not raw:
        raise ApiError("backupId is required.", 400)
    if "/" in raw or "\\" in raw or raw.startswith(".") or ".." in raw:
        raise ApiError("backupId is invalid.", 400)
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-TZ")
    if any(ch not in allowed for ch in raw):
        raise ApiError("backupId contains unsupported characters.", 400)
    return raw


def parse_application_id(payload: dict[str, Any]) -> str:
    raw = str(payload.get("applicationId", "") or "").strip().lower()
    if not raw:
        raise ApiError("applicationId is required.", 400)
    if raw not in APPLICATION_IDS:
        raise ApiError("applicationId is not supported.", 400)
    return raw


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


def has_sunshine_healthcheck(instance: dict[str, Any]) -> bool:
    external_ip = extract_external_ip(instance).strip()
    primary_duckdns = CONFIG["duckdns_domains"][0] if CONFIG["duckdns_domains"] else ""

    for host in [h for h in [external_ip, primary_duckdns] if h]:
        url = f"https://{host}:{CONFIG['sunshine_port']}/"
        try:
            response = requests.get(url, timeout=SUNSHINE_HEALTHCHECK_TIMEOUT_SECONDS, verify=False)
        except requests.RequestException as error:
            logging.debug("Sunshine healthcheck failed for %s: %s", url, error)
            continue

        if response.status_code > 0:
            return True

    return False


def is_sunshine_started(
    instance: dict[str, Any], current_state: str, detail: str
) -> bool:
    if current_state != "starting":
        return current_state == "ready"
    if has_sunshine_healthcheck(instance):
        return True

    phase, _, _ = parse_power_action_status(
        metadata_value(instance, POWER_ACTION_STATUS_METADATA_KEY)
    )
    backup_ready = bool(metadata_value(instance, BACKUP_READY_AT_METADATA_KEY).strip())
    if phase in {"applied", "backed-up", "completed", "restored", "failed"} and backup_ready and not detail.lower().startswith("vm booting"):
        return True
    return False


def wait_for_sunshine_status(
    target_state: str,
    timeout_seconds: int = 300,
) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_instance: dict[str, Any] | None = None
    target_state = target_state.strip().lower()
    while time.time() < deadline:
        last_instance = get_instance()
        if str(last_instance.get("status", "")).upper() != "RUNNING":
            time.sleep(3)
            continue

        status = build_sunshine_status(last_instance)
        current_state = str(status.get("state", "")).strip().lower()
        if current_state == target_state:
            return last_instance

        time.sleep(4)

    if last_instance:
        return last_instance
    raise ApiError("Timed out waiting for Sunshine status to settle.", 504)


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
        {"key": "vm-gpu-count", "value": str(selected_gpu_count())},
        {"key": "vm-gpu-type", "value": selected_gpu_type()},
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
    else:
        items.append({"key": RESTORE_STATUS_METADATA_KEY, "value": "idle"})
        items.append({"key": RESTORE_DETAIL_METADATA_KEY, "value": "No restore requested."})

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


def firewall_rule_body(name: str, allowed: list[dict[str, Any]]) -> dict[str, Any]:
    tags = CONFIG["vm_tags"] or ["steam-headless"]
    return {
        "name": name,
        "network": network_path(),
        "direction": "INGRESS",
        "allowed": allowed,
        "sourceRanges": CONFIG["firewall_source_ranges"],
        "targetTags": tags,
    }


def ensure_firewall_rule(name: str, allowed: list[dict[str, Any]]) -> None:
    body = firewall_rule_body(name, allowed)
    existing = compute_request("GET", firewall_url(name), allow_404=True)
    if existing is None:
        operation = compute_request("POST", firewalls_collection_url(), json=body)
    else:
        operation = compute_request("PATCH", firewall_url(name), json=body)
    if isinstance(operation, dict):
        wait_for_global_operation(operation, timeout_seconds=120)


def ensure_firewall_rules() -> None:
    ensure_firewall_rule(CONFIG["firewall_rule_web"], FIREWALL_WEB_ALLOWED)
    ensure_firewall_rule(CONFIG["firewall_rule_sunshine"], FIREWALL_SUNSHINE_ALLOWED)
    ensure_firewall_rule(CONFIG["firewall_rule_minecraft"], FIREWALL_MINECRAFT_ALLOWED)


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
                )
            },
    }

    if CONFIG["vm_tags"]:
        request_body["tags"] = {"items": CONFIG["vm_tags"]}
    if selected_gpu_count() > 0 and selected_accelerator_mode() == "attached":
        request_body["guestAccelerators"] = [
            {
                "acceleratorType": accelerator_type_path(),
                "acceleratorCount": selected_gpu_count(),
            }
        ]
    return request_body


def build_urls(external_ip: str) -> dict[str, Any]:
    urls: dict[str, Any] = {
        "novnc": "",
        "sunshine": "",
        "minecraft": "",
        "moonlightHost": external_ip,
        "duckdns": [],
    }
    primary_duckdns = CONFIG["duckdns_domains"][0] if CONFIG["duckdns_domains"] else ""
    if primary_duckdns:
        urls["novnc"] = f"http://{primary_duckdns}:{CONFIG['novnc_port']}/"
        urls["sunshine"] = f"https://{primary_duckdns}:{CONFIG['sunshine_port']}/"
        urls["minecraft"] = f"{primary_duckdns}:{CONFIG['minecraft_port']}"
        urls["moonlightHost"] = primary_duckdns
    elif external_ip:
        urls["novnc"] = f"http://{external_ip}:{CONFIG['novnc_port']}/"
        urls["sunshine"] = f"https://{external_ip}:{CONFIG['sunshine_port']}/"
        urls["minecraft"] = f"{external_ip}:{CONFIG['minecraft_port']}"

    duckdns_entries = []
    for domain in CONFIG["duckdns_domains"]:
        duckdns_entries.append(
            {
                "domain": domain,
                "novnc": f"http://{domain}:{CONFIG['novnc_port']}/",
                "sunshine": f"https://{domain}:{CONFIG['sunshine_port']}/",
                "minecraft": f"{domain}:{CONFIG['minecraft_port']}",
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
    phase, power_action, _ = parse_power_action_status(
        metadata_value(instance, POWER_ACTION_STATUS_METADATA_KEY)
    )
    if power_action == "create-backup" and phase in {"requested", "running"}:
        return {
            "state": "backup",
            "label": "Backup in progress",
            "detail": detail or "Steam Headless and Sunshine are temporarily stopped while the manual backup is running.",
        }
    if power_action == "restore-backup" and phase in {"requested", "running"}:
        return {
            "state": "restore",
            "label": "Restore in progress",
            "detail": detail or "Steam Headless and Sunshine are temporarily stopped while the selected backup is restored.",
        }
    if power_action == "restart" and phase in {"requested", "running", "rebooting"}:
        return {
            "state": "starting",
            "label": "Restarting",
            "detail": detail or "VM is restarting. Waiting for Sunshine Web UI.",
        }
    if power_action == "apply-sunshine-password" and phase in {"requested", "running"}:
        return {
            "state": "starting",
            "label": "Applying password",
            "detail": detail or "Applying Sunshine password change.",
        }
    if power_action in {"install-app", "uninstall-app"} and phase in {"requested", "running"}:
        return {
            "state": "starting",
            "label": "Updating application",
            "detail": detail or "Updating Sunshine application list.",
        }
    if power_action in {"delete", "stop"} and phase in {"requested", "running", "backed-up", "stopping"}:
        return {
            "state": "stopping",
            "label": "Stopping",
            "detail": detail or "Steam Headless and Sunshine are stopping for the requested VM action.",
        }
    if is_sunshine_started(instance, state, detail):
        state = "ready"
        detail = "Sunshine Web UI is available."
    labels = {
        "ready": "Ready",
        "starting": "Starting",
        "stopping": "Stopping",
        "backup": "Backup in progress",
        "restore": "Restore in progress",
        "error": "Error",
    }
    return {
        "state": state,
        "label": labels.get(state, state.title()),
        "detail": detail,
    }


def build_minecraft_status(instance: dict[str, Any] | None) -> dict[str, str]:
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

    state = metadata_value(instance, MINECRAFT_STATUS_METADATA_KEY).strip().lower() or "not_installed"
    detail = metadata_value(instance, MINECRAFT_STATUS_DETAIL_METADATA_KEY).strip()
    phase, power_action, _ = parse_power_action_status(
        metadata_value(instance, POWER_ACTION_STATUS_METADATA_KEY)
    )
    if power_action in {
        "install-minecraft",
        "start-minecraft",
        "stop-minecraft",
        "restart-minecraft",
        "remove-minecraft",
    } and phase in {"requested", "running"}:
        action_labels = {
            "install-minecraft": "Installing",
            "start-minecraft": "Starting",
            "stop-minecraft": "Stopping",
            "restart-minecraft": "Restarting",
            "remove-minecraft": "Removing",
        }
        return {
            "state": "starting" if power_action != "stop-minecraft" else "stopping",
            "label": action_labels.get(power_action, "Updating"),
            "detail": detail or "Minecraft server action is running.",
        }

    labels = {
        "not_installed": "Not installed",
        "installing": "Installing",
        "starting": "Starting",
        "running": "Running",
        "stopping": "Stopping",
        "stopped": "Stopped",
        "removed": "Removed",
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
            "backupReady": {
                "state": "",
                "label": "",
                "lastAt": "",
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
            "backups": [],
        }

    data_disk_state = metadata_value(instance, DATA_DISK_STATUS_METADATA_KEY).strip().lower()
    restore_mode = metadata_value(instance, RESTORE_MODE_METADATA_KEY).strip().lower()
    restore_state = metadata_value(instance, RESTORE_STATUS_METADATA_KEY).strip().lower()
    games_archive_state = metadata_value(instance, GAMES_ARCHIVE_STATUS_METADATA_KEY).strip().lower()
    backups: list[dict[str, Any]] = []
    raw_backups = metadata_value(instance, BACKUPS_JSON_METADATA_KEY).strip()
    if raw_backups:
        try:
            parsed_backups = json.loads(raw_backups)
            if isinstance(parsed_backups, list):
                backups = [item for item in parsed_backups if isinstance(item, dict)]
        except Exception:
            backups = []

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
        "backupReady": {
            "state": "ready" if metadata_value(instance, BACKUP_READY_AT_METADATA_KEY).strip() else "pending",
            "label": (
                "Ready"
                if metadata_value(instance, BACKUP_READY_AT_METADATA_KEY).strip()
                else "Pending"
            ),
            "lastAt": metadata_value(instance, BACKUP_READY_AT_METADATA_KEY),
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
        "backups": backups,
    }


def is_live_backup_ready(instance: dict[str, Any] | None) -> bool:
    if instance is None:
        return False
    status = str(instance.get("status", "")).upper()
    if status != "RUNNING":
        return False
    return bool(metadata_value(instance, BACKUP_READY_AT_METADATA_KEY).strip())


def require_live_backup_ready(instance: dict[str, Any] | None, command: str) -> None:
    if is_live_backup_ready(instance):
        return
    raise ApiError(
        f'VM is still booting. "{command}" is available only after startup finishes and live backup becomes ready.',
        409,
    )


ACTIVE_POWER_ACTION_PHASES = {"requested", "running", "rebooting", "stopping", "backed-up"}


def active_power_action(instance: dict[str, Any] | None) -> dict[str, str] | None:
    if instance is None:
        return None

    instance_status = str(instance.get("status", "UNKNOWN")).upper()
    phase, action, token = parse_power_action_status(
        metadata_value(instance, POWER_ACTION_STATUS_METADATA_KEY)
    )
    pending = metadata_value(instance, POWER_ACTION_METADATA_KEY).strip()

    if action and phase in ACTIVE_POWER_ACTION_PHASES and instance_status == "RUNNING":
        return {
            "phase": phase,
            "action": action,
            "token": token,
            "pending": pending,
        }

    if pending:
        pending_action = pending.split(":", 1)[0]
        return {
            "phase": "requested",
            "action": pending_action,
            "token": pending.split(":", 1)[1] if ":" in pending else "",
            "pending": pending,
        }

    return None


def require_no_active_power_action(instance: dict[str, Any] | None, command: str) -> None:
    active = active_power_action(instance)
    if not active:
        return

    action = active.get("action") or "unknown"
    phase = active.get("phase") or "active"
    raise ApiError(
        f'VM action "{action}" is still {phase}. Wait for it to finish before running "{command}".',
        409,
    )


def allowed_commands(instance: dict[str, Any] | None) -> list[str]:
    if instance is None:
        return ["status", "create"]

    status = str(instance.get("status", "UNKNOWN")).upper()
    if status == "RUNNING":
        if active_power_action(instance):
            return ["status"]
        commands = ["status", "set-sunshine-password"]
        if is_live_backup_ready(instance):
            commands.extend([
                "restart",
                "stop",
                "delete",
                "create-backup",
                "restore-backup",
                "remove-backup",
                "install-app",
                "uninstall-app",
                "install-minecraft",
                "start-minecraft",
                "stop-minecraft",
                "restart-minecraft",
                "remove-minecraft",
            ])
        return commands
    if status == "TERMINATED":
        return ["status", "start", "delete", "set-sunshine-password"]
    return ["status", "delete"]


def build_power_action_status(instance: dict[str, Any] | None) -> dict[str, str]:
    if instance is None:
        return {
            "phase": "",
            "action": "",
            "token": "",
            "pending": "",
            "label": "",
        }

    phase, action, token = parse_power_action_status(
        metadata_value(instance, POWER_ACTION_STATUS_METADATA_KEY)
    )
    pending = metadata_value(instance, POWER_ACTION_METADATA_KEY).strip()
    instance_status = str(instance.get("status", "UNKNOWN")).upper()
    if instance_status != "RUNNING" and not pending:
        phase = ""
        action = ""
        token = ""
    labels = {
        "requested": "Requested",
        "running": "Running",
        "backed-up": "Backed up",
        "applied": "Applied",
        "completed": "Completed",
        "installed": "Installed",
        "uninstalled": "Uninstalled",
        "removed": "Removed",
        "started": "Started",
        "rebooting": "Rebooting",
        "restarted": "Restarted",
        "restored": "Restored",
        "stopping": "Stopping",
        "failed": "Failed",
    }
    return {
        "phase": phase,
        "action": action,
        "token": token,
        "pending": pending,
        "label": labels.get(phase, phase.title() if phase else ""),
    }


def build_status_payload(
    instance: dict[str, Any] | None,
    *,
    user: dict[str, Any],
    command: str,
    duckdns_updated: bool | None = None,
    sunshine_credentials: dict[str, str] | None = None,
) -> dict[str, Any]:
    hardware = {
        "id": selected_hardware_id(),
        "zone": selected_zone(),
        "machineType": selected_machine_type(),
        "gpuType": selected_gpu_type(),
        "gpuCount": selected_gpu_count(),
        "acceleratorMode": selected_accelerator_mode(),
    }
    if instance is None:
        payload = {
            "command": command,
            "target": {
                "project": CONFIG["project"],
                "zone": selected_zone(),
                "instance": CONFIG["instance"],
            },
            "hardware": hardware,
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
            "minecraftStatus": build_minecraft_status(None),
            "persistence": build_persistence_status(None),
            "powerAction": build_power_action_status(None),
            "applications": {
                "catalog": APPLICATION_CATALOG,
                "selected": "",
            },
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
            "zone": selected_zone(),
            "instance": CONFIG["instance"],
        },
        "hardware": hardware,
        "status": status,
        "instanceExists": True,
        "allowedCommands": allowed_commands(instance),
        "externalIp": external_ip,
        "duckdnsDomains": CONFIG["duckdns_domains"],
        "urls": build_urls(external_ip),
        "user": user,
        "autoStopHours": metadata_value(instance, AUTO_STOP_METADATA_KEY),
        "sunshineCredentials": normalize_sunshine_credentials_for_response(credentials),
        "sunshineStatus": build_sunshine_status(instance),
        "minecraftStatus": build_minecraft_status(instance),
        "persistence": build_persistence_status(instance),
        "powerAction": build_power_action_status(instance),
        "applications": {
            "catalog": APPLICATION_CATALOG,
            "selected": metadata_value(instance, SELECTED_APPLICATION_METADATA_KEY),
        },
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


def restart_instance_and_wait(current_instance: dict[str, Any], detail: str) -> dict[str, Any]:
    set_instance_metadata_values(
        current_instance,
        {
            SUNSHINE_STATUS_METADATA_KEY: "starting",
            SUNSHINE_STATUS_DETAIL_METADATA_KEY: detail,
        },
    )
    stop_operation = compute_request("POST", f"{instance_url()}/stop")
    if not isinstance(stop_operation, dict):
        raise ApiError("Failed to stop VM instance before restart.", 502)

    wait_for_zone_operation(stop_operation, timeout_seconds=120)
    poll_instance_status("TERMINATED", timeout_seconds=600)

    operation = compute_request("POST", f"{instance_url()}/start")
    if not isinstance(operation, dict):
        raise ApiError("Failed to restart VM instance.", 502)

    wait_for_zone_operation(operation)
    poll_instance_status("RUNNING", timeout_seconds=900)
    return wait_for_external_ip(timeout_seconds=180)


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

    require_no_active_power_action(current_instance, command)

    if command == "create":
        if current_instance is not None:
            raise ApiError("Instance already exists.", 400)
        auto_stop_hours = parse_auto_stop_hours(payload)
        sunshine_credentials = {
            "username": SUNSHINE_USERNAME,
            "password": generate_sunshine_password(),
        }
        ensure_firewall_rules()
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
            current_instance, sunshine_credentials = ensure_sunshine_credentials(current_instance)
            set_instance_metadata_values(
                current_instance,
                {
                    AUTO_STOP_METADATA_KEY: str(auto_stop_hours) if auto_stop_hours is not None else None,
                    POWER_ACTION_METADATA_KEY: None,
                    POWER_ACTION_STATUS_METADATA_KEY: None,
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
            require_live_backup_ready(current_instance, command)
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
        current_instance, sunshine_credentials = ensure_sunshine_credentials(current_instance)
        set_instance_metadata_values(
            current_instance,
            {
                SUNSHINE_STATUS_METADATA_KEY: "starting",
                SUNSHINE_STATUS_DETAIL_METADATA_KEY: "VM restarting. Waiting for Sunshine Web UI.",
            },
        )
        current_instance = get_instance()
        if current_status == "RUNNING":
            current_instance, token = request_live_power_action(
                current_instance,
                action="restart",
                status_detail="VM restarting without creating a backup.",
            )
            wait_for_power_action_phase(
                action="restart",
                token=token,
                target_phase="rebooting",
                timeout_seconds=120,
            )
            final_instance = wait_for_external_ip(timeout_seconds=180)
            final_instance = wait_for_sunshine_status("ready", timeout_seconds=240)
            set_instance_metadata_values(
                final_instance,
                {
                    POWER_ACTION_STATUS_METADATA_KEY: f"restarted:restart:{token}",
                    POWER_ACTION_METADATA_KEY: None,
                },
            )
            final_instance = get_instance()
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

        if current_status == "RUNNING":
            require_live_backup_ready(current_instance, command)
            current_instance, _ = request_live_power_action(
                current_instance,
                action="delete",
                status_detail="VM deleting without creating a backup.",
            )
            poll_instance_status("TERMINATED", timeout_seconds=900)
        elif current_status != "TERMINATED":
            poll_instance_status("TERMINATED", timeout_seconds=900)
        operation = compute_request("DELETE", instance_url())
        if not isinstance(operation, dict):
            raise ApiError("Failed to delete instance.", 502)
        wait_for_zone_operation(operation, timeout_seconds=180)
        poll_instance_deleted(timeout_seconds=120)
        return build_status_payload(None, user=user, command=command)

    if command == "create-backup":
        if current_instance is None:
            raise ApiError("Instance does not exist. Create it first.", 400)
        if current_status != "RUNNING":
            raise ApiError("Create Backup requires a running VM.", 400)
        require_live_backup_ready(current_instance, command)
        current_instance, token = request_live_power_action(
            current_instance,
            action="create-backup",
            status_detail="Creating a manual backup. Sunshine is temporarily stopped.",
        )
        final_instance = wait_for_power_action_phase(
            action="create-backup",
            token=token,
            target_phase="completed",
            timeout_seconds=3600,
        )
        return build_status_payload(final_instance, user=user, command=command)

    if command == "restore-backup":
        if current_instance is None:
            raise ApiError("Instance does not exist. Create it first.", 400)
        if current_status != "RUNNING":
            raise ApiError("Restore Backup requires a running VM.", 400)
        require_live_backup_ready(current_instance, command)
        backup_id = parse_backup_id(payload)
        set_instance_metadata_values(
            current_instance,
            {
                SELECTED_BACKUP_METADATA_KEY: backup_id,
                RESTORE_STATUS_METADATA_KEY: "running",
                RESTORE_DETAIL_METADATA_KEY: f"Restoring backup {backup_id}.",
            },
        )
        current_instance = get_instance()
        current_instance, token = request_live_power_action(
            current_instance,
            action="restore-backup",
            status_detail="Restoring selected backup. Sunshine is temporarily stopped.",
        )
        try:
            final_instance = wait_for_power_action_phase(
                action="restore-backup",
                token=token,
                target_phase="restored",
                timeout_seconds=3600,
            )
        except ApiError:
            failed_instance = get_instance()
            set_instance_metadata_values(
                failed_instance,
                {
                    RESTORE_STATUS_METADATA_KEY: "failed",
                    RESTORE_DETAIL_METADATA_KEY: f"Restore backup {backup_id} failed.",
                },
            )
            raise
        final_instance = wait_for_external_ip(timeout_seconds=180)
        return build_status_payload(final_instance, user=user, command=command)

    if command == "remove-backup":
        if current_instance is None:
            raise ApiError("Instance does not exist. Create it first.", 400)
        if current_status != "RUNNING":
            raise ApiError("Remove Backup requires a running VM.", 400)
        require_live_backup_ready(current_instance, command)
        backup_id = parse_backup_id(payload)
        set_instance_metadata_values(
            current_instance,
            {
                SELECTED_BACKUP_METADATA_KEY: backup_id,
            },
        )
        current_instance = get_instance()
        current_instance, token = request_live_power_action(
            current_instance,
            action="remove-backup",
            status_detail=f"Removing manual backup {backup_id}.",
        )
        final_instance = wait_for_power_action_phase(
            action="remove-backup",
            token=token,
            target_phase="removed",
            timeout_seconds=900,
        )
        return build_status_payload(final_instance, user=user, command=command)

    if command in {"install-app", "uninstall-app"}:
        if current_instance is None:
            raise ApiError("Instance does not exist. Create it first.", 400)
        if current_status != "RUNNING":
            raise ApiError("Application changes require a running VM.", 400)
        require_live_backup_ready(current_instance, command)
        application_id = parse_application_id(payload)
        verb = "Installing" if command == "install-app" else "Uninstalling"
        target_phase = "installed" if command == "install-app" else "uninstalled"
        current_instance, token = request_live_power_action(
            current_instance,
            action=command,
            status_detail=f"{verb} application {application_id}. Sunshine is temporarily refreshed.",
            extra_metadata={
                SELECTED_APPLICATION_METADATA_KEY: application_id,
            },
        )
        final_instance = wait_for_power_action_phase(
            action=command,
            token=token,
            target_phase=target_phase,
            timeout_seconds=1800,
        )
        final_instance = wait_for_external_ip(timeout_seconds=180)
        final_instance = wait_for_sunshine_status("ready", timeout_seconds=240)
        return build_status_payload(final_instance, user=user, command=command)

    if command in {
        "install-minecraft",
        "start-minecraft",
        "stop-minecraft",
        "restart-minecraft",
        "remove-minecraft",
    }:
        if current_instance is None:
            raise ApiError("Instance does not exist. Create it first.", 400)
        if current_status != "RUNNING":
            raise ApiError("Minecraft server actions require a running VM.", 400)
        require_live_backup_ready(current_instance, command)
        ensure_firewall_rule(CONFIG["firewall_rule_minecraft"], FIREWALL_MINECRAFT_ALLOWED)
        target_phase = {
            "install-minecraft": "installed",
            "start-minecraft": "started",
            "stop-minecraft": "stopped",
            "restart-minecraft": "restarted",
            "remove-minecraft": "removed",
        }[command]
        current_instance, token = request_live_power_action(
            current_instance,
            action=command,
            status_detail=f"Running Minecraft server action {command}.",
            sunshine_state=None,
            extra_metadata={
                MINECRAFT_STATUS_METADATA_KEY: "starting" if command != "stop-minecraft" else "stopping",
                MINECRAFT_STATUS_DETAIL_METADATA_KEY: f"Running {command}.",
            },
        )
        final_instance = wait_for_power_action_phase(
            action=command,
            token=token,
            target_phase=target_phase,
            timeout_seconds=1200,
        )
        final_instance = wait_for_external_ip(timeout_seconds=180)
        updated = update_duckdns(extract_external_ip(final_instance))
        return build_status_payload(
            final_instance,
            user=user,
            command=command,
            duckdns_updated=updated,
        )

    if command == "set-sunshine-password":
        if "set-sunshine-password" not in allowed_commands(current_instance):
            raise ApiError("This action is not available for the current instance state.", 400)

        if current_instance is None:
            raise ApiError("Instance does not exist. Create it first.", 400)

        password = parse_sunshine_password(payload)
        current_instance, sunshine_credentials = set_sunshine_password(current_instance, password)
        if str(current_instance.get("status", "")).upper() == "RUNNING":
            current_instance, action_token = request_live_power_action(
                current_instance,
                action="apply-sunshine-password",
                status_detail="Applying Sunshine password change.",
            )
            current_instance = wait_for_power_action_phase(
                action="apply-sunshine-password",
                token=action_token,
                target_phase="applied",
                timeout_seconds=300,
            )
            current_instance = wait_for_external_ip(timeout_seconds=180)
            current_instance = wait_for_sunshine_status("ready", timeout_seconds=240)
            updated = update_duckdns(extract_external_ip(current_instance))
            return build_status_payload(
                current_instance,
                user=user,
                command=command,
                duckdns_updated=updated,
                sunshine_credentials=sunshine_credentials,
            )
        return build_status_payload(current_instance, user=user, command=command, sunshine_credentials=sunshine_credentials)

    raise ApiError("Unsupported command.", 400)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
