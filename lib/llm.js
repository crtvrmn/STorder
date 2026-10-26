// KI-Anbindung über jeden OpenAI-kompatiblen Endpunkt (Default: OpenRouter).
// Zwei Aufrufe:
//  1. Vision: Foto -> Identifikation + Maße/Gewicht (aus Bild, ggf. Websuche)
//  2. Web:    Produkt identifizieren -> Beschreibung + offizielle Maße/Gewicht
//             aus dem Internet (OpenRouter-Plugin "web" = echte Websuche)
// Beide werden in analyzeImage() zusammengeführt. Robust gegen ungenaues JSON.

import OpenAI from 'openai';
import { z } from './validate.js';
import { toCm, toGrams } from './geometry.js';

const IDENTIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    identified: { type: 'boolean' },
    title: { type: 'string' },
    description: { type: 'string' },
    category: { type: 'string' },
    brand: { type: 'string' },
    model: { type: 'string' },
    color: { type: 'string' },
    material: { type: 'string' },
    barcode: { type: 'string' },
    quantity: { type: 'integer' },
    search_query: { type: 'string' },
    dimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        length_cm: { type: ['number', 'null'] },
        width_cm: { type: ['number', 'null'] },
        height_cm: { type: ['number', 'null'] },
        note: { type: 'string' },
      },
      required: ['length_cm', 'width_cm', 'height_cm'],
    },
    weight_g: { type: ['number', 'null'] },
    shape: { type: 'string', enum: ['cuboid', 'box', 'cylinder', 'bottle', 'sphere', 'irregular', 'bag', 'other'] },
    condition: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string' },
  },
  required: ['identified', 'title', 'description', 'category', 'search_query', 'shape', 'tags', 'confidence'],
};

const PRODUCT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    found: { type: 'boolean' },
    title: { type: 'string' },
    brand: { type: 'string' },
    model: { type: 'string' },
    product_url: { type: 'string' },
    description: { type: 'string' },
    dimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        length_cm: { type: ['number', 'null'] },
        width_cm: { type: ['number', 'null'] },
        height_cm: { type: ['number', 'null'] },
        note: { type: 'string' },
      },
      required: ['length_cm', 'width_cm', 'height_cm'],
    },
    weight_g: { type: ['number', 'null'] },
    material: { type: 'string' },
    barcode: { type: 'string' },
    source_urls: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string' },
  },
  required: ['found', 'title', 'description', 'source_urls', 'confidence'],
};

const VISION_PROMPT = `Du bist ein präziser Assistent für ein privates Lager (Kisten im Regal).
Analysiere das Foto eines Gegenstands und identifiziere ihn so genau wie möglich.

Regeln:
- Nenne Marke/Modell nur, wenn du sie wirklich am Objekt erkennst (Typenschild, Logo, Schriftzug).
- Maße/Gewicht: Schätze nur, wenn du das Produkt sicher kennst. Sonst null und im Feld "note" kurz erklären. KEINE erfundenen Zahlen.
- "search_query": kurze, gute Suchanfrage, mit der man das Produkt im Internet findet (Marke + Modell + Variante, z.B. "Bosch GSR 12V-15 Akkuschrauber").
- "shape": grobe Form für die Volumenschätzung (cuboid = Quader/Karton, cylinder = Zylinder/Dose, bottle = Flasche, sphere = rund, bag = Beutel/Softbag, irregular = Werkzeug/Kabel/ungerade).
- "quantity": sichtbare Stückzahl (meist 1).
- "barcode": nur, wenn ein Barcode lesbar ist, sonst "".
- Sprache: Deutsch. Antworte ausschließlich mit JSON nach Schema.`;

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    issues: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          item_id: { type: 'integer' },
          type: { type: 'string', enum: ['dimensions', 'weight', 'description'] },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          message: { type: 'string' },
          suggested: {
            type: 'object',
            additionalProperties: false,
            properties: {
              // Bewusst keine Union-Typen (["number","null"]): die lehnen
              // manche Provider ab. Nicht benötigte Felder werden weggelassen.
              length_cm: { type: 'number' },
              width_cm: { type: 'number' },
              height_cm: { type: 'number' },
              weight_g: { type: 'number' },
              description: { type: 'string' },
            },
          },
        },
        required: ['item_id', 'type', 'message'],
      },
    },
  },
  required: ['issues'],
};

