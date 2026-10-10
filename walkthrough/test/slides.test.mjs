import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSlides } from '../lib/slides.mjs';

const narration = Array(45).fill('word').join(' ');
test('slides schema accepts a valid slide', () => {
  assert.equal(validateSlides([{ section: 'Title', title: 'Book', bullets: ['For you'], narration }]).length, 1);
});
test('slides schema rejects overlong bullets', () => {
  assert.throws(() => validateSlides([{ section: 'Title', title: 'Book', bullets: ['one two three four five six seven eight nine ten eleven twelve thirteen'], narration }]), /bullet/);
});
