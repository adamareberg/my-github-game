
# Reflex Arena: Resource Wars

> A top-down multiplayer arena game built from scratch in vanilla JavaScript and Node.js. No frameworks, no game engine, no build tools.

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

Reflex Arena is a real-time multiplayer MOBA that runs entirely in a browser tab. Think early League of Legends or Warcraft 3 custom maps. Players pick one of six classes, fight in a shared arena, farm jungle camps for gold and XP, level up with a talent tree, and push toward the enemy base.

The whole thing runs on a single Node.js process with no database, no framework, and no build step. Everything from the physics to the map editor to the sprite art is written from scratch in plain JavaScript.

---

## Tech stack

| Layer | What I used |
|---|---|
| Server | Node.js (ESM), `ws` for WebSockets, `multer` for file uploads |
| Renderer | PixiJS v7 (WebGL) with a Canvas 2D overlay for sprites and UI |
| Language | Vanilla JavaScript. No TypeScript, no React, no bundler |
| Physics | Fixed-timestep loop at 60 Hz, runs entirely on the server |
| Networking | Binary state packets at 30 Hz, player inputs at 125 Hz |

---

## How the multiplayer works

### Why WebSockets?

Normal HTTP works like this: your browser asks the server "what changed?", the server replies, connection closes. For a game you'd have to do this hundreds of times per second. That's called polling and it's slow and wasteful.

WebSockets are different. The connection stays open and the server can push data to every player the moment something changes, with no extra back-and-forth. For a game running at 30 updates per second that's exactly what you need.

### The server owns everything

The most important decision in the project was making the server fully authoritative. Every action a player takes gets validated on the server before anything actually happens. The browser never trusts itself.

When you press W to move forward:

```
1. Browser sends { ax: 0, ay: -1, angle: 1.57 } to the server
2. Server runs physics and moves your character
3. Server sends the updated game state back to all players
4. Everyone's screen updates
```

If you trusted the client instead, anyone could open the browser console and type `player.x = enemyBase.x` or `player.damage = 99999`. Making the server authoritative makes that impossible because the server only accepts inputs, never positions.

### Why 30 Hz broadcast, not 60 Hz?

The server runs physics at 60 Hz internally but only sends updates to players every 2 ticks (30 Hz). This cuts bandwidth and CPU in half with no visible difference, because:

- At 30 Hz, updates arrive every 33 ms
- The client keeps a small 34 ms buffer, so it always has two snapshots to smoothly blend between
- Your eyes can't actually see individual network packets, you see the smooth blended result

Going to 60 Hz would double the bandwidth cost for a benefit no one can perceive.

### Why 125 Hz for player input?

Input goes the other way, from client to server. This runs at 125 Hz (every 8 ms) because some actions like tap-fire shots happen in a single frame. If input only sent at 30 Hz, a quick click could get missed entirely. 125 Hz makes sure the server sees every action even if it lasts less than one screen frame.

### Binary data instead of JSON

The simple approach is to send the game state as text using JSON. The problem is size:

- JSON for 6 players + 50 bullets + 18 orbs is around **4 to 6 KB** per update
- At 30 Hz that's **120 to 180 KB/sec per player**, or **720+ KB/sec total for a 6-player match**

Instead the server encodes everything into raw binary bytes:

```
Header   20 bytes  (tick counter, time, scores, match length)
Players  ~60 bytes each (x/y position, hp, shield, flags)
Bullets  10 bytes each (position and velocity packed tight)
```

The same update is now around **400 bytes**. That is roughly 10x smaller. The server builds the binary packet once and sends it to every player. No JSON, no strings, no waste.

A good example of how the packing works is the flags byte. Instead of sending 8 true/false values separately, they all get packed into a single byte using bitwise OR:

```js
let flags = 0;
if (p.alive)      flags |= 1;
if (p.swordOn)    flags |= 2;
if (p.novaOn)     flags |= 4;
if (p.hookOn)     flags |= 8;
if (p.barrierOn)  flags |= 16;
// etc.
```

8 booleans, 1 byte.

Slower-changing data like camp mob positions and tower HP goes out as normal JSON every 133 ms. It changes rarely enough that the larger size is fine at that rate.

### Keeping it smooth despite lag

Even on a fast connection there are always a few milliseconds of delay. Two techniques hide it:

**Local prediction:** Your character moves the moment you press a key, without waiting for the server to reply. The server's confirmed position arrives about 50 ms later. If it matches closely, the client blends toward it smoothly. If there was a lag spike and you are way off, it snaps. Only position and velocity get predicted. HP, cooldowns, and abilities always come from the server.

