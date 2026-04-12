# VM State Persistence Plan

## Goal

Preserve user state needed to rebuild the Steam VM from scratch, including:

- Steam login/session state
- Sunshine pairing/auth state
- Sunshine configuration
- selected user-level application state stored under the container home

The target outcome is:

1. the VM can be fully destroyed and recreated,
2. the required state is restored automatically during bootstrap,
3. the source of truth is controlled from the Google account `mwodevelop`,
4. secrets do not end up committed to git.

## Decisions Confirmed

1. Google Drive will be used for backup and restore synchronization, not as a live-mounted primary filesystem.
2. The full Steam Headless home tree must be persisted at minimum.
3. Both `/opt/container-data/steam-headless/home` and `/mnt/games` must be persisted.
4. Backup/sync should happen automatically.
5. `Delete` must require operator confirmation before backup + destroy.
4. Google Drive credentials may be stored in Secret Manager.
5. The control panel must gain `Create` and `Delete` actions, with button enablement depending on VM state.

## Current State

Current deployment already stores the Steam Headless container home on the VM host under:

- host path: `/opt/container-data/steam-headless/home`
- container path: `/home/default`

This means Steam and Sunshine state is already concentrated in one host directory tree, which is a good recovery boundary.

Current startup path:

- VM metadata provides `steam-headless-env`
- startup script writes `/opt/container-services/steam-headless/.env`
- docker compose mounts `${HOME_DIR}` to `/home/default`

## Discovery Findings (2026-04-12)

Inspection on the live VM shows:

- Sunshine state is stored under `/opt/container-data/steam-headless/home/.config/sunshine`
- key Sunshine files observed:
  - `apps.json`
  - `credentials/cacert.pem`
  - `credentials/cakey.pem`
  - `sunshine.conf`
  - `sunshine_state.json`
- Steam state is stored under `/opt/container-data/steam-headless/home/.steam`
- key Steam files observed:
  - `.steam/steam/config/loginusers.vdf`
  - `.steam/steam/config/config.vdf`
  - `.steam/steam.token`

This means:

- for Steam authentication/session state and Sunshine pairing/configuration, backing up the full `/opt/container-data/steam-headless/home` tree should cover the critical user-state data,
- however, `/home` alone is not the whole machine state.

Important data outside `/home`:

- `/opt/container-services/steam-headless/.env`
  - runtime environment for the stack
  - includes Sunshine web credentials and other deployment settings
  - should be reproducible from metadata/bootstrap, not treated as the primary user-state backup payload
- `/mnt/games`
  - game library mount
  - not required for auth/session restore, but required if full installed game data should survive rebuilds

Practical conclusion:

- for the stated goal of preserving authentication/authorization and application configuration, backing up `/home` is a sound baseline,
- if the goal expands to full environment restoration including installed games, `/mnt/games` needs its own persistence strategy,
- bootstrap config and secrets must still be restored independently of `/home`.

## Important Technical Note

Using Google Drive as a live mounted filesystem for the full active home directory is possible in theory via `rclone mount`, but it is a weak fit for this workload because:

- Steam and Sunshine keep mutable state and may rely on filesystem semantics that FUSE-backed Drive mounts do not handle well,
- file locking and sqlite-like access patterns can be fragile,
- latency and partial sync behavior can corrupt or stale the restored state,
- boot reliability becomes dependent on Drive mount health.

Because of that, the preferred design is:

- local fast disk for runtime,
- Google Drive as backup/export source of truth for recovery,
- bootstrap restore from Drive into local disk,
- automatic sync back to Drive during lifecycle actions.

## Recommended Architecture

### Option A: Recommended

Runtime state on local VM disk, recovery state in Google Drive.

Flow:

1. VM starts.
2. Bootstrap script authenticates to Google Drive as `mwodevelop`.
3. If backup state exists, restore it into `/opt/container-data/steam-headless/home`.
4. Start docker compose.
5. On stop, restart, delete, or explicit maintenance actions, sync state back to Drive.

### Option B: Not Recommended Except for Experiments

Mount a Drive-backed filesystem directly into `/opt/container-data/steam-headless/home`.

This is operationally simpler on paper, but much higher risk for data corruption and broken app behavior.

## Scope of Data to Preserve

Baseline persistence scope:

- full `/opt/container-data/steam-headless/home`

Additional scope to evaluate separately:

- `/mnt/games` if installed games should survive full rebuild
- selected bootstrap/runtime config outside `/home` only when it cannot be reconstructed deterministically

Why this split:

- `/home` appears sufficient for Steam auth/session and Sunshine pairing/configuration,
- `/mnt/games` is likely large and should not be bundled into the same lightweight auth-state backup flow by default.

## Proposed Implementation Plan

