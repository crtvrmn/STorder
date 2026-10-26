// Kisten-Belegung: Shelf-/3D-Packing in einem Koordinatensystem in cm.
//
// Konvention (siehe README): `axes` ist ein Permutationsarray, das die
// gespeicherten Innenmaße {a,b,c} (absteigend sortiert) auf die Weltachsen
// [x, y, z] der Kiste abbildet. Beispiel: axes = [1, 0, 2] => die größte
// Innenkante liegt entlang Y. Gegenstände werden achsparallel (6 Ausrichtungen)
// platziert, mit einer Füllhöhe in Z. Drehung um beliebige Achsen wird bewusst
// nicht modelliert – für Lagerkisten reicht das und bleibt robust.

import {
  normalizeDimensions,
  fitsInBox,
  DIMENSION_TOLERANCE,
  round,
} from './geometry.js';
import { categoryMatch } from './category.js';

const EPS = 1e-6;
const DEFAULT_AXES = [0, 1, 2];

/**
 * Als "voll" markierte Kisten bekommen nur noch sehr kleine Gegenstände:
 * bis zu diesem benötigten Volumen (Liter) werden sie weiter vorgeschlagen,
 * darüber gelten sie als voll. So bleibt eine volle Kiste für Kabel, Adapter
 * o. Ä. nutzbar, ohne dass große Sachen dort landen.
 */
export const FULL_BOX_MAX_ITEMS_LITERS = 2;

/** Permutationsreihenfolge für die 6 Achsen-Drehungen: dims[i] = base[order[i]]. */
const ROTATION_ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

export function parseAxes(axes) {
  if (Array.isArray(axes) && axes.length === 3) {
    const parsed = axes.map(Number);
    if ([0, 1, 2].every((n) => parsed.includes(n))) return parsed;
  }
  return DEFAULT_AXES;
}

/** Gespeicherte Innenmaße ({a,b,c}) + Achsen -> Weltmaße [x, y, z] in cm. */
export function boxExtentsCm(box, axes = DEFAULT_AXES) {
  const norm = normalizeDimensions(box);
  if (!norm) return null;
  const cm = [norm.a, norm.b, norm.c];
  const ax = parseAxes(axes);
  return [cm[ax[0]], cm[ax[1]], cm[ax[2]]];
}

const overlaps = (aMin, aMax, bMin, bMax) => aMin < bMax - EPS && bMin < aMax - EPS;
const overlaps1d = (p, min, max) => overlaps(min, max, p.x, p.x + p.size[0]);

