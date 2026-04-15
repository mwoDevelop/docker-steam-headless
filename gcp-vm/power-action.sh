#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[power-action] $*"
}

METADATA_HDR=( -H "Metadata-Flavor: Google" --fail --silent --show-error )
STATE_DIR=${STATE_DIR:-/var/lib/vm-state}
BACKUP_READY_MARKER="${STATE_DIR}/backup-ready"
BACKUP_COMPLETE_MARKER="${STATE_DIR}/backup-complete"
PERSIST_SCRIPT=/usr/local/bin/vm-persist-state
POLL_INTERVAL_SECONDS=${POLL_INTERVAL_SECONDS:-5}
POWER_ACTION_METADATA_KEY="vm-pending-power-action"
POWER_ACTION_STATUS_METADATA_KEY="vm-power-action-status"

metadata_get() {
  local key="$1"
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/instance/attributes/${key}" || true
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
