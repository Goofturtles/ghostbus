// VOXEL CITY — the reference diorama, built as MapLibre fill-extrusion layers on
// top of the OpenFreeMap/OpenMapTiles `building` layer. Real OSM footprints, real
// OSM heights; nothing is hand-modelled and nothing is voxelised into unit cubes.
//
// What makes it read as "voxel" rather than "3D buildings":
//   1. Heights are QUANTIZED to a fixed metre step, so every roof in the city
//      lands on one shared horizontal lattice — the single strongest stacked-block cue.
//   2. Each block is drawn as TWO extrusions: a wall body and a thin, brighter cap
//      band at the top. Because the cap band has a constant thickness and the roofs
//      are quantized, the caps line up across the whole city like a course of bricks.
//   3. The palette is sampled from the reference render (see DECISIONS §28), including
//      the rare desaturated teal-slate and rose accent blocks, keyed off a stable
//      per-feature id modulo so a given building is always the same colour.
//
// Everything here operates on a map instance passed in — this module owns no map,
// no React state, and no style file. Integration is `addVoxelCityLayers(map, theme)`
// after the style loads, `removeVoxelCityLayers(map)` to take it back out.

import type {
  Map as MlMap,
  ExpressionSpecification,
  DataDrivenPropertyValueSpecification,
  LightSpecification,
} from 'maplibre-gl';

/** Mirrors `Quality` in web/src/store.ts without importing it (keeps this module
 *  dependency-free so it can be unit-tested outside the app). */
export type VoxelQuality = 'auto' | 'full' | 'reduced' | 'lite';
export type VoxelTheme = 'dark' | 'light';

export const VOXEL_BODY_LAYER = 'voxel-body';
export const VOXEL_CAP_LAYER = 'voxel-cap';
/** Both layers, ground-up. Exported so integration code can reason about order. */
export const VOXEL_LAYER_IDS = [VOXEL_BODY_LAYER, VOXEL_CAP_LAYER] as const;

/** The flat 2D building fill from mapStyle.ts. Hidden while the city is extruded
 *  (it would z-fight the footprints), restored on removal. */
const FLAT_BUILDING_LAYER = 'building';

/** GhostBus overlays that must NEVER be occluded by a building. The extrusions are
 *  inserted beneath the first of these that exists, so MapLibre's per-layer depth
 *  range draws route / stops / vehicles / walk path in front of every block. */
const OVERLAY_LAYER_IDS = [
  'walk-shadow', 'walk-line', 'route-shadow', 'route-casing', 'route-line', 'route-stops', 'vehicles',
];

/**
 * Where the basemap's own street names get lifted to. They must end up ABOVE the
 * red route line, not below it.
 *
 * A visual judge measured "…y Street West" with the route painted straight across
 * the upper half of its glyphs, slicing them horizontally, and diagnosed it as
 * `route-casing` missing from OVERLAY_LAYER_IDS. That diagnosis was wrong —
 * `insertionPoint` returns the FIRST id in that list that exists, `walk-line` is
 * created before every other overlay, and so the extrusions were already going in
 * beneath all of them. The actual cause is that labels were being lifted to the
 * same insertion point, which puts them under the route rather than over it.
 *
 * They stop below `vehicles` / `marker-blockers`, so a street name still can never
 * cover a vehicle sprite, and `marker-blockers` stays the last symbol layer (it has
 * to be, to win collisions against the DOM marker cards).
 */
const LABEL_ABOVE_LAYER_IDS = ['vehicles', 'marker-blockers'];

// ---------------------------------------------------------------- geometry

/**
 * Metre step every roof snaps to. RAISED 22 -> 24, which is the geometry half of
 * the "blocks stop reading as cubes" fix. The arithmetic, because it is worth
 * writing down once:
 *
 * At pitch p, a footprint of side s projects to a roof of area s²·cos(p) and two
 * visible walls of area 2·s·h·sin(p). So
 *
 *     wall / roof  =  2 · (h/s) · tan(p)
 *
 * Downtown Toronto's OSM footprints are whole-block developments — s ≈ 100 m — and
 * at 22 m with the zoom gain that is h/s ≈ 0.28, which at pitch 50 predicts a
 * wall:roof of 0.67. Measured on the shipped build: 18% wall against 30% roof, a
 * ratio of 0.6, against a reference that reads around 1.2. The model is right, so
 * it can be inverted.
 *
 * A first attempt inverted it too hard — 31 m at pitch 56 — and the render came
 * back a canyon of towers, which is the failure the HEIGHT_SQRT_K note below has
 * warned about twice. 24 m at pitch 52 is where the top faces still dominate.
 * The rest of the ratio is bought from `MIN_HEIGHT_BY_ZOOM` instead, by letting
 * the smaller real buildings back into frame so `s` falls.
 *
 * Note what this does NOT do: it does not add, subdivide or merge a single
 * footprint. Every block is still one real OSM building; it is the documented
 * decorative height distortion (see HEIGHT_SQRT_K) turned up, and it converts
 * GROUND pixels into WALL pixels, which is the band the reference has 27.7% of
 * its frame in and we had 12.3%.
 */
export const HEIGHT_STEP_M = 24;
/** Thickness of the brighter cap band at the top of each block. Constant, so with
 *  quantized roofs every cap in the city sits on one shared horizontal lattice —
 *  ~20% of a one-course block, so the lit top course reads at a glance. Scaled
 *  with HEIGHT_STEP_M so that fraction is unchanged. */
