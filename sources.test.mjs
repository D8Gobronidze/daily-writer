import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, findPapers, mythNotes, notesFrom, researchBeliefs, toPaper } from './sources.mjs';

const result = (pmid, over = {}) => ({
  pmid: String(pmid),
  title: `Magnesium and <i>sleep</i> study ${pmid}.`,
  abstractText: '<h4>Background</h4>Adults took magnesium.',
  pubYear: '2025',
  journalInfo: { journal: { title: 'Nutrients' } },
  pubTypeList: { pubType: ['Journal Article', 'Systematic Review'] },
  ...over,
});

test('the query looks in titles, recent years and study types only', () => {
  const q = buildQuery({ main: 'vitamin D', about: ['sleep'] }, new Date('2026-11-01'));
  assert.match(q, /^\(TITLE:"vitamin D" AND \(TITLE:"sleep" OR ABSTRACT:"sleep"\)\)/);
  assert.match(q, /PUB_YEAR:\[2021 TO 2026\]/);
  assert.match(q, /HAS_ABSTRACT:y AND LANG:eng/);
  assert.match(q, /PUB_TYPE:"meta-analysis"/);
  assert.equal(buildQuery({ main: 'zinc "x"', about: [] }, new Date('2026-01-01')).startsWith('(TITLE:"zinc  x")'), true);
});

test('a result becomes a PubMed source with clean text', () => {
  const p = toPaper(result(123));
  assert.deepEqual(p, {
    url: 'https://pubmed.ncbi.nlm.nih.gov/123/',
    title: 'Magnesium and sleep study 123',
    journal: 'Nutrients',
    year: 2025,
    kind: 'systematic review',
    abstract: 'Background Adults took magnesium.',
  });
  assert.equal(toPaper(result(1, { abstractText: '' })), null);
});

test('papers from several searches are merged without duplicates', async () => {
  const pages = [[result(1), result(2)], [result(2), result(3)]];
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ resultList: { result: pages[calls.length - 1] } }));
  };
  const papers = await findPapers([{ main: 'a', about: [] }, { main: 'b', about: [] }], { fetchFn });
  assert.deepEqual(papers.map((p) => p.url.match(/\d+/)[0]), ['1', '2', '3']);
  assert.match(calls[0], /europepmc.*query=/);
  assert.match(notesFrom(papers), /^\[1\] Magnesium and sleep study 1 \(systematic review, Nutrients, 2025\)\nURL: https:\/\/pubmed/);
});

test('a failing search stops the run', async () => {
  await assert.rejects(findPapers([{ main: 'a', about: [] }], { waits: [], fetchFn: async () => new Response('x', { status: 503 }) }), /HTTP 503/);
});

const paper = (n) => ({ url: `https://pubmed.ncbi.nlm.nih.gov/${n}/`, title: `Study ${n}`, journal: 'J', year: 2024, kind: 'review', abstract: `Abstract ${n}` });

test('each belief gets its own studies; beliefs nobody studied are dropped', async () => {
  const found = { 'eight glasses': [paper(1), paper(2)], coffee: [paper(3), paper(1)], 'thirst': [] };
  const beliefs = [
    { belief: 'You need eight glasses of water a day', search: { main: 'eight glasses', about: [] } },
    { belief: 'Coffee dehydrates you', search: { main: 'coffee', about: ['hydration'] } },
    { belief: 'Thirst means you are already dehydrated', search: { main: 'thirst', about: [] } },
  ];
  const kept = await researchBeliefs(beliefs, { find: async ([s]) => found[s.main] });
  assert.deepEqual(kept.map((k) => k.belief), ['You need eight glasses of water a day', 'Coffee dehydrates you']);
  assert.deepEqual(kept[1].papers.map((p) => p.url), [paper(3).url, paper(1).url]);
});

test('myth notes list each belief with only its own studies', () => {
  const notes = mythNotes([
    { belief: 'Coffee dehydrates you', papers: [paper(3)] },
    { belief: 'You need eight glasses a day', papers: [paper(1), paper(2)] },
  ]);
  assert.match(notes, /^Belief 1: "Coffee dehydrates you"\n\[1\] Study 3 \(review, J, 2024\)\nURL: https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/3\//);
  assert.match(notes, /Belief 2: "You need eight glasses a day"\n\[2\] Study 1[\s\S]*\[3\] Study 2/);
});

test('belief searches look 10 years back; other posts 5', async () => {
  const years = [];
  const fetchFn = async (url) => {
    years.push(decodeURIComponent(String(url)).match(/PUB_YEAR:\[(\d+)[+ ]TO[+ ](\d+)\]/).slice(1).map(Number));
    return new Response(JSON.stringify({ resultList: { result: [] } }));
  };
  const now = new Date('2026-11-02T00:00:00Z');
  await findPapers([{ main: 'coffee', about: [] }], { fetchFn, now });
  await findPapers([{ main: 'coffee', about: [] }], { fetchFn, now, years: 10 });
  assert.deepEqual(years, [[2021, 2026], [2016, 2026]]);
});

test('a busy Europe PMC is retried', async () => {
  const answers = [new Response('busy', { status: 503 }), new Response(JSON.stringify({ resultList: { result: [] } }))];
  let n = 0;
  const papers = await findPapers([{ main: 'a', about: [] }], { waits: [0, 0], fetchFn: async () => { n++; return answers.shift(); } });
  assert.deepEqual(papers, []);
  assert.equal(n, 2);
});

test('a Europe PMC outage is marked busy; a bad request is not', async () => {
  await assert.rejects(findPapers([{ main: 'a', about: [] }], { waits: [], fetchFn: async () => new Response('x', { status: 502 }) }), (e) => e.busy === true);
  await assert.rejects(findPapers([{ main: 'a', about: [] }], { waits: [], fetchFn: async () => new Response('x', { status: 400 }) }), (e) => e.busy === false);
});
