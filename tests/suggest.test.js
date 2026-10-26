// Tests für den Platzierungs-Service (lib/suggest.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { suggestPlacement, prepareBox, prepareItem } from '../lib/suggest.js';

const box = (over = {}) => ({
  id: 1,
  code: 'A23',
  name: 'Küche',
  location: 'Regal 1',
  inner_dims: { a: 50, b: 40, c: 40 },
  length_cm: 50,
  width_cm: 40,
  height_cm: 40,
  axes: [0, 1, 2],
  active: true,
  ...over,
});

test('prepareBox übernimmt DB-Form und Rohmaße', () => {
  const prepared = prepareBox(box());
  assert.equal(prepared.length_cm, 50);
  assert.equal(prepared.active, true);
  const raw = prepareBox({ id: 2, code: 'B1', length_cm: 60, width_cm: 40, height_cm: 40, active: 0 });
  assert.equal(raw.length_cm, 60);
  assert.equal(raw.active, false);
  assert.equal(prepareBox({ id: 3 }), null);
});

test('prepareItem mappt DB-Felder (bin_id, position) auf die Packing-Form', () => {
  const p = prepareItem({
    id: 5,
    bin_id: 1,
    position: { x_cm: 10, y_cm: 5, z_cm: 0 },
    size_cm: [21.6, 21.6, 21.6],
    weight_g: '1,5 kg',
  });
  assert.equal(p.box_id, 1);
  assert.equal(p.x_cm, 10);
  assert.equal(p.y_cm, 5);
  assert.equal(p.z_cm, 0);
  assert.deepEqual(p.size_cm, [21.6, 21.6, 21.6]);
  assert.equal(p.weight_g, 1500);
});

test('suggestPlacement findet die passende Kiste inkl. Position', () => {
  const r = suggestPlacement({
    boxes: [box()],
    items: [],
    dimsCm: { length_cm: 30, width_cm: 20, height_cm: 20 },
    weightGrams: 1500,
    shape: 'cuboid',
  });
  assert.equal(r.reason, 'fits');
  assert.ok(r.best);
  assert.equal(r.best.box.code, 'A23');
  assert.ok(r.best.position);
  assert.equal(r.best.position.x, 0);
  assert.equal(r.needs_bigger_box, false);
  assert.ok(r.volume.liters > 12);
});

test('suggestPlacement bevorzugt die kleinere passende Kiste', () => {
  const r = suggestPlacement({
    boxes: [
      box({ id: 1, code: 'KLEIN', inner_dims: { a: 30, b: 30, c: 30 }, length_cm: 30, width_cm: 30, height_cm: 30 }),
      box({ id: 2, code: 'GROSS', inner_dims: { a: 90, b: 60, c: 60 }, length_cm: 90, width_cm: 60, height_cm: 60 }),
    ],
    items: [],
    dimsCm: { length_cm: 20, width_cm: 20, height_cm: 20 },
    shape: 'cuboid',
  });
  assert.equal(r.best.box.code, 'KLEIN');
  assert.equal(r.alternatives.length, 1);
});

test('suggestPlacement: zu große Gegenstände schlagen eine größere Kiste vor', () => {
  const r = suggestPlacement({
    boxes: [box()],
    items: [],
    dimsCm: { length_cm: 80, width_cm: 20, height_cm: 20 },
    shape: 'cuboid',
  });
  assert.equal(r.best, null);
  assert.equal(r.reason, 'too_big_for_box');
  assert.equal(r.needs_bigger_box, true);
  assert.ok(r.recommended_min_liters > 0);
  assert.match(r.reason_text, /größer als der Innenraum/);
  assert.equal(r.considered[0].fits, false);
  assert.ok(r.considered[0].reason_text);
});

test('suggestPlacement: berücksichtigt bereits eingelagerte Gegenstände', () => {
  const boxes = [box({ length_cm: 30, width_cm: 30, height_cm: 30, inner_dims: { a: 30, b: 30, c: 30 } })];
  const filled = [{
    id: 1,
    bin_id: 1,
    position: { x_cm: 0, y_cm: 0, z_cm: 0 },
    size_cm: [30, 30, 30],
    weight_g: 1000,
  }];
  const r = suggestPlacement({
    boxes,
    items: filled,
    dimsCm: { length_cm: 10, width_cm: 10, height_cm: 10 },
  });
  assert.equal(r.best, null);
  assert.equal(r.considered[0].fill_percent, 100);
});

