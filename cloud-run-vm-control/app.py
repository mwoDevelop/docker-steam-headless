import base64
import gzip
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import socket
import ssl
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.client import HTTPConnection, HTTPSConnection
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


DEFAULT_MINECRAFT_SERVER_VERSIONS: Final = [
    "LATEST",
    "1.21.8",
    "1.21.7",
    "1.21.6",
    "1.21.5",
    "1.21.4",
    "1.21.1",
    "1.20.6",
    "1.20.4",
]
MINECRAFT_SERVER_TYPES: Final = {
    "paper": {
        "id": "paper",
        "label": "Paper",
        "dockerType": "PAPER",
        "contentKind": "plugin",
        "contentLabel": "plugins",
        "modrinthLoaders": ["paper", "purpur", "spigot", "bukkit"],
    },
    "purpur": {
        "id": "purpur",
        "label": "Purpur",
        "dockerType": "PURPUR",
        "contentKind": "plugin",
        "contentLabel": "plugins",
        "modrinthLoaders": ["purpur", "paper", "spigot", "bukkit"],
    },
    "fabric": {
        "id": "fabric",
        "label": "Fabric",
        "dockerType": "FABRIC",
        "contentKind": "mod",
        "contentLabel": "mods",
        "modrinthLoaders": ["fabric"],
    },
    "forge": {
        "id": "forge",
        "label": "Forge",
        "dockerType": "FORGE",
        "contentKind": "mod",
        "contentLabel": "mods",
        "modrinthLoaders": ["forge"],
    },
    "neoforge": {
        "id": "neoforge",
        "label": "NeoForge",
        "dockerType": "NEOFORGE",
        "contentKind": "mod",
        "contentLabel": "mods",
        "modrinthLoaders": ["neoforge"],
    },
}
DEFAULT_MINECRAFT_SERVER_TYPE: Final = "paper"
MODRINTH_API_BASE_URL: Final = "https://api.modrinth.com/v2"
MODRINTH_USER_AGENT: Final = "docker-steam-headless-vm-control/1.0 (mwodevelop@gmail.com)"


CONFIG = {
    "project": os.environ.get("GCP_PROJECT", ""),
    "zone": os.environ.get("GCP_ZONE", ""),
    "instance": os.environ.get("GCE_NAME", ""),
    "legacy_instance_names": csv_env("LEGACY_GCE_NAMES"),
    "machine_type": os.environ.get("MACHINE_TYPE", "n1-standard-4"),
    "gpu_type": os.environ.get("GPU_TYPE", "nvidia-tesla-t4-vws"),
    "gpu_count": int(os.environ.get("GPU_COUNT", "1") or "1"),
    "boot_disk_size": os.environ.get("BOOT_DISK_SIZE", "60GB"),
    "boot_disk_type": os.environ.get("BOOT_DISK_TYPE", "pd-ssd"),
    "data_disk_size": os.environ.get("DATA_DISK_SIZE", "100GB"),
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
    "firewall_rule_novnc_iap": os.environ.get("FIREWALL_RULE_NOVNC_IAP", "allow-steam-headless-novnc-iap"),
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
    "admin_google_emails": {value.lower() for value in (csv_env("ADMIN_GOOGLE_EMAILS") or ["mwodevelop@gmail.com"])},
    "access_users_secret_name": os.environ.get("ACCESS_USERS_SECRET_NAME", "steam-vm-control-allowed-users"),
    "endpoints_secret_name": os.environ.get("ENDPOINTS_SECRET_NAME", "steam-vm-control-endpoints"),
    "minecraft_versions_secret_name": os.environ.get("MINECRAFT_VERSIONS_SECRET_NAME", ""),
    "runtime_images_secret_name": os.environ.get("RUNTIME_IMAGES_SECRET_NAME", ""),
    "compatibility_catalog_secret_name": os.environ.get("COMPATIBILITY_CATALOG_SECRET_NAME", ""),
    "vm_minecraft_management_script_b64": os.environ.get("VM_MINECRAFT_MANAGEMENT_SCRIPT_B64", ""),
    "session_token_secret": os.environ.get("VM_CONTROL_SESSION_SECRET", ""),
    "capacity_cleanup_token": os.environ.get("CAPACITY_RESERVATION_CLEANUP_TOKEN", ""),
    "duckdns_domains": normalize_duckdns_domains(csv_env("DUCKDNS_DOMAINS")),
    "duckdns_token": os.environ.get("DUCKDNS_TOKEN", ""),
    "novnc_port": os.environ.get("VM_NOVNC_PORT", "8083"),
    "sunshine_port": os.environ.get("VM_SUNSHINE_PORT", "47990"),
    "minecraft_port": os.environ.get("VM_MINECRAFT_PORT", "25565"),
    "minecraft_versions": csv_env("MINECRAFT_VERSIONS") or list(DEFAULT_MINECRAFT_SERVER_VERSIONS),
}

SUNSHINE_HEALTHCHECK_TIMEOUT_SECONDS: Final = 8
SESSION_TOKEN_PREFIX: Final = "vmcs1"
SESSION_TOKEN_TTL_SECONDS: Final = 12 * 60 * 60

AUTO_STOP_METADATA_KEY = "vm-auto-shutdown-hours"
AUTO_STOP_AT_METADATA_KEY = "vm-auto-shutdown-at"
STEAM_ENV_METADATA_KEY = "steam-headless-env"
SUNSHINE_STATUS_METADATA_KEY = "vm-sunshine-status"
SUNSHINE_STATUS_DETAIL_METADATA_KEY = "vm-sunshine-status-detail"
GPU_COUNT_METADATA_KEY = "vm-gpu-count"
MINECRAFT_STATUS_METADATA_KEY = "vm-minecraft-status"
MINECRAFT_STATUS_DETAIL_METADATA_KEY = "vm-minecraft-status-detail"
MINECRAFT_VERSION_METADATA_KEY = "vm-minecraft-version"
MINECRAFT_SERVER_TYPE_METADATA_KEY = "vm-minecraft-server-type"
MINECRAFT_MODRINTH_CONTENT_METADATA_KEY = "vm-minecraft-modrinth-content"
MINECRAFT_SERVERS_METADATA_KEY = "vm-minecraft-servers"
MINECRAFT_SERVER_ID_METADATA_KEY = "vm-minecraft-server-id"
MINECRAFT_GAME_PORT_METADATA_KEY = "vm-minecraft-game-port"
MINECRAFT_MANAGEMENT_REQUEST_METADATA_KEY = "vm-minecraft-management-request"
MINECRAFT_MANAGEMENT_RESULT_METADATA_KEY = "vm-minecraft-management-result"
MINECRAFT_MANAGEMENT_AGENT_METADATA_KEY = "vm-minecraft-management-agent"
MINECRAFT_SERVER_PROPERTIES_METADATA_KEY = "vm-minecraft-server-properties"
RUNTIME_IMAGE_COMPONENT_METADATA_KEY = "vm-runtime-image-component"
RUNTIME_IMAGE_OPERATION_METADATA_KEY = "vm-runtime-image-operation"
RUNTIME_IMAGE_TARGET_REF_METADATA_KEY = "vm-runtime-image-target-ref"
RUNTIME_IMAGE_TARGET_TAG_METADATA_KEY = "vm-runtime-image-target-tag"
RUNTIME_IMAGE_CURRENT_REF_METADATA_KEY = "vm-runtime-image-current-ref"
RUNTIME_IMAGE_CURRENT_TAG_METADATA_KEY = "vm-runtime-image-current-tag"
RUNTIME_IMAGE_PREVIOUS_REF_METADATA_KEY = "vm-runtime-image-previous-ref"
RUNTIME_IMAGE_PREVIOUS_TAG_METADATA_KEY = "vm-runtime-image-previous-tag"
RUNTIME_IMAGE_STATUS_METADATA_KEY = "vm-runtime-image-status"
RUNTIME_IMAGE_DETAIL_METADATA_KEY = "vm-runtime-image-detail"
RUNTIME_IMAGE_AGENT_METADATA_KEY = "vm-runtime-image-agent"
MINECRAFT_IMAGE_METADATA_KEY = "vm-minecraft-image"
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
COMPUTE_BILLING_SERVICE_ID = "6F81-5844-456A"
PRICE_CURRENCY_CODE = "PLN"
PRICE_CACHE_TTL_SECONDS = 6 * 60 * 60
BILLING_HOURS_PER_MONTH = 730
CAPACITY_RESERVATION_TTL_SECONDS = max(60, min(int(os.environ.get("CAPACITY_RESERVATION_TTL_SECONDS", "300") or "300"), 900))
CAPACITY_RESERVATION_DESCRIPTION_PREFIX: Final = "steam-vm-control-capacity-probe"
MACHINE_TYPE_SPECS: Final = {
    "n1-standard-4": {"family": "n1-standard", "vcpus": 4.0, "memoryGb": 15.0},
    "g2-standard-4": {"family": "g2", "vcpus": 4.0, "memoryGb": 16.0},
}
GPU_PRICE_DESCRIPTION_ALIASES: Final = {
    "nvidia-l4": ("Nvidia L4 GPU",),
    "nvidia-l4-vws": ("Nvidia L4 Virtual Workstation GPU", "Nvidia L4 GPU"),
    "nvidia-tesla-t4": ("Nvidia Tesla T4 GPU",),
    "nvidia-tesla-t4-vws": ("Nvidia Tesla T4 Virtual Workstation GPU", "Nvidia Tesla T4 GPU"),
    "nvidia-tesla-p4": ("Nvidia Tesla P4 GPU",),
    "nvidia-tesla-p4-vws": ("Nvidia Tesla P4 Virtual Workstation GPU", "Nvidia Tesla P4 GPU"),
    "nvidia-tesla-p100": ("Nvidia Tesla P100 GPU",),
    "nvidia-tesla-p100-vws": ("Nvidia Tesla P100 Virtual Workstation GPU", "Nvidia Tesla P100 GPU"),
    "nvidia-tesla-v100": ("Nvidia Tesla V100 GPU",),
    "nvidia-tesla-a100": ("Nvidia Tesla A100 GPU",),
    "nvidia-a100-80gb": ("Nvidia Tesla A100 80GB GPU", "Nvidia A100 80GB GPU"),
    "nvidia-h100-80gb": ("Nvidia H100 80GB GPU",),
    "nvidia-h100-mega-80gb": ("Nvidia H100 80GB Mega GPU", "Nvidia H100 Mega 80GB GPU"),
    "nvidia-h200-141gb": ("H200 141GB GPU", "Nvidia H200 141GB GPU"),
    "nvidia-b200": ("A4 Nvidia B200 (1 gpu slice)", "Nvidia B200 GPU"),
    "nvidia-gb200": ("Nvidia GB200 GPU",),
    "nvidia-rtx-pro-6000": ("Nvidia RTX PRO 6000 GPU", "Nvidia RTX Pro 6000 GPU"),
}
GPU_VRAM_GB: Final = {
    "nvidia-l4": 24,
    "nvidia-l4-vws": 24,
    "nvidia-tesla-t4": 16,
    "nvidia-tesla-t4-vws": 16,
    "nvidia-tesla-p4": 8,
    "nvidia-tesla-p4-vws": 8,
    "nvidia-tesla-p100": 16,
    "nvidia-tesla-p100-vws": 16,
    "nvidia-tesla-v100": 16,
    "nvidia-tesla-a100": 40,
    "nvidia-a100-80gb": 80,
    "nvidia-h100-80gb": 80,
    "nvidia-h100-mega-80gb": 80,
    "nvidia-h200-141gb": 141,
    "nvidia-b200": 180,
    "nvidia-gb200": 186,
    "nvidia-rtx-pro-6000": 96,
}
SUNSHINE_GPU_COMPATIBILITY: Final = {
    "nvidia-tesla-t4-vws": {
        "state": "compatible",
        "label": "Latest: tested works",
        "detail": "Validated with the current Steam Headless latest image: Sunshine, Xorg, noVNC, and NVIDIA NVENC started successfully on T4 vWS.",
    },
    "nvidia-l4-vws": {
        "state": "untested",
        "label": "Latest image requires validation",
        "detail": "The prior vWS result must be revalidated with the current Steam Headless latest image.",
    },
    "nvidia-tesla-p100": {
        "state": "untested",
        "label": "Latest image requires validation",
        "detail": "The raw P100 profile must be revalidated after switching the default Steam Headless image to latest.",
    },
    "nvidia-tesla-p4": {
        "state": "incompatible",
        "label": "Tested: fails",
        "detail": "Tested in us-east4-a on 2026-08-11: Tesla P4 with driver 580.173.02 and Sunshine 2026.516.143833 exposes only the NULL Xorg MetaMode, so Sunshine cannot initialize X11 capture or NVENC.",
    },
}
INCOMPATIBLE_SUNSHINE_ACCELERATORS: Final = frozenset(
    gpu_type
    for gpu_type, compatibility in SUNSHINE_GPU_COMPATIBILITY.items()
    if compatibility["state"] == "incompatible"
)
GPU_CREATION_PROFILE_SPECS: Final = {
    "nvidia-tesla-t4": {
        "id": "nvidia-tesla-t4",
        "label": "GPU T4",
        "machineType": DEFAULT_T4_MACHINE_TYPE,
        "acceleratorMode": "attached",
    },
    "nvidia-tesla-t4-vws": {
        "id": "nvidia-tesla-t4-vws",
        "label": "GPU T4 vWS",
        "machineType": DEFAULT_T4_MACHINE_TYPE,
        "acceleratorMode": "attached",
    },
    "nvidia-l4": {
        "id": "nvidia-l4",
        "label": "GPU L4",
        "machineType": DEFAULT_L4_MACHINE_TYPE,
        "acceleratorMode": "builtin",
    },
    "nvidia-l4-vws": {
        "id": "nvidia-l4-vws",
        "label": "GPU L4 vWS",
        "machineType": DEFAULT_L4_MACHINE_TYPE,
        "acceleratorMode": "attached",
    },
    "nvidia-tesla-p4": {
        "id": "nvidia-tesla-p4",
        "label": "GPU P4",
        "machineType": DEFAULT_T4_MACHINE_TYPE,
        "acceleratorMode": "attached",
    },
    "nvidia-tesla-p100": {
        "id": "nvidia-tesla-p100",
        "label": "GPU P100",
        "machineType": DEFAULT_T4_MACHINE_TYPE,
        "acceleratorMode": "attached",
    },
    "nvidia-tesla-v100": {
        "id": "nvidia-tesla-v100",
        "label": "GPU V100",
        "machineType": DEFAULT_T4_MACHINE_TYPE,
        "acceleratorMode": "attached",
    },
    "nvidia-tesla-a100": {
        "id": "nvidia-tesla-a100",
        "label": "GPU A100",
        "machineType": DEFAULT_T4_MACHINE_TYPE,
        "acceleratorMode": "attached",
    },
    "nvidia-a100-80gb": {
        "id": "nvidia-a100-80gb",
        "label": "GPU A100 80 GB",
        "machineType": DEFAULT_T4_MACHINE_TYPE,
        "acceleratorMode": "attached",
    },
    "nvidia-h100-80gb": {
        "id": "nvidia-h100-80gb",
        "label": "GPU H100 80 GB",
        "machineType": DEFAULT_T4_MACHINE_TYPE,
        "acceleratorMode": "attached",
    },
    "nvidia-h100-mega-80gb": {
        "id": "nvidia-h100-mega-80gb",
        "label": "GPU H100 Mega 80 GB",
        "machineType": DEFAULT_T4_MACHINE_TYPE,
        "acceleratorMode": "attached",
    },
    "nvidia-h200-141gb": {
        "id": "nvidia-h200-141gb",
        "label": "GPU H200 141 GB",
        "machineType": DEFAULT_T4_MACHINE_TYPE,
        "acceleratorMode": "attached",
    },
    "nvidia-b200": {
        "id": "nvidia-b200",
        "label": "GPU B200",
        "machineType": DEFAULT_T4_MACHINE_TYPE,
        "acceleratorMode": "attached",
    },
    "nvidia-gb200": {
        "id": "nvidia-gb200",
        "label": "GPU GB200",
        "machineType": DEFAULT_T4_MACHINE_TYPE,
        "acceleratorMode": "attached",
    },
}


PERSISTENT_DISK_PRICE_TYPES: Final = {
    "pd-ssd": "SSD backed PD Capacity",
    "pd-balanced": "Balanced PD Capacity",
}
PRICE_INDEX_CACHE: dict[str, Any] = {
    "loaded_at": 0.0,
    "currency": "",
    "index": {},
    "effective_time": "",
    "conversion_rate": None,
}
PRICE_INDEX_LOCK = threading.Lock()
FIREWALL_WEB_ALLOWED: Final = [{"IPProtocol": "tcp", "ports": ["22"]}]
IAP_TCP_FORWARDING_SOURCE_RANGES: Final = ["35.235.240.0/20"]
FIREWALL_NOVNC_IAP_ALLOWED: Final = [{"IPProtocol": "tcp", "ports": ["8083"]}]
FIREWALL_SUNSHINE_ALLOWED: Final = [
    {"IPProtocol": "tcp", "ports": ["47984", "47989", "47990", "48010", "27036-27037"]},
    {"IPProtocol": "udp", "ports": ["47998", "47999", "48000", "48002", "48010", "27031-27036"]},
]
MINECRAFT_GAME_PORT_MIN = 25565
MINECRAFT_GAME_PORT_MAX = 25575


def minecraft_firewall_allowed(ports: list[int]) -> list[dict[str, Any]]:
    return [{"IPProtocol": "tcp", "ports": [str(port) for port in sorted(set(ports))]}]


FIREWALL_MINECRAFT_ALLOWED: Final = minecraft_firewall_allowed([int(CONFIG["minecraft_port"])])
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
SECRET_MANAGER_BASE_URL = "https://secretmanager.googleapis.com/v1"
PAPERMC_PROJECT_URL = "https://fill.papermc.io/v3/projects/paper"
PAPERMC_USER_AGENT = "docker-steam-headless-vm-control/1.0"
PURPURMC_PROJECT_URL = "https://api.purpurmc.org/v2/purpur"
FABRIC_GAME_VERSIONS_URL = "https://meta.fabricmc.net/v2/versions/game"
FORGE_MAVEN_METADATA_URL = "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml"
NEOFORGE_MAVEN_METADATA_URL = "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml"
MINECRAFT_VERSION_CACHE: dict[str, Any] = {
    "catalogs": {},
    "loaded": False,
}
DEFAULT_STEAM_HEADLESS_IMAGE: Final = "josh5/steam-headless:latest"
DEFAULT_MINECRAFT_IMAGE: Final = "itzg/minecraft-server:latest"
DOCKER_HUB_TAGS_URL: Final = "https://hub.docker.com/v2/repositories/{repository}/tags"
RUNTIME_IMAGE_COMPONENTS: Final = {
    "steam-headless": {
        "label": "Steam Headless + Sunshine",
        "repository": "josh5/steam-headless",
        "requiresGpu": True,
        "fallbackTags": ["latest", "debian", "debian-dev-frontend-revamp"],
    },
    "minecraft": {
        "label": "Minecraft container",
        "repository": "itzg/minecraft-server",
        "requiresGpu": False,
        "fallbackTags": ["stable", "latest"],
    },
}
RUNTIME_IMAGE_CATALOG_CACHE: dict[str, Any] = {
    "components": {},
    "source": "static",
    "updatedAt": "",
    "lastError": "",
    "loaded": False,
}


def normalize_minecraft_version(raw_version: Any) -> str:
    version = str(raw_version or "").strip()
    if not version:
        raise ApiError("Minecraft server version is required.", 400)
    if version.upper() == "LATEST":
        return "LATEST"
    parts = version.split(".")
    if len(parts) not in {2, 3} or not all(part.isdigit() for part in parts):
        raise ApiError("Minecraft server version must be LATEST or a numeric version like 1.21.4.", 400)
    return version


def minecraft_server_type_options() -> list[dict[str, Any]]:
    return [
        {
            "id": str(spec["id"]),
            "label": str(spec["label"]),
            "contentKind": str(spec["contentKind"]),
            "contentLabel": str(spec["contentLabel"]),
        }
        for spec in MINECRAFT_SERVER_TYPES.values()
    ]


def normalize_minecraft_server_type(raw_server_type: Any) -> str:
    server_type = str(raw_server_type or "").strip().lower() or DEFAULT_MINECRAFT_SERVER_TYPE
    if server_type not in MINECRAFT_SERVER_TYPES:
        raise ApiError("Minecraft server type must be Paper, Purpur, Fabric, Forge, or NeoForge.", 400)
    return server_type


def minecraft_server_type_spec(server_type: Any) -> dict[str, Any]:
    return dict(MINECRAFT_SERVER_TYPES[normalize_minecraft_server_type(server_type)])


def parse_minecraft_server_type(payload: Any) -> str:
    raw_server_type = payload.get("minecraftServerType") if hasattr(payload, "get") else ""
    return normalize_minecraft_server_type(raw_server_type)


def configured_minecraft_version_options() -> list[str]:
    versions: list[str] = []
    for raw_version in CONFIG["minecraft_versions"]:
        try:
            version = normalize_minecraft_version(raw_version)
        except ApiError:
            logging.warning("Ignoring invalid configured Minecraft server version: %s", raw_version)
            continue
        if version not in versions:
            versions.append(version)
    if "LATEST" not in versions:
        versions.insert(0, "LATEST")
    return versions


def minecraft_version_catalog(server_type: Any = DEFAULT_MINECRAFT_SERVER_TYPE) -> dict[str, Any]:
    load_persisted_minecraft_versions()
    normalized_server_type = normalize_minecraft_server_type(server_type)
    catalogs = MINECRAFT_VERSION_CACHE.get("catalogs")
    catalog = catalogs.get(normalized_server_type) if isinstance(catalogs, dict) else None
    versions = normalize_minecraft_version_list(catalog.get("versions")) if isinstance(catalog, dict) else []
    if versions:
        return {
            "versions": versions,
            "defaultVersion": versions[0],
            "source": str(catalog.get("source") or "cache"),
            "updatedAt": str(catalog.get("updatedAt") or ""),
            "lastError": str(catalog.get("lastError") or ""),
        }
    if normalized_server_type == DEFAULT_MINECRAFT_SERVER_TYPE:
        versions = configured_minecraft_version_options()
        return {
            "versions": versions,
            "defaultVersion": versions[0],
            "source": "static",
            "updatedAt": "",
            "lastError": str(catalog.get("lastError") or "") if isinstance(catalog, dict) else "",
        }
    return {
        "versions": [],
        "defaultVersion": "",
        "source": "unavailable",
        "updatedAt": "",
        "lastError": str(catalog.get("lastError") or "Refresh Minecraft Versions to load this runtime catalog.") if isinstance(catalog, dict) else "Refresh Minecraft Versions to load this runtime catalog.",
    }


def minecraft_version_options(server_type: Any = DEFAULT_MINECRAFT_SERVER_TYPE) -> list[str]:
    return list(minecraft_version_catalog(server_type).get("versions") or [])


def default_minecraft_version(server_type: Any = DEFAULT_MINECRAFT_SERVER_TYPE) -> str:
    catalog = minecraft_version_catalog(server_type)
    return str(catalog.get("defaultVersion") or "")


def latest_concrete_minecraft_version(server_type: Any = DEFAULT_MINECRAFT_SERVER_TYPE) -> str:
    for version in minecraft_version_options(server_type):
        candidate = str(version or "").strip()
        if candidate and candidate.upper() != "LATEST":
            return candidate
    raise ApiError("No concrete Minecraft server version is available.", 503)


def concrete_minecraft_version(version: str, server_type: Any = DEFAULT_MINECRAFT_SERVER_TYPE) -> str:
    normalized = normalize_minecraft_version(version)
    return latest_concrete_minecraft_version(server_type) if normalized.upper() == "LATEST" else normalized


def minecraft_version_payload(
    *,
    selected_server_type: Any = DEFAULT_MINECRAFT_SERVER_TYPE,
    refreshed: bool = False,
    error: str = "",
) -> dict[str, Any]:
    normalized_server_type = normalize_minecraft_server_type(selected_server_type)
    catalogs = {
        server_type: minecraft_version_catalog(server_type)
        for server_type in MINECRAFT_SERVER_TYPES
    }
    selected_catalog = catalogs[normalized_server_type]
    return {
        "versions": selected_catalog["versions"],
        "availableVersions": selected_catalog["versions"],
        "defaultVersion": selected_catalog["defaultVersion"],
        "serverType": normalized_server_type,
        "serverTypes": minecraft_server_type_options(),
        "defaultServerType": DEFAULT_MINECRAFT_SERVER_TYPE,
        "versionCatalogs": catalogs,
        "source": selected_catalog["source"],
        "updatedAt": selected_catalog["updatedAt"],
        "refreshed": refreshed,
        "error": error,
    }


def minecraft_version_sort_key(version: str) -> tuple[int, list[int], str]:
    if version.upper() == "LATEST":
        return (2, [9999], version)
    core = version.split("-", 1)[0]
    parts: list[int] = []
    for part in core.split("."):
        try:
            parts.append(int(part))
        except ValueError:
            parts.append(-1)
    return (1 if "-" not in version else 0, parts, version)


def stable_paper_versions(session: requests.Session, headers: dict[str, str]) -> list[str]:
    response = session.get(PAPERMC_PROJECT_URL, headers=headers, timeout=20)
    if response.status_code >= 400:
        raise ApiError(f"PaperMC version API returned {response.status_code}.", 502)
    data = response.json()
    grouped_versions = data.get("versions", {})
    if not isinstance(grouped_versions, dict):
        raise ApiError("PaperMC version API returned an unexpected payload.", 502)
    raw_versions = sorted(
        {
            str(version)
            for values in grouped_versions.values()
            if isinstance(values, list)
            for version in values
            if version
        },
        key=minecraft_version_sort_key,
        reverse=True,
    )
    stable_versions: list[str] = []
    for version in raw_versions:
        builds_response = session.get(f"{PAPERMC_PROJECT_URL}/versions/{version}/builds", headers=headers, timeout=15)
        if builds_response.status_code >= 400:
            continue
        builds = builds_response.json()
        if any(
            isinstance(build, dict)
            and str(build.get("channel", "")).upper() == "STABLE"
            and "server:default" in (build.get("downloads") or {})
            for build in (builds if isinstance(builds, list) else [])
        ):
            stable_versions.append(version)
    if not stable_versions:
        raise ApiError("PaperMC did not return any stable server versions.", 502)
    return stable_versions


def stable_purpur_versions(session: requests.Session, headers: dict[str, str]) -> list[str]:
    response = session.get(PURPURMC_PROJECT_URL, headers=headers, timeout=20)
    if response.status_code >= 400:
        raise ApiError(f"Purpur version API returned {response.status_code}.", 502)
    data = response.json()
    versions = data.get("versions") if isinstance(data, dict) else None
    return normalize_minecraft_version_list(versions)


def stable_fabric_versions(session: requests.Session, headers: dict[str, str]) -> list[str]:
    response = session.get(FABRIC_GAME_VERSIONS_URL, headers=headers, timeout=20)
    if response.status_code >= 400:
        raise ApiError(f"Fabric version API returned {response.status_code}.", 502)
    data = response.json()
    versions = [item.get("version") for item in data if isinstance(item, dict) and item.get("stable")]
    return normalize_minecraft_version_list(versions)


def maven_metadata_versions(session: requests.Session, headers: dict[str, str], url: str, source_name: str) -> list[str]:
    response = session.get(url, headers=headers, timeout=20)
    if response.status_code >= 400:
        raise ApiError(f"{source_name} version metadata returned {response.status_code}.", 502)
    try:
        root = ET.fromstring(response.text)
    except ET.ParseError as error:
        raise ApiError(f"{source_name} version metadata was invalid XML.", 502) from error
    return [str(node.text or "").strip() for node in root.findall(".//version") if str(node.text or "").strip()]


def stable_forge_versions(session: requests.Session, headers: dict[str, str]) -> list[str]:
    artifact_versions = maven_metadata_versions(session, headers, FORGE_MAVEN_METADATA_URL, "Forge")
    return normalize_minecraft_version_list([
        artifact.split("-", 1)[0]
        for artifact in artifact_versions
        if "-" in artifact and not re.search(r"(?:alpha|beta|rc|snapshot|pre)", artifact, re.IGNORECASE)
    ])


def minecraft_version_from_neoforge_artifact(artifact: str) -> str:
    core = artifact.split("-", 1)[0]
    parts = core.split(".")
    if len(parts) < 3 or not all(part.isdigit() for part in parts):
        return ""
    minecraft_parts = parts[:-1]
    if core.startswith("1."):
        candidate = ".".join(minecraft_parts)
    elif int(parts[0]) <= 25:
        candidate = "1." + ".".join(minecraft_parts)
    else:
        candidate = ".".join(minecraft_parts)
    return candidate[:-2] if candidate.endswith(".0") else candidate


def stable_neoforge_versions(session: requests.Session, headers: dict[str, str]) -> list[str]:
    artifact_versions = maven_metadata_versions(session, headers, NEOFORGE_MAVEN_METADATA_URL, "NeoForge")
    return normalize_minecraft_version_list([
        minecraft_version_from_neoforge_artifact(artifact)
        for artifact in artifact_versions
        if not re.search(r"(?:alpha|beta|rc|snapshot|pre)", artifact, re.IGNORECASE)
    ])


def refresh_minecraft_version_catalogs() -> dict[str, Any]:
    load_persisted_minecraft_versions()
    previous_catalogs = dict(MINECRAFT_VERSION_CACHE.get("catalogs") or {})
    session = requests.Session()
    headers = {"User-Agent": PAPERMC_USER_AGENT, "Accept": "application/json"}
    fetchers = {
        "paper": ("papermc", stable_paper_versions),
        "purpur": ("purpurmc", stable_purpur_versions),
        "fabric": ("fabricmc", stable_fabric_versions),
        "forge": ("minecraftforge", stable_forge_versions),
        "neoforge": ("neoforged", stable_neoforge_versions),
    }
    updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    catalogs: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    for server_type, (source, fetcher) in fetchers.items():
        try:
            versions = normalize_minecraft_version_list(fetcher(session, headers))
            if len(versions) <= 1:
                raise ApiError(f"{minecraft_server_type_spec(server_type)['label']} did not return any stable Minecraft versions.", 502)
            catalogs[server_type] = {
                "versions": versions,
                "source": source,
                "updatedAt": updated_at,
                "lastError": "",
            }
        except Exception as error:
            message = error.message if isinstance(error, ApiError) else str(error)
            previous = previous_catalogs.get(server_type)
            previous_versions = normalize_minecraft_version_list(previous.get("versions")) if isinstance(previous, dict) else []
            catalogs[server_type] = {
                "versions": previous_versions,
                "source": str(previous.get("source") or "unavailable") if isinstance(previous, dict) else "unavailable",
                "updatedAt": str(previous.get("updatedAt") or "") if isinstance(previous, dict) else "",
                "lastError": message,
            }
            errors.append(f"{minecraft_server_type_spec(server_type)['label']}: {message}")
    try:
        save_persisted_minecraft_versions(catalogs)
        MINECRAFT_VERSION_CACHE.update({"catalogs": catalogs, "loaded": True})
    except Exception as error:
        message = error.message if isinstance(error, ApiError) else str(error)
        MINECRAFT_VERSION_CACHE.update({"catalogs": previous_catalogs, "loaded": True})
        errors.append(f"cache: {message}")
    return minecraft_version_payload(refreshed=not errors, error="; ".join(errors))


