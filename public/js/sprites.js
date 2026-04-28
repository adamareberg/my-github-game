// ═══════════════════════════════════════════════════════════════
// SPRITES.JS — Sprite sheet loader, animation, and render helpers
// Load AFTER data.js, BEFORE renderer.js
// ═══════════════════════════════════════════════════════════════

// ── SPRITE SHEET DEFINITIONS ──
const SPRITE_SHEETS = {
  grassTiles: {
    src: 'sprites/grass-floor-tiles.png',
    cols: 4, rows: 2,
    frameW: 0, frameH: 0,
    img: null, loaded: false
  },
  waterAnim: {
    src: 'sprites/water-animated.png',
    cols: 2, rows: 2,       // 2×2 grid
    frameW: 0, frameH: 0,
    img: null, loaded: false
  },
  bloodSplat1: {
    src: 'sprites/blood-splatter-blue-1.png',
    cols: 5, rows: 1,
    frameW: 0, frameH: 0,
    img: null, loaded: false
  },
  bloodSplat2: {
    src: 'sprites/blood-splatter-blue.png',
    cols: 5, rows: 1,
    frameW: 0, frameH: 0,
    img: null, loaded: false
  },
  scrollItem: {
    src: 'sprites/scroll-item.png',
    cols: 4, rows: 1,
    frameW: 0, frameH: 0,
    img: null, loaded: false
  }
};

// ── LOAD ALL SPRITE SHEETS ──
let spritesReady = false;
let spritesLoadedCount = 0;
let spriteSheetsTotal = Object.keys(SPRITE_SHEETS).length;

function _checkSpritesReady() {
  if (spritesLoadedCount >= spriteSheetsTotal) spritesReady = true;
}

function loadAllSprites() {
  for (const key in SPRITE_SHEETS) {
    const sheet = SPRITE_SHEETS[key];
    fetch(sheet.src)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then(b => createImageBitmap(b))
      .then(bmp => {
        sheet.img = bmp;
        sheet.frameW = Math.floor(bmp.width / sheet.cols);
        sheet.frameH = Math.floor(bmp.height / sheet.rows);
        sheet.loaded = true;
        markSheetCacheDirty();
        spritesLoadedCount++;
        _checkSpritesReady();
      })
      .catch(() => {
        console.warn('[SPRITES] Failed to load:', sheet.src);
        spritesLoadedCount++;
        _checkSpritesReady();
      });
  }
}

// ── LOAD MAP SPRITES (called by map.js after custom map is read) ──
function loadMapSprites(sheets) {
  if (!sheets || !sheets.length) return;
  spritesReady = false;
  for (const sd of sheets) {
    const key = 'map_' + sd.name;
    const existing = SPRITE_SHEETS[key];
    if (existing && existing.loaded) continue; // already loaded — skip
    // If registered but failed (loaded=false, img=null) — retry by falling through

    const sheet = existing || {
      src: sd.path,
      cols: sd.cols || 1,
      rows: sd.rows || 1,
      frameW: 0, frameH: 0,
      img: null, loaded: false,
      name: sd.name,
      assignments: sd.assignments || null,
      regions: sd.regions || null
    };
    if (!existing) {
      SPRITE_SHEETS[key] = sheet;
      spriteSheetsTotal++;
    }
    fetch(sheet.src)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then(b => createImageBitmap(b))
      .then(bmp => {
        sheet.img = bmp;
        sheet.frameW = Math.floor(bmp.width / sheet.cols);
        sheet.frameH = Math.floor(bmp.height / sheet.rows);
        sheet.loaded = true;
        markSheetCacheDirty();
        if (!existing) { spritesLoadedCount++; _checkSpritesReady(); }
      })
      .catch(() => {
        console.warn('[SPRITES] Failed to load map sprite:', sheet.src);
        if (!existing) { spritesLoadedCount++; _checkSpritesReady(); }
      });
  }
  // If all added sheets were already loaded, re-check immediately
  _checkSpritesReady();
}

loadAllSprites();

