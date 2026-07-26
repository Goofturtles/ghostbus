// Pedestrian routing — the module that turns "somewhere near you" and "that stop"
// into a line you can actually walk.
//
// WHY THIS EXISTS. The map used to draw the walk as a two-point LineString from the
// rider straight to the boarding stop. A rider testing the live app said what that
// looks like from the outside: the path cuts through buildings. It does — a straight
// line through downtown Toronto crosses whatever happens to be in the way, and the
// app was drawing it in the loudest place it has while claiming, everywhere else,
// that it does not show people things that are not true.
//
// WHERE THE STREETS COME FROM. Nowhere new. The basemap is OpenFreeMap vector tiles
// on the OpenMapTiles schema, and its `transportation` layer carries the same
// OpenStreetMap ways that draw the roads under your finger — footways, sidewalks,
// crossings, steps, residential streets. The voxel city already reads that source
// for building footprints (`voxelMesh.ts`); this reads the lines instead of the
// polygons. So routing costs ZERO new network: the data is already downloaded,
// already decoded, and already on screen. See DECISIONS §51.
//
// WHAT THIS FILE IS NOT. It is not a trip planner and it is not turn-by-turn. It has
// no notion of one-way (irrelevant on foot), no traffic signals, no elevation. It
// answers one question — what is the shortest walkable line between these two
// points, given the ways this device has already loaded — and it answers `null` when
// it cannot, which is a state the callers are required to render as an absence or a
// labelled straight line, never as a route.
//
// PURE ON PURPOSE. No maplibre import, no DOM, no fetch. The edge list is passed in.
// That is what lets the whole thing be exercised in a plain Node test against a real
// fixture of King & Spadina (`walkRoute.test.ts`).

/** One walkable way, as lon/lat vertices. `steps` marks a staircase. */
export interface WalkLine {
  coords: readonly (readonly [number, number])[];
  steps?: boolean;
}

export interface WalkPoint { lat: number; lon: number }

export interface WalkPath {
  /** lon/lat, starting at `from` and ending at `to` — both ends included, so the
   *  drawn line always begins under the rider and ends under the stop pin. */
  coordinates: [number, number][];
  /** Metres actually walked along this line. Not the straight-line distance. */
  distanceM: number;
}

export interface RouteOpts {
  /**
   * How far a query point may be from the nearest way before we refuse to attach it.
   * A rider inside a shopping mall, on a pier, or in a park with no mapped paths is
   * genuinely not on the network, and pretending otherwise would draw a route that
   * starts 300 m from where they are standing.
   */
  maxAttachM?: number;
  /** Gap that counts as "these two ways are the same way, cut in half". See `heal`. */
  healM?: number;
  /**
   * Absurdity guard. A partial graph can be connected and still only offer a route
   * three times longer than the crow flies; that is a symptom of missing data, not a
   * fact about the walk, so it is refused rather than drawn. Genuine detours (around
   * a rail corridor, a river) live comfortably under this.
   */
  detourCeiling?: number;
  /** Route around staircases. Set for the wheelchair / walker / stroller profiles. */
  avoidSteps?: boolean;
}

const DEFAULTS: Required<RouteOpts> = {
  maxAttachM: 150,
  healM: 8,
  detourCeiling: 3,
  avoidSteps: false,
};

/** Detour in METRES below which `detourCeiling` never fires. See the guard's note. */
const DETOUR_FLOOR_M = 250;

const TO_R = Math.PI / 180;
const R_EARTH_M = 6_371_000;

export function haversineM(a: WalkPoint, b: WalkPoint): number {
  const dLat = (b.lat - a.lat) * TO_R;
  const dLon = (b.lon - a.lon) * TO_R;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * TO_R) * Math.cos(b.lat * TO_R) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * A local equirectangular plane in metres, anchored at the walk's own latitude.
 *
 * Every distance in the graph is a plane distance rather than a haversine one. Over
 * the two kilometres this module ever spans the difference is under a centimetre,
 * and the plane buys exact, cheap point-to-segment projection — which is the
 * operation the whole thing is built on.
 *
 * THE CONSTANTS ARE THE HAVERSINE'S OWN, not the WGS84 ellipsoid's. Metres per
 * degree comes from the same spherical radius `haversineM` uses, because routed
 * distances are compared against haversine straight-line distances (the detour
 * guards below, and `catch.ts` upstream). Mixing 110_574 (WGS84 meridional at 45°)
 * with a 6_371_000 m sphere makes plane north-south distances 0.56% short, which is
 * enough for a 200 m walk due north to measure as SHORTER than the crow flies and
 * be refused as impossible.
 */
