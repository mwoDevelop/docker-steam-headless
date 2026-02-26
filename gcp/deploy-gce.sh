#!/usr/bin/env bash
set -euo pipefail

# Simple, repeatable deployment of a GPU VM on GCE with docker-steam-headless.
# - Creates/updates firewall rules for noVNC and Sunshine
# - Creates the VM (if missing) with a T4 GPU
# - Attaches a startup-script that installs NVIDIA driver, Docker, and brings the stack up

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")"/.. && pwd)
STARTUP_SCRIPT="${ROOT_DIR}/gcp/startup.sh"

# Config (single source of truth)
CFG_FILE="${ROOT_DIR}/gcp/.env"
if [[ -f "$CFG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CFG_FILE"
fi

# Defaults (overridable via environment or gcp/.env)
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

if [[ -z "${GCP_PROJECT}" ]]; then
  echo "ERROR: GCP_PROJECT is empty."
  echo "Set it in gcp/.env (copy from gcp/.env.example)."
  exit 1
fi

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
    --metadata-from-file startup-script="$STARTUP_SCRIPT"
else
  echo "Instance ${GCE_NAME} already exists; skipping create."
fi

echo "Instance details:"
gcloud compute instances describe "$GCE_NAME" --zone="$GCP_ZONE" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)' | awk '{print "EXTERNAL_IP=" $0}'

echo "Done. To SSH: gcloud compute ssh ${GCE_NAME} --zone=${GCP_ZONE}"
