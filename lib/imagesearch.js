// Bildersuche für zusätzliche Fotos.
// Standard ist Wikimedia Commons (schnell, zuverlässig, frei lizenziert, ohne
// API-Key). Alternativ/ergänzend Openverse (IMAGE_SEARCH_PROVIDER=openverse|auto).
// Der Aufruf passiert serverseitig, damit der Browser keine CORS-Probleme hat.

const OPENVERSE_URL = 'https://api.openverse.org/v1/images/';
const WIKIMEDIA_URL = 'https://commons.wikimedia.org/w/api.php';

export class ImageSearchError extends Error {
  constructor(message, { code = 'IMAGE_SEARCH', status = 502, cause } = {}) {
    super(message);
    this.name = 'ImageSearchError';
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

function withTimeout(timeoutMs, fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fn(controller.signal).finally(() => clearTimeout(timer));
}

function stripHtml(value) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function searchOpenverse(query, { limit, timeoutMs, fetchImpl, baseUrl = OPENVERSE_URL }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const url = new URL(baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('page_size', String(Math.min(Math.max(Number(limit) || 12, 1), 20)));
  url.searchParams.set('mature', 'false');

  const response = await withTimeout(timeoutMs, (signal) => doFetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'Storder/1.0 (selfhosted Lagerkatalog)' },
    signal,
  }));
  if (!response.ok) {
    throw new ImageSearchError(`Bildersuche fehlgeschlagen (HTTP ${response.status}).`, { code: 'IMAGE_SEARCH_HTTP' });
  }
  const data = await response.json().catch(() => null);
  return (Array.isArray(data?.results) ? data.results : [])
    .map((r) => ({
      id: String(r.id ?? ''),
      title: stripHtml(r.title).slice(0, 160) || 'Bild',
      thumbnail: r.thumbnail || r.url,
      url: r.url,
      creator: r.creator || null,
      license: r.license || null,
      source: r.source || 'openverse',
      attribution: r.attribution || null,
    }))
    .filter((r) => typeof r.url === 'string' && /^https?:\/\//i.test(r.url));
}

async function searchWikimedia(query, { limit, timeoutMs, fetchImpl }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const url = new URL(WIKIMEDIA_URL);
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('generator', 'search');
  url.searchParams.set('gsrsearch', `filetype:bitmap ${query}`);
  url.searchParams.set('gsrnamespace', '6');
  url.searchParams.set('gsrlimit', String(Math.min(Math.max(Number(limit) || 12, 1), 20)));
  url.searchParams.set('prop', 'imageinfo');
  url.searchParams.set('iiprop', 'url|extmetadata');
  url.searchParams.set('iiurlwidth', '800');

  const response = await withTimeout(timeoutMs, (signal) => doFetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'Storder/1.0 (selfhosted Lagerkatalog)' },
    signal,
  }));
  if (!response.ok) {
    throw new ImageSearchError(`Bildersuche fehlgeschlagen (HTTP ${response.status}).`, { code: 'IMAGE_SEARCH_HTTP' });
  }
  const data = await response.json().catch(() => null);
  const pages = data?.query?.pages ?? {};
  return Object.values(pages)
    .map((page) => {
      const info = page.imageinfo?.[0] ?? {};
      const meta = info.extmetadata ?? {};
      return {
        id: String(page.pageid ?? ''),
        title: stripHtml(String(page.title ?? '').replace(/^File:/i, '').replace(/\.\w+$/, '')).slice(0, 160) || 'Bild',
        // Thumbnail (max. 800 px) reicht: gespeichert wird ohnehin max. 1000 px.
        thumbnail: info.thumburl || info.url,
        url: info.thumburl || info.url,
        creator: stripHtml(meta.Artist?.value).slice(0, 120) || null,
        license: stripHtml(meta.LicenseShortName?.value).slice(0, 60) || null,
        source: 'wikimedia',
        attribution: info.descriptionurl || null,
      };
    })
    .filter((r) => typeof r.url === 'string' && /^https?:\/\//i.test(r.url));
}

function mergeResults(groups, limit) {
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    for (const item of group) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(item);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Sucht frei lizenzierte Bilder.
 * @param {string} query
 * @param {{limit?:number, provider?:'wikimedia'|'openverse'|'auto', openverseUrl?:string, timeoutMs?:number, fetchImpl?:Function}} opts
 */
export async function searchImages(query, opts = {}) {
  const q = String(query ?? '').trim();
  if (q.length < 2) throw new ImageSearchError('Suchbegriff ist zu kurz.', { code: 'IMAGE_QUERY', status: 400 });

  const {
    limit = 12,
    timeoutMs = 12000,
    fetchImpl,
    openverseUrl,
  } = opts;
  // Eine explizite Openverse-URL (z. B. für Tests/andere Instanz) erzwingt Openverse.
  const provider = openverseUrl ? 'openverse' : (opts.provider ?? 'wikimedia');
  const max = Math.min(Math.max(Number(limit) || 12, 1), 20);
  const base = { limit: max, timeoutMs, fetchImpl };

  try {
    if (provider === 'openverse') {
      return await searchOpenverse(q, { ...base, baseUrl: openverseUrl || OPENVERSE_URL });
    }
    if (provider === 'auto') {
      const [wiki, open] = await Promise.allSettled([
        searchWikimedia(q, base),
        searchOpenverse(q, base),
      ]);
      const groups = [wiki, open].map((r) => (r.status === 'fulfilled' ? r.value : []));
      const merged = mergeResults(groups, max);
      if (!merged.length) {
        const reason = wiki.status === 'rejected' ? wiki.reason : open.reason;
        throw reason instanceof Error ? reason : new ImageSearchError('Keine Bilder gefunden.', { status: 404 });
      }
      return merged;
    }
    return await searchWikimedia(q, base);
  } catch (err) {
    if (err instanceof ImageSearchError) throw err;
    if (err?.name === 'AbortError') {
      throw new ImageSearchError('Bildersuche hat zu lange gedauert.', { code: 'IMAGE_SEARCH_TIMEOUT' });
    }
    throw new ImageSearchError(`Bildersuche nicht erreichbar: ${err?.message ?? err}`, { code: 'IMAGE_SEARCH_UNAVAILABLE', cause: err });
  }
}
