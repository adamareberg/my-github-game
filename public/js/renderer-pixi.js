// ═══════════════════════════════════════════════════════════════
// RENDERER-PIXI.JS  —  WebGL renderer via PixiJS v7
// Drop-in replacement for renderer.js.
// Game logic (engine, combat, network…) is unchanged.
// ═══════════════════════════════════════════════════════════════

// ── OVERLAY 2D CANVAS ─────────────────────────────────────────
// Sprite sheets, gradient shapes, text, debug — everything that
// needs Canvas 2D API sits on a transparent canvas above the WebGL
// canvas. engine.js binds its `ctx` to this overlay.
const _overlayCanvas = (function () {
  const c = document.createElement('canvas');
  c.id = 'overlayCanvas';
  c.style.cssText =
    'position:absolute;top:0;left:0;pointer-events:none;z-index:2;';
  c.width  = window.innerWidth;
  c.height = window.innerHeight;
  const app = document.getElementById('app');
  app.style.position = 'relative';
  app.appendChild(c);
  return c;
})();
const _overlayCtx = _overlayCanvas.getContext('2d', { alpha: true });

// ── PIXI APPLICATION ──────────────────────────────────────────
const pixiApp = new PIXI.Application({
  view: document.getElementById('gameCanvas'),
  width:  window.innerWidth,
  height: window.innerHeight,
  backgroundColor: 0x080c18,
  antialias: false,
  powerPreference: 'high-performance',
  resolution: 1,
  autoDensity: false,
});
pixiApp.ticker.stop(); // driven manually each frame

// ── SCENE GRAPH ───────────────────────────────────────────────
const _stage      = pixiApp.stage;
const _bgSpr      = new PIXI.Sprite(PIXI.Texture.EMPTY);
const worldCont   = new PIXI.Container();   // camera-transformed
const _tilesCont  = new PIXI.Container();   // tile-layer sprites (below world gfx)
const _staticGfx  = new PIXI.Graphics();    // static world (walls/border — rebuilt on map change)
const _wGfx       = new PIXI.Graphics();    // dynamic world (cleared every frame)
const _screenGfx  = new PIXI.Graphics();    // screen-space HUD (timer bar etc — every frame)
const _mmGfx      = new PIXI.Graphics();    // minimap — throttled to ~15fps
const _vignSpr    = new PIXI.Sprite(PIXI.Texture.EMPTY);
let   _mmAge      = 0; // frame counter for minimap throttle

const _entityCont = new PIXI.Container(); // GPU entity sprites — between walls and bullets

const _terrainCont = new PIXI.Container();
const _bloodCont   = new PIXI.ParticleContainer(200, {position:true, rotation:true, alpha:true, uvs:true});
const _objectsCont = new PIXI.Container();
const _lightsCont  = new PIXI.Container();
const _explosionsCont = new PIXI.Container();

_stage.addChild(_bgSpr, worldCont, _screenGfx, _mmGfx, _vignSpr);
worldCont.addChild(_tilesCont, _terrainCont, _bloodCont, _objectsCont, _staticGfx, _entityCont, _wGfx, _lightsCont, _explosionsCont);

// ── SOFT RADIAL TEXTURE (for lights and explosions) ─────────
const _softRadialTex = (function() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  return PIXI.Texture.from(c);
})();

// ── EXPLOSIONS POOL ──────────────────────────────────────────
const _explosionsPool = [];
for (let i = 0; i < 20; i++) {
  const s = new PIXI.Sprite(_softRadialTex);
  s.anchor.set(0.5);
  s.blendMode = PIXI.BLEND_MODES.ADD;
  s.visible = false;
  _explosionsCont.addChild(s);
  _explosionsPool.push({ sprite: s, life: 0, maxLife: 0.3, startR: 0, endR: 0 });
}

window.addExplosionPixi = function(x, y, radius, colorStr) {
  let p = _explosionsPool.find(e => e.life <= 0);
  if (!p) {
    const s = new PIXI.Sprite(_softRadialTex);
    s.anchor.set(0.5);
    s.blendMode = PIXI.BLEND_MODES.ADD;
    _explosionsCont.addChild(s);
    p = { sprite: s, life: 0, maxLife: 0.3, startR: 0, endR: 0 };
    _explosionsPool.push(p);
  }
  p.sprite.x = x;
  p.sprite.y = y;
  // Fallback to white if PIXI string2hex fails
  try {
    p.sprite.tint = PIXI.utils.string2hex(colorStr || '#ff8800');
  } catch (e) {
    p.sprite.tint = 0xffffff;
  }
  p.sprite.visible = true;
  p.life = 0.35;
  p.maxLife = 0.35;
  p.startR = radius * 0.2;
  p.endR = radius * 1.5;
}

let _lastExpTime = performance.now();
function _syncExplosionsPixi() {
  const now = performance.now();
  const dt = (now - _lastExpTime) / 1000;
  _lastExpTime = now;
  for (const p of _explosionsPool) {
    if (p.life > 0) {
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.visible = false;
        continue;
      }
      const t = 1 - (p.life / p.maxLife); // 0 to 1
      const ease = 1 - Math.pow(1 - t, 3); // cubic ease out
      const r = p.startR + (p.endR - p.startR) * ease;
      p.sprite.scale.set(r / 64); // base is 128x128 -> r=64
      p.sprite.alpha = (1 - t) * 1.2; // slight bloom at start
    }
  }
}

// ── LIGHTS POOL ──────────────────────────────────────────────
const _lightsPool = [];
function _getLightSprite() {
  let p = _lightsPool.find(e => !e.visible);
  if (!p) {
    p = new PIXI.Sprite(_softRadialTex);
    p.anchor.set(0.5);
    p.blendMode = PIXI.BLEND_MODES.ADD;
    _lightsCont.addChild(p);
    _lightsPool.push(p);
  }
  p.visible = true;
  return p;
}
function _resetLights() {
  for (const p of _lightsPool) p.visible = false;
}

function _syncLights(gs) {
  _resetLights();
  if (!gs) return;
  for (const p of gs.players) {
    if (!p.alive) continue;
    if ((p.smokeTimer > 0 || p.invisTimer > 0) && !p.isHuman) continue;
    const s = _getLightSprite();
    s.x = p.x; s.y = p.y;
    s.tint = _colorToHex(p.color || '#ffffff');
    s.scale.set((p.radius * 5) / 64);
    s.alpha = 0.18;
  }
  if (gs.bullets) {
    for (const b of gs.bullets) {
      if (b.life <= 0 || !b.isMage) continue;
      const s = _getLightSprite();
      s.x = b.x; s.y = b.y;
      s.tint = _colorToHex(b.color || '#cc44ff');
      s.scale.set(30 / 64);
      s.alpha = 0.28;
    }
  }
}


// ── MOODY POST-PROCESS FILTER ─────────────────────────────
const _moodFrag = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform float uTime;
uniform float uShake;
uniform float uLowHp;

