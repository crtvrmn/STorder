// Reine Geometrie-/Volumen-Helfer. Keine Abhängigkeiten -> gut testbar.

export const DIMENSION_KEYS = ['length_cm', 'width_cm', 'height_cm'];

export const SHAPE_FACTORS = {
  // Box: Bounding-Box exakt
  cuboid: 1.0,
  box: 1.0,
  // Nicht-quaderförmige Gegenstände: Bounding-Box * Faktor
  cylinder: 0.785, // π/4 – Zylinder in der Bounding-Box
  bottle: 0.7, // Flasche inkl. Hals
  sphere: 0.524, // π/6 – Kugel in der Bounding-Box
  irregular: 0.65, // Kabel, Werkzeug, sonstiges Ungeregeltes
  bag: 0.75, // Beutel / Softbag
  default: 0.7,
};

export const PACKING_FACTOR = 1.25; // 25 % Luft, damit Sachen rein- und rausgehen
export const DIMENSION_TOLERANCE = 1.08; // 8 % Aufschlag auf jede Kante

const DIMENSION_LIMITS = { min: 0.2, max: 300 }; // cm
const WEIGHT_LIMITS = { min: 0.001, max: 300000 }; // g

function round(value, digits = 2) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Wandelt einen beliebigen Wert (Zahl, "12,5", "12 cm", {value,unit}) in cm um. */
export function toCm(value) {
  if (value == null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    value = value.value ?? value.amount ?? value.number ?? null;
    if (value == null) return null;
  }
  let text = String(value).trim().toLowerCase().replace(',', '.');
  if (!text) return null;
  let factor = 1;
  if (/\bmm\b|millimeter/.test(text)) factor = 0.1;
  else if (/\bdm\b|dezimeter/.test(text)) factor = 10;
  else if (/\bm\b|meter(?!\w)/.test(text) && !/cm|mm/.test(text)) factor = 100;
  const match = text.match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  if (!Number.isFinite(num) || num <= 0) return null;
  const cm = num * factor;
  return round(Math.min(Math.max(cm, DIMENSION_LIMITS.min), DIMENSION_LIMITS.max), 2);
}

/** Wandelt Gewicht in Gramm um. Versteht g, kg, mg, lb, oz. */
export function toGrams(value) {
  if (value == null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const unit = String(value.unit ?? value.units ?? '').toLowerCase();
    value = value.value ?? value.amount ?? null;
    if (value == null) return null;
    return toGrams(`${value} ${unit}`);
  }
  let text = String(value).trim().toLowerCase().replace(',', '.');
  if (!text) return null;
  let factor = 1;
  if (/\bkg\b|kilogramm/.test(text)) factor = 1000;
  else if (/\bmg\b|milligramm/.test(text)) factor = 0.001;
  else if (/\blb\b|\bpound/.test(text)) factor = 453.592;
  else if (/\boz\b|ounce/.test(text)) factor = 28.3495;
  const match = text.match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  if (!Number.isFinite(num) || num <= 0) return null;
  const grams = num * factor;
  return round(Math.min(Math.max(grams, WEIGHT_LIMITS.min), WEIGHT_LIMITS.max), 1);
}

/**
 * Sortiert Maße absteigend (a >= b >= c) und rundet.
 * Akzeptiert mehrere Formen, damit alle Schichten dasselbe Objekt nutzen können:
 *   - { length_cm, width_cm, height_cm }  (Rohdaten / API)
 *   - { a, b, c }                          (normalisiert, z. B. aus der DB)
 *   - { dims_cm: { ...eine der beiden Formen } }
 *   - [x, y, z]                            (z. B. Weltmaße einer Kiste)
 */
