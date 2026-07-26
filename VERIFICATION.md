# VERIFICATION CONTRACT (governs HOW work is done; the Reality Contract governs WHAT is built)

Nothing is "done" because an agent says so — **done means stored evidence.** Verification
depth is constant; only scope is tiered.

## Roles
1. **BUILDER** — implements, in Reality Contract tier order. Never tests or approves its
   own work. Commits by explicit path.
2. **TEST AGENTS ×3 per feature** — three lenses, independently run, never the builder:
   - **T1 Functional** — happy path against real live data; every spec'd state
     (Live / Scheduled / stale / ghost) reproduced.
   - **T2 Adversarial** — feed down, empty responses, offline, kill-and-resume mid-flow,
     malformed input, rate-limit hammering, 2 a.m. no-service.
   - **T3 Spec-fidelity** — verbatim copy rules ("never arrived", "Updated Xs ago"),
     every prediction shows its evidence line, thresholds gate correctly, i18n intact
     across en / fr-CA / es.
   A feature passes only when all three log green in `TESTLOG.md` **with repro commands
   and artifact paths**. Any red → BUILDER fixes → **all three rerun from scratch.**
3. **DESIGN CRITIC** — after EVERY visual change: renders 390×844 light+dark and
   1280×800, compares against `ghostbus-design-reference.png` + the Apple/Transit rules,
   inspects **zoomed element crops** for the zero-collision law (an overlap is a blocking
   red), files concrete diffs ("row gap 6px, spec says 9px"), loops with BUILDER until
   crops can be captioned "matches reference."
4. **MODEL/SCENE AGENT** — voxel vehicles, map styling, instanced city: rendered colors
   vs sampled palette hexes, silhouettes at spec sizes, 60fps DevTools trace in budget.
5. **INTEGRATION AGENT** — end-to-end journeys: cold open → answer in 3 s, zero taps;
   Catch verdict flips as simulated positions move; ghost detection fires on the fixture;
   Demo Mode runs the full loop. Deploy check after every merge (see Deploy note).

## Cadence per milestone
build → T1/T2/T3 → Design Critic → Model check (if visual) → Integration → deploy →
screenshot pack. **Never advance a milestone with an open red.**

## Definition of done (the whole app)
`STATUS.md` lists every Tier-0 feature with three green marks + log links, Critic
sign-off crops, the deployed URL with a fresh timestamp, honest `npm run eval` output,
zero console errors, zero collisions. Claiming completion = showing that dashboard plus
an annotated screenshot walkthrough. **Anything red is named, never claimed around.**

## Integrity rules
- No agent marks its own work green. The tester of a feature is never its builder.
- No green without a stored artifact (log, screenshot, or trace) at a path in TESTLOG.md.
- A fabricated pass invalidates the feature; it restarts from T1.
- Known instrument traps every tester must honour: **assert the app rendered before
  trusting any probe** (a 429 page scores a perfect zero); dev servers lie about the map
  (verify production builds); PGlite is single-writer (never open a dir a server holds;
  never hard-kill a holder); measure at matched scale against the reference, structure
  before histograms.

## Deploy note (honest status)
Render does not exist yet — the user has not created the account, and Neon is
quota-blocked (task #32). Until then the "deploy check" target is the local production
build (`npx vite build` + `node --import tsx server/src/server.ts` on pglite3), and
STATUS.md carries deploy as an explicit RED/BLOCKED row rather than pretending.
