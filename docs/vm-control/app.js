(function () {
  const defaultBackendUrl = "https://steam-vm-control-api-w2urpq2xlq-lm.a.run.app";
  const defaultAutoStopHours = "3";

  const storageKeys = {
    config: "vm-control-cloudrun-config",
    sessionToken: "vm-control-google-session-token",
    sessionTokenExpiresAt: "vm-control-google-session-token-expires-at",
    history: "vm-control-session-history",
  };
  const minecraftManagementSessionRequest = "vm-control-minecraft-session-request";
  const minecraftManagementSessionResponse = "vm-control-minecraft-session-response";
  const adminSessionRequest = "vm-control-admin-session-request";
  const adminSessionResponse = "vm-control-admin-session-response";

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    const responseType = event.data?.type === minecraftManagementSessionRequest
      ? minecraftManagementSessionResponse
      : event.data?.type === adminSessionRequest
        ? adminSessionResponse
        : "";
    if (!responseType) return;
    const token = window.sessionStorage.getItem(storageKeys.sessionToken) || "";
    if (!token || !event.source) return;
    event.source.postMessage({
      type: responseType,
      token,
    }, event.origin);
  });
  const SUNSHINE_POLL_INTERVAL_MS = 3000;
  const SUNSHINE_POLL_TIMEOUT_MS = 1200000;
  const POST_COMMAND_STATUS_REFRESH_DELAY_MS = 2000;
  const COMMAND_STATUS_POLL_TIMEOUT_MS = 1200000;
  const COMMAND_STATUS_POLL_TIMEOUTS_MS = {
    create: 1200000,
    start: 1200000,
    restart: 1200000,
    stop: 1800000,
    delete: 900000,
    "create-backup": 3600000,
    "restore-backup": 3600000,
    "remove-backup": 900000,
    "install-app": 1800000,
    "uninstall-app": 1800000,
    "install-minecraft": 1800000,
    "start-minecraft": 900000,
    "stop-minecraft": 900000,
    "restart-minecraft": 900000,
    "remove-minecraft": 900000,
    "set-auto-stop": 120000,
  };
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
    "stop",
    "delete",
    "set-auto-stop",
    "create-backup",
    "restore-backup",
    "remove-backup",
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
    pageLoader: document.querySelector("#page-loader"),
    pageLoaderMessage: document.querySelector("#page-loader-message"),
    appShell: document.querySelector("#app-shell"),
    authStatus: document.querySelector("#auth-status"),
    googleSignIn: document.querySelector("#google-sign-in"),
    signOut: document.querySelector("#sign-out"),
    targetSummary: document.querySelector("#target-summary"),
    refreshStatus: document.querySelector("#refresh-status"),
    hardwareSelect: document.querySelector("#hardware-select"),
    zoneSelect: document.querySelector("#zone-select"),
    refreshHardware: document.querySelector("#refresh-hardware"),
    cancelGpuScan: document.querySelector("#cancel-gpu-scan"),
    hardwareOptionsStatus: document.querySelector("#hardware-options-status"),
    hardwarePriceEstimate: document.querySelector("#hardware-price-estimate"),
    refreshInstances: document.querySelector("#refresh-instances"),
    instancesList: document.querySelector("#instances-list"),
    instancesStatus: document.querySelector("#instances-status"),
    autoStopHours: document.querySelector("#auto-stop-hours"),
    autoStopStatus: document.querySelector("#auto-stop-status"),
    backupSelect: document.querySelector("#backup-select"),
    backupOptionsStatus: document.querySelector("#backup-options-status"),
    applicationSelect: document.querySelector("#application-select"),
    applicationOptionsStatus: document.querySelector("#application-options-status"),
    minecraftAddress: document.querySelector("#minecraft-address"),
    minecraftVersionSelect: document.querySelector("#minecraft-version-select"),
    refreshMinecraftVersions: document.querySelector("#refresh-minecraft-versions"),
    minecraftOptionsStatus: document.querySelector("#minecraft-options-status"),
    checkGpuCapacity: document.querySelector("#check-gpu-capacity"),
    releaseGpuCapacity: document.querySelector("#release-gpu-capacity"),
    gpuProbeCount: document.querySelector("#gpu-probe-count"),
    banner: document.querySelector("#banner"),
    commandStatus: document.querySelector("#command-status"),
    access: document.querySelector("#access"),
    history: document.querySelector("#history"),
    form: document.querySelector("#settings-form"),
    actionButtons: Array.from(document.querySelectorAll("[data-command]")),
  };

  const state = {
    backendUrl: "",
    backendConfig: null,
    gpuAvailabilityScan: null,
    gpuAvailabilityScanRun: null,
    googleInitializedFor: "",
    googleTokenClient: null,
    googleTokenRefreshHandlers: null,
    googleTokenRefreshPromise: null,
    token: "",
    tokenExpiresAt: 0,
    user: null,
    lastStatus: null,
    lastStatusTargetKey: "",
    hardwarePayload: null,
    instancesPayload: null,
    priceEstimates: {},
    isBusy: false,
    commandStatusRefreshTimer: null,
    history: [],
    isPageLoading: true,
    pageLoadingToken: 0,
    scrolledInitialHash: "",
  };

  function setPageLoading(message) {
    state.pageLoadingToken += 1;
    state.isPageLoading = true;
    document.body.classList.add("is-page-loading");
    if (!elements.pageLoader) {
      return;
    }
    elements.pageLoader.hidden = false;
    elements.pageLoader.setAttribute("aria-busy", "true");
    if (elements.appShell) {
      elements.appShell.setAttribute("aria-busy", "true");
    }
    if (elements.pageLoaderMessage && message) {
      elements.pageLoaderMessage.textContent = message;
    }
    return state.pageLoadingToken;
  }

  function markPageReady(message, token) {
    if (token && token !== state.pageLoadingToken) {
      return;
    }
    state.isPageLoading = false;
    if (elements.pageLoaderMessage && message) {
      elements.pageLoaderMessage.textContent = message;
    }
    if (elements.appShell) {
      elements.appShell.setAttribute("aria-busy", "false");
    }
    if (!elements.pageLoader) {
      document.body.classList.remove("is-page-loading");
      return;
    }
    elements.pageLoader.setAttribute("aria-busy", "false");
    document.body.classList.remove("is-page-loading");
    window.setTimeout(() => {
      if (!state.isPageLoading) {
        elements.pageLoader.hidden = true;
      }
    }, 220);
  }

  function loadConfig() {
    const saved = JSON.parse(window.localStorage.getItem(storageKeys.config) || "{}");
    state.backendUrl = saved.backendUrl || defaultBackendUrl;
    state.token = window.sessionStorage.getItem(storageKeys.sessionToken) || "";
    state.tokenExpiresAt = Math.max(
      0,
      Number.parseInt(window.sessionStorage.getItem(storageKeys.sessionTokenExpiresAt) || "0", 10) || 0,
    );
    state.history = JSON.parse(window.localStorage.getItem(storageKeys.history) || "[]");
    elements.backendUrl.value = state.backendUrl;
    elements.autoStopHours.value = Object.prototype.hasOwnProperty.call(saved, "autoStopHours")
      ? String(saved.autoStopHours || "")
      : defaultAutoStopHours;
    if (elements.hardwareSelect && saved.hardwareId) {
      elements.hardwareSelect.dataset.savedValue = String(saved.hardwareId);
    }
    if (elements.minecraftVersionSelect && saved.minecraftVersion) {
      elements.minecraftVersionSelect.dataset.savedValue = String(saved.minecraftVersion);
    }
    renderHistory();
    renderTargetSummary();
    renderBackupOptions(null);
    renderApplicationOptions(null);
    renderMinecraftOptions(null);
    renderHardwareOptions(null);
    renderInstanceOptions(null);
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
        minecraftVersion: String(elements.minecraftVersionSelect && elements.minecraftVersionSelect.value || "").trim(),
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
    if (elements.refreshInstances) {
      elements.refreshInstances.disabled = nextBusy || !state.user;
    }
    if (elements.refreshMinecraftVersions) {
      elements.refreshMinecraftVersions.disabled = nextBusy || !state.user || !state.backendConfig;
    }
    updateActionAvailability();
    updateGpuAvailabilityScanButton();

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

  function isMinecraftCommand(command) {
    return Object.prototype.hasOwnProperty.call(COMMAND_MINECRAFT_TRANSITIONS, command);
  }

  function minecraftCommandAvailable(command) {
    if (!isMinecraftCommand(command)) {
      return true;
    }
    const minecraftState = String(state.lastStatus && state.lastStatus.minecraftStatus && state.lastStatus.minecraftStatus.state || "")
      .trim()
      .toLowerCase();
    if (command === "install-minecraft") {
      return ["not_installed", "removed", "error"].includes(minecraftState);
    }
    if (command === "start-minecraft") {
      return minecraftState === "stopped";
    }
    if (command === "stop-minecraft" || command === "restart-minecraft") {
      return minecraftState === "running";
    }
    if (command === "remove-minecraft") {
      return ["running", "stopped", "error"].includes(minecraftState);
    }
    return false;
  }

  function updateActionAvailability() {
    const canUseLastStatus = state.lastStatus
      && state.lastStatusTargetKey
      && state.lastStatusTargetKey === selectedTargetKey();
    const allowed = new Set(state.user && canUseLastStatus
      ? allowedCommandsForCurrentSelection(state.lastStatus)
      : state.user
        ? ["status"]
        : []);

    if (elements.refreshStatus) {
      elements.refreshStatus.disabled = !state.user;
    }
    if (elements.refreshInstances) {
      elements.refreshInstances.disabled = state.isBusy || !state.user;
    }
    if (elements.instancesList) {
      elements.instancesList.querySelectorAll("[data-instance-index]").forEach((button) => {
        button.disabled = state.isBusy || !state.user;
      });
    }
    if (elements.hardwareSelect) {
      elements.hardwareSelect.disabled = state.isBusy || !state.user || !state.hardwarePayload;
    }
    if (elements.zoneSelect) {
      elements.zoneSelect.disabled = state.isBusy || !state.user || !selectedHardwareProfile();
    }
    const canEditAutoStop = allowed.has("start") || allowed.has("create") || allowed.has("set-auto-stop");
    elements.autoStopHours.disabled = state.isBusy || !state.user || !canEditAutoStop;
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
    if (elements.minecraftVersionSelect) {
      elements.minecraftVersionSelect.disabled = state.isBusy
        || !state.user
        || !allowed.has("install-minecraft")
        || !minecraftCommandAvailable("install-minecraft")
        || getMinecraftVersionCatalog(state.lastStatus).length === 0;
    }
    if (elements.refreshMinecraftVersions) {
      elements.refreshMinecraftVersions.disabled = state.isBusy || !state.user || !state.backendConfig;
    }
    const target = selectedTargetParams();
    const canCheckGpuCapacity = Boolean(
      target.hardwareId
      && target.zone
      && target.gpuType
      && Number(target.gpuCount || 0) > 0
    );
    if (elements.checkGpuCapacity) {
      elements.checkGpuCapacity.disabled = state.isBusy || !state.user || !canCheckGpuCapacity;
    }
    if (elements.releaseGpuCapacity) {
      elements.releaseGpuCapacity.disabled = state.isBusy || !state.user;
    }
    elements.actionButtons.forEach((button) => {
      const command = button.dataset.command;
      const needsBackup = command === "restore-backup" || command === "remove-backup";
      const needsApplication = command === "install-app" || command === "uninstall-app";
      const needsMinecraftState = isMinecraftCommand(command);
      const hasSelectedBackup = Boolean(elements.backupSelect && elements.backupSelect.value);
      const hasSelectedApplication = Boolean(elements.applicationSelect && elements.applicationSelect.value);
      button.disabled = !state.user
        || (command !== "status" && (
          state.isBusy
          || !allowed.has(command)
          || (needsBackup && !hasSelectedBackup)
          || (needsApplication && !hasSelectedApplication)
          || (needsMinecraftState && !minecraftCommandAvailable(command))
        ));
    });
  }

  function isCommandAllowed(command) {
    return Boolean(
      state.user &&
        state.lastStatus &&
        state.lastStatusTargetKey === selectedTargetKey() &&
        allowedCommandsForCurrentSelection(state.lastStatus).includes(command),
    );
  }

  function selectedHardwareMatchesPayload(payload) {
    if (!payload || payload.instanceExists === false || payload.status === "NOT_FOUND") {
      return true;
    }
    if (payload.hardwareMatchesSelection === false) {
      return false;
    }
    const actual = payload.actualHardware || null;
    if (!actual) {
      return true;
    }
    const selected = selectedTargetParams();
    if (!Object.keys(selected).length) {
      return true;
    }
    const selectedGpuCount = Number(selected.gpuCount || 0);
    const actualGpuCount = Number(actual.gpuCount || 0);
    return String(actual.machineType || "") === String(selected.machineType || "")
      && String(actual.gpuType || "") === String(selected.gpuType || "")
      && actualGpuCount === selectedGpuCount
      && String(actual.acceleratorMode || "") === String(selected.acceleratorMode || "");
  }

  function hardwareLabelFromSelection(selection) {
    if (!selection) {
      return "unknown hardware";
    }
    if (selection.label) {
      return String(selection.label);
    }
    if (selection.id === "cpu" || Number(selection.gpuCount || 0) <= 0) {
      return "CPU";
    }
    if (selection.gpuType === "nvidia-tesla-t4") {
      return "GPU T4";
    }
    if (selection.gpuType === "nvidia-l4") {
      return "GPU L4";
    }
    return String(selection.gpuType || selection.id || "unknown hardware");
  }

  function actualHardwareLabel(payload) {
    return hardwareLabelFromSelection(payload && payload.actualHardware);
  }

  function selectedHardwareMismatchMessage(payload) {
    if (selectedHardwareMatchesPayload(payload)) {
      return "";
    }
    const selected = selectedHardwareLabel() || hardwareLabelFromSelection(selectedTargetParams());
    const status = String(payload && payload.status || "UNKNOWN").toUpperCase();
    if (status === "RUNNING") {
      return `Existing VM uses ${actualHardwareLabel(payload)}, but the selected profile is ${selected}. Stop or delete the running VM before creating the selected profile, or select the existing VM profile to manage running services.`;
    }
    if (status === "TERMINATED") {
      return `Existing VM uses ${actualHardwareLabel(payload)}, but the selected profile is ${selected}. Use Create to reconfigure and start the stopped VM with the selected profile, or select the existing VM profile to start it unchanged.`;
    }
    return `Existing VM uses ${actualHardwareLabel(payload)}, but the selected profile is ${selected}. Select the existing VM profile to manage running services.`;
  }

  function allowedMismatchCommands(payload, fallbackCommands) {
    const allowed = new Set(Array.isArray(payload && payload.allowedCommands) ? payload.allowedCommands : fallbackCommands);
    const keep = (commands) => commands.filter((command) => allowed.has(command));
    const status = String(payload && payload.status || "UNKNOWN").toUpperCase();
    if (status === "TERMINATED") {
      return keep(["status", "create", "delete", "set-sunshine-password"]);
    }
    if (status === "RUNNING") {
      return keep(["status", "stop", "delete"]);
    }
    return keep(["status", "delete"]);
  }

  function allowedCommandsForCurrentSelection(payload) {
    if (!payload || !Array.isArray(payload.allowedCommands)) {
      return ["status"];
    }
    if (selectedHardwareMatchesPayload(payload)) {
      return payload.allowedCommands;
    }
    return allowedMismatchCommands(payload, ["status"]);
  }

  function setBanner(message, tone) {
    const isDuplicateCommandStatus = Boolean(
      elements.commandStatus
      && String(elements.commandStatus.textContent || "").trim() === String(message || "").trim(),
    );
    elements.banner.hidden = isDuplicateCommandStatus;
    if (isDuplicateCommandStatus) {
      return;
    }
    elements.banner.textContent = message;
    elements.banner.dataset.tone = tone || "neutral";
  }

  function setCommandStatus(message, tone) {
    if (!elements.commandStatus) {
      return;
    }
    elements.commandStatus.textContent = message;
    elements.commandStatus.dataset.tone = tone || "neutral";
  }

    function clearScheduledCommandStatusRefresh() {
      state.commandStatusRefreshGeneration = Number(state.commandStatusRefreshGeneration || 0) + 1;
      if (!state.commandStatusRefreshTimer) {
        return;
      }
      window.clearTimeout(state.commandStatusRefreshTimer);
      state.commandStatusRefreshTimer = null;
  }

  function extractErrorToken(rawMessage, key) {
    const raw = String(rawMessage || "");
    const singleQuoted = new RegExp(`['"]${key}['"]\\s*:\\s*'([^']+)'`).exec(raw);
    if (singleQuoted && singleQuoted[1]) {
      return singleQuoted[1];
    }
    const doubleQuoted = new RegExp(`['"]${key}['"]\\s*:\\s*"([^"]+)"`).exec(raw);
    if (doubleQuoted && doubleQuoted[1]) {
      return doubleQuoted[1];
    }
    return "";
  }

  function formatErrorMessage(error) {
    const raw = String(error && error.message ? error.message : error || "Unexpected error.");
    const code = extractErrorToken(raw, "code");
    const message = extractErrorToken(raw, "message");
    if (code === "ZONE_RESOURCE_POOL_EXHAUSTED") {
      return `Google Compute Engine capacity error (${code}): ${message || raw}`;
    }
    if (code) {
      return `Google Compute Engine error (${code}): ${message || raw}`;
    }
    return raw;
  }

  function commandFailureMessage(command, error) {
    return `Command "${command}" failed. ${formatErrorMessage(error)}`;
  }

  function statusBannerMessage(prefix, data) {
    if (data && data.instanceExists === false) {
      const target = data.target || {};
      const hardware = data.hardware || {};
      const zone = hardware.zone || target.zone || "unknown";
      const instance = target.instance || "unknown";
      return `${prefix}. VM not created for ${zone}/${instance}.`;
    }
    if (data && !selectedHardwareMatchesPayload(data)) {
      return `${prefix}. Current VM state: ${data.status || "UNKNOWN"}. ${selectedHardwareMismatchMessage(data)}`;
    }
    const parts = [`${prefix}. Current VM state: ${data.status || "UNKNOWN"}`];
    if (data.sunshineStatus && data.sunshineStatus.label) {
      parts.push(`Sunshine: ${data.sunshineStatus.label}`);
    }
    if (data.powerAction && data.powerAction.action && data.powerAction.phase) {
      parts.push(`VM action: ${data.powerAction.action} ${data.powerAction.phase}`);
    }
    return `${parts.join(", ")}.`;
  }

  function statusMessageTone(data) {
    return isTransitionalStatus(data) ? "warning" : "success";
  }

    function schedulePostCommandStatusRefresh(command, refreshGeneration) {
      if (command === "status" || !state.user) {
        return;
      }

      const generation = Number.isInteger(refreshGeneration)
        ? refreshGeneration
        : Number(state.commandStatusRefreshGeneration || 0) + 1;
      state.commandStatusRefreshGeneration = generation;
      if (state.commandStatusRefreshTimer) {
        window.clearTimeout(state.commandStatusRefreshTimer);
      }

      state.commandStatusRefreshTimer = window.setTimeout(async () => {
        state.commandStatusRefreshTimer = null;
        if (!state.user || generation !== state.commandStatusRefreshGeneration) {
          return;
        }

        try {
          const data = await refreshStatus({ silent: true, forceRender: true });
          if (generation !== state.commandStatusRefreshGeneration) {
            return;
          }
          setCommandStatus(statusBannerMessage("VM status refreshed", data), statusMessageTone(data));
          if (state.isPageLoading && state.user && generation === state.commandStatusRefreshGeneration) {
            schedulePostCommandStatusRefresh(command, generation);
          }
        } catch (error) {
          if (generation !== state.commandStatusRefreshGeneration) {
            return;
          }
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

  function firstEuropeZone(zones) {
    return zones.find((zone) => String(zone || "").startsWith("europe-")) || "";
  }

  const ZONE_CITY_BY_REGION = Object.freeze({
    "africa-south1": "Johannesburg",
    "asia-east1": "Changhua County",
    "asia-east2": "Hong Kong",
    "asia-northeast1": "Tokyo",
    "asia-northeast2": "Osaka",
    "asia-northeast3": "Seoul",
    "asia-south1": "Mumbai",
    "asia-south2": "Delhi",
    "asia-southeast1": "Singapore",
    "asia-southeast2": "Jakarta",
    "australia-southeast1": "Sydney",
    "australia-southeast2": "Melbourne",
    "europe-central2": "Warsaw",
    "europe-north1": "Hamina",
    "europe-north2": "Stockholm",
    "europe-southwest1": "Madrid",
    "europe-west1": "Ghislain",
    "europe-west2": "London",
    "europe-west3": "Frankfurt",
    "europe-west4": "Eemshaven",
    "europe-west6": "Zurich",
    "europe-west8": "Milan",
    "europe-west9": "Paris",
    "europe-west10": "Berlin",
    "europe-west12": "Turin",
    "me-central1": "Doha",
    "me-central2": "Dammam",
    "me-west1": "Tel Aviv",
    "northamerica-northeast1": "Montreal",
    "northamerica-northeast2": "Toronto",
    "northamerica-south1": "Queretaro",
    "southamerica-east1": "Sao Paulo",
    "southamerica-west1": "Santiago",
    "us-central1": "Council Bluffs",
    "us-east1": "Moncks Corner",
    "us-east4": "Ashburn",
    "us-east5": "Columbus",
    "us-south1": "Dallas",
    "us-west1": "The Dalles",
    "us-west2": "Los Angeles",
    "us-west3": "Salt Lake City",
    "us-west4": "Las Vegas",
  });

  function zoneDisplayLabel(zone) {
    const value = String(zone || "").trim();
    const region = value.replace(/-[a-z]$/, "");
    const city = ZONE_CITY_BY_REGION[region];
    return city ? `${city} · ${value}` : value;
  }

  function selectedHardwareLabel() {
    const profile = selectedHardwareProfile();
    return profile ? String(profile.label || profile.id) : "";
  }

  function activeGpuAvailabilityScan(profile) {
    const scan = state.gpuAvailabilityScan;
    return scan && profile && String(scan.hardwareId) === String(profile.id) ? scan : null;
  }

  function resetGpuAvailabilityScan() {
    state.gpuAvailabilityScan = null;
  }

  function updateGpuAvailabilityScanButton() {
    const run = state.gpuAvailabilityScanRun;
    const running = Boolean(run && !run.finished);
    const profile = selectedHardwareProfile();
    const isGpu = profile && Number(profile.gpuCount || 0) > 0 && String(profile.gpuType || "").trim();
    const isFiltered = Boolean(activeGpuAvailabilityScan(profile));
    if (elements.refreshHardware) {
      elements.refreshHardware.textContent = running
        ? "Scanning GPU Availability..."
        : isFiltered ? "Show All GPU Zones" : "Scan GPU Availability";
      elements.refreshHardware.title = isFiltered
        ? "Restore all zones compatible with the selected GPU"
        : "Temporarily test GPU capacity in every compatible zone";
      elements.refreshHardware.disabled = state.isBusy || !state.user || !isGpu || running;
    }
    if (elements.cancelGpuScan) {
      elements.cancelGpuScan.classList.toggle("hidden", !running);
      elements.cancelGpuScan.disabled = !running || Boolean(run && run.cancelRequested);
    }
  }

  function renderGpuAvailabilityScanProgress(run) {
    if (!run) {
      return;
    }
    const completed = Number(run.completed || 0);
    const total = Number(run.zones && run.zones.length || 0);
    const available = Number(run.availableZones && run.availableZones.length || 0);
    const current = run.currentZone ? ` Current zone: ${zoneDisplayLabel(run.currentZone)}.` : "";
    const message = run.cancelRequested
      ? `Cancelling GPU capacity scan after the current request. Checked ${completed}/${total} zones.${current}`
      : `Scanning GPU capacity: ${completed}/${total} zones checked, ${available} currently available.${current}`;
    if (elements.hardwareOptionsStatus) {
      elements.hardwareOptionsStatus.textContent = message;
    }
    if (elements.pageLoaderMessage && state.isPageLoading) {
      elements.pageLoaderMessage.textContent = message;
    }
  }

  function cancelGpuAvailabilityScan() {
    const run = state.gpuAvailabilityScanRun;
    if (!run || run.finished || run.cancelRequested) {
      return;
    }
    run.cancelRequested = true;
    run.abortController.abort();
    renderGpuAvailabilityScanProgress(run);
    updateGpuAvailabilityScanButton();
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

  function selectedTargetKey() {
    const params = selectedTargetParams();
    return Object.keys(params).length ? JSON.stringify(params) : "";
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
      renderHardwarePriceEstimate(null);
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
      const vramGb = Number(profile.vramGb || 0);
      const vram = gpuCount > 0 && vramGb > 0 ? `, ${vramGb} GB VRAM` : "";
      const suffix = gpuCount > 0
        ? `${profile.gpuType || profile.id}${vram}, ${profile.machineType || "machine"}`
        : `${profile.machineType || "machine"}`;
      const estimate = profile.priceEstimate || null;
      const price = gpuCount > 0
        ? ` - ${estimate && estimate.display ? estimate.display : "Price unavailable"}`
        : "";
      return `<option value="${escapeHtml(id)}">${escapeHtml(profile.label || id)}${escapeHtml(price)} (${escapeHtml(suffix)}, ${zoneCount} zones)</option>`;
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
    const compatibleZones = profile && Array.isArray(profile.zones) ? profile.zones : [];
    const scan = activeGpuAvailabilityScan(profile);
    const zones = scan ? scan.availableZones : compatibleZones;
    if (!zones.length) {
      elements.zoneSelect.innerHTML = '<option value="">No zones available</option>';
      if (elements.hardwareOptionsStatus) {
        elements.hardwareOptionsStatus.textContent = scan
          ? `Capacity scan found no currently available zones for ${selectedHardwareLabel() || "selected GPU"}. Click Show All GPU Zones to restore compatible zones.`
          : `No zones currently expose ${selectedHardwareLabel() || "selected hardware"}. Refresh later or choose CPU.`;
      }
      renderHardwarePriceEstimate(null);
      saveConfig();
      updateGpuAvailabilityScanButton();
      updateActionAvailability();
      return;
    }
    const requestedZone = elements.zoneSelect.dataset.savedValue || "";
    const previousZone = requestedZone
      || elements.zoneSelect.value
      || String((state.hardwarePayload && state.hardwarePayload.defaultSelection || {}).zone || "");
    elements.zoneSelect.innerHTML = zones.map((zone) => (
      `<option value="${escapeHtml(zone)}">${escapeHtml(zoneDisplayLabel(zone))}</option>`
    )).join("");
    if (zones.includes(previousZone)) {
      elements.zoneSelect.value = previousZone;
    } else {
      elements.zoneSelect.value = firstEuropeZone(zones) || zones[0];
    }
    elements.zoneSelect.dataset.savedValue = "";
    resetGpuCapacityProbeButton();
    if (elements.hardwareOptionsStatus) {
      const refreshedAt = state.hardwarePayload && state.hardwarePayload.refreshedAt
        ? ` Refreshed: ${state.hardwarePayload.refreshedAt}.`
        : "";
      elements.hardwareOptionsStatus.textContent = scan
        ? `Capacity scan found GPU capacity in ${zones.length}/${compatibleZones.length} compatible zone${compatibleZones.length === 1 ? "" : "s"}. Temporary test reservations were released immediately.`
        : `${selectedHardwareLabel()} available in ${zones.length} zone${zones.length === 1 ? "" : "s"}.${refreshedAt}`;
    }
    renderHardwarePriceEstimate(selectedPriceEstimate());
    saveConfig();
    updateGpuAvailabilityScanButton();
    updateActionAvailability();
  }

  function selectedPriceEstimate() {
    const profile = selectedHardwareProfile();
    const zone = selectedZone();
    const key = selectedTargetKey();
    if (key && state.priceEstimates[key]) {
      return state.priceEstimates[key];
    }
    const statusPrice = state.lastStatus && state.lastStatus.hardware && state.lastStatus.hardware.priceEstimate
      ? state.lastStatus.hardware.priceEstimate
      : null;
    if (statusPrice && statusPrice.zone === zone) {
      return statusPrice;
    }
    return null;
  }

  async function refreshPriceEstimate(options) {
    const silent = Boolean(options && options.silent);
    const key = selectedTargetKey();
    if (!state.user || !key) {
      renderHardwarePriceEstimate(null);
      return null;
    }
    if (!silent && elements.hardwarePriceEstimate) {
      elements.hardwarePriceEstimate.dataset.tone = "neutral";
      elements.hardwarePriceEstimate.textContent = "Loading estimated hourly price...";
    }
    const data = await fetchApi(`/api/price${statusQueryString()}`, { method: "GET" });
    const estimate = data && data.priceEstimate ? data.priceEstimate : null;
    if (estimate) {
      state.priceEstimates[key] = estimate;
    }
    renderHardwarePriceEstimate(estimate);
    renderTargetSummary();
    return estimate;
  }

  function renderHardwarePriceEstimate(estimate) {
    if (!elements.hardwarePriceEstimate) {
      return;
    }
    if (!estimate) {
      elements.hardwarePriceEstimate.dataset.tone = "neutral";
      elements.hardwarePriceEstimate.textContent = "Estimated price: unavailable until hardware data is loaded.";
      return;
    }
    if (!estimate.available) {
      elements.hardwarePriceEstimate.dataset.tone = "warning";
      elements.hardwarePriceEstimate.innerHTML = `
        <strong>Estimated price: unavailable</strong>
        <span>${escapeHtml(estimate.detail || "Pricing catalog did not return all required SKUs.")}</span>
      `;
      return;
    }
    const formatComponents = (components) => Array.isArray(components)
      ? components.map((component) => `${component.label}: ${Number(component.amountPln || 0).toFixed(2)} PLN/h`).join(", ")
      : "";
    const running = estimate.running || {
      available: true,
      display: estimate.display || `~${Number(estimate.amountPln || 0).toFixed(2)} PLN/h`,
      components: estimate.components || [],
    };
    const terminated = estimate.terminated || null;
    const runningParts = formatComponents(running.components);
    const terminatedParts = terminated ? formatComponents(terminated.components) : "";
    const storageSource = estimate.storage && estimate.storage.source === "actual"
      ? " Uses actual attached disks."
      : estimate.storage && estimate.storage.source === "configured"
        ? " Uses configured disks before the VM exists."
        : "";
    const unavailableDetail = (value) => Array.isArray(value && value.missing) && value.missing.length
      ? ` Missing pricing SKU: ${value.missing.join(", ")}.`
      : "";
    const effectiveTime = estimate.effectiveTime ? ` Catalog: ${escapeHtml(estimate.effectiveTime)}.` : "";
    elements.hardwarePriceEstimate.dataset.tone = "success";
    elements.hardwarePriceEstimate.innerHTML = `
      <strong>Running: ${escapeHtml(running.display || "Price unavailable")}</strong>
      <span>${escapeHtml(runningParts)}.${escapeHtml(unavailableDetail(running))}</span>
      <strong>Terminated: ${escapeHtml(terminated && terminated.display || "Price unavailable")}</strong>
      <span>${escapeHtml(terminatedParts)}.${escapeHtml(unavailableDetail(terminated))}</span>
      <span>On-demand Compute Engine estimate for ${escapeHtml(estimate.region || "selected region")}.${storageSource}${effectiveTime} Excludes snapshots, network egress, committed-use discounts and taxes.</span>
    `;
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

  async function scanGpuAvailabilityAcrossZones() {
    const profile = selectedHardwareProfile();
    if (!profile || Number(profile.gpuCount || 0) <= 0 || !String(profile.gpuType || "").trim()) {
      throw new Error("Select a GPU hardware profile before scanning availability.");
    }
    if (activeGpuAvailabilityScan(profile)) {
      resetGpuAvailabilityScan();
      renderZoneOptions();
      await refreshPriceEstimate({ silent: false });
      await refreshStatus({ silent: true });
      await refreshGpuCapacityReservationCount();
      setBanner("All compatible GPU zones are shown again. You can run a new capacity scan.", "success");
      return;
    }

    const zones = Array.isArray(profile.zones)
      ? profile.zones.map((zone) => String(zone || "").trim()).filter(Boolean)
      : [];
    const run = {
      hardwareId: String(profile.id || ""),
      target: selectedTargetParams(),
      zones,
      completed: 0,
      currentZone: "",
      availableZones: [],
      cleanupFailures: [],
      cancelRequested: false,
      finished: false,
      abortController: new AbortController(),
    };
    state.gpuAvailabilityScanRun = run;
    updateGpuAvailabilityScanButton();
    renderGpuAvailabilityScanProgress(run);
    try {
      for (const zone of zones) {
        if (run.cancelRequested) {
          break;
        }
        run.currentZone = zone;
        renderGpuAvailabilityScanProgress(run);
        try {
          const data = await fetchApi("/api/capacity-reservations/scan-zone", {
            method: "POST",
            body: JSON.stringify({ ...run.target, zone }),
            signal: run.abortController.signal,
          });
          if (data && data.available) {
            run.availableZones.push(zone);
          }
          if (data && data.cleanupFailure) {
            run.cleanupFailures.push({ zone, error: String(data.cleanupFailure) });
          }
          run.completed += 1;
        } catch (error) {
          if (run.cancelRequested || error.name === "AbortError") {
            break;
          }
          run.completed += 1;
          setCommandStatus(`Capacity scan skipped ${zoneDisplayLabel(zone)}: ${formatErrorMessage(error)}`, "warning");
        }
        renderGpuAvailabilityScanProgress(run);
      }
    } finally {
      run.finished = true;
      run.currentZone = "";
      state.gpuAvailabilityScanRun = null;
      updateGpuAvailabilityScanButton();
      await refreshGpuCapacityReservationCount();
      scheduleGpuCapacityReservationCountRefreshes();
      if (run.cancelRequested) {
        state.gpuAvailabilityScan = {
          hardwareId: run.hardwareId,
          availableZones: run.availableZones,
        };
        renderZoneOptions();
        await refreshPriceEstimate({ silent: false });
        await refreshStatus({ silent: true });
        const cleanupFailures = run.cleanupFailures.length;
        const message = cleanupFailures
          ? `GPU capacity scan cancelled after ${run.completed}/${zones.length} zones. Applied partial result: ${run.availableZones.length} GPU zones with current capacity; ${cleanupFailures} temporary reservation cleanup${cleanupFailures === 1 ? "" : "s"} will expire automatically.`
          : `GPU capacity scan cancelled after ${run.completed}/${zones.length} zones. Applied partial result: ${run.availableZones.length} GPU zones with current capacity. All temporary reservations were released.`;
        setBanner(message, cleanupFailures ? "warning" : "success");
        return;
      }
    }

    state.gpuAvailabilityScan = {
      hardwareId: run.hardwareId,
      availableZones: run.availableZones,
    };
    renderZoneOptions();
    await refreshPriceEstimate({ silent: false });
    await refreshStatus({ silent: true });
    const cleanupFailures = run.cleanupFailures.length;
    const message = cleanupFailures
      ? `Capacity scan found ${run.availableZones.length}/${zones.length} available GPU zones, but ${cleanupFailures} temporary reservation cleanup${cleanupFailures === 1 ? "" : "s"} will expire automatically.`
      : `Capacity scan found ${run.availableZones.length}/${zones.length} GPU zones with current capacity. All temporary reservations were released.`;
    setBanner(message, cleanupFailures ? "warning" : "success");
  }

  function getCreatedInstances() {
    const instances = state.instancesPayload && Array.isArray(state.instancesPayload.instances)
      ? state.instancesPayload.instances
      : [];
    return instances.filter((instance) => instance && instance.name && instance.zone);
  }

  function instanceHardwareLabel(instance) {
    const hardware = instance && instance.hardware ? instance.hardware : {};
    if (hardware.label) {
      return String(hardware.label);
    }
    if (hardware.gpuType) {
      return String(hardware.gpuType);
    }
    return "CPU";
  }

  function concreteMinecraftVersion(version, payload) {
    const candidate = String(version || "").trim();
    if (candidate && candidate.toUpperCase() !== "LATEST") {
      return candidate;
    }
    return getMinecraftVersionCatalog(payload)
      .find((item) => String(item || "").trim().toUpperCase() !== "LATEST") || "";
  }

  function serviceStatusWithVersion(status, payload, service) {
    const label = status && status.label ? String(status.label) : "unknown";
    const version = service === "minecraft"
      ? concreteMinecraftVersion(status && status.version, payload)
      : String(status && status.version || "").trim();
    if (version) {
      return `${label} · v${version}`;
    }
    return service === "sunshine" ? `${label} · version not detected` : label;
  }

  function renderInstanceOptions(payload) {
    if (!elements.instancesList) {
      return;
    }

    state.instancesPayload = payload || state.instancesPayload;
    const instances = getCreatedInstances();
    if (!state.user) {
      elements.instancesList.className = "instance-list empty";
      elements.instancesList.textContent = "Sign in to load created instances.";
      if (elements.instancesStatus) {
        elements.instancesStatus.textContent = "Created instances are loaded from Compute Engine after Google sign-in.";
      }
      updateActionAvailability();
      return;
    }

    if (!instances.length) {
      elements.instancesList.className = "instance-list empty";
      elements.instancesList.textContent = "No created instances found for this backend target name.";
      if (elements.instancesStatus) {
        const name = state.instancesPayload && state.instancesPayload.instanceName
          ? state.instancesPayload.instanceName
          : "configured VM";
        elements.instancesStatus.textContent = `No Compute Engine instances named ${name} were found.`;
      }
      updateActionAvailability();
      return;
    }

    const selectedHardware = String(elements.hardwareSelect && elements.hardwareSelect.value || "");
    const selectedZoneValue = selectedZone();
    elements.instancesList.className = "instance-list";
    elements.instancesList.innerHTML = instances.map((instance, index) => {
      const hardware = instance.hardware || {};
      const hardwareId = String(hardware.id || "");
      const isSelected = selectedHardware && selectedZoneValue
        && hardwareId === selectedHardware
        && String(instance.zone) === selectedZoneValue;
      const status = String(instance.status || "UNKNOWN");
      const sunshine = serviceStatusWithVersion(instance.sunshineStatus, payload, "sunshine");
      const minecraft = serviceStatusWithVersion(instance.minecraftStatus, payload, "minecraft");
      const ip = instance.externalIp ? ` · ${instance.externalIp}` : "";
      return `
        <button
          class="instance-card${isSelected ? " selected" : ""}"
          type="button"
          data-instance-index="${index}"
        >
          <span class="instance-card-title">${escapeHtml(instance.name)} · ${escapeHtml(instance.zone)}</span>
          <span class="instance-card-meta">${escapeHtml(instanceHardwareLabel(instance))} · ${escapeHtml(hardware.machineType || "machine")} · ${escapeHtml(status)}${escapeHtml(ip)}</span>
          <span class="instance-card-meta">Sunshine: ${escapeHtml(sunshine)}</span>
          <span class="instance-card-meta">Minecraft: ${escapeHtml(minecraft)}</span>
        </button>
      `;
    }).join("");

    if (elements.instancesStatus) {
      const refreshedAt = state.instancesPayload && state.instancesPayload.refreshedAt
        ? ` Refreshed: ${state.instancesPayload.refreshedAt}.`
        : "";
      elements.instancesStatus.textContent = `${instances.length} created instance${instances.length === 1 ? "" : "s"} found.${refreshedAt}`;
    }
    updateActionAvailability();
  }

  function currentSelectionMatchesCreatedInstance() {
    const currentZone = selectedZone();
    const currentHardwareId = String(elements.hardwareSelect && elements.hardwareSelect.value || "").trim();
    if (!currentZone || !currentHardwareId) {
      return false;
    }
    return getCreatedInstances().some((instance) => {
      const profile = profileForInstance(instance);
      return profile
        && String(profile.id || "") === currentHardwareId
        && String(instance.zone || "").trim() === currentZone;
    });
  }

  function instanceMatchesCurrentSelection(instance) {
    const currentZone = selectedZone();
    const currentHardwareId = String(elements.hardwareSelect && elements.hardwareSelect.value || "").trim();
    const profile = profileForInstance(instance);
    return Boolean(
      profile
      && currentZone
      && currentHardwareId
      && String(profile.id || "") === currentHardwareId
      && String(instance && instance.zone || "").trim() === currentZone
    );
  }

  function runningInstancesOutsideCurrentSelection() {
    return getCreatedInstances().filter((instance) => (
      String(instance.status || "").toUpperCase() === "RUNNING"
      && !instanceMatchesCurrentSelection(instance)
    ));
  }

  function runningInstancePromptLabel(instance) {
    return `${instance.name || "unknown"} (${instanceHardwareLabel(instance)}, ${instance.zone || "unknown zone"})`;
  }

  async function refreshInstances(options) {
    const silent = Boolean(options && options.silent);
    const autoSelect = Boolean(options && options.autoSelect);
    if (!state.user) {
      throw new Error("Sign in with Google first.");
    }
    if (!silent && elements.instancesStatus) {
      elements.instancesStatus.textContent = "Refreshing created instances...";
    }
    const data = await fetchApi("/api/instances", { method: "GET" });
    renderInstanceOptions(data);
    if (autoSelect) {
      await autoSelectCreatedInstanceIfNeeded({ silent: true });
    }
    return data;
  }

  function profileForInstance(instance) {
    const hardware = instance && instance.hardware ? instance.hardware : {};
    const hardwareId = String(hardware.id || "");
    const gpuType = String(hardware.gpuType || "");
    return getHardwareProfiles().find((profile) => String(profile.id) === hardwareId)
      || getHardwareProfiles().find((profile) => gpuType && String(profile.gpuType) === gpuType)
      || null;
  }

  async function autoSelectCreatedInstanceIfNeeded(options) {
    const instances = getCreatedInstances();
    if (!instances.length) {
      return false;
    }
    if (!state.hardwarePayload || !getHardwareProfiles().length) {
      await refreshHardwareOptions({ silent: true });
    }
    if (currentSelectionMatchesCreatedInstance()) {
      return false;
    }
    await selectCreatedInstance(0, options);
    return true;
  }

  async function selectCreatedInstance(index, options) {
    const silent = Boolean(options && options.silent);
    const instances = getCreatedInstances();
    const instance = instances[index];
    if (!instance) {
      throw new Error("Selected instance is no longer available.");
    }
    if (!state.hardwarePayload || !getHardwareProfiles().length) {
      await refreshHardwareOptions({ silent: false });
    }

    const profile = profileForInstance(instance);
    if (!profile) {
      throw new Error(`No hardware profile matches ${instanceHardwareLabel(instance)}.`);
    }

    const zone = String(instance.zone || "").trim();
    if (zone && Array.isArray(profile.zones) && !profile.zones.includes(zone)) {
      profile.zones = [zone, ...profile.zones];
    }

    resetGpuAvailabilityScan();
    elements.hardwareSelect.value = String(profile.id || "");
    if (elements.zoneSelect) {
      elements.zoneSelect.dataset.savedValue = zone;
    }
    renderZoneOptions();
    renderInstanceOptions(state.instancesPayload);
    if (!silent) {
      setCommandStatus(`Selected ${instance.name} in ${zone}. Hardware and zone fields were updated.`, "success");
    }
    await refreshPriceEstimate({ silent });
    await refreshStatus({ silent: true });
  }

  function backupDisplayLabel(backup) {
    const id = String(backup && backup.id || "");
    const label = String(backup && backup.label || "");
    const prefixed = /^(.+)-([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)$/.exec(id);
    if (prefixed && (!label || label === id)) {
      return `${prefixed[1]} · ${prefixed[2]}`;
    }
    return label || String(backup && backup.createdAt || id);
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
        const label = backupDisplayLabel(backup);
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

  function renderStatusPayload(payload, targetKey) {
    state.lastStatus = payload;
    state.lastStatusTargetKey = targetKey || selectedTargetKey();
    renderTargetSummary();
    renderBackupOptions(payload);
    renderApplicationOptions(payload);
    renderMinecraftOptions(payload);
    renderAutoStopStatus(payload);
    renderHardwarePriceEstimate(selectedPriceEstimate());
    renderAccess(payload);
    scrollToCurrentHashOnce();
    updateActionAvailability();
  }

  function scrollToHashTarget(hash, options) {
    const rawHash = String(hash || "");
    const targetId = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
    if (!targetId) {
      return false;
    }
    const target = document.getElementById(targetId);
    if (!target) {
      return false;
    }
    target.scrollIntoView({ behavior: options && options.smooth ? "smooth" : "auto", block: "center" });
    if (typeof target.focus === "function") {
      target.focus({ preventScroll: true });
    }
    return true;
  }

  function scrollToCurrentHashOnce() {
    if (!window.location.hash || state.scrolledInitialHash === window.location.hash) {
      return;
    }
    window.setTimeout(() => {
      if (scrollToHashTarget(window.location.hash, { smooth: false })) {
        state.scrolledInitialHash = window.location.hash;
      }
    }, 100);
  }

  function formatLocalDateTime(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return "";
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      return raw;
    }
    return date.toLocaleString("pl-PL", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function formatRemainingSeconds(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "";
    }
    const totalMinutes = Math.ceil(seconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours && minutes) {
      return `${hours}h ${minutes}min`;
    }
    if (hours) {
      return `${hours}h`;
    }
    return `${minutes}min`;
  }

  function autoStopSummary(payload) {
    const autoStop = payload && payload.autoStop ? payload.autoStop : {};
    const hours = autoStop.hours || payload && payload.autoStopHours || "";
    const scheduledAt = autoStop.scheduledAt || "";
    if (!hours) {
      return "Auto-stop: disabled.";
    }
    if (!scheduledAt) {
      return `Auto-stop: scheduled after ${hours}h.`;
    }
    const remaining = formatRemainingSeconds(autoStop.remainingSeconds);
    const source = autoStop.source === "estimated" ? " estimated" : "";
    return `Auto-stop: ${formatLocalDateTime(scheduledAt)}${remaining ? ` (${remaining} left)` : ""}${source}.`;
  }

  function renderAutoStopStatus(payload) {
    if (!elements.autoStopStatus) {
      return;
    }
    if (!payload || payload.instanceExists === false || payload.status === "NOT_FOUND") {
      elements.autoStopStatus.textContent = "Auto-stop schedule will appear after VM status is loaded.";
      return;
    }
    elements.autoStopStatus.textContent = autoStopSummary(payload);
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

    const vmState = String(payload.status || "").trim().toUpperCase();
    const persistence = payload.persistence || {};
    const dataDiskState = String(persistence.dataDisk && persistence.dataDisk.state || "")
      .trim()
      .toLowerCase();
    const backupReadyState = String(persistence.backupReady && persistence.backupReady.state || "")
      .trim()
      .toLowerCase();
    const restoreState = String(persistence.restore && persistence.restore.state || "")
      .trim()
      .toLowerCase();
    const gamesArchiveState = String(persistence.gamesArchive && persistence.gamesArchive.state || "")
      .trim()
      .toLowerCase();
    if (vmState === "RUNNING" && payload.instanceExists !== false) {
      if (["pending", "attaching", "mounting", "preparing", "starting"].includes(dataDiskState)) {
        return true;
      }
      if (!["ready", "error", "missing", "disabled"].includes(backupReadyState)) {
        return true;
      }
      if (["pending", "starting", "preparing"].includes(backupReadyState)) {
        return true;
      }
    }
    if (["running", "restoring", "starting"].includes(restoreState)) {
      return true;
    }
    if (["running", "archiving", "uploading"].includes(gamesArchiveState)) {
      return true;
    }

    const sunshineState = String(payload.sunshineStatus && payload.sunshineStatus.state || "")
      .trim()
      .toLowerCase();
    const minecraftState = String(payload.minecraftStatus && payload.minecraftStatus.state || "")
      .trim()
      .toLowerCase();
    return ["starting", "stopping", "backup", "restore"].includes(sunshineState)
      || ["installing", "starting", "stopping", "backup", "restore", "removing"].includes(minecraftState);
  }

  async function waitForStatusSettled(command, initialPayload) {
    if (!COMMANDS_TO_POLL_AFTER_RESPONSE.has(command)) {
      return initialPayload;
    }

    const deadline = Date.now() + (COMMAND_STATUS_POLL_TIMEOUTS_MS[command] || COMMAND_STATUS_POLL_TIMEOUT_MS);
    let payload = initialPayload;

    do {
      await wait(SUNSHINE_POLL_INTERVAL_MS);
      payload = await refreshStatus({ silent: true, forceRender: true });
      if (isTransitionalStatus(payload)) {
        setCommandStatus(statusBannerMessage(`Command "${command}" still updating`, payload), "warning");
      }
    } while (Date.now() < deadline && isTransitionalStatus(payload));

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

    const target = state.lastStatus && state.lastStatus.target
      ? state.lastStatus.target
      : (config.target || {});
    const domains = (config.duckdnsDomains || []).length
      ? `<p><strong>DuckDNS:</strong> <code>${escapeHtml(config.duckdnsDomains.join(", "))}</code></p>`
      : "<p><strong>DuckDNS:</strong> not configured</p>";
    const persistence = state.lastStatus && state.lastStatus.persistence ? state.lastStatus.persistence : null;
    const autoStopMeta = state.lastStatus
      ? `<p><strong>Auto-stop:</strong> <code>${escapeHtml(autoStopSummary(state.lastStatus))}</code></p>`
      : "";
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
        <p><strong>Estimated price:</strong> <code>${escapeHtml((effectiveHardware.priceEstimate && effectiveHardware.priceEstimate.display) || (selectedPriceEstimate() && selectedPriceEstimate().display) || "unknown")}</code></p>
      `
      : "";

    elements.targetSummary.innerHTML = `
      <p><strong>Backend:</strong> <code>${escapeHtml(state.backendUrl)}</code></p>
      <p><strong>Project:</strong> <code>${escapeHtml(target.project || "unknown")}</code></p>
      <p><strong>Zone:</strong> <code>${escapeHtml((effectiveHardware && effectiveHardware.zone) || target.zone || "unknown")}</code></p>
      <p><strong>Instance:</strong> <code>${escapeHtml(target.instance || "unknown")}</code></p>
      ${domains}
      ${hardwareMeta}
      ${autoStopMeta}
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
    setPageLoading("Connecting to Cloud Run backend...");

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
      await loadAuthenticatedControls("Restoring Google session...");
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

  function storeSessionToken(token, expiresInSeconds) {
    state.token = token;
    if (token) {
      window.sessionStorage.setItem(storageKeys.sessionToken, token);
      const expiresIn = Number(expiresInSeconds);
      state.tokenExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0
        ? Date.now() + (expiresIn * 1000)
        : 0;
      if (state.tokenExpiresAt) {
        window.sessionStorage.setItem(storageKeys.sessionTokenExpiresAt, String(state.tokenExpiresAt));
      } else {
        window.sessionStorage.removeItem(storageKeys.sessionTokenExpiresAt);
      }
    } else {
      window.sessionStorage.removeItem(storageKeys.sessionToken);
      window.sessionStorage.removeItem(storageKeys.sessionTokenExpiresAt);
      state.tokenExpiresAt = 0;
    }
  }

  async function refreshGoogleToken() {
    if (state.googleTokenRefreshPromise) {
      return state.googleTokenRefreshPromise;
    }
    if (!state.googleTokenClient) {
      throw new Error("Google session refresh is unavailable. Sign in with Google again.");
    }

    state.googleTokenRefreshPromise = new Promise((resolve, reject) => {
      state.googleTokenRefreshHandlers = { resolve, reject };
      try {
        state.googleTokenClient.requestAccessToken({ prompt: "" });
      } catch (error) {
        state.googleTokenRefreshHandlers = null;
        reject(error);
      }
    }).finally(() => {
      state.googleTokenRefreshHandlers = null;
      state.googleTokenRefreshPromise = null;
    });
    return state.googleTokenRefreshPromise;
  }

  function clearSession(options) {
    const revokeGoogleSession = Boolean(options && options.revokeGoogleSession);
    const token = state.token;
    storeSessionToken("");
    state.user = null;
    state.lastStatus = null;
    state.lastStatusTargetKey = "";
    renderAccess(null);
    updateAuthUi();
    setBusy(false);
    if (revokeGoogleSession && token && window.google && window.google.accounts && window.google.accounts.oauth2) {
      window.google.accounts.oauth2.revoke(token, () => {});
    }
  }

  async function handleGoogleToken(response) {
    const refreshHandlers = state.googleTokenRefreshHandlers;
    if (refreshHandlers) {
      if (response.error || !response.access_token) {
        refreshHandlers.reject(new Error(response.error_description || response.error || "Google session refresh failed."));
      } else {
        storeSessionToken(response.access_token, response.expires_in);
        refreshHandlers.resolve();
      }
      return;
    }

    let loaded = false;
    try {
      if (response.error) {
        throw new Error(response.error_description || response.error);
      }
      setPageLoading("Verifying Google session...");
      setBusy(true);
      setBanner("Verifying Google session...", "warning");
      storeSessionToken(response.access_token || "", response.expires_in);
      await loadAuthenticatedControls("Verifying Google session...");
      loaded = true;
    } catch (error) {
      clearSession();
      handleError(error);
    } finally {
      setBusy(false);
      markPageReady(loaded ? "Ready." : "Sign-in failed.");
    }
  }

  function handleGoogleOAuthError(error) {
    const refreshHandlers = state.googleTokenRefreshHandlers;
    if (refreshHandlers) {
      refreshHandlers.reject(new Error((error && (error.description || error.type)) || "Google session refresh failed."));
      return;
    }

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
    if (data && data.session && data.session.token) {
      storeSessionToken(data.session.token, data.session.expiresInSeconds);
    }
    state.user = data.user;
    updateAuthUi();
    setBanner(`Signed in as ${state.user.email}.`, "success");
  }

  async function loadAuthenticatedControls(firstMessage) {
    setPageLoading(firstMessage || "Loading authenticated controls...");
    await restoreSession();
    setPageLoading("Loading hardware and zone availability...");
    await refreshHardwareOptions({ silent: true });
    setPageLoading("Loading created VM instances...");
    await refreshInstances({ silent: true, autoSelect: true });
    setPageLoading("Loading price estimate...");
    await refreshPriceEstimate({ silent: true });
    setPageLoading("Loading current VM and service status...");
    await refreshStatus({ silent: true });
    updateActionAvailability();
  }

  async function fetchApi(path, options, allowTokenRefresh = true) {
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
        if (allowTokenRefresh && state.token) {
          try {
            await refreshGoogleToken();
            return fetchApi(path, options, false);
          } catch (error) {
            console.warn("Google session refresh failed after an API authorization response.", error);
          }
        }
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

    // Capture the target before any asynchronous preflight can refresh the
    // hardware payload or alter the form state. This prevents an action from
    // silently falling back to the backend's default hardware selection.
    const commandTargetParams = selectedTargetParams();
    if (!commandTargetParams.hardwareId || !commandTargetParams.zone) {
      throw new Error("Selected hardware or zone is no longer available. Refresh hardware availability and select the target again.");
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

    let stopRunningInstances = false;
    if (command === "create" || command === "start") {
      try {
        await refreshInstances({ silent: true });
      } catch (error) {
        console.warn("Unable to refresh instances before start/create preflight.", error);
      }
      const runningInstances = runningInstancesOutsideCurrentSelection();
      if (runningInstances.length) {
        const labels = runningInstances.map(runningInstancePromptLabel).join(", ");
        const confirmed = window.confirm(
          `Another VM is currently running: ${labels}. Stop it before running "${command}" for the selected Hardware/Zone?`,
        );
        if (!confirmed) {
          setBanner(`Command "${command}" cancelled. Another VM is already running.`, "warning");
          setCommandStatus(`Command "${command}" cancelled. Running VM was left unchanged.`, "warning");
          return;
        }
        stopRunningInstances = true;
      }
    }

    const loadingToken = setPageLoading(`Running "${command}"...`);
    setBusy(true);
    const appLabel = command === "install-app" || command === "uninstall-app"
      ? ` for ${selectedApplicationLabel()}`
      : "";
    setCommandStatus(`Running "${command}"${appLabel} on the VM...`, "warning");
    applyCommandTransition(command);
    const previousStatus = state.lastStatus;
    const previousStatusTargetKey = state.lastStatusTargetKey;
    schedulePostCommandStatusRefresh(command);

    try {
      const body = { command, ...commandTargetParams };
      if (stopRunningInstances) {
        body.stopRunningInstances = true;
      }
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
      if (command === "install-minecraft") {
        const minecraftVersion = selectedMinecraftVersion();
        if (!minecraftVersion) {
          throw new Error("Select a Minecraft server version first.");
        }
        body.minecraftVersion = minecraftVersion;
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
      if (COMMANDS_TO_POLL_AFTER_RESPONSE.has(command)) {
        setCommandStatus(`Command "${command}" accepted. Waiting for current VM and Sunshine status...`, "warning");
        data = await waitForStatusSettled(command, data);
        renderStatusPayload(data);
      }
      if (COMMANDS_TO_POLL_AFTER_RESPONSE.has(command)) {
        await refreshInstances({ silent: true, autoSelect: command === "delete" });
      }

      const suffix = data.duckdnsUpdated
        ? " DuckDNS refreshed."
        : "";
      const autoStop = data.autoStopHours
        ? ` ${autoStopSummary(data)}`
        : "";
      const powerActionPhase = String(data.powerAction && data.powerAction.phase ? data.powerAction.phase : "").toLowerCase();
      const bannerTone = powerActionPhase === "failed" ? "warning" : "success";
      setCommandStatus(`${commandCompletionMessage(command, data)}${suffix}${autoStop}`, bannerTone);
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
    } catch (error) {
      clearScheduledCommandStatusRefresh();
      const message = commandFailureMessage(command, error);
      setCommandStatus(message, "error");
      setBanner(message, "error");
      let recoveredStatus = null;
      if (COMMANDS_TO_POLL_AFTER_RESPONSE.has(command)) {
        try {
          setCommandStatus(
            `Command "${command}" response was lost. Checking current VM status before restoring the previous view...`,
            "warning",
          );
          recoveredStatus = await waitForStatusSettled(command, null);
          renderStatusPayload(recoveredStatus);
          await refreshInstances({ silent: true, autoSelect: command === "delete" });
          const recoveredMessage = `${message} ${statusBannerMessage(`Current VM status recovered after "${command}"`, recoveredStatus)}`;
          setCommandStatus(recoveredMessage, "error");
          setBanner(recoveredMessage, "error");
        } catch (recoveryError) {
          recoveredStatus = null;
        }
      }
      if (!recoveredStatus && previousStatus) {
        state.lastStatus = previousStatus;
        state.lastStatusTargetKey = previousStatusTargetKey;
      }
      try {
        if (!recoveredStatus) {
          recoveredStatus = await refreshStatus({ silent: true, forceRender: true });
          const recoveredMessage = `${message} ${statusBannerMessage(`Current VM status recovered after "${command}"`, recoveredStatus)}`;
          setCommandStatus(recoveredMessage, "error");
          setBanner(recoveredMessage, "error");
        }
      } catch (refreshError) {
        if (previousStatus) {
          renderStatusPayload(previousStatus, previousStatusTargetKey);
        } else {
          updateActionAvailability();
        }
      }
    } finally {
      setBusy(false);
      markPageReady("Ready.", loadingToken);
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

    const loadingToken = setPageLoading("Updating Sunshine password...");
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
      markPageReady("Ready.", loadingToken);
    }
  }

  function readAutoStopHours(command) {
    if (command !== "start" && command !== "create" && command !== "set-auto-stop") {
      return null;
    }

    const raw = String(elements.autoStopHours.value || "").trim();
    if (!raw) {
      if (command === "set-auto-stop") {
        throw new Error("Enter auto-stop hours before extending the timer.");
      }
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
      parts.push(autoStopSummary(data));
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
    const mismatch = selectedHardwareMismatchMessage(payload);
    if (mismatch) {
      return `
      <div class="service-status disabled">
        <span class="service-status-dot" aria-hidden="true"></span>
        <span>Status: Hardware mismatch</span>
      </div>
      <p class="access-meta">Status detail: <span>${escapeHtml(mismatch)}</span></p>
    `;
    }
    const sunshineStatus = payload.sunshineStatus || {};
    const state = escapeToken(sunshineStatus.state || "starting");
    const label = escapeHtml(sunshineStatus.label || "Starting");
    const version = String(sunshineStatus.version || "").trim();
    const versionMeta = version
      ? `<p class="access-meta">Version: <code>${escapeHtml(version)}</code></p>`
      : "";
    const detail = sunshineStatus.detail
      ? `<p class="access-meta">Status detail: <span>${escapeHtml(sunshineStatus.detail)}</span></p>`
      : "";
    return `
      <div class="service-status ${state}">
        <span class="service-status-dot" aria-hidden="true"></span>
        <span>Status: ${label}</span>
      </div>
      ${versionMeta}
      ${detail}
    `;
  }

  function renderMinecraftStatusMeta(payload) {
    const mismatch = selectedHardwareMismatchMessage(payload);
    if (mismatch) {
      return `
      <div class="service-status disabled">
        <span class="service-status-dot" aria-hidden="true"></span>
        <span>Status: Hardware mismatch</span>
      </div>
      <p class="access-meta">Status detail: <span>${escapeHtml(mismatch)}</span></p>
    `;
    }
    const minecraftStatus = payload.minecraftStatus || {};
    const state = escapeToken(minecraftStatus.state || "not_installed");
    const label = escapeHtml(minecraftStatus.label || "Not installed");
    const concreteVersion = concreteMinecraftVersion(minecraftStatus.version, payload);
    const version = concreteVersion
      ? `<p class="access-meta">Version: <code>${escapeHtml(concreteVersion)}</code></p>`
      : "";
    const detail = minecraftStatus.detail
      ? `<p class="access-meta">Status detail: <span>${escapeHtml(minecraftStatus.detail)}</span></p>`
      : "";
    return `
      <div class="service-status ${state}">
        <span class="service-status-dot" aria-hidden="true"></span>
        <span>Status: ${label}</span>
      </div>
      ${version}
      ${detail}
    `;
  }

  function getMinecraftVersionCatalog(payload) {
    const fromPayload = payload && payload.minecraft && Array.isArray(payload.minecraft.versions)
      ? payload.minecraft.versions
      : [];
    const fromConfig = state.backendConfig && state.backendConfig.minecraftServer && Array.isArray(state.backendConfig.minecraftServer.versions)
      ? state.backendConfig.minecraftServer.versions
      : [];
    const versions = fromPayload.length ? fromPayload : fromConfig;
    return versions.map((version) => String(version || "").trim()).filter(Boolean);
  }

  function defaultMinecraftVersion(payload) {
    const fromPayload = payload && payload.minecraft && payload.minecraft.defaultVersion
      ? String(payload.minecraft.defaultVersion)
      : "";
    const fromConfig = state.backendConfig && state.backendConfig.minecraftServer && state.backendConfig.minecraftServer.defaultVersion
      ? String(state.backendConfig.minecraftServer.defaultVersion)
      : "";
    return fromPayload || fromConfig || "LATEST";
  }

  function minecraftVersionOptionLabel(version, payload) {
    if (String(version || "").trim().toUpperCase() !== "LATEST") {
      return String(version || "");
    }
    const concreteVersion = concreteMinecraftVersion(version, payload);
    return concreteVersion ? `Latest stable (${concreteVersion})` : "Latest stable";
  }

  function selectedMinecraftVersion() {
    return String(elements.minecraftVersionSelect && elements.minecraftVersionSelect.value || "").trim()
      || defaultMinecraftVersion(state.lastStatus);
  }

  function applyMinecraftVersionPayload(payload) {
    if (!payload || !Array.isArray(payload.versions) || !payload.versions.length) {
      return false;
    }
    state.backendConfig = {
      ...(state.backendConfig || {}),
      minecraftServer: {
        ...(state.backendConfig && state.backendConfig.minecraftServer ? state.backendConfig.minecraftServer : {}),
        versions: payload.versions,
        defaultVersion: payload.defaultVersion || payload.versions[0],
        source: payload.source || "backend",
        updatedAt: payload.updatedAt || "",
        error: payload.error || "",
      },
    };
    if (state.lastStatus) {
      state.lastStatus = {
        ...state.lastStatus,
        minecraft: {
          ...(state.lastStatus.minecraft || {}),
          versions: payload.versions,
          defaultVersion: payload.defaultVersion || payload.versions[0],
          source: payload.source || "backend",
          updatedAt: payload.updatedAt || "",
          error: payload.error || "",
        },
      };
    }
    return true;
  }

  async function refreshMinecraftVersions() {
    if (!state.user) {
      throw new Error("Sign in with Google first.");
    }
    if (elements.minecraftOptionsStatus) {
      elements.minecraftOptionsStatus.textContent = "Refreshing Minecraft server versions from PaperMC...";
    }
    const previousVersion = selectedMinecraftVersion();
    const data = await fetchApi("/api/minecraft/versions", { method: "POST" });
    const updated = applyMinecraftVersionPayload(data);
    if (updated && elements.minecraftVersionSelect) {
      elements.minecraftVersionSelect.dataset.savedValue = previousVersion;
    }
    renderMinecraftOptions(state.lastStatus);
    if (data && data.error) {
      setCommandStatus(`Minecraft versions refresh failed. Keeping previous list. ${data.error}`, "warning");
    } else {
      const source = data && data.source ? ` Source: ${data.source}.` : "";
      const updatedAt = data && data.updatedAt ? ` Updated: ${data.updatedAt}.` : "";
      setCommandStatus(`Minecraft versions refreshed.${source}${updatedAt}`, "success");
    }
    return data;
  }

  function renderMinecraftOptions(payload) {
    if (!elements.minecraftAddress) {
      return;
    }
    const address = payload && payload.urls && payload.urls.minecraft
      ? String(payload.urls.minecraft)
      : "Connect backend to load address";
    elements.minecraftAddress.value = address;
    if (elements.minecraftVersionSelect) {
      const versions = getMinecraftVersionCatalog(payload);
      const previousValue = elements.minecraftVersionSelect.value
        || elements.minecraftVersionSelect.dataset.savedValue
        || (payload && payload.minecraftStatus && payload.minecraftStatus.version ? String(payload.minecraftStatus.version) : "")
        || defaultMinecraftVersion(payload);
      if (!versions.length) {
        elements.minecraftVersionSelect.innerHTML = '<option value="">No versions loaded</option>';
      } else {
        elements.minecraftVersionSelect.innerHTML = versions
          .map((version) => `<option value="${escapeHtml(version)}">${escapeHtml(minecraftVersionOptionLabel(version, payload))}</option>`)
          .join("");
        if (versions.includes(previousValue)) {
          elements.minecraftVersionSelect.value = previousValue;
        } else {
          const fallbackVersion = defaultMinecraftVersion(payload);
          elements.minecraftVersionSelect.value = versions.includes(fallbackVersion) ? fallbackVersion : versions[0];
        }
      }
      elements.minecraftVersionSelect.dataset.savedValue = "";
    }
    if (elements.minecraftOptionsStatus) {
      const mismatch = selectedHardwareMismatchMessage(payload);
      if (mismatch) {
        elements.minecraftOptionsStatus.textContent = `Minecraft status: Hardware mismatch. ${mismatch}`;
        updateActionAvailability();
        return;
      }
      const label = payload && payload.minecraftStatus && payload.minecraftStatus.label
        ? payload.minecraftStatus.label
        : "Unknown";
      const versionPayload = payload && payload.minecraft ? payload.minecraft : state.backendConfig && state.backendConfig.minecraftServer || {};
      const versionSource = versionPayload.source ? ` Source: ${versionPayload.source}.` : "";
      const versionUpdatedAt = versionPayload.updatedAt ? ` Versions updated: ${versionPayload.updatedAt}.` : "";
      const installedVersion = concreteMinecraftVersion(payload && payload.minecraftStatus && payload.minecraftStatus.version, payload);
      const selectedVersion = minecraftVersionOptionLabel(selectedMinecraftVersion(), payload);
      const versionText = installedVersion
        ? `Installed version: ${installedVersion}.`
        : `Selected version: ${selectedVersion}.`;
      elements.minecraftOptionsStatus.textContent = `Minecraft status: ${label}. Server address: ${address}. ${versionText}${versionSource}${versionUpdatedAt}`;
    }
    updateActionAvailability();
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
    const forceRender = Boolean(options && options.forceRender);
    if (!state.user) {
      throw new Error("Sign in with Google first.");
    }

    if (!silent) {
      setBusy(true);
      setCommandStatus("Refreshing VM status...", "warning");
    }

    try {
      const requestTargetKey = selectedTargetKey();
      const data = await fetchApi(`/api/status${statusQueryString()}`, { method: "GET" });
      if (!forceRender && requestTargetKey !== selectedTargetKey()) {
        return data;
      }
      renderStatusPayload(data, requestTargetKey);
      await refreshGpuCapacityReservationCount();
      if (!options || options.refreshInstances !== false) {
        try {
          await refreshInstances({ silent: true });
        } catch (error) {
          console.warn("Failed to refresh instance list after status update.", error);
        }
      }
      if (!silent) {
        setCommandStatus(statusBannerMessage("VM status loaded", data), statusMessageTone(data));
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
    const minecraftManagement = payload.minecraftManagement || {};
    const minecraftManagementUrl = new URL("./minecraft-admin.html", window.location.href);
    const currentBackendUrl = String(elements.backendUrl && elements.backendUrl.value || "").trim();
    if (currentBackendUrl) {
      minecraftManagementUrl.searchParams.set("backend", currentBackendUrl);
    }
    minecraftManagementUrl.searchParams.set("hardwareId", String(elements.hardwareSelect && elements.hardwareSelect.value || ""));
    minecraftManagementUrl.searchParams.set("zone", selectedZone());
    const minecraftManagementLink = minecraftManagement.authorized
      ? `<a href="${escapeHtml(minecraftManagementUrl.toString())}">Open management controls</a>`
      : "<span class=\"access-meta\">Minecraft management access has not been granted to this account.</span>";

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
          <p>Use this address in Minecraft Multiplayer. Privileged accounts can open the secure server management panel.</p>
          <p class="access-meta">Address: <code>${minecraftAddressEscaped}</code></p>
          ${minecraftStatusMeta}
          <div class="access-links">
            ${minecraftManagementLink}
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
    clearScheduledCommandStatusRefresh();
    const message = formatErrorMessage(error);
    setCommandStatus(message, "error");
    setBanner(message, "error");
    updateActionAvailability();
  }

  function setCapacityButtonResult(button, label, tone) {
    if (!button) {
      return;
    }
    const labelElement = button.querySelector("[data-capacity-label]");
    if (labelElement) {
      labelElement.textContent = label;
    } else {
      button.textContent = label;
    }
    button.dataset.tone = tone || "neutral";
  }

  function renderGpuCapacityReservationCount(rawCount) {
    if (!elements.gpuProbeCount) {
      return;
    }
    const count = Math.max(0, Number.parseInt(rawCount, 10) || 0);
    elements.gpuProbeCount.textContent = String(count);
    elements.gpuProbeCount.setAttribute(
      "aria-label",
      `${count} reserved GPU probe${count === 1 ? "" : "s"}`,
    );
  }

  async function refreshGpuCapacityReservationCount() {
    if (!state.user) {
      renderGpuCapacityReservationCount(0);
      return;
    }
    try {
      const data = await fetchApi("/api/capacity-reservations", { method: "GET" });
      renderGpuCapacityReservationCount(data && data.reservedGpuCount);
    } catch (error) {
      console.warn("Failed to refresh GPU capacity reservation count.", error);
    }
  }

  function scheduleGpuCapacityReservationCountRefreshes() {
    [3000, 10000, 30000, 60000, 120000].forEach((delay) => {
      window.setTimeout(() => {
        if (state.user) {
          refreshGpuCapacityReservationCount();
        }
      }, delay);
    });
  }

  function resetGpuCapacityProbeButton() {
    setCapacityButtonResult(elements.checkGpuCapacity, "Check GPU Capacity", "neutral");
  }

  async function checkGpuCapacity() {
    const target = selectedTargetParams();
    if (!target.hardwareId || !target.zone || !target.gpuType || Number(target.gpuCount || 0) <= 0) {
      const message = "Select a GPU hardware profile and zone before checking capacity.";
      setCapacityButtonResult(elements.checkGpuCapacity, "GPU Capacity Unavailable", "error");
      setCommandStatus(message, "error");
      setBanner(message, "error");
      return;
    }

    const loadingToken = setPageLoading("Checking GPU capacity...");
    try {
      setBusy(true);
      setCapacityButtonResult(elements.checkGpuCapacity, "Checking GPU Capacity...", "neutral");
      const data = await fetchApi("/api/capacity-reservations/probe", {
        method: "POST",
        body: JSON.stringify(target),
      });
      const expiresAt = data && data.reservation && data.reservation.expiresAt
        ? ` until ${data.reservation.expiresAt}`
        : "";
      const message = data && data.message
        ? `${data.message}${expiresAt}.`
        : `GPU capacity is reserved${expiresAt}.`;
      setCapacityButtonResult(elements.checkGpuCapacity, "GPU Capacity Available", "success");
      setCommandStatus(message, "success");
      setBanner(message, "success");
    } catch (error) {
      const message = commandFailureMessage("check-gpu-capacity", error);
      setCapacityButtonResult(elements.checkGpuCapacity, "GPU Capacity Unavailable", "error");
      setCommandStatus(message, "error");
      setBanner(message, "error");
    } finally {
      await refreshGpuCapacityReservationCount();
      setBusy(false);
      markPageReady("Ready.", loadingToken);
    }
  }

  async function releaseGpuCapacityReservations() {
    const loadingToken = setPageLoading("Releasing GPU capacity reservations...");
    try {
      setBusy(true);
      setCapacityButtonResult(elements.releaseGpuCapacity, "Releasing GPU Probes...", "neutral");
      const data = await fetchApi("/api/capacity-reservations/release", { method: "POST", body: "{}" });
      const released = Array.isArray(data && data.released) ? data.released.length : 0;
      const failed = Array.isArray(data && data.failed) ? data.failed.length : 0;
      const message = failed
        ? `Released ${released} managed GPU reservation${released === 1 ? "" : "s"}; ${failed} could not be released.`
        : released
          ? `Released all ${released} managed GPU capacity reservation${released === 1 ? "" : "s"}.`
          : "No managed GPU capacity reservations were active.";
      setCapacityButtonResult(
        elements.releaseGpuCapacity,
        failed ? "Release GPU Probes Failed" : "GPU Probes Released",
        failed ? "error" : "success",
      );
      setCommandStatus(message, failed ? "error" : "success");
      setBanner(message, failed ? "error" : "success");
    } catch (error) {
      const message = commandFailureMessage("release-gpu-capacity-reservations", error);
      setCapacityButtonResult(elements.releaseGpuCapacity, "Release GPU Probes Failed", "error");
      setCommandStatus(message, "error");
      setBanner(message, "error");
    } finally {
      await refreshGpuCapacityReservationCount();
      setBusy(false);
      markPageReady("Ready.", loadingToken);
    }
  }

  elements.form.addEventListener("input", saveConfig);
  elements.connect.addEventListener("click", async () => {
    if (state.isBusy) {
      return;
    }
    try {
      setPageLoading("Connecting to Cloud Run backend...");
      setBusy(true);
      await connectBackend();
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
      markPageReady("Ready.");
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
        setCommandStatus(statusBannerMessage("VM status loaded", data), statusMessageTone(data));
      } catch (error) {
        handleError(error);
      }
    });
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest("[data-scroll-target]");
    if (!link) {
      return;
    }
    const targetId = String(link.getAttribute("data-scroll-target") || "").trim();
    if (!targetId) {
      return;
    }
    event.preventDefault();
    if (window.location.hash !== `#${targetId}`) {
      window.history.pushState(null, "", `#${targetId}`);
    }
    state.scrolledInitialHash = "";
    scrollToHashTarget(targetId, { smooth: true });
  });

  elements.actionButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const command = button.dataset.command;
      if (command === "status") {
        const loadingToken = setPageLoading("Refreshing VM status...");
        try {
          const data = await refreshStatus({ silent: true });
          setCommandStatus(statusBannerMessage("VM status loaded", data), statusMessageTone(data));
        } catch (error) {
          handleError(error);
        } finally {
          markPageReady("Ready.", loadingToken);
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

  if (elements.minecraftVersionSelect) {
    elements.minecraftVersionSelect.addEventListener("change", () => {
      saveConfig();
      renderMinecraftOptions(state.lastStatus);
    });
  }

  if (elements.refreshMinecraftVersions) {
    elements.refreshMinecraftVersions.addEventListener("click", async () => {
      if (state.isBusy) {
        return;
      }
      const loadingToken = setPageLoading("Refreshing Minecraft versions...");
      try {
        setBusy(true);
        await refreshMinecraftVersions();
      } catch (error) {
        handleError(error);
        renderMinecraftOptions(state.lastStatus);
      } finally {
        setBusy(false);
        markPageReady("Ready.", loadingToken);
      }
    });
  }

  if (elements.hardwareSelect) {
    elements.hardwareSelect.addEventListener("change", async () => {
      const loadingToken = setPageLoading("Loading selected hardware status...");
      resetGpuAvailabilityScan();
      resetGpuCapacityProbeButton();
      try {
        setBusy(true);
        if (state.user) {
          await refreshHardwareOptions({ silent: false });
        } else {
          renderZoneOptions();
        }
        await refreshPriceEstimate({ silent: false });
        await refreshStatus({ silent: true });
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
        markPageReady("Ready.", loadingToken);
      }
    });
  }

  if (elements.zoneSelect) {
    elements.zoneSelect.addEventListener("change", async () => {
      const loadingToken = setPageLoading("Loading selected zone status...");
      resetGpuCapacityProbeButton();
      saveConfig();
      renderTargetSummary();
      renderHardwarePriceEstimate(selectedPriceEstimate());
      updateActionAvailability();
      try {
        setBusy(true);
        if (state.user) {
          await refreshPriceEstimate({ silent: false });
          await refreshStatus({ silent: true });
        }
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
        markPageReady("Ready.", loadingToken);
      }
    });
  }

  if (elements.refreshHardware) {
    elements.refreshHardware.addEventListener("click", async () => {
      const restoringZones = Boolean(activeGpuAvailabilityScan(selectedHardwareProfile()));
      const loadingToken = setPageLoading(restoringZones ? "Restoring compatible GPU zones..." : "Scanning GPU capacity across all compatible zones...");
      try {
        setBusy(true);
        await scanGpuAvailabilityAcrossZones();
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
        markPageReady("Ready.", loadingToken);
      }
    });
  }

  if (elements.checkGpuCapacity) {
    elements.checkGpuCapacity.addEventListener("click", checkGpuCapacity);
  }

  if (elements.cancelGpuScan) {
    elements.cancelGpuScan.addEventListener("click", cancelGpuAvailabilityScan);
  }

  if (elements.releaseGpuCapacity) {
    elements.releaseGpuCapacity.addEventListener("click", releaseGpuCapacityReservations);
  }

  if (elements.refreshInstances) {
    elements.refreshInstances.addEventListener("click", async () => {
      const loadingToken = setPageLoading("Refreshing created instances...");
      try {
        setBusy(true);
        await refreshInstances({ silent: false, autoSelect: true });
        setBanner("Created instances refreshed.", "success");
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
        markPageReady("Ready.", loadingToken);
      }
    });
  }

  if (elements.instancesList) {
    elements.instancesList.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-instance-index]");
      if (!button || state.isBusy) {
        return;
      }
      const loadingToken = setPageLoading("Loading selected instance status...");
      try {
        setBusy(true);
        await selectCreatedInstance(Number(button.dataset.instanceIndex));
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
        markPageReady("Ready.", loadingToken);
      }
    });
  }

  async function boot() {
    setPageLoading("Preparing page components...");
    try {
      loadConfig();
      setBusy(false);
      if (!state.backendUrl) {
        return;
      }
      setBusy(true);
      await connectBackend({ silent: true });
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
      markPageReady("Ready.");
    }
  }

  boot();
})();
