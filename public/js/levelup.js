// ═══════════════════════════════════════════════════════════════
// LEVELUP.JS — XP, levels 1-10, talent picks at 2/4/6/8/10
// Performance: all checks are event-driven (on kill/orb/camp),
// never in the per-frame loop. UI is pure DOM, zero canvas cost.
// ═══════════════════════════════════════════════════════════════

// ── XP THRESHOLDS (XP needed to reach each level) ──────────────
const XP_PER_LEVEL = [0, 100, 150, 180, 220, 260, 310, 370, 440, 520];
// cumulative: [0, 100, 250, 430, 650, 910, 1220, 1590, 2030, 2550]
function _xpCumulative(level) {
  let t = 0;
  for (let i = 1; i < level; i++) t += XP_PER_LEVEL[i];
  return t;
}

const XP_FOR_LEVEL = Array.from({length: 11}, (_, i) => _xpCumulative(i));

const XP_TALENT_LEVELS = new Set([2, 4, 6, 8, 10]);

// ── XP REWARDS ──────────────────────────────────────────────────
const XP_KILL_PLAYER = 120;
const XP_KILL_VICTIM_BONUS = 15; // × victim.level
const XP_ORB = 15;
const XP_CAMP = { wolves:30, golems:55, wraiths:50, dragon:200, sentinel:200, berserker:75, lich:120 };
const XP_CAMP_DEFAULT = 35;

// ── PER-LEVEL STAT BONUS ─────────────────────────────────────────
const LEVEL_HP_BONUS   = 10;  // +10 max HP per level
const LEVEL_DMG_BONUS  = 0.02; // +2% damage multiplier per level
const LEVEL_CDR_BONUS  = 0.02; // -2% cooldown reduction per level

