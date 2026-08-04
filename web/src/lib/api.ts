// Typed client for the real GhostBus API. One source of truth: @shared/types.
// Every response shape is imported from the server's contract so the UI cannot
// drift from what the API actually returns.
//
// THIS FILE IS ALSO WHERE "WHOSE FAULT WAS IT" IS DECIDED, and that is why it grew.
//
// A rider reported: "when I allow it to use my location it kept saying can't reach the
// live TTC feed right now". Every failure here used to collapse into `new Error(msg)`,
// so the UI could not tell our own rate limiter from a genuine agency outage — and the
// copy it reached for blamed the TTC. For an app whose entire argument is honest
// attribution, blaming the agency for our own throttling is the worst available bug.
//
// So every failure now arrives as an `ApiFailure` carrying a `kind`, and NONE of those
// kinds means "the TTC feed is down". That claim has exactly one honest source in the
// whole system: `HealthResponse.feeds`. See DECISIONS §45.
import type {
  HealthResponse, StopsResponse, ArrivalsResponse, VehiclesResponse, RouteShapeResponse,
  AlertsResponse, GhostFeedResponse, StatsResponse, PlanResponse, ApiError,
  GeocodeResponse,
} from '@shared/types';

/** A viewport box in [minLon, minLat, maxLon, maxLat] order (what the API expects). */
export type Bbox = [number, number, number, number];

/**
 * Why a request failed, in terms the UI can honestly repeat to a rider.
 *
 *   throttled   · our own server refused us (429). WE are over budget, nothing else.
 *   serverDown  · our server answered 5xx, or is restarting/not listening.
 *   unreachable · the request never completed — no network, captive portal, DNS, CORS.
 *   badRequest  · we asked for something invalid (4xx). A bug on our side.
 *   aborted     · superseded by a newer request. NOT a failure; never shown to anyone.
 *
 * All of the first three are OUR side of the wire. The UI groups them into one honest
 * message ("GhostBus is catching up") and never converts any of them into a claim about
 * the transit agency.
 */
export type ApiFailureKind = 'throttled' | 'serverDown' | 'unreachable' | 'badRequest' | 'aborted';

export class ApiFailure extends Error {
  readonly kind: ApiFailureKind;
  /** HTTP status, or null when the request never got one. */
  readonly status: number | null;
  /** Seconds the server asked us to wait. Only ever set on `throttled`. */
  readonly retryAfterSec: number | null;

  constructor(kind: ApiFailureKind, message: string, status: number | null = null, retryAfterSec: number | null = null) {
    super(message);
    this.name = 'ApiFailure';
    this.kind = kind;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }

  /** True when the honest thing to tell a rider is "this is us, and we are retrying". */
  get isOurs(): boolean {
    return this.kind === 'throttled' || this.kind === 'serverDown' || this.kind === 'unreachable';
  }
}

/** Narrowing helper so callers never have to `instanceof` in a catch block. */
export function failureKind(e: unknown): ApiFailureKind {
  return e instanceof ApiFailure ? e.kind : e instanceof DOMException && e.name === 'AbortError' ? 'aborted' : 'unreachable';
}

/**
 * IN-FLIGHT DEDUPE, and the deliberate limit on it.
 *
 * The network log showed health, alerts and ghosts each being fetched twice within a few
 * milliseconds — different components asking for the same URL independently. Two
 * identical GETs in flight at once is one wasted request out of a shared rate-limit
 * budget, so identical in-flight GETs now share a single response.
 *
 * ONLY requests with no `signal` are shared. A caller that passed an AbortSignal wants
 * individual cancellation — the search sheet aborts superseded queries specifically so
 * they stop costing budget — and handing it a promise somebody else can cancel, or that
 * ignores its own abort, would break that. Those callers are already deduped by their own
 * debounce, so there is nothing left to win there and a correctness bug to lose.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * A request that never settles must never be able to wedge a URL.
 *
 * Without this the dedupe introduces a failure mode that did not exist before it: a
 * black-holed socket leaves an entry in `inFlight` forever, every later caller is handed
 * the same never-settling promise, no success or failure is ever recorded, the backoff
 * never engages, and the UI shows no error at all — a silent permanent hang that even
 * regaining focus or network cannot clear, because the resume path just re-subscribes to
 * the wedged promise. Un-deduped polling was self-healing by accident; deduped polling has
 * to be self-healing on purpose.
 *
 * 15s is comfortably above a slow cold query on a loaded box and well below the 20s health
 * cadence, so a timed-out poll is replaced by the next one rather than overlapping it.
 */
const REQUEST_TIMEOUT_MS = 15_000;

async function request<T>(url: string, signal?: AbortSignal): Promise<T> {
  // A caller-supplied signal owns the request's lifetime; it is not shared (see above).
  if (signal) return raw<T>(url, signal);
  const shared = inFlight.get(url) as Promise<T> | undefined;
  if (shared) return shared;
  const p = raw<T>(url, AbortSignal.timeout(REQUEST_TIMEOUT_MS), true)
    .finally(() => { inFlight.delete(url); });
  inFlight.set(url, p);
  return p;
}

/**
 * The one place an HTTP outcome becomes an `ApiFailure`.
 *
 * `ownTimeout` distinguishes OUR watchdog firing from a caller cancelling: both surface as
 * an AbortError, but a timeout is a genuine failure the backoff must see, while a caller's
 * abort is a decision it must ignore.
 */
