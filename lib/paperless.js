// Paperless-ngx-Client (lokales Netz): Rechnungen zu einem Gegenstand suchen
// und herunterladen. Nur Lesezugriff über die offizielle REST-API.
//
// Benötigt PAPERLESS_URL (z. B. http://192.168.1.50:8000) und PAPERLESS_TOKEN
// (Paperless -> Einstellungen -> API-Token). Kein Schreibzugriff, kein Upload
// in Paperless – Paperless bleibt die Quelle der Wahrheit.

export class PaperlessNotConfiguredError extends Error {
  constructor() {
    super('Paperless ist nicht konfiguriert (PAPERLESS_URL und PAPERLESS_TOKEN oder PAPERLESS_USERNAME/PAPERLESS_PASSWORD setzen).');
    this.code = 'PAPERLESS_NOT_CONFIGURED';
    this.status = 503;
  }
}

export class PaperlessError extends Error {
  constructor(message, { code = 'PAPERLESS_ERROR', status = 502, cause } = {}) {
    super(message, { cause });
    this.code = code;
    this.status = status;
  }
}

/** Sucht die Rechnung zu einem Gegenstand (Titel, Marke, Jahr …). */
export function buildInvoiceQuery({ name, brand, purchase_date, category } = {}) {
  const parts = [name, brand, category].map((v) => String(v ?? '').trim()).filter(Boolean);
  const year = String(purchase_date ?? '').match(/^(\d{4})/)?.[1];
  // Rechnung/Dokument als Suchwort hilft Paperless beim Einschränken.
  const words = [...new Set(parts)].join(' ');
  return [words, year, 'Rechnung'].filter(Boolean).join(' ').trim();
}

function parseFilename(disposition, fallback) {
  if (!disposition) return fallback;
  const star = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try { return decodeURIComponent(star[1]).replace(/^"|"$/g, '').trim() || fallback; } catch { /* egal */ }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() || fallback : fallback;
}

