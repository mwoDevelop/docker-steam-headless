#!/usr/bin/env bash
set -euo pipefail

# Control a GCE VM and keep firewall pinned to your current public IP.
#
# Usage:
#   vm-ctl.sh up [1h]  # start instance; optional auto-shutdown after duration
#   vm-ctl.sh down     # stop instance
#   vm-ctl.sh destroy  # stop and delete VM instance
#   vm-ctl.sh allow    # update firewall to your current IP/32
#   vm-ctl.sh open     # set firewall to 0.0.0.0/0 (not recommended)
#   vm-ctl.sh status   # print VM status and external IP
#   vm-ctl.sh ip       # print your current public IP (detected)
#   vm-ctl.sh install help    # list install targets
#   vm-ctl.sh install prism   # install PrismLauncher in container
#   vm-ctl.sh install chrome  # install Chrome in container
#
# Config file: gcp/.env (copy from gcp/.env.example)
# Duration format for "up": <number><unit>, where unit is s|m|h|d.

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")"/.. && pwd)
CFG_FILE="${ROOT_DIR}/gcp/.env"
if [[ -f "$CFG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CFG_FILE"
fi

GCP_PROJECT=${GCP_PROJECT:-}
GCP_ZONE=${GCP_ZONE:-europe-central2-b}
GCE_NAME=${GCE_NAME:-steam-gpu}
FW_RULE_WEB=${FW_RULE_WEB:-allow-steam-headless-web}
FW_RULE_SUN=${FW_RULE_SUN:-allow-sunshine}
FW_TAGS=${FW_TAGS:-steam-headless}
FW_NET=${FW_NET:-default}
DUCKDNS_DOMAINS=${DUCKDNS_DOMAINS:-${DUCKDNS_DOMAIN:-}}
DUCKDNS_TOKEN=${DUCKDNS_TOKEN:-}

ALLOW_WEB_PORTS=${ALLOW_WEB_PORTS:-tcp:22,tcp:8083}
ALLOW_SUN_PORTS=${ALLOW_SUN_PORTS:-tcp:47984,tcp:47989,tcp:47990,tcp:48010,udp:47998,udp:47999,udp:48000,udp:48002}

log(){ printf '%s [vm-ctl] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
err(){ log "ERROR: $*" >&2; exit 1; }
is_help_arg(){ [[ "${1:-}" == "help" ]]; }

ensure_project() {
  [[ -n "$GCP_PROJECT" ]] || err "GCP_PROJECT is empty. Set it in gcp/.env (copy from gcp/.env.example)."
  gcloud config set project "$GCP_PROJECT" >/dev/null 2>&1 || true
}

# Helpers to improve UX locally (open browser / copy clipboard)
open_local(){
  # disabled: do not auto-open Sunshine URL
  return 0
}


copy_clip(){
  local text="$1"
  if [ "${VMCTL_NO_CLIP:-0}" = "1" ]; then return 0; fi
  if command -v pbcopy >/dev/null 2>&1; then printf '%s' "$text" | pbcopy 2>/dev/null || true; return 0; fi
  if command -v xclip >/dev/null 2>&1; then printf '%s' "$text" | xclip -selection clipboard 2>/dev/null || true; return 0; fi
  if command -v xsel  >/dev/null 2>&1; then printf '%s' "$text" | xsel --clipboard --input 2>/dev/null || true; return 0; fi
  if command -v wl-copy >/dev/null 2>&1; then printf '%s' "$text" | wl-copy 2>/dev/null || true; return 0; fi
  if command -v clip.exe >/dev/null 2>&1; then printf '%s' "$text" | clip.exe 2>/dev/null || true; return 0; fi
}

get_my_ip(){
  for url in \
    'https://api.ipify.org' \
    'https://ifconfig.me' \
    'https://icanhazip.com' \
    'https://checkip.amazonaws.com'; do
    ip=$(curl -fsS "$url" 2>/dev/null | tr -d '\n\r' || true)
    if [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then echo -n "$ip"; return 0; fi
  done
  # Fallback via DNS
  ip=$(dig +short myip.opendns.com @resolver1.opendns.com 2>/dev/null | tr -d '\n\r' || true)
  [[ -n "$ip" ]] && echo -n "$ip" || return 1
}

duckdns_domains_api() {
  local raw="${DUCKDNS_DOMAINS:-}"
  local cleaned
  local value
  local out=()
  cleaned="${raw// /}"
  cleaned="${cleaned#,}"
  cleaned="${cleaned%,}"
  [[ -n "$cleaned" ]] || return 0
  IFS=',' read -r -a items <<< "$cleaned"
  for value in "${items[@]}"; do
    [[ -n "$value" ]] || continue
    value="${value%.duckdns.org}"
    value="${value#https://}"
    value="${value#http://}"
    value="${value%%/*}"
    value="${value%%:*}"
    [[ -n "$value" ]] || continue
    out+=("$value")
  done
  (IFS=','; printf '%s' "${out[*]}")
}

duckdns_domains_fqdn() {
  local value
  local domains
  domains="$(duckdns_domains_api || true)"
  [[ -n "$domains" ]] || return 0
  IFS=',' read -r -a items <<< "$domains"
  for value in "${items[@]}"; do
    [[ -n "$value" ]] || continue
    printf '%s.duckdns.org\n' "$value"
  done
}

update_duckdns() {
  local ip="$1"
  local domains
  local resp
  if [[ -z "$DUCKDNS_TOKEN" ]]; then
    log "DuckDNS token not set; skipping DNS update"
    return 1
  fi
  domains="$(duckdns_domains_api || true)"
  if [[ -z "$domains" ]]; then
    log "DuckDNS domains not set; skipping DNS update"
    return 1
  fi
  resp=$(curl -fsS --max-time 15 \
    "https://www.duckdns.org/update?domains=${domains}&token=${DUCKDNS_TOKEN}&ip=${ip}" \
    2>/dev/null || true)
  if [[ "$resp" == "OK" ]]; then
    log "DuckDNS updated for: ${domains}"
    return 0
  fi
  log "WARN: DuckDNS update failed (response: ${resp:-<empty>})"
  return 1
}

ensure_firewall(){
  if ! gcloud compute firewall-rules describe "$FW_RULE_WEB" --project "$GCP_PROJECT" >/dev/null 2>&1; then
    log "Creating firewall $FW_RULE_WEB"
    gcloud compute firewall-rules create "$FW_RULE_WEB" \
      --project "$GCP_PROJECT" --network="$FW_NET" \
      --allow="$ALLOW_WEB_PORTS" --target-tags="$FW_TAGS" \
      --source-ranges=0.0.0.0/0 >/dev/null
  fi
  if ! gcloud compute firewall-rules describe "$FW_RULE_SUN" --project "$GCP_PROJECT" >/dev/null 2>&1; then
    log "Creating firewall $FW_RULE_SUN"
    gcloud compute firewall-rules create "$FW_RULE_SUN" \
      --project "$GCP_PROJECT" --network="$FW_NET" \
      --allow="$ALLOW_SUN_PORTS" --target-tags="$FW_TAGS" \
      --source-ranges=0.0.0.0/0 >/dev/null
  fi
}

update_firewall_to(){
  local cidr="$1"
  log "Updating firewall source-ranges to ${cidr}"
  gcloud compute firewall-rules update "$FW_RULE_WEB" \
    --project "$GCP_PROJECT" --allow="$ALLOW_WEB_PORTS" \
    --target-tags="$FW_TAGS" --source-ranges="$cidr" >/dev/null || true
  gcloud compute firewall-rules update "$FW_RULE_SUN" \
    --project "$GCP_PROJECT" --allow="$ALLOW_SUN_PORTS" \
    --target-tags="$FW_TAGS" --source-ranges="$cidr" >/dev/null || true
}

get_vm_ip(){
  gcloud compute instances describe "$GCE_NAME" --zone="$GCP_ZONE" \
    --format='value(networkInterfaces[0].accessConfigs[0].natIP)'
}

wait_running(){
  local t=0; local st
  while :; do
    st=$(gcloud compute instances describe "$GCE_NAME" --zone="$GCP_ZONE" --format='value(status)' 2>/dev/null || true)
    [[ "$st" == "RUNNING" ]] && return 0
    (( t+=2 )); (( t>120 )) && err "VM did not become RUNNING in time"
    sleep 2
  done
}

wait_for_ssh() {
  local timeout_sec="${1:-300}"
  local waited=0
  local st
  while (( waited < timeout_sec )); do
    st=$(gcloud compute instances describe "$GCE_NAME" --zone="$GCP_ZONE" --format='value(status)' 2>/dev/null || true)
    if [[ "$st" == "RUNNING" ]]; then
      if gcloud compute ssh "$GCE_NAME" --zone="$GCP_ZONE" \
        --ssh-flag='-o ConnectTimeout=8' \
        --command 'echo SSH_OK' >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 5
    (( waited += 5 ))
  done
  return 1
}

AUTO_SHUTDOWN_RAW=""
AUTO_SHUTDOWN_SECONDS=0
AUTO_SHUTDOWN_SYSTEMD=""

parse_up_duration() {
  local raw="$1"
  local value unit
  [[ "$raw" =~ ^([0-9]+)([smhd])$ ]] || return 1
  value="${BASH_REMATCH[1]}"
  unit="${BASH_REMATCH[2]}"

  case "$unit" in
    s)
      AUTO_SHUTDOWN_SECONDS=$(( value ))
      AUTO_SHUTDOWN_SYSTEMD="${value}s"
      ;;
    m)
      AUTO_SHUTDOWN_SECONDS=$(( value * 60 ))
      AUTO_SHUTDOWN_SYSTEMD="${value}min"
      ;;
    h)
      AUTO_SHUTDOWN_SECONDS=$(( value * 3600 ))
      AUTO_SHUTDOWN_SYSTEMD="${value}h"
      ;;
    d)
      AUTO_SHUTDOWN_SECONDS=$(( value * 86400 ))
      AUTO_SHUTDOWN_SYSTEMD="${value}d"
      ;;
    *)
      return 1
      ;;
  esac

  (( AUTO_SHUTDOWN_SECONDS > 0 )) || return 1
  AUTO_SHUTDOWN_RAW="$raw"
  return 0
}

