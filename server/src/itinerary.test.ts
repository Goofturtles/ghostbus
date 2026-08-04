// The two-leg planner's rules, each pinned by the failure it exists to prevent. The
// fixture is a small deliberate network rather than a recorded one, because what is
// being tested is the JOIN — which connections are offered and which are refused — and
// a real board would bury that in noise.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stitchItineraries, stitchThreeLeg, startSearchBudget, breathe, PLAN_SEARCH_BUDGET_MS,
  TRANSFER_MAX_WALK_M, TRANSFER_MIN_SLACK_S, TRANSFER_MAX_WAIT_S,
  type StitchRide, type StitchStop,
} from './itinerary.ts';

const T0 = Date.UTC(2026, 7, 3, 12, 0, 0);
const min = (n: number) => n * 60_000;

/** Stops on one east-west line, spaced so the walk cap can be crossed deliberately. */
const STOPS: StitchStop[] = [
  { agency: 'miway', stopId: 'HOME', lat: 43.6000, lon: -79.6000 },
  // HUB_A and HUB_B are ~180 m apart: a real cross-agency transfer, inside the cap.
  { agency: 'miway', stopId: 'HUB_A', lat: 43.6300, lon: -79.5500 },
  { agency: 'ttc', stopId: 'HUB_B', lat: 43.6300, lon: -79.5478 },
  // FAR is ~1.6 km from HUB_A: past the cap, and must never be offered.
  { agency: 'ttc', stopId: 'FAR', lat: 43.6300, lon: -79.5300 },
  { agency: 'ttc', stopId: 'WORK', lat: 43.6500, lon: -79.5000 },
];

const ride = (o: Partial<StitchRide> & Pick<StitchRide, 'agency' | 'tripId' | 'boardStopId' | 'alightStopId' | 'departureMs' | 'arrivalMs'>): StitchRide =>
  ({ routeId: o.routeId ?? 'R', ...o });

const opts = { paceMps: 1.3, limit: 10 };

test('a known two-leg journey is found: MiWay to the hub, walk, TTC onward', async () => {
  const leg1 = [ride({ agency: 'miway', tripId: 'M1', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0, arrivalMs: T0 + min(15) })];
  const leg2 = [ride({ agency: 'ttc', tripId: 'T1', boardStopId: 'HUB_B', alightStopId: 'WORK', departureMs: T0 + min(22), arrivalMs: T0 + min(40) })];

  const [it] = await stitchItineraries(leg1, leg2, STOPS, opts);
  assert.ok(it, 'the connection exists and must be offered');
  assert.equal(it.legs[0].tripId, 'M1');
  assert.equal(it.legs[1].tripId, 'T1');
  assert.equal(it.crossAgency, true, 'MiWay -> TTC is exactly the case this tier adds');
  assert.equal(it.arrivalMs, T0 + min(40));
  assert.equal(it.transfers[0].waitSec, 7 * 60, 'the wait is stated, not folded into a total');
  assert.ok(it.transfers[0].walkM > 0 && it.transfers[0].walkM <= TRANSFER_MAX_WALK_M);
});

test('RULE 1: a connection that cannot physically be made is refused', async () => {
  // Leg 2 leaves 30 s after leg 1 lands — the timetable permits it and a rider cannot.
  const leg1 = [ride({ agency: 'miway', tripId: 'M1', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0, arrivalMs: T0 + min(15) })];
  const leg2 = [ride({ agency: 'ttc', tripId: 'T1', boardStopId: 'HUB_B', alightStopId: 'WORK', departureMs: T0 + min(15) + 30_000, arrivalMs: T0 + min(40) })];

  assert.deepEqual(await stitchItineraries(leg1, leg2, STOPS, opts), [],
    'a sprint the schedule allows is still not a plan');
});

test('RULE 1: the slack floor is real — one second under it is still refused', async () => {
  const leg1 = [ride({ agency: 'miway', tripId: 'M1', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0, arrivalMs: T0 + min(15) })];
  // MEASURED, not guessed: the walk is whatever the module says it is for these two
  // stops at this pace, and the point of the test is the boundary around it.
  const walkSec = (await stitchItineraries(
    leg1,
    [ride({ agency: 'ttc', tripId: 'T0', boardStopId: 'HUB_B', alightStopId: 'WORK', departureMs: T0 + min(30), arrivalMs: T0 + min(40) })],
    STOPS, opts,
  ))[0].transfers[0].walkSec;
  const at = (extraS: number) => [ride({
    agency: 'ttc', tripId: 'T1', boardStopId: 'HUB_B', alightStopId: 'WORK',
    departureMs: T0 + min(15) + extraS * 1000, arrivalMs: T0 + min(40),
  })];

  assert.equal((await stitchItineraries(leg1, at(walkSec + TRANSFER_MIN_SLACK_S - 1), STOPS, opts)).length, 0);
  assert.equal((await stitchItineraries(leg1, at(walkSec + TRANSFER_MIN_SLACK_S + 5), STOPS, opts)).length, 1);
});

