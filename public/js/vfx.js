// ═══════════════════════════════════════════════════════════════
// VFX.JS — Visual effects, particles, screen shake/flash
// ═══════════════════════════════════════════════════════════════

// ── SCREEN SHAKE ──
let shakeIntensity=0, shakeDecay=0.92;

function addScreenShake(intensity) {
  shakeIntensity = Math.max(shakeIntensity, intensity);
}

function updateScreenShake(dt) {
  if (shakeIntensity > 0) {
    shakeIntensity *= shakeDecay;
    if (shakeIntensity < 0.1) shakeIntensity = 0;
  }
}

// ── SCREEN FLASH (disabled for performance) ──
let screenFlashTimer=0, screenFlashColor='#ff3355';
function triggerScreenFlash(color,duration){ /* disabled */ }
function updateScreenFlashTimer(dt){ /* disabled */ }

// ── IMPACT RINGS (object pool) ──
const MAX_IMPACT_RINGS = 16;
const impactRings = [];
for (let _i = 0; _i < MAX_IMPACT_RINGS; _i++) impactRings.push({x:0,y:0,r:0,maxR:0,color:'#ff3355',life:0});

function addImpactRing(x,y,color,maxR){
  for(let i=0;i<impactRings.length;i++){
    if(impactRings[i].life<=0){
      const r=impactRings[i];
      r.x=x; r.y=y; r.r=10; r.maxR=maxR||120; r.color=color||'#ff3355'; r.life=1;
      return;
    }
  }
}
function updateImpactRings(dt){
  for(let i=0;i<impactRings.length;i++){
    if(impactRings[i].life<=0) continue;
    const ring=impactRings[i];
    ring.life-=dt*2.5;
    ring.r+=(ring.maxR-ring.r)*dt*6;
    if(ring.life<0) ring.life=0;
  }
}

// ── MINION SLASH VFX (object pool) ──
const MAX_MINION_SLASHES = 12;
const minionSlashes = [];
for (let _i = 0; _i < MAX_MINION_SLASHES; _i++) minionSlashes.push({x:0,y:0,angle:0,life:0,maxLife:0.35});

