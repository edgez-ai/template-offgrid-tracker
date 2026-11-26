const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');
function load(file, dependencies) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, URL, AbortController, Date, setTimeout, clearTimeout,
    require(name) { assert.ok(name in dependencies, name); return dependencies[name]; },
  });
  return module.exports;
}
function setup(initial = []) {
  const devices = [...initial], paths = [], inserts = [];
  let nameFails = false;
  const api = load('gateway-lwm2m.ts', { 'react-native': { NativeModules: { WifiGateway: {
    request: async (_, resource) => {
      paths.push(resource);
      const isName = resource.includes('/31029/0/7?');
      return { status: 200, body: JSON.stringify(isName && nameFails ? { success: false, error: 'Asleep' } : {
        success: true, content: { value: isName ? 'Luna' : resource.includes('/3/0/1?') ? 'EZ-DEV54-GPS' : 'OTHER-SERIAL' },
      }) };
    },
  } } } });
  const linker = load('gateway-local-devices.ts', {
    './gateway-lwm2m': api,
    './profile-store': {
      listProfileDevices: async profileId => devices.filter(device => device.profileId === profileId),
      addDiscoveredProfileDevice: async details => {
        inserts.push(details);
        const existing = devices.find(device => device.profileId === details.profileId && device.serial.toUpperCase() === details.serial.toUpperCase());
        if (existing) return existing;
        const saved = { ...details, id: `local-${devices.length}`, createdAt: 'now', updatedAt: 'now' };
        devices.push(saved); return saved;
      },
    },
  });
  return { ...linker, devices, paths, inserts, failName: value => { nameFails = value; } };
}
const origin = 'http://10.20.30.1:8088';
const client = { endpoint: '5037CDF35BB6' };
test('existing serial links to local ID and name without requesting the name', async () => {
  const fixture = setup([{ id: 'paired-id', profileId: 'offline', serial: '5037cdf35bb6', name: 'My local name' }]);
  const result = await fixture.linkGatewayDevice(origin, 'offline', client);
  assert.equal(result.client.localDeviceId, 'paired-id');
  assert.equal(result.client.name, 'My local name');
  assert.equal(result.added, false);
  assert.equal(fixture.inserts.length, 0);
  assert.equal(fixture.paths.length, 0);
  assert.equal(result.client.product, 'collar');
});
test('unknown endpoint saves its name and serial once and reuses the local record on later discovery', async () => {
  const fixture = setup();
  const first = await fixture.linkGatewayDevice(origin, 'offline', client);
  assert.equal(first.added, true);
  assert.equal(fixture.devices.length, 1);
  assert.equal(fixture.devices[0].serial, client.endpoint); // endpoint is the link, not a conflicting Device resource
  assert.equal(fixture.devices[0].name, 'Luna');
  assert.equal(fixture.devices[0].deviceType, 'tracker');
  fixture.devices[0].name = 'Renamed locally';
  const second = await fixture.linkGatewayDevice(origin, 'offline', client);
  assert.equal(second.client.localDeviceId, first.client.localDeviceId);
  assert.equal(second.client.name, 'Renamed locally');
  assert.equal(second.added, false);
  assert.equal(fixture.inserts.length, 1);
  assert.equal(fixture.paths.filter(path => path.includes('/31029/0/7?')).length, 1);
});
test('local matching is scoped to the active profile', async () => {
  const fixture = setup([{ id: 'other', profileId: 'other-profile', serial: client.endpoint, name: 'Other profile' }]);
  const result = await fixture.linkGatewayDevice(origin, 'offline', client);
  assert.equal(result.added, true);
  assert.equal(result.client.name, 'Luna');
  assert.equal(fixture.devices.length, 2);
});
test('failed name reads are retried without persisting a placeholder', async () => {
  const fixture = setup(); fixture.failName(true);
  assert.equal((await fixture.linkGatewayDevice(origin, 'offline', client)).added, false);
  assert.equal(fixture.devices.length, 0);
  fixture.failName(false);
  assert.equal((await fixture.linkGatewayDevice(origin, 'offline', client)).added, true);
  assert.equal(fixture.devices[0].name, 'Luna');
});
test('aborted discovery does not fetch identity or save a device', async () => {
  const fixture = setup(); const controller = new AbortController(); controller.abort();
  await assert.rejects(fixture.linkGatewayDevice(origin, 'offline', client, controller.signal), /cancelled/);
  assert.equal(fixture.paths.length, 0);
  assert.equal(fixture.devices.length, 0);
});

test('existing camera uses its local section without requesting model or name', async () => {
  const fixture = setup([{ id: 'camera-id', profileId: 'offline', serial: client.endpoint, name: 'Yard camera', deviceType: 'camera' }]);
  const result = await fixture.linkGatewayDevice(origin, 'offline', client);
  assert.equal(result.client.product, 'camera');
  assert.equal(result.client.name, 'Yard camera');
  assert.equal(fixture.paths.length, 0);
});
