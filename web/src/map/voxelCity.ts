// VOXEL CITY — the facade the app talks to, plus the shared height maths and the
// diorama camera. The pixels are produced by `voxelMesh.ts`, a MapLibre custom layer
// that renders Three.js inside MapLibre's own WebGL context.
//
// THIS FILE USED TO BE THE RENDERER. It built two `fill-extrusion` layers — a wall
// body plus a brighter "cap band" — out of MapLibre style expressions. That version
// is gone; `voxelMesh.ts`'s header records exactly which four things fill-extrusion
// structurally could not do and, just as importantly, which two commonly-blamed
// things were NOT its fault (it does shade per face normal, and MapLibre v6 can
// flatten its perspective via `setVerticalFieldOfView`).
//
// What survives here, because it was right and is still used:
//   * the height compression + quantisation maths (`quantizeHeightM`), which is what
//     makes every roof in the viewport land on one shared lattice;
//   * the zoom-keyed generalisation floor (`minHeightForZoom`) and the zoom height
//     gain (`zoomHeightGain`), both of which hold the diorama's apparent proportions
//     constant as `frameCamera` moves the camera;
//   * the camera (`applyVoxelCamera`), now with the narrow field of view that pushes
//     the projection toward the reference's axonometric look;
//   * the quality gate, the insertion point, and the basemap-label lift.
//
// Integration is unchanged: `addVoxelCityLayers(map, theme)` after the style loads,
// `removeVoxelCityLayers(map)` to take it back out.

import type { Map as MlMap } from 'maplibre-gl';
import { createVoxelMeshLayer, VOXEL_MESH_LAYER, type VoxelMeshLayer } from './voxelMesh';

/** Mirrors `Quality` in web/src/store.ts without importing it (keeps this module
 *  dependency-free so it can be unit-tested outside the app). */
export type VoxelQuality = 'auto' | 'full' | 'reduced' | 'lite';
export type VoxelTheme = 'dark' | 'light';

export { VOXEL_MESH_LAYER };
/** Kept as an array for the handful of callers that reason about layer order. */
export const VOXEL_LAYER_IDS = [VOXEL_MESH_LAYER] as const;

/** The flat 2D building fill from mapStyle.ts. Hidden while the city is in 3D (it
 *  would z-fight the footprints), restored on removal. */
const FLAT_BUILDING_LAYER = 'building';

/** GhostBus overlays that must NEVER be occluded by a building. The city is
 *  inserted beneath the first of these that exists, so MapLibre draws the route /
 *  stops / vehicles / walk path in front of every block. */
const OVERLAY_LAYER_IDS = [
  'walk-shadow', 'walk-line', 'route-shadow', 'route-casing', 'route-line', 'route-stops', 'vehicles',
];

/**
 * Where the basemap's own street names get lifted to. They must end up ABOVE the
 * red route line, not below it. They stop below `vehicles` / `marker-blockers`, so a
 * street name can never cover a vehicle sprite, and `marker-blockers` stays the last
 * symbol layer (it has to be, to win collisions against the DOM marker cards).
 */
const LABEL_ABOVE_LAYER_IDS = ['vehicles', 'marker-blockers'];

// ---------------------------------------------------------------- geometry

/**
 * Metre step every roof snaps to. This is the whole voxel trick: every roof in the
 * viewport lands on the same lattice, so the skyline is a staircase of block courses
 * instead of a smooth histogram of real-world heights.
 *
 * At pitch p, a footprint of side s projects to a roof of area s^2*cos(p) and two
 * visible walls of area 2*s*h*sin(p), so wall/roof = 2*(h/s)*tan(p). Downtown
 * Toronto's OSM footprints are whole-block developments (s ~ 100 m), and 24 m with
 * the zoom gain lands that ratio near the reference's.
 *
 * Note what this does NOT do: it does not add, subdivide or merge a single
 * footprint. Every block is one real OSM building.
 */
