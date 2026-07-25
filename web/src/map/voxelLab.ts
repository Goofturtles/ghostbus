// DEV-ONLY harness for the voxel city (web/voxel-lab.html).
//
// Not a Vite build entry — nothing here reaches the production bundle. Its job is
// to render voxelCity.ts over real Toronto geography, with MapCard's exact overlay
// layer ids present, so the look and the layer ordering can be judged and
// screenshotted without touching MapCard.tsx.

// MUST be first: sets maplibre's worker URL at module scope, before any Map is
// constructed. Without it this page is perfect in dev and a blank grey box in any
// production build. See mapWorker.ts.
import './mapWorker';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { buildStyle, type MapTheme } from './mapStyle';
import { makeVoxelSprite, spriteId } from './sprites';
import {
  addVoxelCityLayers,
  removeVoxelCityLayers,
  setVoxelCityRouteFocus,
  applyVoxelCamera,
  resetVoxelCamera,
  voxelCityAllowed,
  resolveQuality,
  VOXEL_PITCH,
  VOXEL_DIORAMA_ZOOM,
  type VoxelQuality,
} from './voxelCity';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = Number(q.get(k));
  return Number.isFinite(v) && q.get(k) !== null ? v : d;
};

// King St W at Spadina Ave — the stop in the reference screenshot.
const CENTER: [number, number] = [num('lon', -79.39555), num('lat', 43.64475)];

let theme: MapTheme = q.get('theme') === 'light' ? 'light' : 'dark';
let quality: VoxelQuality = (q.get('quality') as VoxelQuality) || 'full';
let voxelOn = q.get('novoxel') !== '1';
let focused = q.get('focus') === '1';
let pitch = num("pitch", VOXEL_PITCH);
let bearing = num('bearing', -17);
let zoom = num('zoom', VOXEL_DIORAMA_ZOOM);

document.documentElement.setAttribute('data-theme', theme);
if (q.get('bare') === '1') document.getElementById('panel')?.classList.add('hidden');
if (q.get('card') === '1') document.getElementById('lab')?.classList.add('card');

const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(theme),
  center: CENTER,
  zoom,
  pitch,
  bearing,
  minZoom: 9,
  maxZoom: 18,
  attributionControl: false,
  dragRotate: true, // lab only — the app keeps rotation locked
});
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
// ?card=1 resizes the container after MapLibre has already measured it.
new ResizeObserver(() => map.resize()).observe(document.getElementById('map')!);

// ------------------------------------------------------------------ overlays
// Same layer ids MapCard installs, in the same order, so voxelCity's
// "insert beneath the first overlay" rule is exercised for real.

const RED = () => (theme === 'dark' ? '#FF4D4D' : '#E23434');
const PURPLE = '#9a54bd';

interface Shape {
  coordinates: [number, number][];
  stops: { stopId: string; lat: number; lon: number }[];
}
let shape: Shape | null = null;

/** Straight-ish fallback along King St W if the API isn't up in this dev session. */
function fallbackShape(): Shape {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    pts.push([-79.4105 + t * 0.031, 43.6462 - t * 0.0032]);
  }
  return {
    coordinates: pts,
    stops: pts.filter((_, i) => i % 6 === 0).map((p, i) => ({ stopId: `s${i}`, lat: p[1], lon: p[0] })),
  };
}

async function loadShape(): Promise<Shape> {
  for (const r of ['504', '501', '510']) {
    try {
      const res = await fetch(`/api/routes/${r}/shape?dir=0`);
      if (!res.ok) continue;
      const j = (await res.json()) as Shape;
      if (j?.coordinates?.length > 2) return j;
    } catch {
      /* dev API may not be running; fall through */
    }
  }
  return fallbackShape();
}

