// Tests für den LLM-Client (lib/llm.js) mit gemocktem fetch.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../lib/config.js';
import { createLlmClient, parseJson, LlmError, LlmNotConfiguredError } from '../lib/llm.js';

const completion = (content) => new Response(JSON.stringify({
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1,
  model: 'test/model',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: JSON.stringify(content) },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
}), { status: 200, headers: { 'content-type': 'application/json' } });

function client({ appTitle = 'Storder – Lagerkatalog', body = {}, status = 200, env = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { message: 'nope', code: status } }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return completion(body);
  };
  const config = loadConfig({
    LLM_API_KEY: 'test-key',
    LLM_BASE_URL: 'https://openrouter.ai/api/v1',
    LLM_APP_TITLE: appTitle,
    ...env,
  });
  return { llm: createLlmClient(config, { fetchImpl }), calls, config };
}

test('Header werden ASCII-sicher gesendet (kein ByteString-Fehler)', async () => {
  const { llm, calls } = client({ body: { identified: true, title: 'Toaster', confidence: 'high' } });
  const result = await llm.analyzePhoto({ imageDataUrl: 'data:image/jpeg;base64,AAAA' });
  assert.equal(result.title, 'Toaster');
  assert.equal(calls.length, 1);
  const headers = new Headers(calls[0].init.headers);
  const title = headers.get('x-title');
  assert.ok(title, 'X-Title fehlt');
  assert.match(title, /^[\x20-\x7E]+$/, `X-Title enthält Nicht-ASCII: ${JSON.stringify(title)}`);
  assert.match(headers.get('http-referer') ?? '', /^[\x20-\x7E]*$/);
});

test('Vision-Antwort wird normalisiert (Maße, Gewicht, Form, Confidence)', async () => {
  const { llm } = client({
    body: {
      identified: true,
      title: 'Toaster',
      description: 'Zwei Schlitze',
      brand: 'Müller',
      dimensions: { length_cm: '30 cm', width_cm: 20, height_cm: '2 dm' },
      weight_g: '1,5 kg',
      shape: 'cuboid',
      confidence: 'medium',
      tags: ['Küche', 'Elektro'],
    },
  });
  const v = await llm.analyzePhoto({ imageDataUrl: 'data:image/jpeg;base64,AAAA' });
  assert.equal(v.dimensions.length_cm, 30);
  assert.equal(v.dimensions.height_cm, 20); // 2 dm = 20 cm
  assert.equal(v.weight_g, 1500);
  assert.equal(v.shape, 'cuboid');
  assert.equal(v.confidence, 'medium');
  assert.deepEqual(v.tags, ['Küche', 'Elektro']);
  assert.equal(v.identified, true);
});

test('Websuche-Plugin wird bei aktivierter Suche mitgeschickt', async () => {
  const { llm, calls } = client({ body: { found: false } });
  await llm.lookupProduct({ title: 'Toaster' });
  const payload = JSON.parse(calls[0].init.body);
  assert.deepEqual(payload.plugins, [{
    id: 'web',
    max_results: 4,
    search_prompt: 'Suche nach Hersteller-Datenblatt, Maßen, Gewicht und Produktbeschreibung. Nutze seriöse Quellen.',
  }]);

  const off = client({ body: { found: false }, env: { LLM_WEB_SEARCH: 'false' } });
  await off.llm.lookupProduct({ title: 'Toaster' });
  assert.equal(JSON.parse(off.calls[0].init.body).plugins, undefined);
});

test('Produkt-Antwort wird normalisiert inkl. Quellen-Deduplizierung', async () => {
  const { llm } = client({
    body: {
      found: true,
      title: 'Müller TM-200',
      description: 'Doppeltoaster',
      dimensions: { length_cm: 31, width_cm: 21, height_cm: 21 },
      weight_g: 1700,
      source_urls: ['https://a.example', 'https://a.example', 'https://b.example'],
      confidence: 'high',
    },
  });
  const p = await llm.lookupProduct({ title: 'Toaster' });
  assert.equal(p.found, true);
  assert.equal(p.title, 'Müller TM-200');
  assert.deepEqual(p.source_urls, ['https://a.example', 'https://b.example']);
  assert.equal(p.dimensions.length_cm, 31);
});

test('401 wird zu LlmError LLM_AUTH', async () => {
  const { llm } = client({ status: 401 });
  await assert.rejects(
    () => llm.analyzePhoto({ imageDataUrl: 'data:image/jpeg;base64,AAAA' }),
    (err) => err instanceof LlmError && err.code === 'LLM_AUTH' && err.status === 502 && /API-Key/.test(err.message),
  );
});

test('429 wird zu LlmError LLM_RATE_LIMIT', async () => {
  const { llm } = client({ status: 429 });
  await assert.rejects(
    () => llm.analyzePhoto({ imageDataUrl: 'x' }),
    (err) => err.code === 'LLM_RATE_LIMIT',
  );
});

test('ohne API-Key: LlmNotConfiguredError', async () => {
  const config = loadConfig({ LLM_API_KEY: '', OPENROUTER_API_KEY: '' });
  const llm = createLlmClient(config, { fetchImpl: async () => { throw new Error('darf nicht aufgerufen werden'); } });
  assert.equal(llm.isConfigured, false);
  await assert.rejects(
    () => llm.analyzePhoto({ imageDataUrl: 'x' }),
    (err) => err instanceof LlmNotConfiguredError && err.status === 503,
  );
});

test('parseJson akzeptiert Code-Fences und kaputtes JSON', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.equal(parseJson('kein json'), null);
  assert.equal(parseJson(''), null);
  assert.equal(parseJson(null), null);
});
