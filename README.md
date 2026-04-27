
## Screenshots

<table>
  <tr>
    <td align="center"><img src="screenshots/gameplay.png" width="420" alt="Gameplay"/><br/><sub>In-game arena combat</sub></td>
    <td align="center"><img src="screenshots/classes.png" width="420" alt="Class select"/><br/><sub>Class selection screen</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="screenshots/levelup.png" width="420" alt="Talent picker"/><br/><sub>Non-blocking talent picker on level-up</sub></td>
    <td align="center"><img src="screenshots/editor.png" width="420" alt="Map editor"/><br/><sub>In-browser map editor</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="screenshots/boss.png" width="420" alt="Boss fight"/><br/><sub>Ancient Colossus boss arena</sub></td>
    <td align="center"><img src="screenshots/shop.png" width="420" alt="Shop"/><br/><sub>In-game upgrade shop</sub></td>
  </tr>
</table>

> **To add screenshots:** take a screenshot in-game, save it to the `screenshots/` folder with the matching filename, and it will show up here automatically.

---

## Tech used

| What | How |
|---|---|
| Server | Node.js + WebSockets (`ws` library) |
| Graphics | PixiJS (WebGL) + Canvas 2D |
| Language | Vanilla JavaScript — no React, no TypeScript, no bundler |
| Physics | Runs on server at 60 updates/second |
| Networking | 30 updates/second to clients, 125 inputs/second from clients |

---

## How the multiplayer works

### The server is in charge of everything

When you press W to move, here's what happens:

```
1. Your browser sends {move: up, angle: 1.57} to the server
2. The server moves your character
3. The server sends the new positions to everyone
4. Everyone's screen updates
```

The server is the single source of truth. It validates every action — you can't deal more damage than your class allows, use abilities on cooldown, or pick talents you haven't earned.

### Staying smooth despite internet delay

Even on a fast connection there's always a small delay between sending an input and getting a response back. Two tricks hide this lag:

**Local prediction** — your own character moves instantly on your screen without waiting for the server. If the server slightly disagrees it blends smoothly. Big disagreements snap.

**Interpolation** — other players are shown slightly in the past (34 ms), smoothly sliding between server updates instead of jumping around.

### Sending data efficiently

Instead of sending plain text (JSON), the server packs game state into raw binary bytes. A full update with 6 players, bullets, and mobs is only a few hundred bytes. The server builds this packet **once** and sends the same bytes to all players — no extra work per player.

### Matchmaking

Click Play → you join a queue. Match starts when 6 players join or 15 seconds pass with at least 2 players. The server can run many matches at the same time with no database needed.

### Leveling in multiplayer

The server tracks XP so players can't cheat it:

| Action | XP |
|---|---|
| Kill a player | 120 + their level × 15 |
| Pick up an orb | 12 |
| Clear a jungle camp | 28 – 180 |

At levels 2, 4, 6, 8, and 10 you get a talent pick. A small panel slides up at the bottom of screen — **the game keeps running while you decide**. When you pick, the server double-checks your choice is valid before applying it.

---

## Performance problems we had to solve

JavaScript runs in one thread. If anything takes too long, the whole game freezes. Here are the main problems we hit and how we fixed them.

### Problem: Too much garbage slowing the game down

JavaScript automatically cleans up old objects (called garbage collection). The problem: if you create thousands of tiny objects every second, the GC fires frequently and pauses the game for a few milliseconds each time.

The old code did this every frame:
```js
// Creates a brand new object 144 times per second
bulletTrails.push({ x: b.x, y: b.y, life: 1, color: '#ff3355' });
```

**Fix — reuse objects instead of creating new ones:**
```js
// Find an "empty" slot and fill it — zero new objects after startup
for (let i = 0; i < bulletTrails.length; i++) {
  if (bulletTrails[i].life <= 0) {   // this slot is empty
    bulletTrails[i].x = b.x;
    bulletTrails[i].y = b.y;
    bulletTrails[i].life = 1;
    return;                           // reused!
  }
}
```

We did this for bullets, particles, damage numbers, and gold floats.

### Problem: Removing items from arrays was slow

When you remove an item from the middle of an array with `splice`, JavaScript shifts every item after it forward by one. On a large array this is noticeably slow.

```js
particles.splice(i, 1);  // moves everything after i — slow
```

**Fix — swap the last item into the gap, then remove the end:**
```js
particles[i] = particles[particles.length - 1];  // put last item in the gap
particles.pop();                                   // remove the last — instant
```

Order doesn't matter for particles, so this is safe and much faster.

### Problem: The game loop was running too fast and wasting CPU

The game was using a trick to run the loop as fast as possible — sometimes hundreds of times per second. Most of that work was never shown on screen and burned CPU for no reason.

**Fix — sync the loop to your monitor's refresh rate:**
```js
// Before — runs as fast as possible, wastes CPU
const UNCAP_FPS = true;

// After — runs exactly in sync with your 60 or 144 Hz monitor
const UNCAP_FPS = false;
```

After this change, the game only does ~2.5ms of real work per frame, leaving plenty of room before any frame takes too long.

### Problem: Looking up screen elements every single frame

The health bar and timer update 60 times per second. The old code called `document.getElementById(...)` every time — that's 60+ unnecessary lookups per second.

```js
// Old — looks up the element 60 times a second
document.getElementById('hudHPFill').style.width = hp + '%';

// New — look it up once, reuse the reference forever
const hpFill = document.getElementById('hudHPFill');  // done once
hpFill.style.width = hp + '%';                        // fast every frame
```

### Problem: Server creating unnecessary objects on every player input

The server receives up to 750 player inputs per second (6 players × 125/sec). Each input used to create a new object:

```js
// 750 new objects per second being created and thrown away
p.input = { ax: 0, ay: -1, angle: 1.57, shoot: true };
```

**Fix — update the existing object instead:**
```js
// Zero new objects — just update what's already there
p.input.ax    = 0;
p.input.ay    = -1;
p.input.angle = 1.57;
p.input.shoot = true;
```

### Problem: Generating sprites blocked the screen for 6 seconds

All character art is generated in code at startup (no image files to download). The old approach generated all 14 character sheets one after another, blocking the screen for several seconds.

**Fix — generate one character per frame so the work is invisible:**
```js
function generateNext() {
  buildOneCharacterSheet();           // takes ~7ms
  requestAnimationFrame(generateNext); // pause, let browser paint, come back
}
```

Spread across 14 frames the work becomes invisible.

---

## Map editor

The built-in editor at `/editor2/` lets you design maps visually. Place walls, jungle camps, towers, and shops on a canvas. Click **Deploy to Multiplayer** and the next match uses your map automatically — no server restart needed.

---

## File overview

```
server.js              The game server — handles connections and runs all physics
public/
  game.html            The page players load to play
  js/
    engine.js          Main game loop and keyboard/mouse input
    network.js         Connects to server, handles incoming updates
    combat.js          Damage, bullets, and kill logic
    renderer-pixi.js   Draws everything on screen (WebGL)
    levelup.js         XP, levels 1-10, and talent picks
    sprite-gen.js      Draws all character art in code (no image files)
    hud.js             Health bar, timer, and score display
    ai.js              Bot and jungle mob behaviour
    map.js             Map layout and mob definitions
  maps/                Saved map files
  sprites/             Any custom images you upload in the editor
```
