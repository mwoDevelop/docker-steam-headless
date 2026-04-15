#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")"/.. && pwd)
# shellcheck disable=SC1091
source "${ROOT_DIR}/gcp-vm/lib/env.sh"
load_gcp_vm_env "$ROOT_DIR"

GCP_PROJECT=${GCP_PROJECT:-}
REGION=${REGION:-europe-central2}
SERVICE_NAME=${SERVICE_NAME:-steam-vm-control-api}
RUNTIME_SA_NAME=${RUNTIME_SA_NAME:-vm-control-api}
RUNTIME_SA_EMAIL="${RUNTIME_SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"
ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-https://mwodevelop.github.io}
ALLOWED_GOOGLE_EMAILS=${ALLOWED_GOOGLE_EMAILS:-}
ALLOWED_GOOGLE_DOMAINS=${ALLOWED_GOOGLE_DOMAINS:-}
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}
DUCKDNS_SECRET_NAME=${DUCKDNS_SECRET_NAME:-steam-vm-control-duckdns-token}
MACHINE_TYPE=${MACHINE_TYPE:-n1-standard-4}
GPU_TYPE=${GPU_TYPE:-nvidia-tesla-t4}
GPU_COUNT=${GPU_COUNT:-1}
BOOT_DISK_SIZE=${BOOT_DISK_SIZE:-120GB}
BOOT_DISK_TYPE=${BOOT_DISK_TYPE:-pd-ssd}
DATA_DISK_SIZE=${DATA_DISK_SIZE:-300GB}
DATA_DISK_TYPE=${DATA_DISK_TYPE:-pd-balanced}
DATA_DISK_DEVICE_NAME=${DATA_DISK_DEVICE_NAME:-steam-state}
DATA_DISK_MOUNT_ROOT=${DATA_DISK_MOUNT_ROOT:-/mnt/state}
TAGS=${TAGS:-steam-headless}
VM_IMAGE_FAMILY=${VM_IMAGE_FAMILY:-ubuntu-2204-lts}
VM_IMAGE_PROJECT=${VM_IMAGE_PROJECT:-ubuntu-os-cloud}
VM_NETWORK=${VM_NETWORK:-default}
VM_SUBNET=${VM_SUBNET:-}
GDRIVE_FOLDER_ID=${GDRIVE_FOLDER_ID:-}
GDRIVE_STATE_ROOT=${GDRIVE_STATE_ROOT:-steam-vm-state}
GDRIVE_OWNER_EMAIL=${GDRIVE_OWNER_EMAIL:-mwodevelop@gmail.com}
GDRIVE_OAUTH_TOKEN_SECRET_NAME=${GDRIVE_OAUTH_TOKEN_SECRET_NAME:-}

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

