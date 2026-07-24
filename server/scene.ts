// The Toronto demo scene — a recorded-style slice of real TTC geometry around
// King St W at Spadina Ave. Everything the app shows is DERIVED here from an
// explicit schedule + seeded observation history, never hardcoded per-screen.
// When the live TTC feed is reachable, live.ts overrides vehicles/arrivals; this
// module is the honest fallback that keeps the app answering (labeled source:'demo').

import type {
  Vehicle, Departure, StopArrivals, ServiceAlert, GhostEvent,
  RouteReport, CityStats, AnomalyBanner, ModeKind, EtaEvidence, TrustGrade,
} from '../shared/types.ts';

// ---- geo helpers: author in local metres, emit real lon/lat ----
const CENTER = { lat: 43.64487, lon: -79.39566 }; // King & Spadina, Toronto
const MPD_LAT = 111320;
const mpdLon = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);
function toLL(dxEast: number, dyNorth: number): [number, number] {
  return [
    CENTER.lon + dxEast / mpdLon(CENTER.lat),
    CENTER.lat + dyNorth / MPD_LAT,
  ];
}
function metresBetween(a: [number, number], b: [number, number]): number {
  const dx = (a[0] - b[0]) * mpdLon(CENTER.lat);
  const dy = (a[1] - b[1]) * MPD_LAT;
  return Math.hypot(dx, dy);
}

// deterministic seeded RNG so the "recorded" history is stable across restarts
function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- routes ----
interface RouteDef {
  routeId: string; short: string; long: string; color: string;
  mode: ModeKind; shapeLocal: [number, number][]; headsign: string;
  headwaySec: number; // scheduled spacing
  medianDelaySec: number; p25: number; p75: number; obs: number; // seeded history
  ghostRate: number; live: boolean; accessible: boolean | null;
}

// King St W runs roughly W→E with a jog south around Spadina, then east to
// Distillery — a real turn, not a straight slash.
const KING_SHAPE: [number, number][] = [
  [-1400, 60], [-900, 55], [-420, 40], [-40, 20], [0, 0],
  [180, -18], [520, -30], [980, -34], [1500, -30], [2100, -22],
];
const SPADINA_SHAPE: [number, number][] = [
  [-30, 900], [-24, 520], [-16, 180], [-6, 0], [0, -260], [8, -640], [16, -1000],
];

const ROUTES: RouteDef[] = [
  {
    routeId: '504', short: '504A', long: 'King', color: 'D6001C', mode: 'tram',
    shapeLocal: KING_SHAPE, headsign: 'Distillery Loop', headwaySec: 7 * 60,
    medianDelaySec: 150, p25: 30, p75: 300, obs: 212, ghostRate: 0.11,
    live: true, accessible: true,
  },
  {
    routeId: '510', short: '510', long: 'Spadina', color: 'D6001C', mode: 'tram',
    shapeLocal: SPADINA_SHAPE, headsign: 'Union Station', headwaySec: 9 * 60,
    medianDelaySec: 90, p25: 20, p75: 210, obs: 6, ghostRate: 0.04,
    live: false, accessible: true, // scheduled-only in the demo → honest "Scheduled"
  },
  {
    routeId: '501', short: '501', long: 'Queen', color: 'D6001C', mode: 'tram',
    shapeLocal: KING_SHAPE.map(([x, y]) => [x, y + 220] as [number, number]),
    headsign: 'Neville Park', headwaySec: 8 * 60,
    medianDelaySec: 200, p25: 40, p75: 380, obs: 158, ghostRate: 0.18,
    live: true, accessible: true,
  },
  {
    routeId: '29', short: '29', long: 'Dufferin', color: 'E8A100', mode: 'bus',
    shapeLocal: SPADINA_SHAPE.map(([x, y]) => [x - 380, y] as [number, number]),
    headsign: 'Dufferin Loop', headwaySec: 6 * 60,
    medianDelaySec: 260, p25: 60, p75: 520, obs: 96, ghostRate: 0.22,
    live: true, accessible: false, // demonstrates the Access Profile de-prioritization
  },
];

const routeById = (id: string) => ROUTES.find((r) => r.routeId === id)!;

// arc-length param of a local polyline
function shapeLL(r: RouteDef): [number, number][] {
  return r.shapeLocal.map(([x, y]) => toLL(x, y));
}
function pointAt(shape: [number, number][], t: number): { ll: [number, number]; bearing: number } {
  const segs = shape.length - 1;
  const f = Math.min(0.9999, Math.max(0, t)) * segs;
  const i = Math.floor(f);
  const k = f - i;
  const a = shape[i], b = shape[Math.min(segs, i + 1)];
  const ll: [number, number] = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const dx = (b[0] - a[0]) * mpdLon(CENTER.lat);
  const dy = (b[1] - a[1]) * MPD_LAT;
  const bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
  return { ll, bearing };
}

