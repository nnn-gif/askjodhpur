// =============================================================================
// Walk Jodhpur — a walkable 3D city map in the browser.
//
// This single file does everything. It is intentionally dependency-light
// (just three.js from CDN) so you can read it top-to-bottom and understand
// every step. The README explains *why* each choice was made; the comments
// here explain *how*.
//
// Pipeline (section numbers match the sections below):
//   2.  Fetch real building + road geometry for Jodhpur from the Overpass API
//       (OpenStreetMap's read endpoint), plus gates/landmarks for the
//       destinations panel.
//   1.  Convert latitude/longitude into 3D scene coordinates (equirectangular
//       projection centered on the city).
//   4.  Extrude each building footprint into a 3D block; lay roads as flat
//       ribbons sized by road type.
//   9.  Wire controls: pointer-lock mouse-look with a drag-to-look fallback,
//       WASD movement, first/third-person view toggle.
//   12. Run a frame loop that moves the player, resolves collision against
//       real building footprints, places the camera/avatar per view mode,
//       and updates the HUD + minimap.
//   13. Boot: load, build, go.
// =============================================================================

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// -----------------------------------------------------------------------------
// 0. Configuration
// -----------------------------------------------------------------------------
// All tuning scalars live here so there's one place to look. Feature-specific
// lookup tables (CITY_BLUES/CITY_WARMS, ROAD_STYLE) stay co-located with
// their builders in section 4, where they're most readable.

// --- Geographic --------------------------------------------------------------

// The geographic center of the area we want to walk. Jodhpur's old city sits
// roughly here (near the Mehrangarh Fort / Clock Tower area). All lat/lon
// points are measured as offsets from this origin.
const ORIGIN = { lat: 26.2980, lon: 73.0220 };

// Bounding box around the origin to limit how much OSM data we pull.
// ~0.015° ≈ 1.6 km, so this box is roughly 3 km × 3 km — a walkable district.
const BBOX = {
  south: ORIGIN.lat - 0.015,
  west:  ORIGIN.lon - 0.015,
  north: ORIGIN.lat + 0.015,
  east:  ORIGIN.lon + 0.015,
};

// Meters per degree of latitude. This is nearly constant worldwide (~111.3 km
// per degree) because latitude lines are evenly spaced. We use it to scale the
// world so 1 scene unit = 1 meter — which makes camera heights, collision
// radii, and walking speeds physically meaningful.
const METERS_PER_DEG_LAT = 111320;

// --- Player physics (meters / seconds) ----------------------------------------

const EYE_HEIGHT     = 1.7;   // average human eye height
const WALK_SPEED     = 4.5;   // brisk pace (~16 km/h) — zippy enough to enjoy the city
const RUN_SPEED      = 14.0;  // sprint (hold Shift) — covers the 3 km map quickly
const PLAYER_RADIUS  = 0.4;   // collision clearance from walls

// --- Third-person view tuning --------------------------------------------------
// The camera sits this far BEHIND the avatar, this high above the avatar's
// feet, and looks at the avatar's upper body. See README "Character".

const THIRD_PERSON_DIST   = 4.5;   // camera distance behind the avatar, meters
const THIRD_PERSON_HEIGHT = 2.2;   // camera height above avatar feet, meters
const AVATAR_LOOK_HEIGHT  = 1.2;   // where the camera aims on the avatar (chest)

// --- Top-down (Road-Fighter-style) view tuning ----------------------------------
// The camera hovers directly above the player, heading-up: your forward
// direction always points to the top of the screen and the world rotates
// beneath you — like the classic top-down driving games (and the original
// GTA 1/2). This is also the best view for reading the street network.

const TOP_DOWN_HEIGHT = 60;        // camera height above the ground, meters

// --- Movement feel (game juice) -------------------------------------------------
// Momentum: velocity eases toward the input direction instead of snapping, so
// starts/stops feel like a person with weight. FOV kick: the camera widens
// slightly at sprint speed — cheap, but it makes running FEEL fast.
const FOV_BASE    = 72;    // resting field of view (degrees)
const FOV_SPRINT  = 82;    // FOV at full sprint
const MOVE_ACCEL  = 10;    // velocity approach rate while input held (1/s)
const MOVE_DECEL  = 7;     // ...and when releasing (slightly floatier stop)

// --- World streaming (tile grid) --------------------------------------------------
// Instead of one ~8 MB whole-city fetch, the world loads as a grid of 1 km
// tiles around the PLAYER: the center tile starts in ~1–2 s (a ~1 MB query),
// the 3×3 ring streams in the background, and walking/teleporting toward an
// edge queues the next ring in your direction of travel. Tiles stay loaded
// (memory stays modest — each tile is one merged mesh, one draw call).
const TILE_SIZE_M = 1000;          // tile edge, meters
const TILE_RING   = 1;             // load 3×3 tiles around the player
const MINIMAP_EXTENT_M = 4000;     // minimap covers ±4 km from origin (fixed)

// --- Overpass reliability -------------------------------------------------------
// The public Overpass service is free and shared. Heavy queries (a ~3 km city
// box returns ~8 MB / thousands of buildings) intermittently fail with HTTP
// 429 (rate limit), 503, or 504 (gateway timeout), and network blips surface
// as ERR_NETWORK_CHANGED / "Failed to fetch". To stay robust the loader:
//   1. tries several mirrors in order (the main DE server and the FR mirror),
//   2. retries each mirror a few times on transient errors,
//   3. if every mirror fails on the full bbox, shrinks the bbox and retries,
//      on the assumption that *some* of the city beats *none* of it.
// kumi.systems was dropped because it was unreachable at the time of writing.

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
];
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 2500;

// --- Minimap --------------------------------------------------------------------

const MINIMAP_SIZE_PX     = 200;   // visible canvas size (square)
const MINIMAP_VIEW_METERS = 160;   // world meters across the visible window

// --- Place-name lookup (Nominatim reverse geocode) -------------------------------
// Nominatim's usage policy is MAX 1 request/second; we throttle far below that.

const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const PLACE_REFRESH_MS   = 3000;   // min time between lookups
const PLACE_REFRESH_DIST = 15;     // min meters moved before re-querying
const PLACE_ZOOM         = 18;     // street-level detail (road + neighbourhood)

// --- Input ----------------------------------------------------------------------

// Keys that resume the game from the Esc-pause screen. Movement/look keys, but
// not modifier-only presses.
const RESUME_KEYS = [
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyQ', 'KeyE',
];

// --- DOM element references -------------------------------------------------------
// Gathered in one place instead of getElementById calls sprinkled throughout.
// (The module script runs at the end of <body>, so the DOM exists by now.)

const dom = {
  app:         document.getElementById('app'),
  overlay:     document.getElementById('overlay'),
  loading:     document.getElementById('loading'),
  hud:         document.getElementById('hud'),
  status:      document.getElementById('status'),
  crosshair:   document.getElementById('crosshair'),
  viewToggle:  document.getElementById('viewToggle'),
  inputDebug:  document.getElementById('inputDebug'),
  minimapWrap: document.getElementById('minimapWrap'),
  minimap:     document.getElementById('minimap'),
  destinations: document.getElementById('destinations'),
  destList:    document.getElementById('destList'),
  destCount:   document.getElementById('destCount'),
  destHeader:  document.getElementById('destHeader'),
};

// -----------------------------------------------------------------------------
// 1. Geographic projection: lat/lon ↔ scene coordinates
// -----------------------------------------------------------------------------
//
// A globe's coordinates can't be used directly in a flat 3D scene. We use the
// simplest possible projection: equirectangular. Latitude → Z (north/south),
// longitude → X (east/west). Longitude is scaled by cos(latitude) because
// lines of longitude converge toward the poles — at Jodhpur's latitude they're
// only ~89% as far apart as latitude lines are. This keeps distances correct.
//
// Why this and not a "proper" projection like UTM? Because for a 3 km city
// block the distortion from any projection is sub-meter, and equirectangular
// is trivially reversible and readable. UTM would add a dependency and gain
// us nothing visible.

const cosLat = Math.cos(ORIGIN.lat * Math.PI / 180);

function lonLatToXY(lon, lat) {
  const x = (lon - ORIGIN.lon) * METERS_PER_DEG_LAT * cosLat;
  const y = (lat - ORIGIN.lat) * METERS_PER_DEG_LAT;
  return [x, y];
}

// Inverse of lonLatToXY — used by the HUD + place lookups.
function scenePosToLatLon(pos) {
  const lat = ORIGIN.lat + pos.z / METERS_PER_DEG_LAT;
  const lon = ORIGIN.lon + pos.x / (METERS_PER_DEG_LAT * cosLat);
  return { lat, lon };
}

// -----------------------------------------------------------------------------
// 2. OSM data fetch (Overpass API)
// -----------------------------------------------------------------------------
//
// Overpass is OpenStreetMap's read-only query API. We send it Overpass QL and
// get back GeoJSON-ish elements: ways (ordered lists of lat/lon nodes) tagged
// with things like building=yes, highway=residential, building:levels=3.
//
// The main query requests both buildings and roads in one call (the union
// `(...)`) so we pay only one network round-trip. `out geom` embeds each way's
// coordinates inline — without it we'd have to resolve node IDs separately,
// doubling the number of requests.

function buildOverpassQuery(bbox) {
  // bbox defaults to the full city box; a smaller bbox can be passed in by the
  // shrink-and-retry path.
  const b = bbox || BBOX;
  return `
    [out:json][timeout:60];
    (
      way["building"](${b.south},${b.west},${b.north},${b.east});
      way["highway"](${b.south},${b.west},${b.north},${b.east});
    );
    out geom;
  `;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Hit one mirror once. Returns parsed {buildings, roads} or throws on error.
// We do NOT send an explicit Content-Type header: some Overpass front-ends
// reject requests whose Accept/Content-Type they dislike (observed 406 from
// stricter clients), and a plain URL-encoded POST body works everywhere.
async function fetchOnce(endpoint, query, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: ctrl.signal,
      body: 'data=' + encodeURIComponent(query),
    });
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    const text = await res.text();
    // Overpass returns HTML error pages (not JSON) on some failures; detect
    // that here instead of letting res.json() throw an opaque parse error.
    if (text.startsWith('<')) {
      throw new Error('Overpass returned an HTML error page');
    }
    const json = JSON.parse(text);
    const buildings = [];
    const roads = [];
    for (const el of json.elements) {
      if (el.type !== 'way' || !el.geometry) continue;
      const tags = el.tags || {};
      if (tags.building) buildings.push(el);
      else if (tags.highway) roads.push(el);
    }
    return { buildings, roads };
  } finally {
    clearTimeout(timer);
  }
}

// isRetryable: network failure or a known-transient HTTP status (or our own
// HTML-page marker). 4xx other than 429 are permanent and should NOT retry.
function isRetryable(err) {
  const m = String(err && err.message || '');
  if (m.includes('Overpass HTTP')) {
    const code = parseInt(m.replace(/.*Overpass HTTP (\d+).*/, '$1'), 10);
    if (code) return TRANSIENT_STATUS.has(code);
  }
  // AbortError / fetch network failure → try the next mirror.
  // 'returned no data' MUST be retryable: an empty (bad-cache) response from
  // one mirror shouldn't abort the whole load when the other mirror may be
  // fine — that was a real abort-the-entire-fetch bug.
  return m.includes('HTML error page') ||
         m.includes('returned no data') ||
         m.includes('Failed to fetch') ||
         m.includes('Aborted') ||
         m.includes('NetworkError') ||
         m.includes('Load failed');
}

// --- Streaming tile manager -------------------------------------------------------
//
// The whole city no longer loads in one mega-fetch. The world is a grid of
// TILE_SIZE_M tiles; the tile under the player loads first (fast start), the
// 3×3 ring streams in behind it, and moving toward an edge queues the next
// ring in the direction of travel. Ways that straddle a tile boundary come
// back in BOTH tile queries (Overpass returns full geometry for anything
// intersecting the bbox), so ids are deduped globally. Each tile's buildings
// merge into their own mesh (one draw call per tile) and paint onto the
// minimap's fixed base canvas as they arrive.
const loadedTiles = new Set();       // "ix,iz" keys of completed tiles
const loadingTiles = new Set();      // in flight
const _tileQueue = [];               // pending keys, loaded one at a time
const seenBuildingIds = new Set();   // global OSM-way dedupe
const seenRoadIds = new Set();
let streamingStats = { buildings: 0, roads: 0, trees: 0, tiles: 0 };

const tileKey = (ix, iz) => ix + ',' + iz;
const playerTile = () => ({
  ix: Math.round(playerPos.x / TILE_SIZE_M),
  iz: Math.round(playerPos.z / TILE_SIZE_M),
});

// Scene-meters tile bounds → lat/lon bbox for Overpass.
function tileBbox(ix, iz) {
  const half = TILE_SIZE_M / 2;
  const cx = ix * TILE_SIZE_M, cz = iz * TILE_SIZE_M;
  return {
    south: ORIGIN.lat + (cz - half) / METERS_PER_DEG_LAT,
    north: ORIGIN.lat + (cz + half) / METERS_PER_DEG_LAT,
    west:  ORIGIN.lon + (cx - half) / (METERS_PER_DEG_LAT * cosLat),
    east:  ORIGIN.lon + (cx + half) / (METERS_PER_DEG_LAT * cosLat),
  };
}