// ── TALENT DEFINITIONS ───────────────────────────────────────────
const TALENTS = {
  gunner: [
    [
      { id:'gn_hollow',  name:'HOLLOW POINT',    desc:'+25% bullet damage',                      icon:'🔴', color:'#ff4444' },
      { id:'gn_vest',    name:'COMBAT VEST',     desc:'+30 max HP  ·  +10% speed',              icon:'🛡', color:'#00ff88' },
      { id:'gn_extmag',  name:'EXTENDED MAG',    desc:'Bullets pierce 1 extra target',           icon:'🔫', color:'#00f5ff' },
    ],
    [
      { id:'gn_incend',  name:'INCENDIARY',      desc:'Hits apply 20 burn damage over 3s',       icon:'🔥', color:'#ff8800' },
      { id:'gn_medic',   name:'FIELD MEDIC',     desc:'Kills restore 20 HP',                     icon:'❤️', color:'#ff3355' },
      { id:'gn_suppress',name:'SUPPRESSOR',      desc:'Hits slow target 30% for 0.8s',           icon:'🌀', color:'#88aaff' },
    ],
    [
      { id:'gn_turret',  name:'TURRET STANCE',   desc:'Standing still: +50% fire rate',          icon:'🏰', color:'#ffcc00' },
      { id:'gn_grndier', name:'GRENADIER',       desc:'F key throws a frag grenade',             icon:'💣', color:'#ff8800' },
      { id:'gn_rapid',   name:'RAPID MASTERY',   desc:'-30% attack cooldown',                    icon:'⚡', color:'#00f5ff' },
    ],
    [
      { id:'gn_shred',   name:'ARMOR SHRED',     desc:'Each hit: -4% enemy armor (max -32%)',    icon:'💥', color:'#ff4444' },
      { id:'gn_execute', name:'EXECUTE',         desc:'+70% damage vs targets below 25% HP',     icon:'🎯', color:'#ff3355' },
      { id:'gn_veteran', name:'VETERAN',         desc:'+50 max HP  ·  -10% damage taken',        icon:'⚔️', color:'#00ff88' },
    ],
    [
      { id:'gn_annihil', name:'ANNIHILATOR',     desc:'Ult: massive explosive round (×3 dmg)',   icon:'☢️', color:'#ff4444' },
      { id:'gn_berserk', name:'BERSERK PROTOCOL',desc:'Below 40% HP: +80% fire rate',            icon:'🔴', color:'#ff8800' },
      { id:'gn_fortress',name:'FORTRESS',        desc:'Passive 40 HP shield, regens after 8s',   icon:'🛡', color:'#4488ff' },
    ],
  ],
  assassin: [
    [
      { id:'as_quick',   name:'QUICK BLADE',     desc:'+20% attack speed',                       icon:'⚡', color:'#e040fb' },
      { id:'as_shadow',  name:'SHADOW ENTRY',    desc:'First hit per fight: +60% damage',        icon:'👤', color:'#9c27b0' },
      { id:'as_viper',   name:'VIPER\'S TOUCH',  desc:'Hits apply 8 poison/s for 2s',            icon:'☠️', color:'#88cc44' },
    ],
    [
      { id:'as_bleed',   name:'HEMORRHAGE',      desc:'Melee hits stack bleed: 10 dmg/2s',       icon:'🔴', color:'#ff3355' },
      { id:'as_counter', name:'COUNTER STRIKE',  desc:'Take damage → next hit +80% damage',      icon:'🔄', color:'#ff8800' },
      { id:'as_smoke2',  name:'SMOKE SCREEN',    desc:'Dash leaves smoke cloud for 3s',          icon:'🌫️', color:'#aaaaaa' },
    ],
    [
      { id:'as_mark',    name:'DEATH MARK',      desc:'Mark: +100% dmg burst on target after 5s',icon:'💀', color:'#cc44ff' },
      { id:'as_clone',   name:'SHADOW CLONE',    desc:'Dash deploys a decoy that draws fire',    icon:'👥', color:'#9c27b0' },
      { id:'as_storm',   name:'BLADE STORM',     desc:'Q: 4 rapid slashes in a cone',            icon:'🌀', color:'#ff3355' },
    ],
    [
      { id:'as_pred',    name:'PREDATOR',        desc:'Kills restore full HP',                   icon:'❤️', color:'#ff3355' },
      { id:'as_shroud',  name:'SHROUD',          desc:'Below 20% HP: auto-stealth 2.5s (40s cd)',icon:'👻', color:'#9c27b0' },
      { id:'as_phantom', name:'PHANTOM SPEED',   desc:'+60% speed for 3s after a kill',          icon:'💨', color:'#00f5ff' },
    ],
    [
      { id:'as_lethal',  name:'FROM THE SHADOWS',desc:'Ult: 5s stealth → next hit deals 350% dmg',icon:'🌑', color:'#9c27b0' },
      { id:'as_thousand',name:'THOUSAND CUTS',   desc:'-50% dmg but +200% attack speed',         icon:'⚡', color:'#e040fb' },
      { id:'as_rampage', name:'RAMPAGE',         desc:'Each kill: +20% dmg permanent (5 stacks)',icon:'🔥', color:'#ff4444' },
    ],
  ],
  mage: [
    [
      { id:'mg_arcane',  name:'ARCANE POWER',    desc:'+25% spell damage',                       icon:'✨', color:'#cc44ff' },
      { id:'mg_mshield', name:'MANA SHIELD',     desc:'Absorb up to 30 dmg with energy',         icon:'🔮', color:'#7c4dff' },
      { id:'mg_missiles',name:'ARCANE MISSILES', desc:'Every 3rd shot deals double damage',      icon:'💫', color:'#aa44ff' },
    ],
    [
      { id:'mg_chain',   name:'CHAIN LIGHTNING', desc:'Projectiles bounce to 1 nearby enemy',    icon:'⚡', color:'#00f5ff' },
      { id:'mg_frost',   name:'FROST NOVA',      desc:'Q slows all nearby enemies 50% for 1.5s', icon:'❄️', color:'#88ccff' },
      { id:'mg_surge',   name:'MANA SURGE',      desc:'Below 50% energy: +30% spell power',      icon:'🔋', color:'#aa44ff' },
    ],
    [
      { id:'mg_meteor',  name:'METEOR',          desc:'Ult: crashes a meteor at cursor position', icon:'☄️', color:'#ff8800' },
      { id:'mg_warp',    name:'TIME WARP',       desc:'Q creates 2s slow field on impact',        icon:'🌀', color:'#7c4dff' },
      { id:'mg_master',  name:'ARCANE MASTERY',  desc:'-25% all cooldowns  ·  +15% spell power',  icon:'📚', color:'#cc44ff' },
    ],
    [
      { id:'mg_void',    name:'MANA VOID',       desc:'Drain enemy energy, deal equal damage',   icon:'⚫', color:'#4a148c' },
      { id:'mg_force',   name:'FORCE OF WILL',   desc:'Dash pushes all nearby enemies away',     icon:'💥', color:'#cc44ff' },
      { id:'mg_ethreal', name:'ETHEREAL FORM',   desc:'-40% damage taken while casting',         icon:'👻', color:'#e1bee7' },
    ],
    [
      { id:'mg_apoc',    name:'APOCALYPSE',      desc:'Ult: fires 3 meteors in rapid sequence',  icon:'🌋', color:'#ff4444' },
      { id:'mg_transcend',name:'TRANSCENDENCE',  desc:'Passively regenerate 2 energy/s',         icon:'♾️', color:'#cc44ff' },
      { id:'mg_inf',     name:'INFINITE POWER',  desc:'Kills reduce all cooldowns by 30%',       icon:'∞',  color:'#e040fb' },
    ],
  ],
  tank: [
    [
      { id:'tk_iron',    name:'IRON SKIN',       desc:'+40 max HP',                              icon:'🛡', color:'#00ff88' },
      { id:'tk_counter', name:'COUNTER FORCE',   desc:'Reflect 20% damage back to attacker',    icon:'🔄', color:'#4488ff' },
      { id:'tk_bulwark', name:'BULWARK',         desc:'Nearby allies take 10% less damage',      icon:'👥', color:'#00ff88' },
    ],
    [
      { id:'tk_shatter', name:'SHATTER',         desc:'Q: ground slam AoE dealing 40 damage',    icon:'💥', color:'#4488ff' },
      { id:'tk_unstop',  name:'UNSTOPPABLE',     desc:'Immune to slows  ·  +15% speed',          icon:'🚀', color:'#00ff88' },
      { id:'tk_cry',     name:'BATTLE CRY',      desc:'Kills: team gets +15% speed for 3s',      icon:'📣', color:'#ffcc00' },
    ],
    [
      { id:'tk_titan',   name:'TITAN',           desc:'+80 max HP  ·  -15% damage taken',        icon:'⚡', color:'#4488ff' },
      { id:'tk_fortress2',name:'FORTRESS WALL',  desc:'Barrier HP doubled  ·  recharges faster', icon:'🏰', color:'#00ff88' },
      { id:'tk_warlord', name:'WARLORD',         desc:'Hook: deals 60 dmg + 0.5s stun',          icon:'⚓', color:'#ffcc00' },
    ],
    [
      { id:'tk_jugger',  name:'JUGGERNAUT',      desc:'Charge straight through walls on dash',   icon:'💨', color:'#00ff88' },
      { id:'tk_rally',   name:'RALLY',           desc:'Revive nearest dead ally at 50 HP (×1)',  icon:'💊', color:'#ff3355' },
      { id:'tk_last',    name:'LAST STAND',      desc:'Below 25% HP: +50% dmg  ·  -25% taken',  icon:'❤️', color:'#ff8800' },
    ],
    [
      { id:'tk_impen',   name:'IMPENETRABLE',    desc:'Ult grants 6s of invulnerability',        icon:'🛡', color:'#4488ff' },
      { id:'tk_coloss',  name:'COLOSSUS',        desc:'+150 max HP  ·  30% damage reduction',    icon:'🗿', color:'#00ff88' },
      { id:'tk_warcry',  name:'WARLORD\'S CRY',  desc:'Ult empowers whole team for 5s',          icon:'📣', color:'#ffcc00' },
    ],
  ],
  necro: [
    [
      { id:'nc_pact',    name:'DARK PACT',       desc:'Kills grant +20 energy',                  icon:'💀', color:'#88cc44' },
      { id:'nc_bone',    name:'BONE ARMOR',      desc:'Passive +20 shield that slowly regens',   icon:'🦴', color:'#c8e6c9' },
      { id:'nc_plague',  name:'PLAGUE',          desc:'Projectiles spread poison on hit',         icon:'☠️', color:'#88cc44' },
    ],
    [
      { id:'nc_drain',   name:'SOUL DRAIN',      desc:'Drain heals 60% of damage dealt',         icon:'🔋', color:'#88cc44' },
      { id:'nc_strong',  name:'RAISE STRONGER',  desc:'Minions: +50% HP  ·  +20% damage',        icon:'💪', color:'#a5d6a7' },
      { id:'nc_cursed',  name:'CURSED GROUND',   desc:'Leave poison trail while moving',         icon:'🟢', color:'#66bb6a' },
    ],
    [
      { id:'nc_lich2',   name:'LICH FORM',       desc:'Ult lasts 3s longer  ·  +2 skeleton summons',icon:'💎', color:'#aa44ff' },
      { id:'nc_coil',    name:'DEATH COIL',      desc:'Q fires a homing death bolt (80 dmg)',    icon:'🐍', color:'#88cc44' },
      { id:'nc_aura',    name:'UNHOLY AURA',     desc:'All allies regenerate 4 HP/s',            icon:'💚', color:'#00ff88' },
    ],
    [
      { id:'nc_sacr',    name:'DEATH PACT',      desc:'Sacrifice a minion: restore 60 HP',       icon:'❤️', color:'#ff3355' },
      { id:'nc_epid',    name:'EPIDEMIC',        desc:'On kill: nearby enemies take 40 damage',  icon:'🦠', color:'#88cc44' },
      { id:'nc_corrupt', name:'CORRUPTING TOUCH',desc:'Your damage cuts enemy healing by 60%',  icon:'🖤', color:'#4a148c' },
    ],
    [
      { id:'nc_undying', name:'UNDYING',         desc:'On death: revive once at 50% HP (90s cd)',icon:'♻️', color:'#88cc44' },
      { id:'nc_army',    name:'ARMY OF DARKNESS',desc:'Ult summons 6 skeletons instead of 3',   icon:'💀', color:'#aa44ff' },
      { id:'nc_pest',    name:'PESTILENCE',      desc:'All abilities spread disease (40 dmg/s)', icon:'☢️', color:'#88cc44' },
    ],
  ],
  ranger: [
    [
      { id:'rg_eagle',   name:'EAGLE EYE',       desc:'+30% range  ·  +15% projectile speed',   icon:'🦅', color:'#ff8833' },
      { id:'rg_mark',    name:'HUNTER\'S MARK',  desc:'Mark enemy: +25% damage against them',   icon:'🎯', color:'#ff8833' },
      { id:'rg_quiver',  name:'QUIVER',          desc:'+2 stored rapid-fire charges',            icon:'🏹', color:'#ffcc00' },
    ],
    [
      { id:'rg_barbed',  name:'BARBED ARROWS',   desc:'Each hit: -10% target speed (stackable)', icon:'🔴', color:'#ff4444' },
      { id:'rg_forest',  name:'FOREST STEP',     desc:'+30% speed  ·  phase through walls briefly',icon:'🌿', color:'#88cc44' },
      { id:'rg_multi',   name:'MULTISHOT',       desc:'Attack fires 3 arrows in a spread',       icon:'〰️', color:'#ff8833' },
    ],
    [
      { id:'rg_sniper',  name:'SNIPER ELITE',    desc:'Snipe damage +50%  ·  charges 40% faster',icon:'🔭', color:'#ff8833' },
      { id:'rg_rain',    name:'RAIN OF ARROWS',  desc:'Q: arrow barrage rains on cursor area',   icon:'🌧️', color:'#4488ff' },
      { id:'rg_camo',    name:'CAMOUFLAGE',      desc:'Still for 1.5s: turn invisible',          icon:'🌿', color:'#88cc44' },
    ],
    [
      { id:'rg_call',    name:'PREDATOR\'S CALL',desc:'Mark all nearby enemies for 8s',          icon:'📡', color:'#ff8833' },
      { id:'rg_arrow',   name:'ARROW MASTERY',   desc:'Arrows pierce every target in their path',icon:'🏹', color:'#ffcc00' },
      { id:'rg_wind',    name:'WINDRUNNER',      desc:'+50% speed  ·  after-image trail on dash', icon:'💨', color:'#00f5ff' },
    ],
    [
      { id:'rg_eagle10', name:'EAGLE STRIKE',    desc:'Snipe fires 3 in sequence, all pierce',   icon:'⚡', color:'#ff8833' },
      { id:'rg_death',   name:'DEATH FROM AFAR', desc:'+100% snipe damage  ·  no charge needed', icon:'💀', color:'#ff4444' },
      { id:'rg_storm',   name:'STORM ARCHERY',   desc:'Hold fire: 8 rapid arrows in all directions',icon:'🌪️', color:'#00f5ff' },
    ],
  ],
};

