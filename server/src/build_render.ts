// build_render — bake the database at BUILD time so a free-tier boot restores instead of
// working.
//
// THE DEPLOY THIS EXISTS FOR. Render's free tier has no free Postgres, 512 MB of RAM,
// 0.1 CPU, and an ephemeral disk that resets to the *built image* on every spin-down wake.
// Its build machines, by contrast, are full-speed and time-generous. So everything heavy
// happens here, once, at build:
//
//   1. every agency's static GTFS is downloaded and seeded into ONE PGlite directory,
//      `.data/pglite-render` (db.ts boots from it automatically when PGLITE_DIR is unset);
//   2. every agency's pattern-index cache blob is prebuilt into BOTH tiers — the
//      `.data/pattern-cache/<agency>-<fingerprint>.gbpx` file and the
//      `pattern_index_cache` row inside that same PGlite directory — so a runtime boot
//      restores each index in ~0.3-0.6 s instead of rebuilding it from millions of
//      stop_times rows (DECISIONS §36: the rebuild is the dominant boot cost, ~200 s for
//      the TTC at full speed, and the free runtime is 0.1 CPU).
//
// Because the baked directory ships inside the image, every cold wake starts from this
// exact seeded state. That also means runtime-accumulated observations (trip_delay_obs,
// ghosts) do NOT survive a wake — the honest cost of a $0 deploy, stated in render.yaml.
//
// WHICH AGENCIES. `GHOSTBUS_AGENCIES` (the same variable the server reads), or EVERY
// registry agency when it is unset. Note the deliberate difference from the server's
// default: `enabledAgencies()` defaults to TTC-only so a bare local run stays what it
// always was, but a BUILD bakes everything it could be asked to serve — baking too much
// costs disk, while baking too little means a runtime agency with an empty board. On
// Render the env var is set once and reaches build and runtime alike, so the two sets
// cannot diverge within one deploy.
//
// FAILS LOUDLY, by design: an unknown agency id, a failed download, a seed that loads
// zero stops or trips, a board that yields no tag, a fingerprint that cannot be taken, or
// a cache blob that does not restore — each one aborts the build with a non-zero exit.
// A half-baked image that boots into a half-empty app is precisely what this script
// exists to make impossible.
//
// Idempotent: the seeder is a per-agency DELETE + INSERT (verified in DECISIONS §43) and
// the index cache is keyed by content fingerprint, so re-running converges on the same
// state.
//
//   npm run build:render      (npm ci + vite build + this script — what Render runs)
//   npx tsx server/src/build_render.ts   (just the bake, against an existing install)
//
// Run locally, the baked directory is INERT: db.ts only prefers .data/pglite-render when
// the RENDER env var is present (Render sets it everywhere), so a local bake can never
// silently repoint `npm run dev` / collect / demo away from .data/pglite — nor race a
// re-bake against a dev server holding the single-writer directory. To boot against a
// local bake deliberately, set PGLITE_DIR to it (with nothing else holding it open).

import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgliteDb, type Db } from './db.ts';
import { allAgencies, agency as agencyById, type AgencyDescriptor } from './agencies.ts';
import { boardSpan, type CalendarRow, type CalendarDateRow } from './gtfs.ts';
import {
  boardFingerprint, loadOrBuildPatternIndex, persistPatternIndex, PATTERN_CACHE_FORMAT,
} from './patterns.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

/** The one directory a Render boot looks for (db.ts) when PGLITE_DIR is unset. */
export const RENDER_PGLITE_DIR = join(ROOT, '.data', 'pglite-render');

/**
 * Which agencies this build bakes. Exported pure so the parsing is testable: unset,
 * blank, or a value that parses to zero ids means EVERY registry agency (see the header
 * for why that differs from the server's TTC-only default — baking a superset of what is
 * served is safe; the reverse is a half-empty app); an explicit list is trimmed, deduped
 * and order-preserving; an unknown id throws — a typo that silently halved coverage
 * would defeat the bake.
 */
export function agenciesForBuild(raw: string | undefined): readonly AgencyDescriptor[] {
  const trimmed = raw?.trim();
  if (!trimmed) return allAgencies();
  const out: AgencyDescriptor[] = [];
  const seen = new Set<string>();
  for (const id of trimmed.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(agencyById(id)); // throws on an unknown id
  }
  return out.length > 0 ? out : allAgencies();
}

