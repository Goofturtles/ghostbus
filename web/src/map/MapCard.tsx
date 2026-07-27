// The real Tier 0 map: a flat, hand-styled MapLibre map (OpenFreeMap vector
// tiles, zero-key) with procedurally-drawn voxel vehicle sprites as ONE symbol
// layer (handles ~1,500 vehicles at 60fps), the You beacon / boarding pin /
// walk path / red active-route markers, and self-contained 5s polling that
// pauses when the tab is hidden. Lazy-loaded so maplibre-gl stays out of the
// initial bundle. See DECISIONS §23.
// MUST be the first local import: `mapWorker` calls `maplibregl.setWorkerUrl()` at
// module scope, and that has to happen before any Map is constructed. It is now the
// ONLY place the worker URL is named — this file used to carry a second copy, and
// two copies of the fix that unbroke the production map would drift, which means a
// blank grey box in production and a perfect map in dev. See DECISIONS §28.
import './mapWorker';
import './map.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { VehicleDto, RouteShapeResponse } from '@shared/types';
import { api, type Bbox } from '@/lib/api';
import { useLive, selectedNearbyStop, DEFAULT_LOCATION, isBackedOff, noteFailure } from '@/hooks/useLive';
import { useStore, resolveTheme, paceMps } from '@/store';
import { walkLegSeconds, type MeasuredWalk } from '@/lib/walk';
import { pathMidpoint } from '@/lib/walkRoute';
import { resolveWalkLeg } from './walkPath';
import { buildStyle, type MapTheme } from './mapStyle';
import { makeVoxelSprite, spriteId, kindForRouteType, SPRITE_SIZE_PX, type VehicleKind } from './sprites';
import {
  addVoxelCityLayers,
  removeVoxelCityLayers,
  setVoxelCityTheme,
  applyVoxelCamera,
  resetVoxelCamera,
  voxelCityAllowed,
  voxelInsertionPoint,
  syncVoxelCity,
  VOXEL_DIORAMA_ZOOM,
  VOXEL_PITCH,
  VOXEL_BEARING,
  VOXEL_MAX_PITCH,
  VOXEL_FOV_DEG,
  DEFAULT_FOV_DEG,
  setVoxelFov,
} from './voxelCity';
import {
  addVoxelTreeLayers,
  removeVoxelTreeLayers,
  setVoxelTreeTheme,
  syncVoxelTrees,
  voxelTreeStats,
} from './voxelTrees';
import {
  addVoxelVehicleLayers,
  removeVoxelVehicleLayers,
  setVoxelVehicleTheme,
  setVoxelVehicles,
  type VoxelVehicle,
} from './voxelVehicles';
import { readableOn } from '@/components/Primitives';
import { PlusIcon, MinusIcon, NavIcon, LayersIcon } from '@/components/icons';

const POLL_MS = 5000;
const ANIM_MS = 1200;
const FADE_MS = 420;
const JUMP_M = 500;            // beyond this a vehicle fades in place, never slides
const KNOWN_COLORS = ['ED1C24', '3C4A5B', '00A651', 'E472AC']; // the live TTC palette
/** Sprites are authored at their final size (see `S` in sprites.ts), so icon-size
 *  stays at 1 and MapLibre draws them at native resolution instead of upscaling a
 *  small image into a blurry one. */
const ICON_BASE = 1;
const ICON_SEL = 1.18;
/** How far above a vehicle's ground point the route badge's bottom edge sits.
 *  `SPRITE_SIZE_PX * 0.42` is the sprite's roof when it is pointing north (its
 *  worst case — a sprite pointing east is narrower), plus a few px of air. */
const BADGE_LIFT_PX = Math.round(SPRITE_SIZE_PX * 0.42) + 5;
/** Below this card width the reference keeps at most three floating labels on the
 *  map at once (DESIGN-TARGET §D). Measured against the card, not the window, so
 *  a narrow map inside a wide desktop window is treated as narrow. */
const NARROW_CARD_PX = 480;
/** Floor between two tile-driven city rebuilds, in ms. Low enough that the city
 *  visibly fills in as tiles land, high enough that a burst of twenty tiles does
 *  not rebuild the whole instance buffer twenty times. */
const CITY_BUILD_MIN_MS = 120;
/** How often the (invisible) sprite source is refreshed while the 3D models are
 *  drawing. It exists only to keep the tap hit-test honest — see the rAF loop. */
