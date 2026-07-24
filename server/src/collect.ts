// collect — standalone GTFS-realtime collector for the TTC.
//
// Polls the three TTC feeds every 45s, decodes the protobuf, and writes only
// DISTILLED events to the database:
//   - trip_delay_obs : delay observations at stops a vehicle has already passed
//   - ghosts         : scheduled trips that never showed up (genuine, computed)
//   - service_alerts : upserted alerts, accessibility-flagged
//
// Raw vehicle pings are NEVER persisted. Current positions live in an in-process
// map with a short per-vehicle ring buffer and are dropped when the process ends.
//
// Ghost detection is gated on a live-measured RT<->static trip_id match rate: if
// realtime trip_ids don't line up with the static GTFS trip_ids, every scheduled
// trip would look like a ghost, so emission is suppressed and the mismatch is
// reported instead of faked. See DECISIONS.md / BLOCKERS.md.

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { getDb, type Db, type Queryable } from './db.ts';
import {
  activeServiceIds,
  type CalendarRow,
  type CalendarDateRow,
} from './gtfs.ts';
import { torontoDay, torontoMidnightEpoch, hourOfWeek, torontoYmd } from './tz.ts';

const { transit_realtime } = GtfsRealtimeBindings;

const AGENCY = 'ttc';
const FEEDS = {
  vehicles: 'https://bustime.ttc.ca/gtfsrt/vehicles',
  trips: 'https://bustime.ttc.ca/gtfsrt/trips',
  alerts: 'https://bustime.ttc.ca/gtfsrt/alerts',
} as const;
type FeedKey = keyof typeof FEEDS;

const POLL_MS = 45_000;
const REQUEST_TIMEOUT_MS = 10_000;
const GHOST_MIN_AGE_MS = 6 * 60_000; // scheduled start >= 6 min ago
const GHOST_MAX_AGE_MS = 30 * 60_000; // ...and <= 30 min ago (bounded scan)
const MATCH_RATE_THRESHOLD = 0.5;
const RETENTION_DAYS = 14;
const RING_BUFFER = 6;
const EVICT_AFTER_CYCLES = 10; // drop vehicles not seen for this many polls (~7.5 min)
const MAX_SANE_DELAY_S = 24 * 3600; // drop obviously bogus delays
const MAX_CYCLES = Number(process.env.GHOSTBUS_MAX_CYCLES ?? 0); // 0 = run forever

// ---------- protobuf numeric coercion (Long / bigint / number) ----------
function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object' && v !== null && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  const n = Number(v as number);
  return Number.isNaN(n) ? null : n;
}

function enumName(enumObj: Record<string, number>, val: number | null | undefined): string | null {
  if (val == null) return null;
  for (const [k, v] of Object.entries(enumObj)) if (v === val) return k;
  return String(val);
}

function translated(ts: { translation?: Array<{ text?: string | null }> } | null | undefined): string | null {
  const t = ts?.translation?.[0]?.text;
  return t == null || t === '' ? null : t;
}

// ---------- in-memory state ----------
interface VehicleState { tripId: string | null; routeId: string | null; seq: number | null; lat: number; lon: number; ts: number; cycleSeen: number }
const positions = new Map<string, VehicleState>();
const ring = new Map<string, Array<{ lat: number; lon: number; ts: number }>>();

interface TripStart { routeId: string | null; serviceId: string | null; startS: number | null }
const tripStarts = new Map<string, TripStart>();
const staticTripIds = new Set<string>();

let calendar: CalendarRow[] = [];
let calendarDates: CalendarDateRow[] = [];
const activeServiceCache = new Map<number, Set<string>>(); // ymd -> active service_ids
const midnightCache = new Map<number, number>();           // ymd -> local-midnight epoch ms

const delayDedupe = new Map<string, number>(); // `${tripId}|${stopId}` -> serviceDate (complements DB unique; pruned on day rollover)

// Rolling RT<->static trip_id match calibration. Accumulated across cycles so a tiny
// early sample can't permanently latch a wrong decision; ghost emission only turns on
// once we have a confident sample AND the rate clears the threshold.
const MATCH_MIN_SAMPLE = 50;
let matchMatched = 0;
let matchTotal = 0;
let currentMatchRate = 0;
let ghostEnabled = false;
let calibrated = false;