/**
 * Seed one agency as a CHILD PROCESS rather than an import. The seeder resolves its
 * agency and opens its database at module scope, so a child per agency is the shape it
 * already has — and it guarantees each seed opens and cleanly closes the single-writer
 * PGlite directory before the next one (or this process) touches it.
 */
function seedOne(id: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(ROOT, 'server', 'src', 'seed_toronto.ts'), `--agency=${id}`],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: {
          ...process.env,
          // EMPTY STRING, NOT deleted. `process.loadEnvFile` does not overwrite a variable
          // that is already present — including one set to '' — and db.ts branches on
          // truthiness, so this is what guarantees the seed lands in PGlite even on a
          // machine whose .env carries a real DATABASE_URL (DECISIONS §37/§41). Deleting
          // the variable instead would let .env put Neon straight back.
          DATABASE_URL: '',
          PGLITE_DIR: RENDER_PGLITE_DIR,
        },
      },
    );
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`seed for '${id}' failed (${signal ?? `exit ${code}`}) — refusing to bake a partial image`));
    });
  });
}

interface BakeReport {
  agency: string;
  boardTag: string;
  /** 'build' on a first bake; 'cache-file' when an idempotent re-bake restored instead. */
  source: string;
  stops: number;
  trips: number;
  patterns: number;
  buildMs: number;
  restoreMs: number;
}

/**
 * Prebuild one agency's pattern index and PROVE the bake took: build + persist through
 * the exact runtime path (`loadOrBuildPatternIndex`), then call it again and require a
 * file-tier restore. `persistPatternIndex` deliberately never throws — a runtime cache
 * write failure costs the next boot, not correctness — so the re-read is the only thing
 * that turns "the cache silently failed to land" into a build failure, which at 0.1
 * runtime CPU it must be.
 */
async function prebuildIndex(db: Db, id: string): Promise<BakeReport> {
  const one = async (sql: string): Promise<number> =>
    Number((await db.query<{ n: string }>(sql, [id])).rows[0].n);
  const stops = await one('SELECT COUNT(*)::text AS n FROM stops WHERE agency=$1');
  const trips = await one('SELECT COUNT(*)::text AS n FROM trips WHERE agency=$1');
  if (stops === 0 || trips === 0) {
    throw new Error(`agency '${id}' seeded ${stops} stops / ${trips} trips — an empty board must fail the build`);
  }

  // The board tag, derived exactly as the runtime derives it (poller.ts
  // loadStaticContext): calendar ∪ calendar_dates through boardSpan. Matching by
  // construction is what makes the cache key we bake the key the boot will ask for.
  const calendar: CalendarRow[] = (await db.query<{ service_id: string; mon: boolean; tue: boolean; wed: boolean; thu: boolean; fri: boolean; sat: boolean; sun: boolean; start_date: number; end_date: number }>(
    'SELECT service_id, mon, tue, wed, thu, fri, sat, sun, start_date, end_date FROM calendar WHERE agency=$1', [id])).rows
    .map((r) => ({ service_id: r.service_id, days: [r.mon, r.tue, r.wed, r.thu, r.fri, r.sat, r.sun] as CalendarRow['days'], start_date: Number(r.start_date), end_date: Number(r.end_date) }));
  const calendarDates: CalendarDateRow[] = (await db.query<{ service_id: string; date: number; exception_type: number }>(
    'SELECT service_id, date, exception_type FROM calendar_dates WHERE agency=$1', [id])).rows
    .map((r) => ({ service_id: r.service_id, date: Number(r.date), exception_type: Number(r.exception_type) }));
  const span = boardSpan(calendar, calendarDates);
  if (!span) throw new Error(`agency '${id}' has no derivable board span — its index cache could never be keyed`);
  const boardTag = `${span.first}..${span.last}`;

  const fingerprint = await boardFingerprint(db, id);
  if (!fingerprint) {
    throw new Error(`agency '${id}': board fingerprint unavailable — nothing could be cached and every boot would rebuild`);
  }

  const t0 = Date.now();
  const idx = await loadOrBuildPatternIndex(db, id, boardTag, fingerprint);
  const buildMs = Date.now() - t0;   // on an idempotent re-bake this is a restore, not a build — the log carries idx.source
  if (idx.fingerprint !== fingerprint) {
    throw new Error(`agency '${id}': board changed while its index was building — nothing else writes during a bake, so this is a real fault`);
  }
  if (idx.slotsByTrip.size === 0) {
    throw new Error(`agency '${id}': pattern index holds zero trips against ${trips} seeded — refusing to cache it`);
  }

  // ENFORCE BOTH TIERS. A fresh build persists file + database together, but a re-bake
  // whose first call restored from a pre-existing .gbpx never reaches persist, and
  // `persistPatternIndex` itself deliberately never throws (a runtime cache miss costs
  // the next boot, not correctness — a BUILD cache miss costs every boot, so here it is
  // a failure). If the row is absent, persist explicitly and require it to land.
  const dbTier = async (): Promise<boolean> =>
    (await db.query(
      'SELECT 1 FROM pattern_index_cache WHERE agency=$1 AND fingerprint=$2 AND format=$3',
      [id, fingerprint, PATTERN_CACHE_FORMAT],
    )).rows.length > 0;
  if (!(await dbTier())) {
    await persistPatternIndex(db, id, idx);
    if (!(await dbTier())) {
      throw new Error(`agency '${id}': pattern_index_cache row did not land in the baked database`);
    }
  }

  const t1 = Date.now();
  const again = await loadOrBuildPatternIndex(db, id, boardTag, fingerprint);
  const restoreMs = Date.now() - t1;
  if (again.source !== 'cache-file') {
    throw new Error(`agency '${id}': index did not restore from the baked file cache (source=${again.source}) — the bake did not land`);
  }
  return { agency: id, boardTag, source: idx.source, stops, trips, patterns: idx.patterns.size, buildMs, restoreMs };
}

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    try { total += (await stat(join(e.parentPath, e.name))).size; } catch { /* file vanished mid-walk */ }
  }
  return total;
}

