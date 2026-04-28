// ═══════════════════════════════════════════════════════════════
// BINPROTO.JS — Binary protocol encoder/decoder for state sync
// ~10x smaller than JSON, ~5x faster to parse
// ═══════════════════════════════════════════════════════════════

// Packet types
const BIN_STATE = 0x01;

// Class enum
const CLS_MAP = ['gunner','assassin','mage','tank','necro','ranger'];
const CLS_IDX = {}; CLS_MAP.forEach((c,i) => CLS_IDX[c] = i);

// Upgrade bitfield mapping (18 upgrades → u32)
const UPG_LIST = [
  'rapidFire','doubleShot','pierce','homing','heavy','critStrike',
  'shield','regen','armor','fortify','thornmail','vitality',
  'speed','fastDash','teleport','boots','momentum','phaseWalk'
];
const UPG_IDX = {}; UPG_LIST.forEach((u,i) => UPG_IDX[u] = i);

// Player ability flags byte
const FLAG_ALIVE      = 1;
const FLAG_SWORD_ON   = 2;
const FLAG_NOVA_ON    = 4;
const FLAG_HOOK_ON    = 8;
const FLAG_BARRIER_ON = 16;
const FLAG_HOOK_RET   = 32;
const FLAG_HOOK_HIT   = 64;
const FLAG_NOVA_HIT   = 128;

// Mob bullet type enum
const MBTYPE_MAP = ['bolt','fire','lightning'];
const MBTYPE_IDX = {}; MBTYPE_MAP.forEach((t,i) => MBTYPE_IDX[t] = i);

