import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync("loop.manifest.json", "utf8"));
const cli = readFileSync("scripts/weaver.mjs", "utf8");

test("loop manifest has unique nodes and connected edges", () => {
  const ids = manifest.nodes.map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length >= 6);
  for (const edge of manifest.edges) {
    assert.ok(ids.includes(edge.from), `unknown edge source: ${edge.from}`);
    assert.ok(ids.includes(edge.to), `unknown edge target: ${edge.to}`);
    assert.ok(edge.when);
  }
});

test("loop manifest names executable commands and sabotage evidence", () => {
  for (const node of manifest.nodes.filter((candidate) => candidate.command)) {
    const command = node.command.split(/\s+/)[1];
    assert.match(cli, new RegExp(`command === "${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  }
  assert.ok(manifest.gates.length >= 3);
  for (const gate of manifest.gates) {
    assert.ok(gate.accepts);
    assert.ok(gate.rejects);
    assert.ok(gate.evidence.length);
  }
});
