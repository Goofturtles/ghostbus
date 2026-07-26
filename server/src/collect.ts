// collect — standalone GTFS-realtime collector, one poller per enabled agency.
//
// Thin wrapper around the shared poller (server/src/poller.ts). The poll cycle,
// in-memory stores, identity join, ghost detection, and all honesty guards live in
// the poller module; the API server runs the same poller in-process. This wrapper
// exists so `npm run collect` still runs the collector as its own process (e.g. a
// detached background collector), honouring GHOSTBUS_MAX_CYCLES (0 = run forever).
//
// `--demo` (or GHOSTBUS_DEMO=1) runs the same collector over the recorded fixture instead
// of the network — useful for driving the pipeline end to end without touching the TTC,
// and for the same reasons the API server supports it. Demo rows are written under
// agency='ttc-demo'; the live namespace is never touched.

import { getDb } from './db.ts';
import { createPoller } from './poller.ts';
import { demoRequested, bootDemoSource } from './demo.ts';
import { enabledAgencies, agency as agencyOf } from './agencies.ts';

const MAX_CYCLES = Number(process.env.GHOSTBUS_MAX_CYCLES ?? 0);

async function main(): Promise<void> {
  const demo = demoRequested();
  const source = demo ? await bootDemoSource() : undefined;

  const db = await getDb();
  const cadence = source ? `${(source.pollMs / 1000).toFixed(3)}s (replay)` : '45s';
  console.log(`GhostBus collector — driver=${db.driver}, mode=${demo ? 'DEMO (recorded replay)' : 'live'}, poll=${cadence}${MAX_CYCLES ? `, max cycles=${MAX_CYCLES}` : ''}`);

  // One poller per enabled agency, same as the API server. Demo replays one agency,
  // because a fixture is a recording of one agency's feeds.
  // The fixture decides which agency is replayed — see the long note in server.ts.
  const agencies = demo && source ? [agencyOf(source.agency.replace(/-demo$/, ''))] : enabledAgencies();
  console.log(`  agencies: ${agencies.map((a) => a.id).join(', ')}`);
  const pollers = agencies.map((a) => createPoller(db, {
    source,
    agency: a,
    maxCycles: MAX_CYCLES,
    // With several pollers the first to finish its bounded run would otherwise tear the
    // whole process down under the others. Only exit once every poller has finished.
    onExit: () => { if (++finished >= pollers.length) void shutdown(0); },
  }));
  let finished = 0;

  let stopping = false;
  async function shutdown(code: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    console.log('\n[shutdown] stopping poller + closing database…');
    await Promise.all(pollers.map((p) => p.stop()));
    try { await db.close(); } catch { /* ignore */ }
    process.exit(code);
  }
  process.on('SIGINT', () => { console.log('\n[signal] SIGINT'); void shutdown(0); });
  process.on('SIGTERM', () => { console.log('\n[signal] SIGTERM'); void shutdown(0); });

  for (const p of pollers) p.start();
}

main().catch((e) => { console.error('collector FAILED:', e); process.exit(1); });
