// ═══════════════════════════════════════════════════════════════
// ENGINE.JS — Core game loop, input, screen management, match logic
// ═══════════════════════════════════════════════════════════════

// ── CANVAS & VIEWPORT ──
const canvas = document.getElementById('gameCanvas');
const ctx = (typeof _overlayCtx !== 'undefined') ? _overlayCtx
  : canvas.getContext('2d', { alpha: false, powerPreference: 'high-performance' });
let VW, VH;
var CAM_ZOOM = 1.3;
function resize(){
  VW = window.innerWidth; VH = window.innerHeight;
  if (typeof _overlayCanvas !== 'undefined') {
    _overlayCanvas.width = VW; _overlayCanvas.height = VH;
    if (typeof onResizeRenderer === 'function') onResizeRenderer(VW, VH);
  } else {
    canvas.width = VW; canvas.height = VH;
  }
}
resize();
window.addEventListener('resize', resize);

// var (not let) — makes these window properties so other scripts can read them
var W=9600, H=5400;
var camX=0, camY=0;

// ── INPUT STATE ──
const K={};
const M={x:0,y:0,down:false,rdown:false};
window.addEventListener('keydown',e=>{K[e.code]=true;
  if(e.code==='KeyE'&&gameRunning&&gameState&&!gameState.gameOver){
    if(gameState.shopOpen) closeShop();
    else if(isInShopZone(getLocalPlayer(gameState),gameState)) openShop();
  }
  if(e.code==='KeyQ'){if(gameRunning&&gameState&&!gameState.shopOpen) doSpecial();}
  if(e.code==='KeyF'){if(gameRunning&&gameState&&!gameState.shopOpen) doSecondary();}
  if(e.code==='KeyR'){if(gameRunning&&gameState&&!gameState.shopOpen) doUltimate();}
  // Consumable hotkeys 1-5
  if(e.code>='Digit1'&&e.code<='Digit5'){
    const slot=parseInt(e.code.replace('Digit',''))-1;
    useConsumableSlot(slot);
  }
});
window.addEventListener('keyup',e=>{K[e.code]=false;});
canvas.addEventListener('mousemove',e=>{M.x=e.clientX;M.y=e.clientY;});
canvas.addEventListener('mousedown',e=>{if(e.button===0)M.down=true;if(e.button===2)M.rdown=true;});
canvas.addEventListener('mouseup',e=>{if(e.button===0)M.down=false;if(e.button===2)M.rdown=false;});
canvas.addEventListener('contextmenu',e=>e.preventDefault());

// ── GAME MODE ──
// var (not let) — window property, accessible from inline onclick handlers and setMode()
var teamMode = false;

// Called by inline onclick attributes in game.html.
// `let` variables are not window properties so onclick strings can't write them directly.
function setMode(pm, tm) {
  playMode = pm;
  teamMode = tm;
  showClassSelect();
}

// ── SCREEN MANAGEMENT ──
// var (not const) — hoisted before any code runs, no TDZ risk
var SCREENS = ['menuScreen','classScreen','mmScreen','shopScreen','resultScreen','lbScreen','tutorialScreen','loadingScreen'];
function showScreen(id){
  SCREENS.forEach(s=>document.getElementById(s).classList.add('hidden'));
  if(id) document.getElementById(id).classList.remove('hidden');
  document.getElementById('hud').classList.add('hidden');
}
function showMenu(){ gameRunning=false; showScreen('menuScreen'); document.getElementById('menuElo').textContent=PD.elo; }
function showLeaderboard(){ showScreen('lbScreen'); renderLB(); }
function showTutorial(){ showScreen('tutorialScreen'); }

var selectedCls = null;
function showClassSelect(){
  selectedCls=null;
  document.querySelectorAll('.class-card').forEach(c=>c.classList.remove('selected'));
  const b=document.getElementById('confirmBtn'); b.style.opacity='.4'; b.style.pointerEvents='none';
  showScreen('classScreen');
}
function selectClass(cls){
  selectedCls=cls;
  document.querySelectorAll('.class-card').forEach(c=>c.classList.remove('selected'));
  document.querySelector('.class-card.'+cls).classList.add('selected');
  const b=document.getElementById('confirmBtn'); b.style.opacity='1'; b.style.pointerEvents='all';
}
function confirmClass(){
  if(!selectedCls)return;
  PD.cls=selectedCls; savePD(); showMM();
}
function showMM(){
  showScreen('mmScreen');
  document.getElementById('mmElo').textContent=PD.elo;
  if(playMode==='online'){
    if(ws&&ws.readyState===1){
      document.getElementById('mmInfo').textContent='Searching for opponent online…';
      ws.send(JSON.stringify({type:'queue',name:PD.name,cls:selectedCls||PD.cls,elo:PD.elo}));
    } else {
    document.getElementById('mmInfo').textContent='Server not connected. Please refresh and try again.';
      document.getElementById('onlineBtn').style.opacity='.4';
      document.getElementById('onlineBtn').style.pointerEvents='none';
    }
  } else if(playMode==='practice'){
    document.getElementById('mmInfo').textContent='Setting up practice arena…';
    setTimeout(()=>{ if(typeof applyMapForMode==='function') applyMapForMode('practice'); document.getElementById('mmInfo').textContent='Ready! All items free. No time limit.'; setTimeout(startPractice,500); }, 600);
  } else if(playMode==='local2p'){
    document.getElementById('mmInfo').textContent='Setting up local 2P match…';
    setTimeout(()=>{ if(typeof applyMapForMode==='function') applyMapForMode('local2p'); document.getElementById('mmInfo').textContent='Ready! Player 2 uses Arrow Keys + Enter/Numpad'; setTimeout(startLocal2P,700); }, 800);
  } else if(playMode==='3v3'){
    document.getElementById('mmInfo').textContent='Assembling 3v3 teams…';
    setTimeout(()=>{ if(typeof applyMapForMode==='function') applyMapForMode('3v3'); document.getElementById('mmInfo').textContent='Teams ready! Loading arena…'; setTimeout(start3v3Game,700); }, 1200+Math.random()*1000);
  } else {
    document.getElementById('mmInfo').textContent=teamMode?'Assembling teams…':'Searching near rating '+PD.elo+'…';
    setTimeout(()=>{ if(typeof applyMapForMode==='function') applyMapForMode('offline'); document.getElementById('mmInfo').textContent='Found '+(teamMode?'match':'opponent')+'! Loading…'; setTimeout(startGame,700); }, 1200+Math.random()*1400);
  }
}
function renderLB(){
  const icons={gunner:'🔫',assassin:'⚔️',mage:'🔮',tank:'🛡',necro:'💀',ranger:'🏹'};
  let lb=[...LB];
  const me={name:PD.name+' ★',cls:PD.cls,elo:PD.elo,wins:PD.wins,losses:PD.losses};
  lb.push(me); lb.sort((a,b)=>b.elo-a.elo);
  const rank=lb.findIndex(e=>e.name===me.name)+1;
  document.getElementById('yourRank').textContent='#'+rank+' of '+lb.length;
  const body=document.getElementById('lbBody'); body.innerHTML='';
  lb.slice(0,12).forEach((e,i)=>{
    const tr=document.createElement('tr');
    const rc=i===0?'rank-1':i===1?'rank-2':i===2?'rank-3':'';
    const isMe=e.name===me.name;
    tr.innerHTML=`<td class="${rc}" style="${isMe?'color:var(--cyan)':''}">${i+1}</td>
      <td style="${isMe?'color:var(--cyan);font-weight:700':''}">${e.name}</td>
      <td>${e.elo}</td><td>${e.wins}/${e.losses}</td>
      <td>${icons[e.cls]||'?'} ${(e.cls||'').toUpperCase()}</td>`;
    body.appendChild(tr);
  });
}

