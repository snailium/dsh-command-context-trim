# Tuning compaction automatically in a fresh dsh environment

Goal: a test script, starting from a **brand-new** `DSH_HOME`, makes dsh compact at a chosen fraction
of the model window, and then runs automated sessions under that setting. No interaction, no preset
picker, no manual config edit.

Verified on dsh **0.1.7-rc.2**, headless profile, Linux, on 2026-09-26. Everything below is the route
that measurement supports; the sections at the end say what was **not** verified.

## 0. Why this is needed

dsh derives its compaction trigger like this:

```
reservedCompletion = routed request maxTokens
messageBudget      = contextWindow − reservedCompletion
pressureBudget     = messageBudget − headroomTokens        # headroomTokens defaults to 65536
thresholdTokens    = floor(min(contextWindow × thresholdRatio, pressureBudget))
```

`thresholdRatio` alone therefore does **not** decide the trigger: with the shipped `headroomTokens`
default, `min()` picks the headroom term on any window below roughly 370k, so a 131072-token route
compacts at **37.5 %** instead of the 80 % the ratio suggests. The fix is to set `headroomTokens: 0`
(so the ratio decides) and to state `maxTokens` explicitly (headroom would otherwise supply it).

## 1. Prerequisites

- a dsh installation you are allowed to run (the drill uses its own `DSH_HOME`, never `~/.dsh`);
- Node.js 22+ (the same Node that runs dsh is enough — the mock and the generator are Node-only);
- this repository checked out (the generator and the fixtures live in it);
- no network beyond `127.0.0.1` is required for the self-check.

## 2. Tell the script which capacity to tune against

The window and output reserve differ per backend (a card running 128k, another 40k, each with its own
`maxTokens`), so the generator resolves them from the best source available, in this order:

1. **a base inventory** — **`--routes <json>`** (an explicit list you supply), else **`--dump <file>`**: the
   composed profile from `dsh --profile <name> --patch … --dump-config > dump.yml`. Its `llm-pi-ai` row
   declares `contextWindow`/`maxTokens` per model (a model without its own numbers inherits the provider
   level), and `agent-default-model` names the route in use. The script only *parses* that file — it never
   spawns dsh, which keeps it usable and auditable anywhere;
2. **`--context-window <n>` / `--max-tokens <n>` / `--model provider:model` — an OVERRIDE.** The operator
   passing these knows the backend better than its declaration does: a card that serves 40k while the
   profile claims 128k, or a fresh instance whose profile declares no backend yet. The named route gets
   exactly those numbers (a route the base does not declare is added); with no `--model` the **active**
   route is the target, and if the base names no active route either, every known route takes them. Only
   the numbers you pass are replaced — a route keeps its declared reserve if you pass only a window;
3. **`--window-agnostic`** — deliberately tune the ratio alone, needing no window at all (see below).

**Nothing usable in any source is an error**, not a guess: a threshold that silently depends on an assumed
window is worse than no overlay.

```bash
# a) from a profile that already declares the backend
DSH_HOME=$DSH_HOME dsh --profile headless --patch /path/to/model-route.yml --dump-config > /tmp/dump.yml
node scripts/make-preset-patch.mjs --mode host --ratio 0.8 --dump /tmp/dump.yml --out /tmp/tuned.yml

# b) force the numbers this backend really serves (overrides the declaration)
node scripts/make-preset-patch.mjs --mode host --ratio 0.8 \
  --context-window 40960 --max-tokens 8192 --model lc:/models/q.gguf --out /tmp/tuned.yml

# c) multi-backend where every route's reserve is a small share of its window
node scripts/make-preset-patch.mjs --mode host --ratio 0.8 --window-agnostic --out /tmp/tuned.yml
```

That writes a **profile-plane row override** for the compaction entry:

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.8
    headroomTokens: 0
    maxTokens: 8192
```

`--ratio` is the fraction you want (0 < r ≤ 1). Where a route is known, the overlay also carries a
per-route policy whose headroom lets that ratio actually decide; the top level stays window-independent
(`headroomTokens: 0`, so `threshold = min(r·W, W − R)` on every route). `--summarizer-max-tokens` sets the
cap for the compaction call itself (default 8192) — it is a different number from a route's output reserve.

## 3. Run an automated session under it

```bash
export DSH_HOME=$(mktemp -d)          # a genuinely fresh environment
dsh --profile headless --patch /tmp/tuned.yml --patch /path/to/model-route.yml "do the task"
```

`--patch` is a launcher flag (before the app arguments) and may be repeated; the later overlay wins.
The model route can come from your profile's own configuration instead of an overlay — the tuning
overlay is orthogonal to it.

## 4. Assert it, in the test script

```bash
# (a) composition: the row really carries the tuning
DSH_HOME="$DSH_HOME" dsh --profile headless --patch /tmp/tuned.yml --dump-config \
  | grep -A6 '^- id: compaction-basic' | grep -q 'thresholdRatio: 0.8' || exit 1

