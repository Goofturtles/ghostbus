import { test } from 'node:test';
import assert from 'node:assert/strict';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { present, presentInt, presentStr, presentFloat } from './pb.ts';

const { transit_realtime } = GtfsRealtimeBindings;

// Encode -> decode, so we exercise the real wire format rather than a create()d object
// that still carries whatever properties the constructor happened to assign. The message
// classes are structurally identical but not nominally related, so the parameter is typed
// to the shape we use rather than to any one of them.
interface PbType {
  create(o: object): object;
  encode(m: object): { finish(): Uint8Array };
  decode(b: Uint8Array): object;
}
function roundTrip(type: unknown, obj: object): { decoded: object; bytes: number } {
  const t = type as PbType;
  const buf = t.encode(t.create(obj)).finish();
  return { decoded: t.decode(buf), bytes: buf.length };
}

test('THE ROOT CAUSE: an absent delay decodes as 0 but is not present on the wire', () => {
  const T = transit_realtime.TripUpdate.StopTimeEvent;

  const noDelay = roundTrip(T as never, { time: 123 });
  // The trap, stated as an assertion: the value reads 0 …
  assert.equal((noDelay.decoded as { delay: number }).delay, 0);
  // … but the field was never sent, and presentInt says so.
  assert.equal(present(noDelay.decoded, 'delay'), false);
  assert.equal(presentInt(noDelay.decoded, 'delay'), null);
  // Wire-level proof that nothing was sent: time alone is 2 bytes.
  assert.equal(noDelay.bytes, 2);
  assert.equal(presentInt(noDelay.decoded, 'time'), 123);

  // An explicitly-reported on-time bus is distinguishable, and costs 2 more bytes.
  const zeroDelay = roundTrip(T as never, { time: 123, delay: 0 });
  assert.equal(present(zeroDelay.decoded, 'delay'), true);
  assert.equal(presentInt(zeroDelay.decoded, 'delay'), 0);
  assert.equal(zeroDelay.bytes, 4);

  const realDelay = roundTrip(T as never, { time: 123, delay: 60 });
  assert.equal(presentInt(realDelay.decoded, 'delay'), 60);

  const negDelay = roundTrip(T as never, { time: 123, delay: -45 });
  assert.equal(presentInt(negDelay.decoded, 'delay'), -45);
});

test('VehiclePosition.currentStatus defaults to IN_TRANSIT_TO (2), not 0', () => {
  const V = transit_realtime.VehiclePosition;
  const absent = roundTrip(V as never, {});
  // Reading this with `?? 0` or `!= null` would silently label a moving bus STOPPED_AT-adjacent.
  assert.equal((absent.decoded as { currentStatus: number }).currentStatus, 2);
  assert.equal(presentInt(absent.decoded, 'currentStatus'), null);

  const stoppedAt = roundTrip(V as never, { currentStatus: 1 });
  assert.equal(presentInt(stoppedAt.decoded, 'currentStatus'), 1);
  // An explicit 0 (INCOMING_AT) must survive as 0, not be confused with absence.
  const incoming = roundTrip(V as never, { currentStatus: 0 });
  assert.equal(presentInt(incoming.decoded, 'currentStatus'), 0);
});

test('TripDescriptor directionId/startDate/startTime default to 0 and empty string', () => {
  const TD = transit_realtime.TripDescriptor;
  const td = roundTrip(TD as never, { tripId: 'x' });
  assert.equal((td.decoded as { directionId: number }).directionId, 0);
  assert.equal(presentInt(td.decoded, 'directionId'), null);
  assert.equal((td.decoded as { startDate: string }).startDate, '');
  assert.equal(presentStr(td.decoded, 'startDate'), null);
  assert.equal(presentStr(td.decoded, 'startTime'), null);
  assert.equal(presentStr(td.decoded, 'tripId'), 'x');

  const withDir = roundTrip(TD as never, { tripId: 'x', directionId: 0 });
  assert.equal(presentInt(withDir.decoded, 'directionId'), 0);
});

