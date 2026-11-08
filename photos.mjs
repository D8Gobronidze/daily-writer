// Real photos for posts from Pixabay (free; PIXABAY_API_KEY from pixabay.com/api/docs). Pixabay's
// terms: download the photo rather than hotlink it, so the site stores it and serves it from its own
// address (/blog/images/…). No credit line is needed.
const ENDPOINT = 'https://pixabay.com/api/';
// Tags that suggest words in the picture: covers must not carry text.
const TEXTY = /\b(text|word|words|sign|signs|signage|letter|letters|quote|label|labels|poster|banner|book|books|newspaper|screen|chalkboard|note|notes|logo|typography|menu|neon|font|alphabet)\b/i;

export const looksTexty = (tags) => TEXTY.test(tags ?? '');
// No pill, capsule or needle close-ups: posts show real life, not medicine.
const MEDICAL = /\b(pill|pills|capsule|capsules|tablet|tablets|syringe|syringes|needle|needles|injection|vaccine|drugs)\b/i;
export const looksMedical = (tags) => MEDICAL.test(tags ?? '');

const STOP = new Set(['and', 'with', 'the', 'for', 'from', 'into', 'onto', 'over', 'under', 'near']);
const words = (s) => new Set(String(s).toLowerCase().match(/[a-z]+/g) ?? []);
// The words of a search that matter (2+ letters after "a", "of", "with"… are dropped).
const keyWords = (query) => [...words(query)].filter((w) => w.length > 2 && !STOP.has(w));

// How many of the search words a photo's tags contain (more = closer to what was asked).
export function score(query, tags) {
  const t = words(tags);
  return keyWords(query).filter((w) => t.has(w)).length;
}

// A photo must match most of the search, not one stray word ("customer" alone isn't a pharmacy).
export const needed = (query) => {
  const n = keyWords(query).length;
  return n <= 2 ? n : Math.max(2, Math.ceil(n * 0.6));
};

const MAX_CANDIDATES = 8;

/**
 * Finds a photo for a post and downloads it.
 * With `choose` (Gemini looking at the candidates): up to 8 photos from the searches are shown to it
 * and it picks the one that really fits, or none. Without it: the best tag match of the first search
 * that matches well enough. No good photo: null (the post keeps its drawn cover).
 * @param {string|string[]} queries specific first, simple last
 * @param {{choose?: (images: {data: string, mime: string}[]) => Promise<number>}} opts choose returns 1-based index, 0 = none
 * @returns {Promise<{image: string, source: string, query: string} | null>} base64 bytes, "pixabay:<id>"
 */
export async function findPhoto(queries, opts = {}) {
  const list = [].concat(queries ?? []).filter(Boolean).slice(0, 3);
  if (!opts.choose) {
    for (const query of list) {
      const [best] = await candidates(query, opts);
      if (best && best.s >= needed(query)) return { ...(await download(best.h.largeImageURL, opts)), source: `pixabay:${best.h.id}`, query };
    }
    return null;
  }
  const pool = [];
  for (const query of list) {
    for (const c of await candidates(query, opts)) {
      if (pool.length < MAX_CANDIDATES && !pool.some((p) => p.h.id === c.h.id)) pool.push({ ...c, query });
    }
  }
  if (!pool.length) return null;
  const previews = await Promise.all(pool.map((c) => download(c.h.webformatURL ?? c.h.largeImageURL, opts)));
  const pick = await opts.choose(previews.map((p) => ({ data: p.image, mime: 'image/jpeg' })));
  const chosen = Number.isInteger(pick) && pick >= 1 && pick <= pool.length ? pool[pick - 1] : null;
  if (!chosen) return null;
  return { ...(await download(chosen.h.largeImageURL, opts)), source: `pixabay:${chosen.h.id}`, query: chosen.query };
}

async function download(url, { fetchFn = fetch }) {
  const img = await fetchFn(url);
  if (!img.ok) throw new Error(`Pixabay image download answered HTTP ${img.status}`);
  return { image: Buffer.from(await img.arrayBuffer()).toString('base64') };
}

// The usable photos for one search, best tag match first (no text, no pills, landscape, not used yet).
async function candidates(query, { key = process.env.PIXABAY_API_KEY, fetchFn = fetch, used = [] }) {
  if (!key) return [];
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    key, q: query.slice(0, 100), image_type: 'photo', orientation: 'horizontal', safesearch: 'true', min_width: '1200', per_page: '20',
  }).toString();
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Pixabay answered HTTP ${res.status}`);
  const data = await res.json();
  return (data.hits ?? [])
    .filter((h) => h.largeImageURL && !looksTexty(h.tags) && !looksMedical(h.tags) && !used.includes(`pixabay:${h.id}`) && h.imageWidth > h.imageHeight)
    .map((h, i) => ({ h, s: score(query, h.tags), i }))
    .filter((c) => c.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, 4);
}
