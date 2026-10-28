// Baut eine einzelne, komplett eigenständige HTML-Seite (HTML/CSS/JS + Bilder
// als Data-URLs) für einen öffentlichen, durchsuchbaren Lagerkatalog.
// Keine Preise, Rechnungen oder Kaufdaten – nur Name, Beschreibung,
// Kategorien, Marke, optional Maße und Kisten-Code.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const TEMPLATE_URL = new URL('./public-template.html', import.meta.url);

const MIME_BY_EXT = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Foto als verkleinerte Data-URL (WebP), oder null. */
async function photoDataUrl(dataDir, photoPath, { maxSide, quality }) {
  const name = path.basename(String(photoPath ?? ''));
  if (!name) return null;
  const file = path.join(dataDir, 'photos', name);
  try {
    const buffer = await sharp(file)
      .rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();
    return `data:image/webp;base64,${buffer.toString('base64')}`;
  } catch {
    // Fallback: Originaldatei einbetten, wenn sharp sie nicht lesen kann.
    try {
      const raw = fs.readFileSync(file);
      const mime = MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
      return `data:${mime};base64,${raw.toString('base64')}`;
    } catch {
      return null;
    }
  }
}

/**
 * @param {Array} items  Artikel (aus listItems, status=stored)
 * @param {{dataDir:string, includeBoxes?:boolean, includeDims?:boolean,
 *          maxPhotos?:number, maxSide?:number, quality?:number, title?:string}} opts
 */
export async function buildPublicPage(items, {
  dataDir,
  includeBoxes = false,
  includeDims = false,
  maxPhotos = 3,
  maxSide = 720,
  quality = 72,
  title = 'Storder – Lagerkatalog',
} = {}) {
  const out = [];
  for (const item of items ?? []) {
    const photos = [];
    for (const photoPath of (item.photos ?? []).slice(0, Math.max(1, maxPhotos))) {
      const dataUrl = await photoDataUrl(dataDir, photoPath, { maxSide, quality });
      if (dataUrl) photos.push(dataUrl);
    }
    const dims = item.dims_cm;
    out.push({
      name: String(item.name ?? ''),
      description: String(item.description ?? ''),
      categories: Array.isArray(item.categories) ? item.categories.filter(Boolean) : (item.category ? [item.category] : []),
      brand: String(item.brand ?? ''),
      dims: includeDims && dims?.length_cm
        ? `${dims.length_cm} × ${dims.width_cm} × ${dims.height_cm} cm`
        : null,
      box: includeBoxes && item.bin ? String(item.bin.code ?? '') : null,
      photos,
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));

  const data = {
    title,
    generated_at: new Date().toISOString(),
    include: { boxes: Boolean(includeBoxes), dims: Boolean(includeDims) },
    items: out,
  };

  // "<" escapen, damit ein Name wie "</script>" den Datenblock nicht beendet.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const template = await fs.promises.readFile(TEMPLATE_URL, 'utf8');
  const html = template
    .replaceAll('__TITLE__', escapeHtml(title))
    .replace('__DATA__', json);

  return { html, items: out.length, bytes: Buffer.byteLength(html) };
}
