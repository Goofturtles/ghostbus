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
// and no two footprints are ever merged into a structure that does not exist. Three
// documented decorative transforms are applied, all of them the same class of
// stylisation as the height quantisation this project has always used:
//
//   a. Each footprint is drawn as its PCA-oriented bounding box — one block per real
//      building, at the building's real position, real orientation and real extent.
//      (An oriented box slightly OVER-covers a non-rectangular footprint; the inset
//      in (b) pulls it back the other way, so the drawn area is not systematically
//      larger than the truth.)
//   b. That box is inset by INSET_M so abutting buildings show the reference's dark
//      gap instead of fusing into one mass.
//   c. Heights are quantised onto a shared lattice (voxelCity.ts owns that maths).
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
  quantizeHeightM,
  minHeightForZoom,
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
  seam: number;
  aoStrength: number;
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
    tops: ['#2e325c', '#46426b', '#303b64', '#46376a', '#253b40', '#5b355b'],
    ground: '#0e142b',
    shadow: '#05070f',
    // Night: the wall tones already separate the blocks, so the contact shadow is a
    // whisper. Measured on the reference, the darkening under a block bottoms out
    // ~18% below the surrounding ground.
    shadowAlpha: 0.34,
    seam: 0.085,
    aoStrength: 0.34,
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
    seam: 0.055,
    aoStrength: 0.22,
  },
};

// ---------------------------------------------------------------- geometry knobs

/**
 * Footprint inset in metres, per side. Produces the reference's dark gap between
 * abutting blocks — the thing `fill-extrusion` structurally could not do.
 *
 * Small on purpose. Downtown Toronto's OSM footprints have a median span around
 * 24 m, so 1.2 m a side is ~10% of a block, which is about what the reference shows.
 * It is also the counterweight to the oriented bounding box: a box CIRCUMSCRIBES a
 * non-rectangular footprint, so without the inset every block would read slightly
 * fatter than the building actually is.
 */
const INSET_M = 1.2;
/** A block never insets below this half-extent, so small real buildings survive. */
const MIN_HALF_M = 2.4;
/** Sanity ceiling on a block's half-extent — see the note in `build`. Toronto's
 *  longest single building (the Eaton Centre) is ~300 m end to end, so a half-extent
 *  above 300 m is a tile-generalisation artifact, not architecture. */
const MAX_HALF_M = 300;

/**
 * Voxel cell size in metres — the lattice the seam shader draws.
 *
 * MEASURED: on the reference's desktop map at ~0.95 m/px (§32's scale derivation),
 * a block's roof grid runs ~16 px per cube and its wall courses ~13 px, i.e. 12–16 m.
 * 14 m is the middle of that, and it is a clean half of voxelCity's 24 m height step
 * so wall courses line up with the quantised roof lattice instead of beating against it.
 */
const CELL_M = 17;

/** How far up a wall the contact darkening reaches. */
const AO_HEIGHT_M = 9;

/** Hard ceiling on instances. Beyond this the smallest footprints are dropped —
 *  ordinary cartographic generalisation, and it never triggers at the app's framings
 *  (the default desktop view builds ~400). */
const MAX_INSTANCES = 9000;

/** Re-anchor the scene origin when the camera has wandered this far, so scene-space
 *  metres stay small and float32 in the shader stays exact. */
const ORIGIN_REANCHOR_M = 4000;

// ---------------------------------------------------------------- shaders