// ═══════════════════════════════════════════════════════════════
// ENCODER (server-side)
// ═══════════════════════════════════════════════════════════════
function encodeBinaryState(match, elapsed, matchTimeLimit) {
  const MATCH_TIME = matchTimeLimit || 120;
  const players = match.players;
  const bullets = match.bullets;
  const mobBullets = match.mobBullets;
  const orbs = match.orbs;
  const grenades = match.grenades || [];
  const traps = (match.traps || []).filter(t => t.armed);

  // Calculate buffer size
  // Header: 1(type) + 4(time) + 4(tick) + 2(remaining) + 1(pCount) + 2(bCount) + 2(mbCount) + 2(oCount) + 1(gCount) + 1(tCount) + scoreBlock
  const scoreSize = players.length * 3; // id(1) + score(2)
  const headerSize = 20 + scoreSize;

  // Per player: 48 bytes base + variable ability data
  let playerSize = 0;
  const playerAbilityData = [];
  for (const p of players) {
    let abilBytes = 0;
    let flags = 0;
    if (p.alive) flags |= FLAG_ALIVE;
    if (p.swordOn) { flags |= FLAG_SWORD_ON; abilBytes += 6; } // angle(2)+sweep(2)+timer(2)
    if (p.novaOn) { flags |= FLAG_NOVA_ON; abilBytes += 10; } // r(2)+x(2)+y(2)+life(2)+reserved(2)
    if (p.novaHit) flags |= FLAG_NOVA_HIT;
    if (p.hookOn) {
      flags |= FLAG_HOOK_ON; abilBytes += 5; // x(2)+y(2)+target(1)
      if (p.hookReturning) flags |= FLAG_HOOK_RET;
      if (p.hookHit) flags |= FLAG_HOOK_HIT;
    }
    if (p.barrierOn) { flags |= FLAG_BARRIER_ON; abilBytes += 4; } // timer(2)+hp(2)
    playerAbilityData.push({ flags, abilBytes });
    playerSize += 59 + abilBytes; // 45 base + 14 new timer/state fields
  }

  const bulletSize = bullets.length * 11;
  const mobBulletSize = mobBullets.length * 10;
  const orbSize = orbs.length * 6;
  const grenadeSize = grenades.length * 8;
  const trapSize = traps.length * 6;

  const totalSize = headerSize + playerSize + bulletSize + mobBulletSize + orbSize + grenadeSize + trapSize;
  const buf = Buffer.alloc(totalSize);
  let off = 0;

  // === HEADER ===
  buf[off++] = BIN_STATE;
  buf.writeUInt32LE(Math.round(match.serverTime), off); off += 4;
  buf.writeUInt32LE(match.physicsTick, off); off += 4;
  buf.writeUInt16LE(Math.round((MATCH_TIME - elapsed) * 10), off); off += 2;
  buf[off++] = players.length;
  buf.writeUInt16LE(bullets.length, off); off += 2;
  buf.writeUInt16LE(mobBullets.length, off); off += 2;
  buf.writeUInt16LE(orbs.length, off); off += 2;
  buf[off++] = grenades.length;
  buf[off++] = traps.length;

  // Score block
  for (const p of players) {
    buf[off++] = p.id;
    buf.writeUInt16LE(match.score[p.id] || 0, off); off += 2;
  }

  // === PLAYERS ===
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const { flags, abilBytes } = playerAbilityData[i];

    buf[off++] = p.id;
    buf[off++] = CLS_IDX[p.cls] || 0;
    buf.writeUInt16LE(Math.round(p.x), off); off += 2;
    buf.writeUInt16LE(Math.round(p.y), off); off += 2;
    buf.writeInt16LE(Math.round(p.vx), off); off += 2;
    buf.writeInt16LE(Math.round(p.vy), off); off += 2;
    buf.writeInt16LE(Math.round(p.angle * 1000), off); off += 2; // milliradians
    buf.writeInt16LE(Math.round(p.hp), off); off += 2;
    buf.writeUInt16LE(Math.round(p.maxHp), off); off += 2;
    buf[off++] = flags;
    buf.writeUInt16LE(p.inputSeq || 0, off); off += 2;
    buf.writeUInt16LE(Math.floor(p.energy), off); off += 2;
    buf[off++] = Math.min(255, p.killStreak || 0);
    buf[off++] = Math.min(255, Math.round(p.shield || 0));
    buf.writeUInt16LE(Math.round(Math.max(0, p.invuln || 0)), off); off += 2;

    // Upgrade bitfield
    let upgBits = 0;
    if (Array.isArray(p.upgrades)) {
      for (const u of p.upgrades) {
        const idx = UPG_IDX[u];
        if (idx !== undefined) upgBits |= (1 << idx);
      }
    }
    buf.writeUInt32LE(upgBits, off); off += 4;

    // Streak data
    buf[off++] = Math.round((p.streakDmgBoost - 1) * 100);
    buf[off++] = Math.round((p.streakSpdBoost - 1) * 100);
    buf.writeUInt16LE(Math.round(p.streakDmgTimer || 0), off); off += 2;
    buf.writeUInt16LE(Math.round(p.streakSpdTimer || 0), off); off += 2;

    // Timers
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

    // Conditional ability data
    if (flags & FLAG_SWORD_ON) {
      buf.writeInt16LE(Math.round((p.swordAngle || 0) * 1000), off); off += 2;
      buf.writeUInt16LE(Math.round((p.swordSweep || 0) * 1000), off); off += 2;
      buf.writeUInt16LE(Math.round(p.swordTimer || 0), off); off += 2;
    }
    if (flags & FLAG_NOVA_ON) {
      buf.writeUInt16LE(Math.round(p.novaR || 0), off); off += 2;
      buf.writeUInt16LE(Math.round(p.novaX || 0), off); off += 2;
      buf.writeUInt16LE(Math.round(p.novaY || 0), off); off += 2;
      buf.writeUInt16LE(Math.round(p.novaLife || 0), off); off += 2;
      buf.writeUInt16LE(0, off); off += 2; // reserved
    }
    if (flags & FLAG_HOOK_ON) {
      buf.writeUInt16LE(Math.round(p.hookX || 0), off); off += 2;
      buf.writeUInt16LE(Math.round(p.hookY || 0), off); off += 2;
      buf[off++] = p.hookTarget || 0;
    }
    if (flags & FLAG_BARRIER_ON) {
      buf.writeUInt16LE(Math.round(p.barrierTimer || 0), off); off += 2;
      buf.writeUInt16LE(Math.round(p.barrierHp || 0), off); off += 2;
    }
  }

  // === BULLETS === (10 bytes each)
  for (const b of bullets) {
    buf.writeUInt16LE(Math.round(b.x), off); off += 2;
    buf.writeUInt16LE(Math.round(b.y), off); off += 2;
    buf.writeInt16LE(Math.round(b.vx), off); off += 2;
    buf.writeInt16LE(Math.round(b.vy), off); off += 2;
    buf[off++] = b.owner;
    buf[off++] = (b.r & 0x1F) | (b.isMage ? 0x20 : 0) | (b.pierce ? 0x40 : 0) | (b.homing ? 0x80 : 0);
    buf[off++] = (b.isSnipe ? 0x01 : 0) | (b.isArrow ? 0x02 : 0);
  }

  // === MOB BULLETS === (10 bytes each)
  for (const mb of mobBullets) {
    buf.writeUInt16LE(Math.round(mb.x), off); off += 2;
    buf.writeUInt16LE(Math.round(mb.y), off); off += 2;
    buf.writeInt16LE(Math.round(mb.vx), off); off += 2;
    buf.writeInt16LE(Math.round(mb.vy), off); off += 2;
    buf[off++] = mb.dmg || 10;
    buf[off++] = (mb.r & 0x1F) | ((MBTYPE_IDX[mb.type || 'bolt'] || 0) << 5);
  }

  // === ORBS === (6 bytes each)
  for (const o of orbs) {
    buf.writeUInt16LE(Math.round(o.x), off); off += 2;
    buf.writeUInt16LE(Math.round(o.y), off); off += 2;
    buf[off++] = o.value;
    buf[off++] = Math.round(o.r);
  }

  // === GRENADES === (8 bytes each)
  for (const g of grenades) {
    buf.writeUInt16LE(Math.round(g.x), off); off += 2;
    buf.writeUInt16LE(Math.round(g.y), off); off += 2;
    buf.writeUInt16LE(Math.round(g.timer), off); off += 2;
    buf[off++] = g.owner;
    buf[off++] = 0; // padding
  }

  // === TRAPS === (6 bytes each)
  for (const t of traps) {
    buf.writeUInt16LE(Math.round(t.x), off); off += 2;
    buf.writeUInt16LE(Math.round(t.y), off); off += 2;
    buf[off++] = t.owner;
    buf[off++] = t.radius;
  }

  return buf.slice(0, off);
}

