const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const jpeg = Buffer.from([255, 216, 255, 217]).toString('base64');
const tick = () => new Promise(setImmediate);
function fixture({ image = { type: 'OPAQUE', value: jpeg }, hold = '', fail = '', resolution = '640x480', confirm = true } = {}) {
  const calls = [], timers = new Map(); let id = 0;
  const api = {
    currentWifiGateway: async () => 'http://10.0.0.1:8088',
    executeGatewayResource: async (...args) => { calls.push(['execute', ...args]); if (fail) throw new Error(fail); if (hold === 'execute') await new Promise(() => {}); },
    writeGatewayResource: async (...args) => { calls.push(['write', ...args]); if (fail) throw new Error(fail); if (confirm) resolution = args[3]; },
    readGatewayResource: async (...args) => { calls.push(['read', ...args]); if (args[2] === '/5001/0/3') return { type: 'STRING', value: resolution }; if (hold === 'read') await new Promise(() => {}); return image; },
  };
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../gateway-camera.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, AbortController,
    setTimeout(fn, ms) { const next = ++id; timers.set(next, { fn, ms }); return next; }, clearTimeout(id) { timers.delete(id); },
    require(name) { if (name === './gateway-lwm2m') return api; if (name === 'base64-js') return require('base64-js'); throw Error(name); },
  });
  return { ...module.exports, calls, timers, expire() { for (const { fn, ms } of timers.values()) if (ms === 300000) fn(); } };
}
test('captures once, downloads the JPEG from the same endpoint, and returns an image URI', async () => {
  const f=fixture(); let downloads=0;
  const picture=await f.captureGatewayPicture('CAMERA',undefined,() => { downloads++; assert.equal(f.calls.length,1); });
  assert.equal(picture.uri,`data:image/jpeg;base64,${jpeg}`); assert.equal(picture.bytes,4); assert.equal(downloads,1);
  assert.deepEqual(f.calls.map(c => [c[0],c[2],c[3],c[5]]),[['execute','CAMERA','/5001/0/0',30],['read','CAMERA','/5001/0/1',300]]);
  assert.equal(f.calls[0][4],f.calls[1][4]); assert.equal(f.timers.size,0);
});
test('a pre-cancelled request never captures', async () => {
  const f=fixture(),c=new AbortController();c.abort();await assert.rejects(f.captureGatewayPicture('cam',c.signal),/cancelled/);assert.equal(f.calls.length,0);
});
for (const hold of ['execute','read']) {
  test(`cancels during ${hold} without leaving the UI waiting`,async () => {
    const f=fixture({hold}),c=new AbortController();const pending=f.captureGatewayPicture('cam',c.signal);await tick();c.abort();
    await assert.rejects(pending,/cancelled/);assert.ok(f.calls.every(c => c[4].aborted));assert.equal(f.timers.size,0);
    assert.equal(f.calls.length,hold==='execute'?1:2);
  });
}
test('one overall deadline aborts a stalled image download',async () => {
  const f=fixture({hold:'read'});const pending=f.captureGatewayPicture('cam');await tick();f.expire();
  await assert.rejects(pending,/timed out/);assert.equal(f.calls[1][4].aborted,true);
});
test('a failed capture never fetches a stale image',async () => {
  const f=fixture({fail:'Camera unavailable'});await assert.rejects(f.captureGatewayPicture('cam'),/unavailable/);assert.equal(f.calls.length,1);
});
for (const image of [{type:'STRING',value:jpeg},{type:'OPAQUE',value:'bad!'},{type:'OPAQUE',value:Buffer.from('not a JPEG').toString('base64')},{type:'OPAQUE',value:Buffer.from([255,216,1,2]).toString('base64')}]) {
  test(`rejects malformed or incomplete image ${image.value}`,async () => {
    const f=fixture({image});await assert.rejects(f.captureGatewayPicture('cam'),/image data|complete JPEG/);
  });
}

test('queries the camera resolution resource', async () => {
  const f = fixture({resolution: '320x240'});
  assert.equal(await f.readCameraResolution('cam'), '320x240');
  assert.deepEqual(f.calls.map(c => [c[0], c[2], c[3]]), [['read', 'cam', '/5001/0/3']]);
});
test('writes resolution and reads it back before confirming', async () => {
  const f = fixture();
  assert.equal(await f.changeCameraResolution('cam', '160x120'), '160x120');
  assert.deepEqual(f.calls.map(c => [c[0], c[2], c[3]]), [['write', 'cam', '/5001/0/3'], ['read', 'cam', '/5001/0/3']]);
  assert.equal(f.calls[0][4], '160x120');
});
test('rejects unsupported sizes before writing', async () => {
  const f = fixture();
  await assert.rejects(f.changeCameraResolution('cam', '1920x1080'), /Unsupported/);
  assert.equal(f.calls.length, 0);
});
test('does not confirm a resolution the device failed to apply', async () => {
  const f = fixture({confirm: false});
  await assert.rejects(f.changeCameraResolution('cam', '160x120'), /did not confirm/);
});
test('does not read after a failed resolution write', async () => {
  const f = fixture({fail: 'offline'});
  await assert.rejects(f.changeCameraResolution('cam', '160x120'), /offline/);
  assert.equal(f.calls.length, 1);
});
