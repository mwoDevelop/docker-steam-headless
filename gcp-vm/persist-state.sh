#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[persist-state] $*"
}

METADATA_HDR=( -H "Metadata-Flavor: Google" --fail --silent --show-error )
STATE_DIR=${STATE_DIR:-/var/lib/vm-state}
RCLONE_CONFIG_PATH="${STATE_DIR}/rclone.conf"
OAUTH_TOKEN_PATH="${STATE_DIR}/drive-oauth-token.json"
WORK_DIR="${STATE_DIR}/work"
HOME_ARCHIVE="${WORK_DIR}/home.tar.zst"
HOST_HOME_DIR=${HOST_HOME_DIR:-/opt/container-data/steam-headless/home}
HOST_HOME_PARENT=${HOST_HOME_PARENT:-/opt/container-data/steam-headless}
HOST_GAMES_DIR=${HOST_GAMES_DIR:-/mnt/games}
STACK_DIR=${STACK_DIR:-/opt/container-services/steam-headless}
STACK_ENV=${STACK_ENV:-${STACK_DIR}/.env}
REMOTE_NAME="vmstate"
DEFAULT_ROOT_PATH="steam-vm-state"

metadata_get() {
  local key="$1"
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/instance/attributes/${key}" || true
}

project_id() {
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/project/project-id"
}

instance_name() {
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/instance/name"
}

instance_zone() {
  local zone
  zone="$(curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/instance/zone")"
  printf '%s\n' "${zone##*/}"
}

instance_status() {
  local zone project token
  project="$(project_id)"
  zone="$(instance_zone)"
  token="$(metadata_token)"
  curl --fail --silent --show-error \
    -H "Authorization: Bearer ${token}" \
    "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/$(instance_name)" \
    | jq -r '.status // ""'
}

metadata_token() {
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/instance/service-accounts/default/token" \
    | jq -r '.access_token'
}

secret_payload() {
  local secret_name="$1"
  local token project payload encoded

  token="$(metadata_token)"
  project="$(project_id)"
  payload="$(curl --fail --silent --show-error \
    -H "Authorization: Bearer ${token}" \
    "https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${secret_name}/versions/latest:access")"
  encoded="$(printf '%s' "$payload" | jq -r '.payload.data')"
  [[ -n "$encoded" && "$encoded" != "null" ]] || return 1
  printf '%s' "$encoded" | tr '_-' '/+' | base64 -d
}

secret_json_to_file() {
  local secret_name="$1"
  local target_path="$2"
  secret_payload "$secret_name" > "$target_path"
  chmod 600 "$target_path"
}

ensure_tools() {
  command -v curl >/dev/null 2>&1 || { log "curl is required"; return 1; }
  command -v jq >/dev/null 2>&1 || { log "jq is required"; return 1; }
  command -v tar >/dev/null 2>&1 || { log "tar is required"; return 1; }
  command -v zstd >/dev/null 2>&1 || { log "zstd is required"; return 1; }
  command -v rclone >/dev/null 2>&1 || { log "rclone is required"; return 1; }
}

render_rclone_config_oauth() {
  local folder_id="$1"
  local token_json
  token_json="$(jq -c . "$OAUTH_TOKEN_PATH")"
  cat > "$RCLONE_CONFIG_PATH" <<EOF
[${REMOTE_NAME}]
type = drive
scope = drive
token = ${token_json}
root_folder_id = ${folder_id}
EOF
  chmod 600 "$RCLONE_CONFIG_PATH"
}

ensure_rclone_remote() {
  local folder_id oauth_secret_name owner_email

  folder_id="$(metadata_get gdrive-folder-id)"
  owner_email="$(metadata_get gdrive-owner-email)"
  oauth_secret_name="$(metadata_get gdrive-oauth-token-secret-name)"

  if [[ -z "$folder_id" ]]; then
    log "Google Drive persistence is not configured; skipping."
    return 1
  fi

  mkdir -p "$STATE_DIR" "$WORK_DIR"
  if [[ -z "$oauth_secret_name" ]]; then
    log "Google Drive persistence requires a fixed OAuth token secret for ${owner_email:-the Drive owner}; skipping."
    return 1
  fi

  secret_json_to_file "$oauth_secret_name" "$OAUTH_TOKEN_PATH"
  render_rclone_config_oauth "$folder_id"
  log "Configured Drive remote with fixed OAuth token secret ${oauth_secret_name}${owner_email:+ for ${owner_email}}"
  return 0
}

remote_root() {
  local root_path
  root_path="$(metadata_get gdrive-state-root)"
  root_path="${root_path:-$DEFAULT_ROOT_PATH}"
  printf '%s/%s\n' "$root_path" "$(instance_name)"
}

