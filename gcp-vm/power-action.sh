#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[power-action] $*"
}

METADATA_HDR=( -H "Metadata-Flavor: Google" --silent --show-error )
STATE_DIR=${STATE_DIR:-/var/lib/vm-state}
BACKUP_READY_MARKER="${STATE_DIR}/backup-ready"
BACKUP_COMPLETE_MARKER="${STATE_DIR}/backup-complete"
PERSIST_SCRIPT=/usr/local/bin/vm-persist-state
POLL_INTERVAL_SECONDS=${POLL_INTERVAL_SECONDS:-5}
POWER_ACTION_METADATA_KEY="vm-pending-power-action"
POWER_ACTION_STATUS_METADATA_KEY="vm-power-action-status"
SUNSHINE_STATUS_METADATA_KEY="vm-sunshine-status"
SUNSHINE_STATUS_DETAIL_METADATA_KEY="vm-sunshine-status-detail"
MINECRAFT_STATUS_METADATA_KEY="vm-minecraft-status"
MINECRAFT_STATUS_DETAIL_METADATA_KEY="vm-minecraft-status-detail"
MINECRAFT_VERSION_METADATA_KEY="vm-minecraft-version"
STEAM_ENV_METADATA_KEY="steam-headless-env"
SELECTED_APPLICATION_METADATA_KEY="vm-selected-application-id"
ENVF=/opt/container-services/steam-headless/.env
COMPOSE_DIR=/opt/container-services/steam-headless
COMPOSE_GCE="${COMPOSE_DIR}/docker-compose.nvidia.privileged.gce.yml"
COMPOSE_OVERRIDE="${COMPOSE_DIR}/docker-compose.nvidia.privileged.override.yml"
COMPOSE_IMAGE_OVERRIDE="${COMPOSE_DIR}/docker-compose.image.override.yml"
MINECRAFT_ROOT=/mnt/games/minecraft-server
MINECRAFT_COMPOSE_FILE="${MINECRAFT_ROOT}/docker-compose.yml"
MINECRAFT_SERVICE=minecraft

metadata_get() {
  local key="$1"
  local response_code body_file
  body_file="$(mktemp)"
  response_code="$(curl "${METADATA_HDR[@]}" \
    -o "$body_file" \
    -w '%{http_code}' \
    "http://metadata/computeMetadata/v1/instance/attributes/${key}" || true)"
  case "$response_code" in
    200)
      cat "$body_file"
      ;;
    404)
      ;;
    *)
      if [[ -n "$response_code" ]]; then
        log "Metadata read for ${key} returned HTTP ${response_code}"
      fi
      ;;
  esac
  rm -f "$body_file"
}

normalize_metadata_value() {
  local value="$1"
  if [[ "$value" == "|-"$'\n'* ]]; then
    value="${value#|-$'\n'}"
  fi
  printf '%s\n' "$value"
}

metadata_token() {
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/instance/service-accounts/default/token" \
    | jq -r '.access_token'
}

project_id() {
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/project/project-id"
}

instance_name() {
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/instance/name"
}

zone_name() {
  local zone
  zone="$(curl "${METADATA_HDR[@]}" "http://metadata/computeMetadata/v1/instance/zone")"
  printf '%s\n' "${zone##*/}"
}