export const HEIGHT_STEP_M = 24;
/** Buildings with no OSM height at all. */
export const DEFAULT_HEIGHT_M = 8;
/**
 * Height COMPRESSION, not exaggeration: `base + k*sqrt(h)`.
 *
 * Toronto's downtown is 200 m towers standing next to 6 m storefronts. Extruded
 * literally that is a bed of nails, which is the opposite of the reference — its
 * blocks are chunky and live in a narrow band of 1-2 courses. A square root pulls
 * the top of the range down hard while leaving the bottom alone. Against the real
 * render_height values in these tiles (4, 5, 8, 11, 30, 55, 132, 174 m) and a 24 m
 * step, that quantises to 1 / 1 / 1 / 1 / 1 / 2 / 2 / 2 courses.
 *
 * Two earlier attempts overshot in the same direction and both rendered as, in a
 * reviewer's words, "a canyon of towers": base 6 / k 4.2 / step 26, and step 31 at
 * pitch 56. At pitch ~50 a foreground block's wall grows much faster on screen than
 * its roof does, so the honest lever for wall area is the camera, not the height.
 *
 * This is a deliberate, documented distortion of building height — a decorative
 * layer. No transit datum anywhere in the app is styled this way.
 */
export const HEIGHT_BASE_M = 5;
export const HEIGHT_SQRT_K = 3.6;
/** Below this the city is a texture, not architecture: not worth the draw calls. */
export const VOXEL_MIN_ZOOM = 14.6;

/**
 * Diorama camera.
 *
 * COUNTERINTUITIVE: in MapLibre, LARGER pitch means MORE horizontal, not more
 * dramatic. The reference is near-isometric — its cubes show a big top face over two
 * short side faces, which is a comparatively TOP-DOWN camera. At pitch 75 the frame
 * fills with facades and a horizon and stops reading as a diorama entirely.
 *
 * 48 IS NOW MEASURED RATHER THAN JUDGED, which is what settles three passes of
 * 58 -> 50 -> 52 argument. The reference is an orthographic render, so its ground
 * plane's projection is exact: a horizontal direction at plan-angle phi from
 * screen-right projects to a screen slope of `tan(phi) * sin(e)`, where e is the
 * camera's elevation above the horizon. A gradient-orientation histogram over the
 * reference's desktop map region has its two peaks at slope +/-0.675 and they are
 * symmetric, which forces phi = 45 deg and therefore `sin(e) = 0.675`, e = 42.5 deg.
 * MapLibre's pitch is measured from straight down, so pitch = 90 - e = 47.5.
 */
export const VOXEL_PITCH = 48;
/**
 * MapLibre's default `maxPitch` is 60 — any larger value passed to `setPitch` is
 * silently clamped, which makes a "steeper camera" change look like it did nothing.
 * `applyVoxelCamera` raises the ceiling first and `resetVoxelCamera` puts it back.
 */
export const VOXEL_MAX_PITCH = 78;
/**
 * Diorama BEARING. In the reference the street grid runs diagonally across the frame
 * and every block presents two visible walls, which is what makes them read as cubes
 * rather than as facades seen head-on. Toronto's grid is already ~17 deg off true
 * north, so King St draws at about -10 deg with the map north-up; -18 puts it at
 * ~-28 deg.
 *
 * The map has no compass rose, so this is a deliberate, documented departure from
 * north-up.
 */
export const VOXEL_BEARING = -18;
/**
 * NARROW VERTICAL FIELD OF VIEW — the lever that makes the projection near-isometric,
 * and one of the two things on the "fill-extrusion cannot do this" list that turned
 * out to be false. MapLibre v6 ships `setVerticalFieldOfView`, and
 * `cameraToCenterDistance` is `0.5 * height / tan(fov/2)`: narrowing the FOV
 * therefore pushes the camera BACK while holding the scale at the map centre exactly
 * where it was. Nothing about pan, zoom, pitch or rotate changes; only the
 * perspective gradient across the frame does.
 *
 * MapLibre's default is 36.87 deg. At that FOV the nearest blocks in a pitched frame
 * are several times the on-screen size of the ones a street away, which is precisely
 * the complaint three previous passes tried to fix by lowering the pitch. 16 deg cuts
 * the convergence to roughly a quarter of that and leaves block size near-uniform
 * from the bottom of the frame to the top, which is what the reference shows.
 *
 * Not taken to ~1 deg (i.e. effectively orthographic) on purpose: MapLibre derives
 * its near/far planes from the FOV, and a pinhole that narrow pushes the camera far
 * enough back to start costing depth-buffer precision between abutting blocks.
 */