const REVIEW_PROMPT = `Du prüfst die Datenqualität eines privaten Lagerkatalogs (Haushalt, Werkstatt, Keller).
Du bekommst eine Liste von Gegenständen mit Maßen (cm), Gewicht (g), Kategorie und Beschreibung.

Finde NUR klare, offensichtliche Fehler:
- Maße, die für den Gegenstand unplausibel sind (z. B. USB-Kabel 40 cm hoch, Toaster 2 cm lang).
- Gewichte, die unplausibel sind (z. B. Kaffeetasse 5 kg, Kabel 0 g/2 kg).
- Beschreibungen, die leer, abgeschnitten, widersprüchlich oder unverständlich sind.

Regeln:
- Schlage konkrete, realistische Werte vor (Maße in cm, Gewicht in g, Beschreibung auf Deutsch, 1–3 Sätze).
- Wenn du unsicher bist, lass den Gegenstand weg. Lieber wenige sichere Treffer.
- Erfinde keine Gegenstände; nutze ausschließlich die gelieferten item_id-Werte.
- Keine Vorschläge zum Umräumen oder zu Duplikaten (das macht die App selbst).
- Antworte ausschließlich mit JSON nach Schema.`;

const PRODUCT_PROMPT = `Du hilfst bei einem privaten Lagerkatalog. Suche im Internet nach dem Produkt
und liefere eine kurze Produktbeschreibung sowie die echten Maße und das Gewicht
(Produktmaße, NICHT Verpackungsmaße – falls nur Verpackungsmaße auffindbar sind, das in "notes" schreiben).

Regeln:
- Rechne alle Maße in cm um (DIN-Reihenfolge Länge × Breite × Höhe) und das Gewicht in Gramm. Nur Zahlen, keine Einheiten.
- Bevorzuge Herstellerseite oder große Shops. Trage 1–3 Quellen-URLs ein, die du tatsächlich gesehen hast.
- Wenn das Produkt nicht gefunden wurde: found=false, title = beste Beschreibung, Maße null.
- confidence: high = Maße direkt aus Datenblatt, medium = plausible Schätzwerte, low = unsicher.
- Sprache: Deutsch. Antworte ausschließlich mit JSON nach Schema.`;

export class LlmNotConfiguredError extends Error {
  constructor() {
    super('Kein LLM_API_KEY konfiguriert. Bitte in .env setzen (z.B. OpenRouter-Key).');
    this.code = 'LLM_NOT_CONFIGURED';
    this.status = 503;
  }
}

export class LlmError extends Error {
  constructor(message, { code = 'LLM_ERROR', status = 502, cause } = {}) {
    super(message, { cause });
    this.code = code;
    this.status = status;
  }
}