test('RULE 2: a transfer past the walk cap is not a transfer', async () => {
  const leg1 = [ride({ agency: 'miway', tripId: 'M1', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0, arrivalMs: T0 + min(15) })];
  // Plenty of time; the only problem is that FAR is 1.6 km away.
  const leg2 = [ride({ agency: 'ttc', tripId: 'T1', boardStopId: 'FAR', alightStopId: 'WORK', departureMs: T0 + min(40), arrivalMs: T0 + min(55) })];

  assert.deepEqual(await stitchItineraries(leg1, leg2, STOPS, opts), [],
    'past the cap this is a second journey, and the app must say it cannot plan it');
});

test('an impossible journey still refuses — no connection is ever fabricated', async () => {
  // Nothing leg-2 touches anything leg-1 reaches.
  const leg1 = [ride({ agency: 'miway', tripId: 'M1', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0, arrivalMs: T0 + min(15) })];
  const leg2 = [ride({ agency: 'ttc', tripId: 'T1', boardStopId: 'WORK', alightStopId: 'FAR', departureMs: T0 + min(30), arrivalMs: T0 + min(45) })];
  assert.deepEqual(await stitchItineraries(leg1, leg2, STOPS, opts), []);

  // And the degenerate inputs, which must be silence rather than a throw.
  assert.deepEqual(await stitchItineraries([], leg2, STOPS, opts), []);
  assert.deepEqual(await stitchItineraries(leg1, [], STOPS, opts), []);
  assert.deepEqual(await stitchItineraries(leg1, leg2, [], opts), []);
});

test('a service gap is not a connection', async () => {
  const leg1 = [ride({ agency: 'miway', tripId: 'M1', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0, arrivalMs: T0 + min(15) })];
  const tooLate = Math.ceil(TRANSFER_MAX_WAIT_S / 60) + 16;
  const leg2 = [ride({ agency: 'ttc', tripId: 'T1', boardStopId: 'HUB_B', alightStopId: 'WORK', departureMs: T0 + min(tooLate), arrivalMs: T0 + min(tooLate + 15) })];
  assert.deepEqual(await stitchItineraries(leg1, leg2, STOPS, opts), [],
    'waiting out an hour-long gap is not something to call a transfer');
});

test('RULE 4: ranked by ARRIVAL, and the earliest catchable leg 2 is the one offered', async () => {
  const leg1 = [
    ride({ agency: 'miway', tripId: 'EARLY', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0, arrivalMs: T0 + min(15) }),
    ride({ agency: 'miway', tripId: 'LATER', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0 + min(10), arrivalMs: T0 + min(25) }),
  ];
  const leg2 = [
    ride({ agency: 'ttc', tripId: 'SLOW', boardStopId: 'HUB_B', alightStopId: 'WORK', departureMs: T0 + min(20), arrivalMs: T0 + min(60) }),
    ride({ agency: 'ttc', tripId: 'FAST', boardStopId: 'HUB_B', alightStopId: 'WORK', departureMs: T0 + min(30), arrivalMs: T0 + min(45) }),
  ];

  const out = await stitchItineraries(leg1, leg2, STOPS, opts);
  assert.equal(out[0].arrivalMs, T0 + min(45), 'the soonest ARRIVAL leads, not the soonest departure');
  assert.equal(out[0].legs[0].tripId, 'LATER',
    'and among equal arrivals the rider waits at home, not at the transfer stop');
  // EARLY can catch SLOW (20 min mark) — the earliest catchable, so SLOW is what EARLY
  // is paired with, never the later FAST as well.
  assert.ok(out.every((i) => !(i.legs[0].tripId === 'EARLY' && i.legs[1].tripId === 'FAST')),
    'one itinerary per first leg: the earliest leg 2 it can actually catch');
});

