(function () {
  const defaultBackendUrl = "";

  const storageKeys = {
    config: "vm-control-cloudrun-config",
    sessionToken: "vm-control-google-session-token",
    history: "vm-control-session-history",
  };

  const elements = {
    backendUrl: document.querySelector("#backend-url"),
    connect: document.querySelector("#connect"),
    authStatus: document.querySelector("#auth-status"),
    googleSignIn: document.querySelector("#google-sign-in"),
    signOut: document.querySelector("#sign-out"),
    targetSummary: document.querySelector("#target-summary"),
    refreshStatus: document.querySelector("#refresh-status"),
    autoStopHours: document.querySelector("#auto-stop-hours"),
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
    isBusy: false,
    history: [],
  };

  function loadConfig() {
    const saved = JSON.parse(window.localStorage.getItem(storageKeys.config) || "{}");
    state.backendUrl = saved.backendUrl || defaultBackendUrl;
    state.token = window.sessionStorage.getItem(storageKeys.sessionToken) || "";
    state.history = JSON.parse(window.localStorage.getItem(storageKeys.history) || "[]");
    elements.backendUrl.value = state.backendUrl;
    renderHistory();
    renderTargetSummary();
    renderAccess(null);
    updateAuthUi();
  }

  function saveConfig() {
    state.backendUrl = sanitizeBackendUrl(elements.backendUrl.value);
    window.localStorage.setItem(
      storageKeys.config,
      JSON.stringify({
        backendUrl: state.backendUrl,
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
    elements.refreshStatus.disabled = nextBusy || !state.user;
    elements.autoStopHours.disabled = nextBusy || !state.user;
    elements.actionButtons.forEach((button) => {
      button.disabled = nextBusy || !state.user;
    });
  }

  function setBanner(message, tone) {
    elements.banner.textContent = message;
    elements.banner.dataset.tone = tone || "neutral";
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

    elements.targetSummary.innerHTML = `
      <p><strong>Backend:</strong> <code>${escapeHtml(state.backendUrl)}</code></p>
      <p><strong>Project:</strong> <code>${escapeHtml(target.project || "unknown")}</code></p>
      <p><strong>Zone:</strong> <code>${escapeHtml(target.zone || "unknown")}</code></p>
      <p><strong>Instance:</strong> <code>${escapeHtml(target.instance || "unknown")}</code></p>
      ${domains}
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
    updateAuthUi();

    if (!config.googleClientId) {
      throw new Error("Backend is missing GOOGLE_CLIENT_ID. Finish Cloud Run setup first.");
    }

    await initializeGoogle(config.googleClientId);
    setBanner("Backend connected. Sign in with Google to unlock VM control.", "success");

    if (state.token) {
      await restoreSession();
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

    setBusy(true);
    setBanner(`Running "${command}" on the VM...`, "warning");

    try {
      const body = { command };
      const autoStopHours = readAutoStopHours(command);
      if (autoStopHours) {
        body.autoStopHours = autoStopHours;
      }

      const data = await fetchApi("/api/command", {
        method: "POST",
        body: JSON.stringify(body),
      });
      state.lastStatus = data;
      renderAccess(data);

      const suffix = data.duckdnsUpdated
        ? " DuckDNS refreshed."
        : "";
      const autoStop = data.autoStopHours
        ? ` Auto-stop scheduled after ${data.autoStopHours}h.`
        : "";
      setBanner(`Command "${command}" completed. Final VM state: ${data.status}.${suffix}${autoStop}`, "success");
      pushHistory({
        at: new Date().toISOString(),
        command,
        status: data.status,
        tone: "success",
        userEmail: state.user.email,
        message: historyMessage(data),
        duckdnsDomains: data.duckdnsDomains || [],
      });
    } finally {
      setBusy(false);
    }
  }

  function readAutoStopHours(command) {
    if (command !== "start") {
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
    return parts.join(" · ");
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
      const data = await fetchApi("/api/status", { method: "GET" });
      state.lastStatus = data;
      renderAccess(data);
      if (!silent) {
        setBanner(`VM status loaded. Current state: ${data.status}.`, "success");
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

    if (payload.status !== "RUNNING") {
      elements.access.className = "access";
      elements.access.innerHTML = `
        <div class="access-grid">
          <article class="access-card">
            <h3>VM not running</h3>
            <p>The current backend status for <code>${escapeHtml(target)}</code> is <code>${escapeHtml(payload.status || "UNKNOWN")}</code>, so remote access links are not available right now.</p>
          </article>
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
      `;
      return;
    }

    const ip = escapeHtml(payload.externalIp);
    const novncUrl = payload.urls && payload.urls.novnc ? escapeHtml(payload.urls.novnc) : "";
    const sunshineUrl = payload.urls && payload.urls.sunshine ? escapeHtml(payload.urls.sunshine) : "";
    const sunshineCredentials = payload.sunshineCredentials || {};
    const duckdnsEntries = payload.urls && payload.urls.duckdns ? payload.urls.duckdns : [];
    const primaryDuckDns = duckdnsEntries.length ? duckdnsEntries[0] : null;
    const novncDnsMeta = primaryDuckDns && primaryDuckDns.novnc
      ? `<p class="access-meta">DNS URL: <code>${escapeHtml(primaryDuckDns.novnc)}</code></p>`
      : "";
    const sunshineDnsMeta = primaryDuckDns && primaryDuckDns.sunshine
      ? `<p class="access-meta">DNS URL: <code>${escapeHtml(primaryDuckDns.sunshine)}</code></p>`
      : "";
    const dnsHostMeta = primaryDuckDns && primaryDuckDns.domain
      ? `<p class="access-meta">DNS Host: <code>${escapeHtml(primaryDuckDns.domain)}</code></p>`
      : "";
    const sunshineUserMeta = sunshineCredentials.username
      ? `<p class="access-meta">Username: <code>${escapeHtml(sunshineCredentials.username)}</code></p>`
      : "";
    const sunshinePasswordMeta = sunshineCredentials.password
      ? `<p class="access-meta">Password: <code>${escapeHtml(sunshineCredentials.password)}</code></p>`
      : `<p class="access-meta">Password: <code>unavailable</code></p>`;

    elements.access.className = "access";
    elements.access.innerHTML = `
      <div class="access-grid">
        <article class="access-card accent">
          <h3>Browser Desktop</h3>
          <p>Best for first login, Steam setup, and recovery when streaming clients are not paired yet.</p>
          <div class="access-links">
            <a href="${novncUrl}" target="_blank" rel="noreferrer">Open noVNC</a>
          </div>
          <p class="access-meta">URL: <code>${novncUrl}</code></p>
          ${novncDnsMeta}
        </article>

        <article class="access-card accent">
          <h3>Sunshine Web UI</h3>
          <p>Use this to manage Sunshine, pair clients, and inspect streaming settings. Expect a browser certificate warning on first open.</p>
          <div class="access-links">
            <a href="${sunshineUrl}" target="_blank" rel="noreferrer">Open Sunshine UI</a>
          </div>
          <p class="access-meta">URL: <code>${sunshineUrl}</code></p>
          ${sunshineDnsMeta}
          ${sunshineUserMeta}
          ${sunshinePasswordMeta}
        </article>

        <article class="access-card">
          <h3>Moonlight / Sunshine Client</h3>
          <p>Add this host in Moonlight or another Sunshine-compatible client, then pair with the PIN shown by Sunshine.</p>
          <p class="access-meta">Host/IP: <code>${ip}</code></p>
          ${dnsHostMeta}
        </article>

        <article class="access-card">
          <h3>Steam Link / Steam Client</h3>
          <p>After Steam inside the VM signs in, the host should appear in Steam Link or Steam Remote Play. First-time setup is usually easiest through noVNC.</p>
          <p class="access-meta">Target: <code>${escapeHtml(target)}</code></p>
          ${dnsHostMeta}
        </article>
      </div>

      <p class="access-note">
        The VM can report <code>RUNNING</code> before the desktop and Sunshine finish booting. On a cold start, give noVNC and Sunshine up to a minute or two to become reachable.
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

  elements.refreshStatus.addEventListener("click", async () => {
    try {
      await refreshStatus();
    } catch (error) {
      handleError(error);
    }
  });

  elements.actionButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      if (state.isBusy) {
        return;
      }
      try {
        await dispatchCommand(button.dataset.command);
      } catch (error) {
        handleError(error);
      }
    });
  });

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
