// Tests for the Demo Mode recorder/replay pair.
//
// Two halves:
//   - synthetic fixtures (built in-test) cover manifest validation, replay clock math,
//     frame selection, looping, the error-marked-frame path and the all-or-nothing latch;
//   - the real committed fixture is decoded end-to-end, proving the recorded bytes still
//     parse with gtfs-realtime-bindings into sane values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import type { FeedId } from '../../shared/types.ts';
import type { DemoFixtureFile, DemoManifest, RecordedFrame } from './record_demo.ts';
import { captureFrame } from './record_demo.ts';
import {
  parseFixture,
  createDemoSource,
  replayPositionAt,
  frameIndexAt,
  activateDemoMode,
  isDemoActive,
  activeDemoSource,
  __resetDemoModeForTests,
  DEFAULT_SPEED,
} from './demo.ts';

const { transit_realtime } = GtfsRealtimeBindings;

const CADENCE = 45_000;
const START = Date.UTC(2026, 6, 24, 21, 0, 0);

/** Valid GTFS-realtime bytes carrying `count` vehicle entities. */
function vehicleBytes(count: number, ts: number): Buffer {
  const msg = transit_realtime.FeedMessage.create({
    header: { gtfsRealtimeVersion: '2.0', timestamp: ts },
    entity: Array.from({ length: count }, (_, i) => ({
      id: `v${i}`,
      vehicle: {
        trip: { tripId: `t${i}`, routeId: `${500 + i}` },
        position: { latitude: 43.65 + i / 1000, longitude: -79.38 },
        timestamp: ts,
        vehicle: { id: `bus${i}` },
      },
    })),
  });
  return Buffer.from(transit_realtime.FeedMessage.encode(msg).finish());
}

function frame(feed: FeedId, seq: number, opts: Partial<RecordedFrame> = {}): RecordedFrame {
  const offsetMs = opts.offsetMs ?? seq * CADENCE;
  const capturedAtMs = START + offsetMs;
  const bytes = opts.ok === false ? null : vehicleBytes(2 + seq, Math.floor(capturedAtMs / 1000));
  return {
    feed,
    seq,
    capturedAtMs,
    capturedAtIso: new Date(capturedAtMs).toISOString(),
    capturedAtToronto: 'stamp',
    offsetMs,
    ok: true,
    httpStatus: 200,
    byteLength: bytes?.length ?? null,
    payloadBase64: bytes ? bytes.toString('base64') : null,
    error: null,
    fetchMs: 12,
    ...opts,
  };
}

function manifest(over: Partial<DemoManifest> = {}): DemoManifest {
  return {
    schemaVersion: 1,
    kind: 'ghostbus-demo-fixture',
    agency: 'ttc',
    timezone: 'America/Toronto',
    attribution: 'TTC',
    recordedNotice: 'RECORDING',
    captureStartMs: START,
    captureStartIso: new Date(START).toISOString(),
    captureStartToronto: 'stamp',
    captureEndMs: START + 2 * CADENCE,
    captureEndIso: new Date(START + 2 * CADENCE).toISOString(),
    captureEndToronto: 'stamp',
    durationMs: 2 * CADENCE,
    cadenceMs: CADENCE,
    frameCount: 0,
    cycleCount: 3,
    totalPayloadBytes: 0,
    feeds: {
      vehicles: { url: 'u', frames: 3, okFrames: 3, errorFrames: 0, totalBytes: 0 },
      trips: { url: 'u', frames: 3, okFrames: 3, errorFrames: 0, totalBytes: 0 },
      alerts: { url: 'u', frames: 3, okFrames: 3, errorFrames: 0, totalBytes: 0 },
    },
    ...over,
  };
}

function bundle(frames: RecordedFrame[], over: Partial<DemoManifest> = {}): Buffer {
  const file: DemoFixtureFile = { manifest: manifest({ frameCount: frames.length, ...over }), frames };
  return gzipSync(Buffer.from(JSON.stringify(file), 'utf8'));
}

/** Three cycles across all three feeds. */
function threeCycles(): RecordedFrame[] {
  const out: RecordedFrame[] = [];
  for (let seq = 0; seq < 3; seq++) {
    for (const feed of ['vehicles', 'trips', 'alerts'] as FeedId[]) out.push(frame(feed, seq));
  }
  return out;
}

// ---------- manifest validation ----------

