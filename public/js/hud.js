// ═══════════════════════════════════════════════════════════════
// HUD.JS — Cyberpunk MOBA HUD
// ═══════════════════════════════════════════════════════════════

let _hudLastT = 0, _lastStreakHTML = null;

// Hoisted out of updateHUD — avoids allocating a new object every 16ms
const _CLS_MAP = {gunner:'cls-g',assassin:'cls-a',mage:'cls-m',tank:'cls-t',necro:'cls-n',ranger:'cls-r'};

// DOM refs cached once — getElementById is surprisingly expensive in hot loops
let _hEl = null;
function _hudEl() {
  if (_hEl) return _hEl;
  _hEl = {
    hpFill:    document.getElementById('hudHPFill'),
    hpText:    document.getElementById('hudHPText'),
    energyText:document.getElementById('hudEnergyText'),
    s1:        document.getElementById('hudS1'),
    s2:        document.getElementById('hudS2'),
    timer:     document.getElementById('hudTimer'),
    cls:       document.getElementById('hudCls'),
    streak:    document.getElementById('hudStreak'),
    itemsBar:  document.getElementById('itemsBar'),
    upgrades:  document.getElementById('hudUpgrades'),
    shopEnergy:document.getElementById('shopEnergy'),
    scoreboard:document.getElementById('hudScoreboard'),
  };
  return _hEl;
}
function updateHUD(){
  if(!gameState)return;
  const now=performance.now();
  if(now - _hudLastT < 16) return; // cap at ~60fps
  _hudLastT = now;
  const p=getLocalPlayer(gameState);
  const H=_hudEl();

  // HP bar (smooth fill)
  const hpPct = Math.max(0, p.hp / p.maxHp * 100);
  if(H.hpFill) H.hpFill.style.width = hpPct + '%';
  const hpStr = Math.max(0,Math.ceil(p.hp)) + ' / ' + p.maxHp;
  if(H.hpText && H.hpText.textContent !== hpStr) H.hpText.textContent = hpStr;

  // Energy bar
  const enStr = String(Math.floor(p.energy));
  if(H.energyText && H.energyText.textContent !== enStr) H.energyText.textContent = enStr;

  // Score
  if(playMode==='online' && typeof gameState.score === 'object' && !Array.isArray(gameState.score)){
    const myScore = gameState.score[myPlayerId] || 0;
    const scores = Object.entries(gameState.score).map(([id,s])=>({id:parseInt(id),s})).sort((a,b)=>b.s-a.s);
    H.s1.textContent='YOU:'+myScore;
    H.s2.textContent=scores.length>0?('#1:'+scores[0].s):'';
  } else if(gameState.teamMode){
    H.s1.textContent='🔵'+gameState.score[0];
    H.s2.textContent='🔴'+gameState.score[1];
  } else {
    H.s1.textContent=gameState.score[0];
    H.s2.textContent=gameState.score[1];
  }

  const rem=Math.max(0,gameState.matchTime-(now-gameState.startTime)/1000);
  const mins = Math.floor(rem/60);
  const secs = Math.ceil(rem%60);
  H.timer.textContent=mins+':'+(secs<10?'0':'')+secs;

  const cb=H.cls;
  const clsName=CDEFS[p.cls].name;
  if(cb.textContent!==clsName) cb.textContent=clsName;
  const clsClass='hud-cls '+_CLS_MAP[p.cls];
  if(cb.className!==clsClass) cb.className=clsClass;

  // Streak — build string first, only write DOM if it changed (avoids emoji reflow every frame)
  const streakEl=H.streak;
  let newStreakHTML='';
  if(p.killStreak>=2){
    const streakCol=p.killStreak>=7?'var(--amber)':p.killStreak>=5?'var(--green)':p.killStreak>=3?'var(--red)':'var(--dim)';
    newStreakHTML=`<div style="font-size:10px;color:${streakCol};font-family:Orbitron,monospace;letter-spacing:1px">🔥 STREAK: ${p.killStreak}</div>`;
    let bonuses='';
    if(p.streakDmgTimer>0) bonuses+=`<span style="color:var(--red);font-size:9px">+DMG ${(p.streakDmgTimer/1000).toFixed(1)}s</span> `;
    if(p.streakSpdTimer>0) bonuses+=`<span style="color:var(--green);font-size:9px">+SPD ${(p.streakSpdTimer/1000).toFixed(1)}s</span>`;
    if(bonuses) newStreakHTML+=`<div>${bonuses}</div>`;
  }
  if(newStreakHTML !== _lastStreakHTML){ streakEl.innerHTML=newStreakHTML; _lastStreakHTML=newStreakHTML; }

  // Ability bar cooldowns
  const effDcd=p.dashCd*(p.upgrades.fastDash ? 0.6 : 1);
  const dr=Math.max(0,effDcd-(now-p.lastDash));
  const sr=Math.max(0,p.spCd-(now-p.lastSp));
  const d=CDEFS[p.cls];
  const fr2=p.upgrades.rapidFire?d.fireRate*.58:p.upgrades.heavy?d.fireRate*1.8:d.fireRate;
  const ar=Math.max(0,fr2-(now-p.lastShot));

  const secr = Math.max(0, (p.secCd||7000) - (now - (p.lastSec||-9999)));
  updateAbiSlot('abiAtk', ABI_ICONS[p.cls]?.atk||'🔫', ar, fr2);
  updateAbiSlot('abiDash', '💨', dr, effDcd);
  updateAbiSlot('abiSec', ABI_ICONS[p.cls]?.sec||'💥', secr, p.secCd||7000);
  updateAbiSlot('abiSpec', ABI_ICONS[p.cls]?.spec||'⚡', sr, p.spCd);
  
  const ur=Math.max(0,p.ultCd-(now-p.lastUlt));
  const abiUlt=document.getElementById('abiUlt');
  updateAbiSlot('abiUlt', ABI_ICONS[p.cls]?.ult||'🔥', ur, p.ultCd);
  if(p.overchargeTimer>0||p.smokeTimer>0||p.barrierOn){
    abiUlt.classList.add('abi-active');
  }

  // Items bar — only rebuild DOM when upgrades change
  const ib=H.itemsBar;
  const owned=Object.keys(p.upgrades);
  const upgradeKey = owned.join(',');
  if(ib._lastUpgradeKey !== upgradeKey){
    ib._lastUpgradeKey = upgradeKey;
    ib.innerHTML='';
    for(let i=0;i<MAX_ITEMS;i++){
      const div=document.createElement('div');
      div.className='item-slot';
      if(i<owned.length){
        const uid=owned[i];
        const u=ALL_UPS.find(x=>x.id===uid);
        const cat=UPS.O.find(x=>x.id===uid)?'o':UPS.D.find(x=>x.id===uid)?'d':'m';
        div.className='item-slot item-owned';
        const catColor=cat==='o'?'var(--red)':cat==='d'?'var(--cyan)':'var(--green)';
        div.style.borderColor=catColor;
        div.innerHTML=`<span class="item-icon">${ITEM_ICONS[uid]||'✦'}</span>`;
        div.title=u?u.name+': '+u.desc:'';
      } else {
        div.style.color='var(--dim)';
        div.style.fontSize='8px';
        div.textContent='—';
      }
      ib.appendChild(div);
    }
  }

  if(gameState.shopOpen && H.shopEnergy) H.shopEnergy.textContent=Math.floor(p.energy);
  updateConsumableBar(p);
  
  // Scoreboard (3v3 / team)
  updateScoreboard();
}

