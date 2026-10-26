// Storder – mobile Web-App (Vanilla JS, keine Build-Schritte).
//
// Ablauf Einlagern: Foto -> /api/analyze (LLM: Beschreibung, Maße, Gewicht)
// -> /api/suggest (deterministische Platzsuche) -> /api/items (speichern).

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  bins: [],
  photo: null,          // { dataUrl, path }
  analysis: null,       // Ergebnis von /api/analyze
  suggestion: null,     // Ergebnis von /api/suggest
  settings: null,
  manualBinId: null,    // vom Nutzer gewählte Kiste (überschreibt den Vorschlag)
  excludedBoxIds: [],   // als "voll"/"passt nicht" markierte Kisten
  paperless: null,      // { configured, url } – Paperless im lokalen Netz
  saving: false,        // Doppelklick-Schutz beim Einlagern
  analysisAbort: null,  // laufende Analyse abbrechen können
  skipAnalysis: false,  // "KI überspringen": nur manuelle Eingabe
  similar: [],          // ähnliche, bereits eingelagerte Artikel
  viewMode: (localStorage.getItem('storder_view') === 'grid' ? 'grid' : 'list'),
};

/* ------------------------------- Helfer --------------------------------- */

const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const num = (value) => {
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const liters = (value) => (value == null ? '–' : `${Number(value).toFixed(1)} l`);

/** Foto-URL mit Version, damit nach dem Drehen nicht das alte Bild kommt. */
const photoSrc = (path, item) => (path
  ? `${path}${path.includes('?') ? '&' : '?'}v=${encodeURIComponent(item?.updated_at ?? '')}`
  : '');

const dateStr = (iso) => {
  if (!iso) return '–';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '–' : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

let toastTimer = null;
function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3600);
}

async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* z. B. HTML */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Fehler ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ------------------------------- Ansichten ------------------------------ */

const VIEWS = ['capture', 'inbox', 'bins', 'search', 'recall'];

function showView(name, { push = true } = {}) {
  if (!VIEWS.includes(name)) name = 'capture';
  for (const view of VIEWS) {
    $(`#view-${view}`).classList.toggle('active', view === name);
  }
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name));
  if (push && location.hash !== `#${name}`) {
    // replaceState statt hash-Assignment: kein Sprung, aber Reload-fest.
    history.replaceState(null, '', `#${name}`);
  }
  if (name === 'bins') loadBins();
  if (name === 'inbox') loadInbox();
  if (name === 'recall') loadRecall();
  if (name === 'search') {
    $('#search-input').focus();
    // Ohne Suchbegriff zeigt die Liste den ganzen Katalog (neueste zuerst).
    runSearch();
  }
  window.scrollTo({ top: 0 });
}

$$('.tab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));
window.addEventListener('hashchange', () => showView(location.hash.slice(1), { push: false }));

/* ------------------------------ Einstellungen --------------------------- */

async function openSettings() {
  let data;
  try {
    data = await api('/api/settings');
  } catch (err) { toast(err.message, 'error'); return; }
  state.settings = data.effective;

  const e = data.effective;
  openDialog({
    title: 'Einstellungen',
    okText: 'Speichern',
    body: `
      <p class="muted">${esc(e.app_name)} · KI ${e.llm_configured ? 'aktiv' : 'nicht konfiguriert'}</p>
      <div class="field"><label>Modell (Vision)</label><input name="llm_vision_model" value="${esc(e.llm_vision_model)}"></div>
      <div class="field"><label>Modell (Internet-Recherche)</label><input name="llm_web_model" value="${esc(e.llm_web_model)}"></div>
      <div class="field"><label>LLM-Basis-URL</label><input name="llm_base_url" value="${esc(e.llm_base_url)}"></div>
      <div class="field"><label>Prüf-Erinnerung aktiv</label>
        <select name="recall_enabled">
          <option value="1" ${e.recall_enabled ? 'selected' : ''}>Ja</option>
          <option value="0" ${e.recall_enabled ? '' : 'selected'}>Nein</option>
        </select>
      </div>
      <div class="grid-2">
        <div class="field"><label>Intervall (Tage)</label><input name="recall_interval_days" type="number" min="1" value="${esc(e.recall_interval_days)}"></div>
        <div class="field"><label>Sachen pro Prüfung</label><input name="recall_items_per_recall" type="number" min="1" max="20" value="${esc(e.recall_items_per_recall)}"></div>
      </div>
      <div class="field"><label>Mindestalter (Tage)</label><input name="recall_min_item_age_days" type="number" min="0" value="${esc(e.recall_min_item_age_days)}"></div>
      <p class="status">Der API-Key kommt aus der Umgebung (OPENROUTER_API_KEY) und wird hier nie angezeigt.</p>`,
    onOk: async (form) => {
      const fd = new FormData(form);
      await api('/api/settings', {
        method: 'PUT',
        body: {
          llm_vision_model: fd.get('llm_vision_model'),
          llm_web_model: fd.get('llm_web_model'),
          llm_base_url: fd.get('llm_base_url'),
          recall_enabled: fd.get('recall_enabled') === '1',
          recall_interval_days: fd.get('recall_interval_days'),
          recall_items_per_recall: fd.get('recall_items_per_recall'),
          recall_min_item_age_days: fd.get('recall_min_item_age_days'),
        },
      });
      toast('Einstellungen gespeichert', 'ok');
    },
  });
}

$('#btn-settings').addEventListener('click', openSettings);

/* -------------------------------- Dialog -------------------------------- */

let dialogOkHandler = null;
let pendingBinPhoto = null; // Foto, das erst nach dem Anlegen der Kiste hochgeladen wird

function openDialog({ title, body, okText = 'Speichern', onOk }) {
  dialogOkHandler = onOk;
  $('#dialog-body').innerHTML = `<h3>${esc(title)}</h3>${body}`;
  const ok = $('#dialog-ok');
  ok.textContent = okText;
  ok.hidden = false;
  const dialog = $('#dialog');
  if (!dialog.open) dialog.showModal();
}

/**
 * Sheet mit großen Auswahl-Buttons (statt Formular). Der OK-Button entfällt,
 * "Abbrechen" schließt nur. choices: [{label, hint, kind, onSelect}]
 */
function openChoiceSheet({ title, body = '', choices, cancelLabel = 'Abbrechen' }) {
  openDialog({
    title,
    body: `${body}<div class="choice-list">${choices.map((c, i) => `
      <button type="button" class="choice ${c.kind ?? ''}" data-choice="${i}" ${c.disabled ? 'disabled' : ''}>
        <span class="choice-label">${esc(c.label)}</span>
        ${c.hint ? `<span class="choice-hint">${esc(c.hint)}</span>` : ''}
      </button>`).join('')}</div>`,
    okText: cancelLabel,
    onOk: async () => {},
  });
  $('#dialog-ok').hidden = true;
  $$('#dialog-body [data-choice]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const choice = choices[Number(btn.dataset.choice)];
      closeDialog();
      await choice?.onSelect?.();
    });
  });
}

function closeDialog() {
  const dialog = $('#dialog');
  dialogOkHandler = null;
  if (dialog.open) dialog.close();
}

$('#dialog-form').addEventListener('submit', async (event) => {
  const submitter = event.submitter;
  if (submitter?.value === 'cancel' || !dialogOkHandler) {
    event.preventDefault();
    closeDialog();
    return;
  }
  event.preventDefault();
  const handler = dialogOkHandler;
  const form = $('#dialog-form');
  $('#dialog-ok').disabled = true;
  try {
    await handler(form);
    closeDialog();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    $('#dialog-ok').disabled = false;
  }
});

/* ------------------------------ Foto + Analyse -------------------------- */

/** Lädt ein Bild in ein Image-Element (Fallback für ältere Browser). */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild nicht lesbar')); };
    img.src = url;
  });
}

/** Verkleinert das Foto im Browser, bevor es hochgeladen wird. */
async function fileToDataUrl(file, maxSide = 1000) {
  let source;
  let width;
  let height;
  if (typeof createImageBitmap === 'function') {
    // Große Dateien (typisch für 48/50-MP-Handykameras) direkt kleiner dekodieren:
    // sonst muss der Browser das volle Bild in den Speicher laden, bevor es
    // verkleinert wird – auf dem Handy langsam und speicherhungrig.
    const options = { imageOrientation: 'from-image' };
    if (file.size > 2.5 * 1024 * 1024) {
      options.resizeWidth = maxSide;
      options.resizeQuality = 'high';
    }
    const bitmap = await createImageBitmap(file, options).catch(() => null);
    if (bitmap) {
      source = bitmap;
      width = bitmap.width;
      height = bitmap.height;
    }
  }
  if (!source) {
    const img = await loadImage(file);
    source = img;
    width = img.naturalWidth;
    height = img.naturalHeight;
  }
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  // WebP, wenn der Browser es kann (kleiner bei gleicher Qualität), sonst JPEG.
  const webp = canvas.toDataURL('image/webp', 0.8);
  if (webp.startsWith('data:image/webp')) return webp;
  return canvas.toDataURL('image/jpeg', 0.82);
}

$('#photo-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const status = $('#analyze-status');
  status.hidden = false;
  status.className = 'status';
  status.textContent = 'Foto wird verkleinert…';
  try {
    const dataUrl = await fileToDataUrl(file);
    const kb = Math.round((dataUrl.length * 0.75) / 1024);
    state.photo = { dataUrl, path: null };
    state.analysis = emptyAnalysis();
    const preview = $('#photo-preview');
    preview.src = dataUrl;
    preview.hidden = false;
    $('#photo-placeholder').hidden = true;
    state.skipAnalysis = false;
    $('#btn-inbox').disabled = false;
    // Formular sofort anzeigen: Die Analyse läuft danach im Hintergrund weiter,
    // sodass man schon Name, Maße etc. eintragen kann.
    renderResult();
    const autoAnalyze = $('#auto-analyze')?.checked ?? true;
    if (autoAnalyze) {
      status.textContent = `Foto verkleinert (${kb} KB). Analyse läuft – du kannst schon Angaben machen…`;
      startAnalysis();
    } else {
      status.textContent = `Foto verkleinert (${kb} KB). Automatische Analyse ist aus – bitte selbst eintragen.`;
    }
  } catch {
    status.hidden = true;
    toast('Bild konnte nicht gelesen werden.', 'error');
  }
});

