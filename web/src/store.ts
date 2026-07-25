import { create } from 'zustand';
import { setLocale, type LocaleId } from './i18n';

// Everything personal lives here and in localStorage — never on the server.
export type Theme = 'system' | 'light' | 'dark';
export type Quality = 'auto' | 'full' | 'reduced' | 'lite';
export type Pace = 'slow' | 'average' | 'fast';
export type Tab = 'nearby' | 'plan' | 'saved' | 'alerts';
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
  settingsOpen: boolean;
  aboutOpen: boolean;
  searchOpen: boolean;
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
  openSearch: (v: boolean) => void;
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
  settingsOpen: false,
  aboutOpen: false,
  searchOpen: false,
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
  openSearch: (searchOpen) => set({ searchOpen }),
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
