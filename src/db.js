// SQLite-Zugriff über Node-Bordmittel (node:sqlite) – keine nativen Builds.
// Schema + Abfragen für Kisten, Gegenstände, Erinnerungen und Einstellungen.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeDimensions, computeRequiredVolume } from '../lib/geometry.js';
import { findFreePosition, analyzeBox, boxExtentsCm, parseAxes } from '../lib/placement.js';

const SCHEMA_VERSION = 3;

/** Obergrenze für Fotos pro Gegenstand. */
export const MAX_ITEM_PHOTOS = 12;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  shelf TEXT NOT NULL DEFAULT '',
  length_cm REAL NOT NULL,
  width_cm REAL NOT NULL,
  height_cm REAL NOT NULL,
  axes TEXT NOT NULL DEFAULT '[0,1,2]',
  fill_height_cm REAL,
  max_weight_g REAL,
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  -- gesetzt, wenn die Kiste als "voll" markiert wurde: dann nur noch Kleinteile
  full_marked_at TEXT,
  photo_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bin_id INTEGER REFERENCES bins(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  shape TEXT NOT NULL DEFAULT '',
  length_cm REAL,
  width_cm REAL,
  height_cm REAL,
  weight_g REAL,
  volume_liters REAL NOT NULL DEFAULT 0,
  volume_confidence TEXT NOT NULL DEFAULT '',
  volume_method TEXT NOT NULL DEFAULT '',
  x_cm REAL NOT NULL DEFAULT 0,
  y_cm REAL NOT NULL DEFAULT 0,
  z_cm REAL NOT NULL DEFAULT 0,
  size_cm TEXT,
  rotation TEXT,
  photo_path TEXT NOT NULL DEFAULT '',
  photos TEXT NOT NULL DEFAULT '[]',
  -- Kaufdaten (optional, nachträglich pflegbar)
  purchase_date TEXT,
  purchase_price_cents INTEGER,
  invoice_path TEXT,
  invoice_name TEXT,
  invoice_source TEXT,
  invoice_ref TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  ai_raw TEXT,
  keep_count INTEGER NOT NULL DEFAULT 0,
  discard_count INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT,
  next_review_at TEXT,
  discarded_at TEXT,
  status TEXT NOT NULL DEFAULT 'stored',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_bin ON items(bin_id);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_next_review ON items(next_review_at);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_item ON reviews(item_id);
`;

const now = () => new Date().toISOString();

const asArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// Nachträglich hinzugekommene Spalten: CREATE TABLE IF NOT EXISTS ändert
// bestehende Tabellen nicht, deshalb hier explizit ergänzen.
const COLUMN_MIGRATIONS = {
  bins: {
    full_marked_at: 'TEXT',
    photo_path: "TEXT NOT NULL DEFAULT ''",
  },
  items: {
    purchase_date: 'TEXT',
    purchase_price_cents: 'INTEGER',
    invoice_path: 'TEXT',
    invoice_name: 'TEXT',
    invoice_source: 'TEXT',
    invoice_ref: 'TEXT',
    quantity: 'INTEGER NOT NULL DEFAULT 1',
  },
};

function migrateColumns(db) {
  for (const [table, columns] of Object.entries(COLUMN_MIGRATIONS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

/** Datum als ISO-Tag (YYYY-MM-DD) oder null; toleriert ISO-Strings. */
function normalizeDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/** Stückzahl: ganze Zahl zwischen 1 und 9999. */
function clampQuantity(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 9999);
}

/** Preis (Euro, "12,50" oder 12.5) -> Cent; negative/ungültige Werte -> null. */
function priceToCents(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'storder.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrateColumns(db);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  return { db, file };
}

/* ------------------------------- Settings ------------------------------- */

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

export function setSettings(db, patch) {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [key, value] of Object.entries(patch)) {
    stmt.run(key, JSON.stringify(value));
  }
  return getSettings(db);
}

/* --------------------------------- Bins --------------------------------- */

function rowToBin(row, placements = []) {
  if (!row) return null;
  const dims = normalizeDimensions({ length_cm: row.length_cm, width_cm: row.width_cm, height_cm: row.height_cm });
  const axes = parseAxes(asArray(row.axes));
  const bin = {
    id: row.id,
    code: row.code,
    name: row.name,
    location: row.location,
    shelf: row.shelf,
    length_cm: row.length_cm,
    width_cm: row.width_cm,
    height_cm: row.height_cm,
    inner_dims: dims ? { a: dims.a, b: dims.b, c: dims.c } : null,
    axes,
    fill_height_cm: row.fill_height_cm,
    max_weight_g: row.max_weight_g,
    active: row.active !== 0,
    note: row.note,
    full_marked_at: row.full_marked_at ?? null,
    photo_path: row.photo_path ?? '',
    photo_url: row.photo_path ? `/api/bins/${row.id}/photo` : null,
    // true = Kiste ist als voll markiert -> zukünftig nur noch für Kleinteile
    marked_full: Boolean(row.full_marked_at),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  bin.extents_cm = dims ? boxExtentsCm(dims, axes) : null;
  const analysis = analyzeBox(bin, placements);
  bin.capacity_liters = analysis ? Math.round((analysis.capacityCm3 / 1000) * 10) / 10 : null;
  bin.used_liters = analysis ? Math.round((analysis.usedCm3 / 1000) * 100) / 100 : null;
  bin.free_liters = analysis ? analysis.freeLiters : null;
  bin.fill_percent = analysis ? analysis.fillPercent : null;
  bin.item_count = placements.length;
  bin.weight_g = analysis ? analysis.weightGrams : 0;
  return bin;
}

function placementsByBin(db, binIds = null) {
  const sql = `SELECT id, bin_id, x_cm, y_cm, z_cm, size_cm, weight_g, quantity FROM items WHERE status = 'stored'${binIds ? ` AND bin_id IN (${binIds.map(() => '?').join(',')})` : ''}`;
  const rows = binIds ? db.prepare(sql).all(...binIds) : db.prepare(sql).all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.bin_id)) map.set(r.bin_id, []);
    map.get(r.bin_id).push({
      id: r.id,
      x: r.x_cm,
      y: r.y_cm,
      z: r.z_cm,
      size: asArray(r.size_cm),
      weightGrams: r.weight_g ?? 0,
      quantity: Number(r.quantity) > 0 ? Number(r.quantity) : 1,
    });
  }
  return map;
}

export function listBins(db, { activeOnly = false } = {}) {
  const rows = activeOnly
    ? db.prepare('SELECT * FROM bins WHERE active = 1 ORDER BY location, code').all()
    : db.prepare('SELECT * FROM bins ORDER BY location, code').all();
  const placements = placementsByBin(db, rows.map((r) => r.id));
  return rows.map((row) => rowToBin(row, placements.get(row.id) ?? []));
}

export function getBin(db, id) {
  const row = db.prepare('SELECT * FROM bins WHERE id = ?').get(id);
  if (!row) return null;
  const placements = placementsByBin(db, [row.id]);
  return rowToBin(row, placements.get(row.id) ?? []);
}

export function createBin(db, input) {
  const dims = normalizeDimensions(input);
  if (!dims) throw new HttpError(400, 'Für eine Kiste werden Länge, Breite und Höhe in cm benötigt.');
  const code = String(input.code ?? '').trim().toUpperCase();
  if (!code) throw new HttpError(400, 'Bitte ein Kürzel/Code für die Kiste angeben (z. B. A23).');
  const exists = db.prepare('SELECT id FROM bins WHERE code = ?').get(code);
  if (exists) throw new HttpError(409, `Eine Kiste mit dem Code "${code}" gibt es schon.`);
  const t = now();
  const info = db.prepare(`INSERT INTO bins
    (code, name, location, shelf, length_cm, width_cm, height_cm, axes, fill_height_cm, max_weight_g, active, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    code,
    String(input.name ?? '').trim(),
    String(input.location ?? '').trim(),
    String(input.shelf ?? '').trim(),
    dims.a,
    dims.b,
    dims.c,
    JSON.stringify(parseAxes(input.axes ? asArray(input.axes) : [0, 1, 2])),
    Number(input.fill_height_cm) > 0 ? Number(input.fill_height_cm) : null,
    Number(input.max_weight_g) > 0 ? Number(input.max_weight_g) : null,
    input.active === false || input.active === 0 ? 0 : 1,
    String(input.note ?? '').trim(),
    t,
    t,
  );
  return getBin(db, Number(info.lastInsertRowid));
}

