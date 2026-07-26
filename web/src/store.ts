import { create } from 'zustand';
import { setLocale, type LocaleId } from './i18n';
import { pushRecent, type RecentPlace } from './lib/search';

// Everything personal lives here and in localStorage — never on the server.
export type Theme = 'system' | 'light' | 'dark';
export type Quality = 'auto' | 'full' | 'reduced' | 'lite';
export type Pace = 'slow' | 'average' | 'fast';
export type Tab = 'nearby' | 'plan' | 'saved' | 'alerts';
/** What the search sheet is being opened FOR. Same UI, two destinations for the pick. */
export type SearchMode = 'stop' | 'destination';
export type AccessProfile = 'none' | 'wheelchair' | 'walker' | 'stroller' | 'lowVision' | 'slower';

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
/** Always a list of stop ids. Anything else in `gb.saved` is discarded. */
function savedIds(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
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
    const lat = num(r.lat), lon = num(r.lon);
    out.push({
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
  savedStops: string[];
  /** Stops opened from search, most recent first. Personal, so localStorage only. */
  recentStops: RecentPlace[];
  /** Destinations the rider has planned a trip to, most recent first. */
  recentTrips: RecentPlace[];
  settingsOpen: boolean;
  aboutOpen: boolean;
  /** null = closed. 'stop' searches for somewhere to open, 'destination' for
   *  somewhere to travel to — the same sheet, two jobs. */
  searchMode: SearchMode | null;
  /** The destination the Plan tab is planning to. Session-only: a stale trip
   *  restored on launch would be a plan nobody asked for. */
  planTarget: RecentPlace | null;
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
  mapExpanded: boolean;
  locale: LocaleId;

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
  toggleSaved: (id: string) => void;
  setLocaleId: (l: LocaleId) => void;
  openSettings: (v: boolean) => void;
  openAbout: (v: boolean) => void;
  openSearch: (mode: SearchMode | null) => void;
  rememberStop: (p: RecentPlace) => void;
  setPlanTarget: (p: RecentPlace | null) => void;
  setPlanUnresolved: (v: boolean) => void;
  setMapExpanded: (v: boolean) => void;
}

export const useStore = create<State>((set, get) => ({
  city: 'toronto',
  tab: 'nearby',
  selectedStopId: '4197',
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
  planTarget: null,
  planUnresolved: false,
  mapExpanded: false,
  locale: (localStorage.getItem('gb.lang') as LocaleId) || 'en',

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
  toggleSaved: (id) => {
    const cur = get().savedStops;
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
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
  setPlanTarget: (planTarget) => {
    // A new destination is a new question: nothing is known about it yet, so the previous
    // answer's geometry must not linger on the map while this one is being worked out.
    set({ planUnresolved: false });
    if (planTarget) {
      const next = pushRecent(get().recentTrips, planTarget, RECENTS_CAP);
      save('gb.trips', next);
      set({ planTarget, recentTrips: next });
    } else {
      set({ planTarget: null });
    }
  },
  setMapExpanded: (mapExpanded) => set({ mapExpanded }),
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