void main(void){
  vec2 uv = vTextureCoord;

  float ab = uShake * 0.004;
  float cr = texture2D(uSampler, vec2(uv.x + ab, uv.y)).r;
  float cg = texture2D(uSampler, uv).g;
  float cb = texture2D(uSampler, vec2(uv.x - ab, uv.y)).b;
  float ca = texture2D(uSampler, uv).a;
  vec4 col = vec4(cr, cg, cb, ca);

  col.rgb = col.rgb * 0.92 + 0.02;
  col.r *= 0.88;
  col.b *= 1.07;

  float n = fract(sin(dot(uv + fract(uTime * 0.05), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  col.rgb += n * 0.04;

  float dx = uv.x - 0.5;
  float dy = uv.y - 0.5;
  float vig = clamp(1.0 - (dx * dx * 2.6 + dy * dy * 3.0), 0.0, 1.0);
  col.rgb *= mix(0.28, 1.0, vig);

  col.r += uLowHp * (1.0 - vig) * (0.6 + 0.4 * sin(uTime * 5.0)) * 0.55;

  gl_FragColor = vec4(clamp(col.rgb, 0.0, 1.0), ca);
}`;
const _moodFilter = new PIXI.Filter(null, _moodFrag, { uTime: 0, uShake: 0, uLowHp: 0 });
_stage.filters = [_moodFilter];
_vignSpr.visible = false; // vignette now handled by _moodFilter

let _staticDirty = true;
function invalidateStaticGfx() { 
  _staticDirty = true; 
  _objectsPixiInit = false; 
  if (_objectsCont) { _objectsCont.cacheAsBitmap = false; _objectsCont.removeChildren(); }
}

// ── GPU ENTITY SPRITE SYSTEM ──────────────────────────────────
// Maps sheet.name → PIXI.BaseTexture (one per loaded sheet)
const _pixiBaseTex  = new Map();
// Maps "name:col:row" → PIXI.Texture (one per unique animation frame)
const _pixiFrameTex = new Map();
// One PIXI.Sprite per entity (keyed by "p_{id}" or "m_{id}")
const _entitySprites = new Map();
const _entityActive  = new Set(); // which keys were drawn this frame

// Lazily get the Pixi BaseTexture for a sheet.
// sheet.img must be ImageBitmap (PNG sheets) or null (OffscreenCanvas not yet converted).
function _getPixiBase(sheet) {
  if (!sheet || !sheet.img || !sheet.name) return null;
  if (_pixiBaseTex.has(sheet.name)) return _pixiBaseTex.get(sheet.name);
  // OffscreenCanvas is not accepted by Pixi v7 — needs to be converted first by prewarmPixiTextures
  if (typeof OffscreenCanvas !== 'undefined' && sheet.img instanceof OffscreenCanvas) return null;
  try {
    const base = new PIXI.BaseTexture(sheet.img);
    _pixiBaseTex.set(sheet.name, base);
    return base;
  } catch { return null; }
}

// Get (or create) the sub-texture for one animation frame.
// Clamps col/row to what actually fits in the texture — prevents errors when a
// user-uploaded sheet has fewer rows than the direction system expects.
function _getPixiFrame(sheet, col, row) {
  const base = _getPixiBase(sheet);
  if (!base) return null;
  // Clamp to real texture dimensions (available synchronously for ImageBitmap)
  const texW = base.realWidth  || (sheet.frameW * (sheet.cols || 1));
  const texH = base.realHeight || (sheet.frameH * (sheet.rows || 1));
  const maxCol = Math.max(0, Math.floor(texW / sheet.frameW) - 1);
  const maxRow = Math.max(0, Math.floor(texH / sheet.frameH) - 1);
  const sc = Math.min(col, maxCol);
  const sr = Math.min(row, maxRow);
  const key = sheet.name + ':' + sc + ':' + sr;
  if (_pixiFrameTex.has(key)) return _pixiFrameTex.get(key);
  try {
    const tex = new PIXI.Texture(
      base,
      new PIXI.Rectangle(sc * sheet.frameW, sr * sheet.frameH, sheet.frameW, sheet.frameH)
    );
    _pixiFrameTex.set(key, tex);
    return tex;
  } catch { return null; }
}

// Get or create a pooled sprite for this entity key.
function _getEntitySprite(key) {
  if (_entitySprites.has(key)) return _entitySprites.get(key);
  const spr = new PIXI.Sprite(PIXI.Texture.EMPTY);
  spr.anchor.set(0.5, 0.5);
  _entityCont.addChild(spr);
  _entitySprites.set(key, spr);
  return spr;
}

// Draw an entity as a Pixi GPU sprite. Returns true if drawn, false if no texture ready.
function _drawEntitySpritePixi(key, assignKey, worldX, worldY, size, state, angle, alpha) {
  const result = typeof getEntitySheet === 'function' ? getEntitySheet(assignKey, state) : null;
  if (!result) return false;
  const { sheet, assign } = result;
  const base = _getPixiBase(sheet);
  if (!base) return false;
  let dirOffset = 0;
  if (angle !== undefined) {
    if (assign.dirMode === '4way' && typeof angleTo4Dir === 'function') dirOffset = angleTo4Dir(angle);
    else if (assign.dirMode === '8way' && typeof angleTo8Dir === 'function') dirOffset = angleTo8Dir(angle);
  }
  const { col, row } = typeof getEntityAnimFrameRC === 'function'
    ? getEntityAnimFrameRC(assign, state, dirOffset, sheet.cols)
    : { col: 0, row: 0 };
  const tex = _getPixiFrame(sheet, col, row);
  if (!tex) return false;
  const spr = _getEntitySprite(key);
  if (spr.texture !== tex) spr.texture = tex;
  spr.position.set(worldX, worldY);
  spr.width  = size;
  spr.height = size;
  spr.alpha  = (alpha !== undefined) ? alpha : 1;
  spr.visible = true;
  _entityActive.add(key);
  return true;
}

// Call once after all sprite sheets are loaded — uploads every sheet to the GPU
// and converts OffscreenCanvas sheets to ImageBitmap (required by Pixi v7).
async function prewarmPixiTextures() {
  if (typeof SPRITE_SHEETS === 'undefined') return;
  const jobs = [];
  for (const key in SPRITE_SHEETS) {
    const sheet = SPRITE_SHEETS[key];
    if (!sheet.loaded || !sheet.img || !sheet.name) continue;
    if (_pixiBaseTex.has(sheet.name)) continue;
    // OffscreenCanvas must be converted to ImageBitmap first
    if (typeof OffscreenCanvas !== 'undefined' && sheet.img instanceof OffscreenCanvas) {
      jobs.push(
        createImageBitmap(sheet.img)
          .then(bmp => { sheet.img = bmp; })
          .catch(() => {})
      );
    }
  }
  if (jobs.length) await Promise.all(jobs);
  // Now register all sheets as Pixi textures
  for (const key in SPRITE_SHEETS) {
    const sheet = SPRITE_SHEETS[key];
    if (!sheet.loaded || !sheet.img || !sheet.name) continue;
    if (_pixiBaseTex.has(sheet.name)) continue;
    if (typeof OffscreenCanvas !== 'undefined' && sheet.img instanceof OffscreenCanvas) continue;
    try {
      const base = new PIXI.BaseTexture(sheet.img);
      _pixiBaseTex.set(sheet.name, base);
    } catch {}
  }
  console.log('[PIXI] Warmed', _pixiBaseTex.size, 'entity sheet textures on GPU');
  // Init BitmapFont atlases after web fonts are loaded — guaranteed correct glyph rendering
  if (typeof document !== 'undefined' && document.fonts) await document.fonts.ready;
  _initBitmapFonts();
}

// ── COLOR CACHE ───────────────────────────────────────────────
// _c() is called in particle/bullet loops every frame — memoize it
const _cCache = new Map();
const _cOrig = _c;
// Redefine after initial declaration (hoisted above, so we shadow here)
function _cCached(css, fa) {
  if (fa !== undefined && fa !== 1) return _cOrig(css, fa); // non-default alpha: don't cache
  if (_cCache.has(css)) return _cCache.get(css);
  if (_cCache.size >= 64) _cCache.delete(_cCache.keys().next().value); // evict oldest
  const r = _cOrig(css, 1);
  _cCache.set(css, r);
  return r;
}

// ── PHASE 2: PARTICLECONTAINER POOLS ─────────────────────────
// One white-circle texture (radius 8 and 4) shared by all sprite pools.
// pixiApp.renderer.generateTexture works immediately after PIXI.Application().
const _circleTex8 = (() => { const g2=new PIXI.Graphics(); g2.beginFill(0xffffff,1); g2.drawCircle(0,0,8); g2.endFill(); return pixiApp.renderer.generateTexture(g2); })();
const _circleTex4 = (() => { const g2=new PIXI.Graphics(); g2.beginFill(0xffffff,1); g2.drawCircle(0,0,4); g2.endFill(); return pixiApp.renderer.generateTexture(g2); })();

// Phase 2.4 — HP bars as PIXI.Sprite (replaces g.beginFill/drawRect per entity per frame)
// A 1×1 white texture scaled to bar dimensions — no geometry rebuild, just transform update.
const _px1Tex = (() => { const g2=new PIXI.Graphics(); g2.beginFill(0xffffff,1); g2.drawRect(0,0,1,1); g2.endFill(); return pixiApp.renderer.generateTexture(g2); })();
// ParticleContainer for HP bars — all bars batched into one draw call
const _hpBarCont = new PIXI.ParticleContainer(170, {position:true, scale:true, tint:true, alpha:true});
const _HP_SLOTS = 80; // raised for 10-player loads
const _hpBg   = []; // gray background bars
const _hpFill = []; // colored fill bars
for(let _ii=0;_ii<_HP_SLOTS;_ii++){
  const bg=new PIXI.Sprite(_px1Tex); bg.tint=0x000000; bg.alpha=0.7; bg.visible=false; _hpBarCont.addChild(bg); _hpBg.push(bg);
  const fl=new PIXI.Sprite(_px1Tex); fl.visible=false; _hpBarCont.addChild(fl); _hpFill.push(fl);
}

// Phase 3.2 — Persistent PIXI.Text per player for names (avoid Canvas 2D fillText each frame)
const _nameCont   = new PIXI.Container();
const _nameMap    = new Map(); // playerId → PIXI.Text
const _nameStyle  = { fontFamily:'Share Tech Mono,monospace', fontWeight:'bold', fontSize:10, resolution:1 };

// Particles (MAX_PARTICLES = 600 + 20 headroom for 5v5)
const _particleCont = new PIXI.ParticleContainer(700,{position:true,alpha:true,scale:true,tint:true});
const _particlePool = [];
for(let _ii=0;_ii<700;_ii++){const s=new PIXI.Sprite(_circleTex8);s.anchor.set(0.5);s.visible=false;_particleCont.addChild(s);_particlePool.push(s);}

// Bullet trails (MAX_BULLET_TRAILS = 80 + 10 headroom)
const _trailCont = new PIXI.ParticleContainer(90,{position:true,alpha:true,scale:true,tint:true});
const _trailPool = [];
for(let _ii=0;_ii<90;_ii++){const s=new PIXI.Sprite(_circleTex8);s.anchor.set(0.5);s.visible=false;_trailCont.addChild(s);_trailPool.push(s);}

// Bullets + mob bullets — raised for 5v5 teamfights
const _bulletCont = new PIXI.ParticleContainer(500,{position:true,alpha:true,scale:true,tint:true});
const _bulletPool = [];
for(let _ii=0;_ii<500;_ii++){const s=new PIXI.Sprite(_circleTex4);s.anchor.set(0.5);s.visible=false;_bulletCont.addChild(s);_bulletPool.push(s);}

// Phase 3.3 — Damage numbers / gold floats via PIXI.BitmapText
// Pools are populated in _initBitmapFonts() which runs inside prewarmPixiTextures()
// after document.fonts.ready — guarantees correct glyph rendering.
const _dmgTextCont  = new PIXI.Container();
const _dmgTextPool  = []; // 80 STM16 BitmapText  (regular damage numbers)
const _critTextPool = []; // 20 ORB22 BitmapText  (crit / kill messages)
const _goldTextCont = new PIXI.Container();
const _goldTextPool = []; // 50 ORB14 BitmapText  (gold floats)

// CSS color string → integer hex (memoized)
const _colorHexCache = new Map();
function _colorToHex(css){
  if(!css) return 0xffffff;
  if(_colorHexCache.has(css)) return _colorHexCache.get(css);
  const n = parseInt((css[0]==='#'?css.slice(1):css),16)||0xffffff;
  _colorHexCache.set(css,n); return n;
}

let _bitmapFontsReady = false;
function _initBitmapFonts(){
  if(_bitmapFontsReady) return;
  _bitmapFontsReady = true;
  const BF_CHARS = '!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~ ☠★+×';
  const STM = {fontFamily:'Share Tech Mono,monospace',fontWeight:'bold',fill:0xffffff};
  const ORB = {fontFamily:'Orbitron,monospace',fontWeight:'bold',fill:0xffffff};
  [10,16,22].forEach(sz=>PIXI.BitmapFont.from('STM'+sz,{...STM,fontSize:sz},{chars:BF_CHARS,resolution:2}));
  [14,22].forEach(sz=>PIXI.BitmapFont.from('ORB'+sz,{...ORB,fontSize:sz},{chars:BF_CHARS,resolution:2}));
  for(let _ii=0;_ii<80;_ii++){
    const t=new PIXI.BitmapText('',{fontName:'STM16',fontSize:16});t.tint=0xff3355;
    t.anchor.set(0.5);t.visible=false;_dmgTextCont.addChild(t);_dmgTextPool.push(t);
  }
  for(let _ii=0;_ii<20;_ii++){
    const t=new PIXI.BitmapText('',{fontName:'ORB22',fontSize:22});t.tint=0xff3355;
    t.anchor.set(0.5);t.visible=false;_dmgTextCont.addChild(t);_critTextPool.push(t);
  }
  for(let _ii=0;_ii<50;_ii++){
    const t=new PIXI.BitmapText('',{fontName:'ORB14',fontSize:14});t.tint=0xffcc00;
    t.anchor.set(0.5);t.visible=false;_goldTextCont.addChild(t);_goldTextPool.push(t);
  }
}

// ── PHASE B: Separate-layer Graphics (avoid _wGfx.clear() rebuild for static elements) ──

// Grid — only redrawn when camera crosses an 80px cell boundary (~2× per sec at normal speed)
const _gridGfx = new PIXI.Graphics();
let _gridCamX = -1e9, _gridCamY = -1e9;

// Arena rings — drawn once, alpha updated per frame
// Hard-code map center (W=9600, H=5400) — renderer-pixi.js loads BEFORE engine.js defines W/H
const _MAP_CX = 4800, _MAP_CY = 2700;
const _arenaGfx1 = new PIXI.Graphics();
_arenaGfx1.lineStyle(2, 0x00f5ff, 1); _arenaGfx1.drawCircle(_MAP_CX, _MAP_CY, 90);
const _arenaGfx2 = new PIXI.Graphics();
_arenaGfx2.lineStyle(1.5, 0xff00aa, 1); _arenaGfx2.drawCircle(_MAP_CX, _MAP_CY, 125);

// Shop zone outlines — redrawn only when shop zone changes
const _shopOutlineGfx = new PIXI.Graphics();
let _shopDirty = true;
// Shop zone fills — sprite per zone, alpha updated per frame
const _shopFillSprites = [];
for(let _ii=0;_ii<3;_ii++){
  const s=new PIXI.Sprite(_px1Tex); s.tint=0xffaa00; s.visible=false;
  _shopFillSprites.push(s);
}

// Orbs — sprite pool, Phase 2.6 (replaces g.drawCircle per orb per frame)
const _orbTex = (() => { const g2=new PIXI.Graphics(); g2.beginFill(0xffffff,1); g2.drawCircle(0,0,16); g2.endFill(); return pixiApp.renderer.generateTexture(g2); })();
const _orbCont = new PIXI.Container();
const _MAX_ORBS = 20;
const _orbOuter = [], _orbInner = [];
for(let _ii=0;_ii<_MAX_ORBS;_ii++){
  const o1=new PIXI.Sprite(_orbTex); o1.anchor.set(0.5); o1.tint=0xffaa00; o1.visible=false; _orbCont.addChild(o1); _orbOuter.push(o1);
  const o2=new PIXI.Sprite(_orbTex); o2.anchor.set(0.5); o2.tint=0xff9900; o2.visible=false; _orbCont.addChild(o2); _orbInner.push(o2);
}

// Dash trails — rotated rectangle sprites, Phase 2.5 (replaces g.lineStyle/moveTo/lineTo)
const _dashLineTex = (() => { const g2=new PIXI.Graphics(); g2.beginFill(0xffffff,1); g2.drawRect(0,-0.5,1,1); g2.endFill(); return pixiApp.renderer.generateTexture(g2); })();
const _dashLineCont = new PIXI.Container();
const _MAX_DASH = 60; // raised for 10-player loads
const _dashLinePool = [];
for(let _ii=0;_ii<_MAX_DASH;_ii++){
  const s=new PIXI.Sprite(_dashLineTex); s.anchor.set(0, 0.5); s.visible=false;
  _dashLineCont.addChild(s); _dashLinePool.push(s);
}

// High-water-marks for pool hide loops — only hide slots used in the PREVIOUS frame
let _particleHWM=0, _trailHWM=0, _bulletHWM=0, _orbHWM=0, _dashHWM=0, _hpHWM=0;

// Cached Graphics for rarely-changing world elements
const _towerRangeGfx  = new PIXI.Graphics(); // tower range circles + bodies
const _campAliveGfx   = new PIXI.Graphics(); // alive camp zone circles
let _towerCacheKey    = '';  // rebuilt when tower count/HP changes
let _campAliveCacheKey= '';  // rebuilt when camp alive/dead state changes

// All Phase 2/3/B containers are now declared — safe to add to scene graph
worldCont.addChild(
  _gridGfx,                                // grid below everything
  _arenaGfx1, _arenaGfx2,                 // arena rings
  _shopOutlineGfx, ..._shopFillSprites,   // shop zones
  _towerRangeGfx, _campAliveGfx,          // cached world structure
  _orbCont,                                // orbs (Phase 2.6)
  _dashLineCont,                           // dash trails (Phase 2.5)
  _hpBarCont,                              // Phase 2.4 — HP bars
  _particleCont, _trailCont, _bulletCont, // Phase 2   — particles/bullets/trails
  _nameCont,                               // Phase 3.2 — player names
  _dmgTextCont, _goldTextCont             // Phase 3.3 — floating numbers on top
);

function _rebuildStaticGfx(gs) {
  _staticDirty = false;
  _staticGfx.cacheAsBitmap = false; // must clear before modifying geometry
  const sg = _staticGfx;
  sg.clear();

  // Lane markers
  sg.lineStyle(2, 0x00c8ff, 0.04);
  sg.moveTo(0, H/2); sg.lineTo(W, H/2);
  sg.moveTo(W/2, 0); sg.lineTo(W/2, H);

  // World border
  sg.lineStyle(2, 0x00f5ff, 0.18); sg.drawRect(2, 2, W-4, H-4);
  sg.lineStyle(1, 0x00f5ff, 0.06); sg.drawRect(10, 10, W-20, H-20);
  const cL = 80;
  sg.lineStyle(2.5, 0x00f5ff, 0.4);
  [[0,0,1,1],[W,0,-1,1],[0,H,1,-1],[W,H,-1,-1]].forEach(([bx,by,dx,dy])=>{
    sg.moveTo(bx, by+dy*cL); sg.lineTo(bx, by); sg.lineTo(bx+dx*cL, by);
  });

  // Team energy fields (static once per match)
  if (gs.teamMode) {
    sg.lineStyle(0); sg.beginFill(0x4488ff, 0.03); sg.drawRect(0, 0, W/2, H); sg.endFill();
    sg.beginFill(0xff4444, 0.03); sg.drawRect(W/2, 0, W/2, H); sg.endFill();
    sg.lineStyle(1, 0xffffff, 0.05); sg.moveTo(W/2, 0); sg.lineTo(W/2, H);
  }

  // Walls (static during match)
  for (const w of gs.walls) {
    sg.lineStyle(0); sg.beginFill(0x002d6e, 0.48); sg.drawRect(w.x, w.y, w.w, w.h); sg.endFill();
    sg.lineStyle(1.5, 0x00a0ff, 0.6); sg.drawRect(w.x, w.y, w.w, w.h);
    const cl = 8;
    sg.lineStyle(2, 0x00f5ff, 0.5);
    [[w.x,w.y,1,1],[w.x+w.w,w.y,-1,1],[w.x,w.y+w.h,1,-1],[w.x+w.w,w.y+w.h,-1,-1]].forEach(([cx2,cy2,dx2,dy2])=>{
      sg.moveTo(cx2, cy2+dy2*cl); sg.lineTo(cx2, cy2); sg.lineTo(cx2+dx2*cl, cy2);
    });
  }
  // Bake to a single GPU texture — walls never change during a match so we pay
  // the rasterisation cost once here instead of every rendered frame.
  _staticGfx.cacheAsBitmap = true;
}

// ── COLOR HELPER ──────────────────────────────────────────────
// Returns [pixiHex, alpha] from any CSS colour string.
function _c(css, fa) {
  fa = (fa === undefined) ? 1 : fa;
  if (!css) return [0xffffff, fa];
  const s = css.trim();
  if (s[0] === '#') {
    const h = s.slice(1);
    if (h.length === 8) return [parseInt(h.slice(0, 6), 16), parseInt(h.slice(6), 16) / 255];
    if (h.length === 6) return [parseInt(h, 16), fa];
    if (h.length === 3) {
      const r = parseInt(h[0]+h[0],16), g = parseInt(h[1]+h[1],16), b = parseInt(h[2]+h[2],16);
      return [(r<<16)|(g<<8)|b, fa];
    }
  }
  const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (m) return [(parseInt(m[1])<<16)|(parseInt(m[2])<<8)|parseInt(m[3]),
                 m[4] !== undefined ? parseFloat(m[4]) : fa];
  return [0xffffff, fa];
}

// ── CAMERA ────────────────────────────────────────────────────
// Prefixed _r_ to avoid redeclaration conflict with network.js globals
let _rSmCamX = 0, _rSmCamY = 0, _rCamInit = false;

function updateCamera(gs) {
  const p = gs.players.find(pp => pp.isHuman) || gs.players[0];
  const tx = Math.max(0, Math.min(W - VW/CAM_ZOOM, p.x - VW/(2*CAM_ZOOM)));
  const ty = Math.max(0, Math.min(H - VH/CAM_ZOOM, p.y - VH/(2*CAM_ZOOM)));
  camX += (tx - camX) * 0.22;
  camY += (ty - camY) * 0.22;
}
function updateCameraSmooth(gs) {
  const p = getLocalPlayer(gs);
  if (!p) { updateCamera(gs); return; }
  const tx = Math.max(0, Math.min(W - VW/CAM_ZOOM, p.x - VW/(2*CAM_ZOOM)));
  const ty = Math.max(0, Math.min(H - VH/CAM_ZOOM, p.y - VH/(2*CAM_ZOOM)));
  if (!_rCamInit) { _rSmCamX = tx; _rSmCamY = ty; _rCamInit = true; }
  _rSmCamX += (tx - _rSmCamX) * 0.22;
  _rSmCamY += (ty - _rSmCamY) * 0.22;
  camX = _rSmCamX; camY = _rSmCamY;
}

// ── RESIZE ────────────────────────────────────────────────────
// var (not let) — hoisted to null before any code runs, so onResizeRenderer() never sees TDZ
// even if renderer-pixi.js aborted before reaching this line in a previous error
var _bgTex = null, _vigTex = null;
function onResizeRenderer(w, h) {
  pixiApp.renderer.resize(w, h);
  _overlayCanvas.width = w; _overlayCanvas.height = h;
  _bgTex = null; _vigTex = null;          // rebuild on next frame
  _bgSpr.texture  = PIXI.Texture.EMPTY;
  _vignSpr.texture = PIXI.Texture.EMPTY;
}

// ── BACKGROUND & VIGNETTE ────────────────────────────────────
function _ensureBg() {
  if (_bgTex) return;
  const c = document.createElement('canvas');
  c.width = VW; c.height = VH;
  const cx = c.getContext('2d');
  const g = cx.createRadialGradient(VW/2,VH/2,0, VW/2,VH/2,VW*0.8);
  g.addColorStop(0,'#080c18'); g.addColorStop(0.5,'#050810'); g.addColorStop(1,'#020408');
  cx.fillStyle = g; cx.fillRect(0,0,VW,VH);
  _bgTex = PIXI.Texture.from(c);
  _bgSpr.texture = _bgTex; _bgSpr.width = VW; _bgSpr.height = VH;
}
function _ensureVig() {
  if (_vigTex) return;
  const c = document.createElement('canvas');
  c.width = VW; c.height = VH;
  const cx = c.getContext('2d');
  const g = cx.createRadialGradient(VW/2,VH/2,VW*0.3, VW/2,VH/2,VW*0.75);
  g.addColorStop(0,'rgba(0,0,0,0)');
  g.addColorStop(0.7,'rgba(0,0,0,0.15)');
  g.addColorStop(1,'rgba(0,0,0,0.55)');
  cx.fillStyle = g; cx.fillRect(0,0,VW,VH);
  _vigTex = PIXI.Texture.from(c);
  _vignSpr.texture = _vigTex; _vignSpr.width = VW; _vignSpr.height = VH;
  _vignSpr.zIndex = 999;
}
// Legacy compat for anything that might call these
function getBackgroundCache() { return null; }
function getVignetteCache()   { return null; }

// ── TILE-LAYER SPRITES ────────────────────────────────────────
const _tileSprMap = new Map(); // layer → { sprite, gen, helperCanvas }
let _activeLayersRef = null;   // cached reference — rebuilt only when gameTileLayers changes
let _activeLayerSet  = new Set();

function _syncTiles(ZW, ZH) {
  if (typeof gameTileLayers === 'undefined' || !gameTileLayers.length) {
    for (const ts of _tileSprMap.values()) ts.sprite.visible = false;
    return;
  }

  // Push live camera coords to sprites.js without drawing to overlay
  if (typeof _tlLiveCamX !== 'undefined') {
    _tlLiveCamX = camX; _tlLiveCamY = camY;
    _tlLiveViewW = ZW;  _tlLiveViewH = ZH;
  }

  // Hide sprites whose layer is no longer active — rebuild set only when array ref changes
  if (_activeLayersRef !== gameTileLayers) {
    _activeLayerSet.clear();
    for (const l of gameTileLayers) _activeLayerSet.add(l);
    _activeLayersRef = gameTileLayers;
  }
  for (const [layer, ts] of _tileSprMap.entries()) {
    if (!_activeLayerSet.has(layer)) ts.sprite.visible = false;
  }

  const safe = (typeof _TL_MARGIN !== 'undefined' ? _TL_MARGIN : 600) * 0.5;

  for (const layer of gameTileLayers) {
    if (!layer.visible || layer.animated) continue;
    if (typeof _tlCaches === 'undefined') continue;
    const e = _tlCaches.get(layer);

    // Trigger rebuild when cache is missing or camera near edge
    if (typeof _scheduleBuild === 'function') {
      const inBounds = e && e.gen === _tlGen &&
        camX >= e.originX + safe && camX + ZW <= e.originX + e.cW - safe &&
        camY >= e.originY + safe && camY + ZH <= e.originY + e.cH - safe;
      if (!inBounds) _scheduleBuild(layer);
    }

    let ts = _tileSprMap.get(layer);
    if (!ts) {
      const spr = new PIXI.Sprite();
      _tilesCont.addChild(spr);
      ts = { sprite: spr, lastCache: null, helperCanvas: null, tex: null };
      _tileSprMap.set(layer, ts);
    }

    if (!e || !e.canvas) {
      // Cache rebuilding — keep last texture visible rather than going blank
      ts.sprite.visible = !!ts.tex;
      continue;
    }

    // Use object identity: any new cache entry (same gen OR new gen) triggers upload.
    if (ts.lastCache !== e) {
      const sizeChanged = !ts.helperCanvas || ts.helperCanvas.width !== e.cW || ts.helperCanvas.height !== e.cH;
      if (sizeChanged) {
        ts.helperCanvas = document.createElement('canvas');
        ts.helperCanvas.width = e.cW; ts.helperCanvas.height = e.cH;
      }
      const h2 = ts.helperCanvas.getContext('2d');
      h2.clearRect(0, 0, e.cW, e.cH);
      h2.drawImage(e.canvas, 0, 0);
      if (!ts.tex || sizeChanged) {
        if (ts.tex) ts.tex.destroy(true);
        ts.tex = PIXI.Texture.from(ts.helperCanvas);
        ts.sprite.texture = ts.tex;
      } else {
        ts.tex.baseTexture.update();
      }
      ts.lastCache = e;
    }
    ts.sprite.position.set(e.originX, e.originY);
    ts.sprite.visible = true;
  }
}

// ── BULLET TRAILS (object pool — zero allocation after warm-up) ──
const MAX_BULLET_TRAILS = 80;
const bulletTrails = [];
// Pre-fill pool slots at startup
for (let _i = 0; _i < MAX_BULLET_TRAILS; _i++) bulletTrails.push({ x:0, y:0, life:0, ml:0.3, color:'#ff3355', sz:1 });

function _btAdd(x, y, color, ml, sz) {
  for (let i = 0; i < bulletTrails.length; i++) {
    if (bulletTrails[i].life <= 0) {
      const t = bulletTrails[i];
      t.x = x; t.y = y; t.life = 1; t.ml = ml; t.color = color; t.sz = sz;
      return;
    }
  }
  // Pool full — silently drop (rare, no allocation)
}

function updateBulletTrails(gs, dt) {
  for (const b of gs.bullets) {
    if (b.life <= 0) continue;
    if (Math.random() < 0.15) _btAdd(b.x, b.y, b.color||'#ff3355', 0.3, b.r*0.6+Math.random()*1.5);
  }
  if (gs.mobBullets) {
    for (const mb of gs.mobBullets) {
      if (Math.random() < 0.10) _btAdd(mb.x, mb.y, mb.color||'#bb77ff', 0.25, mb.r*0.4+Math.random()*1);
    }
  }
  // Decay in place — no splice, no shift, dead slots recycled by _btAdd
  for (let i = 0; i < bulletTrails.length; i++) {
    if (bulletTrails[i].life <= 0) continue;
    bulletTrails[i].life -= dt / bulletTrails[i].ml;
    if (bulletTrails[i].life < 0) bulletTrails[i].life = 0;
  }
}

// ── SHAPE CACHES ──────────────────────────────────────────────
const _mobBodyCache = {};
function _getMobBody(mob) {
  const key = mob.type+'|'+mob.color+'|'+mob.radius;
  if (_mobBodyCache[key]) return _mobBodyCache[key];
  const r = mob.radius, d = Math.ceil(r*2.6), cx = d/2;
  const off = new OffscreenCanvas(d, d), c = off.getContext('2d');
  c.fillStyle = mob.color; c.beginPath(); c.arc(cx,cx,r,0,Math.PI*2); c.fill();
  c.strokeStyle = '#fff4'; c.lineWidth = 1.2; c.beginPath(); c.arc(cx,cx,r,0,Math.PI*2); c.stroke();
  if (mob.icon && mob.icon !== '●') {
    c.font = Math.ceil(r*0.9)+'px sans-serif'; c.textAlign='center'; c.textBaseline='middle';
    c.fillStyle='#fff'; c.fillText(mob.icon, cx, cx);
  }
  return (_mobBodyCache[key] = { off, d, cx });
}

const _clsCache = {};
function _getClsCircle(cls, color, radius) {
  const key = cls+color+radius;
  if (_clsCache[key]) return _clsCache[key];
  const d = Math.ceil(radius*2.6), cx = d/2;
  const off = new OffscreenCanvas(d, d), oc = off.getContext('2d');
  const gr = oc.createRadialGradient(cx,cx,0, cx,cx,radius);
  gr.addColorStop(0,'#fff'); gr.addColorStop(0.45,color); gr.addColorStop(1,color+'66');
  oc.fillStyle = gr; oc.beginPath(); oc.arc(cx,cx,radius,0,Math.PI*2); oc.fill();
  oc.strokeStyle='#fff5'; oc.lineWidth=1.5; oc.beginPath(); oc.arc(cx,cx,radius,0,Math.PI*2); oc.stroke();
  return (_clsCache[key] = { off, d });
}

let _mmWallCanvas = null, _mmWallKey = -1;
function _getMinimapWallCache(walls, mmW, mmH) {
  if (_mmWallCanvas && _mmWallKey === walls.length) return _mmWallCanvas;
  _mmWallCanvas = new OffscreenCanvas(mmW, mmH);
  const mc = _mmWallCanvas.getContext('2d');
  mc.fillStyle = 'rgba(0,100,200,.5)';
  for (const w of walls)
    mc.fillRect(w.x/W*mmW, w.y/H*mmH, Math.max(1,w.w/W*mmW), Math.max(1,w.h/H*mmH));
  _mmWallKey = walls.length;
  return _mmWallCanvas;
}

function getPlayerAnimState(p) {
  if (!p.alive) return 'dead';
  if (p.swordOn||p.novaOn||p.overchargeTimer>0||p.drainTimer>0||p.fortifyTimer>0||p.hookOn) return 'special';
  if (Math.abs(p.vx)>20||Math.abs(p.vy)>20) return 'walk';
  return 'idle';
}

// ── GPU TERRAIN, BLOOD, OBJECTS, EMOJIS (Phase 4 Migration) ────
let _terrainPixiInit = false;
const _grassSprites = [];
const _waterSprites = [];

function _syncTerrainPixi(camX, camY, ZW, ZH) {
  if (typeof terrainPatches === 'undefined' || !terrainPatches) {
    if (typeof initTerrainPatches === 'function') initTerrainPatches();
    if (typeof terrainPatches === 'undefined' || !terrainPatches) return;
  }
  if (!_terrainPixiInit && SPRITE_SHEETS.grassTiles && SPRITE_SHEETS.grassTiles.loaded) {
    _terrainPixiInit = true;
    for (const p of terrainPatches) {
      const tex = _getPixiFrame(SPRITE_SHEETS.grassTiles, p.col, p.row);
      if (!tex) continue;
      const spr = new PIXI.Sprite(tex);
      spr.position.set(p.x, p.y);
      spr.width = p.size; spr.height = p.size;
      spr.alpha = p.alpha;
      spr.baseX = p.x;
      _terrainCont.addChild(spr);
      _grassSprites.push(spr);
    }
    for (const w of waterZones) {
      const tex = _getPixiFrame(SPRITE_SHEETS.waterAnim, 0, 0);
      if (!tex) continue;
      const spr = new PIXI.Sprite(tex);
      spr.position.set(w.x, w.y);
      spr.width = w.size; spr.height = w.size;
      spr.alpha = w.alpha;
      _terrainCont.addChild(spr);
      _waterSprites.push(spr);
    }
  }
  if (!_terrainPixiInit) return;
  
  const now = performance.now();
  for (const spr of _grassSprites) {
    if (spr.baseX + spr.width < camX || spr.baseX > camX + ZW ||
        spr.y + spr.height < camY || spr.y > camY + ZH) { spr.visible = false; continue; }
    spr.visible = true;
    spr.x = spr.baseX + Math.sin(now * 0.0006 + spr.baseX * 0.008) * 1.5;
  }
  
  if (SPRITE_SHEETS.waterAnim && SPRITE_SHEETS.waterAnim.loaded) {
    const s = SPRITE_SHEETS.waterAnim;
    const tf = s.cols * s.rows;
    const fi = Math.floor(now / 220) % tf;
    const col = fi % s.cols;
    const row = Math.floor(fi / s.cols);
    const wTex = _getPixiFrame(s, col, row);
    for (const spr of _waterSprites) {
      if (spr.x + spr.width < camX || spr.x > camX + ZW ||
          spr.y + spr.height < camY || spr.y > camY + ZH) { spr.visible = false; continue; }
      spr.visible = true;
      if (wTex && spr.texture !== wTex) spr.texture = wTex;
    }
  }
}

const _bloodPool = [];
let _bloodHWM = 0;
for(let i=0; i<100; i++) {
  const s = new PIXI.Sprite(PIXI.Texture.EMPTY);
  s.anchor.set(0.5); s.visible = false;
  _bloodCont.addChild(s); _bloodPool.push(s);
}

function _syncBloodPixi(camX, camY, ZW, ZH) {
  if (typeof bloodSplatters === 'undefined') return;
  let bi = 0;
  for (const b of bloodSplatters) {
    if (b.life <= 0) continue;
    if (b.x + b.size < camX || b.x > camX + ZW || b.y + b.size < camY || b.y > camY + ZH) continue;
    if (bi >= _bloodPool.length) break;
    const spr = _bloodPool[bi++];
    const tex = _getPixiFrame(SPRITE_SHEETS[b.sheetKey], b.col, b.row);
    if (tex && spr.texture !== tex) spr.texture = tex;
    spr.position.set(b.x + b.size/2, b.y + b.size/2);
    spr.rotation = b.rotation;
    spr.width = b.size; spr.height = b.size;
    spr.alpha = b.life * b.alpha;
    spr.visible = true;
  }
  for (let j = bi; j < _bloodHWM; j++) _bloodPool[j].visible = false;
  _bloodHWM = bi;
}

let _objectsPixiInit = false;
function _syncObjectsPixi() {
  if (_objectsPixiInit || typeof gameObjectLayers === 'undefined' || !gameObjectLayers || !gameObjectLayers.length) return;
  _objectsPixiInit = true;
  for (const layer of gameObjectLayers) {
    if (!layer.visible) continue;
    const opacity = layer.opacity !== undefined ? layer.opacity : 1;
    if (opacity <= 0) continue;
    for (const obj of layer.objects || []) {
      const sheet = SPRITE_SHEETS['map_' + obj.sheetName];
      if (!sheet || !sheet.loaded) {
        _objectsPixiInit = false; 
        continue; 
      }
      let col = 0, row = 0;
      if (obj.regionId && sheet.regions) {
        const r = sheet.regions.find(rg => rg.id === obj.regionId);
        if (r) { col = Math.floor(r.x/sheet.frameW); row = Math.floor(r.y/sheet.frameH); }
      } else if (obj.col !== undefined && obj.row !== undefined) {
        col = obj.col; row = obj.row;
      }
      const tex = _getPixiFrame(sheet, col, row);
      if (tex) {
        const spr = new PIXI.Sprite(tex);
        spr.position.set(obj.x, obj.y);
        spr.width = obj.w; spr.height = obj.h;
        spr.alpha = opacity;
        _objectsCont.addChild(spr);
      }
    }
  }
  if (_objectsPixiInit) _objectsCont.cacheAsBitmap = true; 
}

const _emojiFont = { fontFamily: 'sans-serif', fontSize: 16, fill: 0xffffff };
const _emojiCont = new PIXI.Container();
worldCont.addChild(_emojiCont); 
const _emojiPool = [];
let _emojiHWM = 0;
for(let i=0; i<60; i++) {
  const t = new PIXI.Text('', _emojiFont);
  t.anchor.set(0.5); t.visible = false;
  _emojiCont.addChild(t); _emojiPool.push(t);
}

const _labelFont = { fontFamily: 'Orbitron,monospace', fontSize: 10, fontWeight: 'bold', fill: 0xffffff };
const _labelPool = [];
let _labelHWM = 0;
for(let i=0; i<30; i++) {
  const t = new PIXI.Text('', _labelFont);
  t.anchor.set(0.5); t.visible = false;
  _emojiCont.addChild(t); _labelPool.push(t);
}

function _drawEmojiPixi(emoji, x, y, size=16, color=0xffffff) {
  if (_emojiHWM >= _emojiPool.length) return;
  const t = _emojiPool[_emojiHWM++];
  if (t.text !== emoji) t.text = emoji;
  if (t.style.fontSize !== size) t.style.fontSize = size;
  if (t.style.fill !== color) t.style.fill = color;
  t.position.set(x, y); t.visible = true;
}

function _drawLabelPixi(text, x, y, size=10, color=0xffffff) {
  if (_labelHWM >= _labelPool.length) return;
  const t = _labelPool[_labelHWM++];
  if (t.text !== text) t.text = text;
  if (t.style.fontSize !== size) t.style.fontSize = size;
  if (t.style.fill !== color) t.style.fill = color;
  t.position.set(x, y); t.visible = true;
}

// ─────────────────────────────────────────────────────────────
//  MAIN RENDER FUNCTION
// ─────────────────────────────────────────────────────────────
let renderFrame = 0, _frameTime = 0;
let _visualPulseFlip = false; // toggles each frame — throttles grid/arena alpha to ~30 Hz

function render(gs) {
  _emojiHWM = 0;
  _labelHWM = 0;
  _frameTime = performance.now();
  renderFrame++;
  const ZW = VW / CAM_ZOOM, ZH = VH / CAM_ZOOM;
  let _hpIdx = 0; // resets every frame — HP bar sprite slot counter
  const t  = _frameTime;
  const _t0 = _frameTime;

  _ensureBg(); _ensureVig();

  let shakeOffX = 0;
  let shakeOffY = 0;
  if (typeof shakeIntensity !== 'undefined' && shakeIntensity > 0) {
    shakeOffX = (Math.random() - 0.5) * shakeIntensity * 2;
    shakeOffY = (Math.random() - 0.5) * shakeIntensity * 2;
  }

  // ── Apply camera to world container ──────────────────────
  worldCont.position.set(Math.round(-(camX + shakeOffX) * CAM_ZOOM), Math.round(-(camY + shakeOffY) * CAM_ZOOM));
  worldCont.scale.set(CAM_ZOOM, CAM_ZOOM);

  // ── Sync tile sprites ─────────────────────────────────────
  _syncTiles(ZW, ZH);
  _dbgT.tiles = performance.now() - _t0;

  // ── Clear overlay — ONE save/restore covers all world space
  _overlayCtx.clearRect(0, 0, VW, VH);
  _overlayCtx.save();
  _overlayCtx.scale(CAM_ZOOM, CAM_ZOOM);
  _overlayCtx.translate(-(camX + shakeOffX), -(camY + shakeOffY));

  // Terrain
  _syncTerrainPixi(camX, camY, ZW, ZH);
  // Object layers (atlas sprites placed in editor)
  _syncObjectsPixi();
  // Animated tile layers
  if (typeof gameTileLayers !== 'undefined') {
    for (const layer of gameTileLayers) {
      if (!layer.visible || !layer.animated) continue;
      if (typeof _drawTilesDirect === 'function') _drawTilesDirect(_overlayCtx, layer, camX, camY, ZW, ZH);
    }
  }
  // Blood splatters
  _syncBloodPixi(camX, camY, ZW, ZH);

  // Shop zone icons (scroll sprite or emoji)
  const allShops = gs.shopZones || [gs.shopZone];
  for (let si = 0; si < allShops.length; si++) {
    const sz = allShops[si], szCx = sz.x+sz.w/2, szCy = sz.y+sz.h/2;
    const isMain = si === 0;
    if (typeof drawScrollItem === 'function' && !drawScrollItem(_overlayCtx, szCx, szCy, 'teleScroll', 36)) {
      _drawEmojiPixi('🏪', szCx, szCy+6, isMain ? 20 : 16, 0xffaa00);
    }
    _drawLabelPixi(isMain?'MAIN SHOP [E]':'SHOP [E]', szCx, szCy+22, 9, 0xffaa00);
  }

  // Mob bodies — GPU sprite purely
  for (const camp of gs.camps) {
    for (const mob of camp.mobs) {
      if (!mob.alive) continue;
      if (mob.x<camX-60||mob.x>camX+ZW+60||mob.y<camY-60||mob.y>camY+ZH+60) continue;
      const mobSize  = mob.radius * 2.4;
      const mobState = mob.aggroTarget
        ? ((Math.abs(mob.vx||0)>5||Math.abs(mob.vy||0)>5) ? 'walk' : 'attack') : 'idle';
      const mobAngle = mob.angle !== undefined ? mob.angle : Math.atan2(mob.vy||0, mob.vx||0);
      const mobKey   = 'm_' + (mob.id ?? (camp.x+'_'+mob.type));
      // Try GPU path
      _drawEntitySpritePixi(mobKey, 'mob_'+mob.type, mob.x, mob.y, mobSize, mobState, mobAngle);
    }
  }

  // Tower emoji label
  if (gs.towers) {
    for (const tw of gs.towers) {
      if (tw.hp <= 0) continue;
      _drawEmojiPixi('🏰', tw.x, tw.y+6, 18, 0xffffff);
      _drawLabelPixi(tw.team===1?'🔵 TOWER':'🔴 TOWER', tw.x, tw.y-tw.radius-10, 10, _colorToHex(tw.color));
    }
  }

  // Trap + grenade emojis
  if (gs.traps) {
    for (const trap of gs.traps) {
      if (!trap.armed) continue;
      _drawEmojiPixi('🪤', trap.x, trap.y+4, 12, 0xff8833);
    }
  }
  if (gs.grenades) {
    for (const gr of gs.grenades) {
      _drawEmojiPixi('💣', gr.x, gr.y+4, 10, 0xffffff);
    }
  }

  // Orb values
  for (const o of gs.orbs) {
    if (o.x<camX-30||o.x>camX+ZW+30||o.y<camY-30||o.y>camY+ZH+30) continue;
    _drawLabelPixi('+'+o.value, o.x, o.y+3, 8, 0xffffff);
  }

  // Camp respawn countdown text
  for (const camp of gs.camps) {
    if (!camp.dead) {
      _drawLabelPixi('+'+camp.gold+'g', camp.x, camp.y-50, 8, 0xffaa00);
    } else {
      const elapsed = _frameTime - camp.deathTime;
      _drawLabelPixi(Math.ceil((camp.respawnTime-elapsed)/1000)+'s', camp.x, camp.y+3, 8, 0x888888);
    }
  }

  // Minion slashes
  if (typeof minionSlashes !== 'undefined') _drawMinionSlashes(_overlayCtx, camX, camY);

  // Player bodies + class-specific shapes
  for (const p of gs.players) {
    if (!p.alive) continue;
    if (p.invuln>0 && Math.floor(p.invuln/80)%2===0) continue;
    if (!p.isHuman && (p.x<camX-80||p.x>camX+ZW+80||p.y<camY-80||p.y>camY+ZH+80)) continue;
    if ((p.smokeTimer>0||p.invisTimer>0) && !p.isHuman) continue; 
    
    // Force GPU render
    const size  = p.radius * 2.4;
    const state = getPlayerAnimState(p);
    const alpha = p.invisTimer>0&&p.isHuman ? 0.35 : 1;
    _drawEntitySpritePixi('p_'+p.id, 'class_'+p.cls, p.x, p.y, size, state, p.angle, alpha);
  }

  // Minion HP bars
  for (const p of gs.players) {
    if (!p.alive) continue;
    if (!p.isHuman && (p.x<camX-80||p.x>camX+ZW+80||p.y<camY-80||p.y>camY+ZH+80)) continue;
    if (p.cls === 'necro' && p.minions) {
      for (const m of p.minions) {
        if (!m.alive) continue;
        const mbw=16, mbh=3;
        if (_hpIdx < _HP_SLOTS) {
           _hpBg[_hpIdx].position.set(m.x-mbw/2, m.y-(m.radius||8)-6); _hpBg[_hpIdx].width=mbw; _hpBg[_hpIdx].height=mbh; _hpBg[_hpIdx].visible=true;
           const hw = mbw*(m.hp/(m.maxHp||40));
           _hpFill[_hpIdx].position.set(m.x-mbw/2, m.y-(m.radius||8)-6); _hpFill[_hpIdx].width=hw; _hpFill[_hpIdx].height=mbh;
           _hpFill[_hpIdx].tint=0x88cc44; _hpFill[_hpIdx].alpha=1; _hpFill[_hpIdx].visible=hw>0;
           _hpIdx++;
        }
      }
    }
  }

  // Ward eye emojis
  if (gs.wards) {
    for (const w of gs.wards) {
      _drawEmojiPixi('👁️', w.x, w.y+4, 12, 0x00ccff);
    }
  }

  // Damage numbers → BitmapText pools (no Canvas2D texture re-render per number)
  if (typeof dmgNumbers !== 'undefined' && _bitmapFontsReady) {
    let _dni_n=0, _dni_c=0;
    for(let _dnii=0;_dnii<dmgNumbers.length;_dnii++){
      const dn=dmgNumbers[_dnii];
      if(dn.life<=0) continue;
      const isCrit=dn.isCrit||(dn.size&&dn.size>20);
      if(isCrit){
        if(_dni_c>=_critTextPool.length) continue;
        const t=_critTextPool[_dni_c++];
        if(t.text!==dn.text) t.text=dn.text||'';
        const col=_colorToHex(dn.color||'#ff3355'); if(t.tint!==col) t.tint=col;
        t.position.set(dn.x,dn.y); t.alpha=Math.min(1,dn.life/1.4); t.visible=true;
      } else {
        if(_dni_n>=_dmgTextPool.length) continue;
        const t=_dmgTextPool[_dni_n++];
        if(t.text!==dn.text) t.text=dn.text||'';
        const col=_colorToHex(dn.color||'#ff3355'); if(t.tint!==col) t.tint=col;
        t.position.set(dn.x,dn.y); t.alpha=Math.min(1,dn.life/1.4); t.visible=true;
      }
    }
    for(let j=_dni_n;j<_dmgTextPool.length;j++) if(_dmgTextPool[j].visible) _dmgTextPool[j].visible=false;
    for(let j=_dni_c;j<_critTextPool.length;j++) if(_critTextPool[j].visible) _critTextPool[j].visible=false;
  }

  // Gold floats → BitmapText pool
  if (typeof goldFloats !== 'undefined' && _bitmapFontsReady) {
    let _gfi=0;
    for(let _gfii=0;_gfii<goldFloats.length;_gfii++){
      const gf=goldFloats[_gfii];
      if(gf.life<=0) continue;
      if(_gfi>=_goldTextPool.length) break;
      const t=_goldTextPool[_gfi++];
      if(t.text!==gf.text) t.text=gf.text||'';
      t.position.set(gf.x,gf.y); t.alpha=Math.min(1,gf.life/0.4); t.visible=true;
    }
    for(let j=_gfi;j<_goldTextPool.length;j++) if(_goldTextPool[j].visible) _goldTextPool[j].visible=false;
  }

  // Emote bubbles (network_features)
  if (typeof gameState !== 'undefined' && gameState) {
    for (const p of gs.players) {
      if (typeof drawEmoteBubbles === 'function') drawEmoteBubbles(_overlayCtx, p.x, p.y);
    }
  }

  for(let j=_emojiHWM; j<_emojiPool.length; j++) _emojiPool[j].visible = false;
  for(let j=_labelHWM; j<_labelPool.length; j++) _labelPool[j].visible = false;

  _overlayCtx.restore(); // end world transform
  _dbgT.overlay = performance.now() - _t0 - _dbgT.tiles;

  _syncLights(gs);
  _syncExplosionsPixi();

  // ── Screen-space overlay ─────────────────────────────────
  // Shop prompt
  const pp = getLocalPlayer ? getLocalPlayer(gs) : null;
  if (pp && pp.alive && typeof isInShopZone==='function' && isInShopZone(pp,gs) && !gs.shopOpen) {
    _overlayCtx.save();
    _overlayCtx.fillStyle='rgba(255,170,0,.85)';
    _overlayCtx.font='bold 14px Orbitron,monospace';
    _overlayCtx.textAlign='center';
    _overlayCtx.fillText('Press [E] to open SHOP', VW/2, VH-60);
    _overlayCtx.restore();
  }
  // Minimap dots: rendered inline by _screenGfx below

  // ── STATIC GRAPHICS (walls, border, lanes — rebuilt only on map change) ─
  if (_staticDirty) _rebuildStaticGfx(gs);

  // ── WORLD GRAPHICS (WebGL) ───────────────────────────────
  const _t_wgfx = performance.now();
  const g = _wGfx;
  g.clear();

  // Grid — separate _gridGfx, only rebuilt when camera crosses 80px cell boundary
  if(Math.abs(camX-_gridCamX)>40 || Math.abs(camY-_gridCamY)>40){
    _gridCamX=camX; _gridCamY=camY;
    _gridGfx.clear();
    _gridGfx.lineStyle(1, 0x00b4ff, 1);
    const gxS=Math.floor((camX-80)/80)*80, gyS=Math.floor((camY-80)/80)*80;
    for(let x=gxS; x<camX+ZW+160; x+=80){ _gridGfx.moveTo(x,camY-80); _gridGfx.lineTo(x,camY+ZH+80); }
    for(let y=gyS; y<camY+ZH+160; y+=80){ _gridGfx.moveTo(camX-80,y); _gridGfx.lineTo(camX+ZW+80,y); }
  }
  // Visual-only alpha pulse — throttled to every other frame (~30 Hz at 60fps)
  if((_visualPulseFlip = !_visualPulseFlip)){
    _gridGfx.alpha = Math.sin(t/2000)*0.015+0.045;
    const cp = Math.sin(t/800)*0.03+0.07;
    _arenaGfx1.alpha = cp;
    _arenaGfx2.alpha = cp * 0.6;
  }

  // Shop zones — outline cached, fills via sprite alpha
  if(_shopDirty){
    _shopDirty=false;
    _shopOutlineGfx.clear();
    for(let si=0;si<allShops.length;si++){
      const sz=allShops[si];
      _shopOutlineGfx.lineStyle(2,0xffaa00,si===0?0.5:0.35);
      _shopOutlineGfx.drawRect(sz.x-10,sz.y-10,sz.w+20,sz.h+20);
    }
  }
  for(let si=0;si<_shopFillSprites.length;si++){
    if(si<allShops.length){
      const sz=allShops[si]; const sp=Math.sin(t/600+si)*0.04+0.08;
      _shopFillSprites[si].position.set(sz.x-10,sz.y-10);
      _shopFillSprites[si].width=sz.w+20; _shopFillSprites[si].height=sz.h+20;
      _shopFillSprites[si].alpha=sp; _shopFillSprites[si].visible=true;
    } else { _shopFillSprites[si].visible=false; }
  }

  // Grenades (circle only; emoji drawn in overlay)
  if (gs.grenades) {
    for (const gr of gs.grenades) {
      const gp = Math.sin(t/150)*0.2+0.8;
      g.lineStyle(0); g.beginFill(0xff8800,gp); g.drawCircle(gr.x,gr.y,6); g.endFill();
    }
  }

  // Traps
  if (gs.traps) {
    for (const trap of gs.traps) {
      if (!trap.armed) continue;
      const tp = Math.sin(t/400)*0.15+0.5;
      g.lineStyle(2,0xff8833,tp); g.drawCircle(trap.x,trap.y,trap.radius);
    }
  }

  // Pre-compute allDead once per camp — reused in main loop and minimap (for+break, Phase 5.2)
  for(let _ci=0;_ci<gs.camps.length;_ci++){
    const _cc=gs.camps[_ci]; let _ad=true;
    for(let _mi=0;_mi<_cc.mobs.length;_mi++){if(_cc.mobs[_mi].alive){_ad=false;break;}}
    _cc._allDead=_ad;
  }

  // Alive camp circles → cached _campAliveGfx (only rebuilt when alive/dead state changes)
  let _campStateKey='';
  for(let _ci2=0;_ci2<gs.camps.length;_ci2++) _campStateKey+=gs.camps[_ci2]._allDead?'1':'0';
  if(_campStateKey!==_campAliveCacheKey){
    _campAliveCacheKey=_campStateKey;
    _campAliveGfx.clear();
    for(let _ci2=0;_ci2<gs.camps.length;_ci2++){
      const camp=gs.camps[_ci2];
      if(camp._allDead) continue;
      const [mc]=_c(camp.mobs[0]?.color||'#ffffff');
      _campAliveGfx.lineStyle(1,mc,0.2); _campAliveGfx.drawCircle(camp.x,camp.y,45);
    }
  }
  // Dead camp respawn arcs — truly dynamic (arc progress changes each frame)
  for(const camp of gs.camps){
    if(!camp._allDead||!camp.dead) continue;
    if(camp.x<camX-60||camp.x>camX+ZW+60||camp.y<camY-60||camp.y>camY+ZH+60) continue;
    const pct=Math.min(1,(t-camp.deathTime)/camp.respawnTime);
    g.lineStyle(1,0x646464,0.2); g.drawCircle(camp.x,camp.y,35);
    g.lineStyle(2,0xffffff,0.3); g.moveTo(camp.x,camp.y-35);
    g.arc(camp.x,camp.y,35,-Math.PI/2,-Math.PI/2+pct*Math.PI*2);
  }
  // Mob HP bars
  for(let _ci2=0;_ci2<gs.camps.length;_ci2++){
    const camp=gs.camps[_ci2];
    for(const mob of camp.mobs){
      if(!mob.alive) continue;
      if(mob.x<camX-60||mob.x>camX+ZW+60||mob.y<camY-60||mob.y>camY+ZH+60) continue;
      if(_hpIdx>=_HP_SLOTS) break;
      const bw=mob.radius*2.2, bh=3, bxm=mob.x-bw/2, bym=mob.y+mob.radius+4;
      const hf=Math.max(0,mob.hp/mob.maxHp);
      _hpBg[_hpIdx].position.set(bxm,bym); _hpBg[_hpIdx].width=bw; _hpBg[_hpIdx].height=bh; _hpBg[_hpIdx].visible=true;
      _hpFill[_hpIdx].position.set(bxm,bym); _hpFill[_hpIdx].width=bw*hf; _hpFill[_hpIdx].height=bh;
      _hpFill[_hpIdx].tint=hf>.5?0x88aa44:0xff6644; _hpFill[_hpIdx].alpha=1; _hpFill[_hpIdx].visible=hf>0;
      _hpIdx++;
    }
  }

  // Towers — range circles cached in _towerRangeGfx, HP bar sprites always current
  if(gs.towers){
    let _twKey='';
    for(const tw of gs.towers) _twKey+=tw.hp+',';
    if(_twKey!==_towerCacheKey){
      _towerCacheKey=_twKey;
      _towerRangeGfx.clear();
      for(const tw of gs.towers){
        if(tw.hp<=0) continue;
        const [tc]=_c(tw.color);
        _towerRangeGfx.lineStyle(0); _towerRangeGfx.beginFill(tc,0.06); _towerRangeGfx.drawCircle(tw.x,tw.y,tw.atkRange); _towerRangeGfx.endFill();
        _towerRangeGfx.lineStyle(1,tc,0.15); _towerRangeGfx.drawCircle(tw.x,tw.y,tw.atkRange);
        _towerRangeGfx.lineStyle(0); _towerRangeGfx.beginFill(tc,1); _towerRangeGfx.drawCircle(tw.x,tw.y,tw.radius); _towerRangeGfx.endFill();
      }
    }
    for(const tw of gs.towers){
      if(tw.hp<=0||_hpIdx>=_HP_SLOTS) continue;
      const bwt=tw.radius*2.5, bht=5, bxt=tw.x-bwt/2, byt=tw.y+tw.radius+8;
      const hft=Math.max(0,tw.hp/tw.maxHp);
      _hpBg[_hpIdx].position.set(bxt,byt); _hpBg[_hpIdx].width=bwt; _hpBg[_hpIdx].height=bht; _hpBg[_hpIdx].visible=true;
      _hpFill[_hpIdx].position.set(bxt,byt); _hpFill[_hpIdx].width=bwt*hft; _hpFill[_hpIdx].height=bht;
      _hpFill[_hpIdx].tint=hft>.5?0x00ff88:hft>.25?0xffaa00:0xff3355; _hpFill[_hpIdx].alpha=1; _hpFill[_hpIdx].visible=hft>0;
      _hpIdx++;
    }
  }

  // Dash trails → rotated-rectangle sprites (Phase 2.5)
  let _di=0;
  for(let _dii=0;_dii<gs.dashTrails.length;_dii++){
    const tr=gs.dashTrails[_dii];
    if(tr.life<=0) continue;
    if(_di>=_dashLinePool.length) break;
    const dx=tr.x2-tr.x1, dy=tr.y2-tr.y1;
    const len=Math.sqrt(dx*dx+dy*dy);
    if(len<1) continue;
    const spr=_dashLinePool[_di++];
    spr.position.set(tr.x1,tr.y1);
    spr.rotation=Math.atan2(dy,dx);
    spr.width=len; spr.height=6;
    spr.alpha=tr.life*0.6;
    spr.tint=_cCached(tr.color)[0];
    spr.visible=true;
  }
  for(let j=_di;j<_dashHWM;j++) _dashLinePool[j].visible=false;
  _dashHWM=_di;

  // Orbs → sprite pool (Phase 2.6 — replaces 2 drawCircle per orb per frame)
  let _oi=0;
  for(let _oii=0;_oii<gs.orbs.length;_oii++){
    const o=gs.orbs[_oii];
    if(o.x<camX-30||o.x>camX+ZW+30||o.y<camY-30||o.y>camY+ZH+30) continue;
    if(_oi>=_MAX_ORBS) break;
    const gv=Math.sin(o.pulse)*.5+.5;
    const life=o.life!==undefined?o.life:18;
    const fade=life>3?1:life>1?life/3:(Math.floor(life*6)%2===0?0.3:0.9);
    const outer=_orbOuter[_oi]; const inner=_orbInner[_oi]; _oi++;
    outer.position.set(o.x,o.y); outer.scale.set(o.r*(1.3+gv*.2)/16); outer.alpha=(0.25+gv*0.2)*fade; outer.visible=true;
    inner.position.set(o.x,o.y); inner.scale.set(o.r*(0.88+gv*.12)/16); inner.alpha=(0.75+gv*0.25)*fade; inner.visible=true;
  }
  for(let j=_oi;j<_orbHWM;j++){ _orbOuter[j].visible=false; _orbInner[j].visible=false; }
  _orbHWM=_oi;

  // Bullet trails → ParticleContainer (Phase 2.5)
  let _ti=0;
  for(let _tii=0;_tii<bulletTrails.length;_tii++){
    const bt=bulletTrails[_tii];
    if(bt.life<=0) continue;
    if(bt.x<camX-16||bt.x>camX+ZW+16||bt.y<camY-16||bt.y>camY+ZH+16) continue;
    if(_ti>=_trailPool.length) break;
    const spr=_trailPool[_ti++];
    spr.position.set(bt.x,bt.y);
    spr.scale.set(bt.sz*bt.life/8);
    spr.alpha=bt.life*0.4;
    spr.tint=_cCached(bt.color)[0];
    spr.visible=true;
  }
  for(let j=_ti;j<_trailHWM;j++) _trailPool[j].visible=false;
  _trailHWM=_ti;

  // Particles → ParticleContainer (Phase 2.3 — eliminates hundreds of Graphics.drawCircle/frame)
  let _pi=0;
  for(let _pii=0;_pii<gs.particles.length;_pii++){
    const p=gs.particles[_pii];
    if(p.life<=0) continue;
    if(p.x<camX-16||p.x>camX+ZW+16||p.y<camY-16||p.y>camY+ZH+16) continue;
    if(_pi>=_particlePool.length) break;
    const spr=_particlePool[_pi++];
    spr.position.set(p.x,p.y);
    spr.scale.set(p.sz*p.life/8);
    spr.alpha=Math.max(0,p.life);
    spr.tint=_cCached(p.col)[0];
    spr.visible=true;
  }
  for(let j=_pi;j<_particleHWM;j++) _particlePool[j].visible=false;
  _particleHWM=_pi;

  // Bullets → ParticleContainer (Phase 2.1 — snipe stays in Graphics for double-circle look)
  let _bi=0;
  for(let _bii=0;_bii<gs.bullets.length;_bii++){
    const b=gs.bullets[_bii];
    if(b.life<=0) continue;
    if(b.x<camX-20||b.x>camX+ZW+20||b.y<camY-20||b.y>camY+ZH+20) continue;
    if(b.isSnipe){
      g.lineStyle(0); g.beginFill(0xff4444,1); g.drawCircle(b.x,b.y,b.r*2); g.endFill();
      g.beginFill(0xffffff,1); g.drawCircle(b.x,b.y,3); g.endFill();
      continue;
    }
    if(_bi>=_bulletPool.length) continue;
    const spr=_bulletPool[_bi++];
    spr.position.set(b.x,b.y);
    spr.scale.set(b.r/4);
    spr.alpha=b.isMage?0.9:1;
    spr.tint=_cCached(b.color||'#ffffff')[0];
    spr.visible=true;
  }
  // Mob bullets → ParticleContainer (Phase 2.2)
  if(gs.mobBullets){
    for(let _bii=0;_bii<gs.mobBullets.length;_bii++){
      const b=gs.mobBullets[_bii];
      if(b.x<camX-20||b.x>camX+ZW+20||b.y<camY-20||b.y>camY+ZH+20) continue;
      if(_bi>=_bulletPool.length) continue;
      const spr=_bulletPool[_bi++];
      spr.position.set(b.x,b.y);
      spr.scale.set((b.r||5)/4);
      spr.alpha=b.isFire?0.85:0.9;
      spr.tint=b.isFire?0xff8800:_cCached(b.color||'#bb77ff')[0];
      spr.visible=true;
    }
  }
  for(let j=_bi;j<_bulletHWM;j++) _bulletPool[j].visible=false;
  _bulletHWM=_bi;

  // Impact rings
  if (typeof impactRings !== 'undefined') {
    for (const ring of impactRings) {
      const [rc,] = _c(ring.color);
      g.lineStyle(4*ring.life, rc, ring.life*0.7); g.drawCircle(ring.x,ring.y,ring.r);
    }
  }

  // Hook chain
  for (const p of gs.players) {
    if (!p.hookOn) continue;
    g.lineStyle(3,0x00ff88,0.7);
    g.moveTo(p.x+Math.cos(p.hookAngle||p.angle)*p.radius,
             p.y+Math.sin(p.hookAngle||p.angle)*p.radius);
    g.lineTo(p.hookX||p.x, p.hookY||p.y);
    g.lineStyle(0); g.beginFill(0x00ff88,0.9); g.drawCircle(p.hookX||p.x,p.hookY||p.y,5); g.endFill();
    if (p.hookHit) {
      g.beginFill(0x00ff88,0.5); g.drawCircle(p.hookX||p.x,p.hookY||p.y,18); g.endFill();
    }
  }

  // Ranger laser
  for (const p of gs.players) {
    if (!p.charging||!p.chargeTimer||p.cls!=='ranger') continue;
    const ca = p.chargeAngle||p.angle, cp2 = Math.min(1,p.chargeTimer/1200);
    const ll = 200+cp2*400;
    g.lineStyle(1.5+cp2*2, 0xff2222, 0.3+cp2*0.5);
    g.moveTo(p.x+Math.cos(ca)*p.radius, p.y+Math.sin(ca)*p.radius);
    g.lineTo(p.x+Math.cos(ca)*ll, p.y+Math.sin(ca)*ll);
    const _rng = p.radius+8+cp2*12;
    g.lineStyle(3,0xff3333,0.5+cp2*0.4);
    g.moveTo(p.x, p.y - _rng);
    g.arc(p.x,p.y,_rng,-Math.PI/2,-Math.PI/2+cp2*Math.PI*2);
  }

  // Smoke clouds
  for (const p of gs.players) {
    if (p.smokeTimer>0) {
      g.lineStyle(0); g.beginFill(0x505050,Math.min(0.4,p.smokeTimer/3000));
      g.drawCircle(p.smokeX,p.smokeY,80); g.endFill();
    }
  }

  // ── PLAYERS (rings / effects) ─────────────────────────────
  for (const p of gs.players) {
    if (!p.alive) continue;
    if (p.invuln>0&&Math.floor(p.invuln/80)%2===0) continue;
    // Cull all players (human included) when clearly off-screen — 100px margin for largest effects
    if (p.x<camX-100||p.x>camX+ZW+100||p.y<camY-100||p.y>camY+ZH+100) continue;
    if ((p.smokeTimer>0||p.invisTimer>0)&&!p.isHuman) {
      g.lineStyle(0); g.beginFill(_c(p.color)[0],0.12); g.drawCircle(p.x,p.y,p.radius); g.endFill();
      continue;
    }

    // Glow / team / overcharge rings
    if (p.glowTimer>0||p.overchargeTimer>0||p.barrierOn) {
      const gc = p.overchargeTimer>0?0x00ffff:p.barrierOn?0xcc44ff:_c(p.glowColor||p.color)[0];
      const pulse = Math.sin(t/80)*0.3+0.5;
      g.lineStyle(2,gc,0.4+pulse*0.3); g.drawCircle(p.x,p.y,p.radius+18);
    }
    if (gs.teamMode) {
      g.lineStyle(3,p.team===1?0x4488ff:0xff4444,0.6); g.drawCircle(p.x,p.y,p.radius+4);
    }
    if (p.overchargeTimer>0) {
      g.lineStyle(3,0x00ffff,0.5+Math.sin(t/100)*0.3); g.drawCircle(p.x,p.y,p.radius+12);
    }
    if (p.barrierOn) {
      const bA=Math.min(0.7,p.barrierHp/80);
      g.lineStyle(4,0xcc44ff,bA); g.drawCircle(p.x,p.y,p.radius+35);
      g.lineStyle(0); g.beginFill(0xcc44ff,bA*0.15); g.drawCircle(p.x,p.y,p.radius+35); g.endFill();
    }
    if (p.shield>0) {
      g.lineStyle(2,0x88aaff,0.5+Math.sin(t/200)*0.2); g.drawCircle(p.x,p.y,p.radius+7);
    }
    if (p.killStreak>=3) {
      const sc=p.killStreak>=7?0xffaa00:p.killStreak>=5?0x00ff88:0xff4444;
      g.lineStyle(2,sc,0.25+Math.sin(t/150)*0.15); g.drawCircle(p.x,p.y,p.radius+20);
    }
    if (p.novaOn) {
      g.lineStyle(4,_c(p.color)[0],Math.max(0,p.novaLife/700)*0.85);
      g.drawCircle(p.novaX,p.novaY,p.novaR);
    }
    // Aim line
    g.lineStyle(1,0xffffff,0.15);
    g.moveTo(p.x+Math.cos(p.angle)*(p.radius+2), p.y+Math.sin(p.angle)*(p.radius+2));
    g.lineTo(p.x+Math.cos(p.angle)*(p.radius+18), p.y+Math.sin(p.angle)*(p.radius+18));
    // Sword arc
    if (p.swordOn&&p.swordAngle!==undefined) {
      const sa=p.swordAngle, sw=p.swordSweep||0;
      const _sr=p.radius+16;
      g.lineStyle(3,0xffffff,0.7);
      g.moveTo(p.x+_sr*Math.cos(sa-sw), p.y+_sr*Math.sin(sa-sw));
      g.arc(p.x,p.y,_sr,sa-sw,sa+sw);
      g.lineStyle(0); g.beginFill(0xffffff,0.3);
      g.drawCircle(p.x+Math.cos(sa)*(p.radius+20), p.y+Math.sin(sa)*(p.radius+20), 4); g.endFill();
    }
    // HP bar → sprite (Phase 2.4)
    if(_hpIdx<_HP_SLOTS){
      const hpPct=Math.max(0,p.hp/p.maxHp), bwP=p.radius*2.4, bhP=4, bxP=p.x-bwP/2, byP=p.y+p.radius+6;
      _hpBg[_hpIdx].position.set(bxP,byP); _hpBg[_hpIdx].width=bwP; _hpBg[_hpIdx].height=bhP; _hpBg[_hpIdx].visible=true;
      _hpFill[_hpIdx].position.set(bxP,byP); _hpFill[_hpIdx].width=bwP*hpPct; _hpFill[_hpIdx].height=bhP;
      _hpFill[_hpIdx].tint=hpPct>.5?0x00dd66:hpPct>.25?0xffaa00:0xff3355; _hpFill[_hpIdx].alpha=1; _hpFill[_hpIdx].visible=hpPct>0;
      _hpIdx++;
      if(p.shield>0&&_hpIdx<_HP_SLOTS){
        const sf=Math.min(1,p.shield/p.maxHp);
        _hpFill[_hpIdx].position.set(bxP,byP); _hpFill[_hpIdx].width=bwP*sf; _hpFill[_hpIdx].height=bhP;
        _hpFill[_hpIdx].tint=0x88aaff; _hpFill[_hpIdx].alpha=0.7; _hpFill[_hpIdx].visible=true;
        _hpBg[_hpIdx].visible=false; _hpIdx++; // no bg for shield overlay
      }
    }
  }

  // Wards (dashed ring in PIXI)
  if (gs.wards) {
    for (const w of gs.wards) {
      g.lineStyle(1,0x00ccff,0.3); g.drawCircle(w.x,w.y,w.radius);
    }
  }

  _dbgT.wgfx = performance.now() - _t_wgfx;

  // ── SCREEN-SPACE HUD (WebGL) ─────────────────────────────
  const sg = _screenGfx;
  sg.clear();

  // Timer bar
  const elapsed = (t - gs.startTime)/1000;
  const tf = Math.max(0,(gs.matchTime-elapsed)/gs.matchTime);
  sg.lineStyle(0); sg.beginFill(0x00f5ff,1); sg.drawRect(0,0,VW*tf,2); sg.endFill();

  // Minimap — throttled to ~10fps (every 40 frames). Clear() + redraw of _mmGfx is non-trivial.
  const mmW=140, mmH=100, mmX=VW-mmW-10, mmY=VH-mmH-10;
  if (++_mmAge % 40 === 0) {
    _mmGfx.clear();
    _mmGfx.beginFill(0x05080f,0.8); _mmGfx.drawRect(mmX,mmY,mmW,mmH); _mmGfx.endFill();
    _mmGfx.lineStyle(1,0x00f5ff,0.25); _mmGfx.drawRect(mmX,mmY,mmW,mmH);
    // Shops
    _mmGfx.lineStyle(0);
    for (const sz of allShops) {
      _mmGfx.beginFill(0xffaa00,0.6); _mmGfx.drawRect(mmX+sz.x/W*mmW-2,mmY+sz.y/H*mmH-2,5,5); _mmGfx.endFill();
    }
    // Camps
    for (const camp of gs.camps) {
      const ad = camp._allDead;
      _mmGfx.beginFill(ad?0x646464:0xff6432,ad?0.3:0.5);
      _mmGfx.drawCircle(mmX+camp.x/W*mmW, mmY+camp.y/H*mmH, 2); _mmGfx.endFill();
    }
    // Players
    for (const p2 of gs.players) {
      if (!p2.alive) continue;
      const mc = gs.teamMode ? (p2.team===1?0x4488ff:0xff4444) : _c(p2.color)[0];
      _mmGfx.lineStyle(0); _mmGfx.beginFill(mc,1); _mmGfx.drawCircle(mmX+p2.x/W*mmW,mmY+p2.y/H*mmH,3); _mmGfx.endFill();
      if (p2.isHuman) { _mmGfx.lineStyle(1,0xffffff,1); _mmGfx.drawCircle(mmX+p2.x/W*mmW,mmY+p2.y/H*mmH,4); }
    }
    // Walls (use OffscreenCanvas painted to overlay)
    _overlayCtx.drawImage(_getMinimapWallCache(gs.walls,mmW,mmH), mmX, mmY);
  }
  // Camera rect updates every frame (follows camera smoothly)
  sg.lineStyle(1,0xffffff,0.3);
  sg.drawRect(mmX+camX/W*mmW, mmY+camY/H*mmH, ZW/W*mmW, ZH/H*mmH);

  // ── Hide entity sprites not drawn this frame (dead players, off-screen mobs) ──
  for (const [k, spr] of _entitySprites) {
    if (!_entityActive.has(k)) spr.visible = false;
  }
  _entityActive.clear();

  // ── Hide unused HP bar sprites — high-water-mark so we only iterate active slots ──
  for(let _j=_hpIdx;_j<_hpHWM;_j++){ _hpBg[_j].visible=false; _hpFill[_j].visible=false; }
  _hpHWM=_hpIdx;

  // ── Sync player names to PIXI.Text (Phase 3.2) ──
  for(let _pi=0;_pi<gs.players.length;_pi++){
    const p=gs.players[_pi];
    if(!p.alive||(!p.isHuman&&(p.x<camX-80||p.x>camX+ZW+80||p.y<camY-80||p.y>camY+ZH+80))){
      const nt=_nameMap.get(p.id); if(nt) nt.visible=false; continue;
    }
    let nt=_nameMap.get(p.id);
    if(!nt){
      if(_bitmapFontsReady){
        nt=new PIXI.BitmapText(p.name||p.cls||'',{fontName:'STM10',fontSize:10});
        nt.tint=_colorToHex(p.color);
      } else {
        nt=new PIXI.Text(p.name||p.cls||'',{..._nameStyle,fill:p.color||0xffffff});
      }
      nt.anchor.set(0.5,1); _nameCont.addChild(nt); _nameMap.set(p.id,nt);
    }
    const label=p.name||p.cls||'';
    if(nt.text!==label) nt.text=label;
    if(_bitmapFontsReady && nt.tint!==undefined){
      const nc=_colorToHex(p.color); if(nt.tint!==nc) nt.tint=nc;
    }
    nt.position.set(p.x,p.y-p.radius-6);
    nt.visible=true;
  }

  // ── Render PixiJS ─────────────────────────────────────────
  const _now = performance.now();
  _moodFilter.uniforms.uTime  = _now * 0.001;
  _moodFilter.uniforms.uShake = Math.min(1, (typeof shakeIntensity !== 'undefined' ? shakeIntensity : 0) / 10);
  const _lp = typeof getLocalPlayer === 'function' && gs ? getLocalPlayer(gs) : null;
  _moodFilter.uniforms.uLowHp = _lp ? Math.max(0, (0.3 - _lp.hp / _lp.maxHp) / 0.3) : 0;
  const _t_pixi = _now;
  pixiApp.renderer.render(_stage);
  _dbgRecord(performance.now() - _t_pixi, gs);
}

// ─────────────────────────────────────────────────────────────
//  PLAYER SHAPE  (draws to overlay 2D ctx, already world-space)
// ─────────────────────────────────────────────────────────────
function _renderPlayerShape(oc, p, alpha) {
  const size  = p.radius * 2.4;
  const state = getPlayerAnimState(p);
  // GPU path — Pixi sprite in world-space, inherits camera transform from worldCont
  const gpuDone = _drawEntitySpritePixi('p_'+p.id, 'class_'+p.cls, p.x, p.y, size, state, p.angle, alpha);
  if (gpuDone) return;
  // Canvas 2D fallback — used until prewarmPixiTextures completes
  if (typeof drawEntitySprite === 'function') {
    oc.save();
    oc.globalAlpha = alpha;
    oc.translate(p.x, p.y);
    const drawn = drawEntitySprite(oc, 'class_'+p.cls, size, state, p.angle);
    oc.restore();
    if (drawn) return;
  }

  oc.save();
  oc.globalAlpha = alpha;
  oc.translate(p.x, p.y);

  if (p.cls === 'assassin') {
    oc.fillStyle = p.color;
    oc.beginPath();
    oc.moveTo(0,-p.radius); oc.lineTo(p.radius*.7,p.radius*.3);
    oc.lineTo(0,p.radius*.6); oc.lineTo(-p.radius*.7,p.radius*.3);
    oc.closePath(); oc.fill();
    oc.strokeStyle='#fff6'; oc.lineWidth=1.2; oc.stroke();

  } else if (p.cls === 'mage') {
    oc.fillStyle = p.color;
    oc.beginPath();
    for (let i=0; i<6; i++) {
      const a = i*Math.PI/3+_frameTime*.0005;
      i===0 ? oc.moveTo(Math.cos(a)*p.radius,Math.sin(a)*p.radius)
             : oc.lineTo(Math.cos(a)*p.radius,Math.sin(a)*p.radius);
    }
    oc.closePath(); oc.fill();
    oc.strokeStyle='#fff4'; oc.lineWidth=1.2; oc.stroke();

  } else if (p.cls === 'tank') {
    oc.fillStyle = p.color;
    oc.beginPath();
    for (let i=0; i<8; i++) {
      const a = i*Math.PI/4, r = p.radius*(i%2===0?1:0.85);
      i===0 ? oc.moveTo(Math.cos(a)*r,Math.sin(a)*r)
             : oc.lineTo(Math.cos(a)*r,Math.sin(a)*r);
    }
    oc.closePath(); oc.fill();
    oc.strokeStyle='#fff6'; oc.lineWidth=2; oc.stroke();
    if (p.fortifyTimer>0) {
      const pulse=Math.sin(_frameTime/100)*0.3+0.5;
      oc.save(); oc.strokeStyle='#00ff88'; oc.lineWidth=4;
      oc.globalAlpha=alpha*(0.4+pulse*0.3);
      oc.beginPath(); oc.arc(0,0,p.radius+14,0,Math.PI*2); oc.stroke();
      oc.restore();
    }

  } else if (p.cls === 'necro') {
    const nT = _frameTime;
    // Orbiting wisps
    for (let wi=0; wi<3; wi++) {
      const wa=nT*0.002+wi*2.1, wr=p.radius+8+Math.sin(nT*0.003+wi)*5;
      oc.save(); oc.globalAlpha=alpha*(0.3+Math.sin(nT*0.005+wi)*0.15);
      oc.fillStyle='#aaffaa';
      oc.beginPath(); oc.arc(Math.cos(wa)*wr,Math.sin(wa)*wr,2+Math.sin(nT*0.004+wi),0,Math.PI*2); oc.fill();
      oc.restore();
    }
    oc.fillStyle = p.color;
    oc.beginPath();
    for (let i=0; i<5; i++) {
      const a = i*Math.PI*2/5-Math.PI/2+nT*0.001;
      i===0 ? oc.moveTo(Math.cos(a)*p.radius,Math.sin(a)*p.radius)
             : oc.lineTo(Math.cos(a)*p.radius,Math.sin(a)*p.radius);
    }
    oc.closePath(); oc.fill();
    oc.strokeStyle='#aaffaa66'; oc.lineWidth=1.5; oc.stroke();
    if (p.drainTimer>0) {
      oc.save(); oc.globalAlpha=alpha*0.15*(p.drainTimer/800);
      oc.fillStyle='#aaffaa';
      oc.beginPath(); oc.moveTo(0,0);
      oc.arc(0,0,220,p.angle-0.65,p.angle+0.65); oc.closePath(); oc.fill();
      oc.restore();
    }
    // Minions
    if (p.minions) {
      for (const m of p.minions) {
        if (!m.alive) continue;
        oc.save(); oc.translate(m.x-p.x,m.y-p.y);
        const ss=m.spawnAnim>0?1.5-m.spawnAnim*0.5:1;
        oc.scale(ss,ss);
        oc.fillStyle='#aaffaa'; oc.globalAlpha=0.85;
        oc.beginPath();
        for (let si=0; si<3; si++) {
          const sa=si*Math.PI*2/3-Math.PI/2+nT*0.003;
          si===0?oc.moveTo(Math.cos(sa)*(m.radius||8),Math.sin(sa)*(m.radius||8))
                :oc.lineTo(Math.cos(sa)*(m.radius||8),Math.sin(sa)*(m.radius||8));
        }
        oc.closePath(); oc.fill();
        oc.strokeStyle='#88cc44'; oc.lineWidth=1.5; oc.stroke();
        oc.restore();
      }
    }

  } else if (p.cls === 'ranger') {
    const rT = _frameTime;
    for (let wi=0; wi<2; wi++) {
      const wa=rT*0.003+wi*3.14, wr=p.radius+6+Math.sin(rT*0.004+wi)*4;
      oc.save(); oc.globalAlpha=alpha*(0.25+Math.sin(rT*0.005+wi)*0.1);
      oc.fillStyle='#ffcc66';
      oc.beginPath(); oc.arc(Math.cos(wa)*wr,Math.sin(wa)*wr,2,0,Math.PI*2); oc.fill();
      oc.restore();
    }
    oc.fillStyle = p.color;
    oc.beginPath();
    oc.moveTo(0,-p.radius); oc.lineTo(p.radius*0.65,0);
    oc.lineTo(0,p.radius); oc.lineTo(-p.radius*0.65,0);
    oc.closePath(); oc.fill();
    oc.strokeStyle='#ffcc6666'; oc.lineWidth=1.5; oc.stroke();

  } else {
    // Gunner + fallback: cached radial-gradient circle
    const c = _getClsCircle(p.cls, p.color, p.radius);
    oc.drawImage(c.off, -c.d/2, -c.d/2, c.d, c.d);
  }

  oc.restore();
}

// ─────────────────────────────────────────────────────────────
//  MINION SLASHES  (inline — vfx.js drawMinionSlashes needs a
//  screen-space ctx; we replicate its drawing here in world space)
// ─────────────────────────────────────────────────────────────
function _drawMinionSlashes(oc) {
  if (typeof minionSlashes === 'undefined') return;
  for (const s of minionSlashes) {
    const tx = s.life / s.maxLife;      // 1→0 as slash ages
    const prog = 1 - tx;
    oc.save();
    oc.translate(s.x, s.y);
    oc.rotate(s.angle);
    oc.globalAlpha = tx * 0.9;
    for (let i=-1; i<=1; i++) {
      const off2 = i*0.4, arcR = 18+prog*15;
      oc.strokeStyle = i===0?'#ccffcc':'#88cc44';
      oc.lineWidth   = i===0?3:2;
      oc.beginPath();
      oc.arc(0,0,arcR,-0.8+off2+prog*0.3,0.8+off2-prog*0.3);
      oc.stroke();
    }
    if (prog < 0.3) {
      oc.globalAlpha = (1-prog/0.3)*0.6;
      oc.fillStyle='#ffffff';
      oc.beginPath(); oc.arc(0,0,6*(1-prog),0,Math.PI*2); oc.fill();
    }
    oc.restore();
  }
}

// ─────────────────────────────────────────────────────────────
//  DEBUG OVERLAY COMPAT
// renderDebugOverlay (debug.js) draws to the global `ctx`.
// Since engine.js wires ctx → _overlayCtx, this works automatically.
// ─────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════
// PERF DEBUG PANEL  (toggle with backtick `)
// ═══════════════════════════════════════════════════════════════
const _dbgT = { tiles: 0, overlay: 0, wgfx: 0, pixi: 0, build: 0 };
const _dbgEng = { sched: 0, ai: 0, minions: 0, bullets: 0, camps: 0, misc: 0, render: 0, hud: 0 };
const _dbgBuf = new Float32Array(120); // circular frame-time buffer
let _dbgBufI = 0, _dbgShow = false, _dbgLastMs = 0, _dbgLastFrame = 0;
let _perfDbgEl = null, _dbgLastText = '';

let _dbgTextEl = null, _dbgCopyBtn = null;

function _dbgEnsureEl() {
  if (_perfDbgEl) return;

  // Outer wrapper — holds button + text separately so innerHTML on text won't nuke the button
  _perfDbgEl = document.createElement('div');
  _perfDbgEl.id = '_perfDbg';
  _perfDbgEl.style.cssText = [
    'position:fixed', 'top:8px', 'left:8px', 'z-index:9999',
    'background:rgba(0,0,0,.82)', 'color:#0ff', 'font:11px/1.55 "Share Tech Mono",monospace',
    'border:1px solid #0ff4', 'border-radius:4px', 'pointer-events:all',
    'min-width:240px', 'padding-bottom:4px'
  ].join(';');

  // Button row at top
  const _btnRow = document.createElement('div');
  _btnRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:5px 10px 3px;border-bottom:1px solid #0ff2;margin-bottom:2px;';
  _btnRow.innerHTML = '<span style="color:#0ff;font-size:12px;font-weight:bold">⚡ PERF DEBUG</span>';
  _dbgCopyBtn = document.createElement('button');
  _dbgCopyBtn.textContent = '📋 COPY';
  _dbgCopyBtn.style.cssText = [
    'background:#0ff3', 'color:#0ff', 'border:1px solid #0ff8',
    'border-radius:3px', 'font:bold 10px "Share Tech Mono",monospace',
    'padding:3px 10px', 'cursor:pointer'
  ].join(';');
  _dbgCopyBtn.onclick = () => {
    navigator.clipboard.writeText(_dbgLastText || '').then(() => {
      _dbgCopyBtn.textContent = '✅ COPIED';
      setTimeout(() => { _dbgCopyBtn.textContent = '📋 COPY'; }, 1500);
    });
  };
  _btnRow.appendChild(_dbgCopyBtn);
  _perfDbgEl.appendChild(_btnRow);

  // Text area updated every frame
  _dbgTextEl = document.createElement('div');
  _dbgTextEl.style.cssText = 'padding:4px 10px;white-space:pre;pointer-events:none;';
  _perfDbgEl.appendChild(_dbgTextEl);

  document.body.appendChild(_perfDbgEl);
}

function _dbgRecord(pixiMs, gs) {
  const now = performance.now();
  const frameMs = now - _dbgLastMs;
  _dbgLastMs = now;
  _dbgT.pixi = pixiMs;
  _dbgBuf[_dbgBufI++ % 120] = frameMs;

  if (!_dbgShow) return;
  _dbgEnsureEl();

  // Compute stats over buffer
  let sum = 0, mn = 9999, mx = 0, spikes = 0;
  const n = Math.min(_dbgBufI, 120);
  for (let i = 0; i < n; i++) {
    const v = _dbgBuf[i];
    sum += v; if (v < mn) mn = v; if (v > mx) mx = v;
    if (v > 20) spikes++;
  }
  const avg = sum / n;
  const fps = 1000 / avg;
  const minFps = 1000 / mx;
  const maxFps = 1000 / mn;

  // Collect object counts from gameState
  const gc = (typeof gameState !== 'undefined' && gameState) ? gameState : null;
  const nBullets  = gc ? (gc.bullets?.length || 0) : 0;
  const nParticle = gc ? (gc.particles?.length || 0) : 0;
  const nPlayers  = gc ? gc.players.length : 0;
  const nMobBull  = gc ? (gc.mobBullets?.length || 0) : 0;
  const nTrails   = gc ? (gc.dashTrails?.length || 0) : 0;
  const nOrbs     = gc ? (gc.orbs?.length || 0) : 0;

  // Color-code spike count
  const spikeColor = spikes > 10 ? '#f55' : spikes > 3 ? '#fa0' : '#0f8';

  // Bar: last 30 frames
  let bar = '';
  for (let i = 0; i < 30; i++) {
    const v = _dbgBuf[(_dbgBufI - 30 + i + 120) % 120];
    bar += v > 20 ? '▇' : v > 12 ? '▅' : v > 8 ? '▃' : '▁';
  }

  const engTotal = _dbgEng.ai+_dbgEng.minions+_dbgEng.bullets+_dbgEng.camps+_dbgEng.misc+_dbgEng.render+_dbgEng.hud;
  const renderTotal = _dbgT.tiles+_dbgT.overlay+_dbgT.wgfx+_dbgT.pixi;
  // Individual threshold: red>2ms, yellow>1ms. Subtotal threshold: red>6ms, yellow>3ms
  function _ms(v,hi=2,mid=1) { return `<b style="color:${v>hi?'#f55':v>mid?'#fa0':'#0f8'}">${v.toFixed(2)}</b>`; }

  _dbgLastText = [
    `FPS  now:${fps.toFixed(0)}  avg:${(1000/avg).toFixed(0)}  min:${minFps.toFixed(0)}  max:${maxFps.toFixed(0)}`,
    `ms   avg:${avg.toFixed(2)}  min:${mn.toFixed(2)}  max:${mx.toFixed(2)}`,
    `spikes >20ms: ${spikes}/120`,
    `--- ENGINE ---`,
    ` sched  : ${_dbgEng.sched.toFixed(2)} ms`,
    ` ai     : ${_dbgEng.ai.toFixed(2)} ms`,
    ` minions: ${_dbgEng.minions.toFixed(2)} ms`,
    ` bullets: ${_dbgEng.bullets.toFixed(2)} ms`,
    ` camps  : ${_dbgEng.camps.toFixed(2)} ms`,
    ` misc   : ${_dbgEng.misc.toFixed(2)} ms`,
    ` hud    : ${_dbgEng.hud.toFixed(2)} ms`,
    ` subtotal: ${engTotal.toFixed(2)} ms`,
    `--- RENDERER ---`,
    ` tiles  : ${_dbgT.tiles.toFixed(2)} ms`,
    ` overlay: ${_dbgT.overlay.toFixed(2)} ms`,
    ` wgfx   : ${_dbgT.wgfx.toFixed(2)} ms`,
    ` pixi   : ${_dbgT.pixi.toFixed(2)} ms`,
    ` build* : ${_dbgT.build.toFixed(2)} ms  (idle, not in subtotal)`,
    ` subtotal: ${renderTotal.toFixed(2)} ms`,
    `--- OBJECTS ---`,
    ` players:${nPlayers} bullets:${nBullets} mbullets:${nMobBull}`,
    ` particles:${nParticle} trails:${nTrails} orbs:${nOrbs}`,
    ` colorCache:${_cCache.size}`,
    `--- FRAME BAR ---`,
    bar,
  ].join('\n');

  _dbgTextEl.innerHTML =
    `─────────────────────────────\n` +
    `FPS  now:<b style="color:${fps<120?'#fa0':'#0f8'}">${fps.toFixed(0)}</b>  avg:<b>${(1000/avg).toFixed(0)}</b>  min:<b style="color:${minFps<60?'#f55':'#fa0'}">${minFps.toFixed(0)}</b>  max:<b>${maxFps.toFixed(0)}</b>\n` +
    `ms   avg:<b>${avg.toFixed(2)}</b>  min:<b>${mn.toFixed(2)}</b>  max:<b style="color:${mx>20?'#f55':mx>12?'#fa0':'#0f8'}">${mx.toFixed(2)}</b>\n` +
    `spikes >20ms: <b style="color:${spikeColor}">${spikes}</b>/120 frames\n` +
    `─────────────────────────────\n` +
    `ENGINE UPDATE\n` +
    ` sched  : ${_ms(_dbgEng.sched,2,1)} ms  ← scheduler wait\n` +
    ` ai     : ${_ms(_dbgEng.ai)} ms\n` +
    ` minions: ${_ms(_dbgEng.minions)} ms\n` +
    ` bullets: ${_ms(_dbgEng.bullets)} ms\n` +
    ` camps  : ${_ms(_dbgEng.camps)} ms\n` +
    ` misc   : ${_ms(_dbgEng.misc)} ms\n` +
    ` hud    : ${_ms(_dbgEng.hud)} ms\n` +
    ` subtotal: ${_ms(engTotal,8,5)} ms\n` +
    `─────────────────────────────\n` +
    `RENDERER\n` +
    ` tiles  : ${_ms(_dbgT.tiles)} ms\n` +
    ` overlay: ${_ms(_dbgT.overlay)} ms\n` +
    ` wgfx   : ${_ms(_dbgT.wgfx)} ms\n` +
    ` pixi   : ${_ms(_dbgT.pixi)} ms\n` +
    ` build* : ${_ms(_dbgT.build,8,4)} ms  ← idle tile build\n` +
    ` subtotal: ${_ms(renderTotal,4,2)} ms\n` +
    `─────────────────────────────\n` +
    `OBJECTS\n` +
    ` players:${nPlayers}  bullets:${nBullets}  mbullets:${nMobBull}\n` +
    ` particles:${nParticle}  trails:${nTrails}  orbs:${nOrbs}\n` +
    ` colorCache:${_cCache.size}\n` +
    `─────────────────────────────\n` +
    bar;
}

window.addEventListener('keydown', e => {
  if (e.key === '`' || e.key === 'Dead' || e.code === 'Backquote') {
    _dbgShow = !_dbgShow;
    if (!_dbgShow && _perfDbgEl) { _perfDbgEl.style.display = 'none'; }
    else { _dbgEnsureEl(); if(_perfDbgEl) _perfDbgEl.style.display = ''; }
  }
});
