# dsh-command-context-trim

A **model-free `/trim` command** and a **compaction-threshold tuner** for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): give a small-window local model every token it can
actually use, compact it less often, and repair a blown context window without a single model call.

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

The other half of this plugin goes after the cause instead of the symptom: it raises *where* compaction fires, which
on a small local window is the difference between using most of the context or less than half of it.

## What this buys a local model

DSH reserves a **fixed 65536-token headroom** whatever the window is, and the trigger is
`min(thresholdRatio × W, W − R − headroom)` where `R` is the route's own output reserve. On a million-token cloud
route that barely matters. On a local card it decides everything:

| route | W | R | dsh default trigger | tuned (`headroomTokens: 0`, `r = 0.8`) | usable context |
|---|---:|---:|---:|---:|---|
| `Qwen3.8:27b @ Intel Arc B70` | 131072 | 16384 | 49152 — **37.5 %** | 104857 — **80.0 %** | **+55705 tokens, 2.1×** |
| `Bonsai 2 @ RTX 5060 8GB` | 40960 | 8192 | *no pressure path at all* (the route cannot compact early) | 32768 — 80.0 % | +32768 — but **measured slower**: see *When it does not pay* |
| `deepseek-official` (cloud) | 1000000 | 256000 | 678464 — 67.8 % | 744000 — 74.4 % | barely moves — tuning matters where the window is small |

Three consequences, in the order they matter:

1. **More usable context, so the model reasons over more of the real history.** On the routes above the ratio is no
   longer capped by a fixed reserve, so the session keeps roughly twice the conversation before anything is condensed.
2. **Fewer compactions where the stock headroom was capping the trigger — and compaction is the expensive part.**
   It costs a model call that *blocks the turn* (measured at 209–372 s with a local summarizer), so compacting
   later and less often removes those stalls. Read *When it does not pay* below before enabling this on a small
   window: there the same mechanism works in reverse.
3. **When the window is blown anyway, it is repaired without a model.** `/trim` shadows the oldest balanced span with
   a marker synchronously, with zero LLM calls: the turn continues in milliseconds instead of waiting minutes for a
   summarizer that may overflow for the very reason the request did. Installed in a profile, it also runs itself on
   `CONTEXT_WINDOW_EXCEEDED` (`emergencyTrim`), so the wall does not end the turn.

### When it does not pay

The benefit above is a *fewer, later* compactions benefit, and it exists only where the stock headroom was **capping**
a trigger the route could otherwise support. Where the stock headroom already **disables** the trigger outright — a
message budget at or below dsh's 65536 — turning one on cannot move an existing compaction; it **adds** events, and
every event is a summarizer call that blocks the turn.

Measured on `Bonsai 2 @ RTX 5060 8GB` (40960 / 8192) by the backend-test session on 2026-09-27, same task, single
route, tuning confirmed applied end to end: **15 → 24 compactions** with the 80 % trigger on, and prompt volume for
the run grew with them. With a local summarizer at 209–372 s per call, that is a net loss even though no individual
turn is wrong. So:

- enable the tuning where it **raises** an existing trigger (`message budget > 65536`, i.e. the large-window rows
  above, where 37.5 % becomes 80 %);
- **leave a small-window route alone** (`message budget ≤ 65536`) and let dsh's **overflow path** be the fallback: it
  still summarizes and retries when a request really exceeds the window, it is just rare instead of constant (the
  overflow path does not resolve a pressure spec, so a negative pressure budget does not affect it). `/trim` then
  remains the last-resort net, model-free, for the case where nothing else handled the error;
- do not switch auto-tuning on globally for a fleet: it is a per-backend decision. `DSH_TRIM_AUTO_TUNE=1` belongs on
  the backends whose window is big enough to benefit.

**You do not have to remember this.** The planner keeps such a route at its stock setting by default: it writes the
route a policy with dsh's stock 65536 headroom, so the pressure budget stays negative and the trigger stays disabled,
and it says so in its output. Enabling one there is an explicit choice — `--include-stock-disabled-routes` for
`scripts/make-preset-patch.mjs`, or `tuneStockDisabledRoutes: true` for `/trim tune` — and even then the measurement
above is printed next to it.

Two honest limits. Where the route's own reserve is larger than `(1 − r) × W`, the ratio is *unreachable by
construction* — `ovms` (81920/65536) and `opencode-go` are capped at 20 % and 61.6 % respectively; the tuner
moves those to their real ceiling rather than pretending. And the tuning applies where
compaction is composed on the profile plane (headless, tui); a web profile keeps compaction inside each session's
agent-preset realm, where a runtime write cannot reach a running session — see *Retuning the live process* below.

### The preset route is locked and has to stay resolvable

A session's preset is fixed once it starts (`agent-preset/locked`), and a **fork inherits the parent's preset and
is locked the same way**: `buildForkSeed` copies the parent's `turn/start` events into the child
(`dsh-session/lib/index.js:884-893`), and forking requires a completed turn to begin with, so the child's
`turnBoundary.lastTurn` is already above zero when it is created.