export function createPaperlessClient(config = {}, { fetchImpl } = {}) {
  const cfg = config.paperless ?? config;
  const base = String(cfg.url ?? '').replace(/\/+$/, '');
  const staticToken = String(cfg.token ?? '');
  const username = String(cfg.username ?? '');
  const password = String(cfg.password ?? '');
  const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 15000;
  const fetchFn = fetchImpl ?? globalThis.fetch;

  const canLogin = Boolean(base && username && password);
  const isConfigured = Boolean(base && (staticToken || canLogin));
  // 'token' = fester API-Token, 'login' = Token wird per Benutzername/Passwort geholt
  const authMode = staticToken ? 'token' : (canLogin ? 'login' : null);

  let cachedToken = staticToken;
  let loginPromise = null;

  function ensureConfigured() {
    if (!isConfigured) throw new PaperlessNotConfiguredError();
  }

  async function login() {
    let response;
    try {
      response = await fetchFn(`${base}/api/token/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new PaperlessError('Paperless antwortet nicht (Zeitüberschreitung).', { code: 'PAPERLESS_TIMEOUT', cause: err });
      }
      throw new PaperlessError(`Paperless nicht erreichbar: ${err.message}`, { code: 'PAPERLESS_UNREACHABLE', cause: err });
    }
    if (response.status === 400 || response.status === 401) {
      throw new PaperlessError('Paperless-Login fehlgeschlagen – PAPERLESS_USERNAME/PAPERLESS_PASSWORD prüfen.', {
        code: 'PAPERLESS_AUTH', status: 502,
      });
    }
    if (!response.ok) {
      throw new PaperlessError(`Paperless-Login nicht möglich (HTTP ${response.status}).`, { code: 'PAPERLESS_ERROR' });
    }
    const data = await response.json().catch(() => null);
    if (!data?.token) {
      throw new PaperlessError('Paperless hat keinen API-Token geliefert.', { code: 'PAPERLESS_AUTH', status: 502 });
    }
    cachedToken = String(data.token);
    return cachedToken;
  }

  /** Token holen: fest konfiguriert oder einmalig per Login (mit Cache). */
  function getToken() {
    if (cachedToken) return Promise.resolve(cachedToken);
    if (!canLogin) throw new PaperlessNotConfiguredError();
    if (!loginPromise) {
      loginPromise = login().finally(() => { loginPromise = null; });
    }
    return loginPromise;
  }

  async function request(path, { retried = false } = {}) {
    ensureConfigured();
    const token = await getToken();
    let response;
    try {
      response = await fetchFn(`${base}${path}`, {
        headers: {
          Authorization: `Token ${token}`,
          Accept: 'application/json, application/pdf, */*',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new PaperlessError('Paperless antwortet nicht (Zeitüberschreitung).', { code: 'PAPERLESS_TIMEOUT', cause: err });
      }
      throw new PaperlessError(`Paperless nicht erreichbar: ${err.message}`, { code: 'PAPERLESS_UNREACHABLE', cause: err });
    }
    if (response.status === 401 || response.status === 403) {
      // Im Login-Modus kann der Token abgelaufen/neu erzeugt sein -> einmal neu holen.
      if (!retried && authMode === 'login') {
        cachedToken = '';
        return request(path, { retried: true });
      }
      throw new PaperlessError(
        authMode === 'login'
          ? 'Paperless hat den Login abgelehnt (PAPERLESS_USERNAME/PAPERLESS_PASSWORD prüfen).'
          : 'Paperless hat den API-Token abgelehnt (PAPERLESS_TOKEN prüfen).',
        { code: 'PAPERLESS_AUTH', status: 502 },
      );
    }
    if (response.status === 404) {
      throw new PaperlessError('In Paperless nicht gefunden.', { code: 'PAPERLESS_NOT_FOUND', status: 404 });
    }
    if (!response.ok) {
      throw new PaperlessError(`Paperless-Fehler (HTTP ${response.status}).`, { code: 'PAPERLESS_ERROR' });
    }
    return response;
  }

  /**
   * Volltextsuche in Paperless.
   * @returns {Promise<Array<{id,title,created,correspondent,tags}>>}
   */
  async function searchDocuments({ query, limit } = {}) {
    const count = Math.min(Math.max(Number(limit) || Number(cfg.results) || 8, 1), 25);
    const params = new URLSearchParams({
      query: String(query ?? '').trim(),
      page_size: String(count),
      ordering: '-created',
    });
    const response = await request(`/api/documents/?${params}`);
    const data = await response.json().catch(() => null);
    const results = Array.isArray(data?.results) ? data.results : [];
    return results.slice(0, count).map((doc) => ({
      id: doc.id,
      title: doc.title ?? `Dokument ${doc.id}`,
      created: doc.created ?? null,
      added: doc.added ?? null,
      correspondent: typeof doc.correspondent === 'object'
        ? doc.correspondent?.name ?? null
        : null,
      document_type: typeof doc.document_type === 'object'
        ? doc.document_type?.name ?? null
        : null,
      tags: Array.isArray(doc.tags)
        // Paperless liefert normalerweise Objekte; reine IDs sind nicht auflösbar.
        ? doc.tags.map((t) => (typeof t === 'object' ? t?.name : (typeof t === 'string' ? t : null))).filter(Boolean)
        : [],
    }));
  }

  /** Lädt das Originaldokument (PDF/Bild) herunter. */
  async function downloadDocument(id) {
    const response = await request(`/api/documents/${Number(id)}/download/`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    const filename = parseFilename(response.headers.get('content-disposition'), `paperless-${id}`);
    return { buffer, contentType, filename };
  }

  return {
    isConfigured,
    authMode,
    config: { url: base, results: Number(cfg.results) || 8, auth: authMode },
    searchDocuments,
    downloadDocument,
  };
}
