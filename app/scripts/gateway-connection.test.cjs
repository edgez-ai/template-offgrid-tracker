const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');
const moduleUnderTest = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../keepteen/connection.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, { module: moduleUnderTest, exports: moduleUnderTest.exports });
const { connectionSummary } = moduleUnderTest.exports;
const offline = { onlineMode: false, bleStatus: { phase: 'not-selected' }, gatewayConnected: true };
test('Collar reports its working gateway even when no BLE device is paired', () => {
  assert.equal(connectionSummary(offline, true).label, 'statusGatewayConnected');
  assert.equal(connectionSummary(offline, true).tone, 'online');
  assert.equal(connectionSummary(offline).label, 'statusNoController'); // Chat remains a BLE product.
});
test('lost gateway does not show the misleading pairing message; BLE-ready fallback still works', () => {
  assert.equal(connectionSummary({ ...offline, gatewayConnected: false }, true).label, 'statusGatewayUnavailable');
  assert.equal(connectionSummary({ ...offline, gatewayConnected: false, bleStatus: { phase: 'ready' } }, true).label, 'statusReady');
});
test('cloud profiles continue to report their cloud connection', () => {
  assert.equal(connectionSummary({ ...offline, onlineMode: true, cloudStatus: 'login' }, true).label, 'statusSignInRequired');
});
