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
import { enabledAgencies, agency as agencyOf } from './agencies.ts';
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
   * REFUSE EARLY, BEFORE ANY WORK. The API read path still serves exactly one agency
   * (Phase 1 lands the union queries), so booting with several would poll and store every
   * agency while showing riders only the first — coverage silently halved. `buildApi`
   * enforces this too, but by then N pollers have started and run their heavy static
   * loads; failing here keeps the message the first thing that happens.
   */
  if (!demo && enabled.length > 1) {
    throw new Error(
      `GHOSTBUS_AGENCIES lists ${enabled.length} agencies (${enabled.map((a) => a.id).join(', ')}), ` +
      `but the API read path still serves exactly one. Booting would poll and store every agency ` +
      `while showing riders only the first — coverage silently halved. ` +
      `Run with a single agency until the Phase 1 union queries land.`,
    );
  }

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
  const pollers = agencies.map((a) => createPoller(db, { source, agency: a }));
  console.log(`[boot] ${pollers.length} poller(s): ${agencies.map((a) => a.id).join(', ')}`);

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

  // The API is still single-agency on its read path (Phase 1 lands the union queries), so
  // it is handed the first poller. `buildApi` refuses to boot if that would under-serve.
  const poller = pollers[0];

  // Aggregation rebuilds agg_delay/agg_delay_route for the LIVE agency, so a demo process
  // must not run it: it would be a recorded-replay process rewriting live aggregates, and
  // a ten-minute recording could not honestly fill a fourteen-day window anyway. Demo
  // arrivals therefore fall back to schedule-only ETAs with bucket:'none', which is the
  // truthful answer to "what does history say" when there is no history.
  const aggTimer = demo ? null : startAggregation(db);

  const app = await buildApi({ db, poller });
  await app.listen({ port: PORT, host: HOST });
  console.log(`GhostBus API listening on http://${HOST}:${PORT}  (GET /api/health)`);

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

/** Aggregate on boot (non-fatal if it fails) and then hourly in-process. */
function startAggregation(db: Awaited<ReturnType<typeof getDb>>): NodeJS.Timeout {
  runAggregationAll(db)
    .then((r) => console.log(`[aggregate] boot: agg_delay=${r.stopHourRows} agg_delay_route=${r.routeHourRows} from ${r.obsConsidered} obs (${(r.elapsedMs / 1000).toFixed(1)}s)`))
    .catch((e) => console.error('[aggregate] boot failed:', e));
  const t = setInterval(() => {
    runAggregationAll(db)
      .then((r) => console.log(`[aggregate] hourly: agg_delay=${r.stopHourRows} agg_delay_route=${r.routeHourRows} from ${r.obsConsidered} obs`))
      .catch((e) => console.error('[aggregate] hourly failed:', e));
  }, AGG_INTERVAL_MS);
  t.unref?.();
  return t;
}

main().catch((e) => { console.error('API server FAILED:', e); process.exit(1); });
