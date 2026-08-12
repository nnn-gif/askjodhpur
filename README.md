# Walk Jodhpur 🚶

A **walkable 3D map of Jodhpur, Rajasthan**, rendered in the browser from **live OpenStreetMap data**. First-person WASD + mouse-look, just like walking around a city in a game.

No build step. No backend. No API key. Just two files (`index.html` + `app.js`) and a CDN.

```
┌──────────────────────────────────────────────────────────────┐
│  Browser                                                     │
│  ┌────────────────────────────────┐                           │
│  │  index.html                    │                           │
│  │   └─ import map → three.js CDN │                           │
│  │   └─ <script src="app.js">     │                           │
│  └──────────────┬─────────────────┘                           │
│                 │                                             │
│      app.js     │  1. fetch() POST  Overpass QL               │
│                 │ ──────────────────────────────────────────► │
│                 │              overpass-api.de                │
│                 │                                             │
│                 │  2. JSON: building polygons + road lines    │
│                 │ ◄────────────────────────────────────────── │
│                 │                                             │
│                 │  3. lat/lon → meters (equirectangular)      │
│                 │  4. extrude footprints → 3D boxes           │
│                 │  5. PointerLock + WASD + collision loop     │
│                 │                                             │
│                 ▼                                             │
│            WebGL canvas (walk around)                         │
└──────────────────────────────────────────────────────────────┘
```

---

## Run it

Because the code uses ES modules and fetches a remote API, open it via a tiny local server (not `file://`):

```bash
# from this repo's root
python3 -m http.server 8000
# then open http://localhost:8000
```

Or with Node: `npx serve .` — any static server works.

The city loads and you can walk immediately — **W A S D** to move, **drag** to look around, **`←` `→`** or **Q/E** to turn, **Shift** to run, **V** to switch between first- and third-person. (In a normal desktop browser, clicking once upgrades you to pointer-lock FPS mouse-look; in embedded webviews like this one, drag-to-look just stays active.)

---

## What's actually here

```
askjodhpur/
├── index.html   # page shell, import map, overlay/HUD markup
├── app.js       # the whole demo: fetch OSM → 3D → walk loop
└── README.md    # this file
```

That's it. Two source files.

---

## The techniques, in order, and why each was chosen

This section exists because "a browser-based walkable city" can be built a dozen ways. Here's every decision in this codebase and the alternative it beat.

### 1. Rendering library: **three.js** (via CDN import map)