interface FeedState { etag?: string; lastModified?: string; fails: number; nextAttemptAt: number }
const feedState: Record<FeedKey, FeedState> = {
  vehicles: { fails: 0, nextAttemptAt: 0 },
  trips: { fails: 0, nextAttemptAt: 0 },
  alerts: { fails: 0, nextAttemptAt: 0 },
};

const totals = { obs: 0, ghosts: 0, cancelled: 0, alerts: 0 };
let lastRetentionYmd = 0;
let db: Db;
let stopping = false;

// ---------- feed fetch: 10s timeout, conditional requests, exponential backoff ----------
type FeedMessage = ReturnType<typeof transit_realtime.FeedMessage.decode>;
async function fetchFeed(key: FeedKey): Promise<{ status: 'ok'; msg: FeedMessage } | { status: 'notmodified' | 'skip' | 'error'; reason?: string }> {
  const st = feedState[key];
  const now = Date.now();
  if (now < st.nextAttemptAt) return { status: 'skip', reason: `backoff ${(st.nextAttemptAt - now) / 1000 | 0}s` };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (st.etag) headers['If-None-Match'] = st.etag;
    if (st.lastModified) headers['If-Modified-Since'] = st.lastModified;
    const res = await fetch(FEEDS[key], { signal: ctrl.signal, headers });
    if (res.status === 304) { st.fails = 0; st.nextAttemptAt = 0; return { status: 'notmodified' }; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const msg = transit_realtime.FeedMessage.decode(buf);
    st.etag = res.headers.get('etag') ?? undefined;
    st.lastModified = res.headers.get('last-modified') ?? undefined;
    st.fails = 0;
    st.nextAttemptAt = 0;
    return { status: 'ok', msg };
  } catch (e) {
    st.fails++;
    const backoff = Math.min(5_000 * 2 ** (st.fails - 1), 5 * 60_000);
    st.nextAttemptAt = Date.now() + backoff;
    return { status: 'error', reason: `${e instanceof Error ? e.message : String(e)} (backoff ${backoff / 1000}s)` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- static context loaded once at startup ----------
async function loadStaticContext(): Promise<void> {
  const cal = await db.query<{ service_id: string; mon: boolean; tue: boolean; wed: boolean; thu: boolean; fri: boolean; sat: boolean; sun: boolean; start_date: number; end_date: number }>(
    'SELECT service_id, mon, tue, wed, thu, fri, sat, sun, start_date, end_date FROM calendar WHERE agency=$1',
    [AGENCY],
  );
  calendar = cal.rows.map((r) => ({
    service_id: r.service_id,
    days: [r.mon, r.tue, r.wed, r.thu, r.fri, r.sat, r.sun],
    start_date: Number(r.start_date),
    end_date: Number(r.end_date),
  }));

  const cd = await db.query<{ service_id: string; date: number; exception_type: number }>(
    'SELECT service_id, date, exception_type FROM calendar_dates WHERE agency=$1',
    [AGENCY],
  );
  calendarDates = cd.rows.map((r) => ({ service_id: r.service_id, date: Number(r.date), exception_type: Number(r.exception_type) }));

  const ids = await db.query<{ trip_id: string }>('SELECT trip_id FROM trips WHERE agency=$1', [AGENCY]);
  for (const r of ids.rows) staticTripIds.add(r.trip_id);

  const starts = await db.query<{ trip_id: string; route_id: string | null; service_id: string | null; start_s: number | null }>(
    `SELECT DISTINCT ON (t.trip_id) t.trip_id, t.route_id, t.service_id,
            COALESCE(st.departure_s, st.arrival_s) AS start_s
     FROM trips t
     JOIN stop_times st ON st.agency = t.agency AND st.trip_id = t.trip_id
     WHERE t.agency = $1
     ORDER BY t.trip_id, st.stop_sequence`,
    [AGENCY],
  );
  for (const r of starts.rows) {
    tripStarts.set(r.trip_id, { routeId: r.route_id, serviceId: r.service_id, startS: r.start_s == null ? null : Number(r.start_s) });
  }
  console.log(`[startup] loaded ${calendar.length} calendar, ${calendarDates.length} calendar_dates, ${staticTripIds.size} trips (${tripStarts.size} with a first-stop time)`);
}

function servicesForYmd(ymd: number, dow: number): Set<string> {
  let s = activeServiceCache.get(ymd);
  if (!s) { s = activeServiceIds(calendar, calendarDates, [{ ymd, dow }]); activeServiceCache.set(ymd, s); }
  return s;
}
function midnightForYmd(ymd: number): number {
  let m = midnightCache.get(ymd);
  if (m === undefined) {
    const y = Math.floor(ymd / 10000);
    const mo = Math.floor((ymd % 10000) / 100);
    const d = ymd % 100;
    m = torontoMidnightEpoch(y, mo, d);
    midnightCache.set(ymd, m);
  }
  return m;
}

// ---------- generic batched insert ----------
async function insertRows(
  table: string,
  columns: string[],
  rows: unknown[][],
  opts: { conflict: string; casts?: Record<number, string> },
): Promise<number> {
  if (rows.length === 0) return 0;
  let inserted = 0;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const values: unknown[] = [];
    const tuples: string[] = [];
    let p = 1;
    for (const row of slice) {
      const ph: string[] = [];
      for (let c = 0; c < columns.length; c++) {
        let s = `$${p++}`;
        if (opts.casts && opts.casts[c]) s += opts.casts[c];
        ph.push(s);
        values.push(row[c]);
      }
      tuples.push(`(${ph.join(',')})`);
    }
    const text = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ${opts.conflict}`;
    const r = await db.query(text, values);
    inserted += r.rowCount;
  }
  return inserted;
}

// ---------- per-poll processing ----------
interface CycleStats { vehicles: number; tripUpdates: number; obsInserted: number; ghosts: number; cancelled: number; alerts: number }

function processVehicles(msg: FeedMessage, seenTripIds: Set<string>, seqByTrip: Map<string, number>, cycle: number): number {
  let n = 0;
  for (const e of msg.entity) {
    const v = e.vehicle;
    if (!v?.position) continue;
    n++;
    const vid = v.vehicle?.id ?? e.id;
    const tripId = v.trip?.tripId ?? null;
    const seq = v.currentStopSequence && v.currentStopSequence > 0 ? v.currentStopSequence : null;
    const ts = (toNum(v.timestamp) ?? Math.floor(Date.now() / 1000)) * 1000;
    positions.set(vid, { tripId, routeId: v.trip?.routeId ?? null, seq, lat: v.position.latitude, lon: v.position.longitude, ts, cycleSeen: cycle });
    let buf = ring.get(vid);
    if (!buf) { buf = []; ring.set(vid, buf); }
    buf.push({ lat: v.position.latitude, lon: v.position.longitude, ts });
    if (buf.length > RING_BUFFER) buf.shift();
    if (tripId) {
      seenTripIds.add(tripId);
      if (seq != null) seqByTrip.set(tripId, seq);
    }
  }
  return n;
}

interface Cancelled { tripId: string; serviceDate: number | null }
function processTripUpdates(
  msg: FeedMessage,
  seenTripIds: Set<string>,
  seqByTrip: Map<string, number>,
  now: number,
  obsRows: unknown[][],
  cancelled: Cancelled[],
): number {
  const CANCELED = transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED;
  let n = 0;
  for (const e of msg.entity) {
    const tu = e.tripUpdate;
    if (!tu) continue;
    n++;
    const tripId = tu.trip?.tripId ?? null;
    const routeId = tu.trip?.routeId ?? (tripId ? tripStarts.get(tripId)?.routeId ?? null : null);
    const startDate = tu.trip?.startDate ? Number(tu.trip.startDate) : null;
    if (tripId) seenTripIds.add(tripId);

    if (tu.trip?.scheduleRelationship === CANCELED && tripId) {
      cancelled.push({ tripId, serviceDate: startDate });
      continue;
    }
    if (!tripId) continue;

    const seqNow = seqByTrip.get(tripId) ?? null;
    for (const stu of tu.stopTimeUpdate ?? []) {
      const stopId = stu.stopId ?? null;
      if (!stopId) continue;
      const stopSeq = stu.stopSequence && stu.stopSequence > 0 ? stu.stopSequence : null;
      const evTime = toNum(stu.departure?.time) ?? toNum(stu.arrival?.time);
      const rawDelay = stu.departure?.delay ?? stu.arrival?.delay;
      const delay = rawDelay == null ? null : toNum(rawDelay);

      const passedBySeq = seqNow != null && stopSeq != null && stopSeq < seqNow;
      const passedByTime = evTime != null && evTime * 1000 <= now;
      if (!passedBySeq && !passedByTime) continue; // only stops the vehicle has passed
      if (delay == null) continue; // need an explicit delay to record an honest observation
      if (Math.abs(delay) > MAX_SANE_DELAY_S) continue; // drop bogus values

      const serviceDate = startDate ?? torontoYmd(now);
      const key = `${tripId}|${stopId}`;
      if (delayDedupe.get(key) === serviceDate) continue; // already recorded this stop for this service day
      delayDedupe.set(key, serviceDate);
      const eventEpoch = evTime != null ? evTime * 1000 : now;
      obsRows.push([AGENCY, routeId, stopId, tripId, hourOfWeek(eventEpoch), delay, serviceDate]);
    }
  }
  return n;
}

function computeGhostCandidates(now: number, present: Set<string>): unknown[][] {
  const today = torontoDay(now);
  const yesterday = torontoDay(now - 86_400_000);
  const rows: unknown[][] = [];
  const seen = new Set<string>();
  for (const day of [today, yesterday]) {
    const svc = servicesForYmd(day.ymd, day.dow);
    if (svc.size === 0) continue;
    const midnight = midnightForYmd(day.ymd);
    for (const [tripId, info] of tripStarts) {
      if (info.startS == null || info.serviceId == null || !svc.has(info.serviceId)) continue;
      const startEpoch = midnight + info.startS * 1000;
      const age = now - startEpoch;
      if (age < GHOST_MIN_AGE_MS || age > GHOST_MAX_AGE_MS) continue;
      if (present.has(tripId)) continue; // it did show up — not a ghost
      const dedupe = `${tripId}|${startEpoch}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      rows.push([AGENCY, tripId, info.routeId, new Date(startEpoch).toISOString(), 'ghost']);
    }
  }
  return rows;
}

function cancelledRows(cancelled: Cancelled[], now: number): unknown[][] {
  const today = torontoDay(now);
  const rows: unknown[][] = [];
  const seen = new Set<string>();
  for (const c of cancelled) {
    const info = tripStarts.get(c.tripId);
    if (!info || info.startS == null) continue; // can't place a scheduled_start without static schedule
    const ymd = c.serviceDate ?? today.ymd;
    const startEpoch = midnightForYmd(ymd) + info.startS * 1000;
    const dedupe = `${c.tripId}|${startEpoch}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    rows.push([AGENCY, c.tripId, info.routeId, new Date(startEpoch).toISOString(), 'cancelled']);
  }
  return rows;
}

async function processAlerts(msg: FeedMessage): Promise<number> {
  let n = 0;
  for (const e of msg.entity) {
    const al = e.alert;
    if (!al) continue;
    n++;
    const effect = enumName(transit_realtime.Alert.Effect as unknown as Record<string, number>, al.effect);
    const cause = enumName(transit_realtime.Alert.Cause as unknown as Record<string, number>, al.cause);
    const header = translated(al.headerText);
    const description = translated(al.descriptionText);
    const period = al.activePeriod?.[0];
    const activeStart = period?.start != null ? new Date((toNum(period.start) ?? 0) * 1000).toISOString() : null;
    const activeEnd = period?.end != null ? new Date((toNum(period.end) ?? 0) * 1000).toISOString() : null;
    const informed = (al.informedEntity ?? []).map((ie) => ({
      routeId: ie.routeId ?? null,
      stopId: ie.stopId ?? null,
      tripId: ie.trip?.tripId ?? null,
      agencyId: ie.agencyId ?? null,
    }));
    const text = `${header ?? ''} ${description ?? ''}`;
    const isAccessibility = effect === 'ACCESSIBILITY_ISSUE' || /elevator|escalator|wheelchair|accessib/i.test(text);
    await db.query(
      `INSERT INTO service_alerts (agency, alert_id, effect, cause, header, description, active_start, active_end, informed, is_accessibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       ON CONFLICT (agency, alert_id) DO UPDATE SET
         effect=EXCLUDED.effect, cause=EXCLUDED.cause, header=EXCLUDED.header, description=EXCLUDED.description,
         active_start=EXCLUDED.active_start, active_end=EXCLUDED.active_end, informed=EXCLUDED.informed,
         is_accessibility=EXCLUDED.is_accessibility`,
      [AGENCY, e.id, effect, cause, header, description, activeStart, activeEnd, JSON.stringify(informed), isAccessibility],
    );
  }
  return n;
}

async function retention(now: number): Promise<void> {
  const ymd = torontoYmd(now);
  if (ymd === lastRetentionYmd) return;
  lastRetentionYmd = ymd;
  const cutoff = new Date(now - RETENTION_DAYS * 86_400_000).toISOString();
  const r = await db.query('DELETE FROM trip_delay_obs WHERE ts < $1', [cutoff]);
  if (r.rowCount > 0) console.log(`[retention] deleted ${r.rowCount} trip_delay_obs older than ${RETENTION_DAYS}d`);
  // Drop dedupe keys whose service day has passed so the map can't grow without bound.
  let pruned = 0;
  for (const [k, sd] of delayDedupe) if (sd < ymd) { delayDedupe.delete(k); pruned++; }
  if (pruned > 0) console.log(`[retention] pruned ${pruned} stale delay-dedupe keys`);
}

// Evict vehicles not seen for a while so positions/ring stay bounded over a long run.
function evictStaleVehicles(cycle: number): void {
  for (const [vid, st] of positions) {
    if (cycle - st.cycleSeen > EVICT_AFTER_CYCLES) { positions.delete(vid); ring.delete(vid); }
  }
}

async function tableCounts(): Promise<string> {
  const r = await db.query<{ obs: string; ghosts: string; alerts: string }>(
    `SELECT (SELECT COUNT(*) FROM trip_delay_obs)::text AS obs,
            (SELECT COUNT(*) FROM ghosts)::text AS ghosts,
            (SELECT COUNT(*) FROM service_alerts)::text AS alerts`,
  );
  const row = r.rows[0];
  return `trip_delay_obs=${row.obs} ghosts=${row.ghosts} service_alerts=${row.alerts}`;
}

async function poll(cycle: number): Promise<void> {
  const now = Date.now();
  await retention(now);

  const [vr, tr, ar] = await Promise.all([fetchFeed('vehicles'), fetchFeed('trips'), fetchFeed('alerts')]);
  const stats: CycleStats = { vehicles: 0, tripUpdates: 0, obsInserted: 0, ghosts: 0, cancelled: 0, alerts: 0 };

  const seenTripIds = new Set<string>();
  const seqByTrip = new Map<string, number>();
  const obsRows: unknown[][] = [];
  const cancelled: Cancelled[] = [];

  if (vr.status === 'ok') stats.vehicles = processVehicles(vr.msg, seenTripIds, seqByTrip, cycle);
  else console.log(`[cycle ${cycle}] vehicles ${vr.status}${vr.status !== 'ok' && 'reason' in vr && vr.reason ? `: ${vr.reason}` : ''}`);
  evictStaleVehicles(cycle);

  if (tr.status === 'ok') stats.tripUpdates = processTripUpdates(tr.msg, seenTripIds, seqByTrip, now, obsRows, cancelled);
  else console.log(`[cycle ${cycle}] trips ${tr.status}${tr.status !== 'ok' && 'reason' in tr && tr.reason ? `: ${tr.reason}` : ''}`);

  // Rolling RT<->static trip_id match calibration, accumulated across cycles. Ghost
  // emission only turns on once the cumulative sample is large enough (>= MATCH_MIN_SAMPLE)
  // AND the cumulative rate clears the threshold — so a tiny early sample (e.g. 2 vehicles
  // at 5am) can never permanently latch a wrong decision. The rate is re-evaluated every cycle.
  if (seenTripIds.size > 0) {
    let m = 0;
    for (const id of seenTripIds) if (staticTripIds.has(id)) m++;
    matchMatched += m;
    matchTotal += seenTripIds.size;
    currentMatchRate = matchTotal > 0 ? matchMatched / matchTotal : 0;
    const enough = matchTotal >= MATCH_MIN_SAMPLE;
    const wasEnabled = ghostEnabled;
    ghostEnabled = enough && currentMatchRate >= MATCH_RATE_THRESHOLD;
    if (!calibrated && enough) {
      calibrated = true;
      console.log(`\n[calibration] RT trip_id sample=${matchTotal}, matched static=${matchMatched}, match rate=${(currentMatchRate * 100).toFixed(1)}%`);
      if (ghostEnabled) {
        console.log('[calibration] match rate OK -> ghost/cancelled detection ENABLED\n');
      } else {
        console.log('[calibration] match rate BELOW threshold -> ghost/cancelled detection SUPPRESSED (would be all false positives).');
        console.log('[calibration] Fallback identifier is route_id + scheduled start time; delay observations still work (feed-provided delays).\n');
      }
    } else if (calibrated && ghostEnabled !== wasEnabled) {
      console.log(`[calibration] cumulative match rate now ${(currentMatchRate * 100).toFixed(1)}% -> ghost/cancelled detection ${ghostEnabled ? 'ENABLED' : 'SUPPRESSED'}`);
    }
  }

  if (obsRows.length > 0) {
    stats.obsInserted = await insertRows('trip_delay_obs', ['agency', 'route_id', 'stop_id', 'trip_id', 'hour_of_week', 'delay_s', 'service_date'], obsRows, {
      conflict: 'ON CONFLICT (agency, trip_id, stop_id, service_date) DO NOTHING',
    });
    totals.obs += stats.obsInserted;
  }

  // Only scan for ghosts when BOTH presence feeds are fresh this cycle; otherwise a
  // 304/error on the trips feed would drop genuinely-running trips from `present` and
  // flag them as false ghosts.
  const feedsFresh = vr.status === 'ok' && tr.status === 'ok';
  if (ghostEnabled && !feedsFresh) {
    console.log(`[cycle ${cycle}] ghost scan skipped (vehicles/trips feed not fresh)`);
  }
  if (ghostEnabled && feedsFresh) {
    const present = seenTripIds; // vehicles + tripUpdates trip_ids
    const ghosts = computeGhostCandidates(now, present);
    if (ghosts.length > 0) {
      stats.ghosts = await insertRows('ghosts', ['agency', 'trip_id', 'route_id', 'scheduled_start', 'kind'], ghosts, {
        conflict: 'ON CONFLICT (agency, trip_id, scheduled_start) DO NOTHING',
      });
      totals.ghosts += stats.ghosts;
    }
    const canc = cancelledRows(cancelled, now);
    if (canc.length > 0) {
      stats.cancelled = await insertRows('ghosts', ['agency', 'trip_id', 'route_id', 'scheduled_start', 'kind'], canc, {
        conflict: 'ON CONFLICT (agency, trip_id, scheduled_start) DO NOTHING',
      });
      totals.cancelled += stats.cancelled;
    }
  }

  // Alerts are a full upsert of the CURRENT alert set each cycle, so this is a snapshot
  // (current active alerts), not a running sum — `=` is intentional here, unlike obs/ghosts.
  if (ar.status === 'ok') { stats.alerts = await processAlerts(ar.msg); totals.alerts = stats.alerts; }
  else if (ar.status !== 'notmodified') console.log(`[cycle ${cycle}] alerts ${ar.status}${'reason' in ar && ar.reason ? `: ${ar.reason}` : ''}`);

  console.log(
    `[cycle ${cycle}] vehicles=${stats.vehicles} tripUpdates=${stats.tripUpdates} ` +
    `obs+=${stats.obsInserted} ghosts+=${stats.ghosts} cancelled+=${stats.cancelled} alerts=${stats.alerts} ` +
    `| totals obs=${totals.obs} ghost=${totals.ghosts} cancelled=${totals.cancelled} | DB ${await tableCounts()}`,
  );
}

async function shutdown(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log('\n[shutdown] closing database…');
  try { await db.close(); } catch { /* ignore */ }
  process.exit(code);
}

async function main(): Promise<void> {
  db = await getDb();
  console.log(`GhostBus collector — driver=${db.driver}, poll=${POLL_MS / 1000}s${MAX_CYCLES ? `, max cycles=${MAX_CYCLES}` : ''}`);
  await loadStaticContext();
  if (staticTripIds.size === 0) {
    console.warn('[warn] no static trips found — run `npm run seed:toronto` first. Ghost detection needs the schedule.');
  }

  process.on('SIGINT', () => { console.log('\n[signal] SIGINT'); void shutdown(0); });
  process.on('SIGTERM', () => { console.log('\n[signal] SIGTERM'); void shutdown(0); });

  let cycle = 0;
  const loop = async (): Promise<void> => {
    if (stopping) return;
    cycle++;
    try { await poll(cycle); } catch (e) { console.error(`[cycle ${cycle}] error:`, e); }
    if (MAX_CYCLES > 0 && cycle >= MAX_CYCLES) {
      console.log(`\n[done] reached ${MAX_CYCLES} cycles.`);
      await shutdown(0);
      return;
    }
    if (!stopping) setTimeout(() => void loop(), POLL_MS);
  };
  await loop();
}

main().catch((e) => { console.error('collector FAILED:', e); process.exit(1); });
