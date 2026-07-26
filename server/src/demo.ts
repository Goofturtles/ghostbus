// demo — Demo Mode replay source.
//
// Reads a fixture produced by record_demo.ts and hands the poller RAW recorded
// protobuf bytes on demand, decoded through the *identical*
// `transit_realtime.FeedMessage.decode` call the live fetch layer uses. Nothing here
// re-shapes the data: Demo Mode drives the real pipeline (join, ghost detection,
// aggregation, ETAs) over real recorded TTC traffic, so every feature works when the
// live feed is unreachable or the URL says ?demo=1.
//
// ============================ THE HONESTY CONTRACT ============================
// 1. DEMO AND LIVE DATA ARE NEVER MIXED. Demo Mode is all-or-nothing per process:
//    once `activateDemoMode()` is called, this process is a demo process for its
//    entire lifetime. There is deliberately no public way to switch back to live —
//    a process that has served one demo byte must never later claim to be live.
//    (Flip the mode by restarting with different config, not at runtime.)
// 2. EVERY RESULT IS LABELLED. Each fetch result carries `demo: true` and the frame's
//    real capture timestamp. Callers MUST propagate that to the UI: the persistent
//    amber DEMO badge, plus `manifest.recordedNotice` / `manifest.attribution`
//    wherever the data surfaces. This is replayed history, never "live".
// 3. THE CLOCK IS FAKE, THE DATA IS NOT. Replay runs at a speed multiplier (8x by
//    default) and loops. The vehicle positions, trip updates and alerts inside are
//    exactly what the TTC published during the capture window.
// ==============================================================================
//
// 4. THE DATA CLOCK MOVES WITH THE DATA. A demo source is not just bytes, it is bytes
//    *and the moment they were taken*. `dataNow()` returns the capture instant of the
//    frame being replayed, and the poller runs its whole cycle on it. Judging a recording
//    against the wall clock is not a cosmetic error: every trip in the recording would be
//    scheduled hours ago, absent from the current due window, and the ghost detector would
//    declare the entire network dead. See poller.ts, "TWO CLOCKS".
// 5. DEMO ROWS LIVE IN THEIR OWN NAMESPACE. Everything a demo process writes is tagged
//    `agency = 'ttc-demo'` (DEMO_AGENCY). The static schedule is read under 'ttc' because
//    a schedule is not an observation and there is only one published board. Rule 1 is
//    thereby enforced by the primary keys, not by convention.
//
// WIRING:
//   const source = await loadDemoSource();          // newest bundled fixture, 8x, looping
//   const poller = createPoller(db, { source });    // that is the entire integration
// `createPoller` needs nothing else: the source carries the bytes, the clock, the cadence
// and the namespace, and the poller never asks which mode it is in.