/** Prüft, ob ein Quader-Kandidat einen der belegten Quader überschneidet. */
function intersects(cand, used) {
  for (const p of used) {
    if (
      overlaps(cand.x, cand.x + cand.size[0], p.x, p.x + p.size[0]) &&
      overlaps(cand.y, cand.y + cand.size[1], p.y, p.y + p.size[1]) &&
      overlaps(cand.z, cand.z + cand.size[2], p.z, p.z + p.size[2])
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Sucht einen freien achsparallelen Platz für einen Gegenstand.
 * - itemDimsCm: {length_cm,width_cm,height_cm}
 * - worldSize: [xLen, yLen, zLen] der Kiste in cm
 * - placements: [{x,y,z,size:[sx,sy,sz]}] (bereits mit Toleranz beaufschlagt)
 * - opts.fillHeight: max. Stapelhöhe in cm (default: volle Höhe)
 * - opts.maxWeight, opts.currentWeightGrams: Gewichtslimit der Kiste
 *
 * Strategie: zuerst von unten nach oben (stabile Stapel), danach von vorne
 * nach hinten, dann links nach rechts. Das ist deterministisch und packt
 * immer am niedrigsten freien Punkt.
 */
export function findFreePosition(itemDimsCm, worldSize, placements = [], opts = {}) {
  const dims = normalizeDimensions(itemDimsCm);
  const [xLen, yLen, zLen] = [Number(worldSize?.[0]), Number(worldSize?.[1]), Number(worldSize?.[2])];
  if (!dims || [xLen, yLen, zLen].some((n) => !Number.isFinite(n) || n <= 0)) return null;

  const fillHeight = Number(opts.fillHeight) > 0 ? Math.min(Number(opts.fillHeight), zLen) : zLen;
  if (opts.maxWeight != null && Number(opts.maxWeight) > 0) {
    const usedWeight = placements.reduce((sum, p) => sum + (Number(p.weightGrams) || 0), 0);
    if (usedWeight + (Number(opts.weightGrams) || 0) > Number(opts.maxWeight)) return null;
  }

  const t = DIMENSION_TOLERANCE;
  const base = [dims.a, dims.b, dims.c];
  const used = placements.filter((p) => Array.isArray(p.size) && p.size.length === 3);

  let best = null;
  for (const order of ROTATION_ORDERS) {
    const size = order.map((i) => base[i] * t);
    if (size[0] > xLen + EPS || size[1] > yLen + EPS || size[2] > fillHeight + EPS) continue;

    const xs = new Set([0]);
    const ys = new Set([0]);
    const zs = new Set([0]);
    for (const p of used) {
      if (p.x + size[0] <= xLen + EPS) xs.add(p.x);
      if (p.x + p.size[0] + size[0] <= xLen + EPS) xs.add(p.x + p.size[0]);
      if (p.y + size[1] <= yLen + EPS) ys.add(p.y);
      if (p.y + p.size[1] + size[1] <= yLen + EPS) ys.add(p.y + p.size[1]);
      if (p.z + p.size[2] + size[2] <= fillHeight + EPS) zs.add(p.z + p.size[2]);
    }

    for (const z of [...zs].sort((a, b) => a - b)) {
      if (z + size[2] > fillHeight + EPS) continue;
      // Kleinstes z zuerst; sobald wir ein z gefunden haben, sind größere z uninteressant.
      if (best && z > best.score[0] + EPS) break;
      for (const y of [...ys].sort((a, b) => a - b)) {
        for (const x of [...xs].sort((a, b) => a - b)) {
          const cand = { x, y, z, size };
          if (intersects(cand, used)) continue;
          const score = [z, y, x, size[2]];
          if (!best || lexLess(score, best.score)) {
            best = { score, ...cand, order };
          }
        }
      }
    }
  }
  if (!best) return null;
  return {
    x: round(best.x, 2),
    y: round(best.y, 2),
    z: round(best.z, 2),
    size: best.size.map((n) => round(n, 2)),
    // Originalmaße in der gefundenen Ausrichtung (ohne Toleranz)
    dimensions: best.order.map((i) => base[i]),
    rotation: best.order,
  };
}

function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > EPS) return a[i] < b[i];
  }
  return false;
}

/**
 * Bestandsaufnahme einer Kiste.
 * placements: [{id, x,y,z, size:[sx,sy,sz], weightGrams}]
 */
export function analyzeBox(box, placements = []) {
  const extents = boxExtentsCm(box, box.axes);
  if (!extents) return null;
  const [xLen, yLen, zLen] = extents;
  const capacityCm3 = xLen * yLen * zLen;
  let usedCm3 = 0;
  let weightGrams = 0;
  let maxHeight = 0;
  const packed = [];
  for (const p of placements) {
    if (!Array.isArray(p.size) || p.size.length !== 3) continue;
    // Stückzahl zählt für Volumen und Gewicht mit; die Kollisionsfläche bleibt
    // ein Quader (die Stücke stehen gedanklich zusammen).
    const qty = Math.max(1, Math.floor(Number(p.quantity) || 1));
    usedCm3 += p.size[0] * p.size[1] * p.size[2] * qty;
    weightGrams += (Number(p.weightGrams) || 0) * qty;
    maxHeight = Math.max(maxHeight, (Number(p.z) || 0) + p.size[2]);
    packed.push({ id: p.id, x: p.x, y: p.y, z: p.z, size: p.size, quantity: qty });
  }
  const freeCm3 = Math.max(capacityCm3 - usedCm3, 0);
  return {
    extents: [xLen, yLen, zLen],
    capacityCm3,
    usedCm3,
    freeCm3,
    freeLiters: round(freeCm3 / 1000, 3),
    usedLiters: round(usedCm3 / 1000, 3),
    fillPercent: capacityCm3 > 0 ? Math.min(100, round((usedCm3 / capacityCm3) * 100, 1)) : 100,
    floorAreaCm2: round(xLen * yLen, 2),
    weightGrams: round(weightGrams, 1),
    maxHeight: round(maxHeight, 2),
    placements: packed,
  };
}

