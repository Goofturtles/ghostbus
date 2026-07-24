import { useTranslation } from 'react-i18next';
import type { StopArrivals } from '@shared/types';
import { PinIcon, HeartIcon, ChevronIcon } from './icons';
import { useStore } from '@/store';
import { fmtDistance } from '@/lib/format';

export function StopHeader({ arr, onShowMap }: { arr: StopArrivals; onShowMap?: () => void }) {
  const { t } = useTranslation();
  const saved = useStore((s) => s.savedStops.includes(arr.stopId));
  const toggleSaved = useStore((s) => s.toggleSaved);
  const units = useStore((s) => s.units);
  const walk = arr.walkMinRange;

  return (
    <div className="stop-header">
      <div className="stop-pin-tile" aria-hidden>
        <PinIcon width={20} height={20} />
      </div>
      <div className="stop-head-text">
        <h2 className="stop-name truncate balance">{arr.stopName}</h2>
        <p className="stop-sub truncate">
          <span className="stop-dir">{arr.directionLabel}</span>
          <span className="dot-sep">·</span>
          {t('stop.code', { code: arr.stopCode })}
          <span className="dot-sep">·</span>
          {t('stop.walkRange', { a: walk[0], b: walk[1] })}
          <span className="dot-sep">·</span>
          {fmtDistance(arr.distanceM, units === 'imperial')}
        </p>
      </div>
      <div className="stop-head-actions">
        <button className="icon-btn heart-btn" aria-pressed={saved} aria-label={t('stop.save')} onClick={() => toggleSaved(arr.stopId)}>
          <HeartIcon width={20} height={20} filled={saved} />
        </button>
        <button className="icon-btn pin-btn" aria-label={t('stop.showOnMap')} onClick={onShowMap}>
          <ChevronIcon width={20} height={20} />
        </button>
      </div>
    </div>
  );
}
