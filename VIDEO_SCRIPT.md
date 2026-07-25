# GhostBus — demo video script

**Target runtime: 2:45. Hard ceiling: 3:00.**
Captioned. Clean audio. No music bed under narration (or −24 LUFS if used).

Narration is written to be spoken at ~150 words per minute. Each beat lists its word
budget; if a take runs long, cut words, not the honesty caveats.

> **Read the pre-flight checklist at the bottom before you record anything.** Several shots
> here are only legal to film if a specific condition is true on the day, and this repo moved
> under the script while it was being written — features landed, copy changed, and the central
> finding was re-framed once. Every such shot carries its condition and a documented honest
> fallback. Shooting the preferred take when its condition is false would be the exact failure
> this project exists to argue against.

---

## Beat map

| # | Beat | In | Out | Length |
|---|------|----|-----|--------|
| 1 | Cold open — the ghost moment | 0:00 | 0:10 | 10s |
| 2 | The one-liner | 0:10 | 0:20 | 10s |
| 3 | Live core loop, real timestamp on screen | 0:20 | 1:00 | 40s |
| 4 | A forecast chip and its evidence line | 1:00 | 1:25 | 25s |
| 5 | Receipts — open data, and the bug we caught in ourselves | 1:25 | 2:05 | 40s |
| 6 | What's built vs what's designed | 2:05 | 2:15 | 10s |
| 7 | Architecture | 2:15 | 2:30 | 15s |
| — | Close | 2:30 | 2:45 | 15s |

Total 2:45, leaving 15s of headroom under the 3:00 ceiling.

---

## Beat 1 — Cold open: the ghost moment (0:00–0:10, 23 words ≈ 9s)

**On-screen action**
Real-world footage, no app. A bus shelter at dusk. Static locked-off shot. A person
checks their phone, looks up the empty street, checks the phone again. Cut on the second
look-up. Timecode or a wall clock visible in frame if you can get one naturally.

**Narration**
> "The app said seven minutes. That was eleven minutes ago. The bus is still coming —
> according to the app. It is not coming."

**B-roll / capture notes**
- Shoot this yourself at a real TTC stop, or use licensed stock. **Do not** fabricate an
  app screen showing a phantom arrival — see pre-flight rule P-2.
- Keep it silent except for street ambience. The line lands harder over near-silence.
- Cut to black for 4 frames before Beat 2.

---

## Beat 2 — The one-liner (0:10–0:20, 14 words ≈ 6s + a 1.5s hold)

**On-screen action**
Black card, then the wordmark. `GhostBus` in the app's own type (screenshot the top-left
lockup from `screenshots/phase4/desktop-dark-nearby.png` or re-render it at 4K).
The one-liner types on in two lines.

**Narration**
> "Every transit app predicts when the bus will come. GhostBus knows when it won't."

**B-roll / capture notes**
- Hold 1.5s of silence after "won't" before the next beat's audio starts.
- On-screen text must match the spoken line word for word — judges read faster than you talk.

---

## Beat 3 — Live core loop with the real data timestamp (0:20–1:00, 91 words ≈ 36s)

**On-screen action**
Screen capture of the running app, desktop dark theme, exactly the state in
`screenshots/phase4/desktop-dark-nearby.png`.

1. (0:20) The Nearby view. Map card, every TTC vehicle in the viewport drawn as a voxel
   sprite (roughly 15 in this frame; the collector tracks ~1,500 fleet-wide per cycle —
   **do not say "1,500" over a shot showing 15**), the **You** beacon with
   "You · 1 min walk", the boarding-stop pin, the beaded walk path.
2. (0:28) **Click the `Live` pill, then push in on the freshness stamp it opens.** The
   stamp lives inside the pill's popover (`web/src/components/Primitives.tsx`) and is in
   neither reference screenshot, so you have to click it — do not plan a shot that assumes
   it is already visible. This is the beat's required proof; the timestamp must be legible
   at 1080p. Safer alternative, or in addition: cut to a terminal running
   `curl -s localhost:8799/api/health | jq` and hold on `lastPollAtMs` and `serverNowMs`.