log() { printf '%s [cloud-run-vm-control] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
err() { log "ERROR: $*" >&2; exit 1; }

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

[[ -n "$GCP_PROJECT" ]] || err "GCP_PROJECT is required"
[[ -n "${GCP_ZONE:-}" ]] || err "GCP_ZONE is required"
[[ -n "${GCE_NAME:-}" ]] || err "GCE_NAME is required"
[[ -n "$GOOGLE_CLIENT_ID" ]] || err "GOOGLE_CLIENT_ID is required"
[[ -n "$ALLOWED_GOOGLE_EMAILS" || -n "$ALLOWED_GOOGLE_DOMAINS" ]] || err "Set ALLOWED_GOOGLE_EMAILS or ALLOWED_GOOGLE_DOMAINS"

gcloud config set project "$GCP_PROJECT" >/dev/null

log "Enabling required Google Cloud APIs"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  compute.googleapis.com >/dev/null

if ! gcloud iam service-accounts describe "$RUNTIME_SA_EMAIL" --project "$GCP_PROJECT" >/dev/null 2>&1; then
  log "Creating runtime service account ${RUNTIME_SA_EMAIL}"
  gcloud iam service-accounts create "$RUNTIME_SA_NAME" \
    --project "$GCP_PROJECT" \
    --display-name "VM Control API runtime" >/dev/null
fi

log "Granting Compute Engine VM control role to runtime service account"
gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
  --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
  --role="roles/compute.instanceAdmin.v1" \
  --quiet >/dev/null

PROJECT_NUMBER=$(gcloud projects describe "$GCP_PROJECT" --format='value(projectNumber)')
DEFAULT_COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
VM_SERVICE_ACCOUNT_EMAIL=${VM_SERVICE_ACCOUNT_EMAIL:-${DEFAULT_COMPUTE_SA}}
VM_STARTUP_SCRIPT_B64=$(gzip -9c "${ROOT_DIR}/gcp-vm/startup.sh" | base64 -w0)
VM_SHUTDOWN_SCRIPT_B64=$(gzip -9c "${ROOT_DIR}/gcp-vm/shutdown.sh" | base64 -w0)
VM_PERSIST_SCRIPT_B64=$(gzip -9c "${ROOT_DIR}/gcp-vm/persist-state.sh" | base64 -w0)
VM_POWER_ACTION_SCRIPT_B64=$(gzip -9c "${ROOT_DIR}/gcp-vm/power-action.sh" | base64 -w0)
VM_STEAM_ENV_B64=$(render_steam_headless_env | gzip -9c | base64 -w0)
if gcloud iam service-accounts describe "$DEFAULT_COMPUTE_SA" --project "$GCP_PROJECT" >/dev/null 2>&1; then
  log "Granting metadata update impersonation on VM service account"
  gcloud iam service-accounts add-iam-policy-binding "$DEFAULT_COMPUTE_SA" \
    --project "$GCP_PROJECT" \
    --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role="roles/iam.serviceAccountUser" >/dev/null
fi

SECRET_ARGS=()
if [[ -n "${DUCKDNS_TOKEN:-}" ]]; then
  if ! gcloud secrets describe "$DUCKDNS_SECRET_NAME" --project "$GCP_PROJECT" >/dev/null 2>&1; then
    log "Creating Secret Manager secret ${DUCKDNS_SECRET_NAME}"
    gcloud secrets create "$DUCKDNS_SECRET_NAME" \
      --project "$GCP_PROJECT" \
      --replication-policy="automatic" >/dev/null
  fi

  log "Updating DuckDNS token secret"
  printf '%s' "$DUCKDNS_TOKEN" | gcloud secrets versions add "$DUCKDNS_SECRET_NAME" \
    --project "$GCP_PROJECT" \
    --data-file=- >/dev/null

  log "Granting Secret Manager access to runtime service account"
  gcloud secrets add-iam-policy-binding "$DUCKDNS_SECRET_NAME" \
    --project "$GCP_PROJECT" \
    --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null

  SECRET_ARGS+=(--update-secrets="DUCKDNS_TOKEN=${DUCKDNS_SECRET_NAME}:latest")
fi

log "Deploying Cloud Run service ${SERVICE_NAME}"
gcloud run deploy "$SERVICE_NAME" \
  --project "$GCP_PROJECT" \
  --region "$REGION" \
  --source "${ROOT_DIR}/cloud-run-vm-control" \
  --service-account "$RUNTIME_SA_EMAIL" \
  --allow-unauthenticated \
  --quiet \
  --set-env-vars "^|^GCP_PROJECT=${GCP_PROJECT}|GCP_ZONE=${GCP_ZONE}|GCE_NAME=${GCE_NAME}|GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}|ALLOWED_GOOGLE_EMAILS=${ALLOWED_GOOGLE_EMAILS}|ALLOWED_GOOGLE_DOMAINS=${ALLOWED_GOOGLE_DOMAINS}|ALLOWED_ORIGINS=${ALLOWED_ORIGINS}|DUCKDNS_DOMAINS=${DUCKDNS_DOMAINS:-}|VM_NOVNC_PORT=8083|VM_SUNSHINE_PORT=47990|MACHINE_TYPE=${MACHINE_TYPE}|GPU_TYPE=${GPU_TYPE}|GPU_COUNT=${GPU_COUNT}|BOOT_DISK_SIZE=${BOOT_DISK_SIZE}|BOOT_DISK_TYPE=${BOOT_DISK_TYPE}|DATA_DISK_SIZE=${DATA_DISK_SIZE}|DATA_DISK_TYPE=${DATA_DISK_TYPE}|DATA_DISK_DEVICE_NAME=${DATA_DISK_DEVICE_NAME}|DATA_DISK_MOUNT_ROOT=${DATA_DISK_MOUNT_ROOT}|VM_TAGS=${TAGS}|VM_IMAGE_FAMILY=${VM_IMAGE_FAMILY}|VM_IMAGE_PROJECT=${VM_IMAGE_PROJECT}|VM_NETWORK=${VM_NETWORK}|VM_SUBNET=${VM_SUBNET}|VM_SERVICE_ACCOUNT_EMAIL=${VM_SERVICE_ACCOUNT_EMAIL}|GDRIVE_FOLDER_ID=${GDRIVE_FOLDER_ID}|GDRIVE_STATE_ROOT=${GDRIVE_STATE_ROOT}|GDRIVE_OWNER_EMAIL=${GDRIVE_OWNER_EMAIL}|GDRIVE_OAUTH_TOKEN_SECRET_NAME=${GDRIVE_OAUTH_TOKEN_SECRET_NAME}|VM_STARTUP_SCRIPT_B64=${VM_STARTUP_SCRIPT_B64}|VM_SHUTDOWN_SCRIPT_B64=${VM_SHUTDOWN_SCRIPT_B64}|VM_PERSIST_SCRIPT_B64=${VM_PERSIST_SCRIPT_B64}|VM_POWER_ACTION_SCRIPT_B64=${VM_POWER_ACTION_SCRIPT_B64}|VM_STEAM_ENV_B64=${VM_STEAM_ENV_B64}" \
  "${SECRET_ARGS[@]}" >/dev/null

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --project "$GCP_PROJECT" \
  --region "$REGION" \
  --format='value(status.url)')

log "Cloud Run VM control API deployed"
echo "Service URL: ${SERVICE_URL}"
echo "Use this backend URL in https://mwodevelop.github.io/docker-steam-headless/vm-control/"
