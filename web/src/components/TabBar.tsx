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
  const hasAlerts = useLive((s) => s.alerts.length > 0);

  return (
    <nav className="tabbar" aria-label="Primary">
      {TABS.map(({ id, Icon, key }) => (
        <button
          key={id}
          className={`tab ${tab === id ? 'tab-active' : ''}`}
          aria-current={tab === id ? 'page' : undefined}
          onClick={() => setTab(id)}
        >
          <span className="tab-icon">
            <Icon width={22} height={22} />
            {id === 'alerts' && hasAlerts && <span className="tab-dot" aria-hidden />}
          </span>
          <span className="tab-label">{t(key)}</span>
        </button>
      ))}
    </nav>
  );
}
