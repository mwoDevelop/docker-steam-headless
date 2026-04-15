#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[persist-state] $*"
}

METADATA_HDR=(-H "Metadata-Flavor: Google" --fail --silent --show-error)
STATE_DIR=${STATE_DIR:-/var/lib/vm-state}
RCLONE_CONFIG_PATH="${STATE_DIR}/rclone.conf"
OAUTH_TOKEN_PATH="${STATE_DIR}/drive-oauth-token.json"
WORK_DIR="${STATE_DIR}/work"
BACKUP_READY_MARKER="${STATE_DIR}/backup-ready"
BACKUP_COMPLETE_MARKER="${STATE_DIR}/backup-complete"
HOME_ARCHIVE="${WORK_DIR}/home.tar.zst"
HOME_MANIFEST="${WORK_DIR}/home-manifest.json"
ROOT_MANIFEST="${WORK_DIR}/manifest.json"
GAMES_CURRENT_FILE="${WORK_DIR}/games-current.json"
GAMES_MANIFEST_FILE="${WORK_DIR}/games-manifest.json"
HOST_HOME_DIR=${HOST_HOME_DIR:-/opt/container-data/steam-headless/home}
HOST_HOME_PARENT=${HOST_HOME_PARENT:-/opt/container-data/steam-headless}
HOST_GAMES_DIR=${HOST_GAMES_DIR:-/mnt/games}
STACK_DIR=${STACK_DIR:-/opt/container-services/steam-headless}
REMOTE_NAME="vmstate"
DEFAULT_ROOT_PATH="steam-vm-state"
DEFAULT_DATA_DISK_DEVICE_NAME="steam-state"
DEFAULT_STATE_MOUNT_ROOT="/mnt/state"
HOME_BACKUP_AT_KEY="vm-last-home-backup-at"
GAMES_ARCHIVE_AT_KEY="vm-last-games-archive-at"
GAMES_ARCHIVE_STATUS_KEY="vm-games-archive-status"
GAMES_ARCHIVE_DETAIL_KEY="vm-games-archive-detail"
RESTORE_MODE_KEY="vm-restore-mode"
RESTORE_STATUS_KEY="vm-restore-status"
RESTORE_DETAIL_KEY="vm-restore-detail"
DATA_DISK_STATUS_KEY="vm-data-disk-status"
DATA_DISK_DETAIL_KEY="vm-data-disk-detail"
PERSISTENCE_FORMAT_VERSION="2"

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

metadata_token() {
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/instance/service-accounts/default/token" \
    | jq -r '.access_token'
}

