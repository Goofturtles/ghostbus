// eval — the spec's honest evaluation script (`npm run eval`).
//
// Two independent sections, both computed from real rows in the configured DB (same
// dual-driver pattern as aggregate.ts: DATABASE_URL set -> pg, unset -> PGlite). Every
// number printed traces to a query. This script NEVER fabricates or extrapolates a metric:
// a thin-data report is a correct, successful run, not a failure — exit code is always 0.
//
//   1. Ghost Forecast backtest (METHODS.md §7, §9.4). Hold out the most recent FULL
//      service day that recorded a meaningful number of ghost events, train the
//      (route, hour_of_week) risk model on the days before it, then score every
//      departure due on the held-out day against what that trained model would have
//      flagged. Reuses `buildForecast` / `ghostRiskFor` from api.ts UNMODIFIED — this is a
//      backtest of the exact mechanism the live app ships, not a reimplementation of it.
//
//      REALITY TODAY: the `ghosts` table has recorded ZERO rows for this project's entire
//      life so far — the mass-ghost breaker honestly suppresses emission while the
//      realtime/static join rate matures (METHODS.md §9.4). So this section prints
//      "not runnable" against the real database. It is written and fixture-tested against
//      synthetic ghosts so the backtest is ready the day the breaker stops firing, rather
//      than being built after the fact under time pressure.
//
//   2. Honest-ETA within-sample calibration (METHODS.md §6). Reconstructing "what agg_delay
//      looked like at observation time" is not something the stored data can answer
//      honestly (no history of the aggregate table is kept), so this does the honest
//      simpler thing: for each (route, hour_of_week) bucket with enough observations to be
//      the estimator's own route-hour fallback, what fraction of THAT bucket's own
//      observations fall inside THAT bucket's own P25-P75 band. Expected ~50% by
//      construction; a large deviation shows the band is not internally consistent.
//      Labelled clearly as within-sample: NOT a holdout, NOT a forecast-skill score.
//      Runnable today — 1,000+ genuine `sched_diff` observations exist.
//
// Agency-scoped: every query below binds agency='ttc' explicitly. 'ttc-demo' (Demo Mode's
// replay namespace, DEMO_AGENCY in demo.ts) is never queried by this script.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { getDb, type Db } from './db.ts';
import { torontoDay, torontoMidnightEpoch, hourOfWeek } from './tz.ts';
import { activeServiceIds, type CalendarRow, type CalendarDateRow } from './gtfs.ts';
import {
  buildForecast, ghostRiskFor,
  type ForecastDay, type TripStartBucket,
} from './api.ts';
import { WINDOW_DAYS } from './aggregate.ts';
import { percentileCont, ROUTE_HOUR_MIN_N } from './eta.ts';

const AGENCY = 'ttc';

// =====================================================================================
// Section 1: Ghost Forecast backtest
// =====================================================================================

// "Meaningful" is defined here, printed in the report, and nowhere else duplicated: a
// train/test split needs at least this many FULL (already-ended) service days that each
// recorded at least this many ghost events, or the split is an anecdote wearing a
// percentage sign. Chosen a priori, same spirit as the GHOST_RISK_* constants in api.ts.
export const BACKTEST_MIN_QUALIFYING_DAYS = 2;
export const BACKTEST_MIN_EVENTS_PER_DAY = 5;
// How many trailing days the risk model trains over, immediately before the holdout day.
// Reuses aggregate.ts's own WINDOW_DAYS rather than a fresh literal: same concept ("how
// much trailing history is recent enough to build a rate from").
const TRAIN_WINDOW_DAYS = WINDOW_DAYS;

export interface BacktestThin {
  runnable: false;
  reason: string;
  totalGhostEvents: number;
  serviceDaysObserved: number;
  qualifyingDays: number;
}

export interface BacktestRunnable {
  runnable: true;
  holdoutYmd: number;
  trainWindowDays: number;
  truePositives: number;   // flagged-risky departures that actually ghosted
  falsePositives: number;  // flagged-risky departures that did NOT ghost
  falseNegatives: number;  // un-flagged departures that DID ghost
  trueNegatives: number;   // un-flagged departures that did not ghost
  totalDue: number;
  baseRate: number;        // (TP+FN) / totalDue — the holdout day's raw ghost rate
  precision: number | null; // TP / (TP+FP): of what we flagged, how much actually ghosted
  recall: number | null;    // TP / (TP+FN): of what actually ghosted, how much we flagged
  /** Cells where a recorded ghost's own count exceeded the CURRENT static schedule's due
   *  count for that cell (board drift between when the ghost fired and when this ran).
   *  Clamped in the totals above; a nonzero value here means take the numbers as a lower
   *  bound on schedule disagreement, not a clean read. Should be 0 in the ordinary case. */
  inconsistentCells: number;
}

