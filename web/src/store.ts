import { create } from 'zustand';
import { setLocale, type LocaleId } from './i18n';
import { pushRecent, type RecentPlace } from './lib/search';
import { HERE, swapEnds, type PlanPoint } from './lib/planpoint';
import type { MeasuredWalk } from './lib/walk';
import type { Journey } from './lib/journey';

// Everything personal lives here and in localStorage — never on the server.
export type Theme = 'system' | 'light' | 'dark';
export type Quality = 'auto' | 'full' | 'reduced' | 'lite';
export type Pace = 'slow' | 'average' | 'fast';
/**
 * THE NEARBY TAB IS GONE, and with it the stop-board-first home.
 *
 * It was a feed of "buses near you", which is a list nobody opens an app to read: a rider
 * standing somewhere already knows what is around them, and what they actually want is to
 * get somewhere. So the home is now the map plus the journey planner, and a stop board is
 * reached the way a map makes you reach one — by tapping a stop, or by searching it. That
 * is an interaction, not a feed, and `stopSheet` below is where it lands.
 *
 * `plan` is first, and is the tab a cold start opens on.
 */
export type Tab = 'plan' | 'saved' | 'alerts';
/** What the search sheet is being opened FOR. Same UI, two destinations for the pick. */
export type SearchMode = 'stop' | 'destination' | 'origin';
export type AccessProfile = 'none' | 'wheelchair' | 'walker' | 'stroller' | 'lowVision' | 'slower';
/** Which end of the trip a map pick is being made for. */
export type MapPickTarget = 'origin' | 'dest';
/**
 * A point the rider chose ON THE MAP, and the label the map could honestly put on it.
 *
 * `label` is never invented. It is, in order of preference, a real agency stop name, a
 * named place the vector tiles actually carry, the street the pin landed on, or — when
 * the map knows nothing about that spot — the coordinates themselves. There is no
 * geocoder behind this and nothing here pretends there is.
 */
export interface MapPickPlace { lat: number; lon: number; label: string }

const PACE_MPS: Record<Pace, number> = { slow: 3.6 / 3.6, average: 4.8 / 3.6, fast: 6 / 3.6 };
/** Always a usable speed. `pace` is restored from localStorage, which anything can
 *  write, and a corrupt value must not silently become a zero-second walk. */
export const paceMps = (p: Pace) => PACE_MPS[p] ?? PACE_MPS.average;

function ls<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
/**
 * A saved stop, identified by the PAIR. See the migration note below.
 */
export interface SavedStop { agency: string; stopId: string }

/**
 * Always a list of real saved stops. Anything else in `gb.saved` is discarded.
 *
 * MULTI-AGENCY MIGRATION. This used to be a list of bare stop id strings, and those are
 * now ambiguous — 2,824 stop_ids are shared between the TTC and YRT alone. A bare string
 * is therefore DROPPED rather than assumed to be the TTC, for the same reason the recents
 * sanitiser drops one: silently re-pointing somebody's saved stop at a different city's
 * platform is worse than forgetting it.
 */
function savedIds(v: unknown): SavedStop[] {
  if (!Array.isArray(v)) return [];
  const out: SavedStop[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.agency !== 'string' || r.agency === '') continue;
    if (typeof r.stopId !== 'string' || r.stopId === '') continue;
    out.push({ agency: r.agency, stopId: r.stopId });
  }
  return out;
}
/** Identity of a saved stop is the pair, never the id alone. */
export const sameStop = (a: SavedStop, b: SavedStop): boolean =>
  a.agency === b.agency && a.stopId === b.stopId;
/** Always a list of real places. localStorage is writable by anything, and these
 *  rows are rendered — and, for a trip, fed straight into the planner as coordinates
 *  — on first paint, so every field is checked rather than trusted. */
