#!/usr/bin/env bash
set -euo pipefail
ENV=/opt/container-services/steam-headless/.env
SUNPASS=${1:-}
if [[ -z "$SUNPASS" ]]; then
  SUNPASS=$(python3 - <<"PY"
import secrets,string
alph=string.ascii_letters+string.digits+"!@#%^&*"
print("".join(secrets.choice(alph) for _ in range(20)))
PY
)
fi
# Toggle Sunshine in .env
sed -i -E "s/^(ENABLE_SUNSHINE)=.*/\1=true/" "$ENV" || true
sed -i -E "s/^(FORCE_X11_DUMMY_CONFIG)=.*/\1=true/" "$ENV" || true
sed -i -E "s/^(NVIDIA_DRIVER_CAPABILITIES)=.*/\1=all/" "$ENV" || true
grep -q ^SUNSHINE_USER= "$ENV" && sed -i -E "s/^(SUNSHINE_USER)=.*/\1=admin/" "$ENV" || echo SUNSHINE_USER=admin >> "$ENV"
grep -q ^SUNSHINE_PASS= "$ENV" && sed -i -E "s/^(SUNSHINE_PASS)=.*/\1=${SUNPASS}/" "$ENV" || echo SUNSHINE_PASS=${SUNPASS} >> "$ENV"

cd /opt/container-services/steam-headless
COMPOSE_GCE=/opt/container-services/steam-headless/docker-compose.nvidia.privileged.gce.yml
COMPOSE_BASE=/opt/container-services/steam-headless/docker-compose.nvidia.privileged.yml
COMPOSE_OVERRIDE=/opt/container-services/steam-headless/docker-compose.nvidia.privileged.override.yml
COMPOSE="$COMPOSE_GCE"
if [[ ! -f "$COMPOSE" ]]; then
  COMPOSE="$COMPOSE_BASE"
fi
COMPOSE_ARGS=(-f "$COMPOSE")
if [[ -f "$COMPOSE_OVERRIDE" ]]; then
  COMPOSE_ARGS+=(-f "$COMPOSE_OVERRIDE")
fi
# Ensure running
sudo docker compose "${COMPOSE_ARGS[@]}" up -d || true
sleep 2
CFG=/opt/container-data/steam-headless/home/.config/sunshine/sunshine.conf
if [[ -f "$CFG" ]]; then
  sed -i -E "/origin_web_ui_allowed/d" "$CFG"
  echo >> "$CFG"
  echo "origin_web_ui_allowed = wan" >> "$CFG"
  sed -i -E "/origin_pin_allowed/d" "$CFG"
  echo "origin_pin_allowed = wan" >> "$CFG"
fi
# Restart container to pick up config
sudo docker compose "${COMPOSE_ARGS[@]}" restart || true
sleep 2
sudo ss -lntup | egrep "(47990|47989|48010|8083)" || true
# Print pass
printf "SUNSHINE_USER=admin\nSUNSHINE_PASS=%s\n" "$SUNPASS"