import { readFile, readdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import type { FeedId } from '../../shared/types.ts';
import type { DemoFixtureFile, DemoManifest, RecordedFrame } from './record_demo.ts';
import type { DemoModeInfo, PollerSource } from './poller.ts';
import { STATIC_AGENCY } from './poller.ts';
import { demoAgencyFor } from './agencies.ts';

const { transit_realtime } = GtfsRealtimeBindings;

/** Same decoded type the live poller works with. */
type FeedMessage = ReturnType<typeof transit_realtime.FeedMessage.decode>;

export const SUPPORTED_SCHEMA_VERSIONS = [1];
export const FIXTURE_KIND = 'ghostbus-demo-fixture';
export const DEFAULT_SPEED = 8;
/**
 * The namespace every row a demo process writes is tagged with. Deliberately NOT 'ttc':
 * one SELECT that forgets a WHERE clause is all it would take to publish recorded history
 * as live measurement, and there is no such SELECT if the rows are not there.
 *
 * NOTE FOR MULTI-AGENCY. This derives the demo namespace from the TTC because every
 * recorded fixture is currently a TTC capture. It is NOT the general answer: a fixture
 * recorded from another agency must be replayed under `demoAgencyFor(<that agency>)`, which
 * is why the helper takes an argument rather than being a constant. When fixtures grow an
 * agency field, read it from the fixture and pass it here.
 */
export const DEMO_AGENCY = demoAgencyFor(STATIC_AGENCY);
/** Where bundled fixtures live, relative to this file. */
const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/', import.meta.url));

/** A recorded frame with its payload already base64-decoded back to bytes. */
export interface DemoFrame extends Omit<RecordedFrame, 'payloadBase64'> {
  /** Raw GTFS-realtime protobuf bytes. null on a frame that recorded a failed poll. */
  bytes: Buffer | null;
  /**
   * The frame's slot on the replay timeline: `seq * cadenceMs`, NOT its raw `offsetMs`.
   *
   * `offsetMs` is the instant the response finished arriving, so it carries the recorder's
   * own fetch latency — 0.3 s to 1.5 s, different every cycle. Selecting frames by it puts
   * every frame just past the cadence tick a replaying poller lands on, which shifts the
   * whole replay one frame late and serves frame 0 twice per loop. The recorder polls on a
   * fixed grid it re-anchors every cycle (no drift), so `seq` is the frame's intended
   * position and network luck is not. The true capture instant is still carried, unaltered,
   * on `capturedAtMs` — it is the provenance, it is just not the clock.
   */
  slotMs: number;
}

export interface DemoFixture {
  manifest: DemoManifest;
  frames: DemoFrame[];
  /** Frames per feed, ascending by offsetMs. */
  byFeed: Record<FeedId, DemoFrame[]>;
  /**
   * Length of the replay loop. The last frame keeps its full cadence slot before the
   * timeline wraps, otherwise it would flash past in zero milliseconds.
   */
  timelineMs: number;
}

// ---------- loading ----------

function fail(msg: string): never {
  throw new Error(`demo fixture: ${msg}`);
}

/** Decode + validate a recorded fixture. Throws a clear error on anything malformed. */
export function parseFixture(gz: Buffer): DemoFixture {
  let bundle: DemoFixtureFile;
  try {
    bundle = JSON.parse(gunzipSync(gz).toString('utf8')) as DemoFixtureFile;
  } catch (e) {
    return fail(`unreadable (${e instanceof Error ? e.message : String(e)})`);
  }
  const manifest = bundle?.manifest;
  if (!manifest || typeof manifest !== 'object') fail('missing manifest');
  if (manifest.kind !== FIXTURE_KIND) fail(`wrong kind ${JSON.stringify(manifest.kind)}`);
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(manifest.schemaVersion)) {
    fail(`unsupported schemaVersion ${manifest.schemaVersion} (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})`);
  }
  if (!Array.isArray(bundle.frames) || bundle.frames.length === 0) fail('no frames');
  if (!(manifest.cadenceMs > 0)) fail('cadenceMs must be positive');
  if (!manifest.captureStartMs || !manifest.captureEndMs) fail('missing capture window');

  const frames: DemoFrame[] = bundle.frames.map((f, i) => {
    if (typeof f.offsetMs !== 'number' || !Number.isFinite(f.offsetMs)) fail(`frame ${i} has no offsetMs`);
    if (f.ok && !f.payloadBase64) fail(`frame ${i} is marked ok but carries no payload`);
    const { payloadBase64, ...rest } = f;
    // A fixture written before `seq` was trustworthy falls back to the raw offset rather
    // than being rejected: a slightly-shifted replay beats no replay.
    const slotMs = Number.isFinite(f.seq) && f.seq >= 0 ? f.seq * manifest.cadenceMs : f.offsetMs;
    return { ...rest, slotMs, bytes: payloadBase64 ? Buffer.from(payloadBase64, 'base64') : null };
  });

  const byFeed: Record<FeedId, DemoFrame[]> = { vehicles: [], trips: [], alerts: [] };
  for (const f of frames) {
    const bucket = byFeed[f.feed];
    if (!bucket) fail(`unknown feed ${JSON.stringify(f.feed)}`);
    bucket.push(f);
  }
  for (const id of Object.keys(byFeed) as FeedId[]) {
    byFeed[id].sort((a, b) => a.slotMs - b.slotMs);
  }

  const maxSlot = frames.reduce((m, f) => Math.max(m, f.slotMs), 0);
  return { manifest, frames, byFeed, timelineMs: maxSlot + manifest.cadenceMs };
}

/** Load a fixture from disk (gzipped JSON produced by record_demo.ts). */
export async function loadFixture(path: string): Promise<DemoFixture> {
  return parseFixture(await readFile(path));
}

/**
 * Which fixture a demo process replays: `GHOSTBUS_DEMO_FIXTURE` if set, otherwise the
 * lexicographically last `fixtures/*.json.gz`. The recorder's filenames are
 * `ttc-demo-YYYYMMDD-HHMM.json.gz`, so "last by name" is "most recent capture" — and it
 * is a pure function of the directory contents, which "most recently modified" is not
 * (a checkout or a copy rewrites mtimes and would silently change which demo ships).
 */
export async function resolveFixturePath(): Promise<string> {
  const override = process.env.GHOSTBUS_DEMO_FIXTURE?.trim();
  if (override) return resolve(override);
  let names: string[];
  try {
    names = (await readdir(FIXTURES_DIR)).filter((n) => n.endsWith('.json.gz')).sort();
  } catch (e) {
    throw new Error(`demo: cannot read ${FIXTURES_DIR} (${e instanceof Error ? e.message : String(e)})`);
  }
  if (names.length === 0) {
    throw new Error(`demo: no fixture in ${FIXTURES_DIR} — record one with: npm run record:demo`);
  }
  return resolve(FIXTURES_DIR, names[names.length - 1]);
}

