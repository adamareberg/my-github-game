
# Reflex Arena: Resource Wars

> A top-down multiplayer arena game built entirely in vanilla JavaScript and Node.js — no frameworks, no build tools, no game engine.

---

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
</table>

---

## What I built

Reflex Arena is a real-time multiplayer MOBA — think early League of Legends or Warcraft 3 custom maps, running entirely in a browser tab. Players pick one of six classes, fight in a shared arena, farm jungle camps for gold and XP, level up with a talent tree, and push toward the enemy base.

The whole thing runs on a single Node.js process with no database get...(will add later), no framework, and no build step. Everything from the physics engine to the map editor to the sprite art is written from scratch in plain JavaScript.

---

## Tech stack

| Layer | What I used |
|---|---|
| Server | Node.js (ESM), `ws` for WebSockets, `multer` for file uploads |
| Renderer | PixiJS v7 (WebGL) with a Canvas 2D overlay for text and sprites |
| Language | Vanilla JavaScript — no TypeScript, no React, no bundler |
| Physics | Fixed-timestep loop at 60 Hz, runs entirely on the server |
| Networking | Binary state packets at 30 Hz, player inputs at 125 Hz |

---

## How the multiplayer works

### The server owns everything

The biggest architectural decision was making the server fully authoritative. Every player action — movement, shooting, buying items, using abilities — is validated server-side before anything happens. The client never trusts itself.

When you press W to move forward:

```
1. Browser sends { ax: 0, ay: -1, angle: 1.57 } to the server
2. Server runs physics, moves your character
3. Server sends updated game state back to all players
4. Screens update
```

This prevents cheating entirely — you can't teleport, deal extra damage, or pick talents you haven't earned, because the server checks everything.

### Keeping it smooth despite lag

Internet connections always have some delay. To hide it, two things happen simultaneously:

**Local prediction** — your character moves on your screen the moment you press a key, without waiting for the server to confirm. If the server disagrees slightly it blends smoothly. Big gaps snap.

**Interpolation** — other players are shown slightly in the past (34 ms by default), smoothly sliding between server snapshots rather than jumping.

### Sending updates efficiently

Rather than sending JSON text every tick, the server packs the entire game state into raw binary bytes. A full update for 6 players, 50 bullets, and 18 orbs comes to roughly 400 bytes. Crucially, this packet is built **once per tick** and the same bytes are sent to every player — no extra serialisation work per player.

### The level and talent system

XP and levelling are handled entirely by the server so they can't be spoofed:

| Action | XP earned |
|---|---|
| Kill a player | 120 + their level × 15 |
| Pick up an orb | 12 |
| Clear a camp | 28 – 180 depending on camp type |

At levels 2, 4, 6, 8, and 10 you unlock a talent pick. A compact panel slides up from the bottom of the screen — the game keeps running while you decide. Your choice goes to the server, which checks it against a whitelist of 90 valid talent IDs before applying it.

---

## Performance problems I had to solve

JavaScript runs on a single thread. If anything takes too long in the middle of a frame, the whole game stutters. These are the main problems I ran into and how I fixed them.

---

### 1. Garbage collection spikes

JavaScript automatically frees memory that's no longer needed. The problem is that this "garbage collection" pauses execution for a few milliseconds when it runs. If you're creating thousands of small objects every second, GC fires constantly.

The original code created a fresh object every single frame for bullets, particles, and floating text:

```js
// Creates a new object 144 times per second — triggers GC constantly
bulletTrails.push({ x: b.x, y: b.y, life: 1, color: '#ff3355' });
```

**The fix: object pools.** Pre-allocate a fixed array of slots at startup. When you need a new item, find a dead slot and reuse it. No new objects, no GC pressure.

```js
function addBulletTrail(x, y, color) {
  for (let i = 0; i < bulletTrails.length; i++) {
    if (bulletTrails[i].life <= 0) {   // found a dead slot
      bulletTrails[i].x = x;
      bulletTrails[i].y = y;
      bulletTrails[i].life = 1;
      bulletTrails[i].color = color;
      return;                           // reused — zero allocation
    }
  }
}
```

