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

## Why I built it this way

I want to be upfront about something. This is not the most practical way to build a game.

If you want to ship a polished game, you use Unity, Godot, or Unreal. They handle the physics, the rendering, the audio, the input, the networking abstractions, all of it. Thousands of developers have already solved those problems and packaged them up for you. Using a real engine is faster, more reliable, and produces better results for most people.

I chose not to do that on purpose.

The reason is that I wanted to deeply understand how real-time multiplayer networking actually works, not just how to call an API that handles it for me. Things like: how do you keep two players in sync when messages can arrive late or out of order? How do you stop cheaters when the client could be modified to send anything? How do you make movement feel instant when there is a 50 ms gap between the player pressing a button and the server processing it? These are questions you never have to think about in a game engine because the engine handles them. Building everything from scratch forced me to actually understand the answers.

It was also genuinely one of the hardest things I have built. JavaScript is a single-threaded language that was not designed for 60 Hz game loops running physics simulations. Getting it to perform well meant going deep into garbage collection, memory allocation patterns, binary data encoding, and browser rendering pipelines. Every part of the stack had something that needed to be figured out the hard way.

So this project is less about "the best way to make a game" and more about understanding what is happening underneath the games you play every day. If you want to learn multiplayer networking at a real technical level, building it yourself is the only way that actually sticks.

### What to use instead depending on your goal

Different goals call for different tools. Here is an honest breakdown:

**If you want to ship a game to players fast**, use a game engine. Unity has Mirror and Netcode for GameObjects for multiplayer. Godot has its own built-in multiplayer API. Both handle the hard parts: clock sync, interest management, state replication, lag compensation. You can have a working multiplayer prototype in a weekend. This project took months to get to the same point.

**If you want to build a browser game with multiplayer**, Phaser with Colyseus is a well-tested combination. Colyseus is a dedicated multiplayer server framework for Node.js that handles rooms, state sync, and reconnection out of the box. You write your game logic, Colyseus handles the networking layer. It would have saved a lot of time on this project.

**If you want to learn how networking works at a low level**, doing it from scratch like this project is the right call. You will hit every problem yourself: clock drift, packet ordering, cheat prevention, bandwidth budgets. You cannot skip any of it because nothing is hidden behind a library. The frustration is the point.

**If you are building something that needs to scale to thousands of players**, none of these approaches are enough on their own. You need load balancers, match servers that can be spun up on demand, a real database for player accounts and stats, and usually a team. Single-process Node.js with in-memory match state tops out at maybe 20 to 30 concurrent matches on a small VPS before you need to think about architecture differently.

The honest summary: this project is an educational exercise built to learn, not a production-ready multiplayer platform. The code is clear and the architecture makes sense, but if your goal is players in seats, start with an engine.

---

## If you are new to game development

This section is for people who know how to use a computer and maybe done some basic coding, but have never built a game before. The rest of the README goes into specific technical decisions, but this part explains the basics of why those decisions needed to happen at all.

**Why is multiplayer so hard?**

A single-player game is simple. Your code runs, things move on screen, you are done. Multiplayer means multiple computers need to agree on what is happening at every moment. Player A is on a laptop in one city. Player B is on a desktop in another. They both press buttons at the same time. Who moved first? What if a message got delayed? What if someone cheats? Every one of these questions needs a real answer, or the game breaks.

**What is a game server?**

A game server is a program that sits in the middle and acts as the single source of truth. Instead of Player A's computer telling Player B's computer what happened, both players send their inputs to the server, and the server decides what actually happened and tells everyone. This project's server runs in Node.js, which is JavaScript that runs outside a browser, on a machine that both players can connect to.

**What is a game loop?**

Games do not wait for something to happen. They run a loop, over and over, usually 60 times per second. Each loop tick updates every object in the game: move all the bullets, check all the collisions, apply all the damage, figure out who died. This project runs that loop on the server so every player is working from the exact same physics simulation.

**Why does the game need to be so fast?**

60 updates per second means each tick has to finish in about 16 milliseconds. If anything takes longer, the game stutters. JavaScript has some specific traps that make this harder, like garbage collection (where the language stops to clean up unused memory), and these had to be worked around carefully. A lot of the technical decisions in this project exist because of that 16 ms budget.