// ── INIT PLAYER LEVEL STATE ──────────────────────────────────────
function initPlayerLevel(p) {
  p.level        = 1;
  p.xp           = 0;
  p.xpToNext     = XP_PER_LEVEL[1];
  p.talentQueue  = [];   // [{tierIdx, choices[]}] queued picks
  p.talents      = {};   // { talentId: true }
  p.lvlDmgMult   = 1.0;
  p.lvlCdr       = 1.0;
  p.armorShred   = 0;
  p.poisonTimer  = 0;
  p.bleedTimer   = 0;
  p.bleedStacks  = 0;
}

// ── ADD XP & LEVEL UP ────────────────────────────────────────────
function addXP(gs, p, amount) {
  if (!p || p.level >= 10) return;
  p.xp += amount;
  while (p.level < 10 && p.xp >= XP_FOR_LEVEL[p.level + 1]) {
    _levelUp(gs, p);
    if (p.talentPick) break; // pause level-up loop until talent picked
  }
  _updateXPBar(p);
}

function _levelUp(gs, p) {
  p.level++;

  // Stat bonus per level — additive so talent multiplications stack on top
  p.maxHp += LEVEL_HP_BONUS;
  p.hp = Math.min(p.maxHp, p.hp + LEVEL_HP_BONUS);
  p.lvlDmgMult = (p.lvlDmgMult || 1) + LEVEL_DMG_BONUS;
  p.lvlCdr     = Math.max(0.3, (p.lvlCdr || 1) - LEVEL_CDR_BONUS);
  p.xpToNext   = p.level < 10 ? XP_PER_LEVEL[p.level] : 0;

  // VFX
  if (typeof sparks === 'function' && gs)
    sparks(gs, p.x, p.y, '#ffcc00', 20, 160);
  if (typeof addDmgNumber === 'function')
    addDmgNumber(p.x, p.y - 30, '⬆ LVL ' + p.level, '#ffcc00', false);
  if (typeof showCenterAlert === 'function' && p.isHuman)
    showCenterAlert('LEVEL ' + p.level + '!', '#ffcc00', 1800);

  // Queue a talent pick at specific levels (non-blocking — player picks when ready)
  if (XP_TALENT_LEVELS.has(p.level) && p.isHuman) {
    const tierIdx = [2,4,6,8,10].indexOf(p.level);
    const choices = TALENTS[p.cls]?.[tierIdx] || [];
    if (choices.length) {
      p.talentQueue = p.talentQueue || [];
      p.talentQueue.push({ tierIdx, choices });
      _updateTalentBadge(p);
    }
  }
}