// Häkchen "Automatisch analysieren": bei bereits gewähltem Foto Analyse starten
$('#auto-analyze').addEventListener('change', () => {
  if ($('#auto-analyze').checked && state.photo?.dataUrl && !state.analysis?.title && !state.skipAnalysis) {
    startAnalysis();
  }
});

/** Startet die LLM-Analyse im Hintergrund und füllt nur leere Felder. */
async function startAnalysis() {
  if (state.skipAnalysis) return;
  if (!state.photo?.dataUrl) {
    toast('Bitte zuerst ein Foto machen.', 'error');
    return;
  }
  const status = $('#analyze-status');
  state.analysisAbort?.abort();
  state.analysisAbort = new AbortController();
  const controller = state.analysisAbort;
  if (status) {
    status.hidden = false;
    status.className = 'status';
    status.textContent = 'Bild wird analysiert – du kannst schon Angaben machen…';
  }
  try {
    const data = await api('/api/analyze', {
      method: 'POST',
      body: { image: state.photo.dataUrl, hint: $('#hint')?.value.trim() || undefined },
      signal: controller.signal,
    });
    // Wurde in der Zwischenzeit übersprungen/neu gestartet? Ergebnis verwerfen.
    if (controller.signal.aborted || state.skipAnalysis) return;
    state.photo.path = data.photo.path;
    state.analysis = data.analysis;
    if (status) status.hidden = true;
    // Wurde in der Zwischenzeit schon eingelagert? Dann nichts mehr ändern.
    if ($('#f-name')) {
      applyAnalysisToForm(data.analysis);
      toast('Analyse fertig – Vorschläge übernommen', 'ok');
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // "KI überspringen" oder neue Analyse
    if (status) {
      status.className = 'status error';
      status.textContent = `${err.message} – du kannst die Angaben trotzdem manuell machen.`;
    }
  } finally {
    state.analysisAbort = null;
  }
}

$('#btn-manual').addEventListener('click', () => {
  state.skipAnalysis = true;
  state.analysisAbort?.abort();
  const status = $('#analyze-status');
  if (status) {
    status.hidden = false;
    status.className = 'status';
    status.textContent = 'KI übersprungen – bitte alle Angaben selbst eintragen.';
  }
  // Formular öffnen, falls noch keins da ist (auch ohne Foto möglich).
  if (!$('#f-name')) {
    state.analysis = emptyAnalysis();
    if (!state.photo) state.photo = { dataUrl: null, path: null };
    renderResult();
  }
  toast('KI übersprungen – selbst eingeben', 'ok');
});

/** Leeres Analyse-Objekt – Basis für manuelle Eingabe und den Analyse-Entwurf. */
function emptyAnalysis(over = {}) {
  return {
    title: '',
    title_source: 'manual',
    description: '',
    brand: '',
    category: '',
    shape: 'cuboid',
    dims_cm: null,
    weight_g: null,
    volume_liters: null,
    volume_confidence: 'low',
    volume_method: 'manual',
    ai_analysis: { warnings: [], sources: [] },
    source_urls: [],
    ...over,
  };
}



/* ---------------------------- Ergebnis-Formular ------------------------- */

const SHAPES = [
  ['cuboid', 'Quader / Karton'],
  ['box', 'Kiste'],
  ['cylinder', 'Zylinder / Dose'],
  ['bottle', 'Flasche'],
  ['sphere', 'Kugel / rund'],
  ['bag', 'Beutel / weich'],
  ['irregular', 'Unregelmäßig'],
  ['other', 'Sonstiges'],
];

function badgeHtml(a) {
  return a.title_source === 'web'
    ? '<span class="badge web">Internet</span>'
    : a.title_source === 'ai' || a.title_source === 'vision'
      ? '<span class="badge ai">KI</span>'
      : a.title_source === 'hint' ? '<span class="badge">Hinweis</span>' : '<span class="badge">Manuell</span>';
}

function warningsHtml(a) {
  return (a.ai_analysis?.warnings ?? []).map((w) => `<p class="status error">${esc(w)}</p>`).join('');
}

function sourcesText(a) {
  return JSON.stringify({
    quellen: a.ai_analysis?.sources ?? [],
    warnungen: a.ai_analysis?.warnings ?? [],
    volumen: { liter: a.volume_liters, methode: a.volume_method, sicherheit: a.volume_confidence },
    links: a.source_urls ?? [],
  }, null, 2);
}

function renderResult() {
  const a = state.analysis ?? emptyAnalysis();
  const card = $('#result');
  const d = a.dims_cm ?? {};
  const thumb = state.photo?.dataUrl
    ? `<img src="${state.photo.dataUrl}" alt="">`
    : '<div class="item-thumb"></div>';

  card.hidden = false;
  card.innerHTML = `
    <div class="analysis-head">
      ${thumb}
      <div class="titles">
        <div id="analysis-badge">${badgeHtml(a)}</div>
        <input id="f-name" type="text" value="${esc(a.title)}" placeholder="Name des Gegenstands">
        <small class="muted">Beschreibung und Maße sind Vorschläge – bitte kurz prüfen.</small>
      </div>
    </div>

    <div class="field" style="margin-top:12px">
      <label>Beschreibung</label>
      <textarea id="f-description" placeholder="Was ist das?">${esc(a.description ?? '')}</textarea>
    </div>

    <div class="grid-2" style="margin-top:10px">
      <div class="field"><label>Marke</label><input id="f-brand" value="${esc(a.brand ?? '')}"></div>
      <div class="field"><label>Kategorie</label><input id="f-category" value="${esc(a.category ?? '')}" placeholder="z. B. Küche"></div>
    </div>

    <div class="field" style="margin-top:10px">
      <label>Maße in cm (L × B × H)</label>
      <div class="grid-3">
        <input id="f-length" type="number" step="0.1" min="0.2" max="300" placeholder="L" value="${esc(d.length_cm ?? '')}">
        <input id="f-width" type="number" step="0.1" min="0.2" max="300" placeholder="B" value="${esc(d.width_cm ?? '')}">
        <input id="f-height" type="number" step="0.1" min="0.2" max="300" placeholder="H" value="${esc(d.height_cm ?? '')}">
      </div>
    </div>

    <div class="grid-3" style="margin-top:10px">
      <div class="field"><label>Gewicht g</label><input id="f-weight" type="number" step="1" min="0" inputmode="decimal" value="${esc(a.weight_g ?? '')}"></div>
      <div class="field"><label>Volumen l</label><input id="f-volume" type="number" step="0.1" min="0" inputmode="decimal" value="${esc(a.volume_liters ?? '')}" placeholder="aus Maßen"></div>
      <div class="field"><label>Stückzahl</label><input id="f-quantity" type="number" step="1" min="1" max="9999" inputmode="numeric" value="1"></div>
    </div>
    <div class="field" style="margin-top:10px"><label>Form</label>
      <select id="f-shape">
        ${SHAPES.map(([v, label]) => `<option value="${v}" ${a.shape === v ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </div>

    <p class="muted" style="margin-top:10px" id="volume-line"></p>
    <div id="similar-box" style="margin-top:10px"></div>
    <div id="suggestion-box" style="margin-top:10px"></div>
    <div id="analysis-warnings">${warningsHtml(a)}</div>

    <div class="row" style="margin-top:14px">
      <button class="primary" id="btn-save">Einlagern</button>
      <button class="danger icon-x shrink" id="btn-reject" aria-label="Nicht einlagern" title="Nicht einlagern">✕</button>
    </div>
    <details style="margin-top:10px">
      <summary>Woher kommen die Daten?</summary>
      <pre id="analysis-sources" style="white-space:pre-wrap;font-size:0.75rem;color:var(--muted)">${esc(sourcesText(a))}</pre>
    </details>`;

  for (const id of ['f-length', 'f-width', 'f-height', 'f-weight', 'f-volume', 'f-quantity']) {
    $(`#${id}`).addEventListener('input', () => {
      // Vom Vorschlag automatisch gesetztes Volumen verwerfen, sobald der
      // Nutzer die Maße ändert – sonst wäre es veraltet.
      if (id !== 'f-volume') {
        const volumeField = $('#f-volume');
        if (volumeField?.dataset.auto === '1') {
          volumeField.value = '';
          delete volumeField.dataset.auto;
        }
      } else {
        delete $('#f-volume').dataset.auto;
      }
      scheduleSuggest();
    });
  }
  $('#f-shape').addEventListener('change', () => {
    $('#f-shape').dataset.touched = '1';
    scheduleSuggest();
  });
  for (const id of ['f-name', 'f-category']) {
    $(`#${id}`).addEventListener('input', scheduleSimilar);
  }
  scheduleSimilar();

  updateVolumeLine();
  scheduleSuggest();
  $('#btn-save').addEventListener('click', saveItem);
  $('#btn-reject').addEventListener('click', openRejectSheet);
}

/** Übernimmt Analyse-Ergebnisse nur in Felder, die noch leer sind. */
function applyAnalysisToForm(a) {
  const setIfEmpty = (sel, value) => {
    const el = $(sel);
    if (!el) return;
    if (String(el.value ?? '').trim() !== '') return;
    if (value == null || value === '') return;
    el.value = value;
  };
  // Wichtig: Hat die Nutzerin die Maße schon selbst eingetragen, darf das von
  // der Analyse berechnete Volumen nicht darübergebügelt werden (wäre veraltet).
  const dimsWereEmpty = ['#f-length', '#f-width', '#f-height']
    .every((sel) => !String($(sel)?.value ?? '').trim());

  setIfEmpty('#f-name', a.title);
  setIfEmpty('#f-description', a.description);
  setIfEmpty('#f-brand', a.brand);
  setIfEmpty('#f-category', a.category);
  const d = a.dims_cm ?? {};
  setIfEmpty('#f-length', d.length_cm);
  setIfEmpty('#f-width', d.width_cm);
  setIfEmpty('#f-height', d.height_cm);
  setIfEmpty('#f-weight', a.weight_g);
  const volumeField = $('#f-volume');
  if (volumeField && dimsWereEmpty && !String(volumeField.value).trim() && a.volume_liters) {
    volumeField.value = a.volume_liters;
    volumeField.dataset.auto = '1';
  }
  const shape = $('#f-shape');
  if (shape && !shape.dataset.touched && a.shape) shape.value = a.shape;

  const badge = $('#analysis-badge');
  if (badge) badge.innerHTML = badgeHtml(a);
  const warnings = $('#analysis-warnings');
  if (warnings) warnings.innerHTML = warningsHtml(a);
  const sources = $('#analysis-sources');
  if (sources) sources.textContent = sourcesText(a);
  updateVolumeLine();
  scheduleSuggest();
}

