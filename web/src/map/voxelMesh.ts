// VOXEL MESH — the reference diorama rendered with Three.js inside MapLibre's own
// WebGL context, as a `type: 'custom'`, `renderingMode: '3d'` layer.
//
// WHY THIS EXISTS AT ALL (and what the fill-extrusion version could and could not do).
//
// The previous city (see the git history of voxelCity.ts) was two `fill-extrusion`
// layers. A common claim about that approach is that it "shades by height, not by
// face orientation". THAT CLAIM IS FALSE, and it is worth writing down because it
// nearly sent this pass in the wrong direction. MapLibre's fill-extrusion vertex
// shader reads, verbatim:
//
//     float directional = clamp(dot(normalForLighting, u_lightpos), 0.0, 1.0);
//     directional = mix((1.0 - u_lightintensity),
//                       max((1.0 - colorvalue + u_lightintensity), 1.0), directional);
//
// — that IS per-face directional shading off the face normal. With light intensity
// ~0.51 and a light at polar ~48 deg it can be driven to the exact top:wall:wall
// luminance ratio measured off the reference (1 : 0.64 : 0.49; see the measurement
// note on FACE_TONES below). So face shading was never the blocker.
//
// What fill-extrusion genuinely cannot do, and why this module exists:
//
//   1. NO FOOTPRINT INSET. The whole paint spec is opacity / color / translate /
//      pattern / height / base / vertical-gradient. Two abutting OSM footprints
//      cannot be pulled apart, so the reference's dark gap between blocks — the
//      single strongest "these are separate solid cubes" cue — is unreachable.
//      voxelCity.ts worked around it with five sub-tiers of roof height; the seam
//      it buys is a step in the skyline, not a gap on the ground.
//   2. NO AMBIENT OCCLUSION / CONTACT DARKENING. `fill-extrusion-vertical-gradient`
//      is the only vertical modulation available and it is not AO: it ramps over the
//      WHOLE wall (not the bottom metre or two), its floor is
//      `mix(0.7, 0.98, 1 - intensity)` so it can darken by at most ~16%, and it is
//      scaled by `pow(height/150, 0.5)` so short buildings barely get any. Turning
//      it on is also what makes blocks read as smooth architectural prisms, which is
//      why it was switched off. There is no ground contact shadow of any kind.
//   3. NO PER-FACE TEXTURE. The reference is a VOXEL render: every block is visibly
//      built out of stacked cubes, with seams on the roof grid and courses up the
//      walls. `fill-extrusion-pattern` tiles in tile space, not per-face UV space,
//      so it cannot draw a cube lattice on a facade.
//   4. ROOF AND WALL CANNOT BE COLOURED INDEPENDENTLY. One `fill-extrusion-color`
//      per layer, and the roof/wall split comes only from the single light. The old
//      two-layer "cap band" hack is a coplanar-wall z-fighting hazard that has to be
//      dodged by tiling the body and cap heights exactly.
//
// For completeness: PERSPECTIVE was also not a blocker. MapLibre v6 ships
// `map.setVerticalFieldOfView()`, and narrowing the FOV pushes the camera back while
// holding the centre scale, which flattens perspective toward the reference's
// axonometric look. voxelCity.ts uses it; it is not a reason to leave fill-extrusion.
//
// WHAT IS DRAWN, AND WHAT IS NOT INVENTED.
//
// Every block is ONE real OpenStreetMap building from the same OpenFreeMap vector
// tiles the basemap already loads. Nothing is hand-modelled, nothing is generated,
// and no two footprints are ever merged into a structure that does not exist. Five
// documented decorative transforms are applied, all of them the same class of
// stylisation as the height quantisation this project has always used:
//
//   a. Each footprint is drawn as its PCA-oriented bounding box — one block per real
//      building, at the building's real position, real orientation and real extent.
//   b. That box is scaled about its own centre until it covers the same GROUND AREA
//      the real ring does (AREA_TRUE_MIN). An oriented box CIRCUMSCRIBES a
//      non-rectangular footprint, so without this a block stands on ground its
//      building does not; the correction only ever shrinks, never enlarges.
//   c. It is then inset by INSET_M so abutting buildings show the reference's dark
//      gap instead of fusing into one mass. (b) makes the block honest about its
//      area; (c) is the gap, on top, and after both the drawn area is a little under
//      the truth rather than a little over.
//   d. Heights are quantised onto a shared lattice (voxelCity.ts owns that maths),
//      plus a deterministic sub-decimetre coplanar tie-break (COPLANAR_EPS_M).
//   e. Footprints below a screen-size floor are OMITTED at wide framings — ordinary
//      cartographic generalisation, and voxelCity's `minFootprintAreaM2` argues the
//      case. Omission, never invention: nothing is merged, moved or made up, and
//      zooming in brings every one of them back.
//
// No transit datum anywhere in GhostBus is styled, derived from, or scaled like any
// of this. It is scenery.

import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import type {
  Map as MlMap,
  CustomLayerInterface,
  CustomRenderMethodInput,
  GeoJSONFeature,
} from 'maplibre-gl';

import {
  DEFAULT_HEIGHT_M,
  HEIGHT_STEP_M,
  quantizeHeightM,
  minHeightForZoom,
  minFootprintAreaM2,
  zoomHeightGain,
  FOCUS_FLATTEN,
  type VoxelTheme,
} from './voxelCity';

export const VOXEL_MESH_LAYER = 'voxel-city-3d';

// ---------------------------------------------------------------- measurement

/**
 * FACE TONES — measured off `ghostbus-design-reference.png`, not chosen.
 *
 * Method (scratchpad `corners.py`): the reference is an orthographic voxel render,
 * so every block presents a NEAR VERTICAL EDGE where its two visible walls meet.
 * That edge is unambiguous in the image — a long run of consecutive rows at one
 * column where the horizontal colour step exceeds a threshold — and its geometry
 * pins all three faces at once: the left wall is immediately left of the edge, the
 * right wall immediately right of it, and the roof sits directly above the edge's
 * top endpoint. So each detected edge yields a TRIPLE sampled from one building,
 * with no segmentation, no colour clustering and no guessed coordinates.
 *
 * 37 such edges were found in the desktop map region (x 360..1069, y 88..689 of the
 * reference sheet) after masking the red route, the trees, the marker cards and the
 * street labels. 24 of them have the roof as the brightest of the three, which is
 * the sanity condition for a lit-from-above render; the other 13 are edges where
 * the "roof" sample landed on ground behind the building and are discarded.
 *
 * Over those 24, relative luminance (Rec.709):
 *
 *     TOP : LEFT : RIGHT  =  1.000 : 0.641 : 0.491      (medians)
 *                            1.000 : 0.646 : 0.513      (trimmed means)
 *     interquartile range   L/T 0.568..0.739,  R/T 0.454..0.590
 *     LEFT is the brighter wall in 73% of all 37 detected edges.
 *
 * Two top-face families fall out of the same 24 samples, split on luminance:
 *   indigo   mean top #21294b (lum 42), n=12
 *   lavender mean top #484a72 (lum 76), n=12
 * with top-face hue centred at 232 deg and saturation 0.37..0.69.
 *
 * The DAYLIGHT panel was measured the same way on the light phone card (a 280x166
 * region, upscaled 4x with Lanczos so the run-length thresholds still bite). Only 3
 * edges survive at that size, but they agree to within 0.008:
 *
 *     TOP : LEFT : RIGHT  =  1.000 : 0.808 : 0.983      top #f3f1ec, left #c6c3c1
 *
 * Note the HANDEDNESS FLIPS between the two panels, which was confirmed by eye at
 * 8x on single blocks before it was believed: the night render is lit from the
 * screen-left, so its left wall is the bright one; the daylight render is lit from
 * the screen-right, so its LEFT wall is the shaded one and its right wall is within
 * 2% of the roof. That is why daylight leans on ground contact shadows for block
 * separation where the night render leans on wall tone — see SHADOW_ALPHA.
 */
