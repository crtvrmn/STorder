// Ähnlichkeitssuche: "Gibt es diesen (oder einen ähnlichen) Artikel schon?"
// Rein textbasiert (Wort-Schnittmenge inkl. Komposita/Synonyme), kein LLM.

import { tokens } from './category.js';

/**
 * Ähnlichkeit zwischen Suchtext und Artikeltext (0..1).
 * 1 = alle Suchwörter kommen vor, 0 = keine Übereinstimmung.
 */
export function similarityScore(queryText, itemText) {
  const query = tokens(queryText);
  const item = tokens(itemText);
  if (!query.size || !item.size) return 0;

  let hits = 0;
  for (const word of query) {
    if (item.has(word)) { hits += 1; continue; }
    // Komposita/Teilwörter: "Staubsaugerzubehör" trifft "Staubsauger" und
    // "Zubehör". Der längere (spezifischere) Treffer zählt mehr, damit
    // "Staubsauger" vor dem allgemeinen "Zubehör" landet.
    let best = 0;
    for (const candidate of item) {
      if (word.length < 4 || candidate.length < 4) continue;
      if (!word.includes(candidate) && !candidate.includes(word)) continue;
      const overlap = Math.min(candidate.length, word.length) / Math.max(candidate.length, word.length);
      if (overlap > best) best = overlap;
    }
    hits += best;
  }
  return Math.round((hits / query.size) * 100) / 100;
}

/**
 * Findet bereits eingelagerte, ähnliche Artikel.
 * @returns {Array<{item: object, score: number}>}
 */
export function findSimilarItems(items, {
  query = '',
  category = '',
  limit = 5,
  minScore = 0.34,
  excludeId = null,
} = {}) {
  const queryText = [query, category].filter(Boolean).join(' ').trim();
  if (!queryText) return [];
  return (items ?? [])
    .filter((item) => item && item.id !== excludeId)
    .map((item) => {
      const itemText = [item.name, item.category, item.brand].filter(Boolean).join(' ');
      return { item, score: similarityScore(queryText, itemText) };
    })
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score
      || String(b.item.created_at ?? '').localeCompare(String(a.item.created_at ?? '')))
    .slice(0, limit);
}
