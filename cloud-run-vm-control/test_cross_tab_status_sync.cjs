const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const adminSource = fs.readFileSync(path.join(__dirname, '../docs/vm-control/admin.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../docs/vm-control/app.js'), 'utf8');

// 1. Static contract verification
assert.match(adminSource, /new BroadcastChannel\("vm-control-action-status"\)/, 'admin.js must instantiate action status channel');
assert.match(adminSource, /function broadcastActionStatus\(type, command, endpointId\)/, 'admin.js must define broadcastActionStatus');
assert.match(adminSource, /window\.dispatchEvent\(new CustomEvent\("vm-control:action-status"/, 'admin.js must dispatch vm-control:action-status event');
assert.match(adminSource, /broadcastActionStatus\("started", `runtime-\${action}`, endpointId\)/, 'updateRuntimeImages must broadcast started');
assert.match(adminSource, /broadcastActionStatus\("settled", `runtime-\${action}`, endpointId\)/, 'updateRuntimeImages must broadcast settled');
assert.match(adminSource, /broadcastActionStatus\("started", command, endpointId\)/, 'updateSoftware must broadcast started');
assert.match(adminSource, /broadcastActionStatus\("settled", command, endpointId\)/, 'updateSoftware must broadcast settled');
assert.match(adminSource, /broadcastActionStatus\("started", `migration-\${action}`, endpointId\)/, 'updateMigration must broadcast started');
assert.match(adminSource, /broadcastActionStatus\("settled", `migration-\${action}`, endpointId\)/, 'updateMigration must broadcast settled');

assert.match(appSource, /endpointId: selectedEndpointId\(\)/, 'app.js broadcastActionStatus must include endpointId');
assert.match(appSource, /function handleActionStatusNotification\(data\)/, 'app.js must define handleActionStatusNotification');
assert.match(appSource, /window\.addEventListener\("vm-control:action-status"/, 'app.js must listen to vm-control:action-status');
assert.match(appSource, /schedulePassiveStatusRefresh\(50\)/, 'app.js must fast-refresh status on tab-activated');

// 2. Dynamic behavior tests: statusMessageTone
const cut = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start) + start.length));
const toneCode = cut(appSource, '  function isTransitionalStatus(payload) {', '  const OPERATION_PROGRESS_TITLES = {')
  + '\n' + cut(appSource, '  function statusMessageTone(data) {', '    function schedulePostCommandStatusRefresh(');

const toneContext = vm.createContext({});
vm.runInContext(toneCode, toneContext);

assert.equal(toneContext.statusMessageTone(null), 'neutral');
assert.equal(toneContext.statusMessageTone({ powerAction: { phase: 'running' } }), 'warning');
assert.equal(toneContext.statusMessageTone({ powerAction: { phase: 'failed' } }), 'warning');
assert.equal(toneContext.statusMessageTone({ status: 'RUNNING', persistence: { backupReady: { state: 'ready' } }, powerAction: { phase: 'updated' } }), 'success');
assert.equal(toneContext.statusMessageTone({ status: 'TERMINATED', powerAction: { phase: 'stopped' } }), 'success');

// 3. Dynamic behavior tests: passive refresh transition from running to settled
const helperCode = `
  var commandStatusText = "";
  var commandStatusTone = "";
  var operationProgressCleared = false;
  var operationProgressRendered = false;

  var elements = {
    commandStatus: {
      get textContent() { return commandStatusText; },
      set textContent(v) { commandStatusText = v; }
    }
  };

  function setCommandStatus(msg, tone) {
    commandStatusText = msg;
    commandStatusTone = tone;
  }

  function renderOperationProgress(action, payload) {
    operationProgressRendered = true;
    state.operationProgressCommand = action;
  }

  function clearOperationProgress() {
    operationProgressCleared = true;
    state.operationProgressCommand = "";
  }

  function statusBannerMessage(prefix, payload) {
    return prefix + ": " + (payload?.status || "UNKNOWN") + " / " + (payload?.powerAction?.phase || "none");
  }

  var state = {
    user: { email: "admin@test.com" },
    isBusy: false,
    isPageLoading: false,
    passiveStatusTimer: null,
    passiveStatusRefreshRunning: false,
    passiveRunningAction: "",
    operationProgressCommand: "",
    activeCommand: null,
  };
`;

const refreshSnippet = cut(appSource, '  async function runPassiveStatusRefresh() {', '  function handleActionStatusNotification(');
const testContext = vm.createContext({
  document: { visibilityState: 'visible' },
  schedulePassiveStatusRefresh: () => {},
  console: { warn: () => {} },
  PASSIVE_STATUS_IDLE_INTERVAL_MS: 10000,
  PASSIVE_STATUS_ACTIVE_INTERVAL_MS: 3000,
});
vm.runInContext(toneCode + '\n' + helperCode + '\n' + refreshSnippet, testContext);

(async () => {
  // Scenario A: Action is currently running
  testContext.refreshStatus = async () => ({
    status: 'RUNNING',
    persistence: { backupReady: { state: 'ready' } },
    powerAction: { action: 'update-runtime-image', phase: 'running' },
  });
  await testContext.runPassiveStatusRefresh();
  assert.equal(testContext.state.passiveRunningAction, 'update-runtime-image');
  assert.equal(testContext.commandStatusTone, 'warning');
  assert.match(testContext.commandStatusText, /update-runtime-image is still running/);
  assert.equal(testContext.operationProgressRendered, true);

  // Scenario B: Action settles on next refresh
  testContext.operationProgressCleared = false;
  testContext.refreshStatus = async () => ({
    status: 'RUNNING',
    persistence: { backupReady: { state: 'ready' } },
    powerAction: { action: 'update-runtime-image', phase: 'updated' },
    sunshineStatus: { state: 'ready' },
  });
  await testContext.runPassiveStatusRefresh();
  assert.equal(testContext.state.passiveRunningAction, '');
  assert.equal(testContext.operationProgressCleared, true);
  assert.equal(testContext.commandStatusTone, 'success');
  assert.match(testContext.commandStatusText, /VM status loaded: RUNNING \/ updated/);

  // Scenario C: Page had stale "stop is still running" banner while VM is TERMINATED
  testContext.commandStatusText = "stop is still running. Current VM state: RUNNING";
  testContext.state.passiveRunningAction = "";
  testContext.state.operationProgressCommand = "stop";
  testContext.operationProgressCleared = false;
  testContext.refreshStatus = async () => ({
    status: 'TERMINATED',
    powerAction: { action: 'stop', phase: 'stopped' },
  });
  await testContext.runPassiveStatusRefresh();
  assert.equal(testContext.operationProgressCleared, true);
  assert.equal(testContext.commandStatusTone, 'success');
  assert.match(testContext.commandStatusText, /VM status loaded: TERMINATED \/ stopped/);

  // Scenario D: Action failed
  testContext.refreshStatus = async () => ({
    status: 'RUNNING',
    persistence: { backupReady: { state: 'ready' } },
    powerAction: { action: 'update-runtime-image', phase: 'running' },
  });
  await testContext.runPassiveStatusRefresh();
  assert.equal(testContext.state.passiveRunningAction, 'update-runtime-image');
  testContext.refreshStatus = async () => ({
    status: 'RUNNING',
    persistence: { backupReady: { state: 'ready' } },
    powerAction: { action: 'update-runtime-image', phase: 'failed' },
  });
  await testContext.runPassiveStatusRefresh();
  assert.equal(testContext.commandStatusTone, 'warning');
  assert.match(testContext.commandStatusText, /VM status loaded: RUNNING \/ failed/);

  console.log('PASS: 12 cross-tab status sync checks');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
