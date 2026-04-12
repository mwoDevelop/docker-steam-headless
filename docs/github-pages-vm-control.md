# GitHub Pages VM Control

This repo now contains a static control panel under [`docs/vm-control/`](./vm-control/index.html) and a matching GitHub Actions workflow in [`.github/workflows/vm-control.yml`](../.github/workflows/vm-control.yml).

The page does not talk to GCP directly. Instead:

1. the browser calls the GitHub Actions API with your GitHub token,
2. GitHub Actions authenticates to Google Cloud with a repository secret,
3. the workflow runs `status`, `start`, `stop`, or `restart` against one GCE VM.

## What It Controls

This setup is for the **single-VM GCE flow** in [`gcp-vm/`](../gcp-vm/).

It does **not** control the `gcp-v8s` GKE cluster lifecycle.

## Required Repository Setup

Set these **repository variables** in GitHub:

- `GCP_PROJECT` – target Google Cloud project
- `GCP_ZONE` – target VM zone, for example `europe-central2-b`
- `GCE_NAME` – VM name, for example `steam-gpu`

Set this **repository secret** in GitHub:

- `GCP_SA_KEY` – full JSON key for a Google Cloud service account

Recommended minimum GitHub workflow config:

- keep the workflow file name as `vm-control.yml`
- keep the default branch name in the page config aligned with your real default branch

## Google Cloud Service Account

The workflow needs a service account that can inspect and power-cycle the VM.

Simplest option:

- grant the service account `Compute Instance Admin (v1)` on the project or on the specific VM

If you want a tighter setup, create a custom role containing at least:

- `compute.instances.get`
- `compute.instances.start`
- `compute.instances.stop`
- `compute.instances.reset`
- permissions required to read the corresponding compute operations

## Enable GitHub Pages

The static page lives in `docs/`, so the simple Pages setup is:

1. Open repository `Settings -> Pages`
2. Set `Source` to `Deploy from a branch`
3. Choose your default branch
4. Choose folder `/docs`
5. Save

After Pages is enabled, the panel will be available under something like:

- `https://<owner>.github.io/<repo>/vm-control/`

## GitHub Token For The Browser

The page requires a GitHub token because GitHub Pages is static and has no backend.

Recommended token:

- fine-grained personal access token
- repository access limited to this repo
- permissions:
  - `Actions: Read and write`
  - `Contents: Read-only`

Do not hardcode the token into the page. Enter it in the form when you use the panel.

By default the page stores the token only in browser session storage. If you enable `Remember token on this device`, it moves to local storage on that machine.

## How To Use

1. Open the Pages URL
2. Fill in:
   - GitHub token
   - owner
   - repository
   - branch/ref
   - workflow file name, usually `vm-control.yml`
3. Leave GCP overrides blank if repository variables are already set
4. Use `Start`, `Stop`, `Restart`, or `Status`

The panel lists recent workflow runs and tries to extract:

- final VM power state
- external IP
- prominent access links for noVNC and Sunshine when the VM is running
- host/IP guidance for Moonlight, Sunshine clients, and Steam Remote Play
- the failed workflow step when the latest run does not complete successfully

## Notes

- The `Status` button does not call GCP from the browser. It runs the same workflow in read-only mode.
- If your repo default branch is `main`, change the page field from `master` to `main`.
- If you want to control a different VM temporarily, fill the override fields for project/zone/instance before dispatching the workflow.
