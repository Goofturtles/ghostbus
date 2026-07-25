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

/** Base sprite size in CSS px (before pixelRatio). */
const S = 40;
const DPR = 2;

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
  const bw = kind === 'streetcar' ? S * 0.34 : S * 0.42;
  const bh = kind === 'streetcar' ? S * 0.72 : S * 0.60;
  const depth = S * 0.09;           // extrusion toward the shadow side
  const r = kind === 'streetcar' ? S * 0.07 : S * 0.09;

  const roofX = cx - bw / 2;
  const roofY = cy - bh / 2 - depth / 2; // bias up so the block sits centered incl. its extrusion

  // --- contact shadow (soft ellipse, offset down) ---
  ctx.save();
  ctx.translate(cx, roofY + bh + depth * 0.7);
  ctx.scale(1, 0.4);
  const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, bw * 0.8);
  grd.addColorStop(0, 'rgba(0,0,0,0.34)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(0, 0, bw * 0.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // --- extruded side/base (darkest), offset down-right ---
  ctx.fillStyle = shade(hex, -0.42);
  roundRect(ctx, roofX + depth * 0.55, roofY + depth, bw, bh, r);
  ctx.fill();

  // --- roof (base color) ---
  ctx.fillStyle = `#${hex}`;
  roundRect(ctx, roofX, roofY, bw, bh, r);
  ctx.fill();

  // crisp outline for definition on either theme
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = shade(hex, -0.5);
  ctx.stroke();

  // --- roof highlight strip (light from top-left) ---
  ctx.fillStyle = shade(hex, 0.28);
  roundRect(ctx, roofX + bw * 0.14, roofY + bh * 0.06, bw * 0.24, bh * 0.86, r * 0.6);
  ctx.fill();

  // --- windshield band near the front (top) ---
  ctx.fillStyle = 'rgba(12, 16, 30, 0.82)';
  roundRect(ctx, roofX + bw * 0.12, roofY + bh * 0.10, bw * 0.76, bh * 0.17, r * 0.5);
  ctx.fill();
  // streetcars get a second (rear) window band
  if (kind === 'streetcar') {
    ctx.fillStyle = 'rgba(12, 16, 30, 0.55)';
    roundRect(ctx, roofX + bw * 0.12, roofY + bh * 0.66, bw * 0.76, bh * 0.15, r * 0.5);
    ctx.fill();
  }

  // --- headlight pixels at the very front ---
  ctx.fillStyle = '#ffe08a';
  const hlY = roofY + bh * 0.045;
  const hlW = bw * 0.14;
  ctx.fillRect(roofX + bw * 0.16, hlY, hlW, hlW);
  ctx.fillRect(roofX + bw * 0.70, hlY, hlW, hlW);

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