**Snapshot interpolation:** Other players and mobs are drawn from a rolling buffer of the last 10 snapshots from the server. Instead of jumping to each new position the moment it arrives, the client renders 34 ms behind, always blending between two known positions. Movement looks smooth even if packets arrive slightly unevenly.

The 34 ms buffer equals exactly 2 network frames at 30 Hz (33.3 ms each). Smaller than that and one late packet causes a visible stutter. Larger and the game starts to feel sluggish.

### Matchmaking without a database

There is no database. Players join a queue stored in a plain JavaScript array. When 6 players are ready, or 15 seconds pass with 2+ players waiting, the server creates a match:

```js
const match = {
  id: ++matchIdCounter,
  players: [...],
  bullets: [], camps: [], orbs: [],
  score: {}, gameOver: false
};
matches.set(match.id, match);
```

Each match is just a plain object. When it ends it gets deleted. No Redis, no Postgres, no sessions. For matches that last 5 minutes this works perfectly fine.

### The level and talent system

XP and leveling are server-controlled for the same reason everything else is. The server tracks all the numbers:

| Action | XP earned |
|---|---|
| Kill a player | 120 + their level x 15 |
| Pick up an orb | 12 |
| Clear a camp | 28 to 180 depending on type |

When you hit level 2, 4, 6, 8, or 10 the server sends a `levelUp` message to your socket only. A small panel slides up at the bottom of the screen and **the game keeps running, nothing pauses** (like Dota or LoL). You pick a talent, it applies immediately on the client for feel, and the choice gets sent to the server. The server checks the talent ID against a whitelist of all 90 valid IDs, confirms you actually unlocked that tier, then applies the stat change on its own copy of your character.

---

## How the renderer works

### Why PixiJS instead of a game engine

The renderer uses PixiJS v7, which is a WebGL drawing library, not a full game engine. The difference matters.

A full game engine like Unity, Godot, or Phaser comes with its own physics system, its own input handling, its own game loop. The problem is this project's physics run on the server. If you used Phaser, you would have to disable all of its physics just to get it to render things in the positions the server sent. You would be dragging along a ton of code you can't use.

PixiJS only draws things on screen. Everything else, the input, physics, networking, and state, is handled manually. That is a much cleaner fit.

### Why WebGL instead of Canvas 2D

The arena has 6 players, 50+ bullets, 18 orbs, 25 jungle mobs, particles, and a full tile map on screen at the same time. Canvas 2D draws each object one at a time on the CPU. With hundreds of objects at 60 fps that starts to saturate the processor.

WebGL batches everything together and sends it to the GPU in one call. The GPU renders 200 sprites in the same time Canvas 2D handles one. On a normal machine the WebGL path runs at about 2.5 ms per frame, leaving over 60% of the frame budget free.

### Why a Canvas 2D overlay on top of PixiJS

There are actually two canvas elements stacked on top of each other. PixiJS owns the bottom one and draws the tile map and the world. A second canvas sits on top using plain Canvas 2D. This overlay handles:

- **Sprite art:** all character and mob sprites are drawn in code using Canvas 2D shapes. Doing this inside PixiJS would require converting canvas drawings into GPU textures every frame, which is slow. The overlay draws them directly.
- **Damage numbers and floating text:** short-lived text that changes constantly. Canvas 2D text calls are faster than creating and destroying PixiJS text objects.
- **In-world HUD:** health bars, cooldown rings, ability indicators drawn on top of characters.

The browser composites both canvases together automatically.

### Why sprites are drawn in code

There are no image files in this project. No PNGs, no downloaded sprite sheets. Every character and mob is generated from scratch at startup using Canvas 2D drawing commands (rectangles, circles, gradients, custom shapes).

The reason is consistency across screen sizes. If you ship a 32x32 PNG and scale it up on a high-DPI display, it blurs unless you add special CSS that browsers handle differently. Generating sprites at the exact right size always gives a clean result.

Generation runs in the background one entity per frame, using `requestAnimationFrame` to yield control back to the browser between each one:

```js
function generateNext() {
  buildOneCharacterSheet();            // about 7 ms of work
  requestAnimationFrame(generateNext); // yield, come back next frame
}
```

On a 60 Hz display that is 14 frames to generate all 14 entity types, about 233 ms total. The title screen is showing during that time so the player never sees it. After startup the sheets are cached and never rebuilt.