// ── SHOP ZONE CHECK ──
function isInShopZone(p, gs){
  // Practice mode — shop accessible from anywhere
  if(typeof practiceMode!=='undefined'&&practiceMode) return true;
  const zones = gs.shopZones || [gs.shopZone];
  for(const sz of zones){
    if(p.x>=sz.x && p.x<=sz.x+sz.w && p.y>=sz.y && p.y<=sz.y+sz.h) return true;
  }
  // Also check tower shop zones
  if(gs.towerShops){
    for(const sz of gs.towerShops){
      if(p.x>=sz.x-10 && p.x<=sz.x+sz.w+10 && p.y>=sz.y-10 && p.y<=sz.y+sz.h+10) return true;
    }
  }
  return false;
}

// ── STREAK SYSTEM ──
function checkStreak(gs, p){
  for(const s of STREAKS){
    if(p.killStreak === s.threshold){
      activateStreakBonus(gs, p, s);
    }
  }
  if(p.killStreak > (gs.stats.bestStreak||0) && p.isHuman) gs.stats.bestStreak = p.killStreak;
}

function activateStreakBonus(gs, p, streak){
  if(streak.threshold===3){
    p.streakDmgBoost=1.25; p.streakDmgTimer=streak.duration;
    sparks(gs,p.x,p.y,'#ff4444',30,200); shakeIntensity=Math.max(shakeIntensity,6);
  } else if(streak.threshold===5){
    p.streakSpdBoost=1.4; p.streakSpdTimer=streak.duration;
    sparks(gs,p.x,p.y,'#00ff88',30,200); shakeIntensity=Math.max(shakeIntensity,6);
  } else if(streak.threshold===7){
    p.hp=p.maxHp; p.shield=50;
    sparks(gs,p.x,p.y,'#ffaa00',50,300); sparks(gs,p.x,p.y,'#ffffff',25,200);
    shakeIntensity=Math.max(shakeIntensity,12);
  }
}

function updateStreakTimers(p, dt){
  if(p.streakDmgTimer>0){ p.streakDmgTimer-=dt*1000; if(p.streakDmgTimer<=0){p.streakDmgBoost=1;p.streakDmgTimer=0;} }
  if(p.streakSpdTimer>0){ p.streakSpdTimer-=dt*1000; if(p.streakSpdTimer<=0){p.streakSpdBoost=1;p.streakSpdTimer=0;} }
}

// ── CAMP/MOB UPDATE ──
function updCamps(gs,dt,now){
  for(const camp of gs.camps){
    // Check individual mob death for gold drops
    for(const mob of camp.mobs){
      if(!mob.alive && !mob._goldGiven){
        mob._goldGiven = true;
        // Give gold from individual mob kill to nearest player
        let closest=null, minD=250*250;
        for(const p of gs.players){
          if(!p.alive) continue;
          const dx=p.x-mob.x, dy=p.y-mob.y, d2=dx*dx+dy*dy;
          if(d2<minD){minD=d2;closest=p;}
        }
        if(closest){
          const mobGold = mob.gold || 10;
          closest.energy += mobGold;
          if(closest.isHuman){ gs.stats.en+=mobGold; addGoldFloat(mob.x,mob.y,mobGold); }
        }
      }
    }
    let allDead=true; for(let _cm=0;_cm<camp.mobs.length;_cm++){if(camp.mobs[_cm].alive){allDead=false;break;}}
    if(allDead && !camp.dead){
      camp.dead=true; camp.deathTime=now;
      if (typeof grantCampXP === 'function' && playMode !== 'online') grantCampXP(gs, camp.type);
      // Award camp bonus gold to nearby players
      for(const p of gs.players){
        if(!p.alive) continue;
        const dx=p.x-camp.x, dy=p.y-camp.y;
        if(dx*dx+dy*dy<250*250){
          p.energy+=camp.gold;
          if(p.isHuman){ gs.stats.en+=camp.gold; addGoldFloat(camp.x,camp.y,camp.gold); }
        }
      }
    }
    if(camp.dead && now-camp.deathTime>camp.respawnTime){
      camp.dead=false;
      camp.mobs.forEach((m,i)=>{
        const angle=Math.PI*2*i/camp.mobs.length;
        const spread=camp.mobs.length>1?28:0;
        Object.assign(m, mkMob(camp.type,camp.x+Math.cos(angle)*spread,camp.y+Math.sin(angle)*spread));
        m._goldGiven = false;
      });
    }
    for(const mob of camp.mobs){
      if(!mob.alive) continue;
      updMob(gs,mob,dt,now);
    }
  }
}

// ── TOWER UPDATE ──
function updTowers(gs,dt,now){
  if(!gs.towers || !gs.towers.length) return;
  for(const tower of gs.towers){
    if(tower.hp<=0) continue;
    // Find nearest enemy player
    let target=null, minD2=tower.atkRange*tower.atkRange;
    for(const p of gs.players){
      if(!p.alive || p.team===tower.team) continue;
      const dx=p.x-tower.x, dy=p.y-tower.y, d2=dx*dx+dy*dy;
      if(d2<minD2){minD2=d2;target=p;}
    }
    if(target && now-tower.lastAtk>tower.atkCd){
      tower.lastAtk=now;
      const dx=target.x-tower.x, dy=target.y-tower.y;
      const angle=Math.atan2(dy,dx);
      gs.mobBullets.push({
        x:tower.x+Math.cos(angle)*tower.radius,
        y:tower.y+Math.sin(angle)*tower.radius,
        vx:Math.cos(angle)*tower.projSpeed,
        vy:Math.sin(angle)*tower.projSpeed,
        dmg:tower.dmg, r:8, life:1200,
        color:tower.projColor, type:'tower',
        towerTeam:tower.team
      });
      sparks(gs,tower.x,tower.y,tower.color,8,60);
    }
  }
}

