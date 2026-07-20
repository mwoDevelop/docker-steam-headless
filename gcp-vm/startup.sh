#!/usr/bin/env bash
set -euo pipefail

# GCE startup script for Steam Headless on Ubuntu 22.04.
# Scope intentionally limited to base platform setup.
# Prism installation is handled separately by gcp-additional/install-prism.sh.

log() { echo "[startup] $*"; }

export DEBIAN_FRONTEND=noninteractive
METADATA_HDR=( -H "Metadata-Flavor: Google" --fail --silent --show-error )
STATE_DIR=${STATE_DIR:-/var/lib/vm-state}
BACKUP_READY_MARKER="${STATE_DIR}/backup-ready"
BACKUP_COMPLETE_MARKER="${STATE_DIR}/backup-complete"
EXT_IP=$(curl "${METADATA_HDR[@]}" \
  http://metadata/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)

metadata_get() {
  local key="$1"
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/instance/attributes/${key}" || true
}

metadata_get_from_instance() {
  local key="$1"
  local token project zone name instance_json
  token="$(metadata_token || true)"
  project="$(project_id || true)"
  zone="$(zone_name || true)"
  name="$(instance_name || true)"
  [[ -n "$token" && -n "$project" && -n "$zone" && -n "$name" ]] || return 1

  instance_json="$(curl --fail --silent --show-error \
    -H "Authorization: Bearer ${token}" \
    "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}" || true)"
  [[ -n "$instance_json" ]] || return 1

  printf '%s\n' "$instance_json" | jq -r --arg key "$key" \
    '.metadata.items // [] | map(select(.key == $key)) | .[0].value // empty'
}

metadata_get_with_retry_instance() {
  local key="$1"
  local retries="${2:-20}"
  local value=""
  local attempt=0

  while (( attempt < retries )); do
    value="$(metadata_get_from_instance "$key" || true)"
    if [[ -n "$value" ]]; then
      printf '%s\n' "$value"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done

  printf '%s\n' "$value"
  return 1
}

metadata_token() {
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/instance/service-accounts/default/token" \
    | jq -r '.access_token'
}

metadata_get_with_retry() {
  local key="$1"
  local retries="${2:-20}"
  local value=""
  local attempt=0

  while (( attempt < retries )); do
    value="$(metadata_get "$key" || true)"
    if [[ -n "$value" ]]; then
      printf '%s\n' "$value"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done

  printf '%s\n' "$value"
  return 1
}

wait_for_zone_operation() {
  local token="$1"
  local project="$2"
  local zone="$3"
  local operation_name="$4"
  local operation_json status
  [[ -n "$token" && -n "$project" && -n "$zone" && -n "$operation_name" ]] || return 0

  for _ in $(seq 1 30); do
    operation_json="$(curl --fail --silent --show-error \
      -H "Authorization: Bearer ${token}" \
      "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/operations/${operation_name}" || true)"
    status="$(printf '%s\n' "$operation_json" | jq -r '.status // empty' 2>/dev/null || true)"
    if [[ "$status" == "DONE" ]]; then
      return 0
    fi
    sleep 1
  done

  return 0
}

normalize_metadata_value() {
  local value="$1"
  if [[ "$value" == "|-"$'\n'* ]]; then
    value="${value#|-$'\n'}"
  fi
  printf '%s\n' "$value"
}

