// ═══════════════════════════════════════════════════════════════
// ABILITIES.JS — Special abilities and ultimates
// ═══════════════════════════════════════════════════════════════

function triggerSpecial(gs,p){
  const cls=p.cls, now=performance.now();
  if(cls==='gunner'){
    for(let i=0;i<5;i++) setTimeout(()=>{ if(!gs.gameOver&&p.alive){ fireBullet(gs,p,p.angle+(Math.random()-.5)*.1); if(p.isHuman)gs.stats.shots++; } },i*75);
    sparks(gs,p.x,p.y,p.color,16,130);
  } else if(cls==='assassin'){
    const dashDist=280;
    const ddx=Math.cos(p.angle), ddy=Math.sin(p.angle);
    const startX=p.x, startY=p.y;
    const endX=Math.max(p.radius,Math.min(W-p.radius,p.x+ddx*dashDist));
    const endY=Math.max(p.radius,Math.min(H-p.radius,p.y+ddy*dashDist));
    addDashTrail(gs,startX,startY,endX,endY,p.color);
    p.x=endX; p.y=endY; p.vx=0; p.vy=0; p.invuln=300;
    const allTargets=[...getEnemies(p,gs)];
    for(const camp of gs.camps){
      for(const mob of camp.mobs){ if(mob.alive) allTargets.push(mob); }
    }
    for(const t of allTargets){
      const ex=t.x-startX, ey=t.y-startY;
      const lx=endX-startX, ly=endY-startY;
      const len2=lx*lx+ly*ly;
      const proj=Math.max(0,Math.min(1,(ex*lx+ey*ly)/len2));
      const cx=startX+lx*proj, cy=startY+ly*proj;
      const dist=Math.sqrt((t.x-cx)*(t.x-cx)+(t.y-cy)*(t.y-cy));
      const hitR=(t.radius||14)+p.radius+20;
      if(dist<hitR){
        if(t.hp!==undefined && t.alive!==undefined && !t.id){
          t.hp-=45;
          sparks(gs,t.x,t.y,p.color,14,120);
          if(t.hp<=0){ t.alive=false; sparks(gs,t.x,t.y,t.color,20,160); }
        } else {
          dmgPlayer(gs,t,{dmg:45,owner:p.id,color:p.color});
          sparks(gs,t.x,t.y,p.color,22,180);
        }
      }
    }
    p.swordOn=true; p.swordAngle=p.angle; p.swordSweep=0; p.swordTimer=300;
    sparks(gs,p.x,p.y,p.color,16,130);
    shakeIntensity=Math.max(shakeIntensity,5);
  } else if(cls==='necro'){
    const range=200, arc=1.2;
    p.drainTimer=800;
    let drainCount=0;
    const allTargets2=[...getEnemies(p,gs)];
    for(const camp of gs.camps){ for(const mob of camp.mobs){ if(mob.alive) allTargets2.push(mob); } }
    for(const t of allTargets2){
      const dx=t.x-p.x, dy=t.y-p.y, dist=Math.sqrt(dx*dx+dy*dy);
      if(dist>range) continue;
      const angle=Math.atan2(dy,dx);
      let diff=angle-p.angle; while(diff>Math.PI) diff-=Math.PI*2; while(diff<-Math.PI) diff+=Math.PI*2;
      if(Math.abs(diff)<arc/2){
        if(t.id){dmgPlayer(gs,t,{dmg:30,owner:p.id,color:'#88cc44'});} else {t.hp-=30; if(t.hp<=0) t.alive=false;}
        const oldHpD=p.hp; p.hp=Math.min(p.maxHp,p.hp+15);
        if(p.hp>oldHpD && p.isHuman) addHealNumber(p.x,p.y-15,p.hp-oldHpD);
        drainCount++;
        for(let si=0;si<3;si++){
          gs.particles.push({x:t.x+(Math.random()-0.5)*20,y:t.y+(Math.random()-0.5)*20,
            vx:(p.x-t.x)/dist*200+(Math.random()-0.5)*60,vy:(p.y-t.y)/dist*200+(Math.random()-0.5)*60,
            life:0.5,maxLife:0.5,r:4+Math.random()*3,color:'#88cc44',glow:true});
        }
        sparks(gs,t.x,t.y,'#88cc44',12,100);
        addImpactRing(t.x,t.y,'#88cc44',40);
      }
    }
    sparks(gs,p.x,p.y,'#88cc44',25,180);
    sparks(gs,p.x,p.y,'#ccffcc',10,120);
    addImpactRing(p.x,p.y,'#88cc44',range*0.6);
    if(drainCount>0) addImpactRing(p.x,p.y,'#aaffaa',80);
    shakeIntensity=Math.max(shakeIntensity,5+drainCount*2);
  } else if(cls==='ranger'){
    const spread = 0.5;
    for(let i=0;i<5;i++){
      const aOff = (i - 2) * (spread / 4);
      const a = p.angle + aOff;
      const d = CDEFS.ranger;
      const b=_bulletSlot(gs);
      if(b){
        b.x=p.x+Math.cos(a)*(p.radius+4); b.y=p.y+Math.sin(a)*(p.radius+4);
        b.vx=Math.cos(a)*d.bSpd*1.1; b.vy=Math.sin(a)*d.bSpd*1.1;
        b.owner=p.id; b.dmg=d.bDmg; b.color='#ff8833'; b.life=d.bLife; b.pierced=false;
        b.homing=false; b.isMage=false; b.r=5; b.team=p.team; b.isSnipe=false; b.isArrow=true; b.isPredicted=false;
      }
      sparks(gs,p.x+Math.cos(a)*p.radius,p.y+Math.sin(a)*p.radius,'#ff8833',3,50);
    }
    sparks(gs,p.x,p.y,'#ff8833',20,150);
    addImpactRing(p.x,p.y,'#ff8833',60);
    shakeIntensity=Math.max(shakeIntensity,5);
  } else if(cls==='mage'){
    p.novaOn=true; p.novaR=p.radius+4; p.novaLife=700; p.novaX=p.x; p.novaY=p.y;
    p.novaHit=false;
    sparks(gs,p.x,p.y,p.color,28,240);
  } else if(cls==='tank'){
    p.hookOn=true;
    p.hookX=p.x+Math.cos(p.angle)*p.radius;
    p.hookY=p.y+Math.sin(p.angle)*p.radius;
    p.hookVx=Math.cos(p.angle)*700;
    p.hookVy=Math.sin(p.angle)*700;
    p.hookTimer=600;
    p.hookTarget=null;
    p.hookReturning=false;
    p.hookHit=false;
    sparks(gs,p.x,p.y,p.color,12,100);
    shakeIntensity=Math.max(shakeIntensity,3);
  }
}

