import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AD_NOTE, NEEDED_PERMISSIONS, checkToken, commentOn, deletePosts, facebookMessage, instagramCaption, sharePost, wentOut } from './social.mjs';

process.env.SITE_URL = 'https://example.com';

const post = {
  title: 'Omega-3 and your heart',
  summary: 'What recent trials found.',
  url: 'https://example.com/blog/omega-3/',
  imageUrl: 'https://example.com/blog/images/9-omega-3.jpg?v=abc',
  tags: ['heart', 'daily-basics'],
};

// A fake Graph API: records calls; `statuses` are the container states returned in turn.
function meta({ ig = '178', statuses = ['IN_PROGRESS', 'FINISHED'], fail = {} } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    const params = Object.fromEntries(init.body ? new URLSearchParams(init.body) : u.searchParams);
    const path = u.pathname.replace('/v26.0', '');
    calls.push({ method: init.method ?? 'GET', path, params });
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    if (fail[path]) return json({ error: { message: fail[path] } }, 400);
    if (path === '/me/accounts') return params.access_token === 'user' ? json({ data: [{ id: '999', name: 'Other page', access_token: 'p-other' }, { id: '615', name: 'Example', access_token: 'p-example', ...(ig ? { instagram_business_account: { id: ig } } : {}) }] }) : json({ error: { message: 'nonexisting field (accounts) on node type (Page)' } }, 400);
    if (path === '/me') return json({ id: '615', name: 'Example', ...(ig ? { instagram_business_account: { id: ig } } : {}) });
    if (path === '/') return json({ id: params.id });
    if (path === '/615_7' && init.method === 'DELETE') return json({ success: true });
    if (path === '/615/feed') return json({ id: '615_1' });
    if (path === `/${ig}/media`) return json({ id: 'c1' });
    if (path === '/c1') return json({ status_code: statuses.shift() ?? 'FINISHED' });
    if (path === `/${ig}/media_publish`) return json({ id: 'ig_1' });
    if (path === '/615_1/comments') return json({ id: 'fbc_1' });
    if (path === '/ig_1/comments') return json({ id: 'igc_1' });
    if (path === '/615_9/comments') return json({ id: 'fbc_9' });
    if (path === `/${ig}`) return json({ id: ig, username: 'example.com' });
    if (path === '/debug_token') return json({ data: { type: 'PAGE', expires_at: 0, scopes: params.access_token === 'p-example' ? NEEDED_PERMISSIONS : ['pages_manage_posts'] } });
    return json({ error: { message: 'unexpected ' + path } }, 404);
  };
  return { calls, fetchFn };
}

test('posts to the Facebook Page and Instagram with the photo', async () => {
  const m = meta();
  const out = await sharePost(post, { token: 't', fetchFn: m.fetchFn, wait: async () => {} });
  assert.deepEqual(out, { facebook: '615_1', instagram: 'ig_1', comments: { facebook: 'fbc_1', instagram: 'igc_1' } });
  const fb = m.calls.find((c) => c.path === '/615/feed');
  assert.equal(fb.params.link, post.url);
  assert.equal(fb.params.access_token, 't');
  const media = m.calls.find((c) => c.path === '/178/media');
  assert.equal(media.params.image_url, post.imageUrl);
  assert.equal(m.calls.filter((c) => c.path === '/c1').length, 2, 'waited for the container');
  assert.equal(m.calls.find((c) => c.path === '/178/media_publish').params.creation_id, 'c1');
});

test('Instagram is skipped without a linked account or a JPEG; one failure does not stop the other', async () => {
  assert.match((await sharePost(post, { token: 't', fetchFn: meta({ ig: null }).fetchFn })).instagram, /no Instagram/);
  assert.match((await sharePost({ ...post, imageUrl: null }, { token: 't', fetchFn: meta().fetchFn })).instagram, /JPEG/);
  const out = await sharePost(post, { token: 't', fetchFn: meta({ fail: { '/615/feed': 'Permission denied' } }).fetchFn, wait: async () => {} });
  assert.equal(out.facebook, 'failed: Meta POST /615/feed → Permission denied');
  assert.equal(out.instagram, 'ig_1');
  const bad = await sharePost(post, { token: 't', fetchFn: meta({ statuses: ['ERROR'] }).fetchFn, wait: async () => {} });
  assert.match(bad.instagram, /could not use the photo \(ERROR\)/);
});

