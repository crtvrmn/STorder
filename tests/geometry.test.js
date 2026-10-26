// Tests für die reinen Geometrie-/Volumen-Helfer.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toCm,
  toGrams,
  normalizeDimensions,
  boundingBoxLiters,
  computeRequiredVolume,
  fitsInBox,
  normalizeDimensions as norm,
  SHAPE_FACTORS,
  DIMENSION_TOLERANCE,
  PACKING_FACTOR,
} from '../lib/geometry.js';

test('toCm versteht Zahlen, Komma, Einheiten und Objekte', () => {
  assert.equal(toCm(30), 30);
  assert.equal(toCm('12,5'), 12.5);
  assert.equal(toCm('30 cm'), 30);
  assert.equal(toCm('250 mm'), 25);
  assert.equal(toCm('1,2 m'), 120);
  assert.equal(toCm('2 dm'), 20);
  assert.equal(toCm({ value: 40, unit: 'cm' }), 40);
  assert.equal(toCm(''), null);
  assert.equal(toCm(0), null);
  assert.equal(toCm(-5), null);
  assert.equal(toCm(null), null);
});

test('toGrams versteht g, kg und Objekte', () => {
  assert.equal(toGrams(1500), 1500);
  assert.equal(toGrams('1,5 kg'), 1500);
  assert.equal(toGrams({ value: 2, unit: 'kg' }), 2000);
  assert.equal(toGrams(0), null);
  assert.equal(toGrams(''), null);
});

test('normalizeDimensions akzeptiert alle Formen und sortiert absteigend', () => {
  assert.deepEqual(norm({ length_cm: 30, width_cm: 20, height_cm: 10 }), { a: 30, b: 20, c: 10 });
  assert.deepEqual(norm({ length_cm: 10, width_cm: 30, height_cm: 20 }), { a: 30, b: 20, c: 10 });
  assert.deepEqual(norm({ a: 30, b: 20, c: 10 }), { a: 30, b: 20, c: 10 });
  assert.deepEqual(norm({ dims_cm: { length_cm: 40, width_cm: 30, height_cm: 50 } }), { a: 50, b: 40, c: 30 });
  assert.deepEqual(norm([50, 40, 30]), { a: 50, b: 40, c: 30 });
  assert.deepEqual(norm(['2 m', '30 cm', '250 mm']), { a: 200, b: 30, c: 25 });
  assert.equal(norm({ length_cm: 30 }), null);
  assert.equal(norm(null), null);
  assert.equal(norm({}), null);
});

test('boundingBoxLiters rechnet cm³ in Liter', () => {
  assert.equal(boundingBoxLiters({ length_cm: 40, width_cm: 30, height_cm: 30 }), 36);
  assert.equal(boundingBoxLiters({ a: 100, b: 100, c: 100 }), 1000);
  assert.equal(boundingBoxLiters({}), null);
});

test('computeRequiredVolume: Bounding-Box × Toleranz × Formfaktor × Packluft', () => {
  const r = computeRequiredVolume({ dims: { length_cm: 40, width_cm: 30, height_cm: 20 }, shape: 'cuboid', weightGrams: 2000 });
  const expected = Math.round(
    ((40 * DIMENSION_TOLERANCE * 30 * DIMENSION_TOLERANCE * 20 * DIMENSION_TOLERANCE * 1.0 * PACKING_FACTOR) / 1000) * 1000,
  ) / 1000;
  assert.equal(r.liters, expected);
  assert.equal(r.method, 'dimensions');
  assert.equal(r.confidence, 'measured');
  assert.equal(r.boundingBoxLiters, 24);
  assert.equal(r.weightGrams, 2000);

  const cylinder = computeRequiredVolume({ dims: { length_cm: 40, width_cm: 30, height_cm: 20 }, shape: 'cylinder' });
  assert.ok(cylinder.liters < r.liters);
  assert.ok(Math.abs(cylinder.liters - (r.liters / 1.0) * SHAPE_FACTORS.cylinder) < 0.01);

  // Ohne Maße: Dichte-Heuristik über das Gewicht, als unsicher markiert.
  const heuristic = computeRequiredVolume({ weightGrams: 3500 });
  assert.equal(heuristic.method, 'weight_heuristic');
  assert.equal(heuristic.confidence, 'low');
  assert.ok(heuristic.liters > 0);
  assert.equal(heuristic.boundingBoxLiters, null);

  assert.equal(computeRequiredVolume({}), null);
  assert.equal(computeRequiredVolume(), null);
});

test('fitsInBox: Toleranz pro Kante, Rotation erlaubt', () => {
  assert.equal(fitsInBox({ length_cm: 30, width_cm: 20, height_cm: 10 }, { length_cm: 40, width_cm: 30, height_cm: 30 }), true);
  // 30 * 1.08 = 32.4 passt nicht in 32
  assert.equal(fitsInBox({ length_cm: 30, width_cm: 20, height_cm: 10 }, { length_cm: 32, width_cm: 30, height_cm: 30 }), false);
  // gedreht: 10→30, 20→20, 30→30
  assert.equal(fitsInBox({ length_cm: 30, width_cm: 20, height_cm: 10 }, { length_cm: 30, width_cm: 20, height_cm: 30 }), false);
  assert.equal(fitsInBox({ length_cm: 30, width_cm: 20, height_cm: 10 }, { length_cm: 33, width_cm: 22, height_cm: 33 }), true);
  assert.equal(fitsInBox({ length_cm: 0, width_cm: 20, height_cm: 10 }, [40, 40, 40]), false);
  assert.equal(fitsInBox({ a: 20, b: 20, c: 20 }, [50, 40, 40]), true);
});

test('normalizeDimensions ist idempotent', () => {
  const once = normalizeDimensions({ length_cm: 12, width_cm: 34, height_cm: 5 });
  assert.deepEqual(normalizeDimensions(once), once);
});
