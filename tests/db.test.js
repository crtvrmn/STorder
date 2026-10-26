// Integrationstests für die SQLite-Schicht (src/db.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  openDatabase,
  getSettings,
  setSettings,
  listBins,
  getBin,
  createBin,
  updateBin,
  deleteBin,
  listItems,
  deleteBinWithItems,
  getItem,
  createItem,
  updateItem,
  moveItem,
  deleteItem,
  searchItems,
  pickRecallItems,
  reviewItem,
  listReviews,
  countItems,
  stats,
  seedBins,
  markBinFull,
  addItemPhotos,
  removeItemPhoto,
  setItemInvoice,
  clearItemInvoice,
  setBinPhoto,
} from '../src/db.js';

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storder-test-'));
  const { db, file } = openDatabase(dir);
  return { db, file, dir };
}

const dims = (l, w, h) => ({ length_cm: l, width_cm: w, height_cm: h });

test('openDatabase legt Datei und Schema an', () => {
  const { db, file } = freshDb();
  assert.ok(fs.existsSync(file));
  assert.deepEqual(stats(db).bins, 0);
  db.close();
});

test('Settings werden als JSON gespeichert und gelesen', () => {
  const { db } = freshDb();
  assert.deepEqual(getSettings(db), {});
  const all = setSettings(db, { recall_interval_days: 45, llm_model: 'x/y', recall_enabled: true });
  assert.equal(all.recall_interval_days, 45);
  assert.equal(all.llm_model, 'x/y');
  assert.equal(getSettings(db).recall_enabled, true);
  db.close();
});

test('createBin speichert Maße, Achsen und Analyse', () => {
  const { db } = freshDb();
  const bin = createBin(db, { code: 'a23', name: 'Küche', location: 'Regal 1', dims_cm: dims(50, 40, 40) });
  assert.equal(bin.code, 'A23');
  assert.deepEqual(bin.inner_dims, { a: 50, b: 40, c: 40 });
  assert.deepEqual(bin.extents_cm, [50, 40, 40]);
  assert.equal(bin.capacity_liters, 80);
  assert.equal(bin.used_liters, 0);
  assert.equal(bin.free_liters, 80);
  assert.equal(bin.fill_percent, 0);
  assert.equal(bin.item_count, 0);
  assert.equal(bin.active, true);

  const raw = createBin(db, { code: 'B1', length_cm: 30, width_cm: 20, height_cm: 10 });
  assert.equal(raw.capacity_liters, 6);

  assert.throws(() => createBin(db, { code: 'C1' }), /Länge, Breite und Höhe/);
  assert.throws(() => createBin(db, { dims_cm: dims(10, 10, 10) }), /Kürzel/);
  assert.throws(() => createBin(db, { code: 'A23', dims_cm: dims(10, 10, 10) }), /gibt es schon/);
  db.close();
});

test('updateBin und deleteBin', () => {
  const { db } = freshDb();
  const bin = createBin(db, { code: 'A23', dims_cm: dims(50, 40, 40) });
  const updated = updateBin(db, bin.id, { name: 'Neu', length_cm: 60, width_cm: 50, height_cm: 50, active: false });
  assert.equal(updated.name, 'Neu');
  assert.equal(updated.capacity_liters, 150);
  assert.equal(updated.active, false);
  assert.throws(() => updateBin(db, 9999, { name: 'x' }), /nicht gefunden/);

  const a = createBin(db, { code: 'A1', dims_cm: dims(10, 10, 10) });
  const b = createBin(db, { code: 'A2', dims_cm: dims(10, 10, 10) });
  assert.throws(() => updateBin(db, b.id, { code: 'A1' }), /gibt es schon/);
  assert.equal(deleteBin(db, a.id), true);
  assert.equal(deleteBin(db, a.id), false);
  db.close();
});

