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
// lookup tables (BLUE_PALETTE, ROAD_STYLE) stay co-located with their builders
// in section 4, where they're most readable.

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
const ATTEMPTS_PER_MIRROR = 4;
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
  return [];   // non-fatal: panel just won't populate
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
dom.app.appendChild(renderer.domElement);

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

// --- Ground plane -------------------------------------------------------------
// A large plane represents the ground, tinted a warm sandy color to evoke
// Jodhpur's desert setting (the Sun City / Blue City).
const groundGeo = new THREE.PlaneGeometry(4000, 4000);
const groundMat = new THREE.MeshStandardMaterial({ color: 0xc9b08a, roughness: 1 });
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
// the collision match what you see. (See section 5 for the tests.)
const colliders = [];

// A palette leaning into Jodhpur's famous "Blue City" old-town colors, with a
// few warm tones mixed in. We pick per-building deterministically from the OSM
// id so the same building is always the same color on reload.
const BLUE_PALETTE = [0x2b4a7a, 0x365a8c, 0x4a6fa5, 0x6b8cbf, 0xb08968, 0xc9a87c, 0xd9c2a0];

function buildBuildings(buildings) {
  // One material + one MERGED mesh per palette color. Rendering 8,900
  // buildings as individual Meshes meant ~9,000 draw calls per frame —
  // doubled by the shadow pass — which was the dominant render cost.
  // Merging each color's geometries keeps the visuals identical (same
  // geometry, same palette, same lighting) while dropping to a handful of
  // draw calls. Collision data is unaffected (stored separately below).
  const paletteMats = BLUE_PALETTE.map(c =>
    new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: 0 }));
  const geosByColor = BLUE_PALETTE.map(() => []);
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

    // Deterministic color bucket from the building's OSM id.
    geosByColor[Math.abs(b.id) % BLUE_PALETTE.length].push(geo);

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

  // Emit one merged mesh per color (single-geometry buckets skip the merge).
  for (let ci = 0; ci < geosByColor.length; ci++) {
    const list = geosByColor[ci];
    if (!list.length) continue;
    const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
    const mesh = new THREE.Mesh(merged, paletteMats[ci]);
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
  // (cheap to render; avoids one draw call per road).
  const byColor = Object.create(null);   // colorHex -> { verts: [], idx: [] }

  for (const r of roads) {
    const g = r.geometry;
    if (!g || g.length < 2) continue;
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
  transform: null,   // { minX, maxZ, PX_PER_M } world→pixel params, set by renderMinimapBase
};

function initMinimap() {
  MINIMAP.el = dom.minimap;
  MINIMAP.ctx = MINIMAP.el.getContext('2d');
  // Offscreen canvas holds the full-city static layer. Sized so that the whole
  // loaded bbox (~3 km) fits; we only blit the window around the player.
  MINIMAP.base = document.createElement('canvas');
  MINIMAP.baseCtx = MINIMAP.base.getContext('2d');
}

// Render the whole city once to the offscreen canvas. Called once after load.
// We compute the data's bounding box, scale it to fit the offscreen canvas at
// a chosen resolution, and draw every building polygon + road segment.
function renderMinimapBase() {
  // Guard: with no data at all (both Overpass result sets empty) the bounds
  // would stay ±Infinity and the canvas size becomes NaN, throwing here —
  // inside boot's try/catch that surfaced as a misleading "Failed to load
  // Jodhpur" error. Skip the minimap instead; MINIMAP.transform stays null
  // and updateMinimap no-ops.
  if (!colliders.length && !roadSegments.length) return;

  // World bounds covered by the data. Buildings are stored in colliders[]
  // (with poly in scene XZ); roads in roadSegments[].
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const c of colliders) {
    for (const [x, z] of c.poly) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  for (const seg of roadSegments) {
    const x1 = seg[0], z1 = seg[1], x2 = seg[2], z2 = seg[3];
    if (x1 < minX) minX = x1; if (x1 > maxX) maxX = x1;
    if (x2 < minX) minX = x2; if (x2 > maxX) maxX = x2;
    if (z1 < minZ) minZ = z1; if (z1 > maxZ) maxZ = z1;
    if (z2 < minZ) minZ = z2; if (z2 > maxZ) maxZ = z2;
  }
  // Pad bounds slightly.
  const pad = 20;
  minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;
  const worldW = maxX - minX, worldH = maxZ - minZ;

  // Offscreen resolution: aim for ~2 px per meter so buildings are legible when
  // we zoom in. Cap the canvas dimensions to avoid blowing past browser limits
  // for very large bboxes (3 km × 2 px/m = 6000 px, fine).
  const PX_PER_M = 2;
  const bw = Math.min(8000, Math.round(worldW * PX_PER_M));
  const bh = Math.min(8000, Math.round(worldH * PX_PER_M));
  MINIMAP.base.width = bw;
  MINIMAP.base.height = bh;
  const bctx = MINIMAP.baseCtx;

  // Ground fill (matches the 3D ground color).
  bctx.fillStyle = '#c9b08a';
  bctx.fillRect(0, 0, bw, bh);

  // Helper: world (x,z) → offscreen pixel (px,py). Note z maps to y, and we
  // flip z so that north (+z) is UP on the map (canvas y grows downward).
  const wx = x => (x - minX) * PX_PER_M;
  const wz = z => (maxZ - z) * PX_PER_M;   // flip: +z (north) → top of image

  // Roads first (so buildings draw on top of them, like the 3D view).
  bctx.strokeStyle = '#5a5147';
  bctx.lineWidth = Math.max(1, PX_PER_M * 1.2);
  bctx.beginPath();
  for (const seg of roadSegments) {
    bctx.moveTo(wx(seg[0]), wz(seg[1]));
    bctx.lineTo(wx(seg[2]), wz(seg[3]));
  }
  bctx.stroke();

  // Buildings. Use a slightly darker blue than the 3D palette so they read
  // against the sandy ground at small size.
  bctx.fillStyle = '#2b4a7a';
  for (const c of colliders) {
    const poly = c.poly;
    if (!poly || poly.length < 3) continue;
    bctx.beginPath();
    bctx.moveTo(wx(poly[0][0]), wz(poly[0][1]));
    for (let i = 1; i < poly.length; i++) bctx.lineTo(wx(poly[i][0]), wz(poly[i][1]));
    bctx.closePath();
    bctx.fill();
  }

  // Label the NAMED roads along their direction — street names on the map are
  // the strongest "I know this place" anchor. Only long-enough segments get a
  // label to avoid clutter.
  for (const s of namedRoadSegments) {
    const px1 = wx(s.x1), pz1 = wz(s.z1), px2 = wx(s.x2), pz2 = wz(s.z2);
    if (Math.hypot(px2 - px1, pz2 - pz1) < 60) continue;   // too short to label
    const mx = (px1 + px2) / 2, my = (pz1 + pz2) / 2;
    let ang = Math.atan2(pz2 - pz1, px2 - px1);
    if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;  // keep readable
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

  // Stash the world→pixel transform params for the per-frame draw.
  MINIMAP.transform = { minX, maxZ, PX_PER_M };
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

// `thirdPerson` selects the view mode. `active` (section 9) gates all input.
let thirdPerson = false;

// Head-bob phase for first-person walking (see updateCamera, section 12).
let bobPhase = 0;

// Sync the camera to the spawn point once at startup; every frame after this
// the frame loop owns camera placement.
camera.position.set(playerPos.x, EYE_HEIGHT, playerPos.z);

// Manual yaw/pitch used by the no-lock fallback look (section 9). In
// pointer-lock mode PointerLockControls writes the camera quaternion directly
// and these go stale — which is why the frame loop derives the player's yaw
// from the camera's world direction instead of reading `yaw`.
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

// Toggle between first- and third-person view. Called by the V key (section 9)
// and the on-screen #viewToggle button (essential on touch devices and in
// webviews that swallow synthetic key events). Builds the avatar lazily on
// first toggle so first-person play pays nothing until the user opts in.
function toggleView() {
  if (!active) return;
  if (!avatar) {
    avatar = buildAvatar();
    scene.add(avatar);
  }
  thirdPerson = !thirdPerson;
  avatar.visible = thirdPerson;
  dom.status.textContent = thirdPerson
    ? 'Third-person view — V to switch back'
    : 'First-person view — V for third-person';
  if (dom.viewToggle) {
    dom.viewToggle.textContent = thirdPerson ? '🚶 Third person (V)' : '👁 First person (V)';
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

// `active` means "the demo is in interactive mode" — distinct from pointer
// lock. WASD movement and turning are enabled whenever active is true, even
// if pointer lock is unavailable. `worldReady` gates resume-from-pause so
// pressing keys DURING the initial load can't start the game early.
let active = false;
let worldReady = false;

addEventListener('keydown', e => {
  keys[e.code] = true;
  // V switches first/third-person view.
  if (e.code === 'KeyV') toggleView();
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
  dom.status.textContent = thirdPerson
    ? 'Third-person view — V to switch'
    : 'Resumed — drag to look, arrows to turn';
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

  // Drag with the mouse / touch to look around. Track button state so we only
  // rotate while a button is held — otherwise the cursor stays usable. The
  // `active` guard ignores drags while paused (pause-overlay background clicks
  // now pass through to the canvas), and the `controls.isLocked` guard is
  // essential on desktop: once pointer lock engages, PointerLockControls
  // rotates the camera from raw mouse movement — applying drag-look ON TOP of
  // it would double every rotation.
  let dragging = false;
  let lastX = 0, lastY = 0;
  const onDown = (x, y) => {
    if (!active || controls.isLocked) return;
    dragging = true; lastX = x; lastY = y;
  };
  const onMove = (x, y) => {
    if (!dragging || controls.isLocked) return;
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
const _moveResult = { moving: false, speed: 0 };

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05); // clamp big frame gaps (e.g.
                                                // when the tab was inactive)

  if (active) {
    updateTurning(dt);
    updateInputDebug();

    // Shared per-frame derivations, computed AFTER turning so they reflect
    // this frame's rotation. The camera's world direction is the one source
    // of truth for orientation in BOTH control modes (in pointer-lock mode
    // the manual `yaw` variable is stale — PointerLockControls writes the
    // camera quaternion directly).
    //
    //   playerYaw: radians, 0 = facing -Z (north). Forward in world XZ for
    //              this yaw is (sin yaw, 0, -cos yaw).
    //   camFwdFlat: the yaw's horizontal unit vector — used for movement and
    //               the third-person camera offset.
    camera.getWorldDirection(_camFwd);
    const playerYaw = Math.atan2(_camFwd.x, -_camFwd.z);
    _camFwdFlat.copy(_camFwd);
    _camFwdFlat.y = 0;
    _camFwdFlat.normalize();                   // keep movement horizontal

    const { moving, speed } = updateMovement(dt, _camFwdFlat);
    updateCamera(dt, _camFwdFlat, moving, speed, playerYaw);
    updateNearest();       // nearest named road + landmark (throttled 1 s)
    updateHud();
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

// Desired horizontal velocity from input, applied to `playerPos` with
// axis-separated collision resolution. Returns whether the player is moving
// and at what speed (the camera/avatar code needs both).
function updateMovement(dt, camFwdFlat) {
  const speed = keys['ShiftLeft'] || keys['ShiftRight'] ? RUN_SPEED : WALK_SPEED;

  const forward = (keys['KeyW'] || keys['ArrowUp']   ? 1 : 0)
                - (keys['KeyS'] || keys['ArrowDown'] ? 1 : 0);
  const strafe  = (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0);

  // Right vector = forward × up (both horizontal).
  _right.crossVectors(camFwdFlat, camera.up).normalize();

  _move.set(0, 0, 0);
  _move.addScaledVector(camFwdFlat, forward * speed * dt);
  _move.addScaledVector(_right,     strafe  * speed * dt);

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

  _moveResult.moving = (forward !== 0 || strafe !== 0);
  _moveResult.speed = speed;
  return _moveResult;
}

// Place the camera + avatar based on view mode.
// FIRST-PERSON: camera at playerPos + eye height, with a subtle head-bob while
//   walking (±4 cm sine; frequency scales with speed).
// THIRD-PERSON: camera behind/above the avatar looking at its chest; no
//   head-bob — the walk cycle (animateAvatar) drives the limbs instead.
function updateCamera(dt, camFwdFlat, moving, speed, playerYaw) {
  try {
    if (thirdPerson) {
      // Position the avatar at the player's feet, facing where the camera
      // looks (Vice-City style: character turns to face the view forward).
      // The avatar model's "front" is its local -Z, and world forward for
      // `playerYaw` is (sin yaw, -cos yaw) — the rotation that aligns the
      // model's front with that forward works out to `-playerYaw`.
      avatar.position.set(playerPos.x, 0, playerPos.z);
      avatar.rotation.y = -playerYaw;
      animateAvatar(dt, moving, speed);

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
    } else {
      // First-person. Keep playerPos.y at eye height and apply head-bob.
      if (moving) {
        bobPhase += dt * speed * 1.8;
        playerPos.y = EYE_HEIGHT + Math.sin(bobPhase) * 0.04;
      } else {
        playerPos.y += (EYE_HEIGHT - playerPos.y) * Math.min(1, dt * 8);
      }
      camera.position.copy(playerPos);
    }
  } catch (camErr) {
    console.warn('Camera/avatar placement error:', camErr);
  }
}

// HUD: place name (throttled Nominatim lookup) + live coordinates.
function updateHud() {
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
    // Two lines: Nominatim place + coordinates, then nearest named road and
    // nearest landmark with distances (the useful "where am I" anchors in a
    // city where most streets are unnamed in OSM). #hud uses pre-line.
    const line2 = [_nearestRoadTxt, _nearestLmTxt].filter(Boolean).join('   ·   ');
    dom.hud.textContent =
      (currentPlace ? currentPlace + '   |   ' : '') +
      `XY: ${playerPos.x.toFixed(0)}, ${playerPos.z.toFixed(0)} m   |   ` +
      `lat/lon: ${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)}` +
      (line2 ? '\n' + line2 : '');
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
    dom.status.textContent = 'Fetching Jodhpur from OpenStreetMap…';
    const { buildings, roads } = await fetchOSM(msg => { dom.status.textContent = msg; });
    dom.status.textContent = `Building 3D… (${buildings.length} buildings, ${roads.length} roads)`;
    const nB = buildBuildings(buildings);
    buildRoads(roads);
    dom.crosshair.style.display = 'block';
    // Build the minimap now that colliders + roadSegments are populated.
    initMinimap();
    renderMinimapBase();
    dom.minimapWrap.hidden = false;
    dom.status.textContent = `Jodhpur loaded: ${nB} buildings, ${roads.length} roads`;
    console.log(`Loaded Jodhpur: ${nB} buildings, ${roads.length} roads.`);
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
