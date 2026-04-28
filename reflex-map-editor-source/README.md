# Reflex Arena — Pro Map Editor

A 2D tile/atlas map editor for Reflex Arena. Paint tile layers, place objects,
define walls/camps/spawns, configure animations, and push the result straight
to your `reflex-server`.

The editor is a static React/Vite app — no backend required. The recommended
setup is to **build it once and serve the `dist/` folder from your game server**
so it shares an origin with your `/sprites/...` assets.

---

## Quick start (local dev)

```bash
npm install
npm run dev
```

Opens at <http://localhost:5173>. Use this while you're tweaking the editor
itself. For day-to-day map editing, prefer the production setup below.

## Production setup — serve next to your game

This is what you want 99% of the time. The editor and your sprites live on the
same origin, so `/sprites/...` paths resolve naturally and there's no CORS.

### 1. Clone next to your reflex-server

```bash
# from your projects directory
git clone <this-repo-url> reflex-map-editor
cd reflex-map-editor
npm install
npm run build
```

This produces a `dist/` folder containing `index.html` + bundled assets.

### 2. Serve `dist/` from reflex-server

Add one line to your Express app (adjust the path to wherever you cloned):

```js
// reflex-server/index.js
import path from "node:path";
import express from "express";

const app = express();

// ...your existing routes...

// Serve the map editor at /editor
app.use("/editor", express.static(path.resolve("../reflex-map-editor/dist")));
```

Or copy `dist/` into your server's existing public folder:

```bash
cp -r dist/ ../reflex-server/public/editor/
```

Restart reflex-server and open <http://localhost:3000/editor>.

### 3. Point the editor at your map endpoint

In the editor toolbar, click **Server** and set:

- **Server URL:** `http://localhost:3000/api/maps/main` (or whatever your
  reflex-server uses)
- **Map name:** `main`

Then **Push** sends the current map to your server, **Pull** fetches the
current one back.

---

## How sprite paths work

The editor normalizes every sheet path to live under `/sprites/...` on export.
That means:

- When you import a sheet, paste the **server-relative path** (e.g.
  `/sprites/tilesets/dungeon.png`) — not a file:// URL or a full http URL.
- On export, the saved JSON references those same `/sprites/...` paths, which
  your game and server already know how to resolve.
- Because the editor is served from the same origin as your sprites, the
  preview canvas can also fetch them directly — no extra config.

If you paste a full URL, the editor strips the protocol/host and rewrites it.
See `normalizeSpritePath()` in `src/components/editor/TopBar.tsx`.

---

## Saving & loading maps

Three ways to persist a map:

1. **Server Push/Pull** — primary workflow. PUT (with POST fallback) to your
   reflex-server endpoint.
2. **Export** (toolbar) — downloads `map.json` to your machine. Useful for
   backups or hand-editing.
3. **Open** (toolbar) — load a `map.json` from disk.

The schema matches reflex-server exactly: `version`, `mapW/H`, `walls`,
`camps`, `spawns`, `shopZone`, `tileLayers`, `spriteSheets`,
`mapSpriteAssignments`. See `src/editor/types.ts` for the full shape.

---

## Keyboard shortcuts

| Key | Tool |
|-----|------|
| `V` | Select |
| `B` | Paint |
| `E` | Erase |
| `G` | Fill |
| `R` | Rect |
| `O` | Place object |
| `H` | Pan |
| `1` | Spawn |
| `2` | Wall |
| `3` | Camp |
| `[` / `]` | Brush size − / + |
| `Cmd/Ctrl+Z` | Undo |
| `Cmd/Ctrl+Shift+Z` | Redo |

---

## Tech stack

React 18 · Vite 5 · TypeScript · Tailwind CSS · Zustand · shadcn/ui

## Project structure

```
src/
  editor/         # store, types, persistence, sheets
  components/
    editor/       # TopBar, LeftRail, MapCanvas, Inspector, panels
    ui/           # shadcn primitives
  pages/          # Index (the editor) + NotFound
```
