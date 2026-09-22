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
- **The system prompt is never trimmed** (harness 0.1.5+ carries it as a surface node): it is a barrier that no
  elided span may touch or cross.
- **Mutual exclusion with everything else.** The handler runs inside `agent.runMaintenance()`, which fails unless the agent
  is idle, so it cannot interleave with a turn, `/compact`, or automatic compaction; it also refuses while an unmatched
  `compaction/start` is open.

## Automatic trimming on the context wall

`autoTrim` (default on) makes the same model-free reduction happen without anyone typing a command: a **prepended**
`agent/request-error` listener reacts to `CONTEXT_WINDOW_EXCEEDED`, trims, and asks the loop to retry.

```
request fails (context wall)
  ├─ prepended: context-trim   → trim a span, no model call → retry      ← wins when it can free space
  └─ next(): compaction-basic  → prune tool results → summarize (LLM)    ← only when trimming cannot help
```

Why `prepend` is the whole trick: `agent/request-error` is a Cordis **waterfall**, and compaction registers its own
summarization recovery on the same event. Cordis keeps listeners in registration order and `{ prepend: true }`
unshifts to the front, so this plugin runs first even though compaction is mounted later — in a web profile it lives
inside an agent-preset isolate realm, which no host-plane plugin can out-order by mount position. Returning
`{ kind: 'retry' }` without calling `next()` vetoes summarization for that attempt.

Scope, deliberately narrow:

| Event | Behaviour |
|---|---|
| `CONTEXT_WINDOW_EXCEEDED` on `agent/request-error` | trim, then retry |
| any other request failure | untouched (`next()`) |
| ordinary threshold compaction (`agent/pre-step` pressure) | **never touched** |
| `/compact`, the tool-result pruner | **never touched** |

The per-episode retry budget (`maxAutoTrimRetries`, default 3) resets when a completed assistant message lands or the
agent goes idle, mirroring compaction's own overflow accounting. Set `autoTrim: false` to keep trimming manual.

**A wrong `contextWindow` degrades into extra trimming, not a dead turn.** The first attempt trusts the declared window.
If the retry is rejected again, the declaration has just been contradicted, so every later attempt in that episode
retargets to `failingRequestTokens * (1 - autoTrimShrink)` — by default *halving* the request that was rejected — which
converges however far the backend is below its declaration, and logs a warning naming the setting to fix. With an honest
window the first attempt succeeds and the adaptive path never runs. The real fix for a mismatched backend is the setting:
`contextWindow: 32768` makes the first trim target ~22k and fit.

Trade-off, stated plainly: an automatic trim **drops** the oldest span instead of summarizing it. On a small local
window that is the point — the summarizer must fit the region it is condensing and frequently cannot — but the dropped
text is replaced by a marker rather than a summary. `/compact` stays available, and the full text remains in the
durable session log.

## What is protected

| Protected | Why |
|---|---|
| Leading `protectHeadNodes` nodes (default 1) | The task statement — dropping it destroys the point of the conversation. |
| Recent tail (`retainRatio` of the window, floor `minTailTokens`) | Recency is what a coding agent needs; retention is relaxed only when the fit is otherwise impossible, and the result says so. |
| The **newest** `user/message` | The live human instruction. It is never elided and no span may cross it, so an ongoing request cannot be dropped. Older user messages are ordinary nodes. |
| The final surface message | **A preference, not a prohibition.** Kept whenever any older span can free enough; dropped only as a last resort, and typically only together with its tool call (they can only be removed as a pair). |

Within those bounds the policy is **oldest-first, least-long-possible**: the elided span starts at the oldest balanced cut
and grows only until it frees exactly enough tokens.

Elision always starts at the **oldest** balanced cut, and the search is graded so that the cheapest loss is tried first:

1. a span that stays **outside the retained tail** and keeps the **final message** (the configured retention, relaxed step
   by step only if the fit otherwise fails);
2. a span that may reach **into the retained tail**, still keeping the final message;
3. **last resort** — a span that includes the final message, typically the current step's assistant tool-call plus its tool
   result, which can only be removed as a pair.

Protecting the final message outright deadlocks the most common overflow shape: one large assistant tool-call whose tool
result is the last node cannot be removed as a pair, which left a handful of freeable tokens while the request stayed over
the wall (observed live: "largest balanced span frees ~4 of the ~4631 tokens needed"). The newest user message is the real
anchor and stays a hard barrier in every tier. With `allowTailTrim: false` the search ends after tier 1, so the retained
tail is a hard boundary and the final message is never dropped.

## Compatibility

| Harness | State |
|---|---|
| 0.1.2-rc.1 (`latest`) | ✅ full suite green |
| 0.1.5-rc.2 (`next`) | ✅ full suite green |

Two harness changes between those lines are handled without a version check:

- **The replacement marker was renamed** — `{op: 'replace', start, end}` became `{op: 'replace', startSeq, endSeq}`.
  The plugin probes a throwaway detached session with each known shape at first use and writes the accepted one.
- **The system prompt moved onto the surface** — 0.1.5 carries it as `system/message` node 0 instead of
  `header.system`. System nodes are treated as **barriers**: they are never elided, no elided span crosses one,
  and `protectHeadNodes` counts only non-barrier nodes, so head protection keeps covering the task statement
  rather than the system prompt.

Because of the second change, the fixed request overhead is now the tool schemas plus any other non-surface
request data; on 0.1.2 it also included the system prompt. A trim's budget itself is unaffected — it comes from
the token meter's total, whichever way the harness splits that total.

