// ═══════════════════════════════════════════════════════════════
// SFX_MULTIPLAYER.JS — Multiplayer-aware spatial audio
// Extends sfx.js:
//   • Spatial / positional audio (sounds from enemy positions)
//   • Per-player sound de-duplication (don't fire 4 shoot sounds
//     for 4 simultaneous bullets from remote players)
//   • Audio budget — caps total concurrent sounds to avoid crackle
//   • Missing sfx hooks wired to network events
//   • Volume sliders persisted in localStorage
// Load AFTER sfx.js.
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// SPATIAL CONFIG
// ─────────────────────────────────────────────────────────────
const SFX_SPATIAL = {
  enabled:    true,
  maxDist:    1800,   // world units — beyond this, silent
  refDist:    300,    // world units — full volume within this
  rolloff:    1.4,    // how fast volume drops with distance
  stereoPan:  true,   // pan sounds left/right by horizontal position
  maxPan:     0.9     // clamp panning to ±this value
};

// Maximum simultaneous one-shot sounds before we start dropping
const SFX_BUDGET = 24;
let _sfxActive = 0;

// Per-player cooldowns (ms) to prevent spamming the same sound
const _playerSfxCd  = new Map(); // playerId → { sfxKey: timestamp }
const SFX_PLAYER_CD = {
  shoot:   80,   // ms — gunner fires at ~320ms, so 80ms prevents duplicate-frame firing
  hit:    120,
  dash:   100,
  special: 0,
  ult:     0
};

// ─────────────────────────────────────────────────────────────
// BUDGET WRAPPER
// Every sound that produces audio nodes should go through this.
// ─────────────────────────────────────────────────────────────
function _withBudget(fn) {
  if (!audioCtx) return;
  if (_sfxActive >= SFX_BUDGET) return; // drop — too many active sounds
  _sfxActive++;
  fn();
  // AudioContext sounds auto-complete; we track budget approximately
  // by decrementing after the typical max sound duration (500ms)
  setTimeout(() => { _sfxActive = Math.max(0, _sfxActive - 1); }, 500);
}

// ─────────────────────────────────────────────────────────────
// SPATIAL HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Compute [volume 0-1, pan -1 to +1] for a world position
 * relative to the local player.
 */
function _spatialGain(wx, wy) {
  if (!SFX_SPATIAL.enabled || !gameState) return { vol: 1, pan: 0 };

  const lp = getLocalPlayer(gameState);
  if (!lp) return { vol: 1, pan: 0 };

  const dx = wx - lp.x;
  const dy = wy - lp.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist > SFX_SPATIAL.maxDist) return { vol: 0, pan: 0 };

  // Inverse power law rolloff
  const vol = dist <= SFX_SPATIAL.refDist
    ? 1
    : Math.pow(SFX_SPATIAL.refDist / dist, SFX_SPATIAL.rolloff);

  // Stereo pan proportional to horizontal offset
  const pan = SFX_SPATIAL.stereoPan
    ? Math.max(-SFX_SPATIAL.maxPan, Math.min(SFX_SPATIAL.maxPan,
        dx / SFX_SPATIAL.maxDist * SFX_SPATIAL.maxPan * 2))
    : 0;

  return { vol, pan };
}

/**
 * Wrap a regular sfx call with spatial volume + panning.
 * gainNode   — the Web Audio GainNode to route through (usually sfxGain)
 * spatialFn  — function(effectiveGain, pannerNode) that creates the sound
 */
function _playSpatial(wx, wy, spatialFn) {
  if (!audioCtx) return;
  const { vol, pan } = _spatialGain(wx, wy);
  if (vol < 0.01) return; // inaudible — skip entirely

  _withBudget(() => {
    const spatialGain = audioCtx.createGain();
    spatialGain.gain.value = vol;

    let dest = spatialGain;
    if (pan !== 0 && audioCtx.createStereoPanner) {
      const panner = audioCtx.createStereoPanner();
      panner.pan.value = pan;
      spatialGain.connect(panner);
      panner.connect(sfxGain);
    } else {
      spatialGain.connect(sfxGain);
    }

    spatialFn(spatialGain);
  });
}