set_instance_metadata_values_json() {
  local updates_json="$1"
  local token project zone name instance_json fingerprint items payload
  token="$(metadata_token || true)"
  project="$(project_id || true)"
  zone="$(instance_zone || true)"
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

set_metadata_values() {
  local updates_json="$1"
  set_instance_metadata_values_json "$updates_json" || true
}

set_data_disk_status() {
  local state="$1"
  local detail="${2-}"
  local updates
  updates="$(jq -n \
    --arg state_key "$DATA_DISK_STATUS_KEY" \
    --arg state_value "$state" \
    --arg detail_key "$DATA_DISK_DETAIL_KEY" \
    --arg detail_value "$detail" \
    '{($state_key): $state_value, ($detail_key): $detail_value}')"
  set_metadata_values "$updates"
}

set_restore_status() {
  local state="$1"
  local detail="${2-}"
  local updates
  updates="$(jq -n \
    --arg state_key "$RESTORE_STATUS_KEY" \
    --arg state_value "$state" \
    --arg detail_key "$RESTORE_DETAIL_KEY" \
    --arg detail_value "$detail" \
    '{($state_key): $state_value, ($detail_key): $detail_value}')"
  set_metadata_values "$updates"
}

set_games_archive_status() {
  local state="$1"
  local detail="${2-}"
  local updates
  updates="$(jq -n \
    --arg state_key "$GAMES_ARCHIVE_STATUS_KEY" \
    --arg state_value "$state" \
    --arg detail_key "$GAMES_ARCHIVE_DETAIL_KEY" \
    --arg detail_value "$detail" \
    '{($state_key): $state_value, ($detail_key): $detail_value}')"
  set_metadata_values "$updates"
}

record_home_backup_time() {
  local timestamp="$1"
  local updates
  updates="$(jq -n \
    --arg key "$HOME_BACKUP_AT_KEY" \
    --arg value "$timestamp" \
    '{($key): $value}')"
  set_metadata_values "$updates"
}

record_games_archive_time() {
  local timestamp="$1"
  local updates
  updates="$(jq -n \
    --arg key "$GAMES_ARCHIVE_AT_KEY" \
    --arg value "$timestamp" \
    '{($key): $value}')"
  set_metadata_values "$updates"
}

clear_restore_mode() {
  local updates
  updates="$(jq -n \
    --arg key "$RESTORE_MODE_KEY" \
    '{($key): null}')"
  set_metadata_values "$updates"
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
  command -v blkid >/dev/null 2>&1 || { log "blkid is required"; return 1; }
  command -v curl >/dev/null 2>&1 || { log "curl is required"; return 1; }
  command -v jq >/dev/null 2>&1 || { log "jq is required"; return 1; }
  command -v mount >/dev/null 2>&1 || { log "mount is required"; return 1; }
  command -v mkfs.ext4 >/dev/null 2>&1 || { log "mkfs.ext4 is required"; return 1; }
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

state_mount_root() {
  local mount_root
  mount_root="$(metadata_get vm-data-disk-mount-root)"
  printf '%s\n' "${mount_root:-$DEFAULT_STATE_MOUNT_ROOT}"
}

mount_home_dir() {
  printf '%s/home\n' "$(state_mount_root)"
}

mount_games_dir() {
  printf '%s/games\n' "$(state_mount_root)"
}

data_disk_device_name() {
  local device_name
  device_name="$(metadata_get vm-data-disk-device-name)"
  printf '%s\n' "${device_name:-$DEFAULT_DATA_DISK_DEVICE_NAME}"
}

data_disk_device_path() {
  printf '/dev/disk/by-id/google-%s\n' "$(data_disk_device_name)"
}

ensure_fstab_entry() {
  local mountpoint="$1"
  local line="$2"
  local tmp

  tmp="$(mktemp)"
  touch /etc/fstab
  awk -v mountpoint="$mountpoint" '
    NF < 2 || $2 != mountpoint { print }
  ' /etc/fstab > "$tmp"
  printf '%s\n' "$line" >> "$tmp"
  cat "$tmp" > /etc/fstab
  rm -f "$tmp"
}

wait_for_data_disk() {
  local device_path
  device_path="$(data_disk_device_path)"
  for _ in $(seq 1 60); do
    if [[ -b "$device_path" ]]; then
      printf '%s\n' "$device_path"
      return 0
    fi
    sleep 2
  done
  return 1
}

prepare_data_disk() {
  local device_path mount_root home_mount games_mount uuid

  mount_root="$(state_mount_root)"
  home_mount="$(mount_home_dir)"
  games_mount="$(mount_games_dir)"
  mkdir -p "$STATE_DIR" "$WORK_DIR" "$HOST_HOME_PARENT" "$HOST_GAMES_DIR" "$HOST_HOME_DIR" "$mount_root"

  if ! device_path="$(wait_for_data_disk)"; then
    set_data_disk_status "missing" "Shared data disk device was not found."
    return 1
  fi

  uuid="$(blkid -s UUID -o value "$device_path" 2>/dev/null || true)"
  if [[ -z "$uuid" ]]; then
    log "Formatting shared data disk ${device_path}"
    mkfs.ext4 -F -m 0 "$device_path" >/dev/null
    uuid="$(blkid -s UUID -o value "$device_path")"
  fi

  ensure_fstab_entry "$mount_root" "UUID=${uuid} ${mount_root} ext4 defaults,nofail,discard 0 2"
  mountpoint -q "$mount_root" || mount "$mount_root"

  mkdir -p "$home_mount" "$games_mount" "$HOST_HOME_PARENT" "$HOST_GAMES_DIR" "$HOST_HOME_DIR"

  ensure_fstab_entry "$HOST_HOME_DIR" "${home_mount} ${HOST_HOME_DIR} none bind 0 0"
  ensure_fstab_entry "$HOST_GAMES_DIR" "${games_mount} ${HOST_GAMES_DIR} none bind 0 0"

  set_data_disk_status "ready" "Shared data disk mounted at ${mount_root} using ${device_path}."
}

bind_data_paths() {
  local home_mount games_mount
  home_mount="$(mount_home_dir)"
  games_mount="$(mount_games_dir)"

  prepare_data_disk
  mkdir -p "$HOST_HOME_DIR" "$HOST_GAMES_DIR"

  mountpoint -q "$HOST_HOME_DIR" || mount --bind "$home_mount" "$HOST_HOME_DIR"
  mountpoint -q "$HOST_GAMES_DIR" || mount --bind "$games_mount" "$HOST_GAMES_DIR"

  chown -R ubuntu:ubuntu "$HOST_HOME_DIR" 2>/dev/null || true
  chmod 0777 "$HOST_GAMES_DIR" 2>/dev/null || true
}

restore_stack_perms() {
  chown -R ubuntu:ubuntu "$(mount_home_dir)" 2>/dev/null || true
  chmod 0777 "$(mount_games_dir)" 2>/dev/null || true
}

compose_files() {
  local files=("${STACK_DIR}/docker-compose.nvidia.privileged.gce.yml")
  if [[ -f "${STACK_DIR}/docker-compose.nvidia.privileged.override.yml" ]]; then
    files+=("${STACK_DIR}/docker-compose.nvidia.privileged.override.yml")
  fi
  printf '%s\n' "${files[@]}"
}

stop_stack() {
  if [[ ! -f "${STACK_DIR}/docker-compose.nvidia.privileged.gce.yml" ]]; then
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    return 0
  fi

  local compose_args=()
  while IFS= read -r file; do
    compose_args+=(-f "$file")
  done < <(compose_files)

  if docker ps -qf name=steam-headless | grep -q .; then
    log "Stopping Steam Headless stack before persistence work"
    (cd "$STACK_DIR" && docker compose "${compose_args[@]}" stop -t 30) || true
  fi
}

start_stack() {
  if [[ ! -f "${STACK_DIR}/docker-compose.nvidia.privileged.gce.yml" ]]; then
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    return 0
  fi

  local compose_args=()
  while IFS= read -r file; do
    compose_args+=(-f "$file")
  done < <(compose_files)

  log "Starting Steam Headless stack after failed persistence action"
  (cd "$STACK_DIR" && docker compose "${compose_args[@]}" up -d) || true
}

write_root_manifest() {
  local mode="$1"
  local root="$2"
  local timestamp="$3"
  jq -n \
    --arg mode "$mode" \
    --arg root "$root" \
    --arg timestamp "$timestamp" \
    --arg instance "$(instance_name)" \
    --arg zone "$(instance_zone)" \
    --arg home_path "$HOST_HOME_DIR" \
    --arg games_path "$HOST_GAMES_DIR" \
    --arg version "$PERSISTENCE_FORMAT_VERSION" \
    '{
      mode: $mode,
      timestamp: $timestamp,
      instance: $instance,
      zone: $zone,
      homePath: $home_path,
      gamesPath: $games_path,
      backupRoot: $root,
      formatVersion: $version
    }' > "$ROOT_MANIFEST"
  rclone --config "$RCLONE_CONFIG_PATH" copyto "$ROOT_MANIFEST" "${REMOTE_NAME}:${root}/manifest.json"
}

write_home_manifest() {
  local root="$1"
  local timestamp="$2"
  jq -n \
    --arg timestamp "$timestamp" \
    --arg archive_path "home/home.tar.zst" \
    --arg source_path "$HOST_HOME_DIR" \
    --arg version "$PERSISTENCE_FORMAT_VERSION" \
    '{
      timestamp: $timestamp,
      archivePath: $archive_path,
      sourcePath: $source_path,
      formatVersion: $version
    }' > "$HOME_MANIFEST"
  rclone --config "$RCLONE_CONFIG_PATH" copyto "$HOME_MANIFEST" "${REMOTE_NAME}:${root}/home/manifest.json"
}