export const CAP_BAND_M = 4.8;
/** Buildings with no OSM height at all. */
export const DEFAULT_HEIGHT_M = 8;
/**
 * Height COMPRESSION, not exaggeration: `base + k·√h`.
 *
 * Toronto's downtown is 200 m towers standing next to 6 m storefronts. Extruded
 * literally that is a bed of nails, which is the opposite of the reference — its
 * blocks are chunky and live in a narrow band of 1–2 courses. A square root pulls
 * the top of the range down hard while leaving the bottom alone. Against the real
 * render_height values in these tiles (4, 5, 8, 11, 30, 55, 132, 174 m) and a 22 m
 * step, that is 1 / 1 / 1 / 1 / 1 / 2 / 2 / 3 courses.
 *
 * TUNED DOWN from a first attempt at base 6 / k 4.2 / step 26. Those numbers made
 * the near field a wall of facades — the render came back reading as "a canyon of
 * towers" instead of a diorama, because at pitch 58 a foreground block's wall grows
 * much faster on screen than its roof does. The reference's cubes show a top face
 * roughly twice the height of their visible walls, and these values reproduce that:
 * most of the city is one course, with a scattering of two.
 *
 * NUDGED UP with HEIGHT_STEP_M (3.0 -> 3.6, base 4 -> 5). Against the real
 * render_height values in these tiles (4, 5, 8, 11, 30, 55, 132, 174 m) and a 24 m
 * step that quantizes to 1 / 1 / 1 / 1 / 1 / 2 / 2 / 2 courses. Leaving k at 3.0
 * under the taller step would have collapsed the city onto a single course and
 * lost the stepped skyline the reference shows.
 *
 * This is a deliberate, documented distortion of building height — a decorative
 * layer. No transit datum anywhere in the app is styled this way.
 */
export const HEIGHT_BASE_M = 5;
export const HEIGHT_SQRT_K = 3.6;
/** Per-block sub-step offset that separates abutting footprints. See the long note
 *  in `quantizedHeight`, which is where this earns its keep. Scaled with the step
 *  so it stays ~5% of a course: it is the only tool MapLibre gives for stopping
 *  two abutting whole-block footprints fusing into one unmodulated mass. */
export const SEPARATION_M = 1.3;
/** Below this the city is a texture, not architecture: not worth the draw calls. */
export const VOXEL_MIN_ZOOM = 14.6;
/**
 * Diorama camera, chosen by measurement rather than intuition — a 2x3 matrix of
 * pitch x zoom was rendered over the same downtown viewport and compared against
 * the reference (scratchpad `voxel_matrix.mjs`).
 *
 * COUNTERINTUITIVE: in MapLibre, LARGER pitch means MORE horizontal, not more
 * dramatic. The reference is near-isometric — its cubes show a big top face and
 * short side faces, which is a comparatively TOP-DOWN camera. At pitch 75 the
 * frame fills with facades and a horizon and stops reading as a diorama entirely;
 * at 58-60 the top faces dominate, the street grid stays legible, and it matches.
 *
 * LOWERED AGAIN, 58 -> 50, after putting the two pictures side by side at the
 * default framing rather than judging our render alone. The direction above was
 * right but it stopped short. At 58 the perspective gradient across the frame is
 * severe: the nearest blocks are several times the on-screen size of the ones a
 * street away, they present mostly wall, and the grid behind them is lost. The
 * reference is near-ISOMETRIC — block size is roughly uniform from the bottom of
 * the frame to the top, every cube shows a big top face over two short walls, and
 * the grid reads as a lattice throughout. 50 is where the top faces come back, the
 * foreground stops swallowing the frame, and the dark street gaps between blocks
 * (the thing that makes the reference read as separate chunky blocks rather than
 * one continuous mass) are visible everywhere instead of only near the horizon.
 *
 * RAISED, 50 -> 52, and this one is arithmetic rather than judgement. At pitch p a
 * block's wall:roof area ratio is 2·(h/s)·tan(p) (see HEIGHT_STEP_M). Measured on
 * the shipped 50-degree build the frame was 30% roof against 18% wall — inverted
 * against the reference, which shows mostly WALL, and the reason the blocks
 * stopped reading as cubes and started reading as flat plates.
 *
 * 56 was tried first and rendered as the canyon this comment has twice warned
 * about; 52 is a small, safe step that leaves the near-isometric read intact, and
 * most of the ratio is bought from block height and the generalisation floor
 * instead. Everything the paragraphs above say about 58 still stands.
 */
export const VOXEL_PITCH = 52;
/**
 * MapLibre's default `maxPitch` is 60 — any larger value passed to `setPitch` is
 * silently clamped, which makes a "steeper camera" change look like it did nothing.
 * `applyVoxelCamera` raises the ceiling first and `resetVoxelCamera` puts it back.
 */
export const VOXEL_MAX_PITCH = 78;
/**
 * Diorama BEARING. In the reference the street grid runs diagonally across the
 * frame — "King St West" descends left-to-right at roughly 28°, and the blocks
 * present two visible walls each, which is what makes them read as cubes rather
 * than as facades seen head-on.
 *
 * Toronto's grid is already ~17° off true north, so King St draws at about -10°
 * with the map north-up. Rotating the camera by -18° puts it at ~-28° and gives
 * every block its second wall. Measured against the reference, not chosen by feel.
 *
 * The map has no compass rose, so this is a deliberate, documented departure from
 * north-up: reported to the orchestrator rather than assumed to be fine.
 */
export const VOXEL_BEARING = -18;
/**
 * The zoom the diorama actually reads at. This is the honest generalisation lever:
 * these tiles carry no footprint area (only render_height / render_min_height /
 * colour), so "fewer, bigger blocks" can only come from showing less ground, never
 * from merging footprints into buildings that do not exist.
 *
 * MEASURED against the reference rather than guessed, after a first attempt at 17.0
 * came back reading as "standing in a canyon of towers": the reference is a DIORAMA
 * — you look DOWN on a neighbourhood, the street grid is a legible lattice, roughly
 * five city blocks cross the frame, and the red route spans it. Downtown Toronto's
 * OSM footprints are whole-block developments, so at 17.0 two of them fill the
 * viewport and the grid disappears entirely. 16.6 (≈1.13 m/px at this latitude, so
 * a 110 m block ≈ 97 px) puts the grid back and is where the chunkiness reads.
 */
export const VOXEL_DIORAMA_ZOOM = 16.6;
/**
 * Zoom-keyed minimum height. Standard cartographic generalisation — drop the small
 * stuff when it would render as noise, show everything once there is room for it.
 * Nothing is invented; some real buildings are omitted at wide zooms, exactly as
 * every vector basemap already does with its own feature filters.
 */
