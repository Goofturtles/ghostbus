# TOOLKIT.md — verified dependencies

Package honesty rule: every dependency below was verified to exist with
`npm view <pkg> version` before use, and the version column records what actually
installed (from `node_modules/<pkg>/package.json`) after `npm install`.

## Runtime dependencies added for Milestone 0

| Package                   | Range in package.json | Installed | Verified via `npm view` | Purpose |
|---------------------------|-----------------------|-----------|-------------------------|---------|
| `pg`                      | `^8.22.0`             | 8.22.0    | 8.22.0                  | node-postgres Pool — production/Neon driver |
| `@electric-sql/pglite`    | `^0.5.4`              | 0.5.4     | 0.5.4                   | embedded Postgres (WASM) — zero-signup local fallback |
| `adm-zip`                 | `^0.6.0`              | 0.6.0     | 0.6.0                   | extract the TTC static GTFS zip |
| `csv-parse`               | `^7.0.1`              | 7.0.1     | 7.0.1                   | stream-parse GTFS CSVs (ships its own types) |
| `gtfs-realtime-bindings`  | `^1.1.1` (pre-existing)| 1.1.1    | 2.1.0 (latest) also verified | decode GTFS-realtime protobuf |

## Dev dependencies added

| Package            | Range      | Installed | Verified | Purpose |
|--------------------|------------|-----------|----------|---------|
| `@types/pg`        | `^8.20.0`  | 8.20.0    | 8.20.0   | types for pg |
| `@types/adm-zip`   | `^0.5.8`   | 0.5.8     | 0.5.8    | types for adm-zip |

`tsx` (4.23.1) and `typescript` (5.9.3) were already in the project and run the
TS directly (`npm run seed:toronto`, `npm run collect`).

## Deliberately NOT added (dependency-free choices)

- **Timezone math** — used the built-in `Intl.DateTimeFormat` (IANA `America/Toronto`)
  instead of `date-fns-tz`. `date-fns-tz@3.2.0` was verified to exist, but Intl handles
  EST/EDT and DST transitions natively with zero dependencies. See `server/src/tz.ts`.
- **.env loading** — used Node's built-in `process.loadEnvFile()` (no `dotenv`).
- **HTTP** — used the global `fetch` + `AbortController` (Node 24), no `axios`/`node-fetch`.

## Notes on `gtfs-realtime-bindings` version

The pre-existing scaffold pinned `^1.1.1`; the current latest is `2.1.0` (verified).
The decode surface this project uses — `transit_realtime.FeedMessage.decode`,
`TripDescriptor.ScheduleRelationship.CANCELED`, `Alert.Effect` / `Alert.Cause` —
is identical across both majors, so the pin was left at `^1.1.1` to avoid disturbing
the existing `server/live.ts`. The collector was run and verified against 1.1.1.