export function updateBin(db, id, patch) {
  const current = db.prepare('SELECT * FROM bins WHERE id = ?').get(id);
  if (!current) throw new HttpError(404, 'Kiste nicht gefunden.');
  const merged = {
    length_cm: patch.length_cm ?? current.length_cm,
    width_cm: patch.width_cm ?? current.width_cm,
    height_cm: patch.height_cm ?? current.height_cm,
  };
  const dims = normalizeDimensions(merged);
  if (!dims) throw new HttpError(400, 'Ungültige Kistenmaße.');
  const code = patch.code != null ? String(patch.code).trim().toUpperCase() : current.code;
  if (code !== current.code) {
    const dup = db.prepare('SELECT id FROM bins WHERE code = ? AND id <> ?').get(code, id);
    if (dup) throw new HttpError(409, `Eine Kiste mit dem Code "${code}" gibt es schon.`);
  }
  db.prepare(`UPDATE bins SET code=?, name=?, location=?, shelf=?, length_cm=?, width_cm=?, height_cm=?,
    axes=?, fill_height_cm=?, max_weight_g=?, active=?, note=?, updated_at=? WHERE id=?`).run(
    code,
    patch.name != null ? String(patch.name).trim() : current.name,
    patch.location != null ? String(patch.location).trim() : current.location,
    patch.shelf != null ? String(patch.shelf).trim() : current.shelf,
    dims.a,
    dims.b,
    dims.c,
    JSON.stringify(parseAxes(patch.axes != null ? asArray(patch.axes) : asArray(current.axes))),
    patch.fill_height_cm !== undefined
      ? (Number(patch.fill_height_cm) > 0 ? Number(patch.fill_height_cm) : null)
      : current.fill_height_cm,
    patch.max_weight_g !== undefined
      ? (Number(patch.max_weight_g) > 0 ? Number(patch.max_weight_g) : null)
      : current.max_weight_g,
    patch.active !== undefined ? (patch.active ? 1 : 0) : current.active,
    patch.note != null ? String(patch.note).trim() : current.note,
    now(),
    id,
  );
  return getBin(db, id);
}

