#!/usr/bin/env bash
set -euo pipefail

# Installs PrismLauncher and adds it to Sunshine applications.
# Supports:
# - VM host mode (finds and uses running steam-headless Docker container)
# - In-container mode (run directly via kubectl exec in gamerX pods)

log() { echo "[install-prism] $*"; }

run_payload() {
  bash -s <<'PAYLOAD'
set -euo pipefail

install -d -m 0755 -o default -g default /home/default
install -d -m 0755 -o default -g default /home/default/.local
install -d -m 0755 -o default -g default /home/default/.var
install -d -m 0755 -o default -g default /home/default/.config

if ! command -v flatpak >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y flatpak
fi

sudo -u default env HOME=/home/default flatpak --user remote-add --if-not-exists flathub \
  https://flathub.org/repo/flathub.flatpakrepo || true

if ! sudo -u default env HOME=/home/default flatpak --user info org.prismlauncher.PrismLauncher >/dev/null 2>&1; then
  sudo -u default env HOME=/home/default flatpak --user install -y flathub org.prismlauncher.PrismLauncher
fi

apps_file=/home/default/.config/sunshine/apps.json
mkdir -p "$(dirname "$apps_file")"
[ -s "$apps_file" ] || echo "{\"apps\":[]}" > "$apps_file"

python3 - "$apps_file" <<PY
import json, sys
path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    data = {}
apps = list(data.get("apps") or [])
new_entry = {
    "name": "PrismLauncher",
    "exclude-global-prep-cmd": "true",
    "detached": [
        "/usr/bin/flatpak run org.prismlauncher.PrismLauncher//stable"
    ],
    "prep-cmd": [
        {"do": "", "undo": "/usr/bin/sunshine-stop"},
        {"do": "", "undo": "/usr/bin/xfce4-close-all-windows"}
    ]
}
replaced = False
for index, app in enumerate(apps):
    if app.get("name") == "PrismLauncher":
        apps[index] = new_entry
        replaced = True
        break
if not replaced:
    apps.append(new_entry)
data["apps"] = apps
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f)
print("UPDATED")
PY

supervisorctl restart sunshine || true
PAYLOAD
}

run_in_docker() {
  local docker_bin="$1"
  local container_id="$2"
  "$docker_bin" exec -i "$container_id" bash -s <<'PAYLOAD'
set -euo pipefail

install -d -m 0755 -o default -g default /home/default
install -d -m 0755 -o default -g default /home/default/.local
install -d -m 0755 -o default -g default /home/default/.var
install -d -m 0755 -o default -g default /home/default/.config

if ! command -v flatpak >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y flatpak
fi

sudo -u default env HOME=/home/default flatpak --user remote-add --if-not-exists flathub \
  https://flathub.org/repo/flathub.flatpakrepo || true

if ! sudo -u default env HOME=/home/default flatpak --user info org.prismlauncher.PrismLauncher >/dev/null 2>&1; then
  sudo -u default env HOME=/home/default flatpak --user install -y flathub org.prismlauncher.PrismLauncher
fi

apps_file=/home/default/.config/sunshine/apps.json
mkdir -p "$(dirname "$apps_file")"
[ -s "$apps_file" ] || echo "{\"apps\":[]}" > "$apps_file"

python3 - "$apps_file" <<PY
import json, sys
path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    data = {}
apps = list(data.get("apps") or [])
new_entry = {
    "name": "PrismLauncher",
    "exclude-global-prep-cmd": "true",
    "detached": [
        "/usr/bin/flatpak run org.prismlauncher.PrismLauncher//stable"
    ],
    "prep-cmd": [
        {"do": "", "undo": "/usr/bin/sunshine-stop"},
        {"do": "", "undo": "/usr/bin/xfce4-close-all-windows"}
    ]
}
replaced = False
for index, app in enumerate(apps):
    if app.get("name") == "PrismLauncher":
        apps[index] = new_entry
        replaced = True
        break
if not replaced:
    apps.append(new_entry)
data["apps"] = apps
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f)
print("UPDATED")
PY

supervisorctl restart sunshine || true
PAYLOAD
}

in_container_env() {
  [[ -f "/.dockerenv" || -f "/run/.containerenv" || -d "/home/default" ]]
}

docker_bin=$(command -v docker || true)
if [[ -z "$docker_bin" && -x /usr/bin/docker ]]; then
  docker_bin=/usr/bin/docker
fi

if [[ -n "$docker_bin" ]]; then
  container_id=$("$docker_bin" ps -qf name=steam-headless | head -n1 || true)
  if [[ -n "$container_id" ]]; then
    log "Using container: $container_id"
    run_in_docker "$docker_bin" "$container_id"
    log "Done"
    exit 0
  fi
fi

if in_container_env; then
  log "Running directly in current container"
  run_payload
  log "Done"
  exit 0
fi

log "steam-headless container not found and not running inside a container context"
exit 1
