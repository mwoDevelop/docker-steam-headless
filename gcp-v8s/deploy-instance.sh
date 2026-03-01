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
: "${GPU_TYPE:=nvidia-tesla-t4}"
: "${IMAGE:=josh5/steam-headless:latest}"
: "${PULL_POLICY:=IfNotPresent}"
: "${SOURCE_RANGES:=0.0.0.0/0}"
: "${LB_ADDRESS_PREFIX:=steam-headless-ip}"
: "${K8S_NAMESPACE_PREFIX:=steam}"
: "${DUCKDNS_ENABLED:=false}"
: "${DUCKDNS_TOKEN:=}"
: "${DUCKDNS_BASE_DOMAIN:=k8s-gcp}"
: "${DUCKDNS_SUFFIX_SEPARATOR:--}"
: "${DUCKDNS_PER_INSTANCE:=true}"
: "${DUCKDNS_FALLBACK_TO_BASE:=true}"

: "${WEB_PORT_NOVNC:=8083}"
: "${WEB_PORT_SUNSHINE:=47990}"

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
err() { log "ERROR: $*" >&2; exit 1; }

usage() {
  cat <<USAGE
Usage:
  $0 <instance-id>
  $0 help

Example:
  $0 gamer1
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

duckdns_enabled() {
  [[ "${DUCKDNS_ENABLED,,}" == "true" || "${DUCKDNS_ENABLED}" == "1" || "${DUCKDNS_ENABLED,,}" == "yes" ]]
}

is_true() {
  local value="${1:-}"
  [[ "${value,,}" == "true" || "$value" == "1" || "${value,,}" == "yes" ]]
}

duckdns_base_domain() {
  local base="${DUCKDNS_BASE_DOMAIN%.duckdns.org}"
  base="${base#http://}"
  base="${base#https://}"
  base="${base%%/*}"
  base="${base%%:*}"
  printf '%s' "$base"
}

duckdns_subdomain_for_instance() {
  local instance_safe="$1"
  local base
  base="$(duckdns_base_domain)"
  if [[ -z "$base" ]]; then
    return 1
  fi
  if ! is_true "$DUCKDNS_PER_INSTANCE"; then
    printf '%s' "$base"
    return 0
  fi
  printf '%s%s%s' "$base" "$DUCKDNS_SUFFIX_SEPARATOR" "$instance_safe"
}

duckdns_update_domain() {
  local domain="$1"
  local ip="$2"
  local response
  response=$(curl -fsS --max-time 20 \
    "https://www.duckdns.org/update?domains=${domain}&token=${DUCKDNS_TOKEN}&ip=${ip}" \
    2>/dev/null || true)
  [[ "$response" == "OK" ]]
}

source_ranges_yaml() {
  local raw="$1"
  local cleaned value
  local has_value=0
  cleaned="${raw// /}"
  cleaned="${cleaned#,}"
  cleaned="${cleaned%,}"
  IFS=',' read -r -a items <<< "$cleaned"
  for value in "${items[@]}"; do
    [[ -n "$value" ]] || continue
    has_value=1
    printf '  - %s\n' "$value"
  done
  if [[ "$has_value" -eq 0 ]]; then
    printf '  - 0.0.0.0/0\n'
  fi
}

INSTANCE="${1:-}"
if [[ -z "$INSTANCE" || "$INSTANCE" == "help" || "$INSTANCE" == "-h" || "$INSTANCE" == "--help" ]]; then
  usage
  exit 0
fi
if [[ "$INSTANCE" == --* ]]; then
  err "Unknown option: ${INSTANCE}. Set profile via ./deploy.sh --profile <L4|T4>."
fi

INSTANCE_SAFE=$(printf '%s' "$INSTANCE" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9-' '-')
INSTANCE_SAFE="${INSTANCE_SAFE#-}"
INSTANCE_SAFE="${INSTANCE_SAFE%-}"
[[ -n "$INSTANCE_SAFE" ]] || err "Invalid instance id: ${INSTANCE}"

NAMESPACE="${K8S_NAMESPACE_PREFIX}-${INSTANCE_SAFE}"
APP_NAME="steam-headless-${INSTANCE_SAFE}"
SECRET_NAME="${APP_NAME}-env"
WEB_SERVICE_NAME="${APP_NAME}-web"
STREAM_UDP_SERVICE_NAME="${APP_NAME}-stream-udp"
LB_ADDRESS_NAME="${LB_ADDRESS_PREFIX}-${INSTANCE_SAFE}"
DUCKDNS_SUBDOMAIN=""
DUCKDNS_FQDN=""
DUCKDNS_BASE=""

if duckdns_enabled; then
  [[ -n "$DUCKDNS_TOKEN" ]] || err "DUCKDNS_ENABLED=true but DUCKDNS_TOKEN is empty"
  DUCKDNS_BASE="$(duckdns_base_domain)"
  [[ -n "$DUCKDNS_BASE" ]] || err "Cannot parse DUCKDNS_BASE_DOMAIN='${DUCKDNS_BASE_DOMAIN}'"
  DUCKDNS_SUBDOMAIN="$(duckdns_subdomain_for_instance "$INSTANCE_SAFE")" || \
    err "Cannot build DuckDNS subdomain from DUCKDNS_BASE_DOMAIN='${DUCKDNS_BASE_DOMAIN}'"
  DUCKDNS_FQDN="${DUCKDNS_SUBDOMAIN}.duckdns.org"
fi

gcloud config set project "$GCP_PROJECT" >/dev/null
gcloud container clusters describe "$GKE_CLUSTER" --location "$GKE_LOCATION" >/dev/null 2>&1 || \
  err "Cluster ${GKE_CLUSTER} not found in ${GKE_LOCATION}. Run ./deploy.sh first."
gcloud container clusters get-credentials "$GKE_CLUSTER" --location "$GKE_LOCATION" --project "$GCP_PROJECT" >/dev/null

LB_REGION=$(region_from_location "$GKE_LOCATION")
if ! gcloud compute addresses describe "$LB_ADDRESS_NAME" --region "$LB_REGION" >/dev/null 2>&1; then
  log "Creating static IP ${LB_ADDRESS_NAME} in ${LB_REGION}"
  gcloud compute addresses create "$LB_ADDRESS_NAME" --region "$LB_REGION" >/dev/null
fi
LB_IP=$(gcloud compute addresses describe "$LB_ADDRESS_NAME" --region "$LB_REGION" --format='value(address)')

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace "$NAMESPACE" \
  app.kubernetes.io/part-of=steam-headless-fleet \
  steam-headless-instance="$INSTANCE_SAFE" \
  --overwrite >/dev/null
kubectl annotate namespace "$NAMESPACE" \
  steam-headless/duckdns-enabled="$(duckdns_enabled && echo true || echo false)" \
  steam-headless/duckdns-domain="${DUCKDNS_FQDN}" \
  --overwrite >/dev/null

kubectl -n "$NAMESPACE" delete secret "$SECRET_NAME" --ignore-not-found >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" create secret generic "$SECRET_NAME" \
  --from-literal=NAME="${NAME}-${INSTANCE_SAFE}" \
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
  --from-literal=NVIDIA_DRIVER_VERSION="$NVIDIA_DRIVER_VERSION" >/dev/null

SOURCE_RANGES_BLOCK="$(source_ranges_yaml "$SOURCE_RANGES")"

cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${APP_NAME}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/part-of: steam-headless-fleet
    app.kubernetes.io/name: steam-headless
    steam-headless-instance: ${INSTANCE_SAFE}
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: ${APP_NAME}
  template:
    metadata:
      labels:
        app: ${APP_NAME}
        app.kubernetes.io/part-of: steam-headless-fleet
        app.kubernetes.io/name: steam-headless
        steam-headless-instance: ${INSTANCE_SAFE}
    spec:
      terminationGracePeriodSeconds: 30
      nodeSelector:
        cloud.google.com/gke-accelerator: ${GPU_TYPE}
      tolerations:
        - key: nvidia.com/gpu
          operator: Equal
          value: present
          effect: NoSchedule
      containers:
        - name: steam-headless
          image: ${IMAGE}
          imagePullPolicy: ${PULL_POLICY}
          command: ["/bin/bash", "-lc"]
          args:
            - touch /tmp/.desktop-apps-updated; exec /entrypoint.sh
          securityContext:
            privileged: true
            allowPrivilegeEscalation: true
          envFrom:
            - secretRef:
                name: ${SECRET_NAME}
          resources:
            requests:
              cpu: "2"
              memory: "8Gi"
              nvidia.com/gpu: "1"
            limits:
              cpu: "4"
              memory: "12Gi"
              nvidia.com/gpu: "1"
          ports:
            - name: novnc
              containerPort: 8083
              protocol: TCP
            - name: sun-ui
              containerPort: 47990
              protocol: TCP
            - name: sun-pair
              containerPort: 47984
              protocol: TCP
            - name: sun-ctrl
              containerPort: 47989
              protocol: TCP
            - name: sun-stream
              containerPort: 48010
              protocol: TCP
            - name: sun-udp-1
              containerPort: 47998
              protocol: UDP
            - name: sun-udp-2
              containerPort: 47999
              protocol: UDP
            - name: sun-udp-3
              containerPort: 48000
              protocol: UDP
            - name: sun-udp-4
              containerPort: 48002
              protocol: UDP
          volumeMounts:
            - name: steam-home
              mountPath: /home/default
            - name: games
              mountPath: /mnt/games
            - name: x11
              mountPath: /tmp/.X11-unix
            - name: pulse
              mountPath: /tmp/pulse
            - name: shm
              mountPath: /dev/shm
      volumes:
        - name: steam-home
          emptyDir: {}
        - name: games
          emptyDir: {}
        - name: x11
          emptyDir: {}
        - name: pulse
          emptyDir: {}
        - name: shm
          emptyDir:
            medium: Memory
            sizeLimit: 4Gi
---
apiVersion: v1
kind: Service
metadata:
  name: ${WEB_SERVICE_NAME}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/part-of: steam-headless-fleet
    steam-headless-instance: ${INSTANCE_SAFE}
spec:
  type: LoadBalancer
  loadBalancerIP: ${LB_IP}
  loadBalancerSourceRanges:
${SOURCE_RANGES_BLOCK}
  selector:
    app: ${APP_NAME}
  ports:
    - name: novnc
      protocol: TCP
      port: 8083
      targetPort: 8083
    - name: sunshine-ui
      protocol: TCP
      port: 47990
      targetPort: 47990
    - name: sun-pair
      protocol: TCP
      port: 47984
      targetPort: 47984
    - name: sun-ctrl
      protocol: TCP
      port: 47989
      targetPort: 47989
    - name: sun-stream
      protocol: TCP
      port: 48010
      targetPort: 48010
---
apiVersion: v1
kind: Service
metadata:
  name: ${STREAM_UDP_SERVICE_NAME}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/part-of: steam-headless-fleet
    steam-headless-instance: ${INSTANCE_SAFE}
spec:
  type: LoadBalancer
  loadBalancerIP: ${LB_IP}
  loadBalancerSourceRanges:
${SOURCE_RANGES_BLOCK}
  selector:
    app: ${APP_NAME}
  ports:
    - name: sun-udp-1
      protocol: UDP
      port: 47998
      targetPort: 47998
    - name: sun-udp-2
      protocol: UDP
      port: 47999
      targetPort: 47999
    - name: sun-udp-3
      protocol: UDP
      port: 48000
      targetPort: 48000
    - name: sun-udp-4
      protocol: UDP
      port: 48002
      targetPort: 48002
EOF

kubectl -n "$NAMESPACE" rollout status deployment/"$APP_NAME" --timeout=30m

wait_ip() {
  local namespace="$1" service="$2" ip=""
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

IP=$(wait_ip "$NAMESPACE" "$WEB_SERVICE_NAME" || true)
if [[ -n "$IP" && -n "$DUCKDNS_SUBDOMAIN" ]]; then
  if duckdns_update_domain "$DUCKDNS_SUBDOMAIN" "$IP"; then
    log "DuckDNS updated: ${DUCKDNS_FQDN} -> ${IP}"
  elif is_true "$DUCKDNS_PER_INSTANCE" && is_true "$DUCKDNS_FALLBACK_TO_BASE" && [[ -n "$DUCKDNS_BASE" ]] && [[ "$DUCKDNS_BASE" != "$DUCKDNS_SUBDOMAIN" ]] && duckdns_update_domain "$DUCKDNS_BASE" "$IP"; then
    DUCKDNS_SUBDOMAIN="$DUCKDNS_BASE"
    DUCKDNS_FQDN="${DUCKDNS_BASE}.duckdns.org"
    log "DuckDNS per-instance domain not found; using base domain fallback: ${DUCKDNS_FQDN} -> ${IP}"
  else
    log "WARN: DuckDNS update failed for ${DUCKDNS_FQDN}. Verify domain exists for this token."
  fi
fi

if [[ -n "$DUCKDNS_FQDN" ]]; then
  kubectl annotate namespace "$NAMESPACE" \
    steam-headless/duckdns-domain="${DUCKDNS_FQDN}" \
    --overwrite >/dev/null
fi

echo "Instance:   ${INSTANCE_SAFE}"
echo "Namespace:  ${NAMESPACE}"
echo "Cluster:    ${GKE_CLUSTER} (${GKE_LOCATION})"
echo "GPU type:   ${GPU_TYPE}"
echo "Static IP:  ${LB_IP}"
echo "Ingress IP: ${IP:-<pending>}"
echo "Sources:    ${SOURCE_RANGES}"
echo "noVNC:      http://${IP:-<pending>}:${WEB_PORT_NOVNC}/"
echo "Sunshine:   https://${IP:-<pending>}:${WEB_PORT_SUNSHINE}/"
if [[ -n "$DUCKDNS_FQDN" ]]; then
  echo "DuckDNS:    ${DUCKDNS_FQDN}"
  echo "noVNC DNS:  http://${DUCKDNS_FQDN}:${WEB_PORT_NOVNC}/"
  echo "Sun DNS:    https://${DUCKDNS_FQDN}:${WEB_PORT_SUNSHINE}/"
fi
echo "SUNSHINE_USER=${SUNSHINE_USER}"
echo "SUNSHINE_PASS=${SUNSHINE_PASS}"
