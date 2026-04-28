// ═══════════════════════════════════════════════════════════════
// SPRITE-GEN.JS — Procedural pixel-art sprite generator
// Generates all class & mob sprite sheets once at startup.
// Sheets live in OffscreenCanvas — zero per-frame allocation.
// Layout: 8 cols × 17 rows × 48px per cell (matches ENTITY_ANIM_PRESETS)
//   rows 0-3:  idle  (4 frames, 4 dirs)
//   rows 4-7:  walk  (6 frames, 4 dirs — uses first 6 cols)
//   rows 8-11: attack(5 frames, 4 dirs)
//  rows 12-15: special(6 frames, 4 dirs)
//   row  16:   dead  (6 frames, single pass)
// ═══════════════════════════════════════════════════════════════

const _SG_F    = 48;   // frame size px
const _SG_COLS = 8;
const _SG_ROWS = 17;

// Direction vectors: [down, left, right, up]
const _DIR_DX = [0, -1,  1,  0];
const _DIR_DY = [1,  0,  0, -1];

// ── LOW-LEVEL DRAW HELPERS ───────────────────────────────────────
function _circ(c, x, y, r, fill, stroke, sw) {
  c.beginPath(); c.arc(x, y, r, 0, Math.PI*2);
  if (fill)   { c.fillStyle   = fill;   c.fill();   }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = sw||1.5; c.stroke(); }
}
function _oval(c, x, y, rx, ry, fill, rot) {
  c.save(); c.translate(x,y); if (rot) c.rotate(rot);
  c.beginPath(); c.ellipse(0,0,rx,ry,0,0,Math.PI*2);
  c.fillStyle = fill; c.fill(); c.restore();
}
function _rect(c, x, y, w, h, fill, r) {
  if (r) { c.beginPath(); c.roundRect(x,y,w,h,r); c.fillStyle=fill; c.fill(); }
  else   { c.fillStyle=fill; c.fillRect(x,y,w,h); }
}
function _line(c, x1,y1,x2,y2,color,w) {
  c.strokeStyle=color; c.lineWidth=w||2;
  c.beginPath(); c.moveTo(x1,y1); c.lineTo(x2,y2); c.stroke();
}
function _shadow(c, cx,cy,rw,rh) {
  c.save(); c.globalAlpha=0.28;
  _oval(c,cx,cy+rh*0.75,rw*0.55,rh*0.18,'#000');
  c.restore();
}
function _glow(c, cx,cy,r,color,a) {
  const g=c.createRadialGradient(cx,cy,0,cx,cy,r);
  g.addColorStop(0,color+(Math.round((a||0.4)*255).toString(16).padStart(2,'0')));
  g.addColorStop(1,color+'00');
  c.fillStyle=g; c.beginPath(); c.arc(cx,cy,r,0,Math.PI*2); c.fill();
}

// ── ANIMATION OFFSET HELPERS ─────────────────────────────────────
// Returns {dy} for idle breathing bob (4 frames)
function _idleBob(frame) { return Math.sin(frame * Math.PI/2) * 1.2; }
// Returns {dx,dy} sway for walk cycle (6 frames)
function _walkSway(frame) {
  const t = frame / 6 * Math.PI * 2;
  return { dx: Math.sin(t)*1.5, dy: Math.abs(Math.sin(t))*1.2 - 0.6 };
}
// Returns weapon extension factor for attack frames (0→1→0 over 5 frames)
function _atkExt(frame) { return [0.1,0.5,1.0,0.7,0.2][frame]||0; }
// Pulse factor for special frames
function _spcPulse(frame) { return 0.7 + Math.sin(frame/5*Math.PI)*0.6; }

