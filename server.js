/**
 * Reflex Arena: Resource Wars — WebSocket Game Server v5 (ESPORTS READY)
 * 
 * Architecture:
 * - 60Hz fixed-timestep physics (matches singleplayer exactly)
 * - 60Hz binary state broadcast (~10x smaller than JSON)
 * - Deterministic simulation with authoritative server
 * - Up to 6 players per match
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import Redis from 'ioredis';
import crypto from 'crypto';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── In-memory caches for hot GET routes (invalidated on write) ──
let _cacheAssignments = null;  // sprite-assignments JSON
let _cacheSheets      = null;  // sprite-sheets JSON

// ── Ensure asset directories exist on startup ──
const SPRITE_CATEGORIES = ['tilesets', 'players', 'mobs', 'vfx', 'ui', 'misc'];
for (const cat of SPRITE_CATEGORIES) {
  fs.mkdirSync(path.join(__dirname, 'public', 'sprites', cat), { recursive: true });
}
fs.mkdirSync(path.join(__dirname, 'public', 'audio'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'public', 'maps'), { recursive: true });
// One folder per game mode — drop a .json in the folder to set the map for that mode
const MAP_MODE_DIRS = ['multiplayer', 'offline', '3v3', 'local2p', 'practice'];
for (const m of MAP_MODE_DIRS) {
  fs.mkdirSync(path.join(__dirname, 'public', 'maps', m), { recursive: true });
}

// Configure multer for file uploads

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    let folder = 'sprites';
    if (file.fieldname === 'sound') {
      folder = 'audio';
    } else {
      try {
        const urlObj = new URL(req.url, 'http://x');
        const cat = urlObj.searchParams.get('category');
        if (cat && SPRITE_CATEGORIES.includes(cat)) folder = 'sprites/' + cat;
      } catch(e) {}
    }
    const dir = path.join(__dirname, 'public', folder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    const safeName = basename.replace(/[^a-z0-9]/gi, '_');
    cb(null, `${safeName}_${timestamp}${ext}`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/wav', 'audio/ogg'];
    cb(null, allowedTypes.includes(file.mimetype));
  }
});

// Binary protocol constants (shared with client binproto.js)
const CLS_MAP = ['gunner','assassin','mage','tank','necro','ranger'];
const CLS_IDX = {}; CLS_MAP.forEach((c,i) => CLS_IDX[c] = i);
const UPG_LIST = [
  'rapidFire','doubleShot','pierce','homing','heavy','critStrike',
  'shield','regen','armor','fortify','thornmail','vitality',
  'speed','fastDash','teleport','boots','momentum','phaseWalk'
];
const UPG_IDX = {}; UPG_LIST.forEach((u,i) => UPG_IDX[u] = i);
const BIN_STATE = 0x01;
const FLAG_ALIVE=1,FLAG_SWORD_ON=2,FLAG_NOVA_ON=4,FLAG_HOOK_ON=8,FLAG_BARRIER_ON=16,FLAG_HOOK_RET=32,FLAG_HOOK_HIT=64,FLAG_NOVA_HIT=128;

function encodeBinaryState(match, elapsed, matchTimeLimit) {
  const MT = matchTimeLimit || 120;
  const players = match.players;
  const bullets = match.bullets;
  const mobBullets = match.mobBullets;
  const orbs = match.orbs;
  const grenades = match.grenades || [];
  const traps = (match.traps || []).filter(t => t.armed);
  const scoreSize = players.length * 3;
  const headerSize = 20 + scoreSize;
  let playerSize = 0;
  const playerAbilityData = [];
  for (const p of players) {
    let abilBytes = 0, flags = 0;
    if (p.alive) flags |= FLAG_ALIVE;
    if (p.swordOn) { flags |= FLAG_SWORD_ON; abilBytes += 6; }
    if (p.novaOn) { flags |= FLAG_NOVA_ON; abilBytes += 10; }
    if (p.novaHit) flags |= FLAG_NOVA_HIT;
    if (p.hookOn) { flags |= FLAG_HOOK_ON; abilBytes += 5; if (p.hookReturning) flags |= FLAG_HOOK_RET; if (p.hookHit) flags |= FLAG_HOOK_HIT; }
    if (p.barrierOn) { flags |= FLAG_BARRIER_ON; abilBytes += 4; }
    playerAbilityData.push({ flags, abilBytes });
    playerSize += 60 + abilBytes;
  }
  const totalSize = headerSize + playerSize + bullets.length*11 + mobBullets.length*10 + orbs.length*6 + grenades.length*8 + traps.length*6;
  const buf = Buffer.allocUnsafe(totalSize);
  let off = 0;
  buf[off++] = BIN_STATE;
  buf.writeUInt32LE(Math.round(match.serverTime), off); off += 4;
  buf.writeUInt32LE(match.physicsTick, off); off += 4;
  buf.writeUInt16LE(Math.round((MT - elapsed) * 10), off); off += 2;
  buf[off++] = players.length;
  buf.writeUInt16LE(bullets.length, off); off += 2;
  buf.writeUInt16LE(mobBullets.length, off); off += 2;
  buf.writeUInt16LE(orbs.length, off); off += 2;
  buf[off++] = grenades.length;
  buf[off++] = traps.length;
  for (const p of players) { buf[off++] = p.id; buf.writeUInt16LE(match.score[p.id]||0, off); off += 2; }
  for (let i = 0; i < players.length; i++) {
    const p = players[i], { flags } = playerAbilityData[i];
    buf[off++] = p.id;
    buf[off++] = CLS_IDX[p.cls] || 0;
    buf[off++] = p.team || 0;
    buf.writeUInt16LE(Math.round(p.x), off); off += 2;
    buf.writeUInt16LE(Math.round(p.y), off); off += 2;
    buf.writeInt16LE(Math.round(p.vx), off); off += 2;
    buf.writeInt16LE(Math.round(p.vy), off); off += 2;
    buf.writeInt16LE(Math.round(p.angle * 1000), off); off += 2;
    buf.writeInt16LE(Math.round(p.hp), off); off += 2;
    buf.writeUInt16LE(Math.round(p.maxHp), off); off += 2;
    buf[off++] = flags;
    buf.writeUInt16LE(p.inputSeq || 0, off); off += 2;
    buf.writeUInt16LE(Math.floor(p.energy), off); off += 2;
    buf[off++] = Math.min(255, p.killStreak || 0);
    buf[off++] = Math.min(255, Math.round(p.shield || 0));
    buf.writeUInt16LE(Math.round(Math.max(0, p.invuln || 0)), off); off += 2;
    let upgBits = 0;
    if (Array.isArray(p.upgrades)) { for (const u of p.upgrades) { const idx = UPG_IDX[u]; if (idx !== undefined) upgBits |= (1 << idx); } }
    buf.writeUInt32LE(upgBits, off); off += 4;
    buf[off++] = Math.round((p.streakDmgBoost - 1) * 100);
    buf[off++] = Math.round((p.streakSpdBoost - 1) * 100);
    buf.writeUInt16LE(Math.round(p.streakDmgTimer || 0), off); off += 2;
    buf.writeUInt16LE(Math.round(p.streakSpdTimer || 0), off); off += 2;
    buf.writeUInt16LE(Math.round(Math.max(0, p.overchargeTimer || 0)), off); off += 2;
    buf.writeUInt16LE(Math.round(Math.max(0, p.smokeTimer || 0)), off); off += 2;
    buf.writeUInt16LE(Math.round(Math.max(0, p.fortifyTimer || 0)), off); off += 2;
    buf.writeUInt16LE(Math.round(Math.max(0, p.dmgBoostTimer || 0)), off); off += 2;
    buf.writeUInt16LE(Math.round(Math.max(0, p.spdBoostTimer || 0)), off); off += 2;
    buf.writeUInt16LE(Math.round(Math.max(0, p.invisTimer || 0)), off); off += 2;
    buf.writeUInt16LE(Math.round(Math.max(0, p.drainTimer || 0)), off); off += 2;
    buf.writeUInt16LE(Math.round(Math.max(0, p.glowTimer || 0)), off); off += 2;
    buf.writeUInt16LE(Math.round(Math.max(0, p.chargeTimer || 0)), off); off += 2;
    buf.writeUInt16LE(Math.round(Math.max(0, p.adrenalineTimer || 0)), off); off += 2;
    buf.writeInt16LE(Math.round(p.smokeX || 0), off); off += 2;
    buf.writeInt16LE(Math.round(p.smokeY || 0), off); off += 2;
    if (flags & FLAG_SWORD_ON) {
      buf.writeInt16LE(Math.round((p.swordAngle||0)*1000), off); off += 2;
      buf.writeUInt16LE(Math.round((p.swordSweep||0)*1000), off); off += 2;
      buf.writeUInt16LE(Math.round(p.swordTimer||0), off); off += 2;
    }
    if (flags & FLAG_NOVA_ON) {
      buf.writeUInt16LE(Math.round(p.novaR||0), off); off += 2;
      buf.writeUInt16LE(Math.round(p.novaX||0), off); off += 2;
      buf.writeUInt16LE(Math.round(p.novaY||0), off); off += 2;
      buf.writeUInt16LE(Math.round(p.novaLife||0), off); off += 2;
      buf.writeUInt16LE(0, off); off += 2;
    }
    if (flags & FLAG_HOOK_ON) {
      buf.writeUInt16LE(Math.round(p.hookX||0), off); off += 2;
      buf.writeUInt16LE(Math.round(p.hookY||0), off); off += 2;
      buf[off++] = p.hookTarget || 0;
    }
    if (flags & FLAG_BARRIER_ON) {
      buf.writeUInt16LE(Math.round(p.barrierTimer||0), off); off += 2;
      buf.writeUInt16LE(Math.round(p.barrierHp||0), off); off += 2;
    }
  }
  for (const b of bullets) {
    buf.writeUInt16LE(Math.round(b.x), off); off += 2;
    buf.writeUInt16LE(Math.round(b.y), off); off += 2;
    buf.writeInt16LE(Math.round(b.vx), off); off += 2;
    buf.writeInt16LE(Math.round(b.vy), off); off += 2;
    buf[off++] = b.owner;
    buf[off++] = (b.r & 0x1F) | (b.isMage ? 0x20 : 0) | (b.pierce ? 0x40 : 0) | (b.homing ? 0x80 : 0);
    buf[off++] = (b.isSnipe ? 0x01 : 0) | (b.isArrow ? 0x02 : 0);
  }
  for (const mb of mobBullets) {
    const MBTYPE_IDX = {bolt:0,fire:1,lightning:2};
    buf.writeUInt16LE(Math.round(mb.x), off); off += 2;
    buf.writeUInt16LE(Math.round(mb.y), off); off += 2;
    buf.writeInt16LE(Math.round(mb.vx), off); off += 2;
    buf.writeInt16LE(Math.round(mb.vy), off); off += 2;
    buf[off++] = mb.dmg || 10;
    buf[off++] = (mb.r & 0x1F) | ((MBTYPE_IDX[mb.type||'bolt']||0) << 5);
  }
  for (const o of orbs) {
    buf.writeUInt16LE(Math.round(o.x), off); off += 2;
    buf.writeUInt16LE(Math.round(o.y), off); off += 2;
    buf[off++] = o.value;
    buf[off++] = Math.round(o.r);
  }
  for (const g of grenades) {
    buf.writeUInt16LE(Math.round(g.x), off); off += 2;
    buf.writeUInt16LE(Math.round(g.y), off); off += 2;
    buf.writeUInt16LE(Math.round(g.timer), off); off += 2;
    buf[off++] = g.owner;
    buf[off++] = 0;
  }
  for (const t of traps) {
    buf.writeUInt16LE(Math.round(t.x), off); off += 2;
    buf.writeUInt16LE(Math.round(t.y), off); off += 2;
    buf[off++] = t.owner;
    buf[off++] = t.radius;
  }
  const currentBuf = buf.slice(0, off);
  if (!match._lastBinState || match._lastBinState.length !== currentBuf.length) {
    match._lastBinState = Buffer.from(currentBuf);
    return currentBuf;
  }
  
  const comp = Buffer.allocUnsafe(currentBuf.length * 2 + 5);
  let cOff = 0;
  comp[cOff++] = 0x02; // BIN_DELTA flag
  
  for (let i = 0; i < currentBuf.length; i++) {
    const v = currentBuf[i] ^ match._lastBinState[i];
    if (v === 0) {
      let count = 1;
      while (i + 1 < currentBuf.length && (currentBuf[i+1] ^ match._lastBinState[i+1]) === 0 && count < 255) {
        count++; i++;
      }
      comp[cOff++] = 0;
      comp[cOff++] = count;
    } else {
      comp[cOff++] = v;
    }
  }
  
  match._lastBinState = Buffer.from(currentBuf);
  if (cOff < currentBuf.length) return comp.slice(0, cOff);
  return currentBuf;
}

const PORT = process.env.PORT || 9090;
const PHYSICS_RATE = 60;
const SEND_EVERY = 1; // 60Hz network — every physics tick
const ACTUAL_SEND_RATE = PHYSICS_RATE / SEND_EVERY; // 60
const PHYSICS_DT = 1 / PHYSICS_RATE;

// ── SERVER-SIDE SPATIAL HASH ─────────────────────────────────────
// Same algorithm as public/js/spatial-hash.js — shared O(1) neighbourhood queries
const _SV_SH_CELL = 200;
const _svShCells = new Map();
const _svShDirty = [];
let   _svShStamp = 0;
function _svShClear(){
  for(let i=0;i<_svShDirty.length;i++){ const a=_svShCells.get(_svShDirty[i]); if(a)a.length=0; }
  _svShDirty.length=0;
}
function _svShInsert(x,y,r,obj){
  const cs=_SV_SH_CELL,x0=(x-r)/cs|0,x1=(x+r)/cs|0,y0=(y-r)/cs|0,y1=(y+r)/cs|0;
  for(let cx=x0;cx<=x1;cx++){for(let cy=y0;cy<=y1;cy++){
    const k=(cx&0x7FFF)|((cy&0x7FFF)<<15);
    let c=_svShCells.get(k);
    if(!c){c=[];_svShCells.set(k,c);}
    if(c.length===0)_svShDirty.push(k);
    c.push(obj);
  }}
}
function _svShQuery(x,y,r,out){
  const cs=_SV_SH_CELL,x0=(x-r)/cs|0,x1=(x+r)/cs|0,y0=(y-r)/cs|0,y1=(y+r)/cs|0;
  const stamp=++_svShStamp;
  for(let cx=x0;cx<=x1;cx++){for(let cy=y0;cy<=y1;cy++){
    const k=(cx&0x7FFF)|((cy&0x7FFF)<<15);
    const c=_svShCells.get(k);
    if(!c)continue;
    for(let i=0;i<c.length;i++){const obj=c[i];if(obj._svShStamp!==stamp){obj._svShStamp=stamp;out.push(obj);}}
  }}
}
const _svShQueryOut = [];

// ═══════════════════════════════════════════════════════════════
// CLASS DEFINITIONS
// ═══════════════════════════════════════════════════════════════
const CDEFS = {
  gunner:   { name:'GUNNER',   hp:100, speed:280, radius:14, fireRate:320, bDmg:20, bSpd:540, bLife:2200, dashCd:2000, spCd:4000, ultCd:8000 },
  assassin: { name:'ASSASSIN', hp:80,  speed:370, radius:12, fireRate:280, bDmg:22, bSpd:0,   bLife:0,    dashCd:1200, spCd:3000, ultCd:10000, meleeRange:80, meleeArc:1.4 },
  mage:     { name:'MAGE',     hp:90,  speed:225, radius:15, fireRate:720, bDmg:35, bSpd:360, bLife:2800, dashCd:2800, spCd:5000, ultCd:12000 },
  tank:     { name:'TANK',     hp:160, speed:190, radius:18, fireRate:600, bDmg:18, bSpd:400, bLife:1800, dashCd:3000, spCd:6000, ultCd:14000, hookSpeed:700, hookRange:400, hookDmg:30 },
  necro:    { name:'NECRO',    hp:95,  speed:240, radius:14, fireRate:550, bDmg:28, bSpd:380, bLife:2400, dashCd:2200, spCd:5500, ultCd:13000 },
  ranger:   { name:'RANGER',   hp:85,  speed:340, radius:13, fireRate:420, bDmg:24, bSpd:620, bLife:2600, dashCd:1600, spCd:4000, ultCd:12000 }
};

const MAX_ITEMS = 6;

const UPGRADE_COSTS = {
  rapidFire:40, doubleShot:60, pierce:80, homing:100, heavy:70, critStrike:85, projSpeed:50,
  shield:50, regen:60, armor:80, fortify:90, thornmail:75, vitality:65,
  speed:45, fastDash:55, teleport:110, boots:35, momentum:70, phaseWalk:95
};

const CONSUMABLE_DEFS = {
  healthPot:    { name:'HEALTH POTION',   cost:25, icon:'❤️', desc:'Restore 50 HP instantly', stackable:true, maxStack:3 },
  dmgBoost:     { name:'DAMAGE BOOST',    cost:40, icon:'⚔️', desc:'+40% damage for 6s', stackable:true, maxStack:2 },
  speedBoost:   { name:'SPEED BOOST',     cost:30, icon:'💨', desc:'+50% speed for 5s', stackable:true, maxStack:2 },
  invulnPot:    { name:'INVULN POTION',   cost:80, icon:'✨', desc:'Invulnerable for 2s', stackable:true, maxStack:1 },
  grenade:      { name:'FRAG GRENADE',    cost:50, icon:'💣', desc:'Throw explosive, 40 AoE dmg', stackable:true, maxStack:3 },
  smokeBomb:    { name:'SMOKE BOMB',      cost:35, icon:'🌫️', desc:'Become invisible for 3s', stackable:true, maxStack:2 },
  wardStone:    { name:'WARD STONE',      cost:20, icon:'👁️', desc:'Place a vision ward for 30s', stackable:true, maxStack:3 },
  manaPot:      { name:'ENERGY ELIXIR',   cost:30, icon:'🔮', desc:'Restore 40 energy instantly', stackable:true, maxStack:3 },
  adrenaline:   { name:'ADRENALINE',      cost:55, icon:'💉', desc:'-50% cooldowns for 6s', stackable:true, maxStack:2 },
  teleScroll:   { name:'RECALL SCROLL',   cost:45, icon:'📜', desc:'Teleport back to your team tower', stackable:true, maxStack:1 }
};

const MOB_DEFS = {
  wolves:     { hp:30,  maxHp:30,  radius:9,  speed:130, dmg:8,  color:'#88aa44', atkRange:40, atkCd:700,  aggroRange:140, ranged:false },
  golems:     { hp:100, maxHp:100, radius:16, speed:50,  dmg:18, color:'#886644', atkRange:45, atkCd:1800, aggroRange:120, ranged:false, aoe:true, aoeRadius:70 },
  wraiths:    { hp:50,  maxHp:50,  radius:10, speed:90,  dmg:14, color:'#9966cc', atkRange:200,atkCd:1100, aggroRange:220, ranged:true, projSpeed:320, projColor:'#bb77ff' },
  dragon:     { hp:300, maxHp:300, radius:24, speed:65,  dmg:35, color:'#ff6600', atkRange:180,atkCd:1400, aggroRange:220, ranged:true, projSpeed:280, projColor:'#ff8833', cone:true, coneCount:3 },
  sentinel:   { hp:300, maxHp:300, radius:24, speed:65,  dmg:30, color:'#4488ff', atkRange:250,atkCd:900,  aggroRange:260, ranged:true, projSpeed:450, projColor:'#66bbff', chain:true },
  berserker:  { hp:180, maxHp:180, radius:14, speed:110, dmg:28, color:'#ff2244', atkRange:55, atkCd:900,  aggroRange:180, ranged:false },
  lich:             { hp:250,  maxHp:250,  radius:18, speed:55,  dmg:22,  color:'#aa44ff', atkRange:220, atkCd:1000, aggroRange:240, ranged:true,  projSpeed:320, projColor:'#cc66ff', cone:true, coneCount:3 },
  ancient_colossus: { hp:2500, maxHp:2500, radius:42, speed:22,  dmg:90,  color:'#8B0000', atkRange:360, atkCd:650,  aggroRange:560, ranged:true,  projSpeed:230, projColor:'#ff2200', cone:true, coneCount:5, aoe:true, aoeRadius:200 }
};

// ═══════════════════════════════════════════════════════════════
// MATCHMAKING & STATE
// ═══════════════════════════════════════════════════════════════
const queue = [];
const matches = new Map();
let matchIdCounter = 0;
let queueTimer = null;

// === REDIS SCALING LOGIC ===
let redis = null;
let redisPub = null;
let redisSub = null;
let useRedis = false;
const localClients = new Map(); // connId -> ws
const workerId = process.env.NODE_APP_INSTANCE || 'master';

try {
  redis = new Redis({ host: '127.0.0.1', port: 6379, maxRetriesPerRequest: 1, connectTimeout: 1000 });
  redisPub = new Redis({ host: '127.0.0.1', port: 6379, maxRetriesPerRequest: 1, connectTimeout: 1000 });
  redisSub = new Redis({ host: '127.0.0.1', port: 6379, maxRetriesPerRequest: 1, connectTimeout: 1000 });

  redis.on('error', () => { useRedis = false; });
  redisPub.on('error', () => { useRedis = false; });
  redisSub.on('error', () => { useRedis = false; });
  redis.on('ready', () => {
    useRedis = true;
    console.log(`[Worker ${workerId}] Connected to Redis for Global Matchmaking`);
    redisSub.subscribe('match_start', 'global_chat');
  });

  redisSub.on('message', (channel, message) => {
    if (channel === 'global_chat') {
      const msg = JSON.parse(message);
      for (const ws of localClients.values()) {
        send(ws, msg);
      }
    } else if (channel === 'match_start') {
      const data = JSON.parse(message);
      // Since proxying WebSockets across processes without IPC is complex,
      // in this Redis integration phase, we'll assign the match to the worker that popped it,
      // and notify the clients directly to reconnect to the correct server IP/Port if this was a multi-server setup.
      // For this single-port PM2 cluster, PM2 doesn't support WebSocket stickiness well, so we simulate it
      // by just printing the match start. Full WS proxying would go here.
      if (data.workerHost === workerId) {
        console.log(`[Worker ${workerId}] Hosting Match ${data.matchId} with ${data.connIds.length} players`);
      }
    }
  });
} catch (err) {
  useRedis = false;
}
// ===========================
let activeCustomMap = null; // custom map data loaded from editor
const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;
const TEAM_MODE = true;
const QUEUE_WAIT_MS = 15000;

// ═══════════════════════════════════════════════════════════════
// MAP CONSTANTS
// ═══════════════════════════════════════════════════════════════
const MAP_W = 9600;
const MAP_H = 5400;
const WIN_SCORE = 15;
const MATCH_TIME = 300;

const CAMP_DEFS = [
  { x:MAP_W*0.07, y:MAP_H*0.40, type:'wolves',   count:3, gold:45,  respawnTime:12000 },
  { x:MAP_W*0.07, y:MAP_H*0.60, type:'wolves',   count:3, gold:45,  respawnTime:12000 },
  { x:MAP_W*0.14, y:MAP_H*0.25, type:'wolves',   count:4, gold:55,  respawnTime:14000 },
  { x:MAP_W*0.14, y:MAP_H*0.75, type:'wolves',   count:4, gold:55,  respawnTime:14000 },
  { x:MAP_W*0.93, y:MAP_H*0.40, type:'wolves',   count:3, gold:45,  respawnTime:12000 },
  { x:MAP_W*0.93, y:MAP_H*0.60, type:'wolves',   count:3, gold:45,  respawnTime:12000 },
  { x:MAP_W*0.86, y:MAP_H*0.25, type:'wolves',   count:4, gold:55,  respawnTime:14000 },
  { x:MAP_W*0.86, y:MAP_H*0.75, type:'wolves',   count:4, gold:55,  respawnTime:14000 },
  { x:MAP_W*0.25, y:MAP_H*0.20, type:'golems',   count:2, gold:90,  respawnTime:20000 },
  { x:MAP_W*0.75, y:MAP_H*0.20, type:'golems',   count:2, gold:90,  respawnTime:20000 },
  { x:MAP_W*0.25, y:MAP_H*0.80, type:'golems',   count:2, gold:90,  respawnTime:20000 },
  { x:MAP_W*0.75, y:MAP_H*0.80, type:'golems',   count:2, gold:90,  respawnTime:20000 },
  { x:MAP_W*0.35, y:MAP_H*0.35, type:'wraiths',  count:3, gold:75,  respawnTime:16000 },
  { x:MAP_W*0.65, y:MAP_H*0.35, type:'wraiths',  count:3, gold:75,  respawnTime:16000 },
  { x:MAP_W*0.35, y:MAP_H*0.65, type:'wraiths',  count:3, gold:75,  respawnTime:16000 },
  { x:MAP_W*0.65, y:MAP_H*0.65, type:'wraiths',  count:3, gold:75,  respawnTime:16000 },
  { x:MAP_W*0.20, y:MAP_H*0.50, type:'berserker', count:2, gold:100, respawnTime:25000 },
  { x:MAP_W*0.80, y:MAP_H*0.50, type:'berserker', count:2, gold:100, respawnTime:25000 },
  { x:MAP_W*0.40, y:MAP_H*0.12, type:'lich',     count:1, gold:120, respawnTime:30000 },
  { x:MAP_W*0.60, y:MAP_H*0.88, type:'lich',     count:1, gold:120, respawnTime:30000 },
  { x:MAP_W*0.50, y:MAP_H*0.05, type:'dragon',   count:1, gold:250, respawnTime:60000 },
  { x:MAP_W*0.50, y:MAP_H*0.95, type:'sentinel', count:1, gold:250, respawnTime:60000 }
];

const WALL_DEFS = [
  { x:MAP_W*0.44, y:MAP_H*0.10, w:MAP_W*0.12, h:MAP_H*0.04 },
  { x:MAP_W*0.44, y:MAP_H*0.86, w:MAP_W*0.12, h:MAP_H*0.04 },
  { x:MAP_W*0.15, y:MAP_H*0.35, w:MAP_W*0.06, h:MAP_H*0.18 },
  { x:MAP_W*0.79, y:MAP_H*0.35, w:MAP_W*0.06, h:MAP_H*0.18 },
  { x:MAP_W*0.34, y:MAP_H*0.44, w:MAP_W*0.04, h:MAP_H*0.12 },
  { x:MAP_W*0.62, y:MAP_H*0.44, w:MAP_W*0.04, h:MAP_H*0.12 },
  { x:MAP_W*0.08, y:MAP_H*0.08, w:MAP_W*0.05, h:MAP_H*0.08 },
  { x:MAP_W*0.87, y:MAP_H*0.08, w:MAP_W*0.05, h:MAP_H*0.08 },
  { x:MAP_W*0.08, y:MAP_H*0.84, w:MAP_W*0.05, h:MAP_H*0.08 },
  { x:MAP_W*0.87, y:MAP_H*0.84, w:MAP_W*0.05, h:MAP_H*0.08 },
  { x:MAP_W*0.24, y:MAP_H*0.20, w:MAP_W*0.04, h:MAP_H*0.06 },
  { x:MAP_W*0.72, y:MAP_H*0.20, w:MAP_W*0.04, h:MAP_H*0.06 },
  { x:MAP_W*0.24, y:MAP_H*0.74, w:MAP_W*0.04, h:MAP_H*0.06 },
  { x:MAP_W*0.72, y:MAP_H*0.74, w:MAP_W*0.04, h:MAP_H*0.06 },
  { x:MAP_W*0.48, y:MAP_H*0.28, w:MAP_W*0.04, h:MAP_H*0.05 },
  { x:MAP_W*0.48, y:MAP_H*0.67, w:MAP_W*0.04, h:MAP_H*0.05 },
  { x:MAP_W*0.20, y:MAP_H*0.50, w:MAP_W*0.03, h:MAP_H*0.10 },
  { x:MAP_W*0.77, y:MAP_H*0.50, w:MAP_W*0.03, h:MAP_H*0.10 },
  { x:MAP_W*0.12, y:MAP_H*0.25, w:MAP_W*0.03, h:MAP_H*0.05 },
  { x:MAP_W*0.85, y:MAP_H*0.25, w:MAP_W*0.03, h:MAP_H*0.05 },
  { x:MAP_W*0.12, y:MAP_H*0.70, w:MAP_W*0.03, h:MAP_H*0.05 },
  { x:MAP_W*0.85, y:MAP_H*0.70, w:MAP_W*0.03, h:MAP_H*0.05 },
];

const SHOP_ZONE = { x:MAP_W*0.47, y:MAP_H*0.47, w:MAP_W*0.06, h:MAP_H*0.06 };

const TOWER_DEFS = [
  { team:1, x:MAP_W*0.06, y:MAP_H*0.50, hp:500, maxHp:500, radius:30, atkRange:350, atkCd:1000, lastAtk:0, dmg:25, color:'#4488ff', projColor:'#6699ff', projSpeed:400 },
  { team:2, x:MAP_W*0.94, y:MAP_H*0.50, hp:500, maxHp:500, radius:30, atkRange:350, atkCd:1000, lastAtk:0, dmg:25, color:'#ff4444', projColor:'#ff6666', projSpeed:400 },
];

const TEAM_SPAWNS = {
  1: [
    { x: MAP_W * 0.10, y: MAP_H * 0.35 },
    { x: MAP_W * 0.10, y: MAP_H * 0.50 },
    { x: MAP_W * 0.10, y: MAP_H * 0.65 },
  ],
  2: [
    { x: MAP_W * 0.90, y: MAP_H * 0.35 },
    { x: MAP_W * 0.90, y: MAP_H * 0.50 },
    { x: MAP_W * 0.90, y: MAP_H * 0.65 },
  ]
};

const TOWER_SHOP_1 = { x:MAP_W*0.03, y:MAP_H*0.42, w:MAP_W*0.06, h:MAP_H*0.16 };
const TOWER_SHOP_2 = { x:MAP_W*0.91, y:MAP_H*0.42, w:MAP_W*0.06, h:MAP_H*0.16 };

const SPAWN_POSITIONS = [
  { x: MAP_W * 0.15, y: MAP_H * 0.30 },
  { x: MAP_W * 0.85, y: MAP_H * 0.30 },
  { x: MAP_W * 0.15, y: MAP_H * 0.70 },
  { x: MAP_W * 0.85, y: MAP_H * 0.70 },
  { x: MAP_W * 0.50, y: MAP_H * 0.12 },
  { x: MAP_W * 0.50, y: MAP_H * 0.88 },
];

// ═══════════════════════════════════════════════════════════════
// HTTP + WebSocket SERVER
// ═══════════════════════════════════════════════════════════════
const httpServer = http.createServer((req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Handle file uploads and API endpoints
  if (req.method === 'POST' && req.url.startsWith('/api/upload-sprite')) {
    upload.single('sprite')(req, res, (err) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      if (!req.file) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No file uploaded' }));
        return;
      }
      let cat = null;
      try {
        const urlObj = new URL(req.url, 'http://x');
        const c = urlObj.searchParams.get('category');
        if (c && SPRITE_CATEGORIES.includes(c)) cat = c;
      } catch(e) {}
      const filePath = cat ? `/sprites/${cat}/${req.file.filename}` : `/sprites/${req.file.filename}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        path: filePath,
        category: cat || 'misc',
        originalName: req.body.name,
        size: req.file.size
      }));
    });
    return;
  }
  
  if (req.method === 'POST' && req.url === '/api/upload-sound') {
    upload.single('sound')(req, res, (err) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      if (!req.file) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No file uploaded' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        path: `/audio/${req.file.filename}`,
        originalName: req.body.name
      }));
    });
    return;
  }
  
  if (req.method === 'GET' && req.url === '/api/sprites') {
    const spritesDir = path.join(__dirname, 'public', 'sprites');
    const result = [];
    if (fs.existsSync(spritesDir)) {
      // Root-level sprites (built-in / legacy)
      fs.readdirSync(spritesDir)
        .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
        .forEach(f => result.push({ filename: f, category: 'misc', url: '/sprites/' + f }));
      // Category subfolders
      for (const cat of SPRITE_CATEGORIES) {
        const catDir = path.join(spritesDir, cat);
        if (fs.existsSync(catDir)) {
          fs.readdirSync(catDir)
            .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
            .forEach(f => result.push({ filename: f, category: cat, url: `/sprites/${cat}/${f}` }));
        }
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }
  
  if (req.method === 'GET' && req.url === '/api/sounds') {
    const audioDir = path.join(__dirname, 'public', 'audio');
    let files = [];
    if (fs.existsSync(audioDir)) {
      files = fs.readdirSync(audioDir).filter(f => /\.(mp3|wav|ogg)$/i.test(f));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(files));
    return;
  }

  // ═══ MAP SAVE/LOAD API ═══
  const mapsDir = path.join(__dirname, 'public', 'maps');
  if (!fs.existsSync(mapsDir)) fs.mkdirSync(mapsDir, { recursive: true });

  if (req.method === 'GET' && req.url === '/api/maps') {
    const files = fs.readdirSync(mapsDir).filter(f => f.endsWith('.json'));
    const maps = files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(mapsDir, f), 'utf8'));
        return { name: f.replace('.json',''), mapW: data.mapW, mapH: data.mapH, walls: (data.walls||[]).length, camps: (data.camps||[]).length, spawns: (data.spawns||[]).length, savedAt: data.savedAt || null };
      } catch { return { name: f.replace('.json','') }; }
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(maps));
    return;
  }

  const mapMatch = req.url.match(/^\/api\/maps\/([a-zA-Z0-9_\-]+)$/);
  if (mapMatch) {
    const mapName = mapMatch[1];
    const mapFile = path.join(mapsDir, mapName + '.json');
    
    if (req.method === 'GET') {
      if (!fs.existsSync(mapFile)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Map not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      fs.createReadStream(mapFile).pipe(res);
      return;
    }
    
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 5e6) { req.destroy(); } });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          data.savedAt = new Date().toISOString();
          fs.writeFileSync(mapFile, JSON.stringify(data, null, 2));
          // Update active map for new matches
          if (data.walls) activeCustomMap = data;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, name: mapName }));
        } catch(e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON: ' + e.message }));
        }
      });
      return;
    }
    
    if (req.method === 'DELETE') {
      if (fs.existsSync(mapFile)) fs.unlinkSync(mapFile);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }
  }

  // Set active map for matches
  if (req.method === 'GET' && req.url === '/api/sprite-assignments') {
    if (_cacheAssignments === null) {
      const file = path.join(__dirname, 'public', 'sprites', '_assignments.json');
      try { _cacheAssignments = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; } catch(e) { _cacheAssignments = {}; }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(_cacheAssignments));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sprite-assignments') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const file = path.join(__dirname, 'public', 'sprites', '_assignments.json');
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        _cacheAssignments = data;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Sprite sheet registry: persists sheet metadata (name, path, cols, rows) ──
  if (req.method === 'GET' && req.url === '/api/sprite-sheets') {
    if (_cacheSheets === null) {
      const file = path.join(__dirname, 'public', 'sprites', '_sheets.json');
      try { _cacheSheets = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []; } catch(e) { _cacheSheets = []; }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(_cacheSheets));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sprite-sheets') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2e5) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const file = path.join(__dirname, 'public', 'sprites', '_sheets.json');
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        _cacheSheets = data;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Map-for-mode API: GET returns the active map for a mode folder,
  //    POST deploys a named map into a mode folder (editor "Deploy" button).
  if (req.url.startsWith('/api/map-for-mode/')) {
    const mode = req.url.slice('/api/map-for-mode/'.length).split('?')[0].replace(/[^a-z0-9_\-]/gi, '');
    const modeDir = path.join(mapsDir, mode);

    if (req.method === 'GET') {
      const data = getMapForMode(mode);
      res.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data || { error: 'no map in folder' }));
      return;
    }

    if (req.method === 'POST') {
      // Body: { name: 'mapname' } — copies named map into mode folder
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 6e6) req.destroy(); });
      req.on('end', () => {
        try {
          const { name } = JSON.parse(body);
          const src = path.join(mapsDir, name + '.json');
          if (!fs.existsSync(src)) { res.writeHead(404, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'map not found'})); return; }
          if (!fs.existsSync(modeDir)) fs.mkdirSync(modeDir, { recursive: true });
          // Remove existing JSONs in the folder before placing the new one
          for (const f of fs.readdirSync(modeDir).filter(f => f.endsWith('.json'))) {
            fs.unlinkSync(path.join(modeDir, f));
          }
          fs.copyFileSync(src, path.join(modeDir, name + '.json'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch(e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  // ── List contents of all mode folders (for Map Manager UI)
  if (req.method === 'GET' && req.url === '/api/map-slots') {
    const result = {};
    for (const mode of MAP_MODE_DIRS) {
      const data = getMapForMode(mode);
      result[mode] = data ? (data.name || mode) : null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/set-active-map') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body);
        if (name === 'default') {
          activeCustomMap = null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, map: 'default' }));
          return;
        }
        const mapFile = path.join(mapsDir, name + '.json');
        if (!fs.existsSync(mapFile)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Map not found' }));
          return;
        }
        activeCustomMap = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, map: name }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/server-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      players: wss ? wss.clients.size : 0,
      matches: matches.size,
      queue: queue.length,
      activeMap: activeCustomMap ? (activeCustomMap.name || 'custom') : 'default'
    }));
    return;
  }
  
  // Serve static files from public/
  if (req.method === 'GET') {
    // Strip query string before resolving file path
    const urlPath = req.url.split('?')[0];
    let filePath = urlPath === '/' ? '/game.html' : urlPath;

    // Handle old editor route
    if (urlPath === '/editor' || urlPath === '/editor.html') {
      filePath = '/editor.html';
    }

    // Serve new React editor (built with Vite).
    // /editor2 (no trailing slash) → redirect to /editor2/ so that relative
    // ./assets/ paths in index.html resolve correctly.
    if (urlPath === '/editor2') {
      res.writeHead(301, { Location: '/editor2/' });
      res.end();
      return;
    }
    if (urlPath.startsWith('/editor2/')) {
      const editorIndex = path.join(__dirname, 'public', 'editor2', 'index.html');
      const exactFile = path.join(__dirname, 'public', urlPath);
      if (fs.existsSync(exactFile) && fs.statSync(exactFile).isFile()) {
        // fall through to normal static serving below
      } else if (fs.existsSync(editorIndex)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(editorIndex).pipe(res);
        return;
      }
    }

    const fullPath = path.join(__dirname, 'public', filePath);
    const ext = path.extname(fullPath);
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.json': 'application/json',
      '.wasm': 'application/wasm'
    };
    
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }
  }
  
  // Default response
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', players: wss ? wss.clients.size : 0, matches: matches.size, queue: queue.length }));
});

const wss = new WebSocketServer({
  server: httpServer,
  perMessageDeflate: false   // disable compression — binary state is already compact; deflate adds CPU + variable latency
});

wss.on('connection', (ws) => {
  // Disable Nagle — send packets immediately without coalescing delay
  if (ws._socket) ws._socket.setNoDelay(true);
  ws.isAlive = true;
  ws.playerId = null;
  ws.matchId = null;
  ws.playerInfo = null;
  ws.lastInputTime = 0;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => { removeFromQueue(ws); handleDisconnect(ws); });
  ws.on('error', () => { removeFromQueue(ws); handleDisconnect(ws); });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

httpServer.listen(PORT, () => {
  console.log(`\n🎮 REFLEX ARENA SERVER RUNNING`);
  console.log(`   Port    : ${PORT}`);
  console.log(`   Game    : http://localhost:${PORT}/`);
  console.log(`   Editor  : http://localhost:${PORT}/editor2/`);
  console.log(`   Physics : ${PHYSICS_RATE}Hz | Net: ${ACTUAL_SEND_RATE}Hz`);

  // ── Quick debug summary ──────────────────────────────────────────
  const mapsDir   = path.join(__dirname, 'public', 'maps');
  const mapFiles  = fs.existsSync(mapsDir)
    ? fs.readdirSync(mapsDir).filter(f => f.endsWith('.json'))
    : [];

  const assignFile = path.join(__dirname, 'public', 'sprites', '_assignments.json');
  let assignCount = 0;
  if (fs.existsSync(assignFile)) {
    try { assignCount = Object.keys(JSON.parse(fs.readFileSync(assignFile, 'utf8'))).length; } catch {}
  }

  const sheetsFile = path.join(__dirname, 'public', 'sprites', '_sheets.json');
  let sheetsCount = 0;
  if (fs.existsSync(sheetsFile)) {
    try { sheetsCount = JSON.parse(fs.readFileSync(sheetsFile, 'utf8')).length; } catch {}
  }

  console.log(`\n   📁 Maps saved   : ${mapFiles.length} (${mapFiles.map(f => f.replace('.json','')).join(', ') || 'none'})`);

  for (const mode of MAP_MODE_DIRS) {
    const active = getMapForMode(mode);
    console.log(`   🗺  ${mode.padEnd(12)}: ${active ? '✅ ' + (active.name || '?') : '— empty'}`);
  }

  console.log(`\n   🖼  Sprite sheets : ${sheetsCount}`);
  console.log(`   🎭 Assignments   : ${assignCount} (mobs/classes/vfx)`);
  console.log('');
});

// ═══════════════════════════════════════════════════════════════
// LEVEL / XP SYSTEM
// ═══════════════════════════════════════════════════════════════
// Cumulative XP required to reach each level (index = level number)
const SV_XP_FOR_LEVEL = [0, 0, 100, 250, 430, 650, 910, 1220, 1590, 2030, 2550];
const SV_TALENT_TIERS  = [2, 4, 6, 8, 10]; // levels that unlock a talent pick
const SV_XP_KILL       = 120;
const SV_XP_KILL_BONUS = 15;  // × victim.level
const SV_XP_ORB        = 12;
const SV_XP_CAMP       = { wolves:28, golems:55, wraiths:50, dragon:180, sentinel:180, berserker:70, lich:110, ancient_colossus:400 };

// Set of all valid talent IDs — prevents clients injecting fake talents
const ALL_TALENT_IDS = new Set([
  'gn_hollow','gn_vest','gn_extmag','gn_incend','gn_medic','gn_suppress',
  'gn_turret','gn_grndier','gn_rapid','gn_shred','gn_execute','gn_veteran','gn_annihil','gn_berserk','gn_fortress',
  'as_quick','as_shadow','as_viper','as_bleed','as_counter','as_smoke2',
  'as_mark','as_clone','as_storm','as_pred','as_shroud','as_phantom','as_lethal','as_thousand','as_rampage',
  'mg_arcane','mg_mshield','mg_missiles','mg_chain','mg_frost','mg_surge',
  'mg_meteor','mg_warp','mg_master','mg_void','mg_force','mg_ethreal','mg_apoc','mg_transcend','mg_inf',
  'tk_iron','tk_counter','tk_bulwark','tk_shatter','tk_unstop','tk_cry',
  'tk_titan','tk_fortress2','tk_warlord','tk_jugger','tk_rally','tk_last','tk_impen','tk_coloss','tk_warcry',
  'nc_pact','nc_bone','nc_plague','nc_drain','nc_strong','nc_cursed',
  'nc_lich2','nc_coil','nc_aura','nc_sacr','nc_epid','nc_corrupt','nc_undying','nc_army','nc_pest',
  'rg_eagle','rg_mark','rg_quiver','rg_barbed','rg_forest','rg_multi',
  'rg_sniper','rg_rain','rg_camo','rg_call','rg_arrow','rg_wind','rg_eagle10','rg_death','rg_storm'
]);

function serverGrantXP(match, p, amount) {
  if (!p || !p.ws || p.level >= 10) return;
  p.xp = (p.xp || 0) + amount;
  let leveled = false;
  while (p.level < 10 && p.xp >= SV_XP_FOR_LEVEL[p.level + 1]) {
    p.level++;
    leveled = true;
    // Per-level passive stat bonus
    p.maxHp += 10;
    p.hp = Math.min(p.maxHp, p.hp + 10);
    p.lvlDmgMult = (p.lvlDmgMult || 1) + 0.02;
    p.lvlCdr     = Math.max(0.3, (p.lvlCdr || 1) - 0.02);
    // Talent tier unlock
    const tierIdx = SV_TALENT_TIERS.indexOf(p.level);
    if (tierIdx >= 0) {
      p.talentQueue.push(tierIdx);
      send(p.ws, { type:'levelUp', level:p.level, tierIdx, xp:p.xp, xpFor:SV_XP_FOR_LEVEL[p.level + 1] || 0 });
    } else {
      send(p.ws, { type:'levelUp', level:p.level, tierIdx:-1, xp:p.xp, xpFor:SV_XP_FOR_LEVEL[p.level + 1] || 0 });
    }
  }
  // Always send current XP state so the bar stays accurate
  send(p.ws, { type:'xpGain', xp:p.xp, level:p.level, xpFor:SV_XP_FOR_LEVEL[Math.min(10, p.level + 1)] || 0, leveled });
}

function serverApplyTalentEffect(p, id) {
  // Immediate stat changes only — behavioural flags are checked inline via p.talents[id]
  switch (id) {
    case 'gn_hollow':   p.lvlDmgMult = (p.lvlDmgMult||1) * 1.25; break;
    case 'gn_vest':     p.maxHp += 30; p.hp = Math.min(p.maxHp, p.hp + 30); p.speed = Math.round(p.speed * 1.1); break;
    case 'gn_rapid':    p.fireRate = Math.round(p.fireRate * 0.7); break;
    case 'gn_veteran':  p.maxHp += 50; p.hp = Math.min(p.maxHp, p.hp + 50); break;
    case 'gn_fortress': p.shield = Math.max(p.shield || 0, 40); break;
    case 'as_quick':    p.fireRate = Math.round(p.fireRate * 0.8); break;
    case 'as_thousand': p.fireRate = Math.round(p.fireRate * 0.33); p.lvlDmgMult = (p.lvlDmgMult||1) * 0.5; break;
    case 'mg_arcane':   p.lvlDmgMult = (p.lvlDmgMult||1) * 1.25; break;
    case 'mg_master':   p.lvlDmgMult = (p.lvlDmgMult||1) * 1.15; p.lvlCdr = Math.max(0.3, (p.lvlCdr||1) * 0.75); break;
    case 'tk_iron':     p.maxHp += 40; p.hp = Math.min(p.maxHp, p.hp + 40); break;
    case 'tk_rally':    p.rallyCharge = 1; break;
    case 'tk_unstop':   p.speed = Math.round(p.speed * 1.15); break;
    case 'tk_titan':    p.maxHp += 80; p.hp = Math.min(p.maxHp, p.hp + 80); break;
    case 'tk_coloss':   p.maxHp += 150; p.hp = Math.min(p.maxHp, p.hp + 150); break;
    case 'nc_bone':     p.shield = Math.max(p.shield || 0, 20); break;
    case 'nc_undying':  p.undyingCharge = 1; break;
    case 'rg_eagle':    p.lvlDmgMult = (p.lvlDmgMult||1) * 1.1; break;
    case 'rg_forest':   p.speed = Math.round(p.speed * 1.3); break;
    case 'rg_wind':     p.speed = Math.round(p.speed * 1.5); break;
    case 'rg_death':    p.lvlDmgMult = (p.lvlDmgMult||1) * 2.0; break;
  }
}

function handleTalentPick(ws, msg) {
  const match = matches.get(ws.matchId);
  if (!match || match.gameOver) return;
  const p = getPlayer(match, ws.playerId);
  if (!p) return;
  const talentId = String(msg.talentId || '');
  const tierIdx  = typeof msg.tier === 'number' ? msg.tier : -1;
  if (!ALL_TALENT_IDS.has(talentId)) return;
  const qi = (p.talentQueue || []).indexOf(tierIdx);
  if (qi < 0) return; // tier not unlocked — reject
  p.talentQueue.splice(qi, 1);
  p.talents[talentId] = true;
  serverApplyTalentEffect(p, talentId);
  send(ws, { type:'talentPicked', talentId, tier:tierIdx });
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE HANDLING
// ═══════════════════════════════════════════════════════════════
function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'ping':
      sendRaw(ws, `{"type":"pong","t":${msg.t}}`);
      break;
    case 'queue':
      ws.playerInfo = {
        name: String(msg.name || 'PLAYER').substring(0, 20),
        cls: ['gunner','assassin','mage','tank','necro','ranger'].includes(msg.cls) ? msg.cls : 'gunner',
        elo: Math.max(0, Math.min(9999, parseInt(msg.elo) || 1000))
      };
      addToQueue(ws);
      break;
    case 'input':
      handleInput(ws, msg);
      break;
    case 'buyUpgrade':
      handleBuyUpgrade(ws, msg);
      break;
    case 'useUltimate':
      handleUseUltimate(ws);
      break;
    case 'useSpecial':
    case 'special':
      handleUseSpecial(ws);
      break;
    case 'secondary':
      handleUseSecondary(ws);
      break;
    case 'useConsumable':
      handleUseConsumable(ws, msg);
      break;
    case 'buyConsumable':
      handleBuyConsumable(ws, msg);
      break;
    case 'talentPick':
      handleTalentPick(ws, msg);
      break;
    case 'forfeit': {
      const m = ws.matchId ? matches.get(ws.matchId) : null;
      if (!m || m.gameOver) break;
      const fp = m.players.find(p => p.ws === ws);
      if (!fp) break;

      // Mark player dead
      fp.alive = false;
      fp.hp = 0;

      // Notify all players (including forfeiter, so they see the killfeed entry)
      broadcastMatchRaw(m, JSON.stringify({
        type: 'playerForfeited',
        playerId: fp.id,
        name: ws.playerInfo?.name || 'PLAYER'
      }));

      // Send matchEnd only to the forfeiting player
      const eloLoss = -Math.round(10 + Math.random() * 8);
      sendRaw(fp.ws, JSON.stringify({
        type: 'matchEnd',
        winner: 0,
        score: { ...m.score },
        eloChange: { [fp.id]: eloLoss },
        rankings: m.players.map(p => ({
          id: p.id,
          name: p.ws.playerInfo?.name || 'PLAYER',
          cls: p.cls,
          score: m.score[p.id] || 0,
          elo: p.id === fp.id ? eloLoss : 0
        })).sort((a, b) => b.score - a.score)
      }));

      // Remove forfeiting player from match
      m.players = m.players.filter(p => p.ws !== ws);
      delete m.score[ws.playerId];
      ws.matchId = null;

      // End match for everyone if too few players remain
      const remaining = m.players.filter(p => p.ws.readyState === WebSocket.OPEN);
      if (remaining.length < 2) {
        endMatch(m);
      }
      break;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// QUEUE & MATCHMAKING
// ═══════════════════════════════════════════════════════════════
function addToQueue(ws) {
  if (!ws.connId) { ws.connId = crypto.randomUUID(); localClients.set(ws.connId, ws); }
  ws.on('close', () => { localClients.delete(ws.connId); if(useRedis) redis.lrem('queue', 0, ws.connId); });
  
  removeFromQueue(ws);
  if (useRedis) {
    redis.lpush('queue', ws.connId).then(len => {
      send(ws, { type:'queued', position:len });
      tryMatch();
    });
  } else {
    queue.push({ ws, joinedAt: Date.now() });
    send(ws, { type:'queued', position:queue.length });
    tryMatch();
  }
}

function removeFromQueue(ws) {
  if (useRedis && ws.connId) {
    redis.lrem('queue', 0, ws.connId);
  }
  const idx = queue.findIndex(q => q.ws === ws);
  if (idx !== -1) queue.splice(idx, 1);
}

function tryMatch() {
  if (useRedis) {
    redis.llen('queue').then(len => {
      if (len >= MAX_PLAYERS) {
        redis.rpop('queue', MAX_PLAYERS).then(connIds => {
          if(connIds && connIds.length > 0) redisPub.publish('match_start', JSON.stringify({ matchId: crypto.randomUUID(), connIds, workerHost: workerId }));
        });
      } else if (len >= MIN_PLAYERS && !queueTimer) {
        queueTimer = setTimeout(async () => {
          queueTimer = null;
          const currentLen = await redis.llen('queue');
          if (currentLen >= MIN_PLAYERS) {
            const count = Math.min(currentLen, MAX_PLAYERS);
            const connIds = await redis.rpop('queue', count);
            if(connIds && connIds.length > 0) redisPub.publish('match_start', JSON.stringify({ matchId: crypto.randomUUID(), connIds, workerHost: workerId }));
          }
        }, QUEUE_WAIT_MS);
      }
    });
    return;
  }

  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].ws.readyState !== WebSocket.OPEN) queue.splice(i, 1);
  }

  if (queue.length >= MAX_PLAYERS) {
    const players = queue.splice(0, MAX_PLAYERS).map(q => q.ws);
    if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
    createMatch(players);
    return;
  }

  if (queue.length >= MIN_PLAYERS && !queueTimer) {
    queueTimer = setTimeout(() => {
      queueTimer = null;
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].ws.readyState !== WebSocket.OPEN) queue.splice(i, 1);
      }
      if (queue.length >= MIN_PLAYERS) {
        const count = Math.min(queue.length, MAX_PLAYERS);
        const players = queue.splice(0, count).map(q => q.ws);
        createMatch(players);
      }
    }, QUEUE_WAIT_MS);

    for (const q of queue) {
      send(q.ws, { type:'queueCountdown', players: queue.length, max: MAX_PLAYERS, waitMs: QUEUE_WAIT_MS });
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// MATCH CREATION
// ═══════════════════════════════════════════════════════════════
function isInsideWallServer(x, y, r, walls) {
  for (const w of walls) {
    if (x + r > w.x && x - r < w.x + w.w && y + r > w.y && y - r < w.y + w.h) return true;
  }
  return false;
}

function findSafeSpawnServer(x, y, r, walls) {
  if (!isInsideWallServer(x, y, r, walls)) return { x, y };
  for (let attempt = 0; attempt < 20; attempt++) {
    const tx = x + (Math.random() - 0.5) * 120;
    const ty = y + (Math.random() - 0.5) * 120;
    if (!isInsideWallServer(tx, ty, r, walls)) return { x: tx, y: ty };
  }
  return { x: MAP_W * 0.5, y: MAP_H * 0.5 };
}

// Returns the newest .json from public/maps/<mode>/ or null if the folder is empty.
function getMapForMode(mode) {
  const dir = path.join(__dirname, 'public', 'maps', mode);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  if (!files.length) return null;
  const newest = files
    .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0].f;
  try { return JSON.parse(fs.readFileSync(path.join(dir, newest), 'utf8')); } catch(e) { return null; }
}

function createMatch(wsArray) {
  const id = ++matchIdCounter;

  // Load map from multiplayer mode folder; fall back to activeCustomMap
  const customMap = getMapForMode('multiplayer') || activeCustomMap;
  const matchMapW = customMap?.mapW || MAP_W;
  const matchMapH = customMap?.mapH || MAP_H;
  const matchWalls = customMap?.walls?.map(w => ({...w})) || WALL_DEFS.slice();
  const matchShopZone = customMap?.shopZone || SHOP_ZONE;
  const matchCampDefs = customMap?.camps || CAMP_DEFS;
  const matchTowerDefs = customMap?.towers?.map(t => ({
    ...t, hp: t.hp||500, maxHp: t.maxHp||500, radius: t.radius||30,
    atkRange: t.atkRange||350, atkCd: t.atkCd||1000, dmg: t.dmg||25,
    color: t.team===1?'#4488ff':'#ff4444', projColor: t.team===1?'#6699ff':'#ff6666', projSpeed: 400,
    lastAtk: 0, alive: true
  })) || (TEAM_MODE ? TOWER_DEFS.map(td => ({ ...td, lastAtk: 0, alive: true })) : []);
  const matchSpawns = customMap?.spawns || null;
  
  let customTeamSpawns = null;
  if (matchSpawns && matchSpawns.length > 0) {
    customTeamSpawns = { 1: matchSpawns.filter(s => s.team === 1), 2: matchSpawns.filter(s => s.team === 2) };
    if (!customTeamSpawns[1].length) customTeamSpawns[1] = [{ x: matchMapW * 0.1, y: matchMapH * 0.5 }];
    if (!customTeamSpawns[2].length) customTeamSpawns[2] = [{ x: matchMapW * 0.9, y: matchMapH * 0.5 }];
  }

  const players = wsArray.map((ws, i) => {
    const info = ws.playerInfo;
    const team = TEAM_MODE ? (i % 2 === 0 ? 1 : 2) : 0;
    let spawn;
    if (TEAM_MODE) {
      const teamSpawns = customTeamSpawns ? customTeamSpawns[team] : TEAM_SPAWNS[team];
      const spawnIdx = Math.floor(i / 2) % teamSpawns.length;
      spawn = teamSpawns[spawnIdx];
    } else {
      spawn = (matchSpawns && matchSpawns[i]) || SPAWN_POSITIONS[i] || { x: matchMapW * 0.5, y: matchMapH * 0.5 };
    }
    const p = makeServerPlayer(i + 1, spawn.x, spawn.y, info.cls, ws);
    p.team = team;
    p.color = TEAM_MODE ? (team === 1 ? '#4488ff' : '#ff4444') : CDEFS[info.cls]?.color || '#fff';
    return p;
  });

  const match = {
    id,
    startTime: Date.now(),
    players,
    teamMode: TEAM_MODE,
    towers: matchTowerDefs,
    bullets: [],
    mobBullets: [],
    orbs: [],
    grenades: [],
    traps: [],
    camps: createCampsFromDefs(matchCampDefs),
    walls: matchWalls,
    shopZone: matchShopZone,
    towerShops: TEAM_MODE ? (customMap?.towerShops || [
      customMap ? { x: matchMapW*0.01, y: matchMapH*0.42, w: matchMapW*0.06, h: matchMapH*0.16 } : TOWER_SHOP_1,
      customMap ? { x: matchMapW*0.93, y: matchMapH*0.42, w: matchMapW*0.06, h: matchMapH*0.16 } : TOWER_SHOP_2
    ]) : [],
    score: {},
    teamScore: { 1: 0, 2: 0 },
    gameOver: false,
    tickInterval: null,
    physicsTick: 0,
    orbSpawnTimer: 0,
    nowCache: Date.now(),
    serverTime: 0,
    lastBroadcast: null,
    topScore: 0,
    campsDirty: true,    // set whenever mobs/towers change — avoids redundant JSON.stringify
    campsSyncCache: null,
    mapW: matchMapW,
    mapH: matchMapH,
    customSpawns: customTeamSpawns,
    spriteSheets: (()=>{
      const mapSheets = customMap?.spriteSheets || [];
      const gf = path.join(__dirname, 'public', 'sprites', '_sheets.json');
      let globalSheets = [];
      try { if(fs.existsSync(gf)) globalSheets = JSON.parse(fs.readFileSync(gf,'utf8')); } catch(e) {}
      const seen = new Set(mapSheets.map(s=>s.name));
      return [...mapSheets, ...globalSheets.filter(s=>!seen.has(s.name))];
    })(),
    spriteAssignments: (()=>{
      const f = path.join(__dirname, 'public', 'sprites', '_assignments.json');
      try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; } catch(e) { return {}; }
    })(),
    tileLayers: customMap?.tileLayers || [],
    objectLayers: customMap?.objectLayers || []
  };

  for (const p of match.players) {
    match.score[p.id] = 0;
    const safe = findSafeSpawnServer(p.x, p.y, p.radius, match.walls);
    p.x = safe.x; p.y = safe.y;
  }

  for (const p of match.players) {
    p.ws.playerId = p.id;
    p.ws.matchId = id;
  }

  matches.set(id, match);

  const allPlayersInfo = match.players.map(p => ({
    id: p.id,
    name: p.ws.playerInfo.name,
    cls: p.cls,
    elo: p.ws.playerInfo.elo,
    team: p.team,
    color: p.color,
    x: Math.round(p.x),
    y: Math.round(p.y)
  }));

  const towersInfo = match.towers.map(t => ({
    team: t.team, x: Math.round(t.x), y: Math.round(t.y),
    hp: t.hp, maxHp: t.maxHp, radius: t.radius, atkRange: t.atkRange,
    color: t.color, alive: t.alive
  }));

  for (const p of match.players) {
    const matchMsg = JSON.stringify({
      type: 'matchStart',
      playerId: p.id,
      players: allPlayersInfo,
      walls: match.walls,
      shopZone: match.shopZone,
      towerShops: match.towerShops,
      towers: towersInfo,
      teamMode: match.teamMode,
      mapW: match.mapW, mapH: match.mapH,
      physicsRate: PHYSICS_RATE, sendRate: ACTUAL_SEND_RATE,
      maxPlayers: match.players.length,
      spriteSheets: match.spriteSheets,
      spriteAssignments: match.spriteAssignments,
      tileLayers: match.tileLayers
    });
    sendRaw(p.ws, matchMsg);
  }

  // Self-correcting loop — compensates for OS timer jitter (setTimeout has ~1-4ms variance on Windows)
  // Uses setImmediate for catch-up ticks so we never fall behind without a syscall stall.
  const TICK_MS = 1000 / PHYSICS_RATE;
  let nextTick = Date.now() + TICK_MS;
  function scheduledTick() {
    if (match.gameOver) return;
    tickMatch(match);
    nextTick += TICK_MS;
    const remaining = nextTick - Date.now();
    match.tickInterval = remaining <= 1
      ? setImmediate(scheduledTick)
      : setTimeout(scheduledTick, remaining - 1);
  }
  match.tickInterval = setTimeout(scheduledTick, TICK_MS);
}

function makeServerPlayer(id, x, y, cls, ws) {
  const d = CDEFS[cls];
  return {
    id, x, y, cls, ws,
    team: 0,
    color: '#fff',
    vx:0, vy:0, radius:d.radius, speed:d.speed,
    hp:d.hp, maxHp:d.hp, shield:0,
    angle: id === 1 ? 0 : Math.PI,
    fireRate:d.fireRate, lastShot:0,
    dashCd:d.dashCd, lastDash:0,
    spCd:d.spCd, lastSp:0, secCd:d.secCd||7000, lastSec:-9999,
    ultCd:d.ultCd, lastUlt:0,
    energy:0, upgrades:[],
    alive:true, invuln:0,
    regenT:0, regenT2:0,
    killStreak:0,
    streakSpdBoost:1, streakDmgBoost:1,
    streakDmgTimer:0, streakSpdTimer:0,
    swordOn:false, swordAngle:0, swordSweep:0, swordTimer:0,
    novaOn:false, novaR:0, novaX:0, novaY:0, novaLife:0, novaHit:false,
    overchargeTimer:0, smokeTimer:0, smokeX:0, smokeY:0,
    barrierOn:false, barrierTimer:0, barrierHp:0,
    hookOn:false, hookX:0, hookY:0, hookVx:0, hookVy:0, hookTimer:0, hookTarget:null, hookReturning:false, hookHit:false,
    fortifyTimer:0,
    inputSeq:0,
    input: { ax:0, ay:0, angle:0, shoot:false, dash:false, special:false },
    minions: [],
    drainTarget: null, drainTimer: 0,
    charging: false, chargeTimer: 0,
    consumables: [null, null, null, null, null],
    dmgBoostTimer: 0, spdBoostTimer: 0,
    adrenalineTimer: 0, invisTimer: 0,
    level: 1, xp: 0, talents: {}, lvlDmgMult: 1.0, lvlCdr: 1.0,
    talentQueue: [], undyingCharge: 0, _rampageStacks: 0
  };
}

// ═══════════════════════════════════════════════════════════════
// INPUT HANDLING
// ═══════════════════════════════════════════════════════════════
function handleInput(ws, msg) {
  const now = Date.now();
  if (now - ws.lastInputTime < 8) return;
  ws.lastInputTime = now;

  const match = matches.get(ws.matchId);
  if (!match || match.gameOver) return;
  const p = getPlayer(match, ws.playerId);
  if (!p) return;

  if (msg.seq && msg.seq <= (p.inputSeq || 0)) return;
  p.inputSeq = msg.seq || 0;
  
  p.input.ax     = clamp(msg.ax || 0, -1, 1);
  p.input.ay     = clamp(msg.ay || 0, -1, 1);
  p.input.angle  = typeof msg.angle === 'number' ? msg.angle : p.angle;
  p.input.shoot  = !!msg.shoot;
  p.input.dash   = !!msg.dash;
  p.input.special= !!msg.special;
}

function handleBuyUpgrade(ws, msg) {
  const match = matches.get(ws.matchId);
  if (!match || match.gameOver) return;
  const p = getPlayer(match, ws.playerId);
  if (!p || p.upgrades.length >= MAX_ITEMS) return;
  if (p.upgrades.includes(msg.id)) return;
  
  const cost = UPGRADE_COSTS[msg.id];
  if (!cost) return;
  if (p.energy < cost) return;
  
  p.energy -= cost;
  p.upgrades.push(msg.id);
  
  if (msg.id === 'fortify') { p.maxHp += 50; p.hp = Math.min(p.maxHp, p.hp + 50); }
  if (msg.id === 'vitality') { p.maxHp += 30; p.hp = Math.min(p.maxHp, p.hp + 30); }
  if (msg.id === 'shield') { p.shield = 30; }
  
  send(ws, { type:'upgradeBought', id:msg.id, energy:p.energy });
}

function handleUseUltimate(ws) {
  const match = matches.get(ws.matchId);
  if (!match || match.gameOver) return;
  const p = getPlayer(match, ws.playerId);
  if (!p || !p.alive) return;
  const now = match.nowCache;
  if ((now - p.lastUlt) < p.ultCd) return;
  p.lastUlt = now;
  serverTriggerUltimate(match, p);
}

function handleUseSecondary(ws) {
  const match = matches.get(ws.matchId);
  if (!match || match.gameOver) return;
  const p = getPlayer(match, ws.playerId);
  if (!p || !p.alive) return;
  const now = match.nowCache;
  const secCd = p.secCd || 7000;
  if ((now - (p.lastSec || -9999)) < secCd) return;
  p.lastSec = now;
  broadcastMatchRaw(match, JSON.stringify({ type:'secondaryUsed', playerId:p.id, cls:p.cls }));
}

function handleUseSpecial(ws) {
  const match = matches.get(ws.matchId);
  if (!match || match.gameOver) return;
  const p = getPlayer(match, ws.playerId);
  if (!p || !p.alive) return;
  const now = match.nowCache;
  if ((now - p.lastSp) < p.spCd) return;
  p.lastSp = now;
  serverTriggerSpecial(match, p);
  broadcastMatchRaw(match, JSON.stringify({ type:'specialUsed', playerId:p.id, cls:p.cls }));
}

function getPlayer(match, id) {
  return match.players.find(p => p.id === id) || null;
}

function isAllyServer(a, b, match) {
  if (!match.teamMode) return a.id === b.id;
  return a.team === b.team && a.team > 0;
}

// ═══════════════════════════════════════════════════════════════
// TOWER UPDATE
// ═══════════════════════════════════════════════════════════════
function updateTowers(match, dt, now) {
  if (!match.towers) return;
  for (const tower of match.towers) {
    if (!tower.alive) continue;
    let target = null, minD2 = tower.atkRange * tower.atkRange;
    for (const p of match.players) {
      if (!p.alive || p.invuln > 0 || p.team === tower.team) continue;
      const dx = p.x - tower.x, dy = p.y - tower.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < minD2) { minD2 = d2; target = p; }
    }
    if (target && (now - tower.lastAtk) > tower.atkCd) {
      tower.lastAtk = now;
      const angle = Math.atan2(target.y - tower.y, target.x - tower.x);
      match.mobBullets.push({
        x: tower.x + Math.cos(angle) * tower.radius,
        y: tower.y + Math.sin(angle) * tower.radius,
        vx: Math.cos(angle) * tower.projSpeed,
        vy: Math.sin(angle) * tower.projSpeed,
        dmg: tower.dmg, r: 6, life: 1200,
        color: tower.projColor || tower.color,
        type: 'bolt', towerTeam: tower.team
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// SERVER TICK
// ═══════════════════════════════════════════════════════════════
function tickMatch(match) {
  if (match.gameOver) return;
  
  const now = Date.now();
  match.nowCache = now;
  match.physicsTick++;
  match.serverTime += PHYSICS_DT * 1000;
  
  const elapsed = (now - match.startTime) / 1000;

  if (elapsed >= MATCH_TIME || match.topScore >= WIN_SCORE) {
    endMatch(match);
    return;
  }

  for (const p of match.players) {
    if (!p.alive) continue;
    updatePlayer(match, p, PHYSICS_DT, now);
    if (p.minions && p.minions.length > 0) {
      updateMinions(match, p, PHYSICS_DT, now);
    }
    if (p.dmgBoostTimer > 0) { p.dmgBoostTimer -= PHYSICS_DT * 1000; if (p.dmgBoostTimer <= 0) p.dmgBoostTimer = 0; }
    if (p.spdBoostTimer > 0) { p.spdBoostTimer -= PHYSICS_DT * 1000; if (p.spdBoostTimer <= 0) p.spdBoostTimer = 0; }
    if (p.drainTimer > 0) p.drainTimer -= PHYSICS_DT * 1000;
    if (p.adrenalineTimer > 0) { p.adrenalineTimer -= PHYSICS_DT * 1000; if (p.adrenalineTimer <= 0) p.adrenalineTimer = 0; }
    if (p.invisTimer > 0) { p.invisTimer -= PHYSICS_DT * 1000; if (p.invisTimer <= 0) p.invisTimer = 0; }
  }
  // Universal Spatial Hash Build
  _svShClear();
  for (const p of match.players) {
    if (p.alive) { p._shType = 'player'; _svShInsert(p.x, p.y, p.radius, p); }
    if (p.minions) {
      for (const m of p.minions) { if (m.alive) { m._shType = 'minion'; _svShInsert(m.x, m.y, m.radius || 8, m); } }
    }
  }
  for (const c of match.camps) {
    for (const mob of c.mobs) {
      if (mob.alive) { mob._shType = 'mob'; _svShInsert(mob.x, mob.y, mob.radius, mob); }
    }
  }
  if (match.towers) {
    for (const tw of match.towers) {
      if (tw.hp > 0) { tw._shType = 'tower'; _svShInsert(tw.x, tw.y, tw.radius, tw); }
    }
  }
  if (match.traps) {
    for (const trap of match.traps) {
      if (trap.armed) { trap._shType = 'trap'; _svShInsert(trap.x, trap.y, trap.radius, trap); }
    }
  }
  updateBullets(match, PHYSICS_DT);
  updateMobBullets(match, PHYSICS_DT);
  updateOrbs(match);
  updateGrenades(match, PHYSICS_DT);
  updateTraps(match, PHYSICS_DT);
  updateTowers(match, PHYSICS_DT, match.nowCache);

  match.orbSpawnTimer += PHYSICS_DT * 1000;
  if (match.orbs.length < 18 && match.orbSpawnTimer > 1200) {
    match.orbSpawnTimer = 0;
    spawnOrb(match);
  }

  if (match.physicsTick % 4 === 0) {
    updateCamps(match, PHYSICS_DT * 4, now);
  }

  if (match.physicsTick % SEND_EVERY === 0) {
    broadcastState(match, elapsed);
  }
}

function updatePlayer(match, p, dt, now) {
  const inp = p.input;
  p.angle = inp.angle;

  let spdMult = 1;
  if (p.upgrades.includes('speed')) spdMult += 0.3;
  if (p.upgrades.includes('boots')) spdMult += 0.15;
  if (p.smokeTimer > 0) spdMult *= 1.4;
  if (p.streakSpdBoost > 1) spdMult *= p.streakSpdBoost;
  if (p.spdBoostTimer > 0) spdMult *= 1.5;
  const spd = p.speed * spdMult;
  const accel = 2200;

  p.vx += inp.ax * accel * dt;
  p.vy += inp.ay * accel * dt;
  const friction = 1 - Math.min(1, 6.5 * dt);
  p.vx *= friction;
  p.vy *= friction;
  if (Math.abs(p.vx) < 0.5) p.vx = 0;
  if (Math.abs(p.vy) < 0.5) p.vy = 0;
  const s = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
  if (s > spd) { p.vx = (p.vx / s) * spd; p.vy = (p.vy / s) * spd; }

  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.x = clamp(p.x, p.radius, MAP_W - p.radius);
  p.y = clamp(p.y, p.radius, MAP_H - p.radius);
  checkWallCollision(p, match.walls);

  if (p.upgrades.includes('regen')) {
    p.regenT += dt * 1000;
    if (p.regenT > 850) { p.hp = Math.min(p.maxHp, p.hp + 1); p.regenT = 0; }
  }
  if (p.upgrades.includes('vitality')) {
    p.regenT2 += dt * 1000;
    if (p.regenT2 > 500) { p.hp = Math.min(p.maxHp, p.hp + 1); p.regenT2 = 0; }
  }

  if (p.streakDmgTimer > 0) {
    p.streakDmgTimer -= dt * 1000;
    if (p.streakDmgTimer <= 0) { p.streakDmgBoost = 1; p.streakDmgTimer = 0; }
  }
  if (p.streakSpdTimer > 0) {
    p.streakSpdTimer -= dt * 1000;
    if (p.streakSpdTimer <= 0) { p.streakSpdBoost = 1; p.streakSpdTimer = 0; }
  }

  const effDcd = p.dashCd * (p.upgrades.includes('fastDash') ? 0.6 : 1);
  if (inp.dash && (now - p.lastDash) > effDcd) {
    const oldX = p.x, oldY = p.y;
    if (p.upgrades.includes('teleport')) {
       p.x = clamp(p.x + Math.cos(p.angle) * 280, p.radius, MAP_W - p.radius);
       p.y = clamp(p.y + Math.sin(p.angle) * 280, p.radius, MAP_H - p.radius);
      checkWallCollision(p, match.walls);
    } else {
      const dl = Math.sqrt(inp.ax * inp.ax + inp.ay * inp.ay);
      const ddx = dl > 0.1 ? inp.ax / dl : Math.cos(p.angle);
      const ddy = dl > 0.1 ? inp.ay / dl : Math.sin(p.angle);
      const dashPow = p.upgrades.includes('boots') ? 1600 : 1500;
       p.vx = ddx * dashPow;
       p.vy = ddy * dashPow;
    }
    p.lastDash = now;
    p.invuln = 200;
    broadcastMatchRaw(match, JSON.stringify({
      type:'dash', playerId:p.id,
      fromX:Math.round(oldX), fromY:Math.round(oldY),
      toX:Math.round(p.x), toY:Math.round(p.y),
      teleport:!!p.upgrades.includes('teleport')
    }));
  }

  if (p.invuln > 0) p.invuln -= dt * 1000;

  const d = CDEFS[p.cls];
  let fr = p.upgrades.includes('rapidFire') ? d.fireRate * 0.58 :
           p.upgrades.includes('heavy') ? d.fireRate * 1.8 : d.fireRate;
  if (p.overchargeTimer > 0) fr *= 0.33;
  
  if (p.cls === 'ranger') {
    if (inp.shoot) {
      if (!p.charging) { p.charging = true; p.chargeTimer = 0; }
      p.chargeTimer += dt * 1000;
      if (p.chargeTimer >= 1200) {
        let dmg = Math.round(d.bDmg * 3.5);
        if (p.streakDmgBoost > 1) dmg = Math.round(dmg * p.streakDmgBoost);
        if (p.dmgBoostTimer > 0) dmg = Math.round(dmg * 1.4);
        let snipeSpd = d.bSpd * 1.4;
        if (p.upgrades.includes('projSpeed')) snipeSpd = Math.round(snipeSpd * 1.3);
        match.bullets.push({
          x: p.x + Math.cos(p.angle) * 20, y: p.y + Math.sin(p.angle) * 20,
          vx: Math.cos(p.angle) * snipeSpd, vy: Math.sin(p.angle) * snipeSpd,
          owner: p.id, isMage: false, dmg, r: 7,
          life: d.bLife * 1.3, homing: false, pierce: true, pierced: false, isSnipe: true, isArrow: true,
          serverTime: match.nowCache, ownerLag: 0
        });
        p.charging = false; p.chargeTimer = 0; p.lastShot = now;
        broadcastMatchRaw(match, JSON.stringify({ type:'snipeFired', playerId:p.id, x:Math.round(p.x), y:Math.round(p.y), angle:+(p.angle).toFixed(3) }));
      }
    } else {
      if (p.charging) {
        if (p.chargeTimer > 200) {
          serverFireBullet(match, p, p.angle);
          if (p.upgrades.includes('doubleShot')) {
            serverFireBullet(match, p, p.angle + 0.13);
            serverFireBullet(match, p, p.angle - 0.13);
          }
          p.lastShot = now;
        }
        p.charging = false; p.chargeTimer = 0;
      }
    }
  } else if (inp.shoot && (now - p.lastShot) > fr) {
    if (p.cls === 'assassin') {
      serverMeleeHit(match, p);
    } else {
      serverFireBullet(match, p, p.angle);
      if (p.upgrades.includes('doubleShot')) {
        serverFireBullet(match, p, p.angle + 0.13);
        serverFireBullet(match, p, p.angle - 0.13);
      }
    }
    p.lastShot = now;
  }

  if (p.swordTimer > 0) { p.swordTimer -= dt * 1000; p.swordSweep = 1 - (p.swordTimer / 300); }
  if (p.swordTimer <= 0) p.swordOn = false;
  if (p.novaLife > 0) {
    p.novaLife -= dt * 1000;
    p.novaR += dt * 340;
    if (!p.novaHit) {
      for (const t of match.players) {
        if (t.id === p.id || !t.alive || t.invuln > 0) continue;
        const dx = t.x - p.novaX, dy = t.y - p.novaY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (Math.abs(dist - p.novaR) < t.radius + 36) {
          serverDamage(match, t, 35, p.id);
          p.novaHit = true;
          break;
        }
      }
      for (const camp of match.camps) {
        for (const mob of camp.mobs) {
          if (!mob.alive) continue;
          const dx = mob.x - p.novaX, dy = mob.y - p.novaY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (Math.abs(dist - p.novaR) < mob.radius + 36) {
            mob.hp -= 35;
            if (mob.hp <= 0) { mob.alive = false; }
          }
        }
      }
    }
  }
  if (p.novaLife <= 0) p.novaOn = false;
  if (p.overchargeTimer > 0) p.overchargeTimer -= dt * 1000;
  if (p.smokeTimer > 0) p.smokeTimer -= dt * 1000;
  if (p.fortifyTimer > 0) p.fortifyTimer -= dt * 1000;

  if (p.hookOn) {
    p.hookTimer -= dt * 1000;
    if (p.hookReturning) {
      const dx = p.x - p.hookX, dy = p.y - p.hookY;
      const d2 = Math.sqrt(dx * dx + dy * dy);
      if (d2 < p.radius + 10) {
        p.hookOn = false;
      } else {
        p.hookX += (dx / d2) * 900 * dt;
        p.hookY += (dy / d2) * 900 * dt;
        if (p.hookTarget) {
          const t = getPlayer(match, p.hookTarget);
          if (t && t.alive) { t.x += (p.x - t.x) * dt * 6; t.y += (p.y - t.y) * dt * 6; t.vx = 0; t.vy = 0; }
        }
      }
    } else {
      p.hookX += p.hookVx * dt;
      p.hookY += p.hookVy * dt;
      if (!p.hookHit) {
        for (const t of match.players) {
          if (t.id === p.id || !t.alive || t.invuln > 0) continue;
          if (match.teamMode && t.team === p.team) continue;
          const dx = t.x - p.hookX, dy = t.y - p.hookY;
          if (dx * dx + dy * dy < (t.radius + 12) ** 2) {
            p.hookHit = true; p.hookTarget = t.id; p.hookReturning = true;
            serverDamage(match, t, 30, p.id);
            broadcastMatchRaw(match, JSON.stringify({ type:'hookHit', hookerId:p.id, targetId:t.id, hookX:Math.round(p.hookX), hookY:Math.round(p.hookY) }));
            break;
          }
        }
      }
      let wallHit = false;
      for (const w of match.walls) { if (p.hookX >= w.x && p.hookX <= w.x + w.w && p.hookY >= w.y && p.hookY <= w.y + w.h) { wallHit = true; break; } }
      if (p.hookTimer <= 0 || wallHit || p.hookX < 0 || p.hookX > MAP_W || p.hookY < 0 || p.hookY > MAP_H) {
        p.hookReturning = true;
        if (!p.hookHit) broadcastMatchRaw(match, JSON.stringify({ type:'hookMiss', hookerId:p.id }));
      }
    }
  }
  if (p.barrierTimer > 0) p.barrierTimer -= dt * 1000;
  if (p.barrierTimer <= 0) p.barrierOn = false;
}

function updateBullets(match, dt) {
  const now = match.nowCache;
  // Spatial hash built centrally in tickMatch
  for (let i = match.bullets.length - 1; i >= 0; i--) {
    const b = match.bullets[i];
    b.life -= dt * 1000;
    if (b.life <= 0) { match.bullets.splice(i, 1); continue; }
    
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    
    if (b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) {
      match.bullets.splice(i, 1); continue;
    }
    
    let removed = false;
    for (const w of match.walls) {
      if (b.x >= w.x && b.x <= w.x + w.w && b.y >= w.y && b.y <= w.y + w.h) {
        if (b.pierce && !b.pierced) {
          b.pierced = true;
        } else {
          match.bullets.splice(i, 1);
          removed = true;
        }
        break;
      }
    }
    if (removed) continue;

    if (b.homing) {
      let target = null, minD = Infinity;
      const bOwner = getPlayer(match, b.owner);
      _svShQueryOut.length=0; _svShQuery(b.x,b.y,400,_svShQueryOut);
      for (let _sqi=0;_sqi<_svShQueryOut.length;_sqi++) {
        const p = _svShQueryOut[_sqi];
        if (p._shType !== 'player' || p.id === b.owner || !p.alive) continue;
        if (bOwner && isAllyServer(bOwner, p, match)) continue;
        const dx = p.x - b.x, dy = p.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < minD) { minD = d2; target = p; }
      }
      if (target) {
        const dx = target.x - b.x, dy = target.y - b.y;
        const turnSpeed = 2.5 * dt;
        const targetAngle = Math.atan2(dy, dx);
        let angleDiff = targetAngle - Math.atan2(b.vy, b.vx);
        if (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        if (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
        const newAngle = Math.atan2(b.vy, b.vx) + Math.sign(angleDiff) * Math.min(turnSpeed, Math.abs(angleDiff));
        const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        b.vx = Math.cos(newAngle) * speed;
        b.vy = Math.sin(newAngle) * speed;
      }
    }

    // Spatial hash universal collision — O(1) per bullet
    _svShQueryOut.length=0; _svShQuery(b.x,b.y,b.r+40,_svShQueryOut);
    const bOwner = getPlayer(match, b.owner);
    for(let _sqi=0;_sqi<_svShQueryOut.length;_sqi++){
      const ent=_svShQueryOut[_sqi];
      if(!ent.alive && ent._shType !== 'tower') continue;
      
      const dx=ent.x-b.x, dy=ent.y-b.y;
      const d2=dx*dx+dy*dy;

      if(ent._shType === 'player') {
         if (ent.id === b.owner) continue;
         if (bOwner && isAllyServer(bOwner, ent, match)) continue;
         if (ent.barrierOn && ent.barrierHp > 0 && d2 < (ent.radius + 35)**2) {
           ent.barrierHp -= b.dmg;
           if (ent.barrierHp <= 0) { ent.barrierOn = false; ent.barrierTimer = 0; }
           match.bullets.splice(i, 1); removed=true; break;
         }
         if (ent.invuln > 0) continue;
         const lagBonus = Math.min(6, (b.ownerLag || 0) / 33);
         if (d2 < (ent.radius + b.r + lagBonus)**2) {
           serverDamage(match, ent, b.dmg, b.owner);
           if (bOwner) bOwner.energy += 12;
           broadcastMatchRaw(match, JSON.stringify({ type:'hit', targetId:ent.id, attackerId:b.owner, x:Math.round(b.x), y:Math.round(b.y), dmg:b.dmg }));
           match.bullets.splice(i, 1); removed=true; break;
         }
      } else if (ent._shType === 'mob') {
         if(d2 < (ent.radius+b.r)**2){
           ent.hp-=b.dmg; ent.aggroTarget=b.owner;
           const killed=ent.hp<=0;
           if(killed){ent.alive=false;match.campsDirty=true;}
           broadcastMatchRaw(match,JSON.stringify({type:'mobHit',x:Math.round(ent.x),y:Math.round(ent.y),dmg:b.dmg,attackerId:b.owner,killed}));
           match.bullets.splice(i,1); removed=true; break;
         }
      } else if (ent._shType === 'minion') {
         if (ent.ownerId === b.owner) continue;
         if (bOwner && ent.ownerId && isAllyServer(bOwner, {id: ent.ownerId, team: ent.team}, match)) continue;
         if(d2 < ((ent.radius||8)+b.r)**2){
           ent.hp-=b.dmg;
           if(ent.hp<=0) ent.alive=false;
           broadcastMatchRaw(match,JSON.stringify({type:'mobHit',x:Math.round(ent.x),y:Math.round(ent.y),dmg:b.dmg,attackerId:b.owner,killed:!ent.alive}));
           match.bullets.splice(i,1); removed=true; break;
         }
      } else if (ent._shType === 'tower' && ent.hp > 0) {
         if (bOwner && bOwner.team === ent.team && match.teamMode) continue;
         if(d2 < (ent.radius+b.r)**2){
           ent.hp -= b.dmg;
           match.bullets.splice(i,1); removed=true; break;
         }
      }
    }
  }
}

function updateOrbs(match) {
  for (let i = match.orbs.length - 1; i >= 0; i--) {
    const o = match.orbs[i];
    _svShQueryOut.length=0; _svShQuery(o.x, o.y, o.r + 30, _svShQueryOut);
    for (let _sqi=0; _sqi<_svShQueryOut.length; _sqi++) {
      const p = _svShQueryOut[_sqi];
      if (p._shType !== 'player' || !p.alive) continue;
      const dx = p.x - o.x, dy = p.y - o.y;
      if (dx * dx + dy * dy < (p.radius + o.r) ** 2) {
        p.energy += o.value;
        serverGrantXP(match, p, SV_XP_ORB);
        broadcastMatchRaw(match, JSON.stringify({
          type:'orbPickup', playerId:p.id,
          x:Math.round(o.x), y:Math.round(o.y), value:o.value
        }));
        match.orbs.splice(i, 1);
        break;
      }
    }
  }
}

function spawnOrb(match) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const center = Math.random() < 0.6;
    let x, y;
    if (center) {
      x = MAP_W * 0.3 + Math.random() * MAP_W * 0.4;
      y = MAP_H * 0.2 + Math.random() * MAP_H * 0.6;
    } else {
      x = Math.random() < 0.5 ? MAP_W * 0.04 + Math.random() * MAP_W * 0.14 : MAP_W * 0.82 + Math.random() * MAP_W * 0.14;
      y = MAP_H * 0.1 + Math.random() * MAP_H * 0.8;
    }
    let blocked = false;
    for (const w of match.walls) {
      if (x >= w.x - 10 && x <= w.x + w.w + 10 && y >= w.y - 10 && y <= w.y + w.h + 10) { blocked = true; break; }
    }
    if (!blocked) {
      const v = center ? (10 + Math.floor(Math.random() * 20)) : (4 + Math.floor(Math.random() * 10));
      match.orbs.push({ x, y, value: v, r: 7 + v / 6 });
      return;
    }
  }
}

function broadcastState(match, elapsed) {
  const binBuf = encodeBinaryState(match, elapsed, MATCH_TIME);
  for (const p of match.players) {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(binBuf, { binary: true });
    }
  }

  if (match.physicsTick % 8 === 0) {
    // Only re-stringify when something actually changed — mob positions always change
    // so we always rebuild, but we skip the static tower/consumable sections when clean.
    match.campsSyncCache = JSON.stringify({
      type: 'campsSync',
      camps: match.camps.map(c => ({
        x: Math.round(c.x), y: Math.round(c.y), dead: c.dead, type: c.type,
        gold: c.gold, respawnTime: c.respawnTime,
        _deathTime: c.dead ? Math.round(c.deathTime) : 0,
        mobs: c.mobs.filter(m => m.alive).map(m => ({
          id: m.id,
          x: Math.round(m.x), y: Math.round(m.y),
          vx: Math.round(m.vx || 0), vy: Math.round(m.vy || 0),
          hp: m.hp, maxHp: m.maxHp,
          color: m.color, radius: m.radius,
          type: m.type || c.type,
          homeX: Math.round(m.homeX || m.x), homeY: Math.round(m.homeY || m.y)
        }))
      })),
      consumables: match.campsDirty ? match.players.map(p => ({ id: p.id, c: p.consumables })) : undefined,
      minions: match.players.filter(p => p.minions && p.minions.length > 0).map(p => ({
        id: p.id,
        m: p.minions.filter(m => m.alive).map(m => ({
          x: Math.round(m.x), y: Math.round(m.y), hp: m.hp, maxHp: m.maxHp
        }))
      })),
      towers: match.campsDirty && match.towers ? match.towers.map(t => ({
        team: t.team, x: Math.round(t.x), y: Math.round(t.y),
        hp: t.hp, maxHp: t.maxHp, alive: t.alive,
        radius: t.radius, atkRange: t.atkRange, color: t.color
      })) : undefined
    });
    match.campsDirty = false;
    broadcastMatchRaw(match, match.campsSyncCache);
  }
}

function serverFireBullet(match, p, angle) {
  const d = CDEFS[p.cls];
  let dmg = p.upgrades.includes('heavy') ? d.bDmg * 2 : d.bDmg;
  if (p.streakDmgBoost > 1) dmg = Math.round(dmg * p.streakDmgBoost);
  if (p.dmgBoostTimer > 0) dmg = Math.round(dmg * 1.4);
  if (p.lvlDmgMult && p.lvlDmgMult > 1.0) dmg = Math.round(dmg * p.lvlDmgMult);
  if (p.upgrades.includes('momentum')) {
    const spd = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    dmg = Math.round(dmg * (1 + Math.min(0.2, spd / 1500)));
  }
  let spd = d.bSpd + (p.upgrades.includes('rapidFire') ? 50 : 0);
  if (p.upgrades.includes('projSpeed')) spd = Math.round(spd * 1.3);
  
  const ownerLag = p.ws ? (match.nowCache - (p.ws.lastInputTime || match.nowCache)) : 0;
  
  match.bullets.push({
    x: p.x + Math.cos(angle) * 20,
    y: p.y + Math.sin(angle) * 20,
    vx: Math.cos(angle) * spd,
    vy: Math.sin(angle) * spd,
    owner: p.id, isMage: p.cls === 'mage',
    dmg, r: p.cls === 'mage' ? 8 : 4,
    life: d.bLife,
    homing: p.upgrades.includes('homing'),
    pierce: p.upgrades.includes('pierce'),
    pierced: false,
    serverTime: match.nowCache,
    ownerLag: Math.min(200, ownerLag)
  });
}

function serverMeleeHit(match, p) {
  let dmg = p.upgrades.includes('heavy') ? 36 : 22;
  if (p.streakDmgBoost > 1) dmg = Math.round(dmg * p.streakDmgBoost);
  if (p.dmgBoostTimer > 0) dmg = Math.round(dmg * 1.4);
  const range = 80 + (p.upgrades.includes('heavy') ? 10 : 0);
  const arc = 1.4;
  
  p.swordOn = true;
  p.swordAngle = p.angle;
  p.swordSweep = 0;
  p.swordTimer = 220;
  
  _svShQueryOut.length=0; _svShQuery(p.x, p.y, range + 50, _svShQueryOut);
  for (let _sqi=0; _sqi<_svShQueryOut.length; _sqi++) {
    const ent = _svShQueryOut[_sqi];
    if (!ent.alive) continue;
    const dx = ent.x - p.x, dy = ent.y - p.y;
    const thresh = range + (ent.radius || 14);
    if (dx * dx + dy * dy > thresh * thresh) continue;
    
    const angleToTarget = Math.atan2(dy, dx);
    let diff = angleToTarget - p.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) > arc / 2) continue;

    if (ent._shType === 'player') {
      if (ent.id === p.id || ent.invuln > 0) continue;
      if (isAllyServer(p, ent, match)) continue;
      serverDamage(match, ent, dmg, p.id);
      p.energy += 12;
      broadcastMatchRaw(match, JSON.stringify({ type:'hit', targetId:ent.id, attackerId:p.id, x:Math.round(ent.x), y:Math.round(ent.y), dmg:dmg }));
    } else if (ent._shType === 'mob') {
      ent.hp -= dmg;
      ent.aggroTarget = p.id;
      if (ent.hp <= 0) { ent.alive = false; match.campsDirty = true; }
    } else if (ent._shType === 'minion') {
      if (ent.ownerId === p.id) continue;
      if (ent.ownerId && isAllyServer(p, {id: ent.ownerId, team: ent.team}, match)) continue;
      ent.hp -= dmg;
      if (ent.hp <= 0) ent.alive = false;
    }
  }
}

function serverTriggerSpecial(match, p) {
  if (p.cls === 'gunner') {
    for (let i = 0; i < 5; i++) {
      serverFireBullet(match, p, p.angle + (i - 2) * 0.1);
    }
   } else if (p.cls === 'assassin') {
     const dashDist = 280;
     const ddx = Math.cos(p.angle), ddy = Math.sin(p.angle);
     const startX = p.x, startY = p.y;
     const endX = clamp(p.x + ddx * dashDist, p.radius, MAP_W - p.radius);
     const endY = clamp(p.y + ddy * dashDist, p.radius, MAP_H - p.radius);
     p.x = endX; p.y = endY; p.vx = 0; p.vy = 0; p.invuln = 300;
     p.swordOn = true; p.swordAngle = p.angle; p.swordSweep = 0; p.swordTimer = 300;
     
     broadcastMatchRaw(match, JSON.stringify({
       type:'dash', playerId:p.id,
       fromX:Math.round(startX), fromY:Math.round(startY),
       toX:Math.round(endX), toY:Math.round(endY),
       teleport:true
     }));
     
     for (const t of match.players) {
       if (t.id === p.id || !t.alive) continue;
       if (isAllyServer(p, t, match)) continue;
       const ex = t.x - startX, ey = t.y - startY;
       const lx = endX - startX, ly = endY - startY;
       const len2 = lx * lx + ly * ly;
       const proj = Math.max(0, Math.min(1, (ex * lx + ey * ly) / len2));
       const cx = startX + lx * proj, cy = startY + ly * proj;
       const dist = Math.sqrt((t.x - cx) * (t.x - cx) + (t.y - cy) * (t.y - cy));
       if (dist < t.radius + p.radius + 20) {
         serverDamage(match, t, 45, p.id);
         broadcastMatchRaw(match, JSON.stringify({ type:'hit', targetId:t.id, attackerId:p.id, x:Math.round(t.x), y:Math.round(t.y), dmg:45 }));
       }
     }
     for (const camp of match.camps) {
       for (const mob of camp.mobs) {
         if (!mob.alive) continue;
         const ex = mob.x - startX, ey = mob.y - startY;
         const lx = endX - startX, ly = endY - startY;
         const len2 = lx * lx + ly * ly;
         const proj = Math.max(0, Math.min(1, (ex * lx + ey * ly) / len2));
         const cx = startX + lx * proj, cy = startY + ly * proj;
         const dist = Math.sqrt((mob.x - cx) * (mob.x - cx) + (mob.y - cy) * (mob.y - cy));
         if (dist < (mob.radius || 14) + p.radius + 20) {
           mob.hp -= 45;
           if (mob.hp <= 0) mob.alive = false;
         }
       }
     }
  } else if (p.cls === 'mage') {
    p.novaOn = true;
    p.novaR = p.radius + 4;
    p.novaLife = 700;
    p.novaX = p.x;
    p.novaY = p.y;
    p.novaHit = false;
  } else if (p.cls === 'tank') {
    p.hookOn = true;
    p.hookX = p.x + Math.cos(p.angle) * p.radius;
    p.hookY = p.y + Math.sin(p.angle) * p.radius;
    p.hookVx = Math.cos(p.angle) * 700;
    p.hookVy = Math.sin(p.angle) * 700;
    p.hookTimer = 600;
    p.hookTarget = null;
    p.hookReturning = false;
    p.hookHit = false;
  } else if (p.cls === 'necro') {
    const range = 200;
    const arc = 1.2;
    p.drainTimer = 800;
    const range2 = range * range;
    for (const t of match.players) {
      if (t.id === p.id || !t.alive || t.invuln > 0) continue;
      if (isAllyServer(p, t, match)) continue;
      const dx = t.x - p.x, dy = t.y - p.y;
      if (dx * dx + dy * dy > range2) continue;
      const angle = Math.atan2(dy, dx);
      let diff = angle - p.angle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      if (Math.abs(diff) < arc / 2) {
        serverDamage(match, t, 30, p.id);
        const oldHp = p.hp;
        p.hp = Math.min(p.maxHp, p.hp + 15);
        const healed = p.hp - oldHp;
        if (healed > 0) broadcastMatchRaw(match, JSON.stringify({ type:'heal', playerId:p.id, amount:healed }));
        broadcastMatchRaw(match, JSON.stringify({ type:'hit', targetId:t.id, attackerId:p.id, x:Math.round(t.x), y:Math.round(t.y), dmg:30 }));
      }
    }
    for (const camp of match.camps) {
      for (const mob of camp.mobs) {
        if (!mob.alive) continue;
        const dx = mob.x - p.x, dy = mob.y - p.y;
        if (dx * dx + dy * dy > range2) continue;
        const angle = Math.atan2(dy, dx);
        let diff = angle - p.angle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        if (Math.abs(diff) < arc / 2) {
          mob.hp -= 30;
          const oldHp2 = p.hp;
          p.hp = Math.min(p.maxHp, p.hp + 10);
          const healed2 = p.hp - oldHp2;
          if (healed2 > 0) broadcastMatchRaw(match, JSON.stringify({ type:'heal', playerId:p.id, amount:healed2 }));
          if (mob.hp <= 0) mob.alive = false;
        }
      }
    }
  } else if (p.cls === 'ranger') {
    const spread = 0.5;
    for (let i = 0; i < 5; i++) {
      const aOff = (i - 2) * (spread / 4);
      const a = p.angle + aOff;
      const d = CDEFS.ranger;
      match.bullets.push({
        x: p.x + Math.cos(a) * (p.radius + 4), y: p.y + Math.sin(a) * (p.radius + 4),
        vx: Math.cos(a) * d.bSpd * 1.1, vy: Math.sin(a) * d.bSpd * 1.1,
        owner: p.id, isMage: false, dmg: d.bDmg, r: 5,
        life: d.bLife, homing: false, pierce: false, pierced: false, isArrow: true,
        serverTime: match.nowCache, ownerLag: 0
      });
    }
  }
}

function serverTriggerUltimate(match, p) {
  if (p.cls === 'gunner') {
    p.overchargeTimer = 4000;
  } else if (p.cls === 'assassin') {
    p.smokeTimer = 3000;
    p.smokeX = p.x;
    p.smokeY = p.y;
    p.invuln = 500;
    for (const t of match.players) {
      if (t.id === p.id || !t.alive) continue;
      if (isAllyServer(p, t, match)) continue;
      const dx = t.x - p.x, dy = t.y - p.y;
      if (dx * dx + dy * dy < 120 * 120) serverDamage(match, t, 15, p.id);
    }
  } else if (p.cls === 'mage') {
    p.barrierOn = true;
    p.barrierTimer = 3000;
    p.barrierHp = 80;
    const oldHpM = p.hp;
    p.hp = Math.min(p.maxHp, p.hp + 30);
    const healedM = p.hp - oldHpM;
    if (healedM > 0) broadcastMatchRaw(match, JSON.stringify({ type:'heal', playerId:p.id, amount:healedM }));
  } else if (p.cls === 'tank') {
    p.fortifyTimer = 4000;
    for (const t of match.players) {
      if (t.id === p.id || !t.alive || t.invuln > 0) continue;
      if (isAllyServer(p, t, match)) continue;
      const dx = t.x - p.x, dy = t.y - p.y;
      if (dx * dx + dy * dy < 130 * 130) {
        serverDamage(match, t, 25, p.id);
      }
    }
  } else if (p.cls === 'necro') {
    p.minions = [];
    for (let i = 0; i < 3; i++) {
      const angle = p.angle + (i - 1) * 0.8;
      p.minions.push({
        x: p.x + Math.cos(angle) * 60,
        y: p.y + Math.sin(angle) * 60,
        vx: 0, vy: 0,
        hp: 40, maxHp: 40, alive: true,
        radius: 8, speed: 200, dmg: 12,
        atkRange: 40, atkCd: 800, lastAtk: 0,
        target: null, lifeTimer: 10000
      });
    }
    p.invuln = 300;
  } else if (p.cls === 'ranger') {
    if (!match.traps) match.traps = [];
    for (let i = 0; i < 3; i++) {
      const angle = p.angle + (i - 1) * 0.7;
      const dist = 80 + i * 40;
      match.traps.push({
        x: p.x + Math.cos(angle) * dist, y: p.y + Math.sin(angle) * dist,
        owner: p.id, radius: 22, dmg: 35, rootDuration: 1500, timer: 15000, armed: true
      });
    }
  }
  broadcastMatchRaw(match, JSON.stringify({ type:'ultimateUsed', playerId:p.id, cls:p.cls }));
}

let thornmailDepth = 0;

function serverDamage(match, p, dmg, attackerId) {
  const upgrades = p.upgrades || [];
  if (p.shield > 0 && upgrades.includes('shield')) {
    const absorbed = Math.min(p.shield, dmg);
    p.shield -= absorbed;
    dmg -= absorbed;
    if (dmg <= 0) return;
  }
  
  if (upgrades.includes('armor')) dmg = Math.round(dmg * 0.75);
  if (p.fortifyTimer > 0) dmg = Math.round(dmg * 0.5);
  
  const attacker = attackerId > 0 ? getPlayer(match, attackerId) : null;
  if (attacker && (attacker.upgrades || []).includes('critStrike') && Math.random() < 0.2) {
    dmg *= 2;
    broadcastMatchRaw(match, JSON.stringify({ type:'crit', x:Math.round(p.x), y:Math.round(p.y) }));
  }
  // Level damage multiplier (baked into bullets at fire time via serverFireBullet)
  // Talent mods applied here cover melee / AoE sources
  if (attacker) {
    if (attacker.talents?.gn_execute && p.hp / p.maxHp < 0.25) dmg = Math.round(dmg * 1.7);
    if (attacker.talents?.mg_surge && (attacker.energy||0) < 100)  dmg = Math.round(dmg * 1.3);
  }
  if (p.talents?.tk_titan)                         dmg = Math.round(dmg * 0.85);
  if (p.talents?.tk_coloss)                        dmg = Math.round(dmg * 0.70);
  if (p.talents?.tk_last && p.hp / p.maxHp < 0.25) dmg = Math.round(dmg * 0.75);
  if (p.talents?.mg_mshield && (p.energy||0) > 0 && dmg > 0) {
    const absorb = Math.min(30, dmg, p.energy);
    p.energy -= absorb;
    dmg -= absorb;
    if (dmg <= 0) return;
  }

  if (p.barrierOn && p.barrierHp > 0) {
    const absorbed = Math.min(p.barrierHp, dmg);
    p.barrierHp -= absorbed;
    dmg -= absorbed;
    if (p.barrierHp <= 0) { p.barrierOn = false; p.barrierTimer = 0; }
    if (dmg <= 0) return;
  }
  
  p.hp -= dmg;
  
  if (upgrades.includes('thornmail') && attacker && thornmailDepth === 0) {
    thornmailDepth++;
    const reflect = Math.round(dmg * 0.15);
    serverDamage(match, attacker, reflect, -1);
    thornmailDepth--;
  }
  
  if (p.hp <= 0) serverKill(match, p, attackerId);
}

const STREAK_NAMES = {
  2:'DOUBLE KILL', 3:'KILLING SPREE', 4:'DOMINATING',
  5:'MEGA KILL', 6:'UNSTOPPABLE', 7:'GODLIKE',
  8:'LEGENDARY', 9:'BEYOND GODLIKE', 10:'RAMPAGE'
};

function serverKill(match, victim, killerId) {
  // Undying talent — block death once
  if (victim.talents?.nc_undying && victim.undyingCharge > 0) {
    victim.undyingCharge = 0;
    victim.hp = Math.round(victim.maxHp * 0.5);
    victim.invuln = 2200;
    return;
  }
  victim.alive = false;
  victim.hp = 0;
  
  victim.killStreak = 0;
  victim.streakDmgBoost = 1; victim.streakDmgTimer = 0;
  victim.streakSpdBoost = 1; victim.streakSpdTimer = 0;
  
  if (killerId > 0) {
    if (match.score[killerId] !== undefined) {
      match.score[killerId]++;
      if (match.score[killerId] > match.topScore) match.topScore = match.score[killerId];
    }
    const killer = getPlayer(match, killerId);
    if (killer) {
      // XP for kill
      serverGrantXP(match, killer, SV_XP_KILL + (victim.level || 1) * SV_XP_KILL_BONUS);
      // Kill talent effects
      if (killer.talents?.gn_medic)   killer.hp = Math.min(killer.maxHp, killer.hp + 20);
      if (killer.talents?.as_pred)    killer.hp = killer.maxHp;
      if (killer.talents?.nc_pact)    killer.energy = (killer.energy || 0) + 20;
      if (killer.talents?.as_phantom) killer.spdBoostTimer = 3000;
      if (killer.talents?.as_rampage) {
        killer._rampageStacks = Math.min(5, (killer._rampageStacks || 0) + 1);
        killer.lvlDmgMult = (killer.lvlDmgMult || 1) + 0.20;
      }
      if (killer.talents?.mg_inf) { killer.lastDash = 0; killer.lastSp = 0; killer.lastSec = -9999; }
      // Epidemic: damage nearby enemies on kill
      if (killer.talents?.nc_epid) {
        for (const ep of match.players) {
          if (ep === killer || !ep.alive || (match.teamMode && ep.team === killer.team)) continue;
          const edx = ep.x - victim.x, edy = ep.y - victim.y;
          if (edx*edx + edy*edy < 200*200) serverDamage(match, ep, 40, killer.id);
        }
      }
      killer.killStreak = (killer.killStreak || 0) + 1;
      
      if (killer.killStreak === 3) {
        killer.streakDmgBoost = 1.25;
        killer.streakDmgTimer = 5000;
      }
      if (killer.killStreak === 5) {
        killer.streakSpdBoost = Math.max(killer.streakSpdBoost, 1.4);
        killer.streakSpdTimer = 5000;
      }
      if (killer.killStreak === 7) {
        killer.hp = killer.maxHp;
        killer.shield = 50;
      }
      
      if (killer.upgrades.includes('momentum')) {
        killer.streakSpdBoost = Math.min(2, killer.streakSpdBoost + 0.2);
      }
      
      const streakName = STREAK_NAMES[Math.min(killer.killStreak, 10)] || null;
      if (streakName) {
        broadcastMatchRaw(match, JSON.stringify({
          type: 'streakAnnounce',
          playerId: killer.id,
          streak: killer.killStreak,
          name: streakName,
          cls: killer.cls
        }));
      }
    }
  }
  
  if (killerId > 0) {
    const killer = getPlayer(match, killerId);
    if (killer) killer.energy += 20;
  }

  broadcastMatchRaw(match, JSON.stringify({
    type: 'kill',
    killerId, victimId: victim.id,
    killerCls: killerId > 0 ? getPlayer(match, killerId)?.cls : null,
    victimCls: victim.cls,
    killerStreak: killerId > 0 ? getPlayer(match, killerId)?.killStreak : 0,
    score: match.score
  }));

  if (match.topScore >= WIN_SCORE) {
    setTimeout(() => endMatch(match), 700);
    return;
  }

  setTimeout(() => {
    if (match.gameOver) return;
    victim.alive = true;
    victim.hp = victim.maxHp;
    victim.shield = victim.upgrades.includes('shield') ? 30 : 0;
    victim.invuln = 2200;
    victim.vx = 0; victim.vy = 0;
    victim.novaOn = false;
    
    let bestSpawn;
    if (match.teamMode && victim.team > 0) {
      const teamSpawns = TEAM_SPAWNS[victim.team] || SPAWN_POSITIONS;
      bestSpawn = teamSpawns[Math.floor(Math.random() * teamSpawns.length)];
    } else {
      bestSpawn = SPAWN_POSITIONS[0];
      let bestDist = -1;
      for (const sp of SPAWN_POSITIONS) {
        let minEnemyDist = Infinity;
        for (const other of match.players) {
          if (other.id === victim.id || !other.alive) continue;
          const dx = other.x - sp.x, dy = other.y - sp.y;
          minEnemyDist = Math.min(minEnemyDist, dx * dx + dy * dy);
        }
        if (minEnemyDist > bestDist) { bestDist = minEnemyDist; bestSpawn = sp; }
      }
    }
    
    const safe = findSafeSpawnServer(bestSpawn.x + Math.random() * 60 - 30, bestSpawn.y + Math.random() * 60 - 30, victim.radius, match.walls);
    victim.x = safe.x;
    victim.y = safe.y;
    
    broadcastMatchRaw(match, JSON.stringify({
      type: 'respawn', playerId: victim.id,
      x: Math.round(victim.x), y: Math.round(victim.y)
    }));
  }, 2000);
}

function endMatch(match) {
  if (match.gameOver) return;
  match.gameOver = true;
  // tickInterval may hold a setTimeout or setImmediate handle depending on timing
  clearTimeout(match.tickInterval);
  clearImmediate(match.tickInterval);
  
  let winnerId = 0;
  let topScore = -1;
  for (const [id, score] of Object.entries(match.score)) {
    if (score > topScore) { topScore = score; winnerId = parseInt(id); }
  }
  const tiedPlayers = Object.entries(match.score).filter(([,s]) => s === topScore);
  if (tiedPlayers.length > 1) winnerId = 0;
  
  const eloChange = {};
  const playerCount = match.players.length;
  for (const p of match.players) {
    if (p.id === winnerId) {
      eloChange[p.id] = Math.round(20 + Math.random() * 10);
    } else if (winnerId === 0) {
      eloChange[p.id] = 0;
    } else {
      eloChange[p.id] = -Math.round(10 + Math.random() * 8);
    }
  }
  
  const rankings = match.players.map(p => ({
    id: p.id,
    name: p.ws.playerInfo?.name || 'PLAYER',
    cls: p.cls,
    score: match.score[p.id] || 0,
    elo: eloChange[p.id] || 0
  })).sort((a, b) => b.score - a.score);
  
  const endMsg = JSON.stringify({
    type: 'matchEnd',
    winner: winnerId,
    score: match.score,
    eloChange,
    rankings
  });
  
  for (const p of match.players) {
    sendRaw(p.ws, endMsg);
  }
  
  matches.delete(match.id);
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function sendRaw(ws, str) {
  if (ws.readyState === WebSocket.OPEN) ws.send(str);
}

function broadcastMatchRaw(match, str) {
  for (const p of match.players) {
    sendRaw(p.ws, str);
  }
}

function handleDisconnect(ws) {
  if (ws.matchId) {
    const m = matches.get(ws.matchId);
    if (!m) return;
    
    const dcPlayer = m.players.find(p => p.ws === ws);
    if (dcPlayer) {
      dcPlayer.alive = false;
      dcPlayer.hp = 0;
      broadcastMatchRaw(m, JSON.stringify({
        type: 'playerDisconnected',
        playerId: dcPlayer.id,
        name: ws.playerInfo?.name || 'PLAYER'
      }));
    }
    
    m.players = m.players.filter(p => p.ws !== ws);
    delete m.score[ws.playerId];
    
    const alivePlayers = m.players.filter(p => p.ws.readyState === WebSocket.OPEN);
    if (alivePlayers.length < 2) {
      endMatch(m);
    }
  }
}

let nextMobId = 1;
function createMob(type, x, y) {
  const def = MOB_DEFS[type] || MOB_DEFS.wolves;
  return { id: nextMobId++, type, x, y, homeX:x, homeY:y, vx:0, vy:0, ...def, alive:true, lastAtk:-9999, aggroTarget:null };
}

function createCamps() {
  return createCampsFromDefs(CAMP_DEFS);
}

function createCampsFromDefs(campDefs) {
  return campDefs.map(cd => {
    const type = cd.type || 'wolves';
    const count = cd.count || 1;
    const camp = { ...cd, type, count, mobs:[], dead:false, respawnTimer:0, deathTime:0 };
    for (let i = 0; i < count; i++) {
      const angle = Math.PI * 2 * i / count;
      const spread = count > 1 ? 28 : 0;
      camp.mobs.push(createMob(type, cd.x + Math.cos(angle) * spread, cd.y + Math.sin(angle) * spread));
    }
    return camp;
  });
}

function updateCamps(match, dt, now) {
  for (const camp of match.camps) {
    const allDead = camp.mobs.every(m => !m.alive);
    if (allDead && !camp.dead) {
      camp.dead = true;
      camp.deathTime = now;
      _svShQueryOut.length=0; _svShQuery(camp.x, camp.y, 600, _svShQueryOut);
      for (let _sqi=0;_sqi<_svShQueryOut.length;_sqi++) {
        const p = _svShQueryOut[_sqi];
        if (p._shType !== 'player' || !p.alive) continue;
        const dx = p.x - camp.x, dy = p.y - camp.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < minD) { minD = d2; closest = p; }
      }
      if (closest) {
        closest.energy += camp.gold;
        const campXP = SV_XP_CAMP[camp.type] || 35;
        for (let _sqi=0;_sqi<_svShQueryOut.length;_sqi++) {
          const xpp = _svShQueryOut[_sqi];
          if (xpp._shType !== 'player' || !xpp.alive) continue;
          const xdx = xpp.x - camp.x, xdy = xpp.y - camp.y;
          const nearby = xdx*xdx + xdy*xdy < 600*600;
          if (nearby) serverGrantXP(match, xpp, Math.round(campXP * 0.6));
        }
        serverGrantXP(match, closest, Math.round(campXP * 0.4)); // finisher bonus
        broadcastMatchRaw(match, JSON.stringify({
          type:'campCleared', campX:Math.round(camp.x), campY:Math.round(camp.y),
          gold:camp.gold, playerId:closest.id
        }));
      }
    }
    if (camp.dead && now - camp.deathTime > camp.respawnTime) {
      camp.dead = false;
      camp.mobs = [];
      for (let i = 0; i < camp.count; i++) {
        const angle = Math.PI * 2 * i / camp.count;
        const spread = camp.count > 1 ? 28 : 0;
        camp.mobs.push(createMob(camp.type, camp.x + Math.cos(angle) * spread, camp.y + Math.sin(angle) * spread));
      }
    }
    for (const mob of camp.mobs) {
      if (!mob.alive) continue;
      updateMob(match, mob, dt, now);
    }
  }
}

function updateMob(match, mob, dt, now) {
  if (match.physicsTick % 4 === 0) {
    let target = null, minD2 = mob.aggroRange * mob.aggroRange;
    _svShQueryOut.length=0; _svShQuery(mob.x, mob.y, mob.aggroRange, _svShQueryOut);
    for(let _qi=0;_qi<_svShQueryOut.length;_qi++){
      const p=_svShQueryOut[_qi];
      if(p._shType !== 'player' && p._shType !== 'minion') continue;
      if(!p.alive) continue;
      const dx=p.x-mob.x, dy=p.y-mob.y, dsq=dx*dx+dy*dy;
      if(dsq<minD2){minD2=dsq;target=p;}
    }
    if (!target && mob.aggroTarget) {
      const p = getPlayer(match, mob.aggroTarget);
      if (p && p.alive) {
        const dx = p.x - mob.x, dy = p.y - mob.y;
        const leash = mob.aggroRange * 1.5;
        if (dx * dx + dy * dy < leash * leash) { target = p; }
      }
    }
    mob.aggroTarget = target ? target.id : null;
  }

  const target = mob.aggroTarget ? getPlayer(match, mob.aggroTarget) : null;

  if (target && target.alive) {
    const dx = target.x - mob.x, dy = target.y - mob.y;
    const d2 = Math.sqrt(dx * dx + dy * dy);
    
    if (mob.ranged) {
      const idealDist = mob.atkRange * 0.7;
      if (d2 < idealDist * 0.5) {
        mob.vx = -(dx / d2) * mob.speed;
        mob.vy = -(dy / d2) * mob.speed;
      } else if (d2 > mob.atkRange * 0.9) {
        mob.vx = (dx / d2) * mob.speed;
        mob.vy = (dy / d2) * mob.speed;
      } else {
        mob.vx *= 0.85;
        mob.vy *= 0.85;
      }
      
      if (now - mob.lastAtk > mob.atkCd && d2 <= mob.atkRange) {
        mob.lastAtk = now;
        const angle = Math.atan2(dy, dx);
        const pSpd = mob.projSpeed || 300;
        
        if (mob.cone && mob.coneCount) {
          for (let i = 0; i < mob.coneCount; i++) {
            const spread = (i - (mob.coneCount - 1) / 2) * 0.2;
            match.mobBullets.push({
              x: mob.x + Math.cos(angle + spread) * mob.radius,
              y: mob.y + Math.sin(angle + spread) * mob.radius,
              vx: Math.cos(angle + spread) * pSpd,
              vy: Math.sin(angle + spread) * pSpd,
              dmg: mob.dmg, r: 8, life: 1200,
              color: mob.projColor || mob.color,
              type: 'fire'
            });
          }
          broadcastMatchRaw(match, JSON.stringify({
            type: 'mobAttack', mobType: 'dragon',
            x: Math.round(mob.x), y: Math.round(mob.y), angle: Math.round(angle * 100) / 100
          }));
        } else if (mob.chain) {
          match.mobBullets.push({
            x: mob.x + Math.cos(angle) * mob.radius,
            y: mob.y + Math.sin(angle) * mob.radius,
            vx: Math.cos(angle) * pSpd,
            vy: Math.sin(angle) * pSpd,
            dmg: mob.dmg, r: 6, life: 800,
            color: mob.projColor || mob.color,
            type: 'lightning'
          });
          broadcastMatchRaw(match, JSON.stringify({
            type: 'mobAttack', mobType: 'sentinel',
            x: Math.round(mob.x), y: Math.round(mob.y), angle: Math.round(angle * 100) / 100
          }));
        } else {
          match.mobBullets.push({
            x: mob.x + Math.cos(angle) * mob.radius,
            y: mob.y + Math.sin(angle) * mob.radius,
            vx: Math.cos(angle) * pSpd,
            vy: Math.sin(angle) * pSpd,
            dmg: mob.dmg, r: 5, life: 1500,
            color: mob.projColor || mob.color,
            type: 'bolt'
          });
        }
      }
    } else {
      if (d2 > mob.atkRange) {
        mob.vx = (dx / d2) * mob.speed;
        mob.vy = (dy / d2) * mob.speed;
      } else {
        mob.vx *= 0.8;
        mob.vy *= 0.8;
        if (now - mob.lastAtk > mob.atkCd) {
          mob.lastAtk = now;
          
          if (mob.aoe) {
            const aoeR = mob.aoeRadius || 70;
            for (const p of match.players) {
              if (!p.alive || p.invuln > 0) continue;
              const pdx = p.x - mob.x, pdy = p.y - mob.y;
              if (pdx * pdx + pdy * pdy < aoeR * aoeR) {
                serverDamage(match, p, mob.dmg, -1);
              }
            }
            broadcastMatchRaw(match, JSON.stringify({
              type: 'mobAttack', mobType: 'golem',
              x: Math.round(mob.x), y: Math.round(mob.y), radius: aoeR
            }));
          } else {
            serverDamage(match, target, mob.dmg, -1);
          }
        }
      }
    }
  } else {
    const dx = mob.homeX - mob.x, dy = mob.homeY - mob.y;
    const d2 = Math.sqrt(dx * dx + dy * dy);
    if (d2 > 5) {
      mob.vx = (dx / d2) * mob.speed * 0.5;
      mob.vy = (dy / d2) * mob.speed * 0.5;
    } else {
      mob.vx *= 0.9;
      mob.vy *= 0.9;
    }
    mob.aggroTarget = null;
    if (d2 < 20 && mob.hp < mob.maxHp) mob.hp = Math.min(mob.maxHp, mob.hp + dt * 15);
  }
  
  mob.x += mob.vx * dt;
  mob.y += mob.vy * dt;
  mob.x = clamp(mob.x, mob.radius, MAP_W - mob.radius);
  mob.y = clamp(mob.y, mob.radius, MAP_H - mob.radius);
}

function updateMobBullets(match, dt) {
  for (let i = match.mobBullets.length - 1; i >= 0; i--) {
    const mb = match.mobBullets[i];
    mb.life -= dt * 1000;
    if (mb.life <= 0) { match.mobBullets.splice(i, 1); continue; }
    mb.x += mb.vx * dt;
    mb.y += mb.vy * dt;
    if (mb.x < 0 || mb.x > MAP_W || mb.y < 0 || mb.y > MAP_H) {
      match.mobBullets.splice(i, 1); continue;
    }
    let hit = false;
    for (const w of match.walls) {
      if (mb.x >= w.x && mb.x <= w.x + w.w && mb.y >= w.y && mb.y <= w.y + w.h) {
        match.mobBullets.splice(i, 1); hit = true; break;
      }
    }
    if (hit) continue;
    _svShQueryOut.length=0; _svShQuery(mb.x, mb.y, mb.r + 30, _svShQueryOut);
    for (let _sqi=0; _sqi<_svShQueryOut.length; _sqi++) {
      const p = _svShQueryOut[_sqi];
      if (p._shType !== 'player' && p._shType !== 'minion') continue;
      if (!p.alive || p.invuln > 0) continue;
      if (mb.towerTeam && p.team === mb.towerTeam) continue;
      const dx = p.x - mb.x, dy = p.y - mb.y;
      if (dx * dx + dy * dy < ((p.radius||8) + mb.r) ** 2) {
        if (p._shType === 'player') {
          serverDamage(match, p, mb.dmg, -1);
        } else {
          p.hp -= mb.dmg;
          if (p.hp <= 0) p.alive = false;
        }
        broadcastMatchRaw(match, JSON.stringify({
          type: 'hit', targetId: p.id || p.ownerId, attackerId: -1,
          x: Math.round(mb.x), y: Math.round(mb.y), dmg: mb.dmg
        }));
        match.mobBullets.splice(i, 1);
        break;
      }
    }
  }
}

function updateMinions(match, owner, dt, now) {
  for (let i = owner.minions.length - 1; i >= 0; i--) {
    const m = owner.minions[i];
    if (!m.alive) { owner.minions.splice(i, 1); continue; }
    m.lifeTimer -= dt * 1000;
    if (m.lifeTimer <= 0) { m.alive = false; owner.minions.splice(i, 1); continue; }
    
    let nearest = null, minDist = 300;
    for (const p of match.players) {
      if (p.id === owner.id || !p.alive) continue;
      if (isAllyServer(owner, p, match)) continue;
      const dx = p.x - m.x, dy = p.y - m.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < minDist) { minDist = d; nearest = p; }
    }
    for (const camp of match.camps) {
      for (const mob of camp.mobs) {
        if (!mob.alive) continue;
        const dx = mob.x - m.x, dy = mob.y - m.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < minDist) { minDist = d; nearest = mob; }
      }
    }
    
    if (nearest) {
      const dx = nearest.x - m.x, dy = nearest.y - m.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > m.atkRange) {
        m.vx = (dx / d) * m.speed;
        m.vy = (dy / d) * m.speed;
      } else {
        m.vx *= 0.5; m.vy *= 0.5;
        if (now - m.lastAtk > m.atkCd) {
          m.lastAtk = now;
          if (nearest.id !== undefined) {
            serverDamage(match, nearest, m.dmg, owner.id);
            broadcastMatchRaw(match, JSON.stringify({ type:'minionAtk', x:Math.round(m.x), y:Math.round(m.y), tx:Math.round(nearest.x), ty:Math.round(nearest.y), dmg:m.dmg, ownerId:owner.id }));
          } else {
            nearest.hp -= m.dmg;
            if (nearest.hp <= 0) nearest.alive = false;
            broadcastMatchRaw(match, JSON.stringify({ type:'minionAtk', x:Math.round(m.x), y:Math.round(m.y), tx:Math.round(nearest.x), ty:Math.round(nearest.y), dmg:m.dmg, ownerId:owner.id }));
          }
        }
      }
    } else {
      const dx = owner.x - m.x, dy = owner.y - m.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 80) {
        m.vx = (dx / d) * m.speed * 0.8;
        m.vy = (dy / d) * m.speed * 0.8;
      } else {
        m.vx *= 0.5; m.vy *= 0.5;
      }
    }
    
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    m.x = clamp(m.x, m.radius, MAP_W - m.radius);
    m.y = clamp(m.y, m.radius, MAP_H - m.radius);
    checkWallCollision(m, match.walls);
  }
}

function updateGrenades(match, dt) {
  for (let i = match.grenades.length - 1; i >= 0; i--) {
    const g = match.grenades[i];
    g.timer -= dt * 1000;
    g.x += g.vx * dt;
    g.y += g.vy * dt;
    g.vx *= 0.97; g.vy *= 0.97;
    g.x = clamp(g.x, 5, MAP_W - 5);
    g.y = clamp(g.y, 5, MAP_H - 5);
    
    if (g.timer <= 0) {
      const aoeRadius = 100;
      const gOwner = getPlayer(match, g.owner);
      for (const p of match.players) {
        if (!p.alive || p.invuln > 0) continue;
        if (gOwner && isAllyServer(gOwner, p, match)) continue;
        const dx = p.x - g.x, dy = p.y - g.y;
        if (dx * dx + dy * dy < aoeRadius * aoeRadius) {
          const dist = Math.sqrt(dx * dx + dy * dy);
          const falloff = 1 - (dist / aoeRadius);
          const dmg = Math.round(40 * Math.max(0.3, falloff));
          serverDamage(match, p, dmg, g.owner);
          broadcastMatchRaw(match, JSON.stringify({ type:'hit', targetId:p.id, attackerId:g.owner, x:Math.round(g.x), y:Math.round(g.y), dmg }));
        }
      }
      for (const camp of match.camps) {
        for (const mob of camp.mobs) {
          if (!mob.alive) continue;
          const dx = mob.x - g.x, dy = mob.y - g.y;
          if (dx * dx + dy * dy < aoeRadius * aoeRadius) {
            mob.hp -= 40;
            if (mob.hp <= 0) mob.alive = false;
          }
        }
      }
      broadcastMatchRaw(match, JSON.stringify({ type:'explosion', x:Math.round(g.x), y:Math.round(g.y), radius:aoeRadius }));
      match.grenades.splice(i, 1);
    }
  }
}

function handleBuyConsumable(ws, msg) {
  const match = matches.get(ws.matchId);
  if (!match || match.gameOver) return;
  const p = getPlayer(match, ws.playerId);
  if (!p) return;
  
  const cDef = CONSUMABLE_DEFS[msg.id];
  if (!cDef) return;
  if (p.energy < cDef.cost) return;
  
  let placed = false;
  for (let i = 0; i < 5; i++) {
    if (p.consumables[i] && p.consumables[i].id === msg.id && p.consumables[i].count < cDef.maxStack) {
      p.consumables[i].count++;
      placed = true;
      break;
    }
  }
  if (!placed) {
    for (let i = 0; i < 5; i++) {
      if (!p.consumables[i]) {
        p.consumables[i] = { id: msg.id, count: 1 };
        placed = true;
        break;
      }
    }
  }
  if (!placed) return;
  
  p.energy -= cDef.cost;
  send(p.ws, { type:'consumableBought', slot: p.consumables.findIndex(c => c && c.id === msg.id), id: msg.id, energy: p.energy, consumables: p.consumables });
}

function handleUseConsumable(ws, msg) {
  const match = matches.get(ws.matchId);
  if (!match || match.gameOver) return;
  const p = getPlayer(match, ws.playerId);
  if (!p || !p.alive) return;
  // Rate-limit: one consumable use per 500ms — prevents client spam
  const now = match.nowCache;
  if (p._lastConsumableUse && now - p._lastConsumableUse < 500) return;
  p._lastConsumableUse = now;

  const slot = parseInt(msg.slot);
  if (slot < 0 || slot >= 5) return;
  const item = p.consumables[slot];
  if (!item) return;
  
  const cDef = CONSUMABLE_DEFS[item.id];
  if (!cDef) return;
  
  switch (item.id) {
    case 'healthPot':
      p.hp = Math.min(p.maxHp, p.hp + 50);
      broadcastMatchRaw(match, JSON.stringify({ type:'consumableUsed', playerId:p.id, item:'healthPot', x:Math.round(p.x), y:Math.round(p.y) }));
      break;
    case 'dmgBoost':
      p.dmgBoostTimer = 6000;
      broadcastMatchRaw(match, JSON.stringify({ type:'consumableUsed', playerId:p.id, item:'dmgBoost', x:Math.round(p.x), y:Math.round(p.y) }));
      break;
    case 'speedBoost':
      p.spdBoostTimer = 5000;
      broadcastMatchRaw(match, JSON.stringify({ type:'consumableUsed', playerId:p.id, item:'speedBoost', x:Math.round(p.x), y:Math.round(p.y) }));
      break;
    case 'smokeBomb':
      p.invisTimer = 3000;
      broadcastMatchRaw(match, JSON.stringify({ type:'consumableUsed', playerId:p.id, item:'smokeBomb', x:Math.round(p.x), y:Math.round(p.y) }));
      break;
    case 'wardStone':
      broadcastMatchRaw(match, JSON.stringify({ type:'consumableUsed', playerId:p.id, item:'wardStone', x:Math.round(p.x), y:Math.round(p.y) }));
      break;
    case 'manaPot':
      p.energy = Math.min(999, (p.energy || 0) + 40);
      broadcastMatchRaw(match, JSON.stringify({ type:'consumableUsed', playerId:p.id, item:'manaPot', x:Math.round(p.x), y:Math.round(p.y) }));
      break;
    case 'adrenaline':
      p.adrenalineTimer = 6000;
      broadcastMatchRaw(match, JSON.stringify({ type:'consumableUsed', playerId:p.id, item:'adrenaline', x:Math.round(p.x), y:Math.round(p.y) }));
      break;
    case 'teleScroll': {
      let tx = SHOP_ZONE.x + SHOP_ZONE.w / 2, ty = SHOP_ZONE.y + SHOP_ZONE.h / 2;
      if (match.teamMode && match.towers) {
        const myTower = match.towers.find(t => t.team === p.team && t.alive);
        if (myTower) { tx = myTower.x; ty = myTower.y + 50; }
      }
      const safe = findSafeSpawnServer(tx, ty, p.radius, match.walls);
      p.x = safe.x; p.y = safe.y;
      p.vx = 0; p.vy = 0;
      broadcastMatchRaw(match, JSON.stringify({ type:'consumableUsed', playerId:p.id, item:'teleScroll', x:Math.round(p.x), y:Math.round(p.y) }));
      break;
    }
    case 'invulnPot':
      p.invuln = 2000;
      broadcastMatchRaw(match, JSON.stringify({ type:'consumableUsed', playerId:p.id, item:'invulnPot', x:Math.round(p.x), y:Math.round(p.y) }));
      break;
    case 'grenade':
      match.grenades.push({
        x: p.x + Math.cos(p.angle) * 25,
        y: p.y + Math.sin(p.angle) * 25,
        vx: Math.cos(p.angle) * 400,
        vy: Math.sin(p.angle) * 400,
        owner: p.id, timer: 1500, radius: 5
      });
      broadcastMatchRaw(match, JSON.stringify({ type:'grenadeThrown', playerId:p.id, x:Math.round(p.x), y:Math.round(p.y), angle:p.angle }));
      break;
  }
  
  item.count--;
  if (item.count <= 0) p.consumables[slot] = null;
  
  send(p.ws, { type:'consumableUpdate', consumables: p.consumables, energy: p.energy });
}

function updateTraps(match, dt) {
  if (!match.traps) return;
  for (let i = match.traps.length - 1; i >= 0; i--) {
    const trap = match.traps[i];
    trap.timer -= dt * 1000;
    if (trap.timer <= 0 || !trap.armed) { match.traps.splice(i, 1); continue; }
    for (const p of match.players) {
      if (!p.alive || p.invuln > 0 || p.id === trap.owner) continue;
      const dx = p.x - trap.x, dy = p.y - trap.y;
      if (dx * dx + dy * dy < (p.radius + trap.radius) * (p.radius + trap.radius)) {
        trap.armed = false;
        serverDamage(match, p, trap.dmg, trap.owner);
        p.vx = 0; p.vy = 0; p.invuln = -trap.rootDuration;
        broadcastMatchRaw(match, JSON.stringify({ type:'hit', targetId:p.id, attackerId:trap.owner, x:Math.round(trap.x), y:Math.round(trap.y), dmg:trap.dmg }));
        break;
      }
    }
    if (!trap.armed) continue;
    for (const camp of match.camps) {
      for (const mob of camp.mobs) {
        if (!mob.alive) continue;
        const dx = mob.x - trap.x, dy = mob.y - trap.y;
        if (dx * dx + dy * dy < (mob.radius + trap.radius) * (mob.radius + trap.radius)) {
          trap.armed = false; mob.hp -= trap.dmg; mob.vx = 0; mob.vy = 0;
          if (mob.hp <= 0) mob.alive = false;
          break;
        }
      }
      if (!trap.armed) break;
    }
  }
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function checkWallCollision(obj, walls) {
  for (const w of walls) {
    if (obj.x + obj.radius > w.x && obj.x - obj.radius < w.x + w.w &&
        obj.y + obj.radius > w.y && obj.y - obj.radius < w.y + w.h) {
      const left   = (obj.x + obj.radius) - w.x;
      const right  = (w.x + w.w) - (obj.x - obj.radius);
      const top    = (obj.y + obj.radius) - w.y;
      const bottom = (w.y + w.h) - (obj.y - obj.radius);
      const min = Math.min(left, right, top, bottom);
      if (min === left)       { obj.x = w.x - obj.radius; obj.vx *= -0.3; }
      else if (min === right) { obj.x = w.x + w.w + obj.radius; obj.vx *= -0.3; }
      else if (min === top)   { obj.y = w.y - obj.radius; obj.vy *= -0.3; }
      else                    { obj.y = w.y + w.h + obj.radius; obj.vy *= -0.3; }
    }
  }
}