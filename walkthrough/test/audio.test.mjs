import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAudio } from '../lib/audio.mjs';
import { slideDuration } from '../lib/render.mjs';

test('none provider returns no audio and rejects unknown providers', async () => {
  assert.deepEqual(await renderAudio([], '', 'none'), []);
  await assert.rejects(renderAudio([], '', 'cloud'), /Unknown audio provider/);
});

test('silent frames allow about 150 narration words per minute', () => {
  assert.equal(slideDuration({ narration: 'short note' }), 6);
  assert.equal(slideDuration({ narration: Array(75).fill('word').join(' ') }), 30);
});