/**
 * Markiert eine Kiste als "voll" oder hebt die Markierung auf.
 * Markierte Kisten werden künftig nur noch für sehr kleine Gegenstände
 * vorgeschlagen (siehe FULL_BOX_MAX_ITEMS_LITERS in lib/placement.js).
 */
export function markBinFull(db, id, full = true) {
  const bin = getBin(db, id);
  if (!bin) throw new HttpError(404, 'Kiste nicht gefunden.');
  db.prepare('UPDATE bins SET full_marked_at = ?, updated_at = ? WHERE id = ?')
    .run(full ? now() : null, now(), id);
  return getBin(db, id);
}

/** Foto der Kiste setzen/entfernen (Datei verwaltet der Server). */
export function setBinPhoto(db, id, photoPath) {
  const bin = getBin(db, id);
  if (!bin) throw new HttpError(404, 'Kiste nicht gefunden.');
  db.prepare('UPDATE bins SET photo_path = ?, updated_at = ? WHERE id = ?')
    .run(String(photoPath ?? ''), now(), id);
  return getBin(db, id);
}

/** Kiste löschen; enthaltene Gegenstände bleiben, verlieren aber den Platz (bin_id = NULL). */
export function deleteBin(db, id) {
  const info = db.prepare('DELETE FROM bins WHERE id = ?').run(id);
  return info.changes > 0;
}

/**
 * Kiste samt Inhalt löschen. Liefert die gelöschten Gegenstände zurück, damit
 * der Aufrufer deren Foto-/Rechnungsdateien aufräumen kann.
 */
export function deleteBinWithItems(db, id) {
  const row = db.prepare('SELECT * FROM bins WHERE id = ?').get(id);
  if (!row) return { deleted: false, items: [] };
  const items = db.prepare('SELECT id, name, photos, photo_path, invoice_path FROM items WHERE bin_id = ?').all(id)
    .map((r) => ({
      id: r.id,
      name: r.name,
      photos: asArray(r.photos),
      photo_path: r.photo_path ?? '',
      invoice_path: r.invoice_path ?? '',
    }));
  db.prepare('DELETE FROM items WHERE bin_id = ?').run(id);
  const info = db.prepare('DELETE FROM bins WHERE id = ?').run(id);
  return { deleted: info.changes > 0, items };
}

/* --------------------------------- Items -------------------------------- */

