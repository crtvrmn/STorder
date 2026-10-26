// Tests für das 3D-Packing (lib/placement.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FULL_BOX_MAX_ITEMS_LITERS,
  parseAxes,
  boxExtentsCm,
  findFreePosition,
  analyzeBox,
  fitForBox,
  findPlacement,
  boxDimensionsLabel,
} from '../lib/placement.js';
import { DIMENSION_TOLERANCE as T } from '../lib/geometry.js';

const box = (over = {}) => ({
  id: 1,
  code: 'A23',
  name: 'Testkiste',
  location: 'Regal 1',
  length_cm: 50,
  width_cm: 40,
  height_cm: 40,
  axes: [0, 1, 2],
  active: true,
  ...over,
});

test('parseAxes akzeptiert nur Permutationen', () => {
  assert.deepEqual(parseAxes([0, 1, 2]), [0, 1, 2]);
  assert.deepEqual(parseAxes([2, 0, 1]), [2, 0, 1]);
  assert.deepEqual(parseAxes(['1', '0', '2']), [1, 0, 2]);
  assert.deepEqual(parseAxes([0, 0, 2]), [0, 1, 2]);
  assert.deepEqual(parseAxes(null), [0, 1, 2]);
});

test('boxExtentsCm bildet Innenmaße über axes auf Weltachsen ab', () => {
  assert.deepEqual(boxExtentsCm(box(), [0, 1, 2]), [50, 40, 40]);
  // größte Kante entlang Y
  assert.deepEqual(boxExtentsCm(box(), [2, 0, 1]), [40, 50, 40]);
  assert.equal(boxExtentsCm({ length_cm: 0 }, [0, 1, 2]), null);
});

test('boxDimensionsLabel', () => {
  assert.equal(boxDimensionsLabel(box()), '50 × 40 × 40 cm');
  assert.equal(boxDimensionsLabel({ length_cm: 0 }), null);
});

test('findFreePosition: erster Gegenstand bei 0/0/0, Toleranz in der Größe', () => {
  const pos = findFreePosition({ length_cm: 20, width_cm: 15, height_cm: 10 }, [50, 40, 40], []);
  assert.ok(pos);
  assert.equal(pos.x, 0);
  assert.equal(pos.y, 0);
  assert.equal(pos.z, 0);
  assert.ok(Math.abs(pos.size[0] - 20 * T) < 1e-6);
  assert.ok(Math.abs(pos.size[1] - 15 * T) < 1e-6);
  assert.ok(Math.abs(pos.size[2] - 10 * T) < 1e-6);
});

test('findFreePosition: dreht den Gegenstand, damit er passt', () => {
  // 30 hoch, Kiste nur 25 hoch -> muss auf die Seite gelegt werden
  const pos = findFreePosition({ length_cm: 30, width_cm: 20, height_cm: 20 }, [50, 40, 25], []);
  assert.ok(pos);
  assert.ok(pos.size[2] <= 25);
});

test('findFreePosition: nutzt freien Platz neben einem Gegenstand', () => {
  const used = [{ id: 1, x: 0, y: 0, z: 0, size: [20 * T, 20 * T, 20 * T] }];
  const pos = findFreePosition({ length_cm: 20, width_cm: 20, height_cm: 20 }, [50, 40, 40], used);
  assert.ok(pos);
  assert.ok(pos.x > 0 || pos.y > 0 || pos.z > 0);
  // keine Überschneidung
  const overlapX = pos.x < used[0].size[0] && pos.x + pos.size[0] > used[0].x;
  const overlapY = pos.y < used[0].size[1] && pos.y + pos.size[1] > used[0].y;
  const overlapZ = pos.z < used[0].size[2] && pos.z + pos.size[2] > used[0].z;
  assert.equal(overlapX && overlapY && overlapZ, false);
});

test('findFreePosition: stapelt lieber nach oben als in die hinterste Ecke', () => {
  const used = [{ id: 1, x: 0, y: 0, z: 0, size: [50, 40, 20] }];
  const pos = findFreePosition({ length_cm: 10, width_cm: 10, height_cm: 10 }, [50, 40, 40], used);
  assert.ok(pos);
  assert.ok(Math.abs(pos.z - 20) < 0.01, `z=${pos.z}`);
});

