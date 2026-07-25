# GhostBus

**Every transit app predicts when the bus will come. GhostBus knows when it won't.**

An independent accountability engine for the Toronto Transit Commission, with a transit
app attached. It watches the published schedule and the published realtime feed, and it
tells riders when the two stopped agreeing — without waiting for the agency to admit it.

Repo layout, setup and run instructions: **see `README.md`.**

> **Author's note before submitting.** Every number below carries the moment it was measured,
> and the volatile ones are flagged inline with **[REFRESH]**: the observation count, the ghost
> count, the i18n string count, and the bundle sizes. Four workstreams were editing this repo
> while this was written, so re-verify anything marked **[REFRESH]** or **[IN PROGRESS]** and
> update or delete the line before you submit. Nothing here should reach a judge as an
> unverified claim — that is the whole thesis of the project.

---

## Creativity & Originality

### Related work — what already exists

Arrival prediction is a solved and crowded problem. Transit, Google Maps and Citymapper
all consume GTFS-realtime and answer *"when will the next bus arrive?"* well. GhostBus
does not compete there and does not claim to.

The interesting prior art is Chicago. CTA riders named the phenomenon — *ghost buses* —
and in 2025 the agency began publishing data on which scheduled runs were cancelled; the
Transit app now renders those runs with a line through the scheduled time
([WBEZ, 2025-08-04](https://www.wbez.org/transportation/2025/08/04/cta-canceled-bus-tracker-apps-ventra-transit)).
That is the right outcome. It is also a dependency: **it required the agency to confess.**
The strike-through appears because CTA chose to publish a cancellation feed. Where an
agency does not publish one — which is most agencies, including the TTC — riders get
nothing, and the phenomenon is invisible in the data even though it is extremely visible
at the shelter.

### What GhostBus claims is new

Four things, in combination, and stated as a claim rather than an absolute:

1. **Independent, agency-cooperation-free detection of vanished trips.** GhostBus infers a
   no-show by reconciling the published static schedule against the published vehicle and
   trip-update feeds. It needs no cancellation feed, no agency API, no partnership, and no
   permission. Chicago proved riders want this; GhostBus's contribution is not needing the
   confession to provide it.
2. **A historical accountability ledger**, not just a live status. Ghosts are recorded with
   their scheduled start, their detection time, and — crucially — the window in which the
   collector was demonstrably watching, so a rate computed from them has a real denominator.
3. **Prediction of future ghosts**, not just reporting of past ones: a per-`(route, hour-of-week)`
   risk rate, gated on sample size, surfaced only when it is genuinely elevated. Built and
   rendered — but honestly dormant, because it cannot fire until the ledger has ghosts in it
   (see Known limitations).
4. **Public receipts.** Every prediction the UI shows is accompanied by the evidence behind
   it, and any prediction without sufficient evidence is *withheld rather than softened*.

If a judge finds an app doing all four for an agency that publishes no cancellation feed,
that claim is wrong and we would want to know. We are not claiming nobody does this. We
are claiming this specific combination, done independently of the agency, is the
contribution.

### The second original thing: the honesty architecture is enforced by types, not by intent

`shared/types.ts` makes a trust grade optional and `server/src/api.ts` returns `null` for
it whenever the evidence bucket is `'none'`. An unevidenced prediction is not merely
discouraged — there is no shape for it to travel in. That constraint is what caught the
bug described under Technical Execution, in our own product.

---

## Impact

### The rider problem

A bus that is 20 minutes late and a bus that never runs feel identical from the shelter,
and current apps present them identically: a number that keeps refreshing. The rider's
actual decision — *keep waiting, or walk / cab / take the other route* — depends entirely
on which one it is, and that is exactly the information no app gives them.

Scale, for Toronto alone: TTC customers took **420 million trips in 2024**, of which
**204 million were on the bus network**
([TTC news release, 2025-04-10](https://www.ttc.ca/news/2025/April/34-billion-rides-and-counting)).

### Who is hurt most

Not the commuter with an alternative. The cost of a ghost falls hardest on people whose
next option is worse:

- Shift workers on late-evening and overnight service, where headways are 20–30 minutes and
  the "just take the next one" fallback costs half an hour, not five minutes.
- Riders who cannot walk to a parallel route — the reason GhostBus stores an accessibility
  flag on every service alert (**11 of the 64 alerts** currently stored are
  accessibility-flagged) and why a ghosted *accessible* departure has its own copy string
  rather than being folded into the generic case (`web/src/i18n/en.ts`, `ghost.accessibleNever`).
- Riders for whom a cab is not a fallback at all. For them, the schedule is the service.

### The accountability gap

This is the part that is not a UX problem.

The TTC measures on-time performance **at end terminals**: a vehicle counts as on time if it
departs a terminal within a window of roughly one minute early to five minutes late. There is
no published measurement of schedule adherence anywhere else along the route. Transit
advocate Steve Munro puts the consequence plainly: most riders do not board at terminals, so
service quality is not measured where riders actually see it
([Steve Munro, 2025-01-23](https://stevemunro.ca/2025/01/23/delving-into-ttc-on-time-performance/)).
The rider-advocacy group TTCriders reached the same finding in its report *Lucky or late:
A report on TTC metrics vs. rider experience* (November 2025), which documents that the TTC
does not publicly report whether vehicles hold to schedule along the route
([TTCriders](https://www.ttcriders.ca/bunchingreport)).

So the metric that governs the service is measured at the two points where almost nobody
boards. **The stop you are standing at is not measured, by anyone.** GhostBus's ledger is an
attempt to measure it from the outside, from public data, at the stop.

### Our own numbers — measured, and honestly qualified

These are GhostBus's own figures, not external statistics. Collection window and caveats
attached to each.

| Ours | Value | Window / caveat |
|---|---|---|
| Static schedule loaded (Neon Postgres) | 2,151,105 stop_times · 68,401 trips · 9,361 stops · 233 routes · 1,374 shapes | TTC GTFS board **2026-07-26 – 2026-09-05** |
| Live vehicles tracked | 1,488 with positions in one snapshot; 1,520–1,630 per cycle across `.data/collector.log` cycles 470–529 | **`.data/` and `*.log` are gitignored and are not in a fresh clone.** Quote a range, not a round number — the fleet in service varies by hour |
| Delay observations stored | **947** (post-purge), all written after 2026-07-25 02:02 UTC | Peaked at 312,696 before the purge. **Every row, before and after, is information-free — see Technical Execution. [REFRESH] after the code fix and re-collection.** |
| Service alerts stored | 64 (11 accessibility-flagged) | same window |
| Ghosts recorded | **0** | An honest zero. The loaded board does not activate until 2026-07-26, so no trip has yet been due, so nothing can yet have failed to arrive. **[REFRESH]** |
| Aggregate buckets built | 81,182 stop-hour · 1,430 route-hour | Trailing 14-day window; every bucket currently has p25 = p50 = p75 = 0 for the reason above |

The zero in that table is the most important number in this document. It would have been
trivial to seed a plausible-looking ghost count. The system is built so that it cannot.

---

## Technical Execution

### The pipeline: memory-first by design

One Node process. A poller runs **inside** the Fastify API (`server/src/poller.ts`,
started by `server/src/server.ts`), so there is exactly one thing to deploy —
`render.yaml` declares a single `type: web` service against an external Neon Postgres.

Every 45 seconds the poller fetches three public TTC GTFS-realtime feeds
(`bustime.ttc.ca/gtfsrt/{vehicles,trips,alerts}`; no key, no registration) and then makes a
deliberate split:

- **Raw pings stay in memory.** Current vehicle positions live in a `Map` with a short ring
  buffer and are evicted after 10 unseen cycles. They are *never written to Postgres*. At
  1,500 vehicles every 45 seconds, persisting raw pings would be ~2.9M rows a day of data
  nobody queries — and, worse, would make the interesting table 99% noise.
- **Only distilled facts are persisted**: delay observations at *passed* stops, the current
  service-alert snapshot, and confirmed ghosts.

Idempotency is enforced by the database, not by trust: `trip_delay_obs` has
`UNIQUE (agency, trip_id, stop_id, service_date)` and every insert is `ON CONFLICT DO NOTHING`.
A process-local in-memory dedupe sits in front of it to avoid pointless round-trips during a
run; it is empty after a restart, which is exactly why the DB constraint — not the cache — is
what actually guarantees correctness across restarts. Retention is 14 days.

### The evidence gates

`server/src/eta.ts` is 77 lines and is the product's spine. An estimate is
`scheduled + median historical delay`, banded P25–P75, and the bucket that supplies those
percentiles is chosen by hard thresholds:

```
(route, stop, hour_of_week)  needs n >= 8    -> bucket 'stop-hour'
(route, hour_of_week)        needs n >= 20   -> bucket 'route-hour'
otherwise                                     -> estimate is null, bucket 'none'
```

When the bucket is `'none'` the API returns `null` for every numeric field and the UI
renders *"schedule only — not enough live history yet"*. Percentiles are computed in JS
(`percentileCont`, matching Postgres `percentile_cont`, unit-tested) specifically so the
numbers are byte-identical on the `pg` and PGlite drivers.

Trust grades (`GRADE_TIERS`: A needs n≥40 and ≤±4 min spread, down to D at n≥8 / ≤±14 min, E
for evidenced-but-untiered) and the Ghost Forecast (`GHOST_RISK_MIN_N = 8`, elevated above an
8% rate, high above 20%) are pure, exported, unit-tested functions in `server/src/api.ts`,
served by the API and rendered in `web/src/components/DepartureRow.tsx`. A departure with
bucket `'none'` gets **no grade object at all** — the UI renders an untracked dash rather than
inventing a letter (`screenshots/phase5/departures-untracked-390-dark.png`, where *every* row is
untracked). The forecast chip, though built, **cannot fire until ghosts exist** — limitation 2.

### The identity join — built against a feed that fights it

Ghost detection needs to know which scheduled trips are currently running. The obvious key
does not exist on this feed. Measured, reproducibly:

- **TTC realtime `trip_id` matches static `trip_id` ~0.1%** (1,920 sampled, 2 matched —
  `collect.log`). RT trip ids are negative integers like `-1711785711`.
- **`TripDescriptor` carries no `start_time` and no `start_date`**, so the textbook
  `(route_id, start_date, start_time)` key is impossible as written.
- **`route_id` does match** (174 of 175 distinct RT route ids present in static `routes`).
- **`scheduleRelationship = 8`** appears on some entities — not a value in the GTFS-realtime
  enum. Undocumented semantics, so we do not act on it.
- **Zero standard `CANCELED` entities.** TTC publishes none, and its CANCELED-shaped entities
  carry no stop-time updates, so they are *anonymous* — they cannot be placed on a schedule.
  We count them and never guess (`canceledUnidentified`).
- **No conditional-request support.** No `ETag`, no `Last-Modified`, and a conditional
  re-request returns 200, never 304.

So the join (`server/src/join.ts`, pure and unit-tested) reconciles on the schedule itself:
per stop, a reconstructed scheduled second must agree with a static `departure_s` within
**±75 s**, and a static trip is only claimed when **≥ 2 stops agree**. One agreeing stop is
coincidence; two on the same route is signal. Claims are 1:1 and greedy by vote count; a top
tie is left unmatched and counted as ambiguous rather than guessed.

Ghosts are then both **confirmed and retractable**: a due trip must be absent for **2
consecutive cycles** before a row is written, and if it is later claimed inside its due window
the ghost row is **DELETEd** and the retraction logged. Two circuit breakers sit on top — a
global breaker suppressing any cycle that would flag >30% of due trips, and a per-route
breaker for routes with ≥4 due trips — because a mass no-show is far more likely to be a feed
outage or our bug than reality.

### The missing-`delay` discovery — a bug we shipped, and the best thing in this submission

Mid-build, the collector's first-generation logic trusted the feed's `StopTimeEvent.delay`
field. The GTFS-realtime spec is unambiguous about what that field means: *"Delay of 0 means
that the vehicle is exactly on time."*
([GTFS-realtime reference](https://gtfs.org/documentation/realtime/reference/)).

Our collector recorded 304,697 observations, every one of them saying "exactly on time". The
reason is more interesting than an agency publishing bad data.

**The TTC does not publish the `delay` field at all.** Measured live on a snapshot of 23,165
stop-time events:

```
stopTimeEvents:        23165
delay present on wire:     0     (hasOwnProperty)
time  present on wire: 23165
delay reported as != null: 23165 ← the trap
```

GTFS-realtime is proto2, where `delay` is an `optional int32` whose default is `0`, and
protobuf.js materialises that default on the decoded message's prototype. **A decoded event
answers `0` for a field it never received.** So the collector's idiomatic, apparently-defensive
guard — `if (delay != null)` — passed on all 23,165 events and wrote a measurement for a
quantity the feed never sent. Nobody lied. A correct-looking null check silently converted
*missing data* into *confident data*, three hundred thousand times.

Two consequences, both live in the product before anyone noticed:

1. **The observations measured nothing.** Every row in `trip_delay_obs` had `delay_s = 0`, so
   every stop-hour and route-hour aggregate bucket had `p25 = p50 = p75 = 0`. Buckets cleared
   the `n >= 8` and `n >= 20` evidence gates comfortably — **so the UI rendered "±0 min · 21
   observations" as though it were evidence.** The gate held perfectly. The input was hollow.
2. **The join was circular.** It reconstructed scheduled time as `predicted − delay`. With
   `delay` always zero that reduces to `scheduled = predicted` — the join was matching the
   feed's own predictions against themselves and scoring the agreement as a match.

**How it was caught:** by re-measuring a believed-true assumption against the live feed instead
of trusting the build reports, which were accurate about what the code did and silent about
whether it meant anything. Verified two independent ways — `hasOwnProperty` on the decoded
event, and `toObject({ defaults: false })`.

**The point, for anyone evaluating AI-assisted work:** an honesty architecture is worthless
unless someone verifies it against reality. The evidence gates did their job flawlessly and
still produced a lie, because a gate tests sample size and spread — not whether the samples
mean anything. And the specific trap here is not an AI failure mode at all; it is a protobuf
default-value trap that has caught experienced engineers for a decade. What the process
contributed was the habit of going back to the wire to check.

**Remediation — status, stated exactly, verified against the database.** The fix is to stop
asking the agency how late its buses are and measure it ourselves:

```
delay = predicted absolute time (realtime feed)
      − scheduled absolute time (our own static GTFS, for that trip and stop)
```

Both sides of that subtraction are real, published data.

**Status at 2026-07-24 22:02 ET, from a direct query:**

- The **purge has run.** `trip_delay_obs` dropped from 312,696 rows to **947**, all written
  after 02:02:09 UTC.
- The **code fix has not merged.** `server/src/poller.ts` still reconstructs from the feed's
  `delay` and still writes it, so those 947 fresh rows are **also all zero** (min 0, max 0),
  and the table is refilling with the same information-free data. The 494 rebuilt aggregate
  buckets are likewise all-zero.
- `README.md` describes the purge and the fix together in the past tense. **The purge half is
  true; the code half is not yet.**

**[REFRESH] — this is the highest-priority item before submitting.** Merge the delay
computation, purge again, re-collect, then replace every observation and aggregate figure in
this document with real post-fix values. Do not soften this section. Being the people who
wrote down the discrepancy is worth far more to this audience than a clean number that does
not survive a `SELECT`.

### Performance, measured from the build output

| Asset | Gzipped | Note |
|---|---|---|
| Initial JS (`dist/assets/index-*.js`) | **79,305 B** | 247,600 B raw |
| Initial CSS | 5,318 B | |
| Lazy map chunk (`MapCard-*.js`) | 255,119 B | `React.lazy`; never in the initial budget |
| Lazy map CSS | 10,017 B | |

Measured with `gzip -9` over `dist/assets/` on 2026-07-24. `DECISIONS.md` §23 records 79.6 KB
and 256.6 KB from an earlier build of the same bundles; the small difference is build drift,
not a disagreement about method. **[REFRESH]** after the final build.

Every live vehicle in the viewport renders through **one MapLibre symbol layer**, not DOM markers. Sprites are
drawn procedurally on an offscreen canvas (`web/src/map/sprites.ts`) and cached per
`(kind, colour)` — the live TTC feed contains only 4 distinct route colours, so ≤ 8 images
total. Each poll eases vehicles old→new over 1.2s via `requestAnimationFrame`, mutating **one
reused GeoJSON FeatureCollection in place** with a single `setData` per frame; the rAF loop
stops when nothing is animating. A jump > 500 m snaps and fades rather than sliding across the
city. `prefers-reduced-motion` turns position animations into instant transitions and camera
flights into cuts.

**Polling provably pauses when the tab is hidden.** Every timer is gated on `!document.hidden`
— map vehicles at 5s, health 20s, arrivals 30s, alerts and ghosts 60s
(`web/src/map/MapCard.tsx`, `web/src/hooks/useLive.ts`). Verified: over 11 seconds hidden,
**0** vehicle fetches; **1** on resume.

### Security and hygiene

`@fastify/helmet`, CORS locked to same-origin plus localhost dev origins, rate limiting at
120 req/min on all routes, every parameter validated (bbox side capped at 3°, radius capped
at 3 km, query ≤ 64 chars, `at=` rejected before 2020 or beyond +30 days), uniform JSON errors
with no stack traces, and parameterised SQL everywhere. **There are no API keys anywhere in
this project** — the TTC feeds are unauthenticated and OpenFreeMap requires no key,
registration or token ([OpenFreeMap](https://openfreemap.org/)). `.env` is gitignored and has
never been committed.

### Where to read more

Status as of 2026-07-24 21:50. **[REFRESH]** — two of these were still being written by a
parallel workstream; confirm before citing any of them on a submission page.

| Document | Contains | Status |
|---|---|---|
| `METHODS.md` | Join algorithm, evidence gates, ghost confirmation/retraction, the feed measurements | **Present** |
| `SECURITY.md` | AppSec checklist with verification commands, and unfixed findings listed as findings | **Present** |
| `CREDITS.md` | Every dependency and asset with its licence | **Present** |
| `DECISIONS.md` | Every non-obvious choice and every deviation, numbered §1–§26 | **Present** |
| `BLOCKERS.md` | Empirically measured feed limitations | **Present** |
| `TOOLKIT.md` | Every dependency, verified to exist before use | **Present** |
| `ARCHITECTURE.md` | Process model, data flow, schema | **Present** |
| `README.md` | Setup, run, repo tour, deploy, AI disclosure | **Present** |

---

## Thoughtfulness of Design

### Verifiable copy: "never arrived" is a fact, "isn't coming" is a prediction

`web/src/lib/ghostCopy.ts` exists to hold exactly one decision, and it is deliberately its own
module with its own unit test rather than an inline ternary in a component:

- `'ghost'` → **"7:26 — never arrived."** We watched a scheduled, due trip. It did not show up.
  A statement about the past, which we can defend.
- `'cancelled'` → **"7:26 — cancelled by the agency."** The agency said so, on the record.

A detected ghost must never be described as "cancelled": we do not know *why* it did not come,
only that it did not. And a cancellation must never be dressed up as a no-show, because the
agency owned it publicly and deserves the credit for saying so. Every user-facing sentence in
the app was written against that test — is this a fact we observed, or an inference we are
making, and does the sentence say which?

### "Catch", not "Go"

The primary action on a live departure is labelled **Catch** (`row.catch`). It was **Go**. In
Toronto, GO is a different transit agency — GO Transit runs the regional network — so a button
reading "GO" on a Toronto transit app names a competitor at the exact moment the rider is
deciding what to do. Nobody outside Toronto would catch this, which is precisely why it is
worth mentioning: local correctness is not a detail you can outsource to a style guide.

### Scheduled rows get "View route", not a tracking promise the data cannot keep

A departure with no live trip-update cannot be tracked. It would have been easy — and normal —
to show the same "Catch"/"Track" affordance on every row and let it fail quietly. Instead
`web/src/components/DepartureRow.tsx` branches on `dep.liveEtaMs != null`: live rows get
**Catch** with a live pill; scheduled-only rows get a quiet **View route** and a `Scheduled`
pill. The label promises exactly what the data can deliver. You can see both states in
`screenshots/phase3/mobile-dark-scrolled.png`.

**Honest caveat on that, found in review:** the *labels* are correct, but in this build
neither action is wired to a destination — `App.tsx` mounts `NearbyPanel` without an
`onCatch` handler, and `onOpen` currently switches to the `Plan` tab, which is a placeholder.
Catch Mode is designed, not built (see the table below), so pressing the button does not yet
take you anywhere. The row is telling the truth about the *data*; it is not yet telling the
truth about the *destination*, and that is a real gap rather than a deliberate choice.
**[REFRESH]** — re-check before submitting.

### The tiered reality contract: a small correct core instead of a large broken one

The design covers considerably more than what shipped. Rather than half-wiring all of it, the
build drew a hard line and **the app itself discloses where the line is** — the `Plan` tab
renders *"Trip planning is designed — it isn't wired up in this build yet."* That is a shipped
product string (`web/src/i18n/en.ts`, `plan.body`), translated into all three locales, not a
caveat buried in a README. A user who never reads this document still learns where the edge is.

The line moved during the build, which is worth saying plainly: the `Alerts` tab carried the
same kind of disclosure until the Ghost Feed panel landed late in development, and its copy is
now a description of a working feature. **[REFRESH]** — re-check what each tab renders before
submitting, because a stale disclosure is worse than no disclosure.

### Honest states everywhere else, too

- **Empty states tell the truth about *why*.** With the loaded board not active until 2026-07-26,
  the Nearby view says *"No departures in the next 90 minutes / This stop's live board isn't
  active yet — here's its scheduled service"* and then walks forward day by day to find and
  label the genuine next service day — **SUN, JUL 26** — rather than showing the first plausible
  future day it finds (see `DECISIONS.md` §15, Phase-4 amendment; visible in
  `screenshots/phase4/desktop-dark-nearby.png`).
- **Skeletons shaped like real rows**, not spinners, so the layout does not jump.
- **Feed failure is a first-class state**: the header pill stops saying `Live`, and a banner
  says the TTC feed is unreachable and that you are looking at scheduled times.
- **Map tiles failing** flips a *"Map tiles unavailable — showing list only"* overlay over the
  ground colour, so a slow tile never flashes a checkerboard.
- **The walk path is honestly a straight line.** There is no routing engine in this tier, so the
  path from You to the boarding stop is a beaded as-the-crow-flies indicator — deliberately not
  drawn as a street-following route it isn't.
- **Two complete themes.** The light theme is a real daylight map style hand-painted for
  navigational contrast (`web/src/map/mapStyle.ts`), not an inverted dark theme.
- **Three complete locales**: en, fr-CA, es — **250 leaf keys each** (counted 2026-07-24
  21:50; the count grew from 218 to 250 during this document's drafting) **[REFRESH]**, with parity
  enforced by the type system (`const frCA: Dict = {...}` where `Dict = typeof en`), so a
  missing translation is a compile error rather than an English string leaking into a French UI.
- **The map canvas is `aria-hidden` and keyboard-inert on purpose**: the departures list is the
  accessible path, and a focus trap on a GL canvas would be worse than no focus at all.

---

## Presentation & Clarity

### How to navigate this repo

Start with `README.md` for setup. Then, depending on what you want to check:

| If you want to check… | Read |
|---|---|
| The claim that predictions are gated on evidence | `server/src/eta.ts` (77 lines) and `server/src/eta.test.ts` |
| How a trip is identified without a shared `trip_id` | `server/src/join.ts` + `server/src/join.test.ts` |
| Ghost confirmation, retraction, circuit breakers | `server/src/poller.ts`; `DECISIONS.md` §14, §18, §20, §22 |
| The API contract | `shared/types.ts` — one file, both sides, heavily commented |
| That the feed really behaves as claimed | **Reproduce it in one command, no clone artifacts needed** (see the box below). `.data/` and `*.log` are gitignored, so `.data/feedprobe.cjs` and `collector.log` exist on the build machine but **not in a fresh clone** — every figure sourced from them in this document is labelled with where it came from. |
| What we could not do and why | `BLOCKERS.md` — every entry is an empirical measurement, not a guess |
| Every deviation from the original plan | `DECISIONS.md` — 26 numbered sections, including the ones that make us look bad |

The two files worth reading if you only read two: **`BLOCKERS.md`** and **`DECISIONS.md`**.
They are the project's actual record.

### Verify the central claim yourself, in about ten seconds

The missing-`delay` finding is the load-bearing measurement in this submission, so here it is
with no dependency on our repo, our database, or our word. It hits the public TTC feed directly
and — importantly — distinguishes *present-and-zero* from *absent-and-defaulted*, which is the
whole point:

```bash
npm i gtfs-realtime-bindings
node -e "const g=require('gtfs-realtime-bindings');fetch('https://bustime.ttc.ca/gtfsrt/trips').then(r=>r.arrayBuffer()).then(b=>{const f=g.transit_realtime.FeedMessage.decode(Buffer.from(b));let n=0,onWire=0,notNull=0,t=0;for(const e of f.entity)for(const s of e.tripUpdate?.stopTimeUpdate||[]){const v=s.departure||s.arrival;if(!v)continue;n++;if(Object.prototype.hasOwnProperty.call(v,'delay'))onWire++;if(v.delay!=null)notNull++;if(Object.prototype.hasOwnProperty.call(v,'time'))t++;}console.log({stopTimeEvents:n,delayOnWire:onWire,timeOnWire:t,delayReportedNotNull:notNull});})"
```

No key, no registration, no account. Expected: **`delayOnWire: 0`** while `timeOnWire` equals
the event count and `delayReportedNotNull` *also* equals the event count. That gap between the
last two numbers is the bug, reproducible on anyone's machine in ten seconds. Totals drift run
to run; the gap does not.

### AI-use disclosure

**GhostBus was built with Claude Code**, using a spec-driven, evidence-gated process. We are
disclosing this as a strength, and here is the specific argument.

The failure mode of AI-assisted work is exactly the failure mode this project is about:
**confident output with no verification underneath it.** A model will happily generate a
collector that reports "304,697 observations collected" and a build report that says the
milestone is complete, and both statements will be true, and the data will still mean nothing.
That is not a hypothetical — it is what happened here, and it is documented above in full.

What made it recoverable was structural, not motivational:

- **Every dependency was verified to exist before use.** `TOOLKIT.md` records the `npm view`
  check and the actually-installed version for every package — a direct countermeasure to
  hallucinated packages.
- **Every empirical claim was measured, then written down with its measurement.**
  `BLOCKERS.md` exists because a probe was run against the live feed, not because a model
  believed something about GTFS.
- **Every deviation from the plan was recorded rather than quietly absorbed.** `DECISIONS.md`
  §12 documents that the specified join key was *impossible on this feed* and what replaced it.
- **The honesty architecture was applied to the tooling, not just the product.** The rule "no
  prediction renders without its evidence" is the same rule as "no build report is believed
  without a query against the database." One of those caught the other.

The honesty architecture and the AI-verification discipline are not two practices. They are one
practice pointed in two directions, and the delay-zero bug is the proof: the product's refusal
to show an unevidenced number is what made an unevidenced number worth going to look for.

**What a human decided**, for the record: the tiered scope cut (ship a small correct core), the
"never arrived" vs "cancelled" copy rule, the Go → Catch rename, the choice to publish a ghost
count of zero rather than manufacture a demo, and the decision to write this section instead of
omitting it.

---

## What's built vs designed

| Feature | Status | Where to verify |
|---|---|---|
| Static GTFS seed into Postgres (2.15M stop_times) | **Built** | `server/src/seed_toronto.ts`; `BLOCKERS.md` |
| 45s collector, 3 TTC realtime feeds, memory-first | **Built** | `server/src/poller.ts`; `.data/collector.log` |
| Honest-ETA engine with evidence gates | **Built** | `server/src/eta.ts`, `eta.test.ts` |
| Identity join without a shared `trip_id` | **Built** | `server/src/join.ts`, `join.test.ts` |
| Ghost confirm-over-2-cycles + retraction + breakers | **Built** (dormant until the board activates 2026-07-26) | `server/src/poller.ts` |
| Fastify API, poller in-process, one deployable service | **Built** | `server/src/server.ts`, `render.yaml` |
| Nearby view, live MapLibre map, voxel sprites, markers | **Built** | `screenshots/phase4/*` |
| Both themes, en/fr-CA/es, skeletons, honest empty states | **Built** | `screenshots/phase3/*`, `web/src/i18n/*` |
| Route shape endpoint + real GTFS route line | **Built** | `GET /api/routes/:routeId/shape` |
| Service alerts incl. accessibility flagging | **Built** | 64 stored, 11 flagged |
| Trust grades (A–E) | **Built** — served by the API and rendered as a chip, with an explicit **untracked** dash when there is no evidence. Every departure is untracked today, for the reason in limitation 1 | `GRADE_TIERS` in `server/src/api.ts`, `web/src/components/DepartureRow.tsx`, `screenshots/phase5/departures-untracked-390-dark.png` |
| Ghost Forecast chips | **Built, but dormant** — `ghostRiskFor` is served and rendered, and **cannot fire until ghosts exist** (limitation 2). Do not demo it as working until it has real input | `server/src/api.ts`, `web/src/components/DepartureRow.tsx` |
| Ghost Feed UI | **Built** — today/week ghost + cancelled counters, ghost event cards, honest empty state, service-alerts list. **Renders `0 / 0` today, correctly (limitation 2)** | `web/src/components/AlertsPanel.tsx`, `GET /api/ghosts/feed`, `screenshots/phase5/alerts-ghostfeed-390-dark.png` |
| PWA — manifest, icons, service worker | **Built** — registered at startup **in production builds only** (`pwa.ts` guards on `import.meta.env.PROD`, so it never registers under `vite dev`) | `web/src/pwa.ts`, `web/public/sw.js`, `manifest.webmanifest`, `screenshots/pwa/*` |
| Demo Mode | **[IN PROGRESS 2026-07-24]** — recorder + replay source written and unit-tested; **not yet wired into the poller**, and no web component consumes the `DEMO` badge string | `server/src/record_demo.ts`, `demo.ts` |
| Ride Mode | **Designed, not built** | copy exists in `web/src/i18n/en.ts` (`ride.*`) |
| Plan / "Where to?" routing | **Designed, not built** | app says so: `plan.body` |
| Saved places | **Designed, not built** | app says so: `saved.body` |
| Catch Mode's full guided choreography | **Designed, not built** | `catch.*` strings only |
| Focused Boarding Mode | **Designed, not built** | — |
| 3D voxel building city | **Deliberately deferred** | `DECISIONS.md` §23 |
| Vancouver / multi-city coverage engine | **Removed** — Tier 0 is Toronto-only | `DECISIONS.md` §10 |
| Transit Passport | **Designed, not built** | `settings.passport` string only |
| Rider Evidence (crowd reports) | **Designed, not built** | — |
| Offline schedule-slice cache | **Designed, not built** | — |
| Capacitor Android shell | **Designed, not built** | — |

---

## Known limitations

Listed because a reviewer will find them anyway, and because a limitation you found yourself is
worth more than one someone found for you.

1. **The delay signal is currently hollow, and the code fix is not merged.** Every stored
   observation has `delay_s = 0`, because the TTC feed omits `delay` entirely and protobuf's
   proto2 default supplies a `0` the collector recorded as a measurement. The bad rows were
   purged, but `server/src/poller.ts` still reads the same defaulted field, so the table is
   refilling with zeros. Until the computation changes, every evidence count in the app counts
   information-free rows. This is the single largest caveat in the project. **[REFRESH]**
2. **Ghost count is 0 and will stay 0 until 2026-07-26.** The published TTC board covers
   2026-07-26 – 2026-09-05, so on the build date there is no calendar-active service, no trip is
   due, and nothing can be a no-show. Ghost detection, the ghost ledger, forecasts and any
   accountability number derived from them are **genuinely inert** until the board activates.
   The mechanism is unit-tested; it has not yet been exercised against live due trips.
3. **The identity join's measured live rate is 0.0%**, for the same clock-vs-board reason: the
   currently-running RT trips belong to the pre-Jul-26 board, which is not in our static data.
   An independent probe found 3.8% of trips get exactly one coincidental vote and 0% get the
   required two — the ≥2-vote threshold is doing exactly what it was built to do. The join
   becomes near-exact once the clock falls inside the loaded board period.
4. **Anonymous cancellations surface as ghosts.** TTC publishes no standard `CANCELED` entities,
   and its cancellation-shaped entities carry no stop-time updates, so they cannot be placed on
   a schedule. An officially-cancelled but anonymous trip will therefore read as "never arrived"
   rather than "cancelled by the agency". This is a feed limitation; the `kind='cancelled'` path
   activates with no code change if TTC ever publishes identifiable cancellations.
5. **The API read-path caches static data at boot.** The poller hot-reloads calendar and trip
   data on service-day rollover and every 6h; the API's route/calendar caches do not, so after a
   board re-seed, arrivals can serve stale schedule metadata until the process restarts
   (`DECISIONS.md` §19).
6. **Toronto only.** One agency, one timezone, one feed dialect. The multi-city engine was
   deleted rather than left half-working (`DECISIONS.md` §10). Every measured feed quirk above is
   a TTC quirk; none of it is claimed to generalise.
7. **The walk path is a straight line**, not a walking route. There is no routing engine.
8. **Web-only, foreground-only.** No background tracking, no push notifications; the app says as
   much in its own copy (`ride.keepOpen`).
9. **Seeded schedule is windowed by default** to service active in the next 7 days
   (`GHOSTBUS_SEED_WINDOW_DAYS`), so schedules beyond the window are absent until a re-seed.
   `GHOSTBUS_SEED_FULL=1` loads all 2,151,105 rows.
10. **Single-operator scale.** All figures come from one collector process against one Neon free-tier
    instance (pool capped at 4 connections) over a single afternoon. Nothing here has been load-tested.

---

## Credits and data sources

- **Static schedule:** *TTC Routes and Schedules*, City of Toronto Open Data Portal —
  https://open.toronto.ca/dataset/ttc-routes-and-schedules/ (GTFS ZIP, refreshed monthly per the
  portal's metadata; confirm the licence terms on the portal page at submission).
- **Realtime:** TTC GTFS-realtime feeds at `bustime.ttc.ca/gtfsrt/{vehicles,trips,alerts}` —
  unauthenticated, no key.
- **Map tiles:** OpenFreeMap (OpenMapTiles schema) over OpenStreetMap data — no registration, no
  API keys — https://openfreemap.org/. Attribution is rendered permanently expanded in the app.
- **Specification:** GTFS-realtime reference — https://gtfs.org/documentation/realtime/reference/
- Full dependency provenance: `TOOLKIT.md`. Further credits: **see `CREDITS.md`.**