// ── XP REWARDS (called from combat.js / engine.js) ───────────────
function grantKillXP(gs, killer, victim) {
  if (!killer || !gs) return;
  const xp = XP_KILL_PLAYER + (victim.level || 1) * XP_KILL_VICTIM_BONUS;
  addXP(gs, killer, xp);
  // Small assist XP to nearby allies
  if (gs.teamMode) {
    for (const p of gs.players) {
      if (p === killer || !p.alive || !isAlly || (typeof isAlly === 'function' && !isAlly(killer, p, gs))) continue;
      const dx = p.x - killer.x, dy = p.y - killer.y;
      if (dx*dx + dy*dy < 600*600) addXP(gs, p, Math.round(xp * 0.3));
    }
  }
}

function grantOrbXP(gs, p) {
  addXP(gs, p, XP_ORB);
}

function grantCampXP(gs, campType) {
  const xp = XP_CAMP[campType] || XP_CAMP_DEFAULT;
  for (const p of gs.players) {
    if (!p.alive) continue;
    addXP(gs, p, Math.round(xp * 0.6));
  }
}

// ── TALENT PICKER UI (MOBA style — non-blocking, game runs behind it) ──
let _talentPanelEl  = null;
let _talentPanelP   = null;
let _talentPanelOpen = false;

