(function () {
  const defaultBackendUrl = "https://steam-vm-control-api-w2urpq2xlq-lm.a.run.app";
  const storageKeys = {
    config: "vm-control-cloudrun-config",
    sessionToken: "vm-control-google-session-token",
    history: "vm-control-session-history",
  };
  const adminSessionRequest = "vm-control-admin-session-request";
  const adminSessionResponse = "vm-control-admin-session-response";
  const ADMIN_REFRESH_INTERVAL_MS = 15_000;

  const elements = {
    backendUrl: document.querySelector("#backend-url"),
    connect: document.querySelector("#connect"),
    authStatus: document.querySelector("#auth-status"),
    googleSignIn: document.querySelector("#google-sign-in"),
    signOut: document.querySelector("#sign-out"),
    adminProtectedContent: document.querySelector("#admin-protected-content"),
    adminAccessDenied: document.querySelector("#admin-access-denied"),
    accessDeniedEmail: document.querySelector("#access-denied-email"),
    accessDeniedChangeAccount: document.querySelector("#access-denied-change-account"),
    adminSummary: document.querySelector("#admin-summary"),
    addUserForm: document.querySelector("#add-user-form"),
    userEmail: document.querySelector("#user-email"),
    addUser: document.querySelector("#add-user"),
    addEndpointForm: document.querySelector("#add-endpoint-form"),
    endpointId: document.querySelector("#endpoint-id"),
    endpointDomain: document.querySelector("#endpoint-domain"),
    addEndpoint: document.querySelector("#add-endpoint"),
    adminMessage: document.querySelector("#admin-message"),
    usersList: document.querySelector("#users-list"),
    endpointsList: document.querySelector("#endpoints-list"),
    migrationSource: document.querySelector("#migration-source"),
    migrationMode: document.querySelector("#migration-mode"),
    migrationTargetZone: document.querySelector("#migration-target-zone"),
    migrationTargetEndpoint: document.querySelector("#migration-target-endpoint"),
    prepareMigration: document.querySelector("#prepare-migration"),
    migrationSnapshotCount: document.querySelector("#migration-snapshot-count"),
    migrationStatus: document.querySelector("#migration-status"),
    migrationTargets: document.querySelector("#migration-targets"),
    refreshRuntimeImages: document.querySelector("#refresh-runtime-images"),
    runtimeEndpoint: document.querySelector("#runtime-endpoint"),
    runtimeImagesList: document.querySelector("#runtime-images-list"),
    compatibilityForm: document.querySelector("#compatibility-form"),
    compatibilityHardware: document.querySelector("#compatibility-hardware"),
    compatibilityImageRef: document.querySelector("#compatibility-image-ref"),
    compatibilityImageTag: document.querySelector("#compatibility-image-tag"),
    compatibilitySunshineVersion: document.querySelector("#compatibility-sunshine-version"),
    compatibilityDriverVersion: document.querySelector("#compatibility-driver-version"),
    compatibilityResult: document.querySelector("#compatibility-result"),
    compatibilityEvidence: document.querySelector("#compatibility-evidence"),
    saveCompatibility: document.querySelector("#save-compatibility"),
    compatibilityList: document.querySelector("#compatibility-list"),
    sunshineEndpoint: document.querySelector("#sunshine-endpoint"),
    sunshineCurrentPassword: document.querySelector("#sunshine-current-password"),
    sunshinePasswordToggle: document.querySelector("#sunshine-password-toggle"),
    sunshineCredentialsSummary: document.querySelector("#sunshine-credentials-summary"),
    sunshinePasswordForm: document.querySelector("#sunshine-password-form"),
    sunshinePasswordInput: document.querySelector("#sunshine-password-input"),
    sunshinePasswordSubmit: document.querySelector("#sunshine-password-submit"),
    softwareEndpoint: document.querySelector("#software-endpoint"),
    softwareApplication: document.querySelector("#software-application"),
    softwareApplicationState: document.querySelector("#software-application-state"),
    softwareMinecraftVersion: document.querySelector("#software-minecraft-version"),
    softwareMinecraftServerType: document.querySelector("#software-minecraft-server-type"),
    softwareMinecraftServer: document.querySelector("#software-minecraft-server"),
    softwareMinecraftNewServer: document.querySelector("#software-minecraft-new-server"),
    softwareMinecraftCreateHint: document.querySelector("#software-minecraft-create-hint"),
    softwareMinecraftCreatePanel: document.querySelector("#software-minecraft-create-panel"),
    softwareMinecraftExistingPanel: document.querySelector("#software-minecraft-existing-panel"),
    softwareMinecraftServerSummary: document.querySelector("#software-minecraft-server-summary"),
    softwareRefreshMinecraftVersions: document.querySelector("#software-refresh-minecraft-versions"),
    softwareActions: document.querySelector("#software-actions"),
    softwareStatus: document.querySelector("#software-status"),
    softwareLiveAccess: document.querySelector("#software-live-access"),
  };

  const state = {
    backendUrl: "",
    backendConfig: null,
    googleInitializedFor: "",
    googleTokenClient: null,
    token: "",
    user: null,
    viewer: null,
    accessDenied: false,
    isBusy: false,
    usersPayload: null,
    endpointsPayload: null,
    migrationsPayload: null,
    runtimeImagesPayload: null,
    compatibilityPayload: null,
    sunshineCredentialsPayload: null,
    sunshineEndpointId: "",
    sunshinePasswordVisible: false,
    softwarePayload: null,
    softwareEndpointId: "",
    softwareMinecraftSelection: "",
    refreshRevision: 0,
    automaticRefreshInFlight: false,
  };
  let automaticRefreshTimer = 0;
  let adminLoaderDeferredTimer = 0;

  function loadConfig() {
    const saved = JSON.parse(window.localStorage.getItem(storageKeys.config) || "{}");
    state.backendUrl = saved.backendUrl || defaultBackendUrl;
    state.token = window.sessionStorage.getItem(storageKeys.sessionToken) || "";
    elements.backendUrl.value = state.backendUrl;
    updateUi();
  }

  function saveConfig() {
    state.backendUrl = String(elements.backendUrl.value || "").trim().replace(/\/+$/, "");
    const saved = JSON.parse(window.localStorage.getItem(storageKeys.config) || "{}");
    saved.backendUrl = state.backendUrl;
    window.localStorage.setItem(storageKeys.config, JSON.stringify(saved));
  }

  function vmControlLoaderVisible() {
    const loader = document.querySelector("#page-loader");
    return Boolean(loader && !loader.hidden);
  }

  function setAdminPageLoading(nextBusy, message) {
    const loader = document.querySelector("#admin-page-loader");
    const loaderMessage = document.querySelector("#admin-page-loader-message");
    if (!loader) {
      return;
    }
    window.clearTimeout(adminLoaderDeferredTimer);
    if (!nextBusy) {
      loader.hidden = true;
      loader.setAttribute("aria-busy", "false");
      return;
    }
    if (loaderMessage && message) {
      loaderMessage.textContent = message || "Updating administrator controls...";
    }
    const showWhenVmControlLoaderIsGone = () => {
      if (!state.isBusy) {
        return;
      }
      if (vmControlLoaderVisible()) {
        loader.hidden = true;
        loader.setAttribute("aria-busy", "false");
        adminLoaderDeferredTimer = window.setTimeout(showWhenVmControlLoaderIsGone, 80);
        return;
      }
      loader.hidden = false;
      loader.setAttribute("aria-busy", "true");
    };
    showWhenVmControlLoaderIsGone();
  }

  function setBusy(nextBusy, loadingMessage) {
    const wasBusy = state.isBusy;
    if (nextBusy && !state.isBusy) {
      state.refreshRevision += 1;
    }
    state.isBusy = nextBusy;
    setAdminPageLoading(nextBusy, loadingMessage || (!wasBusy ? "Updating administrator controls..." : ""));
    elements.connect.disabled = nextBusy;
    elements.googleSignIn.disabled = nextBusy || !state.backendConfig;
    elements.addUser.disabled = nextBusy || !state.user;
    elements.userEmail.disabled = nextBusy || !state.user;
    elements.addEndpoint.disabled = nextBusy || !state.user;
    elements.endpointId.disabled = nextBusy || !state.user;
    elements.endpointDomain.disabled = nextBusy || !state.user;
    document.querySelectorAll("[data-minecraft-management]").forEach((input) => {
      input.disabled = nextBusy || input.dataset.minecraftManagementLocked === "true";
    });
    document.querySelectorAll("[data-administrator]").forEach((input) => {
      input.disabled = nextBusy || input.dataset.administratorLocked === "true";
    });
    document.querySelectorAll("[data-endpoint-action], [data-endpoint-zone]").forEach((input) => {
      input.disabled = nextBusy || !state.user || input.dataset.endpointDisabled === "true";
    });
    const migrationLoaded = Boolean(state.migrationsPayload);
    [elements.migrationSource, elements.migrationMode, elements.migrationTargetZone, elements.migrationTargetEndpoint, elements.prepareMigration].forEach((input) => {
      input.disabled = nextBusy || !state.user || !migrationLoaded || input.dataset.migrationDisabled === "true";
    });
    document.querySelectorAll("[data-migration-action]").forEach((input) => {
      input.disabled = nextBusy || !state.user || input.dataset.migrationDisabled === "true";
    });
    const hasVmEndpoint = vmEndpoints(state.endpointsPayload && state.endpointsPayload.endpoints).length > 0;
    const hasRuntimeVmEndpoint = vmEndpoints(state.runtimeImagesPayload && state.runtimeImagesPayload.endpoints).length > 0;
    elements.refreshRuntimeImages.disabled = nextBusy || !state.user;
    elements.runtimeEndpoint.disabled = nextBusy || !state.user || !hasRuntimeVmEndpoint;
    document.querySelectorAll("[data-runtime-action], [data-runtime-image-select]").forEach((input) => {
      input.disabled = nextBusy || !state.user || input.dataset.runtimeDisabled === "true";
    });
    [
      elements.compatibilityHardware,
      elements.compatibilityImageRef,
      elements.compatibilityImageTag,
      elements.compatibilitySunshineVersion,
      elements.compatibilityDriverVersion,
      elements.compatibilityResult,
      elements.compatibilityEvidence,
      elements.saveCompatibility,
    ].forEach((input) => {
      input.disabled = nextBusy || !state.user;
    });
    document.querySelectorAll("[data-compatibility-remove]").forEach((input) => {
      input.disabled = nextBusy || !state.user;
    });
    const sunshinePayload = state.sunshineCredentialsPayload || {};
    const canUpdateSunshine = Boolean(sunshinePayload.canUpdate);
    const canRevealSunshine = Boolean(sunshinePayload.passwordAvailable);
    elements.sunshineEndpoint.disabled = nextBusy || !state.user || !hasVmEndpoint;
    elements.sunshinePasswordToggle.disabled = nextBusy || !state.user || !canRevealSunshine;
    elements.sunshinePasswordInput.disabled = nextBusy || !state.user || !canUpdateSunshine;
    elements.sunshinePasswordSubmit.disabled = nextBusy || !state.user || !canUpdateSunshine;
    const softwareLoaded = Boolean(state.softwarePayload) && hasVmEndpoint;
    [
      elements.softwareEndpoint,
      elements.softwareApplication,
      elements.softwareMinecraftVersion,
      elements.softwareMinecraftServerType,
      elements.softwareMinecraftServer,
      elements.softwareMinecraftNewServer,
      elements.softwareRefreshMinecraftVersions,
    ].forEach((input) => {
      input.disabled = nextBusy || !state.user || !softwareLoaded;
    });
    document.querySelectorAll("[data-software-command]").forEach((input) => {
      input.disabled = nextBusy || !state.user || !softwareLoaded || input.dataset.softwareDisabled === "true";
    });
  }

  function setAuthStatus(message, tone) {
    elements.authStatus.textContent = message;
    elements.authStatus.dataset.tone = tone || "neutral";
  }

  function setMessage(message, tone) {
    elements.adminMessage.textContent = message;
    elements.adminMessage.dataset.tone = tone || "neutral";
  }

  function updateUi() {
    const authorized = Boolean(state.user && state.user.isAdmin);
    const denied = Boolean(state.accessDenied && !authorized);
    const viewerEmail = String(state.viewer && state.viewer.email || "");
    elements.adminProtectedContent.hidden = !authorized;
    elements.adminAccessDenied.hidden = !denied;
    elements.accessDeniedEmail.textContent = viewerEmail || "the currently signed-in account";
    elements.googleSignIn.classList.toggle("hidden", authorized);
    elements.googleSignIn.textContent = denied ? "Use another Google account" : "Sign in with Google";
    if (state.user) {
      setAuthStatus(`Signed in as ${state.user.email}`, "success");
      elements.signOut.classList.remove("hidden");
    } else if (denied) {
      setAuthStatus(
        viewerEmail
          ? `Signed in as ${viewerEmail}. This account is not an administrator.`
          : "This authenticated Google account is not an administrator.",
        "error",
      );
      elements.signOut.classList.remove("hidden");
    } else if (state.backendConfig) {
      setAuthStatus("Backend connected. Sign in with the administrator Google account.", "warning");
      elements.signOut.classList.add("hidden");
    } else {
      setAuthStatus("Connect the backend, then sign in with Google.", "neutral");
      elements.signOut.classList.add("hidden");
    }
    renderUsers();
    renderEndpoints();
    renderMigrations();
    renderRuntimeImages();
    renderCompatibility();
    renderSunshineCredentials();
    renderSoftware();
    setBusy(state.isBusy);
  }

  function selectAdminTab(requestedTab) {
    const tabs = [...document.querySelectorAll("[data-admin-tab]")];
    const panels = [...document.querySelectorAll("[data-admin-tab-panel]")];
    const selectedTab = tabs.some((tab) => tab.dataset.adminTab === requestedTab) ? requestedTab : "vm-control";
    tabs.forEach((tab) => {
      const selected = tab.dataset.adminTab === selectedTab;
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-selected", String(selected));
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.adminTabPanel !== selectedTab;
    });
    window.dispatchEvent(new CustomEvent("vm-control:tab-activated", { detail: { tab: selectedTab } }));
    if (selectedTab === "activity") {
      renderActivityHistory();
    }
    if (selectedTab === "software" && state.user && !state.isBusy) {
      refreshAdminDataInBackground();
    }
  }

  function renderActivityHistory() {
    const container = document.querySelector("#admin-history");
    if (!container) return;
    let history = [];
    try {
      const stored = JSON.parse(window.localStorage.getItem(storageKeys.history) || "[]");
      history = Array.isArray(stored) ? stored : [];
    } catch (error) {
      history = [];
    }
    if (!history.length) {
      container.className = "runs empty";
      container.textContent = "No actions recorded yet in this browser.";
      return;
    }
    container.className = "runs";
    container.innerHTML = history.slice(0, 20).map((entry) => {
      const title = escapeHtml(`${String(entry.command || "status").toUpperCase()} · ${entry.status || "UNKNOWN"}`);
      const time = escapeHtml(new Date(entry.at).toLocaleString());
      const by = entry.userEmail ? `by ${escapeHtml(entry.userEmail)}` : "unknown user";
      const message = entry.message ? `<div class="run-detail">${escapeHtml(entry.message)}</div>` : "";
      return `
        <article class="run-card">
          <div class="run-top">
            <h3 class="run-title">${title}</h3>
            <span class="run-time">${time}</span>
          </div>
          <div class="run-detail">${by}</div>
          ${message}
        </article>
      `;
    }).join("");
  }

  function initializeAdminTabs() {
    document.querySelectorAll("[data-admin-tab]").forEach((tab) => {
      tab.addEventListener("click", () => {
        const selectedTab = tab.dataset.adminTab || "access";
        window.history.replaceState(null, "", `#${selectedTab}`);
        selectAdminTab(selectedTab);
      });
    });
    window.addEventListener("hashchange", () => selectAdminTab(window.location.hash.slice(1)));
    selectAdminTab(window.location.hash.slice(1) || "vm-control");
    return true;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderUsers() {
    const payload = state.usersPayload;
    if (!payload) {
      elements.adminSummary.innerHTML = "<p>Sign in to load managed users.</p>";
      elements.usersList.innerHTML = "";
      return;
    }
    const rows = payload.accounts || [
      ...(payload.adminEmails || []).map((email) => ({ email, source: "administrator", minecraftManagement: true, minecraftManagementLocked: true, administrator: true, administratorLocked: true, removable: false })),
      ...(payload.configuredEmails || []).map((email) => ({ email, source: "configured env", minecraftManagement: false, minecraftManagementLocked: false, administrator: false, administratorLocked: false, removable: false })),
      ...(payload.managedUsers || []).map((email) => ({ email, source: "managed", minecraftManagement: Boolean((payload.managedUserPermissions || {})[email]), minecraftManagementLocked: false, administrator: Boolean((payload.managedUserAdministratorPermissions || {})[email]), administratorLocked: false, removable: true })),
    ];
    const endpointCount = Array.isArray(state.endpointsPayload?.endpoints) ? state.endpointsPayload.endpoints.length : 0;
    const administratorCount = rows.filter((account) => Boolean(account.administrator)).length;
    elements.adminSummary.innerHTML = `
      <p><strong>Administrators:</strong> <code>${escapeHtml((payload.adminEmails || []).join(", ") || String(administratorCount))}</code></p>
      <p><strong>Accounts with GUI access:</strong> <code>${rows.length}</code></p>
      <p><strong>Registered VM endpoints:</strong> <code>${endpointCount}</code></p>
    `;
    if (!rows.length) {
      elements.usersList.innerHTML = '<div class="admin-user-row fixed">No direct users configured.</div>';
      return;
    }
    elements.usersList.innerHTML = rows.map((row) => {
      const button = row.removable
        ? `<button class="action delete" type="button" data-remove-user="${escapeHtml(row.email)}">Remove</button>`
        : `<span>${escapeHtml(row.source)}</span>`;
      const managementToggle = `
        <label class="access-meta">
          <input
            type="checkbox"
            data-minecraft-management="${escapeHtml(row.email)}"
            data-minecraft-management-locked="${row.minecraftManagementLocked ? "true" : "false"}"
            ${row.minecraftManagement ? "checked" : ""}
            ${row.minecraftManagementLocked ? "disabled" : ""}
          > Minecraft management
        </label>`;
      const administratorToggle = `
        <label class="access-meta">
          <input
            type="checkbox"
            data-administrator="${escapeHtml(row.email)}"
            data-administrator-locked="${row.administratorLocked ? "true" : "false"}"
            ${row.administrator ? "checked" : ""}
            ${row.administratorLocked ? "disabled" : ""}
          > Administrator
        </label>`;
      return `
        <div class="admin-user-row user-access-row ${row.removable ? "" : "fixed"}">
          <div><code>${escapeHtml(row.email)}</code><br><span>${escapeHtml(row.source)}</span></div>
          ${managementToggle}
          ${administratorToggle}
          ${button}
        </div>
      `;
    }).join("");
  }

  function renderEndpoints() {
    const payload = state.endpointsPayload;
    if (!payload || !Array.isArray(payload.endpoints)) {
      elements.endpointsList.innerHTML = "";
      return;
    }
    if (!payload.endpoints.length) {
      elements.endpointsList.innerHTML = '<div class="admin-user-row fixed">No endpoints configured.</div>';
      return;
    }
    elements.endpointsList.innerHTML = payload.endpoints.map((endpoint) => {
      const id = String(endpoint.id || "");
      const vm = String(endpoint.instanceName || "").trim();
      const staticIp = String(endpoint.staticIp || "").trim();
      const externalIp = String(endpoint.externalIp || "").trim();
      const manualIpReservation = String(endpoint.ipReservationMode || "").trim() === "manual";
      const zone = String(endpoint.zone || "").trim();
      const region = String(endpoint.region || "").trim();
      const ipDescription = staticIp
        ? `${manualIpReservation ? "Manual reserved IP" : "Automatic IP pending release on stop"} ${staticIp}`
        : externalIp
          ? `Ephemeral IP ${externalIp} (releases on stop)`
          : "Ephemeral IP assigned while VM runs";
      const canReserve = !staticIp;
      const canChooseReservationZone = canReserve && !vm;
      const canRelease = Boolean(staticIp) && !vm;
      const canRemove = !staticIp && !vm && id !== "mwo-vm1";
      return `
        <div class="admin-user-row fixed" data-endpoint-row="${escapeHtml(id)}">
          <div><code>${escapeHtml(id)}</code><br><span>${escapeHtml(endpoint.domain || "")}</span><br><span>${escapeHtml(ipDescription)}${region ? ` · ${escapeHtml(region)}` : ""}${vm ? ` · VM ${escapeHtml(vm)}` : ""}</span></div>
          <label class="access-meta" title="A manual reservation survives stop and delete. Otherwise an ephemeral IP is used only while the VM runs.">Persistent IP zone <input data-endpoint-zone="${escapeHtml(id)}" data-endpoint-disabled="${canChooseReservationZone ? "false" : "true"}" type="text" value="${escapeHtml(zone)}" placeholder="Choose zone" ${canChooseReservationZone ? "" : "disabled"}></label>
          <button class="action start" type="button" data-endpoint-action="reserve-ip" data-endpoint-id="${escapeHtml(id)}" data-endpoint-disabled="${canReserve ? "false" : "true"}" ${canReserve ? "" : "disabled"}>Reserve Persistent IP</button>
          <button class="action delete" type="button" data-endpoint-action="release-ip" data-endpoint-id="${escapeHtml(id)}" data-endpoint-disabled="${canRelease ? "false" : "true"}" ${canRelease ? "" : "disabled"}>Release Reserved IP</button>
          <button class="action delete" type="button" data-endpoint-action="remove" data-endpoint-id="${escapeHtml(id)}" data-endpoint-disabled="${canRemove ? "false" : "true"}" ${canRemove ? "" : "disabled"}>Remove</button>
        </div>
      `;
    }).join("");
  }

  function renderMigrations() {
    const payload = state.migrationsPayload;
    if (!payload || !state.user) {
      elements.migrationSource.innerHTML = '<option value="">Sign in to load stopped VMs</option>';
      elements.migrationTargetZone.innerHTML = '<option value="">Sign in to load compatible zones</option>';
      elements.migrationTargetEndpoint.innerHTML = '<option value="">Sign in to load endpoints</option>';
      elements.migrationStatus.textContent = "Sign in to load stopped VM migration targets.";
      elements.migrationStatus.dataset.tone = "neutral";
      elements.migrationTargets.innerHTML = "";
      elements.migrationSnapshotCount.textContent = "0";
      return;
    }
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    const targetsPayload = Array.isArray(payload.targets) ? payload.targets : [];
    const blockingMigrationStates = new Set(["preparing", "prepared", "starting", "failed", "cleanup_pending"]);
    const blockingTargets = targetsPayload.filter((target) => blockingMigrationStates.has(String(target.state || "")));
    const blockedSourceIds = new Set(blockingTargets.map((target) => String(target.sourceEndpointId || "")));
    const blockedEndpointIds = new Set(blockingTargets.map((target) => String(target.endpointId || "")));
    const snapshotCount = Math.max(0, Number(payload.snapshotCount || 0));
    elements.migrationSnapshotCount.textContent = String(snapshotCount);
    elements.migrationSnapshotCount.setAttribute("aria-label", `${snapshotCount} managed migration snapshots`);
    const eligible = sources.filter((source) => (
      Boolean(source.eligible)
      && !blockedSourceIds.has(String(source.endpoint && source.endpoint.id || ""))
    ));
    const previousSource = String(elements.migrationSource.value || "");
    elements.migrationSource.innerHTML = eligible.length ? eligible.map((source) => {
      const endpoint = source.endpoint || {};
      return `<option value="${escapeHtml(String(endpoint.id || ""))}">${escapeHtml(`${endpoint.id || "endpoint"} · ${endpoint.instanceName || "VM"} · ${endpoint.zone || "unknown zone"}`)}</option>`;
    }).join("") : '<option value="">No terminated VM available</option>';
    const sourceId = eligible.some((source) => String(source.endpoint && source.endpoint.id || "") === previousSource)
      ? previousSource : String(eligible[0] && eligible[0].endpoint && eligible[0].endpoint.id || "");
    elements.migrationSource.value = sourceId;
    const source = eligible.find((item) => String(item.endpoint && item.endpoint.id || "") === sourceId) || null;
    const targetZones = Array.isArray(source && source.targetZones)
      ? source.targetZones.map((zone) => String(zone || "").trim()).filter(Boolean)
      : [];
    const previousZone = String(elements.migrationTargetZone.value || "").trim();
    elements.migrationTargetZone.innerHTML = targetZones.length
      ? targetZones.map((zone) => `<option value="${escapeHtml(zone)}">${escapeHtml(zone)}</option>`).join("")
      : '<option value="">No compatible target zones available</option>';
    const preferredZone = targetZones.includes(previousZone)
      ? previousZone
      : targetZones.find((zone) => zone.startsWith("europe-")) || targetZones[0] || "";
    elements.migrationTargetZone.value = preferredZone;
    const mode = String(elements.migrationMode.value || "copy");
    const endpoints = Array.isArray(payload.endpoints) ? payload.endpoints : [];
    const targets = mode === "move"
      ? endpoints.filter((endpoint) => String(endpoint.id || "") === sourceId)
      : endpoints.filter((endpoint) => (
        !String(endpoint.instanceName || "").trim()
        && !String(endpoint.zone || "").trim()
        && !blockedEndpointIds.has(String(endpoint.id || ""))
      ));
    const previousTarget = String(elements.migrationTargetEndpoint.value || "");
    elements.migrationTargetEndpoint.innerHTML = targets.length ? targets.map((endpoint) => {
      const label = mode === "move" ? `${endpoint.id} · retain source endpoint` : `${endpoint.id} · ${endpoint.domain || "no DNS"}`;
      return `<option value="${escapeHtml(String(endpoint.id || ""))}">${escapeHtml(label)}</option>`;
    }).join("") : '<option value="">No compatible endpoint available</option>';
    elements.migrationTargetEndpoint.value = targets.some((endpoint) => String(endpoint.id || "") === previousTarget)
      ? previousTarget : String(targets[0] && targets[0].id || "");
    const canPrepare = Boolean(sourceId && elements.migrationTargetEndpoint.value && String(elements.migrationTargetZone.value || "").trim());
    elements.prepareMigration.dataset.migrationDisabled = String(!canPrepare);
    elements.migrationStatus.textContent = payload.scopeNote || "Migration copies the persistent state disk only.";
    elements.migrationStatus.dataset.tone = eligible.length ? "neutral" : "warning";
    elements.migrationTargets.innerHTML = targetsPayload.length ? targetsPayload.map((target) => {
      const status = String(target.state || "unknown");
      const canStart = status === "prepared";
      const canDelete = !["starting", "started"].includes(status);
      const hardware = target.hardware || {};
      return `<div class="admin-user-row fixed"><div><code>${escapeHtml(target.id)}</code><br><span>${escapeHtml(String(target.mode || "copy").toUpperCase())} · ${escapeHtml(String(target.sourceEndpointId || "source"))} -> ${escapeHtml(String(target.endpointId || "target"))} · ${escapeHtml(String(target.targetZone || ""))}</span><br><span>${escapeHtml(String(hardware.id || "CPU"))} · state disk ${escapeHtml(String(target.diskName || "pending"))} · ${escapeHtml(status)}</span><br><span>${escapeHtml(String(target.detail || ""))}</span></div><button class="action start" type="button" data-migration-action="start" data-migration-id="${escapeHtml(String(target.id || ""))}" data-migration-disabled="${canStart ? "false" : "true"}">Start prepared VM</button><button class="action delete" type="button" data-migration-action="delete" data-migration-id="${escapeHtml(String(target.id || ""))}" data-migration-disabled="${canDelete ? "false" : "true"}">Delete prepared target</button></div>`;
    }).join("") : '<div class="admin-user-row fixed">No prepared migration targets.</div>';
  }

  function vmEndpoints(endpoints) {
    return (Array.isArray(endpoints) ? endpoints : []).filter((endpoint) => (
      String(endpoint && endpoint.instanceName || "").trim()
      && String(endpoint && endpoint.zone || "").trim()
    ));
  }

  function renderSunshineCredentials() {
    const endpoints = vmEndpoints(state.endpointsPayload && state.endpointsPayload.endpoints);
    const payload = state.sunshineCredentialsPayload;
    const previousSelection = state.sunshineEndpointId || String(elements.sunshineEndpoint.value || "");
    elements.sunshineEndpoint.innerHTML = endpoints.length ? endpoints.map((endpoint) => {
      const id = String(endpoint.id || "");
      const label = `${id} · ${endpoint.domain || "no DNS"}${endpoint.instanceName ? ` · ${endpoint.instanceName}` : ""}`;
      return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
    }).join("") : '<option value="">No VM endpoint available</option>';
    const selectedId = endpoints.some((endpoint) => String(endpoint.id || "") === previousSelection)
      ? previousSelection
      : String(endpoints[0] && endpoints[0].id || "");
    state.sunshineEndpointId = selectedId;
    elements.sunshineEndpoint.value = selectedId;
    elements.sunshineEndpoint.disabled = !endpoints.length;

    if (!endpoints.length) {
      elements.sunshineCurrentPassword.value = "";
      elements.sunshineCurrentPassword.type = "password";
      elements.sunshinePasswordToggle.textContent = "Show";
      elements.sunshineCredentialsSummary.textContent = state.user
        ? "No VM exists for a managed endpoint. Create a VM before managing Sunshine credentials."
        : "Sign in to load Sunshine credential status.";
      elements.sunshineCredentialsSummary.dataset.tone = state.user ? "warning" : "neutral";
      return;
    }

    if (!payload || String(payload.endpoint && payload.endpoint.id || "") !== selectedId) {
      elements.sunshineCurrentPassword.value = "";
      elements.sunshineCurrentPassword.type = "password";
      elements.sunshinePasswordToggle.textContent = "Show";
      elements.sunshineCredentialsSummary.textContent = state.user
        ? "Select an endpoint to load its Sunshine credential status."
        : "Sign in to load Sunshine credential status.";
      elements.sunshineCredentialsSummary.dataset.tone = "neutral";
      return;
    }

    const credentials = payload.credentials || {};
    const shownPassword = state.sunshinePasswordVisible ? String(credentials.password || "") : "";
    elements.sunshineCurrentPassword.value = shownPassword;
    elements.sunshineCurrentPassword.type = state.sunshinePasswordVisible ? "text" : "password";
    elements.sunshinePasswordToggle.textContent = state.sunshinePasswordVisible ? "Hide" : "Show";
    const endpoint = payload.endpoint || {};
    const stateLabel = String(payload.instanceState || "NOT_FOUND");
    const runtimeDetail = payload.operation && payload.operation.detail ? ` ${payload.operation.detail}` : "";
    if (!payload.instanceExists) {
      elements.sunshineCredentialsSummary.textContent = `${endpoint.id || "Selected endpoint"} has no VM. Create the VM before setting Sunshine credentials.`;
      elements.sunshineCredentialsSummary.dataset.tone = "warning";
    } else if (!payload.passwordAvailable) {
      elements.sunshineCredentialsSummary.textContent = `${endpoint.id || "Selected endpoint"}: Sunshine password is not available yet. Start or recreate the VM to generate one.`;
      elements.sunshineCredentialsSummary.dataset.tone = "warning";
    } else {
      elements.sunshineCredentialsSummary.textContent = `${endpoint.id || "Selected endpoint"}: VM ${stateLabel}. Username: ${credentials.username || "admin"}. Password is hidden until Show is selected.${runtimeDetail}`;
      elements.sunshineCredentialsSummary.dataset.tone = "success";
    }
  }

  function runtimeComponentRow(endpoint, componentId, definition) {
    const details = endpoint.runtimeImages && endpoint.runtimeImages[componentId] || {};
    const candidates = Array.isArray(definition.candidates) ? definition.candidates : [];
    const currentRef = String(details.currentRef || "");
    const previousRef = String(details.previousRef || "");
    const currentTag = String(details.currentTag || "");
    const isRunning = String(endpoint.instanceState || "").toUpperCase() === "RUNNING";
    const agentReady = Boolean(endpoint.runtimeImageAgentReady);
    const minecraftReady = componentId !== "minecraft" || String(endpoint.minecraft && endpoint.minecraft.state || "") === "running";
    const canPull = isRunning && agentReady && candidates.some((candidate) => candidate.imageRef);
    const canApply = canPull && minecraftReady;
    const canRollback = isRunning && agentReady && minecraftReady && Boolean(previousRef);
    const options = candidates.map((candidate) => {
      const ref = String(candidate.imageRef || "");
      const label = `${candidate.tag || "untagged"}${candidate.updatedAt ? ` · ${candidate.updatedAt.slice(0, 10)}` : ""}`;
      return `<option value="${escapeHtml(ref)}" ${ref && ref === currentRef ? "selected" : ""} ${ref ? "" : "disabled"}>${escapeHtml(label)}</option>`;
    }).join("");
    const status = details.detail ? `<br><span>${escapeHtml(details.detail)}</span>` : "";
    return `
      <div class="admin-user-row fixed">
        <div>
          <code>${escapeHtml(definition.label || componentId)}</code><br>
          <span>Current: ${escapeHtml(currentTag || currentRef || "not recorded")}</span>
          ${previousRef ? `<br><span>Rollback: ${escapeHtml(details.previousTag || previousRef)}</span>` : ""}
          ${status}
        </div>
        <label class="access-meta">Target
          <select data-runtime-image-select="${escapeHtml(componentId)}">${options || '<option value="">Refresh trusted versions first</option>'}</select>
        </label>
        <button class="action start" type="button" data-runtime-action="pull" data-runtime-component="${escapeHtml(componentId)}" data-runtime-disabled="${canPull ? "false" : "true"}">Pull Only</button>
        <button class="action create" type="button" data-runtime-action="apply" data-runtime-component="${escapeHtml(componentId)}" data-runtime-disabled="${canApply ? "false" : "true"}">Apply Update</button>
        <button class="action delete" type="button" data-runtime-action="rollback" data-runtime-component="${escapeHtml(componentId)}" data-runtime-disabled="${canRollback ? "false" : "true"}">Rollback</button>
      </div>
    `;
  }

  function renderRuntimeImages() {
    const payload = state.runtimeImagesPayload;
    if (!payload || !Array.isArray(payload.endpoints)) {
      elements.runtimeEndpoint.innerHTML = "";
      elements.runtimeImagesList.innerHTML = "";
      return;
    }
    const endpoints = vmEndpoints(payload.endpoints);
    const previousSelection = String(elements.runtimeEndpoint.value || "");
    elements.runtimeEndpoint.innerHTML = endpoints.length ? endpoints.map((endpoint) => {
      const id = String(endpoint.id || "");
      const label = `${id} · ${endpoint.domain || "no DNS"}${endpoint.instanceName ? ` · ${endpoint.instanceName}` : ""}`;
      return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
    }).join("") : '<option value="">No VM endpoint available</option>';
    elements.runtimeEndpoint.disabled = !endpoints.length;
    const selectedId = endpoints.some((endpoint) => endpoint.id === previousSelection)
      ? previousSelection
      : String(endpoints[0] && endpoints[0].id || "");
    elements.runtimeEndpoint.value = selectedId;
    const endpoint = endpoints.find((entry) => entry.id === selectedId);
    if (!endpoint) {
      elements.runtimeImagesList.innerHTML = '<div class="admin-user-row fixed">No VM endpoint available. Create a VM before managing runtime images.</div>';
      return;
    }
    const components = payload.catalog && payload.catalog.components || {};
    const catalogInfo = payload.catalog && payload.catalog.updatedAt
      ? `Trusted catalog: ${payload.catalog.source || "cache"} · ${payload.catalog.updatedAt}`
      : `Trusted catalog: ${payload.catalog && payload.catalog.source || "static"}`;
    const status = endpoint.runtimeImages && endpoint.runtimeImages.status
      ? `<div class="admin-user-row fixed"><span>${escapeHtml(`Last runtime operation: ${endpoint.runtimeImages.status}${endpoint.runtimeImages.detail ? ` · ${endpoint.runtimeImages.detail}` : ""}`)}</span></div>`
      : "";
    const agent = endpoint.instanceState === "RUNNING" && !endpoint.runtimeImageAgentReady
      ? '<div class="admin-user-row fixed"><span>Runtime image agent: restart the VM once before image operations.</span></div>'
      : "";
    elements.runtimeImagesList.innerHTML = `
      <div class="admin-user-row fixed"><span>${escapeHtml(catalogInfo)}</span><span>VM: ${escapeHtml(endpoint.instanceState || "NOT_FOUND")}</span></div>
      ${agent}
      ${runtimeComponentRow(endpoint, "steam-headless", components["steam-headless"] || { label: "Steam Headless + Sunshine", candidates: [] })}
      ${runtimeComponentRow(endpoint, "minecraft", components.minecraft || { label: "Minecraft container", candidates: [] })}
      ${status}
    `;
  }

  function renderCompatibility() {
    const payload = state.compatibilityPayload;
    if (!payload) {
      elements.compatibilityHardware.innerHTML = "";
      elements.compatibilityList.innerHTML = "";
      return;
    }
    const previousHardware = String(elements.compatibilityHardware.value || "");
    const hardwareOptions = Array.isArray(payload.hardwareOptions) ? payload.hardwareOptions : [];
    elements.compatibilityHardware.innerHTML = hardwareOptions.map((hardware) => (
      `<option value="${escapeHtml(hardware.id)}">${escapeHtml(`${hardware.label} (${hardware.gpuType})`)}</option>`
    )).join("");
    if (hardwareOptions.some((hardware) => hardware.id === previousHardware)) {
      elements.compatibilityHardware.value = previousHardware;
    }
    const records = payload.catalog && Array.isArray(payload.catalog.records) ? payload.catalog.records : [];
    if (!records.length) {
      elements.compatibilityList.innerHTML = '<div class="admin-user-row fixed">No compatibility evidence recorded yet.</div>';
      return;
    }
    const colorForResult = (result) => ({
      works: "#178f5b",
      fails: "#b54040",
      testing: "#a46c00",
      unknown: "#5b6470",
    }[result] || "#5b6470");
    elements.compatibilityList.innerHTML = records.map((record) => `
      <div class="admin-user-row fixed">
        <div>
          <code>${escapeHtml(record.hardwareLabel || record.hardwareId)}</code><br>
          <span>${escapeHtml(record.gpuType)} · ${escapeHtml(record.acceleratorMode)} · ${escapeHtml(record.imageRef)}</span><br>
          <span>Sunshine ${escapeHtml(record.sunshineVersion)} · NVIDIA ${escapeHtml(record.driverVersion)} · ${escapeHtml(String(record.recordedAt || "").replace("T", " ").replace("Z", " UTC"))}</span>
          ${record.evidence ? `<br><span>${escapeHtml(record.evidence)}</span>` : ""}
        </div>
        <strong style="color:${colorForResult(record.result)}">${escapeHtml(String(record.result || "unknown").toUpperCase())}</strong>
        <button class="action delete" type="button" data-compatibility-remove="${escapeHtml(record.recordId)}">Remove</button>
      </div>
    `).join("");
  }

  async function waitForGoogleIdentity() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("Google Identity Services script did not load.");
  }

  async function connectBackend(options) {
    const silent = Boolean(options && options.silent);
    saveConfig();
    if (!state.backendUrl) {
      throw new Error("Cloud Run API URL is required.");
    }
    if (!silent) {
      setMessage("Connecting to Cloud Run backend...", "warning");
    }
    const response = await window.fetch(`${state.backendUrl}/api/config`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(await response.text() || `Backend returned ${response.status}.`);
    }
    state.backendConfig = await response.json();
    if (!state.backendConfig.googleClientId) {
      throw new Error("Backend is missing GOOGLE_CLIENT_ID.");
    }
    await initializeGoogle(state.backendConfig.googleClientId);
    if (!silent) {
      setMessage("Backend connected.", "success");
    }
    updateUi();
    if (state.token) {
      await verifyAdminSession();
    }
  }

  async function initializeGoogle(clientId) {
    if (state.googleInitializedFor === clientId) {
      return;
    }
    await waitForGoogleIdentity();
    state.googleTokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: "openid email profile",
      prompt: "select_account",
      callback: handleGoogleToken,
      error_callback: handleGoogleOAuthError,
    });
    state.googleInitializedFor = clientId;
  }

  function storeSessionToken(token) {
    state.token = token || "";
    if (state.token) {
      window.sessionStorage.setItem(storageKeys.sessionToken, state.token);
    } else {
      window.sessionStorage.removeItem(storageKeys.sessionToken);
    }
    window.dispatchEvent(new CustomEvent("vm-control:session-changed"));
  }

  window.addEventListener("message", async (event) => {
    if (event.origin !== window.location.origin || event.data?.type !== adminSessionResponse) return;
    const token = String(event.data.token || "");
    if (!token) return;
    storeSessionToken(token);
    if (!state.backendConfig) return;
    try {
      setBusy(true);
      await verifyAdminSession();
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  function clearSession(options) {
    const revokeGoogleSession = Boolean(options && options.revokeGoogleSession);
    const token = state.token;
    state.refreshRevision += 1;
    if (automaticRefreshTimer) {
      window.clearInterval(automaticRefreshTimer);
      automaticRefreshTimer = 0;
    }
    state.automaticRefreshInFlight = false;
    storeSessionToken("");
    state.user = null;
    state.viewer = null;
    state.accessDenied = false;
    state.usersPayload = null;
    state.endpointsPayload = null;
    state.migrationsPayload = null;
    state.runtimeImagesPayload = null;
    state.compatibilityPayload = null;
    state.sunshineCredentialsPayload = null;
    state.sunshineEndpointId = "";
    state.sunshinePasswordVisible = false;
    state.softwarePayload = null;
    state.softwareEndpointId = "";
    if (revokeGoogleSession && token && window.google && window.google.accounts && window.google.accounts.oauth2) {
      window.google.accounts.oauth2.revoke(token, () => {});
    }
    updateUi();
  }

  async function handleGoogleToken(response) {
    try {
      if (response.error) {
        throw new Error(response.error_description || response.error);
      }
      setBusy(true);
      storeSessionToken(response.access_token || "");
      await verifyAdminSession();
    } catch (error) {
      if (!state.accessDenied) {
        clearSession();
      }
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  function handleGoogleOAuthError(error) {
    clearSession();
    handleError(new Error(error && error.type ? `Google sign-in failed: ${error.type}` : "Google sign-in failed."));
    setBusy(false);
  }

  async function fetchApi(path, options) {
    if (!state.backendUrl) {
      throw new Error("Connect the backend first.");
    }
    if (!state.token) {
      throw new Error("Sign in with Google first.");
    }
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${state.token}`,
      ...(options && options.body ? { "Content-Type": "application/json" } : {}),
    };
    const response = await window.fetch(`${state.backendUrl}${path}`, {
      ...(options || {}),
      headers,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) {
        state.user = null;
        state.viewer = null;
        state.accessDenied = false;
      } else if (response.status === 403 && (path === "/api/me" || path.startsWith("/api/admin/"))) {
        state.viewer = state.viewer || state.user;
        state.user = null;
        state.accessDenied = true;
      }
      throw new Error((payload && payload.error) || `API returned ${response.status}.`);
    }
    return payload;
  }

  async function verifyAdminSession(options) {
    const payload = await fetchApi("/api/me", { method: "GET" });
    const viewer = payload && payload.user ? payload.user : null;
    state.viewer = viewer;
    if (!viewer || !viewer.isAdmin) {
      state.user = null;
      state.accessDenied = true;
      setMessage("Administrator access denied for this Google account.", "error");
      updateUi();
      return false;
    }
    state.accessDenied = false;
    return loadUsers(options);
  }

  async function loadUsers(options) {
    if (!state.viewer || !state.viewer.isAdmin) {
      throw new Error("Administrator session verification is required.");
    }
    const silent = Boolean(options && options.silent);
    const refreshRevision = state.refreshRevision;
    const [payload, endpoints, migrations, runtimeImages, compatibility] = await Promise.all([
      fetchApi("/api/admin/users", { method: "GET" }),
      fetchApi("/api/admin/endpoints", { method: "GET" }),
      fetchApi("/api/admin/migrations", { method: "GET" }),
      fetchApi("/api/admin/runtime-images", { method: "GET" }),
      fetchApi("/api/admin/compatibility", { method: "GET" }),
    ]);
    if (refreshRevision !== state.refreshRevision) {
      return false;
    }
    state.user = payload.user;
    state.viewer = payload.user;
    state.accessDenied = false;
    state.usersPayload = payload;
    state.endpointsPayload = endpoints;
    state.migrationsPayload = migrations;
    state.runtimeImagesPayload = runtimeImages;
    state.compatibilityPayload = compatibility;
    const availableEndpoints = vmEndpoints(endpoints.endpoints);
    const selectedEndpointId = availableEndpoints.some((endpoint) => String(endpoint.id || "") === state.sunshineEndpointId)
      ? state.sunshineEndpointId
      : String(availableEndpoints[0] && availableEndpoints[0].id || "");
    state.sunshineEndpointId = selectedEndpointId;
    state.sunshinePasswordVisible = false;
    state.sunshineCredentialsPayload = selectedEndpointId
      ? await fetchApi(`/api/admin/sunshine-credentials?endpointId=${encodeURIComponent(selectedEndpointId)}`, { method: "GET" })
      : null;
    const softwareEndpointId = availableEndpoints.some((endpoint) => String(endpoint.id || "") === state.softwareEndpointId)
      ? state.softwareEndpointId
      : String(availableEndpoints[0] && availableEndpoints[0].id || "");
    state.softwareEndpointId = softwareEndpointId;
    state.softwarePayload = softwareEndpointId
      ? await fetchApi(`/api/admin/software?endpointId=${encodeURIComponent(softwareEndpointId)}`, { method: "GET" })
      : null;
    if (!silent) {
      setMessage("Managed GUI users loaded.", "success");
    }
    updateUi();
    startAutomaticRefresh();
    return true;
  }

  async function refreshAdminDataInBackground() {
    if (
      state.automaticRefreshInFlight
      || state.isBusy
      || !state.user
      || !state.token
      || document.visibilityState !== "visible"
    ) {
      return;
    }
    state.automaticRefreshInFlight = true;
    try {
      await loadUsers({ silent: true });
    } catch (error) {
      if (!state.user) {
        clearSession();
      }
      console.warn("Automatic admin refresh failed.", error);
    } finally {
      state.automaticRefreshInFlight = false;
    }
  }

  function startAutomaticRefresh() {
    if (automaticRefreshTimer) {
      return;
    }
    automaticRefreshTimer = window.setInterval(refreshAdminDataInBackground, ADMIN_REFRESH_INTERVAL_MS);
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        refreshAdminDataInBackground();
      }
    });
  }

  async function updateUser(action, email, extra) {
    const payload = await fetchApi("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ action, email, ...(extra || {}) }),
    });
    state.usersPayload = payload;
    const message = action === "add"
      ? `Added ${email}.`
      : action === "remove"
        ? `Removed ${email}.`
        : action === "set-administrator"
          ? `Updated administrator access for ${email}.`
        : `Updated Minecraft management access for ${email}.`;
    setMessage(message, "success");
    renderUsers();
  }

  async function updateEndpoint(action, endpointId, extra) {
    const payload = await fetchApi("/api/admin/endpoints", {
      method: "POST",
      body: JSON.stringify({ action, endpointId, ...(extra || {}) }),
    });
    state.endpointsPayload = payload;
    const actionLabel = action === "add" ? "Added" : action === "remove" ? "Removed" : action === "reserve-ip" ? "Reserved IP for" : "Released IP for";
    setMessage(`${actionLabel} ${endpointId}.`, "success");
    renderEndpoints();
  }

  async function updateMigration(action, extra) {
    const payload = await fetchApi("/api/admin/migrations", {
      method: "POST",
      body: JSON.stringify({ action, ...(extra || {}) }),
    });
    state.migrationsPayload = payload;
    state.endpointsPayload = { user: payload.user, endpoints: payload.endpoints || [] };
    setMessage({ prepare: "Migration target prepared.", start: "Prepared migration VM started.", delete: "Prepared migration target deleted." }[action] || "Migration updated.", "success");
    renderMigrations();
    renderEndpoints();
  }

  async function updateRuntimeImages(action, component, extra) {
    const endpointId = String(elements.runtimeEndpoint.value || "");
    const payload = await fetchApi("/api/admin/runtime-images", {
      method: "POST",
      body: JSON.stringify({ action, endpointId, component, ...(extra || {}) }),
    });
    state.runtimeImagesPayload = payload;
    const operation = payload.operation || {};
    const label = action === "refresh-catalog"
      ? "Trusted image versions refreshed."
      : action === "pull"
        ? `Pulled ${operation.component || component} image without restart.`
        : action === "rollback"
          ? `Rolled back ${operation.component || component} image.`
          : `Updated ${operation.component || component} image.`;
    setMessage(label, "success");
    renderRuntimeImages();
  }

  async function updateCompatibility(action, extra) {
    const payload = await fetchApi("/api/admin/compatibility", {
      method: "POST",
      body: JSON.stringify({ action, ...(extra || {}) }),
    });
    state.compatibilityPayload = payload;
    setMessage(action === "remove" ? "Compatibility result removed." : "Compatibility result saved.", "success");
    renderCompatibility();
  }

  async function loadSunshineCredentials(options) {
    const reveal = Boolean(options && options.reveal);
    const endpointId = String(state.sunshineEndpointId || elements.sunshineEndpoint.value || "");
    if (!endpointId) {
      state.sunshineCredentialsPayload = null;
      state.sunshinePasswordVisible = false;
      renderSunshineCredentials();
      return;
    }
    const query = new URLSearchParams({ endpointId });
    if (reveal) {
      query.set("reveal", "true");
    }
    const payload = await fetchApi(`/api/admin/sunshine-credentials?${query.toString()}`, { method: "GET" });
    state.sunshineCredentialsPayload = payload;
    state.sunshinePasswordVisible = reveal && Boolean(payload.passwordRevealed);
    renderSunshineCredentials();
  }

  async function updateSunshinePassword(password) {
    const endpointId = String(state.sunshineEndpointId || elements.sunshineEndpoint.value || "");
    const payload = await fetchApi("/api/admin/sunshine-credentials", {
      method: "POST",
      body: JSON.stringify({ endpointId, sunshinePassword: password }),
    });
    state.sunshineCredentialsPayload = payload;
    state.sunshinePasswordVisible = false;
    renderSunshineCredentials();
    setMessage(`Sunshine password updated for ${endpointId}.`, "success");
  }

  function optionList(items, selectedValue, emptyLabel) {
    const normalized = Array.isArray(items) ? items : [];
    if (!normalized.length) {
      return `<option value="">${escapeHtml(emptyLabel)}</option>`;
    }
    return normalized.map((item) => {
      const value = String(typeof item === "string" ? item : (item.id || item.value || item.version || item.name || ""));
      const label = String(typeof item === "string" ? item : (item.label || item.name || item.version || value));
      return `<option value="${escapeHtml(value)}" ${value === String(selectedValue || "") ? "selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("");
  }

  function renderSoftware() {
    const payload = state.softwarePayload;
    if (!payload) {
      elements.softwareEndpoint.innerHTML = '<option value="">No VM endpoint available</option>';
      elements.softwareEndpoint.disabled = true;
      elements.softwareApplication.innerHTML = '<option value="">No applications loaded</option>';
      elements.softwareApplicationState.textContent = "Installed applications are unavailable.";
      elements.softwareMinecraftVersion.innerHTML = '<option value="">No versions loaded</option>';
      elements.softwareMinecraftServer.innerHTML = '<option value="__new__">+ Create new server</option>';
      elements.softwareMinecraftCreatePanel.hidden = false;
      elements.softwareMinecraftExistingPanel.hidden = true;
      elements.softwareStatus.textContent = state.user
        ? "No VM endpoint is available. Create a VM before managing applications or Minecraft."
        : "Sign in to load applications and Minecraft server state.";
      elements.softwareStatus.dataset.tone = state.user ? "warning" : "neutral";
      renderSoftwareLiveAccess(null);
      return;
    }

    const endpoints = vmEndpoints(state.endpointsPayload && state.endpointsPayload.endpoints);
    const previousApplication = elements.softwareApplication.value;
    const previousVersion = elements.softwareMinecraftVersion.value;
    const previousServerType = elements.softwareMinecraftServerType.value;
    const previousMinecraftServer = state.softwareMinecraftSelection || elements.softwareMinecraftServer.value;
    elements.softwareEndpoint.innerHTML = endpoints.length
      ? endpoints.map((endpoint) => {
        const id = String(endpoint.id || "");
        const domain = String(endpoint.domain || "");
        return `<option value="${escapeHtml(id)}" ${id === state.softwareEndpointId ? "selected" : ""}>${escapeHtml(id)}${domain ? ` · ${escapeHtml(domain)}` : ""}</option>`;
      }).join("")
      : '<option value="">No VM endpoint available</option>';
    elements.softwareEndpoint.disabled = !endpoints.length;

    const applications = Array.isArray(payload.applicationCatalog) ? payload.applicationCatalog : [];
    const status = payload.status || {};
    const installedApplications = new Set(Array.isArray(status.applications && status.applications.installed)
      ? status.applications.installed.map(String)
      : []);
    elements.softwareApplication.innerHTML = applications.length
      ? applications.map((application) => {
        const id = String(application.id || application.value || "");
        const label = String(application.label || application.name || id);
        const stateLabel = installedApplications.has(id) ? "Installed" : "Not installed";
        return `<option value="${escapeHtml(id)}" ${id === String(previousApplication || "") ? "selected" : ""}>${escapeHtml(label)} · ${stateLabel}</option>`;
      }).join("")
      : '<option value="">No applications available</option>';
    const installedLabels = applications
      .filter((application) => installedApplications.has(String(application.id || application.value || "")))
      .map((application) => String(application.label || application.name || application.id || application.value || ""));
    elements.softwareApplicationState.textContent = installedLabels.length
      ? `Installed applications (${installedLabels.length}/${applications.length}): ${installedLabels.join(", ")}.`
      : `No desktop applications installed (0/${applications.length}).`;
    const minecraft = payload.minecraftServer || {};
    const serverTypes = Array.isArray(minecraft.serverTypes) ? minecraft.serverTypes : [];
    const selectedServerType = previousServerType || minecraft.serverType || "paper";
    elements.softwareMinecraftServerType.innerHTML = optionList(serverTypes, selectedServerType, "No runtimes available");
    if ([...elements.softwareMinecraftServerType.options].some((option) => option.value === selectedServerType)) {
      elements.softwareMinecraftServerType.value = selectedServerType;
    }
    const activeServerType = String(elements.softwareMinecraftServerType.value || selectedServerType || "paper");
    const versionCatalogs = minecraft.versionCatalogs && typeof minecraft.versionCatalogs === "object"
      ? minecraft.versionCatalogs
      : {};
    const versionCatalog = versionCatalogs[activeServerType] || {
      versions: minecraft.versions || minecraft.availableVersions || [],
      defaultVersion: minecraft.defaultVersion || "",
      source: minecraft.source || "static",
      updatedAt: minecraft.updatedAt || "",
      lastError: minecraft.error || "",
    };
    const minecraftVersions = Array.isArray(versionCatalog.versions) ? versionCatalog.versions : [];
    const selectedVersion = minecraftVersions.includes(previousVersion)
      ? previousVersion
      : (versionCatalog.defaultVersion || minecraftVersions[0] || "");
    elements.softwareMinecraftVersion.innerHTML = optionList(minecraftVersions, selectedVersion, "Refresh Minecraft Versions to load this runtime catalog");
    const servers = Array.isArray(status.minecraftServers) ? status.minecraftServers : (Array.isArray(payload.minecraftServers) ? payload.minecraftServers : []);
    const activeServers = servers.filter((server) => String(server && server.state || "").trim().toLowerCase() !== "removed");
    const selectedMinecraftServer = previousMinecraftServer === "__new__"
      ? "__new__"
      : activeServers.some((server) => String(server.id || "") === previousMinecraftServer)
        ? previousMinecraftServer
        : String(activeServers[0] && activeServers[0].id || "__new__");
    state.softwareMinecraftSelection = selectedMinecraftServer;
    elements.softwareMinecraftServer.innerHTML = `<option value="__new__" ${selectedMinecraftServer === "__new__" ? "selected" : ""}>+ Create new server</option>${activeServers.map((server) => `<option value="${escapeHtml(String(server.id || ""))}" ${String(server.id || "") === selectedMinecraftServer ? "selected" : ""}>${escapeHtml(String(server.id || ""))} · ${escapeHtml(String(server.serverType || "paper"))} ${escapeHtml(String(server.version || "LATEST"))} · :${escapeHtml(String(server.gamePort || ""))} · ${escapeHtml(String(server.state || ""))}</option>`).join("")}`;
    const createMinecraftMode = selectedMinecraftServer === "__new__";
    elements.softwareMinecraftCreatePanel.hidden = !createMinecraftMode;
    elements.softwareMinecraftExistingPanel.hidden = createMinecraftMode;
    const selectedMinecraftRecord = activeServers.find((server) => String(server.id || "") === selectedMinecraftServer) || null;
    elements.softwareMinecraftServerSummary.textContent = selectedMinecraftRecord
      ? `${selectedMinecraftRecord.id} · ${selectedMinecraftRecord.serverType || "paper"} ${selectedMinecraftRecord.version || "LATEST"} · port ${selectedMinecraftRecord.gamePort || "not assigned"} · ${selectedMinecraftRecord.state || "unknown"}.`
      : "Select an installed server to manage it.";
    const allowedCommands = new Set(Array.isArray(status.allowedCommands) ? status.allowedCommands : []);
    const instanceState = String(status.instanceState || status.vmState || status.status || "NOT_FOUND");
    const minecraftState = String(
      (status.minecraftStatus && (status.minecraftStatus.state || status.minecraftStatus.status))
      || (status.minecraft && (status.minecraft.state || status.minecraft.status))
      || "not installed"
    );
    const catalogDetail = versionCatalog.lastError
      ? `Version list error: ${versionCatalog.lastError}`
      : `${minecraftVersions.length} ${activeServerType} versions available${versionCatalog.source ? ` from ${versionCatalog.source}` : ""}.`;
    elements.softwareStatus.textContent = `${payload.endpoint && payload.endpoint.id ? payload.endpoint.id : "Selected endpoint"} · VM ${instanceState} · Applications ${installedApplications.size}/${applications.length} installed · Minecraft ${minecraftState}`;
    elements.softwareStatus.dataset.tone = versionCatalog.lastError ? "warning" : (instanceState === "RUNNING" ? "success" : "neutral");
    const newServer = String(elements.softwareMinecraftNewServer.value || "").trim().toLowerCase();
    const validNewServer = /^[a-z0-9][a-z0-9-]{0,30}$/.test(newServer);
    if (elements.softwareMinecraftCreateHint) {
      elements.softwareMinecraftCreateHint.textContent = !allowedCommands.has("install-minecraft")
        ? "The VM is not ready to create a Minecraft server yet."
        : !validNewServer
          ? "Enter a new server ID using lowercase letters, numbers or hyphens (for example: survival)."
          : `Ready to create “${newServer}”. ${catalogDetail}`;
    }
    document.querySelectorAll("[data-software-command]").forEach((button) => {
      const command = button.dataset.softwareCommand || "";
      const needsApplication = command === "install-app" || command === "uninstall-app";
      const selectedApplicationInstalled = installedApplications.has(String(elements.softwareApplication.value || ""));
      const needsVersion = command === "install-minecraft";
      const selectedServer = String(elements.softwareMinecraftServer.value || "");
      const needsExistingServer = ["start-minecraft", "stop-minecraft", "restart-minecraft", "remove-minecraft"].includes(command);
      const selectedServerState = String((activeServers.find((server) => String(server.id || "") === selectedServer) || {}).state || "").toLowerCase();
      const invalidLifecycleState = (command === "start-minecraft" && selectedServerState !== "stopped")
        || (["stop-minecraft", "restart-minecraft"].includes(command) && selectedServerState !== "running")
        || (command === "remove-minecraft" && !["running", "stopped", "error"].includes(selectedServerState));
      button.dataset.softwareDisabled = String(
        !allowedCommands.has(command)
        || (needsApplication && !elements.softwareApplication.value)
        || (command === "install-app" && selectedApplicationInstalled)
        || (command === "uninstall-app" && !selectedApplicationInstalled)
        || (needsVersion && !elements.softwareMinecraftVersion.value)
        || (command === "install-minecraft" && !createMinecraftMode)
        || (command === "install-minecraft" && !validNewServer)
        || (needsExistingServer && createMinecraftMode)
        || (needsExistingServer && !selectedServer)
        || (needsExistingServer && invalidLifecycleState)
      );
    });
    renderSoftwareLiveAccess(payload);
  }

  function renderSoftwareLiveAccess(payload) {
    const container = elements.softwareLiveAccess;
    if (!container) return;
    if (!state.user) {
      container.className = "access empty";
      container.textContent = "Sign in to load live access details.";
      return;
    }
    if (!payload) {
      container.className = "access empty";
      container.textContent = "No VM endpoint is available for live access.";
      return;
    }

    const endpoint = payload.endpoint || {};
    const status = payload.status || {};
    const endpointId = String(endpoint.id || "selected endpoint");
    const instanceState = String(status.instanceState || status.vmState || status.status || "NOT_FOUND").toUpperCase();
    if (instanceState !== "RUNNING") {
      container.className = "access empty";
      container.textContent = `${endpointId}: VM ${instanceState}. Start the VM to use live access.`;
      return;
    }

    const urls = status.urls || {};
    const sunshineUrl = String(urls.sunshine || "");
    const novncIap = urls.novncIap || {};
    const novncTunnelCommand = String(novncIap.command || "");
    const novncLocalUrl = String(novncIap.localUrl || "http://localhost:8083/");
    const minecraftAddress = String(urls.minecraft || "");
    const minecraftStatus = status.minecraftStatus || status.minecraft || {};
    const sunshineStatus = status.sunshineStatus || status.sunshine || {};
    const minecraftManagement = status.minecraftManagement || {};
    const managementUrl = new URL("./minecraft-admin.html", window.location.href);
    if (state.backendUrl) managementUrl.searchParams.set("backend", state.backendUrl);
    if (endpoint.id) managementUrl.searchParams.set("endpointId", String(endpoint.id));
    if (endpoint.zone) managementUrl.searchParams.set("zone", String(endpoint.zone));
    if (endpoint.hardware && endpoint.hardware.id) managementUrl.searchParams.set("hardwareId", String(endpoint.hardware.id));
    if (minecraftManagement.selectedServerId) managementUrl.searchParams.set("minecraftServerId", String(minecraftManagement.selectedServerId));
    const card = (title, url, detail, linkLabel) => `
      <article class="access-card">
        <h3>${escapeHtml(title)}</h3>
        <p class="access-meta">${escapeHtml(detail || "Status not available")}</p>
        ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(linkLabel)}</a>` : (linkLabel ? '<span class="access-meta">Address not available</span>' : "")}
      </article>`;

    container.className = "access";
    container.innerHTML = `<div class="access-grid">
      ${card("Sunshine Web UI", sunshineUrl, String(sunshineStatus.label || "Status not available"), "Open Sunshine UI")}
      <article class="access-card accent">
        <h3>Browser desktop</h3>
        <p class="access-meta">Restricted to configured administrators through Google IAP. Run this on your administrator workstation:</p>
        <p class="access-meta"><code>${escapeHtml(novncTunnelCommand || "IAP tunnel command is not available.")}</code></p>
        <p class="access-meta">Then open <code>${escapeHtml(novncLocalUrl)}</code>.</p>
      </article>
      ${card("Minecraft Server", "", `${minecraftAddress || "Address not available"} · ${String(minecraftStatus.label || "Not installed")}`, "")}
      <article class="access-card accent">
        <h3>Minecraft management</h3>
        <p class="access-meta">${minecraftManagement.authorized ? "Authorized administrator access." : "Minecraft management access is not available."}</p>
        ${minecraftManagement.authorized ? `<a href="${escapeHtml(managementUrl.toString())}">Open management controls</a>` : ""}
      </article>
    </div>`;
  }

  async function loadSoftware() {
    const endpointId = String(state.softwareEndpointId || elements.softwareEndpoint.value || "");
    state.softwareEndpointId = endpointId;
    state.softwarePayload = endpointId
      ? await fetchApi(`/api/admin/software?endpointId=${encodeURIComponent(endpointId)}`, { method: "GET" })
      : null;
    renderSoftware();
  }

  async function updateSoftware(command) {
    const endpointId = String(state.softwareEndpointId || elements.softwareEndpoint.value || "");
    const minecraftServerId = command === "install-minecraft"
      ? String(elements.softwareMinecraftNewServer.value || "")
      : String(elements.softwareMinecraftServer.value || "");
    const payload = await fetchApi("/api/admin/software", {
      method: "POST",
      body: JSON.stringify({
        endpointId,
        command,
        applicationId: String(elements.softwareApplication.value || ""),
        minecraftVersion: String(elements.softwareMinecraftVersion.value || ""),
        minecraftServerType: String(elements.softwareMinecraftServerType.value || "paper"),
        minecraftServerId: minecraftServerId.trim().toLowerCase(),
      }),
    });
    state.softwarePayload = payload;
    state.softwareEndpointId = endpointId;
    if (command === "install-minecraft") {
      elements.softwareMinecraftNewServer.value = "";
      state.softwareMinecraftSelection = minecraftServerId.trim().toLowerCase();
    } else if (command === "remove-minecraft") {
      state.softwareMinecraftSelection = "";
    }
    const labels = {
      "install-app": "Application installation started.",
      "uninstall-app": "Application removal started.",
      "install-minecraft": "Minecraft installation started.",
      "start-minecraft": "Minecraft server start requested.",
      "stop-minecraft": "Minecraft server stop requested.",
      "restart-minecraft": "Minecraft server restart requested.",
      "remove-minecraft": "Minecraft server removal started.",
      "refresh-minecraft-versions": "Minecraft versions refreshed.",
    };
    setMessage(labels[command] || "Software action completed.", "success");
    renderSoftware();
  }

  function handleError(error) {
    setMessage(error.message || "Unexpected error.", "error");
    updateUi();
  }

  elements.connect.addEventListener("click", async () => {
    try {
      setBusy(true);
      await connectBackend({ silent: false });
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  elements.googleSignIn.addEventListener("click", async () => {
    try {
      setBusy(true);
      if (!state.googleTokenClient) {
        await connectBackend({ silent: true });
      }
      state.googleTokenClient.requestAccessToken();
    } catch (error) {
      handleError(error);
      setBusy(false);
    }
  });

  elements.accessDeniedChangeAccount.addEventListener("click", async () => {
    try {
      setBusy(true);
      if (!state.googleTokenClient) {
        await connectBackend({ silent: true });
      }
      state.googleTokenClient.requestAccessToken({ prompt: "select_account" });
    } catch (error) {
      handleError(error);
      setBusy(false);
    }
  });

  elements.signOut.addEventListener("click", () => {
    clearSession({ revokeGoogleSession: true });
    setMessage("Google session cleared from this browser session.", "success");
  });

  elements.addUserForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = String(elements.userEmail.value || "").trim().toLowerCase();
    if (!email) {
      setMessage("Provide a Google account email.", "warning");
      return;
    }
    try {
      setBusy(true);
      await updateUser("add", email);
      elements.userEmail.value = "";
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  elements.addEndpointForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const endpointId = String(elements.endpointId.value || "").trim().toLowerCase();
    const domain = String(elements.endpointDomain.value || "").trim().toLowerCase();
    if (!endpointId || !domain) {
      setMessage("Provide an endpoint ID and DuckDNS domain.", "warning");
      return;
    }
    try {
      setBusy(true);
      await updateEndpoint("add", endpointId, { domain });
      elements.endpointId.value = "";
      elements.endpointDomain.value = "";
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  elements.usersList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-remove-user]");
    if (!button) {
      return;
    }
    const email = String(button.dataset.removeUser || "");
    if (!window.confirm(`Remove ${email} from managed GUI access?`)) {
      return;
    }
    try {
      setBusy(true);
      await updateUser("remove", email);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  elements.usersList.addEventListener("change", async (event) => {
    const administratorInput = event.target.closest("[data-administrator]");
    if (administratorInput) {
      if (administratorInput.dataset.administratorLocked === "true") {
        return;
      }
      const email = String(administratorInput.dataset.administrator || "");
      try {
        setBusy(true);
        await updateUser("set-administrator", email, { administrator: administratorInput.checked });
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
      }
      return;
    }
    const input = event.target.closest("[data-minecraft-management]");
    if (!input || input.dataset.minecraftManagementLocked === "true") {
      return;
    }
    const email = String(input.dataset.minecraftManagement || "");
    try {
      setBusy(true);
      await updateUser("set-minecraft-management", email, { minecraftManagement: input.checked });
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  [elements.migrationSource, elements.migrationMode, elements.migrationTargetZone, elements.migrationTargetEndpoint].forEach((input) => {
    input.addEventListener("change", () => {
      renderMigrations();
      setBusy(state.isBusy);
    });
  });

  elements.prepareMigration.addEventListener("click", async () => {
    const sourceEndpointId = String(elements.migrationSource.value || "");
    const mode = String(elements.migrationMode.value || "copy");
    const targetZone = String(elements.migrationTargetZone.value || "").trim();
    const targetEndpointId = String(elements.migrationTargetEndpoint.value || "");
    if (!sourceEndpointId || !targetEndpointId || !targetZone) {
      setMessage("Select a terminated source VM, target zone and endpoint.", "warning");
      return;
    }
    const prompt = mode === "move"
      ? `Move ${sourceEndpointId} to ${targetZone}? The source VM is deleted only after the target disk is prepared. The temporary snapshot is removed automatically.`
      : `Copy ${sourceEndpointId} to ${targetZone}? The source VM remains unchanged.`;
    if (!window.confirm(prompt)) return;
    try {
      setBusy(true, "Preparing migration snapshot and target state disk...");
      await updateMigration("prepare", { sourceEndpointId, mode, targetZone, targetEndpointId });
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  elements.migrationTargets.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-migration-action]");
    if (!button || button.disabled) return;
    const action = String(button.dataset.migrationAction || "");
    const migrationId = String(button.dataset.migrationId || "");
    const prompt = action === "delete"
      ? "Delete this prepared migration target, its state disk and its migration snapshot?"
      : "Start this prepared VM? Compute Engine will attempt to allocate the saved CPU/GPU profile now.";
    if (!window.confirm(prompt)) return;
    try {
      setBusy(true, action === "start" ? "Creating VM from prepared state disk..." : "Deleting prepared migration target...");
      await updateMigration(action, { migrationId });
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  elements.endpointsList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-endpoint-action]");
    if (!button || button.disabled) {
      return;
    }
    const endpointId = String(button.dataset.endpointId || "");
    const action = String(button.dataset.endpointAction || "");
    const zoneInput = elements.endpointsList.querySelector(`[data-endpoint-zone="${CSS.escape(endpointId)}"]`);
    const zone = String(zoneInput && zoneInput.value || "").trim();
    const confirmation = action === "remove"
      ? `Remove endpoint ${endpointId}? Its DuckDNS domain must be removed separately in DuckDNS.`
      : action === "release-ip"
        ? `Release the static IP for ${endpointId}?`
        : `Reserve a regional external IP for ${endpointId} in ${zone}?`;
    if (!window.confirm(confirmation)) {
      return;
    }
    try {
      setBusy(true);
      await updateEndpoint(action, endpointId, action === "reserve-ip" ? { zone } : {});
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  elements.runtimeEndpoint.addEventListener("change", () => {
    renderRuntimeImages();
    setBusy(state.isBusy);
  });

  elements.sunshineEndpoint.addEventListener("change", async () => {
    state.sunshineEndpointId = String(elements.sunshineEndpoint.value || "");
    state.sunshineCredentialsPayload = null;
    state.sunshinePasswordVisible = false;
    try {
      setBusy(true);
      await loadSunshineCredentials();
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  elements.sunshinePasswordToggle.addEventListener("click", async () => {
    if (state.sunshinePasswordVisible) {
      state.sunshinePasswordVisible = false;
      if (state.sunshineCredentialsPayload && state.sunshineCredentialsPayload.credentials) {
        state.sunshineCredentialsPayload.credentials.password = "";
      }
      renderSunshineCredentials();
      setBusy(state.isBusy);
      return;
    }
    try {
      setBusy(true);
      await loadSunshineCredentials({ reveal: true });
      setMessage("Sunshine password is shown only in this administrator browser view.", "warning");
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  elements.sunshinePasswordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = String(elements.sunshinePasswordInput.value || "").trim();
    if (!password) {
      setMessage("Provide a new Sunshine password.", "warning");
      return;
    }
    if (!window.confirm("Update the Sunshine password for the selected endpoint? A running GPU VM will restart Sunshine.")) {
      return;
    }
    try {
      setBusy(true);
      await updateSunshinePassword(password);
      elements.sunshinePasswordInput.value = "";
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  elements.refreshRuntimeImages.addEventListener("click", async () => {
    try {
      setBusy(true);
      await updateRuntimeImages("refresh-catalog", "");
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  elements.runtimeImagesList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-runtime-action]");
    if (!button || button.disabled) {
      return;
    }
    const action = String(button.dataset.runtimeAction || "");
    const component = String(button.dataset.runtimeComponent || "");
    const select = elements.runtimeImagesList.querySelector(`[data-runtime-image-select="${CSS.escape(component)}"]`);
    const imageRef = String(select && select.value || "");
    if (action !== "rollback" && !imageRef) {
      setMessage("Select a trusted image version first.", "warning");
      return;
    }
    const confirmation = action === "apply"
      ? `Apply the selected ${component} image? The affected service will restart. A ready backup is required.`
      : action === "rollback"
        ? `Rollback ${component} to its previous immutable image? The affected service will restart.`
        : `Pull the selected ${component} image without restarting a service?`;
    if (!window.confirm(confirmation)) {
      return;
    }
    try {
      setBusy(true);
      await updateRuntimeImages(action, component, { imageRef, confirm: action !== "pull" });
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  elements.compatibilityForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      setBusy(true);
      await updateCompatibility("record", {
        hardwareId: String(elements.compatibilityHardware.value || ""),
        imageRef: String(elements.compatibilityImageRef.value || "").trim(),
        imageTag: String(elements.compatibilityImageTag.value || "").trim(),
        sunshineVersion: String(elements.compatibilitySunshineVersion.value || "").trim(),
        driverVersion: String(elements.compatibilityDriverVersion.value || "").trim(),
        result: String(elements.compatibilityResult.value || "unknown"),
        evidence: String(elements.compatibilityEvidence.value || "").trim(),
      });
      elements.compatibilityEvidence.value = "";
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  elements.compatibilityList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-compatibility-remove]");
    if (!button || button.disabled) {
      return;
    }
    if (!window.confirm("Remove this compatibility record?")) {
      return;
    }
    try {
      setBusy(true);
      await updateCompatibility("remove", { recordId: String(button.dataset.compatibilityRemove || "") });
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  elements.softwareEndpoint.addEventListener("change", async () => {
    try {
      state.softwareEndpointId = String(elements.softwareEndpoint.value || "");
      state.softwareMinecraftSelection = "";
      setBusy(true, "Loading selected VM software...");
      await loadSoftware();
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  [elements.softwareApplication, elements.softwareMinecraftVersion, elements.softwareMinecraftServerType, elements.softwareMinecraftServer].forEach((input) => {
    input.addEventListener("change", () => {
      if (input === elements.softwareMinecraftServer) {
        state.softwareMinecraftSelection = String(input.value || "__new__");
      }
      renderSoftware();
      setBusy(state.isBusy);
    });
  });

  elements.softwareMinecraftNewServer.addEventListener("input", () => {
    renderSoftware();
    setBusy(state.isBusy);
  });

  elements.softwareRefreshMinecraftVersions.addEventListener("click", async () => {
    try {
      setBusy(true, "Refreshing Minecraft version catalog...");
      await updateSoftware("refresh-minecraft-versions");
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  elements.softwareActions.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-software-command]");
    if (!button || button.disabled) {
      return;
    }
    const command = button.dataset.softwareCommand || "";
    if (command === "remove-minecraft" && !window.confirm("Remove the Minecraft server container and configuration from the selected endpoint? World data is preserved.")) {
      return;
    }
    try {
      const loadingMessages = {
        "install-app": "Installing application...",
        "uninstall-app": "Removing application...",
        "install-minecraft": "Creating Minecraft server...",
        "start-minecraft": "Starting Minecraft server...",
        "stop-minecraft": "Stopping Minecraft server...",
        "restart-minecraft": "Restarting Minecraft server...",
        "remove-minecraft": "Removing Minecraft server...",
      };
      setBusy(true, loadingMessages[command] || "Updating software...");
      await updateSoftware(command);
    } catch (error) {
      handleError(error);
      if (elements.softwareStatus) {
        elements.softwareStatus.textContent = error.message || "Software action failed.";
        elements.softwareStatus.dataset.tone = "error";
      }
    } finally {
      setBusy(false);
    }
  });

  if (!initializeAdminTabs()) {
    return;
  }
  loadConfig();
  setBusy(false);
  if (state.backendUrl) {
    setBusy(true);
    connectBackend({ silent: true })
      .catch(handleError)
      .finally(() => setBusy(false));
  }
  if (!state.token && window.opener) {
    window.opener.postMessage({ type: adminSessionRequest }, window.location.origin);
  }
})();
