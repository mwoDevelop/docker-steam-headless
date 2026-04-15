# VM State Persistence Plan

## Goal

Preserve the state needed to rebuild the Steam VM from scratch, including:

- Steam login/session state
- Sunshine pairing/auth state
- Sunshine configuration
- user-level application state under the container home
- installed game files under `/mnt/games`

Target outcome:

1. the VM can be fully destroyed and recreated,
2. the required state is restored automatically during bootstrap,
3. Google Drive on `mwodevelop@gmail.com` is the single backup source of truth,
4. secrets do not end up committed to git,
5. normal `Stop` and `Restart` stay reasonably fast.

## Decisions Confirmed

1. Google Drive is used for backup and restore synchronization, not as a live-mounted primary filesystem.
2. The full Steam Headless home tree must be persisted.
3. `/mnt/games` must also survive full rebuilds.
4. Backup/sync should happen automatically.
5. `Delete` must require operator confirmation before backup + destroy.
6. Google Drive credentials may be stored in Secret Manager.
7. The control panel must expose `Create` and `Delete`, with enablement based on VM state.
8. Google Drive storage is pinned to the main account `mwodevelop@gmail.com`; other allowed Google accounts are only for panel login.
9. `/home` and `/mnt/games` should not use the same persistence method.
10. VM storage layout should use one shared data disk for both `/opt/container-data/steam-headless/home` and `/mnt/games`, plus the normal boot disk.
11. `Create` and `Delete` must manage the full lifecycle of that shared data disk; Drive remains the recovery source of truth, not a detached disk left behind after `Delete`.

## Current State

Current deployment already stores the Steam Headless container home on the VM host under:

- host path: `/opt/container-data/steam-headless/home`
- container path: `/home/default`

The game library lives under:

- `/mnt/games`

Current startup path:

- VM metadata provides `steam-headless-env`
- startup script writes `/opt/container-services/steam-headless/.env`
- docker compose mounts `${HOME_DIR}` to `/home/default`

Current persistence behavior already works for `/home` through the host-side backup/restore flow tied to Google Drive.

Current deployment note:

- the existing implementation does not yet define the shared-data-disk lifecycle described below,
- this plan therefore includes both a storage-layout change and a persistence-flow change.

## Discovery Findings

Inspection on the live VM showed:

- Sunshine state lives under `/opt/container-data/steam-headless/home/.config/sunshine`
- key Sunshine files include:
  - `apps.json`
  - `credentials/cacert.pem`
  - `credentials/cakey.pem`
  - `sunshine.conf`
  - `sunshine_state.json`
- Steam state lives under `/opt/container-data/steam-headless/home/.steam`
- key Steam files include:
  - `.steam/steam/config/loginusers.vdf`
  - `.steam/steam/config/config.vdf`
  - `.steam/steam.token`

This means:

- `/home` is the right recovery boundary for Steam auth/session and Sunshine pairing/configuration,
- `/mnt/games` is separate and should be treated as installed content, not lightweight runtime state,
- bootstrap config and secrets must still be restored independently of `/home`.

## Design Direction

### `/home`

Keep the current lightweight backup path:

- restore on `Create` / fresh-create boot
- backup on `Stop`, `Restart`, and `Delete`

Reasoning:

- it contains the authentication/configuration state we actually need often,
- it is relatively small,
- frequent backup is acceptable.

### `/mnt/games`

Do not keep `/mnt/games` on the same directory-level sync path as `/home`.

Instead:

- archive `/mnt/games` only during `Delete`,
- restore that archive only during `Create` / fresh-create boot,
- do not back up `/mnt/games` during `Stop` or `Restart`.

Reasoning:

- game libraries are large,
- frequent sync is too slow and noisy,
- Drive is acceptable as cold storage for installed content, not as frequent operational sync.

## Recommended Architecture

### Runtime

- boot disk for the OS, Docker, bootstrap scripts, and transient host runtime
- one shared data disk for application state
- `/opt/container-data/steam-headless/home` stored on the shared data disk
- `/mnt/games` stored on the same shared data disk
- restore gating based on explicit fresh-create intent, not every ordinary boot

### VM Disk Layout

The VM should have 2 disks total:

1. boot disk
   - operating system
   - Docker engine and packages
   - startup/shutdown/persistence tooling
   - transient machine-local runtime
2. data disk
   - mounted early in boot
   - contains both:
     - `/opt/container-data/steam-headless/home`
     - `/mnt/games`

Lifecycle:

- `Create` creates and attaches a fresh shared data disk
- first boot formats it if needed and mounts it deterministically
- `Delete` removes the VM and its shared data disk only after backup succeeds
- recovery source remains Google Drive, not the deleted disk

Reasoning:

- simpler provisioning than separate disks for home and games,
- fewer moving parts during `Create`,
- both paths represent app-state rather than base system state,
- backup policy can still differ by directory even when both live on the same data disk.

### Backup Storage