// ── ENTITY VISUAL PROFILES ───────────────────────────────────────
const _PROFILES = {
  // ── CLASSES ──
  class_gunner: {
    body:'#7a6040', bodyLight:'#c4a35a', bodyR:9, headColor:'#c4a35a',
    headR:5, accentColor:'#ff8800', outlineColor:'#3a2010',
    weapon:'gun', armorColor:'#5a4030',
    extra(c, cx,cy, dir, frame, state) {
      // Helmet visor strip
      const dx=_DIR_DX[dir], dy=_DIR_DY[dir];
      const hx=cx+dx*5.5, hy=cy+dy*5.5;
      _rect(c,hx-4,hy-1.5,8,3,'#ff8800',1);
    }
  },
  class_assassin: {
    body:'#2d1b4e', bodyLight:'#7c5cbf', bodyR:8, headColor:'#4a2d7a',
    headR:4.5, accentColor:'#e040fb', outlineColor:'#1a0a2e',
    weapon:'daggers', armorColor:'#2d1b4e',
    extra(c, cx,cy, dir, frame, state) {
      // Glowing eyes
      const dx=_DIR_DX[dir], dy=_DIR_DY[dir];
      const hx=cx+dx*5, hy=cy+dy*5;
      c.save(); c.shadowColor='#e040fb'; c.shadowBlur=6;
      _circ(c,hx+dy*2.5,hy-dx*2.5,1.5,'#e040fb');
      _circ(c,hx-dy*2.5,hy+dx*2.5,1.5,'#e040fb');
      c.restore();
    }
  },
  class_mage: {
    body:'#1e1060', bodyLight:'#7c4dff', bodyR:10, headColor:'#5e35b1',
    headR:5.5, accentColor:'#cc44ff', outlineColor:'#0d0040',
    weapon:'staff', armorColor:'#311b92',
    extra(c, cx,cy, dir, frame, state) {
      // Floating orb effect
      const t = performance.now ? performance.now()*0.002 : 0;
      c.save(); c.globalAlpha=0.5;
      _glow(c,cx,cy,14,'#cc44ff',0.25);
      c.restore();
    }
  },
  class_tank: {
    body:'#1a3a5c', bodyLight:'#4488bb', bodyR:12, headColor:'#2a5080',
    headR:6, accentColor:'#00ff88', outlineColor:'#0a1a2a',
    weapon:'shield', armorColor:'#1a3a5c',
    extra(c, cx,cy, dir, frame, state) {
      // Chest emblem
      _circ(c,cx,cy,3,'#00ff8844','#00ff88',1);
    }
  },
  class_necro: {
    body:'#1b2a1b', bodyLight:'#4a7a4a', bodyR:9, headColor:'#2a4a2a',
    headR:5, accentColor:'#88cc44', outlineColor:'#0a150a',
    weapon:'bone_staff', armorColor:'#1b2a1b',
    extra(c, cx,cy, dir, frame, state) {
      // Skull mark on chest
      c.save(); c.globalAlpha=0.7;
      _circ(c,cx,cy+1,3,'#c8e6c9');
      _circ(c,cx-1.2,cy,0.8,'#1b2a1b'); _circ(c,cx+1.2,cy,0.8,'#1b2a1b');
      c.restore();
    }
  },
  class_ranger: {
    body:'#2e4a1a', bodyLight:'#7cb342', bodyR:8.5, headColor:'#558b2f',
    headR:5, accentColor:'#ff8833', outlineColor:'#1a2a0a',
    weapon:'bow', armorColor:'#33601a',
    extra(c, cx,cy, dir, frame, state) {
      // Quiver hint on back side
      const dx=_DIR_DX[dir], dy=_DIR_DY[dir];
      c.save(); c.globalAlpha=0.7;
      _rect(c,cx-dx*8-1.5,cy-dy*8-4,3,8,'#8d6e63',1);
      c.restore();
    }
  },

  // ── MOBS ──
  mob_wolves: {
    body:'#757575', bodyLight:'#bdbdbd', bodyR:9, headColor:'#9e9e9e',
    headR:4.5, accentColor:'#ffcc00', outlineColor:'#424242',
    weapon:'teeth',
    extra(c, cx,cy, dir, frame, state) {
      // Ears
      const dx=_DIR_DX[dir], dy=_DIR_DY[dir];
      const hx=cx+dx*4.5, hy=cy+dy*4.5;
      _circ(c,hx+dy*3,hy-dx*3,2.5,'#9e9e9e','#616161',1);
      _circ(c,hx-dy*3,hy+dx*3,2.5,'#9e9e9e','#616161',1);
      // Yellow eyes
      c.save(); c.shadowColor='#ffcc00'; c.shadowBlur=4;
      _circ(c,hx+dy*2,hy-dx*2,1.4,'#ffcc00');
      _circ(c,hx-dy*2,hy+dx*2,1.4,'#ffcc00');
      c.restore();
    }
  },
  mob_golems: {
    body:'#5d4037', bodyLight:'#8d6e63', bodyR:14, headColor:'#6d4c41',
    headR:6, accentColor:'#ff6d00', outlineColor:'#3e2723',
    weapon:'fist',
    extra(c, cx,cy, dir, frame, state) {
      // Glowing lava core
      const pulse = 0.7 + Math.sin((frame||0)*0.8)*0.3;
      c.save(); c.globalAlpha=pulse;
      _glow(c,cx,cy,8,'#ff6d00',0.8);
      _circ(c,cx,cy,4,'#ffcc00');
      c.restore();
      // Cracks
      c.save(); c.globalAlpha=0.5; c.strokeStyle='#3e2723'; c.lineWidth=1;
      c.beginPath(); c.moveTo(cx-4,cy-6); c.lineTo(cx-1,cy); c.lineTo(cx-5,cy+5); c.stroke();
      c.beginPath(); c.moveTo(cx+3,cy-5); c.lineTo(cx+5,cy+1); c.stroke();
      c.restore();
    }
  },
  mob_wraiths: {
    body:'#4a148c', bodyLight:'#7b1fa2', bodyR:9, headColor:'#6a1b9a',
    headR:5, accentColor:'#ce93d8', outlineColor:'#1a0033',
    weapon:'none',
    extra(c, cx,cy, dir, frame, state) {
      // Ethereal wisps
      c.save(); c.globalAlpha = 0.4 + Math.sin((frame||0)*0.6)*0.2;
      _glow(c,cx,cy,15,'#9c27b0',0.35);
      c.restore();
      // White glowing eyes
      const dx=_DIR_DX[dir], dy=_DIR_DY[dir];
      const hx=cx+dx*4.5, hy=cy+dy*4.5;
      c.save(); c.shadowColor='#fff'; c.shadowBlur=8;
      _circ(c,hx+dy*2.2,hy-dx*2.2,1.8,'#ffffff');
      _circ(c,hx-dy*2.2,hy+dx*2.2,1.8,'#ffffff');
      c.restore();
    }
  },
  mob_dragon: {
    body:'#b71c1c', bodyLight:'#e53935', bodyR:16, headColor:'#c62828',
    headR:8, accentColor:'#ff6d00', outlineColor:'#4a0000',
    weapon:'fire',
    extra(c, cx,cy, dir, frame, state) {
      // Wing hints
      const dx=_DIR_DX[dir], dy=_DIR_DY[dir];
      c.save(); c.globalAlpha=0.7; c.fillStyle='#b71c1c';
      c.beginPath();
      c.ellipse(cx+dy*14,cy-dx*14, 10, 5, Math.atan2(dy,dx)+Math.PI/2, 0, Math.PI*2);
      c.fill();
      c.beginPath();
      c.ellipse(cx-dy*14,cy+dx*14, 10, 5, Math.atan2(-dy,-dx)+Math.PI/2, 0, Math.PI*2);
      c.fill();
      c.restore();
      // Fire breath in attack
      if (state==='attack' && frame>=2) {
        c.save(); c.globalAlpha=_atkExt(frame)*0.8;
        _glow(c,cx+dx*18,cy+dy*18, 12,'#ff6d00',0.9);
        c.restore();
      }
    }
  },
  mob_sentinel: {
    body:'#0d47a1', bodyLight:'#1976d2', bodyR:12, headColor:'#1565c0',
    headR:6, accentColor:'#40c4ff', outlineColor:'#002171',
    weapon:'bolt',
    extra(c, cx,cy, dir, frame, state) {
      // Electric halo
      c.save(); c.globalAlpha=0.5+Math.sin((frame||0)*0.9)*0.3;
      _glow(c,cx,cy,18,'#40c4ff',0.3);
      c.restore();
      // Four prongs
      const angles=[0,Math.PI/2,Math.PI,3*Math.PI/2];
      c.strokeStyle='#40c4ff'; c.lineWidth=2;
      for (const a of angles) {
        c.save(); c.globalAlpha=0.7;
        c.beginPath();
        c.moveTo(cx+Math.cos(a)*10,cy+Math.sin(a)*10);
        c.lineTo(cx+Math.cos(a)*16,cy+Math.sin(a)*16);
        c.stroke(); c.restore();
      }
    }
  },
  mob_berserker: {
    body:'#880e4f', bodyLight:'#ad1457', bodyR:13, headColor:'#6a0f3a',
    headR:6, accentColor:'#ff1744', outlineColor:'#3d0020',
    weapon:'axe',
    extra(c, cx,cy, dir, frame, state) {
      // Horns
      const dx=_DIR_DX[dir], dy=_DIR_DY[dir];
      const hx=cx+dx*5, hy=cy+dy*5;
      c.save(); c.fillStyle='#4a0020';
      c.beginPath();
      c.moveTo(hx+dy*4,hy-dx*4); c.lineTo(hx+dy*6,hy-dx*8); c.lineTo(hx+dy*2,hy-dx*6); c.closePath(); c.fill();
      c.beginPath();
      c.moveTo(hx-dy*4,hy+dx*4); c.lineTo(hx-dy*6,hy+dx*8); c.lineTo(hx-dy*2,hy+dx*6); c.closePath(); c.fill();
      c.restore();
      // Rage aura at low HP / attack
      if (state==='attack') {
        c.save(); c.globalAlpha=0.35*_atkExt(frame||0);
        _glow(c,cx,cy,18,'#ff1744',0.5);
        c.restore();
      }
    }
  },
  mob_ancient_colossus: {
    body:'#1a0000', bodyLight:'#4a0000', bodyR:22, headColor:'#300000',
    headR:11, accentColor:'#ff2200', outlineColor:'#000000',
    weapon:'none',
    extra(c, cx,cy, dir, frame, state) {
      // Massive dark aura
      c.save(); c.globalAlpha=0.5+Math.sin((frame||0)*0.4)*0.2;
      _glow(c,cx,cy,30,'#8B0000',0.6);
      c.restore();
      // Six glowing red eyes arranged in a ring
      const dx=_DIR_DX[dir], dy=_DIR_DY[dir];
      const hx=cx+dx*9, hy=cy+dy*9;
      c.save(); c.shadowColor='#ff2200'; c.shadowBlur=10;
      const eyeAngle=Math.atan2(dy||0.001,dx||0.001);
      const eyePulse=0.8+Math.sin((frame||0)*1.2)*0.4;
      for(let e=0;e<6;e++){
        const a=eyeAngle+(e-2.5)*0.55;
        const er=7+Math.abs(e-2.5)*1.5;
        _circ(c,hx+Math.cos(a)*er,hy+Math.sin(a)*er,2.2*eyePulse,'#ff2200');
      }
      c.restore();
      // Cracks/energy seams on body
      c.save(); c.strokeStyle='#ff440044'; c.lineWidth=1.5; c.globalAlpha=0.6;
      c.beginPath(); c.moveTo(cx-12,cy-8); c.lineTo(cx-4,cy); c.lineTo(cx-10,cy+10); c.stroke();
      c.beginPath(); c.moveTo(cx+10,cy-10); c.lineTo(cx+6,cy+2); c.lineTo(cx+12,cy+8); c.stroke();
      c.restore();
      // Crown of dark spikes
      c.save(); c.fillStyle='#4a0000';
      const spikeAngles=[-0.6,-0.3,0,0.3,0.6];
      spikeAngles.forEach(a=>{
        const base=Math.atan2(dy||0.001,dx||0.001)+a-Math.PI/2;
        c.beginPath();
        c.moveTo(cx+Math.cos(base-0.2)*22,cy+Math.sin(base-0.2)*22);
        c.lineTo(cx+Math.cos(base)*30,cy+Math.sin(base)*30);
        c.lineTo(cx+Math.cos(base+0.2)*22,cy+Math.sin(base+0.2)*22);
        c.closePath(); c.fill();
      });
      c.restore();
      // Attack surge
      if(state==='attack'&&(frame||0)>=2){
        c.save(); c.globalAlpha=_atkExt(frame)*0.9;
        _glow(c,cx+dx*28,cy+dy*28,18,'#ff2200',1.0);
        c.restore();
      }
    }
  },
  mob_lich: {
    body:'#311b92', bodyLight:'#512da8', bodyR:12, headColor:'#4527a0',
    headR:6.5, accentColor:'#aa44ff', outlineColor:'#1a0060',
    weapon:'skull_staff',
    extra(c, cx,cy, dir, frame, state) {
      // Crown
      const dx=_DIR_DX[dir], dy=_DIR_DY[dir];
      const hx=cx+dx*5.5, hy=cy+dy*5.5;
      c.save(); c.fillStyle='#ffcc00'; c.globalAlpha=0.9;
      [-3,0,3].forEach(o => {
        c.beginPath();
        c.moveTo(hx+dy*o-1.5,hy-dx*o); c.lineTo(hx+dy*o,hy-dx*o-4); c.lineTo(hx+dy*o+1.5,hy-dx*o);
        c.closePath(); c.fill();
      });
      c.restore();
      // Death aura
      c.save(); c.globalAlpha=0.25+Math.sin((frame||0)*0.5)*0.15;
      _glow(c,cx,cy,18,'#7b1fa2',0.4);
      c.restore();
    }
  },
};