**What is WebGL and why does rendering matter?**

The browser has two ways to draw things on screen. Canvas 2D is the simple one: you call drawing commands and it draws them one at a time. WebGL is the fast one: it talks directly to the graphics card, which can draw thousands of things at once in parallel. A game with 200 moving objects on screen needs WebGL or the drawing alone eats the entire 16 ms frame budget.

**What is a WebSocket?**

A regular website request works like a letter: you send a request, wait for a reply, the connection closes. A WebSocket is more like a phone call: the connection stays open and either side can say something at any time. Multiplayer games need WebSockets because the server needs to push new game state to players 30 times per second without waiting for each player to ask for it.

With that context, the sections below should make a lot more sense.

---

## Tech stack

| Layer | What I used |
|---|---|
| Server | Node.js (ESM), `ws` for WebSockets, `multer` for file uploads |
| Renderer | PixiJS v7 (WebGL) with a Canvas 2D overlay for sprites and UI |
| Game code | Vanilla JavaScript. No TypeScript, no bundler |
| Map editor UI | React (for the editor panel and controls only) |
| Physics | Fixed-timestep loop at 60 Hz, runs entirely on the server |
| Networking | Binary state packets at 30 Hz, player inputs at 125 Hz |

---

## How to structure a dedicated game server

Before getting into the specific decisions, it is worth explaining what a dedicated server actually is and how you structure one from scratch. This is the part most tutorials skip.

### Peer-to-peer vs dedicated server

There are two main ways to do multiplayer. The first is peer-to-peer: players connect directly to each other and share the game state between themselves. This sounds simpler but breaks quickly. What happens when two players disagree about who shot first? Who is the authority? What stops someone from modifying their client to send fake data? Peer-to-peer works for simple turn-based games but falls apart in anything real-time.

The second way is a dedicated server. One central program runs the entire simulation. Players send inputs to it and receive results back. The server is the only authority. Players cannot cheat by modifying their client because the server ignores anything that is not a valid input.

This project uses a dedicated server running in Node.js.

### How the server file is structured

The server is a single file (`server.js`) and is split into clear responsibilities:

**Connection handling** sits at the top. When a player opens the game, their browser creates a WebSocket connection. The server gives them a player ID, registers them in a waiting queue, and listens for their messages.

**The match manager** handles the queue. When enough players are waiting, it calls `createMatch()`, which builds the match object and assigns players to it. When a match ends, the object is deleted from the map.

**The physics loop** runs at 60 Hz using `setInterval`. Every tick it loops through every active match and updates all the moving pieces: player positions from their latest input, bullet trajectories, collision detection, camp spawns, damage calculations. This loop is the heart of the server.

**The broadcast loop** runs at 30 Hz, also with `setInterval`. Every other physics tick it serialises the current state of each match into a binary buffer and sends it to every player in that match.

**Message handlers** sit in a `switch` statement that processes incoming messages from players: movement input, shoot, buy item, pick talent, and so on. Each case validates the message and applies the effect to the server's copy of the game state.

```
setInterval (60 Hz) ─── physics update for all matches
setInterval (30 Hz) ─── encode binary state, broadcast to all players
WebSocket 'message'  ─── validate player input, apply to match state
```

### Why setInterval instead of requestAnimationFrame

`requestAnimationFrame` only exists in the browser. Node.js has no concept of a display. The server uses `setInterval` to schedule its game loop, which fires every 16.67 ms (for 60 Hz). The downside is that `setInterval` can drift slightly under load, so the loop tracks elapsed time and calculates delta-time on each tick rather than assuming exactly 16.67 ms passed.

### Why one file and not split into modules

At the current scale, one file makes it easier to follow the data flow. You can search for where a variable is set and read the whole picture without jumping between files. As the server grows, splitting into modules makes sense, but premature splitting often just adds indirection without clarity.

### The lifecycle of a match

Understanding the lifecycle helps you see how all the pieces connect:

