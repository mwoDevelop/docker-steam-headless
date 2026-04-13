#!/usr/bin/env bash
set -euo pipefail

# GCE startup script for Steam Headless on Ubuntu 22.04.
# Scope intentionally limited to base platform setup.
# Prism installation is handled separately by gcp-additional/install-prism.sh.

log() { echo "[startup] $*"; }

export DEBIAN_FRONTEND=noninteractive
METADATA_HDR=( -H "Metadata-Flavor: Google" --fail --silent --show-error )
EXT_IP=$(curl "${METADATA_HDR[@]}" \
  http://metadata/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)

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

set_instance_metadata_value() {
  local key="$1"
  local value="${2-}"
  local token project zone name instance_json fingerprint items payload
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
  items="$(printf '%s' "$instance_json" | jq --arg key "$key" '[.metadata.items // [] | .[] | select(.key != $key)]')"

  if [ -n "$value" ]; then
    payload="$(jq -n \
      --arg fingerprint "$fingerprint" \
      --arg key "$key" \
      --arg value "$value" \
      --argjson items "$items" \
      '{fingerprint: $fingerprint, items: ($items + [{key: $key, value: $value}])}')"
  else
    payload="$(jq -n \
      --arg fingerprint "$fingerprint" \
      --argjson items "$items" \
      '{fingerprint: $fingerprint, items: $items}')"
  fi

  curl --fail --silent --show-error \
    -X POST \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}/setMetadata" >/dev/null || true
}

set_sunshine_status() {
  local state="$1"
  local detail="${2-}"
  set_instance_metadata_value vm-sunshine-status "$state"
  set_instance_metadata_value vm-sunshine-status-detail "$detail"
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

sync_env_metadata() {
  local token project zone name instance_json fingerprint items payload
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
  payload="$(jq -n \
    --arg fingerprint "$fingerprint" \
    --arg env_value "$(cat "$ENVF")" \
    --argjson items "$items" \
    '{fingerprint: $fingerprint, items: ($items + [{key: "steam-headless-env", value: $env_value}])}')"

  curl --fail --silent --show-error \
    -X POST \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}/setMetadata" >/dev/null || true
}

schedule_auto_shutdown() {
  local hours
  local next_at
  hours="$(metadata_get vm-auto-shutdown-hours)"
  if ! [[ "$hours" =~ ^[0-9]+$ ]] || [ "$hours" -lt 1 ] || [ "$hours" -gt 24 ]; then
    return 0
  fi

  systemctl stop vm-ctl-auto-shutdown.timer vm-ctl-auto-shutdown.service >/dev/null 2>&1 || true
  systemctl reset-failed vm-ctl-auto-shutdown.timer vm-ctl-auto-shutdown.service >/dev/null 2>&1 || true
  systemd-run --unit=vm-ctl-auto-shutdown --on-active="${hours}h" /sbin/poweroff >/dev/null
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
    sed -i -E "s#^${key}=.*#${key}=${value}#" "$ENVF"
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

log "Installing base packages"
set_sunshine_status "starting" "VM startup in progress."
apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release ubuntu-drivers-common jq zstd rclone

if ! command -v nvidia-smi >/dev/null 2>&1; then
  log "Installing NVIDIA driver (ubuntu-drivers autoinstall)"
  ubuntu-drivers autoinstall || true
  log "Rebooting once to load GPU driver"
  reboot || true
  exit 0
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
systemctl enable --now docker

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
systemctl restart docker

modprobe uinput || true
modprobe fuse || true
echo uinput > /etc/modules-load.d/uinput.conf

install -d -m 0755 /opt/container-services/steam-headless
install -d -m 0755 /opt/container-data/steam-headless/home
install -d -m 0755 /opt/container-data/steam-headless/sockets/.X11-unix
install -d -m 0755 /opt/container-data/steam-headless/sockets/pulse
install -d -m 0777 /mnt/games || true
install_persist_script

cd /opt/container-services/steam-headless

COMPOSE_BASE=/opt/container-services/steam-headless/docker-compose.nvidia.privileged.yml
COMPOSE_GCE=/opt/container-services/steam-headless/docker-compose.nvidia.privileged.gce.yml
COMPOSE_OVERRIDE=/opt/container-services/steam-headless/docker-compose.nvidia.privileged.override.yml
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
ENV_METADATA="$(metadata_get steam-headless-env)"
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
ensure_env_key_missing ENABLE_SUNSHINE "true"
ensure_env_key_missing SUNSHINE_USER "admin"
ensure_env_key_missing SUNSHINE_PASS "change-me"
ensure_env_key_missing ENABLE_EVDEV_INPUTS "true"
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

if [ -x /usr/local/bin/vm-persist-state ]; then
  /usr/local/bin/vm-persist-state restore || log "State restore skipped or failed"
fi

docker compose "${COMPOSE_FILES[@]}" up -d

for _ in $(seq 1 60); do
  if ss -lntup | grep -qE ':8083\s|:47990\s'; then
    break
  fi
  sleep 2
done

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

docker compose "${COMPOSE_FILES[@]}" restart || true

schedule_auto_shutdown

sunshine_http_code=""
for _ in $(seq 1 60); do
  sunshine_http_code="$(curl -k --silent --output /dev/null --write-out '%{http_code}' --max-time 5 https://127.0.0.1:47990/ || true)"
  if [[ "$sunshine_http_code" == "200" || "$sunshine_http_code" == "401" || "$sunshine_http_code" == "403" ]]; then
    set_sunshine_status "ready" "Sunshine Web UI responded with HTTP ${sunshine_http_code}."
    break
  fi
  sleep 2
done

if [[ "$sunshine_http_code" != "200" && "$sunshine_http_code" != "401" && "$sunshine_http_code" != "403" ]]; then
  set_sunshine_status "starting" "VM is running, but Sunshine Web UI is still warming up."
fi

ss -lntup | egrep '(8083|47989|47990|48010)' || true
log "noVNC: http://${EXT_IP:-$(hostname -I | awk '{print $1}')}:8083/"
log "Sunshine UI: https://${EXT_IP:-$(hostname -I | awk '{print $1}')}:47990/"
exit 0