test('createItem platziert in der Kiste und liefert Position/Maße', () => {
  const { db } = freshDb();
  const bin = createBin(db, { code: 'A23', dims_cm: dims(50, 40, 40) });
  const item = createItem(db, {
    bin_id: bin.id,
    name: 'Toaster',
    description: 'Doppel-Slot-Toaster',
    brand: 'Test',
    category: 'Küche',
    dims_cm: dims(30, 20, 20),
    weight_g: 1500,
    shape: 'cuboid',
  });
  assert.equal(item.name, 'Toaster');
  assert.equal(item.bin.code, 'A23');
  assert.equal(item.status, 'stored');
  assert.ok(item.id > 0);
  // Größe inkl. Toleranz, an der Wand gepackt
  assert.deepEqual(item.position, { x_cm: 0, y_cm: 0, z_cm: 0 });
  assert.ok(Math.abs(item.size_cm[0] - 30 * 1.08) < 0.01);
  assert.ok(item.volume_liters > 12);
  assert.equal(item.volume_method, 'dimensions');

  const after = getBin(db, bin.id);
  assert.equal(after.item_count, 1);
  assert.ok(after.used_liters > 14);
  assert.ok(after.fill_percent > 17);

  assert.throws(() => createItem(db, {}), /Namen/);
  assert.throws(() => createItem(db, { name: 'X', bin_id: 9999, dims_cm: dims(5, 5, 5) }), /Kiste nicht gefunden/);
  db.close();
});

test('createItem ohne Kiste ist erlaubt (nur katalogisiert)', () => {
  const { db } = freshDb();
  const item = createItem(db, { name: 'Kabel', dims_cm: dims(10, 10, 3) });
  assert.equal(item.bin_id, null);
  assert.equal(item.bin, null);
  assert.equal(item.status, 'stored');
  db.close();
});

test('createItem meldet volle Kiste', () => {
  const { db } = freshDb();
  const bin = createBin(db, { code: 'K', dims_cm: dims(20, 20, 20) });
  createItem(db, { bin_id: bin.id, name: 'A', dims_cm: dims(18, 18, 18) });
  assert.throws(
    () => createItem(db, { bin_id: bin.id, name: 'B', dims_cm: dims(18, 18, 18) }),
    /kein freier Platz|kein Platz/i,
  );
  db.close();
});

test('createItem respektiert manuelles Volumen und Größenangaben', () => {
  const { db } = freshDb();
  const bin = createBin(db, { code: 'K', dims_cm: dims(40, 40, 40) });
  const item = createItem(db, { bin_id: bin.id, name: 'Kissen', volume_liters: 20, dims_cm: dims(30, 30, 20) });
  assert.equal(item.volume_liters, 20);
  assert.equal(item.volume_method, 'manual');
  db.close();
});

test('updateItem, moveItem und Gewichts-/Füllstandsanpassung', () => {
  const { db } = freshDb();
  const a = createBin(db, { code: 'A1', dims_cm: dims(50, 40, 40) });
  const b = createBin(db, { code: 'A2', dims_cm: dims(50, 40, 40) });
  const item = createItem(db, { bin_id: a.id, name: 'Bohrmaschine', dims_cm: dims(30, 20, 20), weight_g: 2000 });

  const renamed = updateItem(db, item.id, { name: 'Bohrhammer', brand: 'Makita' });
  assert.equal(renamed.name, 'Bohrhammer');
  assert.equal(renamed.brand, 'Makita');

  const moved = moveItem(db, item.id, b.id);
  assert.equal(moved.bin.code, 'A2');

  assert.throws(() => moveItem(db, item.id, 9999), /Kiste nicht gefunden/);
  assert.throws(() => moveItem(db, 9999, a.id), /Gegenstand nicht gefunden/);

  const out = updateItem(db, item.id, { status: 'discarded' });
  assert.equal(out.status, 'discarded');
  out && assert.equal(countItems(db, 'discarded'), 1);
  assert.equal(countItems(db, 'stored'), 0);
  db.close();
});