```
1. Player connects via WebSocket
2. Server adds them to the waiting queue
3. Queue hits 6 players (or 15s timeout with 2+ players)
4. createMatch() builds the match object in memory
5. Players receive a 'matchStart' message with their ID and initial state
6. Physics loop begins updating that match every 16.67 ms
7. Players send inputs, server applies them each tick
8. Broadcast loop sends binary state every 33 ms
9. A team reaches the kill limit or timer expires
10. Server sends 'gameOver' to all players in the match
11. Match object is removed from the Map, memory freed
```

No database, no sessions, no files written. The match only exists in memory for its lifetime.

### Why this architecture scales reasonably well

Because each match is a plain object and the loops iterate over all active matches, adding more matches costs roughly linear CPU. The bottleneck is the physics calculation per match, not the number of connections. For a small server running a handful of concurrent matches, this is completely fine. For hundreds of concurrent matches you would need to move to worker threads or multiple processes, but that is a problem for later.

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

### How sprites work

The sprite system has two layers.

**Custom PNG sheets** are the primary path. Through the map editor you can upload your own sprite sheet PNG for any class or mob. The editor lets you define how the sheet is laid out: how many columns, which rows are idle, walk, attack, and so on. When the game loads, it reads these assignments and draws characters directly from the uploaded images.

**Procedural fallback** kicks in for any entity that does not have a custom sheet assigned. The game generates a placeholder sprite from scratch using Canvas 2D drawing commands (rectangles, circles, gradients), bakes the result into an `OffscreenCanvas`, and uses that. This means the game always has something to display even before you have set up any art.

Both paths end up in the same place: a bitmap in memory that the renderer reads from each frame. Copying pixels from a cached bitmap is very fast compared to re-drawing geometry from commands every frame. The work gets done once at startup, then the result is reused for the rest of the session.

The procedural generation is spread across frames using `requestAnimationFrame` so it does not block the title screen:

```js
function generateNext() {
  buildOneCharacterSheet();            // about 7 ms of canvas work
  requestAnimationFrame(generateNext); // give the browser a frame to breathe
}
```

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

## Making it feel smooth

Fixing performance problems stops the game from stuttering. Making it actually feel smooth is a separate problem. Here is what went into that.

**Vsync-locked rendering.** The game loop runs with `requestAnimationFrame`, which fires in sync with your monitor. On a 144 Hz display you get 144 frames per second, each delivered exactly when the monitor is ready to show it. Earlier the loop used a `MessageChannel` hack that fired as fast as possible and was out of sync with the display, which caused visible tearing on fast movement.

**Interpolation buffer.** Other players are never drawn at their latest known position. They are drawn from 34 ms in the past, always blending smoothly between two confirmed server snapshots. If a packet arrives slightly late, there is always another snapshot to fill in. Movement looks fluid even when the network has a little jitter.

**Local prediction.** Your own character responds instantly to input. You do not wait for the server to confirm your movement before the sprite moves on screen. The server position arrives 50 ms later and the client quietly corrects toward it. The correction is almost always invisible because on a normal connection the positions are very close.

**Object pools.** Particles, bullet trails, damage numbers, and gold floats are all pre-allocated at startup and reused. This eliminates the garbage collection pauses that used to cause occasional frame drops even when the CPU had headroom.

**Sprite caching.** Whether a sprite comes from an uploaded PNG or from procedural generation, it ends up as a cached bitmap in memory. Every frame is just a pixel copy from that cache. No re-drawing, no re-decoding, no wasted work.

The result on a mid-range machine: about 2.5 ms of CPU time per 6.94 ms frame at 144 Hz, which is 64% headroom. The game can handle a full 6-player match at max load without dropping a frame.

---

## The map editor

Instead of hardcoding map layouts I built a full in-browser map editor. It runs at `/editor2/` and lets you paint walls, place jungle camps and towers, set spawn points, and position shops, all on a canvas.

The editor UI (the side panels, dropdowns, property tables, and tile palette) is built with React. The game itself uses no React at all, but the editor has a lot of interactive controls that update each other, and React made that state management much cleaner than wiring it up by hand in vanilla JS. The canvas where you actually paint the map is still plain Canvas 2D, React just handles the surrounding UI.

