import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originLock, preferBinding, type LockInput, type LockSlot } from './bind.ts';
import { serviceEpochSeconds } from './tz.ts';

const DATE = 20260803; // a Monday inside the loaded board, no DST anywhere near it
const DAY0 = serviceEpochSeconds(DATE, 0);

/** A slot departing at `firstDepS`, with a stop every 120 s afterwards. */
function slot(tripId: string, firstDepS: number, nStops = 20): LockSlot {
  const times = new Int32Array(nStops);
  for (let i = 0; i < nStops; i++) times[i] = firstDepS + i * 120;
  return { tripId, firstDepS, claimed: false, times };
}

function input(over: Partial<LockInput> = {}): LockInput {
  return {
    serviceDate: DATE,
    routeId: 'R',
    staticPatternId: 'SP',
    predFirstEpochS: DAY0 + 9 * 3600,
    anchors: [{ stopSequence: 1, staticStopId: 's1', predEpochS: DAY0 + 9 * 3600 }],
    slots: [slot('T_ontime', 9 * 3600)],
    medianHeadwayS: 900,
    ...over,
  };
}

test('a clean, well-separated origin locks', () => {
  const r = originLock(input({ slots: [slot('T', 9 * 3600), slot('T_next', 9 * 3600 + 900)] }));
  assert.equal(r.method, 'origin_lock');
  assert.equal(r.tripId, 'T');
  assert.equal(r.residS, 0);
  assert.equal(r.confidence, 'high');
});

test('THE MARGIN TEST: a runner-up within 120 s is refused, beyond it is accepted', () => {
  // Two slots 60 s apart. Prediction sits 30 s after the first: |resid| 30 vs 30 — the
  // runner-up is no worse, so we genuinely cannot tell which bus this is.
  const near = originLock(input({
    predFirstEpochS: DAY0 + 9 * 3600 + 30,
    slots: [slot('A', 9 * 3600), slot('B', 9 * 3600 + 60)],
  }));
  assert.equal(near.method, 'refused_ambiguous');
  assert.equal(near.tripId, null);
  assert.ok(near.marginS != null && near.marginS < 120);

  // Same shape but the runner-up is 200 s worse: now the winner is genuinely separated.
  // (B is placed 200 s EARLIER so it stays inside the band and is a real runner-up.)
  const far = originLock(input({
    predFirstEpochS: DAY0 + 9 * 3600,
    slots: [slot('A', 9 * 3600), slot('B', 9 * 3600 - 200)],
  }));
  assert.equal(far.method, 'origin_lock');
  assert.equal(far.tripId, 'A');
  assert.equal(far.marginS, 200);

  // A lone candidate has no runner-up at all, and a null margin says exactly that rather
  // than reporting a fabricated separation.
  const solo = originLock(input({ predFirstEpochS: DAY0 + 9 * 3600, slots: [slot('A', 9 * 3600)] }));
  assert.equal(solo.method, 'origin_lock');
  assert.equal(solo.marginS, null);
  assert.equal(solo.candidates, 1);
});

test('exactly 120 s of separation is accepted; 119 s is not', () => {
  const at120 = originLock(input({ slots: [slot('A', 9 * 3600), slot('B', 9 * 3600 + 120)] }));
  assert.equal(at120.method, 'origin_lock');
  const at119 = originLock(input({ slots: [slot('A', 9 * 3600), slot('B', 9 * 3600 + 119)] }));
  assert.equal(at119.method, 'refused_ambiguous');
});

test('the origin band is asymmetric: -200 s falls outside it, +400 s does not', () => {
  // 200 s EARLY: a trip published half an hour ahead cannot be meaningfully early, so a
  // slot that far back is not a candidate at all.
  const early = originLock(input({ predFirstEpochS: DAY0 + 9 * 3600 - 200, slots: [slot('A', 9 * 3600)] }));
  assert.equal(early.method, 'refused_no_slot');

  // 400 s LATE: a late block handoff, which is a real and expected thing.
  const late = originLock(input({ predFirstEpochS: DAY0 + 9 * 3600 + 400, slots: [slot('A', 9 * 3600)] }));
  assert.equal(late.method, 'origin_lock');
  assert.equal(late.residS, 400);

  // Just past each edge.
  assert.equal(originLock(input({ predFirstEpochS: DAY0 + 9 * 3600 - 181, slots: [slot('A', 9 * 3600)] })).method, 'refused_no_slot');
  assert.equal(originLock(input({ predFirstEpochS: DAY0 + 9 * 3600 + 421, slots: [slot('A', 9 * 3600)] })).method, 'refused_no_slot');
});

test('the headway band: <300 s is refused outright, 300-600 s is low, >=600 s is high', () => {
  const tooFrequent = originLock(input({ medianHeadwayS: 250 }));
  assert.equal(tooFrequent.method, 'refused_headway_band');
  assert.equal(tooFrequent.tripId, null, 'never emitted at any confidence');

  assert.equal(originLock(input({ medianHeadwayS: 450 })).confidence, 'low');
  assert.equal(originLock(input({ medianHeadwayS: 900 })).confidence, 'high');
  assert.equal(originLock(input({ medianHeadwayS: 600 })).confidence, 'high');
  assert.equal(originLock(input({ medianHeadwayS: 599 })).confidence, 'low');

  // An unknown headway is not an excuse to publish.
  assert.equal(originLock(input({ medianHeadwayS: null })).method, 'refused_headway_band');
});

