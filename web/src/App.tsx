import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from './store';
import { useLive } from './hooks/useLive';
import { TopBar, MobileTopStrip } from './components/TopBar';
import { TabBar } from './components/TabBar';
import { NearbyPanel } from './components/NearbyPanel';
import { SettingsSheet } from './components/SettingsSheet';
import { RouteIcon, BookmarkIcon, BellIcon, LayersIcon } from './components/icons';

/** Honest map placeholder — Phase 4 fills this slot. Calm, not apologetic. */
function MapCard() {
  const { t } = useTranslation();
  return (
    <div className="map-card" role="img" aria-label={t('map.placeholderAlt')}>
      <div className="map-grid" aria-hidden />
      <div className="map-placeholder">
        <span className="map-glyph" aria-hidden><LayersIcon width={22} height={22} /></span>
        <span className="map-note">{t('map.placeholder')}</span>
      </div>
    </div>
  );
}

/** Designed, honest placeholder for tabs that are designed but not yet built. */
function PlaceholderView({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="placeholder-view">
      <div className="state-card state-placeholder" role="status">
        <div className="state-glyph" aria-hidden>{icon}</div>
        <h2 className="state-title">{title}</h2>
        <p className="state-body">{body}</p>
      </div>
    </div>
  );
}

export default function App() {
  const { t } = useTranslation();
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const start = useLive((s) => s.start);

  useEffect(() => start(), [start]);

  const openRoute = () => setTab('plan');

  return (
    <div className="app">
      <h1 className="sr-only">{t('brand.ghost')}{t('brand.bus')} — {t('tagline')}</h1>
      <div className="only-desktop"><TopBar /></div>
      <div className="only-mobile"><MobileTopStrip /></div>

      <main className="app-main scroll" aria-label={t(`nav.${tab}`)}>
        <div className="app-col">
          {tab === 'nearby' && (
            <div className="reveal">
              <MapCard />
              <div className="sheet">
                <NearbyPanel onOpen={openRoute} />
              </div>
            </div>
          )}
          {tab === 'plan' && (
            <PlaceholderView icon={<RouteIcon width={26} height={26} />} title={t('plan.title')} body={t('plan.body')} />
          )}
          {tab === 'saved' && (
            <PlaceholderView icon={<BookmarkIcon width={26} height={26} />} title={t('saved.title')} body={t('saved.body')} />
          )}
          {tab === 'alerts' && (
            <PlaceholderView icon={<BellIcon width={26} height={26} />} title={t('alerts.title')} body={t('alerts.body')} />
          )}
        </div>
      </main>

      <TabBar />
      <SettingsSheet />
    </div>
  );
}
