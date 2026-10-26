// Vorgegebene Kategorien (Mehrfachauswahl) für den Lagerkatalog.
// Bewusst breit genug für Haushalt/Werkstatt/Elektronik, aber nicht beliebig.

export const DEFAULT_TAXONOMY = [
  'Elektronik',
  'Computer & Zubehör',
  'Netzwerk',
  'USB & Kabel',
  'Smart Home',
  'Messen & Prüfen',
  'Werkzeug',
  'Haushalt',
  'Küche',
  'Bad & Pflege',
  'Büro & Papier',
  'Kleidung',
  'Reise',
  'Sport & Freizeit',
  'Garten',
  'Fahrzeug',
  'Basteln & Kleben',
  'Verpackung & Versand',
  'Spielzeug',
  'Sonstiges',
];

export const CATEGORY_TAXONOMY = DEFAULT_TAXONOMY; // Rückwärtskompatibler Alias

let currentTaxonomy = DEFAULT_TAXONOMY.slice();

/** Aktuelle (ggf. vom Nutzer bearbeitete) Kategorienliste. */
export function getTaxonomy() {
  return currentTaxonomy.slice();
}

/** Setzt die Kategorienliste (leer -> Standard). */
export function setTaxonomy(list) {
  const clean = (Array.isArray(list) ? list : [])
    .map((v) => String(v ?? '').trim())
    .filter((v) => v && v.length <= 40 && !/[|,]/.test(v));
  const unique = [...new Set(clean)];
  currentTaxonomy = unique.length ? unique : DEFAULT_TAXONOMY.slice();
  return getTaxonomy();
}

/** Kategorie-Name für Neuanlage/Umbenennung prüfen. */
export function sanitizeCategoryName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > 40 || /[|,]/.test(name)) return null;
  return name;
}

// Altbestand/freie Texte auf sinnvolle Kategorien abbilden.
const ALIASES = new Map(Object.entries({
  'elektronik': ['Elektronik'],
  'elektronikzubehör': ['Elektronik', 'USB & Kabel'],
  'elektronikzubehoer': ['Elektronik', 'USB & Kabel'],
  'elektronikbauteile': ['Elektronik'],
  'elektronikbauteil': ['Elektronik'],
  'elektronik-komponenten': ['Elektronik'],
  'elektronikkomponenten': ['Elektronik'],
  'elektronik-messgeräte': ['Elektronik', 'Messen & Prüfen'],
  'elektronik-messgeraete': ['Elektronik', 'Messen & Prüfen'],
  'elektrotechnik': ['Elektronik'],
  'computerhardware': ['Computer & Zubehör'],
  'computerzubehör': ['Computer & Zubehör'],
  'computerzubehoer': ['Computer & Zubehör'],
  'computer': ['Computer & Zubehör'],
  'netzwerktechnik': ['Netzwerk'],
  'netzwerk': ['Netzwerk'],
  'netzwerkspeicher (nas)': ['Netzwerk'],
  'nas': ['Netzwerk'],
  'kabelmanagement': ['USB & Kabel'],
  'kabel': ['USB & Kabel'],
  'usb': ['USB & Kabel', 'Elektronik'],
  'smart home': ['Smart Home', 'Elektronik'],
  'smart home zubehör': ['Smart Home', 'Elektronik'],
  'smart home zubehoer': ['Smart Home', 'Elektronik'],
  'smart home sensorik': ['Smart Home', 'Elektronik'],
  'smart home sensor': ['Smart Home', 'Elektronik'],
  'smart home / elektrotechnik': ['Smart Home', 'Elektronik'],
  'smart home / elektrik': ['Smart Home', 'Elektronik'],
  'werkzeug': ['Werkzeug'],
  'werkzeug und heimwerker': ['Werkzeug'],
  'heimwerker': ['Werkzeug'],
  'messwerkzeug': ['Werkzeug', 'Messen & Prüfen'],
  'messtechnik': ['Messen & Prüfen'],
  'messen': ['Messen & Prüfen'],
  'klebstoffe und bänder': ['Basteln & Kleben'],
  'klebstoffe und baender': ['Basteln & Kleben'],
  'basteln': ['Basteln & Kleben'],
  'haushalt & wohnen': ['Haushalt'],
  'haushalt': ['Haushalt'],
  'küche': ['Küche'],
  'kueche': ['Küche'],
  'bad': ['Bad & Pflege'],
  'büro': ['Büro & Papier'],
  'buero': ['Büro & Papier'],
  'papier': ['Büro & Papier'],
  'kleidung': ['Kleidung'],
  'reise': ['Reise'],
  'sport': ['Sport & Freizeit'],
  'freizeit': ['Sport & Freizeit'],
  'garten': ['Garten'],
  'fahrzeugzubehör': ['Fahrzeug'],
  'fahrzeugzubehoer': ['Fahrzeug'],
  'fahrzeug': ['Fahrzeug'],
  'verpackung': ['Verpackung & Versand'],
  'spielzeug': ['Spielzeug'],
  'sonstiges': ['Sonstiges'],
}));

/** Eine einzelne Kategorie auf die Taxonomie abbilden (Liste oder null). */
export function canonicalCategory(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  // Direkter Treffer in der aktuellen Liste (auch selbst angelegte Kategorien).
  const direct = currentTaxonomy.find((c) => c.toLowerCase() === lower);
  if (direct) return [direct];
  // Alt-/Alias-Texte nur abbilden, wenn das Ziel noch in der Liste ist.
  const alias = ALIASES.get(lower);
  if (alias?.length) {
    const mapped = alias
      .map((name) => currentTaxonomy.find((c) => c.toLowerCase() === name.toLowerCase()))
      .filter(Boolean);
    if (mapped.length) return [...new Set(mapped)];
  }
  return null;
}

/**
 * Bis zu fünf sinnvolle Kategorien aus beliebigen Eingaben (Array oder String).
 * Unbekannte Werte werden verworfen; leere Eingabe -> [].
 */
export function normalizeCategories(input, { max = 5 } = {}) {
  const values = Array.isArray(input) ? input : (input == null ? [] : String(input).split(','));
  const out = [];
  for (const value of values) {
    for (const canonical of (canonicalCategory(value) || [])) {
      if (!out.includes(canonical)) out.push(canonical);
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}
