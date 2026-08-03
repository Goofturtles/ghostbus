// rtjson.test — the JSON decode path, pinned against a REAL recorded GO snapshot.
//
// fixtures/go-tripupdates-sample.json is the header plus the first three entities of an
// actual Metrolinx TripUpdates response (captured 2026-07-29, bytes as served: snake_case
// keys, explicit `"arrival": null`s, an empty-string license_plate, numeric uint64s).
// Nothing in it is synthesised, because the two traps this module exists to survive were
// both discovered by pointing the real bytes at the obvious code and watching it fail
// silently. Every assertion on a concrete value below is the value in the fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { decodeJsonFeed } from './rtjson.ts';
import { present, presentInt, presentStr } from './pb.ts';

const { transit_realtime } = GtfsRealtimeBindings;
const FIXTURE = readFileSync(new URL('../../fixtures/go-tripupdates-sample.json', import.meta.url));

test('a real GO JSON body decodes to the shapes the binary path yields', () => {
  const msg = decodeJsonFeed(FIXTURE);
  assert.equal(msg.header.gtfsRealtimeVersion, '2.0');
  // uint64 arrives as a JSON number and must survive the Long conversion.
  assert.equal(presentInt(msg.header, 'timestamp'), 1785365898);
  assert.equal(msg.entity.length, 3);

  const tu = msg.entity[0].tripUpdate;
  assert.ok(tu, 'entity[0] must carry its tripUpdate');
  assert.equal(presentStr(tu.trip, 'tripId'), '20260729-41-41471');
  assert.equal(presentStr(tu.trip, 'routeId'), '06260926-41');
  assert.equal(presentInt(tu.trip, 'directionId'), 1);
  // The wire says the STRING "SCHEDULED"; fromObject converts it to the enum number,
  // and it is a real own property because it really was on the wire.
  assert.equal(presentInt(tu.trip, 'scheduleRelationship'),
    transit_realtime.TripDescriptor.ScheduleRelationship.SCHEDULED);
});

test('THE CASING TRAP: raw snake_case fed straight to fromObject is a silent empty husk', () => {
  // This is why decodeJsonFeed camelises first. protobuf.js's generated fromObject reads
  // only camelCase property names, so the raw body "decodes" into entities whose payload
  // fields are all missing — a feed that looks alive and carries nothing. If this test
  // ever FAILS because tripUpdate is suddenly populated, protobuf.js learned to read
  // snake_case and the camelise step is dead weight to remove.
  const husk = transit_realtime.FeedMessage.fromObject(JSON.parse(FIXTURE.toString('utf8')));
  assert.equal(husk.entity.length, 3, 'entities themselves appear (their key has no underscore)');
  assert.equal(husk.entity[0].tripUpdate, null, 'but trip_update was silently dropped');
});

test('THE PRESENCE TRAP: absent and explicitly-null fields stay OFF the instance', () => {
  const msg = decodeJsonFeed(FIXTURE);
  const tu = msg.entity[0].tripUpdate!;
  const stu = tu.stopTimeUpdate![0];

  // GO sends NO stop_sequence. The prototype default still READS 0 — which a
  // presence-blind consumer would take as "this is the first stop of the trip". The
  // helpers must answer null, exactly as they do for the binary path (pb.ts).
  assert.equal(stu.stopSequence, 0, 'the prototype default is visible to a naive read…');
  assert.equal(present(stu, 'stopSequence'), false, '…but it was never on the wire');
  assert.equal(presentInt(stu, 'stopSequence'), null);

  // The wire says `"arrival": null` — an EXPLICIT null. fromObject must skip it, not
  // materialise an empty StopTimeEvent whose delay/time then read as proto2 defaults.
  assert.equal(present(stu, 'arrival'), false);
  assert.equal(stu.arrival, null);
  assert.equal(presentInt(stu.arrival, 'time'), null);

  // Entity-level nulls too: the serialiser writes `"vehicle": null, "alert": null` on a
  // trip-update entity, and neither may become a materialised message.
  assert.equal(present(msg.entity[0], 'vehicle'), false);
  assert.equal(present(msg.entity[0], 'alert'), false);

  // And the fields that WERE sent are really there, with their real values.
  assert.equal(presentInt(stu.departure, 'time'), 1785366000);
  assert.equal(presentInt(stu.departure, 'delay'), -706);
  // Reported-as-zero is distinguishable from never-reported — the whole point of pb.ts.
  assert.equal(presentInt(stu.departure, 'uncertainty'), 0);
  assert.equal(presentStr(stu, 'stopId'), '00141');
});

test('an empty string on the wire is present but reads as null, same as the binary path', () => {
  const tu = decodeJsonFeed(FIXTURE).entity[0].tripUpdate!;
  // GO pads license_plate with "" — it WAS sent, but an empty id is not an id.
  assert.equal(present(tu.vehicle, 'licensePlate'), true);
  assert.equal(presentStr(tu.vehicle, 'licensePlate'), null);
  assert.equal(presentStr(tu.vehicle, 'label'), '41 - Hamilton GO');
  assert.equal(presentStr(tu.vehicle, 'id'), '8532');
});

test('well-formed JSON that is not a feed throws, exactly as a malformed protobuf would', () => {
  // fromObject enforces no required fields, so without the header guard a keyed API
  // answering an error payload with HTTP 200 (a lapsed key, say) would decode into a
  // "healthy" empty feed the poller marks ok forever. The binary path throws on a
  // missing header; this path must too, into the same poller catch/backoff.
  assert.throws(() => decodeJsonFeed(Buffer.from('{}')), /no GTFS-realtime 'header'/);
  assert.throws(() => decodeJsonFeed(Buffer.from('{"error":"invalid key"}')), /no GTFS-realtime 'header'/);
  assert.throws(() => decodeJsonFeed(Buffer.from('not json at all')), SyntaxError);
});
