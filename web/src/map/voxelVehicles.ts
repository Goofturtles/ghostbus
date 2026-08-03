// VOXEL VEHICLES — the buses and streetcars, as actual cube clusters in the diorama.
//
// WHAT THIS REPLACES, AND WHY IT HAD TO BE 3D.
//
// `sprites.ts` draws a top-down rounded rectangle with a fake offset "extrusion"
// painted under it, registers it as a MapLibre image, and the `vehicles` symbol layer
// rotates it by heading. It is a good sprite. It is not a voxel model, and at the
// diorama's pitch 48 the difference is the whole complaint: every building in frame
// presents a real roof and two real walls that turn as the map turns, and the vehicle
// standing among them presents a flat picture of a vehicle. The user's words were that
// the buses are not voxel 3D, and a painted extrusion cannot become one — a flat image
// has one silhouette, and an object seen from a fixed camera has a different silhouette
// for every heading it can take.
//
// So a vehicle here is built the same way a building is: a small cluster of cubes,
// standing on the ground plane, oriented by the vehicle's real heading, and shaded by
// LITERALLY the city's shader — `voxelMesh.ts` exports `CUBE_VERT`/`CUBE_FRAG` and this
// module imports them, so the measured face ratios (TOP:LEFT:RIGHT = 1.000 : 0.641 :
// 0.491) and the viewport-anchored studio lamp are shared by construction rather than
// by two constants that agree today.
//
// WHAT IS NOT INVENTED. The position is the agency's own reported position; the heading
// is the agency's own reported heading (or, where the feed omits it, the bearing between
// two consecutive reported positions, which MapCard already computes). The BODY is
// stylised — see `MODELS` — and it is stylised in exactly the documented decorative
// register the buildings' quantised heights already occupy. No timing, no distance and
// no verdict anywhere in GhostBus is derived from any of it.
//
// DEPTH. The layer clears the depth buffer before it draws. That is deliberate and it
// implements DESIGN-TARGET §C: "Buildings must never occlude the route, stops, markers,
// labels, vehicles or the You beacon." Left depth-tested, a bus on the far side of a
// tower would simply vanish, which is the one thing a transit map may not do with a
// vehicle. Cleared, the cluster still depth-sorts against ITSELF — so the cab is in
// front of the body and the roof is on top — while never losing to the scenery.

import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import type { Map as MlMap, CustomLayerInterface, CustomRenderMethodInput } from 'maplibre-gl';

import {
  makeCubeGeometry,
  makeCubeMaterial,
  applyCubeTheme,
  cubeSrgb,
  cubeLitAxis,
} from './voxelMesh';
import type { VoxelTheme } from './voxelCity';
import type { VehicleKind } from './sprites';

export const VOXEL_VEHICLE_LAYER = 'voxel-vehicles-3d';

const DEG = Math.PI / 180;

/** One vehicle to draw. Everything here is already in MapCard's tween state. */
export interface VoxelVehicle {
  lon: number;
  lat: number;
  /** degrees clockwise from north — the direction of travel */
  heading: number;
  /** agency route colour, `RRGGBB`, no leading '#' */
  color: string;
  kind: VehicleKind;
  selected: boolean;
  /** 0..1 fade, used by the same appear/disappear tween the sprites used */
  opacity: number;
}

/**
 * One cube of a vehicle model, in FRACTIONS OF THE VEHICLE'S DRAWN LENGTH.
 *   +x forward (the direction of travel), +y to the vehicle's left, z up from the road.
 * `tone` multiplies the route colour: 1 is the body, <1 is glass and shadowed trim,
 * >1 is the pale roof band the reference paints down the middle of its streetcar.
 *
 * FRACTIONS, NOT METRES — and the first version of this was metres, which is worth
 * recording because it looked obviously right and rendered obviously wrong. A 40-foot
 * bus really is 12.2 x 2.6 m, i.e. 4.7 : 1, and at the diorama's 0.68 m/px that draws
 * a 34 x 7 px sliver: a red dash on the route line, which is the exact complaint the
 * sprite was raised from 40 to 72 px to fix. Measured on the reference sheet, its
 * streetcar spans ~60 px at ~0.94 m/px — about 56 m, nearly twice a real Flexity — and
 * its body is roughly a quarter as wide as it is long. The reference is an
 * illustration and it sizes its vehicles for legibility, not to scale.
 *
 * So the ENVELOPE is stylised here in the same documented decorative register as the
 * buildings' compressed heights, and `LENGTH_PX` below is where the honesty line
 * sits: a vehicle's POSITION and HEADING are the agency's own data; its drawn size is
 * scenery, exactly like a tree's.
 */
