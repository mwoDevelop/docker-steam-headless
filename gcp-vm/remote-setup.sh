#!/usr/bin/env bash
set -euo pipefail

# Run this manually over SSH if the startup script wasn't attached.

wait_for_apt_idle() {
  local n=0
  if command -v fuser >/dev/null 2>&1; then
    while fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1; do
      n=$((n + 1))
      if (( n % 10 == 0 )); then
        echo "[remote-setup] waiting for apt/dpkg lock..."
      fi
      sleep 3
    done
  else
    while pgrep -x apt-get >/dev/null 2>&1 || pgrep -x dpkg >/dev/null 2>&1; do
      n=$((n + 1))
      if (( n % 10 == 0 )); then
        echo "[remote-setup] waiting for apt/dpkg lock..."
      fi
      sleep 3
    done
  fi
}

export DEBIAN_FRONTEND=noninteractive
METADATA_HDR=( -H "Metadata-Flavor: Google" --fail --silent --show-error )
EXT_IP=$(curl "${METADATA_HDR[@]}" \
  http://metadata/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)

metadata_get() {
  local key="$1"
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/instance/attributes/${key}" || true
}

metadata_get_from_instance() {
  local key="$1"
  local token project zone name instance_json
  token="$(metadata_token || true)"
  project="$(project_id || true)"
  zone="$(zone_name || true)"
  name="$(instance_name || true)"
  [[ -n "$token" && -n "$project" && -n "$zone" && -n "$name" ]] || return 1

  instance_json="$(curl --fail --silent --show-error \
    -H "Authorization: Bearer ${token}" \
    "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}" || true)"
  [[ -n "$instance_json" ]] || return 1

  printf '%s\n' "$instance_json" | jq -r --arg key "$key" \
    '.metadata.items // [] | map(select(.key == $key)) | .[0].value // empty'
}

metadata_get_with_retry_instance() {
  local key="$1"
  local retries="${2:-20}"
  local value=""
  local attempt=0

  while (( attempt < retries )); do
    value="$(metadata_get_from_instance "$key" || true)"
    if [[ -n "$value" ]]; then
      printf '%s\n' "$value"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done

  printf '%s\n' "$value"
  return 1
}

metadata_get_with_retry() {
  local key="$1"
  local retries="${2:-20}"
  local value=""
  local attempt=0

  while (( attempt < retries )); do
    value="$(metadata_get "$key" || true)"
    if [[ -n "$value" ]]; then
      printf '%s\n' "$value"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done

  printf '%s\n' "$value"
  return 1
}

normalize_metadata_value() {
  local value="$1"
  if [[ "$value" == "|-"$'\n'* ]]; then
    value="${value#|-$'\n'}"
  fi
  printf '%s\n' "$value"
}

metadata_token() {
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/instance/service-accounts/default/token" \
    | jq -r '.access_token'
}

set_instance_metadata_value() {
  local key="$1"
  local value="${2-}"
  local token project zone name instance_json fingerprint items items_file payload payload_file
  token="$(metadata_token || true)"
  project="$(project_id || true)"
  zone="$(zone_name || true)"
  name="$(instance_name || true)"
  [[ -n "$token" && -n "$project" && -n "$zone" && -n "$name" ]] || return 0

  instance_json="$(curl --fail --silent --show-error \
    -H "Authorization: Bearer ${token}" \
    "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}" || true)"
  [[ -n "$instance_json" ]] || return 0
  fingerprint="$(printf '%s' "$instance_json" | jq -r '.metadata.fingerprint // empty')"
  [[ -n "$fingerprint" ]] || return 0
  items="$(printf '%s' "$instance_json" | jq --arg key "$key" '[.metadata.items // [] | .[] | select(.key != $key)]')"
  items_file="$(mktemp)"
  printf '%s' "$items" > "$items_file"

  if [ -n "$value" ]; then
    payload="$(jq -n \
      --arg fingerprint "$fingerprint" \
      --arg key "$key" \
      --arg value "$value" \
      --slurpfile items "$items_file" \
      '{fingerprint: $fingerprint, items: ($items[0] + [{key: $key, value: $value}])}')"
  else
    payload="$(jq -n \
      --arg fingerprint "$fingerprint" \
      --slurpfile items "$items_file" \
      '{fingerprint: $fingerprint, items: $items[0]}')"
  fi
  rm -f "$items_file"
  payload_file="$(mktemp)"
  printf '%s' "$payload" > "$payload_file"

  curl --fail --silent --show-error \
    -X POST \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    --data-binary "@${payload_file}" \
    "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}/setMetadata" >/dev/null || true
  rm -f "$payload_file"
}

