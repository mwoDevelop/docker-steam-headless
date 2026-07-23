#!/usr/bin/env bash
set -euo pipefail

METADATA_HDR=( -H "Metadata-Flavor: Google" --fail --silent --show-error )
REQUEST_KEY="vm-minecraft-management-request"
RESULT_KEY="vm-minecraft-management-result"
AGENT_KEY="vm-minecraft-management-agent"
PROPERTIES_KEY="vm-minecraft-server-properties"
MINECRAFT_STATUS_KEY="vm-minecraft-status"
MINECRAFT_STATUS_DETAIL_KEY="vm-minecraft-status-detail"
POWER_ACTION_STATUS_KEY="vm-power-action-status"
MINECRAFT_ROOT=/mnt/games/minecraft-server
MINECRAFT_COMPOSE_FILE="${MINECRAFT_ROOT}/docker-compose.yml"
MINECRAFT_CONTENT_FILE="${MINECRAFT_ROOT}/data/modrinth-projects.txt"

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
  local token project zone name instance_json fingerprint items items_file payload payload_file operation operation_name
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
    items_file="$(mktemp)"
    printf '%s' "$items" > "$items_file"
    payload="$(jq -n --arg fingerprint "$fingerprint" --arg key "$key" --arg value "$value" --slurpfile items "$items_file" \
      '{fingerprint: $fingerprint, items: ($items[0] + [{key: $key, value: $value}])}')"
    rm -f "$items_file"
    payload_file="$(mktemp)"
    printf '%s' "$payload" > "$payload_file"
    if operation="$(curl --fail --silent --show-error -X POST \
      -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" --data-binary "@${payload_file}" \
      "https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}/setMetadata")"; then
      rm -f "$payload_file"
      operation_name="$(printf '%s' "$operation" | jq -r '.name // empty')"
      if wait_for_zone_operation "$token" "$project" "$zone" "$operation_name"; then
        return 0
      fi
    fi
    rm -f "$payload_file"
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

list_operators() {
  local container="$1" raw operators
  if ! raw="$(docker exec "$container" sh -c 'if [ -f /data/ops.json ]; then cat /data/ops.json; else printf "[]"; fi' 2>&1)"; then
    return 1
  fi
  if ! jq -e 'type == "array"' >/dev/null 2>&1 <<<"$raw"; then
    printf '%s' "$raw"
    return 1
  fi
  operators="$(jq -r '.[] | .name // empty' <<<"$raw")"
  if [[ -z "$operators" ]]; then
    printf 'There are no server operators'
  else
    printf 'Server operators:\n%s' "$operators"
  fi
}

server_properties_json() {
  local properties_file="$1"
  jq -Rn '[inputs | select(test("^[A-Za-z0-9.-]+=")) | capture("^(?<key>[A-Za-z0-9.-]+)=(?<value>.*)$")] | from_entries | del(."rcon.password")' < "$properties_file"
}

load_server_properties() {
  local container="$1" properties_file="$2"
  docker cp "${container}:/data/server.properties" "$properties_file" 2>&1
}

publish_server_properties() {
  local container="$1" properties_file properties_json
  properties_file="$(mktemp)"
  if ! load_server_properties "$container" "$properties_file"; then
    rm -f "$properties_file"
    return 1
  fi
  if ! properties_json="$(server_properties_json "$properties_file")"; then
    rm -f "$properties_file"
    return 1
  fi
  rm -f "$properties_file"
  set_metadata_value "$PROPERTIES_KEY" "$properties_json"
}

validate_server_property_value() {
  local property="$1" value="$2" numeric
  [[ "$property" =~ ^[A-Za-z0-9.-]{1,80}$ ]] || { printf 'Invalid server.properties option.'; return 1; }
  [[ ${#value} -le 512 && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || { printf 'A server.properties value must be a single line up to 512 characters.'; return 1; }
  case "$property" in
    enable-rcon|rcon.password|rcon.port|enable-query|query.port|server-ip|server-port)
      printf '%s is managed by the VM deployment and cannot be changed here.' "$property"; return 1 ;;
    online-mode|white-list|enforce-whitelist|pvp|allow-flight|allow-nether|hardcore|spawn-animals|spawn-monsters|spawn-npcs|force-gamemode)
      [[ "$value" == "true" || "$value" == "false" ]] || { printf '%s must be true or false.' "$property"; return 1; } ;;
    difficulty)
      [[ "$value" =~ ^(peaceful|easy|normal|hard)$ ]] || { printf 'difficulty must be peaceful, easy, normal, or hard.'; return 1; } ;;
    gamemode)
      [[ "$value" =~ ^(survival|creative|adventure|spectator)$ ]] || { printf 'gamemode must be survival, creative, adventure, or spectator.'; return 1; } ;;
    level-type)
      [[ "$value" =~ ^(minecraft:normal|minecraft:flat|minecraft:large_biomes|minecraft:amplified|minecraft:single_biome_surface)$ ]] || { printf 'level-type is not a supported value.'; return 1; } ;;
    max-players|view-distance|simulation-distance|spawn-protection|player-idle-timeout|op-permission-level|entity-broadcast-range-percentage|network-compression-threshold)
      [[ "$value" =~ ^-?[0-9]+$ ]] || { printf '%s must be an integer.' "$property"; return 1; }
      numeric=$((10#${value#-}))
      case "$property" in
        max-players) (( numeric >= 1 && numeric <= 1000 )) || { printf 'max-players must be between 1 and 1000.'; return 1; } ;;
        view-distance|simulation-distance) (( numeric >= 3 && numeric <= 32 )) || { printf '%s must be between 3 and 32.' "$property"; return 1; } ;;
        spawn-protection) (( numeric >= 0 && numeric <= 64 )) || { printf 'spawn-protection must be between 0 and 64.'; return 1; } ;;
        player-idle-timeout) (( numeric >= 0 && numeric <= 2147483647 )) || { printf 'player-idle-timeout must be between 0 and 2147483647.'; return 1; } ;;
        op-permission-level) (( numeric >= 1 && numeric <= 4 )) || { printf 'op-permission-level must be between 1 and 4.'; return 1; } ;;
        entity-broadcast-range-percentage) (( numeric >= 10 && numeric <= 1000 )) || { printf 'entity-broadcast-range-percentage must be between 10 and 1000.'; return 1; } ;;
        network-compression-threshold) (( value == -1 || (numeric >= 0 && numeric <= 2147483647) )) || { printf 'network-compression-threshold must be -1 or a non-negative integer.'; return 1; } ;;
      esac ;;
  esac
}