interface FaceTones {
  /** wall/top luminance ratio for the lit wall */
  lit: number;
  /** wall/top luminance ratio for the shaded wall */
  shade: number;
  /**
   * Which screen direction the lit wall faces, in degrees measured clockwise from
   * screen-up. 225 = lower-left (night), 135 = lower-right (daylight). Anchored to
   * the VIEWPORT, not to the world: this is a diorama with a studio lamp, not a sun,
   * so the lit side must not swing when the map is rotated.
   */
  litScreenDeg: number;
}

const TONES: Record<VoxelTheme, FaceTones> = {
  dark: { lit: 0.641, shade: 0.491, litScreenDeg: 225 },
  light: { lit: 0.983, shade: 0.808, litScreenDeg: 135 },
};

/**
 * Top-face colours. These are the AUTHORED material colour of a block — the two
 * wall tones are derived from it by TONES above, exactly as one light would.
 *
 * The night families are the two measured clusters, plus the rare teal and rose
 * accents §31 measured (frequencies unchanged from voxelCity.ts's `faceColor`, which
 * a previous pass corrected from "five times too common" to ~1% each).
 */
interface MeshPalette {
  tops: string[];
  /** index weights: `tops[pick(id)]`, keyed off the stable feature id */
  ground: string;
  shadow: string;
  shadowAlpha: number;
  /** Occlusion in the crevice where a cube abuts a shorter neighbour. */
  crevice: number;
  /** Ground contact darkening at the foot of a wall. */
  aoStrength: number;
  /** Across-face gradient amplitude — no face in the reference is one flat tone. */
  gradient: number;
}

const PALETTES: Record<VoxelTheme, MeshPalette> = {
  dark: {
    // The two measured families (indigo #21294b, lavender #484a72) plus the
    // blue-slate, violet, teal and rose accents §31 measured — every one of them
    // SCALED BY 1.3, and that scale is a deliberate, measured trade rather than a
    // fudge. See the note on TOP_GAIN below.
    // MEASURED, then corrected once against the render — see the hueJitter note.
    // Family hue / HSV-sat / Rec.709 luminance, in dealt order:
    //   A indigo-violet 235 / 0.50 / 52   (34%)   B lavender     245 / 0.38 / 70 (30%)
    //   C blue-slate    227 / 0.52 / 60   (26%)   D violet       257 / 0.48 / 62 ( 6%)
    //   teal 190 / 0.42 / 55 (2%)         rose   300 / 0.42 / 64 (2%)
    // LIFTED 1.28x over �38's values (1.14 then 1.12), and the lift is measured rather than judged:
    // running �38's own vertical-edge sampler over BOTH images gives a median
    // top-face luminance of 63 on the reference and 55 on our render. Same code,
    // same masking, both panels � so the roofs really were eight levels dark, and
    // the frame histogram agreed (bands 64-80 and >80 sat at 4.1 / 3.4 against the
    // reference's 12.3 / 6.1). Hue and saturation are untouched; this is value only.
    tops: ['#3a4076', '#5a5489', '#3e4b80', '#5a4787', '#2f4b52', '#744374'],
    ground: '#0e142b',
    shadow: '#05070f',
    // Night: the wall tones already separate the blocks, so the contact shadow is a
    // whisper. Measured on the reference, the darkening under a block bottoms out
    // ~18% below the surrounding ground.
    shadowAlpha: 0.34,
    // Night leans on wall TONE for separation, so the crevice can be firm without
    // muddying the frame; the gradient stays small because the measured face ratios
    // (1.000 : 0.641 : 0.491) are what the palette match is pinned to and a large
    // ramp would smear them together.
    crevice: 0.30,
    aoStrength: 0.34,
    gradient: 0.10,
  },
  light: {
    tops: ['#f3f1ec', '#eceae4', '#f6f4f1', '#eee9f0', '#dfe6df', '#f0e3e2'],
    ground: '#cfc9c1',
    shadow: '#7d7a74',
    // Daylight: the right wall is within 2% of the roof, so almost all of the block
    // separation in the reference's light panel comes from the shadow on the ground.
    // This is the single largest reason the old fill-extrusion light theme read as
    // "near-uniform white" — it had no shadows at all.
    shadowAlpha: 0.46,
    // Daylight's right wall is within 2% of its roof, so tone separates almost
    // nothing and the crevice has to do more of the work of showing where one cube
    // ends and the next begins.
    crevice: 0.34,
    aoStrength: 0.22,
    gradient: 0.09,
  },
};

// ---------------------------------------------------------------- geometry knobs

/**
 * Footprint inset in metres, per side. Produces the reference's dark gap between
 * abutting blocks — the thing `fill-extrusion` structurally could not do.
 *
 * Small on purpose. Downtown Toronto's OSM footprints have a median span around
 * 24 m, so 1.2 m a side is ~10% of a block, which is about what the reference shows.
 *
 * IT IS NO LONGER DOING TWO JOBS. It used to be justified partly as the counterweight
 * to the circumscribed oriented box, which over-covers a non-rectangular footprint.
 * The area-true scale below now does that job properly and measurably, so this is the
 * GAP and only the gap. The two do compound — the total pull-in per side is
 * `(1 - k) * half + INSET_M`.
 *
 * §41 left the value where the reference measurement put it rather than re-tuning it on
 * top of the new area-true scale. §42 DID sweep it — at 0.5, 0.9, 1.2, 1.6, 2, 3, 4 and
 * 6 m, a production build and its own browser window each — and the answer is that 1.2
 * is already in the only safe interval, pinned from BOTH sides:
 *
 *   below ~0.9 m the banding comes back. At 0.5 m the boxes close back up on each other
 *   and `zfight.py` reports 0.039% of the frame banded against the reference's 0.012%
 *   and this build's 0.009% — i.e. worse than §41's pre-fix render. The inset is part of
 *   the coplanar-roof fix, not merely decoration;
 *
 *   above ~1.6 m every honest structural statistic degrades monotonically. Per metre of
 *   inset the city loses ~3 points of built coverage and its ground corridors widen, and
 *   we are ALREADY 15 points short of the reference on coverage and 3x too wide on
 *   corridors (§42 measures 44% vs 59%, and 17.0 m vs 6.0 m). An inset that separates
 *   masses does it by shrinking buildings we do not have enough of.
 *
 * Between 0.9 and 1.6 nothing is resolvable: the run-to-run spread of the probe on ONE
 * unchanged configuration is larger than the difference (§42 quantifies it). So 1.2 sits
 * mid-interval and there is no measured reason to move it. Do not re-sweep this without
 * first reading DECISIONS §42 — the instrument that made the old numbers look like a
 * welding problem was counting the road network as buildings.
 */
const INSET_M = 1.2;
/** A block never insets below this half-extent, so small real buildings survive. */
const MIN_HALF_M = 2.4;

/**
 * AREA-TRUE BOX. The PCA box CIRCUMSCRIBES the ring, so it over-covers every footprint
 * that is not a rectangle — measured on the 796 rings in the default frame, the ring
 * fills its own box to a median of 0.888 and a mean of 0.806, with a p10 of 0.498.
 * That surplus is ground the building does not stand on, drawn as if it did, and it is
 * also the direct cause of §41's second gap: two boxes that over-cover into each other
 * overlap, and 1,360 of the 2,252 overlapping pairs in view carry the SAME quantised
 * roof height (the lattice has only four values here — 17 / 34 / 51 / 68 m), which is
 * an exactly coplanar pair of roof quads and therefore a depth-buffer tie.
 *
 * So the box is scaled about its own centre until its area equals the ring's:
 * `k = sqrt(ringArea / boxArea)`, clamped to never ENLARGE and never to shrink past
 * `AREA_TRUE_MIN` (a ring that is nearly a line — a wall, a canopy, a mis-digitised
 * sliver — must not collapse a real building to a dot).
 */
const AREA_TRUE_MIN = 0.55;

