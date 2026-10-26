// HTTP-API-Tests: startet den echten Express-App auf einem freien Port.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { loadConfig } from '../lib/config.js';
import { openDatabase, seedBins } from '../src/db.js';
import { createApp } from '../src/server.js';

async function boot(env = {}, llmOverride = null, paperlessOverride = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storder-api-'));
  const config = loadConfig({ DATA_DIR: dir, PORT: '0', HOST: '127.0.0.1', SEED_BOXES: 'false', LLM_API_KEY: '', ...env });
  const { db } = openDatabase(config.dataDir);
  if (config.seed.enabled) seedBins(db, config.seed.boxes);
  const llm = llmOverride ?? {
    analyzePhoto: async () => { throw new Error('kein LLM im Test'); },
    lookupProduct: async () => null,
  };
  const app = createApp({ config, db, llm, paperless: paperlessOverride ?? undefined });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML */ }
    return { status: res.status, json, text };
  };
  return {
    base,
    call,
    db,
    config,
    close: async () => {
      server.close();
      await once(server, 'close');
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('health und stats', async () => {
  const t = await boot();
  try {
    const health = await t.call('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.llm_configured, false);

    const stats = await t.call('GET', '/api/stats');
    assert.equal(stats.status, 200);
    assert.equal(stats.json.stats.bins, 0);
  } finally { await t.close(); }
});

test('Kisten-CRUD über die API (Maße aus dem Formular)', async () => {
  const t = await boot();
  try {
    const created = await t.call('POST', '/api/bins', {
      code: 'a23',
      name: 'Küche',
      location: 'Regal 1',
      dims_cm: { length_cm: 50, width_cm: 40, height_cm: 40 },
    });
    assert.equal(created.status, 201);
    const bin = created.json.bin;
    assert.equal(bin.code, 'A23');
    assert.deepEqual(bin.inner_dims, { a: 50, b: 40, c: 40 });
    assert.equal(bin.capacity_liters, 80);

    const list = await t.call('GET', '/api/bins');
    assert.equal(list.json.bins.length, 1);

    const updated = await t.call('PUT', `/api/bins/${bin.id}`, {
      name: 'Vorrat',
      dims_cm: { length_cm: 60, width_cm: 40, height_cm: 40 },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.bin.name, 'Vorrat');
    assert.equal(updated.json.bin.capacity_liters, 96);

    const invalid = await t.call('POST', '/api/bins', { code: 'X1', dims_cm: { length_cm: 10, width_cm: 10 } });
    assert.equal(invalid.status, 400);
    assert.ok(invalid.json.details.dims_cm);

    const dup = await t.call('POST', '/api/bins', { code: 'A23', dims_cm: { length_cm: 10, width_cm: 10, height_cm: 10 } });
    assert.equal(dup.status, 409);

    const del = await t.call('DELETE', `/api/bins/${bin.id}`);
    assert.equal(del.status, 200);
    assert.equal((await t.call('GET', '/api/bins')).json.bins.length, 0);
  } finally { await t.close(); }
});

test('Gegenstand anlegen: Auto-Platzierung, Suche, Verschieben', async () => {
  const t = await boot();
  try {
    const bin = (await t.call('POST', '/api/bins', {
      code: 'A23',
      dims_cm: { length_cm: 50, width_cm: 40, height_cm: 40 },
    })).json.bin;

    const item = await t.call('POST', '/api/items', {
      name: 'Toaster',
      description: 'Zwei Schlitze',
      category: 'Küche',
      bin_id: 'auto',
      dims_cm: { length_cm: 30, width_cm: 20, height_cm: 20 },
      weight_g: 1500,
    });
    assert.equal(item.status, 201);
    assert.equal(item.json.item.bin.id, bin.id);
    assert.ok(item.json.item.position);
    assert.equal(item.json.item.volume_method, 'dimensions');

    const search = await t.call('GET', '/api/search?q=toaster');
    assert.equal(search.json.items.length, 1);
    assert.equal(search.json.items[0].bin.code, 'A23');

    const second = await t.call('POST', '/api/bins', {
      code: 'B1',
      dims_cm: { length_cm: 60, width_cm: 40, height_cm: 40 },
    });
    const moved = await t.call('POST', `/api/items/${item.json.item.id}/move`, { bin_id: second.json.bin.id });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.item.bin.code, 'B1');

    const binDetail = await t.call('GET', `/api/bins/${second.json.bin.id}`);
    assert.equal(binDetail.json.items.length, 1);
    assert.equal(binDetail.json.bin.item_count, 1);
  } finally { await t.close(); }
});

test('Platzierungsvorschlag und "größere Kiste nötig"', async () => {
  const t = await boot();
  try {
    await t.call('POST', '/api/bins', { code: 'KLEIN', dims_cm: { length_cm: 30, width_cm: 30, height_cm: 30 } });
    const ok = await t.call('POST', '/api/suggest', { dims_cm: { length_cm: 20, width_cm: 20, height_cm: 20 } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.suggestion.reason, 'fits');
    assert.equal(ok.json.suggestion.best.box.code, 'KLEIN');

    const big = await t.call('POST', '/api/suggest', { dims_cm: { length_cm: 80, width_cm: 20, height_cm: 20 } });
    assert.equal(big.json.suggestion.best, null);
    assert.equal(big.json.suggestion.needs_bigger_box, true);
    assert.ok(big.json.suggestion.recommended_min_liters > 0);

    const autoFail = await t.call('POST', '/api/items', {
      name: 'Zu groß', bin_id: 'auto', dims_cm: { length_cm: 80, width_cm: 20, height_cm: 20 },
    });
    assert.equal(autoFail.status, 409);
    assert.equal(autoFail.json.needs_bigger_box, true);
  } finally { await t.close(); }
});

test('Analyse ohne API-Key liefert 503 mit Hinweis', async () => {
  const t = await boot();
  try {
    const res = await t.call('POST', '/api/analyze', { image: 'data:image/jpeg;base64,AAAA' });
    assert.equal(res.status, 503);
    assert.match(res.json.error, /LLM_API_KEY/);
  } finally { await t.close(); }
});

test('Einstellungen lassen sich lesen und ändern (Laufzeit-Override)', async () => {
  const t = await boot();
  try {
    const initial = await t.call('GET', '/api/settings');
    assert.equal(initial.status, 200);
    assert.equal(initial.json.effective.recall_interval_days, 30);
    assert.equal(initial.json.effective.recall_enabled, true);

    const saved = await t.call('PUT', '/api/settings', {
      recall_interval_days: 60,
      recall_items_per_recall: 5,
      recall_enabled: false,
      llm_model: 'openai/gpt-4o-mini',
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.settings.recall_interval_days, 60);

    const after = await t.call('GET', '/api/settings');
    assert.equal(after.json.effective.recall_interval_days, 60);
    assert.equal(after.json.effective.recall_items_per_recall, 5);
    assert.equal(after.json.effective.recall_enabled, false);
    assert.equal(after.json.effective.llm_model, 'openai/gpt-4o-mini');

    const bad = await t.call('PUT', '/api/settings', { recall_interval_days: 'abc' });
    assert.equal(bad.status, 400);
  } finally { await t.close(); }
});

test('Erinnerung: deaktiviert und leer ohne fällige Gegenstände', async () => {
  const t = await boot();
  try {
    const empty = await t.call('GET', '/api/recall');
    assert.equal(empty.status, 200);
    assert.equal(empty.json.enabled, true);
    assert.deepEqual(empty.json.items, []);

    await t.call('PUT', '/api/settings', { recall_enabled: false });
    const off = await t.call('GET', '/api/recall');
    assert.equal(off.json.enabled, false);
    assert.deepEqual(off.json.items, []);

    const badVerdict = await t.call('POST', '/api/recall/1', { verdict: 'quatsch' });
    assert.equal(badVerdict.status, 400);
  } finally { await t.close(); }
});

test('Erinnerung: alte Gegenstände werden fällig und bewertbar', async () => {
  const t = await boot({ RECALL_MIN_ITEM_AGE_DAYS: '0', RECALL_ITEMS_PER_RECALL: '3' });
  try {
    const bin = (await t.call('POST', '/api/bins', { code: 'A1', dims_cm: { length_cm: 60, width_cm: 40, height_cm: 40 } })).json.bin;
    const item = (await t.call('POST', '/api/items', {
      name: 'Zelt', bin_id: bin.id, dims_cm: { length_cm: 20, width_cm: 20, height_cm: 20 },
    })).json.item;

    // Gegenstand altern lassen: vor 60 Tagen eingelagert.
    const old = new Date(Date.now() - 60 * 86400000).toISOString();
    t.db.prepare('UPDATE items SET created_at = ? WHERE id = ?').run(old, item.id);

    const recall = await t.call('GET', '/api/recall');
    assert.equal(recall.status, 200);
    assert.equal(recall.json.items.length, 1);
    assert.equal(recall.json.items[0].id, item.id);

    const verdict = await t.call('POST', `/api/recall/${item.id}`, { verdict: 'keep', note: 'benutze ich' });
    assert.equal(verdict.status, 200);
    assert.equal(verdict.json.item.keep_count, 1);
    assert.ok(verdict.json.item.next_review_at);

    // nach der Bewertung ist der Gegenstand nicht mehr fällig
    const again = await t.call('GET', '/api/recall');
    assert.equal(again.json.items.length, 0);
  } finally { await t.close(); }
});

test('Unbekannte API-Route -> 404 JSON; Fotos -> 404', async () => {
  const t = await boot();
  try {
    const nope = await t.call('GET', '/api/gibtsnicht');
    assert.equal(nope.status, 404);
    assert.equal(nope.json.code, 'NOT_FOUND');
    const photo = await t.call('GET', '/api/photos/doesnotexist.jpg');
    assert.equal(photo.status, 404);
  } finally { await t.close(); }
});

test('Foto-Pipeline: sharp verkleinert, LLM-Antwort wird übernommen, Foto abrufbar', async () => {
  const { default: sharp } = await import('sharp');
  const jpeg = await sharp({
    create: { width: 900, height: 600, channels: 3, background: { r: 180, g: 40, b: 40 } },
  }).jpeg().toBuffer();

  const calls = [];
  const llm = {
    async analyzePhoto(args) {
      calls.push(args);
      assert.match(args.imageDataUrl, /^data:image\/jpeg;base64,/);
      return {
        identified: true,
        title: 'Toaster',
        description: 'Toaster mit zwei Schlitzen und Krümelschublade.',
        brand: 'Müller',
        category: 'Küche',
        shape: 'cuboid',
        dimensions: { length_cm: 30, width_cm: 20, height_cm: 20 },
        weight_g: 1600,
        confidence: 'high',
      };
    },
    async lookupProduct() {
      return {
        found: true,
        title: 'Müller TM-200 Doppeltoaster',
        description: 'Doppeltoaster mit zwei Schlitzen, 900 Watt und Edelstahlgehäuse für den täglichen Gebrauch.',
        brand: 'Müller',
        model: 'TM-200',
        dimensions: { length_cm: 31, width_cm: 21, height_cm: 21 },
        weight_g: 1700,
        confidence: 'high',
        product_url: 'https://example.com/toaster',
        source_urls: ['https://example.com/toaster'],
        citations: [],
      };
    },
  };

  const t = await boot({ LLM_API_KEY: 'test-key' }, llm);
  try {
    const res = await t.call('POST', '/api/analyze', {
      image: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      hint: 'Küchengerät',
    });
    assert.equal(res.status, 200);
    const a = res.json.analysis;
    assert.equal(a.title, 'Müller TM-200 Doppeltoaster');
    assert.equal(a.dims_cm.length_cm, 31);
    assert.equal(a.weight_g, 1700);
    assert.ok(a.volume_liters > 0);
    assert.match(res.json.photo.path, /^\/api\/photos\/[a-z0-9-]+\.webp$/);
    assert.ok(calls[0].hint.includes('Küchengerät'));

    // Foto liegt verkleinert auf der Platte und ist abrufbar
    const photoRes = await fetch(t.base + res.json.photo.path);
    assert.equal(photoRes.status, 200);
    assert.equal(photoRes.headers.get('content-type'), 'image/webp');
    const stored = Buffer.from(await photoRes.arrayBuffer());
    assert.ok(stored.length > 500);
    const meta = await sharp(stored).metadata();
    assert.equal(meta.format, 'webp');
    assert.ok(meta.width <= 1000 && meta.height <= 1000, `${meta.width}x${meta.height}`);

    // Ergebnis einlagern
    const bin = (await t.call('POST', '/api/bins', { code: 'A1', dims_cm: { length_cm: 60, width_cm: 40, height_cm: 40 } })).json.bin;
    const item = await t.call('POST', '/api/items', {
      name: a.title,
      description: a.description,
      brand: a.brand,
      category: a.category,
      shape: a.shape,
      dims_cm: a.dims_cm,
      weight_g: a.weight_g,
      photo_path: res.json.photo.path,
      photos: [res.json.photo.path],
      bin_id: bin.id,
    });
    assert.equal(item.status, 201);
    assert.equal(item.json.item.photo_path, res.json.photo.path);
    assert.deepEqual(item.json.item.photos, [res.json.photo.path]);
  } finally { await t.close(); }
});

test('Analyse mit kaputtem Bild -> 400', async () => {
  const t = await boot({ LLM_API_KEY: 'test-key' }, {
    analyzePhoto: async () => { throw new Error('nie erreicht'); },
    lookupProduct: async () => null,
  });
  try {
    const res = await t.call('POST', '/api/analyze', { image: 'kein-bild' });
    assert.equal(res.status, 400);
  } finally { await t.close(); }
});

test('Kategorie: Vorschlag und Auto-Einlagerung landen in der passenden Kiste', async () => {
  const t = await boot({ SEED_BOXES: 'true' });
  try {
    // Seeds: B1 Küche & Vorrat (96 l), B6 Dokumente & Papier (21,9 l)
    const suggest = await t.call('POST', '/api/suggest', {
      dims_cm: { length_cm: 30, width_cm: 20, height_cm: 20 },
      weight_g: 1500,
      category: 'Küche',
      name: 'Toaster',
    });
    assert.equal(suggest.status, 200);
    assert.equal(suggest.json.suggestion.best.box.code, 'B1');
    assert.equal(suggest.json.suggestion.best.box.category_match, true);

    const item = await t.call('POST', '/api/items', {
      name: 'Toaster',
      category: 'Küche',
      bin_id: 'auto',
      dims_cm: { length_cm: 30, width_cm: 20, height_cm: 20 },
      weight_g: 1500,
    });
    assert.equal(item.status, 201);
    assert.equal(item.json.item.bin.code, 'B1');
  } finally { await t.close(); }
});

test('Kisten manuell ausschließen: /api/suggest liefert die nächste passende', async () => {
  const t = await boot({ SEED_BOXES: 'true' });
  try {
    const first = await t.call('POST', '/api/suggest', {
      dims_cm: { length_cm: 20, width_cm: 20, height_cm: 20 },
      category: 'Küche',
    });
    const firstId = first.json.suggestion.best.box.id;

    const next = await t.call('POST', '/api/suggest', {
      dims_cm: { length_cm: 20, width_cm: 20, height_cm: 20 },
      category: 'Küche',
      exclude_box_ids: [firstId],
    });
    assert.equal(next.status, 200);
    assert.notEqual(next.json.suggestion.best.box.id, firstId);
    const excluded = next.json.suggestion.considered.find((c) => c.box_id === firstId);
    assert.equal(excluded.fits, false);

    // ohne Ausschluss ist die Kiste wieder dabei
    const again = await t.call('POST', '/api/suggest', {
      dims_cm: { length_cm: 20, width_cm: 20, height_cm: 20 },
      category: 'Küche',
    });
    assert.equal(again.json.suggestion.best.box.id, firstId);
  } finally { await t.close(); }
});

test('Manuell gewählte Kiste: Einlagern in Wunschkiste, 409 wenn voll', async () => {
  const t = await boot();
  try {
    const small = (await t.call('POST', '/api/bins', { code: 'K1', dims_cm: { length_cm: 25, width_cm: 25, height_cm: 25 } })).json.bin;
    const big = (await t.call('POST', '/api/bins', { code: 'K2', dims_cm: { length_cm: 60, width_cm: 40, height_cm: 40 } })).json.bin;

    const picked = await t.call('POST', '/api/items', {
      name: 'Bohrmaschine',
      bin_id: big.id,
      dims_cm: { length_cm: 30, width_cm: 20, height_cm: 20 },
    });
    assert.equal(picked.status, 201);
    assert.equal(picked.json.item.bin.code, 'K2');

    const tooBig = await t.call('POST', '/api/items', {
      name: 'Koffer',
      bin_id: small.id,
      dims_cm: { length_cm: 40, width_cm: 30, height_cm: 20 },
    });
    assert.equal(tooBig.status, 409);
    assert.match(tooBig.json.error, /kein freier Platz/i);
  } finally { await t.close(); }
});

test('Kiste voll: Markierung wirkt dauerhaft auf Vorschläge', async () => {
  const t = await boot({ SEED_BOXES: 'true' });
  try {
    // B6 (Dokumente, 21,9 l) passt für eine kleine Sache
    const before = await t.call('POST', '/api/suggest', {
      dims_cm: { length_cm: 20, width_cm: 15, height_cm: 10 },
    });
    const smallId = before.json.suggestion.best.box.id;

    const marked = await t.call('POST', `/api/bins/${smallId}/full`);
    assert.equal(marked.status, 200);
    assert.equal(marked.json.bin.marked_full, true);
    assert.ok(marked.json.bin.full_marked_at);

    // großer Gegenstand darf nicht mehr dorthin
    const big = await t.call('POST', '/api/suggest', {
      dims_cm: { length_cm: 30, width_cm: 22, height_cm: 18 },
      weight_g: 3000,
    });
    const considered = big.json.suggestion.considered.find((c) => c.box_id === smallId);
    assert.equal(considered.fits, false);
    assert.equal(considered.reason, 'marked_full');
    assert.match(considered.reason_text, /voll markiert/);

    // Kleinteil darf weiterhin hinein (wenn es die einzige passende Kiste wäre)
    const tiny = await t.call('POST', '/api/suggest', { dims_cm: { length_cm: 8, width_cm: 6, height_cm: 4 } });
    assert.equal(tiny.status, 200);
    assert.ok(tiny.json.suggestion.considered.find((c) => c.box_id === smallId));

    // Freigeben
    const freed = await t.call('DELETE', `/api/bins/${smallId}/full`);
    assert.equal(freed.status, 200);
    assert.equal(freed.json.bin.marked_full, false);

    const again = await t.call('POST', '/api/suggest', {
      dims_cm: { length_cm: 30, width_cm: 22, height_cm: 18 },
      weight_g: 3000,
    });
    assert.notEqual(again.json.suggestion.considered.find((c) => c.box_id === smallId).reason, 'marked_full');
  } finally { await t.close(); }
});

test('Artikel-Update: Beschreibung, Kaufdatum, Kaufpreis', async () => {
  const t = await boot();
  try {
    const bin = (await t.call('POST', '/api/bins', { code: 'A1', dims_cm: { length_cm: 60, width_cm: 40, height_cm: 40 } })).json.bin;
    const item = (await t.call('POST', '/api/items', { name: 'Zelt', bin_id: bin.id, dims_cm: { length_cm: 30, width_cm: 20, height_cm: 20 } })).json.item;

    const updated = await t.call('PUT', `/api/items/${item.id}`, {
      description: 'Vier-Personen-Zelt, selten genutzt',
      brand: 'Nordcamp',
      category: 'Outdoor',
      purchase_date: '2023-06-01',
      purchase_price: '149,95',
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.item.description, 'Vier-Personen-Zelt, selten genutzt');
    assert.equal(updated.json.item.purchase_date, '2023-06-01');
    assert.equal(updated.json.item.purchase_price, 149.95);
    assert.equal(updated.json.item.purchase_price_cents, 14995);

    const badDate = await t.call('PUT', `/api/items/${item.id}`, { purchase_date: '01.06.2023' });
    assert.equal(badDate.status, 400);
    const badPrice = await t.call('PUT', `/api/items/${item.id}`, { purchase_price: 'viel' });
    assert.equal(badPrice.status, 400);

    const stats = await t.call('GET', '/api/stats');
    assert.equal(stats.json.stats.purchase_value_eur, 149.95);

    const cleared = await t.call('PUT', `/api/items/${item.id}`, { purchase_price: null, purchase_date: null });
    assert.equal(cleared.json.item.purchase_price, null);
    assert.equal(cleared.json.item.purchase_date, null);
  } finally { await t.close(); }
});

test('Mehrere Fotos nachträglich hinzufügen und entfernen', async () => {
  const { default: sharp } = await import('sharp');
  const jpeg = async (r, g, b) => (await sharp({
    create: { width: 300, height: 220, channels: 3, background: { r, g, b } },
  }).jpeg().toBuffer()).toString('base64');

  const t = await boot({ MAX_IMAGES_PER_ITEM: '3' });
  try {
    const bin = (await t.call('POST', '/api/bins', { code: 'A1', dims_cm: { length_cm: 60, width_cm: 40, height_cm: 40 } })).json.bin;
    const item = (await t.call('POST', '/api/items', { name: 'Kabel', bin_id: bin.id, dims_cm: { length_cm: 10, width_cm: 10, height_cm: 5 } })).json.item;
    assert.equal(item.photos.length, 0);

    const added = await t.call('POST', `/api/items/${item.id}/photos`, {
      images: [`data:image/jpeg;base64,${await jpeg(200, 20, 20)}`, `data:image/jpeg;base64,${await jpeg(20, 200, 20)}`],
    });
    assert.equal(added.status, 200);
    assert.equal(added.json.item.photos.length, 2);
    assert.equal(added.json.item.photos[0], added.json.added[0]);
    assert.notEqual(added.json.item.photo_path, '');

    // Foto-Datei ist abrufbar
    const photoRes = await fetch(t.base + added.json.added[0]);
    assert.equal(photoRes.status, 200);
    assert.equal(photoRes.headers.get('content-type'), 'image/webp');

    // Limit greift
    const tooMany = await t.call('POST', `/api/items/${item.id}/photos`, {
      images: [`data:image/jpeg;base64,${await jpeg(20, 20, 200)}`, `data:image/jpeg;base64,${await jpeg(90, 90, 20)}`],
    });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.json.error, /Maximal 3 Fotos/);

    // drittes Foto einzeln, dann eines löschen
    const third = await t.call('POST', `/api/items/${item.id}/photos`, {
      images: [`data:image/jpeg;base64,${await jpeg(20, 20, 200)}`],
    });
    assert.equal(third.json.item.photos.length, 3);

    const name = third.json.item.photos[0].split('/').pop();
    const removed = await t.call('DELETE', `/api/items/${item.id}/photos/${name}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.json.item.photos.length, 2);
    const gone = await fetch(`${t.base}/api/photos/${name}`);
    assert.equal(gone.status, 404);
  } finally { await t.close(); }
});

test('Originalrechnung: PDF hochladen, ansehen, ersetzen, löschen', async () => {
  const { default: sharp } = await import('sharp');
  const png = (await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer()).toString('base64');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  const invoiceBody = {
    file: `data:application/pdf;base64,${pdf.toString('base64')}`,
    name: 'Rechnung_Zelt.pdf',
  };

  const t = await boot();
  try {
    const bin = (await t.call('POST', '/api/bins', { code: 'A1', dims_cm: { length_cm: 60, width_cm: 40, height_cm: 40 } })).json.bin;
    const item = (await t.call('POST', '/api/items', { name: 'Zelt', bin_id: bin.id, dims_cm: { length_cm: 30, width_cm: 20, height_cm: 20 } })).json.item;
    assert.equal(item.invoice_url, null);

    const uploaded = await t.call('POST', `/api/items/${item.id}/invoice`, invoiceBody);
    assert.equal(uploaded.status, 200);
    assert.equal(uploaded.json.item.invoice_name, 'Rechnung_Zelt.pdf');
    assert.match(uploaded.json.item.invoice_path, /\.pdf$/);

    const res = await fetch(t.base + uploaded.json.item.invoice_url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /Rechnung_Zelt\.pdf/);
    assert.ok((await res.arrayBuffer()).byteLength > 10);

    // ersetzen
    const replaced = await t.call('POST', `/api/items/${item.id}/invoice`, {
      file: `data:image/png;base64,${png}`,
      name: 'Rechnung_Scan.png',
    });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.json.item.invoice_name, 'Rechnung_Scan.png');

    const removed = await t.call('DELETE', `/api/items/${item.id}/invoice`);
    assert.equal(removed.status, 200);
    assert.equal(removed.json.item.invoice_url, null);
    const gone = await fetch(`${t.base}/api/items/${item.id}/invoice`);
    assert.equal(gone.status, 404);
  } finally { await t.close(); }
});

test('Paperless: Status, Suche und Rechnung übernehmen', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  const searches = [];
  const paperless = {
    isConfigured: true,
    authMode: 'token',
    config: { url: 'http://192.168.1.50:8000', results: 8 },
    async searchDocuments({ query, limit }) {
      searches.push({ query, limit });
      return [
        { id: 7, title: 'Rechnung Zelt 2023', created: '2023-06-02', correspondent: 'Camping Shop', document_type: 'Rechnung', tags: ['Outdoor'] },
        { id: 8, title: 'Rechnung Zelt 2022', created: '2022-05-01', correspondent: null, document_type: null, tags: [] },
      ];
    },
    async downloadDocument(id) {
      assert.equal(id, 7);
      return { buffer: pdf, contentType: 'application/pdf', filename: 'Rechnung_Zelt.pdf' };
    },
  };

  const t = await boot({}, null, paperless);
  try {
    const status = await t.call('GET', '/api/paperless/status');
    assert.equal(status.status, 200);
    assert.equal(status.json.configured, true);
    assert.equal(status.json.auth, 'token');

    const settings = await t.call('GET', '/api/settings');
    assert.equal(settings.json.effective.paperless_configured, true);

    const bin = (await t.call('POST', '/api/bins', { code: 'A1', dims_cm: { length_cm: 60, width_cm: 40, height_cm: 40 } })).json.bin;
    const item = (await t.call('POST', '/api/items', {
      name: 'Zelt', brand: 'Nordcamp', bin_id: bin.id, dims_cm: { length_cm: 30, width_cm: 20, height_cm: 20 },
    })).json.item;
    await t.call('PUT', `/api/items/${item.id}`, { purchase_date: '2023-06-01' });

    // Suche nutzt den Gegenstandsnamen als Vorschlag
    const search = await t.call('GET', `/api/items/${item.id}/invoice/search`);
    assert.equal(search.status, 200);
    assert.equal(search.json.query, 'Zelt Nordcamp 2023 Rechnung');
    assert.equal(search.json.results.length, 2);
    assert.equal(search.json.results[0].id, 7);
    assert.equal(searches[0].limit, 8);

    // eigener Suchbegriff
    const custom = await t.call('GET', `/api/items/${item.id}/invoice/search?q=Camping%20Shop`);
    assert.equal(custom.json.query, 'Camping Shop');

    // Rechnung übernehmen
    const attached = await t.call('POST', `/api/items/${item.id}/invoice/paperless`, { document_id: 7 });
    assert.equal(attached.status, 200);
    assert.equal(attached.json.item.invoice_source, 'paperless');
    assert.equal(attached.json.item.invoice_ref, '7');
    assert.equal(attached.json.item.invoice_name, 'Rechnung_Zelt.pdf');
    assert.match(attached.json.item.invoice_url, /invoice$/);

    const download = await fetch(t.base + attached.json.item.invoice_url);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/pdf');

    // ungültige ID
    const bad = await t.call('POST', `/api/items/${item.id}/invoice/paperless`, { document_id: 'abc' });
    assert.equal(bad.status, 400);
  } finally { await t.close(); }
});

test('Paperless: nicht konfiguriert -> 503 mit klarer Meldung', async () => {
  const t = await boot(); // kein paperlessOverride -> echter Client, aber ohne URL/Token
  try {
    const status = await t.call('GET', '/api/paperless/status');
    assert.equal(status.json.configured, false);

    const bin = (await t.call('POST', '/api/bins', { code: 'A1', dims_cm: { length_cm: 60, width_cm: 40, height_cm: 40 } })).json.bin;
    const item = (await t.call('POST', '/api/items', { name: 'Zelt', bin_id: bin.id, dims_cm: { length_cm: 30, width_cm: 20, height_cm: 20 } })).json.item;
    const search = await t.call('GET', `/api/items/${item.id}/invoice/search`);
    assert.equal(search.status, 503);
    assert.match(search.json.error, /PAPERLESS_URL/);

    const attach = await t.call('POST', `/api/items/${item.id}/invoice/paperless`, { document_id: 1 });
    assert.equal(attach.status, 503);
  } finally { await t.close(); }
});

test('Paperless nur mit Login: App holt den Token selbst über /api/token/', async () => {
  const { default: http } = await import('node:http');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  let tokenCalls = 0;
  const fake = http.createServer((req, res) => {
    if (req.url === '/api/token/') {
      if (req.method !== 'POST') { res.writeHead(405); res.end('{}'); return; }
      tokenCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: 'session-token' }));
      return;
    }
    if (req.headers.authorization !== 'Token session-token') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.url.startsWith('/api/documents/?')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        count: 1,
        results: [{ id: 7, title: 'Rechnung Toaster 2024', created: '2024-03-16', correspondent: { name: 'Elektro Shop' }, document_type: { name: 'Rechnung' }, tags: [{ name: 'Küche' }] }],
      }));
      return;
    }
    if (req.url === '/api/documents/7/download/') {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Rechnung_Toaster.pdf"' });
      res.end(pdf);
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const port = fake.address().port;

  const t = await boot({
    PAPERLESS_URL: `http://127.0.0.1:${port}`,
    PAPERLESS_USERNAME: 'storder',
    PAPERLESS_PASSWORD: 'geheim',
  });
  try {
    const status = await t.call('GET', '/api/paperless/status');
    assert.equal(status.json.configured, true);
    assert.equal(status.json.auth, 'login');

    const bin = (await t.call('POST', '/api/bins', { code: 'A1', dims_cm: { length_cm: 60, width_cm: 40, height_cm: 40 } })).json.bin;
    const item = (await t.call('POST', '/api/items', { name: 'Toaster', bin_id: bin.id, dims_cm: { length_cm: 30, width_cm: 20, height_cm: 20 } })).json.item;

    const search = await t.call('GET', `/api/items/${item.id}/invoice/search`);
    assert.equal(search.status, 200);
    assert.equal(search.json.results[0].title, 'Rechnung Toaster 2024');
    assert.ok(tokenCalls >= 1, 'Login wurde nicht aufgerufen');

    const attached = await t.call('POST', `/api/items/${item.id}/invoice/paperless`, { document_id: 7 });
    assert.equal(attached.status, 200);
    assert.equal(attached.json.item.invoice_source, 'paperless');
    assert.equal(attached.json.item.invoice_name, 'Rechnung_Toaster.pdf');

    const download = await fetch(t.base + attached.json.item.invoice_url);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/pdf');
    // Token wird gecacht: Suche + Download lösen keinen zweiten Login aus
    assert.equal(tokenCalls, 1);
  } finally {
    await t.close();
    await new Promise((resolve) => fake.close(resolve));
  }
});

test('Foto drehen: Maße tauschen, Datei wird ersetzt, 404 bei fremdem Foto', async () => {
  const { default: sharp } = await import('sharp');
  const jpeg = (await sharp({
    create: { width: 400, height: 200, channels: 3, background: { r: 10, g: 120, b: 200 } },
  }).jpeg().toBuffer()).toString('base64');

  const t = await boot();
  try {
    const bin = (await t.call('POST', '/api/bins', { code: 'A1', dims_cm: { length_cm: 60, width_cm: 40, height_cm: 40 } })).json.bin;
    const item = (await t.call('POST', '/api/items', { name: 'Kabel', bin_id: bin.id, dims_cm: { length_cm: 10, width_cm: 10, height_cm: 5 } })).json.item;

    const added = await t.call('POST', `/api/items/${item.id}/photos`, { images: [`data:image/jpeg;base64,${jpeg}`] });
    const photoPath = added.json.item.photos[0];
    const name = photoPath.split('/').pop();

    const before = await sharp(fs.readFileSync(path.join(t.config.dataDir, 'photos', name))).metadata();
    assert.equal(before.width, 400);
    assert.equal(before.height, 200);

    const rotated = await t.call('POST', `/api/items/${item.id}/photos/${name}/rotate`, { direction: 'right' });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.json.rotation, 90);
    const after = await sharp(fs.readFileSync(path.join(t.config.dataDir, 'photos', name))).metadata();
    assert.equal(after.width, 200, 'Breite nach rechts drehen');
    assert.equal(after.height, 400, 'Höhe nach rechts drehen');

    // 180° tauscht nicht, dreht aber das Bild
    await t.call('POST', `/api/items/${item.id}/photos/${name}/rotate`, { degrees: 180 });
    const after180 = await sharp(fs.readFileSync(path.join(t.config.dataDir, 'photos', name))).metadata();
    assert.equal(after180.width, 200);
    assert.equal(after180.height, 400);

    // links drehen
    const left = await t.call('POST', `/api/items/${item.id}/photos/${name}/rotate`, { direction: 'left' });
    assert.equal(left.json.rotation, 270);

    // Foto eines anderen Gegenstands
    const other = (await t.call('POST', '/api/items', { name: 'Anderes', dims_cm: { length_cm: 5, width_cm: 5, height_cm: 5 } })).json.item;
    const foreign = await t.call('POST', `/api/items/${other.id}/photos/${name}/rotate`, { direction: 'right' });
    assert.equal(foreign.status, 404);

    // ungültiger Name
    const bad = await t.call('POST', `/api/items/${item.id}/photos/..%2Fpasswd/rotate`, { direction: 'right' });
    assert.ok([400, 404].includes(bad.status));
  } finally { await t.close(); }
});

test('Doppelklick-Schutz: gleicher Name + Kiste in 10 s wird abgelehnt', async () => {
  const t = await boot();
  try {
    const bin = (await t.call('POST', '/api/bins', { code: 'A1', dims_cm: { length_cm: 80, width_cm: 60, height_cm: 60 } })).json.bin;
    const bin2 = (await t.call('POST', '/api/bins', { code: 'A2', dims_cm: { length_cm: 80, width_cm: 60, height_cm: 60 } })).json.bin;
    const body = { name: 'Koffer', bin_id: bin.id, dims_cm: { length_cm: 50, width_cm: 30, height_cm: 20 } };

    const first = await t.call('POST', '/api/items', body);
    assert.equal(first.status, 201);

    const second = await t.call('POST', '/api/items', body);
    assert.equal(second.status, 409);
    assert.equal(second.json.code, 'DUPLICATE_ITEM');
    assert.equal((await t.call('GET', '/api/items')).json.items.length, 1);

    // anderer Name oder andere Kiste ist erlaubt
    assert.equal((await t.call('POST', '/api/items', { ...body, name: 'Koffer 2' })).status, 201);
    assert.equal((await t.call('POST', '/api/items', { ...body, bin_id: bin2.id })).status, 201);
    assert.equal((await t.call('GET', '/api/items')).json.items.length, 3);
  } finally { await t.close(); }
});

test('Ähnliche Artikel: findet vorhandene Kiste (auch Komposita)', async () => {
  const t = await boot();
  try {
    const bin = (await t.call('POST', '/api/bins', { code: 'B1', name: 'Kabel & Elektronik', dims_cm: { length_cm: 100, width_cm: 60, height_cm: 60 } })).json.bin;
    const xbox = await t.call('POST', '/api/items', {
      name: 'Xbox Controller', category: 'Elektronik', bin_id: bin.id, dims_cm: { length_cm: 20, width_cm: 15, height_cm: 8 },
    });
    const sauger = await t.call('POST', '/api/items', {
      name: 'Staubsauger', category: 'Haushalt', bin_id: bin.id, dims_cm: { length_cm: 40, width_cm: 30, height_cm: 30 },
    });
    assert.equal(xbox.status, 201);
    assert.equal(sauger.status, 201);

    const similar = await t.call('GET', '/api/items/similar?q=Xbox%20Zubehör');
    assert.equal(similar.status, 200);
    assert.ok(similar.json.items.length >= 1, 'kein Treffer');
    assert.equal(similar.json.items[0].name, 'Xbox Controller');
    assert.equal(similar.json.items[0].bin.code, 'B1');
    assert.ok(similar.json.items[0].score >= 0.34);

    // Kompositum: "Staubsaugerzubehör" trifft "Staubsauger"
    const compound = await t.call('GET', `/api/items/similar?q=${encodeURIComponent('Staubsaugerzubehör')}`);
    assert.equal(compound.json.items[0]?.name, 'Staubsauger');

    const none = await t.call('GET', '/api/items/similar?q=Kochtopf');
    assert.equal(none.json.items.length, 0);
  } finally { await t.close(); }
});

test('Stückzahl über die API: speichern, ändern, validieren', async () => {
  const t = await boot();
  try {
    const bin = (await t.call('POST', '/api/bins', { code: 'B1', dims_cm: { length_cm: 100, width_cm: 60, height_cm: 60 } })).json.bin;
    const created = await t.call('POST', '/api/items', {
      name: 'Toaster', bin_id: bin.id, dims_cm: { length_cm: 30, width_cm: 20, height_cm: 20 }, quantity: 6,
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.item.quantity, 6);

    const binState = await t.call('GET', `/api/bins/${bin.id}`);
    assert.ok(binState.json.bin.used_liters > 90, `used=${binState.json.bin.used_liters}`);

    const updated = await t.call('PUT', `/api/items/${created.json.item.id}`, { quantity: 2 });
    assert.equal(updated.json.item.quantity, 2);

    for (const bad of [0, -3, 'abc', 10000]) {
      const res = await t.call('PUT', `/api/items/${created.json.item.id}`, { quantity: bad });
      assert.equal(res.status, 400, `quantity=${bad}`);
    }
  } finally { await t.close(); }
});

test('Vorschlag mit bevorzugter Kiste (ähnlicher Artikel)', async () => {
  const t = await boot({ SEED_BOXES: 'true' });
  try {
    const bins = (await t.call('GET', '/api/bins')).json.bins;
    const normal = await t.call('POST', '/api/suggest', { dims_cm: { length_cm: 20, width_cm: 15, height_cm: 10 } });
    const normalId = normal.json.suggestion.best.box.id;
    // eine andere, ebenfalls passende Kiste bevorzugen
    const other = bins.find((b) => b.id !== normalId && b.active && b.code !== 'B6');
    const preferred = await t.call('POST', '/api/suggest', {
      dims_cm: { length_cm: 20, width_cm: 15, height_cm: 10 },
      prefer_box_id: other.id,
    });
    assert.equal(preferred.json.suggestion.best.box.id, other.id);
  } finally { await t.close(); }
});

test('Kistenfoto: hochladen, abrufen, entfernen, mit Kiste löschen', async () => {
  const { default: sharp } = await import('sharp');
  const jpeg = (await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 200, g: 120, b: 40 } },
  }).jpeg().toBuffer()).toString('base64');

  const t = await boot();
  try {
    const bin = (await t.call('POST', '/api/bins', { code: 'F1', name: 'Foto-Kiste', dims_cm: { length_cm: 50, width_cm: 40, height_cm: 40 } })).json.bin;
    assert.equal(bin.photo_url, null);

    const uploaded = await t.call('POST', `/api/bins/${bin.id}/photo`, { image: `data:image/jpeg;base64,${jpeg}` });
    assert.equal(uploaded.status, 200);
    assert.match(uploaded.json.bin.photo_url, new RegExp(`/api/bins/${bin.id}/photo$`));

    const res = await fetch(t.base + uploaded.json.bin.photo_url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/webp');
    const stored = Buffer.from(await res.arrayBuffer());
    assert.ok(stored.length > 100);
    const binPhotoMeta = await sharp(stored).metadata();
    assert.equal(binPhotoMeta.format, 'webp');
    assert.equal(binPhotoMeta.width, 320);

    const removed = await t.call('DELETE', `/api/bins/${bin.id}/photo`);
    assert.equal(removed.json.bin.photo_url, null);
    assert.equal((await fetch(t.base + `/api/bins/${bin.id}/photo`)).status, 404);

    // Foto setzen und Kiste löschen -> Datei verschwindet
    const again = await t.call('POST', `/api/bins/${bin.id}/photo`, { image: `data:image/jpeg;base64,${jpeg}` });
    const name = again.json.bin.photo_path.split('/').pop();
    await t.call('DELETE', `/api/bins/${bin.id}`);
    const photoPath = path.join(t.config.dataDir, 'photos', name);
    assert.equal(fs.existsSync(photoPath), false);
  } finally { await t.close(); }
});

test('Kiste löschen: optional mit Inhalt (inkl. Dateien)', async () => {
  const { default: sharp } = await import('sharp');
  const jpeg = (await sharp({
    create: { width: 240, height: 180, channels: 3, background: { r: 30, g: 90, b: 200 } },
  }).jpeg().toBuffer()).toString('base64');

  const t = await boot();
  try {
    // Kiste ohne Inhalt
    const empty = (await t.call('POST', '/api/bins', { code: 'L0', dims_cm: { length_cm: 50, width_cm: 40, height_cm: 40 } })).json.bin;
    assert.equal((await t.call('DELETE', `/api/bins/${empty.id}`)).json.deleted, true);

    // Kiste mit Inhalt: "nur Kiste" -> Gegenstand bleibt
    const keep = (await t.call('POST', '/api/bins', { code: 'L1', dims_cm: { length_cm: 60, width_cm: 40, height_cm: 40 } })).json.bin;
    const item = (await t.call('POST', '/api/items', { name: 'Bohrer', bin_id: keep.id, dims_cm: { length_cm: 20, width_cm: 15, height_cm: 10 } })).json.item;
    const delKeep = await t.call('DELETE', `/api/bins/${keep.id}`);
    assert.equal(delKeep.status, 200);
    assert.equal(delKeep.json.deleted_items, 0);
    const kept = await t.call('GET', `/api/items/${item.id}`);
    assert.equal(kept.status, 200);
    assert.equal(kept.json.item.bin_id, null);

    // Kiste mit Inhalt: with_items=1 -> Gegenstand + Foto weg
    const purge = (await t.call('POST', '/api/bins', { code: 'L2', dims_cm: { length_cm: 60, width_cm: 40, height_cm: 40 } })).json.bin;
    const item2 = (await t.call('POST', '/api/items', { name: 'Bohrer 2', bin_id: purge.id, dims_cm: { length_cm: 20, width_cm: 15, height_cm: 10 } })).json.item;
    const withPhoto = await t.call('POST', `/api/items/${item2.id}/photos`, { images: [`data:image/jpeg;base64,${jpeg}`] });
    const photoPath = withPhoto.json.item.photos[0];
    const photoFile = path.join(t.config.dataDir, 'photos', photoPath.split('/').pop());
    assert.ok(fs.existsSync(photoFile));

    const delAll = await t.call('DELETE', `/api/bins/${purge.id}?with_items=1`);
    assert.equal(delAll.status, 200);
    assert.equal(delAll.json.deleted_items, 1);
    assert.equal((await t.call('GET', `/api/items/${item2.id}`)).status, 404);
    assert.equal(fs.existsSync(photoFile), false);

    // unbekannte Kiste
    assert.equal((await t.call('DELETE', '/api/bins/9999')).status, 404);
  } finally { await t.close(); }
});

test('Maße ändern: neu platzieren, Volumen neu berechnen, 409 wenn zu groß', async () => {
  const t = await boot();
  try {
    const bin = (await t.call('POST', '/api/bins', { code: 'A1', dims_cm: { length_cm: 60, width_cm: 40, height_cm: 40 } })).json.bin;
    const item = (await t.call('POST', '/api/items', {
      name: 'Koffer', bin_id: bin.id, dims_cm: { length_cm: 30, width_cm: 20, height_cm: 20 }, weight_g: 1500,
    })).json.item;
    const oldVolume = item.volume_liters;

    const changed = await t.call('PUT', `/api/items/${item.id}`, {
      dims_cm: { length_cm: 50, width_cm: 35, height_cm: 30 },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.item.dims_cm.length_cm, 50);
    assert.equal(changed.json.item.dims_cm.height_cm, 30);
    assert.ok(changed.json.item.volume_liters > oldVolume, `${changed.json.item.volume_liters} > ${oldVolume}`);
    assert.ok(Math.abs(changed.json.item.size_cm[0] - 50 * 1.08) < 0.01, JSON.stringify(changed.json.item.size_cm));
    assert.equal(changed.json.item.bin_id, bin.id);

    // zu groß für die Kiste -> 409, nichts geändert
    const tooBig = await t.call('PUT', `/api/items/${item.id}`, {
      dims_cm: { length_cm: 60, width_cm: 40, height_cm: 40 },
    });
    assert.equal(tooBig.status, 409);
    assert.match(tooBig.json.error, /passen nicht mehr/);
    const after = (await t.call('GET', `/api/items/${item.id}`)).json.item;
    assert.equal(after.dims_cm.length_cm, 50);

    // unvollständige Maße -> 400
    const bad = await t.call('PUT', `/api/items/${item.id}`, { dims_cm: { length_cm: 10 } });
    assert.equal(bad.status, 400);

    // Gegenstand ohne Kiste: Maße einfach speichern
    const loose = (await t.call('POST', '/api/items', { name: 'Lose', dims_cm: { length_cm: 10, width_cm: 10, height_cm: 10 } })).json.item;
    const updated = await t.call('PUT', `/api/items/${loose.id}`, { dims_cm: { length_cm: 25, width_cm: 20, height_cm: 15 } });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.item.dims_cm.length_cm, 25);
    assert.equal(updated.json.item.bin_id, null);
  } finally { await t.close(); }
});

test('Posteingang: Schnell-Erfassung, Liste, Stapel-Einlagerung', async () => {
  const { default: sharp } = await import('sharp');
  const jpeg = (await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 30, g: 120, b: 90 } },
  }).jpeg().toBuffer()).toString('base64');

  const t = await boot({ SEED_BOXES: 'true' });
  try {
    // 1) Schnell-Erfassung ohne Formular
    const quick = await t.call('POST', '/api/inbox', { image: `data:image/jpeg;base64,${jpeg}`, hint: 'Bohrmaschine' });
    assert.equal(quick.status, 201);
    assert.equal(quick.json.item.bin_id, null);
    assert.equal(quick.json.item.name, 'Bohrmaschine');
    assert.equal(quick.json.auto_named, false);
    assert.match(quick.json.image_data_url, /^data:image\/jpeg;base64,/);
    assert.match(quick.json.item.photo_path, /\.webp$/);
    assert.equal(quick.json.inbox_count, 1);

    // ohne Hinweis wird ein Fallback-Name vergeben
    const unnamed = await t.call('POST', '/api/inbox', { image: `data:image/jpeg;base64,${jpeg}` });
    assert.equal(unnamed.status, 201);
    assert.equal(unnamed.json.auto_named, true);
    assert.match(unnamed.json.item.name, /^Foto /);

    const list = await t.call('GET', '/api/inbox');
    assert.equal(list.json.count, 2);
    assert.deepEqual(list.json.items.map((i) => i.bin_id), [null, null]);

    // 2) ohne Maße kann nicht eingelagert werden
    const noDims = await t.call('POST', '/api/inbox/assign', {});
    assert.equal(noDims.status, 200);
    assert.equal(noDims.json.assigned.length, 0);
    assert.equal(noDims.json.failed.length, 2);
    assert.match(noDims.json.failed[0].reason, /Maße|größer|Platz/i);

    // 3) Maße ergänzen (wie nach der Analyse) und stapelweise einlagern
    for (const item of list.json.items) {
      await t.call('PUT', `/api/items/${item.id}`, {
        dims_cm: { length_cm: 25, width_cm: 18, height_cm: 12 },
        weight_g: 1200,
        category: 'Werkzeug',
        name: item.name,
      });
    }
    const assigned = await t.call('POST', '/api/inbox/assign', {});
    assert.equal(assigned.json.assigned.length, 2);
    assert.equal(assigned.json.failed.length, 0);
    assert.ok(assigned.json.assigned.every((a) => a.bin));

    const after = await t.call('GET', '/api/inbox');
    assert.equal(after.json.count, 0);
    const stats = await t.call('GET', '/api/stats');
    assert.equal(stats.json.stats.items_inbox, 0);

    // 4) gezielte Einlagerung nur bestimmter IDs
    const third = await t.call('POST', '/api/inbox', { image: `data:image/jpeg;base64,${jpeg}`, hint: 'Zange' });
    await t.call('PUT', `/api/items/${third.json.item.id}`, { dims_cm: { length_cm: 20, width_cm: 8, height_cm: 5 } });
    const one = await t.call('POST', '/api/inbox/assign', { ids: [third.json.item.id] });
    assert.equal(one.json.assigned.length, 1);
    assert.equal(one.json.assigned[0].name, 'Zange');
  } finally { await t.close(); }
});