3. (0:38) Click a vehicle. The red route line snaps in along the real GTFS shape with the
   real intermediate stop dots — as in `screenshots/phase4/mobile-dark-selected.png`.
4. (0:50) Scroll the sheet down. **Expect the honest empty state, not a departures list** —
   until the board activates on 2026-07-26 this stop reads *"No departures in the next 90
   minutes"* followed by *"NEXT SCHEDULED SERVICE — SUN, JUL 26"*. That is a feature, and
   the narration below treats it as one. If you are shooting on or after 2026-07-26, a real
   departures list should appear here instead; re-cut the last line accordingly.

**Narration**
> "This is Nearby. Every vehicle on this map is a real TTC bus or streetcar, from a feed we
> poll every forty-five seconds — and the app stamps how fresh it is, on screen, from the
> server's clock rather than the browser's. Select one and GhostBus draws its actual route
> shape from the published schedule. No sampled points, no smoothing. And when there is
> nothing to show, it says so: this stop's board doesn't start until Sunday, so instead of
> inventing a countdown, it tells you the real next service day."

**B-roll / capture notes**
- Record at 60fps. The sprite easing is a 1.2s interpolation per poll; at 30fps it reads
  as a stutter rather than as motion.
- The map's attribution control — "OpenFreeMap · OpenMapTiles · © OpenStreetMap" — is
  always expanded and must stay in frame. It is a licence condition, and cropping it out
  on camera is the sort of thing an audience of reviewers notices.
- Do not speed-ramp this section. A judge counting frames should be able to confirm the
  poll cadence.

---

## Beat 4 — A forecast chip and its evidence line (1:00–1:25, ≤60 words ≈ 24s)

> **CONDITIONAL BEAT. Read this before shooting.**
> A Ghost Forecast chip only renders when a `(route, hour-of-week)` cell clears
> `GHOST_RISK_MIN_N = 8` scheduled trips inside hours the collector demonstrably watched
> **and** the ghost rate exceeds 8% (`server/src/api.ts`). As of 2026-07-24 the ghost
> table holds **zero rows** — the loaded GTFS board does not activate until **2026-07-26**,
> so nothing has been due, so nothing can have gone missing. There is no honest forecast
> chip to film today. Shoot **Take A** only if the condition below is met; otherwise shoot
> **Take B**, which is always legal and is arguably the better beat for this audience.

### Take A — only if a chip is rendering from real rows

**Condition to verify on the day:** `GET /api/ghosts/feed` returns `counters.weekGhosts > 0`,
**and** a departure in `GET /api/stops/:id/arrivals` actually carries a `ghostRisk` object.
Screen-record the API response next to the UI so the chip and its source agree on camera.

**On-screen action:** push in on the departure row. The risk chip and, directly beneath it,
the evidence chip: `±X min · N observations`.

**Narration**
> "This run is flagged. Ghost risk: high — it has vanished four of the last twenty-two
> times it was scheduled, in hours we were actually watching. Underneath is the evidence
> line: plus or minus three minutes, based on sixty-one observations from the last
> fourteen days. Read them out loud, because GhostBus will not show you the number
> without them."

*(Replace every figure above with what is literally on screen. Do not round in your
favour. Do not narrate a number the chip does not display.)*

### Take B — the honest fallback (shootable today, and the stronger beat)

**On-screen action:** two shots, both of which exist as real captures.
1. The departures list (`screenshots/phase5/departures-untracked-390-dark.png`). Every row
   shows an **untracked dash** where a trust grade would go, and the grey line
   **"schedule only — not enough live history yet"**. Push in on one row.
2. Cut to the Alerts tab (`screenshots/phase5/alerts-ghostfeed-390-dark.png`): the Ghost
   Feed reading **0 Ghosts, 0 Cancelled** for today and this week, with
   *"No ghosts right now — the schedule is telling the truth."*
Then a two-up: the UI on the left, `server/src/eta.ts` on the right with
`STOP_HOUR_MIN_N = 8` and `ROUTE_HOUR_MIN_N = 20` highlighted.

