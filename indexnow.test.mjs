import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pingIndexNow, sitemapUrls } from './indexnow.mjs';

const KEY = '0123456789abcdef0123456789abcdef';

function fake({ keyStatus = 200, pingStatus = 200 } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/indexnow.txt')) return new Response(`${KEY}\n`, { status: keyStatus });
    return new Response('', { status: pingStatus });
  };
  return { calls, fetchFn };
}

test('new pages are announced to IndexNow with the site key', async () => {
  const f = fake();
  const out = await pingIndexNow(['https://wellzz.app/blog/a/', 'https://wellzz.app/best/sleep-stress/'], { site: 'https://wellzz.app', fetchFn: f.fetchFn });
  assert.equal(out, 'sent 2 URLs (HTTP 200)');
  const ping = f.calls.find((c) => c.url === 'https://api.indexnow.org/indexnow');
  assert.equal(ping.init.method, 'POST');
  assert.deepEqual(JSON.parse(ping.init.body), {
    host: 'wellzz.app', key: KEY, keyLocation: 'https://wellzz.app/indexnow.txt',
    urlList: ['https://wellzz.app/blog/a/', 'https://wellzz.app/best/sleep-stress/'],
  });
});

test('a failure is reported, never thrown; nothing is sent without a key or URLs', async () => {
  assert.equal(await pingIndexNow([], { site: 'https://wellzz.app', fetchFn: fake().fetchFn }), 'nothing to send');
  assert.match(await pingIndexNow(['https://wellzz.app/x/'], { site: 'https://wellzz.app', fetchFn: fake({ keyStatus: 404 }).fetchFn }), /^skipped: no key/);
  assert.match(await pingIndexNow(['https://wellzz.app/x/'], { site: 'https://wellzz.app', fetchFn: fake({ pingStatus: 422 }).fetchFn }), /HTTP 422/);
  const boom = async () => { throw new Error('offline'); };
  assert.match(await pingIndexNow(['https://wellzz.app/x/'], { site: 'https://wellzz.app', fetchFn: boom }), /^failed: offline/);
});

test('the sitemap gives the URLs to announce after a deploy', () => {
  const xml = '<urlset><url><loc>https://wellzz.app/</loc></url><url><loc>https://wellzz.app/best/a/?x=1&amp;y=2</loc></url></urlset>';
  assert.deepEqual(sitemapUrls(xml), ['https://wellzz.app/', 'https://wellzz.app/best/a/?x=1&y=2']);
});
