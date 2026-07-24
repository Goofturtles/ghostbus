// server — the single deployable GhostBus service.
//
// Boots the database (running migrations), starts the GTFS-realtime poller in-process
// (per the spec: one process, not a separate collector), runs the delay aggregation on
// boot + hourly, and serves the JSON API (and, in production, the built web app).
//
//   npm run dev    -> tsx watch server/src/server.ts
//   npm start      -> node --import tsx server/src/server.ts

import { getDb } from './db.ts';
import { createPoller } from './poller.ts';
import { runAggregation } from './aggregate.ts';
import { buildApi } from './api.ts';

const PORT = Number(process.env.PORT) || 8799;
const HOST = process.env.HOST || '127.0.0.1';
const AGG_INTERVAL_MS = 60 * 60_000; // hourly

async function main(): Promise<void> {
  const db = await getDb();
  console.log(`GhostBus API — driver=${db.driver}`);

  const poller = createPoller(db);
  poller.start();

  // Aggregate on boot (non-fatal if it fails) and then hourly in-process.
  runAggregation(db)
    .then((r) => console.log(`[aggregate] boot: agg_delay=${r.stopHourRows} agg_delay_route=${r.routeHourRows} from ${r.obsConsidered} obs (${(r.elapsedMs / 1000).toFixed(1)}s)`))
    .catch((e) => console.error('[aggregate] boot failed:', e));
  const aggTimer = setInterval(() => {
    runAggregation(db)
      .then((r) => console.log(`[aggregate] hourly: agg_delay=${r.stopHourRows} agg_delay_route=${r.routeHourRows} from ${r.obsConsidered} obs`))
      .catch((e) => console.error('[aggregate] hourly failed:', e));
  }, AGG_INTERVAL_MS);
  aggTimer.unref?.();

  const app = await buildApi({ db, poller });
  await app.listen({ port: PORT, host: HOST });
  console.log(`GhostBus API listening on http://${HOST}:${PORT}  (GET /api/health)`);

  let stopping = false;
  async function shutdown(sig: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    console.log(`\n[signal] ${sig} — shutting down…`);
    clearInterval(aggTimer);
    await poller.stop();
    try { await app.close(); } catch { /* ignore */ }
    try { await db.close(); } catch { /* ignore */ }
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => { console.error('API server FAILED:', e); process.exit(1); });