test('a sub-300 s headway is refused even when the margin is enormous', () => {
  const r = originLock(input({
    medianHeadwayS: 200,
    slots: [slot('A', 9 * 3600), slot('B', 9 * 3600 + 100_000)],
  }));
  assert.equal(r.method, 'refused_headway_band');
});

test('TODAY\'S REAL STATE: an empty slot list emits nothing, and says why', () => {
  const r = originLock(input({ slots: [] }));
  assert.equal(r.method, 'refused_board_inactive');
  assert.equal(r.tripId, null);
  assert.equal(r.residS, null);
  assert.equal(r.confidence, null);
  // Not "zero delay", not "no data yet" — a distinct, nameable outcome.
  assert.notEqual(r.method, 'refused_no_slot');
});

test('extra anchors break a tie the origin alone cannot', () => {
  // Two slots 60 s apart -> ambiguous on origin. But this trip has published stop 5, and
  // only slot A's stop 5 lines up with the prediction.
  const A = slot('A', 9 * 3600);
  const B = slot('B', 9 * 3600 + 60);
  const base = {
    predFirstEpochS: DAY0 + 9 * 3600 + 30,
    slots: [A, B],
    anchors: [
      { stopSequence: 1, staticStopId: 's1', predEpochS: DAY0 + 9 * 3600 + 30 },
      { stopSequence: 5, staticStopId: 's5', predEpochS: DAY0 + 9 * 3600 + 30 + 4 * 120 },
      { stopSequence: 9, staticStopId: 's9', predEpochS: DAY0 + 9 * 3600 + 30 + 8 * 120 },
    ],
  };
  const r = originLock(input(base));
  // Both slots are internally consistent time-shifts, so agree cannot separate them
  // either — and the honest result is still a refusal, not a coin flip.
  assert.equal(r.method, 'refused_ambiguous');
});

test('a slot whose stop_sequence is missing from the pattern is scored, not crashed on', () => {
  const short = slot('SHORT', 9 * 3600, 3);
  const r = originLock(input({
    slots: [short],
    anchors: [
      { stopSequence: 1, staticStopId: 's1', predEpochS: DAY0 + 9 * 3600 },
      { stopSequence: 40, staticStopId: 's40', predEpochS: DAY0 + 9 * 3600 + 4000 },
    ],
  }));
  assert.equal(r.method, 'origin_lock');
  assert.equal(r.agree, 1, 'only the in-range anchor counts');
});

test('the winner is deterministic when two slots are genuinely identical', () => {
  const r1 = originLock(input({ slots: [slot('B', 9 * 3600), slot('A', 9 * 3600)] }));
  const r2 = originLock(input({ slots: [slot('A', 9 * 3600), slot('B', 9 * 3600)] }));
  // Identical residuals -> refused either way, and refused the same way both times.
  assert.equal(r1.method, 'refused_ambiguous');
  assert.equal(r2.method, r1.method);
});

test('double-book resolution prefers agree, then |resid|, then a stable tiebreak', () => {
  const hi = { agree: 3, residS: 200, rtTripId: 'rt1' };
  const lo = { agree: 1, residS: 5, rtTripId: 'rt2' };
  assert.equal(preferBinding(hi, lo).winner.rtTripId, 'rt1');
  assert.equal(preferBinding(lo, hi).winner.rtTripId, 'rt1');

  const a = { agree: 2, residS: -10, rtTripId: 'rtA' };
  const b = { agree: 2, residS: 90, rtTripId: 'rtB' };
  assert.equal(preferBinding(a, b).winner.rtTripId, 'rtA', 'smaller |resid| wins on equal agree');
  assert.equal(preferBinding(b, a).loser.rtTripId, 'rtB');

  const t1 = { agree: 1, residS: 50, rtTripId: 'z' };
  const t2 = { agree: 1, residS: -50, rtTripId: 'a' };
  assert.equal(preferBinding(t1, t2).winner.rtTripId, 'a', 'fully tied -> stable, order-independent');
  assert.equal(preferBinding(t2, t1).winner.rtTripId, 'a');
});

test('binding math is anchored on the service day, not on local midnight', () => {
  // 2026-11-01 is the fall-back day. A 9h scheduled departure predicted exactly on time
  // must read as resid 0 — with a midnight anchor it would read as a fabricated 3,600 s.
  const dstDay = 20261101;
  const r = originLock({
    serviceDate: dstDay,
    routeId: 'R',
    staticPatternId: 'SP',
    predFirstEpochS: serviceEpochSeconds(dstDay, 9 * 3600),
    anchors: [{ stopSequence: 1, staticStopId: 's1', predEpochS: serviceEpochSeconds(dstDay, 9 * 3600) }],
    slots: [slot('T', 9 * 3600)],
    medianHeadwayS: 900,
  });
  assert.equal(r.method, 'origin_lock');
  assert.equal(r.residS, 0);
});
