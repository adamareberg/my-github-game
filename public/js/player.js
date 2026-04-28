// ═══════════════════════════════════════════════════════════════
// PLAYER.JS — Player update logic
// ═══════════════════════════════════════════════════════════════

function updPlayer(gs,p,dt,inp){
  if(!p.alive)return;
  const {ax,ay,shoot,dash}=inp;
  let spdMult=1; if(p.upgrades.speed) spdMult+=0.3; if(p.upgrades.boots) spdMult+=0.15;
  if(p.streakSpdBoost>1) spdMult*=p.streakSpdBoost;
  if(p.smokeTimer>0 && p.id===gameState.players.find(pp=>pp.smokeTimer>0)?.id) spdMult*=1.4;
  const spd=p.speed*spdMult;
  const accel=2200;
  p.vx+=ax*accel*dt; p.vy+=ay*accel*dt;
  const friction=1-Math.min(1, 6.5*dt);
  p.vx*=friction; p.vy*=friction;
  if(Math.abs(p.vx)<0.5) p.vx=0;
  if(Math.abs(p.vy)<0.5) p.vy=0;
  const s=Math.sqrt(p.vx*p.vx+p.vy*p.vy);
  if(s>spd){p.vx=p.vx/s*spd; p.vy=p.vy/s*spd;}
  let nx=p.x+p.vx*dt, ny=p.y+p.vy*dt;
  nx=Math.max(p.radius,Math.min(W-p.radius,nx));
  ny=Math.max(p.radius,Math.min(H-p.radius,ny));
  for(const w of gs.walls){
    const cx=Math.max(w.x,Math.min(nx,w.x+w.w));
    const cy=Math.max(w.y,Math.min(ny,w.y+w.h));
    const dx=nx-cx, dy=ny-cy, d=Math.sqrt(dx*dx+dy*dy);
    if(d<p.radius){const ov=p.radius-d+1; if(d>0){nx+=dx/d*ov;ny+=dy/d*ov;} Math.abs(dx)>Math.abs(dy)?p.vx*=-.3:p.vy*=-.3;}
  }
  p.x=nx; p.y=ny;

  const now=performance.now();
  const adrenMul = p.adrenalineTimer > 0 ? 0.5 : 1;
  const effDcd=p.dashCd*(p.upgrades.fastDash ? 0.6 : 1)*adrenMul;
  if(dash&&(now-p.lastDash)>effDcd){
    if(p.upgrades.teleport){
      // BLINK: short-range directional teleport in facing direction
      const bx=p.x+Math.cos(p.angle)*280, by=p.y+Math.sin(p.angle)*280;
      let tx=Math.max(p.radius,Math.min(W-p.radius,bx));
      let ty=Math.max(p.radius,Math.min(H-p.radius,by));
      // Shorten blink until not inside a wall
      if(isInsideWall(tx,ty,p.radius,gs.walls)){
        for(let step=0.9;step>0.1;step-=0.1){
          tx=Math.max(p.radius,Math.min(W-p.radius,p.x+Math.cos(p.angle)*280*step));
          ty=Math.max(p.radius,Math.min(H-p.radius,p.y+Math.sin(p.angle)*280*step));
          if(!isInsideWall(tx,ty,p.radius,gs.walls)) break;
        }
      }
      addDashTrail(gs,p.x,p.y,tx,ty,p.color);
      p.x=tx; p.y=ty;
      sparks(gs,p.x,p.y,p.color,20,200);
    } else {
      const dl=Math.sqrt(ax*ax+ay*ay);
      const ddx=dl>.1?ax/dl:Math.cos(p.angle), ddy=dl>.1?ay/dl:Math.sin(p.angle);
      const dashPow=p.upgrades.boots?1600:1500; // Longer base dash (was 1200/1300)
      addDashTrail(gs,p.x,p.y,p.x+ddx*80,p.y+ddy*80,p.color);
      p.vx=ddx*dashPow; p.vy=ddy*dashPow;
    }
    p.lastDash=now; p.invuln=160; sparks(gs,p.x,p.y,p.color,10,110);
  }
  if(p.invuln>0) p.invuln-=dt*1000;
  if(p.invisTimer>0){ p.invisTimer-=dt*1000; if(p.invisTimer<=0) p.invisTimer=0; }
  if(p.adrenalineTimer>0){ p.adrenalineTimer-=dt*1000; if(p.adrenalineTimer<=0) p.adrenalineTimer=0; }
  if(gs.wards){gs.wards=gs.wards.filter(w=>{w.timer-=dt*1000;return w.timer>0;});}

  // Nova ring expand
  if(p.novaOn){
    p.novaR+=dt*340; p.novaLife-=dt*1000;
    if(p.novaLife<=0||p.novaR>240){ p.novaOn=false; }
    else if(!p.novaHit){
      for(const t of gs.players){
        if(isAlly(p,t,gs)||!t.alive) continue;
        const dx=p.novaX-t.x, dy=p.novaY-t.y, d=Math.sqrt(dx*dx+dy*dy);
        if(Math.abs(d-p.novaR)<36){
          dmgPlayer(gs,t,{dmg:35,owner:p.id,color:p.color});
          sparks(gs,t.x,t.y,p.color,18,140);
          p.novaHit=true;
          break;
        }
      }
      for(const camp of gs.camps){
        for(const mob of camp.mobs){
          if(!mob.alive) continue;
          const dx=p.novaX-mob.x, dy=p.novaY-mob.y, d=Math.sqrt(dx*dx+dy*dy);
          if(Math.abs(d-p.novaR)<36){
            mob.hp-=35;
            sparks(gs,mob.x,mob.y,p.color,10,100);
            if(mob.hp<=0){ mob.alive=false; sparks(gs,mob.x,mob.y,mob.color,20,160); }
          }
        }
      }
    }
  }

  if(p.swordTimer>0){p.swordTimer-=dt*1000; p.swordSweep=1-(p.swordTimer/300); if(p.swordTimer<=0){p.swordOn=false;p.swordTimer=0;}}

  if(p.upgrades.regen){p.regenT+=dt*1000; if(p.regenT>850){p.hp=Math.min(p.maxHp,p.hp+1);p.regenT=0;}}
  if(p.upgrades.vitality){p.regenT2=(p.regenT2||0)+dt*1000; if(p.regenT2>500){p.hp=Math.min(p.maxHp,p.hp+1);p.regenT2=0;}}

  if(p.overchargeTimer>0) p.overchargeTimer-=dt*1000;
  if(p.smokeTimer>0){
    p.smokeTimer-=dt*1000;
    if(Math.random()<0.3) sparks(gs,p.smokeX+(Math.random()-.5)*80,p.smokeY+(Math.random()-.5)*80,'#555555',1,30);
  }
  if(p.barrierOn){
    p.barrierTimer-=dt*1000;
    if(p.barrierTimer<=0||p.barrierHp<=0){p.barrierOn=false;p.barrierTimer=0;p.barrierHp=0;}
    for(let bi=0;bi<gs.bullets.length;bi++){
      const b=gs.bullets[bi];
      if(b.life<=0) continue;
      if(isAlly(p,{team:gs.players.find(pp=>pp.id===b.owner)?.team,id:b.owner},gs)) continue;
      const dx=b.x-p.x, dy=b.y-p.y;
      if(dx*dx+dy*dy<(p.radius+35)*(p.radius+35)){
        p.barrierHp-=b.dmg;
        sparks(gs,b.x,b.y,'#cc44ff',6,60);
        b.life=0;
      }
    }
  }

  if(p.drainTimer>0) p.drainTimer-=dt*1000;
  if(p.minions){
    for(const m of p.minions){
      if(m.spawnAnim>0) m.spawnAnim=Math.max(0,m.spawnAnim-dt*3);
    }
  }

  if(p.hookOn){
    p.hookTimer-=dt*1000;
    if(p.hookReturning){
      const dx=p.x-p.hookX, dy=p.y-p.hookY;
      const d=Math.sqrt(dx*dx+dy*dy);
      if(d<p.radius+10){
        p.hookOn=false;
      } else {
        const spd2=900;
        p.hookX+=(dx/d)*spd2*dt;
        p.hookY+=(dy/d)*spd2*dt;
        if(p.hookTarget){
          const t=gs.players.find(pp=>pp.id===p.hookTarget);
          if(t&&t.alive){
            t.x+=(p.x-t.x)*dt*6;
            t.y+=(p.y-t.y)*dt*6;
            t.vx=0; t.vy=0;
          }
        }
      }
    } else {
      p.hookX+=p.hookVx*dt;
      p.hookY+=p.hookVy*dt;
      if(!p.hookHit){
        for(const t of gs.players){
          if(isAlly(p,t,gs)||!t.alive||t.invuln>0) continue;
          const dx=t.x-p.hookX, dy=t.y-p.hookY;
          if(dx*dx+dy*dy<(t.radius+12)*(t.radius+12)){
            p.hookHit=true;
            p.hookTarget=t.id;
            p.hookReturning=true;
            dmgPlayer(gs,t,{dmg:30,owner:p.id,color:p.color});
            sparks(gs,t.x,t.y,p.color,20,160);
            addImpactRing(t.x,t.y,p.color,100);
            shakeIntensity=Math.max(shakeIntensity,8);
            // Show "HOOKED!" near the target for the hooker
            if(p.isHuman) addDmgNumber(t.x,t.y-20,'HOOKED!','#00ff88',true);
            // Notify the hooked player personally
            if(t.isHuman && typeof showCenterAlert==='function'){
              showCenterAlert('HOOKED!','#00f5ff',1400);
              if(typeof triggerScreenFlash==='function') triggerScreenFlash('#00f5ff',0.35);
              shakeIntensity=Math.max(shakeIntensity,12);
            }
            break;
          }
        }
      }
      let wallHit=false;
      for(const w of gs.walls){
        if(p.hookX>=w.x&&p.hookX<=w.x+w.w&&p.hookY>=w.y&&p.hookY<=w.y+w.h){wallHit=true;break;}
      }
      if(p.hookTimer<=0||wallHit||p.hookX<0||p.hookX>W||p.hookY<0||p.hookY>H){
        p.hookReturning=true;
      }
    }
  }

  if(p.fortifyTimer>0) p.fortifyTimer-=dt*1000;
  updateStreakTimers(p,dt);
  if(p.glowTimer>0) p.glowTimer-=dt*1000;

  const d=CDEFS[p.cls];
  let fr2=p.upgrades.rapidFire?d.fireRate*.58:p.upgrades.heavy?d.fireRate*1.8:d.fireRate;
  if(p.overchargeTimer>0) fr2*=0.33;

  // ── RANGER CHARGED SNIPE ──
  if(p.cls==='ranger'){
    if(shoot){
      if(!p.charging){
        p.charging=true; p.chargeTimer=0; p.chargeStartTime=now; p.chargeAngle=p.angle;
      }
      p.chargeTimer+=dt*1000;
      p.chargeAngle=p.angle;
      if(p.chargeTimer>200 && Math.random()<0.3){
        const ca=p.chargeAngle;
        gs.particles.push({x:p.x+Math.cos(ca)*(p.radius+20)+(Math.random()-0.5)*8,
          y:p.y+Math.sin(ca)*(p.radius+20)+(Math.random()-0.5)*8,
          vx:-Math.cos(ca)*30,vy:-Math.sin(ca)*30,life:0.4,ml:0.3,col:'#ff3333',sz:2+Math.random()*2});
      }
      if(p.chargeTimer>=1200){
        fireChargedSnipe(gs,p);
        p.charging=false; p.chargeTimer=0; p.lastShot=now;
        if(p.isHuman) gs.stats.shots++;
      }
    } else {
      if(p.charging){
        if(p.chargeTimer>200){
          fireBullet(gs,p,p.angle);
          if(p.upgrades.doubleShot){fireBullet(gs,p,p.angle+.13);fireBullet(gs,p,p.angle-.13);}
          p.lastShot=now;
          if(p.isHuman) gs.stats.shots++;
        }
        p.charging=false; p.chargeTimer=0;
      }
    }
  } else if(shoot&&(now-p.lastShot)>fr2){
    if(p.cls==='assassin'){
      fireSword(gs,p);
      p.swordOn=true; p.swordAngle=p.angle; p.swordSweep=0; p.swordTimer=220;
    } else {
      fireBullet(gs,p,p.angle);
      if(p.upgrades.doubleShot){fireBullet(gs,p,p.angle+.13);fireBullet(gs,p,p.angle-.13);}
    }
    p.lastShot=now;
    if(p.isHuman) gs.stats.shots++;
  }
}