/**
 * COPLANAR TIE-BREAK, in metres. The area-true box removes most of the overlaps; it
 * cannot remove them all, because some OSM buildings genuinely overlap (a tower over
 * its own podium, a building and its parts, the same block digitised twice in two
 * overscaled z14 tiles). Where two boxes still overlap AND land on the same course of
 * the shared height lattice, their roofs are the same plane to the last bit and the
 * depth test has no answer — which is exactly the horizontal comb §41 found on our
 * faces and the reference does not have.
 *
 * A deterministic per-footprint offset of at most 22 cm, keyed off the same id as the
 * tint, gives the depth test a definite answer: the pair reads as one roof lying on
 * another instead of as a stripe. At the diorama's 0.38 m/px it is well under one
 * pixel of height, so it changes no measured tone and no silhouette.
 *
 * TWO HONEST LIMITS, both recorded in DECISIONS §41 rather than papered over:
 *   * it is exactly as stable as the tint key it shares, and that key mixes in a
 *     counter over the whole `querySourceFeatures` result rather than a per-feature
 *     ring index — so it does re-deal when the loaded tile set changes. That is a
 *     pre-existing property of `tintKey`, it moves every block's COLOUR too, and it is
 *     deliberately not changed in the same pass that measured this render;
 *   * route focus scales it by FOCUS_FLATTEN along with every other height, leaving
 *     ~7 cm. If a comb ever reappears, expect it there first.
 */
const COPLANAR_EPS_M = 0.22;

/**
 * The most of a neighbourhood the generalisation floor may ever omit — the safety net
 * that stops a floor calibrated downtown from deleting a low-rise one. Argued where it
 * is applied, in `build`.
 *
 * 0.65 is not a taste call. Measured on the population this code actually sees — the
 * 2,059 loaded rings that survive `minHeightForZoom` at the default framing — the
 * settled screen-size floor of 499 m2 omits 58.6% of them (56.8% of the 796 in view).
 * So the cap sits above the framing the whole of §41 was measured on and changes
 * nothing about it; it only binds somewhere the data is finer-grained than downtown.
 */
const MAX_OMIT_FRACTION = 0.65;
/** Sanity ceiling on a block's half-extent — see the note in `build`. Toronto's
 *  longest single building (the Eaton Centre) is ~300 m end to end, so a half-extent
 *  above 300 m is a tile-generalisation artifact, not architecture. */
const MAX_HALF_M = 300;

/**
 * VOXEL CELL SIZE — and this is now the size of a REAL CUBE, not of a texture seam.
 *
 * §38 drew one smooth prism per footprint and painted a lattice on its faces to
 * suggest cubes. Magnifying the reference to 5x shows why that could never land:
 * **every building mass in the reference is a CLUSTER of 4-6 discrete cubes at
 * different heights**, with real seams between them, real ambient occlusion in the
 * crevices where a tall cube meets a short one, and visibly softened edges. A painted
 * lattice on one prism has none of those three things — it reads as architecture with
 * a grid on it. The original project spec asked for exactly the cluster ("one box, or
 * a few stacked boxes, with footprint and height quantised to a chunky voxel grid");
 * it was lost somewhere between there and §38.
 *
 * MEASURED off the reference at 5x, on the desktop map region at §32's 0.95 m/px:
 * a building mass ~120 px across resolves into 4 roof cells, and one ~80 px across
 * into 3 — so the cube pitch is ~27 px, i.e. **~25 m of ground**. Swept at 17 / 20 /
 * 24 / 30 m; see DECISIONS §39 for the numbers behind the choice.
 *
 * It is also a near-exact match for voxelCity's 24 m HEIGHT_STEP_M, which is what
 * makes each emitted box an actual CUBE rather than a slab: one cell wide, one cell
 * deep, one course tall.
 */
const CELL_M = 24;

/** Hard cap on cells per axis for one footprint. A 300 m mall at 24 m cells is 12
 *  across; past this the extra cubes are below a pixel and only cost instances. */
const MAX_CELLS_PER_AXIS = 9;

/**
 * How much of a course a cell may drop below its building's real quantised height.
 *
 * This is the "differing heights" in the reference's clusters, and it is the one knob
 * here that has to justify itself as stylisation rather than invention. It never adds
 * height — a cell is either at the footprint's own quantised height or exactly one
 * course below it — and at least one cell per footprint is always at the full height,
 * so the building's real height is still what the mass reads as. The variation is
 * within what the footprint's own height supports, in the same sense that a hatching
 * or halftone screen varies within the tone of the photograph it renders.
 */
const CELL_DROP_CHANCE = 0.42;

/** How far up a wall the ground contact darkening reaches. */
const AO_HEIGHT_M = 9;

/**
 * Bevel width in metres. The reference's cubes are not razor-sharp — the edges read
 * soft and toy-like, which is a large part of why it looks like voxel art rather than
 * CAD. Rather than bevelling the geometry (12 extra tris an instance, times ~7,000
 * instances), the shader blends each face's tone toward its neighbour across the last
 * couple of metres, which is what a rounded edge does to the light anyway.
 */
const BEVEL_M = 1.4;

/**
 * How far ABOVE a short neighbour's roofline the crevice occlusion reaches on the
 * tall cube's wall. Roughly a third of a cell: in the reference the darkening in an
 * inner corner fades out well before the top of the taller cube.
 */
const CREVICE_M = 8;

/**
 * Tallest a cluster may be drawn, as a multiple of its own narrowest footprint span.
 *
 * The spike guard. Toronto's tiles carry plenty of 6-8 m laneway and infill
 * footprints, and a quantised 2-3 courses on one of those renders as a needle — the
 * reference contains nothing remotely like it, and at 5x they were the loudest
 * artefact in the first cluster build. 2.2 lets a real tower on a real tower-sized
 * footprint keep its courses while collapsing the needles to one cube.
 */
const MAX_ASPECT = 2.2;

/** Hard ceiling on instances. Beyond this the smallest FOOTPRINTS are dropped, whole
 *  — never a cell out of the middle of a building, which would punch a hole in it. */
const MAX_INSTANCES = 40000;

/** Re-anchor the scene origin when the camera has wandered this far, so scene-space
 *  metres stay small and float32 in the shader stays exact. */
const ORIGIN_REANCHOR_M = 4000;

// ---------------------------------------------------------------- shaders