set_sunshine_status() {
  local state="$1"
  local detail="${2-}"
  set_instance_metadata_value vm-sunshine-status "$state"
  set_instance_metadata_value vm-sunshine-status-detail "$detail"
}

instance_name() {
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/instance/name"
}

project_id() {
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/project/project-id"
}

zone_name() {
  local zone
  zone="$(curl "${METADATA_HDR[@]}" "http://metadata/computeMetadata/v1/instance/zone")"
  printf '%s\n' "${zone##*/}"
}

install_persist_script() {
  local payload
  local target=/usr/local/bin/vm-persist-state
  payload="$(metadata_get vm-persist-script)"
  [[ -n "$payload" ]] || return 0
  install -d -m 0755 "$(dirname "$target")"
  printf '%s\n' "$payload" > "$target"
  chmod 0755 "$target"
}

sync_env_metadata() {
  local token project zone name instance_json fingerprint items items_file env_file payload payload_file
  token="$(metadata_token || true)"
  project="$(project_id || true)"
  zone="$(zone_name || true)"
  name="$(instance_name || true)"
  [[ -n "$token" && -n "$project" && -n "$zone" && -n "$name" ]] || return 0

  instance_json="$(curl --fail --silent --show-error \
    -H "Authorization: Bearer ${token}" \
    "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}" || true)"
  [[ -n "$instance_json" ]] || return 0
  fingerprint="$(printf '%s' "$instance_json" | jq -r '.metadata.fingerprint // empty')"
  [[ -n "$fingerprint" ]] || return 0
  items="$(printf '%s' "$instance_json" | jq '[.metadata.items // [] | .[] | select(.key != "steam-headless-env")]')"
  items_file="$(mktemp)"
  env_file="$(mktemp)"
  printf '%s' "$items" > "$items_file"
  cat "$ENVF" > "$env_file"
  payload="$(jq -n \
    --arg fingerprint "$fingerprint" \
    --rawfile env_value "$env_file" \
    --slurpfile items "$items_file" \
    '{fingerprint: $fingerprint, items: ($items[0] + [{key: "steam-headless-env", value: $env_value}])}')"
  rm -f "$items_file" "$env_file"
  payload_file="$(mktemp)"
  printf '%s' "$payload" > "$payload_file"

  curl --fail --silent --show-error \
    -X POST \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    --data-binary "@${payload_file}" \
    "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}/setMetadata" >/dev/null || true
  rm -f "$payload_file"
}
wait_for_apt_idle
apt-get update -y
set_sunshine_status "starting" "VM setup in progress."
apt-get install -y ca-certificates curl gnupg lsb-release python3 ubuntu-drivers-common jq zstd rclone

