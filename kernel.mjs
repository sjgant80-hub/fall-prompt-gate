// fall-prompt-gate · kernel.mjs — the deterministic six-layer prompt evaluator, extracted from the
// page and gated. Six pure scorers (clarity, constraint, rubric, grounding, regression, fit) score a
// prompt out of 100; per-prompt-type weights combine them into an overall; a reading can be sealed to
// a content-addressed hash so a score is tamper-evident (honest version history + regression detection).
//
// PURE and TOTAL: no DOM, no I/O, no LLM in the loop — a prompt is graded by rules, not by a model.
// Garbage in gives a low score / { ok:false }, never a throw.

export const LAYER_KEYS = Object.freeze(['clarity', 'constraint', 'rubric', 'grounding', 'regression', 'fit']);
export const LAYER_NAMES = Object.freeze({ clarity: 'Clarity', constraint: 'Constraint', rubric: 'Rubric', grounding: 'Grounding', regression: 'Regression', fit: 'Model fit' });

export const WEIGHTS = Object.freeze({
  agent_system: { clarity: 15, constraint: 25, rubric: 20, grounding: 15, regression: 15, fit: 10 },
  subagent:     { clarity: 20, constraint: 20, rubric: 15, grounding: 20, regression: 15, fit: 10 },
  one_shot:     { clarity: 30, constraint: 10, rubric: 20, grounding: 15, regression: 10, fit: 15 },
  tool_use:     { clarity: 20, constraint: 25, rubric: 30, grounding: 10, regression: 10, fit: 5 },
  skill:        { clarity: 25, constraint: 15, rubric: 25, grounding: 15, regression: 10, fit: 10 },
  reference:    { clarity: 20, constraint: 10, rubric: 15, grounding: 40, regression: 10, fit: 5 },
});
export const PROMPT_TYPES = Object.freeze(Object.keys(WEIGHTS));

export const MODEL_PROFILES = Object.freeze({
  opus:         { name: 'opus class',   tokenSweetSpot: [200, 8000], wantsRubric: true, toleratesChain: true,  apiId: 'claude-opus-4-5' },
  sonnet:       { name: 'sonnet class', tokenSweetSpot: [150, 4000], wantsRubric: true, toleratesChain: true,  apiId: 'claude-sonnet-4-5' },
  haiku:        { name: 'haiku class',  tokenSweetSpot: [50, 1500],  wantsRubric: true, toleratesChain: false, apiId: 'claude-haiku-4-5' },
  'local-small':{ name: 'local small',  tokenSweetSpot: [30, 800],   wantsRubric: true, toleratesChain: false, apiId: null },
  'local-mid':  { name: 'local mid',    tokenSweetSpot: [80, 2500],  wantsRubric: true, toleratesChain: false, apiId: null },
  other:        { name: 'generic',      tokenSweetSpot: [100, 3000], wantsRubric: true, toleratesChain: false, apiId: null },
});

const isStr = (v) => typeof v === 'string';
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export function estTokens(t) { return Math.max(1, Math.round((isStr(t) ? t : '').length / 4)); }

export function avgScore(scores, weights) {
  let total = 0, sumW = 0;
  for (const k of Object.keys(weights || {})) {
    total += ((scores && scores[k] && scores[k].score) || 0) * weights[k];
    sumW += weights[k];
  }
  return sumW === 0 ? 0 : Math.round(total / sumW);
}

