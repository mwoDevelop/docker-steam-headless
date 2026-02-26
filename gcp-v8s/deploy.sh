#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROFILE="${PROFILE:-}"
PROFILE_EXPLICIT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      [[ $# -ge 2 ]] || { echo "Missing value for --profile" >&2; exit 1; }
      PROFILE="$2"
      PROFILE_EXPLICIT=1
      shift 2
      ;;
    --profile=*)
      PROFILE="${1#*=}"
      PROFILE_EXPLICIT=1
      shift
      ;;
    help|-h|--help)
      cat <<USAGE
Usage:
  $0 --profile L4|T4|...

Examples:
  $0 --profile L4
  $0 --profile T4
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Use: $0 --profile L4|T4|..." >&2
      exit 1
      ;;
  esac
done

if [[ "$PROFILE_EXPLICIT" -ne 1 || -z "$PROFILE" ]]; then
  echo "ERROR: explicit profile is required." >&2
  echo "Usage: $0 --profile L4|T4|..." >&2
  exit 1
fi

# shellcheck disable=SC1091
source "${ROOT_DIR}/lib/env.sh"
load_gcp_v8s_env "$ROOT_DIR"
printf '%s\n' "$ACTIVE_PROFILE" > "$ACTIVE_PROFILE_STATE_FILE"

: "${GCP_PROJECT:=}"
: "${GKE_CLUSTER:=steam-gpu-k8s}"
: "${GKE_LOCATION:=europe-central2-b}"
: "${GKE_NETWORK:=default}"
: "${GKE_SUBNETWORK:=default}"
: "${DEFAULT_POOL_NAME:=default-pool}"
: "${DEFAULT_POOL_MACHINE:=e2-standard-4}"
: "${DEFAULT_POOL_NODES:=1}"
: "${GPU_POOL_NAME:=gpu-pool}"
: "${GPU_MACHINE:=n1-standard-4}"
: "${GPU_TYPE:=nvidia-tesla-t4}"
: "${GPU_COUNT:=1}"
: "${GPU_SHARING_STRATEGY:=}"
: "${GPU_MAX_SHARED_CLIENTS_PER_GPU:=}"
: "${GPU_MIN_NODES:=1}"
: "${GPU_MAX_NODES:=1}"
: "${GPU_DISK_SIZE_GB:=120}"
: "${GPU_DISK_TYPE:=pd-balanced}"
: "${K8S_NAMESPACE:=steam-headless}"
: "${DEPLOY_DEFAULT_WORKLOAD:=true}"
: "${IMAGE:=josh5/steam-headless:latest}"
: "${PULL_POLICY:=IfNotPresent}"
: "${WEB_SERVICE_NAME:=steam-headless-web}"
: "${STREAM_SERVICE_NAME:=steam-headless-stream}"
: "${STREAM_UDP_SERVICE_NAME:=steam-headless-stream-udp}"
: "${WEB_PORT_NOVNC:=8083}"
: "${WEB_PORT_SUNSHINE:=47990}"
: "${LB_ADDRESS_NAME:=steam-headless-lb-ip}"
: "${SOURCE_RANGES:=0.0.0.0/0}"

: "${NAME:=SteamHeadless}"
: "${TZ:=Europe/Warsaw}"
: "${USER_LOCALES:=en_US.UTF-8 UTF-8}"
: "${DISPLAY:=:55}"
: "${SHM_SIZE:=4GB}"
: "${PUID:=1000}"
: "${PGID:=1000}"
: "${UMASK:=000}"
: "${USER_PASSWORD:=password}"
: "${MODE:=primary}"
: "${WEB_UI_MODE:=vnc}"
: "${ENABLE_VNC_AUDIO:=true}"
: "${ENABLE_STEAM:=true}"
: "${STEAM_ARGS:=-silent}"
: "${ENABLE_SUNSHINE:=true}"
: "${SUNSHINE_USER:=admin}"
: "${SUNSHINE_PASS:=admin}"
: "${ENABLE_EVDEV_INPUTS:=true}"
: "${FORCE_X11_DUMMY_CONFIG:=true}"
: "${DISPLAY_SIZEW:=1920}"
: "${DISPLAY_SIZEH:=1080}"
: "${DISPLAY_REFRESH:=60}"
: "${DISPLAY_CDEPTH:=24}"
: "${NVIDIA_DRIVER_CAPABILITIES:=all}"
: "${NVIDIA_VISIBLE_DEVICES:=all}"
: "${NVIDIA_DRIVER_VERSION:=}"

