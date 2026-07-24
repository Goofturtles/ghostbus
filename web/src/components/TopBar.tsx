import { useTranslation } from 'react-i18next';
import { Wordmark, StatusPill } from './Primitives';
import { SearchIcon, SlidersIcon } from './icons';
import { useStore } from '@/store';

export function SearchField({ variant }: { variant: 'bar' | 'mobile' }) {
  const { t } = useTranslation();
  const openSearch = useStore((s) => s.openSearch);
  return (
    <div className={`searchfield sf-${variant}`}>
      <button className="searchfield-input" onClick={() => openSearch(true)} aria-label={t('search.placeholder')}>
        <SearchIcon width={18} height={18} />
        <span className="sf-placeholder truncate">{t('search.placeholder')}</span>
        {variant === 'bar' && <kbd className="sf-kbd">{t('search.hint')}</kbd>}
      </button>
      {variant === 'mobile' && (
        <button className="sf-filters" aria-label={t('search.filters')} onClick={() => openSearch(true)}>
          <SlidersIcon width={20} height={20} />
        </button>
      )}
    </div>
  );
}

export function ProfileButton() {
  const { t } = useTranslation();
  const openSettings = useStore((s) => s.openSettings);
  return (
    <button className="profile-btn" aria-label={t('a11y.profile')} onClick={() => openSettings(true)}>
      <span className="profile-glyph" aria-hidden>A</span>
    </button>
  );
}

/** Desktop / tablet top bar — the window chrome IS the app bar. */
export function TopBar() {
  return (
    <header className="topbar glass">
      <div className="topbar-left">
        <Wordmark />
      </div>
      <div className="topbar-center">
        <SearchField variant="bar" />
      </div>
      <div className="topbar-right">
        <StatusPill />
        <ProfileButton />
      </div>
    </header>
  );
}

/** Mobile top strip — wordmark + live pill, then a full-width search below. */
export function MobileTopStrip() {
  return (
    <header className="mobile-top">
      <div className="mobile-top-row">
        <Wordmark />
        <div className="mobile-top-right">
          <StatusPill compact />
          <ProfileButton />
        </div>
      </div>
      <SearchField variant="mobile" />
    </header>
  );
}