// ── DRAW A SINGLE FRAME FROM A SPRITE SHEET ──
function drawSpriteFrame(ctx, sheet, col, row, x, y, w, h) {
  if (!sheet || !sheet.loaded) return;
  ctx.drawImage(
    sheet.img,
    col * sheet.frameW, row * sheet.frameH, sheet.frameW, sheet.frameH,
    x, y, w || sheet.frameW, h || sheet.frameH
  );
}

function getAnimFrame(totalFrames, speed) {
  return Math.floor(performance.now() / speed) % totalFrames;
}

// ═══════════════════════════════════════════════════════════════
// TERRAIN OVERLAY — Grass patches and water zones
// ═══════════════════════════════════════════════════════════════

let terrainPatches = null;
let waterZones = null;

function initTerrainPatches() {
  if (typeof W === 'undefined' || W <= 0) return;
  terrainPatches = [];
  waterZones = [];

  let seed = 42;
  function seededRand() { seed = (seed * 16807 + 0) % 2147483647; return seed / 2147483647; }

  // Sparser grass — ~1 per 600×600 area
  const grassCount = Math.floor((W * H) / (600 * 600));
  const tileSize = 72;
  for (let i = 0; i < grassCount; i++) {
    const px = seededRand() * (W - tileSize * 3);
    const py = seededRand() * (H - tileSize * 3);
    const variant = Math.floor(seededRand() * 4);
    const rowVar = Math.floor(seededRand() * 2);
    const clusterSize = 1 + Math.floor(seededRand() * 2); // 1-2 tiles per patch (sparser)
    for (let c = 0; c < clusterSize; c++) {
      const ox = c * tileSize * 0.85 + seededRand() * 20 - 10;
      const oy = seededRand() * tileSize * 0.4 - tileSize * 0.2;
      terrainPatches.push({
        x: px + ox, y: py + oy,
        col: (variant + c) % 4,
        row: rowVar,
        size: tileSize + seededRand() * 16 - 8,
        alpha: 0.18 + seededRand() * 0.12  // more subtle
      });
    }
  }

  // Water — smaller pools near center, not a full river
  const waterTileSize = 56;
  // Center pool
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      waterZones.push({
        x: W * 0.5 + dx * waterTileSize * 0.85 - waterTileSize/2,
        y: H * 0.5 + dy * waterTileSize * 0.85 - waterTileSize/2,
        size: waterTileSize,
        alpha: 0.3 + (dx === 0 && dy === 0 ? 0.1 : 0)
      });
    }
  }
  // Small side pools
  const poolPositions = [[0.25, 0.3], [0.75, 0.3], [0.25, 0.7], [0.75, 0.7]];
  for (const [px, py] of poolPositions) {
    for (let i = 0; i < 3; i++) {
      waterZones.push({
        x: W * px + (seededRand() - 0.5) * waterTileSize * 1.5,
        y: H * py + (seededRand() - 0.5) * waterTileSize * 1.5,
        size: waterTileSize * (0.7 + seededRand() * 0.4),
        alpha: 0.2 + seededRand() * 0.1
      });
    }
  }
}

function drawTerrainGrass(ctx, camX, camY) {
  const sheet = SPRITE_SHEETS.grassTiles;
  if (!sheet.loaded || !terrainPatches) return;

  const _origAlphaG = ctx.globalAlpha;
  for (const p of terrainPatches) {
    if (p.x + p.size < camX || p.x > camX + VW ||
        p.y + p.size < camY || p.y > camY + VH) continue;

    ctx.globalAlpha = p.alpha;
    const sway = Math.sin(performance.now() * 0.0006 + p.x * 0.008) * 1.5;
    drawSpriteFrame(ctx, sheet, p.col, p.row, p.x + sway, p.y, p.size, p.size);
  }
  ctx.globalAlpha = _origAlphaG;
}

