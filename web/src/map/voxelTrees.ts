// VOXEL TREES — the small green blocks the reference scatters along the streets.
//
// WHY EXTRUSIONS AND NOT SPRITES. A symbol/circle layer would be one line of code,
// but symbols do not depth-test against `fill-extrusion` geometry: every tree on a
// street behind a tower would draw straight through the tower. Real extruded boxes
// share the 3D depth buffer with the city, so a tree behind a block is hidden by it
// exactly as it should be. That is the whole reason this module builds polygons.
//
// WHERE THE TREES COME FROM — and what they do NOT claim.
// OpenMapTiles carries no `natural=tree` features, so there is no dataset of real
// street trees to draw. These are DECORATIVE SET DRESSING, deterministically placed
// on the verge of REAL road geometry from the basemap's own `transportation` layer.
// They are part of the same documented decorative layer as the compressed building
// heights (voxelCity.ts) — no transit datum, distance, or timing anywhere in
// GhostBus is derived from or styled like them. A tree here is scenery, never a
// claim that a specific tree exists at that spot.
//
// Placement is keyed off the rounded coordinate, so a given patch of verge always
// gets the same answer no matter which tile or which query it arrived in — trees
// never crawl or flicker as the user pans.

import type { Map as MlMap, ExpressionSpecification, GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl';
import type { VoxelTheme } from './voxelCity';

export const TREE_SOURCE = 'voxel-trees';
export const TREE_BODY_LAYER = 'voxel-tree-body';
export const TREE_CAP_LAYER = 'voxel-tree-cap';
export const TREE_LAYER_IDS = [TREE_BODY_LAYER, TREE_CAP_LAYER] as const;

/** Basemap road layers (mapStyle.ts) the verge is measured from. */
const ROAD_LAYERS = ['road-minor', 'road-med', 'road-major'];

/**
 * TREES ARE SIZED IN SCREEN SPACE, NOT IN METRES — and this is the whole trick.
 *
 * The camera no longer sits at a fixed zoom (see `frameCamera` in MapCard: it fits
 * the marker set, so a phone lands near 15.4 and a desktop pane near 16.1). A fixed
 * metre size therefore cannot work: 8 m of canopy is ~7 px at 16.6 and ~3 px at
 * 15.4, which is why the first pull-back made every tree vanish.
 *
 * Because the tree footprints are rebuilt from scratch on every `idle` anyway, they
 * can simply be built at the size the CURRENT zoom needs. Each tree carries its own
 * height in its feature properties so the extrusion layers read `['get', …]` rather
 * than a constant. The result is a tree that stays about the same size on screen at
 * any zoom — which is exactly how the reference behaves, since it is an illustration
 * with a fixed apparent tree size rather than a scale model.
 *
 * (For the record: the reference's trees are ~10 px on a phone map at roughly
 * 2.5 m/px, i.e. ~25 m across in world terms. Nobody's street tree is 25 m wide.
 * Matching the picture means matching the apparent size, not the botany.)
 */
/**
 * Target canopy width. UNCHANGED at 7.5 — and the reason is worth writing down,
 * because a brief for this pass asked for the opposite.
 *
 * The brief said "the trees are too small; scale them up until they read at
 * reference proportion". Measured, they are already the right size, and there are
 * five times too many of them. The measurement is the same run-length scan applied
 * to both images — horizontal runs of olive pixels across the desktop map region,
 * converted to CSS pixels by each panel's own scale (our 960 px pane; the
 * reference's 744 px pane, x 325..1069):
 *
 *                     median run   p75    p90    olive share of the map region
 *   reference          15.5 px    21.9   29.7        0.98 %
 *   ours (before)      16.0 px    20.0   24.0        4.91 %
 *
 * Canopy width is a match to within half a pixel. What is off by 5x is the COUNT,
 * which is why the frame reads as a forest and the reference reads as a city with
 * trees in it. So the levers moved below are SPACING_PX and KEEP, not this.
 *
 * (Two earlier notes in this file are also corrected by that scan: the "reference
 * trees are ~10 px on a phone" estimate, and "ours covered 1.17% against the
 * reference's 0.53%". Both came from a narrow green-hue filter that threw away the
 * reference's dark olive SIDE faces and kept only its lit tops.)
 *
 * NB on units: `metresPerPixel` below uses the 256-px-tile Web Mercator constant
 * while MapLibre's world is 512-px tiles, so it returns twice the true value and
 * every `_PX` constant in this module therefore renders at twice its nominal size.
 * 7.5 here is ~15 real CSS pixels, which is what the table above measured. Left
 * alone deliberately: the numbers are tuned against the current behaviour, and
 * "fixing" the constant would silently double every tree in the app.
 *
 * SETTLED in DECISIONS §40, and the table above is CORRECTED there. §37 compared
 * canopy widths in CSS pixels across two panes of different scale (the reference's
 * covers 673 m of ground, ours 731 m), and compared an "olive share of the region"
 * that counts pixels rather than canopies. Re-measured at one matched scale with
 * canopies counted as objects, the COUNT was already right (0.92x the reference's
 * per km2) and the SIZE was 0.55x — but per CUBE it was right, and the gap was that
 * the reference builds a canopy from four to six of them. So this constant is
 * unchanged for a third time, and `canopyCubes` below is what moved.
 */
const CANOPY_PX = 7.5;
/** Target gap between trees along a street, in CSS pixels — keeps the density of
 *  the set dressing constant on screen instead of exploding as you zoom in.
 *  RAISED 30 -> 48, half of the thinning; the other half is KEEP. Spread across both
 *  so the verges thin evenly rather than turning into long bare stretches punctuated
 *  by a surviving clump. (A first attempt at 52/0.18 was calibrated on a low-rise
 *  frame with far more road verge per square kilometre than downtown has, and
 *  over-thinned to 0.50% coverage against the reference's 1.02%; a second at 40/0.24
 *  overshot the other way to 1.67%. 48/0.20 is measured at 1.1%.) */
const SPACING_PX = 48;
/** Metre clamps, so an extreme zoom cannot produce a 2 m shrub or a 60 m monolith
 *  (which would read as a building — §C: never focal). */
const CANOPY_MIN_M = 5;
const CANOPY_MAX_M = 30;
const SPACING_MIN_M = 20;
const SPACING_MAX_M = 90;
/** Canopy height and lit cap band, as multiples of its width — a squat blob, taller
 *  than it is wide but well under a one-course (22 m) building. */
const HEIGHT_RATIO = 1.35;
const CAP_RATIO = 0.32;
/** How far off the centreline a tree sits, as a multiple of the canopy width. */
const VERGE_RATIO = 1.4;
/** Hard cap on TREE CENTRES in frame — not on quads. Since `canopyCubes` each centre
 *  now emits five boxes, so this is a ceiling of 2,600 quads across the two extrusion
 *  layers, rebuilt on `idle` only. Measured at the shipped default framing: 227 quads
 *  on desktop and 46 on mobile, and frame timings are p50 4.1 / p95 5.0 ms against
 *  4.2 / 6.2 before the cluster — i.e. unchanged. Left at 520 because it is the tree
 *  COUNT that the density measurement pins (DECISIONS §40), and the count is right. */
const MAX_TREES = 520;
/** Fraction of candidate slots that actually get a tree (hash-gated, not random),
 *  so the spacing never reads as a metronome. */
/** THINNED, 0.3 -> 0.24. See the CANOPY_PX note: the run-length scan put our olive
 *  coverage at 4.91% of the desktop map region against the reference's ~1.0%, so the
 *  count had to come down even though the size was already right. With SPACING_PX 40
 *  this leaves ~48% of the trees, measured at the shipped default framing. Trees are
 *  set dressing here; the city is the subject. */
const KEEP = 0.20;
export const TREE_MIN_ZOOM = 14.8;

interface TreePalette {
  wall: string;
  cap: string;
}
/**
 * MEASURED off `ghostbus-design-reference.png` by pulling every green-hued pixel
 * out of each map and taking the modes. Both themes come out OLIVE-sage, not
 * forest green — which is exactly the "small, muted, numerous, never focal"
 * instruction, and why a saturated green would be wrong here.
 *   dark   sides #363f34…#3e4334   lit tops #555a42
 *   light  sides #8da48a…#99ac90   lit tops #b2c69d…#bac7a8
 *
 * Authored a little more saturated than those raw modes on purpose: the samples are
 * pixel averages that include every antialiased edge against a violet neighbour, so
 * taking them literally produced grey-olive blocks nobody would call a tree. These
 * values are what actually RENDER as the sampled ones — muted, never saturated.
 */
//
// CORRECTED. The "authored a little more saturated than the raw modes" reasoning
// above overshot: measured back off a rendered production frame, our dark trees
// average #415236 — hue 96, saturation 0.21 — against the reference's #4d5540 —
// hue 81, saturation 0.14. Ours were a fresher, greener green over more than
// twice the frame area (1.17% vs 0.53%). These values are the sampled sides/tops
// this comment already records, which is where they should have been.
// RETUNED, and the 1.09x lift that stood here is REVERSED — see DECISIONS §40.
//
// §38 item 13 measured the reference's tree pixels at mean RGB (65, 77, 63) against
// ours at (60, 69, 57) and concluded ours were too dark, so §39 lifted these values
// 1.09x. That measurement used `(G > R+6) && (G > B+6)`, and our LIT CAP #5c6248 is
// (92, 98, 72): G is EXACTLY R+6, and the test is strict, so every lit top face we
// draw was thrown away. It compared our side faces against the reference's sides AND
// tops, which is why ours came out darker — and the lift pushed us further off.
//
// Measured again with one mask over both images (green must lead by 3% of the pixel's
// own mean level, which every tree colour in either theme clears and every non-tree
// surface fails by a wide margin), canopy surface only:
//
//                    canopy mean RGB   lum   hue   sat   sides / lit tops
//   reference          62 / 74 / 62   70.2   121  0.235   #323f38 / #4b5644
//   ours, lifted       78 / 85 / 67   82.0    91  0.213   #3b4235 / #6e7459
//
// Ours were 1.17x too BRIGHT and 30 deg too YELLOW, not too dark.
//
// Solved per FACE, in two passes, because the cluster changes the mix: a single box
// showed 62% side / 38% lit top, a cluster of five shows 46% / 54%, so a correction
// fitted to the canopy MEAN would have been wrong the moment the geometry changed.
// Pass 1 scaled by the mean ratio and re-rendered; pass 2 read each face off that
// render and scaled again. The values below are AUTHORED; what they RENDER as, once
// MapLibre's per-face directional multiply has been applied, is sides #303a33
// (lum 55.6, hue 133) against the reference's #323f38 (lum 59.6, hue 142) and lit
// tops #515d49 (lum 88.8, hue 97) against its #4b5644 (lum 82.3, hue 98) — every
// face within 8% of luminance and 9 deg of hue.
const DARK_TREES: TreePalette = { wall: '#2c3b37', cap: '#3b4535' };
/** In daylight the trees carry nearly all the chroma in the frame — the blocks
 *  are near-white — so this is the one place the light map is allowed real colour. */
const LIGHT_TREES: TreePalette = { wall: '#8ba482', cap: '#b2c79c' };

export function treePalette(theme: VoxelTheme): TreePalette {
  return theme === 'dark' ? DARK_TREES : LIGHT_TREES;
}

const OPACITY_RAMP: ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'],
  TREE_MIN_ZOOM, 0,
  TREE_MIN_ZOOM + 0.5, 1,
];