export function createLlmClient(config, { fetchImpl } = {}) {
  const cfg = config.llm;

  const makeClient = (headers = {}) =>
    new OpenAI({
      apiKey: cfg.apiKey || 'unconfigured',
      baseURL: cfg.baseUrl,
      timeout: cfg.timeoutMs,
      maxRetries: 1,
      defaultHeaders: headers,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });

  // HTTP-Header sind ByteStrings (nur Latin-1). Titel/Referer können aber
  // beliebigen Text aus der Konfiguration enthalten -> defensiv säubern.
  const headerSafe = (value) => String(value ?? '').replace(/[^\x20-\x7E]/g, '-').slice(0, 200);
  const orHeaders = cfg.baseUrl.includes('openrouter')
    ? { 'HTTP-Referer': headerSafe(cfg.appReferer), 'X-Title': headerSafe(cfg.appTitle) }
    : {};

  async function chatJson({ model, messages, schema, plugins, maxTokens = 2000 }) {
    if (!cfg.apiKey) throw new LlmNotConfiguredError();
    const client = makeClient(orHeaders);
    let response;
    try {
      const params = {
        model,
        messages,
        temperature: cfg.temperature,
        max_tokens: maxTokens,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'result', strict: false, schema },
        },
      };
      if (plugins?.length) params.plugins = plugins;
      response = await client.chat.completions.create(params);
    } catch (err) {
      // Manche Modelle/Provider unterstützen json_schema nicht -> Fallback auf json_object.
      if (isSchemaUnsupported(err)) {
        try {
          response = await client.chat.completions.create({
            model,
            messages,
            temperature: cfg.temperature,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' },
            ...(plugins?.length ? { plugins } : {}),
          });
        } catch (err2) {
          throw toLlmError(err2);
        }
      } else {
        throw toLlmError(err);
      }
    }
    const choice = response?.choices?.[0];
    const text = choice?.message?.content;
    const annotations = choice?.message?.annotations ?? [];
    const citations = extractCitations(annotations, response);
    const data = parseJson(text);
    if (!data) throw new LlmError('Das Modell hat kein gültiges JSON geliefert.', { code: 'LLM_BAD_JSON' });
    return { data, citations, raw: text, usage: response?.usage ?? null, model: response?.model ?? model };
  }

  function webPlugin() {
    if (cfg.webSearch === false) return [];
    return [{ id: 'web', max_results: cfg.webResults, search_prompt: 'Suche nach Hersteller-Datenblatt, Maßen, Gewicht und Produktbeschreibung. Nutze seriöse Quellen.' }];
  }

  /** 1) Foto analysieren (Vision). */
  async function analyzePhoto({ imageDataUrl, hint, model }) {
    const userText = [
      hint ? `Hinweis der Nutzerin/des Nutzers: ${hint}` : null,
      'Identifiziere den Gegenstand auf dem Foto.',
    ].filter(Boolean).join('\n');
    const result = await chatJson({
      model: model || cfg.visionModel,
      schema: IDENTIFY_SCHEMA,
      maxTokens: 2500,
      messages: [
        { role: 'system', content: VISION_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } },
          ],
        },
      ],
    });
    return normalizeVision(result);
  }

  /** 2) Produkt im Internet nachschlagen (optional Websuche). */
  async function lookupProduct({ title, brand, model, barcode, hint, model: modelOverride }) {
    const q = [brand, title, model].filter(Boolean).join(' ').trim() || title || hint || 'Produkt';
    const userText = [
      `Produkt: ${q}`,
      barcode ? `Barcode: ${barcode}` : null,
      hint ? `Hinweis: ${hint}` : null,
      'Bitte Produktbeschreibung, Maße und Gewicht nachschlagen.',
    ].filter(Boolean).join('\n');
    const result = await chatJson({
      model: modelOverride || cfg.webModel,
      schema: PRODUCT_SCHEMA,
      maxTokens: 2500,
      plugins: webPlugin(),
      messages: [
        { role: 'system', content: PRODUCT_PROMPT },
        { role: 'user', content: userText },
      ],
    });
    return normalizeProduct(result);
  }

  /** Datenqualität prüfen (Maße/Gewicht/Beschreibung). */
  async function reviewInventory({ items, model: modelOverride } = {}) {
    const compact = (items ?? []).slice(0, 150).map((it) => ({
      item_id: it.id,
      name: it.name,
      category: it.category || null,
      description: String(it.description ?? '').slice(0, 400),
      length_cm: it.dims_cm?.length_cm ?? null,
      width_cm: it.dims_cm?.width_cm ?? null,
      height_cm: it.dims_cm?.height_cm ?? null,
      weight_g: it.weight_g ?? null,
      bin: it.bin?.code ?? null,
    }));
    const result = await chatJson({
      model: modelOverride || cfg.model,
      schema: REVIEW_SCHEMA,
      maxTokens: 3500,
      messages: [
        { role: 'system', content: REVIEW_PROMPT },
        { role: 'user', content: JSON.stringify({ items: compact }) },
      ],
    });
    return normalizeReview(result);
  }

  return { analyzePhoto, lookupProduct, reviewInventory, isConfigured: Boolean(cfg.apiKey), config: cfg };
}

function normalizeVision({ data, citations, usage, model }) {
  const d = data ?? {};
  const dims = d.dimensions ?? {};
  return {
    identified: d.identified !== false,
    title: z.str(d.title, 'Unbekannter Gegenstand'),
    description: z.str(d.description, ''),
    category: z.str(d.category, 'Sonstiges'),
    brand: z.str(d.brand, ''),
    model: z.str(d.model, ''),
    color: z.str(d.color, ''),
    material: z.str(d.material, ''),
    barcode: z.str(d.barcode, ''),
    quantity: z.int(d.quantity, 1, 1, 999),
    search_query: z.str(d.search_query, ''),
    dimensions: {
      length_cm: toCm(dims.length_cm),
      width_cm: toCm(dims.width_cm),
      height_cm: toCm(dims.height_cm),
      note: z.str(dims.note, ''),
    },
    weight_g: toGrams(d.weight_g),
    shape: z.str(d.shape, 'irregular'),
    condition: z.str(d.condition, ''),
    tags: z.strArray(d.tags, 12),
    confidence: ['high', 'medium', 'low'].includes(d.confidence) ? d.confidence : 'low',
    notes: z.str(d.notes, ''),
    citations,
    model,
    usage,
  };
}