**Narration**
> "This is what a forecast looks like when we haven't earned it. Eight observations at this
> stop and hour, or twenty across the route — under that, GhostBus returns null and the row
> says schedule only. Same rule on the ledger: zero ghosts, so it says zero. Most apps would
> have shown you a number."

**B-roll / capture notes**
- Either take: hold the evidence line on screen for at least 3 seconds. It is small type.
- Never composite a chip into a screenshot. If it isn't rendering, it isn't in the video.

---

## Beat 5 — Receipts, and the bug we caught in ourselves (1:25–2:05, 81 words ≈ 32s)

**On-screen action**
1. (1:25) Split screen: the Toronto Open Data page for *TTC Routes and Schedules* on the
   left, a terminal on the right.
2. (1:33) **Run the wire probe live on camera** (the one-liner published in `DEVPOST.md`
   § Presentation & Clarity). Hold on the output. The three numbers that must be legible:
   ```
   stopTimeEvents:        23165
   delayOnWire:               0   <- the field is never sent
   delayReportedNotNull:  23165   <- what our decoder answered
   ```
3. (1:45) Cut to a two-line code inset: `if (delay != null) { … }` with a caption reading
   *"proto2 optional int32, default 0"*. This is the actual bug, in one frame.
4. (1:55) Cut to a `psql`/script window: every row in `trip_delay_obs`, one distinct value
   of `delay_s`, and that value is zero.

**Narration**
> "Everything here is open data — Toronto's published schedule, Toronto's published
> realtime feed, no keys, no scraping. Which is how we found this. The TTC never sends the
> delay field at all. But it's an optional integer that defaults to zero, so our decoder
> answered zero, twenty-three thousand times, and our null check waved every one of them
> through. Three hundred thousand observations that said 'exactly on time' and measured
> nothing. A correct-looking null check turned missing data into confident data."

**B-roll / capture notes**
- **Run the probe live.** A pre-recorded terminal is worth a fraction of a live one to this
  audience. Event totals drift run to run (23,165 / 23,335 / 23,371 across recorded runs) —
  **the invariant is `delayOnWire: 0` alongside a non-zero `delayReportedNotNull`.** Narrate
  the gap between those two numbers, and read whatever totals are actually on screen.
- **Get the framing right; an earlier draft of this script got it wrong.** Do NOT say "the
  TTC publishes delay zero". The TTC publishes *no delay field whatsoever* — the zero is
  manufactured by protobuf's proto2 default and materialised by protobuf.js on the decoded
  message. That distinction is the entire finding, it is more flattering to the agency and
  more damning of our own code, and this panel will know the difference.
- The terminal must not show `DATABASE_URL`. `.data/feedprobe.cjs` reads only the public
  feed, but the DB script in step 3 reads `.env` — scrub the frame or pipe through a
  wrapper that prints only the aggregate row. See pre-flight rule P-6.
- On-screen caption over step 4: `SELECT count(*), count(DISTINCT delay_s) FROM trip_delay_obs`
  → a row count beside a distinct count of **1**. **Run the query live and read what it
  returns**, because the count moves: it peaked at 312,696, was purged to 947, and is
  refilling. The distinct count of one is the part that does not move.
- **Status check before you record.** At 2026-07-24 22:02 ET: the purge **has** run, and the
  code fix **has not** — `server/src/poller.ts` still reads the defaulted `delay`, so the
  table is refilling with zeros. `README.md` describes the purge and the fix together in the
  past tense; only the purge half is true. Before shooting, re-check both, and narrate
  whichever is true on the day. **Do not say "and we fixed it" until `poller.ts` computes
  delay as predicted-minus-our-own-scheduled-time and a fresh query shows more than one
  distinct value.** See pre-flight rule P-4.

---

## Beat 6 — What's built vs what's designed (2:05–2:15, 24 words ≈ 10s)

**On-screen action**
Tap through the app's own tabs on mobile. `Plan` shows the app's real placeholder copy:
*"Trip planning is designed — it isn't wired up in this build yet."* Then `Saved`:
*"Star a stop from its header and it'll live here."* Then a static card listing the tiers.