GPU_TYPE="$(metadata_get vm-gpu-type || true)"
case "$GPU_TYPE" in
  nvidia-tesla-t4-vws|nvidia-l4-vws)
    VWS_MARKER=/var/lib/steam-headless-gce/nvidia-vws-driver-installing
    VWS_INSTALLER=/opt/google/cuda-installer/cuda_installer.pyz
    mkdir -p "$(dirname "$VWS_MARKER")" "$(dirname "$VWS_INSTALLER")"
    if [[ -f "$VWS_MARKER" ]]; then
      for _ in $(seq 1 180); do
        if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
          rm -f "$VWS_MARKER"
          break
        fi
        sleep 2
      done
      [[ ! -f "$VWS_MARKER" ]] || { set_sunshine_status "error" "NVIDIA RTX vWS driver did not become ready after reboot."; exit 1; }
    elif [[ ! -f "$VWS_MARKER" ]]; then
      touch "$VWS_MARKER"
      curl -fsSL https://storage.googleapis.com/compute-gpu-installation-us/installer/latest/cuda_installer.pyz -o "$VWS_INSTALLER"
      chmod 0755 "$VWS_INSTALLER"
      if command -v nvidia-smi >/dev/null 2>&1; then
        python3 "$VWS_INSTALLER" uninstall_driver || true
        VWS_GENERIC_PACKAGES="$(dpkg-query -W -f='${db:Status-Status} ${binary:Package}\n' \
          'nvidia-driver-*' 'nvidia-dkms-*' 'nvidia-utils-*' 'nvidia-compute-utils-*' \
          'nvidia-kernel-common-*' 'nvidia-kernel-source-*' 'nvidia-firmware-*' 2>/dev/null | \
          awk '$1 == "installed" {print $2}')"
        [[ -z "$VWS_GENERIC_PACKAGES" ]] || apt-get purge -y $VWS_GENERIC_PACKAGES
      fi
      python3 "$VWS_INSTALLER" install_driver --installation-mode=binary --installation-branch=lts
      echo "Rebooting to activate the NVIDIA RTX vWS driver"
      reboot || true
      exit 0
    fi
    ;;
  *)
    if ! command -v nvidia-smi >/dev/null 2>&1; then
      ubuntu-drivers autoinstall || true
      echo "Rebooting to load NVIDIA driver"
      reboot || true
      exit 0
    fi
    ;;
esac

# Docker Engine + compose plugin
install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi
codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${codename} stable" \
  > /etc/apt/sources.list.d/docker.list
wait_for_apt_idle
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# NVIDIA Container Toolkit
if [ ! -f /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg ]; then
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
    gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
fi
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#' \
  > /etc/apt/sources.list.d/nvidia-container-toolkit.list
wait_for_apt_idle
apt-get update -y
apt-get install -y nvidia-container-toolkit
nvidia-ctk runtime configure --runtime=docker || true
systemctl restart docker

# Kernel modules needed by container
modprobe uinput || true
modprobe fuse || true
echo uinput > /etc/modules-load.d/uinput.conf

# Prepare host paths and compose
install -d -m 0755 /opt/container-services/steam-headless
install -d -m 0755 /opt/container-data/steam-headless/home
install -d -m 0755 /opt/container-data/steam-headless/sockets/.X11-unix
install -d -m 0755 /opt/container-data/steam-headless/sockets/pulse
install -d -m 0777 /mnt/games || true
install_persist_script

COMPOSE_BASE=/opt/container-services/steam-headless/docker-compose.nvidia.privileged.yml
COMPOSE_GCE=/opt/container-services/steam-headless/docker-compose.nvidia.privileged.gce.yml
COMPOSE_OVERRIDE=/opt/container-services/steam-headless/docker-compose.nvidia.privileged.override.yml
COMPOSE_IMAGE_OVERRIDE=/opt/container-services/steam-headless/docker-compose.image.override.yml
curl -fsSL \
  https://raw.githubusercontent.com/Steam-Headless/docker-steam-headless/master/docs/compose-files/docker-compose.nvidia.privileged.yml \
  -o "$COMPOSE_BASE"
cp -f "$COMPOSE_BASE" "$COMPOSE_GCE"
sed -i 's#/dev/input/:/dev/input/:ro#/dev/input/:/dev/input/:rw#' "$COMPOSE_GCE" || true
if [ ! -f "$COMPOSE_OVERRIDE" ]; then
  cat > "$COMPOSE_OVERRIDE" <<'EOF'