function addMinionSlash(tx, ty, mx, my) {
  const angle = Math.atan2(ty - my, tx - mx);
  for(let i=0;i<minionSlashes.length;i++){
    if(minionSlashes[i].life<=0){
      const s=minionSlashes[i];
      s.x=tx; s.y=ty; s.angle=angle; s.life=0.35; s.maxLife=0.35;
      return;
    }
  }
}
function updateMinionSlashes(dt) {
  for(let i=0;i<minionSlashes.length;i++){
    if(minionSlashes[i].life<=0) continue;
    minionSlashes[i].life -= dt;
    if(minionSlashes[i].life<0) minionSlashes[i].life=0;
  }
}
function drawMinionSlashes(ctx, camX, camY) {
  for (const s of minionSlashes) {
    const sx = s.x - camX, sy = s.y - camY;
    const t = 1 - s.life / s.maxLife;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(s.angle);
    ctx.globalAlpha = (1 - t) * 0.9;
    for (let i = -1; i <= 1; i++) {
      const offset = i * 0.4;
      const arcR = 18 + t * 15;
      ctx.strokeStyle = i === 0 ? '#ccffcc' : '#88cc44';
      ctx.lineWidth = i === 0 ? 3 : 2;
      ctx.shadowColor = '#88cc44';
      ctx.shadowBlur = i === 0 ? 12 : 6;
      ctx.beginPath();
      ctx.arc(0, 0, arcR, -0.8 + offset + t * 0.3, 0.8 + offset - t * 0.3);
      ctx.stroke();
    }
    if (t < 0.3) {
      ctx.globalAlpha = (1 - t / 0.3) * 0.6;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(0, 0, 6 * (1 - t), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}

// ── DAMAGE NUMBERS (object pool — no splice/push after warm-up) ──
const MAX_DMG_NUMBERS = 40;
let dmgNumbers = [];
function _dmgPoolAdd(worldX, worldY, text, color, life, vy, vx, size, isCrit, isHeal) {
  for (let i = 0; i < dmgNumbers.length; i++) {
    if (dmgNumbers[i].life <= 0) {
      const d = dmgNumbers[i];
      d.x=worldX; d.y=worldY; d.text=text; d.color=color;
      d.life=life; d.vy=vy; d.vx=vx; d.size=size; d.isCrit=!!isCrit; d.isHeal=!!isHeal;
      return;
    }
  }
  if (dmgNumbers.length < MAX_DMG_NUMBERS)
    dmgNumbers.push({x:worldX,y:worldY,text,color,life,vy,vx,size,isCrit:!!isCrit,isHeal:!!isHeal});
}
function addDmgNumber(worldX, worldY, dmg, color, isCrit) {
  _dmgPoolAdd(worldX, worldY, (isCrit ? '💥 ' : '') + dmg, color||'#ff3355', 1.4,
    isCrit ? -120-Math.random()*50 : -80-Math.random()*40, (Math.random()-0.5)*60,
    isCrit?28:16, isCrit, false);
}
function addHealNumber(worldX, worldY, amount) {
  _dmgPoolAdd(worldX, worldY, '+'+amount, '#00ff88', 1.2,
    -70-Math.random()*30, (Math.random()-0.5)*40, amount>=30?20:16, false, true);
}
function updateDmgNumbers(dt) {
  for (let i = 0; i < dmgNumbers.length; i++) {
    const d = dmgNumbers[i];
    if (d.life <= 0) continue;
    d.life -= dt;
    d.y += d.vy * dt;
    d.x += d.vx * dt;
    d.vy *= 0.95;
    if (d.life < 0) d.life = 0;
  }
}

// ── CENTER ALERT (hooked, taunted, etc.) ──
let _centerAlertTimer = null;
function showCenterAlert(text, color, ms) {
  let el = document.getElementById('centerAlert');
  if (!el) {
    el = document.createElement('div');
    el.id = 'centerAlert';
    el.style.cssText = 'position:fixed;top:38%;left:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:999;text-align:center;';
    document.body.appendChild(el);
  }
  el.innerHTML = `<div style="
    font-family:'Orbitron',monospace;
    font-size:28px;
    font-weight:900;
    color:${color||'#00f5ff'};
    text-shadow:0 0 24px ${color||'#00f5ff'},0 0 48px ${color||'#00f5ff'};
    letter-spacing:4px;
    animation:centerAlertAnim ${(ms||1400)/1000}s ease-out forwards;
    white-space:nowrap;
  ">${text}</div>`;
  if (_centerAlertTimer) clearTimeout(_centerAlertTimer);
  _centerAlertTimer = setTimeout(() => { if(el) el.innerHTML=''; }, ms||1400);
}
// Inject keyframes once
(function(){
  if(document.getElementById('_centerAlertStyle')) return;
  const s = document.createElement('style');
  s.id='_centerAlertStyle';
  s.textContent='@keyframes centerAlertAnim{0%{opacity:0;transform:scale(.7)}15%{opacity:1;transform:scale(1.12)}30%{transform:scale(1)}80%{opacity:1}100%{opacity:0;transform:scale(1.05) translateY(-20px)}}';
  document.head.appendChild(s);
})();

// ── STREAK POPUP ──
function showStreakPopup(name, streak) {
  const container = document.getElementById('streakPopup');
  if (!container) return;
  container.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'streak-announce' + (streak >= 7 ? ' godlike' : '');
  div.textContent = ''; // avoid innerHTML parse cost; build via DOM
  const t1 = document.createElement('div'); t1.className = 'streak-text'; t1.textContent = name;
  const t2 = document.createElement('div'); t2.className = 'streak-sub'; t2.textContent = '🔥 ' + streak + ' KILL STREAK 🔥';
  div.appendChild(t1); div.appendChild(t2);
  container.appendChild(div);
  setTimeout(() => { if (div.parentNode) div.parentNode.removeChild(div); }, 2500);
}

// ── COMBO COUNTER ──
let comboCount=0, comboTimer=0, comboDecay=4;
let comboMultiplier=1;
function registerComboKill(){
  comboCount++;
  comboTimer=comboDecay;
  comboMultiplier=1+comboCount*0.15;
  const el=document.getElementById('comboDisplay');
  if(comboCount>=2){
    el.innerHTML=`<div class="combo-text" style="color:${comboCount>=5?'#ffaa00':comboCount>=3?'#ff3355':'#ff00aa'}">${comboCount}× COMBO</div>
      <div class="combo-sub">+${Math.round((comboMultiplier-1)*100)}% DAMAGE</div>`;
  }
}
function updateCombo(dt){
  if(comboTimer>0){
    comboTimer-=dt;
    if(comboTimer<=0){
      comboCount=0; comboMultiplier=1;
      const el=document.getElementById('comboDisplay');
      if(el.innerHTML) el.style.animation='comboFade 0.5s ease-out forwards';
      setTimeout(()=>{const e=document.getElementById('comboDisplay');if(e){e.innerHTML='';e.style.animation='';}},500);
    }
  }
}

// ── GOLD FLOAT ANIMATIONS (object pool) ──
const MAX_GOLD_FLOATS = 24;
let goldFloats=[];
function addGoldFloat(worldX,worldY,amount){
  const text='+'+amount+'g', size=amount>=100?20:amount>=50?16:14;
  for(let i=0;i<goldFloats.length;i++){
    if(goldFloats[i].life<=0){
      const g=goldFloats[i]; g.x=worldX; g.y=worldY; g.text=text; g.life=1.5; g.vy=-60; g.size=size; return;
    }
  }
  if(goldFloats.length<MAX_GOLD_FLOATS) goldFloats.push({x:worldX,y:worldY,text,life:1.5,vy:-60,size});
  if(gameState) sparks(gameState,worldX,worldY,'#ffcc00',4,60);
}
function updateGoldFloats(dt){
  for(let i=0;i<goldFloats.length;i++){
    const g=goldFloats[i];
    if(g.life<=0) continue;
    g.life-=dt; g.y+=g.vy*dt; g.vy*=0.95;
    if(g.life<0) g.life=0;
  }
}

// ── UPGRADE FANFARE ──
function showUpgradeFanfare(name,icon){
  const el=document.getElementById('upgradeFanfare');
  el.innerHTML=`<div class="fanfare-text">⬆ UPGRADED</div><div class="fanfare-sub">${icon||'✦'} ${name}</div>`;
  triggerScreenFlash('#00ff88',0.2);
  shakeIntensity=Math.max(shakeIntensity,5);
  setTimeout(()=>{const e=document.getElementById('upgradeFanfare');if(e)e.innerHTML='';},2200);
}

// ── PARTICLES ── (object pool — no splice/push after warm-up, zero GC)
const MAX_PARTICLES = 600; // raised for 5v5 teamfights
function sparks(gs,x,y,col,n,spd){
  const count = Math.min(n, MAX_PARTICLES);
  let added = 0;
  // Reuse dead slots first — avoids allocating new objects
  for(let i=0; i<gs.particles.length && added<count; i++){
    if(gs.particles[i].life<=0){
      const a=Math.random()*Math.PI*2, s=Math.random()*spd, p=gs.particles[i];
      p.x=x; p.y=y; p.vx=Math.cos(a)*s; p.vy=Math.sin(a)*s;
      p.life=1; p.ml=.3+Math.random()*.5; p.col=col; p.sz=1+Math.random()*3;
      added++;
    }
  }
  // Allocate new slots while under the cap
  while(added<count && gs.particles.length<MAX_PARTICLES){
    const a=Math.random()*Math.PI*2, s=Math.random()*spd;
    gs.particles.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life:1,ml:.3+Math.random()*.5,col,sz:1+Math.random()*3});
    added++;
  }
  // Pool full — evict particle with lowest remaining life to make room
  if(added<count && gs.particles.length>=MAX_PARTICLES){
    let minIdx=0, minLife=gs.particles[0].life;
    for(let i=1;i<gs.particles.length;i++){ if(gs.particles[i].life<minLife){minLife=gs.particles[i].life;minIdx=i;} }
    const a=Math.random()*Math.PI*2, s=Math.random()*spd, p=gs.particles[minIdx];
    p.x=x; p.y=y; p.vx=Math.cos(a)*s; p.vy=Math.sin(a)*s;
    p.life=1; p.ml=.3+Math.random()*.5; p.col=col; p.sz=1+Math.random()*3;
  }
}
function updParticles(gs,dt){
  for(let i=0;i<gs.particles.length;i++){
    const p=gs.particles[i];
    if(p.life<=0) continue; // dead slot — skip, will be recycled by sparks()
    if(p.ml) p.life-=dt/p.ml; else p.life-=dt; // sparks use ml; smoke/other direct-push use linear decay
    p.x+=p.vx*dt; p.y+=p.vy*dt; p.vx*=.90; p.vy*=.90;
    if(p.life<0) p.life=0;
  }
}

// ── DASH TRAILS (object pool — max 24 slots, no allocation after warm-up) ──
const MAX_DASH_TRAILS = 24;
function addDashTrail(gs,x1,y1,x2,y2,color){
  // Reuse a dead slot first
  for(let i=0;i<gs.dashTrails.length;i++){
    if(gs.dashTrails[i].life<=0){
      const t=gs.dashTrails[i];
      t.x1=x1;t.y1=y1;t.x2=x2;t.y2=y2;t.color=color;t.life=1;t.ml=0.4;
      return;
    }
  }
  if(gs.dashTrails.length<MAX_DASH_TRAILS) gs.dashTrails.push({x1,y1,x2,y2,color,life:1,ml:0.4});
}
function updDashTrails(gs,dt){
  for(let i=0;i<gs.dashTrails.length;i++){
    if(gs.dashTrails[i].life<=0) continue;
    gs.dashTrails[i].life-=dt/gs.dashTrails[i].ml;
    if(gs.dashTrails[i].life<0) gs.dashTrails[i].life=0;
  }
}

// Streak helpers moved to engine.js