write_games_manifest() {
  local root="$1"
  local timestamp="$2"
  local archive_path="$3"
  local size_bytes="$4"

  jq -n \
    --arg timestamp "$timestamp" \
    --arg archive_path "$archive_path" \
    --arg source_path "$HOST_GAMES_DIR" \
    --arg compression "zstd" \
    --arg version "$PERSISTENCE_FORMAT_VERSION" \
    --argjson size_bytes "$size_bytes" \
    --arg status "published" \
    '{
      timestamp: $timestamp,
      archivePath: $archive_path,
      sourcePath: $source_path,
      compression: $compression,
      sizeBytes: $size_bytes,
      formatVersion: $version,
      publicationStatus: $status
    }' > "$GAMES_MANIFEST_FILE"
  rclone --config "$RCLONE_CONFIG_PATH" copyto \
    "$GAMES_MANIFEST_FILE" \
    "${REMOTE_NAME}:${root}/games/manifests/${timestamp}.json"
}

publish_games_current() {
  local root="$1"
  local timestamp="$2"
  local archive_path="$3"

  jq -n \
    --arg timestamp "$timestamp" \
    --arg archive_path "$archive_path" \
    --arg manifest_path "games/manifests/${timestamp}.json" \
    --arg version "$PERSISTENCE_FORMAT_VERSION" \
    '{
      timestamp: $timestamp,
      archivePath: $archive_path,
      manifestPath: $manifest_path,
      formatVersion: $version,
      published: true
    }' > "$GAMES_CURRENT_FILE"
  rclone --config "$RCLONE_CONFIG_PATH" copyto \
    "$GAMES_CURRENT_FILE" \
    "${REMOTE_NAME}:${root}/games/current.json"
}

