// Kleine Validierungshelfer (ohne Zusatz-Bibliotheken).

export class ValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.code = 'VALIDATION';
    this.status = 400;
    this.details = details;
  }
}

export const z = {
  str(value, fallback = '') {
    if (value == null) return fallback;
    const s = String(value).trim();
    return s || fallback;
  },
  /** Ganzzahl mit Grenzen. */
  int(value, fallback = 0, min = -Infinity, max = Infinity) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.round(n), min), max);
  },
  num(value, fallback = null, min = -Infinity, max = Infinity) {
    if (value == null || value === '') return fallback;
    const n = Number(String(value).replace(',', '.'));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  },
  bool(value, fallback = false) {
    if (value == null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return /^(1|true|yes|on)$/i.test(String(value));
  },
  strArray(value, limit = 20) {
    if (value == null) return [];
    const arr = Array.isArray(value) ? value : String(value).split(',');
    return arr
      .map((v) => String(v).trim())
      .filter(Boolean)
      .slice(0, limit);
  },
  /** Positive Zahl mit Nachkommastellen. */
  positive(value, fallback = null, max = 1e9) {
    const n = Number(String(value ?? '').replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, max);
  },
};

/** Prüft einen Kisten-Eingabewert. */
export function validateBoxInput(input, { partial = false } = {}) {
  const errors = {};
  const out = {};
  const has = (k) => input != null && Object.prototype.hasOwnProperty.call(input, k);

  if (!partial || has('code')) {
    const code = z.str(input?.code).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9 _./-]{0,19}$/.test(code)) errors.code = 'Code 1–20 Zeichen (A–Z, 0–9, - _ . /)';
    out.code = code;
  }
  if (has('name')) out.name = z.str(input.name).slice(0, 80);
  if (has('location')) out.location = z.str(input.location).slice(0, 80);
  if (has('description')) out.description = z.str(input.description).slice(0, 300);
  if (has('notes')) out.notes = z.str(input.notes).slice(0, 500);
  if (has('active')) out.active = z.bool(input.active, true);
  if (has('fill_height_cm')) out.fill_height_cm = z.positive(input.fill_height_cm, null, 300);
  if (has('max_weight_g')) out.max_weight_g = z.positive(input.max_weight_g, null, 1e6);

  const capacity = z.positive(input?.capacity_liters, null, 1e6);
  const dimsInput = input?.dims_cm ?? input?.dims;
  // Ohne Maße, aber mit Litern: Maße werden unten aus dem Volumen abgeleitet.
  if (dimsInput !== undefined || (!partial && !capacity)) {
    const length = z.positive(dimsInput?.length_cm ?? dimsInput?.length, null, 1e9);
    const width = z.positive(dimsInput?.width_cm ?? dimsInput?.width, null, 1e9);
    const height = z.positive(dimsInput?.height_cm ?? dimsInput?.height, null, 1e9);
    if (dimsInput == null || dimsInput === '') {
      if (!partial) errors.dims_cm = 'Innenmaße sind erforderlich';
      out.dims_cm = null;
    } else if (!length || !width || !height) {
      errors.dims_cm = 'Länge, Breite und Höhe angeben';
      out.dims_cm = null;
    } else if (length > 300 || width > 300 || height > 300) {
      errors.dims_cm = 'Maximal 300 cm je Kante';
      out.dims_cm = null;
    } else {
      const sorted = [length, width, height].sort((a, b) => b - a);
      out.dims_cm = { a: sorted[0], b: sorted[1], c: sorted[2] };
    }
  }

  if (has('axes')) {
    const ax = Array.isArray(input.axes) ? input.axes.map(Number) : null;
    out.axes = ax && ax.length === 3 && [0, 1, 2].every((n) => ax.includes(n)) ? ax : [0, 1, 2];
  }

  if (capacity && !out.dims_cm) {
    // Nur Volumen angegeben -> daraus plausible Innenmaße ableiten (würfelförmig).
    const edge = Math.cbrt(capacity * 1000);
    const rounded = Math.round(edge * 2) / 2;
    out.dims_cm = { a: rounded, b: rounded, c: rounded };
    out.derived_dims = true;
  }

  if (Object.keys(errors).length) throw new ValidationError('Ungültige Kistendaten', errors);
  return out;
}

/** Prüft Eingaben zum Einlagern/Verschieben. */
export function validatePlacementInput(input) {
  const errors = {};
  const out = {};
  if (input?.box_id === 'auto') {
    out.box_id = 'auto';
  } else if (input?.box_id != null && input.box_id !== '') {
    const boxId = Number(input.box_id);
    if (!Number.isInteger(boxId) || boxId <= 0) errors.box_id = 'Ungültige Kiste';
    out.box_id = boxId;
  } else {
    errors.box_id = 'Kiste angeben (box_id) oder "auto" verwenden';
  }
  if (input?.position && typeof input.position === 'object') {
    out.position = input.position;
  }
  if (input?.fill_height_cm != null) out.fill_height_cm = z.positive(input.fill_height_cm, null, 300);
  if (Object.keys(errors).length) throw new ValidationError('Ungültige Einlagerung', errors);
  return out;
}
