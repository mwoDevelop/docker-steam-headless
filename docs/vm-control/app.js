(function () {
  const defaultBackendUrl = "https://steam-vm-control-api-w2urpq2xlq-lm.a.run.app";
  const defaultAutoStopHours = "3";
  const scanCreateUrlParams = new URLSearchParams(window.location.search);

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
  const PASSIVE_STATUS_ACTIVE_INTERVAL_MS = 5000;
  const PASSIVE_STATUS_IDLE_INTERVAL_MS = 15000;
  const GPU_SCAN_CANCEL_CLEANUP_DELAYS_MS = [10000, 60000];
  const actionStatusChannel = typeof BroadcastChannel === "function"
    ? new BroadcastChannel("vm-control-action-status")
    : null;
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
  const COMMAND_POWER_ACTION_TRANSITIONS = {
    create: { action: "create", phase: "requested", label: "Create requested" },
    start: { action: "start", phase: "requested", label: "Start requested" },
    restart: { action: "restart", phase: "requested", label: "Restart requested" },
    stop: { action: "stop", phase: "requested", label: "Stop requested" },
    delete: { action: "delete", phase: "requested", label: "Delete requested" },
    "create-backup": { action: "create-backup", phase: "requested", label: "Backup requested" },
    "restore-backup": { action: "restore-backup", phase: "requested", label: "Restore requested" },
    "remove-backup": { action: "remove-backup", phase: "requested", label: "Backup removal requested" },
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
    "install-minecraft",
    "start-minecraft",
    "stop-minecraft",
    "restart-minecraft",
    "remove-minecraft",
  ]);
  const embeddedVmControl = Boolean(document.querySelector("[data-vm-control-embedded]"));

  const elements = {
    backendUrl: document.querySelector("#backend-url"),
    connect: document.querySelector("#connect"),
    pageLoader: document.querySelector("#page-loader"),
    pageLoaderMessage: document.querySelector("#page-loader-message"),
    pageLoaderOperationProgress: document.querySelector("#page-loader-operation-progress"),
    appShell: document.querySelector("#app-shell"),
    authStatus: document.querySelector("#auth-status"),
    googleSignIn: document.querySelector("#google-sign-in"),
    signOut: document.querySelector("#sign-out"),
    targetSummary: document.querySelector("#target-summary"),
    refreshStatus: document.querySelector("#refresh-status"),
    endpointSelect: document.querySelector("#endpoint-select"),
    endpointStatus: document.querySelector("#endpoint-status"),
    hardwareSelect: document.querySelector("#hardware-select"),
    hardwarePicker: document.querySelector("#hardware-picker"),
    zoneSelect: document.querySelector("#zone-select"),
    gpuScanScope: document.querySelector("#gpu-scan-scope"),
    gpuScanProfiles: document.querySelector("#hardware-picker-options"),
    scanCreateResults: document.querySelector("#scan-create-results"),
    pageLoaderScanResults: document.querySelector("#page-loader-scan-results"),
    gpuScanProfilesSummary: document.querySelector("#hardware-picker-summary"),
    refreshHardware: document.querySelector("#refresh-hardware"),
    scanSelectedGpu: document.querySelector("#scan-selected-gpu"),
    scanAllGpuZones: document.querySelector("#scan-all-gpu-zones"),
    pauseGpuScan: document.querySelector("#pause-gpu-scan"),
    cancelGpuScan: document.querySelector("#cancel-gpu-scan"),
    autoCreateFirstGpu: document.querySelector("#auto-create-first-gpu"),
    startSelectedFirstGpu: document.querySelector("#start-selected-first-gpu"),
    hardwareOptionsStatus: document.querySelector("#hardware-options-status"),
    hardwarePriceEstimate: document.querySelector("#hardware-price-estimate"),
    refreshInstances: document.querySelector("#refresh-instances"),
    instancesList: document.querySelector("#instances-list"),
    instancesStatus: document.querySelector("#instances-status"),
    autoStopHours: document.querySelector("#auto-stop-hours"),
    autoStopStatus: document.querySelector("#auto-stop-status"),
    backupSelect: document.querySelector("#backup-select"),
    backupOptionsStatus: document.querySelector("#backup-options-status"),
    minecraftAddress: document.querySelector("#minecraft-address"),
    minecraftVersionSelect: document.querySelector("#minecraft-version-select"),
    minecraftServerTypeSelect: document.querySelector("#minecraft-server-type-select"),
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
    gpuScanProfileIds: [],
    gpuScanProfilesCustomized: false,
    visibleHardwareProfiles: [],
    allGpuZoneAvailabilityScan: null,
    allGpuZoneAvailabilityScanRun: null,
    googleInitializedFor: "",
    googleTokenClient: null,
    googleTokenRefreshHandlers: null,
    googleTokenRefreshPromise: null,
    token: "",
    tokenExpiresAt: 0,
    user: null,
    selectedEndpointId: "",
    endpointSelectionLocked: false,
    lastStatus: null,
    lastStatusTargetKey: "",
    hardwarePayload: null,
    instancesPayload: null,
    priceEstimates: {},
    isBusy: false,
    pendingMinecraftServerType: "",
    activeCommand: "",
    commandStatusRefreshTimer: null,
    history: [],
    isPageLoading: true,
    pageLoadingToken: 0,
    operationProgressCommand: "",
    scanCreateResultRun: null,
    activeHeldGpuWorkflow: null,
    startScanSourceInstanceName: "",
    scrolledInitialHash: "",
    passiveStatusTimer: null,
    passiveStatusRefreshRunning: false,
  };

  function broadcastActionStatus(type, command) {
    if (!actionStatusChannel) return;
    actionStatusChannel.postMessage({
      type,
      command: String(command || ""),
      targetKey: selectedTargetKey(),
      at: Date.now(),
    });
  }

  function schedulePassiveStatusRefresh(delayMs) {
    if (state.passiveStatusTimer) {
      window.clearTimeout(state.passiveStatusTimer);
    }
    state.passiveStatusTimer = window.setTimeout(runPassiveStatusRefresh, delayMs);
  }

  async function runPassiveStatusRefresh() {
    state.passiveStatusTimer = null;
    if (!state.user || state.isBusy || state.isPageLoading || document.visibilityState !== "visible" || state.passiveStatusRefreshRunning) {
      schedulePassiveStatusRefresh(PASSIVE_STATUS_IDLE_INTERVAL_MS);
      return;
    }
    state.passiveStatusRefreshRunning = true;
    let active = false;
    try {
      const payload = await refreshStatus({ silent: true, forceRender: true, refreshInstances: false });
      active = Boolean(payload && isTransitionalStatus(payload));
      if (active && !state.activeCommand) {
        const action = String(payload.powerAction && payload.powerAction.action || "VM action");
        setCommandStatus(statusBannerMessage(`${action} is still running`, payload), "warning");
        renderOperationProgress(action, payload);
      }
    } catch (error) {
      console.warn("Passive VM status refresh failed.", error);
    } finally {
      state.passiveStatusRefreshRunning = false;
      schedulePassiveStatusRefresh(active ? PASSIVE_STATUS_ACTIVE_INTERVAL_MS : PASSIVE_STATUS_IDLE_INTERVAL_MS);
    }
  }

  if (actionStatusChannel) {
    actionStatusChannel.addEventListener("message", (event) => {
      if (!event.data || event.data.targetKey !== selectedTargetKey()) return;
      schedulePassiveStatusRefresh(250);
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      schedulePassiveStatusRefresh(250);
    }
  });

  function setPageLoading(message) {
    state.pageLoadingToken += 1;
    state.isPageLoading = true;
    clearOperationProgress();
    if (!embeddedVmControl) {
      document.body.classList.add("is-page-loading");
    }
    if (!elements.pageLoader) {
      return;
    }
    if (embeddedVmControl) {
      elements.pageLoader.classList.add("is-active");
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
    // Embedded administrator controls can finish their own asynchronous
    // session refresh while a VM command is still polling. A tokenless
    // completion must never hide the loader owned by that command.
    if (!token && state.activeCommand) {
      return;
    }
    if (token && token !== state.pageLoadingToken) {
      return;
    }
    state.isPageLoading = false;
    if (!embeddedVmControl) {
      document.body.classList.add("is-page-ready");
    }
    if (elements.pageLoaderMessage && message) {
      elements.pageLoaderMessage.textContent = message;
    }
    if (elements.appShell) {
      elements.appShell.setAttribute("aria-busy", "false");
    }
    if (!elements.pageLoader) {
      if (!embeddedVmControl) {
        document.body.classList.remove("is-page-loading");
      }
      return;
    }
    elements.pageLoader.setAttribute("aria-busy", "false");
    if (!embeddedVmControl) {
      document.body.classList.remove("is-page-loading");
    }
    window.setTimeout(() => {
      if (!state.isPageLoading) {
        if (embeddedVmControl) {
          elements.pageLoader.classList.remove("is-active");
        }
        elements.pageLoader.hidden = true;
        clearOperationProgress();
      }
    }, 220);
  }

  function loadConfig() {
    const saved = JSON.parse(window.localStorage.getItem(storageKeys.config) || "{}");
    const scanCreateEndpointId = String(scanCreateUrlParams.get("endpointId") || "").trim();
    const scanCreateHardwareId = String(scanCreateUrlParams.get("hardwareId") || "").trim();
    const scanCreateZone = String(scanCreateUrlParams.get("zone") || "").trim();
    const scanCreateToken = String(scanCreateUrlParams.get("scanCreateToken") || "").trim();
    state.scanCreatePreparation = scanCreateToken && scanCreateEndpointId && scanCreateHardwareId && scanCreateZone
      ? { endpointId: scanCreateEndpointId, hardwareId: scanCreateHardwareId, zone: scanCreateZone, token: scanCreateToken }
      : null;
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
    if (elements.hardwareSelect && (scanCreateHardwareId || saved.hardwareId)) {
      elements.hardwareSelect.dataset.savedValue = scanCreateHardwareId || String(saved.hardwareId);
    }
    if (elements.endpointSelect && (scanCreateEndpointId || saved.endpointId)) {
      state.selectedEndpointId = scanCreateEndpointId || String(saved.endpointId);
      state.endpointSelectionLocked = true;
      elements.endpointSelect.dataset.savedValue = state.selectedEndpointId;
    }
    if (elements.zoneSelect && scanCreateZone) {
      elements.zoneSelect.dataset.savedValue = scanCreateZone;
    }
    if (elements.minecraftVersionSelect && saved.minecraftVersion) {
      elements.minecraftVersionSelect.dataset.savedValue = String(saved.minecraftVersion);
    }
    if (elements.minecraftServerTypeSelect && saved.minecraftServerType) {
      elements.minecraftServerTypeSelect.dataset.savedValue = String(saved.minecraftServerType);
    }
    renderHistory();
    renderTargetSummary();
    renderBackupOptions(null);
    renderMinecraftOptions(null);
    renderHardwareOptions(null);
    renderInstanceOptions(null);
    renderAccess(null);
    updateAuthUi();
  }

  function requestAdminSessionFromOpener() {
    if (state.token || !window.opener) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (received) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", receiveSession);
        resolve(received);
      };
      const receiveSession = (event) => {
        if (event.origin !== window.location.origin || event.data?.type !== adminSessionResponse) return;
        const token = String(event.data?.token || "");
        if (!token) return;
        storeSessionToken(token);
        finish(true);
      };
      window.addEventListener("message", receiveSession);
      window.opener.postMessage({ type: adminSessionRequest }, window.location.origin);
      window.setTimeout(() => finish(false), 1000);
    });
  }

  function saveConfig() {
    state.backendUrl = sanitizeBackendUrl(elements.backendUrl.value);
    window.localStorage.setItem(
      storageKeys.config,
      JSON.stringify({
        backendUrl: state.backendUrl,
        autoStopHours: String(elements.autoStopHours.value || "").trim(),
        endpointId: selectedEndpointId(),
        hardwareId: String(elements.hardwareSelect && elements.hardwareSelect.value || "").trim(),
        zone: String(elements.zoneSelect && elements.zoneSelect.value || "").trim(),
        minecraftVersion: String(elements.minecraftVersionSelect && elements.minecraftVersionSelect.value || "").trim(),
        minecraftServerType: String(elements.minecraftServerTypeSelect && elements.minecraftServerTypeSelect.value || "").trim(),
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
    if (!embeddedVmControl) {
      elements.connect.disabled = nextBusy;
      elements.googleSignIn.disabled = nextBusy || !state.backendConfig;
    }
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

    const selectedProfile = selectedHardwareProfile();
    const profileSupportsCreate = hardwareProfileSupported(selectedProfile);
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
    if (elements.endpointSelect) {
      elements.endpointSelect.disabled = state.isBusy || !state.user || !state.backendConfig;
    }
    if (elements.zoneSelect) {
      elements.zoneSelect.disabled = state.isBusy || !state.user || !selectedHardwareProfile();
    }
    const canEditAutoStop = allowed.has("start") || (allowed.has("create") && profileSupportsCreate) || allowed.has("set-auto-stop");
    elements.autoStopHours.disabled = state.isBusy || !state.user || !canEditAutoStop;
    if (elements.backupSelect) {
      const hasBackups = getAvailableBackups(state.lastStatus).length > 0;
      const canUseBackupSelection = allowed.has("restore-backup") || allowed.has("remove-backup");
      elements.backupSelect.disabled = state.isBusy || !state.user || !canUseBackupSelection || !hasBackups;
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
      && profileSupportsCreate
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
      const needsMinecraftState = isMinecraftCommand(command);
      const hasSelectedBackup = Boolean(elements.backupSelect && elements.backupSelect.value);
      button.disabled = !state.user
        || (command !== "status" && (
          state.isBusy
          || !allowed.has(command)
          || (command === "create" && !profileSupportsCreate)
          || (command === "create" && !selectedZone())
          || (needsBackup && !hasSelectedBackup)
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
      return keep(["status", "create", "delete"]);
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
    if (data && data.instanceExists === false && !isTransitionalStatus(data)) {
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
          if (!data) {
            return;
          }
          // The command request can take longer than the first background
          // refresh. Keep its progress message until it returns instead of
          // presenting an older pre-create/pre-delete status as final.
          if (String(state.activeCommand || "") === command) {
            if (state.isPageLoading && state.user && generation === state.commandStatusRefreshGeneration) {
              schedulePostCommandStatusRefresh(command, generation);
            }
            return;
          }
          const stillUpdating = isTransitionalStatus(data);
          setCommandStatus(
            statusBannerMessage(stillUpdating ? `Command "${command}" still updating` : `Command "${command}" status refreshed`, data),
            stillUpdating ? "warning" : statusMessageTone(data),
          );
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
    if (embeddedVmControl) {
      renderTargetSummary();
      updateActionAvailability();
      return;
    }
    elements.googleSignIn.classList.toggle("hidden", Boolean(state.user));
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

  function migrateHistoryDuckDnsDomains(domains) {
    const activeDomains = Array.isArray(domains)
      ? domains.map((domain) => String(domain || "").trim()).filter(Boolean)
      : [];
    if (!activeDomains.length || !state.history.length) return;

    const activeDomainsKey = JSON.stringify(activeDomains);
    let changed = false;
    state.history = state.history.map((entry) => {
      if (!entry || !Array.isArray(entry.duckdnsDomains) || !entry.duckdnsDomains.length) {
        return entry;
      }
      if (JSON.stringify(entry.duckdnsDomains) === activeDomainsKey) {
        return entry;
      }
      changed = true;
      return { ...entry, duckdnsDomains: [...activeDomains] };
    });
    if (changed) {
      saveHistory();
      renderHistory();
    }
  }

  function renderHistory() {
    if (!elements.history) {
      return;
    }

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

  function getHardwareProfiles() {
    const profiles = state.hardwarePayload && Array.isArray(state.hardwarePayload.profiles)
      ? state.hardwarePayload.profiles
      : [];
    return profiles.filter((profile) => profile && profile.id && Array.isArray(profile.zones));
  }

  function hardwareProfileSupported(profile) {
    return Boolean(profile) && profile.supported !== false;
  }

  function sunshineCompatibility(profile) {
    const compatibility = profile && profile.sunshineCompatibility && typeof profile.sunshineCompatibility === "object"
      ? profile.sunshineCompatibility
      : {};
    const state = String(compatibility.state || "untested").trim().toLowerCase();
    const labels = {
      verified: "Tested: works",
      incompatible: "Tested: fails",
      untested: "Not tested",
    };
    return {
      state: Object.prototype.hasOwnProperty.call(labels, state) ? state : "untested",
      label: String(compatibility.label || labels[state] || labels.untested),
      detail: String(compatibility.detail || ""),
    };
  }

  function selectedHardwareProfile() {
    const selectedId = String(elements.hardwareSelect && elements.hardwareSelect.value || "").trim();
    return getHardwareProfiles().find((profile) => String(profile.id) === selectedId) || null;
  }

  function selectedZone() {
    return String(elements.zoneSelect && elements.zoneSelect.value || "").trim();
  }

  function getEndpoints() {
    const endpoints = state.backendConfig && Array.isArray(state.backendConfig.endpoints)
      ? state.backendConfig.endpoints
      : [];
    return endpoints.filter((endpoint) => endpoint && endpoint.id && endpoint.domain);
  }

  function selectedEndpointId() {
    return String(state.selectedEndpointId || elements.endpointSelect && elements.endpointSelect.value || "mwo-vm1").trim() || "mwo-vm1";
  }

  function selectedEndpoint() {
    return getEndpoints().find((endpoint) => String(endpoint.id) === selectedEndpointId()) || null;
  }

  function endpointForInstance(instance) {
    const name = String(instance && instance.name || "").trim();
    return getEndpoints().find((endpoint) => String(endpoint.instanceName || "").trim() === name) || null;
  }

  function renderEndpointStatus() {
    if (!elements.endpointStatus) {
      return;
    }
    const endpoint = selectedEndpoint();
    if (!endpoint) {
      elements.endpointStatus.textContent = "Sign in to load public VM endpoints.";
      return;
    }
    const ip = String(endpoint.staticIp || "").trim();
    const region = String(endpoint.region || "").trim();
    const vm = String(endpoint.instanceName || "").trim();
    const details = [ip ? `static IP ${ip}` : "IP will be reserved on first Create", region, vm ? `VM ${vm}` : "no VM created"]
      .filter(Boolean)
      .join(" · ");
    elements.endpointStatus.textContent = `${endpoint.domain} · ${details}.`;
  }

  function renderEndpointOptions(config) {
    if (!elements.endpointSelect) {
      return;
    }
    const endpoints = config && Array.isArray(config.endpoints) ? config.endpoints : [];
    const previous = state.selectedEndpointId
      || elements.endpointSelect.value
      || elements.endpointSelect.dataset.savedValue
      || "mwo-vm1";
    elements.endpointSelect.innerHTML = endpoints.length
      ? endpoints.map((endpoint) => {
        const id = String(endpoint.id || "");
        const domain = String(endpoint.domain || "");
        const assigned = endpoint.instanceName ? ` · ${endpoint.instanceName}` : "";
        return `<option value="${escapeHtml(id)}">${escapeHtml(id)} · ${escapeHtml(domain)}${escapeHtml(assigned)}</option>`;
      }).join("")
      : '<option value="">No endpoints configured</option>';
    if (endpoints.some((endpoint) => String(endpoint.id) === previous)) {
      elements.endpointSelect.value = previous;
    }
    state.selectedEndpointId = String(elements.endpointSelect.value || "").trim();
    elements.endpointSelect.dataset.savedValue = "";
    renderEndpointStatus();
  }

  function applySelectedEndpoint() {
    const endpoint = selectedEndpoint();
    if (!endpoint) {
      return;
    }
    const endpointHardware = endpoint && typeof endpoint.hardware === "object" ? endpoint.hardware : {};
    const profile = getHardwareProfiles().find((item) => String(item.id) === String(endpoint.hardwareId || endpointHardware.id || ""));
    if (profile && elements.hardwareSelect) {
      elements.hardwareSelect.value = String(profile.id || "");
      const zone = String(endpoint.zone || "").trim();
      if (zone && elements.zoneSelect) {
        elements.zoneSelect.dataset.savedValue = zone;
      }
      renderZoneOptions();
    }
    renderEndpointStatus();
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

  function selectedGpuScanScope() {
    return String(elements.gpuScanScope && elements.gpuScanScope.value || "europe");
  }

  function gpuScanScopeLabel(scope = selectedGpuScanScope()) {
    return ({
      all: "all regions",
      europe: "Europe",
      americas: "Americas",
      "asia-pacific": "Asia Pacific",
      "middle-east": "Middle East",
      africa: "Africa",
    })[scope] || "all regions";
  }

  function gpuScanScopePrefixes(scope = selectedGpuScanScope()) {
    return ({
      all: [],
      europe: ["europe-"],
      americas: ["us-", "northamerica-", "southamerica-"],
      "asia-pacific": ["asia-", "australia-"],
      "middle-east": ["me-"],
      africa: ["africa-"],
    })[scope] || [];
  }

  function zonesForGpuScanScope(zones, scope = selectedGpuScanScope()) {
    const prefixes = gpuScanScopePrefixes(scope);
    return prefixes.length
      ? zones.filter((zone) => prefixes.some((prefix) => zone.startsWith(prefix)))
      : zones;
  }

  function eligibleGpuScanProfiles() {
    return getHardwareProfiles().filter((profile) => (
      hardwareProfileSupported(profile)
      && Number(profile.gpuCount || 0) > 0
      && String(profile.gpuType || "").trim()
      && Array.isArray(profile.zones)
      && profile.zones.length
    ));
  }

  function selectedGpuScanProfiles() {
    if (startSelectedVmScanEnabled()) {
      const source = selectedStartScanSource();
      const sourceHardwareId = String(source && source.hardware && source.hardware.id || "");
      return eligibleGpuScanProfiles().filter((profile) => String(profile.id) === sourceHardwareId);
    }
    const selectedIds = new Set(state.gpuScanProfileIds.map((id) => String(id)));
    return eligibleGpuScanProfiles().filter((profile) => selectedIds.has(String(profile.id)));
  }

  function gpuScanTargetCount(profiles = selectedGpuScanProfiles(), scope = selectedGpuScanScope()) {
    return profiles.reduce((total, profile) => total + zonesForGpuScanScope(profile.zones || [], scope).length, 0);
  }

  function renderGpuScanProfileOptions(profiles = state.visibleHardwareProfiles) {
    if (!elements.gpuScanProfiles) {
      return;
    }
    const visibleProfiles = Array.isArray(profiles) && profiles.length ? profiles : getHardwareProfiles();
    const gpuProfiles = eligibleGpuScanProfiles();
    const allowedIds = new Set(gpuProfiles.map((profile) => String(profile.id)));
    if (!state.gpuScanProfilesCustomized) {
      const selectedProfile = selectedHardwareProfile();
      state.gpuScanProfileIds = selectedProfile && allowedIds.has(String(selectedProfile.id))
        ? [String(selectedProfile.id)]
        : [];
    } else {
      state.gpuScanProfileIds = state.gpuScanProfileIds.filter((id) => allowedIds.has(String(id)));
    }
    const selectedIds = new Set(state.gpuScanProfileIds.map((id) => String(id)));
    const selectedHardwareId = String(elements.hardwareSelect && elements.hardwareSelect.value || "");
    const zone = selectedZone();
    elements.gpuScanProfiles.innerHTML = visibleProfiles.length
      ? visibleProfiles.map((profile) => {
        const id = String(profile.id);
        const gpuCount = Number(profile.gpuCount || 0);
        const vram = Number(profile.vramGb || 0) > 0 ? `, ${Number(profile.vramGb)} GB VRAM` : "";
        const compatibility = sunshineCompatibility(profile);
        const compatibilityLabel = gpuCount > 0 ? ` [Sunshine: ${compatibility.label}]` : "";
        const price = gpuCount > 0 && profile.priceEstimate && profile.priceEstimate.display ? ` - ${profile.priceEstimate.display}` : "";
        const unavailable = !hardwareProfileSupported(profile)
          ? ` - Create unavailable: ${String(profile.unavailableReason || "unsupported by this VM stack")}`
          : "";
        const zoneUnavailable = gpuCount > 0 && zone && !profile.zones.includes(zone);
        const label = `${String(profile.label || id)}${compatibilityLabel}${price} (${gpuCount > 0 ? `${String(profile.gpuType || id)}${vram}, ${profile.machineType || "machine"}, ${profile.zones.length} zones` : String(profile.machineType || "machine")})${unavailable}`;
        const scanToggle = allowedIds.has(id)
          ? `<label class="hardware-picker-scan-toggle" title="Include this GPU in the geographic capacity scan"><input type="checkbox" value="${escapeHtml(id)}" ${selectedIds.has(id) ? "checked" : ""}><span>Scan</span></label>`
          : "";
        return `<div class="hardware-picker-option"><button type="button" class="hardware-picker-select sunshine-${escapeHtml(compatibility.state)}${String(selectedHardwareId) === id ? " is-selected" : ""}${zoneUnavailable ? " is-zone-unavailable" : ""}" data-hardware-select="${escapeHtml(id)}">${escapeHtml(label)}${zoneUnavailable ? " [Zone: unavailable]" : ""}</button>${scanToggle}</div>`;
      }).join("")
      : "<span>No GPU profiles are configured for the capacity scan.</span>";
    const selectedProfiles = selectedGpuScanProfiles();
    const targetCount = gpuScanTargetCount(selectedProfiles);
    if (elements.gpuScanProfilesSummary) {
      const primaryLabel = selectedHardwareProfile() ? String(selectedHardwareProfile().label || selectedHardwareProfile().id) : "Select hardware";
      const scanLabels = selectedProfiles.map((profile) => String(profile.label || profile.id));
      elements.gpuScanProfilesSummary.textContent = scanLabels.length
        ? `${primaryLabel} · scan: ${scanLabels.join(", ")} (${targetCount} tests)`
        : `${primaryLabel} · no GPU scan profile selected`;
    }
  }

  function activeGpuAvailabilityScan(profile) {
    const scan = state.gpuAvailabilityScan;
    if (!scan || !profile || String(scan.scope || "all") !== selectedGpuScanScope()) {
      return null;
    }
    if (Array.isArray(scan.hardwareIds) && scan.hardwareIds.includes(String(profile.id))) {
      return {
        ...scan,
        availableZones: (scan.availableZonesByHardwareId || {})[String(profile.id)] || [],
      };
    }
    return String(scan.hardwareId) === String(profile.id) ? scan : null;
  }

  function activeSelectedZoneGpuAvailabilityScan(zone) {
    const scan = state.selectedZoneGpuAvailabilityScan;
    return scan && String(scan.zone) === String(zone) ? scan : null;
  }

  function resetGpuAvailabilityScan() {
    state.gpuAvailabilityScan = null;
  }

  function resetSelectedZoneGpuAvailabilityScan() {
    state.selectedZoneGpuAvailabilityScan = null;
  }

  function resetAllGpuZoneAvailabilityScan() {
    state.allGpuZoneAvailabilityScan = null;
  }

  function activeAllGpuZoneAvailabilityScan() {
    return state.allGpuZoneAvailabilityScan;
  }

  function updateGpuAvailabilityScanButton() {
    const run = state.gpuAvailabilityScanRun || state.selectedZoneGpuAvailabilityScanRun || state.allGpuZoneAvailabilityScanRun;
    const running = Boolean(run && !run.finished);
    const runningZoneCatalogScan = Boolean(state.selectedZoneGpuAvailabilityScanRun && !state.selectedZoneGpuAvailabilityScanRun.finished);
    const runningAllGpuZoneScan = Boolean(state.allGpuZoneAvailabilityScanRun && !state.allGpuZoneAvailabilityScanRun.finished);
    const profile = selectedHardwareProfile();
    const scanProfiles = selectedGpuScanProfiles();
    const scanTargetCount = gpuScanTargetCount(scanProfiles);
    const isFiltered = Boolean(state.gpuAvailabilityScan);
    const selectedZoneGpuScan = activeSelectedZoneGpuAvailabilityScan(selectedZone());
    const scope = selectedGpuScanScope();
    const scopeLabel = gpuScanScopeLabel(scope);
    const scanLabel = !scanProfiles.length
      ? "Select GPUs to scan capacity"
      : scope === "all"
        ? `Scan ${scanProfiles.length === 1 ? "Selected GPU" : "Selected GPUs"} Across Compatible Zones`
        : `Scan ${scanProfiles.length === 1 ? "Selected GPU" : "Selected GPUs"} in ${scopeLabel}`;
    if (elements.refreshHardware) {
      elements.refreshHardware.textContent = state.gpuAvailabilityScanRun && !state.gpuAvailabilityScanRun.finished
        ? scope === "all" ? "Scanning Selected GPUs Across Compatible Zones..." : `Scanning Selected GPUs in ${scopeLabel}...`
        : isFiltered ? "Show All Compatible GPU Zones" : scanLabel;
      elements.refreshHardware.title = isFiltered
        ? "Restore all zones compatible with the scanned GPU profiles"
        : scanProfiles.length
          ? `Temporarily test ${scanTargetCount} selected GPU-zone combination${scanTargetCount === 1 ? "" : "s"}`
          : "Select one or more GPU hardware profiles to scan capacity";
      elements.refreshHardware.disabled = state.isBusy || !state.user || !scanProfiles.length || running;
    }
    if (elements.gpuScanScope) {
      elements.gpuScanScope.disabled = state.isBusy || !state.user || running;
    }
    if (elements.autoCreateFirstGpu) {
      elements.autoCreateFirstGpu.disabled = state.isBusy || !state.user || running;
    }
    const startSource = selectedStartScanSource();
    if (elements.startSelectedFirstGpu) {
      const eligible = Boolean(startSource && String(startSource.status || "").toUpperCase() === "TERMINATED" && Number(startSource.hardware && startSource.hardware.gpuCount || 0) > 0);
      elements.startSelectedFirstGpu.disabled = state.isBusy || !state.user || running || !eligible;
      if (!eligible) elements.startSelectedFirstGpu.checked = false;
    }
    if (elements.gpuScanProfiles) {
      elements.gpuScanProfiles.querySelectorAll("input, [data-hardware-select]").forEach((input) => {
        input.disabled = state.isBusy || !state.user || running || startSelectedVmScanEnabled();
      });
    }
    if (elements.scanSelectedGpu) {
      elements.scanSelectedGpu.textContent = runningZoneCatalogScan
        ? "Scanning GPUs in Selected Zone..."
        : selectedZoneGpuScan ? "Show All GPUs in Selected Zone" : "Scan All GPUs in Selected Zone";
      elements.scanSelectedGpu.disabled = state.isBusy || !state.user || !selectedZone() || running || startSelectedVmScanEnabled();
      elements.scanSelectedGpu.title = selectedZoneGpuScan
        ? "Restore every known GPU profile for the selected zone"
        : "Temporarily test every known GPU profile in the selected zone without retaining reservations";
    }
    if (elements.scanAllGpuZones) {
      const globalScan = activeAllGpuZoneAvailabilityScan();
      elements.scanAllGpuZones.textContent = runningAllGpuZoneScan
        ? "Scanning All GPUs in All Zones..."
        : globalScan ? "Show All GPUs in All Zones" : "Scan All GPUs in All Zones";
      elements.scanAllGpuZones.disabled = state.isBusy || !state.user || running || startSelectedVmScanEnabled();
      elements.scanAllGpuZones.title = globalScan
        ? "Restore all configured GPU profiles and compatible zones"
        : "Temporarily test every configured GPU profile in every compatible zone without retaining reservations";
    }
    if (elements.pauseGpuScan) {
      const pausing = Boolean(run && run.pauseRequested && !run.paused);
      elements.pauseGpuScan.classList.toggle("hidden", !running);
      elements.pauseGpuScan.textContent = run && run.paused
        ? "Resume Scan and Release Reservations"
        : pausing
          ? "Pausing Scan and Releasing Reservations..."
          : "Pause Scan and Release Reservations";
      elements.pauseGpuScan.disabled = !running || Boolean(run && (run.cancelRequested || pausing));
    }
    if (elements.cancelGpuScan) {
      elements.cancelGpuScan.classList.toggle("hidden", !running);
      elements.cancelGpuScan.textContent = run && run.cancelRequested
        ? "Cancelling Scan and Releasing Reservations..."
        : "Cancel Scan and Release Reservations";
      elements.cancelGpuScan.disabled = !running || Boolean(run && run.cancelRequested);
    }
  }

  function renderGpuAvailabilityScanProgress(run) {
    if (!run) {
      return;
    }
    const completed = Number(run.completed || 0);
    const zoneCatalogScan = run.kind === "zone-gpus";
    const allGpuZoneScan = run.kind === "all-gpu-zones";
    const selectedGpuProfilesScan = run.kind === "selected-gpu-zones";
    const total = Number((allGpuZoneScan || selectedGpuProfilesScan)
      ? run.targets && run.targets.length
      : zoneCatalogScan ? run.profiles && run.profiles.length : run.zones && run.zones.length || 0);
    const available = Number((allGpuZoneScan || selectedGpuProfilesScan)
      ? run.availablePairCount
      : zoneCatalogScan ? run.availableHardwareIds && run.availableHardwareIds.length : run.availableZones && run.availableZones.length || 0);
    const current = (allGpuZoneScan || selectedGpuProfilesScan)
      ? run.currentTarget ? ` Current GPU: ${String(run.currentTarget.profile.label || run.currentTarget.profile.id || "GPU")} in ${zoneDisplayLabel(run.currentTarget.zone)}.` : ""
      : zoneCatalogScan
      ? run.currentProfile ? ` Current GPU: ${String(run.currentProfile.label || run.currentProfile.id || "GPU")}.` : ""
      : run.currentZone ? ` Current zone: ${zoneDisplayLabel(run.currentZone)}.` : "";
    const message = run.cancelRequested
      ? `Cancelling GPU capacity scan after the current request and releasing reservations. Checked ${completed}/${total} ${(allGpuZoneScan || selectedGpuProfilesScan) ? "GPU-zone combinations" : zoneCatalogScan ? "GPU profiles" : "zones"}.${current}`
      : run.paused
        ? `GPU capacity scan paused. Reservations were released. Checked ${completed}/${total} ${(allGpuZoneScan || selectedGpuProfilesScan) ? "GPU-zone combinations" : zoneCatalogScan ? "GPU profiles" : "zones"}. Resume to continue from the next item.`
        : run.pauseRequested
          ? `Pausing GPU capacity scan after the current request and releasing reservations. Checked ${completed}/${total} ${(allGpuZoneScan || selectedGpuProfilesScan) ? "GPU-zone combinations" : zoneCatalogScan ? "GPU profiles" : "zones"}.${current}`
      : allGpuZoneScan
        ? `Scanning all GPU capacity: ${completed}/${total} GPU-zone combinations checked, ${available} currently available.${current}`
        : selectedGpuProfilesScan
          ? `Scanning selected GPU capacity: ${completed}/${total} GPU-zone combinations checked, ${available} currently available.${current}`
        : zoneCatalogScan
        ? `Scanning GPU capacity in ${zoneDisplayLabel(run.zone)}: ${completed}/${total} GPU profiles checked, ${available} currently available.${current}`
        : `Scanning GPU capacity${run.scope && run.scope !== "all" ? ` in ${gpuScanScopeLabel(run.scope)}` : ""}: ${completed}/${total} zones checked, ${available} currently available.${current}`;
    if (elements.hardwareOptionsStatus) {
      elements.hardwareOptionsStatus.textContent = message;
    }
    if (elements.pageLoaderMessage && state.isPageLoading) {
      elements.pageLoaderMessage.textContent = message;
    }
  }

  function pauseGpuAvailabilityScan() {
    const run = state.gpuAvailabilityScanRun || state.selectedZoneGpuAvailabilityScanRun || state.allGpuZoneAvailabilityScanRun;
    if (!run || run.finished || run.cancelRequested) {
      return;
    }
    if (run.paused) {
      run.paused = false;
      run.pauseRequested = false;
      run.linksUnlocked = false;
      renderScanCreateResults(run);
      const resume = run.resume;
      run.resume = null;
      if (typeof resume === "function") {
        resume();
      }
      updateGpuAvailabilityScanButton();
      return;
    }
    run.pauseRequested = true;
    renderGpuAvailabilityScanProgress(run);
    updateGpuAvailabilityScanButton();
  }

  async function releaseReservationsAndWaitForGpuScanResume(run) {
    if (!run || (!run.pauseRequested && !run.cancelRequested)) {
      return;
    }
    const shouldPause = !run.cancelRequested;
    run.paused = shouldPause;
    run.currentZone = "";
    run.currentTarget = null;
    run.currentProfile = null;
    try {
      await fetchApi("/api/capacity-reservations/release", { method: "POST", body: "{}" });
    } catch (error) {
      run.cleanupFailures.push({ error: formatErrorMessage(error) });
    }
    const remaining = await refreshGpuCapacityReservationCount();
    run.linksUnlocked = remaining === 0;
    renderScanCreateResults(run);
    renderGpuAvailabilityScanProgress(run);
    updateGpuAvailabilityScanButton();
    if (!shouldPause) {
      return;
    }
    setBusy(false);
    await new Promise((resolve) => {
      run.resume = resolve;
    });
    if (!run.cancelRequested) {
      setBusy(true);
    }
  }

  function cancelGpuAvailabilityScan() {
    const run = state.gpuAvailabilityScanRun || state.selectedZoneGpuAvailabilityScanRun || state.allGpuZoneAvailabilityScanRun;
    if (!run || run.finished || run.cancelRequested) {
      return;
    }
    run.cancelRequested = true;
    run.pauseRequested = false;
    run.paused = false;
    run.currentZone = "";
    run.currentTarget = null;
    run.currentProfile = null;
    if (run.abortController && typeof run.abortController.abort === "function") {
      run.abortController.abort();
    }
    const resume = run.resume;
    run.resume = null;
    if (typeof resume === "function") {
      resume();
    }
    renderGpuAvailabilityScanProgress(run);
    updateGpuAvailabilityScanButton();
  }

  async function releaseCancelledGpuScanReservations(run) {
    let remaining = null;
    try {
      await fetchApi("/api/capacity-reservations/release", { method: "POST", body: "{}" });
    } catch (error) {
      run.cleanupFailures.push({ error: formatErrorMessage(error) });
    }
    try {
      remaining = await refreshGpuCapacityReservationCount();
    } catch (error) {
      run.cleanupFailures.push({ error: formatErrorMessage(error) });
    }
    GPU_SCAN_CANCEL_CLEANUP_DELAYS_MS.forEach((delayMs) => {
      window.setTimeout(async () => {
        try {
          await fetchApi("/api/capacity-reservations/release", { method: "POST", body: "{}" });
          await refreshGpuCapacityReservationCount();
        } catch (error) {
          console.warn("Deferred GPU scan cancellation cleanup failed.", error);
        }
      }, delayMs);
    });
    return remaining;
  }

  function gpuScanCompletionTone(run) {
    return run.cleanupFailures.length || run.cancelRequested ? "warning" : "success";
  }

  function autoCreateFirstAvailableGpuEnabled() {
    return Boolean(elements.autoCreateFirstGpu && elements.autoCreateFirstGpu.checked);
  }

  function selectedStartScanSource() {
    return getCreatedInstances().find((instance) => String(instance.name || "") === String(state.startScanSourceInstanceName || "")) || null;
  }

  function startSelectedVmScanEnabled() {
    return Boolean(elements.startSelectedFirstGpu && elements.startSelectedFirstGpu.checked && selectedStartScanSource());
  }

  function gpuScanRequestPayload(run, target) {
    if (!autoCreateFirstAvailableGpuEnabled()) {
      return target;
    }
    if (!run.scanId) {
      run.scanId = window.crypto && typeof window.crypto.randomUUID === "function"
        ? window.crypto.randomUUID()
        : `scan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
    const source = selectedStartScanSource();
    const operation = startSelectedVmScanEnabled() ? "start" : "create";
    return {
      ...target,
      holdForOperation: true,
      operation,
      sourceEndpointId: operation === "start" ? String(endpointForInstance(source) && endpointForInstance(source).id || "") : "",
      scanId: run.scanId,
    };
  }

  async function releaseHeldGpuWorkflow(workflowId, reason) {
    const data = await fetchApi("/api/gpu-workflows/release", {
      method: "POST",
      body: JSON.stringify({ workflowId, reason }),
    });
    await refreshGpuCapacityReservationCount();
    return data;
  }

  async function waitForHeldScanResume(run) {
    run.pauseRequested = true;
    run.paused = true;
    renderGpuAvailabilityScanProgress(run);
    updateGpuAvailabilityScanButton();
    setBusy(false);
    await new Promise((resolve) => {
      run.resume = resolve;
    });
    if (!run.cancelRequested) {
      setBusy(true);
    }
  }

  async function handleHeldGpuCapacity(run, prepared) {
    const workflowId = String(prepared && prepared.workflowId || "");
    const target = prepared && prepared.target ? prepared.target : null;
    if (!workflowId || !target || !prepared.preparationToken) {
      throw new Error("The backend returned an incomplete held GPU reservation.");
    }
    state.activeHeldGpuWorkflow = { workflowId, ...prepared };
    await refreshGpuCapacityReservationCount();
    renderGpuAvailabilityScanProgress(run);
    const operation = String(prepared.operation || "create");
    const choice = operation === "start"
      ? await selectReservedStart(target, prepared)
      : await selectPostCreateApplications(target, { heldWorkflow: prepared });
    const action = choice && choice.action ? choice.action : "pause";
    if (!["create", "start"].includes(action)) {
      setCommandStatus("Releasing the held GPU reservation before continuing...", "warning");
      await releaseHeldGpuWorkflow(workflowId, action);
      state.activeHeldGpuWorkflow = null;
      if (action === "cancel-scan") {
        run.cancelRequested = true;
        return "cancelled";
      }
      if (action === "pause") {
        await waitForHeldScanResume(run);
      }
      return "continue";
    }

    run.createStarted = true;
    const loadingToken = setPageLoading(`GPU reserved. ${operation === "start" ? "Starting" : "Creating"} ${String(target.hardwareId || "GPU")} VM in ${zoneDisplayLabel(target.zone)}...`);
    setBusy(true);
    setCommandStatus(`GPU capacity is held. Submitting ${operation === "start" ? "Start" : "Create"} against the reservation...`, "warning");
    try {
      const body = {
        command: operation,
        ...target,
        scanCreateToken: prepared.preparationToken,
        gpuWorkflowId: workflowId,
        applicationIds: operation === "create" ? choice.applicationIds || [] : undefined,
      };
      const autoStopHours = readAutoStopHours(operation);
      if (autoStopHours) body.autoStopHours = autoStopHours;
      if (operation === "start" && String(prepared.source && prepared.source.zone || "") !== String(target.zone || "")) {
        await fetchApi("/api/admin/migrations", {
          method: "POST",
          body: JSON.stringify({ action: "prepare", mode: "relocate-start", sourceEndpointId: String(prepared.source.endpointId || ""), targetEndpointId: String(prepared.source.endpointId || ""), targetZone: String(target.zone || ""), gpuWorkflowId: workflowId, scanCreateToken: prepared.preparationToken }),
        });
        const migrations = await fetchApi("/api/admin/migrations", { method: "GET" });
        const migration = (migrations.targets || []).find((item) => item.mode === "relocate-start" && item.gpuWorkflowId === workflowId && item.state === "prepared");
        if (!migration) throw new Error("Prepared relocation target was not returned by the backend.");
        await fetchApi("/api/admin/migrations", {
          method: "POST",
          body: JSON.stringify({ action: "start", migrationId: migration.id, gpuWorkflowId: workflowId, scanCreateToken: prepared.preparationToken }),
        });
        let relocationStatus = await refreshStatus({ silent: true, forceRender: true });
        relocationStatus = await waitForStatusSettled("start", relocationStatus);
        renderStatusPayload(relocationStatus);
        await refreshInstances({ silent: true, autoSelect: true });
        setCommandStatus(
          statusBannerMessage(`Reserved GPU VM relocated and started in ${zoneDisplayLabel(target.zone)}`, relocationStatus),
          statusMessageTone(relocationStatus),
        );
        return "created";
      }
      let data = await fetchApi("/api/command", { method: "POST", body: JSON.stringify(body) });
      renderStatusPayload(data);
      data = await waitForStatusSettled(operation, data);
      renderStatusPayload(data);
      await refreshInstances({ silent: true, autoSelect: true });
      setCommandStatus(commandCompletionMessage(operation, data), "success");
      setBanner(statusBannerMessage(`Reserved GPU VM ${operation === "start" ? "started" : "created"}`, data), "success");
      return "created";
    } catch (error) {
      const message = commandFailureMessage(operation, error);
      setCommandStatus(message, "error");
      setBanner(message, "error");
      return "failed";
    } finally {
      state.activeHeldGpuWorkflow = null;
      await refreshGpuCapacityReservationCount();
      markPageReady("Ready.", loadingToken);
    }
  }

  function selectReservedStart(target, prepared) {
    const dialog = document.querySelector("#start-reserved-dialog");
    const form = dialog && dialog.querySelector("form");
    const summary = document.querySelector("#start-reserved-summary");
    const confirm = document.querySelector("#start-reserved-confirm");
    if (!dialog || !form || !summary || !confirm) return Promise.resolve({ action: "pause" });
    const source = prepared.source || {};
    const relocation = String(source.zone || "") !== String(target.zone || "");
    summary.textContent = `${source.instanceName || "Selected VM"} · ${target.hardwareId} · ${zoneDisplayLabel(target.zone)}. ${relocation ? `The VM will be relocated from ${zoneDisplayLabel(source.zone)} before Start.` : "The VM will start in its current zone."} Reservation: ${prepared.reservation && prepared.reservation.name || prepared.workflowId}.`;
    confirm.textContent = relocation ? "Migrate and start reserved VM" : "Start reserved VM";
    return new Promise((resolve) => {
      const onClose = () => {
        dialog.removeEventListener("close", onClose);
        resolve({ action: dialog.returnValue || "pause", applicationIds: [] });
      };
      dialog.addEventListener("close", onClose);
      dialog.showModal();
    });
  }

  function selectedTargetParams() {
    const profile = selectedHardwareProfile();
    const zone = selectedZone();
    return targetParamsForHardwareProfile(profile, zone);
  }

  function targetParamsForHardwareProfile(profile, zone) {
    if (!profile || !zone) {
      return { endpointId: selectedEndpointId() };
    }
    const target = {
      endpointId: selectedEndpointId(),
      hardwareId: String(profile.id || ""),
      zone,
      machineType: String(profile.machineType || ""),
      gpuType: String(profile.gpuType || ""),
      gpuCount: Number(profile.gpuCount || 0),
      acceleratorMode: String(profile.acceleratorMode || "none"),
    };
    const preparation = state.scanCreatePreparation;
    if (preparation
      && preparation.endpointId === target.endpointId
      && preparation.hardwareId === target.hardwareId
      && preparation.zone === target.zone) {
      target.scanCreateToken = preparation.token;
    }
    return target;
  }

  function renderScanCreateResults(run) {
    const candidates = Array.isArray(run && run.scanCreateCandidates) ? run.scanCreateCandidates : [];
    const linksReady = Boolean(run && run.linksUnlocked);
    const containers = [elements.scanCreateResults, elements.pageLoaderScanResults].filter(Boolean);
    if (!containers.length) return;
    if (!candidates.length) {
      containers.forEach((container) => {
        container.hidden = true;
        container.innerHTML = "";
      });
      return;
    }
    const content = candidates.map((candidate) => {
      const profile = escapeHtml(String(candidate.hardwareLabel || "GPU"));
      const zone = escapeHtml(zoneDisplayLabel(String(candidate.zone || "")));
      if (candidate.error) {
        const retry = linksReady
          ? `<button class="action capacity-check" type="button" data-reserve-candidate="${candidate.index}">Retry reservation</button>`
          : "";
        return `<article class="scan-create-result" data-tone="warning"><strong>${profile} in ${zone}: capacity found</strong><span>${escapeHtml(candidate.error)}</span>${retry}</article>`;
      }
      const action = linksReady
        ? `<button class="action capacity-check" type="button" data-reserve-candidate="${candidate.index}">Reserve GPU</button>`
        : `<button class="action capacity-check" type="button" disabled>Pause scan before reserving</button>`;
      return `<article class="scan-create-result" data-links-ready="${linksReady ? "true" : "false"}"><strong>${profile} in ${zone}: capacity observed</strong><span>${candidate.operation === "start" ? "Reserve for selected VM Start" : "Reserve for Create"}</span>${action}</article>`;
    }).join("");
    containers.forEach((container) => {
      container.hidden = false;
      container.innerHTML = content;
    });
  }

  async function appendScanCreateCandidate(run, profile, zone) {
    if (!run || !profile || !zone) return;
    const candidate = {
      index: Array.isArray(run.scanCreateCandidates) ? run.scanCreateCandidates.length : 0,
      hardwareId: String(profile.id || ""),
      hardwareLabel: String(profile.label || profile.id || "GPU"),
      zone: String(zone),
      target: targetParamsForHardwareProfile(profile, zone),
      operation: startSelectedVmScanEnabled() ? "start" : "create",
      sourceEndpointId: startSelectedVmScanEnabled() ? String(endpointForInstance(selectedStartScanSource()) && endpointForInstance(selectedStartScanSource()).id || "") : "",
    };
    if (!Array.isArray(run.scanCreateCandidates)) run.scanCreateCandidates = [];
    run.scanCreateCandidates.push(candidate);
    renderScanCreateResults(run);
  }

  async function reserveScanCandidate(index) {
    const run = state.scanCreateResultRun;
    const candidate = run && Array.isArray(run.scanCreateCandidates) ? run.scanCreateCandidates[index] : null;
    if (!candidate || !run.linksUnlocked || state.isBusy) return;
    const loadingToken = setPageLoading(`Reserving ${candidate.hardwareLabel} in ${zoneDisplayLabel(candidate.zone)}...`);
    try {
      setBusy(true);
      candidate.error = "";
      const prepared = await fetchApi("/api/gpu-workflows/reserve", {
        method: "POST",
        body: JSON.stringify({ ...candidate.target, operation: candidate.operation, sourceEndpointId: candidate.sourceEndpointId, scanId: run.scanId || `manual-${Date.now()}` }),
      });
      if (!prepared.available || !prepared.heldForOperation) throw new Error(prepared.error || "GPU capacity is no longer available.");
      await handleHeldGpuCapacity(run, prepared);
    } catch (error) {
      candidate.error = formatErrorMessage(error);
      renderScanCreateResults(run);
      setCommandStatus(`GPU reservation failed: ${candidate.error}`, "error");
    } finally {
      setBusy(false);
      markPageReady("Ready.", loadingToken);
    }
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

  function updateHardwareZoneAvailability() {
    renderGpuScanProfileOptions();
  }

  function renderHardwareOptions(payload) {
    if (!elements.hardwareSelect || !elements.zoneSelect) {
      return;
    }

    state.hardwarePayload = payload || state.hardwarePayload;
    const allProfiles = getHardwareProfiles();
    if (!allProfiles.length) {
      state.visibleHardwareProfiles = [];
      elements.hardwareSelect.innerHTML = '<option value="">No hardware profiles loaded</option>';
      elements.zoneSelect.innerHTML = '<option value="">No zones loaded</option>';
      renderHardwarePriceEstimate(null);
      if (elements.hardwareOptionsStatus) {
        elements.hardwareOptionsStatus.textContent = "Sign in and refresh hardware to load Compute Engine availability.";
      }
      updateActionAvailability();
      return;
    }

    const zoneScan = activeSelectedZoneGpuAvailabilityScan(selectedZone());
    const globalScan = activeAllGpuZoneAvailabilityScan();
    let profiles = globalScan
      ? allProfiles.filter((profile) => (
        Number(profile.gpuCount || 0) <= 0
        || Object.prototype.hasOwnProperty.call(globalScan.availableZonesByHardwareId || {}, String(profile.id))
      ))
      : allProfiles;
    if (zoneScan) {
      profiles = profiles.filter((profile) => (
        Number(profile.gpuCount || 0) <= 0
        || zoneScan.availableHardwareIds.includes(String(profile.id))
      ));
    }
    const selectableProfiles = profiles;
    state.visibleHardwareProfiles = profiles;

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
      const compatibility = sunshineCompatibility(profile);
      const compatibilityNote = gpuCount > 0 ? ` [Sunshine: ${compatibility.label}]` : "";
      const unavailable = !hardwareProfileSupported(profile);
      const availability = unavailable
        ? ` - Create unavailable: ${String(profile.unavailableReason || "unsupported by this VM stack")}`
        : "";
      const hardwareLabel = profile.label || id;
      const optionLabel = `${hardwareLabel}${compatibilityNote}${price} (${suffix}, ${zoneCount} zones)${availability}`;
      return `<option class="sunshine-${escapeHtml(compatibility.state)}" value="${escapeHtml(id)}" data-base-label="${escapeHtml(optionLabel)}" data-hardware-label="${escapeHtml(hardwareLabel)}">${escapeHtml(optionLabel)}</option>`;
    }).join("");
    if (selectableProfiles.some((profile) => String(profile.id) === previousHardware)) {
      elements.hardwareSelect.value = previousHardware;
    } else {
      elements.hardwareSelect.value = String((selectableProfiles[0] || {}).id || "");
    }
    elements.hardwareSelect.dataset.savedValue = "";
    renderZoneOptions();
    renderGpuScanProfileOptions();
    updateActionAvailability();
  }

  function renderZoneOptions() {
    if (!elements.zoneSelect) {
      return;
    }
    const profile = selectedHardwareProfile();
    const compatibleZones = profile && Array.isArray(profile.zones) ? profile.zones : [];
    const scan = activeGpuAvailabilityScan(profile);
    const globalScan = activeAllGpuZoneAvailabilityScan();
    const globalZones = globalScan && profile && Number(profile.gpuCount || 0) > 0
      ? (globalScan.availableZonesByHardwareId || {})[String(profile.id)] || []
      : compatibleZones;
    const zones = scan ? scan.availableZones : globalZones;
    if (!zones.length) {
      elements.zoneSelect.innerHTML = '<option value="">No zones available</option>';
      if (elements.hardwareOptionsStatus) {
      elements.hardwareOptionsStatus.textContent = scan
        ? `Capacity scan found no currently available zones for ${selectedHardwareLabel() || "selected GPU"}. Click Show All GPU Zones to restore compatible zones.`
        : globalScan && profile && Number(profile.gpuCount || 0) > 0
          ? `Full GPU scan found no currently available zones for ${selectedHardwareLabel() || "selected GPU"}. Click Show All GPUs in All Zones to restore the catalog.`
        : `No zones currently expose ${selectedHardwareLabel() || "selected hardware"}. Refresh later or choose CPU.`;
      }
      renderHardwarePriceEstimate(null);
      updateHardwareZoneAvailability();
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
    updateHardwareZoneAvailability();
    if (elements.hardwareOptionsStatus) {
      const refreshedAt = state.hardwarePayload && state.hardwarePayload.refreshedAt
        ? ` Refreshed: ${state.hardwarePayload.refreshedAt}.`
        : "";
      elements.hardwareOptionsStatus.textContent = scan
        ? `Capacity scan found GPU capacity in ${zones.length}/${zonesForGpuScanScope(compatibleZones, scan.scope).length} compatible zone${zonesForGpuScanScope(compatibleZones, scan.scope).length === 1 ? "" : "s"}. Temporary test reservations were released immediately.`
        : globalScan && profile && Number(profile.gpuCount || 0) > 0
          ? `Full GPU scan found capacity in ${zones.length}/${compatibleZones.length} compatible zone${compatibleZones.length === 1 ? "" : "s"} for ${selectedHardwareLabel()}. Temporary test reservations were released immediately.`
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
    const applyEndpoint = Boolean(options && options.applyEndpoint);
    if (!state.user) {
      throw new Error("Sign in with Google first.");
    }
    if (!silent && elements.hardwareOptionsStatus) {
      elements.hardwareOptionsStatus.textContent = "Refreshing Compute Engine hardware availability...";
    }
    const data = await fetchApi("/api/hardware", { method: "GET" });
    renderHardwareOptions(data);
    if (applyEndpoint) {
      applySelectedEndpoint();
    } else {
      renderEndpointStatus();
    }
    return data;
  }

  async function scanGpuAvailabilityAcrossZones() {
    const profile = selectedHardwareProfile();
    if (!hardwareProfileSupported(profile) || Number(profile.gpuCount || 0) <= 0 || !String(profile.gpuType || "").trim()) {
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

    const scope = selectedGpuScanScope();
    const zones = zonesForGpuScanScope(
      Array.isArray(profile.zones)
        ? profile.zones.map((zone) => String(zone || "").trim()).filter(Boolean)
        : [],
      scope
    );
    if (!zones.length) {
      throw new Error(`No compatible ${String(profile.label || profile.id)} zones are declared in ${gpuScanScopeLabel(scope)}.`);
    }
    const run = {
      hardwareId: String(profile.id || ""),
      hardwareLabel: String(profile.label || profile.id || "GPU"),
      scope,
      target: {
        endpointId: selectedEndpointId(),
        hardwareId: String(profile.id || ""),
        machineType: String(profile.machineType || ""),
        gpuType: String(profile.gpuType || ""),
        gpuCount: Number(profile.gpuCount || 0),
        acceleratorMode: String(profile.acceleratorMode || "attached"),
      },
      zones,
      completed: 0,
      currentZone: "",
      availableZones: [],
      scanCreateCandidates: [],
      cleanupFailures: [],
      cancelRequested: false,
      pauseRequested: false,
      paused: false,
      resume: null,
      finished: false,
      linksUnlocked: false,
      abortController: new AbortController(),
    };
    state.gpuAvailabilityScanRun = run;
    state.scanCreateResultRun = run;
    renderScanCreateResults(run);
    updateGpuAvailabilityScanButton();
    renderGpuAvailabilityScanProgress(run);
    try {
      for (const zone of zones) {
        if (run.pauseRequested || run.cancelRequested) {
          await releaseReservationsAndWaitForGpuScanResume(run);
        }
        if (run.cancelRequested) {
          break;
        }
        run.currentZone = zone;
        renderGpuAvailabilityScanProgress(run);
        try {
          const data = await fetchApi("/api/capacity-reservations/scan-zone", {
            method: "POST",
            body: JSON.stringify(gpuScanRequestPayload(run, { ...run.target, zone })),
            signal: run.abortController.signal,
          });
          if (data && data.available) {
            run.availableZones.push(zone);
            if (data.heldForOperation) {
              const outcome = await handleHeldGpuCapacity(run, data);
              if (["created", "failed", "cancelled"].includes(outcome)) break;
            } else {
              await appendScanCreateCandidate(run, profile, zone);
            }
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
      const remainingReservations = run.cancelRequested
        ? await releaseCancelledGpuScanReservations(run)
        : await refreshGpuCapacityReservationCount();
      run.linksUnlocked = remainingReservations === 0;
      renderScanCreateResults(run);
      scheduleGpuCapacityReservationCountRefreshes();
      if (run.cancelRequested) {
        state.gpuAvailabilityScan = {
          hardwareId: run.hardwareId,
          scope: run.scope,
          availableZones: run.availableZones,
        };
        renderZoneOptions();
        await refreshPriceEstimate({ silent: false });
        await refreshStatus({ silent: true });
        const cleanupFailures = run.cleanupFailures.length;
        const message = cleanupFailures
          ? `GPU capacity scan cancelled after ${run.completed}/${zones.length} zones. Applied partial result: ${run.availableZones.length} GPU zones with current capacity; ${cleanupFailures} temporary reservation cleanup${cleanupFailures === 1 ? "" : "s"} will expire automatically.`
          : `GPU capacity scan cancelled after ${run.completed}/${zones.length} zones. Applied partial result: ${run.availableZones.length} GPU zones with current capacity. All temporary reservations were released.`;
        setBanner(message, gpuScanCompletionTone(run));
        return;
      }
    }

    if (run.createStarted) return;
    state.gpuAvailabilityScan = {
      hardwareId: run.hardwareId,
      scope: run.scope,
      availableZones: run.availableZones,
    };
    renderZoneOptions();
    await refreshPriceEstimate({ silent: false });
    await refreshStatus({ silent: true });
    const cleanupFailures = run.cleanupFailures.length;
    const message = cleanupFailures
      ? `Capacity scan found ${run.availableZones.length}/${zones.length} available GPU zones, but ${cleanupFailures} temporary reservation cleanup${cleanupFailures === 1 ? "" : "s"} will expire automatically.`
      : `Capacity scan found ${run.availableZones.length}/${zones.length} GPU zones with current capacity. All temporary reservations were released.`;
    setBanner(message, gpuScanCompletionTone(run));
  }

  async function scanSelectedGpuProfilesAcrossZones(options = {}) {
    if (state.gpuAvailabilityScan) {
      resetGpuAvailabilityScan();
      renderZoneOptions();
      renderGpuScanProfileOptions();
      await refreshPriceEstimate({ silent: false });
      await refreshStatus({ silent: true });
      await refreshGpuCapacityReservationCount();
      setBanner("All compatible GPU zones are shown again. You can run a new capacity scan.", "success");
      return;
    }

    const profiles = selectedGpuScanProfiles();
    if (!profiles.length) {
      throw new Error("Select one or more GPU hardware profiles before scanning availability.");
    }
    const scope = selectedGpuScanScope();
    const targets = profiles.flatMap((profile) => zonesForGpuScanScope(profile.zones || [], scope).map((zone) => ({ profile, zone })));
    if (!targets.length) {
      throw new Error(`No compatible GPU zones are declared in ${gpuScanScopeLabel(scope)} for the selected profiles.`);
    }
    if (profiles.length > 1 && !options.confirmed && !window.confirm(`This will create and immediately release ${targets.length} short-lived GPU capacity reservations for ${profiles.length} selected GPU profiles. It may take several minutes and may be cancelled. Continue?`)) {
      setCommandStatus("Selected GPU capacity scan cancelled before it started.", "neutral");
      return;
    }

    const run = {
      kind: "selected-gpu-zones",
      profiles,
      scope,
      targets,
      completed: 0,
      currentTarget: null,
      availableZonesByHardwareId: {},
      scanCreateCandidates: [],
      availablePairCount: 0,
      cleanupFailures: [],
      cancelRequested: false,
      pauseRequested: false,
      paused: false,
      resume: null,
      finished: false,
      linksUnlocked: false,
      abortController: new AbortController(),
    };
    state.gpuAvailabilityScanRun = run;
    state.scanCreateResultRun = run;
    renderScanCreateResults(run);
    updateGpuAvailabilityScanButton();
    renderGpuAvailabilityScanProgress(run);
    try {
      for (const target of targets) {
        if (run.pauseRequested || run.cancelRequested) {
          await releaseReservationsAndWaitForGpuScanResume(run);
        }
        if (run.cancelRequested) {
          break;
        }
        run.currentTarget = target;
        renderGpuAvailabilityScanProgress(run);
        try {
          const data = await fetchApi("/api/capacity-reservations/scan-zone", {
            method: "POST",
            body: JSON.stringify(gpuScanRequestPayload(run, targetParamsForHardwareProfile(target.profile, target.zone))),
            signal: run.abortController.signal,
          });
          if (data && data.available) {
            const hardwareId = String(target.profile.id);
            const zones = run.availableZonesByHardwareId[hardwareId] || [];
            zones.push(String(target.zone));
            run.availableZonesByHardwareId[hardwareId] = zones;
            run.availablePairCount += 1;
            if (data.heldForOperation) {
              const outcome = await handleHeldGpuCapacity(run, data);
              if (["created", "failed", "cancelled"].includes(outcome)) break;
            } else {
              await appendScanCreateCandidate(run, target.profile, target.zone);
            }
          }
          if (data && data.cleanupFailure) {
            run.cleanupFailures.push({ target, error: String(data.cleanupFailure) });
          }
          run.completed += 1;
        } catch (error) {
          if (run.cancelRequested || error.name === "AbortError") {
            break;
          }
          run.completed += 1;
          setCommandStatus(`Selected GPU scan skipped ${String(target.profile.label || target.profile.id)} in ${zoneDisplayLabel(target.zone)}: ${formatErrorMessage(error)}`, "warning");
        }
        renderGpuAvailabilityScanProgress(run);
      }
    } finally {
      run.finished = true;
      run.currentTarget = null;
      state.gpuAvailabilityScanRun = null;
      updateGpuAvailabilityScanButton();
      const remainingReservations = run.cancelRequested
        ? await releaseCancelledGpuScanReservations(run)
        : await refreshGpuCapacityReservationCount();
      run.linksUnlocked = remainingReservations === 0;
      renderScanCreateResults(run);
      scheduleGpuCapacityReservationCountRefreshes();
    }

    if (run.createStarted) return;
    state.gpuAvailabilityScan = {
      hardwareIds: profiles.map((profile) => String(profile.id)),
      scope,
      availableZonesByHardwareId: run.availableZonesByHardwareId,
    };
    renderZoneOptions();
    renderGpuScanProfileOptions();
    await refreshPriceEstimate({ silent: false });
    await refreshStatus({ silent: true });
    const cleanupFailures = run.cleanupFailures.length;
    const prefix = run.cancelRequested ? "Selected GPU capacity scan cancelled" : "Selected GPU capacity scan completed";
    const message = cleanupFailures
      ? `${prefix}: ${run.availablePairCount}/${targets.length} GPU-zone combinations currently available; ${cleanupFailures} temporary reservation cleanup${cleanupFailures === 1 ? "" : "s"} will expire automatically.`
      : `${prefix}: ${run.availablePairCount}/${targets.length} GPU-zone combinations currently available. Temporary test reservations were released immediately.`;
    if (elements.hardwareOptionsStatus) {
      elements.hardwareOptionsStatus.textContent = message;
    }
    setCommandStatus(message, gpuScanCompletionTone(run));
  }

  async function scanSelectedZoneGpuAvailability() {
    const zone = selectedZone();
    if (activeSelectedZoneGpuAvailabilityScan(zone)) {
      resetSelectedZoneGpuAvailabilityScan();
      renderHardwareOptions(state.hardwarePayload);
      await refreshPriceEstimate({ silent: false });
      await refreshStatus({ silent: true });
      setCommandStatus(`All known GPU profiles are shown again for ${zoneDisplayLabel(zone)}.`, "success");
      return;
    }

    const profiles = getHardwareProfiles().filter((profile) => (
      hardwareProfileSupported(profile)
      &&
      Number(profile.gpuCount || 0) > 0
      && String(profile.gpuType || "").trim()
      && Array.isArray(profile.zones)
      && profile.zones.includes(zone)
    ));
    if (!zone || !profiles.length) {
      throw new Error("No GPU hardware profiles are configured for the capacity scan.");
    }

    const run = {
      kind: "zone-gpus",
      zone,
      profiles,
      completed: 0,
      currentProfile: null,
      availableHardwareIds: [],
      scanCreateCandidates: [],
      cleanupFailures: [],
      cancelRequested: false,
      pauseRequested: false,
      paused: false,
      resume: null,
      finished: false,
      linksUnlocked: false,
      abortController: new AbortController(),
    };
    state.selectedZoneGpuAvailabilityScanRun = run;
    state.scanCreateResultRun = run;
    renderScanCreateResults(run);
    updateGpuAvailabilityScanButton();
    renderGpuAvailabilityScanProgress(run);
    try {
      for (const profile of profiles) {
        if (run.pauseRequested || run.cancelRequested) {
          await releaseReservationsAndWaitForGpuScanResume(run);
        }
        if (run.cancelRequested) {
          break;
        }
        run.currentProfile = profile;
        renderGpuAvailabilityScanProgress(run);
        try {
          const data = await fetchApi("/api/capacity-reservations/scan-zone", {
            method: "POST",
            body: JSON.stringify(gpuScanRequestPayload(run, targetParamsForHardwareProfile(profile, zone))),
            signal: run.abortController.signal,
          });
          if (data && data.available) {
            run.availableHardwareIds.push(String(profile.id));
            if (data.heldForOperation) {
              const outcome = await handleHeldGpuCapacity(run, data);
              if (["created", "failed", "cancelled"].includes(outcome)) break;
            } else {
              await appendScanCreateCandidate(run, profile, zone);
            }
          }
          if (data && data.cleanupFailure) {
            run.cleanupFailures.push({ profile, error: String(data.cleanupFailure) });
          }
          run.completed += 1;
        } catch (error) {
          if (run.cancelRequested || error.name === "AbortError") {
            break;
          }
          run.completed += 1;
          setCommandStatus(`GPU scan skipped ${String(profile.label || profile.id)}: ${formatErrorMessage(error)}`, "warning");
        }
        renderGpuAvailabilityScanProgress(run);
      }
    } finally {
      run.finished = true;
      run.currentProfile = null;
      state.selectedZoneGpuAvailabilityScanRun = null;
      updateGpuAvailabilityScanButton();
      const remainingReservations = run.cancelRequested
        ? await releaseCancelledGpuScanReservations(run)
        : await refreshGpuCapacityReservationCount();
      run.linksUnlocked = remainingReservations === 0;
      renderScanCreateResults(run);
      scheduleGpuCapacityReservationCountRefreshes();
    }

    if (run.createStarted) return;
    state.selectedZoneGpuAvailabilityScan = {
      zone,
      availableHardwareIds: run.availableHardwareIds,
    };
    renderHardwareOptions(state.hardwarePayload);
    await refreshPriceEstimate({ silent: false });
    await refreshStatus({ silent: true });
    const cleanupFailures = run.cleanupFailures.length;
    const prefix = run.cancelRequested ? "GPU capacity scan cancelled" : "GPU capacity scan completed";
    const message = cleanupFailures
      ? `${prefix} for ${zoneDisplayLabel(zone)}: ${run.availableHardwareIds.length}/${profiles.length} GPU profiles currently available; ${cleanupFailures} temporary reservation cleanup${cleanupFailures === 1 ? "" : "s"} will expire automatically.`
      : `${prefix} for ${zoneDisplayLabel(zone)}: ${run.availableHardwareIds.length}/${profiles.length} GPU profiles currently available. Temporary test reservations were released immediately.`;
    if (elements.hardwareOptionsStatus) {
      elements.hardwareOptionsStatus.textContent = message;
    }
    setCommandStatus(message, gpuScanCompletionTone(run));
  }

  async function scanAllGpuZoneAvailability(options = {}) {
    if (activeAllGpuZoneAvailabilityScan()) {
      resetAllGpuZoneAvailabilityScan();
      renderHardwareOptions(state.hardwarePayload);
      await refreshPriceEstimate({ silent: false });
      await refreshStatus({ silent: true });
      await refreshGpuCapacityReservationCount();
      setBanner("All configured GPU profiles and compatible zones are shown again.", "success");
      return;
    }

    const profiles = getHardwareProfiles().filter((profile) => (
      hardwareProfileSupported(profile)
      && Number(profile.gpuCount || 0) > 0
      && String(profile.gpuType || "").trim()
      && Array.isArray(profile.zones)
      && profile.zones.length
    ));
    const targets = profiles.flatMap((profile) => profile.zones.map((zone) => ({ profile, zone: String(zone) })));
    if (!targets.length) {
      throw new Error("No GPU hardware profiles are configured for the full capacity scan.");
    }
    if (!options.confirmed && !window.confirm(`This will create and immediately release ${targets.length} short-lived GPU capacity reservations across ${profiles.length} GPU profiles. It can take several minutes and may be cancelled. Continue?`)) {
      setCommandStatus("Full GPU capacity scan cancelled before it started.", "neutral");
      return;
    }

    const run = {
      kind: "all-gpu-zones",
      targets,
      completed: 0,
      currentTarget: null,
      availableZonesByHardwareId: {},
      scanCreateCandidates: [],
      availablePairCount: 0,
      cleanupFailures: [],
      cancelRequested: false,
      pauseRequested: false,
      paused: false,
      resume: null,
      finished: false,
      linksUnlocked: false,
      abortController: new AbortController(),
    };
    state.allGpuZoneAvailabilityScanRun = run;
    state.scanCreateResultRun = run;
    renderScanCreateResults(run);
    updateGpuAvailabilityScanButton();
    renderGpuAvailabilityScanProgress(run);
    try {
      for (const target of targets) {
        if (run.pauseRequested || run.cancelRequested) {
          await releaseReservationsAndWaitForGpuScanResume(run);
        }
        if (run.cancelRequested) {
          break;
        }
        run.currentTarget = target;
        renderGpuAvailabilityScanProgress(run);
        try {
          const data = await fetchApi("/api/capacity-reservations/scan-zone", {
            method: "POST",
            body: JSON.stringify(gpuScanRequestPayload(run, targetParamsForHardwareProfile(target.profile, target.zone))),
            signal: run.abortController.signal,
          });
          if (data && data.available) {
            const hardwareId = String(target.profile.id);
            const zones = run.availableZonesByHardwareId[hardwareId] || [];
            zones.push(target.zone);
            run.availableZonesByHardwareId[hardwareId] = zones;
            run.availablePairCount += 1;
            if (data.heldForOperation) {
              const outcome = await handleHeldGpuCapacity(run, data);
              if (["created", "failed", "cancelled"].includes(outcome)) break;
            } else {
              await appendScanCreateCandidate(run, target.profile, target.zone);
            }
          }
          if (data && data.cleanupFailure) {
            run.cleanupFailures.push({ target, error: String(data.cleanupFailure) });
          }
          run.completed += 1;
        } catch (error) {
          if (run.cancelRequested || error.name === "AbortError") {
            break;
          }
          run.completed += 1;
          setCommandStatus(`Full GPU scan skipped ${String(target.profile.label || target.profile.id)} in ${zoneDisplayLabel(target.zone)}: ${formatErrorMessage(error)}`, "warning");
        }
        renderGpuAvailabilityScanProgress(run);
      }
    } finally {
      run.finished = true;
      run.currentTarget = null;
      state.allGpuZoneAvailabilityScanRun = null;
      updateGpuAvailabilityScanButton();
      const remainingReservations = run.cancelRequested
        ? await releaseCancelledGpuScanReservations(run)
        : await refreshGpuCapacityReservationCount();
      run.linksUnlocked = remainingReservations === 0;
      renderScanCreateResults(run);
      scheduleGpuCapacityReservationCountRefreshes();
    }

    if (run.createStarted) return;
    state.allGpuZoneAvailabilityScan = {
      availableZonesByHardwareId: run.availableZonesByHardwareId,
    };
    renderHardwareOptions(state.hardwarePayload);
    await refreshPriceEstimate({ silent: false });
    await refreshStatus({ silent: true });
    const cleanupFailures = run.cleanupFailures.length;
    const prefix = run.cancelRequested ? "Full GPU capacity scan cancelled" : "Full GPU capacity scan completed";
    const message = cleanupFailures
      ? `${prefix}: ${run.availablePairCount}/${targets.length} GPU-zone combinations currently available; ${cleanupFailures} temporary reservation cleanup${cleanupFailures === 1 ? "" : "s"} will expire automatically.`
      : `${prefix}: ${run.availablePairCount}/${targets.length} GPU-zone combinations currently available. Temporary test reservations were released immediately.`;
    if (elements.hardwareOptionsStatus) {
      elements.hardwareOptionsStatus.textContent = message;
    }
    setCommandStatus(message, gpuScanCompletionTone(run));
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
      elements.instancesList.textContent = "No managed Compute Engine instances are currently created.";
      if (elements.instancesStatus) {
        elements.instancesStatus.textContent = "";
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

  function mergeCurrentStatusIntoInstancesPayload(payload) {
    if (
      !payload
      || !Array.isArray(payload.instances)
      || !state.lastStatus
      || state.lastStatusTargetKey !== selectedTargetKey()
    ) {
      return payload;
    }

    const currentStatus = state.lastStatus;
    return {
      ...payload,
      instances: payload.instances.map((instance) => {
        if (!instanceMatchesCurrentSelection(instance)) {
          return instance;
        }
        return {
          ...instance,
          status: currentStatus.status || instance.status,
          externalIp: currentStatus.externalIp || instance.externalIp,
          sunshineStatus: currentStatus.sunshineStatus || instance.sunshineStatus,
          minecraftStatus: currentStatus.minecraftStatus || instance.minecraftStatus,
        };
      }),
    };
  }

  function currentSelectionMatchesCreatedInstance() {
    const currentZone = selectedZone();
    const currentHardwareId = String(elements.hardwareSelect && elements.hardwareSelect.value || "").trim();
    if (!currentZone || !currentHardwareId) {
      return false;
    }
    return getCreatedInstances().some((instance) => {
      const profile = profileForInstance(instance);
      const endpoint = endpointForInstance(instance);
      return profile
        && endpoint
        && String(endpoint.id) === selectedEndpointId()
        && String(profile.id || "") === currentHardwareId
        && String(instance.zone || "").trim() === currentZone;
    });
  }

  function instanceMatchesCurrentSelection(instance) {
    const currentZone = selectedZone();
    const currentHardwareId = String(elements.hardwareSelect && elements.hardwareSelect.value || "").trim();
    const profile = profileForInstance(instance);
    const endpoint = endpointForInstance(instance);
    return Boolean(
      profile
      && endpoint
      && String(endpoint.id) === selectedEndpointId()
      && currentZone
      && currentHardwareId
      && String(profile.id || "") === currentHardwareId
      && String(instance && instance.zone || "").trim() === currentZone
    );
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
    await refreshEndpointRegistry();
    const data = mergeCurrentStatusIntoInstancesPayload(
      await fetchApi("/api/instances", { method: "GET" }),
    );
    renderInstanceOptions(data);
    if (autoSelect) {
      await autoSelectCreatedInstanceIfNeeded({ silent: true });
    }
    return data;
  }

  async function refreshEndpointRegistry() {
    const response = await window.fetch(`${state.backendUrl}/api/config`, {
      method: "GET",
      cache: "no-store",
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
    renderEndpointOptions(config);
    renderTargetSummary();
    return config;
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
    if (state.endpointSelectionLocked) {
      return false;
    }
    const instances = getCreatedInstances();
    if (!instances.length) {
      return false;
    }
    if (!state.hardwarePayload || !getHardwareProfiles().length) {
      await refreshHardwareOptions({ silent: true });
    }
    if (state.endpointSelectionLocked) {
      return false;
    }
    if (currentSelectionMatchesCreatedInstance()) {
      return false;
    }
    await selectCreatedInstance(0, { ...(options || {}), automatic: true });
    return true;
  }

  async function selectCreatedInstance(index, options) {
    const automatic = Boolean(options && options.automatic);
    if (automatic && state.endpointSelectionLocked) {
      return false;
    }
    if (!automatic) {
      state.endpointSelectionLocked = false;
    }
    const silent = Boolean(options && options.silent);
    const instances = getCreatedInstances();
    const instance = instances[index];
    if (!instance) {
      throw new Error("Selected instance is no longer available.");
    }
    if (!automatic) {
      state.startScanSourceInstanceName = String(instance.name || "");
      if (elements.startSelectedFirstGpu) elements.startSelectedFirstGpu.checked = false;
    }
    if (!state.hardwarePayload || !getHardwareProfiles().length) {
      await refreshHardwareOptions({ silent: false });
    }
    if (automatic && state.endpointSelectionLocked) {
      return false;
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
    const endpoint = endpointForInstance(instance);
    if (automatic && state.endpointSelectionLocked) {
      return false;
    }
    if (endpoint && elements.endpointSelect) {
      elements.endpointSelect.value = String(endpoint.id || "");
      state.selectedEndpointId = String(endpoint.id || "");
      state.endpointSelectionLocked = false;
      renderEndpointStatus();
    }
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

  function renderStatusPayload(payload, targetKey) {
    state.lastStatus = payload;
    state.lastStatusTargetKey = targetKey || selectedTargetKey();
    syncEndpointFromStatus(payload);
    migrateHistoryDuckDnsDomains(payload.duckdnsDomains);
    renderTargetSummary();
    renderBackupOptions(payload);
    renderMinecraftOptions(payload);
    renderAutoStopStatus(payload);
    renderHardwarePriceEstimate(selectedPriceEstimate());
    renderAccess(payload);
    scrollToCurrentHashOnce();
    updateActionAvailability();
  }

  function syncEndpointFromStatus(payload) {
    const endpoint = payload && payload.target && payload.target.endpoint;
    if (!endpoint || !endpoint.id || !state.backendConfig) {
      return;
    }
    const endpoints = Array.isArray(state.backendConfig.endpoints)
      ? [...state.backendConfig.endpoints]
      : [];
    const index = endpoints.findIndex((item) => String(item && item.id || "") === String(endpoint.id));
    if (index >= 0) {
      endpoints[index] = { ...endpoints[index], ...endpoint };
    } else {
      endpoints.push(endpoint);
    }
    state.backendConfig = { ...state.backendConfig, endpoints };
    renderEndpointOptions(state.backendConfig);
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
    if (autoStop.label === "Will be scheduled after next start") {
      return `Auto-stop: will be scheduled ${hours}h after the next start.`;
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
    const powerAction = COMMAND_POWER_ACTION_TRANSITIONS[command];
    if (!state.lastStatus) {
      return;
    }
    const nextStatus = { ...state.lastStatus };
    if (sunshineStatus) {
      nextStatus.sunshineStatus = {
        ...(state.lastStatus.sunshineStatus || {}),
        ...sunshineStatus,
      };
    }
    if (minecraftStatus) {
      nextStatus.minecraftStatus = {
        ...(state.lastStatus.minecraftStatus || {}),
        ...minecraftStatus,
      };
    }
    if (powerAction) {
      nextStatus.powerAction = {
        ...(state.lastStatus.powerAction || {}),
        ...powerAction,
      };
    }
    if (sunshineStatus || minecraftStatus || powerAction) {
      renderStatusPayload(nextStatus);
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

  const OPERATION_PROGRESS_TITLES = {
    create: "Creating VM",
    start: "Starting VM",
    restart: "Restarting VM",
    stop: "Stopping VM",
    delete: "Deleting VM",
    "create-backup": "Creating backup",
    "restore-backup": "Restoring backup",
    "remove-backup": "Removing backup",
    "install-app": "Installing application",
    "uninstall-app": "Uninstalling application",
    "install-minecraft": "Installing Minecraft server",
    "start-minecraft": "Starting Minecraft server",
    "stop-minecraft": "Stopping Minecraft server",
    "restart-minecraft": "Restarting Minecraft server",
    "remove-minecraft": "Removing Minecraft server",
    "set-auto-stop": "Updating auto-stop",
  };

  function progressPayloadState(payload, path, fallback) {
    const value = path.reduce((current, key) => current && current[key], payload);
    return String(value || fallback || "unknown").trim();
  }

  function operationProgressDefinition(command) {
    if (command === "create") {
      return ["Request accepted", "Provisioning Compute Engine VM", "Preparing data disk", "Starting platform services", "Verifying ready state"];
    }
    if (command === "start") {
      return ["Request accepted", "Starting Compute Engine VM", "Preparing data disk", "Starting platform services", "Verifying ready state"];
    }
    if (command === "restart") {
      return ["Request accepted", "Restarting guest system", "Starting platform services", "Verifying ready state"];
    }
    if (command === "stop") {
      return ["Request accepted", "Stopping guest services", "Flushing local disk writes", "Powering off VM", "Verifying VM is stopped"];
    }
    if (command === "delete") {
      return ["Request accepted", "Stopping VM", "Removing VM and attached disks", "Verifying resources were removed"];
    }
    if (["create-backup", "restore-backup"].includes(command)) {
      return ["Request accepted", "Preparing VM data", "Transferring persisted data", "Verifying result"];
    }
    if (command === "remove-backup") {
      return ["Request accepted", "Removing backup from storage", "Verifying backup catalog"];
    }
    if (["install-app", "uninstall-app", "install-minecraft", "start-minecraft", "stop-minecraft", "restart-minecraft", "remove-minecraft"].includes(command)) {
      return ["Request accepted", "Waiting for VM management agent", "Applying requested software change", "Refreshing service status"];
    }
    return ["Request accepted", "Applying configuration", "Verifying result"];
  }

  function operationProgressIndex(command, payload, steps) {
    if (!payload) return 0;
    const vmState = String(payload.status || "NOT_FOUND").trim().toUpperCase();
    const instanceExists = payload.instanceExists !== false && vmState !== "NOT_FOUND";
    const dataDiskState = progressPayloadState(payload, ["persistence", "dataDisk", "state"]);
    const sunshineState = progressPayloadState(payload, ["sunshineStatus", "state"]);
    const minecraftState = progressPayloadState(payload, ["minecraftStatus", "state"]);
    const restoreState = progressPayloadState(payload, ["persistence", "restore", "state"]);
    const archiveState = progressPayloadState(payload, ["persistence", "gamesArchive", "state"]);
    const servicesReady = vmState === "RUNNING"
      && ["ready", "disabled"].includes(sunshineState.toLowerCase())
      && !isTransitionalStatus(payload);

    if (["create", "start"].includes(command)) {
      if (!instanceExists) return 1;
      if (vmState !== "RUNNING") return 1;
      if (!["ready", "disabled", "missing"].includes(dataDiskState.toLowerCase())) return 2;
      if (!servicesReady) return 3;
      return steps.length - 1;
    }
    if (command === "restart") {
      const phase = progressPayloadState(payload, ["powerAction", "phase"]);
      if (["requested", "running", "rebooting", "stopping"].includes(phase.toLowerCase()) || vmState !== "RUNNING") return 1;
      if (!servicesReady) return 2;
      return steps.length - 1;
    }
    if (command === "stop") {
      const phase = progressPayloadState(payload, ["powerAction", "phase"]);
      if (["TERMINATED", "NOT_FOUND"].includes(vmState)) return steps.length - 1;
      if (vmState === "STOPPING") return 3;
      if (phase.toLowerCase() === "running") return 2;
      return 1;
    }
    if (command === "delete") {
      if (!instanceExists) return steps.length - 1;
      if (["TERMINATED", "STOPPING"].includes(vmState)) return 2;
      return 1;
    }
    if (["create-backup", "restore-backup"].includes(command)) {
      if (["running", "restoring", "starting", "preparing"].includes(restoreState.toLowerCase()) || ["running", "archiving", "uploading"].includes(archiveState.toLowerCase())) return 2;
      return isTransitionalStatus(payload) ? 1 : steps.length - 1;
    }
    if (["install-app", "uninstall-app", "install-minecraft", "start-minecraft", "stop-minecraft", "restart-minecraft", "remove-minecraft"].includes(command)) {
      if (["installing", "starting", "stopping", "removing", "backup", "restore"].includes(minecraftState.toLowerCase())) return 2;
      return isTransitionalStatus(payload) ? 1 : steps.length - 1;
    }
    return isTransitionalStatus(payload) ? 1 : steps.length - 1;
  }

  function renderOperationProgress(command, payload) {
    const container = elements.pageLoaderOperationProgress;
    if (!container || !command) return;
    const steps = operationProgressDefinition(command);
    const index = Math.min(Math.max(operationProgressIndex(command, payload, steps), 0), steps.length - 1);
    const progressState = payload ? "Live status received" : "Waiting for first VM status";
    const rawVmAction = progressPayloadState(
      payload,
      ["powerAction", "label"],
      progressPayloadState(payload, ["powerAction", "phase"]),
    );
    const vmAction = rawVmAction.toLowerCase() === "unknown"
      ? ["create", "start"].includes(command)
        ? "Not required during provisioning"
        : "No guest action active"
      : rawVmAction;
    const facts = payload ? [
      ["VM", String(payload.status || "NOT_FOUND")],
      ["VM action", vmAction],
      ["Data disk", progressPayloadState(payload, ["persistence", "dataDisk", "label"], progressPayloadState(payload, ["persistence", "dataDisk", "state"]))],
      ["Sunshine", progressPayloadState(payload, ["sunshineStatus", "label"], progressPayloadState(payload, ["sunshineStatus", "state"]))],
      ["Minecraft", progressPayloadState(payload, ["minecraftStatus", "label"], progressPayloadState(payload, ["minecraftStatus", "state"]))],
    ] : [["VM", "Waiting for status"], ["Service", "Waiting for status"]];
    container.hidden = false;
    container.innerHTML = `
      <div class="operation-progress-head">
        <p class="operation-progress-title">${escapeHtml(OPERATION_PROGRESS_TITLES[command] || "VM operation")}</p>
        <p class="operation-progress-stage">${escapeHtml(progressState)}</p>
      </div>
      <progress class="operation-progress-meter" value="${index + 1}" max="${steps.length}"></progress>
      <ol class="operation-progress-steps">${steps.map((step, stepIndex) => `<li data-state="${stepIndex < index ? "done" : stepIndex === index ? "active" : "pending"}">${escapeHtml(step)}</li>`).join("")}</ol>
      <ul class="operation-progress-facts">${facts.map(([label, value]) => `<li><strong>${escapeHtml(label)}</strong>${escapeHtml(value)}</li>`).join("")}</ul>
    `;
    state.operationProgressCommand = command;
  }

  function clearOperationProgress() {
    state.operationProgressCommand = "";
    if (!elements.pageLoaderOperationProgress) return;
    elements.pageLoaderOperationProgress.hidden = true;
    elements.pageLoaderOperationProgress.innerHTML = "";
  }

  async function waitForStatusSettled(command, initialPayload) {
    if (!COMMANDS_TO_POLL_AFTER_RESPONSE.has(command)) {
      return initialPayload;
    }

    const deadline = Date.now() + (COMMAND_STATUS_POLL_TIMEOUTS_MS[command] || COMMAND_STATUS_POLL_TIMEOUT_MS);
    let payload = initialPayload;
    let sunshineVersionGraceDeadline = 0;

    do {
      await wait(SUNSHINE_POLL_INTERVAL_MS);
      const refreshedPayload = await refreshStatus({ silent: true, forceRender: true });
      if (!refreshedPayload) {
        continue;
      }
      payload = refreshedPayload;
      renderOperationProgress(command, payload);
      if (isTransitionalStatus(payload)) {
        setCommandStatus(statusBannerMessage(`Command "${command}" still updating`, payload), "warning");
      }
      const sunshineState = String(payload.sunshineStatus && payload.sunshineStatus.state || "").trim().toLowerCase();
      const sunshineVersion = String(payload.sunshineStatus && payload.sunshineStatus.version || "").trim();
      if (["create", "start"].includes(command) && sunshineState === "ready" && !sunshineVersion && !sunshineVersionGraceDeadline) {
        sunshineVersionGraceDeadline = Math.min(deadline, Date.now() + 30000);
        setCommandStatus("VM and Sunshine are ready. Waiting for Sunshine version detection...", "warning");
      }
    } while (
      Date.now() < deadline
      && (
        isTransitionalStatus(payload)
        || (
          sunshineVersionGraceDeadline > Date.now()
          && String(payload.sunshineStatus && payload.sunshineStatus.state || "").trim().toLowerCase() === "ready"
          && !String(payload.sunshineStatus && payload.sunshineStatus.version || "").trim()
        )
      )
    );

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
    const selectedEndpointDomain = String(target && target.endpoint && target.endpoint.domain || selectedEndpoint() && selectedEndpoint().domain || "").trim();
    const domains = selectedEndpointDomain
      ? `<p><strong>DuckDNS:</strong> <code>${escapeHtml(selectedEndpointDomain)}</code></p>`
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
      cache: "no-store",
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
    renderEndpointOptions(config);
    renderTargetSummary();
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
    await refreshHardwareOptions({ silent: true, applyEndpoint: true });
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
      cache: "no-store",
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
      const apiError = new Error((payload && payload.error) || `API returned ${response.status}.`);
      apiError.status = response.status;
      apiError.details = payload || {};
      apiError.retryAfterSeconds = Number(payload && payload.retryAfterSeconds || 0);
      throw apiError;
    }

    return payload;
  }

  function isComputeReadRateLimitError(error) {
    return Number(error && error.status) === 429
      && String(error && error.details && error.details.reason || "") === "COMPUTE_READ_RATE_LIMIT";
  }

  function createApplicationCatalog() {
    const catalog = state.backendConfig && Array.isArray(state.backendConfig.applicationCatalog)
      ? state.backendConfig.applicationCatalog
      : [];
    return catalog.filter((application) => application && application.id && application.label);
  }

  function selectPostCreateApplications(target, options = {}) {
    const dialog = document.querySelector("#create-applications-dialog");
    const form = dialog && dialog.querySelector("form");
    const summary = document.querySelector("#create-applications-summary");
    const list = document.querySelector("#create-applications-list");
    const selectedButton = document.querySelector("#create-with-applications");
    const cancelButton = document.querySelector("#create-dialog-cancel");
    const skipButton = document.querySelector("#create-dialog-skip");
    const pauseButton = document.querySelector("#create-dialog-pause");
    const cancelScanButton = document.querySelector("#create-dialog-cancel-scan");
    if (!dialog || !form || !summary || !list || !selectedButton) {
      return Promise.resolve([]);
    }

    const gpuEnabled = Number(target && target.gpuCount || 0) > 0;
    const applicationCatalog = createApplicationCatalog();
    const targetLabel = [selectedEndpoint() && selectedEndpoint().domain, selectedHardwareLabel(), target && target.zone]
      .filter(Boolean)
      .join(" · ");
    const heldWorkflow = options.heldWorkflow || null;
    const expiresAt = heldWorkflow && heldWorkflow.expiresAt ? new Date(heldWorkflow.expiresAt).toLocaleTimeString() : "";
    summary.textContent = gpuEnabled
      ? `Target: ${targetLabel}. ${heldWorkflow ? `GPU capacity is reserved until approximately ${expiresAt}. ` : ""}Selected applications will be installed after the VM and Sunshine are ready.`
      : `Target: ${targetLabel}. Desktop application installation requires a GPU-enabled VM, so this VM will be created without applications.`;
    [skipButton, pauseButton, cancelScanButton].forEach((button) => {
      if (button) button.hidden = !heldWorkflow;
    });
    if (cancelButton) cancelButton.hidden = Boolean(heldWorkflow);
    list.replaceChildren();
    if (!applicationCatalog.length) {
      const empty = document.createElement("p");
      empty.className = "access-meta";
      empty.textContent = "No installable applications are available from the backend.";
      list.append(empty);
    } else {
      applicationCatalog.forEach((application) => {
        const label = document.createElement("label");
        label.className = "create-application-option";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = String(application.id);
        checkbox.disabled = !gpuEnabled;
        const copy = document.createElement("span");
        const title = document.createElement("strong");
        title.textContent = String(application.label);
        const description = document.createElement("small");
        description.textContent = String(application.description || "");
        copy.append(title, description);
        label.append(checkbox, copy);
        list.append(label);
      });
    }

    const updateSelectedButton = () => {
      selectedButton.disabled = !gpuEnabled || !list.querySelector('input[type="checkbox"]:checked');
    };
    list.onchange = updateSelectedButton;
    updateSelectedButton();

    return new Promise((resolve) => {
      let settled = false;
      const finish = (choice) => {
        if (settled) {
          return;
        }
        settled = true;
        dialog.removeEventListener("close", onClose);
        form.removeEventListener("submit", onSubmit);
        if (choice === "create-selected") {
          resolve({
            action: "create",
            applicationIds: Array.from(list.querySelectorAll('input[type="checkbox"]:checked'))
              .map((checkbox) => String(checkbox.value)),
          });
          return;
        }
        if (choice === "create-empty") {
          resolve({ action: "create", applicationIds: [] });
          return;
        }
        if (heldWorkflow) {
          resolve({ action: choice === "skip" ? "skip" : choice === "cancel-scan" ? "cancel-scan" : "pause", applicationIds: [] });
          return;
        }
        resolve(null);
      };
      const onClose = () => {
        finish(dialog.returnValue || (heldWorkflow ? "pause" : "cancel"));
      };
      const onSubmit = (event) => {
        event.preventDefault();
        const choice = String(event.submitter && event.submitter.value || "cancel");
        dialog.close(choice);
        finish(choice);
      };
      dialog.addEventListener("close", onClose);
      form.addEventListener("submit", onSubmit);
      dialog.showModal();
    });
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

    // Preserve the explicit Minecraft selection before the optimistic command
    // transition re-renders the form with the previous server metadata.
    const requestedMinecraftVersion = command === "install-minecraft" ? selectedMinecraftVersion() : "";
    const requestedMinecraftServerType = command === "install-minecraft" ? selectedMinecraftServerType() : "";
    if (command === "install-minecraft" && !requestedMinecraftVersion) {
      throw new Error("Select a Minecraft server version first.");
    }
    if (command === "install-minecraft" && !requestedMinecraftServerType) {
      throw new Error("Select a Minecraft server runtime first.");
    }
    if (command === "install-minecraft") {
      state.pendingMinecraftServerType = requestedMinecraftServerType;
    }

    const createApplicationChoice = command === "create"
      ? await selectPostCreateApplications(commandTargetParams)
      : { action: "create", applicationIds: [] };
    if (command === "create" && createApplicationChoice === null) {
      setBanner("Create cancelled.", "warning");
      return;
    }
    const createApplicationIds = createApplicationChoice.applicationIds;

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

    if (command === "remove-minecraft") {
      const confirmed = window.confirm("Remove the Minecraft container? World data under /mnt/games/minecraft-server/data will be preserved.");
      if (!confirmed) {
        setBanner("Remove Minecraft cancelled.", "warning");
        return;
      }
    }

    // Invalidate any Status request already in flight before mutating the VM.
    state.statusRequestGeneration = Number(state.statusRequestGeneration || 0) + 1;
    const loadingToken = setPageLoading(`Running "${command}"...`);
    setBusy(true);
    state.activeCommand = command;
    broadcastActionStatus("started", command);
    setCommandStatus(`Running "${command}" on the VM...`, "warning");
    applyCommandTransition(command);
    renderOperationProgress(command, state.lastStatus);
    const previousStatus = state.lastStatus;
    const previousStatusTargetKey = state.lastStatusTargetKey;
    schedulePostCommandStatusRefresh(command);

    try {
      const body = { command, ...commandTargetParams };
      if (command === "create") {
        body.applicationIds = createApplicationIds;
      }
      if (command === "delete") {
        body.confirmDelete = true;
      }
      if (command === "restore-backup" || command === "remove-backup") {
        body.backupId = String(elements.backupSelect && elements.backupSelect.value || "").trim();
      }
      if (command === "install-minecraft") {
        body.minecraftVersion = requestedMinecraftVersion;
        body.minecraftServerType = requestedMinecraftServerType;
      }
      const autoStopHours = readAutoStopHours(command);
      if (autoStopHours) {
        body.autoStopHours = autoStopHours;
      }

      const submitCommand = () => fetchApi("/api/command", {
        method: "POST",
        body: JSON.stringify(body),
      });
      let data;
      try {
        data = await submitCommand();
      } catch (error) {
        if (command !== "create" || !isComputeReadRateLimitError(error)) {
          throw error;
        }
        const retryAfterSeconds = Math.max(5, Number(error.retryAfterSeconds || 65));
        setCommandStatus(
          `Compute Engine read quota is cooling down. Create was not retried yet; checking the VM after ${retryAfterSeconds}s.`,
          "warning",
        );
        await wait(retryAfterSeconds * 1000);
        const cooledStatus = await refreshStatus({ silent: true, forceRender: true });
        if (String(cooledStatus && cooledStatus.status || "").toUpperCase() !== "NOT_FOUND") {
          renderStatusPayload(cooledStatus);
          throw new Error("Create was not retried because the VM state changed while Compute Engine read quota was cooling down.");
        }
        setCommandStatus("Compute Engine read quota recovered. Retrying Create because no VM exists yet...", "warning");
        data = await submitCommand();
      }
      renderStatusPayload(data);
      if (COMMANDS_TO_POLL_AFTER_RESPONSE.has(command)) {
        // The command endpoint can return before the guest has written its
        // action metadata. Keep the accepted action visible until the first
        // live status poll replaces this optimistic transition.
        applyCommandTransition(command);
        renderOperationProgress(command, state.lastStatus);
        setCommandStatus(`Command "${command}" accepted. Waiting for current VM and Sunshine status...`, "warning");
        data = await waitForStatusSettled(command, data);
        renderStatusPayload(data);
      }
      if (COMMANDS_TO_POLL_AFTER_RESPONSE.has(command)) {
        await refreshInstances({ silent: true, autoSelect: command === "delete" });
      }

      clearScheduledCommandStatusRefresh();

      const suffix = data.duckdnsUpdated
        ? " DuckDNS refreshed."
        : "";
      const autoStop = data.autoStopHours
        ? ` ${autoStopSummary(data)}`
        : "";
      const powerActionPhase = String(data.powerAction && data.powerAction.phase ? data.powerAction.phase : "").toLowerCase();
      const bannerTone = powerActionPhase === "failed" ? "warning" : "success";
      setCommandStatus(`${commandCompletionMessage(command, data)}${suffix}${autoStop}`, bannerTone);
      broadcastActionStatus("settled", command);
      pushHistory({
        at: new Date().toISOString(),
        command,
        status: data.status,
        tone: "success",
        userEmail: state.user.email,
        message: historyMessage(data),
        duckdnsDomains: data.duckdnsDomains || [],
      });
    } catch (error) {
      clearScheduledCommandStatusRefresh();
      const message = commandFailureMessage(command, error);
      setCommandStatus(message, "error");
      setBanner(message, "error");
      broadcastActionStatus("failed", command);
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
      if (command === "install-minecraft") {
        state.pendingMinecraftServerType = "";
      }
      if (state.activeCommand === command) {
        state.activeCommand = "";
      }
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

  function getMinecraftServerTypes(payload) {
    const fromPayload = payload && payload.minecraft && Array.isArray(payload.minecraft.serverTypes)
      ? payload.minecraft.serverTypes
      : [];
    const fromConfig = state.backendConfig && state.backendConfig.minecraftServer && Array.isArray(state.backendConfig.minecraftServer.serverTypes)
      ? state.backendConfig.minecraftServer.serverTypes
      : [];
    return (fromPayload.length ? fromPayload : fromConfig).filter((type) => type && type.id);
  }

  function selectedMinecraftServerType() {
    return String(elements.minecraftServerTypeSelect && elements.minecraftServerTypeSelect.value || "").trim()
      || String(state.lastStatus && state.lastStatus.minecraft && state.lastStatus.minecraft.serverType || "paper");
  }

  function minecraftServerTypeLabel(serverType, payload) {
    const match = getMinecraftServerTypes(payload).find((type) => String(type.id) === String(serverType));
    if (!match) return String(serverType || "Paper");
    return `${match.label} (${match.contentLabel || `${match.contentKind}s`})`;
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
    if (elements.minecraftServerTypeSelect) {
      const types = getMinecraftServerTypes(payload);
      const installed = Boolean(payload && payload.minecraftStatus && payload.minecraftStatus.state && !["not_installed", "removed", "not_created"].includes(payload.minecraftStatus.state));
      const currentType = String(payload && payload.minecraft && payload.minecraft.serverType || "paper");
      const pendingType = String(state.pendingMinecraftServerType || "");
      const previousType = pendingType
        || elements.minecraftServerTypeSelect.value
        || elements.minecraftServerTypeSelect.dataset.savedValue
        || currentType;
      elements.minecraftServerTypeSelect.innerHTML = types.length
        ? types.map((type) => `<option value="${escapeHtml(type.id)}">${escapeHtml(`${type.label} (${type.contentLabel || `${type.contentKind}s`})`)}</option>`).join("")
        : '<option value="paper">Paper (plugins)</option>';
      elements.minecraftServerTypeSelect.value = installed && !pendingType && types.some((type) => type.id === currentType)
        ? currentType
        : types.some((type) => type.id === previousType) ? previousType : "paper";
      elements.minecraftServerTypeSelect.dataset.savedValue = "";
      elements.minecraftServerTypeSelect.disabled = installed;
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
      const runtimeType = state.pendingMinecraftServerType
        || (payload && payload.minecraft && payload.minecraft.serverType);
      const runtimeText = `Runtime: ${minecraftServerTypeLabel(runtimeType, payload)}.`;
      elements.minecraftOptionsStatus.textContent = `Minecraft status: ${label}. Server address: ${address}. ${runtimeText} ${versionText}${versionSource}${versionUpdatedAt}`;
    }
    updateActionAvailability();
  }

  async function refreshStatus(options) {
    const silent = Boolean(options && options.silent);
    const forceRender = Boolean(options && options.forceRender);
    const requestGeneration = Number(state.statusRequestGeneration || 0);
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
      // Status remains available during actions. A response started before a
      // lifecycle command must not overwrite the command's newer VM state.
      if (requestGeneration !== Number(state.statusRequestGeneration || 0)) {
        return null;
      }
      if (!forceRender && requestTargetKey !== selectedTargetKey()) {
        return data;
      }
      renderStatusPayload(data, requestTargetKey);
      if (state.activeCommand) {
        renderOperationProgress(state.activeCommand, data);
      }
      await refreshGpuCapacityReservationCount();
      if (!options || options.refreshInstances !== false) {
        try {
          await refreshInstances({ silent: true, autoSelect: false });
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
    if (!elements.access) {
      return;
    }
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
    const sunshineUrl = String(payload.urls && payload.urls.sunshine ? payload.urls.sunshine : "");
    const minecraftAddress = String(payload.urls && payload.urls.minecraft ? payload.urls.minecraft : "");
    const sunshineOpenUrl = primaryDuckDns && primaryDuckDns.sunshine ? primaryDuckDns.sunshine : sunshineUrl;
    const sunshineUrlLabel = primaryDuckDns && primaryDuckDns.sunshine === sunshineUrl
      ? "DNS URL"
      : "URL";
    const sunshineUrlEscaped = escapeHtml(sunshineUrl);
    const sunshineOpenUrlEscaped = escapeHtml(sunshineOpenUrl);
    const minecraftAddressEscaped = escapeHtml(minecraftAddress);
    const sunshineCredentials = payload.sunshineCredentials || {};
    const sunshineDnsMeta = primaryDuckDns && primaryDuckDns.sunshine && primaryDuckDns.sunshine !== sunshineUrl
      ? `<p class="access-meta">DNS URL: <code>${escapeHtml(primaryDuckDns.sunshine)}</code></p>`
      : "";
    const sunshineUserMeta = sunshineCredentials.username
      ? `<p class="access-meta">Username: <code>${escapeHtml(sunshineCredentials.username)}</code></p>`
      : "";
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
    minecraftManagementUrl.searchParams.set("endpointId", selectedEndpointId());
    if (minecraftManagement.selectedServerId) minecraftManagementUrl.searchParams.set("minecraftServerId", String(minecraftManagement.selectedServerId));
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
          <p class="access-meta">Password: <code>managed in the administrator panel</code></p>
        </article>

        <article class="access-card accent">
          <h3>Browser Desktop</h3>
          <p>Browser desktop access is restricted to administrators through Google IAP.</p>
          <p class="access-meta">Open the Administration panel to obtain the authorized local tunnel command.</p>
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
      return 0;
    }
    try {
      const data = await fetchApi("/api/capacity-reservations", { method: "GET" });
      const count = Math.max(0, Number.parseInt(data && data.reservedGpuCount, 10) || 0);
      renderGpuCapacityReservationCount(count);
      const resultRun = state.scanCreateResultRun;
      if (count === 0 && resultRun && resultRun.finished && !resultRun.linksUnlocked) {
        resultRun.linksUnlocked = true;
        renderScanCreateResults(resultRun);
      }
      return count;
    } catch (error) {
      console.warn("Failed to refresh GPU capacity reservation count.", error);
      return null;
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
    setCapacityButtonResult(elements.checkGpuCapacity, "Reserve Selected GPU Capacity", "neutral");
  }

  async function checkGpuCapacity() {
    const target = selectedTargetParams();
    if (!target.hardwareId || !target.zone || !target.gpuType || Number(target.gpuCount || 0) <= 0) {
      const message = "Select a GPU hardware profile and zone before checking capacity.";
      setCapacityButtonResult(elements.checkGpuCapacity, "GPU Reservation Unavailable", "error");
      setCommandStatus(message, "error");
      setBanner(message, "error");
      return;
    }

    const loadingToken = setPageLoading("Checking GPU capacity...");
    try {
      setBusy(true);
      setCapacityButtonResult(elements.checkGpuCapacity, "Reserving Selected GPU...", "neutral");
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
      setCapacityButtonResult(elements.checkGpuCapacity, "Selected GPU Reserved", "success");
      setCommandStatus(message, "success");
      setBanner(message, "success");
    } catch (error) {
      const message = commandFailureMessage("check-gpu-capacity", error);
      setCapacityButtonResult(elements.checkGpuCapacity, "GPU Reservation Unavailable", "error");
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
      setCapacityButtonResult(elements.releaseGpuCapacity, "Releasing GPU Reservations...", "neutral");
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
        failed ? "Release GPU Reservations Failed" : "GPU Reservations Released",
        failed ? "error" : "success",
      );
      setCommandStatus(message, failed ? "error" : "success");
      setBanner(message, failed ? "error" : "success");
    } catch (error) {
      const message = commandFailureMessage("release-gpu-capacity-reservations", error);
      setCapacityButtonResult(elements.releaseGpuCapacity, "Release GPU Reservations Failed", "error");
      setCommandStatus(message, "error");
      setBanner(message, "error");
    } finally {
      await refreshGpuCapacityReservationCount();
      setBusy(false);
      markPageReady("Ready.", loadingToken);
    }
  }

  if (elements.autoCreateFirstGpu) {
    const savedAutoCreate = window.localStorage.getItem("vm-control-auto-create-first-gpu");
    elements.autoCreateFirstGpu.checked = savedAutoCreate === null ? true : savedAutoCreate === "true";
    elements.autoCreateFirstGpu.addEventListener("change", () => {
      window.localStorage.setItem("vm-control-auto-create-first-gpu", String(elements.autoCreateFirstGpu.checked));
    });
  }

  if (elements.startSelectedFirstGpu) {
    elements.startSelectedFirstGpu.checked = false;
    elements.startSelectedFirstGpu.addEventListener("change", () => {
      if (elements.startSelectedFirstGpu.checked && !selectedStartScanSource()) {
        elements.startSelectedFirstGpu.checked = false;
        setCommandStatus("Select a TERMINATED GPU VM in Created instances first.", "warning");
      }
      const source = selectedStartScanSource();
      if (elements.startSelectedFirstGpu.checked && source && source.hardware && source.hardware.id) {
        state.gpuScanProfileIds = [String(source.hardware.id)];
        state.gpuScanProfilesCustomized = true;
        renderGpuScanProfileOptions();
      }
      updateGpuAvailabilityScanButton();
    });
  }

  [elements.scanCreateResults, elements.pageLoaderScanResults].filter(Boolean).forEach((container) => {
    container.addEventListener("click", (event) => {
      const button = event.target.closest("[data-reserve-candidate]");
      if (button) reserveScanCandidate(Number(button.dataset.reserveCandidate));
    });
  });

  if (!embeddedVmControl) {
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
  }

  if (embeddedVmControl) {
    const syncEmbeddedSession = async (force) => {
      const token = window.sessionStorage.getItem(storageKeys.sessionToken) || "";
      if (!token) {
        if (state.user) {
          state.token = "";
          state.user = null;
          updateAuthUi();
        }
        return;
      }
      if (!force && state.user && state.token === token) return;
      if (state.isBusy) return;
      state.token = token;
      try {
        setBusy(true);
        await connectBackend({ silent: true });
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
        markPageReady("Ready.");
      }
    };
    window.addEventListener("vm-control:session-changed", () => { void syncEmbeddedSession(true); });
    window.addEventListener("vm-control:tab-activated", (event) => {
      if (event.detail && event.detail.tab === "vm-control") {
        void syncEmbeddedSession(true);
      }
    });
  }

  if (elements.refreshStatus) {
    elements.refreshStatus.addEventListener("click", async () => {
      try {
        const data = await refreshStatus({ silent: true });
        if (!data) {
          return;
        }
        const activeCommand = String(state.activeCommand || "");
        setCommandStatus(
          statusBannerMessage(activeCommand ? `Command "${activeCommand}" still updating` : "VM status loaded", data),
          activeCommand ? "warning" : statusMessageTone(data),
        );
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
        const loadingToken = state.isPageLoading ? null : setPageLoading("Refreshing VM status...");
        try {
          const data = await refreshStatus({ silent: true });
          if (!data) {
            return;
          }
          const activeCommand = String(state.activeCommand || "");
          setCommandStatus(
            statusBannerMessage(activeCommand ? `Command "${activeCommand}" still updating` : "VM status loaded", data),
            activeCommand ? "warning" : statusMessageTone(data),
          );
        } catch (error) {
          handleError(error);
        } finally {
          if (loadingToken) {
            markPageReady("Ready.", loadingToken);
          }
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

  if (elements.minecraftVersionSelect) {
    elements.minecraftVersionSelect.addEventListener("change", () => {
      saveConfig();
      renderMinecraftOptions(state.lastStatus);
    });
  }

  if (elements.minecraftServerTypeSelect) {
    elements.minecraftServerTypeSelect.addEventListener("change", () => {
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

  if (elements.endpointSelect) {
    elements.endpointSelect.addEventListener("change", async () => {
      const loadingToken = setPageLoading("Loading selected public endpoint...");
      state.selectedEndpointId = String(elements.endpointSelect.value || "").trim();
      state.endpointSelectionLocked = true;
      resetGpuAvailabilityScan();
      resetGpuCapacityProbeButton();
      try {
        setBusy(true);
        applySelectedEndpoint();
        saveConfig();
        renderTargetSummary();
        if (state.user) {
          await refreshPriceEstimate({ silent: false });
          await refreshStatus({ silent: true });
          await refreshInstances({ silent: true });
        }
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
      resetSelectedZoneGpuAvailabilityScan();
      renderHardwareOptions(state.hardwarePayload);
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
      const restoringZones = Boolean(state.gpuAvailabilityScan);
      const scope = selectedGpuScanScope();
      const profiles = selectedGpuScanProfiles();
      const targetCount = gpuScanTargetCount(profiles, scope);
      if (!restoringZones && profiles.length > 1 && !window.confirm(`This will create and immediately release ${targetCount} short-lived GPU capacity reservations for ${profiles.length} selected GPU profiles. It may take several minutes and may be cancelled. Continue?`)) {
        setCommandStatus("Selected GPU capacity scan cancelled before it started.", "neutral");
        return;
      }
      const loadingToken = setPageLoading(restoringZones
        ? "Restoring compatible GPU zones..."
        : scope === "all"
          ? "Scanning selected GPU capacity across all compatible zones..."
          : `Scanning selected GPU capacity in ${gpuScanScopeLabel(scope)}...`);
      try {
        setBusy(true);
        await scanSelectedGpuProfilesAcrossZones({ confirmed: true });
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
        markPageReady("Ready.", loadingToken);
      }
    });
  }

  if (elements.gpuScanScope) {
    elements.gpuScanScope.addEventListener("change", async () => {
      if (!state.gpuAvailabilityScan) {
        renderGpuScanProfileOptions();
        updateGpuAvailabilityScanButton();
        return;
      }
      const loadingToken = setPageLoading("Updating GPU scan scope...");
      try {
        // Prevent the asynchronous scope reset from racing a new scan.
        setBusy(true);
        resetGpuAvailabilityScan();
        renderZoneOptions();
        renderGpuScanProfileOptions();
        await refreshPriceEstimate({ silent: false });
        await refreshStatus({ silent: true });
        setCommandStatus("GPU scan scope changed. All compatible zones are shown again.", "success");
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
        updateGpuAvailabilityScanButton();
        markPageReady("Ready.", loadingToken);
      }
    });
  }

  if (elements.gpuScanProfiles) {
    elements.gpuScanProfiles.addEventListener("click", (event) => {
      const button = event.target.closest("[data-hardware-select]");
      if (!button || !elements.hardwareSelect || button.disabled) {
        return;
      }
      const hardwareId = String(button.dataset.hardwareSelect || "");
      if (!hardwareId || elements.hardwareSelect.value === hardwareId) {
        return;
      }
      if (elements.hardwarePicker) {
        elements.hardwarePicker.open = false;
      }
      elements.hardwareSelect.value = hardwareId;
      elements.hardwareSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    elements.gpuScanProfiles.addEventListener("change", (event) => {
      const input = event.target.closest('input[type="checkbox"]');
      if (!input) {
        return;
      }
      state.gpuScanProfilesCustomized = true;
      state.gpuScanProfileIds = Array.from(elements.gpuScanProfiles.querySelectorAll('input[type="checkbox"]:checked'))
        .map((checkbox) => String(checkbox.value));
      resetGpuAvailabilityScan();
      renderZoneOptions();
      renderGpuScanProfileOptions();
      updateGpuAvailabilityScanButton();
    });
  }

  if (elements.checkGpuCapacity) {
    elements.checkGpuCapacity.addEventListener("click", checkGpuCapacity);
  }

  if (elements.scanSelectedGpu) {
    elements.scanSelectedGpu.addEventListener("click", async () => {
      const restoringProfiles = Boolean(activeSelectedZoneGpuAvailabilityScan(selectedZone()));
      const loadingToken = setPageLoading(restoringProfiles ? "Restoring declared GPU profiles..." : "Scanning all GPU profiles in the selected zone...");
      try {
        setBusy(true);
        updateGpuAvailabilityScanButton();
        await scanSelectedZoneGpuAvailability();
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
        updateGpuAvailabilityScanButton();
        markPageReady("Ready.", loadingToken);
      }
    });
  }

  if (elements.scanAllGpuZones) {
    elements.scanAllGpuZones.addEventListener("click", async () => {
      const restoringCatalog = Boolean(activeAllGpuZoneAvailabilityScan());
      const profiles = eligibleGpuScanProfiles();
      const targetCount = profiles.reduce((total, profile) => total + profile.zones.length, 0);
      if (!restoringCatalog && profiles.length && !window.confirm(`This will create and immediately release ${targetCount} short-lived GPU capacity reservations across ${profiles.length} GPU profiles. It can take several minutes and may be cancelled. Continue?`)) {
        setCommandStatus("Full GPU capacity scan cancelled before it started.", "neutral");
        return;
      }
      const loadingToken = setPageLoading(restoringCatalog ? "Restoring all configured GPU profiles and zones..." : "Scanning all configured GPU profiles in all compatible zones...");
      try {
        setBusy(true);
        updateGpuAvailabilityScanButton();
        await scanAllGpuZoneAvailability({ confirmed: true });
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
        updateGpuAvailabilityScanButton();
        markPageReady("Ready.", loadingToken);
      }
    });
  }

  if (elements.pauseGpuScan) {
    elements.pauseGpuScan.addEventListener("click", pauseGpuAvailabilityScan);
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
      await requestAdminSessionFromOpener();
      setBusy(false);
      if (!state.backendUrl) {
        return;
      }
      setBusy(true);
      await connectBackend({ silent: true });
      schedulePassiveStatusRefresh(1000);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
      markPageReady("Ready.");
    }
  }

  boot();
})();
