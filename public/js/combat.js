// ═══════════════════════════════════════════════════════════════
// COMBAT.JS — Damage, bullets, combat mechanics
// ═══════════════════════════════════════════════════════════════

// ── TEAM HELPERS ──
function isAlly(p1, p2, gs){
  if(!gs.teamMode) return p1.id===p2.id;
  return p1.team===p2.team;
}
function isEnemy(p1, p2, gs){
  if(!gs.teamMode) return p1.id!==p2.id;
  return p1.team!==p2.team;
}
const _enemyBuf = []; // reused buffer — no array allocation per call
function getEnemies(p, gs){
  _enemyBuf.length = 0;
  for(let _i=0;_i<gs.players.length;_i++){
    const pp=gs.players[_i];
    if(isEnemy(p,pp,gs)&&pp.alive) _enemyBuf.push(pp);
  }
  return _enemyBuf;
}
function getLocalPlayer(gs){
  for(let _i=0;_i<gs.players.length;_i++) if(gs.players[_i].isHuman) return gs.players[_i];
  return gs.players[0];
}
function getTeamColor(p, gs){
  if(!gs.teamMode) return null;
  return p.team===1?TEAM_COLORS.blue:TEAM_COLORS.red;
}

// ── BULLET POOL — reuse dead slots, never allocate after warm-up ──
const MAX_BULLETS = 150;
function _bulletSlot(gs) {
  for (let i = 0; i < gs.bullets.length; i++) {
    if (gs.bullets[i].life <= 0) return gs.bullets[i];
  }
  if (gs.bullets.length < MAX_BULLETS) {
    const b = {};
    gs.bullets.push(b);
    return b;
  }
  return null;
}

function fireBullet(gs,p,angle){
  const d=CDEFS[p.cls];
  let dmg=p.upgrades.heavy?d.bDmg*2:d.bDmg;
  let spd=d.bSpd+(p.upgrades.rapidFire?50:0);
  if(p.upgrades.projSpeed) spd=Math.round(spd*1.3);
  const isMage=p.cls==='mage';
  const b=_bulletSlot(gs);
  if(b){
    b.x=p.x+Math.cos(angle)*(p.radius+4); b.y=p.y+Math.sin(angle)*(p.radius+4);
    b.vx=Math.cos(angle)*spd; b.vy=Math.sin(angle)*spd;
    b.owner=p.id; b.dmg=dmg; b.color=p.color; b.life=d.bLife; b.pierced=false;
    b.homing=!!p.upgrades.homing; b.isMage=isMage; b.r=isMage?8:4;
    b.team=p.team; b.isSnipe=false; b.isArrow=false; b.isPredicted=false;
  }
  sparks(gs,p.x+Math.cos(angle)*p.radius,p.y+Math.sin(angle)*p.radius,p.color,isMage?7:3,isMage?70:36);
}

function fireSword(gs,p){
  const dmg=p.upgrades.heavy ? 36 : 22;
  const range=CDEFS.assassin.meleeRange + (p.upgrades.heavy ? 10 : 0);
  const arc=CDEFS.assassin.meleeArc;
  for(const t of gs.players){
    if(isAlly(p,t,gs)||!t.alive||t.invuln>0) continue;
    const dx=t.x-p.x, dy=t.y-p.y, dist=Math.sqrt(dx*dx+dy*dy);
    if(dist > range + t.radius) continue;
    const angleToTarget=Math.atan2(dy,dx);
    let diff=angleToTarget-p.angle;
    while(diff>Math.PI)diff-=Math.PI*2; while(diff<-Math.PI)diff+=Math.PI*2;
    if(Math.abs(diff) < arc/2){
      dmgPlayer(gs,t,{dmg,owner:p.id,color:p.color});
      sparks(gs,t.x,t.y,p.color,14,120);
    }
  }
  for(const camp of gs.camps){
    for(const mob of camp.mobs){
      if(!mob.alive) continue;
      const dx=mob.x-p.x, dy=mob.y-p.y, dist=Math.sqrt(dx*dx+dy*dy);
      if(dist > range + mob.radius) continue;
      const angleToTarget=Math.atan2(dy,dx);
      let diff=angleToTarget-p.angle;
      while(diff>Math.PI)diff-=Math.PI*2; while(diff<-Math.PI)diff+=Math.PI*2;
      if(Math.abs(diff) < arc/2){
        mob.hp-=dmg;
        sparks(gs,mob.x,mob.y,p.color,10,90);
        if(mob.hp<=0){ mob.alive=false; sparks(gs,mob.x,mob.y,mob.color,18,140); if(typeof addExplosionPixi==='function') addExplosionPixi(mob.x,mob.y,mob.radius*4,mob.color); }
      }
    }
  }
  sparks(gs,p.x+Math.cos(p.angle)*30,p.y+Math.sin(p.angle)*30,p.color,8,80);
}

