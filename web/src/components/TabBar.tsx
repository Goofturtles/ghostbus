import { useTranslation } from 'react-i18next';
import { useStore, type Tab } from '@/store';
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

  return (
    <nav className="tabbar glass" aria-label={t('nav.primary')}>
      {TABS.map(({ id, Icon, key }) => (
        <button
          key={id}
          className={`tab ${tab === id ? 'tab-active' : ''}`}
          aria-current={tab === id ? 'page' : undefined}
          onClick={() => setTab(id)}
        >
          <span className="tab-icon">
            <Icon width={22} height={22} />
          </span>
          <span className="tab-label">{t(key)}</span>
        </button>
      ))}
    </nav>
  );
}