// ── ULTIMATES (R KEY) ──

function triggerUltimate(gs,p){
  const cls=p.cls;
  p.glowTimer=3000; p.glowColor=p.color;
  if(cls==='gunner'){
    p.overchargeTimer=4000;
    sparks(gs,p.x,p.y,'#00ffff',30,200);
    sparks(gs,p.x,p.y,'#ffffff',15,140);
    shakeIntensity=Math.max(shakeIntensity,8);
  } else if(cls==='assassin'){
    p.smokeTimer=3000;
    p.smokeX=p.x; p.smokeY=p.y;
    p.invuln=500;
    sparks(gs,p.x,p.y,'#666666',40,180);
    shakeIntensity=Math.max(shakeIntensity,6);
    const enemies=getEnemies(p,gs);
    for(const t of enemies){
      const dx=t.x-p.x, dy=t.y-p.y;
      if(dx*dx+dy*dy<120*120){
        dmgPlayer(gs,t,{dmg:15,owner:p.id,color:'#666666'});
        sparks(gs,t.x,t.y,'#666666',10,80);
      }
    }
  } else if(cls==='mage'){
    p.barrierOn=true;
    p.barrierTimer=3000;
    p.barrierHp=80;
    const oldHpB=p.hp; p.hp=Math.min(p.maxHp,p.hp+30);
    if(p.isHuman&&p.hp>oldHpB) addHealNumber(p.x,p.y-15,p.hp-oldHpB);
    sparks(gs,p.x,p.y,'#cc44ff',25,200);
    sparks(gs,p.x,p.y,'#ffffff',12,160);
    shakeIntensity=Math.max(shakeIntensity,8);
  } else if(cls==='tank'){
    p.fortifyTimer=4000;
    p.glowTimer=4000; p.glowColor='#00ff88';
    const enemies=getEnemies(p,gs);
    for(const t of enemies){
      const dx=t.x-p.x, dy=t.y-p.y;
      if(dx*dx+dy*dy<130*130){
        dmgPlayer(gs,t,{dmg:25,owner:p.id,color:'#00ff88'});
        sparks(gs,t.x,t.y,'#00ff88',15,120);
        addImpactRing(t.x,t.y,'#00ff88',80);
      }
    }
    sparks(gs,p.x,p.y,'#00ff88',40,250);
    addImpactRing(p.x,p.y,'#00ff88',130);
    shakeIntensity=Math.max(shakeIntensity,10);
  } else if(cls==='necro'){
    p.minions = [];
    for(let i=0;i<3;i++){
      const angle=p.angle+(i-1)*0.8;
      const mx=p.x+Math.cos(angle)*60, my=p.y+Math.sin(angle)*60;
      p.minions.push({
        x:mx, y:my, vx:0, vy:0, hp:40, maxHp:40, alive:true,
        radius:8, speed:200, dmg:12, atkRange:40, atkCd:800, lastAtk:0,
        target:null, lifeTimer:10000, spawnAnim:1.0
      });
      sparks(gs,mx,my,'#88cc44',15,120);
      sparks(gs,mx,my,'#ccffcc',8,80);
      addImpactRing(mx,my,'#88cc44',50);
      for(let si=0;si<5;si++){
        gs.particles.push({x:mx+(Math.random()-0.5)*30,y:my+10,
          vx:(Math.random()-0.5)*40,vy:-80-Math.random()*60,
          life:0.8,maxLife:0.8,r:3+Math.random()*3,color:'#aaffaa',glow:true});
      }
    }
    p.invuln=300;
    sparks(gs,p.x,p.y,'#88cc44',50,280);
    sparks(gs,p.x,p.y,'#aaffaa',25,200);
    sparks(gs,p.x,p.y,'#ccffcc',12,140);
    addImpactRing(p.x,p.y,'#88cc44',120);
    addImpactRing(p.x,p.y,'#66aa22',80);
    shakeIntensity=Math.max(shakeIntensity,12);
  } else if(cls==='ranger'){
    gs.traps = gs.traps || [];
    for(let i=0;i<3;i++){
      const angle=p.angle+(i-1)*0.7;
      const dist=80+i*40;
      const tx=p.x+Math.cos(angle)*dist, ty=p.y+Math.sin(angle)*dist;
      gs.traps.push({
        x:tx, y:ty, owner:p.id, team:p.team, radius:22, dmg:35,
        rootDuration:1500, timer:15000, armed:true, triggered:false
      });
      sparks(gs,tx,ty,'#ff8833',12,80);
      addImpactRing(tx,ty,'#ff8833',30);
      for(let si=0;si<4;si++){
        gs.particles.push({x:tx+(Math.random()-0.5)*20,y:ty+(Math.random()-0.5)*20,
          vx:(Math.random()-0.5)*60,vy:-40-Math.random()*40,
          life:0.6,maxLife:0.6,r:2+Math.random()*2,color:'#ffcc66',glow:false});
      }
    }
    sparks(gs,p.x,p.y,'#ff8833',25,150);
    addImpactRing(p.x,p.y,'#ff8833',80);
    shakeIntensity=Math.max(shakeIntensity,6);
  }
}

