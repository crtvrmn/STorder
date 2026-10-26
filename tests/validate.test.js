// Tests für die Eingabe-Validierung (lib/validate.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateBoxInput, validatePlacementInput, ValidationError, z } from '../lib/validate.js';

test('validateBoxInput: Code wird normalisiert und geprüft', () => {
  const out = validateBoxInput({ code: ' a23 ', dims_cm: { length_cm: 50, width_cm: 40, height_cm: 40 } });
  assert.equal(out.code, 'A23');
  assert.deepEqual(out.dims_cm, { a: 50, b: 40, c: 40 });
});

test('validateBoxInput: fehlende oder ungültige Angaben werfen mit Details', () => {
  assert.throws(
    () => validateBoxInput({ code: 'A23' }),
    (err) => err instanceof ValidationError && err.status === 400 && /Innenmaße/.test(err.details.dims_cm),
  );
  assert.throws(
    () => validateBoxInput({ code: 'A23', dims_cm: { length_cm: 50, width_cm: 40 } }),
    (err) => /Länge, Breite und Höhe/.test(err.details.dims_cm),
  );
  assert.throws(
    () => validateBoxInput({ code: 'zu-lang-und-mit-umlaut-ö', dims_cm: { length_cm: 50, width_cm: 40, height_cm: 40 } }),
    (err) => Boolean(err.details.code),
  );
  assert.throws(
    () => validateBoxInput({ code: 'A23', dims_cm: { length_cm: 500, width_cm: 40, height_cm: 40 } }),
    (err) => /Maximal 300/.test(err.details.dims_cm),
  );
});

test('validateBoxInput: Kapazität in Litern leitet würfelförmige Maße ab', () => {
  const out = validateBoxInput({ code: 'B1', capacity_liters: 50 });
  assert.equal(out.derived_dims, true);
  assert.ok(out.dims_cm.a > 0);
  const liters = (out.dims_cm.a * out.dims_cm.b * out.dims_cm.c) / 1000;
  assert.ok(Math.abs(liters - 50) < 8, `abgeleitetes Volumen ${liters} l`);
});

test('validateBoxInput: komma-tolerante Zahlen und Achsen', () => {
  const out = validateBoxInput({
    code: 'C1',
    dims_cm: { length_cm: '50,5', width_cm: '40', height_cm: '40' },
    axes: [2, 1, 0],
    fill_height_cm: '35',
    max_weight_g: '20000',
    active: 'false',
  });
  assert.equal(out.dims_cm.a, 50.5);
  assert.deepEqual(out.axes, [2, 1, 0]);
  assert.equal(out.fill_height_cm, 35);
  assert.equal(out.max_weight_g, 20000);
  assert.equal(out.active, false);
});

test('validatePlacementInput: box_id nötig, "auto" wird akzeptiert', () => {
  assert.equal(validatePlacementInput({ box_id: 'auto' }).box_id, 'auto');
  assert.throws(() => validatePlacementInput({}), (err) => /Kiste angeben/.test(err.details.box_id));
  assert.equal(validatePlacementInput({ box_id: 3 }).box_id, 3);
  assert.throws(() => validatePlacementInput({ box_id: 0 }), (err) => /Ungültige Kiste/.test(err.details.box_id));
});

test('z-Helfer', () => {
  assert.equal(z.str('  x  '), 'x');
  assert.equal(z.str('', 'fallback'), 'fallback');
  assert.equal(z.int('3.7', 0, 1, 10), 4);
  assert.equal(z.int('abc', 7), 7);
  assert.equal(z.num('12,5'), 12.5);
  assert.equal(z.bool('Ja'), false); // nur 1/true/yes/on
  assert.equal(z.bool('yes'), true);
  assert.deepEqual(z.strArray('a, b ,c'), ['a', 'b', 'c']);
  assert.equal(z.positive('0'), null);
  assert.equal(z.positive('2,5'), 2.5);
});