const M_PER_DEG = R_EARTH_M * TO_R;
function planeAt(lat0: number) {
  const kx = M_PER_DEG * Math.cos(lat0 * TO_R);
  const ky = M_PER_DEG;
  return {
    x: (lon: number) => lon * kx,
    y: (lat: number) => lat * ky,
    lon: (x: number) => x / kx,
    lat: (y: number) => y / ky,
  };
}
type Plane = ReturnType<typeof planeAt>;

interface Node { x: number; y: number }
interface Edge { to: number; w: number; steps: boolean }

interface Graph {
  P: Plane;
  nodes: Node[];
  adj: Edge[][];
  /** every edge once, as a node pair — the thing points get projected onto. */
  segs: [number, number][];
  segSteps: boolean[];
}

/**
 * Vertices land in 1 m cells and every cell is one node.
 *
 * This is what turns a pile of disconnected polylines into a network: where two OSM
 * ways meet they share a node, so they share a coordinate, so they share a cell.
 * One metre is chosen against the data, not by taste — a z14 tile quantises
 * coordinates to a 4096 grid, which at this latitude is 43 cm, so the SAME real
 * vertex arriving from two different tiles can differ by that much and must still
 * merge, while two genuinely different vertices a metre apart essentially never
 * occur in OSM road data.
 */
const CELL_M = 1;

function buildGraph(lines: readonly WalkLine[], lat0: number): Graph {
  const P = planeAt(lat0);
  const g: Graph = { P, nodes: [], adj: [], segs: [], segSteps: [] };
  const cells = new Map<string, number>();
  const pairs = new Map<string, number>();

  const nodeAt = (lon: number, lat: number): number => {
    const x = P.x(lon), y = P.y(lat);
    const key = `${Math.round(x / CELL_M)},${Math.round(y / CELL_M)}`;
    const hit = cells.get(key);
    if (hit !== undefined) return hit;
    const i = g.nodes.length;
    g.nodes.push({ x, y });
    g.adj.push([]);
    cells.set(key, i);
    return i;
  };

  for (const line of lines) {
    let prev = -1;
    for (const c of line.coords) {
      if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) { prev = -1; continue; }
      const i = nodeAt(c[0], c[1]);
      if (prev >= 0 && prev !== i) link(g, pairs, prev, i, line.steps === true);
      prev = i;
    }
  }
  return g;
}

function link(
  g: Graph, pairs: Map<string, number>, a: number, b: number, steps: boolean,
): void {
  if (a === b) return;
  const key = a < b ? `${a}_${b}` : `${b}_${a}`;
  const seen = pairs.get(key);
  if (seen !== undefined) {
    // The same node pair arriving twice is a footway drawn alongside its own
    // staircase, or a way repeated across a tile seam. If EITHER copy is step-free
    // then the pair is step-free: dropping the duplicate silently would otherwise
    // leave a step-free profile refusing a link it can use, purely because the
    // staircase happened to be parsed first.
    if (!steps && g.segSteps[seen]) {
      g.segSteps[seen] = false;
      for (const e of g.adj[a]) if (e.to === b) e.steps = false;
      for (const e of g.adj[b]) if (e.to === a) e.steps = false;
    }
    return;
  }
  const w = Math.hypot(g.nodes[a].x - g.nodes[b].x, g.nodes[a].y - g.nodes[b].y);
  g.adj[a].push({ to: b, w, steps });
  g.adj[b].push({ to: a, w, steps });
  pairs.set(key, g.segs.length);
  g.segs.push([a, b]);
  g.segSteps.push(steps);
}

// ---------------------------------------------------------------- spatial index

interface SegIndex { cell: number; bins: Map<string, number[]> }

function indexSeg(g: Graph, ix: SegIndex, i: number): void {
  const [a, b] = g.segs[i];
  const A = g.nodes[a], B = g.nodes[b];
  const c = ix.cell;
  const x0 = Math.floor(Math.min(A.x, B.x) / c), x1 = Math.floor(Math.max(A.x, B.x) / c);
  const y0 = Math.floor(Math.min(A.y, B.y) / c), y1 = Math.floor(Math.max(A.y, B.y) / c);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const k = `${x},${y}`;
      const arr = ix.bins.get(k);
      if (arr) arr.push(i); else ix.bins.set(k, [i]);
    }
  }
}

function indexSegs(g: Graph, cell = 40): SegIndex {
  const ix: SegIndex = { cell, bins: new Map<string, number[]>() };
  for (let i = 0; i < g.segs.length; i++) indexSeg(g, ix, i);
  return ix;
}

