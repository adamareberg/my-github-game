// ═══════════════════════════════════════════════════════════════
// DATA.JS — All game data definitions
// ═══════════════════════════════════════════════════════════════

// ▼▼▼ CLASS DEFINITIONS — ADD / REMOVE / TWEAK CLASSES HERE ▼▼▼
const CDEFS = {
  gunner:{ name:'GUNNER', color:'#00f5ff', hp:100, speed:280, radius:14, fireRate:320, bDmg:20, bSpd:540, bLife:2200, dashCd:2000, secCd:8000, secName:'GRENADE', spCd:4000, spName:'BURST', ultCd:8000, ultName:'OVERCHARGE' },
  assassin:{ name:'ASSASSIN', color:'#ff3355', hp:80, speed:370, radius:12, fireRate:280, bDmg:22, bSpd:0, bLife:0, dashCd:1200, secCd:5000, secName:'BLITZ', spCd:3000, spName:'SHADOW STEP', meleeRange:80, meleeArc:1.4, ultCd:10000, ultName:'SMOKE BOMB' },
  mage:{ name:'MAGE', color:'#cc44ff', hp:90, speed:225, radius:15, fireRate:720, bDmg:35, bSpd:360, bLife:2800, dashCd:2800, secCd:7000, secName:'ARC MISSILES', spCd:5000, spName:'NOVA BURST', ultCd:12000, ultName:'ARCANE BARRIER' },
  tank:{ name:'TANK', color:'#00ff88', hp:160, speed:190, radius:18, fireRate:600, bDmg:18, bSpd:400, bLife:1800, dashCd:3000, secCd:9000, secName:'SHOCKWAVE', spCd:6000, spName:'MEAT HOOK', ultCd:14000, ultName:'FORTIFY', hookSpeed:700, hookRange:400, hookDmg:30 },
  necro:{ name:'NECRO', color:'#88cc44', hp:95, speed:240, radius:14, fireRate:550, bDmg:28, bSpd:380, bLife:2400, dashCd:2200, secCd:6000, secName:'BONE SPEAR', spCd:5500, spName:'SOUL DRAIN', ultCd:13000, ultName:'RAISE DEAD' },
  ranger:{ name:'RANGER', color:'#ff8833', hp:85, speed:340, radius:13, fireRate:420, bDmg:24, bSpd:620, bLife:2600, dashCd:1600, secCd:5000, secName:'RAPID BURST', spCd:4000, spName:'VOLLEY', ultCd:12000, ultName:'TRAP FIELD' }
};
// ▲▲▲ END CLASS DEFINITIONS ▲▲▲

// ── TEAM COLORS ──
const TEAM_COLORS = { blue:'#4488ff', red:'#ff4444' };

// ▼▼▼ CONSUMABLE ITEMS — ADD / REMOVE CONSUMABLES HERE ▼▼▼
const CONS_DEFS = {
  healthPot:  { name:'HEALTH POTION', cost:25, icon:'❤️', desc:'Restore 50 HP instantly', maxStack:3, cat:'combat' },
  dmgBoost:   { name:'DAMAGE BOOST', cost:40, icon:'⚔️', desc:'+40% damage for 6s', maxStack:2, cat:'combat' },
  speedBoost: { name:'SPEED BOOST', cost:30, icon:'💨', desc:'+50% speed for 5s', maxStack:2, cat:'combat' },
  invulnPot:  { name:'INVULN POTION', cost:80, icon:'✨', desc:'Invulnerable for 2s', maxStack:1, cat:'combat' },
  grenade:    { name:'FRAG GRENADE', cost:50, icon:'💣', desc:'Throw explosive, 40 AoE dmg', maxStack:3, cat:'combat' },
  smokeBomb:  { name:'SMOKE BOMB', cost:35, icon:'🌫️', desc:'Become invisible for 3s', maxStack:2, cat:'utility' },
  wardStone:  { name:'WARD STONE', cost:20, icon:'👁️', desc:'Place a vision ward for 30s', maxStack:3, cat:'utility' },
  manaPot:    { name:'ENERGY ELIXIR', cost:30, icon:'🔮', desc:'Restore 40 energy instantly', maxStack:3, cat:'utility' },
  adrenaline: { name:'ADRENALINE', cost:55, icon:'💉', desc:'-50% cooldowns for 6s', maxStack:2, cat:'combat' },
  teleScroll: { name:'RECALL SCROLL', cost:45, icon:'📜', desc:'Teleport back to your team tower', maxStack:1, cat:'utility' }
};
// ▲▲▲ END CONSUMABLES ▲▲▲

