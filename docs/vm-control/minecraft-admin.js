(function () {
  const storageKeys = {
    config: "vm-control-cloudrun-config",
    sessionToken: "vm-control-google-session-token",
  };
  const minecraftManagementSessionRequest = "vm-control-minecraft-session-request";
  const minecraftManagementSessionResponse = "vm-control-minecraft-session-response";
  const params = new URLSearchParams(window.location.search);
  const elements = {
    identity: document.querySelector("#manager-identity"),
    back: document.querySelector("#back-to-control"),
    heading: document.querySelector("#server-heading"),
    status: document.querySelector("#management-status"),
    notice: document.querySelector("#agent-notice"),
    refresh: document.querySelector("#refresh"),
    console: document.querySelector("#console-command"),
    consoleSuggestions: document.querySelector("#console-suggestions"),
    consolePlayerHints: document.querySelector("#console-player-hints"),
    consoleHintDescription: document.querySelector("#console-hint-description"),
    output: document.querySelector("#command-output"),
    actionButtons: [...document.querySelectorAll("[data-action]")],
    propertiesLoad: document.querySelector("#properties-load"),
    propertiesSave: document.querySelector("#properties-save"),
    propertyName: document.querySelector("#property-name"),
    propertyValue: document.querySelector("#property-value"),
    propertySuggestions: document.querySelector("#property-suggestions"),
    propertyDescription: document.querySelector("#property-description"),
    propertyValidation: document.querySelector("#property-validation"),
    propertyHelp: document.querySelector(".property-help"),
    contentHeading: document.querySelector("#content-heading"),
    contentRuntime: document.querySelector("#content-runtime"),
    contentSearchQuery: document.querySelector("#content-search-query"),
    contentSearch: document.querySelector("#content-search"),
    contentResults: document.querySelector("#content-results"),
    installedContentHeading: document.querySelector("#installed-content-heading"),
    installedContent: document.querySelector("#installed-content"),
  };
  const saved = JSON.parse(window.localStorage.getItem(storageKeys.config) || "{}");
  const state = {
    backend: String(params.get("backend") || saved.backendUrl || "").replace(/\/+$/, ""),
    token: window.sessionStorage.getItem(storageKeys.sessionToken) || "",
    endpointId: String(params.get("endpointId") || "mwo-vm1"),
    hardwareId: String(params.get("hardwareId") || ""),
    zone: String(params.get("zone") || ""),
    data: null,
    busy: false,
  };

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin || event.data?.type !== minecraftManagementSessionResponse) return;
    const token = String(event.data.token || "");
    if (!token) return;
    state.token = token;
    window.sessionStorage.setItem(storageKeys.sessionToken, token);
    refresh();
  });

  function targetQuery() {
    const target = new URLSearchParams();
    if (state.endpointId) target.set("endpointId", state.endpointId);
    if (state.hardwareId) target.set("hardwareId", state.hardwareId);
    if (state.zone) target.set("zone", state.zone);
    return target.toString();
  }

  function setBusy(busy) {
    state.busy = busy;
    elements.refresh.disabled = busy;
    elements.actionButtons.forEach((button) => { button.disabled = busy || !state.data || !state.data.agentReady; });
    if (elements.console) elements.console.disabled = busy || !state.data || !state.data.agentReady;
    document.querySelectorAll(".console-suggestion, .console-player-hint").forEach((button) => { button.disabled = busy || !state.data || !state.data.agentReady; });
    const propertiesLoaded = Boolean(state.data && state.data.serverProperties && state.data.serverProperties.loaded);
    if (elements.propertiesLoad) elements.propertiesLoad.disabled = busy || !state.data || !state.data.agentReady;
    if (elements.propertyName) elements.propertyName.disabled = busy || !propertiesLoaded;
    if (elements.propertyValue) elements.propertyValue.disabled = busy || !propertiesLoaded || !selectedServerProperty()?.editable;
    if (elements.propertiesSave) elements.propertiesSave.disabled = busy || !propertiesLoaded || !selectedServerProperty()?.editable || !validatePropertyValue(false);
    if (elements.contentSearch) elements.contentSearch.disabled = busy || !state.data || !state.data.agentReady;
    document.querySelectorAll("[data-content-action]").forEach((button) => { button.disabled = busy || !state.data || !state.data.agentReady; });
  }

  function setStatus(message, tone) {
    elements.status.textContent = message;
    elements.status.dataset.tone = tone || "neutral";
  }

  function cleanCommandOutput(value) {
    const cleaned = String(value || "")
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\r/g, "")
      .trim();
    return cleaned || "No output returned by the server.";
  }

  function setOutput(value) {
    elements.output.textContent = cleanCommandOutput(value);
  }

  function resultSummary(result, fallback) {
    if (!result || !result.id) return fallback || "Minecraft action completed.";
    const labels = {
      players: "Online players",
      "whitelist-list": "Whitelist",
      "op-list": "Server operators",
      "properties-read": "Server properties",
      "properties-update": "Server properties",
    };
    const label = labels[result.action] || result.action || "Minecraft action";
    const output = cleanCommandOutput(result.output);
    return output.toLowerCase().startsWith(`${label.toLowerCase()}:`) ? output : `${label}: ${output}`;
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character]);
  }

  function modrinthProjectUrl(item) {
    try {
      const url = new URL(String(item && item.projectUrl || ""));
      if (
        url.protocol === "https:"
        && url.hostname === "modrinth.com"
        && /^\/(?:plugin|mod)\/[A-Za-z0-9_-]+$/.test(url.pathname)
      ) {
        return url.toString();
      }
    } catch (_) {
      // Catalog data without a valid Modrinth address is rendered without a link.
    }
    return "";
  }

  async function api(path, options) {
    if (!state.backend) throw new Error("Cloud Run API URL is missing. Open this page through VM Control.");
    if (!state.token) throw new Error("Sign in to VM Control first, then open this page again.");
    const response = await fetch(`${state.backend}${path}`, {
      ...(options || {}),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${state.token}`,
        ...(options && options.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error((payload && payload.error) || `API returned ${response.status}.`);
    return payload;
  }

  function renderCatalog(results) {
    if (!results.length) {
      elements.contentResults.className = "content-list empty";
      elements.contentResults.textContent = "No compatible Modrinth content was found.";
      return;
    }
    elements.contentResults.className = "content-list";
    elements.contentResults.innerHTML = results.map((item) => {
      const projectUrl = modrinthProjectUrl(item);
      const projectLink = projectUrl
        ? `<a class="content-project-link" href="${escapeHtml(projectUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(projectUrl)}</a>`
        : "";
      return `
      <article class="content-item">
        <div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description || "No description available.")}</p><p class="content-meta">${escapeHtml(item.author || "Unknown author")} · ${Number(item.downloads || 0).toLocaleString()} downloads</p>${projectLink}</div>
        <button class="action create" type="button" data-content-action="install" data-project-id="${escapeHtml(item.projectId)}" data-title="${escapeHtml(item.title)}">Install</button>
      </article>`;
    }).join("");
    elements.contentResults.querySelectorAll("[data-content-action='install']").forEach((button) => button.addEventListener("click", () => runContentAction("content-install", button.dataset.projectId, button.dataset.title)));
  }

  function renderInstalledContent(content, runtime) {
    const kindLabel = runtime.contentLabel || `${runtime.contentKind || "content"}s`;
    elements.installedContentHeading.textContent = `Managed ${kindLabel}`;
    if (!content.length) {
      elements.installedContent.className = "content-list empty";
      elements.installedContent.textContent = `No Modrinth ${kindLabel} are installed.`;
      return;
    }
    elements.installedContent.className = "content-list";
    elements.installedContent.innerHTML = content.map((item) => {
      const projectUrl = modrinthProjectUrl(item);
      const projectLink = projectUrl
        ? `<a class="content-project-link" href="${escapeHtml(projectUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(projectUrl)}</a>`
        : "";
      return `
      <article class="content-item">
        <div><h3>${escapeHtml(item.title)}</h3><p class="content-meta">${escapeHtml(item.projectId)} · ${escapeHtml(item.version)}</p>${projectLink}</div>
        <button class="action delete" type="button" data-content-action="remove" data-project-id="${escapeHtml(item.projectId)}">Remove</button>
      </article>`;
    }).join("");
    elements.installedContent.querySelectorAll("[data-content-action='remove']").forEach((button) => button.addEventListener("click", () => runContentAction("content-remove", button.dataset.projectId, "")));
  }

  function serverProperties() {
    return Array.isArray(state.data && state.data.serverProperties && state.data.serverProperties.properties)
      ? state.data.serverProperties.properties
      : [];
  }

  function selectedServerProperty() {
    return serverProperties().find((property) => property.key === elements.propertyName?.value) || null;
  }

  function validatePropertyValue(showMessage = true) {
    const property = selectedServerProperty();
    if (!property || !property.editable) return false;
    const value = String(elements.propertyValue.value || "");
    let message = "";
    if (/\r|\n/.test(value) || value.length > 512) message = "Use one line up to 512 characters.";
    else if (property.kind === "boolean" && !["true", "false"].includes(value)) message = "Choose true or false.";
    else if (property.kind === "enum" && !(property.suggestions || []).includes(value)) message = `Choose one of: ${(property.suggestions || []).join(", ")}.`;
    else if (property.kind === "integer") {
      const numericValue = Number(value);
      if (!/^-?\d+$/.test(value) || !Number.isInteger(numericValue)) message = "Enter an integer.";
      else if (numericValue < property.minimum || numericValue > property.maximum) message = `Enter a value from ${property.minimum} to ${property.maximum}.`;
    }
    elements.propertyValue.setCustomValidity(message);
    if (showMessage) {
      elements.propertyValidation.textContent = message || (property.editable ? "Validation passed. Saving restarts Minecraft." : "Managed by the VM deployment; editing is disabled.");
      elements.propertyHelp.dataset.invalid = message ? "true" : "false";
    }
    return !message;
  }

  function renderPropertyEditor(resetValue = false) {
    const property = selectedServerProperty();
    if (!property) {
      elements.propertyValue.value = "";
      elements.propertySuggestions.innerHTML = "";
      elements.propertyDescription.textContent = "Options are read from the active server version.";
      elements.propertyValidation.textContent = "Load settings to edit an option.";
      elements.propertyHelp.dataset.invalid = "false";
      return;
    }
    if (resetValue) elements.propertyValue.value = property.value;
    elements.propertySuggestions.innerHTML = (property.suggestions || []).map((value) => `<option value="${escapeHtml(value)}"></option>`).join("");
    const limits = property.kind === "integer" ? ` Allowed range: ${property.minimum}-${property.maximum}.` : "";
    elements.propertyDescription.textContent = property.description;
    elements.propertyValidation.textContent = property.editable ? `Current value: ${property.value}.${limits} Saving restarts Minecraft.` : "Managed by the VM deployment; editing is disabled.";
    elements.propertyHelp.dataset.invalid = "false";
    elements.propertyValue.disabled = state.busy || !property.editable;
    validatePropertyValue(false);
  }

  function renderServerProperties(serverProperties) {
    const config = serverProperties || {};
    const properties = Array.isArray(config.properties) ? config.properties : [];
    const previous = elements.propertyName.value;
    if (!config.loaded || !properties.length) {
      elements.propertyName.innerHTML = '<option value="">Load settings first</option>';
      elements.propertyName.disabled = true;
      renderPropertyEditor(true);
      return;
    }
    elements.propertyName.innerHTML = properties.map((property) => `<option value="${escapeHtml(property.key)}">${escapeHtml(property.key)}${property.editable ? "" : " (managed)"}</option>`).join("");
    elements.propertyName.value = properties.some((property) => property.key === previous) ? previous : properties[0].key;
    elements.propertyName.disabled = state.busy;
    renderPropertyEditor(true);
  }

  function rconSuggestions() {
    const suggestions = state.data && state.data.rconSuggestions;
    return suggestions && typeof suggestions === "object" ? suggestions : { commands: [], onlinePlayers: [] };
  }

  function matchingConsoleCommands() {
    const typed = String(elements.console && elements.console.value || "").trim().toLowerCase();
    const commands = Array.isArray(rconSuggestions().commands) ? rconSuggestions().commands : [];
    if (!typed) return commands.slice(0, 8);
    const root = typed.replace(/^\/+/, "").split(/\s+/, 1)[0];
    return commands.filter((command) => String(command.command || "").startsWith(root) || String(command.template || "").startsWith(typed)).slice(0, 8);
  }

  function applyConsoleTemplate(template) {
    const value = String(template || "");
    elements.console.value = value;
    elements.console.focus();
    const placeholder = value.search(/[<[]/);
    elements.console.setSelectionRange(placeholder >= 0 ? placeholder : value.length, value.length);
    renderConsoleAssistant();
  }

  function applyPlayerHint(player) {
    const current = String(elements.console.value || "").trim();
    elements.console.value = current.includes("<player>")
      ? current.replace("<player>", player)
      : `${current}${current ? " " : ""}${player}`;
    elements.console.focus();
    renderConsoleAssistant();
  }

  function renderConsoleAssistant() {
    if (!elements.consoleSuggestions || !elements.consolePlayerHints) return;
    const suggestions = rconSuggestions();
    const commands = matchingConsoleCommands();
    elements.consoleSuggestions.innerHTML = commands.length
      ? commands.map((command) => `<button class="console-suggestion" type="button" data-template="${escapeHtml(command.template)}" data-description="${escapeHtml(command.description)}" data-risk="${command.dangerous ? "dangerous" : "safe"}">${escapeHtml(command.template)}</button>`).join("")
      : '<span class="section-meta">No matching managed command. You can still send a raw RCON command.</span>';
    elements.consoleSuggestions.querySelectorAll(".console-suggestion").forEach((button) => button.addEventListener("click", () => applyConsoleTemplate(button.dataset.template)));
    const players = Array.isArray(suggestions.onlinePlayers) ? suggestions.onlinePlayers : [];
    elements.consolePlayerHints.classList.toggle("hidden", players.length === 0);
    elements.consolePlayerHints.innerHTML = players.length
      ? `<span class="section-meta">Online players:</span>${players.map((player) => `<button class="console-player-hint" type="button" data-player="${escapeHtml(player)}">${escapeHtml(player)}</button>`).join("")}`
      : "";
    elements.consolePlayerHints.querySelectorAll(".console-player-hint").forEach((button) => button.addEventListener("click", () => applyPlayerHint(button.dataset.player)));
    const selected = commands[0];
    const version = String(state.data && state.data.minecraftStatus && state.data.minecraftStatus.version || "current server");
    elements.consoleHintDescription.textContent = selected
      ? `${selected.description}${selected.dangerous ? " Confirmation is required before sending." : ""}`
      : `Managed hints for ${version}. Refresh player hints to read online players through RCON.`;
    setBusy(state.busy);
  }

  function consoleCommandNeedsConfirmation(command) {
    const root = String(command || "").trim().toLowerCase().replace(/^\/+/, "");
    return /^(stop|op\s|deop\s|ban(?:-ip)?\s|pardon(?:-ip)?\s|kick\s|whitelist\s+(?:add|remove|on|off|reload)\b|save-off\b|reload\b)/.test(root);
  }

  function render(data) {
    state.data = data;
    elements.identity.textContent = `Management account: ${data.user && data.user.email || "unknown"}`;
    const endpoint = data.target && data.target.endpoint ? data.target.endpoint : {};
    const endpointLabel = endpoint.domain || state.endpointId;
    elements.heading.textContent = `${endpointLabel} · ${data.target.instance} · ${data.target.zone}`;
    const minecraft = data.minecraftStatus || {};
    const runtime = data.serverRuntime || {};
    const kindLabel = runtime.contentLabel || `${runtime.contentKind || "content"}s`;
    setStatus(`Minecraft: ${minecraft.label || "Unknown"}. Runtime: ${runtime.label || "Paper"} (${kindLabel}). VM: ${data.instanceState || "unknown"}.`, data.agentReady ? "success" : "warning");
    elements.contentHeading.textContent = `Compatible Modrinth ${kindLabel}`;
    elements.contentRuntime.textContent = `${runtime.label || "Paper"} accepts ${kindLabel}; the backend filters results by the installed Minecraft version and runtime.`;
    renderServerProperties(data.serverProperties);
    renderCatalog(data.catalogResults || []);
    renderInstalledContent(data.content || [], runtime);
    const result = data.lastResult || {};
    if (result.id) setOutput(`[${result.action || "action"}] ${result.state || "unknown"}\n${result.output || "No output returned."}`);
    if (data.restartRequired) {
      elements.notice.classList.remove("hidden");
      elements.notice.textContent = data.message || "The management agent is prepared but requires one VM restart from the main GUI.";
    } else if (!data.agentReady) {
      elements.notice.classList.remove("hidden");
      elements.notice.innerHTML = '<button class="action create" type="button" id="prepare-agent">Enable management agent</button><p>After preparation, restart the VM once from the main GUI.</p>';
      document.querySelector("#prepare-agent").addEventListener("click", () => runAction("prepare-agent"));
    } else {
      elements.notice.classList.add("hidden");
      elements.notice.textContent = "";
    }
    renderConsoleAssistant();
    setBusy(state.busy);
  }

  async function refresh() {
    setBusy(true);
    try {
      const query = targetQuery();
      render(await api(`/api/minecraft/management${query ? `?${query}` : ""}`, { method: "GET" }));
    } catch (error) {
      setStatus(error.message || "Unable to load Minecraft management.", "error");
      elements.identity.textContent = "Minecraft management access is required.";
    } finally {
      setBusy(false);
    }
  }

  async function runAction(action, playerInputId) {
    const body = { action, endpointId: state.endpointId, hardwareId: state.hardwareId, zone: state.zone };
    if (action === "console") {
      body.command = String(elements.console.value || "").trim();
      if (consoleCommandNeedsConfirmation(body.command)) {
        if (!window.confirm(`Send the potentially disruptive RCON command?\n\n${body.command}`)) return;
        body.confirmDangerous = true;
      }
    }
    if (playerInputId) body.player = String(document.querySelector(`#${playerInputId}`).value || "").trim();
    setBusy(true);
    setStatus(`Running Minecraft action: ${action}...`, "warning");
    try {
      const data = await api("/api/minecraft/management", { method: "POST", body: JSON.stringify(body) });
      render(data);
      setStatus(resultSummary(data.lastResult, data.message || "Minecraft action completed."), data.lastResult && data.lastResult.state === "failed" ? "error" : "success");
    } catch (error) {
      setStatus(error.message || "Minecraft action failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function runContentAction(action, projectId, title) {
    if (action === "content-remove" && !window.confirm(`Remove ${projectId} and restart Minecraft?`)) return;
    const body = { action, endpointId: state.endpointId, hardwareId: state.hardwareId, zone: state.zone, projectId, title };
    if (action === "catalog-search") body.query = String(elements.contentSearchQuery.value || "").trim();
    setBusy(true);
    setStatus(action === "catalog-search" ? "Searching Modrinth..." : "Applying Modrinth content and restarting Minecraft...", "warning");
    try {
      const data = await api("/api/minecraft/management", { method: "POST", body: JSON.stringify(body) });
      render(data);
      setStatus(resultSummary(data.lastResult, data.message || "Minecraft content action completed."), data.lastResult && data.lastResult.state === "failed" ? "error" : "success");
    } catch (error) {
      setStatus(error.message || "Minecraft content action failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function runPropertyAction(action) {
    const body = { action, endpointId: state.endpointId, hardwareId: state.hardwareId, zone: state.zone };
    if (action === "properties-update") {
      if (!validatePropertyValue(true)) return;
      body.property = elements.propertyName.value;
      body.value = elements.propertyValue.value;
      if (!window.confirm(`Save ${body.property}=${body.value} and restart Minecraft?`)) return;
    }
    setBusy(true);
    setStatus(action === "properties-read" ? "Loading server.properties from Minecraft..." : "Saving server.properties and restarting Minecraft...", "warning");
    try {
      const data = await api("/api/minecraft/management", { method: "POST", body: JSON.stringify(body) });
      render(data);
      setStatus(resultSummary(data.lastResult, data.message || "Minecraft configuration action completed."), data.lastResult && data.lastResult.state === "failed" ? "error" : "success");
    } catch (error) {
      setStatus(error.message || "Minecraft configuration action failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  elements.back.href = `./index.html${window.location.search}`;
  elements.refresh.addEventListener("click", refresh);
  elements.actionButtons.forEach((button) => button.addEventListener("click", () => runAction(button.dataset.action, button.dataset.playerInput)));
  elements.contentSearch.addEventListener("click", () => runContentAction("catalog-search", "", ""));
  elements.contentSearchQuery.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); runContentAction("catalog-search", "", ""); } });
  elements.propertiesLoad.addEventListener("click", () => runPropertyAction("properties-read"));
  elements.propertiesSave.addEventListener("click", () => runPropertyAction("properties-update"));
  elements.propertyName.addEventListener("change", () => { renderPropertyEditor(true); setBusy(state.busy); });
  elements.propertyValue.addEventListener("input", () => { validatePropertyValue(true); setBusy(state.busy); });
  elements.console.addEventListener("input", renderConsoleAssistant);
  if (!state.token && window.opener) {
    window.opener.postMessage({ type: minecraftManagementSessionRequest }, window.location.origin);
    window.setTimeout(refresh, 250);
  } else {
    refresh();
  }
})();