function emptyFC(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function installOverlays() {
  if (!map.getSource('walk-path')) map.addSource('walk-path', { type: 'geojson', data: emptyFC() });
  if (!map.getSource('route-shape')) map.addSource('route-shape', { type: 'geojson', data: emptyFC() });
  if (!map.getSource('route-stops')) map.addSource('route-stops', { type: 'geojson', data: emptyFC() });
  if (!map.getSource('vehicles')) map.addSource('vehicles', { type: 'geojson', data: emptyFC() });

  for (const c of ['ED1C24', '3C4A5B']) {
    for (const k of ['bus', 'streetcar'] as const) {
      const id = spriteId(k, c);
      if (!map.hasImage(id)) {
        const s = makeVoxelSprite(k, c);
        map.addImage(id, { width: s.width, height: s.height, data: s.data }, { pixelRatio: s.pixelRatio });
      }
    }
  }

  if (!map.getLayer('walk-line')) {
    map.addLayer({
      id: 'walk-line', type: 'line', source: 'walk-path',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': PURPLE, 'line-width': 4, 'line-dasharray': [0, 2.2], 'line-opacity': 0.9 },
    });
  }
  if (!map.getLayer('route-line')) {
    map.addLayer({
      id: 'route-line', type: 'line', source: 'route-shape',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': RED(), 'line-opacity': 0.95,
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 11, 2.5, 14, 4.5, 17, 8],
      },
    });
  }
  if (!map.getLayer('route-stops')) {
    map.addLayer({
      id: 'route-stops', type: 'circle', source: 'route-stops', minzoom: 13,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2, 16, 4],
        'circle-color': theme === 'dark' ? '#0B0E1A' : '#ffffff',
        'circle-stroke-color': RED(), 'circle-stroke-width': 1.6, 'circle-opacity': 0.95,
      },
    });
  }
  if (!map.getLayer('vehicles')) {
    map.addLayer({
      id: 'vehicles', type: 'symbol', source: 'vehicles',
      layout: {
        'icon-image': ['get', 'sprite'], 'icon-rotate': ['get', 'heading'],
        'icon-rotation-alignment': 'map', 'icon-allow-overlap': true,
        'icon-ignore-placement': true, 'icon-size': 1.05,
      },
    });
  }
  applyShape();
}

function applyShape() {
  const s = shape;
  const line = map.getSource('route-shape') as maplibregl.GeoJSONSource | undefined;
  const dots = map.getSource('route-stops') as maplibregl.GeoJSONSource | undefined;
  const veh = map.getSource('vehicles') as maplibregl.GeoJSONSource | undefined;
  const walk = map.getSource('walk-path') as maplibregl.GeoJSONSource | undefined;
  if (!s || !line || !dots || !veh || !walk) return;

  line.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: s.coordinates } });
  dots.setData({
    type: 'FeatureCollection',
    features: s.stops.map((st) => ({
      type: 'Feature', properties: { id: st.stopId },
      geometry: { type: 'Point', coordinates: [st.lon, st.lat] },
    })),
  });
  // A handful of vehicles spaced along the shape, to prove nothing occludes them.
  const step = Math.max(1, Math.floor(s.coordinates.length / 7));
  veh.setData({
    type: 'FeatureCollection',
    features: s.coordinates.filter((_, i) => i % step === 0).slice(0, 7).map((c, i) => ({
      type: 'Feature',
      properties: { sprite: spriteId(i % 2 ? 'bus' : 'streetcar', i % 2 ? '3C4A5B' : 'ED1C24'), heading: 105 },
      geometry: { type: 'Point', coordinates: c },
    })),
  });
  walk.setData({
    type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: [[CENTER[0] - 0.0016, CENTER[1] - 0.0009], CENTER] },
  });
}

// ------------------------------------------------------------------ markers
function addMarkers() {
  const you = document.createElement('div');
  you.className = 'you-beacon';
  you.innerHTML =
    '<span class="you-bloom" aria-hidden="true"></span>' +
    '<span class="you-disc"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.4"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg></span>' +
    '<span class="you-pill">You · 4 min walk</span>';
  new maplibregl.Marker({ element: you, anchor: 'center' })
    .setLngLat([CENTER[0] - 0.0016, CENTER[1] - 0.0009]).addTo(map);

  const stop = document.createElement('div');
  stop.className = 'stop-marker';
  stop.innerHTML =
    '<span class="stop-pin-dot"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10Z"/><circle cx="12" cy="11" r="2.2"/></svg></span>' +
    '<span class="stop-card"><b>King St W</b><i>Stop 4197</i></span>';
  new maplibregl.Marker({ element: stop, anchor: 'bottom' }).setLngLat(CENTER).addTo(map);

  const badge = document.createElement('div');
  badge.className = 'map-badge';
  badge.style.setProperty('--badge', '#ED1C24');
  badge.style.color = '#fff';
  badge.textContent = '504A';
  new maplibregl.Marker({ element: badge, anchor: 'bottom', offset: [0, -22] })
    .setLngLat([CENTER[0] + 0.0012, CENTER[1] + 0.0006]).addTo(map);
}