test('REGRESSION (BLOCKERS 16): Position.bearing/speed default to 0, i.e. due north and stopped', () => {
  // The map path used `v.position.bearing != null ? Number(...) : null`, which is true for
  // every vehicle on the feed whether or not the producer sent a bearing — so a vehicle
  // that never reported a heading rendered pointing due north, indistinguishable from one
  // genuinely heading north. Same class of mistake as the delay field above; the cost here
  // is a wrong sprite rotation rather than a wrong statistic, which is not a reason to
  // keep it.
  const P = transit_realtime.Position;
  const bare = roundTrip(P as never, { latitude: 43.7, longitude: -79.4 });
  assert.equal((bare.decoded as { bearing: number }).bearing, 0, 'the trap: reads as due north');
  assert.equal((bare.decoded as { speed: number }).speed, 0, 'the trap: reads as stationary');
  assert.notEqual((bare.decoded as { bearing: number }).bearing, null,
    'so a != null test cannot reject it');
  assert.equal(presentFloat(bare.decoded, 'bearing'), null);
  assert.equal(presentFloat(bare.decoded, 'speed'), null);

  // A vehicle that really is pointing north, or really is stopped, must survive as 0.
  const explicit = roundTrip(P as never, { latitude: 43.7, longitude: -79.4, bearing: 0, speed: 0 });
  assert.equal(presentFloat(explicit.decoded, 'bearing'), 0);
  assert.equal(presentFloat(explicit.decoded, 'speed'), 0);
  const moving = roundTrip(P as never, { latitude: 43.7, longitude: -79.4, bearing: 271.5, speed: 8.25 });
  assert.ok(Math.abs((presentFloat(moving.decoded, 'bearing') ?? 0) - 271.5) < 0.01);
  assert.ok(Math.abs((presentFloat(moving.decoded, 'speed') ?? 0) - 8.25) < 0.01);
});

test('REGRESSION (BLOCKERS 16): an absent VehiclePosition.timestamp is not 1970', () => {
  // `toNum(v.timestamp) ?? Date.now()/1000` never reached its fallback: an absent
  // timestamp decodes as 0, which is a number, so the ping was dated 1970-01-01.
  const V = transit_realtime.VehiclePosition;
  const bare = roundTrip(V as never, {});
  assert.equal(Number((bare.decoded as { timestamp: unknown }).timestamp), 0);
  assert.equal(presentInt(bare.decoded, 'timestamp'), null, 'so the "unknown -> now" fallback can fire');
  const stamped = roundTrip(V as never, { timestamp: 1_800_000_000 });
  assert.equal(presentInt(stamped.decoded, 'timestamp'), 1_800_000_000);

  // TimeRange (an alert's active period) has the same shape: an open-ended window would
  // otherwise be published as one starting 1970-01-01.
  const range = roundTrip(transit_realtime.TimeRange as never, {});
  assert.equal(presentInt(range.decoded, 'start'), null);
  assert.equal(presentInt(range.decoded, 'end'), null);
  assert.equal(presentInt(roundTrip(transit_realtime.TimeRange as never, { start: 5 }).decoded, 'start'), 5);
});

test('presentInt handles protobufjs Long-like objects and rejects junk', () => {
  assert.equal(presentInt({ t: { toNumber: () => 42 } }, 't'), 42);
  assert.equal(presentInt({ t: 7n }, 't'), 7);
  assert.equal(presentInt({ t: 'abc' }, 't'), null);
  assert.equal(presentInt({ t: null }, 't'), null);
  assert.equal(presentInt(null, 't'), null);
  assert.equal(presentInt(undefined, 't'), null);
  assert.equal(presentStr({ s: '' }, 's'), null);
  assert.equal(present({ s: '' }, 's'), true);
});