// ---------- replay clock (pure math, exported so it is directly testable) ----------

export interface ReplayPosition {
  /** Position inside the recording, in recording-time ms. */
  timelineMs: number;
  /** How many times replay has wrapped around. 0 on the first pass. */
  loops: number;
  /** Only ever true when looping is disabled and the recording has run out. */
  finished: boolean;
  elapsedWallMs: number;
}

/**
 * Map elapsed wall-clock time onto the recording timeline.
 * `speed` is the multiplier (8 => 8 recorded minutes per wall minute).
 */
export function replayPositionAt(
  elapsedWallMs: number,
  speed: number,
  timelineMs: number,
  loop: boolean,
): ReplayPosition {
  const raw = Math.max(0, elapsedWallMs) * speed;
  if (!loop) {
    const finished = raw >= timelineMs;
    return { timelineMs: Math.min(raw, timelineMs), loops: 0, finished, elapsedWallMs };
  }
  return {
    timelineMs: raw % timelineMs,
    loops: Math.floor(raw / timelineMs),
    finished: false,
    elapsedWallMs,
  };
}

/**
 * Index of the frame that is *current* at recording-time `t`: the last frame whose
 * offset has already been reached. Before the first frame, the first frame stands in.
 */
export function frameIndexAt(offsets: readonly number[], t: number): number {
  if (offsets.length === 0) return -1;
  let idx = 0;
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] <= t) idx = i; else break;
  }
  return idx;
}

// ---------- the source ----------

export interface DemoSourceOptions {
  /** Replay speed multiplier. Default 8x. */
  speed?: number;
  /** Loop back to the start when the recording runs out. Default true. */
  loop?: boolean;
  /** Wall clock at which replay began. Defaults to now. */
  startedAtMs?: number;
  /** Injectable WALL clock, for tests. Never the data clock — that comes from the frames. */
  now?: () => number;
  /** Recorded provenance for the UI; purely informational. */
  fixturePath?: string;
}

interface DemoFetchBase {
  /** Always true. Callers MUST label this output as demo data. */
  demo: true;
  frame: DemoFrame | null;
}
export interface DemoFetchOk extends DemoFetchBase {
  status: 'ok';
  msg: FeedMessage;
  bytes: Buffer;
  frame: DemoFrame;
}
export interface DemoFetchError extends DemoFetchBase {
  status: 'error';
  reason: string;
}
/** Structurally matches the live poller's fetchFeed result, plus demo labelling. */
export type DemoFetchResult = DemoFetchOk | DemoFetchError;

/**
 * A recorded replay, shaped as a `PollerSource` so `createPoller(db, { source })` is the
 * whole integration. The extra members beyond PollerSource are for tests and diagnostics.
 */
export interface DemoSource extends PollerSource {
  readonly isDemo: true;
  readonly manifest: DemoManifest;
  readonly speed: number;
  readonly loop: boolean;
  /** Drop-in replacement for the poller's fetchFeed — no network, never throws. */
  fetchFeed(feed: FeedId): DemoFetchResult;
  /** Where replay currently is. Useful for the DEMO badge / diagnostics. */
  position(): ReplayPosition;
  /** The frame currently current for a feed, without decoding it. */
  currentFrame(feed: FeedId): DemoFrame | null;
}

