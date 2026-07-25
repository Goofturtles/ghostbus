// record_demo — the Demo Mode RECORDER.
//
// Captures a real slice of live TTC GTFS-realtime data into a bundled fixture so that
// Demo Mode can replay genuine transit data through the identical pipeline when the
// live feed is unreachable (or when the URL says ?demo=1). This is judge-proofing:
// the app is never dead, and it never pretends a recording is live.
//
// HOW TO RUN (no npm script exists yet — package.json is owned by another agent):
//
//   npx tsx server/src/record_demo.ts
//
// with optional flags (defaults shown):
//
//   npx tsx server/src/record_demo.ts --minutes=10 --cadence-ms=45000 --out=fixtures/<auto>.json.gz
//
// The suggested npm script for a later agent to add is:
//   "record:demo": "tsx server/src/record_demo.ts"
//
// WHAT IT STORES — and why it stores it that way:
//   RAW protobuf bytes, base64-encoded, one payload per feed per cycle. It deliberately
//   does NOT parse the feeds into our own shapes: replay must run through the exact same
//   `transit_realtime.FeedMessage.decode` path the live poller uses, so the fixture has
//   to be bytes, not pre-chewed objects. Every frame carries its real wall-clock capture
//   time, and the manifest carries the capture window in both UTC and America/Toronto.
//
// TWO DELIBERATE DIFFERENCES FROM THE LIVE POLLER'S FETCH LAYER:
//   1. No conditional requests. The poller sends If-None-Match / If-Modified-Since and is
//      happy with a 304; the recorder must never get a 304, because a 304 has no payload
//      and would leave a hole in the recording.
//   2. A failed poll is recorded, not retried-with-backoff. A frame that failed is written
//      with an error marker so replay reproduces the real-world hiccup faithfully instead
//      of silently pretending the feed was fine.

import { gzipSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { torontoParts } from './tz.ts';
import type { FeedId } from '../../shared/types.ts';

const { transit_realtime } = GtfsRealtimeBindings;

// Duplicated from poller.ts on purpose: poller.ts does not export FEEDS, and importing it
// would drag the database layer into a script that must run with no database at all.
const FEEDS: Record<FeedId, string> = {
  vehicles: 'https://bustime.ttc.ca/gtfsrt/vehicles',
  trips: 'https://bustime.ttc.ca/gtfsrt/trips',
  alerts: 'https://bustime.ttc.ca/gtfsrt/alerts',
};
const FEED_IDS: FeedId[] = ['vehicles', 'trips', 'alerts'];

const DEFAULT_MINUTES = 10;
const DEFAULT_CADENCE_MS = 45_000;      // production poll cadence
const MIN_CADENCE_MS = 5_000;           // politeness floor for a public agency feed
const REQUEST_TIMEOUT_MS = 10_000;      // same timeout the live poller uses
const SIZE_WARN_BYTES = 25 * 1024 * 1024;

export const FIXTURE_SCHEMA_VERSION = 1;
export const FIXTURE_KIND = 'ghostbus-demo-fixture';
export const TTC_ATTRIBUTION =
  'Real-time data from the Toronto Transit Commission (bustime.ttc.ca GTFS-realtime). ' +
  'Contains information licensed under the Open Government Licence – Toronto.';

/** One feed, one cycle. `ok:false` frames are real failures preserved on purpose. */
export interface RecordedFrame {
  feed: FeedId;
  /** 0-based cycle index. All three feeds share a cycle number. */
  seq: number;
  /** Real wall clock when the response finished arriving. */
  capturedAtMs: number;
  capturedAtIso: string;
  capturedAtToronto: string;
  /** ms since capture start — this is the replay timeline coordinate. */
  offsetMs: number;
  ok: boolean;
  httpStatus: number | null;
  byteLength: number | null;
  /** Raw GTFS-realtime protobuf bytes, base64. null on a failed poll. */
  payloadBase64: string | null;
  /** Error marker for a failed poll. null when ok. */
  error: string | null;
  fetchMs: number;
}

export interface FeedManifestEntry {
  url: string;
  frames: number;
  okFrames: number;
  errorFrames: number;
  totalBytes: number;
}

export interface DemoManifest {
  schemaVersion: number;
  kind: string;
  agency: 'ttc';
  timezone: 'America/Toronto';
  /** Attribution string that must surface anywhere this data is shown. */
  attribution: string;
  /** Human-readable provenance. Surfaces under the DEMO badge — never call this live. */
  recordedNotice: string;
  captureStartMs: number;
  captureStartIso: string;
  captureStartToronto: string;
  captureEndMs: number;
  captureEndIso: string;
  captureEndToronto: string;
  durationMs: number;
  cadenceMs: number;
  frameCount: number;
  cycleCount: number;
  totalPayloadBytes: number;
  feeds: Record<FeedId, FeedManifestEntry>;
}

export interface DemoFixtureFile {
  manifest: DemoManifest;
  frames: RecordedFrame[];
}

// ---------- time formatting ----------

/** "2026-07-24 17:03:12 America/Toronto" — agency-local, via the shared tz helpers. */
export function torontoStamp(epochMs: number): string {
  const p = torontoParts(epochMs);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}:${two(p.second)} America/Toronto`;
}

/** Compact "20260724-1703" slug in Toronto local time, for the fixture filename. */
function torontoSlug(epochMs: number): string {
  const p = torontoParts(epochMs);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${p.year}${two(p.month)}${two(p.day)}-${two(p.hour)}${two(p.minute)}`;
}