async function main(): Promise<void> {
  const started = Date.now();
  const agencies = agenciesForBuild(process.env.GHOSTBUS_AGENCIES);
  console.log(`GhostBus render bake — ${agencies.length} agenc${agencies.length === 1 ? 'y' : 'ies'}: ${agencies.map((a) => a.id).join(', ')}`);
  console.log(`  target: ${RENDER_PGLITE_DIR}`);

  // Sequential on purpose: PGlite is single-writer, and one loud failure should stop the
  // build before the next agency spends minutes downloading.
  for (const [i, a] of agencies.entries()) {
    console.log(`\n===== [${i + 1}/${agencies.length}] seed ${a.id} (${a.name}) =====`);
    await seedOne(a.id);
  }

  console.log('\n===== prebuild pattern-index caches =====');
  const db = await createPgliteDb(RENDER_PGLITE_DIR);
  const reports: BakeReport[] = [];
  try {
    for (const a of agencies) {
      console.log(`\n--- ${a.id} ---`);
      const r = await prebuildIndex(db, a.id);
      console.log(`  ${r.agency}: board ${r.boardTag}, ${r.patterns} patterns / ${r.trips} trips, ` +
        `${r.source === 'build' ? 'built+cached' : `already baked (${r.source})`} in ${(r.buildMs / 1000).toFixed(1)}s, ` +
        `restore proof ${r.restoreMs} ms`);
      reports.push(r);
    }
    // Flush WAL into the heap files so the image carries data pages, not replay work.
    await db.query('CHECKPOINT');
  } finally {
    await db.close();
  }

  const bytes = await dirSizeBytes(RENDER_PGLITE_DIR);
  console.log('\n================ RENDER BAKE COMPLETE ================');
  console.log(`elapsed        : ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`pglite dir     : ${RENDER_PGLITE_DIR} (${(bytes / 1_073_741_824).toFixed(2)} GiB)`);
  for (const r of reports) {
    console.log(`  ${r.agency.padEnd(11)} board ${r.boardTag}  stops=${r.stops}  trips=${r.trips}  ` +
      `patterns=${r.patterns}  index build ${(r.buildMs / 1000).toFixed(1)}s / restore ${r.restoreMs} ms`);
  }
  console.log('======================================================');
}

// Run only when executed directly, so the test can import `agenciesForBuild` without
// triggering a bake. Same resolve()-comparison pattern as seed_toronto.ts and
// aggregate.ts, so every entrypoint in this repo answers "am I the main module?" one way.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error('render bake FAILED:', e);
    process.exit(1);
  });
}
