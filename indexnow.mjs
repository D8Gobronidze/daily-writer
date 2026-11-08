// IndexNow (free): tells Bing, Yandex and others right away that pages are new or changed, instead of waiting
// for a crawl. Bing's index also feeds ChatGPT search and Copilot. The key is served by the site at /indexnow.txt.
// Used after a post is published or rewritten, and after each deploy:
//   node indexnow.mjs https://example.com       (announces every URL in the sitemap)
const ENDPOINT = 'https://api.indexnow.org/indexnow';

// The <loc> addresses in a sitemap.
export const sitemapUrls = (xml) => [...String(xml).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));

// Announces `urls`; returns what happened and never throws (search engines will still crawl on their own).
export async function pingIndexNow(urls, { site = process.env.SITE_URL ?? '', fetchFn = fetch } = {}) {
  if (!urls.length) return 'nothing to send';
  try {
    const base = site.replace(/\/+$/, '');
    const res = await fetchFn(`${base}/indexnow.txt`);
    const key = res.ok ? (await res.text()).trim() : '';
    if (!/^[a-zA-Z0-9-]{8,128}$/.test(key)) return `skipped: no key at ${base}/indexnow.txt`;
    const ping = await fetchFn(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: new URL(base).host, key, keyLocation: `${base}/indexnow.txt`, urlList: urls.slice(0, 10000) }),
    });
    return `sent ${urls.length} URLs (HTTP ${ping.status})`;
  } catch (err) {
    return `failed: ${err instanceof Error ? err.message : err}`;
  }
}

// Run directly (after a deploy): announce everything in the sitemap.
if (import.meta.url === `file://${process.argv[1]}`) {
  const site = (process.argv[2] ?? process.env.SITE_URL ?? '').replace(/\/+$/, '');
  const xml = site ? await fetch(`${site}/sitemap.xml`).then((r) => (r.ok ? r.text() : ''), () => '') : '';
  console.log(`IndexNow: ${await pingIndexNow(sitemapUrls(xml), { site })}`);
}
