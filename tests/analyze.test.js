// Tests für die Analyse-Pipeline (src/analyze.js) mit gemocktem LLM.
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeImage, mergeSources } from '../src/analyze.js';

const visionFull = {
  identified: true,
  title: 'Toaster',
  description: 'Ein Toaster mit zwei Schlitzen.',
  brand: 'Müller',
  model: 'TM-200',
  category: 'Küche',
  color: 'silber',
  material: 'Edelstahl',
  shape: 'cuboid',
  dimensions: { length_cm: 30, width_cm: 20, height_cm: 20 },
  weight_g: 1600,
  confidence: 'high',
};

const productFull = {
  found: true,
  title: 'Müller TM-200 Doppeltoaster',
  description: 'Doppeltoaster mit zwei Schlitzen, 900 Watt, Edelstahlgehäuse und Krümelschublade.',
  brand: 'Müller',
  model: 'TM-200',
  category: 'Küche',
  product_url: 'https://example.com/toaster',
  dimensions: { length_cm: 31, width_cm: 21, height_cm: 21 },
  weight_g: 1700,
  shape: 'cuboid',
  confidence: 'high',
  source_urls: ['https://example.com/toaster', 'https://example.com/2'],
  citations: [{ url: 'https://example.com/2', title: 'Test' }],
};

test('mergeSources: Web-Maße und Beschreibung gewinnen bei gleicher Confidence', () => {
  const r = mergeSources({ vision: visionFull, product: productFull, hint: null, warnings: [] });
  assert.equal(r.title, 'Müller TM-200 Doppeltoaster');
  assert.equal(r.title_source, 'web');
  assert.equal(r.description, productFull.description);
  assert.equal(r.brand, 'Müller');
  assert.equal(r.dims_cm.length_cm, 31);
  assert.equal(r.weight_g, 1700);
  assert.equal(r.weight_source, 'web');
  assert.equal(r.shape, 'cuboid');
  assert.ok(r.volume_liters > 0);
  assert.equal(r.volume_method, 'dimensions');
  assert.deepEqual(r.source_urls, ['https://example.com/toaster', 'https://example.com/2']);
  assert.equal(r.product.found, true);
  assert.equal(r.product.product_url, 'https://example.com/toaster');
});

test('mergeSources: ohne Web-Treffer kommen Vision-Daten', () => {
  const r = mergeSources({ vision: visionFull, product: { found: false }, hint: null, warnings: [] });
  assert.equal(r.title, 'Toaster');
  assert.equal(r.title_source, 'vision');
  assert.equal(r.dims_cm.length_cm, 30);
  assert.equal(r.weight_g, 1600);
  assert.equal(r.volume_confidence, 'measured'); // Maße + Gewicht vorhanden
});

test('mergeSources: Hinweis schlägt Vision-Titel bei Titelgleichheit', () => {
  const r = mergeSources({ vision: visionFull, product: null, hint: 'Toaster', warnings: [] });
  assert.equal(r.title, 'Toaster');
  assert.equal(r.title_source, 'hint');
});

test('mergeSources: ohne Maße und Gewicht wird Volumen geschätzt + Warnung', () => {
  const warnings = [];
  const r = mergeSources({ vision: { identified: true, title: 'Kabel', confidence: 'low' }, product: null, hint: null, warnings });
  assert.equal(r.volume_liters, 5);
  assert.equal(r.volume_method, 'default_estimate');
  assert.equal(r.dims_cm, null);
  assert.ok(warnings.some((w) => /Volumen geschätzt/.test(w)));
});

test('mergeSources: Gewicht allein -> Dichte-Heuristik', () => {
  const r = mergeSources({ vision: { identified: true, title: 'Hantel', weight_g: 5000, confidence: 'high' }, product: null });
  assert.equal(r.dims_cm, null);
  assert.equal(r.volume_method, 'weight_heuristic');
  assert.equal(r.volume_confidence, 'low');
  assert.ok(r.volume_liters > 10);
});

test('analyzeImage: Vision + Web, Warnungen bei Teilfehlern', async () => {
  const calls = [];
  const llm = {
    async analyzePhoto(args) { calls.push(['photo', args]); return visionFull; },
    async lookupProduct(args) { calls.push(['product', args]); return productFull; },
  };
  const r = await analyzeImage({
    llm,
    photo: { imageDataUrl: 'data:image/jpeg;base64,AAA', hint: 'Küchengerät' },
    opts: {},
  });
  assert.equal(r.title, 'Müller TM-200 Doppeltoaster');
  assert.equal(r.ai_analysis.warnings.length, 0);
  assert.equal(calls.length, 2);
  // Suchtitel enthält Bild-/Marken-/Modellangaben
  assert.match(calls[1][1].title, /Toaster/);
  assert.equal(calls[1][1].brand, 'Müller');
  assert.equal(calls[0][1].hint, 'Küchengerät');
});

test('analyzeImage: Web-Fehler wird zur Warnung, Vision reicht', async () => {
  const llm = {
    async analyzePhoto() { return visionFull; },
    async lookupProduct() { throw new Error('Netzwerk weg'); },
  };
  const r = await analyzeImage({ llm, photo: { imageDataUrl: 'x' } });
  assert.equal(r.title, 'Toaster');
  assert.equal(r.ai_analysis.warnings.length, 1);
  assert.match(r.ai_analysis.warnings[0], /Internet-Recherche fehlgeschlagen/);
});

test('analyzeImage: Vision-Fehler wird zur Warnung, Web reicht', async () => {
  const llm = {
    async analyzePhoto() { throw new Error('Modell kaputt'); },
    async lookupProduct() { return productFull; },
  };
  const r = await analyzeImage({ llm, photo: { imageDataUrl: 'x' }, opts: { productHint: 'Toaster' } });
  assert.equal(r.title, 'Müller TM-200 Doppeltoaster');
  assert.match(r.ai_analysis.warnings[0], /Bildanalyse fehlgeschlagen/);
});

test('analyzeImage: beide Fehler -> Fehler mit Status 502', async () => {
  const llm = {
    async analyzePhoto() { throw new Error('a'); },
    async lookupProduct() { throw new Error('b'); },
  };
  await assert.rejects(
    () => analyzeImage({ llm, photo: { imageDataUrl: 'x' }, opts: { productHint: 'Ding' } }),
    (err) => err.status === 502 && err.code === 'ANALYZE_FAILED',
  );
});

test('analyzeImage: webLookup=false überspringt die Recherche', async () => {
  let looked = 0;
  const llm = {
    async analyzePhoto() { return visionFull; },
    async lookupProduct() { looked++; return productFull; },
  };
  const r = await analyzeImage({ llm, photo: { imageDataUrl: 'x' }, opts: { webLookup: false } });
  assert.equal(looked, 0);
  assert.equal(r.title, 'Toaster');
});
