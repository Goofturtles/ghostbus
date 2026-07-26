// COLD-START REGRESSION GUARD.
//
// `selectedStopId` used to be seeded with `'4197'` — the stop id from the design
// mockup in `voxelLab.ts`, which is not a stop the TTC has. The consequence was not
// cosmetic: on every cold load the app fired `GET /api/stops/4197/arrivals`, the
// server answered 404, `useLive` classified that as `badRequest`, and `apiFailure`
// went up — so the first thing a rider saw, every time, was the panel saying our
// server was in trouble. Out of coverage it fired twice and nothing displaced it.
// Confirmed on 11 of 11 cold loads by the R4 console sweep.
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
