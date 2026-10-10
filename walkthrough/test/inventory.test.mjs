import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory } from '../lib/inventory.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tiny-book');
test('inventory groups scene files and records provenance', async () => {
  const entries = await inventory(fixture, path.join(path.dirname(fixture), 'tool-package'));
  const scene = entries.find(x => x.path.includes('one file per scene'));
  assert.equal(scene.files.length, 2);
  assert.equal(scene.group, 'Your book');
  assert.match(scene.sha256, /^[0-9a-f]{64}$/);
  assert.ok(scene.size > 0);
  assert.match(scene.excerpt, /First scene/);
  assert.ok(entries.some(x => x.path === 'quality/rules.json'));
  assert.ok(entries.some(x => x.path === 'project.json'));
  assert.equal(entries.find(x => x.path === 'releases/sample/scenes/NN-NN.md: one file per scene').files.length, 2);
  assert.ok(entries.some(x => x.path === '@pickbitsai/weaver/engine/prose.mjs' && x.group === 'The tool'));
  assert.ok(entries.some(x => x.path === '@pickbitsai/weaver/prompts/' && /Do not edit/.test(x.update_policy)));
  assert.equal(entries.find(x => x.path === '.weaver/packets/').files.length, 2);
});