update_server_property() {
  local container="$1" property="$2" value="$3" properties_file updated_file output ownership owner group mode
  properties_file="$(mktemp)"
  updated_file="$(mktemp)"
  if ! ownership="$(docker exec --user 0 "$container" stat -c '%u:%g:%a' /data/server.properties 2>&1)" || ! [[ "$ownership" =~ ^[0-9]+:[0-9]+:[0-7]{3,4}$ ]]; then
    rm -f "$properties_file" "$updated_file"
    printf 'Unable to read the current server.properties ownership and permissions.'
    return 1
  fi
  IFS=: read -r owner group mode <<< "$ownership"
  if ! load_server_properties "$container" "$properties_file"; then
    rm -f "$properties_file" "$updated_file"
    return 1
  fi
  if ! PROPERTY_NAME="$property" PROPERTY_VALUE="$value" awk '
    BEGIN { property = ENVIRON["PROPERTY_NAME"]; value = ENVIRON["PROPERTY_VALUE"]; found = 0 }
    index($0, property "=") == 1 { print property "=" value; found = 1; next }
    { print }
    END { if (!found) exit 3 }
  ' "$properties_file" > "$updated_file"; then
    rm -f "$properties_file" "$updated_file"
    printf 'The selected option is not present in the current server.properties file.'
    return 1
  fi
  if ! docker cp "$updated_file" "${container}:/data/server.properties" 2>&1; then
    rm -f "$properties_file" "$updated_file"
    return 1
  fi
  if ! docker exec --user 0 "$container" chown "${owner}:${group}" /data/server.properties 2>&1 || ! docker exec --user 0 "$container" chmod "$mode" /data/server.properties 2>&1; then
    rm -f "$properties_file" "$updated_file"
    printf 'server.properties was copied, but its original ownership or permissions could not be restored.'
    return 1
  fi
  rm -f "$properties_file" "$updated_file"
  if ! output="$(docker restart "$container" 2>&1)"; then
    printf '%s' "$output"
    return 1
  fi
  if ! wait_for_rcon "$container"; then
    printf 'Minecraft restarted after changing %s, but RCON did not become ready: %s' "$property" "$RCON_READY_ERROR"
    return 1
  fi
  if ! publish_server_properties "$container"; then
    printf 'Updated %s, but the refreshed server.properties could not be read.' "$property"
    return 1
  fi
  printf 'Updated %s=%s and restarted Minecraft.' "$property" "$value"
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

reconcile_minecraft_status() {
  local container output power_status phase action token
  for _ in $(seq 1 90); do
    container="$(minecraft_container || true)"
    if [[ -n "$container" ]] && output="$(run_rcon "$container" "list" 2>&1)"; then
      set_metadata_value "$MINECRAFT_STATUS_KEY" "running" || true
      set_metadata_value "$MINECRAFT_STATUS_DETAIL_KEY" "Minecraft RCON is ready after VM startup." || true
      power_status="$(metadata_get "$POWER_ACTION_STATUS_KEY")"
      IFS=: read -r phase action token <<< "$power_status"
      if [[ "$action" == "auto-stop" && "$phase" =~ ^(requested|running|backed-up|stopping)$ && -n "$token" ]]; then
        set_metadata_value "$POWER_ACTION_STATUS_KEY" "completed:auto-stop:${token}" || true
      fi
      return 0
    fi
    sleep 2
  done
  return 1
}

sync_modrinth_content() {
  local raw="$1" entries entry removed_file expected_file temporary_file container output missing_files
  entries="$(printf '%s' "$raw" | jq -r '.entries // [] | .[]' 2>/dev/null || true)"
  mkdir -p "${MINECRAFT_ROOT}/data"
  temporary_file="$(mktemp)"
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    if [[ "$entry" =~ ^[A-Za-z0-9_-]{3,80}:[A-Za-z0-9_-]{3,80}$ ]]; then
      printf '%s\n' "$entry" >> "$temporary_file"
    else
      rm -f "$temporary_file"
      printf '%s\n' "Invalid Modrinth manifest entry."
      return 1
    fi
  done <<< "$entries"
  sort -u "$temporary_file" > "${temporary_file}.sorted"
  install -m 0644 "${temporary_file}.sorted" "$MINECRAFT_CONTENT_FILE"
  rm -f "$temporary_file" "${temporary_file}.sorted"
  while IFS= read -r removed_file; do
    [[ "$removed_file" =~ ^[A-Za-z0-9._+-]{1,240}\.jar$ ]] || continue
    rm -f "${MINECRAFT_ROOT}/data/plugins/${removed_file}" "${MINECRAFT_ROOT}/data/mods/${removed_file}"
  done < <(printf '%s' "$raw" | jq -r '.removeFiles // [] | .[]' 2>/dev/null || true)
  if [[ ! -f "$MINECRAFT_COMPOSE_FILE" ]]; then
    printf '%s\n' "Minecraft compose file is missing."
    return 1
  fi
  if ! output="$(/usr/local/bin/vm-power-action reconcile-minecraft 2>&1)"; then
    printf '%s\n' "$output"
    return 1
  fi
  container="$(minecraft_container || true)"
  if [[ -z "$container" ]]; then
    printf '%s\n' "Minecraft container was not created while applying the Modrinth manifest."
    return 1
  fi
  if ! output="$(docker restart "$container" 2>&1)"; then
    printf '%s\n' "$output"
    return 1
  fi
  for _ in $(seq 1 90); do
    container="$(minecraft_container || true)"
    if [[ -n "$container" ]] && wait_for_rcon "$container"; then
      missing_files=""
      while IFS= read -r expected_file; do
        [[ "$expected_file" =~ ^[A-Za-z0-9._+-]{1,240}\.jar$ ]] || continue
        if [[ ! -f "${MINECRAFT_ROOT}/data/plugins/${expected_file}" && ! -f "${MINECRAFT_ROOT}/data/mods/${expected_file}" ]]; then
          missing_files+=" ${expected_file}"
        fi
      done < <(printf '%s' "$raw" | jq -r '.expectedFiles // [] | .[]' 2>/dev/null || true)
      if [[ -n "$missing_files" ]]; then
        printf 'Minecraft restarted, but Modrinth files are missing:%s\n' "$missing_files"
        return 1
      fi
      printf 'Applied %s Modrinth project(s) and restarted Minecraft.\n' "$(wc -l < "$MINECRAFT_CONTENT_FILE" | tr -d ' ')"
      return 0
    fi
    sleep 2
  done
  printf '%s\n' "Minecraft did not become RCON-ready after applying the Modrinth manifest."
  return 1
}

process_request() {
  local raw request_id action command player property value container result_id result_state output state
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

  if [[ "$action" == "content-sync" ]]; then
    if output="$(sync_modrinth_content "$raw")"; then
      publish_result "$request_id" "$action" "done" "$output"
    else
      publish_result "$request_id" "$action" "failed" "$output"
    fi
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
  property="$(printf '%s' "$raw" | jq -r '.property // empty' 2>/dev/null || true)"
  value="$(printf '%s' "$raw" | jq -r '.value // empty' 2>/dev/null || true)"
  state="done"
  case "$action" in
    console) if ! output="$(run_rcon "$container" "$command")"; then state="failed"; fi ;;
    players) if ! output="$(run_rcon "$container" "list")"; then state="failed"; fi ;;
    whitelist-list) if ! output="$(run_rcon "$container" "whitelist list")"; then state="failed"; fi ;;
    whitelist-add) if ! output="$(run_rcon "$container" "whitelist add ${player}")"; then state="failed"; fi ;;
    whitelist-remove) if ! output="$(run_rcon "$container" "whitelist remove ${player}")"; then state="failed"; fi ;;
    op-list) if ! output="$(list_operators "$container")"; then state="failed"; fi ;;
    op-add) if ! output="$(run_rcon "$container" "op ${player}")"; then state="failed"; fi ;;
    op-remove) if ! output="$(run_rcon "$container" "deop ${player}")"; then state="failed"; fi ;;
    restart) if ! output="$(docker restart "$container" 2>&1)"; then state="failed"; fi ;;
    properties-read) if ! output="$(publish_server_properties "$container")"; then state="failed"; else output="Loaded current server.properties options."; fi ;;
    properties-update)
      if ! output="$(validate_server_property_value "$property" "$value")"; then
        state="failed"
      elif ! output="$(update_server_property "$container" "$property" "$value")"; then
        state="failed"
      fi ;;
    *) state="failed"; output="Unsupported management action." ;;
  esac
  publish_result "$request_id" "$action" "$state" "$output"
}

main() {
  reconcile_minecraft_status || true
  while true; do
    process_request || true
    sleep 2
  done
}

[[ "${1:-daemon}" == "daemon" ]] || exit 2
main
