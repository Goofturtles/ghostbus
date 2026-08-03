// server — the single deployable GhostBus service.
//
// Boots the database (running migrations), starts the GTFS-realtime poller in-process
// (per the spec: one process, not a separate collector), runs the delay aggregation on
// boot + hourly, and serves the JSON API (and, in production, the built web app).
//
//   npm run dev    -> tsx watch server/src/server.ts
//   npm start      -> node --import tsx server/src/server.ts
//   npm run demo   -> tsx server/src/server.ts --demo   (recorded replay, 8x, DEMO badge)
//
// DEMO MODE is decided here, once, at boot, and never again — see the honesty contract in
// demo.ts. A process that has served one recorded byte must not be able to become a live
// process later, so there is no runtime toggle: `?demo=1` is served by a demo instance,
// not by flipping this one. Everything downstream is identical code on identical shapes.

import { getDb } from './db.ts';
import { createPoller } from './poller.ts';
import { enabledAgencies, agency as agencyOf, isScheduleOnly } from './agencies.ts';
import { demoRequested, bootDemoSource } from './demo.ts';
import { runAggregationAll } from './aggregate.ts';
import { buildApi } from './api.ts';

const PORT = Number(process.env.PORT) || 8799;
const HOST = process.env.HOST || '127.0.0.1';
const AGG_INTERVAL_MS = 60 * 60_000; // hourly

