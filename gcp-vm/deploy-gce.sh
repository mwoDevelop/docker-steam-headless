#!/usr/bin/env bash
set -euo pipefail

# Simple, repeatable deployment of a GPU VM on GCE with docker-steam-headless.
# - Creates/updates firewall rules for noVNC and Sunshine
# - Creates the VM (if missing) with a T4 GPU
# - Attaches a startup-script that installs NVIDIA driver, Docker, and brings the stack up

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")"/.. && pwd)
STARTUP_SCRIPT="${ROOT_DIR}/gcp-vm/startup.sh"

# Config (single source of truth)
CFG_FILE="${ROOT_DIR}/gcp-vm/.env"
if [[ -f "$CFG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CFG_FILE"
fi

# Defaults (overridable via environment or gcp-vm/.env)
GCP_PROJECT=${GCP_PROJECT:-}
GCP_ZONE=${GCP_ZONE:-europe-central2-b}
GCE_NAME=${GCE_NAME:-steam-gpu}
MACHINE_TYPE=${MACHINE_TYPE:-n1-standard-4}
GPU_TYPE=${GPU_TYPE:-nvidia-tesla-t4}
GPU_COUNT=${GPU_COUNT:-1}
BOOT_DISK_SIZE=${BOOT_DISK_SIZE:-120GB}
BOOT_DISK_TYPE=${BOOT_DISK_TYPE:-pd-ssd}
TAGS=${TAGS:-steam-headless}
# CIDR allowed to reach Web UI and Sunshine (set to your IP/32 for safety)
ALLOW_CIDR=${ALLOW_CIDR:-0.0.0.0/0}

NAME=${NAME:-SteamHeadless}
TZ=${TZ:-Europe/Warsaw}
USER_LOCALES="${USER_LOCALES:-en_US.UTF-8 UTF-8}"
DISPLAY=${DISPLAY:-:5}
SHM_SIZE=${SHM_SIZE:-4GB}
HOME_DIR=${HOME_DIR:-/opt/container-data/steam-headless/home}
SHARED_SOCKETS_DIR=${SHARED_SOCKETS_DIR:-/opt/container-data/steam-headless/sockets}
GAMES_DIR=${GAMES_DIR:-/mnt/games}
PUID=${PUID:-1000}
PGID=${PGID:-1000}
UMASK=${UMASK:-000}
USER_PASSWORD=${USER_PASSWORD:-change-me}
MODE=${MODE:-primary}
WEB_UI_MODE=${WEB_UI_MODE:-vnc}
ENABLE_VNC_AUDIO=${ENABLE_VNC_AUDIO:-true}
PORT_NOVNC_WEB=${PORT_NOVNC_WEB:-8083}
NEKO_NAT1TO1=${NEKO_NAT1TO1:-}
ENABLE_STEAM=${ENABLE_STEAM:-true}
STEAM_ARGS=${STEAM_ARGS:--silent}
ENABLE_SUNSHINE=${ENABLE_SUNSHINE:-true}
SUNSHINE_USER=${SUNSHINE_USER:-admin}
SUNSHINE_PASS=${SUNSHINE_PASS:-change-me}
ENABLE_EVDEV_INPUTS=${ENABLE_EVDEV_INPUTS:-true}
FORCE_X11_DUMMY_CONFIG=${FORCE_X11_DUMMY_CONFIG:-true}
DISPLAY_SIZEW=${DISPLAY_SIZEW:-1920}
DISPLAY_SIZEH=${DISPLAY_SIZEH:-1080}
DISPLAY_REFRESH=${DISPLAY_REFRESH:-60}
DISPLAY_CDEPTH=${DISPLAY_CDEPTH:-24}
NVIDIA_DRIVER_CAPABILITIES=${NVIDIA_DRIVER_CAPABILITIES:-all}
NVIDIA_VISIBLE_DEVICES=${NVIDIA_VISIBLE_DEVICES:-all}
NVIDIA_DRIVER_VERSION=${NVIDIA_DRIVER_VERSION:-}

render_steam_headless_env() {
  cat <<EOF
NAME=${NAME}
TZ=${TZ}
USER_LOCALES=${USER_LOCALES}
DISPLAY=${DISPLAY}
SHM_SIZE=${SHM_SIZE}
HOME_DIR=${HOME_DIR}
SHARED_SOCKETS_DIR=${SHARED_SOCKETS_DIR}
GAMES_DIR=${GAMES_DIR}
PUID=${PUID}
PGID=${PGID}
UMASK=${UMASK}
USER_PASSWORD=${USER_PASSWORD}
MODE=${MODE}
WEB_UI_MODE=${WEB_UI_MODE}
ENABLE_VNC_AUDIO=${ENABLE_VNC_AUDIO}
PORT_NOVNC_WEB=${PORT_NOVNC_WEB}
NEKO_NAT1TO1=${NEKO_NAT1TO1}
ENABLE_STEAM=${ENABLE_STEAM}
STEAM_ARGS=${STEAM_ARGS}
ENABLE_SUNSHINE=${ENABLE_SUNSHINE}
SUNSHINE_USER=${SUNSHINE_USER}
SUNSHINE_PASS=${SUNSHINE_PASS}
ENABLE_EVDEV_INPUTS=${ENABLE_EVDEV_INPUTS}
FORCE_X11_DUMMY_CONFIG=${FORCE_X11_DUMMY_CONFIG}
DISPLAY_SIZEW=${DISPLAY_SIZEW}
DISPLAY_SIZEH=${DISPLAY_SIZEH}
DISPLAY_REFRESH=${DISPLAY_REFRESH}
DISPLAY_CDEPTH=${DISPLAY_CDEPTH}
NVIDIA_DRIVER_CAPABILITIES=${NVIDIA_DRIVER_CAPABILITIES}
NVIDIA_VISIBLE_DEVICES=${NVIDIA_VISIBLE_DEVICES}
NVIDIA_DRIVER_VERSION=${NVIDIA_DRIVER_VERSION}
EOF
}

if [[ -z "${GCP_PROJECT}" ]]; then
  echo "ERROR: GCP_PROJECT is empty."
  echo "Set it in gcp-vm/.env (copy from gcp-vm/.env.example)."
  exit 1
fi

if [[ "${USER_PASSWORD}" == "change-me" || "${SUNSHINE_PASS}" == "change-me" ]]; then
  echo "WARNING: USER_PASSWORD/SUNSHINE_PASS still use placeholder values. Update gcp-vm/.env before exposing the VM publicly." >&2
fi

STEAM_ENV_FILE=$(mktemp)
trap 'rm -f "$STEAM_ENV_FILE"' EXIT
render_steam_headless_env > "$STEAM_ENV_FILE"

echo "Using project=${GCP_PROJECT} zone=${GCP_ZONE} name=${GCE_NAME}"
gcloud config set project "$GCP_PROJECT" >/dev/null 2>&1 || true

# Firewall: noVNC + SSH
if ! gcloud compute firewall-rules describe allow-steam-headless-web --project "$GCP_PROJECT" >/dev/null 2>&1; then
  gcloud compute firewall-rules create allow-steam-headless-web \
    --project "$GCP_PROJECT" \
    --network=default \
    --allow=tcp:22,tcp:8083 \
    --target-tags="$TAGS" \
    --source-ranges="$ALLOW_CIDR"
else
  gcloud compute firewall-rules update allow-steam-headless-web \
    --project "$GCP_PROJECT" \
    --allow=tcp:22,tcp:8083 \
    --target-tags="$TAGS" \
    --source-ranges="$ALLOW_CIDR" || true
fi

# Firewall: Sunshine (web ui + control + video)
if ! gcloud compute firewall-rules describe allow-sunshine --project "$GCP_PROJECT" >/dev/null 2>&1; then
  gcloud compute firewall-rules create allow-sunshine \
    --project "$GCP_PROJECT" \
    --network=default \
    --allow=tcp:47984,tcp:47989,tcp:47990,tcp:48010,udp:47998,udp:47999,udp:48000,udp:48002 \
    --target-tags="$TAGS" \
    --source-ranges="$ALLOW_CIDR"
else
  gcloud compute firewall-rules update allow-sunshine \
    --project "$GCP_PROJECT" \
    --allow=tcp:47984,tcp:47989,tcp:47990,tcp:48010,udp:47998,udp:47999,udp:48000,udp:48002 \
    --target-tags="$TAGS" \
    --source-ranges="$ALLOW_CIDR" || true
fi

# Create VM if missing
if ! gcloud compute instances describe "$GCE_NAME" --zone="$GCP_ZONE" --project="$GCP_PROJECT" >/dev/null 2>&1; then
  echo "Creating instance ${GCE_NAME}..."
  gcloud compute instances create "$GCE_NAME" \
    --project="$GCP_PROJECT" \
    --zone="$GCP_ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --accelerator="type=${GPU_TYPE},count=${GPU_COUNT}" \
    --maintenance-policy=TERMINATE \
    --restart-on-failure \
    --image-family=ubuntu-2204-lts \
    --image-project=ubuntu-os-cloud \
    --boot-disk-size="$BOOT_DISK_SIZE" \
    --boot-disk-type="$BOOT_DISK_TYPE" \
    --tags="$TAGS" \
    --metadata-from-file startup-script="$STARTUP_SCRIPT",steam-headless-env="$STEAM_ENV_FILE"
else
  echo "Instance ${GCE_NAME} already exists; updating startup metadata."
  gcloud compute instances add-metadata "$GCE_NAME" \
    --project="$GCP_PROJECT" \
    --zone="$GCP_ZONE" \
    --metadata-from-file startup-script="$STARTUP_SCRIPT",steam-headless-env="$STEAM_ENV_FILE" >/dev/null
fi

echo "Instance details:"
gcloud compute instances describe "$GCE_NAME" --zone="$GCP_ZONE" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)' | awk '{print "EXTERNAL_IP=" $0}'

echo "Done. To SSH: gcloud compute ssh ${GCE_NAME} --zone=${GCP_ZONE}"