async function fetchTileData(bbox) {
  // Mirrors × retries, no bbox-shrink (a 1 km tile that fails everywhere is
  // just skipped — neighboring tiles still give a playable world).
  for (const mirror of OVERPASS_MIRRORS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await fetchOnce(mirror, buildOverpassQuery(bbox));
        if (!r.buildings.length && !r.roads.length) throw new Error('Overpass returned no data');
        return r;
      } catch (err) {
        console.warn(`Tile fetch failed (${mirror}, try ${attempt}):`, err.message);
        if (attempt < 2) await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw new Error('tile fetch failed on all mirrors');
}

async function loadTile(ix, iz) {
  const key = tileKey(ix, iz);
  if (loadedTiles.has(key) || loadingTiles.has(key)) return false;
  loadingTiles.add(key);
  try {
    const data = await fetchTileData(tileBbox(ix, iz));

    // Dedupe boundary-straddling ways, then build.
    const buildings = data.buildings.filter(b => !seenBuildingIds.has(b.id));
    const roads = data.roads.filter(r => !seenRoadIds.has(r.id));
    for (const b of buildings) seenBuildingIds.add(b.id);
    for (const r of roads) seenRoadIds.add(r.id);

    const colsBefore = colliders.length;
    const segsBefore = roadSegments.length;
    const namedBefore = namedRoadSegments.length;

    const nB = buildBuildings(buildings);
    const nR = buildRoads(roads);
    const newCols = colliders.slice(colsBefore);
    const newSegs = roadSegments.slice(segsBefore);
    const newNamed = namedRoadSegments.slice(namedBefore);
    const nT = buildTrees(newSegs) || 0;

    // Paint this tile onto the minimap's base canvas (fixed transform).
    paintMinimapRegion(newCols, newSegs, newNamed);

    loadedTiles.add(key);
    streamingStats.buildings += nB;
    streamingStats.roads += nR;
    streamingStats.trees += nT;
    streamingStats.tiles += 1;
    console.log(`Tile ${key} loaded: +${nB} buildings, +${nR} roads, +${nT} trees (totals: ${streamingStats.buildings}/${streamingStats.roads}/${streamingStats.trees}).`);
    // Keep the status line current while districts stream in — but never
    // clobber game messages (mission/teleport/pause text).
    if ((dom.status.textContent || '').includes('streaming')) {
      dom.status.textContent =
        `Jodhpur streaming: ${streamingStats.buildings} buildings, ${streamingStats.roads} roads, ${streamingStats.trees} trees — ${streamingStats.tiles} districts`;
    }
    return true;
  } catch (err) {
    console.warn(`Tile ${key} failed to load:`, err.message);
    return false;   // not marked loaded — re-approaching the area retries
  } finally {
    loadingTiles.delete(key);
  }
}

// Queue the 3×3 ring around a tile index (skips already-loaded tiles).
function ensureTilesAround(ix, iz) {
  for (let dz = -TILE_RING; dz <= TILE_RING; dz++) {
    for (let dx = -TILE_RING; dx <= TILE_RING; dx++) {
      const key = tileKey(ix + dx, iz + dz);
      if (loadedTiles.has(key) || loadingTiles.has(key)) continue;
      if (!_tileQueue.includes(key)) _tileQueue.push(key);
    }
  }
}

// Background pump: load queued tiles one at a time (gentle on the free
// Overpass service). Runs forever; idles cheaply when the queue is empty.
async function tilePump() {
  for (;;) {
    const key = _tileQueue.shift();
    if (key === undefined) { await sleep(500); continue; }
    // Skip if it became loaded/irrelevant while queued.
    if (loadedTiles.has(key) || loadingTiles.has(key)) continue;
    const [ix, iz] = key.split(',').map(Number);
    await loadTile(ix, iz);
  }
}

// Per-frame check (from animate): when the player crosses into a new tile,
// ensure the ring around the new position. Cheap — a key comparison.
let _lastPlayerTileKey = null;
function updateStreaming() {
  const { ix, iz } = playerTile();
  const key = tileKey(ix, iz);
  if (key === _lastPlayerTileKey) return;
  _lastPlayerTileKey = key;
  ensureTilesAround(ix, iz);
}

// Fetch named gates + major landmarks for the "destinations" panel — the list
// of places the user can click to teleport to. We query OSM for the things that
// make useful navigation targets in a historic city like Jodhpur: city gates
// (the old-city "pol" gates), the fort, palaces, named attractions, and
// memorials. Results are filtered to those with a name and converted to scene
// XY so teleport can move `playerPos` directly.
//
// This is a SEPARATE, much smaller query than the building/road one, run after
// the world has loaded, so it can't slow down or block the initial scene.
async function fetchLandmarks() {
  const q = `
    [out:json][timeout:60];
    (
      nwr["historic"="city_gate"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
      nwr["barrier"="gate"]["name"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
      nwr["historic"="castle"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
      nwr["tourism"="attraction"]["name"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
      nwr["historic"="memorial"]["name"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
    );
    out center tags;
  `;
  // Two passes over the mirrors — the landmarks list drives the destinations
  // panel AND missions, so a single bad Overpass moment shouldn't kill it.
  for (let pass = 0; pass < 2; pass++) {
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(q),
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.startsWith('<')) continue;
      const json = JSON.parse(text);
      const out = [];
      const seen = new Set();
      for (const el of json.elements) {
        const tags = el.tags || {};
        const name = tags['name:en'] || tags.name || '';
        if (!name) continue;
        // Get a single lat/lon: node has its own, way/relation has center.
        let lat, lon;
        if (el.lat != null) { lat = el.lat; lon = el.lon; }
        else if (el.center) { lat = el.center.lat; lon = el.center.lon; }
        else continue;
        const [x, z] = lonLatToXY(lon, lat);
        // Dedupe by name (some landmarks appear as both node and way).
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          name,
          kind: tags.historic || tags.tourism || tags.barrier || 'landmark',
          x, z, lat, lon,
        });
      }
      // Sort: gates first (most useful for navigation), then by distance from
      // origin so the closest/most-central landmarks come first.
      const isGate = l => /^(gate|city_gate)$/i.test(l.kind);
      out.sort((a, b) => {
        const ga = isGate(a) ? 0 : 1, gb = isGate(b) ? 0 : 1;
        if (ga !== gb) return ga - gb;
        return Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z);
      });
      return out;
    } catch (e) {
      console.warn(`Landmarks fetch failed on ${mirror}:`, e.message);
    }
  }
  }
  return [];   // non-fatal: panel just won't populate (panorama spots work regardless)
}

// -----------------------------------------------------------------------------
// 3. Three.js scene setup
// -----------------------------------------------------------------------------

const scene = new THREE.Scene();

// --- Sky: vertical gradient (golden-hour Rajasthan) --------------------------
// A tiny 16×256 canvas stretched as the background: deeper blue zenith fading
// through pale haze into a warm horizon glow. Cheap (one texture, no geometry)
// and instantly sets the time of day. The fog color below matches the horizon
// so distant buildings fade into the same warm haze.
function makeSkyTexture() {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.00, '#6fa8dc');   // zenith
  grad.addColorStop(0.45, '#b8d4e8');   // mid haze
  grad.addColorStop(0.72, '#eed9b3');   // warm transition
  grad.addColorStop(0.90, '#f0c891');   // horizon glow
  grad.addColorStop(1.00, '#e6b27e');   // low horizon
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 256);
  return new THREE.CanvasTexture(c);
}
scene.background = makeSkyTexture();
// Fog matched to the warm horizon tone so the far edge of the data dissolves
// into haze instead of a hard cut.
scene.fog = new THREE.Fog(0xeed3a6, 120, 450);

const camera = new THREE.PerspectiveCamera(
  FOV_BASE,                                          // resting FOV; widens to
                                                    // FOV_SPRINT while running
  window.innerWidth / window.innerHeight,
  0.1, 1000
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // cap at 2x for perf
renderer.shadowMap.enabled = true;
dom.app.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Lighting: late-afternoon desert sun --------------------------------------
// A hemisphere light gives soft sky-vs-ground ambient fill; a single warm,
// fairly LOW directional light stands in for the sun (golden hour — long
// shadows, warm walls). Warm ground bounce keeps shadowed faces from going
// cold blue.
const hemi = new THREE.HemisphereLight(0xcfe0f5, 0x9a7b55, 0.75);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffd9a0, 1.25);
sun.position.set(120, 85, -60);       // lower angle → longer shadows
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
// Keep the shadow camera framed on the area around the player's start so the
// shadow map has useful resolution where it matters.
sun.shadow.camera.left = -150;
sun.shadow.camera.right = 150;
sun.shadow.camera.top = 150;
sun.shadow.camera.bottom = -150;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 500;
scene.add(sun);

// --- Ground plane: procedural sand texture ------------------------------------
// A 256px canvas of sandy grain + faint patches, tiled ~180× across the 4 km
// plane (~22 m per tile). One texture kills the "flat paint" look of a solid
// color while staying perfectly seamless by construction (noise only).
function makeGroundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#c9b08a';                 // base sand (same family as before)
  g.fillRect(0, 0, 256, 256);
  // Fine grain: thousands of 1–3 px specks, darker + lighter.
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(120,96,66,0.10)' : 'rgba(240,224,190,0.10)';
    const s = 1 + Math.random() * 2.5;
    g.fillRect(Math.random() * 256, Math.random() * 256, s, s);
  }
  // Faint larger patches so the ground isn't uniformly noisy.
  for (let i = 0; i < 22; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(140,110,80,0.05)' : 'rgba(235,220,190,0.05)';
    g.beginPath();
    g.arc(Math.random() * 256, Math.random() * 256, 18 + Math.random() * 36, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(180, 180);
  return tex;
}

const groundGeo = new THREE.PlaneGeometry(4000, 4000);
const groundMat = new THREE.MeshStandardMaterial({ map: makeGroundTexture(), roughness: 1 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;   // PlaneGeometry is in the XY plane; rotate
                                     // it to lie flat on the XZ ground plane.
ground.receiveShadow = true;
scene.add(ground);

// -----------------------------------------------------------------------------
// 4. World geometry from OSM data (buildings + roads)
// -----------------------------------------------------------------------------

// --- Buildings -----------------------------------------------------------------
//
// Each OSM building is a closed polygon of lat/lon points. We:
//   - convert each point to scene meters,
//   - build a THREE.Shape from the polygon,
//   - extrude it upward by the building's height to get a solid block.
//
// Height: OSM's `building:levels` tag gives the floor count if present;
// otherwise we fall back to a default. This is the standard heuristic used by
// OSMBuildings, Cesium, and other OSM-3D viewers.

const METERS_PER_LEVEL = 3.2;

// Deterministic pseudo-random from an integer id (mulberry-style bit mix).
// Same id → same value on every load, so building heights/colors are stable.
function hashId(id) {
  let h = Math.abs(id | 0);
  h = (h ^ 61) ^ (h >>> 16);
  h = h + (h << 3);
  h = h ^ (h >>> 4);
  h = Math.imul(h, 0x27d4eb2d);
  h = h ^ (h >>> 15);
  return (h >>> 0) / 4294967296;   // 0..1
}

function buildingHeight(tags, id) {
  const levels = parseFloat(tags['building:levels']);
  if (!isNaN(levels) && levels > 0) return levels * METERS_PER_LEVEL;
  const h = parseFloat(tags['height']); // some tags give meters directly
  if (!isNaN(h) && h > 0) return h;
  // The invented fallback — VARIED, deterministic per building, weighted like
  // the real old city: mostly 2 storeys, often 3, occasionally 4–5. A single
  // flat default made the skyline an unreadable slab.
  const r = hashId(id);
  if (r < 0.45) return 5.5 + r * 2.2;          // ≈5.5–7.5 m (2 storeys)
  if (r < 0.80) return 8.0 + (r - 0.45) * 4.5; // ≈8.0–9.6 m (3 storeys)
  return 10.0 + (r - 0.80) * 18.0;             // 10–13.6 m (4–5 storeys)
}

// Collision data. For each building we store:
//   - a coarse AABB (broad phase: cheap "is the player even near this building?")
//   - the real footprint polygon in scene XZ (narrow phase: accurate
//     point-in-polygon + edge-distance test).
// Why not just AABBs? Because a building's AABB is its bounding rectangle — for
// an L-shaped or diagonally-oriented building that's much larger than the
// actual footprint. In a dense old city like Jodhpur's, narrow lanes between
// buildings get "filled in" by overlapping bounding boxes and become
// un-walkable, even though they're open ground. Storing the real polygon makes
// the collision match what you see. (See section 5 for the tests.)
const colliders = [];

// A palette leaning into Jodhpur's identity: the old city's famous indigo
// blues dominate, with sun-bleached sandstone and a touch of terracotta
// mixed in. Each building picks a family+shade and gets a subtle lightness
// jitter — all deterministic from its OSM id so the city looks the same on
// every reload. Delivered as VERTEX COLORS on one merged mesh (below).
const CITY_BLUES = [0x2b4a7a, 0x33568e, 0x3f66a5, 0x5278b8, 0x6f93c9];
const CITY_WARMS = [0xc9a87c, 0xd9c2a0, 0xb08968, 0xc27e5a];

function buildingColor(id) {
  const pick = hashId(id * 7 + 13);
  const shade = hashId(id * 31 + 5);
  const jitter = hashId(id * 17 + 29);
  const hex = pick < 0.62
    ? CITY_BLUES[Math.floor(shade * CITY_BLUES.length)]
    : CITY_WARMS[Math.floor(shade * CITY_WARMS.length)];
  // offsetHSL(h, s, l): tiny hue/sat wander + ±6% lightness — enough that
  // neighbouring walls of the "same" color read as separately weathered.
  return new THREE.Color(hex).offsetHSL((jitter - 0.5) * 0.02, (jitter - 0.5) * 0.08, (jitter - 0.5) * 0.12);
}

// --- Facade texture: windows ----------------------------------------------------
// A 2×2-cell texture (one cell ≈ 3×3 m of wall) drawn on a canvas: mostly
// white (the building's vertex color tints it), dark window insets, and one
// warm LIT window per texture — golden-hour lights just coming on. Applied to
// the merged city mesh with side-wall UVs scaled so one texture cell = 3 m
// (see assignFacadeUVs), this turns 8,900 blank boxes into a city with
// windows at the cost of one texture.
let _facadeTex = null;
function facadeTexture() {
  if (_facadeTex) return _facadeTex;
  const CELL = 96;                       // px per 3 m
  const c = document.createElement('canvas');
  c.width = c.height = CELL * 2;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';               // white — vertex color provides tint
  g.fillRect(0, 0, c.width, c.height);
  // Subtle wall grain so tinted walls aren't perfectly flat.
  for (let i = 0; i < 340; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.05)';
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 2, 2);
  }
  const drawWindow = (x, y, lit) => {
    // Window: dark inset with frame, sized/positioned like a real one.
    const wx = x + CELL * 0.22, wy = y + CELL * 0.18, ww = CELL * 0.56, wh = CELL * 0.52;
    g.fillStyle = 'rgba(0,0,0,0.22)';    // outer shadow line
    g.fillRect(wx - 2, wy - 2, ww + 4, wh + 4);
    if (lit) {
      // Warm lit window — lights on at dusk. Slight gradient glow.
      const grad = g.createLinearGradient(wx, wy, wx, wy + wh);
      grad.addColorStop(0, '#ffd98f');
      grad.addColorStop(1, '#ffb95e');
      g.fillStyle = grad;
    } else {
      // Dark glass with a hint of sky reflection.
      const grad = g.createLinearGradient(wx, wy, wx, wy + wh);
      grad.addColorStop(0, 'rgba(28,38,52,0.88)');
      grad.addColorStop(1, 'rgba(16,22,32,0.92)');
      g.fillStyle = grad;
    }
    g.fillRect(wx, wy, ww, wh);
    // Sill.
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(wx - 3, wy + wh + 2, ww + 6, 3);
  };
  // 2×2 windows; deterministically light one of the four.
  const litIdx = 2;
  for (let i = 0; i < 4; i++) {
    drawWindow((i % 2) * CELL, Math.floor(i / 2) * CELL, i === litIdx);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  _facadeTex = tex;
  return tex;
}

// Rewrite SIDE-WALL UVs so the facade texture tiles one cell per 3 m:
// u = position along the wall (world X or Z, whichever the wall faces),
// v = height. ExtrudeGeometry's default side UVs don't follow wall length,
// which would smear the window pattern; this makes windows real-size.
// Cap faces (roof/footprint) keep their default UVs — the texture's white
// base means the roof just takes the building tint.
function assignFacadeUVs(geo) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const ny = nor.getY(i);
    if (Math.abs(ny) > 0.5) continue;             // top/bottom caps
    const nx = nor.getX(i), nz = nor.getZ(i);
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const u = Math.abs(nx) > Math.abs(nz) ? z / 3 : x / 3;
    uv.setXY(i, u, y / 3);
  }
}

