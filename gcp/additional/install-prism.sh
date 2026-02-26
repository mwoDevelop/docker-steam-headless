#!/usr/bin/env bash
set -euo pipefail

# Installs PrismLauncher inside the running steam-headless container
# and makes sure it appears in Sunshine applications.
# Idempotent: safe to run multiple times.

log() { echo "[install-prism] $*"; }

docker_bin=$(command -v docker || true)
if [ -z "$docker_bin" ] && [ -x /usr/bin/docker ]; then
  docker_bin=/usr/bin/docker
fi
if [ -z "$docker_bin" ]; then
  log "docker not found on host; run provisioning first (startup.sh / remote-setup.sh)"
  exit 1
fi

container_id=$("$docker_bin" ps -qf name=steam-headless | head -n1 || true)
if [ -z "$container_id" ]; then
  log "steam-headless container is not running"
  exit 1
fi

log "Using container: $container_id"

"$docker_bin" exec "$container_id" bash -lc '
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
'

log "Done"