function updMob(gs,mob,dt,now){

  // ── SHAMAN: heal nearby camp mobs ──
  if(mob.healer && mob.healRange){
    if(!mob.lastHeal) mob.lastHeal=0;
    if(now-mob.lastHeal>(mob.healCd||3000)){
      for(const camp of gs.camps){
        for(const m2 of camp.mobs){
          if(m2===mob||!m2.alive||m2.hp>=m2.maxHp) continue;
          const dx2=m2.x-mob.x,dy2=m2.y-mob.y;
          if(dx2*dx2+dy2*dy2<(mob.healRange*mob.healRange)){
            m2.hp=Math.min(m2.maxHp,m2.hp+(mob.healAmount||8));
            sparks(gs,m2.x,m2.y,'#ffdd44',6,40);
            mob.lastHeal=now;
          }
        }
      }
    }
  }

  // ── BANSHEE: scream AoE ──
  if(mob.scream){
    if(!mob.lastScream) mob.lastScream=0;
    if(now-mob.lastScream>(mob.screamCd||4000)){
      let screamed=false;
      for(const p of gs.players){
        if(!p.alive||p.invuln>0) continue;
        const dx2=p.x-mob.x,dy2=p.y-mob.y;
        if(dx2*dx2+dy2*dy2<(mob.screamRange||120)*(mob.screamRange||120)){
          dmgPlayer(gs,p,{dmg:mob.screamDmg||15,owner:-1,color:'#aabbff'});
          addDmgNumber(p.x,p.y-10,'👻 SCREAM','#aabbff',true);
          screamed=true;
        }
      }
      if(screamed){
        mob.lastScream=now;
        sparks(gs,mob.x,mob.y,'#aabbff',20,120);
        shakeIntensity=Math.max(shakeIntensity,4);
      }
    }
  }

  // ── INFERNAL: fire field ──
  if(mob.firefield){
    if(!mob.lastFirefield) mob.lastFirefield=0;
    if(now-mob.lastFirefield>(mob.firefieldCd||5000)){
      let burned=false;
      for(const p of gs.players){
        if(!p.alive||p.invuln>0) continue;
        const dx2=p.x-mob.x,dy2=p.y-mob.y;
        if(dx2*dx2+dy2*dy2<(mob.firefieldRadius||80)*(mob.firefieldRadius||80)){
          dmgPlayer(gs,p,{dmg:mob.firefieldDmg||5,owner:-1,color:'#ff4400'});
          addDmgNumber(p.x,p.y-10,'🔥','#ff4400',false);
          burned=true;
        }
      }
      if(burned){
        mob.lastFirefield=now;
        sparks(gs,mob.x,mob.y,'#ff4400',30,mob.firefieldRadius||80);
      }
    }
  }

  // Find closest player to aggro
  const leash=mob.leashRange||250;
  let target=null, minD2=leash*leash;
  for(const p of gs.players){
    if(!p.alive) continue;
    const dx=p.x-mob.x, dy=p.y-mob.y, d2=dx*dx+dy*dy;
    if(d2<minD2){minD2=d2;target=p;}
  }

  // ── MINOTAUR: charge attack ──
  if(mob.charge && target && !mob._charging){
    const dx=target.x-mob.x,dy=target.y-mob.y,d=Math.sqrt(dx*dx+dy*dy);
    if(d<(mob.chargeRange||300) && d>mob.atkRange*1.5 && now-mob.lastAtk>mob.atkCd*2){
      mob._charging=true;
      mob._chargeTarget={x:target.x,y:target.y};
      mob._chargeTimer=0;
    }
  }
  if(mob._charging){
    const ct=mob._chargeTarget;
    const dx=ct.x-mob.x,dy=ct.y-mob.y,d=Math.sqrt(dx*dx+dy*dy);
    const cspd=mob.chargeSpeed||350;
    mob.vx=(dx/Math.max(1,d))*cspd;
    mob.vy=(dy/Math.max(1,d))*cspd;
    mob._chargeTimer+=dt*1000;
    sparks(gs,mob.x,mob.y,mob.color,2,30);
    // Hit players during charge
    for(const p of gs.players){
      if(!p.alive||p.invuln>0) continue;
      const pdx=p.x-mob.x,pdy=p.y-mob.y;
      if(pdx*pdx+pdy*pdy<(p.radius+mob.radius+10)*(p.radius+mob.radius+10)){
        dmgPlayer(gs,p,{dmg:mob.chargeDmg||45,owner:-1,color:mob.color});
        addDmgNumber(p.x,p.y-20,'🐂 CHARGE!',mob.color,true);
        sparks(gs,p.x,p.y,mob.color,20,120);
        shakeIntensity=Math.max(shakeIntensity,8);
        mob._charging=false;
        mob.lastAtk=now;
        break;
      }
    }
    if(d<20||mob._chargeTimer>1500) mob._charging=false;
    mob.x+=mob.vx*dt; mob.y+=mob.vy*dt;
    mob.x=Math.max(mob.radius,Math.min(W-mob.radius,mob.x));
    mob.y=Math.max(mob.radius,Math.min(H-mob.radius,mob.y));
    return;
  }

  if(target){
    mob.aggroTarget=target.id;
    const dx=target.x-mob.x, dy=target.y-mob.y, d=Math.sqrt(dx*dx+dy*dy);
    if(mob.ranged){
      const idealDist=mob.atkRange*0.7;
      if(d<idealDist*0.5){ mob.vx=-(dx/d)*mob.speed; mob.vy=-(dy/d)*mob.speed; }
      else if(d>mob.atkRange*0.9){ mob.vx=(dx/d)*mob.speed; mob.vy=(dy/d)*mob.speed; }
      else { mob.vx*=.85; mob.vy*=.85; }
      if(now-mob.lastAtk>mob.atkCd && d<=mob.atkRange){
        mob.lastAtk=now;
        const angle=Math.atan2(dy,dx);
        const pSpd=mob.projSpeed||300;
        if(mob.cone && mob.coneCount){
          for(let i=0;i<mob.coneCount;i++){
            const spread=(i-(mob.coneCount-1)/2)*0.2;
            gs.mobBullets.push({ x:mob.x+Math.cos(angle+spread)*mob.radius, y:mob.y+Math.sin(angle+spread)*mob.radius,
              vx:Math.cos(angle+spread)*pSpd, vy:Math.sin(angle+spread)*pSpd, dmg:mob.dmg, r:8, life:1200,
              color:mob.projColor||mob.color, type:'fire' });
          }
          sparks(gs,mob.x,mob.y,'#ff6600',15,100); shakeIntensity=Math.max(shakeIntensity,3);
        } else if(mob.chain){
          gs.mobBullets.push({ x:mob.x+Math.cos(angle)*mob.radius, y:mob.y+Math.sin(angle)*mob.radius,
            vx:Math.cos(angle)*pSpd, vy:Math.sin(angle)*pSpd, dmg:mob.dmg, r:6, life:800,
            color:mob.projColor||mob.color, type:'lightning' });
          sparks(gs,mob.x,mob.y,'#4488ff',12,90);
        } else {
          gs.mobBullets.push({ x:mob.x+Math.cos(angle)*mob.radius, y:mob.y+Math.sin(angle)*mob.radius,
            vx:Math.cos(angle)*pSpd, vy:Math.sin(angle)*pSpd, dmg:mob.dmg, r:5, life:1500,
            color:mob.projColor||mob.color, type:'bolt' });
        }
      }
    } else {
      if(d>mob.atkRange){ mob.vx=(dx/d)*mob.speed; mob.vy=(dy/d)*mob.speed; }
      else {
        mob.vx*=.8; mob.vy*=.8;
        if(now-mob.lastAtk>mob.atkCd){
          mob.lastAtk=now;
          if(mob.aoe){
            const aoeR=mob.aoeRadius||70;
            for(const p of gs.players){
              if(!p.alive||p.invuln>0) continue;
              const pdx=p.x-mob.x, pdy=p.y-mob.y;
              if(pdx*pdx+pdy*pdy<aoeR*aoeR){
                dmgPlayer(gs,p,{dmg:mob.dmg,owner:-1,color:mob.color});
                addDmgNumber(p.x,p.y-10,mob.dmg,mob.color,false);
              }
            }
            sparks(gs,mob.x,mob.y,mob.color,25,150); shakeIntensity=Math.max(shakeIntensity,4);
          } else {
            let meleeDmg=mob.dmg;
            // Vampire lifesteal
            if(mob.lifesteal){
              const heal=Math.round(meleeDmg*mob.lifesteal);
              mob.hp=Math.min(mob.maxHp,mob.hp+heal);
              sparks(gs,mob.x,mob.y,'#cc0033',5,30);
            }
            // Spider poison
            if(mob.poison){
              addDmgNumber(target.x,target.y-20,'☠ POISON','#44aa44',true);
            }
            dmgPlayer(gs,target,{dmg:meleeDmg,owner:-1,color:mob.color});
            sparks(gs,target.x,target.y,mob.color,8,70);
            addDmgNumber(target.x,target.y-10,meleeDmg,mob.color,false);
          }
        }
      }
    }
  } else {
    const dx=mob.homeX-mob.x, dy=mob.homeY-mob.y, d=Math.sqrt(dx*dx+dy*dy);
    if(d>5){mob.vx=(dx/d)*mob.speed*.5; mob.vy=(dy/d)*mob.speed*.5;}
    else{mob.vx*=.9; mob.vy*=.9;}
    mob.aggroTarget=null;
    if(d<20 && mob.hp<mob.maxHp) mob.hp=Math.min(mob.maxHp,mob.hp+dt*15);
  }
  mob.x+=mob.vx*dt; mob.y+=mob.vy*dt;
  mob.x=Math.max(mob.radius,Math.min(W-mob.radius,mob.x));
  mob.y=Math.max(mob.radius,Math.min(H-mob.radius,mob.y));

  // ── PHOENIX: revive once on death ──
  if(mob.revive && !mob.alive && !mob._revived){
    mob._revived=true;
    mob.alive=true;
    mob.hp=Math.round(mob.maxHp*(mob.reviveHp||0.5));
    sparks(gs,mob.x,mob.y,'#ff6600',30,180);
    addDmgNumber(mob.x,mob.y-20,'🔱 REBORN!','#ff4400',true);
    shakeIntensity=Math.max(shakeIntensity,6);
  }
}

