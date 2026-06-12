# ⚒ fall-prompt-gate

> Sovereign prompt evaluation. Six layers · version history · regression detection · single HTML file.
> Prime **619** · MIT · ◊·κ=1

**Live:** [sjgant80-hub.github.io/fall-prompt-gate](https://sjgant80-hub.github.io/fall-prompt-gate/) · **Fork it:** [github.com/sjgant80-hub/fall-prompt-gate](https://github.com/sjgant80-hub/fall-prompt-gate)

---

## What it is

A prompt audit tool for anyone who builds with AI agents. Paste the prompt. Pick the type (agent system / sub-agent / one-shot / tool-use / skill / reference). The Gate reads it through six layers — weighted for the type — and tells you exactly where the prompt is hedging.

Saves every reading to IndexedDB. When you bump the version, the Gate shows the delta against the last one. **Regressions get flagged before they ship.**

Runs entirely in your browser. Your prompts never leave your device — unless you opt into a scenario run, which sends the prompt + your test inputs direct to `api.anthropic.com` with your own key.

Forked in spirit from [copy-gate](https://github.com/sjgant80-hub/copy-gate). Informed by the [AI Craftspeople Guild](https://aicraftspeopleguild.github.io) audit checklist.

---

## The six layers

| # | Layer | What it checks |
|---|---|---|
| 1 | **Clarity** | Specific or vague? Imperative verbs, concrete markers (numbers, paths), hedge words, adverb spray. |
| 2 | **Constraint** | Are the rails defined? Negative-space markers (do not / never / avoid), edge-case handling, scope boundaries. |
| 3 | **Rubric** | Does the prompt say what "good" looks like? Format directives, schemas, examples, output structure. |
| 4 | **Grounding** | Anchored or floating? Role statements, file references, section markers, input variables. |
| 5 | **Regression** | How does this version compare to the last saved one (same name)? Line similarity, token delta, score deltas per layer. |
| 6 | **Model fit** | Suits the chosen target model? Token sweet spot, chain-of-thought on fast models, missing rubric on rubric-loving models. |

Weights vary by prompt type. An agent system prompt lives or dies by Constraint + Rubric. A reference / spec file lives or dies by Grounding. A one-shot lives or dies by Clarity. The Gate weights accordingly.

## Use it

1. Open [the tool](https://sjgant80-hub.github.io/fall-prompt-gate/) (or `index.html` from `file://`)
2. Paste the prompt
3. Name it (e.g. `fallbrief-system-prompt`) and version it (`v1`, `v2`, …)
4. Pick prompt type + target model class
5. Hit **Run the Gate**
6. Read the six scores and the prioritised findings
7. (Optional) Add scenarios — inputs the prompt should handle — and hit **Run Scenarios** with your Anthropic API key for behavioural testing + LLM-as-judge scoring
8. **Save Reading** — when you ship v2 later, the Gate will diff against v1 automatically

Saves to IndexedDB. Export individually as Markdown or the whole journal as JSON.

## Why this is needed

Traditional code review assumes a human wrote every line with intent. Prompts get rebuilt session-by-session, model-by-model, and prompt-shaped failures don't surface in code review.

- A one-shot prompt fails loudly. An agent prompt fails *quietly* — broken in step 3 of a 12-step chain, only under a specific tool call.
- When yesterday-worked is today-broken, was it the prompt, the model rev, or the tool API? Without version + model history, you can't tell.
- Scoring a prompt against its own training output is **test theatre** — exactly the failure mode the Guild audit checklist names.

The Gate doesn't write the prompt for you. It runs the cheap heuristics so you spend your time on the expensive judgement.

## The one rule

**Trust needs proof — and proof has to be checked.** A green Gate doesn't mean the prompt works. It means six heuristics didn't catch anything. **Run the scenarios. Read the outputs.** Don't ship until the actual behaviour matches the rubric.

---

## For developers

```
index.html      one file · sovereign · vanilla JS · no dependencies
README.md       this
LICENSE         MIT
.nojekyll       Pages deploy
```

Open the file from `file://` and it works. That's the test.

### Architecture

- **Sovereign:** single HTML file · vanilla JS · works from `file://`.
- **Persistence:** IndexedDB (`fall-prompt-gate` database, `readings` store). One record per Gate run. Indexed by name + ts.
- **Privacy:** prompts stay on device. The only outbound call is to `api.anthropic.com`, opt-in, with your own key, only when you click **Run Scenarios**.
- **Schema:** every reading has `{ id, name, version, type, model, text, scores, weights, avg, ts, prevVersion?, scenarios? }`. Forwards-compatible — bump `SCHEMA_VERSION` if the shape changes.
- **Layer engine:** six pure functions, no shared state, each returns `{ score: 0-100, notes: string }`. Easy to extend or swap.
- **LLM-as-judge:** when running scenarios with an expected-behaviour rubric, output is sent to a separate Sonnet-class judge call returning strict JSON. Honest, scored 0-100.

### Adding a layer

1. Write a `scoreYourLayer(text)` returning `{ score, notes }`
2. Add to `WEIGHTS[type]` for each prompt type — total each row to 100
3. Add to `LAYER_NAMES` and to `runGate()`'s `scores` object
4. Add a row to the framework modal table

### Adding a prompt type

1. Add to `WEIGHTS` keyed by your snake_case id, weights summing to 100
2. Add an `<option>` to the `#ptype` select in the HTML
3. Done

### Adding a model class

1. Add to `MODEL_PROFILES`: `{ name, tokenSweetSpot: [lo, hi], wantsRubric, toleratesChain, apiId }`
2. Add an `<option>` to the `#pmodel` select
3. `apiId: null` = local / offline-only · scenario runs are disabled for that class

## Roadmap

- Bloom vector per reading (compress reading state to 7-prime ring vector per [konomi-dot-protocol](https://github.com/sjgant80-hub/konomi-dot-protocol))
- Trend chart per prompt name across versions
- Multi-model scenario runs (one prompt, three model classes, side-by-side)
- Import / export individual readings, not just full journal
- Skill / sub-agent file ingestion (drag in a `.md` from `.claude/commands/`)

Pull requests welcome. The bar: every line of code pays rent.

## Credit

- **AI Craftspeople Guild** — the audit checklist that framed the discipline.
- **copy-gate** — the engine pattern this is forked from.
- **Anthropic's prompt eval guidance** — the loop concept (run · score · iterate · version).

⚒ Part of the [fall* estate](https://github.com/sjgant80-hub) · prime 619 · ◊·κ=1