test('parseFixture accepts a well-formed fixture and indexes it by feed', () => {
  const fx = parseFixture(bundle(threeCycles()));
  assert.equal(fx.manifest.kind, 'ghostbus-demo-fixture');
  assert.equal(fx.frames.length, 9);
  assert.equal(fx.byFeed.vehicles.length, 3);
  assert.equal(fx.byFeed.trips.length, 3);
  assert.equal(fx.byFeed.alerts.length, 3);
  // The last frame keeps a full cadence slot before the loop wraps.
  assert.equal(fx.timelineMs, 2 * CADENCE + CADENCE);
  assert.deepEqual(fx.byFeed.vehicles.map((f) => f.offsetMs), [0, CADENCE, 2 * CADENCE]);
  assert.ok(Buffer.isBuffer(fx.byFeed.vehicles[0].bytes));
});

test('parseFixture sorts out-of-order frames by offset', () => {
  const frames = [frame('vehicles', 2), frame('vehicles', 0), frame('vehicles', 1)];
  const fx = parseFixture(bundle(frames));
  assert.deepEqual(fx.byFeed.vehicles.map((f) => f.seq), [0, 1, 2]);
});

test('parseFixture rejects a foreign or corrupt fixture', () => {
  assert.throws(() => parseFixture(bundle(threeCycles(), { kind: 'something-else' })), /wrong kind/);
  assert.throws(() => parseFixture(bundle(threeCycles(), { schemaVersion: 99 })), /unsupported schemaVersion/);
  assert.throws(() => parseFixture(bundle([])), /no frames/);
  assert.throws(() => parseFixture(bundle(threeCycles(), { cadenceMs: 0 })), /cadenceMs/);
  assert.throws(() => parseFixture(Buffer.from('not gzip')), /unreadable/);
});

test('parseFixture rejects a frame marked ok but carrying no payload', () => {
  const bad = frame('vehicles', 0);
  bad.payloadBase64 = null;
  assert.throws(() => parseFixture(bundle([bad])), /marked ok but carries no payload/);
});

// ---------- replay clock math ----------

test('replayPositionAt applies the speed multiplier', () => {
  assert.equal(replayPositionAt(1_000, 8, 100_000, true).timelineMs, 8_000);
  assert.equal(replayPositionAt(1_000, 1, 100_000, true).timelineMs, 1_000);
  // 8x default: a ~10 minute recording replays in ~75 seconds.
  assert.equal(replayPositionAt(75_000, DEFAULT_SPEED, 600_000, true).timelineMs, 600_000 % 600_000);
});

test('replayPositionAt loops and counts wraparounds', () => {
  const timeline = 100_000;
  assert.deepEqual(
    replayPositionAt(10_000, 8, timeline, true),
    { timelineMs: 80_000, loops: 0, finished: false, elapsedWallMs: 10_000 },
  );
  // 15s * 8 = 120_000 -> one full loop plus 20s in.
  const wrapped = replayPositionAt(15_000, 8, timeline, true);
  assert.equal(wrapped.timelineMs, 20_000);
  assert.equal(wrapped.loops, 1);
  assert.equal(wrapped.finished, false);
  // Exactly on the boundary wraps to zero, not to the end.
  const exact = replayPositionAt(12_500, 8, timeline, true);
  assert.equal(exact.timelineMs, 0);
  assert.equal(exact.loops, 1);
});

test('replayPositionAt clamps and reports finished when looping is off', () => {
  const end = replayPositionAt(999_999, 8, 100_000, false);
  assert.equal(end.timelineMs, 100_000);
  assert.equal(end.finished, true);
  assert.equal(end.loops, 0);
  const mid = replayPositionAt(1_000, 8, 100_000, false);
  assert.equal(mid.finished, false);
});

test('frameIndexAt picks the frame that is current at time T', () => {
  const offsets = [0, 45_000, 90_000];
  assert.equal(frameIndexAt(offsets, 0), 0);
  assert.equal(frameIndexAt(offsets, 44_999), 0);
  assert.equal(frameIndexAt(offsets, 45_000), 1);   // exact boundary belongs to the new frame
  assert.equal(frameIndexAt(offsets, 89_999), 1);
  assert.equal(frameIndexAt(offsets, 90_000), 2);
  assert.equal(frameIndexAt(offsets, 10_000_000), 2); // past the end clamps to the last frame
  assert.equal(frameIndexAt(offsets, -5), 0);        // before the start stands in with the first
  assert.equal(frameIndexAt([], 0), -1);
});

// ---------- the source ----------

