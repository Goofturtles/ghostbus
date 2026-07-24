// Unit tests for bbox parsing + validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBbox, pointInBbox } from './bbox.ts';

test('parses a valid downtown-Toronto bbox', () => {
  const r = parseBbox('-79.42,43.63,-79.36,43.67');
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value, { minLon: -79.42, minLat: 43.63, maxLon: -79.36, maxLat: 43.67 });
});

test('rejects wrong arity and non-numeric', () => {
  assert.equal(parseBbox('-79.42,43.63,-79.36')?.ok, false);
  assert.equal(parseBbox('a,b,c,d')?.ok, false);
  assert.equal(parseBbox('')?.ok, false);
  assert.equal(parseBbox(undefined)?.ok, false);
});

test('rejects reversed ordering', () => {
  assert.equal(parseBbox('-79.36,43.63,-79.42,43.67').ok, false); // minLon > maxLon
  assert.equal(parseBbox('-79.42,43.67,-79.36,43.63').ok, false); // minLat > maxLat
});

test('rejects out-of-range coordinates', () => {
  assert.equal(parseBbox('-200,43,-79,44').ok, false);
  assert.equal(parseBbox('-79.5,-91,-79,44').ok, false);
});

test('rejects an over-large span', () => {
  assert.equal(parseBbox('-80,43,-70,44').ok, false); // 10° of longitude
});

test('pointInBbox is inclusive', () => {
  const b = { minLon: -79.42, minLat: 43.63, maxLon: -79.36, maxLat: 43.67 };
  assert.equal(pointInBbox(43.65, -79.39, b), true);
  assert.equal(pointInBbox(43.63, -79.42, b), true); // corner
  assert.equal(pointInBbox(43.70, -79.39, b), false);
});
