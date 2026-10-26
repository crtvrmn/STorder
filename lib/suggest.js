// Platzierungs-Service: verbindet Volumenberechnung mit der Kisten-Suche.
// Rein logisch (keine DB/IO) -> einfach testbar.

import { computeRequiredVolume, toCm, toGrams, round } from './geometry.js';
import { findPlacement } from './placement.js';

export const RESERVE_FACTOR = 1.0; // Sicherheitsreserve auf das freie Volumen

const REASON_TEXT = {
  fits: 'Passt in diese Kiste.',
  too_big_for_box: 'Gegenstand ist größer als der Innenraum der Kiste.',
  marked_full: 'Kiste ist als voll markiert – nur noch für sehr kleine Dinge.',
  not_enough_volume: 'Kiste hat nicht mehr genug freies Volumen.',
  no_free_position: 'Kein freier Platz in der Kiste, obwohl Volumen frei ist.',
  no_dimensions: 'Kiste hat keine gültigen Innenmaße.',
  inactive: 'Kiste ist deaktiviert.',
  no_boxes: 'Es sind keine Kisten angelegt.',
};

/** Normalisiert Kisten- und Gegenstands-Datensätze aus der DB für das Packing. */
export function prepareBox(box) {
  const dims = box.inner_dims ?? { a: box.a, b: box.b, c: box.c };
  const a = toCm(dims?.a ?? box.length_cm);
  const b = toCm(dims?.b ?? box.width_cm);
  const c = toCm(dims?.c ?? box.height_cm);
  if (!a || !b || !c) return null;
  return {
    id: box.id,
    code: box.code,
    name: box.name,
    location: box.location,
    active: box.active !== 0 && box.active !== false,
    fill_height_cm: box.fill_height_cm != null ? Number(box.fill_height_cm) : null,
    max_weight_g: box.max_weight_g != null ? Number(box.max_weight_g) : null,
    length_cm: a,
    width_cm: b,
    height_cm: c,
    inner_dims: { a, b, c },
    axes: box.axes,
  };
}

export function prepareItem(it) {
  return {
    id: it.id,
    // DB-Gegenstände nutzen bin_id, das Packing rechnet intern mit box_id.
    box_id: it.box_id ?? it.bin_id ?? null,
    x_cm: it.x_cm ?? it.position?.x_cm ?? 0,
    y_cm: it.y_cm ?? it.position?.y_cm ?? 0,
    z_cm: it.z_cm ?? it.position?.z_cm ?? 0,
    size_cm: typeof it.size_cm === 'string' ? safeJson(it.size_cm) : it.size_cm,
    weight_g: toGrams(it.weight_g) ?? 0,
    name: it.name,
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Empfiehlt einen Ablageort.
 * @param {object} p
 * @param {Array} p.boxes   Kisten (roh aus DB oder via prepareBox)
 * @param {Array} p.items   Gegenstände in den Kisten (roh oder via prepareItem)
 * @param {object} p.dimsCm {length_cm,width_cm,height_cm} (optional)
 * @param {number} p.weightGrams
 * @param {string} p.shape
 * @param {number} p.volumeLiters  manuell überschreiben
 * @param {string} p.category  Kategorie des Gegenstands (für die Kistenzuordnung)
 * @param {string} p.name      Name/Titel des Gegenstands
 * @param {string[]} p.tags    weitere Stichworte
 * @param {object} p.opts   excludeBoxIds, excludeItemIds, reserveFactor
 */
export function suggestPlacement({
  boxes = [], items = [], dimsCm, weightGrams, shape, volumeLiters,
  category, name, tags, quantity = 1, opts = {},
}) {
  const qty = Math.max(1, Math.min(Math.floor(Number(quantity) || 1), 9999));
  const baseVolume = Number(volumeLiters) > 0
    ? { liters: Number(volumeLiters), confidence: 'manual', method: 'manual' }
    : computeRequiredVolume({ dims: dimsCm, shape, weightGrams });
  // Stückzahl: alle Exemplare brauchen zusammen Platz.
  const volume = baseVolume
    ? {
      ...baseVolume,
      quantity: qty,
      unit_liters: baseVolume.liters,
      liters: round(baseVolume.liters * qty, 3),
    }
    : null;

  const preparedBoxes = boxes.map((b) => b.inner_dims ? b : prepareBox(b)).filter(Boolean);
  // Immer normalisieren: DB-Objekte liefern size_cm schon als Array, haben aber
  // bin_id/position statt box_id/x_cm – das muss auf die Packing-Form gemappt werden.
  const preparedItems = items.map((it) => prepareItem(it));

  const result = findPlacement({
    boxes: preparedBoxes,
    items: preparedItems,
    volumeLiters: volume?.liters ?? 0,
    dimsCm,
    weightGrams,
    category,
    name,
    tags,
    opts: { reserveFactor: RESERVE_FACTOR, ...opts },
  });

  const toSuggestion = (r) => {
    if (!r) return null;
    return {
      box: {
        id: r.box.id,
        code: r.box.code,
        name: r.box.name,
        location: r.box.location,
        capacity_liters: r.capacityLiters ?? null,
        used_liters: r.usedLiters ?? null,
        free_liters: r.freeLiters,
        fill_percent: r.fillPercent,
        fill_after_percent: r.fillAfter,
        category_match: Boolean(r.categoryMatch),
        category_hits: r.categoryHits ?? [],
        marked_full: Boolean(r.markedFull),
      },
      position: r.position,
      score: r.score,
      category_match: Boolean(r.categoryMatch),
    };
  };

  // "Fehlt noch"-Wert nur, wenn das benötigte Volumen das freie übersteigt.
  const shortfall = result.best && volume?.liters
    ? Math.max(0, round(volume.liters - (result.best.freeLiters ?? 0), 2))
    : null;

  return {
    volume: volume ?? null,
    best: toSuggestion(result.best),
    alternatives: result.alternatives.map(toSuggestion).filter(Boolean),
    considered: result.considered.map((r) => ({
      box_id: r.box.id,
      code: r.box.code,
      name: r.box.name,
      location: r.box.location,
      fits: r.fits,
      reason: r.reason,
      reason_text: REASON_TEXT[r.reason] ?? r.reason,
      free_liters: r.freeLiters,
      fill_percent: r.fillPercent,
      fill_after_percent: r.fillAfter,
      category_match: Boolean(r.categoryMatch),
      category_hits: r.categoryHits ?? [],
      marked_full: Boolean(r.markedFull),
    })),
    reason: result.reason,
    reason_text: REASON_TEXT[result.reason] ?? REASON_TEXT.no_boxes,
    shortfall_liters: shortfall,
    // Platzhalter für die UI: Vorschlag, eine größere Kiste anzulegen
    needs_bigger_box: !result.best,
    recommended_min_liters: !result.best && volume?.liters
      ? round(volume.liters * 1.5, 1)
      : null,
  };
}
