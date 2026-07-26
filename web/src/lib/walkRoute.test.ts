// The walk router, against real geometry.
//
// `fixtures/walk-king-spadina.json` is not a hand-drawn grid. It is the actual
// OpenStreetMap content of the two OpenFreeMap z14 tiles that cover King St W &
// Spadina Ave — 734 walkable ways and 378 building footprints, exactly as the
// running app receives them from its own basemap source. Two tiles, deliberately:
// the seam between them is where vector-tile clipping breaks a naive graph, and one
// of the tests below exists to prove the healing pass is load-bearing rather than
// decorative.
//
// The headline test is the user's own complaint, made measurable: how many metres of
// the drawn line lie INSIDE a building.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routeWalk, haversineM, pathMidpoint, type WalkLine } from './walkRoute.ts';

interface Fixture {
  lines: { c: string; s: string | null; g: [number, number][] }[];
  buildings: [number, number][][];
}
const fx: Fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/walk-king-spadina.json', import.meta.url), 'utf8'),
);
const WAYS: WalkLine[] = fx.lines.map((l) => ({ coords: l.g, steps: l.s === 'steps' }));

/** King St W at Spadina Ave — the boarding stop these walks all end at. */
const KING_SPADINA = { lat: 43.6455, lon: -79.3958 };
const WALKS: [string, { lat: number; lon: number }][] = [
  ['from the northwest', { lat: 43.6478, lon: -79.3990 }],
  ['from south of the rail corridor', { lat: 43.6410, lon: -79.3930 }],
  ['from the west', { lat: 43.6470, lon: -79.4030 }],
  ['from inside the block', { lat: 43.6462, lon: -79.3975 }],
  ['from the north', { lat: 43.6495, lon: -79.3960 }],
];

// ---------------------------------------------------------------- geometry probes

function pointInRing(p: readonly [number, number], r: readonly [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > p[1]) !== (b[1] > p[1])
      && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
/** Metres of a polyline that lie inside a building footprint, sampled every ~2 m. */
function metresInsideBuildings(coords: readonly (readonly [number, number])[]): number {
  let inside = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const len = haversineM({ lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] });
    if (len === 0) continue;
    const n = Math.max(1, Math.ceil(len / 2));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const p: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (fx.buildings.some((r) => pointInRing(p, r))) inside += len / n;
    }
  }
  return inside;
}

// ---------------------------------------------------------------- the complaint

test('the drawn walk stops cutting through buildings', () => {
  // MEASURED on this fixture. The straight line spends 15-61% of its length inside
  // building footprints; the routed line spends 1-15%, and what is left is the two
  // end stubs (you do walk out of the building you are standing in) plus places
  // where OSM draws a footway under a footprint. The assertion is deliberately
  // comparative and generous — this test must fail when routing regresses, not when
  // a single sidewalk in Toronto is retraced.
  for (const [name, from] of WALKS) {
    const straight: [number, number][] = [[from.lon, from.lat], [KING_SPADINA.lon, KING_SPADINA.lat]];
    const routed = routeWalk(WAYS, from, KING_SPADINA);
    assert.ok(routed, `${name}: expected a route`);
    const badStraight = metresInsideBuildings(straight);
    const badRouted = metresInsideBuildings(routed.coordinates);
    assert.ok(badStraight > 0.15 * haversineM(from, KING_SPADINA),
      `${name}: the straight line should be the bad one (only ${badStraight.toFixed(0)} m inside)`);
    assert.ok(badRouted <= 0.5 * badStraight,
      `${name}: routed ${badRouted.toFixed(0)} m inside buildings vs straight ${badStraight.toFixed(0)} m`);
    assert.ok(badRouted <= 0.2 * routed.distanceM,
      `${name}: ${badRouted.toFixed(0)} m of a ${routed.distanceM} m route is inside a building`);
  }
});

