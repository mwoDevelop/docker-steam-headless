(function () {
  const defaultBackendUrl = "https://steam-vm-control-api-w2urpq2xlq-lm.a.run.app";
  const storageKeys = {
    config: "vm-control-cloudrun-config",
    sessionToken: "vm-control-google-session-token",
  };
  const adminSessionRequest = "vm-control-admin-session-request";
  const adminSessionResponse = "vm-control-admin-session-response";

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
    adminMessage: document.querySelector("#admin-message"),
    usersList: document.querySelector("#users-list"),
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
  };

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
    state.isBusy = nextBusy;
    elements.connect.disabled = nextBusy;
    elements.googleSignIn.disabled = nextBusy || !state.backendConfig;
    elements.addUser.disabled = nextBusy || !state.user;
    elements.userEmail.disabled = nextBusy || !state.user;
    document.querySelectorAll("[data-minecraft-management]").forEach((input) => {
      input.disabled = nextBusy || input.dataset.minecraftManagementLocked === "true";
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
      ...(payload.adminEmails || []).map((email) => ({ email, source: "administrator", minecraftManagement: true, minecraftManagementLocked: true, removable: false })),
      ...(payload.configuredEmails || []).map((email) => ({ email, source: "configured env", minecraftManagement: false, minecraftManagementLocked: false, removable: false })),
      ...(payload.managedUsers || []).map((email) => ({ email, source: "managed", minecraftManagement: Boolean((payload.managedUserPermissions || {})[email]), minecraftManagementLocked: false, removable: true })),
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
      return `
        <div class="admin-user-row ${row.removable ? "" : "fixed"}">
          <div><code>${escapeHtml(row.email)}</code><br><span>${escapeHtml(row.source)}</span></div>
          ${managementToggle}
          ${button}
        </div>
      `;
    }).join("");
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
    storeSessionToken("");
    state.user = null;
    state.usersPayload = null;
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

  async function loadUsers() {
    const payload = await fetchApi("/api/admin/users", { method: "GET" });
    state.user = payload.user;
    state.usersPayload = payload;
    setMessage("Managed GUI users loaded.", "success");
    updateUi();
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
        : `Updated Minecraft management access for ${email}.`;
    setMessage(message, "success");
    renderUsers();
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