// ─────────────────────────────────────────────────────────────
// PER-PLAYER COOLDOWN GATE
// ─────────────────────────────────────────────────────────────
function _playerCdOk(playerId, sfxKey) {
  const cd = SFX_PLAYER_CD[sfxKey] || 0;
  if (cd === 0) return true;
  const now = performance.now();
  if (!_playerSfxCd.has(playerId)) _playerSfxCd.set(playerId, {});
  const map = _playerSfxCd.get(playerId);
  if (!map[sfxKey] || now - map[sfxKey] >= cd) {
    map[sfxKey] = now;
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// SPATIAL SOUND FUNCTIONS
// These are the NEW multiplayer-aware versions.
// Call these from network.js event handlers where you have a
// world position (wx, wy) and optionally a playerId.
// ─────────────────────────────────────────────────────────────

/** Remote player fired a shot */
function sfxRemoteShoot(playerId, cls, wx, wy) {
  if (!audioCtx) return;
  if (!_playerCdOk(playerId, 'shoot')) return;
  resumeAudio();

  _playSpatial(wx, wy, (g) => {
    // Re-use the existing sfxShoot synthesis but routed through spatial gain
    // We duplicate minimal synthesis inline to route to 'g' not sfxGain
    if (cls === 'mage') {
      _spatialTone(600, 'sine', 0.15, g, 0.18);
      _spatialTone(900, 'sine', 0.12, g, 0.1, 10);
    } else if (cls === 'assassin') {
      _spatialNoise(0.06, g, 0.12, 6000, 'highpass');
    } else if (cls === 'tank') {
      _spatialTone(80, 'square', 0.2, g, 0.18);
      _spatialNoise(0.15, g, 0.1, 800);
    } else if (cls === 'ranger') {
      _spatialTone(400, 'triangle', 0.08, g, 0.13);
    } else if (cls === 'necro') {
      _spatialTone(150, 'sawtooth', 0.18, g, 0.1);
    } else {
      // gunner
      _spatialTone(300, 'square', 0.06, g, 0.13);
      _spatialNoise(0.04, g, 0.09, 5000);
    }
  });
}

/** Remote player was hit */
function sfxRemoteHit(targetId, wx, wy) {
  if (!audioCtx) return;
  if (!_playerCdOk(targetId, 'hit')) return;
  resumeAudio();

  // If target is our own player, use the existing louder self-hit sound
  if (targetId === myPlayerId) {
    sfxHit(true);
    return;
  }

  _playSpatial(wx, wy, (g) => {
    _spatialNoise(0.08, g, 0.12, 2000);
    _spatialTone(350, 'sine', 0.06, g, 0.08);
  });
}

/** Remote player dashed */
function sfxRemoteDash(playerId, wx, wy) {
  if (!audioCtx) return;
  if (!_playerCdOk(playerId, 'dash')) return;
  resumeAudio();

  _playSpatial(wx, wy, (g) => {
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const env = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(1200, now + 0.08);
    env.gain.setValueAtTime(0.12, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(env); env.connect(g);
    osc.start(now); osc.stop(now + 0.15);
  });
}

/** Remote player died */
function sfxRemoteDeath(wx, wy) {
  if (!audioCtx) return;
  resumeAudio();
  _playSpatial(wx, wy, (g) => {
    _spatialTone(400, 'sawtooth', 0.3, g, 0.18);
    _spatialTone(200, 'sawtooth', 0.4, g, 0.13);
    _spatialNoise(0.25, g, 0.1, 1500);
  });
}

/** Remote player used special */
function sfxRemoteSpecial(cls, wx, wy) {
  if (!audioCtx) return;
  resumeAudio();
  _playSpatial(wx, wy, (g) => {
    if (cls === 'mage') {
      _spatialTone(500, 'sine', 0.2, g, 0.13);
      _spatialTone(700, 'sine', 0.15, g, 0.1);
    } else if (cls === 'assassin') {
      _spatialNoise(0.1, g, 0.08, 8000, 'highpass');
      _spatialTone(800, 'sine', 0.05, g, 0.08);
    } else if (cls === 'tank') {
      _spatialTone(150, 'sawtooth', 0.15, g, 0.13);
      _spatialNoise(0.1, g, 0.08, 1000);
    } else if (cls === 'necro') {
      _spatialTone(120, 'sawtooth', 0.3, g, 0.08);
    } else {
      _spatialTone(600, 'square', 0.08, g, 0.1);
    }
  });
}

/** Remote explosion (grenade, etc.) */
function sfxRemoteExplosion(wx, wy) {
  if (!audioCtx) return;
  resumeAudio();
  _playSpatial(wx, wy, (g) => {
    _spatialNoise(0.4, g, 0.28, 600);
    _spatialTone(60,  'sine',   0.35, g, 0.18);
    _spatialTone(40,  'square', 0.25, g, 0.08);
  });
}

/** Orb pickup (light sparkle) */
function sfxOrbPickupAt(wx, wy) {
  if (!audioCtx) return;
  resumeAudio();
  _playSpatial(wx, wy, (g) => {
    _spatialTone(800,  'sine', 0.06, g, 0.07);
    _spatialTone(1200, 'sine', 0.05, g, 0.05);
  });
}

/** Trap triggered */
function sfxTrapTriggered(wx, wy) {
  if (!audioCtx) return;
  resumeAudio();
  _playSpatial(wx, wy, (g) => {
    _spatialNoise(0.2, g, 0.18, 1200);
    _spatialTone(200, 'square', 0.15, g, 0.15);
    _spatialTone(120, 'sawtooth', 0.25, g, 0.1);
  });
}

/** Hook landed */
function sfxHookHitAt(wx, wy) {
  if (!audioCtx) return;
  resumeAudio();
  _playSpatial(wx, wy, (g) => {
    _spatialTone(300, 'square', 0.1, g, 0.16);
    _spatialNoise(0.08, g, 0.1, 2000);
    _spatialTone(150, 'sine', 0.15, g, 0.08);
  });
}

/** Mob attacks player */
function sfxMobAttackAt(wx, wy, mobType) {
  if (!audioCtx) return;
  resumeAudio();
  _playSpatial(wx, wy, (g) => {
    if (mobType === 'dragon') {
      _spatialTone(100, 'sawtooth', 0.25, g, 0.15);
      _spatialNoise(0.2, g, 0.14, 3000);
    } else if (mobType === 'golem') {
      _spatialTone(50, 'square', 0.3, g, 0.18);
      _spatialNoise(0.2, g, 0.16, 800);
    } else {
      _spatialNoise(0.1, g, 0.1, 2500);
      _spatialTone(200, 'sine', 0.08, g, 0.08);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// INTERNAL SPATIAL-ROUTED TONE / NOISE PRIMITIVES
// Same as sfx.js playTone/playNoise but route to a given gainNode
// instead of sfxGain (so spatial volume wraps them correctly).
// ─────────────────────────────────────────────────────────────
function _spatialTone(freq, type, duration, gainNode, volume = 0.2, detune = 0) {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const env = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  if (detune) osc.detune.value = detune;
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(volume, now + 0.01);
  env.gain.exponentialRampToValueAtTime(0.001, now + duration);
  osc.connect(env);
  env.connect(gainNode);
  osc.start(now);
  osc.stop(now + duration + 0.05);
}

function _spatialNoise(duration, gainNode, volume = 0.1, filterFreq = 4000, filterType = 'lowpass') {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const bufSize = Math.floor(audioCtx.sampleRate * duration);
  const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const filter = audioCtx.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.value = filterFreq;
  const env = audioCtx.createGain();
  env.gain.setValueAtTime(volume, now);
  env.gain.exponentialRampToValueAtTime(0.001, now + duration);
  src.connect(filter);
  filter.connect(env);
  env.connect(gainNode);
  src.start(now);
  src.stop(now + duration + 0.05);
}

// ─────────────────────────────────────────────────────────────
// NETWORK.JS INTEGRATION PATCH
// network.js already calls sfxHit / sfxDash / sfxSpecial etc. for
// local events. These wrappers redirect the *remote-player* versions
// to the spatial sounds above.
//
// Simply add these calls in the relevant handleServerMsg cases,
// or patch here after sfx.js/network.js are loaded.
// ─────────────────────────────────────────────────────────────

/**
 * Call this once after both sfx.js and network.js are loaded.
 * Patches handleServerMsg so remote events use spatial audio.
 */
function patchNetworkSfx() {
  // Guard — only patch once
  if (window._sfxNetworkPatched) return;
  window._sfxNetworkPatched = true;

  // Patch the 'hit' handler already in handleServerMsg:
  // The existing code calls sfxHit(msg.targetId===myPlayerId).
  // We replace it so remote hits play spatially.
  const _orig = typeof handleServerMsg === 'function' ? handleServerMsg : null;
  if (!_orig) return;

  window.handleServerMsg = function(msg) {
    // Run the original handler first (it handles game-state changes)
    _orig(msg);

    // Then add/override spatial audio on top
    switch (msg.type) {
      case 'hit':
        if (gameState) {
          const tp = gameState.players.find(p => p.id === msg.targetId);
          if (tp && tp.id !== myPlayerId) {
            sfxRemoteHit(tp.id, tp.x, tp.y);
          }
        }
        break;
      case 'dash':
        if (gameState) {
          const dp = gameState.players.find(p => p.id === msg.playerId);
          if (dp && dp.id !== myPlayerId) {
            sfxRemoteDash(dp.id, msg.toX, msg.toY);
          }
        }
        break;
      case 'specialUsed':
        if (gameState && msg.playerId !== myPlayerId) {
          const sp = gameState.players.find(p => p.id === msg.playerId);
          if (sp) sfxRemoteSpecial(msg.cls, sp.x, sp.y);
        }
        break;
      case 'kill': {
        if (gameState) {
          const vp = gameState.players.find(p => p.id === msg.victimId);
          if (vp && vp.id !== myPlayerId) {
            sfxRemoteDeath(vp.x, vp.y);
          }
        }
        break;
      }
      case 'explosion':
        sfxRemoteExplosion(msg.x, msg.y);
        break;
      case 'orbPickup':
        // Only play for remote pickups (local fires sfxOrbPickup already)
        if (msg.playerId !== myPlayerId) {
          sfxOrbPickupAt(msg.x, msg.y);
        }
        break;
      case 'hookHit':
        sfxHookHitAt(msg.hookX, msg.hookY);
        break;
      case 'mobAttack':
        sfxMobAttackAt(msg.x, msg.y, msg.mobType);
        break;
    }
  };
}

// ─────────────────────────────────────────────────────────────
// MISSING SFX FROM network.js (stubs were listed but not wired)
// These are already called in network.js; this file provides
// any that were missing or need a spatial version.
// ─────────────────────────────────────────────────────────────

// sfxRespawn() — already in sfx.js, called from network.js 'respawn' case ✓
// sfxDeath()   — already in sfx.js, called from network.js 'kill' case  ✓
// sfxKill()    — already in sfx.js                                       ✓
// sfxStreakAnnounce(streak) — already in sfx.js                          ✓

// ─────────────────────────────────────────────────────────────
// VOLUME PERSISTENCE (adds Save/Load for the existing AUDIO_SETTINGS)
// ─────────────────────────────────────────────────────────────
function loadAudioSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('ra3_audio') || 'null');
    if (!saved) return;
    const keys = ['master','sfx','music','ui','ambient'];
    keys.forEach(k => {
      if (saved[k] != null && typeof setVolume === 'function') {
        setVolume(k, saved[k]);
      }
    });
  } catch (e) {}
}

function saveAudioSettings() {
  try {
    localStorage.setItem('ra3_audio', JSON.stringify(AUDIO_SETTINGS));
  } catch (e) {}
}

// ─────────────────────────────────────────────────────────────
// AUDIO SETTINGS UI
// Creates a floating volume panel (toggle with M key or call
// toggleAudioPanel()). Shows sliders for all channels.
// ─────────────────────────────────────────────────────────────
function createAudioPanel() {
  if (document.getElementById('audioPanel')) return;

  const panel = document.createElement('div');
  panel.id = 'audioPanel';
  panel.style.cssText = `
    position:fixed; bottom:80px; right:14px; z-index:9000;
    background:rgba(0,0,0,0.88); color:#00f5ff;
    font:11px 'Share Tech Mono',monospace; padding:14px 18px;
    border:1px solid #00f5ff33; border-radius:8px; width:200px;
    display:none; backdrop-filter:blur(6px);
    box-shadow: 0 0 18px rgba(0,245,255,0.15);
  `;

  const channels = [
    { key:'master',  label:'MASTER' },
    { key:'sfx',     label:'SFX' },
    { key:'music',   label:'MUSIC' },
    { key:'ui',      label:'UI' },
    { key:'ambient', label:'AMBIENT' },
  ];

  let html = '<div style="letter-spacing:2px;margin-bottom:10px;font-size:10px;color:#888">🔊 AUDIO</div>';
  channels.forEach(ch => {
    const val = Math.round((AUDIO_SETTINGS[ch.key] || 0) * 100);
    html += `
      <div style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;margin-bottom:3px">
          <span>${ch.label}</span>
          <span id="audioLbl_${ch.key}" style="color:#fff">${val}%</span>
        </div>
        <input type="range" min="0" max="100" value="${val}"
          id="audioSlider_${ch.key}"
          style="width:100%;accent-color:#00f5ff;cursor:pointer"
          oninput="
            const v=this.value/100;
            setVolume('${ch.key}',v);
            document.getElementById('audioLbl_${ch.key}').textContent=this.value+'%';
            saveAudioSettings();
          ">
      </div>`;
  });

  html += `<div style="margin-top:10px;display:flex;gap:8px">
    <button onclick="if(musicPlaying)stopMusic();else startMusic();"
      style="flex:1;background:#0a1a2a;color:#00f5ff;border:1px solid #00f5ff44;
             border-radius:4px;padding:4px;cursor:pointer;font-size:10px">
      🎵 MUSIC
    </button>
    <button onclick="toggleAudioPanel();"
      style="flex:1;background:#0a1a2a;color:#888;border:1px solid #44444444;
             border-radius:4px;padding:4px;cursor:pointer;font-size:10px">
      CLOSE
    </button>
  </div>`;

  html += `<div style="margin-top:6px;font-size:9px;color:#444">M key to toggle</div>`;
  panel.innerHTML = html;
  document.body.appendChild(panel);
}

function toggleAudioPanel() {
  const panel = document.getElementById('audioPanel');
  if (!panel) { createAudioPanel(); toggleAudioPanel(); return; }
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

// M key to open audio panel
document.addEventListener('keydown', e => {
  if (e.code === 'KeyM' && !e.ctrlKey && !e.altKey) {
    // Don't steal M if we're typing in an input
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    toggleAudioPanel();
  }
});

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
function initSfxMultiplayer() {
  loadAudioSettings();
  createAudioPanel();
  // Patch network message handler for spatial audio on remote events
  // (safe to call early — patchNetworkSfx checks if handleServerMsg exists)
  if (typeof handleServerMsg === 'function') {
    patchNetworkSfx();
  } else {
    // Defer until network.js is ready
    window.addEventListener('load', patchNetworkSfx);
  }
}

// Auto-init once DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSfxMultiplayer);
} else {
  initSfxMultiplayer();
}