// ── RANGER CHARGED SNIPE ──
function fireChargedSnipe(gs, p){
  const d=CDEFS.ranger;
  const dmg = p.upgrades.heavy ? d.bDmg*6 : d.bDmg*3;
  const angle = p.chargeAngle;
  let spd = d.bSpd * 1.5;
  if(p.upgrades.projSpeed) spd=Math.round(spd*1.3);
  const b=_bulletSlot(gs);
  if(b){
    b.x=p.x+Math.cos(angle)*(p.radius+6); b.y=p.y+Math.sin(angle)*(p.radius+6);
    b.vx=Math.cos(angle)*spd; b.vy=Math.sin(angle)*spd;
    b.owner=p.id; b.dmg=dmg; b.color='#ff2222'; b.life=d.bLife*1.5; b.pierced=false;
    b.homing=false; b.isMage=false; b.r=8; b.team=p.team; b.isSnipe=true; b.isArrow=true; b.isPredicted=false;
  }
  sparks(gs,p.x,p.y,'#ff3333',8,160);
  sparks(gs,p.x,p.y,'#ffaa00',4,120);
  addImpactRing(p.x,p.y,'#ff3333',60);
  shakeIntensity=Math.max(shakeIntensity,8);
  triggerScreenFlash('#ff220044',0.1);
  for(let i=0;i<8;i++){
    const spread=(Math.random()-0.5)*0.3;
    gs.particles.push({x:p.x+Math.cos(angle+spread)*(p.radius+10+i*6),
      y:p.y+Math.sin(angle+spread)*(p.radius+10+i*6),
      vx:Math.cos(angle)*100+Math.random()*40,vy:Math.sin(angle)*100+Math.random()*40,
      life:0.5,ml:0.3,col:i<4?'#ff6633':'#ffaa00',sz:3+Math.random()*3});
  }
}

// Pre-built player id→object Map — rebuilt once at top of updBullets, used for owner lookups
const _playerById = new Map();
const _shQueryOut = []; // reused output buffer for shQuery calls