**What:** [three.js](https://threejs.org/) is the dominant WebGL library for the browser. We load it straight from the jsDelivr CDN using an [import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap), which lets us write `import * as THREE from 'three'` with **no bundler**.

**Why not the alternatives:**

| Option | Why not here |
|---|---|
| Babylon.js | Excellent and has built-in physics/collision — a fine choice. Three.js was picked for the larger ecosystem of examples and the bare-bones control it gives over the render loop, which makes the demo more instructive. |
| PlayCanvas | A whole engine with an editor — more than this demo needs and harder to read top-to-bottom as a learning artifact. |
| Raw WebGL | 10× the code for no perceptible benefit. |
| A-Frame | Declarative and fun, but wrapping OSM fetching + custom collision into it would fight the framework. |

**Why pin a version in the import map?** three.js ships breaking changes between minors. Pinning to `0.160.0` means this demo keeps working years from now instead of silently breaking when a new release renames an API.

### 2. Map data: **OpenStreetMap via the Overpass API**

**What:** [Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API) is OSM's free read-only query API. We send it Overpass QL and get back structured JSON: building footprints (closed polygons) and roads (polylines), each with tags like `building:levels=3`.

**Why OSM:** It's the only free, global, detailed source of real building footprints. For Jodhpur specifically it contains thousands of mapped buildings (the old city around Mehrangarh Fort is well-mapped). The query we send:

```overpassql
[out:json][timeout:60];
(
  way["building"](26.283,73.007,26.313,73.037);   // bbox around Jodhpur
  way["highway"](26.283,73.007,26.313,73.037);
);
out geom;
```

- The union `( ... )` grabs both buildings **and** roads in one request (one network round-trip).
- `out geom` embeds each way's coordinates inline. Without it we'd get node IDs and have to do a second request to resolve them.
- The 60s timeout is set both in the query and handled on the client, because Overpass is a shared free service and large bboxes can be slow.

**Reliability — what happens when Overpass 504s.** The public Overpass service is free and shared, and the Jodhpur box is heavy (~8 MB, ~9k buildings), so requests intermittently fail with **HTTP 429 / 503 / 504** under load. The loader defends against this in three layers (in `fetchOSM`):

1. **Multiple mirrors** — try `overpass-api.de` first, then `overpass.openstreetmap.fr`. (kumi.systems was dropped after being unreachable.)
2. **Retry on transient errors** — each mirror gets a couple of attempts with a short backoff. Only transient codes (`429, 500, 502, 503, 504`) and network failures are retried; a real `400` bails immediately.
3. **Shrink-and-retry** — if *every* mirror fails on the full bbox, the box is shrunk (100% → 60% → 35%) around the origin and tried again. Loading just the old-city core beats showing nothing.

It also reads the response as text first and detects HTML error pages (Overpass returns those instead of JSON on some failures) so you get a sensible message instead of a cryptic JSON parse error. The on-screen status shows which mirror / attempt is in flight, so you can see it working.

**Why not Google Maps / Mapbox tiles?** Those are raster/3D tiles you *look* at, not geometry you can collide with. We need raw polygons to build walkable 3D. Mapbox's vector tiles would work but require an API key and a paid plan above free tiers.

### 3. Coordinate projection: **equirectangular, locally centered**

**What:** Convert each `(lon, lat)` to scene meters using:

```
x = (lon - ORIGIN.lon) × 111320 × cos(ORIGIN.lat)
z = (lat - ORIGIN.lat) × 111320
```

`111320 m/°` is the length of one degree of latitude anywhere on Earth. Longitude degrees are scaled by `cos(latitude)` because meridians converge toward the poles — at Jodhpur (26.3° N) they're ~89% as far apart as parallels are.

**Why this and not UTM or Web Mercator?**

- For a ~3 km city block, *every* projection has sub-meter distortion. The projection choice is invisible.
- Equirectangular is **2 lines of code**, trivially reversible (the HUD shows live lat/lon), and needs no library.
- UTM would require knowing the zone number and pulling in `proj4js`. Web Mercator distorts distances and would make the walking speed feel wrong toward higher latitudes (irrelevant at 26° but a bad habit).

The origin is set to the heart of Jodhpur's old city `(26.298°N, 73.022°E)`, so the player starts at scene `(0,0)` near the Clock Tower area.

### 4. Making buildings 3D: **extruding polygons**

**What:** Each OSM building is a closed ring of lat/lon points. We:

1. Convert the ring to scene-space 2D points.
2. Build a `THREE.Shape` from them.
3. `THREE.ExtrudeGeometry` lifts the shape by the building's height into a solid block.
4. `rotateX(-90°)` stands the block upright (the extrude axis is +Z in shape space; we want it to be +Y in world space).

**Height:** OSM's `building:levels` tag gives floor count when present (multiplied by 3.2 m/level). Failing that, a direct `height` tag in meters. Failing that, a 6 m default. This is the same heuristic [OSMBuildings](https://osmbuildings.org/) and Cesium's OSM buildings use.

**Color:** A palette leaning into Jodhpur's "Blue City" identity (the old city's houses are famously indigo), with a few warm sandstone tones. Each building's color is picked deterministically from its OSM id (`id % palette.length`) so a building is the same color every reload — not flickering randomly.

### 5. Walking controls: **PointerLockControls + WASD, with a no-lock fallback**

