// Two hand-built MapLibre styles over OpenFreeMap's zero-key vector tiles
// (OpenMapTiles schema). Every layer is painted to GhostBus tokens — this is
// never a default basemap. Dark = the reference's indigo night; light = a
// Daylight equivalent with real navigational contrast (gray ground, roads that
// read as lighter ribbons). Palettes mirror tokens.css (kept in JS so the style
// builds instantly without waiting on CSS-var resolution). See DECISIONS §23.

import type { StyleSpecification } from 'maplibre-gl';

export type MapTheme = 'dark' | 'light';

/** OpenFreeMap — verified reachable at build time (style/tiles/fonts all 200).
 *  Zero API key. Attribution stays visible on the map (license requirement). */
const OFM_TILES = 'https://tiles.openfreemap.org/planet';
const OFM_GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> · ' +
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

interface Palette {
  ground: string;
  water: string;
  waterway: string;
  park: string;
  grass: string;
  building: string;
  roadMinor: string;
  roadMed: string;
  roadMajor: string;
  roadCasing: string;
  rail: string;
  boundary: string;
  label: string;
  labelHalo: string;
  waterLabel: string;
  /** Street names painted along the roads — brighter than a place label, because
   *  the reference makes them a primary read of the map. */
  roadLabel: string;
  roadLabelHalo: string;
}

// MEASURED off ghostbus-design-reference.png. Two passes were needed here, and the
// second one reversed the first:
//   pass 1 read "streets one step lighter than the ground" (§C) literally, dropped
//     the roads to #1A2340 on a #0C1229 ground, and the grid vanished — the render
//     came back as one continuous mass of rooftops with no sense of place.
//   pass 2 (this one) is what the reference actually does: its GROUND is the darkest
//     surface in the frame (#0b142b, and darker still in the shadows between blocks)
//     and its streets are a clearly readable lavender-slate lattice a good three
//     steps above it. The street grid is a primary read of the picture, not a
//     whisper — the "one step lighter" phrasing is about hue family, not contrast.
const DARK: Palette = {
  ground: '#090E22',
  water: '#0A1330',
  waterway: '#122046',
  park: '#14211C',
  grass: '#16231C',
  building: '#1B203F',
  roadMinor: '#232C4C',
  roadMed: '#2C3760',
  roadMajor: '#3A4570',
  roadCasing: '#0B1024',
  rail: '#1E2440',
  boundary: 'rgba(180,184,220,0.12)',
  label: '#AAB0C4',
  labelHalo: '#0A1024',
  waterLabel: '#6E7BAE',
  roadLabel: '#F2F0FA',
  roadLabelHalo: 'rgba(9,11,24,0.92)',
};

// The daylight reference is a warm near-white city, not a blue-grey one: its
// dominant surface is #f3f0ea (roofs AND roads at 30% of all pixels), its walls
// #d7d3cd/#c4c0bb, and the only saturated things in frame are the trees and the
// red route. Ground is set one step BELOW the roofs so blocks still separate from
// the plaza they stand on, and roads one step above it so they read as ribbons.
const LIGHT: Palette = {
  ground: '#E3DED7',
  water: '#BCD0EA',
  waterway: '#A8BEDD',
  park: '#CFDCC4',
  grass: '#D9E0CC',
  building: '#E7E4DE',
  roadMinor: '#F1EFEB',
  roadMed: '#F8F6F3',
  roadMajor: '#FFFFFF',
  roadCasing: '#CDC7BF',
  rail: '#C8C3BB',
  boundary: 'rgba(70,74,110,0.24)',
  label: '#3A3F52',
  labelHalo: '#F5F2EC',
  waterLabel: '#5F73A6',
  roadLabel: '#242838',
  roadLabelHalo: 'rgba(255,255,255,0.94)',
};

const MAJOR = ['motorway', 'trunk', 'primary'];
const MED = ['secondary', 'tertiary'];
const MINOR = ['minor', 'service', 'street', 'residential', 'living_street', 'unclassified', 'road'];

/** width = interpolate(exp 1.5) over zoom through the given [zoom, px] stops. */
function w(stops: [number, number][]) {
  return ['interpolate', ['exponential', 1.5], ['zoom'], ...stops.flat()] as unknown;
}

