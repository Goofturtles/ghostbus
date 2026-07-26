# TESTLOG — append-only evidence ledger (see VERIFICATION.md)

Format per entry — a green with no artifact path is invalid by definition:

```
## <feature> — <T1|T2|T3|CRITIC|MODEL|INTEGRATION> — <GREEN|RED> — <date time TZ>
Agent: <name/role> (builder was: <name> — must differ)
Build under test: <commit sha> · <production build command used>
Repro: <exact commands / URL / viewport / locale / spoofed location>
Assertions: <what was checked, with measured values>
Artifacts: <paths: logs, screenshots, traces>
Verdict notes: <one paragraph; a RED names the exact failure and hands it to the builder>
```

Rules of evidence (from VERIFICATION.md, restated so no tester misses them):
- Assert the app actually rendered before trusting any probe — a 429/error page scores
  a perfect zero on every DOM check.
- Production builds only (`npx vite build` + server on pglite3); dev servers have lied
  about the map before.
- PGlite is single-writer: never open a dir a live server holds; never hard-kill.
- Rate budget is shared per-IP on localhost: probe bursts starve the user's session —
  space them, and never run a tester against the user's :8799 instance.

_No entries yet. First wave queues when builders R1/R2 land (see STATUS.md)._