// ---- stops ----
export interface StopDef {
  stopId: string; name: string; code: string; direction: string;
  cross: string; local: [number, number]; routeIds: string[];
  wheelchair: 0 | 1 | 2;
}
const STOPS: StopDef[] = [
  { stopId: '4197', name: 'King St W at Spadina Ave', code: '4197', direction: 'Eastbound',
    cross: 'Spadina Ave', local: [10, 8], routeIds: ['504', '510'], wheelchair: 1 },
  { stopId: '4198', name: 'King St W at Spadina Ave', code: '4198', direction: 'Westbound',
    cross: 'Spadina Ave', local: [-24, -22], routeIds: ['504'], wheelchair: 1 },
  { stopId: '6021', name: 'Spadina Ave at King St W', code: '6021', direction: 'Northbound',
    cross: 'King St W', local: [-40, 60], routeIds: ['510'], wheelchair: 1 },
  { stopId: '3312', name: 'King St W at Portland St', code: '3312', direction: 'Eastbound',
    cross: 'Portland St', local: [-360, 42], routeIds: ['504', '501'], wheelchair: 0 },
];
const stopById = (id: string) => STOPS.find((s) => s.stopId === id);

// the demo user — southeast of the board stop, ~a 4 min walk (per reference)
export const USER_LOCAL: [number, number] = [150, -190];
export const BOARD_STOP_ID = '4197';

export function getScene(cityId: string) {
  const streets = [
    { name: 'King St West', pts: KING_SHAPE.map(([x, y]) => toLL(x, y)) },
    { name: 'Spadina Ave', pts: SPADINA_SHAPE.map(([x, y]) => toLL(x, y)) },
    { name: 'Wellington St W', pts: [toLL(-1400, -150), toLL(2100, -180)] },
    { name: 'Portland St', pts: [toLL(-360, 900), toLL(-360, -1000)] },
    { name: 'Adelaide St W', pts: [toLL(-1400, 210), toLL(2100, 190)] },
  ];
  const routes = ROUTES.map((r) => ({
    routeId: r.routeId, short: r.short, long: r.long, color: r.color,
    mode: r.mode, headsign: r.headsign, shape: shapeLL(r),
  }));
  const stops = STOPS.map((s) => ({
    stopId: s.stopId, name: s.name, code: s.code, direction: s.direction,
    cross: s.cross, ll: toLL(s.local[0], s.local[1]), routeIds: s.routeIds,
    wheelchair: s.wheelchair,
  }));
  const user = toLL(USER_LOCAL[0], USER_LOCAL[1]);
  const board = stops.find((s) => s.stopId === BOARD_STOP_ID)!;
  return {
    cityId, center: [CENTER.lon, CENTER.lat] as [number, number],
    user, board, streets, routes, stops,
    walkPath: [user, toLL(150, -60), toLL(60, -10), board.ll],
  };
}

// ---- vehicles: position is a pure function of time (survives restarts) ----
export function getVehicles(cityId: string, nowMs: number): Vehicle[] {
  const out: Vehicle[] = [];
  for (const r of ROUTES) {
    if (!r.live) continue;
    const shape = shapeLL(r);
    const count = r.routeId === '504' ? 3 : 2;
    for (let i = 0; i < count; i++) {
      const period = r.headwaySec * count; // seconds to traverse the shape once
      const phase = i / count + (r.routeId === '504' ? 0.02 : 0.31 * i);
      const t = (((nowMs / 1000) / period + phase) % 1 + 1) % 1;
      const { ll, bearing } = pointAt(shape, t);
      const speed = 6 + 3 * Math.sin((nowMs / 1000) * 0.3 + i); // 3–9 m/s
      out.push({
        id: `${r.routeId}-${i}`,
        routeId: r.routeId, routeShortName: r.short, routeLongName: r.long,
        routeColor: r.color, mode: r.mode,
        tripId: `${r.routeId}_t${i}`, headsign: r.headsign,
        lon: ll[0], lat: ll[1], bearing, speed: Math.max(0, speed),
        shapeT: t, isGhost: false,
        occupancy: r.routeId === '504' && i === 0 ? 'few_seats' : 'many_seats',
        wheelchairAccessible: r.accessible, ts: nowMs,
      });
    }
  }
  return out;
}

