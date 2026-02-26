#!/usr/bin/env bash

profile_normalize() {
  local raw="${1:-}"
  raw="${raw##*/}"
  raw="${raw%.env}"
  raw="${raw,,}"
  raw="${raw// /}"
  case "$raw" in
    "" ) echo "l4" ;;
    * ) echo "$raw" ;;
  esac
}

profile_file_for() {
  local root_dir="${1:?root_dir is required}"
  local profile_raw="${2:-}"
  local normalized
  normalized="$(profile_normalize "$profile_raw")"

  if [[ -f "${root_dir}/profiles/${normalized}.env" ]]; then
    printf '%s/profiles/%s.env' "$root_dir" "$normalized"
    return 0
  fi
  if [[ -f "${root_dir}/profiles/${normalized}-sharing.env" ]]; then
    printf '%s/profiles/%s-sharing.env' "$root_dir" "$normalized"
    return 0
  fi
  return 1
}

load_gcp_v8s_env() {
  local root_dir="${1:?root_dir is required}"
  local env_file="${ENV_FILE:-${root_dir}/.env}"
  local active_profile_file="${root_dir}/.active-profile"
  local profile_requested
  local profile_file

  if [[ ! -f "$env_file" ]]; then
    echo "[gcp-v8s] ERROR: Missing env file: ${env_file}" >&2
    return 1
  fi

  # shellcheck disable=SC1090
  source "$env_file"

  if [[ -n "${PROFILE:-}" ]]; then
    profile_requested="${PROFILE}"
  elif [[ -f "$active_profile_file" ]]; then
    profile_requested="$(tr -d ' \t\r\n' < "$active_profile_file")"
    [[ -n "$profile_requested" ]] || {
      echo "[gcp-v8s] ERROR: Empty ${active_profile_file}. Run ./deploy.sh --profile <L4|T4|...>." >&2
      return 1
    }
  else
    echo "[gcp-v8s] ERROR: No active profile selected." >&2
    echo "[gcp-v8s] Run ./deploy.sh --profile <L4|T4|...> first." >&2
    return 1
  fi
  profile_file="$(profile_file_for "$root_dir" "$profile_requested" || true)"
  if [[ -z "$profile_file" ]]; then
    echo "[gcp-v8s] ERROR: Unknown profile '${profile_requested}'." >&2
    echo "[gcp-v8s] Available profiles:" >&2
    find "${root_dir}/profiles" -maxdepth 1 -type f -name '*.env' -printf '  - %f\n' | sed 's/\.env$//' >&2
    return 1
  fi

  # shellcheck disable=SC1090
  source "$profile_file"

  if [[ -z "${GCP_PROJECT:-}" ]]; then
    echo "[gcp-v8s] ERROR: GCP_PROJECT is empty in ${env_file}" >&2
    return 1
  fi

  ACTIVE_PROFILE="$(profile_normalize "$profile_requested")"
  ACTIVE_PROFILE_FILE="$profile_file"
  ACTIVE_PROFILE_STATE_FILE="$active_profile_file"
  ACTIVE_ENV_FILE="$env_file"
  ENV_FILE="$env_file"
  export ACTIVE_PROFILE ACTIVE_PROFILE_FILE ACTIVE_PROFILE_STATE_FILE ACTIVE_ENV_FILE ENV_FILE
}