// The shared material for all city building meshes (one instance; every tile
// merge references it — the facade texture and vertex colors do the variety).
let _cityMaterial = null;
function cityMaterial() {
  if (!_cityMaterial) {
    _cityMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true, map: facadeTexture(), roughness: 0.9, metalness: 0,
    });
  }
  return _cityMaterial;
}

function buildBuildings(buildings) {
  // ALL buildings merge into ONE mesh whose per-building colors come from a
  // vertex-color attribute (see buildingColor). That's one draw call for the
  // entire city (plus one for the shadow pass) — down from ~9,000 originally
  // and 7 after the first merge pass — while allowing continuous color
  // variation that per-material palettes can't. Collision data is stored
  // separately below and is unaffected.
  const allGeos = [];
  let built = 0;

  for (const b of buildings) {
    const ring = b.geometry;               // array of {lat, lon}
    if (!ring || ring.length < 3) continue;

    // Convert the ring to scene-space XY, then into a THREE.Shape. THREE.Shape
    // lives in 2D; the ExtrudeGeometry will lift it along +Z, which we then
    // rotate to stand upright.
    const pts = ring.map(p => {
      const [x, y] = lonLatToXY(p.lon, p.lat);
      return new THREE.Vector2(x, y);
    });
    // Drop a duplicate closing point if present — THREE.Shape closes itself.
    if (pts.length > 1 &&
        pts[0].distanceTo(pts[pts.length - 1]) < 0.01) pts.pop();
    if (pts.length < 3) continue;

    let shape;
    try { shape = new THREE.Shape(pts); }
    catch (e) { continue; }                // degenerate polygon; skip

    const height = buildingHeight(b.tags || {}, b.id);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: height,
      bevelEnabled: false,
      steps: 1,
    });
    // ExtrudeGeometry extrudes along +Z in the shape's local 2D plane. We want
    // the footprint on the ground (XZ) and the extrude direction to be +Y (up).
    // So rotate -90° about X: maps local +Z → world +Y, and local XY → world XZ.
    geo.rotateX(-Math.PI / 2);
    geo.computeVertexNormals();
    assignFacadeUVs(geo);

    // Bake this building's color into a vertex-color attribute, with FAKE
    // AMBIENT OCCLUSION: vertices darken toward the ground (0.72× at the base
    // → 1.0× at the roofline). Real AO needs lightmaps; this 2-line version
    // grounds the buildings convincingly and costs nothing at render time.
    const col = buildingColor(b.id);
    const vcount = geo.attributes.position.count;
    const colors = new Float32Array(vcount * 3);
    const posAttr = geo.attributes.position;
    const aoFloor = 0.72;
    for (let i = 0; i < vcount; i++) {
      const t = Math.max(0, Math.min(1, posAttr.getY(i) / height)); // 0 base → 1 roof
      const ao = aoFloor + (1 - aoFloor) * t;
      colors[i * 3] = col.r * ao; colors[i * 3 + 1] = col.g * ao; colors[i * 3 + 2] = col.b * ao;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    allGeos.push(geo);

    // Collision data: a broad-phase AABB (expanded by player radius) and the
    // real footprint polygon in scene XZ. The AABB comes straight from the
    // footprint points — the extrusion's XZ extent equals the footprint's,
    // and collision only uses X/Z (much cheaper than a per-mesh
    // Box3.setFromObject, which traverses the full geometry).
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minZ) minZ = p.y; if (p.y > maxZ) maxZ = p.y;
    }
    colliders.push({
      minX: minX - PLAYER_RADIUS,
      maxX: maxX + PLAYER_RADIUS,
      minZ: minZ - PLAYER_RADIUS,
      maxZ: maxZ + PLAYER_RADIUS,
      // Footprint polygon in (x, z) scene coords, in the same winding as the
      // OSM ring. pointInPoly doesn't care about winding.
      poly: pts.map(p => [p.x, p.y]),
    });
    built++;
  }

  // One merged mesh PER TILE (called per tile by the streaming manager); the
  // shared white base material lets vertex colors + the facade map through.
  if (allGeos.length) {
    const merged = allGeos.length === 1 ? allGeos[0] : mergeGeometries(allGeos, false);
    const mesh = new THREE.Mesh(merged, cityMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  return built;
}

// --- Roads -----------------------------------------------------------------------
//
// Each highway is drawn as a FLAT RIBBON (a quad) lying on the ground, with
// width based on road type. Earlier these were 1-pixel lines, which vanished
// against the sandy ground at any distance — making the street network, the
// thing you actually navigate by, unreadable.
//
// Width and color come from the highway=* tag:
//   trunk/primary  → wide, light gray (main arteries)
//   secondary/tertiary → medium, gray
//   residential/service/living_street → narrow, darker gray
//   footway/path/steps/pedestrian/cycleway → very narrow, tan (walkable paths)
//
// Geometry: for each segment p1→p2, compute the perpendicular direction, then
// build a quad with the 4 corner points offset by ±width/2. Roads are flat at
// y=0.06 (just above the ground to avoid z-fighting). They have no collision —
// the player can walk on them, which is the point.
//
// We also keep a flat list of road segments in scene coords (`roadSegments`)
// for the minimap to draw, and a NAMED subset (`namedRoadSegments`) so the
// HUD can show the nearest named street — only ~3% of Jodhpur's roads are
// named in OSM, and those names are the anchors people actually know.
const roadSegments = [];
const namedRoadSegments = [];   // { name, x1, z1, x2, z2 }

// Per-road-type rendering config: [width in meters, color].
const ROAD_STYLE = {
  trunk:        [7.0, 0x9a9a9a],
  primary:      [6.5, 0x9a9a9a],
  primary_link: [5.0, 0x9a9a9a],
  secondary:    [5.5, 0x8e8e8e],
  secondary_link:[4.5, 0x8e8e8e],
  tertiary:     [4.5, 0x848484],
  unclassified: [4.0, 0x7a7a7a],
  residential:  [3.5, 0x70706e],
  living_street:[3.5, 0x70706e],
  service:      [3.0, 0x6a6a68],
  pedestrian:   [3.0, 0xb89a6a],
  footway:      [1.2, 0xb89a6a],
  path:         [1.2, 0xb89a6a],
  steps:        [1.2, 0xb89a6a],
  cycleway:     [1.5, 0xb89a6a],
};
const DEFAULT_ROAD_STYLE = [3.0, 0x70706e];
const ROAD_Y = 0.06;                     // just above ground to prevent z-fighting

function roadWidth(tags) {
  // If the road has an explicit width tag, honor it; otherwise use the type.
  const w = parseFloat(tags.width);
  if (!isNaN(w) && w > 0) return Math.min(w, 12);   // cap absurd values
  const hw = tags.highway;
  return (ROAD_STYLE[hw] || DEFAULT_ROAD_STYLE)[0];
}
function roadColor(tags) {
  const hw = tags.highway;
  return (ROAD_STYLE[hw] || DEFAULT_ROAD_STYLE)[1];
}

// Cache materials per color so roads of the same type share one material.
// (No `roughness` here — MeshBasicMaterial doesn't have that property, and
// passing it made THREE log a console warning per material.)
const _roadMatCache = Object.create(null);
function roadMaterial(color) {
  if (!_roadMatCache[color]) {
    _roadMatCache[color] = new THREE.MeshBasicMaterial({ color });
  }
  return _roadMatCache[color];
}

function buildRoads(roads) {
  // Group vertices by color so we can build one BufferGeometry per material
  // (cheap to render; avoids one draw call per road). Returns the number of
  // road ways actually built (for the streaming status line).
  const byColor = Object.create(null);   // colorHex -> { verts: [], idx: [] }
  let ways = 0;

  for (const r of roads) {
    const g = r.geometry;
    if (!g || g.length < 2) continue;
    ways++;
    const tags = r.tags || {};
    const width = roadWidth(tags);
    const half = width / 2;
    const color = roadColor(tags);
    const roadName = tags['name:en'] || tags.name || '';
    let bucket = byColor[color];
    if (!bucket) {
      bucket = { verts: [], idx: [] };
      byColor[color] = bucket;
    }

    for (let i = 0; i < g.length - 1; i++) {
      const [x1, z1] = lonLatToXY(g[i].lon, g[i].lat);
      const [x2, z2] = lonLatToXY(g[i+1].lon, g[i+1].lat);
      roadSegments.push([x1, z1, x2, z2]);
      if (roadName) namedRoadSegments.push({ name: roadName, x1, z1, x2, z2 });

      // Direction of this segment and its perpendicular (in XZ).
      let dx = x2 - x1, dz = z2 - z1;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      // Perpendicular in XZ: rotate (dx,dz) by 90° → (-dz, dx). Normalize, scale.
      const px = -dz / len * half;
      const pz =  dx / len * half;

      // Four corners of the ribbon quad (flat on the ground).
      const base = bucket.verts.length / 3;
      bucket.verts.push(
        x1 + px, ROAD_Y, z1 + pz,   // 0: p1 left
        x1 - px, ROAD_Y, z1 - pz,   // 1: p1 right
        x2 - px, ROAD_Y, z2 - pz,   // 2: p2 right
        x2 + px, ROAD_Y, z2 + pz,   // 3: p2 left
      );
      // Two triangles: (0,1,2) and (0,2,3).
      bucket.idx.push(base, base+1, base+2,  base, base+2, base+3);
    }
  }

  // Build one mesh per color bucket.
  for (const color in byColor) {
    const bucket = byColor[color];
    if (bucket.verts.length === 0) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(bucket.verts, 3));
    geo.setIndex(bucket.idx);
    geo.computeBoundingSphere();   // helps frustum culling
    scene.add(new THREE.Mesh(geo, roadMaterial(parseInt(color))));
  }
  return ways;
}