function currentDims() {
  const length_cm = num($('#f-length')?.value);
  const width_cm = num($('#f-width')?.value);
  const height_cm = num($('#f-height')?.value);
  if (!length_cm || !width_cm || !height_cm) return null;
  return { length_cm, width_cm, height_cm };
}

function currentForm() {
  return {
    name: $('#f-name')?.value.trim() ?? '',
    description: $('#f-description')?.value.trim() ?? '',
    brand: $('#f-brand')?.value.trim() ?? '',
    category: $('#f-category')?.value.trim() ?? '',
    shape: $('#f-shape')?.value ?? 'irregular',
    dims_cm: currentDims(),
    weight_g: num($('#f-weight')?.value),
    volume_liters: num($('#f-volume')?.value),
    quantity: Math.max(1, Math.round(num($('#f-quantity')?.value) ?? 1)),
    photo_path: state.photo?.path ?? '',
    photos: state.photo?.path ? [state.photo.path] : [],
    source_url: state.analysis?.source_urls?.[0] ?? '',
    ai_raw: state.analysis ?? null,
  };
}

function updateVolumeLine(computed) {
  const el = $('#volume-line');
  if (!el) return;
  const dims = currentDims();
  const weight = num($('#f-weight')?.value);
  const volume = num($('#f-volume')?.value);
  if (!dims && !weight && !volume) {
    el.textContent = 'Bitte Maße (L × B × H) angeben – daraus wird das benötigte Volumen und der Platz berechnet.';
    return;
  }
  const parts = [];
  if (volume) parts.push(`Volumen: ${liters(volume)}`);
  if (dims) parts.push(`Maße: ${dims.length_cm} × ${dims.width_cm} × ${dims.height_cm} cm`);
  if (weight) parts.push(`Gewicht: ${weight} g`);
  if (computed?.liters) parts.push(`benötigt ca. ${liters(computed.liters)}`);
  else parts.push('Volumen wird aus den Maßen berechnet');
  el.textContent = parts.join(' · ');
}

/* --------------------------- Platzierungsvorschlag ---------------------- */

let suggestTimer = null;
function scheduleSuggest() {
  updateVolumeLine();
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(loadSuggestion, 320);
}

async function loadSuggestion() {
  const box = $('#suggestion-box');
  if (!box) return;
  const dims = currentDims();
  const weight = num($('#f-weight')?.value);
  const volume = num($('#f-volume')?.value);
  const quantity = Math.max(1, Math.round(num($('#f-quantity')?.value) ?? 1));
  if (!dims && !weight && !volume) {
    box.innerHTML = '<p class="status">Für den Ablageort werden Maße benötigt – bitte L × B × H eintragen.</p>';
    state.suggestion = null;
    return;
  }
  box.innerHTML = '<p class="status">Suche freien Platz…</p>';
  try {
    const data = await api('/api/suggest', {
      method: 'POST',
      body: {
        dims_cm: dims,
        weight_g: weight,
        shape: $('#f-shape')?.value,
        volume_liters: volume,
        // Kategorie/Name steuern, welche Kiste inhaltlich passt (z. B. Küche -> B1).
        category: $('#f-category')?.value.trim() || undefined,
        name: $('#f-name')?.value.trim() || undefined,
        quantity,
        // Ähnlicher Artikel schon eingelagert? Dessen Kiste bevorzugen.
        prefer_box_id: state.manualBinId ?? state.similar?.[0]?.bin_id ?? undefined,
        exclude_box_ids: state.excludedBoxIds,
      },
    });
    state.suggestion = data.suggestion;
    updateVolumeLine(data.suggestion.volume);
    renderSuggestion(data.suggestion);
  } catch (err) {
    box.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
    state.suggestion = null;
  }
}

/* ------------------------ "Kennst du das schon?" ------------------------ */

let similarTimer = null;
function scheduleSimilar() {
  clearTimeout(similarTimer);
  similarTimer = setTimeout(loadSimilar, 420);
}

async function loadSimilar() {
  const box = $('#similar-box');
  if (!box) return;
  const name = $('#f-name')?.value.trim() || '';
  const category = $('#f-category')?.value.trim() || '';
  if (!name && !category) {
    state.similar = [];
    box.innerHTML = '';
    return;
  }
  try {
    const data = await api(`/api/items/similar?q=${encodeURIComponent(name)}&category=${encodeURIComponent(category)}`);
    state.similar = data.items ?? [];
    renderSimilar();
    scheduleSuggest(); // bevorzugte Kiste ggf. neu bewerten
  } catch {
    state.similar = [];
    box.innerHTML = '';
  }
}

function renderSimilar() {
  const box = $('#similar-box');
  if (!box) return;
  if (!state.similar.length) { box.innerHTML = ''; return; }
  const top = state.similar[0];
  box.innerHTML = `
    <div class="similar">
      <strong>Kennst du schon?</strong>
      ${state.similar.slice(0, 3).map((it) => `
        <button type="button" class="similar-row" data-similar="${it.id}">
          <span>${esc(it.name)}${it.quantity > 1 ? ` · ${it.quantity}×` : ''}</span>
          <span class="similar-bin">${it.bin ? `Kiste ${esc(it.bin.code)}` : 'ohne Kiste'}</span>
        </button>`).join('')}
      ${top.bin ? `<small class="muted">Diese Kiste wird vorgeschlagen: ${esc(top.bin.code)}</small>` : ''}
    </div>`;
  $$('#similar-box [data-similar]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const match = state.similar.find((m) => m.id === Number(btn.dataset.similar));
      if (!match?.bin_id) {
        toast('Dieser Artikel hat keine Kiste.', 'error');
        return;
      }
      state.manualBinId = match.bin_id;
      scheduleSuggest();
      toast(`Kiste ${match.bin.code} übernommen`, 'ok');
    });
  });
}

function renderSuggestion(s) {
  const box = $('#suggestion-box');
  if (!box) return;
  // Manuelle Auswahl verwerfen, wenn sie nicht mehr existiert oder nicht passt.
  if (state.manualBinId) {
    const picked = s.considered.find((c) => c.box_id === state.manualBinId);
    if (!picked || !picked.fits) state.manualBinId = null;
  }
  const manual = state.manualBinId
    ? s.considered.find((c) => c.box_id === state.manualBinId)
    : null;
  if (s.best || manual) {
    const chosen = manual ?? {
      box_id: s.best.box.id,
      code: s.best.box.code,
      name: s.best.box.name,
      location: s.best.box.location,
      free_liters: s.best.box.free_liters,
      fill_percent: s.best.box.fill_percent,
      fill_after_percent: s.best.box.fill_after_percent,
      category_match: s.best.box.category_match,
      marked_full: Boolean(s.best.box.marked_full),
    };
    box.innerHTML = `
      <button type="button" class="suggestion pickable" id="btn-pick-box">
        <span class="suggestion-head">
          <strong>Ablageort: ${esc(chosen.code)}${chosen.name ? ` · ${esc(chosen.name)}` : ''}</strong>
          ${chosen.category_match ? '<span class="badge cat">Kategorie passt</span>' : ''}
          ${manual ? '<span class="badge">manuell gewählt</span>' : ''}
          ${chosen.marked_full ? '<span class="badge full-mark">voll – nur Kleinteile</span>' : ''}
        </span>
        <small class="muted">${esc(chosen.location || 'ohne Ort')} · ${chosen.marked_full ? 'als voll markiert' : `${liters(chosen.free_liters)} frei · aktuell ${Math.round(chosen.fill_percent ?? 0)} % belegt`}</small>
        ${chosen.marked_full ? fillMeter(100, { forcedFull: true, label: 'voll' }) : fillMeter(chosen.fill_after_percent ?? 0, { label: 'nachher ' })}
        <small class="muted pick-hint">Tippen, um den Ablageort manuell zu wählen${manual ? ' oder zurückzusetzen' : ''}</small>
      </button>
      ${!manual && s.alternatives.length ? `<small class="muted" style="display:block;margin-top:8px">Alternativen: ${s.alternatives.map((alt) => `${esc(alt.box.code)} (${liters(alt.box.free_liters)} frei, nachher ${Math.round(alt.box.fill_after_percent ?? 0)} %)`).join(', ')}</small>` : ''}`;
    $('#btn-pick-box').addEventListener('click', openBoxPicker);
  } else if (s.needs_bigger_box) {
    box.innerHTML = `
      <div class="suggestion warn">
        <strong>Keine Kiste hat genug Platz</strong>
        <small class="muted">${esc(s.reason_text)} Benötigt ca. ${liters(s.volume?.liters)}; empfohlen: eine Kiste mit mindestens ${liters(s.recommended_min_liters)}.</small>
        <button class="small primary" id="btn-create-big-bin" style="margin-top:8px">Größere Kiste anlegen</button>
      </div>`;
    $('#btn-create-big-bin').addEventListener('click', () => {
      openBinDialog(null, Math.ceil(s.recommended_min_liters ?? s.volume?.liters ?? 50));
    });
  } else {
    box.innerHTML = `<p class="status">${esc(s.reason_text ?? 'Kein Vorschlag.')}</p>`;
  }
}

/* ------------------------- Manuelle Kistenauswahl ----------------------- */

