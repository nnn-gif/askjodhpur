// =============================================================================
// Walk Jodhpur — a walkable 3D city map in the browser.
//
// This single file does everything. It is intentionally dependency-light
// (just three.js from CDN) so you can read it top-to-bottom and understand
// every step. The README explains *why* each choice was made; the comments
// here explain *how*.
//
// Pipeline:
//   1. Fetch real building + road geometry for Jodhpur from the Overpass API
//      (OpenStreetMap's read endpoint).
//   2. Convert latitude/longitude into 3D scene coordinates (equirectangular
//      projection centered on the city).
//   3. Extrude each building footprint into a 3D box; lay roads as flat ribbons.
//   4. Set up a first-person camera with PointerLockControls (mouse-look + WASD).
//   5. Run a frame loop that moves the player, applies gravity, and stops them
//      from walking through buildings (sphere-vs-AABB collision).
// =============================================================================

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// -----------------------------------------------------------------------------
// 0. Configuration
// -----------------------------------------------------------------------------

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

// Player physics constants, in meters / seconds.
const EYE_HEIGHT     = 1.7;   // average human eye height
const WALK_SPEED     = 1.5;   // ~5.4 km/h, a normal walking pace
const RUN_SPEED      = 5.0;   // a jog
const PLAYER_RADIUS  = 0.4;   // collision sphere radius
const GRAVITY        = 20.0;  // m/s^2, used only if we add steps/jumps later

// -----------------------------------------------------------------------------
// 1. Lat/lon → scene coordinates
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

// -----------------------------------------------------------------------------
// 2. Fetch OSM data from the Overpass API
// -----------------------------------------------------------------------------
//
// Overpass is OpenStreetMap's read-only query API. We send it Overpass QL and
// get back GeoJSON-ish elements: ways (ordered lists of lat/lon nodes) tagged
// with things like building=yes, highway=residential, building:levels=3.
//
// We request both buildings and roads in one query (the union `(...)`) so we
// pay only one network round-trip. `out geom` embeds each way's coordinates
// inline — without it we'd have to resolve node IDs separately, doubling the
// number of requests.
//
// Reliability: the public Overpass service is free and shared. Heavy queries
// (a ~3 km city box returns ~8 MB / thousands of buildings) intermittently
// fail with HTTP 429 (rate limit), 503, or 504 (gateway timeout) — exactly
// the "504 Gateway Timeout" you'll see under load. To stay robust the loader:
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
const ATTEMPTS_PER_MIRROR = 2;
const RETRY_DELAY_MS = 1500;

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
  return m.includes('HTML error page') ||
         m.includes('Failed to fetch') ||
         m.includes('Aborted') ||
         m.includes('NetworkError') ||
         m.includes('Load failed');
}

async function fetchOSM(onStatus) {
  // Try the full city bbox across all mirrors, with retries on transient
  // errors. If every mirror gives up on the full bbox, progressively shrink
  // the box around the origin and try again — better to load the old-city
  // core than to show nothing.
  const bboxScales = [1, 0.6, 0.35];
  for (const scale of bboxScales) {
    const bbox = {
      south: ORIGIN.lat - 0.015 * scale,
      west:  ORIGIN.lon - 0.015 * scale,
      north: ORIGIN.lat + 0.015 * scale,
      east:  ORIGIN.lon + 0.015 * scale,
    };
    const query = buildOverpassQuery(bbox);
    for (const mirror of OVERPASS_MIRRORS) {
      for (let attempt = 1; attempt <= ATTEMPTS_PER_MIRROR; attempt++) {
        const tag = scale < 1 ? ` (smaller area, ${Math.round(scale*100)}%)` : '';
        onStatus && onStatus(
          `Fetching Jodhpur from OpenStreetMap… (mirror ${OVERPASS_MIRRORS.indexOf(mirror)+1}/${OVERPASS_MIRRORS.length}, try ${attempt})${tag}`);
        try {
          const result = await fetchOnce(mirror, query);
          // An empty result is not success — treat it like a failure so we
          // shrink or move on. (Happens on rare bad-cache responses.)
          if (!result.buildings.length && !result.roads.length) {
            throw new Error('Overpass returned no data');
          }
          return result;
        } catch (err) {
          console.warn(`Overpass attempt failed (${mirror}, try ${attempt}, scale ${scale}):`, err.message);
          if (!isRetryable(err)) throw err;          // permanent error → bail
          if (attempt < ATTEMPTS_PER_MIRROR) await sleep(RETRY_DELAY_MS);
        }
      }
    }
  }
  throw new Error('All Overpass mirrors failed. The free OSM API may be busy — please refresh in a moment.');
}

