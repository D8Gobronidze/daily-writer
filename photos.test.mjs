import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPhoto, looksMedical, looksTexty, needed, score } from './photos.mjs';

const hit = (id, tags, over = {}) => ({ id, tags, imageWidth: 4000, imageHeight: 2600, largeImageURL: `https://pixabay.com/get/${id}.jpg`, ...over });
// Answers the search with `hits` and any image download with bytes "img-<id>"; records requests.
const pixabay = (hits, calls = []) => async (url) => {
  const u = String(url);
  calls.push(u);
  if (u.startsWith('https://pixabay.com/api/')) return new Response(JSON.stringify({ hits }));
  return new Response(`img-${u.match(/get\/(\d+)/)[1]}`);
};
const bytes = (photo) => Buffer.from(photo.image, 'base64').toString();

test('picks the photo whose tags best match the search, downloads it and names its source', async () => {
  const calls = [];
  const got = await findPhoto('woman stretching morning sunlight', {
    key: 'k',
    fetchFn: pixabay([hit(1, 'baby, sleeping, bed'), hit(2, 'woman, stretching, morning, sunlight, yoga'), hit(3, 'woman, park')], calls),
  });
  assert.equal(got.source, 'pixabay:2');
  assert.equal(got.query, 'woman stretching morning sunlight');
  assert.equal(bytes(got), 'img-2');
  assert.match(calls[0], /^https:\/\/pixabay\.com\/api\/\?key=k&q=woman\+stretching.*orientation=horizontal.*safesearch=true.*min_width=1200/);
  assert.equal(calls[1], 'https://pixabay.com/get/2.jpg');
});

test('skips text-like, portrait and already-used photos; no match means no photo', async () => {
  const hits = [
    hit(1, 'healthy food, sign, chalkboard'),
    hit(5, 'healthy food, vitamin capsules'),
    hit(2, 'healthy food, salad', { imageWidth: 2000, imageHeight: 3000 }),
    hit(3, 'healthy food, bowl'),
    hit(4, 'healthy food, fruit'),
  ];
  assert.equal((await findPhoto('healthy food', { key: 'k', fetchFn: pixabay(hits), used: ['pixabay:3'] })).source, 'pixabay:4');
  assert.equal(await findPhoto('healthy food', { key: 'k', fetchFn: pixabay([hit(9, 'car, road')]) }), null);
});

test('a weak match is refused and the next, simpler search is tried', async () => {
  const bySearch = {
    'pharmacist consulting with friendly customer': [hit(1, 'call center, customer service, consulting, headset')],
    pharmacy: [hit(2, 'pharmacy, shelves, store')],
  };
  const calls = [];
  const fetchFn = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('https://pixabay.com/api/')) return new Response(JSON.stringify({ hits: bySearch[new URL(u).searchParams.get('q')] ?? [] }));
    return new Response('img');
  };
  const got = await findPhoto(['pharmacist consulting with friendly customer', 'pharmacist talking', 'pharmacy'], { key: 'k', fetchFn });
  assert.equal(got.source, 'pixabay:2');
  assert.equal(got.query, 'pharmacy');
  assert.equal(calls.filter((u) => u.startsWith('https://pixabay.com/api/')).length, 3);
  assert.equal(await findPhoto(['pharmacist consulting with friendly customer'], { key: 'k', fetchFn }), null);
});

test('no key or query means no request; errors are reported', async () => {
  assert.equal(await findPhoto('x', { key: '' }), null);
  assert.equal(await findPhoto('', { key: 'k' }), null);
  await assert.rejects(findPhoto('x', { key: 'k', fetchFn: async () => new Response('', { status: 429 }) }), /HTTP 429/);
});

test('helpers', () => {
  assert.equal(looksTexty('open book, table'), true);
  assert.equal(looksTexty('couple, jogging, sunrise'), false);
  assert.equal(looksMedical('headache, pills, medication'), true);
  assert.equal(looksMedical('pharmacy, pharmacist, smile'), false);
  assert.equal(score('Woman stretching at sunrise', 'woman, sunrise, beach'), 2);
  assert.deepEqual(['pharmacy', 'woman stretching', 'raw nuts and leafy greens', 'pharmacist consulting with friendly customer'].map(needed), [1, 2, 3, 3]);
});

test('with a chooser, it is shown candidates from all searches and its pick is downloaded in full', async () => {
  const bySearch = {
    'woman sleeping in bed': [hit(1, 'woman, sleeping, bed', { webformatURL: 'https://pixabay.com/get/1.jpg?640' }), hit(2, 'woman, bed, sleeping, pillow', { webformatURL: 'https://pixabay.com/get/2.jpg?640' })],
    'sleep': [hit(2, 'sleep, woman'), hit(3, 'sleep, cat', { webformatURL: 'https://pixabay.com/get/3.jpg?640' })],
  };
  const calls = [];
  const fetchFn = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('https://pixabay.com/api/')) return new Response(JSON.stringify({ hits: bySearch[new URL(u).searchParams.get('q')] ?? [] }));
    return new Response(`img-${u.match(/get\/(\d+)/)[1]}${u.includes('?640') ? '-small' : ''}`);
  };
  let shown;
  const got = await findPhoto(['woman sleeping in bed', 'sleep'], { key: 'k', fetchFn, choose: async (images) => { shown = images.map((i) => Buffer.from(i.data, 'base64').toString()); return 3; } });
  assert.deepEqual(shown, ['img-1-small', 'img-2-small', 'img-3-small']);
  assert.equal(got.source, 'pixabay:3');
  assert.equal(got.query, 'sleep');
  assert.equal(bytes(got), 'img-3');

  assert.equal(await findPhoto(['woman sleeping in bed'], { key: 'k', fetchFn, choose: async () => 0 }), null, 'none fits');
  assert.equal(await findPhoto(['woman sleeping in bed'], { key: 'k', fetchFn, choose: async () => 9 }), null, 'out of range');
  assert.equal(await findPhoto(['nothing here'], { key: 'k', fetchFn, choose: async () => { throw new Error('not asked'); } }), null);
});
