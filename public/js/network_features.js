// ═══════════════════════════════════════════════════════════════
// NETWORK_FEATURES.JS — Missing multiplayer features
// Load AFTER network.js.
//
// Adds:
//   1. Chat system (T to open, Enter to send, Escape to close)
//   2. Ready-up lobby (before matchStart)
//   3. Match reconnection (auto-rejoin a running match)
//   4. Team colour name-labels above remote players
//   5. Latency-compensated hit confirmation flash
//   6. Spectator mode on death (watch until respawn)
//   7. In-match scoreboard (Tab key)
//   8. Player emotes (1-4 while alive)
//   9. Minimap remote player dots
//  10. Ability cooldown sync display for remote players
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// 1. CHAT SYSTEM
// ─────────────────────────────────────────────────────────────
let chatOpen = false;
const MAX_CHAT_HISTORY = 40;
const chatHistory = []; // { name, color, text, time }

function createChatUI() {
  if (document.getElementById('chatContainer')) return;

  const css = document.createElement('style');
  css.textContent = `
    #chatContainer {
      position:fixed; bottom:110px; left:14px; z-index:5000;
      display:flex; flex-direction:column; gap:4px; pointer-events:none;
      width:340px;
    }
    #chatLog {
      max-height:160px; overflow:hidden;
      display:flex; flex-direction:column; gap:3px;
      pointer-events:none;
    }
    .chat-msg {
      font:12px 'Share Tech Mono',monospace; padding:3px 7px;
      background:rgba(0,0,0,0.65); border-radius:4px;
      border-left:2px solid transparent;
      animation: chatFadeIn 0.15s ease;
    }
    @keyframes chatFadeIn { from{opacity:0;transform:translateX(-8px)} to{opacity:1;transform:none} }
    .chat-msg.fade { animation: chatFadeOut 0.5s ease forwards; }
    @keyframes chatFadeOut { to{opacity:0} }
    #chatInputWrap {
      display:none; background:rgba(0,0,0,0.85);
      border:1px solid #00f5ff55; border-radius:6px;
      padding:6px 10px; pointer-events:all;
    }
    #chatInput {
      background:none; border:none; outline:none;
      color:#00f5ff; font:13px 'Share Tech Mono',monospace;
      width:100%; caret-color:#00f5ff;
    }
    #chatHint {
      font:9px 'Share Tech Mono',monospace; color:#444;
      margin-top:2px;
    }
  `;
  document.head.appendChild(css);

  const wrap = document.createElement('div');
  wrap.id = 'chatContainer';
  wrap.innerHTML = `
    <div id="chatLog"></div>
    <div id="chatInputWrap">
      <input id="chatInput" maxlength="80" placeholder="Say something…">
      <div id="chatHint">ENTER to send · ESC to close</div>
    </div>
  `;
  document.body.appendChild(wrap);

  const input = document.getElementById('chatInput');
  input.addEventListener('keydown', e => {
    e.stopPropagation(); // don't let game keys fire
    if (e.key === 'Enter') {
      const text = input.value.trim();
      if (text && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'chat', text }));
        // Optimistic: add our own message immediately
        const lp = gameState ? getLocalPlayer(gameState) : null;
        addChatMessage(lp?.name || PD.name, lp?.color || '#00f5ff', text);
      }
      input.value = '';
      closeChat();
    } else if (e.key === 'Escape') {
      input.value = '';
      closeChat();
    }
  });
}

function openChat() {
  if (chatOpen) return;
  chatOpen = true;
  document.getElementById('chatInputWrap').style.display = 'block';
  setTimeout(() => document.getElementById('chatInput').focus(), 0);
}

function closeChat() {
  chatOpen = false;
  document.getElementById('chatInputWrap').style.display = 'none';
  document.getElementById('chatInput').blur();
}