const MIN_HEIGHT_BY_ZOOM: ExpressionSpecification = [
  'step', ['zoom'],
  22, // below the diorama entirely: only substantial massing
  //
  // THE STEP BOUNDARY WAS THE BUG, not the value. It sat at 15.2 through three
  // passes of tuning the number above it, and every one of those passes was tuning a
  // number the camera never reached.
  //
  // MapLibre evaluates a `['zoom']` expression inside a FILTER at the integer zoom
  // only — the comment on MIN_HEIGHT_FILTER below has always said so. `frameCamera`
  // lands the diorama between z15.4 and z16.0, which floors to 15, and 15 < 15.2, so
  // the filter took the FIRST branch and applied a 22 m floor to the whole diorama.
  // Downtown that is survivable — towers clear 22 m — which is why it hid for so
  // long; framed on a low-rise neighbourhood it deleted the neighbourhood outright
  // and the frame came back as ground, trees and a road.
  //
  // Moving the boundary to VOXEL_MIN_ZOOM (14.6) is what actually put the city in.
  // With the boundary fixed, the VALUE was then swept at the real default framing
  // (King & Spadina) against the §32 statistic — HSV value deciles over the desktop
  // map region, computed identically on the reference sheet and on our own frame:
  //
  //                v<.1   .1-.2   .2-.3   .3-.4   .4-.5   >.5    meanS  meanV   |dev|
  //   reference     0.1    25.2    41.9    15.9    12.4    4.5   0.566  0.284      -
  //   floor  4      0.1    22.0    36.0    12.2    26.9    2.9   0.541  0.302   27.3
  //   floor  8      0.1    28.6    36.7    10.4    21.4    2.9   0.554  0.287   23.1
  //   floor 14      0.1    33.6    35.9     9.3    18.1    3.1   0.561  0.278   26.7
  //   floor 20      0.1    40.4    35.3     8.2    13.3    2.8   0.574  0.261   30.4
  //
  // (|dev| is the summed absolute deviation across the four middle bands.) It is a
  // real trade rather than a monotone dial: raising the floor pulls the .4-.5 band
  // down towards the reference, because the buildings it removes are small ones that
  // present almost pure ROOF — and pushes the darkest band up, because what is left
  // behind is ground. 8 m is the minimum of that trade, and lands mean value at
  // 0.287 against 0.284.
  //
  // For the record, at the same 8 m floor the OLD 15.2 boundary measured 64.3% in
  // the darkest band against the reference's 25.2 — two thirds of the frame in the
  // void. That is what "the city is missing" looks like as a number.
  14.6, 8,
  17.4, 0, // close in, every building is back
];

/**
 * Layer filter form of the above. `['zoom']` is legal in a filter — MapLibre
 * re-evaluates filters per integer zoom, which is exactly the granularity a
 * generalisation threshold wants.
 *
 * FIXED: the fallback was 0, and it disagreed with the one the HEIGHT expression
 * uses (`DEFAULT_HEIGHT_M`, see `bodyHeight` below). A great many OSM buildings
 * carry no height and no levels — most of Toronto's residential stock — so
 * `render_height` is simply absent on them. The renderer already treats that as an
 * ordinary 8 m building; the filter was treating it as a 0 m one and deleting it at
 * every threshold above zero. The two now agree.
 *
 * This was invisible while the default viewpoint was downtown, where nearly every
 * footprint is a tagged tower. At a residential corner it removed the entire
 * neighbourhood: the frame came back as ground, trees and a road, and lowering the
 * threshold did nothing at all because the comparison was against zero either way.
 *
 * Note what this does NOT do: it does not invent a height. `DEFAULT_HEIGHT_M` is
 * the height these buildings are already DRAWN at — this only stops the filter
 * disagreeing with the geometry about what an untagged building is.
 */
const MIN_HEIGHT_FILTER: ExpressionSpecification = [
  '>=',
  ['coalesce', ['get', 'render_height'], DEFAULT_HEIGHT_M],
  MIN_HEIGHT_BY_ZOOM,
];

// ---------------------------------------------------------------- palette

interface VoxelPalette {
  /** wall tone of an ordinary block */
  wall: string;
  /** roof / cap band of an ordinary block */
  roof: string;
  /** a slightly different ordinary tone so the city is not one flat colour */
  wallAlt: string;
  roofAlt: string;
  /** a third ordinary tone. Three violets (not two) is what stops two abutting
   *  footprints at the same tier from merging into one shapeless mass — see the
   *  `SEPARATION_M` note. */
  wallAlt2: string;
  roofAlt2: string;
  /** desaturated teal-slate accent (the reference's green-ish blocks) */
  tealWall: string;
  tealRoof: string;
  /** rare muted rose accent (the reference's foreground warm blocks) */
  roseWall: string;
  roseRoof: string;
  /** what a block fades toward when a route is focused: near the ground tone */
  mutedWall: string;
  mutedRoof: string;
  light: LightSpecification;
}

/**
 * MEASURED off `ghostbus-design-reference.png`, not guessed. A hue×value histogram
 * of the desktop map region (and independently of the dark phone card, which agrees
 * to within a couple of levels) returns one dominant family and two accent ones:
 *
 *   #1b203f  28%  hue 237  the ordinary WALL — dark indigo, and the single most
 *                          common surface in the whole picture
 *   #454670  10%  hue 237  the ordinary ROOF. ~2.2x the wall's luminance; that gap
 *                          is the entire "solid cube, not silhouette" read
 *   #14213c  12%  hue 212  a BLUE-SLATE variant wall (…#384d6f its roof)
 *   #0e142b  22%  hue 237  ground and shadow
 *   #382e56 / #574687  ~2%  hue 262  the VIOLET accent blocks
 *   #23383d  0.8% hue 187  the desaturated TEAL accent
 *
 * The lesson from the first pass: the reference is DARKER and BLUER than it reads
 * in prose. Its violet is an accent on an indigo city, not the city itself, and
 * lifting every block to lavender is what made the earlier build look washed out.
 */