test('Posteingang: Artikel ohne Kiste kommen nicht in die Prüf-Erinnerung', async () => {
  const t = await boot({ RECALL_MIN_ITEM_AGE_DAYS: '0' });
  try {
    await t.call('POST', '/api/items', { name: 'Lose Sache', dims_cm: { length_cm: 10, width_cm: 10, height_cm: 5 } });
    const recall = await t.call('GET', '/api/recall');
    assert.equal(recall.status, 200);
    assert.equal(recall.json.items.length, 0);
  } finally { await t.close(); }
});

test('Suche: Kategorien-Liste und Filter', async () => {
  const t = await boot();
  try {
    const bin = (await t.call('POST', '/api/bins', { code: 'A1', dims_cm: { length_cm: 100, width_cm: 60, height_cm: 60 } })).json.bin;
    await t.call('POST', '/api/items', { name: 'Bohrer', category: 'Werkzeug', bin_id: bin.id, dims_cm: { length_cm: 20, width_cm: 10, height_cm: 10 } });
    await t.call('POST', '/api/items', { name: 'Schraube', category: 'Werkzeug', bin_id: bin.id, dims_cm: { length_cm: 5, width_cm: 5, height_cm: 5 } });
    await t.call('POST', '/api/items', { name: 'Toaster', category: 'Küche', bin_id: bin.id, dims_cm: { length_cm: 30, width_cm: 20, height_cm: 20 } });
    await t.call('POST', '/api/items', { name: 'Kabel', bin_id: bin.id, dims_cm: { length_cm: 10, width_cm: 10, height_cm: 5 } });

    const cats = await t.call('GET', '/api/categories');
    assert.equal(cats.status, 200);
    const byName = Object.fromEntries(cats.json.categories.map((c) => [c.name, c.count]));
    assert.equal(byName.Werkzeug, 2);
    assert.equal(byName['Küche'], 1);
    assert.equal(Object.keys(byName).length, 2); // leere Kategorie zählt nicht

    const filtered = await t.call('GET', '/api/search?categories=Werkzeug');
    assert.deepEqual(filtered.json.items.map((i) => i.name).sort(), ['Bohrer', 'Schraube']);

    const two = await t.call('GET', '/api/search?category=Werkzeug&category=K%C3%BCche');
    assert.equal(two.json.items.length, 3);

    const combined = await t.call('GET', '/api/search?q=toaster&categories=Werkzeug');
    assert.equal(combined.json.items.length, 0);
  } finally { await t.close(); }
});