set_instance_metadata_value() {
  local key="$1"
  local value="${2-}"
  local token project zone name instance_json fingerprint items items_file payload payload_file operation_json operation_name
  token="$(metadata_token || true)"
  project="$(project_id || true)"
  zone="$(zone_name || true)"
  name="$(instance_name || true)"
  [[ -n "$token" && -n "$project" && -n "$zone" && -n "$name" ]] || return 0

  for attempt in 1 2 3 4 5; do
    instance_json="$(curl --fail --silent --show-error \
      -H "Authorization: Bearer ${token}" \
      "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}" || true)"
    [[ -n "$instance_json" ]] || return 0
    fingerprint="$(printf '%s' "$instance_json" | jq -r '.metadata.fingerprint // empty')"
    [[ -n "$fingerprint" ]] || return 0
    items="$(printf '%s' "$instance_json" | jq --arg key "$key" '[.metadata.items // [] | .[] | select(.key != $key)]')"
    items_file="$(mktemp)"
    printf '%s' "$items" > "$items_file"

    if [ -n "$value" ]; then
      payload="$(jq -n \
        --arg fingerprint "$fingerprint" \
        --arg key "$key" \
        --arg value "$value" \
        --slurpfile items "$items_file" \
        '{fingerprint: $fingerprint, items: ($items[0] + [{key: $key, value: $value}])}')"
    else
      payload="$(jq -n \
        --arg fingerprint "$fingerprint" \
        --slurpfile items "$items_file" \
        '{fingerprint: $fingerprint, items: $items[0]}')"
    fi
    rm -f "$items_file"
    payload_file="$(mktemp)"
    printf '%s' "$payload" > "$payload_file"

    if operation_json="$(curl --fail --silent --show-error \
      -X POST \
      -H "Authorization: Bearer ${token}" \
      -H "Content-Type: application/json" \
      --data-binary "@${payload_file}" \
      "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}/setMetadata")"; then
      rm -f "$payload_file"
      operation_name="$(printf '%s\n' "$operation_json" | jq -r '.name // empty' 2>/dev/null || true)"
      wait_for_zone_operation "$token" "$project" "$zone" "$operation_name"
      return 0
    fi
    rm -f "$payload_file"

    sleep 2
  done

  return 0
}

set_sunshine_status() {
  local state="$1"
  local detail="${2-}"
  set_instance_metadata_value vm-sunshine-status "$state"
  set_instance_metadata_value vm-sunshine-status-detail "$detail"
}

record_sunshine_version() {
  local container_id raw_version version
  container_id="$(docker compose "${COMPOSE_FILES[@]}" ps -q | head -n 1 || true)"
  [[ -n "$container_id" ]] || return 0
  raw_version="$(docker exec "$container_id" sunshine --version 2>/dev/null | head -n 1 || true)"
  version="$(printf '%s\n' "$raw_version" | grep -Eo '[0-9]+(\.[0-9]+){1,3}([+-][0-9A-Za-z.-]+)?' | head -n 1 || true)"
  [[ -n "$version" ]] && set_instance_metadata_value vm-sunshine-version "$version"
}

sunshine_video_startup_error() {
  local container_id
  container_id="$(docker compose "${COMPOSE_FILES[@]}" ps -q | head -n 1 || true)"
  [[ -n "$container_id" ]] || return 1
  docker exec "$container_id" bash -lc "grep -E -m1 'Fatal: Unable to find display or encoder|Fatal: Please check that a display is connected|Video failed to find working encoder' /home/default/.config/sunshine/sunshine.log 2>/dev/null" || true
}

clear_backup_ready_marker() {
  install -d -m 0755 "$STATE_DIR"
  rm -f "$BACKUP_READY_MARKER"
  rm -f "$BACKUP_COMPLETE_MARKER"
  set_instance_metadata_value vm-backup-ready-at ""
}

mark_backup_ready() {
  local timestamp
  install -d -m 0755 "$STATE_DIR"
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  printf '%s\n' "$timestamp" > "$BACKUP_READY_MARKER"
  set_instance_metadata_value vm-backup-ready-at "$timestamp"
}

instance_name() {
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/instance/name"
}

project_id() {
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/project/project-id"
}

zone_name() {
  local zone
  zone="$(curl "${METADATA_HDR[@]}" "http://metadata/computeMetadata/v1/instance/zone")"
  printf '%s\n' "${zone##*/}"
}

install_persist_script() {
  local payload
  local target=/usr/local/bin/vm-persist-state
  payload="$(metadata_get vm-persist-script)"
  [[ -n "$payload" ]] || return 0
  install -d -m 0755 "$(dirname "$target")"
  printf '%s\n' "$payload" > "$target"
  chmod 0755 "$target"
}

install_power_action_script() {
  local payload
  local target=/usr/local/bin/vm-power-action
  payload="$(metadata_get vm-power-action-script)"
  [[ -n "$payload" ]] || return 0
  install -d -m 0755 "$(dirname "$target")"
  printf '%s\n' "$payload" > "$target"
  chmod 0755 "$target"
}

install_power_action_service() {
  local service_path=/etc/systemd/system/vm-power-action-daemon.service
  if [[ ! -x /usr/local/bin/vm-power-action ]]; then
    return 0
  fi
  cat > "$service_path" <<'EOF'
[Unit]
Description=VM power action daemon
After=network-online.target google-guest-agent.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/vm-power-action daemon
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now vm-power-action-daemon.service >/dev/null 2>&1 || true
}

