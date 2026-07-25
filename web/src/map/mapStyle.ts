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
}

const DARK: Palette = {
  ground: '#0B0E1A',
  water: '#0A1330',
  waterway: '#122046',
  park: '#121C22',
  grass: '#131A26',
  building: '#191A30',
  roadMinor: '#2A2A48',
  roadMed: '#343357',
  roadMajor: '#403D64',
  roadCasing: '#141628',
  rail: '#242440',
  boundary: 'rgba(180,184,220,0.12)',
  label: '#AAB0C4',
  labelHalo: '#0B0E1A',
  waterLabel: '#6E7BAE',
};

const LIGHT: Palette = {
  ground: '#C9CEDE',
  water: '#AEC1E6',
  waterway: '#9DB2DB',
  park: '#C4D3BE',
  grass: '#CBD6C6',
  building: '#D3CFE2',
  roadMinor: '#ECEDF5',
  roadMed: '#F6F6FB',
  roadMajor: '#FFFFFF',
  roadCasing: '#B4BAD0',
  rail: '#BFC3D6',
  boundary: 'rgba(70,74,110,0.24)',
  label: '#3A3F52',
  labelHalo: '#EEF0F5',
  waterLabel: '#5F73A6',
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
      {
        id: 'label-road', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 15,
        filter: ['in', ['get', 'class'], ['literal', [...MAJOR, ...MED]]],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'], 'text-size': 11, 'symbol-placement': 'line',
        },
        paint: { 'text-color': p.label, 'text-halo-color': p.labelHalo, 'text-halo-width': 1.2, 'text-opacity': 0.72 },
      },
      {
        id: 'label-place', type: 'symbol', source: 'omt', 'source-layer': 'place',
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
