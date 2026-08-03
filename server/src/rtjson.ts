// rtjson — GTFS-realtime-as-JSON decode, for a publisher that answers JSON where every
// other agency answers binary protobuf.
//
// One agency does this today: Metrolinx. Verified 2026-07-29 with the operator's key:
// all three GO feeds (api.openmetrolinx.com/OpenDataAPI/api/V1/Gtfs/Feed/…) return
// HTTP 200 with a body that starts `{ "header": {` — GTFS-realtime SHAPES, JSON BYTES.
// The poller routes an agency here only when its descriptor says `rtFormat: 'json'`;
// the binary path for every other agency is untouched.
//
// TWO TRAPS, BOTH MEASURED (2026-07-29, .data/go-rt-probe-output.json), BOTH PINNED
// BY rtjson.test.ts AGAINST A REAL RECORDED GO SNAPSHOT:
//
// 1. CASING. Metrolinx serialises snake_case keys — one TripUpdates snapshot counted
//    6,785 snake_case keys and zero camelCase. protobuf.js's generated `fromObject`
//    reads ONLY camelCase property names (`object.tripUpdate`), so fed the raw JSON it
//    returns 196 entities whose every `tripUpdate` is silently null — a feed that looks
//    alive and carries nothing. Keys are therefore camelised before `fromObject`.
//
// 2. PRESENCE. GTFS-realtime is proto2 and pb.ts documents what reading a materialised
//    default as a measurement cost once already (314,742 artifact observations). The
//    question for THIS path was whether `fromObject` keeps the presence contract
//    `decode()` provides: it does — it assigns only fields present in the source object,
//    so absent fields stay on the PROTOTYPE and `hasOwnProperty` remains an honest
//    "was this on the wire" test. Verified on the real snapshot: a stop_time_update
//    with no `stop_sequence` on the wire still READS `0` (the prototype default) while
//    `present()` correctly answers false. The helpers in pb.ts work unchanged.

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { transit_realtime } = GtfsRealtimeBindings;

type FeedMessage = ReturnType<typeof transit_realtime.FeedMessage.decode>;

/** `trip_update` -> `tripUpdate`. Keys without underscores pass through untouched. */
function camelKey(k: string): string {
  return k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Recursively camelise every object key. Values are never touched — string enums
 * ("SCHEDULED"), stringified uint64s ("1785366000") and empty strings all pass through
 * exactly as published, because `fromObject` is the layer that owns converting them.
 */
function camelizeKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelizeKeys);
  if (v !== null && typeof v === 'object') {
    // Object.fromEntries, not `out[k] = …`: fromEntries DEFINES own data properties, so a
    // hostile key like `__proto__` in a compromised feed body becomes an inert own
    // property instead of a prototype mutation.
    return Object.fromEntries(
      Object.entries(v).map(([k, val]) => [camelKey(k), camelizeKeys(val)]),
    );
  }
  return v;
}

/**
 * Decode a JSON GTFS-realtime body into the SAME FeedMessage shape `decode()` yields
 * for a binary body, presence semantics included. Throws on malformed JSON, and ALSO on
 * well-formed JSON that is not a feed: binary `decode()` throws on a body missing the
 * required `header`, but `fromObject` enforces nothing — so a keyed API answering an
 * error payload with HTTP 200 (a lapsed key is the obvious way) would otherwise become
 * a "healthy" empty feed the poller marks ok forever. The throw lands in the poller's
 * existing catch/backoff exactly like a malformed protobuf.
 */
export function decodeJsonFeed(buf: Buffer): FeedMessage {
  const raw: unknown = JSON.parse(buf.toString('utf8'));
  const msg = transit_realtime.FeedMessage.fromObject(camelizeKeys(raw) as Record<string, unknown>);
  if (msg.header == null) {
    throw new Error("JSON body parsed but carries no GTFS-realtime 'header' — not a feed");
  }
  return msg;
}