// ▼▼▼ SHOP UPGRADES — ADD / REMOVE PERMANENT UPGRADES HERE ▼▼▼
const MAX_ITEMS = 6;
const UPS = {
  O:[
    {id:'rapidFire',name:'RAPID FIRE',desc:'Fire rate +50%',cost:40,badge:'RAPID'},
    {id:'doubleShot',name:'DOUBLE SHOT',desc:'Fire two at once',cost:60,badge:'DBL'},
    {id:'pierce',name:'PIERCE',desc:'Pass through walls once',cost:80,badge:'PIERC'},
    {id:'homing',name:'HOMING',desc:'Slight tracking on shots',cost:100,badge:'HOME'},
    {id:'heavy',name:'HEAVY SHOT',desc:'2× dmg, 40% slower fire',cost:70,badge:'HEAVY'},
    {id:'critStrike',name:'CRIT STRIKE',desc:'20% chance for 2× dmg',cost:85,badge:'CRIT'},
    {id:'projSpeed',name:'PROJECT SPEED',desc:'+30% projectile speed',cost:50,badge:'PROJ'},
  ],
  D:[
    {id:'shield',name:'ENERGY SHIELD',desc:'Absorbs first 30 dmg',cost:50,badge:'SHLD'},
    {id:'regen',name:'REGEN',desc:'Slowly recover HP',cost:60,badge:'RGEN'},
    {id:'armor',name:'ARMOR',desc:'-25% damage taken',cost:80,badge:'ARMR'},
    {id:'fortify',name:'FORTIFY',desc:'+50 max health',cost:90,badge:'FORT'},
    {id:'thornmail',name:'THORNMAIL',desc:'Reflect 15% dmg to attacker',cost:75,badge:'THRN'},
    {id:'vitality',name:'VITALITY',desc:'+30 max HP, +2 HP/s regen',cost:65,badge:'VITA'},
  ],
  M:[
    {id:'speed',name:'AFTERBURNER',desc:'+30% movement speed',cost:45,badge:'BOOST'},
    {id:'fastDash',name:'QUICK DASH',desc:'Dash cooldown -40%',cost:55,badge:'QDSH'},
    {id:'teleport',name:'BLINK',desc:'Teleport-style dash',cost:110,badge:'BLNK'},
    {id:'boots',name:'SWIFT BOOTS',desc:'+15% speed, +10% dash range',cost:35,badge:'BOOT'},
    {id:'momentum',name:'MOMENTUM',desc:'Moving increases dmg up to +20%',cost:70,badge:'MNTM'},
    {id:'phaseWalk',name:'PHASE WALK',desc:'Brief ghost mode after dash (no collide)',cost:95,badge:'PHSE'},
  ]
};
const ALL_UPS = [...UPS.O,...UPS.D,...UPS.M];
// ▲▲▲ END SHOP UPGRADES ▲▲▲

// ── KILL STREAK NAMES ──
const STREAK_NAMES = {
  2:'DOUBLE KILL', 3:'KILLING SPREE', 4:'DOMINATING',
  5:'MEGA KILL', 6:'UNSTOPPABLE', 7:'GODLIKE',
  8:'LEGENDARY', 9:'BEYOND GODLIKE', 10:'RAMPAGE'
};

// ── KILL STREAK PASSIVES ──
const STREAKS = [
  { threshold:3, name:'FURY', desc:'+25% DMG', duration:5000, color:'#ff4444', icon:'🔥' },
  { threshold:5, name:'VELOCITY', desc:'+40% SPD', duration:5000, color:'#00ff88', icon:'⚡' },
  { threshold:7, name:'ASCENSION', desc:'FULL HEAL + SHIELD', duration:0, color:'#ffaa00', icon:'👑' },
];

// ── HUD ICONS ──
const ABI_ICONS={gunner:{atk:'🔫',sec:'💣',spec:'⚡',ult:'🔥'},assassin:{atk:'⚔️',sec:'⚡',spec:'🗡',ult:'💨'},mage:{atk:'🔮',sec:'🌀',spec:'💥',ult:'🛡'},tank:{atk:'🔨',sec:'🌊',spec:'🪝',ult:'🛡'},necro:{atk:'💀',sec:'🦴',spec:'👻',ult:'☠️'},ranger:{atk:'🏹',sec:'🎯',spec:'🎯',ult:'🪤'}};
const ITEM_ICONS={rapidFire:'🔥',doubleShot:'✧✧',pierce:'➤',homing:'◎',heavy:'💣',critStrike:'💥',projSpeed:'💫',shield:'🛡',regen:'💚',armor:'🪨',fortify:'🏰',thornmail:'🌵',vitality:'❤️',speed:'💨',fastDash:'⚡',teleport:'✦',blink:'✦',boots:'👢',momentum:'🌀',phaseWalk:'👻'};

// ── PERSISTENCE ──
let PD = JSON.parse(localStorage.getItem('ra3')||'null') || {
  elo:1000, wins:0, losses:0, shots:0, hits:0,
  name:'PLAYER_'+Math.floor(Math.random()*9000+1000), cls:'gunner'
};
function savePD(){ localStorage.setItem('ra3', JSON.stringify(PD)); }
let LB = JSON.parse(localStorage.getItem('ra3lb')||'null') || genLB();
function genLB(){
  const rows=[['XCEL_V','gunner'],['VOID_SHD','assassin'],['ARCANE7','mage'],
    ['DART_Z','gunner'],['NEON_G','assassin'],['ECHO7','mage'],
    ['BOLT_X','gunner'],['PHASE','assassin'],['NOVA','mage'],['APEX','gunner']];
  return rows.map(([name,cls],i)=>({name,cls,elo:1200-i*28+Math.floor(Math.random()*40-20),wins:20-i,losses:5+i}));
}
function saveLB(){ localStorage.setItem('ra3lb', JSON.stringify(LB)); }
