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
//
// PASS 3 (this one) is a LUMINANCE-BAND correction, and it is the statistic that
// finally agrees with what the picture looks like. Share of the desktop map region
// per 0-255 luminance band, reference vs the pass-2 build:
//
//                0-16   16-32  32-48  48-64  64-80
//   reference     2.9%   37.3%  27.7%  13.2%  12.2%
//   pass 2       21.1%   27.8%  12.3%   6.0%  30.0%
//
// Pass 2 was bimodal — void plus glare. `ground: #090E22` is luminance 14, so a
// fifth of the frame sat in the 0-16 bucket the reference barely uses, and the
// gaps between blocks read as HOLES rather than as a lit surface. Worse, the road
// CASING (#0B1024, luminance 16) was DARKER than the ground it was drawn on, so
// every major street was a trench.
//
// The reference's darkest common tone is #081028 (luminance 16) and its streets
// are a lavender-slate around luminance 35-45 — a clearly lit surface, three or
// four steps above the ground, which is what puts 27.7% of its frame in the
// 32-48 band. These values reproduce that ladder: ground 20, casing 35, minor
// street 40, secondary 47, major 58.
//
// >>> "ITS STREETS ARE A LAVENDER-SLATE AROUND LUMINANCE 35-45" IS MEASURABLY FALSE,
// >>> AND IT IS THE LARGEST KNOWN DEFECT IN THIS RENDER. (The ladder in the sentence
// >>> after it is arithmetically right for the values below — they really are 20 / 35 /
// >>> 40 / 47 / 58. It is the reference reading they were built to match that is wrong,
// >>> so the whole ladder is anchored ~20 levels too high.)
// >>> DECISIONS §42 measured the reference's street SURFACE directly, two
// >>> ways: the luminance of its street-wide open ground (p10 15.5, p50 20.0, p90 25.2)
// >>> and raw vertical cuts across the sheet, which run 13-29 across every street and
// >>> 60-95 across every roof. The reference's streets are its DARKEST surface, not a
// >>> lit one — its whole ground plane, streets included, sits at ~20, which is exactly
// >>> where `ground: #0E142B` already sits. Our road surface measures 39.8-46.8: TWICE
// >>> the reference's, and ~20 levels above our own ground rather than ~3.
// >>>
// >>> The consequence is structural, not merely tonal. The road network is a connected
// >>> graph across the whole frame, so painting it above the building/ground luminance
// >>> boundary welds every block to every other block: 17% of the frame classifies as
// >>> "building" from the BASEMAP ALONE, and §38-§41's structural statistics were all
// >>> read through that. §41's headline "ground share 37.1% vs the reference's 37.8%"
// >>> is two errors cancelling — roads 17 points too bright, buildings 15 points too
// >>> few. Corrected, this frame is 44% built against the reference's 59%.
// >>>
// >>> IT IS DELIBERATELY NOT FIXED HERE, for the reason §41 gave for leaving the
// >>> `cellRand` / `pickTint` hash bugs: the fix invalidates the measurements of the
// >>> pass that found it. Darkening 17% of the frame by ~17 levels drops the frame mean
// >>> luminance from 40.6 to ~37.6 against the reference's 39.9, so it REGRESSES §40's
// >>> verified tonal match unless the missing 15 points of built coverage come back in
// >>> the same pass — and pass 1 above is the recorded proof that darkening the roads
// >>> alone makes the grid vanish. Roads and density have to move together, with their
// >>> own before/after. That is the next piece of work in this file. See DECISIONS §42.
const DARK: Palette = {
  ground: '#0E142B',
  water: '#0C1636',
  waterway: '#16264E',
  park: '#152318',
  grass: '#17251C',
  building: '#1B203F',
  roadMinor: '#1F2749',
  roadMed: '#242E56',
  roadMajor: '#2E3A66',
  // The street SURFACE, not a trench: the casing is the widest road element at the
  // diorama zoom, so it is what the eye reads as "the road", and it must sit above
  // the ground rather than below it.
  // §42: "above, not below" still holds — but only just. The reference puts its street
  // surface at luminance ~20, i.e. level with its ground, not the 15 levels above it
  // this 34.8 sits. Read the §42 block at the head of DARK before changing this.
  roadCasing: '#1B2242',
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
//
// CORRECTED: the first pass painted the roads BRIGHTER than the roofs
// (roadMed #F8F6F3 / roadMajor #FFFFFF against a #E7E4DE roof), so at the diorama
// zoom the blocks and the streets between them were the same value and there was
// no grid at all — "buildings white on white". The reference's daylight roofs are
// the LIGHTEST surface in frame (#f3f0ea); its roads are a legible mid-grey a
// clear step below them, which is what separates one block from the next.
const LIGHT: Palette = {
  ground: '#CFC9C1',
  water: '#BCD0EA',
  waterway: '#A8BEDD',
  park: '#C6D4BA',
  grass: '#D2DAC4',
  building: '#E7E4DE',
  roadMinor: '#DAD5CD',
  roadMed: '#E2DDD5',
  roadMajor: '#EAE5DD',
  roadCasing: '#BAB4AB',
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

      // --- road casing: the STREET SURFACE the blocks stand on -------------------
      // Widened deliberately. At the diorama zoom the casing is the widest road
      // element, so it is what actually fills the gaps between footprints — and
      // the reference's 27.7% of frame in the 32-48 luminance band is mostly this
      // surface, not building walls.
      // §42 REFUTES THAT LAST CLAIM: the reference's 32-48 band is its building WALLS
      // (lit 42, shaded 35 — §40 measured them). Its streets are at ~20 and sit in the
      // 16-32 band with the ground. This casing is the reason 17% of our frame
      // classifies as "building" from the basemap alone. See the §42 block above DARK.
      // A hairline casing left those gaps showing the
      // near-black ground, which is why the blocks read as plates floating over
      // nothing. Minor streets are included now for the same reason: downtown they
      // are the laneways between the big footprints.
      {
        id: 'road-casing', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 11,
        filter: ['in', ['get', 'class'], ['literal', [...MAJOR, ...MED, ...MINOR]]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.roadCasing, 'line-width': w([[11, 1.6], [14, 5], [17, 19], [19, 36]]) as number },
      },

      // --- road fills (quiet filled strokes, no glow) ---
      {
        id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 13,
        filter: ['in', ['get', 'class'], ['literal', MINOR]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.roadMinor, 'line-width': w([[13, 0.8], [15, 3.4], [17, 10], [19, 20]]) as number },
      },
      {
        id: 'road-med', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 11,
        filter: ['in', ['get', 'class'], ['literal', MED]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.roadMed, 'line-width': w([[11, 1], [14, 3.2], [17, 13], [19, 24]]) as number },
      },
      {
        id: 'road-major', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 9,
        filter: ['in', ['get', 'class'], ['literal', MAJOR]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.roadMajor, 'line-width': w([[9, 0.7], [12, 2.2], [14, 5], [17, 17], [19, 32]]) as number },
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
          // MEASURED off the reference, not chosen: "King St West" has a cap height
          // of ~13 reference px in a 1023px-wide window, which is a ~20-22px font.
          // The old 11 -> 13.5 ramp rendered street names at half that and they
          // read as basemap chrome instead of, as §A4 has it, a primary read of the
          // map. The wide `text-padding` below is what keeps the COUNT at two or
          // three per frame while each one gets bigger.
          'text-size': ['interpolate', ['linear'], ['zoom'], 14.5, 15.5, 17, 21],
          'text-letter-spacing': 0.02,
          'symbol-placement': 'line',
          // The reference shows TWO street names in a 715px frame. `symbol-spacing`
          // only dedupes repeats along one feature — separate OSM ways with the same
          // name are separate features, so a wide `text-padding` is what actually
          // thins them: it inflates each label's collision box until neighbours (and
          // the marker blockers MapCard publishes) suppress each other.
          'symbol-spacing': 900,
          'text-padding': 44,
          'text-max-angle': 30,
        },
        paint: {
          // Near-white on dark (the reference), near-black on the light map — a
          // street name is navigational, so it gets real contrast, not a whisper.
          'text-color': p.roadLabel,
          // A HEAVIER halo than a basemap would use, because this layer is now
          // lifted above the red route line (see `liftBasemapLabels`): the route
          // used to be painted straight through the glyphs, slicing them in half.
          // The halo is what lets the label sit ON the stroke and stay legible.
          'text-halo-color': p.roadLabelHalo,
          'text-halo-width': 2.4,
          'text-halo-blur': 0.3,
          'text-opacity': 1,
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