test('a routed walk is longer than the crow flies, and not absurdly so', () => {
  for (const [name, from] of WALKS) {
    const straight = haversineM(from, KING_SPADINA);
    const routed = routeWalk(WAYS, from, KING_SPADINA);
    assert.ok(routed, `${name}: expected a route`);
    const ratio = routed.distanceM / straight;
    assert.ok(ratio >= 1, `${name}: routed ${routed.distanceM} m < straight ${straight.toFixed(0)} m`);
    assert.ok(ratio <= 2.2, `${name}: detour ratio ${ratio.toFixed(2)} is not a walk anyone would take`);
    assert.ok(routed.coordinates.length >= 4, `${name}: ${routed.coordinates.length} points is not a street-following line`);
  }
});

test('the line begins under the rider and ends under the stop', () => {
  // The map draws this between a You beacon and a stop pin. A path that starts at
  // the kerb instead of at the rider leaves a visible gap under both.
  const from = WALKS[0][1];
  const r = routeWalk(WAYS, from, KING_SPADINA);
  assert.ok(r);
  assert.deepEqual(r.coordinates[0], [from.lon, from.lat]);
  assert.deepEqual(r.coordinates[r.coordinates.length - 1], [KING_SPADINA.lon, KING_SPADINA.lat]);
});

test('rejoining tile-clipped ways is load-bearing, not decoration', () => {
  // Vector tiles are clipped, so a street crossing the seam between these two tiles
  // arrives as two pieces whose cut ends land in the middle of one another. Without
  // the healing pass the graph comes apart along that seam. This is the measurement
  // that chose `healM`: four of these five walks have no path at all unhealed.
  let broken = 0;
  for (const [, from] of WALKS) {
    const healed = routeWalk(WAYS, from, KING_SPADINA);
    const raw = routeWalk(WAYS, from, KING_SPADINA, { healM: 0 });
    assert.ok(healed);
    if (raw == null || raw.distanceM > healed.distanceM * 1.5) broken++;
  }
  assert.ok(broken >= 3, `only ${broken}/5 walks needed healing — has the fixture changed?`);
});

test('a rider and a stop on the same block still get a route', () => {
  // REGRESSION. Attaching the rider splits a segment in two and pushes the second
  // half; an index built before that split cannot see the pushed half, so the stop's
  // projection clamped to the end of the truncated first half — the very node the
  // rider had just attached to. Both ends collapsed onto one node and the shortest
  // walk in the app, along one block, returned no route at all.
  const cases: [string, { lat: number; lon: number }, { lat: number; lon: number }][] = [
    ['100 m along King', { lat: 43.64545, lon: -79.39700 }, { lat: 43.64535, lon: -79.39580 }],
    ['40 m along King', { lat: 43.64545, lon: -79.39620 }, { lat: 43.64543, lon: -79.39570 }],
    ['90 m along Spadina', { lat: 43.64600, lon: -79.39585 }, { lat: 43.64520, lon: -79.39575 }],
    ['30 m, one sidewalk', { lat: 43.64550, lon: -79.39600 }, { lat: 43.64550, lon: -79.39563 }],
  ];
  for (const [name, a, b] of cases) {
    const r = routeWalk(WAYS, a, b);
    assert.ok(r, `${name}: expected a route across one block`);
    assert.ok(r.distanceM >= haversineM(a, b), `${name}: shorter than the crow flies`);
    // Crossing a six-lane road to reach the far kerb genuinely triples a 30 m walk;
    // what must not happen is a route measured in kilometres.
    assert.ok(r.distanceM - haversineM(a, b) < 250, `${name}: ${r.distanceM} m detour is not one block`);
  }
});

test("the app's own opening view routes — 225 m, and it used to fall back", () => {
  // REGRESSION, and the one that mattered most: this is GhostBus's DEFAULT_LOCATION
  // (Front & Spadina) walking to the stop the board opens on (King St W at Spadina
  // Ave West Side). It is the first thing a rider sees. With the heal tolerance at
  // 3 m one unjoined 7 m gap sent the route 1152 m round the block — over the detour
  // ceiling — so the opening screen drew the straight line it is this wave's whole
  // job to remove. Verified identically against lines captured out of the running
  // app's own tile cache.
  const from = { lat: 43.64354, lon: -79.39699 };
  const to = { lat: 43.64537, lon: -79.395811 };
  const r = routeWalk(WAYS, from, to);
  assert.ok(r, 'the opening view must route');
  const ratio = r.distanceM / haversineM(from, to);
  assert.ok(ratio < 2.2, `routed ${r.distanceM} m for a ${haversineM(from, to).toFixed(0)} m walk (${ratio.toFixed(2)}x)`);
  assert.equal(routeWalk(WAYS, from, to, { healM: 3 }), null,
    'if 3 m now works, re-measure the tolerance rather than deleting this test');
});

