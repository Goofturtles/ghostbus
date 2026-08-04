// COLD-START REGRESSION GUARD.
//
// `selectedStopId` used to be seeded with `'4197'` — the stop id from the design
// mockup in `voxelLab.ts`, which is not a stop the TTC has. The consequence was not
// cosmetic: on every cold load the app fired `GET /api/stops/4197/arrivals`, the
// server answered 404, `useLive` classified that as `badRequest`, and `apiFailure`
// went up — so the first thing a rider saw, every time, was the panel saying our
// server was in trouble. Out of coverage it fired twice and nothing displaced it.
// Measured by the R4 console sweep: the 404 fired on 10 of 10 cold loads, plus an
// 11th firing when entering Plan while out of coverage.
//
// This test pins the rule that prevents it coming back: AT COLD START NOTHING IS
// SELECTED, so no request can be made for a stop nobody chose. The real selection is
// made by `loadNearby`, from stops the agency actually returned.
//
// Two globals are stubbed because `store.ts` reads `localStorage` for the locale at
// module scope and its `./i18n` import sets `document.documentElement.lang`. The stubs
// are deliberately inert — this test asserts the DEFAULT, so anything a real
// localStorage might restore would defeat the point.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// `globalThis` is typed with the DOM lib here, so `localStorage` is a required
// `Storage` — assigning a two-method stub to it does not typecheck and implementing
// the whole interface would be noise. An index-signature view is the narrow escape.
const g = globalThis as unknown as Record<string, unknown>;
const hadLocalStorage = 'localStorage' in g;
const hadDocument = 'document' in g;
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.document = { documentElement: { lang: 'en', setAttribute() {}, removeAttribute() {} } };

const { useStore } = await import('./store');

// Put the environment back. This file runs in the same process as every other test.
if (!hadLocalStorage) delete g.localStorage;
if (!hadDocument) delete g.document;

test('cold start selects no stop, so no arrivals request can fire for a mockup id', () => {
  const id = useStore.getState().selectedStopId;
  assert.equal(id, '', `cold start must carry no stop id, got ${JSON.stringify(id)}`);
  // Stated as its own assertion because THIS is the property that matters: whatever
  // the initial value is, it must be falsy, because `refetchArrivals` guards on
  // exactly that (`if (!stopId) return;`). A future "harmless" placeholder like
  // 'none' would pass an equality check against itself and still fire a request.
  assert.ok(!id, 'the initial stop id must be falsy — refetchArrivals gates on it');
});

test('selectStop is what puts a real stop in the store', () => {
  useStore.getState().selectStop('5678');
  assert.equal(useStore.getState().selectedStopId, '5678');
  useStore.getState().selectStop('');
  assert.equal(useStore.getState().selectedStopId, '');
});

// ---------------------------------------------------------------- choose on map
//
// The map and the plan surface are built by different hands against this contract, so
// it is pinned here rather than left to agree by accident.

// ------------------------------------------------------------- named places

test('home and work start EMPTY — a seeded Home is a guess about where somebody lives', () => {
  const n = useStore.getState().named;
  assert.equal(n.home, null);
  assert.equal(n.work, null);
});

test('setting a named place stores it and clearing it empties the slot', () => {
  const home = { agency: 'ttc', stopId: '1111', name: 'Home Stop', lat: 43.7, lon: -79.4, ts: 0 };
  useStore.getState().setNamedPlace('home', home);
  assert.equal(useStore.getState().named.home?.stopId, '1111');
  // The other slot is not touched: they are two independent places.
  assert.equal(useStore.getState().named.work, null);
  useStore.getState().setNamedPlace('home', null);
  assert.equal(useStore.getState().named.home, null);
});

// ------------------------------------------------------- the two ends of a trip

const office = {
  kind: 'stop' as const,
  place: { agency: 'ttc', stopId: '999', name: 'Office', lat: 43.66, lon: -79.4, ts: 0 },
};

test('the trip starts at the rider until they say otherwise', () => {
  assert.equal(useStore.getState().planOrigin.kind, 'here');
  assert.equal(useStore.getState().planTarget, null);
});

test('swapPlanEnds actually reverses the two ends', () => {
  // THE REGRESSION THIS EXISTS FOR: `swapEnds` answers in {origin, target} and the store
  // holds {planOrigin, planTarget}. Spreading the result set two keys nothing reads and
  // left both ends untouched — a button that type-checked, shipped, and did nothing.
  const s = useStore.getState();
  s.setPlanTarget(office);
  s.swapPlanEnds();
  assert.equal(useStore.getState().planOrigin.kind, 'stop');
  assert.equal(useStore.getState().planTarget?.kind, 'here');
  // Its own inverse.
  useStore.getState().swapPlanEnds();
  assert.equal(useStore.getState().planOrigin.kind, 'here');
  assert.equal(useStore.getState().planTarget?.kind, 'stop');
  useStore.getState().setPlanTarget(null);
});

