import { useTranslation } from 'react-i18next';
import { HomeIcon, PinIcon, HeartIcon } from './icons';
import { useStore } from '@/store';

interface SavedEntry {
  id: string;
  name: string;
  context: string; // live context line, e.g. "510 Spadina · 9 min"
  home?: boolean;
}

// Live context comes from the same arrivals pipeline; demo values shown here.
const ENTRIES: SavedEntry[] = [
  { id: 'home', name: 'Home', context: '12 min walk', home: true },
  { id: 'union', name: 'Union Station', context: '510 Spadina · 9 min' },
];

export function SavedPlaces({ onViewAll }: { onViewAll?: () => void }) {
  const { t } = useTranslation();
  const saved = useStore((s) => s.savedStops);

  return (
    <section className="saved-section" aria-label={t('sections.savedPlaces')}>
      <div className="section-head">
        <span className="eyebrow">{t('sections.savedPlaces')}</span>
        <button className="link-btn" onClick={onViewAll}>{t('sections.viewAll')}</button>
      </div>
      <div className="saved-list">
        {ENTRIES.map((e) => (
          <button key={e.id} className="saved-row" onClick={onViewAll}>
            <span className="saved-glyph" aria-hidden>
              {e.home ? <HomeIcon width={18} height={18} /> : <PinIcon width={18} height={18} />}
            </span>
            <span className="saved-text">
              <span className="saved-name truncate">{e.home ? t('saved.home') : e.name}</span>
              <span className="saved-context truncate">{e.context}</span>
            </span>
            <span className={`saved-star ${saved.includes(e.id) ? 'on' : ''}`} aria-hidden>
              <HeartIcon width={16} height={16} filled={saved.includes(e.id)} />
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