**What:** [`PointerLockControls`](https://threejs.org/docs/#examples/en/controls/PointerLockControls) calls the browser's [Pointer Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_Lock_API), which hides the cursor and feeds raw mouse deltas to the camera — exactly how every FPS does mouse-look.

**Why pointer lock, not just listen to `mousemove`?** Without pointer lock the cursor hits the screen edge and you stop turning. Pointer lock has no edges, so you can spin freely. The browser **requires a user gesture** before granting pointer lock, which is why `index.html` shows a "Click to start" overlay — this is a hard security rule, not a UX choice.

**The fallback, and why it exists.** Pointer Lock is *not universally supported*. Embedded webviews (ZCode's in-app browser, many Electron apps, most mobile browsers, iframes without `allow="pointer-lock"`) either block it or, worse, silently no-op. If movement were gated on `controls.isLocked` — as the first version of this demo was — the page would load, print "Loaded Jodhpur: …", and then do nothing on those platforms. That is exactly the "nothing happens" bug this design now defends against.

The demo therefore has **two control modes**:

| Mode | When | Look | Turn | Move |
|---|---|---|---|---|
| **Fallback** (default) | always active from the moment the city finishes loading | drag (mouse/touch) | `←` `→` / `Q` `E` | WASD |
| **Pointer lock** (upgrade) | on the first click, *if* the browser actually grants lock | free mouse-look | mouse | WASD |

The key design decision: **the scene is visible and walkable the instant data finishes loading.** There is no "Click to start" gate. Previous versions of this demo waited for a click to engage pointer lock, which worked in normal browsers but stranded users on a black overlay in embedded webviews that can't deliver a usable click (ZCode's in-app browser, Electron, iframes without `allow="pointer-lock"`). The reported symptom was literally *"it never loads, just says 'Jodhpur loaded' in logs"* — the data was there, but the overlay was hiding it.

So now `boot()` calls `startFallback()` unconditionally as soon as the world is built: the loading screen and overlay are hidden, drag-to-look and WASD are wired, and the camera is live. Pointer lock becomes an *upgrade*: on the first `pointerdown` we attempt `controls.lock()`; if the browser actually fires the `lock` event we hide the cursor and switch to FPS mouse-look, and if not, drag-to-look keeps working as it already was. Movement and collision are gated on `active` (set by `startFallback`), **not** on `isLocked`.

**Movement is hand-rolled, not delegated to the controls object**, because we want to combine input with running (Shift), gravity/head-bob, collision, and the yaw/pitch of the fallback path. The camera's world direction gives forward (works for both modes); a cross product with `up` gives right; WASD scales each.

### 6. Collision: **axis-separated, point-in-polygon against real footprints**

**What:** For each building we store both a coarse **axis-aligned bounding box** (broad phase) and the **real footprint polygon** in scene XZ (narrow phase). Each frame:

1. Compute the desired move from input.
2. Try moving on **only X**. For the candidate position, skip any building whose expanded AABB doesn't contain it; for the rest, collide if the point is **inside the real footprint** OR within `PLAYER_RADIUS` of any wall edge. If colliding, cancel X.
3. Try moving on **only Z**. Same test; cancel Z if colliding.

**Why axis-separated?** If you tested the combined move and rejected it wholesale, touching a wall would stop you dead even when you're trying to slide *along* it. Resolving X and Z independently means walking into a wall sideways lets you keep sliding forward — the natural "brush past a building" feel. This is the trick the original *DOOM* and *Quake* used.

**Why point-in-polygon, not pure AABB?** An earlier version used AABB-only collision, and in dense central Jodhpur it made the demo unplayable: you'd spawn at the origin and be stuck within ~1 m, with the HUD maxing out around `-28 m` in any direction. The reason: a building's AABB is its *bounding rectangle*, which for an L-shaped or diagonally-oriented building is much larger than its real footprint. In a packed old city, narrow lanes that are open ground get "filled in" by overlapping bounding boxes and become unwalkable. Analysis on the real data showed **55%** of the ground near spawn was blocked by AABBs; switching to point-in-polygon dropped that to **39%** — reopening a large fraction of streets. On top of that, the spawn point was moved from `(0,0)` (which sat inside a footprint) to a verified street point on the *Layakam Mohalla* lane with ~2 m of clearance.

The `pointInPoly` test is the classic even-odd ray-casting algorithm; `distToPolyEdge` gives the player a radius of clearance so they don't clip into walls. The AABB broad phase keeps it cheap (the polygon math only runs for the handful of buildings near the player). For a fuller game, swap in [Rapier](https://rapier.rs/) or [cannon-es](https://github.com/pmndrs/cannon-es) — the rest of the code wouldn't change.

### 7. Frame loop details

A few small things that matter:

- **`dt` clamping** (`Math.min(clock.getDelta(), 0.05)`): if the user tab-switches away, the next frame's delta can be huge and the player would teleport through a wall. Clamping prevents tunneling.
- **Head bob**: a 4 cm vertical sine while walking. Cheap, but it's the difference between "floating camera" and "person walking".
- **Fog**: `scene.fog` from 120 m to 450 m. It hides the hard edge where the OSM data ends and adds depth. The far value must be **less** than the data radius (~1.5 km), so you never see empty void — just haze.
- **`setPixelRatio(min(dpr, 2))`**: caps rendering at 2× on high-DPI phones to keep frame rate sane.
- **Place names in the HUD**: raw lat/lon is meaningless to a human, so the HUD reverse-geocodes the player's position to a readable label like *"Layakam Mohalla • Paota • Jodhpur"*. This uses OSM's [Nominatim](https://nominatim.org/) reverse-geocode API, and the design respects its constraints:
  - **Throttled** — Nominatim's usage policy caps at 1 req/s, so we look up at most every **3 s** *and* only after the player has moved **>15 m**. In practice that's far under the limit, even when running.
  - **Browser UA** — Nominatim asks for a meaningful `User-Agent`, but browsers [forbid](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/setRequestHeader) setting `User-Agent` from `fetch`. The default browser UA is accepted by the public instance (verified), so we rely on it; English names are requested via `Accept-Language: en`.
  - **Fault-tolerant** — if a lookup fails (rate-limit, offline), the HUD keeps showing the last known label; walking never breaks over a missing name.
  - **Seeded at spawn** — `boot()` fires one lookup at the spawn point so the label isn't blank for the first few seconds before the player moves.

---

## Minimap — knowing where you are

The first-person view alone gives no sense of overall position or heading, so a small **top-down minimap** sits in the top-right corner. It shows buildings (blue polygons), roads (dark lines), and a red triangle that marks the player and points where they're looking.

Two things make it cheap and readable:

- **Static map rendered once.** Drawing ~8,900 building polygons every frame would waste CPU. Instead, the whole loaded city is rendered **once** to an offscreen canvas when data finishes loading (`renderMinimapBase`). Each frame only blits a window of that offscreen image and draws the player marker.
- **Player-centred, north-up.** The minimap always centres on the player and shows a ~160 m window around them — the full 3 km city in 200 px would be ~15 m/px, too coarse to read. North is up so the map's orientation never surprises you.

World→minimap geometry: scene `+X` (east) → right, scene `+Z` (north) → up (the Z axis is flipped because canvas Y grows downward). The player's heading comes from the camera's world direction via `atan2(fwd.x, -fwd.z)`, which works in both pointer-lock and drag-to-look modes. The per-frame minimap draw is wrapped in a try/catch so a drawing failure can never stall the movement loop.

---

## Character / third-person view (Vice-City style)

Press **V** (or click the **👁 button** in the top-left) to switch between first- and third-person. In third-person you see a small blocky humanoid — your character — walking through Jodhpur, with the camera trailing behind and above, exactly like the original *Vice City*.

**Procedural avatar, no external assets.** The humanoid is built entirely from `BoxGeometry` primitives — torso, head/hair, two arms, two legs — in ~50 lines of `buildAvatar()`. Each limb is a child of a small *pivot group* positioned at the shoulder/hip joint, so rotating the pivot about X swings the limb naturally. This matches the demo's "no build step, no assets" philosophy: it can never 404 or hit a license snag. Colors lean Vice-City (orange "Hawaiian" shirt, dark pants).

**Walk cycle.** `animateAvatar(dt, moving, speed)` swings the four limbs with a sine while moving — opposite arms/legs (left arm forward when right leg forward) — and the swing frequency scales with speed so running looks faster than walking. When idle, the limbs ease back to neutral. The avatar's yaw tracks the player's facing so the character turns to face where you look.

**The architectural change underneath.** Before this feature, *the camera was the player* — `camera.position` sat at eye height and was moved directly. Third-person requires decoupling them, so the code now maintains a canonical `playerPos` (feet-level) that **both view modes share**. Each frame the movement + collision math moves `playerPos`, then the camera is placed relative to it:
- **First-person:** camera at `playerPos + (0, EYE_HEIGHT + headBob, 0)`. Numerically identical to before — same eye height, same ±4 cm head-bob. Verified to feel unchanged.
- **Third-person:** camera at `playerPos - forward·4.5 m + (0, 2.2 m, 0)`, looking at the avatar's chest (`AVATAR_LOOK_HEIGHT = 1.2 m`); the avatar mesh sits at `playerPos` with `y=0`.

A subtle but important correctness fix came with this: the manual `yaw`/`pitch` variables are **stale in pointer-lock mode** (PointerLockControls writes the camera quaternion directly, bypassing them). So the avatar's facing and the third-person camera offset are derived from a single `getPlayerYaw()` helper that reads yaw from the camera's world direction (`atan2(fwd.x, -fwd.z)` — the same formula the minimap already used). This makes the character's facing correct in **both** pointer-lock and drag-to-look modes.

**Known limitation:** the third-person camera doesn't (yet) collide with walls, so in Jodhpur's tight lanes it can clip through a building behind you. A real fix is camera ray-collision against building AABBs; noted as a future improvement rather than tackled here.

---

## Why this works as "a walkable Vice-City-style map"

The original *Vice City* is, under the hood, four things:

1. **A ground surface** → our sandy plane.
2. **A road network giving the city structure** → our OSM highways, drawn as lines.
3. **Buildings placed on lots** → our extruded OSM footprints (placed by reality, not by hand).
4. **Walk/collision rules** → pointer lock + AABB collision.

The only difference from Vice City is that **the level designer is the city of Jodhpur itself**, via OpenStreetMap. That's the trick that makes a single developer able to ship a walkable city in two files.

---

## Limitations & easy upgrades

This is a demo, not GTA VI. Known gaps and where to push next:

| Limitation | Upgrade path |
|---|---|
| Buildings are flat-topped boxes (no windows, roofs) | Apply a window texture in the material, or generate geometry with [F4Map](https://demo.f4map.com/)-style CGA rules. |
| Only one bbox loaded (~3 km²) | Page in adjacent bboxes as the player walks, the way MMOs stream terrain. |
| No roads-as-geometry, only lines | Triangulate road polylines into flat ribbons so they look paved. |
| Collision is AABB only (corners feel blocky) | Add per-building capsule-vs-polygon tests, or move to Rapier. |
| No interiors | Some OSM buildings have indoor data; load `indoor=level/*` tags. |
| Overpass can rate-limit | Self-host an Overpass instance, or snapshot the data to a static `.geojson` file (the loader barely changes). |
| No map UI / minimap | Add a Leaflet minimap in a corner, synced to the player's lat/lon (the HUD already computes it). |

---

## Data & licensing

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), licensed under the [Open Database License (ODbL)](https://www.openstreetmap.org/copyright). If you redistribute the rendered map you must credit OSM.
- three.js is MIT-licensed.
- This demo's code is yours to use.

---

## File-by-file pointers

- **`index.html`** — page markup, the import map that loads three.js, the click-to-start overlay (required for pointer lock), HUD, and crosshair. Read top to bottom; it's mostly HTML.
- **`app.js`** — every technique above, in numbered sections (0–8). Heavily commented; the comments are the real documentation. Start at the top and follow the pipeline: fetch → project → extrude → walk.