# (b) behaviour: a session completes
DSH_HOME="$DSH_HOME" dsh --profile headless --patch /tmp/tuned.yml --patch route.yml "say ok" || exit 1
```

(a) is the assertion that the tuning reached the plane the headless app actually composes; (b) proves
the whole stack still boots and answers.

Session logs live under `$DSH_HOME/sessions/<cwd-slug>/session-*/session.v4.jsonl.zstd` (zstd-compressed).
Useful assertions from a log: `request/header` carries the request's tool surface and provider/model
config, `request/context` the resolved context window.

**Do not assert on**: the New Session preset label (it reflects a client/host *draft*, not the default —
a fresh browser context still showed a previously picked name after the default was changed), or an
`agent-preset/selected` event (it is appended by an explicit `select()`; a session created with the
default carries no such event).

## 5. One-command drill (self-check in this repository)

```bash
fixtures/headless-tuned-preset/run-headless-check.sh --dsh /path/to/dsh [--ratio 0.8] [--node node]
```

It creates a fresh temporary `DSH_HOME`, starts the bundled Node mock model on `127.0.0.1`, generates
the overlay, asserts the composed `compaction-basic` config, runs one headless session and reports:

```
dsh home: /tmp/tmpXXXXXXXX
session output: ok
OK: compaction tuned on the profile plane and a headless session ran under it
```

No python3 and no iproute2 are needed.

## 6. Optional: per-route policies

`routes.json` is `[{ "provider": …, "model": …, "contextWindow": …, "maxTokens": … }]`. Per-route
policies exist for routes whose output reserve would otherwise cap the trigger. Example: a 131072-token
route with `maxTokens 16384` cannot reach 80 % without a headroom that lets the ratio decide
(`headroom = (W − R) − floor(W × r) = 9831`), so the overlay emits
`{ provider, model, thresholdRatio: 0.8, headroomTokens: 9831 }` for it. Routes whose reserve makes the
target unreachable are reported on stderr as capped instead of being written silently.

## 6d. The pruner threshold, and where this route differs from web

Auto-tuning writes the compaction trigger **and** the tool-result pruner's clip threshold. The pruner value is derived
per route — `max(8192, min(32768, 2 × (contextWindow − maxTokens)))`, smallest routed window wins — and
`prunerThresholdChars` defaults to `auto`; an integer overrides it and `0` opts out. This is the lever that matters on
a small window, where dsh's stock `8192` clips a whole-file read.

This document is about the **headless / tui** route, where the host plane owns the agents and the automatic paths
fire. A **web** profile is different: session agents are created inside preset realms, their lifecycle events never
reach the host plane, and the plugin cannot retune a running session — so web uses the manual workflow
(`/trim preset inplace`, `/trim preset check` for staleness and uncovered small routes, then a fork or a new session).
See the README's *Which route to use* and the `dsh-compaction-config` skill.

## 7. Why not a preset (the route that does *not* work here)

`agent-preset-registry` and the shipped `preset-*` rows are inserted by `dsh-web-app`, and only the
session API, the web client and the `agent-preset` row ever resolve a session preset. A **headless**
run composes the same agent with or without one. Measured in a single clean `DSH_HOME`, first request:

| run | overlay | tools |
|---|---|---|
| baseline | none | 24 (incl. `web_fetch`, `web_search`) |
| with preset | generated preset row + `agent-preset-registry.selectedDefault` | 24, identical |
| control | same preset, its `tool-web` row deleted | 24, identical |

Identical surfaces prove the preset rows sat in the tree unused. The `--mode preset` output of the same
generator (preset row + registry `default`/`selectedDefault`) is still the right shape for a **web**
profile, where the picker and the session API do consume presets — the earlier live check showed a
generated preset appearing in the picker and being selectable. It is simply not how a headless session
gets its compaction settings.

## 6b. Which numbers matter, and which do not

`threshold = min(r·W, W − R)` with a zero headroom. So a route whose output reserve is at most `(1−r)·W`
reaches exactly the ratio and needs no per-route entry at all — most local backends (reserves around
10–20 % of the window) are in that group. Only a fat reserve caps it: 81920/65536 reaches 20 % at `r=0.8`,
and 1M/384k reaches 61.6 %. Those are the routes `--routes`/`--dump` exist for; the per-route headroom
they emit is `(W − R) − floor(r·W)`.

## 6c. Retuning a long-lived process at runtime

A one-shot `dsh headless "task"` boots, answers and exits, so the boot overlay already covers every
session (that is why this document's main route needs nothing else). A **long-lived** process is the case
where a runtime change matters, and there it works like this:

- `Fiber.update()` — what the configuration editor calls when it writes a row — resolves the new config
  and calls `restart()` on a loaded fiber (dispose + fresh apply). This is generic to every plugin entry.
- So with the plugin installed, `/trim tune` reads the routes through `ctx.llm.resolveModelInfo` (adapter
  truth, not the declaration), computes the same tuning the overlay carries, and writes it onto the
  `compaction-basic` row. The next request uses it.
- `autoTuneCompaction: true` does the same thing once per process, the first time the agent goes idle —
  deliberately idle, because a restarted row cancels work in progress.
- In a **web** profile this is refused with an explanation: compaction there lives inside each session's
  agent-preset isolate realm, so a host-plane write cannot reach a running session, and a session's preset
  is locked once it starts.

### A live check that the runtime write really lands

```bash
# the plugin has to be in the profile as a bundle, so its row is composed
npm --prefix "$DSH_HOME/profiles/headless" install /path/to/dsh-command-context-trim
cat > /tmp/tune-on.yml <<'YAML'
- id: context-trim
  name: dsh-command-context-trim
  config: { autoTuneCompaction: true, compactionTargetRatio: 0.8 }
