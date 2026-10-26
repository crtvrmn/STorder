import test from 'node:test';
import assert from 'node:assert/strict';
import { findPlausibilityIssues, LEAD_DENSITY_G_CM3, HELIUM_DENSITY_G_CM3 } from '../lib/plausibility.js';

const item = (over = {}) => ({
  id: 1, name: 'Test', weight_g: 500,
  dims_cm: { length_cm: 10, width_cm: 5, height_cm: 5 },
  bin: { id: 1, code: 'A1', name: 'Kiste' },
  ...over,
});

test('Dichte: schwerer als Blei wird erkannt', () => {
  const issues = findPlausibilityIssues([item({ weight_g: 3000 })]); // 3000/250 = 12 > 11,34
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, 'density_high');
  assert.match(issues[0].message, /schwerer als Blei/);
  assert.equal(issues[0].item.id, 1);
});

test('Dichte: leichter als Helium wird erkannt', () => {
  const issues = findPlausibilityIssues([item({ weight_g: 0.0001 })]); // 4e-7 < 1,786e-4
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, 'density_low');
  assert.match(issues[0].message, /leichter als Helium/);
});

test('Dichte: plausible Werte und Grenzen', () => {
  assert.deepEqual(findPlausibilityIssues([item({ weight_g: 500 })]), []); // 2 g/cm³
  // exakt Blei/Helium ist noch plausibel (nur echt größer/kleiner zählt)
  const lead = item({ weight_g: LEAD_DENSITY_G_CM3 * 250 });
  assert.deepEqual(findPlausibilityIssues([lead]), []);
  const helium = item({ weight_g: HELIUM_DENSITY_G_CM3 * 250 });
  assert.deepEqual(findPlausibilityIssues([helium]), []);
});

test('Dichte: fehlende Maße/Gewicht -> kein Hinweis; Volumen aus Litern als Fallback', () => {
  assert.deepEqual(findPlausibilityIssues([item({ weight_g: null })]), []);
  assert.deepEqual(findPlausibilityIssues([item({ dims_cm: {} })]), []);
  // ohne Maße, aber Volumen in Litern: 0,25 l bei 3000 g -> 12 g/cm³
  const viaLiters = item({ dims_cm: {}, volume_liters: 0.25, weight_g: 3000 });
  assert.equal(findPlausibilityIssues([viaLiters]).length, 1);
});

test('Dichte: Signatur ist stabil und enthält die Art', () => {
  const a = findPlausibilityIssues([item({ weight_g: 3000 })])[0];
  const b = findPlausibilityIssues([item({ weight_g: 3000 })])[0];
  assert.equal(a.signature, b.signature);
  assert.match(a.signature, /^density:high:1:/);
});