function updBullets(gs,dt){
  // Build player map once — O(n) instead of O(n) per lookup per bullet
  _playerById.clear();
  for(let _pi=0;_pi<gs.players.length;_pi++) _playerById.set(gs.players[_pi].id, gs.players[_pi]);

  // Spatial hash of mobs — eliminates O(bullets × mobs) collision loop
  if(typeof shClear==='function'){
    shClear();
    for(let _ci=0;_ci<gs.camps.length;_ci++){
      const camp=gs.camps[_ci];
      for(let _mi=0;_mi<camp.mobs.length;_mi++){
        const mob=camp.mobs[_mi];
        if(mob.alive) shInsert(mob.x,mob.y,mob.radius,mob);
      }
    }
  }

  for(let i=0;i<gs.bullets.length;i++){
    const b=gs.bullets[i];
    if(b.life<=0) continue; // dead pool slot
    b.life-=dt*1000;
    if(b.life<=0){b.life=0;continue;}
    if(b.homing){
      // Inline enemy scan — reuse owner player object, no temp object allocation
      const _bOwner = _playerById.get(b.owner);
      let t=null, minD=Infinity;
      for(const e of gs.players){
        if(!e.alive || !isEnemy(_bOwner||{id:b.owner,team:b.team},e,gs)) continue;
        const dx=e.x-b.x,dy=e.y-b.y,d=dx*dx+dy*dy;
        if(d<minD){minD=d;t=e;}
      }
      if(t){
        const ta=Math.atan2(t.y-b.y,t.x-b.x), ca=Math.atan2(b.vy,b.vx);
        let diff=ta-ca;
        while(diff>Math.PI)diff-=Math.PI*2; while(diff<-Math.PI)diff+=Math.PI*2;
        const turn=Math.min(Math.abs(diff),2.5*dt)*Math.sign(diff);
        const sp=Math.sqrt(b.vx*b.vx+b.vy*b.vy), na=ca+turn;
        b.vx=Math.cos(na)*sp; b.vy=Math.sin(na)*sp;
      }
    }
    b.x+=b.vx*dt; b.y+=b.vy*dt;
    if(b.x<0||b.x>W||b.y<0||b.y>H){b.life=0;continue;}
    let dead=false;
    for(const w of gs.walls){
      if(b.x>w.x&&b.x<w.x+w.w&&b.y>w.y&&b.y<w.y+w.h){
        const sh=_playerById.get(b.owner);
        if(sh&&sh.upgrades.pierce&&!b.pierced){b.pierced=true;}
        else{dead=true; sparks(gs,b.x,b.y,b.color,3,45);}
        break;
      }
    }
    if(dead){b.life=0;continue;}
    for(const p of gs.players){
      if(p.id===b.owner||!p.alive||p.invuln>0)continue;
      if(gs.teamMode && p.team===b.team) continue;
      const dx=p.x-b.x, dy=p.y-b.y;
      if(dx*dx+dy*dy<(p.radius+b.r)*(p.radius+b.r)){
        dmgPlayer(gs,p,b);
        const sh=_playerById.get(b.owner);
        if(sh) sh.energy+=12;
        if(p.isHuman===false){ for(let _li=0;_li<gs.players.length;_li++){if(gs.players[_li].isHuman){gs.stats.hits++;break;}} }
        b.life=0; dead=true; break;
      }
    }
    if(dead) continue;
    // Spatial hash path: O(1) per bullet instead of O(mobs)
    if(typeof shQuery==='function'){
      _shQueryOut.length=0;
      shQuery(b.x,b.y,b.r+50,_shQueryOut); // 50 = max mob radius headroom
      for(let _sqi=0;_sqi<_shQueryOut.length;_sqi++){
        const mob=_shQueryOut[_sqi];
        if(!mob.alive) continue;
        const dx=mob.x-b.x, dy=mob.y-b.y;
        if(dx*dx+dy*dy<(mob.radius+b.r)*(mob.radius+b.r)){
          mob.hp-=b.dmg; mob.aggroTarget=b.owner;
          sparks(gs,mob.x,mob.y,b.color,6,60);
          if(mob.hp<=0){ mob.alive=false; sparks(gs,mob.x,mob.y,mob.color,18,140); if(typeof addExplosionPixi==='function') addExplosionPixi(mob.x,mob.y,mob.radius*4,mob.color); }
          b.life=0; dead=true; break;
        }
      }
    } else {
      for(const camp of gs.camps){
        for(const mob of camp.mobs){
          if(!mob.alive) continue;
          const dx=mob.x-b.x, dy=mob.y-b.y;
          if(dx*dx+dy*dy<(mob.radius+b.r)*(mob.radius+b.r)){
            mob.hp-=b.dmg; mob.aggroTarget=b.owner;
            sparks(gs,mob.x,mob.y,b.color,6,60);
            if(mob.hp<=0){ mob.alive=false; sparks(gs,mob.x,mob.y,mob.color,18,140); }
            b.life=0; dead=true; break;
          }
        }
        if(dead) break;
      }
    }
  }
}

function dmgPlayer(gs,p,src){
  let d=src.dmg;
  if(src.owner>0){
    const shooter=gs.players.find(pp=>pp.id===src.owner);
    if (shooter && typeof applyTalentDmgMods === 'function')
      d = applyTalentDmgMods(gs, shooter, p, d);
    if(shooter){
      if(shooter.streakDmgBoost>1) d=Math.round(d*shooter.streakDmgBoost);
      if(shooter.isHuman&&comboMultiplier>1) d=Math.round(d*comboMultiplier);
      if(shooter.upgrades.momentum){
        const spd=Math.sqrt(shooter.vx*shooter.vx+shooter.vy*shooter.vy);
        d=Math.round(d*(1+Math.min(0.2,spd/1500)));
      }
      if(shooter.upgrades.critStrike&&Math.random()<0.2){
        d*=2;
        sparks(gs,p.x,p.y-20,'#ffff00',12,100);
      }
    }
  }
  if(p.upgrades.armor) d=Math.round(d*.75);
  if(p.fortifyTimer>0) d=Math.round(d*0.5);
  if(p.shield>0){p.shield=Math.max(0,p.shield-d);}else p.hp-=d;
  // Practice mode damage log
  if(typeof practiceMode!=='undefined'&&practiceMode&&typeof practiceLogDmg==='function'){
    const atkName=src.owner>0?(gs.players.find(pp=>pp.id===src.owner)?.name||gs.players.find(pp=>pp.id===src.owner)?.cls||'???'):'MOB';
    practiceLogDmg(d, p.isDummy?'DUMMY':p.name||p.cls||'???', atkName);
  }
  sparks(gs,p.x,p.y,p.color,10,80);
  if(typeof addBloodSplatter==='function') addBloodSplatter(p.x, p.y);
  if(p.upgrades.thornmail&&src.owner>0){
    const attacker=gs.players.find(pp=>pp.id===src.owner&&pp.alive);
    if(attacker){
      const reflect=Math.round(src.dmg*0.15);
      attacker.hp-=reflect;
      sparks(gs,attacker.x,attacker.y,'#00ff88',5,50);
      if(attacker.hp<=0){attacker.hp=0;killPlayer(gs,attacker,p);}
    }
  }
  if(p.hp<=0){p.hp=0; killPlayer(gs,p,gs.players.find(pp=>pp.id===src.owner));}
}