function recentPlaces(v: unknown): RecentPlace[] {
  if (!Array.isArray(v)) return [];
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const out: RecentPlace[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.stopId !== 'string' || typeof r.name !== 'string') continue;
    /**
     * MULTI-AGENCY MIGRATION. Rows written before the agency seam reached the wire carry
     * a bare stopId and no agency. That id is now AMBIGUOUS — 2,824 stop_ids are shared
     * between the TTC and YRT alone, so "guess the TTC" would silently re-point somebody's
     * saved stop at a different city's platform. There is no honest default, so an entry
     * without an agency is DROPPED. The cost is one forgotten recent; the alternative is a
     * remembered place that quietly becomes the wrong place.
     */
    if (typeof r.agency !== 'string' || r.agency === '') continue;
    const lat = num(r.lat), lon = num(r.lon);
    out.push({
      agency: r.agency,
      stopId: r.stopId,
      name: r.name,
      // A half-known position is no position: the planner must never be handed one.
      lat: lat != null && lon != null && lat >= -90 && lat <= 90 ? lat : null,
      lon: lat != null && lon != null && lon >= -180 && lon <= 180 ? lon : null,
      ts: num(r.ts) ?? 0,
    });
  }
  return out.slice(0, RECENTS_CAP);
}
const RECENTS_CAP = 8;
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage may be unavailable; personal prefs are best-effort */
  }
}

interface State {
  city: string;
  tab: Tab;
  selectedStopId: string;
  routeFocusId: string | null;
  theme: Theme;
  quality: Quality;
  units: 'metric' | 'imperial';
  pace: Pace;
  access: AccessProfile;
  hideInaccessible: boolean;
  largerText: boolean;
  highContrast: boolean;
  voice: boolean;
  savedStops: SavedStop[];
  /** Stops opened from search, most recent first. Personal, so localStorage only. */
  recentStops: RecentPlace[];
  /** Destinations the rider has planned a trip to, most recent first. */
  recentTrips: RecentPlace[];
  settingsOpen: boolean;
  aboutOpen: boolean;
  /** null = closed. 'stop' searches for somewhere to open, 'destination' for
   *  somewhere to travel to — the same sheet, two jobs. */
  searchMode: SearchMode | null;
  /**
   * WHERE THE TRIP STARTS. Defaults to `here` — the rider's live fix — which is what it
   * always silently was; the difference is that it is now a value the rider can change
   * rather than an assumption baked into a label.
   *
   * Session-only, like the target. A persisted origin is a claim about where somebody is
   * that survives them going somewhere else.
   */
  planOrigin: PlanPoint;
  /** The destination the Plan tab is planning to. Session-only: a stale trip
   *  restored on launch would be a plan nobody asked for. */
  planTarget: PlanPoint | null;
  /**
   * A DESTINATION IS ON SCREEN AND THE PLANNER COULD NOT ANSWER IT — transfer needed, no
   * service in range, or no stop near an end. The map reads this and draws NO walk
   * geometry at all while it holds.
   *
   * A beaded walk path is a claim ("you can walk this"), and beside the words "this trip
   * needs a transfer" any route-like line reads as the answer the app just said it does
   * not have. Worse, the line that survived was the PREVIOUS plan's first leg — geometry
   * belonging to a different journey, still drawn under the failure of this one.
   *
   * So the failed state renders an absence, which claims nothing. Session-only, like
   * `planTarget` itself. See DECISIONS §45.
   */
  planUnresolved: boolean;
  /**
   * THE WALK THE MAP IS ACTUALLY DRAWING, so that every number describing it agrees
   * with the line under it.
   *
   * The map routes the rider's walk to the boarding stop over the street geometry in
   * its own tiles (see map/walkPath.ts) and publishes the result here. `stopId` is
   * how a consumer knows the walk is theirs: a header, a departure row's leave-by and
   * a plan's first leg all read it, and all ignore it unless it ends at the stop they
   * are describing. Anything else keeps the straight-line estimate and says so.
   *
   * `kind: 'direct'` means the map could not find a walkable line and is drawing the
   * straight one — still published, because a consumer must be able to tell an
   * estimate from a measurement, and silence would look like a measurement.
   *
   * Null whenever no walk is drawn at all, which includes every state the plan-
   * geometry machine calls unresolved. Session-only: a walk restored from storage
   * would be a claim about a rider who has since moved.
   */
  walkLeg: MeasuredWalk | null;
  mapExpanded: boolean;
  locale: LocaleId;
  /**
   * THE STOP BOARD, as a surface you open rather than a feed you are handed.
   *
   * True while the board for `selectedStopId` is on screen. Opened by tapping a stop on
   * the map or picking one out of search — the two ways a rider actually asks for a
   * specific stop. Session-only: a board restored on launch would be a stop nobody asked
   * about, which is the thing the Nearby tab was doing wrong.
   */
  stopSheet: boolean;
  /**
   * THE JOURNEY THE RIDER PRESSED GO ON, or null.
   *
   * Frozen at the moment they committed: the steps, their instants, and the option's own
   * evidence. It is deliberately NOT re-planned underneath them — a journey that silently
   * swapped itself for a better one mid-walk would be answering a question nobody asked
   * twice. What IS live is the layer on top: the catch verdict, the boarding stop's live
   * board, and the clock. Session-only, for the same reason `planTarget` is.
   */
  journey: Journey | null;
  /**
   * CHOOSE ON MAP. Non-null while the map is in pick mode, and `target` says which end
   * of the trip the pick is for. Session-only, and deliberately a single slot: a rider
   * is picking one point at a time, and a second `beginMapPick` replaces the first
   * rather than stacking a second crosshair on the map.
   *
   * The map owns the interaction (crosshair, fine-drag, the context chip); this is only
   * the intent, so the plan surface and the map agree on what the pick is FOR without
   * either of them reaching into the other.
   */
  mapPick: { target: MapPickTarget } | null;