def parse_minecraft_version(payload: Any, server_type: Any = DEFAULT_MINECRAFT_SERVER_TYPE) -> str:
    normalized_server_type = normalize_minecraft_server_type(server_type)
    raw_version = payload.get("minecraftVersion") if hasattr(payload, "get") else ""
    catalog = minecraft_version_catalog(normalized_server_type)
    version = normalize_minecraft_version(raw_version or catalog.get("defaultVersion"))
    available_versions = set(catalog.get("versions") or [])
    if not available_versions:
        raise ApiError(f"Minecraft version catalog for {minecraft_server_type_spec(normalized_server_type)['label']} is not ready. Refresh Minecraft Versions first.", 409)
    if version not in available_versions:
        raise ApiError(f"Minecraft server version {version} is not available for {minecraft_server_type_spec(normalized_server_type)['label']}.", 400)
    return version


def require_env(name: str) -> str:
    value = CONFIG.get(name) if name in CONFIG else os.environ.get(name, "")
    if not value:
        raise ApiError(f"Service is missing required configuration: {name}", 500)
    return value


@lru_cache(maxsize=1)
def compute_session() -> AuthorizedSession:
    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    return AuthorizedSession(credentials)


def normalize_email(raw_email: str) -> str:
    return str(raw_email or "").strip().lower()


def validate_email(raw_email: str) -> str:
    email = normalize_email(raw_email)
    if not email or "@" not in email or " " in email or email.startswith("@") or email.endswith("@"):
        raise ApiError("Provide a valid email address.", 400)
    return email


def configured_admin_google_emails() -> set[str]:
    return {normalize_email(email) for email in CONFIG["admin_google_emails"] if normalize_email(email)}


def admin_google_emails() -> set[str]:
    managed_admins = {
        email
        for email, profile in read_access_user_profiles().items()
        if bool(profile.get("administrator", False))
    }
    return configured_admin_google_emails() | managed_admins


def secret_path(secret_name: str) -> str:
    project = require_env("project")
    return f"projects/{project}/secrets/{secret_name}"


def read_access_user_profiles() -> dict[str, dict[str, bool]]:
    secret_name = str(CONFIG["access_users_secret_name"] or "").strip()
    if not secret_name:
        return {}
    response = compute_session().get(
        f"{SECRET_MANAGER_BASE_URL}/{secret_path(secret_name)}/versions/latest:access",
        timeout=30,
    )
    if response.status_code == 404:
        return {}
    if response.status_code >= 400:
        logging.warning("Unable to read managed access users secret: %s", response.text)
        return {}
    data = response.json()
    encoded = (((data or {}).get("payload") or {}).get("data") or "")
    if not encoded:
        return {}
    try:
        decoded = base64.b64decode(encoded).decode("utf-8")
        payload = json.loads(decoded)
    except Exception as error:
        logging.warning("Unable to decode managed access users secret: %s", error)
        return {}
    raw_users = payload.get("users", []) if isinstance(payload, dict) else payload
    if not isinstance(raw_users, list):
        return {}

    profiles: dict[str, dict[str, bool]] = {}
    for raw_user in raw_users:
        if isinstance(raw_user, str):
            email = normalize_email(raw_user)
            minecraft_management = False
            administrator = False
        elif isinstance(raw_user, dict):
            email = normalize_email(str(raw_user.get("email", "")))
            minecraft_management = bool(raw_user.get("minecraftManagement", False))
            administrator = bool(raw_user.get("administrator", False))
        else:
            continue
        if email:
            profiles[email] = {
                "minecraftManagement": minecraft_management,
                "administrator": administrator,
            }
    return profiles


def read_access_users_secret() -> set[str]:
    return set(read_access_user_profiles())


def write_access_user_profiles(profiles: dict[str, dict[str, bool]]) -> None:
    secret_name = str(CONFIG["access_users_secret_name"] or "").strip()
    if not secret_name:
        raise ApiError("Managed access users secret is not configured.", 500)
    users = [
        {
            "email": email,
            "minecraftManagement": bool(profile.get("minecraftManagement", False)),
            "administrator": bool(profile.get("administrator", False)),
        }
        for email, profile in sorted(profiles.items())
    ]
    payload = json.dumps({"users": users}, separators=(",", ":")).encode("utf-8")
    response = compute_session().post(
        f"{SECRET_MANAGER_BASE_URL}/{secret_path(secret_name)}:addVersion",
        json={"payload": {"data": base64.b64encode(payload).decode("ascii")}},
        timeout=30,
    )
    if response.status_code >= 400:
        raise ApiError(f"Unable to update managed access users: {response.text}", 502)


def write_access_users_secret(users: set[str]) -> None:
    write_access_user_profiles(
        {email: {"minecraftManagement": False} for email in users if normalize_email(email)}
    )


def normalize_minecraft_version_list(raw_versions: Any) -> list[str]:
    if not isinstance(raw_versions, list):
        return []
    versions: list[str] = []
    for raw_version in raw_versions:
        try:
            version = normalize_minecraft_version(raw_version)
        except ApiError:
            continue
        if version not in versions:
            versions.append(version)
    if not versions:
        return []
    return ["LATEST", *[version for version in versions if version != "LATEST"]]


