#!/usr/bin/env bash
set -euo pipefail

# GCE startup script for Steam Headless on Ubuntu 22.04.
# Scope intentionally limited to base platform setup.
# Prism installation is handled separately by gcp/additional/install-prism.sh.

log() { echo "[startup] $*"; }

export DEBIAN_FRONTEND=noninteractive
METADATA_HDR=( -H "Metadata-Flavor: Google" --fail --silent --show-error )
EXT_IP=$(curl "${METADATA_HDR[@]}" \
  http://metadata/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)

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
curl -fsSL \
  https://raw.githubusercontent.com/Steam-Headless/docker-steam-headless/master/docs/compose-files/docker-compose.nvidia.privileged.yml \
  -o "$COMPOSE_BASE"
cp -f "$COMPOSE_BASE" "$COMPOSE_GCE"
sed -i 's#/dev/input/:/dev/input/:ro#/dev/input/:/dev/input/:rw#' "$COMPOSE_GCE" || true

ENVF=/opt/container-services/steam-headless/.env
if [ ! -f "$ENVF" ]; then
  SUNPASS=$(tr -dc A-Za-z0-9 </dev/urandom | head -c 18)
  cat > "$ENVF" <<'EOF'
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
USER_PASSWORD=password
MODE=primary
WEB_UI_MODE=vnc
ENABLE_VNC_AUDIO=true
PORT_NOVNC_WEB=8083
NEKO_NAT1TO1=
ENABLE_STEAM=true
STEAM_ARGS=-silent
ENABLE_SUNSHINE=true
SUNSHINE_USER=admin
SUNSHINE_PASS=
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
  sed -i -E "s#^(SUNSHINE_PASS)=.*#\1=${SUNPASS}#" "$ENVF"
else
  ensure_env_key() {
    local key="$1"
    local value="$2"
    if grep -q "^${key}=" "$ENVF"; then
      sed -i -E "s#^${key}=.*#${key}=${value}#" "$ENVF"
    else
      echo "${key}=${value}" >> "$ENVF"
    fi
  }
  ensure_env_key NAME "SteamHeadless"
  ensure_env_key TZ "Europe/Warsaw"
  ensure_env_key USER_LOCALES "en_US.UTF-8 UTF-8"
  ensure_env_key DISPLAY ":5"
  ensure_env_key SHM_SIZE "4GB"
  ensure_env_key HOME_DIR "/opt/container-data/steam-headless/home"
  ensure_env_key SHARED_SOCKETS_DIR "/opt/container-data/steam-headless/sockets"
  ensure_env_key GAMES_DIR "/mnt/games"
  ensure_env_key PUID "1000"
  ensure_env_key PGID "1000"
  ensure_env_key UMASK "000"
  ensure_env_key USER_PASSWORD "password"
  ensure_env_key MODE "primary"
  ensure_env_key WEB_UI_MODE "vnc"
  ensure_env_key ENABLE_VNC_AUDIO "true"
  ensure_env_key PORT_NOVNC_WEB "8083"
  ensure_env_key NEKO_NAT1TO1 ""
  ensure_env_key ENABLE_STEAM "true"
  ensure_env_key STEAM_ARGS "-silent"
  ensure_env_key ENABLE_SUNSHINE "true"
  ensure_env_key SUNSHINE_USER "admin"
  grep -q '^SUNSHINE_PASS=' "$ENVF" || echo "SUNSHINE_PASS=admin" >> "$ENVF"
  ensure_env_key ENABLE_EVDEV_INPUTS "true"
  ensure_env_key FORCE_X11_DUMMY_CONFIG "true"
  ensure_env_key DISPLAY_SIZEW "1920"
  ensure_env_key DISPLAY_SIZEH "1080"
  ensure_env_key DISPLAY_REFRESH "60"
  ensure_env_key DISPLAY_CDEPTH "24"
  ensure_env_key NVIDIA_DRIVER_CAPABILITIES "all"
  ensure_env_key NVIDIA_VISIBLE_DEVICES "all"
  grep -q '^NVIDIA_DRIVER_VERSION=' "$ENVF" || echo "NVIDIA_DRIVER_VERSION=" >> "$ENVF"
fi

docker compose -f "$COMPOSE_GCE" up -d

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

docker compose -f "$COMPOSE_GCE" restart || true

ss -lntup | egrep '(8083|47989|47990|48010)' || true
log "noVNC: http://${EXT_IP:-$(hostname -I | awk '{print $1}')}:8083/"
log "Sunshine UI: https://${EXT_IP:-$(hostname -I | awk '{print $1}')}:47990/"
exit 0