// Inject CSS once
(function _injectTalentCSS() {
  if (document.getElementById('_talentCSS')) return;
  const s = document.createElement('style');
  s.id = '_talentCSS';
  s.textContent = `
#_talentBadge{
  display:none;align-items:center;gap:5px;cursor:pointer;
  font-family:'Orbitron',monospace;font-size:9px;font-weight:700;
  letter-spacing:1px;color:#ffcc00;padding:2px 7px 2px 5px;
  border:1px solid #ffcc0088;border-radius:3px;
  background:rgba(30,20,0,.85);pointer-events:all;
  animation:_talentPulse 1.4s ease-in-out infinite;
}
#_talentBadge.visible{display:flex}
@keyframes _talentPulse{0%,100%{box-shadow:0 0 6px #ffcc0066}50%{box-shadow:0 0 16px #ffcc00cc,0 0 28px #ffcc0044}}
#_talentPanel{
  position:fixed;bottom:108px;left:50%;transform:translateX(-50%) translateY(20px);
  display:none;flex-direction:column;align-items:center;gap:10px;
  z-index:9999;pointer-events:all;
  background:rgba(2,5,14,0.94);border:1px solid #ffcc0055;
  padding:14px 16px 12px;border-radius:6px;
  backdrop-filter:blur(8px);
  transition:transform .18s ease,opacity .18s ease;opacity:0;
}
#_talentPanel.open{display:flex;transform:translateX(-50%) translateY(0);opacity:1}
._tp-title{font-family:'Orbitron',monospace;font-size:13px;font-weight:900;
  letter-spacing:3px;color:#ffcc00;text-align:center}
._tp-sub{font-family:'Share Tech Mono',monospace;font-size:9px;color:#4a6080;
  letter-spacing:2px;text-align:center;margin-top:-4px}
._tp-cards{display:flex;gap:10px}
._tp-card{
  width:170px;padding:12px 12px 10px;border:1px solid #1a3050;
  background:rgba(5,10,22,.9);cursor:pointer;border-radius:4px;
  display:flex;flex-direction:column;align-items:center;gap:5px;
  transition:all .12s;position:relative;
}
._tp-card:hover{transform:translateY(-3px)}
._tp-icon{font-size:22px;line-height:1}
._tp-name{font-family:'Orbitron',monospace;font-size:10px;font-weight:700;
  letter-spacing:1px;text-align:center}
._tp-desc{font-size:9px;color:#8899aa;text-align:center;line-height:1.45}
._tp-key{position:absolute;top:5px;right:7px;font-family:'Orbitron',monospace;
  font-size:7px;color:#4a6080}
._tp-close{font-family:'Orbitron',monospace;font-size:8px;color:#4a6080;
  cursor:pointer;letter-spacing:1px;padding:2px 8px;
  border:1px solid #1a3050;border-radius:3px;align-self:flex-end}
._tp-close:hover{color:#aaa;border-color:#aaa}
  `;
  document.head.appendChild(s);
})();

function _ensureTalentBadge() {
  if (document.getElementById('_talentBadge')) return;
  const badge = document.createElement('div');
  badge.id = '_talentBadge';
  badge.innerHTML = '★ TALENT';
  badge.title = 'Talent available — press T or click to choose';
  badge.addEventListener('click', toggleTalentPanel);
  // Insert next to the level display inside HUD TL panel
  const lvlEl = document.getElementById('hudLevel');
  if (lvlEl && lvlEl.parentElement) {
    lvlEl.parentElement.insertAdjacentElement('afterend', badge);
  } else {
    document.body.appendChild(badge);
  }
}

function _ensureTalentPanel() {
  if (document.getElementById('_talentPanel')) return;
  const panel = document.createElement('div');
  panel.id = '_talentPanel';
  document.body.appendChild(panel);
  _talentPanelEl = panel;

  // T key to toggle
  document.addEventListener('keydown', e => {
    if (e.code === 'KeyT' && typeof gameState !== 'undefined' && gameState && !gameState.shopOpen) {
      e.preventDefault(); toggleTalentPanel();
    }
    if (!_talentPanelOpen) return;
    if (e.code === 'Digit1') pickTalent(0);
    else if (e.code === 'Digit2') pickTalent(1);
    else if (e.code === 'Digit3') pickTalent(2);
  });
}