test('findFreePosition: respektiert Füllhöhe und Gewichtslimit', () => {
  assert.equal(findFreePosition({ length_cm: 10, width_cm: 10, height_cm: 10 }, [50, 40, 40], [], { fillHeight: 5 }), null);
  const heavy = [{ id: 1, x: 0, y: 0, z: 0, size: [10, 10, 10], weightGrams: 9000 }];
  assert.equal(
    findFreePosition({ length_cm: 10, width_cm: 10, height_cm: 10 }, [50, 40, 40], heavy, { maxWeight: 10000, weightGrams: 2000 }),
    null,
  );
  assert.ok(findFreePosition({ length_cm: 10, width_cm: 10, height_cm: 10 }, [50, 40, 40], heavy, { maxWeight: 10000, weightGrams: 500 }));
});

test('findFreePosition: null wenn die Kiste zu klein ist', () => {
  assert.equal(findFreePosition({ length_cm: 60, width_cm: 10, height_cm: 10 }, [50, 40, 40], []), null);
  assert.equal(findFreePosition({ length_cm: 10, width_cm: 10, height_cm: 10 }, [0, 40, 40], []), null);
});

test('analyzeBox rechnet Belegung, Füllstand und Gewicht', () => {
  const placements = [
    { id: 1, x: 0, y: 0, z: 0, size: [20, 20, 20], weightGrams: 1000 },
    { id: 2, x: 20, y: 0, z: 0, size: [10, 10, 10], weightGrams: 500 },
  ];
  const a = analyzeBox(box(), placements);
  assert.ok(a);
  assert.deepEqual(a.extents, [50, 40, 40]);
  assert.equal(a.capacityCm3, 80000);
  assert.equal(a.usedCm3, 9000);
  assert.equal(a.freeCm3, 71000);
  assert.equal(a.freeLiters, 71);
  assert.equal(a.fillPercent, 11.3);
  assert.equal(a.weightGrams, 1500);
  assert.equal(a.maxHeight, 20);
  assert.equal(a.placements.length, 2);
  assert.equal(analyzeBox({ length_cm: 0 }, placements), null);
});

test('fitForBox prüft Passung und sucht eine Position', () => {
  assert.ok(fitForBox({ length_cm: 20, width_cm: 20, height_cm: 20 }, box()));
  assert.equal(fitForBox({ length_cm: 60, width_cm: 20, height_cm: 20 }, box()), null);
});

const item = (over = {}) => ({ id: 1, box_id: 1, x_cm: 0, y_cm: 0, z_cm: 0, size_cm: [21.6, 21.6, 21.6], weight_g: 1000, ...over });

test('findPlacement: beste Kiste nach Füllstand/Score, Alternativen sortiert', () => {
  const boxes = [
    box({ id: 1, code: 'KLEIN', length_cm: 30, width_cm: 30, height_cm: 30 }),
    box({ id: 2, code: 'MITTEL', length_cm: 50, width_cm: 40, height_cm: 40 }),
    box({ id: 3, code: 'GROSS', length_cm: 90, width_cm: 60, height_cm: 60 }),
  ];
  const r = findPlacement({
    boxes,
    items: [],
    volumeLiters: 10,
    dimsCm: { length_cm: 25, width_cm: 20, height_cm: 20 },
    weightGrams: 2000,
  });
  assert.ok(r.best);
  assert.equal(r.best.fits, true);
  assert.equal(r.fitting.length, 3);
  assert.equal(r.reason, 'fits');
  // Kisten mit kleiner Kapazität sollen bevorzugt werden (nicht unnötig groß)
  assert.notEqual(r.best.box.code, 'GROSS');
});