// ── WEAPON DRAW FUNCTIONS ────────────────────────────────────────
function _drawWeapon(c, cx, cy, dir, frame, state, profile) {
  const dx=_DIR_DX[dir], dy=_DIR_DY[dir];
  const ext = state==='attack' ? _atkExt(frame||0) : (state==='walk'?0.3:0.15);
  const wx = cx + dx*(11+ext*7), wy = cy + dy*(11+ext*7);

  switch(profile.weapon) {
    case 'gun':
      c.save(); c.strokeStyle=profile.accentColor; c.lineWidth=3; c.lineCap='round';
      c.beginPath(); c.moveTo(cx+dx*8,cy+dy*8); c.lineTo(wx,wy); c.stroke();
      _circ(c,wx,wy,2.5,profile.accentColor);
      if (state==='attack'&&frame===2) {
        c.save(); c.globalAlpha=0.8; _glow(c,wx,wy,8,'#ffff88',0.9); c.restore();
      }
      c.restore(); break;

    case 'daggers':
      [1,-1].forEach(side => {
        const bx=cx+dy*side*4+dx*6, by=cy-dx*side*4+dy*6;
        c.save(); c.strokeStyle=profile.accentColor; c.lineWidth=2; c.lineCap='round';
        c.beginPath(); c.moveTo(bx,by); c.lineTo(bx+dx*(4+ext*5),by+dy*(4+ext*5)); c.stroke();
        c.restore();
      }); break;

    case 'staff':
    case 'bone_staff':
    case 'skull_staff': {
      const sx=cx+dx*5+dy*3, sy=cy+dy*5-dx*3;
      const ex=sx+dx*10, ey=sy+dy*10;
      c.save(); c.strokeStyle=profile.weapon==='staff'?'#b39ddb':'#c8e6c9'; c.lineWidth=2.5; c.lineCap='round';
      c.beginPath(); c.moveTo(sx,sy); c.lineTo(ex,ey); c.stroke();
      // Staff tip / skull
      const tipColor = profile.weapon==='staff' ? '#cc44ff' : (profile.weapon==='skull_staff' ? '#aa44ff' : '#88cc44');
      _circ(c,ex,ey,3.5,tipColor,profile.accentColor,1);
      if (state==='attack'||state==='special') {
        c.save(); c.globalAlpha=_atkExt(frame||0)*0.7;
        _glow(c,ex,ey,10,tipColor,0.8); c.restore();
      }
      c.restore(); break;
    }
    case 'shield': {
      const sx=cx+dy*9+dx*3, sy=cy-dx*9+dy*3;
      c.save(); c.fillStyle='#1565c0'; c.strokeStyle=profile.accentColor; c.lineWidth=1.5;
      c.beginPath(); c.ellipse(sx,sy,5,7,Math.atan2(dy,dx),0,Math.PI*2); c.fill(); c.stroke();
      c.restore(); break;
    }
    case 'bow': {
      const bx=cx+dx*7+dy*3, by=cy+dy*7-dx*3;
      const angle=Math.atan2(dy,dx);
      c.save(); c.translate(bx,by); c.rotate(angle);
      c.strokeStyle='#8d6e63'; c.lineWidth=2;
      c.beginPath(); c.arc(0,0,6,Math.PI*0.4,Math.PI*1.6); c.stroke();
      if (state==='attack') {
        c.strokeStyle='#ffcc00'; c.lineWidth=1;
        c.beginPath(); c.moveTo(-6,0); c.lineTo(6+ext*4,0); c.stroke();
      }
      c.restore(); break;
    }
    case 'axe': {
      c.save(); c.strokeStyle='#bdbdbd'; c.lineWidth=2.5; c.lineCap='round';
      c.beginPath(); c.moveTo(cx+dx*6,cy+dy*6); c.lineTo(wx,wy); c.stroke();
      c.fillStyle='#9e9e9e'; c.strokeStyle='#bdbdbd'; c.lineWidth=1.5;
      c.beginPath();
      c.arc(wx,wy,4+ext*2,Math.atan2(dy,dx)-1.0,Math.atan2(dy,dx)+1.0);
      c.lineTo(wx,wy); c.closePath(); c.fill(); c.stroke();
      c.restore(); break;
    }
    case 'bolt': {
      if (state==='attack') {
        c.save(); c.strokeStyle=profile.accentColor; c.lineWidth=2; c.globalAlpha=ext;
        c.beginPath(); c.moveTo(cx+dx*12,cy+dy*12); c.lineTo(cx+dx*22,cy+dy*22); c.stroke();
        _glow(c,cx+dx*22,cy+dy*22,8,profile.accentColor,0.9);
        c.restore();
      } break;
    }
    case 'fire': {
      if (state==='attack' && (frame||0)>=2) {
        c.save(); c.globalAlpha=ext*0.8;
        for (let i=0;i<3;i++) {
          const angle=Math.atan2(dy,dx)+(i-1)*0.35;
          _glow(c,cx+Math.cos(angle)*20,cy+Math.sin(angle)*20,8,'#ff6d00',0.9);
        }
        c.restore();
      } break;
    }
    case 'teeth': {
      if (state==='attack' && (frame||0)>=1) {
        c.save(); c.fillStyle='#fff'; c.globalAlpha=ext;
        const hx2=cx+dx*7, hy2=cy+dy*7;
        [-2,0,2].forEach(o => _circ(c,hx2+dy*o,hy2-dx*o,1.2,'#fff'));
        c.restore();
      } break;
    }
    case 'fist': {
      c.save(); c.fillStyle='#795548'; c.strokeStyle='#5d4037'; c.lineWidth=1.5;
      _circ(c,cx+dx*14,cy+dy*14,4+ext*2,'#8d6e63','#5d4037',1.5);
      c.restore(); break;
    }
    // 'none' — no weapon
  }
}