function killPlayer(gs,victim,killer){
  victim.alive=false;
  shakeIntensity=Math.max(shakeIntensity,14);
  sparks(gs,victim.x,victim.y,victim.color,14,200);
  if(typeof addExplosionPixi==='function') addExplosionPixi(victim.x,victim.y,victim.radius*6,victim.color);
  addDmgNumber(victim.x, victim.y-20, '☠ KILLED', victim.color, true);
  if(killer&&killer.isHuman) registerComboKill();
  triggerScreenFlash(victim.color,0.25);
  addImpactRing(victim.x,victim.y,victim.color,150);
  if(typeof addBloodSplatter==='function'){
    addBloodSplatter(victim.x+(Math.random()-.5)*20, victim.y+(Math.random()-.5)*20);
  }

  // Undying talent — block death
  if (typeof applyTalentDeathEffects === 'function' && applyTalentDeathEffects(gs, victim)) return;

  if(killer){
    killer.killStreak++;
    if(killer.killStreak>killer.bestStreak) killer.bestStreak=killer.killStreak;
    checkStreak(gs,killer);
    if (typeof playMode === 'undefined' || playMode !== 'online') {
      if (typeof grantKillXP === 'function') grantKillXP(gs, killer, victim);
    }
    if (typeof applyTalentKillEffects === 'function') applyTalentKillEffects(gs, killer, victim);
    
    const streakName = STREAK_NAMES[Math.min(killer.killStreak, 10)];
    if(streakName){
      showStreakPopup(streakName, killer.killStreak);
      sparks(gs, killer.x, killer.y, killer.killStreak>=7?'#ffaa00':'#ff3355', 10, 180);
      shakeIntensity=Math.max(shakeIntensity, 4);
    }

    if(gs.teamMode){
      const teamIdx=killer.team===1?0:1;
      gs.score[teamIdx]++;
    } else {
      const vi=victim.id===1?1:0;
      gs.score[vi]++;
    }
    kfAdd(killer.color,victim.color,killer.cls,victim.cls,getTeamColor(killer,gs),getTeamColor(victim,gs));
  } else {
    if(!gs.teamMode){
      const vi=victim.id===1?1:0;
      gs.score[vi]++;
    }
  }

  victim.killStreak=0;
  victim.streakDmgBoost=1; victim.streakDmgTimer=0;
  victim.streakSpdBoost=1; victim.streakSpdTimer=0;
  
  if(killer) killer.energy+=20;
  setTimeout(()=>{
    if(gs.gameOver)return;
    victim.alive=true;
    const sx=victim.id%2===1?W*.2+Math.random()*W*.1:W*.7+Math.random()*W*.1;
    const sy=H*.3+Math.random()*H*.4;
    victim.x=sx; victim.y=sy;
    victim.hp=victim.maxHp; victim.shield=0; victim.invuln=2000;
    sparks(gs,sx,sy,'#00f5ff',8,120);
  },3000);
}

// ── MOB BULLET UPDATE ──
function updMobBullets(gs,dt){
  if(!gs.mobBullets) gs.mobBullets=[];
  for(let i=gs.mobBullets.length-1;i>=0;i--){
    const mb=gs.mobBullets[i];
    mb.life-=dt*1000;
    if(mb.life<=0){gs.mobBullets.splice(i,1);continue;}
    mb.x+=mb.vx*dt; mb.y+=mb.vy*dt;
    if(mb.x<0||mb.x>W||mb.y<0||mb.y>H){gs.mobBullets.splice(i,1);continue;}
    let hit=false;
    for(const w of gs.walls){
      if(mb.x>=w.x&&mb.x<=w.x+w.w&&mb.y>=w.y&&mb.y<=w.y+w.h){gs.mobBullets.splice(i,1);hit=true;break;}
    }
    if(hit) continue;
    for(const p of gs.players){
      if(!p.alive||p.invuln>0) continue;
      const dx=p.x-mb.x, dy=p.y-mb.y;
      if(dx*dx+dy*dy<(p.radius+mb.r)*(p.radius+mb.r)){
        dmgPlayer(gs,p,{dmg:mb.dmg,owner:-1,color:mb.color});
        sparks(gs,mb.x,mb.y,mb.color,8,60);
        addDmgNumber(p.x,p.y-10,mb.dmg,mb.color,false);
        gs.mobBullets.splice(i,1);
        break;
      }
    }
  }
}

