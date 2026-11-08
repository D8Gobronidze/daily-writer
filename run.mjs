// Writes one researched blog post and publishes it through the site's automation endpoint.
// Runs daily on GitHub Actions; it only writes when the newest automated post is 3+ days old.
// Free: Gemini (free tier) picks a topic and writes; Europe PMC (free) supplies the studies.
// Env: SITE_URL, BLOG_AUTOMATION_TOKEN, GEMINI_API_KEY.
import { readFile } from 'node:fs/promises';
import { LIGHT_MODELS, askJson } from './gemini.mjs';
import { findPapers, mythNotes, notesFrom, researchBeliefs } from './sources.mjs';
import { findPhoto } from './photos.mjs';
import { checkToken, commentOn, sharePost, wentOut } from './social.mjs';
import { pingIndexNow } from './indexnow.mjs';
import { EDU, MYTH, beliefProblem, isDue, plainWords, seasonFor, seasonNote, slugsFromLlms, styleFor, validatePost, MIN_WORDS, MAX_WORDS } from './validate.mjs';

const MIN_PAPERS = 4;
// A secret pasted with a stray space or line break must still work (Pixabay answered 400 to one).
for (const k of ['SITE_URL', 'BLOG_AUTOMATION_TOKEN', 'GEMINI_API_KEY', 'PIXABAY_API_KEY', 'META_PAGE_TOKEN', 'META_PAGE_NAME']) {
  if (process.env[k] !== undefined) process.env[k] = process.env[k].trim();
}
const site = (process.env.SITE_URL ?? '').replace(/\/+$/, '');
const token = process.env.BLOG_AUTOMATION_TOKEN ?? '';

async function siteFetch(path, init = {}) {
  const res = await fetch(`${site}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${init.method ?? 'GET'} ${path} → HTTP ${res.status}: ${text.slice(0, 500)}`), { status: res.status, body: text });
  return text;
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['topic', 'why', 'searches'],
  properties: {
    topic: { type: 'string', description: 'The post idea in one line.' },
    why: { type: 'string', description: 'Why it helps shoppers now.' },
    searches: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['main', 'about'],
        properties: {
          main: { type: 'string', description: 'The ingredient or nutrient, as it appears in study titles, e.g. "vitamin D".' },
          about: { type: 'array', maxItems: 4, items: { type: 'string' }, description: 'Outcome words, e.g. ["sleep", "insomnia"]. Empty for any.' },
        },
      },
    },
  },
};

// Myth posts: the beliefs first, each with the search that finds studies about it.
const MYTH_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['topic', 'beliefs'],
  properties: {
    topic: { type: 'string', description: 'The theme in a few words, e.g. "drinking water".' },
    beliefs: {
      type: 'array',
      minItems: 4,
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['belief', 'search'],
        properties: {
          belief: { type: 'string', description: 'The belief as people say it, a positive statement, e.g. "Coffee dehydrates you".' },
          search: PLAN_SCHEMA.properties.searches.items,
        },
      },
    },
  },
};

// What a good stock-photo search looks like: a real, bright, eye-catching scene with people or food,
// never pills, bottles, text or medical close-ups.
const PHOTO_HINT = 'Three stock-photo searches for a bright, eye-catching real scene that fits the post, most specific first: e.g. ["woman stretching in morning sunlight", "woman stretching", "morning yoga"]. The first 3–5 words, the last 1–2 common words. No pills, bottles, packaging, syringes or text.';
const PHOTO_QUERIES = { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' }, description: PHOTO_HINT };

const POST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'slug', 'kind', 'summary', 'body', 'sources', 'categorySlug', 'tags', 'photoQueries'],
  properties: {
    title: { type: 'string' },
    slug: { type: 'string' },
    kind: { type: 'string', enum: ['guide', 'news'] },
    summary: { type: 'string' },
    body: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'url'],
        properties: { title: { type: 'string' }, url: { type: 'string' } },
      },
    },
    categorySlug: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    photoQueries: PHOTO_QUERIES,
  },
};

