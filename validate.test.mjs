import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avgSentenceWords, beliefProblem, isDue, plainWords, longestSentences, slugsFromLlms, styleFor, validatePost } from './validate.mjs';

const words = (n) => Array.from({ length: n }, (_, i) => `word${i % 7 ? '' : 's'}`).join(' ');
const post = (over = {}) => ({
  title: 'What new research says about vitamin D in winter',
  slug: 'vitamin-d-winter-research',
  kind: 'news',
  summary: 'A plain-language look at recent vitamin D research.',
  body: `## Intro\n\n${words(900)}`,
  sources: [
    { title: 'NIH ODS', url: 'https://ods.od.nih.gov/' },
    { title: 'MedlinePlus', url: 'https://medlineplus.gov/' },
    { title: 'PubMed', url: 'https://pubmed.ncbi.nlm.nih.gov/29025082/' },
  ],
  categorySlug: 'health-wellness',
  ...over,
});

test('a valid post has no errors', () => {
  assert.deepEqual(validatePost(post(), []), []);
});

test('length must be 800 to 1500 words', () => {
  assert.match(validatePost(post({ body: words(700) }), []).join(), /800/);
  assert.match(validatePost(post({ body: words(1600) }), []).join(), /1500/);
});

test('sources need at least three http(s) links', () => {
  assert.match(validatePost(post({ sources: post().sources.slice(0, 2) }), []).join(), /sources/);
  const bad = [...post().sources, { title: 'x', url: 'javascript:alert(1)' }];
  assert.match(validatePost(post({ sources: bad }), []).join(), /sources/);
});

test('banned claims are rejected', () => {
  assert.match(validatePost(post({ body: `${words(900)} This cures it.` }), []).join(), /cures/);
  assert.deepEqual(validatePost(post({ body: `${words(900)} Treatment options vary.` }), []), []);
});

test('slug must be new and well formed', () => {
  assert.match(validatePost(post(), ['vitamin-d-winter-research']).join(), /already/);
  assert.match(validatePost(post({ slug: 'Bad Slug' }), []).join(), /slug/);
  assert.match(validatePost(post({ kind: 'opinion' }), []).join(), /kind/);
});

test('a post is due about 3 days after the last one', () => {
  const now = new Date('2026-10-28T09:17:00Z');
  assert.equal(isDue([], now), true);
  assert.equal(isDue([{ createdAt: '2026-10-26T09:20:00Z' }], now), false);
  // The daily job starts at 09:17 and the last post was published a few minutes later, 3 days ago.
  assert.equal(isDue([{ createdAt: '2026-10-25T09:24:00Z' }], now), true);
});

test('a run recorded a minute ago means a second run the same day writes nothing', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  assert.equal(isDue([{ createdAt: '2026-10-28T11:59:00Z' }, { createdAt: '2026-10-01T09:00:00Z' }], now), false);
});

test('title, summary and sources have length limits', () => {
  assert.match(validatePost(post({ title: 'a'.repeat(201) }), []).join(), /title/);
  assert.match(validatePost(post({ summary: 'a'.repeat(401) }), []).join(), /summary/);
  const long = [{ title: 'x', url: `https://example.org/${'a'.repeat(500)}` }, ...post().sources];
  assert.match(validatePost(post({ sources: long }), []).join(), /sources/);
});

test('slugs of posts already on the blog come from llms.txt', () => {
  const llms = '# Site\n\n## Blog\n\n- [A](https://x.test/blog/how-to-read-a-label/): s\n- [B](https://x.test/blog/magnesium-types/): s\n';
  assert.deepEqual(slugsFromLlms(llms), ['how-to-read-a-label', 'magnesium-types']);
  assert.deepEqual(slugsFromLlms('# Site\n'), []);
});

test('rejects tags that are not a short list of unique words', () => {
  assert.ok(validatePost(post({ tags: 'safety' }), []).some((e) => e.startsWith('tags')));
  assert.ok(validatePost(post({ tags: ['safety', 'safety'] }), []).some((e) => e.startsWith('tags')));
  assert.ok(validatePost(post({ tags: ['a', 'b', 'c', 'd', 'e', 'f'] }), []).some((e) => e.startsWith('tags')));
});

