// ═══════════════════════════════════════════════════════════════
// AI.JS — Bot AI decision-making
// ═══════════════════════════════════════════════════════════════

// Reused return value — no new object per AI player per frame
const _aiOut = {ax:0, ay:0, shoot:false, dash:false};
function getAIInput(gs,ai,dt){
  const enemies=getEnemies(ai,gs);
  if(!ai.alive||!enemies.length){_aiOut.ax=0;_aiOut.ay=0;_aiOut.shoot=false;_aiOut.dash=false;return _aiOut;}

  const st=gs.ai[ai.id-1];
  if(!st){_aiOut.ax=0;_aiOut.ay=0;_aiOut.shoot=false;_aiOut.dash=false;return _aiOut;}

  let pl=null, minD=Infinity;
  for(const e of enemies){
    const dx=e.x-ai.x,dy=e.y-ai.y,d=dx*dx+dy*dy;
    if(d<minD){minD=d;pl=e;}
  }
  if(!pl)return{ax:0,ay:0,shoot:false,dash:false};

  const dx=pl.x-ai.x, dy=pl.y-ai.y, dist=Math.sqrt(dx*dx+dy*dy);
  st.rTimer+=dt*1000; st.strafeT+=dt*1000; st.dashT+=dt*1000; st.spTimer+=dt*1000;

  if(st.rTimer>165){
    const lead=dist/Math.max(CDEFS[ai.cls].bSpd,300);
    st.aim=Math.atan2(pl.y+pl.vy*lead-ai.y,pl.x+pl.vx*lead-ai.x);
    st.noise=(Math.random()-.5)*.32; st.rTimer=0;
  }
  ai.angle=st.aim+st.noise;
  if(st.strafeT>700+Math.random()*600){st.strafeDir*=-1;st.strafeT=0;}
  const ideal=ai.cls==='assassin'?110:ai.cls==='mage'?250:210;
  const perX=-dy/dist, perY=dx/dist;
  const apX=dist>ideal?dx/dist*.8:-dx/dist*.4, apY=dist>ideal?dy/dist*.8:-dy/dist*.4;
  let dash=false;
  for(const b of gs.bullets){
    if(b.owner===ai.id)continue;
    if(gs.teamMode && b.team===ai.team) continue;
    const bx=b.x-ai.x, by=b.y-ai.y, bd=Math.sqrt(bx*bx+by*by);
    if(bd<155){const dot=(b.vx*bx+b.vy*by)/(Math.sqrt(b.vx*b.vx+b.vy*b.vy)*bd+.01); if(dot>.8&&st.dashT>1100){dash=true;st.dashT=0;}}
  }
  if(st.spTimer>1800){
    const now=performance.now();
    if(now-ai.lastSp>ai.spCd){
      const useNow=(ai.cls==='gunner'&&dist<360)||(ai.cls==='assassin'&&dist<160)||(ai.cls==='mage'&&dist<230)||(ai.cls==='necro'&&dist<200)||(ai.cls==='ranger'&&dist<400)||(ai.cls==='tank'&&dist<300);
      if(useNow){ai.lastSp=now; triggerSpecial(gs,ai);}
    }
    if(now-ai.lastUlt>ai.ultCd){
      const useUlt=(ai.cls==='gunner'&&dist<300)||(ai.cls==='assassin'&&dist<200)||(ai.cls==='mage'&&ai.hp<ai.maxHp*0.5)||(ai.cls==='tank'&&dist<150)||(ai.cls==='necro'&&dist<250)||(ai.cls==='ranger'&&dist<300);
      if(useUlt){ai.lastUlt=now; triggerUltimate(gs,ai);}
    }
    st.spTimer=0;
  }
  st.shopCd-=dt*1000;
  if(st.shopCd<=0&&ai.energy>=40){buyAIUpgrade(gs,ai);st.shopCd=3200+Math.random()*3000;}
  const shootR=ai.cls==='assassin'?190:380;
  _aiOut.ax=apX+perX*st.strafeDir*.6;_aiOut.ay=apY+perY*st.strafeDir*.6;
  _aiOut.shoot=st.rTimer<25&&dist<shootR;_aiOut.dash=dash;
  return _aiOut;
}

function buyAIUpgrade(gs,p){
  const ownedCount=Object.keys(p.upgrades).length;
  if(ownedCount>=MAX_ITEMS)return;
  const avail=ALL_UPS.filter(u=>!p.upgrades[u.id]&&u.cost<=p.energy);
  if(!avail.length)return;
  const u=avail[Math.floor(Math.random()*avail.length)];
  p.energy-=u.cost; p.upgrades[u.id]=true; applyUpg(p,u.id);
}

function applyUpg(p,id){
  if(id==='shield') p.shield=30;
  if(id==='fortify'){p.maxHp+=50; p.hp=Math.min(p.hp+50,p.maxHp);}
  if(id==='vitality'){p.maxHp+=30; p.hp=Math.min(p.hp+30,p.maxHp);}
}