interface ModelCube {
  /** centre offset along the vehicle */
  x: number;
  /** centre offset across the vehicle */
  y: number;
  /** base height above the road */
  z: number;
  len: number;
  wid: number;
  hgt: number;
  tone: number;
  /** when set, an absolute colour rather than a tint of the route colour */
  rgb?: [number, number, number];
}

/** Near-black glass, and the warm headlight pixel. Absolute, not route-tinted — a
 *  windscreen is not the colour of the livery, and the reference's is near-black in
 *  both themes. */
const GLASS: [number, number, number] = cubeSrgb('#12162a');
const LAMP: [number, number, number] = cubeSrgb('#ffe9b0');

/**
 * BODY and ROOF-BAND tones, as multipliers of the agency's own route colour.
 *
 * The HUE is never touched. A 504 is red and a 510 is red because the TTC publishes
 * those colours, and the badge floating over the vehicle uses the same value — a
 * vehicle recoloured for looks would be a legend that disagrees with itself.
 *
 * The VALUE is pulled down a step, and rendered frames are why. At tone 1.0 the roof
 * of a bus is full `#ED1C24` sitting in a diorama whose brightest surface is a
 * lavender roof around luminance 95: the vehicle stopped reading as an object in the
 * scene and started reading as a sticker on top of it, and it out-shouted the red
 * route line it is supposed to be travelling along. 0.90 puts the body just under the
 * route stroke and leaves the roof band as the brightest part of the vehicle, which
 * is the relationship the reference shows.
 */
const BODY_TONE = 0.90;
const ROOF_TONE = 1.16;

/**
 * THE MODELS. Every number is a fraction of the vehicle's drawn LENGTH.
 *
 * Each is a handful of cubes in the reference's own vocabulary:
 *   * a BODY at full length;
 *   * a pale ROOF BAND inset along the top, which is what makes the block read as lit
 *     from above rather than as a solid lozenge;
 *   * a dark GLASS cab wrapped over the front;
 *   * two HEADLIGHT pixels at the nose.
 * The streetcar additionally splits its body in two around a narrow dark ARTICULATION
 * joint — Toronto's are articulated, and the reference draws the seam.
 *
 * The 0.30-of-length body width is taken off the shipped sprite (`sprites.ts` drew a
 * streetcar body 0.28 wide by 0.72 long, i.e. 0.39 of its length, and a bus stubbier
 * still), which is the proportion this project's own design review already accepted.
 *
 * The TRAIN (GO/UP rail, route_type 1/2) is the streetcar's own articulated vocabulary
 * taken one step further: THREE coupled coach segments around two dark coupling seams,
 * so a GO train reads as a train and not as a long bus. Same cubes, same shader, same
 * honesty line — position and heading are the agency's, the body is scenery.
 */