test('no token: nothing is sent', async () => {
  assert.deepEqual(await sharePost(post, { token: '', fetchFn: async () => { throw new Error('no'); } }), { skipped: 'META_PAGE_TOKEN is not set' });
});

test('texts', () => {
  assert.equal(
    facebookMessage(post),
    'Omega-3 and your heart\n\nWhat recent trials found.\n\nRead it here: https://example.com/blog/omega-3/\n\n#example #wellness #heart #dailybasics',
  );
  // Instagram doesn't make caption links clickable, so the address is spelled out to type or copy.
  assert.match(instagramCaption(post), /Read the full post at example\.com\/blog\/omega-3 🌿\n\n#example #wellness #heart #dailybasics$/);
  assert.ok(!instagramCaption(post).includes('link in bio'));
});

test('a user or System User token is swapped for the Example Page token', async () => {
  const m = meta();
  const out = await sharePost(post, { token: 'user', fetchFn: m.fetchFn, wait: async () => {} });
  assert.deepEqual(out, { facebook: '615_1', instagram: 'ig_1', comments: { facebook: 'fbc_1', instagram: 'igc_1' } });
  assert.equal(m.calls.find((c) => c.path === '/615/feed').params.access_token, 'p-example');
});

test('a post about one brand product starts with the #ad commission note; others have none', () => {
  const product = { ...post, product: 'organixx/magnesium-7' };
  assert.ok(facebookMessage(product).startsWith(AD_NOTE));
  assert.ok(instagramCaption(product).startsWith(AD_NOTE));
  assert.ok(!facebookMessage(post).includes('#ad'));
  assert.ok(!instagramCaption(post).includes('#ad'));
});

test('a post counts as shared once either network published it', () => {
  assert.equal(wentOut({ facebook: '615_1', instagram: 'skipped: Instagram needs a JPEG photo' }), true);
  assert.equal(wentOut({ facebook: 'failed: x', instagram: 'ig_1' }), true);
  assert.equal(wentOut({ facebook: 'failed: x', instagram: 'failed: y' }), false);
  assert.equal(wentOut({ skipped: 'META_PAGE_TOKEN is not set' }), false);
});

test('Instagram gets a second try when it cannot fetch the photo, and "only" limits the networks', async () => {
  let tries = 0;
  const { calls, fetchFn } = meta();
  const flaky = async (url, init) => {
    if (String(url).includes('/178/media') && !String(url).includes('publish') && tries++ === 0) return new Response(JSON.stringify({ error: { message: 'Only photo or video can be accepted as media type.' } }), { status: 400 });
    return fetchFn(url, init);
  };
  const out = await sharePost(post, { token: 'page', fetchFn: flaky, wait: async () => {}, only: 'instagram' });
  assert.equal(out.instagram, 'ig_1');
  assert.match(out.facebook, /^skipped/);
  assert.ok(!calls.some((c) => c.path === '/615/feed'));
});

test('the link to the post goes in a first comment on Facebook and Instagram', async () => {
  const m = meta();
  await sharePost(post, { token: 't', fetchFn: m.fetchFn, wait: async () => {} });
  const fb = m.calls.find((c) => c.path === '/615_1/comments');
  const ig = m.calls.find((c) => c.path === '/ig_1/comments');
  assert.equal(fb.method, 'POST');
  assert.equal(fb.params.message, '📖 Read the full post: https://example.com/blog/omega-3/');
  assert.equal(ig.params.message, '📖 Read the full post: https://example.com/blog/omega-3/');
  // Comments come after the posts they belong to.
  assert.ok(m.calls.indexOf(fb) > m.calls.findIndex((c) => c.path === '/615/feed'));
  assert.ok(m.calls.indexOf(ig) > m.calls.findIndex((c) => c.path === '/178/media_publish'));
});

test('a comment that fails (e.g. the token lacks comment permission) never undoes the share', async () => {
  const m = meta({ fail: { '/615_1/comments': '(#200) Permissions error', '/ig_1/comments': 'Unsupported request' } });
  const out = await sharePost(post, { token: 't', fetchFn: m.fetchFn, wait: async () => {} });
  assert.equal(out.facebook, '615_1');
  assert.equal(out.instagram, 'ig_1');
  assert.match(out.comments.facebook, /^failed: .*Permissions error/);
  assert.match(out.comments.instagram, /^failed: .*Unsupported request/);
  assert.equal(wentOut(out), true);
  // No comment is tried on a network that did not publish.
  const none = meta({ fail: { '/615/feed': 'down' } });
  const res = await sharePost(post, { token: 't', fetchFn: none.fetchFn, wait: async () => {} });
  assert.ok(!none.calls.some((c) => c.path.endsWith('/comments') && c.path.startsWith('/615')));
  assert.deepEqual(Object.keys(res.comments), ['instagram']);
});

test('comment only: the first comment is added to posts that are already out', async () => {
  const m = meta();
  const out = await commentOn('facebook:615_9 instagram:ig_1', 'https://example.com/blog/omega-3/', { token: 'user', fetchFn: m.fetchFn });
  assert.equal(out.facebook, 'fbc_9');
  assert.equal(out.instagram, 'igc_1');
  assert.equal(out.token.type, 'PAGE');
  const c = m.calls.find((x) => x.path === '/615_9/comments');
  assert.equal(c.params.message, '📖 Read the full post: https://example.com/blog/omega-3/');
  assert.equal(c.params.access_token, 'p-example');
  assert.ok(!m.calls.some((x) => x.path.endsWith('/feed') || x.path.endsWith('/media')), 'nothing is posted');
  assert.deepEqual(await commentOn('', 'https://x.test/', { token: 'user', fetchFn: m.fetchFn }), {});
  assert.match((await commentOn('twitter:1', 'https://x.test/', { token: 'user', fetchFn: m.fetchFn })).twitter, /unknown network/);
});

test('the token check reports the Page, Instagram and permissions without posting', async () => {
  const m = meta();
  const lines = await checkToken({ token: 'user', fetchFn: m.fetchFn });
  assert.deepEqual(lines, ['Facebook Page: Example (615)', 'Instagram: @example.com', 'Token type: PAGE', 'Expires: never', 'All good: new posts will be shared to Facebook and Instagram.']);
  assert.ok(m.calls.every((c) => c.method === 'GET'));
});

test('the token check lists missing permissions and a missing Instagram link', async () => {
  const m = meta({ ig: null });
  const lines = await checkToken({ token: 'page', fetchFn: m.fetchFn });
  assert.match(lines.at(-1), /no Instagram professional account/);
  assert.match(lines.at(-1), /missing permissions: pages_read_engagement/);
});

test('the token check fails on a token Facebook rejects', async () => {
  const m = meta({ fail: { '/me': 'Invalid OAuth access token' } });
  await assert.rejects(checkToken({ token: 'bad', fetchFn: m.fetchFn }), /Invalid OAuth access token/);
});

test('Facebook re-reads the link before posting, so a newer photo shows', async () => {
  const m = meta();
  await sharePost({ title: 'T', summary: 'S', url: 'https://example.com/blog/x/', imageUrl: null, tags: [] }, { token: 'page', fetchFn: m.fetchFn, wait: async () => {} });
  const i = m.calls.findIndex((c) => c.path === '/' && c.params.scrape === 'true' && c.params.id === 'https://example.com/blog/x/');
  assert.ok(i >= 0 && i < m.calls.findIndex((c) => c.path === '/615/feed'));
});

test('deletePosts removes Facebook posts and reports the rest', async () => {
  const m = meta({ fail: { '/615_8': 'gone' } });
  const out = await deletePosts('facebook:615_7 facebook:615_8 instagram:ig_1', { token: 'user', fetchFn: m.fetchFn });
  assert.deepEqual(out, { 'facebook:615_7': 'deleted', 'facebook:615_8': 'failed: Meta DELETE /615_8 → gone', 'instagram:ig_1': 'skipped: delete it in the Instagram app' });
  assert.equal(m.calls.find((c) => c.path === '/615_7').params.access_token, 'p-example');
  assert.deepEqual(await deletePosts('  ', { token: 'user', fetchFn: m.fetchFn }), {});
});
