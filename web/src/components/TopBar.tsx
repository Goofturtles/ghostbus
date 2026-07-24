import { useTranslation } from 'react-i18next';
import { Wordmark, StatusPill } from './Primitives';
import { SearchIcon, SlidersIcon, PersonIcon } from './icons';
import { useStore } from '@/store';

/** Presentational search field. Non-functional this phase (Plan/search lands
 *  later) — hidden from assistive tech so it never reads as a live control. */
export function SearchField({ variant }: { variant: 'bar' | 'mobile' }) {
  const { t } = useTranslation();
  return (
    <div className={`searchfield sf-${variant}`} aria-hidden="true">
      <div className="searchfield-input">
        <SearchIcon width={18} height={18} />
        <span className="sf-placeholder truncate">{t('search.placeholder')}</span>
        {variant === 'bar' && <kbd className="sf-kbd">{t('search.hint')}</kbd>}
      </div>
      {variant === 'mobile' && (
        <div className="sf-filters">
          <SlidersIcon width={20} height={20} />
        </div>
      )}
    </div>
  );
}

export function ProfileButton() {
  const { t } = useTranslation();
  const openSettings = useStore((s) => s.openSettings);
  return (
    <button className="profile-btn" aria-label={t('a11y.profile')} onClick={() => openSettings(true)}>
      <PersonIcon width={19} height={19} />
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