const MODELS: Record<VehicleKind, ModelCube[]> = {
  bus: [
    { x: 0, y: 0, z: 0, len: 1.0, wid: 0.34, hgt: 0.26, tone: BODY_TONE },
    { x: -0.05, y: 0, z: 0.26, len: 0.80, wid: 0.23, hgt: 0.08, tone: ROOF_TONE },
    { x: 0.39, y: 0, z: 0.14, len: 0.20, wid: 0.345, hgt: 0.14, tone: 1, rgb: GLASS },
    { x: 0.485, y: 0.11, z: 0.05, len: 0.05, wid: 0.08, hgt: 0.06, tone: 1, rgb: LAMP },
    { x: 0.485, y: -0.11, z: 0.05, len: 0.05, wid: 0.08, hgt: 0.06, tone: 1, rgb: LAMP },
  ],
  streetcar: [
    { x: -0.25, y: 0, z: 0, len: 0.47, wid: 0.26, hgt: 0.21, tone: BODY_TONE },
    { x: 0.25, y: 0, z: 0, len: 0.47, wid: 0.26, hgt: 0.21, tone: BODY_TONE },
    // the articulation: narrower and darker, so the seam still reads at ~60 px
    { x: 0, y: 0, z: 0, len: 0.05, wid: 0.21, hgt: 0.19, tone: 0.5 },
    { x: -0.25, y: 0, z: 0.21, len: 0.40, wid: 0.17, hgt: 0.06, tone: ROOF_TONE },
    { x: 0.25, y: 0, z: 0.21, len: 0.40, wid: 0.17, hgt: 0.06, tone: ROOF_TONE },
    { x: 0.425, y: 0, z: 0.11, len: 0.14, wid: 0.265, hgt: 0.12, tone: 1, rgb: GLASS },
    { x: 0.485, y: 0.09, z: 0.04, len: 0.04, wid: 0.06, hgt: 0.05, tone: 1, rgb: LAMP },
    { x: 0.485, y: -0.09, z: 0.04, len: 0.04, wid: 0.06, hgt: 0.05, tone: 1, rgb: LAMP },
  ],
  train: [
    // three coupled coaches…
    { x: -0.34, y: 0, z: 0, len: 0.30, wid: 0.24, hgt: 0.20, tone: BODY_TONE },
    { x: 0, y: 0, z: 0, len: 0.30, wid: 0.24, hgt: 0.20, tone: BODY_TONE },
    { x: 0.34, y: 0, z: 0, len: 0.30, wid: 0.24, hgt: 0.20, tone: BODY_TONE },
    // …around two dark coupling seams, narrower and darker like the streetcar's joint
    { x: -0.17, y: 0, z: 0, len: 0.04, wid: 0.19, hgt: 0.18, tone: 0.5 },
    { x: 0.17, y: 0, z: 0, len: 0.04, wid: 0.19, hgt: 0.18, tone: 0.5 },
    // a roof band per coach, so each segment reads as its own lit car
    { x: -0.34, y: 0, z: 0.20, len: 0.24, wid: 0.15, hgt: 0.06, tone: ROOF_TONE },
    { x: 0, y: 0, z: 0.20, len: 0.24, wid: 0.15, hgt: 0.06, tone: ROOF_TONE },
    { x: 0.34, y: 0, z: 0.20, len: 0.24, wid: 0.15, hgt: 0.06, tone: ROOF_TONE },
    { x: 0.435, y: 0, z: 0.10, len: 0.13, wid: 0.245, hgt: 0.11, tone: 1, rgb: GLASS },
    { x: 0.485, y: 0.08, z: 0.04, len: 0.04, wid: 0.06, hgt: 0.05, tone: 1, rgb: LAMP },
    { x: 0.485, y: -0.08, z: 0.04, len: 0.04, wid: 0.06, hgt: 0.05, tone: 1, rgb: LAMP },
  ],
};

const MAX_VEHICLES = 400;
// The budget is the LARGEST model (the train's 11 cubes), so a worst-case all-train
// frame still fits every drawable vehicle instead of silently dropping the tail.
const MAX_CUBES = MAX_VEHICLES * 11;

/**
 * DRAWN LENGTH, in CSS pixels — the vehicle is sized in SCREEN space, exactly as
 * `voxelTrees` sizes a canopy and for the same reason.
 *
 * Measured off the reference sheet: its streetcar spans ~60 px in a pane at ~0.94
 * m/px. The bus is set shorter in the ratio the shipped sprite already used
 * (`sprites.ts`: bus body 0.56 of the sprite, streetcar 0.72), so a bus still reads as
 * the shorter vehicle without being drawn at the 2.5 : 1 ratio reality would give —
 * which at this scale would make every bus a dash.
 */
const LENGTH_PX: Record<VehicleKind, number> = { bus: 46, streetcar: 60, train: 76 };
/**
 * REAL envelopes, used only as clamps. The screen-space length is held between the
 * vehicle's true length (never draw one SMALLER than it is) and three times it (never
 * park an articulated bus across a city block), so a deep zoom converges on reality
 * and a wide one keeps the vehicle findable.
 *
 * The train's clamp is the DRAWN consist — three BiLevel coaches at 25.9 m — not a real
 * GO train's 10-12 (~300 m): the model IS three coaches, and clamping to a full consist
 * would park a train across half of downtown at street zoom. The envelope is stylised
 * scenery here exactly as the header documents for the other two.
 */
