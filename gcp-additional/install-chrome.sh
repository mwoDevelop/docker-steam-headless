#!/usr/bin/env bash
set -euo pipefail

render_chrome_default_browser() {
  cat <<'VM_CHROME_DEFAULT'
#!/usr/bin/env bash
set -euo pipefail
# Runs as the desktop user, after upstream desktop initialization.
export XDG_DATA_DIRS="$HOME/.local/share/flatpak/exports/share:/var/lib/flatpak/exports/share:/usr/local/share:/usr/share"
python3 - <<'PY_BROWSER'
import configparser
import os
from pathlib import Path
import tempfile

user_home = Path.home()
data = Path(os.environ.get("XDG_DATA_HOME") or user_home / ".local/share")
config = Path(os.environ.get("XDG_CONFIG_HOME") or user_home / ".config")
desktop = "com.google.Chrome.desktop"
if not (data / "flatpak/exports/share/applications" / desktop).is_file():
    print("Chrome is not installed; browser preferences unchanged.")
    raise SystemExit(0)

def write_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".vm-browser-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(text)
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def update_ini(path, section, settings):
    value = configparser.ConfigParser(interpolation=None, strict=False)
    value.optionxform = str
    if path.exists():
        value.read(path)
    if not value.has_section(section):
        value.add_section(section)
    for key, content in settings.items():
        value.set(section, key, content)
    import io
    buffer = io.StringIO()
    value.write(buffer, space_around_delimiters=False)
    write_text(path, buffer.getvalue())

mimes = ("x-scheme-handler/http", "x-scheme-handler/https", "text/html", "application/xhtml+xml")
# Desktop-specific entries take precedence over generic mimeapps.list.
for name in ("mimeapps.list", "xfce-mimeapps.list"):
    update_ini(config / name, "Default Applications", {mime: desktop for mime in mimes})
# XfceRc reads helpers from its ungrouped section, not an INI [Helpers] group.
helpers = config / "xfce4/helpers.rc"
lines = helpers.read_text().splitlines() if helpers.exists() else []
lines = [line for line in lines
         if line.partition("=")[0].strip() != "WebBrowser"
         and line.strip() != "[Helpers]"]
write_text(helpers, "WebBrowser=com.google.Chrome\n" + "\n".join(lines) + ("\n" if lines else ""))
write_text(data / "xfce4/helpers" / desktop, """[Desktop Entry]
NoDisplay=true
Version=1.0
Type=X-XFCE-Helper
X-XFCE-Category=WebBrowser
Name=Google Chrome
Icon=com.google.Chrome
X-XFCE-Commands=/usr/bin/flatpak run com.google.Chrome//stable --no-first-run --password-store=basic
X-XFCE-CommandsWithParameter=/usr/bin/flatpak run com.google.Chrome//stable --no-first-run --password-store=basic "%s"
""")
print("Chrome configured as the default browser (MIME and XFCE).")
PY_BROWSER
VM_CHROME_DEFAULT
}

configure_chrome_default_browser() {
  # Keep the helper and autostart entry on the persistent user home too.
  sudo -u default env HOME=/home/default VM_CHROME_DEFAULT_SCRIPT="$VM_CHROME_DEFAULT_SCRIPT" bash -s <<'CONFIGURE_BROWSER'
set -euo pipefail
mkdir -p "$HOME/.local/bin" "$HOME/.config/autostart"
printf '%s\n' "$VM_CHROME_DEFAULT_SCRIPT" > "$HOME/.local/bin/vm-chrome-default"
chmod 0755 "$HOME/.local/bin/vm-chrome-default"
cat > "$HOME/.config/autostart/vm-chrome-default.desktop" <<'AUTOSTART'
[Desktop Entry]
Type=Application
Name=VM browser preferences
Exec=/bin/bash /home/default/.local/bin/vm-chrome-default
NoDisplay=true
Terminal=false
AUTOSTART
"$HOME/.local/bin/vm-chrome-default"
for mime in x-scheme-handler/http x-scheme-handler/https text/html application/xhtml+xml; do
  actual="$(XDG_DATA_DIRS="$HOME/.local/share/flatpak/exports/share:/var/lib/flatpak/exports/share:/usr/local/share:/usr/share" xdg-mime query default "$mime")"
  [[ "$actual" == "com.google.Chrome.desktop" ]] || {
    echo "Failed to configure Chrome for $mime." >&2
    exit 1
  }
done
CONFIGURE_BROWSER
}


log() { echo "[install-chrome] $*"; }

if [[ "${1:-}" == "--print-browser-helper" ]]; then
  render_chrome_default_browser
  exit 0
fi
export VM_CHROME_DEFAULT_SCRIPT="$(render_chrome_default_browser)"

run_payload() {
set -euo pipefail

install -d -m 0755 -o default -g default /home/default /home/default/.local /home/default/.var /home/default/.config
if ! command -v flatpak >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y flatpak
fi
sudo -u default env HOME=/home/default flatpak --user remote-add --if-not-exists flathub \
  https://flathub.org/repo/flathub.flatpakrepo || true
sudo -u default env HOME=/home/default flatpak --user install -y flathub com.google.Chrome
configure_chrome_default_browser

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
        "/usr/bin/flatpak run com.google.Chrome//stable --no-first-run --password-store=basic"
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
}

run_in_docker() {
  local docker_bin="$1" container_id="$2"
  {
    printf "set -euo pipefail\n"
    declare -f configure_chrome_default_browser run_payload
    printf "run_payload\n"
  } | "$docker_bin" exec -i --env VM_CHROME_DEFAULT_SCRIPT="$VM_CHROME_DEFAULT_SCRIPT" "$container_id" bash -s
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