set_instance_metadata_values() {
  local updates_json="$1"
  local token project zone name attempt instance_json fingerprint items payload response_file response_code operation_name
  token="$(metadata_token || true)"
  project="$(project_id || true)"
  zone="$(zone_name || true)"
  name="$(instance_name || true)"
  [[ -n "$token" && -n "$project" && -n "$zone" && -n "$name" ]] || return 1

  for attempt in $(seq 1 8); do
    instance_json="$(curl --fail --silent --show-error \
      -H "Authorization: Bearer ${token}" \
      "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}")" || {
        sleep "$attempt"
        continue
      }
    fingerprint="$(printf '%s' "$instance_json" | jq -r '.metadata.fingerprint // empty')"
    [[ -n "$fingerprint" ]] || return 1
    items="$(printf '%s' "$instance_json" | jq '[.metadata.items // [] | .[]]')"
    payload="$(jq -n \
      --arg fingerprint "$fingerprint" \
      --argjson existing "$items" \
      --argjson updates "$updates_json" \
      '
        def update_items($existing; $updates):
          reduce ($updates | to_entries[]) as $entry (
            $existing;
            map(select(.key != $entry.key))
            + (if $entry.value == null then [] else [{key: $entry.key, value: $entry.value}] end)
          );
        {
          fingerprint: $fingerprint,
          items: update_items($existing; $updates)
        }
      ')"

    response_file="$(mktemp)"
    response_code="$(curl --silent --show-error \
      -o "$response_file" \
      -w '%{http_code}' \
      -X POST \
      -H "Authorization: Bearer ${token}" \
      -H "Content-Type: application/json" \
      -d "$payload" \
      "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}/setMetadata" || true)"

    if [[ "$response_code" == "200" ]]; then
      operation_name="$(jq -r '.name // empty' "$response_file")"
      rm -f "$response_file"
      if [[ -n "$operation_name" ]]; then
        curl --fail --silent --show-error \
          -X POST \
          -H "Authorization: Bearer ${token}" \
          "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/operations/${operation_name}/wait" >/dev/null || true
      fi
      return 0
    fi

    if [[ "$response_code" == "412" ]]; then
      rm -f "$response_file"
      sleep "$attempt"
      continue
    fi

    cat "$response_file" >&2 || true
    rm -f "$response_file"
    return 1
  done

  log "Failed to update instance metadata after retries."
  return 1
}

set_power_action_status() {
  local action="$1"
  local token="$2"
  local phase="$3"
  local pending_value="${4-__KEEP__}"
  local updates

  if [[ "$pending_value" == "__KEEP__" ]]; then
    updates="$(jq -n \
      --arg status_key "$POWER_ACTION_STATUS_METADATA_KEY" \
      --arg status_value "${phase}:${action}:${token}" \
      '{($status_key): $status_value}')"
  elif [[ -n "$pending_value" ]]; then
    updates="$(jq -n \
      --arg status_key "$POWER_ACTION_STATUS_METADATA_KEY" \
      --arg status_value "${phase}:${action}:${token}" \
      --arg pending_key "$POWER_ACTION_METADATA_KEY" \
      --arg pending_value "$pending_value" \
      '{($status_key): $status_value, ($pending_key): $pending_value}')"
  else
    updates="$(jq -n \
      --arg status_key "$POWER_ACTION_STATUS_METADATA_KEY" \
      --arg status_value "${phase}:${action}:${token}" \
      --arg pending_key "$POWER_ACTION_METADATA_KEY" \
      '{($status_key): $status_value, ($pending_key): null}')"
  fi

  set_instance_metadata_values "$updates"

  if [[ "$pending_value" == "" ]]; then
    for _ in $(seq 1 20); do
      if [[ -z "$(metadata_get "$POWER_ACTION_METADATA_KEY")" ]]; then
        return 0
      fi
      sleep 1
    done
    log "Pending power action metadata did not clear yet."
  fi
}

set_sunshine_status() {
  local state="$1"
  local detail="${2-}"
  local updates
  updates="$(jq -n \
    --arg state_key "$SUNSHINE_STATUS_METADATA_KEY" \
    --arg state_value "$state" \
    --arg detail_key "$SUNSHINE_STATUS_DETAIL_METADATA_KEY" \
    --arg detail_value "$detail" \
    '{($state_key): $state_value, ($detail_key): $detail_value}')"
  set_instance_metadata_values "$updates"
}

set_minecraft_status() {
  local state="$1"
  local detail="${2-}"
  local updates
  updates="$(jq -n \
    --arg state_key "$MINECRAFT_STATUS_METADATA_KEY" \
    --arg state_value "$state" \
    --arg detail_key "$MINECRAFT_STATUS_DETAIL_METADATA_KEY" \
    --arg detail_value "$detail" \
    '{($state_key): $state_value, ($detail_key): $detail_value}')"
  set_instance_metadata_values "$updates"
}