remote_has_state() {
  local root="$1"
  local entries

  entries="$(rclone --config "$RCLONE_CONFIG_PATH" lsf "${REMOTE_NAME}:${root}" 2>/dev/null || true)"
  [[ -n "$entries" ]]
}

remote_file_exists() {
  local remote_path="$1"
  rclone --config "$RCLONE_CONFIG_PATH" lsf "$remote_path" >/dev/null 2>&1
}

remote_home_archive_path() {
  local root="$1"
  printf '%s:%s/home/home.tar.zst\n' "$REMOTE_NAME" "$root"
}

legacy_home_archive_path() {
  local root="$1"
  printf '%s:%s/home.tar.zst\n' "$REMOTE_NAME" "$root"
}

games_current_remote_path() {
  local root="$1"
  printf '%s:%s/games/current.json\n' "$REMOTE_NAME" "$root"
}

legacy_games_dir_remote_path() {
  local root="$1"
  printf '%s:%s/games\n' "$REMOTE_NAME" "$root"
}

backup_is_ready() {
  [[ -f "$BACKUP_READY_MARKER" ]]
}

is_dir_empty() {
  local dir="$1"
  [[ ! -d "$dir" ]] && return 0
  find "$dir" -mindepth 1 -maxdepth 1 -print -quit | grep -q . && return 1
  return 0
}

backup_home() {
  local root="$1"
  local timestamp="$2"
  local source_dir

  source_dir="$(mount_home_dir)"
  mkdir -p "$HOST_HOME_PARENT" "$WORK_DIR"
  if [[ ! -d "$source_dir" ]]; then
    log "Home directory ${source_dir} does not exist; refusing to back up an empty tree"
    return 1
  fi

  rm -f "$HOME_ARCHIVE"
  tar --zstd -cpf "$HOME_ARCHIVE" -C "$(dirname "$source_dir")" "$(basename "$source_dir")"
  rclone --config "$RCLONE_CONFIG_PATH" copyto "$HOME_ARCHIVE" "$(remote_home_archive_path "$root")"
  write_home_manifest "$root" "$timestamp"
  record_home_backup_time "$timestamp"
}

backup_games_archive() {
  local root="$1"
  local timestamp="$2"
  local archive_rel="games/archives/${timestamp}.tar.zst"
  local archive_remote="${REMOTE_NAME}:${root}/${archive_rel}"
  local size_bytes

  if [[ ! -d "$(mount_games_dir)" ]]; then
    log "Games directory $(mount_games_dir) does not exist; refusing to archive an empty tree"
    return 1
  fi

  set_games_archive_status "running" "Archiving /mnt/games to Google Drive."
  tar -C "$(dirname "$(mount_games_dir)")" -cf - "$(basename "$(mount_games_dir)")" \
    | zstd -T0 \
    | rclone --config "$RCLONE_CONFIG_PATH" rcat "$archive_remote"

  size_bytes="$(
    rclone --config "$RCLONE_CONFIG_PATH" lsjson "$archive_remote" \
      | jq -r '.[0].Size // 0'
  )"
  write_games_manifest "$root" "$timestamp" "$archive_rel" "$size_bytes"
  publish_games_current "$root" "$timestamp" "$archive_rel"
  record_games_archive_time "$timestamp"
  set_games_archive_status "ready" "Published games archive ${archive_rel}."
}