// ------------------------------------------------------------------ voxel city
function syncVoxel() {
  if (voxelOn && voxelCityAllowed(quality)) {
    addVoxelCityLayers(map, theme, { routeFocused: focused });
    applyVoxelCamera(map, { animate: false, minZoom: null });
    map.setPitch(pitch);
  } else {
    removeVoxelCityLayers(map);
    if (!voxelOn) resetVoxelCamera(map, false);
  }
}

map.on('load', async () => {
  installOverlays();
  syncVoxel();
  shape = await loadShape();
  applyShape();
  addMarkers();
  (window as unknown as Record<string, unknown>).__voxelReady = true;
});
(window as unknown as Record<string, unknown>).__voxelMap = map;

function restyle() {
  document.documentElement.setAttribute('data-theme', theme);
  removeVoxelCityLayers(map);
  map.setStyle(buildStyle(theme), { diff: false });
  const once = () => {
    if (!map.isStyleLoaded()) return;
    map.off('styledata', once);
    installOverlays();
    syncVoxel();
  };
  map.on('styledata', once);
}

// ------------------------------------------------------------------ panel
const $ = (id: string) => document.getElementById(id)!;
function paint() {
  $('b-theme').textContent = `theme: ${theme}`;
  $('b-voxel').dataset.on = voxelOn ? '1' : '0';
  $('b-focus').dataset.on = focused ? '1' : '0';
  $('b-quality').textContent = `quality: ${quality} → ${resolveQuality(quality)}`;
  $('v-pitch').textContent = String(Math.round(map.getPitch()));
  $('v-bearing').textContent = String(Math.round(map.getBearing()));
  $('v-zoom').textContent = map.getZoom().toFixed(1);
  (<HTMLInputElement>$('r-pitch')).value = String(map.getPitch());
  (<HTMLInputElement>$('r-bearing')).value = String(map.getBearing());
  (<HTMLInputElement>$('r-zoom')).value = String(map.getZoom());
}
$('b-theme').addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; restyle(); paint(); });
$('b-voxel').addEventListener('click', () => { voxelOn = !voxelOn; syncVoxel(); paint(); });
$('b-focus').addEventListener('click', () => { focused = !focused; setVoxelCityRouteFocus(map, focused); paint(); });
$('b-quality').addEventListener('click', () => {
  const order: VoxelQuality[] = ['full', 'reduced', 'lite', 'auto'];
  quality = order[(order.indexOf(quality) + 1) % order.length];
  syncVoxel(); paint();
});
$('r-pitch').addEventListener('input', (e) => { pitch = +(<HTMLInputElement>e.target).value; map.setPitch(pitch); paint(); });
$('r-bearing').addEventListener('input', (e) => { bearing = +(<HTMLInputElement>e.target).value; map.setBearing(bearing); paint(); });
$('r-zoom').addEventListener('input', (e) => { zoom = +(<HTMLInputElement>e.target).value; map.setZoom(zoom); paint(); });
map.on('move', paint);
paint();

// ------------------------------------------------------------------ fps probe
// Exposed for the screenshot/benchmark script: __voxelFps(ms) resolves with the
// measured frame timings while the map is continuously repainting.
const fpsEl = $('fps');
(window as unknown as Record<string, unknown>).__voxelFps = (ms = 3000) =>
  new Promise<{ frames: number; fps: number; p50: number; p95: number; worst: number }>((resolve) => {
    const times: number[] = [];
    let last = performance.now();
    const t0 = last;
    const tick = () => {
      const now = performance.now();
      times.push(now - last);
      last = now;
      map.triggerRepaint();
      if (now - t0 < ms) requestAnimationFrame(tick);
      else {
        const s = [...times].sort((a, b) => a - b);
        const pick = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
        const out = {
          frames: times.length,
          fps: +(1000 * times.length / (now - t0)).toFixed(1),
          p50: +pick(0.5).toFixed(2),
          p95: +pick(0.95).toFixed(2),
          worst: +(s[s.length - 1] ?? 0).toFixed(2),
        };
        fpsEl.innerHTML = `fps <b>${out.fps}</b> · p50 ${out.p50}ms · p95 ${out.p95}ms`;
        resolve(out);
      }
    };
    requestAnimationFrame(tick);
  });