---
version: "3.8"

services:
  steam-headless:
    environment:
      - DISPLAY_SIZEW=${DISPLAY_SIZEW}
      - DISPLAY_SIZEH=${DISPLAY_SIZEH}
      - DISPLAY_REFRESH=${DISPLAY_REFRESH}
      - DISPLAY_CDEPTH=${DISPLAY_CDEPTH}
EOF
fi
COMPOSE_FILES=(-f "$COMPOSE_GCE")
if [ -f "$COMPOSE_OVERRIDE" ]; then
  COMPOSE_FILES+=(-f "$COMPOSE_OVERRIDE")
fi

# Environment
ENVF=/opt/container-services/steam-headless/.env
ENV_METADATA="$(metadata_get_with_retry_instance steam-headless-env 20)"
if [[ -z "$ENV_METADATA" ]]; then
  ENV_METADATA="$(metadata_get_with_retry steam-headless-env 20)"
fi
ENV_METADATA="$(normalize_metadata_value "$ENV_METADATA")"
if [ -n "$ENV_METADATA" ]; then
  printf '%s\n' "$ENV_METADATA" > "$ENVF"
elif [ ! -f "$ENVF" ]; then
  if ! curl -fsSL \
    https://raw.githubusercontent.com/Steam-Headless/docker-steam-headless/master/docs/compose-files/.env.example \
    -o "$ENVF"; then
    curl -fsSL \
      https://raw.githubusercontent.com/Steam-Headless/docker-steam-headless/master/docs/compose-files/.env \
      -o "$ENVF"
  fi
  sed -i -E 's#^USER_PASSWORD=password$#USER_PASSWORD=change-me#' "$ENVF" || true
  sed -i -E 's#^SUNSHINE_PASS=admin$#SUNSHINE_PASS=change-me#' "$ENVF" || true
fi
ensure_env_key_missing() {
  local key="$1"
  local value="$2"
  grep -q "^${key}=" "$ENVF" || echo "${key}=${value}" >> "$ENVF"
}

set_env_value() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENVF"; then
    awk -v key="$key" -v value="$value" 'BEGIN{replaced=0} $0 ~ "^" key "=" {if (!replaced) print key "=" value; replaced=1; next} {print} END{if (!replaced) print key "=" value}' "$ENVF" > "${ENVF}.tmp"
    mv "${ENVF}.tmp" "$ENVF"
  else
    echo "${key}=${value}" >> "$ENVF"
  fi
}

generate_runtime_password() {
  od -An -N12 -tx1 /dev/urandom | tr -d ' \n'
}

ensure_sunshine_credentials() {
  local current_pass
  set_env_value SUNSHINE_USER "admin"
  current_pass="$(awk -F= '/^SUNSHINE_PASS=/{print substr($0,index($0,"=")+1)}' "$ENVF" | tail -n1)"
  if [ -z "$current_pass" ] || [ "$current_pass" = "change-me" ]; then
    set_env_value SUNSHINE_PASS "$(generate_runtime_password)"
    echo "[remote-setup] Generated runtime Sunshine password"
  fi
}

apply_sunshine_state_credentials() {
  local user pass container_id attempts
  attempts=0
  user="$(awk -F= '/^SUNSHINE_USER=/{print substr($0,index($0,"=")+1)}' "$ENVF" | tail -n1)"
  pass="$(awk -F= '/^SUNSHINE_PASS=/{print substr($0,index($0,"=")+1)}' "$ENVF" | tail -n1)"
  if [ -z "$user" ] || [ -z "$pass" ]; then
    return 0
  fi

  while (( attempts < 20 )); do
    attempts=$((attempts + 1))
    container_id="$(docker compose "${COMPOSE_FILES[@]}" ps -q | head -n 1 || true)"
    if [ -n "$container_id" ]; then
      if docker exec "$container_id" which sunshine >/dev/null 2>&1; then
        if docker exec "$container_id" sunshine --creds "$user" "$pass" >/dev/null 2>&1; then
          return 0
        fi
      fi
    fi
    sleep 2
  done
}