/** Liste aller Kisten mit Passung – nur ausreichend große sind wählbar. */
function openBoxPicker() {
  const s = state.suggestion;
  if (!s) {
    toast('Bitte zuerst Maße angeben, dann kann ich Kisten vorschlagen.', 'error');
    $('#f-length')?.focus();
    return;
  }
  const fittingBoxes = (s.considered ?? []).filter((c) => c.fits);
  if (!fittingBoxes.length) {
    const hasDims = Boolean(currentDims());
    openChoiceSheet({
      title: 'Kein Platz in den Kisten',
      body: `<p class="muted">${esc(hasDims
        ? (s.reason_text || 'Keine Kiste hat aktuell genug Platz für diesen Gegenstand.')
        : 'Ohne Maße lässt sich kein Platz berechnen – bitte L × B × H eintragen.')}</p>`,
      choices: [
        hasDims
          ? {
            label: 'Größere Kiste anlegen',
            hint: `empfohlen: mindestens ${liters(s.recommended_min_liters ?? s.volume?.liters)}`,
            kind: 'big',
            onSelect: () => openBinDialog(null, Math.ceil(s.recommended_min_liters ?? s.volume?.liters ?? 50)),
          }
          : {
            label: 'Maße eingeben',
            hint: 'Länge, Breite, Höhe in cm',
            kind: 'big',
            onSelect: () => $('#f-length')?.focus(),
          },
      ],
    });
    return;
  }
  const autoId = s.best?.box?.id ?? null;
  const choices = (s.considered ?? []).map((c) => {
    const isAuto = autoId === c.box_id && !state.manualBinId;
    const isManual = state.manualBinId === c.box_id;
    return {
      label: `${c.code}${c.name ? ` · ${c.name}` : ''}${c.category_match ? '  ★' : ''}`,
      hint: c.fits
        ? `${c.location || 'ohne Ort'} · ${c.marked_full ? 'als voll markiert (nur Kleinteile)' : `${liters(c.free_liters)} frei · ${Math.round(c.fill_percent ?? 0)} % → ${Math.round(c.fill_after_percent ?? 0)} % voll`}`
        : `${c.location || 'ohne Ort'} · ${c.reason_text ?? 'passt nicht'}`,
      kind: isManual || isAuto ? 'active' : '',
      disabled: !c.fits,
      onSelect: c.fits
        ? () => {
          state.manualBinId = c.box_id === autoId ? null : c.box_id;
          renderSuggestion(state.suggestion);
          toast(c.box_id === autoId ? 'Automatischer Vorschlag' : `Kiste ${c.code} gewählt`, 'ok');
        }
        : null,
    };
  });
  choices.push({
    label: 'Automatisch wählen',
    hint: 'Vorschlag der App übernehmen',
    onSelect: () => {
      state.manualBinId = null;
      renderSuggestion(state.suggestion);
    },
  });
  openChoiceSheet({
    title: 'Ablageort wählen',
    body: '<p class="muted">★ = passt laut Kategorie. Kisten ohne genug Platz sind ausgegraut.</p>',
    choices,
  });
}

/* --------------------------- "Nicht einlagern" -------------------------- */

function openRejectSheet() {
  const currentId = state.manualBinId ?? state.suggestion?.best?.box?.id ?? null;
  const current = currentId
    ? state.suggestion?.considered?.find((c) => c.box_id === currentId)
    : null;
  const currentLabel = current ? `${current.code} ausschließen` : 'Keine Kiste vorgeschlagen';

  openChoiceSheet({
    title: 'Was stimmt nicht?',
    body: '<p class="muted">Der Gegenstand wird nicht eingelagert.</p>',
    choices: [
      {
        label: 'Passt nicht',
        hint: 'Der Gegenstand passt nicht in diese Kiste – Maße prüfen und anderen Platz suchen',
        kind: 'big',
        onSelect: () => rejectAndResuggest(currentId, 'passt nicht'),
      },
      {
        label: 'Kiste voll',
        hint: currentLabel,
        kind: 'big',
        onSelect: async () => {
          // Dauerhaft markieren: Die Kiste wird künftig nur noch für Kleinteile vorgeschlagen.
          if (currentId) {
            try {
              await api(`/api/bins/${currentId}/full`, { method: 'POST' });
            } catch (err) {
              toast(err.message, 'error');
            }
          }
          rejectAndResuggest(currentId, 'voll');
          loadBins();
        },
      },
      {
        label: 'Verwerfen',
        hint: 'Eingabe komplett verwerfen',
        kind: 'big danger',
        onSelect: () => {
          resetCapture();
          toast('Verworfen');
        },
      },
    ],
  });
}

/** Schließt die aktuelle Kiste aus und sucht sofort einen neuen Platz. */
function rejectAndResuggest(boxId, reason) {
  if (boxId && !state.excludedBoxIds.includes(boxId)) state.excludedBoxIds.push(boxId);
  state.manualBinId = null;
  if (boxId) {
    toast(reason === 'voll'
      ? 'Kiste als voll markiert – nur noch für Kleinteile, neuer Vorschlag folgt'
      : 'Kiste ausgeschlossen – bitte Maße prüfen', 'ok');
  }
  const lengthField = $('#f-length');
  if (reason !== 'voll' && lengthField) lengthField.focus();
  loadSuggestion();
}

/* ------------------------------- Speichern ------------------------------ */

async function saveItem() {
  if (state.saving) return; // schnelle Doppel-Tipps ignorieren
  const form = currentForm();
  if (!form.name) { toast('Bitte einen Namen angeben.', 'error'); return; }
  if (!form.dims_cm && !form.volume_liters) {
    toast('Bitte Maße (L × B × H) oder ein Volumen angeben.', 'error');
    $('#f-length')?.focus();
    return;
  }
  const binId = state.manualBinId ?? state.suggestion?.best?.box?.id;
  if (!binId) {
    toast(state.suggestion?.reason_text || 'Kein Ablageort gefunden – bitte Maße prüfen.', 'error');
    return;
  }
  const btn = $('#btn-save');
  const pendingPhoto = state.photo?.dataUrl && !state.photo?.path ? state.photo.dataUrl : null;
  state.saving = true;
  if (btn) btn.disabled = true;
  try {
    const { item } = await api('/api/items', {
      method: 'POST',
      body: {
        ...form,
        bin_id: binId,
        // Position bewusst nicht mitschicken: der Server platziert deterministisch
        // mit den aktuell gespeicherten Gegenständen (keine veraltete Koordinate).
      },
    });
    // Falls die Analyse noch lief, das Foto jetzt nachreichen.
    if (pendingPhoto && item?.id) {
      try {
        await api(`/api/items/${item.id}/photos`, { method: 'POST', body: { images: [pendingPhoto] } });
      } catch {
        toast('Eingelagert, aber das Foto konnte nicht gespeichert werden.', 'error');
      }
    }
    toast('Eingelagert ✓', 'ok');
    resetCapture();
    loadBins();
  } catch (err) {
    if (err.data?.code === 'DUPLICATE_ITEM') {
      toast('Wurde gerade eben schon eingelagert – bitte im Kisteninhalt prüfen.', 'error');
    } else {
      toast(err.message, 'error');
    }
  } finally {
    state.saving = false;
    if (btn && document.body.contains(btn)) btn.disabled = false;
  }
}

function resetCapture() {
  state.photo = null;
  state.analysis = null;
  state.suggestion = null;
  state.manualBinId = null;
  state.excludedBoxIds = [];
  state.saving = false;
  $('#photo-preview').hidden = true;
  $('#photo-preview').src = '';
  $('#photo-placeholder').hidden = false;
  $('#photo-input').value = '';
  $('#hint').value = '';
  const auto = $('#auto-analyze');
  if (auto) auto.checked = true;
  $('#btn-inbox').disabled = true;
  $('#analyze-status').hidden = true;
  $('#result').hidden = true;
  $('#result').innerHTML = '';
  window.scrollTo({ top: 0 });
}

/* --------------------------------- Kisten ------------------------------- */

async function loadBins() {
  const list = $('#bins-list');
  try {
    const [{ bins }, { stats }] = await Promise.all([api('/api/bins'), api('/api/stats')]);
    state.bins = bins;
    $('#bins-summary').textContent =
      `${bins.length} Kisten · ${Math.round(stats.fill_percent)} % belegt · ${liters(stats.free_liters)} frei von ${liters(stats.capacity_liters)} · ${stats.items_stored} Gegenstände`
      + (bins.filter((b) => b.marked_full).length
        ? ` · ${bins.filter((b) => b.marked_full).length} Kiste(n) voll`
        : '')
      + (stats.purchase_value_eur > 0
        ? ` · Warenwert ${stats.purchase_value_eur.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}`
        : '');
    if (!bins.length) {
      list.innerHTML = '<p class="muted">Noch keine Kiste angelegt.</p>';
      return;
    }
    list.innerHTML = bins.map(binCard).join('');
    $$('#bins-list [data-bin-items]').forEach((btn) => {
      btn.addEventListener('click', () => toggleBinItems(Number(btn.dataset.binItems)));
    });
    $$('#bins-list [data-edit-bin]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const bin = state.bins.find((b) => b.id === Number(btn.dataset.editBin));
        openBinDialog(bin);
      });
    });
    $$('#bins-list [data-mark-bin]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/bins/${btn.dataset.markBin}/full`, { method: 'POST' });
          toast('Kiste als voll markiert – nur noch für Kleinteile', 'ok');
          loadBins();
        } catch (err) { toast(err.message, 'error'); }
      });
    });
    $$('#bins-list [data-unmark-bin]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/bins/${btn.dataset.unmarkBin}/full`, { method: 'DELETE' });
          toast('Kiste wieder freigegeben', 'ok');
          loadBins();
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  } catch (err) {
    list.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
}

function fillClass(percent) {
  if (percent >= 95) return 'full';
  if (percent >= 75) return 'warn';
  return '';
}

/**
 * Füllstands-Balkendiagramm mit Prozentwert.
 * after = optional "nach dem Einlagern"-Prozent (dann wird dieser Wert gezeigt).
 */
function fillMeter(percent, { label = '', forcedFull = false } = {}) {
  if (forcedFull) {
    // Als voll markiert: Balken voll, Text "voll" (der rechnerische Füllstand
    // steht als Zusatzinfo daneben).
    return `<span class="fillmeter">
      <span class="fillbar full"><i style="width:100%"></i></span>
      <span class="fillpct full">${label || 'voll'}</span>
    </span>`;
  }
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const cls = fillClass(value);
  const shown = Math.round(value);
  return `<span class="fillmeter">
    <span class="fillbar ${cls}"><i style="width:${Math.max(value, 2)}%"></i></span>
    <span class="fillpct ${cls}">${label}${shown} %</span>
  </span>`;
}

