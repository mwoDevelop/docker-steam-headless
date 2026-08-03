(function () {
  const defaultBackendUrl = "https://steam-vm-control-api-w2urpq2xlq-lm.a.run.app";
  const storageKeys = {
    config: "vm-control-cloudrun-config",
    sessionToken: "vm-control-google-session-token",
    sessionTokenExpiresAt: "vm-control-google-session-token-expires-at",
  };
  const adminSessionRequest = "vm-control-admin-session-request";
  const adminSessionResponse = "vm-control-admin-session-response";

  const elements = {
    appShell: document.querySelector("#app-shell"),
    pageLoader: document.querySelector("#page-loader"),
    pageLoaderMessage: document.querySelector("#page-loader-message"),
    backendUrl: document.querySelector("#backend-url"),
    form: document.querySelector("#settings-form"),
    connect: document.querySelector("#connect"),
    authStatus: document.querySelector("#auth-status"),
    googleSignIn: document.querySelector("#google-sign-in"),
    signOut: document.querySelector("#sign-out"),
    administrationLink: document.querySelector("#administration-link"),
    targetSummary: document.querySelector("#target-summary"),
    refreshInstances: document.querySelector("#refresh-instances"),
    instancesList: document.querySelector("#instances-list"),
    instancesStatus: document.querySelector("#instances-status"),
    access: document.querySelector("#access"),
  };

  const state = {
    backendUrl: "",
    backendConfig: null,
    googleInitializedFor: "",
    googleTokenClient: null,
    googleTokenRefreshHandlers: null,
    googleTokenRefreshPromise: null,
    token: "",
    tokenExpiresAt: 0,
    user: null,
    instances: [],
    reachabilityByEndpoint: {},
    isBusy: false,
  };

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin || event.data?.type !== adminSessionRequest) return;
    event.source?.postMessage(
      {
        type: adminSessionResponse,
        token: state.token,
        expiresAt: state.tokenExpiresAt,
      },
      event.origin,
    );
  });

  function wait(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalizeBackendUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function setLoading(message) {
    document.body.classList.add("is-page-loading");
    elements.appShell?.setAttribute("aria-busy", "true");
    if (elements.pageLoaderMessage) elements.pageLoaderMessage.textContent = message;
  }

  function markReady(message) {
    document.body.classList.remove("is-page-loading");
    elements.appShell?.setAttribute("aria-busy", "false");
    if (elements.pageLoaderMessage) elements.pageLoaderMessage.textContent = message || "Ready.";
  }

  function setBusy(nextBusy) {
    state.isBusy = nextBusy;
    if (elements.connect) elements.connect.disabled = nextBusy;
    if (elements.googleSignIn) elements.googleSignIn.disabled = nextBusy || !state.backendConfig;
    if (elements.refreshInstances) elements.refreshInstances.disabled = nextBusy || !state.user;
  }

  function setAuthStatus(message, tone) {
    if (!elements.authStatus) return;
    elements.authStatus.textContent = message;
    elements.authStatus.dataset.tone = tone || "neutral";
  }

  function setInstancesStatus(message) {
    if (elements.instancesStatus) elements.instancesStatus.textContent = message;
  }

  function renderTargetSummary() {
    if (!elements.targetSummary) return;
    if (state.user) {
      const administration = state.user.isAdmin ? " Administrator access is available from the Administration button." : "";
      elements.targetSummary.innerHTML = "<p>Signed in for read-only instance and live-access information." + administration + "</p>";
      return;
    }
    elements.targetSummary.innerHTML = "<p>Sign in with Google to view running instances and public access addresses.</p>";
  }

  function renderAuthUi() {
    const signedIn = Boolean(state.user);
    elements.googleSignIn?.classList.toggle("hidden", signedIn);
    elements.signOut?.classList.toggle("hidden", !signedIn);
    elements.administrationLink?.classList.toggle("hidden", !state.user?.isAdmin);
    if (elements.backendUrl) {
      elements.backendUrl.type = signedIn ? "url" : "password";
      elements.backendUrl.value = state.backendUrl;
    }
    if (signedIn) {
      setAuthStatus("Signed in as " + state.user.email + ".", "success");
    } else if (state.backendConfig) {
      setAuthStatus("Backend connected. Sign in with Google to view status.", "neutral");
    } else {
      setAuthStatus("Connect the backend, then sign in with Google.", "neutral");
    }
    renderTargetSummary();
  }

  function loadConfig() {
    const saved = JSON.parse(window.localStorage.getItem(storageKeys.config) || "{}");
    state.backendUrl = normalizeBackendUrl(saved.backendUrl || defaultBackendUrl);
    state.token = window.sessionStorage.getItem(storageKeys.sessionToken) || "";
    state.tokenExpiresAt = Math.max(0, Number.parseInt(window.sessionStorage.getItem(storageKeys.sessionTokenExpiresAt) || "0", 10) || 0);
    elements.backendUrl.value = state.backendUrl;
  }

  function saveConfig() {
    state.backendUrl = normalizeBackendUrl(elements.backendUrl.value);
    const saved = JSON.parse(window.localStorage.getItem(storageKeys.config) || "{}");
    saved.backendUrl = state.backendUrl;
    window.localStorage.setItem(storageKeys.config, JSON.stringify(saved));
  }

  function storeSessionToken(token, expiresInSeconds) {
    state.token = String(token || "");
    if (!state.token) {
      state.tokenExpiresAt = 0;
      window.sessionStorage.removeItem(storageKeys.sessionToken);
      window.sessionStorage.removeItem(storageKeys.sessionTokenExpiresAt);
      return;
    }
    window.sessionStorage.setItem(storageKeys.sessionToken, state.token);
    const seconds = Number(expiresInSeconds);
    state.tokenExpiresAt = Number.isFinite(seconds) && seconds > 0 ? Date.now() + (seconds * 1000) : 0;
    if (state.tokenExpiresAt) {
      window.sessionStorage.setItem(storageKeys.sessionTokenExpiresAt, String(state.tokenExpiresAt));
    } else {
      window.sessionStorage.removeItem(storageKeys.sessionTokenExpiresAt);
    }
  }

  function clearSession() {
    storeSessionToken("");
    state.user = null;
    state.instances = [];
    state.reachabilityByEndpoint = {};
    renderAuthUi();
    renderInstances([]);
    renderLiveAccess([]);
  }

  async function waitForGoogleIdentity() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (window.google?.accounts?.oauth2) return;
      await wait(200);
    }
    throw new Error("Google Identity Services script did not load.");
  }

  async function initializeGoogle(clientId) {
    if (state.googleInitializedFor === clientId) return;
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

  async function refreshGoogleToken() {
    if (state.googleTokenRefreshPromise) return state.googleTokenRefreshPromise;
    if (!state.googleTokenClient) throw new Error("Google session refresh is unavailable. Sign in with Google again.");
    state.googleTokenRefreshPromise = new Promise((resolve, reject) => {
      state.googleTokenRefreshHandlers = { resolve, reject };
      state.googleTokenClient.requestAccessToken({ prompt: "" });
    }).finally(() => {
      state.googleTokenRefreshHandlers = null;
      state.googleTokenRefreshPromise = null;
    });
    return state.googleTokenRefreshPromise;
  }

  async function fetchApi(path, options, allowTokenRefresh) {
    const retry = allowTokenRefresh !== false;
    const headers = {
      Accept: "application/json",
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...(options?.headers || {}),
    };
    if (state.token) headers.Authorization = "Bearer " + state.token;
    const response = await window.fetch(state.backendUrl + path, {
      ...(options || {}),
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
      if ((response.status === 401 || response.status === 403) && retry && state.token) {
        try {
          await refreshGoogleToken();
          return fetchApi(path, options, false);
        } catch (error) {
          clearSession();
        }
      }
      throw new Error((payload && payload.error) || ("API returned " + response.status + "."));
    }
    return payload;
  }

  async function connectBackend() {
    saveConfig();
    if (!state.backendUrl) throw new Error("Cloud Run API URL is required.");
    const response = await window.fetch(state.backendUrl + "/api/config", {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(await response.text() || ("Backend returned " + response.status + "."));
    state.backendConfig = await response.json();
    if (!state.backendConfig.googleClientId) throw new Error("Backend is missing GOOGLE_CLIENT_ID.");
    await initializeGoogle(state.backendConfig.googleClientId);
    renderAuthUi();
    if (state.token) await restoreSessionAndRefresh();
  }

  async function restoreSessionAndRefresh() {
    const data = await fetchApi("/api/me", { method: "GET" });
    if (data?.session?.token) storeSessionToken(data.session.token, data.session.expiresInSeconds);
    state.user = data.user;
    renderAuthUi();
    await refreshInstances();
  }

  function serviceLabel(status, service) {
    const label = String(status?.label || "Unknown");
    const version = String(status?.version || "").trim();
    if (version && version.toUpperCase() !== "LATEST") return label + " · v" + version;
    return service === "sunshine" && !version ? label + " · version not detected" : label;
  }

  function runningInstances(instances) {
    return instances.filter((instance) => String(instance?.status || "").toUpperCase() === "RUNNING");
  }

  function renderInstances(instances) {
    if (!state.user) {
      elements.instancesList.className = "instance-list empty";
      elements.instancesList.textContent = "Sign in to load running instances.";
      setInstancesStatus("Running instances are loaded from Compute Engine after Google sign-in.");
      return;
    }
    const running = runningInstances(instances);
    if (!running.length) {
      elements.instancesList.className = "instance-list empty";
      elements.instancesList.textContent = "No running instances found.";
      setInstancesStatus("Refresh completed.");
      return;
    }
    elements.instancesList.className = "instance-list";
    elements.instancesList.innerHTML = running.map((instance) => {
      const hardware = instance.hardware || {};
      const hardwareLabel = hardware.label || hardware.id || (Number(hardware.gpuCount || 0) > 0 ? hardware.gpuType : "CPU");
      const ip = instance.externalIp ? " · " + escapeHtml(instance.externalIp) : "";
      return "<article class=\"instance-card\">"
        + "<span class=\"instance-card-title\">" + escapeHtml(instance.name) + " · " + escapeHtml(instance.zone) + "</span>"
        + "<span class=\"instance-card-meta\">" + escapeHtml(hardwareLabel) + " · " + escapeHtml(hardware.machineType || "machine") + " · RUNNING" + ip + "</span>"
        + "<span class=\"instance-card-meta\">Sunshine: " + escapeHtml(serviceLabel(instance.sunshineStatus, "sunshine")) + "</span>"
        + "<span class=\"instance-card-meta\">Minecraft: " + escapeHtml(serviceLabel(instance.minecraftStatus, "minecraft")) + "</span>"
        + "</article>";
    }).join("");
    setInstancesStatus(running.length + " running instance" + (running.length === 1 ? "" : "s") + " found.");
  }

  function endpointForInstance(instance) {
    const endpoints = Array.isArray(state.backendConfig?.endpoints) ? state.backendConfig.endpoints : [];
    return endpoints.find((endpoint) => String(endpoint?.instanceName || "").trim() === String(instance?.name || "").trim()) || null;
  }

  function reachabilityStatus(probe) {
    if (!probe) {
      return "<span class=\"service-status starting reachability-status\"><span class=\"service-status-dot\"></span>Checking reachability...</span>";
    }
    if (probe.error) {
      return "<span class=\"service-status error reachability-status\" title=\"" + escapeHtml(probe.error) + "\"><span class=\"service-status-dot\"></span>Check failed</span>";
    }
    const status = String(probe.state || "unreachable").toLowerCase();
    const className = status === "healthy" ? "ready" : (["degraded", "restricted"].includes(status) ? "starting" : "error");
    const label = String(probe.label || (status === "healthy" ? "Reachable" : "Unreachable"));
    const detail = String(probe.detail || "");
    const visibleLabel = detail ? label + ": " + detail : label;
    return "<span class=\"service-status " + className + " reachability-status\" title=\"" + escapeHtml(detail) + "\"><span class=\"service-status-dot\"></span>" + escapeHtml(visibleLabel) + "</span>";
  }

  function missingEndpointReachability() {
    return {
      sunshine: { state: "unreachable", label: "Unreachable", detail: "No managed DNS endpoint is assigned." },
      novnc: { state: "unreachable", label: "Unreachable", detail: "No managed DNS endpoint is assigned." },
      minecraft: { state: "unreachable", label: "Unreachable", detail: "No managed DNS endpoint is assigned." },
    };
  }

  function renderLiveAccess(instances) {
    if (!state.user) {
      elements.access.className = "access empty";
      elements.access.textContent = "Sign in to load live access details.";
      return;
    }
    const running = runningInstances(instances);
    if (!running.length) {
      elements.access.className = "access empty";
      elements.access.textContent = "Live access links appear when an instance is running.";
      return;
    }
    elements.access.className = "access";
    elements.access.innerHTML = "<div class=\"access-grid\">"
      + running.map((instance) => {
        const endpoint = endpointForInstance(instance);
        const reachability = endpoint
          ? state.reachabilityByEndpoint[String(endpoint.id || "")]?.services || state.reachabilityByEndpoint[String(endpoint.id || "")]
          : missingEndpointReachability();
        const host = String(endpoint?.domain || instance.externalIp || "").trim();
        const hostHtml = escapeHtml(host || "External address not assigned");
        const sunshineUrl = host ? "https://" + host + ":47990/" : "";
        const minecraftAddress = host ? host + ":25565" : "External address not assigned";
        const sunshineLink = sunshineUrl
          ? "<div class=\"access-links\"><a href=\"" + escapeHtml(sunshineUrl) + "\" target=\"_blank\" rel=\"noreferrer\">Open Sunshine UI</a></div>"
          : "";
        return "<article class=\"access-card accent\">"
          + "<h3>" + escapeHtml(instance.name) + " · " + escapeHtml(instance.zone) + "</h3>"
          + "<p class=\"access-meta\">Host: <code>" + hostHtml + "</code></p>"
          + "<p class=\"access-meta\">Sunshine: <code>" + escapeHtml(serviceLabel(instance.sunshineStatus, "sunshine")) + "</code></p>"
          + sunshineLink
          + (sunshineUrl ? "<p class=\"access-meta\">Sunshine URL: <code>" + escapeHtml(sunshineUrl) + "</code>" + reachabilityStatus(reachability?.sunshine) + "</p>" : "")
          + "<p class=\"access-meta\">Browser desktop: <code>administrator access through Google IAP</code>" + reachabilityStatus(reachability?.novnc) + "</p>"
          + "<p class=\"access-meta\">Minecraft: <code>" + escapeHtml(minecraftAddress) + "</code> · " + escapeHtml(serviceLabel(instance.minecraftStatus, "minecraft")) + reachabilityStatus(reachability?.minecraft) + "</p>"
          + "</article>";
      }).join("")
      + "</div>";
  }

  async function refreshReachability(instances) {
    const endpoints = runningInstances(instances)
      .map((instance) => endpointForInstance(instance))
      .filter((endpoint) => endpoint?.id);
    state.reachabilityByEndpoint = {};
    for (const endpoint of endpoints) state.reachabilityByEndpoint[String(endpoint.id)] = {};
    renderLiveAccess(instances);
    await Promise.all(endpoints.map(async (endpoint) => {
      const endpointId = String(endpoint.id);
      try {
        state.reachabilityByEndpoint[endpointId] = await fetchApi("/api/reachability?endpointId=" + encodeURIComponent(endpointId), { method: "GET" });
      } catch (error) {
        state.reachabilityByEndpoint[endpointId] = { error: error instanceof Error ? error.message : String(error || "Reachability check failed.") };
      }
    }));
    renderLiveAccess(instances);
  }

  async function refreshInstances() {
    if (!state.user) throw new Error("Sign in with Google first.");
    setInstancesStatus("Refreshing running instances...");
    const payload = await fetchApi("/api/instances", { method: "GET" });
    state.instances = Array.isArray(payload?.instances) ? payload.instances : [];
    renderInstances(state.instances);
    renderLiveAccess(state.instances);
    await refreshReachability(state.instances);
  }

  async function handleGoogleToken(response) {
    if (state.googleTokenRefreshHandlers) {
      if (response.error || !response.access_token) {
        state.googleTokenRefreshHandlers.reject(new Error(response.error_description || response.error || "Google session refresh failed."));
      } else {
        storeSessionToken(response.access_token, response.expires_in);
        state.googleTokenRefreshHandlers.resolve();
      }
      return;
    }
    try {
      if (response.error || !response.access_token) throw new Error(response.error_description || response.error || "Google sign-in failed.");
      setLoading("Verifying Google session...");
      setBusy(true);
      storeSessionToken(response.access_token, response.expires_in);
      await restoreSessionAndRefresh();
    } catch (error) {
      clearSession();
      handleError(error);
    } finally {
      setBusy(false);
      markReady("Ready.");
    }
  }

  function handleGoogleOAuthError(error) {
    const message = error?.type === "popup_closed"
      ? "Google sign-in popup was closed before authentication finished."
      : "Google sign-in failed: " + String(error?.type || "unknown error");
    setAuthStatus(message, "error");
    setBusy(false);
  }

  function handleError(error) {
    const message = error instanceof Error ? error.message : String(error || "Unknown error");
    setAuthStatus(message, "error");
    setInstancesStatus(message);
    if (state.user) renderLiveAccess(state.instances);
  }

  elements.form.addEventListener("input", saveConfig);
  elements.connect.addEventListener("click", async () => {
    try {
      setLoading("Connecting to Cloud Run backend...");
      setBusy(true);
      await connectBackend();
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
      markReady("Ready.");
    }
  });
  elements.googleSignIn.addEventListener("click", async () => {
    try {
      setBusy(true);
      if (!state.googleTokenClient) {
        if (!state.backendConfig?.googleClientId) throw new Error("Connect the backend before signing in.");
        await initializeGoogle(state.backendConfig.googleClientId);
      }
      state.googleTokenClient.requestAccessToken();
    } catch (error) {
      handleError(error);
      setBusy(false);
    }
  });
  elements.signOut.addEventListener("click", () => {
    clearSession();
    setAuthStatus("Google session cleared from this browser session.", "success");
  });
  elements.refreshInstances.addEventListener("click", async () => {
    try {
      setLoading("Refreshing running instances...");
      setBusy(true);
      await refreshInstances();
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
      markReady("Ready.");
    }
  });

  async function boot() {
    setLoading("Preparing read-only status...");
    try {
      loadConfig();
      renderAuthUi();
      if (state.backendUrl) {
        setBusy(true);
        await connectBackend();
      }
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
      markReady("Ready.");
    }
  }

  boot();
})();