const REAL_LENGTH_M: Record<VehicleKind, number> = { bus: 12.2, streetcar: 30.2, train: 77.7 };
const MAX_OVERSIZE = 3;

const _q = new THREE.Quaternion();
const _axisZ = new THREE.Vector3(0, 0, 1);
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const _m4 = new THREE.Matrix4();
const _model = new THREE.Matrix4();

interface Origin {
  x: number; y: number; z: number; unitsPerMetre: number; lng: number; lat: number;
}
function makeOrigin(lng: number, lat: number): Origin {
  const mc = MercatorCoordinate.fromLngLat({ lng, lat }, 0);
  return { x: mc.x, y: mc.y, z: mc.z, unitsPerMetre: mc.meterInMercatorCoordinateUnits(), lng, lat };
}

export interface VoxelVehicleLayer extends CustomLayerInterface {
  setTheme(theme: VoxelTheme): void;
  /** Replace the drawn set. Cheap: writes instance matrices, allocates nothing. */
  setVehicles(list: readonly VoxelVehicle[]): void;
  stats(): { vehicles: number; cubes: number };
}

export function createVoxelVehicleLayer(opts: { theme: VoxelTheme }): VoxelVehicleLayer {
  let theme: VoxelTheme = opts.theme;
  let map: MlMap | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.Camera | null = null;
  let mesh: THREE.InstancedMesh | null = null;
  let mat: THREE.ShaderMaterial | null = null;
  let origin: Origin = makeOrigin(-79.38736, 43.645);
  let cubes = 0;
  let vehicles = 0;
  let pending: readonly VoxelVehicle[] = [];

  const iSize = new Float32Array(MAX_CUBES * 3);
  const iColor = new Float32Array(MAX_CUBES * 3);
  // The crevice term is a building feature (a cube abutting a shorter neighbour). A
  // vehicle has no such neighbours, so every entry stays zero and the shader's
  // crevice branch is inert — but the attribute has to exist, because it is the same
  // shader.
  const iNbr = new Float32Array(MAX_CUBES * 4);

  /** Rebuild the instance buffers for the current vehicle list. */
  function rebuild(): void {
    if (!map || !mesh) return;
    const list = pending;
    const zoom = map.getZoom();
    const lat = map.getCenter().lat;
    const mpp = (156543.03392 * Math.cos(lat * DEG)) / Math.pow(2, zoom + 1);

    let cube = 0;
    let drawn = 0;
    for (let v = 0; v < list.length && drawn < MAX_VEHICLES; v++) {
      const veh = list[v] as VoxelVehicle;
      if (!(veh.opacity > 0.02)) continue;
      const model = MODELS[veh.kind];
      // Drawn length in metres: the screen-space target, clamped into [real, 3x real].
      // Selection nudges it the same 18% the sprite's `ICON_SEL` did.
      const real = REAL_LENGTH_M[veh.kind];
      const wanted = LENGTH_PX[veh.kind] * mpp;
      const lenM = Math.min(real * MAX_OVERSIZE, Math.max(real, wanted))
        * (veh.selected ? 1.18 : 1);

      // Heading is degrees clockwise from north; the scene's yaw is counter-clockwise
      // from east (+x). east = 90 deg of heading, so yaw = 90 - heading.
      const yaw = (90 - veh.heading) * DEG;
      const cs = Math.cos(yaw);
      const sn = Math.sin(yaw);
      _q.setFromAxisAngle(_axisZ, yaw);

      const mc = MercatorCoordinate.fromLngLat({ lng: veh.lon, lat: veh.lat }, 0);
      const vx = (mc.x - origin.x) / origin.unitsPerMetre;
      const vy = -(mc.y - origin.y) / origin.unitsPerMetre;

      const body = cubeSrgb(`#${veh.color}`);

      for (let i = 0; i < model.length && cube < MAX_CUBES; i++) {
        const c = model[i] as ModelCube;
        const ox = c.x * lenM;
        const oy = c.y * lenM;
        // Rotate the model-space offset into the world, then translate.
        _pos.set(vx + ox * cs - oy * sn, vy + ox * sn + oy * cs, c.z * lenM);
        _m.compose(_pos, _q, _scl);
        mesh.setMatrixAt(cube, _m);

        iSize[cube * 3] = c.len * lenM;
        iSize[cube * 3 + 1] = c.wid * lenM;
        iSize[cube * 3 + 2] = c.hgt * lenM;

        const rgb = c.rgb ?? body;
        // The fade is applied to the COLOUR rather than through alpha blending: these
        // are opaque cubes sharing one depth buffer, and a transparent pass would have
        // to sort them against each other every frame. Fading toward the ground tone
        // is what the city already does for its route-focus mute.
        const f = veh.opacity * c.tone;
        iColor[cube * 3] = Math.min(1, rgb[0] * f);
        iColor[cube * 3 + 1] = Math.min(1, rgb[1] * f);
        iColor[cube * 3 + 2] = Math.min(1, rgb[2] * f);
        cube++;
      }
      drawn++;
    }

    cubes = cube;
    vehicles = drawn;
    mesh.count = cube;
    mesh.instanceMatrix.needsUpdate = true;
    (mesh.geometry.getAttribute('iSize') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (mesh.geometry.getAttribute('iColor') as THREE.InstancedBufferAttribute).needsUpdate = true;
    map.triggerRepaint();
  }

  const layer: VoxelVehicleLayer = {
    id: VOXEL_VEHICLE_LAYER,
    type: 'custom',
    renderingMode: '3d',

    onAdd(m: MlMap, gl: WebGL2RenderingContext) {
      map = m;
      const c0 = m.getCenter();
      origin = makeOrigin(c0.lng, c0.lat);

      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
      renderer.autoClearColor = false;
      renderer.autoClearDepth = false;
      renderer.autoClearStencil = false;
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

      scene = new THREE.Scene();
      camera = new THREE.Camera();
      camera.matrixAutoUpdate = false;

      const box = makeCubeGeometry();
      box.setAttribute('iSize', new THREE.InstancedBufferAttribute(iSize, 3));
      box.setAttribute('iColor', new THREE.InstancedBufferAttribute(iColor, 3));
      box.setAttribute('iNbr', new THREE.InstancedBufferAttribute(iNbr, 4));

      mat = makeCubeMaterial(theme);
      mesh = new THREE.InstancedMesh(box, mat, MAX_CUBES);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);

      rebuild();
    },

    render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
      if (!renderer || !scene || !camera || !mat || !map || cubes === 0) return;

      const um = origin.unitsPerMetre;
      _model.makeTranslation(origin.x, origin.y, origin.z);
      _m4.makeScale(um, -um, um);
      _model.multiply(_m4);

      camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]);
      camera.projectionMatrix.multiply(_model);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

      const axis = cubeLitAxis(theme, map.getBearing());
      (mat.uniforms.uLitAxis.value as THREE.Vector2).set(axis[0], axis[1]);
      // A vehicle is already sized in screen space by `rebuild`, so it must NOT
      // take the city's zoom height gain — that exists to hold a BUILDING's apparent
      // proportions as the camera pulls back, and applying it here would grow a bus
      // taller without growing it longer.
      mat.uniforms.uHeightGain.value = 1;
      // Bevel in metres, held near-constant on screen exactly as the city does. A
      // vehicle is a tenth the size of a block, so it needs its own, smaller floor or
      // the whole model turns to soft edge.
      const lat = map.getCenter().lat;
      const mpp = (156543.03392 * Math.cos(lat * DEG)) / Math.pow(2, map.getZoom() + 1);
      mat.uniforms.uBevelM.value = Math.max(0.18, mpp * 0.5);
      // The roof seam needs the same treatment and for a sharper reason. It is sized
      // for a 24 m city cube (SEAM_M is 2.6 m), and a streetcar is about 2.6 m WIDE —
      // left at the city's value it would dim the entire roof of every vehicle toward
      // its wall tone and the model would read as one dark lump. Scaled to the
      // vehicle's own cube size it does here what it does on a block: it shows where
      // one cube of the cluster ends and the next begins.
      mat.uniforms.uSeamM.value = Math.max(0.22, mpp * 0.6);

      const canvas = map.getCanvas();
      renderer.resetState();
      renderer.setViewport(0, 0, canvas.width, canvas.height);
      renderer.setScissorTest(false);
      // §C: nothing in the scenery may hide a vehicle. Clearing depth puts every
      // vehicle in front of every building while leaving the cluster's own cubes to
      // sort against each other normally. Safe here because this layer sits above all
      // 3D content in the style order — only the invisible `marker-blockers` symbols
      // are drawn after it.
      renderer.clearDepth();
      renderer.render(scene, camera);
    },

    onRemove() {
      mesh?.geometry.dispose();
      mat?.dispose();
      renderer?.dispose();
      renderer = null; scene = null; camera = null; mesh = null; mat = null; map = null;
      cubes = 0; vehicles = 0;
    },

    setTheme(next: VoxelTheme) {
      if (theme === next) return;
      theme = next;
      // Every uniform the theme owns, not just the two wall ratios. This used to set
      // uLit/uShade only, so a swapped theme left a bus wearing the other theme's
      // crevice, AO, face gradient and seam depth.
      if (mat) applyCubeTheme(mat, theme);
      map?.triggerRepaint();
    },

    setVehicles(list: readonly VoxelVehicle[]) {
      pending = list;
      rebuild();
    },

    stats() {
      return { vehicles, cubes };
    },
  };

  return layer;
}