// ── MOB BULLET UPDATE (includes tower bullets) ──
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
      // Tower bullets don't hit allies
      if(mb.towerTeam && p.team===mb.towerTeam) continue;
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
        if (typeof grantOrbXP === 'function' && playMode !== 'online') grantOrbXP(gs, p);
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
        p.vx=0; p.vy=0; p.invuln=-trap.rootDuration;
        sparks(gs,trap.x,trap.y,'#ff8833',25,180); sparks(gs,trap.x,trap.y,'#ffcc66',15,120);
        addImpactRing(trap.x,trap.y,'#ff8833',60);
        addDmgNumber(p.x,p.y-20,'🪤 TRAPPED!','#ff8833',true);
        shakeIntensity=Math.max(shakeIntensity,8); triggerScreenFlash('#ff8833',0.15);
        break;
      }
    }
    for(const camp of gs.camps){
      if(!trap.armed) break;
      for(const mob of camp.mobs){
        if(!mob.alive) continue;
        const dx=mob.x-trap.x,dy=mob.y-trap.y;
        if(dx*dx+dy*dy<(mob.radius+trap.radius)*(mob.radius+trap.radius)){
          trap.armed=false; mob.hp-=trap.dmg; mob.vx=0; mob.vy=0;
          if(mob.hp<=0){mob.alive=false;sparks(gs,mob.x,mob.y,mob.color,20,160);}
          sparks(gs,trap.x,trap.y,'#ff8833',20,140); addImpactRing(trap.x,trap.y,'#ff8833',50);
          break;
        }
      }
    }
  }
}

// ── SPECIAL & ULTIMATE WRAPPERS ──
function doSpecial(){
  const p=getLocalPlayer(gameState); if(!p||!p.alive)return;
  const now=performance.now();
  const adrenMul = p.adrenalineTimer > 0 ? 0.5 : 1;
  if(now-p.lastSp<p.spCd*adrenMul)return;
  p.lastSp=now;
  gameState.stats.spec++;
  if(playMode==='online'&&ws&&ws.readyState===1) ws.send(JSON.stringify({type:'special'}));
  if(typeof sfxSpecial==='function') sfxSpecial(p.cls);
  triggerSpecial(gameState,p);
}
function doUltimate(){
  const p=getLocalPlayer(gameState); if(!p||!p.alive)return;
  const now=performance.now();
  const ultAdren = p.adrenalineTimer > 0 ? 0.5 : 1;
  if(now-p.lastUlt<p.ultCd*ultAdren)return;
  p.lastUlt=now;
  if(playMode==='online'&&ws&&ws.readyState===1) ws.send(JSON.stringify({type:'useUltimate'}));
  if(typeof sfxUltimate==='function') sfxUltimate();
  triggerUltimate(gameState,p);
}
function doSecondary(){
  const p=getLocalPlayer(gameState); if(!p||!p.alive)return;
  const now=performance.now();
  if(now-(p.lastSec||-9999)<(p.secCd||7000))return;
  p.lastSec=now;
  if(playMode==='online'&&ws&&ws.readyState===1) ws.send(JSON.stringify({type:'secondary'}));
  triggerSecondary(gameState,p);
}

