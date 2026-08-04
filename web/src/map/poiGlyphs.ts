// POI CATEGORY GLYPHS — the small marks that sit to the left of a place name.
//
// Drawn procedurally onto a canvas and registered as MapLibre images, exactly as
// `sprites.ts` draws the vehicles, for the same reason: this app never ships a
// default basemap look, and a downloaded icon set would be somebody else's drawing
// language sitting inside ours. Eight categories, two themes, cached after the first
// draw — the whole set is sixteen ~26px images.
//
// LINE GLYPHS, NOT FILLED PICTOGRAMS, and the stroke weight is not a taste call: the
// app's own icons (`components/icons.tsx`) are 24-unit viewBoxes stroked at 2, so at
// a 13 CSS px glyph the matching weight is 2/24 * 13 ~ 1.1 CSS px. These are drawn at
// device resolution and registered with `pixelRatio: 2`, so nothing is ever upscaled.
//
// THE STATION GLYPH IS THE ONE THAT IS COLOURED. It is drawn in the app's transit
// purple — the same colour as the tappable stop circles and the walk path — because a
// station IS transit and this map has exactly one colour for that. Every other
// category is drawn in the quiet label tone: a cafe is wayfinding, not a claim.

import { POI_INK, type MapTheme } from './mapStyle';

/** The categories the POI layers resolve OSM classes down to. Deliberately few: the
 *  voxel city is the identity and these are supporting marks, so eight is the whole
 *  vocabulary. See `poiCategory` in mapStyle.ts for the class -> category mapping. */
export type PoiCategory =
  | 'station' | 'landmark' | 'hospital' | 'school'
  | 'civic' | 'park' | 'food' | 'cafe' | 'shop';

/** Glyph box in CSS px. Sized against the 11-12.5px label beside it: a mark taller
 *  than its own cap height stops being a mark and starts being an icon. */
const G = 13;
const DPR = 2;

/** RGBA image + pixelRatio, ready for `map.addImage()`. Mirrors `SpriteImage`. */
export interface GlyphImage {
  width: number;
  height: number;
  data: Uint8Array;
  pixelRatio: number;
}

/** `poi-<category>-<theme>` — the id the style's `icon-image` expression builds. */
export function poiGlyphId(cat: PoiCategory, theme: MapTheme): string {
  return `poi-${cat}-${theme}`;
}

/** Parse an id built by `poiGlyphId` back into its parts, or null if it is not one
 *  of ours. This is what lets the `styleimagemissing` handler answer lazily instead
 *  of the map having to pre-register sixteen images it may never draw. */
export function parsePoiGlyphId(id: string): { cat: PoiCategory; theme: MapTheme } | null {
  const m = /^poi-([a-z]+)-(dark|light)$/.exec(id);
  if (!m) return null;
  const cats: readonly string[] =
    ['station', 'landmark', 'hospital', 'school', 'civic', 'park', 'food', 'cafe', 'shop'];
  if (!cats.includes(m[1])) return null;
  return { cat: m[1] as PoiCategory, theme: m[2] as MapTheme };
}

/**
 * Draw one glyph. Coordinates are authored in a 0..1 box and scaled up, so the same
 * paths hold if `G` ever moves.
 */