export type BacktestOutcome = BacktestThin | BacktestRunnable;

function thinBacktest(
  reason: string, totalGhostEvents: number, serviceDaysObserved: number, qualifyingDays: number,
): BacktestThin {
  return { runnable: false, reason, totalGhostEvents, serviceDaysObserved, qualifyingDays };
}

export async function computeGhostForecastBacktest(db: Db): Promise<BacktestOutcome> {
  const ghostRows = (await db.query<{ trip_id: string; route_id: string | null; scheduled_start: string | Date }>(
    `SELECT trip_id, route_id, scheduled_start FROM ghosts WHERE agency = $1 AND kind = 'ghost'
     ORDER BY scheduled_start`,
    [AGENCY])).rows;

  // Days the collector has demonstrably produced at least one delay observation for — the
  // same "demonstrably ran" proof buildForecast's watched-cell test uses (METHODS.md §7),
  // at day rather than hour granularity. Computed unconditionally: it is the honest number
  // behind "N service days observed" whether or not any ghost ever fired.
  const serviceDaysObserved = Number((await db.query<{ n: number | string }>(
    `SELECT COUNT(DISTINCT service_date)::int AS n FROM trip_delay_obs WHERE agency = $1`,
    [AGENCY])).rows[0]?.n ?? 0);

  if (ghostRows.length === 0) {
    return thinBacktest(
      `0 ghost events recorded across ${serviceDaysObserved} service day(s) observed ` +
      `(breaker suppression: see /api/health)`,
      0, serviceDaysObserved, 0);
  }

  const toMs = (v: string | Date): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

  // Bucket every ghost event by the plain Toronto calendar date of its scheduled start —
  // the SAME day concept buildForecast's own `cellOf` uses (torontoDay, not serviceYmd),
  // because this backtest scores exactly that mechanism and must bucket identically.
  const byDay = new Map<number, { routeId: string; scheduledStartMs: number }[]>();
  for (const g of ghostRows) {
    if (!g.route_id) continue;
    const ms = toMs(g.scheduled_start);
    if (!Number.isFinite(ms)) continue;
    const ymd = torontoDay(ms).ymd;
    const list = byDay.get(ymd) ?? [];
    list.push({ routeId: g.route_id, scheduledStartMs: ms });
    byDay.set(ymd, list);
  }

  const todayYmd = torontoDay(Date.now()).ymd;
  const qualifying = [...byDay.entries()].filter(([, list]) => list.length >= BACKTEST_MIN_EVENTS_PER_DAY);
  const fullQualifying = qualifying.filter(([ymd]) => ymd < todayYmd);

  if (fullQualifying.length < BACKTEST_MIN_QUALIFYING_DAYS) {
    return thinBacktest(
      `${ghostRows.length} ghost event(s) across ${byDay.size} distinct service day(s), but only ` +
      `${fullQualifying.length} full service day(s) meet the >=${BACKTEST_MIN_EVENTS_PER_DAY}-event bar`,
      ghostRows.length, serviceDaysObserved, fullQualifying.length);
  }

  const holdoutYmd = Math.max(...fullQualifying.map(([ymd]) => ymd));

  // The overall "≥2 qualifying days somewhere in history" check above is not enough on its
  // own: the model only ever trains on TRAIN_WINDOW_DAYS days immediately before the
  // holdout, so the second qualifying day must fall inside THAT window or the "meaningful
  // split" claim would rest on data the model never actually sees. Pure — no calendar
  // needed, so this fails fast before the heavier schedule queries below.
  const midnightFor = (ymd: number): number =>
    torontoMidnightEpoch(Math.floor(ymd / 10000), Math.floor(ymd / 100) % 100, ymd % 100);
  const trainWindowStartMs = midnightFor(holdoutYmd) - TRAIN_WINDOW_DAYS * 86_400_000;
  const windowQualifying = fullQualifying.filter(([ymd]) => midnightFor(ymd) >= trainWindowStartMs);
  if (windowQualifying.length < BACKTEST_MIN_QUALIFYING_DAYS) {
    return thinBacktest(
      `only ${windowQualifying.length} of the required >=${BACKTEST_MIN_QUALIFYING_DAYS} qualifying ` +
      `service day(s) fall within the ${TRAIN_WINDOW_DAYS}-day training window ending ${holdoutYmd} ` +
      `(${fullQualifying.length} qualifying day(s) exist across all recorded history)`,
      ghostRows.length, serviceDaysObserved, fullQualifying.length);
  }

  // ----- static schedule (agency-wide; not date-scoped, same shape as api.ts's refreshForecast) -----
  const calendar: CalendarRow[] = (await db.query<{
    service_id: string; mon: boolean; tue: boolean; wed: boolean; thu: boolean; fri: boolean; sat: boolean; sun: boolean;
    start_date: number; end_date: number;
  }>(`SELECT service_id, mon, tue, wed, thu, fri, sat, sun, start_date, end_date FROM calendar WHERE agency = $1`,
    [AGENCY])).rows
    .map((r) => ({ service_id: r.service_id, days: [r.mon, r.tue, r.wed, r.thu, r.fri, r.sat, r.sun] as CalendarRow['days'], start_date: Number(r.start_date), end_date: Number(r.end_date) }));
  const calendarDates: CalendarDateRow[] = (await db.query<{ service_id: string; date: number; exception_type: number }>(
    `SELECT service_id, date, exception_type FROM calendar_dates WHERE agency = $1`, [AGENCY])).rows
    .map((r) => ({ service_id: r.service_id, date: Number(r.date), exception_type: Number(r.exception_type) }));

  const byService = new Map<string, TripStartBucket[]>();
  for (const r of (await db.query<{ route_id: string; service_id: string; start_s: number | string; n: number }>(
    `SELECT route_id, service_id, start_s, COUNT(*)::int AS n FROM (
       SELECT DISTINCT ON (t.trip_id) t.trip_id, t.route_id, t.service_id,
              COALESCE(st.departure_s, st.arrival_s) AS start_s
       FROM trips t JOIN stop_times st ON st.agency = t.agency AND st.trip_id = t.trip_id
       WHERE t.agency = $1 ORDER BY t.trip_id, st.stop_sequence
     ) x
     WHERE route_id IS NOT NULL AND service_id IS NOT NULL AND start_s IS NOT NULL
     GROUP BY route_id, service_id, start_s`, [AGENCY])).rows) {
    const list = byService.get(r.service_id) ?? [];
    list.push({ routeId: r.route_id, startS: Number(r.start_s), n: Number(r.n) });
    byService.set(r.service_id, list);
  }

  // Watched cells: every whole hour, ever, with at least one delay observation. No date
  // filter — the training/holdout day split below decides which of these matter.
  const cellOf = (epochMs: number): { ymd: number; how: number } => ({ ymd: torontoDay(epochMs).ymd, how: hourOfWeek(epochMs) });
  const watched = new Set<string>();
  for (const r of (await db.query<{ hr: string | number }>(
    `SELECT DISTINCT FLOOR(EXTRACT(EPOCH FROM ts) / 3600)::bigint AS hr FROM trip_delay_obs WHERE agency = $1`,
    [AGENCY])).rows) {
    const cell = cellOf(Number(r.hr) * 3_600_000);
    watched.add(`${cell.ymd}|${cell.how}`);
  }

  function dayFor(ymd: number): ForecastDay {
    const midnightMs = midnightFor(ymd);
    const dow = torontoDay(midnightMs + 3_600_000).dow; // +1h: clear of a midnight DST edge
    return { ymd, midnightMs, serviceIds: [...activeServiceIds(calendar, calendarDates, [{ ymd, dow }])] };
  }

  // Walk backward from the holdout day: itself, plus TRAIN_WINDOW_DAYS before it.
  const holdoutMidnight = midnightFor(holdoutYmd);
  const allDays: ForecastDay[] = [];
  for (let i = 0; i <= TRAIN_WINDOW_DAYS; i++) {
    allDays.push(dayFor(torontoDay(holdoutMidnight - i * 86_400_000).ymd));
  }
  const trainDays = allDays.filter((d) => d.ymd < holdoutYmd);
  const holdoutDay = allDays.find((d) => d.ymd === holdoutYmd);
  if (!holdoutDay) {
    return thinBacktest(
      `holdout day ${holdoutYmd} did not resolve to a calendar day (internal)`,
      ghostRows.length, serviceDaysObserved, fullQualifying.length);
  }

  const trainYmds = new Set(trainDays.map((d) => d.ymd));
  const trainGhosts = [...byDay.entries()].filter(([ymd]) => trainYmds.has(ymd)).flatMap(([, list]) => list);
  const holdoutGhosts = byDay.get(holdoutYmd) ?? [];

  const trainForecast = buildForecast({ watched, days: trainDays, byService, ghosts: trainGhosts, cellOf });
  const holdoutForecast = buildForecast({ watched, days: [holdoutDay], byService, ghosts: holdoutGhosts, cellOf });

  let truePositives = 0, falsePositives = 0, falseNegatives = 0, trueNegatives = 0, inconsistentCells = 0;
  for (const [key, cell] of holdoutForecast) {
    const trainCell = trainForecast.get(key);
    const flagged = trainCell != null && ghostRiskFor(trainCell.ghosts, trainCell.scheduled, TRAIN_WINDOW_DAYS) !== null;
    // A cell can never legitimately have more ghosts than departures due — ghostRiskFor
    // guards exactly this on the training side (api.ts). On the holdout side `scheduled`
    // is recomputed from the CURRENT static tables while a ghost's cell is derived from
    // its own recorded scheduled_start, so a board re-seed between recording and running
    // this eval could disagree. Clamp rather than let a negative count corrupt the totals
    // silently, and surface the disagreement so it is never mistaken for a clean number.
    if (cell.ghosts > cell.scheduled) inconsistentCells++;
    const ghosted = Math.min(cell.ghosts, cell.scheduled);
    const notGhosted = Math.max(0, cell.scheduled - cell.ghosts);
    if (flagged) { truePositives += ghosted; falsePositives += notGhosted; }
    else { falseNegatives += ghosted; trueNegatives += notGhosted; }
  }

  const totalDue = truePositives + falsePositives + falseNegatives + trueNegatives;
  if (totalDue === 0) {
    return thinBacktest(
      `holdout day ${holdoutYmd} qualified on event count, but none of its due departures fall in ` +
      `an hour the collector is proven to have watched`,
      ghostRows.length, serviceDaysObserved, fullQualifying.length);
  }
  const actualGhosts = truePositives + falseNegatives;
  const flaggedTotal = truePositives + falsePositives;

  return {
    runnable: true,
    holdoutYmd,
    trainWindowDays: TRAIN_WINDOW_DAYS,
    truePositives, falsePositives, falseNegatives, trueNegatives,
    totalDue,
    baseRate: actualGhosts / totalDue,
    precision: flaggedTotal > 0 ? truePositives / flaggedTotal : null,
    recall: actualGhosts > 0 ? truePositives / actualGhosts : null,
    inconsistentCells,
  };
}