// ── GAME STATE ──
var gameRunning=false, gameState=null, lastT=0;

// ── FPS MODE ──
// Uses requestAnimationFrame (vsync). MessageChannel path removed — UNCAP_FPS was always false.
function _scheduleFrame(fn) { requestAnimationFrame(fn); }

// ── SPRITE PRELOAD GATE ──
// Waits for all sprites (including custom map sheets) to finish loading
// before kicking off the game loop. Shows a loading screen with a progress bar.
function waitThenStart(loopFn) {
  const allReady = () => spritesReady && (typeof _globalSpritesResolved === 'undefined' || _globalSpritesResolved);
  function launch() {
    showScreen(null);
    // Upload all sheets to the GPU before the first game frame — eliminates mid-match texture hitch
    if (typeof prewarmPixiTextures === 'function') {
      prewarmPixiTextures().then(() => requestAnimationFrame(loopFn));
    } else {
      requestAnimationFrame(loopFn);
    }
  }
  if (allReady()) { launch(); return; }
  // Show loading screen while sprites decode
  document.getElementById('hud').classList.add('hidden');
  showScreen('loadingScreen');
  const bar  = document.getElementById('loadingBar');
  const pct  = document.getElementById('loadingPct');
  const info = document.getElementById('loadingInfo');
  const iv = setInterval(() => {
    const loaded = Math.min(spritesLoadedCount, spriteSheetsTotal);
    const total  = spriteSheetsTotal || 1;
    const p = Math.round(loaded / total * 100);
    if (bar)  bar.style.width  = p + '%';
    if (pct)  pct.textContent  = p + '%';
    if (info) info.textContent = loaded + ' / ' + total + ' sprites';
    if (allReady()) { clearInterval(iv); launch(); }
  }, 30);
}

function startGame(){
  showScreen(null);
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('pingDisplay').style.display='none';
  const modeEl=document.getElementById('hudMode');
  if(teamMode){ modeEl.textContent='2v2 TEAM'; modeEl.className='mode-badge mode-team'; }
  else { modeEl.textContent='OFFLINE'; modeEl.className='mode-badge mode-offline'; }
  const pcls = selectedCls||PD.cls||'gunner';
  const aiClasses=['gunner','assassin','mage','tank','necro','ranger'];
  if(teamMode){
    const allyCls=aiClasses[Math.floor(Math.random()*aiClasses.length)];
    const e1cls=aiClasses[Math.floor(Math.random()*aiClasses.length)];
    const e2cls=aiClasses[Math.floor(Math.random()*aiClasses.length)];
    gameState = makeTeamGS(pcls, allyCls, e1cls, e2cls);
  } else {
    const acls = aiClasses[Math.floor(Math.random()*aiClasses.length)];
    gameState = makeGS(pcls, acls);
  }
  comboCount=0;comboTimer=0;comboMultiplier=1;goldFloats=[];
  gameRunning=true; lastT=performance.now();
  waitThenStart(gameLoop);
}

// ── LOCAL 2P MODE ──
var p2Cls = null;
function startLocal2P(){
  showScreen(null);
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('pingDisplay').style.display='none';
  const modeEl=document.getElementById('hudMode');
  modeEl.textContent='LOCAL 2P'; modeEl.className='mode-badge mode-local';
  const p1cls = selectedCls||PD.cls||'gunner';
  const aiClasses=['gunner','assassin','mage','tank','necro','ranger'];
  const p2cls = aiClasses[Math.floor(Math.random()*aiClasses.length)];
  gameState = makeGS(p1cls, p2cls);
  gameState.local2p = true;
  gameState.players[1].isHuman = true;
  comboCount=0;comboTimer=0;comboMultiplier=1;goldFloats=[];
  gameRunning=true; lastT=performance.now();
  waitThenStart(gameLoop);
}

// ── 3v3 TEAM MODE ──
function start3v3Game(){
  showScreen(null);
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('pingDisplay').style.display='none';
  const modeEl=document.getElementById('hudMode');
  modeEl.textContent='3v3 TEAM'; modeEl.className='mode-badge mode-team';
  const pcls = selectedCls||PD.cls||'gunner';
  const aiClasses=['gunner','assassin','mage','tank','necro','ranger'];
  const pick=()=>aiClasses[Math.floor(Math.random()*aiClasses.length)];
  gameState = make3v3GS(pcls, pick(), pick(), pick(), pick(), pick());
  comboCount=0;comboTimer=0;comboMultiplier=1;goldFloats=[];
  gameRunning=true; lastT=performance.now();
  waitThenStart(gameLoop);
}

// ═══════════════════════════════════════════════════════════════
// PRACTICE MODE — Free items, training dummies, damage testing
// ═══════════════════════════════════════════════════════════════
var practiceMode = false;
var practiceDmgLogEnabled = false;
var practiceDummies = [];
var practiceDmgLogEntries = [];

function startPractice(){
  showScreen(null);
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('pingDisplay').style.display='none';
  document.getElementById('practiceToolbar').classList.remove('hidden');
  const modeEl=document.getElementById('hudMode');
  modeEl.textContent='PRACTICE'; modeEl.className='mode-badge mode-offline';
  modeEl.style.color='var(--green)'; modeEl.style.borderColor='var(--green)';
  const pcls = selectedCls||PD.cls||'gunner';
  gameState = makeGS(pcls, 'gunner');
  // Remove the AI player — practice is solo
  gameState.players = [gameState.players[0]];
  gameState.ai = [null];
  gameState.score = [0];
  // Infinite time
  gameState.matchTime = 999999;
  // Start with lots of energy
  gameState.players[0].energy = 999;
  // Practice flags
  practiceMode = true;
  practiceDummies = [];
  practiceDmgLogEntries = [];
  // Spawn a few dummies to start
  practiceSpawnDummyAt(W*0.5, H*0.35);
  practiceSpawnDummyAt(W*0.6, H*0.5);
  practiceSpawnDummyAt(W*0.4, H*0.5);

  comboCount=0;comboTimer=0;comboMultiplier=1;goldFloats=[];
  gameRunning=true; lastT=performance.now();
  waitThenStart(practiceGameLoop);
}

