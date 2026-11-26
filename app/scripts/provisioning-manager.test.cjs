const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

function loadTs(filename, dependencies) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require(name) {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename });
  return module.exports;
}

function setup(camera = false, aligned = false) {
  const calls = [];
  const nativeCalls = [];
  let response = { ok: true, persisted: true };
  const platform = { Platform: { OS: 'android', Version: 34 }, PermissionsAndroid: {
    PERMISSIONS: { ACCESS_FINE_LOCATION: 'location', BLUETOOTH_SCAN: 'scan', BLUETOOTH_CONNECT: 'connect', NEARBY_WIFI_DEVICES: 'wifi' },
    check: async () => true,
  } };
  const esp = {
    ESPTransport: { ble: 'ble', softap: 'softap' }, ESPSecurity: { secure: 1, unsecure: 0 },
    ESPProvisionManager: { async searchESPDevices(prefix, transport, security) {
      calls.push(['scan', prefix, transport, security]);
      return [{ name: camera && prefix === 'PROV_' && transport === 'ble' ? 'PROV_CAM95a863' : `${prefix}AABBCCDDEEFF`,
        getDeviceCapabilities: async () => aligned && prefix === 'EZ_' ? ['wifi_scan', 'ez_wifi_prov', 'mqtt_config'] : [],
        connect: async (...args) => calls.push(['connect', prefix, ...args]),
        sendData: async (endpoint, data) => {
          calls.push(['send', prefix, endpoint, JSON.parse(data)]);
          return JSON.stringify(response);
        },
        disconnect: () => calls.push(['disconnect', prefix]),
        provision: async (ssid, password) => { calls.push(['provision', prefix, ssid, password]); return { status: 'success' }; },
      }, { name: `${prefix}invalid-name` }];
    } },
  };
  class EdgezNativeTransport {
    async invoke(method, args) { nativeCalls.push([method, args]); return JSON.stringify(response); }
  }
  // Exercise the real installed SDK's configuration validation and board fields.
  const sdk = loadTs(path.join(__dirname, '../node_modules/@edgez/react-native-sdk/src/Provisioning.ts'), {
    'base64-js': {}, 'react-native': platform,
    'react-native-ble-plx': { BleManager: class { constructor() { throw new Error('Legacy GATT transport used'); } } },
    '@orbital-systems/react-native-esp-idf-provisioning': esp,
    './EdgezMeshSdk': { EdgezNativeTransport },
  });
  const { ProvisioningManager } = loadTs(path.join(__dirname, '../provisioning-manager.ts'), {
    '@edgez/react-native-sdk': { ...sdk, EdgezNativeTransport },
    '@orbital-systems/react-native-esp-idf-provisioning': esp, 'react-native': platform,
  });
  return { manager: new ProvisioningManager(), calls, nativeCalls, setResponse: value => { response = value; } };
}
const input = { clientId: 'client', username: 'serial', password: 'secret', projectId: 'project',
  channel: 'channel', meshId: 'mesh', passphrase: '', country: 'US', halowChannel: 27,
  deviceName: 'Tracker', useDeviceGps: true };

test('ESP32 and nRF54 share secure BLE, PoP, and mqtt-config; nRF54 retains GPS fields', async () => {
  const { manager, calls } = setup();
  const { devices, warnings } = await manager.scan({ esp32BlePrefix: 'EZ_' });
  assert.equal(warnings.length, 0);
  assert.equal(devices.length, 4);
  assert.deepEqual(calls.slice(0, 2), [['scan', 'EZ_', 'ble', 1], ['scan', 'NRF_', 'ble', 1]]);
  for (const device of devices.slice(0, 2)) {
    assert.equal(device.requiresProofOfPossession, true);
    await assert.rejects(manager.connect(device), /password/);
    await manager.connect(device, ' abcd1234 ');
    await manager.configure(device, input);
    await manager.disconnect(device);
  }
  assert.deepEqual(calls.filter(call => call[0] === 'connect'), [
    ['connect', 'EZ_', 'abcd1234', null, null], ['connect', 'NRF_', 'abcd1234', null, null],
  ]);
  const sent = calls.filter(call => call[0] === 'send');
  assert.equal(sent[0][2], 'mqtt-config');
  assert.equal(sent[0][3].deviceName, 'Tracker');
  assert.equal(sent[1][2], 'mqtt-config');
  assert.equal(sent[1][3].halowFrequencyKHz, 915500);
  assert.equal(sent[1][3].useDeviceGps, true);
  assert.equal(sent[1][3].deviceName, 'Tracker');
  assert.equal(devices[1].firmwareTarget, 'nrf54l15');
  assert.equal(devices[1].supportsDeviceGps, true);
});

test('rejects unpersisted BLE configuration and preserves H7608 SoftAP transport', async () => {
  const { manager, calls, nativeCalls, setResponse } = setup();
  const { devices } = await manager.scan({ esp32BlePrefix: 'EZ_' });
  setResponse({ ok: true, persisted: false });
  await assert.rejects(manager.configure(devices[1], input), /persisted/);
  setResponse({ ok: true, persisted: true });
  await manager.connect(devices[3], 'wifi-password');
  await manager.configure(devices[3], { ...input, softapPassword: 'new-password' });
  assert.deepEqual(calls.find(call => call[0] === 'connect'), ['connect', 'PROV_', null, 'wifi-password', null]);
  assert.equal(nativeCalls[0][0], 'sendH7608CustomEndpoint');
  assert.equal(nativeCalls[0][1].endpoint, 'mqtt-config');
});