## Configuration

Override on the `context-trim` row of a profile patch (the bundle's own `cordis.patch.yml` lists the full default set):

| Key | Default | Meaning |
|---|---|---|
| `targetRatio` | `0.9` | `budget = floor((contextWindow - reserveOutputTokens) * targetRatio)` |
| `reserveOutputTokens` | `8192` | Output space kept for the model's own reply. Keep it plus the provider's own `maxTokens` inside the real window: a 32k server with `maxTokens: 16384` exhausts the window with prompt + output even when every prompt fits |
| `retainRatio` / `retainTokens` | `0.16` / — | Recent tail kept verbatim (mutually exclusive forms) |
| `minTailTokens` | `2048` | Absolute floor for that tail |
| `protectHeadNodes` | `1` | Leading nodes that are never trimmed |
| `allowTailTrim` | `true` | Enable tiers 2–3 (reach into the retained tail; as a last resort include the final message). `false` ends the search after tier 1, making the retained tail a hard boundary |
| `markerSlackTokens` | `64` | Slack added to the priced marker so the post-trim request stays under budget |
| `autoTrim` | `true` | Trim automatically on `CONTEXT_WINDOW_EXCEEDED`; never fires on ordinary compaction |
| `maxAutoTrimRetries` | `3` | Automatic trims allowed per overflow episode before compaction takes over |
| `autoTrimShrink` | `0.5` | After a repeat overflow, retarget to this fraction of the rejected request (geometric descent when the declared window is wrong) |

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

## Reading the session log

`compaction/prune` has **two producers**, and only one of them is this plugin:

| Producer | Where | Followed by | Shape |
|---|---|---|---|
| **this plugin** (`/trim`, automatic) | inside a step, right after a failed attempt | `user/message` whose `source.plugin` is `dsh-command-context-trim` | a whole span, both cut edges tool-pairing balanced |
| **DSH's tool-result pruner** | in compaction's own path | `tool/result` replacing exactly one node | a single `tool/result`, its `tool/call` kept |

Position is the other tell: a prune **between `step/end` and `step/start`** belongs to compaction's *pressure*
path (and this plugin, being overflow-only, is deliberately not involved); a prune **inside a step, after an
`assistant/attempt`** is an overflow recovery. A session with no `assistant/attempt` events never hit
`CONTEXT_WINDOW_EXCEEDED` at all, so this plugin never ran in it.

Two accounting traps when checking whether a trim helped: `assistant/message` `usage` is **per request**
(`input + cacheRead + output` for that call), not a session total — and a tool result is appended *after* the
request that produced its tool call, so comparing consecutive `usage.total` values measures "content was added",
not "the trim freed nothing". Compare the rejected attempt with the retry instead. Also, an in-place replacement of
the *last* node keeps the cached prefix (so `cacheRead` stays high); only a mid-conversation cut — this plugin, or
compaction rewriting the head — breaks it, which shows up as `cacheRead` dropping and `input` jumping on the next call.

## Development

### End-to-end overflow check (no model needed)

`scripts/mock-overflow-server.mjs` is a stateful OpenAI-compatible endpoint that enforces a **real** limit lower than the
`contextWindow` the harness is told, and answers the first `TOOL_STEPS` requests with a tool call so one turn keeps
looping and grows past the real limit — the context wall, without a model switch:

```bash
node scripts/mock-overflow-server.mjs &            # PORT=4185 TOKEN_LIMIT=12000 TOOL_STEPS=4
# point an ISOLATED profile at it (provider with contextWindow 20000, baseURL .../v1), then:
DSH_HOME=$(mktemp -d) dsh --profile headless "..."   # see the isolated-home procedure in dsh-plugin-packaging
```

A passing run leaves this in the session log: `assistant/attempt` (the wall), then exactly one `compaction/prune` + one
`user/message` replacement, then a **succeeding** retry — and **zero** `compaction/start`, proving the request was
repaired by trimming and that summarisation never ran.


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
| `npm test` (51 tests: planner, args, surface apply + log replay, plugin handler, automatic overflow path) | ✅ passing |
| Isolated `DSH_HOME` install (`dsh plugin add file:…`) reconciling dependency **and** bundle layer | ✅ verified |
| Composed profile tree contains the `context-trim` insert row (`dsh --dump-config`) | ✅ verified |
| Profile boot with the plugin mounted (no load error) | ✅ reaches the credential check cleanly |
| Same suite against the pinned **published** harness packages (`npm ci`) | ✅ 51 passing |
| Integration against the **real** `ctx.tokenMeter`: measured drop equals the claimed shadow price, and a fresh meter replaying the trimmed log reaches the identical total | ✅ 4 tests |
| Real-`cordis` proof that a `prepend`ed waterfall listener runs first and vetoes the chain (the mechanism the automatic path depends on) | ✅ 3 tests |
| Same suite on harness 0.1.5-rc.2 (renamed marker + surface system prompt) | ✅ 51 passing |
| CI workflow (Node 22 / 24) | ✅ green |
| npm release via GitHub Actions | ✅ 0.1.0 published with provenance (`+ dsh-command-context-trim@0.1.0`) |
| Isolated profile install **from the npm registry** (dependency + bundle layer + composed insert row) | ✅ 0.1.0 |
| End-to-end in the web GUI against a small-window model | ⏳ harness ready, not yet run |

## License

MIT