function formatBacktest(o: BacktestOutcome): string {
  if (!o.runnable) {
    return (
      `Ghost Forecast backtest: not runnable — ${o.reason}. A meaningful eval needs ` +
      `>=${BACKTEST_MIN_QUALIFYING_DAYS} full service days with >=${BACKTEST_MIN_EVENTS_PER_DAY} ` +
      `ghost events each (have ${o.qualifyingDays} qualifying day(s), ${o.totalGhostEvents} ghost ` +
      `event(s) total, ${o.serviceDaysObserved} service day(s) observed).`
    );
  }
  const pct = (n: number | null): string => (n == null ? 'n/a' : `${(n * 100).toFixed(1)}%`);
  return [
    `Ghost Forecast backtest: RUNNABLE — held out service day ${o.holdoutYmd}, trained on the ` +
      `${o.trainWindowDays} days before it.`,
    `  Departures due on the holdout day: ${o.totalDue} (${o.truePositives + o.falseNegatives} actually ghosted — base rate ${pct(o.baseRate)}).`,
    `  Flagged risky by the trained model: ${o.truePositives + o.falsePositives}` +
      ` (hits ${o.truePositives}, false alarms ${o.falsePositives}).`,
    `  Missed (ghosted, not flagged): ${o.falseNegatives}.`,
    `  Precision (of flagged, how many ghosted): ${pct(o.precision)}. Recall (of ghosts, how many flagged): ${pct(o.recall)}.`,
    ...(o.inconsistentCells > 0
      ? [`  WARNING: ${o.inconsistentCells} cell(s) had more recorded ghosts than the current static ` +
         `schedule shows as due — board drift between recording and this run; counts above are clamped.`]
      : []),
  ].join('\n');
}

