#!/usr/bin/env bash
set -euo pipefail

# Simple, repeatable deployment of a GPU VM on GCE with docker-steam-headless.
# - Creates/updates firewall rules for noVNC and Sunshine
# - Creates the VM (if missing) with a T4 GPU
# - Attaches a startup-script that installs NVIDIA driver, Docker, and brings the stack up

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")"/.. && pwd)
STARTUP_SCRIPT="${ROOT_DIR}/gcp-vm/startup.sh"
SHUTDOWN_SCRIPT="${ROOT_DIR}/gcp-vm/shutdown.sh"
PERSIST_SCRIPT="${ROOT_DIR}/gcp-vm/persist-state.sh"

# shellcheck disable=SC1091
source "${ROOT_DIR}/gcp-vm/lib/env.sh"
load_gcp_vm_env "$ROOT_DIR"

# Defaults (overridable via environment or local gcp-vm/.env* files)
GCP_PROJECT=${GCP_PROJECT:-}
GCP_ZONE=${GCP_ZONE:-europe-central2-b}
GCE_NAME=${GCE_NAME:-steam-gpu}
MACHINE_TYPE=${MACHINE_TYPE:-n1-standard-4}
GPU_TYPE=${GPU_TYPE:-nvidia-tesla-t4}
GPU_COUNT=${GPU_COUNT:-1}
BOOT_DISK_SIZE=${BOOT_DISK_SIZE:-120GB}
BOOT_DISK_TYPE=${BOOT_DISK_TYPE:-pd-ssd}
TAGS=${TAGS:-steam-headless}
VM_IMAGE_FAMILY=${VM_IMAGE_FAMILY:-ubuntu-2204-lts}
VM_IMAGE_PROJECT=${VM_IMAGE_PROJECT:-ubuntu-os-cloud}
VM_NETWORK=${VM_NETWORK:-default}
VM_SUBNET=${VM_SUBNET:-}
# CIDR allowed to reach Web UI and Sunshine (set to your IP/32 for safety)
ALLOW_CIDR=${ALLOW_CIDR:-0.0.0.0/0}
GDRIVE_FOLDER_ID=${GDRIVE_FOLDER_ID:-}
GDRIVE_STATE_ROOT=${GDRIVE_STATE_ROOT:-steam-vm-state}
GDRIVE_OAUTH_TOKEN_SECRET_NAME=${GDRIVE_OAUTH_TOKEN_SECRET_NAME:-}
GDRIVE_OAUTH_TOKEN_FILE=${GDRIVE_OAUTH_TOKEN_FILE:-}
GDRIVE_SERVICE_ACCOUNT_SECRET_NAME=${GDRIVE_SERVICE_ACCOUNT_SECRET_NAME:-steam-vm-state-drive-sa}
GDRIVE_SERVICE_ACCOUNT_JSON_FILE=${GDRIVE_SERVICE_ACCOUNT_JSON_FILE:-}

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

if [[ "${USER_PASSWORD}" == "change-me" ]]; then
  echo "WARNING: USER_PASSWORD still uses a placeholder value. Update gcp-vm/.env.secrets before exposing the VM publicly." >&2
fi

if [[ "${SUNSHINE_PASS}" == "change-me" ]]; then
  echo "INFO: SUNSHINE_PASS uses a placeholder and will be rotated to a random runtime password when the VM starts from the control panel." >&2
fi

STEAM_ENV_FILE=$(mktemp)
trap 'rm -f "$STEAM_ENV_FILE"' EXIT
render_steam_headless_env > "$STEAM_ENV_FILE"

echo "Using project=${GCP_PROJECT} zone=${GCP_ZONE} name=${GCE_NAME}"
gcloud config set project "$GCP_PROJECT" >/dev/null 2>&1 || true

PROJECT_NUMBER=$(gcloud projects describe "$GCP_PROJECT" --format='value(projectNumber)')
DEFAULT_COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