Google Drive rooted in the main account `mwodevelop@gmail.com`.

Proposed layout:

- `steam-vm-state/home/home.tar.zst`
- `steam-vm-state/home/manifest.json`
- `steam-vm-state/games/archives/<timestamp>.tar.zst`
- `steam-vm-state/games/current.json`
- `steam-vm-state/games/manifests/<timestamp>.json`
- `steam-vm-state/manifest.json`
- `steam-vm-state/version.txt`

## Scope of Data to Preserve

### Frequent backup scope

- full `/opt/container-data/steam-headless/home`

### Delete-only archive scope

- full `/mnt/games`

### Rebuildable runtime config

- `/opt/container-services/steam-headless/.env`
- generated startup metadata
- temporary/cache files outside the persisted areas
- disk attachment and mount configuration, which should be recreated deterministically during `Create`
- filesystem creation on a blank shared data disk, which should be automated and idempotent

## Proposed Implementation Plan

### Phase 1: Refine Storage Strategy

1. Keep the existing `/home` backup path as-is.
2. Remove `/mnt/games` from the frequent sync path.
3. Make the VM disk model explicit:
   - `boot disk` for system/runtime
   - one shared `data disk` mounted for both persisted app-state paths
4. Define mount strategy for the shared data disk, for example:
   - mount disk at a stable root such as `/mnt/state`
   - bind-mount or symlink:
     - `/mnt/state/home` -> `/opt/container-data/steam-headless/home`
     - `/mnt/state/games` -> `/mnt/games`
   - or mount individual subdirectories in another deterministic way
5. Define shared-data-disk lifecycle rules:
   - `Create` creates a new blank disk of configured size/type
   - startup formats the disk only when no filesystem exists yet
   - startup mounts it through a stable device identity such as UUID, not an unstable device name
   - `Delete` deletes the disk together with the VM after backup success
6. Make the `/home` layout explicit and stable:
   - `steam-vm-state/home/home.tar.zst`
   - `steam-vm-state/home/manifest.json`
   - keep this compatible with the current implementation unless migration is explicitly needed
7. Define a dedicated games archive layout on Drive:
   - immutable archive object: `steam-vm-state/games/archives/<timestamp>.tar.zst`
   - immutable archive manifest: `steam-vm-state/games/manifests/<timestamp>.json`
   - current pointer: `steam-vm-state/games/current.json`
8. Define manifest content for the `/home` backup:
   - timestamp
   - archive object path
   - source path
   - backup format version
9. Define manifest content for the games archive:
   - timestamp
   - archive object path
   - source path
   - compression format
   - approximate size
   - restore format version
   - success marker / publication status
10. Define retention policy for immutable archives:
   - minimum: keep the latest published archive
   - optional: keep the last `N` archives for rollback/debugging

Deliverable:

- final Drive layout for split persistence

### Phase 2: Backup/Restore Tooling Changes

1. Extend `gcp-vm/persist-state.sh` with separate code paths:
   - `/home` backup/restore
   - `/mnt/games` archive/restore
2. Add helpers to ensure the shared data disk is mounted and expected directories exist before backup or restore starts.
3. Add helpers to:
   - detect whether the shared data disk already has a filesystem,
   - create the filesystem on first boot only,
   - mount by UUID or equivalent stable identifier.
4. Implement `/mnt/games` archive as a stream, not a temporary local tarball:
   - backup: `tar -C /mnt -cf - games | zstd | rclone rcat .../archives/<timestamp>.tar.zst`
   - restore: `rclone cat .../archives/<timestamp>.tar.zst | zstd -d | tar -C /mnt -xf -`
5. Ensure Steam/workload is quiesced before backing up `/home` and before creating the games archive.
6. Preserve ownership, permissions, and mountpoint expectations on restore.
7. Refuse restore if `/mnt/games` is non-empty unless the flow is explicitly in fresh-create mode.
8. Publish games backup transactionally:
   - upload archive to a timestamped immutable path,
   - write timestamped manifest,
   - update `current.json` only after both succeed.
9. Restore games through a staging directory, for example:
   - extract to `/mnt/games.restore.<token>`
   - validate extraction success
   - replace the target directory atomically as far as the filesystem allows
   - only then expose the restored tree as `/mnt/games`
10. If `Delete` backup fails after the workload has been quiesced:
   - do not delete the VM,
   - surface a clear failure state,
   - leave the operator with a recoverable machine state,
   - optionally restart the stack if rollback is safe.

Deliverable:

- reusable split backup/restore script

### Phase 3: VM Bootstrap Integration

1. Update startup flow so restore is gated by explicit fresh-create intent.
2. Preferred mechanism:
   - Cloud Run `Create` writes a metadata marker such as `vm-restore-mode=create`
   - startup consumes it exactly once
   - startup clears it after successful restore or after a controlled no-backup path
3. Empty-state probing may be used only as a safety check, not as the primary trigger.
4. Ensure the shared data disk is attached, mounted, and prepared before any restore work begins.
5. If the shared data disk is blank:
   - create the filesystem,
   - create the expected directory layout,
   - then run restore.
