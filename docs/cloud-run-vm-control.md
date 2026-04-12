# Cloud Run VM Control

This setup replaces the browser-stored GitHub PAT flow with:

1. a static frontend on GitHub Pages,
2. Google sign-in in the browser,
3. a Cloud Run API that controls the GCE VM directly.

The browser never needs a GitHub token in this mode.

## Architecture

- GitHub Pages serves the UI from `docs/vm-control/`
- Google Identity Services signs the user in
- the browser sends a Google ID token to the backend
- Cloud Run verifies the token and checks an allowlist
- Cloud Run uses its runtime service account to control the VM

## Files

- Frontend: [`docs/vm-control/`](./vm-control/index.html)
- Backend: [`cloud-run-vm-control/`](../cloud-run-vm-control/app.py)
- Deploy script: [`cloud-run-vm-control/deploy.sh`](../cloud-run-vm-control/deploy.sh)

## What The Backend Controls

The backend targets the single GCE VM configured by:

- `GCP_PROJECT`
- `GCP_ZONE`
- `GCE_NAME`

It supports:

- `status`
- `start`
- `stop`
- `restart`

On `start` and `restart`, it can also refresh DuckDNS if:

- `DUCKDNS_DOMAINS` is set
- `DUCKDNS_TOKEN` is available

## Required Google Cloud Setup

### 1. Create a Google OAuth client ID

Create a **Web application** OAuth client in Google Cloud Console.

Set **Authorized JavaScript origins** to include at least:

- `https://mwodevelop.github.io`

If you host the page elsewhere, add that origin too.

Save the generated **Client ID**. The frontend needs it, and the backend verifies tokens against it.

### 2. Choose who is allowed to control the VM

Set one of:

- `ALLOWED_GOOGLE_EMAILS`
- `ALLOWED_GOOGLE_DOMAINS`

Examples:

- `ALLOWED_GOOGLE_EMAILS=mwodevelop@gmail.com`
- `ALLOWED_GOOGLE_DOMAINS=example.com`

### 3. Deploy the backend

The deploy script loads `gcp-vm/.env` and `gcp-vm/.env.secrets`, then deploys a public Cloud Run service protected by Google login at the application layer.

Example:

```bash
cd /path/to/docker-steam-headless

GOOGLE_CLIENT_ID="1234567890-abc123def456.apps.googleusercontent.com" \
ALLOWED_GOOGLE_EMAILS="mwodevelop@gmail.com" \
ALLOWED_ORIGINS="https://mwodevelop.github.io" \
./cloud-run-vm-control/deploy.sh
```

What the script does:

- enables required APIs
- creates a dedicated runtime service account if needed
- grants `roles/compute.instanceAdmin.v1`
- stores `DUCKDNS_TOKEN` in Secret Manager if present locally
- deploys the Cloud Run service from source

After deploy, it prints the backend URL.

## Using The Page

1. Open:
   - `https://mwodevelop.github.io/docker-steam-headless/vm-control/`
2. Paste the Cloud Run backend URL once
3. Click `Connect API`
4. Sign in with Google
5. Use `Start`, `Stop`, `Restart`, or `Status`

The page stores:

- backend URL in `localStorage`
- a short-lived Google session token in `sessionStorage`
- local action history in `localStorage`

It does not store any GitHub token.

## Runtime Environment Variables

The backend reads:

- `GCP_PROJECT`
- `GCP_ZONE`
- `GCE_NAME`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_IDS`
- `ALLOWED_GOOGLE_EMAILS`
- `ALLOWED_GOOGLE_DOMAINS`
- `ALLOWED_ORIGINS`
- `DUCKDNS_DOMAINS`
- `DUCKDNS_TOKEN`
- `VM_NOVNC_PORT`
- `VM_SUNSHINE_PORT`

## Notes

- This mode is for the single-VM `gcp-vm` flow, not `gcp-v8s`.
- The Cloud Run service is public, but control endpoints require a valid Google ID token from an allowed account.
- CORS is restricted by `ALLOWED_ORIGINS`, but real authorization is enforced by token verification and the allowlist.
- If the VM changes public IP on start, DuckDNS can keep the DNS hostname current without reserving a static IP.