// --- Trees: greenery along the roads -------------------------------------------
// The scene had zero green, which made the blue/sand palette monotonous and
// artificial. We scatter a few hundred low-poly trees (trunk + canopy) along
// road segments, deterministically (hash-based, stable per load), offset to
// the roadside and rejected if they'd land inside a building footprint. All
// trees merge into ONE vertex-colored mesh — one draw call, no per-frame
// cost, purely decorative (no collision).
// `segments` are the NEW road segments for one tile (streaming: called per
// tile so trees are only planted along freshly loaded roads, never twice).
function buildTrees(segments) {
  // Base tree geometry: trunk cylinder + low-poly canopy, vertex-colored.
  // toNonIndexed() on the trunk is REQUIRED before merging: CylinderGeometry
  // is indexed while IcosahedronGeometry is not, and mergeGeometries returns
  // null for mixed input (which then blew up on .clone()).
  const trunk = new THREE.CylinderGeometry(0.18, 0.28, 2.4, 5).toNonIndexed();
  trunk.translate(0, 1.2, 0);
  const canopy = new THREE.IcosahedronGeometry(1.6, 0);
  canopy.translate(0, 3.2, 0);
  const paint = (geo, hex) => {
    const col = new THREE.Color(hex);
    const n = geo.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i*3] = col.r; arr[i*3+1] = col.g; arr[i*3+2] = col.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geo;
  };
  paint(trunk, 0x6b4a2f);      // brown trunk
  paint(canopy, 0x3e6b35);     // dusty green canopy
  const treeTemplate = mergeGeometries([trunk, canopy], false);

  // Over-sample: the old city is dense, so the collision check rejects a
  // large share of roadside spots. Starting from ~1200 candidates lands
  // roughly 300–400 actual trees per full 3×3 ring of tiles.
  const TARGET = 1200;
  const total = segments.length;
  if (!total) return 0;
  const chance = Math.min(1, TARGET / total);

  const parts = [];
  const _probe = new THREE.Vector3();
  for (let i = 0; i < total && parts.length < TARGET + 100; i++) {
    if (hashId(i * 131 + 17) > chance) continue;   // deterministic thinning
    const seg = segments[i];
    const dx = seg[2] - seg[0], dz = seg[3] - seg[1];
    const len = Math.hypot(dx, dz);
    if (len < 12) continue;                        // skip tiny segments
    // Random point along the segment, offset to one side of the road.
    const t = hashId(i * 29 + 3);
    const side = hashId(i * 53 + 11) < 0.5 ? -1 : 1;
    const px = (-dz / len) * side * 3.2;           // perpendicular, ~3 m off-centre
    const pz = ( dx / len) * side * 3.2;
    const x = seg[0] + dx * t + px;
    const z = seg[1] + dz * t + pz;
    // Reject spots inside/near buildings (reuse the player collision test).
    _probe.set(x, 0, z);
    if (resolveCollision(_probe)) continue;

    const g = treeTemplate.clone();
    const s = 0.8 + hashId(i * 7 + 1) * 0.6;       // 0.8–1.4 size jitter
    g.scale(s, s * (0.9 + hashId(i * 3 + 5) * 0.4), s);
    g.translate(x, 0, z);
    parts.push(g);
  }

  if (!parts.length) return 0;
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.9, metalness: 0,
  }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return parts.length;
}

// -----------------------------------------------------------------------------
// 5. Collision (against real building footprints)
// -----------------------------------------------------------------------------
//
// Movement resolution is AXIS-SEPARATED: we try the X move and the Z move
// independently so a wall on one axis doesn't kill all movement (lets you
// slide along buildings) — the same trick most retro FPS games used.
//
// For each candidate position:
//   - broad phase: skip buildings whose expanded AABB the player isn't in,
//   - narrow phase: collide if inside the real footprint OR within
//     PLAYER_RADIUS of any wall edge.

// Classic ray-casting point-in-polygon test. Fast and good enough for building
// footprints (which are simple polygons without holes here).
function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1];
    const xj = poly[j][0], zj = poly[j][1];
    if (((zi > z) !== (zj > z)) &&
        (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// Distance from point (x,z) to the nearest edge of a polygon. Used to give the
// player a radius of clearance from walls — without this you'd clip right up
// against building faces.
function distToPolyEdge(x, z, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const ax = poly[i][0], az = poly[i][1];
    const bx = poly[(i + 1) % poly.length][0], bz = poly[(i + 1) % poly.length][1];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    const px = ax + t * dx, pz = az + t * dz;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) best = d;
  }
  return best;
}

