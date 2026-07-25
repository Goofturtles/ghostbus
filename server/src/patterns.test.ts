import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  patternIdFor, medianHeadwayForSlots, foldTrip, emptyPatternIndex, median,
  boardFingerprint, loadOrBuildPatternIndex, buildPatternIndex, packIndex, unpackIndex,
  PATTERN_CACHE_FORMAT,
  type StaticTripSlot, type PatternIndex,
} from './patterns.ts';
import { createPgliteDb, type Db, type Params, type Result } from './db.ts';
import { createDelayEngine } from './engine.ts';

function row(tripId: string, routeId: string, dirId: number | null, serviceId: string, seq: number, stopId: string, t: number) {
  return { trip_id: tripId, route_id: routeId, direction_id: dirId, service_id: serviceId, stop_sequence: seq, stop_id: stopId, arrival_s: t, departure_s: t };
}
function slot(tripId: string, serviceId: string, firstDepS: number): StaticTripSlot {
  return { tripId, serviceId, patternId: 'p', times: new Int32Array([firstDepS]), arrivals: new Int32Array([firstDepS]), firstDepS };
}

test('pattern id is stable under row re-ordering', () => {
  const rows = [row('t1', 'R', 0, 's1', 1, 'A', 0), row('t1', 'R', 0, 's1', 2, 'B', 60), row('t1', 'R', 0, 's1', 3, 'C', 120)];
  const a = emptyPatternIndex();
  const b = emptyPatternIndex();
  foldTrip(a, rows);
  foldTrip(b, [rows[2], rows[0], rows[1]]);
  assert.equal([...a.patterns.keys()][0], [...b.patterns.keys()][0]);
  assert.deepEqual([...a.patterns.values()][0].stops, ['A', 'B', 'C']);
  assert.deepEqual([...b.patterns.values()][0].stops, ['A', 'B', 'C']);
});

test('pattern id distinguishes direction_id even with an identical stop list', () => {
  const idx = emptyPatternIndex();
  foldTrip(idx, [row('t1', 'R', 0, 's1', 1, 'A', 0), row('t1', 'R', 0, 's1', 2, 'B', 60)]);
  foldTrip(idx, [row('t2', 'R', 1, 's1', 1, 'A', 0), row('t2', 'R', 1, 's1', 2, 'B', 60)]);
  assert.equal(idx.patterns.size, 2, 'same stops, opposite direction = two patterns');
  assert.notEqual(patternIdFor('R', 0, ['A', 'B']), patternIdFor('R', 1, ['A', 'B']));
  // …and two routes with the same stop list are also distinct.
  assert.notEqual(patternIdFor('R', 0, ['A', 'B']), patternIdFor('S', 0, ['A', 'B']));
  // …but the same route+direction+stops is one pattern, however many trips run it.
  assert.equal(idx.slotsByPattern.get(patternIdFor('R', 0, ['A', 'B']))!.length, 1);
});

test('medianHeadwayForSlots on departures 0/600/1200/1800 is 600', () => {
  const slots = [slot('a', '1', 0), slot('b', '1', 600), slot('c', '1', 1200), slot('d', '1', 1800)];
  assert.equal(medianHeadwayForSlots(slots), 600);
  // Unsorted input gives the same answer.
  assert.equal(medianHeadwayForSlots([slots[3], slots[0], slots[2], slots[1]]), 600);
});

test('medianHeadwayForSlots uses the dominant service, not a mix of them', () => {
  // Service 1 runs every 600s; two stray service-9 trips must not pollute the gap list.
  const slots = [
    slot('a', '1', 0), slot('b', '1', 600), slot('c', '1', 1200), slot('d', '1', 1800),
    slot('x', '9', 30), slot('y', '9', 60),
  ];
  assert.equal(medianHeadwayForSlots(slots), 600);
});

