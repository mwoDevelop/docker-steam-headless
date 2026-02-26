#!/usr/bin/env bash
set -euo pipefail

# Run this manually over SSH if the startup script wasn't attached.

wait_for_apt_idle() {
  local n=0
  if command -v fuser >/dev/null 2>&1; then
    while fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1; do
      n=$((n + 1))
      if (( n % 10 == 0 )); then
        echo "[remote-setup] waiting for apt/dpkg lock..."
      fi
      sleep 3
    done
  else
    while pgrep -x apt-get >/dev/null 2>&1 || pgrep -x dpkg >/dev/null 2>&1; do
      n=$((n + 1))
      if (( n % 10 == 0 )); then
        echo "[remote-setup] waiting for apt/dpkg lock..."
      fi
      sleep 3
    done
  fi
}

export DEBIAN_FRONTEND=noninteractive
METADATA_HDR=( -H "Metadata-Flavor: Google" --fail --silent --show-error )
EXT_IP=$(curl "${METADATA_HDR[@]}" \
  http://metadata/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)
wait_for_apt_idle
apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release ubuntu-drivers-common jq

if ! command -v nvidia-smi >/dev/null 2>&1; then
  ubuntu-drivers autoinstall || true
  echo "Rebooting to load NVIDIA driver"
  reboot || true
  exit 0
fi

# Docker Engine + compose plugin
install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi
codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${codename} stable" \
  > /etc/apt/sources.list.d/docker.list
wait_for_apt_idle
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# NVIDIA Container Toolkit
if [ ! -f /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg ]; then
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
    gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
fi
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#' \
  > /etc/apt/sources.list.d/nvidia-container-toolkit.list
wait_for_apt_idle
apt-get update -y
apt-get install -y nvidia-container-toolkit
nvidia-ctk runtime configure --runtime=docker || true
systemctl restart docker

# Kernel modules needed by container
modprobe uinput || true
modprobe fuse || true
echo uinput > /etc/modules-load.d/uinput.conf

# Prepare host paths and compose
install -d -m 0755 /opt/container-services/steam-headless
install -d -m 0755 /opt/container-data/steam-headless/home
install -d -m 0755 /opt/container-data/steam-headless/sockets/.X11-unix
install -d -m 0755 /opt/container-data/steam-headless/sockets/pulse
install -d -m 0777 /mnt/games || true

COMPOSE_BASE=/opt/container-services/steam-headless/docker-compose.nvidia.privileged.yml
COMPOSE_GCE=/opt/container-services/steam-headless/docker-compose.nvidia.privileged.gce.yml
curl -fsSL \
  https://raw.githubusercontent.com/Steam-Headless/docker-steam-headless/master/docs/compose-files/docker-compose.nvidia.privileged.yml \
  -o "$COMPOSE_BASE"
cp -f "$COMPOSE_BASE" "$COMPOSE_GCE"
sed -i 's#/dev/input/:/dev/input/:ro#/dev/input/:/dev/input/:rw#' "$COMPOSE_GCE" || true

# Environment
ENVF=/opt/container-services/steam-headless/.env
if [ ! -f "$ENVF" ]; then
  curl -fsSL \
    https://raw.githubusercontent.com/Steam-Headless/docker-steam-headless/master/docs/compose-files/.env \
    -o "$ENVF"
fi
grep -q '^ENABLE_SUNSHINE=' "$ENVF" && \
  sed -i -E 's#^ENABLE_SUNSHINE=.*#ENABLE_SUNSHINE=true#' "$ENVF" || \
  echo "ENABLE_SUNSHINE=true" >> "$ENVF"
grep -q '^FORCE_X11_DUMMY_CONFIG=' "$ENVF" && \
  sed -i -E 's#^FORCE_X11_DUMMY_CONFIG=.*#FORCE_X11_DUMMY_CONFIG=true#' "$ENVF" || \
  echo "FORCE_X11_DUMMY_CONFIG=true" >> "$ENVF"
grep -q '^DISPLAY_SIZEW=' "$ENVF" || echo "DISPLAY_SIZEW=1920" >> "$ENVF"
grep -q '^DISPLAY_SIZEH=' "$ENVF" || echo "DISPLAY_SIZEH=1080" >> "$ENVF"

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

docker compose -f "$COMPOSE_GCE" up -d
docker compose -f "$COMPOSE_GCE" restart || true
docker exec -i $(docker ps -qf name=steam-headless) nvidia-smi || true
ss -lntup | egrep '(8083|47989|47990|48010)' || true