const VERT = /* glsl */ `
precision highp float;

attribute vec3 iSize;     // metres: full width, depth, height
attribute vec3 iColor;    // authored top-face colour

uniform float uHeightGain;  // camera-zoom height gain (voxelCity.zoomHeightGain)
uniform float uFlatten;     // route-focus collapse
uniform float uCellM;

varying vec3 vColor;
varying vec3 vNormalW;
varying vec3 vCellM;      // metres from the block's own origin corner (for the lattice)
varying float vUpM;       // metres above the block's base
varying float vSeamAmt;   // how much voxel lattice this block earns (see below)

void main() {
  vColor = iColor;

  float hScale = uHeightGain * uFlatten;
  vec3 local = vec3(position.x * iSize.x, position.y * iSize.y, position.z * iSize.z * hScale);

  // Lattice coordinates run from a CORNER, not the centre, so a block's own edges
  // always land on a seam and every block is outlined.
  vCellM = local + vec3(iSize.x * 0.5, iSize.y * 0.5, 0.0);
  vUpM = local.z;

  // instanceMatrix carries rotation + translation only (no scale), so its upper 3x3
  // is a pure rotation and doubles as the normal matrix.
  vNormalW = normalize(mat3(instanceMatrix) * normal);

  // ONLY BIG BLOCKS GET THE VOXEL LATTICE.
  //
  // The reference's cube seams live on blocks the size of a city block; drawing the
  // same fixed-metre lattice on a 20 m infill shophouse puts a full cross through a
  // face two cells wide, and a reviewer reading the result called it "meshy /
  // subdivided, like a wireframe". Fading the lattice in only once a block is a few
  // cells across reproduces the reference (its small blocks are flat single tones
  // too) and removes the artefact.
  float span = min(iSize.x, iSize.y);
  vSeamAmt = smoothstep(1.9 * uCellM, 3.4 * uCellM, span);

  vec4 world = instanceMatrix * vec4(local, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * world;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform vec2 uLitAxis;      // world-XY direction the LIT wall faces (viewport-anchored)
uniform float uLit;         // lit-wall / top luminance ratio
uniform float uShade;       // shaded-wall / top luminance ratio
uniform float uSeam;        // voxel lattice darkening, 0..1
uniform float uSeamHalfM;   // half-width of a seam line, in metres (kept ~1px)
uniform float uCellM;
uniform float uAo;          // base contact darkening, 0..1
uniform float uAoHeightM;
uniform vec3  uMute;        // route-focus target colour
uniform float uMuteMix;

varying vec3 vColor;
varying vec3 vNormalW;
varying vec3 vCellM;
varying float vUpM;
varying float vSeamAmt;

// distance to the nearest lattice plane, in metres
float latticeDist(float v) {
  float f = fract(v / uCellM);
  return min(f, 1.0 - f) * uCellM;
}

void main() {
  vec3 base = mix(vColor, uMute, uMuteMix);

  // --- face tone: three constant levels, exactly as the reference renders them ---
  float tone;
  bool isTop = vNormalW.z > 0.5;
  if (isTop) {
    tone = 1.0;
  } else {
    vec2 h = vNormalW.xy;
    float len = max(length(h), 1e-4);
    float d = dot(h / len, uLitAxis);
    // A narrow smoothstep rather than a hard step: it reads as two flat tones on the
    // grid-aligned blocks that dominate the frame, but stops the handful of buildings
    // sitting at 45 degrees to the light from aliasing along their own edge.
    tone = mix(uShade, uLit, smoothstep(-0.12, 0.12, d));
  }

  vec3 c = base * tone;

  // --- voxel lattice: the seams between stacked cubes -------------------------
  float dSeam;
  if (isTop) dSeam = min(latticeDist(vCellM.x), latticeDist(vCellM.y));
  else       dSeam = min(min(latticeDist(vCellM.x), latticeDist(vCellM.y)), latticeDist(vCellM.z));
  c *= 1.0 - uSeam * vSeamAmt * (1.0 - smoothstep(0.0, uSeamHalfM, dSeam));

  // --- contact darkening at the base of every wall ----------------------------
  if (!isTop) c *= mix(1.0 - uAo, 1.0, smoothstep(0.0, uAoHeightM, vUpM));

  gl_FragColor = vec4(c, 1.0);
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

interface Block {
  cx: number;
  cy: number;
  yaw: number;
  halfW: number;
  halfD: number;
  base: number;
  height: number;
  tint: number;
  area: number;
}

/**
 * Collapse one building's rings to an oriented bounding box via PCA of its ring
 * vertices. OSM building rings are overwhelmingly rectangles of 4–6 points, so the
 * principal axis is the building's own long axis and the box is the building.
 */
function orientedBox(pts: number[]): { cx: number; cy: number; yaw: number; halfW: number; halfD: number } | null {
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
  return { cx: mx + ou * c - ov * s, cy: my + ou * s + ov * c, yaw, halfW, halfD };
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
  stats(): { blocks: number; built: number; features: number; dropped: number; origin: [number, number] };
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
  let features = 0;

  const iSize = new Float32Array(MAX_INSTANCES * 3);
  const iColor = new Float32Array(MAX_INSTANCES * 3);
  const iExtent = new Float32Array(MAX_INSTANCES * 2);
  const scratch: Block[] = [];
  const local = { x: 0, y: 0 };

  function applyTheme(): void {
    if (!blockMat || !shadowMat) return;
    const t = TONES[theme];
    const p = PALETTES[theme];
    blockMat.uniforms.uLit.value = t.lit;
    blockMat.uniforms.uShade.value = t.shade;
    blockMat.uniforms.uSeam.value = p.seam;
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

    const push = (pts: number[], h: number, b: number, id: number) => {
      const box = orientedBox(pts);
      if (!box) return;
      // SANITY GUARD. Even one ring at a time, tile generalisation occasionally
      // emits a ring that wraps most of a tile. A 600 m cube is not a building at
      // any Toronto address, and one of them covers the whole diorama — so it is
      // dropped rather than drawn. Counted, so the harness can see if it ever
      // becomes common.
      if (box.halfW > MAX_HALF_M || box.halfD > MAX_HALF_M) { oversize++; return; }
      const halfW = Math.max(MIN_HALF_M, box.halfW - INSET_M);
      const halfD = Math.max(MIN_HALF_M, box.halfD - INSET_M);
      const height = quantizeHeightM(h);
      if (!(height > 0)) return;
      scratch.push({
        cx: box.cx,
        cy: box.cy,
        yaw: box.yaw,
        halfW,
        halfD,
        base: Math.max(0, b),
        height,
        tint: id,
        area: halfW * halfD,
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
    built = scratch.length;
    if (scratch.length > MAX_INSTANCES) {
      scratch.sort((a, b2) => b2.area - a.area);
      scratch.length = MAX_INSTANCES;
    }

    const topsRgb = PALETTES[theme].tops.map(srgb);
    const litAxis = litAxisWorld();
    count = scratch.length;

    for (let i = 0; i < count; i++) {
      const b = scratch[i];
      _pos.set(b.cx, b.cy, b.base);
      _q.setFromAxisAngle(_axisZ, b.yaw);
      _m4.compose(_pos, _q, _scale);
      blocks.setMatrixAt(i, _m4);

      iSize[i * 3] = b.halfW * 2;
      iSize[i * 3 + 1] = b.halfD * 2;
      iSize[i * 3 + 2] = Math.max(1, b.height - b.base);

      const c = topsRgb[pickTint(b.tint, topsRgb.length)];
      const j = tintJitter(b.tint);
      const hj = hueJitter(b.tint);
      // Rotate warm<->cool about the block's own mean: +hj pushes toward violet,
      // -hj toward blue. Luminance is held by moving R and B in opposite directions.
      const mean = (c[0] + c[1] + c[2]) / 3;
      iColor[i * 3] = Math.min(1, Math.max(0, (c[0] + (c[0] - mean) * hj * 2.2) * j));
      iColor[i * 3 + 1] = Math.min(1, Math.max(0, c[1] * j));
      iColor[i * 3 + 2] = Math.min(1, Math.max(0, (c[2] - (c[2] - mean) * hj * 0.9) * j));

      // Contact shadow: the footprint, grown by a margin that scales with the
      // block's height, and nudged away from the light like a cast shadow.
      const grow = 2.6 + b.height * 0.10;
      const off = b.height * 0.16;
      _pos.set(b.cx - litAxis[0] * off, b.cy - litAxis[1] * off, 0.12);
      _m4.compose(_pos, _q, _scale);
      shadows.setMatrixAt(i, _m4);
      iExtent[i * 2] = (b.halfW + grow) * 2;
      iExtent[i * 2 + 1] = (b.halfD + grow) * 2;
    }

    blocks.count = count;
    shadows.count = count;
    blocks.instanceMatrix.needsUpdate = true;
    shadows.instanceMatrix.needsUpdate = true;
    (blocks.geometry.getAttribute('iSize') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (blocks.geometry.getAttribute('iColor') as THREE.InstancedBufferAttribute).needsUpdate = true;
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

      blockMat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uLitAxis: { value: new THREE.Vector2(-0.7, -0.7) },
          uLit: { value: TONES[theme].lit },
          uShade: { value: TONES[theme].shade },
          uSeam: { value: PALETTES[theme].seam },
          uSeamHalfM: { value: 1.0 },
          uCellM: { value: CELL_M },
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
      // Keep a seam about one CSS pixel wide at any zoom, and let it fade out
      // entirely when a metre is smaller than a pixel (otherwise it aliases).
      const mpp = metresPerPixel(map);
      blockMat.uniforms.uSeamHalfM.value = Math.max(0.35, mpp * 1.15);
      blockMat.uniforms.uSeam.value = PALETTES[theme].seam * (mpp > 3.2 ? 0 : 1);
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
      return { blocks: count, built, features, dropped, origin: [origin.lng, origin.lat] };
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
