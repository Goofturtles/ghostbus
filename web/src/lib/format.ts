// Locale-correct formatting via Intl. Times display in the agency's local zone
// (the rider is physically there); numbers + distances follow the UI locale.
import i18n from '@/i18n';

const AGENCY_TZ = 'America/Toronto';

export function fmtClock(ms: number, tz = AGENCY_TZ): string {
  return new Intl.DateTimeFormat(i18n.language, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz,
  }).format(new Date(ms));
}

/** A weekday + date label in the agency zone, e.g. "Fri, Jul 31" — used to
 *  stamp the date once on the "next scheduled service" section header. */
export function fmtServiceDate(ms: number, tz = AGENCY_TZ): string {
  return new Intl.DateTimeFormat(i18n.language, {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: tz,
  }).format(new Date(ms));
}

export function fmtNum(n: number): string {
  return new Intl.NumberFormat(i18n.language).format(n);
}

/** Distance formatting, honoring metric/imperial preference. */
export function fmtDistance(metres: number, imperial: boolean): string {
  const t = i18n.getFixedT(i18n.language, 'translation', 'units');
  if (imperial) {
    const ft = metres * 3.28084;
    if (ft < 1000) return t('ft', { v: Math.round(ft / 10) * 10 });
    return t('mi', { v: (ft / 5280).toFixed(1) });
  }
  if (metres < 1000) return t('m', { v: Math.round(metres / 10) * 10 });
  return t('km', { v: (metres / 1000).toFixed(1) });
}

/** Minutes-until label: "Now" under a minute, else the integer. */
export function etaLabel(etaMin: number): string {
  const t = i18n.getFixedT(i18n.language, 'translation', 'row');
  if (etaMin <= 0) return t('now');
  return String(Math.round(etaMin));
}

export function relSeconds(ms: number, now: number): number {
  return Math.max(0, Math.round((now - ms) / 1000));
}

// The walk maths moved to lib/walk.ts so it can be unit-tested without dragging
// the i18n runtime (and the DOM) into a Node test. Re-exported here because it is
// where the rest of the app has always imported it from.
export { walkSeconds } from './walk';