function drawTerrainWater(ctx, camX, camY) {
  const sheet = SPRITE_SHEETS.waterAnim;
  if (!sheet.loaded || !waterZones) return;

  const totalFrames = sheet.cols * sheet.rows;
  const frameIdx = getAnimFrame(totalFrames, 220);
  const col = frameIdx % sheet.cols;
  const row = Math.floor(frameIdx / sheet.cols);

  const _origAlphaW = ctx.globalAlpha;
  for (const wz of waterZones) {
    if (wz.x + wz.size < camX || wz.x > camX + VW ||
        wz.y + wz.size < camY || wz.y > camY + VH) continue;

    ctx.globalAlpha = wz.alpha;
    drawSpriteFrame(ctx, sheet, col, row, wz.x, wz.y, wz.size, wz.size);
  }
  ctx.globalAlpha = _origAlphaW;
}

// ═══════════════════════════════════════════════════════════════
// BLOOD SPLATTER VFX — Spawns on hit, fades over time
// ═══════════════════════════════════════════════════════════════
const bloodSplatters = [];
const MAX_BLOOD_SPLATTERS = 40;

function addBloodSplatter(worldX, worldY) {
  const sheetKey = Math.random() < 0.5 ? 'bloodSplat1' : 'bloodSplat2';
  const sheet = SPRITE_SHEETS[sheetKey];
  const variant = Math.floor(Math.random() * sheet.cols);
  const size = 24 + Math.random() * 20;
  const rotation = Math.random() * Math.PI * 2;

  bloodSplatters.push({
    x: worldX - size / 2 + (Math.random() - 0.5) * 12,
    y: worldY - size / 2 + (Math.random() - 0.5) * 12,
    sheetKey, col: variant, row: 0,
    size, rotation,
    life: 1.0,
    decay: 0.15 + Math.random() * 0.1, // faster fade
    alpha: 0.6 + Math.random() * 0.2
  });

  if (bloodSplatters.length > MAX_BLOOD_SPLATTERS) {
    bloodSplatters.splice(0, bloodSplatters.length - MAX_BLOOD_SPLATTERS);
  }
}

function updateBloodSplatters(dt) {
  for (let i = bloodSplatters.length - 1; i >= 0; i--) {
    bloodSplatters[i].life -= bloodSplatters[i].decay * dt;
    if (bloodSplatters[i].life <= 0) bloodSplatters.splice(i, 1);
  }
}

function drawBloodSplatters(ctx, camX, camY) {
  for (const b of bloodSplatters) {
    const sheet = SPRITE_SHEETS[b.sheetKey];
    if (!sheet || !sheet.loaded) continue;
    if (b.x + b.size < camX || b.x > camX + VW ||
        b.y + b.size < camY || b.y > camY + VH) continue;

    ctx.save();
    ctx.globalAlpha = b.life * b.alpha;
    ctx.translate(b.x + b.size / 2, b.y + b.size / 2);
    ctx.rotate(b.rotation);
    drawSpriteFrame(ctx, sheet, b.col, b.row, -b.size / 2, -b.size / 2, b.size, b.size);
    ctx.restore();
  }
}

// ═══════════════════════════════════════════════════════════════
// SCROLL ITEM SPRITES
// ═══════════════════════════════════════════════════════════════

const SCROLL_VARIANTS = {
  healthPot: 0, dmgBoost: 1, speedBoost: 2, invulnPot: 3,
  grenade: 0, smokeBomb: 1, wardStone: 2, manaPot: 3,
  adrenaline: 0, teleScroll: 3
};

function drawScrollItem(ctx, x, y, consumableKey, size) {
  const sheet = SPRITE_SHEETS.scrollItem;
  if (!sheet.loaded) return false;
  const variant = SCROLL_VARIANTS[consumableKey] || 0;
  const sz = size || 32;
  const floatY = Math.sin(performance.now() * 0.003 + x * 0.05) * 4;
  ctx.save();
  ctx.shadowColor = '#00f5ff';
  ctx.shadowBlur = 6 + Math.sin(performance.now() * 0.004) * 3;
  drawSpriteFrame(ctx, sheet, variant, 0, x - sz / 2, y - sz / 2 + floatY, sz, sz);
  ctx.restore();
  return true;
}