// =====================================================================================
// Section 2: Honest-ETA within-sample calibration
// =====================================================================================

// Below this many qualifying observations in the window, any coverage number is noise
// dressed as a statistic. Chosen to sit comfortably under the "1,000+ real obs" the spec
// names as the current reality, while still requiring enough rows to matter.
export const CALIBRATION_MIN_OBS = 500;

export interface CalibrationThin {
  runnable: false;
  totalObs: number;
  windowDays: number;
}

export interface CalibrationRunnable {
  runnable: true;
  totalObs: number;        // all evidence-qualifying rows in the trailing window
  bucketsConsidered: number; // (route, hour_of_week) buckets with n >= ROUTE_HOUR_MIN_N
  obsInBuckets: number;    // sum of n across those buckets (<= totalObs)
  covered: number;         // of obsInBuckets, how many fall inside [own bucket's P25, P75]
  coverage: number;        // covered / obsInBuckets
  windowDays: number;
}

export type CalibrationOutcome = CalibrationThin | CalibrationRunnable;

export async function computeEtaCalibration(db: Db): Promise<CalibrationOutcome> {
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  // Identical evidence gate to aggregate.ts's runAggregation: only genuine schedule-
  // difference rows, at high confidence, through a confident stop crosswalk, are evidence.
  const rows = (await db.query<{ route_id: string; hour_of_week: number; delay_s: number }>(
    `SELECT route_id, hour_of_week, delay_s FROM trip_delay_obs
     WHERE agency = $1 AND ts >= $2 AND delay_s IS NOT NULL AND route_id IS NOT NULL
       AND hour_of_week IS NOT NULL AND method = 'sched_diff' AND confidence = 'high' AND xwalk_conf >= 0.60`,
    [AGENCY, cutoff])).rows;

  const totalObs = rows.length;
  if (totalObs < CALIBRATION_MIN_OBS) {
    return { runnable: false, totalObs, windowDays: WINDOW_DAYS };
  }

  const byBucket = new Map<string, number[]>();
  for (const r of rows) {
    const key = `${r.route_id}|${Number(r.hour_of_week)}`;
    const list = byBucket.get(key) ?? [];
    list.push(Number(r.delay_s));
    byBucket.set(key, list);
  }

  let bucketsConsidered = 0, obsInBuckets = 0, covered = 0;
  for (const delays of byBucket.values()) {
    // Only buckets that would actually back a route-hour estimate today (eta.ts's own
    // ROUTE_HOUR_MIN_N) are "old enough to have had a prediction" — a 3-observation bucket
    // never surfaces a number for a rider to check, so its coverage is not a calibration.
    if (delays.length < ROUTE_HOUR_MIN_N) continue;
    bucketsConsidered++;
    const p25 = percentileCont(delays, 0.25) as number;
    const p75 = percentileCont(delays, 0.75) as number;
    obsInBuckets += delays.length;
    for (const d of delays) if (d >= p25 && d <= p75) covered++;
  }

  return {
    runnable: true, totalObs, bucketsConsidered, obsInBuckets, covered,
    coverage: obsInBuckets > 0 ? covered / obsInBuckets : 0,
    windowDays: WINDOW_DAYS,
  };
}

