# dsh-command-context-trim

A **model-free `/trim` command** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): drop the oldest,
least valuable span of a conversation so a session can continue on a **smaller-context model** — without a single model call.

[中文说明 →](README.zh.md)

## Why

Switching a long session from a large-window cloud model to a smaller local model makes the *next* request exceed the new
model's window. The established workaround is `/compact` before switching — and that is exactly where it hurts:
compaction **summarizes**, so its summarizer call must fit the (now smaller) window while holding the very region being
condensed. It frequently fails for the same reason the original request failed.

DSH's automatic context-overflow recovery has the same property: it retries by summarizing with the routed model, so on a
too-small local window the recovery call overflows too, and the original error is preserved.

`/trim` needs no model at all. It measures the current request under the target route, picks the oldest
tool-pairing-balanced span that frees exactly enough tokens, and shadows that span with one short marker message. Two
synchronous appends, zero LLM calls — it works precisely when every request is failing.

## Install

```bash
# from npm
dsh plugin --profile web add dsh-command-context-trim

# from a checkout
dsh plugin --profile web add file:/path/to/dsh-command-context-trim
```

The package declares `dsh.bundle.patch`, so `dsh plugin add` also adds it to the profile's `dsh.profile.bundles` and its
insert row (plugin id `context-trim`) is composed automatically. Then restart the profile's app (`/trim` appears in the
slash-command menu with its argument hint).

## Usage

```
/trim                       fit the active model window
/trim check                 report the plan, change nothing
/trim 32k                   fit an explicit 32768-token budget
/trim lc:/models/qwen.gguf  fit that route's declared window
```

Typical use:

1. Switch the session to the smaller local model.
2. Run `/trim` (or run it *before* switching, while the large model is still active — the command targets the newest
   `model/selection` intent, so a pending switch is honored).
3. Continue the conversation.

Success output:

```
Trimmed 47 messages (seqs 12-105, ~52310 tokens → 63-token marker) for lc:/models/Qwen3.8-27B-Q4_K_M.gguf (window 90000).
Request size: ~118204 → ~66310 tokens (target 73612).
```

Every refusal explains itself and changes nothing — for example when the fixed request overhead (system prompt + tool
schemas) alone exceeds the budget, or when the protected head/tail cannot be relaxed far enough.

## How it works

One trim is two synchronously adjacent appends:

| # | Event | Why |
|---|---|---|
| 1 | `compaction/prune` | The token meter's **shadow-price claim**. The meter's persisted projections are O(1) and cannot re-price a replaced range, so a replacement must be preceded by an event stating the exact price of the range it shadows; without it the fold records a zero delta and reported occupancy drifts. |
| 2 | `user/message` with `surfaceOp: {op: 'replace', start, end}` | The replacement itself. `sourceEventSeqs` cites every shadowed node, as the surface contract requires. |

`user/message` is **the only surface-eligible event an idle command may append**: `assistant/message` requires an open
step and a `tool/result` replacement requires an open turn, so a trim performed between turns — which is exactly when a
user needs one — has no other legal node type.

Design consequences:

- **The human transcript is untouched.** Replacements are model-only; the transcript reads append-origin events. The full
  original content stays in the durable session log, so a trim is auditable and recoverable by hand.
- **No tool-call/result pair is ever split.** Cut edges are chosen with
  `toolPairingBalancedBefore`/`After` from `@deepseek-ai/dsh-compaction`.
- **Mutual exclusion with everything else.** The handler runs inside `agent.runMaintenance()`, which fails unless the agent
  is idle, so it cannot interleave with a turn, `/compact`, or automatic compaction; it also refuses while an unmatched
  `compaction/start` is open.

## What is protected

| Protected | Why |
|---|---|
| Leading `protectHeadNodes` nodes (default 1) | The task statement — dropping it destroys the point of the conversation. |
| Recent tail (`retainRatio` of the window, floor `minTailTokens`) | Recency is what a coding agent needs; retention is relaxed only when the fit is otherwise impossible, and the result says so. |
| The final surface node | Never elided, even when trimming into the tail. |

Within those bounds the policy is **oldest-first, least-long-possible**: the elided span starts at the oldest balanced cut
and grows only until it frees exactly enough tokens.

## Configuration

Override on the `context-trim` row of a profile patch (the bundle's own `cordis.patch.yml` lists the full default set):

| Key | Default | Meaning |
|---|---|---|
| `targetRatio` | `0.9` | `budget = floor((contextWindow - reserveOutputTokens) * targetRatio)` |
| `reserveOutputTokens` | `8192` | Output space kept for the model's own reply |
| `retainRatio` / `retainTokens` | `0.16` / — | Recent tail kept verbatim (mutually exclusive forms) |
| `minTailTokens` | `2048` | Absolute floor for that tail |
| `protectHeadNodes` | `1` | Leading nodes that are never trimmed |
| `allowTailTrim` | `true` | Let the elided span reach into the retained tail when necessary |
| `markerSlackTokens` | `64` | Slack added to the priced marker so the post-trim request stays under budget |

## Limits

- **It drops content; it does not summarize.** A trimmed detail is gone from the model's view (still in the log). When you
  want a *summary* instead, use `/compact`; the two complement each other (`/trim` first makes a later `/compact` cheaper
  and more likely to succeed).
- **It cannot shrink the fixed envelope.** System prompt and tool schemas are outside the surface; if they alone exceed the
  budget, `/trim` says so instead of pretending.
- **Nothing is restored.** There is no `/untrim` in v1: re-inserting earlier content as surface nodes would need
  `assistant`/`tool` events, which are only legal inside an open turn.
- **Heuristic pricing.** Budgets use the token meter's own estimate — the same numbers `/compact` and the GUI context bar
  use. Provider-reported usage drifts slightly from it.

## Development

```bash
npm install            # the harness contracts this plugin builds on, pinned as devDependencies
npm test               # node --test
npm run link:harness   # or resolve @deepseek-ai from a local dsh installation instead of npm
```

Tests cover the pure planner and argument parser, the surface mutation against a real `Session` (including log replay),
the plugin's command registration and end-to-end trim over a stub context, and — against the real `ctx.tokenMeter` — that a
trim's measured saving equals the shadow price it claims and that a fresh meter replaying the trimmed log lands on the very
same total. CI runs the suite on Node 22 and 24;
releases go out through `.github/workflows/publish.yml`, which is manual-only (`workflow_dispatch`).

### Verification status

| Check | State |
|---|---|
| `npm test` (34 tests: planner, args, surface apply + log replay, plugin handler) | ✅ passing |
| Isolated `DSH_HOME` install (`dsh plugin add file:…`) reconciling dependency **and** bundle layer | ✅ verified |
| Composed profile tree contains the `context-trim` insert row (`dsh --dump-config`) | ✅ verified |
| Profile boot with the plugin mounted (no load error) | ✅ reaches the credential check cleanly |
| Same suite against the pinned **published** harness packages (`npm ci`) | ✅ 34 passing |
| Integration against the **real** `ctx.tokenMeter`: measured drop equals the claimed shadow price, and a fresh meter replaying the trimmed log reaches the identical total | ✅ 4 tests |
| CI workflow (Node 22 / 24) | ✅ green |
| npm release via GitHub Actions | ✅ 0.1.0 published with provenance (`+ dsh-command-context-trim@0.1.0`) |
| Isolated profile install **from the npm registry** (dependency + bundle layer + composed insert row) | ✅ 0.1.0 |
| End-to-end in the web GUI against a small-window model | ⏳ harness ready, not yet run |

## License

MIT
