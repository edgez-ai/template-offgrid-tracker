const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function fixture() {
  let handlers, closed=0,transform;const calls=[],cleanups=[];
  const module={exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../keepteen/CameraPictureViewer.tsx'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,{module,exports:module.exports,Date,Math,require(name){
    if(name==='react') return {useRef:value=>({current:value}),useState:value=>[value,next=>{transform=next;}],useEffect:fn=>{const cleanup=fn();if(cleanup)cleanups.push(cleanup);}};
    if(name==='react-native')return {Image:'Image',Modal:'Modal',View:'View',findNodeHandle:()=>42,NativeModules:{WifiGateway:{setCameraFullscreen:(...args)=>calls.push(args)}},StyleSheet:{create:x=>x,absoluteFill:{}},PanResponder:{create:h=>{handlers=h;return {panHandlers:{}};}}};
    if(name==='../camera-picture-gesture'){const m={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../camera-picture-gesture.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:m,exports:m.exports,Date,Math});return m.exports;}
    if(name==='./i18n')return {useI18n:()=>({t:key=>key})};
    return require(name);
  }});
  const tree=module.exports.CameraPictureViewer({uri:'file:///picture.jpg',onClose:()=>{closed++;}});
  tree.props.children.props.onLayout({nativeEvent:{layout:{width:2000,height:1000}}});
  const view=tree.props.children.props;
  handlers={onPanResponderGrant:view.onTouchStart,onPanResponderStart:view.onTouchStart,onPanResponderMove:view.onTouchMove,onPanResponderRelease:()=>view.onTouchEnd({nativeEvent:{touches:[]}})};
  return {tree,handlers,calls,cleanups,get closed(){return closed;},get transform(){return transform;}};
}
const event=(...points)=>({nativeEvent:{touches:points.map(([pageX,pageY])=>({pageX,pageY}))}});
test('tapping closes the image without any viewer buttons',()=>{
  const f=fixture();f.handlers.onPanResponderGrant(event([100,100]));f.handlers.onPanResponderRelease();assert.equal(f.closed,1);
  assert.equal(f.tree.props.children.props.children.type,'View');
  assert.equal(f.tree.props.children.props.children.props.pointerEvents,'none');
});
test('a pinch zooms and releasing it never closes the viewer',()=>{
  const f=fixture();f.handlers.onPanResponderGrant(event([100,100]));f.handlers.onPanResponderStart(event([100,100],[200,100]));
  f.handlers.onPanResponderMove(event([100,100],[200,100]));f.handlers.onPanResponderMove(event([50,100],[250,100]));f.handlers.onPanResponderRelease();
  assert.equal(f.transform.scale,2);assert.equal(f.closed,0);
});
test('dragging never counts as a tap to dismiss',()=>{
  const f=fixture();f.handlers.onPanResponderGrant(event([100,100]));f.handlers.onPanResponderMove(event([140,100]));f.handlers.onPanResponderRelease();assert.equal(f.closed,0);
});
test('entering and leaving the modal changes and restores native fullscreen mode',()=>{
  const f=fixture();f.tree.props.onShow();for(const cleanup of f.cleanups)cleanup();assert.deepEqual(f.calls,[[true,42],[false,0]]);
});

test('lifting one finger after a pinch and continuing to drag never closes',()=>{
  const f=fixture(), view=f.tree.props.children.props;
  view.onTouchStart(event([500,400]));view.onTouchStart(event([500,400],[700,400]));
  view.onTouchMove(event([400,400],[800,400]));
  assert.equal(f.transform.scale,2);
  view.onTouchEnd(event([400,400]));view.onTouchMove(event([550,450]));
  assert.equal(f.transform.x,150);assert.equal(f.transform.y,50);
  view.onTouchEnd(event());assert.equal(f.closed,0);
});
test('pinching inward zooms back out and never becomes a close tap',()=>{
  const f=fixture(),view=f.tree.props.children.props;
  view.onTouchStart(event([500,400],[700,400]));view.onTouchMove(event([400,400],[800,400]));assert.equal(f.transform.scale,2);
  view.onTouchMove(event([500,400],[700,400]));assert.equal(f.transform.scale,1);
  view.onTouchEnd(event([700,400]));view.onTouchEnd(event());assert.equal(f.closed,0);
});
test('a two-finger touch with no movement is not a close tap',()=>{
  const f=fixture(),view=f.tree.props.children.props;
  view.onTouchStart(event([500,400]));view.onTouchStart(event([500,400],[700,400]));view.onTouchEnd(event([700,400]));view.onTouchEnd(event());assert.equal(f.closed,0);
});
