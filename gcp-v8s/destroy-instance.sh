#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  set -- help
fi

# shellcheck disable=SC1091
source "${ROOT_DIR}/lib/env.sh"
load_gcp_v8s_env "$ROOT_DIR"

: "${GCP_PROJECT:=}"
: "${GKE_CLUSTER:=steam-gpu-k8s}"
: "${GKE_LOCATION:=europe-central2-b}"
: "${LB_ADDRESS_PREFIX:=steam-headless-ip}"
: "${K8S_NAMESPACE_PREFIX:=steam}"

usage() {
  cat <<USAGE
Usage:
  $0 <instance-id> [release-ip]
  $0 help

Options:
  release-ip   Also delete reserved static IP for this instance.
USAGE
}

region_from_location() {
  local location="$1"
  if [[ "$location" =~ ^[a-z]+-[a-z0-9]+[0-9]-[a-z]$ ]]; then
    echo "${location%-[a-z]}"
  else
    echo "$location"
  fi
}

INSTANCE="${1:-}"
if [[ -z "$INSTANCE" || "$INSTANCE" == "help" || "$INSTANCE" == "-h" || "$INSTANCE" == "--help" ]]; then
  usage
  exit 0
fi
if [[ "$INSTANCE" == --* ]]; then
  echo "Unknown option: ${INSTANCE}. Set profile via ./deploy.sh --profile <L4|T4>." >&2
  exit 1
fi
RELEASE_IP="${2:-}"

INSTANCE_SAFE=$(printf '%s' "$INSTANCE" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9-' '-')
INSTANCE_SAFE="${INSTANCE_SAFE#-}"
INSTANCE_SAFE="${INSTANCE_SAFE%-}"
[[ -n "$INSTANCE_SAFE" ]] || { echo "Invalid instance id: ${INSTANCE}" >&2; exit 1; }

NAMESPACE="${K8S_NAMESPACE_PREFIX}-${INSTANCE_SAFE}"
LB_ADDRESS_NAME="${LB_ADDRESS_PREFIX}-${INSTANCE_SAFE}"
LB_REGION=$(region_from_location "$GKE_LOCATION")

gcloud config set project "$GCP_PROJECT" >/dev/null
gcloud container clusters describe "$GKE_CLUSTER" --location "$GKE_LOCATION" >/dev/null 2>&1 || {
  echo "Cluster ${GKE_CLUSTER} not found in ${GKE_LOCATION}; deleting only static IP (if requested)." >&2
  if [[ "$RELEASE_IP" == "release-ip" ]]; then
    gcloud compute addresses delete "$LB_ADDRESS_NAME" --region "$LB_REGION" --quiet || true
  fi
  echo "Namespace not deleted (cluster unavailable): ${NAMESPACE}" >&2
  exit 0
}
gcloud container clusters get-credentials "$GKE_CLUSTER" --location "$GKE_LOCATION" --project "$GCP_PROJECT" >/dev/null

kubectl delete namespace "$NAMESPACE" --ignore-not-found

if [[ "$RELEASE_IP" == "release-ip" ]]; then
  if gcloud compute addresses describe "$LB_ADDRESS_NAME" --region "$LB_REGION" --project "$GCP_PROJECT" >/dev/null 2>&1; then
    gcloud compute addresses delete "$LB_ADDRESS_NAME" --region "$LB_REGION" --project "$GCP_PROJECT" --quiet || true
    RELEASED_IP_MSG="Deleted static IP: ${LB_ADDRESS_NAME} (${LB_REGION})"
  else
    RELEASED_IP_MSG="Static IP not found (already deleted): ${LB_ADDRESS_NAME} (${LB_REGION})"
  fi
fi

echo "Deleted instance namespace: ${NAMESPACE}"
if [[ "$RELEASE_IP" == "release-ip" ]]; then
  echo "${RELEASED_IP_MSG}"
else
  echo "Static IP kept: ${LB_ADDRESS_NAME} (${LB_REGION})"
fi