function segsNear(ix: SegIndex, x: number, y: number, radiusM: number): number[] {
  const r = Math.ceil(radiusM / ix.cell);
  const cx = Math.floor(x / ix.cell), cy = Math.floor(y / ix.cell);
  const out = new Set<number>();
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      const arr = ix.bins.get(`${cx + dx},${cy + dy}`);
      if (arr) for (const i of arr) out.add(i);
    }
  }
  return [...out];
}

interface Projection { t: number; x: number; y: number; d: number }
function project(px: number, py: number, A: Node, B: Node): Projection {
  const vx = B.x - A.x, vy = B.y - A.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - A.x) * vx + (py - A.y) * vy) / len2));
  const x = A.x + t * vx, y = A.y + t * vy;
  return { t, x, y, d: Math.hypot(px - x, py - y) };
}

/**
 * Split segment `si` at the given point, returning the node now sitting there.
 *
 * THE INDEX IS UPDATED HERE, and that is not tidiness. A split replaces `segs[si]`
 * with its first half and PUSHES the second half; an index built beforehand has no
 * entry for that second half. The bug that costs is subtle and common: attach the
 * rider, then attach the stop, and if the stop's nearest point lies on the half that
 * the index cannot see, the projection clamps to the end of the truncated first half
 * — which is the node the rider just attached to. Both ends collapse onto one node
 * and a rider and a stop on the SAME BLOCK, the commonest short walk there is, get
 * no route at all.
 *
 * `si`'s own bins are left over-large, which is harmless: an extra candidate is an
 * extra projection against a segment that has genuinely shrunk, and the projection
 * is computed from live node coordinates.
 */
function splitAt(g: Graph, ix: SegIndex, si: number, p: Projection): number {
  const [a, b] = g.segs[si];
  if (p.t <= 1e-9) return a;
  if (p.t >= 1 - 1e-9) return b;
  const steps = g.segSteps[si];
  const n = g.nodes.length;
  g.nodes.push({ x: p.x, y: p.y });
  g.adj.push([]);
  g.adj[a] = g.adj[a].filter((e) => e.to !== b);
  g.adj[b] = g.adj[b].filter((e) => e.to !== a);
  const wa = Math.hypot(g.nodes[a].x - p.x, g.nodes[a].y - p.y);
  const wb = Math.hypot(g.nodes[b].x - p.x, g.nodes[b].y - p.y);
  g.adj[a].push({ to: n, w: wa, steps });
  g.adj[n].push({ to: a, w: wa, steps });
  g.adj[b].push({ to: n, w: wb, steps });
  g.adj[n].push({ to: b, w: wb, steps });
  g.segs[si] = [a, n];
  g.segs.push([n, b]);
  g.segSteps.push(steps);
  indexSeg(g, ix, g.segs.length - 1);
  return n;
}

/**
 * Rejoin ways that a tile boundary cut in half.
 *
 * MEASURED, and it is the difference between a router and a toy. Vector tiles are
 * clipped: a street crossing a tile edge arrives as two pieces, and the piece from
 * the neighbouring tile overruns the edge into a buffer zone, so its cut end lands
 * in the MIDDLE of the other piece rather than on one of its vertices. Cell merging
 * cannot see that, and the graph silently comes apart along a grid.
 *
 * On the King & Spadina fixture, six realistic rider→stop walks routed at 6.5×,
 * 2.1×, 1.5×, 4.1× and 16.9× the straight-line distance, with the sixth finding no
 * path at all. Healing every DANGLING end (degree 1) onto a segment within a few
 * metres fixed all six, at 1.26×–1.95× — what a downtown walk with crossings costs.
 *
 * THE TOLERANCE IS 8 m, AND 3 m WAS NOT ENOUGH. Three metres passed those six because
 * a missing link costs a LONG walk little: the detour is absorbed. The app's own
 * default view is the case that exposed it — Front & Spadina to King St W at Spadina
 * Ave, 225 m — where one unjoined 7 m gap sent the route the long way round the block
 * at 1152 m (5.1×), over the detour ceiling, so the map fell back to the straight line
 * on the very first screen a rider sees. At 8 m it is 419 m (1.87×). Both datasets
 * agree: measured over the fixture AND over lines captured live out of the running
 * app's own tile cache, every other pair is IDENTICAL from 3 m to 12 m, so this buys
 * the short walks without loosening the long ones.
 *
 * Only degree-1 nodes are healed: a dangling end in this data is a tile cut or a
 * genuine cul-de-sac. The joint's length is charged to the route like any other edge,
 * so a healed crossing is walked, not teleported.
 *
 * Two cut ends that join EACH OTHER rather than a through-way is the intended
 * outcome, not a miss: the commonest cut is a single way sliced in two, so the ends
 * pairing off IS the repair. The loop reads degrees live, and a degree can only ever
 * rise, so an end that gets healed by its own partner is correctly skipped when its
 * turn comes.
 */