function _updateTalentBadge(p) {
  _ensureTalentBadge();
  const badge = document.getElementById('_talentBadge');
  if (!badge) return;
  const count = (p.talentQueue||[]).length;
  if (count > 0) {
    badge.classList.add('visible');
    badge.innerHTML = `★ TALENT${count > 1 ? ' ×'+count : ''}`;
  } else {
    badge.classList.remove('visible');
    _closeTalentPanel();
  }
}

function toggleTalentPanel() {
  if (_talentPanelOpen) { _closeTalentPanel(); return; }
  const p = typeof gameState !== 'undefined' && gameState
    ? (typeof getLocalPlayer === 'function' ? getLocalPlayer(gameState) : gameState.players?.[0])
    : null;
  if (!p || !(p.talentQueue||[]).length) return;
  _openTalentPanel(p);
}

function _openTalentPanel(p) {
  _ensureTalentPanel();
  _talentPanelP = p;
  const panel = document.getElementById('_talentPanel');
  if (!panel) return;
  const { choices } = p.talentQueue[0];
  const tierIdx = p.talentQueue[0].tierIdx + 1;

  panel.innerHTML = `
    <div class="_tp-title">LEVEL ${p.level} — CHOOSE TALENT</div>
    <div class="_tp-sub">TIER ${tierIdx}  ·  PRESS T TO CLOSE  ·  1 · 2 · 3 TO PICK</div>
    <div class="_tp-cards" id="_tpCards"></div>
    <div class="_tp-close" onclick="toggleTalentPanel()">✕ CLOSE  [T]</div>
  `;
  const cardsEl = panel.querySelector('#_tpCards');
  choices.forEach((t, i) => {
    const card = document.createElement('div');
    card.className = '_tp-card';
    card.style.borderColor = t.color || '#1a3050';
    card.innerHTML = `
      <span class="_tp-key">[${i+1}]</span>
      <div class="_tp-icon">${t.icon}</div>
      <div class="_tp-name" style="color:${t.color||'#00f5ff'}">${t.name}</div>
      <div class="_tp-desc">${t.desc}</div>
    `;
    card.addEventListener('mouseenter', () => {
      card.style.background = `rgba(${_hexToRgbVals(t.color||'#1a3050')},0.18)`;
      card.style.boxShadow  = `0 0 14px ${t.color||'#1a3050'}55`;
    });
    card.addEventListener('mouseleave', () => {
      card.style.background = 'rgba(5,10,22,.9)';
      card.style.boxShadow  = '';
    });
    card.addEventListener('click', () => pickTalent(i));
    cardsEl.appendChild(card);
  });

  _talentPanelOpen = true;
  // Two-frame trick for CSS transition to fire
  requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add('open')));
}

function _closeTalentPanel() {
  _talentPanelOpen = false;
  _talentPanelP = null;
  const panel = document.getElementById('_talentPanel');
  if (!panel) return;
  panel.classList.remove('open');
}

function _hexToRgbVals(hex) {
  const h = hex.replace('#','');
  const n = parseInt(h.length===3 ? h.split('').map(c=>c+c).join('') : h, 16);
  return `${(n>>16)&255},${(n>>8)&255},${n&255}`;
}

function pickTalent(idx) {
  const p = _talentPanelP || (typeof gameState !== 'undefined' && gameState
    ? (typeof getLocalPlayer === 'function' ? getLocalPlayer(gameState) : gameState.players?.[0])
    : null);
  if (!p || !(p.talentQueue||[]).length) return;
  const talent = p.talentQueue[0].choices[idx];
  if (!talent) return;

  const pick = p.talentQueue.shift();
  _closeTalentPanel();

  // Apply locally (optimistic — server also applies for authoritative stats)
  p.talents[talent.id] = true;
  _applyTalent(p, talent.id);

  // Tell server in online mode
  if (typeof playMode !== 'undefined' && playMode === 'online'
      && typeof ws !== 'undefined' && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type:'talentPick', talentId:talent.id, tier:pick?.tierIdx ?? -1 }));
  }

  if (typeof showCenterAlert === 'function')
    showCenterAlert(talent.icon + ' ' + talent.name, talent.color || '#ffcc00', 1800);

  // Update badge (may still have picks queued)
  _updateTalentBadge(p);

  // Resume XP loop if more levels earned
  if (typeof gameState !== 'undefined' && gameState) addXP(gameState, p, 0);
}