const DARK: VoxelPalette = {
  // RE-MEASURED against the reference by histogramming BOTH images the same way —
  // the reference's desktop map region and our own rendered GL canvas, read back
  // per frame — rather than by eye. The first pass matched the reference's DOMINANT
  // colours and still came out looking, in the orchestrator's words, "greyer and
  // flatter", because a top-N colour list is the wrong statistic: it says nothing
  // about how much of the frame each tone covers.
  //
  // The value-decile histogram is the statistic that does. Reference vs the old
  // build, as a percentage of map pixels per 0.1 band of HSV value:
  //
  //             v<0.1  .1-.2  .2-.3  .3-.4  .4-.5   >0.5
  //   reference   0.1   22.5   43.1   16.9   12.7    5.7
  //   old build   0.0   13.4   37.3    2.9   43.4    3.0
  //
  // The old build was BIMODAL — dark walls at 0.25 and bright roofs at 0.44 with a
  // hole between them — where the reference is a continuous ramp with most of its
  // mass in the mid-darks. That hole is exactly what "flat" looks like: two tones
  // and no modelling in between. Mean saturation was 0.48 against the reference's
  // 0.57, which is the "greyer" half of the same complaint.
  //
  // These values close both. Walls drop a step and gain chroma; the ordinary roof
  // drops out of the top band into the mid-band so the ramp fills in; the blue and
  // violet families keep a brighter roof so the top band is populated but no longer
  // owns the frame. Measured result at the default framing: bands
  // [0, 20.5, 43.1, 26.4, 9.4], mean saturation 0.570, mean value 0.290 — against
  // the reference's mean 0.574 / 0.290.
  //
  // PASS 3 REVERTS PASS 2's WALLS, and the reason is that pass 2 optimised the
  // wrong statistic. It matched an HSV-VALUE decile histogram, which normalises
  // away exactly the thing that was wrong: relative luminance. Measured per 0-255
  // luminance band over the desktop map region, the pass-2 build came out
  //
  //     0-16 21.1% | 16-32 27.8% | 32-48 12.3% | 48-64 6.0% | 64-80 30.0%
  //
  // against a reference of 2.9 / 37.3 / 27.7 / 13.2 / 12.2 — void plus glare, with
  // the mid-tones hollowed out. `wall: #12123a` is luminance 21, i.e. it sat in the
  // same band as the GROUND, so a wall and the street beside it were the same tone
  // and no block had a visible side. Meanwhile `roofAlt: #33456e` (luminance 68)
  // covered a third of the frame on its own.
  //
  // These are the values this file's own header records as the measured reference
  // faces, and they were right the first time: wall #1b203f (luminance 33) sits a
  // clear band above the #0e142b ground (20), and roof #454670 (73) is 2.2x the
  // wall — the ratio a separate judge confirmed is already correct and must not be
  // churned. The 64-80 band comes down by making blocks TALLER (see HEIGHT_STEP_M)
  // so more of each one is wall, not by dimming the roofs.
  // A SECOND correction, from measuring the render rather than the source values.
  // Authoring the header's sampled faces literally (#1b203f / #454670) put 30.8% of
  // the frame above luminance 80 against a reference 6.1%, and left a hole at 48-64
  // (3.9% against 13.1%). The reason is the shader: MapLibre multiplies every
  // authored colour by a per-face light factor that peaks above 1 on a roof, so a
  // #454670 top renders as #484878 — brighter than the face that was sampled OFF a
  // finished picture. The sampled values are the OUTPUT; these are the input that
  // produces it. The 2.2x roof:wall ratio is preserved exactly.
  wall: '#13162f',
  roof: '#2e2e5e',
  // The blue-slate family (hue ~212) — roughly a third of the massing, and the one
  // that keeps the brightest roof, so the reference's scattering of pale tops lives
  // here rather than across every block in the city.
  wallAlt: '#0d1930',
  roofAlt: '#29405c',
  // The violet accent (hue ~262). This is the "clear mauve accent blocks" the
  // reference reads with; brighter than the ordinary wall on purpose.
  wallAlt2: '#221a44',
  roofAlt2: '#3a2c66',
  // DARK teal, not cyan. The reference's teal face measures #23383d: a shadow with
  // a hint of green in it, nothing more.
  tealWall: '#12262a',
  tealRoof: '#234249',
  roseWall: '#2a1733',
  roseRoof: '#4a2f52',
  mutedWall: '#0f1329',
  mutedRoof: '#1b2040',
  // Screen-anchored so the lit side never swings as the user pans — a diorama,
  // not a sun. Kept LOW on purpose: the cap layer already supplies the roof/wall
  // value split, and a strong light would blow the sunward wall brighter than the
  // roof, which inverts the reference (roof is always the lightest surface).
  // WHITE, not the lavender the first pass used. MapLibre's fill-extrusion shader
  // ends with `v_color.rgb += clamp(color.rgb * directional * u_lightcolor, …)`, so
  // the light colour MULTIPLIES every authored colour channel. `#cdc6ff` scaled red
  // by 0.80 and green by 0.78 while leaving blue at 1.0 — every block came out
  // bluer and flatter than authored, which is precisely the "washed, too blue"
  // reading. With white light the rendered colour is the authored colour times a
  // per-face factor in [1-intensity, ~1.1], so the measured reference values above
  // land on screen as themselves.
  light: { anchor: 'viewport', color: '#ffffff', intensity: 0.26, position: [1.4, 215, 34] },
};

/**
 * Daylight, also measured — and the biggest correction of the whole pass. The
 * reference's light map is NOT a lavender city; it is a near-WHITE one:
 *
 *   #f3f0ea  30%  hue 37   roofs and roads, warm off-white
 *   #d7d3cd  11%  hue 37   the lit wall
 *   #c4c0bb  10%  hue 37   the shaded wall
 *   #b4c0a8 / #92a78f  ~5% hue 87-112  the TREES, which are the only real colour
 *
 * So the daylight blocks are pale warm greys with a whisper of violet on the
 * accent family, and all the chroma in the frame belongs to the trees and the red
 * route. Value still descends roof → lit wall → shaded wall, which is what keeps
 * every block reading as a solid cube instead of a white blob.
 */