function resolveCollision(nextPos) {
  // Broad phase: skip the polygon math for buildings whose expanded AABB the
  // player isn't even touching. In a dense city this still scans every
  // collider, but the AABB test is ~4 comparisons and branch-predicts well.
  for (const c of colliders) {
    if (nextPos.x <= c.minX || nextPos.x >= c.maxX ||
        nextPos.z <= c.minZ || nextPos.z >= c.maxZ) continue;
    // Narrow phase: the player is near this building's AABB. Collide if they
    // are inside the real footprint OR within PLAYER_RADIUS of any wall.
    if (pointInPoly(nextPos.x, nextPos.z, c.poly)) return true;
    if (distToPolyEdge(nextPos.x, nextPos.z, c.poly) < PLAYER_RADIUS) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// 6. Minimap (top-down map)
// -----------------------------------------------------------------------------
//
// A small canvas in the corner showing the city from above so the player can
// see where they are and which way they're facing — the first-person view
// alone gives no sense of overall position or heading.
//
// Design:
//   - The STATIC map (buildings + roads for the whole loaded area) is rendered
//     ONCE to an offscreen canvas when the city finishes loading. Redrawing
//     8,900 building polygons every frame would waste CPU; rendering once and
//     blitting is far cheaper.
//   - Each FRAME, we draw the offscreen map onto the visible canvas, translated
//     so the player stays centered, then draw the player marker (a triangle
//     pointing where they look) on top.
//   - "North up": the minimap's +Z (north) points up, +X (east) points right —
//     matching the scene axes. The simplest mental model.
//   - Zoom: the minimap shows a ~160 m window around the player (see
//     MINIMAP_VIEW_METERS). The full 3 km city in 200 px would be ~15 m/px,
//     too coarse to read locally.

const MINIMAP = {
  el: null,          // visible <canvas>
  ctx: null,         // its 2D context
  base: null,        // offscreen canvas with the static city map
  baseCtx: null,
  transform: null,   // { minX, maxZ, PX_PER_M } — FIXED world→pixel mapping
};

function initMinimap() {
  MINIMAP.el = dom.minimap;
  MINIMAP.ctx = MINIMAP.el.getContext('2d');
  // FIXED-extent offscreen base: ±MINIMAP_EXTENT_M around the origin at
  // 1 px/m (8000 px — at the browser canvas cap). With streaming tiles the
  // world has no known total bounds up front, so the transform is fixed and
  // each tile paints itself into this canvas as it loads (paintMinimapRegion).
  const size = MINIMAP_EXTENT_M * 2;
  MINIMAP.base = document.createElement('canvas');
  MINIMAP.base.width = MINIMAP.base.height = Math.min(8000, size);
  MINIMAP.baseCtx = MINIMAP.base.getContext('2d');
  const PX_PER_M = MINIMAP.base.width / size;
  MINIMAP.transform = { minX: -MINIMAP_EXTENT_M, maxZ: MINIMAP_EXTENT_M, PX_PER_M };
  // Ground fill (matches the 3D ground color) — unpainted regions read as
  // "not loaded yet" rather than void.
  MINIMAP.baseCtx.fillStyle = '#c9b08a';
  MINIMAP.baseCtx.fillRect(0, 0, MINIMAP.base.width, MINIMAP.base.height);
}

// Paint ONE TILE's worth of colliders/road-segments/named-segments onto the
// fixed base canvas. Called by the streaming manager as tiles arrive; the
// per-frame blit picks everything up automatically. (Replaces the old
// whole-world renderMinimapBase, which needed all data up front.)
function paintMinimapRegion(cols, segs, namedSegs) {
  if (!MINIMAP.transform) return;
  const { minX, maxZ, PX_PER_M } = MINIMAP.transform;
  const bctx = MINIMAP.baseCtx;
  // World (x,z) → offscreen pixel. z flips so north (+z) is UP.
  const wx = x => (x - minX) * PX_PER_M;
  const wz = z => (maxZ - z) * PX_PER_M;

  // Roads (under buildings).
  bctx.strokeStyle = '#5a5147';
  bctx.lineWidth = Math.max(1, PX_PER_M * 1.2);
  bctx.beginPath();
  for (const seg of segs) {
    bctx.moveTo(wx(seg[0]), wz(seg[1]));
    bctx.lineTo(wx(seg[2]), wz(seg[3]));
  }
  bctx.stroke();

  // Buildings.
  bctx.fillStyle = '#2b4a7a';
  for (const c of cols) {
    const poly = c.poly;
    if (!poly || poly.length < 3) continue;
    bctx.beginPath();
    bctx.moveTo(wx(poly[0][0]), wz(poly[0][1]));
    for (let i = 1; i < poly.length; i++) bctx.lineTo(wx(poly[i][0]), wz(poly[i][1]));
    bctx.closePath();
    bctx.fill();
  }

  // Named-road labels along their direction — only long-enough segments.
  for (const s of namedSegs) {
    const px1 = wx(s.x1), pz1 = wz(s.z1), px2 = wx(s.x2), pz2 = wz(s.z2);
    if (Math.hypot(px2 - px1, pz2 - pz1) < 60) continue;
    const mx = (px1 + px2) / 2, my = (pz1 + pz2) / 2;
    let ang = Math.atan2(pz2 - pz1, px2 - px1);
    if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;  // readable
    bctx.save();
    bctx.translate(mx, my);
    bctx.rotate(ang);
    bctx.font = 'italic 11px system-ui, sans-serif';
    bctx.textAlign = 'center';
    bctx.lineWidth = 3;
    bctx.strokeStyle = 'rgba(0,0,0,.6)';
    bctx.strokeText(s.name, 0, -3);
    bctx.fillStyle = 'rgba(255,255,255,.9)';
    bctx.fillText(s.name, 0, -3);
    bctx.restore();
  }
}


// Per-frame minimap draw: blit the static map centred on the player, then draw
// the player marker. `heading` is the player yaw in radians, where 0 = facing
// -Z (north). See the player-yaw derivation in section 12's frame loop.
function drawMinimap(playerX, playerZ, heading) {
  const { minX, maxZ, PX_PER_M } = MINIMAP.transform;
  const playerPX = (playerX - minX) * PX_PER_M;
  const playerPY = (maxZ - playerZ) * PX_PER_M;

  // Source rectangle in the offscreen image: a window around the player, sized
  // so that MINIMAP_VIEW_METERS of world spans the visible canvas.
  const halfWorld = MINIMAP_VIEW_METERS / 2;
  const halfSrcPx = halfWorld * PX_PER_M;
  let sx = playerPX - halfSrcPx;
  let sy = playerPY - halfSrcPx;
  let sw = halfSrcPx * 2;
  let sh = halfSrcPx * 2;
  // Clamp the source rect into the offscreen bounds; if the player is near the
  // edge of the data we don't want to read outside the image.
  const bw = MINIMAP.base.width, bh = MINIMAP.base.height;
  if (sx < 0) sx = 0;
  if (sy < 0) sy = 0;
  if (sx + sw > bw) sw = bw - sx;
  if (sy + sh > bh) sh = bh - sy;

  // Visible canvas: clear, then draw the source window scaled to fill it.
  const ctx = MINIMAP.ctx;
  const S = MINIMAP_SIZE_PX;
  ctx.fillStyle = '#c9b08a';
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(MINIMAP.base, sx, sy, sw, sh, 0, 0, S, S);

  // Player marker: a triangle pointing in the facing direction.
  // World forward (X,Z) for yaw y = (sin y, -cos y). On the minimap image,
  // +X is right and north (+Z... i.e. looking -Z means image-up) — the image
  // forward vector works out to (sin y, cos y).
  const cx = S / 2, cy = S / 2;
  const fx = Math.sin(heading);
  const fy = Math.cos(heading);
  // Perpendicular for the triangle base.
  const px2 = -fy, py2 = fx;
  const R = 8;       // marker size
  ctx.fillStyle = '#ff3b30';
  ctx.beginPath();
  ctx.moveTo(cx + fx * R, cy + fy * R);                  // tip (forward)
  ctx.lineTo(cx - px2 * R * 0.6, cy + py2 * R * 0.6);    // base left
  ctx.lineTo(cx + px2 * R * 0.6, cy - py2 * R * 0.6);    // base right
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// -----------------------------------------------------------------------------
// 7. Character avatar (third-person, Vice-City style)
// -----------------------------------------------------------------------------
//
// A small procedural humanoid built entirely from THREE primitives — no
// external model files, no textures, no network dependency. Built lazily on
// the first switch to third-person (section 8) so first-person play pays
// nothing until the user opts in. The figure has pivotable limbs so we can
// run a simple walk cycle.
//
// Why procedural blocks: it matches the demo's "no build step, no assets"
// philosophy and can never 404. The geometry is intentionally chunky/low-poly,
// which reads fine at the small size the avatar occupies on screen.

let avatar = null;           // the THREE.Group humanoid (null until built)

// Build the humanoid. Origin is at the avatar's FEET (y=0). We return a Group
// plus stash limb references on it (.userData) so the walk cycle can swing
// them. Limbs are children of small "pivot" groups positioned at the shoulder
// / hip joint, so rotating the pivot about X swings the limb naturally.
function buildAvatar() {
  const g = new THREE.Group();

  const skin    = new THREE.MeshStandardMaterial({ color: 0xc68642, roughness: 0.8 });
  const shirt   = new THREE.MeshStandardMaterial({ color: 0xe0651f, roughness: 0.8 }); // orange "Hawaiian" vibe
  const pants   = new THREE.MeshStandardMaterial({ color: 0x2b3a55, roughness: 0.85 });
  const hair    = new THREE.MeshStandardMaterial({ color: 0x2b1a0e, roughness: 0.9 });

  const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);

  // Torso (centered ~1.05 m up). Width 0.5, height 0.6, depth 0.3.
  const torso = box(0.5, 0.6, 0.3, shirt);
  torso.position.y = 1.05;
  torso.castShadow = true;
  g.add(torso);

  // Hips/pelvis block under the torso.
  const hips = box(0.46, 0.18, 0.28, pants);
  hips.position.y = 0.78;
  hips.castShadow = true;
  g.add(hips);

  // Head (skin) + hair cap. Centered ~1.55 m up.
  const head = box(0.26, 0.28, 0.26, skin);
  head.position.y = 1.55;
  head.castShadow = true;
  g.add(head);
  const hairCap = box(0.28, 0.1, 0.28, hair);
  hairCap.position.y = 1.66;
  g.add(hairCap);

  // Helper to build a limb as a pivot group at (x,y,z) with a box hanging
  // below it. Rotating the pivot about X swings the limb forward/back.
  const makeLimb = (x, y, len, w, mat) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const mesh = box(w, len, w, mat);
    mesh.position.y = -len / 2;     // hang below the pivot
    mesh.castShadow = true;
    pivot.add(mesh);
    g.add(pivot);
    return pivot;
  };

  // Arms: pivots at shoulder height (~1.30 m), length 0.55, just outside torso.
  const leftArm  = makeLimb(-0.33, 1.30, 0.55, 0.14, skin);
  const rightArm = makeLimb( 0.33, 1.30, 0.55, 0.14, skin);
  // Legs: pivots at hip height (~0.78 m), length 0.75, at the pelvis edges.
  const leftLeg  = makeLimb(-0.13, 0.78, 0.75, 0.17, pants);
  const rightLeg = makeLimb( 0.13, 0.78, 0.75, 0.17, pants);

  g.userData = { leftArm, rightArm, leftLeg, rightLeg };
  g.castShadow = true;
  return g;
}

// Walk cycle: swing the four limbs with a sine while moving, ease to neutral
// when idle. Phase advances faster at higher speed so running looks quicker.
// `moving` is whether the player is currently applying movement input; `speed`
// is the current WALK/RUN speed; `dt` is the frame delta.
let avatarPhase = 0;
function animateAvatar(dt, moving, speed) {
  if (!avatar) return;
  const ud = avatar.userData;
  // Swing amplitude in radians (~28° arms, ~30° legs). Frequency scales with
  // speed: walking ~2 Hz-ish, running noticeably faster.
  if (moving) {
    avatarPhase += dt * (2.0 + speed * 0.8);
    const armSwing = Math.sin(avatarPhase) * 0.5;
    const legSwing = Math.sin(avatarPhase) * 0.55;
    // Opposite arms/legs: left arm forward when right leg forward.
    ud.leftArm.rotation.x  =  armSwing;
    ud.rightArm.rotation.x = -armSwing;
    ud.leftLeg.rotation.x  = -legSwing;
    ud.rightLeg.rotation.x =  legSwing;
  } else {
    // Ease limbs back to neutral (exponential approach, time constant ~10/s).
    const k = Math.min(1, dt * 10);
    ud.leftArm.rotation.x  *= (1 - k);
    ud.rightArm.rotation.x *= (1 - k);
    ud.leftLeg.rotation.x  *= (1 - k);
    ud.rightLeg.rotation.x *= (1 - k);
    avatarPhase = 0;
  }
}

// -----------------------------------------------------------------------------
// 8. Player & view (position, facing, teleport, view toggle)
// -----------------------------------------------------------------------------
//
// The canonical player state. The frame loop (section 12) moves `playerPos`
// (with collision), then positions the CAMERA relative to it based on view
// mode: first-person sits at playerPos + eye height; third-person sits
// behind/above with the avatar mesh at playerPos. This decoupling is what
// lets both view modes share one movement system.

// The player's position at feet level (y=0 in third-person, eye height in
// first-person). Spawn: a verified point on the "Layakam Mohalla" lane — the
// naive origin (0,0) lands inside a building footprint in dense central
// Jodhpur and traps the player. This spot has ~2 m of clearance.
const playerPos = new THREE.Vector3(1, 0, -24);

// `viewMode` selects the camera mode: 'first' | 'third' | 'top' (the V key
// cycles them). `active` (section 9) gates all input.
let viewMode = 'first';

// Head-bob phase for first-person walking (see updateCamera, section 12).
let bobPhase = 0;

// Sync the camera to the spawn point once at startup; every frame after this
// the frame loop owns camera placement.
camera.position.set(playerPos.x, EYE_HEIGHT, playerPos.z);

// Manual yaw/pitch used by the no-lock fallback look (section 9). In
// pointer-lock mode PointerLockControls writes the camera quaternion directly
// and these go stale — which is why the frame loop derives the player's yaw
// from the camera's world direction instead of reading `yaw`. EXCEPTION: in
// top-down mode the camera looks straight down, so its world direction says
// nothing about heading — there the `yaw` variable IS the authority (the
// camera is rotated to match it every frame).
let yaw = 0;
let pitch = 0;
const PITCH_LIMIT = Math.PI / 2 - 0.05;

// Build the camera orientation from our own yaw/pitch. Order matters: in
// three.js, Euler 'YXZ' applies yaw (Y) then pitch (X), which is exactly the
// FPS camera convention (look around horizontally, then up/down).
function applyFallbackLook() {
  camera.rotation.order = 'YXZ';
  camera.rotation.set(pitch, yaw, 0);
}

// Cycle first-person → third-person → top-down (Road-Fighter-style) → back.
// Called by the V key (section 9) and the on-screen #viewToggle button
// (essential on touch devices and in webviews that swallow synthetic key
// events). Builds the avatar lazily on first use so first-person play pays
// nothing until the user opts in.
const VIEW_LABELS = {
  first: 'First-person — V: third-person',
  third: 'Third-person — V: top-down',
  top:   'Top-down (Road-Fighter style) — V: first-person',
};
const VIEW_BUTTONS = {
  first: '👁 First person (V)',
  third: '🚶 Third person (V)',
  top:   '🚗 Top-down (V)',
};
function toggleView() {
  if (!active) return;
  if (!avatar) {
    avatar = buildAvatar();
    scene.add(avatar);
  }
  viewMode = viewMode === 'first' ? 'third' : viewMode === 'third' ? 'top' : 'first';
  // The avatar is visible in third-person AND top-down (you see yourself
  // from above); only first-person hides it.
  avatar.visible = (viewMode !== 'first');
  dom.status.textContent = VIEW_LABELS[viewMode];
  if (dom.viewToggle) {
    dom.viewToggle.textContent = VIEW_BUTTONS[viewMode];
  }
}

// Teleport the player to scene (x, z). We try a few nearby offsets if the exact
// point is inside a building (landmarks often sit on/near footprints), so you
// don't get stuck in a wall on arrival. Keeps the current facing direction.
function teleportTo(x, z) {
  // Candidate offsets in increasing radius. Try the exact point first, then a
  // small spiral of nearby spots until one isn't blocked by collision.
  const candidates = [
    [0, 0], [2, 0], [-2, 0], [0, 2], [0, -2],
    [3, 3], [-3, 3], [3, -3], [-3, -3],
    [5, 0], [-5, 0], [0, 5], [0, -5],
  ];
  for (const [ox, oz] of candidates) {
    const test = new THREE.Vector3(x + ox, 0, z + oz);
    if (!resolveCollision(test)) {
      playerPos.set(test.x, EYE_HEIGHT, test.z);
      // Drop any in-flight movement so we don't smear the teleport.
      bobPhase = 0;
      _vel.set(0, 0, 0);   // momentum too — arrive standing, not skidding
      // The destination may be outside loaded tiles — stream them now.
      ensureTilesAround(Math.round(x / TILE_SIZE_M), Math.round(z / TILE_SIZE_M));
      // Refresh the place-name lookup immediately for the new location.
      const ll = scenePosToLatLon(playerPos);
      lastPlacePos = { x: playerPos.x, z: playerPos.z };
      refreshPlace(ll.lat, ll.lon);
      return true;
    }
  }
  return false;   // every candidate blocked; give up silently
}

// -----------------------------------------------------------------------------
// 9. Controls & input
// -----------------------------------------------------------------------------
//
// PointerLockControls hides the cursor and reads raw mouse movement to rotate
// the camera — exactly the way FPS games do "mouse look". The browser only
// allows pointer lock after a user gesture (a click).
//
// IMPORTANT — why we don't depend on pointer lock:
// Many embedded webviews (including ZCode's in-app browser, Electron apps,
// some mobile browsers, and any iframe without allow="pointer-lock") do NOT
// support the Pointer Lock API. If we gated movement on `controls.isLocked`
// the demo would silently do nothing on those platforms. So pointer lock is
// treated as an *enhancement*: when it works we use it for FPS-style
// mouse-look; when it doesn't, we fall back to drag-to-look + arrow/Q-E
// turning, and WASD always works.
const controls = new PointerLockControls(camera, document.body);

// Keyboard state. We track pressed keys ourselves so we can mix in run,
// collision, and the view toggle. ONE keydown dispatcher handles everything:
// raw key tracking, the V toggle, and resume-from-pause.
const keys = Object.create(null);

// Live drag-look state, shared with the frame loop for EDGE-CONTINUE
// rotation (see updateDragEdgeRotation): without pointer lock, a drag only
// rotates while the cursor moves — so turning more than ~90° ran out of
// screen and stopped. Holding the drag near a viewport edge now keeps
// rotating in that direction.
const dragState = { dragging: false, x: 0, y: 0 };

// `active` means "the demo is in interactive mode" — distinct from pointer
// lock. WASD movement and turning are enabled whenever active is true, even
// if pointer lock is unavailable. `worldReady` gates resume-from-pause so
// pressing keys DURING the initial load can't start the game early.
let active = false;
let worldReady = false;

addEventListener('keydown', e => {
  keys[e.code] = true;
  // V cycles first/third/top-down view.
  if (e.code === 'KeyV') toggleView();
  // P visits the real-place panorama when near a landmark that has footage
  // (or returns to the 3D city if already visiting).
  if (e.code === 'KeyP') togglePanorama();
  // If paused (Esc), any movement/look key resumes — but only once the world
  // has finished loading.
  if (!active && worldReady && RESUME_KEYS.includes(e.code)) resumeGame();
});
addEventListener('keyup', e => { keys[e.code] = false; });

// --- Pointer-lock path (the upgrade, when the browser supports it) ------------

controls.addEventListener('lock', () => {
  active = true;
  showInteractiveUI();
  // Guard: on desktop this can fire on every re-lock after an Esc pause —
  // only note the upgrade once.
  if (!dom.status.textContent.includes('mouse-look')) {
    dom.status.textContent += '  •  mouse-look (pointer lock)';
  }
});
controls.addEventListener('unlock', () => {
  // Esc / losing pointer lock PAUSES the game instead of stranding the user.
  // We show the overlay as a "paused — click to resume" screen and flip
  // `active` off so movement/HUD freeze. Clicking the overlay (or pressing any
  // movement key) resumes via resumeGame() so there's always a way back.
  if (active) {
    // Sync the fallback yaw/pitch from the camera's CURRENT orientation.
    // Under pointer lock the mouse wrote the camera quaternion directly while
    // the `yaw`/`pitch` variables went stale — without this sync, the first
    // arrow-key turn or drag after resuming would snap the camera back to a
    // pre-lock heading. reorder() re-expresses the same orientation in the
    // YXZ convention applyFallbackLook() uses.
    camera.rotation.reorder('YXZ');
    yaw = camera.rotation.y;
    pitch = camera.rotation.x;

    active = false;
    dom.overlay.hidden = false;
    dom.status.textContent = 'Paused — click a landmark to jump there, or click the card / press a key to resume';
  }
});

// Resume from the paused state shown on Esc. Re-enables the game and re-hides
// the overlay. Safe to call repeatedly (no-op if already active).
function resumeGame() {
  if (active) return;
  active = true;
  dom.overlay.hidden = true;
  dom.hud.hidden = false;
  dom.status.textContent = viewMode === 'first'
    ? 'Resumed — drag to look, arrows to turn'
    : `Resumed — ${VIEW_LABELS[viewMode]}`;
}

// Reveal the interactive-mode UI pieces (shared by the pointer-lock and
// fallback engagement paths so neither duplicates the wiring). Idempotent:
// safe to call again when pointer lock upgrades on desktop AFTER fallback
// already started — which previously double-bound the view-toggle click and
// made every toggle fire twice (net no-op).
function showInteractiveUI() {
  dom.overlay.hidden = true;
  dom.hud.hidden = false;
  if (dom.viewToggle) dom.viewToggle.hidden = false;
  setupInputDebug();
}

// Bind the view-toggle click ONCE (not inside showInteractiveUI, which can run
// twice on desktop). blur() after the click so a focused button can't be
// re-triggered by Space/Enter during normal walking.
if (dom.viewToggle) {
  dom.viewToggle.addEventListener('click', () => {
    toggleView();
    dom.viewToggle.blur();
  });
}

// --- Fallback path (drag-to-look + arrow keys), used when no pointer lock ------

function startFallback() {
  if (active) return;
  active = true;
  showInteractiveUI();
  dom.status.textContent += '  •  drag to look, arrows to turn (pointer lock unavailable in this browser)';

  // Drag-to-look via the POINTER EVENTS API with pointer capture — the
  // definitive fix for drags dying mid-gesture ("maneuver sticks after a
  // certain point"). Earlier mouse-event versions failed in embedded webviews
  // because the webview intercepts long drags for native gestures and simply
  // STOPS delivering mousemove. setPointerCapture() re-targets all subsequent
  // pointermove/pointerup events to this element for the life of the drag —
  // the stream can't be interrupted — and pointer events unify mouse + touch,
  // so the separate touch handlers are gone too.
  let lastX = 0, lastY = 0;
  const canvas = renderer.domElement;

  canvas.addEventListener('pointerdown', e => {
    if (!active || controls.isLocked) return;
    e.preventDefault();                     // no native selection/scroll drags
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* non-fatal */ }
    dragState.dragging = true;
    dragState.x = e.clientX; dragState.y = e.clientY;
    lastX = e.clientX; lastY = e.clientY;
  });
  canvas.addEventListener('pointermove', e => {
    dragState.x = e.clientX; dragState.y = e.clientY;   // for edge-continue
    if (!dragState.dragging || controls.isLocked) return;
    // Buttons no longer held → drag is over (covers release outside the view).
    if (e.pointerType === 'mouse' && (e.buttons & 1) === 0) {
      dragState.dragging = false;
      return;
    }
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    yaw   -= dx * 0.005;            // mouse right → look right (yaw decreases)
    pitch -= dy * 0.005;
    pitch  = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
    applyFallbackLook();
  });
  const endDrag = () => { dragState.dragging = false; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  // Belt-and-braces: never let the webview start a native drag of the canvas.
  canvas.addEventListener('dragstart', e => e.preventDefault());
}

// --- Live WASD input indicator (#inputDebug) -----------------------------------
//
// Reflects the `keys` state each frame so you can see whether key events are
// reaching the page. If a key never lights up while you press it, that key
// isn't being delivered (focus issue, webview input blocking, or stale cached
// code).

const inputSpans = {};
function setupInputDebug() {
  if (!dom.inputDebug) return;
  for (const el of dom.inputDebug.querySelectorAll('span[data-k]')) {
    inputSpans[el.getAttribute('data-k')] = el;
  }
  dom.inputDebug.hidden = false;
}
function updateInputDebug() {
  for (const code in inputSpans) {
    const el = inputSpans[code];
    if (keys[code]) el.classList.add('on');
    else el.classList.remove('on');
  }
}

// -----------------------------------------------------------------------------
// 10. Destinations & orientation (teleport, nearest places, landmark beacons)
// -----------------------------------------------------------------------------
//
// A collapsible list of Jodhpur's historic gates and major landmarks, fetched
// from OpenStreetMap (section 2's fetchLandmarks). Click a name and the player
// teleports there instantly.
//
// The same landmark data drives ORIENTATION — answering "where am I?" three
// ways, because that's hard in a city where only ~3% of roads are named:
//   - the HUD shows the NEAREST NAMED ROAD + NEAREST LANDMARK with distances
//     (how people actually describe location: "near Sardar Market"),
//   - every landmark gets a tall beacon + floating name label in the 3D world
//     so you can see and walk toward known places,
//   - the minimap labels named roads and marks landmark positions.

let landmarks = [];   // { name, kind, x, z, lat, lon } — set once fetched

// Distance from point (px,pz) to segment (x1,z1)-(x2,z2), for nearest-road.
function distPointToSegment(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  const L2 = dx * dx + dz * dz;
  if (L2 === 0) return Math.hypot(px - x1, pz - z1);
  let t = ((px - x1) * dx + (pz - z1) * dz) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), pz - (z1 + t * dz));
}

