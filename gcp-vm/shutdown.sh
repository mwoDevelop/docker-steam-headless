#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[shutdown] $*"
}

METADATA_HDR=( -H "Metadata-Flavor: Google" --fail --silent --show-error )
PERSIST_SCRIPT=/usr/local/bin/vm-persist-state
STATE_DIR=${STATE_DIR:-/var/lib/vm-state}
BACKUP_READY_MARKER="${STATE_DIR}/backup-ready"
BACKUP_COMPLETE_MARKER="${STATE_DIR}/backup-complete"

metadata_get() {
  local key="$1"
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/instance/attributes/${key}" || true
}

ensure_persist_script() {
  if [[ -x "$PERSIST_SCRIPT" ]]; then
    return 0
  fi

  local payload
  payload="$(metadata_get vm-persist-script)"
  [[ -n "$payload" ]] || return 1
  install -d -m 0755 "$(dirname "$PERSIST_SCRIPT")"
  printf '%s\n' "$payload" > "$PERSIST_SCRIPT"
  chmod 0755 "$PERSIST_SCRIPT"
}

main() {
  if ! ensure_persist_script; then
    log "Persist script is unavailable; skipping backup."
    exit 0
  fi

  if [[ ! -f "$BACKUP_READY_MARKER" ]]; then
    log "Backup readiness marker is missing; skipping backup."
    exit 0
  fi

  if [[ -f "$BACKUP_COMPLETE_MARKER" ]]; then
    log "Backup already completed before shutdown; skipping backup."
    exit 0
  fi

  if "$PERSIST_SCRIPT" backup; then
    log "State backup completed during shutdown."
    exit 0
  fi

  log "State backup failed during shutdown."
  exit 0
}

main "$@"