// ── CORE CHARACTER DRAW ──────────────────────────────────────────
function _drawChar(c, profile, dir, frame, state) {
  const cx = _SG_F/2, cy = _SG_F/2;
  let ox=0, oy=0;

  // Compute position offsets by state
  if (state==='idle') {
    oy = _idleBob(frame||0) * 0.5;
  } else if (state==='walk') {
    const s=_walkSway(frame||0); ox=s.dx; oy=s.dy;
  } else if (state==='dead') {
    const t=(frame||0)/5;
    c.save(); c.translate(cx,cy); c.rotate(t*Math.PI*0.5);
    c.globalAlpha=Math.max(0,1-t*1.2);
    _drawCharBody(c, profile, 0, 0, dir, frame, state);
    c.restore(); return;
  }

  if (state==='special') {
    const pulse=_spcPulse(frame||0);
    c.save(); c.translate(cx+ox,cy+oy); c.scale(pulse,pulse);
    _drawCharBody(c, profile, 0, 0, dir, frame, state);
    c.restore();
  } else {
    _drawCharBody(c, profile, cx+ox, cy+oy, dir, frame, state);
  }
}

function _drawCharBody(c, profile, cx, cy, dir, frame, state) {
  const dx=_DIR_DX[dir], dy=_DIR_DY[dir];
  const R=profile.bodyR, hR=profile.headR;
  const hDist=R*0.55;

  // Shadow
  _shadow(c, cx, cy, R, R);

  // Glow for special/attack states
  if (state==='special') {
    c.save(); c.globalAlpha=0.35; _glow(c,cx,cy,R*2,profile.accentColor,0.5); c.restore();
  }

  // Body
  const grad=c.createRadialGradient(cx-R*0.25,cy-R*0.25,0,cx,cy,R);
  grad.addColorStop(0,profile.bodyLight); grad.addColorStop(1,profile.body);
  _circ(c,cx,cy,R,null,profile.outlineColor,1.5);
  c.fillStyle=grad; c.beginPath(); c.arc(cx,cy,R,0,Math.PI*2); c.fill();
  _circ(c,cx,cy,R,null,profile.outlineColor,1.5);

  // Armor/extra details on body
  if (profile.armorColor && profile.armorColor !== profile.body) {
    c.save(); c.globalAlpha=0.6;
    _oval(c,cx,cy,R*0.7,R*0.45,profile.armorColor);
    c.restore();
  }

  // Weapon (drawn behind head for up direction, in front otherwise)
  if (dir!==3) _drawWeapon(c,cx,cy,dir,frame,state,profile);

  // Head
  const hx=cx+dx*hDist, hy=cy+dy*hDist;
  const hGrad=c.createRadialGradient(hx-hR*0.2,hy-hR*0.2,0,hx,hy,hR);
  hGrad.addColorStop(0,profile.headColor+'ff');
  hGrad.addColorStop(1,profile.body);
  _circ(c,hx,hy,hR,null,profile.outlineColor,1);
  c.fillStyle=hGrad; c.beginPath(); c.arc(hx,hy,hR,0,Math.PI*2); c.fill();
  _circ(c,hx,hy,hR,null,profile.outlineColor,1);

  // Eyes (two bright dots facing direction)
  if (dir!==3) { // don't draw eyes when facing away
    const eyeOff=hR*0.38;
    c.save(); c.fillStyle='#fff'; c.shadowColor=profile.accentColor; c.shadowBlur=3;
    _circ(c,hx+dy*eyeOff,hy-dx*eyeOff,1.4,'#fff');
    _circ(c,hx-dy*eyeOff,hy+dx*eyeOff,1.4,'#fff');
    c.restore();
  }

  // Up direction weapon (over head)
  if (dir===3) _drawWeapon(c,cx,cy,dir,frame,state,profile);

  // Extra class/mob-specific details
  if (profile.extra) profile.extra(c,cx,cy,dir,frame,state);
}