function binCard(bin) {
  const fill = Math.max(0, Math.min(100, bin.fill_percent ?? 0));
  const markedFull = Boolean(bin.marked_full);
  return `
    <div class="item-card">
      <div class="title-row">
        <div class="bin-head">
          ${bin.photo_url ? `<img class="bin-thumb" src="${esc(bin.photo_url)}?v=${encodeURIComponent(bin.updated_at ?? '')}" alt="Foto der Kiste" loading="lazy">` : ''}
          <div>
            <div class="name">${esc(bin.code)}${bin.name ? ` · ${esc(bin.name)}` : ''}</div>
            <div class="meta">${esc(bin.location || 'ohne Ort')}${bin.shelf ? ` · ${esc(bin.shelf)}` : ''}${bin.active ? '' : ' · inaktiv'}</div>
          </div>
        </div>
        <span class="bin-chip ${markedFull ? 'full' : ''}">${markedFull ? 'voll' : `${liters(bin.free_liters)} frei`}</span>
      </div>
      ${markedFull ? '<span class="badge full-mark">voll – nur noch Kleinteile</span>' : ''}
      <div class="meta">
        ${markedFull ? 'als voll markiert · rechnerisch ' : ''}${liters(bin.used_liters)} von ${liters(bin.capacity_liters)} belegt · ${bin.item_count} Gegenstände${bin.weight_g ? ` · ${(bin.weight_g / 1000).toFixed(1)} kg` : ''}
      </div>
      ${fillMeter(fill, { forcedFull: markedFull })}
      <div class="actions">
        <button class="small ghost" data-bin-items="${bin.id}">Inhalt</button>
        <button class="small ghost" data-edit-bin="${bin.id}">Bearbeiten</button>
        ${markedFull
          ? `<button class="small ghost" data-unmark-bin="${bin.id}">Wieder freigeben</button>`
          : `<button class="small ghost" data-mark-bin="${bin.id}">Kiste voll</button>`}
      </div>
      <div data-items-for="${bin.id}"></div>
    </div>`;
}

