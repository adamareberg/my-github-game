// ═══════════════════════════════════════════════════════════════
// SHOP.JS — MOBA-style shop UI
// ═══════════════════════════════════════════════════════════════

let currentShopCat = 'all';
let selectedShopItem = null; // { id, isConsumable }

// ── Category meta ──────────────────────────────────────────────
const SHOP_CATS = {
  offense:  { label:'OFFENSE',  color:'var(--red)',    stripe:'stripe-offense',  tag:'tag-offense'  },
  defense:  { label:'DEFENSE',  color:'var(--cyan)',   stripe:'stripe-defense',  tag:'tag-defense'  },
  mobility: { label:'MOBILITY', color:'var(--green)',  stripe:'stripe-mobility', tag:'tag-mobility' },
  combat:   { label:'COMBAT',   color:'#ff8833',       stripe:'stripe-combat',   tag:'tag-combat'   },
  utility:  { label:'UTILITY',  color:'var(--purple)', stripe:'stripe-utility',  tag:'tag-utility'  },
};

// Map upgrade category keys to SHOP_CATS keys
const UPS_CAT_MAP = { O:'offense', D:'defense', M:'mobility' };

// Extra stat lines shown in detail panel per upgrade id
const ITEM_STATS = {
  rapidFire:  [['Fire rate','+50%'],['Bullet cd','−50%']],
  doubleShot: [['Shots/burst','×2'],['Spread','±8°']],
  pierce:     [['Penetration','∞'],['Damage falloff','none']],
  homing:     [['Seek radius','120'],['Turn rate','medium']],
  heavy:      [['Damage','+35%'],['Bullet size','+40%']],
  critStrike: [['Crit chance','25%'],['Crit multiplier','×2']],
  projSpeed:  [['Bullet speed','+60%'],['Range','+40%']],
  shield:     [['Shield HP','30'],['Absorbs','1 hit']],
  regen:      [['Regen rate','3 HP/s'],['Out-of-combat','×2']],
  armor:      [['Damage reduction','15%'],['Applies to','all dmg']],
  fortify:    [['Max HP','+50'],['Current HP','+50']],
  thornmail:  [['Reflect','20% dmg'],['Trigger','any hit']],
  vitality:   [['Max HP','+30'],['Current HP','+30']],
  speed:      [['Move speed','+18%']],
  fastDash:   [['Dash cooldown','−35%'],['Dash speed','+20%']],
  teleport:   [['Teleport range','full map'],['Cooldown','12s']],
  boots:      [['Move speed','+12%'],['Slow resist','30%']],
  momentum:   [['Speed ramp','on kill'],['Duration','4s']],
  phaseWalk:  [['Phase','+30%'],['Dodge window','0.2s']],
};

const CONS_STATS = {
  healthPot:  [['Heal','50 HP'],['Instant','yes']],
  dmgBoost:   [['Damage','+40%'],['Duration','6s']],
  speedBoost: [['Speed','+50%'],['Duration','5s']],
  invulnPot:  [['Invincible','2s'],['Cooldown','—']],
  grenade:    [['AoE damage','40'],['Blast radius','80']],
  smokeBomb:  [['Invisibility','3s'],['Breaks on atk','yes']],
  wardStone:  [['Vision radius','180'],['Duration','30s']],
  manaPot:    [['Energy','+ 40'],['Instant','yes']],
  adrenaline: [['Cooldowns','−50%'],['Duration','6s']],
  teleScroll: [['Teleport','base/tower'],['Cooldown','—']],
};

// ── Open / Close ───────────────────────────────────────────────
function openShop(){
  gameState.shopOpen = true;
  selectedShopItem = null;
  renderShop();
  document.getElementById('shopScreen').classList.remove('hidden');
}
function closeShop(){
  gameState.shopOpen = false;
  document.getElementById('shopScreen').classList.add('hidden');
}

