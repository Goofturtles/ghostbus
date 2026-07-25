// Procedural voxel-look vehicle sprites, drawn once per (kind, color) on an
// offscreen canvas and registered as MapLibre images. Chunky 3D-block bodies:
// a route-colored roof, a darker extruded side (light from top-left), a dark
// window band at the front, tiny yellow headlight pixels, and a soft contact
// shadow. Drawn pointing NORTH so the symbol layer's icon-rotate = heading
// aims the front down the direction of travel.

export type VehicleKind = 'bus' | 'streetcar';

/** RGBA image + pixelRatio, ready for map.addImage(). */
export interface SpriteImage {
  width: number;
  height: number;
  data: Uint8Array;
  pixelRatio: number;
}

/**
 * Base sprite size in CSS px (before pixelRatio).
 *
 * RAISED 40 -> 72. Measured off `ghostbus-design-reference.png`: the streetcar
 * under the 504A badge is about 5.3% of the map frame's width. On the 944px-wide
 * desktop map pane that is ~50 CSS px, and the shipped sprite was drawing a ~25px
 * body — "a red lozenge", "debris on the route line". A streetcar body is
 * `0.72 * S` long, so S = 72 puts it at 51.8px.
 *
 * Deliberately raised HERE rather than by pushing `icon-size` past 1: MapLibre
 * upscales a symbol image with bilinear filtering, so doubling icon-size on a 40px
 * sprite gives a blurry 50px lozenge instead of a crisp 50px vehicle. The atlas
 * cost is bounded — two kinds times the handful of agency colours in view.
 */
const S = 72;
const DPR = 2;

/** The sprite's on-screen box in CSS px at `icon-size: 1`. Exported so MapCard can
 *  place the route badge relative to the vehicle instead of to a magic number. */
export const SPRITE_SIZE_PX = S;

function clamp8(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : Math.round(n);
}

