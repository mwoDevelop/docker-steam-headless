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
    output: document.querySelector("#command-output"),
    actionButtons: [...document.querySelectorAll("[data-action]")],
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
    if (elements.contentSearch) elements.contentSearch.disabled = busy || !state.data || !state.data.agentReady;
    document.querySelectorAll("[data-content-action]").forEach((button) => { button.disabled = busy || !state.data || !state.data.agentReady; });
  }

  function setStatus(message, tone) {
    elements.status.textContent = message;
    elements.status.dataset.tone = tone || "neutral";
  }

  function setOutput(value) {
    elements.output.textContent = String(value || "No output returned by the server.");
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
    if (action === "console") body.command = String(elements.console.value || "").trim();
    if (playerInputId) body.player = String(document.querySelector(`#${playerInputId}`).value || "").trim();
    setBusy(true);
    setStatus(`Running Minecraft action: ${action}...`, "warning");
    try {
      const data = await api("/api/minecraft/management", { method: "POST", body: JSON.stringify(body) });
      render(data);
      setStatus(data.message || "Minecraft action completed.", data.lastResult && data.lastResult.state === "failed" ? "error" : "success");
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
      setStatus(data.message || "Minecraft content action completed.", data.lastResult && data.lastResult.state === "failed" ? "error" : "success");
    } catch (error) {
      setStatus(error.message || "Minecraft content action failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  elements.back.href = `./index.html${window.location.search}`;
  elements.refresh.addEventListener("click", refresh);
  elements.actionButtons.forEach((button) => button.addEventListener("click", () => runAction(button.dataset.action, button.dataset.playerInput)));
  elements.contentSearch.addEventListener("click", () => runContentAction("catalog-search", "", ""));
  elements.contentSearchQuery.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); runContentAction("catalog-search", "", ""); } });
  if (!state.token && window.opener) {
    window.opener.postMessage({ type: minecraftManagementSessionRequest }, window.location.origin);
    window.setTimeout(refresh, 250);
  } else {
    refresh();
  }
})();