const PHOTO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['photos'],
  properties: {
    photos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['slug', 'photoQueries'],
        properties: { slug: { type: 'string' }, photoQueries: PHOTO_QUERIES },
      },
    },
  },
};

// What each kind of post asks for. Every third post is "Myth vs. truth" on everyday health and nutrition
// (validate.mjs checks it). The educational style is kept for manual use.
const STYLE = {
  standard: {
    topic: 'a supplement, vitamin, mineral, herb or nutrition question that would genuinely help shoppers',
    main: 'the ingredient as it appears in study titles, e.g. "vitamin D"',
    body: `${MIN_WORDS + 100}–${MAX_WORDS - 200} words, with "##" headings. Explain what the studies found and how strong the evidence is (say when studies are small or mixed).`,
  },
  myth: {
    topic: 'a "Myth vs. truth" post: 3 to 5 popular beliefs about ONE everyday HEALTH or NUTRITION theme (for example breakfast, drinking water, sleep, sugar, eggs, protein, fat, carbs, coffee, digestion, skin and sun, exercise and age, vitamins from food), each one a belief ordinary healthy adults commonly hold (things friends say, or you read in magazines) and checkable against studies in healthy adults or the general population. Not about patients, diseases, hospitals, care homes, children, medicines, drugs, doses or brands, and not a theme the blog already covered',
    main: 'the theme as it appears in study titles, e.g. "breakfast", "dietary sugar", "egg consumption"',
    body: `${MYTH.min + 300}–${MYTH.max - 200} words, about 180 words per belief. Write so that EVERY reader understands it: a 12-year-old, an older person, someone whose first language isn't English. Everyday words only; sentences of about 12 words; never study jargon (no "randomized", "crossover", "acute", "correlates", "participants", "subcutaneous"): say "a study of 200 adults", "right away", "is linked to". Turn numbers into everyday terms ("500 ml, about two cups"). Start with 2 or 3 short sentences on why these beliefs are common. Then one section per belief in the notes, in that order, headed by what the studies found: "## Myth: <the belief>" when they show it is wrong, "## True: <the belief>" when they back it up, "## Partly true: <the belief>" when it is mixed. Keep the belief's wording, a positive statement. Under each heading, "**The truth:** " and in 6 to 10 short sentences what the studies found and what it means in daily life. End with "## What this means for you" and 3 to 5 practical tips as a list. Never mention medicines, drugs or doses.`,
  },
  educational: {
    topic: 'an EDUCATIONAL health topic for everyday readers: how a part of the body works (sleep, digestion, skin, muscles, the heart, hormones) or a healthy habit (food, movement, rest, water, sunlight, stress). It must NOT be about supplements, vitamins in pill form, medicines, drugs or doses',
    main: 'the topic as it appears in study titles, e.g. "sleep hygiene", "dietary fiber", "physical activity"',
    body: `${EDU.min + 50}–${EDU.max - 50} words, with 3 or 4 short "##" headings. Write for a 12-year-old: short sentences (about 12 words), everyday words, explain any term the first time. End with 3 to 5 simple, practical tips as a list. Never mention supplements, pills, medicines, drugs or doses.`,
  },
};

// Picks a topic and the study searches for it.
// `theme`: rewriting an existing post, so keep its theme instead of picking a new one.
const plan = (system, context, style, feedback, theme = null) =>
  askJson({
    system,
    schema: PLAN_SCHEMA,
    models: LIGHT_MODELS,
    prompt: `${context}

${theme ? `You are REWRITING the existing post "${theme}". Keep its theme and describe the topic as: ${STYLE[style].topic.replace(/,? ?and not a theme the blog already covered/, '')}. It` : `Pick ONE topic for the next post: ${STYLE[style].topic}. The blog must not cover it yet, and it`} must have recent human research (reviews, meta-analyses or clinical trials). Then give 1 to 3 study searches that will find that research: "main" is ${STYLE[style].main}; "about" the outcome words.${feedback ? `\n\nYour previous idea did not work: ${feedback} Pick a different, better-researched topic.` : ''}`,
  });

