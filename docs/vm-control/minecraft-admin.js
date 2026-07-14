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
  };
  const saved = JSON.parse(window.localStorage.getItem(storageKeys.config) || "{}");
  const state = {
    backend: String(params.get("backend") || saved.backendUrl || "").replace(/\/+$/, ""),
    token: window.sessionStorage.getItem(storageKeys.sessionToken) || "",
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
    if (state.hardwareId) target.set("hardwareId", state.hardwareId);
    if (state.zone) target.set("zone", state.zone);
    return target.toString();
  }

  function setBusy(busy) {
    state.busy = busy;
    elements.refresh.disabled = busy;
    elements.actionButtons.forEach((button) => { button.disabled = busy || !state.data || !state.data.agentReady; });
  }

  function setStatus(message, tone) {
    elements.status.textContent = message;
    elements.status.dataset.tone = tone || "neutral";
  }

  function setOutput(value) {
    elements.output.textContent = String(value || "No output returned by the server.");
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

  function render(data) {
    state.data = data;
    elements.identity.textContent = `Management account: ${data.user && data.user.email || "unknown"}`;
    elements.heading.textContent = `${data.target.instance} · ${data.target.zone}`;
    const minecraft = data.minecraftStatus || {};
    setStatus(`Minecraft: ${minecraft.label || "Unknown"}. VM: ${data.instanceState || "unknown"}.`, data.agentReady ? "success" : "warning");
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
    const body = { action, hardwareId: state.hardwareId, zone: state.zone };
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

  elements.back.href = `./index.html${window.location.search}`;
  elements.refresh.addEventListener("click", refresh);
  elements.actionButtons.forEach((button) => button.addEventListener("click", () => runAction(button.dataset.action, button.dataset.playerInput)));
  if (!state.token && window.opener) {
    window.opener.postMessage({ type: minecraftManagementSessionRequest }, window.location.origin);
    window.setTimeout(refresh, 250);
  } else {
    refresh();
  }
})();
