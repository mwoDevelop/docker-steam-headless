(function () {
  const defaultBackendUrl = "https://steam-vm-control-api-w2urpq2xlq-lm.a.run.app";
  const storageKeys = {
    config: "vm-control-cloudrun-config",
    sessionToken: "vm-control-google-session-token",
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
    refreshRuntimeImages: document.querySelector("#refresh-runtime-images"),
    runtimeEndpoint: document.querySelector("#runtime-endpoint"),
    runtimeImagesList: document.querySelector("#runtime-images-list"),
  };

  const state = {
    backendUrl: "",
    backendConfig: null,
    googleInitializedFor: "",
    googleTokenClient: null,
    token: "",
    user: null,
    isBusy: false,
    usersPayload: null,
    endpointsPayload: null,
    runtimeImagesPayload: null,
    refreshRevision: 0,
    automaticRefreshInFlight: false,
  };
  let automaticRefreshTimer = 0;

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

  function setBusy(nextBusy) {
    if (nextBusy && !state.isBusy) {
      state.refreshRevision += 1;
    }
    state.isBusy = nextBusy;
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
    elements.refreshRuntimeImages.disabled = nextBusy || !state.user;
    elements.runtimeEndpoint.disabled = nextBusy || !state.user;
    document.querySelectorAll("[data-runtime-action], [data-runtime-image-select]").forEach((input) => {
      input.disabled = nextBusy || !state.user || input.dataset.runtimeDisabled === "true";
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
    if (state.user) {
      setAuthStatus(`Signed in as ${state.user.email}`, "success");
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
    renderRuntimeImages();
    setBusy(state.isBusy);
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
    elements.adminSummary.innerHTML = `
      <p><strong>Admin:</strong> <code>${escapeHtml((payload.adminEmails || []).join(", ") || "none")}</code></p>
      <p><strong>Configured users:</strong> <code>${escapeHtml((payload.configuredEmails || []).join(", ") || "none")}</code></p>
      <p><strong>Configured domains:</strong> <code>${escapeHtml((payload.configuredDomains || []).join(", ") || "none")}</code></p>
    `;
    const rows = payload.accounts || [
      ...(payload.adminEmails || []).map((email) => ({ email, source: "administrator", minecraftManagement: true, minecraftManagementLocked: true, administrator: true, administratorLocked: true, removable: false })),
      ...(payload.configuredEmails || []).map((email) => ({ email, source: "configured env", minecraftManagement: false, minecraftManagementLocked: false, administrator: false, administratorLocked: false, removable: false })),
      ...(payload.managedUsers || []).map((email) => ({ email, source: "managed", minecraftManagement: Boolean((payload.managedUserPermissions || {})[email]), minecraftManagementLocked: false, administrator: Boolean((payload.managedUserAdministratorPermissions || {})[email]), administratorLocked: false, removable: true })),
    ];
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
      const ip = String(endpoint.staticIp || "").trim();
      const zone = String(endpoint.zone || "").trim();
      const region = String(endpoint.region || "").trim();
      const canReserve = !ip && !vm;
      const canRelease = Boolean(ip) && !vm;
      const canRemove = !ip && !vm && id !== "mwo-vm1";
      return `
        <div class="admin-user-row fixed" data-endpoint-row="${escapeHtml(id)}">
          <div><code>${escapeHtml(id)}</code><br><span>${escapeHtml(endpoint.domain || "")}</span><br><span>${escapeHtml(ip ? `IP ${ip}` : "IP not reserved")}${region ? ` · ${escapeHtml(region)}` : ""}${vm ? ` · VM ${escapeHtml(vm)}` : ""}</span></div>
          <label class="access-meta" title="Used only when reserving a new regional IP; it is not a DNS-to-VM assignment.">IP reservation zone <input data-endpoint-zone="${escapeHtml(id)}" data-endpoint-disabled="${canReserve ? "false" : "true"}" type="text" value="${escapeHtml(zone)}" placeholder="Choose zone" ${canReserve ? "" : "disabled"}></label>
          <button class="action start" type="button" data-endpoint-action="reserve-ip" data-endpoint-id="${escapeHtml(id)}" data-endpoint-disabled="${canReserve ? "false" : "true"}" ${canReserve ? "" : "disabled"}>Reserve IP</button>
          <button class="action delete" type="button" data-endpoint-action="release-ip" data-endpoint-id="${escapeHtml(id)}" data-endpoint-disabled="${canRelease ? "false" : "true"}" ${canRelease ? "" : "disabled"}>Release IP</button>
          <button class="action delete" type="button" data-endpoint-action="remove" data-endpoint-id="${escapeHtml(id)}" data-endpoint-disabled="${canRemove ? "false" : "true"}" ${canRemove ? "" : "disabled"}>Remove</button>
        </div>
      `;
    }).join("");
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
    const previousSelection = String(elements.runtimeEndpoint.value || "");
    elements.runtimeEndpoint.innerHTML = payload.endpoints.map((endpoint) => {
      const id = String(endpoint.id || "");
      const label = `${id} · ${endpoint.domain || "no DNS"}${endpoint.instanceName ? ` · ${endpoint.instanceName}` : ""}`;
      return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
    }).join("");
    const selectedId = payload.endpoints.some((endpoint) => endpoint.id === previousSelection)
      ? previousSelection
      : String(payload.endpoints[0] && payload.endpoints[0].id || "");
    elements.runtimeEndpoint.value = selectedId;
    const endpoint = payload.endpoints.find((entry) => entry.id === selectedId);
    if (!endpoint) {
      elements.runtimeImagesList.innerHTML = '<div class="admin-user-row fixed">No endpoints configured.</div>';
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
      await loadUsers();
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
  }

  window.addEventListener("message", async (event) => {
    if (event.origin !== window.location.origin || event.data?.type !== adminSessionResponse) return;
    const token = String(event.data.token || "");
    if (!token) return;
    storeSessionToken(token);
    if (!state.backendConfig) return;
    try {
      setBusy(true);
      await loadUsers();
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
    state.usersPayload = null;
    state.endpointsPayload = null;
    state.runtimeImagesPayload = null;
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
      await loadUsers();
    } catch (error) {
      clearSession();
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  function handleGoogleOAuthError(error) {
    clearSession();
    handleError(new Error(error && error.type ? `Google sign-in failed: ${error.type}` : "Google sign-in failed."));
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
      if (response.status === 401 || response.status === 403) {
        state.user = null;
      }
      throw new Error((payload && payload.error) || `API returned ${response.status}.`);
    }
    return payload;
  }

  async function loadUsers(options) {
    const silent = Boolean(options && options.silent);
    const refreshRevision = state.refreshRevision;
    const [payload, endpoints, runtimeImages] = await Promise.all([
      fetchApi("/api/admin/users", { method: "GET" }),
      fetchApi("/api/admin/endpoints", { method: "GET" }),
      fetchApi("/api/admin/runtime-images", { method: "GET" }),
    ]);
    if (refreshRevision !== state.refreshRevision) {
      return false;
    }
    state.user = payload.user;
    state.usersPayload = payload;
    state.endpointsPayload = endpoints;
    state.runtimeImagesPayload = runtimeImages;
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
