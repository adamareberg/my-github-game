// ═══════════════════════════════════════════════════════════════
// RENDERER.JS — All canvas drawing (optimized)
// ═══════════════════════════════════════════════════════════════

function updateCamera(gs){
  const p=gs.players.find(pp => pp.isHuman) || gs.players[0];
  const targetX=p.x-VW/(2*CAM_ZOOM);
  const targetY=p.y-VH/(2*CAM_ZOOM);
  const tx=Math.max(0,Math.min(W-VW/CAM_ZOOM,targetX));
  const ty=Math.max(0,Math.min(H-VH/CAM_ZOOM,targetY));
  camX+=(tx-camX)*0.22;
  camY+=(ty-camY)*0.22;
}

function updateCameraSmooth(gs) {
  const p = getLocalPlayer(gs);
  if (!p) { updateCamera(gs); return; }
  const targetX = Math.max(0, Math.min(W - VW/CAM_ZOOM, p.x - VW/(2*CAM_ZOOM)));
  const targetY = Math.max(0, Math.min(H - VH/CAM_ZOOM, p.y - VH/(2*CAM_ZOOM)));
  if (!cameraInitialized) {
    smoothCamX = targetX; smoothCamY = targetY; cameraInitialized = true;
  }
  const smoothFactor = 0.22;
  smoothCamX += (targetX - smoothCamX) * smoothFactor;
  smoothCamY += (targetY - smoothCamY) * smoothFactor;
  camX = smoothCamX; camY = smoothCamY;
}

// ── CACHED OFFSCREEN CANVASES ──
let bgCache = null;
let bgCacheW = 0, bgCacheH = 0;
let vignetteCache = null;
let vignetteCacheW = 0, vignetteCacheH = 0;

function getBackgroundCache() {
  if (bgCache && bgCacheW === VW && bgCacheH === VH) return bgCache;
  bgCache = document.createElement('canvas');
  bgCache.width = VW; bgCache.height = VH;
  bgCacheW = VW; bgCacheH = VH;
  const c = bgCache.getContext('2d');
  const bgGrad = c.createRadialGradient(VW/2, VH/2, 0, VW/2, VH/2, VW*0.8);
  bgGrad.addColorStop(0, '#080c18');
  bgGrad.addColorStop(0.5, '#050810');
  bgGrad.addColorStop(1, '#020408');
  c.fillStyle = bgGrad;
  c.fillRect(0, 0, VW, VH);
  return bgCache;
}

function getVignetteCache() {
  if (vignetteCache && vignetteCacheW === VW && vignetteCacheH === VH) return vignetteCache;
  vignetteCache = document.createElement('canvas');
  vignetteCache.width = VW; vignetteCache.height = VH;
  vignetteCacheW = VW; vignetteCacheH = VH;
  const c = vignetteCache.getContext('2d');
  const vigGrad = c.createRadialGradient(VW/2, VH/2, VW*0.3, VW/2, VH/2, VW*0.75);
  vigGrad.addColorStop(0, 'rgba(0,0,0,0)');
  vigGrad.addColorStop(0.7, 'rgba(0,0,0,0.15)');
  vigGrad.addColorStop(1, 'rgba(0,0,0,0.55)');
  c.fillStyle = vigGrad;
  c.fillRect(0, 0, VW, VH);
  return vignetteCache;
}

// ── NEBULA CLOUD SYSTEM (reduced count) ──
let nebulaClouds = [];
function initNebulaClouds(){
  nebulaClouds = [];
  for(let i=0;i<8;i++){
    const hues = ['0,100,255','180,0,255','255,0,120','0,255,180','255,80,0'];
    nebulaClouds.push({
      x: Math.random()*W, y: Math.random()*H,
      r: 150+Math.random()*250,
      color: hues[Math.floor(Math.random()*hues.length)],
      alpha: 0.015+Math.random()*0.025,
      vx: (Math.random()-0.5)*8, vy: (Math.random()-0.5)*6,
      phase: Math.random()*Math.PI*2
    });
  }
}

// ── BULLET TRAIL SYSTEM (object pool — no splice/alloc after warm-up) ──
const MAX_BULLET_TRAILS = 60;
const bulletTrails = [];
function _btPoolAdd(x,y,life,ml,color,sz){
  for(let i=0;i<bulletTrails.length;i++){
    if(bulletTrails[i].life<=0){
      const t=bulletTrails[i]; t.x=x; t.y=y; t.life=life; t.ml=ml; t.color=color; t.sz=sz; return;
    }
  }
  if(bulletTrails.length<MAX_BULLET_TRAILS) bulletTrails.push({x,y,life,ml,color,sz});
}
function updateBulletTrails(gs, dt){
  for(const b of gs.bullets){
    if(Math.random()<0.15) _btPoolAdd(b.x,b.y,1,0.3,b.color||'#ff3355',b.r*0.6+Math.random()*1.5);
  }
  if(gs.mobBullets){
    for(const mb of gs.mobBullets){
      if(Math.random()<0.1) _btPoolAdd(mb.x,mb.y,1,0.25,mb.color||'#bb77ff',mb.r*0.4+Math.random()*1);
    }
  }
  for(let i=0;i<bulletTrails.length;i++){
    const t=bulletTrails[i];
    if(t.life<=0) continue;
    t.life-=dt/t.ml;
    if(t.life<0) t.life=0;
  }
}

// Frame counter for throttling expensive effects
let renderFrame = 0;
// Cached frame timestamp — set once per render() call, reused everywhere
let _frameTime = 0;

