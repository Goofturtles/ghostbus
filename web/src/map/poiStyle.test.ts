// THE POI LAYERS, PINNED.
//
// Three properties are asserted here, and each of them is a defect this design has a
// real chance of regressing into:
//
//   1. THE HIERARCHY IS THE STYLE ORDER. MapLibre places symbol layers from the END of
//      the array downward, so the last one is placed first and wins every collision.
//      Reordering these five layers by accident silently inverts "an arterial street
//      name outranks a coffee shop" — and nothing about the render says so, because
//      both labels still draw, just not the same ones.
//   2. THE CLASS FILTERS ARE NARROWED BY SUBCLASS. OpenMapTiles' `class` is wider than
//      its name: `library` carries bookshops, `hospital` carries dentists' clinics,
//      `railway` carries tram stops. Every fixture below is a REAL feature's property
//      set, taken from the z14 tile over downtown Toronto (4578/5979).
//   3. EVERY ICON THE STYLE ASKS FOR IS AN ICON THE GLYPH MODULE CAN DRAW. A typo in
//      one `match` branch draws no glyph at all, and with `icon-optional: false` that
//      silently drops the label too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStyle, POI_LAYER_IDS, POI_ZOOM_LADDER } from './mapStyle';
import { parsePoiGlyphId, poiGlyphId } from './poiGlyphs';

type Props = Record<string, string | number | undefined>;

/**
 * A deliberately tiny evaluator for the expression subset these filters use. Written
 * out rather than pulled from maplibre-gl because that package is a browser bundle and
 * this suite runs in node — and because a filter that needs more than these seven
 * operators is a filter that has become too clever to review.
 */
function evalExpr(e: unknown, props: Props): unknown {
  if (!Array.isArray(e)) return e;
  const [op, ...args] = e as [string, ...unknown[]];
  switch (op) {
    case 'literal': return args[0];
    case 'get': return props[evalExpr(args[0], props) as string];
    case 'has': return Object.prototype.hasOwnProperty.call(props, evalExpr(args[0], props) as string)
      && props[evalExpr(args[0], props) as string] !== undefined;
    case 'all': return args.every((a) => evalExpr(a, props) === true);
    case 'any': return args.some((a) => evalExpr(a, props) === true);
    case '==': return evalExpr(args[0], props) === evalExpr(args[1], props);
    case '!=': return evalExpr(args[0], props) !== evalExpr(args[1], props);
    case 'in': {
      const needle = evalExpr(args[0], props);
      const hay = evalExpr(args[1], props) as unknown[];
      return hay.includes(needle);
    }
    default: throw new Error(`filter uses an operator this test cannot evaluate: ${op}`);
  }
}

const style = buildStyle('dark');
const ids = style.layers.map((l) => l.id);
const layer = (id: string) => {
  const l = style.layers.find((x) => x.id === id);
  assert.ok(l, `style has no layer ${id}`);
  return l as unknown as { filter?: unknown; layout?: Record<string, unknown>; minzoom?: number };
};
const passes = (id: string, props: Props) => evalExpr(layer(id).filter, props) === true;

// Real property sets, measured off tile 14/4578/5979.
const SUBWAY = { class: 'railway', subclass: 'subway', name: 'St. Patrick', rank: 3 };
const TRAM_STOP = { class: 'railway', subclass: 'tram_stop', name: 'Harbord Street', rank: 1 };
const BUS_STOP = { class: 'bus', subclass: 'bus_stop', name: 'Bathurst Street', rank: 4 };
const CN_TOWER = { class: 'attraction', subclass: 'attraction', name: 'CN Tower', rank: 1 };
const HOSPITAL = { class: 'hospital', subclass: 'hospital', name: 'Toronto Western Hospital', rank: 1 };
const CLINIC = { class: 'hospital', subclass: 'clinic', name: 'College St. Medical Offices', rank: 1 };
const LIBRARY = { class: 'library', subclass: 'library', name: 'Toronto Public Library - Sanderson', rank: 11 };
const BOOKSHOP = { class: 'library', subclass: 'books', name: 'Type Books', rank: 6 };
const UNIVERSITY = { class: 'college', subclass: 'university', name: 'University of Toronto St. George', rank: 2 };
const COMMUNITY_CENTRE = { class: 'town_hall', subclass: 'community_centre', name: 'Cecil Community Centre', rank: 10 };
const RESTAURANT = { class: 'restaurant', subclass: 'restaurant', name: 'Sneaky Dee’s', rank: 99 };
const CAFE = { class: 'cafe', subclass: 'cafe', name: 'Sam James Coffee Bar', rank: 95 };
const OPTICIAN = { class: 'shop', subclass: 'optician', name: 'Eye Spy Optical', rank: 22 };
const MALL = { class: 'shop', subclass: 'mall', name: 'Eaton Centre', rank: 4 };
const INDOOR_UNIT = { class: 'restaurant', subclass: 'restaurant', name: 'Food court stall', rank: 120, indoor: 1 };
const UNNAMED = { class: 'restaurant', subclass: 'restaurant', rank: 240 };

