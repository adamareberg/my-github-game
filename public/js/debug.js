// ═══════════════════════════════════════════════════════════════
// DEBUG.JS — Live debug overlay (F3 or `)
// Sections: PERF · NET · PLAYER · MATCH · WORLD
// ═══════════════════════════════════════════════════════════════

// Guard against double-loading (let would throw "already declared" on second load)
if (typeof debugOverlayVisible === 'undefined') var debugOverlayVisible = false;
if (typeof debugStats === 'undefined') var debugStats = {
  fps: 0, fpsFrames: 0, fpsTimer: 0, fpsSmooth: 60,
  frameMs: 0, _frameStart: 0,
  ping: 0, pingJitter: 0, pingHistory: [],
  packetLoss: 0, interpDelay: 0, snapshotCount: 0,
  bytesIn: 0, bytesInRate: 0, bytesInTimer: 0, bytesInAccum: 0,
  networkQuality: 'offline', stateFormat: 'json', lastStateSize: 0,
  extrapolating: false,
};

if (typeof _dbgEl === 'undefined') var _dbgEl = null;
function _getDbgEl() {
  if (_dbgEl) return _dbgEl;
  _dbgEl = document.getElementById('debugOverlay');
  return _dbgEl;
}

function initDebugOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'debugOverlay';
  overlay.style.cssText = [
    'position:fixed', 'top:10px', 'left:10px', 'z-index:99999',
    'background:rgba(2,5,14,0.93)', 'color:#c0d8f0',
    'font:11px/1.55 "Share Tech Mono",monospace',
    'padding:10px 14px', 'border:1px solid #1a3050', 'border-radius:6px',
    'pointer-events:none', 'display:none', 'min-width:260px',
    'backdrop-filter:blur(6px)', 'max-height:90vh', 'overflow:hidden'
  ].join(';');
  document.body.appendChild(overlay);
  _dbgEl = overlay;

  // Backtick (`) toggles the overlay
  document.addEventListener('keydown', e => {
    if (e.code === 'Backquote') {
      e.preventDefault();
      debugOverlayVisible = !debugOverlayVisible;
      overlay.style.display = debugOverlayVisible ? 'block' : 'none';
    }
  });
}

function updateDebugStats(dt) {
  const s = debugStats;
  s._frameStart = performance.now();

  // FPS
  s.fpsFrames++;
  s.fpsTimer += dt;
  if (s.fpsTimer >= 0.5) {
    s.fps = Math.round(s.fpsFrames / s.fpsTimer);
    s.fpsSmooth = s.fpsSmooth * 0.7 + s.fps * 0.3;
    s.fpsFrames = 0;
    s.fpsTimer = 0;
  }

  // Bandwidth
  s.bytesInTimer += dt;
  if (s.bytesInTimer >= 1) {
    s.bytesInRate = s.bytesInAccum;
    s.bytesInAccum = 0;
    s.bytesInTimer = 0;
  }

  // Network globals
  s.ping = typeof netPing !== 'undefined' ? netPing : 0;
  if (s.pingHistory.length > 20) s.pingHistory.shift();
  s.pingHistory.push(s.ping);
  if (s.pingHistory.length > 2) {
    const avg = s.pingHistory.reduce((a,b)=>a+b,0) / s.pingHistory.length;
    s.pingJitter = Math.round(s.pingHistory.reduce((a,b)=>a+Math.abs(b-avg),0) / s.pingHistory.length);
  }
  s.packetLoss    = typeof packetLoss    !== 'undefined' ? packetLoss    : 0;
  s.interpDelay   = typeof INTERP_DELAY_MS !== 'undefined' ? INTERP_DELAY_MS : 0;
  s.snapshotCount = typeof snapshotBuffer  !== 'undefined' ? snapshotBuffer.length : 0;
  s.networkQuality= typeof networkQuality  !== 'undefined' ? networkQuality : 'offline';
}

