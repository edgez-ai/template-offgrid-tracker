const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const tick = () => new Promise(setImmediate);
function fixture({ cloud = false, pending = false, failure = false } = {}) {
  const effects = [], states = [], intervals = [], calls = [];
  let foreground, resolve;
  const held = new Promise(r => { resolve = r; });
  const AppState = { currentState: 'active', addEventListener(event, fn) {
    assert.equal(event, 'change'); foreground = fn; return { remove() { foreground = null; } };
  } };
  const react = { useRef: current => ({ current }), useCallback: fn => fn,
    useState: initial => [initial, state => states.push(state)], useEffect: fn => effects.push(fn) };
  const api = {
    currentWifiGateway: async () => { calls.push('gateway'); return 'http://10.0.0.1:8088'; },
    listGatewayClients: async (url, signal) => { calls.push(['clients', url, signal]); if (pending) await held; if (failure) throw Error('offline'); return [{ endpoint: 'SERIAL' }]; },
  };
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../keepteen/useGatewayDevices.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, AbortController,
    setInterval(fn, ms) { assert.equal(ms, 15000); intervals.push(fn); return 1; }, clearInterval() {},
    require(name) {
      if (name === 'react') return react;
      if (name === 'react-native') return { AppState };
      if (name === '@react-native-community/netinfo') return { useNetInfo: () => ({ type: 'wifi', isConnected: true, details: { ipAddress: '10.0.0.2' } }) };
      if (name === '../gateway-lwm2m') return api;
      if (name === '../gateway-local-devices') return { linkGatewayDevice: async (url, profile, client, signal) => {
        calls.push(['link', profile, signal]); return { client, added: true };
      } };
      throw Error(name);
    },
  });
  const subject = module.exports.useGatewayDevices({ onlineMode: cloud, profile: { id: 'local-profile' } }, async () => { calls.push('reload local'); });
  const cleanup = effects[0]();
  return { subject, states, calls, resolve, cleanup, timer() { intervals[0](); },
    appState(state) { AppState.currentState = state; foreground(state); } };
}
test('pull-to-refresh joins the pending discovery and waits for linking and local reload', async () => {
  const f = fixture({ pending: true }); await tick();
  const first = f.subject.refresh(), second = f.subject.refresh(); assert.equal(first, second);
  assert.equal(f.calls.filter(c => Array.isArray(c) && c[0] === 'clients').length, 1);
  f.resolve(); await first;
  assert.equal(f.states.at(-1).connected, true); assert.equal(f.states.at(-1).profileId, 'local-profile');
  assert.ok(f.calls.includes('reload local'));
  await f.subject.refresh(); assert.equal(f.calls.filter(c => Array.isArray(c) && c[0] === 'clients').length, 2);
  f.cleanup();
});
test('discovery refreshes periodically and immediately on foreground return, skipping background polling', async () => {
  const f = fixture(); await tick(); assert.equal(f.states.length, 1);
  f.appState('background'); f.timer(); await tick(); assert.equal(f.states.length, 1);
  f.appState('active'); await tick(); assert.equal(f.states.length, 2);
  f.timer(); await tick(); assert.equal(f.states.length, 3); f.cleanup();
});
test('profile cleanup aborts discovery and prevents stale results or future manual requests', async () => {
  const f = fixture({ pending: true }); await tick();
  const pending = f.subject.refresh(); const signal = f.calls.find(c => Array.isArray(c) && c[0] === 'clients')[2];
  f.cleanup(); assert.equal(signal.aborted, true); f.resolve(); await pending;
  assert.equal(f.states.length, 0); const count=f.calls.length; await f.subject.refresh(); assert.equal(f.calls.length, count);
});
test('failed refresh clears online registrations and settles the refresh promise', async () => {
  const f = fixture({ failure: true }); await f.subject.refresh();
  assert.equal(f.states.at(-1).connected, false); assert.equal(f.states.at(-1).clients.length, 0); f.cleanup();
});
test('cloud profiles never discover LwM2M devices', async () => {
  const f=fixture({ cloud: true }); await f.subject.refresh(); assert.equal(f.calls.length,0); assert.equal(f.states.length,0);
});