install_minecraft_management_script() {
  local payload
  local target=/usr/local/bin/vm-minecraft-management
  payload="$(metadata_get vm-minecraft-management-script)"
  [[ -n "$payload" ]] || return 0
  install -d -m 0755 "$(dirname "$target")"
  printf '%s\n' "$payload" > "$target"
  chmod 0755 "$target"
}

install_minecraft_management_service() {
  local service_path=/etc/systemd/system/vm-minecraft-management.service
  if [[ ! -x /usr/local/bin/vm-minecraft-management ]]; then
    return 0
  fi
  cat > "$service_path" <<'EOF'
[Unit]
Description=VM Minecraft RCON management agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/vm-minecraft-management daemon
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  # The unit can be auto-started from a previous boot before this startup
  # script replaces the agent binary. Restart it explicitly so it always runs
  # the version just installed from instance metadata.
  systemctl enable vm-minecraft-management.service >/dev/null 2>&1 || true
  systemctl restart vm-minecraft-management.service >/dev/null 2>&1 || true
}

mark_minecraft_management_agent_ready() {
  [[ -x /usr/local/bin/vm-minecraft-management ]] || return 0
  if systemctl is-active --quiet vm-minecraft-management.service; then
    set_instance_metadata_value vm-minecraft-management-agent "ready"
  fi
}

sync_env_metadata() {
  local token project zone name instance_json fingerprint items items_file env_file payload payload_file
  token="$(metadata_token || true)"
  project="$(project_id || true)"
  zone="$(zone_name || true)"
  name="$(instance_name || true)"
  [[ -n "$token" && -n "$project" && -n "$zone" && -n "$name" ]] || return 0

  instance_json="$(curl --fail --silent --show-error \
    -H "Authorization: Bearer ${token}" \
    "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}" || true)"
  [[ -n "$instance_json" ]] || return 0
  fingerprint="$(printf '%s' "$instance_json" | jq -r '.metadata.fingerprint // empty')"
  [[ -n "$fingerprint" ]] || return 0
  items="$(printf '%s' "$instance_json" | jq '[.metadata.items // [] | .[] | select(.key != "steam-headless-env")]')"
  items_file="$(mktemp)"
  env_file="$(mktemp)"
  printf '%s' "$items" > "$items_file"
  cat "$ENVF" > "$env_file"
  payload="$(jq -n \
    --arg fingerprint "$fingerprint" \
    --rawfile env_value "$env_file" \
    --slurpfile items "$items_file" \
    '{fingerprint: $fingerprint, items: ($items[0] + [{key: "steam-headless-env", value: $env_value}])}')"
  rm -f "$items_file" "$env_file"
  payload_file="$(mktemp)"
  printf '%s' "$payload" > "$payload_file"

  curl --fail --silent --show-error \
    -X POST \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    --data-binary "@${payload_file}" \
    "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}/setMetadata" >/dev/null || true
  rm -f "$payload_file"
}

clear_restore_mode() {
  set_instance_metadata_value vm-restore-mode ""
}

schedule_auto_shutdown() {
  local hours
  local next_at
  hours="$(metadata_get vm-auto-shutdown-hours)"
  if ! [[ "$hours" =~ ^[0-9]+$ ]] || [ "$hours" -lt 1 ] || [ "$hours" -gt 24 ]; then
    systemctl stop vm-ctl-auto-shutdown.timer vm-ctl-auto-shutdown.service >/dev/null 2>&1 || true
    systemctl reset-failed vm-ctl-auto-shutdown.timer vm-ctl-auto-shutdown.service >/dev/null 2>&1 || true
    set_instance_metadata_value vm-auto-shutdown-at ""
    log "Auto-shutdown is disabled (vm-auto-shutdown-hours is empty or invalid); cleared existing timer."
    return 0
  fi

  systemctl stop vm-ctl-auto-shutdown.timer vm-ctl-auto-shutdown.service >/dev/null 2>&1 || true
  systemctl reset-failed vm-ctl-auto-shutdown.timer vm-ctl-auto-shutdown.service >/dev/null 2>&1 || true
  systemd-run --unit=vm-ctl-auto-shutdown --on-active="${hours}h" /usr/local/bin/vm-power-action auto-stop >/dev/null
  set_instance_metadata_value vm-auto-shutdown-at "$(date -u -d "+${hours} hours" +"%Y-%m-%dT%H:%M:%SZ")"
  next_at="$(systemctl show vm-ctl-auto-shutdown.timer --property=NextElapseUSecRealtime --value 2>/dev/null || true)"
  log "Auto-shutdown scheduled in ${hours}h${next_at:+ at ${next_at}}"
}

