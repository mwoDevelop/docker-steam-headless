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
: "${GKE_CLUSTER:=steam-gpu-k8s}"
: "${GKE_LOCATION:=europe-central2-b}"
: "${K8S_NAMESPACE:=steam-headless}"
: "${WEB_SERVICE_NAME:=steam-headless-web}"
: "${STREAM_UDP_SERVICE_NAME:=steam-headless-stream-udp}"

gcloud config set project "$GCP_PROJECT" >/dev/null
gcloud container clusters get-credentials "$GKE_CLUSTER" --location "$GKE_LOCATION" --project "$GCP_PROJECT" >/dev/null

echo "== Cluster =="
gcloud container clusters describe "$GKE_CLUSTER" --location "$GKE_LOCATION" --format='value(name,location,status,currentMasterVersion)'
echo
echo "== Nodes =="
kubectl get nodes -o wide
echo
echo "== Pods =="
kubectl -n "$K8S_NAMESPACE" get pods -o wide
echo
echo "== Services =="
kubectl -n "$K8S_NAMESPACE" get svc -o wide
echo
echo "== GPU check =="
POD_NAME=$(kubectl -n "$K8S_NAMESPACE" get pods -l app=steam-headless -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
if [[ -n "$POD_NAME" ]]; then
  kubectl -n "$K8S_NAMESPACE" exec "$POD_NAME" -- sh -lc 'ls -l /dev/nvidia* 2>/dev/null || true'
  WEB_IP=$(kubectl -n "$K8S_NAMESPACE" get svc "$WEB_SERVICE_NAME" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
  STREAM_IP=$(kubectl -n "$K8S_NAMESPACE" get svc "$STREAM_UDP_SERVICE_NAME" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
  echo
  echo "noVNC:    http://${WEB_IP:-<pending>}:8083/"
  echo "Sunshine: https://${WEB_IP:-<pending>}:47990/"
  echo "UDP LB:   ${STREAM_IP:-<pending>}"
else
  echo "steam-headless pod not found"
fi
