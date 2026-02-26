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
: "${KUB_FREE_NAME:=kub-free}"
: "${KUB_FREE_LOCATION:=europe-central2}"

gcloud config set project "$GCP_PROJECT" >/dev/null

if gcloud container clusters describe "$KUB_FREE_NAME" --location "$KUB_FREE_LOCATION" >/dev/null 2>&1; then
  gcloud container clusters delete "$KUB_FREE_NAME" --location "$KUB_FREE_LOCATION" --quiet
else
  echo "Cluster ${KUB_FREE_NAME} not found in ${KUB_FREE_LOCATION}"
fi
