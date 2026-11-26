const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function fixture({version=36, granted=true, native=true}={}) {
  const calls=[];
  const module={exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../camera-photos.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText, {
    module,exports:module.exports,Date,
    require:name=>name === 'expo-file-system/legacy' ? {EncodingType:{Base64:'base64'},readAsStringAsync:async uri=>{calls.push(['read',uri]);return '/9j/2Q==';}} : ({Platform:{OS:'android',Version:version},NativeModules:{WifiGateway:native?{savePicture:async (...args)=>{calls.push(['save',...args]);return 'content://photo/1';}}:{}},PermissionsAndroid:{PERMISSIONS:{WRITE_EXTERNAL_STORAGE:'write'},RESULTS:{GRANTED:'granted'},request:async permission=>{calls.push(['permission',permission]);return granted?'granted':'denied';}}}),
  });
  return {...module.exports,calls};
}
test('saves the displayed JPEG without requesting library access on modern Android',async()=>{
  const f=fixture();assert.equal(await f.saveCameraPicture({uri:'data:image/jpeg;base64,/9j/2Q==',bytes:4},'../cam'),'content://photo/1');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][1],'data:image/jpeg;base64,/9j/2Q==');assert.match(f.calls[0][2],/^EZ____cam_\d+\.jpg$/);
});
test('legacy storage denial prevents saving',async()=>{
  const f=fixture({version:28,granted:false});await assert.rejects(f.saveCameraPicture({uri:'image',bytes:4},'cam'),/permission/);assert.equal(f.calls.length,1);
});
test('legacy Android requests storage permission before saving',async()=>{
  const f=fixture({version:28});await f.saveCameraPicture({uri:'image',bytes:4},'cam');assert.deepEqual(f.calls.map(c=>c[0]),['permission','save']);
});
test('older native builds give an actionable error',async()=>{
  const f=fixture({native:false});await assert.rejects(f.saveCameraPicture({uri:'image',bytes:4},'cam'),/latest Android/);assert.equal(f.calls.length,0);
});

test('exports a gallery JPEG by reading its local file',async()=>{
  const f=fixture();await f.saveCameraPicture({uri:'file:///photos/cam.jpg',bytes:4},'cam');
  assert.equal(f.calls[0][0],'read');assert.equal(f.calls[1][1],'data:image/jpeg;base64,/9j/2Q==');
});
