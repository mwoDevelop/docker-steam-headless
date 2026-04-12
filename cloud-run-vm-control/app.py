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
SUNSHINE_USERNAME = "admin"
MIN_AUTO_STOP_HOURS = 1
MAX_AUTO_STOP_HOURS = 24


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
        instance = get_instance()
        return jsonify(build_status_payload(instance, user=user, command="status"))

    if request.path == "/api/command":
        user = require_user()
        payload = request.get_json(silent=True) or {}
        command = str(payload.get("command", "")).strip().lower()
        if command not in {"status", "start", "stop", "restart"}:
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


def compute_request(method: str, url: str, **kwargs) -> dict[str, Any]:
    response = compute_session().request(method=method, url=url, timeout=30, **kwargs)
    if response.status_code == 404:
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
        if str(data.get("status", "")).upper() == "DONE":
            if data.get("error"):
                raise ApiError(str(data["error"]), 502)
            return
        time.sleep(2)
    raise ApiError(f"Timed out waiting for operation {operation_name}.", 504)


def get_instance() -> dict[str, Any]:
    return compute_request("GET", instance_url())


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


def set_instance_metadata_value(instance: dict[str, Any], key: str, value: str | None) -> None:
    metadata = instance.get("metadata", {}) or {}
    fingerprint = str(metadata.get("fingerprint", "") or "")
    if not fingerprint:
        raise ApiError("Instance metadata fingerprint is missing.", 502)

    items = [item for item in instance_metadata_items(instance) if item.get("key") != key]
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


def build_status_payload(
    instance: dict[str, Any],
    *,
    user: dict[str, Any],
    command: str,
    duckdns_updated: bool | None = None,
    sunshine_credentials: dict[str, str] | None = None,
) -> dict[str, Any]:
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
        "externalIp": external_ip,
        "duckdnsDomains": CONFIG["duckdns_domains"],
        "urls": build_urls(external_ip),
        "user": user,
        "autoStopHours": metadata_value(instance, AUTO_STOP_METADATA_KEY),
        "sunshineCredentials": credentials,
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


def wait_for_external_ip(timeout_seconds: int = 90) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_instance = get_instance()
    while time.time() < deadline:
        if extract_external_ip(last_instance):
            return last_instance
        time.sleep(3)
        last_instance = get_instance()
    return last_instance


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
    current_instance = get_instance()
    current_status = str(current_instance.get("status", "UNKNOWN"))

    if command == "status":
        return build_status_payload(current_instance, user=user, command=command)

    if command == "start":
        auto_stop_hours = parse_auto_stop_hours(payload)
        if auto_stop_hours is not None and current_status == "RUNNING":
            raise ApiError("Auto-stop can only be scheduled while starting a stopped VM.", 400)

        sunshine_credentials = sunshine_credentials_from_instance(current_instance)
        if current_status != "RUNNING":
            current_instance, sunshine_credentials = prepare_sunshine_credentials(current_instance)
            set_instance_metadata_value(
                current_instance,
                AUTO_STOP_METADATA_KEY,
                str(auto_stop_hours) if auto_stop_hours is not None else None,
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
        if current_status != "TERMINATED":
            compute_request("POST", f"{instance_url()}/stop")
        final_instance = poll_instance_status("TERMINATED")
        set_instance_metadata_value(final_instance, AUTO_STOP_METADATA_KEY, None)
        final_instance = get_instance()
        return build_status_payload(final_instance, user=user, command=command)

    if command == "restart":
        current_instance, sunshine_credentials = prepare_sunshine_credentials(current_instance)
        if current_status == "RUNNING":
            compute_request("POST", f"{instance_url()}/reset")
        else:
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

    raise ApiError("Unsupported command.", 400)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