if [[ -n "$GDRIVE_SERVICE_ACCOUNT_JSON_FILE" ]]; then
  if [[ ! -f "$GDRIVE_SERVICE_ACCOUNT_JSON_FILE" ]]; then
    echo "ERROR: GDRIVE_SERVICE_ACCOUNT_JSON_FILE does not exist: ${GDRIVE_SERVICE_ACCOUNT_JSON_FILE}" >&2
    exit 1
  fi

  if ! gcloud secrets describe "$GDRIVE_SERVICE_ACCOUNT_SECRET_NAME" --project "$GCP_PROJECT" >/dev/null 2>&1; then
    gcloud secrets create "$GDRIVE_SERVICE_ACCOUNT_SECRET_NAME" \
      --project "$GCP_PROJECT" \
      --replication-policy=automatic >/dev/null
  fi

  gcloud secrets versions add "$GDRIVE_SERVICE_ACCOUNT_SECRET_NAME" \
    --project "$GCP_PROJECT" \
    --data-file="$GDRIVE_SERVICE_ACCOUNT_JSON_FILE" >/dev/null
fi

if [[ -n "$GDRIVE_OAUTH_TOKEN_FILE" ]]; then
  if [[ ! -f "$GDRIVE_OAUTH_TOKEN_FILE" ]]; then
    echo "ERROR: GDRIVE_OAUTH_TOKEN_FILE does not exist: ${GDRIVE_OAUTH_TOKEN_FILE}" >&2
    exit 1
  fi

  if [[ -z "$GDRIVE_OAUTH_TOKEN_SECRET_NAME" ]]; then
    echo "ERROR: GDRIVE_OAUTH_TOKEN_SECRET_NAME must be set when GDRIVE_OAUTH_TOKEN_FILE is used." >&2
    exit 1
  fi

  if ! gcloud secrets describe "$GDRIVE_OAUTH_TOKEN_SECRET_NAME" --project "$GCP_PROJECT" >/dev/null 2>&1; then
    gcloud secrets create "$GDRIVE_OAUTH_TOKEN_SECRET_NAME" \
      --project "$GCP_PROJECT" \
      --replication-policy=automatic >/dev/null
  fi

  gcloud secrets versions add "$GDRIVE_OAUTH_TOKEN_SECRET_NAME" \
    --project "$GCP_PROJECT" \
    --data-file="$GDRIVE_OAUTH_TOKEN_FILE" >/dev/null
fi

if [[ -n "$GDRIVE_FOLDER_ID" && -n "$GDRIVE_SERVICE_ACCOUNT_SECRET_NAME" ]]; then
  gcloud secrets add-iam-policy-binding "$GDRIVE_SERVICE_ACCOUNT_SECRET_NAME" \
    --project "$GCP_PROJECT" \
    --member="serviceAccount:${DEFAULT_COMPUTE_SA}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null || true
fi

if [[ -n "$GDRIVE_FOLDER_ID" && -n "$GDRIVE_OAUTH_TOKEN_SECRET_NAME" ]]; then
  gcloud secrets add-iam-policy-binding "$GDRIVE_OAUTH_TOKEN_SECRET_NAME" \
    --project "$GCP_PROJECT" \
    --member="serviceAccount:${DEFAULT_COMPUTE_SA}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null || true
fi

INSTANCE_METADATA_ARGS=()
if [[ -n "$GDRIVE_FOLDER_ID" ]]; then
  metadata_values=("gdrive-folder-id=${GDRIVE_FOLDER_ID}" "gdrive-state-root=${GDRIVE_STATE_ROOT}")
  if [[ -n "$GDRIVE_OAUTH_TOKEN_SECRET_NAME" ]]; then
    metadata_values+=("gdrive-oauth-token-secret-name=${GDRIVE_OAUTH_TOKEN_SECRET_NAME}")
  fi
  if [[ -n "$GDRIVE_SERVICE_ACCOUNT_SECRET_NAME" ]]; then
    metadata_values+=("gdrive-service-account-secret-name=${GDRIVE_SERVICE_ACCOUNT_SECRET_NAME}")
  fi
  INSTANCE_METADATA_ARGS+=(
    --metadata
    "$(IFS=,; echo "${metadata_values[*]}")"
  )