test('searchItems findet über Name, Kategorie und Kisten-Code', () => {
  const { db } = freshDb();
  const bin = createBin(db, { code: 'WERK1', location: 'Werkstatt', dims_cm: dims(50, 40, 40) });
  createItem(db, { bin_id: bin.id, name: 'Akkuschrauber', category: 'Werkzeug', dims_cm: dims(25, 25, 10) });
  createItem(db, { bin_id: bin.id, name: 'Bohrfutter', description: 'für Akkuschrauber', dims_cm: dims(10, 10, 10) });
  createItem(db, { name: 'Kochtopf', category: 'Küche', dims_cm: dims(25, 25, 15) });

  assert.equal(searchItems(db, 'schrauber').length, 2);
  assert.equal(searchItems(db, 'Bohrfutter').length, 1);
  assert.equal(searchItems(db, 'werkstatt').length, 2); // über Kisten-Ort
  assert.equal(searchItems(db, 'WERK1').length, 2);
  assert.equal(searchItems(db, 'Küche').length, 1);
  assert.equal(searchItems(db, 'gibtsnicht').length, 0);
  assert.equal(searchItems(db, '').length, 3);
  assert.equal(searchItems(db, '', { status: 'discarded' }).length, 0);
  db.close();
});

test('reviewItem verbucht keep/discard und setzt den nächsten Termin', () => {
  const { db } = freshDb();
  const bin = createBin(db, { code: 'A1', dims_cm: dims(50, 40, 40) });
  const item = createItem(db, { bin_id: bin.id, name: 'Zelt', dims_cm: dims(30, 20, 20) });

  const kept = reviewItem(db, item.id, 'keep', { note: 'benutze ich', intervalDays: 60 });
  assert.equal(kept.keep_count, 1);
  assert.equal(kept.status, 'stored');
  assert.ok(kept.next_review_at);

  // 'unused' heißt: behalten, aber lange nicht genutzt -> zählt als "behalten"
  const unused = reviewItem(db, item.id, 'unused', { intervalDays: 10 });
  assert.equal(unused.keep_count, 2);
  assert.equal(unused.status, 'stored');

  const notFound = reviewItem(db, item.id, 'not_found');
  assert.equal(notFound.status, 'stored');

  const discarded = reviewItem(db, item.id, 'discard', { note: 'kaputt' });
  assert.equal(discarded.status, 'discarded');
  assert.equal(discarded.discard_count, 1);
  assert.ok(discarded.discarded_at);

  assert.throws(() => reviewItem(db, 9999, 'keep'), /nicht gefunden/);

  const reviews = listReviews(db, item.id);
  assert.equal(reviews.length, 4);
  assert.equal(listReviews(db).length, 4);
  db.close();
});

test('pickRecallItems liefert fällige Gegenstände und respektiert Mindestalter', () => {
  const { db } = freshDb();
  const bin = createBin(db, { code: 'A1', dims_cm: dims(80, 60, 60) });
  for (let i = 0; i < 5; i++) {
    createItem(db, { bin_id: bin.id, name: `Teil ${i}`, dims_cm: dims(15, 15, 15) });
  }
  const picked = pickRecallItems(db, { count: 3, minAgeDays: 0, maxItems: 3 });
  assert.equal(picked.length, 3);
  const noneYet = pickRecallItems(db, { count: 3, minAgeDays: 14 });
  assert.equal(noneYet.length, 0); // gerade erst eingelagert
  db.close();
});

test('stats fasst Kisten, Gegenstände und Volumen zusammen', () => {
  const { db } = freshDb();
  const a = createBin(db, { code: 'A1', dims_cm: dims(50, 40, 40) });
  createBin(db, { code: 'A2', dims_cm: dims(30, 30, 30), active: false });
  createItem(db, { bin_id: a.id, name: 'Toaster', dims_cm: dims(30, 20, 20), weight_g: 1500 });

  const s = stats(db);
  assert.equal(s.bins, 2);
  assert.equal(s.active_bins, 1);
  assert.equal(s.items_stored, 1);
  assert.equal(s.items_discarded, 0);
  assert.equal(s.capacity_liters, 107);
  assert.ok(s.used_liters > 14 && s.used_liters < 16);
  assert.ok(s.free_liters > 90);
  assert.equal(s.weight_kg, 1.5);
  db.close();
});

