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
// WIRING (for the integration agent — this module wires into nothing by itself):
//   const fixture = await loadFixture('fixtures/ttc-demo-<stamp>.json.gz');
//   const source  = createDemoSource(fixture, { speed: 8, loop: true });
//   activateDemoMode(source);
//   // then, inside poller.ts fetchFeed(key), before any network call:
//   //   if (isDemoActive()) return activeDemoSource()!.fetchFeed(key);
//   // The returned object is `{ status:'ok', msg }` / `{ status:'error', reason }`,
//   // structurally identical to what fetchFeed already returns.

import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import type { FeedId } from '../../shared/types.ts';
import type { DemoFixtureFile, DemoManifest, RecordedFrame } from './record_demo.ts';

const { transit_realtime } = GtfsRealtimeBindings;

/** Same decoded type the live poller works with. */
type FeedMessage = ReturnType<typeof transit_realtime.FeedMessage.decode>;

export const SUPPORTED_SCHEMA_VERSIONS = [1];
export const FIXTURE_KIND = 'ghostbus-demo-fixture';
export const DEFAULT_SPEED = 8;

/** A recorded frame with its payload already base64-decoded back to bytes. */
export interface DemoFrame extends Omit<RecordedFrame, 'payloadBase64'> {
  /** Raw GTFS-realtime protobuf bytes. null on a frame that recorded a failed poll. */
  bytes: Buffer | null;
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
    return { ...rest, bytes: payloadBase64 ? Buffer.from(payloadBase64, 'base64') : null };
  });

  const byFeed: Record<FeedId, DemoFrame[]> = { vehicles: [], trips: [], alerts: [] };
  for (const f of frames) {
    const bucket = byFeed[f.feed];
    if (!bucket) fail(`unknown feed ${JSON.stringify(f.feed)}`);
    bucket.push(f);
  }
  for (const id of Object.keys(byFeed) as FeedId[]) {
    byFeed[id].sort((a, b) => a.offsetMs - b.offsetMs);
  }

  const maxOffset = frames.reduce((m, f) => Math.max(m, f.offsetMs), 0);
  return { manifest, frames, byFeed, timelineMs: maxOffset + manifest.cadenceMs };
}

/** Load a fixture from disk (gzipped JSON produced by record_demo.ts). */
export async function loadFixture(path: string): Promise<DemoFixture> {
  return parseFixture(await readFile(path));
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
  /** Injectable clock, for tests. */
  now?: () => number;
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

export interface DemoSource {
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
  if (!(speed > 0)) throw new Error(`demo: speed must be positive, got ${speed}`);

  const offsets: Record<FeedId, number[]> = {
    vehicles: fixture.byFeed.vehicles.map((f) => f.offsetMs),
    trips: fixture.byFeed.trips.map((f) => f.offsetMs),
    alerts: fixture.byFeed.alerts.map((f) => f.offsetMs),
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

  return { isDemo: true, manifest: fixture.manifest, speed, loop, fetchFeed, position, currentFrame };
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