function normalizeProduct({ data, citations, usage, model }) {
  const d = data ?? {};
  const dims = d.dimensions ?? {};
  const urls = [...z.strArray(d.source_urls, 5), ...citations.map((c) => c.url)].filter(Boolean);
  return {
    found: d.found === true,
    title: z.str(d.title, ''),
    brand: z.str(d.brand, ''),
    model: z.str(d.model, ''),
    product_url: z.str(d.product_url, ''),
    description: z.str(d.description, ''),
    dimensions: {
      length_cm: toCm(dims.length_cm),
      width_cm: toCm(dims.width_cm),
      height_cm: toCm(dims.height_cm),
      note: z.str(dims.note, ''),
    },
    weight_g: toGrams(d.weight_g),
    material: z.str(d.material, ''),
    barcode: z.str(d.barcode, ''),
    source_urls: [...new Set(urls)].slice(0, 6),
    confidence: ['high', 'medium', 'low'].includes(d.confidence) ? d.confidence : 'low',
    notes: z.str(d.notes, ''),
    citations,
    model,
    usage,
  };
}

/** Normalisiert die KI-Prüfung; ungültige IDs/Werte werden verworfen. */
export function normalizeReview({ data } = {}) {
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  return issues
    .slice(0, 40)
    .map((raw) => {
      const type = ['dimensions', 'weight', 'description'].includes(raw?.type) ? raw.type : null;
      const itemId = Number(raw?.item_id);
      if (!type || !Number.isInteger(itemId) || itemId <= 0) return null;
      const suggested = raw?.suggested ?? {};
      return {
        item_id: itemId,
        type,
        severity: ['low', 'medium', 'high'].includes(raw?.severity) ? raw.severity : 'medium',
        message: z.str(raw?.message).slice(0, 300),
        suggested: {
          length_cm: toCm(suggested.length_cm),
          width_cm: toCm(suggested.width_cm),
          height_cm: toCm(suggested.height_cm),
          weight_g: toGrams(suggested.weight_g),
          description: z.str(suggested.description).slice(0, 1200),
        },
      };
    })
    .filter(Boolean)
    .filter((issue) => {
      // Nur Vorschläge behalten, die auch anwendbar sind.
      if (issue.type === 'dimensions') {
        return Boolean(issue.suggested.length_cm && issue.suggested.width_cm && issue.suggested.height_cm);
      }
      if (issue.type === 'weight') return Boolean(issue.suggested.weight_g);
      return Boolean(issue.suggested.description);
    });
}

export function parseJson(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractCitations(annotations, response) {
  const out = [];
  for (const a of annotations ?? []) {
    const c = a?.url_citation;
    if (c?.url) out.push({ url: c.url, title: c.title ?? '' });
  }
  // OpenRouter legt Web-Suchergebnisse teils auch in message.citations ab.
  const extra = response?.choices?.[0]?.message?.citations;
  if (Array.isArray(extra)) {
    for (const c of extra) {
      const url = typeof c === 'string' ? c : c?.url;
      if (url) out.push({ url, title: typeof c === 'string' ? '' : c?.title ?? '' });
    }
  }
  const seen = new Set();
  return out.filter((c) => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  }).slice(0, 6);
}

function isSchemaUnsupported(err) {
  const msg = String(err?.message ?? '');
  const providerRaw = String(err?.error?.metadata?.raw ?? '');
  const status = err?.status ?? err?.statusCode;
  if (status !== 400) return false;
  // Manche Provider melden Schema-/Formatprobleme nur als "Provider returned error".
  return /response_format|json_schema|structured|responseFormat|provider returned error/i.test(`${msg} ${providerRaw}`);
}

function toLlmError(err) {
  if (err instanceof LlmNotConfiguredError || err instanceof LlmError) return err;
  const status = err?.status ?? err?.statusCode;
  const providerDetail = err?.error?.metadata?.raw
    || err?.error?.metadata?.provider_error
    || err?.error?.metadata?.provider_name
    || null;
  const baseMsg = err?.message ?? String(err);
  const msg = providerDetail ? `${baseMsg} (${String(providerDetail).slice(0, 300)})` : baseMsg;
  if (status === 401 || status === 403) {
    return new LlmError(`LLM-API-Key abgelehnt (HTTP ${status}). Prüfe LLM_API_KEY.`, { code: 'LLM_AUTH', status: 502, cause: err });
  }
  if (status === 429) {
    return new LlmError('LLM-Anbieter: Rate-Limit erreicht. Bitte später erneut versuchen.', { code: 'LLM_RATE_LIMIT', status: 502, cause: err });
  }
  if (status === 402) {
    return new LlmError('LLM-Anbieter: Guthaben aufgebraucht.', { code: 'LLM_PAYMENT', status: 502, cause: err });
  }
  return new LlmError(`LLM-Aufruf fehlgeschlagen: ${msg}`, { code: 'LLM_ERROR', status: 502, cause: err });
}
