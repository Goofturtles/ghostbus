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
| 4 | Voxel map: city, route, vehicles, You beacon, stop pin, walk path, markers | ⚪ | ⚪ | ⚪ | ⚪ | screenshots/reference-match/final4–6/, DECISIONS §38–42 |
| 5 | Catch (leave-by + live verdict) | ⚪ | ⚪ | ⚪ | ⚪ | web/src/lib/catch.test.ts (runs since bc17ed4) |
| 6 | Demo Mode (real fixture, identical pipeline, badge) | ⚪ | ⚪ | ⚪ | ⚪ | 37227e2; 12 tests; Sunday fixture re-record in flight; badge in flight (R1) |
| 7 | PWA installability | ⚪ | ⚪ | ⚪ | ⚪ | manifest+sw shipped 6cf12d7; offline-shell screenshots |
| 8 | Light + dark themes, all surfaces | ⚪ | ⚪ | ⚪ | ⚪ | 8-combination probe matrix (prior runs) |
| 9 | Zero text collisions (§F law) | ⚪ | ⚪ | ⚪ | ⚪ | trueOverlaps:0 across 8 combos (prior runs; re-run with search sheet OPEN pending) |
| 10 | Search + single-ride Plan | ⚪ | ⚪ | ⚪ | ⚪ | screenshots/features/; landing in flight (R1) |
| 11 | i18n (en complete; fr-CA/es shipped) | ⚪ | ⚪ | ⚪ | — | Dict parity typechecked; per-locale probe runs |
| 12 | Honest error attribution + out-of-range location | 🔴 | 🔴 | 🔴 | ⚪ | USER-REPORTED BUGS, fix in flight (R1): 429→"can't reach TTC" mislabel; silent location swallow |
| 13 | Deploy (Render) + live keep-alive | ⛔ | ⛔ | ⛔ | — | Blocked: no Render account; Neon quota (task #32). Local prod build is the interim target |

## Open reds / in-flight (builders; testers queue on landing)
- **R1 — Reliability + features builder**: rate-limit rescope, three-state honest error
  attribution, out-of-range location state, orphaned search/Plan landing, demo-API
  integration (AGENCY hardcode blocker), amber DEMO badge, Sunday fixture.
- **R2 — Coverage-gate builder**: binding-corroborated crosswalk promotion (measure
  first; gate itself untouchable). Engine publishes nothing until this clears — every
  evidence-line feature (rows 2, 3) waits on it.
- **R3 — `npm run eval`**: does not exist yet (spec requires an honest backtest, even if
  the answer is "thin data"). Unassigned.
- **R4 — Console errors**: zero-console-error sweep not yet run under the contract.

_Last updated: 2026-07-26 ~15:20 ET by the orchestrator. No green exists yet by design —
the first tester wave runs when R1/R2 land._