export const VOXEL_FOV_DEG = 16;
/** MapLibre's own default, restored when the diorama is switched off. */
export const DEFAULT_FOV_DEG = 36.87;
/**
 * The zoom the diorama actually reads at. This is the honest generalisation lever:
 * these tiles carry no footprint area, so "fewer, bigger blocks" can only come from
 * showing less ground, never from merging footprints into buildings that do not exist.
 *
 * MEASURED against the reference rather than guessed: its walk path is labelled
 * "4 min walk" (~250 m) and spans ~210 px of a ~1030 px map pane, which puts the
 * reference camera at ~0.95 m/px — z16.4 at Toronto's latitude — and at that scale
 * its cubes are ~110 px, one city block each. 17.0 was tried and rejected: two
 * whole-block footprints fill the viewport and the street grid disappears.
 */
export const VOXEL_DIORAMA_ZOOM = 16.6;

/**
 * Zoom-keyed minimum building height, in metres. Standard cartographic
 * generalisation — drop the small stuff when it would render as noise, show
 * everything once there is room for it. Nothing is invented; some real buildings are
 * omitted at wide zooms, exactly as every vector basemap already does with its own
 * feature filters.
 *
 * The VALUE was swept at the real default framing (King & Spadina) against §32's
 * statistic — HSV value deciles over the desktop map region, computed identically on
 * the reference sheet and on our own frame:
 *
 *                v<.1   .1-.2   .2-.3   .3-.4   .4-.5   >.5    meanS  meanV   |dev|
 *   reference     0.1    25.2    41.9    15.9    12.4    4.5   0.566  0.284      -
 *   floor  4      0.1    22.0    36.0    12.2    26.9    2.9   0.541  0.302   27.3
 *   floor  8      0.1    28.6    36.7    10.4    21.4    2.9   0.554  0.287   23.1
 *   floor 14      0.1    33.6    35.9     9.3    18.1    3.1   0.561  0.278   26.7
 *   floor 20      0.1    40.4    35.3     8.2    13.3    2.8   0.574  0.261   30.4
 *
 * It is a real trade rather than a monotone dial: raising the floor pulls the .4-.5
 * band down towards the reference, because the buildings it removes are small ones
 * that present almost pure ROOF — and pushes the darkest band up, because what is
 * left behind is ground. 8 m is the minimum of that trade.
 *
 * NOTE — this used to be a MapLibre `['step', ['zoom'], ...]` expression inside a
 * layer FILTER, and the STEP BOUNDARY was a bug that survived three passes of tuning
 * the number above it. MapLibre evaluates `['zoom']` in a filter at the INTEGER zoom
 * only; `frameCamera` lands the diorama between z15.4 and z16.0, which floors to 15,
 * so a boundary at 15.2 meant the whole diorama took the wide-zoom branch and a 22 m
 * floor. Downtown that is survivable; framed on a low-rise neighbourhood it deleted
 * the neighbourhood outright. Evaluating it in JS at the real fractional zoom, as
 * below, removes the whole class of bug.
 */
export function minHeightForZoom(zoom: number): number {
  if (zoom < VOXEL_MIN_ZOOM) return 22; // below the diorama: only substantial massing
  if (zoom < 17.4) return 8;
  return 0; // close in, every building is back
}

/**
 * ZOOM HEIGHT GAIN — keeps the blocks reading as CUBES at every framing.
 *
 * `frameCamera` fits the marker set, so the camera is not at one fixed zoom: a phone
 * lands near 15.4, a desktop pane near 16.1, and a user can zoom anywhere. A block's
 * footprint shrinks with zoom but a fixed metre height shrinks with it too — so at
 * 15.4 a 24 m block over a 40 px footprint is 8 px tall and the city flattens into
 * pancakes, while at 18 the same block is a tower. This multiplier holds the apparent
 * height-to-footprint ratio roughly constant, which is what a diorama does when you
 * step back from it.
 */
const GAIN_STOPS: [number, number][] = [
  [15.0, 2.4],
  [16.0, 1.5],
  [16.8, 1.0],
  [18.0, 0.75],
];

export function zoomHeightGain(zoom: number): number {
  const first = GAIN_STOPS[0];
  const last = GAIN_STOPS[GAIN_STOPS.length - 1];
  if (zoom <= first[0]) return first[1];
  if (zoom >= last[0]) return last[1];
  for (let i = 1; i < GAIN_STOPS.length; i++) {
    const [z1, g1] = GAIN_STOPS[i];
    if (zoom <= z1) {
      const [z0, g0] = GAIN_STOPS[i - 1];
      return g0 + ((g1 - g0) * (zoom - z0)) / (z1 - z0);
    }
  }
  return 1;
}