wait_for_local_minecraft_ready() {
  local container_id health_status
  for _ in $(seq 1 90); do
    container_id="$(docker ps --filter "name=^/${MINECRAFT_SERVICE}$" --format '{{.ID}}' | head -n 1 || true)"
    if [[ -n "$container_id" ]]; then
      health_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
      if [[ "$health_status" == "healthy" ]]; then
        set_minecraft_status "running" "Minecraft server healthcheck is healthy."
        return 0
      fi
      if [[ -z "$health_status" ]] && timeout 2 bash -c '</dev/tcp/127.0.0.1/25565' >/dev/null 2>&1; then
        set_minecraft_status "running" "Minecraft server port 25565 is reachable locally."
        return 0
      fi
    fi
    sleep 5
  done

  set_minecraft_status "starting" "Minecraft container started, but port 25565 is not reachable yet."
  return 1
}

validated_minecraft_version() {
  local version
  version="$(metadata_get "$MINECRAFT_VERSION_METADATA_KEY" | tr -d '\r' | head -n 1 || true)"
  version="${version:-LATEST}"
  if [[ "$version" == "LATEST" || "$version" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
    printf '%s\n' "$version"
    return 0
  fi
  log "Invalid Minecraft version metadata '${version}', falling back to LATEST."
  printf '%s\n' "LATEST"
}

ensure_minecraft_compose() {
  local version="${1:-LATEST}"
  mkdir -p "${MINECRAFT_ROOT}/data"
  cat > "$MINECRAFT_COMPOSE_FILE" <<EOF
services:
  minecraft:
    image: itzg/minecraft-server:latest
    container_name: minecraft
    restart: unless-stopped
    ports:
      - "25565:25565"
    environment:
      EULA: "TRUE"
      TYPE: "PAPER"
      VERSION: "${version}"
      MEMORY: "4G"
      MOTD: "Steam GPU Minecraft"
      ENABLE_AUTOPAUSE: "FALSE"
    volumes:
      - ./data:/data
EOF
}

minecraft_compose() {
  if [[ ! -f "$MINECRAFT_COMPOSE_FILE" ]]; then
    log "Minecraft compose file is missing at ${MINECRAFT_COMPOSE_FILE}."
    return 1
  fi
  (cd "$MINECRAFT_ROOT" && docker compose -f "$MINECRAFT_COMPOSE_FILE" "$@")
}

minecraft_installed() {
  [[ -f "$MINECRAFT_COMPOSE_FILE" ]]
}

minecraft_state() {
  local state
  state="$(metadata_get "$MINECRAFT_STATUS_METADATA_KEY" | tr '[:upper:]' '[:lower:]' | tr -d '\r' | head -n 1 || true)"
  printf '%s\n' "${state:-not_installed}"
}

fail_minecraft_action() {
  local action="$1"
  local token="$2"
  local state="$3"
  local detail="$4"
  log "Refusing ${action}: ${detail}"
  set_minecraft_status "$state" "$detail"
  set_power_action_status "$action" "$token" "failed" ""
  return 1
}

require_minecraft_state() {
  local action="$1"
  local token="$2"
  shift 2
  local state expected
  state="$(minecraft_state)"
  for expected in "$@"; do
    if [[ "$state" == "$expected" ]]; then
      return 0
    fi
  done
  if [[ "$state" == "not_installed" || "$state" == "removed" ]]; then
    fail_minecraft_action "$action" "$token" "not_installed" "Minecraft server is not installed. Use Install first."
  else
    fail_minecraft_action "$action" "$token" "error" "Minecraft action ${action} is not available while server state is ${state}."
  fi
}

require_minecraft_compose() {
  local action="$1"
  local token="$2"
  if minecraft_installed; then
    return 0
  fi
  fail_minecraft_action "$action" "$token" "not_installed" "Minecraft server files are missing. Use Install first."
}

run_minecraft_action() {
  local action="$1"
  local token="$2"
  local state version
  local target_phase="started"

  log "Running Minecraft action ${action}"
  set_power_action_status "$action" "$token" "running"

  case "$action" in
    install-minecraft)
      state="$(minecraft_state)"
      if [[ "$state" == "running" || "$state" == "stopped" ]]; then
        fail_minecraft_action "$action" "$token" "$state" "Minecraft server is already installed. Use Start, Stop, Restart, or Remove."
        return 1
      fi
      version="$(validated_minecraft_version)"
      set_minecraft_status "installing" "Installing Minecraft server ${version}."
      ensure_minecraft_compose "$version"
      minecraft_compose pull
      minecraft_compose up -d
      if ! wait_for_local_minecraft_ready; then
        set_minecraft_status "error" "Minecraft server did not become reachable on port 25565."
        set_power_action_status "$action" "$token" "failed" ""
        return 1
      fi
      target_phase="installed"
      ;;
    start-minecraft)
      require_minecraft_state "$action" "$token" "stopped" || return 1
      require_minecraft_compose "$action" "$token" || return 1
      set_minecraft_status "starting" "Starting Minecraft server."
      minecraft_compose up -d
      if ! wait_for_local_minecraft_ready; then
        set_minecraft_status "error" "Minecraft server did not become reachable on port 25565."
        set_power_action_status "$action" "$token" "failed" ""
        return 1
      fi
      target_phase="started"
      ;;
    stop-minecraft)
      require_minecraft_state "$action" "$token" "running" || return 1
      require_minecraft_compose "$action" "$token" || return 1
      set_minecraft_status "stopping" "Stopping Minecraft server."
      minecraft_compose stop -t 30
      set_minecraft_status "stopped" "Minecraft server is stopped."
      target_phase="stopped"
      ;;
    restart-minecraft)
      require_minecraft_state "$action" "$token" "running" || return 1
      require_minecraft_compose "$action" "$token" || return 1
      set_minecraft_status "starting" "Restarting Minecraft server."
      minecraft_compose restart
      if ! wait_for_local_minecraft_ready; then
        set_minecraft_status "error" "Minecraft server did not become reachable on port 25565."
        set_power_action_status "$action" "$token" "failed" ""
        return 1
      fi
      target_phase="restarted"
      ;;
    remove-minecraft)
      require_minecraft_state "$action" "$token" "running" "stopped" "error" || return 1
      require_minecraft_compose "$action" "$token" || return 1
      set_minecraft_status "stopping" "Removing Minecraft container while preserving world data."
      minecraft_compose down
      set_minecraft_status "removed" "Minecraft container removed. World data is preserved in ${MINECRAFT_ROOT}/data."
      target_phase="removed"
      ;;
    *)
      log "Unsupported Minecraft action ${action}"
      set_minecraft_status "error" "Unsupported Minecraft action ${action}."
      set_power_action_status "$action" "$token" "failed" ""
      return 1
      ;;
  esac

  set_power_action_status "$action" "$token" "$target_phase" ""
}

