#!/usr/bin/env bash

load_gcp_vm_env() {
  local root_dir="${1:?root_dir is required}"
  local env_file="${ENV_FILE:-${root_dir}/gcp-vm/.env}"
  local env_gcp_file="${ENV_GCP_FILE:-${root_dir}/gcp-vm/.env.gcp}"
  local env_secrets_file="${ENV_SECRETS_FILE:-${root_dir}/gcp-vm/.env.secrets}"
  local file

  for file in "$env_file" "$env_gcp_file" "$env_secrets_file"; do
    [[ -f "$file" ]] || continue
    # shellcheck disable=SC1090
    source "$file"
  done

  ACTIVE_VM_ENV_FILE="$env_file"
  ACTIVE_VM_ENV_GCP_FILE="$env_gcp_file"
  ACTIVE_VM_ENV_SECRETS_FILE="$env_secrets_file"
  ENV_FILE="$env_file"
  ENV_GCP_FILE="$env_gcp_file"
  ENV_SECRETS_FILE="$env_secrets_file"
  export ACTIVE_VM_ENV_FILE ACTIVE_VM_ENV_GCP_FILE ACTIVE_VM_ENV_SECRETS_FILE
  export ENV_FILE ENV_GCP_FILE ENV_SECRETS_FILE
}