test('suggestPlacement: manuelles Volumen überschreibt die Berechnung', () => {
  const r = suggestPlacement({
    boxes: [box()],
    items: [],
    volumeLiters: 1,
    dimsCm: { length_cm: 10, width_cm: 10, height_cm: 10 },
  });
  assert.equal(r.volume.liters, 1);
  assert.equal(r.volume.method, 'manual');
});

test('suggestPlacement: ohne Kisten kommt no_boxes', () => {
  const r = suggestPlacement({ boxes: [], items: [], dimsCm: { length_cm: 10, width_cm: 10, height_cm: 10 } });
  assert.equal(r.reason, 'no_boxes');
  assert.equal(r.best, null);
  assert.match(r.reason_text, /keine Kisten/);
});

test('suggestPlacement: Kategorie bestimmt die Kiste', () => {
  const boxes = [
    box({ id: 1, code: 'B1', name: 'Küche & Vorrat', inner_dims: { a: 60, b: 40, c: 40 }, length_cm: 60, width_cm: 40, height_cm: 40 }),
    box({ id: 6, code: 'B6', name: 'Dokumente & Papier', inner_dims: { a: 35, b: 25, c: 25 }, length_cm: 35, width_cm: 25, height_cm: 25 }),
  ];
  const r = suggestPlacement({
    boxes,
    items: [],
    dimsCm: { length_cm: 30, width_cm: 20, height_cm: 20 },
    category: 'Küche',
    name: 'Toaster',
  });
  assert.equal(r.best.box.code, 'B1');
  assert.equal(r.best.box.category_match, true);
  assert.equal(r.considered.find((c) => c.code === 'B6').category_match, false);
});

test('suggestPlacement: ausgeschlossene Kisten werden übersprungen', () => {
  const boxes = [
    box({ id: 1, code: 'B1', name: 'Küche & Vorrat', inner_dims: { a: 60, b: 40, c: 40 }, length_cm: 60, width_cm: 40, height_cm: 40 }),
    box({ id: 6, code: 'B6', name: 'Dokumente & Papier', inner_dims: { a: 35, b: 25, c: 25 }, length_cm: 35, width_cm: 25, height_cm: 25 }),
  ];
  const r = suggestPlacement({
    boxes,
    items: [],
    dimsCm: { length_cm: 30, width_cm: 20, height_cm: 20 },
    category: 'Küche',
    opts: { excludeBoxIds: [1] },
  });
  assert.equal(r.best.box.code, 'B6');
  assert.equal(r.considered.find((c) => c.code === 'B1').fits, false);
  assert.equal(r.considered.find((c) => c.code === 'B1').reason, 'inactive');
});

test('suggestPlacement: Stückzahl skaliert das benötigte Volumen', () => {
  const boxes = [box({ id: 1, code: 'K', inner_dims: { a: 40, b: 40, c: 40 }, length_cm: 40, width_cm: 40, height_cm: 40 })]; // 64 l
  const one = suggestPlacement({ boxes, items: [], dimsCm: { length_cm: 30, width_cm: 30, height_cm: 30 }, quantity: 1 });
  const six = suggestPlacement({ boxes, items: [], dimsCm: { length_cm: 30, width_cm: 30, height_cm: 30 }, quantity: 6 });

  assert.equal(six.volume.quantity, 6);
  assert.ok(Math.abs(six.volume.liters - one.volume.liters * 6) < 0.01, `${six.volume.liters} vs ${one.volume.liters}`);
  assert.equal(one.volume.unit_liters, one.volume.liters);
  assert.equal(one.reason, 'fits');
  assert.equal(six.reason, 'not_enough_volume');
  assert.equal(six.best, null);
  assert.ok(six.recommended_min_liters > one.volume.liters);
  assert.equal(six.needs_bigger_box, true);
});