wait_for_local_sunshine_ready() {
  local http_code
  for _ in $(seq 1 90); do
    http_code="$(curl -k --silent --output /dev/null --write-out '%{http_code}' --max-time 5 https://127.0.0.1:47990/ || true)"
    if [[ "$http_code" == "200" || "$http_code" == "401" || "$http_code" == "403" ]]; then
      set_sunshine_status "ready" "Sunshine Web UI responded locally with HTTP ${http_code}."
      return 0
    fi
    sleep 2
  done
  set_sunshine_status "starting" "Sunshine Web UI did not respond locally yet."
  return 1
}

schedule_auto_shutdown() {
  local hours
  local next_at
  local context="${1:-restart}"
  hours="$(metadata_get vm-auto-shutdown-hours)"

  if ! [[ "$hours" =~ ^[0-9]+$ ]] || [ "$hours" -lt 1 ] || [ "$hours" -gt 24 ]; then
    systemctl stop vm-ctl-auto-shutdown.timer vm-ctl-auto-shutdown.service >/dev/null 2>&1 || true
    systemctl reset-failed vm-ctl-auto-shutdown.timer vm-ctl-auto-shutdown.service >/dev/null 2>&1 || true
    set_instance_metadata_values "$(jq -n '{"vm-auto-shutdown-at": null}')"
    return 0
  fi

  systemctl stop vm-ctl-auto-shutdown.timer vm-ctl-auto-shutdown.service >/dev/null 2>&1 || true
  systemctl reset-failed vm-ctl-auto-shutdown.timer vm-ctl-auto-shutdown.service >/dev/null 2>&1 || true
  systemd-run --unit=vm-ctl-auto-shutdown --on-active="${hours}h" /usr/local/bin/vm-power-action auto-stop >/dev/null
  set_instance_metadata_values "$(jq -n --arg value "$(date -u -d "+${hours} hours" +"%Y-%m-%dT%H:%M:%SZ")" '{"vm-auto-shutdown-at": $value}')"
  next_at="$(systemctl show vm-ctl-auto-shutdown.timer --property=NextElapseUSecRealtime --value 2>/dev/null || true)"
  log "Auto-shutdown re-scheduled (${context}) in ${hours}h${next_at:+ at ${next_at}}"
}