schedule_auto_shutdown() {
  local next_at=""
  local ssh_cmd

  if [[ -z "$AUTO_SHUTDOWN_RAW" || -z "$AUTO_SHUTDOWN_SYSTEMD" ]]; then
    return 0
  fi

  if ! wait_for_ssh 300; then
    log "WARN: SSH not ready; auto-shutdown (${AUTO_SHUTDOWN_RAW}) not scheduled"
    return 1
  fi

  ssh_cmd="sudo systemctl stop vm-ctl-auto-shutdown.timer vm-ctl-auto-shutdown.service >/dev/null 2>&1 || true; \
sudo systemctl reset-failed vm-ctl-auto-shutdown.timer vm-ctl-auto-shutdown.service >/dev/null 2>&1 || true; \
sudo systemd-run --unit=vm-ctl-auto-shutdown --on-active=${AUTO_SHUTDOWN_SYSTEMD} /sbin/poweroff >/dev/null; \
sudo systemctl show vm-ctl-auto-shutdown.timer --property=NextElapseUSecRealtime --value 2>/dev/null || true"

  next_at=$(gcloud compute ssh "$GCE_NAME" --zone="$GCP_ZONE" \
    --ssh-flag='-o ConnectTimeout=8' \
    --command "$ssh_cmd" 2>/dev/null | tr -d '\r' | tail -n1 || true)

  if [[ -n "$next_at" ]]; then
    log "Auto-shutdown scheduled in ${AUTO_SHUTDOWN_RAW} (at ${next_at})"
  else
    log "Auto-shutdown scheduled in ${AUTO_SHUTDOWN_RAW}"
  fi
}

