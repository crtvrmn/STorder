// Kategorie-Zuordnung: erkennt, ob ein Gegenstand inhaltlich zu einer Kiste
// passt (z. B. Kategorie "Küche" -> Kiste "Küche & Vorrat").
//
// Rein textbasiert und deterministisch: normalisieren, in Wörter zerlegen,
// deutsche Synonyme ergänzen, Schnittmenge bilden. Kein LLM nötig.

const STOPWORDS = new Set([
  'und', 'oder', 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer',
  'fuer', 'mit', 'von', 'vom', 'im', 'in', 'am', 'an', 'auf', 'aus', 'bei', 'zu',
  'zum', 'zur', 'sowie', 'sonstiges', 'sonstige', 'weiteres', 'anderes', 'diverses',
  'the', 'and', 'for', 'with', 'other', 'misc',
]);

// Normalisierte Wortgruppen, die inhaltlich dasselbe meinen.
// Schlüssel = normalisiertes Wort, Wert = alle Wörter der Gruppe.
const SYNONYM_GROUPS = [
  ['kueche', 'kuechen', 'vorrat', 'lebensmittel', 'haushalt', 'kochen', 'backen', 'geschirr', 'kuechengeraet', 'kuechengeraete'],
  ['werkzeug', 'technik', 'werkstatt', 'garten', 'maschine', 'maschinen', 'handwerk', 'bau', 'reparatur'],
  ['elektronik', 'elektro', 'kabel', 'computer', 'it', 'zubehoer', 'adapter', 'ladegeraet', 'technik'],
  ['basteln', 'bastel', 'kleinkram', 'diy', 'naehen', 'handarbeit', 'material', 'werkbasteln'],
  ['deko', 'dekoration', 'saison', 'saisonartikel', 'weihnachten', 'feiertag', 'feiertage', 'ostern', 'schmuck'],
  ['dokument', 'dokumente', 'papier', 'buero', 'unterlagen', 'akte', 'akten', 'schreiben', 'ordner'],
  ['sport', 'fitness', 'outdoor', 'camping', 'wandern'],
  ['kleidung', 'textil', 'textilien', 'wäsche', 'waesche', 'schuhe'],
];

const SYNONYMS = (() => {
  const map = new Map();
  for (const group of SYNONYM_GROUPS) {
    for (const word of group) {
      if (!map.has(word)) map.set(word, new Set());
      for (const other of group) map.get(word).add(other);
    }
  }
  return map;
})();

/** Kleinschreibung + Umlaute auflösen + Sonderzeichen zu Leerzeichen. */
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replaceAll('ä', 'ae')
    .replaceAll('ö', 'oe')
    .replaceAll('ü', 'ue')
    .replaceAll('ß', 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Wörter eines Textes, ohne Stoppwörter, inkl. Synonym-Erweiterung. */
export function tokens(value) {
  const words = normalizeText(value).split(' ').filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const out = new Set();
  for (const word of words) {
    out.add(word);
    for (const synonym of SYNONYMS.get(word) ?? []) out.add(synonym);
  }
  return out;
}

/**
 * Prüft, ob Gegenstand und Kiste inhaltlich zusammenpassen.
 * @returns {{match: boolean, hits: string[]}}
 */
export function categoryMatch(itemText, boxText) {
  const item = tokens(itemText);
  if (!item.size) return { match: false, hits: [] };
  const box = tokens(boxText);
  const hits = [];
  for (const word of item) {
    // Exakt, oder als Bestandteil eines Kompositums ("Weihnachtsdeko" -> "deko",
    // "Bastelmaterial" -> "bastel"). Ab 4 Zeichen, damit kurze Wörter nicht
    // zufällig in längeren Begriffen treffen.
    const hit = box.has(word) || [...box].some((b) => (
      b.length >= 4 && word.length >= 4 && (b.includes(word) || word.includes(b))
    ));
    if (hit) hits.push(word);
  }
  return { match: hits.length > 0, hits: [...new Set(hits)].slice(0, 4) };
}