test('the same vehicle is never both legs of its own transfer', async () => {
  const leg1 = [ride({ agency: 'ttc', tripId: 'SAME', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0, arrivalMs: T0 + min(15) })];
  const leg2 = [ride({ agency: 'ttc', tripId: 'SAME', boardStopId: 'HUB_A', alightStopId: 'WORK', departureMs: T0 + min(20), arrivalMs: T0 + min(35) })];
  const stops: StitchStop[] = [...STOPS, { agency: 'ttc', stopId: 'HUB_A', lat: 43.6300, lon: -79.5500 }];
  assert.deepEqual(await stitchItineraries(leg1, leg2, stops, opts), [],
    'staying on the bus is a one-leg ride the first tier already answers');
});

test('a same-stop transfer needs no walk, only a wait', async () => {
  const leg1 = [ride({ agency: 'ttc', tripId: 'A', boardStopId: 'HOME', alightStopId: 'HUB_B', departureMs: T0, arrivalMs: T0 + min(15) })];
  const leg2 = [ride({ agency: 'ttc', tripId: 'B', boardStopId: 'HUB_B', alightStopId: 'WORK', departureMs: T0 + min(20), arrivalMs: T0 + min(35) })];
  const stops: StitchStop[] = [...STOPS, { agency: 'ttc', stopId: 'HOME', lat: 43.6000, lon: -79.6000 }];

  const [it] = await stitchItineraries(leg1, leg2, stops, opts);
  assert.ok(it);
  assert.equal(it.transfers[0].walkM, 0);
  assert.equal(it.crossAgency, false);
});

// ---------------------------------------------------------------------------
// THREE LEGS. The fixture is the journey the two-leg tier was built to refuse:
// Burlington to Oshawa, opposite ends of the GTA, which no single agency and no
// single transfer connects. Same rules, twice.
// ---------------------------------------------------------------------------

/** Burlington -> Oshawa across three agencies, plus the stops that must be refused. */
const GTA: StitchStop[] = [
  { agency: 'burlington', stopId: 'BURL_LOCAL', lat: 43.3220, lon: -79.7990 },
  // Burlington Transit's bay and GO's platform: ~150 m apart, a real transfer.
  { agency: 'burlington', stopId: 'BURL_GO_BT', lat: 43.3348, lon: -79.8085 },
  { agency: 'go', stopId: 'BURL_GO', lat: 43.3350, lon: -79.8067 },
  // Oshawa GO and the Durham bay outside it: ~145 m.
  { agency: 'go', stopId: 'OSH_GO', lat: 43.8735, lon: -78.8480 },
  { agency: 'durham', stopId: 'OSH_GO_DRT', lat: 43.8737, lon: -78.8462 },
  { agency: 'durham', stopId: 'OSH_DEST', lat: 43.8975, lon: -78.8658 },
  // A second GO platform at Burlington and a second Oshawa pair, so the budget test can
  // build two genuinely different journeys rather than two spellings of one.
  { agency: 'go', stopId: 'BURL_GO_2', lat: 43.3350, lon: -79.8102 },
  { agency: 'go', stopId: 'OSH_GO_2', lat: 43.8735, lon: -78.8560 },
  { agency: 'durham', stopId: 'OSH_DRT_2', lat: 43.8737, lon: -78.8578 },
  // 3 km from the Durham bay: past the cap, and the SECOND seam must refuse it.
  { agency: 'go', stopId: 'OSH_FAR', lat: 43.8735, lon: -78.8100 },
];

const BT_1 = ride({ agency: 'burlington', tripId: 'BT-1', boardStopId: 'BURL_LOCAL', alightStopId: 'BURL_GO_BT', departureMs: T0, arrivalMs: T0 + min(18) });
const GO_1 = ride({ agency: 'go', tripId: 'GO-LSW-1', boardStopId: 'BURL_GO', alightStopId: 'OSH_GO', departureMs: T0 + min(25), arrivalMs: T0 + min(90) });
const DRT_1 = ride({ agency: 'durham', tripId: 'DRT-1', boardStopId: 'OSH_GO_DRT', alightStopId: 'OSH_DEST', departureMs: T0 + min(100), arrivalMs: T0 + min(120) });

const opts3 = { paceMps: 1.3, limit: 3 };