test('createDemoSource serves the frame current at the replay clock, then loops', () => {
  const fx = parseFixture(bundle(threeCycles()));
  let clock = 1_000_000;
  const src = createDemoSource(fx, { speed: 8, loop: true, startedAtMs: clock, now: () => clock });

  assert.equal(src.isDemo, true);
  assert.equal(src.speed, 8);

  // t=0 -> frame 0
  let r = src.fetchFeed('vehicles');
  assert.equal(r.status, 'ok');
  assert.equal(src.currentFrame('vehicles')?.seq, 0);

  // 45s of recording at 8x arrives after 5.625s of wall clock -> frame 1
  clock += 45_000 / 8;
  assert.equal(src.currentFrame('vehicles')?.seq, 1);
  assert.equal(src.currentFrame('trips')?.seq, 1);

  // ...and again -> frame 2 (the last)
  clock += 45_000 / 8;
  assert.equal(src.currentFrame('vehicles')?.seq, 2);
  assert.equal(src.position().loops, 0);

  // the last frame holds for its full cadence slot, then the timeline wraps to frame 0
  clock += 45_000 / 8;
  assert.equal(src.currentFrame('vehicles')?.seq, 0);
  assert.equal(src.position().loops, 1);

  r = src.fetchFeed('vehicles');
  assert.equal(r.status, 'ok');
  if (r.status === 'ok') assert.equal(r.frame.seq, 0);
});

test('createDemoSource decodes recorded bytes into a real FeedMessage and labels it demo', () => {
  const fx = parseFixture(bundle(threeCycles()));
  const src = createDemoSource(fx, { startedAtMs: 0, now: () => 0 });
  const r = src.fetchFeed('vehicles');
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.equal(r.demo, true);
  assert.equal(r.msg.entity.length, 2);           // frame 0 was built with 2 vehicles
  assert.equal(r.msg.entity[0].vehicle?.trip?.routeId, '500');
  assert.equal(typeof r.frame.capturedAtMs, 'number');
});

test('an error-marked frame replays as a failed poll instead of being skipped', () => {
  // Cycle 1 of vehicles recorded a real failure mid-capture.
  const frames = [
    frame('vehicles', 0),
    frame('vehicles', 1, { ok: false, error: 'HTTP 503', httpStatus: 503, byteLength: null, payloadBase64: null }),
    frame('vehicles', 2),
    frame('trips', 1, { offsetMs: CADENCE }),
  ];
  const fx = parseFixture(bundle(frames));
  let clock = 0;
  const src = createDemoSource(fx, { speed: 8, loop: true, startedAtMs: 0, now: () => clock });

  assert.equal(src.fetchFeed('vehicles').status, 'ok');

  clock += 45_000 / 8; // into the failed frame
  const bad = src.fetchFeed('vehicles');
  assert.equal(bad.status, 'error');
  if (bad.status === 'error') {
    assert.equal(bad.demo, true);
    assert.match(bad.reason, /recorded failure: HTTP 503/);
    assert.equal(bad.frame?.seq, 1);
  }
  // the hiccup is per-frame: other feeds in the same cycle are unaffected...
  assert.equal(src.fetchFeed('trips').status, 'ok');
  // ...and the next cycle recovers.
  clock += 45_000 / 8;
  assert.equal(src.fetchFeed('vehicles').status, 'ok');
});

test('a feed with no recorded frames returns an error, never a throw', () => {
  const fx = parseFixture(bundle([frame('vehicles', 0)]));
  const src = createDemoSource(fx, { startedAtMs: 0, now: () => 0 });
  const r = src.fetchFeed('alerts');
  assert.equal(r.status, 'error');
  if (r.status === 'error') assert.match(r.reason, /no alerts frames/);
});

test('createDemoSource rejects a non-positive speed', () => {
  const fx = parseFixture(bundle(threeCycles()));
  assert.throws(() => createDemoSource(fx, { speed: 0 }), /speed must be positive/);
});

// ---------- the all-or-nothing latch ----------

test('Demo Mode is all-or-nothing per process', () => {
  __resetDemoModeForTests();
  const fx = parseFixture(bundle(threeCycles()));
  const a = createDemoSource(fx);
  const b = createDemoSource(fx);

  assert.equal(isDemoActive(), false);
  assert.equal(activeDemoSource(), null);

  activateDemoMode(a);
  assert.equal(isDemoActive(), true);
  assert.equal(activeDemoSource(), a);

  activateDemoMode(a); // idempotent for the same source
  assert.equal(activeDemoSource(), a);

  // A second, different source would mean two data origins in one process.
  assert.throws(() => activateDemoMode(b), /already active with a different source/);

  __resetDemoModeForTests();
  assert.equal(isDemoActive(), false);
});

// ---------- the recorder's own capture path ----------