// ── Category selection ─────────────────────────────────────────
function selectShopCat(cat){
  currentShopCat = cat;
  document.querySelectorAll('.scat-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('scat-'+cat);
  if(btn) btn.classList.add('active');
  renderShopGrid();
}

// ── Legacy compat for engine.js calls ─────────────────────────
function switchShopTab(tab){ selectShopCat(tab); }
function tryShop(){
  if(!gameState||gameState.gameOver) return;
  if(gameState.shopOpen){ closeShop(); return; }
  const p = getLocalPlayer(gameState);
  if(isInShopZone(p, gameState)) openShop();
}

// ── Main render ────────────────────────────────────────────────
function renderShop(){
  const p = getLocalPlayer(gameState);
  if(!p) return;

  // Header energy + inventory count
  const energy = Math.floor(p.energy);
  const el = document.getElementById('shopEnergy');
  if(el) el.textContent = energy;

  const ownedCount = Object.keys(p.upgrades||{}).length;
  const invEl = document.getElementById('shopInventory');
  if(invEl){
    invEl.textContent = 'UPGRADES: '+ownedCount+' / '+MAX_ITEMS;
    invEl.className = ownedCount >= MAX_ITEMS ? 'full' : '';
  }

  renderShopGrid();
  renderShopOwnedFooter(p);

  // Re-render detail panel with fresh state if an item was already selected
  if(selectedShopItem){
    const freshItem = _buildFreshItem(selectedShopItem.id, selectedShopItem.isConsumable, p);
    if(freshItem){
      selectedShopItem = freshItem;
      showShopDetail(freshItem, p);
    }
  }
  refreshBuyButton(p);
}

// ── Grid ───────────────────────────────────────────────────────
function renderShopGrid(){
  const p = getLocalPlayer(gameState);
  const grid = document.getElementById('shopItemGrid');
  if(!grid || !p) return;
  grid.innerHTML = '';

  const cat = currentShopCat;
  const ownedCount = Object.keys(p.upgrades||{}).length;
  const isPractice = typeof practiceMode !== 'undefined' && practiceMode;

  // Build list of all items to show
  const sections = [];

  if(cat === 'all' || cat === 'offense' || cat === 'defense' || cat === 'mobility'){
    ['O','D','M'].forEach(k => {
      const catKey = UPS_CAT_MAP[k];
      if(cat !== 'all' && cat !== catKey) return;
      const meta = SHOP_CATS[catKey];
      sections.push({
        label: meta.label+' UPGRADES',
        color: meta.color,
        items: UPS[k].map(u => ({
          id: u.id,
          name: u.name,
          icon: ITEM_ICONS[u.id]||'✦',
          cost: u.cost,
          desc: u.desc,
          cat: catKey,
          isConsumable: false,
          owned: !!p.upgrades[u.id],
          canAfford: isPractice || p.energy >= u.cost,
          full: ownedCount >= MAX_ITEMS && !p.upgrades[u.id],
        }))
      });
    });
  }

  if(cat === 'all' || cat === 'combat' || cat === 'utility'){
    const cons = p.consumables || [null,null,null,null,null];
    ['combat','utility'].forEach(ck => {
      if(cat !== 'all' && cat !== ck) return;
      const meta = SHOP_CATS[ck];
      const items = Object.entries(CONS_DEFS)
        .filter(([,c]) => c.cat === ck)
        .map(([id,c]) => {
          const existingSlot = cons.findIndex(s=>s&&s.id===id&&s.count<c.maxStack);
          const emptySlot = cons.findIndex(s=>!s);
          const canBuy = existingSlot >= 0 || emptySlot >= 0;
          const curCount = cons.filter(s=>s&&s.id===id).reduce((a,s)=>a+(s.count||0),0);
          return {
            id, name: c.name, icon: c.icon, cost: c.cost, desc: c.desc,
            cat: ck, isConsumable: true,
            owned: false, stackCount: curCount,
            canAfford: isPractice || p.energy >= c.cost,
            full: !canBuy,
            maxStack: c.maxStack,
          };
        });
      sections.push({ label: meta.label.toUpperCase()+' ITEMS', color: meta.color, items });
    });
  }

  if(cat === 'owned'){
    const owned = [];
    ['O','D','M'].forEach(k=>{
      UPS[k].forEach(u=>{
        if(p.upgrades[u.id]) owned.push({
          id:u.id, name:u.name, icon:ITEM_ICONS[u.id]||'✦', cost:u.cost, desc:u.desc,
          cat:UPS_CAT_MAP[k], isConsumable:false, owned:true, canAfford:true, full:false
        });
      });
    });
    sections.push({ label:'OWNED UPGRADES', color:'var(--green)', items: owned });
  }

  // Render sections
  sections.forEach(sec => {
    if(!sec.items.length) return;
    const lbl = document.createElement('div');
    lbl.className = 'shop-section-label';
    lbl.style.color = sec.color;
    lbl.textContent = sec.label;
    grid.appendChild(lbl);

    const row = document.createElement('div');
    row.className = 'shop-items-row';

    sec.items.forEach(item => {
      const card = document.createElement('div');
      card.className = 'shop-item'
        + (item.owned ? ' si-owned' : '')
        + (!item.canAfford || item.full ? ' si-cant' : '')
        + (selectedShopItem && selectedShopItem.id === item.id ? ' si-selected' : '');

      const stripe = SHOP_CATS[item.cat]?.stripe || '';
      const stackBadge = item.isConsumable && item.stackCount > 0
        ? `<span class="si-stack-badge">×${item.stackCount}</span>` : '';
      const ownedBadge = item.owned ? `<span class="si-owned-badge">✓</span>` : '';
      const costText = item.owned ? '—' : (isPractice ? 'FREE' : item.cost+' E');

      card.innerHTML = `
        <div class="si-icon-wrap">
          ${stackBadge}${ownedBadge}
          <span style="position:relative;z-index:1">${item.icon}</span>
          <div class="si-cat-stripe ${stripe}"></div>
        </div>
        <div class="si-name">${item.name}</div>
        <div class="si-cost"><span class="ci-e">${item.owned?'':'⚡'}</span>${costText}</div>`;

      // Hover → detail panel
      card.addEventListener('mouseenter', () => {
        showShopDetail(item, p);
        // Highlight selected
        document.querySelectorAll('.shop-item').forEach(c=>c.classList.remove('si-selected'));
        card.classList.add('si-selected');
        selectedShopItem = item;
        refreshBuyButton(p);
      });

      // Click = buy
      if(!item.owned && item.canAfford && !item.full){
        card.addEventListener('click', () => doBuyItem(item, p));
      }
      row.appendChild(card);
    });
    grid.appendChild(row);
  });

  if(!grid.children.length){
    grid.innerHTML = '<div style="font-size:11px;color:var(--dim);padding:30px;font-family:Orbitron,monospace;letter-spacing:1px">NOTHING HERE</div>';
  }
}

// ── Detail panel ───────────────────────────────────────────────
function showShopDetail(item, p){
  const inner = document.getElementById('shopDetailInner');
  if(!inner) return;
  const meta = SHOP_CATS[item.cat] || {};
  const isPractice = typeof practiceMode !== 'undefined' && practiceMode;
  // Fresh ownership check
  const isOwned = !item.isConsumable && !!p.upgrades[item.id];
  const cantAfford = !isPractice && !isOwned && p.energy < item.cost;
  const statRows = (item.isConsumable ? CONS_STATS[item.id] : ITEM_STATS[item.id]) || [];

  inner.innerHTML = `
    <div class="sd-icon">${item.icon}</div>
    <span class="sd-cat-tag ${meta.tag||''}">${meta.label||item.cat}</span>
    <div class="sd-name">${item.name}</div>
    <div class="sd-desc">${item.desc}</div>
    ${statRows.length ? `<div class="sd-stats">${statRows.map(([k,v])=>`
      <div class="sd-stat-row">
        <span class="sd-stat-key">${k}</span>
        <span class="sd-stat-val" style="color:${meta.color||'var(--amber)'}">${v}</span>
      </div>`).join('')}</div>` : ''}
    <div class="sd-cost-row ${cantAfford?'cant-afford':''}">
      <span class="sd-cost-e">⚡</span>
      <span class="sd-cost-val">${isOwned ? '—' : (isPractice ? 'FREE' : item.cost)}</span>
      <span class="sd-cost-lbl">${isOwned ? 'OWNED' : 'ENERGY'}</span>
    </div>`;
}

function refreshBuyButton(p){
  const btn = document.getElementById('shopBuyBtn');
  if(!btn) return;
  const item = selectedShopItem;
  if(!item){ btn.textContent = 'SELECT AN ITEM'; btn.disabled = true; btn.className=''; return; }

  const isPractice = typeof practiceMode !== 'undefined' && practiceMode;
  const ownedCount = Object.keys(p.upgrades||{}).length;

  // Always check FRESH ownership from player state, not cached item.owned
  const isOwned = !item.isConsumable && !!p.upgrades[item.id];
  if(isOwned){
    btn.textContent = '✓ OWNED';
    btn.disabled = true;
    btn.className = 'owned-btn';
    return;
  }
  if(!item.isConsumable && ownedCount >= MAX_ITEMS){
    btn.textContent = 'INVENTORY FULL';
    btn.disabled = true; btn.className = '';
    return;
  }
  if(item.isConsumable && item.full){
    btn.textContent = 'SLOTS FULL';
    btn.disabled = true; btn.className = '';
    return;
  }
  const cantAfford = !isPractice && p.energy < item.cost;
  if(cantAfford){
    btn.textContent = 'NOT ENOUGH ENERGY';
    btn.disabled = true; btn.className = '';
    return;
  }
  btn.textContent = '⚡ BUY  —  '+(isPractice ? 'FREE' : item.cost+' E');
  btn.disabled = false; btn.className = '';
  btn.onclick = () => doBuyItem(item, getLocalPlayer(gameState));
}

// Rebuild a fresh item descriptor by id (used after purchase to refresh detail panel)
function _buildFreshItem(id, isConsumable, p){
  if(!isConsumable){
    for(const k of ['O','D','M']){
      const u = UPS[k].find(u=>u.id===id);
      if(u){
        const ownedCount = Object.keys(p.upgrades||{}).length;
        return {
          id:u.id, name:u.name, icon:ITEM_ICONS[u.id]||'✦', cost:u.cost, desc:u.desc,
          cat:UPS_CAT_MAP[k], isConsumable:false,
          owned:!!p.upgrades[u.id],
          canAfford:(typeof practiceMode!=='undefined'&&practiceMode)||p.energy>=u.cost,
          full:ownedCount>=MAX_ITEMS&&!p.upgrades[u.id],
        };
      }
    }
  } else {
    const c = CONS_DEFS[id];
    if(!c) return null;
    const cons = p.consumables||[null,null,null,null,null];
    const existingSlot = cons.findIndex(s=>s&&s.id===id&&s.count<c.maxStack);
    const emptySlot = cons.findIndex(s=>!s);
    const canBuy = existingSlot>=0||emptySlot>=0;
    const curCount = cons.filter(s=>s&&s.id===id).reduce((a,s)=>a+(s.count||0),0);
    return {
      id, name:c.name, icon:c.icon, cost:c.cost, desc:c.desc,
      cat:c.cat, isConsumable:true, owned:false, stackCount:curCount,
      canAfford:(typeof practiceMode!=='undefined'&&practiceMode)||p.energy>=c.cost,
      full:!canBuy, maxStack:c.maxStack,
    };
  }
  return null;
}

// ── Buy ────────────────────────────────────────────────────────
function doBuyItem(item, p){
  if(!item || !p) return;
  if(item.isConsumable) doBuyConsumable(item.id, p);
  else doBuyUpgrade(item, p);
}

function doBuyUpgrade(item, p){
  const isPractice = typeof practiceMode !== 'undefined' && practiceMode;
  if(p.upgrades[item.id]) return;
  const ownedCount = Object.keys(p.upgrades||{}).length;
  if(ownedCount >= MAX_ITEMS) return;
  if(!isPractice && p.energy < item.cost) return;

  if(playMode === 'online' && ws && ws.readyState === 1){
    ws.send(JSON.stringify({type:'buyUpgrade', id:item.id}));
  }
  if(!isPractice) p.energy -= item.cost;
  p.upgrades[item.id] = true;
  applyUpg(p, item.id);
  showUpgradeFanfare(item.name, item.icon);
  if(gameState.stats) gameState.stats.upgradesBought = (gameState.stats.upgradesBought||0)+1;
  selectedShopItem = item; // keep selection, but mark owned
  renderShop();
  updateHUD();
}

function doBuyConsumable(id, p){
  const c = CONS_DEFS[id];
  if(!c) return;
  const isPractice = typeof practiceMode !== 'undefined' && practiceMode;
  if(!isPractice && p.energy < c.cost) return;
  const cons = p.consumables || [null,null,null,null,null];
  const existingSlot = cons.findIndex(s=>s&&s.id===id&&s.count<c.maxStack);
  const emptySlot = cons.findIndex(s=>!s);
  if(existingSlot < 0 && emptySlot < 0) return;

  if(playMode === 'online' && ws && ws.readyState === 1){
    ws.send(JSON.stringify({type:'buyConsumable', id}));
  } else {
    if(!isPractice) p.energy -= c.cost;
    if(existingSlot >= 0) cons[existingSlot].count++;
    else cons[emptySlot] = {id, count:1};
    showUpgradeFanfare(c.name, c.icon);
  }
  renderShop();
  updateHUD();
}

// ── Owned footer ───────────────────────────────────────────────
function renderShopOwnedFooter(p){
  const container = document.getElementById('shopOwnedSlots');
  if(!container) return;
  container.innerHTML = '';
  const ownedIds = Object.keys(p.upgrades||{});
  for(let i = 0; i < MAX_ITEMS; i++){
    const slot = document.createElement('div');
    if(i < ownedIds.length){
      const id = ownedIds[i];
      // Find category for stripe
      let catKey = 'offense';
      ['O','D','M'].forEach(k=>{ if(UPS[k].find(u=>u.id===id)) catKey = UPS_CAT_MAP[k]; });
      const stripe = SHOP_CATS[catKey]?.stripe || '';
      slot.className = 'sowned-slot filled';
      slot.title = (ALL_UPS||[...UPS.O,...UPS.D,...UPS.M]).find(u=>u.id===id)?.name || id;
      slot.innerHTML = `${ITEM_ICONS[id]||'✦'}<div class="socat ${stripe}"></div>`;
    } else {
      slot.className = 'sowned-slot';
      slot.innerHTML = `<span class="soslot-empty">${i+1}</span>`;
    }
    container.appendChild(slot);
  }
}

// ── Consumable bar ─────────────────────────────────────────────
function updateConsumableBar(p) {
  const bar = document.getElementById('consumableBar');
  if (!bar) return;
  const slots = bar.querySelectorAll('.cons-slot');
  const cons = p.consumables || [null,null,null,null,null];
  for (let i = 0; i < 5; i++) {
    const slot = slots[i];
    if (!slot) continue;
    const c = cons[i];
    if (c && c.id) {
      const def = CONS_DEFS[c.id];
      slot.className = 'cons-slot has-item';
      slot.innerHTML = `<span class="cons-key">${i+1}</span><span class="cons-icon">${def?.icon||'?'}</span><span class="cons-count">×${c.count||1}</span>`;
      slot.title = def ? def.name + ': ' + def.desc : '';
    } else {
      slot.className = 'cons-slot';
      slot.innerHTML = `<span class="cons-key">${i+1}</span><span class="cons-icon">—</span>`;
      slot.title = 'Empty slot';
    }
  }
}

// ── Use consumable ─────────────────────────────────────────────
function useConsumableSlot(slot) {
  if (!gameState || gameState.gameOver || gameState.shopOpen) return;
  const p = getLocalPlayer(gameState);
  if (!p || !p.alive) return;
  const cons = p.consumables || [null,null,null,null,null];
  const item = cons[slot];
  if (!item || !item.id) return;

  if (playMode === 'online' && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'useConsumable', slot }));
    applyConsumableVFX(item.id, p);
    showUpgradeFanfare(CONS_DEFS[item.id]?.name || 'ITEM', CONS_DEFS[item.id]?.icon || '🧪');
  } else {
    const def = CONS_DEFS[item.id];
    if (!def) return;
    switch (item.id) {
      case 'healthPot': { const oh=p.hp; p.hp=Math.min(p.maxHp,p.hp+50); if(p.isHuman&&p.hp>oh) addHealNumber(p.x,p.y-15,p.hp-oh); } break;
      case 'dmgBoost': p.dmgBoostTimer=6000; break;
      case 'speedBoost': p.spdBoostTimer=5000; break;
      case 'invulnPot': p.invuln=2000; break;
      case 'grenade':
        gameState.grenades=gameState.grenades||[];
        gameState.grenades.push({x:p.x+Math.cos(p.angle)*25,y:p.y+Math.sin(p.angle)*25,
          vx:Math.cos(p.angle)*400,vy:Math.sin(p.angle)*400,owner:p.id,timer:1500,radius:5}); break;
      case 'smokeBomb':
        p.invisTimer=3000;
        for(let i=0;i<20;i++) gameState.particles.push({x:p.x+Math.random()*60-30,y:p.y+Math.random()*60-30,
          vx:Math.random()*40-20,vy:Math.random()*40-20,life:2,maxLife:2,r:12+Math.random()*8,color:'rgba(150,150,150,.4)',type:'smoke'}); break;
      case 'wardStone':
        gameState.wards=gameState.wards||[];
        gameState.wards.push({x:p.x,y:p.y,owner:p.id,team:p.team,timer:30000,radius:180}); break;
      case 'manaPot': p.energy=Math.min(999,(p.energy||0)+40); break;
      case 'adrenaline': p.adrenalineTimer=6000; break;
      case 'teleScroll':
        if(gameState.teamMode&&gameState.towers&&gameState.towers.length){
          const myTower=gameState.towers.find(t=>t.team===p.team);
          if(myTower){const sp=findSafeSpawn(myTower.x,myTower.y+50,p.radius,gameState.walls);p.x=sp.x;p.y=sp.y;}
        } else { const sz=gameState.shopZone; p.x=sz.x+sz.w/2; p.y=sz.y+sz.h/2; }
        break;
    }
    applyConsumableVFX(item.id, p);
    item.count--;
    if(item.count<=0) p.consumables[slot]=null;
    showUpgradeFanfare(CONS_DEFS[item.id]?.name||'ITEM', CONS_DEFS[item.id]?.icon||'🧪');
  }
}