remote_container_ready() {
  local probe
  probe=$(gcloud compute ssh "$GCE_NAME" --zone="$GCP_ZONE" \
    --ssh-flag='-o ConnectTimeout=8' \
    --command "bash -lc 'if command -v docker >/dev/null 2>&1 && sudo docker ps -qf name=steam-headless | grep -q .; then echo READY; else echo NOT_READY; fi'" \
    2>/dev/null || true)
  printf '%s\n' "$probe" | tr -d '\r' | grep -qx 'READY'
}

instance_exists() {
  gcloud compute instances describe "$GCE_NAME" --zone="$GCP_ZONE" >/dev/null 2>&1
}

deploy_instance() {
  local deploy_script="${ROOT_DIR}/gcp/deploy-gce.sh"
  [[ -x "$deploy_script" ]] || err "Missing deploy script: $deploy_script"
  log "Instance ${GCE_NAME} not found, running deploy"
  GCP_PROJECT="$GCP_PROJECT" GCP_ZONE="$GCP_ZONE" GCE_NAME="$GCE_NAME" "$deploy_script"
}

install_prism_remote() {
  ensure_remote_ready
  local src="${ROOT_DIR}/gcp/additional/install-prism.sh"
  [[ -f "$src" ]] || err "Missing script: $src"
  gcloud compute scp "$src" "${GCE_NAME}:/tmp/install-prism.sh" --zone="$GCP_ZONE" >/dev/null
  gcloud compute ssh "$GCE_NAME" --zone="$GCP_ZONE" --command 'sudo bash /tmp/install-prism.sh'
}