test('captureFrame records a good response as an ok frame with raw bytes', async () => {
  const bytes = vehicleBytes(3, 1700);
  const fake = (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch;
  const f = await captureFrame('vehicles', 0, START, fake);
  assert.equal(f.ok, true);
  assert.equal(f.error, null);
  assert.equal(f.httpStatus, 200);
  assert.equal(f.byteLength, bytes.length);
  assert.ok(f.payloadBase64);
  // The stored bytes are the untouched protobuf, not a re-serialization of our shapes.
  assert.deepEqual(Buffer.from(f.payloadBase64, 'base64'), bytes);
  assert.equal(transit_realtime.FeedMessage.decode(Buffer.from(f.payloadBase64, 'base64')).entity.length, 3);
  assert.ok(f.capturedAtMs > 0);
});

test('captureFrame turns a network failure into an error-marked frame, not a throw', async () => {
  const fake = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
  const f = await captureFrame('trips', 4, START, fake);
  assert.equal(f.ok, false);
  assert.equal(f.payloadBase64, null);
  assert.equal(f.httpStatus, null);
  assert.match(f.error ?? '', /ECONNRESET/);
  assert.equal(f.seq, 4);
});

test('captureFrame records an HTTP error as an error-marked frame', async () => {
  const fake = (async () => new Response('upstream is down', { status: 503 })) as unknown as typeof fetch;
  const f = await captureFrame('alerts', 1, START, fake);
  assert.equal(f.ok, false);
  assert.equal(f.httpStatus, 503);
  assert.match(f.error ?? '', /HTTP 503/);
});

test('captureFrame rejects a 200 whose body is not GTFS-realtime', async () => {
  // A captive portal or HTML error page served with status 200 must not poison the fixture.
  const html = Buffer.from('<!doctype html><html><body>Access denied</body></html>');
  const fake = (async () => new Response(html, { status: 200 })) as unknown as typeof fetch;
  const f = await captureFrame('vehicles', 2, START, fake);
  assert.equal(f.ok, false);
  assert.equal(f.payloadBase64, null);
  assert.match(f.error ?? '', /not GTFS-realtime/);
});

// ---------- the real recorded fixture ----------

function newestFixture(): string | null {
  const dir = fileURLToPath(new URL('../../fixtures/', import.meta.url));
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json.gz')).sort();
  } catch {
    return null;
  }
  return names.length ? dir + names[names.length - 1] : null;
}

test('the committed fixture is real TTC data that still decodes', (t) => {
  const path = newestFixture();
  if (!path) {
    t.skip('no fixture in fixtures/ — run: npx tsx server/src/record_demo.ts');
    return;
  }
  const fx = parseFixture(readFileSync(path));

  // Provenance must be intact: this is a recording and says so.
  assert.equal(fx.manifest.kind, 'ghostbus-demo-fixture');
  assert.equal(fx.manifest.agency, 'ttc');
  assert.match(fx.manifest.attribution, /Toronto Transit Commission/);
  assert.match(fx.manifest.recordedNotice, /RECORDING/);
  assert.ok(fx.manifest.captureStartMs > 0);
  assert.ok(fx.manifest.captureEndMs >= fx.manifest.captureStartMs);
  assert.equal(fx.manifest.cadenceMs, 45_000);

  // Every ok frame must still decode through the real bindings.
  let decoded = 0;
  for (const f of fx.frames) {
    if (!f.ok) continue;
    assert.ok(f.bytes, `frame ${f.feed}#${f.seq} has no bytes`);
    const msg = transit_realtime.FeedMessage.decode(f.bytes);
    assert.ok(msg.header, `frame ${f.feed}#${f.seq} decoded without a header`);
    decoded++;
  }
  assert.ok(decoded > 0, 'fixture contained no decodable frames');

  // Sane values: a real rush of TTC buses, not an empty feed.
  const firstVehicles = fx.byFeed.vehicles.find((f) => f.ok);
  assert.ok(firstVehicles?.bytes, 'no successful vehicles frame in the fixture');
  const vmsg = transit_realtime.FeedMessage.decode(firstVehicles.bytes);
  assert.ok(vmsg.entity.length > 0, 'first vehicles frame carried zero vehicles');

  const routes = new Set<string>();
  for (const e of vmsg.entity) {
    const r = e.vehicle?.trip?.routeId;
    if (r) routes.add(r);
  }
  assert.ok(routes.size > 0, 'no route ids in the first vehicles frame');

  // Replay over the real fixture works and stays inside the recording.
  let clock = 0;
  const src = createDemoSource(fx, { speed: 8, loop: true, startedAtMs: 0, now: () => clock });
  const seen = new Set<number>();
  for (let i = 0; i < fx.byFeed.vehicles.length * 2; i++) {
    const cur = src.currentFrame('vehicles');
    assert.ok(cur, 'replay produced no current vehicles frame');
    seen.add(cur.seq);
    clock += fx.manifest.cadenceMs / 8;
  }
  // Two passes over the recording must have visited every frame and looped.
  assert.equal(seen.size, fx.byFeed.vehicles.length);
  assert.ok(src.position().loops >= 1, 'replay did not loop');
});
