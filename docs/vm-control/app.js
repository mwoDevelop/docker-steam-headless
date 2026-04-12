(function () {
  const storageKeys = {
    config: "vm-control-config",
    tokenSession: "vm-control-token-session",
    tokenPersistent: "vm-control-token-persistent",
  };

  const elements = {
    token: document.querySelector("#token"),
    rememberToken: document.querySelector("#remember-token"),
    owner: document.querySelector("#owner"),
    repo: document.querySelector("#repo"),
    ref: document.querySelector("#ref"),
    workflow: document.querySelector("#workflow"),
    project: document.querySelector("#project"),
    zone: document.querySelector("#zone"),
    instance: document.querySelector("#instance"),
    banner: document.querySelector("#banner"),
    access: document.querySelector("#access"),
    runs: document.querySelector("#runs"),
    refreshRuns: document.querySelector("#refresh-runs"),
    clearToken: document.querySelector("#clear-token"),
    form: document.querySelector("#settings-form"),
    actionButtons: Array.from(document.querySelectorAll("[data-command]")),
  };

  let refreshTimer = null;
  let isBusy = false;
  let lastDispatchedAt = "";

  function defaultOwner() {
    const host = window.location.hostname;
    return host.endsWith(".github.io") ? host.replace(/\.github\.io$/, "") : "";
  }

  function defaultRepo() {
    const segments = window.location.pathname.split("/").filter(Boolean);
    return segments.length > 0 ? segments[0] : "";
  }

  function loadToken() {
    return (
      window.localStorage.getItem(storageKeys.tokenPersistent) ||
      window.sessionStorage.getItem(storageKeys.tokenSession) ||
      ""
    );
  }

  function persistToken() {
    const token = elements.token.value.trim();
    const remember = elements.rememberToken.checked;

    window.localStorage.removeItem(storageKeys.tokenPersistent);
    window.sessionStorage.removeItem(storageKeys.tokenSession);

    if (!token) {
      return;
    }

    if (remember) {
      window.localStorage.setItem(storageKeys.tokenPersistent, token);
      return;
    }

    window.sessionStorage.setItem(storageKeys.tokenSession, token);
  }

  function loadConfig() {
    const saved = JSON.parse(window.localStorage.getItem(storageKeys.config) || "{}");

    elements.owner.value = saved.owner || defaultOwner();
    elements.repo.value = saved.repo || defaultRepo();
    elements.ref.value = saved.ref || "master";
    elements.workflow.value = saved.workflow || "vm-control.yml";
    elements.project.value = saved.project || "";
    elements.zone.value = saved.zone || "";
    elements.instance.value = saved.instance || "";
    elements.token.value = loadToken();
    elements.rememberToken.checked = Boolean(window.localStorage.getItem(storageKeys.tokenPersistent));
  }

  function saveConfig() {
    const config = getConfig();
    window.localStorage.setItem(
      storageKeys.config,
      JSON.stringify({
        owner: config.owner,
        repo: config.repo,
        ref: config.ref,
        workflow: config.workflow,
        project: config.project,
        zone: config.zone,
        instance: config.instance,
      }),
    );
    persistToken();
  }

  function getConfig() {
    return {
      token: elements.token.value.trim(),
      owner: elements.owner.value.trim(),
      repo: elements.repo.value.trim(),
      ref: elements.ref.value.trim(),
      workflow: elements.workflow.value.trim(),
      project: elements.project.value.trim(),
      zone: elements.zone.value.trim(),
      instance: elements.instance.value.trim(),
    };
  }

  function setBusy(nextBusy) {
    isBusy = nextBusy;
    elements.actionButtons.forEach((button) => {
      button.disabled = nextBusy;
    });
    elements.refreshRuns.disabled = nextBusy;
  }

  function setBanner(message, tone) {
    elements.banner.textContent = message;
    elements.banner.dataset.tone = tone || "neutral";
  }

  function requireConfig(config) {
    if (!config.token) {
      throw new Error("Missing GitHub token.");
    }
    if (!config.owner || !config.repo || !config.ref || !config.workflow) {
      throw new Error("Owner, repository, ref, and workflow file are required.");
    }
  }

  async function requestJson(url, config, options) {
    const response = await window.fetch(url, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options && options.headers ? options.headers : {}),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `GitHub API returned ${response.status}.`);
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  async function dispatchCommand(command) {
    const config = getConfig();
    requireConfig(config);
    saveConfig();

    setBusy(true);
    setBanner(`Dispatching "${command}" workflow run...`, "warning");

    lastDispatchedAt = new Date().toISOString();

    await requestJson(
      `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/actions/workflows/${encodeURIComponent(config.workflow)}/dispatches`,
      config,
      {
        method: "POST",
        body: JSON.stringify({
          ref: config.ref,
          inputs: {
            command,
            project: config.project,
            zone: config.zone,
            instance: config.instance,
            wait_for_running: command === "stop" ? "false" : "true",
          },
        }),
      },
    );

    setBanner(`Workflow for "${command}" dispatched. Refreshing recent runs...`, "success");
    await wait(2500);
    await refreshRuns();
  }

  function wait(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  async function refreshRuns() {
    const config = getConfig();
    requireConfig(config);
    saveConfig();

    if (refreshTimer) {
      window.clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    const params = new URLSearchParams({
      event: "workflow_dispatch",
      per_page: "8",
    });

    if (config.ref) {
      params.set("branch", config.ref);
    }

    setBanner("Loading recent workflow runs...", "warning");

    const data = await requestJson(
      `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/actions/workflows/${encodeURIComponent(config.workflow)}/runs?${params.toString()}`,
      config,
      { method: "GET" },
    );

    const runs = data && data.workflow_runs ? data.workflow_runs : [];
    const enrichedRuns = await Promise.all(
      runs.map(async (run) => {
        try {
          const jobs = await requestJson(
            `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/actions/runs/${run.id}/jobs`,
            config,
            { method: "GET" },
          );
          return {
            ...run,
            vmControl: extractVmControlDetails(jobs && jobs.jobs ? jobs.jobs : []),
          };
        } catch (error) {
          return {
            ...run,
            vmControl: { error: error.message },
          };
        }
      }),
    );

    renderRuns(enrichedRuns);
    renderAccess(enrichedRuns);

    if (enrichedRuns.length === 0) {
      setBanner("No workflow runs found for this workflow yet.", "warning");
      return;
    }

    const newest = enrichedRuns[0];
    const finalState = newest.vmControl && newest.vmControl.finalState;
    const isFresh =
      lastDispatchedAt && newest.created_at && newest.created_at >= lastDispatchedAt;

    if (newest.status !== "completed") {
      const activeStep =
        newest.vmControl && newest.vmControl.activeStep
          ? ` Current step: ${newest.vmControl.activeStep}.`
          : "";
      setBanner(
        `Latest run is ${newest.status}.${activeStep} The panel will refresh again in a few seconds.`,
        "warning",
      );
      refreshTimer = window.setTimeout(() => {
        refreshRuns().catch(handleError);
      }, 8000);
      return;
    }

    if (newest.conclusion === "success") {
      const suffix = finalState ? ` Final VM state: ${finalState}.` : "";
      const prefix = isFresh ? "Fresh run completed successfully." : "Latest run completed successfully.";
      setBanner(`${prefix}${suffix}`, "success");
      return;
    }

    const failedStep =
      newest.vmControl && newest.vmControl.failedStep
        ? ` Failed at "${newest.vmControl.failedStep}".`
        : "";

    setBanner(
      `Latest run concluded with "${newest.conclusion || "unknown"}".${failedStep} Open the run for details.`,
      "error",
    );
  }

  function extractVmControlDetails(jobs) {
    const details = {
      finalState: "",
      externalIp: "",
      target: "",
      activeStep: "",
      failedStep: "",
    };

    for (const job of jobs) {
      if (job.conclusion === "failure" && !details.failedStep) {
        details.failedStep = job.name || "job failure";
      }

      for (const step of job.steps || []) {
        const name = step.name || "";
        if (name.startsWith("Final state: ")) {
          details.finalState = name.slice("Final state: ".length);
        } else if (name.startsWith("External IP: ")) {
          details.externalIp = name.slice("External IP: ".length);
        } else if (name.startsWith("Target: ")) {
          details.target = name.slice("Target: ".length);
        }

        if (step.status === "in_progress" && !details.activeStep) {
          details.activeStep = name || "workflow step";
        }

        if (
          !details.failedStep &&
          (step.conclusion === "failure" || step.conclusion === "timed_out" || step.conclusion === "cancelled")
        ) {
          details.failedStep = name || "workflow step";
        }
      }
    }

    return details;
  }

  function renderAccess(runs) {
    if (!runs.length) {
      elements.access.className = "access empty";
      elements.access.textContent = "No workflow runs loaded yet.";
      return;
    }

    const newest = runs[0];
    const details = newest.vmControl || {};
    const target = details.target ? escapeHtml(details.target) : "unknown target";
    const runLink = escapeHtml(newest.html_url);

    if (newest.status !== "completed") {
      const activeStep = details.activeStep
        ? `<p class="access-meta">Current step: <code>${escapeHtml(details.activeStep)}</code></p>`
        : "";
      elements.access.className = "access";
      elements.access.innerHTML = `
        <article class="access-card">
          <h3>Workflow in progress</h3>
          <p>The latest run for <code>${target}</code> is still working. Access links will refresh automatically when it completes.</p>
          ${activeStep}
          <div class="access-links">
            <a href="${runLink}" target="_blank" rel="noreferrer">Open GitHub run</a>
          </div>
        </article>
      `;
      return;
    }

    if (newest.conclusion !== "success") {
      const failedStep = details.failedStep
        ? `<p class="access-meta">Failed step: <code>${escapeHtml(details.failedStep)}</code></p>`
        : "";
      elements.access.className = "access";
      elements.access.innerHTML = `
        <article class="access-card error">
          <h3>Latest run failed</h3>
          <p>The panel cannot confirm fresh access details for <code>${target}</code> because the latest workflow run did not finish successfully.</p>
          ${failedStep}
          <div class="access-links">
            <a href="${runLink}" target="_blank" rel="noreferrer">Open GitHub run</a>
          </div>
        </article>
      `;
      return;
    }

    if (details.finalState !== "RUNNING") {
      const state = details.finalState ? escapeHtml(details.finalState) : "UNKNOWN";
      elements.access.className = "access";
      elements.access.innerHTML = `
        <article class="access-card">
          <h3>VM not running</h3>
          <p>The latest successful run reported <code>${state}</code> for <code>${target}</code>, so remote access links are not available right now.</p>
          <div class="access-links">
            <a href="${runLink}" target="_blank" rel="noreferrer">Open GitHub run</a>
          </div>
        </article>
      `;
      return;
    }

    if (!details.externalIp || details.externalIp === "none") {
      elements.access.className = "access";
      elements.access.innerHTML = `
        <article class="access-card error">
          <h3>VM is running, but IP is missing</h3>
          <p>The workflow reported a running VM for <code>${target}</code>, but no external IP was captured. Open the GitHub run and verify the instance networking.</p>
          <div class="access-links">
            <a href="${runLink}" target="_blank" rel="noreferrer">Open GitHub run</a>
          </div>
        </article>
      `;
      return;
    }

    const ip = escapeHtml(details.externalIp);
    elements.access.className = "access";
    elements.access.innerHTML = `
      <div class="access-grid">
        <article class="access-card accent">
          <h3>Browser Desktop</h3>
          <p>Best for first login, Steam setup, and quick recovery when streaming clients are not paired yet.</p>
          <div class="access-links">
            <a href="http://${ip}:8083/" target="_blank" rel="noreferrer">Open noVNC</a>
          </div>
          <p class="access-meta">URL: <code>http://${ip}:8083/</code></p>
        </article>

        <article class="access-card accent">
          <h3>Sunshine Web UI</h3>
          <p>Use this to manage Sunshine, pair streaming clients, and inspect the host configuration. Your browser may warn about the certificate on first open.</p>
          <div class="access-links">
            <a href="https://${ip}:47990/" target="_blank" rel="noreferrer">Open Sunshine UI</a>
          </div>
          <p class="access-meta">URL: <code>https://${ip}:47990/</code></p>
        </article>

        <article class="access-card">
          <h3>Moonlight / Sunshine Client</h3>
          <p>Add this host in Moonlight or another Sunshine-compatible client, then pair with the PIN shown by Sunshine.</p>
          <p class="access-meta">Host/IP: <code>${ip}</code></p>
        </article>

        <article class="access-card">
          <h3>Steam Link / Steam Client</h3>
          <p>After Steam inside the VM signs in, the host should appear in Steam Link or Steam Remote Play. First-time setup is usually easiest through noVNC.</p>
          <p class="access-meta">Target: <code>${target}</code></p>
        </article>
      </div>

      <p class="access-note">
        The VM can report <code>RUNNING</code> before the desktop and Sunshine finish booting. On a cold start, give noVNC and Sunshine up to a minute or two to become reachable.
      </p>
    `;
  }

  function renderRuns(runs) {
    if (!runs.length) {
      elements.runs.className = "runs empty";
      elements.runs.textContent = "No runs loaded yet.";
      return;
    }

    elements.runs.className = "runs";
    elements.runs.innerHTML = runs
      .map((run) => renderRun(run))
      .join("");
  }

  function renderRun(run) {
    const title = escapeHtml(run.display_title || run.name || `Run #${run.run_number}`);
    const statusBadge = renderStatusBadge(run.status, run.conclusion);
    const stateBadge = run.vmControl && run.vmControl.finalState
      ? `<span class="run-badge state">vm ${escapeHtml(run.vmControl.finalState.toLowerCase())}</span>`
      : "";
    const ipLinks =
      run.vmControl &&
      run.vmControl.externalIp &&
      run.vmControl.externalIp !== "none" &&
      run.vmControl.finalState === "RUNNING"
        ? `
          <a href="http://${escapeHtml(run.vmControl.externalIp)}:8083/" target="_blank" rel="noreferrer">noVNC</a>
          <a href="https://${escapeHtml(run.vmControl.externalIp)}:47990/" target="_blank" rel="noreferrer">Sunshine</a>
        `
        : "";
    const runTime = new Date(run.created_at).toLocaleString();
    const target = run.vmControl && run.vmControl.target ? escapeHtml(run.vmControl.target) : "unknown target";
    const externalIp =
      run.vmControl && run.vmControl.externalIp && run.vmControl.externalIp !== "none"
        ? escapeHtml(run.vmControl.externalIp)
        : "n/a";
    const runDetail = renderRunDetail(run);

    return `
      <article class="run-card">
        <div class="run-top">
          <h3 class="run-title">${title}</h3>
          <div class="run-badges">
            ${statusBadge}
            ${stateBadge}
          </div>
        </div>
        <div class="run-meta">
          <span>#${run.run_number}</span>
          <span>${escapeHtml(runTime)}</span>
          <span>${escapeHtml(target)}</span>
          <span>ip ${externalIp}</span>
        </div>
        ${runDetail}
        <div class="run-links">
          <a href="${escapeHtml(run.html_url)}" target="_blank" rel="noreferrer">Open run</a>
          ${ipLinks}
        </div>
      </article>
    `;
  }

  function renderStatusBadge(status, conclusion) {
    const classes = ["run-badge", "status", escapeToken(status)];
    if (status === "completed" && conclusion) {
      classes.push(escapeToken(conclusion));
    }
    const label = status === "completed" && conclusion ? conclusion : status;
    return `<span class="${classes.join(" ")}">${escapeHtml(label || "unknown")}</span>`;
  }

  function renderRunDetail(run) {
    if (run.vmControl && run.vmControl.error) {
      return `<div class="run-detail error">Could not read workflow job details: ${escapeHtml(run.vmControl.error)}</div>`;
    }

    if (run.status !== "completed" && run.vmControl && run.vmControl.activeStep) {
      return `<div class="run-detail">Current step: ${escapeHtml(run.vmControl.activeStep)}</div>`;
    }

    if (run.conclusion !== "success" && run.vmControl && run.vmControl.failedStep) {
      return `<div class="run-detail error">Failed step: ${escapeHtml(run.vmControl.failedStep)}</div>`;
    }

    return "";
  }

  function escapeToken(value) {
    return String(value || "unknown")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function handleError(error) {
    setBanner(error.message || "Unexpected error.", "error");
  }

  function clearToken() {
    window.localStorage.removeItem(storageKeys.tokenPersistent);
    window.sessionStorage.removeItem(storageKeys.tokenSession);
    elements.token.value = "";
    elements.rememberToken.checked = false;
    setBanner("Stored token removed from this browser.", "success");
  }

  loadConfig();

  elements.form.addEventListener("input", saveConfig);
  elements.form.addEventListener("change", saveConfig);

  elements.actionButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      if (isBusy) {
        return;
      }
      try {
        await dispatchCommand(button.dataset.command);
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
      }
    });
  });

  elements.refreshRuns.addEventListener("click", async () => {
    if (isBusy) {
      return;
    }
    try {
      setBusy(true);
      await refreshRuns();
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  });

  elements.clearToken.addEventListener("click", clearToken);

  if (elements.token.value && elements.owner.value && elements.repo.value && elements.workflow.value) {
    setBusy(true);
    refreshRuns()
      .catch(handleError)
      .finally(() => {
        setBusy(false);
      });
  }
})();
