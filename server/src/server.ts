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
import { demoRequested, bootDemoSource } from './demo.ts';
import { runAggregation } from './aggregate.ts';
import { buildApi } from './api.ts';

const PORT = Number(process.env.PORT) || 8799;
const HOST = process.env.HOST || '127.0.0.1';
const AGG_INTERVAL_MS = 60 * 60_000; // hourly

async function main(): Promise<void> {
  const demo = demoRequested();
  const source = demo ? await bootDemoSource() : undefined;

  const db = await getDb();
  console.log(`GhostBus API — driver=${db.driver}, mode=${demo ? 'DEMO (recorded replay)' : 'live'}`);

  const poller = createPoller(db, { source });
  poller.start();

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
    await poller.stop();
    try { await app.close(); } catch { /* ignore */ }
    try { await db.close(); } catch { /* ignore */ }
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/** Aggregate on boot (non-fatal if it fails) and then hourly in-process. */
function startAggregation(db: Awaited<ReturnType<typeof getDb>>): NodeJS.Timeout {
  runAggregation(db)
    .then((r) => console.log(`[aggregate] boot: agg_delay=${r.stopHourRows} agg_delay_route=${r.routeHourRows} from ${r.obsConsidered} obs (${(r.elapsedMs / 1000).toFixed(1)}s)`))
    .catch((e) => console.error('[aggregate] boot failed:', e));
  const t = setInterval(() => {
    runAggregation(db)
      .then((r) => console.log(`[aggregate] hourly: agg_delay=${r.stopHourRows} agg_delay_route=${r.routeHourRows} from ${r.obsConsidered} obs`))
      .catch((e) => console.error('[aggregate] hourly failed:', e));
  }, AGG_INTERVAL_MS);
  t.unref?.();
  return t;
}

main().catch((e) => { console.error('API server FAILED:', e); process.exit(1); });