install_chrome_remote() {
  ensure_remote_ready
  local src="${ROOT_DIR}/gcp/additional/install-chrome.sh"
  [[ -f "$src" ]] || err "Missing script: $src"
  gcloud compute scp "$src" "${GCE_NAME}:/tmp/install-chrome.sh" --zone="$GCP_ZONE" >/dev/null
  gcloud compute ssh "$GCE_NAME" --zone="$GCP_ZONE" --command 'sudo bash /tmp/install-chrome.sh'
}

ensure_remote_ready() {
  if remote_container_ready; then
    return 0
  fi

  log "Remote container not ready, running remote setup"
  local setup_src="${ROOT_DIR}/gcp/remote-setup.sh"
  local max_attempts=3
  local attempt=1
  local rc
  [[ -f "$setup_src" ]] || err "Missing script: $setup_src"

  while (( attempt <= max_attempts )); do
    log "Running remote setup attempt ${attempt}/${max_attempts}"
    if ! gcloud compute scp "$setup_src" "${GCE_NAME}:/tmp/remote-setup.sh" --zone="$GCP_ZONE" >/dev/null; then
      rc=$?
      log "WARN: scp failed with code ${rc}; waiting for SSH and retrying"
      wait_for_ssh 300 || true
      (( attempt += 1 ))
      continue
    fi

    if gcloud compute ssh "$GCE_NAME" --zone="$GCP_ZONE" --command 'sudo bash /tmp/remote-setup.sh'; then
      :
    else
      rc=$?
      log "WARN: remote-setup exited with code ${rc} (this can happen once during reboot)"
    fi

    if remote_container_ready; then
      return 0
    fi

    if (( attempt < max_attempts )); then
      log "Waiting for VM SSH after remote-setup attempt ${attempt}"
      wait_for_ssh 300 || true
    fi
    (( attempt += 1 ))
  done

  err "Remote setup failed after ${max_attempts} attempts; container still not ready"
}

print_install_help() {
  cat <<'USAGE'
Install targets:
  prism    Install PrismLauncher and add entry in Sunshine applications
  chrome   Install Google Chrome and add entry in Sunshine applications
  help     Show this install help

Examples:
  ./gcp/vm-ctl.sh install prism
  ./gcp/vm-ctl.sh install chrome
USAGE
}