// ═══════════════════════════════════════════════════════════════
// TILE LAYER RENDERER
// Static (non-animated) layers are pre-rendered to an OffscreenCanvas in
// an idle callback between frames — no render-loop spike.  While a cache
// is building (or stale after camera drift) tiles draw individually as
// fallback so there is never a blank frame.
// ═══════════════════════════════════════════════════════════════
const _TL_MARGIN = 600; // world-px around viewport — smaller = faster builds, camera needs 300px to trigger rebuild
const _tlCaches = new Map(); // layer → { canvas, originX, originY, cW, cH, gen }
const _tlPending = new Set(); // layers with a build already scheduled
let _tlGen = 0; // incremented on invalidate so stale idle callbacks discard

// Live camera reference updated each frame so idle callbacks use fresh coords
let _tlLiveCamX = 0, _tlLiveCamY = 0, _tlLiveViewW = 0, _tlLiveViewH = 0;

function invalidateTileCaches() { _tlGen++; _tlCaches.clear(); _tlPending.clear(); }

function _buildLayerAsync(layer, gen) {
  const _bt0 = performance.now();
  // Use live camera coords at execution time, not schedule time
  const camX = _tlLiveCamX, camY = _tlLiveCamY;
  const viewW = _tlLiveViewW, viewH = _tlLiveViewH;
  const cW = Math.ceil(viewW + _TL_MARGIN * 2);
  const cH = Math.ceil(viewH + _TL_MARGIN * 2);
  const originX = Math.floor(camX - _TL_MARGIN);
  const originY = Math.floor(camY - _TL_MARGIN);
  const prev = _tlCaches.get(layer);
  const off = (prev && prev.canvas.width === cW && prev.canvas.height === cH)
    ? prev.canvas : new OffscreenCanvas(cW, cH);
  const c = off.getContext('2d');
  c.clearRect(0, 0, cW, cH);
  const opacity = layer.opacity !== undefined ? layer.opacity : 1;
  if (opacity < 1) c.globalAlpha = opacity;
  const x1 = originX, x2 = originX + cW, y1 = originY, y2 = originY + cH;
  const _sheetLookup = {}; // cache 'map_'+name lookups so no per-tile string concat
  for (const tile of layer.tiles) {
    if (tile.x + tile.w <= x1 || tile.x >= x2 || tile.y + tile.h <= y1 || tile.y >= y2) continue;
    let sheet = _sheetLookup[tile.sheetName];
    if (sheet === undefined) {
      const s = SPRITE_SHEETS['map_' + tile.sheetName];
      sheet = _sheetLookup[tile.sheetName] = (s && s.loaded) ? s : null;
    }
    if (!sheet) continue;
    c.drawImage(sheet.img, tile.col * sheet.frameW, tile.row * sheet.frameH, sheet.frameW, sheet.frameH,
                tile.x - originX, tile.y - originY, tile.w, tile.h);
  }
  // Only store if nothing invalidated us while we were building
  if (gen === _tlGen) {
    _tlCaches.set(layer, { canvas: off, originX, originY, cW, cH, gen });
  }
  if (typeof _dbgT !== 'undefined') _dbgT.build = performance.now() - _bt0;
}

function _scheduleBuild(layer) {
  if (_tlPending.has(layer)) return; // build already in flight
  _tlPending.add(layer);
  const gen = _tlGen;
  const runBuild = () => { _tlPending.delete(layer); _buildLayerAsync(layer, gen); };
  if (typeof requestIdleCallback !== 'undefined') {
    // timeout:100 — fire during idle if possible, force after 100ms at latest
    requestIdleCallback(runBuild, { timeout: 100 });
  } else {
    setTimeout(runBuild, 0);
  }
}