// Nearest-places state, recomputed at most once per second (a few hundred
// segment distance tests — trivial, but no reason to do them 60×/s).
let _nearestRoadTxt = '';
let _nearestLmTxt = '';
let _panoHintTxt = '';
let _lastNearestTime = 0;
function updateNearest() {
  const now = performance.now();
  if (now - _lastNearestTime < 1000) return;
  _lastNearestTime = now;

  let bestRoad = null, bestRoadD = Infinity;
  for (const s of namedRoadSegments) {
    const d = distPointToSegment(playerPos.x, playerPos.z, s.x1, s.z1, s.x2, s.z2);
    if (d < bestRoadD) { bestRoadD = d; bestRoad = s; }
  }
  _nearestRoadTxt = bestRoad
    ? `🛣 ${bestRoad.name} · ${bestRoadD < 8 ? 'on it' : Math.round(bestRoadD) + ' m'}`
    : '';

  let bestLm = null, bestLmD = Infinity;
  for (const l of landmarks) {
    const d = Math.hypot(l.x - playerPos.x, l.z - playerPos.z);
    if (d < bestLmD) { bestLmD = d; bestLm = l; }
  }
  _nearestLmTxt = bestLm ? `📍 ${bestLm.name} · ${Math.round(bestLmD)} m` : '';
  // Real-place visit available? (panorama spot near the player)
  _panoHintTxt = (worldReady && !panoramaMode && nearbyPanoramaSpot())
    ? '🎬 P — real 360° view'
    : '';
}

// A canvas-texture sprite with the given text — used for floating landmark
// name labels. Cheap, crisp at distance, and fades with fog like the world.
function makeLabelSprite(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 30px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,.8)';
  g.strokeText(text, 128, 32);
  g.fillStyle = '#fff';
  g.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sprite.scale.set(24, 6, 1);   // world meters — readable from a distance
  return sprite;
}

// Tall semi-transparent beacon + name label over each landmark, so known
// places are visible from anywhere in the city and you can orient by them.
function buildLandmarkBeacons() {
  const gateColor = 0xffd54a;      // gold for gates
  const placeColor = 0xff8a65;     // coral for forts/attractions/memorials
  for (const lm of landmarks) {
    const color = /^(gate|city_gate)$/i.test(lm.kind) ? gateColor : placeColor;
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.6, 0.6, 40, 8, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false }),
    );
    beacon.position.set(lm.x, 20, lm.z);
    scene.add(beacon);

    const label = makeLabelSprite(lm.name);
    label.position.set(lm.x, 44, lm.z);
    scene.add(label);
  }
}

// Draw landmark dots + names directly onto the minimap's offscreen BASE
// canvas (persistent — the per-frame blit picks them up automatically).
// Called once, after the landmarks arrive.
function drawLandmarksOnMinimap() {
  if (!MINIMAP.transform) return;
  const { minX, maxZ, PX_PER_M } = MINIMAP.transform;
  const bctx = MINIMAP.baseCtx;
  const wx = x => (x - minX) * PX_PER_M;
  const wz = z => (maxZ - z) * PX_PER_M;
  for (const lm of landmarks) {
    const px = wx(lm.x), pz = wz(lm.z);
    const isGate = /^(gate|city_gate)$/i.test(lm.kind);
    bctx.fillStyle = isGate ? '#ffd54a' : '#ff8a65';
    bctx.beginPath();
    bctx.arc(px, pz, 5, 0, Math.PI * 2);
    bctx.fill();
    bctx.strokeStyle = 'rgba(0,0,0,.6)';
    bctx.lineWidth = 1.5;
    bctx.stroke();
    bctx.font = 'bold 11px system-ui, sans-serif';
    bctx.textAlign = 'center';
    bctx.lineWidth = 3;
    bctx.strokeStyle = 'rgba(0,0,0,.7)';
    bctx.strokeText(lm.name, px, pz - 9);
    bctx.fillStyle = isGate ? '#ffe9a8' : '#ffd9cc';
    bctx.fillText(lm.name, px, pz - 9);
  }
}

function populateDestinations(list) {
  if (!dom.destinations || !dom.destList) return;
  // Store for nearest-landmark orientation + beacons/minimap markers.
  landmarks = list;
  if (!landmarks.length) { dom.destinations.hidden = true; return; }

  dom.destList.innerHTML = '';
  for (const lm of landmarks) {
    const btn = document.createElement('button');
    btn.className = 'dest-item';
    btn.type = 'button';
    // Friendly kind label.
    const kindLabel = {
      city_gate: 'Gate', gate: 'Gate', castle: 'Fort / Palace',
      attraction: 'Attraction', memorial: 'Memorial',
    }[lm.kind] || 'Landmark';
    btn.innerHTML = `${lm.name}<span class="kind">${kindLabel}</span>`;
    btn.addEventListener('click', () => {
      // blur so Space/Enter while walking can't re-trigger the focused button.
      btn.blur();
      // Clicking a landmark while paused (Esc) also resumes the game, so the
      // teleport takes effect — the frame loop drives camera/HUD/minimap and
      // only runs when active.
      if (!active) resumeGame();
      const ok = teleportTo(lm.x, lm.z);
      dom.status.textContent = ok
        ? `Teleported to ${lm.name}`
        : `Couldn't land at ${lm.name} (blocked) — try another spot`;
      // Keep the place-name cache fresh.
      currentPlace = lm.name;
    });
    dom.destList.appendChild(btn);
  }
  dom.destCount.textContent = `(${landmarks.length})`;
  dom.destinations.hidden = false;

  // Collapsible header.
  dom.destHeader.addEventListener('click', () => dom.destinations.classList.toggle('collapsed'));
}

// --- Panorama visits: isolated real places ---------------------------------------
//
// Where we have real 360° footage of a landmark (extracted from user-provided
// video into photos/panoramas/), standing near that landmark and pressing P
// swaps the 3D city for the REAL place: the panorama becomes the environment,
// the world is hidden, and the normal drag/arrow look controls turn you
// inside the photo. P returns to the city. Multiple views per landmark cycle
// on each visit.
//
// The frames come from the tools/extract-panoramas.sh pipeline (yt-dlp +
// ffmpeg scene-detection). They are kept OUT of git (copyrighted source
// footage) — photos/ is gitignored.
const PANORAMA_SPOTS = [
  {
    label: 'Jaswant Thada (real 360° footage)',
    // Own coordinates (OSM position of the memorial) so visits work even if
    // the async landmarks fetch is slow or fails — the feature must not
    // depend on a flaky API to be reachable.
    lat: 26.30435, lon: 73.02531,
    files: [
      'photos/panoramas/jaswant-thada-1.jpg',
      'photos/panoramas/jaswant-thada-2.jpg',
      'photos/panoramas/jaswant-thada-3.jpg',
    ],
    mode: 'equirect',                             // or 'flat' if a source isn't equirect
    _next: 0,
  },
];
const PANO_TRIGGER_M = 25;     // proximity to the spot to offer the visit

let panoramaMode = false;
const _panoTexCache = new Map();
let _hiddenForPano = [];
let _savedSky = null, _savedFog = null;

// Lazily convert each spot's lat/lon to scene coords (projection is defined
// before this section, but computing on first use keeps the registry literal).
function spotPos(spot) {
  if (spot.x === undefined) {
    const [x, z] = lonLatToXY(spot.lon, spot.lat);
    spot.x = x; spot.z = z;
  }
  return spot;
}

function nearbyPanoramaSpot() {
  for (const s of PANORAMA_SPOTS) {
    spotPos(s);
    if (Math.hypot(s.x - playerPos.x, s.z - playerPos.z) < PANO_TRIGGER_M) return s;
  }
  return null;
}

