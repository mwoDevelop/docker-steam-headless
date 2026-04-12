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

log "Installing base packages"
apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release ubuntu-drivers-common jq

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
chmod 600 "$ENVF"

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

ss -lntup | egrep '(8083|47989|47990|48010)' || true
log "noVNC: http://${EXT_IP:-$(hostname -I | awk '{print $1}')}:8083/"
log "Sunshine UI: https://${EXT_IP:-$(hostname -I | awk '{print $1}')}:47990/"
exit 0
