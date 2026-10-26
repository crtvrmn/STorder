import test from 'node:test';
import assert from 'node:assert/strict';
import { searchImages, ImageSearchError } from '../lib/imagesearch.js';

test('searchImages: Anfrage und Normalisierung', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({
      results: [
        { id: 'a', title: 'Kettle', url: 'https://example.org/k.jpg', thumbnail: 'https://example.org/k-t.jpg', creator: 'Ann', license: 'cc0', source: 'flickr', attribution: '...' },
        { id: 'b', title: '', url: 'ftp://nope/x.jpg' },
        { id: 'c', title: 'Ohne URL' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const results = await searchImages('electric kettle', { limit: 5, provider: 'openverse', fetchImpl });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Kettle');
  assert.equal(results[0].thumbnail, 'https://example.org/k-t.jpg');
  assert.equal(results[0].license, 'cc0');
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('q'), 'electric kettle');
  assert.equal(url.searchParams.get('page_size'), '5');
  assert.equal(url.searchParams.get('mature'), 'false');
});

test('searchImages: zu kurzer Suchbegriff', async () => {
  await assert.rejects(() => searchImages('a'), (err) => err instanceof ImageSearchError && err.status === 400);
});

test('searchImages: HTTP-Fehler', async () => {
  const fetchImpl = async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
  await assert.rejects(() => searchImages('kettle', { fetchImpl }), (err) => err.code === 'IMAGE_SEARCH_HTTP');
});

test('searchImages: Netzwerkfehler', async () => {
  const fetchImpl = async () => { throw new Error('offline'); };
  await assert.rejects(() => searchImages('kettle', { fetchImpl }), (err) => err.code === 'IMAGE_SEARCH_UNAVAILABLE' && /offline/.test(err.message));
});

test('searchImages: Wikimedia Commons (Standard)', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({
      query: {
        pages: {
          11: {
            pageid: 11,
            title: 'File:Electric kettle.jpg',
            imageinfo: [{
              thumburl: 'https://upload.wikimedia.org/thumb/kettle.jpg',
              url: 'https://upload.wikimedia.org/kettle.jpg',
              descriptionurl: 'https://commons.wikimedia.org/wiki/File:Electric_kettle.jpg',
              extmetadata: {
                Artist: { value: '<a href="x">Ann</a>' },
                LicenseShortName: { value: 'CC BY-SA 4.0' },
              },
            }],
          },
          12: { pageid: 12, title: 'File:Kaputt', imageinfo: [{ url: 'not-a-url' }] },
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const results = await searchImages('electric kettle', { limit: 4, fetchImpl });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Electric kettle');
  assert.equal(results[0].url, 'https://upload.wikimedia.org/thumb/kettle.jpg');
  assert.equal(results[0].creator, 'Ann');
  assert.equal(results[0].license, 'CC BY-SA 4.0');
  assert.equal(results[0].source, 'wikimedia');
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('gsrsearch'), 'filetype:bitmap electric kettle');
  assert.equal(url.searchParams.get('gsrnamespace'), '6');
});

test('searchImages: auto kombiniert Quellen und entdoppelt', async () => {
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes('wikimedia')) {
      return new Response(JSON.stringify({
        query: { pages: {
          1: { pageid: 1, title: 'File:A.jpg', imageinfo: [{ thumburl: 'https://x/a.jpg', url: 'https://x/a.jpg' }] },
        } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      results: [
        { id: 'a', title: 'A', url: 'https://x/a.jpg', thumbnail: 'https://x/a.jpg' },
        { id: 'b', title: 'B', url: 'https://x/b.jpg', thumbnail: 'https://x/b.jpg' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const results = await searchImages('kettle', { provider: 'auto', limit: 10, fetchImpl });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.url), ['https://x/a.jpg', 'https://x/b.jpg']);
});