const VERT = /* glsl */ `
precision highp float;

attribute vec3 iSize;     // metres: full width, depth, height OF THIS ONE CUBE
attribute vec3 iColor;    // authored top-face colour
attribute vec4 iNbr;      // body-metre heights of the -x, +x, -y, +y neighbour cubes

uniform float uHeightGain;  // camera-zoom height gain (voxelCity.zoomHeightGain)
uniform float uFlatten;     // route-focus collapse

varying vec3 vColor;
varying vec3 vNormalW;
varying vec3 vNormalL;    // the cube's OWN frame — picks the neighbour and the edges
varying vec3 vLocalM;     // metres from the cube centre (x,y) / its base (z)
varying vec3 vHalfM;      // this cube's half extents, post-scale
varying float vUpM;       // metres above the cube's base
varying vec4 vNbr;

void main() {
  vColor = iColor;

  float hScale = uHeightGain * uFlatten;
  vec3 local = vec3(position.x * iSize.x, position.y * iSize.y, position.z * iSize.z * hScale);

  vLocalM = local;
  vHalfM = vec3(iSize.x * 0.5, iSize.y * 0.5, iSize.z * hScale);
  vUpM = local.z;
  vNbr = iNbr * hScale;
  vNormalL = normal;

  // instanceMatrix carries rotation + translation only (no scale), so its upper 3x3
  // is a pure rotation and doubles as the normal matrix.
  vNormalW = normalize(mat3(instanceMatrix) * normal);

  vec4 world = instanceMatrix * vec4(local, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * world;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform vec2 uLitAxis;      // world-XY direction the LIT wall faces (viewport-anchored)
uniform float uLit;         // lit-wall / top luminance ratio
uniform float uShade;       // shaded-wall / top luminance ratio
uniform float uAo;          // ground contact darkening, 0..1
uniform float uAoHeightM;
uniform float uCrevice;     // crevice occlusion between abutting cubes, 0..1
uniform float uCreviceM;    // how far the crevice gradient reaches, metres
uniform float uBevelM;      // bevel width, metres
uniform float uGrad;        // across-face gradient amplitude, 0..1
uniform vec3  uMute;        // route-focus target colour
uniform float uMuteMix;

varying vec3 vColor;
varying vec3 vNormalW;
varying vec3 vNormalL;
varying vec3 vLocalM;
varying vec3 vHalfM;
varying float vUpM;
varying vec4 vNbr;

void main() {
  vec3 base = mix(vColor, uMute, uMuteMix);

  bool isTop = vNormalW.z > 0.5;

  // --- the three measured face levels (§38: 1.000 : 0.641 : 0.491) --------------
  // Computed for BOTH walls up front, because the bevel needs to know what the face
  // across each edge is doing.
  vec2 hw = vNormalW.xy;
  float lenW = max(length(hw), 1e-4);
  float toneThis;
  if (isTop) {
    toneThis = 1.0;
  } else {
    // A narrow smoothstep rather than a hard step: two flat tones on the grid-aligned
    // cubes that dominate the frame, without aliasing along the edge of the handful
    // sitting at 45 degrees to the light.
    toneThis = mix(uShade, uLit, smoothstep(-0.12, 0.12, dot(hw / lenW, uLitAxis)));
  }

  float tone = toneThis;

  // --- BEVEL: soften every cube edge -------------------------------------------
  // A rounded edge does not change a face's colour, it rotates its normal toward the
  // neighbouring face over the last millimetre or two — so the light it catches
  // crosses smoothly between the two faces. Blending the TONE across the same band is
  // the same thing to within a highlight, at zero geometry cost. It is what turns a
  // razor-sharp CAD prism into the reference's soft, toy-like cube.
  float dEdge;      // metres to the nearest edge of THIS face
  float toneAcross; // the tone of the face on the other side of that edge
  if (isTop) {
    dEdge = min(vHalfM.x - abs(vLocalM.x), vHalfM.y - abs(vLocalM.y));
    // The roof always meets a WALL, and a wall is always darker than the roof, so the
    // exact wall matters less than the fact that the roof dims into it.
    toneAcross = mix(uShade, uLit, 0.5);
  } else {
    float dTopEdge = vHalfM.z - vUpM;                       // meets the roof
    float dSide = (abs(vNormalL.x) > 0.5)
      ? vHalfM.y - abs(vLocalM.y)                            // meets the other wall
      : vHalfM.x - abs(vLocalM.x);
    float dBottom = vUpM;
    if (dTopEdge <= dSide && dTopEdge <= dBottom) { dEdge = dTopEdge; toneAcross = 1.0; }
    // The vertical corner where two walls meet is the ONE edge whose bevel must stay
    // tiny. Blending a lit wall toward a shaded one across it is what closed the
    // measured gap between them from 0.641 : 0.491 to 0.676 : 0.650 � the two walls
    // bunched into near-identical values and the cube structure sank into shadow.
    // The top edge (wall meeting roof) is where the toy-like rounding actually reads,
    // so that one keeps its full blend.
    else if (dSide <= dBottom)                    { dEdge = dSide * 3.0; toneAcross = (toneThis > (uLit + uShade) * 0.5) ? uShade : uLit; }
    else                                          { dEdge = dBottom;  toneAcross = toneThis * (1.0 - uAo); }
  }
  tone = mix(toneAcross, tone, smoothstep(0.0, uBevelM, dEdge) * 0.30 + 0.70);

  // --- FACE GRADIENT: no face in the reference is one flat tone -----------------
  // Walls brighten toward the top, roofs brighten away from the light. Small — this
  // is the difference between "a flat swatch" and "a lit surface", not a new palette,
  // and it is what stops big cube faces owning a whole luminance band.
  float g = isTop
    ? clamp(0.5 + dot(normalize(vec2(vLocalM.x, vLocalM.y) + 1e-4), uLitAxis) * 0.5, 0.0, 1.0)
    : clamp(vUpM / max(vHalfM.z, 1e-3), 0.0, 1.0);
  tone *= 1.0 + uGrad * (g - 0.5);

  // --- CREVICE OCCLUSION where a cube abuts a shorter neighbour -----------------
  // The single strongest voxel cue in the reference after the cluster itself: a tall
  // cube's wall is dark just above the roofline of the short cube pressed against it,
  // fading upward. Below that roofline the wall is hidden anyway; the visible artefact
  // is the gradient in the corner between them.
  if (!isTop) {
    float nbr =
        (vNormalL.x < -0.5) ? vNbr.x
      : (vNormalL.x >  0.5) ? vNbr.y
      : (vNormalL.y < -0.5) ? vNbr.z
      : (vNormalL.y >  0.5) ? vNbr.w : 0.0;
    if (nbr > 0.0) {
      tone *= mix(1.0 - uCrevice, 1.0, smoothstep(nbr, nbr + uCreviceM, vUpM));
    }
  }

  // --- ground contact darkening at the base of every wall ----------------------
  // Scaled to the CUBE, not fixed in metres. A fixed 9 m skirt was a third of a 24 m
  // cube's wall and dragged the whole face down; on the old one-prism-per-building
  // renderer the same 9 m was a small skirt on a much taller wall. AO shapes the
  // bottom of a cube, it does not tint it.
  if (!isTop) {
    float aoH = min(uAoHeightM, vHalfM.z * 0.30);
    tone *= mix(1.0 - uAo, 1.0, smoothstep(0.0, aoH, vUpM));
  }

  gl_FragColor = vec4(base * tone, 1.0);
}
`;

const SHADOW_VERT = /* glsl */ `
precision highp float;
attribute vec2 iExtent;   // full width/depth of the shadow quad, metres
varying vec2 vUv2;
void main() {
  vUv2 = position.xy;                     // plane spans -0.5..0.5
  vec3 local = vec3(position.x * iExtent.x, position.y * iExtent.y, 0.0);
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(local, 1.0);
}
`;