const VEH_DATA_MIN_MS = 200;

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
  /** Staircases are not a route for every rider. The three profiles that say so in
   *  Settings get a step-free walk or none at all — never a flight of stairs drawn
   *  as if it were pavement. */
  const access = useStore((s) => s.access);
  const quality = useStore((s) => s.quality);
  /** User's own layers toggle. The quality setting is the ceiling — Reduced and
   *  Lite never get extrusions at all — and this is the switch inside it. */
  const [voxelWanted, setVoxelWanted] = useState(true);
  const voxelOn = voxelWanted && voxelCityAllowed(quality);

  const geo = useLive((s) => s.geo);
  const arrivals = useLive((s) => s.arrivals);
  /** The next REAL scheduled service at this same real stop, which `useLive` probes
   *  for whenever the live board is empty. Used only to pick which route line to
   *  draw — see `focusRoute`. */
  const nextService = useLive((s) => s.nextService);

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
  const walkMarker = useRef<maplibregl.Marker | null>(null);
  /** Latest theme/voxel intent, readable from map callbacks that were registered
   *  once at init and would otherwise close over the first render's values. */
  const themeRef = useRef<MapTheme>(theme);
  themeRef.current = theme;
  const voxelOnRef = useRef(voxelOn);
  voxelOnRef.current = voxelOn;
  const blockerSizes = useRef<Set<string>>(new Set());
  const lastBlockerKey = useRef('');
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
  /**
   * IS THE BOARDING STOP ACTUALLY WALKABLE FROM HERE — and the answer gates GEOMETRY.
   *
   * The beaded path this component draws is a CLAIM: "you can walk this". It was drawn
   * unconditionally, as a straight line from the rider to whatever stop was selected. So
   * searching a stop across town, or asking for a trip the planner could not complete,
   * left a dotted line running clear across the city — which reads as a suggested walking
   * route, and it is not one. In an app whose argument is that it does not show riders
   * things that are not true, that line was a lie drawn in the loudest place available.
   *
   * THE THRESHOLD IS THE APP'S OWN, not a new opinion. `PLAN_MAX_RADIUS_M` (500 m default,
   * 1500 m ceiling, server/src/api.ts) is the longest walk the planner will put in a plan
   * at all; past that our own API declines to connect a rider to a stop on foot. Drawing a
   * walk we would refuse to plan is self-contradictory, so 1500 m is where the geometry
   * stops. Beyond it there is NO line, no walker node and no walk time — an absence, which
   * claims nothing, rather than a shape that claims something false.
   *
   * This also covers the failed-plan case by construction rather than by special-casing:
   * `PlanView` moves the selection to the plan's boarding stop only when a ride resolves,
   * so a transfer / noService / unreachable outcome leaves the selection wherever it was,
   * and if that is across town no route-like geometry is drawn for it.
   */
  const WALKABLE_MAX_M = 1500;
  // A plan that failed takes the geometry with it, whatever the distance says: the leg
  // still drawn would belong to the PREVIOUS journey, under this one's failure message.
  // Set by PlanView; see the note on `planUnresolved` in store.ts.
  const planUnresolved = useStore((s) => s.planUnresolved);
  const walkDistM = useMemo(() => {
    if (!geo || !boarding) return null;
    const near = selectedNearbyStop();
    return near?.distanceM ?? haversineM(geo.lat, geo.lon, boarding.lat, boarding.lon);
  }, [geo, boarding]);
  const walkable = walkDistM != null && walkDistM <= WALKABLE_MAX_M && !planUnresolved;

  /**
   * THE GATE STAYS ON THE STRAIGHT LINE; ONLY THE DRAWING IS ROUTED.
   *
   * A routed walk is longer than the straight one, so a stop 1,400 m away as the crow
   * flies routes past 1,500 m and would fall off a gate measured on the route. That
   * would be the wrong question. `WALKABLE_MAX_M` mirrors the planner's own
   * `PLAN_MAX_RADIUS_M`, which the server applies as a straight-line radius — it asks
   * "does this app consider these two points connected on foot at all", and that
   * answer must not change because the pavement wanders. The route then tells the
   * truth about the walk inside the gate, however long it turns out to be.
   *
   * The walk the map has drawn, and the numbers that describe it. `null` whenever no
   * walk is drawn — which is every state the plan-geometry machine calls unresolved.
   */
  const [walkLeg, setWalkLegState] = useState<MeasuredWalk | null>(null);
  const publishWalkLeg = useStore((s) => s.setWalkLeg);
  const walkMin = walkLeg == null ? null : Math.max(1, Math.round(walkLeg.seconds / 60));

  /**
   * Which route line to draw in red — the reference's defining stroke, and the only
   * loud colour on the map.
   *
   * Order: the selected vehicle's route, else the top LIVE departure at the boarding
   * stop, else the next REAL SCHEDULED service at that same stop.
   *
   * That third fallback is what stops the city losing its red spine at 2 a.m., and
   * it invents nothing: `nextService` is a real GTFS query against the real current
   * stop, and the geometry is the real published shape for that route. It changes
   * WHICH real route is highlighted when the board is empty; it never claims a
   * vehicle, a departure or a time. The badge is a separate matter — that only ever
   * rides an actual live vehicle (see `badgeVehicle`), so an empty board still shows
   * no badge.
   */
  // The agency rides along with the route id: with several agencies seeded a bare
  // route_id is ambiguous on the wire, and every source here already carries its own.
  const focusRoute = useMemo<{ agency: string; routeId: string; dir: number | null } | null>(() => {
    if (selected?.routeId) return { agency: selected.agency, routeId: selected.routeId, dir: null };
    const d = arrivals?.departures?.[0];
    if (d?.routeId) return { agency: d.agency, routeId: d.routeId, dir: d.directionId };
    const s = nextService?.departures?.[0];
    if (s?.routeId) return { agency: s.agency, routeId: s.routeId, dir: s.directionId };
    return null;
  }, [selected, arrivals, nextService]);
  // Read from the rAF loop and from `badgeVehicle()`, both of which were registered
  // long before these memos last changed and would otherwise see stale values.
  const focusRouteRef = useRef(focusRoute);
  focusRouteRef.current = focusRoute;
  const boardingRef = useRef(boarding);
  boardingRef.current = boarding;
  const geoRef = useRef(geo);
  geoRef.current = geo;
  // Read from `applyWalk` and `frameCamera`, both of which can run from callers
  // registered long before this render (see the note on applyWalk).
  const walkableRef = useRef(walkable);
  walkableRef.current = walkable;
  const paceRef = useRef(pace);
  paceRef.current = pace;
  const avoidStepsRef = useRef(false);
  avoidStepsRef.current = access === 'wheelchair' || access === 'walker' || access === 'stroller';
  /** The line as drawn, so the walker glyph can sit ON it rather than on the midpoint
   *  of two ends it no longer runs between. */
  const walkPathRef = useRef<[number, number][] | null>(null);

  /**
   * Coalesce the tile-arrival rebuilds to at most one per `CITY_BUILD_MIN_MS`.
   * Tiles land in bursts, `build()` rewrites the whole instance buffer from every
   * feature the source holds, and the picture from the first tile of a burst is the
   * same picture as the picture from the last.
   *
   * TRAILING EDGE, and that is the whole point — the first version of this DROPPED
   * any request that arrived inside the window, on the reasoning that `idle` would
   * clean up later. Measured, that was the worst of both: the burst's first tile
   * built a city 18.7% of its final size, every other tile in the burst was
   * discarded, and the frame then sat at 18.7% for a further 1.5-2 s until `idle`
   * finally fired. Deferring instead of dropping means every tile is folded in, at
   * most one rebuild per window.
   */
  const cityBuildTimer = useRef<number | null>(null);
  const cityBuiltAt = useRef(0);
  const vehDataAt = useRef(0);
  function scheduleCityBuild(map: maplibregl.Map) {
    if (cityBuildTimer.current !== null) return;
    const wait = Math.max(0, CITY_BUILD_MIN_MS - (performance.now() - cityBuiltAt.current));
    cityBuildTimer.current = window.setTimeout(() => {
      cityBuildTimer.current = null;
      cityBuiltAt.current = performance.now();
      syncVoxelCity(map);
    }, wait);
  }

  // ============================ map init (once) ============================
  useEffect(() => {
    if (!wrapRef.current) return;
    const start: LngLat = geo ? [geo.lon, geo.lat] : [DEFAULT_LOCATION.lon, DEFAULT_LOCATION.lat];
    const map = new maplibregl.Map({
      container: wrapRef.current,
      style: buildStyle(theme),
      center: start,
      // Open AT the diorama, not at a flat overview that then jumps: the reference
      // is a close, near-isometric view and anything wider is a different picture.
      zoom: VOXEL_DIORAMA_ZOOM,
      minZoom: 9,
      maxZoom: 18,
      attributionControl: false, // added explicitly below so it is always visible + themed
      dragRotate: false,
      pitchWithRotate: false,
      cooperativeGestures: false,
      keyboard: false, // canvas stays keyboard-inert (it is aria-hidden; the list is the a11y path)
    });
    mapRef.current = map;
    // Verification handle. Deliberately an element expando rather than a global:
    // the map has to be inspectable from a PRODUCTION build (dev has already lied
    // about this map once — DECISIONS §28 — so every proof runs against `vite
    // build`), and this adds nothing to `window`.
    (wrapRef.current as HTMLDivElement & { _gbMap?: maplibregl.Map })._gbMap = map;
    // Second verification handle, same expando and same reasoning: the tree/building
    // fix has to be provable with a NUMBER (how many canopies were rejected, and for
    // which reason) rather than by a reviewer squinting at a screenshot, and the
    // custom layers are not reachable through `getStyle()`.
    (wrapRef.current as HTMLDivElement & { _gbTreeStats?: typeof voxelTreeStats })._gbTreeStats = voxelTreeStats;
    // The GL canvas is aria-hidden; make it truly inert so keyboard focus can't land on it.
    map.getCanvas().setAttribute('tabindex', '-1');
    // `compact: false`, NOT compact-plus-force-expanded. The compact control renders
    // a 29px ⓘ button *beside* the expanded text, and the pair was 127px wide, wrapped
    // to three lines and covered a corner of the city. Non-compact is a single
    // always-visible line — still a licence requirement satisfied, and now small
    // enough to stay out of the way (see map.css). `collide()` treats its box as
    // chrome, so no marker is ever placed over it.
    //
    // A judge asked for MapLibre's responsive compact mode on phones (a 202px strip
    // is 52% of a 390px screen). TRIED AND REVERTED, with the measurement: omitting
    // the option entirely does make this build add `maplibregl-compact` under 640px,
    // but it adds `maplibregl-compact-show` with it, so the control renders EXPANDED
    // plus a toggle button — 244px at 390px wide, worse than what it replaced.
    // Collapsing it means reaching into the library's own class list on a private
    // convention, and the thing being traded away is a licence credit. Not worth it:
    // the strip stays visible and honest, and the footprint is managed with type size
    // in map.css instead.
    map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');
    map.touchZoomRotate.disableRotation();

    // Tile-failure detection: don't latch on a single transient tile blip. The fallback
    // shows only if the vector source never becomes usable within a grace window; it
    // clears whenever the source (re)loads. Never a checkerboard (ground color shows through).
    map.on('sourcedata', (e) => {
      if (e.sourceId === 'omt' && e.isSourceLoaded) { tilesOkRef.current = true; setMapFailure(null); }
    });
    // Name the failure we actually observed. If the map never even finished loading,
    // the tile server is not the story — blaming it sent a whole phase chasing tiles
    // while the real fault was a worker that would not start. See DECISIONS §28.
    failTimerRef.current = window.setTimeout(() => {
      if (tilesOkRef.current) return;
      setMapFailure(styleOkRef.current ? 'tiles' : 'engine');
    }, 9000);
    map.on('movestart', (e: { originalEvent?: unknown }) => { if (e.originalEvent) userMoved.current = true; });
    map.on('moveend', () => {
      scheduleFetch();
      // The models carry a zoom-keyed legibility gain, so a zoom changes their drawn
      // size. On `moveend` rather than `move`: this walks the fleet, and the per-move
      // budget is already spent on `collide()`.
      if (voxelOnRef.current) pushVoxelVehicles(map);
    });
    // THE WALK IS ROUTED OVER TILES THAT HAVE LANDED, so it is retried when they do.
    //
    // The first attempt happens the moment a fix and a stop exist, which is routinely
    // before the vector tiles carrying the footways have arrived — and a route asked
    // for over an empty source is a route that does not exist, which would strand the
    // rider on the straight-line fallback for the whole session. `idle` is the exact
    // "nothing is moving and every tile has landed" signal, and it is the ONLY event
    // this may hang off: see the contract on `resolveWalkLeg`. A successful route is
    // cached per endpoint pair, so every later idle is a free lookup.
    map.on('idle', () => applyWalk(map));
    // Trees are re-planted from whatever roads are on screen, so they can only be
    // recomputed when the camera SETTLES. `idle` is the exact "nothing is moving
    // and every tile has landed" signal; doing this per frame would be absurd.
    map.on('idle', () => {
      if (!voxelOnRef.current) return;
      // CITY FIRST, THEN TREES — the order is load-bearing now that a tree refuses
      // to be planted inside a building (`syncVoxelTrees` asks the city where its
      // blocks are). Planting first would test each tree against the PREVIOUS
      // frame's buildings, so every newly-arrived tile would get one round of trees
      // growing through its towers before the next idle corrected them.
      syncVoxelCity(map);
      syncVoxelTrees(map);
    });

    // THE CITY IS BUILT AS TILES LAND, NOT ONLY WHEN EVERYTHING HAS SETTLED.
    //
    // `idle` means "nothing is moving AND every tile has arrived". It was the only
    // rebuild trigger, and measured on the shipped build it first fires 1.8-2.5 s
    // after the map is usable — so on any link slower than this machine's, the
    // rider watched an empty ground plane while the buildings they had already been
    // sent sat parsed in the source, waiting for the last tile in the viewport.
    //
    // Each arriving tile now folds itself in instead. Coalesced to one rebuild per
    // frame with a floor between builds: a batch of tiles lands together, and
    // `build()` rewrites the whole instance buffer, so running it per tile would be
    // the same picture drawn twenty times.
    map.on('sourcedata', (e) => {
      if (e.sourceId !== 'omt' || !voxelOnRef.current) return;
      if (!e.tile && !e.isSourceLoaded) return;
      scheduleCityBuild(map);
    });

    // Add the city the moment the STYLE IS APPLIED, rather than at `load`.
    //
    // MapLibre's `load` is "the first complete render has happened", and that waits
    // on the label GLYPHS — a second network chain to the font server that the
    // buildings do not depend on at all. Measured, it cost the city most of a second
    // of pure waiting for fonts. Everything `installLayers` does needs only the
    // style's sources and layers to exist.
    //
    // THE READINESS TEST IS THE SOURCE, NOT `isStyleLoaded()`, and the difference is
    // not pedantry — the first version of this shipped `isStyleLoaded()` and left the
    // map with NO GhostBus layers at all. `Style.loaded()` is false until every
    // source cache has its tiles AND the image manager is done, but `styledata` stops
    // firing once the style spec itself is stable. So the last `styledata` routinely
    // arrives while `isStyleLoaded()` is still false, the one-shot never fires again,
    // and nothing is ever installed. `getSource('omt')` returning an object means
    // `Style._loaded` is true, which is the real precondition for `addLayer`.
    //
    // `load` stays wired as a backstop, and `installLayers` is idempotent, so the
    // worst case is the behaviour this replaced rather than a broken map.
    const installOnce = () => {
      if (styleOkRef.current) return;
      if (!map.getSource('omt')) return;
      styleOkRef.current = true;
      map.off('styledata', installOnce);
      installLayers(map, theme);
      fetchVehicles();
    };
    map.on('styledata', installOnce);
    map.on('load', installOnce);

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
      if (cityBuildTimer.current !== null) clearTimeout(cityBuildTimer.current);
      if (pollRef.current) clearInterval(pollRef.current);
      if (moveTimerRef.current) clearTimeout(moveTimerRef.current);
      if (failTimerRef.current) clearTimeout(failTimerRef.current);
      youMarker.current?.remove(); stopMarker.current?.remove();
      badgeMarker.current?.remove(); walkMarker.current?.remove();
      youMarker.current = stopMarker.current = badgeMarker.current = walkMarker.current = null;
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
    if (!map.getSource('marker-blockers')) map.addSource('marker-blockers', { type: 'geojson', data: emptyFC() });

    const purple = '#8b5cf6';
    // Route reds MEASURED off ghostbus-design-reference.png: the dark map's stroke
    // modes at #ce4355/#c9353b, the light map's at #ca403c/#d23635. The old #FF4D4D
    // was a full step brighter and read orange next to the reference's carmine.
    const red = thm === 'dark' ? '#D8434F' : '#CF3B3D';
    // §C: the route carries a subtle darker casing in the reference, which is what
    // keeps it legible where it crosses a lit roof or a pale daylight block.
    const redCasing = thm === 'dark' ? '#7E2130' : '#93262A';

    // The beads' own drop shadow, so the walk path sits ON the ground plane rather
    // than floating flat over it (the reference's beads are 3D purple pucks).
    // THE TWO WALK LAYERS ARE TWO DIFFERENT CLAIMS, and the filter is what keeps them
    // apart. `kind: 'routed'` is a line along real ways and gets the reference's beads.
    // `kind: 'direct'` is the straight line drawn when no walkable route could be
    // found: a thin, pale dash that no one would read as a suggested route, and it is
    // labelled as an estimate wherever its minutes appear. A straight line dressed as
    // a route is the defect this whole wave exists to remove; it must never come back
    // wearing the beads.
    const IS_ROUTED: maplibregl.FilterSpecification = ['!=', ['get', 'kind'], 'direct'];
    const IS_DIRECT: maplibregl.FilterSpecification = ['==', ['get', 'kind'], 'direct'];
    if (!map.getLayer('walk-shadow')) {
      map.addLayer({
        id: 'walk-shadow', type: 'line', source: 'walk-path', filter: IS_ROUTED,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': 'rgba(0,0,0,0.5)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 7, 16.6, 12, 18, 15],
          'line-dasharray': [0, 1.55],
          'line-translate': [1.5, 2.5],
          'line-blur': 1.5,
          'line-opacity': 0.75,
        },
      });
    }
    if (!map.getLayer('walk-line')) {
      map.addLayer({
        id: 'walk-line', type: 'line', source: 'walk-path', filter: IS_ROUTED,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          // Round caps + a zero-length dash = a row of separated round BEADS, which
          // is what the reference draws — not a dashed line. The dash gap shrinks
          // with the width so the beads keep the same spacing-to-size ratio.
          'line-color': purple,
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 7, 16.6, 12, 18, 15],
          'line-dasharray': [0, 1.55],
          'line-opacity': 0.98,
        },
      });
    }
    // The straight-line fallback. Deliberately WEAK: a hairline, a long open dash, no
    // shadow, no beads, no walker glyph riding it. It has to be visible enough to say
    // "the stop is that way" and quiet enough that nobody follows it into a wall.
    if (!map.getLayer('walk-direct')) {
      map.addLayer({
        id: 'walk-direct', type: 'line', source: 'walk-path', filter: IS_DIRECT,
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': purple,
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 1.6, 16.6, 2.2, 18, 2.6],
          'line-dasharray': [2.5, 3],
          'line-opacity': thm === 'dark' ? 0.62 : 0.55,
        },
      });
    }
    // ROUTE RIBBON — three strokes, drawn widest-first: a soft ground shadow, a
    // dark casing, then the bright top face. MEASURED off the reference, where the
    // route's median width is 1.13% of the map frame with a visibly lighter top and
    // a darker side. The shipped build drew a uniform 0.42%-of-frame hairline with
    // no casing showing at all, which is why it read as a 2D stroke laid over the
    // city instead of an extruded ribbon lying in it.
    if (!map.getLayer('route-shadow')) {
      map.addLayer({
        id: 'route-shadow', type: 'line', source: 'route-shape',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': thm === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(60,20,24,0.28)',
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 11, 8, 14, 15, 17, 26],
          'line-translate': [1, 3],
          'line-blur': 4,
        },
      });
    }
    if (!map.getLayer('route-casing')) {
      map.addLayer({
        id: 'route-casing', type: 'line', source: 'route-shape',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': redCasing, 'line-opacity': 1,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 11, 6, 14, 11.5, 17, 20],
        },
      });
    }
    if (!map.getLayer('route-line')) {
      map.addLayer({
        id: 'route-line', type: 'line', source: 'route-shape',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': red, 'line-opacity': 1,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 11, 3.6, 14, 7.5, 17, 13.5],
        },
      });
    }
    if (!map.getLayer('route-stops')) {
      map.addLayer({
        id: 'route-stops', type: 'circle', source: 'route-stops', minzoom: 13,
        paint: {
          // A pale FILLED tick sitting in the ribbon, not a hollow ring. With a dark
          // fill these read as holes punched through the map — and at a frame edge a
          // half-clipped ring reads as a broken crescent. The reference integrates
          // its stops into the stroke as small light marks.
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 1.8, 16, 3.4],
          'circle-color': thm === 'dark' ? '#FBE2E4' : '#FFF3F3',
          'circle-stroke-color': redCasing,
          'circle-stroke-width': 1.1,
          'circle-opacity': 0.95,
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
    // MARKER BLOCKERS — how the DOM cards keep basemap street labels off themselves.
    //
    // MapLibre's collision index only knows about symbols. The You card, the stop
    // bubble and the route badge are HTML markers, so "King St West" would happily
    // draw straight underneath them and no amount of DOM collision code could stop
    // it. This layer publishes one invisible symbol per visible marker, sized to
    // that marker's measured box, so the basemap's own placement pass moves the
    // street name out of the way instead.
    //
    // It must be the LAST symbol layer: `PauseablePlacement.continuePlacement`
    // walks the style order from the END downward, so the last symbol layer is
    // placed FIRST and therefore wins every collision it takes part in.
    if (!map.getLayer('marker-blockers')) {
      map.addLayer({
        id: 'marker-blockers', type: 'symbol', source: 'marker-blockers',
        layout: {
          'icon-image': ['get', 'img'],
          'icon-allow-overlap': false,
          'icon-ignore-placement': false,
          // RAISED 6 -> 14. The gap between a street name and a marker card was the
          // SUM of this and the label layer's own `text-padding`, and that padding
          // came down from 44 to 14 so the map could actually name its streets
          // (mapStyle.ts). Taking this up keeps the clearance where it was: §D2 says
          // no map element may sit under the app's own chrome, and a name tucked
          // right against the edge of the You card reads as touching it.
          'icon-padding': 14,
          'icon-pitch-alignment': 'viewport',
          'icon-rotation-alignment': 'viewport',
        },
        paint: { 'icon-opacity': 0 },
      });
    }

    syncVoxel(map, thm);

    // re-apply live data after a style swap
    applyRoute(map);
    applyWalk(map);
    vehSource(map)?.setData(vehFCRef.current);
    restoreFeatureStates(map);
    // The rAF loop stops itself when a setStyle swap drops the source out from under it.
    // The source is back now, so in-flight tweens resume instead of freezing until the
    // next poll (up to 5s) and then snapping to their destination.
    if (animsRef.current.size > 0) startRaf();
  }

  // ============================ camera framing ============================
  /**
   * Frame the diorama so the WHOLE marker set is in view: the stop bubble, the
   * purple pin, the beaded walk path, the walker node and the You beacon.
   *
   * This replaced a fixed zoom, twice, because a fixed zoom cannot pass the actual
   * acceptance test. 17.0 read as a canyon; 16.6 still cropped the stop card off a
   * 390px card. And no single number can be right, because the framing depends on
   * two things that vary at runtime: how far the user is from their stop (a 2-minute
   * walk and a 12-minute walk are not the same picture) and how big the map card is
   * (a full-bleed desktop pane vs a 4:3 card on a phone).
   *
   * So: centre on the midpoint of the walk, then MEASURE. Zoom out in steps until
   * every marker's real DOM box fits inside the card, clear of the control stack and
   * the attribution. The loop is `jumpTo`, which updates marker positions
   * synchronously but defers rendering to the next frame — so the intermediate steps
   * never paint, and the user sees one camera move to the answer.
   */
  // RAISED 16.1 -> 16.35, measured off the reference rather than guessed. Its
  // walk path (labelled "4 min walk", so ~250 m) spans about 210 px of a ~1030 px
  // map pane, which puts the reference camera at ~0.95 m/px — z16.4 at Toronto's
  // latitude — and at that scale its cubes are ~110 px, i.e. one city block each.
  // At 16.1 our blocks came out a third smaller than the reference's and the frame
  // read as busier than it should. This is the ceiling: `frameCamera` only ever
  // zooms OUT from here, so a longer walk or a phone-sized card still fits, and
  // z17 was tried and rejected — one whole-block footprint fills the pane and the
  // grid disappears.
  const FRAME_START_ZOOM = 16.35;
  /**
   * THE COMPOSITION RULE, measured off the reference on BOTH of its breakpoints.
   *
   * A start zoom alone cannot reproduce the reference, because it is a constant and
   * the thing the reference actually holds constant is a PROPORTION. Marker centroids
   * pulled straight out of `ghostbus-design-reference.png`:
   *
   *   desktop   You (728.1, 499.3)  stop pin (672.9, 308.7)  ->  198.4 px apart
   *             map pane x 325..1069 = 744 px               ->  span / pane = 0.267
   *   mobile    You (328.7, 970.9)  stop pin (297.4, 903.7)  ->   74.1 px apart
   *             phone screen x 194..482 = 288 px            ->  span / card = 0.257
   *
   * Two very different card sizes, one ratio: the walk occupies about a quarter of
   * the card's width, and the city fills the other three quarters. Measured on our
   * own production build at FRAME_START_ZOOM the same span was 333 px of 960 (0.347)
   * on desktop and 206 px of 390 (0.528) on a phone — i.e. 1.3x too close on desktop
   * and 2.1x too close on a phone, which is why the phone card read as three tree
   * cubes and a road rather than as a city.
   *
   * So the start zoom is now SOLVED for rather than assumed: project the two real
   * points, measure the span the camera actually produces (which is pitch-aware for
   * free, unlike any ground-resolution formula), and correct the zoom by its log2
   * ratio to the target. `FRAME_START_ZOOM` stays the ceiling and `FRAME_MIN_ZOOM`
   * the floor, so a very short walk cannot zoom into a canyon and a very long one
   * cannot dissolve the diorama; the existing fit loop below still only zooms out.
   */
  const WALK_SPAN_FRAC = 0.26;
  /**
   * RAISED 14.7 -> 15.4, and this is a floor on the DIORAMA, not on the markers.
   *
   * `VOXEL_MIN_ZOOM` is 14.6 and the city's opacity ramp only reaches 1 at 15.3, so
   * any framing below that renders a half-transparent city. Measured on the 5:3
   * mobile card: fitting the whole marker set into 390x234 pushed the camera to
   * z14.95, where the extrusions paint at ~50% and the map card came back looking
   * like an empty grey box with a red line on it. The buildings were there — 156 of
   * them queried as rendered — they were simply almost invisible.
   *
   * Below this floor the honest trade is to drop a MARKER, not the city: `collide()`
   * already degrades the stop bubble to its pin and hides the lowest-priority
   * labels, and a diorama with three markers beats four markers over nothing.
   */
  const FRAME_MIN_ZOOM = 15.4;

  function markerBoxes(): DOMRect[] {
    const out: DOMRect[] = [];
    for (const m of [youMarker.current, stopMarker.current, walkMarker.current]) {
      const el = m?.getElement();
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) out.push(r);
    }
    return out;
  }

  /** True when every marker box sits inside the card, clear of the chrome. */
  function markersFramed(): boolean {
    const card = wrapRef.current?.parentElement as HTMLElement | undefined;
    if (!card) return true;
    const b = card.getBoundingClientRect();
    const chrome: DOMRect[] = [];
    for (const sel of ['.map-controls', '.maplibregl-ctrl-bottom-right']) {
      const r = (card.querySelector(sel) as HTMLElement | null)?.getBoundingClientRect();
      if (r && r.width > 1) chrome.push(r);
    }
    for (const r of markerBoxes()) {
      if (!inside(r, b, 6)) return false;
      if (chrome.some((c) => hit(r, c, 4))) return false;
    }
    return true;
  }

  function frameCamera(animate: boolean) {
    const map = mapRef.current;
    if (!map) return;
    const g = geoRef.current;
    const b = boardingRef.current;
    // With no walk drawn there is no walk to compose around, and fitting the rider and a
    // stop kilometres away would dissolve the diorama to escape a line that is not there.
    // Fall back to the standard city camera on the stop itself.
    if (!g || !b || !walkableRef.current) { applyVoxelCamera(map, { animate }); return; }

    const centre: LngLat = [(g.lon + b.lon) / 2, (g.lat + b.lat) / 2];
    const from = { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
    const pitch = voxelOnRef.current ? VOXEL_PITCH : 0;
    const bearing = voxelOnRef.current ? VOXEL_BEARING : 0;
    if (map.getMaxPitch() < pitch) map.setMaxPitch(VOXEL_MAX_PITCH);
    // The narrow diorama FOV has to be applied BEFORE the fitting loop below, not
    // after: it changes `cameraToCenterDistance`, so it changes where every marker
    // projects to, and a loop that measured at 36.87 deg and then rendered at 16
    // would be fitting the wrong picture. `applyVoxelCamera` sets it too, but this is
    // the path the default view actually takes.
    setVoxelFov(map, voxelOnRef.current ? VOXEL_FOV_DEG : DEFAULT_FOV_DEG);

    // Bias the composition AWAY from the control stack instead of only zooming out
    // to escape it. `offset` moves the target centre relative to the container
    // centre, so a negative x slides the whole marker chain left into the clear
    // half of the card. Without it, a phone card whose right side is occupied by
    // the (now vertically centred) pills had no way to fit the You beacon except by
    // zooming past the diorama floor — and when that floor was raised, `collide()`
    // simply hid the beacon instead, which loses the reference's whole composition.
    //
    // `jumpTo` has no `offset` option (only easeTo/flyTo/fitBounds do), and using
    // easeTo's would put the animation somewhere the measurement loop never checked.
    // So the shift is folded into the centre itself: project the midpoint, push it
    // right by half the chrome, unproject. Measurement and animation then agree by
    // construction.
    const chromeW = (wrapRef.current?.parentElement?.querySelector('.map-controls') as HTMLElement | null)
      ?.getBoundingClientRect().width ?? 0;
    const shiftPx = chromeW > 0 ? chromeW / 2 + 14 : 0;

    let centred: LngLat = centre;
    const place = (z: number) => {
      map.jumpTo({ center: centre, zoom: z, pitch, bearing });
      if (shiftPx > 0) {
        const p = map.project(centre);
        const q = map.unproject([p.x + shiftPx, p.y]);
        centred = [q.lng, q.lat];
        map.jumpTo({ center: centred, zoom: z, pitch, bearing });
      } else {
        centred = centre;
      }
    };

    let zoom = FRAME_START_ZOOM;
    place(zoom);

    // 1. Solve for the reference's proportion: the walk spans ~a quarter of the
    //    card. Two passes are enough — the projection is near-linear in scale, so
    //    the first correction lands within a few percent and the second cleans up.
    const cardW = wrapRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
    const targetPx = cardW * WALK_SPAN_FRAC;
    if (targetPx > 1) {
      for (let i = 0; i < 2; i++) {
        const pa = map.project([g.lon, g.lat]);
        const pb = map.project([b.lon, b.lat]);
        const span = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        if (!(span > 1)) break;
        const next = Math.min(FRAME_START_ZOOM, Math.max(FRAME_MIN_ZOOM, zoom - Math.log2(span / targetPx)));
        if (Math.abs(next - zoom) < 0.02) break;
        zoom = next;
        place(zoom);
      }
    }

    // 2. Then the existing guarantee: nothing may sit outside the card or under the
    //    chrome. This only ever zooms further OUT, so it can never undo step 1.
    for (let i = 0; i < 8 && zoom > FRAME_MIN_ZOOM; i++) {
      if (markersFramed()) break;
      zoom = Math.max(FRAME_MIN_ZOOM, zoom - 0.35);
      place(zoom);
    }

    if (animate && !prefersReducedMotion()) {
      // Put the camera back and ease to the answer, so the entry is one smooth move
      // rather than a snap. `prefers-reduced-motion` cuts straight to final state.
      const target = { center: centred, zoom, pitch, bearing };
      map.jumpTo(from);
      map.easeTo({ ...target, duration: 700 });
    }
    collide();
  }

  // ============================ voxel city + trees ============================
  /**
   * Bring the diorama into line with the current theme and the current
   * quality/layers intent. Idempotent, and the ONLY place that decides whether
   * extrusions exist — every caller (style load, theme swap, quality change,
   * layers button) funnels through here.
   *
   * Extrusions are Full quality ONLY. `voxelCityAllowed` resolves `auto` against
   * the device, and Reduced/Lite deliberately get the flat, north-up map: a steep
   * pitch puts several times more buildings in frame, and on a machine that cannot
   * hold the frame rate the honest answer is fewer polygons, not a janky diorama.
   */
  function syncVoxel(map: maplibregl.Map, thm: MapTheme) {
    if (!map.getSource('omt')) return;
    if (voxelOnRef.current) {
      // TREES FIRST, then the city. `addVoxelCityLayers` finishes by lifting the
      // basemap's street labels to just under the overlays; adding the trees after
      // that would put tree extrusions on top of "King Street West" and let a bush
      // occlude a street name (§C forbids buildings occluding labels, and a tree is
      // the same depth-buffer problem). This ordering puts every extrusion below
      // every label.
      addVoxelTreeLayers(map, thm, voxelInsertionPoint(map));
      setVoxelTreeTheme(map, thm);
      const added = addVoxelCityLayers(map, thm);
      if (!added) { removeVoxelTreeLayers(map); return; }
      setVoxelCityTheme(map, thm);
      // THE VEHICLES BECOME 3D EXACTLY WHEN THE CITY DOES. One gate, one quality
      // ceiling, one layers button — a voxel bus in a flat map would be the only
      // object in frame with walls, and a sprite in the diorama is the RED this
      // replaces. Inserted before `marker-blockers` so the models draw over the
      // route and the city while the invisible collision boxes that keep street
      // names off the app's marker cards stay the last symbol layer.
      if (addVoxelVehicleLayers(map, thm, map.getLayer('marker-blockers') ? 'marker-blockers' : undefined)) {
        setVoxelVehicleTheme(map, thm);
        // The sprite layer stays in the style, invisible: it is still the hit-test
        // target for taps (MapLibre places its collision boxes regardless of paint
        // opacity) and it is what renders again the moment 3D is switched off.
        setSpriteVisible(map, false);
        pushVoxelVehicles(map);
      }
      // Re-frame rather than just tipping the camera: turning 3D on changes how much
      // ground is visible, so the marker set has to be re-fitted at the new pitch.
      if (centeredOnGeo.current && !userMoved.current) frameCamera(false);
      else applyVoxelCamera(map, { animate: false });
      syncVoxelTrees(map);
      syncVoxelCity(map);
    } else {
      removeVoxelTreeLayers(map);
      removeVoxelCityLayers(map);
      removeVoxelVehicleLayers(map);
      setSpriteVisible(map, true);
      resetVoxelCamera(map, false);
      if (centeredOnGeo.current && !userMoved.current) frameCamera(false);
    }
    collide();
  }

  /** Show or hide the flat sprite layer without removing it — it stays in the style
   *  as the tap target and as the flat map's renderer. */
  function setSpriteVisible(map: maplibregl.Map, on: boolean) {
    if (!map.getLayer('vehicles')) return;
    try {
      map.setPaintProperty(
        'vehicles', 'icon-opacity',
        on ? ['coalesce', ['feature-state', 'op'], 1] : 0,
      );
    } catch { /* style swap in flight */ }
  }

  /**
   * Hand the 3D layer the current tweened fleet.
   *
   * This is the cheap per-frame path, and replacing the expensive one is the point:
   * the rAF loop used to re-upload the ENTIRE vehicle FeatureCollection to the
   * GeoJSON source on every frame, which re-parses and re-tiles it. The 3D layer
   * takes plain numbers and writes instance matrices, so a frame costs one buffer
   * upload regardless of fleet size.
   */
  function pushVoxelVehicles(map: maplibregl.Map) {
    const now = performance.now();
    const out: VoxelVehicle[] = [];
    for (const a of animsRef.current.values()) {
      const [lon, lat] = posOf(a, now);
      const op = a.fadeStart > 0 ? Math.max(0, Math.min(1, (now - a.fadeStart) / FADE_MS)) : 1;
      out.push({
        lon, lat,
        heading: a.heading,
        color: a.color,
        kind: a.kind,
        selected: (a.feat.properties as { sel?: number }).sel === 1,
        opacity: op,
      });
    }
    setVoxelVehicles(map, out);
  }

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleOkRef.current) return;
    syncVoxel(map, theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voxelOn]);

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
    /**
     * THE SHARED BACKOFF APPLIES HERE TOO, and this is the poll it matters most for.
     *
     * /api/vehicles runs every 5s — 12 req/min, more than the other four tasks combined
     * and the single largest line in the rate-limit budget. It used to sit outside the
     * backoff and swallow its own errors, so during a 429 it kept hammering at full rate
     * while every other task politely stood down: the app would have throttled itself
     * awake again and again. Standing down here is most of what makes the backoff real.
     */
    if (isBackedOff()) return;
    try {
      const res = await api.vehicles(currentBbox());
      if (!mapRef.current) return;
      ingest(res.vehicles);
      setVehCount(res.count);
    } catch (e) {
      // Reported, so a server-wide failure reaches the one place that decides the copy —
      // and so the map cannot silently disagree with the banner beside it.
      noteFailure(e);
    }
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
    // A poll that adds or removes vehicles without starting a tween (nothing moved
    // far enough to animate) still has to reach the 3D layer, or a newly-appeared
    // vehicle waits for the next thing that happens to move.
    if (voxelOnRef.current) pushVoxelVehicles(map);
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
      // THE PER-FRAME UPLOAD IS NOW CONDITIONAL, and this is the hot loop of the map.
      //
      // `setData` re-parses and re-tiles the whole FeatureCollection. With the flat
      // sprites that cost buys the only picture there is, so it stays exactly as it
      // was. With the 3D models on, the sprite layer is INVISIBLE and its geometry is
      // needed for one thing only — the tap hit-test — so it is flushed on a timer
      // instead of every frame. At a bus's ~10 m/s and a 200 ms flush that is 2 m of
      // staleness against a tap radius of 14 px (~9 m here), i.e. inside the pad that
      // already exists. The final frame always flushes, so the resting position is
      // never stale.
      if (voxelOnRef.current) {
        pushVoxelVehicles(map);
        if (!active || now - vehDataAt.current > VEH_DATA_MIN_MS) {
          vehDataAt.current = now;
          src.setData(vehFCRef.current);
        }
      } else {
        src.setData(vehFCRef.current);
      }
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
    // NOT a removal: with nothing selected the badge falls back to the focused
    // route's nearest vehicle, which is the state the reference actually shows.
    updateBadge();
  }

  // ============================ DOM markers ============================
  /**
   * Which vehicle wears the route badge. The reference shows a `504A` badge sitting
   * directly above the streetcar with nothing selected, so an explicit selection is
   * the override, not the precondition: otherwise it goes to the vehicle on the
   * focused route that is closest to the boarding stop — the one the rider is
   * actually waiting for.
   *
   * This never invents a vehicle. No live vehicle on that route in view means no
   * badge, exactly as it means no vehicle sprite.
   */
  /** Inset from the map's own edges that a vehicle must clear before it may wear
   *  the badge. The badge is drawn ~34px above its vehicle and is ~44px wide, so
   *  this is the margin that keeps the PAIR fully in frame. */
  const BADGE_SAFE_PX = 62;

  /** True when this ground position projects inside the map container, inset. A
   *  vehicle in the far-left gutter must not be given the badge: the reference's
   *  strongest map anchor is a badge sitting ON a fully visible streetcar, and a
   *  badge floating in empty sky beside a half-clipped vehicle is worse than none. */
  function badgeInFrame(lon: number, lat: number): boolean {
    const map = mapRef.current;
    if (!map) return false;
    const { x, y } = map.project([lon, lat]);
    const c = map.getCanvas();
    const w = c.clientWidth, h = c.clientHeight;
    if (w < 2 * BADGE_SAFE_PX || h < 2 * BADGE_SAFE_PX) return false;
    return x >= BADGE_SAFE_PX && x <= w - BADGE_SAFE_PX && y >= BADGE_SAFE_PX && y <= h - BADGE_SAFE_PX;
  }

  function badgeVehicle(): { id: string; label: string; color: string; lon: number; lat: number } | null {
    // `shortName ?? routeId` with NO string fallback. A vehicle whose feed record
    // carries neither is unlabellable, and two production probes caught the old
    // `?? '—'` shipping a literal em-dash badge — a badge that names no route at
    // all, which is exactly the kind of placeholder-as-fact this app exists not to
    // print. No badge is the honest answer.
    const label = (v: { shortName?: string | null; routeId?: string | null }) => v.shortName ?? v.routeId ?? null;

    const sel = selectedRef.current;
    if (sel) {
      const l = label(sel);
      // An explicit selection overrides the framing test — the user asked for this
      // one, and `selectVehicle` has already eased the camera onto it.
      return l ? { id: sel.id, label: l, color: sel.color, lon: sel.lon, lat: sel.lat } : null;
    }
    const routeId = focusRouteRef.current?.routeId;
    const stop = boardingRef.current;
    if (!stop) return null;
    // Two passes: prefer a vehicle on the focused route, then fall back to the
    // nearest live vehicle of ANY route.
    //
    // The fallback is safe because a badge makes exactly one claim — "this vehicle
    // is route X" — and that comes straight off the vehicle's own feed record. It
    // does not say the vehicle serves your stop, and it is never shown when there is
    // no live vehicle in frame to attach it to.
    for (const wantRoute of [true, false]) {
      if (wantRoute && !routeId) continue;
      let best: { id: string; label: string; color: string; lon: number; lat: number } | null = null;
      let bestD = Infinity;
      for (const a of animsRef.current.values()) {
        const p = a.feat.properties as { id: string; routeId?: string; shortName?: string; color: string };
        if (wantRoute && p.routeId !== routeId) continue;
        const l = label(p);
        if (!l) continue;
        const [lon, lat] = a.feat.geometry.coordinates as LngLat;
        // The comment above has always claimed the badge is "never shown when there
        // is no live vehicle in frame", but the selection was nearest-by-haversine
        // with no viewport test at all — so on four of six production captures the
        // badge sat at map-local x=169-287 while the marker cluster was at x=420-555.
        // This is that claim, enforced.
        if (!badgeInFrame(lon, lat)) continue;
        const d = haversineM(lat, lon, stop.lat, stop.lon);
        if (d < bestD) { bestD = d; best = { id: p.id, label: l, color: p.color, lon, lat }; }
      }
      if (best) return best;
    }
    return null;
  }

  function updateBadge() {
    const v = badgeVehicle();
    if (!v) { badgeMarker.current?.remove(); badgeMarker.current = null; return; }
    const map = mapRef.current!;
    const a = animsRef.current.get(v.id);
    const c: LngLat = a ? (a.feat.geometry.coordinates as LngLat) : [v.lon, v.lat];
    const label = v.label;
    const hex = /^[0-9a-fA-F]{6}$/.test(v.color) ? v.color : 'ED1C24';
    if (!badgeMarker.current) {
      const el = document.createElement('div');
      el.className = 'map-badge';
      el.style.setProperty('--badge', `#${hex}`);
      el.style.color = readableOn(hex); // AA on any agency color (black/white per luminance)
      el.textContent = label;
      // The sprite is S px tall (sprites.ts) centred on the vehicle's ground point,
      // so its roof is ~S*0.40 above that point. The badge's bottom sits 6px above
      // the roof — the reference reads badge and streetcar as ONE unit, and the old
      // fixed -22 left a visible empty tail once the sprite grew.
      badgeMarker.current = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -BADGE_LIFT_PX] }).setLngLat(c).addTo(map);
    } else {
      const el = badgeMarker.current.getElement();
      el.style.setProperty('--badge', `#${hex}`);
      el.style.color = readableOn(hex);
      el.textContent = label;
      badgeMarker.current.setLngLat(c);
    }
    collide();
  }

  // You beacon + boarding stop bubble + the walker node on the walk path
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // --- You: blue disc with a person glyph, plus a TWO-LINE attached card ------
    if (geo) {
      if (!youMarker.current) {
        const el = document.createElement('div');
        el.className = 'you-beacon';
        el.innerHTML =
          // The bloom lives INSIDE the disc so it stays centred on it in both the
          // normal and the flipped layout (map.css explains the z-index), and the
          // tip is the small blue-and-white dot the reference floats just above the
          // beacon, where the bead path terminates — without it the beads simply
          // stop in mid-air.
          '<span class="you-disc">' +
            '<span class="you-bloom" aria-hidden="true"></span>' +
            PERSON_SVG +
            '<span class="you-tip" aria-hidden="true"></span>' +
          '</span>' +
          '<span class="you-card"><b></b><i></i></span>';
        youMarker.current = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([geo.lon, geo.lat]).addTo(map);
      } else {
        youMarker.current.setLngLat([geo.lon, geo.lat]);
      }
      // The reference splits this over two lines: "You" then "4 min walk". Both
      // strings already exist (`map.you`, `stop.walk`) — no new i18n keys, and the
      // second line simply disappears when there is no walk to state.
      const card = youMarker.current.getElement().querySelector('.you-card') as HTMLElement;
      (card.querySelector('b') as HTMLElement).textContent = t('map.you');
      const sub = card.querySelector('i') as HTMLElement;
      // A measured walk states its minutes; an unrouted one wears the '~' the whole
      // app now uses for "this is an estimate, not a measurement" (`stop.walkEst`).
      // Two strings, one line, and the difference is legible without a legend.
      sub.textContent = walkMin == null ? ''
        : t(walkLeg?.kind === 'direct' ? 'stop.walkEst' : 'stop.walk', { min: walkMin });
      sub.style.display = walkMin != null ? '' : 'none';
      sub.dataset.estimate = walkLeg?.kind === 'direct' ? '1' : '0';
    } else if (youMarker.current) {
      youMarker.current.remove(); youMarker.current = null;
    }

    // --- boarding stop: outlined bubble with a purple transit tile, over a pin --
    if (boarding) {
      const code = t('stop.code', { code: boarding.id });
      const [line1, line2] = splitStopName(boarding.name ?? code, code);
      const html =
        '<span class="stop-card">' +
          `<span class="stop-card-tile" aria-hidden="true">${TRANSIT_SVG}</span>` +
          '<span class="stop-card-text">' +
            `<b>${escapeHtml(line1)}</b><i>${escapeHtml(line2)}</i>` +
          '</span>' +
        '</span>' +
        `<span class="stop-pin-dot" aria-hidden="true">${PIN_SVG}</span>`;
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

    // --- the walker node sitting partway along the beaded walk path ------------
    // Gated on the same `walkable` test as the path AND on the path being a real
    // route: a walker glyph floating with no path under it would be the same claim
    // with worse draughtsmanship, and one riding the straight-line fallback would
    // re-make the claim the fallback exists to withdraw.
    //
    // It sits at the ARC-LENGTH midpoint of the drawn line, not at the midpoint of
    // the two ends. On a route that turns a corner those are different places, and
    // the second one is out in the middle of a block.
    const walkMid = walkLeg?.kind === 'routed' && walkPathRef.current
      ? pathMidpoint(walkPathRef.current) : null;
    if (geo && boarding && walkable && walkMid) {
      const mid: LngLat = [walkMid[0], walkMid[1]];
      if (!walkMarker.current) {
        const el = document.createElement('div');
        el.className = 'walk-node';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = WALKER_SVG;
        walkMarker.current = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(mid).addTo(map);
      } else {
        walkMarker.current.setLngLat(mid);
      }
    } else if (walkMarker.current) {
      walkMarker.current.remove(); walkMarker.current = null;
    }

    // Frame the whole marker set once, on the first fix, and never again unless the
    // stop changes — panning away from a user's own deliberate camera would be rude.
    if (geo && boarding && !centeredOnGeo.current && !userMoved.current) {
      centeredOnGeo.current = true;
      frameCamera(true);
    }
    collide();
  }, [geo, boarding, walkMin, walkLeg, walkable, t]);

  // A new boarding stop is a new picture: re-frame it (unless the user has taken
  // the camera themselves).
  useEffect(() => {
    if (!centeredOnGeo.current || userMoved.current) return;
    frameCamera(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boarding?.id]);

  // ============================ walk path ============================
  /**
   * Reads geo/boarding from REFS, not from the enclosing render's closure.
   *
   * This was a real production bug, and a nasty one because it needed two callers to
   * show up. The `[geo, boarding]` effect fires as soon as the fix arrives, which is
   * usually BEFORE `map.on('load')` — so `getSource('walk-path')` is undefined and it
   * returns early. Then `installLayers` runs from the load handler, which still holds
   * the very first render's closure where `geo` was null, and writes an EMPTY
   * collection. Nothing changes after that, the effect never re-runs, and the beaded
   * walk path is silently absent forever. Refs make both callers agree.
   */
  function applyWalk(map: maplibregl.Map) {
    const src = map.getSource('walk-path') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    const g = geoRef.current;
    const b = boardingRef.current;
    // NOT WALKABLE -> NO GEOMETRY, AND NO NUMBERS EITHER. An absence claims nothing; a
    // city-spanning beaded line claims "walk this", which would be false. The published
    // leg is cleared in the same breath, so nothing downstream can go on quoting the
    // minutes of a walk that is no longer drawn. See the note on WALKABLE_MAX_M and
    // DECISIONS §45 §8.
    if (!g || !b || !walkableRef.current) {
      src.setData(emptyFC());
      setWalkLegState(null);
      publishWalkLeg(null);
      return;
    }
    // Straight through `resolveWalkLeg`: a hit is free, a miss is one synchronous
    // build. It is called from settled events only — see that function's contract.
    const leg = resolveWalkLeg(map, g, b, { avoidSteps: avoidStepsRef.current });
    src.setData({
      type: 'Feature',
      // The style reads this: a routed line is drawn as the reference's purple beads,
      // a straight-line fallback as a thin dash that could not be mistaken for one.
      properties: { kind: leg.kind },
      geometry: { type: 'LineString', coordinates: leg.coordinates },
    });
    walkPathRef.current = leg.coordinates;
    const measured: MeasuredWalk = {
      kind: leg.kind,
      distanceM: leg.distanceM,
      seconds: walkLegSeconds(leg.kind, leg.distanceM, paceMps(paceRef.current)),
      stopId: b.id,
    };
    setWalkLegState(measured);
    publishWalkLeg(measured);
  }
  useEffect(() => { const m = mapRef.current; if (m) applyWalk(m); }, [geo, boarding, walkable, pace, access]);
  // The map holds no walk once it is gone: a leg left in the store would be quoted by
  // a stop header long after the map that measured it was unmounted.
  useEffect(() => () => { useStore.getState().setWalkLeg(null); }, []);

  // ============================ route shape (red line + stop dots) ============================
  useEffect(() => {
    let alive = true;
    if (!focusRoute) { routeGeoRef.current = null; const m = mapRef.current; if (m?.getSource('route-shape')) applyRoute(m); return; }
    api.routeShape(focusRoute.routeId, focusRoute.dir, focusRoute.agency)
      // applyRoute only calls source.setData (safe whenever the source exists); do NOT
      // gate on isStyleLoaded(), which flips false transiently while tiles reload.
      .then((r) => { if (!alive) return; routeGeoRef.current = r; const m = mapRef.current; if (m) applyRoute(m); })
      .catch(() => { if (alive) { routeGeoRef.current = null; } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRoute?.routeId, focusRoute?.dir, focusRoute?.agency]);

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

  // ============================ ZERO OVERLAP ============================
  //
  // DESIGN-TARGET §D.1-3, and the user's own words: "there should be absolutely
  // nothing overlapping". Four rules, applied in this order on every camera move:
  //
  //   1. CHROME. Nothing may sit under the control stack or over the attribution
  //      (a licence requirement, so it always wins), or spill outside the rounded
  //      card. The You card gets one escape hatch — it flips to the other side of
  //      its disc — before anything is hidden.
  //   2. PRIORITY. You beacon > stop bubble > route badge > walker node. When two
  //      boxes intersect, the LOWER-priority one goes.
  //   3. DEGRADE BEFORE HIDING. The stop marker gives up its text bubble first and
  //      keeps its pin, so the stop is still located on the map even when there is
  //      no room to name it.
  //   4. RESTRAINT. At phone width the reference never shows more than three
  //      floating labels at once, so neither do we.
  //
  // Street labels are handled separately, by the `marker-blockers` symbol layer —
  // they belong to MapLibre's collision index, not to the DOM.
  const HIDE = (el: HTMLElement | null | undefined, on: boolean) => {
    if (el) el.dataset.hidden = on ? '1' : '0';
  };
  const isHidden = (el: HTMLElement | null | undefined) => !!el && el.dataset.hidden === '1';
  const hit = (a: DOMRect, b: DOMRect, pad = 2) =>
    a.left < b.right + pad && a.right + pad > b.left && a.top < b.bottom + pad && a.bottom + pad > b.top;
  const inside = (a: DOMRect, box: DOMRect, pad = 3) =>
    a.left >= box.left + pad && a.right <= box.right - pad && a.top >= box.top + pad && a.bottom <= box.bottom - pad;

  function collide() {
    const canvas = wrapRef.current;
    const card = canvas?.parentElement as HTMLElement | undefined;
    if (!canvas || !card) return;

    const youEl = youMarker.current?.getElement() ?? null;
    const youCard = (youEl?.querySelector('.you-card') as HTMLElement) ?? null;
    const stopEl = stopMarker.current?.getElement() ?? null;
    const stopCard = (stopEl?.querySelector('.stop-card') as HTMLElement) ?? null;
    const badgeEl = badgeMarker.current?.getElement() ?? null;
    const nodeEl = walkMarker.current?.getElement() ?? null;

    // --- reset to fully visible so every pass starts from the same state -------
    for (const e of [youEl, youCard, stopEl, stopCard, badgeEl, nodeEl]) HIDE(e, false);
    if (youEl) youEl.dataset.flip = '0';

    const bounds = card.getBoundingClientRect();
    const chrome: DOMRect[] = [];
    for (const sel of ['.map-controls', '.maplibregl-ctrl-bottom-right']) {
      const el = card.querySelector(sel) as HTMLElement | null;
      const r = el?.getBoundingClientRect();
      if (r && r.width > 1 && r.height > 1) chrome.push(r);
    }

    // --- 1. the You card's flip, decided before anything is hidden -------------
    if (youCard && youEl) {
      const bad = (r: DOMRect) => !inside(r, bounds) || chrome.some((c) => hit(r, c));
      if (bad(youCard.getBoundingClientRect())) {
        youEl.dataset.flip = '1';
        // If the flip is no better, put it back: a card hanging off the left edge
        // is not an improvement on one hanging off the right.
        if (bad(youCard.getBoundingClientRect())) youEl.dataset.flip = '0';
      }
    }

    // --- 2. chrome + card bounds ---------------------------------------------
    // Highest priority first, so a lower-priority element is never the reason a
    // higher-priority one moves.
    const units: { el: HTMLElement | null; degrade?: HTMLElement | null }[] = [
      { el: youEl, degrade: youCard },
      { el: stopEl, degrade: stopCard },
      { el: badgeEl },
      { el: nodeEl },
    ];
    for (const u of units) {
      if (!u.el) continue;
      const offend = () => {
        const r = u.el!.getBoundingClientRect();
        if (r.width < 1) return false;
        return !inside(r, bounds) || chrome.some((c) => hit(r, c));
      };
      if (!offend()) continue;
      if (u.degrade) {
        HIDE(u.degrade, true);           // drop the text, keep the point marker
        if (!offend()) continue;
        HIDE(u.degrade, false);          // the text was not the problem
      }
      HIDE(u.el, true);
    }

    // --- 3. pairwise, by priority --------------------------------------------
    const live = units.filter((u) => u.el && !isHidden(u.el));
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      if (isHidden(a.el)) continue;
      for (let j = i + 1; j < live.length; j++) {
        const b = live[j];
        if (isHidden(b.el)) continue;
        const ra = a.el!.getBoundingClientRect();
        const rb = b.el!.getBoundingClientRect();
        if (ra.width < 1 || rb.width < 1 || !hit(ra, rb)) continue;
        // Try to save the lower-priority one by dropping only its text.
        if (b.degrade && !isHidden(b.degrade)) {
          HIDE(b.degrade, true);
          if (!hit(ra, b.el!.getBoundingClientRect())) continue;
        }
        HIDE(b.el, true);
      }
    }

    // --- 4. phone restraint: at most three floating labels --------------------
    if (bounds.width > 0 && bounds.width < NARROW_CARD_PX) {
      const labels = [youCard, stopCard, badgeEl, nodeEl].filter((e) => e && !isHidden(e)) as HTMLElement[];
      for (let i = 3; i < labels.length; i++) HIDE(labels[i], true);
    }

    publishBlockers();
  }

  /**
   * Republish the invisible collision boxes that keep basemap street labels off the
   * DOM markers. One transparent icon per visible marker, sized to that marker's
   * measured box and anchored at the ground point under its centre.
   *
   * Sizes are bucketed to 8px and the icons cached, so panning does not churn
   * hundreds of one-off images through the sprite atlas.
   */
  function publishBlockers() {
    const map = mapRef.current;
    if (!map || !map.style || !map.getSource('marker-blockers')) return;
    const els = [
      youMarker.current?.getElement(),
      stopMarker.current?.getElement(),
      badgeMarker.current?.getElement(),
    ].filter(Boolean) as HTMLElement[];

    const feats: GeoJSON.Feature<GeoJSON.Point>[] = [];
    const canvasBox = map.getCanvas().getBoundingClientRect();

    /** Register (idempotently) an all-zero RGBA image of this size — a real
     *  collision box that paints nothing — and return its id. */
    const blockerImg = (w: number, h: number): string => {
      const img = `blk-${w}x${h}`;
      if (!blockerSizes.current.has(img)) {
        if (!map.hasImage(img)) {
          map.addImage(img, { width: w, height: h, data: new Uint8Array(w * h * 4) }, { pixelRatio: 1 });
        }
        blockerSizes.current.add(img);
      }
      return img;
    };

    // --- the SIDE GUTTERS -----------------------------------------------------
    // A line-placed street name has no viewport padding in MapLibre: the label is
    // laid along whatever part of the way is on screen, so a name was routinely
    // drawn with its first or last characters cut off by the map container's edge
    // (DESIGN-TARGET §D1/§D2 — measured on the left edge against the sidebar, and
    // on the right as "Richmond Street West" running off the frame). There is no
    // paint property for this, but the collision index is already the mechanism
    // that keeps labels off the marker cards — so each gutter gets published to it
    // as a stack of invisible boxes, and MapLibre moves the name along the street
    // instead of drawing it half off-canvas.
    const GUTTER_W = 56;
    const GUTTER_STEP = 168;
    if (canvasBox.width > NARROW_CARD_PX) {
      const gutterImg = blockerImg(GUTTER_W, 160);
      for (const cx of [GUTTER_W / 2, canvasBox.width - GUTTER_W / 2]) {
        for (let y = 80; y < canvasBox.height; y += GUTTER_STEP) {
          const p = map.unproject([cx, y]);
          feats.push({ type: 'Feature', properties: { img: gutterImg }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } });
        }
      }
    }

    for (const el of els) {
      if (isHidden(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const w = Math.min(320, Math.ceil(r.width / 8) * 8);
      const h = Math.min(160, Math.ceil(r.height / 8) * 8);
      const img = blockerImg(w, h);
      const p = map.unproject([
        r.left + r.width / 2 - canvasBox.left,
        r.top + r.height / 2 - canvasBox.top,
      ]);
      feats.push({
        type: 'Feature',
        properties: { img },
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      });
    }
    // Cheap change detection — this runs on every `move` event.
    const key = feats.map((f) => `${f.properties!.img}@${(f.geometry.coordinates as LngLat).map((n) => n.toFixed(5)).join(',')}`).join('|');
    if (key === lastBlockerKey.current) return;
    lastBlockerKey.current = key;
    (map.getSource('marker-blockers') as maplibregl.GeoJSONSource | undefined)
      ?.setData({ type: 'FeatureCollection', features: feats });
  }

  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    const on = () => collide();
    const onResize = () => {
      // The card's aspect ratio is owned by app.css and can change under us at a
      // breakpoint; a frame that fitted at one size need not fit at the next.
      if (centeredOnGeo.current && !userMoved.current) frameCamera(false);
      collide();
    };
    map.on('move', on);
    map.on('resize', onResize);
    return () => { map.off('move', on); map.off('resize', onResize); };
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
          {/* Two different failures, two different sentences. `map.tilesUnavailable`
              describes exactly one of them; using it for an engine failure would be a
              guess dressed as a diagnosis, and 'map.loading' was a placeholder that
              claimed something still in progress when nothing was. `map.engineUnavailable`
              now exists in all three locales, and it says the one thing that matters to a
              rider staring at a dead map: the departures below are still live. */}
          <span>{t(mapFailure === 'tiles' ? 'map.tilesUnavailable' : 'map.engineUnavailable')}</span>
        </div>
      )}

      {/* Two pills, exactly as the reference draws them: [+ / −] then
          [locate / layers]. The old expand/collapse button is gone — the reference
          has no fullscreen affordance, and its third slot is the layers control.
          `mapExpanded` still works if anything else sets it (the Escape handler and
          the resize effect below are untouched); nothing in the map sets it now. */}
      <div className="map-controls" role="group" aria-label={t('map.controls')}>
        <div className="map-pill">
          <button className="map-ctrl" aria-label={t('a11y.zoomIn')} onClick={() => mapRef.current?.zoomIn()}><PlusIcon width={18} height={18} /></button>
          <span className="map-ctrl-sep" aria-hidden />
          <button className="map-ctrl" aria-label={t('a11y.zoomOut')} onClick={() => mapRef.current?.zoomOut()}><MinusIcon width={18} height={18} /></button>
        </div>
        <div className="map-pill">
          <button className="map-ctrl" aria-label={t('a11y.locate')} onClick={flyToMe}><NavIcon width={18} height={18} /></button>
          <span className="map-ctrl-sep" aria-hidden />
          <button
            className="map-ctrl"
            aria-label={t('a11y.layers')}
            aria-pressed={voxelOn}
            // Disabled rather than hidden when quality forbids extrusions: the
            // control stack must keep the shape the reference gives it, and a
            // pressed-looking button that does nothing would be a lie.
            disabled={!voxelCityAllowed(quality)}
            onClick={() => setVoxelWanted((v) => !v)}
          >
            <LayersIcon width={18} height={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

function emptyFC(): GeoJSON.FeatureCollection { return { type: 'FeatureCollection', features: [] }; }
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/**
 * Split a stop name across the reference's two lines ("King St W" / "at Spadina
 * Ave"). This is a WRAP, not a rewrite: both halves are the agency's own string,
 * broken at its own separator, and nothing is added. Any name without a separator
 * stays whole on line one and the stop code takes line two — which is what the
 * sidebar already shows, so nothing is invented for a name that does not fit.
 */
export function splitStopName(name: string, fallbackLine2: string): [string, string] {
  const m = /^(.*\S)\s+(at|@|and|near|opposite)\s+(\S.*)$/i.exec(name);
  if (m) return [m[1], `${m[2].toLowerCase()} ${m[3]}`];
  return [name, fallbackLine2];
}

// Marker glyphs. Inline because markers are built with innerHTML, not JSX — and
// `components/icons.tsx` is owned by the layout agent, so nothing is added there.
const PERSON_SVG =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.4"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>';
const PIN_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10Z"/><circle cx="12" cy="11" r="2.2"/></svg>';
const WALKER_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="13" cy="4.2" r="1.9"/><path d="M11 21l1.6-5.2-2.2-2.4.8-4.2 3 1.6 2.4 1.4"/><path d="M10.2 9.2 7.4 11l-.9 3"/><path d="m12.6 15.8 2.6 2.1.9 3.1"/></svg>';
/** The transit glyph in the stop bubble's purple tile — a streetcar/tram box. */
const TRANSIT_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="13" rx="3.2"/><path d="M5 10.2h14"/><path d="M8.6 13.3h.01M15.4 13.3h.01"/><path d="M8.6 16.2 7 19.4M15.4 16.2 17 19.4"/></svg>';
