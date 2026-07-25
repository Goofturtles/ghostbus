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

## Runtime dependencies added for Phase 2

| Package            | Range in package.json | Installed | Verified via `npm view` | Purpose |
|--------------------|-----------------------|-----------|-------------------------|---------|
| `@fastify/cors`    | `^9.0.1`              | 9.0.1     | 9.0.1 (v9 = Fastify 4)  | CORS locked to same-origin + localhost dev |
| `@fastify/helmet`  | `^11.1.1`             | 11.1.1    | 11.1.1 (v11 = Fastify 4)| security response headers |

`@fastify/rate-limit@^9.1.0` and `@fastify/static@^7.0.4` were already present (both Fastify-4
compatible) and are reused by the API. Fastify is pinned at `^4.28.1`, so the Fastify-4 majors
(cors 9, helmet 11) were chosen over the Fastify-5 majors (cors 10+, helmet 12+).

**Removed in Phase 2:** `three` + `@types/three` (imported nowhere — dead; the old voxel scene
was deleted). See DECISIONS.md §10.

## Dev dependencies added (Milestone 0)

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

## Vibe Coder Toolkit — every named resource, and what actually happened

The spec names eight front-end resources, each with an assigned job, and requires that
**every toolkit integration is either real or explicitly substituted here — zero
hallucinated packages or components.**

**The honest headline: none of the eight were used. Zero of them are installed.**
Verified by direct filesystem check of `node_modules` — `@rive-app/react-canvas`,
`animejs`, `motion`, `framer-motion`, `kokonutui`, `magicui`, `reactbits`, `limora` and
`bklit` are all **absent**. The entire interface was hand-built. This table records each
substitution rather than leaving the line item silent.

| # | Resource | Assigned job | Outcome |
|---|---|---|---|
| 1 | **KokonutUI** (kokonutui.com) | Pre-built React/Tailwind UI blocks | **Not used.** The project has no Tailwind and no component library at all. Every surface — `NearbyPanel`, `DepartureRow`, `StopHeader`, `TabBar`, `TopBar`, `SettingsSheet`, `AlertsPanel`, the skeletons and the empty states — is a hand-written React component over three hand-written CSS files (`tokens.css`, `global.css`, `app.css`). The design is a transit-specific dark UI with a live map; generic marketing blocks had nothing to contribute to it. |
| 2 | **Magic UI** (magicui.design) | Animated marketing/landing components | **Not used.** GhostBus has no landing page. It opens directly on the Nearby view — the app *is* the pitch. There was no surface for animated hero components to live on. |
| 3 | **React Bits** (reactbits.dev) | Animated React component snippets | **Not used.** The animated pieces this app needs are domain-specific and had no off-the-shelf equivalent: the ~1,500-vehicle MapLibre symbol layer eased between polls on a single reused GeoJSON FeatureCollection, and the voxel sprites drawn procedurally to an offscreen canvas in `web/src/map/sprites.ts`. |
| 4 | **Anime.js** | Timeline/keyframe animation | **Not used.** Substituted by native CSS `@keyframes` (5 in `app.css`) plus `requestAnimationFrame` for the one case CSS cannot express — per-frame interpolation of vehicle positions across a live GeoJSON source. A JS animation library would have added weight to do less. |
| 5 | **Motion** (motion.dev) | React animation primitives | **Not used.** Substituted by four declared easing tokens in `tokens.css` — `--ease-standard: cubic-bezier(0.4,0,0.6,1)`, `--ease-out: cubic-bezier(0.16,1,0.3,1)`, `--ease-spring: cubic-bezier(0.28,0.11,0.32,1)`, `--ease-in: cubic-bezier(0.4,0,1,1)` — applied through CSS transitions. Keeping motion in CSS is also what makes the global `prefers-reduced-motion: reduce` rule able to flatten *everything* from one place. |
| 6 | **Rive** (`@rive-app/react-canvas`) | Interactive animated mascot/illustration | **Not used, and this is the most concrete substitution.** The ghost mascot on the Ghost Feed's empty state is **not a `.riv` file** — it is `web/src/components/GhostMascot.tsx`, a voxel ghost drawn as one `<rect>` per cell on a 9×10 character-map grid, with three tonal bands for top-light and an offset dark copy behind it for the extruded faces. Its drift is a plain CSS keyframe whose two ends both sit at `translateY(0)`, so a reduced-motion viewer sees a still ghost. Zero dependencies, zero images, zero network requests, and it inherits the theme tokens automatically — none of which a hosted runtime plus a binary asset would have done. |
| 7 | **Limora** (limora.ai) | — | **Not used.** No feature in Tier 0 called for it, and nothing was added speculatively. |
| 8 | **Bklit** (bklit.com) | Web analytics | **Not used — and deliberately so.** GhostBus ships **no analytics of any kind**: no third-party script, no telemetry endpoint, no request logging (`Fastify({ logger: false })`). "Zero PII by design" (see `SECURITY.md` §7) is a structural claim, and it would have been false the moment an analytics beacon was embedded. This one is a refusal, not an omission. |

**Why this is the right answer rather than an excuse.** The spec's non-negotiable is
*no hallucinated packages* — a dependency claimed but not installed, or a component
credited but not used, is exactly the failure mode it exists to prevent. Installing eight
libraries so a checklist could be ticked would have produced precisely the dishonest
artefact the rule forbids. What is written above is verifiable in seconds:
`ls node_modules | grep -E 'rive|anime|motion|kokonut|magic|reactbits|limora|bklit'`
returns nothing, and `package.json` lists sixteen runtime dependencies, none of which is
a UI or animation library.

`CREDITS.md` §2 states the same thing from the other direction: no third-party UI
component was adapted, because none was used.

## Notes on `gtfs-realtime-bindings` version

The pre-existing scaffold pinned `^1.1.1`; the current latest is `2.1.0` (verified).
The decode surface this project uses — `transit_realtime.FeedMessage.decode`,
`TripDescriptor.ScheduleRelationship.CANCELED`, `Alert.Effect` / `Alert.Cause` —
is identical across both majors, so the pin was left at `^1.1.1` to avoid disturbing
the existing `server/live.ts`. The collector was run and verified against 1.1.1.