// ── SECONDARY (F KEY) ──

function triggerSecondary(gs, p) {
  const cls = p.cls;
  if (cls === 'gunner') {
    // GRENADE: AOE explosion 220px ahead
    const tx = p.x + Math.cos(p.angle)*220, ty = p.y + Math.sin(p.angle)*220;
    const allT = [...getEnemies(p, gs)];
    for(const camp of gs.camps){ for(const mob of camp.mobs){ if(mob.alive) allT.push(mob); } }
    for(const t of allT){
      const dx=t.x-tx, dy=t.y-ty;
      if(dx*dx+dy*dy < 75*75){
        if(t.id){ dmgPlayer(gs,t,{dmg:45,owner:p.id,color:'#ff8800'}); }
        else { t.hp-=45; if(t.hp<=0){t.alive=false; sparks(gs,t.x,t.y,t.color,20,160);} }
        sparks(gs,t.x,t.y,'#ff8800',14,100);
      }
    }
    sparks(gs,tx,ty,'#ff8800',35,220); sparks(gs,tx,ty,'#ffff00',15,160);
    addImpactRing(tx,ty,'#ff8800',75); addImpactRing(tx,ty,'#ffcc00',40);
    shakeIntensity = Math.max(shakeIntensity, 8);
  } else if (cls === 'assassin') {
    // BLITZ: teleport 160px forward + damage in 65px AOE at destination
    const tx = Math.max(p.radius, Math.min(W-p.radius, p.x + Math.cos(p.angle)*160));
    const ty = Math.max(p.radius, Math.min(H-p.radius, p.y + Math.sin(p.angle)*160));
    addDashTrail(gs, p.x, p.y, tx, ty, p.color);
    p.x = tx; p.y = ty; p.invuln = 150; p.vx = 0; p.vy = 0;
    const blT = [...getEnemies(p, gs)];
    for(const camp of gs.camps){ for(const mob of camp.mobs){ if(mob.alive) blT.push(mob); } }
    for(const t of blT){
      const dx=t.x-tx, dy=t.y-ty;
      if(dx*dx+dy*dy < 65*65){
        if(t.id){ dmgPlayer(gs,t,{dmg:40,owner:p.id,color:p.color}); }
        else { t.hp-=40; if(t.hp<=0){t.alive=false; sparks(gs,t.x,t.y,t.color,20,160);} }
        sparks(gs,t.x,t.y,p.color,18,140);
      }
    }
    sparks(gs,tx,ty,p.color,22,180);
    shakeIntensity = Math.max(shakeIntensity, 6);
  } else if (cls === 'mage') {
    // ARC MISSILES: 5 homing mini-bolts
    const dm = CDEFS.mage;
    for(let i=0;i<5;i++){
      const aOff = (i-2)*0.28;
      const b=_bulletSlot(gs);
      if(b){
        b.x=p.x+Math.cos(p.angle+aOff)*(p.radius+4); b.y=p.y+Math.sin(p.angle+aOff)*(p.radius+4);
        b.vx=Math.cos(p.angle+aOff)*dm.bSpd*0.85; b.vy=Math.sin(p.angle+aOff)*dm.bSpd*0.85;
        b.owner=p.id; b.dmg=18; b.color='#bb88ff'; b.life=1800;
        b.pierced=false; b.homing=true; b.isMage=true; b.r=4; b.team=p.team; b.isSnipe=false; b.isArrow=false; b.isPredicted=false;
      }
    }
    sparks(gs,p.x,p.y,'#bb88ff',25,200); addImpactRing(p.x,p.y,'#bb88ff',55);
    shakeIntensity = Math.max(shakeIntensity, 5);
  } else if (cls === 'tank') {
    // SHOCKWAVE: knockback + damage all enemies in 140px
    const swT = [...getEnemies(p, gs)];
    for(const camp of gs.camps){ for(const mob of camp.mobs){ if(mob.alive) swT.push(mob); } }
    for(const t of swT){
      const dx=t.x-p.x, dy=t.y-p.y, dist=Math.sqrt(dx*dx+dy*dy);
      if(dist > 140) continue;
      const force = (1 - dist/140) * 500;
      if(t.id){
        dmgPlayer(gs,t,{dmg:30,owner:p.id,color:'#00ff88'});
        t.vx += (dx/dist)*force; t.vy += (dy/dist)*force;
      } else {
        t.hp -= 30; if(t.hp<=0){t.alive=false; sparks(gs,t.x,t.y,t.color,20,160);}
      }
      sparks(gs,t.x,t.y,'#00ff88',12,90);
    }
    sparks(gs,p.x,p.y,'#00ff88',40,240); sparks(gs,p.x,p.y,'#ffffff',12,140);
    addImpactRing(p.x,p.y,'#00ff88',140); addImpactRing(p.x,p.y,'#aaffcc',80);
    shakeIntensity = Math.max(shakeIntensity, 10);
  } else if (cls === 'necro') {
    // BONE SPEAR: large heavy-hitting projectile
    const bSpd = CDEFS.necro.bSpd * 0.7;
    const b=_bulletSlot(gs);
    if(b){
      b.x=p.x+Math.cos(p.angle)*(p.radius+6); b.y=p.y+Math.sin(p.angle)*(p.radius+6);
      b.vx=Math.cos(p.angle)*bSpd; b.vy=Math.sin(p.angle)*bSpd;
      b.owner=p.id; b.dmg=55; b.color='#ccffcc'; b.life=2800;
      b.pierced=false; b.homing=false; b.isMage=false; b.r=9; b.team=p.team; b.isSnipe=false; b.isArrow=false; b.isPredicted=false;
    }
    sparks(gs,p.x,p.y,'#88cc44',22,180); sparks(gs,p.x,p.y,'#ffffff',8,100);
    addImpactRing(p.x,p.y,'#88cc44',60);
    shakeIntensity = Math.max(shakeIntensity, 6);
  } else if (cls === 'ranger') {
    // RAPID BURST: 4 arrows fired in quick succession
    const dr = CDEFS.ranger;
    for(let i=0;i<4;i++){
      setTimeout(()=>{
        if(!gs.gameOver && p.alive){
          const aOff = (Math.random()-0.5)*0.14;
          const b=_bulletSlot(gs);
          if(b){
            b.x=p.x+Math.cos(p.angle+aOff)*(p.radius+4); b.y=p.y+Math.sin(p.angle+aOff)*(p.radius+4);
            b.vx=Math.cos(p.angle+aOff)*dr.bSpd*1.05; b.vy=Math.sin(p.angle+aOff)*dr.bSpd*1.05;
            b.owner=p.id; b.dmg=dr.bDmg*0.8; b.color='#ff8833'; b.life=dr.bLife;
            b.pierced=false; b.homing=false; b.isMage=false; b.r=4; b.team=p.team; b.isSnipe=false; b.isArrow=true; b.isPredicted=false;
          }
          sparks(gs,p.x+Math.cos(p.angle+aOff)*p.radius,p.y+Math.sin(p.angle+aOff)*p.radius,'#ff8833',2,40);
        }
      }, i*80);
    }
    sparks(gs,p.x,p.y,'#ff8833',18,150); addImpactRing(p.x,p.y,'#ff8833',50);
    shakeIntensity = Math.max(shakeIntensity, 5);
  }
}