6. Restore `/home` before `docker compose up -d` only when the restore gate is open.
7. Restore `/mnt/games` archive before `docker compose up -d` only when the restore gate is open and a valid `current.json` exists.
8. Skip games restore cleanly when no archive exists.
9. Clear the restore gate after successful first boot so subsequent `Stop`/`Start` cycles do not re-import state.
10. Fail safely if the games archive is corrupt:
   - mark restore status,
   - leave the VM bootable,
   - do not start the app stack against a partially restored `/mnt/games`.
11. Keep bootstrap idempotent.

Deliverable:

- startup path with automatic games restore

### Phase 4: Power Action Integration

1. Keep existing behavior for `/home`:
   - `Stop` -> backup `/home`
   - `Restart` -> backup `/home`
   - `Delete` -> backup `/home`
2. Add games archive behavior only to `Delete`:
   - quiesce workload
   - back up `/home`
   - archive `/mnt/games`
   - publish `current.json`
   - delete VM only after both succeed
3. Keep `Create` automatic:
   - if `/home` backup exists, restore it
   - if games archive exists, restore it
   - otherwise continue with empty state
4. On `Delete` failure after backup starts:
   - return a failed command result,
   - do not delete the instance,
   - preserve enough status for the operator to retry or inspect.
5. On successful `Delete`:
   - delete the VM,
   - delete the shared data disk,
   - preserve Drive artifacts as the only recovery source.

Deliverable:

- control-plane semantics aligned with the new split

### Phase 5: Backend and GUI Changes

1. Update Cloud Run API status payload to expose safe persistence metadata:
   - last `/home` backup time
   - last games archive time
   - whether a games archive exists
   - whether the latest games archive is published and restorable
   - whether the last restore succeeded or failed
   - whether restore is currently pending because the instance was freshly created
   - whether the shared data disk is attached and mounted as expected
2. Update GUI messaging so operators understand:
   - `Stop` and `Restart` save state only for `/home`
   - `Delete` performs the full backup including installed games
3. Keep `Delete` confirmation explicit because it may run a long archive step.
4. Show destructive-path progress at a coarse level:
   - quiescing workload
   - backing up home
   - archiving games
   - deleting VM
5. Show failed-delete guidance if the backup/archive phase failed and the VM was intentionally kept.

Deliverable:

- operator-visible persistence status

### Phase 6: Validation

Test matrix:

1. Steam logged in -> backup -> destroy VM -> recreate VM -> restore -> confirm Steam session survives.
2. Sunshine paired with a client -> backup -> destroy VM -> recreate VM -> restore -> confirm pairing survives.
3. Installed game directory tree exists under `/mnt/games` -> `Delete` -> `Create` -> confirm directory structure returns.
4. A known installed game path under `/mnt/games` returns after restore.
5. Restore to a completely blank boot disk.
6. Restore to a completely blank shared data disk.
7. Interrupted upload does not advance `current.json` to a partial archive.
8. Missing games archive does not brick startup.
9. Corrupted games archive fails safely and surfaces a clear status.
10. `Stop` and `Restart` stay materially faster than `Delete`.
11. Ordinary `Stop` -> `Start` on an existing VM does not trigger a full restore of `/home` or `/mnt/games`.
12. A failed restore into the staging directory does not overwrite a previously good `/mnt/games`.
13. A recreated VM correctly creates, attaches, formats if needed, and mounts the shared data disk before restore begins.
14. Successful `Delete` removes the shared data disk rather than leaving orphaned storage behind.

Deliverable:

- recovery and lifecycle test report

## Suggested Order of Work

1. Define and implement shared data-disk lifecycle and mount layout
2. Refactor persistence script to split `/home` and `/mnt/games`
3. Add streamed games archive support
4. Integrate disk preparation and games restore into startup
5. Adjust `Delete` flow to include the games archive and disk deletion
6. Expose status in backend/UI
7. Run full `Delete -> Create` recovery validation

## Risks

- games archive/restore can take a long time for larger libraries
- interrupted `Delete` can leave a stale or partial archive if writes are not made transactional
- restoring a very large archive will lengthen `Create`
- Steam content may still require self-repair after restore in some cases
- Drive bandwidth/quota can become the limiting factor for large libraries
- tar-based restore preserves files, but not block-level disk identity; any software expecting a raw disk image semantics would need a different approach
- a shared data disk increases blast radius versus separate app-state disks, so correctness of mount and backup layout matters more
- if disk identification is implemented incorrectly, a fresh VM can mount the wrong device or fail to mount the data disk; UUID-based mounting is therefore a hard requirement

## First Recommended Next Step

Modify the current persistence implementation so `/mnt/games` leaves the frequent sync path and becomes a `Delete`-only streamed archive with automatic `Create`-time restore. That keeps normal power actions fast and makes installed-game persistence explicit.