function applyConsumableVFX(itemId, p) {
  if (!gameState) return;
  switch (itemId) {
    case 'healthPot':  sparks(gameState,p.x,p.y,'#ff4444',15,100); break;
    case 'dmgBoost':   sparks(gameState,p.x,p.y,'#ff8800',15,100); break;
    case 'speedBoost': sparks(gameState,p.x,p.y,'#00ffff',15,100); break;
    case 'invulnPot':  sparks(gameState,p.x,p.y,'#ffffff',20,120); break;
    case 'grenade':    sparks(gameState,p.x,p.y,'#ff6600',8,60);   break;
    case 'smokeBomb':
      sparks(gameState,p.x,p.y,'#888888',25,80);
      for(let i=0;i<20;i++) gameState.particles.push({x:p.x+Math.random()*60-30,y:p.y+Math.random()*60-30,
        vx:Math.random()*40-20,vy:Math.random()*40-20,life:2,maxLife:2,r:12+Math.random()*8,color:'rgba(150,150,150,.4)',type:'smoke'}); break;
    case 'wardStone':  sparks(gameState,p.x,p.y,'#00ccff',12,60);  break;
    case 'manaPot':    sparks(gameState,p.x,p.y,'#aa44ff',15,100); break;
    case 'adrenaline': sparks(gameState,p.x,p.y,'#ff2266',18,110); break;
    case 'teleScroll': sparks(gameState,p.x,p.y,'#ffaa00',25,130); break;
  }
}
