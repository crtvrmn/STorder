import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY_TAXONOMY, canonicalCategory, normalizeCategories, getTaxonomy, setTaxonomy, sanitizeCategoryName } from '../lib/categories.js';

test('Taxonomie: eindeutig und ohne Kommas/Pipes', () => {
  assert.ok(CATEGORY_TAXONOMY.length >= 10);
  assert.equal(new Set(CATEGORY_TAXONOMY).size, CATEGORY_TAXONOMY.length);
  for (const c of CATEGORY_TAXONOMY) {
    assert.ok(!c.includes(',') && !c.includes('|'), c);
  }
});

test('normalizeCategories: Mehrfachauswahl und Altbestand', () => {
  assert.deepEqual(
    normalizeCategories(['Elektronik', 'USB & Kabel', 'Computer & Zubehör']),
    ['Elektronik', 'USB & Kabel', 'Computer & Zubehör'],
  );
  assert.deepEqual(normalizeCategories('Werkzeug und Heimwerker, Messwerkzeug'), ['Werkzeug', 'Messen & Prüfen']);
  assert.deepEqual(normalizeCategories(['Elektronikzubehör']), ['Elektronik', 'USB & Kabel']);
  assert.deepEqual(normalizeCategories(['smart home sensor']), ['Smart Home', 'Elektronik']);
  // Duplikate und Unbekanntes raus
  assert.deepEqual(normalizeCategories(['usb', 'USB', 'quatsch']), ['USB & Kabel', 'Elektronik']);
  assert.deepEqual(normalizeCategories([]), []);
  // maximal 5
  assert.equal(normalizeCategories(['Elektronik', 'Computer & Zubehör', 'Netzwerk', 'USB & Kabel', 'Smart Home', 'Werkzeug']).length, 5);
});

test('canonicalCategory: Einzelabbildung', () => {
  assert.deepEqual(canonicalCategory('küche'), ['Küche']);
  assert.deepEqual(canonicalCategory('Netzwerktechnik'), ['Netzwerk']);
  assert.equal(canonicalCategory('gibtsnicht'), null);
  assert.equal(canonicalCategory(''), null);
});

test('setTaxonomy: eigene Kategorien und Validierung', () => {
  setTaxonomy(['Elektronik', '3D-Druck', '3D-Druck', '  ', 'x,y']);
  assert.deepEqual(getTaxonomy(), ['Elektronik', '3D-Druck']);
  assert.deepEqual(normalizeCategories(['3d-druck', 'elektronikzubehör']), ['3D-Druck', 'Elektronik']);
  // Alias auf gelöschte Kategorie fällt weg
  setTaxonomy(['Werkzeug']);
  assert.deepEqual(normalizeCategories(['Elektronikzubehör']), []);
  assert.deepEqual(normalizeCategories(['werkzeug']), ['Werkzeug']);
  assert.equal(sanitizeCategoryName('  Neu  '), 'Neu');
  assert.equal(sanitizeCategoryName('a,b'), null);
  assert.equal(sanitizeCategoryName(''), null);
  // leere Liste -> Standard
  setTaxonomy([]);
  assert.ok(getTaxonomy().includes('Elektronik'));
});
