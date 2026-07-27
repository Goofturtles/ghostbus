// build_render.test — the pure part of the render bake: which agencies a build bakes.
//
// The seeding/prebuild machinery itself is exercised by the real `npm run build:render`
// (it either bakes a bootable image or exits non-zero — that IS its test, run against the
// real feeds), but the agency-list parsing is a contract worth pinning: an unset variable
// must mean "everything", and a typo must be a build failure rather than a quiet gap in
// coverage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agenciesForBuild } from './build_render.ts';
import { allAgencies } from './agencies.ts';

test('unset, empty or blank GHOSTBUS_AGENCIES bakes every registry agency', () => {
  const everyone = allAgencies().map((a) => a.id);
  assert.deepEqual(agenciesForBuild(undefined).map((a) => a.id), everyone);
  assert.deepEqual(agenciesForBuild('').map((a) => a.id), everyone);
  assert.deepEqual(agenciesForBuild('  ').map((a) => a.id), everyone);
  // Degenerate-but-nonempty strings that parse to zero ids also mean "everything":
  // a list of separators is not a request for an empty deploy.
  assert.deepEqual(agenciesForBuild(' , ,').map((a) => a.id), everyone);
});

test('an explicit list is trimmed, deduped, and order-preserving', () => {
  assert.deepEqual(
    agenciesForBuild(' miway , ttc,miway ').map((a) => a.id),
    ['miway', 'ttc'],
  );
});

test('the ten-agency Render list resolves exactly, in order', () => {
  const renderList = 'ttc,miway,yrt,brampton,burlington,drt,oakville,milton,go,upexpress';
  assert.deepEqual(agenciesForBuild(renderList).map((a) => a.id), renderList.split(','));
});

test('an unknown agency id fails the build loudly instead of being skipped', () => {
  assert.throws(() => agenciesForBuild('ttc,mississauga'), /unknown agency 'mississauga'/);
});
