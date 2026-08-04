// The geocoder's contract, with no network anywhere near it.
//
// What matters here is not that Nominatim works — it is that we ask it politely and that
// we never turn one of its answers into a claim it did not make. So: the identifying
// header is present, the box is a filter and not a hint, a query it does not know comes
// back as an honest empty rather than as an error, and a row without real coordinates is
// dropped rather than planned to.

import test from 'node:test';
import assert from 'node:assert/strict';
import { geocode, normaliseQuery, GTA_VIEWBOX, GEOCODE_LIMIT, __resetGeocodeForTest } from './geocode.ts';
import { USER_AGENT } from './agencies.ts';

/** A fetch that records what it was asked and replays what it is told to. */
function stubFetch(rows: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const impl = (async (input: URL | string, init?: { headers?: Record<string, string> }) => {
    calls.push({
      url: input instanceof URL ? input : new URL(String(input)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => rows,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ROW = {
  lat: '43.6532', lon: '-79.3832',
  display_name: '193, Yonge Street, Downtown, Toronto, Ontario, M5B 1M4, Canada',
};

test.beforeEach(() => __resetGeocodeForTest());

test('the request identifies this project — the policy requires it and a browser cannot', () => {
  // This is the whole reason the geocoder lives on the server. If this assertion ever has
  // to be deleted, the call has moved into the browser and is no longer policy-compliant.
  assert.match(USER_AGENT, /GhostBus/);
});

test('an address is looked up with our User-Agent, bounded to the GTA, capped at five', async () => {
  const { impl, calls } = stubFetch([ROW]);
  await geocode('193 Yonge Street', { fetchImpl: impl });
  assert.equal(calls.length, 1);
  const { url, headers } = calls[0];
  assert.equal(headers['User-Agent'], USER_AGENT);
  assert.equal(url.searchParams.get('limit'), String(GEOCODE_LIMIT));
  assert.equal(url.searchParams.get('viewbox'), GTA_VIEWBOX.join(','));
  // `bounded=1` makes the box a FILTER. Without it the box only nudges the ranking, and a
  // King Street in another province can still come back — an address this app cannot plan
  // a trip to is not a result, it is a dead end with a plausible name.
  assert.equal(url.searchParams.get('bounded'), '1');
  assert.equal(url.searchParams.get('countrycodes'), 'ca');
});

test('a known address becomes a point with the geocoder\'s own words as its label', async () => {
  const { impl } = stubFetch([ROW]);
  const out = await geocode('193 Yonge Street', { fetchImpl: impl });
  assert.equal(out.length, 1);
  assert.equal(out[0].label, ROW.display_name, 'the label is quoted, never rewritten');
  assert.equal(out[0].title, '193, Yonge Street');
  assert.match(out[0].context, /Toronto/);
  assert.ok(Math.abs(out[0].lat - 43.6532) < 1e-6);
  assert.ok(Math.abs(out[0].lon + 79.3832) < 1e-6);
});

test('a query the geocoder does not know is an EMPTY answer, not an error', async () => {
  // The honesty split: "we looked and there is nothing" must not be rendered with the same
  // copy as "we could not look". Only the second is a failure.
  const { impl } = stubFetch([]);
  const out = await geocode('asdkjhasdkjh', { fetchImpl: impl });
  assert.deepEqual(out, []);
});

test('an upstream failure THROWS rather than returning an empty list', async () => {
  const { impl } = stubFetch([], { ok: false, status: 503 });
  await assert.rejects(() => geocode('193 Yonge Street', { fetchImpl: impl }));
});

test('a row without usable coordinates is dropped rather than planned to', async () => {
  const { impl } = stubFetch([
    { lat: 'not-a-number', lon: '-79.38', display_name: 'Nowhere' },
    { lat: '43.65', lon: '-79.38', display_name: '' },
    ROW,
  ]);
  const out = await geocode('193 Yonge Street', { fetchImpl: impl });
  assert.equal(out.length, 1, 'only the row with a real point and a real name survives');
});

test('more rows than the cap are trimmed to the cap', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ ...ROW, display_name: `${i} Yonge Street, Toronto` }));
  const { impl } = stubFetch(many);
  const out = await geocode('Yonge', { fetchImpl: impl });
  assert.equal(out.length, GEOCODE_LIMIT);
});

test('a repeated query is served from cache — a stranger\'s endpoint is not billed twice', async () => {
  const { impl, calls } = stubFetch([ROW]);
  await geocode('193 Yonge Street', { fetchImpl: impl });
  await geocode('  193   YONGE street ', { fetchImpl: impl });
  assert.equal(calls.length, 1, 'the second lookup normalised to the first and hit the cache');
});

test('normalisation folds case and runs of whitespace, and nothing else', () => {
  assert.equal(normaliseQuery('  193   Yonge   ST '), '193 yonge st');
});

test('an empty query never reaches the network', async () => {
  const { impl, calls } = stubFetch([ROW]);
  assert.deepEqual(await geocode('   ', { fetchImpl: impl }), []);
  assert.equal(calls.length, 0);
});