test('seedBins legt Standardkisten nur bei leerer Datenbank an', () => {
  const { db } = freshDb();
  const seeds = [
    { code: 'B1', name: 'Küche & Vorrat', location: 'Regal 1', length_cm: 60, width_cm: 40, height_cm: 40 },
    { code: 'B2', name: 'Werkzeug', location: 'Regal 2', length_cm: 60, width_cm: 40, height_cm: 40 },
    { code: 'B3', name: 'Zu groß', length_cm: 0, width_cm: 0, height_cm: 0 },
  ];
  const r = seedBins(db, seeds);
  assert.equal(r.created, 2);
  assert.equal(r.skipped, 1);
  assert.equal(seedBins(db, seeds).created, 0);
  assert.equal(listBins(db).length, 2);
  assert.equal(listBins(db, { activeOnly: true }).length, 2);
  db.close();
});

test('deleteItem entfernt den Gegenstand, Kiste wird wieder leerer', () => {
  const { db } = freshDb();
  const bin = createBin(db, { code: 'A1', dims_cm: dims(50, 40, 40) });
  const item = createItem(db, { bin_id: bin.id, name: 'Staubsauger', dims_cm: dims(30, 30, 30) });
  assert.equal(getBin(db, bin.id).item_count, 1);
  assert.equal(deleteItem(db, item.id), true);
  assert.equal(getItem(db, item.id), null);
  assert.equal(getBin(db, bin.id).item_count, 0);
  assert.equal(deleteItem(db, item.id), false);
  db.close();
});

test('Kiste als voll markieren und wieder freigeben', () => {
  const { db } = freshDb();
  const bin = createBin(db, { code: 'A23', dims_cm: dims(50, 40, 40) });
  assert.equal(bin.marked_full, false);
  assert.equal(bin.full_marked_at, null);

  const marked = markBinFull(db, bin.id, true);
  assert.equal(marked.marked_full, true);
  assert.ok(marked.full_marked_at);

  const freed = markBinFull(db, bin.id, false);
  assert.equal(freed.marked_full, false);
  assert.equal(freed.full_marked_at, null);

  assert.throws(() => markBinFull(db, 9999, true), /nicht gefunden/);
  db.close();
});

test('Kaufdaten: Datum, Preis in Cent und Summe in stats', () => {
  const { db } = freshDb();
  const bin = createBin(db, { code: 'A1', dims_cm: dims(50, 40, 40) });
  const item = createItem(db, {
    bin_id: bin.id,
    name: 'Bohrmaschine',
    dims_cm: dims(30, 20, 20),
    purchase_date: '2024-03-15',
    purchase_price: '129,99',
    invoice_path: '1-abc.pdf',
    invoice_name: 'Rechnung_Bohrmaschine.pdf',
  });
  assert.equal(item.purchase_date, '2024-03-15');
  assert.equal(item.purchase_price_cents, 12999);
  assert.equal(item.purchase_price, 129.99);
  assert.equal(item.invoice_name, 'Rechnung_Bohrmaschine.pdf');
  assert.match(item.invoice_url, /^\/api\/items\/\d+\/invoice$/);

  const updated = updateItem(db, item.id, { purchase_price: 99.5, purchase_date: '2023-12-24' });
  assert.equal(updated.purchase_price_cents, 9950);
  assert.equal(updated.purchase_date, '2023-12-24');

  const cleared = updateItem(db, item.id, { purchase_price: null, purchase_date: null });
  assert.equal(cleared.purchase_price_cents, null);
  assert.equal(cleared.purchase_date, null);

  updateItem(db, item.id, { purchase_price: '10,00' });
  assert.equal(stats(db).purchase_value_eur, 10);
  db.close();
});

