#!/usr/bin/env bash
set -euo pipefail

# Installs Google Chrome inside the running steam-headless container
# and makes sure it appears in Sunshine applications.
# Idempotent: safe to run multiple times.

log() { echo "[install-chrome] $*"; }

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

if ! command -v google-chrome >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y wget gnupg ca-certificates
  install -d -m 0755 /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/google-chrome.gpg ]; then
    wget -qO- https://dl.google.com/linux/linux_signing_key.pub | \
      gpg --dearmor > /etc/apt/keyrings/google-chrome.gpg
  fi
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -y
  apt-get install -y google-chrome-stable
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
    "name": "Google Chrome",
    "exclude-global-prep-cmd": "true",
    "detached": [
        "/usr/bin/google-chrome-stable --no-first-run --password-store=basic"
    ],
    "prep-cmd": [
        {"do": "", "undo": "/usr/bin/sunshine-stop"},
        {"do": "", "undo": "/usr/bin/xfce4-close-all-windows"}
    ]
}
replaced = False
for index, app in enumerate(apps):
    if app.get("name") == "Google Chrome":
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
