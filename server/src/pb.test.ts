import { test } from 'node:test';
import assert from 'node:assert/strict';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { present, presentInt, presentStr } from './pb.ts';

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