// -----------------------------------------------------------------------------
// 3. Three.js scene setup
// -----------------------------------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);      // sky blue
scene.fog = new THREE.Fog(0x87ceeb, 120, 450);     // haze hides the edge of the
                                                    // data and adds depth. The far
                                                    // value must be smaller than
                                                    // the data radius (~3 km) so
                                                    // we never see the void.

const camera = new THREE.PerspectiveCamera(
  72,                                               // FOV — slightly wide, feels
                                                    // like a person looking around
  window.innerWidth / window.innerHeight,
  0.1, 1000
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // cap at 2x for perf
renderer.shadowMap.enabled = true;
document.getElementById('app').appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Lighting ---------------------------------------------------------------
// A hemisphere light gives soft sky-vs-ground ambient fill (cheap, looks
// natural). A single directional light stands in for the sun and casts shadows.
const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x6b5a3a, 0.9);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff2d8, 1.1);
sun.position.set(80, 140, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
// Keep the shadow camera framed on the area around the player's start so the
// shadow map has useful resolution where it matters.
sun.shadow.camera.left = -150;
sun.shadow.camera.right = 150;
sun.shadow.camera.top = 150;
sun.shadow.camera.bottom = -150;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 400;
scene.add(sun);

// -----------------------------------------------------------------------------
// 4. Build the ground plane
// -----------------------------------------------------------------------------
//
// A large textured-tone plane represents the ground. We tint it a warm sandy
// color to evoke Jodhpur's desert setting (it's called the Sun City / Blue City).

const groundGeo = new THREE.PlaneGeometry(4000, 4000);
const groundMat = new THREE.MeshStandardMaterial({ color: 0xc9b08a, roughness: 1 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;   // PlaneGeometry is in the XY plane; rotate
                                     // it to lie flat on the XZ ground plane.
ground.receiveShadow = true;
scene.add(ground);

// -----------------------------------------------------------------------------
// 5. Build 3D geometry from OSM data
// -----------------------------------------------------------------------------
//
// This is the core of the "city map". Each OSM building is a closed polygon of
// lat/lon points. We:
//   - convert each point to scene meters,
//   - build a THREE.Shape from the polygon,
//   - extrude it upward by the building's height to get a solid block.
//
// Height: OSM's `building:levels` tag gives the floor count if present;
// otherwise we fall back to a default. This is the standard heuristic used by
// OSMBuildings, Cesium, and other OSM-3D viewers.

const DEFAULT_BUILDING_HEIGHT = 6;     // ~2 storeys if no data
const METERS_PER_LEVEL = 3.2;

function buildingHeight(tags) {
  const levels = parseFloat(tags['building:levels']);
  if (!isNaN(levels) && levels > 0) return levels * METERS_PER_LEVEL;
  const h = parseFloat(tags['height']); // some tags give meters directly
  if (!isNaN(h) && h > 0) return h;
  return DEFAULT_BUILDING_HEIGHT;
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
// the collision match what you see.
const colliders = [];

// A palette leaning into Jodhpur's famous "Blue City" old-town colors, with a
// few warm tones mixed in. We pick per-building deterministically from the OSM
// id so the same building is always the same color on reload.
const BLUE_PALETTE = [0x2b4a7a, 0x365a8c, 0x4a6fa5, 0x6b8cbf, 0xb08968, 0xc9a87c, 0xd9c2a0];

function buildBuildings(buildings) {
  const meshMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
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

    const height = buildingHeight(b.tags || {});
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

    const mesh = new THREE.Mesh(geo, meshMat.clone());
    // Deterministic color from the building's OSM id.
    mesh.material.color.setHex(BLUE_PALETTE[Math.abs(b.id) % BLUE_PALETTE.length]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    // Store collision data: a broad-phase AABB (expanded by player radius) and
    // the real footprint polygon in scene XZ. The polygon is what makes
    // collision accurate; the AABB skips the expensive point-in-polygon test
    // for buildings that are nowhere near the player.
    const bbox = new THREE.Box3().setFromObject(mesh);
    colliders.push({
      minX: bbox.min.x - PLAYER_RADIUS,
      maxX: bbox.max.x + PLAYER_RADIUS,
      minZ: bbox.min.z - PLAYER_RADIUS,
      maxZ: bbox.max.z + PLAYER_RADIUS,
      // Footprint polygon in (x, z) scene coords, in the same winding as the
      // OSM ring. pointInPoly doesn't care about winding.
      poly: pts.map(p => [p.x, p.y]),
    });
    built++;
  }
  return built;
}

// Roads: draw each highway as a thin flat ribbon on the ground. We use a
// Line instead of a mesh to keep it cheap — there can be thousands of road
// segments. Lines have no collision; the player can cross them freely, which
// is what you want (roads are walkable).
function buildRoads(roads) {
  const positions = [];
  for (const r of roads) {
    const g = r.geometry;
    if (!g || g.length < 2) continue;
    for (let i = 0; i < g.length - 1; i++) {
      const [x1, z1] = lonLatToXY(g[i].lon, g[i].lat);
      const [x2, z2] = lonLatToXY(g[i+1].lon, g[i+1].lat);
      positions.push(x1, 0.05, z1, x2, 0.05, z2);   // y=0.05 to avoid z-fight
                                                     // with the ground plane
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x333333 });
  scene.add(new THREE.LineSegments(geo, mat));
}

// -----------------------------------------------------------------------------
// 6. First-person controls (PointerLockControls)
// -----------------------------------------------------------------------------
//
// PointerLockControls hides the cursor and reads raw mouse movement to rotate
// the camera — exactly the way FPS games and Minecraft do "mouse look". The
// browser only allows pointer lock after a user gesture (a click), which is
// why index.html has a "Click to start" overlay.
//
// IMPORTANT — why we don't depend on pointer lock:
// Many embedded webviews (including ZCode's in-app browser, Electron apps,
// some mobile browsers, and any iframe without allow="pointer-lock") do NOT
// support the Pointer Lock API. If we gated movement on `controls.isLocked`
// the demo would silently do nothing on those platforms — "I see the loaded
// log and nothing happens." So pointer lock is treated as an *enhancement*:
// when it works we use it for FPS-style mouse-look; when it doesn't, we fall
// back to drag-to-look + arrow/Q-E turning, and WASD always works.
const controls = new PointerLockControls(camera, document.body);

// Keyboard state. We track pressed keys ourselves rather than letting the
// controls object move us, so we can mix in run, gravity, and collision.
const keys = Object.create(null);
addEventListener('keydown', e => { keys[e.code] = true; });
addEventListener('keyup',   e => { keys[e.code] = false; });

// Start the player on a real street, at eye height. The naive origin (0,0,0)
// lands inside a building's footprint in dense central Jodhpur and traps the
// player. This point was verified to sit on the "Layakam Mohalla" lane with
// ~2 m of clearance to the nearest building — a genuinely walkable spot.
camera.position.set(1, EYE_HEIGHT, -24);

const overlay = document.getElementById('overlay');
const loading = document.getElementById('loading');
const hud = document.getElementById('hud');
const status = document.getElementById('status');

// `active` means "the demo is in interactive mode" — distinct from pointer
// lock. WASD movement and turning are enabled whenever active is true, even
// if pointer lock is unavailable.
let active = false;

// Manual yaw/pitch used by the no-lock fallback. PointerLockControls updates
// the camera quaternion directly on lock, so these are only read/written in
// fallback mode. Pitch is clamped so you can't flip upside-down.
let yaw = 0;
let pitch = 0;
const PITCH_LIMIT = Math.PI / 2 - 0.05;

function applyFallbackLook() {
  // Build the camera orientation from our own yaw/pitch. Order matters: in
  // three.js, Euler 'YXZ' applies yaw (Y) then pitch (X), which is exactly the
  // FPS camera convention (look around horizontally, then up/down).
  camera.rotation.order = 'YXZ';
  camera.rotation.set(pitch, yaw, 0);
}

// --- Pointer-lock path (primary, when supported) ---
// Engagement (the click/keydown + auto-fallback logic) is wired up in boot()
// after the world has loaded, so the user can't enter the scene before it's
// ready. See boot() for why this is gated and why there's an auto-fallback.

controls.addEventListener('lock', () => {
  active = true;
  overlay.hidden = true;
  hud.hidden = false;
  status.textContent += '  •  mouse-look (pointer lock)';
});
controls.addEventListener('unlock', () => {
  // If we ever had lock, releasing it (Esc) returns to the start overlay.
  if (active && controls.pointerLockElement !== null) {
    active = false;
    overlay.hidden = false;
  }
});

// --- Fallback path (drag-to-look + arrow keys), used when no pointer lock ---
function startFallback() {
  if (active) return;
  active = true;
  overlay.hidden = true;
  hud.hidden = false;
  status.textContent += '  •  drag to look, arrows to turn (pointer lock unavailable in this browser)';

  // Drag with the mouse / touch to look around. Track button state so we only
  // rotate while a button is held — otherwise the cursor stays usable.
  let dragging = false;
  let lastX = 0, lastY = 0;
  const onDown = (x, y) => { dragging = true; lastX = x; lastY = y; };
  const onMove = (x, y) => {
    if (!dragging) return;
    const dx = x - lastX, dy = y - lastY;
    lastX = x; lastY = y;
    yaw   -= dx * 0.005;            // mouse right → look right (yaw decreases)
    pitch -= dy * 0.005;
    pitch  = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
    applyFallbackLook();
  };
  const onUp = () => { dragging = false; };

  renderer.domElement.addEventListener('mousedown',  e => onDown(e.clientX, e.clientY));
  addEventListener('mousemove', e => onMove(e.clientX, e.clientY));
  addEventListener('mouseup',   onUp);
  // Touch support, so the demo also works on phones/tablets.
  renderer.domElement.addEventListener('touchstart', e => {
    if (e.touches[0]) onDown(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  renderer.domElement.addEventListener('touchmove', e => {
    if (e.touches[0]) onMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  renderer.domElement.addEventListener('touchend', onUp);
}

// -----------------------------------------------------------------------------
// 7. Reverse geocoding — show the player's current place name
// -----------------------------------------------------------------------------
//
// Raw lat/lon in the HUD is meaningless to a human ("you are at 26.298, 73.022"
// tells you nothing). We resolve the player's position to a readable place name
// ("Layakam Mohalla • Paota • Jodhpur") using OpenStreetMap's Nominatim
// reverse-geocode API.
//
// Constraints that shape the design:
//   - Nominatim's usage policy is MAX 1 request/second. We can't query every
//     frame, so we throttle: at most one lookup per 3 seconds, AND only when
//     the player has moved >15 m since the last lookup. In practice that's
//     well under 1 req/s even when running.
//   - Nominatim requires a meaningful User-Agent, but browsers FORBID setting
//     User-Agent from fetch(). The default browser UA ("Mozilla/5.0 …") is
//     accepted by the public instance (verified), so we rely on that.
//   - Nominatim sends `Access-Control-Allow-Origin: *`, so a browser fetch to
//     it is allowed despite the cross-origin.
//   - If a lookup fails (rate-limit, offline), we keep showing the last known
//     name — never break walking over a missing label.

const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const PLACE_REFRESH_MS = 3000;     // min time between lookups (≥ Nominatim's 1/s)
const PLACE_REFRESH_DIST = 15;     // min meters moved before re-querying
const PLACE_ZOOM = 18;             // street-level detail (road + neighbourhood)

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
  // The feature's own name (e.g. a named road or square), falling back to the
  // road field. Then append suburb/neighbourhood and city if present.
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
    /* network error — keep last label */
  } finally {
    placeInFlight = false;
    lastPlaceTime = performance.now();
  }
}

// Convert the player's scene position to lat/lon (inverse of lonLatToXY).
function scenePosToLatLon(pos) {
  const lat = ORIGIN.lat + pos.z / METERS_PER_DEG_LAT;
  const lon = ORIGIN.lon + pos.x / (METERS_PER_DEG_LAT * cosLat);
  return { lat, lon };
}

// -----------------------------------------------------------------------------
// 8. Movement & collision (the frame loop)
// -----------------------------------------------------------------------------
//
// Each animation frame:
//   - compute a forward/right direction from the camera's yaw,
//   - sum the WASD input into a desired velocity vector,
//   - attempt to move on X and Z independently so a wall on one axis doesn't
//     kill all movement (lets you slide along buildings),
//   - for the candidate position, do a broad-phase AABB check, then a narrow
//     point-in-polygon + edge-distance check against the real footprint. If
//     inside or within PLAYER_RADIUS of a wall, cancel that axis' move.
//
// Axis-separated resolution is the same trick most retro FPS games used. It's
// cheap and feels good. A more accurate engine would use swept spheres or a
// physics library, but that's overkill for a walking demo.

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

const clock = new THREE.Clock();
let bobPhase = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05); // clamp big frame gaps (e.g.
                                                // when the tab was inactive)

  if (active) {
    // --- turning in fallback mode (pointer-lock mode turns via mouse) ---
    // Arrow keys / Q-E rotate the view when there's no pointer lock. In
    // pointer-lock mode these are harmless extras.
    if (!controls.isLocked) {
      const turn = (keys['ArrowLeft'] || keys['KeyQ'] ? 1 : 0)
                 - (keys['ArrowRight'] || keys['KeyE'] ? 1 : 0);
      if (turn !== 0) {
        yaw += turn * 1.8 * dt;
        applyFallbackLook();
      }
    }

    // --- desired horizontal velocity from input ---
    const speed = keys['ShiftLeft'] || keys['ShiftRight'] ? RUN_SPEED : WALK_SPEED;

    const forward = (keys['KeyW'] || keys['ArrowUp']   ? 1 : 0)
                  - (keys['KeyS'] || keys['ArrowDown'] ? 1 : 0);
    const strafe  = (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0);

    // Direction vectors from the camera. We read the camera's world direction
    // (works whether rotation came from PointerLockControls or our yaw/pitch),
    // then flatten it to keep movement horizontal.
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0; dir.normalize();               // keep movement horizontal
    const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();

    const move = new THREE.Vector3();
    move.addScaledVector(dir,   forward * speed * dt);
    move.addScaledVector(right, strafe  * speed * dt);

    // --- axis-separated collision resolution ---
    const pos = camera.position.clone();
    const tryX = pos.clone(); tryX.x += move.x;
    if (!resolveCollision(tryX)) pos.x = tryX.x;
    const tryZ = pos.clone(); pos.z += move.z;
    if (!resolveCollision(tryZ)) pos.z = tryZ.z;

    // --- head bob: a subtle vertical sine while walking for immersion ---
    if (forward !== 0 || strafe !== 0) {
      bobPhase += dt * speed * 1.8;
      pos.y = EYE_HEIGHT + Math.sin(bobPhase) * 0.04;
    } else {
      // ease back to standing height
      pos.y += (EYE_HEIGHT - pos.y) * Math.min(1, dt * 8);
    }

    camera.position.copy(pos);

    // --- HUD: place name + coordinates ---
    // Update the place name at most every PLACE_REFRESH_MS and only if the
    // player has moved enough to be worth re-querying Nominatim.
    try {
      const now = performance.now();
      const moved = lastPlacePos
        ? Math.hypot(pos.x - lastPlacePos.x, pos.z - lastPlacePos.z)
        : Infinity;
      if (!placeInFlight &&
          now - lastPlaceTime > PLACE_REFRESH_MS &&
          moved > PLACE_REFRESH_DIST) {
        lastPlacePos = { x: pos.x, z: pos.z };
        const ll = scenePosToLatLon(pos);
        refreshPlace(ll.lat, ll.lon);
      }

      const ll = scenePosToLatLon(pos);
      hud.textContent =
        (currentPlace ? currentPlace + '   |   ' : '') +
        `XY: ${pos.x.toFixed(0)}, ${pos.z.toFixed(0)} m   |   ` +
        `lat/lon: ${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)}`;
    } catch (hudErr) {
      // If anything in the HUD update throws, never let it kill the frame loop.
      hud.textContent = 'XY: ' + pos.x.toFixed(0) + ', ' + pos.z.toFixed(0) + ' m';
    }
  }

  renderer.render(scene, camera);
}

// -----------------------------------------------------------------------------
// 8. Boot
// -----------------------------------------------------------------------------

async function boot() {
  try {
    status.textContent = 'Fetching Jodhpur from OpenStreetMap…';
    const { buildings, roads } = await fetchOSM(msg => { status.textContent = msg; });
    status.textContent = `Building 3D… (${buildings.length} buildings, ${roads.length} roads)`;
    const nB = buildBuildings(buildings);
    buildRoads(roads);
    document.getElementById('crosshair').style.display = 'block';
    status.textContent = `Jodhpur loaded: ${nB} buildings, ${roads.length} roads`;
    console.log(`Loaded Jodhpur: ${nB} buildings, ${roads.length} roads.`);
    animate();

    // Seed the HUD with the spawn location's place name so the label isn't
    // empty for the first few seconds before the movement-triggered lookup
    // would have fired. The spawn point is the ORIGIN in lat/lon.
    refreshPlace(ORIGIN.lat, ORIGIN.lon);

    // Engagement strategy: start in fallback (drag-to-look) mode IMMEDIATELY.
    // The scene is visible and walkable the instant data finishes loading — no
    // overlay blocking the view, no waiting on a click that may never come.
    // Embedded webviews (ZCode's in-app browser, etc.) often can't deliver a
    // usable click or grant pointer lock, so any design that gates the scene
    // behind "click to start" strands the user on a black overlay.
    //
    // Pointer lock is an UPGRADE, not a gate: on the first pointerdown we try
    // to acquire it; if the browser actually grants it (lock event fires), we
    // hide the cursor and switch to FPS mouse-look. If not, drag-to-look keeps
    // working as it already did.
    startFallback();
    loading.hidden = true;
    overlay.hidden = true;   // never block the scene; keep the element for the
                             // pointerlock 'unlock' handler if we ever upgrade.

    addEventListener('pointerdown', () => {
      // Only upgrade if we're not already in pointer-lock mode.
      if (!controls.isLocked) {
        try {
          const p = controls.lock();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (e) { /* stay in fallback */ }
      }
    }, { once: true });
  } catch (err) {
    loading.classList.add('error');
    loading.textContent = 'Failed to load Jodhpur map data: ' + err.message +
      '\n\nThe Overpass API may be busy. Wait a moment and refresh.';
    status.textContent = 'Error: ' + err.message;
    console.error(err);
  }
}

boot();