/** Einzelnen Gegenstand auf einen beliebigen (neuen) Kistenmaßraum übertragen. */
export function fitForBox(itemDimsCm, box, fillHeight) {
  const extents = boxExtentsCm(box, box.axes);
  const dims = normalizeDimensions(itemDimsCm);
  if (!extents || !dims) return null;
  if (!fitsInBox(dims, extents)) return null;
  return findFreePosition(dims, extents, [], { fillHeight });
}

function packInput(it) {
  return {
    id: it.id,
    x: Number(it.x_cm) || 0,
    y: Number(it.y_cm) || 0,
    z: Number(it.z_cm) || 0,
    size: Array.isArray(it.size_cm) ? it.size_cm : null,
    weightGrams: Number(it.weight_g) || 0,
    quantity: Math.max(1, Math.floor(Number(it.quantity) || 1)),
  };
}

const REASON_ORDER = {
  too_big_for_box: 0,
  marked_full: 1,
  not_enough_volume: 2,
  no_free_position: 3,
  no_dimensions: 4,
  full: 5,
  inactive: 6,
};

/**
 * Durchsucht alle Kisten nach dem besten Platz für einen Gegenstand.
 * - volumeLiters: benötigtes Stauvolumen
 * - dimsCm: Originalmaße (ohne Toleranz); fehlen sie, geht nur die Volumensuche
 * - category/name/tags: für die inhaltliche Kistenzuordnung ("Küche" -> B1)
 * - opts.excludeBoxIds / opts.excludeItemIds / opts.reserveFactor
 *
 * Rückgabe: {best, fitting[], alternatives[], considered[], reason}
 */
