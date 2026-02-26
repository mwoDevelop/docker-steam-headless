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
: "${K8S_FLEET_LABEL:=app.kubernetes.io/part-of=steam-headless-fleet}"
: "${DESTROY_CLUSTER_NAME_REGEX:=^(steam-gpu-k8s.*|kub-free)$}"
: "${DELETE_RELATED_STATIC_IPS:=true}"
: "${STATIC_IP_NAME_REGEX:=^(steam-headless-(ip|l4-ip|lb-ip).*)$}"
: "${DELETE_RELATED_FORWARDING_RULES:=true}"

log() { printf '%s [gcp-v8s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
is_true() {
  local value="${1:-}"
  [[ "${value,,}" == "true" || "$value" == "1" || "${value,,}" == "yes" ]]
}

delete_forwarding_rules_for_ip() {
  local ip="$1"
  local entry name region
  mapfile -t entries < <(gcloud compute forwarding-rules list \
    --filter="IPAddress=${ip}" \
    --format='value(name,region.basename())' 2>/dev/null || true)

  for entry in "${entries[@]}"; do
    [[ -n "$entry" ]] || continue
    name=$(awk '{print $1}' <<<"$entry")
    region=$(awk '{print $2}' <<<"$entry")
    if [[ -n "$name" && -n "$region" ]]; then
      log "Deleting forwarding rule ${name} (${region}) for IP ${ip}"
      gcloud compute forwarding-rules delete "$name" --region "$region" --quiet >/dev/null 2>&1 || true
    fi
  done
}

delete_static_ips() {
  local address_entry name address region
  mapfile -t address_entries < <(gcloud compute addresses list \
    --format='value(name,address,region.basename())' 2>/dev/null | grep -E "$STATIC_IP_NAME_REGEX" || true)

  if [[ "${#address_entries[@]}" -eq 0 ]]; then
    log "No related static IPs found"
    return 0
  fi

  for address_entry in "${address_entries[@]}"; do
    [[ -n "$address_entry" ]] || continue
    name=$(awk '{print $1}' <<<"$address_entry")
    address=$(awk '{print $2}' <<<"$address_entry")
    region=$(awk '{print $3}' <<<"$address_entry")
    [[ -n "$name" && -n "$region" ]] || continue
    if is_true "$DELETE_RELATED_FORWARDING_RULES" && [[ -n "$address" ]]; then
      delete_forwarding_rules_for_ip "$address"
    fi
    log "Deleting static IP ${name} (${region})"
    gcloud compute addresses delete "$name" --region "$region" --quiet >/dev/null 2>&1 || true
  done
}

delete_cluster_namespaces() {
  local cluster_name="$1"
  local cluster_location="$2"
  gcloud container clusters get-credentials "$cluster_name" --location "$cluster_location" --project "$GCP_PROJECT" >/dev/null 2>&1 || true

  local ns
  mapfile -t ns_list < <(kubectl get ns -l "$K8S_FLEET_LABEL" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)
  for ns in "${ns_list[@]}"; do
    [[ -n "$ns" ]] || continue
    log "Deleting namespace ${ns} from ${cluster_name}"
    kubectl delete namespace "$ns" --ignore-not-found >/dev/null 2>&1 || true
  done

  if [[ -n "${K8S_NAMESPACE:-}" ]]; then
    log "Deleting namespace ${K8S_NAMESPACE} from ${cluster_name}"
    kubectl delete namespace "$K8S_NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
  fi
}

wait_for_cluster_cleanup() {
  local max_checks="${1:-60}"
  local sleep_seconds="${2:-10}"
  local check matches

  for check in $(seq 1 "$max_checks"); do
    matches=$(gcloud container clusters list --format='value(name)' 2>/dev/null | grep -E "$DESTROY_CLUSTER_NAME_REGEX" || true)
    if [[ -z "$matches" ]]; then
      log "All matching clusters deleted"
      return 0
    fi
    log "Waiting for clusters to finish deleting (attempt ${check}/${max_checks})"
    sleep "$sleep_seconds"
  done
  log "WARN: cluster deletion still in progress after wait window"
  return 1
}

gcloud config set project "$GCP_PROJECT" >/dev/null

mapfile -t cluster_entries < <(gcloud container clusters list --format='value(name,location)' 2>/dev/null | grep -E "$DESTROY_CLUSTER_NAME_REGEX" || true)

if [[ "${#cluster_entries[@]}" -eq 0 ]]; then
  log "No matching clusters found for regex: ${DESTROY_CLUSTER_NAME_REGEX}"
else
  for cluster_entry in "${cluster_entries[@]}"; do
    [[ -n "$cluster_entry" ]] || continue
    cluster_name=$(awk '{print $1}' <<<"$cluster_entry")
    cluster_location=$(awk '{print $2}' <<<"$cluster_entry")
    [[ -n "$cluster_name" && -n "$cluster_location" ]] || continue
    log "Preparing cluster cleanup: ${cluster_name} (${cluster_location})"
    delete_cluster_namespaces "$cluster_name" "$cluster_location"
    log "Deleting cluster ${cluster_name} (${cluster_location})"
    gcloud container clusters delete "$cluster_name" --location "$cluster_location" --quiet >/dev/null 2>&1 || true
  done
fi

wait_for_cluster_cleanup || true

if is_true "$DELETE_RELATED_STATIC_IPS"; then
  delete_static_ips
  sleep 5
  delete_static_ips
fi

log "Destroy completed"
