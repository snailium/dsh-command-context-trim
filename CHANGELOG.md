# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-09-22

### Fixed

- **A wall hit is no longer a one-shot.** Reported from a 32k backend while `settings.yaml` declared `contextWindow:
  90000`: the first automatic trim targeted `(90000 - 8192) * 0.9 ~= 73.6k`, the retry was rejected again, and with
  `maxAutoTrimRetries: 1` spent the recovery fell through to compaction — whose summarisation request is itself over the
  real limit, so the turn died. The plugin now adapts instead of trusting a declaration it has just seen contradicted:
  - the **first** attempt still trusts the declared window (cheap, and correct when the window is honest);
  - every **later** attempt inside the same episode retargets to `failingRequestTokens * (1 - autoTrimShrink)`, i.e. it
    halves the request that was just rejected — a geometric descent that converges however wrong the declared window is;
  - a repeat attempt also logs an actionable warning: the routed model's `contextWindow` is larger than the backend
    actually serves, fix it in `settings.yaml` (and the server's own context flag).
- Defaults changed accordingly: `maxAutoTrimRetries` **1 → 3**, and a new `autoTrimShrink` (**0.5**).

### Notes

- The honest fix for a mismatched backend is still the setting itself: with `contextWindow: 32768` the very first trim
  targets ~22k and succeeds without the adaptive path. The adaptive path exists so a wrong declaration degrades into
  "more trimming than necessary" rather than a dead turn.
- Nothing else changed: the event, its gating (`CONTEXT_WINDOW_EXCEEDED` only), the elision preference tiers and the
  newest-user-message barrier are untouched.


## [0.2.0] - 2026-09-16

### Added

- **Automatic trimming on the context wall.** A `prepend`ed `agent/request-error` listener reacts to
  `CONTEXT_WINDOW_EXCEEDED`, frees space with no model call, and asks the loop to retry. Only when it cannot free
  anything does the waterfall continue into DSH's own recovery (prune + summarize) — so a session that hits the wall
  is repaired by *dropping* the oldest span first and only pays for summarization when dropping cannot help.
  This is the unattended form of `/trim`; it is the same execution, invoked by the harness instead of a human.
- Configuration `autoTrim` (default `true`) and `maxAutoTrimRetries` (default `1`, per overflow episode).
- **The elided span is chosen by explicit preference tiers.** Elision always starts at the oldest balanced cut, and the
  search is graded: (1) stay outside the retained tail and keep the final message, with the configured retention relaxed
  step by step only if the fit otherwise fails; (2) reach into the retained tail, still keeping the final message;
  (3) last resort — include the final message, typically the current step's assistant tool-call plus its tool result,
  which can only be removed as a pair. `allowTailTrim: false` ends the list after tier 1. The plan and every rendered
  result state when the last-resort tier was used.
- **Planner anchor changed: the newest `user/message` is protected, the final node is not.** The previous rule
  ("never elide the final surface node") deadlocked the most common overflow shape — one large assistant tool-call whose
  tool result is the last node could not be removed as a pair, so only a handful of tokens were freeable while the
  request stayed over the wall (observed live: "largest balanced span frees ~4 of the ~4631 tokens needed"). The newest
  human instruction is now a **barrier** (never elided, never crossed) and everything after it stays eligible, tool
  pairing still enforced on both cut edges.

### Notes

- **Scope: the context wall only.** The listener fires exclusively for `CONTEXT_WINDOW_EXCEEDED`. Ordinary
  threshold compaction (`agent/pre-step` pressure), `/compact`, and the tool-result pruner are untouched — this is
  asserted by a test that pins the registered listener set.
- Why `prepend` is required: `agent/request-error` is a Cordis waterfall and compaction registers its summarization
  recovery on the same event. Cordis stores listeners in registration order and `{ prepend: true }` unshifts, so this
  listener runs first even when compaction is mounted later inside an agent-preset isolate realm (as it is in a web
  profile). Returning `{ kind: 'retry' }` without calling `next()` vetoes summarization for that attempt.
- The per-episode budget resets when a completed assistant message lands or the agent goes idle, mirroring
  compaction's own overflow accounting.
- Trade-off, stated plainly: an automatic trim **drops** the oldest span rather than summarizing it. That is the
  point on a small local window — the summarizer must fit the region it is condensing and frequently cannot — but it
  does mean the dropped text is replaced by a marker instead of a summary. `/compact` remains available, and the full
  text stays in the durable session log.


## [0.1.1] - 2026-09-15

### Fixed

- **DeepSeek Harness 0.1.5 compatibility.** 0.1.5 renamed the positional replacement marker
  (`{op: 'replace', start, end}` → `{op: 'replace', startSeq, endSeq}`), so every trim failed with
  `session event "user/message" carries an invalid replace surfaceOp`. The plugin now probes the accepted shape
  once against the harness actually installed and writes that one, so the same build works on the 0.1.2 and
  0.1.5 lines without a version check.
- **The system prompt is never trimmed — and no longer eats head protection.** 0.1.5 moved the system prompt
  from the request header onto the surface as node 0 (`system/message`). A position-only "protect the first
  node" rule would have protected the *system prompt* and exposed the **user's original request** as the first
  elidable message. System nodes are now barriers: never elided and never crossed, and `protectHeadNodes` counts
  only non-barrier nodes, so it keeps protecting the task statement.

### Notes

- No configuration changes. The only user-visible difference is the "fixed request overhead" refusal, which now
  says "tool schemas and other non-surface request data": on 0.1.5 the system prompt is surface content rather
  than header content.
- Verified on harness 0.1.2-rc.1 and 0.1.5-rc.2 (40 tests each, same build).


### Added

- Integration tests against the **real** `ctx.tokenMeter` (bare cordis context + stub projection registry): a trim's
  measured saving equals the `compaction/prune` shadow price it claims minus the replacement marker, and a *fresh* meter
  folding the replayed log reaches the identical total — the replay property the claim exists for.

## [0.1.0] - 2026-09-15

### Added

- **`/trim` — model-free context trimming.** Drops the oldest tool-pairing-balanced span of the model-visible surface so a
  session built against a large-window cloud model can keep running on a smaller local model. It makes no model call at
  all, which is the case `/compact` cannot rescue: compaction summarizes, so its summarizer must fit the very region it is
  condensing in the now-smaller window.
- Forms: `/trim` (fit the active or pending model window), `/trim check` (plan only, change nothing),
  `/trim 32k` (explicit budget), `/trim provider:model` (fit another route's declared window).
- Protected context: the leading task statement (`protectHeadNodes`), the most recent messages (`retainRatio` /
  `minTailTokens`), and the final surface node. Within those bounds the policy is oldest-first and frees only what the
  budget requires; retention is relaxed only when the fit is otherwise impossible, and the result says so.
- Configuration: `targetRatio`, `reserveOutputTokens`, `retainRatio` / `retainTokens`, `minTailTokens`,
  `protectHeadNodes`, `allowTailTrim`, `markerSlackTokens`.
- Every refusal (fixed request overhead already over budget, no balanced cut point, not enough freeable) explains itself
  and writes nothing to the session.

### Notes

- One trim appends exactly two events: a `compaction/prune` shadow-price claim for the meter's O(1) projections, then a
  `user/message` positional replacement citing every shadowed node. `user/message` is the only surface-eligible event an
  idle command may append — `assistant/message` needs an open step and a `tool/result` replacement needs an open turn.
- Nothing is lost: replacements are model-only (the human transcript reads append-origin events) and the full original
  content stays in the durable session log. v1 has no `/untrim`.
- Requires a harness that exposes `ctx.commands`, `ctx.tokenMeter`, and `ctx.llm` (DeepSeek Harness 0.1.2-rc.1 or later).

[Unreleased]: https://github.com/snailium/dsh-command-context-trim/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/snailium/dsh-command-context-trim/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/snailium/dsh-command-context-trim/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/snailium/dsh-command-context-trim/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/snailium/dsh-command-context-trim/releases/tag/v0.1.0
