// The agencies the About sheet can credit, in display order — TTC is rendered
// unconditionally (it is the app's origin and always first), the rest only when the
// server's /api/health names them. The ids double as i18n key prefixes
// (`about.<id>Name/Via/Attribution`).
//
// A PLAIN MODULE ON PURPOSE: no imports, no JSX, no vite alias — so the server-side
// registry test (server/src/agencies.test.ts) can import it directly and assert that
// every descriptor in server/src/agencies.ts has a credit slot here. Several licences
// REQUIRE attribution wherever their data is shown; an agency reaching the registry
// without reaching this list would ship coverage without its legally required credit,
// and that test exists so it cannot.
export const CREDITED_AGENCIES = [
  'miway', 'yrt', 'burlington', 'drt', 'brampton', 'oakville', 'milton', 'go', 'upexpress',
] as const;
