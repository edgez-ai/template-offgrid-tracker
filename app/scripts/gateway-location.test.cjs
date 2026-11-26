const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');
function fixture({ states = [0, 1, 2], latitude = 59.3, longitude = 18.1, hang = false, transientRead = false, fixAge = 999 } = {}) {
  const calls = [], timers = new Map(), waits = []; let timerId = 0;
  const module = { exports: {} };
  let readFailed = false;
  const api = {
    currentWifiGateway: async () => 'http://10.0.0.1:8088',
    writeGatewayResource: async (...args) => { calls.push(['write', ...args]); if (hang) await new Promise(() => {}); },
    executeGatewayResource: async (...args) => { calls.push(['execute', ...args]); },
    readGatewayResource: async (...args) => {
      calls.push(['read', ...args]);
      if (transientRead && !readFailed) { readFailed = true; throw new Error('Request timeout'); }
      return { value: args[2] === '/31028/0/2' ? states.shift() ?? 2 : args[2] === '/31028/0/4' ? fixAge : args[2] === '/6/0/0' ? latitude : longitude };
    },
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../gateway-location.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, AbortController,
    setTimeout(callback, ms) { waits.push(ms); const id = ++timerId; timers.set(id, { callback, ms }); if (ms === 750) queueMicrotask(callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(name) { assert.equal(name, './gateway-lwm2m'); return api; },
  });
  return { ...module.exports, calls, waits, expire() { for (const { callback, ms } of timers.values()) if (ms === 300000) callback(); } };
}
test('sets GPS timeout, acquires a fresh fix, then reads latitude and longitude for the endpoint', async () => {
  const subject = fixture();
  const location = await subject.refreshGatewayLocation('5037CDF35BB6');
  assert.equal(location.latitude, 59.3); assert.equal(location.longitude, 18.1);
  assert.deepEqual(subject.calls.map(call => [call[0], call[2], call[3]]), [
    ['read', '5037CDF35BB6', '/31028/0/2'],
    ['write', '5037CDF35BB6', '/31028/0/1'], ['execute', '5037CDF35BB6', '/31028/0/0'],
    ['read', '5037CDF35BB6', '/31028/0/2'], ['read', '5037CDF35BB6', '/31028/0/2'],
    ['read', '5037CDF35BB6', '/6/0/0'], ['read', '5037CDF35BB6', '/6/0/1'],
  ]);
  assert.equal(subject.calls[1][4], '300');
  assert.equal(subject.calls[1][6], 300);
  assert.ok(subject.calls.filter(call => call[0] === 'read').every(call => call[5] === 5));
  assert.ok(subject.calls.filter(call => call[0] === 'execute').every(call => call[5] === 300));
});
test('one five-minute deadline also ends a stalled gateway call and aborts native requests', async () => {
  const subject = fixture({ hang: true });
  const pending = subject.refreshGatewayLocation('serial');
  await new Promise(resolve => setImmediate(resolve));
  subject.expire();
  await assert.rejects(pending, /5 minutes/);
  assert.equal(subject.calls.find(call => call[0] === 'write')[5].aborted, true);
  assert.equal(subject.calls.some(call => call[0] === 'execute'), false);
});
test('a failed acquisition does not read or reuse old GPS coordinates', async () => {
  const subject = fixture({ states: [0, 3] });
  await assert.rejects(subject.refreshGatewayLocation('serial'), /timed out acquiring/);
  assert.equal(subject.calls.some(call => call[3].startsWith('/6/')), false);
});
test('invalid coordinates are rejected; cancelling the screen cancels acquisition', async () => {
  await assert.rejects(fixture({ states: [0, 2], latitude: 100 }).refreshGatewayLocation('serial'), /invalid GPS/);
  const subject = fixture({ hang: true }); const controller = new AbortController();
  const pending = subject.refreshGatewayLocation('serial', controller.signal);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test('joins active GPS acquisition without writing timeout or executing again', async () => {
  const subject = fixture({ states: [1, 1, 2] });
  const result = await subject.refreshGatewayLocation('serial');
  assert.equal(result.latitude, 59.3);
  assert.equal(subject.calls.some(call => call[0] === 'write' || call[0] === 'execute'), false);
});

test('returns immediately once fixed without waiting for the acquisition deadline', async () => {
  const subject = fixture({ states: [0, 2] });
  const result = await subject.refreshGatewayLocation('serial');
  assert.equal(result.longitude, 18.1);
  assert.deepEqual(subject.waits, [300000]); // deadline armed, no polling sleep needed
});

test('a timed-out status read is retried within the acquisition window', async () => {
  const subject = fixture({ states: [1, 2], transientRead: true });
  const result = await subject.refreshGatewayLocation('serial');
  assert.equal(result.latitude, 59.3);
  assert.equal(subject.calls.some(call => call[0] === 'write' || call[0] === 'execute'), false);
  assert.equal(subject.calls.filter(call => call[3] === '/31028/0/2').length, 3);
});

test('a just-completed device fix is read without restarting receiver power', async () => {
  const subject = fixture({ states: [2], fixAge: 2 });
  const result = await subject.refreshGatewayLocation('serial');
  assert.equal(result.latitude, 59.3);
  assert.equal(subject.calls.some(call => call[0] === 'write' || call[0] === 'execute'), false);
  assert.deepEqual(subject.calls.map(call => call[3]), ['/31028/0/2', '/31028/0/4', '/6/0/0', '/6/0/1']);
});
test('an older cached fix still triggers a new acquisition', async () => {
  const subject = fixture({ states: [2, 2], fixAge: 6 });
  await subject.refreshGatewayLocation('serial');
  assert.equal(subject.calls.filter(call => call[0] === 'execute').length, 1);
});

test('an invalid fix age cannot bypass fresh acquisition', async () => {
  const subject = fixture({ states: [2, 2], fixAge: null });
  await subject.refreshGatewayLocation('serial');
  assert.equal(subject.calls.filter(call => call[0] === 'execute').length, 1);
});