test('placement order encodes the label hierarchy', () => {
  // Later in the array = placed earlier = wins the collision.
  const order = ['poi-minor', 'poi-major', 'label-road-minor', 'poi-station', 'label-road'];
  const at = order.map((id) => {
    const i = ids.indexOf(id);
    assert.ok(i >= 0, `style has no layer ${id}`);
    return i;
  });
  for (let i = 1; i < at.length; i++) {
    assert.ok(at[i] > at[i - 1], `${order[i]} must sit after ${order[i - 1]} in the style array`);
  }
  // And every POI layer must stay BELOW the app's own overlays, which are added by
  // MapCard on top of this style. Nothing here may be the last symbol layer.
  for (const id of POI_LAYER_IDS) assert.ok(ids.indexOf(id) < ids.length - 1);
});

test('stations come from the basemap; stops do not', () => {
  assert.ok(passes('poi-station', SUBWAY));
  // GhostBus draws the agency's own stops. OSM's copy of them is not welcome.
  assert.ok(!passes('poi-station', TRAM_STOP), 'a tram stop must never be drawn as a station');
  assert.ok(!passes('poi-station', BUS_STOP), 'a bus stop must never be drawn as a station');
});

test('the wide classes are narrowed by subclass', () => {
  assert.ok(passes('poi-major', CN_TOWER));
  assert.ok(passes('poi-major', HOSPITAL));
  assert.ok(!passes('poi-major', CLINIC), 'a clinic must not be drawn with the hospital glyph');
  assert.ok(passes('poi-major', LIBRARY));
  assert.ok(!passes('poi-major', BOOKSHOP), 'a bookshop is not a library');
  assert.ok(passes('poi-major', UNIVERSITY));
  assert.ok(!passes('poi-major', COMMUNITY_CENTRE), 'a community centre is not a town hall');
});

test('food and cafes are the minor tier; a nail salon is nothing', () => {
  assert.ok(passes('poi-minor', RESTAURANT));
  assert.ok(passes('poi-minor', CAFE));
  assert.ok(passes('poi-minor', MALL));
  assert.ok(!passes('poi-minor', OPTICIAN), 'generic shops are 488 named features per downtown tile');
  assert.ok(!passes('poi-major', RESTAURANT), 'food must not leak into the landmark tier');
});

test('nothing unnamed and nothing indoor is ever drawn', () => {
  for (const id of POI_LAYER_IDS) {
    assert.ok(!passes(id, UNNAMED), `${id} drew a feature with no name`);
    assert.ok(!passes(id, INDOOR_UNIT), `${id} drew an indoor feature`);
  }
});

test('food and shops only appear past the diorama framing', () => {
  // `frameCamera` opens between z15.4 and z16.35. The minor tier must start above it.
  assert.ok((layer('poi-minor').minzoom ?? 0) > 16.35);
  assert.ok((layer('poi-major').minzoom ?? 0) < (layer('poi-minor').minzoom ?? 0));
  assert.ok((layer('poi-station').minzoom ?? 0) < (layer('poi-major').minzoom ?? 0));
  // The narrow-card ladder only ever pushes a layer LATER, never earlier.
  for (const id of POI_LAYER_IDS) {
    const rung = POI_ZOOM_LADDER[id];
    assert.ok(rung, `no narrow-card rung for ${id}`);
    assert.equal(rung.wide, layer(id).minzoom, `${id}'s wide rung must match its authored minzoom`);
    assert.ok(rung.narrow > rung.wide, `${id} must get quieter on a phone, not louder`);
  }
});

test('every icon the style asks for is an icon the glyph module can draw', () => {
  for (const theme of ['dark', 'light'] as const) {
    const s = buildStyle(theme);
    for (const id of POI_LAYER_IDS) {
      const l = s.layers.find((x) => x.id === id) as unknown as { layout: Record<string, unknown> };
      const img = l.layout['icon-image'] as unknown[];
      assert.equal(img[0], 'concat', `${id}'s icon-image must be a concat of category + theme`);
      const suffix = img[2] as string;
      // Pull every literal string the category expression can produce.
      const outs: string[] = [];
      const walk = (e: unknown) => {
        if (typeof e === 'string' && e.startsWith('poi-')) outs.push(e);
        else if (Array.isArray(e)) e.forEach(walk);
      };
      walk(img[1]);
      assert.ok(outs.length > 0, `${id} produced no icon category`);
      for (const o of outs) {
        const parsed = parsePoiGlyphId(o + suffix);
        assert.ok(parsed, `${id} asks for "${o + suffix}", which poiGlyphs cannot draw`);
        assert.equal(poiGlyphId(parsed.cat, parsed.theme), o + suffix);
      }
    }
  }
});

test('an id that is not ours is not claimed', () => {
  assert.equal(parsePoiGlyphId('blk-40x24'), null);
  assert.equal(parsePoiGlyphId('poi-nonsense-dark'), null);
  assert.equal(parsePoiGlyphId('poi-food-sepia'), null);
});
