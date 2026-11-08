// Rules a generated post must pass before it is sent. The API checks the same rules
// (api/src/Blog/AutomationController.php); keep the two in step.
export const BANNED = ['cure', 'cures', 'treats', 'guaranteed', 'miracle', 'detoxes your'];
export const MIN_WORDS = 800;
export const MAX_WORDS = 1500;
export const MAX_TITLE = 80;

// Short, easy educational posts with no supplements or medicines (style kept for manual use).
export const EDU = { min: 450, max: 700, maxSentence: 18 };
export const EDU_BANNED = [
  'supplement', 'supplements', 'supplementation', 'capsule', 'capsules', 'pill', 'pills', 'tablet', 'tablets', 'gummy', 'gummies',
  'drug', 'drugs', 'medication', 'medications', 'medicine', 'medicines', 'dose', 'doses', 'dosage', 'mg', 'mcg', 'iu', 'prescription',
];

// Every third automated post is "Myth vs. truth": 3–5 common health or nutrition beliefs, each checked
// against the studies. Plain language; no medicines, drugs or doses (food vitamins and supplements may come up).
// Room to explain in short sentences: 600–1400 words (the writer aims for 900–1200).
export const MYTH = { min: 600, max: 1400, minMyths: 3, maxSentence: 16 };
export const MYTH_BANNED = ['drug', 'drugs', 'medication', 'medications', 'medicine', 'medicines', 'dose', 'doses', 'dosage', 'mg', 'mcg', 'iu', 'prescription'];

// Myth posts are about everyday beliefs of healthy adults: their title and "## Myth" headings may not be
// about patients, diseases, care settings, children or lab tests and scans (a truth may still say who should ask a doctor).
export const MYTH_OFF_TOPIC = /\b(patients?|diseases?|residents?|hospitals?|hospitali[sz]ed|long-term care|nursing homes?|care homes?|heart failure|cancers?|diabetes|diabetic|conditions?|illness(?:es)?|disorders?|surgery|children|infants?|kids?|scans?|measurements?|ultrasound|bioelectrical|impedance|lab|laboratory|tests? results?|test)\b/i;
// A myth is said the way people believe it: "Coffee dehydrates you", never "X does not help Y"
// (after "Myth:" a denial reads as a double negative).
// Study words most readers don't know; a myth post says it plainly ("a study of 200 adults").
export const MYTH_JARGON = [
  'randomized', 'randomised', 'crossover', 'placebo-controlled', 'meta-analysis', 'meta-analyses', 'cohort', 'cross-sectional',
  'acute', 'chronic', 'correlate', 'correlates', 'correlated', 'correlation', 'subcutaneous', 'preformed', 'participants',
  'proof-of-concept', 'secondary analysis', 'physiological', 'biomarker', 'biomarkers', 'osmolality', 'plasma', 'statistically',
];
// Study words with a plain swap that always reads right; the script makes these itself instead of
// spending a Gemini request and a writing attempt on them. Other jargon still goes back to the writer.
// '' drops the word ("a randomized trial" → "a trial").
const PLAIN = [
  [/randomi[sz]ed,? (?:placebo-)?controlled trials?/i, (m) => (/s$/i.test(m) ? 'trials' : 'trial')],
  [/meta-analyses/i, 'large reviews'],
  [/meta-analysis/i, 'large review'],
  [/participants/i, 'people'],
  [/statistically significant/i, 'clear'],
  [/subcutaneous fat/i, 'fat under the skin'],
  [/plasma/i, 'blood'],
  [/randomi[sz]ed/i, ''],
  [/placebo-controlled/i, ''],
  [/cross-sectional/i, ''],
  [/crossover/i, ''],
];

