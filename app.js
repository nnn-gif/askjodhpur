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
const WALK_SPEED     = 4.5;   // brisk pace (~16 km/h) — zippy enough to enjoy the city
const RUN_SPEED      = 14.0;  // sprint (hold Shift) — covers the 3 km map quickly
const PLAYER_RADIUS  = 0.4;   // collision sphere radius
const GRAVITY        = 20.0;  // m/s^2, used only if we add steps/jumps later

// Third-person view tuning. The camera sits this far BEHIND the avatar and
// this high above the avatar's feet, and looks at the avatar's upper body.
// See README "Character / third-person".
const THIRD_PERSON_DIST   = 4.5;   // camera distance behind the avatar, meters
const THIRD_PERSON_HEIGHT = 2.2;   // camera height above avatar feet, meters
const AVATAR_LOOK_HEIGHT  = 1.2;   // where the camera aims on the avatar (chest)

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

// Fetch named gates + major landmarks for the "destinations" panel — the list
// of places the user can click to teleport to. We query OSM for the things that
// make useful navigation targets in a historic city like Jodhpur: city gates
// (the old-city "pol" gates), the fort, palaces, named attractions, and major
// temples. Results are filtered to those with a name and converted to scene
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
    } catch (e) { /* try next mirror */ }
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

// Roads: draw each highway as a FLAT RIBBON (a quad) lying on the ground, with
// width based on road type. Earlier these were 1-pixel lines, which vanished
// against the sandy ground at any distance — making the street network, the
// thing you actually navigate by, unreadable. Ribbons make roads a real,
// visible part of the world.
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
// for the minimap to draw.
const roadSegments = [];

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

