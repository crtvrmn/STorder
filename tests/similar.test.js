// Tests für die Ähnlichkeitssuche (lib/similar.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { similarityScore, findSimilarItems, findConsolidationSuggestions } from '../lib/similar.js';

const items = [
  { id: 1, name: 'Xbox Controller', category: 'Elektronik', brand: 'Microsoft', created_at: '2026-01-01T10:00:00Z' },
  { id: 2, name: 'Staubsauger', category: 'Haushalt', brand: 'Miele', created_at: '2026-02-01T10:00:00Z' },
  { id: 3, name: 'Toaster', category: 'Küche', brand: 'Müller', created_at: '2026-03-01T10:00:00Z' },
];

test('similarityScore: exakte Wörter zählen voll', () => {
  assert.equal(similarityScore('Toaster', 'Toaster Küche Müller'), 1);
  assert.equal(similarityScore('toaster', 'Toaster'), 1);
  assert.equal(similarityScore('Kaffeemaschine', 'Toaster Küche'), 0);
});

test('similarityScore: Komposita treffen, längerer Treffer zählt mehr', () => {
  const sauger = similarityScore('Staubsaugerzubehör', 'Staubsauger Haushalt');
  const zubehoer = similarityScore('Staubsaugerzubehör', 'Xbox Controller Elektronik'); // "Zubehör"-Synonym
  assert.ok(sauger > zubehoer, `Staubsauger ${sauger} sollte vor Zubehör ${zubehoer} liegen`);
  assert.ok(sauger >= 0.34);
});

test('similarityScore: Umlaute/Schreibweisen', () => {
  assert.equal(similarityScore('Kueche', 'Küche'), 1);
  assert.equal(similarityScore('Müller', 'Mueller'), 1);
});

test('findSimilarItems: sortiert nach Score, respektiert Limit und Schwelle', () => {
  const r = findSimilarItems(items, { query: 'Xbox Zubehör' });
  assert.equal(r[0].item.name, 'Xbox Controller');
  assert.ok(r[0].score >= 0.34);

  const none = findSimilarItems(items, { query: 'Kochtopf' });
  assert.deepEqual(none, []);

  const all = findSimilarItems(items, { query: 'Toaster Küche Staubsauger' });
  assert.ok(all.length >= 2);

  const limited = findSimilarItems(items, { query: 'Toaster Küche Staubsauger', limit: 1 });
  assert.equal(limited.length, 1);
});

test('findSimilarItems: Kategorie hilft und excludeId filtert', () => {
  const byCategory = findSimilarItems(items, { query: '', category: 'Küche' });
  assert.equal(byCategory[0].item.name, 'Toaster');

  const excluded = findSimilarItems(items, { query: 'Toaster', excludeId: 3 });
  assert.equal(excluded.length, 0);

  assert.deepEqual(findSimilarItems(items, {}), []);
});

test('findConsolidationSuggestions: ähnliche Artikel in verschiedenen Kisten', () => {
  const items = [
    { id: 1, name: 'ESP32 Dev Board', category: 'Elektronik', bin_id: 1, bin: { id: 1, code: 'A1', name: 'Kabel' }, created_at: '2026-01-01T10:00:00Z' },
    { id: 2, name: 'ESP32 Board', category: 'Elektronik', bin_id: 2, bin: { id: 2, code: 'K1', name: 'Werkzeug' }, created_at: '2026-02-01T10:00:00Z' },
    { id: 3, name: 'Toaster', category: 'Küche', bin_id: 1, bin: { id: 1, code: 'A1', name: 'Kabel' }, created_at: '2026-01-01T10:00:00Z' },
    { id: 4, name: 'ESP32 Sensor', category: 'Elektronik', bin_id: 1, bin: { id: 1, code: 'A1', name: 'Kabel' }, created_at: '2026-01-03T10:00:00Z' },
  ];
  const suggestions = findConsolidationSuggestions(items);
  assert.ok(suggestions.length >= 1);
  const esp = suggestions.find((s) => s.item.id === 2 && s.target_box.code === 'A1');
  assert.ok(esp, 'Vorschlag A1 -> K1 fehlt');
  assert.equal(esp.signature, 'consolidation:2:1');
  // gleiche Kiste wird nie vorgeschlagen
  assert.ok(suggestions.every((s) => s.item.bin.id !== s.target_box.id));
});

test('findConsolidationSuggestions: verschiedene Artikel werden nicht vermischt', () => {
  const items = [
    { id: 1, name: 'Toaster', category: 'Küche', bin_id: 1, bin: { id: 1, code: 'A1' }, created_at: '2026-01-01T10:00:00Z' },
    { id: 2, name: 'Bohrmaschine', category: 'Werkzeug', bin_id: 2, bin: { id: 2, code: 'B1' }, created_at: '2026-01-02T10:00:00Z' },
  ];
  assert.deepEqual(findConsolidationSuggestions(items), []);
});