/**
 * The LATTICE height in metres a given OSM height quantises to (excluding the zoom
 * gain, which needs a live camera). Pure, and the single source of truth for block
 * height — `voxelMesh.ts` calls exactly this.
 */
export function quantizeHeightM(renderHeight: number | null | undefined, flatten = 1): number {
  const raw = HEIGHT_BASE_M + HEIGHT_SQRT_K * Math.sqrt(Math.max(1, renderHeight ?? DEFAULT_HEIGHT_M));
  return flatten * HEIGHT_STEP_M * Math.max(1, Math.ceil(raw / HEIGHT_STEP_M));
}

/** How much the city collapses when a route is focused: unrelated massing drops to a
 *  third of its height and desaturates toward the ground so the red route line and
 *  its stop dots own the frame. */
export const FOCUS_FLATTEN = 0.34;

// ---------------------------------------------------------------- quality gate

/**
 * Resolve `auto` against the device. A 3D city is a real GPU cost, so `auto` only
 * reaches `full` on a machine that looks like it can hold 60fps: enough cores, enough
 * RAM, and no data-saver hint. Conservative on purpose — the wrong answer here is a
 * janky map, not a flat one.
 */
export function resolveQuality(pref: VoxelQuality): Exclude<VoxelQuality, 'auto'> {
  if (pref !== 'auto') return pref;
  if (typeof navigator === 'undefined') return 'reduced';
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  if (saveData) return 'lite';
  if (cores <= 3 || mem <= 2) return 'lite';
  if (cores <= 5 || mem <= 4) return 'reduced';
  return 'full';
}

/** The 3D city runs at Full quality ONLY. Reduced and Lite get the flat map. */
export function voxelCityAllowed(pref: VoxelQuality): boolean {
  return resolveQuality(pref) === 'full';
}

// ---------------------------------------------------------------- install

export interface VoxelCityOptions {
  /** Vector source id in the current style. Defaults to mapStyle.ts's `omt`. */
  sourceId?: string;
  /** Source layer within it. OpenMapTiles calls it `building`. */
  sourceLayer?: string;
  /** Start muted + flattened (a route is already focused when the city is added). */
  routeFocused?: boolean;
}

interface VoxelState {
  theme: VoxelTheme;
  routeFocused: boolean;
  layer: VoxelMeshLayer;
  flatBuildingWasVisible: boolean;
}

const STATE = new WeakMap<MlMap, VoxelState>();

/**
 * Where to slot the city so it can never occlude anything that matters.
 * Preference order:
 *   1. the first GhostBus overlay (walk path / route / stops / vehicles);
 *   2. failing that, the first symbol layer, so basemap labels still read over it.
 * Returning `undefined` (append on top) is the last resort only.
 */
export function voxelInsertionPoint(map: MlMap): string | undefined {
  return insertionPoint(map);
}

function labelInsertionPoint(map: MlMap): string | undefined {
  for (const id of LABEL_ABOVE_LAYER_IDS) if (map.getLayer(id)) return id;
  return undefined;
}

function insertionPoint(map: MlMap): string | undefined {
  for (const id of OVERLAY_LAYER_IDS) if (map.getLayer(id)) return id;
  const layers = map.getStyle()?.layers ?? [];
  for (const l of layers) {
    if (l.type === 'symbol' && l.id !== VOXEL_MESH_LAYER) return l.id;
  }
  return undefined;
}

/**
 * Move every basemap symbol layer above the city (but still below the GhostBus
 * overlays, so a street name can never cover the route or a vehicle).
 *
 * Not undone by `removeVoxelCityLayers`, and deliberately so: labels-over-buildings
 * is the correct order in the flat map too, so there is nothing to restore.
 */
function liftBasemapLabels(map: MlMap, basemapSource: string, before: string | undefined): void {
  const layers = map.getStyle()?.layers ?? [];
  for (const l of layers) {
    // BASEMAP symbol layers only, identified by their SOURCE — not "every symbol
    // layer that isn't one of ours". An earlier version used a name blocklist and
    // quietly relocated MapCard's `marker-blockers`, which has to stay the topmost
    // symbol layer to win collisions against the DOM marker cards.
    if (l.type !== 'symbol') continue;
    if (!('source' in l) || l.source !== basemapSource) continue;
    try { map.moveLayer(l.id, before); } catch { /* layer vanished mid-swap */ }
  }
}