restore_home() {
  local root="$1"
  local source_remote=""
  local mount_home
  local manifest_remote="${REMOTE_NAME}:${root}/home/manifest.json"
  local manifest_timestamp=""

  mount_home="$(mount_home_dir)"
  mkdir -p "$WORK_DIR" "$(dirname "$mount_home")"

  if remote_file_exists "$(remote_home_archive_path "$root")"; then
    source_remote="$(remote_home_archive_path "$root")"
  elif remote_file_exists "$(legacy_home_archive_path "$root")"; then
    source_remote="$(legacy_home_archive_path "$root")"
  else
    log "No home backup found in Drive"
    return 0
  fi

  rm -rf "$mount_home"
  rclone --config "$RCLONE_CONFIG_PATH" copyto "$source_remote" "$HOME_ARCHIVE"
  tar --zstd -xpf "$HOME_ARCHIVE" -C "$(dirname "$mount_home")"

  if remote_file_exists "$manifest_remote"; then
    rclone --config "$RCLONE_CONFIG_PATH" copyto "$manifest_remote" "$HOME_MANIFEST"
    manifest_timestamp="$(jq -r '.timestamp // ""' "$HOME_MANIFEST")"
    if [[ -n "$manifest_timestamp" ]]; then
      record_home_backup_time "$manifest_timestamp"
    fi
  fi
}

restore_games_from_archive() {
  local root="$1"
  local mount_root target_dir stage_dir current_remote archive_rel archive_remote token

  mount_root="$(state_mount_root)"
  target_dir="$(mount_games_dir)"
  token="$(date +%s)"
  stage_dir="${mount_root}/games.restore.${token}"
  current_remote="$(games_current_remote_path "$root")"

  rclone --config "$RCLONE_CONFIG_PATH" copyto "$current_remote" "$GAMES_CURRENT_FILE"
  archive_rel="$(jq -r '.archivePath // ""' "$GAMES_CURRENT_FILE")"
  if [[ -z "$archive_rel" ]]; then
    log "Games current.json is present but missing archivePath"
    return 1
  fi

  archive_remote="${REMOTE_NAME}:${root}/${archive_rel}"
  rm -rf "$stage_dir"
  mkdir -p "$mount_root"

  rclone --config "$RCLONE_CONFIG_PATH" cat "$archive_remote" \
    | zstd -d \
    | tar -C "$mount_root" --transform "s#^games#$(basename "$stage_dir")#" -xf -

  if [[ ! -d "$stage_dir" ]]; then
    log "Games archive restore did not produce ${stage_dir}"
    return 1
  fi

  rm -rf "$target_dir"
  mv "$stage_dir" "$target_dir"
  record_games_archive_time "$(jq -r '.timestamp // ""' "$GAMES_CURRENT_FILE")"
  set_games_archive_status "ready" "Restored games archive ${archive_rel}."
  return 0
}

restore_games_legacy_sync() {
  local root="$1"
  local mount_root target_dir stage_dir token legacy_remote

  mount_root="$(state_mount_root)"
  target_dir="$(mount_games_dir)"
  token="$(date +%s)"
  stage_dir="${mount_root}/games.restore.${token}"
  legacy_remote="$(legacy_games_dir_remote_path "$root")"

  rm -rf "$stage_dir"
  mkdir -p "$stage_dir"
  rclone --config "$RCLONE_CONFIG_PATH" sync "$legacy_remote" "$stage_dir"

  rm -rf "$target_dir"
  mv "$stage_dir" "$target_dir"
  set_games_archive_status "legacy" "Restored legacy games backup directory from Drive."
  return 0
}

