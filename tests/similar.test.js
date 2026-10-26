// Tests für die Ähnlichkeitssuche (lib/similar.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { similarityScore, findSimilarItems } from '../lib/similar.js';

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