async function toggleBinItems(binId) {
  const host = $(`[data-items-for="${binId}"]`);
  if (!host) return;
  if (host.dataset.open === '1') {
    host.innerHTML = '';
    host.dataset.open = '0';
    return;
  }
  host.dataset.open = '1';
  host.innerHTML = '<p class="status">Lädt…</p>';
  try {
    const { items } = await api(`/api/items?bin_id=${binId}`);
    if (!items.length) { host.innerHTML = '<p class="muted">Kiste ist leer.</p>'; return; }
    renderItemCollection(items, host, { compact: true });
  } catch (err) {
    host.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
}

async function deleteBinAction(bin, withItems) {
  try {
    const path = `/api/bins/${bin.id}${withItems ? '?with_items=1' : ''}`;
    const res = await api(path, { method: 'DELETE' });
    closeDialog();
    toast(withItems
      ? `Kiste und ${res.deleted_items ?? 0} Gegenstände entfernt`
      : 'Kiste entfernt – Inhalt bleibt erhalten', 'ok');
    loadBins();
    runSearch();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openBinDialog(bin, prefillLiters) {
  const isEdit = Boolean(bin);
  const inner = bin?.inner_dims ?? {};
  openDialog({
    title: isEdit ? 'Kiste bearbeiten' : 'Neue Kiste',
    okText: isEdit ? 'Speichern' : 'Anlegen',
    body: `
      <div class="grid-2">
        <div class="field"><label>Code *</label><input name="code" value="${esc(bin?.code ?? '')}" placeholder="A23" required></div>
        <div class="field"><label>Name</label><input name="name" value="${esc(bin?.name ?? '')}" placeholder="Werkzeug"></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Ort</label><input name="location" value="${esc(bin?.location ?? '')}" placeholder="Regal 1"></div>
        <div class="field"><label>Fach / Regal</label><input name="shelf" value="${esc(bin?.shelf ?? '')}"></div>
      </div>
      <div class="grid-3">
        <div class="field"><label>Länge cm</label><input name="length_cm" type="number" step="0.1" inputmode="decimal" min="0.2" max="300" value="${esc(inner.a ?? '')}"></div>
        <div class="field"><label>Breite cm</label><input name="width_cm" type="number" step="0.1" inputmode="decimal" min="0.2" max="300" value="${esc(inner.b ?? '')}"></div>
        <div class="field"><label>Höhe cm</label><input name="height_cm" type="number" step="0.1" inputmode="decimal" min="0.2" max="300" value="${esc(inner.c ?? '')}"></div>
      </div>
      <p class="muted" style="margin-top:-4px">Oder nur Volumen angeben (wird zu würfelförmigen Maßen):</p>
      <div class="grid-2">
        <div class="field"><label>Volumen in Litern</label><input name="capacity_liters" type="number" step="1" min="1" value="${prefillLiters ? esc(prefillLiters) : ''}"></div>
        <div class="field"><label>max. Gewicht g</label><input name="max_weight_g" type="number" step="100" min="0" value="${esc(bin?.max_weight_g ?? '')}"></div>
      </div>
      <div class="field"><label>Füllhöhe in cm (optional)</label><input name="fill_height_cm" type="number" step="0.1" inputmode="decimal" min="0" value="${esc(bin?.fill_height_cm ?? '')}"></div>
      <div class="grid-2">
        <div class="field"><label>Aktiv</label>
          <select name="active"><option value="1" ${bin?.active === false ? '' : 'selected'}>Ja</option><option value="0" ${bin?.active === false ? 'selected' : ''}>Nein</option></select>
        </div>
        <div class="field"><label>Füllstatus</label>
          <select name="full">
            <option value="0" ${bin?.marked_full ? '' : 'selected'}>Platz vorhanden</option>
            <option value="1" ${bin?.marked_full ? 'selected' : ''}>Voll – nur Kleinteile</option>
          </select>
        </div>
      </div>
      ${isEdit ? `<div class="field">
        <label>Kiste entfernen</label>
        <button type="button" class="small danger" id="bin-delete">Kiste entfernen …</button>
        <small class="muted">${bin.item_count ?? 0} Gegenstände in dieser Kiste</small>
      </div>` : ''}
      <div class="field">
        <label>Foto der Kiste (von außen)</label>
        ${bin?.photo_url ? `<img class="bin-photo-preview" src="${esc(bin.photo_url)}?v=${encodeURIComponent(bin.updated_at ?? '')}" alt="Kistenfoto">` : '<p class="muted">Noch kein Foto.</p>'}
        <div class="row">
          <label class="upload-btn">
            <input type="file" accept="image/*" id="bin-photo-input">
            <span>${bin?.photo_url ? 'Foto ersetzen' : '＋ Foto hinzufügen'}</span>
          </label>
          ${bin?.photo_url ? '<button type="button" class="small danger shrink" id="bin-photo-remove">Entfernen</button>' : ''}
        </div>
      </div>`,
    onOk: async (form) => {
      const fd = new FormData(form);
      const payload = {
        code: fd.get('code'),
        name: fd.get('name'),
        location: fd.get('location'),
        shelf: fd.get('shelf'),
        active: fd.get('active') === '1',
        fill_height_cm: num(fd.get('fill_height_cm')),
        max_weight_g: num(fd.get('max_weight_g')),
        capacity_liters: num(fd.get('capacity_liters')) || undefined,
      };
      const dims = {
        length_cm: num(fd.get('length_cm')),
        width_cm: num(fd.get('width_cm')),
        height_cm: num(fd.get('height_cm')),
      };
      if (dims.length_cm && dims.width_cm && dims.height_cm) payload.dims_cm = dims;
      let saved = null;
      if (isEdit) {
        const res = await api(`/api/bins/${bin.id}`, { method: 'PUT', body: payload });
        saved = res.bin;
        toast('Kiste gespeichert', 'ok');
      } else {
        const res = await api('/api/bins', { method: 'POST', body: payload });
        saved = res.bin;
        toast('Kiste angelegt', 'ok');
      }
      // Füllstatus ("voll") setzen/aufheben
      if (saved?.id) {
        const wantFull = fd.get('full') === '1';
        if (wantFull !== Boolean(saved.marked_full)) {
          await api(`/api/bins/${saved.id}/full`, { method: wantFull ? 'POST' : 'DELETE' });
          saved = { ...saved, marked_full: wantFull };
        }
      }
      if (pendingBinPhoto && saved?.id) {
        try {
          await api(`/api/bins/${saved.id}/photo`, { method: 'POST', body: { image: pendingBinPhoto } });
          toast('Kistenfoto gespeichert', 'ok');
        } catch (err) {
          toast(`Kiste gespeichert, Foto fehlgeschlagen: ${err.message}`, 'error');
        }
      }
      pendingBinPhoto = null;
      await loadBins();
    },
  });

  const deleteButton = $('#bin-delete');
  if (deleteButton && isEdit) {
    deleteButton.addEventListener('click', () => {
      const count = bin.item_count ?? 0;
      openChoiceSheet({
        title: 'Kiste entfernen',
        body: `<p class="muted">Was soll mit den ${count} Gegenständen in ${esc(bin.code)} passieren?</p>`,
        choices: [
          {
            label: 'Nur die Kiste entfernen',
            hint: count ? `${count} Gegenstände bleiben erhalten und sind danach „ohne Kiste"` : 'Die Kiste ist leer',
            kind: 'big',
            onSelect: () => deleteBinAction(bin, false),
          },
          {
            label: count ? `Kiste mit ${count} Gegenständen entfernen` : 'Kiste entfernen',
            hint: count ? 'Gegenstände, Fotos und Rechnungen werden gelöscht' : 'Die Kiste ist leer',
            kind: 'big danger',
            onSelect: () => {
              const doIt = count
                ? confirm(`Wirklich ${count} Gegenstände samt Fotos/Rechnungen löschen?`)
                : true;
              if (doIt) deleteBinAction(bin, true);
            },
          },
        ],
      });
    });
  }

  const photoInput = $('#bin-photo-input');
  if (photoInput) {
    photoInput.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const dataUrl = await fileToDataUrl(file, 1000);
        if (isEdit) {
          const { bin: updated } = await api(`/api/bins/${bin.id}/photo`, { method: 'POST', body: { image: dataUrl } });
          toast('Kistenfoto gespeichert', 'ok');
          openBinDialog(updated);
          loadBins();
        } else {
          pendingBinPhoto = dataUrl;
          toast('Foto wird beim Anlegen übernommen', 'ok');
        }
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
  const photoRemove = $('#bin-photo-remove');
  if (photoRemove) {
    photoRemove.addEventListener('click', async () => {
      try {
        const { bin: updated } = await api(`/api/bins/${bin.id}/photo`, { method: 'DELETE' });
        toast('Kistenfoto entfernt', 'ok');
        openBinDialog(updated);
        loadBins();
      } catch (err) { toast(err.message, 'error'); }
    });
  }
}

$('[data-action="new-bin"]').addEventListener('click', () => openBinDialog(null));

/* ------------------------------- Gegenstände ---------------------------- */

function itemCard(item, { compact = false } = {}) {
  const photo = item.photo_path
    ? `<img class="item-thumb" src="${esc(photoSrc(item.photo_path, item))}" alt="" loading="lazy">`
    : '<div class="item-thumb"></div>';
  const bin = item.bin
    ? `<span class="bin-chip">${esc(item.bin.code)}</span>`
    : '<span class="bin-chip" style="background:color-mix(in srgb, var(--warn) 18%, transparent);color:var(--warn)">Posteingang</span>';
  const dims = item.dims_cm?.length_cm
    ? `${item.dims_cm.length_cm} × ${item.dims_cm.width_cm} × ${item.dims_cm.height_cm} cm`
    : '';
  const info = [item.category, item.brand].filter(Boolean).join(' · ');
  return `
    <div class="item-card" data-item="${item.id}">
      <div class="card-main">
        ${photo}
        <div class="card-body">
          <div class="title-row">
            <span class="name">${esc(item.name)}${item.quantity > 1 ? ` <span class="badge qty">${item.quantity}×</span>` : ''}</span>
            ${bin}
          </div>
          ${item.description ? `<div class="meta">${esc(item.description.slice(0, 120))}</div>` : ''}
          <div class="meta">
            ${[dims, info, `seit ${dateStr(item.created_at)}`].filter(Boolean).join(' · ')}
            ${item.purchase_price != null ? ` · ${(item.purchase_price).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}` : ''}
            ${item.purchase_date ? ` · gekauft ${dateStr(item.purchase_date)}` : ''}
            ${item.invoice_url ? ' · Rechnung' : ''}
            ${item.photos?.length > 1 ? ` · ${item.photos.length} Fotos` : ''}
          </div>
          <div class="actions">
            ${item.bin_id ? '' : `<button class="small primary" data-inbox-assign="${item.id}">Einlagern</button>`}
            <button class="small ghost" data-edit-item="${item.id}">Bearbeiten</button>
            <button class="small ghost" data-move-item="${item.id}">Umräumen</button>
            <button class="small danger" data-delete-item="${item.id}">Entfernen</button>
          </div>
        </div>
      </div>
    </div>`;
}

function itemGridCard(item) {
  const photo = item.photo_path
    ? `<img src="${esc(photoSrc(item.photo_path, item))}" alt="" loading="lazy" class="grid-photo">`
    : '<span class="grid-photo empty"></span>';
  return `
    <button type="button" class="grid-item" data-open-item="${item.id}" title="${esc(item.name)}">
      ${photo}
      <span class="grid-name">${esc(item.name)}</span>
      <span class="grid-meta">
        ${item.quantity > 1 ? `<span class="badge qty">${item.quantity}×</span>` : ''}
        ${item.bin ? `<span class="grid-bin">${esc(item.bin.code)}</span>` : ''}
      </span>
    </button>`;
}

/** Rendert Artikel als Liste oder Raster (je nach Ansicht). */
function renderItemCollection(items, host, { compact = false } = {}) {
  if (state.viewMode === 'grid') {
    host.className = 'grid-items';
    host.innerHTML = items.map(itemGridCard).join('');
  } else {
    host.className = 'list';
    host.innerHTML = items.map((it) => itemCard(it, { compact })).join('');
  }
  bindItemActions(host);
}

function bindItemActions(root) {
  // Kachel im Raster: erst ansehen, bearbeitet wird über den Stift.
  $$('[data-open-item]', root).forEach((btn) => {
    btn.addEventListener('click', () => openItemDetail(Number(btn.dataset.openItem)));
  });
  // Listenkarte: Klick auf den Inhalt (nicht auf Knöpfe) öffnet die Ansicht.
  $$('[data-item]', root).forEach((card) => {
    const main = card.querySelector('.card-main');
    if (!main) return;
    main.addEventListener('click', (event) => {
      if (event.target.closest('button, a, input, select, textarea')) return;
      openItemDetail(Number(card.dataset.item));
    });
  });
  $$('[data-edit-item]', root).forEach((btn) => {
    btn.addEventListener('click', () => openItemEditor(Number(btn.dataset.editItem)));
  });
  $$('[data-inbox-assign]', root).forEach((btn) => {
    btn.addEventListener('click', () => assignInboxItem(Number(btn.dataset.inboxAssign)));
  });
  $$('[data-move-item]', root).forEach((btn) => {
    btn.addEventListener('click', () => moveItemDialog(Number(btn.dataset.moveItem)));
  });
  $$('[data-delete-item]', root).forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Diesen Gegenstand wirklich entfernen?')) return;
      try {
        await api(`/api/items/${btn.dataset.deleteItem}`, { method: 'DELETE' });
        toast('Entfernt', 'ok');
        loadBins();
        runSearch();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

/* --------------------------- Artikel bearbeiten ------------------------- */

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
    reader.readAsDataURL(file);
  });
}

/* ------------------------------ Posteingang ----------------------------- */

async function updateInboxBadge(count) {
  const el = $('#inbox-count');
  if (!el) return;
  let n = count;
  if (n == null) {
    try { n = (await api('/api/inbox')).items.length; } catch { return; }
  }
  el.textContent = String(n);
  el.hidden = n === 0;
}

async function loadInbox() {
  const list = $('#inbox-list');
  const summary = $('#inbox-summary');
  list.innerHTML = '<p class="status">Lädt…</p>';
  try {
    const { items } = await api('/api/inbox');
    updateInboxBadge(items.length);
    summary.textContent = items.length
      ? `${items.length} Artikel warten auf eine Kiste – du kannst sie später in Ruhe durchsehen.`
      : 'Der Posteingang ist leer.';
    if (!items.length) {
      list.innerHTML = '<p class="muted">Nimm im Tab „Einlagern" Fotos auf oder nutze „In den Posteingang (schnell)".</p>';
      return;
    }
    renderItemCollection(items, list);
  } catch (err) {
    list.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
}

async function addToInbox() {
  if (!state.photo?.dataUrl) {
    toast('Bitte zuerst ein Foto machen.', 'error');
    return;
  }
  const btn = $('#btn-inbox');
  const hint = $('#hint')?.value.trim() || '';
  btn.disabled = true;
  try {
    const data = await api('/api/inbox', {
      method: 'POST',
      body: { image: state.photo.dataUrl, hint: hint || undefined },
    });
    resetCapture();
    updateInboxBadge();
    if (document.querySelector('#view-inbox').classList.contains('active')) loadInbox();
    toast('Im Posteingang – nächstes Foto?', 'ok');
    // Analyse im Hintergrund nachziehen (blockiert die Erfassung nicht).
    if ($('#auto-analyze')?.checked ?? true) {
      analyzeInboxItem(data.item.id, data.image_data_url, hint, data.auto_named);
    }
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
}

async function analyzeInboxItem(id, imageDataUrl, hint, autoNamed) {
  if (!imageDataUrl) return;
  try {
    const { analysis } = await api('/api/analyze', {
      method: 'POST',
      body: { image: imageDataUrl, hint: hint || undefined },
    });
    const patch = {
      description: analysis.description,
      brand: analysis.brand,
      category: analysis.category,
      shape: analysis.shape,
      quantity: analysis.quantity,
    };
    if (autoNamed && analysis.title) patch.name = analysis.title;
    await api(`/api/items/${id}`, { method: 'PUT', body: patch });
    const dims = analysis.dims_cm;
    if (dims && dims.length_cm && dims.width_cm && dims.height_cm) {
      await api(`/api/items/${id}`, {
        method: 'PUT',
        body: { dims_cm: dims, weight_g: analysis.weight_g ?? null, shape: analysis.shape },
      });
    }
    toast(`Posteingang: „${analysis.title || 'Artikel'}" analysiert`, 'ok');
    updateInboxBadge();
    if (document.querySelector('#view-inbox').classList.contains('active')) loadInbox();
    if (document.querySelector('#view-search').classList.contains('active')) runSearch();
  } catch {
    // Analyse ist optional – der Artikel bleibt einfach im Posteingang.
  }
}

async function assignInboxItems(ids = null) {
  const res = await api('/api/inbox/assign', { method: 'POST', body: ids ? { ids } : {} });
  return res;
}

async function assignInboxItem(id) {
  try {
    const res = await assignInboxItems([id]);
    if (res.assigned.length) {
      toast(`Eingelagert in ${res.assigned[0].bin ?? 'Kiste'}`, 'ok');
    } else {
      toast(res.failed[0]?.reason ?? 'Kein Platz gefunden', 'error');
    }
    refreshItemViews();
  } catch (err) { toast(err.message, 'error'); }
}

async function assignAllInbox() {
  const btn = $('#btn-inbox-assign');
  btn.disabled = true;
  try {
    const res = await assignInboxItems();
    const failedText = res.failed.length
      ? ` · ${res.failed.length} nicht (z. B. „${res.failed[0].name}": ${res.failed[0].reason})`
      : '';
    toast(`${res.assigned.length} eingelagert${failedText}`, res.failed.length ? 'error' : 'ok');
    refreshItemViews();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

$('#btn-inbox').addEventListener('click', addToInbox);
$('#btn-inbox-assign').addEventListener('click', assignAllInbox);

/* ----------------------------- Detailansicht ---------------------------- */

function openPhotoViewer(photoPath, item) {
  openDialog({
    title: 'Foto',
    okText: 'Schließen',
    body: `<img class="photo-large" src="${esc(photoSrc(photoPath, item))}" alt="">`,
    onOk: async () => {},
  });
  $('#dialog-ok').hidden = true;
}

function detailRows(item) {
  const dims = item.dims_cm?.length_cm
    ? `${item.dims_cm.length_cm} × ${item.dims_cm.width_cm} × ${item.dims_cm.height_cm} cm`
    : null;
  const price = item.purchase_price != null
    ? item.purchase_price.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })
    : null;
  const bin = item.bin
    ? `${item.bin.code}${item.bin.name ? ` · ${item.bin.name}` : ''}${item.bin.location ? ` (${item.bin.location})` : ''}`
    : 'Posteingang';
  return [
    ['Ablageort', bin],
    ['Stückzahl', item.quantity > 1 ? `${item.quantity}×` : null],
    ['Kategorie', item.category || null],
    ['Marke', item.brand || null],
    ['Maße', dims],
    ['Gewicht', item.weight_g ? `${item.weight_g} g` : null],
    ['Volumen', item.volume_liters ? liters(item.volume_liters) : null],
    ['Kaufdatum', item.purchase_date ? dateStr(item.purchase_date) : null],
    ['Kaufpreis', price],
    ['Eingelagert', dateStr(item.created_at)],
    ['Zuletzt geprüft', item.last_reviewed_at ? dateStr(item.last_reviewed_at) : null],
  ].filter(([, value]) => value);
}

function renderItemDetail(item) {
  const photos = item.photos ?? [];
  const gallery = photos.length
    ? `<div class="detail-gallery">${photos.map((p) => `
        <button type="button" class="detail-photo" data-view-photo="${esc(p)}" title="Groß ansehen">
          <img src="${esc(photoSrc(p, item))}" alt="" loading="lazy">
        </button>`).join('')}</div>`
    : '<div class="detail-gallery"><div class="item-thumb"></div></div>';
  const invoice = item.invoice_url
    ? `<a href="${esc(item.invoice_url)}" target="_blank" rel="noopener">📄 ${esc(item.invoice_name || 'Rechnung')}</a>`
    : null;

  openDialog({
    title: item.name,
    okText: 'Schließen',
    body: `
      ${gallery}
      ${item.quantity > 1 ? `<p><span class="badge qty">${item.quantity}× vorhanden</span></p>` : ''}
      ${item.description ? `<p class="detail-desc">${esc(item.description)}</p>` : ''}
      <dl class="kv">
        ${detailRows(item).map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}
        ${invoice ? `<dt>Rechnung</dt><dd>${invoice}</dd>` : ''}
      </dl>
      <div class="row" style="margin-top:6px">
        ${item.bin_id ? '' : '<button type="button" class="primary" id="detail-store">Einlagern</button>'}
        <button type="button" class="${item.bin_id ? 'primary' : 'small ghost'}" id="detail-edit">✎ Bearbeiten</button>
        <button type="button" class="small ghost" id="detail-move">Umräumen</button>
        <button type="button" class="small danger" id="detail-delete">Entfernen</button>
      </div>`,
    onOk: async () => {},
  });
  $('#dialog-ok').hidden = true;

  $$('#dialog-body [data-view-photo]').forEach((btn) => {
    btn.addEventListener('click', () => openPhotoViewer(btn.dataset.viewPhoto, item));
  });
  const storeBtn = $('#detail-store');
  if (storeBtn) {
    storeBtn.addEventListener('click', async () => {
      closeDialog();
      await assignInboxItem(item.id);
    });
  }
  $('#detail-edit').addEventListener('click', () => {
    closeDialog();
    renderItemEditor(item);
  });
  $('#detail-move').addEventListener('click', () => {
    closeDialog();
    moveItemDialog(item.id);
  });
  $('#detail-delete').addEventListener('click', async () => {
    if (!confirm(`„${item.name}“ wirklich entfernen?`)) return;
    try {
      await api(`/api/items/${item.id}`, { method: 'DELETE' });
      closeDialog();
      toast('Entfernt', 'ok');
      refreshItemViews();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function openItemDetail(itemId) {
  try {
    const { item } = await api(`/api/items/${itemId}`);
    renderItemDetail(item);
  } catch (err) { toast(err.message, 'error'); }
}

async function openItemEditor(itemId) {
  try {
    const { item } = await api(`/api/items/${itemId}`);
    renderItemEditor(item);
  } catch (err) { toast(err.message, 'error'); }
}

function refreshItemViews() {
  loadBins();
  runSearch();
  updateInboxBadge();
  if (document.querySelector('#view-inbox').classList.contains('active')) loadInbox();
}

function renderItemEditor(item) {
  const price = item.purchase_price != null
    ? String(item.purchase_price).replace('.', ',')
    : '';
  const photos = (item.photos ?? []).map((p) => `
    <span class="photo-tile">
      <img src="${esc(photoSrc(p, item))}" alt="">
      <span class="photo-rotate">
        <button type="button" data-rotate-photo="${esc(p)}" data-direction="left" title="90° nach links drehen" aria-label="90 Grad nach links drehen">↺</button>
        <button type="button" data-rotate-photo="${esc(p)}" data-direction="right" title="90° nach rechts drehen" aria-label="90 Grad nach rechts drehen">↻</button>
      </span>
      <button type="button" class="photo-remove" data-remove-photo="${esc(p)}" title="Foto entfernen" aria-label="Foto entfernen">✕</button>
    </span>`).join('');

  openDialog({
    title: 'Gegenstand bearbeiten',
    okText: 'Speichern',
    body: `
      <div class="field"><label>Name</label><input name="name" value="${esc(item.name)}"></div>
      <div class="field"><label>Beschreibung</label><textarea name="description" placeholder="Was ist das, wofür nutzt du es?">${esc(item.description ?? '')}</textarea></div>
      <div class="grid-2">
        <div class="field"><label>Kategorie</label><input name="category" value="${esc(item.category ?? '')}" placeholder="z. B. Küche"></div>
        <div class="field"><label>Marke</label><input name="brand" value="${esc(item.brand ?? '')}"></div>
      </div>
      <div class="field">
        <label>Maße in cm (L × B × H)</label>
        <div class="grid-3">
          <input name="length_cm" type="number" step="0.1" min="0.2" max="300" inputmode="decimal" placeholder="L" value="${esc(item.dims_cm?.length_cm ?? '')}">
          <input name="width_cm" type="number" step="0.1" min="0.2" max="300" inputmode="decimal" placeholder="B" value="${esc(item.dims_cm?.width_cm ?? '')}">
          <input name="height_cm" type="number" step="0.1" min="0.2" max="300" inputmode="decimal" placeholder="H" value="${esc(item.dims_cm?.height_cm ?? '')}">
        </div>
        <small class="muted">Änderungen platzieren den Gegenstand in seiner Kiste neu.</small>
      </div>
      <div class="grid-2">
        <div class="field"><label>Gewicht g</label><input name="weight_g" type="number" step="1" min="0" inputmode="decimal" value="${esc(item.weight_g ?? '')}"></div>
        <div class="field"><label>Form</label>
          <select name="shape">
            ${SHAPES.map(([v, label]) => `<option value="${v}" ${item.shape === v ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="grid-3">
        <div class="field"><label>Kaufdatum</label><input name="purchase_date" type="date" value="${esc(item.purchase_date ?? '')}"></div>
        <div class="field"><label>Kaufpreis €</label><input name="purchase_price" type="text" inputmode="decimal" autocomplete="off" value="${esc(price)}" placeholder="24,90"></div>
        <div class="field"><label>Stückzahl</label><input name="quantity" type="number" min="1" max="9999" step="1" inputmode="numeric" value="${esc(item.quantity ?? 1)}"></div>
      </div>

      <div class="field">
        <label>Fotos (${item.photos?.length ?? 0})</label>
        <div class="photo-grid">${photos || '<p class="muted">Noch keine Fotos.</p>'}</div>
        <label class="upload-btn">
          <input type="file" accept="image/*" multiple id="editor-add-photos">
          <span>＋ Fotos hinzufügen</span>
        </label>
      </div>

      <div class="field">
        <label>Originalrechnung</label>
        ${item.invoice_url ? `
          <div class="row">
            <a class="small ghost" href="${esc(item.invoice_url)}" target="_blank" rel="noopener">📄 ${esc(item.invoice_name || 'Rechnung ansehen')}</a>
            <button type="button" class="small danger shrink" id="editor-remove-invoice">Entfernen</button>
          </div>
          ${item.invoice_source === 'paperless' ? '<small class="muted">aus Paperless übernommen</small>' : ''}`
        : '<p class="muted">Noch keine Rechnung hinterlegt.</p>'}
        ${state.paperless?.configured
          ? '<button type="button" class="small primary" id="editor-paperless">🔎 In Paperless suchen</button>'
          : '<p class="muted">Paperless nicht konfiguriert – <code>PAPERLESS_URL</code> plus <code>PAPERLESS_TOKEN</code> oder <code>PAPERLESS_USERNAME</code>/<code>PAPERLESS_PASSWORD</code> in der .env setzen.</p>'}
        <label class="upload-btn">
          <input type="file" accept="application/pdf,image/*" id="editor-add-invoice">
          <span>${item.invoice_url ? 'Datei ersetzen' : '＋ Datei hochladen'}</span>
        </label>
      </div>
      <p class="muted">Volumen ${liters(item.volume_liters)} · eingelagert in ${item.bin ? `${esc(item.bin.code)}${item.bin.name ? ` · ${esc(item.bin.name)}` : ''}` : 'keine Kiste'} · seit ${dateStr(item.created_at)}</p>
      <div class="row">
        <button type="button" class="small danger" id="editor-delete-item">Gegenstand entfernen</button>
      </div>`,
    onOk: async (form) => {
      const fd = new FormData(form);
      const dims = {
        length_cm: num(fd.get('length_cm')),
        width_cm: num(fd.get('width_cm')),
        height_cm: num(fd.get('height_cm')),
      };
      const dimsFilled = Object.values(dims).filter((v) => v > 0).length;
      if (dimsFilled > 0 && dimsFilled < 3) {
        toast('Bitte alle drei Maße (L × B × H) angeben oder alle leer lassen.', 'error');
        return;
      }
      const body = {
        name: fd.get('name'),
        description: fd.get('description'),
        category: fd.get('category'),
        brand: fd.get('brand'),
        shape: fd.get('shape'),
        weight_g: fd.get('weight_g') === '' ? null : num(fd.get('weight_g')),
        purchase_date: fd.get('purchase_date') || null,
        purchase_price: fd.get('purchase_price') === '' ? null : fd.get('purchase_price'),
        quantity: Math.max(1, Math.round(num(fd.get('quantity')) ?? 1)),
      };
      if (dimsFilled === 3) body.dims_cm = dims;
      await api(`/api/items/${item.id}`, { method: 'PUT', body });
      toast('Gespeichert', 'ok');
      refreshItemViews();
    },
  });

  // --- Fotos ---
  $('#editor-add-photos').addEventListener('change', async (event) => {
    const files = [...(event.target.files ?? [])];
    if (!files.length) return;
    try {
      const images = [];
      for (const file of files) images.push(await fileToDataUrl(file, 1600));
      const { item: updated } = await api(`/api/items/${item.id}/photos`, {
        method: 'POST',
        body: { images },
      });
      toast(`${images.length} Foto(s) hinzugefügt`, 'ok');
      renderItemEditor(updated);
      refreshItemViews();
    } catch (err) { toast(err.message, 'error'); }
  });

  $$('#dialog-body [data-remove-photo]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const photoPath = btn.dataset.removePhoto;
      const name = photoPath.split('/').pop();
      try {
        const { item: updated } = await api(`/api/items/${item.id}/photos/${name}`, { method: 'DELETE' });
        renderItemEditor(updated);
        refreshItemViews();
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  $$('#dialog-body [data-rotate-photo]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const photoPath = btn.dataset.rotatePhoto;
      const name = photoPath.split('/').pop();
      btn.disabled = true;
      try {
        const { item: updated } = await api(`/api/items/${item.id}/photos/${name}/rotate`, {
          method: 'POST',
          body: { direction: btn.dataset.direction },
        });
        renderItemEditor(updated);
        refreshItemViews();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });
  });

  // --- Rechnung ---
  $('#editor-add-invoice').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { toast('Rechnung ist zu groß (max. 15 MB).', 'error'); return; }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const { item: updated } = await api(`/api/items/${item.id}/invoice`, {
        method: 'POST',
        body: { file: dataUrl, name: file.name },
      });
      toast('Rechnung hinterlegt', 'ok');
      renderItemEditor(updated);
      refreshItemViews();
    } catch (err) { toast(err.message, 'error'); }
  });

  const deleteBtn = $('#editor-delete-item');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`„${item.name}“ wirklich entfernen?`)) return;
      try {
        await api(`/api/items/${item.id}`, { method: 'DELETE' });
        closeDialog();
        toast('Entfernt', 'ok');
        refreshItemViews();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  const paperlessBtn = $('#editor-paperless');
  if (paperlessBtn) paperlessBtn.addEventListener('click', () => openPaperlessSearch(item));

  const removeInvoice = $('#editor-remove-invoice');
  if (removeInvoice) {
    removeInvoice.addEventListener('click', async () => {
      try {
        const { item: updated } = await api(`/api/items/${item.id}/invoice`, { method: 'DELETE' });
        renderItemEditor(updated);
        refreshItemViews();
      } catch (err) { toast(err.message, 'error'); }
    });
  }
}

/* ------------------- Rechnung aus Paperless suchen ---------------------- */

async function loadPaperlessStatus() {
  try {
    state.paperless = await api('/api/paperless/status');
  } catch {
    state.paperless = { configured: false, url: null };
  }
}

function openPaperlessSearch(item) {
  openDialog({
    title: 'Rechnung aus Paperless',
    okText: 'Schließen',
    body: `
      <p class="muted">Paperless: ${esc(state.paperless?.url || 'lokal')}</p>
      <div class="searchbar">
        <input id="pl-query" type="search" placeholder="Suchbegriff" enterkeyhint="search" autocomplete="off">
        <button type="button" class="small primary" id="pl-search">Suchen</button>
      </div>
      <div id="pl-results" class="list"><p class="status">Suche…</p></div>`,
    onOk: async () => {},
  });
  $('#dialog-ok').hidden = true;

  const input = $('#pl-query');
  const results = $('#pl-results');
  const run = async (query) => {
    results.innerHTML = '<p class="status">Suche in Paperless…</p>';
    try {
      const q = query ? `?q=${encodeURIComponent(query)}` : '';
      const data = await api(`/api/items/${item.id}/invoice/search${q}`);
      if (!input.value) input.value = data.query;
      if (!data.results.length) {
        results.innerHTML = '<p class="muted">Nichts gefunden. Anderen Begriff versuchen.</p>';
        return;
      }
      results.innerHTML = data.results.map((doc) => `
        <button type="button" class="choice" data-doc="${doc.id}">
          <span class="choice-label">${esc(doc.title)}</span>
          <span class="choice-hint">${[dateStr(doc.created), doc.correspondent, doc.document_type, ...(doc.tags ?? [])].filter(Boolean).map(esc).join(' · ')}</span>
        </button>`).join('');
      $$('#pl-results [data-doc]').forEach((btn) => {
        btn.addEventListener('click', () => attachPaperlessInvoice(item, Number(btn.dataset.doc), btn));
      });
    } catch (err) {
      results.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
    }
  };

  $('#pl-search').addEventListener('click', () => run(input.value.trim()));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); run(input.value.trim()); }
  });
  run('');
}

async function attachPaperlessInvoice(item, documentId, button) {
  if (button) button.disabled = true;
  try {
    const { item: updated } = await api(`/api/items/${item.id}/invoice/paperless`, {
      method: 'POST',
      body: { document_id: documentId },
    });
    closeDialog();
    toast('Rechnung aus Paperless übernommen', 'ok');
    renderItemEditor(updated);
    refreshItemViews();
  } catch (err) {
    toast(err.message, 'error');
    if (button) button.disabled = false;
  }
}

async function moveItemDialog(itemId) {
  try {
    const [binsData, itemData] = await Promise.all([api('/api/bins?active=1'), api(`/api/items/${itemId}`)]);
    const item = itemData.item;
    openDialog({
      title: 'Umräumen',
      okText: 'Umräumen',
      body: `
        <p class="muted">${esc(item.name)}</p>
        <div class="field"><label>Zielkiste</label>
          <select name="bin_id">
            <option value="">– aus Kiste entfernen –</option>
            ${binsData.bins.map((b) => `<option value="${b.id}" ${b.id === item.bin_id ? 'selected' : ''}>${esc(b.code)} · ${esc(b.location || '')} (${liters(b.free_liters)} frei)</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>oder</label>
          <select name="auto"><option value="0">selbst wählen</option><option value="1">automatisch freien Platz suchen</option></select>
        </div>`,
      onOk: async (form) => {
        const fd = new FormData(form);
        const auto = fd.get('auto') === '1';
        const binId = auto ? 'auto' : (fd.get('bin_id') || null);
        await api(`/api/items/${itemId}/move`, { method: 'POST', body: { bin_id: binId } });
        toast('Umgeräumt', 'ok');
        loadBins();
        runSearch();
      },
    });
  } catch (err) { toast(err.message, 'error'); }
}

/* --------------------------------- Suche -------------------------------- */

async function runSearch() {
  const query = $('#search-input').value.trim();
  const host = $('#search-results');
  host.innerHTML = '<p class="status">Suche…</p>';
  try {
    const { items } = await api(`/api/search?q=${encodeURIComponent(query)}`);
    if (!items.length) {
      host.innerHTML = `<p class="muted">${query ? 'Nichts gefunden.' : 'Noch nichts eingelagert.'}</p>`;
      return;
    }
    renderItemCollection(items, host);
  } catch (err) {
    host.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
}

$('#btn-search').addEventListener('click', runSearch);
$('#search-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); runSearch(); }
});

/* ------------------------------- Erinnerung ----------------------------- */

async function loadRecall() {
  const host = $('#recall-list');
  const info = $('#recall-info');
  host.innerHTML = '<p class="status">Lädt…</p>';
  try {
    const data = await api('/api/recall');
    if (!data.enabled) {
      info.textContent = 'Die Prüf-Erinnerung ist ausgeschaltet.';
      host.innerHTML = '<p class="muted">In den Einstellungen aktivieren, um regelmäßig zufällige Sachen zur Prüfung zu bekommen.</p>';
      return;
    }
    info.textContent = data.eligible
      ? `${data.eligible} Gegenstände sind fällig · Intervall ${data.interval_days} Tage`
      : `Nichts fällig · Intervall ${data.interval_days} Tage`;
    if (!data.items.length) {
      host.innerHTML = '<p class="muted">Gerade ist nichts zur Prüfung fällig. Schau später wieder vorbei.</p>';
      return;
    }
    host.innerHTML = data.items.map(recallCard).join('');
    $$('#recall-list [data-verdict]').forEach((btn) => {
      btn.addEventListener('click', () => submitVerdict(Number(btn.dataset.item), btn.dataset.verdict));
    });
  } catch (err) {
    host.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
}

function recallCard(item) {
  const photo = item.photo_path
    ? `<img class="item-thumb" src="${esc(photoSrc(item.photo_path, item))}" alt="" loading="lazy">`
    : '<div class="item-thumb"></div>';
  return `
    <div class="item-card">
      <div class="card-main">
        ${photo}
        <div class="card-body">
          <div class="title-row">
            <span class="name">${esc(item.name)}</span>
            ${item.bin ? `<span class="bin-chip">${esc(item.bin.code)}</span>` : ''}
          </div>
          ${item.description ? `<div class="meta">${esc(item.description.slice(0, 120))}</div>` : ''}
          <div class="meta">seit ${dateStr(item.created_at)} · zuletzt geprüft: ${dateStr(item.last_reviewed_at)}</div>
          <div class="actions">
            <button class="small primary" data-item="${item.id}" data-verdict="keep">Behalte ich</button>
            <button class="small ghost" data-item="${item.id}" data-verdict="unused">Nutze ich nicht</button>
          </div>
          <div class="actions">
            <button class="small danger" data-item="${item.id}" data-verdict="discard">Aussortieren</button>
            <button class="small ghost" data-item="${item.id}" data-verdict="not_found">Nicht gefunden</button>
          </div>
        </div>
      </div>
    </div>`;
}

async function submitVerdict(itemId, verdict) {
  try {
    await api(`/api/recall/${itemId}`, { method: 'POST', body: { verdict } });
    toast(verdict === 'keep' ? 'Danke – bleibt im Katalog' : 'Notiert', 'ok');
    loadRecall();
  } catch (err) { toast(err.message, 'error'); }
}

$('[data-action="reload-recall"]').addEventListener('click', loadRecall);

/* --------------------------------- Start -------------------------------- */

loadPaperlessStatus();
updateInboxBadge();

/* --------------------------- Listen-/Rasteransicht ---------------------- */

function updateViewToggle() {
  $$('[data-view-mode]').forEach((btn) => {
    btn.textContent = state.viewMode === 'grid' ? 'Liste' : 'Raster';
  });
}

function toggleViewMode() {
  state.viewMode = state.viewMode === 'grid' ? 'list' : 'grid';
  localStorage.setItem('storder_view', state.viewMode);
  updateViewToggle();
  loadBins();
  if (document.querySelector('#view-search').classList.contains('active')) runSearch();
}

$$('[data-view-mode]').forEach((btn) => btn.addEventListener('click', toggleViewMode));
updateViewToggle();

const initialView = location.hash.slice(1);
if (VIEWS.includes(initialView) && initialView !== 'capture') showView(initialView, { push: false });
loadBins();
