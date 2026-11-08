// Free research: recent reviews and trials from Europe PMC (the PubMed database plus abstracts,
// no key needed). Each paper links to its PubMed page, so every source in a post is a real study.
const ENDPOINT = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const TYPES = ['review', 'systematic-review', 'meta-analysis', 'randomized controlled trial'];
const MAX_ABSTRACT = 2200;
const WAITS = [10_000, 30_000, 60_000]; // Europe PMC is sometimes briefly busy (5xx/429): wait and try again

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, fetchFn, waits) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchFn(url, { headers: { 'User-Agent': `daily-writer${process.env.SITE_URL ? ` (${process.env.SITE_URL})` : ''}` } });
    } catch (err) {
      if (attempt >= waits.length) throw Object.assign(err, { busy: true });
      console.log(`Connection to Europe PMC failed (${err.message}); waiting ${waits[attempt] / 1000}s…`);
      await sleep(waits[attempt]);
      continue;
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < waits.length) {
      console.log(`Europe PMC answered HTTP ${res.status}; waiting ${waits[attempt] / 1000}s…`);
      await sleep(waits[attempt]);
      continue;
    }
    throw Object.assign(new Error(`Europe PMC answered HTTP ${res.status}`), { busy: res.status === 429 || res.status >= 500 });
  }
}

const quote = (s) => `"${String(s).replace(/["\\]/g, ' ').trim()}"`;

// One search: papers whose TITLE names `main` and whose title or abstract mentions any of `about`.
// Only English, with an abstract, from the last `years` years, of the study types above.
export function buildQuery({ main, about = [] }, now = new Date(), years = 5) {
  const year = now.getUTCFullYear();
  const aboutPart = about.length ? ` AND (${about.flatMap((a) => [`TITLE:${quote(a)}`, `ABSTRACT:${quote(a)}`]).join(' OR ')})` : '';
  return `(TITLE:${quote(main)}${aboutPart}) AND HAS_ABSTRACT:y AND LANG:eng AND SRC:MED`
    + ` AND PUB_YEAR:[${year - years} TO ${year}] AND (${TYPES.map((t) => `PUB_TYPE:${quote(t)}`).join(' OR ')})`;
}

const clean = (html) => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// A Europe PMC result as a source the writer may cite.
export function toPaper(r) {
  if (!r?.pmid || !r.title || !r.abstractText) return null;
  const types = [].concat(r.pubTypeList?.pubType ?? []).map(String);
  const kind = types.some((t) => /meta-analysis/i.test(t)) ? 'meta-analysis'
    : types.some((t) => /systematic/i.test(t)) ? 'systematic review'
      : types.some((t) => /randomi[sz]ed controlled trial/i.test(t)) ? 'randomized controlled trial'
        : 'review';
  const abstract = clean(r.abstractText);
  return {
    url: `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`,
    title: clean(r.title).replace(/\.$/, ''),
    journal: r.journalInfo?.journal?.title ?? r.journalTitle ?? '',
    year: Number(r.pubYear) || null,
    kind,
    abstract: abstract.length > MAX_ABSTRACT ? `${abstract.slice(0, MAX_ABSTRACT)}…` : abstract,
  };
}

// Runs each search and returns up to `limit` different papers, best matches first.
// `years`: how far back to look (myth posts check classic beliefs, often studied longer ago).
export async function findPapers(searches, { limit = 8, perSearch = 5, fetchFn = fetch, now = new Date(), years = 5, waits = WAITS } = {}) {
  const papers = new Map();
  for (const search of searches) {
    const url = new URL(ENDPOINT);
    url.search = new URLSearchParams({ query: buildQuery(search, now, years), format: 'json', resultType: 'core', pageSize: String(perSearch) }).toString();
    const data = await getJson(url, fetchFn, waits);
    for (const r of data.resultList?.result ?? []) {
      const p = toPaper(r);
      if (p && !papers.has(p.url)) papers.set(p.url, p);
    }
    if (papers.size >= limit) break;
  }
  return [...papers.values()].slice(0, limit);
}

// The papers as numbered research notes for the writer.
export const notesFrom = (papers) =>
  papers.map((p, i) => `[${i + 1}] ${p.title} (${p.kind}, ${p.journal}${p.year ? `, ${p.year}` : ''})\nURL: ${p.url}\nAbstract: ${p.abstract}`).join('\n\n');

// Myth posts: the popular beliefs come first, then each belief gets its own study search, so every
// "Myth/True" section is backed by studies about that very belief. Beliefs no study looked at are dropped.
export async function researchBeliefs(beliefs, { find = (searches) => findPapers(searches, { limit: 3, years: 10 }) } = {}) {
  const kept = [];
  for (const { belief, search } of beliefs) {
    const papers = await find([search]);
    if (papers.length) kept.push({ belief, papers });
  }
  return kept;
}

// The notes for a myth post: each belief followed by only its own studies (numbered across the post).
export function mythNotes(kept) {
  let n = 0;
  return kept
    .map(({ belief, papers }, i) => `Belief ${i + 1}: "${belief}"\n${papers
      .map((p) => `[${++n}] ${p.title} (${p.kind}, ${p.journal}${p.year ? `, ${p.year}` : ''})\nURL: ${p.url}\nAbstract: ${p.abstract}`)
      .join('\n')}`)
    .join('\n\n');
}
