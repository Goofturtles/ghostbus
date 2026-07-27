# STATUS — Tier-0 dashboard (VERIFICATION.md governs what counts as green)

> ⚪ pending re-verification under the contract · 🟢 all lenses green with artifacts
> · 🔴 known red · ⛔ blocked externally
>
> Every 🟢 below traces to merged TESTLOG entries (tester draft + citation review +
> orchestrator adjudication). Rows without fresh contract-grade evidence stay ⚪ even
> where older evidence exists — prior artifacts are inputs, not passes.

| # | Tier-0 feature | T1 | T2 | T3 | Critic | Evidence (TESTLOG) |
|---|---|---|---|---|---|---|
| 1 | Nearby view (honest ETAs, evidence lines, Live/Scheduled, stop header, alert card) | 🟢 | 🟢 | ⚪ | 🟢 | Features rerun (render-asserted throughout) + Critic full-surface crops + R5 items 1/3/6 |
| 1b | **Delay/evidence pipeline (server)** — crosswalk learning, coverage gate, published obs, arrivals evidence | 🟢 | 🟢 | 🟢 | — | T1/T2/T3 + adjudications; identity crosswalk batch audit (7fdc6ab) |
| 2 | Ghost detection + Ghost Feed (Alerts) | ⚪ | ⚪ | ⚪ | ⚪ | Honest gate: 0 ghosts recorded — breaker suppresses while join rate matures; eval says so |
| 3 | Ghost Forecast chips + trust grades | ⚪ | ⚪ | ⚪ | ⚪ | Same gate; chip verified render-only via disclosed injection (R4) |
| 4 | Voxel map: city, route, vehicles, You beacon, stop pin, walk path, markers | 🟢 | ⚪ | — | ⚪ | T1: R5 items 1–6 + R4 sweep (beacon/pin/markers screenshot-level only). T2 merged evidence covers walk-path chaos alone; no contract-grade Critic map-vs-reference pass exists — pre-contract reference-match crops are inputs, not passes |
| 5 | Catch (leave-by + live verdict) | ⚪ | ⚪ | ⚪ | ⚪ | Scarce-not-unreachable on live data (R4 errata); injected-flow clean; needs a live-reach wave |
| 6 | Demo Mode (real fixture, identical pipeline, badge) | 🟢 | 🟢 | 🟢 | 🟢 | T1 (real board+badge) + T2 attack 3 (isolation) + T3 docs + Critic DEMO crops |
| 7 | PWA installability | ⚪ | ⚪ | ⚪ | ⚪ | Pre-contract offline-shell evidence only; SW cache verified incidentally in R4 |
| 8 | Light + dark themes, all surfaces | 🟢 | ⚪ | — | 🟢 | Critic 8-combination matrix + R5 both themes/viewports; no adversarial theme pass merged |
| 9 | Zero text collisions (§F law) | — | — | — | 🟢 | Critic §F 88/88 zero (citation-reviewed: 104/104 probe blocks) + R5 §F ×4 zero |
| 10 | Search + single-ride Plan | 🟢 | 🟢 | 🟢 | 🟢 | Features rerun all lenses + adjudications |
| 11 | i18n (en complete; fr-CA/es shipped) | 🟢 | — | 🟢 | 🟢 | Compile-enforced dict parity; accents restored + verified on screen; per-locale probes |
| 12 | Honest error attribution + out-of-range location | 🟢 | 🟢 | 🟢 | 🟢 | USER-REPORTED BUG closed: T1 reversal + T2 attacks + Critic attribution crops |
| 13 | Deploy (Render) + live keep-alive | ⛔ | ⛔ | ⛔ | — | Blocked on user accounts (Render; Neon quota). Local prod build verified end-to-end |

## R5 wave (user asks, 2026-07-27) — 8/8 GREEN, merged with adjudication
Street-following walk paths · instant city (first-painted-frame) · street labels ×17 ·
zero tree/building overlaps · voxel vehicles · §F zero · **MiWay end-to-end** (union
nearby/search, licence attribution, honest arrivals; Phase 1 complete at b974008) ·
zero console errors. Draft + artifacts: `.data/testlog-drafts/R5-verify.md`,
`.data/r5v-artifacts/`.

## Open items
- Rows 2/3 wait on the engine's own honesty gate (ghosts recording), not on code.
- Row 5 needs a live-reach test wave; row 7 a contract-grade PWA pass; row 1's T3 lens;
  row 4's T2 (beyond walk-path) and Critic map-vs-reference lenses; row 8's T2 lens.
- GTA Phase 2 (YRT→…→GO) awaits re-approval; GO needs a user Metrolinx key; DRT/Milton
  licence-blocked.
- Deploy (row 13) and Neon quota remain user decisions.

_Last updated: 2026-07-27 by the orchestrator after the R5 merge (3829f4d)._