update_auto_stop_timer() {
  local action="$1"
  local token="$2"

  log "Updating auto-stop timer token=${token}"
  set_power_action_status "$action" "$token" "running"
  schedule_auto_shutdown "manual-update"
  set_power_action_status "$action" "$token" "scheduled" ""
}

ensure_persist_script() {
  local payload tmp
  payload="$(metadata_get vm-persist-script || true)"
  payload="$(normalize_metadata_value "$payload")"
  if [[ -n "$payload" ]]; then
    tmp="$(mktemp)"
    printf '%s\n' "$payload" > "$tmp"
    install -m 0755 "$tmp" "$PERSIST_SCRIPT"
    rm -f "$tmp"
  fi
  [[ -x "$PERSIST_SCRIPT" ]]
}

run_backup() {
  local mode="$1"
  if ! ensure_persist_script; then
    log "Persist script is unavailable."
    return 1
  fi
  if [[ ! -f "$BACKUP_READY_MARKER" ]]; then
    log "Backup readiness marker is missing."
    return 1
  fi
  "$PERSIST_SCRIPT" "$mode"
}

start_stack() {
  if ! ensure_persist_script; then
    log "Persist script is unavailable."
    return 1
  fi
  "$PERSIST_SCRIPT" start-stack
}

stop_stack() {
  local files=()
  mapfile -t files < <(docker_compose_files)
  if [[ ! -f "$COMPOSE_GCE" ]]; then
    return 0
  fi
  if ! command -v docker >/dev/null 2>&1; then
    return 0
  fi
  (cd "$COMPOSE_DIR" && docker compose "${files[@]}" stop -t 30) || true
}

restore_selected_backup() {
  local backup_id
  backup_id="$(metadata_get vm-selected-backup-id || true)"
  if [[ -z "$backup_id" ]]; then
    log "Selected backup id is missing."
    return 1
  fi
  "$PERSIST_SCRIPT" restore-backup "$backup_id"
}

sync_steam_env_from_metadata() {
  local env_metadata
  env_metadata="$(metadata_get "$STEAM_ENV_METADATA_KEY" || true)"
  env_metadata="$(normalize_metadata_value "$env_metadata")"
  if [[ -z "$env_metadata" ]]; then
    log "Steam Headless env metadata is empty; leaving ${ENVF} unchanged."
    return 1
  fi

  mkdir -p "$(dirname "$ENVF")"
  printf '%s\n' "$env_metadata" > "$ENVF"
  chmod 600 "$ENVF"
  log "Synced ${ENVF} from instance metadata."
}