function buildRoads(roads) {
  // Group vertices by color so we can build one BufferGeometry per material
  // (cheap to render; avoids one draw call per road).
  const byColor = Object.create(null);   // colorHex -> { verts: [], idx: [], mat: null }
  const ROAD_Y = 0.06;                   // just above ground to prevent z-fighting

  for (const r of roads) {
    const g = r.geometry;
    if (!g || g.length < 2) continue;
    const tags = r.tags || {};
    const width = roadWidth(tags);
    const half = width / 2;
    const color = roadColor(tags);
    let bucket = byColor[color];
    if (!bucket) {
      bucket = { verts: [], idx: [], color };
      byColor[color] = bucket;
    }

    for (let i = 0; i < g.length - 1; i++) {
      const [x1, z1] = lonLatToXY(g[i].lon, g[i].lat);
      const [x2, z2] = lonLatToXY(g[i+1].lon, g[i+1].lat);
      roadSegments.push([x1, z1, x2, z2]);

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
    const mesh = new THREE.Mesh(geo, roadMaterial(parseInt(color)));
    scene.add(mesh);
  }
}

// Cache materials per color so roads of the same type share one material.
const _roadMatCache = Object.create(null);
function roadMaterial(color) {
  if (!_roadMatCache[color]) {
    _roadMatCache[color] = new THREE.MeshBasicMaterial({ color, roughness: 1 });
  }
  return _roadMatCache[color];
}

// -----------------------------------------------------------------------------
// 5b. Minimap (top-down map)
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
//   - Zoom: the minimap shows a ~160 m radius around the player. The full 3 km
//     city in 200 px would be ~15 m/px, too coarse to read locally; a player-
//     centred zoomed view is far more useful for "where am I right now".

const MINIMAP = {
  el: null,          // visible <canvas>
  ctx: null,         // its 2D context
  base: null,        // offscreen canvas with the static city map
  baseCtx: null,
  size: 200,         // pixel size (square)
  viewMeters: 160,   // world meters across the visible window at the player
};

function initMinimap() {
  MINIMAP.el = document.getElementById('minimap');
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

  // Stash the world→pixel transform params for the per-frame draw.
  MINIMAP.transform = { minX, maxZ, PX_PER_M };
}

// Per-frame minimap draw: blit the static map centred on the player, then draw
// the player marker. px,py = player's pixel location in the offscreen image.
function drawMinimap(playerX, playerZ, heading) {
  const { minX, maxZ, PX_PER_M } = MINIMAP.transform;
  const playerPX = (playerX - minX) * PX_PER_M;
  const playerPY = (maxZ - playerZ) * PX_PER_M;

  // Source rectangle in the offscreen image: a window around the player, sized
  // so that `viewMeters` of world spans the visible canvas.
  const halfWorld = MINIMAP.viewMeters / 2;
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
  const S = MINIMAP.size;
  ctx.fillStyle = '#c9b08a';
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(MINIMAP.base, sx, sy, sw, sh, 0, 0, S, S);

  // Player marker: a triangle pointing in the facing direction. `heading` is
  // the camera yaw in radians (0 = looking toward -Z = north). On the minimap,
  // north is up, so we convert yaw to a 2D heading: north (looking -Z) → up.
  //   Forward direction in world XZ for yaw y: (sin y, -cos y) on (X, Z).
  //   On the minimap image, +X is right and +Z(north) is up → forward pixel
  //   vector is (sin y, -(-cos y)) = (sin y, cos y)... simplify below.
  const cx = S / 2, cy = S / 2;
  // Convert world forward to image forward. World forward (X,Z) = (sin y, -cos y).
  // Image: X→right, Z→up means image-y = -Z. So image forward = (sin y, cos y).
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
// 5c. Character avatar (third-person, Vice-City style)
// -----------------------------------------------------------------------------
//
// A small procedural humanoid built entirely from THREE primitives — no
// external model files, no textures, no network dependency. Toggle into/out of
// third-person with the V key (see the keydown handler in the controls
// section). The figure has pivotable limbs so we can run a simple walk cycle.
//
// Why procedural blocks: it matches the demo's "no build step, no assets"
// philosophy and can never 404. The geometry is intentionally chunky/low-poly,
// which reads fine at the small size the avatar occupies on screen.

// Module state for the character. `avatar` is built lazily on the first toggle
// to V so first-person play pays nothing until the user opts in.
let thirdPerson = false;     // current view mode
let avatar = null;           // the THREE.Group humanoid (null until built)

// A canonical player position vector that BOTH view modes share. The frame
// loop moves this (with collision), then positions the camera relative to it.
// In first-person the camera sits at playerPos + eye height; in third-person
// the camera sits behind/above and the avatar mesh sits at playerPos.
// Initialized to the spawn point at feet level (y=0).
const playerPos = new THREE.Vector3(1, 0, -24);

// Read the player's yaw (heading) directly from the camera's world direction.
// This is authoritative in BOTH control modes: in pointer-lock mode the
// `yaw` variable is stale (PointerLockControls writes the quaternion), so we
// derive yaw from the camera instead. Same formula the minimap already uses.
// Returns radians where 0 = facing -Z (north). Forward in world XZ for this
// yaw is (sin yaw, 0, -cos yaw).
const _fwdTmp = new THREE.Vector3();
function getPlayerYaw() {
  camera.getWorldDirection(_fwdTmp);
  return Math.atan2(_fwdTmp.x, -_fwdTmp.z);
}

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
// 5d. Destinations panel (teleport to gates + landmarks)
// -----------------------------------------------------------------------------
//
// A collapsible list of Jodhpur's historic gates and major landmarks, fetched
// from OpenStreetMap. Click a name and the player teleports there instantly —
// useful for getting oriented in a dense city where walking between landmarks
// takes a while. See README "Destinations / teleport".

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

// Build the destinations panel from a list of landmarks. Each item is a button
// that teleports the player and (if in third-person) keeps the avatar in sync.
function populateDestinations(landmarks) {
  const wrap = document.getElementById('destinations');
  const list = document.getElementById('destList');
  const count = document.getElementById('destCount');
  if (!wrap || !list) return;
  if (!landmarks.length) { wrap.hidden = true; return; }

  list.innerHTML = '';
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
      const ok = teleportTo(lm.x, lm.z);
      status.textContent = ok
        ? `Teleported to ${lm.name}`
        : `Couldn't land at ${lm.name} (blocked) — try another spot`;
      // Keep the place-name cache fresh.
      currentPlace = lm.name;
    });
    list.appendChild(btn);
  }
  count.textContent = `(${landmarks.length})`;
  wrap.hidden = false;

  // Collapsible header.
  const header = document.getElementById('destHeader');
  header.addEventListener('click', () => wrap.classList.toggle('collapsed'));
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
// Toggle between first- and third-person view. Shared by the V key and the
// on-screen #viewToggle button (the button is essential on touch devices and
// in webviews that swallow synthetic key events). Builds the avatar lazily on
// first toggle so first-person play pays nothing until the user opts in.
function toggleView() {
  if (!active) return;
  if (!avatar) {
    avatar = buildAvatar();
    scene.add(avatar);
  }
  thirdPerson = !thirdPerson;
  avatar.visible = thirdPerson;
  status.textContent = thirdPerson
    ? 'Third-person view — V to switch back'
    : 'First-person view — V for third-person';
  const btn = document.getElementById('viewToggle');
  if (btn) btn.textContent = thirdPerson ? '🚶 Third person (V)' : '👁 First person (V)';
}

addEventListener('keydown', e => {
  keys[e.code] = true;
  // V switches view. Built and toggled inside toggleView().
  if (e.code === 'KeyV') toggleView();
});
addEventListener('keyup',   e => { keys[e.code] = false; });

// Live WASD input indicator (#inputDebug). Reflects the `keys` state each frame
// so you can see whether key events are reaching the page. If a key never
// lights up while you press it, that key isn't being delivered (focus issue,
// webview input blocking, or stale cached code).
const inputSpans = {};
function setupInputDebug() {
  const wrap = document.getElementById('inputDebug');
  if (!wrap) return;
  for (const el of wrap.querySelectorAll('span[data-k]')) {
    inputSpans[el.getAttribute('data-k')] = el;
  }
  wrap.hidden = false;
}
function updateInputDebug() {
  for (const code in inputSpans) {
    const el = inputSpans[code];
    if (keys[code]) el.classList.add('on');
    else el.classList.remove('on');
  }
}