export function findPlacement({ boxes, items, volumeLiters, dimsCm, weightGrams = 0, category, name, tags, opts = {} }) {
  const excludeBoxIds = new Set(opts.excludeBoxIds ?? []);
  // "Gleicher Artikel wie beim letzten Mal" -> dessen Kiste zuerst vorschlagen.
  const preferBoxId = Number(opts.preferBoxId) || null;
  const excludeItemIds = new Set(opts.excludeItemIds ?? []);
  const reserve = Number(opts.reserveFactor) > 0 ? Number(opts.reserveFactor) : 1;
  const needLiters = Math.max(Number(volumeLiters) || 0, 0);
  const needCm3 = needLiters * 1000;
  const weight = Number(weightGrams) || 0;
  const hasDims = Boolean(normalizeDimensions(dimsCm));
  // Was der Gegenstand ist – daraus wird die inhaltliche Kistenzuordnung.
  const itemText = [category, name, ...(Array.isArray(tags) ? tags : [])].filter(Boolean).join(' ');

  const byBox = new Map();
  for (const it of items) {
    if (!it.box_id || excludeItemIds.has(it.id)) continue;
    if (!byBox.has(it.box_id)) byBox.set(it.box_id, []);
    byBox.get(it.box_id).push(packInput(it));
  }

  const results = [];
  for (const box of boxes) {
    if (!box) continue;
    const boxText = [box.name, box.location, box.note, box.code].filter(Boolean).join(' ');
    const category = itemText ? categoryMatch(itemText, boxText) : { match: false, hits: [] };
    if (box.active === false || excludeBoxIds.has(box.id)) {
      results.push({
        box, fits: false, reason: 'inactive', freeLiters: null, fillPercent: null, position: null,
        categoryMatch: false, categoryHits: [],
      });
      continue;
    }
    const placements = byBox.get(box.id) ?? [];
    const analysis = analyzeBox(box, placements);
    if (!analysis) {
      results.push({
        box, fits: false, reason: 'no_dimensions', freeLiters: null, fillPercent: null, position: null,
        categoryMatch: category.match, categoryHits: category.hits,
      });
      continue;
    }
    // "Kiste voll": nur noch Kleinteile zulassen.
    const markedFull = Boolean(box.marked_full ?? box.full_marked_at);
    const blockedByFullMark = markedFull && needLiters > FULL_BOX_MAX_ITEMS_LITERS;
    const fillHeight = Number(box.fill_height_cm) > 0 ? Number(box.fill_height_cm) : analysis.extents[2];
    const fitsBox = hasDims && !blockedByFullMark ? fitsInBox(dimsCm, analysis.extents) : false;
    const fitsVolume = analysis.freeCm3 >= needCm3 * reserve - EPS;
    const position = fitsBox && fitsVolume
      ? findFreePosition(dimsCm, analysis.extents, analysis.placements, {
        fillHeight,
        maxWeight: box.max_weight_g,
        weightGrams: weight,
      })
      : null;
    const fits = Boolean(fitsBox && fitsVolume && position);
    const usedAfter = analysis.usedCm3 + (fitsVolume ? needCm3 : 0);
    const fillAfter = analysis.capacityCm3 > 0 ? round((usedAfter / analysis.capacityCm3) * 100, 1) : 100;
    const result = {
      box,
      fits,
      reason: fits
        ? 'fits'
        : blockedByFullMark
          ? 'marked_full'
          : !fitsBox
            ? 'too_big_for_box'
            : !fitsVolume
              ? 'not_enough_volume'
              : 'no_free_position',
      capacityLiters: round(analysis.capacityCm3 / 1000, 1),
      usedLiters: round(analysis.usedCm3 / 1000, 2),
      freeLiters: analysis.freeLiters,
      fillPercent: analysis.fillPercent,
      fillAfter,
      weightGrams: analysis.weightGrams,
      position,
      categoryMatch: category.match,
      categoryHits: category.hits,
      markedFull,
    };
    result.score = scoreSuggestion({ analysis, fits, fillAfter: fillAfter / 100, weightGrams: weight });
    results.push(result);
  }

  results.sort((a, b) => {
    if (a.fits !== b.fits) return a.fits ? -1 : 1;
    if (a.fits) {
      if (preferBoxId) {
        if (a.box.id === preferBoxId && b.box.id !== preferBoxId) return -1;
        if (b.box.id === preferBoxId && a.box.id !== preferBoxId) return 1;
      }
      // Inhaltliche Passung (Kategorie) schlägt die reine Füllstandsoptimierung:
      // ein Toaster gehört eher in "Küche" als in "Dokumente", auch wenn dort
      // mehr Platz frei wäre. Innerhalb derselben Gruppe entscheidet der Score.
      if (Boolean(a.categoryMatch) !== Boolean(b.categoryMatch)) return a.categoryMatch ? -1 : 1;
      // Als voll markierte Kisten sind nur Lückenfüller für Kleinteile.
      if (Boolean(a.markedFull) !== Boolean(b.markedFull)) return a.markedFull ? 1 : -1;
      return a.score - b.score || b.freeLiters - a.freeLiters;
    }
    if (a.reason !== b.reason) return (REASON_ORDER[a.reason] ?? 9) - (REASON_ORDER[b.reason] ?? 9);
    return (b.freeLiters ?? 0) - (a.freeLiters ?? 0);
  });

  const fitting = results.filter((r) => r.fits);
  return {
    best: fitting[0] ?? null,
    fitting,
    alternatives: fitting.slice(1),
    considered: results,
    reason: fitting.length ? 'fits' : results[0]?.reason ?? 'no_boxes',
  };
}

/**
 * Score (kleiner ist besser): Bevorzugt Kisten, die nach dem Einlagern noch
 * gut nutzbar bleiben (50–90 % Füllstand), wenig Gewicht tragen und nicht
 * unnötig groß sind. Kisten, die nirgends passen, werden nicht bewertet.
 */
export function scoreSuggestion({ analysis, fits, fillAfter, weightGrams = 0 }) {
  const capacityL = analysis.capacityCm3 / 1000;
  if (!capacityL) return 1e9;
  const target = fillAfter < 0.6 ? 0.75 : fillAfter < 0.95 ? 0.85 : 0.98;
  const fillPenalty = Math.abs(target - Math.max(fillAfter, analysis.fillPercent / 100)) * 2;
  const weightPenalty = Math.min((Number(analysis.weightGrams) || 0) + (Number(weightGrams) || 0), 500000) / 250000;
  const sizePenalty = Math.log10(Math.max(capacityL, 1)) * 0.05;
  const fitPenalty = fits ? 0 : 1;
  return round(fillPenalty + weightPenalty + sizePenalty + fitPenalty, 4);
}

/** Anzeige-Label der Innenmaße einer Kiste, z.B. "40 × 30 × 30 cm". */
export function boxDimensionsLabel(box) {
  const ext = boxExtentsCm(box, box.axes);
  if (!ext) return null;
  return `${ext[0]} × ${ext[1]} × ${ext[2]} cm`;
}