// Myth posts: pick the popular beliefs first, each with the study search that checks it.
const planMyths = (system, context, feedback, theme = null, note = '') =>
  askJson({
    system,
    schema: MYTH_PLAN_SCHEMA,
    models: LIGHT_MODELS,
    prompt: `${context}

${theme ? `You are REWRITING the existing post "${theme}": keep its theme.` : 'Pick ONE theme for the next post that the blog does not cover yet.'} The post is ${STYLE.myth.topic.replace(/,? ?and not a theme the blog already covered/, '')}.

${note ? `The owner asked: ${note}\n\n` : ''}List 4 to 6 beliefs about that theme that ordinary people really say (the kind of thing a friend tells you; never about lab tests, scans or measurements, and never naming a disease, illness or condition: say "Eggs are bad for your heart", not "Eggs cause heart disease"), each written the way people say it, as a positive statement ("Coffee dehydrates you", never "… does not …"). For each, give ONE study search that finds human research testing exactly that belief: "main" is the subject as it appears in study titles (e.g. "coffee", "water intake"); "about" the outcome words (e.g. ["hydration", "urine"]).${feedback ? `\n\nYour previous list did not work: ${feedback}` : ''}`,
  });

const write = (system, notes, context, topic, style, feedback) =>
  askJson({
    system,
    schema: POST_SCHEMA,
    prompt: `${context}

Topic: ${topic}

Research notes: the ONLY facts you may use. Each study has its URL; cite only these URLs.
<notes>
${notes}
</notes>

Write the post as JSON:
- title: ${style === 'myth' ? 'starts with "Myth or truth:" and names the theme, under 70 characters (e.g. "Myth or truth: 4 beliefs about breakfast").' : `specific and useful, no clickbait, short enough to fit two lines on a phone: under ${style === 'educational' ? 60 : 70} characters (e.g. "Omega-3 and your heart: what trials show").`}
- slug: lowercase words joined by hyphens, from the title.
- kind: ${style === 'standard' ? '"news" if it is about research from the last 6 months, otherwise "guide".' : '"guide".'}
- summary: one or two ${style === 'standard' ? '' : 'short, simple '}sentences, under 300 characters, for the blog list and search results.
- body: Markdown, ${STYLE[style].body} Do not repeat the title as a heading and do not include a sources section (the site adds one).
- sources: 3 to 8 of the study URLs from the notes you relied on, each with a short plain title.
- categorySlug: one slug from the category list.
- tags: 1 to 3 names from the tag list (without #) that best describe the post.
- photoQueries: ${PHOTO_HINT}${feedback ? `\n\nYour previous attempt was rejected for these reasons; fix them all:\n- ${feedback.join('\n- ')}` : ''}`,
  });

const PICK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pick', 'why'],
  properties: {
    pick: { type: 'integer', description: 'The number of the best photo, or 0 if none truly fits.' },
    why: { type: 'string', description: 'One short sentence.' },
  },
};

// Gemini looks at the candidate photos and picks the one a reader would instantly connect to the post.
const chooser = (post) => async (images) => {
  const { pick, why } = await askJson({
    system: 'You choose cover photos for a health and wellness blog.',
    schema: PICK_SCHEMA,
    models: LIGHT_MODELS,
    images,
    prompt: `Blog post: "${post.title}"\n${post.summary}\n\nThe ${images.length} photos below are numbered 1 to ${images.length} in order. They are deliberately real-life scenes, never products or pills: the cover should show the everyday side of the topic (the food, the activity, the person, the setting). Pick the photo a reader would most naturally connect with this post's theme, preferring bright, appealing, natural-looking ones. Answer 0 only if every photo is off-topic, shows visible text or logos, or is unpleasant.`,
  });
  console.log(`    Gemini picked ${pick || 'none'} of ${images.length}: ${why}`);
  return pick;
};