test('findPlacement: Gründe für nicht passende Kisten', () => {
  const boxes = [
    box({ id: 1, code: 'KLEIN', length_cm: 20, width_cm: 20, height_cm: 20 }),
    box({ id: 2, code: 'VOLL', length_cm: 50, width_cm: 40, height_cm: 40 }),
    box({ id: 3, code: 'INAKTIV', length_cm: 50, width_cm: 40, height_cm: 40, active: false }),
    { id: 4, code: 'OHNE_MASSE', active: true },
  ];
  const fullItems = Array.from({ length: 8 }, (_, i) => item({ id: i + 1, box_id: 2, x_cm: i * 25, size_cm: [24, 39, 39] }));
  const r = findPlacement({
    boxes,
    items: fullItems,
    volumeLiters: 5,
    dimsCm: { length_cm: 30, width_cm: 30, height_cm: 30 },
  });
  const byCode = Object.fromEntries(r.considered.map((c) => [c.box.code, c]));
  assert.equal(byCode.KLEIN.reason, 'too_big_for_box');
  assert.equal(byCode.INAKTIV.reason, 'inactive');
  assert.equal(byCode.OHNE_MASSE.reason, 'no_dimensions');
  assert.equal(r.best, null);
  assert.equal(r.reason, 'too_big_for_box');
});

test('findPlacement: zu wenig Volumen bei passenden Maßen', () => {
  const boxes = [box({ id: 1, length_cm: 40, width_cm: 40, height_cm: 40 })];
  // Maße passen (30 * 1.08 = 32.4 < 40), aber das benötigte Volumen ist größer
  // als der freie Platz (Kiste hat 64 l, gebraucht werden 90 l).
  const r = findPlacement({
    boxes,
    items: [],
    volumeLiters: 90,
    dimsCm: { length_cm: 30, width_cm: 30, height_cm: 30 },
  });
  assert.equal(r.best, null);
  assert.equal(r.reason, 'not_enough_volume');
});

test('findPlacement: no_boxes ohne Kisten', () => {
  const r = findPlacement({ boxes: [], items: [], volumeLiters: 5, dimsCm: { length_cm: 10, width_cm: 10, height_cm: 10 } });
  assert.equal(r.reason, 'no_boxes');
  assert.equal(r.best, null);
});

test('findPlacement: Gewichtslimit verhindert Platzierung', () => {
  const boxes = [box({ max_weight_g: 1000 })];
  const r = findPlacement({
    boxes,
    items: [],
    volumeLiters: 2,
    dimsCm: { length_cm: 10, width_cm: 10, height_cm: 10 },
    weightGrams: 5000,
  });
  assert.equal(r.best, null);
  assert.equal(r.considered[0].fits, false);
});

test('findPlacement: respektiert ausschließen von Kisten und Gegenständen', () => {
  const boxes = [box({ id: 1 }), box({ id: 2, code: 'B2' })];
  const r = findPlacement({
    boxes,
    items: [item({ id: 9, box_id: 1 })],
    volumeLiters: 2,
    dimsCm: { length_cm: 10, width_cm: 10, height_cm: 10 },
    opts: { excludeBoxIds: [1], excludeItemIds: [9] },
  });
  assert.equal(r.best.box.id, 2);
});

test('findPlacement: Kategorie schlägt Füllstandsoptimierung', () => {
  const boxes = [
    box({ id: 1, code: 'B1', name: 'Küche & Vorrat', length_cm: 60, width_cm: 40, height_cm: 40 }),
    box({ id: 6, code: 'B6', name: 'Dokumente & Papier', length_cm: 35, width_cm: 25, height_cm: 25 }),
  ];
  const r = findPlacement({
    boxes,
    items: [],
    volumeLiters: 13.2,
    dimsCm: { length_cm: 30, width_cm: 20, height_cm: 20 },
    category: 'Küche',
    name: 'Toaster',
  });
  assert.equal(r.best.box.code, 'B1');
  assert.equal(r.best.categoryMatch, true);
  assert.ok(r.best.categoryHits.includes('kueche'));

  const docs = findPlacement({
    boxes,
    items: [],
    volumeLiters: 13.2,
    dimsCm: { length_cm: 30, width_cm: 20, height_cm: 20 },
    category: 'Dokumente',
  });
  assert.equal(docs.best.box.code, 'B6');
});

