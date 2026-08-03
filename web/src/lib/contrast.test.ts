// onBrandPair's whole job is to make a claim that can be checked: that the pair it hands
// back genuinely clears WCAG AA. So the test re-derives the ratio from scratch — from the
// returned hex strings, with its own independent implementation of the WCAG formula —
// rather than trusting the `ratio` field the function reports about itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { onBrandPair, readableOn, AA_NORMAL } from './contrast.ts';

/** WCAG 2.x relative luminance + contrast, written out again on purpose. */
function lum(hex: string): number {
  const h = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function cr(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function hue(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const x = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (x / 6) * 360;
}

/** Real GTFS route_color values from the seeded agencies, plus the trough that broke it. */
const REAL_ROUTE_COLOURS = [
  'ED1C24', // TTC red — the 504 King, the colour in every screenshot
  '00A650', // a TTC green
  '0161AB', // TTC blue
  'F57F29', // an orange
  'FFCC00', // a yellow — near-black wins here
  '8944AB', // the app's own brand purple
  '2E7D32', 'C62828', '1565C0', '6A1B9A', '00838F', '4E342E',
  '808080', // dead mid-grey: the worst case for max(white, black)
  '767676', '7A7A7A', '858585', // the luminance trough either side of it
];

test('every real route colour ends up with a pair that clears AA', () => {
  for (const c of REAL_ROUTE_COLOURS) {
    const p = onBrandPair(c);
    const measured = cr(p.fg, p.bg);
    assert.ok(
      measured >= AA_NORMAL,
      `${c}: fg ${p.fg} on bg ${p.bg} measured ${measured.toFixed(2)}:1, needs ${AA_NORMAL}`,
    );
    // And the function's own report must agree with an independent measurement.
    assert.ok(Math.abs(measured - p.ratio) < 0.01, `${c}: reported ${p.ratio}, measured ${measured}`);
  }
});

test('the de-emphasised tone clears AA too — opacity is not how this is done', () => {
  for (const c of REAL_ROUTE_COLOURS) {
    const p = onBrandPair(c);
    const measured = cr(p.fgMuted, p.bg);
    assert.ok(
      measured >= AA_NORMAL,
      `${c}: muted ${p.fgMuted} on bg ${p.bg} measured ${measured.toFixed(2)}:1`,
    );
    assert.ok(Math.abs(measured - p.mutedRatio) < 0.01);
  }
});

test('the muted tone is genuinely de-emphasised, not just a second copy of fg', () => {
  // On a colour with room to move it should differ; it is allowed to equal fg where the
  // background leaves no headroom, which is the honest outcome rather than a fake one.
  const withRoom = onBrandPair('ED1C24');
  assert.notEqual(withRoom.fgMuted, withRoom.fg);
  assert.ok(cr(withRoom.fgMuted, withRoom.bg) <= cr(withRoom.fg, withRoom.bg));
});

test('the trough that motivated this really was below AA before the fix', () => {
  /**
   * The premise, measured rather than asserted: `readableOn` is a max() over two fixed
   * candidates, and that maximum has a floor. Swept across all 256 greys the worst case
   * is #7b7b7b at 4.269:1 (relative luminance 0.198) — no choice of foreground reaches
   * AA there, which is the entire reason this module exists. If this test ever stops
   * failing on the naive path, the module can be deleted.
   */
  const naive = (hex: string) => cr(readableOn(hex), `#${hex.replace('#', '')}`);
  assert.ok(naive('7b7b7b') < AA_NORMAL, 'the premise of this whole module is wrong');
  assert.ok(Math.abs(naive('7b7b7b') - 4.269) < 0.01);

  // Every grey the naive path fails, the pair rescues — and there really are some.
  const failing: string[] = [];
  for (let v = 0; v < 256; v++) {
    const hex = v.toString(16).padStart(2, '0').repeat(3);
    if (naive(hex) < AA_NORMAL) failing.push(hex);
  }
  assert.ok(failing.length > 0, 'no grey fails AA, so this module is solving nothing');
  for (const hex of failing) {
    const p = onBrandPair(hex);
    assert.equal(p.adjusted, true, `${hex} needed adjusting and was left alone`);
    assert.ok(cr(p.fg, p.bg) >= AA_NORMAL, `${hex} still fails after onBrandPair`);
  }
});

test('no colour anywhere in the sRGB cube escapes the guarantee', () => {
  // A coarse sweep of the whole space, not just the colours transit agencies happen to
  // publish today. A route_color is agency-supplied data and can be anything at all.
  let checked = 0;
  for (let r = 0; r < 256; r += 17) {
    for (let g = 0; g < 256; g += 17) {
      for (let b = 0; b < 256; b += 17) {
        const hex = [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
        const p = onBrandPair(hex);
        assert.ok(cr(p.fg, p.bg) >= AA_NORMAL, `${hex}: ${cr(p.fg, p.bg).toFixed(2)}:1`);
        assert.ok(cr(p.fgMuted, p.bg) >= AA_NORMAL, `${hex} muted: ${cr(p.fgMuted, p.bg).toFixed(2)}:1`);
        checked++;
      }
    }
  }
  assert.ok(checked > 4000, `only swept ${checked} colours`);
});

test('a colour that already clears AA is left exactly alone', () => {
  // Near-black plate, white text: nothing to fix, so nothing may move.
  const p = onBrandPair('101010');
  assert.equal(p.adjusted, false);
  assert.equal(p.bg.toLowerCase(), '#101010');
});

test('the route keeps its hue — only lightness moves', () => {
  for (const c of REAL_ROUTE_COLOURS) {
    const p = onBrandPair(c);
    const before = hue(`#${c}`), after = hue(p.bg);
    // Greys have no meaningful hue; everything else must stay put.
    const isGrey = (() => {
      const h = c, [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
      return Math.max(r, g, b) - Math.min(r, g, b) < 6;
    })();
    if (isGrey) continue;
    const delta = Math.min(Math.abs(before - after), 360 - Math.abs(before - after));
    assert.ok(delta < 2, `${c}: hue moved ${delta.toFixed(1)}deg (${before} -> ${after})`);
  }
});

test('garbage in does not produce an unreadable button', () => {
  for (const bad of ['', '#', 'xyz', '12', '#12345']) {
    const p = onBrandPair(bad);
    assert.ok(cr(p.fg, p.bg) >= AA_NORMAL, `${bad} produced an illegible fallback`);
    // The REPORTED ratio is the one a caller would trust, so it has to be true as well —
    // the fallback used to claim a flat 21:1, which is the black-on-white maximum and not
    // a number this pair has ever had.
    assert.ok(
      Math.abs(cr(p.fg, p.bg) - p.ratio) < 0.01,
      `${bad}: reported ${p.ratio.toFixed(2)}, measured ${cr(p.fg, p.bg).toFixed(2)}`,
    );
    assert.ok(Math.abs(cr(p.fgMuted, p.bg) - p.mutedRatio) < 0.01);
  }
});

test('the worst case in the whole space is covered explicitly, not by luck', () => {
  // The lattice sweep steps by 17 and never lands on #7b7b7b, so the one colour this
  // module was built for is named here rather than left to a coincidence of stride.
  for (const hex of ['7b7b7b', '7a7a7a', '7c7c7c', '777777', '7e7e7e']) {
    const p = onBrandPair(hex);
    assert.ok(cr(p.fg, p.bg) >= AA_NORMAL, `${hex}: ${cr(p.fg, p.bg).toFixed(3)}:1`);
    assert.ok(cr(p.fgMuted, p.bg) >= AA_NORMAL);
  }
});
