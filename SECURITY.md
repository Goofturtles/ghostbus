# SECURITY

What an application-security reviewer can verify about GhostBus in five minutes, with
the commands to verify it and the honest result of each. Findings we have **not** fixed
are listed as findings, not omitted.

All results below were produced on **2026-07-24** against commit-time `main`.

---

## The five-minute checklist

| # | Check | Command | Result |
|---|---|---|---|
| 1 | No secrets ever committed | `git log --all -- .env` | **Empty output — `.env` has never been in a commit, on any branch.** |
| 2 | No secrets tracked now | `git ls-files \| grep -i "env\|secret\|key\|credential"` | Returns exactly one path: `.env.example`, which contains no values. |
| 3 | Secret file ignored | `cat .gitignore` | `.env` is on line 3; `.data` (the embedded database) on line 4. |
| 4 | Security headers | `grep -n helmet server/src/api.ts` | `@fastify/helmet` registered before every route. See §2 for the CSP caveat. |
| 5 | Rate limiting | `grep -n rateLimit server/src/api.ts` | `@fastify/rate-limit`, 120 requests/minute, global. See §4 for the honest caveat. |
| 6 | Input validation | `grep -n "return bad(reply" server/src/api.ts` | Every user-supplied parameter is range-checked or rejected. §3. |
| 7 | Dependency advisories | `npm audit` | **14 advisories: 1 moderate, 13 high. This is NOT clean — §5 explains every one.** |
| 8 | PII surface | `cat server/migrations/001_init.sql` | No user, account, session, or device table exists. §7. |

---

## 1. Secrets

**There are no secrets in this repository, and there never have been.**

```
$ git log --all -- .env
$ echo $?
0
```

An empty result from `git log --all` is the strong form of this claim: not "we removed
it," but "no commit reachable from any ref has ever touched that path." `.env` was
gitignored from the beginning (`.gitignore:3`).

**There is also very little to leak.** GhostBus uses no API keys at all:

- The three TTC GTFS-realtime feeds are unauthenticated public HTTP endpoints.
- The map tiles (OpenFreeMap) require no key, no token, and no registration.
- The only credential in the system is `DATABASE_URL`, supplied at runtime via the
  environment and declared `sync: false` in `render.yaml` so it is entered in the
  hosting dashboard and never serialised into the repo.

The client bundle contains no credentials because there are none to embed — the browser
talks only to our own `/api/*` origin and to the tile host.

---

## 2. Response headers

`@fastify/helmet` is registered before any route, so every response — including error
responses — carries its defaults: `X-Content-Type-Options: nosniff`, frame denial,
`Referrer-Policy`, HSTS on TLS, cross-origin isolation headers, and the removal of
`X-Powered-By`.

**Finding (open): there is no Content-Security-Policy in production.** Helmet is
registered with `contentSecurityPolicy: false`, and the inline comment says the SPA
sets its own. It does not — `web/index.html` contains no CSP `<meta>` tag and no CSP
header is set anywhere. The practical exposure is small (§6: the app renders no
untrusted HTML and stores no credentials in the browser), but the header a reviewer
will look for is genuinely absent, and disabling it was a Phase-3 convenience that was
never paid back. Recording it here rather than letting it be discovered.

---

## 3. Input validation

Every endpoint validates every parameter before it reaches the database, and rejects
with a `400` and a plain message rather than coercing:

| Parameter | Rule |
|---|---|
| `bbox` | Parsed to four finite numbers, ordering checked, **capped at 3° per side** so a single request cannot ask for the planet. |
| `lat` / `lon` | Must be finite and within `[-90, 90]` / `[-180, 180]`. |
| `radius` | Must be a positive number; **hard-capped at 3,000 m** regardless of what was asked for. |
| `q` (stop search) | Non-empty, **max 64 characters**. |
| `windowMin` | Positive; capped at 4,320 minutes. |
| `at` | Epoch ms or ISO; **rejected before 2020-01-01 or more than 30 days in the future**, so `Number('')  === 0` cannot silently resolve to 1970. |
| `dir` | Must be literally `0` or `1`. |
| `:id`, `:routeId` | Non-empty, max 64 characters. |
| Result sets | Bounded server-side: 50 nearby stops, 25 search results, 60 departures, 200 ghost events. |

**SQL injection.** Every query that interpolates user input uses parameter
placeholders (`$1`, `$2`, …) — verified by reading each call site. Three queries build
SQL by string concatenation, and in all three the interpolated part is a
**compile-time constant table/column name from our own code**, never request data:
`aggregate.ts:59` and `poller.ts:336` (batched multi-row `INSERT` builders — the values
are still parameterised) and `seed_toronto.ts:118` (`TRUNCATE` of a fixed table list).

**Error responses.** A single `setErrorHandler` returns a uniform JSON envelope.
Client errors return their message; **any 5xx is flattened to `"internal error"`**, so
no stack trace, driver message, or SQL fragment can reach a client.

---

## 4. Rate limiting and CORS

**Rate limit:** `@fastify/rate-limit` at **120 requests per minute**, applied globally
rather than per route.