/**
 * Add the voxel city to a live map. Idempotent, and a safe no-op when the vector
 * source isn't there (a failed tile load must degrade to the honest flat/list
 * fallback, never to a half-built city).
 *
 * @returns true if the city is now present.
 */
export function addVoxelCityLayers(
  map: MlMap,
  theme: VoxelTheme,
  opts: VoxelCityOptions = {},
): boolean {
  const sourceId = opts.sourceId ?? 'omt';
  const sourceLayer = opts.sourceLayer ?? 'building';
  if (!map.getSource(sourceId)) return false;

  const existing = STATE.get(map);

  // Fully installed AND tracked — a theme swap is a repaint, not a rebuild.
  if (map.getLayer(VOXEL_MESH_LAYER) && existing) {
    setVoxelCityTheme(map, theme);
    if (opts.routeFocused !== undefined) setVoxelCityRouteFocus(map, opts.routeFocused);
    return true;
  }

  // Anything else — half-installed, or installed but with no tracked state (module
  // HMR, or a caller that lost the map reference) — is swept and rebuilt.
  if (map.getLayer(VOXEL_MESH_LAYER)) map.removeLayer(VOXEL_MESH_LAYER);

  const focused = opts.routeFocused ?? existing?.routeFocused ?? false;

  // The flat 2D footprints would z-fight the 3D ones. Record the pre-existing
  // visibility from the CURRENT style — after a `setStyle({diff:false})` the old
  // recorded value describes a style that no longer exists.
  let flatWasVisible = existing?.flatBuildingWasVisible ?? true;
  if (map.getLayer(FLAT_BUILDING_LAYER)) {
    flatWasVisible = map.getLayoutProperty(FLAT_BUILDING_LAYER, 'visibility') !== 'none';
    map.setLayoutProperty(FLAT_BUILDING_LAYER, 'visibility', 'none');
  }

  const before = insertionPoint(map);
  const layer = createVoxelMeshLayer({ sourceId, sourceLayer, theme, routeFocused: focused });
  try {
    map.addLayer(layer, before);
  } catch {
    // A custom layer that fails to initialise (no WebGL2, context loss mid-add) must
    // leave the flat map exactly as it was, not a city-shaped hole.
    if (map.getLayer(FLAT_BUILDING_LAYER) && flatWasVisible) {
      map.setLayoutProperty(FLAT_BUILDING_LAYER, 'visibility', 'visible');
    }
    return false;
  }

  // DESIGN-TARGET §C: "Buildings must never occlude the route, stops, markers,
  // LABELS, vehicles or the You beacon." The overlays are handled by inserting the
  // city beneath them; basemap labels are not, because they live BELOW the insertion
  // point in the style order and would be drawn before — and therefore behind — every
  // block. Lifting them to just under the overlays is what makes "King St West"
  // readable along a street with towers on both sides.
  liftBasemapLabels(map, sourceId, labelInsertionPoint(map) ?? before);

  STATE.set(map, { theme, routeFocused: focused, layer, flatBuildingWasVisible: flatWasVisible });
  return true;
}

/** Take the city back out and undo everything it touched. Safe to call twice, and a
 *  true no-op on a map that never had it (it must not un-hide a `building` layer that
 *  somebody else deliberately turned off). */
export function removeVoxelCityLayers(map: MlMap): void {
  const st = STATE.get(map);
  if (map.getLayer(VOXEL_MESH_LAYER)) map.removeLayer(VOXEL_MESH_LAYER);
  if (!st) return;
  if (map.getLayer(FLAT_BUILDING_LAYER) && st.flatBuildingWasVisible) {
    map.setLayoutProperty(FLAT_BUILDING_LAYER, 'visibility', 'visible');
  }
  STATE.delete(map);
}

export function hasVoxelCityLayers(map: MlMap): boolean {
  return !!map.getLayer(VOXEL_MESH_LAYER);
}

/** Repaint to the other theme without rebuilding the layer (theme swaps are hot). */
export function setVoxelCityTheme(map: MlMap, theme: VoxelTheme): void {
  const st = STATE.get(map);
  if (!st) return;
  st.layer.setTheme(theme);
  STATE.set(map, { ...st, theme });
}