// ── SHEET BUILDER ────────────────────────────────────────────────
function _buildSheet(profile) {
  const W = _SG_F * _SG_COLS;
  const H = _SG_F * _SG_ROWS;
  const canvas = new OffscreenCanvas(W, H);
  const c = canvas.getContext('2d');
  c.imageSmoothingEnabled = false;

  // State layout: [rowStart, frameCount, state]
  const stateLayout = [
    { state:'idle',    rowStart:0,  frames:4 },
    { state:'walk',    rowStart:4,  frames:6 },
    { state:'attack',  rowStart:8,  frames:5 },
    { state:'special', rowStart:12, frames:6 },
    { state:'dead',    rowStart:16, frames:6 },
  ];

  for (const { state, rowStart, frames } of stateLayout) {
    if (state === 'dead') {
      // Single row, no direction
      for (let f = 0; f < frames; f++) {
        const px = f * _SG_F, py = rowStart * _SG_F;
        c.save(); c.translate(px, py);
        _drawChar(c, profile, 0, f, 'dead');
        c.restore();
      }
    } else {
      // 4 directions × frames
      for (let dir = 0; dir < 4; dir++) {
        const row = rowStart + dir;
        for (let f = 0; f < frames; f++) {
          const px = f * _SG_F, py = row * _SG_F;
          c.save(); c.translate(px, py);
          _drawChar(c, profile, dir, f, state);
          c.restore();
        }
      }
    }
  }

  return canvas;
}