function practiceSpawnDummyAt(x, y){
  const dummy = {
    id: 900 + practiceDummies.length,
    x, y, vx:0, vy:0,
    cls:'tank', color:'#888888',
    radius: 18, speed: 0,
    hp: 200, maxHp: 200,
    shield: 0, angle: 0,
    alive: true, invuln: 0,
    isHuman: false, isDummy: true,
    killStreak:0, energy:0,
    upgrades:{}, team:0,
    fireRate:99999, lastShot:0,
    dashCd:99999, lastDash:-9999,
    spCd:99999, lastSp:-9999,
    secCd:99999, lastSec:-9999,
    ultCd:99999, lastUlt:-9999,
    swordOn:false, swordAngle:0, swordSweep:0, swordTimer:0,
    novaOn:false, novaR:0, novaLife:0, novaX:0, novaY:0, novaHit:false,
    overchargeTimer:0, smokeTimer:0, smokeX:0, smokeY:0,
    barrierOn:false, barrierTimer:0, barrierHp:0,
    hookOn:false, hookX:0, hookY:0, hookVx:0, hookVy:0, hookTimer:0,
    hookTarget:null, hookReturning:false, hookHit:false,
    fortifyTimer:0, streakDmgBoost:1, streakDmgTimer:0,
    streakSpdBoost:1, streakSpdTimer:0,
    glowTimer:0, glowColor:'#fff',
    minions:[], drainTimer:0,
    charging:false, chargeTimer:0, chargeAngle:0,
    dmgBoostTimer:0, spdBoostTimer:0, invisTimer:0, adrenalineTimer:0,
    consumables:[null,null,null,null,null],
    name:'DUMMY'
  };
  practiceDummies.push(dummy);
  gameState.players.push(dummy);
  gameState.ai.push(null);
  // Ensure score array is big enough
  while(gameState.score.length < gameState.players.length) gameState.score.push(0);
}

function practiceSpawnDummy(){
  const p = gameState.players[0];
  const dist = 200;
  const x = p.x + Math.cos(p.angle) * dist;
  const y = p.y + Math.sin(p.angle) * dist;
  practiceSpawnDummyAt(
    Math.max(20, Math.min(W-20, x)),
    Math.max(20, Math.min(H-20, y))
  );
  showUpgradeFanfare('TARGET DUMMY', '🎯');
}

function practiceClearDummies(){
  gameState.players = gameState.players.filter(p => !p.isDummy);
  practiceDummies = [];
  gameState.ai = gameState.players.map(() => null);
  while(gameState.score.length < gameState.players.length) gameState.score.push(0);
}

function practiceGiveEnergy(){
  const p = gameState.players[0];
  p.energy = Math.min(9999, p.energy + 500);
  showUpgradeFanfare('+500 ENERGY', '💰');
}

function practiceOpenShop(){
  openShop();
}

function practiceFullHeal(){
  const p = gameState.players[0];
  p.hp = p.maxHp;
  p.shield = p.upgrades.shield ? 30 : 0;
  p.alive = true;
  p.invuln = 500;
  sparks(gameState, p.x, p.y, '#00ff88', 25, 180);
  showUpgradeFanfare('FULL HEAL', '❤️');
  // Also respawn all dummies at full HP
  for(const d of practiceDummies){
    d.hp = d.maxHp; d.alive = true;
  }
}

function practiceResetCooldowns(){
  const p = gameState.players[0];
  p.lastShot = 0; p.lastDash = -9999; p.lastSp = -9999; p.lastSec = -9999; p.lastUlt = -9999;
  showUpgradeFanfare('COOLDOWNS RESET', '⚡');
}

function practiceResetUpgrades(){
  const p = gameState.players[0];
  const d = CDEFS[p.cls];
  p.upgrades = {};
  p.maxHp = d.hp; p.hp = d.hp; p.shield = 0;
  p.speed = d.speed; p.fireRate = d.fireRate;
  p.consumables = [null,null,null,null,null];
  p.dmgBoostTimer=0; p.spdBoostTimer=0; p.adrenalineTimer=0; p.invisTimer=0;
  showUpgradeFanfare('ITEMS RESET', '🔄');
  renderShop();
}

function practiceSpawnMobs(){
  const p = gameState.players[0];
  // Spawn a small camp near player
  const cx = p.x + Math.cos(p.angle) * 250;
  const cy = p.y + Math.sin(p.angle) * 250;
  const types = ['wraith','golem','sentinel'];
  const type = types[Math.floor(Math.random()*types.length)];
  const camp = { x:cx, y:cy, type, count:3, gold:50, respawnTime:15000, mobs:[], dead:false, deathTime:0 };
  for(let i=0; i<3; i++){
    const angle = Math.PI*2*i/3;
    camp.mobs.push(mkMob(type, cx+Math.cos(angle)*30, cy+Math.sin(angle)*30));
  }
  gameState.camps.push(camp);
  showUpgradeFanfare('MOBS SPAWNED', '🐺');
}

function practiceToggleDmgLog(){
  practiceDmgLogEnabled = !practiceDmgLogEnabled;
  document.getElementById('practiceDmgLog').classList.toggle('hidden', !practiceDmgLogEnabled);
}

function practiceLogDmg(dmg, targetName, attackerName){
  if(!practiceDmgLogEnabled) return;
  const el = document.getElementById('practiceDmgLog');
  const entry = document.createElement('div');
  entry.className = 'dmglog-entry';
  const time = ((performance.now() - gameState.startTime)/1000).toFixed(1);
  entry.textContent = `[${time}s] ${attackerName} → ${targetName}: ${dmg} dmg`;
  el.insertBefore(entry, el.firstChild);
  // Keep max 50 entries
  while(el.children.length > 50) el.removeChild(el.lastChild);
}

function practiceEnd(){
  practiceMode = false;
  gameRunning = false;
  document.getElementById('practiceToolbar').classList.add('hidden');
  document.getElementById('practiceDmgLog').classList.add('hidden');
  practiceDummies = [];
  showMenu();
}

function practiceGameLoop(t){
  if(!gameRunning) return;
  const dt = Math.min((t-lastT)/1000, .05); lastT=t;
  const gs = gameState;
  if(!gs || gs.gameOver) return;

  const p = gs.players[0];

  // Keep energy high in practice
  if(p.energy < 200) p.energy = 999;

  // Respawn dummies that died
  for(const d of practiceDummies){
    if(!d.alive){
      d.hp = d.maxHp; d.alive = true;
      sparks(gs, d.x, d.y, '#888888', 10, 60);
    }
  }

  if(!gs.shopOpen){
    let ax=0,ay=0;
    if(K['KeyW']||K['ArrowUp'])ay=-1; if(K['KeyS']||K['ArrowDown'])ay=1;
    if(K['KeyA']||K['ArrowLeft'])ax=-1; if(K['KeyD']||K['ArrowRight'])ax=1;
    const l=Math.sqrt(ax*ax+ay*ay); if(l>0){ax/=l;ay/=l;}
    p.angle=Math.atan2((M.y/CAM_ZOOM+camY)-p.y,(M.x/CAM_ZOOM+camX)-p.x);
    const dash=K['ShiftLeft']||M.rdown;
    const shoot=M.down||K['Space'];
    if(p.alive) updPlayer(gs,p,dt,{ax,ay,shoot,dash});
  }

  // Systems
  updMinions(gs,dt);
  const now=performance.now();
  updBullets(gs,dt); updMobBullets(gs,dt); updOrbs(gs,dt); updParticles(gs,dt);
  updCamps(gs,dt,now); updDashTrails(gs,dt); updateDmgNumbers(dt); updateImpactRings(dt); updateScreenShake(dt);
  updateMinionSlashes(dt); updateCombo(dt); updateGoldFloats(dt); updTraps(gs,dt);
  updateBulletTrails(gs,dt);
  if(typeof updateBloodSplatters==='function') updateBloodSplatters(dt);
  updateCamera(gs);
  if(typeof updateDebugStats==='function') updateDebugStats(dt);
  render(gs);
  if(typeof renderDebugOverlay==='function') renderDebugOverlay();
  updateHUD();
  if(gs.orbs.length<10) spawnOrb(gs);
  _scheduleFrame(practiceGameLoop);
}