/**
 * Focus mode: when a route line is on the map, the city mutes toward the ground tone
 * and collapses to `FOCUS_FLATTEN` of its height, so the only loud thing in frame is
 * the red stroke. Both are shader uniforms, so this costs one repaint and no rebuild.
 */
export function setVoxelCityRouteFocus(map: MlMap, focused: boolean): void {
  const st = STATE.get(map);
  if (!st || st.routeFocused === focused) return;
  st.layer.setRouteFocus(focused);
  STATE.set(map, { ...st, routeFocused: focused });
}

/**
 * Rebuild the city's geometry from the tiles currently loaded. Cheap to call and
 * idempotent; MapCard drives it from `idle`, exactly as it drives the trees.
 *
 * Panning and zooming do NOT need this — the geometry is in world space, so the
 * render path is a matrix multiply and one draw call per mesh. Only NEW TILES change
 * what should be in the scene.
 */
export function syncVoxelCity(map: MlMap): void {
  STATE.get(map)?.layer.sync();
}

/** Diagnostics for the verification harness: how many blocks are actually in the
 *  scene. Replaces `queryRenderedFeatures({layers:['voxel-body']})`, which cannot
 *  work against a custom layer. */
export function voxelCityStats(map: MlMap): { blocks: number; built: number } | null {
  const st = STATE.get(map);
  if (!st) return null;
  const s = st.layer.stats();
  return { blocks: s.blocks, built: s.built };
}

// ---------------------------------------------------------------- camera

const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface VoxelCameraOptions {
  pitch?: number;
  /** Pass `null` to leave bearing alone (the user has rotated the map themselves). */
  bearing?: number | null;
  /**
   * Floor the zoom so the diorama is actually visible. Pass `null` to leave zoom
   * strictly alone — required if the camera was just placed by a `fitBounds`, which
   * this would otherwise silently undo.
   */
  minZoom?: number | null;
  animate?: boolean;
}

/**
 * Tip the camera into the diorama. Honours `prefers-reduced-motion` by cutting rather
 * than easing — there is no drift, no orbit, no idle animation anywhere in this
 * module; the city renders its final state and stops.
 *
 * Note this only ever zooms IN, to the diorama floor. It never zooms out, so it is
 * safe to call on a user who has deliberately zoomed past it.
 */
export function applyVoxelCamera(map: MlMap, opts: VoxelCameraOptions = {}): void {
  const pitch = opts.pitch ?? VOXEL_PITCH;
  // Raise the ceiling BEFORE setting pitch, or MapLibre clamps to its default 60.
  if (map.getMaxPitch() < pitch) map.setMaxPitch(Math.max(pitch, VOXEL_MAX_PITCH));
  setVoxelFov(map, VOXEL_FOV_DEG);
  const floor = opts.minZoom === undefined ? VOXEL_DIORAMA_ZOOM : opts.minZoom;
  const bearing = opts.bearing === undefined ? VOXEL_BEARING : opts.bearing;
  const camera: { pitch: number; zoom?: number; bearing?: number } = { pitch };
  if (floor !== null) camera.zoom = Math.max(map.getZoom(), floor);
  if (bearing !== null) camera.bearing = bearing;
  if (opts.animate === false || prefersReducedMotion()) map.jumpTo(camera);
  else map.easeTo({ ...camera, duration: 700 });
}

/** Put the camera back flat, north-up and at MapLibre's own field of view (used when
 *  quality drops out of Full). Restores the default pitch ceiling too, so the app is
 *  left exactly as it was found. */
export function resetVoxelCamera(map: MlMap, animate = true): void {
  const camera = { pitch: 0, bearing: 0 };
  setVoxelFov(map, DEFAULT_FOV_DEG);
  if (!animate || prefersReducedMotion()) map.jumpTo(camera);
  else map.easeTo({ ...camera, duration: 500 });
  map.setMaxPitch(60);
}

/** `setVerticalFieldOfView` is only in newer MapLibre and can throw mid-style-swap.
 *  A decorative camera tweak must never take the host app down. */
export function setVoxelFov(map: MlMap, deg: number): void {
  try {
    if (typeof map.setVerticalFieldOfView !== 'function') return;
    if (Math.abs(map.getVerticalFieldOfView() - deg) < 0.01) return;
    map.setVerticalFieldOfView(deg);
  } catch {
    /* style swap in flight */
  }
}