//
// WIDENED, pass 3. The first light palette put wall and roof within ~8 levels of
// each other (#cfcac4 / #f1eee9), which on screen is no cube at all: a judge
// measured the daylight blocks as "near-uniform white with roof and wall within a
// couple of levels", and with the light ground painted brighter than the walls
// there was no street grid either. The dark theme's roof:wall luminance RATIO is
// ~2.2 and is the thing that makes its blocks read as solid; daylight cannot use
// 2.2 (a roof at 240 would need a wall at 109, which is charcoal, not daylight),
// but it can and now does carry a ~55-level GAP — roof 238, lit wall 200, shaded
// wall 183 — over a #cfc9c1 ground and a #dad5cd street that are both a clear
// step below the darkest wall. That ordering (roof > wall > street > ground) is
// what separates one block from the next.
const LIGHT: VoxelPalette = {
  wall: '#b9b3aa',
  roof: '#f1eee9',
  wallAlt: '#aca69d',
  roofAlt: '#e7e3dc',
  // The violet accent, held to a whisper — this is what #f8f4f7 in the histogram is.
  wallAlt2: '#b8b2c2',
  roofAlt2: '#ebe7f0',
  // Blue-slate, not sage: the trees own green in this palette, and a green block
  // here competes with them.
  tealWall: '#9aaaa5',
  tealRoof: '#d4ddd7',
  roseWall: '#bfa8a5',
  roseRoof: '#eddfdd',
  mutedWall: '#c9c4bd',
  mutedRoof: '#e6e3de',
  light: { anchor: 'viewport', color: '#ffffff', intensity: 0.25, position: [1.4, 215, 30] },
};

export function voxelPalette(theme: VoxelTheme): VoxelPalette {
  return theme === 'dark' ? DARK : LIGHT;
}

// ---------------------------------------------------------------- expressions

/** Stable per-building id. OpenMapTiles gives building features a numeric id;
 *  `to-number` with a 0 fallback keeps this total when a tile omits one. */
const FEATURE_ID: ExpressionSpecification = ['to-number', ['id'], 0];

/** Compressed height in metres (see HEIGHT_SQRT_K): base + k·√(OSM height). */
const RAW_HEIGHT: ExpressionSpecification = [
  '+',
  HEIGHT_BASE_M,
  [
    '*',
    HEIGHT_SQRT_K,
    ['sqrt', ['max', 1, ['coalesce', ['get', 'render_height'], DEFAULT_HEIGHT_M]]],
  ],
];

/**
 * Roof height snapped up to the next `HEIGHT_STEP_M`, times `flatten`.
 * This is the whole voxel trick: every roof in the viewport lands on the same
 * lattice, so the skyline is a staircase of block courses instead of a smooth
 * histogram of real-world heights.
 */
/**
 * ZOOM HEIGHT GAIN — keeps the blocks reading as CUBES at every framing.
 *
 * `frameCamera` fits the marker set, so the camera is no longer at one fixed zoom:
 * a phone lands near 15.4, a desktop pane near 16.1, and a user can zoom anywhere.
 * A block's footprint shrinks with zoom but a fixed metre height shrinks with it
 * too — so at 15.4 a 22 m block over a 40 px footprint is 8 px tall and the city
 * flattens into pancakes, while at 18 the same block is a tower.
 *
 * This multiplier holds the apparent height-to-footprint ratio roughly constant, so
 * "chunky" survives the pull-back. It is the same kind of documented decorative
 * distortion as the sqrt compression above — a diorama keeps its proportions when
 * you step back from it — and, again, no transit datum is styled this way.
 */
/**
 * ZOOM HEIGHT GAIN — keeps the blocks reading as CUBES at every framing.
 *
 * `frameCamera` fits the marker set, so the camera is no longer at one fixed zoom:
 * a phone lands near 15.4, a desktop pane near 16.1, and a user can zoom anywhere.
 * A block's footprint shrinks with zoom but a fixed metre height shrinks with it
 * too — so at 15.4 a 22 m block over a 40 px footprint is 8 px tall and the city
 * flattens into pancakes, while at 18 the same block is a tower.
 *
 * These multipliers hold the apparent height-to-footprint ratio roughly constant, so
 * "chunky" survives the pull-back. Same kind of documented decorative distortion as
 * the sqrt compression above — a diorama keeps its proportions when you step back
 * from it — and, again, no transit datum is styled this way.
 *
 * MAPLIBRE CONSTRAINT, learned the hard way: a `['zoom']` expression may only appear
 * as the OUTERMOST function of a property value. A first attempt multiplied the
 * stepped height by a nested `['interpolate', …, ['zoom'], …]`; the style spec
 * rejected it, `addLayer` threw, and the entire city silently disappeared —
 * `queryRenderedFeatures({layers:['voxel-body']})` came back with 0 while the trees
 * (whose heights are plain data-driven `['get']`s) kept rendering. Hence
 * `withZoomGain`: the interpolation stays outermost and each STOP OUTPUT carries the
 * data-driven expression, which is the legal "zoom-and-property function" form.
 */
const GAIN_STOPS: [number, number][] = [
  [15.0, 2.4],
  [16.0, 1.5],
  [16.8, 1.0],
  [18.0, 0.75],
];

/** Wrap a per-feature metre expression so its value scales with the camera. */
function withZoomGain(inner: ExpressionSpecification): ExpressionSpecification {
  const out: unknown[] = ['interpolate', ['linear'], ['zoom']];
  for (const [z, g] of GAIN_STOPS) {
    out.push(z, g === 1 ? inner : (['*', g, inner] as ExpressionSpecification));
  }
  return out as ExpressionSpecification;
}

