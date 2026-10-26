// Storder – HTTP-Server (Express 5).
//
// Aufgaben:
//  - statische mobile Web-App aus public/ ausliefern
//  - REST-API für Kisten, Gegenstände, Suche, Platzierung, Erinnerung
//  - Foto-Upload: Bild verkleinern (sharp), an das LLM geben, Ergebnis liefern
//
// Bewusste Trennung: Das LLM liefert nur Beschreibung/Maße/Gewicht. Volumen und
// Platz werden deterministisch berechnet (lib/geometry.js, lib/placement.js).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import express from 'express';
import sharp from 'sharp';

import { loadConfig, mergeRuntimeConfig } from '../lib/config.js';
import { createLlmClient } from '../lib/llm.js';
import { createPaperlessClient } from '../lib/paperless.js';
import { validateBoxInput, ValidationError } from '../lib/validate.js';
import { suggestPlacement } from '../lib/suggest.js';
import { findSimilarItems, findConsolidationSuggestions } from '../lib/similar.js';
import { findPlausibilityIssues } from '../lib/plausibility.js';
import { CATEGORY_TAXONOMY, normalizeCategories } from '../lib/categories.js';
import { analyzeImage } from './analyze.js';
import { selectRecallItems, toRecallItem } from './recall.js';
import {
  openDatabase,
  getSettings,
  setSettings,
  listBins,
  getBin,
  createBin,
  updateBin,
  deleteBin,
  deleteBinWithItems,
  markBinFull,
  setBinPhoto,
  dismissSuggestion,
  listDismissedSuggestions,
  listItems,
  getItem,
  createItem,
  updateItem,
  updateItemDimensions,
  moveItem,
  deleteItem,
  searchItems,
  reviewItem,
  listReviews,
  addItemPhotos,
  removeItemPhoto,
  touchItem,
  setItemInvoice,
  clearItemInvoice,
  MAX_ITEM_PHOTOS,
  stats,
  seedBins,
  HttpError,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const SETTINGS_KEYS = [
  'llm_model',
  'llm_vision_model',
  'llm_web_model',
  'llm_base_url',
  'recall_enabled',
  'recall_interval_days',
  'recall_items_per_recall',
  'recall_min_item_age_days',
  'recall_max_items',
];

/** Express 5 leitet Promise-Rejections selbst weiter; das hält den Code lesbar. */
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------- Fotos ---------------------------------- */

const PHOTO_RE = /^[a-z0-9][a-z0-9-]{0,60}\.(jpg|jpeg|png|webp)$/i;
const IMAGE_MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const imageMime = (file) => IMAGE_MIME_BY_EXT[path.extname(String(file)).replace('.', '').toLowerCase()] ?? 'application/octet-stream';
const INVOICE_EXTS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'webp']);
const MIME_BY_EXT = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function photosDir(config) {
  const dir = path.join(config.dataDir, 'photos');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function invoicesDir(config) {
  const dir = path.join(config.dataDir, 'invoices');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Data-URL oder reines Base64 -> { buffer, mime }. */
function decodePayload(input, { what = 'Datei' } = {}) {
  const text = String(input ?? '').trim();
  if (!text) throw new HttpError(400, `Keine ${what} übermittelt.`);
  const match = text.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/i);
  const base64 = (match ? match[2] : text).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) throw new HttpError(400, `${what} ist keine gültige Base64-Datei.`);
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new HttpError(400, `${what} ist leer.`);
  return { buffer, mime: match ? match[1].toLowerCase() : '' };
}

/** Nur Bilder akzeptieren (z. B. Analyse/Fotos). */
function decodeImage(input) {
  const { buffer, mime } = decodePayload(input, { what: 'Bild' });
  if (mime && !mime.startsWith('image/')) throw new HttpError(400, 'Bitte eine Bilddatei übermitteln.');
  return buffer;
}

function buildPaperlessQuery(item) {
  const parts = [item.name, item.brand, item.category].map((v) => String(v ?? '').trim()).filter(Boolean);
  const year = String(item.purchase_date ?? '').match(/^(\d{4})/)?.[1];
  const words = [...new Set(parts)].join(' ').trim();
  return [words, year, 'Rechnung'].filter(Boolean).join(' ').trim();
}

function invoiceExt(mime, name) {
  const fromMime = mime.split('/').pop()?.toLowerCase();
  const fromName = path.extname(String(name ?? '')).replace('.', '').toLowerCase();
  const ext = INVOICE_EXTS.has(fromMime) ? fromMime : (INVOICE_EXTS.has(fromName) ? fromName : 'pdf');
  return ext === 'jpeg' ? 'jpg' : ext;
}

/**
 * Verkleinert das Foto (max. 1000 px pro Seite), richtet es nach EXIF aus und
 * speichert es als WebP. Fürs LLM gibt es zusätzlich eine JPEG-Data-URL, weil
 * nicht jeder Vision-Endpunkt WebP akzeptiert.
 */
