# STATUS — Tier-0 dashboard (VERIFICATION.md governs what counts as green)

> ⚪ pending re-verification under the contract · 🟢 all three tests green with artifacts
> · 🔴 known red · ⛔ blocked externally
>
> **Honest baseline (2026-07-26):** substantial prior evidence exists (probe tables,
> screenshots, measurement panels) but NONE of it was produced under the
> builder≠tester / three-lens regime, so every feature starts ⚪, not 🟢. Prior
> artifacts are linked as input for the test agents, not as passes.

| # | Tier-0 feature | T1 | T2 | T3 | Critic | Prior evidence |
|---|---|---|---|---|---|---|
| 1 | Nearby view (honest ETAs, evidence lines, Live/Scheduled, stop header, alert card) | ⚪ | ⚪ | ⚪ | ⚪ | screenshots/reference-match/final2/, §F probe results.json |
| 1b | **Delay/evidence pipeline (server)** — crosswalk learning, coverage gate, published obs, arrivals evidence | 🟢 | 🟢 | 🟢 | — | TESTLOG: T1/T2 entries + T3 rerun (supersedes the RED); adjudication note |
| 2 | Ghost detection + Ghost Feed (Alerts) | ⚪ | ⚪ | ⚪ | ⚪ | engine live (due=627, bindings=341); gated by coverage — see R2 |
| 3 | Ghost Forecast chips + trust grades | ⚪ | ⚪ | ⚪ | ⚪ | gated: zero obs until coverage clears (R2) |
| 4 | Voxel map: city, route, vehicles, You beacon, stop pin, walk path, markers | 🔴 | 🔴 | 🔴 | 🔴 | USER ACCEPTANCE REDs (2026-07-26 eve, testing live app): buildings slow to appear; streets not all labeled; trees/buildings overlap; buses not voxel 3D; walk path cuts through buildings. Fix wave R5 dispatched. Prior: screenshots/reference-match/final4–6/, DECISIONS §38–42 |
| 5 | Catch (leave-by + live verdict) | ⚪ | ⚪ | ⚪ | ⚪ | web/src/lib/catch.test.ts (runs since bc17ed4) |
| 6 | Demo Mode (real fixture, identical pipeline, badge) | 🟢 | 🟢 | 🟢 | 🟢 | TESTLOG: T1 rerun (fresh GHOSTBUS_DEMO=1 instance serves real board/search/plan/shape), T2 rerun attack 3 (isolation + ghost-feed join, direct SQL), T3 rerun (agency seam + §45(c)), Critic rerun (badge/banner/provenance crops, 29 stops) |
| 7 | PWA installability | ⚪ | ⚪ | ⚪ | ⚪ | manifest+sw shipped 6cf12d7; offline-shell screenshots |
| 8 | Light + dark themes, all surfaces | ⚪ | ⚪ | ⚪ | ⚪ | 8-combination probe matrix (prior runs) |
| 9 | Zero text collisions (§F law) | — | — | — | 🟢 | Probe-instrumented row (the §F probe IS the test): Critic rerun measured 0 overlaps/0 hScroll/0 clipHits/0 clipped descenders across 88 contexts (11 states × 8 combos, search sheet open included); citation review independently re-swept all 104 probe blocks — zero non-zero |
| 10 | Search + single-ride Plan | 🟢 | 🟢 | 🟢 | 🟢 | TESTLOG: T1 rerun (real search, plan ride, magnifier fix), T2 rerun attacks 1/5 (stale-geometry repro + variants, rate-limit boundary), T3 rerun (plan-geometry state machine vs spec), Critic rerun (RED-1..4 fixed, "matches reference" crops) |
| 11 | i18n (en complete; fr-CA/es shipped) | ⚪ | ⚪ | ⚪ | — | Dict parity typechecked; per-locale probe runs |
| 12 | Honest error attribution + out-of-range location | 🟢 | 🟢 | 🟢 | 🟢 | WAS the user-reported RED. TESTLOG: T1 rerun (429 renders server-busy copy, blame-regex negative is real; out-of-coverage honest card), T2 rerun (server-down/kill-resume attacks), T3 rerun (attribution contract vs §45), Critic rerun (RED-5 hue fix + attribution crops both locales) |
| 13 | Deploy (Render) + live keep-alive | ⛔ | ⛔ | ⛔ | — | Blocked: no Render account; Neon quota (task #32). Local prod build is the interim target |

## Open reds / in-flight (builders; testers queue on landing)
- **R1 — RESOLVED**: reliability + features batch landed (5ba1bbf, d8ba413, 5ea35f3,
  bba517f) and survived the full rerun wave — rows 6/10/12 green above, TESTLOG entries
  with adjudications.
- **R2 — RESOLVED**: pattern-level time-domain validation shipped; coverage cleared the
  50% gate (47.3→68.5%); observations flowing (67,448 qualifying obs in the trailing
  14-day window per the eval run). Rows 2/3 remain ⚪ pending their own tester wave —
  ghosts are still honestly suppressed by the mass-ghost breaker (0 recorded).
- **R3 — RESOLVED**: `npm run eval` exists (b5b4fb4) and ran against a snapshot of the
  live DB: ghost backtest honestly not-runnable (0 ghost events); honest-ETA
  calibration 50.1% inside own P25-P75 vs ~50% expected. Output:
  `.data/eval-run-20260726.txt`.
- **R4 — Console errors**: zero-console-error sweep IN FLIGHT under the contract.
- **R5 — USER ACCEPTANCE WAVE (open)**: from the user testing the live app — (a) GTA
  coverage expansion, MiWay first (the "no TTC stops within 800 m" card is honest but
  coverage-wrong); (b) instant voxel-city load; (c) every street labeled; (d) walk
  paths follow streets, never through buildings; (e) voxel 3D buses; (f) tree/building
  overlap fix. Row 4 red above; builders dispatched.

_Last updated: 2026-07-26 ~18:15 ET by the orchestrator. First greens exist: rows 1b,
6, 9, 10, 12 — each with three-lens TESTLOG entries, citation reviews, and
adjudications. Deploy (row 13) still ⛔ on user accounts._