// ── TALENT EFFECT APPLICATION ────────────────────────────────────
function _applyTalent(p, id) {
  switch (id) {
    // Gunner
    case 'gn_hollow':  p.lvlDmgMult *= 1.25; break;
    case 'gn_vest':    p.maxHp += 30; p.hp = Math.min(p.maxHp, p.hp + 30); p.speed = Math.round((p.speed||280)*1.1); break;
    case 'gn_extmag':  break; // handled in fireBullet via p.talents
    case 'gn_incend':  break; // handled in dmgPlayer
    case 'gn_medic':   break; // handled in killPlayer
    case 'gn_suppress':break; // handled in dmgPlayer
    case 'gn_turret':  break; // handled in fireBullet
    case 'gn_grndier': break; // handled in secondary
    case 'gn_rapid':   p.fireRate  = Math.round((p.fireRate||320) * 0.7); break;
    case 'gn_shred':   break; // handled in dmgPlayer (stacks on target)
    case 'gn_execute': break; // handled in dmgPlayer
    case 'gn_veteran': p.maxHp += 50; p.hp = Math.min(p.maxHp, p.hp + 50); break;
    case 'gn_annihil': break;
    case 'gn_berserk': break;
    case 'gn_fortress':p.shield = Math.max(p.shield||0, 40); break;

    // Assassin
    case 'as_quick':   p.fireRate = Math.round((p.fireRate||280) * 0.8); break;
    case 'as_shadow':  break;
    case 'as_viper':   break;
    case 'as_bleed':   break;
    case 'as_counter': break;
    case 'as_smoke2':  break;
    case 'as_mark':    break;
    case 'as_clone':   break;
    case 'as_storm':   break;
    case 'as_pred':    break; // handled in killPlayer
    case 'as_shroud':  break;
    case 'as_phantom': break;
    case 'as_lethal':  break;
    case 'as_thousand':p.fireRate = Math.round((p.fireRate||280) * 0.33); p.lvlDmgMult *= 0.5; break;
    case 'as_rampage': break; // stacks handled in killPlayer

    // Mage
    case 'mg_arcane':  p.lvlDmgMult *= 1.25; break;
    case 'mg_mshield': break; // passive checked in dmgPlayer
    case 'mg_missiles':break;
    case 'mg_chain':   break;
    case 'mg_frost':   break;
    case 'mg_surge':   break;
    case 'mg_meteor':  break;
    case 'mg_warp':    break;
    case 'mg_master':  p.lvlDmgMult *= 1.15; p.lvlCdr = Math.max(0.3, (p.lvlCdr||1) * 0.75); break;
    case 'mg_void':    break;
    case 'mg_force':   break;
    case 'mg_ethreal': break;
    case 'mg_apoc':    break;
    case 'mg_transcend':break;
    case 'mg_inf':     break;

    // Tank
    case 'tk_iron':    p.maxHp += 40; p.hp = Math.min(p.maxHp, p.hp + 40); break;
    case 'tk_counter': break;
    case 'tk_bulwark': break;
    case 'tk_shatter': break;
    case 'tk_unstop':  p.speed = Math.round((p.speed||190) * 1.15); break;
    case 'tk_cry':     break;
    case 'tk_titan':   p.maxHp += 80; p.hp = Math.min(p.maxHp, p.hp + 80); break;
    case 'tk_fortress2':break;
    case 'tk_warlord': break;
    case 'tk_jugger':  break;
    case 'tk_rally':   p.rallyCharge = 1; break;
    case 'tk_last':    break;
    case 'tk_impen':   break;
    case 'tk_coloss':  p.maxHp += 150; p.hp = Math.min(p.maxHp, p.hp + 150); break;
    case 'tk_warcry':  break;

    // Necro
    case 'nc_pact':    break;
    case 'nc_bone':    p.shield = Math.max(p.shield||0, 20); break;
    case 'nc_plague':  break;
    case 'nc_drain':   break;
    case 'nc_strong':  break;
    case 'nc_cursed':  break;
    case 'nc_lich2':   break;
    case 'nc_coil':    break;
    case 'nc_aura':    break;
    case 'nc_sacr':    break;
    case 'nc_epid':    break;
    case 'nc_corrupt': break;
    case 'nc_undying': p.undyingCharge = 1; break;
    case 'nc_army':    break;
    case 'nc_pest':    break;

    // Ranger
    case 'rg_eagle':   p.lvlDmgMult *= 1.1; break;
    case 'rg_mark':    break;
    case 'rg_quiver':  break;
    case 'rg_barbed':  break;
    case 'rg_forest':  p.speed = Math.round((p.speed||340) * 1.3); break;
    case 'rg_multi':   break;
    case 'rg_sniper':  break;
    case 'rg_rain':    break;
    case 'rg_camo':    break;
    case 'rg_call':    break;
    case 'rg_arrow':   break;
    case 'rg_wind':    p.speed = Math.round((p.speed||340) * 1.5); break;
    case 'rg_eagle10': break;
    case 'rg_death':   p.lvlDmgMult *= 2.0; break;
    case 'rg_storm':   break;
  }
}

// ── PASSIVE TALENT HOOKS (called from combat.js) ─────────────────

