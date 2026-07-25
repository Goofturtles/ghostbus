// The real Tier 0 map: a flat, hand-styled MapLibre map (OpenFreeMap vector
// tiles, zero-key) with procedurally-drawn voxel vehicle sprites as ONE symbol
// layer (handles ~1,500 vehicles at 60fps), the You beacon / boarding pin /
// walk path / red active-route markers, and self-contained 5s polling that
// pauses when the tab is hidden. Lazy-loaded so maplibre-gl stays out of the
// initial bundle. See DECISIONS §23.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// maplibre-gl v6 resolves its worker at RUNTIME with
// `new URL('./maplibre-gl-worker.mjs', import.meta.url)`. No bundler can see that,
// so `vite build` never emitted the worker and the built chunk asked the server for
// a sibling that did not exist — the SPA fallback answered with index.html, the module
// worker refused the text/html MIME type, and the whole map died in production while
// dev (which serves maplibre from source, next to its real worker) kept working.
// `?worker&url` makes Rollup bundle the worker (plus maplibre-gl-shared.mjs, which it
// imports) into a real hashed chunk and hands us its URL. See DECISIONS §29.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { VehicleDto, RouteShapeResponse } from '@shared/types';
import { api, type Bbox } from '@/lib/api';
import { useLive, selectedNearbyStop, DEFAULT_LOCATION } from '@/hooks/useLive';
import { useStore, resolveTheme, paceMps } from '@/store';
import { walkSeconds } from '@/lib/format';
import { buildStyle, type MapTheme } from './mapStyle';
import { makeVoxelSprite, spriteId, kindForRouteType, type VehicleKind } from './sprites';
import { readableOn } from '@/components/Primitives';
import { PlusIcon, MinusIcon, NavIcon, LayersIcon } from '@/components/icons';

const POLL_MS = 5000;
const ANIM_MS = 1200;
const FADE_MS = 420;
const JUMP_M = 500;            // beyond this a vehicle fades in place, never slides
const KNOWN_COLORS = ['ED1C24', '3C4A5B', '00A651', 'E472AC']; // the live TTC palette
const ICON_BASE = 0.82;
const ICON_SEL = 1.14;

// Point maplibre at the worker chunk Vite actually emitted, instead of the sibling
// path it would guess from import.meta.url. Module-scope so it runs exactly once,
// before any Map is constructed.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

type LngLat = [number, number];

