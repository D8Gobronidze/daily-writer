// Shares a new blog post to the site's Facebook Page and its linked Instagram account (free, Meta
// Graph API). One secret: META_PAGE_TOKEN, either a Page access token or a user / System User token
// that manages the Page (the Page's own token is then looked up; see docs/DEPLOY.md).
// Instagram needs a public JPEG, so posts without a photo go to Facebook only.
const GRAPH = 'https://graph.facebook.com/v26.0';

async function graph(path, { token, fetchFn, method = 'GET', params = {} }) {
  const url = new URL(`${GRAPH}${path}`);
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = method === 'GET' || method === 'DELETE'
    ? await fetchFn(`${url}?${body}`, method === 'DELETE' ? { method } : undefined)
    : await fetchFn(url, { method, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Meta ${method} ${path} → ${data.error?.message ?? `HTTP ${res.status}`}`);
  return data;
}

// "#gut-health" → "#guthealth": Instagram hashtags can't contain hyphens.
const hashtag = (t) => `#${String(t).replace(/[^a-z0-9]/gi, '')}`;

// A post about one brand's product has affiliate links: mark it first, before anything else (FTC). Owner: never the word "commission".
export const AD_NOTE = '#ad';
const adLine = (p) => (p.product ? [AD_NOTE, ''] : []);

// The site's name, from SITE_URL: "https://example.com" → "example" (Page name and first hashtag).
export const siteName = () => { try { return new URL(process.env.SITE_URL ?? '').hostname.split('.')[0]; } catch { return ''; } };

const hashtags = (p) => [...new Set([...(siteName() ? [`#${siteName()}`] : []), '#wellness', ...(p.tags ?? []).map(hashtag)])].join(' ');
// "https://example.com/blog/x/" → "example.com/blog/x": short enough to type from a phone.
const shortUrl = (url) => String(url).replace(/^https?:\/\//, '').replace(/\/+$/, '');

// A weekly Health IQ test (kind: 'quiz') invites people to take it instead of reading.
const isQuiz = (p) => p.kind === 'quiz';

export const facebookMessage = (p) => [...adLine(p), p.title, '', p.summary, '', `${isQuiz(p) ? 'Take the quiz' : 'Read it here'}: ${p.url}`, '', hashtags(p)].join('\n');

// Instagram never makes links in a caption clickable, so the post's address is written out in full.
export const instagramCaption = (p) =>
  [...adLine(p), p.title, '', p.summary, '', isQuiz(p) ? `Take the quiz at ${shortUrl(p.url)} 🧠` : `Read the full post at ${shortUrl(p.url)} 🌿`, '', hashtags(p)].join('\n');

// True when Facebook or Instagram published the post (an id, not "failed: …" or "skipped: …").
export const wentOut = (result) => ['facebook', 'instagram'].some((k) => typeof result?.[k] === 'string' && !/^(failed|skipped)/.test(result[k]));

const PAGE_FIELDS = 'id,name,access_token,instagram_business_account';

// The Page to post as and its token. A Page token is used as is; a user or System User token is
// swapped for the token of the Page it manages (the one named like the site, else the only one).
export async function resolvePage(token, fetchFn, name = process.env.META_PAGE_NAME || siteName()) {
  let pages = null;
  try {
    pages = (await graph('/me/accounts', { token, fetchFn, params: { fields: PAGE_FIELDS } })).data ?? [];
  } catch {
    // A Page token has no /me/accounts: it is the Page.
  }
  if (pages === null) {
    const page = await graph('/me', { token, fetchFn, params: { fields: 'id,name,instagram_business_account' } });
    return { page, pageToken: token };
  }
  const page = pages.find((p) => p.name?.toLowerCase() === name.toLowerCase()) ?? (pages.length === 1 ? pages[0] : null);
  if (!page) throw new Error(`The token manages ${pages.length} Pages and none is named "${name}"`);
  // This repo's logs are public: hide the looked-up Page token like a secret, should anything print it.
  if (process.env.GITHUB_ACTIONS && page.access_token) console.log(`::add-mask::${page.access_token}`);
  return { page, pageToken: page.access_token };
}

// The first comment under each shared post: the link to the full post (pages often put it there;
// on Facebook it's tappable). Needs pages_manage_engagement / instagram_manage_comments on the token.
export const firstComment = (p) => (isQuiz(p) ? `🧠 Take the quiz: ${p.url}` : `📖 Read the full post: ${p.url}`);

// Comments under a just-published post; a failure is recorded, never thrown.
async function comment(id, post, opts) {
  try {
    return (await graph(`/${id}/comments`, { ...opts, method: 'POST', params: { message: firstComment(post) } })).id;
  } catch (err) {
    return `failed: ${err.message}`;
  }
}

/**
 * Shares one post. `post`: {title, summary, url, imageUrl (absolute JPEG or null), tags}.
 * Returns what happened per network; a failure on one never stops the other.
 */
export async function sharePost(post, { token = process.env.META_PAGE_TOKEN, fetchFn = fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)), only = '' } = {}) {
  if (!token) return { skipped: 'META_PAGE_TOKEN is not set' };
  const { page, pageToken } = await resolvePage(token, fetchFn);
  const opts = { token: pageToken, fetchFn };
  const out = {};
  const comments = {};

  if (only === 'instagram') out.facebook = 'skipped: Instagram only';
  else try {
    // Facebook caches a link's preview (title, photo): have it read the page again first, so a post
    // that got its photo after an earlier share shows the new one. Best effort.
    await graph('/', { ...opts, method: 'POST', params: { id: post.url, scrape: 'true' } }).catch(() => {});
    const fb = await graph(`/${page.id}/feed`, { ...opts, method: 'POST', params: { message: facebookMessage(post), link: post.url } });
    out.facebook = fb.id;
    comments.facebook = await comment(fb.id, post, opts);
  } catch (err) {
    out.facebook = `failed: ${err.message}`;
  }

  const ig = page.instagram_business_account?.id;
  if (only === 'facebook') out.instagram = 'skipped: Facebook only';
  else if (!ig) out.instagram = 'skipped: no Instagram professional account is linked to the Page';
  else if (!post.imageUrl || !/\.jpe?g(\?|$)/i.test(post.imageUrl)) out.instagram = 'skipped: Instagram needs a JPEG photo';
  else {
    try {
      // Instagram sometimes fails to fetch a just-stored photo ("Only photo or video can be accepted"): try once more.
      const create = () => graph(`/${ig}/media`, { ...opts, method: 'POST', params: { image_url: post.imageUrl, caption: instagramCaption(post) } });
      const { id: container } = await create().catch(async () => {
        await wait(15000);
        return create();
      });
      // Instagram fetches the photo first; publish once the container is ready (up to ~1 minute).
      for (let i = 0; i < 12; i++) {
        const { status_code: status } = await graph(`/${container}`, { ...opts, params: { fields: 'status_code' } });
        if (status === 'FINISHED') break;
        if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Instagram could not use the photo (${status})`);
        await wait(5000);
      }
      const done = await graph(`/${ig}/media_publish`, { ...opts, method: 'POST', params: { creation_id: container } });
      out.instagram = done.id;
      comments.instagram = await comment(done.id, post, opts);
    } catch (err) {
      out.instagram = `failed: ${err.message}`;
    }
  }
  if (Object.keys(comments).length) out.comments = comments;
  return out;
}

// "Comment only" (the workflow's comment_on input, e.g. "facebook:123_456 instagram:789"): adds the
// first comment to posts that are already out, without posting anything new. Returns what happened per id.
export async function commentOn(ids, url, { token = process.env.META_PAGE_TOKEN, fetchFn = fetch } = {}) {
  const pairs = String(ids).trim().split(/\s+/).filter(Boolean).map((x) => x.split(':'));
  if (!pairs.length) return {};
  const { pageToken } = await resolvePage(token, fetchFn);
  const out = {};
  // What the saved token may do (names only, never the token), to explain a permission error.
  try {
    const d = (await graph('/debug_token', { token: pageToken, fetchFn, params: { input_token: pageToken } })).data ?? {};
    out.token = { type: d.type, valid: d.is_valid, expires: d.expires_at === 0 ? 'never' : d.expires_at, scopes: d.scopes ?? [] };
  } catch (err) {
    out.token = `unknown: ${err.message}`;
  }
  for (const [network, id] of pairs) {
    out[network] = ['facebook', 'instagram'].includes(network) && id
      ? await comment(id, { url }, { token: pageToken, fetchFn })
      : `skipped: unknown network "${network}"`;
  }
  return out;
}

// "Delete posts" (the workflow's delete_posts input, e.g. "facebook:123_456 instagram:789"): removes posts
// the Page made, e.g. one shared before its photo was ready. Instagram's API can't delete posts: those
// are reported, to delete in the app. Returns what happened per id.
export async function deletePosts(ids, { token = process.env.META_PAGE_TOKEN, fetchFn = fetch } = {}) {
  const pairs = String(ids).trim().split(/\s+/).filter(Boolean).map((x) => x.split(':'));
  if (!pairs.length) return {};
  const { pageToken } = await resolvePage(token, fetchFn);
  const out = {};
  for (const [network, id] of pairs) {
    if (network === 'instagram') out[`instagram:${id}`] = 'skipped: delete it in the Instagram app';
    else if (network !== 'facebook' || !id) out[`${network}:${id}`] = `skipped: unknown network "${network}"`;
    else {
      try {
        await graph(`/${id}`, { token: pageToken, fetchFn, method: 'DELETE' });
        out[`facebook:${id}`] = 'deleted';
      } catch (err) {
        out[`facebook:${id}`] = `failed: ${err.message}`;
      }
    }
  }
  return out;
}

// What sharing needs from the token (the six permissions picked when making it).
export const NEEDED_PERMISSIONS = ['pages_manage_posts', 'pages_read_engagement', 'pages_manage_engagement', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments'];

/**
 * Checks META_PAGE_TOKEN without posting anything: which Page and Instagram account it reaches, whether it
 * expires and which permissions are missing. Returns lines to print; throws when the token can't be used at all.
 */
export async function checkToken({ token = process.env.META_PAGE_TOKEN, fetchFn = fetch } = {}) {
  if (!token) throw new Error('META_PAGE_TOKEN is not set');
  const { page, pageToken } = await resolvePage(token, fetchFn);
  const lines = [`Facebook Page: ${page.name} (${page.id})`];
  const problems = [];

  const igId = page.instagram_business_account?.id;
  if (!igId) problems.push('no Instagram professional account is linked to this Page, so posts go to Facebook only');
  else {
    try {
      const ig = await graph(`/${igId}`, { token: pageToken, fetchFn, params: { fields: 'username' } });
      lines.push(`Instagram: @${ig.username}`);
    } catch (err) {
      problems.push(`the linked Instagram account can't be read (${err.message})`);
    }
  }

  try {
    const info = (await graph('/debug_token', { token: pageToken, fetchFn, params: { input_token: pageToken } })).data ?? {};
    lines.push(`Token type: ${info.type ?? 'unknown'}`);
    if (info.is_valid === false) problems.push('Facebook says the token is no longer valid; make a new one');
    const expires = info.expires_at ? new Date(info.expires_at * 1000) : null;
    lines.push(`Expires: ${expires ? expires.toISOString().slice(0, 10) : 'never'}`);
    if (expires) problems.push(`the token expires on ${expires.toISOString().slice(0, 10)}; a Page token made from an extended token never expires`);
    const missing = NEEDED_PERMISSIONS.filter((p) => !(info.scopes ?? []).includes(p));
    if (missing.length) problems.push(`missing permissions: ${missing.join(', ')}`);
  } catch (err) {
    lines.push(`Permissions: not checked (${err.message})`);
  }

  lines.push(problems.length ? `Problems: ${problems.join('; ')}.` : 'All good: new posts will be shared to Facebook and Instagram.');
  return lines;
}
