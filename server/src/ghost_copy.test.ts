// The ghost-vs-cancelled copy gate.
//
// GhostBus is allowed to say two very different things about a missing trip, and the
// difference is the whole product: "never arrived" is our own observation, "cancelled by
// the agency" is the agency's public statement. Mixing them would either accuse the
// agency of something it did not announce, or let an unannounced no-show hide behind a
// cancellation. The selector lives in web/src/lib/ghostCopy.ts and is tested here so the
// suite fails loudly if the wording is ever rewired.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ghostCopyKey } from '../../web/src/lib/ghostCopy.ts';
import en from '../../web/src/i18n/en.ts';
import frCA from '../../web/src/i18n/frCA.ts';
import es from '../../web/src/i18n/es.ts';

test('a detected ghost says "never arrived", never anything about cancellation', () => {
  assert.equal(ghostCopyKey('ghost'), 'ghost.neverArrived');
});

test('an official cancellation is attributed to the agency', () => {
  assert.equal(ghostCopyKey('cancelled'), 'ghost.cancelled');
});

test('the two kinds never share a copy key', () => {
  assert.notEqual(ghostCopyKey('ghost'), ghostCopyKey('cancelled'));
});

test('the English strings are the exact verifiable sentences the brief requires', () => {
  assert.equal(en.ghost.neverArrived, '{{time}} — never arrived');
  assert.equal(en.ghost.cancelled, '{{time}} — cancelled by the agency');
});

test('no locale describes a detected ghost as cancelled, or a cancellation as a no-show', () => {
  for (const [name, dict] of [['en', en], ['fr-CA', frCA], ['es', es]] as const) {
    const ghost = dict.ghost.neverArrived.toLowerCase();
    const cancelled = dict.ghost.cancelled.toLowerCase();
    assert.ok(!/cancel|annul/.test(ghost), `${name}: the ghost string must not mention cancellation`);
    assert.ok(/cancel|annul/.test(cancelled), `${name}: the cancellation string must name the agency's act`);
    // The forbidden softenings from the brief, in every locale we ship.
    assert.ok(!ghost.includes("isn't coming"), `${name}: "isn't coming" is not a claim we can back`);
    assert.ok(!ghost.includes('trip cancelled'), `${name}: a detected ghost is not a cancelled trip`);
    assert.ok(dict.ghost.neverArrived.includes('{{time}}'), `${name}: the ghost string must carry the time`);
    assert.ok(dict.ghost.cancelled.includes('{{time}}'), `${name}: the cancellation string must carry the time`);
  }
});