cmd=${1:-}
case "$cmd" in
  up)
    if is_help_arg "${2:-}"; then
      echo "Usage: $0 up [<duration>]"
      echo "Duration format: <number><unit>, unit in s|m|h|d (e.g. 30s, 15m, 1h, 1d)"
      exit 0
    fi
    ensure_project
    [[ $# -le 2 ]] || err "Usage: $0 up [<duration>]"
    if [[ -n "${2:-}" ]]; then
      parse_up_duration "${2:-}" || err "Invalid duration '${2:-}'. Use format <number><s|m|h|d>, e.g. 30s, 15m, 1h, 1d."
    fi
    if ! instance_exists; then
      deploy_instance
    fi
    ensure_firewall
    log "Starting ${GCE_NAME} in ${GCP_ZONE}"
    st=$(gcloud compute instances describe "$GCE_NAME" --zone="$GCP_ZONE" --format='value(status)' 2>/dev/null || true)
    if [[ "$st" != "RUNNING" && "$st" != "PROVISIONING" && "$st" != "STAGING" ]]; then
      gcloud compute instances start "$GCE_NAME" --zone="$GCP_ZONE" >/dev/null
    fi
    wait_running
    ip=$(get_vm_ip)
    myip=$(get_my_ip || true)
    if [[ -n "$myip" ]]; then update_firewall_to "${myip}/32"; else log "WARN: cannot detect your IP; keeping current firewall ranges"; fi
    schedule_auto_shutdown || true
    update_duckdns "${ip:-}" || true
    log "VM RUNNING. External IP: ${ip:-unknown}"
    echo "noVNC:    http://${ip:-<ip>}:8083/"
    echo "Sunshine: https://${ip:-<ip>}:47990/"
    while IFS= read -r dns_name; do
      [[ -n "$dns_name" ]] || continue
      echo "noVNC DNS:    http://${dns_name}:8083/"
      echo "Sunshine DNS: https://${dns_name}:47990/"
    done < <(duckdns_domains_fqdn || true)
    # Try to print Sunshine credentials from remote .env
    # Wait briefly for disk/services to settle, then read remote file and parse locally
    creds=""
    for i in $(seq 1 10); do
      creds=$(gcloud compute ssh "$GCE_NAME" --zone="$GCP_ZONE" --command 'sudo cat /opt/container-services/steam-headless/.env 2>/dev/null || true' 2>/dev/null || true)
      if [[ -n "$creds" ]]; then break; fi; sleep 2
    done
    if [[ -n "$creds" ]]; then
      sun_user=$(printf '%s\n' "$creds" | awk -F= '/^SUNSHINE_USER=/{print substr($0,index($0,"=")+1)}' | tail -n1)
      sun_pass=$(printf '%s\n' "$creds" | awk -F= '/^SUNSHINE_PASS=/{print substr($0,index($0,"=")+1)}' | tail -n1)
      [[ -n "$sun_user" ]] || sun_user="admin"
      echo "SUNSHINE_USER=${sun_user}"
      if [[ -n "$sun_pass" ]]; then
        echo "SUNSHINE_PASS=${sun_pass}"
      else
        echo "SUNSHINE_PASS=<not set> (edit /opt/container-services/steam-headless/.env)"
      fi
      # Open Sunshine UI and copy creds to clipboard for convenience
      sun_url="https://${ip:-<ip>}:47990/"
      copy_clip "SUNSHINE_USER=${sun_user}
SUNSHINE_PASS=${sun_pass}"
      echo "(Creds copied to clipboard if supported. Open  manually.)"
    else
      echo "SUNSHINE_USER/PASS: <unavailable> (remote .env not readable yet)"
    fi
    # Suggest Moonlight pairing (or attempt if CLI present)
    if command -v moonlight >/dev/null 2>&1; then
      echo "Tip: to pair this host now, run: moonlight pair ${ip}"
    else
      echo "Install Moonlight on your device, add PC ${ip}, then pair via PIN."
    fi
    ;;
  down)
    is_help_arg "${2:-}" && { echo "Usage: $0 down"; exit 0; }
    ensure_project
    log "Stopping ${GCE_NAME}"
    gcloud compute instances stop "$GCE_NAME" --zone="$GCP_ZONE" >/dev/null
    log "Stopped."
    ;;
  destroy)
    if is_help_arg "${2:-}"; then
      cat <<USAGE