YAML
DSH_HOME=$DSH_HOME dsh --profile headless --patch /tmp/tune-on.yml \
  "Use the bash tool to run: echo hi. Then reply with the single word done."
grep -A10 '^- id: compaction-basic' "$DSH_HOME/profiles/headless/cordis.patch.yml"
```

Observed on 0.1.7-rc.2 in a fresh home with a mock backend declaring 65536/4096: the session answered, the
plugin activated, and the profile patch gained the row below **while the session was running** — the plugin
asked the adapter for the route, computed the per-route headroom (`(W − R) − floor(r·W) = 61440 − 52428`),
and persisted it:

```yaml
- id: compaction-basic
  config:
    thresholdRatio: 0.8
    headroomTokens: 0
    maxTokens: 8192
    modelPolicies:
      - { provider: mock, model: mock-model, thresholdRatio: 0.8, headroomTokens: 9012 }
```

Still not verified live: the *timing* consequence — a real overflow in a long conversation firing at the new
fraction after such a write. The mechanism is source-verified (a config write restarts the fiber) and the
write path is the one the settings cards use.

## 7b. If you also want the plugin's own trimming in those sessions

The overlay above only sets compaction's thresholds. To get this plugin's `/trim` command and its
automatic overflow trimming inside the same sessions, install the bundle into that profile as well:

```bash
dsh plugin --profile headless add /absolute/path/to/dsh-command-context-trim
DSH_HOME="$DSH_HOME" dsh --profile headless --dump-config | grep -A2 '^- id: context-trim'
```

The two are independent: the plugin trims context without any model call, while the overlay decides when
compaction (prune + summarize) fires. Verify the row appears in the composed tree before relying on it.

## 8. Failure signatures seen while building this

| symptom | cause | fix |
|---|---|---|
| `MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"` | the profile's default route is not configured in this fresh home | pass a route overlay/`settings.yaml`, or point `agent-default-model` at your backend |
| `no route capacity to tune against …` (exit 2) | no source could produce a window: the profile declares no model numbers and no override was given | pass `--dump`, `--context-window` (+ `--max-tokens`, `--model`), or `--window-agnostic` |
| `… is not declared by the base, so --max-tokens alone cannot describe it` | an override named a route the base does not know, with no window for it | pass `--context-window` too |
| `TRANSPORT: Stream ended without finish_reason` | the model endpoint answered without an SSE stream | make the endpoint stream (`data:` chunks + `finish_reason` + `[DONE]`) — the bundled mock does |
| a `settings.yaml` section appears to be ignored | on 0.1.7 a section the composed profile rejects is skipped and the file is renamed | use a `--patch` overlay, which always applies |
| `node --test` hangs | `node --test` executes every JavaScript file under `test/` | keep servers/fixtures outside `test/` (this repository's mock lives in `fixtures/`) |

## 9. Verification status

Verified here: dsh 0.1.7-rc.2, `headless` profile, fresh `DSH_HOME`, the mock route, the composition
assertion and a completing session; plus `112` unit tests over the generator and the YAML surgery.

Not verified: other profiles (`web`, `tui`) under this overlay — for `web` the profile composes its own
preset plane, so prefer `--mode preset` there and confirm with `--dump-config`; other dsh versions
(the generator writes plain config, so it should travel, but the row id `compaction-basic` is what it
targets); and behavioural proof that a real overflow now triggers at exactly the configured fraction —
that needs a backend that can enforce a smaller window than it advertises (this repository's
`fixtures/mock-overflow-server.mjs` exists for that).