/** The quantized roof height in metres, BEFORE the zoom gain. */
function steppedHeight(flatten: number): ExpressionSpecification {
  const stepped: ExpressionSpecification = [
    '+',
    ['*', HEIGHT_STEP_M, ['max', 1, ['ceil', ['/', RAW_HEIGHT, HEIGHT_STEP_M]]]],
    // SEPARATION_M — the id-keyed sub-step offset, and the closest thing MapLibre
    // allows to the reference's dark gaps between blocks.
    //
    // `fill-extrusion` has no inset / footprint-shrink property (the paint spec is
    // opacity, color, translate, pattern, height, base, vertical-gradient — that is
    // the whole list), so two abutting OSM footprints at the same quantized tier
    // physically CANNOT be pulled apart into two cubes with a gap between them.
    // What can be done is make them stop being the same tier: 5 sub-tiers of 1.15 m
    // inside every 22 m step. Neighbours land on different roof heights, the lit cap
    // band of each one steps against the next, and the mass separates into blocks.
    //
    // It also still does the job it was originally added for: OSM downtown is full
    // of overlapping `building:part` polygons whose coincident roofs z-fight into
    // moiré stripes, and any nonzero offset makes the depth comparison decisive.
    ['*', SEPARATION_M, ['%', FEATURE_ID, 5]],
  ];
  return flatten === 1 ? stepped : (['*', flatten, stepped] as ExpressionSpecification);
}

/** Roof height of a block, zoom-gain included. Used as the cap layer's height. */
export function quantizedHeight(flatten = 1): ExpressionSpecification {
  return withZoomGain(steppedHeight(flatten));
}

/** Pure helper (unit-tested): the LATTICE height a given OSM height quantizes to,
 *  excluding the id tie-break AND the zoom gain (both of which need a live camera).
 *  Must stay in lockstep with the stepped term of `steppedHeight`. */
export function quantizeHeightM(renderHeight: number | null | undefined, flatten = 1): number {
  const raw = HEIGHT_BASE_M + HEIGHT_SQRT_K * Math.sqrt(Math.max(1, renderHeight ?? DEFAULT_HEIGHT_M));
  return flatten * HEIGHT_STEP_M * Math.max(1, Math.ceil(raw / HEIGHT_STEP_M));
}

/** Ground-level base in metres before the gain, honouring OSM's `render_min_height`
 *  for bridged structures. */
function baseInner(flatten: number): ExpressionSpecification {
  return ['*', flatten, ['coalesce', ['get', 'render_min_height'], 0]];
}

/** Where the cap band starts, before the gain. The band scales with the block, so
 *  the lit top course stays a constant FRACTION of it at every zoom. */
function capInner(flatten: number): ExpressionSpecification {
  return ['max', 0, ['-', steppedHeight(flatten), CAP_BAND_M * flatten]];
}

/**
 * The body stops exactly where the cap starts. It must NOT run all the way to the
 * roof: two extrusions sharing the top 4.5 m produce coplanar walls, and MapLibre's
 * shared 3D depth range then z-fights them into horizontal stripes across every
 * façade. Body [base, H-cap] + cap [H-cap, H] tile the block with no overlap.
 *
 * Every one of these is built inside ONE outermost zoom interpolation — see the
 * MapLibre constraint note on `withZoomGain`.
 */
function bodyHeight(flatten: number): ExpressionSpecification {
  return withZoomGain(['max', baseInner(flatten), capInner(flatten)]);
}
function bodyBase(flatten: number): ExpressionSpecification {
  return withZoomGain(baseInner(flatten));
}
function capBase(flatten: number): ExpressionSpecification {
  return withZoomGain(capInner(flatten));
}

type ColorExpr = DataDrivenPropertyValueSpecification<string>;

/**
 * Accent assignment, deterministic in the feature id so a block never flickers
 * colour when a tile is re-fetched. Frequencies match the reference render:
 * teal-slate ~1 in 17, rose ~1 in 41 (rare and warm, a foreground note only),
 * and a second ordinary violet on ~1 in 5 so the massing isn't one flat colour.
 */
function faceColor(p: VoxelPalette, face: 'wall' | 'roof', muted: boolean): ColorExpr {
  if (muted) return face === 'wall' ? p.mutedWall : p.mutedRoof;
  const wall = face === 'wall';
  // Moduli 3 and 7 for the ordinary tones, NOT 5 — 5 is what the roof tie-break in
  // `quantizedHeight` uses, and reusing it would lock colour to height so every
  // block of a given tone sat at exactly the same sub-tier, undoing the separation.
  return [
    'case',
    ['==', ['%', FEATURE_ID, 41], 5], wall ? p.roseWall : p.roseRoof,
    ['==', ['%', FEATURE_ID, 23], 3], wall ? p.tealWall : p.tealRoof,
    ['==', ['%', FEATURE_ID, 3], 1], wall ? p.wallAlt : p.roofAlt,
    ['==', ['%', FEATURE_ID, 7], 2], wall ? p.wallAlt2 : p.roofAlt2,
    wall ? p.wall : p.roof,
  ] as ColorExpr;
}

/** Fade the city in over a narrow zoom band. Sits at exactly 1 above the band so
 *  MapLibre keeps the cheap opaque path (opacity < 1 forces an extra framebuffer). */
const OPACITY_RAMP: ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'],
  VOXEL_MIN_ZOOM, 0,
  VOXEL_MIN_ZOOM + 0.7, 1,
];

// ---------------------------------------------------------------- quality gate

/**
 * Resolve `auto` against the device. Extrusions are a real GPU cost, so `auto`
 * only reaches `full` on a machine that looks like it can hold 60fps: enough
 * cores, enough RAM, and a GPU that isn't a software rasteriser.
 * Conservative on purpose — the wrong answer here is a janky map, not a flat one.
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

/** Building extrusions run at Full quality ONLY. Reduced and Lite get the flat map. */
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
  sourceId: string;
  sourceLayer: string;
  routeFocused: boolean;
  /** Style light before we touched it, so removal is a true undo. */
  prevLight: LightSpecification | null;
  flatBuildingWasVisible: boolean;
}

const STATE = new WeakMap<MlMap, VoxelState>();

