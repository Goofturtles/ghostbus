// Tests for the fetch layer's HONEST ATTRIBUTION and its in-flight dedupe.
//
// These exist because of one rider's bug report — "when I allow it to use my location it
// kept saying cant reach the live ttc feed right now" — and they encode the rule that came
// out of it: NO failure of ours may ever be reported as a failure of the transit agency.
// The only honest source for that claim is `HealthResponse.feeds`, which is a different
// field with a different meaning. See DECISIONS §45.
//
// Run with:  node --import tsx --test web/src/lib/api.test.ts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiFailure, failureKind } from './api.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** A fetch stub that records every URL it was asked for. */
function stubFetch(handler: (url: string) => Promise<Response> | Response) {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String(input);
    urls.push(url);
    return handler(url);
  }) as typeof fetch;
  return urls;
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' }, ...init,
  });

// =====================================================================================
// whose fault was it
// =====================================================================================

test('a 429 from OUR server is reported as throttled — never as an agency outage', async () => {
  stubFetch(() => json(
    { statusCode: 429, kind: 'rateLimited', error: 'Too many requests to the GhostBus API from this address.', retryAfterSec: 17 },
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '17' } },
  ));
  const err = await api.health().then(() => null, (e: unknown) => e);
  assert.ok(err instanceof ApiFailure);
  assert.equal(err.kind, 'throttled');
  assert.equal(err.status, 429);
  // The backoff honours the server's own number rather than guessing at one.
  assert.equal(err.retryAfterSec, 17);
  assert.equal(err.isOurs, true, 'throttling ourselves is our own problem');
  // The exact regression: our own rate limiter must not produce a sentence about the TTC.
  assert.doesNotMatch(err.message, /ttc|feed/i);
});

test('a 429 with no body still yields a usable retry delay from the header', async () => {
  stubFetch(() => new Response('rate limited', { status: 429, headers: { 'retry-after': '9' } }));
  const err = await api.health().then(() => null, (e: unknown) => e);
  assert.ok(err instanceof ApiFailure);
  assert.equal(err.kind, 'throttled');
  assert.equal(err.retryAfterSec, 9);
});

test('a 5xx is OUR server failing, and is never confused with a throttle', async () => {
  stubFetch(() => json({ statusCode: 500, kind: 'serverError', error: 'internal error' }, { status: 500 }));
  const err = await api.alerts().then(() => null, (e: unknown) => e);
  assert.ok(err instanceof ApiFailure);
  assert.equal(err.kind, 'serverDown');
  assert.equal(err.isOurs, true);
  assert.equal(err.retryAfterSec, null);
});

test('a dead socket is unreachable — the state a stopped server produces', async () => {
  stubFetch(() => { throw new TypeError('Failed to fetch'); });
  const err = await api.health().then(() => null, (e: unknown) => e);
  assert.ok(err instanceof ApiFailure);
  assert.equal(err.kind, 'unreachable');
  assert.equal(err.isOurs, true);
});

test('a 4xx is OUR bug, and is explicitly NOT one of the retryable states', async () => {
  stubFetch(() => json({ statusCode: 400, kind: 'badRequest', error: 'q is required' }, { status: 400 }));
  const err = await api.stops('x').then(() => null, (e: unknown) => e);
  assert.ok(err instanceof ApiFailure);
  assert.equal(err.kind, 'badRequest');
  // Backing off would not fix a malformed request, so it must not look like the others.
  assert.equal(err.isOurs, false);
});

test('an abort is a decision, not a failure — it must never drive the backoff', async () => {
  stubFetch(() => { throw new DOMException('aborted', 'AbortError'); });
  const ctrl = new AbortController();
  const err = await api.stops('queen', ctrl.signal).then(() => null, (e: unknown) => e);
  assert.equal(failureKind(err), 'aborted');
  assert.ok(err instanceof ApiFailure);
  assert.equal(err.isOurs, false, 'our own cancellation is not an outage');
});

test('failureKind never guesses "the feed is down" for an unrecognised throw', async () => {
  // Whatever goes wrong, the fallback attribution is still OURS. There is no code path
  // through this module that can produce a claim about the agency.
  for (const thrown of [new Error('boom'), 'a string', null, undefined, { weird: true }]) {
    assert.notEqual(failureKind(thrown), 'feedDown' as never);
    assert.ok(['unreachable', 'aborted'].includes(failureKind(thrown)));
  }
});

// =====================================================================================
// in-flight dedupe
// =====================================================================================

test('identical in-flight GETs share ONE request', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const urls = stubFetch(async () => { await gate; return json({ ok: true }); });

  // Three components asking for health at the same instant — the exact pattern the
  // network log showed for health, alerts and ghosts.
  const all = Promise.all([api.health(), api.health(), api.health()]);
  release();
  await all;
  assert.equal(urls.length, 1, `expected 1 request, got ${urls.length}`);
});

test('the shared entry is released, so a LATER call really does refetch', async () => {
  const urls = stubFetch(() => json({ ok: true }));
  await api.health();
  await api.health();
  assert.equal(urls.length, 2, 'dedupe must not turn into a cache');
});

test('a failed shared request does not poison the next one', async () => {
  let fail = true;
  const urls = stubFetch(() => {
    if (fail) throw new TypeError('Failed to fetch');
    return json({ ok: true });
  });
  await api.health().catch(() => { /* expected */ });
  fail = false;
  await api.health();
  assert.equal(urls.length, 2);
});

test('different URLs are never deduped together', async () => {
  const urls = stubFetch(() => json({ stops: [], count: 0 }));
  await Promise.all([api.alerts(), api.ghostFeed(24), api.health()]);
  assert.equal(new Set(urls).size, 3);
});

test('requests carrying an AbortSignal are deliberately NOT shared', async () => {
  // A caller that passed a signal wants individual cancellation — the search sheet aborts
  // superseded queries precisely so they stop costing rate-limit budget. Handing it a
  // promise somebody else can cancel would break that, so those bypass the dedupe.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const urls = stubFetch(async () => { await gate; return json({ stops: [], count: 0 }); });

  const a = new AbortController(), b = new AbortController();
  const all = Promise.all([api.stops('queen', a.signal), api.stops('queen', b.signal)]);
  release();
  await all;
  assert.equal(urls.length, 2);
});
