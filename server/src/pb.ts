// pb — presence-aware protobuf field reads.
//
// GTFS-realtime is proto2. protobuf.js materialises every optional field's default
// on the message PROTOTYPE, so a field the producer never put on the wire still reads
// as a value: `ev.delay` is 0, `v.currentStatus` is 2 (IN_TRANSIT_TO, not 0),
// `td.directionId` is 0, `td.startDate` is ''. A `!= null` check cannot tell
// "reported as zero" from "never reported".
//
// Measured on the live TTC feed (2026-07-24, one snapshot): `hasOwnProperty('delay')`
// was true for 0 of 23,476 StopTimeEvents and 0 of 1,392 TripUpdates, while every one
// of them read `delay === 0`. Synthetic round-trip proof: StopTimeEvent.create({time:123})
// encodes to 2 bytes and decodes with hasOwn(delay)=false / delay===0; adding an explicit
// delay:0 encodes to 4 bytes and decodes with hasOwn(delay)=true. The TTC feed publishes
// NO delay field at all — the 300k+ "all zero" delay observations this project previously
// accumulated were a decoder artifact, not a measurement.
//
// Every optional scalar read from either feed MUST go through these helpers.

/** True only when the field was actually present on the wire (proto2 defaults live on the prototype). */
export function present(msg: object | null | undefined, field: string): boolean {
  return !!msg && Object.prototype.hasOwnProperty.call(msg, field);
}

/** Numeric field, or null when absent on the wire. Handles protobufjs Long. */
export function presentInt(msg: object | null | undefined, field: string): number | null {
  if (!present(msg, field)) return null;
  const v = (msg as Record<string, unknown>)[field];
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber();
  }
  const n = Number(v as number);
  return Number.isFinite(n) ? n : null;
}

/** Float field, or null when absent on the wire. Same presence rule as presentInt. */
export function presentFloat(msg: object | null | undefined, field: string): number | null {
  return presentInt(msg, field);
}

/** String field, or null when absent on the wire or explicitly empty. */
export function presentStr(msg: object | null | undefined, field: string): string | null {
  if (!present(msg, field)) return null;
  const v = (msg as Record<string, unknown>)[field];
  return typeof v === 'string' && v !== '' ? v : null;
}
