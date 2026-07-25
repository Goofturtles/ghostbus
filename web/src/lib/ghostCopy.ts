// Which sentence a ghost-feed event is allowed to say.
//
// This is a one-line module on purpose: the ghost-vs-cancelled distinction is the single
// most load-bearing claim GhostBus makes, so the selection is pure, exported, and unit
// tested (server/src/ghost_copy.test.ts) rather than inlined into a component where a
// refactor could quietly swap the wording.
//
//   'ghost'     -> "7:26 — never arrived"           (we watched; it never showed up)
//   'cancelled' -> "7:26 — cancelled by the agency" (the agency said so, on the record)
//
// A detected ghost must NEVER be described as "cancelled" or "trip cancelled": we do not
// know why it did not come, only that it did not. And a cancellation must never be
// dressed up as a no-show, because the agency owned it publicly.
import type { GhostKind } from '@shared/types';

export type GhostCopyKey = 'ghost.neverArrived' | 'ghost.cancelled';

export function ghostCopyKey(kind: GhostKind): GhostCopyKey {
  return kind === 'cancelled' ? 'ghost.cancelled' : 'ghost.neverArrived';
}