### Phase 0: Discovery

1. Inspect the live VM and identify which files actually change after:
   - Steam login
   - Sunshine pairing
   - Sunshine Web UI login/config changes
2. Separate:
   - state required for recovery,
   - cache/temp files,
   - machine-specific runtime files that should not be restored verbatim.
3. Produce a persistence manifest with:
   - mandatory `/home`,
   - optional `/mnt/games`,
   - explicitly excluded runtime-rebuildable files.

Deliverable:

- a documented allowlist of directories/files to persist

### Phase 1: Storage Strategy

1. Decide the persistence medium:
   - preferred: Google Drive as backup store
   - fallback/recommended for robustness: separate persistent disk plus optional Drive export
2. Decide the integration method:
   - `rclone copy/sync` to Drive
   - or Drive API upload/download through a helper
3. Define the Drive layout, for example:
   - `Google Drive/steam-vm-state/home.tar.zst`
   - `Google Drive/steam-vm-state/games.tar.zst` or a separate sync root if game persistence is enabled
   - `Google Drive/steam-vm-state/manifest.json`
   - `Google Drive/steam-vm-state/version.txt`

Deliverable:

- final storage design and on-disk/on-Drive layout

### Phase 2: Google Drive Authentication

1. Create a non-git-tracked credential path for Drive access.
2. Prefer one of:
   - service account with access to a dedicated Drive folder,
   - OAuth token created once by `mwodevelop` and stored only in local secret files / secret manager.
3. Ensure startup scripts can access the credential material without committing it to repo.

Deliverable:

- secret handling design
- local file paths and deployment flow for credentials

### Phase 3: Backup/Restore Tooling

1. Add a host-side script, for example `gcp-vm/persist-state.sh`, with commands:
   - `backup`
   - `restore`
   - `status`
2. Implement:
   - pre-backup container quiesce or stop
   - tar/zstd packaging of persisted state
   - upload to Drive
   - download and restore on fresh VM
   - ownership and permissions fixup
   - separate handling for `/home` and optional `/mnt/games`
3. Keep backup artifacts out of git and off the public web UI.

Deliverable:

- reusable backup/restore script

### Phase 4: VM Bootstrap Integration

1. Update startup flow to:
   - install `rclone` or chosen Drive helper,
   - configure credentials,
   - restore persisted state before `docker compose up -d`,
   - skip restore gracefully when no backup exists.
2. Ensure bootstrap is idempotent.
3. Ensure rebuild on a blank VM restores the expected state automatically.

Deliverable:

- modified startup bootstrap path

### Phase 5: Control Plane Integration

1. Extend Cloud Run API and UI with explicit actions:
   - `Backup State`
   - `Restore State`
   - `Create`
   - `Delete`
   - `Last Backup`
2. Run backup automatically on:
   - `Stop`
   - `Restart`
   - `Delete`
3. Add state-based enablement to `Power Actions`, for example:
   - `Start` only when instance exists and is stopped
   - `Restart` only when instance is running
   - `Stop` only when instance is running
   - `Status` whenever instance exists
   - `Delete` only when instance exists
   - `Create` only when instance does not exist
3. Show only safe metadata in UI:
   - last backup time
   - backup status
   - manifest version
   - instance existence / lifecycle state

Deliverable:

- operator-visible persistence controls

### Phase 6: Validation

Test matrix:

1. Steam logged in -> backup -> destroy VM -> recreate VM -> restore -> confirm Steam session survives.
2. Sunshine paired with a client -> backup -> destroy VM -> recreate VM -> restore -> confirm pairing survives.
3. Sunshine web credentials still work after restore.
4. Restore to a completely blank boot disk.
5. Delete VM -> Create VM -> automatic restore -> confirm expected state returns.
6. Corrupted/missing backup path fails safely without bricking VM startup.

Deliverable:

- recovery test report

## Suggested Order of Work

1. Discovery on the current live VM
2. Persistence manifest
3. Choose storage/auth approach
4. Implement backup/restore script
5. Integrate restore into startup
6. Add `Create` / `Delete` and persistence controls to backend/UI
7. Run destruction-and-recovery validation

## Risks

- Google Drive mount semantics may not be safe for live app state
- restored machine-specific files may break a recreated VM
- Steam session tokens may expire independently of filesystem restore
- Sunshine pairing may depend on keys plus network identity details
- startup time will increase if restore is large
- `/mnt/games` may be too large for frequent Google Drive sync if enabled

## Open Questions

1. Should `Create` always attempt restore automatically when backup artifacts exist, or should restore be separately confirmable?

## First Recommended Next Step

Implement the persistence manifest and backup/restore tooling around full `/home` first, while explicitly leaving `/mnt/games` as a separate decision point.