docker_compose_files() {
  local files=(-f "$COMPOSE_GCE")
  if [[ -f "$COMPOSE_OVERRIDE" ]]; then
    files+=(-f "$COMPOSE_OVERRIDE")
  fi
  if [[ -f "$COMPOSE_IMAGE_OVERRIDE" ]]; then
    files+=(-f "$COMPOSE_IMAGE_OVERRIDE")
  fi
  printf '%s\n' "${files[@]}"
}

apply_sunshine_state_credentials() {
  local user pass container_id
  user="$(awk -F= '/^SUNSHINE_USER=/{print substr($0,index($0,"=")+1)}' "$ENVF" | tail -n1)"
  pass="$(awk -F= '/^SUNSHINE_PASS=/{print substr($0,index($0,"=")+1)}' "$ENVF" | tail -n1)"
  if [[ -z "$user" || -z "$pass" ]]; then
    log "Sunshine credentials are missing in ${ENVF}."
    return 1
  fi

  container_id="$(docker ps --filter 'name=steam-headless' --format '{{.ID}}' | head -n 1 || true)"
  if [[ -n "$container_id" ]] && docker exec "$container_id" which sunshine >/dev/null 2>&1; then
    docker exec "$container_id" sunshine --creds "$user" "$pass" >/dev/null
  fi
}

recreate_steam_headless_stack() {
  local files=()
  mapfile -t files < <(docker_compose_files)
  if [[ ! -f "$COMPOSE_GCE" ]]; then
    log "Compose file ${COMPOSE_GCE} is missing."
    return 1
  fi
  (cd "$COMPOSE_DIR" && docker compose "${files[@]}" up -d --force-recreate)
}

apply_sunshine_password() {
  local action="$1"
  local token="$2"

  log "Applying Sunshine password from metadata"
  if ! sync_steam_env_from_metadata; then
    set_power_action_status "$action" "$token" "failed" ""
    return 1
  fi

  if ! recreate_steam_headless_stack; then
    set_power_action_status "$action" "$token" "failed" ""
    return 1
  fi

  apply_sunshine_state_credentials || true
  wait_for_local_sunshine_ready || true
  set_power_action_status "$action" "$token" "applied" ""
}

perform_action() {
  local action="$1"
  local token="$2"
  local trigger="$3"
  local backup_mode="backup-runtime"

  log "Handling action=${action} token=${token} trigger=${trigger}"
  set_power_action_status "$action" "$token" "running"

  case "$action" in
    delete)
      backup_mode="backup-delete"
      ;;
  esac

  sync_steam_env_from_metadata || true

  if [[ "$action" == "delete" ]]; then
    touch "$BACKUP_COMPLETE_MARKER"
    set_power_action_status "$action" "$token" "stopping" ""
    log "Powering off for delete without creating a backup"
    /sbin/poweroff
    return 0
  fi

  if [[ "$action" == "restart" ]]; then
    touch "$BACKUP_COMPLETE_MARKER"
    set_power_action_status "$action" "$token" "rebooting" ""
    set_sunshine_status "starting" "VM rebooting. Waiting for Sunshine Web UI."
    log "Restarting without creating a backup"
    stop_stack
    schedule_auto_shutdown "restart"
    /sbin/reboot
    return 0
  fi

  if ! run_backup "$backup_mode"; then
    "$PERSIST_SCRIPT" start-stack >/dev/null 2>&1 || true
    set_power_action_status "$action" "$token" "failed" ""
    return 1
  fi

  touch "$BACKUP_COMPLETE_MARKER"
  set_power_action_status "$action" "$token" "backed-up" ""

  case "$action" in
    stop|delete)
      log "Powering off after backup"
      /sbin/poweroff
      ;;
    auto-stop)
      log "Auto-stop powering off after backup"
      /sbin/poweroff
      ;;
    *)
      log "Unsupported action ${action}"
      return 1
      ;;
  esac
}