/** Ground metres per CSS pixel at a Web Mercator zoom. Pure; unit-testable. */
export function metresPerPixel(lat: number, zoom: number): number {
  return (156_543.033_928 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** The tree geometry the given camera needs, in metres. */
export function treeMetrics(lat: number, zoom: number) {
  const mpp = metresPerPixel(lat, zoom);
  const canopy = clamp(CANOPY_PX * mpp, CANOPY_MIN_M, CANOPY_MAX_M);
  return {
    canopy,
    spacing: clamp(SPACING_PX * mpp, SPACING_MIN_M, SPACING_MAX_M),
    verge: canopy * VERGE_RATIO,
    top: canopy * HEIGHT_RATIO,
    capBase: canopy * HEIGHT_RATIO * (1 - CAP_RATIO),
  };
}

// ---------------------------------------------------------------- placement

/** Deterministic 32-bit hash of a quantised coordinate. Pure; unit-testable. */
export function hashCoord(lon: number, lat: number): number {
  // 1e5 ≈ 1.1 m — finer than the spacing, coarse enough that floating-point noise
  // between two tiles covering the same verge lands on the same bucket.
  let h = Math.imul(Math.round(lon * 1e5) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= Math.imul(Math.round(lat * 1e5) ^ 0xc2b2ae35, 0x27d4eb2f);
  h ^= h >>> 15;
  return (h >>> 0) / 0x1_0000_0000;
}

const M_PER_DEG_LAT = 111_320;
const mPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Axis-aligned square footprint of `side` metres centred on (lon, lat). */
function squareAt(lon: number, lat: number, side: number): GeoJSON.Position[][] {
  const dLat = side / 2 / M_PER_DEG_LAT;
  const dLon = side / 2 / Math.max(1, mPerDegLon(lat));
  return [[
    [lon - dLon, lat - dLat],
    [lon + dLon, lat - dLat],
    [lon + dLon, lat + dLat],
    [lon - dLon, lat + dLat],
    [lon - dLon, lat - dLat],
  ]];
}

/**
 * Walk one road line and emit tree centres on alternating verges.
 * Exported for unit testing: pure, no map, no DOM.
 */
export function treesAlongLine(
  line: GeoJSON.Position[],
  out: Map<string, [number, number]>,
  limit: number,
  spacing: number,
  verge: number,
): void {
  let carry = 0; // distance since the last emitted slot, carried across segments
  let side = 1;
  for (let i = 1; i < line.length; i++) {
    if (out.size >= limit) return;
    const [lon1, lat1] = line[i - 1] as [number, number];
    const [lon2, lat2] = line[i] as [number, number];
    const mLon = Math.max(1, mPerDegLon(lat1));
    const dx = (lon2 - lon1) * mLon;
    const dy = (lat2 - lat1) * M_PER_DEG_LAT;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) continue;
    const ux = dx / len, uy = dy / len;
    const px = -uy, py = ux; // unit perpendicular, metres

    for (let t = spacing - carry; t < len; t += spacing) {
      side = -side;
      const ox = ux * t + px * verge * side;
      const oy = uy * t + py * verge * side;
      const lon = lon1 + ox / mLon;
      const lat = lat1 + oy / M_PER_DEG_LAT;
      // Quantise to the hash bucket FIRST, then key on it: two tiles covering the
      // same verge converge on one tree instead of planting two 20 cm apart.
      const qLon = Math.round(lon * 1e5) / 1e5;
      const qLat = Math.round(lat * 1e5) / 1e5;
      const key = `${qLon},${qLat}`;
      if (out.has(key)) continue;
      if (hashCoord(qLon, qLat) > KEEP) continue;
      out.set(key, [qLon, qLat]);
      if (out.size >= limit) return;
    }
    carry = (carry + len) % spacing;
  }
}

/**
 * THE CANOPY IS A CLUSTER OF CUBES, NOT ONE BOX — and that, not `CANOPY_PX`, is
 * what the size measurement was really about. See DECISIONS §40.
 *
 * Measured on both images at one matched scale (0.950 m/px, §32's reference scale),
 * counting canopies as OBJECTS rather than pixels, with the area-weighted median
 * on-screen width — the width of the canopy covering the median canopy pixel:
 *
 *                        canopy width        canopies/km2      canopy colour
 *   reference          31.0 px = 29.4 m          29.9        hue 121, RGB 62/74/62
 *   ours, one box      17.0 px = 16.1 m          27.6        hue  91, RGB 78/85/67
 *
 * The COUNT was already right (0.92x). What was 0.55x is the size — and the reason
 * is structural, exactly as it was for the buildings in §39: the reference's tree is
 * a CLUSTER of four to six green cubes, each one about 15-18 px across, and ours was
 * a single cube of 17 px. Our cube was already the right size; we were drawing one
 * of theirs. So `CANOPY_PX` stays where §31 and §37 put it, and the cluster is what
 * changes — one centre cube at full height plus four lower satellites, giving an
 * overall span of 1.76 canopies against the single box's 1.0.
 */
const CLUSTER_OFFSET = 0.42;   // satellite centre offset, as a fraction of the canopy
const CLUSTER_SIDE = 0.92;     // satellite side, as a fraction of the canopy
/** Satellite heights as a fraction of the centre cube's, dealt by the coordinate hash
 *  so a given verge always grows the same tree and no two neighbours match.
 *
 *  The deal MUST come from a hash the survival gate did not already use. `KEEP` only
 *  lets a centre through when `hashCoord(lon, lat) <= 0.20`, so every tree that
 *  exists has a hash in [0, 0.20] — `floor(h * 4)` is then always 0 and every canopy
 *  in the city is the same stamp. Swapping the arguments decorrelates it: the two
 *  coordinates go into different multiplies inside `hashCoord`, so `hashCoord(lat,
 *  lon)` is unconstrained by the gate while staying just as deterministic. */
const CLUSTER_H = [0.60, 0.72, 0.84, 0.66];

export interface CanopyCube {
  lon: number;
  lat: number;
  side: number;
  top: number;
  capBase: number;
}

/**
 * The cubes of one canopy. Pure; unit-testable. The centre cube is exactly what this
 * module drew before, so a cluster can never be SHORTER or narrower than the single
 * box it replaces.
 */
export function canopyCubes(
  lon: number,
  lat: number,
  m: { canopy: number; top: number; capBase: number },
): CanopyCube[] {
  const out: CanopyCube[] = [
    { lon, lat, side: m.canopy, top: m.top, capBase: m.capBase },
  ];
  const off = m.canopy * CLUSTER_OFFSET;
  const dLat = off / M_PER_DEG_LAT;
  const dLon = off / Math.max(1, mPerDegLon(lat));
  const corners: [number, number][] = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  const h = hashCoord(lat, lon); // NOT (lon, lat) — see the note on CLUSTER_H
  for (let i = 0; i < corners.length; i++) {
    const [sx, sy] = corners[i] as [number, number];
    // rotate the height deal by the tree's own hash so clusters differ from each other
    const k = CLUSTER_H[(i + Math.floor(h * CLUSTER_H.length)) % CLUSTER_H.length] as number;
    out.push({
      lon: lon + sx * dLon,
      lat: lat + sy * dLat,
      side: m.canopy * CLUSTER_SIDE,
      top: m.top * k,
      capBase: m.capBase * k,
    });
  }
  return out;
}

/** Build the tree FeatureCollection for whatever roads are on screen right now. */
function collectTrees(map: MlMap): GeoJSON.FeatureCollection {
  const layers = ROAD_LAYERS.filter((id) => map.getLayer(id));
  if (layers.length === 0) return { type: 'FeatureCollection', features: [] };
  const m = treeMetrics(map.getCenter().lat, map.getZoom());
  let feats: MapGeoJSONFeature[] = [];
  try {
    feats = map.queryRenderedFeatures({ layers }) as MapGeoJSONFeature[];
  } catch {
    return { type: 'FeatureCollection', features: [] };
  }
  const pts = new Map<string, [number, number]>();
  for (const f of feats) {
    if (pts.size >= MAX_TREES) break;
    const g = f.geometry;
    if (g.type === 'LineString') treesAlongLine(g.coordinates, pts, MAX_TREES, m.spacing, m.verge);
    else if (g.type === 'MultiLineString') for (const l of g.coordinates) treesAlongLine(l, pts, MAX_TREES, m.spacing, m.verge);
  }
  const features: GeoJSON.Feature[] = [];
  for (const [lon, lat] of pts.values()) {
    // `h` / `cb` ride on each cube so the two extrusion layers can read them with
    // `['get', …]`: fill-extrusion-height is data-driven, and that is what lets one
    // pair of layers render a canopy whose size tracks the camera.
    for (const c of canopyCubes(lon, lat, m)) {
      features.push({
        type: 'Feature' as const,
        properties: { h: +c.top.toFixed(2), cb: +c.capBase.toFixed(2) },
        geometry: { type: 'Polygon' as const, coordinates: squareAt(c.lon, c.lat, c.side) },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------- install

/**
 * Add (or repaint) the tree layers. `before` is the same insertion point the city
 * uses, so trees sit under every GhostBus overlay and can never hide the route,
 * a stop, a vehicle or the You beacon.
 */
export function addVoxelTreeLayers(map: MlMap, theme: VoxelTheme, before?: string): void {
  const p = treePalette(theme);
  if (!map.getSource(TREE_SOURCE)) {
    map.addSource(TREE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }
  if (!map.getLayer(TREE_BODY_LAYER)) {
    map.addLayer({
      id: TREE_BODY_LAYER, type: 'fill-extrusion', source: TREE_SOURCE, minzoom: TREE_MIN_ZOOM,
      paint: {
        'fill-extrusion-color': p.wall,
        'fill-extrusion-base': 0,
        'fill-extrusion-height': ['coalesce', ['get', 'cb'], 8],
        'fill-extrusion-opacity': OPACITY_RAMP,
        'fill-extrusion-vertical-gradient': false,
      },
    }, before);
  }
  if (!map.getLayer(TREE_CAP_LAYER)) {
    map.addLayer({
      id: TREE_CAP_LAYER, type: 'fill-extrusion', source: TREE_SOURCE, minzoom: TREE_MIN_ZOOM,
      paint: {
        'fill-extrusion-color': p.cap,
        'fill-extrusion-base': ['coalesce', ['get', 'cb'], 8],
        'fill-extrusion-height': ['coalesce', ['get', 'h'], 12],
        'fill-extrusion-opacity': OPACITY_RAMP,
        'fill-extrusion-vertical-gradient': false,
      },
    }, before);
  }
  setVoxelTreeTheme(map, theme);
}

export function setVoxelTreeTheme(map: MlMap, theme: VoxelTheme): void {
  if (!map.getLayer(TREE_BODY_LAYER)) return;
  const p = treePalette(theme);
  map.setPaintProperty(TREE_BODY_LAYER, 'fill-extrusion-color', p.wall);
  map.setPaintProperty(TREE_CAP_LAYER, 'fill-extrusion-color', p.cap);
}

export function hasVoxelTreeLayers(map: MlMap): boolean {
  return !!map.getLayer(TREE_BODY_LAYER) && !!map.getLayer(TREE_CAP_LAYER);
}

export function removeVoxelTreeLayers(map: MlMap): void {
  for (const id of TREE_LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(TREE_SOURCE)) {
    try { map.removeSource(TREE_SOURCE); } catch { /* a layer still references it; next call reuses it */ }
  }
}

/**
 * Re-plant for the current viewport. Cheap, but not free — call it when the camera
 * SETTLES (`idle`), never per frame. A no-op when the layers are absent.
 */
export function syncVoxelTrees(map: MlMap): number {
  if (!hasVoxelTreeLayers(map)) return 0;
  if (map.getZoom() < TREE_MIN_ZOOM) {
    (map.getSource(TREE_SOURCE) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
    return 0;
  }
  const fc = collectTrees(map);
  (map.getSource(TREE_SOURCE) as GeoJSONSource | undefined)?.setData(fc);
  return fc.features.length;
}