function heal(g: Graph, ix: SegIndex, maxM: number): number {
  let joined = 0;
  const before = g.nodes.length;
  for (let i = 0; i < before; i++) {
    if (g.adj[i].length !== 1) continue;
    const N = g.nodes[i];
    let best: { si: number; p: Projection } | null = null;
    for (const si of segsNear(ix, N.x, N.y, maxM)) {
      const [a, b] = g.segs[si];
      if (a === i || b === i) continue;
      if (g.adj[i].some((e) => e.to === a || e.to === b)) continue;
      const p = project(N.x, N.y, g.nodes[a], g.nodes[b]);
      if (p.d <= maxM && (best === null || p.d < best.p.d)) best = { si, p };
    }
    if (!best) continue;
    const j = splitAt(g, ix, best.si, best.p);
    if (j === i) continue;
    const w = Math.hypot(g.nodes[i].x - g.nodes[j].x, g.nodes[i].y - g.nodes[j].y);
    // A heal edge inherits nothing: it is a joint, not a staircase.
    g.adj[i].push({ to: j, w, steps: false });
    g.adj[j].push({ to: i, w, steps: false });
    joined++;
  }
  return joined;
}

/**
 * Put a lon/lat point on the network. Returns the node and the stub walked to it.
 *
 * `avoidSteps` has to be honoured HERE as well as in the search: attaching a
 * wheelchair profile to the nearest segment when the nearest segment is a staircase
 * strands it on a node whose every edge the search then refuses, and the answer
 * comes back "no route" with a sidewalk five metres away.
 */
function attach(
  g: Graph, ix: SegIndex, p: WalkPoint, maxM: number, avoidSteps: boolean,
): { node: number; stubM: number } | null {
  const px = g.P.x(p.lon), py = g.P.y(p.lat);
  let best: { si: number; p: Projection } | null = null;
  for (const si of segsNear(ix, px, py, maxM)) {
    if (avoidSteps && g.segSteps[si]) continue;
    const [a, b] = g.segs[si];
    const pr = project(px, py, g.nodes[a], g.nodes[b]);
    if (pr.d <= maxM && (best === null || pr.d < best.p.d)) best = { si, p: pr };
  }
  if (!best) return null;
  return { node: splitAt(g, ix, best.si, best.p), stubM: best.p.d };
}

// ---------------------------------------------------------------- search

/** A*, straight-line heuristic (admissible: no edge is shorter than the crow flies). */
function astar(g: Graph, s: number, t: number, avoidSteps: boolean): number[] | null {
  const n = g.nodes.length;
  const cost = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const settled = new Uint8Array(n);
  const T = g.nodes[t];
  const h = (i: number) => Math.hypot(g.nodes[i].x - T.x, g.nodes[i].y - T.y);

  // Binary heap, inline: this runs on a phone and an array sort per pop is not free.
  const heap: { f: number; i: number }[] = [];
  const push = (f: number, i: number) => {
    heap.push({ f, i });
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p].f <= heap[c].f) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop() as { f: number; i: number };
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1, r = l + 1;
        let m = c;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };

  cost[s] = 0;
  push(h(s), s);
  while (heap.length) {
    const cur = pop().i;
    if (settled[cur]) continue;
    settled[cur] = 1;
    if (cur === t) break;
    for (const e of g.adj[cur]) {
      if (avoidSteps && e.steps) continue;
      const next = cost[cur] + e.w;
      if (next < cost[e.to]) {
        cost[e.to] = next;
        from[e.to] = cur;
        push(next + h(e.to), e.to);
      }
    }
  }
  if (!settled[t]) return null;
  const path: number[] = [];
  for (let i = t; i !== -1; i = from[i]) path.push(i);
  return path.reverse();
}

// ---------------------------------------------------------------- public

/**
 * The shortest walkable line between two points over the ways supplied, or null.
 *
 * `null` is a first-class answer and means exactly one thing: THIS DEVICE CANNOT SAY.
 * The ways may not have loaded, the rider may be off the network, the two ends may
 * be genuinely unconnected in the data. Callers must render that as an absence or as
 * a straight line that says on its face it is one — never as a route.
 */
