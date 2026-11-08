// The weekly Health IQ test: written on Monday (US Eastern), saved on the site as a DRAFT for the owner to
// review in Admin → Health IQ. The site shares it once published (Wednesday 9 AM Eastern; see shareQuizzes in run.mjs).
// Same rules as the site's Quiz\WeeklyQuizzes::validate.
import { BANNED } from './validate.mjs';

const ET = 'America/New_York';

// "YYYY-MM-DD" and weekday (1 = Monday … 7 = Sunday) of a moment in US Eastern.
function easternDay(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
  return { ymd: `${parts.year}-${parts.month}-${parts.day}`, weekday };
}

// This week's Monday in US Eastern, as "YYYY-MM-DD".
export function weekStart(now) {
  const { ymd, weekday } = easternDay(now);
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (weekday - 1));
  return d.toISOString().slice(0, 10);
}

// A test is due when none was written since Monday (US Eastern) of this week. The first try on Monday writes it;
// if Gemini is busy all day, Tuesday's tries do.
export function isQuizDue(quizzes, now) {
  const monday = weekStart(now);
  return !quizzes.some((q) => easternDay(new Date(q.createdAt)).ymd >= monday);
}

// The built-in tests on /quizzes/ (their slugs say the topic), so the new one picks something else.
export const builtInTopics = (html) => [...new Set([...String(html).matchAll(/href="\/quizzes\/([a-z0-9-]+)\/"/g)].map((m) => m[1]))];

export const QUIZ_SYSTEM = 'You write short, friendly health quizzes for an independent US wellness website. Readers are ordinary people, not clinicians. '
  + 'Accuracy comes first: every right answer must match current guidance from a public health body, and a reviewer checks each test before it is published. '
  + 'General information only: no medicines, doses, diagnoses or treatment advice, no brands, no hype.';

const COLORS = { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string' }, description: 'Two #rrggbb colours for the result card: a deep one and a light one, calm and natural.' };

export const QUIZ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'title', 'emoji', 'intro', 'questions', 'results', 'relatedPost', 'photoQueries'],
  properties: {
    slug: { type: 'string', description: 'Short URL name, lowercase words joined by hyphens, e.g. "fiber-facts".' },
    title: { type: 'string', description: 'A playful question title, at most 60 characters, e.g. "How fiber-smart are you?"' },
    emoji: { type: 'string', description: 'One emoji for the topic.' },
    intro: { type: 'string', description: 'One sentence, e.g. "Seven quick questions about fiber. See how you score."' },
    questions: {
      type: 'array',
      minItems: 7,
      maxItems: 7,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['q', 'choices', 'explain', 'source'],
        properties: {
          q: { type: 'string', description: 'The question, at most 140 characters.' },
          choices: {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text', 'correct'],
              properties: { text: { type: 'string', description: 'At most 70 characters.' }, correct: { type: 'boolean' } },
            },
          },
          explain: { type: 'string', description: 'Why the right answer is right, 1–2 plain sentences (at most 300 characters).' },
          source: { type: 'string', description: 'The public health body this follows, e.g. "CDC", "NIH", "WHO", "American Heart Association".' },
        },
      },
    },
    results: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['slug', 'title', 'emoji', 'blurb', 'min', 'colors'],
        properties: {
          slug: { type: 'string' },
          title: { type: 'string', description: 'A fun, kind 2–3 word title, at most 30 characters, e.g. "Fiber Rookie".' },
          emoji: { type: 'string' },
          blurb: { type: 'string', description: 'One encouraging sentence, at most 160 characters.' },
          min: { type: 'integer', description: 'Lowest score for this result: 0, then about 3, then about 6.' },
          colors: COLORS,
        },
      },
    },
    relatedPost: { type: 'string', description: 'Slug of one blog post from the list that fits the topic, or "" if none does.' },
    photoQueries: {
      type: 'array',
      minItems: 2,
      maxItems: 3,
      items: { type: 'string' },
      description: 'Three stock-photo searches for a bright real scene about the topic, most specific first. No pills, bottles, packaging, syringes or text.',
    },
  },
};