// Called inside dmgPlayer — modify damage based on attacker/target talents
function applyTalentDmgMods(gs, attacker, target, dmg) {
  if (attacker) {
    // Execute: +70% vs low HP
    if (attacker.talents?.gn_execute && target.hp / target.maxHp < 0.25)
      dmg = Math.round(dmg * 1.7);
    // Mana surge: +30% when low energy
    if (attacker.talents?.mg_surge && (attacker.energy||0) < (attacker.maxEnergy||200) * 0.5)
      dmg = Math.round(dmg * 1.3);
    // Berserk protocol
    if (attacker.talents?.gn_berserk && attacker.hp / attacker.maxHp < 0.4)
      dmg = Math.round(dmg * 1.0); // fire rate handled separately
    // Arcane missiles: every 3rd shot ×2
    if (attacker.talents?.mg_missiles) {
      attacker._missileCount = ((attacker._missileCount||0) + 1);
      if (attacker._missileCount % 3 === 0) dmg *= 2;
    }
    // Apply global level damage multiplier
    if (attacker.lvlDmgMult && attacker.lvlDmgMult > 1)
      dmg = Math.round(dmg * attacker.lvlDmgMult);
  }
  if (target) {
    // Titan / Colossus damage reduction
    if (target.talents?.tk_titan)   dmg = Math.round(dmg * 0.85);
    if (target.talents?.tk_coloss)  dmg = Math.round(dmg * 0.7);
    if (target.talents?.tk_last && target.hp / target.maxHp < 0.25) dmg = Math.round(dmg * 0.75);
    if (target.talents?.mg_ethreal && (typeof target.overchargeTimer !== 'undefined' && target.overchargeTimer > 0))
      dmg = Math.round(dmg * 0.6);
    // Mana shield: absorb some dmg with energy
    if (target.talents?.mg_mshield && (target.energy||0) > 0 && dmg > 0) {
      const absorb = Math.min(30, dmg, target.energy||0);
      target.energy = (target.energy||0) - absorb;
      dmg -= absorb;
    }
  }
  return Math.max(0, dmg);
}

// Called inside killPlayer — post-kill talent effects
function applyTalentKillEffects(gs, killer, victim) {
  if (!killer) return;
  if (killer.talents?.gn_medic) { killer.hp = Math.min(killer.maxHp, killer.hp + 20); }
  if (killer.talents?.as_pred)  { killer.hp = killer.maxHp; killer.shield = killer.maxHp > 0 ? 0 : 0; }
  if (killer.talents?.nc_pact)  { killer.energy = (killer.energy||0) + 20; }
  if (killer.talents?.nc_epid && gs) {
    for (const p of gs.players) {
      if (p === killer || !p.alive) continue;
      const dx = p.x - victim.x, dy = p.y - victim.y;
      if (dx*dx + dy*dy < 200*200 && typeof dmgPlayer === 'function')
        dmgPlayer(gs, p, { dmg:40, owner:killer.id, color:killer.color });
    }
  }
  if (killer.talents?.as_phantom) {
    killer.spdBoostTimer = 3000;
    if (typeof sparks === 'function') sparks(gs, killer.x, killer.y, '#00f5ff', 10, 120);
  }
  // Rampage stacks
  if (killer.talents?.as_rampage) {
    killer._rampageStacks = Math.min(5, (killer._rampageStacks||0) + 1);
    killer.lvlDmgMult = (killer.lvlDmgMult||1) + 0.20;
  }
  // Mage infinite power
  if (killer.talents?.mg_inf) {
    killer.lastDash = 0; killer.lastSp = 0; killer.lastSec = -9999;
  }
}

// Called on player death — undying talent
function applyTalentDeathEffects(gs, victim) {
  if (victim.talents?.nc_undying && victim.undyingCharge > 0) {
    victim.undyingCharge = 0;
    victim.alive = true;
    victim.hp = Math.round(victim.maxHp * 0.5);
    victim.invuln = 2000;
    if (typeof sparks === 'function') sparks(gs, victim.x, victim.y, '#88cc44', 30, 200);
    if (typeof showCenterAlert === 'function' && victim.isHuman)
      showCenterAlert('UNDYING!', '#88cc44', 2000);
    return true; // blocked death
  }
  return false;
}

// ── HUD: XP BAR & LEVEL ──────────────────────────────────────────
let _xpEl = null;
function _getXPEl() {
  if (_xpEl) return _xpEl;
  _xpEl = {
    bar:   document.getElementById('hudXPFill'),
    text:  document.getElementById('hudXPText'),
    level: document.getElementById('hudLevel'),
  };
  return _xpEl;
}

function _updateXPBar(p) {
  if (!p || !p.isHuman) return;
  const el = _getXPEl();
  if (!el.bar) return;
  const pct = p.level >= 10 ? 100
    : ((p.xp - XP_FOR_LEVEL[p.level]) / XP_PER_LEVEL[p.level] * 100);
  el.bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (el.text)  el.text.textContent  = p.level >= 10 ? 'MAX' : p.xp + ' / ' + XP_FOR_LEVEL[p.level + 1];
  if (el.level) el.level.textContent = p.level;
}
