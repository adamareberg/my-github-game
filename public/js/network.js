// ═══════════════════════════════════════════════════════════════
// NETWORK.JS — Online multiplayer networking
// Ultra-smooth: binary protocol, hermite interpolation, jitter buffer
// ═══════════════════════════════════════════════════════════════

var playMode = 'offline'; // var — window property, accessible from inline onclick handlers
let ws = null;
let netPing = 0;
let netSeq = 0;
let myPlayerId = 0;
let matchPlayersInfo = [];
let serverWalls = null;
let serverShopZone = null;
let serverMapW = 0, serverMapH = 0;
let serverPhysicsRate = 60;
let serverSendRate = 20;
let serverMaxPlayers = 2;

const SNAPSHOT_BUFFER_SIZE = 16;
let INTERP_DELAY_MS = 20; // ~1.2 frames at 60Hz — safe default, adaptive below
let snapshotBuffer = [];
let serverTimeOffset = 0;
let serverTimeOffsetSamples = [];

let networkQuality = 'good';
let packetLoss = 0;
let lastServerSeq = 0;
let lastHUDUpdate = 0;
const HUD_UPDATE_INTERVAL = 50;

let velocityHistory = new Map();

// Pre-built Maps for O(1) player lookup in interpolateRemoteEntities — rebuilt each interp call
const _interpFromMap  = new Map(); // snapshot[i].data.players   id → player
const _interpLocalMap = new Map(); // gameState.players           id → player

// Pre-allocated velocity history entries — avoids {vx,vy} object allocation per player per frame
// Each entry: Float32Array [vx0,vy0, vx1,vy1, vx2,vy2, vx3,vy3, vx4,vy4, vx5,vy5] + {wr, len}
const VH_CAP = 6;
const _vhPool = new Map(); // id → { buf: Float32Array(12), wr: 0, len: 0 }
let smoothCamX = 0, smoothCamY = 0;
let camVelX = 0, camVelY = 0; // Camera velocity for critically damped spring
let cameraInitialized = false;

const SERVER_URL = 'ws://localhost:9090';

// ═══════════════════════════════════════════════════════════════
// ADAPTIVE SETTINGS
// ═══════════════════════════════════════════════════════════════
function getAdaptiveInterpDelay() {
  // Must be >= 1 packet interval to always have two snapshots to interpolate between.
  // At 60Hz packets arrive every 16.7ms, so even LAN needs >= 17ms.
  // Add jitter buffer scaled by ping on top.
  const pkt = 1000 / (serverSendRate || 60); // 16.7ms at 60Hz
  if (netPing < 5)   return pkt + 5;   // ~22ms — near-zero latency LAN
  if (netPing < 15)  return pkt + 10;  // ~27ms
  if (netPing < 30)  return pkt + 20;  // ~37ms
  if (netPing < 60)  return pkt + 35;  // ~52ms
  if (netPing < 100) return pkt + 55;  // ~72ms
  if (netPing < 150) return pkt + 80;  // ~97ms
  return pkt + 110;                    // ~127ms — high-latency fallback
}

let _interpTarget = 20; // ease toward this — avoids visible snap when quality changes

function adjustNetworkSettings() {
  if (packetLoss > 0.1) { networkQuality = 'poor'; _interpTarget = 130; }
  else if (packetLoss > 0.03) { networkQuality = 'medium'; _interpTarget = 80; }
  else { networkQuality = 'good'; _interpTarget = getAdaptiveInterpDelay(); }
  // Ease at max 6ms per call (~500ms pong interval) — no visible snap
  const diff = _interpTarget - INTERP_DELAY_MS;
  INTERP_DELAY_MS += Math.sign(diff) * Math.min(6, Math.abs(diff));
}

let inputBuffer = [];
const INPUT_BUFFER_SIZE = 30;
let lastAckedSeq = 0;
let lastInputSend = 0;
const INPUT_SEND_INTERVAL = 8; // 125Hz input — server ticks at 60Hz but fast actions need sub-tick delivery

const MOB_ICONS = { wolves:'🐺', golems:'🗿', wraiths:'👻', dragon:'🐉', sentinel:'⚡', wolf:'🐺', golem:'🗿', wraith:'👻', berserker:'🔥', lich:'💀' };
const REMOTE_MOB_SMOOTHING = 14;

function createRemoteMobState(mob, campType) {
  const type = mob.type || campType;
  return {
    ...mob,
    type,
    alive: true,
    icon: MOB_ICONS[type] || '●',
    name: type.toUpperCase(),
    vx: mob.vx || 0,
    vy: mob.vy || 0,
    homeX: mob.homeX ?? mob.x,
    homeY: mob.homeY ?? mob.y,
    targetX: mob.x,
    targetY: mob.y,
    leashRange: 250,
    lastAtk: 0,
    aggroTarget: null
  };
}

function mergeCampSync(camps) {
  const prevCamps = Array.isArray(gameState?.camps) ? gameState.camps : [];
  gameState.camps = (camps || []).map((camp, campIndex) => {
    const prevCamp = prevCamps[campIndex];
    const prevById = new Map((prevCamp?.mobs || []).map(m => [m.id, m]));
    const mobs = (camp.mobs || []).map(mob => {
      const prevMob = prevById.get(mob.id);
      if (!prevMob) return createRemoteMobState(mob, camp.type);
      prevMob.targetX = mob.x;
      prevMob.targetY = mob.y;
      prevMob.vx = mob.vx || 0;
      prevMob.vy = mob.vy || 0;
      prevMob.hp = mob.hp;
      prevMob.maxHp = mob.maxHp;
      prevMob.color = mob.color || prevMob.color;
      prevMob.radius = mob.radius || prevMob.radius;
      prevMob.type = mob.type || camp.type || prevMob.type;
      prevMob.icon = MOB_ICONS[prevMob.type] || prevMob.icon || '●';
      prevMob.name = prevMob.type.toUpperCase();
      prevMob.homeX = mob.homeX ?? prevMob.homeX ?? mob.x;
      prevMob.homeY = mob.homeY ?? prevMob.homeY ?? mob.y;
      prevMob.alive = true;
      return prevMob;
    });
    return {
      ...(prevCamp || {}),
      ...camp,
      dead: !!camp.dead,
      deathTime: camp.dead ? (prevCamp?.dead ? (prevCamp.deathTime || performance.now()) : performance.now()) : 0,
      respawnTime: camp.respawnTime || prevCamp?.respawnTime || 20000,
      mobs
    };
  });
}