function _drawTilesDirect(ctx, layer, camX, camY, viewW, viewH) {
  const opacity = layer.opacity !== undefined ? layer.opacity : 1;
  ctx.save();
  if (opacity < 1) ctx.globalAlpha = opacity;
  const animFrameCache = {};
  for (const tile of layer.tiles) {
    if (tile.x + tile.w < camX || tile.x > camX + viewW ||
        tile.y + tile.h < camY || tile.y > camY + viewH) continue;
    const sheet = SPRITE_SHEETS['map_' + tile.sheetName];
    if (!sheet || !sheet.loaded) continue;
    let col = tile.col, row = tile.row;
    if (layer.animated) {
      const frameCount = Math.max(1, layer.animFrameCount || 4);
      const fps = layer.fps || 8;
      const vertical = layer.animDir === 'v';
      if (!('_f' in animFrameCache)) animFrameCache._f = getAnimFrame(frameCount, 1000 / fps);
      let offset = animFrameCache._f;
      if (layer.ripple) {
        const gx = Math.round(tile.x / tile.w);
        const gy = Math.round(tile.y / tile.h);
        offset = (offset + (gx + gy)) % frameCount;
      }
      if (layer.animAbsolute) {
        const startIdx = (layer.animAbsRow || 0) * sheet.cols + (layer.animAbsCol || 0);
        const frameIdx = startIdx + offset;
        col = frameIdx % sheet.cols;
        row = Math.floor(frameIdx / sheet.cols);
      } else {
        if (vertical) row = (tile.row + offset) % sheet.rows;
        else col = (tile.col + offset) % sheet.cols;
      }
    }
    drawSpriteFrame(ctx, sheet, col, row, tile.x, tile.y, tile.w, tile.h);
  }
  ctx.restore();
}