function addChatMessage(name, color, text) {
  chatHistory.push({ name, color, text, time: Date.now() });
  if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();

  const log = document.getElementById('chatLog');
  if (!log) return;

  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.style.borderLeftColor = color || '#888';
  div.innerHTML = `<span style="color:${color || '#aaa'}">${escHtml(name)}</span>: <span style="color:#ccc">${escHtml(text)}</span>`;
  log.appendChild(div);

  // Prune visible messages
  while (log.children.length > 8) log.removeChild(log.firstChild);

  // Auto-fade after 6s
  setTimeout(() => { div.classList.add('fade'); setTimeout(() => div.remove(), 500); }, 6000);
  log.scrollTop = log.scrollHeight;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─────────────────────────────────────────────────────────────
// 2. RECONNECTION
// If the connection drops mid-match, try to reconnect and rejoin.
// ─────────────────────────────────────────────────────────────
let _reconnectAttempts = 0;
let _reconnectTimer = null;
const MAX_RECONNECT = 5;
const RECONNECT_BASE_MS = 1500;

function scheduleReconnect() {
  if (_reconnectAttempts >= MAX_RECONNECT) return;
  if (_reconnectTimer) return;
  const delay = RECONNECT_BASE_MS * Math.pow(1.6, _reconnectAttempts);
  _reconnectAttempts++;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _attemptReconnect();
  }, delay);

  // Show reconnect notice in HUD
  const el = document.getElementById('serverStatus');
  if (el) {
    el.textContent = `⟳ RECONNECTING… (${_reconnectAttempts}/${MAX_RECONNECT})`;
    el.style.color = 'var(--amber, #ffaa00)';
  }
}

function _attemptReconnect() {
  if (!playMode || playMode !== 'online') return;
  const url = (typeof SERVER_URL !== 'undefined') ? SERVER_URL : null;
  if (!url) return;

  const newWs = new WebSocket(url.replace(/^http/, 'ws'));
  newWs.binaryType = 'arraybuffer';

  newWs.onopen = () => {
    _reconnectAttempts = 0;
    // Re-announce ourselves and try to rejoin
    newWs.send(JSON.stringify({
      type: 'rejoin',
      name: PD.name,
      cls: PD.cls,
      elo: PD.elo,
      prevId: myPlayerId
    }));

    // Replace global ws
    if (ws) { try { ws.close(); } catch(e) {} }
    window.ws = newWs;
    ws = newWs;
    _patchNewWs(newWs);

    const el = document.getElementById('serverStatus');
    if (el) { el.textContent = '● RECONNECTED'; el.style.color = 'var(--green, #00ff88)'; }
    addChatMessage('SYSTEM', '#888', 'Reconnected to server.');
  };

  newWs.onerror = () => scheduleReconnect();
  newWs.onclose = () => scheduleReconnect();
}

function _patchNewWs(socket) {
  socket.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      if (typeof debugStats !== 'undefined') {
        debugStats.bytesInAccum += e.data.byteLength;
        debugStats.lastStateSize = e.data.byteLength;
        debugStats.stateFormat = 'binary';
      }
      const msg = decodeBinaryState(e.data);
      if (msg && msg.type === 'state') handleStateSnapshot(msg);
      return;
    }
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleServerMsg(msg);
  };
}

// Hook into ws.onclose to trigger reconnect when in an active match
const _origClose = WebSocket.prototype.close;
function _installReconnectHook() {
  // Watch the global ws reference; if it closes during a match, reconnect
  setInterval(() => {
    if (playMode === 'online' && gameRunning && (!ws || ws.readyState === WebSocket.CLOSED)) {
      scheduleReconnect();
    }
  }, 2000);
}

// ─────────────────────────────────────────────────────────────
// 3. IN-MATCH SCOREBOARD (Tab key)
// ─────────────────────────────────────────────────────────────
let scoreboardVisible = false;