create_manual_backup() {
  local action="$1"
  local token="$2"

  log "Creating manual backup token=${token}"
  set_power_action_status "$action" "$token" "running"
  sync_steam_env_from_metadata || true
  if ! run_backup "backup-manual"; then
    start_stack >/dev/null 2>&1 || true
    set_power_action_status "$action" "$token" "failed" ""
    return 1
  fi
  if ! start_stack; then
    set_power_action_status "$action" "$token" "failed" ""
    return 1
  fi
  wait_for_local_sunshine_ready || true
  set_power_action_status "$action" "$token" "completed" ""
}

restore_manual_backup() {
  local action="$1"
  local token="$2"

  log "Restoring manual backup token=${token}"
  set_power_action_status "$action" "$token" "running"
  sync_steam_env_from_metadata || true
  stop_stack
  if ! restore_selected_backup; then
    start_stack >/dev/null 2>&1 || true
    set_power_action_status "$action" "$token" "failed" ""
    return 1
  fi
  if ! start_stack; then
    set_power_action_status "$action" "$token" "failed" ""
    return 1
  fi
  wait_for_local_sunshine_ready || true
  set_power_action_status "$action" "$token" "restored" ""
}

remove_manual_backup() {
  local action="$1"
  local token="$2"

  log "Removing manual backup token=${token}"
  set_power_action_status "$action" "$token" "running"
  if ! "$PERSIST_SCRIPT" "remove-backup"; then
    set_power_action_status "$action" "$token" "failed" ""
    return 1
  fi
  wait_for_local_sunshine_ready || true
  set_power_action_status "$action" "$token" "removed" ""
}

run_application_action() {
  local action="$1"
  local token="$2"
  local app_id container_id target_phase

  app_id="$(metadata_get "$SELECTED_APPLICATION_METADATA_KEY" || true)"
  case "$app_id" in
    prism|chrome)
      ;;
    *)
      log "Unsupported application id: ${app_id:-<empty>}"
      set_power_action_status "$action" "$token" "failed" ""
      return 1
      ;;
  esac

  container_id="$(docker ps --filter 'name=steam-headless' --format '{{.ID}}' | head -n 1 || true)"
  if [[ -z "$container_id" ]]; then
    log "steam-headless container not found."
    if [[ "$(metadata_get vm-gpu-count || true)" == "0" ]]; then
      set_sunshine_status "disabled" "GPU disabled for this VM; application changes require a GPU-enabled Steam Headless container."
    else
      set_sunshine_status "error" "Steam Headless container is not running; application change could not be completed."
    fi
    set_power_action_status "$action" "$token" "failed" ""
    return 1
  fi

  log "Running ${action} for application ${app_id}"
  set_power_action_status "$action" "$token" "running"
  set_sunshine_status "starting" "Updating application ${app_id}."

  if ! docker exec -i "$container_id" bash -s -- "$action" "$app_id" <<'PAYLOAD'
set -euo pipefail

action="$1"
app_id="$2"
apps_file=/home/default/.config/sunshine/apps.json

ensure_apps_file() {
  mkdir -p "$(dirname "$apps_file")"
  [ -s "$apps_file" ] || echo '{"apps":[]}' > "$apps_file"
}

update_sunshine_apps() {
  local mode="$1"
  local app_name="$2"
  local command_line="$3"
  ensure_apps_file
  python3 - "$apps_file" "$mode" "$app_name" "$command_line" <<'PY'
import json
import sys

path, mode, app_name, command_line = sys.argv[1:5]
try:
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    data = {}

apps = [item for item in list(data.get("apps") or []) if isinstance(item, dict)]
apps = [item for item in apps if item.get("name") != app_name]

if mode == "install":
    apps.append({
        "name": app_name,
        "exclude-global-prep-cmd": "true",
        "detached": [command_line],
        "prep-cmd": [
            {"do": "", "undo": "/usr/bin/sunshine-stop"},
            {"do": "", "undo": "/usr/bin/xfce4-close-all-windows"},
        ],
    })

data["apps"] = apps
with open(path, "w", encoding="utf-8") as handle:
    json.dump(data, handle)
PY
}

