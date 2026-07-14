#!/usr/bin/env bash
set -euo pipefail

METADATA_HDR=( -H "Metadata-Flavor: Google" --fail --silent --show-error )
REQUEST_KEY="vm-minecraft-management-request"
RESULT_KEY="vm-minecraft-management-result"
AGENT_KEY="vm-minecraft-management-agent"

metadata_get() {
  local key="$1"
  # A missing optional attribute is normal while no command is queued. Do not
  # flood the system journal with an expected metadata-server 404.
  curl "${METADATA_HDR[@]}" "http://metadata/computeMetadata/v1/instance/attributes/${key}" 2>/dev/null || true
}

metadata_token() {
  curl "${METADATA_HDR[@]}" \
    "http://metadata/computeMetadata/v1/instance/service-accounts/default/token" \
    | jq -r '.access_token // empty'
}

project_id() { curl "${METADATA_HDR[@]}" "http://metadata/computeMetadata/v1/project/project-id"; }
instance_name() { curl "${METADATA_HDR[@]}" "http://metadata/computeMetadata/v1/instance/name"; }
zone_name() {
  local zone
  zone="$(curl "${METADATA_HDR[@]}" "http://metadata/computeMetadata/v1/instance/zone")"
  printf '%s\n' "${zone##*/}"
}

wait_for_zone_operation() {
  local token="$1"
  local project="$2"
  local zone="$3"
  local operation_name="$4"
  local operation status

  [[ -n "$operation_name" ]] || return 1
  for _ in $(seq 1 30); do
    operation="$(curl --fail --silent --show-error -H "Authorization: Bearer ${token}" \
      "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/operations/${operation_name}" || true)"
    status="$(printf '%s' "$operation" | jq -r '.status // empty')"
    if [[ "$status" == "DONE" ]]; then
      printf '%s' "$operation" | jq -e '((.error.errors // []) | length) == 0' >/dev/null
      return
    fi
    sleep 1
  done
  return 1
}

set_metadata_value() {
  local key="$1"
  local value="$2"
  local token project zone name instance_json fingerprint items payload operation operation_name
  token="$(metadata_token || true)"
  project="$(project_id || true)"
  zone="$(zone_name || true)"
  name="$(instance_name || true)"
  [[ -n "$token" && -n "$project" && -n "$zone" && -n "$name" ]] || return 1

  for _ in 1 2 3 4 5; do
    instance_json="$(curl --fail --silent --show-error -H "Authorization: Bearer ${token}" \
      "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}" || true)"
    fingerprint="$(printf '%s' "$instance_json" | jq -r '.metadata.fingerprint // empty')"
    [[ -n "$fingerprint" ]] || return 1
    items="$(printf '%s' "$instance_json" | jq --arg key "$key" '[.metadata.items // [] | .[] | select(.key != $key)]')"
    payload="$(jq -n --arg fingerprint "$fingerprint" --arg key "$key" --arg value "$value" --argjson items "$items" \
      '{fingerprint: $fingerprint, items: ($items + [{key: $key, value: $value}])}')"
    if operation="$(curl --fail --silent --show-error -X POST \
      -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d "$payload" \
      "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}/setMetadata")"; then
      operation_name="$(printf '%s' "$operation" | jq -r '.name // empty')"
      if wait_for_zone_operation "$token" "$project" "$zone" "$operation_name"; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

minecraft_container() {
  docker ps --format '{{.ID}} {{.Image}}' \
    | awk '$2 ~ /itzg\/minecraft-server/ { print $1; exit }'
}

publish_result() {
  local request_id="$1" action="$2" state="$3" output="$4"
  output="$(printf '%s' "$output" | tr -d '\000' | tail -c 4096)"
  local result
  result="$(jq -cn --arg id "$request_id" --arg action "$action" --arg state "$state" \
    --arg output "$output" --arg completedAt "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
    '{id:$id, action:$action, state:$state, output:$output, completedAt:$completedAt}')"
  set_metadata_value "$RESULT_KEY" "$result" || true
}

run_rcon() {
  local container="$1" command="$2"
  docker exec "$container" rcon-cli "$command" 2>&1
}

RCON_READY_ERROR=""

wait_for_rcon() {
  local container="$1" output
  RCON_READY_ERROR=""
  for _ in $(seq 1 30); do
    if output="$(run_rcon "$container" "list")"; then
      return 0
    fi
    RCON_READY_ERROR="$output"
    case "$output" in
      *"connection refused"*|*"Connection refused"*|*"i/o timeout"*|*"EOF"*) sleep 2 ;;
      *) return 1 ;;
    esac
  done
  return 1
}

process_request() {
  local raw request_id action command player container result_id result_state output state
  raw="$(metadata_get "$REQUEST_KEY")"
  [[ -n "$raw" ]] || return 0
  request_id="$(printf '%s' "$raw" | jq -r '.id // empty' 2>/dev/null || true)"
  action="$(printf '%s' "$raw" | jq -r '.action // empty' 2>/dev/null || true)"
  [[ -n "$request_id" && -n "$action" ]] || return 0

  result_id="$(metadata_get "$RESULT_KEY" | jq -r '.id // empty' 2>/dev/null || true)"
  result_state="$(metadata_get "$RESULT_KEY" | jq -r '.state // empty' 2>/dev/null || true)"
  if [[ "$result_id" == "$request_id" && ( "$result_state" == "done" || "$result_state" == "failed" ) ]]; then
    return 0
  fi

  container="$(minecraft_container || true)"
  if [[ -z "$container" ]]; then
    publish_result "$request_id" "$action" "failed" "Minecraft container is not running."
    return 0
  fi

  if [[ "$action" != "restart" ]] && ! wait_for_rcon "$container"; then
    publish_result "$request_id" "$action" "failed" "Minecraft RCON is not ready: ${RCON_READY_ERROR}"
    return 0
  fi

  command="$(printf '%s' "$raw" | jq -r '.command // empty' 2>/dev/null || true)"
  player="$(printf '%s' "$raw" | jq -r '.player // empty' 2>/dev/null || true)"
  state="done"
  case "$action" in
    console) if ! output="$(run_rcon "$container" "$command")"; then state="failed"; fi ;;
    players) if ! output="$(run_rcon "$container" "list")"; then state="failed"; fi ;;
    whitelist-list) if ! output="$(run_rcon "$container" "whitelist list")"; then state="failed"; fi ;;
    whitelist-add) if ! output="$(run_rcon "$container" "whitelist add ${player}")"; then state="failed"; fi ;;
    whitelist-remove) if ! output="$(run_rcon "$container" "whitelist remove ${player}")"; then state="failed"; fi ;;
    op-list) if ! output="$(run_rcon "$container" "op list")"; then state="failed"; fi ;;
    op-add) if ! output="$(run_rcon "$container" "op ${player}")"; then state="failed"; fi ;;
    op-remove) if ! output="$(run_rcon "$container" "deop ${player}")"; then state="failed"; fi ;;
    restart) if ! output="$(docker restart "$container" 2>&1)"; then state="failed"; fi ;;
    *) state="failed"; output="Unsupported management action." ;;
  esac
  publish_result "$request_id" "$action" "$state" "$output"
}

main() {
  while true; do
    process_request || true
    sleep 2
  done
}

[[ "${1:-daemon}" == "daemon" ]] || exit 2
main