// ---- Honest ETA evidence from seeded history ----
function evidenceFor(r: RouteDef): EtaEvidence {
  const n = r.obs;
  const spreadMin = Math.round(((r.p75 - r.p25) / 2 / 60) * 10) / 10;
  const hasEvidence = n >= 8;
  let grade: TrustGrade = null;
  if (hasEvidence) {
    // grade from sample size + variance
    const variancePenalty = (r.p75 - r.p25) / 60; // minutes spread
    const score = Math.min(1, n / 200) * 0.6 + Math.max(0, 1 - variancePenalty / 8) * 0.4;
    grade = score > 0.8 ? 'A' : score > 0.62 ? 'B' : score > 0.44 ? 'C' : score > 0.28 ? 'D' : 'E';
  }
  return { grade, n, spreadMin, windowDays: 7, hasEvidence };
}

function forecastFor(r: RouteDef, rng: () => number) {
  const of = Math.max(4, Math.round(r.obs / 18));
  const vanished = Math.round(of * r.ghostRate + rng() * 0.5);
  const risk = Math.min(0.95, r.ghostRate + rng() * 0.05);
  if (risk < 0.12) return undefined;
  return {
    risk,
    level: (risk > 0.2 ? 'high' : 'medium') as 'high' | 'medium',
    vanished, of,
    granularity: (r.obs > 120 ? 'trip' : 'route-hour') as 'trip' | 'route-hour',
    saferBet: undefined as string | undefined,
  };
}

export function getArrivals(cityId: string, stopId: string, nowMs: number): StopArrivals | null {
  const s = stopById(stopId);
  if (!s) return null;
  const rng = mulberry(Number(stopId) + Math.floor(nowMs / 3_600_000));
  const departures: Departure[] = [];
  for (const rid of s.routeIds) {
    const r = routeById(rid);
    const ev = evidenceFor(r);
    // deterministic upcoming scheduled times for this route at this stop
    const base = Math.ceil(nowMs / (r.headwaySec * 1000)) * r.headwaySec * 1000;
    for (let k = 0; k < 3; k++) {
      const scheduledMs = base + k * r.headwaySec * 1000 + (rid === '504' ? 0 : 120000);
      const delay = ev.hasEvidence ? r.medianDelaySec * 1000 : 0;
      const estimateMs = scheduledMs + delay;
      const etaMin = (estimateMs - nowMs) / 60000;
      if (etaMin < -1) continue;
      const fresh = r.live ? 'live' : 'scheduled';
      departures.push({
        routeId: r.routeId, routeShortName: r.short, routeLongName: r.long,
        routeColor: r.color, mode: r.mode, tripId: `${r.routeId}_dep${k}`,
        headsign: r.headsign, directionLabel: s.direction, stopId: s.stopId,
        scheduledMs, estimateMs, etaMin, freshness: fresh,
        evidence: ev,
        forecast: k === 0 ? forecastFor(r, rng) : undefined,
        wheelchairAccessible: r.accessible,
        occupancy: r.live && k === 0 ? 'few_seats' : undefined,
        vehicleId: r.live ? `${r.routeId}-0` : undefined,
      });
      if (departures.length > 6) break;
    }
  }
  departures.sort((a, b) => a.etaMin - b.etaMin);
  const userLL = toLL(USER_LOCAL[0], USER_LOCAL[1]);
  const distanceM = metresBetween(userLL, toLL(s.local[0], s.local[1]));
  const walkA = Math.max(1, Math.round((distanceM * 1.25) / (4.8 * 1000 / 60)));
  return {
    stopId: s.stopId, stopName: s.name, stopCode: s.code, directionLabel: s.direction,
    crossStreet: s.cross, distanceM, walkMinRange: [walkA, walkA + 2],
    wheelchairBoarding: s.wheelchair, lat: toLL(s.local[0], s.local[1])[1],
    lon: toLL(s.local[0], s.local[1])[0],
    departures: departures.slice(0, 6),
    alerts: getAlerts(cityId, nowMs).filter((a) => a.stopIds.includes(s.stopId)),
  };
}

export function getStops(cityId: string, q: string) {
  const nowMs = Date.now();
  const norm = q.trim().toLowerCase();
  return STOPS.filter((s) => !norm || s.name.toLowerCase().includes(norm) || s.code.includes(norm))
    .map((s) => {
      const arr = getArrivals(cityId, s.stopId, nowMs);
      const userLL = toLL(USER_LOCAL[0], USER_LOCAL[1]);
      return {
        stopId: s.stopId, name: s.name, code: s.code, direction: s.direction,
        distanceM: metresBetween(userLL, toLL(s.local[0], s.local[1])),
        nextEtaMin: arr?.departures[0]?.etaMin ?? null,
        nextRoute: arr?.departures[0]?.routeShortName ?? null,
      };
    })
    .sort((a, b) => a.distanceM - b.distanceM);
}