render_default_env() {
  cat <<'EOF'
NAME=SteamHeadless
TZ=Europe/Warsaw
USER_LOCALES=en_US.UTF-8 UTF-8
DISPLAY=:5
SHM_SIZE=4GB
HOME_DIR=/opt/container-data/steam-headless/home
SHARED_SOCKETS_DIR=/opt/container-data/steam-headless/sockets
GAMES_DIR=/mnt/games
PUID=1000
PGID=1000
UMASK=000
USER_PASSWORD=change-me
MODE=primary
WEB_UI_MODE=vnc
ENABLE_VNC_AUDIO=true
PORT_NOVNC_WEB=8083
NEKO_NAT1TO1=
ENABLE_STEAM=true
STEAM_ARGS=-silent
ENABLE_SUNSHINE=true
SUNSHINE_USER=admin
SUNSHINE_PASS=change-me
ENABLE_EVDEV_INPUTS=true
FORCE_X11_DUMMY_CONFIG=true
DISPLAY_SIZEW=1920
DISPLAY_SIZEH=1080
DISPLAY_REFRESH=60
DISPLAY_CDEPTH=24
NVIDIA_DRIVER_CAPABILITIES=all
NVIDIA_VISIBLE_DEVICES=all
NVIDIA_DRIVER_VERSION=
EOF
}

ensure_env_key_missing() {
  local key="$1"
  local value="$2"
  grep -q "^${key}=" "$ENVF" || echo "${key}=${value}" >> "$ENVF"
}

set_env_value() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENVF"; then
    awk -v key="$key" -v value="$value" 'BEGIN{replaced=0} $0 ~ "^" key "=" {if (!replaced) print key "=" value; replaced=1; next} {print} END{if (!replaced) print key "=" value}' "$ENVF" > "${ENVF}.tmp"
    mv "${ENVF}.tmp" "$ENVF"
  else
    echo "${key}=${value}" >> "$ENVF"
  fi
}

generate_runtime_password() {
  od -An -N12 -tx1 /dev/urandom | tr -d ' \n'
}

ensure_sunshine_credentials() {
  local current_pass
  set_env_value SUNSHINE_USER "admin"
  current_pass="$(awk -F= '/^SUNSHINE_PASS=/{print substr($0,index($0,"=")+1)}' "$ENVF" | tail -n1)"
  if [ -z "$current_pass" ] || [ "$current_pass" = "change-me" ]; then
    set_env_value SUNSHINE_PASS "$(generate_runtime_password)"
    log "Generated runtime Sunshine password"
  fi
}

apply_sunshine_state_credentials() {
  local user pass container_id sunshine_container
  local attempts=0
  user="$(awk -F= '/^SUNSHINE_USER=/{print substr($0,index($0,"=")+1)}' "$ENVF" | tail -n1)"
  pass="$(awk -F= '/^SUNSHINE_PASS=/{print substr($0,index($0,"=")+1)}' "$ENVF" | tail -n1)"
  if [ -z "$user" ] || [ -z "$pass" ]; then
    return 0
  fi

  while (( attempts < 20 )); do
    attempts=$((attempts + 1))
    container_id="$(docker compose "${COMPOSE_FILES[@]}" ps -q | head -n 1 || true)"
    if [ -n "$container_id" ]; then
      if docker exec "$container_id" which sunshine >/dev/null 2>&1; then
        if docker exec "$container_id" sunshine --creds "$user" "$pass" >/dev/null 2>&1; then
          return 0
        fi
      fi
    fi
    sleep 2
  done
}

reconcile_docker_service() {
  local start_failed
  systemctl unmask docker.service docker.socket 2>/dev/null || true
  systemctl stop docker.service docker.socket 2>/dev/null || true
  systemctl reset-failed docker.service docker.socket 2>/dev/null || true
  systemctl start docker.service 2>/dev/null
  start_failed=$?
  if [ "$start_failed" -ne 0 ]; then
    systemctl start docker.socket 2>/dev/null || true
    systemctl start docker.service 2>/dev/null || true
  fi
}

is_nvidia_ready() {
  command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1
}

