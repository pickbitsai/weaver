import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, validateExplanation, validateCommit, withRepair } from '../lib/explain.mjs';

const good = Object.fromEntries(FIELDS.map(x => [x, 'You can inspect this file in your book.']));
test('response validator rejects missing and overlong fields', () => {
  assert.throws(() => validateExplanation({}), /what_it_is/);
  assert.throws(() => validateExplanation({ ...good, what_it_is: Array(13).fill('you').join(' ') }), /12 words/);
  assert.throws(() => validateExplanation({ ...good, what_it_is: 'It holds your words for one...' }), /incomplete/);
  assert.throws(() => validateExplanation({ ...good, what_it_is: 'It holds your words for one…' }), /incomplete/);
  assert.throws(() => validateExplanation({ ...good, what_it_is: 'It holds your words for the' }), /incomplete/);
});
test('truncated response receives one repair retry', async () => {
  const prompts = [];
  const result = await withRepair('Explain', validateExplanation, async prompt => {
    prompts.push(prompt);
    return JSON.stringify(prompts.length === 1 ? { ...good, what_it_is: 'It holds your words for one...' } : good);
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /incomplete/);
  assert.equal(result.needsReview, false);
});
test('invalid Claude response gets one repair attempt', async () => {
  const prompts = [];
  const result = await withRepair('Explain', validateExplanation, async prompt => { prompts.push(prompt); return prompts.length === 1 ? '{bad' : JSON.stringify(good); });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /failed validation/);
  assert.equal(result.needsReview, false);
});
test('two invalid responses fall back for review', async () => {
  let calls = 0;
  const result = await withRepair('Explain', validateExplanation, async () => { calls++; return '{}'; });
  assert.equal(calls, 2);
  assert.equal(result.needsReview, true);
});
test('commit explanations require concise author-facing language', () => {
  assert.deepEqual(validateCommit({ what_changed: 'Your scene changed.', why: 'You approved its revision.' }), { what_changed: 'Your scene changed.', why: 'You approved its revision.' });
  assert.throws(() => validateCommit({ what_changed: 'Scene changed.', why: 'Approved.' }), /you/);
});