export function buildStyle(theme: MapTheme): StyleSpecification {
  const p = theme === 'dark' ? DARK : LIGHT;
  return {
    version: 8,
    glyphs: OFM_GLYPHS,
    sources: {
      omt: { type: 'vector', url: OFM_TILES, attribution: ATTRIBUTION },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': p.ground } },

      // --- land / green ---
      {
        id: 'landcover', type: 'fill', source: 'omt', 'source-layer': 'landcover',
        filter: ['in', ['get', 'class'], ['literal', ['wood', 'grass', 'scrub', 'forest']]],
        paint: { 'fill-color': p.grass, 'fill-opacity': 0.5 },
      },
      {
        id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park',
        paint: { 'fill-color': p.park, 'fill-opacity': 0.7 },
      },

      // --- water ---
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': p.water } },
      {
        id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 11,
        paint: { 'line-color': p.waterway, 'line-width': w([[11, 0.6], [16, 2.2]]) as number },
      },

      // --- buildings (subtle, close zoom) ---
      {
        id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 14,
        paint: {
          'fill-color': p.building,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.5, theme === 'dark' ? 0.55 : 0.7],
        },
      },

      // --- rail (quiet) ---
      {
        id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 12,
        filter: ['==', ['get', 'class'], 'rail'],
        paint: { 'line-color': p.rail, 'line-width': w([[12, 0.5], [16, 1.4]]) as number },
      },

      // --- road casing (under fills, gives quiet separation) ---
      {
        id: 'road-casing', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 11,
        filter: ['in', ['get', 'class'], ['literal', [...MAJOR, ...MED]]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.roadCasing, 'line-width': w([[11, 1.4], [14, 4], [17, 13], [19, 26]]) as number },
      },

      // --- road fills (quiet filled strokes, no glow) ---
      {
        id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 13,
        filter: ['in', ['get', 'class'], ['literal', MINOR]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.roadMinor, 'line-width': w([[13, 0.6], [15, 2], [17, 5], [19, 11]]) as number },
      },
      {
        id: 'road-med', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 11,
        filter: ['in', ['get', 'class'], ['literal', MED]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.roadMed, 'line-width': w([[11, 0.8], [14, 2.2], [17, 8], [19, 15]]) as number },
      },
      {
        id: 'road-major', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 9,
        filter: ['in', ['get', 'class'], ['literal', MAJOR]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.roadMajor, 'line-width': w([[9, 0.6], [12, 1.8], [14, 3.6], [17, 12], [19, 24]]) as number },
      },

      // --- admin boundaries (whisper) ---
      {
        id: 'boundary', type: 'line', source: 'omt', 'source-layer': 'boundary', minzoom: 6,
        filter: ['<=', ['get', 'admin_level'], 6],
        paint: { 'line-color': p.boundary, 'line-width': w([[6, 0.4], [12, 1.1]]) as number, 'line-dasharray': [3, 2] },
      },

      // --- labels (minimal) ---
      // Street names lie ALONG the road, rotated to the road angle, exactly as the
      // reference shows "King St West" / "Wellington St W" running down their
      // streets. `symbol-placement: line` defaults both rotation- and
      // pitch-alignment to `map`, so the type is painted onto the ground plane and
      // tips with the diorama camera instead of floating flat over it.
      //
      // Density is held DOWN on purpose (§D: "at phone size keep at most ~3
      // floating labels visible at once"): major/secondary roads only, a wide
      // `symbol-spacing` so one street gets one name rather than a repeating
      // ribbon, and generous `text-padding` so MapLibre's own collision index
      // keeps names off each other and off the marker blockers MapCard registers.
      {
        id: 'label-road', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 14.5,
        filter: ['in', ['get', 'class'], ['literal', [...MAJOR, ...MED]]],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 14.5, 11, 17, 13.5],
          'text-letter-spacing': 0.02,
          'symbol-placement': 'line',
          // The reference shows TWO street names in a 715px frame. `symbol-spacing`
          // only dedupes repeats along one feature — separate OSM ways with the same
          // name are separate features, so a wide `text-padding` is what actually
          // thins them: it inflates each label's collision box until neighbours (and
          // the marker blockers MapCard publishes) suppress each other.
          'symbol-spacing': 900,
          'text-padding': 34,
          'text-max-angle': 30,
        },
        paint: {
          // Near-white on dark (the reference), near-black on the light map — a
          // street name is navigational, so it gets real contrast, not a whisper.
          'text-color': p.roadLabel,
          'text-halo-color': p.roadLabelHalo,
          'text-halo-width': 1.6,
          'text-halo-blur': 0.4,
          'text-opacity': 0.95,
        },
      },
      // Neighbourhood/place names are an OVERVIEW label class, and the reference's
      // map has none of them — its only type is the street names running along the
      // roads. Left on, "Fashion District" and "Queen West" landed on top of the
      // stop pin and the route at the diorama zoom, which is exactly the overlap the
      // user complained about. Capped so they do their job when the map is zoomed
      // out and get out of the way when it is not.
      {
        id: 'label-place', type: 'symbol', source: 'omt', 'source-layer': 'place', maxzoom: 14.5,
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'suburb', 'neighbourhood', 'village']]],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': [
            'case', ['in', ['get', 'class'], ['literal', ['city', 'town']]],
            ['literal', ['Noto Sans Bold']], ['literal', ['Noto Sans Regular']],
          ] as unknown as string[],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            8, ['match', ['get', 'class'], ['city', 'town'], 13, 10],
            14, ['match', ['get', 'class'], ['city', 'town'], 18, 13],
          ],
          'text-letter-spacing': 0.02, 'text-max-width': 7,
        },
        paint: {
          'text-color': p.label, 'text-halo-color': p.labelHalo,
          'text-halo-width': 1.4, 'text-opacity': theme === 'dark' ? 0.82 : 0.9,
        },
      },
      {
        id: 'label-water', type: 'symbol', source: 'omt', 'source-layer': 'water_name', minzoom: 11,
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Italic'], 'text-size': 11, 'text-max-width': 6,
        },
        paint: { 'text-color': p.waterLabel, 'text-halo-color': p.labelHalo, 'text-halo-width': 1, 'text-opacity': 0.75 },
      },
    ],
  } as StyleSpecification;
}
