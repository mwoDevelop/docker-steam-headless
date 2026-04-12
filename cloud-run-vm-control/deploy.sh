#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")"/.. && pwd)
# shellcheck disable=SC1091
source "${ROOT_DIR}/gcp-vm/lib/env.sh"
load_gcp_vm_env "$ROOT_DIR"

GCP_PROJECT=${GCP_PROJECT:-}
REGION=${REGION:-europe-central2}
SERVICE_NAME=${SERVICE_NAME:-steam-vm-control-api}
RUNTIME_SA_NAME=${RUNTIME_SA_NAME:-vm-control-api}
RUNTIME_SA_EMAIL="${RUNTIME_SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"
ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-https://mwodevelop.github.io}
ALLOWED_GOOGLE_EMAILS=${ALLOWED_GOOGLE_EMAILS:-}
ALLOWED_GOOGLE_DOMAINS=${ALLOWED_GOOGLE_DOMAINS:-}
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}
DUCKDNS_SECRET_NAME=${DUCKDNS_SECRET_NAME:-steam-vm-control-duckdns-token}

log() { printf '%s [cloud-run-vm-control] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
err() { log "ERROR: $*" >&2; exit 1; }

[[ -n "$GCP_PROJECT" ]] || err "GCP_PROJECT is required"
[[ -n "${GCP_ZONE:-}" ]] || err "GCP_ZONE is required"
[[ -n "${GCE_NAME:-}" ]] || err "GCE_NAME is required"
[[ -n "$GOOGLE_CLIENT_ID" ]] || err "GOOGLE_CLIENT_ID is required"
[[ -n "$ALLOWED_GOOGLE_EMAILS" || -n "$ALLOWED_GOOGLE_DOMAINS" ]] || err "Set ALLOWED_GOOGLE_EMAILS or ALLOWED_GOOGLE_DOMAINS"

gcloud config set project "$GCP_PROJECT" >/dev/null

log "Enabling required Google Cloud APIs"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  compute.googleapis.com >/dev/null

if ! gcloud iam service-accounts describe "$RUNTIME_SA_EMAIL" --project "$GCP_PROJECT" >/dev/null 2>&1; then
  log "Creating runtime service account ${RUNTIME_SA_EMAIL}"
  gcloud iam service-accounts create "$RUNTIME_SA_NAME" \
    --project "$GCP_PROJECT" \
    --display-name "VM Control API runtime" >/dev/null
fi

log "Granting Compute Engine VM control role to runtime service account"
gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
  --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
  --role="roles/compute.instanceAdmin.v1" \
  --quiet >/dev/null

SECRET_ARGS=()
if [[ -n "${DUCKDNS_TOKEN:-}" ]]; then
  if ! gcloud secrets describe "$DUCKDNS_SECRET_NAME" --project "$GCP_PROJECT" >/dev/null 2>&1; then
    log "Creating Secret Manager secret ${DUCKDNS_SECRET_NAME}"
    gcloud secrets create "$DUCKDNS_SECRET_NAME" \
      --project "$GCP_PROJECT" \
      --replication-policy="automatic" >/dev/null
  fi

  log "Updating DuckDNS token secret"
  printf '%s' "$DUCKDNS_TOKEN" | gcloud secrets versions add "$DUCKDNS_SECRET_NAME" \
    --project "$GCP_PROJECT" \
    --data-file=- >/dev/null

  log "Granting Secret Manager access to runtime service account"
  gcloud secrets add-iam-policy-binding "$DUCKDNS_SECRET_NAME" \
    --project "$GCP_PROJECT" \
    --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null

  SECRET_ARGS+=(--update-secrets="DUCKDNS_TOKEN=${DUCKDNS_SECRET_NAME}:latest")
fi

log "Deploying Cloud Run service ${SERVICE_NAME}"
gcloud run deploy "$SERVICE_NAME" \
  --project "$GCP_PROJECT" \
  --region "$REGION" \
  --source "${ROOT_DIR}/cloud-run-vm-control" \
  --service-account "$RUNTIME_SA_EMAIL" \
  --allow-unauthenticated \
  --quiet \
  --set-env-vars "^|^GCP_PROJECT=${GCP_PROJECT}|GCP_ZONE=${GCP_ZONE}|GCE_NAME=${GCE_NAME}|GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}|ALLOWED_GOOGLE_EMAILS=${ALLOWED_GOOGLE_EMAILS}|ALLOWED_GOOGLE_DOMAINS=${ALLOWED_GOOGLE_DOMAINS}|ALLOWED_ORIGINS=${ALLOWED_ORIGINS}|DUCKDNS_DOMAINS=${DUCKDNS_DOMAINS:-}|VM_NOVNC_PORT=8083|VM_SUNSHINE_PORT=47990" \
  "${SECRET_ARGS[@]}" >/dev/null

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --project "$GCP_PROJECT" \
  --region "$REGION" \
  --format='value(status.url)')

log "Cloud Run VM control API deployed"
echo "Service URL: ${SERVICE_URL}"
echo "Use this backend URL in https://mwodevelop.github.io/docker-steam-headless/vm-control/"