  setTab: (t: Tab) => void;
  selectStop: (id: string) => void;
  focusRoute: (id: string | null) => void;
  setTheme: (t: Theme) => void;
  setQuality: (q: Quality) => void;
  setUnits: (u: 'metric' | 'imperial') => void;
  setPace: (p: Pace) => void;
  setAccess: (a: AccessProfile) => void;
  toggleHideInaccessible: () => void;
  setLargerText: (v: boolean) => void;
  setHighContrast: (v: boolean) => void;
  setVoice: (v: boolean) => void;
  toggleSaved: (stop: SavedStop) => void;
  setLocaleId: (l: LocaleId) => void;
  openSettings: (v: boolean) => void;
  openAbout: (v: boolean) => void;
  openSearch: (mode: SearchMode | null) => void;
  rememberStop: (p: RecentPlace) => void;
  setPlanTarget: (p: PlanPoint | null) => void;
  setPlanOrigin: (p: PlanPoint) => void;
  /** Reverse the two ends. No-op with no destination chosen — see `swapEnds`. */
  swapPlanEnds: () => void;
  setPlanUnresolved: (v: boolean) => void;
  setWalkLeg: (v: MeasuredWalk | null) => void;
  setMapExpanded: (v: boolean) => void;
  openStopSheet: (v: boolean) => void;
  startJourney: (j: Journey) => void;
  endJourney: () => void;
  beginMapPick: (target: MapPickTarget) => void;
  cancelMapPick: () => void;
  completeMapPick: (place: MapPickPlace) => void;
}

