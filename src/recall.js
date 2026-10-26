// Erinnerungslogik: In einstellbarem Zeitraum werden immer wieder zufällige,
// eingelagerte Gegenstände zur Prüfung vorgeschlagen ("nutzt du das noch?").

const DAY_MS = 24 * 60 * 60 * 1000;
const JITTER_MAX_DAYS = 2.5;
const MAX_INTERVAL_DAYS = 730;

export function shuffle(array, rng = Math.random) {
  const out = array.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Mappt einen DB-Gegenstand auf die Felder, die die Erinnerungslogik erwartet.
 * Die DB speichert created_at/last_reviewed_at/next_review_at; hier bekommen
 * sie die neutralen Namen, damit die Auswahl-Logik unabhängig von der
 * Persistenz bleibt.
 */
export function toRecallItem(item) {
  if (!item) return null;
  const discarded = item.status === 'discarded';
  return {
    ...item,
    placed_at: item.placed_at ?? item.created_at ?? null,
    last_recall_at: item.last_recall_at ?? item.last_reviewed_at ?? null,
    next_recall_at: item.next_recall_at ?? item.next_review_at ?? null,
    recall_verdict: item.recall_verdict ?? (discarded ? 'discard' : null),
    removed_at: item.removed_at ?? item.discarded_at ?? null,
    review_interval_days: item.review_interval_days ?? null,
  };
}

export function effectiveIntervalDays(item, settings) {
  const own = Number(item.review_interval_days);
  if (own > 0) return own;
  const s = Number(settings?.recall_interval_days ?? settings?.intervalDays);
  return Number.isFinite(s) && s > 0 ? s : 30;
}

/**
 * Wählt zufällige Gegenstände für die nächste Prüfung.
 * - Einstellungs-Keys: recall_interval_days, recall_items_per_recall,
 *   recall_min_item_age_days, recall_max_items (0 = unbegrenzt)
 * - Jeder Gegenstand ist erst wieder fällig, wenn sein Intervall
 *   (eigenes oder globales) seit der letzten Prüfung vergangen ist.
 * - Nicht mehr vorhandene Gegenstände sind nie fällig; zuletzt verneinte
 *   werden hinten einsortiert (aber nicht ausgeschlossen).
 */
export function selectRecallItems({ items, settings = {}, now = new Date(), rng = Math.random }) {
  const nowMs = now.getTime();
  const minAgeDays = Number(settings.recall_min_item_age_days ?? 14);
  const maxItems = Number(settings.recall_max_items ?? 0);
  const count = Math.max(1, Math.min(Number(settings.recall_items_per_recall ?? 3), 20));

  const candidates = [];
  const rejected = [];
  for (const item of items ?? []) {
    if (item.removed_at) continue;
    const placedAt = Date.parse(item.placed_at ?? item.created_at ?? '');
    if (!Number.isFinite(placedAt)) continue;
    if ((nowMs - placedAt) / DAY_MS < minAgeDays) continue;
    const interval = effectiveIntervalDays(item, settings);
    // Noch nie geprüft -> das Einlagerungsdatum zählt als Startpunkt.
    const last = Date.parse(
      item.last_recall_at ?? item.last_reviewed_at ?? item.recall_checked_at ?? item.created_at ?? '',
    );
    const due = !Number.isFinite(last) || (nowMs - last) / DAY_MS >= interval;
    if (!due) continue;
    const nextAt = Date.parse(item.next_recall_at ?? item.next_review_at ?? '');
    if (Number.isFinite(nextAt) && nextAt > nowMs) continue;
    (item.recall_verdict === 'discard' ? rejected : candidates).push(item);
  }
  if (maxItems > 0) {
    // Älteste zuerst, dann zufällig – so kommt wirklich jeder irgendwann dran.
    candidates.sort((a, b) =>
      Date.parse(a.last_recall_at ?? a.last_reviewed_at ?? '0') - Date.parse(b.last_recall_at ?? b.last_reviewed_at ?? '0'));
    candidates.splice(maxItems);
  }
  const picked = [...shuffle(candidates, rng), ...shuffle(rejected, rng).slice(0, 1)].slice(0, count);
  return { items: picked, candidates: candidates.length, eligible: candidates.length + rejected.length };
}

/** Nächster Prüftermin mit etwas Zufall, damit es nicht immer punktgenau feuert. */
export function nextRecallDate(intervalDays, now = new Date(), rng = Math.random) {
  const base = Math.min(Math.max(Number(intervalDays) || 30, 1), MAX_INTERVAL_DAYS);
  const jitter = rng() * JITTER_MAX_DAYS;
  const d = new Date(now.getTime() + (base + jitter) * DAY_MS);
  // runde auf Minuten – freundlicher für die Anzeige
  d.setSeconds(0, 0);
  return d;
}

export function dueNow(batch, now = new Date()) {
  const due = Date.parse(batch?.due_at ?? '');
  return Number.isFinite(due) && due <= now.getTime();
}

export { DAY_MS };
