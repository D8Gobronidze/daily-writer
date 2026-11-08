import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtInTopics, isQuizDue, quizPayload, quizProblems, quizPrompt, quizShare, weekStart } from './quiz.mjs';
import { facebookMessage, firstComment, instagramCaption } from './social.mjs';

process.env.SITE_URL = 'https://example.com';

const question = (i) => ({
  q: `Question ${i} about water?`,
  choices: [{ text: 'Right', correct: true }, { text: 'Wrong', correct: false }, { text: 'Also wrong', correct: false }],
  explain: 'Why it is right.',
  source: 'CDC',
});
const good = (over = {}) => ({
  slug: 'water-wise',
  title: 'How water-wise are you?',
  emoji: '💧',
  intro: 'Seven quick questions about water.',
  questions: [1, 2, 3, 4, 5, 6, 7].map(question),
  results: [
    { slug: 'sprout', title: 'Sprout', emoji: '🌱', blurb: 'Room to grow.', min: 0, colors: ['#3b5b52', '#e0e9e4'] },
    { slug: 'sipper', title: 'Sipper', emoji: '🥤', blurb: 'Nice.', min: 3, colors: ['#99562f', '#f3dccb'] },
    { slug: 'pro', title: 'Pro', emoji: '🏆', blurb: 'Great.', min: 6, colors: ['#1e2a21', '#c8794a'] },
  ],
  relatedPost: 'hydration-basics',
  photoQueries: ['woman drinking water outdoors', 'glass of water'],
  ...over,
});

test('the week starts on Monday, US Eastern', () => {
  // Monday 2026-11-09 at 1 AM UTC is still Sunday evening in New York.
  assert.equal(weekStart(new Date('2026-11-09T01:00:00Z')), '2026-11-02');
  assert.equal(weekStart(new Date('2026-11-09T11:17:00Z')), '2026-11-09');
  assert.equal(weekStart(new Date('2026-11-15T23:00:00Z')), '2026-11-09');
});

test('a test is due once a week, from Monday', () => {
  const monday = new Date('2026-11-09T11:17:00Z');
  assert.equal(isQuizDue([], monday), true);
  assert.equal(isQuizDue([{ createdAt: '2026-11-02T11:17:00Z' }], monday), true, 'last week’s does not count');
  assert.equal(isQuizDue([{ createdAt: '2026-11-09T11:18:00Z' }], new Date('2026-11-11T14:17:00Z')), false, 'this week’s is written');
  assert.equal(isQuizDue([{ createdAt: '2026-11-09T11:18:00Z' }], new Date('2026-11-16T11:17:00Z')), true, 'next Monday: a new one');
});

test('a good test passes; mistakes are named', () => {
  assert.deepEqual(quizProblems(good()), []);
  const two = good();
  two.questions[1].choices[1].correct = true;
  assert.match(quizProblems(two).join(), /question 2/);
  assert.match(quizProblems(good({ slug: 'Bad Slug' })).join(), /slug/);
  assert.match(quizProblems(good({ questions: good().questions.slice(0, 3) })).join(), /6 to 8/);
  const flat = good();
  flat.results[2].min = 3;
  assert.match(quizProblems(flat).join(), /rising from 0/);
  assert.match(quizProblems(good({ intro: 'A miracle quiz.' })).join(), /miracle/);
});

test('the site gets the test without helper fields, and only a real related post', () => {
  const body = quizPayload(good(), ['hydration-basics']);
  assert.equal(body.photoQueries, undefined);
  assert.equal(body.relatedPost, undefined);
  assert.deepEqual(body.related, { post: 'hydration-basics' });
  assert.equal(quizPayload(good(), ['other']).related, undefined);
});

test('the prompt lists topics to avoid and posts to link', () => {
  const p = quizPrompt({ topics: ['sleep', 'How fiber-smart are you?'], posts: [{ slug: 'a-post', title: 'A post' }] });
  assert.match(p, /DIFFERENT one\): sleep, How fiber-smart are you\?/);
  assert.match(p, /- a-post: A post/);
});

test('built-in topics come from the /quizzes/ page links', () => {
  const html = '<a href="/quizzes/sleep/">x</a><a href="/quizzes/sleep/">y</a><a href="/quizzes/gut/">z</a><a href="/quizzes/w/new/">w</a>';
  assert.deepEqual(builtInTopics(html), ['sleep', 'gut']);
});

test('social posts invite people to take the quiz', () => {
  const post = quizShare({ slug: 'water-wise', title: 'How water-wise are you?', emoji: '💧', intro: 'Seven quick questions.', questions: 7, url: 'https://example.com/quizzes/w/water-wise/', imageUrl: null });
  assert.equal(post.title, '💧 How water-wise are you?');
  assert.match(facebookMessage(post), /Take the quiz: https:\/\/example\.com\/quizzes\/w\/water-wise\//);
  assert.match(facebookMessage(post), /7 questions, about a minute/);
  assert.match(facebookMessage(post), /#example #wellness #healthquiz #healthiq$/);
  assert.match(instagramCaption(post), /Take the quiz at example\.com\/quizzes\/w\/water-wise 🧠/);
  assert.equal(firstComment(post), '🧠 Take the quiz: https://example.com/quizzes/w/water-wise/');
  // Blog posts keep their own wording.
  assert.equal(firstComment({ url: 'https://example.com/blog/x/' }), '📖 Read the full post: https://example.com/blog/x/');
});
