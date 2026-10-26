// Vorgegebene Kategorien (Mehrfachauswahl) für den Lagerkatalog.
// Bewusst breit genug für Haushalt/Werkstatt/Elektronik, aber nicht beliebig.

export const CATEGORY_TAXONOMY = [
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

const BY_LOWER = new Map(CATEGORY_TAXONOMY.map((c) => [c.toLowerCase(), c]));

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
  const direct = BY_LOWER.get(lower);
  if (direct) return [direct];
  const alias = ALIASES.get(lower);
  if (alias?.length) return alias;
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