def load_persisted_minecraft_versions() -> None:
    if MINECRAFT_VERSION_CACHE.get("loaded"):
        return
    MINECRAFT_VERSION_CACHE["loaded"] = True

    secret_name = str(CONFIG["minecraft_versions_secret_name"] or "").strip()
    if not secret_name:
        return
    try:
        response = compute_session().get(
            f"{SECRET_MANAGER_BASE_URL}/{secret_path(secret_name)}/versions/latest:access",
            timeout=30,
        )
        if response.status_code == 404:
            return
        if response.status_code >= 400:
            raise ApiError(f"Unable to read Minecraft versions cache: {response.text}", 502)
        data = response.json()
        encoded = (((data or {}).get("payload") or {}).get("data") or "")
        payload = json.loads(base64.b64decode(encoded).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("cache payload is not an object")
        raw_catalogs = payload.get("catalogs")
        catalogs: dict[str, dict[str, Any]] = {}
        if isinstance(raw_catalogs, dict):
            for server_type in MINECRAFT_SERVER_TYPES:
                raw_catalog = raw_catalogs.get(server_type)
                versions = normalize_minecraft_version_list(raw_catalog.get("versions")) if isinstance(raw_catalog, dict) else []
                if versions:
                    catalogs[server_type] = {
                        "versions": versions,
                        "source": str(raw_catalog.get("source") or "cache"),
                        "updatedAt": str(raw_catalog.get("updatedAt") or ""),
                        "lastError": str(raw_catalog.get("lastError") or ""),
                    }
        if not catalogs:
            versions = normalize_minecraft_version_list(payload.get("versions"))
            if not versions:
                raise ValueError("cache does not contain valid version catalogs")
            catalogs[DEFAULT_MINECRAFT_SERVER_TYPE] = {
                "versions": versions,
                "source": str(payload.get("source") or "cache"),
                "updatedAt": str(payload.get("updatedAt") or ""),
                "lastError": "",
            }
        MINECRAFT_VERSION_CACHE["catalogs"] = catalogs
    except Exception as error:
        logging.warning("Unable to load persisted Minecraft versions cache: %s", error)
        MINECRAFT_VERSION_CACHE["lastError"] = str(error)


def save_persisted_minecraft_versions(catalogs: dict[str, dict[str, Any]]) -> None:
    secret_name = str(CONFIG["minecraft_versions_secret_name"] or "").strip()
    if not secret_name:
        raise ApiError("Minecraft versions cache secret is not configured.", 500)
    payload = json.dumps(
        {"catalogs": catalogs},
        separators=(",", ":"),
    ).encode("utf-8")
    response = compute_session().post(
        f"{SECRET_MANAGER_BASE_URL}/{secret_path(secret_name)}:addVersion",
        json={"payload": {"data": base64.b64encode(payload).decode("ascii")}},
        timeout=30,
    )
    if response.status_code >= 400:
        raise ApiError(f"Unable to save Minecraft versions cache: {response.text}", 502)


def runtime_image_component(raw_component: Any) -> str:
    component = str(raw_component or "").strip().lower()
    if component not in RUNTIME_IMAGE_COMPONENTS:
        raise ApiError("Unsupported runtime image component.", 400)
    return component


def runtime_image_state_metadata_key(component: str, field: str) -> str:
    return f"vm-runtime-image-{component}-{field}"


def runtime_image_tag_allowed(component: str, raw_tag: Any) -> bool:
    tag = str(raw_tag or "").strip()
    if component == "steam-headless":
        return tag in set(RUNTIME_IMAGE_COMPONENTS[component]["fallbackTags"])
    return bool(
        tag in {"latest", "stable", "java17", "java21", "java25"}
        or re.fullmatch(r"\d{4}\.\d{1,2}\.\d{1,2}-java(?:17|21|25)", tag)
    )


def runtime_image_digest_ref(repository: str, raw_digest: Any) -> str:
    digest = str(raw_digest or "").strip().lower()
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        return ""
    return f"{repository}@{digest}"


def runtime_image_catalog_template() -> dict[str, Any]:
    return {
        "components": {
            component: {
                "label": str(definition["label"]),
                "repository": str(definition["repository"]),
                "requiresGpu": bool(definition["requiresGpu"]),
                "candidates": [
                    {"tag": tag, "imageRef": "", "updatedAt": ""}
                    for tag in definition["fallbackTags"]
                ],
            }
            for component, definition in RUNTIME_IMAGE_COMPONENTS.items()
        },
        "source": "static",
        "updatedAt": "",
        "lastError": "",
    }


def normalize_runtime_image_catalog(raw_value: Any) -> dict[str, Any]:
    result = runtime_image_catalog_template()
    if not isinstance(raw_value, dict):
        return result
    raw_components = raw_value.get("components")
    if not isinstance(raw_components, dict):
        return result
    for component, definition in RUNTIME_IMAGE_COMPONENTS.items():
        raw_component = raw_components.get(component)
        raw_candidates = raw_component.get("candidates") if isinstance(raw_component, dict) else []
        candidates: list[dict[str, str]] = []
        if isinstance(raw_candidates, list):
            for raw_candidate in raw_candidates:
                if not isinstance(raw_candidate, dict):
                    continue
                tag = str(raw_candidate.get("tag") or "").strip()
                image_ref = str(raw_candidate.get("imageRef") or "").strip()
                repository = str(definition["repository"])
                if not runtime_image_tag_allowed(component, tag):
                    continue
                if not image_ref.startswith(f"{repository}@sha256:"):
                    continue
                if not runtime_image_digest_ref(repository, image_ref.removeprefix(f"{repository}@")):
                    continue
                if any(existing["imageRef"] == image_ref for existing in candidates):
                    continue
                candidates.append(
                    {
                        "tag": tag,
                        "imageRef": image_ref,
                        "updatedAt": str(raw_candidate.get("updatedAt") or ""),
                    }
                )
        if candidates:
            result["components"][component]["candidates"] = candidates
    result["source"] = str(raw_value.get("source") or "cache")
    result["updatedAt"] = str(raw_value.get("updatedAt") or "")
    result["lastError"] = str(raw_value.get("lastError") or "")
    return result


def load_persisted_runtime_image_catalog() -> None:
    if RUNTIME_IMAGE_CATALOG_CACHE.get("loaded"):
        return
    RUNTIME_IMAGE_CATALOG_CACHE["loaded"] = True
    secret_name = str(CONFIG["runtime_images_secret_name"] or "").strip()
    if not secret_name:
        return
    try:
        response = compute_session().get(
            f"{SECRET_MANAGER_BASE_URL}/{secret_path(secret_name)}/versions/latest:access",
            timeout=30,
        )
        if response.status_code == 404:
            return
        if response.status_code >= 400:
            raise ApiError(f"Unable to read runtime image catalog: {response.text}", 502)
        encoded = str(((response.json() or {}).get("payload") or {}).get("data") or "")
        payload = json.loads(base64.b64decode(encoded).decode("utf-8"))
        catalog = normalize_runtime_image_catalog(payload)
        RUNTIME_IMAGE_CATALOG_CACHE.update(catalog)
    except Exception as error:
        logging.warning("Unable to load persisted runtime image catalog: %s", error)
        RUNTIME_IMAGE_CATALOG_CACHE["lastError"] = str(error)


def save_persisted_runtime_image_catalog(catalog: dict[str, Any]) -> None:
    secret_name = str(CONFIG["runtime_images_secret_name"] or "").strip()
    if not secret_name:
        raise ApiError("Runtime image catalog secret is not configured.", 500)
    payload = json.dumps(catalog, separators=(",", ":"), sort_keys=True).encode("utf-8")
    response = compute_session().post(
        f"{SECRET_MANAGER_BASE_URL}/{secret_path(secret_name)}:addVersion",
        json={"payload": {"data": base64.b64encode(payload).decode("ascii")}},
        timeout=30,
    )
    if response.status_code >= 400:
        raise ApiError(f"Unable to save runtime image catalog: {response.text}", 502)


COMPATIBILITY_CATALOG_CACHE: dict[str, Any] = {
    "loaded": False,
    "schemaVersion": 1,
    "records": [],
    "updatedAt": "",
    "lastError": "",
}
COMPATIBILITY_RESULTS: Final = frozenset({"works", "fails", "unknown", "testing"})


def compatibility_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def compatibility_catalog_template() -> dict[str, Any]:
    return {"schemaVersion": 1, "records": [], "updatedAt": "", "lastError": ""}


def compatibility_text(raw_value: Any, field: str, limit: int, *, required: bool = False) -> str:
    value = str(raw_value or "").strip()
    if "\n" in value or "\r" in value or len(value) > limit:
        raise ApiError(f"Invalid compatibility field: {field}.", 400)
    if required and not value:
        raise ApiError(f"Compatibility field is required: {field}.", 400)
    return value


def compatibility_hardware_options() -> list[dict[str, str]]:
    return [
        {
            "id": str(spec["id"]),
            "label": str(spec["label"]),
            "gpuType": gpu_type,
            "acceleratorMode": str(spec["acceleratorMode"]),
        }
        for gpu_type, spec in GPU_CREATION_PROFILE_SPECS.items()
    ]


def compatibility_hardware_option(hardware_id: str) -> dict[str, str]:
    return next((option for option in compatibility_hardware_options() if option["id"] == hardware_id), {})


def normalize_compatibility_record(raw_value: Any, *, recorded_by: str = "") -> dict[str, str] | None:
    if not isinstance(raw_value, dict):
        return None
    hardware_id = compatibility_text(raw_value.get("hardwareId"), "hardwareId", 80, required=True)
    hardware = compatibility_hardware_option(hardware_id)
    if not hardware:
        raise ApiError("Unsupported hardware profile for compatibility record.", 400)
    result = compatibility_text(raw_value.get("result"), "result", 20, required=True).lower()
    if result not in COMPATIBILITY_RESULTS:
        raise ApiError("Unsupported compatibility result.", 400)
    image_ref = compatibility_text(raw_value.get("imageRef"), "imageRef", 256, required=True)
    if not image_ref.startswith("josh5/steam-headless:") and not image_ref.startswith("josh5/steam-headless@sha256:"):
        raise ApiError("Compatibility records currently support Steam Headless images only.", 400)
    image_tag = compatibility_text(raw_value.get("imageTag"), "imageTag", 80, required=True).lower()
    record_id = compatibility_text(raw_value.get("recordId"), "recordId", 80)
    if record_id and not re.fullmatch(r"[a-z0-9-]+", record_id):
        raise ApiError("Invalid compatibility record ID.", 400)
    return {
        "recordId": record_id,
        "hardwareId": hardware_id,
        "hardwareLabel": hardware["label"],
        "gpuType": hardware["gpuType"],
        "acceleratorMode": hardware["acceleratorMode"],
        "imageRef": image_ref,
        "imageTag": image_tag,
        "sunshineVersion": compatibility_text(raw_value.get("sunshineVersion"), "sunshineVersion", 120, required=True),
        "driverVersion": compatibility_text(raw_value.get("driverVersion"), "driverVersion", 120, required=True),
        "result": result,
        "evidence": compatibility_text(raw_value.get("evidence"), "evidence", 1200),
        "recordedAt": compatibility_text(raw_value.get("recordedAt"), "recordedAt", 40) or compatibility_timestamp(),
        "recordedBy": compatibility_text(recorded_by or raw_value.get("recordedBy"), "recordedBy", 320),
    }


def normalize_compatibility_catalog(raw_value: Any) -> dict[str, Any]:
    result = compatibility_catalog_template()
    if not isinstance(raw_value, dict):
        return result
    records = raw_value.get("records")
    if isinstance(records, list):
        for raw_record in records:
            try:
                record = normalize_compatibility_record(raw_record)
            except ApiError:
                continue
            if record:
                result["records"].append(record)
    result["records"].sort(key=lambda record: str(record.get("recordedAt") or ""), reverse=True)
    result["updatedAt"] = compatibility_text(raw_value.get("updatedAt"), "updatedAt", 40)
    result["lastError"] = compatibility_text(raw_value.get("lastError"), "lastError", 500)
    return result


def load_persisted_compatibility_catalog() -> None:
    if COMPATIBILITY_CATALOG_CACHE.get("loaded"):
        return
    COMPATIBILITY_CATALOG_CACHE["loaded"] = True
    secret_name = str(CONFIG["compatibility_catalog_secret_name"] or "").strip()
    if not secret_name:
        return
    try:
        response = compute_session().get(
            f"{SECRET_MANAGER_BASE_URL}/{secret_path(secret_name)}/versions/latest:access",
            timeout=30,
        )
        if response.status_code == 404:
            return
        if response.status_code >= 400:
            raise ApiError(f"Unable to read compatibility catalog: {response.text}", 502)
        encoded = str(((response.json() or {}).get("payload") or {}).get("data") or "")
        COMPATIBILITY_CATALOG_CACHE.update(normalize_compatibility_catalog(json.loads(base64.b64decode(encoded).decode("utf-8"))))
    except Exception as error:
        logging.warning("Unable to load compatibility catalog: %s", error)
        COMPATIBILITY_CATALOG_CACHE["lastError"] = str(error)


def compatibility_catalog() -> dict[str, Any]:
    load_persisted_compatibility_catalog()
    return json.loads(json.dumps({
        "schemaVersion": COMPATIBILITY_CATALOG_CACHE.get("schemaVersion", 1),
        "records": COMPATIBILITY_CATALOG_CACHE.get("records", []),
        "updatedAt": COMPATIBILITY_CATALOG_CACHE.get("updatedAt", ""),
        "lastError": COMPATIBILITY_CATALOG_CACHE.get("lastError", ""),
    }))


def save_persisted_compatibility_catalog(catalog: dict[str, Any]) -> None:
    secret_name = str(CONFIG["compatibility_catalog_secret_name"] or "").strip()
    if not secret_name:
        raise ApiError("Compatibility catalog secret is not configured.", 500)
    normalized = normalize_compatibility_catalog(catalog)
    payload = json.dumps(normalized, separators=(",", ":"), sort_keys=True).encode("utf-8")
    response = compute_session().post(
        f"{SECRET_MANAGER_BASE_URL}/{secret_path(secret_name)}:addVersion",
        json={"payload": {"data": base64.b64encode(payload).decode("ascii")}},
        timeout=30,
    )
    if response.status_code >= 400:
        raise ApiError(f"Unable to save compatibility catalog: {response.text}", 502)
    COMPATIBILITY_CATALOG_CACHE.clear()
    COMPATIBILITY_CATALOG_CACHE.update({"loaded": True, **normalized})


def latest_sunshine_compatibility(gpu_type: str, fallback: dict[str, str]) -> dict[str, str]:
    if fallback.get("state") == "incompatible":
        return fallback
    records = [
        record for record in compatibility_catalog().get("records", [])
        if record.get("gpuType") == gpu_type and record.get("imageTag") == "latest"
    ]
    if not records:
        return fallback
    record = records[0]
    result = str(record.get("result") or "unknown")
    state = {"works": "verified", "fails": "warning", "testing": "testing", "unknown": "untested"}[result]
    label = {"works": "Latest: tested works", "fails": "Latest: tested fails", "testing": "Latest: test in progress", "unknown": "Latest: result unknown"}[result]
    evidence = str(record.get("evidence") or "No diagnostic evidence recorded.")
    return {
        "state": state,
        "label": label,
        "detail": f"Sunshine {record.get('sunshineVersion')} with driver {record.get('driverVersion')}: {evidence}",
    }


def build_admin_compatibility_payload(admin_user: dict[str, Any]) -> dict[str, Any]:
    return {
        "user": admin_user,
        "catalog": compatibility_catalog(),
        "hardwareOptions": compatibility_hardware_options(),
    }


def execute_admin_compatibility_action(admin_user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    action = str(payload.get("action") or "").strip().lower()
    catalog = compatibility_catalog()
    records = list(catalog.get("records") or [])
    if action == "record":
        record = normalize_compatibility_record(payload, recorded_by=normalize_email(str(admin_user.get("email") or "")))
        if record is None:
            raise ApiError("Invalid compatibility record.", 400)
        record["recordId"] = f"compat-{int(time.time() * 1000)}-{len(records) + 1}"
        records.append(record)
    elif action == "remove":
        record_id = compatibility_text(payload.get("recordId"), "recordId", 80, required=True)
        if not re.fullmatch(r"[a-z0-9-]+", record_id):
            raise ApiError("Invalid compatibility record ID.", 400)
        if not any(record.get("recordId") == record_id for record in records):
            raise ApiError("Compatibility record does not exist.", 404)
        records = [record for record in records if record.get("recordId") != record_id]
    else:
        raise ApiError("Unsupported compatibility action.", 400)
    catalog.update({"schemaVersion": 1, "records": records, "updatedAt": compatibility_timestamp(), "lastError": ""})
    save_persisted_compatibility_catalog(catalog)
    return build_admin_compatibility_payload(admin_user)


def fetch_runtime_image_component_catalog(component: str) -> dict[str, Any]:
    definition = RUNTIME_IMAGE_COMPONENTS[component]
    repository = str(definition["repository"])
    response = requests.get(
        DOCKER_HUB_TAGS_URL.format(repository=repository),
        params={"page_size": 100, "ordering": "last_updated"},
        headers={"Accept": "application/json", "User-Agent": "docker-steam-headless-vm-control/1.0"},
        timeout=30,
    )
    if response.status_code >= 400:
        raise ApiError(f"Docker Hub returned {response.status_code} for {repository}.", 502)
    payload = response.json()
    raw_tags = payload.get("results") if isinstance(payload, dict) else []
    if not isinstance(raw_tags, list):
        raise ApiError(f"Docker Hub returned an invalid tag list for {repository}.", 502)
    candidates: list[dict[str, str]] = []
    for raw_tag in raw_tags:
        if not isinstance(raw_tag, dict):
            continue
        tag = str(raw_tag.get("name") or "").strip()
        if not runtime_image_tag_allowed(component, tag):
            continue
        digest = ""
        images = raw_tag.get("images")
        if isinstance(images, list):
            for image in images:
                if not isinstance(image, dict):
                    continue
                if str(image.get("architecture") or "") == "amd64" and str(image.get("os") or "") == "linux":
                    digest = str(image.get("digest") or "")
                    break
        image_ref = runtime_image_digest_ref(repository, digest)
        if not image_ref:
            continue
        candidates.append(
            {
                "tag": tag,
                "imageRef": image_ref,
                "updatedAt": str(raw_tag.get("last_updated") or ""),
            }
        )
    if not candidates:
        raise ApiError(f"Docker Hub did not return a supported image version for {repository}.", 502)
    candidates.sort(key=lambda candidate: (candidate["updatedAt"], candidate["tag"]), reverse=True)
    return {
        "label": str(definition["label"]),
        "repository": repository,
        "requiresGpu": bool(definition["requiresGpu"]),
        "candidates": candidates[:24],
    }


def refresh_runtime_image_catalog() -> dict[str, Any]:
    load_persisted_runtime_image_catalog()
    previous = normalize_runtime_image_catalog(RUNTIME_IMAGE_CATALOG_CACHE)
    try:
        components = {
            component: fetch_runtime_image_component_catalog(component)
            for component in RUNTIME_IMAGE_COMPONENTS
        }
        updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        catalog = {
            "components": components,
            "source": "docker-hub",
            "updatedAt": updated_at,
            "lastError": "",
        }
        save_persisted_runtime_image_catalog(catalog)
        RUNTIME_IMAGE_CATALOG_CACHE.update(catalog)
        RUNTIME_IMAGE_CATALOG_CACHE["loaded"] = True
        return catalog
    except Exception as error:
        message = error.message if isinstance(error, ApiError) else str(error)
        RUNTIME_IMAGE_CATALOG_CACHE.update(previous)
        RUNTIME_IMAGE_CATALOG_CACHE["loaded"] = True
        RUNTIME_IMAGE_CATALOG_CACHE["lastError"] = message
        return normalize_runtime_image_catalog(RUNTIME_IMAGE_CATALOG_CACHE)


def runtime_image_catalog() -> dict[str, Any]:
    load_persisted_runtime_image_catalog()
    catalog = normalize_runtime_image_catalog(RUNTIME_IMAGE_CATALOG_CACHE)
    has_digest = any(
        candidate.get("imageRef")
        for component in catalog["components"].values()
        for candidate in component.get("candidates", [])
    )
    if not has_digest:
        catalog = refresh_runtime_image_catalog()
    return normalize_runtime_image_catalog(catalog)


def runtime_image_candidate(component: str, raw_image_ref: Any) -> dict[str, str]:
    image_ref = str(raw_image_ref or "").strip()
    if not image_ref:
        raise ApiError("A runtime image version must be selected.", 400)
    catalog = runtime_image_catalog()
    candidates = catalog["components"][component].get("candidates", [])
    for candidate in candidates:
        if candidate.get("imageRef") == image_ref:
            return dict(candidate)
    raise ApiError("Selected runtime image is not in the trusted version catalog. Refresh the catalog and try again.", 400)


def runtime_image_reference_from_instance(instance: dict[str, Any] | None, component: str) -> str:
    if instance is None:
        return ""
    current = metadata_value(instance, runtime_image_state_metadata_key(component, "current-ref")).strip()
    if current:
        return current
    if component == "steam-headless":
        return metadata_env_value(metadata_value(instance, STEAM_ENV_METADATA_KEY), "STEAM_HEADLESS_IMAGE") or DEFAULT_STEAM_HEADLESS_IMAGE
    return metadata_value(instance, MINECRAFT_IMAGE_METADATA_KEY).strip() or DEFAULT_MINECRAFT_IMAGE


def runtime_image_instance_payload(instance: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "steam-headless": {
            "currentRef": runtime_image_reference_from_instance(instance, "steam-headless"),
            "previousRef": metadata_value(instance, runtime_image_state_metadata_key("steam-headless", "previous-ref")).strip() if instance else "",
            "currentTag": metadata_value(instance, runtime_image_state_metadata_key("steam-headless", "current-tag")).strip() if instance else "",
            "previousTag": metadata_value(instance, runtime_image_state_metadata_key("steam-headless", "previous-tag")).strip() if instance else "",
        },
        "minecraft": {
            "currentRef": runtime_image_reference_from_instance(instance, "minecraft"),
            "previousRef": metadata_value(instance, runtime_image_state_metadata_key("minecraft", "previous-ref")).strip() if instance else "",
            "currentTag": metadata_value(instance, runtime_image_state_metadata_key("minecraft", "current-tag")).strip() if instance else "",
            "previousTag": metadata_value(instance, runtime_image_state_metadata_key("minecraft", "previous-tag")).strip() if instance else "",
        },
        "operation": metadata_value(instance, RUNTIME_IMAGE_OPERATION_METADATA_KEY).strip() if instance else "",
        "status": metadata_value(instance, RUNTIME_IMAGE_STATUS_METADATA_KEY).strip() if instance else "",
        "detail": metadata_value(instance, RUNTIME_IMAGE_DETAIL_METADATA_KEY).strip() if instance else "",
    }


def runtime_image_agent_ready(instance: dict[str, Any] | None) -> bool:
    return bool(instance and metadata_value(instance, RUNTIME_IMAGE_AGENT_METADATA_KEY).strip().lower() == "ready")


def build_admin_runtime_images_payload(admin_user: dict[str, Any]) -> dict[str, Any]:
    endpoints: list[dict[str, Any]] = []
    for endpoint in reconcile_endpoint_instance_bindings():
        instance = endpoint_instance_or_none(endpoint)
        endpoints.append(
            {
                **endpoint_public_payload(endpoint),
                "instanceState": str((instance or {}).get("status", "NOT_FOUND")),
                "sunshine": build_sunshine_status(instance),
                "minecraft": build_minecraft_status(instance),
                "runtimeImages": runtime_image_instance_payload(instance),
                "runtimeImageAgentReady": runtime_image_agent_ready(instance),
            }
        )
    return {"user": admin_user, "catalog": runtime_image_catalog(), "endpoints": endpoints}


def execute_admin_runtime_image_action(admin_user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    action = str(payload.get("action") or "").strip().lower()
    if action == "refresh-catalog":
        refresh_runtime_image_catalog()
        return build_admin_runtime_images_payload(admin_user)
    if action not in {"pull", "apply", "rollback"}:
        raise ApiError("Unsupported runtime image action.", 400)

    apply_target_overrides(payload)
    instance = get_instance_or_none()
    if instance is None:
        raise ApiError("Selected endpoint does not have a VM.", 400)
    if str(instance.get("status", "")).upper() != "RUNNING":
        raise ApiError("Runtime image operations require a running VM.", 400)
    if not runtime_image_agent_ready(instance):
        raise ApiError(
            "Runtime image update agent is not active on this VM. Restart the VM once to activate it, then retry.",
            409,
        )
    require_no_active_power_action(instance, "runtime image update")

    component = runtime_image_component(payload.get("component"))
    if component == "steam-headless" and is_gpu_disabled_for_instance(instance):
        raise ApiError("Steam Headless and Sunshine image updates require a GPU-enabled VM.", 409)
    if component == "minecraft" and action in {"apply", "rollback"}:
        if minecraft_state(instance) != "running":
            raise ApiError("Minecraft container updates require a running installed Minecraft server.", 409)
    if action in {"apply", "rollback"}:
        if not bool(payload.get("confirm")):
            raise ApiError("Runtime image update requires explicit confirmation.", 400)
        require_live_backup_ready(instance, "runtime image update")

    current_ref = runtime_image_reference_from_instance(instance, component)
    current_tag = metadata_value(instance, runtime_image_state_metadata_key(component, "current-tag")).strip()
    if action == "rollback":
        target_ref = metadata_value(instance, runtime_image_state_metadata_key(component, "previous-ref")).strip()
        target_tag = metadata_value(instance, runtime_image_state_metadata_key(component, "previous-tag")).strip()
        if not target_ref:
            raise ApiError("No previous immutable image digest is available for rollback.", 400)
    else:
        candidate = runtime_image_candidate(component, payload.get("imageRef"))
        target_ref = candidate["imageRef"]
        target_tag = candidate["tag"]

    if action == "apply" and target_ref == current_ref:
        raise ApiError("Selected image is already active for this component.", 400)

    action_name = "update-runtime-image"
    status_detail = (
        f"Pulling {component} image {target_tag or target_ref}."
        if action == "pull"
        else f"{('Rolling back' if action == 'rollback' else 'Updating')} {component} image to {target_tag or target_ref}."
    )
    extra_metadata: dict[str, str | None] = {
        RUNTIME_IMAGE_COMPONENT_METADATA_KEY: component,
        RUNTIME_IMAGE_OPERATION_METADATA_KEY: action,
        RUNTIME_IMAGE_TARGET_REF_METADATA_KEY: target_ref,
        RUNTIME_IMAGE_TARGET_TAG_METADATA_KEY: target_tag,
        RUNTIME_IMAGE_STATUS_METADATA_KEY: "requested",
        RUNTIME_IMAGE_DETAIL_METADATA_KEY: status_detail,
    }
    if component == "minecraft" and action in {"apply", "rollback"}:
        extra_metadata[MINECRAFT_STATUS_METADATA_KEY] = "starting"
        extra_metadata[MINECRAFT_STATUS_DETAIL_METADATA_KEY] = status_detail

    instance, token = request_live_power_action(
        instance,
        action=action_name,
        status_detail=status_detail,
        extra_metadata=extra_metadata,
        sunshine_state="starting" if component == "steam-headless" and action in {"apply", "rollback"} else None,
    )
    target_phase = {"pull": "pulled", "apply": "updated", "rollback": "rolled-back"}[action]
    wait_for_power_action_phase(
        action=action_name,
        token=token,
        target_phase=target_phase,
        timeout_seconds=900,
    )
    result = build_admin_runtime_images_payload(admin_user)
    result["operation"] = {
        "action": action,
        "component": component,
        "targetRef": target_ref,
        "targetTag": target_tag,
        "previousRef": current_ref,
        "previousTag": current_tag,
    }
    return result


def configured_allowed_emails() -> set[str]:
    return {normalize_email(email) for email in CONFIG["allowed_google_emails"] if normalize_email(email)}


def managed_allowed_emails() -> set[str]:
    return read_access_users_secret()


def all_direct_allowed_emails() -> set[str]:
    return configured_allowed_emails() | admin_google_emails() | managed_allowed_emails()


def normalize_endpoint_id(raw_value: Any) -> str:
    value = clean_resource_name_part(str(raw_value or ""))
    if not value or len(value) > 40 or not value.startswith("mwo-vm"):
        raise ApiError("Endpoint ID must use the mwo-vmN format.", 400)
    suffix = value.removeprefix("mwo-vm")
    if not suffix.isdigit() or int(suffix) < 1:
        raise ApiError("Endpoint ID must use the mwo-vmN format.", 400)
    return value


def normalize_endpoint_domain(raw_value: Any) -> str:
    domains = normalize_duckdns_domains([str(raw_value or "")])
    if len(domains) != 1 or not domains[0].endswith(".duckdns.org"):
        raise ApiError("Endpoint DNS must be a DuckDNS hostname.", 400)
    return domains[0]


def default_endpoint_records() -> list[dict[str, Any]]:
    primary_domain = CONFIG["duckdns_domains"][0] if CONFIG["duckdns_domains"] else "mwo-vm1.duckdns.org"
    legacy_zone = str(CONFIG["zone"] or "europe-central2-c")
    legacy_region = legacy_zone.rsplit("-", 1)[0] if "-" in legacy_zone else legacy_zone
    return [
        {
            "id": "mwo-vm1",
            "domain": primary_domain,
            "instanceName": "steam-cpu-europe-central2-c",
            "zone": legacy_zone,
            "region": legacy_region,
            "addressName": "steam-mwo-vm1-ip",
            "staticIp": "",
            "externalIp": "",
            "ipReservationMode": "ephemeral",
            "hardware": {
                "id": "cpu",
                "machineType": DEFAULT_CPU_MACHINE_TYPE,
                "gpuType": "",
                "gpuCount": 0,
                "acceleratorMode": "none",
            },
        },
        {"id": "mwo-vm2", "domain": "mwo-vm2.duckdns.org", "instanceName": "", "zone": "", "region": "", "addressName": "steam-mwo-vm2-ip", "staticIp": "", "externalIp": "", "ipReservationMode": "ephemeral", "hardware": {}},
        {"id": "mwo-vm3", "domain": "mwo-vm3.duckdns.org", "instanceName": "", "zone": "", "region": "", "addressName": "steam-mwo-vm3-ip", "staticIp": "", "externalIp": "", "ipReservationMode": "ephemeral", "hardware": {}},
    ]


def normalize_endpoint_record(raw_value: Any) -> dict[str, Any] | None:
    if not isinstance(raw_value, dict):
        return None
    try:
        endpoint_id = normalize_endpoint_id(raw_value.get("id"))
        domain = normalize_endpoint_domain(raw_value.get("domain"))
    except ApiError:
        return None
    hardware = raw_value.get("hardware") if isinstance(raw_value.get("hardware"), dict) else {}
    instance_name = bounded_gce_name(str(raw_value.get("instanceName", "") or "")) if raw_value.get("instanceName") else ""
    zone = str(raw_value.get("zone", "") or "")
    region = str(raw_value.get("region", "") or "")
    static_ip = str(raw_value.get("staticIp", "") or "")
    external_ip = str(raw_value.get("externalIp", "") or "")
    ip_reservation_mode = "manual" if str(raw_value.get("ipReservationMode", "") or "").strip().lower() == "manual" else "ephemeral"
    normalized_hardware = {
        "id": str(hardware.get("id", "") or ""),
        "machineType": str(hardware.get("machineType", "") or ""),
        "gpuType": str(hardware.get("gpuType", "") or ""),
        "gpuCount": int(hardware.get("gpuCount", 0) or 0),
        "acceleratorMode": str(hardware.get("acceleratorMode", "") or ""),
    }
    if not instance_name:
        zone = ""
        external_ip = ""
        normalized_hardware = {}
        if ip_reservation_mode == "ephemeral":
            region = ""
    return {
        "id": endpoint_id,
        "domain": domain,
        "instanceName": instance_name,
        "zone": zone,
        "region": region,
        "addressName": bounded_gce_name(str(raw_value.get("addressName", f"steam-{endpoint_id}-ip") or f"steam-{endpoint_id}-ip")),
        "staticIp": static_ip,
        "externalIp": external_ip,
        "ipReservationMode": ip_reservation_mode,
        "hardware": normalized_hardware if normalized_hardware.get("id") else {},
    }


def read_endpoint_records() -> list[dict[str, Any]]:
    secret_name = str(CONFIG["endpoints_secret_name"] or "").strip()
    if not secret_name:
        return default_endpoint_records()
    response = compute_session().get(
        f"{SECRET_MANAGER_BASE_URL}/{secret_path(secret_name)}/versions/latest:access",
        timeout=30,
    )
    if response.status_code == 404:
        return default_endpoint_records()
    if not response.ok:
        raise ApiError("Unable to load VM endpoint registry.", 502)
    try:
        encoded = str(response.json().get("payload", {}).get("data", "") or "")
        parsed = json.loads(base64.b64decode(encoded).decode("utf-8"))
        raw_records = parsed.get("endpoints", []) if isinstance(parsed, dict) else []
    except (ValueError, TypeError, json.JSONDecodeError):
        raw_records = []
    records = [record for record in (normalize_endpoint_record(item) for item in raw_records) if record]
    return records or default_endpoint_records()


def write_endpoint_records(records: list[dict[str, Any]]) -> None:
    secret_name = str(CONFIG["endpoints_secret_name"] or "").strip()
    if not secret_name:
        raise ApiError("VM endpoint registry is not configured.", 500)
    normalized = [record for record in (normalize_endpoint_record(item) for item in records) if record]
    seen: set[str] = set()
    for endpoint in normalized:
        if endpoint["id"] in seen:
            raise ApiError("Endpoint IDs must be unique.", 400)
        if any(existing["domain"] == endpoint["domain"] for existing in normalized if existing is not endpoint):
            raise ApiError("Endpoint DNS names must be unique.", 400)
        seen.add(endpoint["id"])
    encoded = base64.b64encode(json.dumps({"endpoints": normalized}, separators=(",", ":"), sort_keys=True).encode("utf-8")).decode("ascii")
    response = compute_session().post(
        f"{SECRET_MANAGER_BASE_URL}/{secret_path(secret_name)}:addVersion",
        json={"payload": {"data": encoded}},
        timeout=30,
    )
    if not response.ok:
        raise ApiError("Unable to save VM endpoint registry.", 502)


def endpoint_by_id(endpoint_id: str) -> dict[str, Any]:
    for endpoint in read_endpoint_records():
        if endpoint["id"] == endpoint_id:
            return endpoint
    raise ApiError(f"Unknown VM endpoint: {endpoint_id}.", 404)


def selected_endpoint_id() -> str:
    return str(request_override("target_endpoint_id", "mwo-vm1"))


def selected_endpoint() -> dict[str, Any]:
    if has_request_context() and hasattr(g, "target_endpoint"):
        return dict(getattr(g, "target_endpoint"))
    endpoint = endpoint_by_id(selected_endpoint_id())
    if has_request_context():
        g.target_endpoint = endpoint
    return endpoint


def selected_endpoint_domains() -> list[str]:
    domain = str(selected_endpoint().get("domain", "") or "")
    return [domain] if domain else []


def endpoint_public_payload(endpoint: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": endpoint["id"],
        "domain": endpoint["domain"],
        "instanceName": endpoint.get("instanceName", ""),
        "zone": endpoint.get("zone", ""),
        "region": endpoint.get("region", ""),
        "addressName": endpoint.get("addressName", ""),
        "staticIp": endpoint.get("staticIp", ""),
        "externalIp": endpoint.get("externalIp", ""),
        "ipReservationMode": endpoint.get("ipReservationMode", "ephemeral"),
        "hardware": endpoint.get("hardware", {}),
    }


LIVE_ACCESS_PROBE_TIMEOUT_SECONDS: Final = 5


def live_access_probe_result(state: str, label: str, detail: str) -> dict[str, str]:
    return {
        "state": state,
        "label": label,
        "detail": detail,
        "checkedAt": datetime.now(timezone.utc).isoformat(),
    }


def live_access_probe_error(error: Exception) -> str:
    if isinstance(error, socket.timeout):
        return "Connection timed out."
    if isinstance(error, ConnectionRefusedError):
        return "Connection was refused."
    if isinstance(error, socket.gaierror):
        return "DNS lookup failed."
    message = str(error).strip()
    return message[:160] if message else "Connection failed."


def probe_http_live_access(host: str, port: int, service: str, tls: bool) -> dict[str, str]:
    connection: HTTPConnection | HTTPSConnection | None = None
    try:
        if tls:
            connection = HTTPSConnection(
                host,
                port,
                timeout=LIVE_ACCESS_PROBE_TIMEOUT_SECONDS,
                context=ssl._create_unverified_context(),
            )
        else:
            connection = HTTPConnection(host, port, timeout=LIVE_ACCESS_PROBE_TIMEOUT_SECONDS)
        connection.request("GET", "/", headers={"Host": host, "User-Agent": "steam-vm-control-live-access-probe"})
        response = connection.getresponse()
        response.read(1024)
        if response.status < 500:
            return live_access_probe_result("healthy", "Reachable", f"{service} responded with HTTP {response.status}.")
        return live_access_probe_result("degraded", "Reachable, service error", f"{service} responded with HTTP {response.status}.")
    except (OSError, ssl.SSLError) as error:
        return live_access_probe_result("unreachable", "Unreachable", live_access_probe_error(error))
    finally:
        if connection:
            connection.close()


def encode_minecraft_varint(value: int) -> bytes:
    encoded = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        encoded.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(encoded)


def decode_minecraft_varint(data: bytes, offset: int = 0) -> tuple[int, int]:
    value = 0
    for index in range(5):
        if offset + index >= len(data):
            raise ValueError("Incomplete Minecraft status response.")
        byte = data[offset + index]
        value |= (byte & 0x7F) << (7 * index)
        if not byte & 0x80:
            return value, offset + index + 1
    raise ValueError("Invalid Minecraft status response.")


def receive_minecraft_varint(connection: socket.socket) -> int:
    data = bytearray()
    while len(data) < 5:
        byte = connection.recv(1)
        if not byte:
            raise ValueError("Minecraft server closed the status connection.")
        data.extend(byte)
        if not byte[0] & 0x80:
            return decode_minecraft_varint(bytes(data))[0]
    raise ValueError("Invalid Minecraft status response.")


def receive_minecraft_bytes(connection: socket.socket, length: int) -> bytes:
    if length < 0 or length > 65536:
        raise ValueError("Invalid Minecraft status response length.")
    data = bytearray()
    while len(data) < length:
        chunk = connection.recv(length - len(data))
        if not chunk:
            raise ValueError("Minecraft server closed the status connection.")
        data.extend(chunk)
    return bytes(data)


def probe_minecraft_live_access(host: str) -> dict[str, str]:
    try:
        with socket.create_connection((host, 25565), timeout=LIVE_ACCESS_PROBE_TIMEOUT_SECONDS) as connection:
            connection.settimeout(LIVE_ACCESS_PROBE_TIMEOUT_SECONDS)
            host_bytes = host.encode("utf-8")
            handshake = (
                encode_minecraft_varint(0)
                + encode_minecraft_varint(765)
                + encode_minecraft_varint(len(host_bytes))
                + host_bytes
                + (25565).to_bytes(2, "big")
                + encode_minecraft_varint(1)
            )
            connection.sendall(encode_minecraft_varint(len(handshake)) + handshake)
            connection.sendall(b"\x01\x00")
            payload = receive_minecraft_bytes(connection, receive_minecraft_varint(connection))
            packet_id, offset = decode_minecraft_varint(payload)
            response_length, offset = decode_minecraft_varint(payload, offset)
            if packet_id != 0 or response_length > len(payload) - offset:
                raise ValueError("Minecraft server returned an invalid status response.")
            status = json.loads(payload[offset:offset + response_length].decode("utf-8"))
            version = str(status.get("version", {}).get("name", "") or "").strip() if isinstance(status, dict) else ""
            if not isinstance(status, dict):
                raise ValueError("Minecraft server returned an invalid status response.")
            detail = "Minecraft status ping succeeded" + (f" ({version})." if version else ".")
            return live_access_probe_result("healthy", "Reachable", detail)
    except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        return live_access_probe_result("unreachable", "Unreachable", live_access_probe_error(error))


def build_live_access_reachability_payload(endpoint: dict[str, Any]) -> dict[str, Any]:
    host = str(endpoint.get("domain", "") or "").strip().lower()
    if not re.fullmatch(r"[a-z0-9-]+\.duckdns\.org", host):
        unavailable = live_access_probe_result("unreachable", "Unreachable", "A valid managed DuckDNS host is not assigned.")
        return {
            "endpointId": endpoint["id"],
            "host": host,
            "checkedAt": unavailable["checkedAt"],
            "services": {"sunshine": unavailable, "novnc": unavailable, "minecraft": unavailable},
        }
    with ThreadPoolExecutor(max_workers=3) as executor:
        sunshine_probe = executor.submit(probe_http_live_access, host, 47990, "Sunshine", True)
        minecraft_probe = executor.submit(probe_minecraft_live_access, host)
        services = {
            "sunshine": sunshine_probe.result(),
            "novnc": live_access_probe_result(
                "restricted",
                "Administrator access only",
                "noVNC is intentionally private and is available through an authorized Google IAP TCP tunnel.",
            ),
            "minecraft": minecraft_probe.result(),
        }
    return {
        "endpointId": endpoint["id"],
        "host": host,
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "services": services,
    }


def build_admin_endpoints_payload(admin_user: dict[str, Any]) -> dict[str, Any]:
    return {"user": admin_user, "endpoints": [endpoint_public_payload(endpoint) for endpoint in reconcile_endpoint_instance_bindings()]}


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


def clean_resource_name_part(raw: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in str(raw or ""))
    cleaned = "-".join(part for part in cleaned.split("-") if part)
    return cleaned or "target"


def hardware_name_slug(hardware_id: str, gpu_type: str, gpu_count: int) -> str:
    if int(gpu_count or 0) <= 0 or hardware_id == CPU_HARDWARE_ID:
        return "cpu"
    catalog_gpu_type = gpu_type.removesuffix("-vws")
    aliases = {
        "nvidia-tesla-t4": "t4",
        "nvidia-l4": "l4",
    }
    return aliases.get(catalog_gpu_type, aliases.get(hardware_id, clean_resource_name_part(catalog_gpu_type or hardware_id)))


def bounded_gce_name(raw_name: str) -> str:
    name = clean_resource_name_part(raw_name)
    if not name or not name[0].isalpha():
        name = f"vm-{name}"
    if len(name) <= 63:
        return name
    digest = hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]
    return f"{name[:54].rstrip('-')}-{digest}"


def managed_instance_base_names() -> list[str]:
    names = [bounded_gce_name(require_env("instance"))]
    for legacy_name in CONFIG["legacy_instance_names"]:
        normalized = bounded_gce_name(legacy_name)
        if normalized not in names:
            names.append(normalized)
    for endpoint in read_endpoint_records():
        instance_name = str(endpoint.get("instanceName", "") or "")
        if instance_name and instance_name not in names:
            names.append(instance_name)
        endpoint_base = bounded_gce_name(f"steam-{endpoint['id']}")
        if endpoint_base not in names:
            names.append(endpoint_base)
    return names


def target_instance_name_for(
    *,
    hardware_id: str,
    gpu_type: str,
    gpu_count: int,
    zone: str,
    base_name: str | None = None,
) -> str:
    base = bounded_gce_name(base_name or require_env("instance"))
    hardware_slug = hardware_name_slug(hardware_id, gpu_type, gpu_count)
    return bounded_gce_name(f"{base}-{hardware_slug}-{zone}")


def selected_computed_instance_name() -> str:
    return target_instance_name_for(
        hardware_id=selected_hardware_id(),
        gpu_type=selected_gpu_type(),
        gpu_count=selected_gpu_count(),
        zone=selected_zone(),
    )


def explicit_instance_url(zone: str, instance: str) -> str:
    project = require_env("project")
    return (
        "https://compute.googleapis.com/compute/v1/"
        f"projects/{project}/zones/{zone}/instances/{instance}"
    )


def legacy_instance_for_current_selection() -> dict[str, Any] | None:
    if not has_request_context():
        return None
    # Legacy discovery exists only to migrate the original mwo-vm1 naming
    # scheme. New endpoints must never adopt another endpoint's VM merely
    # because hardware and zone happen to match.
    if selected_endpoint_id() != "mwo-vm1":
        return None
    if hasattr(g, "legacy_instance_checked"):
        return getattr(g, "legacy_instance_for_selection", None)
    g.legacy_instance_checked = True
    g.legacy_instance_for_selection = None
    selected_name = selected_computed_instance_name()
    candidates: list[str] = []
    for base_name in managed_instance_base_names():
        candidates.extend([
            target_instance_name_for(
                hardware_id=selected_hardware_id(),
                gpu_type=selected_gpu_type(),
                gpu_count=selected_gpu_count(),
                zone=selected_zone(),
                base_name=base_name,
            ),
            base_name,
        ])
    for legacy_name in dict.fromkeys(candidates):
        if legacy_name == selected_name:
            continue
        legacy = compute_request("GET", explicit_instance_url(selected_zone(), legacy_name), allow_404=True)
        if isinstance(legacy, dict) and instance_hardware_matches_selection(legacy):
            g.legacy_instance_for_selection = legacy
            return legacy
    return None


def selected_instance_name() -> str:
    if has_request_context() and hasattr(g, "target_instance_name"):
        return str(getattr(g, "target_instance_name"))
    legacy = legacy_instance_for_current_selection()
    name = str(legacy.get("name", "")) if legacy else selected_computed_instance_name()
    if has_request_context():
        g.target_instance_name = name
    return name


def instance_url() -> str:
    return explicit_instance_url(selected_zone(), selected_instance_name())


def instances_collection_url() -> str:
    project = require_env("project")
    zone = selected_zone()
    return f"https://compute.googleapis.com/compute/v1/projects/{project}/zones/{zone}/instances"


def capacity_reservations_collection_url(zone: str | None = None) -> str:
    reservation_zone = zone or selected_zone()
    return (
        "https://compute.googleapis.com/compute/beta/"
        f"projects/{require_env('project')}/zones/{reservation_zone}/reservations"
    )


def capacity_reservation_url(zone: str, name: str) -> str:
    return f"{capacity_reservations_collection_url(zone)}/{name}"


def capacity_reservations_aggregated_url() -> str:
    return (
        "https://compute.googleapis.com/compute/beta/"
        f"projects/{require_env('project')}/aggregated/reservations"
    )


def firewalls_collection_url() -> str:
    project = require_env("project")
    return f"https://compute.googleapis.com/compute/v1/projects/{project}/global/firewalls"


def firewall_url(name: str) -> str:
    return f"{firewalls_collection_url()}/{name}"


def zone_region(zone: str) -> str:
    if zone.count("-") >= 2:
        return zone.rsplit("-", 1)[0]
    return zone


def addresses_collection_url(region: str) -> str:
    return f"https://compute.googleapis.com/compute/v1/projects/{require_env('project')}/regions/{region}/addresses"


def address_url(region: str, name: str) -> str:
    return f"{addresses_collection_url(region)}/{name}"


def endpoint_instance_or_none(endpoint: dict[str, Any]) -> dict[str, Any] | None:
    name = str(endpoint.get("instanceName", "") or "")
    zone = str(endpoint.get("zone", "") or "")
    if not name or not zone:
        return None
    return compute_request("GET", explicit_instance_url(zone, name), allow_404=True)


def reconcile_endpoint_instance_bindings(records: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    records = records if records is not None else read_endpoint_records()
    changed = False
    for endpoint in records:
        name = str(endpoint.get("instanceName", "") or "")
        zone = str(endpoint.get("zone", "") or "")
        if not name and not zone:
            continue
        if not name or not zone or endpoint_instance_or_none(endpoint) is None:
            clear_endpoint_instance_binding(endpoint)
            changed = True
    if changed:
        write_endpoint_records(records)
    return records


def persist_endpoint(endpoint: dict[str, Any]) -> dict[str, Any]:
    records = read_endpoint_records()
    updated = False
    for index, record in enumerate(records):
        if record["id"] == endpoint["id"]:
            records[index] = endpoint
            updated = True
            break
    if not updated:
        records.append(endpoint)
    write_endpoint_records(records)
    if has_request_context():
        g.target_endpoint = endpoint
    return endpoint


def ensure_selected_endpoint_static_address() -> dict[str, Any]:
    endpoint = selected_endpoint()
    region = str(endpoint.get("region", "") or zone_region(selected_zone()))
    if region != zone_region(selected_zone()):
        raise ApiError(f"Endpoint {endpoint['id']} is pinned to {region}.", 400)
    name = bounded_gce_name(str(endpoint.get("addressName", "") or f"steam-{endpoint['id']}-ip"))
    address = compute_request("GET", address_url(region, name), allow_404=True)
    if address is None:
        body: dict[str, Any] = {
            "name": name,
            "addressType": "EXTERNAL",
            "networkTier": "PREMIUM",
            "description": f"VM Control endpoint {endpoint['id']} ({endpoint['domain']})",
        }
        existing_instance = endpoint_instance_or_none(endpoint)
        existing_ip = extract_external_ip(existing_instance) if existing_instance else ""
        if existing_ip:
            body["address"] = existing_ip
        operation = compute_request("POST", addresses_collection_url(region), json=body)
        if not isinstance(operation, dict):
            raise ApiError("Failed to reserve endpoint static IP address.", 502)
        for _ in range(45):
            address = compute_request("GET", address_url(region, name), allow_404=True)
            if isinstance(address, dict) and str(address.get("address", "") or ""):
                break
            time.sleep(2)
    if not isinstance(address, dict) or not str(address.get("address", "") or ""):
        raise ApiError("Endpoint static IP address is not ready.", 504)
    endpoint["region"] = region
    endpoint["addressName"] = name
    endpoint["staticIp"] = str(address.get("address", ""))
    endpoint["externalIp"] = ""
    endpoint["ipReservationMode"] = "manual"
    return persist_endpoint(endpoint)


def bind_selected_endpoint_to_instance(instance: dict[str, Any]) -> dict[str, Any]:
    endpoint = selected_endpoint()
    endpoint["instanceName"] = str(instance.get("name", "") or selected_instance_name())
    endpoint["zone"] = instance_zone_name(instance) or selected_zone()
    endpoint["region"] = zone_region(endpoint["zone"])
    endpoint["hardware"] = instance_hardware_selection(instance)
    external_ip = extract_external_ip(instance)
    if endpoint_has_manual_static_ip(endpoint):
        endpoint["externalIp"] = ""
    else:
        endpoint["externalIp"] = external_ip
    return persist_endpoint(endpoint)


def unbind_selected_endpoint_instance() -> dict[str, Any]:
    endpoint = selected_endpoint()
    clear_endpoint_instance_binding(endpoint)
    return persist_endpoint(endpoint)


def clear_endpoint_instance_binding(endpoint: dict[str, Any]) -> dict[str, Any]:
    endpoint["instanceName"] = ""
    endpoint["zone"] = ""
    endpoint["hardware"] = {}
    endpoint["externalIp"] = ""
    if not endpoint_has_manual_static_ip(endpoint):
        endpoint["region"] = ""
    return endpoint


def endpoint_has_manual_static_ip(endpoint: dict[str, Any]) -> bool:
    return (
        str(endpoint.get("ipReservationMode", "") or "").strip().lower() == "manual"
        and bool(str(endpoint.get("staticIp", "") or "").strip())
    )


def release_endpoint_static_address(
    endpoint: dict[str, Any],
    *,
    preserve_instance_binding: bool = False,
) -> dict[str, Any]:
    if not preserve_instance_binding and endpoint_instance_or_none(endpoint) is not None:
        raise ApiError("Delete the endpoint VM before releasing its static IP address.", 400)
    region = str(endpoint.get("region", "") or "")
    name = str(endpoint.get("addressName", "") or "")
    if region and name:
        operation = compute_request("DELETE", address_url(region, name), allow_404=True)
        if operation is not None and not isinstance(operation, dict):
            raise ApiError("Failed to release endpoint static IP address.", 502)
        for _ in range(45):
            if compute_request("GET", address_url(region, name), allow_404=True) is None:
                break
            time.sleep(2)
        else:
            raise ApiError("Endpoint static IP address is still being released.", 504)
    endpoint["staticIp"] = ""
    endpoint["externalIp"] = ""
    endpoint["ipReservationMode"] = "ephemeral"
    if preserve_instance_binding:
        zone = str(endpoint.get("zone", "") or "")
        endpoint["region"] = zone_region(zone) if zone else ""
    else:
        endpoint["region"] = ""
        endpoint["zone"] = ""
        endpoint["instanceName"] = ""
        endpoint["hardware"] = {}
    return persist_endpoint(endpoint)


def machine_type_path() -> str:
    return f"zones/{selected_zone()}/machineTypes/{selected_machine_type()}"


def accelerator_type_path_for(gpu_type: str) -> str:
    return f"zones/{selected_zone()}/acceleratorTypes/{gpu_type}"


def accelerator_type_path() -> str:
    return accelerator_type_path_for(selected_gpu_type())


def disk_type_path() -> str:
    return f"zones/{selected_zone()}/diskTypes/{CONFIG['boot_disk_type']}"


def data_disk_type_path() -> str:
    return f"zones/{selected_zone()}/diskTypes/{CONFIG['data_disk_type']}"


def data_disk_device_name() -> str:
    return bounded_gce_name(f"{selected_instance_name()}-state")


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


def apply_target_overrides(source: Any, respect_existing_endpoint_hardware: bool = True) -> None:
    default = default_hardware_selection()
    endpoint_id = normalize_endpoint_id(source.get("endpointId") if hasattr(source, "get") and source.get("endpointId") else "mwo-vm1")
    endpoint = endpoint_by_id(endpoint_id)
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

    endpoint_hardware = endpoint.get("hardware") if isinstance(endpoint.get("hardware"), dict) else {}
    endpoint_has_instance = bool(endpoint.get("instanceName") and endpoint.get("zone"))
    if respect_existing_endpoint_hardware and endpoint_has_instance:
        zone = str(endpoint["zone"])
    if respect_existing_endpoint_hardware and endpoint_has_instance and endpoint_hardware:
        hardware_id = str(endpoint_hardware.get("id") or hardware_id)
        machine_type = str(endpoint_hardware.get("machineType") or machine_type)
        gpu_type = str(endpoint_hardware.get("gpuType") or "")
        gpu_count = int(endpoint_hardware.get("gpuCount", 0) or 0)
        accelerator_mode = str(endpoint_hardware.get("acceleratorMode") or ("none" if gpu_count == 0 else accelerator_mode))
    endpoint_region = str(endpoint.get("region", "") or "")
    if respect_existing_endpoint_hardware and endpoint_region and zone_region(zone) != endpoint_region:
        raise ApiError(f"Endpoint {endpoint_id} is pinned to {endpoint_region}.", 400)

    g.target_zone = zone
    g.target_machine_type = machine_type
    g.target_gpu_type = gpu_type
    g.target_gpu_count = gpu_count
    g.target_accelerator_mode = accelerator_mode
    g.target_hardware_id = hardware_id
    g.target_endpoint_id = endpoint_id
    g.target_endpoint = endpoint
    g.target_instance_name = str(endpoint.get("instanceName", "") or "") or target_instance_name_for(
        hardware_id=hardware_id,
        gpu_type=gpu_type,
        gpu_count=gpu_count,
        zone=zone,
        base_name=f"steam-{endpoint_id}",
    )


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


def money_to_float(unit_price: dict[str, Any]) -> float:
    return float(int(unit_price.get("units", "0") or "0")) + float(unit_price.get("nanos", 0) or 0) / 1_000_000_000


def sku_hourly_price(sku: dict[str, Any]) -> float | None:
    pricing_info = sku.get("pricingInfo", []) or []
    if not pricing_info:
        return None
    expression = pricing_info[0].get("pricingExpression", {}) or {}
    usage_unit = str(expression.get("usageUnit", ""))
    if not usage_unit.endswith("h"):
        return None
    rates = expression.get("tieredRates", []) or []
    if not rates:
        return None
    unit_price = rates[0].get("unitPrice", {}) or {}
    return money_to_float(unit_price)


def sku_disk_hourly_price(sku: dict[str, Any]) -> float | None:
    pricing_info = sku.get("pricingInfo", []) or []
    if not pricing_info:
        return None
    expression = pricing_info[0].get("pricingExpression", {}) or {}
    if str(expression.get("usageUnit", "")) != "GiBy.mo":
        return None
    rates = expression.get("tieredRates", []) or []
    if not rates:
        return None
    unit_price = rates[0].get("unitPrice", {}) or {}
    return money_to_float(unit_price) / BILLING_HOURS_PER_MONTH


def gpu_billing_label(gpu_type: str) -> str:
    parts = [part for part in gpu_type.split("-") if part and part != "nvidia"]
    return "Nvidia " + " ".join(part.upper() if any(ch.isdigit() for ch in part) else part.title() for part in parts)


def is_priceable_gpu_accelerator(accelerator_name: str) -> bool:
    return accelerator_name in GPU_PRICE_DESCRIPTION_ALIASES


def is_standard_gpu_price_description(description: str, gpu_type: str) -> bool:
    normalized = " ".join(str(description or "").split())
    if not normalized:
        return False

    is_vws = gpu_type.endswith("-vws")
    dws_marker = "attached to DWS Defined Duration VMs"
    excluded_markers = (
        "attached to Spot Preemptible VMs",
        "Commitment ",
        "DWS Calendar Mode",
        "Reserved ",
        "Spot Preemptible ",
    )
    if any(marker in normalized for marker in excluded_markers):
        return False

    for alias in GPU_PRICE_DESCRIPTION_ALIASES.get(gpu_type, (gpu_billing_label(gpu_type),)):
        if dws_marker in normalized:
            if is_vws and normalized.startswith(f"{alias} {dws_marker} running in "):
                return True
            continue
        if is_vws:
            continue
        if normalized.startswith(f"{alias} running in "):
            return True
    return False


def price_key_for_sku(sku: dict[str, Any]) -> tuple[str, str] | None:
    category = sku.get("category", {}) or {}
    if category.get("usageType") != "OnDemand":
        return None

    description = str(sku.get("description", ""))
    excluded_terms = ("Commitment", "Spot", "Preemptible")
    if any(term in description for term in excluded_terms):
        return None

    if description.startswith("N1 Predefined Instance Core "):
        return ("n1-standard", "core")
    if description.startswith("N1 Predefined Instance Ram "):
        return ("n1-standard", "ram")
    if description.startswith("G2 Instance Core "):
        return ("g2", "core")
    if description.startswith("G2 Instance Ram "):
        return ("g2", "ram")

    for disk_type, prefix in PERSISTENT_DISK_PRICE_TYPES.items():
        if description.startswith(f"{prefix} in ") or description == prefix:
            return ("disk", disk_type)

    known_gpu_types = tuple(GPU_PRICE_DESCRIPTION_ALIASES)
    for gpu_type in known_gpu_types:
        if is_standard_gpu_price_description(description, gpu_type):
            return ("gpu", gpu_type)
    return None


def refresh_price_index(currency: str = PRICE_CURRENCY_CODE, *, allow_fetch: bool = True) -> dict[str, Any]:
    now = time.time()
    if (
        PRICE_INDEX_CACHE["index"]
        and PRICE_INDEX_CACHE["currency"] == currency
        and now - float(PRICE_INDEX_CACHE["loaded_at"]) < PRICE_CACHE_TTL_SECONDS
    ):
        return PRICE_INDEX_CACHE
    if not allow_fetch:
        raise ApiError("Pricing catalog is not loaded yet.", 503)

    # A cold Cloud Run revision can receive several hardware requests in
    # parallel. Only one request should scan the complete Billing catalog.
    with PRICE_INDEX_LOCK:
        now = time.time()
        if (
            PRICE_INDEX_CACHE["index"]
            and PRICE_INDEX_CACHE["currency"] == currency
            and now - float(PRICE_INDEX_CACHE["loaded_at"]) < PRICE_CACHE_TTL_SECONDS
        ):
            return PRICE_INDEX_CACHE

        index: dict[str, dict[tuple[str, str], float]] = {}
        effective_time = ""
        conversion_rate: float | None = None
        page_token = ""
        session = compute_session()
        for _ in range(20):
            params = {
                "currencyCode": currency,
                "pageSize": "5000",
            }
            if page_token:
                params["pageToken"] = page_token
            response = session.get(
                f"https://cloudbilling.googleapis.com/v1/services/{COMPUTE_BILLING_SERVICE_ID}/skus",
                params=params,
                timeout=30,
            )
            if response.status_code >= 400:
                raise ApiError(f"Cloud Billing pricing catalog returned {response.status_code}.", 502)
            data = response.json()
            for sku in data.get("skus", []) or []:
                if not isinstance(sku, dict):
                    continue
                key = price_key_for_sku(sku)
                price = sku_disk_hourly_price(sku) if key and key[0] == "disk" else sku_hourly_price(sku)
                if not key or price is None:
                    continue
                pricing_info = sku.get("pricingInfo", []) or []
                if pricing_info:
                    effective_time = effective_time or str(pricing_info[0].get("effectiveTime", ""))
                    conversion_rate = conversion_rate or pricing_info[0].get("currencyConversionRate")
                for region in sku.get("serviceRegions", []) or []:
                    region_key = str(region)
                    region_prices = index.setdefault(region_key, {})
                    region_prices.setdefault(key, price)
            page_token = str(data.get("nextPageToken", "") or "")
            if not page_token:
                break

        PRICE_INDEX_CACHE.update(
            {
                "loaded_at": now,
                "currency": currency,
                "index": index,
                "effective_time": effective_time,
                "conversion_rate": conversion_rate,
            }
        )
        return PRICE_INDEX_CACHE


def machine_spec(machine_type: str) -> dict[str, float | str] | None:
    if machine_type in MACHINE_TYPE_SPECS:
        return MACHINE_TYPE_SPECS[machine_type]
    if machine_type.startswith("n1-standard-"):
        try:
            vcpus = float(machine_type.rsplit("-", 1)[-1])
        except ValueError:
            return None
        return {"family": "n1-standard", "vcpus": vcpus, "memoryGb": vcpus * 3.75}
    return None


def configured_persistent_disks() -> list[dict[str, Any]]:
    return [
        {
            "label": "Boot disk",
            "diskType": str(CONFIG["boot_disk_type"]),
            "sizeGb": float(parse_disk_size_gb(str(CONFIG["boot_disk_size"]))),
        },
        {
            "label": "State disk",
            "diskType": str(CONFIG["data_disk_type"]),
            "sizeGb": float(parse_disk_size_gb(str(CONFIG["data_disk_size"]))),
        },
    ]


def persistent_disks_for_price(instance: dict[str, Any] | None) -> tuple[list[dict[str, Any]], str]:
    actual_disks: list[dict[str, Any]] = []
    for disk in (instance or {}).get("disks", []) or []:
        if not isinstance(disk, dict):
            continue
        source_disk: dict[str, Any] = {}
        source_url = str(disk.get("source", "") or "").strip()
        if source_url:
            try:
                fetched_disk = compute_request("GET", source_url, allow_404=True)
                if isinstance(fetched_disk, dict):
                    source_disk = fetched_disk
            except ApiError as error:
                logging.warning("Unable to read disk details for price estimate: %s", error)
        disk_type = str(source_disk.get("type", "") or disk.get("type", "") or "").rsplit("/", 1)[-1].strip()
        try:
            size_gb = float(source_disk.get("sizeGb", 0) or disk.get("diskSizeGb", 0) or 0)
        except (TypeError, ValueError):
            size_gb = 0
        if not disk_type or size_gb <= 0:
            continue
        actual_disks.append(
            {
                "label": "Boot disk" if disk.get("boot") is True else "State disk",
                "diskType": disk_type,
                "sizeGb": size_gb,
            }
        )

    if actual_disks:
        return actual_disks, "actual"
    return configured_persistent_disks(), "configured"


def build_price_estimate(
    *,
    machine_type: str,
    gpu_type: str,
    gpu_count: int,
    zone: str,
    allow_fetch: bool = True,
    persistent_disks: list[dict[str, Any]] | None = None,
    disk_source: str = "",
) -> dict[str, Any]:
    currency = PRICE_CURRENCY_CODE
    region = zone_region(zone)
    spec = machine_spec(machine_type)
    if not spec:
        return {
            "available": False,
            "currency": currency,
            "zone": zone,
            "region": region,
            "display": "Price unavailable",
            "detail": f"No local machine specification for {machine_type}.",
        }

    price_index = refresh_price_index(currency, allow_fetch=allow_fetch)
    region_prices = (price_index.get("index", {}) or {}).get(region, {})
    family = str(spec["family"])
    core_rate = region_prices.get((family, "core"))
    ram_rate = region_prices.get((family, "ram"))
    missing = []
    if core_rate is None:
        missing.append(f"{family} core")
    if ram_rate is None:
        missing.append(f"{family} RAM")

    components = []
    total = 0.0
    if core_rate is not None:
        amount = float(spec["vcpus"]) * core_rate
        total += amount
        components.append({"label": f"{spec['vcpus']:g} vCPU", "amountPln": round(amount, 4)})
    if ram_rate is not None:
        amount = float(spec["memoryGb"]) * ram_rate
        total += amount
        components.append({"label": f"{spec['memoryGb']:g} GB RAM", "amountPln": round(amount, 4)})

    if gpu_count > 0:
        gpu_rate = region_prices.get(("gpu", gpu_type))
        if gpu_rate is None:
            missing.append(gpu_type)
        else:
            amount = float(gpu_count) * gpu_rate
            total += amount
            components.append({"label": f"{gpu_count} x {gpu_type}", "amountPln": round(amount, 4)})

    if missing:
        return {
            "available": False,
            "currency": currency,
            "zone": zone,
            "region": region,
            "display": "Price unavailable",
            "detail": f"Missing pricing SKU: {', '.join(missing)}.",
            "effectiveTime": price_index.get("effective_time", ""),
            "currencyConversionRate": price_index.get("conversion_rate"),
        }

    disk_components = []
    disk_missing = []
    disk_total = 0.0
    for disk in persistent_disks or []:
        disk_type = str(disk.get("diskType", "") or "")
        try:
            size_gb = float(disk.get("sizeGb", 0) or 0)
        except (TypeError, ValueError):
            size_gb = 0
        if size_gb <= 0:
            continue
        rate = region_prices.get(("disk", disk_type))
        if rate is None:
            disk_missing.append(disk_type or "unknown disk")
            continue
        amount = size_gb * rate
        disk_total += amount
        disk_components.append(
            {
                "label": f"{disk.get('label', 'Persistent disk')} ({disk_type}, {size_gb:g} GB)",
                "amountPln": round(amount, 4),
            }
        )

    rounded = round(total, 2)
    disk_rounded = round(disk_total, 2)
    running_rounded = round(total + disk_total, 2)
    disk_available = not disk_missing
    return {
        "available": True,
        "currency": currency,
        "amountPln": rounded,
        "display": f"~{rounded:.2f} PLN/h",
        "zone": zone,
        "region": region,
        "machineType": machine_type,
        "gpuType": gpu_type,
        "gpuCount": gpu_count,
        "components": components,
        "source": "Google Cloud Billing Catalog API",
        "effectiveTime": price_index.get("effective_time", ""),
        "currencyConversionRate": price_index.get("conversion_rate"),
        "storage": {
            "available": disk_available,
            "amountPln": disk_rounded,
            "components": disk_components,
            "missing": disk_missing,
            "source": disk_source or "not requested",
        },
        "running": {
            "available": disk_available,
            "amountPln": running_rounded,
            "display": f"~{running_rounded:.2f} PLN/h" if disk_available else "Price unavailable",
            "components": [*components, *disk_components],
            "missing": disk_missing,
        },
        "terminated": {
            "available": disk_available,
            "amountPln": disk_rounded,
            "display": f"~{disk_rounded:.2f} PLN/h" if disk_available else "Price unavailable",
            "components": disk_components,
            "missing": disk_missing,
        },
        "excludes": ["snapshots", "network egress", "committed-use discounts", "taxes"],
    }


def safe_price_estimate(
    *,
    machine_type: str,
    gpu_type: str,
    gpu_count: int,
    zone: str,
    allow_fetch: bool = True,
    persistent_disks: list[dict[str, Any]] | None = None,
    disk_source: str = "",
) -> dict[str, Any]:
    try:
        return build_price_estimate(
            machine_type=machine_type,
            gpu_type=gpu_type,
            gpu_count=gpu_count,
            zone=zone,
            allow_fetch=allow_fetch,
            persistent_disks=persistent_disks,
            disk_source=disk_source,
        )
    except ApiError as error:
        if not allow_fetch:
            return {
                "available": False,
                "currency": PRICE_CURRENCY_CODE,
                "zone": zone,
                "region": zone_region(zone),
                "display": "Price not loaded",
                "detail": error.message,
            }
        logging.warning("Pricing estimate unavailable: %s", error)
        return {
            "available": False,
            "currency": PRICE_CURRENCY_CODE,
            "zone": zone,
            "region": zone_region(zone),
            "display": "Price unavailable",
            "detail": "Cloud Billing pricing catalog is temporarily unavailable.",
        }
    except Exception as error:
        logging.warning("Pricing estimate unavailable: %s", error)
        return {
            "available": False,
            "currency": PRICE_CURRENCY_CODE,
            "zone": zone,
            "region": zone_region(zone),
            "display": "Price unavailable",
            "detail": "Cloud Billing pricing catalog is temporarily unavailable.",
        }


def priced_gpu_regions(gpu_type: str) -> set[str] | None:
    try:
        price_index = refresh_price_index(PRICE_CURRENCY_CODE)
    except Exception as error:
        logging.warning("Unable to filter GPU zones by pricing catalog: %s", error)
        return None

    regions: set[str] = set()
    for region, region_prices in (price_index.get("index", {}) or {}).items():
        if isinstance(region_prices, dict) and ("gpu", gpu_type) in region_prices:
            regions.add(str(region))
    return regions


def filter_zones_by_gpu_price(gpu_type: str, zones: list[str]) -> list[str]:
    priced_regions = priced_gpu_regions(gpu_type)
    if not priced_regions:
        return zones
    return [zone for zone in zones if zone_region(zone) in priced_regions]


def hardware_profile(
    *,
    hardware_id: str,
    label: str,
    machine_type: str,
    gpu_type: str,
    gpu_count: int,
    accelerator_mode: str,
    zones: list[str],
    supported: bool = True,
    unavailable_reason: str = "",
    sunshine_compatibility: dict[str, str] | None = None,
) -> dict[str, Any]:
    return {
        "id": hardware_id,
        "label": label,
        "machineType": machine_type,
        "gpuType": gpu_type,
        "gpuCount": gpu_count,
        "vramGb": GPU_VRAM_GB.get(gpu_type),
        "acceleratorMode": accelerator_mode,
        "zones": zones,
        "supported": supported,
        "unavailableReason": unavailable_reason,
        "sunshineCompatibility": sunshine_compatibility or {},
    }


def lowest_profile_price_estimate(profile: dict[str, Any]) -> dict[str, Any] | None:
    """Return the lowest on-demand hourly estimate across a GPU profile's regions.

    The Billing Catalog API prices Compute Engine resources per region, not per
    zone.  One representative zone per region is therefore sufficient and keeps
    building the hardware combobox local after the shared catalog cache is warm.
    """
    if int(profile.get("gpuCount", 0) or 0) <= 0:
        return None

    representative_zones: dict[str, str] = {}
    for zone in profile.get("zones", []) or []:
        zone_name = str(zone).strip()
        if zone_name:
            representative_zones.setdefault(zone_region(zone_name), zone_name)

    estimates = []
    for zone in representative_zones.values():
        estimate = safe_price_estimate(
            machine_type=str(profile.get("machineType", "")),
            gpu_type=str(profile.get("gpuType", "")),
            gpu_count=int(profile.get("gpuCount", 0) or 0),
            zone=zone,
            allow_fetch=False,
        )
        if estimate.get("available") and isinstance(estimate.get("amountPln"), (int, float)):
            estimates.append(estimate)

    if not estimates:
        return None
    return min(estimates, key=lambda estimate: float(estimate["amountPln"]))


def sort_hardware_profiles_by_price(profiles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cpu_profiles = [profile for profile in profiles if int(profile.get("gpuCount", 0) or 0) <= 0]
    gpu_profiles = [profile for profile in profiles if int(profile.get("gpuCount", 0) or 0) > 0]

    for profile in gpu_profiles:
        profile["priceEstimate"] = lowest_profile_price_estimate(profile)

    def gpu_price_sort_key(profile: dict[str, Any]) -> tuple[float, str]:
        estimate = profile.get("priceEstimate") or {}
        amount = estimate.get("amountPln")
        price = float(amount) if isinstance(amount, (int, float)) else float("inf")
        return price, str(profile.get("label") or profile.get("id") or "")

    return [*cpu_profiles, *sorted(gpu_profiles, key=gpu_price_sort_key)]


def build_hardware_payload() -> dict[str, Any]:
    # Hardware options include the lowest GPU price and are sorted by it. Warm
    # the catalog before rendering the first list, instead of requiring a later
    # /api/price request for the selected profile to populate the cache.
    try:
        refresh_price_index(PRICE_CURRENCY_CODE)
    except Exception as error:
        logging.warning("Hardware list loaded without pricing catalog: %s", error)

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
    ]

    for accelerator_name, accelerator_zone_list in by_accelerator.items():
        if not accelerator_name.startswith("nvidia-"):
            continue
        spec = GPU_CREATION_PROFILE_SPECS.get(accelerator_name)
        sunshine_compatibility = latest_sunshine_compatibility(accelerator_name, dict(
            SUNSHINE_GPU_COMPATIBILITY.get(
                accelerator_name,
                {
                    "state": "untested",
                    "label": "Not tested",
                    "detail": "This GPU has not yet been validated with the Steam Headless and Sunshine streaming stack.",
                },
            )
        ))
        supported = spec is not None and accelerator_name not in INCOMPATIBLE_SUNSHINE_ACCELERATORS
        if sunshine_compatibility["state"] == "incompatible":
            unavailable_reason = sunshine_compatibility["detail"]
        elif not supported:
            unavailable_reason = (
                "No VM machine profile is configured for this GPU yet. It can be selected, but cannot be created or capacity-scanned."
            )
        else:
            unavailable_reason = ""
        profile_id = str(spec["id"]) if spec else f"catalog-{accelerator_name}"
        label = str(spec["label"]) if spec else gpu_billing_label(accelerator_name)
        profiles.append(
            hardware_profile(
                hardware_id=profile_id,
                label=label,
                machine_type=str(spec["machineType"]) if spec else "",
                gpu_type=accelerator_name,
                gpu_count=1,
                accelerator_mode=str(spec["acceleratorMode"]) if spec else "attached",
                zones=sorted(accelerator_zone_list),
                supported=supported,
                unavailable_reason=unavailable_reason,
                sunshine_compatibility=sunshine_compatibility,
            )
        )

    profiles = sort_hardware_profiles_by_price(profiles)

    return {
        "refreshedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "project": CONFIG["project"],
        "scope": "global-zones",
        "defaultSelection": default_hardware_selection(),
        "zones": zones,
        "accelerators": by_accelerator,
        "profiles": profiles,
    }


def instance_zone_name(instance: dict[str, Any]) -> str:
    return str(instance.get("zone", "") or "").rsplit("/", 1)[-1]


def instance_accelerator_summary(instance: dict[str, Any]) -> tuple[str, int]:
    accelerators = instance_guest_accelerators(instance)
    if not accelerators:
        return "", 0
    accelerator = accelerators[0]
    gpu_type = str(accelerator.get("acceleratorType", "") or "").rsplit("/", 1)[-1]
    try:
        gpu_count = int(accelerator.get("acceleratorCount", 0) or 0)
    except (TypeError, ValueError):
        gpu_count = 0
    return gpu_type, gpu_count


def instance_hardware_selection(instance: dict[str, Any]) -> dict[str, Any]:
    machine_type = instance_machine_type(instance)
    metadata_gpu_type = metadata_value(instance, "vm-gpu-type").strip()
    metadata_count = metadata_gpu_count(instance)
    accelerator_gpu_type, accelerator_gpu_count = instance_accelerator_summary(instance)

    gpu_type = metadata_gpu_type or accelerator_gpu_type
    gpu_count = metadata_count or accelerator_gpu_count
    if machine_type.startswith("g2-") and not gpu_type:
        gpu_type = "nvidia-l4"
        gpu_count = max(gpu_count, 1)

    if not gpu_type or gpu_count <= 0:
        return {
            "id": CPU_HARDWARE_ID,
            "label": "CPU",
            "machineType": machine_type or DEFAULT_CPU_MACHINE_TYPE,
            "gpuType": "",
            "gpuCount": 0,
            "acceleratorMode": "none",
        }

    hardware_id = gpu_type
    base_gpu_type = gpu_type.removesuffix("-vws")
    accelerator_mode = "builtin" if machine_type.startswith("g2-") and not gpu_type.endswith("-vws") else "attached"
    label = "GPU L4" if base_gpu_type == "nvidia-l4" else "GPU T4" if base_gpu_type == "nvidia-tesla-t4" else base_gpu_type
    if gpu_type.endswith("-vws"):
        label += " vWS"
    return {
        "id": hardware_id,
        "label": label,
        "machineType": machine_type,
        "gpuType": gpu_type,
        "gpuCount": gpu_count,
        "acceleratorMode": accelerator_mode,
    }


def build_instance_picker_entry(instance: dict[str, Any]) -> dict[str, Any]:
    zone = instance_zone_name(instance)
    hardware = instance_hardware_selection(instance)
    status = str(instance.get("status", "UNKNOWN") or "UNKNOWN")
    name = str(instance.get("name", "") or CONFIG["instance"])
    return {
        "name": name,
        "zone": zone,
        "targetName": target_instance_name_for(
            hardware_id=str(hardware.get("id", "")),
            gpu_type=str(hardware.get("gpuType", "")),
            gpu_count=int(hardware.get("gpuCount", 0) or 0),
            zone=zone,
        ),
        "status": status,
        "externalIp": extract_external_ip(instance),
        "createdAt": str(instance.get("creationTimestamp", "") or ""),
        "lastStartTimestamp": str(instance.get("lastStartTimestamp", "") or ""),
        "hardware": hardware,
        "sunshineStatus": build_sunshine_status(instance),
        "minecraftStatus": build_minecraft_status(instance),
    }


def list_created_instances() -> list[dict[str, Any]]:
    return sorted(
        [build_instance_picker_entry(instance) for instance in list_managed_compute_instances()],
        key=lambda item: (str(item.get("name", "")), str(item.get("zone", ""))),
    )


def list_managed_compute_instances() -> list[dict[str, Any]]:
    project = require_env("project")
    url = f"https://compute.googleapis.com/compute/v1/projects/{project}/aggregated/instances"
    page_token = ""
    instances: list[dict[str, Any]] = []
    base_names = managed_instance_base_names()
    while True:
        params: dict[str, str] = {}
        if page_token:
            params["pageToken"] = page_token
        data = compute_request("GET", url, params=params)
        if not isinstance(data, dict):
            break
        for scoped_data in (data.get("items", {}) or {}).values():
            if not isinstance(scoped_data, dict):
                continue
            for instance in scoped_data.get("instances", []) or []:
                name = str(instance.get("name", ""))
                if isinstance(instance, dict) and any(
                    name == base_name or name.startswith(f"{base_name}-")
                    for base_name in base_names
                ):
                    instances.append(instance)
        page_token = str(data.get("nextPageToken", "") or "")
        if not page_token:
            break
    return sorted(instances, key=lambda item: (str(item.get("name", "")), instance_zone_name(item)))


def build_instances_payload() -> dict[str, Any]:
    reconcile_endpoint_instance_bindings()
    return {
        "refreshedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "project": CONFIG["project"],
        "instanceName": selected_instance_name(),
        "baseInstanceName": bounded_gce_name(CONFIG["instance"]),
        "managedBaseInstanceNames": managed_instance_base_names(),
        "instances": list_created_instances(),
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
@app.route("/api/healthz", methods=["GET", "OPTIONS"])
@app.route("/api/config", methods=["GET", "OPTIONS"])
@app.route("/api/admin/users", methods=["GET", "POST", "OPTIONS"])
@app.route("/api/admin/sunshine-credentials", methods=["GET", "POST", "OPTIONS"])
@app.route("/api/admin/endpoints", methods=["GET", "POST", "OPTIONS"])
@app.route("/api/admin/runtime-images", methods=["GET", "POST", "OPTIONS"])
@app.route("/api/admin/compatibility", methods=["GET", "POST", "OPTIONS"])
@app.route("/api/admin/software", methods=["GET", "POST", "OPTIONS"])
@app.route("/api/hardware", methods=["GET", "OPTIONS"])
@app.route("/api/instances", methods=["GET", "OPTIONS"])
@app.route("/api/reachability", methods=["GET", "OPTIONS"])
@app.route("/api/price", methods=["GET", "OPTIONS"])
@app.route("/api/minecraft/versions", methods=["GET", "POST", "OPTIONS"])
@app.route("/api/minecraft/management", methods=["GET", "POST", "OPTIONS"])
@app.route("/api/capacity-reservations", methods=["GET", "OPTIONS"])
@app.route("/api/capacity-reservations/probe", methods=["POST", "OPTIONS"])
@app.route("/api/capacity-reservations/scan", methods=["POST", "OPTIONS"])
@app.route("/api/capacity-reservations/scan-zone", methods=["POST", "OPTIONS"])
@app.route("/api/capacity-reservations/release", methods=["POST", "OPTIONS"])
@app.route("/api/internal/capacity-reservations/cleanup", methods=["POST", "OPTIONS"])
@app.route("/api/me", methods=["GET", "OPTIONS"])
@app.route("/api/status", methods=["GET", "OPTIONS"])
@app.route("/api/command", methods=["POST", "OPTIONS"])
def options_passthrough():
    if request.method == "OPTIONS":
        return make_response(("", 204))

    if request.path in {"/healthz", "/api/healthz"}:
        return jsonify({"ok": True})

    if request.path == "/api/config":
        endpoints = reconcile_endpoint_instance_bindings()
        return jsonify(
            {
                "service": "cloud-run-vm-control",
                "googleClientId": CONFIG["google_client_ids"][0] if CONFIG["google_client_ids"] else "",
                "applicationCatalog": APPLICATION_CATALOG,
                "defaultHardware": default_hardware_selection(),
                "adminUrl": "./admin.html",
                "target": {
                    "project": CONFIG["project"],
                    "zone": CONFIG["zone"],
                    "instance": selected_computed_instance_name(),
                    "baseInstance": bounded_gce_name(CONFIG["instance"]),
                },
                "duckdnsDomains": [endpoint["domain"] for endpoint in endpoints],
                "endpoints": [endpoint_public_payload(endpoint) for endpoint in endpoints],
                "ports": {
                    "novnc": CONFIG["novnc_port"],
                    "sunshine": CONFIG["sunshine_port"],
                    "minecraft": CONFIG["minecraft_port"],
                },
                "minecraftServer": minecraft_version_payload(),
            }
        )

    if request.path == "/api/admin/users":
        admin_user = require_admin_user()
        if request.method == "GET":
            return jsonify(build_admin_users_payload(admin_user))
        payload = request.get_json(silent=True) or {}
        action = str(payload.get("action", "")).strip().lower()
        email = validate_email(str(payload.get("email", "")))
        profiles = read_access_user_profiles()
        if action == "add":
            profile = dict(profiles.get(email, {}))
            profile["minecraftManagement"] = bool(payload.get("minecraftManagement", False))
            profile["administrator"] = bool(profile.get("administrator", False))
            profiles[email] = profile
        elif action == "remove":
            if email in admin_google_emails():
                raise ApiError("Administrator accounts cannot be removed from this page.", 400)
            profiles.pop(email, None)
        elif action == "set-minecraft-management":
            if email in admin_google_emails():
                raise ApiError("Administrator accounts always retain Minecraft management access.", 400)
            profile = dict(profiles.get(email, {}))
            profile["minecraftManagement"] = bool(payload.get("minecraftManagement", False))
            profile["administrator"] = bool(profile.get("administrator", False))
            profiles[email] = profile
        elif action == "set-administrator":
            administrator = bool(payload.get("administrator", False))
            if email == normalize_email(str(admin_user.get("email", ""))) and not administrator:
                raise ApiError("You cannot remove your own administrator access.", 400)
            if email in configured_admin_google_emails() and not administrator:
                raise ApiError("Administrator access configured by the service cannot be removed here.", 400)
            profile = dict(profiles.get(email, {}))
            profile["minecraftManagement"] = bool(profile.get("minecraftManagement", False))
            profile["administrator"] = administrator
            profiles[email] = profile
        else:
            raise ApiError("Unsupported admin action.", 400)
        write_access_user_profiles(profiles)
        return jsonify(build_admin_users_payload(admin_user))

    if request.path == "/api/admin/sunshine-credentials":
        admin_user = require_admin_user()
        source = request.args if request.method == "GET" else (request.get_json(silent=True) or {})
        apply_target_overrides(source)
        current_instance = get_instance_or_none()
        if request.method == "GET":
            reveal = str(source.get("reveal", "")).strip().lower() in {"1", "true", "yes"}
            return jsonify(
                build_admin_sunshine_credentials_payload(
                    admin_user=admin_user,
                    instance=current_instance,
                    include_password=reveal,
                )
            )

        if current_instance is None:
            raise ApiError("Instance does not exist. Create it before setting Sunshine credentials.", 400)
        password = parse_sunshine_password(source)
        current_instance, _ = set_sunshine_password(current_instance, password)
        operation = {"state": "stored", "detail": "Password saved in VM metadata."}
        if str(current_instance.get("status", "")).upper() == "RUNNING" and not is_gpu_disabled_for_instance(current_instance):
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
            update_duckdns(extract_external_ip(current_instance))
            operation = {"state": "applied", "detail": "Password applied and Sunshine is ready."}
        elif str(current_instance.get("status", "")).upper() == "RUNNING":
            operation = {"state": "stored", "detail": "Password saved. CPU-only VMs do not run Sunshine."}
        return jsonify(
            build_admin_sunshine_credentials_payload(
                admin_user=admin_user,
                instance=current_instance,
                operation=operation,
            )
        )

    if request.path == "/api/admin/runtime-images":
        admin_user = require_admin_user()
        if request.method == "GET":
            return jsonify(build_admin_runtime_images_payload(admin_user))
        payload = request.get_json(silent=True) or {}
        return jsonify(execute_admin_runtime_image_action(admin_user, payload))

    if request.path == "/api/admin/compatibility":
        admin_user = require_admin_user()
        if request.method == "GET":
            return jsonify(build_admin_compatibility_payload(admin_user))
        payload = request.get_json(silent=True) or {}
        return jsonify(execute_admin_compatibility_action(admin_user, payload))

    if request.path == "/api/admin/software":
        admin_user = require_admin_user()
        source = request.args if request.method == "GET" else (request.get_json(silent=True) or {})
        apply_target_overrides(source)

        if request.method == "POST":
            command = str(source.get("command", "")).strip().lower()
            if command == "refresh-minecraft-versions":
                refresh_minecraft_version_catalogs()
            elif command in {
                "install-app",
                "uninstall-app",
                "install-minecraft",
                "start-minecraft",
                "stop-minecraft",
                "restart-minecraft",
                "remove-minecraft",
            }:
                execute_command(command, admin_user, source)
            else:
                raise ApiError("Unsupported software administration action.", 400)

        instance = get_instance_or_none()
        return jsonify(
            {
                "user": admin_user,
                "endpoint": endpoint_public_payload(selected_endpoint()),
                "status": build_status_payload(instance, user=admin_user, command="status"),
                "applicationCatalog": APPLICATION_CATALOG,
                "minecraftServer": minecraft_version_payload(),
            }
        )

    if request.path == "/api/admin/endpoints":
        admin_user = require_admin_user()
        if request.method == "GET":
            return jsonify(build_admin_endpoints_payload(admin_user))
        payload = request.get_json(silent=True) or {}
        action = str(payload.get("action", "")).strip().lower()
        endpoint_id = normalize_endpoint_id(payload.get("endpointId"))
        records = read_endpoint_records()
        endpoint = next((record for record in records if record["id"] == endpoint_id), None)
        if action == "add":
            if endpoint is not None:
                raise ApiError("Endpoint already exists.", 400)
            domain = normalize_endpoint_domain(payload.get("domain"))
            if any(record["domain"] == domain for record in records):
                raise ApiError("Endpoint DNS already exists.", 400)
            endpoint = normalize_endpoint_record({
                "id": endpoint_id,
                "domain": domain,
                "addressName": f"steam-{endpoint_id}-ip",
            })
            if endpoint is None:
                raise ApiError("Endpoint is invalid.", 400)
            records.append(endpoint)
            write_endpoint_records(records)
        elif endpoint is None:
            raise ApiError("Endpoint does not exist.", 404)
        elif action == "remove":
            if endpoint_instance_or_none(endpoint) is not None:
                raise ApiError("Delete the endpoint VM before removing the endpoint.", 400)
            if endpoint.get("staticIp"):
                raise ApiError("Release the endpoint static IP before removing the endpoint.", 400)
            write_endpoint_records([record for record in records if record["id"] != endpoint_id])
        elif action == "reserve-ip":
            zone = clean_target_text(payload.get("zone"), str(endpoint.get("zone", "") or ""))
            if not zone:
                raise ApiError("Zone is required to reserve an endpoint IP address.", 400)
            apply_target_overrides({"endpointId": endpoint_id, "zone": zone})
            endpoint = ensure_selected_endpoint_static_address()
            update_duckdns(str(endpoint.get("staticIp", "") or ""))
        elif action == "release-ip":
            release_endpoint_static_address(endpoint)
        else:
            raise ApiError("Unsupported endpoint action.", 400)
        return jsonify(build_admin_endpoints_payload(admin_user))

    if request.path == "/api/hardware":
        require_user()
        return jsonify(build_hardware_payload())

    if request.path == "/api/instances":
        require_user()
        return jsonify(build_instances_payload())

    if request.path == "/api/reachability":
        require_user()
        endpoint_id = normalize_endpoint_id(request.args.get("endpointId", ""))
        return jsonify(build_live_access_reachability_payload(endpoint_by_id(endpoint_id)))

    if request.path == "/api/price":
        require_user()
        apply_target_overrides(request.args, respect_existing_endpoint_hardware=False)
        instance = get_instance_or_none()
        persistent_disks, disk_source = persistent_disks_for_price(instance)
        return jsonify(
            {
                "hardware": {
                    "id": selected_hardware_id(),
                    "zone": selected_zone(),
                    "machineType": selected_machine_type(),
                    "gpuType": selected_gpu_type(),
                    "gpuCount": selected_gpu_count(),
                    "acceleratorMode": selected_accelerator_mode(),
                },
                "priceEstimate": safe_price_estimate(
                    machine_type=selected_machine_type(),
                    gpu_type=selected_gpu_type(),
                    gpu_count=selected_gpu_count(),
                    zone=selected_zone(),
                    allow_fetch=True,
                    persistent_disks=persistent_disks,
                    disk_source=disk_source,
                ),
            }
        )

    if request.path == "/api/minecraft/versions":
        if request.method == "POST":
            require_admin_user()
            return jsonify(refresh_minecraft_version_catalogs())
        require_user()
        return jsonify(minecraft_version_payload())

    if request.path == "/api/minecraft/management":
        user = require_minecraft_manager_user()
        if request.method == "GET":
            apply_target_overrides(request.args)
            return jsonify(build_minecraft_management_payload(get_instance_or_none(), user))
        payload = request.get_json(silent=True) or {}
        apply_target_overrides(payload)
        return jsonify(execute_minecraft_management_action(get_instance_or_none(), user, payload))

    if request.path == "/api/capacity-reservations":
        require_user()
        return jsonify(managed_capacity_reservation_summary())

    if request.path == "/api/capacity-reservations/probe":
        require_admin_user()
        payload = request.get_json(silent=True) or {}
        apply_target_overrides(payload, respect_existing_endpoint_hardware=False)
        return jsonify(create_capacity_reservation_probe())

    if request.path == "/api/capacity-reservations/scan":
        require_admin_user()
        payload = request.get_json(silent=True) or {}
        return jsonify(scan_gpu_capacity_availability(payload))

    if request.path == "/api/capacity-reservations/scan-zone":
        require_admin_user()
        payload = request.get_json(silent=True) or {}
        return jsonify(scan_gpu_capacity_zone(payload))

    if request.path == "/api/capacity-reservations/release":
        require_admin_user()
        return jsonify(release_managed_capacity_reservations())

    if request.path == "/api/internal/capacity-reservations/cleanup":
        require_capacity_cleanup_token()
        result = release_managed_capacity_reservations(expired_only=True)
        if result["failed"]:
            raise ApiError("Failed to release one or more expired GPU capacity reservations.", 502)
        return jsonify(result)

    if request.path == "/api/me":
        user = require_user()
        return jsonify({"user": user, "session": create_session_token(user)})

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
        if command == "set-sunshine-password":
            raise ApiError("Manage Sunshine passwords from the administrator panel.", 403)
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
            "set-auto-stop",
            "install-app",
            "uninstall-app",
            "install-minecraft",
            "start-minecraft",
            "stop-minecraft",
            "restart-minecraft",
            "remove-minecraft",
        }:
            raise ApiError("Unsupported command.", 400)
        if command in {
            "start",
            "stop",
            "restart",
            "create",
            "delete",
            "create-backup",
            "restore-backup",
            "remove-backup",
            "set-auto-stop",
            "install-app",
            "uninstall-app",
            "install-minecraft",
            "start-minecraft",
            "stop-minecraft",
            "restart-minecraft",
            "remove-minecraft",
        }:
            user = require_admin_user()
        result = execute_command(command, user, payload)
        return jsonify(result)

    raise ApiError("Not found.", 404)


def bearer_token() -> str:
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise ApiError("Missing authentication token.", 401)

    token = auth_header.removeprefix("Bearer ").strip()
    if not token:
        raise ApiError("Missing authentication token.", 401)
    return token


def session_signing_secret() -> bytes:
    secret = str(CONFIG["session_token_secret"] or "").strip()
    if len(secret) < 32:
        raise ApiError("Service is missing VM_CONTROL_SESSION_SECRET configuration.", 500)
    return secret.encode("utf-8")


def base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def base64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(f"{value}{'=' * (-len(value) % 4)}")


def create_session_token(user: dict[str, Any]) -> dict[str, Any]:
    now = int(time.time())
    expires_at = now + SESSION_TOKEN_TTL_SECONDS
    payload = {
        "email": normalize_email(str(user.get("email", ""))),
        "name": str(user.get("name", "")),
        "picture": str(user.get("picture", "")),
        "sub": str(user.get("sub", "")),
        "hd": normalize_email(str(user.get("hd", ""))),
        "iat": now,
        "exp": expires_at,
    }
    if not payload["email"]:
        raise ApiError("Cannot create a session without an email address.", 401)
    encoded_payload = base64url_encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signed_data = f"{SESSION_TOKEN_PREFIX}.{encoded_payload}".encode("ascii")
    signature = base64url_encode(hmac.new(session_signing_secret(), signed_data, hashlib.sha256).digest())
    return {
        "token": f"{SESSION_TOKEN_PREFIX}.{encoded_payload}.{signature}",
        "expiresAt": expires_at,
        "expiresInSeconds": SESSION_TOKEN_TTL_SECONDS,
    }


def authenticated_session_user(token: str) -> dict[str, Any]:
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != SESSION_TOKEN_PREFIX:
        raise ApiError("Invalid VM Control session.", 401)
    _, encoded_payload, encoded_signature = parts
    signed_data = f"{SESSION_TOKEN_PREFIX}.{encoded_payload}".encode("ascii")
    expected_signature = hmac.new(session_signing_secret(), signed_data, hashlib.sha256).digest()
    try:
        supplied_signature = base64url_decode(encoded_signature)
        payload = json.loads(base64url_decode(encoded_payload).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        raise ApiError("Invalid VM Control session.", 401) from None
    if not hmac.compare_digest(supplied_signature, expected_signature) or not isinstance(payload, dict):
        raise ApiError("Invalid VM Control session.", 401)
    try:
        expires_at = int(payload.get("exp", 0))
    except (TypeError, ValueError):
        expires_at = 0
    if expires_at <= int(time.time()):
        raise ApiError("VM Control session has expired. Sign in with Google again.", 401)
    email = normalize_email(str(payload.get("email", "")))
    if not email:
        raise ApiError("Invalid VM Control session.", 401)
    return {
        "email": email,
        "name": str(payload.get("name", "")),
        "picture": str(payload.get("picture", "")),
        "sub": str(payload.get("sub", "")),
        "hd": normalize_email(str(payload.get("hd", ""))),
        "email_domain": email.split("@", 1)[1] if "@" in email else "",
    }


def authenticated_google_user(token: str | None = None) -> dict[str, Any]:
    token = token or bearer_token()

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

    return {
        "email": email,
        "name": info.get("name", ""),
        "picture": info.get("picture", ""),
        "sub": info.get("sub", ""),
        "hd": hd,
        "email_domain": email_domain,
    }


def authenticated_user() -> dict[str, Any]:
    token = bearer_token()
    if token.startswith(f"{SESSION_TOKEN_PREFIX}."):
        return authenticated_session_user(token)
    return authenticated_google_user(token)


def user_response(user: dict[str, Any]) -> dict[str, Any]:
    email = normalize_email(str(user.get("email", "")))
    return {
        "email": email,
        "name": user.get("name", ""),
        "picture": user.get("picture", ""),
        "sub": user.get("sub", ""),
        "hd": user.get("hd", ""),
        "isAdmin": email in admin_google_emails(),
    }


def require_user() -> dict[str, Any]:
    user = authenticated_user()
    email = normalize_email(str(user.get("email", "")))
    hd = normalize_email(str(user.get("hd", "")))
    email_domain = normalize_email(str(user.get("email_domain", "")))
    allowed_emails = all_direct_allowed_emails()
    allowed_domains = CONFIG["allowed_google_domains"]
    if allowed_emails or allowed_domains:
        allowed = (
            email in allowed_emails
            or (hd and hd in allowed_domains)
            or (email_domain and email_domain in allowed_domains)
        )
        if not allowed:
            raise ApiError(f"Google account {email} is not allowed.", 403)

    return user_response(user)


def require_admin_user() -> dict[str, Any]:
    user = authenticated_user()
    email = normalize_email(str(user.get("email", "")))
    if email not in admin_google_emails():
        raise ApiError(f"Google account {email} is not an administrator.", 403)
    return user_response(user)


def user_can_manage_minecraft(user: dict[str, Any]) -> bool:
    email = normalize_email(str(user.get("email", "")))
    if not email:
        return False
    if email in admin_google_emails():
        return True
    profile = read_access_user_profiles().get(email, {})
    return bool(profile.get("minecraftManagement", False))


def require_minecraft_manager_user() -> dict[str, Any]:
    user = require_user()
    if not user_can_manage_minecraft(user):
        raise ApiError(
            f"Google account {user.get('email', '')} does not have Minecraft management access.",
            403,
        )
    return user


def build_admin_users_payload(admin_user: dict[str, Any]) -> dict[str, Any]:
    managed_profiles = read_access_user_profiles()
    managed_users = set(managed_profiles)
    admin_emails = admin_google_emails()
    configured_admin_emails = configured_admin_google_emails()
    current_admin_email = normalize_email(str(admin_user.get("email", "")))
    configured_users = configured_allowed_emails() - admin_emails
    accounts: dict[str, dict[str, Any]] = {}
    for email in admin_emails:
        accounts[email] = {
            "email": email,
            "source": "administrator",
            "minecraftManagement": True,
            "minecraftManagementLocked": True,
            "administrator": True,
            "administratorLocked": email in configured_admin_emails or email == current_admin_email,
            "removable": False,
        }
    for email in configured_users:
        profile = managed_profiles.get(email, {})
        accounts[email] = {
            "email": email,
            "source": "configured env",
            "minecraftManagement": bool(profile.get("minecraftManagement", False)),
            "minecraftManagementLocked": False,
            "administrator": False,
            "administratorLocked": False,
            "removable": False,
        }
    for email, profile in managed_profiles.items():
        if email in accounts:
            continue
        accounts[email] = {
            "email": email,
            "source": "managed",
            "minecraftManagement": bool(profile.get("minecraftManagement", False)),
            "minecraftManagementLocked": False,
            "administrator": False,
            "administratorLocked": False,
            "removable": True,
        }
    return {
        "user": admin_user,
        "adminEmails": sorted(admin_emails),
        "configuredEmails": sorted(configured_users),
        "configuredDomains": sorted(CONFIG["allowed_google_domains"]),
        "managedUsers": sorted(managed_users),
        "managedUserPermissions": {
            email: bool(profile.get("minecraftManagement", False))
            for email, profile in sorted(managed_profiles.items())
        },
        "managedUserAdministratorPermissions": {
            email: bool(profile.get("administrator", False))
            for email, profile in sorted(managed_profiles.items())
        },
        "accounts": [accounts[email] for email in sorted(accounts)],
        "effectiveDirectEmails": sorted(configured_users | admin_emails | managed_users),
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
    response = None
    last_error: requests.RequestException | None = None
    for attempt in range(1, 4):
        try:
            candidate = compute_session().request(method=method, url=url, timeout=30, **kwargs)
        except requests.RequestException as error:
            last_error = error
            if attempt < 3:
                time.sleep(attempt)
                continue
            break
        if candidate.status_code in {429, 500, 502, 503, 504} and attempt < 3:
            time.sleep(attempt)
            continue
        response = candidate
        break
    if response is None:
        detail = str(last_error) if last_error else "transient Compute API failure"
        raise ApiError(f"Compute API request failed after retry: {detail}", 502)
    if response.status_code == 404:
        if allow_404:
            return None
        raise ApiError(
            f"Compute resource was not found in project {CONFIG['project']}.",
            404,
        )
    if response.status_code >= 400:
        raise ApiError(response.text or f"Compute API returned {response.status_code}.", 502)
    return response.json()


def require_capacity_cleanup_token() -> None:
    expected = str(CONFIG["capacity_cleanup_token"] or "")
    provided = request.headers.get("X-Capacity-Cleanup-Token", "")
    if not expected or not hmac.compare_digest(provided, expected):
        raise ApiError("Invalid capacity reservation cleanup token.", 403)


def wait_for_zone_operation(operation: dict[str, Any], timeout_seconds: int = 90, zone: str | None = None) -> None:
    operation_name = str(operation.get("name", "") or "")
    if not operation_name:
        return
    operation_zone = zone or str(operation.get("zone", "") or "").rsplit("/", 1)[-1] or selected_zone()

    url = (
        "https://compute.googleapis.com/compute/v1/"
        f"projects/{CONFIG['project']}/zones/{operation_zone}/operations/{operation_name}"
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


def capacity_reservation_name() -> str:
    if selected_gpu_count() <= 0 or not selected_gpu_type():
        raise ApiError("GPU capacity checks require a selected GPU hardware profile.", 400)
    return bounded_gce_name(
        f"{CONFIG['instance']}-capacity-"
        f"{hardware_name_slug(selected_hardware_id(), selected_gpu_type(), selected_gpu_count())}-"
        f"{selected_zone()}"
    )


def is_managed_capacity_reservation(reservation: dict[str, Any]) -> bool:
    return str(reservation.get("description", "") or "").startswith(CAPACITY_RESERVATION_DESCRIPTION_PREFIX)


def capacity_reservation_zone(reservation: dict[str, Any]) -> str:
    return str(reservation.get("zone", "") or "").rsplit("/", 1)[-1]


def list_managed_capacity_reservations() -> list[dict[str, Any]]:
    data = compute_request("GET", capacity_reservations_aggregated_url()) or {}
    managed: list[dict[str, Any]] = []
    for scoped_list in (data.get("items", {}) or {}).values():
        if not isinstance(scoped_list, dict):
            continue
        for reservation in scoped_list.get("reservations", []) or []:
            if isinstance(reservation, dict) and is_managed_capacity_reservation(reservation):
                managed.append(reservation)
    return managed


def reservation_gpu_count(reservation: dict[str, Any]) -> int:
    specific_reservation = reservation.get("specificReservation", {}) or {}
    if not isinstance(specific_reservation, dict):
        return 0
    try:
        instance_count = max(0, int(specific_reservation.get("count", 0) or 0))
    except (TypeError, ValueError):
        return 0
    properties = specific_reservation.get("instanceProperties", {}) or {}
    if not isinstance(properties, dict):
        return 0
    gpu_per_instance = 0
    for accelerator in properties.get("guestAccelerators", []) or []:
        if not isinstance(accelerator, dict):
            continue
        try:
            gpu_per_instance += max(0, int(accelerator.get("acceleratorCount", 0) or 0))
        except (TypeError, ValueError):
            continue
    if gpu_per_instance == 0 and str(properties.get("machineType", "") or "").startswith("g2-"):
        gpu_per_instance = 1
    return instance_count * gpu_per_instance


def managed_capacity_reservation_summary() -> dict[str, int]:
    reservations = list_managed_capacity_reservations()
    return {
        "managedReservationCount": len(reservations),
        "reservedGpuCount": sum(reservation_gpu_count(reservation) for reservation in reservations),
    }


def reservation_has_expired(reservation: dict[str, Any]) -> bool:
    expires_at = parse_datetime_utc(str(reservation.get("deleteAtTime", "") or ""))
    return expires_at is not None and expires_at <= datetime.now(timezone.utc)


def delete_capacity_reservation(reservation: dict[str, Any]) -> None:
    name = str(reservation.get("name", "") or "")
    zone = capacity_reservation_zone(reservation)
    if not name or not zone:
        raise ApiError("Managed GPU capacity reservation is missing its name or zone.", 502)
    operation = compute_request("DELETE", capacity_reservation_url(zone, name), allow_404=True)
    if operation:
        wait_for_zone_operation(operation, timeout_seconds=90, zone=zone)


def release_managed_capacity_reservations(*, expired_only: bool = False) -> dict[str, Any]:
    released: list[str] = []
    failed: list[dict[str, str]] = []
    reservations = list_managed_capacity_reservations()
    for reservation in reservations:
        if expired_only and not reservation_has_expired(reservation):
            continue
        name = str(reservation.get("name", "") or "unknown")
        try:
            delete_capacity_reservation(reservation)
            released.append(name)
        except ApiError as error:
            logging.warning("Failed to release capacity reservation %s: %s", name, error.message)
            failed.append({"name": name, "error": error.message})
    return {
        "released": released,
        "failed": failed,
        "managedCount": len(reservations),
        "expiredOnly": expired_only,
    }


def create_capacity_reservation_probe() -> dict[str, Any]:
    if selected_gpu_count() <= 0:
        raise ApiError("GPU capacity checks require a selected GPU hardware profile.", 400)

    name = capacity_reservation_name()
    zone = selected_zone()
    existing = compute_request("GET", capacity_reservation_url(zone, name), allow_404=True)
    if isinstance(existing, dict):
        if int(existing.get("specificReservation", {}).get("inUseCount", 0) or 0) > 0:
            return {
                "available": True,
                "reservation": {
                    "name": name,
                    "zone": zone,
                    "expiresAt": existing.get("deleteAtTime", ""),
                    "state": "consumed",
                },
                "message": "The selected VM already consumes the matching GPU capacity reservation.",
            }
        delete_capacity_reservation(existing)

    expires_at = datetime.now(timezone.utc) + timedelta(seconds=CAPACITY_RESERVATION_TTL_SECONDS)
    instance_properties: dict[str, Any] = {"machineType": selected_machine_type()}
    if selected_accelerator_mode() == "attached":
        instance_properties["guestAccelerators"] = [
            {
                "acceleratorType": selected_gpu_type(),
                "acceleratorCount": selected_gpu_count(),
            }
        ]
    operation = compute_request(
        "POST",
        capacity_reservations_collection_url(zone),
        json={
            "name": name,
            "description": f"{CAPACITY_RESERVATION_DESCRIPTION_PREFIX}; expires at {format_datetime_utc(expires_at)}",
            "specificReservationRequired": False,
            "deleteAtTime": format_datetime_utc(expires_at),
            "specificReservation": {
                "count": "1",
                "instanceProperties": instance_properties,
            },
        },
    )
    if not isinstance(operation, dict):
        raise ApiError("Failed to create the GPU capacity reservation.", 502)
    wait_for_zone_operation(operation, timeout_seconds=120, zone=zone)
    return {
        "available": True,
        "reservation": {
            "name": name,
            "zone": zone,
            "expiresAt": format_datetime_utc(expires_at),
            "state": "reserved",
        },
        "message": f"GPU capacity is reserved for up to {CAPACITY_RESERVATION_TTL_SECONDS // 60} minutes.",
    }


def gpu_hardware_profile(hardware_id: str) -> dict[str, Any]:
    normalized_id = str(hardware_id or "").strip()
    for profile in build_hardware_payload().get("profiles", []):
        if str(profile.get("id", "")) == normalized_id:
            if int(profile.get("gpuCount", 0) or 0) <= 0 or not str(profile.get("gpuType", "")).strip():
                raise ApiError("GPU capacity scans require a selected GPU hardware profile.", 400)
            if not bool(profile.get("supported", True)):
                raise ApiError(str(profile.get("unavailableReason") or "This GPU is not supported by the current VM stack."), 400)
            return profile
    raise ApiError("The selected GPU hardware profile is no longer available.", 400)


def scan_capacity_reservation_name(profile: dict[str, Any], zone: str, token: str) -> str:
    return bounded_gce_name(
        f"{CONFIG['instance']}-capacity-scan-"
        f"{hardware_name_slug(str(profile['id']), str(profile['gpuType']), int(profile['gpuCount']))}-"
        f"{zone}-{token}"
    )


def scan_capacity_instance_properties(profile: dict[str, Any]) -> dict[str, Any]:
    instance_properties: dict[str, Any] = {"machineType": str(profile["machineType"])}
    if str(profile.get("acceleratorMode", "attached")) == "attached":
        instance_properties["guestAccelerators"] = [
            {
                "acceleratorType": str(profile["gpuType"]),
                "acceleratorCount": int(profile["gpuCount"]),
            }
        ]
    return instance_properties


def probe_gpu_capacity_zone(profile: dict[str, Any], zone: str, token: str) -> dict[str, Any]:
    reservation = {
        "name": scan_capacity_reservation_name(profile, zone, token),
        "zone": zone,
    }
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=CAPACITY_RESERVATION_TTL_SECONDS)
    created = False
    available = False
    error_message = ""
    cleanup_failure = ""
    try:
        operation = compute_request(
            "POST",
            capacity_reservations_collection_url(zone),
            json={
                "name": reservation["name"],
                "description": (
                    f"{CAPACITY_RESERVATION_DESCRIPTION_PREFIX}; availability scan; "
                    f"expires at {format_datetime_utc(expires_at)}"
                ),
                "specificReservationRequired": False,
                "deleteAtTime": format_datetime_utc(expires_at),
                "specificReservation": {
                    "count": "1",
                    "instanceProperties": scan_capacity_instance_properties(profile),
                },
            },
        )
        if not isinstance(operation, dict):
            raise ApiError("Failed to create the GPU capacity scan reservation.", 502)
        wait_for_zone_operation(operation, timeout_seconds=120, zone=zone)
        created = True
        available = True
    except ApiError as error:
        error_message = error.message
    finally:
        if created:
            try:
                delete_capacity_reservation(reservation)
            except ApiError as error:
                logging.warning(
                    "Failed to release GPU capacity scan reservation %s: %s",
                    reservation["name"],
                    error.message,
                )
                cleanup_failure = error.message

    return {
        "zone": zone,
        "available": available,
        "error": error_message,
        "releasedReservation": created and not cleanup_failure,
        "cleanupFailure": cleanup_failure,
    }


def scan_gpu_capacity_zone(payload: dict[str, Any]) -> dict[str, Any]:
    profile = gpu_hardware_profile(str(payload.get("hardwareId", "")))
    zone = str(payload.get("zone", "")).strip()
    if not zone:
        raise ApiError("GPU capacity scans require a zone.", 400)
    if zone not in {str(item) for item in profile.get("zones", [])}:
        raise ApiError("The selected zone is not compatible with this GPU profile.", 400)
    result = probe_gpu_capacity_zone(profile, zone, secrets.token_hex(4))
    result["hardwareId"] = str(profile["id"])
    return result


def scan_gpu_capacity_availability(payload: dict[str, Any]) -> dict[str, Any]:
    profile = gpu_hardware_profile(str(payload.get("hardwareId", "")))
    zones = [str(zone) for zone in profile.get("zones", []) if str(zone).strip()]
    requested_zones = payload.get("zones")
    if requested_zones is not None:
        if not isinstance(requested_zones, list):
            raise ApiError("GPU capacity scan zones must be a list.", 400)
        allowed_zones = set(zones)
        zones = list(dict.fromkeys(str(zone).strip() for zone in requested_zones if str(zone).strip()))
        unsupported_zones = [zone for zone in zones if zone not in allowed_zones]
        if unsupported_zones:
            raise ApiError("The GPU capacity scan contains incompatible zones.", 400)
    if not zones:
        raise ApiError("No compatible zones are available for the selected GPU profile.", 400)

    token = secrets.token_hex(4)
    available_zones: list[str] = []
    unavailable_zones: list[dict[str, str]] = []
    cleanup_failures: list[dict[str, str]] = []
    released_reservation_count = 0
    for zone in zones:
        result = probe_gpu_capacity_zone(profile, zone, token)
        if result["available"]:
            available_zones.append(zone)
        else:
            unavailable_zones.append({"zone": zone, "error": str(result["error"])})
        if result["releasedReservation"]:
            released_reservation_count += 1
        if result["cleanupFailure"]:
            cleanup_failures.append({"zone": zone, "error": str(result["cleanupFailure"])})

    return {
        "hardwareId": str(profile["id"]),
        "checkedZoneCount": len(zones),
        "availableZones": available_zones,
        "unavailableZones": unavailable_zones,
        "releasedReservationCount": released_reservation_count,
        "cleanupFailures": cleanup_failures,
    }


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


def instance_self_url(instance: dict[str, Any]) -> str:
    self_link = str(instance.get("selfLink", "") or "")
    if self_link:
        return self_link
    zone = instance_zone_name(instance) or selected_zone()
    name = str(instance.get("name", "") or selected_instance_name())
    return explicit_instance_url(zone, name)


def extract_external_ip(instance: dict[str, Any]) -> str:
    network_interfaces = instance.get("networkInterfaces", []) or []
    if not network_interfaces:
        return ""
    access_configs = network_interfaces[0].get("accessConfigs", []) or []
    if not access_configs:
        return ""
    return str(access_configs[0].get("natIP", "") or "")


def remove_instance_external_access_config(instance: dict[str, Any]) -> dict[str, Any]:
    network_interfaces = instance.get("networkInterfaces", []) or []
    if not network_interfaces:
        return instance
    network_interface = network_interfaces[0] if isinstance(network_interfaces[0], dict) else {}
    access_configs = network_interface.get("accessConfigs", []) or []
    if not access_configs:
        return instance
    access_config = access_configs[0] if isinstance(access_configs[0], dict) else {}
    operation = compute_request(
        "POST",
        f"{instance_self_url(instance)}/deleteAccessConfig",
        params={
            "networkInterface": str(network_interface.get("name", "nic0") or "nic0"),
            "accessConfig": str(access_config.get("name", "External NAT") or "External NAT"),
        },
    )
    if not isinstance(operation, dict):
        raise ApiError("Failed to detach the automatic external IP address.", 502)
    wait_for_zone_operation(operation, timeout_seconds=180, zone=instance_zone_name(instance))
    return get_instance()


def ensure_instance_external_access_config(instance: dict[str, Any]) -> dict[str, Any]:
    network_interfaces = instance.get("networkInterfaces", []) or []
    if not network_interfaces:
        raise ApiError("VM is missing a network interface.", 502)
    network_interface = network_interfaces[0] if isinstance(network_interfaces[0], dict) else {}
    if network_interface.get("accessConfigs", []) or []:
        return instance
    access_config: dict[str, str] = {"name": "External NAT", "type": "ONE_TO_ONE_NAT"}
    endpoint = selected_endpoint()
    if endpoint_has_manual_static_ip(endpoint):
        access_config["natIP"] = str(endpoint.get("staticIp", ""))
    operation = compute_request(
        "POST",
        f"{instance_self_url(instance)}/addAccessConfig",
        params={"networkInterface": str(network_interface.get("name", "nic0") or "nic0")},
        json=access_config,
    )
    if not isinstance(operation, dict):
        raise ApiError("Failed to add an external IP access configuration.", 502)
    wait_for_zone_operation(operation, timeout_seconds=180, zone=instance_zone_name(instance))
    return get_instance()


def release_selected_endpoint_ephemeral_ip(instance: dict[str, Any]) -> dict[str, Any]:
    endpoint = selected_endpoint()
    static_ip = str(endpoint.get("staticIp", "") or "")
    if static_ip and not endpoint_has_manual_static_ip(endpoint):
        instance = remove_instance_external_access_config(instance)
        release_endpoint_static_address(endpoint, preserve_instance_binding=True)
        endpoint = selected_endpoint()
    endpoint["externalIp"] = ""
    return persist_endpoint(endpoint) and instance


def instance_machine_type(instance: dict[str, Any]) -> str:
    return str(instance.get("machineType", "") or "").rsplit("/", 1)[-1]


def instance_guest_accelerators(instance: dict[str, Any]) -> list[dict[str, Any]]:
    accelerators = instance.get("guestAccelerators", []) or []
    return [accelerator for accelerator in accelerators if isinstance(accelerator, dict)]


def metadata_gpu_count(instance: dict[str, Any]) -> int:
    raw = metadata_value(instance, GPU_COUNT_METADATA_KEY).strip()
    if not raw:
        return 0
    try:
        return int(raw)
    except ValueError:
        return 0


def attached_accelerator_matches(instance: dict[str, Any], gpu_type: str, gpu_count: int) -> bool:
    accelerators = instance_guest_accelerators(instance)
    if gpu_count <= 0:
        return not accelerators
    if len(accelerators) != 1:
        return False
    accelerator = accelerators[0]
    actual_type = str(accelerator.get("acceleratorType", "") or "").rsplit("/", 1)[-1]
    try:
        actual_count = int(accelerator.get("acceleratorCount", 0) or 0)
    except (TypeError, ValueError):
        actual_count = 0
    return actual_type == gpu_type and actual_count == gpu_count


def instance_hardware_matches_selection(instance: dict[str, Any]) -> bool:
    actual = instance_hardware_selection(instance)
    try:
        actual_gpu_count = int(actual.get("gpuCount", 0) or 0)
    except (TypeError, ValueError):
        actual_gpu_count = 0
    return (
        str(actual.get("machineType", "")) == selected_machine_type()
        and str(actual.get("gpuType", "")) == selected_gpu_type()
        and actual_gpu_count == selected_gpu_count()
        and str(actual.get("acceleratorMode", "")) == selected_accelerator_mode()
    )


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
    current_instance = instance
    update_keys = set(updates)
    last_error: ApiError | None = None
    for attempt in range(5):
        metadata = current_instance.get("metadata", {}) or {}
        fingerprint = str(metadata.get("fingerprint", "") or "")
        if not fingerprint:
            raise ApiError("Instance metadata fingerprint is missing.", 502)
        items = [item for item in instance_metadata_items(current_instance) if item.get("key") not in update_keys]
        for key, value in updates.items():
            if value is not None:
                items.append({"key": key, "value": value})
        try:
            operation = compute_request(
                "POST",
                f"{instance_self_url(current_instance)}/setMetadata",
                json={"fingerprint": fingerprint, "items": items},
            )
            wait_for_zone_operation(operation, zone=instance_zone_name(current_instance))
            return
        except ApiError as error:
            if "CONDITION_NOT_MET" not in str(error) or attempt == 4:
                raise
            last_error = error
            time.sleep(0.4 * (attempt + 1))
            refreshed = compute_request("GET", instance_self_url(current_instance))
            if not isinstance(refreshed, dict):
                raise last_error
            current_instance = refreshed
    raise last_error or ApiError("Unable to update instance metadata.", 502)


def set_instance_metadata_value(instance: dict[str, Any], key: str, value: str | None) -> None:
    set_instance_metadata_values(instance, {key: value})


def minecraft_management_agent_ready(instance: dict[str, Any] | None) -> bool:
    return bool(
        instance
        and metadata_value(instance, MINECRAFT_MANAGEMENT_AGENT_METADATA_KEY).strip().lower() == "ready"
    )


def prepare_minecraft_management_agent(instance: dict[str, Any]) -> None:
    if not str(CONFIG["vm_minecraft_management_script_b64"] or "").strip():
        raise ApiError("Minecraft management agent script is not configured.", 500)
    set_instance_metadata_values(
        instance,
        {
            "startup-script": decode_config_b64("vm_startup_script_b64"),
            "vm-minecraft-management-script": decode_config_b64("vm_minecraft_management_script_b64"),
            MINECRAFT_MANAGEMENT_AGENT_METADATA_KEY: "pending-restart",
        },
    )


def wait_for_instance_metadata_fingerprint() -> dict[str, Any]:
    return get_instance()


def set_instance_machine_type_if_needed(instance: dict[str, Any]) -> dict[str, Any]:
    if instance_machine_type(instance) == selected_machine_type():
        return instance
    operation = compute_request(
        "POST",
        f"{instance_url()}/setMachineType",
        json={"machineType": machine_type_path()},
    )
    if not isinstance(operation, dict):
        raise ApiError("Failed to update VM machine type.", 502)
    wait_for_zone_operation(operation, timeout_seconds=180)
    return get_instance()


def set_instance_accelerators_if_needed(instance: dict[str, Any]) -> dict[str, Any]:
    if selected_accelerator_mode() != "attached":
        desired_accelerators: list[dict[str, Any]] = []
    else:
        desired_accelerators = [
            {
                "acceleratorType": accelerator_type_path(),
                "acceleratorCount": selected_gpu_count(),
            }
        ]

    if selected_accelerator_mode() == "attached":
        if attached_accelerator_matches(instance, selected_gpu_type(), selected_gpu_count()):
            return instance
    elif attached_accelerator_matches(instance, "", 0):
        return instance

    operation = compute_request(
        "POST",
        f"{instance_url()}/setMachineResources",
        json={"guestAccelerators": desired_accelerators},
    )
    if not isinstance(operation, dict):
        raise ApiError("Failed to update VM accelerators.", 502)
    wait_for_zone_operation(operation, timeout_seconds=180)
    return get_instance()


def set_instance_scheduling_for_selected_hardware(instance: dict[str, Any]) -> dict[str, Any]:
    operation = compute_request(
        "POST",
        f"{instance_url()}/setScheduling",
        json={
            "onHostMaintenance": "TERMINATE",
            "automaticRestart": True,
        },
    )
    if isinstance(operation, dict):
        wait_for_zone_operation(operation, timeout_seconds=120)
    return get_instance()


def start_metadata_updates(
    *,
    auto_stop_hours: int | None,
    sunshine_credentials: dict[str, str],
) -> dict[str, str | None]:
    return {
        "startup-script": decode_config_b64("vm_startup_script_b64"),
        "shutdown-script": decode_config_b64("vm_shutdown_script_b64"),
        "vm-persist-script": decode_config_b64("vm_persist_script_b64"),
        "vm-power-action-script": decode_config_b64("vm_power_action_script_b64"),
        "vm-data-disk-device-name": data_disk_device_name(),
        "vm-data-disk-mount-root": CONFIG["data_disk_mount_root"],
        "vm-sunshine-csrf-allowed-origins": (
            ",".join(
                f"https://{domain}:{CONFIG['sunshine_port']}"
                for domain in selected_endpoint_domains()
            )
            or None
        ),
        GPU_COUNT_METADATA_KEY: str(selected_gpu_count()),
        "vm-gpu-type": selected_gpu_type(),
        STEAM_ENV_METADATA_KEY: build_steam_env_value(
            {
                "SUNSHINE_USER": sunshine_credentials["username"],
                "SUNSHINE_PASS": sunshine_credentials["password"],
            }
        ),
        AUTO_STOP_METADATA_KEY: str(auto_stop_hours) if auto_stop_hours is not None else None,
        AUTO_STOP_AT_METADATA_KEY: None,
        POWER_ACTION_METADATA_KEY: None,
        POWER_ACTION_STATUS_METADATA_KEY: None,
        SUNSHINE_STATUS_METADATA_KEY: "starting" if selected_gpu_count() > 0 else "disabled",
        SUNSHINE_STATUS_DETAIL_METADATA_KEY: (
            "VM booting. Waiting for Sunshine Web UI."
            if selected_gpu_count() > 0
            else "GPU disabled for this VM; Sunshine stack was not started."
        ),
    }


def reconcile_stopped_instance_hardware(instance: dict[str, Any]) -> dict[str, Any]:
    if instance_hardware_matches_selection(instance):
        return instance
    if str(instance.get("status", "")).upper() != "TERMINATED":
        raise ApiError("Hardware profile can only be changed while the VM is stopped.", 400)

    set_instance_metadata_values(
        instance,
        {
            SUNSHINE_STATUS_METADATA_KEY: "starting" if selected_gpu_count() > 0 else "disabled",
            SUNSHINE_STATUS_DETAIL_METADATA_KEY: (
                f"Reconfiguring VM hardware to {selected_hardware_id()} before start."
            ),
        },
    )
    instance = get_instance()

    if selected_accelerator_mode() in {"none", "builtin"}:
        instance = set_instance_accelerators_if_needed(instance)
        instance = set_instance_machine_type_if_needed(instance)
    else:
        instance = set_instance_machine_type_if_needed(instance)
        instance = set_instance_accelerators_if_needed(instance)

    return set_instance_scheduling_for_selected_hardware(instance)


def ensure_instance_virtual_display(instance: dict[str, Any]) -> dict[str, Any]:
    display_device = instance.get("displayDevice", {}) or {}
    if isinstance(display_device, dict) and bool(display_device.get("enableDisplay")):
        return instance
    if str(instance.get("status", "")).upper() != "TERMINATED":
        raise ApiError("The VM virtual display can only be enabled while the VM is stopped.", 400)

    operation = compute_request(
        "POST",
        f"{instance_self_url(instance)}/updateDisplayDevice",
        json={"enableDisplay": True},
    )
    if not isinstance(operation, dict):
        raise ApiError("Failed to enable the VM virtual display device.", 502)
    wait_for_zone_operation(operation, zone=instance_zone_name(instance), timeout_seconds=180)
    return get_instance()


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


def parse_datetime_utc(raw_value: str) -> datetime | None:
    value = str(raw_value or "").strip()
    if not value:
        return None
    if value.endswith("Z"):
        value = f"{value[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def format_datetime_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def estimated_auto_stop_at(instance: dict[str, Any], hours: int) -> str:
    base = parse_datetime_utc(metadata_value(instance, BACKUP_READY_AT_METADATA_KEY))
    if base is None:
        base = parse_datetime_utc(str(instance.get("lastStartTimestamp", "") or ""))
    if base is None:
        base = parse_datetime_utc(str(instance.get("creationTimestamp", "") or ""))
    if base is None:
        return ""
    return format_datetime_utc(base + timedelta(hours=hours))


def build_auto_stop_status(instance: dict[str, Any] | None) -> dict[str, Any]:
    if instance is None:
        return {
            "hours": "",
            "scheduledAt": "",
            "remainingSeconds": None,
            "source": "",
            "label": "VM not created",
        }

    hours_raw = metadata_value(instance, AUTO_STOP_METADATA_KEY).strip()
    if not hours_raw:
        return {
            "hours": "",
            "scheduledAt": "",
            "remainingSeconds": None,
            "source": "",
            "label": "Disabled",
        }

    scheduled_at = metadata_value(instance, AUTO_STOP_AT_METADATA_KEY).strip()
    source = "metadata" if scheduled_at else ""
    try:
        hours = int(hours_raw)
    except ValueError:
        hours = None

    if str(instance.get("status", "")).upper() != "RUNNING":
        return {
            "hours": hours_raw,
            "scheduledAt": "",
            "remainingSeconds": None,
            "source": "",
            "label": "Will be scheduled after next start",
        }

    if not scheduled_at and hours is not None and str(instance.get("status", "")).upper() == "RUNNING":
        scheduled_at = estimated_auto_stop_at(instance, hours)
        source = "estimated" if scheduled_at else ""

    remaining_seconds: int | None = None
    scheduled_dt = parse_datetime_utc(scheduled_at)
    if scheduled_dt is not None:
        remaining_seconds = max(0, int((scheduled_dt - datetime.now(timezone.utc)).total_seconds()))

    return {
        "hours": hours_raw,
        "scheduledAt": scheduled_at,
        "remainingSeconds": remaining_seconds,
        "source": source,
        "label": "Scheduled" if scheduled_at else f"Scheduled after {hours_raw}h",
    }


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


def build_admin_sunshine_credentials_payload(
    *,
    admin_user: dict[str, Any],
    instance: dict[str, Any] | None,
    include_password: bool = False,
    operation: dict[str, str] | None = None,
) -> dict[str, Any]:
    credentials = sunshine_credentials_from_instance(instance) if instance else {
        "username": SUNSHINE_USERNAME,
        "password": "",
    }
    password = str(credentials.get("password", "")).strip()
    password_available = bool(password and password != "change-me")
    response = {
        "user": admin_user,
        "endpoint": endpoint_public_payload(selected_endpoint()),
        "instanceExists": instance is not None,
        "instanceState": str(instance.get("status", "NOT_FOUND")).upper() if instance else "NOT_FOUND",
        "sunshineStatus": build_sunshine_status(instance),
        "credentials": {
            "username": credentials.get("username") or SUNSHINE_USERNAME,
            "password": password if include_password and password_available else "",
        },
        "passwordAvailable": password_available,
        "passwordRevealed": bool(include_password and password_available),
        "canUpdate": instance is not None,
    }
    if operation:
        response["operation"] = operation
    return response


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
        # Keep existing VMs on the current lifecycle scripts as well. In
        # particular, restart reboots the guest and executes GCE's
        # startup-script, not only vm-power-action-script.
        "startup-script": decode_config_b64("vm_startup_script_b64"),
        "shutdown-script": decode_config_b64("vm_shutdown_script_b64"),
        "vm-persist-script": decode_config_b64("vm_persist_script_b64"),
        "vm-power-action-script": decode_config_b64("vm_power_action_script_b64"),
        POWER_ACTION_METADATA_KEY: f"{action}:{token}",
        POWER_ACTION_STATUS_METADATA_KEY: f"requested:{action}:{token}",
    }
    if str(CONFIG["vm_minecraft_management_script_b64"] or "").strip():
        updates["vm-minecraft-management-script"] = decode_config_b64("vm_minecraft_management_script_b64")
    if sunshine_state is not None:
        updates[SUNSHINE_STATUS_METADATA_KEY] = sunshine_state
        updates[SUNSHINE_STATUS_DETAIL_METADATA_KEY] = status_detail
    if extra_metadata:
        updates.update(extra_metadata)
    set_instance_metadata_values(instance, updates)
    refreshed = compute_request("GET", instance_self_url(instance))
    return refreshed if isinstance(refreshed, dict) else get_instance(), token


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
                runtime_detail = metadata_value(last_instance, RUNTIME_IMAGE_DETAIL_METADATA_KEY).strip()
                raise ApiError(runtime_detail or f"VM action {action} failed.", 502)
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


def is_gpu_disabled_for_instance(instance: dict[str, Any]) -> bool:
    gpu_count = metadata_value(instance, GPU_COUNT_METADATA_KEY).strip()
    if not gpu_count:
        return False
    try:
        return int(gpu_count) <= 0
    except ValueError:
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


def wait_for_raw_sunshine_metadata_state(
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

        current_state = metadata_value(last_instance, SUNSHINE_STATUS_METADATA_KEY).strip().lower()
        if current_state == target_state:
            return last_instance

        time.sleep(4)

    if last_instance:
        return last_instance
    raise ApiError("Timed out waiting for Sunshine metadata status to settle.", 504)


def wait_for_remote_access_status(timeout_seconds: int = 300) -> dict[str, Any]:
    instance = get_instance()
    if is_gpu_disabled_for_instance(instance):
        return wait_for_raw_sunshine_metadata_state("disabled", timeout_seconds=timeout_seconds)
    return wait_for_sunshine_status("ready", timeout_seconds=timeout_seconds)


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
        {"key": "vm-data-disk-device-name", "value": data_disk_device_name()},
        {"key": "vm-data-disk-mount-root", "value": CONFIG["data_disk_mount_root"]},
        {"key": "vm-control-endpoint-id", "value": selected_endpoint_id()},
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
        {
            "key": SUNSHINE_STATUS_METADATA_KEY,
            "value": "starting" if selected_gpu_count() > 0 else "disabled",
        },
        {
            "key": SUNSHINE_STATUS_DETAIL_METADATA_KEY,
            "value": (
                "VM booting. Waiting for Sunshine Web UI."
                if selected_gpu_count() > 0
                else "GPU disabled for this VM; Sunshine stack was not started."
            ),
        },
        {"key": DATA_DISK_STATUS_METADATA_KEY, "value": "pending"},
        {"key": DATA_DISK_DETAIL_METADATA_KEY, "value": "Waiting for shared data disk mount."},
    ]

    if str(CONFIG["vm_minecraft_management_script_b64"] or "").strip():
        items.append(
            {
                "key": "vm-minecraft-management-script",
                "value": decode_config_b64("vm_minecraft_management_script_b64"),
            }
        )

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


def firewall_rule_body(
    name: str,
    allowed: list[dict[str, Any]],
    source_ranges: list[str] | None = None,
) -> dict[str, Any]:
    tags = CONFIG["vm_tags"] or ["steam-headless"]
    return {
        "name": name,
        "network": network_path(),
        "direction": "INGRESS",
        "allowed": allowed,
        "sourceRanges": source_ranges or CONFIG["firewall_source_ranges"],
        "targetTags": tags,
    }


def ensure_firewall_rule(
    name: str,
    allowed: list[dict[str, Any]],
    source_ranges: list[str] | None = None,
) -> None:
    body = firewall_rule_body(name, allowed, source_ranges)
    existing = compute_request("GET", firewall_url(name), allow_404=True)
    if existing is None:
        operation = compute_request("POST", firewalls_collection_url(), json=body)
    else:
        operation = compute_request("PATCH", firewall_url(name), json=body)
    if isinstance(operation, dict):
        wait_for_global_operation(operation, timeout_seconds=120)


def ensure_firewall_rules() -> None:
    ensure_firewall_rule(CONFIG["firewall_rule_web"], FIREWALL_WEB_ALLOWED)
    ensure_firewall_rule(
        CONFIG["firewall_rule_novnc_iap"],
        FIREWALL_NOVNC_IAP_ALLOWED,
        IAP_TCP_FORWARDING_SOURCE_RANGES,
    )
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
    endpoint = selected_endpoint()
    static_ip = str(endpoint.get("staticIp", "") or "") if endpoint_has_manual_static_ip(endpoint) else ""
    if static_ip:
        network_interface["accessConfigs"][0]["natIP"] = static_ip

    service_account_email = CONFIG["vm_service_account_email"].strip()
    if not service_account_email:
        raise ApiError("Service is missing required configuration: vm_service_account_email", 500)

    request_body: dict[str, Any] = {
        "name": selected_instance_name(),
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
                "deviceName": data_disk_device_name(),
                "initializeParams": {
                    "diskName": data_disk_device_name(),
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
        "displayDevice": {"enableDisplay": True},
            "metadata": {
                "items": build_instance_metadata_items(
                    auto_stop_hours=auto_stop_hours,
                    sunshine_credentials=sunshine_credentials,
                )
            },
    }

    if CONFIG["vm_tags"]:
        request_body["tags"] = {"items": CONFIG["vm_tags"]}
    if selected_gpu_count() > 0:
        request_body["reservationAffinity"] = {"consumeReservationType": "ANY_RESERVATION"}
    if selected_gpu_count() > 0 and selected_accelerator_mode() == "attached":
        request_body["guestAccelerators"] = [
            {
                "acceleratorType": accelerator_type_path(),
                "acceleratorCount": selected_gpu_count(),
            }
        ]
    return request_body


def build_urls(external_ip: str, minecraft_port: int | None = None) -> dict[str, Any]:
    game_port = int(minecraft_port or CONFIG["minecraft_port"])
    urls: dict[str, Any] = {
        "novnc": "",
        "novncIap": {
            "localUrl": f"http://localhost:{CONFIG['novnc_port']}/",
            "command": (
                f"gcloud compute start-iap-tunnel {selected_instance_name()} {CONFIG['novnc_port']} "
                f"--project {CONFIG['project']} --zone {selected_zone()} "
                f"--local-host-port=localhost:{CONFIG['novnc_port']}"
            ),
        },
        "sunshine": "",
        "minecraft": "",
        "moonlightHost": external_ip,
        "duckdns": [],
    }
    endpoint_domains = selected_endpoint_domains()
    primary_duckdns = endpoint_domains[0] if endpoint_domains else ""
    if primary_duckdns:
        urls["sunshine"] = f"https://{primary_duckdns}:{CONFIG['sunshine_port']}/"
        urls["minecraft"] = f"{primary_duckdns}:{game_port}"
        urls["moonlightHost"] = primary_duckdns
    elif external_ip:
        urls["sunshine"] = f"https://{external_ip}:{CONFIG['sunshine_port']}/"
        urls["minecraft"] = f"{external_ip}:{game_port}"

    duckdns_entries = []
    for domain in endpoint_domains:
        duckdns_entries.append(
            {
                "domain": domain,
                "sunshine": f"https://{domain}:{CONFIG['sunshine_port']}/",
                "minecraft": f"{domain}:{game_port}",
            }
        )
    urls["duckdns"] = duckdns_entries
    return urls


def build_sunshine_status(instance: dict[str, Any] | None) -> dict[str, str]:
    version = metadata_value(instance, "vm-sunshine-version").strip() if instance else ""
    if instance is None:
        return {
            "state": "not_created",
            "label": "VM not created",
            "detail": "",
            "version": version,
        }

    vm_status = str(instance.get("status", "UNKNOWN")).upper()
    if vm_status != "RUNNING":
        return {
            "state": "stopped",
            "label": "VM not running",
            "detail": "",
            "version": version,
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
            "version": version,
        }
    if power_action == "restore-backup" and phase in {"requested", "running"}:
        return {
            "state": "restore",
            "label": "Restore in progress",
            "detail": detail or "Steam Headless and Sunshine are temporarily stopped while the selected backup is restored.",
            "version": version,
        }
    if power_action == "restart" and phase in {"requested", "running", "rebooting"}:
        return {
            "state": "starting",
            "label": "Restarting",
            "detail": detail or "VM is restarting. Waiting for Sunshine Web UI.",
            "version": version,
        }
    if power_action == "apply-sunshine-password" and phase in {"requested", "running"}:
        return {
            "state": "starting",
            "label": "Applying password",
            "detail": detail or "Applying Sunshine password change.",
            "version": version,
        }
    if power_action in {"install-app", "uninstall-app"} and phase in {"requested", "running"}:
        return {
            "state": "starting",
            "label": "Updating application",
            "detail": detail or "Updating Sunshine application list.",
            "version": version,
        }
    if (
        power_action == "update-runtime-image"
        and phase in {"requested", "running"}
        and metadata_value(instance, RUNTIME_IMAGE_COMPONENT_METADATA_KEY).strip() == "steam-headless"
    ):
        return {
            "state": "starting",
            "label": "Updating image",
            "detail": detail or metadata_value(instance, RUNTIME_IMAGE_DETAIL_METADATA_KEY) or "Updating Steam Headless and Sunshine image.",
            "version": version,
        }
    if power_action in {"delete", "stop", "auto-stop"} and phase in {"requested", "running", "backed-up", "stopping"}:
        stopping_detail = (
            "Steam Headless and Sunshine are stopping for the scheduled auto-stop."
            if power_action == "auto-stop"
            else "Steam Headless and Sunshine are stopping for the requested VM action."
        )
        return {
            "state": "stopping",
            "label": "Stopping",
            "detail": detail or stopping_detail,
            "version": version,
        }
    gpu_type = metadata_value(instance, "vm-gpu-type").strip() or instance_accelerator_summary(instance)[0]
    if gpu_type in INCOMPATIBLE_SUNSHINE_ACCELERATORS:
        return {
            "state": "error",
            "label": "Incompatible GPU",
            "detail": f"{gpu_type} is confirmed incompatible with the Steam Headless and Sunshine streaming stack.",
            "version": version,
        }
    if is_gpu_disabled_for_instance(instance):
        if state != "disabled":
            gpu_disabled_pending_labels = {
                "starting": "Starting",
                "stopping": "Stopping",
                "error": "Error",
            }
            return {
                "state": state or "starting",
                "label": gpu_disabled_pending_labels.get(state, state.title() if state else "Starting"),
                "detail": detail or "VM startup in progress.",
                "version": version,
            }
        return {
            "state": "disabled",
            "label": "Disabled",
            "detail": "GPU disabled for this VM; Sunshine stack was not started.",
            "version": version,
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
        "disabled": "Disabled",
        "error": "Error",
    }
    return {
        "state": state,
        "label": labels.get(state, state.title()),
        "detail": detail,
        "version": version,
    }


def minecraft_version_from_instance(instance: dict[str, Any] | None) -> str:
    if instance is None:
        return ""
    raw_version = metadata_value(instance, MINECRAFT_VERSION_METADATA_KEY).strip()
    if not raw_version:
        return ""
    try:
        return concrete_minecraft_version(raw_version)
    except ApiError:
        return ""


def minecraft_server_type_from_instance(instance: dict[str, Any] | None) -> str:
    raw_server_type = metadata_value(instance, MINECRAFT_SERVER_TYPE_METADATA_KEY).strip() if instance else ""
    try:
        return normalize_minecraft_server_type(raw_server_type)
    except ApiError:
        return DEFAULT_MINECRAFT_SERVER_TYPE


def minecraft_server_id(payload: Any, *, required: bool = False) -> str:
    raw = payload.get("minecraftServerId") if hasattr(payload, "get") else ""
    server_id = str(raw or "").strip().lower()
    if not server_id and not required:
        return "default"
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,30}", server_id):
        raise ApiError("Minecraft server ID must use 1-31 lowercase letters, digits, or hyphens.", 400)
    return server_id


def minecraft_servers_from_instance(instance: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Return the per-VM Minecraft registry, migrating the legacy singleton in memory."""
    if instance is None:
        return []
    raw = metadata_value(instance, MINECRAFT_SERVERS_METADATA_KEY)
    try:
        parsed = json.loads(raw) if raw else []
    except (TypeError, ValueError):
        parsed = []
    entries = parsed.get("servers", []) if isinstance(parsed, dict) else parsed
    servers: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    used_ports: set[int] = set()
    if isinstance(entries, list):
        for value in entries:
            if not isinstance(value, dict):
                continue
            try:
                server_id = minecraft_server_id({"minecraftServerId": value.get("id")}, required=True)
                port = int(value.get("gamePort"))
            except (ApiError, TypeError, ValueError):
                continue
            if server_id in used_ids or not MINECRAFT_GAME_PORT_MIN <= port <= MINECRAFT_GAME_PORT_MAX:
                continue
            used_ids.add(server_id)
            used_ports.add(port)
            servers.append({
                "id": server_id,
                "version": str(value.get("version") or "LATEST"),
                "serverType": normalize_minecraft_server_type(value.get("serverType") or DEFAULT_MINECRAFT_SERVER_TYPE),
                "gamePort": port,
                "state": str(value.get("state") or "stopped").lower(),
                "detail": str(value.get("detail") or ""),
                "content": value.get("content") if isinstance(value.get("content"), list) else [],
            })
    if not servers:
        legacy_state = metadata_value(instance, MINECRAFT_STATUS_METADATA_KEY).strip().lower()
        if legacy_state and legacy_state not in {"not_installed", "removed"}:
            servers.append({
                "id": "default",
                "version": minecraft_version_from_instance(instance) or "LATEST",
                "serverType": minecraft_server_type_from_instance(instance),
                "gamePort": int(CONFIG["minecraft_port"]),
                "state": legacy_state,
                "detail": metadata_value(instance, MINECRAFT_STATUS_DETAIL_METADATA_KEY),
                "content": minecraft_modrinth_content(instance),
            })
    return servers


def minecraft_server_registry_value(servers: list[dict[str, Any]]) -> str:
    return json.dumps({"schemaVersion": 2, "servers": servers}, separators=(",", ":"))


def minecraft_server_by_id(instance: dict[str, Any] | None, server_id: str) -> dict[str, Any] | None:
    return next((server for server in minecraft_servers_from_instance(instance) if server["id"] == server_id), None)


def selected_minecraft_server_id(instance: dict[str, Any] | None, payload: Any) -> str:
    """Resolve an explicit server ID, or the most useful live server on a multi-server VM."""
    raw_server_id = payload.get("minecraftServerId") if hasattr(payload, "get") else ""
    if str(raw_server_id or "").strip():
        return minecraft_server_id(payload)
    servers = minecraft_servers_from_instance(instance)
    for server in servers:
        if server.get("state") == "running":
            return str(server["id"])
    for server in servers:
        if server.get("state") != "removed":
            return str(server["id"])
    return "default"


def minecraft_next_game_port(servers: list[dict[str, Any]]) -> int:
    used = {int(server["gamePort"]) for server in servers}
    for port in range(MINECRAFT_GAME_PORT_MIN, MINECRAFT_GAME_PORT_MAX + 1):
        if port not in used:
            return port
    raise ApiError(f"All Minecraft ports {MINECRAFT_GAME_PORT_MIN}-{MINECRAFT_GAME_PORT_MAX} are allocated on this VM.", 409)


def ensure_minecraft_firewall_for_servers(servers: list[dict[str, Any]]) -> None:
    ports = [int(server["gamePort"]) for server in servers if server.get("state") != "removed"]
    if ports:
        ensure_firewall_rule(CONFIG["firewall_rule_minecraft"], minecraft_firewall_allowed(ports))
    else:
        compute_request("DELETE", firewall_url(CONFIG["firewall_rule_minecraft"]), allow_404=True)


def update_minecraft_server_registry(instance: dict[str, Any], servers: list[dict[str, Any]]) -> dict[str, Any]:
    set_instance_metadata_value(instance, MINECRAFT_SERVERS_METADATA_KEY, minecraft_server_registry_value(servers))
    ensure_minecraft_firewall_for_servers(servers)
    return get_instance()


def normalize_minecraft_modrinth_content(values: Any) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        return []

    result: list[dict[str, Any]] = []
    for value in values:
        if not isinstance(value, dict):
            continue
        project_id = str(value.get("projectId") or "").strip()
        version_id = str(value.get("versionId") or "").strip()
        kind = str(value.get("kind") or "").strip().lower()
        if not re.fullmatch(r"[A-Za-z0-9_-]{3,80}", project_id):
            continue
        if not re.fullmatch(r"[A-Za-z0-9_-]{3,80}", version_id) or kind not in {"plugin", "mod"}:
            continue
        files = [
            str(filename).strip()
            for filename in (value.get("files") or [])
            if isinstance(filename, str) and re.fullmatch(r"[A-Za-z0-9._+-]{1,240}\.jar", filename.strip())
        ]
        raw_checksums = value.get("checksums") if isinstance(value.get("checksums"), dict) else {}
        checksums = {
            filename: str(raw_checksums.get(filename) or "").lower()
            for filename in files
            if re.fullmatch(r"[a-fA-F0-9]{128}", str(raw_checksums.get(filename) or ""))
        }
        result.append(
            {
                "projectId": project_id,
                "versionId": version_id,
                "kind": kind,
                "projectUrl": f"https://modrinth.com/{kind}/{project_id}",
                "title": str(value.get("title") or project_id).strip()[:160] or project_id,
                "version": str(value.get("version") or version_id).strip()[:120] or version_id,
                "files": files,
                "checksums": checksums,
            }
        )
    return result


def minecraft_modrinth_content(instance: dict[str, Any] | None) -> list[dict[str, Any]]:
    raw_content = metadata_value(instance, MINECRAFT_MODRINTH_CONTENT_METADATA_KEY) if instance else ""
    try:
        values = json.loads(raw_content) if raw_content else []
    except (TypeError, ValueError):
        return []
    return normalize_minecraft_modrinth_content(values)


def migrate_unambiguous_legacy_minecraft_content(instance: dict[str, Any]) -> dict[str, Any]:
    """Copy legacy content once into a single live server; retain the legacy value for rollback."""
    legacy_content = minecraft_modrinth_content(instance)
    registry_raw = metadata_value(instance, MINECRAFT_SERVERS_METADATA_KEY)
    if not legacy_content or not registry_raw:
        return instance
    servers = minecraft_servers_from_instance(instance)
    live_servers = [server for server in servers if server.get("state") != "removed"]
    if len(live_servers) != 1 or normalize_minecraft_modrinth_content(live_servers[0].get("content", [])):
        return instance
    live_servers[0]["content"] = legacy_content
    audit = {
        "state": "copied",
        "serverId": live_servers[0]["id"],
        "sourceChecksum": hashlib.sha256(
            registry_raw.encode("utf-8") + json.dumps(legacy_content, sort_keys=True).encode("utf-8")
        ).hexdigest(),
        "migratedAt": datetime.now(timezone.utc).isoformat(),
    }
    set_instance_metadata_values(
        instance,
        {
            MINECRAFT_SERVERS_METADATA_KEY: minecraft_server_registry_value(servers),
            "vm-minecraft-content-migration": json.dumps(audit, separators=(",", ":")),
        },
    )
    return get_instance()


def update_minecraft_server_content(
    instance: dict[str, Any], server_id: str, content: list[dict[str, str]]
) -> dict[str, Any]:
    servers = minecraft_servers_from_instance(instance)
    for server in servers:
        if server["id"] == server_id:
            server["content"] = normalize_minecraft_modrinth_content(content)
            return update_minecraft_server_registry(instance, servers)
    raise ApiError("Selected Minecraft server is not installed on this VM.", 404)


def modrinth_get(path: str, *, params: dict[str, Any], timeout_seconds: float = 20) -> Any:
    if time.monotonic() < float(getattr(modrinth_get, "circuit_open_until", 0.0)):
        raise ApiError("Modrinth compatibility checks are temporarily paused after rate limiting. Try again shortly.", 503)
    try:
        response = requests.get(
            f"{MODRINTH_API_BASE_URL}{path}",
            params=params,
            headers={"User-Agent": MODRINTH_USER_AGENT, "Accept": "application/json"},
            timeout=max(1, min(timeout_seconds, 20)),
        )
    except requests.RequestException as error:
        raise ApiError(f"Modrinth request failed: {error}", 502) from error
    if response.status_code == 429:
        modrinth_get.circuit_open_until = time.monotonic() + 30
        raise ApiError("Modrinth rate limited compatibility checks. Try again in 30 seconds.", 503)
    if response.status_code >= 400:
        raise ApiError(f"Modrinth returned {response.status_code}.", 502)
    try:
        return response.json()
    except ValueError as error:
        raise ApiError("Modrinth returned invalid JSON.", 502) from error


_modrinth_version_cache: dict[tuple[str, str, tuple[str, ...]], tuple[float, list[dict[str, Any]]]] = {}
_modrinth_version_cache_lock = threading.Lock()


def modrinth_project_versions(project_id: str, version: str, loaders: list[str], *, deadline: float | None = None) -> list[dict[str, Any]]:
    key = (project_id, version, tuple(sorted(loaders)))
    now = time.monotonic()
    with _modrinth_version_cache_lock:
        cached = _modrinth_version_cache.get(key)
    if cached and cached[0] > now:
        return cached[1]
    remaining = 20.0 if deadline is None else deadline - now
    if remaining <= 0:
        raise ApiError("Modrinth compatibility verification timed out.", 504)
    data = modrinth_get(
        f"/project/{project_id}/version",
        params={"game_versions": json.dumps([version]), "loaders": json.dumps(loaders)},
        timeout_seconds=remaining,
    )
    if not isinstance(data, list):
        raise ApiError("Modrinth returned an invalid version catalog.", 502)
    versions = [candidate for candidate in data if isinstance(candidate, dict)]
    with _modrinth_version_cache_lock:
        if len(_modrinth_version_cache) >= 256:
            oldest = min(_modrinth_version_cache, key=lambda item: _modrinth_version_cache[item][0])
            _modrinth_version_cache.pop(oldest, None)
        _modrinth_version_cache[key] = (time.monotonic() + 600, versions)
    return versions


def modrinth_server_artifact(candidate: dict[str, Any]) -> dict[str, str] | None:
    environment = candidate.get("environment")
    if isinstance(environment, dict) and str(environment.get("server") or "").lower() in {"unsupported", "client_only", "client-only"}:
        return None
    files = [file for file in candidate.get("files", []) if isinstance(file, dict)]
    files.sort(key=lambda file: not bool(file.get("primary")))
    for file in files:
        filename = str(file.get("filename") or "").strip()
        sha512 = str((file.get("hashes") or {}).get("sha512") or "").strip().lower()
        if re.fullmatch(r"[A-Za-z0-9._+-]{1,240}\.jar", filename) and re.fullmatch(r"[a-f0-9]{128}", sha512):
            return {"filename": filename, "sha512": sha512}
    return None


def select_compatible_modrinth_version(
    versions: list[dict[str, Any]], loaders: list[str], requested_version_id: str = ""
) -> tuple[dict[str, Any], dict[str, str]] | None:
    supported_loaders = set(loaders)
    for candidate in versions:
        if requested_version_id and str(candidate.get("id") or "") != requested_version_id:
            continue
        if not supported_loaders.intersection(str(loader) for loader in (candidate.get("loaders") or [])):
            continue
        artifact = modrinth_server_artifact(candidate)
        version_id = str(candidate.get("id") or "").strip()
        if artifact and re.fullmatch(r"[A-Za-z0-9_-]{3,80}", version_id):
            return candidate, artifact
    return None


def minecraft_modrinth_catalog_search(instance: dict[str, Any], payload: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
    query = str(payload.get("query") or "").strip()
    if not (2 <= len(query) <= 100) or any(ord(character) < 32 for character in query):
        raise ApiError("Modrinth search query must contain 2-100 printable characters.", 400)
    selected_server = minecraft_server_by_id(instance, minecraft_server_id(payload))
    version = str((selected_server or {}).get("version") or minecraft_version_from_instance(instance)).strip()
    if not version:
        raise ApiError("Install a concrete Minecraft version before searching for content.", 409)
    runtime = minecraft_server_type_spec((selected_server or {}).get("serverType") or minecraft_server_type_from_instance(instance))
    kind = str(runtime["contentKind"])
    requested_kind = str(payload.get("kind") or kind).strip().lower()
    if requested_kind != kind:
        raise ApiError(f"The selected {runtime['label']} server supports {runtime['contentLabel']}, not {requested_kind}s.", 409)
    data = modrinth_get(
        "/search",
        params={
            "query": query,
            "limit": 20,
            "index": "relevance",
            "facets": json.dumps(
                [
                    [f"project_type:{kind}"],
                    [f"versions:{version}"],
                    [f"categories:{loader}" for loader in runtime["modrinthLoaders"]],
                ]
            ),
        },
    )
    hits = data.get("hits") if isinstance(data, dict) else []
    if not isinstance(hits, list):
        return [], 0
    results: list[dict[str, Any]] = []
    skipped = 0
    deadline = time.monotonic() + 18
    for hit in hits:
        if not isinstance(hit, dict):
            continue
        project_id = str(hit.get("project_id") or hit.get("projectId") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{3,80}", project_id):
            continue
        try:
            selected = select_compatible_modrinth_version(
                modrinth_project_versions(project_id, version, list(runtime["modrinthLoaders"]), deadline=deadline),
                list(runtime["modrinthLoaders"]),
            )
        except ApiError:
            skipped += 1
            if time.monotonic() >= deadline:
                break
            continue
        if not selected:
            skipped += 1
            continue
        selected_version, artifact = selected
        slug = str(hit.get("slug") or "").strip()
        project_path = slug if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{1,99}", slug) else project_id
        results.append(
            {
                "projectId": project_id,
                "projectUrl": f"https://modrinth.com/{kind}/{project_path}",
                "title": str(hit.get("title") or project_id).strip()[:160] or project_id,
                "description": str(hit.get("description") or "").strip()[:500],
                "author": str(hit.get("author") or "").strip()[:160],
                "downloads": int(hit.get("downloads") or 0) if str(hit.get("downloads") or "").isdigit() else 0,
                "iconUrl": str(hit.get("icon_url") or "").strip()[:500],
                "versionId": str(selected_version["id"]),
                "version": str(selected_version.get("version_number") or selected_version["id"])[:120],
                "files": [artifact["filename"]],
                "checksums": {artifact["filename"]: artifact["sha512"]},
            }
        )
    return results, skipped


def minecraft_modrinth_content_entry(instance: dict[str, Any], payload: dict[str, Any]) -> dict[str, str]:
    project_id = str(payload.get("projectId") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{3,80}", project_id):
        raise ApiError("Invalid Modrinth project ID.", 400)
    selected_server = minecraft_server_by_id(instance, minecraft_server_id(payload))
    version = str((selected_server or {}).get("version") or minecraft_version_from_instance(instance)).strip()
    if not version:
        raise ApiError("Install a concrete Minecraft version before adding content.", 409)
    runtime = minecraft_server_type_spec((selected_server or {}).get("serverType") or minecraft_server_type_from_instance(instance))
    requested_kind = str(payload.get("kind") or runtime["contentKind"]).strip().lower()
    if requested_kind != runtime["contentKind"]:
        raise ApiError(f"The selected {runtime['label']} server supports {runtime['contentLabel']} only.", 409)
    versions = modrinth_project_versions(project_id, version, list(runtime["modrinthLoaders"]))
    requested_version_id = str(payload.get("versionId") or "").strip()
    selected = select_compatible_modrinth_version(versions, list(runtime["modrinthLoaders"]), requested_version_id)
    if not selected:
        raise ApiError(f"No compatible Modrinth {runtime['contentKind']} version was found for Minecraft {version} and {runtime['label']}.", 409)
    selected_version, artifact = selected
    version_id = str(selected_version.get("id") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{3,80}", version_id):
        raise ApiError("Modrinth returned an invalid version ID.", 502)
    return {
        "projectId": project_id,
        "versionId": version_id,
        "kind": str(runtime["contentKind"]),
        "title": str(payload.get("title") or project_id).strip()[:160] or project_id,
        "version": str(selected_version.get("version_number") or version_id).strip()[:120] or version_id,
        "files": [artifact["filename"]],
        "checksums": {artifact["filename"]: artifact["sha512"]},
    }


def minecraft_management_request_result(instance: dict[str, Any] | None) -> dict[str, Any]:
    if instance is None:
        return {}
    raw_result = metadata_value(instance, MINECRAFT_MANAGEMENT_RESULT_METADATA_KEY)
    if not raw_result:
        return {}
    try:
        result = json.loads(raw_result)
    except (TypeError, ValueError):
        return {}
    if not isinstance(result, dict):
        return {}
    output = str(result.get("output", "") or "")
    return {
        "id": str(result.get("id", "") or ""),
        "action": str(result.get("action", "") or ""),
        "state": str(result.get("state", "") or ""),
        "output": output[:4096],
        "completedAt": str(result.get("completedAt", "") or ""),
    }


def minecraft_management_request_server_id(instance: dict[str, Any] | None) -> str:
    raw_request = metadata_value(instance, MINECRAFT_MANAGEMENT_REQUEST_METADATA_KEY) if instance else ""
    try:
        request_payload = json.loads(raw_request) if raw_request else {}
    except (TypeError, ValueError):
        return ""
    server_id = str(request_payload.get("serverId", "") or "").strip().lower() if isinstance(request_payload, dict) else ""
    return server_id if re.fullmatch(r"[a-z0-9][a-z0-9-]{0,30}", server_id) else ""


def minecraft_server_properties(instance: dict[str, Any] | None) -> dict[str, Any]:
    if instance is None:
        return {"loaded": False, "properties": []}
    raw = metadata_value(instance, MINECRAFT_SERVER_PROPERTIES_METADATA_KEY)
    if not raw:
        return {"loaded": False, "properties": []}
    try:
        values = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return {"loaded": False, "properties": []}
    if not isinstance(values, dict):
        return {"loaded": False, "properties": []}

    properties: list[dict[str, Any]] = []
    for key, value in values.items():
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9.-]{1,80}", key):
            continue
        if key == "rcon.password":
            continue
        rule = MINECRAFT_SERVER_PROPERTY_RULES.get(key, {})
        properties.append(
            {
                "key": key,
                "value": str(value)[:512],
                "kind": str(rule.get("kind", "text")),
                "minimum": rule.get("minimum"),
                "maximum": rule.get("maximum"),
                "suggestions": list(rule.get("suggestions", [])),
                "description": str(rule.get("description", "Option provided by the currently installed server version.")),
                "editable": key not in MINECRAFT_SERVER_PROPERTY_BLOCKED,
            }
        )
    return {"loaded": True, "properties": sorted(properties, key=lambda item: item["key"])}


def minecraft_rcon_suggestions(instance: dict[str, Any] | None) -> dict[str, Any]:
    raw = metadata_value(instance, MINECRAFT_COMMAND_SUGGESTIONS_METADATA_KEY) if instance else ""
    players: list[str] = []
    refreshed_at = ""
    if raw:
        try:
            payload = json.loads(raw)
        except (TypeError, ValueError):
            payload = {}
        if isinstance(payload, dict):
            players = [
                value for value in payload.get("players", [])
                if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_]{3,16}", value)
            ][:100]
            refreshed_at = str(payload.get("refreshedAt", ""))
    return {
        "commands": MINECRAFT_RCON_COMMAND_CATALOG,
        "onlinePlayers": players,
        "refreshedAt": refreshed_at,
    }


def build_minecraft_management_payload(
    instance: dict[str, Any] | None,
    user: dict[str, Any],
    *,
    selected_server_id: str | None = None,
    result: dict[str, Any] | None = None,
    message: str = "",
    catalog_results: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if selected_server_id is None:
        selected_server_id = selected_minecraft_server_id(instance, request.args if request else {})
    servers = minecraft_servers_from_instance(instance)
    selected_server = next((server for server in servers if server["id"] == selected_server_id), None)
    minecraft_status = build_minecraft_status(instance)
    if selected_server:
        minecraft_status = {
            "state": selected_server["state"],
            "label": selected_server["state"].replace("_", " ").title(),
            "detail": selected_server.get("detail", ""),
            "version": selected_server.get("version", ""),
        }
    agent_ready = minecraft_management_agent_ready(instance)
    runtime = minecraft_server_type_spec((selected_server or {}).get("serverType") or minecraft_server_type_from_instance(instance))
    agent_prepared = bool(
        instance and metadata_value(instance, "vm-minecraft-management-script").strip()
    )
    last_result = result or minecraft_management_request_result(instance)
    if result is None and last_result and minecraft_management_request_server_id(instance) != selected_server_id:
        last_result = {}
    return {
        "user": user,
        "target": {
            "project": CONFIG["project"],
            "zone": selected_zone(),
            "instance": selected_instance_name(),
        },
        "authorized": user_can_manage_minecraft(user),
        "instanceExists": instance is not None,
        "instanceState": str((instance or {}).get("status", "NOT_FOUND")),
        "minecraftStatus": minecraft_status,
        "servers": servers,
        "selectedServerId": selected_server_id,
        "selectedServer": selected_server,
        "serverRuntime": {
            "id": runtime["id"],
            "label": runtime["label"],
            "contentKind": runtime["contentKind"],
            "contentLabel": runtime["contentLabel"],
        },
        "serverProperties": minecraft_server_properties(instance),
        "rconSuggestions": minecraft_rcon_suggestions(instance),
        "content": normalize_minecraft_modrinth_content((selected_server or {}).get("content", [])),
        "catalogResults": catalog_results or [],
        "agentReady": agent_ready,
        "agentPrepared": agent_prepared,
        "restartRequired": agent_prepared and not agent_ready,
        "actions": [
            "console",
            "players",
            "whitelist-list",
            "whitelist-add",
            "whitelist-remove",
            "op-list",
            "op-add",
            "op-remove",
            "restart",
            "properties-read",
            "properties-update",
            "catalog-search",
            "content-install",
            "content-remove",
        ],
        "lastResult": last_result,
        "message": message,
    }


def build_minecraft_status(
    instance: dict[str, Any] | None,
    server: dict[str, Any] | None = None,
) -> dict[str, str]:
    version = str(server.get("version") or "") if server else minecraft_version_from_instance(instance)
    if instance is None:
        return {
            "state": "not_created",
            "label": "VM not created",
            "detail": "",
            "version": version,
        }

    vm_status = str(instance.get("status", "UNKNOWN")).upper()
    if vm_status != "RUNNING":
        return {
            "state": "stopped",
            "label": "VM not running",
            "detail": "",
            "version": version,
        }

    state = (
        str(server.get("state") or "").strip().lower()
        if server
        else metadata_value(instance, MINECRAFT_STATUS_METADATA_KEY).strip().lower()
    ) or "not_installed"
    detail = (
        str(server.get("detail") or "").strip()
        if server
        else metadata_value(instance, MINECRAFT_STATUS_DETAIL_METADATA_KEY).strip()
    )
    phase, power_action, _ = parse_power_action_status(
        metadata_value(instance, POWER_ACTION_STATUS_METADATA_KEY)
    )
    if power_action == "create-backup" and phase in {"requested", "running"}:
        return {
            "state": "backup",
            "label": "Backup in progress",
            "detail": detail or "Minecraft server is temporarily stopped while the manual backup is running.",
            "version": version,
        }
    if power_action == "restore-backup" and phase in {"requested", "running"}:
        return {
            "state": "restore",
            "label": "Restore in progress",
            "detail": detail or "Minecraft server is temporarily stopped while the selected backup is restored.",
            "version": version,
        }
    if power_action in {"stop", "delete", "auto-stop"} and phase in {"requested", "running", "backed-up", "stopping"}:
        return {
            "state": "stopping",
            "label": "Stopping",
            "detail": detail or "VM is stopping. Minecraft server is not expected to be reachable.",
            "version": version,
        }
    if power_action == "restart" and phase in {"requested", "running", "rebooting"}:
        return {
            "state": "starting",
            "label": "Restarting",
            "detail": detail or "VM is restarting. Waiting for Minecraft server status.",
            "version": version,
        }
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
        action_states = {
            "install-minecraft": "installing",
            "start-minecraft": "starting",
            "stop-minecraft": "stopping",
            "restart-minecraft": "starting",
            "remove-minecraft": "removing",
        }
        return {
            "state": action_states.get(power_action, "starting"),
            "label": action_labels.get(power_action, "Updating"),
            "detail": detail or "Minecraft server action is running.",
            "version": version,
        }
    if (
        power_action == "update-runtime-image"
        and phase in {"requested", "running"}
        and metadata_value(instance, RUNTIME_IMAGE_COMPONENT_METADATA_KEY).strip() == "minecraft"
    ):
        return {
            "state": "starting",
            "label": "Updating image",
            "detail": detail or metadata_value(instance, RUNTIME_IMAGE_DETAIL_METADATA_KEY) or "Updating Minecraft container image.",
            "version": version,
        }

    labels = {
        "not_installed": "Not installed",
        "installing": "Installing",
        "starting": "Starting",
        "running": "Ready",
        "stopping": "Stopping",
        "stopped": "Stopped",
        "backup": "Backup in progress",
        "restore": "Restore in progress",
        "removing": "Removing",
        "removed": "Removed",
        "error": "Error",
    }
    return {
        "state": state,
        "label": labels.get(state, state.title()),
        "detail": detail,
        "version": version,
    }


MINECRAFT_INSTALLED_STATES = {"running", "stopped"}


def minecraft_state(instance: dict[str, Any] | None) -> str:
    if instance is None:
        return "not_created"
    return metadata_value(instance, MINECRAFT_STATUS_METADATA_KEY).strip().lower() or "not_installed"


def minecraft_installed(instance: dict[str, Any] | None) -> bool:
    return minecraft_state(instance) in MINECRAFT_INSTALLED_STATES


def allowed_minecraft_commands(instance: dict[str, Any] | None) -> list[str]:
    # The selected server determines lifecycle eligibility. Keep the full
    # surface available here so a second stopped/running server is not hidden
    # by the legacy singleton status metadata.
    return ["install-minecraft", "start-minecraft", "stop-minecraft", "restart-minecraft", "remove-minecraft"]


def require_minecraft_command_allowed(instance: dict[str, Any] | None, command: str) -> None:
    if command in set(allowed_minecraft_commands(instance)):
        return

    state = minecraft_state(instance)
    if command == "install-minecraft" and minecraft_installed(instance):
        raise ApiError("Minecraft server is already installed. Use Start, Stop, Restart, or Remove.", 400)
    if command in {"start-minecraft", "stop-minecraft", "restart-minecraft", "remove-minecraft"} and not minecraft_installed(instance):
        raise ApiError("Minecraft server is not installed. Use Install first.", 400)
    raise ApiError(f'Minecraft action "{command}" is not available while server state is "{state}".', 400)


def has_attached_data_disk(instance: dict[str, Any] | None) -> bool:
    if instance is None:
        return False

    expected_device_name = metadata_value(instance, "vm-data-disk-device-name").strip() or data_disk_device_name()
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
    hardware_matches = instance_hardware_matches_selection(instance)
    if status == "RUNNING":
        if active_power_action(instance):
            return ["status"]
        gpu_type = metadata_value(instance, "vm-gpu-type").strip() or instance_accelerator_summary(instance)[0]
        if gpu_type in INCOMPATIBLE_SUNSHINE_ACCELERATORS:
            return ["status", "stop", "delete"]
        if not hardware_matches:
            return ["status", "stop", "delete"]
        # Deletion is intentionally available before the guest-ready marker.
        # A failed boot or unsupported GPU configuration must not leave a VM
        # that can be removed only through a direct API call.
        commands = ["status", "set-auto-stop", "delete"]
        if is_live_backup_ready(instance):
            commands.extend([
                "restart",
                "stop",
                "create-backup",
                "restore-backup",
                "remove-backup",
            ])
            if not is_gpu_disabled_for_instance(instance):
                commands.extend(["install-app", "uninstall-app"])
            commands.extend(allowed_minecraft_commands(instance))
        return commands
    if status == "TERMINATED" and not hardware_matches:
        return ["status", "create", "delete"]
    if status == "TERMINATED":
        return ["status", "start", "delete"]
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
        "scheduled": "Scheduled",
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


def reconcile_completed_restart_action(instance: dict[str, Any] | None) -> dict[str, Any] | None:
    """Finalize a guest reboot when the originating Cloud Run request did not survive it."""
    if instance is None or str(instance.get("status", "")).upper() != "RUNNING":
        return instance

    phase, action, token = parse_power_action_status(
        metadata_value(instance, POWER_ACTION_STATUS_METADATA_KEY)
    )
    if action != "restart" or phase != "rebooting":
        return instance
    if metadata_value(instance, POWER_ACTION_METADATA_KEY).strip():
        return instance

    sunshine_state = metadata_value(instance, SUNSHINE_STATUS_METADATA_KEY).strip().lower()
    expected_state = "disabled" if is_gpu_disabled_for_instance(instance) else "ready"
    if sunshine_state not in {expected_state, "error"}:
        return instance

    final_phase = "failed" if sunshine_state == "error" else "restarted"
    set_instance_metadata_values(
        instance,
        {
            POWER_ACTION_STATUS_METADATA_KEY: f"{final_phase}:restart:{token}",
            POWER_ACTION_METADATA_KEY: None,
        },
    )
    return get_instance()


def build_status_payload(
    instance: dict[str, Any] | None,
    *,
    user: dict[str, Any],
    command: str,
    duckdns_updated: bool | None = None,
    sunshine_credentials: dict[str, str] | None = None,
) -> dict[str, Any]:
    instance = reconcile_completed_restart_action(instance)
    hardware = {
        "id": selected_hardware_id(),
        "zone": selected_zone(),
        "machineType": selected_machine_type(),
        "gpuType": selected_gpu_type(),
        "gpuCount": selected_gpu_count(),
        "acceleratorMode": selected_accelerator_mode(),
        "priceEstimate": safe_price_estimate(
            machine_type=selected_machine_type(),
            gpu_type=selected_gpu_type(),
            gpu_count=selected_gpu_count(),
            zone=selected_zone(),
            allow_fetch=False,
        ),
    }
    if instance is None:
        payload = {
            "command": command,
            "target": {
                "project": CONFIG["project"],
                "zone": selected_zone(),
                "instance": selected_instance_name(),
                "baseInstance": bounded_gce_name(CONFIG["instance"]),
                "endpoint": endpoint_public_payload(selected_endpoint()),
            },
            "hardware": hardware,
            "status": STATUS_NOT_FOUND,
            "instanceExists": False,
            "allowedCommands": allowed_commands(None),
            "externalIp": "",
            "duckdnsDomains": selected_endpoint_domains(),
            "urls": build_urls(""),
            "user": user,
            "autoStopHours": "",
            "autoStop": build_auto_stop_status(None),
            "sunshineCredentials": {
                "username": SUNSHINE_USERNAME,
                "password": "",
            },
            "sunshineStatus": build_sunshine_status(None),
            "minecraftStatus": build_minecraft_status(None),
            "minecraftServers": [],
              "minecraftManagement": build_minecraft_management_payload(None, user),
            "minecraft": {
                **minecraft_version_payload(),
                "serverType": minecraft_server_type_from_instance(None),
            },
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

    actual_hardware = instance_hardware_selection(instance)
    hardware_matches = instance_hardware_matches_selection(instance)
    external_ip = extract_external_ip(instance)
    status = str(instance.get("status", "UNKNOWN"))
    credentials = sunshine_credentials or sunshine_credentials_from_instance(instance)
    if status != "RUNNING":
        credentials = {
            "username": credentials.get("username", SUNSHINE_USERNAME) or SUNSHINE_USERNAME,
            "password": "",
        }
    minecraft_servers = minecraft_servers_from_instance(instance)
    active_minecraft_server_id = selected_minecraft_server_id(instance, {})
    active_minecraft_server = next(
        (server for server in minecraft_servers if server["id"] == active_minecraft_server_id),
        None,
    )
    active_minecraft_port = int(active_minecraft_server["gamePort"]) if active_minecraft_server else int(CONFIG["minecraft_port"])
    minecraft_payload = {
        **minecraft_version_payload(),
        "serverType": (
            str(active_minecraft_server["serverType"])
            if active_minecraft_server
            else minecraft_server_type_from_instance(instance)
        ),
        "activeServerId": active_minecraft_server_id if active_minecraft_server else "",
        "gamePort": active_minecraft_port,
    }
    if active_minecraft_server:
        minecraft_payload["installedVersion"] = str(active_minecraft_server["version"])
    payload = {
        "command": command,
        "target": {
            "project": CONFIG["project"],
            "zone": selected_zone(),
            "instance": selected_instance_name(),
            "baseInstance": bounded_gce_name(CONFIG["instance"]),
            "endpoint": endpoint_public_payload(selected_endpoint()),
        },
        "hardware": hardware,
        "actualHardware": actual_hardware,
        "hardwareMatchesSelection": hardware_matches,
        "status": status,
        "instanceExists": True,
        "allowedCommands": allowed_commands(instance),
        "externalIp": external_ip,
        "duckdnsDomains": selected_endpoint_domains(),
        "urls": build_urls(external_ip, active_minecraft_port),
        "user": user,
        "autoStopHours": metadata_value(instance, AUTO_STOP_METADATA_KEY),
        "autoStop": build_auto_stop_status(instance),
        "sunshineCredentials": normalize_sunshine_credentials_for_response(credentials),
        "sunshineStatus": build_sunshine_status(instance),
        "minecraftStatus": build_minecraft_status(instance, active_minecraft_server),
        "minecraftServers": minecraft_servers,
          "minecraftManagement": build_minecraft_management_payload(instance, user),
        "minecraft": minecraft_payload,
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
        last_status = str(last_instance.get("status", "UNKNOWN"))
        raise ApiError(
            f"Timed out waiting for instance to reach {target_status}; last state was {last_status}.",
            504,
        )
    raise ApiError(f"Timed out waiting for instance to reach {target_status}.", 504)


def poll_specific_instance_status(
    instance: dict[str, Any],
    target_status: str,
    timeout_seconds: int = 300,
) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_instance: dict[str, Any] | None = None
    url = instance_self_url(instance)
    while time.time() < deadline:
        data = compute_request("GET", url, allow_404=True)
        last_instance = data if isinstance(data, dict) else None
        if last_instance and str(last_instance.get("status", "")).upper() == target_status.upper():
            return last_instance
        time.sleep(3)

    if last_instance:
        last_status = str(last_instance.get("status", "UNKNOWN"))
        raise ApiError(
            f"Timed out waiting for instance {instance.get('name', '<unknown>')} to reach {target_status}; last state was {last_status}.",
            504,
        )
    raise ApiError(f"Timed out waiting for instance {instance.get('name', '<unknown>')} to reach {target_status}.", 504)


def instance_identity(instance: dict[str, Any]) -> tuple[str, str]:
    return (str(instance.get("name", "") or ""), instance_zone_name(instance))


def is_selected_instance(instance: dict[str, Any]) -> bool:
    return instance_identity(instance) == (selected_instance_name(), selected_zone())


def running_managed_instances_except_selected() -> list[dict[str, Any]]:
    return [
        instance
        for instance in list_managed_compute_instances()
        if str(instance.get("status", "")).upper() == "RUNNING" and not is_selected_instance(instance)
    ]


def running_instance_summary(instance: dict[str, Any]) -> str:
    hardware = instance_hardware_selection(instance)
    label = str(hardware.get("label", "") or hardware.get("id", "") or "unknown hardware")
    return f"{instance.get('name', '<unknown>')} ({label}, {instance_zone_name(instance)})"


def ensure_no_other_running_instances_or_stop(payload: dict[str, Any], command: str) -> list[dict[str, Any]]:
    running_instances = running_managed_instances_except_selected()
    if not running_instances:
        return []

    summaries = ", ".join(running_instance_summary(instance) for instance in running_instances)
    if not bool(payload.get("stopRunningInstances")):
        raise ApiError(
            f'Another VM is already running: {summaries}. Confirm stopping it before running "{command}".',
            409,
        )

    stopped: list[dict[str, Any]] = []
    for instance in running_instances:
        require_no_active_power_action(instance, f"stop-before-{command}")
        require_live_backup_ready(instance, f"stop-before-{command}")
        updated_instance, token = request_live_power_action(
            instance,
            action="stop",
            status_detail=f'Stopping this VM before running "{command}" on another target.',
        )
        final_instance = poll_specific_instance_status(updated_instance, "TERMINATED", timeout_seconds=900)
        set_instance_metadata_values(
            final_instance,
            {
                AUTO_STOP_METADATA_KEY: None,
                AUTO_STOP_AT_METADATA_KEY: None,
                SUNSHINE_STATUS_METADATA_KEY: "stopped",
                SUNSHINE_STATUS_DETAIL_METADATA_KEY: None,
                POWER_ACTION_STATUS_METADATA_KEY: f"stopped:stop:{token}",
                POWER_ACTION_METADATA_KEY: None,
            },
        )
        refreshed = compute_request("GET", instance_self_url(final_instance))
        stopped.append(refreshed if isinstance(refreshed, dict) else final_instance)
    return stopped


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
    endpoint_domains = selected_endpoint_domains()
    if not external_ip or not endpoint_domains or not CONFIG["duckdns_token"]:
        return False

    updated = True
    for domain in endpoint_domains:
        subdomain = domain.removesuffix(".duckdns.org")
        domain_updated = False
        last_error = ""
        for attempt in range(1, 5):
            try:
                response = requests.get(
                    "https://www.duckdns.org/update",
                    params={
                        "domains": subdomain,
                        "token": CONFIG["duckdns_token"],
                        "ip": external_ip,
                    },
                    timeout=15,
                )
            except requests.RequestException as error:
                last_error = str(error).replace(CONFIG["duckdns_token"], "<redacted>")
                logging.warning(
                    "DuckDNS update attempt %s failed for %s: %s",
                    attempt,
                    domain,
                    last_error,
                )
                time.sleep(min(attempt * 2, 8))
                continue
            if response.text.strip() == "OK":
                logging.info("DuckDNS updated for %s -> %s", domain, external_ip)
                domain_updated = True
                break
            last_error = response.text.strip()
            logging.warning(
                "DuckDNS update attempt %s failed for %s: %s",
                attempt,
                domain,
                last_error,
            )
            time.sleep(min(attempt * 2, 8))
        if not domain_updated:
            logging.warning("DuckDNS update failed for %s after retries: %s", domain, last_error)
            updated = False
    return updated


def minecraft_management_player_name(payload: dict[str, Any]) -> str:
    player = str(payload.get("player", "") or "").strip()
    if not (3 <= len(player) <= 16 and all(char.isalnum() or char == "_" for char in player)):
        raise ApiError("Minecraft player name must contain 3-16 letters, digits, or underscores.", 400)
    return player


def minecraft_management_property_update(payload: dict[str, Any]) -> dict[str, str]:
    property_name = str(payload.get("property", "") or "").strip()
    value = str(payload.get("value", ""))
    if not re.fullmatch(r"[A-Za-z0-9.-]{1,80}", property_name):
        raise ApiError("Invalid server.properties option.", 400)
    if property_name in MINECRAFT_SERVER_PROPERTY_BLOCKED:
        raise ApiError(f"{property_name} is managed by the VM deployment and cannot be changed here.", 400)
    if len(value) > 512 or "\r" in value or "\n" in value:
        raise ApiError("A server.properties value must be a single line up to 512 characters.", 400)

    rule = MINECRAFT_SERVER_PROPERTY_RULES.get(property_name, {})
    kind = rule.get("kind")
    if kind == "boolean" and value not in {"true", "false"}:
        raise ApiError(f"{property_name} must be true or false.", 400)
    if kind == "enum" and value not in set(rule.get("suggestions", [])):
        raise ApiError(f"{property_name} must be one of: {', '.join(rule['suggestions'])}.", 400)
    if kind == "integer":
        if not re.fullmatch(r"-?[0-9]+", value):
            raise ApiError(f"{property_name} must be an integer.", 400)
        numeric_value = int(value)
        if numeric_value < int(rule["minimum"]) or numeric_value > int(rule["maximum"]):
            raise ApiError(f"{property_name} must be between {rule['minimum']} and {rule['maximum']}.", 400)
    return {"property": property_name, "value": value}


def minecraft_management_console_command(payload: dict[str, Any]) -> str:
    command = str(payload.get("command", "") or "").strip()
    if not command or len(command) > 300 or any(ord(char) < 32 for char in command):
        raise ApiError("Console command must be 1-300 printable characters.", 400)
    normalized = command.lower().lstrip("/").strip()
    dangerous = re.match(
        r"^(stop|op\s|deop\s|ban(?:-ip)?\s|pardon(?:-ip)?\s|kick\s|whitelist\s+(?:add|remove|on|off|reload)\b|save-off\b|reload\b)",
        normalized,
    )
    if dangerous and payload.get("confirmDangerous") is not True:
        raise ApiError("This RCON command requires explicit confirmation in the management panel.", 400)
    return command


def minecraft_management_request_payload(payload: dict[str, Any]) -> dict[str, str]:
    action = str(payload.get("action", "") or "").strip().lower()
    allowed_actions = {
        "console",
        "players",
        "whitelist-list",
        "whitelist-add",
        "whitelist-remove",
        "op-list",
        "op-add",
        "op-remove",
        "restart",
        "properties-read",
        "properties-update",
        "command-suggestions",
    }
    if action not in allowed_actions:
        raise ApiError("Unsupported Minecraft management action.", 400)

    request_payload = {"id": secrets.token_urlsafe(18), "action": action, "serverId": minecraft_server_id(payload)}
    if action == "console":
        request_payload["command"] = minecraft_management_console_command(payload)
    elif action.endswith("-add") or action.endswith("-remove"):
        request_payload["player"] = minecraft_management_player_name(payload)
    elif action == "properties-update":
        request_payload.update(minecraft_management_property_update(payload))
    return request_payload


def minecraft_content_sync_request(entries: list[dict[str, Any]], removed_files: list[str] | None = None) -> dict[str, Any]:
    return {
        "id": secrets.token_urlsafe(18),
        "action": "content-sync",
        "serverId": "default",
        "entries": [f"{entry['projectId']}:{entry['versionId']}" for entry in entries],
        "expectedFiles": sorted(
            {
                filename
                for entry in entries
                for filename in entry.get("files", [])
                if isinstance(filename, str) and re.fullmatch(r"[A-Za-z0-9._+-]{1,240}\.jar", filename)
            }
        ),
        "expectedChecksums": [
            {"filename": filename, "sha512": str((entry.get("checksums") or {}).get(filename) or "").lower()}
            for entry in entries
            for filename in entry.get("files", [])
            if isinstance(filename, str)
            and re.fullmatch(r"[A-Za-z0-9._+-]{1,240}\.jar", filename)
            and re.fullmatch(r"[a-fA-F0-9]{128}", str((entry.get("checksums") or {}).get(filename) or ""))
        ],
        "removeFiles": [filename for filename in (removed_files or []) if re.fullmatch(r"[A-Za-z0-9._+-]{1,240}\.jar", filename)],
    }


def wait_for_minecraft_management_result(request_id: str, timeout_seconds: int = 75) -> tuple[dict[str, Any], dict[str, Any]]:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        instance = get_instance_or_none()
        if instance is None:
            raise ApiError("VM was removed while executing the Minecraft management action.", 409)
        result = minecraft_management_request_result(instance)
        if result.get("id") == request_id and result.get("state") in {"done", "failed"}:
            return instance, result
        time.sleep(2)
    raise ApiError("Minecraft management action is still pending on the VM. Refresh the panel shortly.", 504)


def execute_minecraft_management_action(
    instance: dict[str, Any] | None,
    user: dict[str, Any],
    payload: dict[str, Any],
) -> dict[str, Any]:
    action = str(payload.get("action", "") or "").strip().lower()
    if instance is None:
        raise ApiError("Create the selected VM before using Minecraft management.", 409)
    selected_server_id = selected_minecraft_server_id(instance, payload)
    payload = {**payload, "minecraftServerId": selected_server_id}
    if action == "prepare-agent":
        prepare_minecraft_management_agent(instance)
        refreshed = get_instance()
        return build_minecraft_management_payload(
            refreshed,
            user,
            selected_server_id=selected_server_id,
            message="Minecraft management agent was prepared. Restart the VM once from the main GUI to activate it.",
        )

    selected_server = minecraft_server_by_id(instance, selected_server_id)
    if selected_server is None or selected_server.get("state") == "removed":
        raise ApiError("Selected Minecraft server is not installed on this VM.", 404)
    if action == "catalog-search":
        results, skipped = minecraft_modrinth_catalog_search(instance, payload)
        return build_minecraft_management_payload(
            instance,
            user,
            selected_server_id=selected_server_id,
            message=f"Found {len(results)} verified compatible Modrinth result(s). {skipped} result(s) were skipped because their server artifact could not be verified.",
            catalog_results=results,
        )
    if str(instance.get("status", "")).upper() != "RUNNING" or selected_server.get("state") != "running":
        raise ApiError("Start the selected Minecraft server before using management controls.", 409)
    if not minecraft_management_agent_ready(instance):
        raise ApiError(
            "Minecraft management agent is not active yet. Prepare it and restart the VM from the main GUI.",
            409,
        )

    updated_content: list[dict[str, str]] | None = None
    if action == "content-install":
        instance = migrate_unambiguous_legacy_minecraft_content(instance)
        selected_server = minecraft_server_by_id(instance, selected_server_id)
        if selected_server is None:
            raise ApiError("Selected Minecraft server is not installed on this VM.", 404)
        entry = minecraft_modrinth_content_entry(instance, payload)
        current_content = normalize_minecraft_modrinth_content(selected_server.get("content", []))
        if any(item["projectId"] == entry["projectId"] for item in current_content):
            raise ApiError("This Modrinth project is already installed. Remove it before selecting another version.", 409)
        updated_content = [*current_content, entry]
        request_payload = minecraft_content_sync_request(updated_content)
        request_payload["serverId"] = selected_server_id
    elif action == "content-remove":
        project_id = str(payload.get("projectId") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{3,80}", project_id):
            raise ApiError("Invalid Modrinth project ID.", 400)
        current_content = normalize_minecraft_modrinth_content(selected_server.get("content", []))
        updated_content = [item for item in current_content if item["projectId"] != project_id]
        if len(updated_content) == len(current_content):
            raise ApiError("The selected Modrinth project is not installed.", 404)
        removed_files = [filename for item in current_content if item["projectId"] == project_id for filename in item.get("files", [])]
        request_payload = minecraft_content_sync_request(updated_content, removed_files)
        request_payload["serverId"] = selected_server_id
    else:
        request_payload = minecraft_management_request_payload(payload)
    set_instance_metadata_values(
        instance,
        {
            MINECRAFT_MANAGEMENT_REQUEST_METADATA_KEY: json.dumps(request_payload, separators=(",", ":")),
            MINECRAFT_MANAGEMENT_RESULT_METADATA_KEY: json.dumps(
                {
                    "id": request_payload["id"],
                    "action": request_payload["action"],
                    "serverId": selected_server_id,
                    "state": "queued",
                    "output": "",
                    "completedAt": "",
                },
                separators=(",", ":"),
            ),
        },
    )
    refreshed, result = wait_for_minecraft_management_result(
        request_payload["id"],
        timeout_seconds=300 if updated_content is not None else 75,
    )
    if updated_content is not None and result.get("state") == "done":
        refreshed = update_minecraft_server_content(refreshed, selected_server_id, updated_content)
    message = "Minecraft management action completed." if result.get("state") == "done" else "Minecraft management action failed on the VM."
    return build_minecraft_management_payload(
        refreshed,
        user,
        selected_server_id=selected_server_id,
        result=result,
        message=message,
    )


def execute_command(command: str, user: dict[str, Any], payload: dict[str, Any] | None = None) -> dict[str, Any]:
    logging.info("VM command=%s user=%s", command, user.get("email", "<unknown>"))
    payload = payload or {}
    current_instance = get_instance_or_none()
    current_status = str(current_instance.get("status", STATUS_NOT_FOUND)) if current_instance else STATUS_NOT_FOUND

    if command == "status":
        if current_instance is not None and current_status == "TERMINATED":
            try:
                current_instance = release_selected_endpoint_ephemeral_ip(current_instance)
            except ApiError as error:
                logging.warning("Automatic endpoint IP cleanup after stop failed: %s", error)
        return build_status_payload(current_instance, user=user, command=command)

    require_no_active_power_action(current_instance, command)

    if command == "create":
        if selected_gpu_count() > 0:
            gpu_hardware_profile(selected_hardware_id())
        auto_stop_hours = parse_auto_stop_hours(payload)
        if current_instance is not None:
            if current_status != "TERMINATED" or instance_hardware_matches_selection(current_instance):
                raise ApiError("Instance already exists.", 400)

            current_instance, sunshine_credentials = ensure_sunshine_credentials(current_instance)
            current_instance = reconcile_stopped_instance_hardware(current_instance)
            current_instance = ensure_instance_virtual_display(current_instance)
            current_instance = release_selected_endpoint_ephemeral_ip(current_instance)
            current_instance = ensure_instance_external_access_config(current_instance)
            set_instance_metadata_values(
                current_instance,
                start_metadata_updates(
                    auto_stop_hours=auto_stop_hours,
                    sunshine_credentials=sunshine_credentials,
                ),
            )
            current_instance = get_instance()
            operation = compute_request("POST", f"{instance_url()}/start")
            if not isinstance(operation, dict):
                raise ApiError("Failed to start VM instance.", 502)
            wait_for_zone_operation(operation, timeout_seconds=180)
            poll_instance_status("RUNNING", timeout_seconds=240)
            final_instance = wait_for_external_ip(timeout_seconds=180)
            bind_selected_endpoint_to_instance(final_instance)
            updated = update_duckdns(extract_external_ip(final_instance))
            return build_status_payload(
                final_instance,
                user=user,
                command=command,
                duckdns_updated=updated,
                sunshine_credentials=sunshine_credentials,
            )

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
        bind_selected_endpoint_to_instance(final_instance)
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
        if current_status == "RUNNING" and not instance_hardware_matches_selection(current_instance):
            raise ApiError("Hardware profile can only be changed while the VM is stopped.", 400)

        sunshine_credentials = sunshine_credentials_from_instance(current_instance)
        if current_status != "RUNNING":
            current_instance, sunshine_credentials = ensure_sunshine_credentials(current_instance)
            current_instance = reconcile_stopped_instance_hardware(current_instance)
            current_instance = release_selected_endpoint_ephemeral_ip(current_instance)
            current_instance = ensure_instance_external_access_config(current_instance)
            set_instance_metadata_values(
                current_instance,
                start_metadata_updates(
                    auto_stop_hours=auto_stop_hours,
                    sunshine_credentials=sunshine_credentials,
                ),
            )
            current_instance = get_instance()

        if current_status != "RUNNING":
            operation = compute_request("POST", f"{instance_url()}/start")
            if not isinstance(operation, dict):
                raise ApiError("Failed to start VM instance.", 502)
            wait_for_zone_operation(operation, timeout_seconds=180)
            poll_instance_status("RUNNING")
            final_instance = wait_for_external_ip(timeout_seconds=120)
        else:
            final_instance = wait_for_external_ip()
        bind_selected_endpoint_to_instance(final_instance)
        updated = update_duckdns(extract_external_ip(final_instance))
        return build_status_payload(
            final_instance,
            user=user,
            command=command,
            duckdns_updated=updated,
            sunshine_credentials=sunshine_credentials,
        )

    if command == "set-auto-stop":
        if current_instance is None:
            raise ApiError("Instance does not exist. Use Create first.", 400)
        if current_status != "RUNNING":
            raise ApiError("Auto-stop can only be extended while the VM is running.", 400)
        auto_stop_hours = parse_auto_stop_hours(payload)
        if auto_stop_hours is None:
            raise ApiError("Auto-stop hours are required.", 400)
        current_instance, token = request_live_power_action(
            current_instance,
            action="set-auto-stop",
            status_detail="Updating auto-stop timer.",
            extra_metadata={AUTO_STOP_METADATA_KEY: str(auto_stop_hours)},
            sunshine_state=None,
        )
        final_instance = wait_for_power_action_phase(
            action="set-auto-stop",
            token=token,
            target_phase="scheduled",
            timeout_seconds=120,
        )
        return build_status_payload(final_instance, user=user, command=command)

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
        final_instance = release_selected_endpoint_ephemeral_ip(final_instance)
        set_instance_metadata_values(
            final_instance,
            {
                AUTO_STOP_METADATA_KEY: None,
                AUTO_STOP_AT_METADATA_KEY: None,
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
            final_instance = get_instance()
            return build_status_payload(
                final_instance,
                user=user,
                command=command,
                sunshine_credentials=sunshine_credentials,
            )
        operation = compute_request("POST", f"{instance_url()}/start")
        if not isinstance(operation, dict):
            raise ApiError("Failed to start VM instance.", 502)
        wait_for_zone_operation(operation, timeout_seconds=180)
        poll_instance_status("RUNNING")
        final_instance = wait_for_external_ip(timeout_seconds=120)
        bind_selected_endpoint_to_instance(final_instance)
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
            if is_live_backup_ready(current_instance):
                current_instance, _ = request_live_power_action(
                    current_instance,
                    action="delete",
                    status_detail="VM deleting without creating a backup.",
                )
            else:
                # Delete no longer creates a backup. A VM which has not reached
                # the guest-ready marker must still be removable, for example
                # after a failed startup or an unsupported GPU configuration.
                # Stop it at the Compute Engine layer before deleting it.
                operation = compute_request("POST", f"{instance_url()}/stop")
                if not isinstance(operation, dict):
                    raise ApiError("Failed to stop VM instance before deletion.", 502)
            poll_instance_status("TERMINATED", timeout_seconds=900)
        elif current_status != "TERMINATED":
            poll_instance_status("TERMINATED", timeout_seconds=900)
        operation = compute_request("DELETE", instance_url())
        if not isinstance(operation, dict):
            raise ApiError("Failed to delete instance.", 502)
        wait_for_zone_operation(operation, timeout_seconds=180)
        poll_instance_deleted(timeout_seconds=120)
        endpoint = selected_endpoint()
        if str(endpoint.get("staticIp", "") or "") and not endpoint_has_manual_static_ip(endpoint):
            release_endpoint_static_address(endpoint)
        else:
            unbind_selected_endpoint_instance()
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
        if is_gpu_disabled_for_instance(current_instance):
            raise ApiError(
                "Application changes require a GPU-enabled VM because Steam Headless and Sunshine are not started on CPU-only VMs.",
                409,
            )
        if command == "install-app":
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
        # Initial Minecraft installation changes the VM's persistent runtime
        # layout and must not race the startup restore/backup sequence. Once a
        # server already exists, its lifecycle actions are handled by the live
        # VM agent and do not depend on that backup marker.
        if command == "install-minecraft":
            require_live_backup_ready(current_instance, command)
        minecraft_server_id_value = minecraft_server_id(payload, required=command == "install-minecraft")
        servers = minecraft_servers_from_instance(current_instance)
        existing_server = next((server for server in servers if server["id"] == minecraft_server_id_value), None)
        if command == "install-minecraft":
            if existing_server and existing_server.get("state") == "installing":
                phase, action, _ = parse_power_action_status(
                    metadata_value(current_instance, POWER_ACTION_STATUS_METADATA_KEY)
                )
                if action != "install-minecraft" or phase not in {"requested", "running"}:
                    existing_server["state"] = "error"
                    existing_server["detail"] = "Previous installation did not complete. Ready to retry."
                    current_instance = update_minecraft_server_registry(current_instance, servers)
            if existing_server and existing_server.get("state") not in {"removed", "error"}:
                raise ApiError("A Minecraft server with this ID already exists. Select it and use lifecycle controls.", 409)
            game_port = int(existing_server["gamePort"]) if existing_server and existing_server.get("state") == "error" else minecraft_next_game_port([
                server for server in servers
                if server.get("id") != minecraft_server_id_value and server.get("state") != "removed"
            ])
        else:
            if existing_server is None or existing_server.get("state") == "removed":
                raise ApiError("Select an installed Minecraft server before running its lifecycle action.", 404)
            game_port = int(existing_server["gamePort"])
            current_server_state = str(existing_server.get("state") or "").lower()
            expected_states = {
                "start-minecraft": {"stopped"},
                "stop-minecraft": {"running"},
                "restart-minecraft": {"running"},
                "remove-minecraft": {"running", "stopped", "error"},
            }[command]
            if current_server_state not in expected_states:
                raise ApiError(
                    f'Minecraft server "{minecraft_server_id_value}" cannot run "{command}" while it is {current_server_state or "unknown"}.',
                    409,
                )
        minecraft_server_type = (
            parse_minecraft_server_type(payload)
            if command == "install-minecraft"
            else str(existing_server["serverType"])
        )
        minecraft_version = (
            concrete_minecraft_version(parse_minecraft_version(payload, minecraft_server_type), minecraft_server_type)
            if command == "install-minecraft"
            else str(existing_server["version"])
        )
        if command == "install-minecraft":
            server_record = {
                "id": minecraft_server_id_value,
                "version": minecraft_version,
                "serverType": minecraft_server_type,
                "gamePort": game_port,
                "state": "installing",
                "detail": f"Installing {minecraft_server_type_spec(minecraft_server_type)['label']} {minecraft_version}.",
                "content": [],
            }
            servers = [server for server in servers if server["id"] != minecraft_server_id_value] + [server_record]
            current_instance = update_minecraft_server_registry(current_instance, servers)
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
                MINECRAFT_STATUS_DETAIL_METADATA_KEY: (
                    f"Installing {minecraft_server_type_spec(minecraft_server_type)['label']} Minecraft server {minecraft_version}."
                    if command == "install-minecraft"
                    else f"Running {command}."
                ),
                MINECRAFT_VERSION_METADATA_KEY: minecraft_version,
                MINECRAFT_SERVER_TYPE_METADATA_KEY: minecraft_server_type,
                MINECRAFT_SERVER_ID_METADATA_KEY: minecraft_server_id_value,
                MINECRAFT_GAME_PORT_METADATA_KEY: str(game_port),
            },
        )
        try:
            final_instance = wait_for_power_action_phase(
                action=command,
                token=token,
                target_phase=target_phase,
                timeout_seconds=1200,
            )
        except ApiError as error:
            failed_instance = get_instance()
            failed_servers = minecraft_servers_from_instance(failed_instance)
            for server in failed_servers:
                if server["id"] == minecraft_server_id_value:
                    server["state"] = "error"
                    server["detail"] = str(error)
            update_minecraft_server_registry(failed_instance, failed_servers)
            raise
        final_servers = minecraft_servers_from_instance(final_instance)
        final_state = {
            "install-minecraft": "running",
            "start-minecraft": "running",
            "stop-minecraft": "stopped",
            "restart-minecraft": "running",
            "remove-minecraft": "removed",
        }[command]
        for server in final_servers:
            if server["id"] == minecraft_server_id_value:
                server["state"] = final_state
                server["detail"] = f"Minecraft server {final_state}."
                if command == "remove-minecraft":
                    server["content"] = []
        final_instance = update_minecraft_server_registry(final_instance, final_servers)
        final_instance = wait_for_external_ip(timeout_seconds=180)
        bind_selected_endpoint_to_instance(final_instance)
        updated = update_duckdns(extract_external_ip(final_instance))
        return build_status_payload(
            final_instance,
            user=user,
            command=command,
            duckdns_updated=updated,
        )

    raise ApiError("Unsupported command.", 400)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
MINECRAFT_SERVER_PROPERTY_RULES = {
    "max-players": {"kind": "integer", "minimum": 1, "maximum": 1000, "description": "Maximum number of simultaneous players."},
    "view-distance": {"kind": "integer", "minimum": 3, "maximum": 32, "description": "Server-side chunk view distance."},
    "simulation-distance": {"kind": "integer", "minimum": 3, "maximum": 32, "description": "Chunk distance in which game logic is simulated."},
    "difficulty": {"kind": "enum", "suggestions": ["peaceful", "easy", "normal", "hard"], "description": "Default world difficulty."},
    "gamemode": {"kind": "enum", "suggestions": ["survival", "creative", "adventure", "spectator"], "description": "Default game mode for new players."},
    "level-type": {"kind": "enum", "suggestions": ["minecraft:normal", "minecraft:flat", "minecraft:large_biomes", "minecraft:amplified", "minecraft:single_biome_surface"], "description": "World generator type; applies when a world is created."},
    "motd": {"kind": "text", "description": "Server description shown in the multiplayer list."},
    "level-name": {"kind": "text", "description": "World directory name; changing it loads or creates another world."},
    "level-seed": {"kind": "text", "description": "Seed used only when a new world is created."},
    "online-mode": {"kind": "boolean", "suggestions": ["true", "false"], "description": "Require Mojang account authentication. Keep enabled for public servers."},
    "white-list": {"kind": "boolean", "suggestions": ["true", "false"], "description": "Enable the whitelist enforced by the access-control panel."},
    "enforce-whitelist": {"kind": "boolean", "suggestions": ["true", "false"], "description": "Disconnect non-whitelisted players immediately when the whitelist changes."},
    "pvp": {"kind": "boolean", "suggestions": ["true", "false"], "description": "Allow player-versus-player damage."},
    "allow-flight": {"kind": "boolean", "suggestions": ["true", "false"], "description": "Allow clients to fly without being kicked."},
    "allow-nether": {"kind": "boolean", "suggestions": ["true", "false"], "description": "Allow travel to the Nether."},
    "hardcore": {"kind": "boolean", "suggestions": ["true", "false"], "description": "Enable hardcore mode for the world."},
    "spawn-animals": {"kind": "boolean", "suggestions": ["true", "false"], "description": "Allow passive animal spawning."},
    "spawn-monsters": {"kind": "boolean", "suggestions": ["true", "false"], "description": "Allow hostile monster spawning."},
    "spawn-npcs": {"kind": "boolean", "suggestions": ["true", "false"], "description": "Allow NPC spawning."},
    "force-gamemode": {"kind": "boolean", "suggestions": ["true", "false"], "description": "Apply the default game mode when players join."},
    "spawn-protection": {"kind": "integer", "minimum": 0, "maximum": 64, "description": "Protected radius around world spawn for non-operators."},
    "player-idle-timeout": {"kind": "integer", "minimum": 0, "maximum": 2147483647, "description": "Minutes before idle players are kicked; 0 disables the timeout."},
    "op-permission-level": {"kind": "integer", "minimum": 1, "maximum": 4, "description": "Permission level granted to server operators."},
    "entity-broadcast-range-percentage": {"kind": "integer", "minimum": 10, "maximum": 1000, "description": "Entity tracking range as a percentage."},
    "network-compression-threshold": {"kind": "integer", "minimum": -1, "maximum": 2147483647, "description": "Packet size threshold for network compression; -1 disables it."},
}
MINECRAFT_SERVER_PROPERTY_BLOCKED = {
    "enable-rcon",
    "rcon.password",
    "rcon.port",
    "enable-query",
    "query.port",
    "server-ip",
    "server-port",
}

MINECRAFT_COMMAND_SUGGESTIONS_METADATA_KEY = "vm-minecraft-rcon-suggestions"
MINECRAFT_RCON_COMMAND_CATALOG = [
    {"command": "help", "template": "help [command]", "description": "Show commands available on this server.", "dangerous": False},
    {"command": "list", "template": "list", "description": "Show online players.", "dangerous": False},
    {"command": "say", "template": "say <message>", "description": "Broadcast a message to every online player.", "dangerous": False},
    {"command": "time", "template": "time set day", "description": "Set the world time. Replace day with night, noon, midnight, or a tick value.", "dangerous": False},
    {"command": "weather", "template": "weather clear", "description": "Set weather to clear, rain, or thunder.", "dangerous": False},
    {"command": "difficulty", "template": "difficulty normal", "description": "Set peaceful, easy, normal, or hard difficulty.", "dangerous": False},
    {"command": "gamemode", "template": "gamemode survival <player>", "description": "Set a player's game mode. Online player hints can fill the placeholder.", "dangerous": False},
    {"command": "gamerule", "template": "gamerule keepInventory true", "description": "Change a world game rule.", "dangerous": False},
    {"command": "whitelist", "template": "whitelist list", "description": "Show the whitelist. Add, remove, on, off, and reload require confirmation.", "dangerous": False},
    {"command": "save-all", "template": "save-all", "description": "Save loaded chunks immediately.", "dangerous": False},
    {"command": "kick", "template": "kick <player> [reason]", "description": "Disconnect a player from the server.", "dangerous": True},
    {"command": "op", "template": "op <player>", "description": "Grant a player operator access.", "dangerous": True},
    {"command": "deop", "template": "deop <player>", "description": "Remove a player's operator access.", "dangerous": True},
    {"command": "stop", "template": "stop", "description": "Stop the Minecraft server process.", "dangerous": True},
]
