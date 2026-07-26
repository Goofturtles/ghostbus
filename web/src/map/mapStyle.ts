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

// MEASURED off ghostbus-design-reference.png, over four passes, and the fourth one is
// what ships. The history matters because three of the four were wrong in ways that
// only the next instrument could see.
//
//   pass 1 read §C's "streets one step lighter than the ground" literally, dropped the
//     roads toward the ground tone, and the grid vanished — the render came back as one
//     continuous mass of rooftops with no sense of place.
//   pass 2 concluded the opposite: that the reference's streets are "a lavender-slate
//     around luminance 35-45", and built a ladder ground 20 / casing 35 / minor 40 /
//     secondary 47 / major 58 to match it.
//   pass 3 kept that ladder and justified it with a luminance-band histogram — the
//     reference gives 27.7% of its frame to the 32-48 band, and the casing was taken to
//     be what fills it.
//
//   pass 4 (§42 measured it, §43 ships it). BOTH of those readings were false, and they
//     were false in the same direction. §42 measured the reference's street SURFACE
//     directly, two independent ways: the luminance of its street-wide open ground
//     (p10 15.5, p50 20.0, p90 25.2) and raw vertical cuts across the sheet, which run
//     13-29 across every street and 60-95 across every roof. THE REFERENCE'S STREETS
//     ARE ITS DARKEST SURFACE, level with its own ground at ~20 — and the 32-48 band
//     pass 3 attributed to them is its building WALLS (§40 measured lit 42, shaded 35).
//     Our ladder was anchored ~20 levels too high: our road surface measured 39.8 (p50)
//     against our own ground at 20.4.
//
//     The consequence was structural, not merely tonal. The road network is a connected
//     graph across the whole frame, so painting it above the building/ground luminance
//     boundary WELDED every block to every other block: 17% of the frame classified as
//     "building" from the basemap alone, and every structural statistic in §38-§41 was
//     read through that. §41's headline "ground share 37.1% vs the reference's 37.8%"
//     was two errors cancelling — roads 17 points too bright, buildings 15 points too few.
//
// THE LADDER BELOW IS THE REFERENCE'S OWN, and it is deliberately NARROW: casing 17.5,
// minor 20.6, secondary 22.7, major 26.7, against a ground of 20.4. That spans exactly
// the reference's measured 15.5-25.2, and it means a minor street is no longer a lit
// surface — it is the ground, with an edge.
//
// WHY THE GRID SURVIVES THIS TIME, when pass 1's identical move destroyed it. Pass 1
// darkened the roads on a city covering 41.5% of the frame; roads and density have to
// move together, and §43 moves them together (the footprint floor is gone and both
// signed-hash bugs are fixed, taking built coverage to 47.2% before the roads move at
// all). Three things then carry the street grid, none of them a bright fill:
//
//   1. THE CASING IS NOW A STEP DARKER THAN ITS FILL, not lighter. It is the widest road
//      element at the diorama zoom, so it is the one that had to come down hardest; at
//      17.5 against a 20.4 ground it draws each street as a shallow channel with two
//      soft edges, which survives even where no building borders the street. A LIGHTER
//      casing was the other option and was rejected for the same reason pass 3 failed:
//      it puts the brightest pixels in the frame on the widest road element.
//   2. THE BUILDING MASSES DEFINE THE CORRIDOR. Roofs run 60-95 and lit walls ~45
//      against a ~20 street, so the contrast that reads as "street" is building-to-
//      street, not street-to-ground — exactly as it is in the reference.
//   3. THE STREET NAMES. Near-white type on a now-darker surface gains contrast for
//      free; the label layer below is unchanged and did not need to be touched.
const DARK: Palette = {
  ground: '#0E142B',
  water: '#0C1636',
  waterway: '#16264E',
  park: '#152318',
  grass: '#17251C',
  building: '#1B203F',
  roadMinor: '#0E142E',
  roadMed: '#101632',
  roadMajor: '#131A38',
  // The street CHANNEL. The casing is the widest road element at the diorama zoom, so
  // it is what the eye reads as "the road" — and at 17.5 it is now a step DARKER than
  // both its own fill (20.6) and the ground (20.4), which is what gives a street two
  // edges without giving it a glow. It sat at 34.8 for three passes. See the §43 block
  // above DARK before changing it.
  roadCasing: '#0C1126',
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
//
// §43 CARRIED THE SAME CORRECTION ACROSS, because the same defect was here in a
// lighter key. The roads had crept back UP to the roof band: roadMajor measured 229.6
// against building tops of 228-244, so a major street and a rooftop were the same
// value again — and §43's density work, which draws every footprint the tiles carry
// instead of only those over 500 m2, put many more near-white blocks against them.
// Left alone, the light theme would have washed out exactly as the dark one welded.
//
// The fix is the dark theme's, mirrored: the street surface sits AT or just below the
// ground plane, and the blocks own the top of the range. minor 195.6 / ground 201.7 /
// secondary 202.6 / major 210.6 / building 228 / roofs 228-244, over a casing left at
// 180.5 — already a step below everything, and the element that gives each street two
// edges. Navigational hierarchy is untouched: a major road is still the lightest road.
const LIGHT: Palette = {
  ground: '#CFC9C1',
  water: '#BCD0EA',
  waterway: '#A8BEDD',
  park: '#C6D4BA',
  grass: '#D2DAC4',
  building: '#E7E4DE',
  roadMinor: '#C9C3BA',
  roadMed: '#D0CAC1',
  roadMajor: '#D8D2C9',
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

      // --- road casing: the STREET CHANNEL the blocks stand in --------------------
      // Widened deliberately, and the WIDTH is the part of this layer that was always
      // right. At the diorama zoom the casing is the widest road element, so it is what
      // actually fills the gaps between footprints; a hairline casing left those gaps
      // showing raw ground and the blocks read as plates floating over nothing. Minor
      // streets are included for the same reason — downtown they are the laneways
      // between the big footprints.
      //
      // Its TONE is what was wrong for three passes. It was justified by the claim that
      // the reference's 27.7% of frame in the 32-48 luminance band is mostly this
      // surface; §42 refuted that outright — the reference's 32-48 band is its building
      // WALLS (§40 measured lit 42, shaded 35), and its streets sit at ~20 in the 16-32
      // band with the ground. A casing at 34.8 was the single largest reason 17% of our
      // frame classified as "building" from the basemap alone. It is now 17.5, a step
      // BELOW the ground, and the corridor reads as a channel rather than a ribbon.
      // See the §43 block above DARK.
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

      // --- labels ---
      // Street names lie ALONG the road, rotated to the road angle, exactly as the
      // reference shows "King St West" / "Wellington St W" running down their
      // streets. `symbol-placement: line` defaults both rotation- and
      // pitch-alignment to `map`, so the type is painted onto the ground plane and
      // tips with the diorama camera instead of floating flat over it.
      //
      // TWO LAYERS, AND THE ORDER BETWEEN THEM IS LOAD-BEARING.
      //
      // The user tested the live app and filed it plainly: the streets are not
      // labeled. They were right, and the cause was this layer's FILTER — it carried
      // `[...MAJOR, ...MED]`, so motorway/trunk/primary/secondary/tertiary got names
      // and every residential street, laneway and side street in the frame got
      // nothing. Downtown Toronto at the diorama zoom is mostly those.
      //
      // `label-road-minor` below therefore names them, and it is placed BEFORE
      // `label-road` in this array on purpose. MapLibre's placement pass walks the
      // style order from the END downward, so the LAST symbol layer is placed FIRST
      // and wins every collision it takes part in. Minor first in the array means
      // minor is placed LAST, so a side street can never suppress "King St West" —
      // the hierarchy the reference shows survives having five times as many labels
      // in the frame.
      //
      // What this does NOT and CANNOT do: label a street OSM has no name for. The
      // `transportation_name` layer only carries ways that have been named, so an
      // unnamed service alley stays unnamed — there is no data to draw. The
      // per-frame coverage this actually achieves is measured, not assumed; see the
      // census in .data/r5map-artifacts/labels-*.json.
      {
        id: 'label-road-minor', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name',
        // Higher than the majors' 14.5: a residential street name is only legible
        // once its street is more than a few pixels wide, and below the diorama the
        // frame belongs to the arterials.
        minzoom: 15,
        filter: ['in', ['get', 'class'], ['literal', MINOR]],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          // Regular, not Bold — the weight difference is half of what keeps the
          // arterial names dominant now that the side streets are named too.
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 15, 10.5, 17, 14],
          'text-letter-spacing': 0.01,
          'symbol-placement': 'line',
          // Tight, unlike the majors. `text-padding: 44` is what thins the arterials
          // to the reference's two-per-frame; applying it here would suppress almost
          // every side street and leave the RED exactly where it was.
          'symbol-spacing': 260,
          'text-padding': 3,
          'text-max-angle': 35,
        },
        paint: {
          'text-color': p.roadLabel,
          'text-halo-color': p.roadLabelHalo,
          // Slightly tighter halo than the majors', scaled to the smaller type.
          'text-halo-width': 1.8,
          'text-halo-blur': 0.3,
          // Not full strength: a side street name is a secondary read. This is the
          // other half of the hierarchy, and it keeps a frame with twenty labels in
          // it from reading as a wall of type.
          'text-opacity': theme === 'dark' ? 0.86 : 0.9,
        },
      },
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
          // name are separate features, so `text-padding` is what actually thins
          // them: it inflates each label's collision box until neighbours (and the
          // marker blockers MapCard publishes) suppress each other.
          //
          // RELAXED, 900/44 -> 420/14. At 44 px of padding an arterial name claimed a
          // ~50 px moat, and the layer was thinned so hard that ARTERIALS were going
          // unnamed too — which is half of the user's "streets are not labeled". The
          // reference's two-names-per-frame was never a rule about how many streets
          // may be named; it is what that one illustration happens to show. 14 px
          // still keeps names off each other and off the marker blockers (whose own
          // `icon-padding` was raised to match — see MapCard), and it lets a frame
          // name the streets it actually contains.
          'symbol-spacing': 420,
          'text-padding': 14,
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
