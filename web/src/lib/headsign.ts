// Reading a GTFS headsign the way a rider does.
//
// The TTC publishes a departure's headsign as one string that packs three facts
// together, e.g.  "South - 310 Spadina towards Union Station":
//
//     South              the direction — which side of the street this is
//     310 Spadina        the route — already shown as a badge and a route name
//     Union Station      the destination — the only part a rider is reading for
//
// Rendering that string whole means the destination gets whatever width is left
// after the part that duplicates the badge, and at 390px it was measured cut
// mid-word at "South - 310 Spa…". Splitting it is not a rewrite of the agency's
// data — every character shown is still the agency's own — it is showing the same
// fact where a rider can read it. Anything that does not match the pattern is
// returned VERBATIM: this never guesses, and it never drops a fact it cannot
// account for.
//
// See DECISIONS §30.

export interface ParsedHeadsign {
  /** Canonical lowercase cardinal ('north' | 'south' | 'east' | 'west'), or null
   *  when the headsign does not begin with one. Never inferred from anything else. */
  direction: 'north' | 'south' | 'east' | 'west' | null;
  /** What is left to show as the destination. Falls back to the whole headsign. */
  destination: string;
}

/** "South - …" / "Southbound — …". Requires the separator, so a destination that
 *  merely starts with a compass word (e.g. "West Mall") is not mistaken for one. */
const DIRECTION_PREFIX = /^\s*(north|south|east|west)(?:bound)?\s*[-–—]\s*(.+)$/i;
/** "… towards Union Station" / "… toward Union Station". Deliberately not a bare
 *  "to": that appears inside real destination names. */
const TOWARDS = /\btowards?\s+(.+)$/i;

export function parseHeadsign(raw: string | null | undefined): ParsedHeadsign {
  const full = (raw ?? '').trim();
  if (!full) return { direction: null, destination: '' };

  const m = DIRECTION_PREFIX.exec(full);
  const direction = m
    ? (m[1].toLowerCase() as 'north' | 'south' | 'east' | 'west')
    : null;
  const rest = m ? m[2] : full;

  const t = TOWARDS.exec(rest);
  const destination = (t ? t[1] : rest).trim();

  // An empty result means the pattern matched something degenerate; keep the
  // agency's string rather than showing a blank destination.
  return { direction, destination: destination || full };
}

/**
 * The direction to print on a STOP, from the board that stop is showing.
 *
 * Returns a cardinal only when every departure on the board agrees on one. A
 * stop that serves both directions has no single direction, and printing one of
 * them would tell a rider to stand on the wrong side of the street — so in that
 * case, and whenever no headsign carries a direction at all, this returns null
 * and the line simply omits it.
 */
export function stopDirection(headsigns: (string | null | undefined)[]): ParsedHeadsign['direction'] {
  let agreed: ParsedHeadsign['direction'] = null;
  for (const h of headsigns) {
    const d = parseHeadsign(h).direction;
    if (d == null) continue;
    if (agreed == null) agreed = d;
    else if (agreed !== d) return null;
  }
  return agreed;
}
