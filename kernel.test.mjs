import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYER_KEYS, LAYER_NAMES, WEIGHTS, PROMPT_TYPES, MODEL_PROFILES,
  estTokens, avgScore, scoreClarity, scoreConstraint, scoreRubric, scoreGrounding, scoreRegression, scoreFit,
  gatePrompt, sha256, canon, sealReading, verifyReading,
} from './kernel.mjs';

test('sha256 + canon are the proven pair', () => {
  assert.equal(sha256('abc').hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(canon({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('vocabularies are frozen', () => {
  assert.deepEqual([...LAYER_KEYS], ['clarity', 'constraint', 'rubric', 'grounding', 'regression', 'fit']);
  assert.deepEqual([...PROMPT_TYPES], ['agent_system', 'subagent', 'one_shot', 'tool_use', 'skill', 'reference']);
  assert.throws(() => { WEIGHTS.one_shot = {}; });
  assert.throws(() => { MODEL_PROFILES.opus = null; });
});

test('estTokens ≈ length/4, floor of 1', () => {
  assert.equal(estTokens('abcd'), 1);
  assert.equal(estTokens('a'.repeat(400)), 100);
  assert.equal(estTokens(''), 1);
  assert.equal(estTokens(null), 1);
});

test('scoreClarity: exact scores (clean vs hedged vs empty)', () => {
  assert.equal(scoreClarity('Write a function. Return JSON with the result.').score, 70);
  assert.equal(scoreClarity('maybe try to probably do something perhaps').score, 15);
  assert.equal(scoreClarity('').score, 0);
  assert.equal(scoreClarity(null).score, 0);
});

test('scoreConstraint: negatives raise it; zero negatives is capped at 35', () => {
  assert.equal(scoreConstraint('Do not use eval. Never fetch. Only operate locally.').score, 80);
  assert.equal(scoreConstraint('just write something nice').score, 30);
  // kill: edge-case + scope bumps still cannot exceed 35 when there are NO negative constraints
  assert.equal(scoreConstraint('handle the edge case when uncertain, scope is defined').score, 35);
});

test('scoreRubric / scoreGrounding: exact scores', () => {
  assert.equal(scoreRubric('Return JSON. For example: {"a":1}. Good output looks like a table.').score, 62);
  assert.equal(scoreGrounding('You are an expert.\n## Task\nProcess file.js and return.').score, 35);
});

test('scoreRegression: baseline 75 with no prior; a divergent revision is penalised', () => {
  assert.equal(scoreRegression('abc', null).score, 75);
  assert.equal(scoreRegression('abc', null).delta, null);
  const prev = { text: 'line one\nline two\nline three', version: 'v1', scores: {}, weights: { clarity: 100 } };
  const r = scoreRegression('totally different content here', prev);
  assert.equal(r.score, 45);                 // low line-similarity penalty
  assert.ok(r.delta.sim < 0.6);
});

test('scoreFit: chain-of-thought on a non-CoT model class is penalised; unknown model is neutral', () => {
  assert.equal(scoreFit('Think step by step and explain your thinking carefully before answering the question in full detail here now', 'haiku').score, 44);
  assert.equal(scoreFit('x', 'nope').score, 50);   // unknown model class → neutral 50
});

test('avgScore is the weighted mean; empty weights → 0 (no divide-by-zero)', () => {
  assert.equal(avgScore({ clarity: { score: 80 }, constraint: { score: 60 } }, { clarity: 50, constraint: 50 }), 70);
  assert.equal(avgScore({ clarity: { score: 90 }, constraint: { score: 10 } }, { clarity: 75, constraint: 25 }), 70);   // weighted, not plain
  assert.equal(avgScore({}, {}), 0);
});

test('gatePrompt: runs all six layers and combines by the type weights', () => {
  const g = gatePrompt('You are an expert.\nWrite a function. Return JSON. Do not use eval.', { type: 'one_shot', modelKey: 'opus' });
  assert.equal(g.overall, 50);
  assert.equal(g.scores.clarity.score, 70);
  assert.deepEqual(Object.keys(g.scores).sort(), [...LAYER_KEYS].sort());
  assert.equal(g.type, 'one_shot');
});

test('gatePrompt: an unknown prompt type defaults to one_shot', () => {
  assert.equal(gatePrompt('hi', { type: 'bogus' }).type, 'one_shot');
  assert.equal(gatePrompt('hi', {}).modelKey, 'other');
});

test('sealReading seals a tamper-evident reading; verifyReading confirms it', () => {
  const s = sealReading('Write a function. Return JSON.', { type: 'one_shot', modelKey: 'opus' }, { at: '2026-09-15' });
  assert.equal(s.kind, 'prompt-gate-reading');
  assert.equal(verifyReading(s).valid, true);
  assert.ok(typeof s.overall === 'number');
});

test('sealReading: a nudged overall score breaks the seal', () => {
  const s = sealReading('do the thing', { type: 'one_shot' }, {});
  const tampered = { ...s, overall: 100 };
  assert.equal(verifyReading(tampered).valid, false);
  assert.equal(verifyReading({ hash: 'x' }).ok, false);
  assert.equal(verifyReading({ kind: 'prompt-gate-reading' }).ok, false);
});

// ── kill-probes: pin the NOTES branches + the score boundaries ──────────────────────────────────

test('scoreClarity notes: imperatives, hedges, concreteness, clean shape, empty→dash', () => {
  assert.match(scoreClarity('This document describes a system. Another line about the system.').notes, /no imperative verbs/);
  assert.match(scoreClarity('maybe perhaps possibly probably might sort of').notes, /6 hedge words/);
  assert.match(scoreClarity('Write a function. Return JSON.').notes, /clean instruction shape/);
  assert.match(scoreClarity('Write about the topic and describe the aspects and explain the parts and summarise the whole for the reader in a clear simple friendly helpful useful thorough complete detailed way for everyone today').notes, /zero concrete markers/);
  const punct = scoreClarity('!!! ??? ...');
  assert.equal(punct.score, 50); assert.equal(punct.notes, '—');   // empty notes → dash; and t.match null → 0, not a throw
});

test('scoreConstraint notes: none vs some (singular)', () => {
  assert.match(scoreConstraint('write something').notes, /unbounded latitude/);
  const c = scoreConstraint('do not fail');
  assert.equal(c.score, 55); assert.match(c.notes, /1 constraint marker found/);
});

test('scoreRubric notes: undefined shape vs one format hint (singular)', () => {
  assert.match(scoreRubric('plain text answer').notes, /output shape undefined/);
  assert.match(scoreRubric('Return JSON').notes, /1 format hint/);
});

test('scoreGrounding notes: no role, no sections (long), reference-no-vars, both present, and the wc<20 cap', () => {
  assert.match(scoreGrounding('process the data and return it now').notes, /no role \/ job statement/);
  assert.match(scoreGrounding('word '.repeat(90)).notes, /no section markers in a long prompt/);
  assert.match(scoreGrounding('This is a reference template for the task').notes, /no input variables/);
  assert.match(scoreGrounding('You are an agent.\n## Task\ndo it').notes, /role and sections present/);
  assert.equal(scoreGrounding('You are @bot. See file.js. ## A ## B ## C').score, 40);   // wc<20 caps at 40
  assert.equal(scoreGrounding('You are helpful and you do the task well').notes, '—');   // no branch fires → dash
});

test('scoreRegression boundaries: both-empty sim=100%, mid-sim penalty, big divergence + token delta', () => {
  const e = scoreRegression('', { text: '', version: 'v1', scores: {}, weights: {} });
  assert.equal(e.score, 70); assert.match(e.notes, /similarity 100%/); assert.match(e.notes, /\+0 tokens/);
  const mid = scoreRegression('a\nb\nx\ny\nz', { text: 'a\nb\nc\nd\ne', version: 'v2', scores: {}, weights: { clarity: 100 } });
  assert.equal(mid.score, 60); assert.match(mid.notes, /40%/);
  const big = scoreRegression('x'.repeat(3000), { text: 'x', version: 'v9', scores: {}, weights: {} });
  assert.equal(big.score, 35); assert.match(big.notes, /0%/); assert.match(big.notes, /\+749 tokens/);
});

test('scoreFit boundaries: below sweet spot, above sweet spot, and no CoT penalty when none present', () => {
  const below = scoreFit('hi', 'opus');
  assert.equal(below.score, 30); assert.match(below.notes, /below sweet spot/);
  const above = scoreFit('word '.repeat(2000), 'haiku');
  assert.equal(above.score, 30); assert.match(above.notes, /above sweet spot/);
  assert.equal(scoreFit('Return JSON with the answer to the users question about the weather today please', 'haiku').score, 65);   // no CoT → no penalty
});

test('kill: exact boundaries (>, <) in the scorers', () => {
  // L49 — a single 3-char fragment is NOT a sentence (length > 3), so no imperative-note fires
  assert.equal(scoreClarity('abc').notes, '—');
  // L72 — exactly 3 hedges does not trip the hedge note (> 3)
  assert.doesNotMatch(scoreClarity('maybe perhaps possibly do the thing here').notes, /hedge words/);
  // L73 — at exactly 30 words the "zero concrete" note does not fire (> 30)
  assert.doesNotMatch(scoreClarity('word '.repeat(30).trim()).notes, /zero concrete/);
  // L74 — clean-shape needs impRatio > 0.4 (exactly 0.4 does not qualify) AND hedges < 2 (exactly 2 does not)
  assert.doesNotMatch(scoreClarity('Write it. Use that. The cat sat. The dog ran. The bird flew.').notes, /clean instruction shape/);
  assert.doesNotMatch(scoreClarity('Write it maybe. Use that perhaps. The end here.').notes, /clean instruction shape/);
  // L143 — at exactly 80 words the "no section markers" note does not fire (> 80)
  assert.doesNotMatch(scoreGrounding('word '.repeat(80).trim()).notes, /no section markers/);
  // L139 — at exactly 20 words the grounding cap (wc < 20) does NOT apply, so a strong prompt scores above 40
  assert.ok(scoreGrounding('You are @x @y with the file.js and file.ts and see ## A ## B ## C ## D ## E now here').score > 40);
});

test('kill: exact boundaries in regression + fit', () => {
  // L161 — similarity exactly 0.3 is not < 0.3, so the -25 does not apply (only the -10 for < 0.6)
  assert.equal(scoreRegression('a\nb\nc\nd\ne\nf\ng\nh\ni\nj', { text: 'a\nb\nc\nk\nl\nm\nn\no\np\nq', version: 'v', scores: {}, weights: {} }).score, 60);
  // L162 — similarity exactly 0.6 is not < 0.6, so no penalty
  assert.equal(scoreRegression('a\nb\nc\nd\ne', { text: 'a\nb\nc\nx\ny', version: 'v', scores: {}, weights: {} }).score, 70);
  // L163 — a token delta of exactly 500 is not > 500, so no -10 (only the sim penalty)
  assert.equal(scoreRegression('z'.repeat(2004), { text: 'zzzz', version: 'v', scores: {}, weights: {} }).score, 45);
  // L179 / L180 — exactly at the sweet-spot edges is "in sweet spot", not below/above
  assert.match(scoreFit('x'.repeat(800), 'opus').notes, /in sweet spot/);
  assert.match(scoreFit('return json ' + 'x'.repeat(5988), 'haiku').notes, /in sweet spot/);
});

test('kill: singular vs plural note forms + gatePrompt uses prevReading', () => {
  assert.doesNotMatch(scoreRubric('Return JSON').notes, /format hints/);                                   // exactly 1 → "hint" not "hints"
  assert.doesNotMatch(scoreRubric('Return JSON. e.g. foo').notes, /example markers/);                      // exactly 1 example
  assert.doesNotMatch(scoreRubric('Return JSON ' + '```code```').notes, /code blocks/);                    // exactly 1 code block
  // gatePrompt must actually pass prevReading into scoreRegression (|| null, not && null)
  const prev = { text: 'old\nlines\nhere\nnow', version: 'v', scores: {}, weights: {} };
  assert.ok(gatePrompt('totally new different content entirely', { type: 'one_shot', prevReading: prev }).scores.regression.score < 75);
});

test('fuzz: pure and total — garbage never throws', () => {
  const junk = [null, undefined, 0, '', [], {}, NaN, true, Symbol.for('x')];
  for (const a of junk) for (const b of junk) {
    assert.doesNotThrow(() => {
      scoreClarity(a); scoreConstraint(a); scoreRubric(a); scoreGrounding(a); scoreRegression(a, b); scoreFit(a, b);
      avgScore(a, b); gatePrompt(a, b); sealReading(a, b, a); verifyReading(a);
    });
  }
});