function createScoreboardUI() {
  if (document.getElementById('scoreboardOverlay')) return;

  const css = document.createElement('style');
  css.textContent = `
    #scoreboardOverlay {
      position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
      z-index:7000; background:rgba(0,0,0,0.9); border:1px solid #00f5ff33;
      border-radius:12px; padding:24px 32px; min-width:400px;
      font:13px 'Share Tech Mono',monospace; color:#ccc;
      display:none; backdrop-filter:blur(8px);
      box-shadow: 0 0 40px rgba(0,245,255,0.1);
    }
    #scoreboardOverlay h2 {
      text-align:center; color:#00f5ff; letter-spacing:4px;
      font-size:14px; margin:0 0 16px;
    }
    #scoreboardTable { width:100%; border-collapse:collapse; }
    #scoreboardTable th {
      color:#555; font-size:10px; letter-spacing:2px;
      padding:4px 8px; border-bottom:1px solid #111;
      text-align:left;
    }
    #scoreboardTable td { padding:6px 8px; border-bottom:1px solid #0a0a0a; }
    #scoreboardTable tr.me td { color:#00f5ff; }
    .sb-class-icon { font-size:16px; }
    #scoreboardHint { text-align:center; font-size:9px; color:#333; margin-top:12px; }
  `;
  document.head.appendChild(css);

  const el = document.createElement('div');
  el.id = 'scoreboardOverlay';
  el.innerHTML = `
    <h2>SCOREBOARD</h2>
    <table id="scoreboardTable">
      <thead><tr>
        <th></th><th>PLAYER</th><th>KILLS</th><th>STREAK</th><th>PING</th>
      </tr></thead>
      <tbody id="scoreboardBody"></tbody>
    </table>
    <div id="scoreboardHint">TAB to close</div>
  `;
  document.body.appendChild(el);
}

function renderScoreboard() {
  if (!gameState) return;
  const body = document.getElementById('scoreboardBody');
  if (!body) return;
  body.innerHTML = '';

  // Sort by kills
  const scores = Array.isArray(gameState.score)
    ? gameState.players.map((p,i) => ({ p, score: gameState.score[i] || 0 }))
    : gameState.players.map(p => ({ p, score: (gameState.score[p.id] || 0) }));
  scores.sort((a, b) => b.score - a.score);

  const icons = { gunner:'🔫', assassin:'⚔️', mage:'🔮', tank:'🛡', necro:'💀', ranger:'🏹' };
  scores.forEach(({ p, score }) => {
    const tr = document.createElement('tr');
    if (p.id === myPlayerId) tr.className = 'me';
    const teamDot = gameState.teamMode && p.team
      ? `<span style="color:${p.team===1?'#4488ff':'#ff4444'}">●</span> `
      : '';
    const pingStr = p.id === myPlayerId ? netPing + 'ms' : '—';
    tr.innerHTML = `
      <td class="sb-class-icon">${icons[p.cls] || '?'}</td>
      <td>${teamDot}<span style="color:${p.color}">${escHtml(p.name || p.cls.toUpperCase())}</span>
          ${!p.alive ? ' <span style="color:#555;font-size:10px">[DEAD]</span>' : ''}</td>
      <td style="color:#ffcc00">${score}</td>
      <td style="color:${p.killStreak>=5?'#ff3355':p.killStreak>=3?'#ffaa00':'#888'}">${p.killStreak}</td>
      <td style="color:#aaa">${pingStr}</td>
    `;
    body.appendChild(tr);
  });
}

function showScoreboard() {
  scoreboardVisible = true;
  renderScoreboard();
  const el = document.getElementById('scoreboardOverlay');
  if (el) el.style.display = 'block';
}

function hideScoreboard() {
  scoreboardVisible = false;
  const el = document.getElementById('scoreboardOverlay');
  if (el) el.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────
// 4. EMOTES
// ─────────────────────────────────────────────────────────────
const EMOTES = ['👋','🔥','💀','👑'];

// Emote bubbles rendered in world space
const _emoteBubbles = [];

function sendEmote(idx) {
  if (!gameState || gameState.gameOver || !gameRunning) return;
  const lp = getLocalPlayer(gameState);
  if (!lp || !lp.alive) return;
  const emote = EMOTES[idx];
  if (!emote) return;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'emote', idx }));
  // Show locally immediately
  _addEmoteBubble(lp.id, emote);
}

function _addEmoteBubble(playerId, emote) {
  _emoteBubbles.push({ playerId, emote, life: 2.5, maxLife: 2.5 });
}

function updateEmoteBubbles(dt) {
  for (let i = _emoteBubbles.length - 1; i >= 0; i--) {
    _emoteBubbles[i].life -= dt;
    if (_emoteBubbles[i].life <= 0) _emoteBubbles.splice(i, 1);
  }
}