test('accepts missing or valid tags', () => {
  assert.deepEqual(validatePost(post(), []), []);
  assert.deepEqual(validatePost(post({ tags: ['safety', 'immunity'] }), []), []);
});


test('with research URLs given, sources must come from them, once each', () => {
  const allowed = ['https://ods.od.nih.gov/', 'https://medlineplus.gov/', 'https://pubmed.ncbi.nlm.nih.gov/29025082/'];
  assert.deepEqual(validatePost(post(), [], allowed), []);
  assert.match(validatePost(post(), [], allowed.slice(0, 2)).join(), /not found there: https:\/\/pubmed/);
  const twice = post({ sources: [...post().sources, post().sources[0]] });
  assert.match(validatePost(twice, [], allowed).join(), /only once/);
});

test('every third post is a myth vs. truth post', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 8].map((n) => styleFor(Array(n).fill({}))), [
    'standard', 'standard', 'myth', 'standard', 'standard', 'myth', 'myth',
  ]);
});

const mythBody = (myths = 3, extra = '') =>
  Array.from({ length: myths }, (_, i) => `## Myth: belief number ${i + 1}\n\n**The truth:** ${easy(200)}`).join('\n\n') + extra;

test('a myth vs. truth post has 3+ myths, each with its truth, and no medicines or doses', () => {
  const myth = (over) => post({ title: 'Myth or truth: 3 beliefs about breakfast', body: mythBody(), ...over });
  assert.deepEqual(validatePost(myth(), [], null, 'myth'), []);
  assert.match(validatePost(myth({ title: 'Breakfast facts' }), [], null, 'myth').join(), /title must say it is about myths/);
  assert.match(validatePost(myth({ body: mythBody(2, `\n\n## Tips\n\n${easy(200)}`) }), [], null, 'myth').join(), /at least 3 "## Myth/);
  const noTruth = mythBody(3).replace('**The truth:**', '');
  assert.match(validatePost(myth({ body: noTruth }), [], null, 'myth').join(), /every "## Myth" section needs its truth/);
  assert.match(validatePost(myth({ body: mythBody(3, '\n\nTake a 500 mg dose of this medicine.') }), [], null, 'myth').join(), /remove: medicine, dose, mg/);
  assert.deepEqual(validatePost(myth({ body: mythBody(6) }), [], null, 'myth'), []);
  assert.match(validatePost(myth({ body: mythBody(8) }), [], null, 'myth').join(), /600–1400 words/);
  // Food vitamins and supplements may come up in nutrition myths.
  assert.deepEqual(validatePost(myth({ summary: 'Do vitamin supplements replace a good diet? The truth from studies.' }), [], null, 'myth'), []);
});

test('myths are everyday beliefs, said the way people say them', () => {
  const withMyths = (heads) => post({
    title: 'Myth or truth: 3 beliefs about drinking water',
    body: heads.map((h) => `## Myth: ${h}\n\n**The truth:** ${easy(200)}`).join('\n\n'),
  });
  const ok = ['Everyone needs eight glasses of water a day', 'Coffee dehydrates you', 'If you feel thirsty, you are already dehydrated'];
  assert.deepEqual(validatePost(withMyths(ok), [], null, 'myth'), []);
  // A belief told as a denial reads as a double negative once "Myth:" is in front of it.
  const negative = validatePost(withMyths([ok[0], ok[1], 'Drinking water before meals does not help weight loss']), [], null, 'myth').join();
  assert.match(negative, /say each myth the way people believe it/);
  assert.match(negative, /does not help weight loss/);
  assert.match(validatePost(withMyths([ok[0], ok[1], "Hydration habits can't change"]), [], null, 'myth').join(), /say each myth the way people believe it/);
  // Patients, diseases and care settings are not everyday beliefs.
  for (const bad of [
    'Restricting fluids is necessary for all adult heart failure patients',
    'Hydration habits stay the same in long-term care residents',
    'Children and adults with health conditions drink enough',
    'Water flushes out kidney disease',
    'Drinking large amounts of water affects bioelectrical body composition scans',
    'Dehydration changes ultrasound fat measurements',
    'Water changes your lab test results',
  ]) {
    assert.match(validatePost(withMyths([ok[0], ok[1], bad]), [], null, 'myth').join(), /everyday beliefs of healthy adults/, bad);
  }
  assert.match(
    validatePost(post({ title: 'Myth or truth: water for hospital patients', body: mythBody() }), [], null, 'myth').join(),
    /everyday beliefs of healthy adults/,
  );
  // The truth may still mention a group that should ask a doctor.
  const caveat = withMyths(ok).body.replace('**The truth:**', '**The truth:** People with kidney disease should ask their doctor.');
  assert.deepEqual(validatePost(post({ title: 'Myth or truth: 3 beliefs about drinking water', body: caveat }), [], null, 'myth'), []);
});

const easy = (n) => Array.from({ length: n / 10 }, () => 'Your body needs rest to repair muscles every single night.').join(' ');

test('an educational post is short, simple and has no supplements or medicines', () => {
  const edu = (over) => post({ body: `## How sleep works\n\n${easy(500)}`, ...over });
  assert.deepEqual(validatePost(edu(), [], null, 'educational'), []);
  assert.match(validatePost(edu({ body: easy(900) }), [], null, 'educational').join(), /450–700 words/);
  assert.match(validatePost(edu({ summary: 'Why a magnesium supplement or sleeping pills are not needed.' }), [], null, 'educational').join(), /remove: supplement, pills/);
  const long = `## Long\n\n${Array.from({ length: 20 }, () => words(25) + '.').join(' ')}`;
  assert.match(validatePost(edu({ body: long }), [], null, 'educational').join(), /too long for an easy read/);
  // The same words are fine in a standard post.
  assert.deepEqual(validatePost(post({ summary: 'A magnesium supplement guide.' }), []), []);
});

test('sentence length skips headings and counts list items on their own', () => {
  assert.equal(avgSentenceWords('## A heading here\n\nOne two three. Four five six seven!\n\n- eight nine\n- ten'), 2.5);
});

test('titles must fit on a phone', () => {
  assert.deepEqual(validatePost(post({ title: 'a'.repeat(80) }), []), []);
  assert.match(validatePost(post({ title: 'a'.repeat(81) }), []).join(), /at most 80 characters so it fits on a phone \(got 81\)/);
});

const verdictPost = (heads, text = null) => post({
  title: 'Myth or truth: 3 beliefs about drinking water',
  body: heads.map((h) => `## ${h}\n\n**The truth:** ${text ?? easy(200)}`).join('\n\n'),
});

test('a belief the studies support is headed "True:", a mixed one "Partly true:"', () => {
  const ok = verdictPost(['Myth: Coffee dehydrates you', 'True: Water before meals can make you less hungry', 'Partly true: You need eight glasses a day']);
  assert.deepEqual(validatePost(ok, [], null, 'myth'), []);
  // The same everyday-belief rules apply to every verdict.
  assert.match(validatePost(verdictPost(['Myth: Coffee dehydrates you', 'True: Patients need less water', 'Partly true: Thirst is a good guide']), [], null, 'myth').join(), /everyday beliefs/);
  assert.match(validatePost(verdictPost(['Myth: Coffee dehydrates you', 'True: Juice does not count', 'Partly true: Thirst is a good guide']), [], null, 'myth').join(), /the way people believe it/);
  assert.match(validatePost(verdictPost(['Myth: Coffee dehydrates you', 'Fact: Thirst is a good guide']), [], null, 'myth').join(), /at least 3/);
});

test('myth posts are easy for everyone: short sentences, no study jargon', () => {
  const heads = ['Myth: Coffee dehydrates you', 'True: Food gives you water too', 'Partly true: You need eight glasses a day'];
  const jargon = 'A randomized crossover trial found acute changes that correlate with subcutaneous fat in participants. ';
  const r = validatePost(verdictPost(heads, easy(150) + ' ' + jargon.repeat(4)), [], null, 'myth').join();
  assert.match(r, /everyday words instead of: randomized, crossover, acute, correlate, subcutaneous, participants/);
  const longSentences = Array.from({ length: 20 }, () => 'People often say that you must drink eight full glasses of plain water every single day to stay well.').join(' ');
  assert.match(validatePost(verdictPost(heads, longSentences), [], null, 'myth').join(), /keep it under 16/);
});

test('a too-long myth post is told which sentences to split', () => {
  const md = '## Myth: X\n\nShort one. This sentence is clearly the longest one in the whole little text here today. Mid length sentence here.';
  assert.deepEqual(longestSentences(md, 1), ['This sentence is clearly the longest one in the whole little text here today']);
  const heads = ['Myth: Coffee dehydrates you', 'True: Food gives you water too', 'Partly true: You need eight glasses a day'];
  const long = Array.from({ length: 20 }, (_, i) => `People often say that you must drink eight full glasses of plain water every single day number ${i}.`).join(' ');
  assert.match(validatePost(verdictPost(heads, long), [], null, 'myth').join(), /split these into two: "The truth: People often say/);
});

test('beliefProblem flags planned myths the post check would always reject', () => {
  assert.match(beliefProblem('Eating whole eggs increases your risk of heart disease'), /disease/);
  assert.match(beliefProblem("Coffee doesn't hydrate you"), /denial/);
  assert.equal(beliefProblem('Eggs are bad for your heart'), null);
  assert.equal(beliefProblem('Eating eggs every day raises your cholesterol levels'), null);
});

test('plainWords swaps study words for everyday ones and keeps the grammar', () => {
  const post = {
    title: 'Myth or truth: eggs',
    summary: 'A meta-analysis says so.',
    body: 'Participants ate eggs. In a randomized trial, they felt full. Randomized controlled trials agree. '
      + 'An analysis found a statistically significant rise in plasma levels. Two meta-analyses looked too.',
  };
  assert.deepEqual(plainWords(post).sort(), ['meta-analyses', 'meta-analysis', 'participants', 'plasma', 'randomized', 'randomized controlled trials', 'statistically significant']);
  assert.equal(post.summary, 'A large review says so.');
  assert.equal(post.body, 'People ate eggs. In a trial, they felt full. Trials agree. '
    + 'An analysis found a clear rise in blood levels. Two large reviews looked too.');
  // The swapped post no longer trips the jargon check for those words.
  assert.ok(!validatePost({ ...post, body: post.body }, [], null, 'myth').some((e) => /everyday words instead of: .*(participants|meta-analysis)/.test(e)));
});

test('plainWords leaves other text and words without a safe swap alone', () => {
  const post = { title: 'Myth or truth: sleep', summary: 'Short.', body: 'This correlates with sleep. A cohort of adults.' };
  assert.deepEqual(plainWords(post), []);
  assert.equal(post.body, 'This correlates with sleep. A cohort of adults.');
});

test('the first post in the 3 weeks before a season is about that season', async () => {
  const { seasonFor, seasonNote } = await import('./validate.mjs');
  const before = [{ createdAt: '2026-11-08T20:00:00Z' }];
  // Nov 8: the winter window (from Nov 10) has not opened yet.
  assert.equal(seasonFor(before, new Date('2026-11-08T21:00:00Z')), null);
  // Nov 11, no post since the window opened: winter.
  const s = seasonFor(before, new Date('2026-11-11T11:17:00Z'));
  assert.deepEqual({ name: s.name, start: s.start, days: s.days }, { name: 'winter', start: '2026-12-01', days: 20 });
  assert.match(seasonNote(s), /winter starts in the US on 2026-12-01/);
  // Once a post went out in the window, the rest are ordinary.
  assert.equal(seasonFor([...before, { createdAt: '2026-11-11T11:30:00Z' }], new Date('2026-11-14T11:17:00Z')), null);
  // From Dec 1 the window is over.
  assert.equal(seasonFor(before, new Date('2026-12-01T11:17:00Z')), null);
  // Feb 10 is inside the spring window (spring starts Mar 1).
  assert.equal(seasonFor([], new Date('2027-02-10T11:17:00Z')).name, 'spring');
  // No posts at all yet: still seasonal inside a window.
  assert.equal(seasonFor([], new Date('2026-08-20T11:17:00Z')).name, 'fall');
});
