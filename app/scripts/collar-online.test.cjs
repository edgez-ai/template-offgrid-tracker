const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');
const subject = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../keepteen/collar-model.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: subject, exports: subject.exports,
  require(name) {
    if (name === '@react-native-async-storage/async-storage') return {};
    if (name === '../mesh-utils') return { nodeNumFromSerial: () => null };
    throw new Error(name);
  },
});
const device = { serial: '5037cdf35bb6', kind: 'nrf54', deviceType: 'tracker', iconStyle: 'tracker', lastSeenAt: '', latitude: null, longitude: null };
test('registered serial makes only its collar online without inventing telemetry', () => {
  const nodes = subject.exports.buildCollarNodes([device, { ...device, serial: 'AABBCCDDEEFF' }], null, new Map(), 10000, ['5037CDF35BB6']);
  assert.equal(nodes[0].online, true);
  assert.equal(nodes[1].online, false);
  assert.equal(nodes[0].freshness, 'never');
  assert.equal(nodes[0].lastReportMs, 0);
  assert.equal(nodes[0].batteryVolts, null);
  assert.equal(subject.exports.buildCollarNodes([device], null, new Map(), 20000, [])[0].online, false);
});
