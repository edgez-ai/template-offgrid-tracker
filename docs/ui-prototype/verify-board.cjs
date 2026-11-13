/* Browserless model and rendered-template checks. Does not claim visual/browser QA. */
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const path=require('node:path');
const os=require('node:os');
const snapshots=[];
let checks=0;
const check=(condition,message)=>{assert.ok(condition,message);checks++;};
function environment(storage=new Map()) {
  const elements=new Map(),listeners={};
  const element=id=>{
    if(!elements.has(id))elements.set(id,{id,innerHTML:'',textContent:'',value:id==='demo-send'?'delivered':id==='demo-apply'?'success':'',scrollTop:0,scrollHeight:100,style:{},classList:{set:new Set(),add(s){this.set.add(s);},remove(s){this.set.delete(s);},contains(s){return this.set.has(s);},toggle(s,force){if(force===true||force===undefined&&!this.set.has(s))this.set.add(s);else this.set.delete(s);return this.set.has(s);}},setAttribute(){},focus(){},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(name,fn){listeners[name]=fn;}});
    return elements.get(id);
  };
  const body=element('body');
  const context={console,TextEncoder,URL,Date,Map,Set,Promise,Blob,setTimeout,clearTimeout,setInterval,clearInterval,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},document:{body,getElementById:element},location:{hash:''},FormData:class {constructor(form){this.values=form.values;}get(k){return this.values[k]??null;}has(k){return k in this.values;}getAll(k){return this.values[k]||[];}}};
  context.window=context;vm.createContext(context);
  for(const name of ['radio-catalog.js','locales/base.js','locales/packs.js','i18n.js','product-art.js','media.js','product-ui.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,name),'utf8'),context,{filename:name});
  const board=context.EdgezBoard;
  const snapshot=name=>{const html=element('app').innerHTML;check(!html.includes('undefined')&&!html.includes('NaN'),'No undefined/NaN in '+name);const ids=[...html.matchAll(/(?:^|\s)id="([^"]+)"/g)].map(x=>x[1]);check(ids.length===new Set(ids).size,'Unique IDs in '+name);for(const m of html.matchAll(/data-act="([^"]+)"/g))check(typeof board.handlers[m[1]]==='function','Known action '+m[1]);snapshots.push({name,html});return html;};
  return {context,board,element,listeners,storage,snapshot};
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const env=environment(),{context:c,board:b,element,listeners,snapshot}=env,S=b.state;
  check((snapshot('home').match(/class="pz-product"/g)||[]).length===4,'Exactly four product entries');
  b.handlers.product({dataset:{value:'valve'}});check(S.route==='home'&&!S.modal,'Valve has no detail page');
  b.handlers.product({dataset:{value:'camera'}});check(S.route==='home'&&!S.modal,'Camera has no detail page');
  c.setSimState(1);b.handlers.connect({dataset:{target:'gateway'}});await b.handlers.pair();
  check(S.links.gateway&&!S.links.radio,'Pairing gateway does not connect radio');
  check(S.lifecycle===2,'Connected empty-network state');
  const locales=c.EdgezI18n.languages;
  check(locales.length===12,'Twelve selectable offline languages');
  for(const lang of locales.map(item=>item.code))for(const mode of [false,true])for(const state of [1,2,3]) {
    S.lang=lang;c.document.body.classList.toggle('dark-mode',mode);c.setSimState(state);
    for(const route of ['home','collar','chat','profile','networks']){b.navigate(route);snapshot(`${lang}-${mode}-${state}-${route}`);}
  }
  for(const item of locales){
    const pack=c.EdgezLocaleData[item.code];check(pack.length===326,'Complete language pack: '+item.code);
    for(let i=0;i<pack.length;i++){
      check(typeof pack[i]==='string'&&pack[i].trim().length>0,'Nonempty translation '+item.code+'/'+i);
      const actual=[...pack[i].matchAll(/\{p\d+\}/g)].map(m=>m[0]).sort().join(',');
      const expected=[...c.EdgezLocaleData.en[i].matchAll(/\{p\d+\}/g)].map(m=>m[0]).sort().join(',');
      check(actual===expected,'Translation parameters '+item.code+'/'+i);
      check(!c.EdgezI18n.t(item.code,'m'+String(i).padStart(3,'0'),{p0:2}).includes('{p'),'Parameters substituted');
    }
    S.lang=item.code;S.lifecycle=3;S.links={gateway:true,radio:true};
    for(const route of ['node','collar','chat','profile','networks']){S.nodeId='n01';S.thread=route==='chat'?'p1':null;b.navigate(route);snapshot('locale-detail-'+item.code+'-'+route);}
    b.openRadio('gateway');snapshot('locale-radio-'+item.code);b.openFence();snapshot('locale-fence-'+item.code);
    for(const name of ['language','identity','account','connection','about','storage']){S.modal=name;b.render();snapshot('locale-modal-'+item.code+'-'+name);}
  }
  const radioBeforeLanguage=JSON.stringify(S.radio),fencesBeforeLanguage=JSON.stringify(S.fences);
  b.handlers['set-language']({dataset:{value:'fr'}});check(S.lang==='fr','Language selection applies');
  check(JSON.stringify(S.radio)===radioBeforeLanguage&&JSON.stringify(S.fences)===fencesBeforeLanguage,'Language does not change RF or fence data');
  check(environment(env.storage).board.state.lang==='fr','Language persists after reload');
  check((element('app').innerHTML.match(/pz-product-art/g)||[]).length===0||element('app').innerHTML.includes('pz-product-art'),'Artwork is native SVG');
  b.navigate('home');check((element('app').innerHTML.match(/class="pz-product-art"/g)||[]).length===4,'Four refined product illustrations');
  check(!element('app').innerHTML.includes('<img'),'No photorealistic product images used');
  S.lang='zh';c.setSimState(3);b.navigate('collar');
  listeners.input({target:{id:'node-search',value:'023',closest:()=>null}});
  check(element('node-results').innerHTML.includes('023')&&!element('node-results').innerHTML.includes('026'),'Search filters real node rows');
  S.search='';S.filter='low';b.render();check(!snapshot('low-voltage').includes('DEMO-023')&&element('app').innerHTML.includes('DEMO-031'),'Low voltage filter');
  S.filter='all';b.handlers.node({dataset:{id:'n07'}});check(snapshot('missing-fix').includes('尚未收到定位'),'Missing GPS is explicit');
  check(!element('app').innerHTML.includes('31.23'),'Missing GPS does not use fallback coordinate');
  b.handlers.node({dataset:{id:'n08'}});check(snapshot('missing-battery').includes('—'),'Missing battery and RSSI remain unknown');
  b.navigate('collar');S.collarTab='map';b.render();snapshot('node-map');
  b.openFence();S.fenceDraft.name='Test fence';check(b.validateFence(S.fenceDraft)==='','Valid default circle');
  S.fenceDraft.enterAlert=false;S.fenceDraft.exitAlert=false;check(Boolean(b.validateFence(S.fenceDraft)),'At least one fence rule required');S.fenceDraft.exitAlert=true;
  for(const shape of ['circle','oval','rectangle','polygon']){
    const f={...S.fenceDraft,shape,vertices:[{latitude:31.230,longitude:121.474},{latitude:31.232,longitude:121.474},{latitude:31.232,longitude:121.477},{latitude:31.230,longitude:121.477}]};
    check(b.validateFence(f)==='','Valid '+shape);check(b.contains(f,{latitude:31.231,longitude:121.475})===true,'Inside '+shape);check(b.contains(f,{latitude:31.250,longitude:121.499})===false,'Outside '+shape);
    S.fenceDraft=f;b.render();snapshot('edit-'+shape);
  }
  S.fenceDraft.vertices=[{latitude:0,longitude:0},{latitude:1,longitude:1},{latitude:0,longitude:1},{latitude:1,longitude:0}];check(Boolean(b.validateFence(S.fenceDraft)),'Reject self-intersecting polygon');
  S.fenceDraft.shape='circle';S.fenceScope='selected';S.fenceDraft.deviceIds=[];check(Boolean(b.validateFence(S.fenceDraft)),'Selected scope requires a node');
  S.fenceDraft.deviceIds=['n01','n03'];check(b.saveFence(S.fenceDraft),'Save selected-node fence');check(env.storage.size>0,'Fence persisted');
  check(b.alarms().every(a=>a.n.latitude!==null&&Date.now()-a.n.lastSeenAt<=120000),'Never evaluate absent/stale fixes');
  c.setSimState(1);check(b.alarms().length===0,'No normal/alarm evaluation when disconnected');c.setSimState(3);
  check(Object.keys(b.catalog).sort().join(',')==='AU,CA,EU,GB,IN,JP,KR,NZ,US','All nine registered firmware regions');
  check(Object.values(b.catalog).reduce((sum,v)=>sum+v.length,0)===188,'All 188 active-domain channel records');
  for(const [country,rows] of Object.entries(b.catalog))for(const row of rows){check(Number.isFinite(row.frequencyHz)&&row.frequencyMHz===row.frequencyHz/1e6&&[1,2,4,8].includes(row.bandwidthMHz),'Frequency/bandwidth tuple '+country+row.number);check(['dutyCycleCentiPercent','omitControlResponse','globalOperatingClass','s1gOperatingClass','maxEirpDbm','minPacketSpacingUs','airtimeMinUs','airtimeMaxUs'].every(k=>k in row),'Full driver metadata retained');}
  b.openRadio('gateway');
  for(const country of Object.keys(b.catalog)) {const row=b.catalog[country].at(-1);S.radioDraft={country,halowChannel:row.number,bandwidth:row.bandwidthMHz,meshId:'DEMO',meshPassphrase:''};check(b.validateRadio(S.radioDraft)==='','Radio tuple valid for '+country);b.render();snapshot('radio-'+country);}
  S.radioDraft={country:'US',halowChannel:27,meshId:'牧'.repeat(11),meshPassphrase:''};check(Boolean(b.validateRadio(S.radioDraft)),'UTF-8 Mesh ID byte limit');
  S.radioDraft={country:'US',halowChannel:27,meshId:'DEMO',meshPassphrase:'short'};check(Boolean(b.validateRadio(S.radioDraft)),'Passphrase minimum');
  S.radioDraft.meshPassphrase='';check(!b.validateRadio(S.radioDraft),'Empty passphrase remains empty');
  S.radioDraft.halowChannel=255;check(Boolean(b.validateRadio(S.radioDraft)),'Unsupported channel rejected');
  S.radioDraft={country:'US',halowChannel:27,meshId:'CATTLE-DEMO',meshPassphrase:'demo-only-123'};S.links.gateway=false;const original=b.state.radio.gateway.applied.meshId;
  await b.applyRadio();check(S.radio.gateway.status==='pending'&&S.radio.gateway.applied.meshId===original,'Disconnected target saves without claiming application');
  S.links.gateway=true;await b.applyRadio();check(S.radio.gateway.status==='applied'&&S.radio.gateway.applied.meshId==='CATTLE-DEMO','Simulated read-back acknowledges target');
  check(S.radio.radio.applied.meshId==='OFFGRID-MESH-01','Gateway update leaves handheld unchanged');
  S.radioDraft.meshId='NEW-NETWORK';element('demo-apply').value='failed';await b.applyRadio();check(S.radio.gateway.status==='failed'&&S.radio.gateway.applied.meshId==='CATTLE-DEMO','Failed application preserves last applied values');
  b.openRadio('radio');S.radioDraft.meshId='RADIO-NEW';element('demo-apply').value='success';const applying=b.applyRadio();b.openRadio('gateway');await applying;check(S.radio.radio.applied.meshId==='RADIO-NEW'&&S.radio.gateway.applied.meshId==='CATTLE-DEMO','Target switching does not redirect in-flight response');
  const restored=environment(env.storage);check(restored.board.state.radio.radio.applied.meshId==='RADIO-NEW','Applied configuration survives reload');check(restored.board.state.fences.some(f=>f.name==='Test fence'),'Fence survives reload');
  b.navigate('chat');S.thread='c1';check(b.send('Public test'),'Public send accepted');await pause(400);check(S.messages.c1.at(-1).status==='sent','Broadcast never claims all-member delivery');
  S.thread='p1';check(b.send('<img src=x onerror=alert(1)>'),'Direct send accepted');await pause(700);check(S.messages.p1.at(-1).status==='delivered','Direct receipt state');check(snapshot('escaped-message').includes('&lt;img'),'Message HTML is escaped');
  element('demo-send').value='failed';b.send('Retry test');await pause(2300);const failed=S.messages.p1.at(-1);check(failed.status==='failed'&&failed.retryCount===3,'Three retries then failure');snapshot('failed-message');
  const length=S.messages.p1.length;element('demo-send').value='delivered';b.handlers.retry({dataset:{id:failed.id}});await pause(700);check(failed.status==='delivered'&&S.messages.p1.length===length,'Manual retry keeps one logical message');
  S.links.radio=false;check(!b.send('Offline test')&&S.messages.p1.length===length,'Disconnected radio does not fake-send');S.links.radio=true;check(!b.send('牛'.repeat(81)),'UTF-8 text size enforced');
  b.navigate('profile');b.handlers.account();snapshot('account-request');
  listeners.submit({preventDefault(){},target:{id:'account-form',values:{email:'demo@example.com'}}});check(S.otpEmail==='demo@example.com'&&!S.account,'OTP request does not sign in');
  listeners.submit({preventDefault(){},target:{id:'account-form',values:{email:'demo@example.com',otp:'000000'}}});check(!S.account&&S.error,'Wrong OTP rejected');
  listeners.submit({preventDefault(){},target:{id:'account-form',values:{email:'demo@example.com',otp:'123456'}}});check(S.account?.email==='demo@example.com','Demo account login');
  const fenceCount=S.fences.length;b.handlers.logout();check(!S.account&&S.fences.length===fenceCount,'Logout preserves local data');
  for(const name of ['identity','storage','about','add','connection']){S.modal=name;b.render();snapshot('sheet-'+name);}
  // A click inside a dialog must not cancel native checkbox/form behaviour.
  let prevented=false;const backdrop={dataset:{act:'backdrop'}};listeners.click({target:{closest:()=>backdrop},preventDefault(){prevented=true;}});check(!prevented,'Dialog content does not prevent native form events');
  S.lang='zh';c.setSimState(3);b.navigate('home');
  check(element('app').innerHTML.includes('项圈 / 耳标')&&!element('app').innerHTML.includes('牛项圈'),'Species-neutral product name');
  check(element('app').innerHTML.includes('聊天')&&!element('app').innerHTML.includes('对讲手持机'),'Chat product name');
  b.handlers.node({dataset:{id:'n03'}});S.modal='rename';
  listeners.submit({preventDefault(){},target:{id:'rename-form',values:{name:'小羊 031'}}});
  check(b.nodes.find(n=>n.id==='n03').name==='小羊 031','Node can be renamed');
  check(element('app').innerHTML.includes('小羊 031'),'Renamed node detail');
  b.navigate('collar');S.collarTab='map';b.render();check(element('app').innerHTML.includes('小羊 031'),'Map uses renamed node');
  check(environment(env.storage).board.nodes.find(n=>n.id==='n03').name==='小羊 031','Node alias survives reload');
  S.account=null;b.handlers.account();b.handlers['login-mode']({dataset:{value:'password'}});snapshot('password-login');
  listeners.submit({preventDefault(){},target:{id:'account-form',values:{email:'demo@example.com',password:'incorrect'}}});check(!S.account&&S.error,'Wrong password rejected');
  listeners.submit({preventDefault(){},target:{id:'account-form',values:{email:'demo@example.com',password:'Demo@123456'}}});check(S.account?.method==='password','Demo password login');b.handlers.logout();
  b.navigate('chat');S.thread='p1';S.modal=null;S.links.radio=true;S.lifecycle=3;
  element('demo-send').value='read';b.send('Read receipt test');const readMessage=S.messages.p1.at(-1);
  await pause(400);check(readMessage.status==='sent','Sent phase before ACK');
  await pause(300);check(readMessage.status==='delivered'&&!readMessage.readAt,'Delivered before read receipt');
  await pause(500);check(readMessage.status==='read'&&readMessage.readAt>=readMessage.deliveredAt,'Read requires separate simulated receipt');snapshot('read-message');
  S.thread='c2';b.send('Broadcast read test');await pause(400);check(S.messages.c2.at(-1).status==='sent'&&!S.messages.c2.at(-1).readAt,'Public channel never claims everyone read');
  S.thread='p1';element('demo-send').value='delivered';
  const png=new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZV8AAAAASUVORK5CYII=','base64')],{type:'image/png'});
  check(await b.media.choose(png,'image'),'Local image selection');S.caption='围栏照片';S.modal='compose-image';b.render();snapshot('image-preview');
  b.handlers['send-image']();const imageMessage=S.messages.p1.at(-1);await pause(700);
  check(imageMessage.attachmentKind==='image'&&imageMessage.objectUrl.startsWith('blob:')&&imageMessage.status==='delivered','Image message keeps local content and receipt');snapshot('image-message');
  check(!await b.media.choose(new Blob([new Uint8Array(8*1024*1024+1)],{type:'image/png'}),'image'),'Oversized attachment rejected');
  check(!await b.media.choose(new Blob(['<svg/>'],{type:'image/svg+xml'}),'image'),'Unsupported image type rejected');
  const wav=Buffer.alloc(844);wav.write('RIFF');wav.writeUInt32LE(836,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(8000,28);wav.writeUInt16LE(1,32);wav.writeUInt16LE(8,34);wav.write('data',36);wav.writeUInt32LE(800,40);wav.fill(128,44);
  check(await b.media.choose(new Blob([wav],{type:'audio/wav'}),'voice'),'Local audio selection');b.media.state.durationMs=100;S.modal='voice';b.render();snapshot('voice-preview');
  b.handlers['send-voice']();const voiceMessage=S.messages.p1.at(-1);await pause(700);check(voiceMessage.attachmentKind==='voice'&&voiceMessage.attachmentMimeType==='audio/wav'&&voiceMessage.status==='delivered','Voice file payload and receipt');check(snapshot('voice-message').includes('<audio'),'Voice message exposes playback controls');
  check(!await b.media.start(),'Recording unavailable handled without pretending to record');
  let stopped=false;const mockStream={getTracks:()=>[{stop(){stopped=true;}}]};
  c.navigator={mediaDevices:{getUserMedia:async()=>mockStream}};
  c.MediaRecorder=class {static isTypeSupported(){return true;}constructor(){this.state='inactive';this.mimeType='audio/webm';}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable({data:new Blob(['mock audio'],{type:'audio/webm'})});this.onstop();}};
  S.modal='voice';check(await b.media.start()&&b.media.state.recording,'Recording lifecycle with browser API double');b.media.stop();check(stopped&&!b.media.state.recording&&b.media.state.url,'Recorder stops tracks and provides preview');b.media.discard();
  c.navigator.mediaDevices.getUserMedia=async()=>{throw Object.assign(new Error('denied'),{name:'NotAllowedError'});};check(!await b.media.start()&&!b.media.state.recording,'Denied microphone leaves no fake recording');
  let resolvePermission,lateTrackStopped=false;c.navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{resolvePermission=resolve;});
  const pendingRecording=b.media.start();check(b.media.state.requesting,'Microphone permission request is tracked');check(!await b.media.start(),'Repeated recording request is blocked');b.media.discard();resolvePermission({getTracks:()=>[{stop(){lateTrackStopped=true;}}]});await pendingRecording;check(lateTrackStopped&&!b.media.state.recording&&!b.media.state.url,'Cancelled permission request cannot leave microphone active');
  for(const outcome of ['empty','off','denied','found']){element('demo-scan').value=outcome;await b.startSearch();check(S.scanStatus===outcome,'Discovery state '+outcome);snapshot('discovery-'+outcome);}
  b.handlers['discovered-device']({dataset:{id:'DEMO-GW-01'}});check(S.pendingDevice?.target==='gateway'&&S.modal==='connection','Discovered device selected by ID');await b.handlers.pair();check(S.bindings.gateway.id==='DEMO-GW-01','Binding is tied to selected discovery');
  const searching=b.startSearch();b.handlers.close();await searching;check(S.modal===null,'Cancelled discovery cannot reopen a closed dialog');
  b.openFence();S.fenceDraft.radiusMeters=NaN;b.render();snapshot('invalid-radius-preview');check(Boolean(b.validateFence(S.fenceDraft)),'Blank fence dimension rejected without invalid SVG');
  for(const item of locales){S.lang=item.code;S.modal='account';S.loginMode='password';b.render();snapshot('password-'+item.code);S.modal='voice';b.render();snapshot('media-'+item.code);}
  const report=path.join(os.tmpdir(),'edgez-ui-template-snapshots.json');fs.writeFileSync(report,JSON.stringify(snapshots));
  console.log(JSON.stringify({passed:checks,renderedTemplates:snapshots.length,snapshotFile:report,scope:'Browserless model and template verification; no visual or hardware verification'},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
