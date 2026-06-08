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
: "${DUCKDNS_TOKEN:=}"

err() { echo "[gcp-v8s] ERROR: $*" >&2; exit 1; }

[[ -n "$DUCKDNS_TOKEN" ]] || err "DUCKDNS_TOKEN is empty"

gcloud config set project "$GCP_PROJECT" >/dev/null
gcloud container clusters describe "$GKE_CLUSTER" --location "$GKE_LOCATION" >/dev/null 2>&1 || \
  err "Cluster ${GKE_CLUSTER} not found in ${GKE_LOCATION}. Run ./deploy.sh first."
gcloud container clusters get-credentials "$GKE_CLUSTER" --location "$GKE_LOCATION" --project "$GCP_PROJECT" >/dev/null

updated=0
for ns in $(kubectl get ns -l app.kubernetes.io/part-of=steam-headless-fleet -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null); do
  [[ -n "$ns" ]] || continue
  domain_fqdn=$(kubectl get ns "$ns" -o jsonpath="{.metadata.annotations['steam-headless/duckdns-domain']}" 2>/dev/null || true)
  [[ -n "$domain_fqdn" ]] || continue
  subdomain="${domain_fqdn%.duckdns.org}"
  web_svc=$(kubectl -n "$ns" get svc -l app.kubernetes.io/part-of=steam-headless-fleet -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | grep -- '-web$' | head -n1 || true)
  [[ -n "$web_svc" ]] || continue
  ip=$(kubectl -n "$ns" get svc "$web_svc" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
  [[ -n "$ip" ]] || continue
  response=$(curl -fsS --max-time 20 \
    "https://www.duckdns.org/update?domains=${subdomain}&token=${DUCKDNS_TOKEN}&ip=${ip}" \
    2>/dev/null || true)
  if [[ "$response" == "OK" ]]; then
    echo "${ns}: ${domain_fqdn} -> ${ip} [OK]"
    updated=$((updated + 1))
  else
    echo "${ns}: ${domain_fqdn} -> ${ip} [FAILED: ${response:-<empty>}]" >&2
  fi
done

echo "DuckDNS updates completed: ${updated}"
