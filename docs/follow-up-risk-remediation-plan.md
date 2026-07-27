# Follow-up Risk Remediation Plan

## Purpose

Address the remaining follow-up items discovered while adding multi-server
Minecraft Modrinth management and repairing the Arch image build. The work is
intentionally split into independently deployable changes. No phase may assume
that a UI state, metadata value, or successful image build proves runtime
correctness.

## Current Findings

1. Minecraft content is now stored in each entry of `vm-minecraft-servers`.
   Older VMs can still have a legacy global
   `vm-minecraft-modrinth-content` value. A registry that already exists but
   has no per-server content would hide that legacy value.
2. Modrinth search filters projects by game version and loader category. The
   actual downloadable version is checked during installation. A project can
   still match a category but lack a downloadable artifact for the exact game
   version and loader.
3. The image build is green after removing unavailable `ttf-msfonts`, but CI
   reports Node.js 20 deprecation warnings for pinned GitHub Actions and
   `SecretsUsedInArgOrEnv` warnings for default password environment values in
   both Dockerfiles.
4. Local Docker validation is unavailable in the current WSL session because
   `/var/run/docker.sock` is absent. This is an environment issue, not evidence
   of an image or source failure.

## Non-goals

- Do not migrate or delete VM metadata without a verified backup and a
  deterministic server mapping.
- Do not expose Minecraft RCON or runtime secrets to the Internet.
- Do not replace pinned GitHub Actions with floating tags.
- Do not change deployed Steam, Sunshine, or Minecraft credentials as part of
  image-warning cleanup.

## Independent Plan Review and Amendments

The initial plan was reviewed as a production change with concurrent VM
actions, external package data, and CI publication in scope. The following
gaps were found and are resolved by the amendments below.

1. **Metadata migration can race with an active content action.** A read-copy-
   write migration without an instance metadata fingerprint can overwrite a
   new agent result or another administrator action. Migration must therefore
   use an endpoint-level action lock and optimistic concurrency/retry based on
   the Compute Engine metadata fingerprint.
2. **The registry may not be the only runtime source of truth.** Before a
   migration, trace how the VM startup and management-agent scripts consume
   the registry, legacy content metadata, and generated manifests. Migration
   cannot remove or stop updating a legacy key until that execution path is
   proven to use the registry for the selected server.
3. **Loader-category search is not sufficient compatibility proof.** Exact
   Modrinth version checks must also reject client-only artifacts and retain
   the selected file name and checksum for the VM agent to verify after
   download.
4. **Per-result verification can amplify external API load.** Search needs a
   bounded concurrency, a cache, a deadline, and a clear partial-result policy
   so an outage or 429 response does not make the administration page hang.
5. **CI security warnings have different meanings.** A placeholder default
   and a deployed secret are not equivalent. The design must first prove that
   no production credential is embedded in an image, then remove or isolate
   placeholders without changing runtime precedence accidentally.
6. **A successful CI test must not silently publish an unreviewed production
   tag.** Dependency and Dockerfile validation needs a non-publishing PR or
   test-tag path before a master release publishes `latest`.

## Phase 0: Baseline and Safety Gate

### Analysis

1. Inventory every live endpoint and read, without mutation:
   - `vm-minecraft-servers`
   - `vm-minecraft-modrinth-content`
   - active Minecraft server ID, runtime, version, state, and content list
2. Classify each VM as one of:
   - legacy singleton: no server registry, global content may belong to
     `default`
   - unambiguous registry: exactly one non-removed server with legacy content
   - ambiguous registry: multiple non-removed servers with legacy content
   - already migrated: content is present only in the registry
3. Save a timestamped metadata backup before any migration. Include endpoint,
   zone, instance name, source metadata values, and a SHA-256 checksum.
4. Trace the complete runtime path from instance metadata through the startup
   script, generated Minecraft manifests, and the management agent. Record
   which value is authoritative at boot and during `content-sync`.
5. Acquire an endpoint-scoped migration lock and capture the Compute Engine
   metadata fingerprint before reading any source value. Refuse migration if
   a VM power action or content action is active.

### Decision gate

- Migrate automatically only the legacy-singleton and unambiguous cases.
- For an ambiguous case, display the old content in the administrator panel as
  `migration pending` and require an administrator to choose the destination
  server. Never guess based solely on the currently running server.

### Tests and acceptance

1. Fixture tests cover all four classifications.
2. Read-only production inventory matches fixture classification before a
   write is enabled.
3. Restore test proves the backup can recreate the original metadata exactly.

## Phase 1: Versioned Per-server Content Migration

### Implementation

1. Add a schema version and migration marker to `vm-minecraft-servers`.
2. Add an idempotent backend migration function:
   - normalize legacy content with the existing validation rules
   - copy it, never move it, to the selected server entry
   - use the captured metadata fingerprint for compare-and-set; reload and
     retry only when the source state is still equivalent
   - retain the legacy metadata until post-migration verification completes
   - write an audit record with source checksum, destination server ID, and
     migration timestamp
3. Add an administrator-only migration screen for ambiguous assignments and
   status visibility for every endpoint.
4. Remove legacy metadata only through an explicit cleanup action after the
   registry value, live installed files, and UI all agree.

### Tests and acceptance

1. Unit tests: empty, malformed, duplicate, legacy singleton, unambiguous,
   ambiguous, and rerun/idempotency cases.