fi

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

# Firewall: Sunshine and Steam Remote Play (web ui + control + streaming)
if ! gcloud compute firewall-rules describe allow-sunshine --project "$GCP_PROJECT" >/dev/null 2>&1; then
  gcloud compute firewall-rules create allow-sunshine \
    --project "$GCP_PROJECT" \
    --network=default \
    --allow=tcp:47984,tcp:47989,tcp:47990,tcp:48010,tcp:27036-27037,udp:47998,udp:47999,udp:48000,udp:48002,udp:27031-27036 \
    --target-tags="$TAGS" \
    --source-ranges="$ALLOW_CIDR"
else
  gcloud compute firewall-rules update allow-sunshine \
    --project "$GCP_PROJECT" \
    --allow=tcp:47984,tcp:47989,tcp:47990,tcp:48010,tcp:27036-27037,udp:47998,udp:47999,udp:48000,udp:48002,udp:27031-27036 \
    --target-tags="$TAGS" \
    --source-ranges="$ALLOW_CIDR" || true
fi

# Create VM if missing
if ! gcloud compute instances describe "$GCE_NAME" --zone="$GCP_ZONE" --project="$GCP_PROJECT" >/dev/null 2>&1; then
  echo "Creating instance ${GCE_NAME}..."
  CREATE_ARGS=(
    --project="$GCP_PROJECT"
    --zone="$GCP_ZONE"
    --machine-type="$MACHINE_TYPE"
    --accelerator="type=${GPU_TYPE},count=${GPU_COUNT}"
    --maintenance-policy=TERMINATE
    --restart-on-failure
    --image-family="$VM_IMAGE_FAMILY"
    --image-project="$VM_IMAGE_PROJECT"
    --boot-disk-size="$BOOT_DISK_SIZE"
    --boot-disk-type="$BOOT_DISK_TYPE"
    --tags="$TAGS"
    --service-account="$DEFAULT_COMPUTE_SA"
    --scopes="https://www.googleapis.com/auth/cloud-platform"
    --metadata-from-file
    "startup-script=${STARTUP_SCRIPT},shutdown-script=${SHUTDOWN_SCRIPT},vm-persist-script=${PERSIST_SCRIPT},steam-headless-env=${STEAM_ENV_FILE}"
  )
  if [[ -n "$VM_NETWORK" ]]; then
    CREATE_ARGS+=(--network="$VM_NETWORK")
  fi
  if [[ -n "$VM_SUBNET" ]]; then
    CREATE_ARGS+=(--subnet="$VM_SUBNET")
  fi
  gcloud compute instances create "$GCE_NAME" \
    "${CREATE_ARGS[@]}" \
    "${INSTANCE_METADATA_ARGS[@]}" >/dev/null
else
  echo "Instance ${GCE_NAME} already exists; updating startup metadata."
  gcloud compute instances add-metadata "$GCE_NAME" \
    --project="$GCP_PROJECT" \
    --zone="$GCP_ZONE" \
    --metadata-from-file startup-script="$STARTUP_SCRIPT",shutdown-script="$SHUTDOWN_SCRIPT",vm-persist-script="$PERSIST_SCRIPT",steam-headless-env="$STEAM_ENV_FILE" \
    "${INSTANCE_METADATA_ARGS[@]}" >/dev/null
fi

echo "Instance details:"
gcloud compute instances describe "$GCE_NAME" --zone="$GCP_ZONE" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)' | awk '{print "EXTERNAL_IP=" $0}'

echo "Done. To SSH: gcloud compute ssh ${GCE_NAME} --zone=${GCP_ZONE}"