export function quizPrompt({ topics, posts }) {
  return [
    'Write this week\'s "Health IQ" test for a US wellness website: a short, playful, multiple-choice quiz that teaches everyday health facts.',
    '',
    'Rules:',
    '- 7 questions, 3 answers each, exactly ONE correct. The wrong answers are believable but clearly wrong to an expert.',
    '- Every fact must match current guidance from a public health body (CDC, NIH, WHO, USDA, FDA, AHA, AAD, AAO, Mayo Clinic). Name it as the source.',
    '- Plain American English, friendly, no jargon. Everyday habits: food, water, sleep, movement, sun, eyes, stress, skin, labels.',
    '- No medicines, drugs, doses, diagnoses or treatment advice. Never say a food or habit cures, treats or prevents a disease.',
    `- Avoid these words: ${BANNED.join(', ')}.`,
    '- Results: 3 kind titles from beginner to expert, scored from 0 (min 0, then about 3, then about 6).',
    '',
    `Topics the site already has tests on (pick a DIFFERENT one): ${topics.join(', ') || 'none'}.`,
    posts.length ? `Blog posts you may link (relatedPost, or ""):\n${posts.map((p) => `- ${p.slug}: ${p.title}`).join('\n')}` : 'relatedPost: "".',
  ].join('\n');
}

/** Problems with a written test (empty when it is fine). Mirrors the site's checks. */
export function quizProblems(q) {
  const out = [];
  const str = (v, max) => typeof v === 'string' && v.trim() !== '' && v.trim().length <= max;
  if (typeof q?.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(q.slug) || q.slug.length > 80) out.push('slug: lowercase words joined by hyphens');
  if (!str(q?.title, 90)) out.push('title: at most 90 characters');
  if (!str(q?.intro, 240)) out.push('intro: at most 240 characters');
  if (!str(q?.emoji, 8)) out.push('emoji: one emoji');
  const questions = Array.isArray(q?.questions) ? q.questions : [];
  if (questions.length < 6 || questions.length > 8) out.push('questions: 6 to 8');
  questions.forEach((item, i) => {
    const choices = Array.isArray(item?.choices) ? item.choices : [];
    const texts = choices.map((c) => String(c?.text ?? '').trim().toLowerCase());
    const ok =
      str(item?.q, 200) && str(item?.explain, 400) && str(item?.source, 80) && choices.length >= 3 && choices.length <= 4
      && choices.every((c) => str(c?.text, 120)) && choices.filter((c) => c?.correct === true).length === 1 && new Set(texts).size === texts.length;
    if (!ok) out.push(`question ${i + 1}: 3–4 different answers with exactly one correct, an explanation and a source`);
  });
  const results = Array.isArray(q?.results) ? q.results : [];
  if (results.length !== 3) out.push('results: exactly 3');
  const resultsOk = results.every(
    (r) => typeof r?.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.slug) && r.slug.length <= 40 && str(r?.title, 40) && str(r?.emoji, 8)
      && str(r?.blurb, 240) && Number.isInteger(r?.min) && r.min >= 0 && r.min <= questions.length
      && Array.isArray(r?.colors) && r.colors.length === 2 && r.colors.every((c) => /^#[0-9a-f]{6}$/i.test(c)),
  );
  if (!resultsOk) out.push('results: slug, title (≤ 40), emoji, blurb (≤ 240), min score and two #rrggbb colours');
  else if (results.length === 3 && (results[0].min !== 0 || results[0].min >= results[1].min || results[1].min >= results[2].min || new Set(results.map((r) => r.slug)).size !== 3)) {
    out.push('results: different slugs and min scores rising from 0 (e.g. 0, 3, 6)');
  }
  const text = JSON.stringify([q?.title, q?.intro, questions, results]);
  const banned = BANNED.find((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
  if (banned) out.push(`must not use "${banned}"`);
  return out;
}

/** What goes to the site: the test without the helper fields, the related post only if it is a real one. */
export function quizPayload(q, postSlugs) {
  const { photoQueries, relatedPost, ...quiz } = q;
  void photoQueries;
  return { ...quiz, ...(relatedPost && postSlugs.includes(relatedPost) ? { related: { post: relatedPost } } : {}) };
}

/** The post shared to Facebook/Instagram for a published test. */
export const quizShare = (q) => ({
  kind: 'quiz',
  title: `${q.emoji} ${q.title}`,
  summary: `${q.intro} ${q.questions} questions, about a minute. How many can you get right?`,
  url: q.url,
  imageUrl: q.imageUrl,
  tags: ['healthquiz', 'healthiq'],
  product: null,
});
