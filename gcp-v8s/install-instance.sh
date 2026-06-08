#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

# shellcheck disable=SC1091
source "${ROOT_DIR}/lib/env.sh"
load_gcp_v8s_env "$ROOT_DIR"

: "${GCP_PROJECT:=}"
: "${GKE_CLUSTER:=steam-gpu-k8s}"
: "${GKE_LOCATION:=europe-central2-b}"
: "${K8S_NAMESPACE_PREFIX:=steam}"

log() { printf '%s [gcp-v8s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
err() { log "ERROR: $*" >&2; exit 1; }

usage() {
  cat <<USAGE
Usage:
  $0 <instance-id> <prism|chrome>
  $0 help

Examples:
  $0 gamer1 prism
  $0 gamer2 chrome
USAGE
}

INSTANCE="${1:-}"
ADDON_RAW="${2:-}"

if [[ -z "$INSTANCE" || "$INSTANCE" == "help" || "$INSTANCE" == "-h" || "$INSTANCE" == "--help" ]]; then
  usage
  exit 0
fi

[[ -n "$ADDON_RAW" ]] || err "Missing addon target. Use: prism or chrome"

if [[ "$INSTANCE" == --* ]]; then
  err "Unknown option: ${INSTANCE}."
fi

ADDON="$(printf '%s' "$ADDON_RAW" | tr '[:upper:]' '[:lower:]')"
case "$ADDON" in
  prism|chrome) ;;
  *) err "Unsupported addon '${ADDON_RAW}'. Allowed: prism, chrome" ;;
esac

INSTANCE_SAFE=$(printf '%s' "$INSTANCE" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9-' '-')
INSTANCE_SAFE="${INSTANCE_SAFE#-}"
INSTANCE_SAFE="${INSTANCE_SAFE%-}"
[[ -n "$INSTANCE_SAFE" ]] || err "Invalid instance id: ${INSTANCE}"

NAMESPACE="${K8S_NAMESPACE_PREFIX}-${INSTANCE_SAFE}"
APP_NAME="steam-headless-${INSTANCE_SAFE}"
CONTAINER_NAME="steam-headless"
ADDON_SCRIPT="${ROOT_DIR}/../gcp-additional/install-${ADDON}.sh"
ADDON_SCRIPT_BASENAME="install-${ADDON}.sh"

[[ -f "$ADDON_SCRIPT" ]] || err "Missing addon script: ${ADDON_SCRIPT}"

gcloud config set project "$GCP_PROJECT" >/dev/null
gcloud container clusters describe "$GKE_CLUSTER" --location "$GKE_LOCATION" >/dev/null 2>&1 || \
  err "Cluster ${GKE_CLUSTER} not found in ${GKE_LOCATION}. Run ./deploy.sh first."
gcloud container clusters get-credentials "$GKE_CLUSTER" --location "$GKE_LOCATION" --project "$GCP_PROJECT" >/dev/null

kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || err "Namespace ${NAMESPACE} not found. Deploy instance first."

POD="$(kubectl -n "$NAMESPACE" get pod -l "app=${APP_NAME}" -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\n"}{end}' | head -n1 || true)"
if [[ -z "$POD" ]]; then
  POD="$(kubectl -n "$NAMESPACE" get pod -l "app=${APP_NAME}" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | head -n1 || true)"
fi
[[ -n "$POD" ]] || err "No pod found for app=${APP_NAME} in namespace ${NAMESPACE}"

log "Installing ${ADDON} on ${INSTANCE_SAFE} (${NAMESPACE}/${POD})"
kubectl -n "$NAMESPACE" cp "$ADDON_SCRIPT" "${POD}:/tmp/${ADDON_SCRIPT_BASENAME}" -c "$CONTAINER_NAME"
kubectl -n "$NAMESPACE" exec "$POD" -c "$CONTAINER_NAME" -- bash "/tmp/${ADDON_SCRIPT_BASENAME}"

log "Addon ${ADDON} installed on ${INSTANCE_SAFE}"
