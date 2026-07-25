import { useTranslation } from 'react-i18next';
import { useStore, type Tab } from '@/store';
import { useLive } from '@/hooks/useLive';
import { PinIcon, RouteIcon, BookmarkIcon, BellIcon } from './icons';

const TABS: { id: Tab; Icon: typeof PinIcon; key: string }[] = [
  { id: 'nearby', Icon: PinIcon, key: 'nav.nearby' },
  { id: 'plan', Icon: RouteIcon, key: 'nav.plan' },
  { id: 'saved', Icon: BookmarkIcon, key: 'nav.saved' },
  { id: 'alerts', Icon: BellIcon, key: 'nav.alerts' },
];

export function TabBar() {
  const { t } = useTranslation();
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  // A real dot for real alerts: it appears only when the agency currently has active
  // alerts published, and disappears the moment the feed stops carrying them.
  const alertCount = useLive((s) => s.alerts?.count ?? 0);

  return (
    // Deliberately not `.glass`: the bar is opaque so the scrolling column can be
    // clipped cleanly above it, and a backdrop-filter under an opaque background
    // is a compositing layer that buys nothing.
    <nav className="tabbar" aria-label={t('nav.primary')}>
      {TABS.map(({ id, Icon, key }) => {
        const dot = id === 'alerts' && alertCount > 0;
        return (
          <button
            key={id}
            className={`tab ${tab === id ? 'tab-active' : ''}`}
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => setTab(id)}
          >
            <span className="tab-icon">
              <Icon width={22} height={22} />
              {dot && <span className="tab-dot" aria-hidden />}
            </span>
            <span className="tab-label">{t(key)}</span>
          </button>
        );
      })}
    </nav>
  );
}