function drawEmoteBubbles(ctx, cx, cy) {
  if (!gameState) return;
  for (const b of _emoteBubbles) {
    const p = gameState.players.find(pp => pp.id === b.playerId);
    if (!p || !p.alive) continue;
    const sx = p.x - cx, sy = p.y - cy;
    const t = 1 - b.life / b.maxLife;
    const alpha = b.life < 0.5 ? b.life / 0.5 : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '22px serif';
    ctx.textAlign = 'center';
    ctx.fillText(b.emote, sx, sy - p.radius - 20 - t * 20);
    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────────
// 5. MINIMAP REMOTE PLAYER DOTS
// Extends any existing minimap drawn in renderer.js
// ─────────────────────────────────────────────────────────────
function drawMinimapDots(ctx) {
  if (!gameState) return;
  const MM_W = 160, MM_H = 90;
  const MM_X = 14, MM_Y = 14;
  const scaleX = MM_W / W, scaleY = MM_H / H;

  ctx.save();
  ctx.globalAlpha = 0.85;

  for (const p of gameState.players) {
    if (!p.alive) continue;
    const mx = MM_X + p.x * scaleX;
    const my = MM_Y + p.y * scaleY;
    const isMe = p.id === myPlayerId;

    ctx.beginPath();
    ctx.arc(mx, my, isMe ? 4 : 3, 0, Math.PI * 2);
    ctx.fillStyle = isMe ? '#ffffff' : p.color;
    ctx.fill();

    if (isMe) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Draw orbs as tiny gold dots
  for (const o of (gameState.orbs || [])) {
    const mx = MM_X + o.x * scaleX;
    const my = MM_Y + o.y * scaleY;
    ctx.beginPath();
    ctx.arc(mx, my, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffcc00';
    ctx.fill();
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────────
// 6. PLAYER NAME-LABELS (world-space, above every player)
// Call drawPlayerLabels(ctx, camX, camY) from renderer.js
// after drawing players.
// ─────────────────────────────────────────────────────────────
function drawPlayerLabels(ctx, cx, cy) {
  if (!gameState) return;
  ctx.save();
  ctx.textAlign = 'center';
  for (const p of gameState.players) {
    if (!p.alive) continue;
    const sx = p.x - cx;
    const sy = p.y - cy - p.radius - 14;
    const isMe = p.id === myPlayerId;

    // Name
    ctx.font = isMe ? 'bold 11px Orbitron,monospace' : '10px Share Tech Mono,monospace';
    ctx.fillStyle = isMe ? '#ffffff' : (p.color || '#aaa');
    ctx.globalAlpha = 0.9;
    ctx.fillText(p.name || p.cls.toUpperCase(), sx, sy);

    // Tiny health bar under name (only for remote players)
    if (!isMe) {
      const barW = 36, barH = 3;
      const hpPct = Math.max(0, Math.min(1, p.hp / (p.maxHp || 100)));
      const barX = sx - barW / 2;
      const barY = sy + 3;
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = '#222';
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = hpPct > 0.5 ? '#00ff88' : hpPct > 0.25 ? '#ffaa00' : '#ff3355';
      ctx.fillRect(barX, barY, barW * hpPct, barH);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────
// 7. SPECTATOR MODE — watch on death
// When local player is dead and respawn timer is running,
// cycle camera through alive players with Z/X or left-click.
// ─────────────────────────────────────────────────────────────
let spectatorTarget = null;
let _spectatorEl = null;

function updateSpectatorMode(dt) {
  if (playMode !== 'online' || !gameState) return;
  const lp = getLocalPlayer(gameState);
  if (!lp || lp.alive) {
    spectatorTarget = null;
    if (_spectatorEl) _spectatorEl.style.display = 'none';
    return;
  }

  // Auto-pick first alive enemy/ally to follow
  const alive = gameState.players.filter(p => p.alive && p.id !== myPlayerId);
  if (!alive.length) { spectatorTarget = null; return; }

  if (!spectatorTarget || !alive.find(p => p.id === spectatorTarget)) {
    spectatorTarget = alive[0].id;
  }

  const target = alive.find(p => p.id === spectatorTarget);
  if (target) {
    // Move camera to spectator target
    const tx = Math.max(0, Math.min(W - VW, target.x - VW / 2));
    const ty = Math.max(0, Math.min(H - VH, target.y - VH / 2));
    camX += (tx - camX) * 0.12;
    camY += (ty - camY) * 0.12;
  }

  // Show spectator HUD
  if (!_spectatorEl) {
    _spectatorEl = document.createElement('div');
    _spectatorEl.style.cssText = `
      position:fixed; bottom:160px; left:50%; transform:translateX(-50%);
      z-index:5500; background:rgba(0,0,0,0.7); color:#888;
      font:11px 'Share Tech Mono',monospace; padding:6px 16px;
      border-radius:20px; border:1px solid #333; pointer-events:none;
      letter-spacing:2px;
    `;
    document.body.appendChild(_spectatorEl);
  }
  const t = alive.find(p => p.id === spectatorTarget);
  if (t) {
    _spectatorEl.innerHTML = `<span style="color:#555">SPECTATING</span> <span style="color:${t.color}">${t.name || t.cls.toUpperCase()}</span>`;
    _spectatorEl.style.display = 'block';
  }
}

function cycleSpectatorTarget(dir) {
  if (!gameState) return;
  const alive = gameState.players.filter(p => p.alive && p.id !== myPlayerId);
  if (!alive.length) return;
  const idx = alive.findIndex(p => p.id === spectatorTarget);
  const next = (idx + dir + alive.length) % alive.length;
  spectatorTarget = alive[next].id;
}

// ─────────────────────────────────────────────────────────────
// 8. READY-UP LOBBY
// Before the match starts the server may send a 'lobby' message.
// We show a ready panel; player clicks Ready and server waits for all.
// ─────────────────────────────────────────────────────────────
function createLobbyUI() {
  if (document.getElementById('lobbyOverlay')) return;

  const css = document.createElement('style');
  css.textContent = `
    #lobbyOverlay {
      position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
      z-index:8000; background:rgba(0,0,0,0.93); border:1px solid #00f5ff33;
      border-radius:12px; padding:28px 40px; min-width:320px; text-align:center;
      font:13px 'Share Tech Mono',monospace; color:#ccc; display:none;
      backdrop-filter:blur(10px);
    }
    #lobbyOverlay h2 { color:#00f5ff; letter-spacing:4px; font-size:15px; margin:0 0 18px; }
    #lobbyPlayers { margin:10px 0 18px; display:flex; flex-direction:column; gap:6px; }
    .lobby-player { display:flex; align-items:center; gap:8px; justify-content:center; font-size:12px; }
    .lobby-ready-icon { font-size:16px; }
    #lobbyReadyBtn {
      background:#001a2a; color:#00f5ff; border:1px solid #00f5ff66;
      border-radius:6px; padding:10px 28px; font:13px 'Share Tech Mono',monospace;
      letter-spacing:2px; cursor:pointer; transition: background 0.2s;
    }
    #lobbyReadyBtn:hover { background:#002a3a; }
    #lobbyReadyBtn.ready { background:#003a20; color:#00ff88; border-color:#00ff8866; }
    #lobbyCountdown { font-size:22px; color:#ffcc00; margin-top:8px; min-height:28px; }
  `;
  document.head.appendChild(css);

  const el = document.createElement('div');
  el.id = 'lobbyOverlay';
  el.innerHTML = `
    <h2>LOBBY</h2>
    <div id="lobbyPlayers"></div>
    <button id="lobbyReadyBtn" onclick="sendReady()">READY UP</button>
    <div id="lobbyCountdown"></div>
  `;
  document.body.appendChild(el);
}

let _isReady = false;
function sendReady() {
  _isReady = !_isReady;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ready', ready: _isReady }));
  const btn = document.getElementById('lobbyReadyBtn');
  if (btn) {
    btn.textContent = _isReady ? '✓ READY' : 'READY UP';
    btn.className = _isReady ? 'ready' : '';
  }
}

function updateLobbyUI(players, countdown) {
  const icons = { gunner:'🔫', assassin:'⚔️', mage:'🔮', tank:'🛡', necro:'💀', ranger:'🏹' };
  const el = document.getElementById('lobbyOverlay');
  if (!el) return;
  el.style.display = 'block';
  const playersEl = document.getElementById('lobbyPlayers');
  if (playersEl) {
    playersEl.innerHTML = players.map(p => `
      <div class="lobby-player">
        <span class="lobby-ready-icon">${p.ready ? '✅' : '⬜'}</span>
        <span style="color:${p.color || '#aaa'}">${icons[p.cls] || '?'} ${escHtml(p.name)}</span>
        <span style="color:#555;font-size:10px">${p.elo ? p.elo + ' ELO' : ''}</span>
      </div>
    `).join('');
  }
  const cdEl = document.getElementById('lobbyCountdown');
  if (cdEl) cdEl.textContent = countdown != null && countdown > 0 ? `Starting in ${countdown}…` : '';
}

function closeLobbyUI() {
  const el = document.getElementById('lobbyOverlay');
  if (el) el.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────
// SERVER MESSAGE EXTENSIONS
// Extend handleServerMsg to handle new message types.
// ─────────────────────────────────────────────────────────────
function _installNetworkFeatureHandlers() {
  if (window._netFeaturesPatched) return;
  window._netFeaturesPatched = true;

  const _orig = typeof handleServerMsg === 'function' ? handleServerMsg : null;
  if (!_orig) { window.addEventListener('load', _installNetworkFeatureHandlers); return; }

  window.handleServerMsg = function(msg) {
    _orig(msg);

    switch (msg.type) {
      case 'chat':
        addChatMessage(msg.name, msg.color || '#aaa', msg.text);
        break;

      case 'emote':
        _addEmoteBubble(msg.playerId, EMOTES[msg.idx] || '❓');
        break;

      case 'lobby':
        createLobbyUI();
        updateLobbyUI(msg.players || [], msg.countdown);
        break;

      case 'lobbyUpdate':
        updateLobbyUI(msg.players || [], msg.countdown);
        break;

      case 'matchStart':
        closeLobbyUI();
        _isReady = false;
        break;

      case 'playerDisconnected':
        addChatMessage('SYSTEM', '#555', (msg.name || 'A player') + ' disconnected.');
        break;

      case 'rejoinAck':
        // Server confirmed our rejoin — re-sync state
        if (msg.playerId) myPlayerId = msg.playerId;
        addChatMessage('SYSTEM', '#00f5ff', 'Rejoined match.');
        break;
    }
  };
}

// ─────────────────────────────────────────────────────────────
// KEYBOARD BINDINGS
// ─────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  // Chat
  if (e.code === 'KeyT' && gameRunning && !chatOpen && !gameState?.shopOpen) {
    e.preventDefault();
    openChat();
    return;
  }
  if (chatOpen) return; // block all game keys while chat is open

  // Scoreboard
  if (e.code === 'Tab') {
    e.preventDefault();
    if (gameRunning && playMode === 'online') showScoreboard();
    return;
  }

  // Emotes (Z then 1-4 while alive)
  if (e.code === 'KeyZ' && gameRunning) {
    e.preventDefault();
    // Show emote picker hint — simplified: just send emote 0 immediately
    // or tie to number row if desired
    sendEmote(0);
    return;
  }

  // Spectator cycle
  if (e.code === 'BracketLeft' && gameRunning) cycleSpectatorTarget(-1);
  if (e.code === 'BracketRight' && gameRunning) cycleSpectatorTarget(1);
});

document.addEventListener('keyup', e => {
  if (e.code === 'Tab') hideScoreboard();
});

// ─────────────────────────────────────────────────────────────
// INTEGRATION HOOKS FOR engine.js / renderer.js
// Call these from your main game loops.
// ─────────────────────────────────────────────────────────────

/**
 * Call from onlineGameLoop each frame (after updParticles etc.)
 */
function updateNetworkFeatures(dt) {
  updateEmoteBubbles(dt);
  updateSpectatorMode(dt);
}

/**
 * Call from render() after all players are drawn, before UI overlay.
 * ctx is the main canvas context; camX/camY are current offsets.
 */
function renderNetworkFeatures(ctx, cx, cy) {
  drawEmoteBubbles(ctx, cx, cy);
  drawPlayerLabels(ctx, cx, cy);
  // Minimap dots — only if minimap background is already drawn in renderer
  drawMinimapDots(ctx);
}

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
function initNetworkFeatures() {
  createChatUI();
  createScoreboardUI();
  _installNetworkFeatureHandlers();
  _installReconnectHook();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initNetworkFeatures);
} else {
  initNetworkFeatures();
}