test('only a real stop is written to the persisted recents', () => {
  const s = useStore.getState();
  const before = useStore.getState().recentTrips.length;
  // A map pin has no agency and no stop id: remembering it would write a row that
  // `recentPlaces` discards on the next boot.
  s.setPlanTarget({ kind: 'pin', lat: 43.7, lon: -79.5, label: 'Dropped pin' });
  assert.equal(useStore.getState().recentTrips.length, before);
  // A stop this file has not used yet — `pushRecent` de-duplicates, so reusing `office`
  // would leave the length unchanged for the RIGHT reason and prove nothing.
  s.setPlanTarget({
    kind: 'stop',
    place: { agency: 'ttc', stopId: '4242', name: 'Somewhere Else', lat: 43.7, lon: -79.41, ts: 0 },
  });
  assert.equal(useStore.getState().recentTrips.length, before + 1);
  useStore.getState().setPlanTarget(null);
});

test('map pick is off at cold start', () => {
  assert.equal(useStore.getState().mapPick, null);
});

test('beginMapPick carries which end of the trip is being picked', () => {
  useStore.getState().beginMapPick('origin');
  assert.deepEqual(useStore.getState().mapPick, { target: 'origin' });
  // A second begin REPLACES the first — one crosshair, not two.
  useStore.getState().beginMapPick('dest');
  assert.deepEqual(useStore.getState().mapPick, { target: 'dest' });
  useStore.getState().cancelMapPick();
});

test('picking takes the map, so it closes the sheets that would cover it', () => {
  useStore.getState().openSettings(true);
  useStore.getState().openStopSheet(true);
  useStore.getState().openSearch('destination');
  useStore.getState().beginMapPick('dest');
  const s = useStore.getState();
  assert.equal(s.settingsOpen, false);
  assert.equal(s.aboutOpen, false);
  assert.equal(s.stopSheet, false);
  assert.equal(s.searchMode, null);
  useStore.getState().cancelMapPick();
});

test('cancel and complete both end pick mode', () => {
  useStore.getState().beginMapPick('origin');
  useStore.getState().cancelMapPick();
  assert.equal(useStore.getState().mapPick, null);

  useStore.getState().beginMapPick('dest');
  useStore.getState().completeMapPick({ lat: 43.6465, lon: -79.39, label: 'King St W' });
  assert.equal(useStore.getState().mapPick, null);
});

test('a completed pick lands on the END it was picked for, as a pin', () => {
  const s = useStore.getState();
  s.setPlanTarget(null);
  s.setPlanOrigin({ kind: 'here' });

  s.beginMapPick('dest');
  s.completeMapPick({ lat: 43.6465, lon: -79.39, label: 'King St W' });
  assert.equal(useStore.getState().planTarget?.kind, 'pin');
  // The origin is untouched: picking one end is not a statement about the other.
  assert.equal(useStore.getState().planOrigin.kind, 'here');
  // And the rider is taken to the surface that answers the question they just asked.
  assert.equal(useStore.getState().tab, 'plan');

  useStore.getState().beginMapPick('origin');
  useStore.getState().completeMapPick({ lat: 43.7, lon: -79.5, label: 'Somewhere' });
  assert.equal(useStore.getState().planOrigin.kind, 'pin');
  assert.equal(useStore.getState().planTarget?.kind, 'pin');

  useStore.getState().setPlanTarget(null);
  useStore.getState().setPlanOrigin({ kind: 'here' });
});

test('a pick with no target in flight ends pick mode and invents no end', () => {
  const s = useStore.getState();
  s.setPlanTarget(null);
  s.setPlanOrigin({ kind: 'here' });
  s.cancelMapPick();
  s.completeMapPick({ lat: 43.6, lon: -79.4, label: 'Nowhere' });
  assert.equal(useStore.getState().mapPick, null);
  assert.equal(useStore.getState().planTarget, null);
  assert.equal(useStore.getState().planOrigin.kind, 'here');
});

test('a completed pick must not be written to the persisted trips list', () => {
  // A map-picked point has no agency and no stop id, so a `RecentPlace` built from one
  // is dropped by `recentPlaces` on the next boot. Writing it anyway would put rows in
  // localStorage that exist only to be discarded — see the note on `completeMapPick`.
  const before = useStore.getState().recentTrips.length;
  useStore.getState().beginMapPick('dest');
  useStore.getState().completeMapPick({ lat: 43.6465, lon: -79.39, label: '43.64650, -79.39000' });
  assert.equal(useStore.getState().recentTrips.length, before);
});
