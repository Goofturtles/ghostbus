import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { FEEDS, feedForPoint } from './feeds.ts';
import { probeFeed } from './live.ts';
import {
  getScene, getVehicles, getArrivals, getStops, getGhosts, getAlerts,
  getAnomalies, getReport, getStats,
} from './scene.ts';
import type { CitySummary, VehiclesResponse } from '../shared/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8799;

const app = Fastify({ logger: { level: 'warn' } });
await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });

// ---- upstream reachability, refreshed by the poller (honest /health + status) ----
const feedStatus: Record<string, { ok: boolean; lastOkMs: number; error?: string; count?: number }> = {};
for (const id of Object.keys(FEEDS)) feedStatus[id] = { ok: false, lastOkMs: 0 };

async function pollOnce() {
  for (const feed of Object.values(FEEDS)) {
    try {
      const r = await probeFeed(feed);
      const s = feedStatus[feed.cityId];
      s.ok = r.ok;
      s.error = r.error;
      s.count = r.count;
      if (r.ok) s.lastOkMs = r.at;
    } catch {
      /* keep last state; scene fallback stays honest */
    }
  }
}
// one server-side poller only. Browsers hit our API, never the agency's.
pollOnce();
const POLL_MS = 45_000;
setInterval(pollOnce, POLL_MS).unref();

// ---- API ----
app.get('/api/health', async () => ({
  ok: true,
  serverNowMs: Date.now(),
  feeds: Object.fromEntries(
    Object.entries(feedStatus).map(([id, s]) => [
      id,
      { reachable: s.ok, lastOkMs: s.lastOkMs, vehicleCount: s.count ?? null, error: s.error ?? null },
    ]),
  ),
}));

app.get('/api/cities', async () => {
  const cities: CitySummary[] = Object.values(FEEDS).map((f) => ({
    cityId: f.cityId, name: f.name, tier: f.tier, attribution: f.attribution,
    center: [(f.bbox[0] + f.bbox[2]) / 2, (f.bbox[1] + f.bbox[3]) / 2],
    active: f.cityId === 'toronto',
  }));
  return { cities };
});

// resolve the agency for a coordinate (coverage engine's runtime match)
app.get<{ Querystring: { lat: string; lon: string } }>('/api/resolve', async (req) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  const feed = feedForPoint(lon, lat);
  if (!feed) return { covered: false };
  return {
    covered: true, cityId: feed.cityId, name: feed.name, tier: feed.tier,
    attribution: feed.attribution, license: feed.license,
  };
});

function cityGuard(cityId: string) {
  return Boolean(FEEDS[cityId]);
}

app.get<{ Params: { city: string } }>('/api/:city/scene', async (req, reply) => {
  if (!cityGuard(req.params.city)) return reply.code(404).send({ error: 'unknown city' });
  return getScene(req.params.city);
});

app.get<{ Params: { city: string } }>('/api/:city/vehicles', async (req, reply) => {
  const { city } = req.params;
  if (!cityGuard(city)) return reply.code(404).send({ error: 'unknown city' });
  const now = Date.now();
  const s = feedStatus[city];
  // Honest source label: the recorded scene is what we render; when the upstream
  // feed is reachable we say so, but geo-correct live rendering needs the seed.
  const stale = s.ok && now - s.lastOkMs > 90_000;
  const resp: VehiclesResponse = {
    cityId: city,
    source: 'demo',
    lastPollMs: s.lastOkMs || now,
    serverNowMs: now,
    vehicles: getVehicles(city, now),
    anomalies: getAnomalies(city, now),
  };
  if (stale) resp.source = 'stale';
  return resp;
});

app.get<{ Params: { city: string; id: string } }>('/api/:city/stops/:id/arrivals', async (req, reply) => {
  if (!cityGuard(req.params.city)) return reply.code(404).send({ error: 'unknown city' });
  const arr = getArrivals(req.params.city, req.params.id, Date.now());
  if (!arr) return reply.code(404).send({ error: 'unknown stop' });
  return arr;
});

app.get<{ Params: { city: string }; Querystring: { q?: string } }>('/api/:city/stops', async (req, reply) => {
  if (!cityGuard(req.params.city)) return reply.code(404).send({ error: 'unknown city' });
  return { stops: getStops(req.params.city, req.query.q ?? '') };
});

app.get<{ Params: { city: string } }>('/api/:city/alerts', async (req, reply) => {
  if (!cityGuard(req.params.city)) return reply.code(404).send({ error: 'unknown city' });
  return { alerts: getAlerts(req.params.city, Date.now()) };
});

app.get<{ Params: { city: string } }>('/api/:city/ghosts', async (req, reply) => {
  if (!cityGuard(req.params.city)) return reply.code(404).send({ error: 'unknown city' });
  return { ghosts: getGhosts(req.params.city, Date.now()) };
});

app.get<{ Params: { city: string } }>('/api/:city/stats', async (req, reply) => {
  if (!cityGuard(req.params.city)) return reply.code(404).send({ error: 'unknown city' });
  return getStats(req.params.city, Date.now());
});

app.get<{ Params: { city: string; id: string } }>('/api/:city/routes/:id/report', async (req, reply) => {
  if (!cityGuard(req.params.city)) return reply.code(404).send({ error: 'unknown city' });
  const rep = getReport(req.params.city, req.params.id, Date.now());
  if (!rep) return reply.code(404).send({ error: 'unknown route' });
  return rep;
});

// ---- Open Ghost Data (feature 23) — zero user data by construction ----
app.get('/api/ghosts.json', async () => {
  const rows = Object.keys(FEEDS).flatMap((c) => getGhosts(c, Date.now()));
  return {
    schema: 'route,stop,scheduled,kind,detected',
    generated: new Date().toISOString(),
    events: rows.map((g) => ({
      city: g.cityId, route: g.routeShortName, stop: g.stopId, stopName: g.stopName,
      scheduled: new Date(g.scheduledMs).toISOString(), kind: g.kind,
      detected: new Date(g.detectedMs).toISOString(), accessibility: g.isAccessibility,
    })),
  };
});

app.get('/api/ghosts.csv', async (_req, reply) => {
  const rows = Object.keys(FEEDS).flatMap((c) => getGhosts(c, Date.now()));
  const header = 'city,route,stop,stop_name,scheduled,kind,detected,accessibility';
  const body = rows
    .map((g) =>
      [g.cityId, g.routeShortName, g.stopId, `"${g.stopName}"`,
       new Date(g.scheduledMs).toISOString(), g.kind,
       new Date(g.detectedMs).toISOString(), g.isAccessibility].join(','),
    )
    .join('\n');
  reply.header('content-type', 'text/csv; charset=utf-8');
  return `${header}\n${body}\n`;
});

// ---- serve the built frontend in production (one deployable service) ----
const distDir = join(__dirname, '..', 'dist');
if (existsSync(distDir)) {
  await app.register(fastifyStatic, { root: distDir });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.warn(`GhostBus API on :${PORT}`))
  .catch((e) => {
    app.log.error(e);
    process.exit(1);
  });