export function makePoiGlyph(cat: PoiCategory, theme: MapTheme): GlyphImage {
  const px = G * DPR;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, px, px);

  const ink = cat === 'station' ? POI_INK[theme].transit : POI_INK[theme].quiet;
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = 2.1 * DPR * (G / 24);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Unit-box helpers. `u` maps 0..1 onto the canvas with a small margin so a round
  // cap at the extremes is not clipped by the image edge.
  const M = 0.10;
  const u = (v: number) => (M + v * (1 - 2 * M)) * px;
  const line = (pts: [number, number][]) => {
    ctx.beginPath();
    ctx.moveTo(u(pts[0][0]), u(pts[0][1]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(u(pts[i][0]), u(pts[i][1]));
    ctx.stroke();
  };
  const dot = (x: number, y: number, r: number) => {
    ctx.beginPath();
    ctx.arc(u(x), u(y), r * px, 0, Math.PI * 2);
    ctx.fill();
  };

  switch (cat) {
    case 'station': {
      // A transit box on two rails — the same shape family as the stop bubble's tile.
      ctx.beginPath();
      const x = u(0.16), y = u(0.06), w = u(0.84) - x, h = u(0.76) - y, r = 0.22 * w;
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
      ctx.stroke();
      line([[0.16, 0.48], [0.84, 0.48]]);
      line([[0.26, 0.78], [0.14, 1.0]]);
      line([[0.74, 0.78], [0.86, 1.0]]);
      break;
    }
    case 'landmark': {
      // A five-point star: the one mark that reads "somewhere worth knowing" without
      // committing to what kind of place it is (this tier holds a stadium, a museum
      // and a monument at once).
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rad = i % 2 === 0 ? 0.5 : 0.21;
        const px2 = u(0.5 + Math.cos(a) * rad);
        const py2 = u(0.5 + Math.sin(a) * rad);
        if (i === 0) ctx.moveTo(px2, py2); else ctx.lineTo(px2, py2);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'hospital':
      line([[0.5, 0.08], [0.5, 0.92]]);
      line([[0.08, 0.5], [0.92, 0.5]]);
      break;
    case 'school':
      // A mortarboard: the cap, then the band under it.
      line([[0.5, 0.14], [0.96, 0.38], [0.5, 0.62], [0.04, 0.38], [0.5, 0.14]]);
      line([[0.22, 0.47], [0.22, 0.78], [0.5, 0.9], [0.78, 0.78], [0.78, 0.47]]);
      break;
    case 'civic':
      // A pediment over columns — a library, a town hall, a courthouse.
      line([[0.06, 0.36], [0.5, 0.08], [0.94, 0.36]]);
      line([[0.06, 0.92], [0.94, 0.92]]);
      line([[0.24, 0.44], [0.24, 0.82]]);
      line([[0.5, 0.44], [0.5, 0.82]]);
      line([[0.76, 0.44], [0.76, 0.82]]);
      break;
    case 'park':
      // A canopy on a trunk, echoing the voxel trees on the ground below it.
      ctx.beginPath();
      ctx.arc(u(0.5), u(0.38), 0.30 * (1 - 2 * M) * px, 0, Math.PI * 2);
      ctx.stroke();
      line([[0.5, 0.68], [0.5, 0.96]]);
      break;
    case 'food':
      // Fork and knife.
      line([[0.28, 0.06], [0.28, 0.94]]);
      line([[0.12, 0.06], [0.12, 0.36], [0.44, 0.36], [0.44, 0.06]]);
      line([[0.74, 0.94], [0.74, 0.06]]);
      line([[0.74, 0.06], [0.92, 0.24], [0.74, 0.5]]);
      break;
    case 'cafe':
      // A cup with a handle and a saucer.
      line([[0.14, 0.24], [0.14, 0.62], [0.62, 0.62], [0.62, 0.24], [0.14, 0.24]]);
      ctx.beginPath();
      ctx.arc(u(0.66), u(0.40), 0.16 * (1 - 2 * M) * px, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
      line([[0.06, 0.86], [0.72, 0.86]]);
      break;
    case 'shop':
      // A shopping bag with its handle.
      line([[0.1, 0.32], [0.9, 0.32], [0.82, 0.94], [0.18, 0.94], [0.1, 0.32]]);
      ctx.beginPath();
      ctx.arc(u(0.5), u(0.32), 0.19 * (1 - 2 * M) * px, Math.PI, 0);
      ctx.stroke();
      break;
  }
  // A period at the end of the sentence for the categories that want a centre mark.
  if (cat === 'park') dot(0.5, 0.38, 0.045);

  const d = ctx.getImageData(0, 0, px, px);
  return { width: px, height: px, data: new Uint8Array(d.data.buffer.slice(0)), pixelRatio: DPR };
}