ensure_env_key_missing ENABLE_SUNSHINE "true"
ensure_env_key_missing STEAM_HEADLESS_IMAGE "josh5/steam-headless:debian-dev-frontend-revamp"
ensure_env_key_missing SUNSHINE_USER "admin"
ensure_env_key_missing SUNSHINE_PASS "change-me"
set_env_value ENABLE_EVDEV_INPUTS "true"
ensure_env_key_missing FORCE_X11_DUMMY_CONFIG "true"
ensure_env_key_missing DISPLAY_SIZEW "1920"
ensure_env_key_missing DISPLAY_SIZEH "1080"
ensure_env_key_missing DISPLAY_REFRESH "60"
ensure_env_key_missing DISPLAY_CDEPTH "24"
ensure_sunshine_credentials
chmod 600 "$ENVF"
sync_env_metadata

STEAM_HEADLESS_IMAGE_VALUE="$(awk -F= '/^STEAM_HEADLESS_IMAGE=/{print substr($0,index($0,"=")+1)}' "$ENVF" | tail -n1)"
STEAM_HEADLESS_IMAGE_VALUE="${STEAM_HEADLESS_IMAGE_VALUE:-josh5/steam-headless:debian-dev-frontend-revamp}"
cat > "$COMPOSE_IMAGE_OVERRIDE" <<EOF
---
version: "3.8"

services:
  steam-headless:
    image: ${STEAM_HEADLESS_IMAGE_VALUE}
EOF
COMPOSE_FILES+=(-f "$COMPOSE_IMAGE_OVERRIDE")

if [ -x /usr/local/bin/vm-persist-state ]; then
  /usr/local/bin/vm-persist-state restore || echo "[remote-setup] State restore skipped or failed"
fi

CFG_HOST="/opt/container-data/steam-headless/home/.config/sunshine/sunshine.conf"
mkdir -p "$(dirname "$CFG_HOST")"
touch "$CFG_HOST"
sed -i -E \
  -e '/origin_web_ui_allowed\s*=.*/d' \
  -e '/origin_pin_allowed\s*=.*/d' \
  -e '/external_ip\s*=.*/d' \
  "$CFG_HOST" || true
{
  echo
  echo "origin_web_ui_allowed = wan"
  echo "origin_pin_allowed = wan"
  if [ -n "$EXT_IP" ]; then
    echo "external_ip = $EXT_IP"
  fi
} >> "$CFG_HOST"

docker compose "${COMPOSE_FILES[@]}" up -d --force-recreate
docker compose "${COMPOSE_FILES[@]}" restart || true
apply_sunshine_state_credentials

sunshine_http_code=""
for _ in $(seq 1 60); do
  sunshine_http_code="$(curl -k --silent --output /dev/null --write-out '%{http_code}' --max-time 5 https://127.0.0.1:47990/ || true)"
  if [[ "$sunshine_http_code" == "200" || "$sunshine_http_code" == "401" || "$sunshine_http_code" == "403" ]]; then
    set_sunshine_status "ready" "Sunshine Web UI responded with HTTP ${sunshine_http_code}."
    break
  fi
  sleep 2
done

if [[ "$sunshine_http_code" != "200" && "$sunshine_http_code" != "401" && "$sunshine_http_code" != "403" ]]; then
  set_sunshine_status "starting" "VM is running, but Sunshine Web UI is still warming up."
fi
docker exec -i $(docker ps -qf name=steam-headless) nvidia-smi || true
ss -lntup | egrep '(8083|47989|47990|48010)' || true