Usage: $0 destroy
Stops and deletes VM instance: ${GCE_NAME}
USAGE
      exit 0
    fi
    ensure_project
    [[ $# -eq 1 ]] || err "Usage: $0 destroy"
    if ! instance_exists; then
      log "Instance ${GCE_NAME} does not exist, nothing to destroy."
      exit 0
    fi
    log "Stopping ${GCE_NAME} (if running)"
    gcloud compute instances stop "$GCE_NAME" --zone="$GCP_ZONE" >/dev/null || true
    log "Deleting ${GCE_NAME}"
    gcloud compute instances delete "$GCE_NAME" --zone="$GCP_ZONE" --quiet >/dev/null || true
    log "Deleted."
    ;;
  allow)
    is_help_arg "${2:-}" && { echo "Usage: $0 allow"; exit 0; }
    ensure_project
    ensure_firewall
    myip=$(get_my_ip) || err "Could not detect your public IP"
    update_firewall_to "${myip}/32"
    log "Firewall pinned to ${myip}/32"
    ;;
  open)
    is_help_arg "${2:-}" && { echo "Usage: $0 open"; exit 0; }
    ensure_project
    ensure_firewall
    update_firewall_to "0.0.0.0/0"
    log "Firewall opened to 0.0.0.0/0 (be careful)."
    ;;
  status)
    is_help_arg "${2:-}" && { echo "Usage: $0 status"; exit 0; }
    ensure_project
    st=$(gcloud compute instances describe "$GCE_NAME" --zone="$GCP_ZONE" --format='value(status)' 2>/dev/null || true)
    ip=$(get_vm_ip || true)
    echo "STATUS=${st:-unknown} IP=${ip:-none}"
    ;;
  ip)
    is_help_arg "${2:-}" && { echo "Usage: $0 ip"; exit 0; }
    get_my_ip || err "Could not detect public IP"
    ;;
  install)
    is_help_arg "${2:-}" && { print_install_help; exit 0; }
    ensure_project
    case "${2:-}" in
      help|"")
        print_install_help
        ;;
      prism)
        install_prism_remote
        ;;
      chrome)
        install_chrome_remote
        ;;
      *)
        err "Unknown install target: ${2:-<empty>} (use: $0 install help)"
        ;;
    esac
    ;;
  help|-h|--help|"")
    cat >&2 <<USAGE
Usage:
  $0 up [<duration>]
  $0 down
  $0 destroy
  $0 allow
  $0 open
  $0 status
  $0 ip
  $0 install <target>
  $0 help

Commands:
  up              Start VM; if missing, auto-deploy it; pin firewall to your public IP; update DuckDNS (if configured)
                  Optional duration (s|m|h|d): auto-stop VM after time, e.g. "$0 up 1h"
  down            Stop VM
  destroy         Stop VM (if running) and delete VM instance
  allow           Update firewall rules to your current public IP (/32)
  open            Open firewall rules to 0.0.0.0/0 (less secure)
  status          Show VM status and external IP
  ip              Show your current public IP
  install prism   Install PrismLauncher in container + add to Sunshine apps
  install chrome  Install Google Chrome in container + add to Sunshine apps
  install help    Show install targets and examples
  help            Show this help

Env (gcp/.env, copy from gcp/.env.example):
  GCP_PROJECT, GCP_ZONE, GCE_NAME, FW_RULE_WEB, FW_RULE_SUN, FW_TAGS, FW_NET,
  DUCKDNS_DOMAINS, DUCKDNS_TOKEN

One-liner deployment examples:
  Start VM + lock firewall to your current IP:
    $0 up
  Start VM + auto-stop after 1 hour:
    $0 up 1h
  Start VM + install Prism:
    $0 up && $0 install prism
  Start VM + install Chrome:
    $0 up && $0 install chrome
  Rebuild VM from scratch + install Prism + Chrome:
    $0 destroy && $0 up && $0 install prism && $0 install chrome
  Start VM + update DuckDNS + print DNS URLs:
    DUCKDNS_DOMAINS=your-duckdns-domain DUCKDNS_TOKEN=... $0 up
  Command help (no --):
    $0 destroy help
USAGE
    exit 0
    ;;
  *)
    err "Unknown command: $cmd (use: $0 help)"
    ;;
esac
