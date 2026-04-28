// ═══════════════════════════════════════════════════════════════
// SPATIAL-HASH.JS — O(1) neighbourhood queries for collision/AI
// Cell size 200px. One global instance rebuilt each frame by
// the caller that needs it (updBullets, updMinions, etc.).
// Usage:
//   shClear();
//   shInsert(x, y, radius, obj); // call for every entity you want queryable
//   shQuery(x, y, searchRadius, outArray); // fills outArray (no duplicates)
// ═══════════════════════════════════════════════════════════════

const _SH_CELL = 200;
const _shCells  = new Map();  // int32 key → entity array
const _shDirty  = [];         // keys written this frame (to avoid full Map.clear)
let   _shStamp  = 0;          // monotone counter — marks visited objects per query

function shClear() {
  for(let i=0;i<_shDirty.length;i++){
    const arr = _shCells.get(_shDirty[i]);
    if(arr) arr.length = 0;
  }
  _shDirty.length = 0;
}

function shInsert(x, y, r, obj) {
  const cs = _SH_CELL;
  const x0 = (x-r)/cs|0, x1 = (x+r)/cs|0;
  const y0 = (y-r)/cs|0, y1 = (y+r)/cs|0;
  for(let cx=x0;cx<=x1;cx++){
    for(let cy=y0;cy<=y1;cy++){
      const k = (cx & 0x7FFF) | ((cy & 0x7FFF) << 15);
      let cell = _shCells.get(k);
      if(!cell){ cell=[]; _shCells.set(k,cell); }
      if(cell.length===0) _shDirty.push(k);
      cell.push(obj);
    }
  }
}

function shQuery(x, y, r, out) {
  const cs = _SH_CELL;
  const x0 = (x-r)/cs|0, x1 = (x+r)/cs|0;
  const y0 = (y-r)/cs|0, y1 = (y+r)/cs|0;
  const stamp = ++_shStamp;
  for(let cx=x0;cx<=x1;cx++){
    for(let cy=y0;cy<=y1;cy++){
      const k = (cx & 0x7FFF) | ((cy & 0x7FFF) << 15);
      const cell = _shCells.get(k);
      if(!cell) continue;
      for(let i=0;i<cell.length;i++){
        const obj = cell[i];
        if(obj._shStamp!==stamp){ obj._shStamp=stamp; out.push(obj); }
      }
    }
  }
}