function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000, toR = Math.PI / 180;
  const dLat = (bLat - aLat) * toR, dLon = (bLon - aLon) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function bearing(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const toR = Math.PI / 180;
  const y = Math.sin((bLon - aLon) * toR) * Math.cos(bLat * toR);
  const x = Math.cos(aLat * toR) * Math.sin(bLat * toR) - Math.sin(aLat * toR) * Math.cos(bLat * toR) * Math.cos((bLon - aLon) * toR);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Anim {
  feat: GeoJSON.Feature<GeoJSON.Point>;
  fromLon: number; fromLat: number; toLon: number; toLat: number;
  start: number; dur: number;
  fadeStart: number;        // 0 = no fade
  color: string; kind: VehicleKind; heading: number;
}

/** Resolve 'system' | 'light' | 'dark' to a concrete map theme, reacting to the
 *  OS setting when the preference is 'system'. */
function useMapTheme(): MapTheme {
  const pref = useStore((s) => s.theme);
  const [sys, setSys] = useState<MapTheme>(() => resolveTheme('system'));
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSys(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return pref === 'system' ? sys : pref;
}

export default function MapCard() {
  const { t } = useTranslation();
  const theme = useMapTheme();
  const expanded = useStore((s) => s.mapExpanded);
  const setExpanded = useStore((s) => s.setMapExpanded);
  const pace = useStore((s) => s.pace);

  const geo = useLive((s) => s.geo);
  const arrivals = useLive((s) => s.arrivals);

  const [selected, setSelected] = useState<VehicleDto | null>(null);
  // 'tiles'  = the style started but the vector source never became usable.
  // 'engine' = the map itself never finished loading (worker/style init failure).
  const [mapFailure, setMapFailure] = useState<'tiles' | 'engine' | null>(null);
  const [vehCount, setVehCount] = useState(0);

  // ---- imperative state kept off the React render path ----
  const wrapRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const animsRef = useRef<Map<string, Anim>>(new Map());
  const vehFCRef = useRef<GeoJSON.FeatureCollection<GeoJSON.Point>>({ type: 'FeatureCollection', features: [] });
  const rafRef = useRef<number | null>(null);
  const pollRef = useRef<number | null>(null);
  const moveTimerRef = useRef<number | null>(null);
  const registeredColors = useRef<Set<string>>(new Set());
  const youMarker = useRef<maplibregl.Marker | null>(null);
  const stopMarker = useRef<maplibregl.Marker | null>(null);
  const badgeMarker = useRef<maplibregl.Marker | null>(null);
  const userMoved = useRef(false);
  const centeredOnGeo = useRef(false);
  const routeGeoRef = useRef<RouteShapeResponse | null>(null);
  const tilesOkRef = useRef(false);
  const styleOkRef = useRef(false);
  const failTimerRef = useRef<number | null>(null);
  const themeInitedRef = useRef(false);
  const selectedRef = useRef<VehicleDto | null>(null);
  selectedRef.current = selected;

  // Boarding stop + walk math (used by markers + walk path).
  const boarding = useMemo(() => {
    if (!arrivals || arrivals.lat == null || arrivals.lon == null) return null;
    return { id: arrivals.stopId, name: arrivals.stopName, lat: arrivals.lat, lon: arrivals.lon };
  }, [arrivals]);
  const walkMin = useMemo(() => {
    if (!geo || !boarding) return null;
    const near = selectedNearbyStop();
    const dM = near?.distanceM ?? haversineM(geo.lat, geo.lon, boarding.lat, boarding.lon);
    return Math.max(1, Math.round(walkSeconds(dM, paceMps(pace)) / 60));
  }, [geo, boarding, pace]);

  // Which route line to draw in red: the selected vehicle's route, else the top
  // departure at the boarding stop.
  const focusRoute = useMemo<{ routeId: string; dir: number | null } | null>(() => {
    if (selected?.routeId) return { routeId: selected.routeId, dir: null };
    const d = arrivals?.departures?.[0];
    if (d?.routeId) return { routeId: d.routeId, dir: d.directionId };
    return null;
  }, [selected, arrivals]);

  // ============================ map init (once) ============================
  useEffect(() => {
    if (!wrapRef.current) return;
    const start: LngLat = geo ? [geo.lon, geo.lat] : [DEFAULT_LOCATION.lon, DEFAULT_LOCATION.lat];
    const map = new maplibregl.Map({
      container: wrapRef.current,
      style: buildStyle(theme),
      center: start,
      zoom: 14,
      minZoom: 9,
      maxZoom: 18,
      attributionControl: false, // added explicitly below so it is always visible + themed
      dragRotate: false,
      pitchWithRotate: false,
      cooperativeGestures: false,
      keyboard: false, // canvas stays keyboard-inert (it is aria-hidden; the list is the a11y path)
    });
    mapRef.current = map;
    // The GL canvas is aria-hidden; make it truly inert so keyboard focus can't land on it.
    map.getCanvas().setAttribute('tabindex', '-1');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    // Keep the OSM/OpenFreeMap attribution expanded + visible (license requirement).
    requestAnimationFrame(() => {
      map.getContainer().querySelector('.maplibregl-ctrl-attrib')?.classList.add('maplibregl-compact-show');
    });
    map.touchZoomRotate.disableRotation();

    // Tile-failure detection: don't latch on a single transient tile blip. The fallback
    // shows only if the vector source never becomes usable within a grace window; it
    // clears whenever the source (re)loads. Never a checkerboard (ground color shows through).
    map.on('sourcedata', (e) => {
      if (e.sourceId === 'omt' && e.isSourceLoaded) { tilesOkRef.current = true; setMapFailure(null); }
    });
    // Name the failure we actually observed. If the map never even finished loading,
    // the tile server is not the story — blaming it sent a whole phase chasing tiles
    // while the real fault was a worker that would not start. See DECISIONS §29.
    failTimerRef.current = window.setTimeout(() => {
      if (tilesOkRef.current) return;
      setMapFailure(styleOkRef.current ? 'tiles' : 'engine');
    }, 9000);
    map.on('movestart', (e: { originalEvent?: unknown }) => { if (e.originalEvent) userMoved.current = true; });
    map.on('moveend', () => scheduleFetch());

    map.on('load', () => {
      styleOkRef.current = true;
      installLayers(map, theme);
      fetchVehicles();
    });

    // vehicle selection with a generous hit radius (no precision taps)
    map.on('click', (e: maplibregl.MapMouseEvent) => {
      const pad = 14;
      const feats = map.queryRenderedFeatures(
        [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]],
        { layers: ['vehicles'] },
      );
      if (feats.length === 0) { deselect(); return; }
      // nearest to the tap
      let best = feats[0], bestD = Infinity;
      for (const f of feats) {
        const c = (f.geometry as GeoJSON.Point).coordinates;
        const p = map.project(c as LngLat);
        const d = (p.x - e.point.x) ** 2 + (p.y - e.point.y) ** 2;
        if (d < bestD) { bestD = d; best = f; }
      }
      selectVehicle(best.properties as unknown as VehicleDto);
    });
    map.on('mouseenter', 'vehicles', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'vehicles', () => { map.getCanvas().style.cursor = ''; });

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
      if (moveTimerRef.current) clearTimeout(moveTimerRef.current);
      if (failTimerRef.current) clearTimeout(failTimerRef.current);
      youMarker.current?.remove(); stopMarker.current?.remove(); badgeMarker.current?.remove();
      youMarker.current = stopMarker.current = badgeMarker.current = null;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============================ install sources/layers/images ============================
  /** The one precondition every vehicle write shares: a live map whose style still holds
   *  the `vehicles` source. It is absent before `load` fires (the first geo recenter fires
   *  `moveend` -> a fetch well before then), across a `setStyle` swap, and permanently if
   *  the style never initialises at all. Without this, each of those windows turned into
   *  hundreds of console errors per second from setFeatureState. */
  function vehSource(map: maplibregl.Map | null): maplibregl.GeoJSONSource | null {
    if (!map || !map.style) return null;
    try { return (map.getSource('vehicles') as maplibregl.GeoJSONSource | undefined) ?? null; }
    catch { return null; }
  }

  function ensureSprite(map: maplibregl.Map, kind: VehicleKind, color: string) {
    const id = spriteId(kind, color);
    if (map.hasImage(id)) return;
    const s = makeVoxelSprite(kind, color);
    map.addImage(id, { width: s.width, height: s.height, data: s.data }, { pixelRatio: s.pixelRatio });
  }

  function installLayers(map: maplibregl.Map, thm: MapTheme) {
    registeredColors.current.clear();
    // setStyle drops all images; re-register the known palette AND any colors already in
    // the live set so no vehicle references a missing icon after a theme swap.
    const colors = new Set<string>(KNOWN_COLORS);
    for (const f of vehFCRef.current.features) colors.add((f.properties as { color: string }).color);
    for (const c of colors) {
      ensureSprite(map, 'bus', c); ensureSprite(map, 'streetcar', c);
      registeredColors.current.add(c);
    }

    if (!map.getSource('walk-path')) map.addSource('walk-path', { type: 'geojson', data: emptyFC() });
    if (!map.getSource('route-shape')) map.addSource('route-shape', { type: 'geojson', data: emptyFC() });
    if (!map.getSource('route-stops')) map.addSource('route-stops', { type: 'geojson', data: emptyFC() });
    if (!map.getSource('vehicles')) map.addSource('vehicles', { type: 'geojson', data: vehFCRef.current, promoteId: 'id' });

    const purple = '#9a54bd';
    const red = thm === 'dark' ? '#FF4D4D' : '#E23434';
    const stopFill = thm === 'dark' ? '#0B0E1A' : '#ffffff';

    if (!map.getLayer('walk-line')) {
      map.addLayer({
        id: 'walk-line', type: 'line', source: 'walk-path',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': purple, 'line-width': 4, 'line-dasharray': [0, 2.2], 'line-opacity': 0.9 },
      });
    }
    if (!map.getLayer('route-line')) {
      map.addLayer({
        id: 'route-line', type: 'line', source: 'route-shape',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': red, 'line-opacity': 0.95,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 11, 2.5, 14, 4.5, 17, 8],
        },
      });
    }
    if (!map.getLayer('route-stops')) {
      map.addLayer({
        id: 'route-stops', type: 'circle', source: 'route-stops', minzoom: 13,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2, 16, 4],
          'circle-color': stopFill, 'circle-stroke-color': red, 'circle-stroke-width': 1.6, 'circle-opacity': 0.95,
        },
      });
    }
    if (!map.getLayer('vehicles')) {
      map.addLayer({
        id: 'vehicles', type: 'symbol', source: 'vehicles',
        layout: {
          'icon-image': ['get', 'sprite'],
          'icon-rotate': ['get', 'heading'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          // feature-state is paint-only; selection scale rides a data-driven property instead.
          'icon-size': ['case', ['==', ['get', 'sel'], 1], ICON_SEL, ICON_BASE],
        },
        paint: { 'icon-opacity': ['coalesce', ['feature-state', 'op'], 1] },
      });
    }

    // re-apply live data after a style swap
    applyRoute(map);
    applyWalk(map);
    vehSource(map)?.setData(vehFCRef.current);
    restoreFeatureStates(map);
  }

  function restoreFeatureStates(map: maplibregl.Map) {
    if (!vehSource(map)) return;
    // `sel` lives in feature properties (survives setData); only `op` is feature-state.
    for (const f of vehFCRef.current.features) {
      map.setFeatureState({ source: 'vehicles', id: (f.properties as { id: string }).id }, { op: 1 });
    }
  }

  // ============================ theme restyle ============================
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Skip only the very first run (map was created with this theme already).
    if (!themeInitedRef.current) { themeInitedRef.current = true; return; }
    map.setStyle(buildStyle(theme), { diff: false });
    const onData = () => {
      if (!map.isStyleLoaded()) return;
      map.off('styledata', onData);
      installLayers(map, theme);
    };
    map.on('styledata', onData);
    return () => { map.off('styledata', onData); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  // ============================ 5s polling (paused when hidden) ============================
  function currentBbox(): Bbox {
    const map = mapRef.current!;
    const b = map.getBounds();
    const clamp = (lo: number, hi: number, max: number): [number, number] => {
      if (hi - lo <= max) return [lo, hi];
      const c = (lo + hi) / 2; return [c - max / 2, c + max / 2];
    };
    const [minLon, maxLon] = clamp(b.getWest(), b.getEast(), 2.9);
    const [minLat, maxLat] = clamp(b.getSouth(), b.getNorth(), 2.9);
    return [minLon, minLat, maxLon, maxLat];
  }
  async function fetchVehicles() {
    const map = mapRef.current;
    if (!map || document.hidden) return;
    try {
      const res = await api.vehicles(currentBbox());
      if (!mapRef.current) return;
      ingest(res.vehicles);
      setVehCount(res.count);
    } catch { /* transient; next tick retries */ }
  }
  function scheduleFetch() {
    if (moveTimerRef.current) clearTimeout(moveTimerRef.current);
    moveTimerRef.current = window.setTimeout(() => fetchVehicles(), 400);
  }
  useEffect(() => {
    pollRef.current = window.setInterval(() => {
      if (document.hidden) { if (import.meta.env.DEV) console.log('[map] 5s poll skipped — document hidden'); return; }
      fetchVehicles();
    }, POLL_MS);
    const onVis = () => {
      if (document.hidden) { if (import.meta.env.DEV) console.log('[map] polling paused — document hidden'); }
      else fetchVehicles();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============================ ingest + animate ============================
  function ingest(vehicles: VehicleDto[]) {
    const map = mapRef.current;
    // No usable style yet (or ever): drop this tick silently. `vehFCRef`/`anims` stay
    // empty, so the next poll after the source appears rebuilds the whole fleet.
    if (!map || !vehSource(map)) return;
    const now = performance.now();
    const anims = animsRef.current;
    const seen = new Set<string>();
    const reduce = prefersReducedMotion();

    for (const v of vehicles) {
      seen.add(v.id);
      const color = /^[0-9a-fA-F]{6}$/.test(v.color) ? v.color.toUpperCase() : '3C4A5B';
      if (!registeredColors.current.has(color)) {
        ensureSprite(map, 'bus', color); ensureSprite(map, 'streetcar', color);
        registeredColors.current.add(color);
      }
      const kind = kindForRouteType(v.routeType);
      const sprite = spriteId(kind, color);
      const existing = anims.get(v.id);
      if (!existing) {
        const feat: GeoJSON.Feature<GeoJSON.Point> = {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
          properties: { id: v.id, sprite, heading: v.heading ?? 0, sel: v.id === selectedRef.current?.id ? 1 : 0, routeId: v.routeId, shortName: v.shortName, routeType: v.routeType, color },
        };
        vehFCRef.current.features.push(feat);
        anims.set(v.id, {
          feat, fromLon: v.lon, fromLat: v.lat, toLon: v.lon, toLat: v.lat,
          start: now, dur: 0, fadeStart: reduce ? 0 : now, color, kind, heading: v.heading ?? 0,
        });
        map.setFeatureState({ source: 'vehicles', id: v.id }, { op: reduce ? 1 : 0, sel: false });
      } else {
        // current interpolated position becomes the tween origin
        const p = posOf(existing, now);
        const dist = haversineM(p[1], p[0], v.lat, v.lon);
        existing.fromLon = p[0]; existing.fromLat = p[1];
        existing.toLon = v.lon; existing.toLat = v.lat;
        existing.color = color; existing.kind = kind;
        const hdg = v.heading ?? (dist > 3 ? bearing(p[0], p[1], v.lon, v.lat) : existing.heading);
        existing.heading = hdg;
        (existing.feat.properties as Record<string, unknown>).sprite = sprite;
        (existing.feat.properties as Record<string, unknown>).heading = hdg;
        (existing.feat.properties as Record<string, unknown>).routeId = v.routeId;
        (existing.feat.properties as Record<string, unknown>).shortName = v.shortName;
        if (dist > JUMP_M && !reduce) {
          // teleport → place at destination and fade back in (never a slide across the map)
          existing.feat.geometry.coordinates = [v.lon, v.lat];
          existing.fromLon = v.lon; existing.fromLat = v.lat;
          existing.start = now; existing.dur = 0; existing.fadeStart = now;
          map.setFeatureState({ source: 'vehicles', id: v.id }, { op: 0 });
        } else {
          existing.start = now; existing.dur = reduce ? 0 : ANIM_MS; existing.fadeStart = 0;
          if (reduce) existing.feat.geometry.coordinates = [v.lon, v.lat];
        }
      }
    }

    // drop vehicles no longer in the viewport feed
    if (seen.size !== anims.size) {
      const kept: GeoJSON.Feature<GeoJSON.Point>[] = [];
      for (const f of vehFCRef.current.features) {
        const id = (f.properties as { id: string }).id;
        if (seen.has(id)) kept.push(f); else { anims.delete(id); map.removeFeatureState({ source: 'vehicles', id }); }
      }
      vehFCRef.current.features = kept;
    }

    vehSource(map)?.setData(vehFCRef.current);
    startRaf();
    updateBadge();
  }

  function posOf(a: Anim, now: number): LngLat {
    if (a.dur <= 0) return [a.toLon, a.toLat];
    const t = Math.min(1, (now - a.start) / a.dur);
    const e = easeOut(t);
    return [a.fromLon + (a.toLon - a.fromLon) * e, a.fromLat + (a.toLat - a.fromLat) * e];
  }

  function startRaf() {
    if (rafRef.current != null) return;
    const tick = () => {
      // Re-checked every frame, not just at start: a theme swap drops the source
      // mid-animation, and this loop writes feature-state per vehicle per frame.
      const map = mapRef.current;
      const src = vehSource(map);
      if (!map || !src) { rafRef.current = null; return; }
      const now = performance.now();
      let active = false;
      for (const a of animsRef.current.values()) {
        if (a.dur > 0) {
          const t = (now - a.start) / a.dur;
          if (t < 1) { a.feat.geometry.coordinates = posOf(a, now); active = true; }
          else { a.feat.geometry.coordinates = [a.toLon, a.toLat]; a.dur = 0; }
        }
        if (a.fadeStart > 0) {
          const ft = (now - a.fadeStart) / FADE_MS;
          if (ft < 1) { map.setFeatureState({ source: 'vehicles', id: (a.feat.properties as { id: string }).id }, { op: Math.max(0, ft) }); active = true; }
          else { map.setFeatureState({ source: 'vehicles', id: (a.feat.properties as { id: string }).id }, { op: 1 }); a.fadeStart = 0; }
        }
      }
      src.setData(vehFCRef.current);
      updateBadge();
      if (active) { rafRef.current = requestAnimationFrame(tick); }
      else { rafRef.current = null; }
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  // ============================ selection ============================
  function setSelProp(id: string, on: boolean) {
    const a = animsRef.current.get(id);
    if (a) (a.feat.properties as Record<string, unknown>).sel = on ? 1 : 0;
  }
  function selectVehicle(v: VehicleDto) {
    const map = mapRef.current!;
    const prev = selectedRef.current?.id;
    if (prev && prev !== v.id) setSelProp(prev, false);
    setSelProp(v.id, true);
    vehSource(map)?.setData(vehFCRef.current);
    setSelected(v);
    const a = animsRef.current.get(v.id);
    const c: LngLat = a ? [a.toLon, a.toLat] : [v.lon, v.lat];
    if (prefersReducedMotion()) map.jumpTo({ center: c });
    else map.easeTo({ center: c, duration: 600, zoom: Math.max(map.getZoom(), 14.5) });
  }
  function deselect() {
    const map = mapRef.current!;
    const prev = selectedRef.current?.id;
    if (prev) { setSelProp(prev, false); vehSource(map)?.setData(vehFCRef.current); }
    setSelected(null);
    badgeMarker.current?.remove(); badgeMarker.current = null;
  }

  // ============================ DOM markers ============================
  function updateBadge() {
    const v = selectedRef.current;
    if (!v) { badgeMarker.current?.remove(); badgeMarker.current = null; return; }
    const map = mapRef.current!;
    const a = animsRef.current.get(v.id);
    const c: LngLat = a ? (a.feat.geometry.coordinates as LngLat) : [v.lon, v.lat];
    const label = v.shortName ?? v.routeId ?? '—';
    const hex = /^[0-9a-fA-F]{6}$/.test(v.color) ? v.color : 'ED1C24';
    if (!badgeMarker.current) {
      const el = document.createElement('div');
      el.className = 'map-badge';
      el.style.setProperty('--badge', `#${hex}`);
      el.style.color = readableOn(hex); // AA on any agency color (black/white per luminance)
      el.textContent = label;
      badgeMarker.current = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -22] }).setLngLat(c).addTo(map);
    } else {
      const el = badgeMarker.current.getElement();
      el.style.setProperty('--badge', `#${hex}`);
      el.style.color = readableOn(hex);
      el.textContent = label;
      badgeMarker.current.setLngLat(c);
    }
    collide();
  }

  // You beacon + boarding pin
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // You beacon
    if (geo) {
      if (!youMarker.current) {
        const el = document.createElement('div');
        el.className = 'you-beacon';
        el.innerHTML =
          '<span class="you-bloom" aria-hidden="true"></span>' +
          '<span class="you-disc"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.4"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg></span>' +
          '<span class="you-pill"></span>';
        youMarker.current = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([geo.lon, geo.lat]).addTo(map);
      } else {
        youMarker.current.setLngLat([geo.lon, geo.lat]);
      }
      const pill = youMarker.current.getElement().querySelector('.you-pill') as HTMLElement;
      pill.textContent = walkMin != null ? t('map.youWalk', { min: walkMin }) : t('map.you');
      // one eased recenter on first real fix
      if (!centeredOnGeo.current && !userMoved.current) {
        centeredOnGeo.current = true;
        if (prefersReducedMotion()) map.jumpTo({ center: [geo.lon, geo.lat] });
        else map.easeTo({ center: [geo.lon, geo.lat], duration: 800 });
      }
    } else if (youMarker.current) {
      youMarker.current.remove(); youMarker.current = null;
    }
    // Boarding stop pin
    if (boarding) {
      const html =
        '<span class="stop-pin-dot"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10Z"/><circle cx="12" cy="11" r="2.2"/></svg></span>' +
        `<span class="stop-card"><b>${escapeHtml(boarding.name ?? t('stop.code', { code: boarding.id }))}</b><i>${escapeHtml(t('stop.code', { code: boarding.id }))}</i></span>`;
      if (!stopMarker.current) {
        const el = document.createElement('div');
        el.className = 'stop-marker';
        el.innerHTML = html;
        stopMarker.current = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([boarding.lon, boarding.lat]).addTo(map);
      } else {
        stopMarker.current.getElement().innerHTML = html;
        stopMarker.current.setLngLat([boarding.lon, boarding.lat]);
      }
    } else if (stopMarker.current) {
      stopMarker.current.remove(); stopMarker.current = null;
    }
    collide();
  }, [geo, boarding, walkMin, t]);

  // ============================ walk path ============================
  function applyWalk(map: maplibregl.Map) {
    const src = map.getSource('walk-path') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (geo && boarding) {
      src.setData({
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: [[geo.lon, geo.lat], [boarding.lon, boarding.lat]] },
      });
    } else src.setData(emptyFC());
  }
  useEffect(() => { const m = mapRef.current; if (m) applyWalk(m); }, [geo, boarding]);

  // ============================ route shape (red line + stop dots) ============================
  useEffect(() => {
    let alive = true;
    if (!focusRoute) { routeGeoRef.current = null; const m = mapRef.current; if (m?.getSource('route-shape')) applyRoute(m); return; }
    api.routeShape(focusRoute.routeId, focusRoute.dir)
      // applyRoute only calls source.setData (safe whenever the source exists); do NOT
      // gate on isStyleLoaded(), which flips false transiently while tiles reload.
      .then((r) => { if (!alive) return; routeGeoRef.current = r; const m = mapRef.current; if (m) applyRoute(m); })
      .catch(() => { if (alive) { routeGeoRef.current = null; } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRoute?.routeId, focusRoute?.dir]);

  function applyRoute(map: maplibregl.Map) {
    const line = map.getSource('route-shape') as maplibregl.GeoJSONSource | undefined;
    const dots = map.getSource('route-stops') as maplibregl.GeoJSONSource | undefined;
    const r = routeGeoRef.current;
    if (!line || !dots) return;
    if (!r) { line.setData(emptyFC()); dots.setData(emptyFC()); return; }
    line.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.coordinates } });
    dots.setData({
      type: 'FeatureCollection',
      features: r.stops.map((s) => ({ type: 'Feature', properties: { id: s.stopId }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })),
    });
  }

  // ============================ fullscreen resize ============================
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const id = window.setTimeout(() => map.resize(), 260); // after the CSS transition
    return () => clearTimeout(id);
  }, [expanded]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && useStore.getState().mapExpanded) setExpanded(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setExpanded]);

  // Label discipline: priority badge > you pill > stop card. Hide the lower one when
  // two overlap, or when a label would sit under the map controls (app chrome).
  function collide() {
    const els = [
      badgeMarker.current?.getElement(),
      youMarker.current?.getElement()?.querySelector('.you-pill') as HTMLElement | undefined,
      stopMarker.current?.getElement()?.querySelector('.stop-card') as HTMLElement | undefined,
    ].filter(Boolean) as HTMLElement[];
    for (const e of els) e.style.visibility = '';
    const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const chrome = wrapRef.current?.parentElement?.querySelector('.map-controls')?.getBoundingClientRect();
    for (let i = 0; i < els.length; i++) {
      if (els[i].style.visibility === 'hidden') continue;
      const a = els[i].getBoundingClientRect();
      if (a.width === 0) continue;
      if (chrome && overlaps(a, chrome)) { els[i].style.visibility = 'hidden'; continue; }
      for (let j = i + 1; j < els.length; j++) {
        if (els[j].style.visibility === 'hidden') continue;
        const b = els[j].getBoundingClientRect();
        if (b.width === 0) continue;
        if (overlaps(a, b)) els[j].style.visibility = 'hidden';
      }
    }
  }
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    const on = () => collide();
    map.on('move', on);
    return () => { map.off('move', on); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============================ render ============================
  const flyToMe = () => {
    const map = mapRef.current; if (!map) return;
    const c: LngLat = geo ? [geo.lon, geo.lat] : [DEFAULT_LOCATION.lon, DEFAULT_LOCATION.lat];
    userMoved.current = true;
    if (prefersReducedMotion()) map.jumpTo({ center: c, zoom: 15 });
    else map.easeTo({ center: c, zoom: 15, duration: 700 });
  };

  return (
    <div className={`map-card map-live ${expanded ? 'map-expanded' : ''}`}>
      <div className="map-canvas" ref={wrapRef} aria-hidden="true" />
      <p className="sr-only">
        {t('map.srAlt', { count: vehCount, stop: boarding?.name ?? t('stop.code', { code: boarding?.id ?? '—' }) })}
      </p>
      <p className="sr-only" aria-live="polite">
        {selected ? t('map.selectedVehicle', { route: selected.shortName ?? selected.routeId ?? '—' }) : ''}
      </p>

      {mapFailure && (
        <div className="map-fallback" role="status">
          <span className="map-fallback-glyph" aria-hidden><LayersIcon width={20} height={20} /></span>
          {/* 'tiles' is the only failure `map.tilesUnavailable` actually describes. For an
              engine failure it would be a guess dressed as a diagnosis, so fall back to the
              neutral 'map.loading' until a truthful key exists in all three locales.
              TODO(i18n, owner: orchestrator): add `map.engineUnavailable` to en/frCA/es —
              EN: "Map can't load right now — the list below is still live." */}
          <span>{t(mapFailure === 'tiles' ? 'map.tilesUnavailable' : 'map.loading')}</span>
        </div>
      )}

      <div className="map-controls" role="group" aria-label={t('map.controls')}>
        <div className="map-zoom">
          <button className="map-ctrl" aria-label={t('a11y.zoomIn')} onClick={() => mapRef.current?.zoomIn()}><PlusIcon width={18} height={18} /></button>
          <span className="map-zoom-sep" aria-hidden />
          <button className="map-ctrl" aria-label={t('a11y.zoomOut')} onClick={() => mapRef.current?.zoomOut()}><MinusIcon width={18} height={18} /></button>
        </div>
        <button className="map-ctrl map-ctrl-solo" aria-label={t('a11y.locate')} onClick={flyToMe}><NavIcon width={18} height={18} /></button>
        <button
          className="map-ctrl map-ctrl-solo map-ctrl-expand"
          aria-label={expanded ? t('map.collapse') : t('map.expand')}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <CollapseGlyph /> : <ExpandGlyph />}
        </button>
      </div>
    </div>
  );
}

function ExpandGlyph() {
  return (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5" /></svg>);
}
function CollapseGlyph() {
  return (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 4v5H4M15 4v5h5M15 20v-5h5M9 20v-5H4" /></svg>);
}

function emptyFC(): GeoJSON.FeatureCollection { return { type: 'FeatureCollection', features: [] }; }
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