function togglePanorama() {
  if (!worldReady) return;
  if (panoramaMode) { exitPanorama(); return; }
  const spot = nearbyPanoramaSpot();
  if (!spot) {
    // Guide the player to the nearest real place instead of a dead end —
    // this also keeps the feature usable when the destinations panel hasn't
    // loaded (landmarks fetch is async and can fail on a busy Overpass day).
    let best = null, bestD = Infinity;
    for (const s of PANORAMA_SPOTS) {
      spotPos(s);
      const d = Math.hypot(s.x - playerPos.x, s.z - playerPos.z);
      if (d < bestD) { bestD = d; best = s; }
    }
    dom.status.textContent = best
      ? `Nearest real place: ${best.label} · ${Math.round(bestD)} m ${arrowTo(best.x, best.z, yaw)} — walk there and press P`
      : 'No real-place views available';
    return;
  }
  const file = spot.files[spot._next++ % spot.files.length];   // cycle views
  dom.status.textContent = `Loading ${spot.label}…`;
  const show = tex => applyPanorama(spot, tex);
  let tex = _panoTexCache.get(file);
  if (tex) { show(tex); return; }
  new THREE.TextureLoader().load(
    file,
    t => {
      if (spot.mode !== 'flat') {
        t.mapping = THREE.EquirectangularReflectionMapping;
        t.colorSpace = THREE.SRGBColorSpace;
      }
      _panoTexCache.set(file, t);
      show(t);
    },
    undefined,
    () => { dom.status.textContent = `Could not load ${file}`; },
  );
}

function applyPanorama(spot, tex) {
  panoramaMode = true;
  _savedSky = scene.background;
  _savedFog = scene.fog;
  if (spot.mode !== 'flat') {
    scene.background = tex;             // full-sphere environment
  } else {
    // Fallback mode for non-equirect sources: giant backdrop plane ahead.
    // (Not currently used; kept so a source can flip modes with one string.)
    scene.background = _savedSky;
  }
  scene.fog = null;
  // Hide the whole 3D world — this is an ISOLATED visit to the real place.
  _hiddenForPano = [];
  for (const child of scene.children) {
    if (child.visible) { _hiddenForPano.push(child); child.visible = false; }
  }
  camera.position.set(playerPos.x, EYE_HEIGHT, playerPos.z);
  _vel.set(0, 0, 0);
  dom.status.textContent = `🎬 ${spot.label} — drag or ←→ to look around · P to return`;
}

function exitPanorama() {
  panoramaMode = false;
  scene.background = _savedSky;
  scene.fog = _savedFog;
  for (const c of _hiddenForPano) c.visible = true;
  _hiddenForPano = [];
  dom.status.textContent = 'Back in the 3D city';
}

// --- Missions: endless deliveries -------------------------------------------------
// A reason to walk: a persistent delivery loop between real landmarks. Each
// mission targets a landmark (≥300 m away when possible), pays by distance,
// and chains forever. Money persists across reloads via localStorage — the
// beginning of game progression on top of the map.
let money = parseInt(localStorage.getItem('wj_money') || '0', 10) || 0;
let mission = null;               // { name, x, z, reward }
const MISSION_ARRIVE_M = 15;      // arrival radius

function newMission() {
  if (!landmarks.length) { mission = null; return; }
  // Prefer a target that's an actual journey away; fall back to the farthest
  // of a few random picks in a small old city.
  let best = null, bestD = -1;
  for (let tries = 0; tries < 8; tries++) {
    const c = landmarks[Math.floor(Math.random() * landmarks.length)];
    const d = Math.hypot(c.x - playerPos.x, c.z - playerPos.z);
    if (d > 300) { best = c; break; }
    if (d > bestD) { best = c; bestD = d; }
  }
  const d = Math.hypot(best.x - playerPos.x, best.z - playerPos.z);
  mission = {
    name: best.name, x: best.x, z: best.z,
    reward: Math.max(10, Math.round(d / 100) * 10),
  };
}

// 8-way direction arrow from the player to a point, relative to `heading`
// (the shared playerYaw: 0 = facing north/-Z; same convention as movement).
function arrowTo(tx, tz, heading) {
  const bearing = Math.atan2(tx - playerPos.x, -(tz - playerPos.z));
  let rel = bearing - heading;
  while (rel > Math.PI) rel -= 2 * Math.PI;
  while (rel < -Math.PI) rel += 2 * Math.PI;
  const arrows = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
  return arrows[((Math.round(rel / (Math.PI / 4)) % 8) + 8) % 8];
}

// Mission tick: returns the HUD line (target + arrow + distance + reward +
// money), completes the mission on arrival, and chains the next one.
function updateMission(heading) {
  if (!mission) return money > 0 ? `💰 ₹${money}` : '';
  const d = Math.hypot(mission.x - playerPos.x, mission.z - playerPos.z);
  if (d < MISSION_ARRIVE_M) {
    money += mission.reward;
    localStorage.setItem('wj_money', String(money));
    dom.status.textContent = `✅ Delivered to ${mission.name}! +₹${mission.reward} — next delivery…`;
    newMission();
    return '';
  }
  return `🎯 ${mission.name} ${arrowTo(mission.x, mission.z, heading)} ${Math.round(d)} m · ₹${mission.reward}   |   💰 ₹${money}`;
}

// -----------------------------------------------------------------------------
// 11. Place-name lookup (Nominatim reverse geocode)
// -----------------------------------------------------------------------------
//
// Raw lat/lon in the HUD is meaningless to a human. We resolve the player's
// position to a readable place name ("Layakam Mohalla • Paota • Jodhpur").
//
// Constraints that shape the design:
//   - Throttled to ≥ PLACE_REFRESH_MS apart AND ≥ PLACE_REFRESH_DIST moved,
//     comfortably under Nominatim's 1 req/s policy limit.
//   - Nominatim requires a meaningful User-Agent, but browsers FORBID setting
//     User-Agent from fetch(). The default browser UA ("Mozilla/5.0 …") is
//     accepted by the public instance (verified), so we rely on that.
//   - Nominatim sends `Access-Control-Allow-Origin: *`, so a browser fetch to
//     it is allowed despite the cross-origin.
//   - If a lookup fails (rate-limit, offline), we keep showing the last known
//     name — never break walking over a missing label.

let lastPlacePos = null;           // {x, z} of last lookup in scene coords
let lastPlaceTime = 0;             // ms timestamp of last lookup
let placeInFlight = false;         // prevent overlapping requests
let currentPlace = '';             // last successfully resolved label

function formatPlace(json) {
  // Build a short "road • suburb • city" style label from the address object.
  // We prefer the road/feature name, then progressively larger areas, and stop
  // before country/state to keep it short.
  if (!json) return '';
  const a = json.address || {};
  const parts = [];
  const name = json.name || a.road || a.pedestrian || a.square || a.path;
  if (name) parts.push(name);
  const area = a.neighbourhood || a.suburb || a.quarter || a.city_district;
  if (area && area !== name) parts.push(area);
  const city = a.city || a.town || a.village;
  if (city && city !== area && city !== name) parts.push(city);
  return parts.join(' • ');
}

async function refreshPlace(lat, lon) {
  if (placeInFlight) return;
  placeInFlight = true;
  try {
    const url = new URL(NOMINATIM);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', lat.toFixed(6));
    url.searchParams.set('lon', lon.toFixed(6));
    url.searchParams.set('zoom', String(PLACE_ZOOM));
    const res = await fetch(url, {
      headers: { 'Accept-Language': 'en' },   // English place names where tagged
    });
    if (res.ok) {
      const json = await res.json();
      const label = formatPlace(json);
      if (label) currentPlace = label;
    }
    // On failure we simply keep the last label; nothing to do.
  } catch (e) {
    // Network error — keep the last label, but leave a trace for debugging.
    console.warn('Place lookup failed:', e.message);
  } finally {
    placeInFlight = false;
    lastPlaceTime = performance.now();
  }
}

// -----------------------------------------------------------------------------
// 12. Frame loop
// -----------------------------------------------------------------------------
//
// `animate` is the orchestrator: it computes the shared per-frame values
// (camera forward, player yaw) ONCE, then delegates to one function per
// concern. Each sub-function is independently readable; none of them can kill
// the loop (failures are caught and logged, not swallowed silently).

const clock = new THREE.Clock();

// Scratch vectors/objects reused every frame (avoids per-frame allocation
// churn — at 60 fps, even small allocations add up to GC pauses).
const _camFwd = new THREE.Vector3();
const _camFwdFlat = new THREE.Vector3();
const _move = new THREE.Vector3();
const _right = new THREE.Vector3();
const _tryPos = new THREE.Vector3();
const _camProbe = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);   // constant world up (camera.up is repurposed in top-down view)
const _vel = new THREE.Vector3();              // persistent horizontal velocity (momentum)
const _desiredVel = new THREE.Vector3();       // input-derived target velocity
const _moveResult = { moving: false, speed: 0 };

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05); // clamp big frame gaps (e.g.
                                                // when the tab was inactive)

  if (active) {
    // PANORAMA VISIT: the 3D world is hidden and the real 360° photo is the
    // environment. Only look-controls run (drag/arrows rotate you inside the
    // photo); movement, streaming, camera placement, and physics are frozen.
    if (panoramaMode) {
      updateTurning(dt);
      updateDragEdgeRotation(dt);
      applyFallbackLook();           // yaw/pitch drive the view in all modes
      updateHud(yaw);
      renderer.render(scene, camera);
      return;
    }

    updateStreaming();         // crossed into a new tile → queue the next ring
    updateTurning(dt);
    updateDragEdgeRotation(dt);
    updateInputDebug();

    // Shared per-frame derivations, computed AFTER turning so they reflect
    // this frame's rotation. In first/third-person the camera's world
    // direction is the one source of truth (in pointer-lock mode the manual
    // `yaw` variable is stale — PointerLockControls writes the camera
    // quaternion directly). In TOP-DOWN the camera looks straight down, so
    // its direction says nothing about heading — there the `yaw` variable is
    // authoritative and the camera is rotated to match it in updateCamera.
    //
    //   playerYaw: radians, 0 = facing -Z (north). Forward in world XZ for
    //              this yaw is (sin yaw, 0, -cos yaw).
    //   camFwdFlat: the yaw's horizontal unit vector — used for movement and
    //               the camera offsets.
    let playerYaw;
    if (viewMode === 'top') {
      playerYaw = yaw;
      _camFwdFlat.set(Math.sin(yaw), 0, -Math.cos(yaw));
    } else {
      camera.getWorldDirection(_camFwd);
      playerYaw = Math.atan2(_camFwd.x, -_camFwd.z);
      _camFwdFlat.copy(_camFwd);
      _camFwdFlat.y = 0;
      _camFwdFlat.normalize();                 // keep movement horizontal
    }

    const { moving, speed } = updateMovement(dt, _camFwdFlat);

    // FOV kick: widen toward FOV_SPRINT as actual speed passes walking pace —
    // pure game-feel; makes sprinting read as fast. Eased and only touched
    // when it changes (updateProjectionMatrix is not free).
    const sprintT = Math.max(0, Math.min(1, (speed - WALK_SPEED) / (RUN_SPEED - WALK_SPEED)));
    const targetFov = FOV_BASE + sprintT * (FOV_SPRINT - FOV_BASE);
    if (Math.abs(camera.fov - targetFov) > 0.05) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 5);
      camera.updateProjectionMatrix();
    }

    updateCamera(dt, _camFwdFlat, moving, speed, playerYaw);
    updateNearest();       // nearest named road + landmark (throttled 1 s)
    updateHud(playerYaw);
    updateMinimap(playerYaw);
  }

  renderer.render(scene, camera);
}

// Fallback-mode turning: arrow keys / Q-E rotate the view when there's no
// pointer lock. In pointer-lock mode the mouse does this and this is a no-op.
function updateTurning(dt) {
  if (controls.isLocked) return;
  const turn = (keys['ArrowLeft'] || keys['KeyQ'] ? 1 : 0)
             - (keys['ArrowRight'] || keys['KeyE'] ? 1 : 0);
  if (turn !== 0) {
    yaw += turn * 1.8 * dt;
    applyFallbackLook();
  }
}

// EDGE-CONTINUE rotation while dragging. Without pointer lock, drag-look only
// rotates while the cursor MOVES — a single stroke covers ~90° before the
// cursor reaches the edge of the viewport and rotation stops ("when I drag
// there is limitation and it stops"). While a drag is held near a screen
// edge, we keep rotating in that direction, scaled by how close to the edge
// the pointer is (RTS-style edge scrolling). One stroke can now turn any
// amount: drag to the edge and hold.
const DRAG_EDGE_ZONE_PX  = 70;    // proximity to an edge that triggers rotation
const DRAG_EDGE_RATE     = 2.2;   // rad/s at the very edge
function updateDragEdgeRotation(dt) {
  if (!dragState.dragging || controls.isLocked) return;
  const w = window.innerWidth, h = window.innerHeight;
  const dRight = w - dragState.x, dLeft = dragState.x;
  const dBottom = h - dragState.y, dTop = dragState.y;

  if (dRight < DRAG_EDGE_ZONE_PX)        yaw   -= (1 - dRight  / DRAG_EDGE_ZONE_PX) * DRAG_EDGE_RATE * dt;
  else if (dLeft < DRAG_EDGE_ZONE_PX)    yaw   += (1 - dLeft   / DRAG_EDGE_ZONE_PX) * DRAG_EDGE_RATE * dt;
  if (dBottom < DRAG_EDGE_ZONE_PX)       pitch -= (1 - dBottom / DRAG_EDGE_ZONE_PX) * DRAG_EDGE_RATE * dt;
  else if (dTop < DRAG_EDGE_ZONE_PX)     pitch += (1 - dTop    / DRAG_EDGE_ZONE_PX) * DRAG_EDGE_RATE * dt;

  pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
  applyFallbackLook();
}