// ---------------------------------------------------------------- install
//
// The same facade shape `voxelCity.ts` uses, for the same reason: MapCard should say
// "add the vehicles", not know what a custom layer is.

const STATE = new WeakMap<MlMap, { layer: VoxelVehicleLayer; theme: VoxelTheme }>();

/**
 * Add (or re-theme) the 3D vehicles. `before` places them ABOVE the flat `vehicles`
 * symbol layer and below `marker-blockers`, so the models are drawn over the route
 * and the city, and the invisible collision boxes that keep street names off the app's
 * marker cards remain the last symbol layer.
 *
 * @returns true if the models are now present.
 */
export function addVoxelVehicleLayers(map: MlMap, theme: VoxelTheme, before?: string): boolean {
  const existing = STATE.get(map);
  if (map.getLayer(VOXEL_VEHICLE_LAYER) && existing) {
    setVoxelVehicleTheme(map, theme);
    return true;
  }
  if (map.getLayer(VOXEL_VEHICLE_LAYER)) map.removeLayer(VOXEL_VEHICLE_LAYER);
  const layer = createVoxelVehicleLayer({ theme });
  try {
    map.addLayer(layer, before);
  } catch {
    // No WebGL2, or a context loss mid-add. The flat sprite layer is still there and
    // still correct, so the honest degradation is "sprites", never "no vehicles".
    return false;
  }
  STATE.set(map, { layer, theme });
  return true;
}

export function removeVoxelVehicleLayers(map: MlMap): void {
  if (map.getLayer(VOXEL_VEHICLE_LAYER)) map.removeLayer(VOXEL_VEHICLE_LAYER);
  STATE.delete(map);
}

export function hasVoxelVehicleLayers(map: MlMap): boolean {
  return !!map.getLayer(VOXEL_VEHICLE_LAYER);
}

export function setVoxelVehicleTheme(map: MlMap, theme: VoxelTheme): void {
  const st = STATE.get(map);
  if (!st) return;
  st.layer.setTheme(theme);
  STATE.set(map, { ...st, theme });
}

/** Push the current tweened set. Called from MapCard's rAF loop — writes instance
 *  matrices only, so this is the cheap path the GeoJSON re-upload was not. */
export function setVoxelVehicles(map: MlMap, list: readonly VoxelVehicle[]): void {
  STATE.get(map)?.layer.setVehicles(list);
}

/** Diagnostics for the verification harness. */
export function voxelVehicleStats(map: MlMap): { vehicles: number; cubes: number } | null {
  return STATE.get(map)?.layer.stats() ?? null;
}