test('PROV_ BLE discovery recognizes camera model tags and stays separate from SoftAP', async () => {
  const { manager, calls } = setup(true);
  const { devices } = await manager.scan({ esp32BlePrefix: 'EZ_' });
  const camera = devices.find(device => device.name === 'PROV_CAM95a863');
  assert.ok(camera);
  assert.equal(camera.kind, 'nrf54');
  assert.equal(camera.serial, '95A863');
  assert.equal(camera.transport, 'ble');
  assert.equal(camera.firmwareTarget, 'nrf54l15');
  await manager.connect(camera, 'factory-derived-pop');
  assert.ok(calls.some(call => call[0] === 'scan' && call[1] === 'PROV_' && call[2] === 'ble' && call[3] === 1));
  assert.ok(calls.some(call => call[0] === 'scan' && call[1] === 'PROV_' && call[2] === 'softap' && call[3] === 0));
  assert.ok(calls.some(call => call[0] === 'connect' && call[1] === 'PROV_' && call[2] === 'factory-derived-pop'));
  const defaults = await manager.scan();
  assert.equal(defaults.devices.filter(device => device.name === 'PROV_CAM95a863').length, 1);
});


test('camera receives the profile SSID/password through standard provisioning, without mqtt-config', async () => {
  const { manager, calls } = setup(true);
  const { devices } = await manager.scan({ esp32BlePrefix: 'EZ_' });
  const camera = devices.find(device => device.name === 'PROV_CAM95a863');
  assert.equal(camera.supportsDeviceGps, false);
  const result = await manager.configure(camera, { ...input, meshId: 'halowlink2', passphrase: 'network-password', country: 'EU', halowChannel: 0 });
  assert.equal(result.persisted, true);
  assert.deepEqual(calls.find(call => call[0] === 'provision'), ['provision', 'PROV_', 'halowlink2', 'network-password']);
  assert.equal(calls.some(call => call[0] === 'send'), false);
});

function identityHelper(cloud, devices = []) {
  return loadTs(path.join(__dirname, '../provisioning-identity.ts'), {
    './cloud-auth': { prepareDeviceCredential: cloud },
    './profile-store': { listProfileDevices: async () => devices },
    './mesh-utils': { localMessageId: () => ({ uuid: '12345678-1234-4234-8234-123456789abc' }) },
  }).prepareProvisioningIdentity;
}

test('offline BLE and SoftAP provisioning never request cloud credentials or send stale cloud data', async () => {
  const prepare = identityHelper(() => { throw new Error('Offline provisioning must never call Appwrite'); });
  for (const kind of ['esp32', 'nrf54', 'h7608']) {
    const identity = await prepare({ id: 'offline', connectToCloud: false }, { kind, serial: 'ABCDEF' }, 'Camera', 'blue', {
      deviceId: 'cloud-device', clientId: 'cloud-client', username: 'cloud-user', password: 'cloud-password', projectId: 'cloud-project',
    });
    assert.equal(identity.deviceId, '12345678-1234-4234-8234-123456789abc');
    assert.equal(identity.clientId, identity.deviceId);
    assert.deepEqual(Object.keys(identity).sort(), ['clientId', 'deviceId']);
  }
});

test('offline reprovisioning reuses the local device UUID; cloud profiles keep credential creation', async () => {
  const prepareLocal = identityHelper(() => { throw new Error('Unexpected cloud call'); }, [{ id: 'saved-local-id', serial: 'abcdef' }]);
  const local = await prepareLocal({ id: 'local', connectToCloud: false }, { serial: 'ABCDEF' }, 'Name', 'blue');
  assert.equal(local.deviceId, 'saved-local-id');
  const calls = [];
  const credential = { deviceId: 'device', clientId: 'client', username: 'ABCDEF' };
  const prepareCloud = identityHelper(async (...args) => { calls.push(args); return credential; });
  const cloudProfile = { id: 'cloud', connectToCloud: true };
  const gateway = { kind: 'h7608', serial: 'ABCDEF', firmwareTarget: 'heltec-h7608-v1' };
  assert.equal(await prepareCloud(cloudProfile, gateway, 'Gateway', 'blue'), credential);
  assert.deepEqual(calls[0], ['cloud', 'ABCDEF', 'Gateway', 'heltec-h7608-v1', true, 'gateway', 'blue']);
  assert.equal(await prepareCloud(cloudProfile, gateway, 'Gateway', 'blue', credential), credential);
  assert.equal(calls.length, 1);
});


test('EZ_ names select standard nRF54 provisioning from capabilities, without changing serial', async () => {
  const { manager, calls } = setup(false, true);
  const { devices } = await manager.scan({ esp32BlePrefix: 'EZ_' });
  const device = devices[0];
  await manager.connect(device, 'factory-pop');
  assert.equal(device.kind, 'nrf54');
  assert.equal(device.serial, 'AABBCCDDEEFF');
  assert.equal(device.firmwareTarget, 'nrf54l15');
  await manager.configure(device, input);
  assert.ok(calls.some(call => call[0] === 'provision'));
  const sent = calls.find(call => call[0] === 'send');
  assert.equal(sent[2], 'mqtt-config');
  assert.equal(sent[3].deviceName, 'Tracker');
  assert.equal(sent[3].meshId, input.meshId);
  assert.ok(calls.findIndex(call => call[0] === 'send') < calls.findIndex(call => call[0] === 'provision'));
});

test('name persistence failure stops Wi-Fi provisioning', async () => {
  const { manager, calls, setResponse } = setup(false, true);
  const { devices } = await manager.scan({ esp32BlePrefix: 'EZ_' });
  await manager.connect(devices[0], 'factory-pop');
  setResponse({ ok: true, persisted: false });
  await assert.rejects(manager.configure(devices[0], input), /save its name/);
  assert.equal(calls.some(call => call[0] === 'provision'), false);
});