**Narration**
> "Nearby, the map, the ETA engine and the collector are built. Trip planning and ride
> mode are designed, not built. Multi-city we deleted. The app says so."

**B-roll / capture notes**
- This is a real screen recording, not a slide. The `Plan` disclosure is shipped in the
  product (`web/src/i18n/en.ts`, key `plan.body`), which is the point.
- **Do not use the `Alerts` tab for this beat.** Its copy changed during the build: it is
  now a real Alerts + Ghost Feed panel (`web/src/components/AlertsPanel.tsx`) and
  `alerts.body` reads *"Trips that never came, and what the agency has said about it."* —
  which is a description of a working feature, not a disclosure. Verify what that tab
  actually renders on shoot day before pointing a camera at it.
- Say "deleted", not "designed", about the multi-city engine: it was removed in Phase 2
  (`DECISIONS.md` §10), which is a stronger and more accurate claim than "not built".
- Do not smash-cut past this beat. Ten honest seconds here buys the other 155.

---

## Beat 7 — Architecture (2:15–2:30, 36 words ≈ 14s)

**On-screen action**
One diagram, animated in three strokes:
`TTC GTFS-realtime ×3 → poller (45s, in-process) → memory: live vehicles │ Postgres: distilled observations, alerts, ghosts → Fastify API → React SPA`
Then a one-second cut to `render.yaml` showing a single `type: web` service.

**Narration**
> "One process. The poller runs inside the API, so there's one thing to deploy. Raw feed
> pings stay in memory, never written to Postgres — only distilled observations, alerts and
> confirmed ghosts. Two-point-one million schedule rows sit behind it."

**B-roll / capture notes**
- Draw the diagram fresh; do not screenshot a whiteboard.
- Optional one-frame flash of `screenshots/phase4/desktop-light-fullscreen.png` to prove
  the light theme is a real second theme and not an inverted filter.

---

## Close (2:30–2:45, 34 words ≈ 14s)

**On-screen action**
Return to the live app, wide. Wordmark lower third. Repo URL and `README.md` on screen —
it now exists, alongside `ARCHITECTURE.md`, `METHODS.md`, `SECURITY.md`, `CREDITS.md`,
`DECISIONS.md`, `TOOLKIT.md` and `BLOCKERS.md`. Name a file on camera only after you have
seen it; this list was accurate at 2026-07-24 22:05 and the repo was moving fast.

**Narration**
> "GhostBus doesn't need the agency to admit a bus was cancelled. It watches the schedule,
> watches the street, and tells you when they stop agreeing. Everything's in the repo —
> including what isn't finished."

---

## Pre-flight checklist

Tick every line before the first take. Anything unticked is a reshoot, not a fix in post.

### Must be on screen
- [ ] **P-1.** A real, server-sourced data timestamp during Beat 3 — the `Live` pill plus
      either the freshness stamp or `/api/health` (`lastPollAtMs`, `serverNowMs`). Legible
      at 1080p on a laptop screen.
- [ ] The map attribution control, expanded: "OpenFreeMap · OpenMapTiles · © OpenStreetMap".
      Licence condition; never crop it.
- [ ] The evidence line under whichever departure row you feature (Beat 4, either take).
- [ ] The app's own "designed, not built" placeholder copy (Beat 6), read from the running app.
- [ ] Live terminal output for the feed probe (Beat 5), not a still.

### Must NOT be on screen
- [ ] **P-2.** No staged or composited ghost. `ghosts` currently holds **0 rows** and the
      loaded board does not begin until **2026-07-26**. Do not mock a "never arrived" row,
      do not edit one into a screenshot, do not describe one as if it were on screen.
- [ ] **P-3.** No `DEMO` badge anywhere in a shot where the narration says "live". Demo Mode
      is all-or-nothing per process (`server/src/demo.ts`): once a process serves one demo
      byte it is a demo process for its whole lifetime, and every result is labelled.
      **As of 2026-07-24 there is no Demo Mode footage to shoot at all** — the recorder and
      replay source are written and unit-tested but the module wires into nothing (its own
      header says so), and no web component consumes the `status.demoBadge` string. If it
      has been wired by shoot day, the amber `DEMO` badge and the recorded-notice must be
      visible for the entire duration of any demo footage and the narration must say
      "recorded", never "live".