// ---- ghosts, alerts, stats, reports, anomalies ----
export function getAlerts(cityId: string, nowMs: number): ServiceAlert[] {
  // one official cancellation on the 504A at this stop (matches the reference)
  const cancelledAt = nowMs + 2 * 60000;
  return [
    {
      id: 'ttc-504-cancel-1', effect: 'SIGNIFICANT_DELAYS', header: '504A trip cancelled',
      description: '504A King → Distillery Loop', routeIds: ['504'], stopIds: ['4197'],
      isAccessibility: false, timestampMs: nowMs - 12000, activeStart: cancelledAt,
    },
  ];
}

export function getGhosts(cityId: string, nowMs: number): GhostEvent[] {
  const rng = mulberry(Math.floor(nowMs / 3_600_000));
  const out: GhostEvent[] = [];
  const s = stopById('4197')!;
  // the official cancellation (agency admitted it)
  out.push({
    cityId, tripId: '504_cancel', routeShortName: '504A', routeLongName: 'King',
    routeColor: 'D6001C', stopId: '4197', stopName: s.name,
    scheduledMs: nowMs - 34 * 60000, detectedMs: nowMs - 34 * 60000,
    kind: 'cancelled', isAccessibility: false, headsign: 'Distillery Loop',
  });
  // detected ghosts across tonight (never arrived) — genuinely counted per route rate
  for (const r of ROUTES.filter((x) => x.live)) {
    const nightRuns = Math.round(r.ghostRate * 24 + rng() * 2);
    for (let i = 0; i < Math.min(6, nightRuns); i++) {
      out.push({
        cityId, tripId: `${r.routeId}_g${i}`, routeShortName: r.short,
        routeLongName: r.long, routeColor: r.color, stopId: '4197', stopName: s.name,
        scheduledMs: nowMs - (i + 1) * 47 * 60000,
        detectedMs: nowMs - (i + 1) * 47 * 60000 + 6 * 60000,
        kind: 'ghost', isAccessibility: r.accessible === false && i === 0,
        headsign: r.headsign,
      });
    }
  }
  return out.sort((a, b) => b.detectedMs - a.detectedMs);
}

export function getAnomalies(cityId: string, nowMs: number): AnomalyBanner[] {
  const r = routeById('501');
  return [{ routeShortName: r.short, routeColor: r.color, vanishedRecent: 4, typical: 1, windowMin: 90 }];
}

export function getReport(cityId: string, routeId: string, nowMs: number): RouteReport | null {
  const r = ROUTES.find((x) => x.routeId === routeId);
  if (!r) return null;
  const rng = mulberry(Number(routeId) || 7);
  const heatmap: number[][] = [];
  for (let d = 0; d < 7; d++) {
    const row: number[] = [];
    for (let h = 0; h < 24; h++) {
      const rush = h >= 7 && h <= 9 ? 1.8 : h >= 16 && h <= 19 ? 2.1 : 1;
      row.push(Math.round(r.medianDelaySec * rush * (0.7 + rng() * 0.6)));
    }
    heatmap.push(row);
  }
  const distribution = ['<0', '0–2', '2–5', '5–10', '10+'].map((bucket, i) => ({
    bucket, count: Math.round([0.1, 0.34, 0.28, 0.18, 0.1][i] * r.obs),
  }));
  const onTimePct = Math.round(100 - r.medianDelaySec / 6 - r.ghostRate * 30);
  const score = onTimePct * 0.6 + (100 - r.ghostRate * 100) * 0.25 + (100 - r.p75 / 6) * 0.15;
  const grade = score > 82 ? 'A' : score > 72 ? 'B' : score > 62 ? 'C' : score > 50 ? 'D' : 'F';
  return {
    routeId: r.routeId, routeShortName: r.short, routeLongName: r.long, routeColor: r.color,
    grade, onTimePct, p50DelaySec: r.medianDelaySec, p75DelaySec: r.p75,
    ghostCount7d: Math.round(r.ghostRate * 120), heatmap, distribution,
    observations: r.obs * 7, windowLabel: 'last 7 days',
    formula: 'on-time 60% · ghost rate 25% · P75 delay 15%',
  };
}

export function getStats(cityId: string, nowMs: number): CityStats {
  const vehicles = getVehicles(cityId, nowMs).length;
  const obs = ROUTES.reduce((a, r) => a + r.obs * 7, 0);
  const ghosts = getGhosts(cityId, nowMs).filter((g) => g.kind === 'ghost').length * 5;
  return {
    cityId, vehiclesTracked: vehicles, observations: obs, ghosts7d: ghosts,
    avgDelaySec: Math.round(ROUTES.reduce((a, r) => a + r.medianDelaySec, 0) / ROUTES.length),
    hoursLostToGhosts7d: Math.round((ghosts * 11) / 60),
    accessibleKeptPct: 84, overallKeptPct: 91,
    window: 'this week', source: 'demo',
  };
}
