// When the app is allowed to spend an address lookup, and what it remembers afterwards.
//
// The trigger rules matter more than they look: every lookup costs a stranger's free
// endpoint a request, and the whole reason this feature is acceptable is that it fires
// where the stop search has already failed the rider rather than on every keystroke.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeAddress, shouldGeocode, pushRecentGeocode, filterRecentGeocodes,
  THIN_STOP_RESULTS, type RecentGeocode,
} from './geocode.ts';
import type { GeocodeResultDto } from '../../../shared/types.ts';

function addr(label: string, lat = 43.65, lon = -79.38): GeocodeResultDto {
  return { label, title: label, context: '', lat, lon };
}

// ---------------- when to look ----------------

test('a query that opens with a house number is an address, and asks immediately', () => {
  // No stop in any seeded agency is named "193 Yonge" — stops are "King St W At Spadina
  // Ave" — so a rider who types this has already told us what they want.
  assert.ok(looksLikeAddress('193 Yonge Street'));
  assert.ok(shouldGeocode('193 Yonge Street', 25), 'even a full stop list does not answer it');
});

test('a BARE number is a stop code, not an address — the stop search owns it', () => {
  assert.equal(looksLikeAddress('14663'), false);
  assert.equal(shouldGeocode('14663', 5), false, 'a healthy stop list answers a stop code');
});

test('a healthy stop list is left alone', () => {
  assert.equal(shouldGeocode('dundas', THIN_STOP_RESULTS), false);
  assert.equal(shouldGeocode('dundas', 12), false);
});

test('a THIN stop list is what earns a lookup', () => {
  assert.ok(shouldGeocode('dundas', THIN_STOP_RESULTS - 1));
  assert.ok(shouldGeocode('nowhere at all', 0));
});

test('a query too short to mean anything never spends a request', () => {
  assert.equal(shouldGeocode('yo', 0), false);
  assert.equal(shouldGeocode('  ', 0), false);
});

// ---------------- what to remember ----------------

test('a chosen address goes to the front of the remembered list', () => {
  const a = pushRecentGeocode([], addr('A'), 1_000);
  const b = pushRecentGeocode(a, addr('B', 43.7, -79.4), 2_000);
  assert.equal(b[0].label, 'B');
  assert.equal(b.length, 2);
  assert.equal(b[0].ts, 2_000);
});

test('the same POINT is de-duplicated even when the wording changed', () => {
  // Nominatim's display_name for one doorway is not byte-stable between lookups, so
  // matching on the label alone would grow a list of near-duplicates of one address.
  const first = pushRecentGeocode([], addr('193 Yonge Street, Toronto', 43.6532, -79.3832), 1_000);
  const again = pushRecentGeocode(first, addr('193, Yonge St, Old Toronto', 43.6532, -79.3832), 2_000);
  assert.equal(again.length, 1);
  assert.equal(again[0].label, '193, Yonge St, Old Toronto', 'the newest wording wins');
});

test('the remembered list is capped', () => {
  let list: RecentGeocode[] = [];
  for (let i = 0; i < 40; i++) list = pushRecentGeocode(list, addr(`${i} St`, 43 + i / 1000, -79), i);
  assert.ok(list.length <= 12, `expected a cap, got ${list.length}`);
});

test('remembered addresses are filtered by what has been typed', () => {
  const list = [
    { ...addr('193 Yonge Street, Toronto'), ts: 2 },
    { ...addr('80 Front Street West, Toronto', 43.64, -79.38), ts: 1 },
  ];
  assert.equal(filterRecentGeocodes(list, 'yonge').length, 1);
  assert.equal(filterRecentGeocodes(list, 'front')[0].label, '80 Front Street West, Toronto');
  assert.equal(filterRecentGeocodes(list, '').length, 0, 'an empty query matches nothing here');
});