// ── MINION AI UPDATE ──
const _minionSHOut = []; // reused spatial query buffer for minion AI
function updMinions(gs, dt){
  if(playMode==='online') return;
  const now=performance.now();
  // Build spatial hash of all enemies for O(1) nearest-target search
  const useSH = typeof shClear==='function';
  if(useSH){
    shClear();
    for(let _pi=0;_pi<gs.players.length;_pi++){ const p=gs.players[_pi]; if(p.alive) shInsert(p.x,p.y,p.radius,p); }
    for(let _ci=0;_ci<gs.camps.length;_ci++){ const c=gs.camps[_ci]; for(let _mi=0;_mi<c.mobs.length;_mi++){ const mob=c.mobs[_mi]; if(mob.alive) shInsert(mob.x,mob.y,mob.radius,mob); } }
  }
  for(const owner of gs.players){
    if(!owner.minions||!owner.minions.length) continue;
    for(let mi=owner.minions.length-1;mi>=0;mi--){
      const m=owner.minions[mi];
      if(!m.alive){owner.minions.splice(mi,1);continue;}
      m.lifeTimer-=dt*1000;
      if(m.lifeTimer<=0){m.alive=false;owner.minions.splice(mi,1);continue;}
      let nearest=null, minDist=300;
      if(useSH){
        _minionSHOut.length=0; shQuery(m.x,m.y,300,_minionSHOut);
        for(let _qi=0;_qi<_minionSHOut.length;_qi++){
          const e=_minionSHOut[_qi];
          if(e===owner||!e.alive) continue;
          if(e.id!==undefined && isAlly(owner,e,gs)) continue; // skip ally players
          const dx=e.x-m.x,dy=e.y-m.y,d=Math.sqrt(dx*dx+dy*dy);
          if(d<minDist){minDist=d;nearest=e;}
        }
      } else {
        for(const p2 of gs.players){
          if(p2===owner||!p2.alive) continue;
          const dx=p2.x-m.x,dy=p2.y-m.y,d=Math.sqrt(dx*dx+dy*dy);
          if(d<minDist){minDist=d;nearest=p2;}
        }
        for(const camp of gs.camps){
          for(const mob of camp.mobs){
            if(!mob.alive)continue;
            const dx=mob.x-m.x,dy=mob.y-m.y,d=Math.sqrt(dx*dx+dy*dy);
            if(d<minDist){minDist=d;nearest=mob;}
          }
        }
      }
      if(nearest){
        const dx=nearest.x-m.x,dy=nearest.y-m.y,d=Math.sqrt(dx*dx+dy*dy);
        if(d>m.atkRange){
          m.vx=(dx/d)*m.speed; m.vy=(dy/d)*m.speed;
        } else {
          m.vx*=0.5; m.vy*=0.5;
          if(now-m.lastAtk>m.atkCd){
            m.lastAtk=now;
            if(nearest.id){dmgPlayer(gs,nearest,{dmg:m.dmg,owner:owner.id,color:'#88cc44'});}
            else{nearest.hp-=m.dmg;if(nearest.hp<=0)nearest.alive=false;}
            addMinionSlash(nearest.x,nearest.y,m.x,m.y);
            sparks(gs,nearest.x,nearest.y,'#88cc44',8,60);
            addDmgNumber(nearest.x,nearest.y-10,m.dmg,'#88cc44',false);
          }
        }
      } else {
        const dx=owner.x-m.x,dy=owner.y-m.y,d=Math.sqrt(dx*dx+dy*dy);
        if(d>80){m.vx=(dx/d)*m.speed*0.8;m.vy=(dy/d)*m.speed*0.8;}
        else{m.vx*=0.5;m.vy*=0.5;}
      }
      m.x+=m.vx*dt; m.y+=m.vy*dt;
      m.x=Math.max(m.radius||8,Math.min(W-(m.radius||8),m.x));
      m.y=Math.max(m.radius||8,Math.min(H-(m.radius||8),m.y));
    }
  }
}

