# Running automated (headless) sessions under a tuned compaction threshold

This fixture is the answer to "let a clean, automated instance compact at the tuned threshold".
It exists because two planes in dsh 0.1.7 look interchangeable and are not.

## What was verified, and why the obvious route does not work

A **headless** profile (`dsh-base` + `dsh-headless`) composes compaction itself: its tree carries
`compaction-basic`, `command-compact` and `tool-result-pruner` on the **profile plane**. It never
resolves a session **preset** — only `dsh-agent-preset`, the session-API controller and the web client
do. Measured, in one clean `DSH_HOME`:

| run | overlay | tools in the first request |
|---|---|---|
| baseline | none | 24 (incl. `web_fetch`, `web_search`) |
| with a generated preset + `selectedDefault` | preset row + registry row | **24, identical** |
| control: same preset with its `tool-web` row deleted | as above | **24, identical** |

Identical tool surfaces prove the preset rows sat in the tree unused: a headless run composes the same
agent with or without them. So "create a preset, set it as default, let later sessions use it" is a
*web / session-API* route, not a headless one.

## The route that works for headless

Write the tuning onto the profile's own compaction row instead:

```bash
# 1. mock model route (this fixture; replace with your real route in other setups)
sed 's/8901/<mock-port>/' provider.patch.yml > /tmp/provider.yml

# 2. the tuned config, as a profile-plane row override
node scripts/make-preset-patch.mjs --mode host --ratio 0.75 \\
  --routes fixtures/headless-tuned-preset/routes.json --route mock:mock-model \\
  --out /tmp/host.yml

# 3. a clean home, then any number of automated sessions
export DSH_HOME=$(mktemp -d)
DSH_HOME=$DSH_HOME dsh --profile headless --patch /tmp/provider.yml --patch /tmp/host.yml "do the task"
```

`run-headless-check.sh` performs exactly this drill and asserts it:

```bash
fixtures/headless-tuned-preset/run-headless-check.sh --dsh <path-to-dsh> [--home <dir>] [--mock-port 8902]
```

What it asserts, and what it deliberately does **not**:

- **asserted** — `dsh --profile headless --patch … --dump-config` shows the tuned config on the
  `compaction-basic` row (threshold, headroom, per-route policies), and a real session against the mock
  model exits 0;
- **not asserted** — anything about the New Session picker label. That label reflects a client/host
  *draft*, not the default: after setting `selectedDefault` to a preset that was never chosen, a fresh
  browser context still showed the previously picked name.
- **not available** — `agent-preset/selected` in the session log. It is appended by an explicit
  `select()`; a session created with the default carries no such event, which is why the fixture checks
  the composition and the run instead.

## Route inventory

`routes.json` is `[{provider, model, contextWindow, maxTokens}]` — the same shape `/trim preset` reads
from the live profile. Three other sources exist: `--dump <file>` (a `dsh --dump-config` output, parsed for its `llm-pi-ai`
provider table and `agent-default-model`), `--context-window`/`--max-tokens`/`--model` as an **override**
(the named route — or the active one — takes exactly those numbers, and only those numbers are replaced),
and `--window-agnostic` to tune the ratio alone. With none of them the generator **errors**
rather than assuming a window. `--summarizer-max-tokens` is the compaction call's own cap, which is a
different number from a route's output reserve.
