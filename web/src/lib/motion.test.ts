// THE ENTRY ANIMATIONS MUST NOT BE ABLE TO HIDE CONTENT.
//
// This pins the fix for a production defect: a plan rendered its "4 ways to get there"
// heading and its time axis with no option cards under them. The cards were in the DOM at
// full height the whole time — they were painted at `opacity: 0` because their entry
// animation had not advanced. An animation advances only when the compositor produces
// frames, so a phone whose renderer stalls for a moment (this app draws a WebGL map and a
// voxel diorama beside the plan) shows the heading, which has no entry animation, and
// nothing else.
//
// The rule that follows, and the only one that cannot strand: an entry animation on
// CONTENT may move it, but must never make it transparent. Every frame of the animation —
// including the first, which `animation-fill-mode: both` paints indefinitely while the
// animation is pending — has to be legible.
//
// Read from the stylesheet rather than asserted about a component, because the defect was
// in the stylesheet and there is no DOM in this test runner. Scoped to the keyframes that
// CONTENT lists use; sheets and scrims may still fade, since a sheet that has not appeared
// yet is not a claim the rider is missing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = ['../styles/app.css', '../styles/journey.css']
  .map((p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'))
  .join('\n');

/** The body of `@keyframes <name> { ... }`, braces balanced one level deep. */
function keyframeBody(name: string): string {
  const at = css.indexOf(`@keyframes ${name}`);
  assert.notEqual(at, -1, `@keyframes ${name} is missing from the stylesheets`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  assert.fail(`@keyframes ${name} is not closed`);
}

/** The keyframes that CONTENT enters with. Both are used by lists a rider reads. */
const CONTENT_REVEALS = ['reveal', 'reveal-row'];

for (const name of CONTENT_REVEALS) {
  test(`@keyframes ${name} never animates opacity — a starved frame must stay legible`, () => {
    const body = keyframeBody(name);
    assert.ok(
      !/\bopacity\s*:/.test(body),
      `@keyframes ${name} sets opacity. An element holding this keyframe's first frame ` +
      'while the compositor is stalled would be invisible, which is the "heading with no ' +
      'cards under it" defect this rule exists to prevent. Move it, do not fade it.',
    );
    assert.ok(/transform\s*:/.test(body), `@keyframes ${name} should still move something`);
  });
}

test('the option cards still enter with the shared cascade, and still fill BOTH ways', () => {
  // `both` is what holds the final frame after the animation ends. Dropping it would
  // reintroduce a different flavour of the same bug — a card that snaps back to its
  // offset once the animation is done.
  const rule = /\.opt-list > \.opt-card \{ animation: reveal-row [^}]*\bboth\b[^}]*\}/;
  assert.ok(rule.test(css), 'the option-card entry rule should keep `reveal-row` and `both`');
});

test('reduced motion still flattens the option-card stagger', () => {
  // A delay left in place under reduced motion holds the first frame for its duration.
  // That is harmless now that the first frame is legible, but the rider asked for less
  // motion, so the cascade must still collapse.
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(
    /\.opt-list > \.opt-card:nth-child\(n\)/.test(reduced),
    'the reduced-motion arm should still name the option cards',
  );
});
