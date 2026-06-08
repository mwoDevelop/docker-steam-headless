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
STEAM_ENV_METADATA_KEY="steam-headless-env"
ENVF=/opt/container-services/steam-headless/.env
COMPOSE_DIR=/opt/container-services/steam-headless
COMPOSE_GCE="${COMPOSE_DIR}/docker-compose.nvidia.privileged.gce.yml"
COMPOSE_OVERRIDE="${COMPOSE_DIR}/docker-compose.nvidia.privileged.override.yml"
COMPOSE_IMAGE_OVERRIDE="${COMPOSE_DIR}/docker-compose.image.override.yml"

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
  local token project zone name instance_json fingerprint items payload
  token="$(metadata_token || true)"
  project="$(project_id || true)"
  zone="$(zone_name || true)"
  name="$(instance_name || true)"
  [[ -n "$token" && -n "$project" && -n "$zone" && -n "$name" ]] || return 1

  instance_json="$(curl --fail --silent --show-error \
    -H "Authorization: Bearer ${token}" \
    "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}")"
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

  curl --fail --silent --show-error \
    -X POST \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}/setMetadata" >/dev/null
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
    return 0
  fi

  systemctl stop vm-ctl-auto-shutdown.timer vm-ctl-auto-shutdown.service >/dev/null 2>&1 || true
  systemctl reset-failed vm-ctl-auto-shutdown.timer vm-ctl-auto-shutdown.service >/dev/null 2>&1 || true
  systemd-run --unit=vm-ctl-auto-shutdown --on-active="${hours}h" /usr/local/bin/vm-power-action auto-stop >/dev/null
  next_at="$(systemctl show vm-ctl-auto-shutdown.timer --property=NextElapseUSecRealtime --value 2>/dev/null || true)"
  log "Auto-shutdown re-scheduled (${context}) in ${hours}h${next_at:+ at ${next_at}}"
}

ensure_persist_script() {
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
    restart)
      log "Rebooting after backup"
      schedule_auto_shutdown "restart"
      /sbin/reboot
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
        apply-sunshine-password)
          apply_sunshine_password "$action" "$token" || true
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