test('Fotos hinzufügen und entfernen', () => {
  const { db } = freshDb();
  const bin = createBin(db, { code: 'A1', dims_cm: dims(50, 40, 40) });
  const item = createItem(db, { bin_id: bin.id, name: 'Kabel', dims_cm: dims(10, 10, 5), photos: ['/api/photos/a.jpg'] });
  assert.deepEqual(item.photos, ['/api/photos/a.jpg']);
  assert.equal(item.photo_path, '/api/photos/a.jpg');

  const more = addItemPhotos(db, item.id, ['/api/photos/b.jpg', '/api/photos/a.jpg', 'ungueltig']);
  assert.deepEqual(more.photos, ['/api/photos/a.jpg', '/api/photos/b.jpg']);

  assert.throws(() => addItemPhotos(db, item.id, []), /Keine gültigen Fotos/);

  const removed = removeItemPhoto(db, item.id, '/api/photos/a.jpg');
  assert.deepEqual(removed.photos, ['/api/photos/b.jpg']);
  assert.equal(removed.photo_path, '/api/photos/b.jpg');

  const empty = removeItemPhoto(db, item.id, '/api/photos/b.jpg');
  assert.deepEqual(empty.photos, []);
  assert.equal(empty.photo_path, '');
  db.close();
});

test('Rechnung hinterlegen und entfernen', () => {
  const { db } = freshDb();
  const bin = createBin(db, { code: 'A1', dims_cm: dims(50, 40, 40) });
  const item = createItem(db, { bin_id: bin.id, name: 'Zelt', dims_cm: dims(30, 20, 20) });
  assert.equal(item.invoice_url, null);

  const withInvoice = setItemInvoice(db, item.id, { path: '7-abc.pdf', name: 'Zelt_Rechnung.pdf' });
  assert.equal(withInvoice.invoice_path, '7-abc.pdf');
  assert.equal(withInvoice.invoice_name, 'Zelt_Rechnung.pdf');
  assert.match(withInvoice.invoice_url, /invoice$/);

  const cleared = clearItemInvoice(db, item.id);
  assert.equal(cleared.invoice_path, '');
  assert.equal(cleared.invoice_url, null);
  db.close();
});