### How animation direction works

The server tracks each entity's angle and sends it in every update. The client uses that angle to pick the right row in the sprite sheet:

```
Row 0-3:   idle (facing down, left, right, up)
Row 4-7:   walking
Row 8-11:  attacking
Row 12-15: ability / special
Row 16:    death
```

The animation state (idle, walk, attack, dead) is figured out on the client from the data that is already there. If the player is shooting, use the attack row. If velocity is above zero, use the walk row. This means the server does not need to send animation state at all, saving bytes on every packet.

---

## Performance problems I had to solve

JavaScript runs on a single thread. If anything takes too long in a frame, the whole game stutters. Here are the main problems I ran into.

---

### 1. Garbage collection spikes

JavaScript frees unused memory automatically. The catch is that this "garbage collection" pauses execution for a few milliseconds each time it runs. If you create thousands of small objects every second, GC fires constantly.

The original code created a fresh object for every bullet trail, particle, and floating number:

```js
// Creates a new object 144 times per second
bulletTrails.push({ x: b.x, y: b.y, life: 1, color: '#ff3355' });
```

**The fix: object pools.** Pre-allocate a fixed list of slots at startup. When you need a new item, find a slot that is no longer in use and overwrite it. Zero new objects, zero GC pressure.

```js
function addBulletTrail(x, y, color) {
  for (let i = 0; i < bulletTrails.length; i++) {
    if (bulletTrails[i].life <= 0) {
      bulletTrails[i].x = x;
      bulletTrails[i].y = y;
      bulletTrails[i].life = 1;
      bulletTrails[i].color = color;
      return;
    }
  }
}
```

After warm-up, zero objects are created per frame.

---

### 2. Slow array removal with splice

`Array.splice(i, 1)` removes one item by shifting every item after it forward by one slot. On a 200-item particle array that means up to 200 moves per dead particle, every frame.

```js
particles.splice(i, 1);  // O(n)
```

**The fix: swap-and-pop.** For arrays where order does not matter, move the last item into the gap, then remove the end. Two operations instead of potentially hundreds.

```js
particles[i] = particles[particles.length - 1];
particles.pop();
```

---

### 3. The game loop was wasting CPU

The original loop used a `MessageChannel` trick to fire faster than the screen refresh rate, sometimes 500+ times per second. Most of that work was thrown away, and being out of sync with the display caused visual tearing.

Switching to `requestAnimationFrame` locks the loop to the monitor's refresh rate. On a 144 Hz display the game does about 2.5 ms of real work per 6.94 ms frame, leaving 64% headroom.

```js
const UNCAP_FPS = false;  // locked to monitor refresh rate
```

---

### 4. DOM lookups on every frame

The HUD updates 60 times per second. The original code called `document.getElementById` on every update. That is 60+ unnecessary lookups per second for elements that never change position.

```js
// Old: looks up the element every frame
document.getElementById('hudHPFill').style.width = hp + '%';
```

**The fix:** look up each element once at startup and save the reference.

```js
const hpFill = document.getElementById('hudHPFill');  // once at startup

// Every frame: instant, no lookup
hpFill.style.width = hp + '%';
```

---

### 5. Server creating objects for every input

The server receives up to 750 player inputs per second (6 players at 125 Hz each). Each one used to create a new object:

```js
p.input = { ax: 0, ay: -1, angle: 1.57, shoot: true };  // 750 new objects/sec
```

**The fix:** update the existing object instead of replacing it.

```js
p.input.ax    = 0;
p.input.ay    = -1;
p.input.angle = 1.57;
p.input.shoot = true;
```

---

### 6. Sprite generation blocking the screen

Generating all 14 character sheets back-to-back at startup blocked the screen for about 6 seconds.

**The fix:** generate one character per animation frame so the work spreads across 14 frames invisibly.

```js
function generateNext() {
  buildOneCharacterSheet();
  requestAnimationFrame(generateNext);
}
requestAnimationFrame(() => requestAnimationFrame(generateNext));
```

---

## The map editor

Instead of hardcoding map layouts I built a full in-browser map editor. It runs at `/editor2/` and lets you paint walls, place jungle camps and towers, set spawn points, and position shops, all on a canvas.

When you are done, clicking **Deploy to Multiplayer** saves the map to the server and makes it the active map. The next match loads it automatically with no server restart needed.

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
server.js              Game server, WebSocket connections, 60 Hz physics
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
