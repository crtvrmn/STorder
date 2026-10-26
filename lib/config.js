// Konfiguration: alles per Umgebungsvariablen steuerbar. Einige Werte
// (Modell, Erinnerungsintervall) lassen sich zusätzlich in der App ändern;
// die DB-Einstellungen haben Vorrang vor den ENV-Defaults.

import path from 'node:path';

export function loadConfig(env = process.env) {
  const num = (key, def) => {
    const v = Number(env[key]);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  const bool = (key, def) => {
    if (env[key] == null || env[key] === '') return def;
    return /^(1|true|yes|on)$/i.test(String(env[key]));
  };
  // Wie num(), aber 0 ist ein gültiger Wert (z. B. "kein Mindestalter").
  const num0 = (key, def) => {
    if (env[key] == null || env[key] === '') return def;
    const v = Number(env[key]);
    return Number.isFinite(v) && v >= 0 ? v : def;
  };
  return {
    port: num('PORT', 8080),
    host: env.HOST || '0.0.0.0',
    // absolut, damit res.sendFile() (Fotos/Rechnungen) zuverlässig funktioniert
    dataDir: path.resolve(env.DATA_DIR || './data'),
    appUrl: (env.APP_URL || '').replace(/\/+$/, ''), // für QR-Codes/Links, z.B. http://192.168.1.20:8080
    appName: env.APP_NAME || 'Storder',

    // KI: jeder OpenAI-kompatible Endpunkt. OpenRouter = Default.
    llm: {
      apiKey: env.LLM_API_KEY || env.OPENROUTER_API_KEY || '',
      baseUrl: env.LLM_BASE_URL || 'https://openrouter.ai/api/v1',
      model: env.LLM_MODEL || 'google/gemini-2.5-flash',
      visionModel: env.LLM_VISION_MODEL || env.LLM_MODEL || 'google/gemini-2.5-flash',
      webModel: env.LLM_WEB_MODEL || env.LLM_MODEL || 'google/gemini-2.5-flash',
      // OpenRouter-Plugin "web" (Websuche) ein/aus; false => nur Modellwissen.
      webSearch: bool('LLM_WEB_SEARCH', true),
      webSearchEngine: env.LLM_WEB_SEARCH_ENGINE || 'exa',
      webResults: num('LLM_WEB_RESULTS', 4),
      temperature: Number.isFinite(Number(env.LLM_TEMPERATURE)) ? Number(env.LLM_TEMPERATURE) : 0.2,
      maxImageDimension: num('LLM_MAX_IMAGE_DIM', 1536),
      timeoutMs: num('LLM_TIMEOUT_MS', 180000),
      appReferer: env.LLM_APP_REFERER || 'http://localhost:8080',
      appTitle: env.LLM_APP_TITLE || 'Storder - Lagerkatalog', // ASCII: HTTP-Header erlauben kein –
    },

    // Vorauswahl "typische Kisten" für neue Installationen
    seed: {
      enabled: bool('SEED_BOXES', true),
      // "Name" wird in der App zur Einlagerung vorgeschlagen (optional).
      boxes: (env.SEED_BOXES_LIST || '').trim()
        ? JSON.parse(env.SEED_BOXES_LIST)
        : defaultSeedBoxes(),
    },

    // Erinnerung: Zufalls-Sachen, die man nutzt oder aussortiert
    recall: {
      enabled: bool('RECALL_ENABLED', true),
      intervalDays: num('RECALL_INTERVAL_DAYS', 30),
      itemsPerRecall: num('RECALL_ITEMS_PER_RECALL', 3),
      minItemAgeDays: num0('RECALL_MIN_ITEM_AGE_DAYS', 14),
      maxDaysBetweenRecalls: num('RECALL_MAX_DAYS_BETWEEN_RECALLS', 3),
      maxItems: num0('RECALL_MAX_ITEMS', 0), // 0 = unbegrenzt
      timezone: env.TZ || 'Europe/Berlin',
    },

    upload: {
      maxBytes: num('MAX_UPLOAD_MB', 15) * 1024 * 1024,
      imagesPerItem: num('MAX_IMAGES_PER_ITEM', 8),
    },

    // Paperless-ngx im lokalen Netz: Rechnungen zur Einlagerung suchen.
    // Auth entweder per Token oder per Benutzername/Passwort (holt den Token
    // beim ersten Zugriff über /api/token/).
    paperless: {
      url: (env.PAPERLESS_URL || '').trim().replace(/\/+$/, ''),
      token: (env.PAPERLESS_TOKEN || '').trim(),
      username: (env.PAPERLESS_USERNAME || '').trim(),
      password: String(env.PAPERLESS_PASSWORD ?? ''), // nicht trimmen
      timeoutMs: num('PAPERLESS_TIMEOUT_MS', 15000),
      results: num('PAPERLESS_RESULTS', 8),
    },

    timezone: env.TZ || 'Europe/Berlin',
  };
}

function defaultSeedBoxes() {
  const mk = (code, name, l, w, h) => ({ code, name, length_cm: l, width_cm: w, height_cm: h });
  return [
    mk('B1', 'Küche & Vorrat', 60, 40, 40),
    mk('B2', 'Werkzeug & Technik', 60, 40, 40),
    mk('B3', 'Kabel & Elektronik', 40, 30, 30),
    mk('B4', 'Kleinkram & Basteln', 40, 30, 30),
    mk('B5', 'Saison & Deko', 80, 50, 50),
    mk('B6', 'Dokumente & Papier', 35, 25, 25),
  ];
}

/** Laufzeit-Overrides aus der DB über die ENV-Defaults legen. */
export function mergeRuntimeConfig(config, settings = {}) {
  const merged = structuredClone(config);
  if (settings.llm_model) merged.llm.model = settings.llm_model;
  if (settings.llm_vision_model) merged.llm.visionModel = settings.llm_vision_model;
  if (settings.llm_web_model) merged.llm.webModel = settings.llm_web_model;
  if (settings.llm_base_url) merged.llm.baseUrl = settings.llm_base_url;
  if (settings.recall_enabled != null) merged.recall.enabled = Boolean(settings.recall_enabled);
  if (Number(settings.recall_interval_days) > 0) merged.recall.intervalDays = Number(settings.recall_interval_days);
  if (Number(settings.recall_items_per_recall) > 0) merged.recall.itemsPerRecall = Number(settings.recall_items_per_recall);
  if (settings.recall_min_item_age_days != null && Number(settings.recall_min_item_age_days) >= 0) {
    merged.recall.minItemAgeDays = Number(settings.recall_min_item_age_days);
  }
  if (settings.recall_max_items != null && Number(settings.recall_max_items) >= 0) {
    merged.recall.maxItems = Number(settings.recall_max_items);
  }
  return merged;
}
