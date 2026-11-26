const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');
function fixture({ content = { format: 0, value: JSON.stringify({ latitude: 59.3, longitude: 18.1, timestamp: 1795668500 }) }, hang = false, error } = {}) {
  const calls = [], timers = new Map(); let timerId = 0;
  const module = { exports: {} };
  const api = {
    currentWifiGateway: async () => 'http://10.0.0.1:8088',
    executeGatewayResource: async (...args) => {
      calls.push(args);
      if (error) throw new Error(error);
      if (hang) await new Promise(() => {});
      return content;
    },
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../gateway-location.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, AbortController,
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(name) { assert.equal(name, './gateway-lwm2m'); return api; },
  });
  return { ...module.exports, calls, timers, expire() { for (const { callback, ms } of timers.values()) if (ms === 300000) callback(); } };
}
test('one Execute returns the fresh fix without setup writes, polling or coordinate reads', async () => {
  const subject = fixture();
  const location = await subject.refreshGatewayLocation('5037CDF35BB6');
  assert.equal(location.latitude, 59.3); assert.equal(location.longitude, 18.1);
  assert.equal(subject.calls.length, 1);
  const [url, endpoint, resource, signal, timeout, args] = subject.calls[0];
  assert.equal(url, 'http://10.0.0.1:8088'); assert.equal(endpoint, '5037CDF35BB6');
  assert.equal(resource, '/31028/0/0'); assert.equal(timeout, 300); assert.equal(args, "0='295'");
  assert.equal(signal.aborted, true); assert.equal(subject.timers.size, 0);
});
test('deadline aborts a stalled Execute response', async () => {
  const subject = fixture({ hang: true }); const pending = subject.refreshGatewayLocation('serial');
  await new Promise(setImmediate); subject.expire();
  await assert.rejects(pending, /timed out/); assert.equal(subject.calls[0][3].aborted, true);
});
test('cancellation aborts the pending native Execute', async () => {
  const subject = fixture({ hang: true }); const controller = new AbortController();
  const pending = subject.refreshGatewayLocation('serial', controller.signal);
  await new Promise(setImmediate); controller.abort();
  await assert.rejects(pending, /cancelled/); assert.equal(subject.calls[0][3].aborted, true);
});
test('an already cancelled request sends no Execute', async () => {
  const subject = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(subject.refreshGatewayLocation('serial', controller.signal), /cancelled/);
  assert.equal(subject.calls.length, 0);
});
test('legacy acknowledgements require updated gateway and firmware, without falling back to polling', async () => {
  const subject = fixture({ content: null });
  await assert.rejects(subject.refreshGatewayLocation('serial'), /Update the gateway and device/);
  assert.equal(subject.calls.length, 1);
});
for (const value of ['not JSON', 'null', '{}', '{"latitude":91,"longitude":18,"timestamp":1}', '{"latitude":"59","longitude":18,"timestamp":1}', '{"latitude":59,"longitude":18,"timestamp":null}']) {
  test(`rejects malformed fix: ${value}`, async () => {
    const subject = fixture({ content: { format: 0, value } });
    await assert.rejects(subject.refreshGatewayLocation('serial'), /invalid GPS/);
  });
}
test('device errors propagate without repeating acquisition', async () => {
  const subject = fixture({ error: 'SERVICE_UNAVAILABLE(5.03)' });
  await assert.rejects(subject.refreshGatewayLocation('serial'), /SERVICE_UNAVAILABLE/);
  assert.equal(subject.calls.length, 1);
});
