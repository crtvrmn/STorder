// Tests für den Paperless-ngx-Client (lib/paperless.js) mit gemocktem fetch.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPaperlessClient,
  buildInvoiceQuery,
  PaperlessError,
  PaperlessNotConfiguredError,
} from '../lib/paperless.js';
import { loadConfig } from '../lib/config.js';

const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

function makeClient({ fetchImpl, url = 'http://192.168.1.50:8000', token = 'secret-token' } = {}) {
  const config = loadConfig({ PAPERLESS_URL: url, PAPERLESS_TOKEN: token, PAPERLESS_RESULTS: '5' });
  const calls = [];
  const fetchMock = fetchImpl ?? (async (target, init) => {
    calls.push({ url: String(target), init });
    if (String(target).includes('/download/')) {
      return new Response(pdfBytes, {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': "attachment; filename=\"Rechnung_Zelt.pdf\"; filename*=UTF-8''Rechnung_Zelt.pdf",
        },
      });
    }
    return new Response(JSON.stringify({
      count: 2,
      results: [
        {
          id: 7,
          title: 'Rechnung Zelt 2023',
          created: '2023-06-02',
          correspondent: { id: 1, name: 'Camping Shop' },
          document_type: { id: 2, name: 'Rechnung' },
          tags: [{ id: 3, name: 'Outdoor' }, 4],
        },
        { id: 8, title: 'Rechnung Zelt 2022', created: '2022-05-01', correspondent: 5, tags: [] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { client: createPaperlessClient(config, { fetchImpl: fetchMock }), calls, config };
}

test('buildInvoiceQuery kombiniert Name, Marke, Jahr und "Rechnung"', () => {
  assert.equal(
    buildInvoiceQuery({ name: 'Zelt', brand: 'Nordcamp', purchase_date: '2023-06-01' }),
    'Zelt Nordcamp 2023 Rechnung',
  );
  assert.equal(buildInvoiceQuery({ name: 'Zelt' }), 'Zelt Rechnung');
  assert.equal(buildInvoiceQuery({ name: 'Zelt', brand: 'Zelt' }), 'Zelt Rechnung');
  assert.equal(buildInvoiceQuery({}), 'Rechnung');
});

test('nicht konfiguriert -> PaperlessNotConfiguredError (503)', async () => {
  const empty = createPaperlessClient(loadConfig({}), { fetchImpl: async () => { throw new Error('darf nicht passieren'); } });
  assert.equal(empty.isConfigured, false);
  await assert.rejects(
    () => empty.searchDocuments({ query: 'Zelt' }),
    (err) => err instanceof PaperlessNotConfiguredError && err.status === 503 && /PAPERLESS_URL/.test(err.message),
  );
});

test('Suche: URL, Token-Header und Normalisierung', async () => {
  const { client, calls } = makeClient();
  assert.equal(client.isConfigured, true);
  const results = await client.searchDocuments({ query: 'Zelt Nordcamp 2023' });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/documents/');
  assert.equal(url.searchParams.get('query'), 'Zelt Nordcamp 2023');
  assert.equal(url.searchParams.get('page_size'), '5');
  assert.equal(url.searchParams.get('ordering'), '-created');
  assert.equal(calls[0].init.headers.Authorization, 'Token secret-token');

  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    id: 7,
    title: 'Rechnung Zelt 2023',
    created: '2023-06-02',
    added: null,
    correspondent: 'Camping Shop',
    document_type: 'Rechnung',
    tags: ['Outdoor'],
  });
  // numerische Referenzen werden toleriert
  assert.equal(results[1].correspondent, null);
  assert.deepEqual(results[1].tags, []);
});

test('Download: Buffer, Content-Type und Dateiname aus Content-Disposition', async () => {
  const { client, calls } = makeClient();
  const doc = await client.downloadDocument(7);
  assert.equal(calls[0].url, 'http://192.168.1.50:8000/api/documents/7/download/');
  assert.equal(doc.contentType, 'application/pdf');
  assert.equal(doc.filename, 'Rechnung_Zelt.pdf');
  assert.equal(doc.buffer.length, pdfBytes.length);
});

test('HTTP-Fehler werden übersetzt', async () => {
  const cases = [
    [401, 'PAPERLESS_AUTH', 502],
    [403, 'PAPERLESS_AUTH', 502],
    [404, 'PAPERLESS_NOT_FOUND', 404],
    [500, 'PAPERLESS_ERROR', 502],
  ];
  for (const [status, code, mappedStatus] of cases) {
    const { client } = makeClient({
      fetchImpl: async () => new Response('{}', { status, headers: { 'content-type': 'application/json' } }),
    });
    await assert.rejects(
      () => client.searchDocuments({ query: 'x' }),
      (err) => err instanceof PaperlessError && err.code === code && err.status === mappedStatus,
      `Status ${status}`,
    );
  }
});

test('Zeitüberschreitung und Nichterreichbarkeit', async () => {
  const timeout = makeClient({
    fetchImpl: async () => { const err = new Error('timeout'); err.name = 'TimeoutError'; throw err; },
  });
  await assert.rejects(
    () => timeout.client.searchDocuments({ query: 'x' }),
    (err) => err.code === 'PAPERLESS_TIMEOUT',
  );

  const unreachable = makeClient({
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  await assert.rejects(
    () => unreachable.client.searchDocuments({ query: 'x' }),
    (err) => err.code === 'PAPERLESS_UNREACHABLE' && /nicht erreichbar/.test(err.message),
  );
});

test('Suchlimit wird begrenzt (1..25)', async () => {
  const { client, calls } = makeClient();
  await client.searchDocuments({ query: 'x', limit: 100 });
  assert.equal(new URL(calls[0].url).searchParams.get('page_size'), '25');
  await client.searchDocuments({ query: 'x', limit: 0 });
  assert.equal(new URL(calls[1].url).searchParams.get('page_size'), '5'); // Default aus Config
});

/* --------------------- Login mit Benutzername/Passwort ------------------- */

function loginClient({ password = 'geheim', tokenResult = 'login-token-123', failLogin = null } = {}) {
  const calls = [];
  const config = loadConfig({
    PAPERLESS_URL: 'http://192.168.1.50:8000',
    PAPERLESS_USERNAME: 'storder',
    PAPERLESS_PASSWORD: password,
  });
  const fetchMock = async (target, init) => {
    calls.push({ url: String(target), init });
    if (String(target).endsWith('/api/token/')) {
      if (failLogin) return new Response('{}', { status: failLogin, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ token: tokenResult }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (String(target).includes('/api/documents/7/download/')) {
      return new Response(pdfBytes, { status: 200, headers: { 'content-type': 'application/pdf' } });
    }
    // ohne gültigen Login-Token -> 401
    const auth = init.headers.Authorization;
    if (auth !== `Token ${tokenResult}`) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ count: 0, results: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  return { client: createPaperlessClient(config, { fetchImpl: fetchMock }), calls, config };
}

test('ohne Token: Login über /api/token/ und Nutzung des Tokens', async () => {
  const { client, calls } = loginClient({ tokenResult: 'login-token-123' });
  assert.equal(client.isConfigured, true);
  assert.equal(client.authMode, 'login');

  const results = await client.searchDocuments({ query: 'Zelt' });
  assert.deepEqual(results, []);

  const loginCall = calls.find((c) => c.url.endsWith('/api/token/'));
  assert.ok(loginCall, 'Login-Aufruf fehlt');
  assert.equal(loginCall.init.method, 'POST');
  assert.deepEqual(JSON.parse(loginCall.init.body), { username: 'storder', password: 'geheim' });

  const docCall = calls.find((c) => c.url.includes('/api/documents/?'));
  assert.equal(docCall.init.headers.Authorization, 'Token login-token-123');

  // Token wird gecacht: zweite Suche ohne erneuten Login
  await client.searchDocuments({ query: 'Zelt 2' });
  assert.equal(calls.filter((c) => c.url.endsWith('/api/token/')).length, 1);
});

test('falsche Zugangsdaten -> klare Fehlermeldung', async () => {
  const { client } = loginClient({ failLogin: 400 });
  await assert.rejects(
    () => client.searchDocuments({ query: 'x' }),
    (err) => err.code === 'PAPERLESS_AUTH' && /PAPERLESS_USERNAME/.test(err.message),
  );
});

test('abgelehnter Token im Login-Modus: einmal neu einloggen und wiederholen', async () => {
  let tokenRequests = 0;
  const config = loadConfig({
    PAPERLESS_URL: 'http://paperless.local:8000',
    PAPERLESS_USERNAME: 'u',
    PAPERLESS_PASSWORD: 'p',
  });
  const calls = [];
  const fetchMock = async (target, init) => {
    calls.push(String(target));
    if (String(target).endsWith('/api/token/')) {
      tokenRequests++;
      return new Response(JSON.stringify({ token: `token-${tokenRequests}` }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    // nur der zweite Token ist gültig -> erster Dokument-Aufruf 401
    const auth = init.headers.Authorization;
    if (auth === 'Token token-2') {
      return new Response(JSON.stringify({ count: 0, results: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 401 });
  };
  const client = createPaperlessClient(config, { fetchImpl: fetchMock });
  const results = await client.searchDocuments({ query: 'x' });
  assert.deepEqual(results, []);
  assert.equal(tokenRequests, 2);
  assert.equal(calls.filter((u) => u.includes('/api/documents/')).length, 2);
});

test('Login-Endpunkt fehlt (404) -> verständlicher Fehler', async () => {
  const { client } = loginClient({ failLogin: 404 });
  await assert.rejects(
    () => client.searchDocuments({ query: 'x' }),
    (err) => err.code === 'PAPERLESS_ERROR' && /Login nicht möglich/.test(err.message),
  );
});

test('Token-Modus ruft keinen Login auf', async () => {
  const { client, calls } = makeClient({ url: 'http://paperless.local:8000', token: 'fest' });
  assert.equal(client.authMode, 'token');
  await client.searchDocuments({ query: 'x' });
  assert.equal(calls.filter((c) => String(c.url).includes('/api/token/')).length, 0);
});