I applied this to bullets, particles, damage numbers, and gold floats. After warm-up, zero objects are created per frame.

---

### 2. Slow array removal with splice

`Array.splice(i, 1)` removes an item from the middle of an array by shifting every item after it forward by one slot. On a 200-item particle array that's 200 moves per dead particle — every frame.

```js
particles.splice(i, 1);  // O(n) — shifts everything after index i
```

**The fix: swap-and-pop.** For arrays where order doesn't matter (particles, impact rings, dash trails), move the last item into the gap, then remove the end.

```js
particles[i] = particles[particles.length - 1];  // one move
particles.pop();                                   // one removal — O(1)
```

---

### 3. The game loop was wasting CPU

The original loop used a `MessageChannel` trick to fire faster than the monitor's refresh rate — sometimes 500+ times per second. Most of that work was invisible, and the loop was out of sync with the display which caused tearing.

Switching to `requestAnimationFrame` locked the loop to the monitor refresh rate. On a 144 Hz display the game now does ~2.5 ms of real work per 6.94 ms frame, leaving 64% headroom.

```js
const UNCAP_FPS = false;  // use requestAnimationFrame — vsync-locked
```

---

### 4. DOM lookups on every frame

The HUD updates 60 times per second. The original code called `document.getElementById` on every update — that's 60+ unnecessary DOM lookups per second for elements that never move.

```js
// Old — looks up the element every frame
document.getElementById('hudHPFill').style.width = hp + '%';
```

**The fix:** look up each element once at startup and store the reference.

```js
const hpFill = document.getElementById('hudHPFill');  // once

// Every frame — instant, no lookup
hpFill.style.width = hp + '%';
```

---

### 5. Server allocating objects per input

The server receives up to 750 player inputs per second (6 players × 125 Hz). Each one used to create a new object:

```js
p.input = { ax: 0, ay: -1, angle: 1.57, shoot: true };  // 750 new objects/sec
```

**The fix:** mutate the existing object instead.

```js
p.input.ax    = 0;
p.input.ay    = -1;
p.input.angle = 1.57;
p.input.shoot = true;   // zero allocations
```

---

### 6. Sprite generation blocking the screen

All character and mob art is drawn in code at startup — no image files to download. The original approach generated all 14 character sheets back-to-back, which blocked the screen for around 6 seconds.

**The fix:** generate one character per animation frame so the work spreads invisibly across 14 frames (~100 ms total).

```js
function generateNext() {
  buildOneCharacterSheet();            // ~7 ms of canvas work
  requestAnimationFrame(generateNext); // yield, let browser paint, come back
}
requestAnimationFrame(() => requestAnimationFrame(generateNext));
```

---

## The map editor

Rather than hardcoding map layouts, I built a full in-browser map editor. It runs at `/editor2/` and lets you paint walls, place jungle camps and towers, set spawn points, and position shops — all visually on a canvas.

When you're done, clicking **Deploy to Multiplayer** saves the map JSON to the server and makes it the active map. The next match loads it automatically with no server restart.

---

## Running it locally

```bash
npm install
node server.js
```

Open `http://localhost:9090` in two browser tabs and click Play in both to start a match.

---

## File overview

```
server.js              Game server — WebSocket connections, 60 Hz physics
public/
  game.html            The page players load
  js/
    engine.js          Game loop and input handling
    network.js         Connects to server, handles incoming state
    combat.js          Damage, bullets, kill logic
    renderer-pixi.js   Draws everything with WebGL (PixiJS)
    levelup.js         XP, 10-level system, 90-talent tree
    sprite-gen.js      Generates all character art in code
    hud.js             Health bar, timer, score
    ai.js              Bot and jungle mob behaviour
    map.js             Map layout and mob definitions
  maps/                Saved map files (JSON)
  screenshots/         Screenshots for this README
```
