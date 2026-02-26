#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
ACTIVE_PROFILE_FILE="${ROOT_DIR}/.active-profile"

# shellcheck disable=SC1091
source "${ROOT_DIR}/lib/env.sh"

usage() {
  cat <<USAGE
Usage:
  $0 --profile <L4|T4|...> --gamers <0..5>

Description:
  Wrapper for sequence: deploy -> reconcile gamer instances -> status.
  Managed instance names are: gamer1..gamer5.

Rules:
  - --gamers accepts values from 0 to 5
  - if a different profile is currently running, command exits with error
  - repeated runs are idempotent: adds/removes instances to match desired count

Examples:
  $0 --profile T4 --gamers 1
  $0 --profile L4 --gamers 3
  $0 --profile T4 --gamers 0
USAGE
}

PROFILE_ARG=""
GAMERS_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      [[ $# -ge 2 ]] || { echo "Missing value for --profile" >&2; exit 1; }
      PROFILE_ARG="$2"
      shift 2
      ;;
    --profile=*)
      PROFILE_ARG="${1#*=}"
      shift
      ;;
    --gamers)
      [[ $# -ge 2 ]] || { echo "Missing value for --gamers" >&2; exit 1; }
      GAMERS_ARG="$2"
      shift 2
      ;;
    --gamers=*)
      GAMERS_ARG="${1#*=}"
      shift
      ;;
    help|-h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

[[ -n "$PROFILE_ARG" ]] || { echo "Missing required option: --profile" >&2; usage >&2; exit 1; }
[[ -n "$GAMERS_ARG" ]] || { echo "Missing required option: --gamers" >&2; usage >&2; exit 1; }
[[ "$GAMERS_ARG" =~ ^[0-5]$ ]] || { echo "Invalid --gamers value: ${GAMERS_ARG}. Allowed: 0..5" >&2; exit 1; }

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"
[[ -n "${GCP_PROJECT:-}" ]] || { echo "GCP_PROJECT is empty in ${ENV_FILE}" >&2; exit 1; }

REQUESTED_PROFILE="$(profile_normalize "$PROFILE_ARG")"
REQUESTED_PROFILE_FILE="$(profile_file_for "$ROOT_DIR" "$REQUESTED_PROFILE" || true)"
[[ -n "$REQUESTED_PROFILE_FILE" ]] || {
  echo "Unknown profile: ${PROFILE_ARG}" >&2
  echo "Available profiles:" >&2
  find "${ROOT_DIR}/profiles" -maxdepth 1 -type f -name '*.env' -printf '  - %f\n' | sed 's/\.env$//' >&2
  exit 1
}

if [[ -f "$ACTIVE_PROFILE_FILE" ]]; then
  ACTIVE_PROFILE_RAW="$(tr -d ' \t\r\n' < "$ACTIVE_PROFILE_FILE")"
  if [[ -n "$ACTIVE_PROFILE_RAW" ]]; then
    ACTIVE_PROFILE="$(profile_normalize "$ACTIVE_PROFILE_RAW")"
    if [[ "$ACTIVE_PROFILE" != "$REQUESTED_PROFILE" ]]; then
      ACTIVE_PROFILE_PATH="$(profile_file_for "$ROOT_DIR" "$ACTIVE_PROFILE" || true)"
      if [[ -n "$ACTIVE_PROFILE_PATH" ]]; then
        ACTIVE_CLUSTER="$(bash -lc "source '$ENV_FILE'; source '$ACTIVE_PROFILE_PATH'; printf '%s' \"\${GKE_CLUSTER:-}\"")"
        ACTIVE_LOCATION="$(bash -lc "source '$ENV_FILE'; source '$ACTIVE_PROFILE_PATH'; printf '%s' \"\${GKE_LOCATION:-}\"")"
        ACTIVE_STATUS="$(gcloud container clusters describe "$ACTIVE_CLUSTER" --location "$ACTIVE_LOCATION" --project "$GCP_PROJECT" --format='value(status)' 2>/dev/null || true)"
        if [[ -n "$ACTIVE_STATUS" && "$ACTIVE_STATUS" != "STOPPING" && "$ACTIVE_STATUS" != "ERROR" ]]; then
          echo "ERROR: Active running profile is '${ACTIVE_PROFILE}' (${ACTIVE_CLUSTER}/${ACTIVE_LOCATION})." >&2
          echo "Requested profile '${REQUESTED_PROFILE}' is different." >&2
          exit 1
        fi
      fi
    fi
  fi
fi

echo "[deploy-gamers] profile=${REQUESTED_PROFILE} gamers=${GAMERS_ARG}"
echo "[deploy-gamers] deploy cluster"
ENV_FILE="$ENV_FILE" "${ROOT_DIR}/deploy.sh" --profile "$REQUESTED_PROFILE"

desired="$GAMERS_ARG"
for i in 1 2 3 4 5; do
  name="gamer${i}"
  if (( i <= desired )); then
    echo "[deploy-gamers] ensure instance: ${name}"
    ENV_FILE="$ENV_FILE" "${ROOT_DIR}/deploy-instance.sh" "$name"
  else
    echo "[deploy-gamers] ensure removed: ${name}"
    ENV_FILE="$ENV_FILE" "${ROOT_DIR}/destroy-instance.sh" "$name" release-ip
  fi
done

echo "[deploy-gamers] status"
ENV_FILE="$ENV_FILE" "${ROOT_DIR}/status.sh"
echo "[deploy-gamers] instances"
ENV_FILE="$ENV_FILE" "${ROOT_DIR}/list-instances.sh"