function formatCalibration(o: CalibrationOutcome): string {
  if (!o.runnable) {
    return (
      `Honest-ETA calibration: thin data — ${o.totalObs} qualifying observation(s) in the trailing ` +
      `${o.windowDays}-day window (need >=${CALIBRATION_MIN_OBS}).`
    );
  }
  return [
    `Honest-ETA calibration: WITHIN-SAMPLE (not a holdout; measures band consistency, not forecast skill).`,
    `  Qualifying observations in the trailing ${o.windowDays}-day window: ${o.totalObs}.`,
    `  (route, hour_of_week) buckets with n >= ${ROUTE_HOUR_MIN_N}: ${o.bucketsConsidered}, ` +
      `covering ${o.obsInBuckets} of those observations.`,
    `  Fraction of each bucket's own observations landing inside that bucket's own P25-P75 band: ` +
      `${(o.coverage * 100).toFixed(1)}% (${o.covered}/${o.obsInBuckets}). Expected ~50% by ` +
      `construction — deviation shows drift in the band, not a forecast error.`,
  ].join('\n');
}

// ---------- standalone entry (`npm run eval`) ----------
async function main(): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  console.log(`GhostBus eval — driver=${db.driver}, agency=${AGENCY}, run at ${now}`);
  console.log('');
  console.log(formatBacktest(await computeGhostForecastBacktest(db)));
  console.log('');
  console.log(formatCalibration(await computeEtaCalibration(db)));
  await db.close();
}

// Only run main when invoked directly (npm run eval), not when imported by tests.
// Normalize both paths so the check is robust on Windows (same as aggregate.ts).
const invokedDirectly = !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  // A thin-data report is a correct, successful run of this script — only an unexpected
  // failure (e.g. the database is unreachable) is a real error, so only that path exits 1.
  main().catch((e) => { console.error('eval FAILED:', e); process.exit(1); });
}