test('THREE LEGS: Burlington to Oshawa resolves — local bus, GO train, Durham bus', async () => {
  const [it] = await stitchThreeLeg([BT_1], [GO_1], [DRT_1], GTA, opts3);
  assert.ok(it, 'three real legs exist and the app must stop refusing this journey');
  assert.deepEqual(it.legs.map((l) => l.tripId), ['BT-1', 'GO-LSW-1', 'DRT-1']);
  assert.equal(it.crossAgency, true);
  assert.equal(it.arrivalMs, T0 + min(120));

  // N-1 transfers, each stated on its own — never one number for the whole journey.
  assert.equal(it.transfers.length, 2);
  assert.equal(it.transfers[0].from.stopId, 'BURL_GO_BT');
  assert.equal(it.transfers[0].to.stopId, 'BURL_GO');
  assert.equal(it.transfers[0].waitSec, 7 * 60, '12:18 off the bus, 12:25 on the train');
  assert.equal(it.transfers[1].from.stopId, 'OSH_GO');
  assert.equal(it.transfers[1].to.stopId, 'OSH_GO_DRT');
  assert.equal(it.transfers[1].waitSec, 10 * 60);

  // Rule 1 holds at BOTH seams: every wait covers its own walk plus the slack floor.
  for (const t of it.transfers) {
    assert.ok(t.walkM > 0 && t.walkM <= TRANSFER_MAX_WALK_M, `walk ${t.walkM} m inside the cap`);
    assert.ok(t.waitSec >= t.walkSec + TRANSFER_MIN_SLACK_S,
      `a ${t.waitSec}s connection must cover a ${t.walkSec}s walk plus slack`);
  }
});

test('THREE LEGS: the walk cap is enforced at the SECOND seam, not just the first', async () => {
  const far = ride({ agency: 'go', tripId: 'GO-FAR', boardStopId: 'BURL_GO', alightStopId: 'OSH_FAR', departureMs: T0 + min(25), arrivalMs: T0 + min(90) });
  assert.deepEqual(await stitchThreeLeg([BT_1], [far], [DRT_1], GTA, opts3), [],
    'a 3 km hike between the last two legs is not a transfer, whichever seam it is on');
});

test('THREE LEGS: an unmakeable second connection is refused, timetable or not', async () => {
  // The Durham bus leaves 30 s after the train lands. The board permits it; a rider cannot.
  const tooSoon = ride({ agency: 'durham', tripId: 'DRT-SPRINT', boardStopId: 'OSH_GO_DRT', alightStopId: 'OSH_DEST', departureMs: T0 + min(90) + 30_000, arrivalMs: T0 + min(110) });
  assert.deepEqual(await stitchThreeLeg([BT_1], [GO_1], [tooSoon], GTA, opts3), []);
});

test('THREE LEGS: a truly impossible journey still refuses — nothing is fabricated', async () => {
  // The middle leg lands nowhere near anything the last leg departs from.
  const orphan = ride({ agency: 'go', tripId: 'GO-ORPHAN', boardStopId: 'BURL_GO', alightStopId: 'OSH_FAR', departureMs: T0 + min(25), arrivalMs: T0 + min(90) });
  const stranded = ride({ agency: 'durham', tripId: 'DRT-STRANDED', boardStopId: 'OSH_DEST', alightStopId: 'OSH_GO_DRT', departureMs: T0 + min(100), arrivalMs: T0 + min(120) });
  assert.deepEqual(await stitchThreeLeg([BT_1], [orphan], [stranded], GTA, opts3), []);

  // And the degenerate inputs, which must be silence rather than a throw.
  assert.deepEqual(await stitchThreeLeg([], [GO_1], [DRT_1], GTA, opts3), []);
  assert.deepEqual(await stitchThreeLeg([BT_1], [], [DRT_1], GTA, opts3), []);
  assert.deepEqual(await stitchThreeLeg([BT_1], [GO_1], [], GTA, opts3), []);
  assert.deepEqual(await stitchThreeLeg([BT_1], [GO_1], [DRT_1], [], opts3), []);
});

test('THREE LEGS: the same vehicle is never two legs of its own journey', async () => {
  const back = ride({ agency: 'go', tripId: 'GO-LSW-1', boardStopId: 'OSH_GO_DRT', alightStopId: 'OSH_DEST', departureMs: T0 + min(100), arrivalMs: T0 + min(120) });
  assert.deepEqual(await stitchThreeLeg([BT_1], [GO_1], [back], GTA, opts3), [],
    'trip GO-LSW-1 cannot also be the leg the rider transfers onto');
});

