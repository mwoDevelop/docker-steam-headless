#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ "${1:-}" == "help" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<USAGE
Usage:
  $0
USAGE
  exit 0
fi
[[ $# -eq 0 ]] || { echo "Usage: $0" >&2; exit 1; }

# shellcheck disable=SC1091
source "${ROOT_DIR}/lib/env.sh"
load_gcp_v8s_env "$ROOT_DIR"

: "${GCP_PROJECT:=}"
: "${AR_REGION:=europe-central2}"
: "${AR_REPO:=steam-images}"
: "${IMAGE_NAME:=steam-headless-prism}"
: "${IMAGE_TAG:=latest}"

IMAGE="${IMAGE:-${AR_REGION}-docker.pkg.dev/${GCP_PROJECT}/${AR_REPO}/${IMAGE_NAME}:${IMAGE_TAG}}"

log() { printf '%s [gcp-v8s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

gcloud config set project "$GCP_PROJECT" >/dev/null
gcloud services enable artifactregistry.googleapis.com cloudbuild.googleapis.com >/dev/null

if ! gcloud artifacts repositories describe "$AR_REPO" --location "$AR_REGION" >/dev/null 2>&1; then
  log "Creating Artifact Registry repo ${AR_REPO} in ${AR_REGION}"
  gcloud artifacts repositories create "$AR_REPO" \
    --location "$AR_REGION" \
    --repository-format docker \
    --description "Steam headless custom images"
fi

log "Building and pushing image: ${IMAGE}"
gcloud builds submit "${ROOT_DIR}/image" --tag "$IMAGE"

echo "IMAGE built successfully:"
echo "  ${IMAGE}"
echo
echo "If needed, set this in ${ENV_FILE}:"
echo "  IMAGE=${IMAGE}"