// ---------- single feed capture ----------

/**
 * Fetch one feed once. Never throws: a failure becomes an error-marked frame so the
 * capture survives a mid-recording hiccup and replay can reproduce it.
 */
export async function captureFrame(
  feed: FeedId,
  seq: number,
  captureStartMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RecordedFrame> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const base = (capturedAtMs: number): Omit<RecordedFrame, 'ok' | 'httpStatus' | 'byteLength' | 'payloadBase64' | 'error'> => ({
    feed,
    seq,
    capturedAtMs,
    capturedAtIso: new Date(capturedAtMs).toISOString(),
    capturedAtToronto: torontoStamp(capturedAtMs),
    offsetMs: capturedAtMs - captureStartMs,
    fetchMs: capturedAtMs - t0,
  });
  try {
    // No If-None-Match / If-Modified-Since: a 304 carries no payload and would hole the recording.
    const res = await fetchImpl(FEEDS[feed], { signal: ctrl.signal, headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) {
      const at = Date.now();
      return { ...base(at), ok: false, httpStatus: res.status, byteLength: null, payloadBase64: null, error: `HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const at = Date.now();
    // Sanity-decode before accepting the frame. A 200 carrying an HTML error page or a
    // captive-portal interstitial would otherwise be recorded as healthy and only blow up
    // at replay, long after the buses have stopped running. The decoded value is
    // discarded — we store the raw bytes, this is purely a guard on fixture integrity.
    try {
      transit_realtime.FeedMessage.decode(buf);
    } catch (e) {
      return {
        ...base(at), ok: false, httpStatus: res.status, byteLength: buf.length, payloadBase64: null,
        error: `HTTP ${res.status} but body is not GTFS-realtime (${e instanceof Error ? e.message : String(e)})`,
      };
    }
    return {
      ...base(at),
      ok: true,
      httpStatus: res.status,
      byteLength: buf.length,
      payloadBase64: buf.toString('base64'),
      error: null,
    };
  } catch (e) {
    const at = Date.now();
    return {
      ...base(at),
      ok: false,
      httpStatus: null,
      byteLength: null,
      payloadBase64: null,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- manifest ----------

export function buildManifest(
  frames: RecordedFrame[],
  captureStartMs: number,
  captureEndMs: number,
  cadenceMs: number,
  cycleCount: number,
): DemoManifest {
  const feeds = {} as Record<FeedId, FeedManifestEntry>;
  for (const id of FEED_IDS) {
    const mine = frames.filter((f) => f.feed === id);
    feeds[id] = {
      url: FEEDS[id],
      frames: mine.length,
      okFrames: mine.filter((f) => f.ok).length,
      errorFrames: mine.filter((f) => !f.ok).length,
      totalBytes: mine.reduce((s, f) => s + (f.byteLength ?? 0), 0),
    };
  }
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    kind: FIXTURE_KIND,
    agency: 'ttc',
    timezone: 'America/Toronto',
    attribution: TTC_ATTRIBUTION,
    recordedNotice:
      `RECORDING of live TTC data captured ${torontoStamp(captureStartMs)} ` +
      `through ${torontoStamp(captureEndMs)}. This is replayed history, not live service.`,
    captureStartMs,
    captureStartIso: new Date(captureStartMs).toISOString(),
    captureStartToronto: torontoStamp(captureStartMs),
    captureEndMs,
    captureEndIso: new Date(captureEndMs).toISOString(),
    captureEndToronto: torontoStamp(captureEndMs),
    durationMs: captureEndMs - captureStartMs,
    cadenceMs,
    frameCount: frames.length,
    cycleCount,
    totalPayloadBytes: frames.reduce((s, f) => s + (f.byteLength ?? 0), 0),
    feeds,
  };
}

// ---------- CLI ----------

function argValue(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return null;
  const v = hit.slice(hit.indexOf('=') + 1).trim();
  return v === '' ? null : v;
}

function flag(name: string, fallback: number, min: number): number {
  const raw = argValue(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`--${name}=${raw} is invalid (must be a number >= ${min})`);
  }
  return n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main(): Promise<void> {
  const minutes = flag('minutes', DEFAULT_MINUTES, 0.01);
  // Floor the cadence at 5s: this recorder points at a public agency feed, and a typo
  // like --cadence-ms=0.5 would otherwise hammer the TTC with millions of requests.
  const cadenceMs = flag('cadence-ms', DEFAULT_CADENCE_MS, MIN_CADENCE_MS);
  const durationMs = minutes * 60_000;
  // Frame at t=0, then every cadence, for as long as the next one still fits the window.
  const cycles = Math.floor(durationMs / cadenceMs) + 1;

  const captureStartMs = Date.now();
  const outPath = resolve(
    process.cwd(),
    argValue('out') ?? `fixtures/ttc-demo-${torontoSlug(captureStartMs)}.json.gz`,
  );
  // The manifest sidecar must never collide with the bundle: a naive
  // `outPath.replace(/\.json\.gz$/, ...)` is a no-op for an --out that does not end in
  // .json.gz, which would overwrite ten minutes of capture with a 1 KB manifest.
  const sidecarPath = `${outPath.replace(/\.json\.gz$/, '')}.manifest.json`;
  if (sidecarPath === outPath) throw new Error(`--out=${outPath} collides with its manifest sidecar`);

  // Fail fast on an unwritable destination rather than at minute 10 with the capture
  // already in hand and nowhere to put it.
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(sidecarPath, `{"status":"capture in progress","startedAt":${JSON.stringify(new Date(captureStartMs).toISOString())}}\n`);

  console.log('GhostBus Demo Mode recorder');
  console.log(`  start    ${torontoStamp(captureStartMs)}  (${new Date(captureStartMs).toISOString()})`);
  console.log(`  plan     ${cycles} cycles x ${FEED_IDS.length} feeds @ ${cadenceMs / 1000}s = ~${minutes} min`);
  console.log(`  out      ${outPath}`);
  console.log('');

  const frames: RecordedFrame[] = [];
  for (let seq = 0; seq < cycles; seq++) {
    const cycleFrames = await Promise.all(
      FEED_IDS.map((id) => captureFrame(id, seq, captureStartMs)),
    );
    frames.push(...cycleFrames);
    const summary = cycleFrames
      .map((f) => (f.ok ? `${f.feed} ${((f.byteLength ?? 0) / 1024).toFixed(0)}KB` : `${f.feed} FAILED(${f.error})`))
      .join('  ');
    console.log(`  [cycle ${String(seq + 1).padStart(2, ' ')}/${cycles}] ${torontoStamp(Date.now())}  ${summary}`);

    if (seq < cycles - 1) {
      await sleep(captureStartMs + (seq + 1) * cadenceMs - Date.now());
    }
  }
  const captureEndMs = Date.now();

  const manifest = buildManifest(frames, captureStartMs, captureEndMs, cadenceMs, cycles);
  const bundle: DemoFixtureFile = { manifest, frames };
  const json = Buffer.from(JSON.stringify(bundle), 'utf8');
  const gz = gzipSync(json, { level: 9 });

  writeFileSync(outPath, gz);
  // Sidecar: the manifest alone, uncompressed, so the provenance of the fixture is
  // readable (and diffable in git) without inflating a multi-megabyte bundle.
  writeFileSync(sidecarPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log('');
  console.log(`  frames         ${frames.length} (${frames.filter((f) => f.ok).length} ok, ${frames.filter((f) => !f.ok).length} failed)`);
  console.log(`  raw payloads   ${mb(manifest.totalPayloadBytes)}`);
  console.log(`  json bundle    ${mb(json.length)}`);
  console.log(`  gzipped file   ${mb(gz.length)}  -> ${outPath}`);
  console.log(`  manifest       ${sidecarPath}`);
  console.log(`  window         ${manifest.captureStartToronto} .. ${manifest.captureEndToronto}`);
  if (gz.length > SIZE_WARN_BYTES) {
    console.warn(`  WARNING: fixture exceeds ${mb(SIZE_WARN_BYTES)} — reduce --minutes before committing.`);
  }
}

// Only run when executed directly, so the helpers above stay importable by tests.
// Path comparison (not URL string comparison) matches aggregate.ts and is not tripped up
// by Windows drive-letter casing.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error('recorder FAILED:', e); process.exit(1); });
}