log() { printf '%s [gcp-v8s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
normalize_gpu_sharing_strategy() {
  local value="${1:-}"
  value="${value^^}"
  value="${value//-/_}"
  printf '%s' "$value"
}

gpu_pool_diff_reason() {
  local expected_sharing expected_max_shared
  local current_machine current_type current_count current_sharing current_max_shared
  local current_min_nodes current_max_nodes current_disk_size current_disk_type
  local reasons=()

  expected_sharing="$(normalize_gpu_sharing_strategy "$GPU_SHARING_STRATEGY")"
  expected_max_shared="${GPU_MAX_SHARED_CLIENTS_PER_GPU:-}"

  current_machine="$(gcloud container node-pools describe "$GPU_POOL_NAME" --cluster "$GKE_CLUSTER" --location "$GKE_LOCATION" --format='value(config.machineType)' 2>/dev/null || true)"
  current_type="$(gcloud container node-pools describe "$GPU_POOL_NAME" --cluster "$GKE_CLUSTER" --location "$GKE_LOCATION" --format='value(config.accelerators[0].acceleratorType)' 2>/dev/null || true)"
  current_count="$(gcloud container node-pools describe "$GPU_POOL_NAME" --cluster "$GKE_CLUSTER" --location "$GKE_LOCATION" --format='value(config.accelerators[0].acceleratorCount)' 2>/dev/null || true)"
  current_sharing="$(gcloud container node-pools describe "$GPU_POOL_NAME" --cluster "$GKE_CLUSTER" --location "$GKE_LOCATION" --format='value(config.accelerators[0].gpuSharingConfig.gpuSharingStrategy)' 2>/dev/null || true)"
  current_max_shared="$(gcloud container node-pools describe "$GPU_POOL_NAME" --cluster "$GKE_CLUSTER" --location "$GKE_LOCATION" --format='value(config.accelerators[0].gpuSharingConfig.maxSharedClientsPerGpu)' 2>/dev/null || true)"
  current_min_nodes="$(gcloud container node-pools describe "$GPU_POOL_NAME" --cluster "$GKE_CLUSTER" --location "$GKE_LOCATION" --format='value(autoscaling.minNodeCount)' 2>/dev/null || true)"
  current_max_nodes="$(gcloud container node-pools describe "$GPU_POOL_NAME" --cluster "$GKE_CLUSTER" --location "$GKE_LOCATION" --format='value(autoscaling.maxNodeCount)' 2>/dev/null || true)"
  current_disk_size="$(gcloud container node-pools describe "$GPU_POOL_NAME" --cluster "$GKE_CLUSTER" --location "$GKE_LOCATION" --format='value(config.diskSizeGb)' 2>/dev/null || true)"
  current_disk_type="$(gcloud container node-pools describe "$GPU_POOL_NAME" --cluster "$GKE_CLUSTER" --location "$GKE_LOCATION" --format='value(config.diskType)' 2>/dev/null || true)"

  [[ "$current_machine" == "$GPU_MACHINE" ]] || reasons+=("machineType=${current_machine:-<none>}!=${GPU_MACHINE}")
  [[ "$current_type" == "$GPU_TYPE" ]] || reasons+=("gpuType=${current_type:-<none>}!=${GPU_TYPE}")
  [[ "$current_count" == "$GPU_COUNT" ]] || reasons+=("gpuCount=${current_count:-<none>}!=${GPU_COUNT}")
  [[ "$current_min_nodes" == "$GPU_MIN_NODES" ]] || reasons+=("minNodes=${current_min_nodes:-<none>}!=${GPU_MIN_NODES}")
  [[ "$current_max_nodes" == "$GPU_MAX_NODES" ]] || reasons+=("maxNodes=${current_max_nodes:-<none>}!=${GPU_MAX_NODES}")
  [[ "$current_disk_size" == "$GPU_DISK_SIZE_GB" ]] || reasons+=("diskSize=${current_disk_size:-<none>}!=${GPU_DISK_SIZE_GB}")
  [[ "$current_disk_type" == "$GPU_DISK_TYPE" ]] || reasons+=("diskType=${current_disk_type:-<none>}!=${GPU_DISK_TYPE}")

  if [[ -n "$expected_sharing" ]]; then
    [[ "$current_sharing" == "$expected_sharing" ]] || reasons+=("sharing=${current_sharing:-<none>}!=${expected_sharing}")
    if [[ -n "$expected_max_shared" ]]; then
      [[ "$current_max_shared" == "$expected_max_shared" ]] || reasons+=("maxShared=${current_max_shared:-<none>}!=${expected_max_shared}")
    fi
  else
    [[ -z "$current_sharing" ]] || reasons+=("sharing=${current_sharing}!=<none>")
  fi

  if [[ "${#reasons[@]}" -eq 0 ]]; then
    return 1
  fi
  printf '%s' "${reasons[*]}"
  return 0
}

region_from_location() {
  local location="$1"
  if [[ "$location" =~ ^[a-z]+-[a-z0-9]+[0-9]-[a-z]$ ]]; then
    echo "${location%-[a-z]}"
  else
    echo "$location"
  fi
}

source_ranges_json() {
  local raw="$1"
  local cleaned value out=""
  cleaned="${raw// /}"
  cleaned="${cleaned#,}"
  cleaned="${cleaned%,}"
  IFS=',' read -r -a items <<< "$cleaned"
  for value in "${items[@]}"; do
    [[ -n "$value" ]] || continue
    if [[ -n "$out" ]]; then out+=", "; fi
    out+="\"${value}\""
  done
  [[ -n "$out" ]] || out="\"0.0.0.0/0\""
  printf '[%s]' "$out"
}

gcloud config set project "$GCP_PROJECT" >/dev/null

log "Using profile=${ACTIVE_PROFILE} (${ACTIVE_PROFILE_FILE})"
log "Saved active profile in ${ACTIVE_PROFILE_STATE_FILE}"
log "Checking cluster ${GKE_CLUSTER} in ${GKE_LOCATION}"
if ! gcloud container clusters describe "$GKE_CLUSTER" --location "$GKE_LOCATION" >/dev/null 2>&1; then
  log "Creating GKE cluster"
  gcloud container clusters create "$GKE_CLUSTER" \
    --location "$GKE_LOCATION" \
    --network "$GKE_NETWORK" \
    --subnetwork "$GKE_SUBNETWORK" \
    --release-channel regular \
    --machine-type "$DEFAULT_POOL_MACHINE" \
    --num-nodes "$DEFAULT_POOL_NODES" \
    --enable-ip-alias \
    --workload-pool "${GCP_PROJECT}.svc.id.goog" \
    --logging=SYSTEM,WORKLOAD \
    --monitoring=SYSTEM \
    --addons=GcePersistentDiskCsiDriver \
    --disk-type=pd-balanced \
    --disk-size=100
else
  log "Cluster already exists"
fi

create_gpu_pool() {
  local accelerator
  accelerator="type=${GPU_TYPE},count=${GPU_COUNT},gpu-driver-version=latest"
  if [[ -n "$GPU_SHARING_STRATEGY" ]]; then
    accelerator+=",gpu-sharing-strategy=${GPU_SHARING_STRATEGY}"
  fi
  if [[ -n "$GPU_MAX_SHARED_CLIENTS_PER_GPU" ]]; then
    accelerator+=",max-shared-clients-per-gpu=${GPU_MAX_SHARED_CLIENTS_PER_GPU}"
  fi

  gcloud container node-pools create "$GPU_POOL_NAME" \
    --cluster "$GKE_CLUSTER" \
    --location "$GKE_LOCATION" \
    --machine-type "$GPU_MACHINE" \
    --accelerator "$accelerator" \
    --image-type COS_CONTAINERD \
    --disk-size "$GPU_DISK_SIZE_GB" \
    --disk-type "$GPU_DISK_TYPE" \
    --node-taints "nvidia.com/gpu=present:NoSchedule" \
    --num-nodes "$GPU_MIN_NODES" \
    --enable-autoscaling \
    --min-nodes "$GPU_MIN_NODES" \
    --max-nodes "$GPU_MAX_NODES"
}

if ! gcloud container node-pools describe "$GPU_POOL_NAME" --cluster "$GKE_CLUSTER" --location "$GKE_LOCATION" >/dev/null 2>&1; then
  log "Creating GPU node pool ${GPU_POOL_NAME}"
  create_gpu_pool
else
  GPU_STATUS=$(gcloud container node-pools describe "$GPU_POOL_NAME" \
    --cluster "$GKE_CLUSTER" \
    --location "$GKE_LOCATION" \
    --format='value(status)' 2>/dev/null || true)
  if [[ "$GPU_STATUS" == "ERROR" ]]; then
    log "GPU node pool is in ERROR, recreating"
    gcloud container node-pools delete "$GPU_POOL_NAME" \
      --cluster "$GKE_CLUSTER" \
      --location "$GKE_LOCATION" \
      --quiet
    create_gpu_pool
  else
    GPU_POOL_DIFF="$(gpu_pool_diff_reason || true)"
    if [[ -n "$GPU_POOL_DIFF" ]]; then
      log "GPU node pool config drift detected (${GPU_POOL_DIFF}), recreating"
      gcloud container node-pools delete "$GPU_POOL_NAME" \
        --cluster "$GKE_CLUSTER" \
        --location "$GKE_LOCATION" \
        --quiet
      create_gpu_pool
    else
      log "GPU node pool already exists and matches requested profile"
    fi
  fi
fi

log "Getting kube credentials"
gcloud container clusters get-credentials "$GKE_CLUSTER" --location "$GKE_LOCATION" --project "$GCP_PROJECT"

if [[ "$DEPLOY_DEFAULT_WORKLOAD" != "true" ]]; then
  log "Cluster and GPU node pool ready (DEPLOY_DEFAULT_WORKLOAD=${DEPLOY_DEFAULT_WORKLOAD})"
  log "Skipping default steam-headless workload deployment"
  echo "Cluster: ${GKE_CLUSTER} (${GKE_LOCATION})"
  echo "GPU pool: ${GPU_POOL_NAME} (type=${GPU_TYPE}, sharing=${GPU_SHARING_STRATEGY:-none}, max-shared=${GPU_MAX_SHARED_CLIENTS_PER_GPU:-n/a})"
  exit 0
fi

log "Applying default workload manifests"
kubectl apply -f "${ROOT_DIR}/manifests/namespace.yaml"

LB_REGION=$(region_from_location "$GKE_LOCATION")
if ! gcloud compute addresses describe "$LB_ADDRESS_NAME" --region "$LB_REGION" >/dev/null 2>&1; then
  log "Creating static external IP ${LB_ADDRESS_NAME} in ${LB_REGION}"
  gcloud compute addresses create "$LB_ADDRESS_NAME" --region "$LB_REGION"
fi
LB_IP=$(gcloud compute addresses describe "$LB_ADDRESS_NAME" --region "$LB_REGION" --format='value(address)')

log "Creating/updating workload secret"
kubectl -n "$K8S_NAMESPACE" delete secret steam-headless-env --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$K8S_NAMESPACE" create secret generic steam-headless-env \
  --from-literal=NAME="$NAME" \
  --from-literal=TZ="$TZ" \
  --from-literal=USER_LOCALES="$USER_LOCALES" \
  --from-literal=DISPLAY="$DISPLAY" \
  --from-literal=SHM_SIZE="$SHM_SIZE" \
  --from-literal=PUID="$PUID" \
  --from-literal=PGID="$PGID" \
  --from-literal=UMASK="$UMASK" \
  --from-literal=USER_PASSWORD="$USER_PASSWORD" \
  --from-literal=MODE="$MODE" \
  --from-literal=WEB_UI_MODE="$WEB_UI_MODE" \
  --from-literal=ENABLE_VNC_AUDIO="$ENABLE_VNC_AUDIO" \
  --from-literal=PORT_NOVNC_WEB="$WEB_PORT_NOVNC" \
  --from-literal=NEKO_NAT1TO1="" \
  --from-literal=ENABLE_STEAM="$ENABLE_STEAM" \
  --from-literal=STEAM_ARGS="$STEAM_ARGS" \
  --from-literal=ENABLE_SUNSHINE="$ENABLE_SUNSHINE" \
  --from-literal=SUNSHINE_USER="$SUNSHINE_USER" \
  --from-literal=SUNSHINE_PASS="$SUNSHINE_PASS" \
  --from-literal=ENABLE_EVDEV_INPUTS="$ENABLE_EVDEV_INPUTS" \
  --from-literal=FORCE_X11_DUMMY_CONFIG="$FORCE_X11_DUMMY_CONFIG" \
  --from-literal=DISPLAY_SIZEW="$DISPLAY_SIZEW" \
  --from-literal=DISPLAY_SIZEH="$DISPLAY_SIZEH" \
  --from-literal=DISPLAY_REFRESH="$DISPLAY_REFRESH" \
  --from-literal=DISPLAY_CDEPTH="$DISPLAY_CDEPTH" \
  --from-literal=NVIDIA_DRIVER_CAPABILITIES="$NVIDIA_DRIVER_CAPABILITIES" \
  --from-literal=NVIDIA_VISIBLE_DEVICES="$NVIDIA_VISIBLE_DEVICES" \
  --from-literal=NVIDIA_DRIVER_VERSION="$NVIDIA_DRIVER_VERSION"

kubectl apply -f "${ROOT_DIR}/manifests/deployment.yaml"
kubectl -n "$K8S_NAMESPACE" patch deployment steam-headless --type=json \
  -p "[{\"op\":\"replace\",\"path\":\"/spec/template/spec/nodeSelector/cloud.google.com~1gke-accelerator\",\"value\":\"${GPU_TYPE}\"}]"
kubectl -n "$K8S_NAMESPACE" set image deployment/steam-headless "steam-headless=${IMAGE}" >/dev/null
kubectl -n "$K8S_NAMESPACE" patch deployment steam-headless --type=json \
  -p "[{\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/imagePullPolicy\",\"value\":\"${PULL_POLICY}\"}]"
kubectl apply -f "${ROOT_DIR}/manifests/service-web.yaml"
kubectl apply -f "${ROOT_DIR}/manifests/service-stream.yaml"
kubectl -n "$K8S_NAMESPACE" delete svc steam-headless-stream --ignore-not-found >/dev/null 2>&1 || true
SOURCE_RANGES_JSON="$(source_ranges_json "$SOURCE_RANGES")"
kubectl -n "$K8S_NAMESPACE" patch svc "$WEB_SERVICE_NAME" --type=merge -p "{\"spec\":{\"loadBalancerSourceRanges\":${SOURCE_RANGES_JSON}}}"
kubectl -n "$K8S_NAMESPACE" patch svc "$STREAM_UDP_SERVICE_NAME" --type=merge -p "{\"spec\":{\"loadBalancerSourceRanges\":${SOURCE_RANGES_JSON}}}"
kubectl -n "$K8S_NAMESPACE" patch svc "$WEB_SERVICE_NAME" --type=merge -p "{\"spec\":{\"loadBalancerIP\":\"${LB_IP}\"}}"
kubectl -n "$K8S_NAMESPACE" patch svc "$STREAM_UDP_SERVICE_NAME" --type=merge -p "{\"spec\":{\"loadBalancerIP\":\"${LB_IP}\"}}"

log "Waiting for rollout"
kubectl -n "$K8S_NAMESPACE" rollout status deployment/steam-headless --timeout=30m

log "Checking GPU inside pod"
POD_NAME=$(kubectl -n "$K8S_NAMESPACE" get pods -l app=steam-headless -o jsonpath='{.items[0].metadata.name}')
if ! kubectl -n "$K8S_NAMESPACE" exec "$POD_NAME" -- sh -lc 'ls /dev/nvidia0 >/dev/null 2>&1'; then
  echo "GPU device /dev/nvidia0 not visible in container" >&2
  exit 1
fi

wait_lb_ip() {
  local namespace="$1"
  local service="$2"
  local ip=""
  for _ in $(seq 1 90); do
    ip=$(kubectl -n "$namespace" get svc "$service" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
    if [[ -n "$ip" ]]; then
      echo "$ip"
      return 0
    fi
    sleep 5
  done
  return 1
}

WEB_IP=$(wait_lb_ip "$K8S_NAMESPACE" "$WEB_SERVICE_NAME" || true)
STREAM_IP=$(wait_lb_ip "$K8S_NAMESPACE" "$STREAM_UDP_SERVICE_NAME" || true)

log "Deployment ready"
echo "Namespace:  ${K8S_NAMESPACE}"
echo "Cluster:    ${GKE_CLUSTER} (${GKE_LOCATION})"
echo "GPU pool:   ${GPU_POOL_NAME} (type=${GPU_TYPE}, sharing=${GPU_SHARING_STRATEGY:-none}, max-shared=${GPU_MAX_SHARED_CLIENTS_PER_GPU:-n/a})"
echo "Image:      ${IMAGE}"
echo "Static IP:  ${LB_IP}"
echo "Web LB IP:  ${WEB_IP:-<pending>}"
echo "Stream LB:  ${STREAM_IP:-<pending>}"
echo "Sources:    ${SOURCE_RANGES}"
echo "noVNC:      http://${WEB_IP:-<pending>}:${WEB_PORT_NOVNC}/"
echo "Sunshine:   https://${WEB_IP:-<pending>}:${WEB_PORT_SUNSHINE}/"
echo "SUNSHINE_USER=${SUNSHINE_USER}"
echo "SUNSHINE_PASS=${SUNSHINE_PASS}"
