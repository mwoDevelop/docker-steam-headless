const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../docs/vm-control/app.js'), 'utf8');
const admin = fs.readFileSync(path.join(__dirname, '../docs/vm-control/admin.js'), 'utf8');
function cut(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing source boundary: ${start}`);
  return source.slice(first, last);
}
const poller = cut(app, '  async function runPassiveStatusRefresh() {', '  if (actionStatusChannel) {\n    actionStatusChannel.addEventListener');
const broadcaster = cut(app, '  function broadcastActionStatus(type, command) {', '  function schedulePassiveStatusRefresh(');
const ready = { status: 'RUNNING', powerAction: { phase: 'updated' } };
function harness() {
  const context = {
    state: { user: {}, activeCommand: null, passiveRunningAction: '', operationProgressCommand: '', passiveRefreshUntil: 0 },
    document: { visibilityState: 'visible' },
    elements: { commandStatus: { textContent: '' } },
    endpoint: 'mwo-vm2', target: 'mwo-vm2/l4/europe-west3-a', now: 1000,
    delays: [], renders: [], clears: 0, events: [], actionStatusChannel: null,
    PASSIVE_STATUS_ACTIVE_INTERVAL_MS: 3000, PASSIVE_STATUS_IDLE_INTERVAL_MS: 10000,
    console, Date: { now: () => context.now },
    selectedEndpointId: () => context.endpoint,
    selectedTargetKey: () => context.target,
    schedulePassiveStatusRefresh: (delay) => context.delays.push(delay),
    refreshStatus: async () => ready,
    isTransitionalStatus: (p) => p?.powerAction?.phase === 'running',
    statusBannerMessage: (prefix, p) => `${prefix}: ${p.powerAction.phase}`,
    statusMessageTone: (p) => p.powerAction.phase === 'failed' ? 'warning' : 'success',
    setCommandStatus: (text, tone) => { context.elements.commandStatus.textContent = text; context.tone = tone; },
    renderOperationProgress: (action) => context.renders.push(action),
    clearOperationProgress: () => { context.clears++; context.state.operationProgressCommand = ''; },
    window: { dispatchEvent: (event) => context.events.push(event) },
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts.detail; } },
  };
  vm.createContext(context);
  vm.runInContext(poller + '\n' + broadcaster, context);
  return context;
}
let count = 0;
async function test(name, body) { await body(); count++; console.log(`PASS ${name}`); }
(async () => {
  await test('same-window notifications without BroadcastChannel', () => {
    const h = harness(); h.broadcastActionStatus('settled', 'stop');
    assert.equal(h.events[0].type, 'vm-control:action-status');
    assert.equal(h.events[0].detail.endpointId, 'mwo-vm2');
  });
  await test('notifications do not publish credentials', () => {
    const h = harness(); h.state.password = 'test-only-not-a-secret'; h.broadcastActionStatus('started', 'start');
    assert.deepEqual(Object.keys(h.events[0].detail).sort(), ['at', 'command', 'endpointId', 'targetKey', 'type']);
  });
  await test('other endpoint and legacy wrong target ignored', () => {
    const h = harness(); h.handleActionStatusNotification({ endpointId: 'mwo-vm1' });
    h.handleActionStatusNotification({ targetKey: 'wrong' });
    assert.equal(h.delays.length, 0); assert.equal(h.state.passiveRefreshUntil, 0);
  });
  await test('metadata propagation uses bounded active polling', async () => {
    const h = harness(); h.handleActionStatusNotification({ endpointId: h.endpoint, type: 'started' });
    await h.runPassiveStatusRefresh(); assert.equal(h.delays.at(-1), 3000);
    h.now = 17000; await h.runPassiveStatusRefresh(); assert.equal(h.delays.at(-1), 10000);
  });
  await test('out-of-order hints never fabricate completion', () => {
    const h = harness(); h.handleActionStatusNotification({ type: 'settled', endpointId: h.endpoint, at: 5000 });
    h.handleActionStatusNotification({ type: 'started', endpointId: h.endpoint, at: 100 });
    assert.equal(h.elements.commandStatus.textContent, ''); assert.equal(h.clears, 0);
  });
  await test('null response preserves confirmed operation progress', async () => {
    const h = harness(); h.state.passiveRunningAction = 'stop'; h.refreshStatus = async () => null;
    await h.runPassiveStatusRefresh(); assert.equal(h.state.passiveRunningAction, 'stop');
    assert.equal(h.clears, 0); assert.equal(h.delays.at(-1), 3000);
  });
  await test('read failure preserves confirmed operation progress', async () => {
    const h = harness(); h.console = { warn() {} }; h.state.passiveRunningAction = 'stop';
    h.refreshStatus = async () => { throw new Error('synthetic read failure'); };
    await h.runPassiveStatusRefresh(); assert.equal(h.clears, 0); assert.equal(h.delays.at(-1), 3000);
  });
  await test('response for old endpoint is not rendered', async () => {
    const h = harness(); h.refreshStatus = async () => { h.endpoint = 'mwo-vm1'; return ready; };
    h.state.passiveRunningAction = 'stop'; await h.runPassiveStatusRefresh();
    assert.equal(h.clears, 0); assert.equal(h.elements.commandStatus.textContent, '');
  });
  await test('response for old hardware or zone is not rendered', async () => {
    const h = harness(); h.refreshStatus = async () => { h.target = 'mwo-vm2/cpu/other'; return ready; };
    h.state.passiveRunningAction = 'stop'; await h.runPassiveStatusRefresh(); assert.equal(h.clears, 0);
  });
  await test('busy UI retries within the propagation window', async () => {
    const h = harness(); h.state.isBusy = true; h.handleActionStatusNotification({ type: 'started' });
    await h.runPassiveStatusRefresh(); assert.equal(h.delays.at(-1), 3000);
    h.now = 17000; await h.runPassiveStatusRefresh(); assert.equal(h.delays.at(-1), 10000);
  });
  await test('hidden tabs do not perform network polling', async () => {
    const h = harness(); h.document.visibilityState = 'hidden'; let reads = 0;
    h.refreshStatus = async () => { reads++; return ready; };
    await h.runPassiveStatusRefresh(); assert.equal(reads, 0); assert.equal(h.delays.at(-1), 10000);
  });
  await test('active local command retains its loader and message', async () => {
    const h = harness(); h.state.activeCommand = 'start'; h.state.passiveRunningAction = 'start';
    await h.runPassiveStatusRefresh(); assert.equal(h.clears, 0);
  });
  await test('administrator listens with debounced read-only refresh', () => {
    const source = cut(admin, '  let actionRefreshTimer = null;', '\n  const elements = {');
    let callback; let refreshed = 0; let cancelled = 0;
    const h = vm.createContext({ actionStatusChannel: null, refreshAdminDataInBackground: () => refreshed++,
      window: { setTimeout: (cb) => { callback = cb; return 1; }, clearTimeout: () => cancelled++, addEventListener() {} } });
    vm.runInContext(source, h);
    h.handleAdminActionStatusNotification({ type: 'started' }); h.handleAdminActionStatusNotification({ type: 'settled' });
    assert.equal(cancelled, 1); callback(); assert.equal(refreshed, 1);
  });
  await test('migration invalidation cannot borrow unrelated runtime endpoint', () => {
    const source = cut(admin, '  function broadcastActionStatus(type, command, endpointId)', '  const ADMIN_REFRESH_INTERVAL_MS');
    let result;
    const h = vm.createContext({ actionStatusChannel: null, Date,
      elements: { runtimeEndpoint: { value: 'wrong-vm' } },
      CustomEvent: class { constructor(type, opts) { this.detail = opts.detail; } },
      window: { dispatchEvent: (event) => { result = event.detail; } } });
    vm.runInContext(source, h); h.broadcastActionStatus('settled', 'migration-prepare', '');
    assert.equal(result.endpointId, '');
  });
  await test('endpoint change has an explicit final-status path', () => {
    const source = cut(app, '  if (elements.endpointSelect) {\n    elements.endpointSelect.addEventListener("change", async () => {', '  if (elements.zoneSelect) {');
    assert.match(source, /state\.passiveRunningAction = ""/);
    assert.match(source, /refreshStatus\(\{ silent: false \}\)/);
  });
  console.log(`PASS: ${count} status sync edge cases`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
