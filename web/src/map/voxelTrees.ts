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
/** Target canopy width in CSS pixels. Small enough to stay texture, big enough to
 *  read as green rather than as grit. */
const CANOPY_PX = 7.5;
/** Target gap between trees along a street, in CSS pixels — keeps the density of
 *  the set dressing constant on screen instead of exploding as you zoom in. */
const SPACING_PX = 30;
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
/** Hard cap on trees in frame. Two cheap extrusion layers over a few hundred tiny
 *  quads costs almost nothing; ten thousand would not. */
const MAX_TREES = 520;
/** Fraction of candidate slots that actually get a tree (hash-gated, not random),
 *  so the spacing never reads as a metronome. */
const KEEP = 0.55;
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
const DARK_TREES: TreePalette = { wall: '#2a3a28', cap: '#4a5c37' };
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
  return {
    type: 'FeatureCollection',
    // `h` / `cb` ride on the feature so the two extrusion layers can read them with
    // `['get', …]`: fill-extrusion-height is data-driven, and that is what lets one
    // pair of layers render a tree whose size tracks the camera.
    features: [...pts.values()].map(([lon, lat]) => ({
      type: 'Feature' as const,
      properties: { h: +m.top.toFixed(2), cb: +m.capBase.toFixed(2) },
      geometry: { type: 'Polygon' as const, coordinates: squareAt(lon, lat, m.canopy) },
    })),
  };
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
