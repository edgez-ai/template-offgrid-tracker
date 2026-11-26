const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
function client(native) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../gateway-lwm2m.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, URL, AbortController, Date, setTimeout, clearTimeout,
    require: name => { assert.equal(name, 'react-native'); return { NativeModules: { WifiGateway: native } }; },
  });
  return module.exports;
}
const response = data => ({ status: 200, body: JSON.stringify(data) });
test('resolves the current Wi-Fi gateway on every refresh and uses no configured IP or cloud credentials', async () => {
  let gateway = 'http://10.20.30.1:8088';
  const calls = [];
  const api = client({ getGateway: async () => gateway, request: async (...args) => {
    calls.push(args);
    return response(args[1] === '/clients' ? [{ endpoint: '5037CDF35BB6' }] : { success: true, valid: true, content: { type: 'STRING', value: '5037CDF35BB6' } });
  } });
  const url = await api.currentWifiGateway();
  assert.equal(url, gateway);
  const found = await api.listGatewayClients(url);
  assert.equal(found[0].endpoint, '5037CDF35BB6');
  const resource = await api.readGatewayResource(url, 'legacy/name', '/3/0/2');
  assert.equal(resource.value, '5037CDF35BB6');
  assert.equal(calls[1][0], gateway);
  assert.equal(calls[1][1], '/clients/legacy%2Fname/3/0/2?timeout=5');
  assert.equal(calls[1].length, 3); // origin, path, cancellation ID only
  gateway = 'http://10.42.0.1:8088';
  assert.equal(await api.currentWifiGateway(), gateway);
});
test('rejects invalid origins, resource paths and LwM2M failures with HTTP 200', async () => {
  const api = client({ request: async () => response({ success: false, error: 'Device asleep' }) });
  for (const url of ['file:///etc/passwd', 'http://user:password@10.20.30.1', 'http://10.20.30.1/api', 'http://10.20.30.1?secret=x']) assert.throws(() => api.normalizeGatewayUrl(url));
  await assert.rejects(api.readGatewayResource('http://10.20.30.1:8088', 'serial', '/3/0/2'), /Device asleep/);
  await assert.rejects(api.readGatewayResource('http://10.20.30.1:8088', 'serial', '/../config'), /resource path/);
  await assert.rejects(client({ request: async () => response({}) }).listGatewayClients('http://10.20.30.1:8088'), /invalid client list/);
});
test('cancels the native request when the offline view closes', async () => {
  let cancel;
  const api = client({ request: async () => new Promise((_, reject) => { cancel = () => reject(new Error('aborted')); }), cancelRequest: () => cancel() });
  const controller = new AbortController();
  const pending = api.listGatewayClients('http://10.20.30.1:8088', controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/);
});


test('factory model selects Collar or Camera, and unknown models stay unclassified', () => {
  const api = client({});
  assert.equal(api.gatewayProductForModel('EZ-DEV54-GPS'), 'collar');
  assert.equal(api.gatewayProductForModel('EZ-DEV54-CAM'), 'camera');
  assert.equal(api.gatewayProductForModel(' ez-dev54-gps '), 'collar');
  assert.equal(api.gatewayProductForModel('EZ-DEV54'), null);
  assert.equal(api.gatewayProductForModel('unrecognized-camera'), null);
  assert.equal(api.gatewayProductForModel(), null);
});

test('reads the factory model and serial from Device resources for product classification', async () => {
  const paths = [];
  const api = client({ request: async (_, path) => {
    paths.push(path);
    return response({ success: true, content: { value: path.includes('/3/0/1?') ? 'EZ-DEV54-CAM' : path.includes('/31029/0/7?') ? 'Luna' : '5037CDF35BB6' } });
  } });
  const found = await api.readGatewayClientIdentity('http://10.20.30.1:8088', { endpoint: '5037CDF35BB6' });
  assert.equal(found.model, 'EZ-DEV54-CAM');
  assert.equal(found.serial, '5037CDF35BB6');
  assert.equal(found.name, 'Luna');
  assert.equal(api.gatewayProductForModel(found.model), 'camera');
  assert.ok(paths.includes('/clients/5037CDF35BB6/3/0/1?timeout=5'));
  assert.equal(paths.length, 2);
  assert.equal(paths.some(path => path.includes('/3/0/2?')), false);
});

test('GPS configuration and acquisition use PUT and POST with text payloads on existing resources', async () => {
  const calls = [];
  const api = client({ requestOperation: async (...args) => { calls.push(args); return response({ success: true }); } });
  await api.writeGatewayResource('http://10.20.30.1:8088', '5037CDF35BB6', '/31028/0/1', '30');
  await api.executeGatewayResource('http://10.20.30.1:8088', '5037CDF35BB6', '/31028/0/0');
  assert.deepEqual(calls.map(args => args.slice(0, 4)), [
    ['http://10.20.30.1:8088', '/clients/5037CDF35BB6/31028/0/1?timeout=5', 'PUT', '30'],
    ['http://10.20.30.1:8088', '/clients/5037CDF35BB6/31028/0/0?timeout=5', 'POST', ''],
  ]);
});

test('long GPS requests include timeout=300 on reads, writes and execution', async () => {
  const calls = [];
  const api = client({
    request: async (...args) => { calls.push(args); return response({ success: true, content: { value: 2 } }); },
    requestOperation: async (...args) => { calls.push(args); return response({ success: true }); },
  });
  await api.writeGatewayResource('http://10.20.30.1:8088', 'serial', '/31028/0/1', '300', undefined, 300);
  await api.executeGatewayResource('http://10.20.30.1:8088', 'serial', '/31028/0/0', undefined, 300);
  await api.readGatewayResource('http://10.20.30.1:8088', 'serial', '/6/0/0', undefined, 300);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(args => args[1].endsWith('?timeout=300')));
  await assert.rejects(api.readGatewayResource('http://10.20.30.1:8088', 'serial', '/6/0/0', undefined, 301), /REST timeout/);
});