const SHADOW_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uAlpha;
varying vec2 vUv2;
void main() {
  // Rounded-box falloff: solid under the block, soft at the margin.
  vec2 q = abs(vUv2) * 2.0;               // 0 at centre, 1 at the quad edge
  float d = max(q.x, q.y);
  float a = uAlpha * (1.0 - smoothstep(0.45, 1.0, d));
  if (a <= 0.003) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

// ---------------------------------------------------------------- helpers

/**
 * Hex -> 0..1 channel values, kept in **sRGB** and deliberately NOT run through
 * `THREE.Color`.
 *
 * This is the bug that made the first working build render as a city of black
 * silhouettes. Since r152 three enables `ColorManagement` by default, so
 * `new THREE.Color('#21294b')` does not store 0.129 — it stores the LINEAR-sRGB
 * value, 0.0144, expecting the renderer's output pass to encode it back. Our shader
 * writes `gl_FragColor` directly and includes no `<colorspace_fragment>` chunk, so
 * nothing ever encoded it back and every authored tone rendered about nine times too
 * dark. The values in PALETTES were measured off a finished PNG, i.e. they are
 * already sRGB, so the correct handling is no conversion at all.
 *
 * The per-face ratios in TONES are multiplied in this same sRGB space on purpose:
 * they were measured as ratios of Rec.709 luminance computed on sRGB pixels, so
 * reproducing them means scaling sRGB values, not linear ones.
 */
function srgb(hex: string): [number, number, number] {
  const h = hex.charCodeAt(0) === 35 ? hex.slice(1) : hex;
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const DEG = Math.PI / 180;

/** Reused scratch — this module allocates nothing per frame. */
const _m4 = new THREE.Matrix4();
const _model = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _axisZ = new THREE.Vector3(0, 0, 1);

interface Origin {
  x: number;
  y: number;
  z: number;
  /** mercator units per metre at the origin latitude */
  unitsPerMetre: number;
  lng: number;
  lat: number;
}

function makeOrigin(lng: number, lat: number): Origin {
  const mc = MercatorCoordinate.fromLngLat({ lng, lat }, 0);
  return { x: mc.x, y: mc.y, z: mc.z, unitsPerMetre: mc.meterInMercatorCoordinateUnits(), lng, lat };
}

/** Metres east/north of the origin. */
function toLocal(origin: Origin, lng: number, lat: number, out: { x: number; y: number }): void {
  const mc = MercatorCoordinate.fromLngLat({ lng, lat }, 0);
  out.x = (mc.x - origin.x) / origin.unitsPerMetre;
  // Mercator y grows southward; scene +y is north.
  out.y = -(mc.y - origin.y) / origin.unitsPerMetre;
}

/** Rough metres between two lng/lat, for the origin re-anchor test. */
function metresBetween(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const dy = (bLat - aLat) * 111_320;
  const dx = (bLng - aLng) * 111_320 * Math.cos(((aLat + bLat) / 2) * DEG);
  return Math.hypot(dx, dy);
}

/**
 * One real footprint. It is no longer one drawn box — `build` expands it into an
 * `nx * ny` cluster of cubes, which is what the reference actually shows.
 */
interface Block {
  cx: number;
  cy: number;
  yaw: number;
  halfW: number;
  halfD: number;
  base: number;
  height: number;
  tint: number;
  /** the REAL ring's ground area in m2 — the generalisation key AND the budget key */
  ringArea: number;
  /** cluster shape, filled in by `push` */
  nx: number;
  ny: number;
}

/**
 * Deterministic sub-decimetre height offset, in metres, keyed off the footprint's
 * stable id — the coplanar tie-break described on COPLANAR_EPS_M. Stable across tile
 * refetches for the same reason `cellRand` is: a roof that changed its winner when a
 * tile reloaded would flicker, which is the artefact this exists to remove.
 */
function coplanarEps(id: number): number {
  let h = (Math.imul(id, 0x45d9f3b) ^ 0x3c6ef372) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x119de1f3) >>> 0;
  h ^= h >>> 13;
  // `h ^ (h >>> 13)` is an int32 expression, so this is signed again and is negative
  // for about half of all ids — and JS `%` keeps the DIVIDEND's sign. Without the
  // final `>>> 0` the offset ran (-0.22, 0.22]: twice the intended spread, and half of
  // the roofs sat BELOW the lattice `quantizeHeightM` is supposed to guarantee. (The
  // same missing shift is present in `cellRand` and `pickTint` below; both predate
  // this pass, both change what the city looks like, and neither is fixed here — see
  // DECISIONS §41.)
  return (((h >>> 0) % 1024) / 1024) * COPLANAR_EPS_M;
}

/** Deterministic 0..1 from a footprint id and a cell index. Stable across tile
 *  refetches, so a cube never changes height when its tile reloads. */
function cellRand(id: number, ix: number, iy: number): number {
  let h = (Math.imul(id, 0x27d4eb2d) ^ Math.imul(ix + 1, 0x9e3779b1) ^ Math.imul(iy + 1, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491) >>> 0;
  h ^= h >>> 13;
  return (h % 4096) / 4096;
}

/**
 * Collapse one building's rings to an oriented bounding box via PCA of its ring
 * vertices. OSM building rings are overwhelmingly rectangles of 4–6 points, so the
 * principal axis is the building's own long axis and the box is the building.
 *
 * Also returns the ring's own SHOELACE AREA, which `build` uses for two things: the
 * generalisation floor (a floor on real footprint area, not on box area, so a long
 * thin building is judged on the ground it actually covers), and the area-true
 * correction that stops the circumscribed box over-covering a non-rectangular
 * footprint.
 */
function orientedBox(
  pts: number[],
): { cx: number; cy: number; yaw: number; halfW: number; halfD: number; area: number } | null {
  const n = pts.length / 2;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += pts[i * 2];
    sy += pts[i * 2 + 1];
  }
  const mx = sx / n;
  const my = sy / n;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (let i = 0; i < n; i++) {
    const dx = pts[i * 2] - mx;
    const dy = pts[i * 2 + 1] - my;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  const yaw = 0.5 * Math.atan2(2 * xy, xx - yy);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = pts[i * 2] - mx;
    const dy = pts[i * 2 + 1] - my;
    const u = dx * c + dy * s;
    const v = -dx * s + dy * c;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const halfW = (maxU - minU) / 2;
  const halfD = (maxV - minV) / 2;
  if (!(halfW > 0.5) || !(halfD > 0.5)) return null;
  const ou = (maxU + minU) / 2;
  const ov = (maxV + minV) / 2;
  let shoelace = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    shoelace += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
  }
  return {
    cx: mx + ou * c - ov * s,
    cy: my + ou * s + ov * c,
    yaw,
    halfW,
    halfD,
    area: Math.abs(shoelace) / 2,
  };
}

// ---------------------------------------------------------------- the layer

export interface VoxelMeshOptions {
  sourceId?: string;
  sourceLayer?: string;
  theme: VoxelTheme;
  routeFocused?: boolean;
}

export interface VoxelMeshLayer extends CustomLayerInterface {
  setTheme(theme: VoxelTheme): void;
  setRouteFocus(focused: boolean): void;
  /** Rebuild the instance buffers from the tiles currently loaded. */
  sync(): void;
  /** Diagnostics for the verification harness. */
  stats(): {
    /** CUBES drawn (one instance each). */
    blocks: number;
    /** real footprints behind them */
    built: number;
    features: number;
    dropped: number;
    /** real footprints omitted by the zoom-keyed area floor (generalisation) */
    omitted: number;
    /** footprints that produced a multi-cube, multi-height cluster */
    clustered: number;
    origin: [number, number];
  };
  /**
   * Show/hide one half of the scene. Verification-only, and it earned its place:
   * when the first build came back with the whole map painted black, this is what
   * separated "the blocks are wrong" from "the shadows are wrong" in one run instead
   * of by bisecting constants.
   */
  setPartVisible(part: 'blocks' | 'shadows', on: boolean): void;
}

export function createVoxelMeshLayer(opts: VoxelMeshOptions): VoxelMeshLayer {
  const sourceId = opts.sourceId ?? 'omt';
  const sourceLayer = opts.sourceLayer ?? 'building';
  let theme: VoxelTheme = opts.theme;
  let focused = opts.routeFocused ?? false;

  let map: MlMap | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.Camera | null = null;
  let blocks: THREE.InstancedMesh | null = null;
  let shadows: THREE.InstancedMesh | null = null;
  let blockMat: THREE.ShaderMaterial | null = null;
  let shadowMat: THREE.ShaderMaterial | null = null;
  let origin: Origin = makeOrigin(-79.38736, 43.645);
  let count = 0;
  let built = 0;
  let dropped = 0;
  let omitted = 0;
  let features = 0;
  let clustered = 0;

  const iSize = new Float32Array(MAX_INSTANCES * 3);
  const iColor = new Float32Array(MAX_INSTANCES * 3);
  const iNbr = new Float32Array(MAX_INSTANCES * 4);
  // Shadows are one per FOOTPRINT, and a footprint is at least one cube, so the cube
  // budget is a safe upper bound for them too.
  const iExtent = new Float32Array(MAX_INSTANCES * 2);
  /** Reused per-cluster cell heights � at most MAX_CELLS_PER_AXIS squared. */
  const cellH = new Float32Array(MAX_CELLS_PER_AXIS * MAX_CELLS_PER_AXIS);
  const scratch: Block[] = [];
  const local = { x: 0, y: 0 };

  function applyTheme(): void {
    if (!blockMat || !shadowMat) return;
    const t = TONES[theme];
    const p = PALETTES[theme];
    blockMat.uniforms.uLit.value = t.lit;
    blockMat.uniforms.uShade.value = t.shade;
    blockMat.uniforms.uCrevice.value = p.crevice;
    blockMat.uniforms.uGrad.value = p.gradient;
    blockMat.uniforms.uAo.value = p.aoStrength;
    const g = srgb(p.ground);
    (blockMat.uniforms.uMute.value as THREE.Vector3).set(g[0], g[1], g[2]);
    const sh = srgb(p.shadow);
    (shadowMat.uniforms.uColor.value as THREE.Vector3).set(sh[0], sh[1], sh[2]);
    shadowMat.uniforms.uAlpha.value = p.shadowAlpha;
  }

  function applyFocus(): void {
    if (!blockMat) return;
    blockMat.uniforms.uFlatten.value = focused ? FOCUS_FLATTEN : 1;
    blockMat.uniforms.uMuteMix.value = focused ? 0.55 : 0;
  }

  /**
   * Read every building the source currently has loaded and rebuild the instance
   * buffers. Called on `idle` / `moveend` only — the geometry is in world space, so
   * panning and zooming need no rebuild at all and the render path allocates nothing.
   */
  function build(): void {
    if (!map || !blocks || !shadows) return;
    if (!map.getSource(sourceId)) return;

    const zoom = map.getZoom();
    const minH = minHeightForZoom(zoom);

    // Re-anchor the scene if the camera has wandered, so scene metres stay small.
    const c = map.getCenter();
    if (metresBetween(origin.lng, origin.lat, c.lng, c.lat) > ORIGIN_REANCHOR_M) {
      origin = makeOrigin(c.lng, c.lat);
    }

    let feats: GeoJSONFeature[];
    try {
      feats = map.querySourceFeatures(sourceId, { sourceLayer });
    } catch {
      return; // style mid-swap
    }

    // ONE BOX PER POLYGON RING. Never merged across rings, across polygons, or
    // across features — and that rule is load-bearing, not tidiness.
    //
    // The first version of this grouped every ring of a feature into one oriented
    // box, on the theory that a building straddling a tile boundary arrives as one
    // clipped piece per tile. It rendered the entire map black, and the measurement
    // that explains why is this: of the ~700 building features loaded at the default
    // framing, 112 have a per-FEATURE bounding box wider than 300 m and the worst is
    // 1825 m — which is exactly the width of a z14 tile at Toronto's latitude.
    //
    // The cause is upstream and legitimate. OpenFreeMap's `building` layer stops at
    // z14, so at the diorama's z16.4 the tiles are overscaled z14 tiles, and at z14
    // OpenMapTiles emits MULTIPOLYGONS whose parts are scattered right across the
    // tile. Union those parts into one oriented box and you get a single near-black
    // cube the size of a neighbourhood sitting over everything.
    //
    // Treating each ring separately is also the more honest reading: each part is a
    // real footprint at a real place, and merging them was the thing that invented
    // geometry.
    scratch.length = 0;
    let ringSeq = 0;
    let oversize = 0;
    let generalised = 0;

    const push = (pts: number[], h: number, b: number, id: number) => {
      const box = orientedBox(pts);
      if (!box) return;
      // SANITY GUARD. Even one ring at a time, tile generalisation occasionally
      // emits a ring that wraps most of a tile. A 600 m cube is not a building at
      // any Toronto address, and one of them covers the whole diorama — so it is
      // dropped rather than drawn. Counted, so the harness can see if it ever
      // becomes common.
      if (box.halfW > MAX_HALF_M || box.halfD > MAX_HALF_M) { oversize++; return; }
      // AREA-TRUE correction: pull the circumscribed box in until it covers the same
      // ground the ring does. Never enlarges, never collapses past AREA_TRUE_MIN.
      // `orientedBox` already guarantees halfW, halfD > 0.5, so boxArea > 1.
      const boxArea = box.halfW * box.halfD * 4;
      const k = Math.sqrt(Math.min(1, Math.max(AREA_TRUE_MIN, box.area / boxArea)));
      const halfW = Math.max(MIN_HALF_M, box.halfW * k - INSET_M);
      const halfD = Math.max(MIN_HALF_M, box.halfD * k - INSET_M);
      // The tie-break rides on the footprint's quantised height, so every cube in one
      // cluster still shares one lattice with every other cube in it.
      const height = quantizeHeightM(h) + coplanarEps(id);
      if (!(height > 0)) return;
      // THE CLUSTER. The footprint is divided into a whole number of cells as close
      // to CELL_M as it can manage, so the cubes exactly tile the footprint — no
      // partial cell at the far edge, and nothing spilling outside the building.
      // The grid is laid out in the footprint's OWN frame rather than in world space:
      // a world grid would leave every off-grid building with a staircase silhouette
      // and cells hanging over its edges, which is precisely the "do not spill
      // outside its own footprint" rule.
      const nx = Math.max(1, Math.min(MAX_CELLS_PER_AXIS, Math.round((halfW * 2) / CELL_M)));
      const ny = Math.max(1, Math.min(MAX_CELLS_PER_AXIS, Math.round((halfD * 2) / CELL_M)));
      scratch.push({
        cx: box.cx,
        cy: box.cy,
        yaw: box.yaw,
        halfW,
        halfD,
        base: Math.max(0, b),
        height,
        tint: id,
        ringArea: box.area,
        nx,
        ny,
      });
    };

    for (const f of feats) {
      const props = f.properties as Record<string, unknown> | null;
      const rh = Number(props?.render_height ?? DEFAULT_HEIGHT_M);
      const h = Number.isFinite(rh) ? rh : DEFAULT_HEIGHT_M;
      if (h < minH) continue;
      const rb = Number(props?.render_min_height ?? 0);
      const g = f.geometry;
      if (!g) continue;
      const polys: number[][][][] =
        g.type === 'Polygon'
          ? [g.coordinates as unknown as number[][][]]
          : g.type === 'MultiPolygon'
            ? (g.coordinates as unknown as number[][][][])
            : [];
      if (!polys.length) continue;

      for (const poly of polys) {
        const ring = poly[0];
        if (!ring || ring.length < 4) continue;
        const flat: number[] = [];
        // Drop the closing duplicate so the PCA is not weighted twice at one vertex.
        const stop = ring.length - 1;
        for (let i = 0; i < stop; i++) {
          const p = ring[i] as unknown as [number, number];
          toLocal(origin, p[0], p[1], local);
          flat.push(local.x, local.y);
        }
        if (flat.length < 6) continue;
        // Tint key: the real OSM id where there is one, mixed with the ring index so
        // the parts of a multipolygon do not all come out the same colour. Stable
        // across tile refetches, which is what stops blocks flickering colour.
        const tintKey = ((Number(f.id) || ringSeq) * 31 + ringSeq) | 0;
        ringSeq++;
        push(flat, h, Number.isFinite(rb) ? rb : 0, tintKey);
      }
    }

    features = feats.length;
    dropped = oversize;

    // ---- GENERALISATION, on the ring's OWN area rather than on its box's ----------
    //
    // The floor itself is `minFootprintAreaM2` (voxelCity.ts), a constant screen area.
    // It is applied HERE rather than inside `push` because of the cap below, which
    // needs to see the whole neighbourhood before it can decide anything.
    //
    // THE CAP, and the failure it exists to prevent. A pure absolute floor is tuned on
    // the place it was measured. At King & Spadina it omits 58.6% of the loaded rings
    // that get this far and the result is the reference's calm; somewhere finer-grained
    // the same floor can take most of a neighbourhood. So it is capped by RANK as well as
    // by size: drop the smallest footprints until the screen-size floor is satisfied OR
    // MAX_OMIT_FRACTION of the loaded neighbourhood has been dropped, whichever comes
    // first. Selection by rank is the older and more standard of the two generalisation
    // operators — Töpfer's radical law is exactly this — and like the size floor it only
    // ever OMITS.
    //
    // MEASURED, on three real Toronto framings, as built coverage of the pane, with the
    // size floor switched off / on-uncapped / on-capped:
    //
    //   King & Spadina (downtown)  66.4%  ->  63.5%  ->  63.5%   cap never binds
    //   Roncesvalles   (low-rise)  35.4%  ->  27.8%  ->  31.6%   cap halves the loss
    //   Greenwood/Danforth         25.5%  ->  24.9%  ->  25.2%
    //
    // The Greenwood row is worth reading carefully: that frame is ALREADY sparse with no
    // area floor at all, because most of its houses carry a render_height under
    // `minHeightForZoom`'s 8 m and never reach this code. The area floor is not what
    // empties it, and the fix for that — if it is ever wanted — belongs to the HEIGHT
    // floor, not here.
    const minArea = minFootprintAreaM2(metresPerPixel(map));
    if (minArea > 0 && scratch.length > 0) {
      const sorted = scratch.map((bl) => bl.ringArea).sort((x, y) => x - y);
      const capIdx = Math.floor(sorted.length * MAX_OMIT_FRACTION);
      const capArea = capIdx < sorted.length ? sorted[capIdx] : Infinity;
      const threshold = Math.min(minArea, capArea);
      let keep = 0;
      for (let i = 0; i < scratch.length; i++) {
        if (scratch[i].ringArea >= threshold) scratch[keep++] = scratch[i];
      }
      generalised = scratch.length - keep;
      scratch.length = keep;
    }
    omitted = generalised;
    built = scratch.length;

    // INSTANCE BUDGET, spent in whole buildings. A cluster with a cell missing out of
    // its middle is a building with a hole in it, so when the budget binds the
    // smallest FOOTPRINTS are dropped entirely — the same cartographic generalisation
    // as before, just counted in cubes.
    let cubesWanted = 0;
    for (const b of scratch) cubesWanted += b.nx * b.ny;
    if (cubesWanted > MAX_INSTANCES) {
      scratch.sort((a, b2) => b2.ringArea - a.ringArea);
      let acc = 0;
      let keep = 0;
      for (; keep < scratch.length; keep++) {
        const n = scratch[keep].nx * scratch[keep].ny;
        if (acc + n > MAX_INSTANCES) break;
        acc += n;
      }
      scratch.length = keep;
    }

    const topsRgb = PALETTES[theme].tops.map(srgb);
    const litAxis = litAxisWorld();
    const nFootprints = scratch.length;
    let cube = 0;
    let clusters = 0;

    for (let i = 0; i < nFootprints; i++) {
      const b = scratch[i];
      _q.setFromAxisAngle(_axisZ, b.yaw);
      const cs = Math.cos(b.yaw);
      const sn = Math.sin(b.yaw);

      // --- colour: ONE per footprint, so a cluster reads as one building ---------
      const c = topsRgb[pickTint(b.tint, topsRgb.length)];
      const j = tintJitter(b.tint);
      const hj = hueJitter(b.tint);
      // Rotate warm<->cool about the block's own mean: +hj pushes toward violet,
      // -hj toward blue. Luminance is held by moving R and B in opposite directions.
      const mean = (c[0] + c[1] + c[2]) / 3;
      const cr = Math.min(1, Math.max(0, (c[0] + (c[0] - mean) * hj * 2.2) * j));
      const cg = Math.min(1, Math.max(0, c[1] * j));
      const cb = Math.min(1, Math.max(0, (c[2] - (c[2] - mean) * hj * 0.9) * j));

      // --- contact shadow: ONE per footprint, not one per cube ------------------
      // The building casts one shadow; a shadow quad per cube would stack alpha in
      // the middle of every cluster and burn a dark core into it.
      const grow = 2.6 + b.height * 0.10;
      const off = b.height * 0.16;
      _pos.set(b.cx - litAxis[0] * off, b.cy - litAxis[1] * off, 0.12);
      _m4.compose(_pos, _q, _scale);
      shadows.setMatrixAt(i, _m4);
      iExtent[i * 2] = (b.halfW + grow) * 2;
      iExtent[i * 2 + 1] = (b.halfD + grow) * 2;

      // --- the cluster ----------------------------------------------------------
      const w = b.halfW * 2;
      const d = b.halfD * 2;
      const { nx, ny } = b;
      const cw = w / nx;
      const cd = d / ny;
      const body = Math.max(1, b.height - b.base);
      // Courses are whole steps of the SHARED height lattice, and `step` divides the
      // real body exactly — so the tallest cell in every cluster is the footprint's
      // own quantised height, never more.
      // SPIKE GUARD. A voxel cube is about as tall as it is wide; a 6 m laneway
      // footprint taking three quantised courses renders as a needle, and the
      // reference has nothing of the kind. So a cluster's height is capped by its own
      // horizontal extent � a rule about how a real height is DRAWN in this idiom,
      // exactly like the sqrt compression `quantizeHeightM` already applies, and it
      // only ever draws a real building shorter, never taller than it is.
      const minSpanM = Math.min(w, d);
      const maxCourses = Math.max(1, Math.floor((minSpanM * MAX_ASPECT) / CELL_M));
      const courses = Math.max(1, Math.min(Math.round(body / HEIGHT_STEP_M), maxCourses));
      const step = body / Math.max(1, Math.round(body / HEIGHT_STEP_M));

      // Which cells stand a course lower. One cell is always held at full height, so
      // the mass still reads as the building's real height; a single-course footprint
      // gets no variation at all, because it has none to express.
      const nCells = nx * ny;
      const tallest = nCells > 1 ? Math.abs(b.tint * 2654435761) % nCells : 0;
      for (let k = 0; k < nCells; k++) {
        const ix = k % nx;
        const iy = (k / nx) | 0;
        const drop = courses >= 2 && k !== tallest && cellRand(b.tint, ix, iy) < CELL_DROP_CHANCE ? 1 : 0;
        cellH[k] = (courses - drop) * step;
      }
      if (nCells > 1 && courses >= 2) clusters++;

      for (let k = 0; k < nCells; k++) {
        const ix = k % nx;
        const iy = (k / nx) | 0;
        const u = -w / 2 + (ix + 0.5) * cw;
        const v = -d / 2 + (iy + 0.5) * cd;
        _pos.set(b.cx + u * cs - v * sn, b.cy + u * sn + v * cs, b.base);
        _m4.compose(_pos, _q, _scale);
        blocks.setMatrixAt(cube, _m4);

        iSize[cube * 3] = cw;
        iSize[cube * 3 + 1] = cd;
        iSize[cube * 3 + 2] = cellH[k];

        iColor[cube * 3] = cr;
        iColor[cube * 3 + 1] = cg;
        iColor[cube * 3 + 2] = cb;

        // Neighbour heights, in the cube's own frame, for the crevice occlusion. A
        // zero means open air on that side — the cluster's outer walls get no
        // crevice, which is right: there is nothing pressed against them.
        iNbr[cube * 4] = ix > 0 ? cellH[k - 1] : 0;
        iNbr[cube * 4 + 1] = ix < nx - 1 ? cellH[k + 1] : 0;
        iNbr[cube * 4 + 2] = iy > 0 ? cellH[k - nx] : 0;
        iNbr[cube * 4 + 3] = iy < ny - 1 ? cellH[k + nx] : 0;

        cube++;
      }
    }

    count = cube;
    clustered = clusters;
    blocks.count = cube;
    shadows.count = nFootprints;
    blocks.instanceMatrix.needsUpdate = true;
    shadows.instanceMatrix.needsUpdate = true;
    (blocks.geometry.getAttribute('iSize') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (blocks.geometry.getAttribute('iColor') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (blocks.geometry.getAttribute('iNbr') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (shadows.geometry.getAttribute('iExtent') as THREE.InstancedBufferAttribute).needsUpdate = true;
    map.triggerRepaint();
  }

  /**
   * Deal a block one of the palette's top tones. Keyed off the stable OSM feature id
   * so a building never changes colour when its tile is refetched, and mixed with a
   * cheap integer hash so neighbouring ids (which OSM hands out in creation order,
   * i.e. often to neighbouring buildings) do not stripe.
   */
  function pickTint(id: number, n: number): number {
    let h = (id | 0) >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d) >>> 0;
    h ^= h >>> 15;
    // Shares: the two measured families take ~62% between them, the blue-slate
    // variant ~26%, and the violet / teal / rose accents stay rare — §31 measured the
    // violet at ~2% of reference pixels and the teal at ~0.8%, and a previous pass had
    // to correct them down from five times that.
    const r = (h % 1000) / 1000;
    if (r < 0.34) return 0;
    if (r < 0.64) return 1;
    if (r < 0.90) return 2;
    if (r < 0.96) return 3;
    if (r < 0.98) return 4 % n;
    return 5 % n;
  }

  /**
   * Per-block brightness jitter, deterministic in the same id.
   *
   * The reference is not six colours; it is a city of individually-tinted blocks, and
   * its luminance histogram is a smooth ramp. Six discrete tones times three face
   * levels gives eighteen spikes instead, which measured as a visibly lumpy
   * distribution — 23% of the frame in one 16-level band and 3% in the next. A +/-15%
   * jitter fills the gaps between the tones without moving the mean, and is the same
   * class of decorative variation as the palette itself.
   */
  function tintJitter(id: number): number {
    let h = (id * 2654435761) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    return 1 + (((h % 1000) / 1000) - 0.5) * 0.30;
  }

  /**
   * Per-block HUE jitter, in the same spirit and for a sharper reason.
   *
   * Circular-mean hue over the reference's building surfaces is 233.5 deg and ours
   * measured 230.0 — three and a half degrees apart, i.e. the MEAN was never the
   * problem. The SHAPE was: binned by 10 deg, the reference spreads its building
   * pixels 3 / 5 / 31 / 35 / 19 / 6 / 2 across 210..280, with 60% of them at hue 240
   * or above, while ours was a single spike of 77% in the 230..240 bin. A narrow
   * spike centred on 230 is exactly what "reads steel blue instead of violet" looks
   * like as a number, even when the average says otherwise.
   *
   * So the fix is two-part: the family hues move up (above), and this rotates each
   * block by up to +/-11 deg so the population spreads instead of stacking. Applied
   * by rotating the R and B channels about the block's own luminance, which is a
   * cheap approximation to a hue rotation and preserves the measured luminance the
   * face tones depend on.
   */
  function hueJitter(id: number): number {
    let h = (Math.imul(id, 0x9e3779b1) ^ 0x5bf03635) >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    return (((h % 1000) / 1000) - 0.5) * 0.22;
  }

  /** World-XY direction the lit wall faces, derived from the map bearing so the lamp
   *  stays anchored to the viewport rather than to the compass. */
  function litAxisWorld(): [number, number] {
    const bearing = (map?.getBearing() ?? 0) * DEG;
    const a = TONES[theme].litScreenDeg * DEG;
    // screen-up in world = (sin b, cos b); screen-right = (cos b, -sin b)
    const su: [number, number] = [Math.sin(bearing), Math.cos(bearing)];
    const sr: [number, number] = [Math.cos(bearing), -Math.sin(bearing)];
    const x = Math.sin(a);
    const y = Math.cos(a);
    return [sr[0] * x + su[0] * y, sr[1] * x + su[1] * y];
  }

  const layer: VoxelMeshLayer = {
    id: VOXEL_MESH_LAYER,
    type: 'custom',
    renderingMode: '3d',

    onAdd(m: MlMap, gl: WebGL2RenderingContext) {
      map = m;
      const c0 = m.getCenter();
      origin = makeOrigin(c0.lng, c0.lat);

      renderer = new THREE.WebGLRenderer({
        canvas: m.getCanvas(),
        context: gl,
        antialias: true,
      });
      renderer.autoClear = false;
      renderer.autoClearColor = false;
      renderer.autoClearDepth = false;
      renderer.autoClearStencil = false;
      // Colours are authored as final sRGB values measured off the reference sheet;
      // nothing must re-encode them on the way out.
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

      scene = new THREE.Scene();
      camera = new THREE.Camera();
      camera.matrixAutoUpdate = false;

      // Unit box: x,y in [-0.5, 0.5], z in [0, 1], so the base sits on the ground.
      const box = new THREE.BoxGeometry(1, 1, 1);
      box.rotateX(Math.PI / 2);
      box.translate(0, 0, 0.5);
      box.deleteAttribute('uv');
      box.setAttribute('iSize', new THREE.InstancedBufferAttribute(iSize, 3));
      box.setAttribute('iColor', new THREE.InstancedBufferAttribute(iColor, 3));
      box.setAttribute('iNbr', new THREE.InstancedBufferAttribute(iNbr, 4));

      blockMat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uLitAxis: { value: new THREE.Vector2(-0.7, -0.7) },
          uLit: { value: TONES[theme].lit },
          uShade: { value: TONES[theme].shade },
          uCrevice: { value: PALETTES[theme].crevice },
          uCreviceM: { value: CREVICE_M },
          uBevelM: { value: BEVEL_M },
          uGrad: { value: PALETTES[theme].gradient },
          uAo: { value: PALETTES[theme].aoStrength },
          uAoHeightM: { value: AO_HEIGHT_M },
          uHeightGain: { value: 1 },
          uFlatten: { value: 1 },
          uMute: { value: new THREE.Vector3(0, 0, 0) },
          uMuteMix: { value: 0 },
        },
      });

      blocks = new THREE.InstancedMesh(box, blockMat, MAX_INSTANCES);
      blocks.frustumCulled = false;
      blocks.count = 0;
      blocks.matrixAutoUpdate = false;
      blocks.renderOrder = 1;

      const plane = new THREE.PlaneGeometry(1, 1);
      plane.deleteAttribute('uv');
      plane.deleteAttribute('normal');
      plane.setAttribute('iExtent', new THREE.InstancedBufferAttribute(iExtent, 2));

      shadowMat = new THREE.ShaderMaterial({
        vertexShader: SHADOW_VERT,
        fragmentShader: SHADOW_FRAG,
        uniforms: {
          uColor: { value: new THREE.Vector3(0, 0, 0) },
          uAlpha: { value: PALETTES[theme].shadowAlpha },
        },
        // NOT `transparent: true`, and the distinction matters. Three sorts every
        // transparent object into a second list rendered AFTER all opaque objects,
        // so a `transparent` shadow would be painted over the blocks themselves and
        // hundreds of overlapping quads would compound into a black wash across the
        // whole diorama. Declaring it opaque keeps it in the first list, where
        // `renderOrder` decides the order, so the shadows land on the GROUND and the
        // blocks are then drawn on top of them. Blending is applied either way.
        transparent: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        depthWrite: false,
        depthTest: true,
      });

      shadows = new THREE.InstancedMesh(plane, shadowMat, MAX_INSTANCES);
      shadows.frustumCulled = false;
      shadows.count = 0;
      shadows.matrixAutoUpdate = false;
      shadows.renderOrder = 0;

      scene.add(shadows);
      scene.add(blocks);

      applyTheme();
      applyFocus();
      build();
    },

    render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
      if (!renderer || !scene || !camera || !blockMat || !map || count === 0) return;

      // MapLibre's own matrix maps mercator space to clip space. The model matrix
      // takes our scene (metres east / north / up, relative to `origin`) into it.
      const um = origin.unitsPerMetre;
      _model.makeTranslation(origin.x, origin.y, origin.z);
      _m4.makeScale(um, -um, um);
      _model.multiply(_m4);

      camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]);
      camera.projectionMatrix.multiply(_model);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

      const zoom = map.getZoom();
      blockMat.uniforms.uHeightGain.value = zoomHeightGain(zoom);
      // Hold the bevel at roughly a constant SCREEN width. A fixed metre bevel is a
      // fat smear when the camera is close and invisible when it is far, and both
      // read as a different material rather than as the same rounded cube.
      const mpp = metresPerPixel(map);
      blockMat.uniforms.uBevelM.value = Math.max(BEVEL_M, mpp * 1.6);
      const axis = litAxisWorld();
      (blockMat.uniforms.uLitAxis.value as THREE.Vector2).set(axis[0], axis[1]);

      const canvas = map.getCanvas();
      renderer.resetState();
      renderer.setViewport(0, 0, canvas.width, canvas.height);
      renderer.setScissorTest(false);
      renderer.render(scene, camera);
    },

    onRemove() {
      blocks?.geometry.dispose();
      shadows?.geometry.dispose();
      blockMat?.dispose();
      shadowMat?.dispose();
      // The GL context belongs to MapLibre — dispose only the objects we made.
      renderer?.dispose();
      renderer = null;
      scene = null;
      camera = null;
      blocks = null;
      shadows = null;
      blockMat = null;
      shadowMat = null;
      map = null;
      count = 0;
    },

    setTheme(next: VoxelTheme) {
      if (theme === next) return;
      theme = next;
      applyTheme();
      build();
    },

    setRouteFocus(next: boolean) {
      if (focused === next) return;
      focused = next;
      applyFocus();
      map?.triggerRepaint();
    },

    sync() {
      build();
    },

    stats() {
      return { blocks: count, built, features, dropped, omitted, clustered, origin: [origin.lng, origin.lat] };
    },

    setPartVisible(part, on) {
      const m = part === 'blocks' ? blocks : shadows;
      if (m) m.visible = on;
      map?.triggerRepaint();
    },
  };

  return layer;
}

/** Ground metres per CSS pixel at the map's current centre and zoom. */
function metresPerPixel(map: MlMap): number {
  const lat = map.getCenter().lat;
  return (156543.03392 * Math.cos(lat * DEG)) / Math.pow(2, map.getZoom() + 1);
}