2. Concurrency tests simulate a content install or VM state update between
   migration read and write; migration must retry safely or fail without
   losing either update.
3. E2E: install a different test add-on on two disposable running servers, refresh both
   pages, and verify that each sees only its own content.
4. E2E: remove one add-on and verify the other server remains unchanged.
5. Rollback: restore the captured metadata backup and confirm the old UI state
   is recovered.

## Phase 2: Exact Modrinth Artifact Compatibility

### Implementation

1. Keep the current broad search facets for responsiveness:
   - project type
   - Minecraft version
   - runtime loader categories
2. For every displayed hit, query the Modrinth version endpoint with the exact
   selected game version and loader list before rendering it as installable.
   Reject client-only artifacts and select one exact downloadable server-side
   file with its published checksum.
3. Cache compatibility checks by `(projectId, gameVersion, loaders)` for a
   short TTL, for example 10 minutes. Bound concurrent requests to avoid a
   search causing an API burst, apply a total search deadline, and use a
   short-lived circuit breaker after Modrinth rate limiting or outage.
4. Render only candidates with at least one exact artifact. If a catalog check
   times out, mark that candidate `verification unavailable` and disable its
   install button rather than presenting it as compatible. Apply verified
   partial results and display the number of skipped candidates.
5. Preserve the server-side exact check during installation as the mandatory
   final authorization point. Pass the chosen file identity and checksum to
   the VM agent, which must verify the downloaded file before activation.

### Tests and acceptance

1. Mock Modrinth responses for category-only matches with no exact artifact;
   they must not be installable.
2. Test Paper, Fabric, Forge, NeoForge, legacy/default, client-only, and
   multi-file server-side fixtures.
3. E2E on a running server: search, install, verify the agent result and file
   metadata, remove, then verify an empty per-server list.
4. Failure tests: Modrinth 429, timeout, invalid JSON, and no compatible
   artifact; no metadata or container mutation may occur.

## Phase 3: CI Runtime and Secret Hygiene

### Analysis and design

1. Identify the latest supported, commit-pinned revisions of each GitHub
   Action that runs on Node.js 24. Confirm provenance and release notes before
   updating each SHA.
2. Identify whether `USER_PASSWORD`, `NEKO_PASSWORD`, and
   `NEKO_PASSWORD_ADMIN` are required as build defaults or only runtime
   defaults. Trace compose files, entrypoints, Cloud Run deployment templates,
   and VM startup scripts before changing them.
3. Define runtime behavior when a password is absent:
   - reject insecure production configuration, or
   - generate it at deployment and store it in Secret Manager.
   The final choice must preserve the existing administrator password flow.
4. Define a non-publishing validation path for Dockerfile and action updates:
   pull request, `workflow_dispatch` input, or an immutable test image tag.
   It must run the full matrix without updating `latest` or stable tags.

### Implementation

1. Update Actions one at a time to verified, pinned Node.js 24-compatible
   revisions. Add Dependabot or an equivalent review workflow for future
   action updates.
2. Replace image-embedded credential defaults with non-secret configuration
   plumbing. Pass actual values only at deployment/runtime from existing secret
   sources.
   - first classify every current value as placeholder, development default, or
     production credential
   - keep documented placeholder behavior only when the runtime rejects it for
     externally reachable deployments
3. Add a CI policy check that fails when a password-like value is added to a
   Dockerfile `ARG` or `ENV`, except documented non-secret placeholders.

### Tests and acceptance

1. Build both Debian and Arch images in the non-publishing validation path,
   then repeat on the approved publishing path and verify image publication.
2. Start each image with production-equivalent runtime secrets and verify the
   expected web UI and Sunshine authentication path.
3. Confirm image inspection and build logs contain no actual credential value.
4. Confirm GitHub Actions no longer emits the Node.js 20 deprecation warning.

## Phase 4: Local Docker/WSL Developer Environment

### Analysis

1. Detect whether Docker Desktop integration or a native WSL Docker daemon is
   the intended local engine.
2. Record `docker context ls`, `docker version`, socket ownership, WSL
   interop, and systemd service state without restarting anything.
3. Provide separate remediation instructions for Docker Desktop integration
   and native `docker.service`; do not enable both concurrently.

### Tests and acceptance

1. `docker version` reports both client and server from WSL.
2. `docker buildx build --check -f Dockerfile.arch .` succeeds locally.
3. A non-publishing Arch build succeeds with the same build arguments used by
   CI.

## Rollout Order

1. Phase 0, then Phase 1 as a separately reviewed release.
2. Phase 2 after content migration, because its E2E tests depend on reliable
   per-server state.
3. Phase 3 in isolated CI/security commits; no VM-control behavior changes in
   the same release.
4. Phase 4 is documented operational work and does not block production
   deployment.

## Completion Criteria

The remediation is complete only when:

1. Every live server has a verified content ownership state or an explicit
   administrator migration decision.
2. The UI never presents a non-installable Modrinth result as installable.
3. Both image flavours build and publish with no Node.js 20 warning, and the
   remaining Dockerfile credential policy is either warning-free or explicitly
   justified by a reviewed placeholder exception that contains no production
   secret.
4. A developer can reproduce the Arch validation locally with a documented
   Docker/WSL setup.