test('the same query twice is the same answer', () => {
  // The graph is mutated while the two ends are attached to it, so a router that
  // cached and reused one would drift. It builds a fresh graph per query.
  const from = WALKS[2][1];
  const a = routeWalk(WAYS, from, KING_SPADINA);
  const b = routeWalk(WAYS, from, KING_SPADINA);
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------- the refusals

test('no ways, no route — and it says so rather than inventing one', () => {
  assert.equal(routeWalk([], WALKS[0][1], KING_SPADINA), null);
});

test('a rider nowhere near a mapped way gets no route', () => {
  // Out in the lake: genuinely off the network, and a route from there would have to
  // start somewhere the rider is not.
  assert.equal(routeWalk(WAYS, { lat: 43.6300, lon: -79.3958 }, KING_SPADINA), null);
});

test('a non-finite endpoint gets no route', () => {
  assert.equal(routeWalk(WAYS, { lat: NaN, lon: -79.3958 }, KING_SPADINA), null);
  assert.equal(routeWalk(WAYS, WALKS[0][1], { lat: 43.6455, lon: Infinity }), null);
});

test('an absurd detour is refused rather than drawn', () => {
  // A graph with a hole in it can be connected and still only offer a route several
  // times longer than the crow flies. That is a symptom of missing data, not a fact
  // about the walk.
  const from = WALKS[0][1];
  assert.ok(routeWalk(WAYS, from, KING_SPADINA));
  assert.equal(routeWalk(WAYS, from, KING_SPADINA, { detourCeiling: 1.2 }), null);
});

// ---------------------------------------------------------------- steps

test('the step-free profiles are routed around staircases', () => {
  // Two parallel ways between the same ends: a short staircase and a longer ramp.
  const stair: WalkLine = { coords: [[-79.4, 43.645], [-79.4, 43.6455], [-79.3995, 43.6455]], steps: true };
  const ramp: WalkLine = {
    coords: [[-79.4, 43.645], [-79.3990, 43.645], [-79.3990, 43.6455], [-79.3995, 43.6455]],
  };
  const from = { lat: 43.645, lon: -79.4 };
  const to = { lat: 43.6455, lon: -79.3995 };
  const withSteps = routeWalk([stair, ramp], from, to);
  const stepFree = routeWalk([stair, ramp], from, to, { avoidSteps: true });
  assert.ok(withSteps && stepFree);
  assert.ok(stepFree.distanceM > withSteps.distanceM,
    'the step-free route should be the longer one, or the staircase was still used');
});

test('no step-free way at all is no route, not a staircase anyway', () => {
  const stair: WalkLine = { coords: [[-79.4, 43.645], [-79.4, 43.6455], [-79.3995, 43.6455]], steps: true };
  assert.equal(
    routeWalk([stair], { lat: 43.645, lon: -79.4 }, { lat: 43.6455, lon: -79.3995 }, { avoidSteps: true }),
    null,
  );
});

// ---------------------------------------------------------------- midpoint

test('the walker glyph sits halfway ALONG the path, not halfway between its ends', () => {
  // An L-shaped path: the midpoint of the two ENDS is out in the middle of the
  // block, which is where the walker used to float.
  const L: [number, number][] = [[-79.4, 43.645], [-79.4, 43.6460], [-79.3980, 43.6460]];
  const mid = pathMidpoint(L);
  assert.ok(mid);
  // Half the length is 111 m up + 55 m across (the vertical leg is ~111 m, the
  // horizontal ~161 m), so the midpoint lies on the horizontal leg near its start.
  assert.equal(mid[1], 43.6460);
  assert.ok(mid[0] > -79.4 && mid[0] < -79.3980);
  assert.deepEqual(pathMidpoint([[-79.4, 43.645]]), [-79.4, 43.645]);
  assert.equal(pathMidpoint([]), null);
});