test('findPlacement: ohne Kategorie entscheidet der Score (kleine Kiste)', () => {
  const boxes = [
    box({ id: 1, code: 'B1', name: 'Küche & Vorrat', length_cm: 60, width_cm: 40, height_cm: 40 }),
    box({ id: 6, code: 'B6', name: 'Dokumente & Papier', length_cm: 35, width_cm: 25, height_cm: 25 }),
  ];
  const r = findPlacement({
    boxes,
    items: [],
    volumeLiters: 13.2,
    dimsCm: { length_cm: 30, width_cm: 20, height_cm: 20 },
  });
  assert.equal(r.best.box.code, 'B6');
  assert.equal(r.best.categoryMatch, false);
});

test('findPlacement: Kategorie hilft nicht, wenn die Kiste nicht passt', () => {
  const boxes = [
    box({ id: 1, code: 'B1', name: 'Küche & Vorrat', length_cm: 20, width_cm: 20, height_cm: 20 }),
  ];
  const r = findPlacement({
    boxes,
    items: [],
    volumeLiters: 20,
    dimsCm: { length_cm: 40, width_cm: 20, height_cm: 20 },
    category: 'Küche',
  });
  assert.equal(r.best, null);
  assert.equal(r.reason, 'too_big_for_box');
});

test('Als voll markierte Kiste: nur noch Kleinteile, sonst marked_full', () => {
  const marked = box({ id: 1, code: 'VOLL', marked_full: true, length_cm: 60, width_cm: 40, height_cm: 40 });
  const free = box({ id: 2, code: 'FREI', length_cm: 60, width_cm: 40, height_cm: 40 });

  // Kleinteil (unter dem Limit) darf weiter hinein
  const smallVolume = FULL_BOX_MAX_ITEMS_LITERS * 0.5;
  const small = findPlacement({
    boxes: [marked, free],
    items: [],
    volumeLiters: smallVolume,
    dimsCm: { length_cm: 10, width_cm: 8, height_cm: 5 },
  });
  assert.equal(small.considered.find((c) => c.box.id === 1).fits, true);
  assert.equal(small.considered.find((c) => c.box.id === 1).markedFull, true);
  // nicht als erste Wahl, wenn eine freie Kiste gleichermaßen passt
  assert.equal(small.best.box.code, 'FREI');

  // größerer Gegenstand wird abgelehnt
  const big = findPlacement({
    boxes: [marked, free],
    items: [],
    volumeLiters: FULL_BOX_MAX_ITEMS_LITERS + 5,
    dimsCm: { length_cm: 20, width_cm: 15, height_cm: 10 },
  });
  const markedResult = big.considered.find((c) => c.box.id === 1);
  assert.equal(markedResult.fits, false);
  assert.equal(markedResult.reason, 'marked_full');
  assert.equal(big.best.box.code, 'FREI');
});

test('Als voll markierte Kiste bleibt bei Kategorie-Treffer wählbar (Kleinteil)', () => {
  const marked = box({ id: 1, code: 'B1', name: 'Küche & Vorrat', marked_full: true });
  const other = box({ id: 2, code: 'B2', name: 'Werkzeug & Technik' });
  const r = findPlacement({
    boxes: [marked, other],
    items: [],
    volumeLiters: 1,
    dimsCm: { length_cm: 10, width_cm: 8, height_cm: 5 },
    category: 'Küche',
  });
  assert.equal(r.best.box.code, 'B1');
  assert.equal(r.best.markedFull, true);
});

test('findPlacement: bevorzugte Kiste (gleicher Artikel) gewinnt', () => {
  const boxes = [
    box({ id: 1, code: 'KLEIN', length_cm: 50, width_cm: 40, height_cm: 40 }),
    box({ id: 2, code: 'GROSS', length_cm: 90, width_cm: 60, height_cm: 60 }),
  ];
  const base = { boxes, items: [], volumeLiters: 10, dimsCm: { length_cm: 25, width_cm: 20, height_cm: 20 } };
  const normal = findPlacement(base);
  assert.equal(normal.best.box.code, 'KLEIN');
  const preferred = findPlacement({ ...base, opts: { preferBoxId: 2 } });
  assert.equal(preferred.best.box.code, 'GROSS');
  // bevorzugte Kiste wird nicht erzwungen, wenn sie nicht passt
  const tooSmall = findPlacement({
    ...base,
    opts: { preferBoxId: 99 },
  });
  assert.equal(tooSmall.best.box.code, 'KLEIN');
});