async function preparePhoto(config, input) {
  const raw = decodeImage(input);
  if (raw.length > config.upload.maxBytes) {
    throw new HttpError(413, `Bild ist zu groß (max. ${Math.round(config.upload.maxBytes / 1024 / 1024)} MB).`);
  }
  const maxSide = config.llm.maxImageDimension;
  const resized = await sharp(raw)
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .toBuffer();
  const [webp, jpeg] = await Promise.all([
    sharp(resized).webp({ quality: 80 }).toBuffer(),
    sharp(resized).jpeg({ quality: 85, mozjpeg: true }).toBuffer(),
  ]);
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.webp`;
  fs.writeFileSync(path.join(photosDir(config), name), webp);
  return {
    name,
    path: `/api/photos/${name}`,
    imageDataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    bytes: webp.length,
  };
}

/* ------------------------------- App ------------------------------------ */

export function createApp({ config, db, llm, paperless }) {
  const paperlessClient = paperless ?? createPaperlessClient(config);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  const jsonLimit = Math.max(config.upload.maxBytes * 2, 2 * 1024 * 1024);
  app.use(express.json({ limit: jsonLimit }));
  app.use(express.urlencoded({ extended: false, limit: jsonLimit }));

  /** Aktuelle Konfiguration inkl. Laufzeit-Einstellungen aus der DB. */
  const runtime = () => mergeRuntimeConfig(config, getSettings(db));

  /* ----------------------------- Gesundheit ---------------------------- */

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      app: config.appName,
      version: '1.0.0',
      llm_configured: Boolean(runtime().llm.apiKey),
      llm_base_url: runtime().llm.baseUrl,
      time: new Date().toISOString(),
    });
  });

  app.get('/api/stats', (req, res) => {
    res.json({ stats: stats(db), recall: runtime().recall });
  });

  /* ------------------------------ Kisten ------------------------------- */

  app.get('/api/bins', (req, res) => {
    const activeOnly = req.query.active === '1' || req.query.active === 'true';
    res.json({ bins: listBins(db, { activeOnly }) });
  });

  app.get('/api/bins/:id', (req, res) => {
    const bin = getBin(db, Number(req.params.id));
    if (!bin) throw new HttpError(404, 'Kiste nicht gefunden.');
    res.json({ bin, items: listItems(db).filter((it) => it.bin_id === bin.id) });
  });

  app.post('/api/bins', (req, res) => {
    const input = validateBoxInput(req.body ?? {});
    // validateBoxInput liefert {a,b,c}; die DB erwartet die benannten Kanten.
    const bin = createBin(db, {
      ...req.body,
      ...input,
      dims_cm: input.dims_cm,
    });
    res.status(201).json({ bin });
  });

  app.put('/api/bins/:id', (req, res) => {
    const input = validateBoxInput(req.body ?? {}, { partial: true });
    // updateBin arbeitet mit benannten Kanten, validateBoxInput mit {a,b,c}.
    const dims = input.dims_cm
      ? { length_cm: input.dims_cm.a, width_cm: input.dims_cm.b, height_cm: input.dims_cm.c }
      : {};
    const bin = updateBin(db, Number(req.params.id), { ...req.body, ...input, ...dims });
    res.json({ bin });
  });

  app.delete('/api/bins/:id', (req, res) => {
    const id = Number(req.params.id);
    const bin = getBin(db, id);
    if (!bin) throw new HttpError(404, 'Kiste nicht gefunden.');
    const withItems = ['1', 'true', 'yes'].includes(String(req.query.with_items ?? '').toLowerCase());

    let removedItems = 0;
    if (withItems) {
      const result = deleteBinWithItems(db, id);
      if (!result.deleted) throw new HttpError(404, 'Kiste nicht gefunden.');
      removedItems = result.items.length;
      // Dateien der gelöschten Gegenstände aufräumen
      for (const item of result.items) {
        for (const photo of item.photos ?? []) {
          const name = path.basename(String(photo));
          if (!PHOTO_RE.test(name)) continue;
          const file = path.join(photosDir(config), name);
          if (fs.existsSync(file)) fs.rmSync(file, { force: true });
        }
        if (item.invoice_path) {
          const file = path.join(invoicesDir(config), path.basename(item.invoice_path));
          if (fs.existsSync(file)) fs.rmSync(file, { force: true });
        }
      }
    } else if (!deleteBin(db, id)) {
      throw new HttpError(404, 'Kiste nicht gefunden.');
    }

    if (bin.photo_path) {
      const file = path.join(photosDir(config), path.basename(bin.photo_path));
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    }
    res.json({ deleted: true, deleted_items: removedItems });
  });

  /* ------------------------------ Kistenfoto ---------------------------- */

  app.post(
    '/api/bins/:id/photo',
    route(async (req, res) => {
      const id = Number(req.params.id);
      const bin = getBin(db, id);
      if (!bin) throw new HttpError(404, 'Kiste nicht gefunden.');
      const photo = await preparePhoto(config, req.body?.image ?? req.body?.photo);
      if (bin.photo_path) {
        const previous = path.join(photosDir(config), path.basename(bin.photo_path));
        if (fs.existsSync(previous)) fs.rmSync(previous, { force: true });
      }
      res.json({ bin: setBinPhoto(db, id, photo.path) });
    }),
  );

  app.get('/api/bins/:id/photo', (req, res) => {
    const bin = getBin(db, Number(req.params.id));
    if (!bin) throw new HttpError(404, 'Kiste nicht gefunden.');
    if (!bin.photo_path) throw new HttpError(404, 'Kein Foto hinterlegt.');
    const name = path.basename(bin.photo_path);
    if (!PHOTO_RE.test(name)) throw new HttpError(400, 'Ungültiger Dateiname.');
    const file = path.join(photosDir(config), name);
    if (!fs.existsSync(file)) throw new HttpError(404, 'Foto fehlt.');
    res.setHeader('Cache-Control', 'no-store');
    res.type(imageMime(name)).sendFile(file);
  });

  app.delete('/api/bins/:id/photo', (req, res) => {
    const id = Number(req.params.id);
    const bin = getBin(db, id);
    if (!bin) throw new HttpError(404, 'Kiste nicht gefunden.');
    if (bin.photo_path) {
      const file = path.join(photosDir(config), path.basename(bin.photo_path));
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    }
    res.json({ bin: setBinPhoto(db, id, '') });
  });

  // "Kiste voll": dauerhaft markieren -> nur noch sehr kleine Gegenstände.
  app.post('/api/bins/:id/full', (req, res) => {
    res.json({ bin: markBinFull(db, Number(req.params.id), true) });
  });
  app.delete('/api/bins/:id/full', (req, res) => {
    res.json({ bin: markBinFull(db, Number(req.params.id), false) });
  });

  /* ---------------------------- Gegenstände ---------------------------- */

  app.get('/api/items', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'stored';
    const binId = req.query.bin_id ? Number(req.query.bin_id) : null;
    const items = binId
      ? listItems(db, { status }).filter((it) => it.bin_id === binId)
      : listItems(db, { status });
    res.json({ items });
  });

  /** "Gibt es das schon?" – ähnliche eingelagerte Artikel samt Kiste. */
  app.get('/api/items/similar', (req, res) => {
    const query = String(req.query.q ?? '').trim();
    const category = String(req.query.category ?? '').trim();
    if (!query && !category) {
      res.json({ query: '', items: [] });
      return;
    }
    const items = listItems(db, { status: 'stored', limit: 500 });
    const matches = findSimilarItems(items, {
      query,
      category,
      limit: Math.min(Math.max(Number(req.query.limit) || 5, 1), 10),
      excludeId: req.query.exclude_id ? Number(req.query.exclude_id) : null,
    });
    res.json({
      query: [query, category].filter(Boolean).join(' '),
      items: matches.map(({ item, score }) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        quantity: item.quantity ?? 1,
        bin: item.bin ? { id: item.bin.id, code: item.bin.code, name: item.bin.name, location: item.bin.location } : null,
        bin_id: item.bin_id,
        volume_liters: item.volume_liters,
        score,
      })),
    });
  });

  app.get('/api/items/:id', (req, res) => {
    const item = getItem(db, Number(req.params.id));
    if (!item) throw new HttpError(404, 'Gegenstand nicht gefunden.');
    res.json({ item, reviews: listReviews(db, item.id) });
  });

  app.post('/api/items', (req, res) => {
    const body = { ...(req.body ?? {}) };
    if (!String(body.name ?? '').trim()) throw new HttpError(400, 'Der Gegenstand braucht einen Namen.');
    // Formularwerte kommen als Strings an -> IDs und Zahlen normalisieren.
    if (body.bin_id === '' || body.bin_id == null) body.bin_id = null;
    else if (body.bin_id !== 'auto') body.bin_id = Number(body.bin_id);
    if (body.bin_id === 'auto') {
      const suggestion = suggestFor({
        dims_cm: body.dims_cm,
        weight_g: body.weight_g,
        shape: body.shape,
        category: body.category,
        name: body.name,
        tags: body.tags,
        quantity: Number(body.quantity) || 1,
      });
      if (!suggestion.best) {
        res.status(409).json({ error: suggestion.reason_text, suggestion, needs_bigger_box: true });
        return;
      }
      body.bin_id = suggestion.best.box.id;
      body.position = suggestion.best.position ?? undefined;
    }
    const item = createItem(db, body);
    res.status(201).json({ item });
  });

  app.put('/api/items/:id', (req, res) => {
    const body = { ...(req.body ?? {}) };
    if (body.purchase_date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.purchase_date))) {
        throw new HttpError(400, 'Kaufdatum bitte als JJJJ-MM-TT angeben.');
      }
    }
    if (body.purchase_price != null && body.purchase_price !== '') {
      const price = Number(String(body.purchase_price).replace(',', '.'));
      if (!Number.isFinite(price) || price < 0) throw new HttpError(400, 'Kaufpreis ist ungültig.');
    }
    if (body.photos !== undefined) delete body.photos; // nur über die Foto-Routen

    // Maße/Gewicht/Form ändern -> neu platzieren (eigene Funktion, wirft 409).
    const dimsProvided = body.dims_cm !== undefined || body.dims !== undefined;
    const detailsChanged = dimsProvided
      || body.weight_g !== undefined || body.weightGrams !== undefined
      || body.shape !== undefined
      || body.volume_liters !== undefined || body.volumeLiters !== undefined;
    if (dimsProvided) {
      const check = body.dims_cm ?? body.dims;
      if (check != null && check !== '' && !(Number(check.length_cm) > 0 && Number(check.width_cm) > 0 && Number(check.height_cm) > 0)) {
        throw new HttpError(400, 'Bitte Länge, Breite und Höhe in cm angeben.');
      }
    }
    if (detailsChanged) {
      updateItemDimensions(db, Number(req.params.id), {
        dims_cm: body.dims_cm ?? body.dims,
        weight_g: body.weight_g ?? body.weightGrams,
        shape: body.shape,
        volume_liters: body.volume_liters ?? body.volumeLiters,
      });
    }
    if (body.quantity !== undefined) {
      const qty = Number(body.quantity);
      if (!Number.isFinite(qty) || qty < 1 || qty > 9999) {
        throw new HttpError(400, 'Stückzahl muss zwischen 1 und 9999 liegen.');
      }
      body.quantity = Math.round(qty);
    }
    const item = updateItem(db, Number(req.params.id), body);
    res.json({ item });
  });

  /* ------------------------------ Fotos --------------------------------- */

  app.post(
    '/api/items/:id/photos',
    route(async (req, res) => {
      const id = Number(req.params.id);
      const item = getItem(db, id);
      if (!item) throw new HttpError(404, 'Gegenstand nicht gefunden.');
      const body = req.body ?? {};
      const images = Array.isArray(body.images) ? body.images : (body.image ? [body.image] : []);
      if (!images.length) throw new HttpError(400, 'Keine Fotos übermittelt.');
      const limit = Math.min(config.upload.imagesPerItem, MAX_ITEM_PHOTOS);
      if ((item.photos?.length ?? 0) >= limit) {
        throw new HttpError(400, `Maximal ${limit} Fotos pro Gegenstand.`);
      }
      const room = limit - (item.photos?.length ?? 0);
      if (images.length > room) {
        throw new HttpError(400, `Maximal ${limit} Fotos pro Gegenstand (noch ${room} möglich).`);
      }
      const prepared = [];
      for (const image of images) {
        prepared.push(await preparePhoto(config, image));
      }
      const updated = addItemPhotos(db, id, prepared.map((p) => p.path), { limit });
      res.json({ item: updated, added: prepared.map((p) => p.path) });
    }),
  );

  app.delete('/api/items/:id/photos/:name', (req, res) => {
    const id = Number(req.params.id);
    const name = path.basename(String(req.params.name));
    if (!PHOTO_RE.test(name)) throw new HttpError(400, 'Ungültiger Dateiname.');
    const item = removeItemPhoto(db, id, `/api/photos/${name}`);
    const file = path.join(photosDir(config), name);
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    res.json({ item });
  });

  /* ---------------------------- Rechnung -------------------------------- */

  app.post(
    '/api/items/:id/invoice',
    route(async (req, res) => {
      const id = Number(req.params.id);
      const item = getItem(db, id);
      if (!item) throw new HttpError(404, 'Gegenstand nicht gefunden.');
      const body = req.body ?? {};
      const payload = body.file ?? body.invoice ?? body.image;
      const originalName = String(body.name ?? 'rechnung').slice(0, 200);
      const { buffer, mime } = decodePayload(payload, { what: 'Rechnung' });
      if (buffer.length > config.upload.maxBytes) {
        throw new HttpError(413, `Rechnung ist zu groß (max. ${Math.round(config.upload.maxBytes / 1024 / 1024)} MB).`);
      }
      const ext = invoiceExt(mime, originalName);
      if (!INVOICE_EXTS.has(ext)) throw new HttpError(400, 'Nur PDF, JPG, PNG oder WebP.');
      const previous = item.invoice_path ? path.join(invoicesDir(config), path.basename(item.invoice_path)) : null;
      const name = `${id}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
      fs.writeFileSync(path.join(invoicesDir(config), name), buffer);
      if (previous && fs.existsSync(previous)) fs.rmSync(previous, { force: true });
      const updated = setItemInvoice(db, id, { path: name, name: originalName });
      res.json({ item: updated });
    }),
  );

  app.get('/api/items/:id/invoice', (req, res) => {
    const item = getItem(db, Number(req.params.id));
    if (!item) throw new HttpError(404, 'Gegenstand nicht gefunden.');
    if (!item.invoice_path) throw new HttpError(404, 'Keine Rechnung hinterlegt.');
    const name = path.basename(item.invoice_path);
    const file = path.join(invoicesDir(config), name);
    if (!fs.existsSync(file)) throw new HttpError(404, 'Rechnungsdatei fehlt.');
    const ext = path.extname(name).replace('.', '').toLowerCase();
    const filename = item.invoice_name || name;
    const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    res.type(MIME_BY_EXT[ext] ?? 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.sendFile(file);
  });

  /* ------------------- Rechnung aus Paperless (LAN) ---------------------- */

  app.get('/api/paperless/status', (req, res) => {
    res.json({
      configured: paperlessClient.isConfigured,
      url: config.paperless.url || null,
      auth: paperlessClient.authMode ?? null,
    });
  });

  app.get(
    '/api/items/:id/invoice/search',
    route(async (req, res) => {
      const item = getItem(db, Number(req.params.id));
      if (!item) throw new HttpError(404, 'Gegenstand nicht gefunden.');
      const query = String(req.query.q ?? '').trim() || buildPaperlessQuery(item);
      if (!query) throw new HttpError(400, 'Kein Suchbegriff – bitte einen Begriff angeben.');
      const results = await paperlessClient.searchDocuments({ query, limit: Math.min(Number(req.query.limit) || 8, 20) });
      res.json({ query, results });
    }),
  );

  app.post(
    '/api/items/:id/invoice/paperless',
    route(async (req, res) => {
      const id = Number(req.params.id);
      const item = getItem(db, id);
      if (!item) throw new HttpError(404, 'Gegenstand nicht gefunden.');
      const documentId = Number(req.body?.document_id);
      if (!Number.isInteger(documentId) || documentId <= 0) {
        throw new HttpError(400, 'Bitte eine Paperless-Dokument-ID angeben.');
      }
      // Keine Kopie: nur prüfen, dass es das Dokument gibt, und einen Link speichern.
      const doc = await paperlessClient.getDocument(documentId);
      const base = String(config.paperless.url ?? '').replace(/\/+$/, '');
      if (!base) throw new HttpError(503, 'PAPERLESS_URL ist nicht gesetzt.');
      const link = `${base}/documents/${documentId}`;
      // Eine evtl. vorher hochgeladene lokale Datei wird entfernt.
      if (item.invoice_path) {
        const previous = path.join(invoicesDir(config), path.basename(item.invoice_path));
        if (fs.existsSync(previous)) fs.rmSync(previous, { force: true });
      }
      const updated = setItemInvoice(db, id, {
        path: null,
        name: doc.title || `Paperless ${documentId}`,
        source: 'paperless',
        ref: documentId,
        link,
      });
      res.json({ item: updated, document: { id: documentId, title: doc.title, url: link } });
    }),
  );

  app.delete('/api/items/:id/invoice', (req, res) => {
    const id = Number(req.params.id);
    const item = getItem(db, id);
    if (!item) throw new HttpError(404, 'Gegenstand nicht gefunden.');
    if (item.invoice_path) {
      const file = path.join(invoicesDir(config), path.basename(item.invoice_path));
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    }
    res.json({ item: clearItemInvoice(db, id) });
  });

  app.delete('/api/items/:id', (req, res) => {
    const id = Number(req.params.id);
    const item = getItem(db, id);
    if (!item) throw new HttpError(404, 'Gegenstand nicht gefunden.');
    const ok = deleteItem(db, id);
    if (!ok) throw new HttpError(404, 'Gegenstand nicht gefunden.');
    // Zugehörige Dateien entfernen (keine Waisen im Datenordner).
    for (const photo of item.photos ?? []) {
      const name = path.basename(String(photo));
      if (!PHOTO_RE.test(name)) continue;
      const file = path.join(photosDir(config), name);
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    }
    if (item.invoice_path) {
      const file = path.join(invoicesDir(config), path.basename(item.invoice_path));
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    }
    res.json({ deleted: true });
  });

  app.post('/api/items/:id/move', (req, res) => {
    const id = Number(req.params.id);
    const body = req.body ?? {};
    if (body.box_id === 'auto' || body.bin_id === 'auto') {
      const item = getItem(db, id);
      if (!item) throw new HttpError(404, 'Gegenstand nicht gefunden.');
      const suggestion = suggestFor({ ...item, id });
      if (!suggestion.best) {
        res.status(409).json({ error: suggestion.reason_text, suggestion, needs_bigger_box: true });
        return;
      }
      const moved = moveItem(db, id, suggestion.best.box.id);
      res.json({ item: moved, suggestion });
      return;
    }
    const target = body.bin_id ?? body.box_id ?? null;
    const item = moveItem(db, id, target == null ? null : Number(target));
    res.json({ item });
  });

  /* ------------------------------- Suche ------------------------------- */

  app.get('/api/search', (req, res) => {
    const query = String(req.query.q ?? '');
    const status = typeof req.query.status === 'string' ? req.query.status : 'stored';
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);
    // Kategorien: ?category=A&category=B oder ?categories=A,B
    const raw = [
      ...(Array.isArray(req.query.category) ? req.query.category : (req.query.category ? [req.query.category] : [])),
      ...(typeof req.query.categories === 'string' ? req.query.categories.split(',') : []),
    ];
    const categories = [...new Set(raw.map((c) => String(c).trim()).filter(Boolean))].slice(0, 20);
    res.json({ query, categories, items: searchItems(db, query, { limit, status, categories }) });
  });

  /** Vorgegebene Kategorien + verwendete Kategorien mit Anzahl. */
  app.get('/api/categories', (req, res) => {
    const items = listItems(db, { status: 'stored', limit: 5000 });
    const counts = new Map();
    for (const item of items) {
      for (const cat of item.categories ?? []) counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    const categories = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'de'));
    res.json({ categories, taxonomy: CATEGORY_TAXONOMY });
  });

  /* ------------------------- Foto + KI-Analyse ------------------------- */

  app.post(
    '/api/analyze',
    route(async (req, res) => {
      const cfg = runtime();
      if (!cfg.llm.apiKey) {
        throw new HttpError(503, 'Kein LLM_API_KEY gesetzt. Bitte in der .env eintragen (z. B. OpenRouter-Key).');
      }
      const photo = await preparePhoto(config, req.body?.image ?? req.body?.photo);
      const analysis = await analyzeImage({
        llm,
        photo: {
          imageDataUrl: photo.imageDataUrl,
          hint: typeof req.body?.hint === 'string' ? req.body.hint.slice(0, 300) : undefined,
          productHint: typeof req.body?.product_hint === 'string' ? req.body.product_hint.slice(0, 200) : undefined,
        },
        opts: { webLookup: req.body?.web_lookup !== false },
      });
      // KI-Kategorie auf die vorgegebene Taxonomie abbilden.
      const canonical = normalizeCategories([analysis.category]);
      analysis.category = canonical[0] ?? '';
      analysis.categories = canonical;
      res.json({
        analysis,
        photo: { path: photo.path, name: photo.name, bytes: photo.bytes },
      });
    }),
  );

  /* ----------------------------- Platzierung ---------------------------- */

  /** Baut aus einem Gegenstand (oder Maßen) einen Platzierungsvorschlag. */
  function suggestFor(itemLike, { excludeBoxIds = [], preferBoxId = null } = {}) {
    const boxes = listBins(db, { activeOnly: true });
    const items = listItems(db).filter((it) => it.id !== itemLike.id);
    const opts = {};
    if (itemLike.id) opts.excludeItemIds = [itemLike.id];
    if (excludeBoxIds.length) opts.excludeBoxIds = excludeBoxIds;
    if (preferBoxId) opts.preferBoxId = preferBoxId;
    const suggestion = suggestPlacement({
      boxes,
      items,
      dimsCm: itemLike.dims_cm ?? null,
      weightGrams: itemLike.weight_g ?? null,
      shape: itemLike.shape,
      volumeLiters: itemLike.volume_liters ?? null,
      category: itemLike.category ?? null,
      name: itemLike.name ?? null,
      tags: itemLike.tags ?? null,
      quantity: itemLike.quantity ?? 1,
      opts,
    });
    return suggestion;
  }

  app.post(
    '/api/suggest',
    route(async (req, res) => {
      const body = req.body ?? {};
      let itemLike;
      if (body.item_id) {
        itemLike = getItem(db, Number(body.item_id));
        if (!itemLike) throw new HttpError(404, 'Gegenstand nicht gefunden.');
      } else {
        itemLike = {
          dims_cm: body.dims_cm ?? body.dims ?? null,
          weight_g: body.weight_g ?? body.weightGrams ?? null,
          shape: body.shape ?? null,
          volume_liters: body.volume_liters ?? body.volumeLiters ?? null,
          category: typeof body.category === 'string' ? body.category.slice(0, 80) : null,
          name: typeof body.name === 'string' ? body.name.slice(0, 120) : null,
          tags: Array.isArray(body.tags) ? body.tags.slice(0, 12).map(String) : null,
          quantity: Number(body.quantity) || 1,
        };
      }
      // "Kiste voll"/"Passt nicht": die Nutzerin kann einzelne Kisten ausschließen.
      const excludeBoxIds = Array.isArray(body.exclude_box_ids)
        ? body.exclude_box_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
        : [];
      const preferBoxId = Number(body.prefer_box_id) || null;
      res.json({ suggestion: suggestFor(itemLike, { excludeBoxIds, preferBoxId }) });
    }),
  );

  /* ------------------------------ Posteingang --------------------------- */

  app.get('/api/inbox', (req, res) => {
    const items = listItems(db, { status: 'stored', limit: 500 }).filter((it) => !it.bin_id);
    res.json({ items, count: items.length });
  });

  /** Schnell-Erfassung: Foto rein, Artikel in den Posteingang, Analyse später. */
  app.post(
    '/api/inbox',
    route(async (req, res) => {
      const body = req.body ?? {};
      const photo = await preparePhoto(config, body.image ?? body.photo);
      const hint = typeof body.hint === 'string' ? body.hint.trim().slice(0, 80) : '';
      const now = new Date();
      const fallback = `Foto ${now.toLocaleDateString('de-DE')}, ${now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
      const item = createItem(db, {
        name: hint || fallback,
        photo_path: photo.path,
        photos: [photo.path],
      });
      res.status(201).json({
        item,
        image_data_url: photo.imageDataUrl,
        auto_named: !hint,
        inbox_count: listItems(db, { status: 'stored', limit: 500 }).filter((it) => !it.bin_id).length,
      });
    }),
  );

  /** Stapelweise einlagern (optional nur bestimmte IDs). */
  app.post(
    '/api/inbox/assign',
    route(async (req, res) => {
      const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
        : null;
      const inbox = listItems(db, { status: 'stored', limit: 500 })
        .filter((it) => !it.bin_id && (!ids || ids.includes(it.id)));
      const assigned = [];
      const failed = [];
      for (const item of inbox) {
        const suggestion = suggestFor({ ...item });
        if (!suggestion.best) {
          failed.push({ id: item.id, name: item.name, reason: suggestion.reason_text });
          continue;
        }
        try {
          const moved = moveItem(db, item.id, suggestion.best.box.id);
          assigned.push({ id: item.id, name: moved.name, bin: moved.bin?.code ?? null });
        } catch (err) {
          failed.push({ id: item.id, name: item.name, reason: err.message });
        }
      }
      res.json({ assigned, failed, remaining: inbox.length - assigned.length });
    }),
  );

  /* ------------------------------ Aufräumen ----------------------------- */

  /** Deterministische Prüfung: Umlager-Vorschläge + Dichte (Blei/Helium). */
  app.get('/api/housekeeping', (req, res) => {
    const items = listItems(db, { status: 'stored', limit: 5000 });
    const dismissed = listDismissedSuggestions(db);
    const suggestions = findConsolidationSuggestions(items)
      .filter((s) => !dismissed.has(s.signature));
    const issues = findPlausibilityIssues(items)
      .filter((i) => !dismissed.has(i.signature));
    res.json({ suggestions, issues, checked: items.length, dismissed: dismissed.size });
  });

  /** Vorschlag ablehnen – wird danach nicht mehr angezeigt. */
  app.post('/api/housekeeping/dismiss', (req, res) => {
    const signature = String(req.body?.signature ?? '').trim();
    if (!signature) throw new HttpError(400, 'Signatur fehlt.');
    dismissSuggestion(db, signature, req.body?.reason);
    res.json({ dismissed: true, signature });
  });

  /* ------------------------------ Erinnerung ---------------------------- */

  function recallSettings(cfg) {
    return {
      recall_interval_days: cfg.recall.intervalDays,
      recall_items_per_recall: cfg.recall.itemsPerRecall,
      recall_min_item_age_days: cfg.recall.minItemAgeDays,
      recall_max_items: cfg.recall.maxItems,
    };
  }

  app.get(
    '/api/recall',
    route(async (req, res) => {
      const cfg = runtime();
      if (!cfg.recall.enabled) {
        res.json({ enabled: false, items: [], candidates: 0, eligible: 0 });
        return;
      }
      // Artikel im Posteingang (noch ohne Kiste) werden nicht zur Prüfung vorgeschlagen.
      const items = listItems(db).filter((it) => it.bin_id).map(toRecallItem);
      const selection = selectRecallItems({ items, settings: recallSettings(cfg) });
      res.json({
        enabled: true,
        interval_days: cfg.recall.intervalDays,
        items: selection.items,
        candidates: selection.candidates,
        eligible: selection.eligible,
      });
    }),
  );

  app.post(
    '/api/recall/:id',
    route(async (req, res) => {
      const cfg = runtime();
      const verdict = String(req.body?.verdict ?? '');
      if (!['keep', 'unused', 'discard', 'not_found'].includes(verdict)) {
        throw new HttpError(400, 'Unbekannte Bewertung (keep, unused, discard, not_found).');
      }
      const item = reviewItem(db, Number(req.params.id), verdict, {
        note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : '',
        intervalDays: cfg.recall.intervalDays,
      });
      res.json({ item, next_review_at: item.next_review_at });
    }),
  );

  /* ------------------------------ Einstellungen ------------------------- */

  app.get('/api/settings', (req, res) => {
    const cfg = runtime();
    res.json({
      settings: getSettings(db),
      effective: {
        llm_model: cfg.llm.model,
        llm_vision_model: cfg.llm.visionModel,
        llm_web_model: cfg.llm.webModel,
        llm_base_url: cfg.llm.baseUrl,
        llm_configured: Boolean(cfg.llm.apiKey),
        llm_web_search: cfg.llm.webSearch,
        recall_enabled: cfg.recall.enabled,
        recall_interval_days: cfg.recall.intervalDays,
        recall_items_per_recall: cfg.recall.itemsPerRecall,
        recall_min_item_age_days: cfg.recall.minItemAgeDays,
        recall_max_items: cfg.recall.maxItems,
        app_name: config.appName,
        timezone: config.timezone,
        max_upload_mb: Math.round(config.upload.maxBytes / 1024 / 1024),
        paperless_configured: paperlessClient.isConfigured,
        paperless_url: config.paperless.url || null,
        paperless_auth: paperlessClient.authMode ?? null,
      },
    });
  });

  app.put('/api/settings', (req, res) => {
    const body = req.body ?? {};
    const patch = {};
    for (const key of SETTINGS_KEYS) {
      if (body[key] === undefined) continue;
      if (key === 'llm_base_url' || key === 'llm_model' || key === 'llm_vision_model' || key === 'llm_web_model') {
        const value = String(body[key] ?? '').trim();
        if (value) patch[key] = value;
        continue;
      }
      if (key === 'recall_enabled') {
        patch[key] = body[key] === true || body[key] === 'true' || body[key] === 1 || body[key] === '1';
        continue;
      }
      const num = Number(String(body[key]).replace(',', '.'));
      if (!Number.isFinite(num) || num < 0) throw new HttpError(400, `Ungültiger Wert für ${key}.`);
      patch[key] = Math.round(num);
    }
    setSettings(db, patch);
    res.json({ settings: getSettings(db) });
  });

  /* -------------------------------- Fotos ------------------------------- */

  app.get('/api/photos/:name', (req, res) => {
    const name = path.basename(String(req.params.name));
    if (!PHOTO_RE.test(name)) throw new HttpError(400, 'Ungültiger Dateiname.');
    const file = path.join(photosDir(config), name);
    if (!fs.existsSync(file)) throw new HttpError(404, 'Foto nicht gefunden.');
    // Fotos ändern sich (Drehen) -> nie aus dem Browser-Cache bedienen.
    res.setHeader('Cache-Control', 'no-store');
    res.type(imageMime(name)).sendFile(file);
  });

  /** Foto um 90° drehen (Richtung: left/right) bzw. 180°/270°. */
  app.post(
    '/api/items/:id/photos/:name/rotate',
    route(async (req, res) => {
      const id = Number(req.params.id);
      const name = path.basename(String(req.params.name));
      if (!PHOTO_RE.test(name)) throw new HttpError(400, 'Ungültiger Dateiname.');
      const item = getItem(db, id);
      if (!item) throw new HttpError(404, 'Gegenstand nicht gefunden.');
      const photoPath = `/api/photos/${name}`;
      if (!(item.photos ?? []).includes(photoPath)) {
        throw new HttpError(404, 'Dieses Foto gehört nicht zu dem Gegenstand.');
      }
      const file = path.join(photosDir(config), name);
      if (!fs.existsSync(file)) throw new HttpError(404, 'Foto nicht gefunden.');

      const direction = String(req.body?.direction ?? '').toLowerCase();
      const requested = Number(req.body?.degrees);
      const degrees = direction === 'left' || requested === -90 || requested === 270
        ? 270
        : requested === 180
          ? 180
          : 90;
      const ext = path.extname(file).replace('.', '').toLowerCase();
      // Datei als Buffer lesen: sharps Datei-Cache könnte bei schnell
      // aufeinanderfolgenden Drehungen noch den alten Stand liefern.
      const pipeline = sharp(fs.readFileSync(file)).rotate(degrees);
      const rotated = ext === 'webp'
        ? await pipeline.webp({ quality: 80 }).toBuffer()
        : ext === 'png'
          ? await pipeline.png().toBuffer()
          : await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
      fs.writeFileSync(file, rotated);
      res.json({ item: touchItem(db, id), rotation: degrees });
    }),
  );

  /* ------------------------------ Statisch ------------------------------ */

  // maxAge 0: nach einem Update bekommt der Browser sofort die neue UI (kein Hard-Reload nötig).
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: 0 }));
  // Single-Page-Fallback: alles außer /api/ bekommt die index.html.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path === '/api' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  /* ----------------------------- Fehler --------------------------------- */

  // 404 für unbekannte API-Routen
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Unbekannter API-Endpunkt.', code: 'NOT_FOUND' });
  });

  app.use((err, req, res, _next) => {
    const status = Number(err.status) || (err instanceof ValidationError ? 400 : 500);
    if (status >= 500) console.error('[storder]', err);
    res.status(status).json({
      error: err.message || 'Interner Fehler.',
      code: err.code ?? 'ERROR',
      ...(err.details ? { details: err.details } : {}),
    });
  });

  return app;
}

/* ------------------------------ Start ---------------------------------- */

function lanUrls(port) {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) urls.push(`http://${net.address}:${port}`);
    }
  }
  return urls;
}

