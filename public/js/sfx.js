// ═══════════════════════════════════════════════════════════════
// SFX.JS — Procedural sound effects using Web Audio API
// No external files needed — all sounds synthesized at runtime
// ═══════════════════════════════════════════════════════════════

let audioCtx = null;
let masterGain = null;
let musicGain = null;
let sfxGain = null;
let uiGain = null;
let ambientGain = null;
let audioInitialized = false;
let musicPlaying = false;
let currentMusic = null;

// Volume settings (0-1)
const AUDIO_SETTINGS = {
  master: 0.5,
  sfx: 0.7,
  music: 0.25,
  ui: 0.5,
  ambient: 0.3
};

function initAudio() {
  if (audioInitialized) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = AUDIO_SETTINGS.master;
    masterGain.connect(audioCtx.destination);

    sfxGain = audioCtx.createGain();
    sfxGain.gain.value = AUDIO_SETTINGS.sfx;
    sfxGain.connect(masterGain);

    musicGain = audioCtx.createGain();
    musicGain.gain.value = AUDIO_SETTINGS.music;
    musicGain.connect(masterGain);

    uiGain = audioCtx.createGain();
    uiGain.gain.value = AUDIO_SETTINGS.ui;
    uiGain.connect(masterGain);

    ambientGain = audioCtx.createGain();
    ambientGain.gain.value = AUDIO_SETTINGS.ambient;
    ambientGain.connect(masterGain);

    audioInitialized = true;
  } catch (e) { console.warn('Audio init failed:', e); }
}

function resumeAudio() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