The sharper edge is permanence. `agentPresets.resolve(id)` has no fallback — an unknown explicit id throws
`agent-preset/not-found` (`dsh-agent-preset-registry/lib/index.js:603-610`) — so if a preset id disappears, every
session bound to it can be neither resumed nor forked, and the lock means it cannot be re-pointed at another one.
A dsh upgrade overwrites the **shipped** presets, and a generated preset can be deleted by hand; the id you generate
is therefore a durable interface. Keep it stable across plugin upgrades, keep at least one copy, and use
`/trim preset default` so that *new* sessions pick it up — existing ones will not follow.

On headless/tui the profile-plane path (`autoTuneCompaction`, `prunerThresholdChars`) has none of these problems,
because there `dsh-base` inserts both rows into the profile and a patch layer retunes them on every boot. Prefer
that plane where it exists; the preset route is the web-shaped exception.

### Which route to use

Both routes can set every compaction setting — thresholds, the pruner, **and** the summarizer
(`summarizationProvider` / `summarizationModel` are ordinary keys on `compaction-basic`, per route via
`modelPolicies` entries). Reach for the profile plane first, because it is retunable on every boot and carries no
lock.

| You want to | Use | Why |
|---|---|---|
| retune thresholds or the pruner (headless, tui) | `autoTuneCompaction`, the settings card, or a patch layer | applied at boot or live; nothing persists that can break |
| pick the summarizer (headless, tui) | the profile plane (`summarizationProvider` / `summarizationModel`, or `modelPolicies` per route) | ordinary config keys — no preset needed |
| do either one in **web** | `/trim preset` | the web host plane disables both rows, so nothing else can reach them |
| a different config per session or task | `/trim preset` | presets are per session; the profile is per profile |
| change a session that already started | start a **new** session | locked at the first turn, and a fork inherits the lock |

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

**If compaction cannot recover either, trim steps in.** When the plugin declines, it calls `next()` — running
compaction's own listener — and inspects the result. A value means compaction pruned and/or summarized and the loop is
already retrying. `undefined` means the original request error is about to be preserved and the turn will fail; at that
point the plugin takes **one emergency trim** (at most once per overflow episode), in which the head-protected nodes — the
original task statement — become elidable too. The newest human instruction is still never crossed. Set
`emergencyTrim: false` to keep the old hand-off behaviour.

**The cheap reduction runs first.** On the wall the plugin slims oversized tool results **in place** (head + marker + tail,
the same transform DSH's own pruner performs) and only elides a whole span when that is not enough:

```
request refused → in-place tool-result slim  →  elide one span  →  compaction (prune + summarize)
```

It calls the official `toolResultPruner` service when that service is reachable from the plugin's context (0.1.2, and a
0.1.5 headless profile where compaction stays on the host plane) and performs the same transform itself when it is not (a
0.1.5 web profile hides the pruner inside an agent-preset isolate realm). A slim keeps the node, its tool call and the
prefix up to it — the marker written in place says `[... tool result middle trimmed to fit the context window ...]`, which
is how a log shows that *this* plugin slimmed a node rather than DSH's pruner (`[... tool result middle pruned ...]`).
Set `preferInPlacePrune: false` to go straight to span elision.

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

**Marker provenance under session format v4.** The replacement message carries the source kind
`plugin:dsh-command-context-trim` — the `plugin:<plugin id>` shape v4 requires — because 0.1.7's admission path
refuses the retired `{kind: 'plugin'}` wrapper with `format v4 message requires a producer-owned source kind`.
Markers written before 0.3.1 are still recognised by this plugin, and dsh rewrites them when it upgrades a v3
session. This is **not** a 0.1.7-only release: running each line's own admission validator gives