export function normalizeDimensions(dims) {
  if (!dims || typeof dims !== 'object') return null;
  if (Array.isArray(dims)) {
    const values = dims.slice(0, 3).map((v) => toCm(v)).filter((v) => v != null);
    if (values.length !== 3) return null;
    const [a, b, c] = values.sort((x, y) => y - x);
    return { a, b, c };
  }
  const source =
    dims.dims_cm && typeof dims.dims_cm === 'object' && !Array.isArray(dims.dims_cm)
      ? { ...dims, ...dims.dims_cm }
      : dims;
  let values = DIMENSION_KEYS.map((key) => toCm(source[key])).filter((v) => v != null);
  if (values.length !== 3) {
    values = ['a', 'b', 'c'].map((key) => toCm(source[key])).filter((v) => v != null);
  }
  if (values.length !== 3) return null;
  const [a, b, c] = values.sort((x, y) => y - x);
  return { a, b, c };
}

/** Volumen in Litern aus Kantenlängen in cm (bereits sortiert oder nicht). */
export function boundingBoxLiters(dimsCm) {
  const norm = normalizeDimensions(dimsCm);
  if (!norm) return null;
  return round((norm.a * norm.b * norm.c) / 1000, 3);
}

export function shapeFactor(shape) {
  if (!shape) return SHAPE_FACTORS.default;
  return SHAPE_FACTORS[String(shape).toLowerCase()] ?? SHAPE_FACTORS.default;
}

/**
 * Berechnet das benötigte Stauvolumen (Liter) für einen Gegenstand.
 * - dims: { length_cm, width_cm, height_cm } (irgendeine Reihenfolge)
 * - shape: optionaler Formfaktor-Name
 * - weightGrams / weight_g: optional; wenn keine Maße vorhanden sind, wird
 *   das Volumen über eine Dichte geschätzt (nur als Fallback, lowConfidence).
 */
export function computeRequiredVolume({ dims, shape, weightGrams } = {}) {
  const norm = normalizeDimensions(dims);
  const weight = toGrams(weightGrams);
  if (norm) {
    const baseCm3 = norm.a * DIMENSION_TOLERANCE * norm.b * DIMENSION_TOLERANCE * norm.c * DIMENSION_TOLERANCE;
    const liters = round((baseCm3 * shapeFactor(shape) * PACKING_FACTOR) / 1000, 3);
    return {
      liters,
      confidence: weight ? 'measured' : 'estimated',
      method: 'dimensions',
      boundingBoxLiters: round((norm.a * norm.b * norm.c) / 1000, 3),
      weightGrams: weight,
      shape: shape ?? null,
    };
  }
  if (weight) {
    // Grobe Dichte-Heuristik (typische Lagerware ~ 0.35 g/cm³ inkl. Verpackung)
    const density = 0.35;
    const liters = round(((weight / density) * PACKING_FACTOR) / 1000, 3);
    return {
      liters,
      confidence: 'low',
      method: 'weight_heuristic',
      boundingBoxLiters: null,
      weightGrams: weight,
      shape: shape ?? null,
    };
  }
  return null;
}

/**
 * Prüft, ob ein Gegenstand mit achsparalleler Ausrichtung in einen freien
 * Quader (fA x fB x fC, je sortiert absteigend) passt. Kanten dürfen getauscht
 * werden; jede Kante wird mit der Toleranz beaufschlagt. Rotation um beliebige
 * Achsen (nicht achsparallel) wird bewusst nicht modelliert.
 */
export function fitsInBox(itemDimsCm, freeBoxCm) {
  const item = normalizeDimensions(itemDimsCm);
  const free = normalizeDimensions(freeBoxCm);
  if (!item || !free) return false;
  // Greedy: größte Gegenstands-Kante in größte freie Kante etc. ist für den
  // Quader-Fall optimal, weil die Dimensionen sortiert vorliegen.
  return (
    item.a * DIMENSION_TOLERANCE <= free.a + 1e-9 &&
    item.b * DIMENSION_TOLERANCE <= free.b + 1e-9 &&
    item.c * DIMENSION_TOLERANCE <= free.c + 1e-9
  );
}

export { round };