// Start the player on a real street. The naive origin (0,0,0) lands inside a
// building's footprint in dense central Jodhpur and traps the player. This
// point was verified to sit on the "Layakam Mohalla" lane with ~2 m of
// clearance to the nearest building — a genuinely walkable spot. The canonical
// playerPos (defined with the avatar code) holds the feet-level position;
// camera placement happens each frame from it, so we just sync the camera here.
camera.position.set(playerPos.x, EYE_HEIGHT, playerPos.z);

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
  const viewBtn = document.getElementById('viewToggle');
  if (viewBtn) {
    viewBtn.hidden = false;
    viewBtn.addEventListener('click', toggleView);
  }
  setupInputDebug();
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
  // Show the view-toggle button now that the demo is interactive.
  const viewBtn = document.getElementById('viewToggle');
  if (viewBtn) {
    viewBtn.hidden = false;
    viewBtn.addEventListener('click', toggleView);
  }
  setupInputDebug();
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

    // Mirror current key state to the on-screen WASD indicator.
    updateInputDebug();

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

    // --- axis-separated collision resolution on the canonical player position ---
    // We move `playerPos` (shared by both view modes) instead of the camera
    // directly, then place the camera relative to playerPos based on mode.
    const tryX = playerPos.clone(); tryX.x += move.x;
    if (!resolveCollision(tryX)) playerPos.x = tryX.x;
    const tryZ = playerPos.clone(); playerPos.z += move.z;
    if (!resolveCollision(tryZ)) playerPos.z = tryZ.z;

    const moving = (forward !== 0 || strafe !== 0);

    // --- place the camera + avatar based on view mode ---
    // FIRST-PERSON: identical to before the character feature existed — camera
    //   at eye height with a subtle head-bob while walking. Numerically the
    //   same EYE_HEIGHT and ±4 cm bob amplitude/frequency.
    // THIRD-PERSON: camera behind/above the avatar, looking at its chest. No
    //   head-bob; instead the walk cycle (animateAvatar) drives the limbs.
    try {
      if (thirdPerson) {
        // Position the avatar at the player's feet, facing where the camera
        // looks (Vice-City style: character turns to face the view forward).
        const pyaw = getPlayerYaw();
        avatar.position.set(playerPos.x, 0, playerPos.z);
        // World forward (X,Z) for this yaw = (sin yaw, -cos yaw). The avatar
        // model faces +Z by default (no rotation = looking +Z). We need it to
        // face the camera's forward, so rotate about Y by the angle that maps
        // +Z → forward. That yaw-about-Y is (yaw - π/2) in our convention; but
        // simplest: set rotation.y so the model's +Z aligns with forward.
        // rotation.y = atan2(fwdX, fwdZ) does exactly that.
        avatar.rotation.y = Math.atan2(Math.sin(pyaw), -Math.cos(pyaw)) + Math.PI;
        // The "+π" flips because the model's "front" is -Z in its local frame
        // after the limb layout; empirically the figure faces the camera's
        // forward with this offset.
        animateAvatar(dt, moving, speed);

        // Camera: behind the player (opposite of forward) and above the feet.
        const camTarget = new THREE.Vector3(
          playerPos.x - dir.x * THIRD_PERSON_DIST,
          THIRD_PERSON_HEIGHT,
          playerPos.z - dir.z * THIRD_PERSON_DIST,
        );
        camera.position.copy(camTarget);
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
    } catch (camErr) { /* never let camera/avatar placement kill movement */ }

    // `pos` alias used by HUD/minimap below — the player's current location.
    const pos = playerPos;

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

    // --- minimap: draw the player-centred top-down view ---
    // Derive heading from the camera's world direction so it works in both
    // pointer-lock and fallback modes. Forward in world XZ = (sin yaw, -cos yaw).
    try {
      const fwd = new THREE.Vector3();
      camera.getWorldDirection(fwd);
      const heading = Math.atan2(fwd.x, -fwd.z);  // yaw where 0 = north (-Z)
      drawMinimap(pos.x, pos.z, heading);
    } catch (mmErr) { /* never let minimap kill the frame loop */ }
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
    // Build the minimap now that colliders + roadSegments are populated.
    initMinimap();
    renderMinimapBase();
    document.getElementById('minimapWrap').hidden = false;
    status.textContent = `Jodhpur loaded: ${nB} buildings, ${roads.length} roads`;
    console.log(`Loaded Jodhpur: ${nB} buildings, ${roads.length} roads.`);
    animate();

    // Seed the HUD with the spawn location's place name so the label isn't
    // empty for the first few seconds before the movement-triggered lookup
    // would have fired. The spawn point is the ORIGIN in lat/lon.
    refreshPlace(ORIGIN.lat, ORIGIN.lon);

    // Fetch gates + landmarks for the destinations panel. Run AFTER the scene
    // is live so it can't delay the initial render; it's a small, separate
    // query and any failure is non-fatal (the panel just stays hidden).
    fetchLandmarks().then(landmarks => {
      populateDestinations(landmarks);
      if (landmarks.length) {
        console.log(`Loaded ${landmarks.length} destinations.`);
      }
    }).catch(err => console.warn('Landmarks fetch failed:', err.message));

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