export function routeWalk(
  lines: readonly WalkLine[],
  from: WalkPoint,
  to: WalkPoint,
  opts: RouteOpts = {},
): WalkPath | null {
  // An explicit `undefined` from a caller spreading its own options must not wipe a
  // default and NaN-poison every threshold below.
  const num = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const o = {
    maxAttachM: num(opts.maxAttachM, DEFAULTS.maxAttachM),
    healM: num(opts.healM, DEFAULTS.healM),
    detourCeiling: num(opts.detourCeiling, DEFAULTS.detourCeiling),
    avoidSteps: opts.avoidSteps === true,
  };
  if (!Number.isFinite(from.lat) || !Number.isFinite(from.lon)) return null;
  if (!Number.isFinite(to.lat) || !Number.isFinite(to.lon)) return null;
  if (lines.length === 0) return null;

  const g = buildGraph(lines, (from.lat + to.lat) / 2);
  if (g.segs.length === 0) return null;
  // ONE index from here on. `splitAt` keeps it current, which is what lets healing
  // and both attaches see every half of every segment they have created.
  const ix = indexSegs(g);
  heal(g, ix, o.healM);

  const a = attach(g, ix, from, o.maxAttachM, o.avoidSteps);
  const b = attach(g, ix, to, o.maxAttachM, o.avoidSteps);
  if (!a || !b) return null;
  if (a.node === b.node) return null; // both ends on one spot: nothing to draw

  const path = astar(g, a.node, b.node, o.avoidSteps);
  if (!path) return null;

  // The drawn line starts under the rider and ends under the stop pin, so the two
  // stubs (rider→pavement, pavement→stop) are part of the geometry AND part of the
  // distance. They are real walking: across a forecourt, over a lawn, up a driveway.
  const coordinates: [number, number][] = [[from.lon, from.lat]];
  const pushUnique = (c: [number, number]) => {
    const last = coordinates[coordinates.length - 1];
    if (Math.abs(last[0] - c[0]) > 1e-9 || Math.abs(last[1] - c[1]) > 1e-9) coordinates.push(c);
  };
  let distanceM = a.stubM;
  for (const i of path) {
    const n = g.nodes[i];
    // Repeated vertices are dropped: the tiles carry duplicates, and a zero-length
    // segment turns into a stray bead on the map. The distance below is summed over
    // the path's own nodes, so dropping a zero-length step cannot change it.
    pushUnique([g.P.lon(n.x), g.P.lat(n.y)]);
  }
  for (let i = 1; i < path.length; i++) {
    const A = g.nodes[path[i - 1]], B = g.nodes[path[i]];
    distanceM += Math.hypot(A.x - B.x, A.y - B.y);
  }
  distanceM += b.stubM;
  pushUnique([to.lon, to.lat]);

  if (coordinates.length < 2) return null;
  const straight = haversineM(from, to);
  // BOTH conditions, and the second is what stops the guard eating honest short
  // walks. MEASURED on the fixture: a rider 30 m from the stop but on the far side of
  // Spadina Ave routes 182 m, because crossing a six-lane road means walking to the
  // light and back — ratio 6.1, and completely true. Refusing it would put a straight
  // line back through the middle of Spadina, which is the exact lie being fixed. A
  // ratio alone cannot tell that from a broken graph; a ratio plus an absolute detour
  // can, because a broken graph overshoots by kilometres, not by metres.
  if (straight > 0 && distanceM > straight * o.detourCeiling && distanceM - straight > DETOUR_FLOOR_M) {
    return null;
  }
  // A "route" materially shorter than the crow flies is arithmetically impossible and
  // means the graph lied about something; refuse rather than publish it. The 1%
  // tolerance is for the local plane's own flatness, not for slack in the claim.
  if (distanceM < straight * 0.99 - 1) return null;

  return { coordinates, distanceM: Math.round(distanceM) };
}

/** Arc-length midpoint of a drawn path — where the walker glyph belongs. */
export function pathMidpoint(coordinates: readonly (readonly [number, number])[]): [number, number] | null {
  if (coordinates.length === 0) return null;
  if (coordinates.length === 1) return [coordinates[0][0], coordinates[0][1]];
  const lat0 = coordinates[0][1];
  const P = planeAt(lat0);
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const d = Math.hypot(
      P.x(coordinates[i][0]) - P.x(coordinates[i - 1][0]),
      P.y(coordinates[i][1]) - P.y(coordinates[i - 1][1]),
    );
    seg.push(d);
    total += d;
  }
  let want = total / 2;
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i] || i === seg.length - 1) {
      const t = seg[i] === 0 ? 0 : Math.max(0, Math.min(1, want / seg[i]));
      const a = coordinates[i], b = coordinates[i + 1];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    want -= seg[i];
  }
  return [coordinates[0][0], coordinates[0][1]];
}
