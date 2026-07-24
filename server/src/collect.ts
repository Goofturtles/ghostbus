// collect — standalone GTFS-realtime collector for the TTC.
//
// Thin wrapper around the shared poller (server/src/poller.ts). The poll cycle,
// in-memory stores, identity join, ghost detection, and all honesty guards live in
// the poller module; the API server runs the same poller in-process. This wrapper
// exists so `npm run collect` still runs the collector as its own process (e.g. a
// detached background collector), honouring GHOSTBUS_MAX_CYCLES (0 = run forever).

import { getDb } from './db.ts';
import { createPoller } from './poller.ts';

const MAX_CYCLES = Number(process.env.GHOSTBUS_MAX_CYCLES ?? 0);

async function main(): Promise<void> {
  const db = await getDb();
  console.log(`GhostBus collector — driver=${db.driver}, poll=45s${MAX_CYCLES ? `, max cycles=${MAX_CYCLES}` : ''}`);

  const poller = createPoller(db, {
    maxCycles: MAX_CYCLES,
    onExit: () => { void shutdown(0); },
  });

  let stopping = false;
  async function shutdown(code: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    console.log('\n[shutdown] stopping poller + closing database…');
    await poller.stop();
    try { await db.close(); } catch { /* ignore */ }
    process.exit(code);
  }
  process.on('SIGINT', () => { console.log('\n[signal] SIGINT'); void shutdown(0); });
  process.on('SIGTERM', () => { console.log('\n[signal] SIGTERM'); void shutdown(0); });

  poller.start();
}

main().catch((e) => { console.error('collector FAILED:', e); process.exit(1); });