// ═══════════════════════════════════════════════════════════════
// DECODER (client-side) — works with DataView on ArrayBuffer
// ═══════════════════════════════════════════════════════════════
function decodeBinaryState(arrayBuf) {
  let dv = new DataView(arrayBuf);
  let packetType = dv.getUint8(0);

  if (packetType === 0x02) { // BIN_DELTA
    if (typeof window === 'undefined') return null; // Server shouldn't decode deltas anyway
    if (!window._lastBinState) return null; // Missed base state
    const buf = new Uint8Array(arrayBuf);
    const lastBuf = window._lastBinState;
    const reconstructed = new Uint8Array(lastBuf.length);
    let rOff = 0;
    for (let i = 1; i < buf.length; i++) {
       const v = buf[i];
       if (v === 0) {
          const count = buf[++i];
          for (let c=0; c<count && rOff < reconstructed.length; c++) {
            reconstructed[rOff] = lastBuf[rOff];
            rOff++;
          }
       } else {
          if (rOff < reconstructed.length) {
            reconstructed[rOff] = v ^ lastBuf[rOff];
            rOff++;
          }
       }
    }
    window._lastBinState = reconstructed;
    dv = new DataView(reconstructed.buffer);
    packetType = dv.getUint8(0);
  } else if (packetType === BIN_STATE) {
    if (typeof window !== 'undefined') {
      window._lastBinState = new Uint8Array(arrayBuf);
    }
  } else {
    return null;
  }

  let off = 1;

  const t = dv.getUint32(off, true); off += 4;
  const tick = dv.getUint32(off, true); off += 4;
  const time = dv.getUint16(off, true) / 10; off += 2;
  const playerCount = dv.getUint8(off++);
  const bulletCount = dv.getUint16(off, true); off += 2;
  const mobBulletCount = dv.getUint16(off, true); off += 2;
  const orbCount = dv.getUint16(off, true); off += 2;
  const grenadeCount = dv.getUint8(off++);
  const trapCount = dv.getUint8(off++);

  // Score
  const score = {};
  for (let i = 0; i < playerCount; i++) {
    const id = dv.getUint8(off++);
    score[id] = dv.getUint16(off, true); off += 2;
  }

  // Players
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    const id = dv.getUint8(off++);
    const clsIdx = dv.getUint8(off++);
    const team = dv.getUint8(off++);
    const x = dv.getUint16(off, true); off += 2;
    const y = dv.getUint16(off, true); off += 2;
    const vx = dv.getInt16(off, true); off += 2;
    const vy = dv.getInt16(off, true); off += 2;
    const angle = dv.getInt16(off, true) / 1000; off += 2;
    const hp = dv.getInt16(off, true); off += 2;
    const maxHp = dv.getUint16(off, true); off += 2;
    const flags = dv.getUint8(off++);
    const seq = dv.getUint16(off, true); off += 2;
    const energy = dv.getUint16(off, true); off += 2;
    const killStreak = dv.getUint8(off++);
    const shield = dv.getUint8(off++);
    const invuln = dv.getUint16(off, true); off += 2;
    const upgBits = dv.getUint32(off, true); off += 4;
    const streakDmgBoostRaw = dv.getUint8(off++);
    const streakSpdBoostRaw = dv.getUint8(off++);
    const streakDmgTimer = dv.getUint16(off, true); off += 2;
    const streakSpdTimer = dv.getUint16(off, true); off += 2;
    const overchargeTimer = dv.getUint16(off, true); off += 2;
    const smokeTimer = dv.getUint16(off, true); off += 2;
    const fortifyTimer = dv.getUint16(off, true); off += 2;
    const dmgBoostTimer = dv.getUint16(off, true); off += 2;
    const spdBoostTimer = dv.getUint16(off, true); off += 2;
    const invisTimer = dv.getUint16(off, true); off += 2;
    const drainTimer = dv.getUint16(off, true); off += 2;
    const glowTimer = dv.getUint16(off, true); off += 2;
    const chargeTimer = dv.getUint16(off, true); off += 2;
    const adrenalineTimer = dv.getUint16(off, true); off += 2;
    const smokeX = dv.getInt16(off, true); off += 2;
    const smokeY = dv.getInt16(off, true); off += 2;

    // Decode upgrades from bitfield
    const upgrades = [];
    for (let b = 0; b < UPG_LIST.length; b++) {
      if (upgBits & (1 << b)) upgrades.push(UPG_LIST[b]);
    }

    const pd = {
      id, cls: CLS_MAP[clsIdx] || 'gunner', team,
      x, y, vx, vy, angle,
      hp, maxHp, alive: !!(flags & FLAG_ALIVE),
      seq, energy, killStreak, shield, invuln,
      upgrades,
      streakDmgBoost: 1 + streakDmgBoostRaw / 100,
      streakSpdBoost: 1 + streakSpdBoostRaw / 100,
      streakDmgTimer, streakSpdTimer,
      overchargeTimer, smokeTimer, fortifyTimer, dmgBoostTimer, spdBoostTimer,
      invisTimer, drainTimer, glowTimer, chargeTimer, adrenalineTimer,
      smokeX, smokeY,
      charging: chargeTimer > 0
    };

    // Conditional ability data
    if (flags & FLAG_SWORD_ON) {
      pd.swordOn = true;
      pd.swordAngle = dv.getInt16(off, true) / 1000; off += 2;
      pd.swordSweep = dv.getUint16(off, true) / 1000; off += 2;
      pd.swordTimer = dv.getUint16(off, true); off += 2;
    }
    if (flags & FLAG_NOVA_ON) {
      pd.novaOn = true;
      pd.novaR = dv.getUint16(off, true); off += 2;
      pd.novaX = dv.getUint16(off, true); off += 2;
      pd.novaY = dv.getUint16(off, true); off += 2;
      pd.novaLife = dv.getUint16(off, true); off += 2;
      off += 2; // reserved
      pd.novaHit = !!(flags & FLAG_NOVA_HIT);
    }
    if (flags & FLAG_HOOK_ON) {
      pd.hookOn = true;
      pd.hookX = dv.getUint16(off, true); off += 2;
      pd.hookY = dv.getUint16(off, true); off += 2;
      pd.hookTarget = dv.getUint8(off++);
      pd.hookReturning = !!(flags & FLAG_HOOK_RET);
      pd.hookHit = !!(flags & FLAG_HOOK_HIT);
    }
    if (flags & FLAG_BARRIER_ON) {
      pd.barrierOn = true;
      pd.barrierTimer = dv.getUint16(off, true); off += 2;
      pd.barrierHp = dv.getUint16(off, true); off += 2;
    }

    players.push(pd);
  }

  // Bullets
  const bullets = [];
  for (let i = 0; i < bulletCount; i++) {
    const x = dv.getUint16(off, true); off += 2;
    const y = dv.getUint16(off, true); off += 2;
    const bvx = dv.getInt16(off, true); off += 2;
    const bvy = dv.getInt16(off, true); off += 2;
    const owner = dv.getUint8(off++);
    const bflags = dv.getUint8(off++);
    const bflags2 = dv.getUint8(off++);
    bullets.push({
      x, y, vx: bvx, vy: bvy, owner,
      r: bflags & 0x1F,
      isMage: !!(bflags & 0x20),
      pierce: !!(bflags & 0x40),
      homing: !!(bflags & 0x80),
      isSnipe: !!(bflags2 & 0x01),
      isArrow: !!(bflags2 & 0x02)
    });
  }

  // Mob bullets
  const mobBullets = [];
  for (let i = 0; i < mobBulletCount; i++) {
    const x = dv.getUint16(off, true); off += 2;
    const y = dv.getUint16(off, true); off += 2;
    const mbvx = dv.getInt16(off, true); off += 2;
    const mbvy = dv.getInt16(off, true); off += 2;
    const dmg = dv.getUint8(off++);
    const mbflags = dv.getUint8(off++);
    mobBullets.push({
      x, y, vx: mbvx, vy: mbvy, dmg,
      r: mbflags & 0x1F,
      type: MBTYPE_MAP[(mbflags >> 5) & 0x07] || 'bolt'
    });
  }

  // Orbs
  const orbsOut = [];
  for (let i = 0; i < orbCount; i++) {
    const x = dv.getUint16(off, true); off += 2;
    const y = dv.getUint16(off, true); off += 2;
    const value = dv.getUint8(off++);
    const r = dv.getUint8(off++);
    orbsOut.push({ x, y, value, r });
  }

  // Grenades
  const grenadesOut = [];
  for (let i = 0; i < grenadeCount; i++) {
    const x = dv.getUint16(off, true); off += 2;
    const y = dv.getUint16(off, true); off += 2;
    const timer = dv.getUint16(off, true); off += 2;
    const owner = dv.getUint8(off++);
    off++; // padding
    grenadesOut.push({ x, y, timer, owner });
  }

  // Traps
  const trapsOut = [];
  for (let i = 0; i < trapCount; i++) {
    const x = dv.getUint16(off, true); off += 2;
    const y = dv.getUint16(off, true); off += 2;
    const owner = dv.getUint8(off++);
    const radius = dv.getUint8(off++);
    trapsOut.push({ x, y, owner, radius, armed: true });
  }

  return {
    type: 'state', t, tick, time, score,
    players, bullets, mobBullets,
    orbs: orbsOut, grenades: grenadesOut, traps: trapsOut,
    _binary: true, _size: off
  };
}

// Export for Node.js (server), browser uses globals
try {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = { encodeBinaryState, decodeBinaryState, CLS_MAP, CLS_IDX, UPG_LIST, UPG_IDX, BIN_STATE };
  }
} catch(e) { /* browser — globals are fine */ }
