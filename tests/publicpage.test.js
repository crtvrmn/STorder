import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { buildPublicPage } from '../lib/publicpage.js';

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storder-public-'));
  fs.mkdirSync(path.join(dir, 'photos'));
  const a = await sharp({ create: { width: 900, height: 700, channels: 3, background: '#26a' } }).webp().toBuffer();
  const b = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#e93' } }).webp().toBuffer();
  fs.writeFileSync(path.join(dir, 'photos', 'a.webp'), a);
  fs.writeFileSync(path.join(dir, 'photos', 'b.webp'), b);

  const items = [
    {
      id: 1,
      name: 'Wasserkocher',
      description: 'Kocher aus Edelstahl.\nMit Abschaltautomatik.',
      categories: ['Küche', 'Haushalt'],
      brand: 'Müller',
      dims_cm: { length_cm: 20, width_cm: 15, height_cm: 25 },
      bin: { code: 'B1', name: 'Küche & Vorrat' },
      photos: ['/api/photos/a.webp', '/api/photos/b.webp'],
      purchase_price: 49.9,
      invoice_url: '/api/items/1/invoice',
      purchase_date: '2024-01-02',
    },
    {
      id: 2,
      name: 'Kabel',
      description: '',
      categories: ['Elektronik'],
      brand: '',
      dims_cm: {},
      bin: { code: 'K2' },
      photos: [],
    },
  ];
  return { dir, items };
}

test('buildPublicPage: bettet Bilder und Inhalte ein, ohne sensible Daten', async () => {
  const { dir, items } = await fixture();
  const page = await buildPublicPage(items, { dataDir: dir });
  assert.match(page.html, /<!doctype html>/i);
  assert.match(page.html, /Wasserkocher/);
  assert.match(page.html, /Kocher aus Edelstahl/);
  assert.match(page.html, /data:image\/webp;base64,/);
  assert.match(page.html, /"Küche"/);
  // keine Preise / Rechnungen / Kaufdaten
  assert.ok(!page.html.includes('49.9'));
  assert.ok(!page.html.includes('invoice'));
  assert.ok(!page.html.includes('2024-01-02'));
  // optional: Kisten-Code und Maße standardmäßig NICHT enthalten
  assert.ok(!page.html.includes('"B1"'));
  assert.ok(!page.html.includes('20 × 15 × 25 cm'));
  assert.equal(page.items, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildPublicPage: Kisten-Code und Maße optional', async () => {
  const { dir, items } = await fixture();
  const page = await buildPublicPage(items, { dataDir: dir, includeBoxes: true, includeDims: true });
  assert.match(page.html, /"B1"/);
  assert.match(page.html, /20 × 15 × 25 cm/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildPublicPage: sortiert, begrenzt Fotos und escaped </script>', async () => {
  const { dir, items } = await fixture();
  items[0].photos = ['/api/photos/a.webp', '/api/photos/b.webp', '/api/photos/a.webp', '/api/photos/b.webp'];
  items[0].name = 'Böse </script><script>window.x=1</script>';
  const page = await buildPublicPage(items, { dataDir: dir, maxPhotos: 2 });
  assert.ok(!page.html.includes('</script><script>window.x'));
  assert.match(page.html, /\\u003c\/script/);
  // 2 Fotos für den ersten Artikel + keins für den zweiten
  assert.equal((page.html.match(/data:image\/webp;base64,/g) || []).length, 2);
  // alphabetisch: "Böse …" vor "Kabel"
  assert.ok(page.html.indexOf('Böse') < page.html.indexOf('Kabel'));
  fs.rmSync(dir, { recursive: true, force: true });
});