When you are done, clicking **Deploy to Multiplayer** saves the map to the server and makes it the active map. The next match loads it automatically with no server restart needed.

---

## Running it locally

```bash
npm install
node server.js
```

Open `http://localhost:9090` in two browser tabs and click Play in both to start a match.

---

## Resources that helped build this

These are the actual articles, videos, and docs I kept coming back to during this project. If you want to go deeper on any of the topics covered in this README, these are good starting points.

### Multiplayer networking

**Gabriel Gambetta - Fast-Paced Multiplayer**
https://www.gabrielgambetta.com/client-server-game-architecture.html

This is the best series of articles on real-time multiplayer networking I have found. It covers server authority, client prediction, lag compensation, and snapshot interpolation in a way that is actually understandable. If you read one thing from this list, make it this.

**Gaffer on Games - Networking for Game Programmers**
https://gafferongames.com

Glenn Fiedler wrote the foundational articles on game networking. Covers UDP vs TCP, reliable packet ordering, and how to build a custom transport. Goes deeper than most resources.

**Valve Developer Wiki - Source Multiplayer Networking**
https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking

How Valve actually implemented networking in games like CS:GO. The concepts behind lag compensation and the interpolation buffer come from here. Reading how a professional studio solved these problems is very useful.

---

### JavaScript performance

**V8 Blog**
https://v8.dev/blog

The V8 team (the engine that runs Node.js and Chrome) writes about how JavaScript is optimized internally. If you want to understand why object allocation causes GC pauses or how to write code that the JIT compiler can optimize, this is the source.

**MDN - Memory Management**
https://developer.mozilla.org/en-US/docs/Web/JavaScript/Memory_management

Plain explanation of how garbage collection works in JavaScript and why it matters for performance-sensitive code.

---

### WebGL and rendering

**PixiJS official docs and examples**
https://pixijs.com

The official PixiJS docs are well written and the examples section shows real use cases. Good starting point before going into the source.

**WebGL Fundamentals**
https://webglfundamentals.org

If you want to understand what PixiJS is actually doing under the hood, this site teaches raw WebGL from scratch. Very detailed, no assumptions.

---

### YouTube channels worth following

**Freya Holmér** - Game math, vectors, interpolation, bezier curves. Very visual explanations that make concepts like lerp and smoothstep actually make sense.

**Sebastian Lague** - Builds game systems from scratch (pathfinding, terrain generation, physics). Similar spirit to this project, great for learning by doing.

**SimonDev** - Covers 3D game rendering and Three.js. Good for understanding how rendering pipelines work in the browser.

**Fireship** - Short sharp videos on JavaScript, Node.js, and web tech. Good for catching up on tools and concepts quickly.

**The Coding Train (Daniel Shiffman)** - Creative coding in JavaScript. Good for people coming from a non-game background who want to learn how to draw and animate things in the browser.

---

### WebSockets and Node.js

**MDN WebSocket API**
https://developer.mozilla.org/en-US/docs/Web/API/WebSocket

The definitive reference for how WebSockets work in the browser. Covers the full API, event model, and binary data handling.

**ws library (the WebSocket server used in this project)**
https://github.com/websockets/ws

The `ws` GitHub page has clear examples for everything from basic connections to binary message handling and broadcast patterns.

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
    sprite-gen.js      Procedural fallback sprites generated in code
    hud.js             Health bar, timer, score
    ai.js              Bot and jungle mob behaviour
    map.js             Map layout and mob definitions
  maps/                Saved map files (JSON)
    multiplayer/       Maps used in online matches
    3v3/               3v3 mode maps
    local2p/           Local two-player maps
    offline/           Single-player / practice maps
  sprites/             All PNG sprite assets
    players/           Player class sprite sheets
    mobs/              Enemy and jungle mob sprite sheets
    tilesets/          Tile and decoration sprites for the map
    vfx/               Visual effect sprites
    ui/                UI icons and elements
    misc/              Cursor and other shared sprites
  editor2/             The in-browser map editor (React UI + Canvas 2D)
    assets/            Editor-specific assets
  audio/               Sound files
  screenshots/         Screenshots for this README
```