// ── REGISTRATION ─────────────────────────────────────────────────
let _spriteGenDone = false;

// Generate one entity per rAF so sprite-gen never blocks a visible frame.
// Uses requestAnimationFrame so each build happens between two paints —
// the long task is invisible to the user and never delays input.
(function _scheduleGen() {
  const keys = Object.keys(_PROFILES);
  let i = 0;
  function _next() {
    if (_spriteGenDone || i >= keys.length) {
      _spriteGenDone = true;
      console.log('[SPRITE-GEN] All', keys.length, 'entity sheets ready.');
      return;
    }
    const key     = keys[i++];
    const profile = _PROFILES[key];
    const sheetName = 'gen_' + key;
    const existing = typeof _globalSpriteAssignments !== 'undefined' && _globalSpriteAssignments[key];
    if (!(existing && existing.sheetName && !existing.sheetName.startsWith('gen_'))) {
      const canvas = _buildSheet(profile);
      if (typeof SPRITE_SHEETS !== 'undefined') {
        SPRITE_SHEETS[sheetName] = { img:canvas, cols:_SG_COLS, rows:_SG_ROWS, frameW:_SG_F, frameH:_SG_F, loaded:true, name:sheetName };
        if (typeof markSheetCacheDirty === 'function') markSheetCacheDirty();
      }
      const isMob = key.startsWith('mob_');
      const assignment = {
        sheetName, dirMode:'4way',
        states: {
          idle:   { rowStart:0,  frameCount:4, fps:6,  directional:true },
          walk:   { rowStart:4,  frameCount:6, fps:10, directional:true },
          attack: { rowStart:8,  frameCount:5, fps:12, directional:true },
          special:{ rowStart:12, frameCount:6, fps:8,  directional:true },
          dead:   { rowStart:16, frameCount:6, fps:6,  directional:false },
        }
      };
      if (isMob) delete assignment.states.special;
      if (typeof _globalSpriteAssignments !== 'undefined') _globalSpriteAssignments[key] = assignment;
      if (typeof _sheetByNameDirty !== 'undefined') _sheetByNameDirty = true;
    }
    // Yield to rAF so the build never lands in the same frame as game logic
    requestAnimationFrame(_next);
  }
  // Start after first paint so page render isn't blocked
  requestAnimationFrame(() => requestAnimationFrame(_next));
})();
