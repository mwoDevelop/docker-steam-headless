#!/usr/bin/env bash
set -euo pipefail

status=0
for dockerfile in "$@"; do
  if ! awk '
    BEGIN { in_instruction = 0; failed = 0 }
    /^[[:space:]]*(ARG|ENV)[[:space:]]/ { in_instruction = 1 }
    in_instruction && /(PASSWORD|PASSWD|_PASS)[[:space:]]*=/ {
      print FILENAME ":" FNR ":" $0
      failed = 1
    }
    in_instruction && $0 !~ /\\[[:space:]]*$/ { in_instruction = 0 }
    END { exit failed }
  ' "$dockerfile"; then
    printf '%s contains a password-like Dockerfile default. Pass credentials only at runtime.\n' "$dockerfile" >&2
    status=1
  fi
done

exit "$status"