// Swaps the study words in PLAIN for everyday ones in a myth post's title, summary and body.
// Keeps a capital at the start of a sentence and fixes "a"/"an" in front. Returns the words it changed.
export function plainWords(post) {
  const changed = new Set();
  const fix = (text) => {
    if (typeof text !== 'string') return text;
    for (const [pattern, plain] of PLAIN) {
      const re = new RegExp(String.raw`\b(?:(an?) )?(${pattern.source})\b( ?)`, 'gi');
      text = text.replace(re, (all, article, word, space) => {
        changed.add(word.toLowerCase());
        let out = typeof plain === 'function' ? plain(word) : plain;
        if (!out) return article ? `${article} ` : ''; // dropped: the next word follows the article
        if (/^[A-Z]/.test(article ?? word)) out = out[0].toUpperCase() + out.slice(1);
        if (article) {
          let a = /^[aeiou]/i.test(out) ? 'an' : 'a';
          if (/^A/.test(article)) a = a[0].toUpperCase() + a.slice(1);
          out = `${a} ${out[0].toLowerCase()}${out.slice(1)}`;
        }
        return out + space;
      });
    }
    return text;
  };
  for (const key of ['title', 'summary', 'body']) post[key] = fix(post[key]);
  return [...changed];
}

// The verdict that heads each belief: "## Myth: …", "## True: …" or "## Partly true: …".
const VERDICT = String.raw`(?:myth|true|partly true)\b`;
export const MYTH_NEGATION = /\b(not|cannot|no longer)\b|n['’]t\b/i;

// Why a planned belief could never pass the checks above (null when it can), so the plan drops it
// before writing instead of the writer failing on it every try.
export function beliefProblem(belief) {
  const words = (belief.match(MYTH_OFF_TOPIC) ?? [])[0];
  if (words) return `"${belief}" mentions "${words}" (myths can't be about patients, diseases, conditions, children or tests)`;
  if (MYTH_NEGATION.test(belief)) return `"${belief}" is a denial; say it the way people believe it`;
  return null;
}

// Post number n (1-based) is a myth post when n is a multiple of 3; `runs` are the posts so far.
export const styleFor = (runs) => ((runs.length + 1) % 3 === 0 ? 'myth' : 'standard');

// Average words per sentence in Markdown text (headings are skipped; each list item counts as one).
export function avgSentenceWords(markdown) {
  const text = markdown.replace(/^#+\s.*$/gm, ' ').replace(/[*_`>]/g, ' ');
  const sentences = text.split(/[.!?]+(?=\s|$)|\n\s*[-*\d]+[.)]?\s/).map((x) => wordCount(x)).filter((n) => n > 0);
  return sentences.length ? sentences.reduce((a, b) => a + b, 0) / sentences.length : 0;
}
// The `n` longest sentences (headings skipped), so the writer knows exactly what to split.
export function longestSentences(markdown, n = 3) {
  const text = markdown.replace(/^#+\s.*$/gm, ' ').replace(/[*_`>]/g, ' ');
  return [...new Set(text.split(/[.!?]+(?=\s|$)|\n\s*[-*\d]+[.)]?\s/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean))]
    .sort((a, b) => wordCount(b) - wordCount(a)).slice(0, n);
}
const DAY_MS = 24 * 60 * 60 * 1000;

// Counts words the way PHP's str_word_count does (runs of letters, ' and -).
export const wordCount = (text) => (text.replace(/<[^>]*>/g, ' ').match(/[A-Za-z'-]+/g) ?? []).length;

// `allowedUrls`: when given, every source must be one of these (the papers the research step
// actually fetched), so a post can never cite a link nobody checked.
export function validatePost(post, existingSlugs, allowedUrls = null, style = 'standard') {
  const errors = [];
  const [min, max] = style === 'educational' ? [EDU.min, EDU.max] : style === 'myth' ? [MYTH.min, MYTH.max] : [MIN_WORDS, MAX_WORDS];
  for (const key of ['title', 'summary', 'body']) {
    if (typeof post[key] !== 'string' || !post[key].trim()) errors.push(`${key} is required`);
  }
  for (const [key, max] of [['title', 200], ['summary', 400]]) {
    if (typeof post[key] === 'string' && post[key].length > max) errors.push(`${key} must be at most ${max} characters`);
  }
  // Long titles wrap to 4+ lines on phones.
  if (typeof post.title === 'string' && post.title.length <= 200 && post.title.length > MAX_TITLE) {
    errors.push(`title must be at most ${MAX_TITLE} characters so it fits on a phone (got ${post.title.length}); shorten it`);
  }
  if (typeof post.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug) || post.slug.length > 120) {
    errors.push('slug must be lowercase words joined by hyphens');
  } else if (existingSlugs.includes(post.slug)) {
    errors.push(`slug "${post.slug}" was already used; pick a different topic or slug`);
  }
  if (!['guide', 'news'].includes(post.kind)) errors.push('kind must be guide or news');
  if (typeof post.body === 'string') {
    const n = wordCount(post.body);
    if (n < min || n > max) errors.push(`body must be ${min}–${max} words (got ${n})`);
  }
  const text = `${post.title ?? ''} ${post.summary ?? ''} ${post.body ?? ''}`.toLowerCase();
  for (const word of BANNED) {
    if (new RegExp(`\\b${word}\\b`).test(text)) errors.push(`must not use "${word}"`);
  }
  if (style === 'educational') {
    const found = EDU_BANNED.filter((w) => new RegExp(`\\b${w}\\b`).test(text));
    if (found.length) errors.push(`this is an educational post: no supplements, medicines or doses; remove: ${found.join(', ')}`);
    if (typeof post.body === 'string') {
      const avg = avgSentenceWords(post.body);
      if (avg > EDU.maxSentence) errors.push(`sentences are too long for an easy read (average ${avg.toFixed(1)} words; keep it under ${EDU.maxSentence})`);
    }
  }
  if (style === 'myth') {
    if (typeof post.title === 'string' && !/\bmyths?\b/i.test(post.title)) errors.push('title must say it is about myths (e.g. "Myth or truth: …")');
    const found = MYTH_BANNED.filter((w) => new RegExp(`\\b${w}\\b`).test(text));
    if (found.length) errors.push(`this is a myth vs. truth post about everyday health and nutrition: no medicines, drugs or doses; remove: ${found.join(', ')}`);
    if (typeof post.body === 'string') {
      const sections = post.body.split(new RegExp(String.raw`^##\s+(?=${VERDICT})`, 'im')).slice(1);
      if (sections.length < MYTH.minMyths) errors.push(`needs at least ${MYTH.minMyths} "## Myth: …" sections (got ${sections.length})`);
      if (sections.some((sec) => !/\btruth\b/i.test(sec.split(/^##\s/m)[0]))) errors.push('every "## Myth" section needs its truth ("**The truth:** …") right under it');
      const heads = [...post.body.matchAll(new RegExp(String.raw`^##\s+${VERDICT}\s*:?\s*(.+)$`, 'gim'))].map((m) => m[1].trim());
      const body = post.body.toLowerCase();
      const jargon = MYTH_JARGON.filter((w) => new RegExp(`\\b${w}\\b`).test(body));
      if (jargon.length) errors.push(`write for everyone: use everyday words instead of: ${jargon.join(', ')} (e.g. "a study of 200 adults", "right away", "is linked to")`);
      const denials = heads.filter((h) => MYTH_NEGATION.test(h));
      if (denials.length) errors.push(`say each myth the way people believe it, without "not", "can't" or "doesn't" (rewrite: ${denials.map((h) => `"${h}"`).join(', ')})`);
      const offTopic = [post.title ?? '', ...heads].filter((h) => MYTH_OFF_TOPIC.test(h));
      if (offTopic.length) errors.push(`myths must be everyday beliefs of healthy adults, not about patients, diseases, care settings, children or lab tests and scans (change: ${offTopic.map((h) => `"${h}"`).join(', ')})`);
      const avg = avgSentenceWords(post.body);
      if (avg > MYTH.maxSentence) errors.push(`sentences are too long for an easy read (average ${avg.toFixed(1)} words; keep it under ${MYTH.maxSentence}). Keep the length of the post, but split these into two: ${longestSentences(post.body).map((x) => `"${x}"`).join(', ')}`);
    }
  }
  const sources = Array.isArray(post.sources) ? post.sources : [];
  const good = sources.filter(
    (s) => s && typeof s.title === 'string' && s.title.trim() && s.title.length <= 200
      && typeof s.url === 'string' && s.url.length <= 500 && /^https?:\/\/[^\s/]+\.\S+$/i.test(s.url),
  );
  if (sources.length < 3 || sources.length > 12 || good.length !== sources.length) {
    errors.push('sources: 3 to 12, each with a title (≤ 200 characters) and an http(s) URL (≤ 500 characters)');
  }
  if (allowedUrls) {
    const unknown = good.map((s) => s.url).filter((u) => !allowedUrls.includes(u));
    if (unknown.length) errors.push(`sources must be URLs from the research notes; not found there: ${unknown.join(', ')}`);
    if (new Set(good.map((s) => s.url)).size !== good.length) errors.push('each source may be listed only once');
  }
  // Tags are optional here; the API checks each one is on the site's tag list.
  if (post.tags !== undefined) {
    const t = post.tags;
    if (!Array.isArray(t) || t.some((x) => typeof x !== 'string' || !x) || new Set(t).size !== t.length || t.length > 5) {
      errors.push('tags must be a list of up to 5 different tag names');
    }
  }
  return errors;
}

// A post is due about 3 days after the newest run (or when there is none). The 6-hour slack lets
// the daily job, which publishes a few minutes after it starts, still run on the third day.
export function isDue(runs, now) {
  if (runs.length === 0) return true;
  const newest = Math.max(...runs.map((r) => Date.parse(r.createdAt)));
  return now.getTime() - newest >= 3 * DAY_MS - 6 * 60 * 60 * 1000;
}

// Slugs of every post already on the blog, from the "## Blog" section of /llms.txt.
export function slugsFromLlms(llms) {
  const start = llms.indexOf('## Blog');
  if (start < 0) return [];
  return [...llms.slice(start).matchAll(/\/blog\/([a-z0-9-]+)\/\)/g)].map((m) => m[1]);
}

// Seasonal posts: the first post in the 3 weeks before a US season starts (meteorological: Mar 1, Jun 1,
// Sep 1, Dec 1) is about that season, so readers find it before they need it. One per season, never extra.
export const SEASON_LEAD_DAYS = 21;
const SEASONS = [
  { name: 'spring', month: 2, ideas: 'spring allergy season, getting active again after winter, more sun on the skin, spring clean-eating trends' },
  { name: 'summer', month: 5, ideas: 'sun and skin, heat and drinking enough water, electrolytes, summer travel and digestion, sleeping in the heat' },
  { name: 'fall', month: 8, ideas: 'back to routines and sleep, shorter days and vitamin D, drier air and skin, getting ready for cold and flu season' },
  { name: 'winter', month: 11, ideas: 'vitamin D when days are short, dry winter skin, holiday eating, staying active in the cold, winter mood and daylight' },
];

/** The season this post should be about, or null. `runs`: the automation's posts ({createdAt}). */
export function seasonFor(runs, now) {
  // Every 3-week window falls inside one calendar year (the earliest, spring's, opens on Feb 8).
  for (const s of SEASONS) {
    const start = Date.UTC(now.getUTCFullYear(), s.month, 1);
    const windowStart = start - SEASON_LEAD_DAYS * DAY_MS;
    if (now.getTime() < windowStart || now.getTime() >= start) continue;
    if (runs.some((r) => Date.parse(r.createdAt) >= windowStart)) return null;
    const days = Math.ceil((start - now.getTime()) / DAY_MS);
    return { name: s.name, start: new Date(start).toISOString().slice(0, 10), days, ideas: s.ideas };
  }
  return null;
}

/** The instruction added to the prompts for a seasonal post. */
export const seasonNote = (s) =>
  `SEASONAL POST: ${s.name} starts in the US on ${s.start} (in ${s.days} days). This post must help readers get ready for ${s.name}: pick a topic tied to the season (ideas: ${s.ideas}), say "${s.name}" in the title, and explain why it matters at this time of year.`;