export function start() {
  const config = loadConfig();
  const { db, file } = openDatabase(config.dataDir);
  const llm = createLlmClient(config);

  if (config.seed.enabled) {
    const result = seedBins(db, config.seed.boxes);
    if (result.created) console.log(`[storder] ${result.created} Standardkisten angelegt.`);
  }

  const paperless = createPaperlessClient(config);
  const app = createApp({ config, db, llm, paperless });
  const server = app.listen(config.port, config.host, () => {
    console.log(`\n${config.appName} läuft auf http://localhost:${config.port}`);
    for (const url of lanUrls(config.port)) console.log(`  im Heimnetz: ${url}`);
    console.log(`  Datenbank:   ${file}`);
    console.log(`  KI:          ${config.llm.apiKey ? `aktiv (${config.llm.visionModel})` : 'nicht konfiguriert (LLM_API_KEY fehlt)'}`);
    const paperlessInfo = !paperless.isConfigured
      ? 'nicht konfiguriert (PAPERLESS_URL + TOKEN oder USERNAME/PASSWORD)'
      : `${config.paperless.url} (${paperless.authMode === 'login' ? 'Login mit Benutzername/Passwort' : 'API-Token'})`;
    console.log(`  Paperless:   ${paperlessInfo}\n`);
  });

  const shutdown = () => {
    server.close(() => {
      try { db.close(); } catch { /* egal */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) start();