function renderDebugOverlay() {
  const el = _getDbgEl();
  if (!el) return;

  const s   = debugStats;
  const gs  = typeof gameState !== 'undefined' ? gameState : null;
  const lp  = gs ? (typeof getLocalPlayer === 'function' ? getLocalPlayer(gs) : gs.players?.[0]) : null;
  const now = performance.now();

  // Frame budget (ms since updateDebugStats was called)
  const frameMs = now - s._frameStart;

  // ── colour helpers ──
  const col = (v, good, warn) => v <= good ? '#00ff88' : v <= warn ? '#ffaa00' : '#ff3355';
  const bw  = s.bytesInRate < 1024
    ? s.bytesInRate + ' B/s'
    : (s.bytesInRate / 1024).toFixed(1) + ' KB/s';

  // ── PERF ──
  const fpsC = col(100 - s.fpsSmooth, 5, 20);        // inverted: lower loss = greener
  const msC  = col(frameMs, 10, 20);

  // ── NET ──
  const pingC = col(s.ping, 60, 120);
  const lossC = col(s.packetLoss * 100, 2, 8);
  const qC    = s.networkQuality === 'good' ? '#00ff88' : s.networkQuality === 'medium' ? '#ffaa00' : '#ff3355';
  const SEND_HZ = typeof SEND_EVERY !== 'undefined' ? Math.round(60 / SEND_EVERY) : '?';

  // ── PLAYER ──
  let playerHTML = '<span style="color:#555">— no player —</span>';
  if (lp) {
    const hpC    = col(lp.maxHp - lp.hp, 0, lp.maxHp * 0.4);
    const cdFmt  = ms => ms <= 0 ? '<span style="color:#00ff88">RDY</span>' : `<span style="color:#ffaa00">${(ms/1000).toFixed(1)}s</span>`;
    const lpNow  = now;
    const dashR  = Math.max(0, (lp.dashCd||2000) - (lpNow - (lp.lastDash||0)));
    const spR    = Math.max(0, (lp.spCd||4000)   - (lpNow - (lp.lastSp||0)));
    const ultR   = Math.max(0, (lp.ultCd||8000)  - (lpNow - (lp.lastUlt||0)));
    const upgArr = lp.upgrades ? (Array.isArray(lp.upgrades) ? lp.upgrades : Object.keys(lp.upgrades)) : [];
    playerHTML = `
<div>HP:     <span style="color:${hpC}">${Math.ceil(lp.hp)}/${lp.maxHp}</span>${lp.shield>0?` <span style="color:#4488ff">[+${Math.ceil(lp.shield)}⛊]</span>`:''}</div>
<div>EN:     <span style="color:#88aaff">${Math.floor(lp.energy||0)}</span></div>
<div>POS:    <span style="color:#888">${Math.round(lp.x)}, ${Math.round(lp.y)}</span></div>
<div>SPEED:  <span style="color:#888">${Math.round(Math.sqrt((lp.vx||0)**2+(lp.vy||0)**2))}</span></div>
<div>DASH:   ${cdFmt(dashR)}  SP: ${cdFmt(spR)}  ULT: ${cdFmt(ultR)}</div>
<div>ITEMS:  <span style="color:#aaa">${upgArr.length ? upgArr.join(' ') : '—'}</span></div>
<div>STREAK: <span style="color:#ffaa00">${lp.killStreak||0}🔥</span>${lp.alive?'':' <span style="color:#ff3355">DEAD</span>'}</div>`;
  }

  // ── MATCH ──
  let matchHTML = '<span style="color:#555">— no match —</span>';
  if (gs) {
    const elapsed = (now - gs.startTime) / 1000;
    const rem     = Math.max(0, (gs.matchTime || 300) - elapsed);
    const mins    = Math.floor(rem / 60);
    const secs    = Math.ceil(rem % 60);
    const scoreStr = gs.teamMode
      ? `🔵${gs.score?.[0]??0} — 🔴${gs.score?.[1]??0}`
      : Array.isArray(gs.score)
        ? gs.score.join(' / ')
        : Object.entries(gs.score||{}).map(([id,s])=>`P${id}:${s}`).join(' ');
    const alivePlayers = gs.players?.filter(p=>p.alive).length ?? 0;
    matchHTML = `
<div>TIME:   <span style="color:#00f5ff">${mins}:${secs<10?'0':''}${secs}</span></div>
<div>SCORE:  <span style="color:#ffcc00">${scoreStr}</span></div>
<div>MODE:   <span style="color:#aaa">${typeof playMode!=='undefined'?playMode:'?'}${gs.teamMode?' (team)':''}</span></div>
<div>ALIVE:  <span style="color:#aaa">${alivePlayers} / ${gs.players?.length??0} players</span></div>`;
  }

  // ── WORLD ──
  let worldHTML = '<span style="color:#555">—</span>';
  if (gs) {
    const bullets   = (gs.bullets?.length||0) + (gs.mobBullets?.length||0);
    const particles = gs.particles?.filter(p=>p.life>0).length ?? 0;
    const camps     = gs.camps?.length ?? 0;
    const deadCamps = gs.camps?.filter(c=>c.dead).length ?? 0;
    const orbs      = gs.orbs?.length ?? 0;
    const trails    = bulletTrails?.filter(t=>t.life>0).length ?? 0;
    worldHTML = `
<div>BULLETS:    <span style="color:#ff8844">${bullets}</span></div>
<div>PARTICLES:  <span style="color:#88aaff">${particles}/${MAX_PARTICLES}</span>  TRAILS: <span style="color:#88aaff">${trails}/${MAX_BULLET_TRAILS}</span></div>
<div>CAMPS:      <span style="color:#aaa">${camps - deadCamps} alive, ${deadCamps} dead</span></div>
<div>ORBS:       <span style="color:#ffcc00">${orbs}</span></div>`;
  }

  // Pull latest perf snapshot from network.js profiler variables (shared globals)
  const _pf = typeof _perfFrames !== 'undefined' && _perfFrames > 0;
  const _renderMs  = _pf ? (_perfRender / _perfFrames).toFixed(2) : '--';
  const _vfxMs     = _pf ? (_perfVfx    / _perfFrames).toFixed(2) : '--';
  const _gapMs     = _pf ? (_perfGapAccum / _perfFrames).toFixed(2) : '--';
  const _hz        = typeof _measuredHz !== 'undefined' ? _measuredHz : '--';
  const _budget    = _hz !== '--' ? (1000 / _hz).toFixed(2) : '--';
  const _headroom  = (_pf && _hz !== '--') ? (1000/_hz - (_perfRender+_perfVfx)/_perfFrames).toFixed(2) : '--';
  const hrC        = _headroom !== '--' ? col(parseFloat(_budget) - parseFloat(_headroom), 2, 4) : '#888';

  el.innerHTML = `
<div style="color:#00f5ff;margin-bottom:5px;font-size:10px;letter-spacing:2px">▸ DEBUG  <span style="color:#444;font-size:9px">[ \` ] to close</span></div>

<div style="color:#4a6080;font-size:9px;letter-spacing:2px;margin-bottom:2px">PERF</div>
<div>FPS:      <span style="color:${fpsC}">${Math.round(s.fpsSmooth)}</span>  (~<span style="color:#aaa">${_hz}Hz</span>)  FRAME: <span style="color:${msC}">${frameMs.toFixed(1)}ms</span></div>
<div>RENDER:   <span style="color:#88aaff">${_renderMs}ms</span>  VFX: <span style="color:#88aaff">${_vfxMs}ms</span></div>
<div>RAF-GAP:  <span style="color:#aaa">${_gapMs}ms</span>  BUDGET: <span style="color:#aaa">${_budget}ms</span></div>
<div>HEADROOM: <span style="color:${hrC}">${_headroom}ms</span></div>

<div style="color:#4a6080;font-size:9px;letter-spacing:2px;margin:4px 0 2px">NET</div>
<div>PING:   <span style="color:${pingC}">${s.ping}ms</span> <span style="color:#555">±${s.pingJitter}ms</span></div>
<div>LOSS:   <span style="color:${lossC}">${(s.packetLoss*100).toFixed(1)}%</span>  BW: <span style="color:#aaa">${bw}</span></div>
<div>INTERP: <span style="color:#88aaff">${Math.round(s.interpDelay)}ms</span>  BUF: <span style="color:#555">${s.snapshotCount}</span>  HZ: <span style="color:#555">${SEND_HZ}</span></div>
<div>QUAL:   <span style="color:${qC}">${s.networkQuality.toUpperCase()}</span>${s.extrapolating?' <span style="color:#ff8800">⚠ EXTRAP</span>':''}</div>

<div style="color:#4a6080;font-size:9px;letter-spacing:2px;margin:4px 0 2px">PLAYER</div>
${playerHTML}

<div style="color:#4a6080;font-size:9px;letter-spacing:2px;margin:4px 0 2px">MATCH</div>
${matchHTML}

<div style="color:#4a6080;font-size:9px;letter-spacing:2px;margin:4px 0 2px">WORLD</div>
${worldHTML}
`;
}

// Init on load
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDebugOverlay);
  } else {
    initDebugOverlay();
  }
}