export function scoreClarity(t) {
  if (!isStr(t) || !t.trim()) return { score: 0, notes: 'empty prompt' };
  const wc = (t.match(/\b\w+\b/g) || []).length;
  const imperatives = ['use', 'return', 'write', 'generate', 'create', 'build', 'find', 'list', 'identify', 'extract', 'summarise', 'summarize', 'classify', 'rank', 'score', 'format', 'output', 'respond', 'answer', 'do', 'analyse', 'analyze', 'check', 'validate', 'transform', 'convert', 'parse', 'filter', 'select', 'call', 'invoke', 'emit'];
  const sentences = t.split(/[.\n!?]+/).filter((s) => s.trim().length > 3);
  let impCount = 0;
  for (const s of sentences) {
    const first = (s.trim().toLowerCase().split(/\W+/)[0] || '');
    if (imperatives.includes(first)) impCount++;
  }
  const impRatio = sentences.length ? impCount / sentences.length : 0;
  const numbers = (t.match(/\b\d+\b/g) || []).length;
  const paths = (t.match(/[\/\\]\w|\.\w{2,5}\b|`[^`]+`/g) || []).length;
  const concrete = numbers + paths;
  const hedgeRe = /\b(maybe|perhaps|might|kind of|sort of|try to|probably|possibly|generally|usually|somewhat|fairly|quite|rather|just|simply)\b/gi;
  const hedges = (t.match(hedgeRe) || []).length;
  const hedgeRatio = wc ? hedges / wc : 0;
  const adverbs = (t.match(/\b\w+ly\b/g) || []).length;
  const adRatio = wc ? adverbs / wc : 0;
  let score = 50;
  score += Math.min(20, impRatio * 40);
  score += Math.min(15, concrete * 1.2);
  score -= Math.min(25, hedgeRatio * 1200);
  score -= Math.min(10, Math.max(0, adRatio * 400 - 8));
  score = Math.max(0, Math.min(100, Math.round(score)));
  const notes = [];
  if (impCount === 0 && sentences.length > 0) notes.push('no imperative verbs at sentence starts');
  if (hedges > 3) notes.push(hedges + ' hedge words detected (maybe / try / probably …)');
  if (concrete === 0 && wc > 30) notes.push('zero concrete markers (numbers, paths, code refs)');
  if (impRatio > 0.4 && hedges < 2) notes.push('clean instruction shape');
  return { score, notes: notes.join(' · ') || '—' };
}

export function scoreConstraint(t) {
  if (!isStr(t) || !t.trim()) return { score: 0, notes: 'empty prompt' };
  const negRe = /\b(do not|don'?t|never|must not|avoid|without|except|only|strictly|under no|refuse|reject)\b/gi;
  const negs = (t.match(negRe) || []).length;
  const wc = (t.match(/\b\w+\b/g) || []).length;
  const density = wc ? negs / Math.max(1, wc / 100) : 0;
  let score = 30 + Math.min(50, density * 25);
  if (/edge case|exception|when uncertain|if unsure|when you can'?t|in case of/i.test(t)) score += 10;
  if (/scope|out of scope|in scope|boundary|domain/i.test(t)) score += 5;
  if (negs === 0) score = Math.min(score, 35);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const notes = [];
  if (negs === 0) notes.push('no negative constraints — model has unbounded latitude');
  else notes.push(negs + ' constraint marker' + (negs === 1 ? '' : 's') + ' found');
  if (/edge case|when uncertain|if unsure/i.test(t)) notes.push('edge cases addressed');
  return { score, notes: notes.join(' · ') };
}

export function scoreRubric(t) {
  if (!isStr(t) || !t.trim()) return { score: 0, notes: 'empty prompt' };
  const fmtRe = /\b(json|yaml|xml|markdown|table|list|csv|format|schema|return\s+a|output\s+as|respond\s+with|answer\s+in)\b/gi;
  const fmt = (t.match(fmtRe) || []).length;
  const examples = (t.match(/<example|example:|e\.g\.|for example|example output|sample input|sample output/gi) || []).length;
  const codeBlocks = (t.match(/```/g) || []).length;
  const goodLooksLike = /good (output|answer|response) (looks like|is)|criteria|rubric|grading|quality bar|expected/i.test(t) ? 1 : 0;
  let score = 25;
  score += Math.min(30, fmt * 6);
  score += Math.min(20, examples * 10);
  score += Math.min(15, (codeBlocks / 2) * 8);
  score += goodLooksLike * 15;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const notes = [];
  if (fmt === 0 && examples === 0) notes.push('no format directives, no examples — output shape undefined');
  else {
    const bits = [];
    if (fmt) bits.push(fmt + ' format hint' + (fmt === 1 ? '' : 's'));
    if (examples) bits.push(examples + ' example marker' + (examples === 1 ? '' : 's'));
    if (codeBlocks) bits.push(Math.floor(codeBlocks / 2) + ' code block' + (codeBlocks === 2 ? '' : 's'));
    if (goodLooksLike) bits.push('explicit quality criteria');
    notes.push(bits.join(' · '));
  }
  return { score, notes: notes.join(' · ') };
}

