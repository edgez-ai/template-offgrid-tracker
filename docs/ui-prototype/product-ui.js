/* Interactive presentation only. No BLE, MQTT, cloud, audio or hardware commands. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const copy = value => JSON.parse(JSON.stringify(value));
  const catalog = window.EdgezRadioCatalog;
  const STORE = 'edgez.product-board.v1';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch {}
  const initialRadio = {country:'US',halowChannel:27,meshId:'OFFGRID-MESH-01',meshPassphrase:'demo-mesh-2026'};
  const freshRadio = () => ({desired:copy(initialRadio),applied:copy(initialRadio),status:'applied',revision:1});
  const baseTime = Date.now();
  const nodes = [
    ['n01','023','collar',3.98,-65,31.2310,121.4740,20],
    ['n02','026','tag',3.82,-72,31.2320,121.4770,42],
    ['n03','031','tag',3.29,-83,31.2370,121.4810,65],
    ['n04','035','collar',3.91,-69,31.2290,121.4730,83],
    ['n05','042','tag',3.64,-88,31.2260,121.4700,95],
    ['n06','047','collar',3.71,-76,31.2300,121.4790,900],
    ['n07','051','tag',3.86,-71,null,null,35],
    ['n08','058','collar',null,null,31.2280,121.4750,110],
  ].map(([id,name,type,batteryVoltage,rssi,latitude,longitude,age]) => ({id,name,type,serial:`DEMO-${name}`,gatewayId:'gateway-01',batteryVoltage,rssi,latitude,longitude,lastSeenAt:baseTime-age*1000,locationAt:latitude===null?null:baseTime-age*1000}));
  const peers = [{id:'p1',zh:'牧场管理员',en:'Ranch manager',online:true},{id:'p2',zh:'西区巡护员',en:'West patrol',online:true},{id:'p3',zh:'营地队友',en:'Camp teammate',online:false}];
  const defaultFence = {id:'f1',name:'牧区 A',nameKey:'m259',shape:'circle',center:{latitude:31.231,longitude:121.475},radiusMeters:500,radiusXMeters:600,radiusYMeters:350,widthMeters:1000,heightMeters:700,rotationDegrees:0,vertices:[],deviceIds:[],enterAlert:false,exitAlert:true,enabled:true};
  const S = {
    lang:window.EdgezI18n.has(saved.language)?saved.language:'zh',route:'home',lifecycle:3,links:{gateway:true,radio:true},collarTab:'nodes',chatTab:'channels',thread:null,nodeId:null,selectedMapNode:null,
    search:'',filter:'all',modal:null,error:'',fenceDraft:null,radioDraft:null,target:'gateway',map:{zoom:1,x:0,y:0},busy:false,
    fences:Array.isArray(saved.fences)&&saved.fences.every(f=>f&&typeof f.id==='string'&&['circle','oval','rectangle','polygon'].includes(f.shape)&&f.center&&Number.isFinite(f.center.latitude)&&Number.isFinite(f.center.longitude)&&Array.isArray(f.deviceIds)&&Array.isArray(f.vertices))?saved.fences:[copy(defaultFence)],
    acknowledged:[],radio:{gateway:freshRadio(),radio:freshRadio()},account:null,loginMode:'code',accountEmail:'',accountPassword:'',accountCode:'',showAccountPassword:false,otpEmail:'',scanStatus:'idle',pendingDevice:null,bindings:{gateway:null,radio:null},caption:'',identity:{name:saved.identityName||'',id:'demo-user-8c42',nodeId:'!a8f4c201',publicKey:'DEMO-PUBLIC-KEY'},messages:{},composerDrafts:{},storageError:false,
  };
  for(const n of nodes)if(typeof saved.nodeNames?.[n.id]==='string'&&saved.nodeNames[n.id].trim())n.name=saved.nodeNames[n.id].slice(0,40);
  const L = window.EdgezI18n;
  const t = (key,params) => L.t(S.lang,key,params);
  const identityName = () => S.identity.name || t('m254');
  const peerName = p => t(({p1:'m255',p2:'m256',p3:'m257'})[p.id]);
  const messageText = m => m.textKey ? t(m.textKey) : m.text || (m.attachmentKind?t(m.attachmentKind==='image'?'m281':'m282'):'');
  const nodeName = n => /^\d+$/.test(n.name) ? t(n.type==='tag'?'m025':'m026')+' '+n.name : n.name;
  const fenceName = f => f.nameKey ? t(f.nameKey) : f.name;
  const I = (name,extra='') => `<svg class="pz-icon ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({
    image:'<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.5"/><path d="m4 17 5-5 4 4 3-3 5 5"/>',mic:'<rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
    back:'<path d="m15 5-7 7 7 7"/>',next:'<path d="m9 5 7 7-7 7"/>',plus:'<path d="M12 5v14M5 12h14"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',
    home:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    user:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',radio:'<path d="M5 4h14a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-9l-5 3 1-3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z"/><path d="M7 9h10M7 13h7"/>',
    gateway:'<rect x="3" y="12" width="18" height="8" rx="3"/><path d="M6 12V6M18 12V6M9 5a5 5 0 0 1 6 0M10 8a3 3 0 0 1 4 0M7 16h.01M11 16h.01"/>',
    map:'<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5ZM9 3v16M15 5v16"/>',pin:'<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
    collar:'<ellipse cx="12" cy="12" rx="10" ry="6"/><rect x="8" y="8" width="8" height="8" rx="2"/>',tag:'<path d="m4 3 12 1 5 9-9 9-9-10Z"/><circle cx="8" cy="8" r="1.5"/>',
    fence:'<path d="M3 9V4h5M16 4h5v5M21 16v5h-5M8 21H3v-5"/><path d="M8 12h8M12 8v8"/>',settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--bg-card)"/><circle cx="15" cy="17" r="3" fill="var(--bg-card)"/>',
    send:'<path d="m4 12 16-8-6 17-3-7-7-2ZM11 14l9-10"/>',chat:'<path d="M21 11a9 9 0 0 1-9 9H4l-2 2V11a9 9 0 0 1 19 0Z"/><path d="M7 10h10M7 14h6"/>',
    shield:'<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z"/><path d="m8 12 3 3 5-6"/>',signal:'<path d="M4 20v-3M9 20v-7M14 20V9M19 20V4"/>',battery:'<rect x="2" y="6" width="18" height="12" rx="3"/><path d="M23 10v4M6 10h6v4H6z"/>',
    bell:'<path d="M5 17h14l-2-4V8A5 5 0 0 0 7 8v5l-2 4ZM10 21h4"/>',info:'<circle cx="12" cy="12" r="10"/><path d="M12 11v6M12 7h.01"/>',
    valve:'<path d="M2 13h20v7H2zM8 13V8h8v5M12 8V4M6 4h12"/>',camera:'<rect x="2" y="5" width="16" height="13" rx="4"/><circle cx="10" cy="11.5" r="3.5"/><path d="m18 9 4-3v12l-4-3M8 18v4M5 22h6"/>',
    minus:'<path d="M5 12h14"/>',refresh:'<path d="M20 7v5h-5M4 17v-5h5M20 12a8 8 0 0 0-14-5M4 12a8 8 0 0 0 14 5"/>',
  })[name]||''}</svg>`;
  const action = (act,label,cls='pz-primary',data='') => `<button type="button" class="${cls}" data-act="${act}" ${data}>${label}</button>`;
  const targetName = target => target==='gateway'?t('m000'):t('m001');
  const liveNodes = () => S.lifecycle===3&&S.links.gateway?nodes:[];
  const hasLink = (target=S.route==='chat'?'radio':'gateway') => Boolean(S.links[target]);
  const age = time => {
    if(!time) return t('m002');
    const sec=Math.max(0,Math.floor((Date.now()-time)/1000));
    return sec<60?t('m003',{p0:sec}):sec<3600?t('m004',{p0:Math.floor(sec/60)}):t('m005',{p0:Math.floor(sec/3600)});
  };
  const recent = n => hasLink()&&Date.now()-n.lastSeenAt<=120000;
  const nodeStatus = n => !hasLink()?t('m006'):recent(n)?t('m007'):t('m008');
  const linkLabel = target => hasLink(target)?t('m009'):t('m010');
  function persist() {
    try {localStorage.setItem(STORE,JSON.stringify({language:S.lang,fences:S.fences,identityName:S.identity.name,radio:S.radio,nodeNames:Object.fromEntries(nodes.map(n=>[n.id,n.name]))}));S.storageError=false;}
    catch {S.storageError=true;toast(t('m011'));}
  }
  let toastTimer;
  function toast(message) { const el=$('toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2400); }
  const media=window.EdgezMedia.create({language:()=>S.lang,notify:toast,onChange:type=>{
    if(type==='tick'){const el=$('app').querySelector('[data-record-time]');if(el)el.textContent=L.number(S.lang,media.state.seconds)+' s';}
    else if(['voice','compose-image'].includes(S.modal))render();
  }});
  function navigate(route) { media.discard();S.route=route;S.modal=null;S.error='';S.resetScroll=true;render(); }
  const head = (title,back='home',right='') => `<header class="pz-head">${action('nav',I('back')+t('m012'),'pz-back',`data-route="${back}"`)}<h2>${esc(title)}</h2>${right||'<span style="width:44px"></span>'}</header>`;
  const empty = (icon,title,desc,button='') => `<div class="pz-card pz-empty">${I(icon)}<div class="pz-title">${title}</div><p class="pz-sub">${desc}</p>${button}</div>`;
  const connection = target => `<button class="pz-card pz-connection" data-act="connect" data-target="${target}"><span class="pz-symbol">${I(target==='gateway'?'gateway':'radio')}</span><span class="pz-grow"><span class="pz-title">${targetName(target)}</span><br><span class="pz-small ${hasLink(target)?'pz-good':'pz-warn'}"><span class="pz-dot"></span>${linkLabel(target)} · ${hasLink(target)?t('m013'):t('m014')}</span></span>${I('next')}</button>`;
  const tabs = (items,current,act) => `<div class="pz-segments" role="tablist">${items.map(([id,label])=>`<button role="tab" aria-selected="${current===id}" data-act="${act}" data-value="${id}">${label}</button>`).join('')}</div>`;
  function home() {
    const products=[['collar',t('m015'),'collar',linkLabel('gateway'),'pz-neutral'],['chat',t('m001'),'radio',linkLabel('radio'),'pz-neutral'],['valve',t('m016'),'valve',t('m017'),'pz-neutral'],['camera',t('m018'),'camera',t('m017'),'pz-neutral']];
    return `<div class="pz-page"><header class="pz-head"><h1>${t('m019')}</h1>${action('add',I('plus'),'pz-icon-btn',`aria-label="${t('m020')}"`)}</header><p class="pz-sub" style="margin:-8px 0 20px">${t('m021')}</p><div class="pz-section"><h3>${t('m022')}</h3><span class="pz-small">04</span></div><div class="pz-product-grid">${products.map(([id,name,icon,status,color])=>`<button class="pz-product" data-act="product" data-value="${id}"><span class="pz-product-visual ${color}">${window.EdgezProductArt[icon]}</span><span class="pz-title">${name}</span><span class="pz-small"><span><span class="pz-dot ${['valve','camera'].includes(id)?'':hasLink(id==='chat'?'radio':'gateway')?'pz-blue':'pz-warn'}"></span>${status}</span>${I('next')}</span></button>`).join('')}</div>${action('add',I('plus')+t('m023'),'pz-add')}</div>`;
  }
  function nodeCard(n) {
    return `<button class="pz-node" data-act="node" data-id="${n.id}"><span class="pz-node-top"><span class="pz-avatar">${I(n.type==='tag'?'tag':'collar')}</span><span class="pz-grow"><span class="pz-title">${esc(nodeName(n))}</span><br><span class="pz-small">${n.type==='tag'?t('m025'):t('m026')} · ${esc(n.serial)}</span></span>${I('next')}</span><span class="pz-node-metrics"><span><b class="${n.batteryVoltage!==null&&n.batteryVoltage<3.4?'pz-warn':''}">${n.batteryVoltage===null?'—':L.number(S.lang,n.batteryVoltage,{minimumFractionDigits:2,maximumFractionDigits:2})+' V'}</b>${t('m027')}</span><span><b>${n.rssi===null?'—':n.rssi+' dBm'}</b>${t('m028')}</span><span><b>${age(n.lastSeenAt)}</b>${t('m029')}</span></span><span class="pz-small" style="display:block;margin-top:10px">${nodeStatus(n)} · ${n.latitude===null?t('m030'):recent(n)?t('m031'):t('m032')}</span></button>`;
  }
  function collar() {
    const list=liveNodes();
    const filtered=list.filter(n=>(n.name+' '+n.serial).toLowerCase().includes(S.search.toLowerCase())&&(S.filter==='all'||S.filter==='low'&&n.batteryVoltage!==null&&n.batteryVoltage<3.4||S.filter==='stale'&&!recent(n)||S.filter==='no-fix'&&n.latitude===null));
    return `<div class="pz-page">${head(t('m015'),'home',action('settings',I('settings'),'pz-icon-btn','data-target="gateway" aria-label="HaLow"'))}${connection('gateway')}<div class="pz-stat-grid"><div class="pz-stat"><b>${list.length}</b><span class="pz-small">${t('m033')}</span></div><div class="pz-stat"><b class="pz-good">${list.filter(recent).length}</b><span class="pz-small">${t('m007')}</span></div><div class="pz-stat"><b class="pz-warn">${list.filter(n=>n.batteryVoltage!==null&&n.batteryVoltage<3.4).length}</b><span class="pz-small">${t('m034')}</span></div></div>${tabs([['nodes',t('m035')],['map',t('m036')],['fences',t('m037')]],S.collarTab,'collar-tab')}${S.collarTab==='nodes'?`<div class="pz-tools"><input id="node-search" type="search" placeholder="${t('m038')}" aria-label="${t('m039')}" value="${esc(S.search)}"><select id="node-filter" aria-label="${t('m040')}">${[['all',t('m041')],['low',t('m034')],['stale',t('m042')],['no-fix',t('m030')]].map(([v,l])=>`<option value="${v}" ${S.filter===v?'selected':''}>${l}</option>`).join('')}</select></div><div id="node-results">${nodeResults(filtered,list)}</div>`:S.collarTab==='map'?mapPanel():fencePanel()}</div>`;
  }
  function nodeResults(filtered,list) {
    return filtered.length?filtered.map(nodeCard).join(''):empty('collar',list.length?t('m043'):t('m044'),list.length?t('m045'):hasLink()?t('m046'):t('m047'),!hasLink()?action('connect',t('m048'),'pz-primary','data-target="gateway"'):'');
  }
  function nodeDetail() {
    const n=nodes.find(n=>n.id===S.nodeId);if(!n)return empty('collar',t('m049'),'');
    const hasFix=n.latitude!==null;
    return `<div class="pz-page">${head(nodeName(n),'collar')}<div class="pz-card"><div class="pz-node-top"><span class="pz-avatar">${I(n.type==='tag'?'tag':'collar')}</span><div><div class="pz-title">${esc(n.serial)}</div><div class="pz-small">${t('m051')}</div></div></div><div class="pz-sub">${nodeStatus(n)} · ${age(n.lastSeenAt)}</div></div><div class="pz-pairs"><div class="pz-card"><div class="pz-small">${t('m027')}</div><div class="pz-value">${n.batteryVoltage===null?'—':L.number(S.lang,n.batteryVoltage,{minimumFractionDigits:2,maximumFractionDigits:2})+' V'}</div><div class="pz-small">${t('m052')}</div></div><div class="pz-card"><div class="pz-small">${t('m028')}</div><div class="pz-value" style="font-size:19px">${n.rssi===null?'—':n.rssi+' dBm'}</div><div class="pz-small">${t('m053')}</div></div></div><div class="pz-card"><div class="pz-title">${t('m029')}</div><p class="pz-sub">${new Date(n.lastSeenAt).toLocaleString(L.locale(S.lang))}</p><div class="pz-title">${t('m054')}</div><p class="pz-code">${hasFix?`${n.latitude.toFixed(6)}, ${n.longitude.toFixed(6)}`:t('m055')}</p><div class="pz-small">${hasFix?t('m056')+age(n.locationAt):t('m057')}</div></div>${hasFix?action('locate-node',I('map')+t('m058'),'pz-primary',`data-id="${n.id}"`):''}${action('rename-node',t('m059'),'pz-secondary',`data-id="${n.id}"`)}<p class="pz-small" style="margin:14px 0">${t('m060')}</p></div>`;
  }
  const pointXY = p => ({x:(p.longitude-121.465)/.020*360,y:(31.241-p.latitude)/.020*300});
  const pointGeo = (x,y) => ({latitude:31.241-y/300*.020,longitude:121.465+x/360*.020});
  function contains(f,p) {
    if(!p||!Number.isFinite(p.latitude)||!Number.isFinite(p.longitude))return null;
    const lat=(p.latitude-f.center.latitude)*111320,lon=(p.longitude-f.center.longitude)*111320*Math.cos(f.center.latitude*Math.PI/180),a=-(f.rotationDegrees||0)*Math.PI/180;
    const x=lon*Math.cos(a)-lat*Math.sin(a),y=lon*Math.sin(a)+lat*Math.cos(a);
    if(f.shape==='circle')return x*x+y*y<=f.radiusMeters**2;
    if(f.shape==='oval')return (x/f.radiusXMeters)**2+(y/f.radiusYMeters)**2<=1;
    if(f.shape==='rectangle')return Math.abs(x)<=f.widthMeters/2&&Math.abs(y)<=f.heightMeters/2;
    let inside=false;for(let i=0,j=f.vertices.length-1;i<f.vertices.length;j=i++) {const a=f.vertices[i],b=f.vertices[j];if((a.latitude>p.latitude)!==(b.latitude>p.latitude)&&p.longitude<(b.longitude-a.longitude)*(p.latitude-a.latitude)/(b.latitude-a.latitude)+a.longitude)inside=!inside;}return inside;
  }
  function fenceSvg(f,draft=false) {
    if(!Number.isFinite(f.center?.latitude)||!Number.isFinite(f.center?.longitude)||!Number.isFinite(f.rotationDegrees))return '';
    const dimensions={circle:['radiusMeters'],oval:['radiusXMeters','radiusYMeters'],rectangle:['widthMeters','heightMeters'],polygon:[]}[f.shape]||[];
    if(dimensions.some(key=>!Number.isFinite(f[key])||f[key]<=0))return '';
    const c=pointXY(f.center),sx=360/(.020*111320*Math.cos(f.center.latitude*Math.PI/180)),sy=300/(.020*111320);
    const attrs=`fill="#0a84ff20" stroke="#0a84ff" stroke-width="1.7" ${draft?'stroke-dasharray="5 4"':''}`;
    if(f.shape==='polygon')return `<polygon points="${f.vertices.map(p=>{const q=pointXY(p);return q.x+','+q.y;}).join(' ')}" ${attrs}/>${f.vertices.map(p=>{const q=pointXY(p);return `<circle cx="${q.x}" cy="${q.y}" r="3" fill="#0a84ff"/>`;}).join('')}`;
    const geometry=f.shape==='rectangle'?`<rect x="${-f.widthMeters*sx/2}" y="${-f.heightMeters*sy/2}" width="${f.widthMeters*sx}" height="${f.heightMeters*sy}" rx="2" ${attrs}/>`:`<ellipse rx="${(f.shape==='circle'?f.radiusMeters:f.radiusXMeters)*sx}" ry="${(f.shape==='circle'?f.radiusMeters:f.radiusYMeters)*sy}" ${attrs}/>`;
    return `<g transform="translate(${c.x} ${c.y}) rotate(${-(f.rotationDegrees||0)})">${geometry}</g>`;
  }
  function mapSvg(editor=false) {
    const m=S.map;return `<div class="pz-map"><svg id="${editor?'pz-map-editor':'pz-map'}" data-map="${editor?'editor':'view'}" viewBox="0 0 360 300" preserveAspectRatio="none" role="group" aria-label="${t('m061')}" data-editor="${editor}"><g id="${editor?'pz-map-content-editor':'pz-map-content'}" data-map-content="true" transform="translate(${m.x} ${m.y}) translate(180 150) scale(${m.zoom}) translate(-180 -150)"><rect x="-2000" y="-2000" width="4400" height="4300" fill="var(--map-surface)"/><path d="M0 20 145 0 205 95 165 190 0 160Z" fill="var(--map-land)"/><path d="m235 145 125-35v190H205Z" fill="var(--map-land-alt)"/><path d="M-80 250Q70 105 190 155T450 0" fill="none" stroke="var(--map-water)" stroke-width="24"/><path d="M-40 75 400 240M90-40l75 400" stroke="var(--map-road)" stroke-width="11"/><path d="M-40 75 400 240M90-40l75 400" stroke="var(--map-road-line)" stroke-width="1" stroke-dasharray="5 4"/><text x="25" y="35" fill="var(--map-label)" font-size="11">${t('m062')}</text><text x="240" y="280" fill="var(--map-label)" font-size="11">${t('m063')}</text>${editor?fenceSvg(S.fenceDraft,true):S.fences.filter(f=>f.enabled).map(f=>fenceSvg(f)).join('')}${liveNodes().filter(n=>n.latitude!==null).map(n=>{const p=pointXY(n),selected=S.selectedMapNode===n.id;return `<g class="pz-marker" role="button" tabindex="0" aria-label="${esc(nodeName(n))}" data-act="map-node" data-id="${n.id}" transform="translate(${p.x} ${p.y})"><circle r="${selected?13:10}" fill="${recent(n)?'#0a84ff':'#8e8e93'}" stroke="white" stroke-width="3"/><text y="-17" text-anchor="middle" fill="var(--map-node-label)" font-size="11" font-weight="600">${esc(n.name)}</text></g>`;}).join('')}</g></svg><div class="pz-map-actions">${action('zoom',I('plus'),'pz-icon-btn',`data-value="in" aria-label="${t('m260')}"`)}${action('zoom',I('minus'),'pz-icon-btn',`data-value="out" aria-label="${t('m261')}"`)}${action('zoom',I('refresh'),'pz-icon-btn',`data-value="reset" aria-label="${t('m262')}"`)}</div><div class="pz-map-caption">${t('m064')}</div></div>`;
  }
  function mapPanel() {
    const located=liveNodes().filter(n=>n.latitude!==null),selected=located.find(n=>n.id===S.selectedMapNode);
    return `${mapSvg()}<div class="pz-map-key"><span class="pz-blue">● ${t('m065')}</span><span>● ${t('m066')}</span><span>${located.length} ${t('m067')}</span></div><p class="pz-small">${t('m068')}</p>${selected?nodeCard(selected):empty('pin',t('m069'),t('m070'))}${liveNodes().some(n=>n.latitude===null)?`<div class="pz-notice">${t('m071')}</div>`:''}`;
  }
  function alarms() {
    if(S.lifecycle!==3)return [];
    return S.fences.filter(f=>f.enabled).flatMap(f=>liveNodes().filter(n=>recent(n)&&n.latitude!==null&&(!f.deviceIds.length||f.deviceIds.includes(n.id))).flatMap(n=>{
      const inside=contains(f,n),event=inside?'enter':'exit';return (inside?f.enterAlert:f.exitAlert)?[{id:f.id+':'+n.id+':'+event,f,n,event}]:[];
    }));
  }
  function fencePanel() {
    const alerts=alarms();
    return `${action('new-fence',I('plus')+t('m072'))}${S.fences.map(f=>`<div class="pz-card" style="margin-top:12px"><div class="pz-node-top"><span class="pz-avatar">${I('fence')}</span><div class="pz-grow"><div class="pz-title">${esc(fenceName(f))}</div><div class="pz-small">${shapeName(f.shape)} · ${f.enabled?t('m073'):t('m074')}</div></div>${action('edit-fence',I('next'),'pz-icon-btn',`data-id="${f.id}" aria-label="${t('m075')}"`)}</div><div class="pz-small">${f.deviceIds.length?t('m076',{p0:f.deviceIds.length}):t('m077')} · ${[f.enterAlert?t('m078'):'',f.exitAlert?t('m079'):''].filter(Boolean).join(' / ')}</div></div>`).join('')}<div class="pz-section"><h3>${t('m080')}</h3><span class="pz-small">${alerts.length}</span></div>${alerts.length?alerts.map(a=>`<div class="pz-card"><div class="pz-title pz-warn">${esc(nodeName(a.n))} · ${a.event==='exit'?t('m081'):t('m082')}</div><p class="pz-small">${esc(fenceName(a.f))} · ${t('m083')} ${age(a.n.locationAt)}</p>${S.acknowledged.includes(a.id)?`<div class="pz-small">${t('m084')}</div>`:action('ack',t('m085'),'pz-secondary',`data-id="${a.id}"`)}</div>`).join(''):empty('shield',t('m086'),S.lifecycle===3?t('m087'):t('m088'))}<div class="pz-notice">${t('m089')}</div>`;
  }
  function shapeName(shape){return ({circle:t('m090'),oval:t('m091'),rectangle:t('m092'),polygon:t('m093')})[shape];}
  const channelNames = () => [t('m094'),t('m095'),t('m096'),t('m097'),t('m098')];
  function threadName(id) {return id.startsWith('c')?'#'+id.slice(1)+' '+channelNames()[Number(id.slice(1))-1]:(peers.find(p=>p.id===id)?peerName(peers.find(p=>p.id===id)):id);}
  const canSend = () => S.lifecycle===3&&hasLink('radio')&&(S.thread?.startsWith('c')||peers.find(p=>p.id===S.thread)?.online);
  const messageLabel = m => ({sending:t('m099'),sent:t('m100'),delivered:t('m101'),read:t('m280'),failed:t('m102'),retrying:t('m103',{p0:m.retryCount})})[m.status]||'';
  function chat() {
    if(S.thread) {
      const history=S.messages[S.thread]||[],publicChannel=S.thread.startsWith('c');
      return `<div class="pz-page pz-conversation">${head(threadName(S.thread),'chat-list',action('thread-info',I('info'),'pz-icon-btn',`aria-label="${t('m104')}"`))}<div class="pz-small" style="margin:-8px 0 8px">${publicChannel?t('m105'):t('m106')}</div>${!canSend()?`<div class="pz-notice">${hasLink()?t('m107'):t('m108')}</div>`:''}<div class="pz-messages" id="pz-messages">${history.length?history.map(messageBubble).join(''):`<div class="pz-empty pz-small">${t('m110')}</div>`}</div><div class="pz-phrases">${[t('m111'),t('m112'),t('m113')].map(text=>action('phrase',esc(text),'',`data-text="${esc(text)}" ${canSend()?'':'disabled'}`)).join('')}</div><form class="pz-composer" id="chat-form" novalidate>${action('choose-image',I('image'),'pz-icon-btn',`aria-label="${t('m283')}" ${canSend()?'':'disabled'}`)}<input name="message" id="message-input" value="${esc(S.composerDrafts[S.thread]||'')}" maxlength="240" autocomplete="off" placeholder="${t('m114')}" aria-label="${t('m115')}" ${canSend()?'':'disabled'} required>${action('voice',I('mic'),'pz-icon-btn',`aria-label="${t('m284')}" ${canSend()?'':'disabled'}`)}<button class="pz-send" type="submit" aria-label="${t('m116')}" ${canSend()?'':'disabled'}>${I('send')}</button></form><input id="image-picker" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden><input id="audio-picker" type="file" accept="audio/*" hidden></div>`;
    }
    const list=S.chatTab==='channels'?channelNames().map((name,i)=>({id:'c'+(i+1),name:'#'+(i+1)+' '+name,icon:'chat',sub:t('m117')})):S.lifecycle===3?peers.map(p=>({id:p.id,name:peerName(p),icon:'user',sub:!hasLink('radio')?t('m006'):p.online?t('m118'):t('m119')})):[];
    return `<div class="pz-page">${head(t('m001'),'home',action('settings',I('settings'),'pz-icon-btn','data-target="radio" aria-label="HaLow"'))}${connection('radio')}<div class="pz-section"><h3>${t('m120')}</h3><span class="pz-small">${S.lifecycle===3&&hasLink('radio')?t('m121'):t('m122')}</span></div>${tabs([['channels',t('m123')],['people',t('m124')]],S.chatTab,'chat-tab')}<div class="pz-card">${list.length?list.map(item=>{const messages=S.messages[item.id]||[],last=messages[messages.length-1];return `<button class="pz-menu" data-act="thread" data-id="${item.id}"><span class="pz-avatar">${I(item.icon)}</span><span class="pz-grow"><span class="pz-title">${esc(item.name)}</span><small>${last?esc(messageText(last)):item.sub}</small></span>${I('next')}</button>`;}).join(''):empty('user',t('m125'),t('m126'))}</div><p class="pz-small">${t('m127')}</p></div>`;
  }
  function seedConversation(id) {
    if(!S.messages[id])S.messages[id]=S.lifecycle===3?[{id:'seed-'+id,mine:false,textKey:'m258',text:'Near the west fence. Returning to the rally point.',timestampMs:baseTime-120000,status:'received'}]:[];
  }
  const menu = (act,icon,title,sub,data='') => `<button class="pz-menu" data-act="${act}" ${data}>${I(icon)}<span class="pz-grow"><span class="pz-title">${title}</span><small>${sub}</small></span>${I('next')}</button>`;
  function profile() {
    return `<div class="pz-page"><header class="pz-head"><h1>${t('m128')}</h1></header><button class="pz-card pz-connection pz-account" data-act="account"><span class="pz-avatar">${I('user')}</span><span class="pz-grow"><span class="pz-title">${S.account?esc(S.account.name):t('m129')}</span><br><span class="pz-small">${S.account?esc(S.account.email):t('m130')}</span></span>${I('next')}</button><div class="pz-section"><h3>${t('m131')}</h3></div><div class="pz-card" style="padding-top:0;padding-bottom:0">${menu('identity','shield',t('m132'),esc(identityName())+' · '+esc(S.identity.nodeId))}${menu('networks','signal',t('m133'),t('m134'))}</div><div class="pz-section"><h3>${t('m135')}</h3></div><div class="pz-card" style="padding-top:0;padding-bottom:0">${menu('storage','map',t('m136'),t('m137'))}${menu('language','user',t('m138'),L.name(S.lang))}${menu('appearance','settings',t('m139'),document.body.classList.contains('dark-mode')?t('m140'):t('m141'))}${menu('about','info',t('m142'),t('m143'))}</div><p class="pz-small">${t('m144')}</p></div>`;
  }
  function networks() {
    return `<div class="pz-page">${head(t('m133'),'profile')}${['gateway','radio'].map(target=>{const item=S.radio[target];return `<button class="pz-card pz-connection" data-act="settings" data-target="${target}"><span class="pz-symbol">${I(target==='gateway'?'gateway':'radio')}</span><span class="pz-grow"><span class="pz-title">${targetName(target)}</span><br><span class="pz-small">${esc(item.desired.country)} · CH ${item.desired.halowChannel} · ${esc(item.desired.meshId)}</span><br><span class="pz-small ${item.status==='applied'?'pz-good':'pz-warn'}">${radioStatus(item)}</span></span>${I('next')}</button>`;}).join('')}<div class="pz-notice">${t('m145')}</div></div>`;
  }
  const radioStatus = item => ({applied:t('m146'),pending:t('m147'),applying:t('m148'),failed:t('m149')})[item.status];
  function field(name,label,value,type='text',attrs='') {return `<label class="pz-field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(type==='number'&&typeof value==='number'&&!Number.isFinite(value)?'':value)}" ${attrs}></label>`;}
  function selectField(name,label,options) {return `<label class="pz-field"><span>${label}</span><select name="${name}">${options}</select></label>`;}
  function radioForm() {
    const d=S.radioDraft,item=S.radio[S.target],channel=catalog[d.country].find(c=>c.number===Number(d.halowChannel)),bandwidth=d.bandwidth||channel.bandwidthMHz;
    const bws=[...new Set(catalog[d.country].map(c=>c.bandwidthMHz))];
    return `<form id="radio-form" novalidate><div class="pz-notice">${t('m150')}<strong>${targetName(S.target)}</strong><br>${radioStatus(item)}</div>${selectField('country',t('m151'),Object.keys(catalog).map(code=>`<option value="${code}" ${d.country===code?'selected':''}>${code} · ${esc(L.region(S.lang,code))}</option>`).join(''))}${selectField('bandwidth',t('m152'),bws.map(bw=>`<option value="${bw}" ${bw===Number(bandwidth)?'selected':''}>${bw} MHz</option>`).join(''))}${selectField('halowChannel',t('m153'),catalog[d.country].filter(c=>c.bandwidthMHz===Number(bandwidth)).map(c=>`<option value="${c.number}" ${c.number===Number(d.halowChannel)?'selected':''}>CH ${c.number} · ${L.number(S.lang,c.frequencyMHz)} MHz</option>`).join(''))}${field('meshId',t('m154'),d.meshId,'text','required maxlength="32" autocomplete="off"')}${field('meshPassphrase',t('m155'),d.meshPassphrase,S.showPass?'text':'password','maxlength="63" autocomplete="off"')}<label class="pz-check"><input id="show-pass" type="checkbox" ${S.showPass?'checked':''}>${t('m156')}</label><div class="pz-small">${t('m157')}</div><div class="pz-error" role="alert">${esc(S.error)}</div><button class="pz-primary" type="submit">${t('m158')}</button>${action('apply-radio',t('m159'),'pz-secondary',item.status==='applying'?'disabled':'')}${action('revert-radio',t('m160'),'pz-text-btn',item.status==='applying'?'disabled':'')}<div class="pz-notice">${t('m161')}</div></form>`;
  }
  function fenceForm() {
    const f=S.fenceDraft,shape=f.shape;
    const sizeFields=shape==='circle'?field('radiusMeters',t('m162'),f.radiusMeters,'number','min="10" max="100000" required'):shape==='oval'?field('radiusXMeters',t('m163'),f.radiusXMeters,'number','min="10" max="100000" required')+field('radiusYMeters',t('m164'),f.radiusYMeters,'number','min="10" max="100000" required'):shape==='rectangle'?field('widthMeters',t('m165'),f.widthMeters,'number','min="10" max="100000" required')+field('heightMeters',t('m166'),f.heightMeters,'number','min="10" max="100000" required'):'';
    return `<form id="fence-form" novalidate>${field('name',t('m167'),f.name,'text','required maxlength="128"')}${selectField('shape',t('m168'),['circle','oval','rectangle','polygon'].map(s=>`<option value="${s}" ${shape===s?'selected':''}>${shapeName(s)}</option>`).join(''))}${mapSvg(true)}<div class="pz-small">${shape==='polygon'?t('m169'):t('m170')}</div>${shape==='polygon'?action('undo-vertex',t('m171',{p0:f.vertices.length}),'pz-text-btn'):''}<div class="pz-pairs">${field('latitude',t('m172'),(Number.isFinite(f.center.latitude)?f.center.latitude.toFixed(6):''),'number','min="-90" max="90" step="any" required')}${field('longitude',t('m173'),(Number.isFinite(f.center.longitude)?f.center.longitude.toFixed(6):''),'number','min="-180" max="180" step="any" required')}</div>${sizeFields}${['oval','rectangle'].includes(shape)?field('rotationDegrees',t('m174'),f.rotationDegrees,'number','min="-180" max="180" required'):''}${selectField('scope',t('m175'),`<option value="all" ${!f.deviceIds.length?'selected':''}>${t('m041')}</option><option value="selected" ${f.deviceIds.length?'selected':''}>${t('m176')}</option>`)}${S.fenceScope==='selected'?`<div class="pz-card">${nodes.map(n=>`<label class="pz-check"><input type="checkbox" name="deviceIds" value="${n.id}" ${f.deviceIds.includes(n.id)?'checked':''}>${esc(nodeName(n))} · ${esc(n.serial)}</label>`).join('')}</div>`:''}<label class="pz-check"><input name="enterAlert" type="checkbox" ${f.enterAlert?'checked':''}>${t('m177')}</label><label class="pz-check"><input name="exitAlert" type="checkbox" ${f.exitAlert?'checked':''}>${t('m178')}</label><label class="pz-check"><input name="enabled" type="checkbox" ${f.enabled?'checked':''}>${t('m179')}</label><div class="pz-error" role="alert">${esc(S.error)}</div><button class="pz-primary" type="submit">${t('m180')}</button>${S.fences.some(item=>item.id===f.id)?action('delete-fence',t('m181'),'pz-secondary',`data-id="${f.id}"`):''}</form>`;
  }
  function receiptText(m){return new Date(m.timestampMs).toLocaleTimeString(L.locale(S.lang),{hour:'2-digit',minute:'2-digit'})+(m.mine?' · '+messageLabel(m):'');}
  function retryButton(m){return m.status==='failed'?action('retry',t('m109'),'pz-text-btn',`data-id="${m.id}" ${canSend()?'':'disabled'}`):'';}
  function messageBubble(m){
    let body='';
    if(m.attachmentKind==='image')body=`<button type="button" class="pz-image-message" data-act="view-image" data-id="${m.id}" aria-label="${t('m307')}"><img src="${esc(m.objectUrl)}" alt="${t('m281')}"></button>`;
    if(m.attachmentKind==='voice')body=`<div class="pz-small">${I('mic')} ${t('m282')}${m.durationMs?' · '+t('m308',{p0:Math.round(m.durationMs/1000)}):''}</div><audio controls preload="metadata" src="${esc(m.objectUrl)}" aria-label="${t('m297')}"></audio>`;
    const text=m.attachmentKind?m.text:messageText(m);
    return `<div class="pz-bubble ${m.mine?'mine':''} ${m.status==='failed'?'failed':''}" data-message="${m.id}">${body}${text?`<div>${esc(text)}</div>`:''}<div class="pz-small" data-receipt>${esc(receiptText(m))}</div><div data-retry>${retryButton(m)}</div></div>`;
  }
  function refreshMessage(m,thread){
    if(S.route!=='chat'||S.thread!==thread||S.modal)return;
    const bubble=$('app').querySelector(`[data-message="${m.id}"]`);
    if(!bubble){render();return;}
    bubble.classList.toggle('failed',m.status==='failed');
    bubble.querySelector('[data-receipt]').textContent=receiptText(m);
    bubble.querySelector('[data-retry]').innerHTML=retryButton(m);
  }
  function accountPanel(){
    if(S.account)return `<div class="pz-card"><div class="pz-title">${esc(S.account.name)}</div><p class="pz-sub">${esc(S.account.email)}</p><div class="pz-small">${t('m198')}</div></div>${action('logout',t('m199'),'pz-secondary')}`;
    return `${tabs([['code',t('m299')],['password',t('m298')]],S.loginMode,'login-mode')}<form id="account-form" novalidate>${field('email',t('m200'),S.accountEmail||S.otpEmail,'email','required autocomplete="email"')}${S.loginMode==='password'?`${field('password',t('m300'),S.accountPassword,S.showAccountPassword?'text':'password','required autocomplete="current-password"')}<label class="pz-check"><input id="show-account-password" type="checkbox" ${S.showAccountPassword?'checked':''}>${t('m301')}</label>`:S.otpEmail?field('otp',t('m201'),S.accountCode,'text','required inputmode="numeric" maxlength="6" autocomplete="one-time-code"'):''}<div class="pz-error" role="alert">${esc(S.error)}</div><button class="pz-primary" type="submit">${S.loginMode==='password'?t('m129'):S.otpEmail?t('m202'):t('m203')}</button><p class="pz-small">${t('m204')}</p></form>`;
  }
  function mediaPanel(){
    const d=media.state;
    if(S.modal==='image-view'){
      const message=Object.values(S.messages).flat().find(m=>m.id===S.imageMessageId);
      return message?`<img class="pz-media-preview" src="${esc(message.objectUrl)}" alt="${t('m281')}">`:'';
    }
    if(S.modal==='compose-image')return `<img class="pz-media-preview" src="${esc(d.url)}" alt="${t('m281')}">${field('caption',t('m290'),S.caption,'text','maxlength="240"')}${action('send-image',t('m287'))}${action('close',t('m289'),'pz-secondary')}`;
    return `<div class="pz-voice-stage">${I('mic')}<div class="pz-value" data-record-time>${d.recording?L.number(S.lang,d.seconds)+' s':t('m284')}</div><div class="pz-small">${d.recording?t('m296'):t('m306')}</div></div>${d.url?`<audio class="pz-audio-preview" controls src="${esc(d.url)}" aria-label="${t('m297')}"></audio>${d.durationMs?`<p class="pz-small">${t('m308',{p0:Math.round(d.durationMs/1000)})}</p>`:''}${action('send-voice',t('m288'))}`:''}${d.recording?action('stop-recording',t('m286'),'pz-secondary'):action('start-recording',t('m285'),'pz-secondary',d.requesting?'disabled':'')}${!d.recording?action('choose-audio',t('m295'),'pz-text-btn'):''}`;
  }
  const discovered=[{id:'DEMO-GW-01',advertisement:'EZ_02000000A001',target:'gateway',rssi:-48},{id:'DEMO-CHAT-01',advertisement:'NRF_02000000B001',target:'radio',rssi:-63}];
  let searchEpoch=0;
  async function startSearch(){
    const token=++searchEpoch;S.pendingDevice=null;S.scanStatus='scanning';openModal('add');
    const outcome=$('demo-scan')?.value||'found';
    await new Promise(resolve=>setTimeout(resolve,700));
    if(token!==searchEpoch||S.modal!=='add')return;
    S.scanStatus=['empty','off','denied'].includes(outcome)?outcome:'found';render();
  }
  function discoveryPanel(){
    if(S.scanStatus==='scanning')return `<div class="pz-empty"><div class="pz-spinner" aria-hidden="true"></div><div class="pz-title" role="status">${t('m312')}</div><p class="pz-sub">${t('m313')}</p></div>`;
    if(S.scanStatus==='off'||S.scanStatus==='denied')return empty('info',t(S.scanStatus==='off'?'m322':'m323'),t(S.scanStatus==='off'?'m315':'m316'),action('search-again',t('m317')));
    if(S.scanStatus==='empty'||S.scanStatus==='idle')return empty('signal',t('m314'),t('m313'),action('search-again',t('m317')));
    return `<p class="pz-sub">${t('m325')}</p><div class="pz-card">${discovered.map(d=>`<button type="button" class="pz-menu" data-act="discovered-device" data-id="${d.id}"><span class="pz-avatar">${I(d.target==='gateway'?'gateway':'chat')}</span><span class="pz-grow"><span class="pz-title">${targetName(d.target)}</span><small>${esc(d.advertisement)}<br>${d.rssi} dBm</small></span>${I('next')}</button>`).join('')}</div>${action('search-again',t('m317'),'pz-secondary')}`;
  }
  function connectionPanel(){
    const d=S.pendingDevice||S.bindings[S.target],pairNeeded=Boolean(S.pendingDevice)||!hasLink(S.target);
    return `<div class="pz-card"><div class="pz-title ${pairNeeded?'pz-blue':'pz-good'}">${S.pendingDevice?t('m320'):linkLabel(S.target)}</div>${d?`<p class="pz-small">${t('m324')}: ${esc(d.advertisement)}<br>${d.rssi} dBm</p>`:''}<p class="pz-sub">${pairNeeded?t('m185'):t('m184')}</p></div>${pairNeeded?action('pair',S.busy?t('m240'):t('m186'),'pz-primary',S.busy?'disabled':''):action('settings',t('m187'),'pz-primary',`data-target="${S.target}"`)}<div class="pz-small">${t('m150')+targetName(S.target)}</div>`;
  }
  function modal() {
    if(!S.modal)return '';
    let title='',body='';
    if(S.modal==='fence'){title=t('m182');body=fenceForm();}
    if(S.modal==='radio'){title=t('m183');body=radioForm();}
    if(S.modal==='connection'){title=targetName(S.target);body=connectionPanel();}
    if(S.modal==='add'){title=t('m318');body=discoveryPanel();}
    if(S.modal==='language'){title=t('m252');body=`<p class="pz-sub">${t('m253')}</p><div role="radiogroup" aria-label="${t('m252')}">${L.languages.map(item=>`<button type="button" class="pz-menu pz-language-choice" role="radio" aria-checked="${S.lang===item.code}" data-act="set-language" data-value="${item.code}"><span class="pz-grow" lang="${item.locale}">${item.name}</span><span class="pz-blue">${S.lang===item.code?'✓':''}</span></button>`).join('')}</div>`;}
    if(S.modal==='identity'){title=t('m132');body=`<form id="identity-form" novalidate>${field('name',t('m192'),identityName(),'text','required maxlength="40"')}<div class="pz-card"><div class="pz-small">${t('m193')}</div><p class="pz-code">${S.identity.id}</p><div class="pz-small">${t('m194')}</div><p class="pz-code">${S.identity.nodeId}</p><div class="pz-small">${t('m195')}</div><p class="pz-code">${esc(S.identity.publicKey)}</p></div><div class="pz-error" role="alert">${esc(S.error)}</div><button class="pz-primary" type="submit">${t('m196')}</button></form>`;}
    if(S.modal==='account'){title=t('m197');body=accountPanel();}
    if(['voice','compose-image','image-view'].includes(S.modal)){title=t(S.modal==='voice'?'m284':'m307');body=mediaPanel();}
    if(S.modal==='thread-info'){title=t('m104');body=`<div class="pz-card"><div class="pz-title">${esc(threadName(S.thread))}</div><p class="pz-sub">${S.thread.startsWith('c')?t('m205'):t('m206')}</p></div>`;}
    if(S.modal==='rename'){title=t('m207');const n=nodes.find(n=>n.id===S.nodeId);body=`<form id="rename-form" novalidate>${field('name',t('m208'),n.name,'text','required maxlength="40"')}<div class="pz-error" role="alert">${esc(S.error)}</div><button class="pz-primary" type="submit">${t('m209')}</button></form>`;}
    if(S.modal==='storage'){title=t('m136');body=`<div class="pz-card"><div class="pz-title">${t('m210')}</div><p class="pz-sub">${t('m211')}</p></div>`;}
    if(S.modal==='about'){title=t('m142');body=`<div class="pz-card"><div class="pz-title">Offgrid Tracker · UI Board</div><p class="pz-sub">${t('m212')}</p><div class="pz-small">${t('m213')+linkLabel('gateway')}<br>${t('m214')+linkLabel('radio')}</div></div>`;}
    if(S.modal==='delete-fence'){title=t('m215');body=`<p class="pz-sub">${t('m216')}</p>${action('confirm-delete',t('m181'),'pz-primary',`data-id="${esc(S.deleteFenceId)}"`)}`;}
    return `<div class="pz-modal-layer" data-act="backdrop"><section class="pz-sheet" role="dialog" aria-modal="true" aria-label="${title}"><div class="pz-handle"></div><header class="pz-head"><h2>${title}</h2>${action('close',I('close'),'pz-icon-btn',`aria-label="${t('m217')}"`)}</header>${body}</section></div>`;
  }
  function render() {
    const root=$('app'),scroll=S.resetScroll?0:root.querySelector('.pz-page')?.scrollTop||0,sheetScroll=root.querySelector('.pz-sheet')?.scrollTop||0;S.resetScroll=false;
    root.innerHTML=({home,collar,node:nodeDetail,chat,profile,networks}[S.route]||home)()+(['home','profile'].includes(S.route)?`<nav class="pz-nav" aria-label="${t('m218')}">${[['home','home',t('m219')],['profile','user',t('m128')]].map(([route,icon,label])=>`<button data-act="nav" data-route="${route}" ${S.route===route?'aria-current="page"':''}>${I(icon)}${label}</button>`).join('')}</nav>`:'')+modal();
    const page=root.querySelector('.pz-page');if(page){page.scrollTop=scroll;page.inert=Boolean(S.modal);}
    const sheet=root.querySelector('.pz-sheet');if(sheet)sheet.scrollTop=sheetScroll;
    if($('pz-messages'))$('pz-messages').scrollTop=$('pz-messages').scrollHeight;
    [1,2,3].forEach(n=>$('sim-btn-'+n).classList.toggle('active-state',n===S.lifecycle));
    $('lang-btn-text').textContent=L.name(S.lang);
    L.applyStatic(document,S.lang);
    $('theme-text').textContent=document.body.classList.contains('dark-mode')?t('m220'):t('m221');
  }
  const utf8 = value => new TextEncoder().encode(value).length;
  function canonicalRadio(d) {return {country:d.country,halowChannel:Number(d.halowChannel),meshId:d.meshId.trim(),meshPassphrase:d.meshPassphrase};}
  function validateRadio(d) {
    if(!d||typeof d.country!=='string'||typeof d.meshId!=='string'||typeof d.meshPassphrase!=='string')return t('m222');
    if(!catalog[d.country]?.some(c=>c.number===Number(d.halowChannel)))return t('m223');
    if(!d.meshId.trim()||utf8(d.meshId.trim())>32)return t('m224');
    const length=utf8(d.meshPassphrase);
    return length!==0&&(length<8||length>63)?t('m225'):'';
  }
  for(const target of ['gateway','radio']) {
    const item=saved.radio?.[target];
    if(item&&item.desired&&item.applied&&!validateRadio(item.desired)&&!validateRadio(item.applied))S.radio[target]={desired:canonicalRadio(item.desired),applied:canonicalRadio(item.applied),revision:Number(item.revision)||1,status:JSON.stringify(canonicalRadio(item.desired))===JSON.stringify(canonicalRadio(item.applied))?'applied':'pending'};
  }
  function polygonValid(vertices) {
    if(vertices.length<3||vertices.length>64)return false;
    if(vertices.some(p=>!p||!Number.isFinite(p.latitude)||!Number.isFinite(p.longitude)||Math.abs(p.latitude)>90||Math.abs(p.longitude)>180))return false;
    if(new Set(vertices.map(p=>p.latitude+':'+p.longitude)).size!==vertices.length)return false;
    const orient=(a,b,c)=>(b.longitude-a.longitude)*(c.latitude-a.latitude)-(b.latitude-a.latitude)*(c.longitude-a.longitude);
    let area=0;for(let i=0;i<vertices.length;i++){const a=vertices[i],b=vertices[(i+1)%vertices.length];area+=a.longitude*b.latitude-b.longitude*a.latitude;}
    if(Math.abs(area)<1e-12)return false;
    for(let i=0;i<vertices.length;i++)for(let j=i+1;j<vertices.length;j++) {
      if(j===i+1||(i===0&&j===vertices.length-1))continue;
      const a=vertices[i],b=vertices[(i+1)%vertices.length],c=vertices[j],d=vertices[(j+1)%vertices.length];
      if(orient(a,b,c)*orient(a,b,d)<=0&&orient(c,d,a)*orient(c,d,b)<=0)return false;
    }
    return true;
  }
  function validateFence(f) {
    if(!f.name.trim()||f.name.length>128)return t('m226');
    if(!Number.isFinite(f.center.latitude)||!Number.isFinite(f.center.longitude)||Math.abs(f.center.latitude)>90||Math.abs(f.center.longitude)>180)return t('m227');
    if(!f.enterAlert&&!f.exitAlert)return t('m228');
    const sizes={circle:['radiusMeters'],oval:['radiusXMeters','radiusYMeters'],rectangle:['widthMeters','heightMeters'],polygon:[]}[f.shape];
    if(!sizes)return t('m229');
    if(sizes.some(key=>!Number.isFinite(f[key])||f[key]<10||f[key]>100000))return t('m230');
    if(!Number.isFinite(f.rotationDegrees)||Math.abs(f.rotationDegrees)>180)return t('m231');
    if(f.shape==='polygon'&&!polygonValid(f.vertices))return t('m232');
    if(S.fenceScope==='selected'&&!f.deviceIds.length)return t('m233');
    if(utf8(JSON.stringify(geometryOf(f)))>4000)return t('m234');
    return '';
  }
  function geometryOf(f) {return {center:f.center,rotationDegrees:f.rotationDegrees,...({circle:{radiusMeters:f.radiusMeters},oval:{radiusXMeters:f.radiusXMeters,radiusYMeters:f.radiusYMeters},rectangle:{widthMeters:f.widthMeters,heightMeters:f.heightMeters},polygon:{vertices:f.vertices}})[f.shape]};}
  function openModal(name) {if(name!=='voice'&&media.state.recording)media.discard();S.error='';S.modal=name;render();const focus=$('app').querySelector('[role="dialog"] input, [role="dialog"] button');if(focus)focus.focus();}
  function openRadio(target) {S.target=target;S.radioDraft=copy(S.radio[target].desired);S.radioDraft.bandwidth=catalog[S.radioDraft.country].find(c=>c.number===S.radioDraft.halowChannel).bandwidthMHz;S.showPass=false;openModal('radio');}
  function openFence(id) {S.fenceDraft=copy(id?S.fences.find(f=>f.id===id):{...defaultFence,id:'f-'+Date.now(),name:''});if(S.fenceDraft.nameKey){S.fenceDraft.name=S.fenceDraft.name?t(S.fenceDraft.nameKey):'';delete S.fenceDraft.nameKey;}S.fenceScope=S.fenceDraft.deviceIds.length?'selected':'all';S.map={zoom:1,x:0,y:0};openModal('fence');}
  function saveRadio(d) {
    const error=validateRadio(d);if(error){S.error=error;return false;}
    const item=S.radio[S.target];item.desired=canonicalRadio(d);item.revision++;
    item.status=JSON.stringify(item.desired)===JSON.stringify(item.applied)?'applied':'pending';persist();S.error='';return true;
  }
  async function applyRadio() {
    const target=S.target,item=S.radio[target];
    if(item.status==='applying')return;
    // Save the current form before applying; never apply an older hidden draft.
    if(!saveRadio(S.radioDraft)){render();return;}
    if(!hasLink(target)){item.status='pending';persist();toast(t('m235'));render();return;}
    const revision=item.revision,requested=copy(item.desired),outcome=$('demo-apply').value;
    item.status='applying';render();
    await new Promise(resolve=>setTimeout(resolve,700));
    if(item.revision!==revision)return;
    if(hasLink(target)&&outcome==='success') {item.applied=requested;item.status='applied';toast(t('m236'));}
    else {item.status='failed';toast(t('m237'));}
    persist();render();
  }
  function saveFence(f) {
    if(f.shape==='polygon'&&f.vertices.length)f.center={latitude:f.vertices.reduce((a,p)=>a+p.latitude,0)/f.vertices.length,longitude:f.vertices.reduce((a,p)=>a+p.longitude,0)/f.vertices.length};
    const error=validateFence(f);if(error){S.error=error;return false;}
    f.name=f.name.trim();delete f.nameKey;const index=S.fences.findIndex(item=>item.id===f.id);
    if(index===-1)S.fences.push(copy(f));else S.fences[index]=copy(f);
    S.acknowledged=S.acknowledged.filter(id=>!id.startsWith(f.id+':'));persist();S.modal=null;S.error='';return true;
  }
  let messageSequence=0;
  async function transmit(m,thread,forcedOutcome) {
    const direct=!thread.startsWith('c'),outcome=forcedOutcome||$('demo-send').value;
    const refresh=()=>refreshMessage(m,thread);
    m.status='sending';m.retryCount=0;delete m.deliveredAt;delete m.readAt;refresh();
    await new Promise(resolve=>setTimeout(resolve,350));
    if(!hasLink('radio')||S.lifecycle!==3){m.status='failed';refresh();return;}
    m.status='sent';refresh();
    if(!direct)return;
    if(outcome==='delivered'||outcome==='read'){
      await new Promise(resolve=>setTimeout(resolve,250));
      if(!hasLink('radio')||S.lifecycle!==3){m.status='failed';refresh();return;}
      m.status='delivered';m.deliveredAt=Date.now();refresh();
      if(outcome==='read'){
        await new Promise(resolve=>setTimeout(resolve,500));
        if(hasLink('radio')&&S.lifecycle===3){m.status='read';m.readAt=Date.now();refresh();}
      }return;
    }
    for(let i=1;i<=3;i++) {
      if(!hasLink('radio')||S.lifecycle!==3){m.status='failed';refresh();return;}
      m.status='retrying';m.retryCount=i;refresh();await new Promise(resolve=>setTimeout(resolve,600));
    }
    m.status='failed';refresh();
  }
  function send(text,attachment=null) {
    text=String(text||'').trim();if((!text&&!attachment)||!canSend())return false;
    if(utf8(text)>240){toast(t('m238'));return false;}
    const thread=S.thread,m={id:'message-'+Date.now()+'-'+(++messageSequence),mine:true,text,timestampMs:Date.now(),status:'sending',retryCount:0,...(attachment||{})};
    seedConversation(thread);S.composerDrafts[thread]='';S.messages[thread].push(m);void transmit(m,thread);return true;
  }
  function sendMedia(kind){
    if(!canSend()||!media.state.url||media.state.kind!==kind)return;
    if(utf8(S.caption)>240){toast(t('m238'));return;}
    const attachment=media.take(),caption=kind==='image'?S.caption:'';S.caption='';S.modal=null;
    send(caption,attachment);render();
  }
  const handlers={
    nav:el=>{if(el.dataset.route==='chat-list'){S.thread=null;navigate('chat');}else navigate(el.dataset.route);},
    product:el=>['valve','camera'].includes(el.dataset.value)?toast(t('m239')):navigate(el.dataset.value),
    add:()=>void startSearch(),'search-again':()=>void startSearch(),
    close:()=>{S.modal=null;S.error='';media.discard();render();},
    backdrop:(el,event)=>{if(event.target===el){S.modal=null;media.discard();render();}},
    connect:el=>{S.pendingDevice=null;S.target=el.dataset.target||'gateway';openModal('connection');},
    'discovered-device':el=>{const d=discovered.find(d=>d.id===el.dataset.id);if(!d)return;S.pendingDevice=d;S.target=d.target;openModal('connection');},
    pair:async()=>{if(S.busy)return;S.busy=true;const target=S.target,device=S.pendingDevice;toast(t('m240'));render();await new Promise(resolve=>setTimeout(resolve,600));S.links[target]=true;if(device)S.bindings[target]=device;if(S.lifecycle===1)S.lifecycle=2;S.busy=false;if(S.modal==='connection'&&S.target===target){S.modal=null;S.pendingDevice=null;render();}else if(!S.modal)render();toast(t('m241'));},
    'choose-image':()=>{if(canSend())$('image-picker').click();},
    voice:()=>{if(!canSend())return;media.discard();S.caption='';openModal('voice');},
    'start-recording':()=>void media.start(),'stop-recording':()=>media.stop(),
    'choose-audio':()=>$('audio-picker').click(),
    'send-image':()=>sendMedia('image'),'send-voice':()=>sendMedia('voice'),
    'view-image':el=>{S.imageMessageId=el.dataset.id;openModal('image-view');},
    'login-mode':el=>{S.loginMode=el.dataset.value;S.error='';S.accountPassword='';S.showAccountPassword=false;render();},
    settings:el=>openRadio(el.dataset.target||S.target),networks:()=>navigate('networks'),
    'collar-tab':el=>{S.collarTab=el.dataset.value;render();},'chat-tab':el=>{S.chatTab=el.dataset.value;render();},
    node:el=>{S.nodeId=el.dataset.id;navigate('node');},'map-node':el=>{if(S.modal==='fence')return;S.selectedMapNode=el.dataset.id;render();},
    'locate-node':el=>{S.selectedMapNode=el.dataset.id;S.collarTab='map';navigate('collar');},
    'rename-node':()=>openModal('rename'),
    zoom:el=>{if(el.dataset.value==='reset')S.map={zoom:1,x:0,y:0};else S.map.zoom=Math.max(.5,Math.min(4,S.map.zoom*(el.dataset.value==='in'?1.3:1/1.3)));render();},
    'new-fence':()=>openFence(),'edit-fence':el=>openFence(el.dataset.id),'undo-vertex':()=>{S.fenceDraft.vertices.pop();render();},
    'delete-fence':el=>{S.deleteFenceId=el.dataset.id;openModal('delete-fence');},
    'confirm-delete':el=>{S.fences=S.fences.filter(f=>f.id!==el.dataset.id);S.acknowledged=S.acknowledged.filter(id=>!id.startsWith(el.dataset.id+':'));persist();S.modal=null;render();},
    ack:el=>{S.acknowledged.push(el.dataset.id);render();},
    thread:el=>{S.thread=el.dataset.id;seedConversation(S.thread);render();},'thread-info':()=>openModal('thread-info'),
    phrase:el=>send(el.dataset.text),retry:el=>{const m=(S.messages[S.thread]||[]).find(m=>m.id===el.dataset.id);if(m&&m.status==='failed'&&canSend())void transmit(m,S.thread);},
    identity:()=>openModal('identity'),account:()=>openModal('account'),logout:()=>{S.account=null;S.otpEmail='';S.accountPassword='';S.accountCode='';S.modal=null;render();toast(t('m242'));},
    language:()=>window.toggleLanguage(),'set-language':el=>{if(!L.has(el.dataset.value))return;S.lang=el.dataset.value;S.modal=null;S.error='';persist();render();},appearance:()=>window.toggleTheme(),storage:()=>openModal('storage'),about:()=>openModal('about'),
    'apply-radio':()=>void applyRadio(),
    'revert-radio':()=>{if(S.radio[S.target].status==='applying')return;S.radioDraft=copy(S.radio[S.target].applied);saveRadio(S.radioDraft);S.radioDraft.bandwidth=catalog[S.radioDraft.country].find(c=>c.number===S.radioDraft.halowChannel).bandwidthMHz;render();},
  };
  $('app').addEventListener('click',event=>{const el=event.target.closest('[data-act]');if(el){if(el.dataset.act==='backdrop'&&event.target!==el)return;event.preventDefault();handlers[el.dataset.act]?.(el,event);}});
  function collectFence(form) {
    const data=new FormData(form),f=copy(S.fenceDraft);
    const numeric=key=>data.get(key)!==null&&String(data.get(key)).trim()!==''?Number(data.get(key)):NaN;
    f.name=String(data.get('name')||'');f.shape=data.get('shape');f.center={latitude:numeric('latitude'),longitude:numeric('longitude')};
    for(const key of ['radiusMeters','radiusXMeters','radiusYMeters','widthMeters','heightMeters','rotationDegrees'])if(data.has(key))f[key]=numeric(key);
    f.enterAlert=data.has('enterAlert');f.exitAlert=data.has('exitAlert');f.enabled=data.has('enabled');f.deviceIds=S.fenceScope==='selected'?data.getAll('deviceIds'):[];return f;
  }
  $('app').addEventListener('submit',event=>{
    event.preventDefault();const form=event.target,data=new FormData(form);S.error='';
    if(form.id==='chat-form'){if(!String(data.get('message')||'').trim())toast(t('m114'));else send(data.get('message'));return;}
    if(form.id==='radio-form'){if(saveRadio(S.radioDraft))toast(t('m243'));render();return;}
    if(form.id==='fence-form'){if(saveFence(collectFence(form)))toast(t('m244'));render();return;}
    if(form.id==='identity-form'||form.id==='rename-form') {
      const name=String(data.get('name')||'').trim();if(!name){S.error=t('m245');render();return;}
      if(form.id==='identity-form')S.identity.name=name;else nodes.find(n=>n.id===S.nodeId).name=name;
      persist();
      S.modal=null;render();return;
    }
    if(form.id==='account-form') {
      const email=String(data.get('email')||'').trim();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){S.error=t('m246');render();return;}
      S.accountEmail=email;
      if(S.loginMode==='password'){
        const password=String(data.get('password')||'');
        if(!password){S.error=t('m310');render();return;}
        if(password!=='Demo@123456'){S.error=t('m302');S.accountPassword='';render();return;}
      }else{
        if(email!==S.otpEmail){S.otpEmail=email;toast(t('m247'));render();return;}
        if(data.get('otp')!=='123456'){S.error=t('m248');render();return;}
      }
      S.account={email,name:email.split('@')[0],method:S.loginMode};S.accountPassword='';S.accountCode='';S.modal=null;render();toast(t('m249'));
    }
  });
  $('app').addEventListener('input',event=>{
    const el=event.target;
    if(el.name==='caption')S.caption=el.value;
    if(el.closest('#account-form')){if(el.name==='email')S.accountEmail=el.value;if(el.name==='password')S.accountPassword=el.value;if(el.name==='otp')S.accountCode=el.value;}
    if(el.id==='message-input')S.composerDrafts[S.thread]=el.value;
    if(el.id==='node-search'){S.search=el.value;const list=liveNodes(),filtered=list.filter(n=>(n.name+' '+n.serial).toLowerCase().includes(S.search.toLowerCase())&&(S.filter==='all'||S.filter==='low'&&n.batteryVoltage!==null&&n.batteryVoltage<3.4||S.filter==='stale'&&!recent(n)||S.filter==='no-fix'&&n.latitude===null));$('node-results').innerHTML=nodeResults(filtered,list);}
    if(el.closest('#radio-form')&&['meshId','meshPassphrase'].includes(el.name))S.radioDraft[el.name]=el.value;
    if(el.closest('#fence-form')&&el.name==='name')S.fenceDraft.name=el.value;
  });
  $('app').addEventListener('change',event=>{
    const el=event.target;
    if(el.id==='image-picker'||el.id==='audio-picker'){const kind=el.id==='image-picker'?'image':'voice';void media.choose(el.files?.[0],kind).then(ok=>{if(ok){S.caption='';openModal(kind==='image'?'compose-image':'voice');}});return;}
    if(el.id==='show-account-password'){S.showAccountPassword=el.checked;const input=$('account-form').querySelector('[name="password"]');if(input)input.type=el.checked?'text':'password';}
    if(el.id==='node-filter'){S.filter=el.value;render();}
    if(el.id==='show-pass'){S.showPass=el.checked;const input=$('radio-form').querySelector('[name="meshPassphrase"]');input.type=el.checked?'text':'password';}
    if(el.closest('#radio-form')&&['country','bandwidth','halowChannel'].includes(el.name)) {
      const d=S.radioDraft;if(el.name==='country'){d.country=el.value;const c=catalog[d.country][0];d.halowChannel=c.number;d.bandwidth=c.bandwidthMHz;}
      else if(el.name==='bandwidth'){d.bandwidth=Number(el.value);d.halowChannel=catalog[d.country].find(c=>c.bandwidthMHz===d.bandwidth).number;}
      else d.halowChannel=Number(el.value);S.error='';render();
    }
    if(el.closest('#fence-form')) {
      const form=el.closest('form');S.fenceDraft=collectFence(form);
      if(el.name==='scope'){S.fenceScope=el.value;if(el.value==='all')S.fenceDraft.deviceIds=[];}
      S.error='';render();
    }
  });
  let drag=null;
  $('app').addEventListener('pointerdown',event=>{
    const svg=event.target.closest('svg[data-map]');if(!svg||event.target.closest('[data-act="map-node"]'))return;
    const rect=svg.getBoundingClientRect();drag={id:event.pointerId,x:event.clientX,y:event.clientY,originX:S.map.x,originY:S.map.y,rect,svg};svg.setPointerCapture?.(event.pointerId);
  });
  $('app').addEventListener('pointermove',event=>{
    if(!drag)return;S.map.x=drag.originX+(event.clientX-drag.x)*360/drag.rect.width;S.map.y=drag.originY+(event.clientY-drag.y)*300/drag.rect.height;
    drag.svg.querySelector('[data-map-content]')?.setAttribute('transform',`translate(${S.map.x} ${S.map.y}) translate(180 150) scale(${S.map.zoom}) translate(-180 -150)`);
  });
  $('app').addEventListener('pointerup',event=>{
    if(!drag)return;const d=drag;drag=null;
    if(Math.hypot(event.clientX-d.x,event.clientY-d.y)<5&&S.modal==='fence') {
      const x=((event.clientX-d.rect.left)*360/d.rect.width-S.map.x-180)/S.map.zoom+180,y=((event.clientY-d.rect.top)*300/d.rect.height-S.map.y-150)/S.map.zoom+150,p=pointGeo(x,y);
      if(S.fenceDraft.shape==='polygon'){if(S.fenceDraft.vertices.length<64)S.fenceDraft.vertices.push(p);else toast(t('m250'));}else S.fenceDraft.center=p;
    }render();
  });
  $('app').addEventListener('pointercancel',()=>{drag=null;});
  $('app').addEventListener('keydown',event=>{
    if(event.key==='Escape'&&S.modal){S.modal=null;media.discard();render();}
    const marker=event.target.closest('.pz-marker');if(marker&&['Enter',' '].includes(event.key)){event.preventDefault();handlers['map-node'](marker);}
    if(event.key==='Tab'&&S.modal){const list=[...$('app').querySelectorAll('[role="dialog"] button:not(:disabled),[role="dialog"] input,[role="dialog"] select')];if(event.shiftKey&&document.activeElement===list[0]){event.preventDefault();list.at(-1)?.focus();}else if(!event.shiftKey&&document.activeElement===list.at(-1)){event.preventDefault();list[0]?.focus();}}
  });
  window.setSimState = state => {media.discard();S.lifecycle=state;S.links={gateway:state!==1,radio:state!==1};if(state!==3&&S.route==='node')S.route='collar';S.modal=null;render();toast(t('m251'));};
  window.toggleLanguage = () => openModal('language');
  window.toggleTheme = () => {document.body.classList.toggle('dark-mode');render();};
  window.openSetupWizard = () => void startSearch();
  // The presentation exposes a small inspectable model for reproducible handoff verification.
  window.EdgezBoard={media,startSearch,discovered,state:S,nodes,catalog,render,navigate,send,saveRadio,applyRadio,saveFence,validateRadio,validateFence,contains,geometryOf,openRadio,openFence,handlers,alarms};
  for(const f of S.fences)if(f.id==='f1'&&f.name==='牧区 A')f.nameKey='m259';
  const hash=window.location.hash;
  if(hash==='#profile')S.route='profile';else if(hash==='#chat')S.route='chat';else if(hash==='#collar')S.route='collar';
  render();
})();