// Finds, downloads and stores a photo for a post; `used` (photo sources) grows so no photo repeats.
// Returns the search that found it, or null. `replace`: swap a photo the automation chose earlier.
async function attachPhoto(post, queries, used, replace = false) {
  const photo = await findPhoto(queries, { used, choose: chooser(post) });
  if (!photo) return null;
  const slug = post.slug;
  await siteFetch(`/api/automation/photos/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    body: JSON.stringify({ image: photo.image, source: photo.source, replace }),
  });
  used.push(photo.source);
  return photo.query;
}

// Gives every published post without a photo a real one (older posts, or a run where Pixabay was down).
// Never replaces a photo; a failure here never stops the day's post.
// REDO_PHOTOS=1 (the workflow's "Redo photos" switch) also re-picks photos the automation chose.
async function addMissingPhotos(system) {
  if (!process.env.PIXABAY_API_KEY) return;
  const redo = process.env.REDO_PHOTOS === '1' || process.env.REDO_PHOTOS === 'true';
  try {
    const { posts, usedSources } = JSON.parse(await siteFetch(`/api/automation/photos${redo ? '?redo=1' : ''}`));
    if (!posts.length) return;
    console.log(`Finding photos for ${posts.length} post(s)…`);
    const { photos } = await askJson({
      system,
      schema: PHOTO_SCHEMA,
      models: LIGHT_MODELS,
      prompt: `Suggest a stock-photo search for each blog post.\n\n${posts.map((p) => `- slug: ${p.slug}\n  title: ${p.title}\n  summary: ${p.summary}`).join('\n')}`,
    });
    const used = [...usedSources];
    for (const p of posts) {
      const queries = photos.find((x) => x.slug === p.slug)?.photoQueries ?? [];
      const found = await attachPhoto(p, queries, used, redo);
      console.log(found ? `  ${p.slug}: photo for "${found}"` : `  ${p.slug}: no good match for ${JSON.stringify(queries)}; keeping what it has`);
    }
  } catch (err) {
    console.log(`Photos skipped: ${err instanceof Error ? err.message : err}`);
  }
}

// Shares a published post to Facebook and Instagram (when META_PAGE_TOKEN is set) and records it on the
// site once either network took it, so it is never shared twice; never fails the run.
async function share(slug) {
  if (!process.env.META_PAGE_TOKEN) return;
  try {
    const p = JSON.parse(await siteFetch(`/api/posts/${encodeURIComponent(slug)}`));
    const image = p.cover?.imageUrl ? (p.cover.imageUrl.startsWith('/') ? site + p.cover.imageUrl : p.cover.imageUrl) : null;
    const result = await sharePost({ title: p.title, summary: p.summary, url: p.url, imageUrl: image, tags: p.tags ?? [], product: p.product ?? null }, { only: (process.env.SHARE_ONLY ?? '').trim() });
    console.log(`Shared ${slug}: ${JSON.stringify(result)}`);
    if (wentOut(result) && !process.env.SHARE_ONLY) await siteFetch(`/api/automation/shared/${encodeURIComponent(slug)}`, { method: 'PUT', body: '{}' });
  } catch (err) {
    console.log(`Sharing ${slug} failed: ${err instanceof Error ? err.message : err}`);
  }
}

// Posts published but not shared yet, e.g. ones the owner published in Admin.
async function shareWaiting() {
  if (!process.env.META_PAGE_TOKEN) return;
  try {
    const { posts } = JSON.parse(await siteFetch('/api/automation/unshared'));
    for (const slug of posts) await share(slug);
  } catch (err) {
    console.log(`Sharing waiting posts skipped: ${err instanceof Error ? err.message : err}`);
  }
}

async function main() {
  // CHECK_FACEBOOK (the workflow's "Check the Facebook token" input): test META_PAGE_TOKEN, post nothing.
  if (process.env.CHECK_FACEBOOK === 'true') {
    for (const line of await checkToken()) console.log(line);
    return;
  }
  if (!site || !token || !process.env.GEMINI_API_KEY) throw new Error('Set SITE_URL, BLOG_AUTOMATION_TOKEN and GEMINI_API_KEY');

  const system = await readFile(new URL('./prompt.md', import.meta.url), 'utf8');
  await addMissingPhotos(system);

  // COMMENT_ON (+ SHARE_SLUG for the link): add the first comment to posts already out, post nothing new.
  const commentIds = (process.env.COMMENT_ON ?? '').trim();
  if (commentIds) {
    const slug = (process.env.SHARE_SLUG ?? '').trim().replace(/^.*\/blog\//, '').replace(/\/+$/, '');
    if (!slug) throw new Error('COMMENT_ON needs the post address in "Share an existing post".');
    const { url } = JSON.parse(await siteFetch(`/api/posts/${encodeURIComponent(slug)}`));
    console.log(`Comments: ${JSON.stringify(await commentOn(commentIds, url))}`);
    return;
  }
  // SHARE_SLUG (the workflow's "Share a post" input): share one existing post now, write nothing.
  const shareSlug = (process.env.SHARE_SLUG ?? '').trim().replace(/^.*\/blog\//, '').replace(/\/+$/, '');
  if (shareSlug) {
    await share(shareSlug);
    return;
  }
  await shareWaiting();

  const { runs } = JSON.parse(await siteFetch('/api/automation/posts'));

  // REWRITE_SLUG (the workflow's "Rewrite a post"): write one of this automation's posts again, under the
  // same address, keeping its date, photo and share record. Nothing new is published or shared.
  const rewriteSlug = (process.env.REWRITE_SLUG ?? '').trim().replace(/^.*\/blog\//, '').replace(/\/+$/, '');
  if (rewriteSlug) {
    const old = runs.find((r) => r.slug === rewriteSlug);
    if (!old) throw new Error(`"${rewriteSlug}" is not a post this automation wrote; nothing was changed.`);
    const style = ['myth', 'standard'].includes(process.env.POST_STYLE ?? '') ? process.env.POST_STYLE : /\bmyths?\b/i.test(old.title) ? 'myth' : 'standard';
    console.log(`Rewriting ${rewriteSlug} (${style}).`);
    const { context, llms } = await siteContext(runs.filter((r) => r.slug !== rewriteSlug));
    const note = (process.env.REWRITE_NOTE ?? '').trim();
    await researchAndWrite({
      system, context, style, theme: old.title,
      existing: [...runs.map((r) => r.slug), ...slugsFromLlms(llms)].filter((x) => x !== rewriteSlug),
      firstFeedback: note ? [`the owner asked for a rewrite: ${note}`] : null,
      note,
      fixSlug: rewriteSlug,
      publish: async (ready) => {
        const result = JSON.parse(await siteFetch(`/api/automation/posts/${encodeURIComponent(rewriteSlug)}`, { method: 'PUT', body: JSON.stringify(ready) }));
        console.log(`Rewritten: ${result.url}`);
        console.log(`IndexNow: ${await pingIndexNow([result.url], { site })}`);
      },
    });
    return;
  }

  // FORCE_POST (the workflow's "Publish now" switch) writes a post even before the 3 days are up.
  const force = process.env.FORCE_POST === '1' || process.env.FORCE_POST === 'true';
  if (!force && !isDue(runs, new Date())) {
    console.log(`Not due: the last automated post was ${runs[0].createdAt}.`);
    return;
  }

  const { context: siteNotes, llms } = await siteContext(runs);

  // POST_STYLE (workflow input) picks the style for this one run; otherwise every third post is a myth post.
  const style = ['myth', 'standard'].includes(process.env.POST_STYLE ?? '') ? process.env.POST_STYLE : styleFor(runs);
  // The first post in the 3 weeks before a season starts is about that season (either style).
  const season = seasonFor(runs, new Date());
  const context = season ? `${siteNotes}\n\n${seasonNote(season)}` : siteNotes;
  console.log(`Post #${runs.length + 1}: ${style}${season ? `, about ${season.name}` : ''}.`);

  await researchAndWrite({
    system, context, style,
    existing: [...runs.map((r) => r.slug), ...slugsFromLlms(llms)],
    publish: async (ready, photoQueries) => {
      const result = JSON.parse(await siteFetch('/api/automation/posts', { method: 'POST', body: JSON.stringify(ready) }));
      console.log(`Published: ${result.url}`);
      // Tell Bing (and so ChatGPT search / Copilot) about the new post and the updated blog list right away.
      console.log(`IndexNow: ${await pingIndexNow([result.url, `${site}/blog/`], { site })}`);
      // The photo comes second: a post without one still goes out (and gets one on a later run).
      if (process.env.PIXABAY_API_KEY) {
        try {
          const { usedSources } = JSON.parse(await siteFetch('/api/automation/photos'));
          const found = await attachPhoto(ready, photoQueries, usedSources);
          console.log(found ? `Photo: "${found}"` : `No good photo match for ${JSON.stringify(photoQueries)}; the post keeps its cover.`);
        } catch (err) {
          console.log(`No photo: ${err instanceof Error ? err.message : err}`);
        }
      }
      await share(ready.slug);
    },
  });
}

// What the writer is told about the site: categories, tags, posts on the blog, and past automated topics.
async function siteContext(runs) {
  const categories = JSON.parse(await siteFetch('/api/categories'));
  // The site's #tags (one shared list); posts may only use these.
  const bundle = categories.length ? JSON.parse(await siteFetch(`/api/categories/${categories[0].slug}`)) : { tags: [] };
  const tagList = (bundle.tags ?? []).map((t) => `#${t.name}`).join(' ');
  const llms = await siteFetch('/llms.txt');
  const onSite = llms.includes('## Blog') ? llms.slice(llms.indexOf('## Blog')) : '(no posts yet)';
  const pastTitles = runs.map((r) => `- ${r.title}`).join('\n') || '(none yet)';
  const context = `Categories (slug: name):\n${categories.map((c) => `- ${c.slug}: ${c.name}`).join('\n')}

Tags you may use:\n${tagList}

Already on the blog:\n${onSite}

Topics written by this automation before (including ones the owner removed; never repeat these):\n${pastTitles}

Today is ${new Date().toISOString().slice(0, 10)}.`;
  return { context, llms };
}

// Finds research, writes the post and hands it to `publish` once it passes every rule (3 tries each).
// `theme`/`fixSlug`: a rewrite keeps the old post's theme and address.
async function researchAndWrite({ system, context, style, existing, publish, theme = null, fixSlug = null, firstFeedback = null, note = '' }) {
  // Find a topic with enough research behind it (up to 3 ideas).
  let topic = null;
  let papers = [];
  let feedback = null;
  let notes = null;
  // Myth posts: the beliefs first, then studies for each one; at least 3 beliefs must have studies.
  for (let attempt = 1; style === 'myth' && attempt <= 3 && !notes; attempt++) {
    const idea = await planMyths(system, context, feedback, theme, note);
    // Beliefs the post check would always reject (e.g. "… heart disease") are dropped here, not after 5 writes.
    const problems = idea.beliefs.map((b) => beliefProblem(b.belief)).filter(Boolean);
    if (problems.length) console.log(`Dropped: ${problems.join('; ')}.`);
    const usable = idea.beliefs.filter((b) => !beliefProblem(b.belief));
    const kept = (await researchBeliefs(usable)).slice(0, 5);
    console.log(`Idea ${attempt}: ${idea.topic}: ${kept.length} of ${idea.beliefs.length} beliefs usable with studies (${kept.map((k) => k.belief).join(' | ')}).`);
    if (kept.length >= MYTH.minMyths) {
      notes = mythNotes(kept);
      papers = [...new Map(kept.flatMap((k) => k.papers).map((p) => [p.url, p])).values()];
      topic = `Myth or truth about ${idea.topic}. Cover exactly these beliefs, in this order: ${kept.map((k) => `"${k.belief}"`).join(', ')}.`;
    } else {
      const missing = usable.filter((b) => !kept.some((k) => k.belief === b.belief)).map((b) => `"${b.belief}"`);
      feedback = [
        missing.length ? `no studies were found for ${missing.join(', ')}. Pick beliefs that researchers have actually tested.` : '',
        problems.length ? `These can't be used: ${problems.join('; ')}.` : '',
      ].filter(Boolean).join(' ');
    }
  }
  if (style === 'myth' && !notes) throw new Error('No myth theme with studies for 3 beliefs was found; nothing was published.');
  for (let attempt = 1; style !== 'myth' && attempt <= 3 && papers.length < MIN_PAPERS; attempt++) {
    const idea = await plan(system, context, style, feedback, theme);
    console.log(`Idea ${attempt}: ${idea.topic}`);
    papers = await findPapers(idea.searches);
    console.log(`Found ${papers.length} studies.`);
    topic = idea.topic;
    if (papers.length < MIN_PAPERS) feedback = `only ${papers.length} recent studies were found for "${idea.topic}".`;
  }
  if (style !== 'myth' && papers.length < MIN_PAPERS) throw new Error('No topic with enough recent research was found; nothing was published.');
  notes ??= notesFrom(papers);
  const allowed = papers.map((p) => p.url);

  feedback = firstFeedback;
  // Myth posts get 5 tries: short sentences AND enough words is the hardest mix for the writer.
  const tries = style === 'myth' ? 5 : 3;
  for (let attempt = 1; attempt <= tries; attempt++) {
    console.log(`Writing (attempt ${attempt})…`);
    let post;
    try {
      post = await write(system, notes, context, topic, style, feedback);
      if (fixSlug) post.slug = fixSlug;
    } catch (err) {
      if (!err.invalidJson) throw err;
      post = { _error: 'the response was not valid JSON' };
    }
    // Myth posts: swap simple study words for everyday ones here instead of rejecting the post for them.
    if (!post._error && style === 'myth') {
      const swapped = plainWords(post);
      if (swapped.length) console.log(`Plain words: replaced ${swapped.join(', ')}.`);
    }
    let errors = post._error ? [post._error] : validatePost(post, existing, allowed, style);
    if (errors.length === 0) {
      const { photoQueries, ...ready } = post;
      try {
        await publish(ready, photoQueries);
        return;
      } catch (err) {
        // The site refused it (slug taken, or a rule the local check missed): try once more with the reason.
        if (err.status !== 409 && err.status !== 422) throw err;
        errors = [err.status === 409 ? `slug "${post.slug}" is already used; choose another` : `the site rejected it: ${err.body}`];
      }
    }
    console.log(`Rejected: ${errors.join('; ')}`);
    feedback = errors;
  }
  throw new Error(`The post failed validation ${tries} times; nothing was published.`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  // Busy free services (Gemini or Europe PMC) on an earlier scheduled try of the day: stop quietly and let the
  // next try write the post (nothing was published, so it is still due). Only the last try fails the run (and emails).
  if (err?.busy && process.env.LATER_TRY === 'true') {
    console.log(`::warning::The free services are busy (${message}). Nothing was published; the next try today will write the post.`);
    return;
  }
  console.error(message);
  process.exit(1);
});