export const useStore = create<State>((set, get) => ({
  city: 'toronto',
  tab: 'plan',
  /**
   * NO STOP IS SELECTED AT COLD START, and the empty string is the honest value.
   *
   * This seeded `'4197'` — the stop id in the design mockup (`voxelLab.ts`), which is
   * not a TTC stop. Every cold boot therefore fired `GET /api/stops/4197/arrivals`,
   * got a 404, and `useLive` classified that as `badRequest` and raised `apiFailure` —
   * so the very first thing a rider saw, on every single load, was the panel claiming
   * our server was in trouble. Out of coverage it fired twice and nothing ever
   * displaced it. Measured by the R4 console sweep: the 404 fired on 10 of 10 cold
   * loads, plus an 11th firing when entering Plan while out of coverage.
   *
   * The selection is made by `loadNearby`, which picks the nearest real stop the
   * agency actually returned. Until that resolves there is genuinely no stop, and the
   * app already handles that state: `refetchArrivals` returns early on a falsy id, so
   * no request is made for a stop nobody chose, and `StopBoardSheet` shows its skeleton
   * off the absence of a board rather than off a board that was never requested.
   */
  selectedStopId: '',
  routeFocusId: null,
  theme: ls<Theme>('gb.theme', 'system'),
  quality: ls<Quality>('gb.quality', 'auto'),
  units: ls<'metric' | 'imperial'>('gb.units', 'metric'),
  pace: ls<Pace>('gb.pace', 'average'),
  access: ls<AccessProfile>('gb.access', 'none'),
  hideInaccessible: ls('gb.hideInacc', false),
  largerText: ls('gb.largerText', false),
  highContrast: ls('gb.highContrast', false),
  voice: ls('gb.voice', false),
  // No seed. Saved Places is a list of stops the rider actually starred; a
  // pre-filled 'union' made the section look populated on a device that had
  // saved nothing, which is exactly the kind of decorative fiction this app
  // does not ship. Empty means empty, and the UI says so.
  // Sanitised for the same reason `pace` is: localStorage is writable by anything,
  // and Saved Places now maps over this array on first paint.
  savedStops: savedIds(ls<unknown>('gb.saved', [])),
  recentStops: recentPlaces(ls<unknown>('gb.recents', [])),
  recentTrips: recentPlaces(ls<unknown>('gb.trips', [])),
  settingsOpen: false,
  aboutOpen: false,
  searchMode: null,
  planOrigin: HERE,
  planTarget: null,
  planUnresolved: false,
  walkLeg: null,
  mapExpanded: false,
  locale: (localStorage.getItem('gb.lang') as LocaleId) || 'en',
  stopSheet: false,
  journey: null,
  mapPick: null,

  setTab: (tab) => set({ tab }),
  selectStop: (selectedStopId) => set({ selectedStopId }),
  focusRoute: (routeFocusId) => set({ routeFocusId }),
  setTheme: (theme) => { save('gb.theme', theme); set({ theme }); applyTheme(theme); },
  setQuality: (quality) => { save('gb.quality', quality); set({ quality }); },
  setUnits: (units) => { save('gb.units', units); set({ units }); },
  setPace: (pace) => { save('gb.pace', pace); set({ pace }); },
  setAccess: (access) => { save('gb.access', access); set({ access }); },
  toggleHideInaccessible: () => { const v = !get().hideInaccessible; save('gb.hideInacc', v); set({ hideInaccessible: v }); },
  setLargerText: (v) => { save('gb.largerText', v); set({ largerText: v }); applyTextSize(v); },
  setHighContrast: (v) => { save('gb.highContrast', v); set({ highContrast: v }); applyContrast(v); },
  setVoice: (v) => { save('gb.voice', v); set({ voice: v }); },
  toggleSaved: (stop) => {
    const cur = get().savedStops;
    const next = cur.some((x) => sameStop(x, stop))
      ? cur.filter((x) => !sameStop(x, stop))
      : [...cur, stop];
    save('gb.saved', next);
    set({ savedStops: next });
  },
  setLocaleId: (l) => { setLocale(l); set({ locale: l }); },
  openSettings: (settingsOpen) => set({ settingsOpen }),
  // About replaces Settings rather than stacking on it: two modals deep is two
  // focus traps deep, and there is nothing on this path that needs both open.
  openAbout: (aboutOpen) => set({ aboutOpen, settingsOpen: aboutOpen ? false : get().settingsOpen }),
  // Search replaces the other sheets for the same reason About replaces Settings:
  // two focus traps deep is a keyboard dead end, and nothing here needs both.
  openSearch: (searchMode) => set(
    searchMode ? { searchMode, settingsOpen: false, aboutOpen: false } : { searchMode: null },
  ),
  rememberStop: (p) => {
    const next = pushRecent(get().recentStops, p, RECENTS_CAP);
    save('gb.recents', next);
    set({ recentStops: next });
  },
  setPlanUnresolved: (planUnresolved) => set({ planUnresolved }),
  // Identity-stable: the map republishes on every camera settle, and a fresh object
  // each time would re-render every leave-by chip on the board for no new fact.
  setWalkLeg: (walkLeg) => {
    const cur = get().walkLeg;
    if (cur === walkLeg) return;
    if (cur && walkLeg && cur.stopId === walkLeg.stopId && cur.kind === walkLeg.kind
      && cur.distanceM === walkLeg.distanceM && cur.seconds === walkLeg.seconds) return;
    set({ walkLeg });
  },
  setPlanTarget: (planTarget) => {
    // A new destination is a new question: nothing is known about it yet, so the previous
    // answer's geometry must not linger on the map while this one is being worked out.
    set({ planUnresolved: false });
    set({ planTarget });
    // ONLY A REAL STOP IS REMEMBERED. `here` has no identity to store, and a map `pin`
    // has no agency and no stop id — writing either to the persisted trips list would
    // put a row there that `recentPlaces` discards on the next boot, so the rider would
    // watch their recents silently fail to remember what they just did.
    if (planTarget?.kind === 'stop') {
      const next = pushRecent(get().recentTrips, planTarget.place, RECENTS_CAP);
      save('gb.trips', next);
      set({ recentTrips: next });
    }
  },
  setPlanOrigin: (planOrigin) => set({ planOrigin, planUnresolved: false }),
  swapPlanEnds: () => {
    const { planOrigin, planTarget } = get();
    // Reversing the question invalidates the answer AND the geometry drawn for it, the
    // same way picking a new destination does.
    set({ ...swapEnds(planOrigin, planTarget), planUnresolved: false });
  },
  setMapExpanded: (mapExpanded) => set({ mapExpanded }),
  // The board replaces the other sheets for the same reason About replaces Settings and
  // Search replaces both: two focus traps deep is a keyboard dead end.
  openStopSheet: (stopSheet) => set(
    stopSheet ? { stopSheet, settingsOpen: false, aboutOpen: false, searchMode: null } : { stopSheet: false },
  ),
  /**
   * Committing to a journey takes the whole screen, so it closes everything that could sit
   * on top of it. Nothing else about the plan is disturbed: `planTarget` stays, so exiting
   * returns the rider to the same menu of options they chose from rather than to a blank
   * planner asking them where they are going all over again.
   */
  startJourney: (journey) => set({
    journey, stopSheet: false, settingsOpen: false, aboutOpen: false, searchMode: null,
  }),
  endJourney: () => set({ journey: null }),

  /**
   * CHOOSE ON MAP — the three actions the map and the plan surface share.
   *
   * Picking takes the map, so it closes every sheet that could sit on top of it, for
   * the same reason `startJourney` does: a crosshair the rider cannot see is not a
   * crosshair. Nothing else about the plan is disturbed — the destination they already
   * had stays, so cancelling returns them to exactly the planner they left.
   */
  beginMapPick: (target) => set({
    mapPick: { target },
    stopSheet: false, settingsOpen: false, aboutOpen: false, searchMode: null,
  }),
  cancelMapPick: () => set({ mapPick: null }),
  /**
   * The pick is finished. Pick mode ends here, and that is ALL this does today.
   *
   * TODO(plan-ui): the plan surface owns where a completed pick lands. Route `place`
   * into `planOrigin` / `planTarget` off `get().mapPick?.target` here — this action is
   * the agreed seam, and the map already calls it with a real coordinate and an honest
   * label (see `MapPickPlace`). Deliberately NOT routed through `setPlanTarget` in the
   * meantime: that pushes a `RecentPlace` onto the persisted trips list, and a
   * map-picked point has no agency and no stop id, so every such row would be written
   * to localStorage only to be discarded by `recentPlaces` on the next boot.
   *
   * Until that lands the map shows the confirmed point itself, so the flow is real and
   * demoable end to end without this store guessing at fields it does not own.
   */
  completeMapPick: (_place) => set({ mapPick: null }),
}));

// ---- side effects that touch <html> ----
export function resolveTheme(t: Theme): 'light' | 'dark' {
  if (t === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return t;
}
export function applyTheme(t: Theme) {
  document.documentElement.setAttribute('data-theme', resolveTheme(t));
}
export function applyTextSize(large: boolean) {
  if (large) document.documentElement.setAttribute('data-textsize', 'large');
  else document.documentElement.removeAttribute('data-textsize');
}
export function applyContrast(high: boolean) {
  if (high) document.documentElement.setAttribute('data-contrast', 'high');
  else document.documentElement.removeAttribute('data-contrast');
}

// initialize on load
export function initClientState() {
  const s = useStore.getState();
  applyTheme(s.theme);
  applyTextSize(s.largerText);
  applyContrast(s.highContrast);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (useStore.getState().theme === 'system') applyTheme('system');
  });
}