gpu_enabled() {
  local count
  count="$(metadata_get vm-gpu-count)"
  [[ -z "$count" || "$count" != "0" ]]
}

display_capable_gpu() {
  case "$(metadata_get vm-gpu-type)" in
    nvidia-tesla-t4-vws|nvidia-l4-vws)
      return 0
      ;;
  esac
  return 1
}

is_nvidia_vws_driver_ready() {
  is_nvidia_ready && nvidia-smi -q 2>/dev/null | \
    awk '/vGPU Software Licensed Product/{section=1} section && /Product Name[[:space:]]*:[[:space:]]*NVIDIA RTX Virtual Workstation/{found=1} END{exit !found}'
}

legacy_vws_driver_url() {
  case "$(metadata_get vm-gpu-type)" in
    nvidia-tesla-p4-vws|nvidia-tesla-p100-vws)
      printf '%s\n' 'https://storage.googleapis.com/nvidia-drivers-us-public/GRID/vGPU16.14/nvidia-linux-grid-535_535.309.01_amd64.deb'
      ;;
  esac
}

remove_generic_nvidia_driver() {
  local packages=()
  while IFS= read -r package; do
    [[ -n "$package" ]] && packages+=("$package")
  done < <(dpkg-query -W -f='${db:Status-Status} ${binary:Package}\n' \
    'nvidia-driver-*' 'nvidia-dkms-*' 'nvidia-utils-*' 'nvidia-compute-utils-*' \
    'nvidia-kernel-common-*' 'nvidia-kernel-source-*' 'nvidia-firmware-*' 2>/dev/null | \
    awk '$1 == "installed" {print $2}')
  [[ ${#packages[@]} -eq 0 ]] || apt-get purge -y "${packages[@]}"
}

ensure_nvidia_vws_driver() {
  local retry_file="${STATE_DIR}/nvidia-vws-driver-installing"
  local installer_dir="/opt/google/cuda-installer"
  local installer_file="${installer_dir}/cuda_installer.pyz"
  local legacy_driver_url=""
  local legacy_driver_deb=""

  if [[ -f "$retry_file" ]]; then
    for _ in $(seq 1 30); do
      modprobe nvidia 2>/dev/null || true
      modprobe nvidia_uvm 2>/dev/null || true
      if is_nvidia_vws_driver_ready; then
        rm -f "$retry_file"
        return 0
      fi
      sleep 2
    done
  fi

  if [[ -f "$retry_file" ]]; then
    log "Continuing NVIDIA RTX vWS driver installation after reboot."
  else
    log "Installing the Google Compute Engine NVIDIA RTX vWS driver."
    touch "$retry_file"
  fi
  mkdir -p "$installer_dir"
  if ! curl -fsSL https://storage.googleapis.com/compute-gpu-installation-us/installer/latest/cuda_installer.pyz -o "$installer_file"; then
    rm -f "$retry_file"
    set_sunshine_status "error" "Could not download the NVIDIA RTX vWS driver installer."
    return 1
  fi
  chmod 0755 "$installer_file"

  legacy_driver_url="$(legacy_vws_driver_url)"
  if [[ -z "$legacy_driver_url" ]] && is_nvidia_ready && ! is_nvidia_vws_driver_ready; then
    python3 "$installer_file" uninstall_driver || true
    if ! remove_generic_nvidia_driver; then
      rm -f "$retry_file"
      set_sunshine_status "error" "Could not remove the generic NVIDIA driver before installing NVIDIA RTX vWS."
      return 1
    fi
  fi
  if [[ -n "$legacy_driver_url" ]]; then
    legacy_driver_deb="${installer_dir}/$(basename "$legacy_driver_url")"
    apt-get install -y build-essential libvulkan1 gcc-12 "linux-headers-$(uname -r)"
    update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-12 12 || true
    if ! curl -fsSL "$legacy_driver_url" -o "$legacy_driver_deb"; then
      rm -f "$retry_file"
      set_sunshine_status "error" "Could not download the legacy NVIDIA RTX vWS driver."
      return 1
    fi
    if ! dpkg -i "$legacy_driver_deb" && ! apt-get install -f -y; then
      rm -f "$retry_file"
      set_sunshine_status "error" "Legacy NVIDIA RTX vWS driver installation failed."
      return 1
    fi
    if is_nvidia_vws_driver_ready; then
      rm -f "$retry_file"
      return 0
    fi
    log "Rebooting once to activate the legacy NVIDIA RTX vWS driver."
    reboot || true
    exit 0
  fi

  if ! python3 "$installer_file" install_driver --installation-mode=binary --installation-branch=lts; then
    rm -f "$retry_file"
    set_sunshine_status "error" "NVIDIA RTX vWS driver installation failed."
    return 1
  fi

  if is_nvidia_vws_driver_ready; then
    rm -f "$retry_file"
    return 0
  fi

  log "Rebooting once to activate the NVIDIA RTX vWS driver."
  reboot || true
  exit 0
}

ensure_nvidia_driver() {
  local retry_file="${STATE_DIR}/nvidia-driver-bootstrapped"
  if display_capable_gpu; then
    ensure_nvidia_vws_driver
    return $?
  fi
  if is_nvidia_ready; then
    rm -f "$retry_file"
    return 0
  fi

  if [[ -f "$retry_file" ]]; then
    log "NVIDIA stack is still unavailable after a previous repair attempt."
    return 1
  fi

  log "NVIDIA stack not ready. Installing/reinstalling drivers before reboot."
  touch "$retry_file"
  apt-get update -y
  apt-get install -y \
    "linux-headers-$(uname -r)" \
    dkms || true
  ubuntu-drivers autoinstall || true

  modprobe nvidia || true
  modprobe nvidia_uvm || true

  if is_nvidia_ready; then
    rm -f "$retry_file"
    return 0
  fi

  log "Rebooting once to finish NVIDIA driver load."
  reboot || true
  exit 0
}

log "Installing base packages"
clear_backup_ready_marker
set_sunshine_status "starting" "VM startup in progress."
apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release python3 ubuntu-drivers-common jq zstd rclone
if gpu_enabled; then
  ensure_nvidia_driver
  is_nvidia_ready || log "NVIDIA stack check warning: proceeding with best-effort startup."
else
  log "GPU_COUNT=0; skipping NVIDIA driver bootstrap."
fi

install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
    gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi
codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${codename} stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable docker
reconcile_docker_service

if gpu_enabled; then
  if [ ! -f /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg ]; then
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
      gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  fi
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
    sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update -y
  apt-get install -y nvidia-container-toolkit
  nvidia-ctk runtime configure --runtime=docker || true
  reconcile_docker_service
else
  log "GPU_COUNT=0; skipping NVIDIA container toolkit."
fi

modprobe uinput || true
modprobe fuse || true
echo uinput > /etc/modules-load.d/uinput.conf

install -d -m 0755 /opt/container-services/steam-headless
install -d -m 0755 /opt/container-data/steam-headless/sockets/.X11-unix
install -d -m 0755 /opt/container-data/steam-headless/sockets/pulse
install_persist_script
install_power_action_script
install_power_action_service

if [[ -x /usr/local/bin/vm-persist-state ]]; then
  if ! /usr/local/bin/vm-persist-state prepare-disk; then
    set_sunshine_status "error" "Shared data disk preparation failed."
    log "Shared data disk preparation failed"
    exit 1
  fi
fi

install -d -m 0755 /opt/container-data/steam-headless/home
install -d -m 0777 /mnt/games || true

cd /opt/container-services/steam-headless

COMPOSE_BASE=/opt/container-services/steam-headless/docker-compose.nvidia.privileged.yml
COMPOSE_GCE=/opt/container-services/steam-headless/docker-compose.nvidia.privileged.gce.yml
COMPOSE_OVERRIDE=/opt/container-services/steam-headless/docker-compose.nvidia.privileged.override.yml
COMPOSE_IMAGE_OVERRIDE=/opt/container-services/steam-headless/docker-compose.image.override.yml
curl -fsSL \
  https://raw.githubusercontent.com/Steam-Headless/docker-steam-headless/master/docs/compose-files/docker-compose.nvidia.privileged.yml \
  -o "$COMPOSE_BASE"
cp -f "$COMPOSE_BASE" "$COMPOSE_GCE"
sed -i 's#/dev/input/:/dev/input/:ro#/dev/input/:/dev/input/:rw#' "$COMPOSE_GCE" || true
if [ ! -f "$COMPOSE_OVERRIDE" ]; then
  cat > "$COMPOSE_OVERRIDE" <<'EOF'
---
version: "3.8"

services:
  steam-headless:
    environment:
      - DISPLAY_SIZEW=${DISPLAY_SIZEW}
      - DISPLAY_SIZEH=${DISPLAY_SIZEH}
      - DISPLAY_REFRESH=${DISPLAY_REFRESH}
      - DISPLAY_CDEPTH=${DISPLAY_CDEPTH}
EOF
fi
COMPOSE_FILES=(-f "$COMPOSE_GCE")
if [ -f "$COMPOSE_OVERRIDE" ]; then
  COMPOSE_FILES+=(-f "$COMPOSE_OVERRIDE")
fi

ENVF=/opt/container-services/steam-headless/.env
ENV_METADATA="$(metadata_get_with_retry steam-headless-env 20)"
if [[ -z "$ENV_METADATA" ]]; then
  ENV_METADATA="$(metadata_get_with_retry_instance steam-headless-env 20)"
fi
ENV_METADATA="$(normalize_metadata_value "$ENV_METADATA")"
if [ -n "$ENV_METADATA" ]; then
  printf '%s\n' "$ENV_METADATA" > "$ENVF"
elif [ ! -f "$ENVF" ]; then
  render_default_env > "$ENVF"
fi

ensure_env_key_missing NAME "SteamHeadless"
ensure_env_key_missing TZ "Europe/Warsaw"
ensure_env_key_missing USER_LOCALES "en_US.UTF-8 UTF-8"
ensure_env_key_missing DISPLAY ":5"
ensure_env_key_missing SHM_SIZE "4GB"
ensure_env_key_missing HOME_DIR "/opt/container-data/steam-headless/home"
ensure_env_key_missing SHARED_SOCKETS_DIR "/opt/container-data/steam-headless/sockets"
ensure_env_key_missing GAMES_DIR "/mnt/games"
ensure_env_key_missing PUID "1000"
ensure_env_key_missing PGID "1000"
ensure_env_key_missing UMASK "000"
ensure_env_key_missing USER_PASSWORD "change-me"
ensure_env_key_missing MODE "primary"
ensure_env_key_missing WEB_UI_MODE "vnc"
ensure_env_key_missing ENABLE_VNC_AUDIO "true"
ensure_env_key_missing PORT_NOVNC_WEB "8083"
ensure_env_key_missing NEKO_NAT1TO1 ""
ensure_env_key_missing ENABLE_STEAM "true"
ensure_env_key_missing STEAM_ARGS "-silent"
ensure_env_key_missing STEAM_HEADLESS_IMAGE "josh5/steam-headless:debian-dev-frontend-revamp"
ensure_env_key_missing ENABLE_SUNSHINE "true"
ensure_env_key_missing SUNSHINE_USER "admin"
ensure_env_key_missing SUNSHINE_PASS "change-me"
set_env_value ENABLE_EVDEV_INPUTS "true"
ensure_env_key_missing FORCE_X11_DUMMY_CONFIG "true"
ensure_env_key_missing DISPLAY_SIZEW "1920"
ensure_env_key_missing DISPLAY_SIZEH "1080"
ensure_env_key_missing DISPLAY_REFRESH "60"
ensure_env_key_missing DISPLAY_CDEPTH "24"
ensure_env_key_missing NVIDIA_DRIVER_CAPABILITIES "all"
ensure_env_key_missing NVIDIA_VISIBLE_DEVICES "all"
ensure_env_key_missing NVIDIA_DRIVER_VERSION ""
ensure_sunshine_credentials
chmod 600 "$ENVF"
sync_env_metadata

STEAM_HEADLESS_IMAGE_VALUE="$(awk -F= '/^STEAM_HEADLESS_IMAGE=/{print substr($0,index($0,"=")+1)}' "$ENVF" | tail -n1)"
STEAM_HEADLESS_IMAGE_VALUE="${STEAM_HEADLESS_IMAGE_VALUE:-josh5/steam-headless:debian-dev-frontend-revamp}"
cat > "$COMPOSE_IMAGE_OVERRIDE" <<EOF
---
version: "3.8"

services:
  steam-headless:
    image: ${STEAM_HEADLESS_IMAGE_VALUE}
EOF
COMPOSE_FILES+=(-f "$COMPOSE_IMAGE_OVERRIDE")

if [ -x /usr/local/bin/vm-persist-state ]; then
  if ! /usr/local/bin/vm-persist-state restore-create; then
    set_sunshine_status "starting" "Persisted state restore failed. Continuing with fresh state."
    log "State restore failed; continuing startup without restored state"
  fi
  if ! /usr/local/bin/vm-persist-state bind-mounts; then
    set_sunshine_status "error" "Shared data disk bind mounts failed."
    log "Shared data disk bind mounts failed"
    exit 1
  fi
fi

install_minecraft_management_script
install_minecraft_management_service

if ! gpu_enabled; then
  mark_backup_ready
  log "Backup readiness marker created for CPU-only VM"
  schedule_auto_shutdown
  set_sunshine_status "disabled" "GPU disabled for this VM; Sunshine stack was not started."
  if ! /usr/local/bin/vm-power-action reconcile-minecraft; then
    log "Minecraft startup reconciliation failed."
  fi
  mark_minecraft_management_agent_ready
  exit 0
fi

docker compose "${COMPOSE_FILES[@]}" up -d --force-recreate

for _ in $(seq 1 60); do
  if ss -lntup | grep -qE ':8083\s|:47990\s'; then
    break
  fi
  sleep 2
done

container_id="$(docker compose "${COMPOSE_FILES[@]}" ps -q | head -n 1 || true)"
if [ -n "$container_id" ]; then
  if ! docker exec --user root "$container_id" bash -lc '
    set -e
    install -d -m 0777 /opt/frontend/utils
    if [ ! -x /opt/frontend/utils/websockify/run ]; then
      rm -rf /opt/frontend/utils/websockify
      git clone --depth=1 https://github.com/novnc/websockify /opt/frontend/utils/websockify
      chmod -R a+rX /opt/frontend/utils/websockify
    fi
  '; then
    log "noVNC websockify bootstrap failed; continuing with Sunshine startup."
  fi
fi

CFG_HOST="/opt/container-data/steam-headless/home/.config/sunshine/sunshine.conf"
mkdir -p "$(dirname "$CFG_HOST")"
touch "$CFG_HOST"
sed -i -E \
  -e '/origin_web_ui_allowed\s*=.*/d' \
  -e '/origin_pin_allowed\s*=.*/d' \
  -e '/external_ip\s*=.*/d' \
  "$CFG_HOST" || true
{
  echo
  echo "origin_web_ui_allowed = wan"
  echo "origin_pin_allowed = wan"
  if [ -n "$EXT_IP" ]; then
    echo "external_ip = $EXT_IP"
  fi
} >> "$CFG_HOST"

apply_sunshine_state_credentials

docker compose "${COMPOSE_FILES[@]}" restart || true
mark_backup_ready
log "Backup readiness marker created"

schedule_auto_shutdown
if [[ "$(metadata_get vm-restore-mode)" == "create" ]]; then
  clear_restore_mode
  log "Cleared create-time restore gate"
fi

sunshine_http_code=""
sunshine_ready_polls=0
sunshine_video_error=""
for _ in $(seq 1 60); do
  sunshine_video_error="$(sunshine_video_startup_error || true)"
  if [[ -n "$sunshine_video_error" ]]; then
    set_sunshine_status "error" "Sunshine video initialization failed: ${sunshine_video_error}"
    break
  fi
  sunshine_http_code="$(curl -k --silent --output /dev/null --write-out '%{http_code}' --max-time 5 https://127.0.0.1:47990/ || true)"
  if [[ "$sunshine_http_code" == "200" || "$sunshine_http_code" == "401" || "$sunshine_http_code" == "403" ]]; then
    sunshine_ready_polls=$((sunshine_ready_polls + 1))
    if [[ "$sunshine_ready_polls" -ge 6 ]]; then
      record_sunshine_version
      set_sunshine_status "ready" "Sunshine Web UI and video initialization are ready."
      break
    fi
  else
    sunshine_ready_polls=0
  fi
  sleep 2
done

if [[ -z "$sunshine_video_error" && "$sunshine_ready_polls" -lt 6 ]]; then
  set_sunshine_status "starting" "VM is running, but Sunshine Web UI is still warming up."
fi

if ! /usr/local/bin/vm-power-action reconcile-minecraft; then
  log "Minecraft startup reconciliation failed."
fi
mark_minecraft_management_agent_ready

ss -lntup | egrep '(8083|47989|47990|48010)' || true
log "noVNC: http://${EXT_IP:-$(hostname -I | awk '{print $1}')}:8083/"
log "Sunshine UI: https://${EXT_IP:-$(hostname -I | awk '{print $1}')}:47990/"
exit 0
