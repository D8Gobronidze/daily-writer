import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIGHT_MODELS, askJson, candidateText, interactionText } from './gemini.mjs';

const reply = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const interaction = (text) => ({ status: 'completed', steps: [{ type: 'thought' }, { type: 'model_output', content: [{ type: 'text', text }] }] });
const args = (fetchFn) => ({ system: 's', prompt: 'p', schema: { type: 'object' }, key: 'k', fetchFn, waits: [0, 0, 0] });

test('reads JSON from an interaction and sends the key and schema', async () => {
  let sent;
  const out = await askJson(args(async (url, init) => {
    sent = { url, init };
    return reply(interaction('{"topic":"zinc"}'));
  }));
  assert.deepEqual(out, { topic: 'zinc' });
  assert.match(sent.url, /\/v1beta\/interactions$/);
  assert.equal(sent.init.headers['x-goog-api-key'], 'k');
  const body = JSON.parse(sent.init.body);
  assert.equal(body.model, 'gemini-3.8-flash');
  assert.deepEqual(body.response_format, { type: 'text', mime_type: 'application/json', schema: { type: 'object' } });
});

test('waits and retries when the free tier is busy', async () => {
  const answers = [reply('busy', 429), reply('busy', 503), reply(interaction('{"ok":true}'))];
  assert.deepEqual(await askJson(args(async () => answers.shift())), { ok: true });
});

test('falls back to generateContent when interactions are not available', async () => {
  const urls = [];
  const out = await askJson(args(async (url) => {
    urls.push(url);
    return urls.length === 1 ? reply('nope', 404) : reply({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"a":', thought: true }, { text: '{"a":1}' }] } }] });
  }));
  assert.deepEqual(out, { a: 1 });
  assert.match(urls[1], /models\/gemini-3\.8-flash:generateContent$/);
});

test('errors are reported, not swallowed', async () => {
  await assert.rejects(askJson(args(async () => reply('bad key', 403))), /HTTP 403/);
  await assert.rejects(askJson(args(async () => reply(interaction('not json')))), (e) => e.invalidJson === true);
  assert.throws(() => interactionText({ status: 'incomplete' }), /incomplete/);
  assert.throws(() => candidateText({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), /MAX_TOKENS/);
  await assert.rejects(askJson({ ...args(async () => reply('')), key: '' }), /GEMINI_API_KEY/);
});

test('images go with the prompt to both endpoints', async () => {
  const bodies = [];
  const images = [{ data: 'AAA', mime: 'image/jpeg' }];
  await askJson({ ...args(async (url, init) => { bodies.push(JSON.parse(init.body)); return reply(interaction('{"pick":1}')); }), images });
  assert.deepEqual(bodies[0].input, [{ type: 'text', text: 'p' }, { type: 'image', data: 'AAA', mime_type: 'image/jpeg' }]);

  const sent = [];
  await askJson({
    ...args(async (url, init) => {
      sent.push(JSON.parse(init.body));
      return sent.length === 1 ? reply('nope', 404) : reply({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"pick":1}' }] } }] });
    }),
    images,
  });
  assert.deepEqual(sent[1].contents[0].parts, [{ text: 'p' }, { inline_data: { mime_type: 'image/jpeg', data: 'AAA' } }]);
});

test('an overloaded model hands over to the next free model', async () => {
  const models = [];
  const out = await askJson({
    system: 's', prompt: 'p', schema: {}, key: 'k', waits: [],
    fetchFn: async (url, init) => {
      models.push(JSON.parse(init.body).model);
      return models.length < 3 ? reply('busy', 503) : reply(interaction('{"ok":1}'));
    },
  });
  assert.deepEqual(out, { ok: 1 });
  assert.deepEqual(models, ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']);
});

test('a used-up daily allowance switches model at once, without waiting', async () => {
  const models = [];
  const out = await askJson({
    system: 's', prompt: 'p', schema: {}, key: 'k', waits: [60_000, 60_000], spent: new Set(),
    fetchFn: async (url, init) => {
      models.push(JSON.parse(init.body).model);
      return models.length === 1 ? reply('Rate limit exceeded (limit: 20 requests per day on Free Tier)', 429) : reply(interaction('{"ok":1}'));
    },
  });
  assert.deepEqual(out, { ok: 1 });
  assert.deepEqual(models, ['gemini-3.8-flash', 'gemini-3.6-flash']);
});

test('a dropped connection is retried', async () => {
  let n = 0;
  const out = await askJson(args(async () => {
    n++;
    if (n === 1) throw new TypeError('fetch failed');
    return reply(interaction('{"ok":2}'));
  }));
  assert.deepEqual(out, { ok: 2 });
  assert.equal(n, 2);
});

test('an overloaded model gets one short wait before the next model takes over; the last one gets them all', async () => {
  const seen = [];
  const out = await askJson({
    system: 's', prompt: 'p', schema: {}, key: 'k', waits: [0, 0, 0], spent: new Set(),
    fetchFn: async (url, init) => {
      seen.push(JSON.parse(init.body).model);
      return seen.length < 8 ? reply('busy', 503) : reply(interaction('{"ok":3}'));
    },
  });
  assert.deepEqual(out, { ok: 3 });
  // 2 tries each for the first two models, then 1 + 3 retries for the last.
  assert.deepEqual(seen, [
    'gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.6-flash',
    'gemini-3.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.5-flash-lite',
  ]);
});

test('a model out of free requests is skipped on later calls in the same run', async () => {
  const spent = new Set();
  const seen = [];
  const fetchFn = async (url, init) => {
    const model = JSON.parse(init.body).model;
    seen.push(model);
    return model === 'gemini-3.8-flash' ? reply('limit: 20 requests per day', 429) : reply(interaction('{"ok":1}'));
  };
  await askJson({ system: 's', prompt: 'p', schema: {}, key: 'k', waits: [], spent, fetchFn });
  await askJson({ system: 's', prompt: 'p', schema: {}, key: 'k', waits: [], spent, fetchFn });
  assert.deepEqual(seen, ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.6-flash']);
  spent.add('gemini-3.6-flash').add('gemini-3.5-flash-lite');
  await assert.rejects(askJson({ system: 's', prompt: 'p', schema: {}, key: 'k', spent, fetchFn }), /out of free requests/);
});

test('busy answers are marked busy so the run can try again later; a bad key is not', async () => {
  await assert.rejects(askJson({ ...args(async () => reply('busy', 503)), waits: [], spent: new Set() }), (e) => e.busy === true);
  await assert.rejects(askJson({ ...args(async () => { throw new TypeError('fetch failed'); }), waits: [], spent: new Set() }), (e) => e.busy === true);
  await assert.rejects(askJson({ ...args(async () => reply('bad key', 403)), spent: new Set() }), (e) => !e.busy);
});

test('small jobs can start on a lighter model, keeping the main one for writing', async () => {
  const seen = [];
  await askJson({ ...args(async (url, init) => { seen.push(JSON.parse(init.body).model); return reply(interaction('{"ok":1}')); }), models: LIGHT_MODELS, spent: new Set() });
  assert.deepEqual(seen, ['gemini-3.6-flash']);
  assert.equal(LIGHT_MODELS.at(-1), 'gemini-3.8-flash');
});