// Desired horizontal velocity from input — with MOMENTUM. The velocity eases
// toward the input direction (accelerate a touch faster than decelerate) so
// starts and stops have weight; at a steady walk this is indistinguishable
// from the old direct control, but sprinting away or skidding to a stop now
// feels like a body, not a turret. Returns the ACTUAL speed (post-momentum),
// which the camera FOV kick and walk cycle use.
function updateMovement(dt, camFwdFlat) {
  const speed = keys['ShiftLeft'] || keys['ShiftRight'] ? RUN_SPEED : WALK_SPEED;

  const forward = (keys['KeyW'] || keys['ArrowUp']   ? 1 : 0)
                - (keys['KeyS'] || keys['ArrowDown'] ? 1 : 0);
  const strafe  = (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0);

  // Right vector = forward × WORLD up. (NOT camera.up — the top-down view
  // rotates camera.up to the heading vector, which would zero this product.)
  _right.crossVectors(camFwdFlat, _worldUp).normalize();

  _desiredVel.set(0, 0, 0);
  _desiredVel.addScaledVector(camFwdFlat, forward * speed);
  _desiredVel.addScaledVector(_right,      strafe  * speed);

  // Exponential approach: frame-rate independent easing.
  const k = _desiredVel.lengthSq() > 0 ? MOVE_ACCEL : MOVE_DECEL;
  _vel.lerp(_desiredVel, 1 - Math.exp(-k * dt));

  _move.copy(_vel).multiplyScalar(dt);

  // Sub-step the move so one large frame delta can't TUNNEL through a thin
  // wall. The frame dt is clamped to 0.05 s and sprint speed is 14 m/s, so a
  // throttled tab can produce ~0.7 m per frame — bigger than PLAYER_RADIUS
  // (0.4 m), which the old single endpoint-only check could jump straight
  // through. Each sub-step is capped below the radius. (At normal frame rates
  // this is exactly one step — identical behavior.)
  const dist = _move.length();
  const steps = Math.max(1, Math.ceil(dist / (PLAYER_RADIUS * 0.9)));
  for (let s = 0; s < steps; s++) {
    // Try X and Z independently within each sub-step so a wall on one axis
    // doesn't kill all movement (lets you slide along building faces).
    _tryPos.copy(playerPos); _tryPos.x += _move.x / steps;
    if (!resolveCollision(_tryPos)) playerPos.x = _tryPos.x;
    _tryPos.copy(playerPos); _tryPos.z += _move.z / steps;
    if (!resolveCollision(_tryPos)) playerPos.z = _tryPos.z;
  }

  const actualSpeed = _vel.length();
  _moveResult.moving = actualSpeed > 0.4;   // small threshold: skid counts as moving
  _moveResult.speed = actualSpeed;
  return _moveResult;
}

// Place the camera + avatar based on view mode.
// FIRST-PERSON: camera at playerPos + eye height, with a subtle head-bob while
//   walking (±4 cm sine; frequency scales with speed).
// THIRD-PERSON: camera behind/above the avatar looking at its chest; no
//   head-bob — the walk cycle (animateAvatar) drives the limbs instead.
function updateCamera(dt, camFwdFlat, moving, speed, playerYaw) {
  try {
    if (viewMode === 'third') {
      // Position the avatar at the player's feet, facing where the camera
      // looks (Vice-City style: character turns to face the view forward).
      // The avatar model's "front" is its local -Z, and world forward for
      // `playerYaw` is (sin yaw, -cos yaw) — the rotation that aligns the
      // model's front with that forward works out to `-playerYaw`.
      avatar.position.set(playerPos.x, 0, playerPos.z);
      avatar.rotation.y = -playerYaw;
      animateAvatar(dt, moving, speed);

      // Restore the standard up vector — the top-down view repurposes
      // camera.up as the heading, and a leftover rotated up would skew this
      // branch's lookAt after switching views.
      camera.up.copy(_worldUp);

      // Camera: behind the player and above the feet — but PULLED IN FRONT OF
      // WALLS. In Jodhpur's tight lanes the naive fixed offset regularly put
      // the camera inside the building behind you (near plane clipped through
      // it, hiding the avatar). We march from the player toward the desired
      // position and stop at the first blocked sample, placing the camera at
      // the last free one. Buildings are full-height extrusions, so the 2D
      // footprint test is valid at camera height.
      const desiredX = playerPos.x - camFwdFlat.x * THIRD_PERSON_DIST;
      const desiredZ = playerPos.z - camFwdFlat.z * THIRD_PERSON_DIST;
      let camT = 1;   // fraction along player→desired
      const PROBES = 8;
      for (let i = 1; i <= PROBES; i++) {
        const t = i / PROBES;
        _camProbe.set(
          playerPos.x + (desiredX - playerPos.x) * t,
          0,
          playerPos.z + (desiredZ - playerPos.z) * t,
        );
        if (resolveCollision(_camProbe)) {
          camT = (i - 1) / PROBES;
          break;
        }
      }
      camera.position.set(
        playerPos.x + (desiredX - playerPos.x) * camT,
        THIRD_PERSON_HEIGHT,
        playerPos.z + (desiredZ - playerPos.z) * camT,
      );
      // Look at the avatar's upper body.
      camera.lookAt(playerPos.x, AVATAR_LOOK_HEIGHT, playerPos.z);
    } else if (viewMode === 'top') {
      // TOP-DOWN (Road-Fighter style): camera directly above the player,
      // looking down, with the heading rotated to point UP the screen — the
      // world turns beneath you as you steer. The avatar is visible from
      // above with its walk cycle; landmark beacons + labels read nicely
      // from this height too.
      avatar.position.set(playerPos.x, 0, playerPos.z);
      avatar.rotation.y = -playerYaw;
      animateAvatar(dt, moving, speed);

      // lookAt with a straight-down view direction has a degenerate default
      // up — we set camera.up to the horizontal heading so "forward" always
      // means "toward the top of the screen". (updateCamera's other branches
      // restore the standard up vector.)
      camera.up.set(camFwdFlat.x, 0, camFwdFlat.z);
      camera.position.set(playerPos.x, TOP_DOWN_HEIGHT, playerPos.z);
      camera.lookAt(playerPos.x, 0, playerPos.z);
    } else {
      // First-person. Keep playerPos.y at eye height and apply head-bob.
      if (moving) {
        bobPhase += dt * speed * 1.8;
        playerPos.y = EYE_HEIGHT + Math.sin(bobPhase) * 0.04;
      } else {
        playerPos.y += (EYE_HEIGHT - playerPos.y) * Math.min(1, dt * 8);
      }
      camera.position.copy(playerPos);
      // Restore the standard up vector in case the top-down view changed it.
      camera.up.copy(_worldUp);
    }
  } catch (camErr) {
    console.warn('Camera/avatar placement error:', camErr);
  }
}

// HUD: place name (throttled Nominatim lookup) + live coordinates + mission.
function updateHud(heading) {
  try {
    const now = performance.now();
    const moved = lastPlacePos
      ? Math.hypot(playerPos.x - lastPlacePos.x, playerPos.z - lastPlacePos.z)
      : Infinity;
    if (!placeInFlight &&
        now - lastPlaceTime > PLACE_REFRESH_MS &&
        moved > PLACE_REFRESH_DIST) {
      lastPlacePos = { x: playerPos.x, z: playerPos.z };
      const ll = scenePosToLatLon(playerPos);
      refreshPlace(ll.lat, ll.lon);
    }

    const ll = scenePosToLatLon(playerPos);
    // Three lines: (1) Nominatim place + coordinates, (2) nearest named road
    // and landmark with distances, (3) the active delivery mission. #hud uses
    // pre-line.
    const line2 = [_nearestRoadTxt, _nearestLmTxt, _panoHintTxt].filter(Boolean).join('   ·   ');
    const line3 = updateMission(heading);
    dom.hud.textContent =
      (currentPlace ? currentPlace + '   |   ' : '') +
      `XY: ${playerPos.x.toFixed(0)}, ${playerPos.z.toFixed(0)} m   |   ` +
      `lat/lon: ${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)}` +
      (line2 ? '\n' + line2 : '') +
      (line3 ? '\n' + line3 : '');
  } catch (hudErr) {
    // Never let the HUD kill the frame loop — fall back to bare coordinates.
    console.warn('HUD update error:', hudErr);
    dom.hud.textContent = 'XY: ' + playerPos.x.toFixed(0) + ', ' + playerPos.z.toFixed(0) + ' m';
  }
}

// Minimap: draw the player-centred top-down view. The heading is the shared
// playerYaw computed once per frame in animate(). No-ops if the static base
// map wasn't built (empty data set) instead of throwing every frame.
function updateMinimap(playerYaw) {
  if (!MINIMAP.transform) return;
  try {
    drawMinimap(playerPos.x, playerPos.z, playerYaw);
  } catch (mmErr) {
    console.warn('Minimap draw error:', mmErr);
  }
}

// -----------------------------------------------------------------------------
// 13. Boot
// -----------------------------------------------------------------------------

async function boot() {
  try {
    // --- STREAMING START -------------------------------------------------------
    // Load ONLY the 1 km tile under the player first (a ~1 MB query vs the old
    // ~8 MB whole-city fetch) so the world appears in a couple of seconds;
    // the surrounding 3×3 ring streams in the background (tilePump), and as
    // the player moves, updateStreaming() queues the next ring ahead of them.
    initMinimap();                      // fixed-extent base; tiles paint in
    dom.status.textContent = 'Loading your district of Jodhpur…';
    const pt = playerTile();
    const centerOk = await loadTile(pt.ix, pt.iz);
    if (!centerOk && !colliders.length) {
      throw new Error('Could not reach OpenStreetMap for the starting district.');
    }

    dom.crosshair.style.display = 'block';
    dom.minimapWrap.hidden = false;
    dom.status.textContent =
      `Jodhpur loaded (district): ${streamingStats.buildings} buildings — streaming the rest…`;
    console.log(`Center tile ${tileKey(pt.ix, pt.iz)}: ${streamingStats.buildings} buildings, ${streamingStats.roads} roads.`);
    ensureTilesAround(pt.ix, pt.iz);    // queue the 8 neighbors
    tilePump();                         // background loader, runs forever
    animate();
    worldReady = true;

    // Seed the HUD with the spawn location's place name so the label isn't
    // empty for the first few seconds before the movement-triggered lookup
    // would have fired. The spawn point is the ORIGIN in lat/lon.
    refreshPlace(ORIGIN.lat, ORIGIN.lon);

    // Fetch gates + landmarks for the destinations panel. Run AFTER the scene
    // is live so it can't delay the initial render; it's a small, separate
    // query and any failure is non-fatal (the panel just stays hidden).
    // Once fetched, the same data drives orientation: beacons + name labels
    // in the 3D world, dots + names on the minimap, and the HUD's
    // nearest-landmark line.
    fetchLandmarks().then(list => {
      populateDestinations(list);
      if (landmarks.length) {
        buildLandmarkBeacons();
        drawLandmarksOnMinimap();
        newMission();     // start the delivery loop
        console.log(`Loaded ${landmarks.length} destinations.`);
      }
    }).catch(err => console.warn('Landmarks fetch failed:', err.message));

    // Engagement strategy: start in fallback (drag-to-look) mode IMMEDIATELY.
    // The scene is visible and walkable the instant data finishes loading — no
    // overlay blocking the view, no waiting for a click that may never come.
    // Embedded webviews (ZCode's in-app browser, etc.) often can't deliver a
    // usable click or grant pointer lock, so any design that gates the scene
    // behind "click to start" strands the user on a black overlay.
    //
    // Pointer lock is an UPGRADE, not a gate: on the first pointerdown we try
    // to acquire it; if the browser actually grants it (lock event fires), we
    // hide the cursor and switch to FPS mouse-look. If not, drag-to-look keeps
    // working as it already did.
    startFallback();
    dom.loading.hidden = true;
    dom.overlay.hidden = true;   // never block the scene; keep the element for
                                 // the pointerlock 'unlock' (pause) handler.

    // Persistent resume handler. After Esc pauses the game, any click resumes
    // (the pause overlay's background passes clicks through, so this fires for
    // UI-panel clicks too). Clicks that land on a UI panel are NOT turned into
    // pointer-lock requests — grabbing the pointer mid-click can swallow the
    // panel button's own click event (e.g. destination teleports).
    const UI_PANELS = '#destinations, #viewToggle, #minimapWrap, #inputDebug';
    const onInteract = (e) => {
      // If paused, resume first.
      if (!active) resumeGame();
      // Don't hijack UI-panel clicks into pointer-lock requests.
      if (e && e.target && e.target.closest && e.target.closest(UI_PANELS)) return;
      // Try to upgrade to pointer lock (no-op if unsupported / already locked).
      if (!controls.isLocked) {
        try {
          const p = controls.lock();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (e) { /* stay in fallback */ }
      }
    };
    dom.overlay.addEventListener('click', onInteract);
    addEventListener('pointerdown', onInteract);
  } catch (err) {
    dom.loading.classList.add('error');
    dom.loading.textContent = 'Failed to load Jodhpur map data: ' + err.message +
      '\n\nThe Overpass API may be busy. Wait a moment and refresh.';
    dom.status.textContent = 'Error: ' + err.message;
    console.error(err);
  }
}

boot();
