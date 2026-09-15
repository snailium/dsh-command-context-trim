# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/snailium/dsh-command-context-trim/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/snailium/dsh-command-context-trim/releases/tag/v0.1.0