function drawTileLayers(ctx, camX, camY, viewW, viewH) {
  if (typeof gameTileLayers === 'undefined' || !gameTileLayers.length) return;
  // Keep live coords fresh so idle callbacks always build around current camera
  _tlLiveCamX = camX; _tlLiveCamY = camY;
  _tlLiveViewW = viewW; _tlLiveViewH = viewH;
  const safe = _TL_MARGIN * 0.5;
  for (const layer of gameTileLayers) {
    if (!layer.visible) continue;
    const opacity = layer.opacity !== undefined ? layer.opacity : 1;
    if (opacity <= 0) continue;

    if (layer.animated) {
      _drawTilesDirect(ctx, layer, camX, camY, viewW, viewH);
      continue;
    }

    // Static layer — use async cache; fall back to direct draw if not ready
    const e = _tlCaches.get(layer);
    const inBounds = e && e.gen === _tlGen &&
      camX >= e.originX + safe && camX + viewW <= e.originX + e.cW - safe &&
      camY >= e.originY + safe && camY + viewH <= e.originY + e.cH - safe;

    if (e && e.canvas) {
      // Draw cached version (may be slightly stale — still covers viewport)
      ctx.save();
      if (opacity < 1) ctx.globalAlpha = opacity;
      ctx.drawImage(e.canvas, e.originX, e.originY);
      ctx.restore();
      // Schedule rebuild only when camera approaches the cache edge
      if (!inBounds) _scheduleBuild(layer);
    } else {
      // No cache yet — draw directly and kick off first build
      _drawTilesDirect(ctx, layer, camX, camY, viewW, viewH);
      if (!e) _scheduleBuild(layer);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// GLOBAL SPRITE PRE-LOADER
// Fetches _assignments.json + _sheets.json on page load so entity
// sprites work in offline mode and all game modes without waiting
// for a matchStart message.
// ═══════════════════════════════════════════════════════════════
let _globalSpriteAssignments = {};

(function _initGlobalSprites() {
  Promise.all([
    fetch('/api/sprite-assignments').then(r => r.ok ? r.json() : {}),
    fetch('/api/sprite-sheets').then(r => r.ok ? r.json() : [])
  ]).then(([assigns, sheets]) => {
    if (assigns && typeof assigns === 'object') _globalSpriteAssignments = assigns;
    if (Array.isArray(sheets) && sheets.length) loadMapSprites(sheets);
  }).catch(() => {});
})();

// ═══════════════════════════════════════════════════════════════
// ENTITY SPRITE SYSTEM
// Renderer calls these to draw mobs/classes using assigned sprites.
// Falls back gracefully if no sprite is assigned or not loaded yet.
// ═══════════════════════════════════════════════════════════════

// Returns the loaded sheet for an assignment key (e.g. "mob_wraith", "class_gunner")
// state: optional — checks for a per-state sheetName override first.
// or null if not assigned / not loaded.
// Cache: sheetName → sheet object. Rebuilt when sheets change.
const _sheetByName = new Map();
let _sheetByNameDirty = true;
function _rebuildSheetByName() {
  _sheetByName.clear();
  for (const key in SPRITE_SHEETS) {
    const s = SPRITE_SHEETS[key];
    if (s.loaded) _sheetByName.set(s.name, s);
  }
  _sheetByNameDirty = false;
}
function markSheetCacheDirty() { _sheetByNameDirty = true; invalidateTileCaches(); }

function getEntitySheet(assignKey, state) {
  if (_sheetByNameDirty) _rebuildSheetByName();
  const mapAssign = (typeof mapSpriteAssignments !== 'undefined' && Object.keys(mapSpriteAssignments).length)
    ? mapSpriteAssignments : null;
  const assignments = mapAssign || _globalSpriteAssignments;
  const assign = assignments[assignKey];
  if (!assign || !assign.sheetName) return null;
  let sheetName = assign.sheetName;
  if (state && assign.states && assign.states[state] && assign.states[state].sheetName) {
    sheetName = assign.states[state].sheetName;
  }
  const s = _sheetByName.get(sheetName);
  return s ? { sheet: s, assign } : null;
}

// ── DIRECTION HELPERS ────────────────────────────────────────────
// Standard MOBA 4-way: row offset 0=down 1=left 2=right 3=up
function angleTo4Dir(angle) {
  const a = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (a < Math.PI / 4 || a >= 7 * Math.PI / 4) return 2; // right
  if (a < 3 * Math.PI / 4) return 0;                      // down
  if (a < 5 * Math.PI / 4) return 1;                      // left
  return 3;                                                // up
}
// 8-way: 0=down 1=down-left 2=left 3=up-left 4=up 5=up-right 6=right 7=down-right
function angleTo8Dir(angle) {
  const a = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return Math.round(a / (Math.PI / 4)) % 8;
}

// Gets the current animation frame as {col, row}.
// Supports two formats:
//   Flat:     state has startFrame/endFrame — linearises across the sheet
//   Row-based: state has rowStart + frameCount — one row per animation, dirOffset shifts row
function getEntityAnimFrameRC(assign, state, dirOffset, sheetCols) {
  const cols = sheetCols || 1;
  let fps   = assign.fps   || 8;
  let start = assign.startFrame || 0;
  let end   = assign.endFrame   || 0;

  if (state && assign.states && assign.states[state]) {
    const s = assign.states[state];
    fps = s.fps !== undefined ? s.fps : fps;

    if (s.rowStart !== undefined) {
      // Row-based format
      const frameCount = s.frameCount || 4;
      const col = Math.floor(performance.now() / (1000 / fps)) % frameCount;
      const dirRows = (s.directional && dirOffset) ? dirOffset : 0;
      return { col, row: s.rowStart + dirRows };
    }
    // Flat format
    start = s.startFrame !== undefined ? s.startFrame : start;
    end   = s.endFrame   !== undefined ? s.endFrame   : end;
  }

  const count = Math.max(1, end - start + 1);
  const frame = start + Math.floor(performance.now() / (1000 / fps)) % count;
  return { col: frame % cols, row: Math.floor(frame / cols) };
}

// Legacy: returns flat frame index (kept for any external callers)
function getEntityAnimFrame(assign, state) {
  let fps   = assign.fps   || 8;
  let start = assign.startFrame || 0;
  let end   = assign.endFrame   || 0;
  if (state && assign.states && assign.states[state]) {
    const s = assign.states[state];
    fps   = s.fps   !== undefined ? s.fps   : fps;
    start = s.startFrame !== undefined ? s.startFrame : start;
    end   = s.endFrame   !== undefined ? s.endFrame   : end;
  }
  const count = Math.max(1, end - start + 1);
  return start + Math.floor(performance.now() / (1000 / fps)) % count;
}

// Draws an entity sprite centred on (0,0) in the current ctx transform.
// size = diameter. state = animation state string. angle = facing angle (radians).
// Returns true if drawn, false if no sprite assigned.
function drawEntitySprite(ctx, assignKey, size, state, angle) {
  const result = getEntitySheet(assignKey, state);
  if (!result) return false;
  const { sheet, assign } = result;

  let dirOffset = 0;
  if (angle !== undefined) {
    if (assign.dirMode === '4way') dirOffset = angleTo4Dir(angle);
    else if (assign.dirMode === '8way') dirOffset = angleTo8Dir(angle);
  }

  const { col, row } = getEntityAnimFrameRC(assign, state, dirOffset, sheet.cols);
  const half = size / 2;
  drawSpriteFrame(ctx, sheet, col, row, -half, -half, size, size);
  return true;
}

// ── ENTITY ANIMATION PRESETS ─────────────────────────────────────
// Ready-made animation definitions for a standard MOBA 4-directional
// pixel art sheet (rows ordered: down / left / right / up per state).
// Layout assumes: 8 columns wide.  rowStart counts from 0.
// Load via "PRESET" button in the editor sprite assignment panel.
const ENTITY_ANIM_PRESETS = {
  class_gunner: {
    dirMode: '4way',
    states: {
      idle:    { rowStart:0,  frameCount:4, fps:6,  directional:true },
      walk:    { rowStart:4,  frameCount:6, fps:10, directional:true },
      attack:  { rowStart:8,  frameCount:5, fps:12, directional:true },
      special: { rowStart:12, frameCount:6, fps:8,  directional:true },
      dead:    { rowStart:16, frameCount:6, fps:6,  directional:false }
    }
  },
  class_assassin: {
    dirMode: '4way',
    states: {
      idle:    { rowStart:0,  frameCount:4, fps:6,  directional:true },
      walk:    { rowStart:4,  frameCount:6, fps:12, directional:true },
      attack:  { rowStart:8,  frameCount:5, fps:16, directional:true },
      special: { rowStart:12, frameCount:8, fps:14, directional:true },
      dead:    { rowStart:16, frameCount:5, fps:6,  directional:false }
    }
  },
  class_mage: {
    dirMode: '4way',
    states: {
      idle:    { rowStart:0,  frameCount:6, fps:5,  directional:true },
      walk:    { rowStart:4,  frameCount:4, fps:6,  directional:true },
      attack:  { rowStart:8,  frameCount:6, fps:10, directional:true },
      special: { rowStart:12, frameCount:10,fps:12, directional:true },
      dead:    { rowStart:16, frameCount:7, fps:5,  directional:false }
    }
  },
  class_tank: {
    dirMode: '4way',
    states: {
      idle:    { rowStart:0,  frameCount:4, fps:5,  directional:true },
      walk:    { rowStart:4,  frameCount:6, fps:7,  directional:true },
      attack:  { rowStart:8,  frameCount:5, fps:8,  directional:true },
      special: { rowStart:12, frameCount:8, fps:8,  directional:true },
      dead:    { rowStart:16, frameCount:6, fps:5,  directional:false }
    }
  },
  class_necro: {
    dirMode: '4way',
    states: {
      idle:    { rowStart:0,  frameCount:6, fps:6,  directional:true },
      walk:    { rowStart:4,  frameCount:4, fps:7,  directional:true },
      attack:  { rowStart:8,  frameCount:6, fps:9,  directional:true },
      special: { rowStart:12, frameCount:10,fps:10, directional:true },
      dead:    { rowStart:16, frameCount:8, fps:5,  directional:false }
    }
  },
  class_ranger: {
    dirMode: '4way',
    states: {
      idle:    { rowStart:0,  frameCount:4, fps:6,  directional:true },
      walk:    { rowStart:4,  frameCount:6, fps:10, directional:true },
      attack:  { rowStart:8,  frameCount:8, fps:14, directional:true },
      special: { rowStart:12, frameCount:6, fps:12, directional:true },
      dead:    { rowStart:16, frameCount:5, fps:6,  directional:false }
    }
  },
  mob_wolves: {
    dirMode: '4way',
    states: {
      idle:    { rowStart:0, frameCount:4, fps:6,  directional:true },
      walk:    { rowStart:4, frameCount:6, fps:12, directional:true },
      attack:  { rowStart:8, frameCount:5, fps:14, directional:true },
      dead:    { rowStart:12,frameCount:5, fps:6,  directional:false }
    }
  },
  mob_golem: {
    dirMode: '4way',
    states: {
      idle:    { rowStart:0, frameCount:3, fps:4, directional:true },
      walk:    { rowStart:4, frameCount:6, fps:6, directional:true },
      attack:  { rowStart:8, frameCount:5, fps:6, directional:true },
      dead:    { rowStart:12,frameCount:8, fps:5, directional:false }
    }
  },
  mob_wraith: {
    dirMode: '4way',
    states: {
      idle:    { rowStart:0, frameCount:6, fps:8,  directional:true },
      walk:    { rowStart:4, frameCount:4, fps:8,  directional:true },
      attack:  { rowStart:8, frameCount:5, fps:10, directional:true },
      dead:    { rowStart:12,frameCount:8, fps:6,  directional:false }
    }
  },
  mob_dragon: {
    dirMode: '4way',
    states: {
      idle:    { rowStart:0, frameCount:6, fps:6, directional:true },
      walk:    { rowStart:4, frameCount:6, fps:8, directional:true },
      attack:  { rowStart:8, frameCount:8, fps:8, directional:true },
      dead:    { rowStart:12,frameCount:8, fps:5, directional:false }
    }
  },
  mob_sentinel: {
    dirMode: '4way',
    states: {
      idle:    { rowStart:0, frameCount:5, fps:6,  directional:true },
      walk:    { rowStart:4, frameCount:6, fps:8,  directional:true },
      attack:  { rowStart:8, frameCount:6, fps:10, directional:true },
      dead:    { rowStart:12,frameCount:7, fps:5,  directional:false }
    }
  },
  mob_berserker: {
    dirMode: '4way',
    states: {
      idle:    { rowStart:0, frameCount:4, fps:7,  directional:true },
      walk:    { rowStart:4, frameCount:6, fps:12, directional:true },
      attack:  { rowStart:8, frameCount:5, fps:16, directional:true },
      dead:    { rowStart:12,frameCount:6, fps:6,  directional:false }
    }
  },
  mob_lich: {
    dirMode: '4way',
    states: {
      idle:    { rowStart:0, frameCount:8, fps:6, directional:true },
      walk:    { rowStart:4, frameCount:4, fps:5, directional:true },
      attack:  { rowStart:8, frameCount:7, fps:9, directional:true },
      dead:    { rowStart:12,frameCount:9, fps:5, directional:false }
    }
  }
};

// ═══════════════════════════════════════════════════════════════
// OBJECT LAYER RENDERER
// Draws PlacedObjects (atlas regions or tile-mode cells) from
// objectLayers saved in the map.  Called from renderer.js after
// drawTileLayers.
// ═══════════════════════════════════════════════════════════════
function drawObjectLayers(ctx, camX, camY, viewW, viewH) {
  if (!gameObjectLayers || !gameObjectLayers.length) return;
  for (const layer of gameObjectLayers) {
    if (!layer.visible) continue;
    const opacity = layer.opacity !== undefined ? layer.opacity : 1;
    if (opacity <= 0) continue;
    ctx.save();
    if (opacity < 1) ctx.globalAlpha = opacity;
    for (const obj of layer.objects || []) {
      if (obj.x + obj.w < camX || obj.x > camX + viewW ||
          obj.y + obj.h < camY || obj.y > camY + viewH) continue;
      const sheetKey = 'map_' + obj.sheetName;
      const sheet = SPRITE_SHEETS[sheetKey];
      if (!sheet || !sheet.loaded) continue;
      let sx = 0, sy = 0, sw = sheet.img.width, sh = sheet.img.height;
      if (obj.regionId && sheet.regions) {
        const r = sheet.regions.find(rg => rg.id === obj.regionId);
        if (r) { sx = r.x; sy = r.y; sw = r.w; sh = r.h; }
      } else if (obj.col !== undefined && obj.row !== undefined) {
        sx = obj.col * sheet.frameW; sy = obj.row * sheet.frameH;
        sw = sheet.frameW; sh = sheet.frameH;
      }
      ctx.drawImage(sheet.img, sx, sy, sw, sh, obj.x, obj.y, obj.w, obj.h);
    }
    ctx.restore();
  }
}