// Colour contrast maths — the one place GhostBus decides what text may sit on what.
//
// IT LIVES APART FROM Primitives.tsx FOR THE SAME REASON lib/walk.ts LIVES APART FROM
// format.ts: that file imports the i18n runtime, and with it the DOM, so nothing in it
// can be exercised in a plain Node test. A contrast guarantee that cannot be tested is
// not a guarantee, so the arithmetic moved here and Primitives re-exports it.

/** Text color that stays legible on any GTFS route_color — picks whichever of
 *  white / near-black yields the higher WCAG contrast ratio against the badge. */
function relLum(r: number, g: number, b: number): number {
  const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(l1: number, l2: number): number {
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
export function readableOn(hex: string): string {
  const h = hex.replace('#', '');
  if (h.length < 6) return '#ffffff';
  const bg = relLum(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
  const white = relLum(255, 255, 255), dark = relLum(20, 22, 29);
  return contrast(bg, dark) > contrast(bg, white) ? '#14161d' : '#ffffff';
}

// =====================================================================================
// onBrandPair — a route colour that is guaranteed to carry text, not merely likely to.
// =====================================================================================
//
// `readableOn` picks the BETTER of white and near-black. Better is not the same as good:
// the function is a max() over two options, and that maximum has a floor. Around
// relative luminance 0.196 the two candidates are equally bad and the best available
// ratio bottoms out at ~4.27:1 — under the 4.5:1 AA threshold for normal text, with no
// choice of foreground able to fix it. Transit brand colours are not scattered randomly
// either; mid-luminance reds, greens and blues sit exactly in that trough.
//
// So where the foreground cannot be made to work, the BACKGROUND moves. The hue is
// preserved — it is the route's published identity and the thing a rider recognises —
// and only its lightness shifts, in small steps, until the pair genuinely clears AA.
// The shift is typically a few percent and invisible next to the unmodified badge.
//
// This is deliberately NOT applied to `RouteBadge` here. That is an app-wide change with
// its own review surface; this pair exists for the one control that is a large filled
// button carrying two lines of text.

interface Rgb { r: number; g: number; b: number }

function parseHex(hex: string): Rgb | null {
  const h = hex.replace('#', '');
  if (h.length < 6) return null;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return [r, g, b].every(Number.isFinite) ? { r, g, b } : null;
}
const toHex = ({ r, g, b }: Rgb): string =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const lumOf = (c: Rgb): number => relLum(c.r, c.g, c.b);
/** WCAG contrast between two colours (not two luminances — see `contrast` above). */
const ratio = (a: Rgb, b: Rgb): number => contrast(lumOf(a), lumOf(b));

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? ((G - B) / d + (G < B ? 6 : 0))
    : max === G ? (B - R) / d + 2
      : (R - G) / d + 4;
  return { h: h / 6, s, l };
}
function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): Rgb {
  if (s === 0) { const v = l * 255; return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const chan = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: chan(h + 1 / 3) * 255, g: chan(h) * 255, b: chan(h - 1 / 3) * 255 };
}

/** AA for normal text. The whole point of this module is not to ship anything under it. */
export const AA_NORMAL = 4.5;
/**
 * What the adjustment actually AIMS for, above the hard floor.
 *
 * Stopping the moment the primary label clears 4.5:1 leaves zero headroom, and then the
 * de-emphasised second line has nowhere to go — it comes back identical to the primary
 * and the button has no typographic hierarchy at all. Aiming a little higher buys a
 * secondary tone that is visibly quieter AND still clears AA on its own.
 *
 * AA_NORMAL remains the guarantee; this is only the target. Where the colour runs out of
 * lightness before reaching it, the pair still ships at >= AA_NORMAL and simply forgoes
 * the de-emphasis, which is the honest outcome rather than a quieter illegible one.
 */
const FG_TARGET = 5.2;
/** How far the background lightness moves per attempt. Small enough that the route stays
 *  recognisably its own colour; 50 steps covers the whole range either way. */
const L_STEP = 0.02;

/**
 * SNAP TO WHAT WILL ACTUALLY BE PAINTED before measuring it.
 *
 * `hslToRgb` and the blend below both produce fractional channels, and `toHex` rounds
 * them on the way out. Measuring the float and shipping the rounded value is how a pair
 * that computed as 4.50:1 reached the browser at 4.49:1 — a real failure this test suite
 * caught. Every ratio in this module is therefore taken on quantised channels.
 */
const quant = (c: Rgb): Rgb => ({
  r: Math.max(0, Math.min(255, Math.round(c.r))),
  g: Math.max(0, Math.min(255, Math.round(c.g))),
  b: Math.max(0, Math.min(255, Math.round(c.b))),
});

export interface BrandPair {
  /** the background to paint — the route's hue, lightness adjusted only if it had to be. */
  bg: string;
  /** a foreground guaranteed >= AA_NORMAL against `bg`. */
  fg: string;
  /** a DE-EMPHASISED foreground that still clears AA_NORMAL against `bg`. */
  fgMuted: string;
  /** the achieved ratio of `fg` on `bg`, so a test can assert on it. */
  ratio: number;
  /** the achieved ratio of `fgMuted` on `bg`. */
  mutedRatio: number;
  /** true when the background had to be moved to get there. */
  adjusted: boolean;
}

export function onBrandPair(hex: string): BrandPair {
  const base = parseHex(hex);
  if (!base) {
    // An unusable colour falls back to the app's own brand — and REPORTS ITS REAL RATIOS.
    // These were hardcoded as 21 (the black-on-white maximum), which is a number this pair
    // does not have; `ratio` is documented as something a test may assert on, so a lie
    // here is a lie in exactly the field that exists to be trusted.
    const brandBg = parseHex('#8944ab') as Rgb;
    const brandFg = parseHex(readableOn('8944ab')) as Rgb;
    return {
      bg: toHex(brandBg), fg: toHex(brandFg), fgMuted: toHex(brandFg),
      ratio: ratio(brandFg, brandBg), mutedRatio: ratio(brandFg, brandBg), adjusted: false,
    };
  }

  const fgHex = readableOn(hex);
  const fg = parseHex(fgHex) as Rgb;

  // Which way does lightness have to travel? Away from the foreground: a white label
  // wants a darker plate, a near-black label a lighter one.
  const dir = lumOf(fg) > 0.5 ? -1 : 1;
  const hsl = rgbToHsl(base);

  let bg = quant(base);
  let adjusted = false;
  for (let i = 0; i < 50 && ratio(fg, bg) < FG_TARGET; i++) {
    const l = Math.max(0, Math.min(1, hsl.l + dir * L_STEP * (i + 1)));
    const next = quant(hslToRgb({ ...hsl, l }));
    // Pure black under white (or pure white under near-black) is the end of the road and
    // always clears AA, so this terminates. Stop rather than spin on an unchanging value.
    const atBound = l === 0 || l === 1;
    bg = next;
    adjusted = true;
    if (atBound) break;
  }

  /**
   * DE-EMPHASIS WITHOUT OPACITY.
   *
   * The sub-label used `opacity: 0.86`, which is invisible to every static contrast check
   * — the declared colour still reads as pure white — while the COMPOSITED pixels landed
   * near 3.4:1. Opacity is a lie a colour audit cannot see. So the muted tone is a real
   * colour, blended toward the background only as far as it can go while still clearing
   * AA, and it is measured on the quantised value that will actually be painted.
   */
  let fgMuted = fg;
  // Integer steps: `t += 0.05` accumulates to 0.6000000000000001 and never satisfies a
  // `<= 0.6` bound, so the stated ceiling would have been fiction.
  for (let step = 1; step <= 12; step++) {
    const t = step * 0.05;
    const blended = quant({
      r: fg.r + (bg.r - fg.r) * t,
      g: fg.g + (bg.g - fg.g) * t,
      b: fg.b + (bg.b - fg.b) * t,
    });
    if (ratio(blended, bg) < AA_NORMAL) break;
    fgMuted = blended;
  }

  return {
    bg: toHex(bg),
    fg: fgHex,
    fgMuted: toHex(fgMuted),
    ratio: ratio(fg, bg),
    mutedRatio: ratio(fgMuted, bg),
    adjusted,
  };
}