// ═══════════════════════════════════════════════════════════════
// UTILITY — Create oscillator + envelope
// ═══════════════════════════════════════════════════════════════
function playTone(freq, type, duration, gainNode, volume = 0.3, detune = 0) {
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

function playNoise(duration, gainNode, volume = 0.1, filterFreq = 4000, filterType = 'lowpass') {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const bufferSize = audioCtx.sampleRate * duration;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
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

// ═══════════════════════════════════════════════════════════════
// COMBAT SOUNDS
// ═══════════════════════════════════════════════════════════════
function sfxShoot(cls) {
  if (!audioCtx) return;
  resumeAudio();
  if (cls === 'mage') {
    playTone(600, 'sine', 0.15, sfxGain, 0.2);
    playTone(900, 'sine', 0.12, sfxGain, 0.12, 10);
    playNoise(0.08, sfxGain, 0.06, 2000);
  } else if (cls === 'assassin') {
    playNoise(0.06, sfxGain, 0.15, 6000, 'highpass');
    playTone(200, 'sawtooth', 0.08, sfxGain, 0.12);
  } else if (cls === 'tank') {
    playTone(80, 'square', 0.2, sfxGain, 0.2);
    playNoise(0.15, sfxGain, 0.12, 800);
  } else if (cls === 'ranger') {
    playTone(400, 'triangle', 0.08, sfxGain, 0.15);
    playNoise(0.05, sfxGain, 0.08, 3000, 'highpass');
  } else if (cls === 'necro') {
    playTone(150, 'sawtooth', 0.18, sfxGain, 0.12);
    playTone(180, 'sine', 0.15, sfxGain, 0.1, -5);
  } else {
    // Gunner
    playTone(300, 'square', 0.06, sfxGain, 0.15);
    playNoise(0.04, sfxGain, 0.1, 5000);
  }
}

function sfxHit(isSelf) {
  if (!audioCtx) return;
  resumeAudio();
  const vol = isSelf ? 0.25 : 0.15;
  playNoise(0.08, sfxGain, vol, 2000);
  playTone(isSelf ? 200 : 350, 'sine', 0.06, sfxGain, vol * 0.6);
  // high-freq crunch for tactile impact
  playNoise(0.04, sfxGain, vol * 0.7, 9000, 'highpass');
}

function sfxKill() {
  if (!audioCtx) return;
  resumeAudio();
  playTone(600, 'square', 0.05, sfxGain, 0.15);
  playTone(800, 'square', 0.05, sfxGain, 0.12);
  setTimeout(() => {
    playTone(1000, 'sine', 0.1, sfxGain, 0.1);
    playTone(1200, 'sine', 0.08, sfxGain, 0.08);
  }, 60);
}

function sfxDeath() {
  if (!audioCtx) return;
  resumeAudio();
  playTone(400, 'sawtooth', 0.3, sfxGain, 0.2);
  playTone(200, 'sawtooth', 0.4, sfxGain, 0.15);
  playNoise(0.25, sfxGain, 0.12, 1500);
}

function sfxDash() {
  if (!audioCtx) return;
  resumeAudio();
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const env = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(300, now);
  osc.frequency.exponentialRampToValueAtTime(1200, now + 0.08);
  env.gain.setValueAtTime(0.15, now);
  env.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
  osc.connect(env); env.connect(sfxGain);
  osc.start(now); osc.stop(now + 0.15);
  playNoise(0.06, sfxGain, 0.08, 6000, 'highpass');
}

function sfxExplosion() {
  if (!audioCtx) return;
  resumeAudio();
  const now = audioCtx.currentTime;
  // sub-bass drop: 120Hz → 18Hz over 0.5s
  const sub = audioCtx.createOscillator();
  const subEnv = audioCtx.createGain();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(120, now);
  sub.frequency.exponentialRampToValueAtTime(18, now + 0.5);
  subEnv.gain.setValueAtTime(0.4, now);
  subEnv.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
  sub.connect(subEnv); subEnv.connect(sfxGain);
  sub.start(now); sub.stop(now + 0.6);
  // body noise + mid thud
  playNoise(0.4, sfxGain, 0.3, 600);
  playTone(60, 'sine', 0.35, sfxGain, 0.2);
  playTone(40, 'square', 0.25, sfxGain, 0.1);
}

function sfxSpecial(cls) {
  if (!audioCtx) return;
  resumeAudio();
  if (cls === 'mage') {
    // Nova burst
    playTone(500, 'sine', 0.2, sfxGain, 0.15);
    playTone(700, 'sine', 0.15, sfxGain, 0.12);
    playNoise(0.1, sfxGain, 0.08, 3000);
  } else if (cls === 'assassin') {
    // Shadow step
    playNoise(0.1, sfxGain, 0.1, 8000, 'highpass');
    playTone(800, 'sine', 0.05, sfxGain, 0.1);
    playTone(1200, 'sine', 0.04, sfxGain, 0.08);
  } else if (cls === 'tank') {
    // Hook launch
    playTone(150, 'sawtooth', 0.15, sfxGain, 0.15);
    playNoise(0.1, sfxGain, 0.1, 1000);
  } else if (cls === 'necro') {
    // Soul drain
    playTone(120, 'sawtooth', 0.3, sfxGain, 0.1);
    playTone(180, 'sine', 0.25, sfxGain, 0.08, -20);
  } else {
    playTone(600, 'square', 0.08, sfxGain, 0.12);
    playTone(800, 'square', 0.06, sfxGain, 0.1);
  }
}

function sfxUltimate() {
  if (!audioCtx) return;
  resumeAudio();
  const notes = [400, 600, 800, 1000, 1200];
  notes.forEach((f, i) => {
    setTimeout(() => {
      playTone(f, 'sine', 0.15, sfxGain, 0.12);
      playTone(f * 1.5, 'triangle', 0.12, sfxGain, 0.06);
    }, i * 40);
  });
  playNoise(0.3, sfxGain, 0.1, 4000);
}

function sfxHookHit() {
  if (!audioCtx) return;
  resumeAudio();
  playTone(300, 'square', 0.1, sfxGain, 0.18);
  playNoise(0.08, sfxGain, 0.12, 2000);
  playTone(150, 'sine', 0.15, sfxGain, 0.1);
}

function sfxChargeUp(pct) {
  if (!audioCtx) return;
  resumeAudio();
  const freq = 200 + pct * 800;
  playTone(freq, 'sine', 0.04, sfxGain, 0.05 + pct * 0.1);
}

function sfxSnipe() {
  if (!audioCtx) return;
  resumeAudio();
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const env = audioCtx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(1200, now);
  osc.frequency.exponentialRampToValueAtTime(100, now + 0.3);
  env.gain.setValueAtTime(0.2, now);
  env.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
  osc.connect(env); env.connect(sfxGain);
  osc.start(now); osc.stop(now + 0.4);
  playNoise(0.2, sfxGain, 0.15, 3000);
}

// ═══════════════════════════════════════════════════════════════
// UI SOUNDS
// ═══════════════════════════════════════════════════════════════
function sfxClick() {
  if (!audioCtx) return;
  resumeAudio();
  playTone(800, 'sine', 0.03, uiGain, 0.1);
  playTone(1200, 'sine', 0.02, uiGain, 0.06);
}

function sfxHover() {
  if (!audioCtx) return;
  resumeAudio();
  playTone(1000, 'sine', 0.02, uiGain, 0.04);
}

function sfxUpgrade() {
  if (!audioCtx) return;
  resumeAudio();
  const notes = [523, 659, 784, 1047]; // C5 E5 G5 C6
  notes.forEach((f, i) => {
    setTimeout(() => playTone(f, 'sine', 0.15, uiGain, 0.12), i * 80);
  });
}

function sfxQueueFound() {
  if (!audioCtx) return;
  resumeAudio();
  playTone(523, 'sine', 0.15, uiGain, 0.15);
  setTimeout(() => playTone(659, 'sine', 0.15, uiGain, 0.15), 100);
  setTimeout(() => playTone(784, 'sine', 0.2, uiGain, 0.18), 200);
  setTimeout(() => playTone(1047, 'sine', 0.3, uiGain, 0.15), 300);
}

function sfxStreakAnnounce(streak) {
  if (!audioCtx) return;
  resumeAudio();
  const base = 400 + Math.min(streak, 10) * 50;
  for (let i = 0; i < Math.min(streak, 5); i++) {
    setTimeout(() => {
      playTone(base + i * 100, 'square', 0.08, sfxGain, 0.12);
      playTone(base + i * 150, 'sine', 0.06, sfxGain, 0.08);
    }, i * 50);
  }
}

function sfxOrbPickup() {
  if (!audioCtx) return;
  resumeAudio();
  playTone(800, 'sine', 0.06, sfxGain, 0.08);
  playTone(1200, 'sine', 0.05, sfxGain, 0.06);
}

function sfxRespawn() {
  if (!audioCtx) return;
  resumeAudio();
  const notes = [300, 450, 600, 900];
  notes.forEach((f, i) => {
    setTimeout(() => playTone(f, 'triangle', 0.2, sfxGain, 0.1), i * 100);
  });
}

function sfxMatchEnd(won) {
  if (!audioCtx) return;
  resumeAudio();
  if (won) {
    const notes = [523, 659, 784, 1047, 1318];
    notes.forEach((f, i) => {
      setTimeout(() => {
        playTone(f, 'sine', 0.3, uiGain, 0.15);
        playTone(f * 0.5, 'triangle', 0.25, uiGain, 0.08);
      }, i * 120);
    });
  } else {
    playTone(400, 'sawtooth', 0.5, uiGain, 0.12);
    setTimeout(() => playTone(300, 'sawtooth', 0.5, uiGain, 0.1), 200);
    setTimeout(() => playTone(200, 'sawtooth', 0.7, uiGain, 0.08), 400);
  }
}

// ═══════════════════════════════════════════════════════════════
// AMBIENT — Low drone + pulse (loops via ScriptProcessor)
// ═══════════════════════════════════════════════════════════════
let ambientNode = null;

function startAmbient() {
  if (!audioCtx || ambientNode) return;
  resumeAudio();
  // Low ambient drone using oscillators
  const osc1 = audioCtx.createOscillator();
  const osc2 = audioCtx.createOscillator();
  const lfo = audioCtx.createOscillator();
  const lfoGain = audioCtx.createGain();
  const mix = audioCtx.createGain();

  osc1.type = 'sine'; osc1.frequency.value = 55;
  osc2.type = 'triangle'; osc2.frequency.value = 82.5;
  lfo.type = 'sine'; lfo.frequency.value = 0.15;
  lfoGain.gain.value = 8;
  mix.gain.value = 0.15;

  lfo.connect(lfoGain);
  lfoGain.connect(osc1.frequency);
  lfoGain.connect(osc2.frequency);
  osc1.connect(mix); osc2.connect(mix);
  mix.connect(ambientGain);

  osc1.start(); osc2.start(); lfo.start();
  ambientNode = { osc1, osc2, lfo, mix };
}

function stopAmbient() {
  if (!ambientNode) return;
  try {
    ambientNode.osc1.stop(); ambientNode.osc2.stop(); ambientNode.lfo.stop();
  } catch (e) {}
  ambientNode = null;
}

// ═══════════════════════════════════════════════════════════════
// MUSIC — Procedural synthwave loop
// ═══════════════════════════════════════════════════════════════
let musicLoop = null;
let musicTimer = null;

function startMusic() {
  if (!audioCtx || musicPlaying) return;
  resumeAudio();
  musicPlaying = true;

  // Synthwave arpeggio pattern
  const SCALE = [130.81, 146.83, 164.81, 174.61, 196, 220, 246.94, 261.63]; // C3 to C4
  const PATTERN = [0, 2, 4, 7, 4, 2, 5, 3]; // Arpeggio indices
  let step = 0;
  const BPM = 128;
  const stepTime = (60 / BPM) / 2; // 16th notes

  function playStep() {
    if (!musicPlaying || !audioCtx) return;
    const freq = SCALE[PATTERN[step % PATTERN.length]];
    const octave = Math.floor(step / PATTERN.length) % 2 === 0 ? 1 : 2;

    // Arp lead
    playTone(freq * octave, 'sawtooth', stepTime * 0.8, musicGain, 0.06);
    playTone(freq * octave * 1.005, 'sawtooth', stepTime * 0.7, musicGain, 0.04); // Detune for thickness

    // Bass on every 4 steps
    if (step % 4 === 0) {
      playTone(freq * 0.5, 'square', stepTime * 3, musicGain, 0.08);
    }

    // Kick drum on beat
    if (step % 8 === 0) {
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const env = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(150, now);
      osc.frequency.exponentialRampToValueAtTime(40, now + 0.1);
      env.gain.setValueAtTime(0.15, now);
      env.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.connect(env); env.connect(musicGain);
      osc.start(now); osc.stop(now + 0.2);
    }

    // Hi-hat on offbeats
    if (step % 2 === 1) {
      playNoise(0.03, musicGain, 0.04, 8000, 'highpass');
    }

    step++;
    musicTimer = setTimeout(playStep, stepTime * 1000);
  }

  playStep();
}

function stopMusic() {
  musicPlaying = false;
  if (musicTimer) { clearTimeout(musicTimer); musicTimer = null; }
}

function toggleMusic() {
  if (musicPlaying) stopMusic();
  else startMusic();
}

// ═══════════════════════════════════════════════════════════════
// VOLUME CONTROL
// ═══════════════════════════════════════════════════════════════
function setVolume(type, value) {
  AUDIO_SETTINGS[type] = Math.max(0, Math.min(1, value));
  if (type === 'master' && masterGain) masterGain.gain.value = value;
  if (type === 'sfx' && sfxGain) sfxGain.gain.value = value;
  if (type === 'music' && musicGain) musicGain.gain.value = value;
  if (type === 'ui' && uiGain) uiGain.gain.value = value;
  if (type === 'ambient' && ambientGain) ambientGain.gain.value = value;
}

// ═══════════════════════════════════════════════════════════════
// AUTO-INIT on first user interaction
// ═══════════════════════════════════════════════════════════════
document.addEventListener('click', function audioBootstrap() {
  initAudio();
  document.removeEventListener('click', audioBootstrap);
}, { once: true });

document.addEventListener('keydown', function audioBootstrap2() {
  initAudio();
  document.removeEventListener('keydown', audioBootstrap2);
}, { once: true });
