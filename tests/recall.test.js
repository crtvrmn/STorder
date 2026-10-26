// Tests für die Erinnerungs-/Prüf-Logik (src/recall.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectRecallItems,
  nextRecallDate,
  effectiveIntervalDays,
  dueNow,
  toRecallItem,
  shuffle,
  DAY_MS,
} from '../src/recall.js';

const NOW = new Date('2026-06-01T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY_MS).toISOString();
const daysAhead = (n) => new Date(NOW.getTime() + n * DAY_MS).toISOString();

const item = (over = {}) => ({
  id: over.id ?? Math.random(),
  name: `Item ${over.id ?? ''}`,
  status: 'stored',
  created_at: daysAgo(60),
  ...over,
});

test('toRecallItem mappt DB-Spalten auf die Logik-Felder', () => {
  const mapped = toRecallItem({
    id: 1,
    created_at: '2026-01-01T00:00:00Z',
    last_reviewed_at: '2026-02-01T00:00:00Z',
    next_review_at: '2026-03-01T00:00:00Z',
    status: 'stored',
  });
  assert.equal(mapped.placed_at, '2026-01-01T00:00:00Z');
  assert.equal(mapped.last_recall_at, '2026-02-01T00:00:00Z');
  assert.equal(mapped.next_recall_at, '2026-03-01T00:00:00Z');
  assert.equal(mapped.recall_verdict, null);
  assert.equal(toRecallItem({ id: 2, status: 'discarded', discarded_at: '2026-04-01T00:00:00Z' }).recall_verdict, 'discard');
});

test('shuffle verändert die Eingabe nicht', () => {
  const input = [1, 2, 3, 4, 5];
  const out = shuffle(input, () => 0.5);
  assert.deepEqual(input, [1, 2, 3, 4, 5]);
  assert.equal(out.length, 5);
  assert.deepEqual([...out].sort(), [1, 2, 3, 4, 5]);
});

test('effectiveIntervalDays: eigenes Intervall schlägt global, Default 30', () => {
  assert.equal(effectiveIntervalDays({ review_interval_days: 7 }, { recall_interval_days: 90 }), 7);
  assert.equal(effectiveIntervalDays({}, { recall_interval_days: 90 }), 90);
  assert.equal(effectiveIntervalDays({}, {}), 30);
  assert.equal(effectiveIntervalDays({}, { intervalDays: 45 }), 45);
});

test('selectRecallItems: nur Gegenstände, die alt genug und fällig sind', () => {
  const items = [
    item({ id: 1, created_at: daysAgo(60) }), // fällig
    item({ id: 2, created_at: daysAgo(2) }), // zu jung
    item({ id: 3, created_at: daysAgo(60), last_reviewed_at: daysAgo(5) }), // erst kürzlich geprüft
    item({ id: 4, created_at: daysAgo(60), last_reviewed_at: daysAgo(120) }), // wieder fällig
    item({ id: 5, created_at: daysAgo(60), removed_at: daysAgo(1) }), // entfernt
  ];
  const r = selectRecallItems({ items, settings: { recall_interval_days: 30, recall_items_per_recall: 10 }, now: NOW, rng: () => 0.5 });
  const ids = r.items.map((i) => i.id).sort();
  assert.deepEqual(ids, [1, 4]);
  assert.equal(r.eligible, 2);
});

test('selectRecallItems: respektiert next_review_at in der Zukunft', () => {
  const items = [
    item({ id: 1, created_at: daysAgo(60), next_review_at: daysAhead(10) }),
    item({ id: 2, created_at: daysAgo(60), next_review_at: daysAgo(1) }),
  ];
  const r = selectRecallItems({ items, settings: { recall_items_per_recall: 10 }, now: NOW, rng: () => 0.5 });
  assert.deepEqual(r.items.map((i) => i.id), [2]);
});

test('selectRecallItems: Anzahl wird begrenzt und ist zufällig', () => {
  const items = Array.from({ length: 20 }, (_, i) => item({ id: i + 1, created_at: daysAgo(90) }));
  const r = selectRecallItems({ items, settings: { recall_items_per_recall: 3 }, now: NOW, rng: () => 0.42 });
  assert.equal(r.items.length, 3);
  assert.equal(r.eligible, 20);
  // unterschiedliche Seeds -> unterschiedliche Auswahl (Zufall ist wirksam)
  const other = selectRecallItems({ items, settings: { recall_items_per_recall: 3 }, now: NOW, rng: () => 0.9 });
  assert.notDeepEqual(r.items.map((i) => i.id), other.items.map((i) => i.id));
});

test('selectRecallItems: max_items begrenzt den Kandidaten-Pool (älteste zuerst)', () => {
  const items = [
    item({ id: 1, created_at: daysAgo(100), last_reviewed_at: daysAgo(80) }),
    item({ id: 2, created_at: daysAgo(100), last_reviewed_at: daysAgo(40) }),
    item({ id: 3, created_at: daysAgo(100), last_reviewed_at: null }),
  ];
  const r = selectRecallItems({
    items,
    settings: { recall_items_per_recall: 5, recall_max_items: 2, recall_interval_days: 30 },
    now: NOW,
    rng: () => 0.5,
  });
  assert.equal(r.candidates, 2);
});

test('selectRecallItems: verneinte Gegenstände bleiben im Pool, aber hinten', () => {
  const items = [
    item({ id: 1, created_at: daysAgo(90) }),
    item({ id: 2, created_at: daysAgo(90), recall_verdict: 'discard' }),
  ];
  const r = selectRecallItems({ items, settings: { recall_items_per_recall: 1 }, now: NOW, rng: () => 0.5 });
  assert.equal(r.items.length, 1);
  assert.equal(r.eligible, 2);
});

test('nextRecallDate: Intervall plus etwas Zufall, auf Minuten gerundet', () => {
  const d = nextRecallDate(30, NOW, () => 0);
  assert.equal(d.getSeconds(), 0);
  assert.equal(d.getMilliseconds(), 0);
  const diffDays = (d.getTime() - NOW.getTime()) / DAY_MS;
  assert.ok(diffDays >= 30 && diffDays <= 32.5, `${diffDays}`);

  const small = nextRecallDate(-5, NOW, () => 0);
  assert.ok((small.getTime() - NOW.getTime()) / DAY_MS >= 1);
  const huge = nextRecallDate(100000, NOW, () => 0);
  assert.ok((huge.getTime() - NOW.getTime()) / DAY_MS <= 731);
});

test('dueNow prüft das Fälligkeitsdatum eines Batches', () => {
  assert.equal(dueNow({ due_at: daysAgo(1) }, NOW), true);
  assert.equal(dueNow({ due_at: daysAhead(1) }, NOW), false);
  assert.equal(dueNow({}, NOW), false);
  assert.equal(dueNow(null, NOW), false);
});