async function raw<T>(url: string, signal?: AbortSignal, ownTimeout = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  } catch (e) {
    if (ownTimeout && e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new ApiFailure('unreachable', `no response within ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    // An abort is a decision we made, not a failure to report.
    if (e instanceof DOMException && e.name === 'AbortError') throw new ApiFailure('aborted', 'aborted');
    // The request never completed. This is the offline / captive-portal / server-not-
    // listening case, and it is still OURS — it says nothing about the agency's feed.
    throw new ApiFailure('unreachable', e instanceof Error ? e.message : 'network request failed');
  }
  if (!res.ok) {
    let body: ApiError | null = null;
    try { body = (await res.json()) as ApiError; } catch { /* non-JSON body */ }
    const msg = body?.error ?? `HTTP ${res.status}`;
    if (res.status === 429) {
      // Prefer the server's own number; fall back to the standard header, then to a
      // sane wait. `retryAfterSec` is what the backoff in useLive actually honours.
      const header = Number(res.headers.get('retry-after'));
      const wait = body?.retryAfterSec ?? (Number.isFinite(header) && header > 0 ? header : null);
      throw new ApiFailure('throttled', msg, 429, wait);
    }
    throw new ApiFailure(res.status >= 500 ? 'serverDown' : 'badRequest', msg, res.status);
  }
  return res.json() as Promise<T>;
}

/** Kept as `j` so every call site below reads exactly as it did before. */
const j = request;

export const api = {
  health: (signal?: AbortSignal) => j<HealthResponse>('/api/health', signal),

  nearby: (lat: number, lon: number, radiusM: number, signal?: AbortSignal) =>
    j<StopsResponse>(`/api/stops/nearby?lat=${lat}&lon=${lon}&radius=${radiusM}`, signal),

  /**
   * `agency` on the two id-bearing endpoints (this and routeShape): a stop or route id is
   * unique only WITHIN an agency, so with more than one seeded the server refuses a bare
   * id (400) rather than guess a different city's stop into the rider's board. Callers
   * pass the agency the id came WITH — every DTO carries it — and omit it only where it
   * is genuinely unknown, which a single-agency server still answers.
   */
  arrivals: (stopId: string, opts: { agency?: string; atMs?: number; windowMin?: number } = {}, signal?: AbortSignal) => {
    const p = new URLSearchParams();
    if (opts.agency != null) p.set('agency', opts.agency);
    if (opts.atMs != null) p.set('at', String(Math.round(opts.atMs)));
    if (opts.windowMin != null) p.set('windowMin', String(opts.windowMin));
    const qs = p.toString();
    return j<ArrivalsResponse>(`/api/stops/${encodeURIComponent(stopId)}/arrivals${qs ? `?${qs}` : ''}`, signal);
  },

  /** Free-text stop search. `q` is user input, so it is encoded, never concatenated. */
  stops: (q: string, signal?: AbortSignal) =>
    j<StopsResponse>(`/api/stops?q=${encodeURIComponent(q)}`, signal),

  /**
   * Free-text ADDRESS search, proxied by our server to Nominatim. Never called on every
   * keystroke — see lib/geocode.ts for when it is worth its cost, and server/src/geocode.ts
   * for why the call cannot be made from here.
   *
   * An empty `results` list is a real answer ("no such address"), not a failure; only a
   * thrown ApiFailure means the lookup could not be made.
   */
  geocode: (q: string, signal?: AbortSignal) =>
    j<GeocodeResponse>(`/api/geocode?q=${encodeURIComponent(q)}`, signal),

  /** Real single-ride options between two points. Multi-leg journeys are out of scope
   *  by design — the response says `outcome: 'transfer'` rather than inventing a leg. */
  plan: (
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
    opts: { atMs?: number; windowMin?: number; radiusM?: number } = {},
    signal?: AbortSignal,
  ) => {
    const p = new URLSearchParams({
      fromLat: String(from.lat), fromLon: String(from.lon),
      toLat: String(to.lat), toLon: String(to.lon),
    });
    if (opts.atMs != null) p.set('at', String(Math.round(opts.atMs)));
    if (opts.windowMin != null) p.set('windowMin', String(opts.windowMin));
    if (opts.radiusM != null) p.set('radius', String(opts.radiusM));
    return j<PlanResponse>(`/api/plan?${p}`, signal);
  },

  vehicles: (bbox: Bbox, signal?: AbortSignal) =>
    j<VehiclesResponse>(`/api/vehicles?bbox=${bbox.join(',')}`, signal),

  /** See the note on `arrivals` for why `agency` rides along with the route id. */
  routeShape: (routeId: string, dir: number | null, agency?: string, signal?: AbortSignal) => {
    const p = new URLSearchParams();
    if (agency != null) p.set('agency', agency);
    if (dir != null) p.set('dir', String(dir));
    const qs = p.toString();
    return j<RouteShapeResponse>(`/api/routes/${encodeURIComponent(routeId)}/shape${qs ? `?${qs}` : ''}`, signal);
  },

  alerts: (limit?: number, signal?: AbortSignal) =>
    j<AlertsResponse>(`/api/alerts${limit == null ? '' : `?limit=${limit}`}`, signal),

  ghostFeed: (hours?: number, signal?: AbortSignal) =>
    j<GhostFeedResponse>(`/api/ghosts/feed${hours == null ? '' : `?hours=${hours}`}`, signal),

  stats: (signal?: AbortSignal) => j<StatsResponse>('/api/stats', signal),
};