test('Migration: alte Datenbank bekommt die neuen Spalten', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storder-migrate-'));
  const file = path.join(dir, 'storder.db');
  // Alte Struktur ohne full_marked_at/purchase_*/invoice_* nachbauen
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE bins (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '', shelf TEXT NOT NULL DEFAULT '', length_cm REAL NOT NULL,
      width_cm REAL NOT NULL, height_cm REAL NOT NULL, axes TEXT NOT NULL DEFAULT '[0,1,2]',
      fill_height_cm REAL, max_weight_g REAL, active INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, bin_id INTEGER, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', brand TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '', shape TEXT NOT NULL DEFAULT '', length_cm REAL, width_cm REAL,
      height_cm REAL, weight_g REAL, volume_liters REAL NOT NULL DEFAULT 0, volume_confidence TEXT NOT NULL DEFAULT '',
      volume_method TEXT NOT NULL DEFAULT '', x_cm REAL NOT NULL DEFAULT 0, y_cm REAL NOT NULL DEFAULT 0,
      z_cm REAL NOT NULL DEFAULT 0, size_cm TEXT, rotation TEXT, photo_path TEXT NOT NULL DEFAULT '',
      photos TEXT NOT NULL DEFAULT '[]', ai_raw TEXT, keep_count INTEGER NOT NULL DEFAULT 0,
      discard_count INTEGER NOT NULL DEFAULT 0, last_reviewed_at TEXT, next_review_at TEXT, discarded_at TEXT,
      status TEXT NOT NULL DEFAULT 'stored', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  old.close();

  const { db } = openDatabase(dir);
  const binCols = db.prepare('PRAGMA table_info(bins)').all().map((r) => r.name);
  const itemCols = db.prepare('PRAGMA table_info(items)').all().map((r) => r.name);
  assert.ok(binCols.includes('full_marked_at'));
  for (const col of ['purchase_date', 'purchase_price_cents', 'invoice_path', 'invoice_name', 'invoice_link', 'quantity', 'categories']) {
    assert.ok(itemCols.includes(col), `items.${col} fehlt`);
  }
  // und die neuen Felder funktionieren auf der migrierten DB
  const bin = createBin(db, { code: 'M1', dims_cm: dims(30, 30, 30) });
  assert.equal(markBinFull(db, bin.id, true).marked_full, true);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Stückzahl: Volumen/Gewicht zählen mit, änderbar', () => {
  const { db } = freshDb();
  const bin = createBin(db, { code: 'BIG', dims_cm: dims(100, 60, 60) }); // 360 l
  const item = createItem(db, {
    bin_id: bin.id,
    name: 'Toaster',
    dims_cm: dims(30, 20, 20),
    weight_g: 1500,
    quantity: 6,
  });
  assert.equal(item.quantity, 6);

  const after = getBin(db, bin.id);
  // eine Einheit belegt 15,12 l -> 6 Stück ~90,7 l
  assert.ok(after.used_liters > 90.5 && after.used_liters < 90.9, `used=${after.used_liters}`);
  assert.ok(after.fill_percent > 25 && after.fill_percent < 25.4, `fill=${after.fill_percent}`);
  assert.ok(after.weight_g > 8990 && after.weight_g < 9010, `weight=${after.weight_g}`);

  const updated = updateItem(db, item.id, { quantity: 2 });
  assert.equal(updated.quantity, 2);
  const after2 = getBin(db, bin.id);
  assert.ok(after2.used_liters > 30 && after2.used_liters < 30.3, `used2=${after2.used_liters}`);

  // ungültige Werte fallen auf 1 zurück
  assert.equal(updateItem(db, item.id, { quantity: 0 }).quantity, 1);
  assert.equal(updateItem(db, item.id, { quantity: 'viele' }).quantity, 1);
  db.close();
});

test('Kistenfoto: setzen, URL und leeren', () => {
  const { db } = freshDb();
  const bin = createBin(db, { code: 'A1', dims_cm: dims(50, 40, 40) });
  assert.equal(bin.photo_url, null);
  const withPhoto = setBinPhoto(db, bin.id, '/api/photos/abc.jpg');
  assert.equal(withPhoto.photo_path, '/api/photos/abc.jpg');
  assert.equal(withPhoto.photo_url, `/api/bins/${bin.id}/photo`);
  const cleared = setBinPhoto(db, bin.id, '');
  assert.equal(cleared.photo_url, null);
  db.close();
});

test('Kiste löschen: Inhalt behalten oder mitlöschen', () => {
  const { db } = freshDb();
  const keep = createBin(db, { code: 'KEEP', dims_cm: dims(50, 40, 40) });
  const itemKeep = createItem(db, { bin_id: keep.id, name: 'Bohrer', dims_cm: dims(20, 15, 10), photos: ['/api/photos/a.jpg'] });
  assert.equal(deleteBin(db, keep.id), true);
  const still = getItem(db, itemKeep.id);
  assert.ok(still, 'Gegenstand muss erhalten bleiben');
  assert.equal(still.bin_id, null);
  assert.equal(listBins(db).length, 0);

  const purge = createBin(db, { code: 'WEG', dims_cm: dims(50, 40, 40) });
  createItem(db, { bin_id: purge.id, name: 'Bohrer 2', dims_cm: dims(20, 15, 10), photos: ['/api/photos/b.jpg'], invoice_path: 'x.pdf' });
  createItem(db, { bin_id: purge.id, name: 'Bohrer 3', dims_cm: dims(10, 10, 10) });
  const result = deleteBinWithItems(db, purge.id);
  assert.equal(result.deleted, true);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].photos.length, 1);
  assert.equal(getBin(db, purge.id), null);
  assert.equal(listItems(db).length, 1, 'nur der erhaltene Gegenstand bleibt');

  assert.deepEqual(deleteBinWithItems(db, 9999), { deleted: false, items: [] });
  db.close();
});