/** Lighten (amt>0) / darken (amt<0) a #RRGGBB hex, returns an rgb() string. */
function shade(hex: string, amt: number): string {
  const h = hex.replace('#', '');
  let r = parseInt(h.slice(0, 2), 16);
  let g = parseInt(h.slice(2, 4), 16);
  let b = parseInt(h.slice(4, 6), 16);
  if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  else { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
  return `rgb(${clamp8(r)}, ${clamp8(g)}, ${clamp8(b)})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Build one voxel vehicle sprite tinted `hex` (no leading '#'). */
export function makeVoxelSprite(kind: VehicleKind, hex: string): SpriteImage {
  const px = S * DPR;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(DPR, DPR);
  ctx.clearRect(0, 0, S, S);

  const cx = S / 2;
  const cy = S / 2;
  const bw = kind === 'streetcar' ? S * 0.28 : S * 0.32;
  const bh = kind === 'streetcar' ? S * 0.72 : S * 0.56;
  // Deep enough to read as an extrusion at this size. This is the visible SIDE of
  // the block — at 40px it was 3.6px and invisible, which is why the sprite read
  // as a flat lozenge rather than a solid.
  const depth = S * 0.10;
  const r = kind === 'streetcar' ? S * 0.055 : S * 0.07;

  const roofX = cx - bw / 2;
  const roofY = cy - bh / 2 - depth / 2; // bias up so the block sits centered incl. its extrusion

  // --- contact shadow (soft ellipse, offset down) ---
  ctx.save();
  ctx.translate(cx, roofY + bh + depth * 0.7);
  ctx.scale(1, 0.4);
  const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, bw * 0.95);
  grd.addColorStop(0, 'rgba(0,0,0,0.38)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(0, 0, bw * 0.95, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // --- wheels: dark blocks peeking out of the extruded side, drawn UNDER the body
  //     so only their outer edge shows, exactly as a voxel model would read ------
  ctx.fillStyle = 'rgba(14, 16, 26, 0.9)';
  const wW = bw * 0.20;
  const wH = bh * 0.13;
  for (const fy of kind === 'streetcar' ? [0.20, 0.50, 0.78] : [0.24, 0.74]) {
    const wy = roofY + bh * fy;
    roundRect(ctx, roofX - wW * 0.42 + depth * 0.55, wy + depth * 0.9, wW, wH, wW * 0.3);
    ctx.fill();
    roundRect(ctx, roofX + bw - wW * 0.58 + depth * 0.55, wy + depth * 0.9, wW, wH, wW * 0.3);
    ctx.fill();
  }

  // --- extruded side/base (darkest), offset down-right ---
  ctx.fillStyle = shade(hex, -0.5);
  roundRect(ctx, roofX + depth * 0.55, roofY + depth, bw, bh, r);
  ctx.fill();
  // The side face's own lit edge, so the extrusion has two values rather than one
  // flat dark slab — the same wall/cap split the buildings use.
  ctx.fillStyle = shade(hex, -0.3);
  roundRect(ctx, roofX + depth * 0.55, roofY + depth, bw * 0.34, bh, r);
  ctx.fill();

  // --- roof / top face (base color) ---
  ctx.fillStyle = `#${hex}`;
  roundRect(ctx, roofX, roofY, bw, bh, r);
  ctx.fill();

  // crisp outline for definition on either theme
  ctx.lineWidth = 0.9;
  ctx.strokeStyle = shade(hex, -0.55);
  ctx.stroke();

  // --- pale roof band running the length of the car (light from the top-left) ---
  ctx.fillStyle = shade(hex, 0.46);
  roundRect(ctx, roofX + bw * 0.16, roofY + bh * 0.07, bw * 0.30, bh * 0.86, r * 0.6);
  ctx.fill();

  // --- dark window strip down the sunward flank ------------------------------
  ctx.fillStyle = 'rgba(12, 16, 30, 0.66)';
  roundRect(ctx, roofX + bw * 0.60, roofY + bh * 0.20, bw * 0.26, bh * 0.62, r * 0.5);
  ctx.fill();

  // --- lit windshield at the front (top) -------------------------------------
  ctx.fillStyle = 'rgba(10, 14, 28, 0.88)';
  roundRect(ctx, roofX + bw * 0.11, roofY + bh * 0.055, bw * 0.78, bh * 0.13, r * 0.5);
  ctx.fill();
  ctx.fillStyle = 'rgba(190, 214, 255, 0.5)';
  roundRect(ctx, roofX + bw * 0.15, roofY + bh * 0.07, bw * 0.70, bh * 0.05, r * 0.35);
  ctx.fill();
  // streetcars get a rear window band too
  if (kind === 'streetcar') {
    ctx.fillStyle = 'rgba(12, 16, 30, 0.62)';
    roundRect(ctx, roofX + bw * 0.11, roofY + bh * 0.84, bw * 0.78, bh * 0.10, r * 0.5);
    ctx.fill();
  }

  // --- headlight pixels at the very front ---
  ctx.fillStyle = '#ffe9b0';
  const hlY = roofY + bh * 0.015;
  const hlW = bw * 0.15;
  ctx.fillRect(roofX + bw * 0.14, hlY, hlW, hlW * 0.8);
  ctx.fillRect(roofX + bw * 0.71, hlY, hlW, hlW * 0.8);

  const img = ctx.getImageData(0, 0, px, px);
  return { width: px, height: px, data: new Uint8Array(img.data.buffer.slice(0)), pixelRatio: DPR };
}

/** Stable image id for a (kind, color) sprite. */
export function spriteId(kind: VehicleKind, color: string): string {
  return `veh-${kind}-${color}`;
}

/** Vehicle kind from a GTFS route_type (0 = tram/streetcar, else bus-shaped). */
export function kindForRouteType(routeType: number | null): VehicleKind {
  return routeType === 0 ? 'streetcar' : 'bus';
}