test('medianHeadwayForSlots refuses to guess from fewer than 3 slots', () => {
  assert.equal(medianHeadwayForSlots([slot('a', '1', 0), slot('b', '1', 600)]), null);
  assert.equal(medianHeadwayForSlots([]), null);
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('maxLenByRoute is the max over that route\'s patterns (it feeds the merge cap)', () => {
  const idx = emptyPatternIndex();
  foldTrip(idx, [row('short', 'R', 0, 's1', 1, 'A', 0), row('short', 'R', 0, 's1', 2, 'B', 60)]);
  foldTrip(idx, [
    row('long', 'R', 0, 's1', 1, 'A', 0), row('long', 'R', 0, 's1', 2, 'B', 60),
    row('long', 'R', 0, 's1', 3, 'C', 120), row('long', 'R', 0, 's1', 4, 'D', 180),
  ]);
  foldTrip(idx, [row('other', 'S', 0, 's1', 1, 'Z', 0), row('other', 'S', 0, 's1', 2, 'Y', 60)]);
  assert.equal(idx.maxLenByRoute.get('R'), 4);
  assert.equal(idx.maxLenByRoute.get('S'), 2);
});

test('a trip with a hole in its stop_sequence is refused, not silently patched', () => {
  const idx = emptyPatternIndex();
  // sequences 1 and 3, no 2 — folding this would invent an empty stop at index 1.
  foldTrip(idx, [row('t', 'R', 0, 's1', 1, 'A', 0), row('t', 'R', 0, 's1', 3, 'C', 120)]);
  assert.equal(idx.patterns.size, 0);
  assert.equal(idx.tripIds.size, 0);
});

test('arrival and departure are kept separately and both fall back to the other', () => {
  const idx = emptyPatternIndex();
  foldTrip(idx, [
    { trip_id: 't', route_id: 'R', direction_id: 0, service_id: 's1', stop_sequence: 1, stop_id: 'A', arrival_s: 100, departure_s: 130 },
    { trip_id: 't', route_id: 'R', direction_id: 0, service_id: 's1', stop_sequence: 2, stop_id: 'B', arrival_s: 200, departure_s: null },
  ]);
  const s = idx.slotsByTrip.get('t')!;
  assert.equal(s.arrivals[0], 100);
  assert.equal(s.times[0], 130);
  assert.equal(s.firstDepS, 130);
  assert.equal(s.arrivals[1], 200);
  assert.equal(s.times[1], 200, 'departure falls back to arrival');
});

test('a trip with no route_id contributes nothing', () => {
  const idx = emptyPatternIndex();
  foldTrip(idx, [{ trip_id: 't', route_id: null, direction_id: 0, service_id: 's1', stop_sequence: 1, stop_id: 'A', arrival_s: 0, departure_s: 0 }]);
  assert.equal(idx.patterns.size, 0);
});

// ===========================================================================================
// THE PATTERN-INDEX CACHE
// ===========================================================================================
//
// These run against PGlite — real Postgres, real migrations, on disk, no quota. They cannot
// run against Neon: the project has exceeded its data-transfer allowance and the database
// refuses even SELECT 1, which is the very failure this cache exists to prevent.
//
// The fixture is a small synthetic board (6 patterns, 3 services, 432 trips) rather than the
// real 2.15M-row one. Scale is not what makes a cache correct; ROUND-TRIPPING is, and 432
// trips exercise every branch of the codec — shared prefixes, both directions, a null
// departure, a null arrival, and a trip the build refuses outright.

const AGENCY = 'ttc';
const BOARD = '20260726..20260905';

const S = (lo: number, hi: number): string[] => {
  const out: string[] = [];
  for (let i = lo; i <= hi; i++) out.push(`s${String(i).padStart(2, '0')}`);
  return out;
};

const FIXTURE_PATTERNS: { routeId: string; dirId: number; stops: string[] }[] = [
  { routeId: 'R1', dirId: 0, stops: S(1, 12) },
  { routeId: 'R1', dirId: 1, stops: [...S(1, 12)].reverse() },
  { routeId: 'R1', dirId: 0, stops: S(1, 6) },                 // short turn: shares the prefix
  { routeId: 'R2', dirId: 0, stops: S(13, 22) },
  { routeId: 'R2', dirId: 1, stops: [...S(13, 22)].reverse() },
  { routeId: 'R3', dirId: 0, stops: S(23, 30) },
];
const FIXTURE_SERVICES = ['WEEK', 'SAT', 'SUN'];
const TRIPS_PER = 24;
const FIXTURE_TRIPS = FIXTURE_PATTERNS.length * FIXTURE_SERVICES.length * TRIPS_PER;

async function insertRows(db: Db, sql: string, cols: number, values: unknown[]): Promise<void> {
  const BATCH = 200 * cols;
  for (let off = 0; off < values.length; off += BATCH) {
    const slice = values.slice(off, off + BATCH);
    const tuples: string[] = [];
    for (let i = 0; i < slice.length; i += cols) {
      tuples.push(`(${Array.from({ length: cols }, (_, k) => `$${i + k + 1}`).join(',')})`);
    }
    await db.query(`${sql} VALUES ${tuples.join(',')}`, slice);
  }
}

/** Seed one realistic static board. */
async function seedBoard(db: Db): Promise<void> {
  await insertRows(db, 'INSERT INTO routes (agency, route_id, short_name)', 3,
    [AGENCY, 'R1', '1', AGENCY, 'R2', '2', AGENCY, 'R3', '3']);

  const stopVals: unknown[] = [];
  for (let i = 1; i <= 30; i++) {
    stopVals.push(AGENCY, `s${String(i).padStart(2, '0')}`, `Stop ${i}`,
      43.70 + i * 0.001, -79.40 + i * 0.0007);
  }
  await insertRows(db, 'INSERT INTO stops (agency, stop_id, name, lat, lon)', 5, stopVals);

  await insertRows(db,
    'INSERT INTO calendar (agency, service_id, mon, tue, wed, thu, fri, sat, sun, start_date, end_date)', 11, [
      AGENCY, 'WEEK', true, true, true, true, true, false, false, 20260726, 20260905,
      AGENCY, 'SAT', false, false, false, false, false, true, false, 20260726, 20260905,
      AGENCY, 'SUN', false, false, false, false, false, false, true, 20260726, 20260905,
    ]);
  await insertRows(db, 'INSERT INTO calendar_dates (agency, service_id, date, exception_type)', 4,
    [AGENCY, 'WEEK', 20260803, 2, AGENCY, 'SAT', 20260803, 1]);

  const tripVals: unknown[] = [];
  const stVals: unknown[] = [];
  let n = 0;
  for (const p of FIXTURE_PATTERNS) {
    for (const service of FIXTURE_SERVICES) {
      for (let k = 0; k < TRIPS_PER; k++) {
        const tripId = `T${String(++n).padStart(5, '0')}`;
        tripVals.push(AGENCY, tripId, p.routeId, service, p.dirId);
        const start = 5 * 3600 + k * 600;
        p.stops.forEach((stopId, i) => {
          const t = start + i * 180;
          // Trip 1 carries the two null shapes the fold has to fall back through, so the
          // codec is forced to round-trip a departure that came from an arrival and back.
          const arrival = n === 1 && i === 4 ? null : t;
          const departure = n === 1 && i === 3 ? null : (n === 1 && i === 4 ? t + 30 : t);
          stVals.push(AGENCY, tripId, i + 1, stopId, arrival, departure);
        });
      }
    }
  }
  // A trip with a hole in its stop_sequence. buildPatternIndex refuses it, so it must be
  // absent from the cache too — the two paths have to agree about what is NOT in the index.
  tripVals.push(AGENCY, 'T99999', 'R3', 'WEEK', 0);
  S(23, 26).forEach((stopId, i) => {
    if (i === 2) return;
    stVals.push(AGENCY, 'T99999', i + 1, stopId, 20000 + i * 60, 20000 + i * 60);
  });

  await insertRows(db,
    'INSERT INTO trips (agency, trip_id, route_id, service_id, direction_id)', 5, tripVals);
  await insertRows(db,
    'INSERT INTO stop_times (agency, trip_id, stop_sequence, stop_id, arrival_s, departure_s)', 6, stVals);
}

interface Fixture { db: Db; dir: string; cache: string; dispose: () => Promise<void> }

/** A fresh migrated PGlite board plus its own cache directory. */
async function makeFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'gb-patterns-'));
  const cache = join(dir, 'cache');
  const db = await createPgliteDb(join(dir, 'pg'));
  await seedBoard(db);
  process.env.PATTERN_CACHE_DIR = cache;
  return {
    db, dir, cache,
    async dispose() {
      await db.close();
      delete process.env.PATTERN_CACHE_DIR;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Wraps a Db and records every statement, so "read nothing" can be asserted, not hoped. */
function countingDb(inner: Db): Db & { sql: string[]; reads: () => number } {
  const sql: string[] = [];
  return {
    driver: inner.driver,
    get closed() { return inner.closed; },
    async query<T>(q: string, p?: Params): Promise<Result<T>> {
      sql.push(q);
      return inner.query<T>(q, p);
    },
    transaction: (fn) => inner.transaction(fn),
    close: () => inner.close(),
    sql,
    // A row-returning read of the board, as opposed to the scalar fingerprint aggregate.
    reads: () => sql.filter((q) => /FROM stop_times/.test(q) && !/count\(\*\)/.test(q)).length,
  };
}

/**
 * Everything about an index that has to survive a round trip, in a form deepEqual can
 * compare. Pattern ids, the pattern ORDER, per-slot times and arrivals, the slot ordering,
 * the derived headways and every by-trip map are all included: a cache that got the row
 * count right and the times wrong has to fail here.
 *
 * routeStops is sorted because its source query has no ORDER BY, so its order is not a
 * property of the board and nothing may depend on it.
 */
function snapshot(idx: PatternIndex): unknown {
  return {
    boardTag: idx.boardTag,
    patterns: [...idx.patterns.entries()].map(([id, p]) => [id, p.routeId, p.dirId, p.len, p.stops.join('>')]),
    byRoute: [...idx.byRoute.entries()].map(([r, ps]) => [r, ps.map((p) => p.patternId)]),
    maxLenByRoute: [...idx.maxLenByRoute.entries()],
    slotsByPattern: [...idx.slotsByPattern.entries()].map(([pid, slots]) => [pid, slots.map((s) =>
      [s.tripId, s.serviceId, s.patternId, s.firstDepS, [...s.times].join(','), [...s.arrivals].join(',')])]),
    slotsByTrip: [...idx.slotsByTrip.keys()],
    medianHeadwayS: [...idx.medianHeadwayS.entries()],
    stopsByTrip: [...idx.stopsByTrip.entries()],
    serviceByTrip: [...idx.serviceByTrip.entries()],
    tripsByService: [...idx.tripsByService.entries()],
    tripIds: [...idx.tripIds],
    routeStops: [...idx.routeStops.entries()]
      .map(([r, pts]) => [r, pts.map((p) => `${p.stopId}@${p.lat}/${p.lon}`).sort()])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  };
}

const cacheFiles = async (dir: string): Promise<string[]> =>
  (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.gbpx'));

// ---------- cold boot ----------

test('a cold boot builds the index and persists it to both tiers', async () => {
  const fx = await makeFixture();
  try {
    const fp = await boardFingerprint(fx.db, AGENCY);
    assert.ok(fp && fp.length === 32, 'the board fingerprints to one short digest');

    const built = await loadOrBuildPatternIndex(fx.db, AGENCY, BOARD, fp);
    assert.equal(built.source, 'build', 'nothing was cached yet, so it had to read stop_times');
    assert.equal(built.patterns.size, FIXTURE_PATTERNS.length);
    assert.equal(built.slotsByTrip.size, FIXTURE_TRIPS);
    assert.ok(!built.tripIds.has('T99999'), 'the trip with a hole in its sequence is refused');
    assert.equal(built.fingerprint, fp);

    assert.deepEqual(await cacheFiles(fx.cache), [`${AGENCY}-${fp}.gbpx`], 'the disk tier was written');
    const row = (await fx.db.query<{ fingerprint: string; board_tag: string; bytes: number; slots: number; format: number }>(
      'SELECT fingerprint, board_tag, bytes, slots, format FROM pattern_index_cache WHERE agency=$1', [AGENCY])).rows[0];
    assert.ok(row, 'the database tier was written');
    assert.equal(row.fingerprint, fp);
    assert.equal(row.board_tag, BOARD);
    assert.equal(Number(row.format), PATTERN_CACHE_FORMAT);
    assert.equal(Number(row.slots), built.slotsByTrip.size);
    assert.ok(Number(row.bytes) > 0);
  } finally { await fx.dispose(); }
});

// ---------- the restore is the same index, not merely a similar one ----------

test('a second boot restores an index STRUCTURALLY IDENTICAL to the built one, without reading stop_times', async () => {
  const fx = await makeFixture();
  try {
    const fp = await boardFingerprint(fx.db, AGENCY);
    const built = await loadOrBuildPatternIndex(fx.db, AGENCY, BOARD, fp);

    const counted = countingDb(fx.db);
    const restored = await loadOrBuildPatternIndex(counted, AGENCY, BOARD, fp);
    assert.equal(restored.source, 'cache-file');
    assert.equal(counted.reads(), 0, 'a restore may not touch stop_times at all');
    assert.equal(counted.sql.length, 0, 'the disk tier does not even reach the database');

    // The whole point: not a row count, the actual shape.
    assert.deepEqual(snapshot(restored), snapshot(built));
    assert.equal(restored.builtAtMs, built.builtAtMs, 'the restore reports when the CONTENT was built');
  } finally { await fx.dispose(); }
});

test('with the disk cache gone — a fresh container — the database tier restores it', async () => {
  const fx = await makeFixture();
  try {
    const fp = await boardFingerprint(fx.db, AGENCY);
    const built = await loadOrBuildPatternIndex(fx.db, AGENCY, BOARD, fp);

    // Render's free tier gives every wake a fresh, empty disk. This is that boot.
    await rm(fx.cache, { recursive: true, force: true });

    const counted = countingDb(fx.db);
    const restored = await loadOrBuildPatternIndex(counted, AGENCY, BOARD, fp);
    assert.equal(restored.source, 'cache-db');
    assert.equal(counted.reads(), 0, 'the database tier reads the blob, never the rows');
    assert.deepEqual(snapshot(restored), snapshot(built));
    assert.deepEqual(await cacheFiles(fx.cache), [`${AGENCY}-${fp}.gbpx`],
      'and it lands on disk so the next restart on this container is free');
  } finally { await fx.dispose(); }
});

// ---------- a changed board must never be served from cache ----------

test('a changed board forces a rebuild — including calendar edits the board tag cannot see', async () => {
  const mutations: [string, string, unknown[]][] = [
    ['a changed departure time',
      'UPDATE stop_times SET departure_s = departure_s + 1 WHERE agency=$1 AND trip_id=$2 AND stop_sequence=2', [AGENCY, 'T00007']],
    ['a re-pointed stop',
      "UPDATE stop_times SET stop_id='s30' WHERE agency=$1 AND trip_id=$2 AND stop_sequence=3", [AGENCY, 'T00007']],
    ['a withdrawn trip',
      'DELETE FROM trips WHERE agency=$1 AND trip_id=$2', [AGENCY, 'T00007']],
    ['a moved stop',
      'UPDATE stops SET lat = lat + 0.002 WHERE agency=$1 AND stop_id=$2', [AGENCY, 's05']],
    ['a re-routed trip',
      "UPDATE trips SET route_id='R2' WHERE agency=$1 AND trip_id=$2", [AGENCY, 'T00007']],
    ['a flipped direction',
      'UPDATE trips SET direction_id=1 WHERE agency=$1 AND trip_id=$2', [AGENCY, 'T00007']],
    ['a re-assigned service',
      "UPDATE trips SET service_id='SUN' WHERE agency=$1 AND trip_id=$2", [AGENCY, 'T00007']],
    // The board tag is only min(start_date)..max(end_date). These two leave it IDENTICAL,
    // which is exactly why the fingerprint covers the calendar and the tag alone cannot.
    ['a calendar exception the board tag cannot see',
      'INSERT INTO calendar_dates (agency, service_id, date, exception_type) VALUES ($1,$2,20260810,2)', [AGENCY, 'SUN']],
    ['a service withdrawn from a weekday, with the same date range',
      "UPDATE calendar SET wed=false WHERE agency=$1 AND service_id='WEEK'", [AGENCY]],
  ];

  for (const [what, sql, params] of mutations) {
    const fx = await makeFixture();
    try {
      const before = await boardFingerprint(fx.db, AGENCY);
      await loadOrBuildPatternIndex(fx.db, AGENCY, BOARD, before);

      await fx.db.query(sql, params as Params);
      const after = await boardFingerprint(fx.db, AGENCY);
      assert.notEqual(after, before, `${what} must change the fingerprint`);

      const next = await loadOrBuildPatternIndex(fx.db, AGENCY, BOARD, after);
      assert.equal(next.source, 'build', `${what} must force a rebuild, not a restore`);
      assert.equal(next.fingerprint, after);
    } finally { await fx.dispose(); }
  }
});

test('the fingerprint is stable across repeated reads of an unchanged board', async () => {
  const fx = await makeFixture();
  try {
    const a = await boardFingerprint(fx.db, AGENCY);
    const b = await boardFingerprint(fx.db, AGENCY);
    const c = await boardFingerprint(fx.db, AGENCY);
    assert.equal(a, b);
    assert.equal(b, c);
    // A digest that flapped would rebuild every 6 hours forever, silently undoing the fix.
    assert.ok(a && a.length === 32);
  } finally { await fx.dispose(); }
});

// ---------- corruption falls back, and never half-loads ----------

test('a corrupted or truncated disk cache falls back rather than throwing or part-loading', async () => {
  const damage: [string, (b: Buffer) => Buffer][] = [
    ['truncated to half', (b) => b.subarray(0, b.length >> 1)],
    ['truncated to the header', (b) => b.subarray(0, 40)],
    ['one flipped byte in the payload', (b) => { const c = Buffer.from(b); c[c.length - 20] ^= 0xff; return c; }],
    ['one flipped byte in the checksum', (b) => { const c = Buffer.from(b); c[10] ^= 0xff; return c; }],
    ['a wrong magic', (b) => { const c = Buffer.from(b); c.write('XXXX', 0, 'ascii'); return c; }],
    ['a format version from the future', (b) => { const c = Buffer.from(b); c.writeUInt32LE(PATTERN_CACHE_FORMAT + 1, 4); return c; }],
    ['empty', () => Buffer.alloc(0)],
    ['garbage', () => Buffer.from('not an index at all, not even close', 'utf8')],
  ];

  const fx = await makeFixture();
  try {
    const fp = await boardFingerprint(fx.db, AGENCY);
    const built = await loadOrBuildPatternIndex(fx.db, AGENCY, BOARD, fp);
    const file = join(fx.cache, `${AGENCY}-${fp}.gbpx`);
    const good = await readFile(file);

    for (const [what, bend] of damage) {
      await writeFile(file, bend(good));
      // The database tier still holds a good copy, so a rejected file must fall THROUGH to
      // it — which also proves the rejection is a miss and not an exception.
      const idx = await loadOrBuildPatternIndex(fx.db, AGENCY, BOARD, fp);
      assert.equal(idx.source, 'cache-db', `${what} must be rejected, not half-loaded`);
      assert.deepEqual(snapshot(idx), snapshot(built), `${what}: the fallback is still exact`);
      await writeFile(file, good);
    }
  } finally { await fx.dispose(); }
});

test('a truncated database payload rebuilds from stop_times', async () => {
  const fx = await makeFixture();
  try {
    const fp = await boardFingerprint(fx.db, AGENCY);
    const built = await loadOrBuildPatternIndex(fx.db, AGENCY, BOARD, fp);
    await rm(fx.cache, { recursive: true, force: true });

    const b64 = (await fx.db.query<{ payload_b64: string }>(
      'SELECT payload_b64 FROM pattern_index_cache WHERE agency=$1', [AGENCY])).rows[0].payload_b64;
    await fx.db.query('UPDATE pattern_index_cache SET payload_b64=$2 WHERE agency=$1',
      [AGENCY, b64.slice(0, b64.length >> 1)]);

    const idx = await loadOrBuildPatternIndex(fx.db, AGENCY, BOARD, fp);
    assert.equal(idx.source, 'build', 'a short blob is rebuilt, not part-loaded');
    assert.deepEqual(snapshot(idx), snapshot(built));
  } finally { await fx.dispose(); }
});

test('a cached blob for another board, agency or fingerprint is refused', async () => {
  const fx = await makeFixture();
  try {
    const fp = (await boardFingerprint(fx.db, AGENCY))!;
    const built = await loadOrBuildPatternIndex(fx.db, AGENCY, BOARD, fp);
    const sealed = packIndex(built, AGENCY);

    assert.ok(unpackIndex(sealed, { agency: AGENCY, boardTag: BOARD, fingerprint: fp }), 'the matching one loads');
    assert.equal(unpackIndex(sealed, { agency: 'other', boardTag: BOARD, fingerprint: fp }), null);
    assert.equal(unpackIndex(sealed, { agency: AGENCY, boardTag: '20270101..20270301', fingerprint: fp }), null);
    assert.equal(unpackIndex(sealed, { agency: AGENCY, boardTag: BOARD, fingerprint: 'deadbeef'.repeat(4) }), null);
    assert.equal(unpackIndex(sealed, { agency: AGENCY, boardTag: BOARD, fingerprint: '' }), null,
      'an unknown fingerprint can never be a match');

    // A board-tag rollover with the blob still in the row: the WHERE clause misses, so the
    // payload is not even transferred to be rejected.
    await rm(fx.cache, { recursive: true, force: true });
    const next = await loadOrBuildPatternIndex(fx.db, AGENCY, '20270101..20270301', fp);
    assert.equal(next.source, 'build');
  } finally { await fx.dispose(); }
});

test('an index with no fingerprint is neither cached nor restored', async () => {
  const fx = await makeFixture();
  try {
    // boardFingerprint returns null when it cannot describe the board. That must degrade to
    // exactly today's behaviour — always build — and must never write a blob nothing can
    // later prove is current.
    const idx = await loadOrBuildPatternIndex(fx.db, AGENCY, BOARD, null);
    assert.equal(idx.source, 'build');
    assert.equal(idx.fingerprint, '');
    assert.deepEqual(await cacheFiles(fx.cache), []);
    assert.equal((await fx.db.query('SELECT 1 FROM pattern_index_cache WHERE agency=$1', [AGENCY])).rows.length, 0);
  } finally { await fx.dispose(); }
});

// ---------- the engine's boot and its 6-hourly reload ----------

test('REGRESSION: the 6-hourly reload of an unchanged board reads one row, not 2.15M', async () => {
  const fx = await makeFixture();
  try {
    const counted = countingDb(fx.db);
    const engine = createDelayEngine(counted, AGENCY);
    await engine.reloadStatic(BOARD);
    assert.ok(counted.reads() > 0, 'the first load did read the board');
    const built = engine.getIndex();

    // BEFORE: this reload re-read every stop_times row, every six hours, forever. Four of
    // those in one session exhausted the Neon transfer quota for the month.
    counted.sql.length = 0;
    await engine.reloadStatic(BOARD);
    assert.equal(counted.reads(), 0, 'an unchanged board must not be re-read');
    assert.equal(counted.sql.length, 1, 'exactly one statement: the fingerprint');
    assert.ok(/FROM stop_times WHERE agency/.test(counted.sql[0]), 'and it is a scalar aggregate');
    assert.equal(engine.getIndex(), built, 'the very same index object is kept');
  } finally { await fx.dispose(); }
});

test('REGRESSION: a fresh engine boots from the cache instead of reading stop_times', async () => {
  const fx = await makeFixture();
  try {
    const first = createDelayEngine(fx.db, AGENCY);
    await first.reloadStatic(BOARD);
    const built = first.getIndex();

    // A new process on the same database and the same board — a Render wake.
    const counted = countingDb(fx.db);
    const second = createDelayEngine(counted, AGENCY);
    await second.reloadStatic(BOARD);
    assert.equal(counted.reads(), 0, 'the boot may not read stop_times');
    assert.equal(second.getIndex().source, 'cache-file');
    assert.ok(second.isReady());
    assert.deepEqual(snapshot(second.getIndex()), snapshot(built));
  } finally { await fx.dispose(); }
});

test('a board that changed under a running engine is rebuilt on the next reload', async () => {
  const fx = await makeFixture();
  try {
    const engine = createDelayEngine(fx.db, AGENCY);
    await engine.reloadStatic(BOARD);
    assert.equal(engine.getIndex().slotsByTrip.size, FIXTURE_TRIPS);

    await fx.db.query('DELETE FROM stop_times WHERE agency=$1 AND trip_id=$2', [AGENCY, 'T00007']);
    await fx.db.query('DELETE FROM trips WHERE agency=$1 AND trip_id=$2', [AGENCY, 'T00007']);
    await engine.reloadStatic(BOARD);
    assert.equal(engine.getIndex().source, 'build');
    assert.equal(engine.getIndex().slotsByTrip.size, FIXTURE_TRIPS - 1,
      'the withdrawn trip is gone from the index');
  } finally { await fx.dispose(); }
});

// ---------- what it costs ----------

test('MEASURE: payload size, and restore against build', async () => {
  const fx = await makeFixture();
  try {
    const fp = (await boardFingerprint(fx.db, AGENCY))!;

    const bt0 = Date.now();
    const built = await buildPatternIndex(fx.db, AGENCY, BOARD, fp);
    const buildMs = Date.now() - bt0;

    const sealed = packIndex(built, AGENCY);
    const rt0 = Date.now();
    const restored = unpackIndex(sealed, { agency: AGENCY, boardTag: BOARD, fingerprint: fp })!;
    const restoreMs = Date.now() - rt0;

    const stRows = Number((await fx.db.query<{ n: number }>(
      'SELECT count(*) AS n FROM stop_times WHERE agency=$1', [AGENCY])).rows[0].n);

    console.log(`\n  [measure] fixture: ${stRows} stop_times rows, ${built.slotsByTrip.size} trips, ` +
      `${built.patterns.size} patterns`);
    console.log(`  [measure] sealed payload ${sealed.length} B (${(sealed.length / stRows).toFixed(2)} B per source row), ` +
      `base64 as stored ${Math.ceil(sealed.length / 3) * 4} B`);
    console.log(`  [measure] build ${buildMs} ms  ->  restore ${restoreMs} ms\n`);

    assert.deepEqual(snapshot(restored), snapshot(built));
    assert.ok(sealed.length > 0);
  } finally { await fx.dispose(); }
});
