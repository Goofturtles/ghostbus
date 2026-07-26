// Guards on the canopy cluster (DECISIONS §40). The first version of `canopyCubes`
// dealt its satellite heights from `hashCoord(lon, lat)` — the same hash `KEEP`
// already uses to decide whether a tree exists at all. Every surviving centre
// therefore has a hash in [0, KEEP] = [0, 0.2], `floor(h * 4)` is always 0, and every
// canopy in the city came out as the same stamp. Nothing in a screenshot says so at a
// glance; this test does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canopyCubes, hashCoord, treeMetrics, metresPerPixel } from './voxelTrees.ts';

const M = { canopy: 12, top: 16.2, capBase: 11 };

test('a canopy is a cluster of five cubes, one of them the full-size centre', () => {
  const cubes = canopyCubes(-79.396, 43.6445, M);
  assert.equal(cubes.length, 5);
  const centre = cubes[0]!;
  assert.equal(centre.lon, -79.396);
  assert.equal(centre.lat, 43.6445);
  assert.equal(centre.side, M.canopy);
  assert.equal(centre.top, M.top);
  // no satellite may exceed the centre — a cluster can never be taller or wider than
  // the single box it replaced
  for (const c of cubes.slice(1)) {
    assert.ok(c.side <= centre.side, `satellite side ${c.side} > centre ${centre.side}`);
    assert.ok(c.top < centre.top, `satellite top ${c.top} >= centre ${centre.top}`);
    assert.ok(c.top > 0 && Number.isFinite(c.top));
    assert.ok(Number.isFinite(c.lon) && Number.isFinite(c.lat));
  }
});

test('the cap band keeps its proportion on every cube', () => {
  for (const c of canopyCubes(-79.4, 43.65, M)) {
    assert.ok(Math.abs(c.capBase / c.top - M.capBase / M.top) < 1e-9);
  }
});

test('clusters DIFFER between centres — the height deal is not dealt by the survival hash', () => {
  // Only centres with hashCoord(lon, lat) <= KEEP (0.2) are ever planted, so the deal
  // must not read that same hash. Sample real survivors and require more than one
  // distinct height profile among them.
  const profiles = new Set<string>();
  let survivors = 0;
  for (let i = 0; i < 4000 && survivors < 400; i++) {
    const lon = -79.42 + (i % 80) * 1e-4;
    const lat = 43.63 + Math.floor(i / 80) * 1e-4;
    const qLon = Math.round(lon * 1e5) / 1e5;
    const qLat = Math.round(lat * 1e5) / 1e5;
    if (hashCoord(qLon, qLat) > 0.2) continue; // the module's own KEEP gate
    survivors++;
    profiles.add(canopyCubes(qLon, qLat, M).slice(1).map((c) => c.top.toFixed(3)).join(','));
  }
  assert.ok(survivors > 50, `expected a decent sample of planted trees, got ${survivors}`);
  assert.ok(profiles.size > 1,
    `every planted canopy has the same height profile (${profiles.size} distinct over ${survivors} trees)`);
});

test('clusters are deterministic — the same verge always grows the same tree', () => {
  const a = canopyCubes(-79.3961, 43.6446, M);
  const b = canopyCubes(-79.3961, 43.6446, M);
  assert.deepEqual(a, b);
});

test('the cluster still fits inside the spacing it is planted on', () => {
  // At both metre clamps: overall span is 1.76 canopies, and two trees are never
  // closer than `spacing`, so canopies cannot merge into a hedge.
  for (const zoom of [14.8, 16.182, 18]) {
    const m = treeMetrics(43.6445, zoom);
    assert.ok(m.canopy * 1.76 < m.spacing,
      `at z${zoom} cluster span ${(m.canopy * 1.76).toFixed(1)} m >= spacing ${m.spacing.toFixed(1)} m`);
  }
});

test('metresPerPixel is the documented 256-px-tile constant', () => {
  // Pinned because every _PX constant in the module is calibrated against it; see the
  // note on CANOPY_PX. Changing it would silently resize every tree in the app.
  assert.ok(Math.abs(metresPerPixel(0, 0) - 156_543.033_928) < 1e-3);
});