// ── MOB BODY CACHE ──
// Pre-renders each unique mob appearance (type+color+radius) to OffscreenCanvas.
// Each frame we drawImage instead of re-running arc+font calls per mob.
const _mobBodyCache = {};
function _getMobBody(mob) {
  const key = mob.type + '|' + mob.color + '|' + mob.radius;
  if (_mobBodyCache[key]) return _mobBodyCache[key];
  const r = mob.radius;
  const d = Math.ceil(r * 2.6);
  const off = new OffscreenCanvas(d, d);
  const c = off.getContext('2d');
  const cx = d / 2;
  c.fillStyle = mob.color;
  c.beginPath(); c.arc(cx, cx, r, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#fff4'; c.lineWidth = 1.2;
  c.beginPath(); c.arc(cx, cx, r, 0, Math.PI * 2); c.stroke();
  if (mob.icon && mob.icon !== '●') {
    c.font = Math.ceil(r * 0.9) + 'px sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#fff';
    c.fillText(mob.icon, cx, cx);
  }
  _mobBodyCache[key] = { off, d, cx };
  return _mobBodyCache[key];
}

// ── MINIMAP WALL CACHE ──
let _minimapWallCanvas = null;
let _minimapWallKey = -1;
function _getMinimapWallCache(walls, mmW, mmH) {
  const key = walls.length;
  if (_minimapWallCanvas && _minimapWallKey === key) return _minimapWallCanvas;
  _minimapWallCanvas = new OffscreenCanvas(mmW, mmH);
  const mc = _minimapWallCanvas.getContext('2d');
  mc.fillStyle = 'rgba(0,100,200,.5)';
  for (const w of walls) {
    mc.fillRect(w.x/W*mmW, w.y/H*mmH, Math.max(1, w.w/W*mmW), Math.max(1, w.h/H*mmH));
  }
  _minimapWallKey = key;
  return _minimapWallCanvas;
}

function render(gs){
  _frameTime = performance.now();
  renderFrame++;
  const ZW = VW / CAM_ZOOM;
  const ZH = VH / CAM_ZOOM;
  ctx.drawImage(getBackgroundCache(), 0, 0);

  ctx.save();
  ctx.scale(CAM_ZOOM, CAM_ZOOM);
  ctx.translate(-camX,-camY);
  try {

  // ── PRIMARY GRID ONLY (removed fine grid + scanlines for perf) ──
  const t = _frameTime;
  const gridPulse = Math.sin(t / 2000) * 0.015 + 0.045;
  ctx.strokeStyle = `rgba(0,180,255,${gridPulse})`;
  ctx.lineWidth = 1;
  const gxS=Math.floor(camX/80)*80, gyS=Math.floor(camY/80)*80;
  ctx.beginPath();
  for(let x=gxS;x<camX+ZW+80;x+=80){ ctx.moveTo(x,camY); ctx.lineTo(x,camY+ZH); }
  for(let y=gyS;y<camY+ZH+80;y+=80){ ctx.moveTo(camX,y); ctx.lineTo(camX+ZW,y); }
  ctx.stroke();

  // ── TERRAIN SPRITES (grass + water) ──
  if(typeof drawTerrainGrass==='function'){
    if(!terrainPatches) initTerrainPatches();
    drawTerrainGrass(ctx, camX, camY);
  }
  if(typeof drawTerrainWater==='function'){
    drawTerrainWater(ctx, camX, camY);
  }

  // ── TILE LAYERS (painted in editor, loaded from map data) ──
  if(typeof drawTileLayers==='function'){
    drawTileLayers(ctx, camX, camY, ZW, ZH);
  }
  // ── OBJECT LAYERS (atlas regions placed in editor) ──
  if(typeof drawObjectLayers==='function'){
    drawObjectLayers(ctx, camX, camY, ZW, ZH);
  }

  // ── NEON LANE MARKERS (simplified) ──
  ctx.save();
  ctx.strokeStyle = 'rgba(0,200,255,.04)';
  ctx.lineWidth = 2;
  ctx.setLineDash([30,60]);
  ctx.beginPath();ctx.moveTo(0,H/2);ctx.lineTo(W,H/2);ctx.stroke();
  ctx.beginPath();ctx.moveTo(W/2,0);ctx.lineTo(W/2,H);ctx.stroke();
  ctx.setLineDash([]); ctx.restore();


// ── NEON BORDER + CORNER BRACKETS ──
  ctx.save();
  ctx.shadowColor = '#00f5ff'; ctx.shadowBlur = 8;
  ctx.strokeStyle='rgba(0,245,255,.18)'; ctx.lineWidth=2; ctx.strokeRect(2,2,W-4,H-4);
  ctx.shadowBlur = 0;
  ctx.strokeStyle='rgba(0,245,255,.06)'; ctx.lineWidth=1; ctx.strokeRect(10,10,W-20,H-20);
  ctx.strokeStyle='rgba(0,245,255,.4)'; ctx.lineWidth=2.5;
  ctx.shadowColor='#00f5ff'; ctx.shadowBlur=12;
  const cLen=80;
  [[0,0,1,1],[W,0,-1,1],[0,H,1,-1],[W,H,-1,-1]].forEach(([cx2,cy2,dx2,dy2])=>{
    ctx.beginPath();ctx.moveTo(cx2,cy2+dy2*cLen);ctx.lineTo(cx2,cy2);ctx.lineTo(cx2+dx2*cLen,cy2);ctx.stroke();
  });
  ctx.shadowBlur=0; ctx.restore();

  // ── ENERGY FIELD (center zone) ──
  if(gs.teamMode){
    ctx.save();
    ctx.fillStyle='rgba(68,136,255,.03)'; ctx.fillRect(0,0,W/2,H);
    ctx.fillStyle='rgba(255,68,68,.03)'; ctx.fillRect(W/2,0,W/2,H);
    ctx.strokeStyle='rgba(255,255,255,.05)'; ctx.lineWidth=1; ctx.setLineDash([10,10]);
    ctx.beginPath(); ctx.moveTo(W/2,0); ctx.lineTo(W/2,H); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
  }

  // Center arena ring (simplified — fewer rings)
  ctx.save();
  const centerPulse=Math.sin(t/800)*0.03+0.07;
  ctx.strokeStyle=`rgba(0,245,255,${centerPulse})`; ctx.lineWidth=2;
  ctx.beginPath(); ctx.arc(W/2,H/2,90,0,Math.PI*2); ctx.stroke();
  ctx.strokeStyle=`rgba(255,0,170,${centerPulse*0.6})`; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.arc(W/2,H/2,125,0,Math.PI*2); ctx.stroke();
  ctx.restore();

  // Shop Zones
  const allShops = gs.shopZones || [gs.shopZone];
  for(let si=0;si<allShops.length;si++){
    const sz=allShops[si];
    const szCx=sz.x+sz.w/2, szCy=sz.y+sz.h/2;
    const isMain = si===0;
    ctx.save();
    const shopPulse=Math.sin(_frameTime/600+si)*0.04+0.08;
    ctx.fillStyle=`rgba(255,170,0,${shopPulse})`; ctx.fillRect(sz.x-10,sz.y-10,sz.w+20,sz.h+20);
    ctx.strokeStyle=isMain?'rgba(255,170,0,.5)':'rgba(255,170,0,.35)'; ctx.lineWidth=2; ctx.setLineDash([6,4]);
    ctx.strokeRect(sz.x-10,sz.y-10,sz.w+20,sz.h+20); ctx.setLineDash([]);
    // Try scroll sprite for shop icon, fallback to emoji
    if(typeof drawScrollItem==='function' && !drawScrollItem(ctx, szCx, szCy, 'teleScroll', 36)){
      ctx.fillStyle='#ffaa00'; ctx.font=isMain?'bold 20px Orbitron,monospace':'bold 16px Orbitron,monospace'; ctx.textAlign='center';
      ctx.fillText('🏪',szCx,szCy+6);
    }
    ctx.font='9px Share Tech Mono'; ctx.fillStyle='#ffaa0088'; ctx.textAlign='center';
    ctx.fillText(isMain?'MAIN SHOP [E]':'SHOP [E]',szCx,szCy+22);
    ctx.restore();
  }

  // Grenades
  if(gs.grenades){
    for(const g of gs.grenades){
      ctx.save();
      ctx.translate(g.x, g.y);
      const pulse = Math.sin(_frameTime/150) * 0.2 + 0.8;
      ctx.globalAlpha = pulse;
      ctx.fillStyle = '#ff8800'; ctx.shadowColor = '#ff6600'; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('💣', 0, 4);
      ctx.restore();
    }
  }

  // Traps
  if(gs.traps){
    for(const trap of gs.traps){
      if(!trap.armed) continue;
      ctx.save();
      const tPulse=Math.sin(_frameTime/400)*0.15+0.5;
      ctx.translate(trap.x,trap.y);
      ctx.globalAlpha=tPulse;
      ctx.strokeStyle='#ff8833'; ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(0,0,trap.radius,0,Math.PI*2);ctx.stroke();
      ctx.fillStyle='#ff8833'; ctx.font='12px sans-serif'; ctx.textAlign='center';
      ctx.fillText('🪤',0,4);
      ctx.restore();
    }
  }

  // Camp zones + mobs
  for(const camp of gs.camps){
    ctx.save();
    const allDead=camp.mobs.every(m=>!m.alive);
    if(allDead && camp.dead){
      const elapsed=_frameTime-camp.deathTime;
      const pct=Math.min(1,elapsed/camp.respawnTime);
      ctx.strokeStyle='rgba(100,100,100,.2)'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.arc(camp.x,camp.y,35,0,Math.PI*2); ctx.stroke();
      ctx.strokeStyle='rgba(255,255,255,.3)'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.arc(camp.x,camp.y,35,-Math.PI/2,-Math.PI/2+pct*Math.PI*2); ctx.stroke();
      ctx.fillStyle='rgba(255,255,255,.3)'; ctx.font='8px Share Tech Mono'; ctx.textAlign='center';
      ctx.fillText(Math.ceil((camp.respawnTime-elapsed)/1000)+'s',camp.x,camp.y+3);
    } else {
      ctx.strokeStyle=camp.mobs[0]?.color+'33'||'#fff3'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.arc(camp.x,camp.y,45,0,Math.PI*2); ctx.stroke();
      ctx.fillStyle='#ffaa0088'; ctx.font='8px Share Tech Mono'; ctx.textAlign='center';
      ctx.fillText('+'+camp.gold+'g',camp.x,camp.y-50);
    }
    ctx.restore();
    for(const mob of camp.mobs){
      if(!mob.alive) continue;
      if(mob.x<camX-60||mob.x>camX+ZW+60||mob.y<camY-60||mob.y>camY+ZH+60) continue;
      ctx.save(); ctx.translate(mob.x,mob.y);
      // Try sprite — assigned in editor under "mob_<type>"
      const mobSize = mob.radius * 2.4;
      const mobState = !mob.alive ? 'dead'
        : (mob.aggroTarget ? ((Math.abs(mob.vx||0)>5||Math.abs(mob.vy||0)>5) ? 'walk' : 'attack') : 'idle');
      const mobAngle = mob.angle !== undefined ? mob.angle : Math.atan2(mob.vy||0, mob.vx||0);
      const hasMobSprite = typeof drawEntitySprite === 'function' &&
                           drawEntitySprite(ctx, 'mob_' + mob.type, mobSize, mobState, mobAngle);
      if(!hasMobSprite){
        const mb = _getMobBody(mob);
        ctx.drawImage(mb.off, -mb.cx, -mb.cx);
      }
      const bw=mob.radius*2.2, bh=3, bx=-bw/2, by2=mob.radius+4;
      ctx.fillStyle='rgba(0,0,0,.6)'; ctx.fillRect(bx,by2,bw,bh);
      const hf=mob.hp/mob.maxHp;
      ctx.fillStyle=hf>.5?'#88aa44':'#ff6644';
      ctx.fillRect(bx,by2,bw*hf,bh);
      ctx.restore();
    }
  }

  // Walls — simplified (no gradient, less shadow), viewport-culled
  for(const w of gs.walls){
    if(w.x+w.w<camX||w.x>camX+ZW||w.y+w.h<camY||w.y>camY+ZH) continue;
    ctx.fillStyle = 'rgba(0,45,110,.48)';
    ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.strokeStyle='rgba(0,160,255,.6)'; ctx.lineWidth=1.5;
    ctx.strokeRect(w.x, w.y, w.w, w.h);
    ctx.strokeStyle='rgba(0,245,255,.5)'; ctx.lineWidth=2;
    const cl=8;
    [[w.x,w.y,1,1],[w.x+w.w,w.y,-1,1],[w.x,w.y+w.h,1,-1],[w.x+w.w,w.y+w.h,-1,-1]].forEach(([cx,cy,dx,dy])=>{
      ctx.beginPath();ctx.moveTo(cx,cy+dy*cl);ctx.lineTo(cx,cy);ctx.lineTo(cx+dx*cl,cy);ctx.stroke();
    });
  }

  // ── TOWERS ──
  if(gs.towers){
    for(const tower of gs.towers){
      if(tower.hp<=0) continue;
      ctx.save();
      ctx.translate(tower.x, tower.y);
      // Tower range indicator
      ctx.globalAlpha=0.06;
      ctx.fillStyle=tower.color;
      ctx.beginPath();ctx.arc(0,0,tower.atkRange,0,Math.PI*2);ctx.fill();
      ctx.globalAlpha=0.15;
      ctx.strokeStyle=tower.color; ctx.lineWidth=1; ctx.setLineDash([8,8]);
      ctx.beginPath();ctx.arc(0,0,tower.atkRange,0,Math.PI*2);ctx.stroke();
      ctx.setLineDash([]);
      // Tower body
      ctx.globalAlpha=1;
      ctx.fillStyle=tower.color;
      ctx.beginPath();ctx.arc(0,0,tower.radius,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#fff'; ctx.font='bold 18px sans-serif'; ctx.textAlign='center';
      ctx.fillText('🏰',0,6);
      // HP bar
      const bw=tower.radius*2.5, bh=5;
      ctx.fillStyle='rgba(0,0,0,.7)'; ctx.fillRect(-bw/2,tower.radius+8,bw,bh);
      const hf=tower.hp/tower.maxHp;
      ctx.fillStyle=hf>.5?'#00ff88':hf>.25?'#ffaa00':'#ff3355';
      ctx.fillRect(-bw/2,tower.radius+8,bw*hf,bh);
      // Label
      ctx.fillStyle=tower.color; ctx.font='bold 10px Orbitron,monospace';
      ctx.fillText(tower.team===1?'🔵 TOWER':'🔴 TOWER',0,-tower.radius-10);
      ctx.restore();
    }
  }

  // Blood splatters (ground decals, drawn before entities)
  if(typeof drawBloodSplatters==='function') drawBloodSplatters(ctx, camX, camY);

  // Dash trails
  for(const tr of gs.dashTrails){
    ctx.save();
    ctx.globalAlpha=tr.life*0.6;
    ctx.strokeStyle=tr.color; ctx.lineWidth=6;
    ctx.beginPath(); ctx.moveTo(tr.x1,tr.y1); ctx.lineTo(tr.x2,tr.y2); ctx.stroke();
    ctx.restore();
  }

  // Orbs
  for(const o of gs.orbs){
    if(o.x<camX-30||o.x>camX+ZW+30||o.y<camY-30||o.y>camY+ZH+30) continue;
    const g=Math.sin(o.pulse)*.5+.5;
    // Outer halo (no shadow — use alpha instead)
    ctx.globalAlpha=0.25+g*0.2;
    ctx.fillStyle='#ffaa00';
    ctx.beginPath(); ctx.arc(o.x,o.y,o.r*(1.3+g*.2),0,Math.PI*2); ctx.fill();
    // Core
    ctx.globalAlpha=0.75+g*0.25;
    ctx.fillStyle=`rgba(255,${170+Math.round(g*50)},0,1)`;
    ctx.beginPath(); ctx.arc(o.x,o.y,o.r*(0.88+g*.12),0,Math.PI*2); ctx.fill();
    ctx.globalAlpha=1;
    ctx.fillStyle='#fff'; ctx.font='bold 8px Share Tech Mono'; ctx.textAlign='center';
    ctx.fillText('+'+o.value,o.x,o.y+3);
  }

  // Bullet Trails (batch draw, viewport-culled)
  if (bulletTrails.length > 0) {
    for(const bt of bulletTrails){
      if(bt.x<camX-12||bt.x>camX+ZW+12||bt.y<camY-12||bt.y>camY+ZH+12) continue;
      ctx.globalAlpha=bt.life*0.4;
      ctx.fillStyle=bt.color;
      ctx.beginPath(); ctx.arc(bt.x,bt.y,bt.sz*bt.life,0,Math.PI*2); ctx.fill();
    }
    ctx.globalAlpha=1;
  }

  // Particles (viewport-culled)
  for(const p of gs.particles){
    if(p.x<camX-12||p.x>camX+ZW+12||p.y<camY-12||p.y>camY+ZH+12) continue;
    ctx.globalAlpha=Math.max(0,p.life);
    ctx.fillStyle=p.col; ctx.beginPath();
    ctx.arc(p.x,p.y,p.sz*p.life,0,Math.PI*2); ctx.fill();
  }
  ctx.globalAlpha=1;

  // Bullets — special first, then batch regular by color
  {
    const _regBullets = new Map(); // color → [bullets]
    for(const b of gs.bullets){
      if(b.x<camX-20||b.x>camX+ZW+20||b.y<camY-20||b.y>camY+ZH+20) continue;
      if(b.isSnipe){
        ctx.save();
        ctx.shadowColor='#ff2222'; ctx.shadowBlur=15;
        ctx.fillStyle='#ff4444'; ctx.beginPath(); ctx.arc(b.x,b.y,b.r*2,0,Math.PI*2); ctx.fill();
        ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(b.x,b.y,3,0,Math.PI*2); ctx.fill();
        ctx.restore();
      } else if(b.isMage){
        ctx.save();
        ctx.shadowColor=b.color; ctx.shadowBlur=12;
        ctx.fillStyle=b.color; ctx.beginPath(); ctx.arc(b.x,b.y,b.r*1.8,0,Math.PI*2); ctx.fill();
        ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(b.x,b.y,b.r*0.6,0,Math.PI*2); ctx.fill();
        ctx.restore();
      } else {
        if(!_regBullets.has(b.color)) _regBullets.set(b.color, []);
        _regBullets.get(b.color).push(b);
      }
    }
    // Draw all white outers in one pass
    if(_regBullets.size){
      ctx.fillStyle='#fff';
      ctx.beginPath();
      for(const bullets of _regBullets.values())
        for(const b of bullets){ ctx.moveTo(b.x+b.r,b.y); ctx.arc(b.x,b.y,b.r,0,Math.PI*2); }
      ctx.fill();
      // Draw colored inners grouped by color
      for(const [color,bullets] of _regBullets){
        ctx.fillStyle=color;
        ctx.beginPath();
        for(const b of bullets){ ctx.moveTo(b.x+b.r-1,b.y); ctx.arc(b.x,b.y,b.r-1,0,Math.PI*2); }
        ctx.fill();
      }
    }
  }

  // Mob Bullets (viewport-culled, shadow only for fire/lightning)
  if(gs.mobBullets){
    for(const mb of gs.mobBullets){
      if(mb.x<camX-20||mb.x>camX+ZW+20||mb.y<camY-20||mb.y>camY+ZH+20) continue;
      if(mb.type==='fire'){
        ctx.fillStyle='#ff8833'; ctx.beginPath(); ctx.arc(mb.x,mb.y,mb.r*1.5,0,Math.PI*2); ctx.fill();
        ctx.fillStyle='#ffcc88'; ctx.beginPath(); ctx.arc(mb.x,mb.y,mb.r*0.5,0,Math.PI*2); ctx.fill();
      } else if(mb.type==='lightning'){
        ctx.fillStyle='#aaddff'; ctx.beginPath(); ctx.arc(mb.x,mb.y,mb.r*1.2,0,Math.PI*2); ctx.fill();
        ctx.fillStyle='#88ccff'; ctx.beginPath(); ctx.arc(mb.x,mb.y,mb.r*0.6,0,Math.PI*2); ctx.fill();
      } else {
        ctx.fillStyle=mb.color||'#bb77ff'; ctx.beginPath(); ctx.arc(mb.x,mb.y,mb.r*1.3,0,Math.PI*2); ctx.fill();
      }
    }
  }

  // Impact Rings
  for(const ring of impactRings){
    ctx.save();
    ctx.globalAlpha=ring.life*0.7;
    ctx.strokeStyle=ring.color; ctx.lineWidth=4*ring.life;
    ctx.beginPath(); ctx.arc(ring.x,ring.y,ring.r,0,Math.PI*2); ctx.stroke();
    ctx.restore();
  }

  drawMinionSlashes(ctx, camX, camY);

  // Gold Floats
  for(const gf of goldFloats){
    ctx.save();
    ctx.globalAlpha=Math.min(1,gf.life/0.4);
    ctx.fillStyle='#ffcc00'; ctx.font=`bold ${gf.size}px Orbitron,monospace`; ctx.textAlign='center';
    ctx.fillText(gf.text, gf.x, gf.y);
    ctx.restore();
  }

  // ── PUDGE-STYLE HOOK CHAINS ──
  for(const p of gs.players){
    if(p.hookOn){
      ctx.save();
      const hx=p.hookX, hy=p.hookY;
      const dx=hx-p.x, dy=hy-p.y;
      const dist=Math.sqrt(dx*dx+dy*dy);
      const angle=Math.atan2(dy,dx);
      const segLen=14, segCount=Math.max(1,Math.floor(dist/segLen));
      // Chain links
      for(let si=0;si<segCount;si++){
        const t2=si/segCount;
        const cx=p.x+dx*t2, cy=p.y+dy*t2;
        const wobble=Math.sin(t2*Math.PI*4+_frameTime*0.008)*3*(1-t2*0.5);
        const px=cx+Math.cos(angle+Math.PI/2)*wobble;
        const py=cy+Math.sin(angle+Math.PI/2)*wobble;
        ctx.save();
        ctx.translate(px,py);
        ctx.rotate(angle+Math.PI/2);
        // Chain link shape (oval)
        ctx.fillStyle=si%2===0?'#228855':'#115533';
        ctx.strokeStyle='#00ff88';
        ctx.lineWidth=1.5;
        ctx.beginPath();
        ctx.ellipse(0,0,4,7,0,0,Math.PI*2);
        ctx.fill(); ctx.stroke();
        ctx.restore();
      }
      // Main chain line (thick, glowing)
      ctx.strokeStyle='#00ff88'; ctx.lineWidth=4; ctx.globalAlpha=0.5;
      ctx.shadowColor='#00ff88'; ctx.shadowBlur=10;
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(hx,hy); ctx.stroke();
      ctx.shadowBlur=0; ctx.globalAlpha=1;
      // Hook head (anchor shape)
      ctx.save();
      ctx.translate(hx,hy);
      ctx.rotate(angle);
      // Main hook spike
      ctx.fillStyle='#ccffcc'; ctx.strokeStyle='#00ff88'; ctx.lineWidth=2;
      ctx.shadowColor='#00ff88'; ctx.shadowBlur=12;
      ctx.beginPath();
      ctx.moveTo(14,0);     // tip
      ctx.lineTo(-4,-8);    // top barb
      ctx.lineTo(-2,-3);
      ctx.lineTo(-8,-5);    // top hook curve
      ctx.lineTo(-6,0);     // center
      ctx.lineTo(-8,5);     // bottom hook curve
      ctx.lineTo(-2,3);
      ctx.lineTo(-4,8);     // bottom barb
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.shadowBlur=0;
      // Glowing tip
      ctx.fillStyle='#ffffff';
      ctx.beginPath(); ctx.arc(10,0,3,0,Math.PI*2); ctx.fill();
      ctx.restore();
      // Impact glow if hit
      if(p.hookHit){
        ctx.save();
        ctx.globalAlpha=0.5+Math.sin(_frameTime/60)*0.3;
        ctx.fillStyle='#00ff88'; ctx.shadowColor='#00ff88'; ctx.shadowBlur=20;
        ctx.beginPath(); ctx.arc(hx,hy,18,0,Math.PI*2); ctx.fill();
        ctx.shadowBlur=0;
        ctx.restore();
      }
      ctx.restore();
    }
  }

  // ── RANGER CHARGE-UP LASER SIGHT ──
  for(const p of gs.players){
    if(p.charging && p.chargeTimer>0 && p.cls==='ranger'){
      ctx.save();
      const ca=p.chargeAngle||p.angle;
      const chargePct=Math.min(1,p.chargeTimer/1200);
      const laserLen=200+chargePct*400;
      const ex=p.x+Math.cos(ca)*laserLen, ey=p.y+Math.sin(ca)*laserLen;
      // Red laser line (grows brighter as charge increases)
      ctx.globalAlpha=0.3+chargePct*0.5;
      ctx.strokeStyle='#ff2222'; ctx.lineWidth=1.5+chargePct*2;
      ctx.shadowColor='#ff0000'; ctx.shadowBlur=8+chargePct*12;
      ctx.beginPath(); ctx.moveTo(p.x+Math.cos(ca)*p.radius,p.y+Math.sin(ca)*p.radius);
      ctx.lineTo(ex,ey); ctx.stroke();
      ctx.shadowBlur=0;
      // Charge circle around player
      ctx.strokeStyle='#ff3333'; ctx.lineWidth=3;
      ctx.globalAlpha=0.5+chargePct*0.4;
      ctx.beginPath();
      ctx.arc(p.x,p.y,p.radius+8+chargePct*12,-Math.PI/2,-Math.PI/2+chargePct*Math.PI*2);
      ctx.stroke();
      // Charge percentage text
      if(chargePct>0.1){
        ctx.fillStyle='#ff4444'; ctx.font='bold 10px Orbitron,monospace'; ctx.textAlign='center';
        ctx.globalAlpha=0.7;
        ctx.fillText(Math.floor(chargePct*100)+'%',p.x,p.y-p.radius-20);
      }
      // Pulsing particles along laser — use pool slot, never exceed cap
      if(chargePct>0.3 && Math.random()<chargePct*0.5){
        const pd2=Math.random()*laserLen*0.8;
        sparks(gs,
          p.x+Math.cos(ca)*(p.radius+pd2)+(Math.random()-0.5)*6,
          p.y+Math.sin(ca)*(p.radius+pd2)+(Math.random()-0.5)*6,
          chargePct>0.8?'#ffaa00':'#ff3333', 1, 30);
      }
      ctx.restore();
    }
  }

  // Damage Numbers — single save/restore for entire batch
  if(dmgNumbers.length){
    ctx.save();
    ctx.textAlign='center'; ctx.lineJoin='round'; ctx.strokeStyle='#000';
    for(const dn of dmgNumbers){
      ctx.globalAlpha=Math.min(1,dn.life/0.3);
      const sz = dn.isCrit ? dn.size + Math.sin(dn.life*8)*3 : dn.size;
      ctx.font=`bold ${sz}px Orbitron,monospace`;
      ctx.lineWidth=dn.isCrit?4:2.5;
      ctx.strokeText(dn.text, dn.x, dn.y);
      ctx.fillStyle=dn.color;
      // Shadow only for crits/heals — everything else skip for perf
      if(dn.isCrit){ ctx.shadowColor=dn.color; ctx.shadowBlur=12; }
      else if(dn.isHeal){ ctx.shadowColor='#00ff88'; ctx.shadowBlur=8; }
      ctx.fillText(dn.text, dn.x, dn.y);
      if(dn.isCrit||dn.isHeal) ctx.shadowBlur=0;
    }
    ctx.restore();
  }

  // Smoke clouds
  for(const p of gs.players){
    if(p.smokeTimer>0){
      ctx.save();
      ctx.globalAlpha=Math.min(0.4,p.smokeTimer/3000);
      ctx.fillStyle='rgba(80,80,80,.35)';
      ctx.beginPath();ctx.arc(p.smokeX,p.smokeY,80,0,Math.PI*2);ctx.fill();
      ctx.restore();
    }
  }

  // Players
  for(const p of gs.players){
    if(!p.alive)continue;
    if(p.invuln>0&&Math.floor(p.invuln/80)%2===0)continue;
    if(!p.isHuman&&(p.x<camX-80||p.x>camX+ZW+80||p.y<camY-80||p.y>camY+ZH+80)) continue;
    if((p.smokeTimer>0||p.invisTimer>0)&&!p.isHuman){
      ctx.save(); ctx.globalAlpha=0.12; ctx.translate(p.x,p.y);
      ctx.fillStyle=p.color+'33';
      ctx.beginPath();ctx.arc(0,0,p.radius,0,Math.PI*2);ctx.fill();
      ctx.restore(); continue;
    }
    if(p.invisTimer>0&&p.isHuman){ ctx.save(); ctx.globalAlpha=0.35; }
    ctx.save(); ctx.translate(p.x,p.y);
    // Glow effects (reduced shadow)
    if(p.glowTimer>0||p.overchargeTimer>0||p.barrierOn){
      ctx.save();
      const glowCol=p.overchargeTimer>0?'#00ffff':p.barrierOn?'#cc44ff':p.glowColor;
      const pulse=Math.sin(_frameTime/80)*0.3+0.5;
      ctx.strokeStyle=glowCol; ctx.lineWidth=2; ctx.globalAlpha=0.4+pulse*0.3;
      ctx.beginPath();ctx.arc(0,0,p.radius+18,0,Math.PI*2);ctx.stroke();
      ctx.restore();
    }
    // Team ring
    if(gs.teamMode){
      const tc=p.team===1?TEAM_COLORS.blue:TEAM_COLORS.red;
      ctx.save(); ctx.strokeStyle=tc; ctx.lineWidth=3; ctx.globalAlpha=0.6;
      ctx.beginPath();ctx.arc(0,0,p.radius+4,0,Math.PI*2);ctx.stroke();
      ctx.restore();
    }
    // Overcharge
    if(p.overchargeTimer>0){
      ctx.save();
      ctx.strokeStyle='#00ffff'; ctx.lineWidth=3;
      ctx.globalAlpha=0.5+Math.sin(_frameTime/100)*0.3;
      ctx.beginPath();ctx.arc(0,0,p.radius+12,0,Math.PI*2);ctx.stroke();
      ctx.restore();
    }
    // Barrier
    if(p.barrierOn){
      ctx.save();
      const bAlpha=Math.min(0.7,p.barrierHp/80);
      ctx.strokeStyle='#cc44ff'; ctx.lineWidth=4; ctx.globalAlpha=bAlpha;
      ctx.beginPath();ctx.arc(0,0,p.radius+35,0,Math.PI*2);ctx.stroke();
      ctx.globalAlpha=bAlpha*0.15; ctx.fillStyle='#cc44ff';
      ctx.beginPath();ctx.arc(0,0,p.radius+35,0,Math.PI*2);ctx.fill();
      ctx.restore();
    }
    // Nova
    if(p.novaOn){
      const al=Math.max(0,p.novaLife/700);
      ctx.save(); ctx.strokeStyle=p.color; ctx.lineWidth=4; ctx.globalAlpha=al*.85;
      ctx.beginPath(); ctx.arc(p.novaX-p.x,p.novaY-p.y,p.novaR,0,Math.PI*2); ctx.stroke();
      ctx.restore();
    }
    // Shield
    if(p.shield>0){
      ctx.strokeStyle='#88aaff'; ctx.lineWidth=2;
      ctx.globalAlpha=.5+Math.sin(_frameTime/200)*.2;
      ctx.beginPath(); ctx.arc(0,0,p.radius+7,0,Math.PI*2); ctx.stroke();
      ctx.globalAlpha=1;
    }
    // Streak fire
    if(p.killStreak>=3){
      ctx.save(); ctx.globalAlpha=0.25+Math.sin(_frameTime/150)*0.15;
      const streakCol=p.killStreak>=7?'#ffaa00':p.killStreak>=5?'#00ff88':'#ff4444';
      ctx.strokeStyle=streakCol; ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(0,0,p.radius+20,0,Math.PI*2);ctx.stroke();
      ctx.restore();
    }
    // Class shapes
    renderPlayerShape(ctx, p, gs);
    // Aim line
    ctx.strokeStyle=p.color; ctx.lineWidth=3;
    ctx.beginPath();
    ctx.moveTo(Math.cos(p.angle)*(p.radius-2),Math.sin(p.angle)*(p.radius-2));
    ctx.lineTo(Math.cos(p.angle)*(p.radius+12),Math.sin(p.angle)*(p.radius+12));
    ctx.stroke();
    // Sword arc
    if(p.swordOn&&p.swordTimer>0){
      const sweep=p.swordSweep*Math.PI*.85;
      const sa=p.swordAngle-Math.PI*.42+sweep*.5;
      ctx.save(); ctx.strokeStyle=p.color; ctx.lineWidth=3.5; ctx.globalAlpha=.88;
      ctx.beginPath(); ctx.arc(0,0,p.radius+24,sa-sweep/2,sa+sweep/2); ctx.stroke();
      ctx.restore();
    }
    // HP bar
    ctx.shadowBlur=0;
    const bw=p.radius*2.6, bh=4, bx=-bw/2, by2=p.radius+5;
    ctx.fillStyle='rgba(0,0,0,.6)'; ctx.fillRect(bx,by2,bw,bh);
    const hf=p.hp/p.maxHp;
    ctx.fillStyle=hf>.6?'#00ff88':hf>.3?'#ffaa00':'#ff3355';
    ctx.fillRect(bx,by2,bw*hf,bh);
    // Energy bar
    const ebw=bw, ebh=3, ebx=bx, eby=by2+bh+2;
    ctx.fillStyle='rgba(0,0,0,.6)'; ctx.fillRect(ebx,eby,ebw,ebh);
    ctx.fillStyle='#ffaa00'; ctx.fillRect(ebx,eby,ebw*(p.energy/100),ebh);
    // Label
    ctx.fillStyle='#fff8'; ctx.font='9px Share Tech Mono'; ctx.textAlign='center';
    let label = p.name ? (p.isHuman ? 'YOU' : p.name) : (p.isHuman ? 'YOU' : CDEFS[p.cls].name);
    if(gs.teamMode){ const teamTag=p.team===1?'🔵':'🔴'; label=teamTag+' '+label; }
    ctx.fillText(label, 0,-p.radius-6);
    if(p.killStreak>=2){
      ctx.fillStyle=p.killStreak>=7?'#ffaa00':p.killStreak>=5?'#00ff88':p.killStreak>=3?'#ff4444':'#aaa';
      ctx.font='bold 8px Orbitron,monospace';
      ctx.fillText('🔥'+p.killStreak, 0,-p.radius-16);
    }
    ctx.restore();
    if(p.invisTimer>0&&p.isHuman) ctx.restore();
  }

  // Wards
  if(gs.wards){
    for(const w of gs.wards){
      ctx.save();
      ctx.globalAlpha=0.3;
      ctx.strokeStyle='#00ccff'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.arc(w.x,w.y,w.radius,0,Math.PI*2); ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha=0.8;
      ctx.fillStyle='#00ccff'; ctx.font='12px sans-serif'; ctx.textAlign='center';
      ctx.fillText('👁️',w.x,w.y+4);
      ctx.restore();
    }
  }

  } finally { ctx.restore(); }

  // Screen-space HUD bar
  const elapsed=(_frameTime-gs.startTime)/1000;
  const tf=Math.max(0,(gs.matchTime-elapsed)/gs.matchTime);
  ctx.fillStyle='#00f5ff'; ctx.fillRect(0,0,VW*tf,2);

  const pp=getLocalPlayer(gs);
  if(pp.alive && isInShopZone(pp,gs) && !gs.shopOpen){
    ctx.save(); ctx.fillStyle='rgba(255,170,0,.85)'; ctx.font='bold 14px Orbitron,monospace'; ctx.textAlign='center';
    ctx.fillText('Press [E] to open SHOP',VW/2,VH-60); ctx.restore();
  }

  // Minimap
  const mmW=140, mmH=100, mmX=VW-mmW-10, mmY=VH-mmH-10;
  ctx.fillStyle='rgba(5,8,16,.8)'; ctx.fillRect(mmX,mmY,mmW,mmH);
  ctx.strokeStyle='rgba(0,245,255,.25)'; ctx.lineWidth=1; ctx.strokeRect(mmX,mmY,mmW,mmH);
  ctx.drawImage(_getMinimapWallCache(gs.walls, mmW, mmH), mmX, mmY);
  const allShops2=gs.shopZones||[gs.shopZone];
  ctx.fillStyle='rgba(255,170,0,.6)';
  for(const sz2 of allShops2){ ctx.fillRect(mmX+sz2.x/W*mmW-2,mmY+sz2.y/H*mmH-2,5,5); }
  for(const camp of gs.camps){
    const allDead2=camp.mobs.every(m=>!m.alive);
    ctx.fillStyle=allDead2?'rgba(100,100,100,.3)':'rgba(255,100,50,.5)';
    ctx.beginPath(); ctx.arc(mmX+camp.x/W*mmW,mmY+camp.y/H*mmH,2,0,Math.PI*2); ctx.fill();
  }
  for(const pp2 of gs.players){
    if(!pp2.alive) continue;
    let mmColor=pp2.color;
    if(gs.teamMode) mmColor=pp2.team===1?TEAM_COLORS.blue:TEAM_COLORS.red;
    ctx.fillStyle=mmColor;
    ctx.beginPath(); ctx.arc(mmX+pp2.x/W*mmW,mmY+pp2.y/H*mmH,3,0,Math.PI*2); ctx.fill();
    if(pp2.isHuman){
      ctx.strokeStyle='#fff'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.arc(mmX+pp2.x/W*mmW,mmY+pp2.y/H*mmH,4,0,Math.PI*2); ctx.stroke();
    }
  }
  ctx.strokeStyle='rgba(255,255,255,.3)'; ctx.lineWidth=1;
  ctx.strokeRect(mmX+camX/W*mmW,mmY+camY/H*mmH,ZW/W*mmW,ZH/H*mmH);

  // ── VIGNETTE (cached) ──
  ctx.drawImage(getVignetteCache(), 0, 0);
}

// ── Player animation state detection ──
function getPlayerAnimState(p) {
  if (!p.alive) return 'dead';
  if (p.swordOn || p.novaOn || p.overchargeTimer > 0 || p.drainTimer > 0 || p.fortifyTimer > 0) return 'special';
  if (p.hookOn) return 'special';
  if (Math.abs(p.vx) > 20 || Math.abs(p.vy) > 20) return 'walk';
  return 'idle';
}

// ── Cached class circle textures — drawn once per class+color, reused every frame ──
// Used for the default circular player body so we never call createRadialGradient per-frame.
const _clsGradCache = {};
function _getClsCircle(cls, color, radius) {
  const key = cls + color + radius;
  if (_clsGradCache[key]) return _clsGradCache[key];
  const d = Math.ceil(radius * 2.6);
  const off = new OffscreenCanvas(d, d);
  const oc = off.getContext('2d');
  const cx = d / 2;
  const gr = oc.createRadialGradient(cx, cx, 0, cx, cx, radius);
  gr.addColorStop(0, '#fff');
  gr.addColorStop(0.45, color);
  gr.addColorStop(1, color + '66');
  oc.fillStyle = gr;
  oc.beginPath(); oc.arc(cx, cx, radius, 0, Math.PI * 2); oc.fill();
  oc.strokeStyle = '#fff5'; oc.lineWidth = 1.5;
  oc.beginPath(); oc.arc(cx, cx, radius, 0, Math.PI * 2); oc.stroke();
  _clsGradCache[key] = { off, d };
  return _clsGradCache[key];
}

// ── Player shape rendering ──
function renderPlayerShape(ctx, p, _gs){
  // Try sprite first — assigned in editor under "class_<cls>"
  if(typeof drawEntitySprite === 'function') {
    const size = p.radius * 2.4;
    if(drawEntitySprite(ctx, 'class_' + p.cls, size, getPlayerAnimState(p), p.angle)) return;
  }
  // No sprite assigned — fall back to hardcoded shapes below
  if(p.cls==='assassin'){
    ctx.fillStyle=p.color;
    ctx.beginPath();
    ctx.moveTo(0,-p.radius); ctx.lineTo(p.radius*.7,p.radius*.3);
    ctx.lineTo(0,p.radius*.6); ctx.lineTo(-p.radius*.7,p.radius*.3);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#fff6'; ctx.lineWidth=1.2; ctx.stroke();
  } else if(p.cls==='mage'){
    ctx.fillStyle=p.color;
    ctx.beginPath();
    for(let i=0;i<6;i++){
      const a=i*Math.PI/3+_frameTime*.0005;
      i===0?ctx.moveTo(Math.cos(a)*p.radius,Math.sin(a)*p.radius):ctx.lineTo(Math.cos(a)*p.radius,Math.sin(a)*p.radius);
    }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#fff4'; ctx.lineWidth=1.2; ctx.stroke();
  } else if(p.cls==='tank'){
    ctx.fillStyle=p.color;
    ctx.beginPath();
    for(let i=0;i<8;i++){
      const a=i*Math.PI/4;
      const r=p.radius*(i%2===0?1:0.85);
      i===0?ctx.moveTo(Math.cos(a)*r,Math.sin(a)*r):ctx.lineTo(Math.cos(a)*r,Math.sin(a)*r);
    }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#fff6'; ctx.lineWidth=2; ctx.stroke();
    if(p.fortifyTimer>0){
      ctx.save();
      const pulse=Math.sin(_frameTime/100)*0.3+0.5;
      ctx.strokeStyle='#00ff88'; ctx.lineWidth=4; ctx.globalAlpha=0.4+pulse*0.3;
      ctx.beginPath();ctx.arc(0,0,p.radius+14,0,Math.PI*2);ctx.stroke();
      ctx.restore();
    }
  } else if(p.cls==='necro'){
    const nTime=_frameTime;
    ctx.save();
    for(let wi=0;wi<3;wi++){
      const wa=nTime*0.002+wi*2.1;
      const wr=p.radius+8+Math.sin(nTime*0.003+wi)*5;
      ctx.globalAlpha=0.3+Math.sin(nTime*0.005+wi)*0.15;
      ctx.fillStyle='#aaffaa';
      ctx.beginPath();ctx.arc(Math.cos(wa)*wr,Math.sin(wa)*wr,2+Math.sin(nTime*0.004+wi),0,Math.PI*2);ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle=p.color;
    ctx.beginPath();
    for(let i=0;i<5;i++){
      const a=i*Math.PI*2/5-Math.PI/2+nTime*0.001;
      i===0?ctx.moveTo(Math.cos(a)*p.radius,Math.sin(a)*p.radius):ctx.lineTo(Math.cos(a)*p.radius,Math.sin(a)*p.radius);
    }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#aaffaa66'; ctx.lineWidth=1.5; ctx.stroke();
    if(p.drainTimer>0){
      ctx.save();
      const dt2=p.drainTimer/800;
      ctx.globalAlpha=0.15*dt2; ctx.fillStyle='#aaffaa';
      ctx.beginPath(); ctx.moveTo(0,0); ctx.arc(0,0,220,p.angle-0.65,p.angle+0.65); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    if(p.minions){
      for(const m of p.minions){
        if(!m.alive) continue;
        ctx.save(); ctx.translate(m.x-p.x, m.y-p.y);
        const spawnScale = m.spawnAnim > 0 ? 1.5 - m.spawnAnim * 0.5 : 1;
        ctx.scale(spawnScale, spawnScale);
        ctx.fillStyle='#aaffaa'; ctx.globalAlpha=0.85;
        ctx.beginPath();
        for(let si=0;si<3;si++){
          const sa=si*Math.PI*2/3-Math.PI/2+nTime*0.003;
          si===0?ctx.moveTo(Math.cos(sa)*(m.radius||8),Math.sin(sa)*(m.radius||8)):ctx.lineTo(Math.cos(sa)*(m.radius||8),Math.sin(sa)*(m.radius||8));
        }
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle='#88cc44'; ctx.lineWidth=1.5; ctx.stroke();
        ctx.shadowBlur=0;
        const mbw=16, mbh=3;
        ctx.globalAlpha=0.8;
        ctx.fillStyle='rgba(0,0,0,.7)'; ctx.fillRect(-mbw/2,-(m.radius||8)-6,mbw,mbh);
        ctx.fillStyle='#88cc44'; ctx.fillRect(-mbw/2,-(m.radius||8)-6,mbw*(m.hp/(m.maxHp||40)),mbh);
        ctx.restore();
      }
    }
  } else if(p.cls==='ranger'){
    const rTime=_frameTime;
    ctx.save();
    for(let wi=0;wi<2;wi++){
      const wa=rTime*0.003+wi*3.14;
      const wr=p.radius+6+Math.sin(rTime*0.004+wi)*4;
      ctx.globalAlpha=0.25+Math.sin(rTime*0.005+wi)*0.1;
      ctx.fillStyle='#ffcc66';
      ctx.beginPath();ctx.arc(Math.cos(wa)*wr,Math.sin(wa)*wr,2,0,Math.PI*2);ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle=p.color;
    ctx.beginPath();
    ctx.moveTo(0,-p.radius); ctx.lineTo(p.radius*0.65,0);
    ctx.lineTo(0,p.radius); ctx.lineTo(-p.radius*0.65,0);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#ffcc6666'; ctx.lineWidth=1.5; ctx.stroke();
    if(p.charging && p.chargeTimer>100){
      const chargePct=Math.min(1, p.chargeTimer/1200);
      const ca=p.chargeAngle||p.angle;
      const laserLen=400+chargePct*600;
      ctx.save();
      const pulse=Math.sin(_frameTime/60)*0.2+0.6;
      ctx.globalAlpha=0.15+chargePct*0.5*pulse;
      ctx.strokeStyle='#ff2222'; ctx.lineWidth=1+chargePct*4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(ca)*(p.radius+4),Math.sin(ca)*(p.radius+4));
      ctx.lineTo(Math.cos(ca)*laserLen,Math.sin(ca)*laserLen);
      ctx.stroke();
      ctx.globalAlpha=0.5+chargePct*0.4;
      ctx.strokeStyle=chargePct>=1?'#ffffff':'#ff4444'; ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(0,0,p.radius+22,-Math.PI/2,-Math.PI/2+chargePct*Math.PI*2);ctx.stroke();
      if(chargePct>=1){
        ctx.globalAlpha=0.4+Math.sin(_frameTime/80)*0.3;
        ctx.fillStyle='#ff2222';
        ctx.beginPath();ctx.arc(0,0,p.radius+6,0,Math.PI*2);ctx.fill();
      }
      ctx.restore();
    }
  } else {
    const c = _getClsCircle(p.cls, p.color, p.radius);
    ctx.drawImage(c.off, -c.d/2, -c.d/2, c.d, c.d);
  }
}
