(function () {
  const defaultBackendUrl = "https://steam-vm-control-api-w2urpq2xlq-lm.a.run.app";
  const defaultAutoStopHours = "3";

  const storageKeys = {
    config: "vm-control-cloudrun-config",
    sessionToken: "vm-control-google-session-token",
    history: "vm-control-session-history",
  };
  const SUNSHINE_POLL_INTERVAL_MS = 3000;
  const SUNSHINE_POLL_TIMEOUT_MS = 180000;
  const POST_COMMAND_STATUS_REFRESH_DELAY_MS = 2000;
  const COMMAND_STATUS_POLL_TIMEOUT_MS = 300000;
  const COMMAND_SUNSHINE_TRANSITIONS = {
    create: {
      state: "starting",
      label: "Creating VM",
      detail: "VM creation requested. Waiting for Sunshine Web UI.",
    },
    start: {
      state: "starting",
      label: "Starting",
      detail: "VM start requested. Waiting for Sunshine Web UI.",
    },
    restart: {
      state: "starting",
      label: "Restarting",
      detail: "VM restart requested. Waiting for Sunshine Web UI.",
    },
    stop: {
      state: "stopping",
      label: "Stopping",
      detail: "VM stop requested. Sunshine is stopping.",
    },
    delete: {
      state: "stopping",
      label: "Stopping",
      detail: "VM delete requested. Sunshine is stopping.",
    },
    "create-backup": {
      state: "backup",
      label: "Backup in progress",
      detail: "Steam Headless and Sunshine can be temporarily stopped while the manual backup runs.",
    },
    "restore-backup": {
      state: "restore",
      label: "Restore in progress",
      detail: "Steam Headless and Sunshine can be temporarily stopped while the selected backup is restored.",
    },
    "install-app": {
      state: "starting",
      label: "Updating application",
      detail: "Updating Sunshine application list.",
    },
    "uninstall-app": {
      state: "starting",
      label: "Updating application",
      detail: "Updating Sunshine application list.",
    },
  };
  const COMMAND_MINECRAFT_TRANSITIONS = {
    "install-minecraft": {
      state: "starting",
      label: "Installing",
      detail: "Installing and starting Minecraft server.",
    },
    "start-minecraft": {
      state: "starting",
      label: "Starting",
      detail: "Starting Minecraft server.",
    },
    "stop-minecraft": {
      state: "stopping",
      label: "Stopping",
      detail: "Stopping Minecraft server.",
    },
    "restart-minecraft": {
      state: "starting",
      label: "Restarting",
      detail: "Restarting Minecraft server.",
    },
    "remove-minecraft": {
      state: "stopping",
      label: "Removing",
      detail: "Removing Minecraft container while preserving world data.",
    },
  };
  const COMMANDS_TO_POLL_AFTER_RESPONSE = new Set([
    "create",
    "start",
    "restart",
    "create-backup",
    "restore-backup",
    "install-app",
    "uninstall-app",
    "install-minecraft",
    "start-minecraft",
    "stop-minecraft",
    "restart-minecraft",
    "remove-minecraft",
  ]);

  const elements = {
    backendUrl: document.querySelector("#backend-url"),
    connect: document.querySelector("#connect"),
    authStatus: document.querySelector("#auth-status"),
    googleSignIn: document.querySelector("#google-sign-in"),
    signOut: document.querySelector("#sign-out"),
    targetSummary: document.querySelector("#target-summary"),
    refreshStatus: document.querySelector("#refresh-status"),
    hardwareSelect: document.querySelector("#hardware-select"),
    zoneSelect: document.querySelector("#zone-select"),
    refreshHardware: document.querySelector("#refresh-hardware"),
    hardwareOptionsStatus: document.querySelector("#hardware-options-status"),
    autoStopHours: document.querySelector("#auto-stop-hours"),
    backupSelect: document.querySelector("#backup-select"),
    backupOptionsStatus: document.querySelector("#backup-options-status"),
    applicationSelect: document.querySelector("#application-select"),
    applicationOptionsStatus: document.querySelector("#application-options-status"),
    minecraftAddress: document.querySelector("#minecraft-address"),
    minecraftOptionsStatus: document.querySelector("#minecraft-options-status"),
    banner: document.querySelector("#banner"),
    access: document.querySelector("#access"),
    history: document.querySelector("#history"),
    form: document.querySelector("#settings-form"),
    actionButtons: Array.from(document.querySelectorAll("[data-command]")),
  };

  const state = {
    backendUrl: "",
    backendConfig: null,
    googleInitializedFor: "",
    googleTokenClient: null,
    token: "",
    user: null,
    lastStatus: null,
    hardwarePayload: null,
    isBusy: false,
    commandStatusRefreshTimer: null,
    history: [],
  };

  function loadConfig() {
    const saved = JSON.parse(window.localStorage.getItem(storageKeys.config) || "{}");
    state.backendUrl = saved.backendUrl || defaultBackendUrl;
    state.token = window.sessionStorage.getItem(storageKeys.sessionToken) || "";
    state.history = JSON.parse(window.localStorage.getItem(storageKeys.history) || "[]");
    elements.backendUrl.value = state.backendUrl;
    elements.autoStopHours.value = Object.prototype.hasOwnProperty.call(saved, "autoStopHours")
      ? String(saved.autoStopHours || "")
      : defaultAutoStopHours;
    if (elements.hardwareSelect && saved.hardwareId) {
      elements.hardwareSelect.dataset.savedValue = String(saved.hardwareId);
    }
    if (elements.zoneSelect && saved.zone) {
      elements.zoneSelect.dataset.savedValue = String(saved.zone);
    }
    renderHistory();
    renderTargetSummary();
    renderBackupOptions(null);
    renderApplicationOptions(null);
    renderMinecraftOptions(null);
    renderHardwareOptions(null);
    renderAccess(null);
    updateAuthUi();
  }

  function saveConfig() {
    state.backendUrl = sanitizeBackendUrl(elements.backendUrl.value);
    window.localStorage.setItem(
      storageKeys.config,
      JSON.stringify({
        backendUrl: state.backendUrl,
        autoStopHours: String(elements.autoStopHours.value || "").trim(),
        hardwareId: String(elements.hardwareSelect && elements.hardwareSelect.value || "").trim(),
        zone: String(elements.zoneSelect && elements.zoneSelect.value || "").trim(),
      }),
    );
  }

  function sanitizeBackendUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function saveHistory() {
    window.localStorage.setItem(storageKeys.history, JSON.stringify(state.history.slice(0, 20)));
  }

  function setBusy(nextBusy) {
    state.isBusy = nextBusy;
    elements.connect.disabled = nextBusy;
    elements.googleSignIn.disabled = nextBusy || !state.backendConfig;
    if (elements.refreshHardware) {
      elements.refreshHardware.disabled = nextBusy || !state.user;
    }
    updateActionAvailability();

    const canSetSunshine = canSetSunshinePassword(state.lastStatus);
    const sunshineSubmit = document.querySelector("#sunshine-password-submit");
    if (sunshineSubmit) {
      sunshineSubmit.disabled = !canSetSunshine;
      sunshineSubmit.title = canSetSunshine
        ? "Update Sunshine password"
        : "Sign in and wait until the VM is reachable";
    }

    const sunshineInput = document.querySelector("#sunshine-password-input");
    if (sunshineInput) {
      sunshineInput.disabled = !canSetSunshine;
      sunshineInput.placeholder = canSetSunshine ? "Minimum 8 characters" : "Set to update";
    }
  }

  function canSetSunshinePassword(payload) {
    if (!state.user || state.isBusy || !payload) {
      return false;
    }
    const hasInstance = Boolean(payload.instanceExists);
    const hasPermission = !Array.isArray(payload.allowedCommands)
      || payload.allowedCommands.includes("set-sunshine-password");
    return hasInstance && hasPermission;
  }

  function updateActionAvailability() {
    const allowed = new Set(
      state.user && state.lastStatus && Array.isArray(state.lastStatus.allowedCommands)
        ? state.lastStatus.allowedCommands
        : state.user
          ? ["status"]
          : [],
    );

    if (elements.refreshStatus) {
      elements.refreshStatus.disabled = !state.user || !allowed.has("status");
    }
    if (elements.hardwareSelect) {
      elements.hardwareSelect.disabled = state.isBusy || !state.user || !state.hardwarePayload;
    }
    if (elements.zoneSelect) {
      elements.zoneSelect.disabled = state.isBusy || !state.user || !selectedHardwareProfile();
    }
    elements.autoStopHours.disabled = state.isBusy || !state.user || (!allowed.has("start") && !allowed.has("create"));
    if (elements.backupSelect) {
      const hasBackups = getAvailableBackups(state.lastStatus).length > 0;
      const canUseBackupSelection = allowed.has("restore-backup") || allowed.has("remove-backup");
      elements.backupSelect.disabled = state.isBusy || !state.user || !canUseBackupSelection || !hasBackups;
    }
    if (elements.applicationSelect) {
      const hasApplications = getApplicationCatalog(state.lastStatus).length > 0;
      const canChangeApps = allowed.has("install-app") || allowed.has("uninstall-app");
      elements.applicationSelect.disabled = state.isBusy || !state.user || !canChangeApps || !hasApplications;
    }
    if (elements.minecraftAddress) {
      elements.minecraftAddress.disabled = true;
    }
    elements.actionButtons.forEach((button) => {
      const command = button.dataset.command;
      const needsBackup = command === "restore-backup" || command === "remove-backup";
      const needsApplication = command === "install-app" || command === "uninstall-app";
      const hasSelectedBackup = Boolean(elements.backupSelect && elements.backupSelect.value);
      const hasSelectedApplication = Boolean(elements.applicationSelect && elements.applicationSelect.value);
      button.disabled = (state.isBusy && command !== "status")
        || !state.user
        || !allowed.has(command)
        || (needsBackup && !hasSelectedBackup)
        || (needsApplication && !hasSelectedApplication);
    });
  }

  function isCommandAllowed(command) {
    return Boolean(
      state.user &&
        state.lastStatus &&
        Array.isArray(state.lastStatus.allowedCommands) &&
        state.lastStatus.allowedCommands.includes(command),
    );
  }

  function setBanner(message, tone) {
    elements.banner.textContent = message;
    elements.banner.dataset.tone = tone || "neutral";
  }

  function statusBannerMessage(prefix, data) {
    const parts = [`${prefix}. Current VM state: ${data.status || "UNKNOWN"}`];
    if (data.sunshineStatus && data.sunshineStatus.label) {
      parts.push(`Sunshine: ${data.sunshineStatus.label}`);
    }
    if (data.powerAction && data.powerAction.action && data.powerAction.phase) {
      parts.push(`VM action: ${data.powerAction.action} ${data.powerAction.phase}`);
    }
    return `${parts.join(", ")}.`;
  }

  function schedulePostCommandStatusRefresh(command) {
    if (command === "status" || !state.user) {
      return;
    }

    if (state.commandStatusRefreshTimer) {
      window.clearTimeout(state.commandStatusRefreshTimer);
    }

    state.commandStatusRefreshTimer = window.setTimeout(async () => {
      state.commandStatusRefreshTimer = null;
      if (!state.user) {
        return;
      }

      try {
        const data = await refreshStatus({ silent: true });
        setBanner(statusBannerMessage("VM status refreshed", data), state.isBusy ? "warning" : "success");
      } catch (error) {
        handleError(error);
      }
    }, POST_COMMAND_STATUS_REFRESH_DELAY_MS);
  }

  function setAuthStatus(message, tone) {
    elements.authStatus.textContent = message;
    elements.authStatus.dataset.tone = tone || "neutral";
  }

  function updateAuthUi() {
    if (state.user) {
      setAuthStatus(`Signed in as ${state.user.email}`, "success");
      elements.signOut.classList.remove("hidden");
    } else if (state.backendConfig) {
      setAuthStatus("Backend connected. Sign in with Google to continue.", "warning");
      elements.signOut.classList.add("hidden");
    } else {
      setAuthStatus("Connect the backend, then sign in with Google.", "neutral");
      elements.signOut.classList.add("hidden");
    }
    updateBackendUrlVisibility();
    renderTargetSummary();
    updateActionAvailability();
  }

  function updateBackendUrlVisibility() {
    if (!elements.backendUrl) {
      return;
    }

    if (state.user) {
      elements.backendUrl.type = "url";
      elements.backendUrl.value = state.backendUrl;
      return;
    }

    elements.backendUrl.type = "password";
    elements.backendUrl.value = state.backendUrl;
  }

  function pushHistory(entry) {
    state.history.unshift(entry);
    state.history = state.history.slice(0, 20);
    saveHistory();
    renderHistory();
  }

  function renderHistory() {
    if (!state.history.length) {
      elements.history.className = "runs empty";
      elements.history.textContent = "No actions recorded yet.";
      return;
    }

    elements.history.className = "runs";
    elements.history.innerHTML = state.history
      .map((entry) => {
        const title = escapeHtml(`${entry.command.toUpperCase()} · ${entry.status || "UNKNOWN"}`);
        const time = escapeHtml(new Date(entry.at).toLocaleString());
        const by = entry.userEmail ? `by ${escapeHtml(entry.userEmail)}` : "unknown user";
        const message = entry.message ? `<div class="run-detail">${escapeHtml(entry.message)}</div>` : "";
        const dns = entry.duckdnsDomains && entry.duckdnsDomains.length
          ? `<div class="run-detail">DuckDNS: ${escapeHtml(entry.duckdnsDomains.join(", "))}</div>`
          : "";
        return `
          <article class="run-card">
            <div class="run-top">
              <h3 class="run-title">${title}</h3>
              <div class="run-badges">
                <span class="run-badge status completed ${escapeToken(entry.tone || "success")}">${escapeHtml(entry.tone || "success")}</span>
              </div>
            </div>
            <div class="run-meta">
              <span>${time}</span>
              <span>${by}</span>
            </div>
            ${message}
            ${dns}
          </article>
        `;
      })
      .join("");
  }

  function commandCompletionMessage(command, payload) {
    const vmState = payload && payload.instanceExists === false ? "deleted" : String(payload && payload.status ? payload.status : "UNKNOWN");
    const sunshineState = String(
      payload && payload.sunshineStatus && payload.sunshineStatus.label
        ? payload.sunshineStatus.label
        : payload && payload.sunshineStatus && payload.sunshineStatus.state
          ? payload.sunshineStatus.state
          : "unknown",
    ).toLowerCase();
    const powerAction = payload && payload.powerAction ? payload.powerAction : null;
    const powerActionPhase = String(powerAction && powerAction.phase ? powerAction.phase : "").toLowerCase();
    const powerActionName = String(powerAction && powerAction.action ? powerAction.action : "");
    const powerActionSuffix = powerActionPhase === "failed" && powerActionName
      ? ` Last VM action "${powerActionName}" failed; check backup/delete logs before retrying.`
      : powerActionPhase === "running" && powerActionName
        ? ` VM action "${powerActionName}" is still running.`
        : "";
    const minecraftState = payload && payload.minecraftStatus && payload.minecraftStatus.label
      ? `, Minecraft state: ${String(payload.minecraftStatus.label).toLowerCase()}`
      : "";
    return `Command "${command}" completed. Final VM state: ${vmState}, Sunshine state: ${sunshineState}${minecraftState}.${powerActionSuffix}`;
  }

  function getAvailableBackups(payload) {
    const backups = payload && payload.persistence && Array.isArray(payload.persistence.backups)
      ? payload.persistence.backups
      : [];
    return backups.filter((backup) => backup && backup.id);
  }

  function getApplicationCatalog(payload) {
    const fromPayload = payload && payload.applications && Array.isArray(payload.applications.catalog)
      ? payload.applications.catalog
      : [];
    const fromConfig = state.backendConfig && Array.isArray(state.backendConfig.applicationCatalog)
      ? state.backendConfig.applicationCatalog
      : [];
    const catalog = fromPayload.length ? fromPayload : fromConfig;
    return catalog.filter((item) => item && item.id && item.label);
  }

  function selectedApplicationLabel() {
    const appId = String(elements.applicationSelect && elements.applicationSelect.value || "").trim();
    const app = getApplicationCatalog(state.lastStatus).find((item) => String(item.id) === appId);
    return app ? String(app.label || app.id) : appId;
  }

  function getHardwareProfiles() {
    const profiles = state.hardwarePayload && Array.isArray(state.hardwarePayload.profiles)
      ? state.hardwarePayload.profiles
      : [];
    return profiles.filter((profile) => profile && profile.id && Array.isArray(profile.zones));
  }

  function selectedHardwareProfile() {
    const selectedId = String(elements.hardwareSelect && elements.hardwareSelect.value || "").trim();
    return getHardwareProfiles().find((profile) => String(profile.id) === selectedId) || null;
  }

  function selectedZone() {
    return String(elements.zoneSelect && elements.zoneSelect.value || "").trim();
  }

  function selectedHardwareLabel() {
    const profile = selectedHardwareProfile();
    return profile ? String(profile.label || profile.id) : "";
  }

  function selectedTargetParams() {
    const profile = selectedHardwareProfile();
    const zone = selectedZone();
    if (!profile || !zone) {
      return {};
    }
    return {
      hardwareId: String(profile.id || ""),
      zone,
      machineType: String(profile.machineType || ""),
      gpuType: String(profile.gpuType || ""),
      gpuCount: Number(profile.gpuCount || 0),
      acceleratorMode: String(profile.acceleratorMode || "none"),
    };
  }

  function statusQueryString() {
    const params = new URLSearchParams();
    Object.entries(selectedTargetParams()).forEach(([key, value]) => {
      if (value !== "" && value !== null && value !== undefined) {
        params.set(key, String(value));
      }
    });
    const query = params.toString();
    return query ? `?${query}` : "";
  }

  function renderHardwareOptions(payload) {
    if (!elements.hardwareSelect || !elements.zoneSelect) {
      return;
    }

    state.hardwarePayload = payload || state.hardwarePayload;
    const profiles = getHardwareProfiles();
    if (!profiles.length) {
      elements.hardwareSelect.innerHTML = '<option value="">No hardware profiles loaded</option>';
      elements.zoneSelect.innerHTML = '<option value="">No zones loaded</option>';
      if (elements.hardwareOptionsStatus) {
        elements.hardwareOptionsStatus.textContent = "Sign in and refresh hardware to load Compute Engine availability.";
      }
      updateActionAvailability();
      return;
    }

    const previousHardware = elements.hardwareSelect.value
      || elements.hardwareSelect.dataset.savedValue
      || String((state.hardwarePayload.defaultSelection || {}).id || "");
    elements.hardwareSelect.innerHTML = profiles.map((profile) => {
      const id = String(profile.id || "");
      const gpuCount = Number(profile.gpuCount || 0);
      const zoneCount = Array.isArray(profile.zones) ? profile.zones.length : 0;
      const suffix = gpuCount > 0
        ? `${profile.gpuType || profile.id}, ${profile.machineType || "machine"}`
        : `${profile.machineType || "machine"}`;
      return `<option value="${escapeHtml(id)}">${escapeHtml(profile.label || id)} (${escapeHtml(suffix)}, ${zoneCount} zones)</option>`;
    }).join("");
    if (profiles.some((profile) => String(profile.id) === previousHardware)) {
      elements.hardwareSelect.value = previousHardware;
    } else {
      elements.hardwareSelect.value = String(profiles[0].id || "");
    }
    elements.hardwareSelect.dataset.savedValue = "";
    renderZoneOptions();
    updateActionAvailability();
  }

  function renderZoneOptions() {
    if (!elements.zoneSelect) {
      return;
    }
    const profile = selectedHardwareProfile();
    const zones = profile && Array.isArray(profile.zones) ? profile.zones : [];
    if (!zones.length) {
      elements.zoneSelect.innerHTML = '<option value="">No zones available</option>';
      if (elements.hardwareOptionsStatus) {
        elements.hardwareOptionsStatus.textContent = `No zones currently expose ${selectedHardwareLabel() || "selected hardware"}. Refresh later or choose CPU.`;
      }
      saveConfig();
      updateActionAvailability();
      return;
    }
    const previousZone = elements.zoneSelect.value
      || elements.zoneSelect.dataset.savedValue
      || String((state.hardwarePayload && state.hardwarePayload.defaultSelection || {}).zone || "");
    elements.zoneSelect.innerHTML = zones.map((zone) => (
      `<option value="${escapeHtml(zone)}">${escapeHtml(zone)}</option>`
    )).join("");
    if (zones.includes(previousZone)) {
      elements.zoneSelect.value = previousZone;
    } else {
      elements.zoneSelect.value = zones[0];
    }
    elements.zoneSelect.dataset.savedValue = "";
    if (elements.hardwareOptionsStatus) {
      const refreshedAt = state.hardwarePayload && state.hardwarePayload.refreshedAt
        ? ` Refreshed: ${state.hardwarePayload.refreshedAt}.`
        : "";
      elements.hardwareOptionsStatus.textContent = `${selectedHardwareLabel()} available in ${zones.length} zone${zones.length === 1 ? "" : "s"}.${refreshedAt}`;
    }
    saveConfig();
    updateActionAvailability();
  }

  async function refreshHardwareOptions(options) {
    const silent = Boolean(options && options.silent);
    if (!state.user) {
      throw new Error("Sign in with Google first.");
    }
    if (!silent && elements.hardwareOptionsStatus) {
      elements.hardwareOptionsStatus.textContent = "Refreshing Compute Engine hardware availability...";
    }
    const data = await fetchApi("/api/hardware", { method: "GET" });
    renderHardwareOptions(data);
    return data;
  }

  function renderBackupOptions(payload) {
    if (!elements.backupSelect) {
      return;
    }

    const previousValue = elements.backupSelect.value;
    const backups = getAvailableBackups(payload);
    if (!backups.length) {
      elements.backupSelect.innerHTML = '<option value="">No manual backups available</option>';
      if (elements.backupOptionsStatus) {
        elements.backupOptionsStatus.textContent = "No manual backups found yet. Use Create Backup after the VM is ready.";
      }
      updateActionAvailability();
      return;
    }

    elements.backupSelect.innerHTML = [
      '<option value="">Select backup...</option>',
      ...backups.map((backup) => {
        const id = String(backup.id || "");
        const label = String(backup.label || backup.createdAt || id);
        return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
      }),
    ].join("");
    if (previousValue && backups.some((backup) => String(backup.id) === previousValue)) {
      elements.backupSelect.value = previousValue;
    }
    if (elements.backupOptionsStatus) {
      elements.backupOptionsStatus.textContent = `${backups.length} manual backup${backups.length === 1 ? "" : "s"} available.`;
    }
    updateActionAvailability();
  }

  function renderApplicationOptions(payload) {
    if (!elements.applicationSelect) {
      return;
    }

    const previousValue = elements.applicationSelect.value;
    const applications = getApplicationCatalog(payload);
    if (!applications.length) {
      elements.applicationSelect.innerHTML = '<option value="">No applications available</option>';
      if (elements.applicationOptionsStatus) {
        elements.applicationOptionsStatus.textContent = "No supported applications are defined by the backend.";
      }
      updateActionAvailability();
      return;
    }

    elements.applicationSelect.innerHTML = [
      '<option value="">Select application...</option>',
      ...applications.map((app) => {
        const id = String(app.id || "");
        const label = String(app.label || id);
        return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
      }),
    ].join("");
    if (previousValue && applications.some((app) => String(app.id) === previousValue)) {
      elements.applicationSelect.value = previousValue;
    }
    if (elements.applicationOptionsStatus) {
      const labels = applications.map((app) => String(app.label || app.id)).join(", ");
      elements.applicationOptionsStatus.textContent = `Supported applications: ${labels}.`;
    }
    updateActionAvailability();
  }

  function renderStatusPayload(payload) {
    state.lastStatus = payload;
    renderTargetSummary();
    renderBackupOptions(payload);
    renderApplicationOptions(payload);
    renderMinecraftOptions(payload);
    renderAccess(payload);
    updateActionAvailability();
  }

  function withSunshineStatus(payload, sunshineStatus) {
    if (!payload) {
      return payload;
    }
    return {
      ...payload,
      sunshineStatus: {
        ...(payload.sunshineStatus || {}),
        ...sunshineStatus,
      },
    };
  }

  function applyCommandTransition(command) {
    const sunshineStatus = COMMAND_SUNSHINE_TRANSITIONS[command];
    const minecraftStatus = COMMAND_MINECRAFT_TRANSITIONS[command];
    if (!state.lastStatus) {
      return;
    }
    if (sunshineStatus) {
      renderStatusPayload(withSunshineStatus(state.lastStatus, sunshineStatus));
      return;
    }
    if (minecraftStatus) {
      renderStatusPayload({
        ...state.lastStatus,
        minecraftStatus: {
          ...(state.lastStatus.minecraftStatus || {}),
          ...minecraftStatus,
        },
      });
    }
  }

  function isTransitionalStatus(payload) {
    if (!payload) {
      return false;
    }

    const powerAction = payload.powerAction || {};
    const powerActionPhase = String(powerAction.phase || "").trim().toLowerCase();
    if (["requested", "running", "rebooting", "stopping", "backed-up"].includes(powerActionPhase)) {
      return true;
    }

    const sunshineState = String(payload.sunshineStatus && payload.sunshineStatus.state || "")
      .trim()
      .toLowerCase();
    const minecraftState = String(payload.minecraftStatus && payload.minecraftStatus.state || "")
      .trim()
      .toLowerCase();
    return ["starting", "stopping", "backup", "restore"].includes(sunshineState)
      || ["installing", "starting", "stopping"].includes(minecraftState);
  }

  async function waitForStatusSettled(command, initialPayload) {
    if (!COMMANDS_TO_POLL_AFTER_RESPONSE.has(command)) {
      return initialPayload;
    }

    const deadline = Date.now() + COMMAND_STATUS_POLL_TIMEOUT_MS;
    let payload = initialPayload;

    while (Date.now() < deadline && isTransitionalStatus(payload)) {
      await wait(SUNSHINE_POLL_INTERVAL_MS);
      payload = await refreshStatus({ silent: true });
    }

    return payload;
  }

  async function waitForSunshineReady() {
    const deadline = Date.now() + SUNSHINE_POLL_TIMEOUT_MS;
    let payload = state.lastStatus;
    if (!payload) {
      payload = await refreshStatus({ silent: true });
    }

    while (Date.now() < deadline) {
      const sunshineState = String(payload && payload.sunshineStatus && payload.sunshineStatus.state ? payload.sunshineStatus.state : "")
        .trim()
        .toLowerCase();
      if (sunshineState === "ready") {
        return payload;
      }

      await wait(SUNSHINE_POLL_INTERVAL_MS);
      payload = await refreshStatus({ silent: true });
    }

    return payload;
  }

  function renderTargetSummary() {
    const config = state.backendConfig;
    if (!config) {
      elements.targetSummary.innerHTML = "<p>Backend not connected yet.</p>";
      return;
    }

    if (!state.user) {
      elements.targetSummary.innerHTML = "<p>Sign in with Google to view target details.</p>";
      return;
    }

    const target = config.target || {};
    const domains = (config.duckdnsDomains || []).length
      ? `<p><strong>DuckDNS:</strong> <code>${escapeHtml(config.duckdnsDomains.join(", "))}</code></p>`
      : "<p><strong>DuckDNS:</strong> not configured</p>";
    const persistence = state.lastStatus && state.lastStatus.persistence ? state.lastStatus.persistence : null;
    const persistenceMeta = persistence
      ? `
        <p><strong>Data disk:</strong> <code>${escapeHtml(persistence.dataDisk && persistence.dataDisk.label || "unknown")}</code></p>
        <p><strong>Restore:</strong> <code>${escapeHtml(persistence.restore && persistence.restore.label || "idle")}</code></p>
        <p><strong>Last home backup:</strong> <code>${escapeHtml(persistence.homeBackup && persistence.homeBackup.lastAt || "n/a")}</code></p>
        <p><strong>Last games archive:</strong> <code>${escapeHtml(persistence.gamesArchive && persistence.gamesArchive.lastAt || "n/a")}</code></p>
      `
      : "";
    const selectedParams = selectedTargetParams();
    const responseHardware = state.lastStatus && state.lastStatus.hardware ? state.lastStatus.hardware : {};
    const effectiveHardware = Object.keys(selectedParams).length ? selectedParams : responseHardware;
    const hardwareMeta = effectiveHardware && effectiveHardware.zone
      ? `
        <p><strong>Hardware:</strong> <code>${escapeHtml(selectedHardwareLabel() || effectiveHardware.id || "unknown")}</code></p>
        <p><strong>Selected zone:</strong> <code>${escapeHtml(effectiveHardware.zone || "unknown")}</code></p>
        <p><strong>Machine:</strong> <code>${escapeHtml(effectiveHardware.machineType || "unknown")}</code></p>
      `
      : "";

    elements.targetSummary.innerHTML = `
      <p><strong>Backend:</strong> <code>${escapeHtml(state.backendUrl)}</code></p>
      <p><strong>Project:</strong> <code>${escapeHtml(target.project || "unknown")}</code></p>
      <p><strong>Zone:</strong> <code>${escapeHtml(target.zone || "unknown")}</code></p>
      <p><strong>Instance:</strong> <code>${escapeHtml(target.instance || "unknown")}</code></p>
      ${domains}
      ${hardwareMeta}
      ${persistenceMeta}
    `;
  }

  async function waitForGoogleIdentity() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        return;
      }
      await wait(200);
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
      setBanner("Connecting to Cloud Run backend...", "warning");
    }

    const response = await window.fetch(`${state.backendUrl}/api/config`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Backend returned ${response.status}.`);
    }

    const config = await response.json();
    state.backendConfig = config;
    renderTargetSummary();
    renderApplicationOptions(state.lastStatus);
    renderHardwareOptions({ profiles: [], defaultSelection: config.defaultHardware || null });
    updateAuthUi();

    if (!config.googleClientId) {
      throw new Error("Backend is missing GOOGLE_CLIENT_ID. Finish Cloud Run setup first.");
    }

    await initializeGoogle(config.googleClientId);
    setBanner("Backend connected. Sign in with Google to unlock VM control.", "success");

    if (state.token) {
      await restoreSession();
      await refreshHardwareOptions({ silent: true });
      await refreshStatus({ silent: true });
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
    state.token = token;
    if (token) {
      window.sessionStorage.setItem(storageKeys.sessionToken, token);
    } else {
      window.sessionStorage.removeItem(storageKeys.sessionToken);
    }
  }

  function clearSession(options) {
    const revokeGoogleSession = Boolean(options && options.revokeGoogleSession);
    const token = state.token;
    storeSessionToken("");
    state.user = null;
    state.lastStatus = null;
    renderAccess(null);
    updateAuthUi();
    setBusy(false);
    if (revokeGoogleSession && token && window.google && window.google.accounts && window.google.accounts.oauth2) {
      window.google.accounts.oauth2.revoke(token, () => {});
    }
  }

  async function handleGoogleToken(response) {
    try {
      if (response.error) {
        throw new Error(response.error_description || response.error);
      }
      setBusy(true);
      setBanner("Verifying Google session...", "warning");
      storeSessionToken(response.access_token || "");
      await restoreSession();
      await refreshHardwareOptions({ silent: true });
      await refreshStatus({ silent: true });
    } catch (error) {
      clearSession();
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  function handleGoogleOAuthError(error) {
    clearSession();
    if (!error || !error.type) {
      handleError(new Error("Google sign-in failed."));
      return;
    }

    if (error.type === "popup_closed") {
      setBanner("Google sign-in popup was closed before authentication finished.", "warning");
      return;
    }

    if (error.type === "popup_failed_to_open") {
      handleError(new Error("Google sign-in popup failed to open. Allow popups for this page and try again."));
      return;
    }

    handleError(new Error(`Google sign-in failed: ${error.type}`));
  }

  async function restoreSession() {
    const data = await fetchApi("/api/me", { method: "GET" });
    state.user = data.user;
    updateAuthUi();
    setBanner(`Signed in as ${state.user.email}.`, "success");
  }

  async function fetchApi(path, options) {
    if (!state.backendUrl) {
      throw new Error("Cloud Run backend is not connected.");
    }

    const headers = {
      Accept: "application/json",
      ...(options && options.body ? { "Content-Type": "application/json" } : {}),
      ...(options && options.headers ? options.headers : {}),
    };

    if (state.token) {
      headers.Authorization = `Bearer ${state.token}`;
    }

    const response = await window.fetch(`${state.backendUrl}${path}`, {
      ...options,
      headers,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        clearSession();
      }
      throw new Error((payload && payload.error) || `API returned ${response.status}.`);
    }

    return payload;
  }

  async function dispatchCommand(command) {
    if (!state.user) {
      throw new Error("Sign in with Google first.");
    }

    if (command === "delete") {
      const confirmed = window.confirm("Delete will stop and remove the VM without creating a backup. Continue?");
      if (!confirmed) {
        setBanner("Delete cancelled.", "warning");
        return;
      }
    }

    if (command === "restore-backup") {
      const backupId = String(elements.backupSelect && elements.backupSelect.value || "").trim();
      if (!backupId) {
        throw new Error("Select a backup before running Restore Backup.");
      }
      const confirmed = window.confirm(`Restore backup "${backupId}"? This replaces current VM home and games data.`);
      if (!confirmed) {
        setBanner("Restore Backup cancelled.", "warning");
        return;
      }
    }

    if (command === "remove-backup") {
      const backupId = String(elements.backupSelect && elements.backupSelect.value || "").trim();
      if (!backupId) {
        throw new Error("Select a backup before running Remove Backup.");
      }
      const confirmed = window.confirm(`Remove backup "${backupId}" from Google Drive? This cannot be undone.`);
      if (!confirmed) {
        setBanner("Remove Backup cancelled.", "warning");
        return;
      }
    }

    if (command === "uninstall-app") {
      const appLabel = selectedApplicationLabel();
      const confirmed = window.confirm(`Uninstall "${appLabel}" and remove it from Sunshine applications?`);
      if (!confirmed) {
        setBanner("Uninstall Application cancelled.", "warning");
        return;
      }
    }

    if (command === "remove-minecraft") {
      const confirmed = window.confirm("Remove the Minecraft container? World data under /mnt/games/minecraft-server/data will be preserved.");
      if (!confirmed) {
        setBanner("Remove Minecraft cancelled.", "warning");
        return;
      }
    }

    setBusy(true);
    const appLabel = command === "install-app" || command === "uninstall-app"
      ? ` for ${selectedApplicationLabel()}`
      : "";
    setBanner(`Running "${command}"${appLabel} on the VM...`, "warning");
    applyCommandTransition(command);
    schedulePostCommandStatusRefresh(command);

    try {
      const body = { command, ...selectedTargetParams() };
      if (command === "delete") {
        body.confirmDelete = true;
      }
      if (command === "restore-backup" || command === "remove-backup") {
        body.backupId = String(elements.backupSelect && elements.backupSelect.value || "").trim();
      }
      if (command === "install-app" || command === "uninstall-app") {
        const applicationId = String(elements.applicationSelect && elements.applicationSelect.value || "").trim();
        if (!applicationId) {
          throw new Error("Select an application first.");
        }
        body.applicationId = applicationId;
      }
      const autoStopHours = readAutoStopHours(command);
      if (autoStopHours) {
        body.autoStopHours = autoStopHours;
      }

      let data = await fetchApi("/api/command", {
        method: "POST",
        body: JSON.stringify(body),
      });
      renderStatusPayload(data);
      if (COMMANDS_TO_POLL_AFTER_RESPONSE.has(command) && isTransitionalStatus(data)) {
        setBanner(`Command "${command}" accepted. Waiting for current VM and Sunshine status...`, "warning");
        data = await waitForStatusSettled(command, data);
        renderStatusPayload(data);
      }

      const suffix = data.duckdnsUpdated
        ? " DuckDNS refreshed."
        : "";
      const autoStop = data.autoStopHours
        ? ` Auto-stop scheduled after ${data.autoStopHours}h.`
        : "";
      const powerActionPhase = String(data.powerAction && data.powerAction.phase ? data.powerAction.phase : "").toLowerCase();
      const bannerTone = powerActionPhase === "failed" ? "warning" : "success";
      setBanner(`${commandCompletionMessage(command, data)}${suffix}${autoStop}`, bannerTone);
      pushHistory({
        at: new Date().toISOString(),
        command,
        status: data.status,
        tone: "success",
        userEmail: state.user.email,
        message: command === "install-app" || command === "uninstall-app"
          ? `${historyMessage(data)} · Application: ${selectedApplicationLabel()}`.replace(/^ · /, "")
          : historyMessage(data),
        duckdnsDomains: data.duckdnsDomains || [],
      });
    } finally {
      setBusy(false);
    }
  }

  async function dispatchSetSunshinePassword(password) {
    if (!state.user) {
      throw new Error("Sign in with Google first.");
    }

    if (!password || typeof password !== "string") {
      throw new Error("Password is required.");
    }

    if (!state.lastStatus || !state.lastStatus.instanceExists) {
      throw new Error("Create or discover the VM first.");
    }

    setBusy(true);
    setBanner("Updating Sunshine password...", "warning");
    schedulePostCommandStatusRefresh("set-sunshine-password");
    if (state.lastStatus) {
      state.lastStatus = {
        ...state.lastStatus,
        sunshineStatus: {
          state: "starting",
          label: "Applying password",
          detail: "Applying Sunshine password change.",
        },
      };
      renderTargetSummary();
      renderAccess(state.lastStatus);
    }

    try {
      const data = await fetchApi("/api/command", {
        method: "POST",
        body: JSON.stringify({
          command: "set-sunshine-password",
          sunshinePassword: password,
          ...selectedTargetParams(),
        }),
      });
      state.lastStatus = data;
      renderTargetSummary();
      renderAccess(data);
      setBanner("Sunshine password updated and VM is restarting to apply it. Waiting for Sunshine state to become ready.", "warning");
      const readyStatus = await waitForSunshineReady();
      state.lastStatus = readyStatus;
      renderTargetSummary();
      renderAccess(readyStatus);
      setBanner(commandCompletionMessage("set-sunshine-password", readyStatus), "success");
      pushHistory({
        at: new Date().toISOString(),
        command: "set-sunshine-password",
        status: state.lastStatus.status,
        tone: "success",
        userEmail: state.user.email,
        message: "Updated Sunshine Web UI password.",
        duckdnsDomains: data.duckdnsDomains || [],
      });
    } finally {
      setBusy(false);
    }
  }

  function readAutoStopHours(command) {
    if (command !== "start" && command !== "create") {
      return null;
    }

    const raw = String(elements.autoStopHours.value || "").trim();
    if (!raw) {
      return null;
    }

    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 24) {
      throw new Error("Auto-stop must be a whole number of hours from 1 to 24.");
    }
    return value;
  }

  function historyMessage(data) {
    const parts = [];
    if (data.externalIp) {
      parts.push(`External IP: ${data.externalIp}`);
    }
    if (data.autoStopHours) {
      parts.push(`Auto-stop: ${data.autoStopHours}h`);
    }
    if (data.sunshineStatus && data.sunshineStatus.label) {
      parts.push(`Sunshine: ${data.sunshineStatus.label}`);
    }
    if (data.powerAction && data.powerAction.phase && data.powerAction.action) {
      parts.push(`VM action: ${data.powerAction.action} ${data.powerAction.phase}`);
    }
    if (data.minecraftStatus && data.minecraftStatus.label) {
      parts.push(`Minecraft: ${data.minecraftStatus.label}`);
    }
    return parts.join(" · ");
  }

  function renderSunshineStatusMeta(payload) {
    const sunshineStatus = payload.sunshineStatus || {};
    const state = escapeToken(sunshineStatus.state || "starting");
    const label = escapeHtml(sunshineStatus.label || "Starting");
    const detail = sunshineStatus.detail
      ? `<p class="access-meta">Status detail: <span>${escapeHtml(sunshineStatus.detail)}</span></p>`
      : "";
    return `
      <div class="service-status ${state}">
        <span class="service-status-dot" aria-hidden="true"></span>
        <span>Status: ${label}</span>
      </div>
      ${detail}
    `;
  }

  function renderMinecraftStatusMeta(payload) {
    const minecraftStatus = payload.minecraftStatus || {};
    const state = escapeToken(minecraftStatus.state || "not_installed");
    const label = escapeHtml(minecraftStatus.label || "Not installed");
    const detail = minecraftStatus.detail
      ? `<p class="access-meta">Status detail: <span>${escapeHtml(minecraftStatus.detail)}</span></p>`
      : "";
    return `
      <div class="service-status ${state}">
        <span class="service-status-dot" aria-hidden="true"></span>
        <span>Status: ${label}</span>
      </div>
      ${detail}
    `;
  }

  function renderMinecraftOptions(payload) {
    if (!elements.minecraftAddress) {
      return;
    }
    const address = payload && payload.urls && payload.urls.minecraft
      ? String(payload.urls.minecraft)
      : "Connect backend to load address";
    elements.minecraftAddress.value = address;
    if (elements.minecraftOptionsStatus) {
      const label = payload && payload.minecraftStatus && payload.minecraftStatus.label
        ? payload.minecraftStatus.label
        : "Unknown";
      elements.minecraftOptionsStatus.textContent = `Minecraft status: ${label}. Server address: ${address}.`;
    }
  }

  function bindSunshinePasswordForm(canSet) {
    const form = elements.access.querySelector("#sunshine-password-form");
    if (!form) {
      return;
    }

    const input = elements.access.querySelector("#sunshine-password-input");
    const submit = elements.access.querySelector("#sunshine-password-submit");
    if (input) {
      input.disabled = !canSet;
      input.placeholder = canSet ? "New Sunshine password" : "Set to update";
      input.value = "";
    }
    if (submit) {
      submit.disabled = !canSet;
      submit.title = canSet ? "Update Sunshine password" : "Sign in and wait until the VM is reachable";
      submit.textContent = "Update Sunshine password";
    }

    const handler = async (event) => {
      event.preventDefault();
      if (state.isBusy) {
        return;
      }
      const rawPassword = String((input && input.value) || "").trim();
      if (!rawPassword) {
        setBanner("Provide a new Sunshine password.", "warning");
        return;
      }
      if (input) {
        input.value = "";
      }
      try {
        await dispatchSetSunshinePassword(rawPassword);
      } catch (error) {
        handleError(error);
      }
    };

    if (!form.__sunshinePasswordBound) {
      form.addEventListener("submit", handler);
      form.__sunshinePasswordBound = true;
    }
  }

  async function refreshStatus(options) {
    const silent = Boolean(options && options.silent);
    if (!state.user) {
      throw new Error("Sign in with Google first.");
    }

    if (!silent) {
      setBusy(true);
      setBanner("Refreshing VM status...", "warning");
    }

    try {
      const data = await fetchApi(`/api/status${statusQueryString()}`, { method: "GET" });
      renderStatusPayload(data);
      if (!silent) {
        setBanner(statusBannerMessage("VM status loaded", data), "success");
      }
      return data;
    } finally {
      if (!silent) {
        setBusy(false);
      }
    }
  }

  function renderAccess(payload) {
    if (!payload) {
      elements.access.className = "access empty";
      elements.access.textContent = "Refresh VM status to load current access details.";
      return;
    }

    const target = payload.target
      ? `${payload.target.project}/${payload.target.zone}/${payload.target.instance}`
      : "unknown target";

    const persistence = payload.persistence || {};
    const dataDisk = persistence.dataDisk || {};
    const backupReady = persistence.backupReady || {};
    const restore = persistence.restore || {};
    const homeBackup = persistence.homeBackup || {};
    const gamesArchive = persistence.gamesArchive || {};
    const persistenceMeta = `
      <article class="access-card">
        <h3>Persistence</h3>
        <p>Runtime state is split between frequent home backups and a games archive created during delete.</p>
        <p class="access-meta">Data disk: <code>${escapeHtml(dataDisk.label || "unknown")}</code></p>
        <p class="access-meta">Backup ready: <code>${escapeHtml(backupReady.label || "unknown")}</code></p>
        <p class="access-meta">Restore: <code>${escapeHtml(restore.label || "idle")}</code></p>
        <p class="access-meta">Last home backup: <code>${escapeHtml(homeBackup.lastAt || "n/a")}</code></p>
        <p class="access-meta">Last games archive: <code>${escapeHtml(gamesArchive.lastAt || "n/a")}</code></p>
        <p class="access-meta">Manual backups: <code>${escapeHtml(String(getAvailableBackups(payload).length))}</code></p>
      </article>
    `;

    if (payload.instanceExists === false || payload.status === "NOT_FOUND") {
      elements.access.className = "access";
      elements.access.innerHTML = `
        <div class="access-grid">
          <article class="access-card">
            <h3>VM not created</h3>
            <p>No Compute Engine instance exists yet for <code>${escapeHtml(target)}</code>. Use <code>Create</code> to provision a clean VM, then run <code>Restore Backup</code> if needed.</p>
          </article>
          ${persistenceMeta}
        </div>
      `;
      return;
    }

    if (payload.status !== "RUNNING") {
      elements.access.className = "access";
      elements.access.innerHTML = `
        <div class="access-grid">
          <article class="access-card">
            <h3>VM not running</h3>
            <p>The current backend status for <code>${escapeHtml(target)}</code> is <code>${escapeHtml(payload.status || "UNKNOWN")}</code>, so remote access links are not available right now.</p>
          </article>
          ${persistenceMeta}
        </div>
      `;
      return;
    }

    if (!payload.externalIp) {
      elements.access.className = "access";
      elements.access.innerHTML = `
        <article class="access-card error">
          <h3>VM is running, but IP is missing</h3>
          <p>The backend reported a running VM for <code>${escapeHtml(target)}</code>, but no external IP is available yet.</p>
        </article>
        ${persistenceMeta}
      `;
      return;
    }

    const ip = escapeHtml(payload.externalIp);
    const duckdnsEntries = payload.urls && payload.urls.duckdns ? payload.urls.duckdns : [];
    const primaryDuckDns = duckdnsEntries.length
      ? duckdnsEntries[0]
      : null;
    const displayHost = primaryDuckDns && primaryDuckDns.domain
      ? escapeHtml(primaryDuckDns.domain)
      : ip;
    const displayHostLabel = primaryDuckDns && primaryDuckDns.domain
      ? "DNS Host"
      : "Host/IP";
    const novncUrl = String(payload.urls && payload.urls.novnc ? payload.urls.novnc : "");
    const sunshineUrl = String(payload.urls && payload.urls.sunshine ? payload.urls.sunshine : "");
    const minecraftAddress = String(payload.urls && payload.urls.minecraft ? payload.urls.minecraft : "");
    const sunshineOpenUrl = primaryDuckDns && primaryDuckDns.sunshine ? primaryDuckDns.sunshine : sunshineUrl;
    const novncOpenUrl = primaryDuckDns && primaryDuckDns.novnc ? primaryDuckDns.novnc : novncUrl;
    const sunshineUrlLabel = primaryDuckDns && primaryDuckDns.sunshine === sunshineUrl
      ? "DNS URL"
      : "URL";
    const novncUrlLabel = primaryDuckDns && primaryDuckDns.novnc === novncUrl
      ? "DNS URL"
      : "URL";
    const sunshineUrlEscaped = escapeHtml(sunshineUrl);
    const sunshineOpenUrlEscaped = escapeHtml(sunshineOpenUrl);
    const novncUrlEscaped = escapeHtml(novncUrl);
    const novncOpenUrlEscaped = escapeHtml(novncOpenUrl);
    const minecraftAddressEscaped = escapeHtml(minecraftAddress);
    const sunshineCredentials = payload.sunshineCredentials || {};
    const novncDnsMeta = primaryDuckDns && primaryDuckDns.novnc && primaryDuckDns.novnc !== novncUrl
      ? `<p class="access-meta">DNS URL: <code>${escapeHtml(primaryDuckDns.novnc)}</code></p>`
      : "";
    const sunshineDnsMeta = primaryDuckDns && primaryDuckDns.sunshine && primaryDuckDns.sunshine !== sunshineUrl
      ? `<p class="access-meta">DNS URL: <code>${escapeHtml(primaryDuckDns.sunshine)}</code></p>`
      : "";
    const sunshineUserMeta = sunshineCredentials.username
      ? `<p class="access-meta">Username: <code>${escapeHtml(sunshineCredentials.username)}</code></p>`
      : "";
    const canSetSunshinePasswordForAccess = canSetSunshinePassword(payload);
    const sunshineStatusMeta = renderSunshineStatusMeta(payload);
    const minecraftStatusMeta = renderMinecraftStatusMeta(payload);

    elements.access.className = "access";
    elements.access.innerHTML = `
        <div class="access-grid">
        <article class="access-card">
          <h3>Moonlight / Sunshine Client</h3>
          <p>Add this host in Moonlight or another Sunshine-compatible client, then pair with the PIN shown by Sunshine.</p>
          <p class="access-meta">${displayHostLabel}: <code>${displayHost}</code></p>
        </article>

        <article class="access-card accent">
          <h3>Sunshine Web UI</h3>
          <p>Use this to manage Sunshine, pair clients, and inspect streaming settings. Expect a browser certificate warning on first open.</p>
          <div class="access-links">
            <a href="${sunshineOpenUrlEscaped}" target="_blank" rel="noreferrer">Open Sunshine UI</a>
          </div>
          <p class="access-meta">${sunshineUrlLabel}: <code>${sunshineUrlEscaped}</code></p>
          ${sunshineDnsMeta}
          ${sunshineStatusMeta}
          ${sunshineUserMeta}
          <p class="access-meta">Password: <code>hidden for safety</code></p>
          <form id="sunshine-password-form" class="access-inline-form">
            <label for="sunshine-password-input">
              <span>Set a custom Sunshine password</span>
              <div class="access-inline-form-row">
                <input
                  id="sunshine-password-input"
                  name="sunshine-password"
                  type="password"
                  minlength="8"
                  maxlength="128"
                  autocomplete="off"
                  inputmode="text"
                  spellcheck="false"
                  placeholder="Minimum 8 characters"
                  ${canSetSunshinePasswordForAccess ? "" : "disabled"}
                >
            <button id="sunshine-password-submit" type="submit" class="action status" ${canSetSunshinePasswordForAccess ? "" : "disabled"}>
              Update Sunshine password
            </button>
              </div>
            </label>
          </form>
        </article>

        <article class="access-card accent">
          <h3>Browser Desktop</h3>
          <p>Best for first login, Steam setup, and recovery when streaming clients are not paired yet.</p>
          <div class="access-links">
              <a href="${novncOpenUrlEscaped}" target="_blank" rel="noreferrer">Open noVNC</a>
          </div>
          <p class="access-meta">${novncUrlLabel}: <code>${novncUrlEscaped}</code></p>
          ${novncDnsMeta}
        </article>

        <article class="access-card accent">
          <h3>Minecraft Server</h3>
          <p>Use this address in Minecraft Multiplayer. Server management actions are available in the Minecraft Server row above.</p>
          <p class="access-meta">Address: <code>${minecraftAddressEscaped}</code></p>
          ${minecraftStatusMeta}
          <div class="access-links">
            <a href="#minecraft-address">Open management controls</a>
          </div>
        </article>

        ${persistenceMeta}
      </div>

      <p class="access-note">
        The VM can report <code>RUNNING</code> before the desktop and Sunshine finish booting. On a cold start, give noVNC and Sunshine up to a minute or two to become reachable. Restart, Stop, and Delete stay disabled until the VM reports <code>Backup ready</code>.
      </p>
    `;
    bindSunshinePasswordForm(canSetSunshinePasswordForAccess);
  }

  function escapeToken(value) {
    return String(value || "unknown")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function wait(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function handleError(error) {
    setBanner(error.message || "Unexpected error.", "error");
  }

  elements.form.addEventListener("input", saveConfig);
  elements.connect.addEventListener("click", async () => {
    if (state.isBusy) {
      return;
    }
    try {
      setBusy(true);
      await connectBackend();
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  elements.googleSignIn.addEventListener("click", async () => {
    if (state.isBusy) {
      return;
    }
    try {
      setBusy(true);
      if (!state.googleTokenClient) {
        if (!state.backendConfig || !state.backendConfig.googleClientId) {
          throw new Error("Connect the backend before signing in.");
        }
        await initializeGoogle(state.backendConfig.googleClientId);
      }
      state.googleTokenClient.requestAccessToken();
    } catch (error) {
      handleError(error);
      setBusy(false);
    }
  });

  elements.signOut.addEventListener("click", () => {
    clearSession({ revokeGoogleSession: true });
    setBanner("Google session cleared from this browser session.", "success");
  });

  if (elements.refreshStatus) {
    elements.refreshStatus.addEventListener("click", async () => {
      try {
        const data = await refreshStatus({ silent: true });
        setBanner(statusBannerMessage("VM status loaded", data), state.isBusy ? "warning" : "success");
      } catch (error) {
        handleError(error);
      }
    });
  }

  elements.actionButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const command = button.dataset.command;
      if (command === "status") {
        try {
          const data = await refreshStatus({ silent: true });
          setBanner(statusBannerMessage("VM status loaded", data), state.isBusy ? "warning" : "success");
        } catch (error) {
          handleError(error);
        }
        return;
      }
      if (state.isBusy) {
        return;
      }
      try {
        await dispatchCommand(command);
      } catch (error) {
        handleError(error);
      }
    });
  });

  if (elements.backupSelect) {
    elements.backupSelect.addEventListener("change", updateActionAvailability);
  }

  if (elements.applicationSelect) {
    elements.applicationSelect.addEventListener("change", updateActionAvailability);
  }

  if (elements.hardwareSelect) {
    elements.hardwareSelect.addEventListener("change", async () => {
      try {
        if (state.user) {
          await refreshHardwareOptions({ silent: false });
        } else {
          renderZoneOptions();
        }
        await refreshStatus({ silent: true });
      } catch (error) {
        handleError(error);
      }
    });
  }

  if (elements.zoneSelect) {
    elements.zoneSelect.addEventListener("change", async () => {
      saveConfig();
      renderTargetSummary();
      updateActionAvailability();
      try {
        if (state.user) {
          await refreshStatus({ silent: true });
        }
      } catch (error) {
        handleError(error);
      }
    });
  }

  if (elements.refreshHardware) {
    elements.refreshHardware.addEventListener("click", async () => {
      try {
        setBusy(true);
        await refreshHardwareOptions({ silent: false });
        await refreshStatus({ silent: true });
        setBanner("Hardware availability refreshed.", "success");
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
      }
    });
  }

  loadConfig();
  setBusy(false);

  if (state.backendUrl) {
    setBusy(true);
    connectBackend({ silent: true })
      .catch(handleError)
      .finally(() => {
        setBusy(false);
      });
  }
})();
