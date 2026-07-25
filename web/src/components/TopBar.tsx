import { useTranslation } from 'react-i18next';
import { Wordmark, StatusPill } from './Primitives';
import { SearchIcon, SlidersIcon, PersonIcon } from './icons';
import { useStore } from '@/store';

/** Presentational search field. Non-functional this phase (Plan/search lands
 *  later) — hidden from assistive tech so it never reads as a live control. */
function SearchDisplay({ hint }: { hint?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="searchfield-input" aria-hidden="true">
      <SearchIcon width={18} height={18} />
      <span className="sf-placeholder truncate">{t('search.placeholder')}</span>
      {hint && <kbd className="sf-kbd">{t('search.hint')}</kbd>}
    </div>
  );
}

export function ProfileButton({ glyph = 'person' }: { glyph?: 'person' | 'sliders' }) {
  const { t } = useTranslation();
  const openSettings = useStore((s) => s.openSettings);
  return (
    <button
      className={glyph === 'person' ? 'profile-btn' : 'sf-filters'}
      aria-label={t('a11y.profile')}
      onClick={() => openSettings(true)}
    >
      {glyph === 'person' ? <PersonIcon width={19} height={19} /> : <SlidersIcon width={20} height={20} />}
    </button>
  );
}

/**
 * Desktop / tablet top bar — the window chrome IS the app bar, exactly as the
 * reference draws it: wordmark left, the search pill centred in the WINDOW (not
 * in the space left over), status + avatar right.
 *
 * The dots are the reference's macOS traffic lights. They are decoration, not
 * controls: no button element, no handler, aria-hidden, so nothing here can be
 * mistaken for a window close that does not exist.
 */
export function TopBar() {
  return (
    <header className="topbar only-desktop">
      <div className="topbar-left">
        <span className="win-dots" aria-hidden>
          <i className="win-dot wd-red" /><i className="win-dot wd-amber" /><i className="win-dot wd-green" />
        </span>
        <Wordmark />
      </div>
      <div className="topbar-center">
        <div className="searchfield sf-bar">
          <SearchDisplay hint />
        </div>
      </div>
      <div className="topbar-right">
        <StatusPill />
        <ProfileButton />
      </div>
    </header>
  );
}

/** Phone header — wordmark + live pill on one row, then the search row with the
 *  square button beside it, per both phones in the reference. */
export function MobileTopStrip() {
  return (
    <header className="mobile-top only-mobile">
      <div className="mobile-top-row">
        <Wordmark />
        <StatusPill compact />
      </div>
      <div className="searchfield sf-mobile">
        <SearchDisplay />
        <ProfileButton glyph="sliders" />
      </div>
    </header>
  );
}
