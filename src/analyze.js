// Pipeline: Foto -> (LLM Vision) + (LLM Web) -> einheitliche Gegenstandsdaten.
// Die KI wird NICHT zur Platzsuche befragt – Volumen und Platz berechnen wir
// deterministisch aus Maßen/Gewicht. Die KI liefert nur Beschreibung + Maße.

import { computeRequiredVolume, boundingBoxLiters } from '../lib/geometry.js';

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

function complete(dims) {
  return Boolean(dims && dims.length_cm && dims.width_cm && dims.height_cm);
}

/**
 * @param {object} p
 * @param {{analyzePhoto:Function, lookupProduct:Function}} p.llm
 * @param {{imageDataUrl:string, hint?:string, productHint?:string}} p.photo
 * @param {{webLookup?:boolean, productHint?:string}} p.opts
 */
export async function analyzeImage({ llm, photo, opts = {} }) {
  const warnings = [];
  const webLookup = opts.webLookup !== false;

  let vision = null;
  let visionError = null;
  try {
    vision = await llm.analyzePhoto({
      imageDataUrl: photo.imageDataUrl,
      hint: [photo.hint, opts.productHint].filter(Boolean).join(' – '),
    });
  } catch (err) {
    visionError = err;
    warnings.push(`Bildanalyse fehlgeschlagen: ${err.message}`);
  }

  let product = null;
  let productError = null;
  const lookupTitle = [opts.productHint, vision?.brand, vision?.title, vision?.model]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(' ');
  if (webLookup && lookupTitle) {
    try {
      product = await llm.lookupProduct({
        title: lookupTitle,
        brand: vision?.brand,
        model: vision?.model,
        barcode: vision?.barcode,
        hint: photo.hint,
      });
    } catch (err) {
      productError = err;
      warnings.push(`Internet-Recherche fehlgeschlagen: ${err.message}`);
    }
  }

  if (!vision && !product) {
    // Nichts hat funktioniert -> Fehler weiterreichen (Statuscode des ersten Fehlers)
    const err = visionError ?? productError ?? new Error('Analyse fehlgeschlagen');
    err.code ||= 'ANALYZE_FAILED';
    err.status = err.status ?? 502;
    throw err;
  }

  const result = mergeSources({ vision, product, hint: opts.productHint, warnings, visionError, productError });
  return result;
}

/** Führt Vision- und Websuche-Ergebnis zusammen. Exportiert für Tests. */
export function mergeSources({ vision, product, hint, warnings = [], visionError = null, productError = null }) {
  const sources = [];
  if (vision) sources.push({ type: 'vision', confidence: vision.confidence, found: vision.identified !== false });
  if (product) sources.push({ type: 'web', confidence: product.confidence, found: product.found });

  const title = pickText([
    [product?.found && product.title, CONFIDENCE_RANK[product?.confidence] ?? 0, 'web'],
    [hint, 2, 'hint'],
    [vision?.title, CONFIDENCE_RANK[vision?.confidence] ?? 0, 'vision'],
  ]) || 'Unbekannter Gegenstand';

  const brand = firstNonEmpty(product?.found && product.brand, vision?.brand);
  const model = firstNonEmpty(product?.found && product.model, vision?.model);

  // Beschreibung: Web-Beschreibung bevorzugen (offizieller Text), sonst Vision.
  const description = firstNonEmpty(
    product?.found && product.description?.length >= 40 ? product.description : null,
    vision?.description,
    product?.description,
  ) || '';

  // Maße: die mit höherer Confidence gewinnen. Vision und Web gleichauf -> Web.
  // Web zuerst einfügen: bei gleicher Confidence gewinnt der Web-Treffer,
  // weil Array#sort stabil sortiert.
  const dimCandidates = [];
  if (complete(product?.dimensions)) dimCandidates.push({ dims: product.dimensions, conf: CONFIDENCE_RANK[product.confidence] ?? 0, src: 'web' });
  if (complete(vision?.dimensions)) dimCandidates.push({ dims: vision.dimensions, conf: CONFIDENCE_RANK[vision.confidence] ?? 0, src: 'vision' });
  dimCandidates.sort((a, b) => b.conf - a.conf);
  const chosenDims = dimCandidates[0] ?? null;
  const dims_cm = chosenDims
    ? {
      length_cm: chosenDims.dims.length_cm,
      width_cm: chosenDims.dims.width_cm,
      height_cm: chosenDims.dims.height_cm,
      source: chosenDims.src,
      confidence: chosenDims.dims.note ? 'medium' : 'high',
      note: [vision?.dimensions?.note, product?.dimensions?.note].filter(Boolean).join(' ').trim(),
    }
    : null;

  const weightCandidates = [
    [product?.weight_g, CONFIDENCE_RANK[product?.confidence] ?? 0, 'web'],
    [vision?.weight_g, CONFIDENCE_RANK[vision?.confidence] ?? 0, 'vision'],
  ].filter(([w]) => Number(w) > 0).sort((a, b) => b[1] - a[1]);
  const weight_g = weightCandidates[0]?.[0] ?? null;
  const weight_source = weightCandidates[0]?.[2] ?? null;

  const volume = computeRequiredVolume({ dims: dims_cm, shape: vision?.shape, weightGrams: weight_g });
  if (!volume) {
    warnings.push('Keine Maße und kein Gewicht gefunden – Volumen geschätzt (5 l Standard). Bitte vor dem Einlagern prüfen.');
  }

  const source_urls = [...new Set([...(product?.source_urls ?? []), ...(product?.citations ?? []).map((c) => c.url)].filter(Boolean))];
  const titleLooksLikeHint = Boolean(hint && title.toLowerCase() === hint.toLowerCase());

  return {
    title,
    title_source: titleLooksLikeHint ? 'hint' : title === product?.title ? 'web' : 'vision',
    description,
    category: firstNonEmpty(vision?.category, 'Sonstiges'),
    brand: brand || null,
    model: model || null,
    color: vision?.color || null,
    material: firstNonEmpty(product?.material, vision?.material) || null,
    barcode: firstNonEmpty(vision?.barcode, product?.barcode) || null,
    quantity: vision?.quantity ?? 1,
    tags: vision?.tags ?? [],
    shape: vision?.shape ?? 'irregular',
    condition: vision?.condition || null,
    dims_cm,
    bounding_box_liters: dims_cm ? boundingBoxLiters(dims_cm) : null,
    weight_g,
    weight_source,
    volume_liters: volume?.liters ?? 5,
    volume_method: volume?.method ?? 'default_estimate',
    volume_confidence: volume?.confidence ?? 'low',
    product: product
      ? {
        found: product.found,
        title: product.title,
        brand: product.brand,
        model: product.model,
        product_url: product.product_url || source_urls[0] || null,
        confidence: product.confidence,
        notes: product.notes,
        model_used: product.model,
      }
      : null,
    ai_analysis: {
      vision: vision
        ? {
          identified: vision.identified,
          confidence: vision.confidence,
          search_query: vision.search_query,
          notes: vision.notes,
          model: vision.model,
          usage: vision.usage,
        }
        : { error: visionError?.message ?? 'Bildanalyse fehlgeschlagen' },
      product: product
        ? { confidence: product.confidence, notes: product.notes, model: product.model, citations: product.citations }
        : { error: productError?.message ?? null },
      warnings,
      sources,
    },
    source_urls,
  };
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function pickText(candidates) {
  const sorted = candidates.filter(([text]) => typeof text === 'string' && text.trim());
  sorted.sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0]?.trim() ?? null;
}