async function main(): Promise<void> {
  const demo = demoRequested();
  const source = demo ? await bootDemoSource() : undefined;

  const db = await getDb();
  console.log(`GhostBus API — driver=${db.driver}, mode=${demo ? 'DEMO (recorded replay)' : 'live'}`);

  /**
   * ONE POLLER PER ENABLED AGENCY, IN ONE PROCESS.
   *
   * `createPoller` closes over all of its state, so N instances cost nothing structurally —
   * which is what preserves ARCHITECTURE.md §3's argument for a single deployable service.
   * A separate process per agency would reintroduce exactly the "publish live positions
   * somewhere for the API to read" problem the memory-first design (§1) exists to avoid.
   *
   * Demo mode stays single-agency: a fixture is a recording of one agency's feeds, and
   * `bootDemoSource()` supplies one source. Replaying it under several pollers would mean
   * N-1 of them observing bytes that are not theirs.
   */
  const enabled = enabledAgencies();

  /**
   * A FIXTURE IS A RECORDING OF ONE AGENCY, AND IT DICTATES WHICH ONE.
   *
   * `source.agency` is the demo namespace ('<agency>-demo'), so the board it replays
   * against is that name minus the suffix. Taking `enabledAgencies()[0]` instead would let
   * `GHOSTBUS_AGENCIES=miway --demo` replay recorded TTC protobuf against MiWay's seeded
   * board — RT ids from one network resolved against another network's stops. That is the
   * cross-namespace blend DECISIONS §48 is about, and it would be invisible: every query
   * would succeed and simply describe the wrong city.
   */
  const agencies = demo && source
    ? [agencyOf(source.agency.replace(/-demo$/, ''))]
    : enabled;
  if (demo && source) {
    console.log(`[boot] demo fixture replays agency '${agencies[0].id}' (writes '${source.agency}')`);
  }
  /**
   * POLL ONLY THE AGENCIES THAT PUBLISH REALTIME.
   *
   * A poller for a schedule-only agency (Oakville, Milton, GO, UP Express — descriptors
   * with an empty `rt`) has nothing to poll, yet its boot still costs real memory and
   * real database scans: a full pattern index held for the process lifetime (GO alone is
   * 54k trip slots, UP Express 28k), a per-trip static-context map, and a fingerprint
   * pass over every one of the agency's stop_times rows (GO: 1.19M). Dropping the four
   * dead pollers removes that outright — though measurement (2026-07-27, Windows, ten
   * agencies) puts the remaining steady RSS at ~800 MiB, dominated by the fixed
   * node+tsx+PGlite floor plus the six live engines, so this alone does not fit the
   * 512 MB free instance; see render.yaml's memory note.
   *
   * Skipping them changes nothing a rider can observe: their boards are served entirely
   * from SQL (search, nearby, arrivals with bucket:'none', shapes), and /api/health's
   * `agencies` list still names them. It is also the honest shape — "we do not watch
   * this agency's vehicles" (r5gta plan §4.1) is a statement about observation, and a
   * poller that observes nothing while holding an index was form without substance.
   * If every enabled agency is schedule-only, the first still gets a poller: the API
   * needs one handle for health/mode, and its poll loop no-ops exactly as before. That
   * fallback also covers demo mode by construction — a demo process has exactly one
   * agency (the fixture's), so even a schedule-only fixture keeps its poller, which is
   * the source of the replayed bytes.
   */
  const observed = agencies.filter((a) => !isScheduleOnly(a));
  /**
   * GHOSTBUS_POLL_AGENCIES: comma list restricting which agencies get RT pollers — the
   * memory lever for small instances (each engine holds a pattern index; six of them
   * measured ~800 MiB total, over Render free's 512 MiB). Agencies excluded here still
   * seed and serve fully as schedule-only — the app's existing honest degradation —
   * so coverage (stops, boards, search, plan) is untouched; only live tracking narrows.
   */
  const pollFilter = (process.env.GHOSTBUS_POLL_AGENCIES ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const observedWanted = pollFilter.length > 0
    ? observed.filter((a) => pollFilter.includes(a.id))
    : observed;
  for (const id of pollFilter.filter((f) => !observed.some((a) => a.id === f))) {
    console.warn(`[boot] GHOSTBUS_POLL_AGENCIES entry '${id}' matches no enabled RT agency — ignored (check spelling/case; degradation is safe but silent otherwise)`);
  }
  const polled = observedWanted.length > 0 ? observedWanted : [agencies[0]];
  // Compared by id, not object identity, so this cannot silently misclassify if the
  // registry ever hands out copies instead of singletons.
  const polledIds = new Set(polled.map((a) => a.id));
  const unpolled = agencies.filter((a) => !polledIds.has(a.id));
  const pollers = polled.map((a) => createPoller(db, { source, agency: a }));
  console.log(`[boot] ${pollers.length} poller(s): ${polled.map((a) => a.id).join(', ')}` +
    (unpolled.length > 0 ? ` — not polled (schedule-only or filtered): ${unpolled.map((a) => a.id).join(', ')}` : ''));

  // Static reads are union-aware (agency = ANY over every seeded agency), but the
  // poller-scoped live bits — getVehicleStates, getLivePredictionMs, feed health — still
  // come from one poller. Handing the API the first is correct for single-agency and the
  // known gap for multi: the remaining pollers collect and store, their live surfaces
  // just aren't served yet (Phase 1 §2.7 follow-up).
  const poller = pollers[0];

  /**
   * BIND THE PORT BEFORE STARTING THE POLLERS — deploy-critical ordering.
   *
   * A poller's first act is `loadStaticContext()`, whose DISTINCT ON join reads every
   * stop_times row for its agency, and on embedded PGlite every query shares ONE
   * serialised connection. Starting the pollers first therefore parks that scan (tens of
   * seconds at full speed, minutes at a free tier's 0.1 CPU) in front of `buildApi`'s own
   * boot queries, and `app.listen` — and Render fails a deploy whose service never binds
   * its port in time. Listening first costs nothing: `/api/health` answers without the
   * database, and every poller-fed surface reports its honest warming-up state until the
   * background loads land.
   */
  const app = await buildApi({ db, poller });
  await app.listen({ port: PORT, host: HOST });
  console.log(`GhostBus API listening on http://${HOST}:${PORT}  (GET /api/health)`);

  /**
   * STAGGER THE CYCLES. Every poller runs a 45 s loop, and starting them in the same tick
   * means every 45 s the process decodes N feeds and runs N delay-engine passes in one
   * burst — the engine's crosswalk resolution is the expensive half — while `/api/vehicles`
   * waits behind it. Offsetting agency i by i*(POLL_MS/N) spreads the same work evenly.
   * With one agency the offset is 0 and the behaviour is exactly as before.
   */
  const POLL_MS = 45_000;
  const stagger = pollers.length > 1 ? Math.floor(POLL_MS / pollers.length) : 0;
  const staggerTimers: NodeJS.Timeout[] = [];
  pollers.forEach((p, i) => {
    if (i === 0 || stagger === 0) { p.start(); return; }
    const t = setTimeout(() => p.start(), i * stagger);
    t.unref?.();
    staggerTimers.push(t);
  });

  // Aggregation rebuilds agg_delay/agg_delay_route for the LIVE agency, so a demo process
  // must not run it: it would be a recorded-replay process rewriting live aggregates, and
  // a ten-minute recording could not honestly fill a fourteen-day window anyway. Demo
  // arrivals therefore fall back to schedule-only ETAs with bucket:'none', which is the
  // truthful answer to "what does history say" when there is no history.
  const aggTimer = demo ? null : startAggregation(db);

  let stopping = false;
  async function shutdown(sig: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    console.log(`\n[signal] ${sig} — shutting down…`);
    if (aggTimer) clearInterval(aggTimer);
    for (const t of staggerTimers) clearTimeout(t);
    // Every poller, not just the one the API reads from.
    await Promise.all(pollers.map((p) => p.stop()));
    try { await app.close(); } catch { /* ignore */ }
    try { await db.close(); } catch { /* ignore */ }
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Recycle write-ahead log segments.
 *
 * PGlite is Postgres compiled to WASM and run SINGLE-PROCESS: the background checkpointer
 * that a normal server runs does not exist, so nothing ever services the checkpoint request
 * `max_wal_size` raises. The GUC is set (1 GB, in the generated postgresql.conf) and is
 * simply never acted on — measured on ghostbus.tech, `pg_wal` reached 87 GB across 5,514
 * segments in 4.7 days of uptime, on a 96 GB disk, with not one segment recycled since boot.
 * The database itself was 2.1 GB. A clean shutdown fixed it in 3.2 seconds (PGlite's
 * `close()` runs the shutdown checkpoint), which is the whole diagnosis: checkpoints work,
 * nothing was asking for one.
 *
 * `ALTER SYSTEM SET` + `pg_reload_conf()` is not an alternative — verified locally against a
 * throwaway datadir, `SHOW max_wal_size` still reports the boot value afterwards, because
 * there is no postmaster to signal. An explicit statement on a timer is the only lever.
 *
 * Cheap, and cheapest exactly when it matters least: a checkpoint with nothing dirty to
 * flush is close to a no-op, so this costs nothing on a quiet instance and bounds `pg_wal`
 * at roughly one interval's writes (~800 MB/h measured) on a busy one. Postgres RECYCLES
 * rather than deletes, so the segment count plateaus instead of falling — that plateau is
 * the fix working, not a partial one.
 */
async function checkpoint(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  if (db.driver !== 'pglite') return; // a real server runs its own checkpointer
  await db.query('CHECKPOINT');
}

/**
 * Aggregate on boot (non-fatal if it fails) and then hourly in-process, and checkpoint the
 * WAL on the same tick — see `checkpoint` for why that is this process's job at all.
 */
function startAggregation(db: Awaited<ReturnType<typeof getDb>>): NodeJS.Timeout {
  runAggregationAll(db)
    .then((r) => console.log(`[aggregate] boot: agg_delay=${r.stopHourRows} agg_delay_route=${r.routeHourRows} from ${r.obsConsidered} obs (${(r.elapsedMs / 1000).toFixed(1)}s)`))
    .catch((e) => console.error('[aggregate] boot failed:', e));
  const t = setInterval(() => {
    runAggregationAll(db)
      .then((r) => console.log(`[aggregate] hourly: agg_delay=${r.stopHourRows} agg_delay_route=${r.routeHourRows} from ${r.obsConsidered} obs`))
      .catch((e) => console.error('[aggregate] hourly failed:', e));
    // Independent of the aggregation above: a failed aggregation must not cost the
    // instance its only WAL recycling, and vice versa.
    checkpoint(db)
      .then(() => console.log('[checkpoint] wal recycled'))
      .catch((e) => console.error('[checkpoint] failed:', e));
  }, AGG_INTERVAL_MS);
  t.unref?.();
  return t;
}

main().catch((e) => { console.error('API server FAILED:', e); process.exit(1); });