install_prism() {
  install -d -m 0755 -o default -g default /home/default /home/default/.local /home/default/.var /home/default/.config
  if ! command -v flatpak >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y flatpak
  fi
  sudo -u default env HOME=/home/default flatpak --user remote-add --if-not-exists flathub \
    https://flathub.org/repo/flathub.flatpakrepo || true
  sudo -u default env HOME=/home/default flatpak --user install -y flathub org.prismlauncher.PrismLauncher
  update_sunshine_apps install PrismLauncher "/usr/bin/flatpak run org.prismlauncher.PrismLauncher//stable"
}

uninstall_prism() {
  if command -v flatpak >/dev/null 2>&1; then
    sudo -u default env HOME=/home/default flatpak --user uninstall -y org.prismlauncher.PrismLauncher || true
  fi
  update_sunshine_apps uninstall PrismLauncher ""
}

install_chrome() {
  install -d -m 0755 -o default -g default /home/default /home/default/.local /home/default/.var /home/default/.config
  if ! command -v flatpak >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y flatpak
  fi
  sudo -u default env HOME=/home/default flatpak --user remote-add --if-not-exists flathub \
    https://flathub.org/repo/flathub.flatpakrepo || true
  sudo -u default env HOME=/home/default flatpak --user install -y flathub com.google.Chrome
  update_sunshine_apps install "Google Chrome" "/usr/bin/flatpak run com.google.Chrome//stable --no-first-run --password-store=basic"
}

uninstall_chrome() {
  if command -v flatpak >/dev/null 2>&1; then
    sudo -u default env HOME=/home/default flatpak --user uninstall -y com.google.Chrome || true
  fi
  update_sunshine_apps uninstall "Google Chrome" ""
}

case "${action}:${app_id}" in
  install-app:prism) install_prism ;;
  uninstall-app:prism) uninstall_prism ;;
  install-app:chrome) install_chrome ;;
  uninstall-app:chrome) uninstall_chrome ;;
  *) exit 2 ;;
esac

chown default:default "$apps_file" || true
supervisorctl restart sunshine || true
PAYLOAD
  then
    set_power_action_status "$action" "$token" "failed" ""
    return 1
  fi

  wait_for_local_sunshine_ready || true
  target_phase="installed"
  if [[ "$action" == "uninstall-app" ]]; then
    target_phase="uninstalled"
  fi
  set_power_action_status "$action" "$token" "$target_phase" ""
}

run_daemon() {
  log "Starting power action daemon"
  while true; do
    local request action token
    request="$(metadata_get "$POWER_ACTION_METADATA_KEY")"
    if [[ -n "$request" && "$request" == *:* ]]; then
      action="${request%%:*}"
      token="${request#*:}"
      case "$action" in
        stop|restart|delete)
          perform_action "$action" "$token" "metadata" || true
          ;;
        create-backup)
          create_manual_backup "$action" "$token" || true
          ;;
        restore-backup)
          restore_manual_backup "$action" "$token" || true
          ;;
        remove-backup)
          remove_manual_backup "$action" "$token" || true
          ;;
        apply-sunshine-password)
          apply_sunshine_password "$action" "$token" || true
          ;;
        set-auto-stop)
          update_auto_stop_timer "$action" "$token" || true
          ;;
        install-app|uninstall-app)
          run_application_action "$action" "$token" || true
          ;;
        install-minecraft|start-minecraft|stop-minecraft|restart-minecraft|remove-minecraft)
          run_minecraft_action "$action" "$token" || true
          ;;
      esac
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done
}

auto_stop() {
  local token
  token="auto-$(date +%s)"
  perform_action "auto-stop" "$token" "timer"
}

case "${1:-}" in
  daemon)
    run_daemon
    ;;
  auto-stop)
    auto_stop
    ;;
  *)
    echo "Usage: $0 {daemon|auto-stop}" >&2
    exit 1
    ;;
esac