export function createDemoSource(fixture: DemoFixture, options: DemoSourceOptions = {}): DemoSource {
  const speed = options.speed ?? DEFAULT_SPEED;
  const loop = options.loop ?? true;
  const now = options.now ?? (() => Date.now());
  const startedAtMs = options.startedAtMs ?? now();
  const fixturePath = options.fixturePath ?? null;
  if (!(speed > 0)) throw new Error(`demo: speed must be positive, got ${speed}`);

  const offsets: Record<FeedId, number[]> = {
    vehicles: fixture.byFeed.vehicles.map((f) => f.slotMs),
    trips: fixture.byFeed.trips.map((f) => f.slotMs),
    alerts: fixture.byFeed.alerts.map((f) => f.slotMs),
  };

  function position(): ReplayPosition {
    return replayPositionAt(now() - startedAtMs, speed, fixture.timelineMs, loop);
  }

  function currentFrame(feed: FeedId): DemoFrame | null {
    const list = fixture.byFeed[feed];
    const i = frameIndexAt(offsets[feed], position().timelineMs);
    return i < 0 ? null : (list[i] ?? null);
  }

  function fetchFeed(feed: FeedId): DemoFetchResult {
    const frame = currentFrame(feed);
    if (!frame) {
      return { status: 'error', demo: true, frame: null, reason: `demo fixture has no ${feed} frames` };
    }
    // A frame that recorded a real failed poll replays as a failed poll. Demo Mode
    // reproduces the hiccup rather than papering over it.
    if (!frame.ok || !frame.bytes) {
      return { status: 'error', demo: true, frame, reason: `recorded failure: ${frame.error ?? 'unknown'}` };
    }
    try {
      // The identical decode call the live fetch layer makes.
      const msg = transit_realtime.FeedMessage.decode(frame.bytes);
      return { status: 'ok', demo: true, frame, msg, bytes: frame.bytes };
    } catch (e) {
      return {
        status: 'error', demo: true, frame,
        reason: `undecodable recorded frame: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * The DATA clock: the capture instant of the frame currently being replayed, derived
   * from the replay position rather than read off a frame, so all three feeds agree on
   * "now" even when their frames were written milliseconds apart.
   */
  function dataNow(): number {
    return fixture.manifest.captureStartMs + position().timelineMs;
  }

  function describe(): DemoModeInfo {
    const p = position();
    const m = fixture.manifest;
    return {
      fixturePath,
      recordedNotice: m.recordedNotice,
      attribution: m.attribution,
      captureStartMs: m.captureStartMs,
      captureEndMs: m.captureEndMs,
      captureStartToronto: m.captureStartToronto,
      captureEndToronto: m.captureEndToronto,
      cadenceMs: m.cadenceMs,
      speed,
      loop,
      positionMs: p.timelineMs,
      loops: p.loops,
    };
  }

  return {
    mode: 'demo',
    agency: DEMO_AGENCY,
    // Poll once per recorded frame: at 8x, a 45s capture cadence is a 5.625s poll. Leaving
    // the poller on its 45s live cadence would show one recorded frame in every eight and
    // call it a replay.
    pollMs: Math.max(1, Math.round(fixture.manifest.cadenceMs / speed)),
    dataNow,
    fetch: fetchFeed,
    describe,
    isDemo: true,
    manifest: fixture.manifest,
    speed,
    loop,
    fetchFeed,
    position,
    currentFrame,
  };
}

/**
 * The one call a demo process makes: resolve the bundled fixture, build the replay source
 * at the spec's 8x, and latch this process into Demo Mode. Hand the result to
 * `createPoller(db, { source })`.
 */
export async function loadDemoSource(
  options: DemoSourceOptions = {},
): Promise<DemoSource> {
  const path = options.fixturePath ?? (await resolveFixturePath());
  const fixture = await loadFixture(path);
  const source = createDemoSource(fixture, { ...options, fixturePath: path });
  activateDemoMode(source);
  return source;
}

/** `--demo` on the command line, or GHOSTBUS_DEMO=1 in the environment. */
export function demoRequested(
  argv: readonly string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return argv.includes('--demo') || env.GHOSTBUS_DEMO === '1';
}

/**
 * Load the recorded source and announce it loudly on stdout. Throws when there is no
 * fixture: a demo that boots with nothing to replay would be worse than one that refuses.
 */
export async function bootDemoSource(options: DemoSourceOptions = {}): Promise<DemoSource> {
  const source = await loadDemoSource(options);
  const d = source.describe();
  const mins = ((d.captureEndMs - d.captureStartMs) / 60_000).toFixed(1);
  console.log('');
  console.log('  ##  DEMO MODE — replaying a recording. NOTHING here is live.  ##');
  console.log(`  fixture   ${d.fixturePath}`);
  console.log(`  captured  ${d.captureStartToronto}  ..  ${d.captureEndToronto}  (${mins} min)`);
  console.log(`  replay    ${d.speed}x${d.loop ? ', looping' : ''}, ${(source.pollMs / 1000).toFixed(3)}s per recorded frame`);
  console.log(`  writes    agency='${source.agency}' — no live observation is read or written`);
  console.log(`  shares    the static GTFS board, and its derived pattern-index cache, under 'ttc'`);
  console.log(`  ${d.attribution}`);
  console.log('');
  return source;
}

// ---------- the all-or-nothing latch ----------
//
// Module-level on purpose. Demo Mode is a property of the whole process, not of a
// request: if any part of this process is serving recorded data, all of it is. That
// makes "never blend demo and live data" structurally true instead of a convention
// every future call site has to remember.

let activeSource: DemoSource | null = null;

/** Latch this process into Demo Mode. Idempotent for the same source; never reversible. */
export function activateDemoMode(source: DemoSource): void {
  if (activeSource && activeSource !== source) {
    throw new Error('demo: Demo Mode is already active with a different source — one source per process');
  }
  activeSource = source;
}

/** True once this process has been latched into Demo Mode. */
export function isDemoActive(): boolean {
  return activeSource !== null;
}

/** The latched source, or null when running live. */
export function activeDemoSource(): DemoSource | null {
  return activeSource;
}

/**
 * TEST ONLY. Production code must never call this: releasing the latch is exactly the
 * demo/live blending the contract above forbids.
 */
export function __resetDemoModeForTests(): void {
  activeSource = null;
}