// ── GAME LOOP ──
function gameLoop(t){
  if(!gameRunning)return;
  if(document.hidden){ lastT=t; _scheduleFrame(gameLoop); return; }
  if(typeof _dbgEng!=='undefined' && _dbgEng._schedAt) _dbgEng.sched=performance.now()-_dbgEng._schedAt;
  const dt=Math.min((t-lastT)/1000,.05); lastT=t;
  const gs=gameState;
  if(!gs||gs.gameOver)return;
  if((performance.now()-gs.startTime)/1000>=gs.matchTime){endMatch(gs);return;}
  if(!gs.shopOpen){
    const p=gs.players[0];
    let ax=0,ay=0;
    if(gs.local2p){
      if(K['KeyW'])ay=-1; if(K['KeyS'])ay=1; if(K['KeyA'])ax=-1; if(K['KeyD'])ax=1;
    } else {
      if(K['KeyW']||K['ArrowUp'])ay=-1; if(K['KeyS']||K['ArrowDown'])ay=1;
      if(K['KeyA']||K['ArrowLeft'])ax=-1; if(K['KeyD']||K['ArrowRight'])ax=1;
    }
    const l=Math.sqrt(ax*ax+ay*ay); if(l>0){ax/=l;ay/=l;}
    p.angle=Math.atan2((M.y/CAM_ZOOM+camY)-p.y,(M.x/CAM_ZOOM+camX)-p.x);
    const dash=K['ShiftLeft']||M.rdown;
    const shoot=M.down||K['Space'];
    if(p.alive) updPlayer(gs,p,dt,{ax,ay,shoot,dash});

    // LOCAL 2P
    if(gs.local2p){
      const p2=gs.players[1];
      if(p2&&p2.alive){
        let ax2=0,ay2=0;
        if(K['ArrowUp'])ay2=-1; if(K['ArrowDown'])ay2=1;
        if(K['ArrowLeft'])ax2=-1; if(K['ArrowRight'])ax2=1;
        const l2=Math.sqrt(ax2*ax2+ay2*ay2); if(l2>0){ax2/=l2;ay2/=l2;}
        if(ax2!==0||ay2!==0) p2.angle=Math.atan2(ay2,ax2);
        const dash2=K['ShiftRight'];
        const shoot2=K['Enter']||K['Numpad0'];
        updPlayer(gs,p2,dt,{ax:ax2,ay:ay2,shoot:shoot2,dash:dash2});
      }
    }

    // AI players — server handles AI in online matches
    let _et0ai=performance.now();
    if(playMode!=='online'){
      for(let i=1;i<gs.players.length;i++){
        const aiP=gs.players[i];
        if(!aiP.isHuman){ const aiInp=getAIInput(gs,aiP,dt); updPlayer(gs,aiP,dt,aiInp); }
      }
    }
    if(typeof _dbgEng!=='undefined') _dbgEng.ai=performance.now()-_et0ai;
  } else {
    if(typeof _dbgEng!=='undefined') _dbgEng.ai=0;
  }

  // Minion AI
  let _et0=performance.now();
  updMinions(gs,dt);
  if(typeof _dbgEng!=='undefined'){_dbgEng.minions=performance.now()-_et0;_et0=performance.now();}

  // Systems update
  const now=performance.now();
  updBullets(gs,dt); updMobBullets(gs,dt); updOrbs(gs,dt); updParticles(gs,dt);
  if(typeof _dbgEng!=='undefined'){_dbgEng.bullets=performance.now()-_et0;_et0=performance.now();}
  updCamps(gs,dt,now); updTowers(gs,dt,now);
  if(typeof _dbgEng!=='undefined'){_dbgEng.camps=performance.now()-_et0;_et0=performance.now();}
  updDashTrails(gs,dt); updateDmgNumbers(dt); updateImpactRings(dt); updateScreenShake(dt);
  updateMinionSlashes(dt); updateCombo(dt); updateGoldFloats(dt); updTraps(gs,dt);
  updateBulletTrails(gs,dt);
  if(typeof updateBloodSplatters==='function') updateBloodSplatters(dt);
  updateCamera(gs);
  if(typeof _dbgEng!=='undefined'){_dbgEng.misc=performance.now()-_et0;_et0=performance.now();}
  if (typeof updateDebugStats === 'function') updateDebugStats(dt);
  render(gs);
  if(typeof _dbgEng!=='undefined'){_dbgEng.render=performance.now()-_et0;_et0=performance.now();}
  if (typeof renderDebugOverlay === 'function') renderDebugOverlay();
  updateHUD();
  if(typeof _dbgEng!=='undefined') _dbgEng.hud=performance.now()-_et0;
  if(gs.orbs.length<10) spawnOrb(gs);
  if(typeof _dbgEng!=='undefined') _dbgEng._schedAt=performance.now();
  _scheduleFrame(gameLoop);
}

// ── MATCH END ──
function endMatch(gs){
  if(gs.gameOver)return; gs.gameOver=true; gameRunning=false;
  let won;
  if(gs.teamMode){ won=gs.score[0]>=gs.winScore||(gs.score[0]>gs.score[1]); }
  else { won=gs.score[0]>=gs.winScore||(gs.score[0]>gs.score[1]); }
  const delta=won?+Math.round(20+Math.random()*10):-Math.round(15+Math.random()*10);
  PD.elo=Math.max(0,PD.elo+delta); if(won)PD.wins++;else PD.losses++;
  PD.shots+=gs.stats.shots; PD.hits+=gs.stats.hits; savePD();
  let me=LB.find(e=>e.name===PD.name);
  if(!me){LB.push({name:PD.name,cls:PD.cls,elo:PD.elo,wins:PD.wins,losses:PD.losses});}
  else{me.elo=PD.elo;me.wins=PD.wins;me.losses=PD.losses;me.cls=PD.cls;}
  LB.sort((a,b)=>b.elo-a.elo); saveLB();
  document.getElementById('hud').classList.add('hidden');
  document.getElementById('shopScreen').classList.add('hidden');
  showScreen('resultScreen');
  document.getElementById('rTitle').textContent=won?(gs.teamMode?'TEAM WINS!':'YOU WIN!'):(gs.teamMode?'TEAM DEFEATED':'YOU LOSE');
  document.getElementById('rTitle').className='result-title '+(won?'result-win':'result-lose');
  document.getElementById('rKills').textContent=gs.score[0];
  document.getElementById('rShots').textContent=gs.stats.shots;
  document.getElementById('rAcc').textContent=gs.stats.shots>0?Math.round(gs.stats.hits/gs.stats.shots*100)+'%':'0%';
  document.getElementById('rSpec').textContent=gs.stats.spec;
  document.getElementById('rEn').textContent=gs.stats.en;
  document.getElementById('rStreak').textContent=gs.stats.bestStreak||0;
  document.getElementById('rElo').textContent=(delta>=0?'+':'')+delta+' ELO — NOW '+PD.elo;
  document.getElementById('rElo').className='elo-change '+(delta>=0?'elo-up':'elo-down');
}

// ── INIT — show loading screen, wait for sprites, then show menu ──
(function _preload() {
  showScreen('loadingScreen');

  const bar  = document.getElementById('loadingBar');
  const info = document.getElementById('loadingInfo');
  const pct  = document.getElementById('loadingPct');

  // Safety timeout: if something fails to load, don't hang forever
  const deadline = performance.now() + 8000;

  function _tick() {
    const done  = typeof spritesLoadedCount !== 'undefined' ? spritesLoadedCount : 0;
    const total = typeof spriteSheetsTotal  !== 'undefined' ? Math.max(spriteSheetsTotal, 1) : 1;

    // _globalSpritesResolved flips true in map.js once the API fetches complete
    // and loadMapSprites() has been called, so spriteSheetsTotal is finalised.
    const apiDone = typeof _globalSpritesResolved !== 'undefined'
      ? _globalSpritesResolved
      : true;

    // Progress is only meaningful once the API is done and we know the full total
    const p = apiDone ? Math.min(100, Math.round(done / total * 100)) : 0;

    if (bar)  bar.style.width  = p + '%';
    if (info) info.textContent = done + ' / ' + total + ' sprites';
    if (pct)  pct.textContent  = p + '%';

    const allLoaded = apiDone && done >= total;
    const timedOut  = performance.now() > deadline;

    if (allLoaded || timedOut) {
      if (timedOut && !allLoaded) {
        console.warn('[PRELOAD] Timeout — proceeding with', done, '/', total, 'sprites loaded');
      }
      showMenu();
    } else {
      requestAnimationFrame(_tick);
    }
  }

  requestAnimationFrame(_tick);
})();
