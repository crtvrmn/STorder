// Tests für die Kategorie-Zuordnung (lib/category.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeText, tokens, categoryMatch } from '../lib/category.js';

test('normalizeText: Kleinschreibung, Umlaute, Sonderzeichen', () => {
  assert.equal(normalizeText('Küche & Vorrat'), 'kueche vorrat');
  assert.equal(normalizeText('  Werkzeug/Technik  '), 'werkzeug technik');
  assert.equal(normalizeText('Öl-Flasche 1,5 l'), 'oel flasche 1 5 l');
  assert.equal(normalizeText(null), '');
});

test('tokens: Stoppwörter raus, Synonyme rein', () => {
  const t = tokens('Küche & Vorrat');
  assert.ok(t.has('kueche'));
  assert.ok(t.has('vorrat'));
  assert.ok(t.has('lebensmittel')); // Synonym von Vorrat
  assert.equal(t.has('und'), false);
  assert.equal(t.has('das'), false);
});

test('categoryMatch: Küche passt zu Küche & Vorrat, nicht zu Dokumente', () => {
  assert.equal(categoryMatch('Küche', 'Küche & Vorrat').match, true);
  assert.equal(categoryMatch('Küche', 'Dokumente & Papier').match, false);
  assert.equal(categoryMatch('Küchengerät', 'Küche & Vorrat').match, true);
  assert.equal(categoryMatch('Lebensmittel', 'Küche & Vorrat').match, true);
});

test('categoryMatch: Werkzeug/Elektronik/Basteln/Deko/Dokumente', () => {
  assert.equal(categoryMatch('Werkzeug', 'Werkzeug & Technik').match, true);
  assert.equal(categoryMatch('Elektronik', 'Kabel & Elektronik').match, true);
  assert.equal(categoryMatch('Kabel', 'Kabel & Elektronik').match, true);
  assert.equal(categoryMatch('Bastelmaterial', 'Kleinkram & Basteln').match, true);
  assert.equal(categoryMatch('Weihnachtsdeko', 'Saison & Deko').match, true);
  assert.equal(categoryMatch('Büro', 'Dokumente & Papier').match, true);
  assert.equal(categoryMatch('Ordner', 'Dokumente & Papier').match, true);
});

test('categoryMatch: Schreibweisen und Synonyme', () => {
  assert.equal(categoryMatch('Kueche', 'Küche & Vorrat').match, true);
  assert.equal(categoryMatch('haushalt', 'Küche & Vorrat').match, true);
  assert.equal(categoryMatch('sport', 'Saison & Deko').match, false);
  assert.equal(categoryMatch('Sport & Fitness', 'Sport & Outdoor').match, true);
});

test('categoryMatch: Treffer werden zurückgegeben, leere Eingaben matchen nicht', () => {
  const hit = categoryMatch('Küche', 'Küche & Vorrat');
  assert.ok(hit.hits.length > 0);
  assert.equal(categoryMatch('', 'Küche & Vorrat').match, false);
  assert.equal(categoryMatch('Küche', '').match, false);
  assert.equal(categoryMatch(null, null).match, false);
});

test('categoryMatch: keine zufälligen Teilwort-Treffer', () => {
  // "Technik" ist in beiden Gruppen (Werkzeug/Elektronik) -> passt zu beiden
  assert.equal(categoryMatch('Technik', 'Kabel & Elektronik').match, true);
  // "Toaster" darf nicht auf "Technik" matchen
  assert.equal(categoryMatch('Toaster', 'Werkzeug & Technik').match, false);
});