stop_stack() {
  if [[ ! -f "${STACK_DIR}/docker-compose.nvidia.privileged.gce.yml" ]]; then
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    return 0
  fi

  local compose_args=( -f "${STACK_DIR}/docker-compose.nvidia.privileged.gce.yml" )
  if [[ -f "${STACK_DIR}/docker-compose.nvidia.privileged.override.yml" ]]; then
    compose_args+=( -f "${STACK_DIR}/docker-compose.nvidia.privileged.override.yml" )
  fi

  if docker ps -qf name=steam-headless | grep -q .; then
    log "Stopping Steam Headless stack before backup"
    (cd "$STACK_DIR" && docker compose "${compose_args[@]}" stop -t 30) || true
  fi
}

restore_stack_perms() {
  chown -R ubuntu:ubuntu "$HOST_HOME_DIR" 2>/dev/null || true
  chmod 0777 "$HOST_GAMES_DIR" 2>/dev/null || true
}

write_manifest() {
  local mode="$1"
  local root="$2"
  local manifest="${WORK_DIR}/manifest.json"
  jq -n \
    --arg mode "$mode" \
    --arg root "$root" \
    --arg timestamp "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    --arg instance "$(instance_name)" \
    --arg zone "$(instance_zone)" \
    --arg home_path "$HOST_HOME_DIR" \
    --arg games_path "$HOST_GAMES_DIR" \
    '{
      mode: $mode,
      timestamp: $timestamp,
      instance: $instance,
      zone: $zone,
      homePath: $home_path,
      gamesPath: $games_path,
      backupRoot: $root
    }' > "$manifest"
  rclone --config "$RCLONE_CONFIG_PATH" copyto "$manifest" "${REMOTE_NAME}:${root}/manifest.json"
}

backup_home() {
  local root="$1"
  mkdir -p "$HOST_HOME_PARENT" "$WORK_DIR"
  if [[ ! -d "$HOST_HOME_DIR" ]]; then
    log "Home directory ${HOST_HOME_DIR} does not exist; creating empty tree"
    mkdir -p "$HOST_HOME_DIR"
  fi
  rm -f "$HOME_ARCHIVE"
  tar --zstd -cpf "$HOME_ARCHIVE" -C "$HOST_HOME_PARENT" "$(basename "$HOST_HOME_DIR")"
  rclone --config "$RCLONE_CONFIG_PATH" copyto "$HOME_ARCHIVE" "${REMOTE_NAME}:${root}/home.tar.zst"
}

backup_games() {
  local root="$1"
  mkdir -p "$HOST_GAMES_DIR"
  rclone --config "$RCLONE_CONFIG_PATH" sync "$HOST_GAMES_DIR" "${REMOTE_NAME}:${root}/games"
}

restore_home() {
  local root="$1"
  mkdir -p "$HOST_HOME_PARENT" "$WORK_DIR"
  if ! rclone --config "$RCLONE_CONFIG_PATH" lsf "${REMOTE_NAME}:${root}" | grep -qx 'home.tar.zst'; then
    log "No home backup found in Drive"
    return 0
  fi
  rm -rf "$HOST_HOME_DIR"
  rclone --config "$RCLONE_CONFIG_PATH" copyto "${REMOTE_NAME}:${root}/home.tar.zst" "$HOME_ARCHIVE"
  tar --zstd -xpf "$HOME_ARCHIVE" -C "$HOST_HOME_PARENT"
}

restore_games() {
  local root="$1"
  mkdir -p "$HOST_GAMES_DIR"
  if ! rclone --config "$RCLONE_CONFIG_PATH" lsf "${REMOTE_NAME}:${root}/games" >/dev/null 2>&1; then
    log "No games backup found in Drive"
    return 0
  fi
  rclone --config "$RCLONE_CONFIG_PATH" sync "${REMOTE_NAME}:${root}/games" "$HOST_GAMES_DIR"
}

backup_state() {
  local root
  root="$(remote_root)"
  ensure_tools
  ensure_rclone_remote || return 0
  stop_stack
  backup_home "$root"
  backup_games "$root"
  write_manifest "backup" "$root"
  log "Backup completed to ${root}"
}

restore_state() {
  local root
  root="$(remote_root)"
  ensure_tools
  ensure_rclone_remote || return 0
  restore_home "$root"
  restore_games "$root"
  restore_stack_perms
  write_manifest "restore" "$root"
  log "Restore completed from ${root}"
}

status_state() {
  local root
  root="$(remote_root)"
  ensure_tools
  ensure_rclone_remote || return 0
  echo "REMOTE_ROOT=${root}"
  rclone --config "$RCLONE_CONFIG_PATH" lsf "${REMOTE_NAME}:${root}" || true
}

cmd="${1:-}"
case "$cmd" in
  backup)
    backup_state
    ;;
  restore)
    restore_state
    ;;
  status)
    status_state
    ;;
  *)
    echo "Usage: $0 {backup|restore|status}" >&2
    exit 1
    ;;
esac
