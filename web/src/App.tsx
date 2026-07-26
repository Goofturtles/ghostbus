import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import type { DepartureDto } from '@shared/types';
import { useStore } from './store';
import { useLive } from './hooks/useLive';
import { useMedia, DESKTOP_QUERY } from './hooks/useMedia';
import { TopBar, MobileTopStrip } from './components/TopBar';
import { TabBar } from './components/TabBar';
import { NearbyPanel } from './components/NearbyPanel';
import { AlertsPanel } from './components/AlertsPanel';
import { SavedPanel } from './components/SavedPlaces';
import { SettingsSheet } from './components/SettingsSheet';
import { AboutSheet } from './components/AboutSheet';
import { CatchView } from './components/CatchView';
import { SearchSheet } from './components/SearchSheet';
import { PlanView } from './components/PlanView';
import { LayersIcon } from './components/icons';

// The real map (maplibre-gl) is code-split so it never lands in the initial JS
// budget — it loads after first paint. The styled placeholder is the fallback.
const MapCard = lazy(() => import('./map/MapCard'));

/** Styled placeholder shown while the map chunk loads (and if it fails to). */
function MapPlaceholder() {
  const { t } = useTranslation();
  return (
    <div className="map-card" role="img" aria-label={t('map.placeholderAlt')}>
      <div className="map-grid" aria-hidden />
      <div className="map-placeholder">
        <span className="map-glyph" aria-hidden><LayersIcon width={22} height={22} /></span>
        <span className="map-note">{t('map.loading')}</span>
      </div>
    </div>
  );
}

/**
 * The app-wide search shortcuts the UI advertises.
 *
 * The ⌘K hint has been painted in the top bar since Phase 3 with nothing behind it.
 * This is what makes it true, along with the spec's `/` shortcut.
 *
 * Neither fires while the rider is typing somewhere — a `/` inside a text field is a
 * slash, and stealing it would break searching for "St Clair W / Bathurst".
 */
function useSearchShortcuts(): void {
  useEffect(() => {
    const typing = (el: EventTarget | null): boolean => {
      const n = el as HTMLElement | null;
      if (!n || !n.tagName) return false;
      return n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT' || n.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      const meta = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k';
      const slash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target);
      if (!meta && !slash) return;
      // Already open: the sheet owns the keyboard from here (Esc, arrows, Enter).
      if (useStore.getState().searchMode) return;
      e.preventDefault();
      useStore.getState().openSearch('stop');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export default function App() {
  const { t } = useTranslation();
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const mapExpanded = useStore((s) => s.mapExpanded);
  const start = useLive((s) => s.start);
  const isDesktop = useMedia(DESKTOP_QUERY);

  useEffect(() => start(), [start]);
  useSearchShortcuts();

  // The departure the rider is trying to catch. Identity only — CatchView re-reads
  // the live numbers off the board on every refresh, so this never goes stale.
  const [catching, setCatching] = useState<DepartureDto | null>(null);
  // Stable so CatchView's focus-management effect never re-runs on an App render.
  const closeCatch = useCallback(() => setCatching(null), []);

  const openRoute = () => setTab('plan');

  // On the desktop split the map is the right-hand half of the app and stays
  // mounted across tab changes. On a phone it is a card inside the nearby
  // column, so it mounts and unmounts with that tab exactly as before.
  const showMap = isDesktop || tab === 'nearby';

  return (
    <div className={`app ${mapExpanded ? 'map-is-expanded' : ''}`}>
      <h1 className="sr-only">{t('brand.ghost')}{t('brand.bus')} — {t('tagline')}</h1>
      <TopBar />

      <div className="app-body">
        <MobileTopStrip />

        {showMap && (
          <div className="pane-map">
            <Suspense fallback={<MapPlaceholder />}>
              <MapCard />
            </Suspense>
          </div>
        )}

        <div className="pane-side">
          <main className="side-scroll" aria-label={t(`nav.${tab}`)}>
            <div className="side-inner">
              {tab === 'nearby' && (
                <div className="reveal">
                  <NearbyPanel onOpen={openRoute} onCatch={setCatching} />
                </div>
              )}
              {tab === 'plan' && (
                <div className="reveal"><PlanView /></div>
              )}
              {tab === 'saved' && (
                <div className="reveal"><SavedPanel /></div>
              )}
              {tab === 'alerts' && (
                <div className="reveal">
                  <AlertsPanel />
                </div>
              )}
            </div>
          </main>
        </div>
      </div>

      <TabBar />
      <SearchSheet />
      <SettingsSheet />
      <AboutSheet />
      {catching && <CatchView dep={catching} onClose={closeCatch} />}
    </div>
  );
}