test('THREE LEGS: the total-time budget drops a detour, and keeps a merely slower option', async () => {
  // A second path to Oshawa through its own pair of stops, so the frontier prune (which
  // keeps the earliest arrival PER STOP) cannot be what decides this — only the budget can.
  const slowMid = (arriveMin: number) => ride({ agency: 'go', tripId: 'GO-MILKRUN', boardStopId: 'BURL_GO_2', alightStopId: 'OSH_GO_2', departureMs: T0 + min(25), arrivalMs: T0 + min(arriveMin) });
  const slowLast = (departMin: number) => ride({ agency: 'durham', tripId: 'DRT-2', boardStopId: 'OSH_DRT_2', alightStopId: 'OSH_DEST', departureMs: T0 + min(departMin), arrivalMs: T0 + min(departMin + 20) });

  // Best span is 120 min, so the budget is max(120 x 1.6, 120 + 45) = 192 min.
  const kept = await stitchThreeLeg([BT_1], [GO_1, slowMid(120)], [DRT_1, slowLast(130)], GTA, opts3);
  assert.equal(kept.length, 2, 'a 150-minute alternative is inside the budget and is offered');

  const dropped = await stitchThreeLeg([BT_1], [GO_1, slowMid(210)], [DRT_1, slowLast(220)], GTA, opts3);
  assert.deepEqual(dropped.map((i) => i.legs[1].tripId), ['GO-LSW-1'],
    'a 240-minute journey against a 120-minute one is a detour, not a second option');
});

// ---------------------------------------------------------------------------
// RULE 5: the search is polite and bounded. These pin the two mechanisms that
// stopped one rider's cross-region question from freezing the board for the
// whole city — and, just as importantly, that neither of them may change WHICH
// journeys come back.
// ---------------------------------------------------------------------------

/** A `breathe` that counts, and really does hand the event loop back each time. */
function countingBreath() {
  const state = { calls: 0 };
  return {
    state,
    breathe: async () => { state.calls++; await breathe(); },
  };
}

test('RULE 5: the two-leg join breathes — the event loop is handed back at the seam', async () => {
  const leg1 = [ride({ agency: 'miway', tripId: 'M1', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0, arrivalMs: T0 + min(15) })];
  const leg2 = [ride({ agency: 'ttc', tripId: 'T1', boardStopId: 'HUB_B', alightStopId: 'WORK', departureMs: T0 + min(22), arrivalMs: T0 + min(40) })];
  const b = countingBreath();

  const out = await stitchItineraries(leg1, leg2, STOPS, { ...opts, breathe: b.breathe });
  assert.equal(b.state.calls, 1, 'one seam, one breath — not zero');
  // And the answer is the SAME answer. A breath must never change what is found.
  assert.deepEqual(
    out.map((i) => i.legs.map((l) => l.tripId)),
    (await stitchItineraries(leg1, leg2, STOPS, opts)).map((i) => i.legs.map((l) => l.tripId)),
  );
});

test('RULE 5: a three-leg search breathes ONCE PER TIER, not once for the whole sweep', async () => {
  const b = countingBreath();
  const out = await stitchThreeLeg([BT_1], [GO_1], [DRT_1], GTA, { ...opts3, breathe: b.breathe });

  // Two seams are two joins, and the second is the expensive one — a search that
  // breathed only before the first would still hold the thread through the sweep
  // that actually costs the twenty seconds.
  assert.equal(b.state.calls, 2, 'both seams breathe, so no tier runs unbroken');
  assert.deepEqual(out[0].legs.map((l) => l.tripId), ['BT-1', 'GO-LSW-1', 'DRT-1'],
    'and the journey found is exactly the one found without breathing');
});

test('RULE 5: breathing is OPTIONAL, and a caller that omits it pays nothing', async () => {
  // No `breathe` in the options at all: the join must not invent one, and the result
  // must be identical. This is what keeps every other test in this file a pure unit.
  const three = await stitchThreeLeg([BT_1], [GO_1], [DRT_1], GTA, opts3);
  assert.equal(three.length, 1);
});

test('RULE 5: a fresh budget is unspent, and an exhausted one stays exhausted', async () => {
  let clock = 1_000;
  const budget = startSearchBudget(8_000, () => clock);
  assert.equal(budget.expired(), false, 'a search that just started has spent nothing');

  clock += 7_999;
  assert.equal(budget.expired(), false, 'one millisecond short of the wall is still inside it');

  clock += 1;
  assert.equal(budget.expired(), true, 'the wall is the wall');
  clock += 60_000;
  assert.equal(budget.expired(), true, 'and it never un-expires');
});

test('RULE 5: a zero budget is already spent — the expiry path is reachable in a test', async () => {
  // The property the API test leans on: `planBudgetMs: 0` forces the refusal branch
  // without a test that waits eight real seconds to get there.
  assert.equal(startSearchBudget(0).expired(), true);
  assert.equal(PLAN_SEARCH_BUDGET_MS, 8_000, 'the shipped wall, stated out loud');
});
