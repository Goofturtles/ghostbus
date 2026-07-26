import { useTranslation } from 'react-i18next';
import { Wordmark, StatusPill } from './Primitives';
import { SearchIcon, SlidersIcon, PersonIcon } from './icons';
import { useStore } from '@/store';

/**
 * The search trigger.
 *
 * It was a `<div aria-hidden="true">` with a fake placeholder inside it — a control
 * that looked live and did nothing, which is the exact class of dishonesty this app
 * argues against. It is a real button now: it opens the real search sheet, it carries
 * its own accessible name, and the ⌘K hint it renders is a shortcut that genuinely
 * works (see the global key handler in App.tsx).
 *
 * The field itself lives in the sheet rather than here so there is ONE input, one
 * focus trap and one listbox at every breakpoint, instead of a phone copy and a
 * desktop copy that can drift apart.
 */
function SearchTrigger({ hint }: { hint?: boolean }) {
  const { t } = useTranslation();
  const openSearch = useStore((s) => s.openSearch);
  return (
    <button
      className="searchfield-input searchfield-trigger"
      aria-haspopup="dialog"
      aria-label={t('search.open')}
      onClick={() => openSearch('stop')}
    >
      <SearchIcon width={18} height={18} aria-hidden />
      <span className="sf-placeholder truncate">{t('search.placeholder')}</span>
      {hint && <kbd className="sf-kbd" aria-hidden>{t('search.hint')}</kbd>}
    </button>
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
          <SearchTrigger hint />
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
        <SearchTrigger />
        <ProfileButton glyph="sliders" />
      </div>
    </header>
  );
}