function rowToItem(row, bin = null) {
  if (!row) return null;
  return {
    id: row.id,
    bin_id: row.bin_id,
    bin: bin
      ? { id: bin.id, code: bin.code, name: bin.name, location: bin.location, shelf: bin.shelf }
      : null,
    name: row.name,
    description: row.description,
    brand: row.brand,
    category: row.category,
    source_url: row.source_url,
    shape: row.shape,
    dims_cm: {
      length_cm: row.length_cm,
      width_cm: row.width_cm,
      height_cm: row.height_cm,
    },
    weight_g: row.weight_g,
    volume_liters: row.volume_liters,
    volume_confidence: row.volume_confidence,
    volume_method: row.volume_method,
    position: { x_cm: row.x_cm, y_cm: row.y_cm, z_cm: row.z_cm },
    size_cm: asArray(row.size_cm),
    rotation: asArray(row.rotation),
    photo_path: row.photo_path,
    photos: asArray(row.photos),
    purchase_date: row.purchase_date ?? null,
    purchase_price_cents: row.purchase_price_cents ?? null,
    purchase_price: row.purchase_price_cents != null ? Math.round(row.purchase_price_cents) / 100 : null,
    invoice_path: row.invoice_path ?? '',
    invoice_name: row.invoice_name ?? '',
    invoice_source: row.invoice_source ?? (row.invoice_path ? 'upload' : null),
    invoice_ref: row.invoice_ref ?? null,
    invoice_url: row.invoice_path ? `/api/items/${row.id}/invoice` : null,
    quantity: Number(row.quantity) > 0 ? Number(row.quantity) : 1,
    keep_count: row.keep_count,
    discard_count: row.discard_count,
    last_reviewed_at: row.last_reviewed_at,
    next_review_at: row.next_review_at,
    discarded_at: row.discarded_at,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function binMap(db, ids) {
  const unique = [...new Set(ids.filter((v) => v != null))];
  if (!unique.length) return new Map();
  const rows = db.prepare(`SELECT * FROM bins WHERE id IN (${unique.map(() => '?').join(',')})`).all(...unique);
  const placements = placementsByBin(db, unique);
  return new Map(rows.map((r) => [r.id, rowToBin(r, placements.get(r.id) ?? [])]));
}

export function getItem(db, id) {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!row) return null;
  const bin = row.bin_id ? getBin(db, row.bin_id) : null;
  return rowToItem(row, bin);
}

/**
 * Legt einen Gegenstand an und platziert ihn.
 * Wenn `position` fehlt und `bin_id` gesetzt ist, wird ein freier Platz in der
 * Kiste gesucht. `dims` (length_cm/width_cm/height_cm) und `weight_g` sind optional.
 */
export function createItem(db, input, { nextReviewAt = null } = {}) {
  const name = String(input.name ?? '').trim();
  if (!name) throw new HttpError(400, 'Der Gegenstand braucht einen Namen.');
  const dims = normalizeDimensions(input.dims_cm ?? input);
  const weight = Number(input.weight_g) > 0 ? Number(input.weight_g) : null;
  const volume = Number(input.volume_liters) > 0
    ? { liters: Number(input.volume_liters), confidence: 'manual', method: 'manual' }
    : computeRequiredVolume({ dims: input.dims_cm ?? input, shape: input.shape, weightGrams: weight });

  let bin = input.bin_id ? getBin(db, input.bin_id) : null;
  if (input.bin_id && !bin) throw new HttpError(404, 'Kiste nicht gefunden.');

  // Doppelklick-Schutz: gleicher Name + gleiche Kiste innerhalb von 10 Sekunden
  // ist fast immer ein versehentlich doppelt ausgelöster Speichervorgang.
  const duplicate = db.prepare(`SELECT id FROM items
    WHERE status = 'stored' AND name = ? AND IFNULL(bin_id, -1) = IFNULL(?, -1)
      AND created_at >= ? ORDER BY id DESC LIMIT 1`)
    .get(name, bin?.id ?? null, new Date(Date.now() - 10000).toISOString());
  if (duplicate) {
    const err = new HttpError(409, `„${name}“ wurde gerade eben schon eingelagert (Doppelklick?).`);
    err.code = 'DUPLICATE_ITEM';
    err.item_id = duplicate.id;
    throw err;
  }

  let position = null;
  if (bin) {
    const placements = placementsByBin(db, [bin.id]).get(bin.id) ?? [];
    const ext = boxExtentsCm(bin, bin.axes);
    const fillHeight = bin.fill_height_cm > 0 ? bin.fill_height_cm : null;
    if (input.position && ['x_cm', 'y_cm', 'z_cm'].every((k) => Number.isFinite(Number(input.position[k])))) {
      const size = input.size_cm ? asArray(input.size_cm) : null;
      position = {
        x: Number(input.position.x_cm),
        y: Number(input.position.y_cm),
        z: Number(input.position.z_cm),
        size: size ?? [dims?.a ?? 1, dims?.b ?? 1, dims?.c ?? 1].map((n) => n * 1.08),
        dimensions: dims ? [dims.a, dims.b, dims.c] : null,
        rotation: asArray(input.rotation),
      };
    } else if (dims) {
      position = findFreePosition(dims, ext, placements, { fillHeight, maxWeight: bin.max_weight_g, weightGrams: weight });
      if (!position) throw new HttpError(409, 'In dieser Kiste ist kein freier Platz mehr für den Gegenstand.');
    }
  }

  const t = now();
  const photos = asArray(input.photos);
  const info = db.prepare(`INSERT INTO items
    (bin_id, name, description, brand, category, source_url, shape, length_cm, width_cm, height_cm, weight_g,
     volume_liters, volume_confidence, volume_method, x_cm, y_cm, z_cm, size_cm, rotation, photo_path, photos,
     purchase_date, purchase_price_cents, invoice_path, invoice_name, quantity,
     ai_raw, next_review_at, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    bin?.id ?? null,
    name,
    String(input.description ?? '').trim(),
    String(input.brand ?? '').trim(),
    String(input.category ?? '').trim(),
    String(input.source_url ?? '').trim(),
    String(input.shape ?? '').trim(),
    dims?.a ?? null,
    dims?.b ?? null,
    dims?.c ?? null,
    weight,
    volume?.liters ?? 0,
    volume?.confidence ?? '',
    volume?.method ?? '',
    position?.x ?? 0,
    position?.y ?? 0,
    position?.z ?? 0,
    position ? JSON.stringify(position.size) : null,
    position ? JSON.stringify(position.rotation ?? []) : null,
    String(input.photo_path ?? photos[0] ?? ''),
    JSON.stringify(photos),
    normalizeDate(input.purchase_date),
    priceToCents(input.purchase_price_cents ?? input.purchase_price),
    input.invoice_path ? String(input.invoice_path) : null,
    input.invoice_name ? String(input.invoice_name).slice(0, 200) : null,
    clampQuantity(input.quantity),
    input.ai_raw ? JSON.stringify(input.ai_raw) : null,
    nextReviewAt,
    'stored',
    t,
    t,
  );
  return getItem(db, Number(info.lastInsertRowid));
}

/**
 * Maße/Gewicht/Form eines Gegenstands ändern und ihn dabei in seiner Kiste neu
 * platzieren (alte Position wird freigegeben). Passt er nicht mehr, bleibt
 * alles unverändert und es gibt 409.
 */
export function updateItemDimensions(db, id, patch = {}) {
  const item = getItem(db, id);
  if (!item) throw new HttpError(404, 'Gegenstand nicht gefunden.');

  const dimsInput = patch.dims_cm ?? item.dims_cm;
  const dims = normalizeDimensions(dimsInput);
  const weight = patch.weight_g !== undefined
    ? (Number(patch.weight_g) > 0 ? Number(patch.weight_g) : null)
    : (item.weight_g ?? null);
  const shape = patch.shape !== undefined ? String(patch.shape ?? '') : item.shape;
  const manualVolume = Number(patch.volume_liters) > 0 ? Number(patch.volume_liters) : null;

  const volume = manualVolume
    ? { liters: manualVolume, confidence: 'manual', method: 'manual' }
    : computeRequiredVolume({ dims: patch.dims_cm ?? item.dims_cm, shape, weightGrams: weight });

  const bin = item.bin_id ? getBin(db, item.bin_id) : null;
  let position = null;
  if (bin && dims) {
    const others = (placementsByBin(db, [bin.id]).get(bin.id) ?? []).filter((p) => p.id !== id);
    position = findFreePosition(dims, boxExtentsCm(bin, bin.axes), others, {
      fillHeight: bin.fill_height_cm > 0 ? bin.fill_height_cm : null,
      maxWeight: bin.max_weight_g,
      weightGrams: weight,
    });
    if (!position) {
      throw new HttpError(409, 'Die neuen Maße passen nicht mehr in die Kiste – bitte erst umräumen.');
    }
  }

  db.prepare(`UPDATE items SET length_cm=?, width_cm=?, height_cm=?, weight_g=?, shape=?,
    volume_liters=?, volume_confidence=?, volume_method=?, x_cm=?, y_cm=?, z_cm=?, size_cm=?, rotation=?,
    updated_at=? WHERE id=?`).run(
    dims?.a ?? null,
    dims?.b ?? null,
    dims?.c ?? null,
    weight,
    shape,
    volume?.liters ?? 0,
    volume?.confidence ?? '',
    volume?.method ?? '',
    position?.x ?? 0,
    position?.y ?? 0,
    position?.z ?? 0,
    position ? JSON.stringify(position.size) : null,
    position ? JSON.stringify(position.rotation ?? []) : null,
    now(),
    id,
  );
  return getItem(db, id);
}

export function updateItem(db, id, patch) {
  const current = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!current) throw new HttpError(404, 'Gegenstand nicht gefunden.');
  const sets = [];
  const values = [];
  const set = (col, value) => {
    sets.push(`${col} = ?`);
    values.push(value);
  };
  if (patch.name != null) {
    const name = String(patch.name).trim();
    if (!name) throw new HttpError(400, 'Der Gegenstand braucht einen Namen.');
    set('name', name);
  }
  if (patch.description != null) set('description', String(patch.description).trim());
  if (patch.brand != null) set('brand', String(patch.brand).trim());
  if (patch.category != null) set('category', String(patch.category).trim());
  if (patch.shape != null) set('shape', String(patch.shape).trim());
  if (patch.quantity !== undefined) set('quantity', clampQuantity(patch.quantity));
  if (patch.purchase_date !== undefined) set('purchase_date', normalizeDate(patch.purchase_date));
  if (patch.purchase_price_cents !== undefined || patch.purchase_price !== undefined) {
    set('purchase_price_cents', priceToCents(patch.purchase_price_cents ?? patch.purchase_price));
  }
  if (patch.invoice_path !== undefined) set('invoice_path', patch.invoice_path ? String(patch.invoice_path) : null);
  if (patch.invoice_name !== undefined) {
    set('invoice_name', patch.invoice_name ? String(patch.invoice_name).slice(0, 200) : null);
  }
  if (patch.photos !== undefined) {
    const photos = asArray(patch.photos).filter((p) => typeof p === 'string' && p);
    set('photos', JSON.stringify(photos.slice(0, MAX_ITEM_PHOTOS)));
    set('photo_path', patch.photo_path ?? photos[0] ?? '');
  } else if (patch.photo_path !== undefined) {
    set('photo_path', String(patch.photo_path));
  }
  if (patch.status != null && ['stored', 'discarded', 'lost'].includes(patch.status)) set('status', patch.status);
  if (patch.discarded_at !== undefined) set('discarded_at', patch.discarded_at);
  if (patch.bin_id !== undefined) set('bin_id', patch.bin_id);
  if (patch.position) {
    set('x_cm', Number(patch.position.x_cm) || 0);
    set('y_cm', Number(patch.position.y_cm) || 0);
    set('z_cm', Number(patch.position.z_cm) || 0);
    if (patch.size_cm) set('size_cm', JSON.stringify(asArray(patch.size_cm)));
    if (patch.rotation) set('rotation', JSON.stringify(asArray(patch.rotation)));
  }
  if (!sets.length) return getItem(db, id);
  set('updated_at', now());
  values.push(id);
  db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getItem(db, id);
}

/** Gegenstand in eine andere Kiste umziehen (neu platzieren). */
export function moveItem(db, id, binId) {
  const item = getItem(db, id);
  if (!item) throw new HttpError(404, 'Gegenstand nicht gefunden.');
  if (!binId) {
    db.prepare("UPDATE items SET bin_id = NULL, size_cm = NULL, rotation = NULL, x_cm = 0, y_cm = 0, z_cm = 0, updated_at = ? WHERE id = ?").run(now(), id);
    return getItem(db, id);
  }
  const bin = getBin(db, binId);
  if (!bin) throw new HttpError(404, 'Kiste nicht gefunden.');
  const dims = item.dims_cm.length_cm
    ? normalizeDimensions(item.dims_cm)
    : null;
  const placements = placementsByBin(db, [bin.id]).get(bin.id) ?? [];
  const fillHeight = bin.fill_height_cm > 0 ? bin.fill_height_cm : null;
  let position = null;
  if (dims) {
    position = findFreePosition(dims, boxExtentsCm(bin, bin.axes), placements, {
      fillHeight,
      maxWeight: bin.max_weight_g,
      weightGrams: item.weight_g,
    });
    if (!position) throw new HttpError(409, 'In der Zielkiste ist kein freier Platz mehr.');
  }
  db.prepare(`UPDATE items SET bin_id=?, x_cm=?, y_cm=?, z_cm=?, size_cm=?, rotation=?, updated_at=? WHERE id=?`).run(
    bin.id,
    position?.x ?? 0,
    position?.y ?? 0,
    position?.z ?? 0,
    position ? JSON.stringify(position.size) : null,
    position ? JSON.stringify(position.rotation ?? []) : null,
    now(),
    id,
  );
  return getItem(db, id);
}

/** Fügt einem Gegenstand weitere Fotos hinzu (Pfade wie /api/photos/<name>). */
export function addItemPhotos(db, id, paths, { limit = MAX_ITEM_PHOTOS } = {}) {
  const item = getItem(db, id);
  if (!item) throw new HttpError(404, 'Gegenstand nicht gefunden.');
  const incoming = asArray(paths).filter((p) => typeof p === 'string' && p.startsWith('/api/photos/'));
  if (!incoming.length) throw new HttpError(400, 'Keine gültigen Fotos übermittelt.');
  const photos = [...new Set([...(item.photos ?? []), ...incoming])].slice(0, limit);
  db.prepare('UPDATE items SET photos = ?, photo_path = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(photos), photos[0] ?? '', now(), id);
  return getItem(db, id);
}

/** Entfernt ein einzelnes Foto (Pfad) vom Gegenstand. */
export function removeItemPhoto(db, id, photoPath) {
  const item = getItem(db, id);
  if (!item) throw new HttpError(404, 'Gegenstand nicht gefunden.');
  const photos = (item.photos ?? []).filter((p) => p !== photoPath);
  db.prepare('UPDATE items SET photos = ?, photo_path = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(photos), photos[0] ?? '', now(), id);
  return getItem(db, id);
}

/** Hinterlegt die Originalrechnung (Dateiname im Rechnungs-Ordner + Anzeigename). */
export function setItemInvoice(db, id, { path: file, name, source = 'upload', ref = null }) {
  const item = getItem(db, id);
  if (!item) throw new HttpError(404, 'Gegenstand nicht gefunden.');
  db.prepare('UPDATE items SET invoice_path = ?, invoice_name = ?, invoice_source = ?, invoice_ref = ?, updated_at = ? WHERE id = ?')
    .run(String(file), String(name ?? '').slice(0, 200) || null, source, ref == null ? null : String(ref), now(), id);
  return getItem(db, id);
}

/** Entfernt die Rechnungs-Referenz (Datei löscht der Aufrufer). */
export function clearItemInvoice(db, id) {
  const item = getItem(db, id);
  if (!item) throw new HttpError(404, 'Gegenstand nicht gefunden.');
  db.prepare('UPDATE items SET invoice_path = NULL, invoice_name = NULL, invoice_source = NULL, invoice_ref = NULL, updated_at = ? WHERE id = ?').run(now(), id);
  return getItem(db, id);
}

/** Alle Gegenstände eines Status (für Erinnerung und Platzierungssuche). */
export function listItems(db, { status = 'stored', limit = 500 } = {}) {
  const rows = db.prepare('SELECT * FROM items WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit);
  const bins = binMap(db, rows.map((r) => r.bin_id));
  return rows.map((r) => rowToItem(r, bins.get(r.bin_id) ?? null));
}

/** Aktualisiert nur den Änderungszeitstempel (z. B. nach dem Drehen eines Fotos). */
export function touchItem(db, id) {
  if (!getItem(db, id)) throw new HttpError(404, 'Gegenstand nicht gefunden.');
  db.prepare('UPDATE items SET updated_at = ? WHERE id = ?').run(now(), id);
  return getItem(db, id);
}

export function deleteItem(db, id) {
  const info = db.prepare('DELETE FROM items WHERE id = ?').run(id);
  return info.changes > 0;
}

/* --------------------------------- Suche -------------------------------- */

// Suchfelder getrennt nach Tabelle, damit der JOIN eindeutig bleibt.
const ITEM_SEARCH_FIELDS = ['i.name', 'i.description', 'i.brand', 'i.category'];
const BIN_SEARCH_FIELDS = ['b.code', 'b.name', 'b.location', 'b.shelf'];

/**
 * Freitextsuche über Gegenstand und Kiste. Mehrere Wörter werden UND-verknüpft.
 * Ein Suchwort muss in einem der Gegenstands- ODER Kistenfelder vorkommen.
 */
export function searchItems(db, query, { limit = 60, status = 'stored' } = {}) {
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const base = `SELECT i.* FROM items i LEFT JOIN bins b ON b.id = i.bin_id WHERE i.status = ?`;
  if (!terms.length) {
    const rows = db.prepare(`${base} ORDER BY i.created_at DESC LIMIT ?`).all(status, limit);
    const bins = binMap(db, rows.map((r) => r.bin_id));
    return rows.map((r) => rowToItem(r, bins.get(r.bin_id) ?? null));
  }
  const where = [];
  const params = [];
  for (const term of terms) {
    const like = `%${term}%`;
    const fields = [...ITEM_SEARCH_FIELDS, ...BIN_SEARCH_FIELDS];
    where.push(`(${fields.map((f) => `LOWER(${f}) LIKE ?`).join(' OR ')})`);
    params.push(...fields.map(() => like));
  }
  const sql = `${base} AND ${where.join(' AND ')} ORDER BY i.created_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(status, ...params, limit);
  const bins = binMap(db, rows.map((r) => r.bin_id));
  return rows.map((r) => rowToItem(r, bins.get(r.bin_id) ?? null));
}

/* ------------------------- Erinnerung / Review --------------------------- */

function randomIds(db, { count, minAgeDays, exclude = [] }) {
  const cutoff = new Date(Date.now() - minAgeDays * 86400000).toISOString();
  const excl = exclude.length ? ` AND id NOT IN (${exclude.map(() => '?').join(',')})` : '';
  const rows = db.prepare(
    `SELECT id FROM items WHERE status = 'stored' AND created_at <= ?${excl} ORDER BY RANDOM() LIMIT ?`,
  ).all(cutoff, ...exclude, count);
  return rows.map((r) => r.id);
}

/** Wählt zufällige Gegenstände für die nächste Erinnerung. */
export function pickRecallItems(db, { count = 3, minAgeDays = 14, maxItems = 0, exclude = [] } = {}) {
  const total = db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'stored'").get().n;
  const n = maxItems > 0 ? Math.min(count, maxItems) : count;
  if (!total) return [];
  // Bewusst strikt: erst nach `minAgeDays` sollen Gegenstände zur Prüfung
  // auftauchen – genau das ist der einstellbare Zeitraum aus den Einstellungen.
  const ids = randomIds(db, { count: n, minAgeDays, exclude });
  return ids.map((id) => getItem(db, id)).filter(Boolean);
}

/**
 * Bewertet einen Gegenstand bei der Erinnerung.
 * verdict: 'keep' (behalten/genutzt), 'unused' (lange nicht genutzt, aber behalten),
 *          'discard' (aussortieren), 'not_found' (nicht gefunden)
 */
export function reviewItem(db, id, verdict, { note = '', intervalDays = 30 } = {}) {
  const item = getItem(db, id);
  if (!item) throw new HttpError(404, 'Gegenstand nicht gefunden.');
  const t = now();
  const next = new Date(Date.now() + intervalDays * 86400000).toISOString();
  db.prepare(`INSERT INTO reviews (item_id, verdict, note, created_at) VALUES (?, ?, ?, ?)`).run(id, verdict, String(note ?? ''), t);
  const patch = { last_reviewed_at: t, next_review_at: next };
  if (verdict === 'discard') {
    db.prepare(`UPDATE items SET last_reviewed_at=?, next_review_at=?, discarded_at=?, status='discarded',
      discard_count = discard_count + 1, updated_at=? WHERE id=?`).run(t, null, t, t, id);
  } else if (verdict === 'not_found') {
    db.prepare(`UPDATE items SET last_reviewed_at=?, next_review_at=?, updated_at=? WHERE id=?`).run(t, next, t, id);
  } else {
    db.prepare(`UPDATE items SET last_reviewed_at=?, next_review_at=?, keep_count = keep_count + 1, updated_at=? WHERE id=?`).run(t, next, t, id);
  }
  return getItem(db, id);
}

export function listReviews(db, itemId = null, { limit = 50 } = {}) {
  if (itemId) {
    return db.prepare('SELECT * FROM reviews WHERE item_id = ? ORDER BY created_at DESC LIMIT ?').all(itemId, limit);
  }
  return db.prepare('SELECT * FROM reviews ORDER BY created_at DESC LIMIT ?').all(limit);
}

export function countItems(db, status = 'stored') {
  return db.prepare('SELECT COUNT(*) AS n FROM items WHERE status = ?').get(status).n;
}

export function stats(db) {
  const bins = listBins(db);
  const stored = countItems(db, 'stored');
  const discarded = countItems(db, 'discarded');
  const totalCapacity = bins.reduce((s, b) => s + (b.capacity_liters ?? 0), 0);
  const totalUsed = bins.reduce((s, b) => s + (b.used_liters ?? 0), 0);
  const totalFree = bins.reduce((s, b) => s + (b.free_liters ?? 0), 0);
  const totalWeight = bins.reduce((s, b) => s + (b.weight_g ?? 0), 0);
  return {
    bins: bins.length,
    active_bins: bins.filter((b) => b.active).length,
    items_stored: stored,
    items_discarded: discarded,
    capacity_liters: Math.round(totalCapacity * 10) / 10,
    used_liters: Math.round(totalUsed * 10) / 10,
    free_liters: Math.round(totalFree * 10) / 10,
    fill_percent: totalCapacity > 0 ? Math.round((totalUsed / totalCapacity) * 1000) / 10 : 0,
    weight_kg: Math.round(totalWeight) / 1000,
    // Summe der hinterlegten Kaufpreise (nur eingelagerte Gegenstände)
    purchase_value_eur: (() => {
      const row = db.prepare(
        "SELECT SUM(purchase_price_cents) AS c FROM items WHERE status = 'stored' AND purchase_price_cents IS NOT NULL",
      ).get();
      return Math.round(Number(row?.c) || 0) / 100;
    })(),
  };
}

/* --------------------------------- Seed --------------------------------- */

export function seedBins(db, seeds = []) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM bins').get().n;
  if (existing > 0) return { created: 0, skipped: existing };
  let created = 0;
  let failed = 0;
  for (const seed of seeds) {
    try {
      createBin(db, { ...seed, name: seed.name ?? '' });
      created++;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      failed++;
    }
  }
  return { created, skipped: existing + failed };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