**Finding (open): the rate limit is evadable as currently configured.** Fastify is
constructed with `trustProxy: true`, which per Fastify's documentation means "trust all
proxies" — `request.ip` is then derived from the client-supplied `X-Forwarded-*` chain
instead of the socket address, and Fastify's own docs note these headers "would
otherwise be easily spoofed." `@fastify/rate-limit` keys on `request.ip` by default, so
a client that rotates a forged `X-Forwarded-For` header gets a fresh bucket each time.
The fix is to set `trustProxy` to the number of trusted hops in front of the app (e.g.
`1` behind Render's proxy) rather than `true`, or to supply a `keyGenerator` that reads
the platform's authenticated client-IP header. Not fixed here — `server/` is owned by
another workstream — but it is the first thing an auditor should raise.

**CORS:** `@fastify/cors` allows `GET` only, and only from `http://localhost:<port>`
and `http://127.0.0.1:<port>`. There is no wildcard origin, no credentialed CORS, and
no production origin in the allowlist — which is correct, because in production the SPA
is served by the same Fastify process on the same origin, so its requests are
same-origin and never CORS-checked at all. The allowlist exists purely for the Vite dev
server on port 3499.

---

## 5. `npm audit` — the real result

Run on 2026-07-24. **The honest answer is that this does not come back clean.**

```
14 vulnerabilities (1 moderate, 13 high)
```

Production-only (`npm audit --omit=dev`): **12 high**. So the common "they're all
dev-only" defence does **not** apply here, and claiming it would be false. The
breakdown, by root cause:

### 5.1 Fastify 4.x — 10 of the 12 production advisories trace to one pin

> **Correction (2026-07-25, re-verified with `npm audit --omit=dev --json`).** An earlier
> version of this file said all 12 traced to the Fastify pin. That is wrong, and it matters:
> someone acting on it would upgrade Fastify, re-run the audit, and still find two. The real
> split is **10 through the Fastify chain** and **2 through a separate path** —
> `gtfs-realtime-bindings → protobufjs-cli → glob`, which this file already documents
> correctly in §5.2. The heading contradicted its own next section. Several advisories share
> a root (`brace-expansion → minimatch → glob`) that surfaces in *both* trees, which is how
> the miscount happened. Upgrading Fastify is still the single highest-value change, but it
> resolves 10, not 12.

`fastify@4.29.1` and its dependency tree (`find-my-way`, `fast-json-stringify`,
`fast-uri`, `@fastify/ajv-compiler`, `@fastify/fast-json-stringify-compiler`,
`@fastify/static`, and `glob`/`minimatch`/`brace-expansion` beneath it) carry advisories
including:

| Advisory | Severity | Note |
|---|---|---|
| [GHSA-c96f-x56v-gq3h](https://github.com/advisories/GHSA-c96f-x56v-gq3h) `find-my-way` DDoS with HTTP/2 | high | The service does not enable HTTP/2. |
| [GHSA-jx2c-rxcm-jvmq](https://github.com/advisories/GHSA-jx2c-rxcm-jvmq) Fastify body-validation bypass via Content-Type tab | high | Applies to request-body validation; **every GhostBus route is `GET` with no body**. |
| [GHSA-444r-cwp2-x5xf](https://github.com/advisories/GHSA-444r-cwp2-x5xf) `request.protocol`/`request.host` spoofable via `X-Forwarded-*` | moderate | Directly relevant to `trustProxy: true` (§4). Verified by grep: the app reads `request.protocol`, `request.host` and `request.ip` **nowhere in its own code**, so the only consumer is the rate limiter — which is the §4 finding. |
| [GHSA-83w8-p2f5-377r](https://github.com/advisories/GHSA-83w8-p2f5-377r) / [GHSA-8pvw-jcv7-9cmj](https://github.com/advisories/GHSA-8pvw-jcv7-9cmj) `@fastify/static` path traversal / route-guard bypass | high / moderate | `@fastify/static` serves exactly one directory — the built SPA. There are no guarded routes behind it and nothing secret in it. Still a real advisory against a directly-declared dependency. |
| [GHSA-q3j6-qgpj-74h6](https://github.com/advisories/GHSA-q3j6-qgpj-74h6), [GHSA-v39h-62p7-jpjc](https://github.com/advisories/GHSA-v39h-62p7-jpjc) `fast-uri` | high | Transitive, inside Fastify's own routing/serialisation. |

**Why the pin exists:** the project is on `fastify@^4.28.1`, so the Fastify-4-compatible
majors of the plugins were chosen deliberately (`@fastify/cors@9`, `@fastify/helmet@11`)
— documented in `TOOLKIT.md`. `npm audit fix --force` resolves all of them by installing
`fastify@5.10.0`, a breaking major that would require re-verifying every plugin. **That
upgrade has not been done, and this is a real piece of security debt, not a false
positive.** It is the single highest-value security change available to this codebase.

### 5.2 `gtfs-realtime-bindings` → `protobufjs-cli` → `glob` → `minimatch` → `brace-expansion`

`gtfs-realtime-bindings@1.1.1` is flagged high, entirely through this chain
(verified with `npm ls protobufjs-cli`). The vulnerable leaf is
[GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg)
(`brace-expansion` DoS via unbounded expansion). `protobufjs-cli` is protobuf's
**code-generation command-line tool**; GhostBus only ever calls
`transit_realtime.FeedMessage.decode` at runtime and never invokes the CLI. The
advisory is real but the vulnerable code is not on any path this app executes.

### 5.3 Dev-only: `vite` and `esbuild` — 2 advisories

[GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) (`server.fs.deny`
bypass on Windows alternate paths), [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9),
[GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3), and
[GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) (esbuild dev
server). **These are the ones that genuinely are dev-only** — they affect the Vite
development server, which never runs in production; production ships static files built
by Vite and served by Fastify.

---

## 6. Client-side

- **No `eval`, no `new Function`.** Verified by grep across `web/src`.
- **Three `innerHTML` writes**, all in `web/src/map/MapCard.tsx`, for map marker
  chrome. Two are entirely static SVG string literals with no interpolation. The third
  interpolates a stop name and stop code, and **both are passed through an
  `escapeHtml()` helper** before insertion. Every other dynamic label on the map is set
  with `textContent`.
- **No `dangerouslySetInnerHTML`** anywhere in the React tree.
- **No cookies, no session, no auth, no tokens.** There is nothing to steal from the
  browser and no session to fixate.

---

## 7. Zero PII by design

This is a structural property of the schema, not a policy promise.

**There is no user.** `server/migrations/*.sql` defines thirteen tables: `cities`, `routes`,
`stops`, `trips`, `stop_times`, `shapes`, `calendar`, `calendar_dates`,
`trip_delay_obs`, `agg_delay`, `agg_delay_route`, `ghosts`, `service_alerts`. Every one
holds public transit schedule or vehicle data. **There is no accounts table, no sessions
table, no devices table, and no column anywhere that identifies a person.** There is no
place to put personal data even if someone wanted to.

**Location never leaves the device as an identity.** The browser's geolocation
coordinates are used to build one anonymous query — `GET /api/stops/nearby?lat=&lon=` —
and the server answers it and forgets it. There is no request logging of coordinates
(`Fastify({ logger: false })`), no analytics, no third-party script, and no telemetry
endpoint. Denying the location permission is a first-class path: the app falls back to a
fixed downtown Toronto coordinate and keeps working.

**Preferences stay local.** Theme, language, units, walking pace, accessibility profile
and saved stops live in `localStorage` under `gb.*` keys and are never transmitted.

**Vehicle pings are never persisted.** Raw GTFS-realtime positions live in an in-memory
map inside the process and are evicted after 10 stale cycles. Only distilled events —
delay observations, ghosts, alerts — reach Postgres. This was a memory/cost decision
(see `ARCHITECTURE.md`), but it also means there is no historical vehicle movement
archive to subpoena, leak, or de-anonymise.

The two data classes the app *does* retain are agency-published facts about agency
vehicles, and our own derived statistics about agency promises. Neither is about a
rider.

---

## 8. Known open items, in priority order

1. **Upgrade to Fastify 5** and the matching plugin majors. This clears 12 of the 14
   advisories in one move. (§5.1)
2. **Replace `trustProxy: true`** with a hop count or a platform-aware `keyGenerator`,
   so the rate limit cannot be evaded with a forged header. (§4)
3. **Set a Content-Security-Policy.** Either re-enable helmet's CSP with an allowlist
   for the tile host, or add the header in the SPA shell. (§2)
4. **Bump `vite`** to clear the dev-server advisories. Low risk, low urgency. (§5.3)
5. **Cache the SPA shell behind an mtime check, or read it async.** Unmatched routes are
   not rate-limited — Fastify dispatches them on a separate internal 404 router that never
   fires the `onRequest` hook `@fastify/rate-limit` attaches to, so the limiter's
   `allowList` is never consulted on that path. Three of the not-found handler's four
   branches exit as cheap JSON 404s with no I/O; the fourth serves the SPA shell with an
   uncached `readFileSync` per request, which is what a scanner spraying `/admin`,
   `/.env` etc. reaches. Deliberately NOT fixed with the documented
   `preHandler: app.rateLimit()` pattern: that would answer 429 for the shell during an
   exhausted budget, re-breaking the "the app still loads while throttled" guarantee
   (DECISIONS §48 §5). A boot-time cache is also ruled out — it reintroduces the
   DECISIONS §28 stale-shell failure (hashed assets that no longer exist) on a rebuild
   under a running server. Viable: an mtime-checked
   cache, an async read, or a navigation-exempt limit on the handler. Lowest priority here
   because it is a resource wart on an unauthenticated cheap path, not an access-control or
   data-exposure defect. (DECISIONS §49)

Items 1–3 and 5 are in `server/`, which is owned by another workstream; they are recorded
here so the next person to touch that code inherits the list rather than rediscovering it.

## Reporting a vulnerability

This is a hackathon project with no production users. If you find something, open an
issue on the repository. There is no bug bounty and no security contact address, and
pretending otherwise would be the kind of thing this document exists to avoid.