/** How much the city collapses when a route is focused: unrelated massing drops
 *  to a third of its height and desaturates toward the ground so the red route
 *  line and its stop dots own the frame. */
export const FOCUS_FLATTEN = 0.34;

/**
 * Where to slot the extrusions so they can never occlude anything that matters.
 * Preference order:
 *   1. the first GhostBus overlay (walk path / route / stops / vehicles), which is
 *      what MapCard installs on top of the style;
 *   2. failing that — the city can be added before those exist — the first symbol
 *      layer, so basemap street and place labels still read over the massing.
 * Returning `undefined` (append on top) is the last resort only.
 */
export function voxelInsertionPoint(map: MlMap): string | undefined {
  return insertionPoint(map);
}

/** See LABEL_ABOVE_LAYER_IDS. `undefined` when none of them exist yet, in which
 *  case the caller falls back to the extrusion insertion point. */
function labelInsertionPoint(map: MlMap): string | undefined {
  for (const id of LABEL_ABOVE_LAYER_IDS) if (map.getLayer(id)) return id;
  return undefined;
}

function insertionPoint(map: MlMap): string | undefined {
  for (const id of OVERLAY_LAYER_IDS) if (map.getLayer(id)) return id;
  const layers = map.getStyle()?.layers ?? [];
  for (const l of layers) {
    if (l.type === 'symbol' && !VOXEL_LAYER_IDS.includes(l.id as (typeof VOXEL_LAYER_IDS)[number])) {
      return l.id;
    }
  }
  return undefined;
}

/**
 * Move every basemap symbol layer above the extrusions (but still below the
 * GhostBus overlays, so a street name can never cover the route or a vehicle).
 *
 * Not undone by `removeVoxelCityLayers`, and deliberately so: labels-over-buildings
 * is the correct order in the flat map too (there the `building` layer is a fill
 * that labels should sit on top of anyway), so there is nothing to restore. A
 * theme swap rebuilds the style from scratch and re-runs this.
 */
function liftBasemapLabels(map: MlMap, basemapSource: string, before: string | undefined): void {
  const layers = map.getStyle()?.layers ?? [];
  for (const l of layers) {
    // BASEMAP symbol layers only, identified by their source — not "every symbol
    // layer that isn't one of ours". The first version used a name blocklist and
    // quietly relocated MapCard's `marker-blockers` layer, which has to stay the
    // topmost symbol layer to win collisions (MapLibre places symbol layers from
    // the top of the style downward). Sourcing off the vector tiles is the property
    // that actually distinguishes a street name from an app overlay.
    if (l.type !== 'symbol') continue;
    if (!('source' in l) || l.source !== basemapSource) continue;
    try { map.moveLayer(l.id, before); } catch { /* layer vanished mid-swap */ }
  }
}

/** `setLight` runs `_checkLoaded()` and throws mid-`setStyle`. Never let the host
 *  app take an exception from a decorative layer. */
function safeSetLight(map: MlMap, light: LightSpecification): void {
  try {
    map.setLight(light);
  } catch {
    /* style is mid-swap; the next add/theme call re-applies it */
  }
}

/**
 * Add the voxel city to a live map. Idempotent, and a safe no-op when the vector
 * source isn't there (a failed tile load must degrade to the honest flat/list
 * fallback, never to a half-built city).
 *
 * @returns true if the layers are now present.
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
  if (hasVoxelCityLayers(map) && existing) {
    setVoxelCityTheme(map, theme);
    if (opts.routeFocused !== undefined) setVoxelCityRouteFocus(map, opts.routeFocused);
    return true;
  }

  // Anything else — half-installed (one addLayer threw), or installed but with no
  // tracked state (module HMR, or a caller that lost the map reference) — is swept
  // and rebuilt. A partial city with untracked state is unrecoverable: every later
  // theme/focus call becomes a silent no-op and removal can't undo what it never saw.
  for (const id of VOXEL_LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id);

  const p = voxelPalette(theme);
  const focused = opts.routeFocused ?? existing?.routeFocused ?? false;
  const flatten = focused ? FOCUS_FLATTEN : 1;

  // The flat 2D footprints would z-fight the extruded ones. Record the pre-existing
  // visibility from the CURRENT style — after a `setStyle({diff:false})` the old
  // recorded value describes a style that no longer exists.
  let flatWasVisible = existing?.flatBuildingWasVisible ?? true;
  if (map.getLayer(FLAT_BUILDING_LAYER)) {
    flatWasVisible = map.getLayoutProperty(FLAT_BUILDING_LAYER, 'visibility') !== 'none';
    map.setLayoutProperty(FLAT_BUILDING_LAYER, 'visibility', 'none');
  }

  const before = insertionPoint(map);

  map.addLayer(
    {
      id: VOXEL_BODY_LAYER,
      type: 'fill-extrusion',
      source: sourceId,
      'source-layer': sourceLayer,
      minzoom: VOXEL_MIN_ZOOM,
      filter: MIN_HEIGHT_FILTER,
      paint: {
        'fill-extrusion-color': faceColor(p, 'wall', focused),
        'fill-extrusion-height': bodyHeight(flatten),
        'fill-extrusion-base': bodyBase(flatten),
        'fill-extrusion-opacity': OPACITY_RAMP,
        // OFF on purpose. The vertical gradient is what makes MapLibre extrusions
        // read as smooth architectural prisms; the reference's blocks have hard
        // flat faces. Flat faces are the look.
        'fill-extrusion-vertical-gradient': false,
      },
    },
    before,
  );

  map.addLayer(
    {
      id: VOXEL_CAP_LAYER,
      type: 'fill-extrusion',
      source: sourceId,
      'source-layer': sourceLayer,
      minzoom: VOXEL_MIN_ZOOM,
      filter: MIN_HEIGHT_FILTER,
      paint: {
        'fill-extrusion-color': faceColor(p, 'roof', focused),
        'fill-extrusion-height': quantizedHeight(flatten),
        'fill-extrusion-base': capBase(flatten),
        'fill-extrusion-opacity': OPACITY_RAMP,
        // Flat, unshaded band — this is the lit edge that makes a block a block.
        'fill-extrusion-vertical-gradient': false,
      },
    },
    before,
  );

  // DESIGN-TARGET §C: "Buildings must never occlude the route, stops, markers,
  // LABELS, vehicles or the You beacon." The overlays are handled by inserting the
  // extrusions beneath them; basemap labels are not, because they live BELOW the
  // insertion point in the style order and would be drawn before — and therefore
  // behind — every block. Lifting them to just under the overlays is what makes
  // "King St West" readable along a street with towers on both sides.
  liftBasemapLabels(map, sourceId, labelInsertionPoint(map) ?? before);

  const prevLight = existing?.prevLight ?? safeGetLight(map);
  safeSetLight(map, p.light);

  STATE.set(map, {
    theme,
    sourceId,
    sourceLayer,
    routeFocused: focused,
    prevLight,
    flatBuildingWasVisible: flatWasVisible,
  });
  return true;
}

/** Take the city back out and undo everything it touched. Safe to call twice, and
 *  a true no-op on a map that never had it (it must not un-hide a `building` layer
 *  that somebody else deliberately turned off). */