// ── ORBS ──
function spawnOrb(gs){
  const c=Math.random()<.6;
  let x,y;
  if(c){x=W*.3+Math.random()*W*.4; y=H*.2+Math.random()*H*.6;}
  else{x=Math.random()<.5?W*.04+Math.random()*W*.14:W*.82+Math.random()*W*.14; y=H*.1+Math.random()*H*.8;}
  const v=c?(10+Math.floor(Math.random()*20)):(4+Math.floor(Math.random()*10));
  gs.orbs.push({x,y,value:v,r:7+v/6,pulse:Math.random()*Math.PI*2,life:18});
}
function updOrbs(gs,dt){
  gs.tick++;
  if(gs.tick%110===0&&gs.orbs.length<12) spawnOrb(gs);
  for(let i=gs.orbs.length-1;i>=0;i--){
    const o=gs.orbs[i];
    o.pulse+=dt*3;
    o.life-=dt;
    if(o.life<=0){gs.orbs.splice(i,1);continue;}
    for(const p of gs.players){
      if(!p.alive)continue;
      const dx=p.x-o.x, dy=p.y-o.y;
      if(dx*dx+dy*dy<(p.radius+o.r+8)*(p.radius+o.r+8)){
        p.energy+=o.value; if(p.isHuman){gs.stats.en+=o.value; addGoldFloat(o.x,o.y,o.value);}
        sparks(gs,o.x,o.y,'#ffaa00',8,60); gs.orbs.splice(i,1); break;
      }
    }
  }
}

// ── TRAP UPDATE ──
function updTraps(gs,dt){
  if(!gs.traps) return;
  for(let i=gs.traps.length-1;i>=0;i--){
    const trap=gs.traps[i];
    trap.timer-=dt*1000;
    if(trap.timer<=0||!trap.armed){gs.traps.splice(i,1);continue;}
    for(const p of gs.players){
      if(!p.alive||p.invuln>0) continue;
      if(gs.teamMode && p.team===gs.players.find(pp=>pp.id===trap.owner)?.team) continue;
      if(!gs.teamMode && p.id===trap.owner) continue;
      const dx=p.x-trap.x,dy=p.y-trap.y;
      if(dx*dx+dy*dy<(p.radius+trap.radius)*(p.radius+trap.radius)){
        trap.armed=false;
        dmgPlayer(gs,p,{dmg:trap.dmg,owner:trap.owner,color:'#ff8833'});
        p.vx=0; p.vy=0;
        p.invuln=-trap.rootDuration;
        sparks(gs,trap.x,trap.y,'#ff8833',25,180);
        sparks(gs,trap.x,trap.y,'#ffcc66',15,120);
        addImpactRing(trap.x,trap.y,'#ff8833',60);
        addDmgNumber(p.x,p.y-20,'🪤 TRAPPED!','#ff8833',true);
        shakeIntensity=Math.max(shakeIntensity,8);
        triggerScreenFlash('#ff8833',0.15);
        break;
      }
    }
    for(const camp of gs.camps){
      if(!trap.armed) break;
      for(const mob of camp.mobs){
        if(!mob.alive) continue;
        const dx=mob.x-trap.x,dy=mob.y-trap.y;
        if(dx*dx+dy*dy<(mob.radius+trap.radius)*(mob.radius+trap.radius)){
          trap.armed=false;
          mob.hp-=trap.dmg;
          mob.vx=0; mob.vy=0;
          if(mob.hp<=0){mob.alive=false;sparks(gs,mob.x,mob.y,mob.color,20,160);}
          sparks(gs,trap.x,trap.y,'#ff8833',20,140);
          addImpactRing(trap.x,trap.y,'#ff8833',50);
          break;
        }
      }
    }
  }
}

// ── SHOP ZONE CHECK ──
function isInShopZone(p,gs){
  const zones = gs.shopZones || [gs.shopZone];
  for(const sz of zones){
    if(p.x>sz.x-30 && p.x<sz.x+sz.w+30 && p.y>sz.y-30 && p.y<sz.y+sz.h+30) return true;
  }
  if(gs.towerShops){
    for(const sz of gs.towerShops){
      if(p.x>sz.x-30 && p.x<sz.x+sz.w+30 && p.y>sz.y-30 && p.y<sz.y+sz.h+30) return true;
    }
  }
  return false;
}