const _abiCache = {};
function _getAbiRefs(id) {
  if (_abiCache[id]) return _abiCache[id];
  const el = document.getElementById(id);
  if (!el) return null;
  _abiCache[id] = { el, icon: el.querySelector('.abi-icon'), overlay: el.querySelector('.abi-cd-overlay'), cd: el.querySelector('.abi-cd') };
  return _abiCache[id];
}

function updateAbiSlot(id, icon, remaining, total){
  const r = _getAbiRefs(id);
  if(!r) return;
  if(r.icon && r.icon.textContent !== icon) r.icon.textContent = icon;

  if(remaining <= 0){
    r.el.classList.add('abi-ready');
    r.el.classList.remove('abi-active');
    if(r.overlay) r.overlay.style.height = '0%';
    if(r.cd && r.cd.textContent) r.cd.textContent = '';
  } else {
    r.el.classList.remove('abi-ready');
    const pct = Math.min(100, (remaining / total) * 100);
    if(r.overlay) r.overlay.style.height = pct + '%';
    const cdStr = (remaining/1000).toFixed(1);
    if(r.cd && r.cd.textContent !== cdStr) r.cd.textContent = cdStr;
  }
}

let _sbLastT = 0;
function updateScoreboard(){
  const sb = H.scoreboard;
  if(!sb || !gameState) return;
  const _sbNow = performance.now();
  if(_sbNow - _sbLastT < 66) return; // ~15fps
  _sbLastT = _sbNow;
  sb.innerHTML = '';
  
  const players = [...gameState.players].sort((a,b) => {
    if(gameState.teamMode) return a.team - b.team;
    return (b.killStreak||0) - (a.killStreak||0);
  });
  
  for(const p of players){
    const row = document.createElement('div');
    row.className = 'sb-row' + (p.isHuman ? ' sb-you' : '') + (!p.alive ? ' sb-dead' : '');
    const teamIcon = gameState.teamMode ? (p.team===1?'🔵':'🔴') : '';
    const name = p.isHuman ? 'YOU' : (p.name || CDEFS[p.cls]?.name || 'BOT');
    const clsIcon = {gunner:'🔫',assassin:'⚔️',mage:'🔮',tank:'🛡',necro:'💀',ranger:'🏹'}[p.cls]||'?';
    row.innerHTML = `<span class="sb-team">${teamIcon}</span><span class="sb-icon">${clsIcon}</span><span class="sb-name" style="color:${p.color}">${name}</span><span class="sb-kills">${p.killStreak||0}🔥</span><span class="sb-hp">${Math.ceil(p.hp)}♥</span>`;
    sb.appendChild(row);
  }
}

function kfAdd(wc,lc,wcls,lcls,wTeam,lTeam){
  const feed=document.getElementById('killfeed');
  const icons={gunner:'🔫',assassin:'⚔️',mage:'🔮',tank:'🛡',necro:'💀',ranger:'🏹'};
  const div=document.createElement('div'); div.className='kf-entry';
  const wTeamIcon=wTeam?`<span style="color:${wTeam}">●</span>`:'';
  const lTeamIcon=lTeam?`<span style="color:${lTeam}">●</span>`:'';
  div.innerHTML=`${wTeamIcon}<span style="color:${wc}">${icons[wcls]}</span> ELIMINATED ${lTeamIcon}<span style="color:${lc}">${icons[lcls]}</span>`;
  feed.appendChild(div);
  setTimeout(()=>div.classList.add('fade'),2500);
  setTimeout(()=>div.remove(),4500);
  if(feed.children.length>6) feed.firstChild.remove();
}

function addKillfeed(a,b,c){ /* handled by kfAdd */ }
function addCombo(){ registerComboKill(); }