export function removeVoxelCityLayers(map: MlMap): void {
  const st = STATE.get(map);
  for (const id of VOXEL_LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id);
  if (!st) return;
  if (map.getLayer(FLAT_BUILDING_LAYER) && st.flatBuildingWasVisible) {
    map.setLayoutProperty(FLAT_BUILDING_LAYER, 'visibility', 'visible');
  }
  if (st.prevLight) safeSetLight(map, st.prevLight);
  STATE.delete(map);
}

export function hasVoxelCityLayers(map: MlMap): boolean {
  return !!map.getLayer(VOXEL_BODY_LAYER) && !!map.getLayer(VOXEL_CAP_LAYER);
}

/** Repaint to the other theme without rebuilding the layers (theme swaps are hot). */
export function setVoxelCityTheme(map: MlMap, theme: VoxelTheme): void {
  if (!hasVoxelCityLayers(map)) return;
  const st = STATE.get(map);
  const p = voxelPalette(theme);
  const focused = st?.routeFocused ?? false;
  map.setPaintProperty(VOXEL_BODY_LAYER, 'fill-extrusion-color', faceColor(p, 'wall', focused));
  map.setPaintProperty(VOXEL_CAP_LAYER, 'fill-extrusion-color', faceColor(p, 'roof', focused));
  safeSetLight(map, p.light);
  if (st) STATE.set(map, { ...st, theme });
}

/**
 * Focus mode: when a route line is on the map, the city mutes toward the ground
 * tone and collapses to `FOCUS_FLATTEN` of its height, so the only loud thing in
 * frame is the red stroke. Muting is done with COLOUR, not opacity — translucent
 * extrusions force MapLibre onto an extra framebuffer, and this has to stay cheap.
 */
export function setVoxelCityRouteFocus(map: MlMap, focused: boolean): void {
  const st = STATE.get(map);
  if (!hasVoxelCityLayers(map) || !st || st.routeFocused === focused) return;
  const p = voxelPalette(st.theme);
  const flatten = focused ? FOCUS_FLATTEN : 1;
  map.setPaintProperty(VOXEL_BODY_LAYER, 'fill-extrusion-color', faceColor(p, 'wall', focused));
  map.setPaintProperty(VOXEL_CAP_LAYER, 'fill-extrusion-color', faceColor(p, 'roof', focused));
  map.setPaintProperty(VOXEL_BODY_LAYER, 'fill-extrusion-height', bodyHeight(flatten));
  map.setPaintProperty(VOXEL_CAP_LAYER, 'fill-extrusion-height', quantizedHeight(flatten));
  map.setPaintProperty(VOXEL_BODY_LAYER, 'fill-extrusion-base', bodyBase(flatten));
  map.setPaintProperty(VOXEL_CAP_LAYER, 'fill-extrusion-base', capBase(flatten));
  STATE.set(map, { ...st, routeFocused: focused });
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
   * strictly alone — required if the camera was just placed by a `fitBounds`,
   * which this would otherwise silently undo.
   */
  minZoom?: number | null;
  animate?: boolean;
}

/**
 * Tip the camera into the diorama. Honours `prefers-reduced-motion` by cutting
 * rather than easing — there is no drift, no orbit, no idle animation anywhere
 * in this module; the city renders its final state and stops.
 *
 * Note this only ever zooms IN, to the diorama floor. It never zooms out, so it
 * is safe to call on a user who has deliberately zoomed past it.
 */
export function applyVoxelCamera(map: MlMap, opts: VoxelCameraOptions = {}): void {
  const pitch = opts.pitch ?? VOXEL_PITCH;
  // Raise the ceiling BEFORE setting pitch, or MapLibre clamps to its default 60.
  if (map.getMaxPitch() < pitch) map.setMaxPitch(Math.max(pitch, VOXEL_MAX_PITCH));
  const floor = opts.minZoom === undefined ? VOXEL_DIORAMA_ZOOM : opts.minZoom;
  const bearing = opts.bearing === undefined ? VOXEL_BEARING : opts.bearing;
  const camera: { pitch: number; zoom?: number; bearing?: number } = { pitch };
  if (floor !== null) camera.zoom = Math.max(map.getZoom(), floor);
  if (bearing !== null) camera.bearing = bearing;
  if (opts.animate === false || prefersReducedMotion()) map.jumpTo(camera);
  else map.easeTo({ ...camera, duration: 700 });
}

/** Put the camera back flat and north-up (used when quality drops out of Full).
 *  Restores MapLibre's default pitch ceiling so the app is left as it was found. */
export function resetVoxelCamera(map: MlMap, animate = true): void {
  const camera = { pitch: 0, bearing: 0 };
  if (!animate || prefersReducedMotion()) map.jumpTo(camera);
  else map.easeTo({ ...camera, duration: 500 });
  map.setMaxPitch(60);
}

function safeGetLight(map: MlMap): LightSpecification | null {
  try {
    return map.getLight() ?? null;
  } catch {
    return null;
  }
}