| harness line | this version's marker | the retired wrapper |
|---|---|---|
| 0.1.2-rc.1 | accepted (the line ships no row-admission validator; the only `kind !== "plugin"` checks belong to other plugins' own markers) | accepted |
| 0.1.5-rc.3 | accepted (`assertV3RowAdmission`) | accepted |
| 0.1.7-rc.2 | accepted (`assertV4RowAdmission`) | **rejected** — the bug 0.3.1 fixes |

so `0.3.0` is the version that is restricted, to *older* lines being unaffected and 0.1.7 broken. Re-check the
shape against an installed dsh any time (a dsh upgrade could change the rule):

```bash
node scripts/check-session-marker.mjs --prefix <dir with node_modules/@deepseek-ai>
```

One host half loads on every supported harness line; two features are scoped to the line that introduced the plane they
need. Verified state, by feature:

| Harness | `/trim` | automatic trim | emergency trim | `/trim preset` | settings card |
|---|---|---|---|---|---|
| 0.1.2-rc.1 (the pinned devDependency floor) | ✅ | ✅ | ✅ | ❌ clear error | ❌ absent |
| 0.1.5-rc.3 | ✅ | ✅ | ✅ | ❌ clear error | ❌ absent |
| 0.1.7-rc.2 (`next`) | ✅ | ✅ | ✅ | ✅ | ✅ (schemastery ≥ 3.18.4) |

What the ❌ entries mean in practice:

- **Where auto-tuning actually applies (measured, not assumed).** In a **web** profile the host plane does not receive
the session agents' lifecycle events — the agents are created inside each session's preset realm — so neither the
automatic retune nor the preset-definition sync fires there: a web profile logs the boot-time refusal and then
nothing, however many sessions run. That is why web is a **manual** workflow: `/trim preset inplace` writes the
tuning, `/trim preset check` tells you when a newly added route made it stale, and a fork (or a new session) applies
it. The automatic paths remain meaningful for profiles whose host plane does own the agents (headless, TUI).

**Auto-sync keeps the preset definition current, and `check` says what is missing.** With `autoTuneCompaction` on,
a web profile cannot retune a running session (compaction lives inside its preset realm), so the plugin does the one
thing that plane allows: on the first new session it keeps the preset *definition* in sync — one write per preset id
per process, never blocking a turn — which is what makes the next fork, new session, or restart already correct when
a model is added to the profile. `/trim preset check` reports the gap directly: how many configured routes the
current preset covers, and an explicit warning for any **uncovered route at or below 64K**, where inheriting the
tuned top level would *enable* the pressure trigger — the configuration measured slower (15 -> 24 compactions).

**`/trim rescue <id>` brings a session back whose preset id disappeared.** `resolve()` has no fallback, so a session
bound to a preset that an upgrade (or a manual cleanup) removed can be neither resumed nor forked — and the lock plus
`assertPresetUnchanged` mean it can never be re-pointed at a different id. The repair is to make the id resolvable
again, which is also the moment to decide what it *is*: `/trim rescue <id>` clones a donor preset (`--from <preset>`,
default `standard`) and, unless `--untuned` is given, applies the same tuning `/trim preset inplace` would
(compaction trigger plus the derived pruner threshold). The report says out loud what the clone cannot restore: the
session's history does not depend on the plugin list, but its future turns do, so a preset that mounted extra tools
will not get them back from a donor. It refuses an id that still exists.

**`/trim preset inplace` removes the picking step.** Instead of declaring `<base>-tuned` it writes an override row
for the base preset's own id (`- id: preset-standard` + a complete `config:`), which is exactly how the Web editor
persists a preset edit. New sessions keep using `standard` and pick the tuning up with no picker interaction, and the
same row doubles as the repair for a session whose custom preset disappeared in an upgrade — recreating the id is
what makes that session loadable again (its history does not depend on the plugin list, only its future turns do).
The cost is that the shipped preset's own plugin list is shadowed until the row is removed, and `dsh` overwrites the
shipped copy on every upgrade.

**A conversation that has already started gets the tuning by being forked.** A running session is bound to the
preset realm it composed at its first turn, so editing the preset afterwards cannot reach it — but a fork composes a
fresh realm from the preset's *current* definition while carrying the parent's history. The workflow is
`/trim preset inplace` → (restart, so the composition certainly re-read the patch) → fork → keep working. The fork
has a new session id and is locked like any started session (it inherits the parent's `turn/start` events), which is
harmless because it already runs the tuned values. This is also why `/trim apply` — recomposing a live session past
the lock — is deliberately *not* implemented: the fork does the same job with documented behaviour only.

**`/trim preset` writes the pruner too.** It splices both rows of the preset it clones: `compaction-basic`'s trigger
and `tool-result-pruner`'s `thresholdChars`, the latter from the same derivation auto-tune uses
(`max(8192, min(32768, 2 × (contextWindow − maxTokens)))`, smallest routed window wins). That matters in a web
profile, where the host-plane rows are disabled and the preset is the only place the pruner can be configured — a
generated preset that left `thresholdChars` at 8192 would keep clipping every whole-file read.

**`/trim preset`** needs the preset plane (`agentPresets`), the config-editor service and `profileContext.patchPath`.
  Every package behind those — `dsh-agent-preset-registry`, `dsh-config-editor` — first appears at **0.1.7-alpha.1**, so
  an older harness gets "this profile composes no agent-preset registry" instead of a half-working command. Nothing else
  depends on them: the command lives in its own module, imported only when it runs.
- **The settings card** needs a 0.1.7 web host (`dsh-client-modules`, `dsh-client-ui-primitives`) and schemastery
  **3.18.4** for `.volatile()`, which is what makes an entry a settings namespace at all. Two things keep an older
  harness harmless: the schema marks those fields through a capability probe, so the plugin still imports (an
  unconditional `.volatile()` call broke 0.1.5 outright until the compat matrix caught it), and the browser half
  returns immediately when `configForms` is missing rather than registering into services that do not exist.

Two harness changes are handled without any version check, because both are shape-probed from the session itself:

- **The replacement marker was renamed** — `{op: 'replace', start, end}` became `{op: 'replace', startSeq, endSeq}`.
  The plugin probes a throwaway detached session with each known shape at first use and writes the accepted one.
- **The system prompt moved onto the surface** — 0.1.5 carries it as `system/message` node 0 instead of
  `header.system`. System nodes are treated as **barriers**: they are never elided, no elided span crosses one,
  and `protectHeadNodes` counts only non-barrier nodes, so head protection keeps covering the task statement
  rather than the system prompt.

Because of the second change, the fixed request overhead is now the tool schemas plus any other non-surface
request data; on 0.1.2 it also included the system prompt. A trim's budget itself is unaffected — it comes from
the token meter's total, whichever way the harness splits that total.

The manifest declares the same four lines under `dsh.compatibility.dshReleases` (`compatible` for 0.1.2-rc.1, 0.1.5-rc.2,
0.1.5-rc.3 and 0.1.7-rc.2 — exactly the versions this table has evidence for; everything else stays undeclared, which a
catalog reads as `unknown` rather than as support).

What the matrix proves, and what it does not: each CI leg installs that harness line's **real packages** and runs the
suite against them (that is what caught the schemastery regression), so this is contract-level verification rather than a
boot. Live instances have been booted on 0.1.5 (the `dsh-container` E2E below) and on 0.1.7 (the isolated-instance
checks below); a booted 0.1.5 **web** host — and therefore the browser half on that line — has never been exercised.

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
| `preferInPlacePrune` | `true` | Slim oversized tool results in place before planning any span; uses the official pruner when reachable |
| `compactionTargetRatio` | `0.8` | Trigger fraction written into a preset generated by `/trim preset` (shapes the preset only, never this plugin's trimming) |
| `compactionRoute` | unset | Optional `{provider, model}` pair for the generated preset's summarization call |
| `tuneStockDisabledRoutes` | `false` | When `false` (the default), a route whose *stock* profile has no pressure trigger is left that way — enabling a trigger there only adds compaction events (see *When it does not pay*), so the model-free `/trim` and dsh's overflow path keep the wall. Set it to `true` to tune those routes anyway |
| `prunerThresholdChars` | `auto` (`DSH_TRIM_PRUNER`) | The tool-result pruner's clip threshold. `auto` derives it per route as `max(8192, min(32768, 2 × (contextWindow − maxTokens)))`, smallest routed window wins, so one whole-file read is not clipped away on a small window (dsh's stock value is `8192`). An integer overrides it; `0` opts out and leaves the pruner alone. Same plane as the compaction row, so the same reachability rule applies — a web profile keeps the pruner inside each session's preset and the plugin reports that instead of writing. On a **small** window this is the lever that matters (see *When it does not pay*); with a **pressure trigger enabled** it makes prompts bigger, so think twice there |
| `autoTuneCompaction` | `false` | Retune this process's compaction row (only where compaction is on the profile plane). A web or production profile should set **this** (via its settings card or a patch layer); the `DSH_TRIM_AUTO_TUNE` environment variable that overrides it is an **automation/CI** switch only |
| `pruneThresholdChars` / `pruneHeadChars` / `pruneTailChars` | `8192` / `4096` / `1024` | In-place slim budgets, mirroring DSH's own pruner defaults |

## Permissions and failure bounds

What the plugin touches, stated so a reviewer does not have to infer it:

| Capability | State | Detail |
|---|---|---|
| Files | **yes, deliberately** | `/trim preset` writes **one** file: the profile patch (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`). It writes atomically (temp file + rename), keeps one rolling backup (`…bak-trim-preset`), and confines its own content to a marker-delimited block it can replace. `lib/preset-tune.js` holds the runtime's only `node:fs` import. Trimming itself touches no file: it edits the in-memory session surface through the documented `surfaceOp` mechanism. |
| Network | no | No socket, no HTTP client, no `fetch`. `/trim preset` asks the host's `llm` service for the configured routes (`listModels` / `resolveModelInfo`), which resolves from local metadata; the plugin itself never opens a connection. |
| Command | no | No child process, no shell, no `exec`/`spawn`. |
| Credentials | no | No key, token or credential is read, logged or forwarded. Provider credentials stay with the `llm-pi-ai` row. The runtime reads exactly **one** environment variable, `DSH_TRIM_AUTO_TUNE`, as an opt-in boolean feature flag. |
| Protected DSH behaviour | no | It never disables, replaces or shadows an official component. A generated preset is a **clone** of the preset in use with only the compaction group's config replaced — a new preset id, the original left untouched. |
| Diagnostics | one stderr line and one session record per retune | The cordis logger only reaches a user when a profile wires an exporter (a headless profile does not), so a retune — rare, and a behaviour change — also prints one line to stderr and appends one `context-trim/tuned` **non-surface** session record for analysis. Nothing per request, and never anything in the model's context or the token bill. |
| Test fixtures | `fixtures/`, not shipped | `fixtures/mock-overflow-server.mjs` and `test/compat/mock-llm.py` bind 127.0.0.1 for tests only. They are outside `lib/`, are never loaded at runtime, and are excluded from the published `files` list. |

Failure bounds:

- trimming is model-free and additive: it shadows context with one marker message and never summarizes;
- when nothing can be freed it declines and compaction proceeds — it never forces a partial trim;
- the automatic path is bounded: `maxAutoTrimRetries` attempts, one emergency trim per overflow episode, every decision logged;
- a `/trim preset` write that fails leaves the previous file intact (temp + rename) and reports the error instead of half-writing;
- the plugin never throws out of the overflow listener: a failure to trim is reported and the turn continues on the existing path.

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

## Tuning compaction's threshold (`/trim preset`)

DSH decides when to compact from `thresholdTokens = min(contextWindow × thresholdRatio, messageBudget − headroomTokens)`
with `headroomTokens` defaulting to **65536**. That default, not the ratio, decides the trigger on any window below
~370k: a 131072-token route compacts at **37.5 %**, not 80 %. The ratio cannot move it alone, and compaction's policy is
read at composition time inside a preset isolate realm, so a plugin cannot retune it at runtime.

`/trim preset` therefore writes a **preset**:

```
/trim preset              # generate + land a tuned preset from the configured routes
/trim preset inplace      # override the base preset's own id instead of adding an id (see below)
/trim preset check        # print the generated row + route coverage, write nothing
/trim preset list         # the routes a generated preset would cover, and the trigger each gets
/trim preset default      # also make the generated preset the default for NEW sessions
/trim preset p:m          # ... using p:m as the summarization route for this run
/trim rescue <id>         # recreate a preset id that went missing (--from <donor>, --untuned)
```

`/trim preset check` is the **staleness signal**: it counts the routes the current preset covers and warns about an
**uncovered route at or below a 64K message budget**, the one case where inheriting the tuned top level enables the
pressure trigger instead of leaving it at stock. Add a model to the profile, run `check`, and re-run
`/trim preset inplace` when it reports a gap:

```
coverage: 4 route(s) configured, 3 covered by this preset, 1 not covered.
⚠ uncovered SMALL route bonsai-8gb//models/mtp-lean.gguf (40960 − 8192 ≤ 65536): without a policy it inherits the
  tuned top level, which enables the pressure trigger on a route where that measured slower. Re-run /trim preset inplace…
```

It clones the preset the session is using (via `agentPresets.readDocument`, so the clone always matches the installed
dsh), replaces only `compaction-basic`'s config, and appends a marker-delimited row to the profile patch:

```yaml
# >>> dsh-command-context-trim: preset-standard-tuned (generated; delete this block to drop the preset) >>>
- insert:
    - id: preset-standard-tuned
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard-tuned
        order: 1.5
        plugins: …            # the cloned composition
# <<< dsh-command-context-trim: preset-standard-tuned <<<
```

The generated `compaction-basic` config carries a **per-route `modelPolicies` entry** with the headroom that lets
`compactionTargetRatio` decide, and an explicit `maxTokens` (headroom would otherwise supply it). Routes whose output
reserve makes the target unreachable are reported as capped rather than silently written. Then pick the new preset on the **New Session** screen — if it is not listed yet, restart dsh (a `patchReload: startup`
profile ignores patch edits until boot). A session's preset is locked once its first turn starts (`agent-preset/locked`
from the registry), because switching one recomposes the preset's whole isolate realm: an already-running session cannot
switch, which is why `/trim preset default` exists — it sets the default for every new session instead. That write is
guarded: the command waits (bounded, ~2.5 s) for the generated preset to appear as a **healthy** registration before
pointing the default at it, because the new-session path resolves the default and an unknown id would fail there.

`scripts/verify-preset-artifact.mjs` checks the whole thing against a real installation without writing anything.

The route field is free text rather than a dropdown: dsh 0.1.7's shared settings form exposes only
`settingsNumberField` and `settingsTextField` (see `@deepseek-ai/dsh-client-ui-primitives`' typed surface), and drawing a
custom control would step outside the staged-form contract — the frame, the override/reset semantics and the fenced write
all come from the shared form. `/trim preset list` is the inventory view instead: it prints every routable provider/model
with its window, output reserve and the trigger it would get.

Both keys are also editable in the GUI: **Plugins → Context trim** shows a card with the compaction trigger and the
summarization route. Only fields marked `.volatile()` appear there, and a volatile field arrives at the plugin as a live
handle, so every read goes through `readConfig` and an edit takes effect on the next invocation without a reload.

## Retuning the live process (`/trim tune`)

Where compaction is composed on the **profile plane** — anything built on `dsh-base`, i.e. headless and
tui — its threshold is an ordinary row's config, and cordis applies a config change by restarting the
fiber (`Fiber.update()` resolves the new config and calls `restart()`, i.e. dispose plus a fresh apply;
there is no "hot-reloadable only" restriction). So the tuning can be written at runtime:

```
/trim tune            # retune this process's compaction row from the routes it can see, then report
/trim tune check      # print the diff, write nothing
```

The routes come from the adapter (`ctx.llm.resolveModelInfo`) — the same source compaction itself uses —
so a profile that *claims* 128k while the backend really serves 40k is corrected rather than trusted. The
write is skipped when nothing changes, and it is refused with an explanation where it cannot work: in a
**web** profile compaction lives inside each session's agent-preset isolate realm (`ctx.get('compaction')`
is empty from the host plane), and a session's preset cannot change once it has started — tune the preset
there instead (see `/trim preset`).

`autoTuneCompaction: true` (off by default) does that automatically, and the trigger set was reviewed
rather than accumulated: the agent's creation (`agent/created`, the earliest point and the only one a
one-shot run is guaranteed to reach), **every request** before it is sent (`agent/request` — the guarantee
that a route change is applied before the request that would use it), a session's `model/selection` (the
precise "the route changed" signal, available before the next request rather than only inside it), and an idle
moment in a long-lived profile — the one trigger that takes the write outside a step entirely. A system-prompt insertion is deliberately **not** a trigger: it is committed even earlier in the same step
(the surface is built before the request hook), so it adds a second recompute for that step while still
needing a guess at the agent — the per-request hook already covers the moment. The write is
immediate and intentionally not awaited: a one-shot `dsh headless "task"` never reaches an idle moment, and
that is exactly where automated sessions live. It is safe early — the first trigger fires before anything
can be compacting — and idempotent, so an unchanged route writes nothing and a per-request re-check costs
no restarts. A write does restart the compaction row, so a *later* write can cancel a compaction that is in
flight; that is the one trade-off, and the log says so.

**The pruner is the other half of a small window.** `/trim tune` also writes `tool-result-pruner` when
`prunerThresholdChars` is set (`--pruner-threshold-chars` for the generator), on the same profile plane and
with the same guard: where the pruner lives inside a session preset — a web profile — the plugin says so and
writes nothing. Raising it means a `read` of a whole source file survives instead of being clipped to a head
and a tail, which is what breaks the re-read loop; on a route whose pressure trigger is *enabled* it also makes
each request bigger, so it is the right lever for the small-window case and a deliberate trade elsewhere.

**Automation only: `DSH_TRIM_AUTO_TUNE`, `DSH_TRIM_PRUNER`, `DSH_TRIM_TUNE_STOCK_DISABLED`.** The environment variable (`1`/`0`, `true`/`false`, `yes`/`no`,
`on`/`off`; empty means unset) switches the automatic retune on or off for one process, **overriding** the
profile's own `autoTuneCompaction`. It exists so a container, a CI harness or a benchmark script can enable the
behaviour without editing a profile. A normal **web or production profile should not set it**: the override would
silently win over the profile's setting, and in a web profile a runtime retune has nowhere to land anyway —
compaction there lives inside each session's agent-preset isolate realm. Configure a real profile through its
settings card, or through a patch layer, instead. (A refusal like that is reported once, not once per request,
so a stray variable in the wrong environment cannot flood a service log.)

## Automating a tuned threshold (headless runs)

A **headless** profile composes compaction itself — its tree carries `compaction-basic`, `command-compact`
and `tool-result-pruner` on the profile plane — and it never resolves a session **preset**; only the
session API, the web client and the `agent-preset` row do. Measured in one clean `DSH_HOME`: with a
generated preset plus `agent-preset-registry.selectedDefault`, and then with that preset's `tool-web` row
deleted as a control, the first request carried the **same 24 tools** every time — the preset rows sat in
the tree unused.

So automated runs take the other route: write the tuning onto the profile's own compaction row.

The window and output reserve differ per backend, so the generator resolves them from the best source
available: an explicit `--routes` list or a `--dump` of the composed profile (its `llm-pi-ai` provider
table carries `contextWindow`/`maxTokens` per model) as the base, with `--context-window`/`--max-tokens`/
`--model` as an **override** for the numbers a backend really serves. Nothing usable in any of them is an
**error rather than a guess**; `--window-agnostic` is the deliberate ratio-only overlay
(which needs no window, because `threshold = min(r·W, W − R)` is relative by construction).

```bash
DSH_HOME=$DSH_HOME dsh --profile headless --patch /path/to/route.yml --dump-config > /tmp/dump.yml
node scripts/make-preset-patch.mjs --mode host --ratio 0.8 --dump /tmp/dump.yml --out /tmp/host.yml
DSH_HOME=$DSH_HOME dsh --profile headless --patch /tmp/host.yml "do the task"
```

Step-by-step for a fresh environment, written to be handed to another session:
[`docs/headless-compaction-tuning.md`](docs/headless-compaction-tuning.md).
`fixtures/headless-tuned-preset/run-headless-check.sh` performs that drill against a fresh temporary home,
asserts `--dump-config` carries the tuned config on `compaction-basic`, and runs one real session.
Its README records what the drill does *not* assert, and why: the New Session picker label reflects a
client/host draft rather than the default, and a session created with the default carries no
`agent-preset/selected` event, so neither is usable as an automated assertion.

## Reading the session log

`compaction/prune` has **two producers**, and only one of them is this plugin:

| Producer | Where | Followed by | Shape |
|---|---|---|---|
| **this plugin**, span elision | inside a step, right after a failed attempt | `user/message` whose `source.plugin` is `dsh-command-context-trim` | a whole span, both cut edges tool-pairing balanced |
| **this plugin**, in-place slim | same place, before any span is planned | `tool/result` replacing exactly one node | one `tool/result`, marker `[... tool result middle trimmed to fit the context window ...]`, `callId` kept |
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

It lives in `fixtures/` rather than under `test/` on purpose: `node --test` executes every JavaScript file under
`test/`, so a server placed there would hang the suite.

### End-to-end overflow check (no model needed)

`fixtures/mock-overflow-server.mjs` is a stateful OpenAI-compatible endpoint that enforces a **real** limit lower than the
`contextWindow` the harness is told, and answers the first `TOOL_STEPS` requests with a tool call so one turn keeps
looping and grows past the real limit — the context wall, without a model switch:

```bash
node fixtures/mock-overflow-server.mjs &            # PORT=4185 TOKEN_LIMIT=12000 TOOL_STEPS=4
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
| `npm test` (149 tests: planner, args, surface apply + log replay, plugin handler, automatic overflow path, in-place slim, config, preset modes incl. `inplace`/`rescue`, coverage report, sync reporting) | ✅ passing |
| Isolated `DSH_HOME` install (`dsh plugin add file:…`) reconciling dependency **and** bundle layer | ✅ verified |
| Composed profile tree contains the `context-trim` insert row (`dsh --dump-config`) | ✅ verified |
| Profile boot with the plugin mounted (no load error) | ✅ reaches the model-provider check cleanly |
| Same suite against the pinned **published** harness packages (`npm ci`) | ✅ 103 passing |
| Integration against the **real** `ctx.tokenMeter`: measured drop equals the claimed shadow price, and a fresh meter replaying the trimmed log reaches the identical total | ✅ 4 tests |
| Real-`cordis` proof that a `prepend`ed waterfall listener runs first and vetoes the chain (the mechanism the automatic path depends on) | ✅ 3 tests |
| Same suite on 0.1.5-rc.3 (renamed replacement marker + surface system prompt) | ✅ passing |
| Same suite on 0.1.7-rc.2 (flat tool-result messages, `session.deriveEventMessage`) | ✅ passing |
| Same suite with schemastery 3.18.2 forced in, the version that broke the 0.1.5 leg (capability probe) | ✅ passing |
| `scripts/verify-preset-artifact.mjs`: the generated preset row, cloned from the **_shipped_** `standard` preset and parsed by the harness's own YAML stack | ✅ 19 plugin entries, isolate realm intact, 3 model policies |
| Isolated 0.1.7 instance (`start-isolated-dsh.sh`; own `DSH_HOME`, port 3091, mock provider): a generated row appended to the profile patch appears in the preset menu as *Standard (tuned 75%)* and is selectable — no restart, no runtime registration | ✅ verified |
| Same instance: the Plugins page lists the card under *Official* with its summary line, both fields render, a staged edit saves, and the value lands as a `context-trim` row in the profile patch | ✅ verified |
| Headless client-bundle test (fake `window.__ModuleLoader__`): summary one-liner, two-field form body, older-host no-op | ✅ 3 tests |
| **End-to-end in the real `dsh-container` image (0.1.5-rc.2, isolated home, mock backend)**: span path (33,373 → 18,431 tokens, `compaction/start` = 0) and in-place slim path (23,429 → 19,995 tokens, no span elided, pruner delegated to the official service) | ✅ both verified |
| `/trim preset inplace` in an isolated 0.1.7 instance: one bare override row for `preset-standard` (no `insert:`, no new id), `config.id: standard`, registry accepts it and the picker keeps the same preset | ✅ verified |
| Same instance: the derived pruner threshold lands in that row (`thresholdChars: 32768`, stock `8192` gone) and a re-run is idempotent, with no stacked name suffix | ✅ verified |
| `/trim rescue <id>` in an isolated instance: a bare override row for the **missing** id whose `config.id` matches it, tuned by default, refusing an id that still exists | ✅ verified |
| A live web instance logs the boot-time `compaction is not reachable from this plane` and then nothing per session — session agents are created inside preset realms, so their lifecycle events never reach the host plane | ✅ measured (see *Which route to use*) |
| **Bonsai 2 headless re-run with `DSH_TRIM_AUTO_TUNE=1`** (`session-2577e98b…`, 0.102): the tuned record carries `thresholdChars: 32768` and `compaction/prune` dropped **17 → 2** against the earlier 0.3.2 run | ✅ before/after verified |
| CI workflow (Node 22 / 24) | ✅ green |
| npm release via GitHub Actions | ✅ 0.1.0 published with provenance (`+ dsh-command-context-trim@0.1.0`) |
| Isolated profile install **from the npm registry** (dependency + bundle layer + composed insert row) | ✅ 0.1.0 |
| End-to-end in a real 0.1.7 boot (isolated home, mock backend): a request REFUSED at 10,664 tokens came back ACCEPTED at 7,230 after the automatic trim, with `compaction/start` = 0 | ✅ verified |

## License

MIT

---

## The arithmetic

Every number this plugin computes, with the defaults it starts from. Token-to-character work uses dsh's own
`CHARS_PER_TOKEN = 4` (`@deepseek-ai/dsh-token-meter`).

### 1. The trim budget (what `/trim` fits the surface into)

```
usable  = contextWindow − reserveOutputTokens          # reserveOutputTokens: 8192
budget  = max(1, floor(usable × targetRatio))          # targetRatio: 0.9
retain  = max(minTailTokens,                          # minTailTokens: 2048
              floor(contextWindow × retainRatio))      # retainRatio: 0.16
```

`/trim <budget>` (e.g. `/trim 32k`) replaces `budget` outright; `budgetCeiling` then takes
`min(budget, ceiling)` when the automatic path has to come in under a specific number.

### 2. What the planner compares

```
surfaceTokens  = Σ node.heuristicTokens                       # the token meter's price per surface node
envelopeTokens = measurement.totalTokens − measurement.surfaceTokens   # tool schemas and other fixed request data
totalTokens    = envelopeTokens + surfaceTokens
fits           ⇔ totalTokens ≤ budget
need           = totalTokens − budget
projectedTotal = totalTokens − freedTokens                    # after eliding a span
```

An elided span is replaced by one marker whose price is `markerTokens + markerSlackTokens`
(`markerSlackTokens: 64`), and the planner re-runs once when the marker's real numbers make it
more expensive than the provisional estimate. Leading nodes are protected by `protectHeadNodes`
(`1`), the newest human prompt is never elided, and tool-call/result pairs are only cut where the
pairing stays balanced (`allowTailTrim: true`).

### 3. The compaction trigger (what auto-tune and `/trim preset` write)

Mirrors `@deepseek-ai/dsh-compaction-basic`'s `resolveCompactSpec` as read from dsh 0.1.7-rc.2:

```
reservedCompletion = the routed request's maxTokens      # the output reserve, read from request/header
messageBudget      = contextWindow − reservedCompletion
pressureBudget     = messageBudget − headroomTokens      # dsh's stock headroomTokens: 65536
thresholdTokens    = floor(min(contextWindow × thresholdRatio, pressureBudget))
retainTokens       = retainTokens ?? floor(messageBudget × retainRatio)   # compaction's own retainRatio: 0.16
```

Two consequences, both of which the tuner exists to handle:

- `thresholdRatio` alone does not decide the trigger. The headroom term does whenever
  `headroomTokens > messageBudget − contextWindow × thresholdRatio`, so a 131072-token route with dsh's stock
  65536 compacts at **37.5 %**, not the configured 80 %.
- `headroomTokens` doubles as the default `maxTokens` for compaction's summarization call, so a generated
  preset states `maxTokens` explicitly.

The headroom that lets the ratio decide, and the gate it produces:

```
headroomForRatio = max(0, messageBudget − floor(contextWindow × thresholdRatio))
tunedGate        = floor(min(contextWindow × thresholdRatio, messageBudget − headroomForRatio))
                 = floor(contextWindow × thresholdRatio)        # whenever headroomForRatio > 0
```

A route whose `messageBudget ≤ 65536` has `pressureBudget ≤ 0`: dsh then has **no pressure trigger at all**,
and the tuner leaves it that way (that is what `tuneStockDisabledRoutes` / `DSH_TRIM_TUNE_STOCK_DISABLED` would
change, and it measured slower on one 40K task: 15 → 24 compactions).

### 4. The tool-result pruner threshold (derived by auto-tune since 0.3.5)

```
prunerThresholdChars = max(8192, min(32768, 2 × (contextWindow − maxTokens)))
```

i.e. one tool result may hold up to **half the route's message budget**, capped at 32 KB and floored at dsh's
stock 8192 so it can never clip more aggressively than stock does. With several routes the smallest value wins.
`'auto'` (the default) derives it, `0` leaves the pruner alone, a positive integer overrides it, and
`DSH_TRIM_PRUNER=auto|0|<n>` is the environment form. The plugin's own in-place slim (`preferInPlacePrune: true`)
delegates to dsh's pruner service, so this one value governs both paths; when that service is absent it uses
`pruneThresholdChars: 8192` with `pruneHeadChars: 4096` / `pruneTailChars: 1024` itself.

### 5. Worked examples

| Route | `W` | `maxTokens` | stock gate | tuned gate | pruner threshold |
|---|---:|---:|---:|---:|---:|
| Bonsai 2 (small) | 40,960 | 8,192 | none (pressureBudget −32,768) | none — left at stock | `max(8192, min(32768, 2×32768))` = **32,768** |
| Bonsai 2 (first tuned run) | 40,960 | 16,384 | none (pressureBudget −40,960) | none — left at stock | **32,768** |
| Our 128K route | 131,072 | 16,384 | `floor(min(104857, 49152))` = **49,152** (37.5 %) | **104,857** (80 %) | **32,768** |
| deepseek-official | 1,000,000 | 256,000 | `floor(min(800000, 678464))` = **678,464** (67.8 %) | **744,000** (74.4 %) | **32,768** |

### 6. Automatic trimming

`autoTrim: true` retries a failed request by shrinking its budget:
`nextCeiling = max(1, floor(failingTotal × (1 − autoTrimShrink)))` with `autoTrimShrink: 0.5` and at most
`maxAutoTrimRetries: 3` attempts before it gives up and reports what it measured.