test('searchItems: nach Kategorien filtern (einzeln und kombiniert)', () => {
  const { db } = freshDb();
  const bin = createBin(db, { code: 'A1', dims_cm: dims(80, 60, 60) });
  createItem(db, { bin_id: bin.id, name: 'Bohrer', category: 'Werkzeug', dims_cm: dims(20, 10, 10) });
  createItem(db, { bin_id: bin.id, name: 'Schraube', category: 'Werkzeug', dims_cm: dims(5, 5, 5) });
  createItem(db, { bin_id: bin.id, name: 'Toaster', category: 'Küche', dims_cm: dims(30, 20, 20) });
  createItem(db, { bin_id: bin.id, name: 'Kabel', category: '', dims_cm: dims(10, 10, 5) });

  assert.equal(searchItems(db, '', { categories: ['Werkzeug'] }).length, 2);
  assert.equal(searchItems(db, '', { categories: ['Küche'] }).length, 1);
  assert.equal(searchItems(db, '', { categories: ['Werkzeug', 'Küche'] }).length, 3);
  assert.equal(searchItems(db, '', { categories: ['gibtsnicht'] }).length, 0);
  // Kategorie und Suchwort kombiniert
  assert.equal(searchItems(db, 'bohrer', { categories: ['Werkzeug'] }).length, 1);
  assert.equal(searchItems(db, 'bohrer', { categories: ['Küche'] }).length, 0);
  // Groß-/Kleinschreibung egal
  assert.equal(searchItems(db, '', { categories: ['werkzeug'] }).length, 2);
  db.close();
});

test('Kategorien: mehrere pro Artikel, Suche und Migration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storder-cat-'));
  const { db } = openDatabase(dir);
  const bin = createBin(db, { code: 'A1', dims_cm: dims(80, 60, 60) });

  const item = createItem(db, {
    bin_id: bin.id,
    name: 'USB-Hub',
    categories: ['Elektronik', 'USB & Kabel', 'Computer & Zubehör'],
    dims_cm: dims(10, 5, 2),
  });
  assert.deepEqual(item.categories, ['Elektronik', 'USB & Kabel', 'Computer & Zubehör']);
  assert.equal(item.category, 'Elektronik');

  // freie/aliasierte Eingabe wird auf die Taxonomie abgebildet
  const alias = createItem(db, { bin_id: bin.id, name: 'NAS', category: 'Netzwerkspeicher (NAS)', dims_cm: dims(20, 20, 20) });
  assert.deepEqual(alias.categories, ['Netzwerk']);

  // Update ersetzt die Liste
  const updated = updateItem(db, item.id, { categories: ['Elektronik', 'Netzwerk'] });
  assert.deepEqual(updated.categories, ['Elektronik', 'Netzwerk']);

  // Suche über eine der Kategorien
  assert.equal(searchItems(db, '', { categories: ['Netzwerk'] }).length, 2);
  assert.equal(searchItems(db, '', { categories: ['USB & Kabel'] }).length, 0);
  assert.equal(searchItems(db, 'usb-hub').length, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Migration: alte Kategorie wird auf die Taxonomie abgebildet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storder-mig-'));
  const { db } = openDatabase(dir);
  const bin = createBin(db, { code: 'A1', dims_cm: dims(80, 60, 60) });
  const item = createItem(db, { bin_id: bin.id, name: 'Kabel', dims_cm: dims(10, 5, 2) });
  // Alt-Zustand simulieren: categories leer, category frei
  db.prepare('UPDATE items SET category = ?, categories = ? WHERE id = ?').run('Elektronikzubehör', '', item.id);
  db.close();

  const reopened = openDatabase(dir);
  const migrated = getItem(reopened.db, item.id);
  assert.deepEqual(migrated.categories, ['Elektronik', 'USB & Kabel']);
  assert.equal(migrated.category, 'Elektronik');
  reopened.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