export function scoreGrounding(t) {
  if (!isStr(t) || !t.trim()) return { score: 0, notes: 'empty prompt' };
  const wc = (t.match(/\b\w+\b/g) || []).length;
  const roles = /\b(you are|you'?re|act as|your role|your job|your task|as an? \w+)\b/gi;
  const roleHits = (t.match(roles) || []).length;
  const fileRefs = (t.match(/[\w-]+\.(html|js|md|json|py|ts|tsx|yaml|yml|sql|css|sh)\b/gi) || []).length;
  const proper = (t.match(/[A-Z][a-z]+(?:[A-Z][a-z]+)+/g) || []).length;
  const ats = (t.match(/@[\w-]+/g) || []).length;
  const sections = (t.match(/^#+\s|^---|<context>|<instructions>|##\s/gm) || []).length;
  const inputVars = (t.match(/\{\{[\w\s.]+\}\}|\{[\w_]+\}|\$\{[^}]+\}/g) || []).length;
  let score = 20;
  score += Math.min(20, roleHits * 8);
  score += Math.min(15, fileRefs * 4);
  score += Math.min(12, proper * 1.5);
  score += Math.min(8, ats * 4);
  score += Math.min(15, sections * 3);
  score += Math.min(10, inputVars * 3);
  if (wc < 20) score = Math.min(score, 40);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const notes = [];
  if (roleHits === 0) notes.push('no role / job statement');
  if (sections === 0 && wc > 80) notes.push('no section markers in a long prompt');
  if (inputVars === 0 && /reference|template|skill/i.test(t)) notes.push('no input variables — fixed prompt');
  if (roleHits && sections) notes.push('role and sections present');
  return { score, notes: notes.join(' · ') || '—' };
}

export function scoreRegression(t, prevReading) {
  if (!prevReading) return { score: 75, notes: 'no prior version — informational baseline', delta: null };
  const s = isStr(t) ? t : '';
  const prev = prevReading.text || '';
  const a = new Set(s.split('\n').map((x) => x.trim()).filter(Boolean));
  const b = new Set(prev.split('\n').map((x) => x.trim()).filter(Boolean));
  let shared = 0;
  for (const line of a) if (b.has(line)) shared++;
  const sim = a.size + b.size > 0 ? (2 * shared) / (a.size + b.size) : 1;
  const tokenDelta = estTokens(s) - estTokens(prev);
  const prevAvg = avgScore(prevReading.scores, prevReading.weights);
  let score = 70;
  if (sim < 0.3) score -= 25;
  else if (sim < 0.6) score -= 10;
  if (Math.abs(tokenDelta) > 500) score -= 10;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const notes = [];
  notes.push('vs ' + prevReading.version + ': line similarity ' + Math.round(sim * 100) + '%');
  notes.push((tokenDelta >= 0 ? '+' : '') + tokenDelta + ' tokens');
  return { score, notes: notes.join(' · '), delta: { sim, tokenDelta, prevAvg, prevVersion: prevReading.version } };
}

export function scoreFit(t, modelKey) {
  const profile = MODEL_PROFILES[modelKey];
  if (!profile) return { score: 50, notes: 'unknown model class' };
  const s = isStr(t) ? t : '';
  const toks = estTokens(s);
  const [lo, hi] = profile.tokenSweetSpot;
  let score = 80;
  const notes = [];
  if (toks < lo) { score -= Math.min(40, (lo - toks) * 0.5); notes.push(toks + ' tokens — below sweet spot ' + lo + '-' + hi + ' for ' + profile.name); }
  else if (toks > hi) { score -= Math.min(40, (toks - hi) * 0.04); notes.push(toks + ' tokens — above sweet spot ' + lo + '-' + hi + ' for ' + profile.name); }
  else notes.push(toks + ' tokens — in sweet spot for ' + profile.name);
  const hasCoT = /step[\s-]?by[\s-]?step|chain of thought|think (first|carefully|out loud)|reasoning before|explain your thinking|<thinking>/i.test(s);
  if (hasCoT && !profile.toleratesChain) { score -= 15; notes.push('explicit chain-of-thought directives on fast/cheap model class'); }
  const hasRubric = /format|json|output as|return a|respond with|good (output|answer)|<output>|schema/i.test(s);
  if (!hasRubric && profile.wantsRubric) { score -= 10; notes.push('no output rubric on a rubric-loving model'); }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, notes: notes.join(' · ') };
}

/** Run every layer and combine by the prompt-type weights — the whole gate in one call. */
export function gatePrompt(text, opts) {
  const o = isObj(opts) ? opts : {};
  const type = PROMPT_TYPES.includes(o.type) ? o.type : 'one_shot';
  const modelKey = o.modelKey || 'other';
  const weights = WEIGHTS[type];
  const scores = {
    clarity: scoreClarity(text),
    constraint: scoreConstraint(text),
    rubric: scoreRubric(text),
    grounding: scoreGrounding(text),
    regression: scoreRegression(text, o.prevReading || null),
    fit: scoreFit(text, modelKey),
  };
  return { type, modelKey, weights, scores, overall: avgScore(scores, weights) };
}

// ── SHA-256 + canonical JSON (the estate's proven pair, verbatim) ───────────────────────────────
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(text) {
  if (!isStr(text)) return { ok: false, why: 'sha256 takes a string' };
  const data = new TextEncoder().encode(text);
  const len = data.length;
  const padded = new Uint8Array((((len + 8) >> 6) << 6) + 64);
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  const bitLen = len * 8;
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296));
  dv.setUint32(padded.length - 4, bitLen >>> 0);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15], y = w[t - 2];
      const s0 = (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) >>> 0;
      const s1 = (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) >>> 0;
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + S1 + ch + K256[t] + w[t]) >>> 0;
      const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + hh) >>> 0;
  }
  const hex = (n) => n.toString(16).padStart(8, '0');
  return { ok: true, hash: hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7) };
}

export function canon(v) {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return '"?"';
}

/** Seal a reading: the overall + per-layer scores bound to a hash of the exact prompt. Tamper-evident. */
export function sealReading(text, opts, meta) {
  const g = gatePrompt(text, opts);
  const layerScores = {};
  for (const k of LAYER_KEYS) layerScores[k] = g.scores[k].score;
  const body = {
    v: 1, kind: 'prompt-gate-reading', type: g.type, modelKey: g.modelKey,
    overall: g.overall, layers: layerScores, promptHash: sha256(isStr(text) ? text : '').hash,
    at: (isObj(meta) && isStr(meta.at)) ? meta.at : null,
  };
  const h = sha256(canon(body));
  return { ...body, hash: h.hash };
}

export function verifyReading(r) {
  if (!isObj(r) || !isStr(r.hash)) return { ok: false, why: 'a reading is an object with a hash' };
  if (r.kind !== 'prompt-gate-reading') return { ok: false, why: 'not a prompt-gate reading' };
  const body = { ...r };
  delete body.hash;
  const h = sha256(canon(body));
  if (!h.ok) return { ok: false, why: h.why };
  return { ok: true, valid: h.hash === r.hash };
}

export default gatePrompt;