function updateRemoteCamps(dt) {
  if (!gameState?.camps?.length) return;
  const blend = Math.min(1, dt * REMOTE_MOB_SMOOTHING);
  const lookAhead = Math.min(0.05, INTERP_DELAY_MS / 1000);
  for (const camp of gameState.camps) {
    for (const mob of camp.mobs || []) {
      if (!mob.alive) continue;
      const targetX = (mob.targetX ?? mob.x) + (mob.vx || 0) * lookAhead;
      const targetY = (mob.targetY ?? mob.y) + (mob.vy || 0) * lookAhead;
      mob.x += (targetX - mob.x) * blend;
      mob.y += (targetY - mob.y) * blend;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// CONNECTION
// ═══════════════════════════════════════════════════════════════
function connectToServer(){
  if(!SERVER_URL){
    document.getElementById('serverStatus').textContent='⚠ No server URL configured';
    document.getElementById('serverStatus').style.color='var(--red)';
    document.getElementById('onlineBtn').style.opacity='.4';
    document.getElementById('onlineBtn').style.pointerEvents='none';
    return;
  }
  const url = SERVER_URL.replace(/^http/,'ws');
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer'; // Enable binary reception
  ws.onopen=()=>{
    document.getElementById('serverStatus').textContent='● SERVER CONNECTED';
    document.getElementById('serverStatus').style.color='var(--green)';
    document.getElementById('onlineBtn').style.opacity='1';
    document.getElementById('onlineBtn').style.pointerEvents='all';
    setInterval(()=>{if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:'ping',t:Date.now()}));},500);
  };
  ws.onclose=()=>{
    document.getElementById('serverStatus').textContent='● DISCONNECTED';
    document.getElementById('serverStatus').style.color='var(--red)';
    ws=null;
    if(playMode==='online'&&gameRunning){ gameRunning=false; showMenu(); }
  };
  ws.onerror=()=>{};
  ws.onmessage=(e)=>{
    // Binary state packet
    if (e.data instanceof ArrayBuffer) {
      if (typeof debugStats !== 'undefined') {
        debugStats.bytesInAccum += e.data.byteLength;
        debugStats.lastStateSize = e.data.byteLength;
        debugStats.stateFormat = 'binary';
      }
      const msg = decodeBinaryState(e.data);
      if (msg && msg.type === 'state') {
        const _tn = performance.now();
        handleStateSnapshot(msg);
        _perfNet += performance.now() - _tn;
      }
      return;
    }
    // JSON event messages
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (typeof debugStats !== 'undefined') {
      debugStats.bytesInAccum += e.data.length;
    }
    handleServerMsg(msg);
  };
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE HANDLING
// ═══════════════════════════════════════════════════════════════
function handleServerMsg(msg){
  switch(msg.type){
    case 'pong':
      netPing=Date.now()-msg.t;
      const pd=document.getElementById('pingDisplay');
      pd.style.display='flex';
      const pingColor = netPing<60?'var(--green)':netPing<120?'var(--amber)':'var(--red)';
      const pingClass = netPing<60?'ping-good':netPing<120?'ping-ok':'ping-bad';
      pd.className=''+pingClass;
      document.getElementById('netPing').textContent=netPing+'ms';
      document.getElementById('netPing').style.color=pingColor;
      document.getElementById('netDot').style.background=pingColor;
      const lossVal = typeof packetLoss==='number'?(packetLoss*100).toFixed(1):'0.0';
      const lossEl = document.getElementById('netLoss');
      lossEl.textContent=lossVal+'%';
      lossEl.style.color=packetLoss<0.02?'var(--green)':packetLoss<0.08?'var(--amber)':'var(--red)';
      document.getElementById('netInterp').textContent=Math.round(INTERP_DELAY_MS)+'ms';
      document.getElementById('netInterp').style.color='#88aaff';
      const extrapWrap = document.getElementById('netExtrapWrap');
      if(extrapWrap) extrapWrap.style.display = (typeof debugStats!=='undefined'&&debugStats.extrapolating)?'flex':'none';
      break;
    case 'queued':
      document.getElementById('mmInfo').textContent='In queue… position #'+msg.position;
      break;
    case 'queueCountdown':
      document.getElementById('mmInfo').textContent='In queue… '+msg.players+'/'+msg.max+' players, starting soon…';
      break;
    case 'matchStart':
      myPlayerId=msg.playerId;
      matchPlayersInfo=msg.players||[];
      serverWalls=msg.walls||null;
      serverShopZone=msg.shopZone||null;
      serverMapW=msg.mapW||W;
      serverMapH=msg.mapH||H;
      serverPhysicsRate=msg.physicsRate||60;
      serverSendRate=msg.sendRate||20;
      serverMaxPlayers=msg.maxPlayers||matchPlayersInfo.length;
      // Load map sprites and tile layers sent by server
      if (msg.spriteSheets && msg.spriteSheets.length && typeof loadMapSprites === 'function') {
        loadMapSprites(msg.spriteSheets);
      }
      // Also load any locally-cached global sheets not included by server
      if (typeof _cachedGlobalSheets !== 'undefined' && _cachedGlobalSheets.length && typeof loadMapSprites === 'function') {
        loadMapSprites(_cachedGlobalSheets);
      }
      if (msg.spriteAssignments && Object.keys(msg.spriteAssignments).length) {
        mapSpriteAssignments = msg.spriteAssignments;
      } else if (typeof _cachedGlobalSheets !== 'undefined') {
        // Server sent no assignments — use the locally-fetched ones
        fetch('/api/sprite-assignments').then(r=>r.json()).then(d=>{ if(d && Object.keys(d).length) mapSpriteAssignments=d; }).catch(()=>{});
      }
      if (msg.tileLayers) {
        gameTileLayers = msg.tileLayers;
        if (typeof invalidateTileCaches === 'function') invalidateTileCaches();
        if (typeof invalidateStaticGfx === 'function') invalidateStaticGfx();
      }
      if (msg.objectLayers && typeof gameObjectLayers !== 'undefined') {
        gameObjectLayers = msg.objectLayers;
        if (typeof invalidateTileCaches === 'function') invalidateTileCaches();
      }
      // Store team mode info
      if (typeof window !== 'undefined') {
        window._serverTeamMode = !!msg.teamMode;
        window._serverTowers = msg.towers || [];
        window._serverTowerShops = msg.towerShops || [];
      }
      {
        const myInfo = matchPlayersInfo.find(p => p.id === myPlayerId);
        const myTeam = myInfo ? myInfo.team : 0;
        const teamLabel = myTeam === 1 ? '🔵 BLUE' : myTeam === 2 ? '🔴 RED' : '';
        const others=matchPlayersInfo.filter(p=>p.id!==myPlayerId).map(p=>p.name).join(', ');
        document.getElementById('mmInfo').textContent='Match found! ' + (teamLabel ? teamLabel + ' TEAM — ' : '') + 'vs '+others;
      }
      if(typeof sfxQueueFound==='function') sfxQueueFound();
      if(typeof startAmbient==='function') startAmbient();
      if(typeof startMusic==='function') startMusic();
      setTimeout(()=>startOnlineGame(),500);
      { const fb = document.getElementById('forfeitBtn'); if(fb) fb.style.display='block'; }
      break;
    case 'state':
      // Fallback JSON state (shouldn't happen with binary, but just in case)
      handleStateSnapshot(msg);
      break;
    case 'campsSync':
      // Camp/consumable sync
      if (gameState) {
        if (msg.camps) {
          mergeCampSync(msg.camps);
          if (typeof debugStats !== 'undefined') debugStats.campsSynced = true;
        }
        if (msg.consumables) {
          for (const cd of msg.consumables) {
            const p = gameState.players.find(pp => pp.id === cd.id);
            if (p) p.consumables = cd.c;
          }
        }
        if (msg.minions) {
          for (const md of msg.minions) {
            const p = gameState.players.find(pp => pp.id === md.id);
            if (p) p.minions = md.m.map(m => ({...m, alive:true, radius:8, maxHp:m.maxHp||40}));
          }
        }
        // Sync towers
        if (msg.towers && Array.isArray(msg.towers)) {
          gameState.towers = msg.towers;
        }
      }
      break;
    case 'hit':
      if(gameState){
        sparks(gameState, msg.x||0, msg.y||0, '#fff', 10, 80);
        shakeIntensity=Math.max(shakeIntensity, msg.targetId===myPlayerId?6:3);
        const hitDmg = msg.dmg || 0;
        if(hitDmg) addDmgNumber(msg.x||0, msg.y||0, hitDmg, msg.targetId===myPlayerId?'#ff3355':'#ffffff', false);
        if(msg.targetId===myPlayerId) triggerScreenFlash('#ff3355',0.08);
        if(typeof sfxHit==='function') sfxHit(msg.targetId===myPlayerId);
      }
      break;
    case 'crit':
      if(gameState){
        sparks(gameState, msg.x||0, msg.y||0, '#ffff00', 15, 120);
        addDmgNumber(msg.x||0, (msg.y||0)-10, 'CRIT!', '#ffff00', true);
      }
      break;
    case 'streakAnnounce':
      showStreakPopup(msg.name, msg.streak);
      if(typeof sfxStreakAnnounce==='function') sfxStreakAnnounce(msg.streak);
      if(gameState){
        const sp=gameState.players.find(p=>p.id===msg.playerId);
        if(sp){
          sparks(gameState, sp.x, sp.y, msg.streak>=7?'#ffaa00':'#ff3355', 40, 280);
          shakeIntensity=Math.max(shakeIntensity, 8 + msg.streak);
        }
      }
      break;
    case 'mobHit':
      if(gameState){
        const isMine = msg.attackerId === myPlayerId;
        const dmgColor = isMine ? '#ffcc00' : '#ffffff';
        sparks(gameState, msg.x, msg.y, dmgColor, 8, 70);
        addDmgNumber(msg.x, msg.y - 10, msg.dmg, dmgColor, msg.killed);
      }
      break;
    case 'mobAttack':
      if(gameState){
        if(msg.mobType==='golem') sparks(gameState, msg.x, msg.y, '#886644', 25, 150);
        else if(msg.mobType==='dragon') sparks(gameState, msg.x, msg.y, '#ff6600', 15, 100);
        else if(msg.mobType==='sentinel') sparks(gameState, msg.x, msg.y, '#4488ff', 12, 90);
      }
      break;
    case 'minionAtk':
      if(gameState){
        addMinionSlash(msg.tx, msg.ty, msg.x, msg.y);
        sparks(gameState, msg.tx, msg.ty, '#88cc44', 8, 60);
        addDmgNumber(msg.tx, msg.ty-10, msg.dmg||12, '#88cc44', false);
      }
      break;
    case 'kill': {
      if(!gameState) break;
      gameState.score=msg.score;
      const vp=gameState.players.find(p=>p.id===msg.victimId);
      if(vp){
        // Mark dead immediately — don't wait for next state snapshot
        vp.alive=false; vp.hp=0;
        sparks(gameState,vp.x,vp.y,vp.color,50,250);
        addImpactRing(vp.x,vp.y,vp.color);
        shakeIntensity=Math.max(shakeIntensity, msg.victimId===myPlayerId?12:8);
        if(msg.victimId===myPlayerId) { triggerScreenFlash('#ff0000',0.15); if(typeof sfxDeath==='function') sfxDeath(); }
        if(msg.killerId===myPlayerId) { triggerScreenFlash('#00ff88',0.06); if(typeof sfxKill==='function') sfxKill(); }
      }
      const kp=gameState.players.find(p=>p.id===msg.killerId);
      const vpn=gameState.players.find(p=>p.id===msg.victimId);
      const kName = msg.killerId===myPlayerId ? 'YOU' : (kp?.name || CDEFS[kp?.cls]?.name || '???');
      const vName = msg.victimId===myPlayerId ? 'YOU' : (vpn?.name || CDEFS[vpn?.cls]?.name || '???');
      addKillfeed(kName, vName, msg.killerCls||'gunner');
      if(msg.killerId===myPlayerId) addCombo();
      break;
    }
    case 'dash':
      if(gameState){
        addDashTrail(gameState, msg.fromX, msg.fromY, msg.toX, msg.toY,
          gameState.players.find(p=>p.id===msg.playerId)?.color||'#fff');
        if(msg.teleport) sparks(gameState, msg.toX, msg.toY, '#cc44ff', 20, 120);
        if(typeof sfxDash==='function') sfxDash();
      }
      break;
    case 'secondaryUsed':
      if(gameState){
        const sv=gameState.players.find(p=>p.id===msg.playerId);
        if(sv){
          const sc2=msg.cls;
          if(sc2==='gunner'){ sparks(gameState,sv.x,sv.y,'#ff8800',20,160); addImpactRing(sv.x,sv.y,'#ff8800',75); shakeIntensity=Math.max(shakeIntensity,7); }
          else if(sc2==='assassin'){ sparks(gameState,sv.x,sv.y,sv.color,18,150); shakeIntensity=Math.max(shakeIntensity,5); }
          else if(sc2==='mage'){ sparks(gameState,sv.x,sv.y,'#bb88ff',22,180); addImpactRing(sv.x,sv.y,'#bb88ff',55); shakeIntensity=Math.max(shakeIntensity,5); }
          else if(sc2==='tank'){ sparks(gameState,sv.x,sv.y,'#00ff88',35,220); addImpactRing(sv.x,sv.y,'#00ff88',140); shakeIntensity=Math.max(shakeIntensity,9); }
          else if(sc2==='necro'){ sparks(gameState,sv.x,sv.y,'#88cc44',18,150); shakeIntensity=Math.max(shakeIntensity,5); }
          else if(sc2==='ranger'){ sparks(gameState,sv.x,sv.y,'#ff8833',16,130); shakeIntensity=Math.max(shakeIntensity,4); }
        }
      }
      break;
    case 'specialUsed':
      if(gameState){
        const sp2=gameState.players.find(p=>p.id===msg.playerId);
        if(sp2){
          const sc=msg.cls;
          if(sc==='gunner'){
            sparks(gameState,sp2.x,sp2.y,sp2.color,16,130);
            shakeIntensity=Math.max(shakeIntensity,4);
          } else if(sc==='assassin'){
            sparks(gameState,sp2.x,sp2.y,sp2.color,16,130);
            shakeIntensity=Math.max(shakeIntensity,5);
          } else if(sc==='necro'){
            sparks(gameState,sp2.x,sp2.y,'#88cc44',25,180);
            sparks(gameState,sp2.x,sp2.y,'#ccffcc',10,120);
            addImpactRing(sp2.x,sp2.y,'#88cc44',120);
            shakeIntensity=Math.max(shakeIntensity,7);
          } else if(sc==='ranger'){
            sparks(gameState,sp2.x,sp2.y,'#ff8833',20,150);
            addImpactRing(sp2.x,sp2.y,'#ff8833',60);
            shakeIntensity=Math.max(shakeIntensity,5);
          } else if(sc==='mage'){
            sparks(gameState,sp2.x,sp2.y,sp2.color,28,240);
            shakeIntensity=Math.max(shakeIntensity,4);
          } else if(sc==='tank'){
            sparks(gameState,sp2.x,sp2.y,sp2.color,12,100);
            shakeIntensity=Math.max(shakeIntensity,3);
          } else {
            sparks(gameState,sp2.x,sp2.y,sp2.color,15,100);
            shakeIntensity=Math.max(shakeIntensity,3);
          }
        }
        if(typeof sfxSpecial==='function') sfxSpecial(msg.cls);
      }
      break;
    case 'ultimateUsed':
      if(gameState){
        const up=gameState.players.find(p=>p.id===msg.playerId);
        if(up){
          up.glowTimer=3000; up.glowColor=up.color;
          const uc=msg.cls;
          if(uc==='gunner'){
            sparks(gameState,up.x,up.y,'#00ffff',30,200);
            sparks(gameState,up.x,up.y,'#ffffff',15,140);
            shakeIntensity=Math.max(shakeIntensity,8);
          } else if(uc==='assassin'){
            sparks(gameState,up.x,up.y,'#666666',40,180);
            shakeIntensity=Math.max(shakeIntensity,6);
          } else if(uc==='mage'){
            sparks(gameState,up.x,up.y,'#cc44ff',25,200);
            sparks(gameState,up.x,up.y,'#ffffff',12,160);
            shakeIntensity=Math.max(shakeIntensity,8);
          } else if(uc==='tank'){
            up.glowColor='#00ff88';
            sparks(gameState,up.x,up.y,'#00ff88',40,250);
            addImpactRing(up.x,up.y,'#00ff88',130);
            shakeIntensity=Math.max(shakeIntensity,10);
          } else if(uc==='necro'){
            sparks(gameState,up.x,up.y,'#88cc44',50,280);
            sparks(gameState,up.x,up.y,'#aaffaa',25,200);
            sparks(gameState,up.x,up.y,'#ccffcc',12,140);
            addImpactRing(up.x,up.y,'#88cc44',120);
            addImpactRing(up.x,up.y,'#66aa22',80);
            shakeIntensity=Math.max(shakeIntensity,12);
          } else if(uc==='ranger'){
            sparks(gameState,up.x,up.y,'#ff8833',25,150);
            addImpactRing(up.x,up.y,'#ff8833',80);
            shakeIntensity=Math.max(shakeIntensity,6);
          } else {
            sparks(gameState,up.x,up.y,up.color,30,200);
            addImpactRing(up.x,up.y,up.color);
            shakeIntensity=Math.max(shakeIntensity,6);
          }
        }
        if(typeof sfxUltimate==='function') sfxUltimate();
      }
      break;
    case 'hookHit':
      if(gameState){
        sparks(gameState, msg.hookX, msg.hookY, '#00ff88', 15, 90);
        if(typeof sfxHookHit==='function') sfxHookHit();
        // Hooker: show "HOOKED!" floating text near the target
        if(msg.hookerId === myPlayerId){
          const htgt = gameState.players.find(p=>p.id===msg.targetId);
          if(htgt) addDmgNumber(htgt.x, htgt.y-30, 'HOOKED!', '#00ff88', true);
          addImpactRing(msg.hookX, msg.hookY, '#00ff88', 120);
          shakeIntensity = Math.max(shakeIntensity, 8);
        }
        // Hooked player: prominent personal alert
        if(msg.targetId === myPlayerId){
          if(typeof showCenterAlert==='function') showCenterAlert('HOOKED!', '#00f5ff', 1400);
          if(typeof triggerScreenFlash==='function') triggerScreenFlash('#00f5ff', 0.35);
          shakeIntensity = Math.max(shakeIntensity, 12);
        }
      }
      break;
    case 'hookMiss': break;
    case 'orbPickup':
      if(gameState) { addGoldFloat(msg.x, msg.y, msg.value); if(typeof sfxOrbPickup==='function') sfxOrbPickup(); }
      break;
    case 'campCleared':
      if(gameState) addGoldFloat(msg.campX, msg.campY, msg.gold);
      break;

    case 'xpGain': {
      if (!gameState) break;
      const xpP = getLocalPlayer(gameState);
      if (!xpP) break;
      xpP.xp    = msg.xp;
      xpP.level = msg.level;
      if (typeof _updateXPBar === 'function') _updateXPBar(xpP);
      break;
    }

    case 'levelUp': {
      if (!gameState) break;
      const lvlP = getLocalPlayer(gameState);
      if (!lvlP) break;
      const prevLevel = lvlP.level || 1;
      lvlP.level = msg.level;
      lvlP.xp    = msg.xp;
      // Sync per-level stat bonuses so client state matches server
      // Uses additive increment (same as server) so talent multiplications stay on top
      const levelsGained = msg.level - prevLevel;
      if (levelsGained > 0) {
        lvlP.maxHp       = (lvlP.maxHp || 100) + levelsGained * 10;
        lvlP.hp          = Math.min(lvlP.maxHp, (lvlP.hp || 0) + levelsGained * 10);
        lvlP.lvlDmgMult  = (lvlP.lvlDmgMult || 1) + levelsGained * 0.02;
        lvlP.lvlCdr      = Math.max(0.3, (lvlP.lvlCdr || 1) - levelsGained * 0.02);
      }
      // VFX
      if (typeof sparks      === 'function') sparks(gameState, lvlP.x, lvlP.y, '#ffcc00', 22, 180);
      if (typeof addDmgNumber=== 'function') addDmgNumber(lvlP.x, lvlP.y - 32, '⬆ LVL ' + msg.level, '#ffcc00', false);
      if (typeof showCenterAlert === 'function') showCenterAlert('LEVEL ' + msg.level + '!', '#ffcc00', 1800);
      // Queue talent pick if a tier unlocked
      if (msg.tierIdx >= 0 && typeof TALENTS !== 'undefined') {
        const choices = TALENTS[lvlP.cls]?.[msg.tierIdx] || [];
        if (choices.length) {
          lvlP.talentQueue = lvlP.talentQueue || [];
          lvlP.talentQueue.push({ tierIdx: msg.tierIdx, choices });
          if (typeof _updateTalentBadge === 'function') _updateTalentBadge(lvlP);
        }
      }
      if (typeof _updateXPBar === 'function') _updateXPBar(lvlP);
      break;
    }

    case 'talentPicked':
      // Server confirmed — talent already applied optimistically client-side
      break;
    case 'explosion':
      if(gameState) { sparks(gameState, msg.x, msg.y, '#ff8800', 30, msg.radius||100); shakeIntensity = Math.max(shakeIntensity, 6); if(typeof sfxExplosion==='function') sfxExplosion(); }
      break;
    case 'respawn':
      if(gameState){
        const rp=gameState.players.find(p=>p.id===msg.playerId);
        if(rp){ rp.x=msg.x; rp.y=msg.y; rp.alive=true; }
        sparks(gameState, msg.x, msg.y, '#00f5ff', 25, 150);
        if(typeof sfxRespawn==='function') sfxRespawn();
      }
      break;
    case 'playerDisconnected':
      if(gameState){
        const dcP=gameState.players.find(p=>p.id===msg.playerId);
        if(dcP){ dcP.alive=false; dcP.hp=0; }
        gameState.players=gameState.players.filter(p=>p.id!==msg.playerId);
        addKillfeed(msg.name||'PLAYER','','disconnected');
      }
      break;
    case 'playerForfeited': {
      if(gameState){
        const fp = gameState.players.find(p=>p.id===msg.playerId);
        if(fp){ fp.alive=false; fp.hp=0; sparks(gameState,fp.x,fp.y,fp.color||'#fff',20,150); }
        // Show killfeed entry
        const feed = document.getElementById('killfeed');
        if(feed){
          const div = document.createElement('div'); div.className='kf-entry';
          div.style.borderRightColor='#888';
          div.textContent = (msg.name||'PLAYER') + ' LEFT THE GAME';
          feed.appendChild(div);
          setTimeout(()=>div.classList.add('fade'),2500);
          setTimeout(()=>div.remove(),4500);
          if(feed.children.length>6) feed.firstChild.remove();
        }
        // If it was us who forfeited, the server sends us matchEnd — nothing extra needed
      }
      break;
    }
    case 'matchEnd':
      if(typeof stopMusic==='function') stopMusic();
      if(typeof stopAmbient==='function') stopAmbient();
      { const fb = document.getElementById('forfeitBtn'); if(fb) fb.style.display='none'; }
      if(gameState){
        gameState.gameOver=true;
        gameRunning=false;
        const won = msg.winner === myPlayerId;
        document.getElementById('hud').classList.add('hidden');
        showScreen('resultScreen');
        document.getElementById('rTitle').textContent=won?'YOU WIN!':(msg.winner===0?'DRAW':'YOU LOSE');
        document.getElementById('rTitle').className='result-title '+(won?'result-win':'result-lose');
        const myScore=msg.score[myPlayerId]||0;
        document.getElementById('rKills').textContent=myScore;
        document.getElementById('rShots').textContent=gameState.stats?.shots||0;
        document.getElementById('rAcc').textContent='--';
        document.getElementById('rSpec').textContent=gameState.stats?.spec||0;
        document.getElementById('rEn').textContent=gameState.stats?.en||0;
        document.getElementById('rStreak').textContent=gameState.stats?.bestStreak||0;
        const delta=msg.eloChange?msg.eloChange[myPlayerId]:0;
        PD.elo=Math.max(0,PD.elo+(delta||0)); if(won)PD.wins++;else if(msg.winner!==0)PD.losses++; savePD();
        document.getElementById('rElo').textContent=((delta>=0?'+':'')+delta)+' ELO — NOW '+PD.elo;
        document.getElementById('rElo').className='elo-change '+((delta>=0)?'elo-up':'elo-down');
        if(msg.rankings && msg.rankings.length > 2) {
          let rankHtml='<div style="margin-top:12px;font-size:13px;color:var(--dim)">';
          msg.rankings.forEach((r,i)=>{
            const me=r.id===myPlayerId;
            rankHtml+=`<div style="${me?'color:var(--cyan);font-weight:bold':''}">` +
              `#${i+1} ${r.name} (${r.cls.toUpperCase()}) — ${r.score} kills ${r.elo>=0?'+':''}${r.elo} ELO</div>`;
          });
          rankHtml+='</div>';
          const rElo=document.getElementById('rElo');
          rElo.insertAdjacentHTML('afterend', rankHtml);
        }
      }
      break;
    case 'upgradeBought': {
      const lp=getLocalPlayer(gameState);
      if(lp) lp.energy=msg.energy;
      const upInfo = ALL_UPS.find(u=>u.id===msg.id);
      if(upInfo) showUpgradeFanfare(upInfo.name, ITEM_ICONS[msg.id]);
      break;
    }
    case 'consumableBought':
    case 'consumableUpdate':
      if(gameState){
        const lp=getLocalPlayer(gameState);
        if(lp && msg.consumables) lp.consumables = msg.consumables;
        if(lp && msg.energy !== undefined) lp.energy = msg.energy;
      }
      break;
    case 'snipeFired':
      if(gameState){
        const sniper=gameState.players.find(p=>p.id===msg.playerId);
        if(sniper){
          const sa=msg.angle||0;
          sparks(gameState,sniper.x,sniper.y,'#ff3333',30,200);
          sparks(gameState,sniper.x,sniper.y,'#ffaa00',15,150);
          addImpactRing(sniper.x,sniper.y,'#ff3333',60);
          shakeIntensity=Math.max(shakeIntensity,8);
          triggerScreenFlash('#ff220044',0.1);
          for(let i=0;i<8;i++){
            const spread=(Math.random()-0.5)*0.3;
            gameState.particles.push({x:sniper.x+Math.cos(sa+spread)*(sniper.radius+10+i*6),
              y:sniper.y+Math.sin(sa+spread)*(sniper.radius+10+i*6),
              vx:Math.cos(sa)*100+Math.random()*40,vy:Math.sin(sa)*100+Math.random()*40,
              life:0.5,ml:0.3,col:i<4?'#ff6633':'#ffaa00',sz:3+Math.random()*3});
          }
        }
      }
      break;
    case 'consumableUsed':
      if(gameState){
        sparks(gameState, msg.x||0, msg.y||0, '#ffcc00', 10, 60);
        if(msg.item==='healthPot') addHealNumber(msg.x||0, (msg.y||0)-15, 50);
      }
      break;
    case 'heal':
      if(gameState){
        const hp2=gameState.players.find(p=>p.id===msg.playerId);
        if(hp2){ addHealNumber(hp2.x, hp2.y-15, msg.amount||0); sparks(gameState,hp2.x,hp2.y,'#00ff88',6,50); }
      }
      break;
    case 'grenadeThrown':
      break; // Visual handled by state sync
  }
}

// ═══════════════════════════════════════════════════════════════
// FORFEIT / LEAVE
// ═══════════════════════════════════════════════════════════════
let forfeitPending = false;
let forfeitResetTimer = null;
function forfeitClick() {
  const btn = document.getElementById('forfeitBtn');
  if (!btn) return;
  if (!forfeitPending) {
    // First click — ask for confirmation
    forfeitPending = true;
    btn.textContent = 'CONFIRM LEAVE?';
    btn.style.borderColor = 'rgba(255,80,80,.8)';
    btn.style.color = 'rgba(255,80,80,1)';
    if (forfeitResetTimer) clearTimeout(forfeitResetTimer);
    forfeitResetTimer = setTimeout(() => {
      forfeitPending = false;
      if (btn) { btn.textContent = 'LEAVE'; btn.style.borderColor = 'rgba(255,50,50,.3)'; btn.style.color = 'rgba(255,80,80,.7)'; }
    }, 3000);
  } else {
    // Second click — confirmed, send forfeit
    forfeitPending = false;
    if (forfeitResetTimer) { clearTimeout(forfeitResetTimer); forfeitResetTimer = null; }
    btn.style.display = 'none';
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'forfeit' }));
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// STATE SNAPSHOT HANDLING
// ═══════════════════════════════════════════════════════════════
function handleStateSnapshot(msg) {
  if (!gameState) return;
  const serverTime = msg.t;
  const localNow = performance.now();

  if (msg.tick && lastServerSeq) {
    const expected = lastServerSeq + 1; // 60Hz: ticks increment by 1 each broadcast
    if (msg.tick > expected + 4) {
      packetLoss = (packetLoss * 0.7) + ((msg.tick - expected) / msg.tick) * 0.3;
      adjustNetworkSettings();
    } else {
      packetLoss *= 0.95;
      if (packetLoss < 0.005) packetLoss = 0;
      adjustNetworkSettings();
    }
  }
  lastServerSeq = msg.tick || lastServerSeq;

  const offset = localNow - serverTime;
  serverTimeOffsetSamples.push(offset);
  if (serverTimeOffsetSamples.length > 20) serverTimeOffsetSamples.shift();
  // Use ~10th percentile (near-minimum RTT) — more accurate for game sync than median.
  // Median skews high due to jitter spikes; minimum-RTT region reflects true clock offset.
  const sorted = [...serverTimeOffsetSamples].sort((a,b) => a - b);
  serverTimeOffset = sorted[Math.max(0, Math.floor(sorted.length * 0.1))];

  snapshotBuffer.push({ serverTime, localTime: localNow, data: msg });
  while (snapshotBuffer.length > SNAPSHOT_BUFFER_SIZE) snapshotBuffer.shift();

  applyLocalPlayerState(msg);
  gameState.score = msg.score || gameState.score;
  if (msg.time != null) {
    gameState.matchTime = msg.time + ((performance.now() - gameState.startTime) / 1000);
  }
}