- [ ] **P-4.** No claim that the zero-delay data was purged and recomputed unless you have
      confirmed it **both** in `server/src/poller.ts` and by querying the database on shoot
      day. As of 2026-07-24 21:50 the fix is **specified, not merged**, and the table held
      **306,091 rows, every one `delay_s = 0`** — still growing. Note that `METHODS.md` §3.3
      already states the purge as done; the database disagrees. Trust the database.
- [ ] **P-5.** No forecast chip, trust grade, or Ghost Feed row on camera unless it renders
      from **real data** at shoot time. These were in active development while this script was
      written and the ground shifted mid-draft: the PWA (manifest, icons, service worker,
      registered at startup) and the Ghost Feed panel both landed and are now **built**, while
      forecast chips and trust grades remained pure functions awaiting real inputs. **Confirm
      each one's status yourself before pointing a camera at it.** Note especially that the
      Ghost Feed is built and correct and will render *empty* today — if you film it, film the
      empty state and say why it is empty. An empty ledger you can explain is a stronger shot
      than a full one you cannot.
- [ ] **P-6.** No secrets in frame: `DATABASE_URL`, the Neon connection string, `.env`
      contents, shell history containing either. Use a fresh terminal profile with an empty
      history and a prompt that does not include the repo path if that path is personal.
- [ ] No numbers spoken that do not appear on screen, and none rounded in GhostBus's favour.
- [ ] No claim of the form "no other app does this". The defensible framing is in
      `DEVPOST.md` § Creativity & Originality; use that wording verbatim if you improvise.

### Technical
- [ ] 60fps capture for all app footage (sprite animation is a 1.2s ease).
- [ ] 1920×1080 minimum; mobile shots framed from a real device viewport, not a scaled desktop.
- [ ] Audio: single voice, close mic, no room reverb, normalise to −16 LUFS mono.
- [ ] Total runtime ≤ 3:00 measured on the exported file, not on the timeline.

---

## Caption and accessibility notes

- **Burned-in captions plus a sidecar `.srt`.** Burned-in survives platforms that strip
  caption tracks; the sidecar keeps the text machine-readable and translatable.
- **Caption every word of narration**, and caption the meaningful on-screen text that the
  narration does not read aloud — the terminal output in Beat 5 and the placeholder copy in
  Beat 6 especially.
- **Contrast and placement:** white text on a 60%-opacity black plate, bottom-centre, at
  least 4.5:1 against the plate. Never place captions over the evidence line, the timestamp,
  or the attribution control.
- **Do not rely on colour alone.** The `Live` pill is green and the route line is red; the
  narration and captions must state what they mean, since roughly one viewer in twelve with
  a Y chromosome will not distinguish them reliably.
- **Read every number aloud** that matters to a claim. A screen-reader user consuming the
  audio track alone should get the same evidence a sighted viewer gets.
- **No flashing.** Nothing in this cut should flash more than three times per second; keep
  the Beat 7 diagram strokes slow.
- **Describe, briefly, what the cold open shows** — "a rider at an empty bus shelter" — in
  the video description, since Beat 1 has no narration over its first seconds.
- If you publish an audio-described version, the natural insert points are the 1.5s pause
  after Beat 2 and the 4 frames of black before it.

---

## Notes for whoever records this

- The app's copy discipline is load-bearing and it is easy to break by improvising. "Never
  arrived" is a statement of fact about something we watched. "Isn't coming" is a
  prediction. Do not swap them, and never say "cancelled" about a detected ghost — the
  agency cancelling a trip and a trip simply not showing up are different claims, and
  `web/src/lib/ghostCopy.ts` exists specifically to keep them apart.
- The primary action on a live departure is labelled **Catch**, not **Go**. In Toronto, GO
  is a different transit agency. If you say "hit Go" on camera, a Toronto judge will hear
  a different app.
- Everything in this script is checkable in the repo. If a shot you want isn't, cut the shot.
