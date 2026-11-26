const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function fixture() {
  const files=new Map();let failMove=false;
  const api={documentDirectory:'file:///private/app/',EncodingType:{Base64:'base64'},
    makeDirectoryAsync:async()=>{},
    writeAsStringAsync:async(uri,data)=>{files.set(uri,data);},
    moveAsync:async({from,to})=>{if(failMove)throw Error('disk full');files.set(to,files.get(from));files.delete(from);},
    deleteAsync:async uri=>{files.delete(uri);},
    readDirectoryAsync:async root=>[...files.keys()].filter(uri=>uri.startsWith(root)).map(uri=>uri.slice(root.length)),
    getInfoAsync:async uri=>({exists:files.has(uri),isDirectory:false,size:4}),
  };
  const module={exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../camera-gallery.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Date,Math,require:name=>name==='expo-file-system/legacy'?api:require(name)});
  return {...module.exports,files,failMove:()=>{failMove=true;}};
}
const picture={uri:'data:image/jpeg;base64,/9j/2Q==',bytes:4};
test('captured JPEG persists and is listed again with the same URI',async()=>{
  const f=fixture();const stored=await f.storeCameraPicture('cam',picture);
  assert.equal(f.files.get(stored.uri),'/9j/2Q==');assert.equal(stored.bytes,4);
  const loaded=await f.listCameraPictures('cam');assert.equal(loaded.length,1);assert.equal(loaded[0].uri,stored.uri);
  assert.ok(![...f.files.keys()].some(uri=>uri.endsWith('.tmp')));
});
test('galleries isolate endpoints, including path-like endpoint names',async()=>{
  const f=fixture();const stored=await f.storeCameraPicture('../cam',picture);
  assert.match(stored.uri,/camera-gallery\/[a-f0-9]{64}\/\d+-[a-z0-9]+\.jpg$/);
  assert.equal((await f.listCameraPictures('cam')).length,0);
});
test('failed writes leave no incomplete photo in the gallery',async()=>{
  const f=fixture();f.failMove();await assert.rejects(f.storeCameraPicture('cam',picture),/disk full/);
  assert.equal(f.files.size,0);assert.equal((await f.listCameraPictures('cam')).length,0);
});
test('deleting removes only the selected gallery photo',async()=>{
  const f=fixture();const first=await f.storeCameraPicture('cam',picture),second=await f.storeCameraPicture('cam',picture);
  await f.deleteCameraPicture('cam',first.uri);
  assert.equal(f.files.has(first.uri),false);assert.equal(f.files.has(second.uri),true);
  await assert.rejects(f.deleteCameraPicture('other',second.uri),/Invalid/);
  await assert.rejects(f.deleteCameraPicture('cam',second.uri+'/../outside'),/Invalid/);
});
test('listing ignores temporary and unrelated files',async()=>{
  const f=fixture();const stored=await f.storeCameraPicture('cam',picture);
  f.files.set(stored.uri+'.tmp','bad');assert.equal((await f.listCameraPictures('cam')).length,1);
});