function applyLocalPlayerState(st) {
  if (!Array.isArray(st.players)) return;
  for (const sp of st.players) {
    if (sp.id !== myPlayerId) continue;
    const p = gameState.players.find(pp => pp.id === sp.id);
    if (!p) continue;

    // Copy all stats
    p.hp = sp.hp ?? p.hp;
    p.maxHp = sp.maxHp ?? p.maxHp;
    p.shield = sp.shield || 0;
    p.energy = sp.energy ?? p.energy;
    p.alive = sp.alive ?? p.alive;
    p.killStreak = sp.killStreak || 0;
    p.streakSpdBoost = sp.streakSpdBoost || 1;
    p.streakDmgBoost = sp.streakDmgBoost || 1;
    p.streakDmgTimer = sp.streakDmgTimer || 0;
    p.streakSpdTimer = sp.streakSpdTimer || 0;
    // Do NOT overwrite lastShot/lastDash/lastSp/lastUlt — server binary state
    // doesn't include them, so they'd reset to 0 and break all cooldowns.
    // The client tracks its own cooldown timers locally.
    p.swordOn = sp.swordOn || false;
    p.swordAngle = sp.swordAngle || 0;
    p.swordSweep = sp.swordSweep || 0;
    if (sp.swordTimer > 0) p.swordTimer = sp.swordTimer;
    p.novaOn = sp.novaOn || false;
    p.novaR = sp.novaR || 0;
    p.novaX = sp.novaX || 0;
    p.novaY = sp.novaY || 0;
    p.novaLife = sp.novaLife || 0;
    p.novaHit = sp.novaHit || false;
    p.overchargeTimer = sp.overchargeTimer || 0;
    p.smokeTimer = sp.smokeTimer || 0;
    p.smokeX = sp.smokeX || p.smokeX || 0;
    p.smokeY = sp.smokeY || p.smokeY || 0;
    p.barrierOn = sp.barrierOn || false;
    p.barrierTimer = sp.barrierTimer || 0;
    p.barrierHp = sp.barrierHp || 0;
    p.invuln = sp.invuln || 0;
    p.dmgBoostTimer = sp.dmgBoostTimer || 0;
    p.spdBoostTimer = sp.spdBoostTimer || 0;
    p.drainTimer = sp.drainTimer || 0;
    p.invisTimer = sp.invisTimer || 0;
    p.glowTimer = sp.glowTimer || 0;
    p.glowColor = CDEFS[p.cls]?.color || '#fff';
    p.adrenalineTimer = sp.adrenalineTimer || 0;
    p.fortifyTimer = sp.fortifyTimer || 0;
    // Hook state sync for local player (was missing — caused hook to not render)
    p.hookOn = sp.hookOn || false;
    if (sp.hookOn) {
      p.hookX = sp.hookX || 0;
      p.hookY = sp.hookY || 0;
      p.hookReturning = sp.hookReturning || false;
      p.hookTarget = sp.hookTarget || null;
      p.hookHit = sp.hookHit || false;
    }
    // Charge state sync for ranger sniper
    p.charging = sp.charging || false;
    p.chargeTimer = sp.chargeTimer || 0;
    if (sp.charging) p.chargeAngle = sp.angle || p.angle;
    if (Array.isArray(sp.consumables)) p.consumables = sp.consumables;
    if (Array.isArray(sp.minions)) {
      p.minions = sp.minions.map(m => ({...m, alive:true, radius:8, maxHp:m.maxHp||40}));
    }
    if (Array.isArray(sp.upgrades)) {
      p.upgrades = {};
      sp.upgrades.forEach(u => p.upgrades[u] = true);
    }

    // Position reconciliation — correct prediction error without teleporting
    const dx = sp.x - p.x, dy = sp.y - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > 200) {
      // Way off — hard correct (respawn, death, ability teleport)
      p.x = sp.x; p.y = sp.y;
      p.vx = sp.vx || 0; p.vy = sp.vy || 0;
    } else if (dist > 60) {
      // Large divergence — hard reset to server position, then replay unacked inputs
      p.x = sp.x; p.y = sp.y;
      p.vx = sp.vx || 0; p.vy = sp.vy || 0;
      for (const inp of inputBuffer) {
        clientPredictMovement(p, inp, inp.dt || (1/60));
      }
    } else if (dist > 1.5) {
      // Distance-proportional correction — gentle for small drifts, punchy for large
      // At 60Hz net + 144Hz render, corrections fire frequently so blend can be gentle
      // Small errors (< 20px): blend at 18% per packet — visually undetectable
      // Large errors (20-60px): snap at 30% so they converge in ~3 server frames
      const blendRate = dist < 20 ? 0.18 : 0.30;
      const corrPx = Math.min(dist, Math.max(1.5, dist * blendRate));
      const corrF = corrPx / dist;
      p.x += dx * corrF;
      p.y += dy * corrF;
      p.vx = p.vx * 0.85 + (sp.vx || 0) * 0.15;
      p.vy = p.vy * 0.85 + (sp.vy || 0) * 0.15;
    }
    // Under 1.5px: don't correct — sub-pixel drift, prediction is accurate enough

    if (typeof debugStats !== 'undefined') debugStats.predError = Math.round(dist);

    const ackedSeq = sp.seq || 0;
    if (ackedSeq > lastAckedSeq) {
      lastAckedSeq = ackedSeq;
      // In-place removal — avoids new array allocation on every server ack
      let _wi = 0;
      for (let _ri = 0; _ri < inputBuffer.length; _ri++) {
        if (inputBuffer[_ri].seq > ackedSeq) inputBuffer[_wi++] = inputBuffer[_ri];
      }
      inputBuffer.length = _wi;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// HERMITE INTERPOLATION — Much smoother than linear
// ═══════════════════════════════════════════════════════════════
function hermite(t, p0, p1, m0, m1) {
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2*t3 - 3*t2 + 1;
  const h10 = t3 - 2*t2 + t;
  const h01 = -2*t3 + 3*t2;
  const h11 = t3 - t2;
  return h00*p0 + h10*m0 + h01*p1 + h11*m1;
}

function interpolateRemoteEntities(dt) {
  if (snapshotBuffer.length < 2) return;
  const renderTime = performance.now() - serverTimeOffset - INTERP_DELAY_MS;
  let fromIdx = -1;

  // Find bracket
  for (let i = 0; i < snapshotBuffer.length - 1; i++) {
    if (snapshotBuffer[i].serverTime <= renderTime && snapshotBuffer[i + 1].serverTime >= renderTime) {
      fromIdx = i; break;
    }
  }

  let from, to, t, range;
  let extrapolating = false;
  let extrapolateMs = 0;

  if (fromIdx >= 0) {
    from = snapshotBuffer[fromIdx];
    to = snapshotBuffer[fromIdx + 1];
    range = to.serverTime - from.serverTime;
    t = range > 0 ? Math.max(0, Math.min(1, (renderTime - from.serverTime) / range)) : 1;
  } else if (snapshotBuffer.length >= 2) {
    // Extrapolation — we're ahead of all snapshots (packet delay)
    from = snapshotBuffer[snapshotBuffer.length - 2];
    to = snapshotBuffer[snapshotBuffer.length - 1];
    range = to.serverTime - from.serverTime;
    const elapsed = renderTime - to.serverTime;
    // Cap at 90% of a frame interval — on good connections packets are rarely >1 frame late
    t = range > 0 ? 1 + Math.min(0.9, elapsed / range) : 1;
    extrapolateMs = Math.max(0, elapsed);
    extrapolating = elapsed > 10; // only flag if meaningfully ahead
  } else {
    return; // not enough data yet
  }

  if (typeof debugStats !== 'undefined') debugStats.extrapolating = extrapolating;

  if (Array.isArray(from.data.players) && Array.isArray(to.data.players)) {
    // Build O(1) lookup Maps once per interp call instead of O(n) .find() per player
    _interpFromMap.clear();
    for(let _ii=0;_ii<from.data.players.length;_ii++) _interpFromMap.set(from.data.players[_ii].id, from.data.players[_ii]);
    _interpLocalMap.clear();
    for(let _ii=0;_ii<gameState.players.length;_ii++) _interpLocalMap.set(gameState.players[_ii].id, gameState.players[_ii]);

    for (const toP of to.data.players) {
      if (toP.id === myPlayerId) continue;
      const fromP  = _interpFromMap.get(toP.id);
      const localP = _interpLocalMap.get(toP.id);
      if (!fromP || !localP) continue;

      // Teleport/dash detection — squared distance, no Math.sqrt
      const _sdx=toP.x-fromP.x, _sdy=toP.y-fromP.y;
      const isTeleport = _sdx*_sdx+_sdy*_sdy > 48400; // 220²

      // Hermite interpolation for positions (uses velocity as tangent)
      const rangeS = range / 1000; // convert ms to seconds for velocity scaling
      if (isTeleport) {
        // Hard snap to destination — don't lerp through walls
        localP.x = toP.x; localP.y = toP.y;
      } else if (rangeS > 0 && !extrapolating) {
        localP.x = hermite(t, fromP.x, toP.x, (fromP.vx||0)*rangeS, (toP.vx||0)*rangeS);
        localP.y = hermite(t, fromP.y, toP.y, (fromP.vy||0)*rangeS, (toP.vy||0)*rangeS);
      } else if (extrapolating) {
        // Velocity-based extrapolation — more accurate than linear lerp past toP
        const extraTime = Math.min(extrapolateMs, range * 0.7) / 1000;
        localP.x = toP.x + (toP.vx || 0) * extraTime;
        localP.y = toP.y + (toP.vy || 0) * extraTime;
      } else {
        localP.x = fromP.x + (toP.x - fromP.x) * t;
        localP.y = fromP.y + (toP.y - fromP.y) * t;
      }

      // Smooth velocity — pre-allocated circular buffer, no per-frame object allocation
      if (!toP.alive) { _vhPool.delete(toP.id); velocityHistory.delete(toP.id); continue; }
      let vh = _vhPool.get(toP.id);
      if (!vh) { vh = { buf: new Float32Array(VH_CAP * 2), wr: 0, len: 0 }; _vhPool.set(toP.id, vh); }
      const _slot = vh.wr * 2;
      vh.buf[_slot]   = toP.vx || 0;
      vh.buf[_slot+1] = toP.vy || 0;
      vh.wr = (vh.wr + 1) % VH_CAP;
      if (vh.len < VH_CAP) vh.len++;
      if (vh.len > 1) {
        let wSum=0, wvx=0, wvy=0;
        // Read in chronological order from circular buffer (oldest first → highest weight = most recent)
        for (let _w=0; _w<vh.len; _w++) {
          const _ri = ((vh.wr - vh.len + _w + VH_CAP) % VH_CAP) * 2;
          const w = 1 << _w; // 1,2,4,8,16,32
          wvx += vh.buf[_ri]   * w;
          wvy += vh.buf[_ri+1] * w;
          wSum += w;
        }
        localP.vx = localP.vx * 0.6 + (wvx / wSum) * 0.4;
        localP.vy = localP.vy * 0.6 + (wvy / wSum) * 0.4;
      } else {
        localP.vx = toP.vx || 0;
        localP.vy = toP.vy || 0;
      }

      // Smooth angle interpolation — framerate-independent exponential blend
      let angleDiff = toP.angle - fromP.angle;
      if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      const targetAngle = fromP.angle + angleDiff * Math.min(t, 1);
      let currentDiff = targetAngle - localP.angle;
      if (currentDiff > Math.PI) currentDiff -= Math.PI * 2;
      if (currentDiff < -Math.PI) currentDiff += Math.PI * 2;
      // 28Hz convergence rate — snappy aim tracking without jitter
      const angleBlend = Math.min(1, 1 - Math.exp(-28 * (dt || 0.016)));
      localP.angle += currentDiff * angleBlend;

      // Apply state
      localP.hp = toP.hp != null ? toP.hp : localP.hp;
      localP.maxHp = toP.maxHp != null ? toP.maxHp : localP.maxHp;
      localP.shield = toP.shield || 0;
      localP.energy = toP.energy != null ? toP.energy : localP.energy;
      localP.alive = toP.alive != null ? toP.alive : localP.alive;
      localP.invuln = toP.invuln || 0;
      localP.cls = toP.cls || localP.cls;
      localP.team = toP.team || localP.team || 0;
      // Use team color in team mode, class color otherwise
      if (gameState.teamMode && localP.team > 0) {
        localP.color = localP.team === 1 ? '#4488ff' : '#ff4444';
      } else {
        localP.color = CDEFS[localP.cls]?.color || localP.color;
      }
      localP.killStreak = toP.killStreak || 0;
      localP.streakSpdBoost = toP.streakSpdBoost || 1;
      localP.streakDmgBoost = toP.streakDmgBoost || 1;
      localP.streakDmgTimer = toP.streakDmgTimer || 0;
      localP.streakSpdTimer = toP.streakSpdTimer || 0;
      localP.swordOn = toP.swordOn || false;
      localP.swordAngle = toP.swordAngle || 0;
      localP.swordSweep = toP.swordSweep || 0;
      localP.swordTimer = toP.swordTimer || 0;
      localP.novaOn = toP.novaOn || false;
      localP.novaR = toP.novaR || 0; localP.novaX = toP.novaX || 0; localP.novaY = toP.novaY || 0;
      localP.novaLife = toP.novaLife || 0;
      localP.overchargeTimer = toP.overchargeTimer || 0;
      localP.smokeTimer = toP.smokeTimer || 0;
      localP.smokeX = toP.smokeX || localP.smokeX || 0;
      localP.smokeY = toP.smokeY || localP.smokeY || 0;
      localP.barrierOn = toP.barrierOn || false;
      localP.barrierTimer = toP.barrierTimer || 0; localP.barrierHp = toP.barrierHp || 0;
      // Don't overwrite cooldown timestamps for remote players either — not sent in binary state
      localP.hookOn = toP.hookOn || false;
      if (toP.hookOn) {
        const fromHookP = fromP;
        if (fromHookP.hookOn) {
          localP.hookX = fromHookP.hookX + ((toP.hookX || 0) - (fromHookP.hookX || 0)) * Math.min(t, 1);
          localP.hookY = fromHookP.hookY + ((toP.hookY || 0) - (fromHookP.hookY || 0)) * Math.min(t, 1);
        } else { localP.hookX = toP.hookX || 0; localP.hookY = toP.hookY || 0; }
        localP.hookReturning = toP.hookReturning;
        localP.hookTarget = toP.hookTarget;
        localP.hookHit = toP.hookHit;
      }
      localP.fortifyTimer = toP.fortifyTimer || 0;
      // NEW synced fields
      localP.invisTimer = toP.invisTimer || 0;
      localP.drainTimer = toP.drainTimer || 0;
      localP.glowTimer = toP.glowTimer || 0;
      localP.glowColor = CDEFS[localP.cls]?.color || '#fff';
      localP.charging = toP.charging || false;
      localP.chargeTimer = toP.chargeTimer || 0;
      localP.chargeAngle = toP.angle || localP.angle;
      localP.adrenalineTimer = toP.adrenalineTimer || 0;
      localP.dmgBoostTimer = toP.dmgBoostTimer || 0;
      localP.spdBoostTimer = toP.spdBoostTimer || 0;
      if (Array.isArray(toP.upgrades)) {
        localP.upgrades = {};
        toP.upgrades.forEach(u => localP.upgrades[u] = true);
      }
    }
  }

  // Bullets — extrapolate from latest snapshot, and replace predicted bullets
  const latestSnap = to.data;
  if (Array.isArray(latestSnap.bullets)) {
    const age = (performance.now() - to.localTime) / 1000;

    // Remove server-authoritative bullets and confirmed predicted bullets in-place (no new arrays)
    for (let i = gameState.bullets.length - 1; i >= 0; i--) {
      const b = gameState.bullets[i];
      if (!b.isPredicted) { gameState.bullets.splice(i, 1); continue; }
      // Keep predicted bullet unless server has confirmed it (same owner within 80px)
      for (const sb of latestSnap.bullets) {
        if (sb.owner === b.owner) {
          const dx = sb.x - b.x, dy = sb.y - b.y;
          if (dx*dx + dy*dy < 6400) { gameState.bullets.splice(i, 1); break; }
        }
      }
    }
    // Push server bullets (predicted ones that survived are still in the array)
    for (const b of latestSnap.bullets) {
      const owner = gameState.players.find(pp => pp.id === b.owner);
      gameState.bullets.push({
        x: b.x + (b.vx || 0) * age, y: b.y + (b.vy || 0) * age,
        r: b.r, vx: b.vx || 0, vy: b.vy || 0,
        owner: b.owner, isMage: !!b.isMage,
        isSnipe: !!b.isSnipe, isArrow: !!b.isArrow,
        color: b.isSnipe ? '#ff4444' : b.isArrow ? '#ff8833' : (owner?.color || '#fff'),
        life: 1000
      });
    }
  }
  if (Array.isArray(latestSnap.mobBullets)) {
    const age = (performance.now() - to.localTime) / 1000;
    gameState.mobBullets.length = 0;
    for (const mb of latestSnap.mobBullets) {
      gameState.mobBullets.push({
        x: mb.x + (mb.vx || 0) * age, y: mb.y + (mb.vy || 0) * age,
        r: mb.r || 5, vx: mb.vx || 0, vy: mb.vy || 0,
        color: mb.color || '#ff6600', type: mb.type || 'bolt', life: 1000
      });
    }
  }
  if (Array.isArray(latestSnap.orbs)) {
    gameState.orbs.length = 0;
    for (const o of latestSnap.orbs) gameState.orbs.push({...o, pulse: o.pulse || 0});
  }
  if (Array.isArray(latestSnap.grenades)) {
    gameState.grenades = latestSnap.grenades;
  }
  if (Array.isArray(latestSnap.traps)) {
    gameState.traps = latestSnap.traps;
  }
}

// ═══════════════════════════════════════════════════════════════
// INPUT SENDING
// ═══════════════════════════════════════════════════════════════

// Read current raw input state without sending — used for every-frame prediction
const _inputObj = { ax:0, ay:0, angle:0, shoot:false, dash:false, special:false };
function readLocalInput() {
  if (!gameState) return null;
  const p = getLocalPlayer(gameState);
  if (!p) return null;
  let ax=0, ay=0;
  if(K['KeyW']||K['ArrowUp'])    ay=-1;
  if(K['KeyS']||K['ArrowDown'])  ay=1;
  if(K['KeyA']||K['ArrowLeft'])  ax=-1;
  if(K['KeyD']||K['ArrowRight']) ax=1;
  const l=Math.sqrt(ax*ax+ay*ay); if(l>0){ax/=l;ay/=l;}
  _inputObj.ax=ax; _inputObj.ay=ay;
  _inputObj.angle=Math.atan2((M.y/CAM_ZOOM+camY)-p.y,(M.x/CAM_ZOOM+camX)-p.x);
  _inputObj.shoot=!!(M.down||K['Space']);
  _inputObj.dash=!!(K['ShiftLeft']||M.rdown);
  _inputObj.special=!!(K['KeyQ']||K['KeyF']);
  return _inputObj;
}

function sendInput(frameDt){
  if(!gameState||!ws||ws.readyState!==1) return null;
  const now=performance.now();
  if(now-lastInputSend<INPUT_SEND_INTERVAL) return null;
  lastInputSend=now;

  const p=getLocalPlayer(gameState);
  if(!p||!p.alive) return null;

  const inp = readLocalInput();
  if (!inp) return null;

  const seq=++netSeq;
  ws.send(JSON.stringify({type:'input',seq,ax:inp.ax,ay:inp.ay,angle:inp.angle,shoot:inp.shoot?1:0,dash:inp.dash?1:0,special:inp.special?1:0}));

  // Store actual frame dt so prediction replay is accurate at any framerate
  inputBuffer.push({seq,ax:inp.ax,ay:inp.ay,angle:inp.angle,shoot:inp.shoot,dash:inp.dash,special:inp.special,dt:frameDt||1/60});
  if(inputBuffer.length>INPUT_BUFFER_SIZE) inputBuffer.shift();

  return inp;
}

// ═══════════════════════════════════════════════════════════════
// CAMERA — Critically damped spring for buttery smoothness
// ═══════════════════════════════════════════════════════════════
function updateCameraSmooth(gs, dt) {
  const p = getLocalPlayer(gs);
  if (!p) { updateCamera(gs); return; }

  // Subtle aim lead — small shift toward mouse, capped so it doesn't feel floaty
  const mouseWorldX = (typeof M !== 'undefined' ? M.x : 0) / CAM_ZOOM + camX;
  const mouseWorldY = (typeof M !== 'undefined' ? M.y : 0) / CAM_ZOOM + camY;
  const px = p.renderX ?? p.x;
  const py = p.renderY ?? p.y;
  const rawLeadX = (mouseWorldX - px) * 0.03;
  const rawLeadY = (mouseWorldY - py) * 0.03;
  const leadMag = Math.sqrt(rawLeadX * rawLeadX + rawLeadY * rawLeadY);
  const maxLead = 30;
  const leadScale = leadMag > maxLead ? maxLead / leadMag : 1;
  const targetX = Math.max(0, Math.min(W - VW/CAM_ZOOM, px - VW/(2*CAM_ZOOM) + rawLeadX * leadScale));
  const targetY = Math.max(0, Math.min(H - VH/CAM_ZOOM, py - VH/(2*CAM_ZOOM) + rawLeadY * leadScale));

  if (!cameraInitialized) {
    smoothCamX = targetX; smoothCamY = targetY;
    camVelX = 0; camVelY = 0;
    cameraInitialized = true;
  }

  // Critically damped spring: ω = 2π * freq, ζ = 1.0
  const freq = 8; // 8Hz — responsive without feeling nervous (~125ms settle time)
  const omega = 2 * Math.PI * freq;
  const dampedDt = Math.min(dt || 0.016, 0.033);

  const dx = targetX - smoothCamX;
  const dy = targetY - smoothCamY;

  // Critically damped spring formula
  const exp = Math.exp(-omega * dampedDt);
  smoothCamX = targetX - (dx + (camVelX + omega * dx) * dampedDt) * exp;
  smoothCamY = targetY - (dy + (camVelY + omega * dy) * dampedDt) * exp;
  camVelX = (camVelX - omega * (camVelX + omega * dx) * dampedDt) * exp;
  camVelY = (camVelY - omega * (camVelY + omega * dy) * dampedDt) * exp;

  camX = smoothCamX;
  camY = smoothCamY;
}

function clientPredictMovement(p, inp, dt){
  let spdMult=1;
  if(p.upgrades.speed||p.upgrades['speed']) spdMult+=0.3;
  if(p.upgrades.boots||p.upgrades['boots']) spdMult+=0.15;
  if(p.smokeTimer>0) spdMult*=1.4;
  if(p.streakSpdBoost>1) spdMult*=p.streakSpdBoost;
  if(p.spdBoostTimer>0) spdMult*=1.5;
  const spd=p.speed*spdMult;
  const accel=2200;
  p.vx+=inp.ax*accel*dt; p.vy+=inp.ay*accel*dt;
  const friction=1-Math.min(1,6.5*dt);
  p.vx*=friction; p.vy*=friction;
  if(Math.abs(p.vx)<0.5) p.vx=0;
  if(Math.abs(p.vy)<0.5) p.vy=0;
  const s=Math.sqrt(p.vx*p.vx+p.vy*p.vy);
  if(s>spd){p.vx=p.vx/s*spd; p.vy=p.vy/s*spd;}
  let nx=p.x+p.vx*dt, ny=p.y+p.vy*dt;
  const mapW = serverMapW || W, mapH = serverMapH || H;
  nx=Math.max(p.radius,Math.min(mapW-p.radius,nx));
  ny=Math.max(p.radius,Math.min(mapH-p.radius,ny));
  for(const w of gameState.walls){
    const cx=Math.max(w.x,Math.min(nx,w.x+w.w));
    const cy=Math.max(w.y,Math.min(ny,w.y+w.h));
    const dx=nx-cx, dy=ny-cy, d=Math.sqrt(dx*dx+dy*dy);
    if(d<p.radius){const ov=p.radius-d+1; if(d>0){nx+=dx/d*ov;ny+=dy/d*ov;} Math.abs(dx)>Math.abs(dy)?p.vx*=-.3:p.vy*=-.3;}
  }
  p.x=nx; p.y=ny;
}

// ═══════════════════════════════════════════════════════════════
// ONLINE GAME START & LOOP
// ═══════════════════════════════════════════════════════════════
function startOnlineGame(){
  showScreen(null);
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('pingDisplay').style.display='block';
  const modeEl=document.getElementById('hudMode');
  modeEl.textContent='ONLINE '+matchPlayersInfo.length+'P'; modeEl.className='mode-badge mode-online';
  const pcls=selectedCls||PD.cls||'gunner';
  if(serverMapW && serverMapH){ W=serverMapW; H=serverMapH; }

  const myInfo = matchPlayersInfo.find(p=>p.id===myPlayerId) || { cls: pcls, x: W*0.5, y: H*0.5 };
  gameState=makeGS(myInfo.cls, matchPlayersInfo.length>1 ? matchPlayersInfo[1].cls : 'gunner');

  // Create all players using server-provided spawn positions
  gameState.players = matchPlayersInfo.map(info => {
    const spawnX = info.x || W * 0.5;
    const spawnY = info.y || H * 0.5;
    const p = mkPlayer(info.id, spawnX, spawnY, info.cls, info.id===myPlayerId, 0);
    p.isHuman = info.id === myPlayerId;
    p.name = info.name;
    p.team = info.team || 0;
    p.color = info.color || CDEFS[info.cls]?.color || '#fff';
    return p;
  });
  gameState.score = {};
  matchPlayersInfo.forEach(info => gameState.score[info.id] = 0);
  gameState.ai = matchPlayersInfo.map(() => null);

  if(serverWalls) gameState.walls=serverWalls;
  if(serverShopZone) gameState.shopZone=serverShopZone;

  // Team mode setup
  gameState.teamMode = !!(window._serverTeamMode);
  gameState.towers = window._serverTowers || [];
  // Tower shop zones — player can shop near their team tower
  if (window._serverTowerShops && window._serverTowerShops.length) {
    gameState.towerShops = window._serverTowerShops;
  }

  // Clear camps — server will sync them via campsSync messages
  gameState.camps = [];

  snapshotBuffer = []; serverTimeOffsetSamples = []; serverTimeOffset = 0;
  inputBuffer = []; lastAckedSeq = 0; netSeq = 0; lastInputSend = 0;
  lastServerSeq = 0; packetLoss = 0; networkQuality = 'good'; INTERP_DELAY_MS = 20; _interpTarget = 20;
  _onlineAcc = 0;
  velocityHistory.clear(); cameraInitialized = false; lastHUDUpdate = 0;
  camVelX = 0; camVelY = 0;
  const localPlayer = getLocalPlayer(gameState);
  if (localPlayer) {
    camX = Math.max(0, Math.min(W - VW, localPlayer.x - VW / 2));
    camY = Math.max(0, Math.min(H - VH, localPlayer.y - VH / 2));
  }
  gameState.stats={shots:0,hits:0,en:0,spec:0,bestStreak:0};
  playMode = 'online';
  gameRunning=true; lastT=performance.now();
  requestAnimationFrame(onlineGameLoop);
}

let prevSpecialDown = false;
let prevUltDown = false;

// No fixed timestep for prediction — variable dt is correct here.
// Fixed timestep at 1/120 on a 144Hz screen means ~17% of frames run 0 prediction steps
// (accumulator below threshold) = player doesn't move those frames = the micro-stutter.
// Server reconciliation corrects any tiny dt-variation errors within a few frames anyway.
let _onlineAcc = 0; // kept so the reset line doesn't error

// Profiler — logs to console every 3s. Set DEBUG_PROFILER=true to enable (or add #debug to URL).
const DEBUG_PROFILER = typeof location !== 'undefined' && location.hash.includes('debug');
let _perfRender = 0, _perfVfx = 0, _perfNet = 0, _perfFrames = 0;
let _perfLastRaf = 0, _perfGapAccum = 0;
let _measuredHz = 60;
setInterval(() => {
  if (!_perfFrames) return;
  const f = _perfFrames;
  const avgGap = _perfGapAccum / f;
  if (avgGap > 0) _measuredHz = Math.round(1000 / avgGap);
  const budget   = 1000 / _measuredHz;
  const headroom = budget - (_perfRender + _perfVfx) / f;

  // Network stats from live variables
  const ping      = typeof netPing          !== 'undefined' ? netPing          : '--';
  const loss      = typeof packetLoss       !== 'undefined' ? (packetLoss*100).toFixed(1) : '--';
  const interp    = typeof INTERP_DELAY_MS  !== 'undefined' ? Math.round(INTERP_DELAY_MS) : '--';
  const quality   = typeof networkQuality   !== 'undefined' ? networkQuality   : '--';
  const snapshots = typeof snapshotBuffer   !== 'undefined' ? snapshotBuffer.length : '--';
  const sendRate  = typeof serverSendRate   !== 'undefined' ? serverSendRate   : '--';
  const mode      = typeof playMode         !== 'undefined' ? playMode         : '--';

  if (DEBUG_PROFILER) console.log(
    `\n========= REFLEX ARENA DEBUG =========\n` +
    `  TIME      ${new Date().toLocaleTimeString()}\n` +
    `  MODE      ${mode}\n` +
    `--- PERFORMANCE ---\n` +
    `  FPS       ~${_measuredHz}Hz  (${f} frames / 3s)\n` +
    `  RENDER    ${(_perfRender/f).toFixed(2)}ms\n` +
    `  VFX       ${(_perfVfx/f).toFixed(2)}ms\n` +
    `  RAF-GAP   ${avgGap.toFixed(2)}ms  (budget ${budget.toFixed(2)}ms)\n` +
    `  HEADROOM  ${headroom.toFixed(2)}ms\n` +
    `--- NETWORK ---\n` +
    `  PING      ${ping}ms\n` +
    `  LOSS      ${loss}%\n` +
    `  INTERP    ${interp}ms\n` +
    `  QUALITY   ${quality}\n` +
    `  SNAPSHOTS ${snapshots} buffered\n` +
    `  SRV-RATE  ${sendRate}Hz\n` +
    `  NET-PROC  ${(_perfNet/f).toFixed(2)}ms/frame\n` +
    `======================================`
  );
  _perfRender=0; _perfVfx=0; _perfNet=0; _perfGapAccum=0; _perfFrames=0;
}, 3000);

function onlineGameLoop(t){
  if(!gameRunning)return;
  try {
    // Skip work entirely on hidden tab — avoids huge dt spike when tab comes back
    if (document.hidden) {
      lastT = t; _perfLastRaf = t; // reset profiler baseline so hidden gap doesn't corrupt stats
      if (typeof _scheduleFrame === 'function') _scheduleFrame(onlineGameLoop);
      else requestAnimationFrame(onlineGameLoop);
      return;
    }
    const dt=Math.min((t-lastT)/1000, 1/30); lastT=t; // clamp to 33ms — was 50ms
    if(!gameState||gameState.gameOver)return;

    // ── Always read input every frame for smooth local prediction ──
    const inp = readLocalInput();
    const localPlayer = getLocalPlayer(gameState);

    if(localPlayer && localPlayer.alive && inp){
      const now=performance.now();

      // ── CLIENT-SIDE DASH PREDICTION (every frame, not gated by send rate) ──
      if(inp.dash){
        const adrenMul = localPlayer.adrenalineTimer > 0 ? 0.5 : 1;
        const effDcd = (localPlayer.dashCd||CDEFS[localPlayer.cls].dashCd) *
          (localPlayer.upgrades?.fastDash ? 0.6 : 1) * adrenMul;
        if((now-(localPlayer.lastDash||0)) > effDcd){
          const oldX=localPlayer.x, oldY=localPlayer.y;
          const mapW=serverMapW||W, mapH=serverMapH||H;
          if(localPlayer.upgrades?.teleport){
            localPlayer.x=Math.max(localPlayer.radius,Math.min(mapW-localPlayer.radius,
              localPlayer.x+Math.cos(localPlayer.angle)*280));
            localPlayer.y=Math.max(localPlayer.radius,Math.min(mapH-localPlayer.radius,
              localPlayer.y+Math.sin(localPlayer.angle)*280));
            sparks(gameState,localPlayer.x,localPlayer.y,localPlayer.color,20,200);
          } else {
            const dl=Math.sqrt(inp.ax*inp.ax+inp.ay*inp.ay);
            const ddx=dl>.1?inp.ax/dl:Math.cos(localPlayer.angle);
            const ddy=dl>.1?inp.ay/dl:Math.sin(localPlayer.angle);
            const dashPow=localPlayer.upgrades?.boots?1600:1500; // must match server.js serverDash
            localPlayer.vx=ddx*dashPow; localPlayer.vy=ddy*dashPow;
          }
          addDashTrail(gameState,oldX,oldY,localPlayer.x,localPlayer.y,localPlayer.color);
          sparks(gameState,localPlayer.x,localPlayer.y,localPlayer.color,10,110);
          localPlayer.lastDash=now;
          localPlayer.invuln=200;
          if(typeof sfxDash==='function') sfxDash();
        }
      }

      // ── CLIENT-SIDE MOVEMENT PREDICTION (variable dt — runs every frame) ──
      clientPredictMovement(localPlayer, inp, dt);

      // Update local aim angle every frame
      if(!gameState.shopOpen){
        localPlayer.angle = inp.angle;
      }

      // ── PREDICTED BULLET SPAWNING — fire VFX/cosmetic bullet instantly ──
      if(inp.shoot){
        const d=CDEFS[localPlayer.cls];
        let fr=localPlayer.upgrades?.rapidFire?d.fireRate*.58:localPlayer.upgrades?.heavy?d.fireRate*1.8:d.fireRate;
        if(localPlayer.overchargeTimer>0) fr*=0.33;
        if((now-localPlayer.lastShot)>fr){
          if(localPlayer.cls==='assassin'){
            // Assassin: sword VFX only
            localPlayer.swordOn=true; localPlayer.swordAngle=localPlayer.angle;
            localPlayer.swordSweep=0; localPlayer.swordTimer=220;
            sparks(gameState,localPlayer.x+Math.cos(localPlayer.angle)*30,localPlayer.y+Math.sin(localPlayer.angle)*30,localPlayer.color,8,80);
          } else if(localPlayer.cls === 'ranger') {
            // Ranger: client-side charge visual feedback
            if(!localPlayer.charging){
              localPlayer.charging = true;
              localPlayer.chargeTimer = 0;
              localPlayer.chargeAngle = localPlayer.angle;
            }
            localPlayer.chargeTimer += dt * 1000;
            localPlayer.chargeAngle = localPlayer.angle;
            // Show charging particles
            if(localPlayer.chargeTimer > 200 && Math.random() < 0.4){
              const ca = localPlayer.angle;
              sparks(gameState, localPlayer.x+Math.cos(ca)*20, localPlayer.y+Math.sin(ca)*20, 
                localPlayer.chargeTimer >= 1000 ? '#ff3333' : '#ff8833', 2, 30);
            }
          } else {
            // Spawn a client-predicted bullet — visually immediate
            const a = localPlayer.angle;
            const predBullet = {
              x: localPlayer.x+Math.cos(a)*(localPlayer.radius+4),
              y: localPlayer.y+Math.sin(a)*(localPlayer.radius+4),
              vx: Math.cos(a)*d.bSpd, vy: Math.sin(a)*d.bSpd,
              owner: myPlayerId, color: localPlayer.color,
              r: localPlayer.cls==='mage'?8:4,
              isMage: localPlayer.cls==='mage',
              isPredicted: true,
              life: d.bLife * 0.9, // slightly shorter — server will replace it
              team: localPlayer.team
            };
            gameState.bullets.push(predBullet);
            if(localPlayer.upgrades?.doubleShot){
              gameState.bullets.push({...predBullet, x:localPlayer.x+Math.cos(a+.13)*(localPlayer.radius+4), y:localPlayer.y+Math.sin(a+.13)*(localPlayer.radius+4), vx:Math.cos(a+.13)*d.bSpd, vy:Math.sin(a+.13)*d.bSpd, isPredicted:true});
              gameState.bullets.push({...predBullet, x:localPlayer.x+Math.cos(a-.13)*(localPlayer.radius+4), y:localPlayer.y+Math.sin(a-.13)*(localPlayer.radius+4), vx:Math.cos(a-.13)*d.bSpd, vy:Math.sin(a-.13)*d.bSpd, isPredicted:true});
            }
            sparks(gameState,localPlayer.x+Math.cos(a)*localPlayer.radius,localPlayer.y+Math.sin(a)*localPlayer.radius,localPlayer.color,localPlayer.cls==='mage'?7:3,localPlayer.cls==='mage'?70:36);
          }
          localPlayer.lastShot=now;
          if(playMode==='online') gameState.stats.shots++;
        }
      } else {
        // Mouse released — reset ranger charge if applicable
        if(localPlayer.cls === 'ranger' && localPlayer.charging){
          if(localPlayer.chargeTimer > 200){
            // Fire a predicted normal arrow on release
            const d=CDEFS.ranger;
            const a = localPlayer.angle;
            gameState.bullets.push({
              x: localPlayer.x+Math.cos(a)*(localPlayer.radius+4),
              y: localPlayer.y+Math.sin(a)*(localPlayer.radius+4),
              vx: Math.cos(a)*d.bSpd, vy: Math.sin(a)*d.bSpd,
              owner: myPlayerId, color: '#ff8833',
              r: 4, isMage: false, isPredicted: true, isArrow: true,
              life: d.bLife * 0.9, team: localPlayer.team
            });
            sparks(gameState, localPlayer.x+Math.cos(a)*localPlayer.radius, localPlayer.y+Math.sin(a)*localPlayer.radius, '#ff8833', 3, 36);
            localPlayer.lastShot = now;
            if(playMode==='online') gameState.stats.shots++;
          }
          localPlayer.charging = false;
          localPlayer.chargeTimer = 0;
        }
      }

      const specialDown = inp.special;
      if(specialDown && !prevSpecialDown){
        if((now - (localPlayer.lastSp||0)) > (localPlayer.spCd||CDEFS[localPlayer.cls].spCd)){
          localPlayer.lastSp = now; // HUD shows cooldown immediately
          gameState.stats.spec = (gameState.stats.spec||0)+1;
          if(ws && ws.readyState===1) ws.send(JSON.stringify({type:'useSpecial'}));
        }
      }
      prevSpecialDown = specialDown;

      // ── ULTIMATE (R key) ──
      const ultDown = !!(K['KeyR']);
      if(ultDown && !prevUltDown){
        if(localPlayer.energy >= 100 && (now - (localPlayer.lastUlt||0)) > (localPlayer.ultCd||CDEFS[localPlayer.cls].ultCd)){
          localPlayer.lastUlt = now;
          localPlayer.energy = 0;
          if(ws && ws.readyState===1) ws.send(JSON.stringify({type:'useUltimate'}));
        }
      }
      prevUltDown = ultDown;
    }

    // Send to server at INPUT_SEND_INTERVAL (separate from prediction)
    if(performance.now()-lastInputSend >= INPUT_SEND_INTERVAL && ws && ws.readyState===1){
      sendInput(dt);
    }

    interpolateRemoteEntities(dt);

    // Advance all bullets every frame (both real and predicted)
    for(const b of gameState.bullets){ b.x+=b.vx*dt; b.y+=b.vy*dt; b.life-=dt*1000; }
    for(let _bi=gameState.bullets.length-1;_bi>=0;_bi--){ if(gameState.bullets[_bi].life<=0) gameState.bullets.splice(_bi,1); }
    if(gameState.mobBullets){ for(const mb of gameState.mobBullets){ mb.x+=mb.vx*dt; mb.y+=mb.vy*dt; } }

    // Tick down local invuln for visual feedback
    if(localPlayer && localPlayer.invuln>0) localPlayer.invuln-=dt*1000;
    for(const p of gameState.players){
      if(p.swordTimer>0){p.swordTimer-=dt*1000; p.swordSweep=1-(p.swordTimer/300); if(p.swordTimer<=0){p.swordOn=false;p.swordTimer=0;}}
      if(p.glowTimer>0) p.glowTimer-=dt*1000;
      if(p.drainTimer>0) p.drainTimer-=dt*1000;
      if(p.overchargeTimer>0) p.overchargeTimer-=dt*1000;
      if(p.fortifyTimer>0) p.fortifyTimer-=dt*1000;
      if(p.barrierOn){
        p.barrierTimer-=dt*1000;
        if(p.barrierTimer<=0||p.barrierHp<=0){p.barrierOn=false;p.barrierTimer=0;p.barrierHp=0;}
      }
      if(p.smokeTimer>0){
        p.smokeTimer-=dt*1000;
        if(p.id!==myPlayerId && Math.random()<0.3){
          sparks(gameState,p.smokeX+(Math.random()-.5)*80,p.smokeY+(Math.random()-.5)*80,'#555555',1,30);
        }
      }
      if(p.novaOn){
        p.novaR+=dt*340; p.novaLife-=dt*1000;
        if(p.novaLife<=0||p.novaR>240) p.novaOn=false;
      }
      if(p.invisTimer>0) p.invisTimer-=dt*1000;
      if(p.dmgBoostTimer>0) p.dmgBoostTimer-=dt*1000;
      if(p.spdBoostTimer>0) p.spdBoostTimer-=dt*1000;
      if(p.adrenalineTimer>0) p.adrenalineTimer-=dt*1000;
      updateStreakTimers(p,dt);
    }
    // raf-gap: time since last frame — cap at 50ms so single outlier frames don't skew average
    if (_perfLastRaf) _perfGapAccum += Math.min(t - _perfLastRaf, 50);
    _perfLastRaf = t;

    const _tvfx = performance.now();
    updParticles(gameState,dt); updDashTrails(gameState,dt); updateDmgNumbers(dt);
    updateImpactRings(dt); updateMinionSlashes(dt); updateCombo(dt);
    updateGoldFloats(dt); updateRemoteCamps(dt); updateScreenFlashTimer(dt);
    if(typeof updateBulletTrails==='function') updateBulletTrails(gameState,dt);
    if(typeof updateBloodSplatters==='function') updateBloodSplatters(dt);
    updateCameraSmooth(gameState, dt);
    _perfVfx += performance.now() - _tvfx;

    if (typeof updateDebugStats === 'function') updateDebugStats(dt);

    const _t0 = performance.now();
    render(gameState);
    _perfRender += performance.now() - _t0;

    if (typeof renderDebugOverlay === 'function') renderDebugOverlay();

    updateHUD();
    _perfFrames++;
    if (typeof _scheduleFrame === 'function') _scheduleFrame(onlineGameLoop);
    else requestAnimationFrame(onlineGameLoop);
  } catch(err) { showCanvasError(err); }
}

function showCanvasError(err){
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,VW,VH);
  ctx.fillStyle='#000'; ctx.fillRect(0,0,VW,VH);
  ctx.fillStyle='#ff5555'; ctx.font='16px Orbitron,monospace'; ctx.textAlign='left';
  ctx.fillText('ONLINE ERROR: '+String(err), 20, 40);
  if(err && err.stack){
    const lines=String(err.stack).split('\n').slice(0,6);
    ctx.font='12px Share Tech Mono';
    for(let i=0;i<lines.length;i++) ctx.fillText(lines[i], 20, 70 + i*18);
  }
}

// Try connecting on load
setTimeout(()=>{
  if(SERVER_URL) connectToServer();
  else {
    document.getElementById('serverStatus').textContent='⚠ No server — offline mode only';
    document.getElementById('serverStatus').style.color='var(--dim)';
    document.getElementById('onlineBtn').style.opacity='.4';
    document.getElementById('onlineBtn').style.pointerEvents='none';
  }
},100);
