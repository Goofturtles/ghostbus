import { useTranslation } from 'react-i18next';
import type { ArrivalsResponse } from '@shared/types';
import { PinIcon, HeartIcon, StarIcon } from './icons';
import { StopRoutes } from './Primitives';
import { useStore, paceMps } from '@/store';
import { fmtDistance } from '@/lib/format';
import { walkFor, walkMinutes } from '@/lib/walk';
import { stopDirection } from '@/lib/headsign';

/**
 * The reference's CURRENT STOP block. One component, two shapes:
 *  - desktop: a card on the sidebar — purple pin tile, two text lines, outline heart.
 *  - phone: a bare header on the sheet — title, sub-line, ringed star button.
 * The two glyphs are both rendered inside the SAME button and swapped by CSS, so
 * the save control is one control to a screen reader at every width.
 *
 * The sub-line leads with the direction in the accent colour, as the reference
 * does — which side of the street this is, is the first thing a rider checks. It
 * is read out of the agency's own headsigns (see lib/headsign.ts) and printed ONLY
 * when every departure on this board agrees on one cardinal. A stop that serves
 * both directions has no single direction, so the word is omitted rather than
 * guessed: sending someone to the wrong side of King St is not a cosmetic error.
 */
export function StopHeader({ arr, distanceM, headsigns }: {
  arr: ArrivalsResponse;
  distanceM?: number;
  /** Headsigns to read the stop's direction out of. Defaults to this board's own
   *  departures; Nearby passes the next-service board instead when "now" is empty,
   *  because a stop faces the same way whichever service day is being listed. */
  headsigns?: (string | null | undefined)[];
}) {
  const { t } = useTranslation();
  const saved = useStore((s) => s.savedStops.some((x) => x.agency === arr.agency && x.stopId === arr.stopId));
  const toggleSaved = useStore((s) => s.toggleSaved);
  const units = useStore((s) => s.units);
  const pace = useStore((s) => s.pace);

  // The walk the MAP has drawn, when this is the stop it was drawn to. Its distance
  // is the one along that line, so the two facts on this row cannot disagree with each
  // other or with the picture beside them. Any other stop keeps the straight-line
  // estimate, and the '≈' says which of the two a reader is looking at.
  const walkLeg = useStore((s) => s.walkLeg);
  const walk = walkFor(walkLeg, arr.stopId, distanceM, paceMps(pace));
  const dir = stopDirection(headsigns ?? arr.departures.map((d) => d.directionLabel));

  return (
    <div className="stop-head">
      <span className="stop-head-tile only-desktop" aria-hidden>
        <PinIcon width={19} height={19} />
      </span>

      <div className="stop-head-text">
        {/* Both lines WRAP. A TTC stop name is routinely "King St West at Spadina
            Ave West Side" and its sub-line carries three facts in three locales:
            an ellipsis here would cut a fact off mid-word, which the zero-overlap
            rule forbids outright. The card grows instead. */}
        <h2 className="stop-name">{arr.stopName ?? t('stop.code', { code: arr.stopId })}</h2>
        {/* The separator belongs to the fact that FOLLOWS it, drawn as a ::before
            (see `.stop-fact + .stop-fact` in app.css) rather than as its own
            element. As separate siblings the line could — and did — wrap after a
            "·", leaving "Eastbound · Stop 15644 ·" with a separator dangling at
            the end of a line and nothing after it. A separator that is part of the
            next fact's own nowrap box can never be the last thing on a row. */}
        {/* WHAT SERVES THIS STOP, in the agencies' own route colours, where the board
            told us. It replaces the stop id that used to sit here: 1425 is our primary
            key, "504, 508" is what the rider is standing at. The id is still reachable —
            `StopRoutes` keeps it in the strip's accessible label — and a board whose
            routes we do not have falls back to printing it, because an absent fact must
            not silently become no fact at all. */}
        <p className="stop-sub">
          {dir && <span className="stop-fact stop-dir">{t(`direction.${dir}`)}</span>}
          {arr.routes && arr.routes.length > 0
            ? <StopRoutes routes={arr.routes} stopId={arr.stopId} />
            : <span className={dir ? 'stop-fact' : 'stop-fact stop-dir'}>{t('stop.code', { code: arr.stopId })}</span>}
          {walk != null && (
            <span className="stop-fact">{fmtDistance(walk.distanceM, units === 'imperial')}</span>
          )}
          {walk != null && (
            <span className="stop-fact">
              {t(walk.kind === 'direct' ? 'stop.walkEst' : 'stop.walk', { min: walkMinutes(walk.seconds) })}
            </span>
          )}
        </p>
      </div>

      <button
        className={`stop-save ${saved ? 'is-saved' : ''}`}
        aria-pressed={saved}
        aria-label={saved ? t('stop.saved') : t('stop.save')}
        onClick={() => toggleSaved({ agency: arr.agency, stopId: arr.stopId })}
      >
        <span className="only-desktop"><HeartIcon width={20} height={20} filled={saved} /></span>
        <span className="only-mobile"><StarIcon width={20} height={20} filled={saved} /></span>
      </button>
    </div>
  );
}