restore_games() {
  local root="$1"
  local target_dir

  target_dir="$(mount_games_dir)"
  if ! is_dir_empty "$target_dir"; then
    log "Refusing to restore games into non-empty ${target_dir}"
    return 1
  fi

  if remote_file_exists "$(games_current_remote_path "$root")"; then
    restore_games_from_archive "$root"
    return 0
  fi

  if rclone --config "$RCLONE_CONFIG_PATH" lsf "$(legacy_games_dir_remote_path "$root")" >/dev/null 2>&1; then
    restore_games_legacy_sync "$root"
    return 0
  fi

  log "No games backup found in Drive"
  set_games_archive_status "missing" "No games archive found in Drive."
  return 0
}

backup_runtime_state() {
  local root timestamp
  root="$(remote_root)"
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  ensure_tools
  ensure_rclone_remote || return 0
  prepare_data_disk
  bind_data_paths
  if ! backup_is_ready; then
    log "Backup readiness marker is missing; skipping backup."
    return 0
  fi

  stop_stack
  backup_home "$root" "$timestamp"
  write_root_manifest "backup-runtime" "$root" "$timestamp"
  touch "$BACKUP_COMPLETE_MARKER"
  log "Runtime backup completed to ${root}"
}

backup_delete_state() {
  local root timestamp
  root="$(remote_root)"
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  ensure_tools
  ensure_rclone_remote || return 0
  prepare_data_disk
  bind_data_paths
  if ! backup_is_ready; then
    log "Backup readiness marker is missing; skipping backup."
    return 0
  fi

  stop_stack
  backup_home "$root" "$timestamp"
  backup_games_archive "$root" "$timestamp"
  write_root_manifest "backup-delete" "$root" "$timestamp"
  touch "$BACKUP_COMPLETE_MARKER"
  log "Delete backup completed to ${root}"
}

restore_create_state() {
  local root restored_any=0
  root="$(remote_root)"
  ensure_tools
  ensure_rclone_remote || return 0
  prepare_data_disk

  if [[ "$(metadata_get "$RESTORE_MODE_KEY")" != "create" ]]; then
    log "Restore gate is closed; skipping create-time restore."
    return 0
  fi

  set_restore_status "running" "Restoring persisted state from Google Drive."

  if ! remote_has_state "$root"; then
    set_restore_status "no-backup" "No persisted state found in Google Drive."
    set_games_archive_status "missing" "No games archive found in Drive."
    log "No persisted state found in Drive for ${root}"
    return 0
  fi

  if restore_home "$root"; then
    restored_any=1
  fi

  if restore_games "$root"; then
    if remote_file_exists "$(games_current_remote_path "$root")" || rclone --config "$RCLONE_CONFIG_PATH" lsf "$(legacy_games_dir_remote_path "$root")" >/dev/null 2>&1; then
      restored_any=1
    fi
  else
    set_restore_status "failed" "Games restore failed."
    return 1
  fi

  restore_stack_perms
  if [[ "$restored_any" -eq 1 ]]; then
    write_root_manifest "restore-create" "$root" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    set_restore_status "restored" "Persisted state restored from Google Drive."
  else
    set_restore_status "no-backup" "No persisted state found in Google Drive."
  fi
  log "Restore completed from ${root}"
}

status_state() {
  local root
  root="$(remote_root)"
  ensure_tools
  ensure_rclone_remote || return 0
  prepare_data_disk
  echo "REMOTE_ROOT=${root}"
  echo "STATE_MOUNT_ROOT=$(state_mount_root)"
  echo "DATA_DISK_DEVICE=$(data_disk_device_path)"
  rclone --config "$RCLONE_CONFIG_PATH" lsf "${REMOTE_NAME}:${root}" || true
}

cmd="${1:-}"
case "$cmd" in
  prepare-disk)
    ensure_tools
    prepare_data_disk
    ;;
  bind-mounts)
    ensure_tools
    bind_data_paths
    ;;
  backup)
    backup_runtime_state
    ;;
  backup-runtime)
    backup_runtime_state
    ;;
  backup-delete)
    backup_delete_state
    ;;
  restore)
    restore_create_state
    ;;
  restore-create)
    restore_create_state
    ;;
  start-stack)
    start_stack
    ;;
  clear-restore-mode)
    clear_restore_mode
    ;;
  status)
    status_state
    ;;
  *)
    echo "Usage: $0 {prepare-disk|bind-mounts|backup|backup-runtime|backup-delete|restore|restore-create|start-stack|clear-restore-mode|status}" >&2
    exit 1
    ;;
esac
