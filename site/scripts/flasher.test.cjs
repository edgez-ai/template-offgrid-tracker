const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {parseIntelHex} = require('../public/flasher/firmware-hex.js');
test('parses application bytes and extended linear addresses', () => {
  const [segment] = parseIntelHex(':020000040001F9\n:0400000001020304F2\n:00000001FF');
  assert.equal(segment.address, 0x10000);
  assert.deepEqual([...segment.data], [1,2,3,4]);
});
test('rejects truncated, corrupt, overlapping and unterminated firmware', () => {
  for (const input of [':0400000001020304F3\n:00000001FF', ':0400000001F2\n:00000001FF', ':0400000001020304F2', ':0400000001020304F2\n:0400000001020304F2\n:00000001FF']) assert.throws(() => parseIntelHex(input));
});
test('standalone browser scripts have valid syntax', () => {
  const html = fs.readFileSync(require.resolve('../public/flasher/index.html'), 'utf8');
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});

test('Storage selection cannot load stale or failed firmware', async () => {
  const html = fs.readFileSync(require.resolve('../public/flasher/index.html'), 'utf8');
  const body = html.slice(html.indexOf('        async function selectPreset('), html.indexOf('        // SWD frequency controls'));
  const pending = new Map();
  const context = { isFlashing:false, firmwareLoadToken:0, selectedPreset:null, selectedFile:null, selectedFileContent:null,
    updateButtonState() {}, renderPresets() {}, log() {}, TextDecoder, Uint8Array,
    document:{getElementById:()=>({style:{},textContent:''})},
    fetch:(url)=>new Promise(resolve=>pending.set(url,resolve)) };
  vm.createContext(context); vm.runInContext(body,context);
  const a=context.selectPreset({id:'old',name:'nrf54l15__old.hex',path:'old'});
  const b=context.selectPreset({id:'new',name:'nrf54l15__new.hex',path:'new'});
  pending.get('new')({ok:true,arrayBuffer:async()=>new TextEncoder().encode('new firmware').buffer}); await b;
  pending.get('old')({ok:true,arrayBuffer:async()=>new TextEncoder().encode('stale firmware').buffer}); await a;
  assert.equal(context.selectedFileContent,'new firmware');
  const failed=context.selectPreset({id:'bad',name:'nrf54l15__bad.hex',path:'bad'});
  assert.equal(context.selectedFileContent,null);
  pending.get('bad')({ok:false,status:403}); await failed;
  assert.equal(context.selectedFileContent,null);
});
