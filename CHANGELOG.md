# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.6] - 2026-10-02

### Changed

- **Uniform compaction auto-tuning across all context window sizes.** Removed the special-case `tuneStockDisabledRoutes` configuration, UI toggle, and `DSH_TRIM_TUNE_STOCK_DISABLED` environment variable. Low-context routes (e.g. 40K/48K windows where the message budget is under the stock 40,960 headroom) now automatically compute dynamic `headroomTokens` based on the target ratio instead of being bypassed by default.
- **Client settings card streamlined.** Removed the obsolete stock-disabled switch from the `context-tuning` settings card, leaving clean controls for compaction ratio, compaction route, runtime auto-tuning, and tool-result pruner threshold.

## [0.6.5] - 2026-10-01

### Added

- **Multi-component row titles and descriptions on Plugins page.** Exported `./tune` subpath entry and dedicated locale files (`locale/en.json`, `locale/zh.json`, `locale/tune/en.json`, `locale/tune/zh.json`) so that both `context-trim` and `context-tuning` display distinct human-readable titles and descriptions in English and Chinese.

### Changed

- **Modularized client bundle (`lib/client.js`) into `src/client/`.** Decomposed the monolithic browser bundle into structured modules under `src/client/` (`constants.js`, `locales.js`, `helpers.js`, `form.js`, `components.js`, `lifecycle.js`), assembled via `scripts/build-client.js`. Verified by `test/client-bundle.test.js` to stay byte-identical.
- **Partitioned `lib/preset-tune.js` by extracting `rescuePreset` into `lib/preset-rescue.js`.** Aligned with the standalone architecture of `lib/preset-reset.js`. `rescuePreset` remains re-exported from `lib/preset-tune.js` for backwards compatibility.
- **Scoped `SYNCED_PRESETS` in `lib/tune-runtime.js` via `WeakMap`.** Isolated preset sync tracking per Cordis context instance rather than process-global state, preventing cross-profile state leakage.
- **Consolidated `describeError` helper into `lib/render.js`.** Removed duplicate error formatting logic across `lib/target.js` and `lib/tune-runtime.js`.
- **Dynamic volatile toggle for `autoTrim`.** `registerAutoTrim` attaches the overflow listener unconditionally and dynamically re-checks `config().autoTrim` on each trigger, enabling immediate GUI switch toggling.
- **Cleaned duplicate keys in `Config` schema.** Consolidated redundant property definitions in `lib/index.js` object literal.

## [0.6.4] - 2026-09-29

### Documentation

- **Stated which plugin version belongs on which dsh line.** There is no peer dependency to enforce it, so it was
  only discoverable by trying: dsh 0.1.5 can only run this plugin's 0.1.x line, and from 0.2.0 the latest build
  serves both 0.1.7 and 0.2.0. The 0.1.5 boundary is worth stating loudly because its failure is the quiet kind —
  the plugin still loads and `/trim` still works, but the card silently never appears, since 0.1.5 predates both
  `configForms` and schemastery's `.volatile()`. The 0.2.0 floor is separate and older: that line refuses a card
  write from any build before 0.5.0, because it validates the operation against the schema where 0.1.7's
  `.volatile()` had let the string `"true"` through.
- `0.2.0-rc.2` added to the manifest's declared dsh releases, now that the card write path is verified on it.

### Internal

- `publish.yml` gained a `deprecate` input: comma-separated versions to mark deprecated instead of publishing, with
  each version's reason held in the workflow so the text is reviewed in a diff rather than typed into a web form, and
  an unknown version failing the run rather than quietly marking nothing. Used to mark 0.6.0-0.6.2.


## [0.6.3] - 2026-09-29

### Changed

- **Renamed, as one family: the row `context-trim-tuning` is now `context-tuning`, and `/trim-tune` is now
  `/context-tune`.** The old row name invited exactly the wrong reading — it had nothing to do with trimming, deciding
  when compaction fires and how hard the tool-result pruner clips — and a name that says "tuning" inside a plugin
  about trimming suggests the knobs configure `/trim`, which none of them do. `/trim` keeps its own short name: it
  predates the split, and it is the whole reason somebody reaches for the other one.

  `scripts/migrate-rows.mjs` follows the new name, and a profile whose patch still names the old row needs the row id
  rewritten — the host skips a patch row that names an entry it cannot find, so the tuner's values would otherwise go
  inert **with only a warning**. Pinned by a test so neither name can drift back.

- The `role` VALUE stays `tuning`. It is an internal dispatch flag rather than a name, deployed profiles already set
  it, and the schema accepts nothing else — renaming it would break a boot and buy no clarity.


## [0.6.2] - 2026-09-29

### Added

- **Two settings cards, one per row, each showing only its own knobs.** `plugins.row.config` is a keyed slot: a
  registration only renders on the row whose key matches, so one card left the other row with no Configure button and
  nothing logged. Each row now has its own keyed entry, gated on its own namespace, and each card carries only that
  row's fields — verified in an isolated 0.2.0 instance, where the `context-trim` card shows 13 controls and none of
  the tuner's, and the `context-trim-tuning` card the reverse.
- **The trims have settings of their own for the first time.** Their thirteen knobs (`targetRatio`, `retainRatio`,
  `minTailTokens`, `reserveOutputTokens`, `protectHeadNodes`, `maxAutoTrimRetries`, `allowTailTrim`, `autoTrim`,
  `emergencyTrim`, `preferInPlacePrune`, `pruneThresholdChars`, `pruneHeadChars`, `pruneTailChars`) are now marked
  `.volatile()`, which is the only thing that puts a field on a card. Until now they were unreachable from the UI while
  the one card that existed showed the tuner's five fields under a row named `/trim` — so the visible settings belonged
  to a different component than the row's name suggested.

### Changed

- Each card's controls are namespaced by row (`plugin-config-trim-…`, `plugin-config-tune-…`), and each card opens with
  a line naming the component it configures. That is what distinguishes the two cards in the UI, because the ROW
  HEADINGS cannot be distinguished: a row's heading comes from its module, a bundle mounts one patch and has one module
  name, and dsh resolves a row's `meta` by module name too — so neither a second patch file nor a per-row `meta.title`
  separates them. (Both were tried and measured; `cordis.tune.yml` is kept as the row's documentation, declaring no
  row, because a second patch file is never read.)
- The switches carry an `id` on their wrapper. The shell's `Switch` takes none, so a boolean control previously had
  nothing in the DOM to point at.


## [0.6.1] - 2026-09-29

### Added

- **`/trim-tune` — the compaction-tuning surface, on its own command.** `preset`, `tune` and `rescue` moved off
  `/trim` onto `/trim-tune`, which is registered by the `context-trim-tuning` row, so switching that row off removes
  the whole command rather than leaving it in place with different defaults. `/trim` now answers the moved spelling
  with the new name (`"/trim preset" moved to /trim-tune`) instead of a usage dump, because the old spelling is what
  people type. A bare `/trim-tune` lists its own usage.
- **`/trim-tune reset` — undo the presets this plugin wrote.** It removes our marker blocks from the profile patch,
  which restores the base preset's own definition for both shapes tuning produces (an `inplace` override, which
  shadows the base row, and a generated `-tuned` preset, which only ever added an id). The marker is what makes this
  exact: the set of rows we wrote is knowable without matching a description string, so a preset someone tuned by
  hand is never caught. Blocks belonging to other tools are reported and left alone. `reset check` reports without
  writing; the real run backs the patch up to `.bak-trim-reset` first, and both forms say that sessions which
  already started keep the preset they locked in, since dsh refuses a preset switch after the first turn
  (`agent-preset/locked`).

### Changed

- The `/trim-tune` command description states the consequence a reader cannot guess: switching the tuning row off
  does **not** reset presets that were already tuned, and they keep the values they were given until
  `/trim-tune reset`.


## [0.6.0] - 2026-09-29

### Added

- **The plugin is now two rows, so its halves can be switched and tuned independently.** One bundle can declare more
  than one row, and a row is a loader entry with its own config namespace and its own fiber. `context-trim` owns the
  trims (`/trim`, and the automatic trim when a request hits the model's context wall); the new `context-trim-tuning`
  owns when compaction fires and how hard the tool-result pruner clips. Each has its own switch on the Plugins page, and
  switching one off leaves the other running — verified on isolated instances of 0.2.0 and 0.1.7, where turning
  `context-trim-tuning` off left `context-trim` and `/trim` untouched.

  An entry is **not** told its own row id — `ctx.fiber.name` is the module name for both rows — so the half is declared
  in config as `role: trim | tuning`, defaulting to `trim`, which is exactly what a single-row install was.

### Fixed

- Two rows from one module no longer collide on the `/trim` command. The tuning half owns no command, so switching it
  off does not make `/trim` disappear.
- The split is **additive**: a profile that predates it keeps every compaction knob on its `context-trim` row and loses
  nothing. The tuning row publishes only the keys a deployment **explicitly sets**, and the shipped bundle patch sets
  nothing there but `role` — its documented knobs are comments. Merging the tuning row's *defaults* over a pre-split
  trim row would have silently turned a working `autoTuneCompaction: true` back off. The knob values themselves stay in
  `lib/config.js` (`DEFAULTS`), which is where they were already decided.

### Notes

- The knobs `/trim` actually obeys (retainRatio, protectHeadNodes, emergencyTrim, maxAutoTrimRetries, allowTailTrim,
  preferInPlacePrune) still have no settings card: they are not marked `.volatile()`. The tuning half's five do, which
  is why the card so far has shown only compaction tuning under a `/trim` row. Exposing the trims' own knobs is the
  natural follow-up now that it is a row of its own.

## [0.5.1] - 2026-09-29

### Fixed

- Removed three dead imports from the client half (`SettingsFormModel`, `settingsNumberField`, `settingsTextField`).
  0.5.0 stopped using them but left them in the destructuring, so the published file still pulled names it never
  called. No behaviour change; pinned by a test so the import list stays exactly the three presentational halves.

## [0.5.0] - 2026-09-29

### Fixed

- **The settings card could not save on dsh 0.2.0.** The card staged every field as **text** and let the primitives'
  `SettingsFormModel` parse it on save. That works for strings and numbers, and it is what 0.1.7 accepted for booleans
  too, because a `.volatile()` field relaxed the type check and the string `"true"` landed where a `z.boolean()` was
  declared. 0.2.0 validates the operation against the schema, so a string is not a boolean and the write is refused in
  band: no HTTP error, no console output, the draft kept, and the frame's "The deployment rejected these values".
  Measured both ways on an isolated 0.2.0: changing the numeric trigger saved and landed in the profile patch, while
  flipping a boolean switch was refused.

  The card no longer stages text for a typed field. It declares each field with the type it must be written as
  (`compactionTargetRatio` number, `autoTuneCompaction` and `tuneStockDisabledRoutes` booleans, `prunerThresholdChars`
  `'auto'` or a number, `compactionRoute` text), keeps its own draft over `configForms.get('context-trim')`, and issues
  one revision-fenced `scope.mutate` with correctly typed values — the pattern the in-box cards use. The frame and the
  text controls are still the shell's `SettingsForm` and `SettingsValueField`, which only read
  `{text, overridden, invalid}` and callbacks. A **Reset** now drops the field's edit rather than sending an `unset`
  operation, so a field whose schema has no default can never be cleared away.

  Verified in isolated instances of both versions: on 0.2.0 the boolean lands as a real `true` in the profile patch,
  and on 0.1.7 the same interaction still lands. 154 tests, including one that pins the operations so a regression back
  to string-typed booleans fails there rather than in a browser.

## [0.4.9] - 2026-09-28

### Fixed

- **The settings card was registered into the wrong slot.** It registered into `plugins.item`, which the slot
  contract reserves for the **official** settings pages ("OCCUPIED by the official settings pages, one companion
  package per host-plane namespace; a bundle's configuration belongs in `plugins.bundle.config` or
  `plugins.row.config`"). A third-party bundle's card parked there still renders — which is why this went unnoticed —
  but it appears under **Official**, mislabelled as a built-in plugin, instead of on its own bundle page. It now
  registers into **`plugins.row.config`**, keyed `dsh-command-context-trim#context-trim`, which is the slot the page
  hands a form to and the one whose presence gives the row its **Configure** button. Verified in an isolated 0.2.0
  instance: the card is gone from the Official list, the bundle page's row shows `Configure dsh-command-context-trim`,
  and the form renders in the row view. The keyed `key` is pinned in the test suite, because a wrong key fails
  silently (no error, no log — just a missing button).

### Known (0.2.0 only)

- **Save is still refused on 0.2.0, and the reason is now known.** The row slot hands the component
  `form = { state: snapshot, mutate }` — a **snapshot and a fenced write**, not a scope: it has no `subscribe()` and no
  `getSnapshot()`, so it cannot back a `SettingsFormModel`. The card keeps the model path it drives from
  `configForms.get('context-trim')`, which renders and saves correctly on 0.1.7; making 0.2.0 save means adopting the
  hand-rolled write path the slot contract implies (stage edits locally, then one `form.mutate(ops, revision)`), which
  the primitives' `SettingsForm`/`SettingsValueField` can still render. Until that lands, configure this plugin through
  its profile patch row on 0.2.0 — which is what the web workflow does anyway (`/trim preset inplace`).

## [0.4.8] - 2026-09-28

### Fixed (documentation)

- **"Fork is how an existing conversation gets the tuning" was wrong, and so was the reason given for it.** The
  earlier text said the session header's projection does not change, therefore an existing session cannot pick up an
  edited preset. Both halves are wrong. The preset id lives in the session's `agentPreset` **projection** (folded from
  events — `presetForObservation` reads `observation.projections.values.agentPreset`), not in the header; and the
  definition behind that id is **re-resolved on every adopt**: `createOrAdopt` and `resumeObserved` both call
  `composeAgent(presetForObservation(observation))` before `agents.resume({ setup })`, and `retain(id)` returns the
  generation the *current* definition activated. Measured consequence: a session that was idle while the preset was
  edited picks the tuning up by simply being **resumed** — no fork, no new session id.

  What the projection fact *does* explain is the binding: a **live** agent holds the generation it composed, so that
  realm stays alive and an edit cannot reach it. Fork remains the tool for exactly that case. README (both languages)
  and the `dsh-compaction-config` / `dsh-session-records` skills are corrected accordingly, with the line references.

## [0.4.7] - 2026-09-28

### Added

- **The settings card was rebuilt: two sections, real switches, a mode select, and effective values.** Previously it
  rendered five text fields, three of which were blank no matter what the deployment held — the projection exposed
  only two of them, so `state.autoTuneCompaction` and friends were `undefined`. It is now grouped into **Compaction**
  and **Prune**; `Auto tune compaction at runtime` and `Enable stock-disabled routes` are the shell's own `Switch`
  (found in the official subagent card after wrongly concluding the primitives shipped none); and the pruner threshold
  is a mode select (`Disabled` → `0`, `Auto` → `auto`) plus a number box that appears only for `Custom`, whose value
  is what reaches the setting. `Auto tune compaction at runtime` states the caveat in bold: **headless profile only —
  a web profile must use the `/trim preset` command.**

  Effective values come from the scope snapshot's configuration, not from the per-field entries: those are
  `{text, overridden, invalid}`, and a boolean's `text` is *always* empty, which is why a deployment with
  `autoTuneCompaction: true` rendered as an empty (then false) switch until this was measured with a probe. Unset
  fields now show the plugin's real defaults, from a mirror that a test checks against `lib/config.js`.

### Verified

- Rendered and driven in an isolated 0.1.7 instance: both switches (`true` for the patched `autoTuneCompaction`),
  the select's three options with `auto` selected, the number box hidden for `Auto`, both section headings, and the
  bold caveat all present in the DOM.

## [0.4.6] - 2026-09-28

### Added

- **`README.zh.md` is a maintained translation again, and a test keeps it one.** The file had drifted to 0.3.8 while
  the plugin reached 0.4.5 — no `inplace`, no `rescue`, no coverage report, no fork guidance, the old pruner default —
  which is worse than no translation, because it looks complete. It is now rewritten against the 0.4.5 English README
  with the same 18-section structure, the same commands, keys, defaults, formulas and verification facts (long English
  passages are condensed, nothing that a reader would act on is dropped), and it carries a
  `synced-with-readme: <version>` marker.

  `test/docs-sync.test.js` enforces the parts that must not drift: identical section counts, every command/flag/key/env
  var present on both sides, the marker's version matching `package.json`, and the derived pruner default (with an
  explicit guard against the old `0` opt-out reappearing as the documented default — the exact mistake this audit
  found).

## [0.4.5] - 2026-09-28

### Fixed (documentation)

- **The configuration table still gave `prunerThresholdChars` as `0`.** That was 0.3.2's value and it is an explicit
  opt-out, so the table taught the exact setting that disabled the derivation 0.3.5 introduced — the same stale value
  that a live isolated instance exposed in our own bundle. The row now says `auto`, with the formula
  (`max(8192, min(32768, 2 × (contextWindow − maxTokens)))`, smallest routed window wins), the integer override and the
  `0` opt-out.
- **The `/trim preset` command list was missing `inplace` and `default`**, and had no example of what `check` prints.
  It now lists every form and shows the coverage report, including the *uncovered route at or below 64K* warning, next
  to the sentence that makes it useful: re-run `inplace` when `check` reports a gap. `/trim rescue` is listed too.
- **The verification table said 103 tests and stopped at 0.1.7.** It now says 149 and carries the 0.3.9-0.4.4
  evidence: `inplace` and `rescue` verified in an isolated instance, the derived pruner threshold landing in the
  written row, the measured fact that a web profile logs the boot refusal and nothing per session, and the Bonsai 2
  headless before/after (`thresholdChars: 32768`, `compaction/prune` 17 -> 2).
- **`docs/headless-compaction-tuning.md`** gained the pruner-threshold section and the cross-reference to the web
  manual workflow, and **`README.zh.md`** was replaced by a short, honest page: the English README is canonical, and
  the stale full translation (last in step with 0.3.8) is gone rather than looking complete.

## [0.4.4] - 2026-09-28

### Documented

- **The scope of the automatic paths, measured instead of assumed.** Two isolated instances and the production
  service agree: a web profile logs the boot-time `compaction is not reachable from this plane` refusal and then
  *nothing* — no per-session retune line, no preset-sync line — because the session agents are created inside each
  session's preset realm and their lifecycle events never reach the host plane where this plugin lives. The automatic
  retune and the definition sync therefore apply to profiles whose host plane owns the agents (headless, TUI); for web
  the workflow is `/trim preset inplace` plus `/trim preset check` (staleness and uncovered small routes) and a fork or
  a new session to apply it. This is a documentation correction, not a behaviour change: the code stays, because it is
  right where it can run.

## [0.4.3] - 2026-09-28

### Fixed

- **A skipped sync says why, at least once.** 0.4.2 made failures visible, but a skip (no preset registry reachable
  from this plane, or an id already synced in this process) still only reached the debug log — so a live web instance
  showed nothing at all about the auto-sync, which is indistinguishable from the bug 0.4.2 fixed. The first skip of a
  process now goes to stderr too, the rest stay at info level, and a test asserts the exact line.

## [0.4.2] - 2026-09-28

### Fixed

- **A throw from the preset registry made the auto-sync a silent no-op.** The composer lookup
  (`registry.composedPreset(agent.ctx)`) sat *outside* the guarded region, so a throw rejected the handler's promise and
  nothing was logged at all — which is exactly how "my new model is still untuned and nothing says why" looks. The
  whole sync is now guarded, and its outcome is reported: `preset "<id>" updated` on success, and
  `auto preset sync failed: <reason>` with the reason preserved (the error text's last line, matching the convention
  the auto-retune line already uses). Normal skips — no registry in this profile, or an id already synced in this
  process — stay quiet.

## [0.4.1] - 2026-09-28

### Added

- **The preset definition is kept in sync.** A web profile keeps compaction inside each session's preset realm, so no
  host-plane write reaches a running session — but the *definition* can be kept current, which is what makes the next
  fork, new session, or restart already tuned after a model is added to the profile. With `autoTuneCompaction` on, the
  plugin entry registers one `agent/created` listener that syncs the session's preset id at most once per process
  (never blocking a turn, never throwing). It is a separate trigger from the auto-retune path on purpose: that path
  reports one line per distinct failure and a file write does not belong in its middle.
- **`/trim preset check` reports route coverage.** It counts the configured routes the current preset covers, and
  warns explicitly about any **uncovered route at or below a 64K message budget** — the one case where inheriting the
  tuned top level is wrong, because it *enables* the pressure trigger (measured at 15 -> 24 compactions). Large
  uncovered routes are fine: they inherit the tuned ratio-first shape.

### Fixed

- **`persistBlock` no longer rewrites an identical block.** The sync re-runs on every boot, and a byte-identical
  write churned the profile patch and its backup for nothing.

## [0.4.0] - 2026-09-28

### Added

- **`/trim rescue <id> [--from <donor>] [--untuned]`.** A session whose preset id no longer resolves can be neither
  resumed nor forked (`resolve()` has no fallback), and it can never be re-pointed at another id — the preset is
  locked and `assertPresetUnchanged` refuses a different one. The only repair is to make the id resolvable again,
  and that is also the moment to decide what it is: this command clones a donor preset (default `standard`) into an
  override row for the missing id, tuned like `/trim preset inplace` unless `--untuned` is passed. It refuses an id
  that still exists, names the available donors when `--from` is wrong, and states the one thing a clone cannot
  restore — the donor's plugin list replaces the lost one, so future turns get the donor composition even though the
  history is unaffected.

## [0.3.12] - 2026-09-28

### Documented

- **How an already-started conversation gets new tuning: fork it.** A running session is bound to the preset realm
  it composed at its first turn, so editing the preset does not reach it; a fork composes a fresh realm from the
  preset's current definition while carrying the parent's history (`/trim preset inplace` → restart → fork). Recorded
  with the mechanism (`retain()` returns the generation the current definition activated) and the boundaries (new
  session id, the fork is locked too, it needs a completed turn in the parent). This is why `/trim apply` — a live
  `recompose()` past the lock — stays unimplemented: the fork does the same job with documented behaviour.

## [0.3.11] - 2026-09-28

### Fixed

- **A tuning suffix already present in the registry's name is normalized away.** 0.3.10 stopped *stacking* the
  suffix but the name still came from the registry, which — after one 0.3.9 run — reported
  `standard (tuned 80%) (tuned 80%)` as the base name, so the junk survived every later run. The next run now
  strips a trailing `(tuned N%)` before composing the name, which cleans up rows written by the broken versions.

## [0.3.10] - 2026-09-28

### Fixed

- **Our own bundle patch pinned `prunerThresholdChars: 0`.** That value is an explicit opt-out, so from 0.3.5 —
  when the threshold became derivable — every install of our own bundle kept the pruner at dsh's stock 8192 while
  the code and the README said `auto` was the default. Found live in an isolated web instance: the row the command
  had just written still carried `thresholdChars: 8192`. The bundle now says `auto`, and a regression test reads the
  shipped patch and refuses the old value.
- **A generated preset's name no longer stacks its suffix.** The display name was read back from the document being
  edited, which in `inplace` mode is our own previous row — so a second run produced
  `standard (tuned 80%) (tuned 80%)`. The name now comes from the registry's metadata, and `inplace` keeps the
  original name (the user picks the same preset as before, so renaming it is noise); the tuning details stay in the
  description.

## [0.3.9] - 2026-09-28

### Added

- **`/trim preset inplace` overrides the base preset instead of declaring a new one.** It writes
  `- id: preset-<base>` with a complete `config:` (the same shape the Web editor persists), so new sessions keep
  using the existing preset id and pick the tuning up without anyone choosing anything — and the same row is the
  repair for a session whose custom preset vanished in a dsh upgrade, because recreating the id is what makes that
  session loadable again. Patch layers replace a row's `config:` wholesale, so the block carries every key; the
  shipped preset's plugin list is shadowed until the row is removed, which the report says out loud.

  Why it matters: a web profile keeps compaction and the pruner inside each session's preset, the preset is locked
  once a session starts, and `resolve()` has no fallback — so a lost preset id makes a session unresumable, and a
  new id means a picker interaction every time. Overriding in place addresses all three at once.

## [0.3.8] - 2026-09-28

### Fixed

- **`/trim preset` now also writes the preset's pruner threshold.** It cloned the preset and spliced only
  `compaction-basic`, so a preset generated for a web profile kept `tool-result-pruner.thresholdChars` at dsh's
  stock 8192 — and in a web profile that row is the *only* place the pruner can be configured, because the
  host-plane copy is `disabled: true`. A generated preset therefore still clipped every whole-file read, which is
  exactly what a small-window route needs to keep. The command now splices both rows from the same derivation
  auto-tune uses (`max(8192, min(32768, 2 × (contextWindow − maxTokens)))`, smallest routed window wins), honours
  `prunerThresholdChars: 0` as an opt-out, reports a preset that declares no pruner row instead of failing, and
  names the value in the generated preset's description.

## [0.3.7] - 2026-09-28

### Fixed

- **The settings card can now express `'auto'` for the pruner threshold.** 0.3.5 taught the resolver to accept
  `'auto'`, but the loader schema still declared `z.number()` and the card rendered the field as a numeric control,
  so the new default was unreachable from the UI. The schema is a union now and the field is free text, with the
  hint spelling out `auto` / `0` / a number.

  Found while diagnosing a production web session: its profile patch still carried `prunerThresholdChars: 0` — an
  explicit opt-out written by the 0.3.3 card, whose default was `0` — so even where retuning is reachable the
  pruner would have been left alone. (The main cause in that session was the plane, not the value: a web profile
  keeps compaction and the pruner inside each session's agent-preset realm, which is why the plugin reports
  "not reachable from this plane" and why `/trim preset` — which writes the `preset-<id>` override row — is the
  tool for web.)

## [0.3.6] - 2026-09-28

### Documented

- **Every formula the plugin computes is now in the README**, under *The arithmetic*: the trim budget and retained
  tail, what the planner compares and how a marker is priced, dsh's compaction trigger (stock and tuned, with the
  headroom that lets the ratio decide), the derived pruner threshold, the automatic-shrink ladder, and a worked
  table for the four routes we have measured (Bonsai 2 at 40,960, our 131,072 route, and deepseek-official at 1M).

## [0.3.5] - 2026-09-28

### Changed

- **The tool-result pruner threshold is derived by auto-tune instead of configured.** dsh ships a fixed 8192
  characters, which is safe on a large window and harmful on a small one: an agent that reads a source file gets
  8.5-29.5 KB back, so stock clips exactly the unit it needs and the agent re-reads it. The tuner now computes

  ```
  max(8192, min(32768, 2 x (contextWindow - maxTokens)))
  ```

  -- one result may hold up to half the route's message budget, capped at 32 KB, floored at stock so it can never
  clip more aggressively than dsh does -- and takes the smallest value across the routed windows. `'auto'` is the
  default; `0` is an explicit opt-out; a positive integer overrides both. `DSH_TRIM_PRUNER=auto|0|<n>` is the
  environment form, so a container is back to a single variable.

  Why it matters on a small route: at or below 64K the compaction side is deliberately left at stock (enabling the
  pressure trigger there is what made one 40K run slower), which leaves the pruner as the only lever -- and the
  first tuned Bonsai 2 run had it switched off, so 17 prune events still clipped every read over 8192 characters
  while three files were read three times each.

## [0.3.4] - 2026-09-28

### Added

- **`DSH_TRIM_PRUNER` and `DSH_TRIM_TUNE_STOCK_DISABLED`.** The two levers a small-window route needs are now
  settable from the environment, like `DSH_TRIM_AUTO_TUNE`, so a container entrypoint can set them once instead of
  patching every profile it boots. This closes the gap the first tuned Bonsai 2 run exposed: the image shipped
  `DSH_TRIM_AUTO_TUNE=1` alone, so `prunerThresholdChars` stayed at its default `0`, the pruner was never retuned,
  and every `read` over 8192 characters was still clipped to a head and a tail — 17 prune events, no compaction and
  no overflow, three reads each of `main.go`, `websec.go` and `infer.go`. On a route at or below 64K the compaction
  side is *deliberately* left at stock, which makes the pruner threshold the only lever there is.

## [0.3.3] - 2026-09-27

### Added

- **The tuner's three switches are on the settings card.** `autoTuneCompaction`, `tuneStockDisabledRoutes` and
  `prunerThresholdChars` join `compactionTargetRatio` and `compactionRoute` as volatile fields, so the three rules
  the tuner encodes — retune at runtime, leave a stock-disabled route alone unless asked, and stop the pruner from
  clipping a whole-file read — are reachable from the Plugins page instead of only from a patch layer.

  One honest limitation: dsh 0.1.7's primitives ship no switch control. `SettingsValueField` is a text control and
  `numeric` only hints the keypad, so the two booleans are text fields and the resolution side accepts what a card
  can type — `true`/`false`/`yes`/`no`/`on`/`off`/`1`/`0` for the flags, digits for the threshold. An empty draft
  still means "no override" and falls back to the default.

## [0.3.2] - 2026-09-27

### Added

- **The tuner can raise the tool-result pruner's clip threshold.** `prunerThresholdChars` (default `0`, which
  leaves the pruner alone) writes `tool-result-pruner`'s `thresholdChars` — the lever that matters on a small
  window, where dsh's 8192-character default clips every whole-file `read` back to a head and a tail, and the agent
  reads the same file again. It is the same profile plane and the same reachability rule as the compaction row:
  where a web profile keeps the pruner inside each session's preset, `/trim tune` reports that and writes nothing,
  while `scripts/make-preset-patch.mjs --pruner-threshold-chars` splices it into a preset instead. The value lands
  in the `context-trim/tuned` record beside the compaction settings, so one analysis pass sees both halves.

  The two halves differ by regime, which is why the default stays `0`: on a stock small window raising the pruner
  threshold is a pure win (that route has no pressure trigger, so a larger prompt cannot cause more compactions),
  while on a route whose pressure trigger is enabled it makes each request bigger and remains a deliberate trade.


## [0.3.1] - 2026-09-27

### Fixed

- **A trim made the session unreadable on dsh 0.1.7.** Session format v4 retired the generic
  `{kind: 'plugin', plugin: …}` source wrapper: its admission path fails with
  `format v4 message requires a producer-owned source kind`, while dsh's own v3-to-v4 converter derives
  exactly `plugin:<plugin id>` for a third-party producer. The replacement message now carries
  `plugin:dsh-command-context-trim`; `isTrimMarkerSource` still recognises markers written by earlier
  versions, so an old marker in an existing session stays ours instead of looking like user text. Checking
  it took the real validator rather than a stand-in — `scripts/check-session-marker.mjs --prefix <dsh install>`
  reports the new kind as ACCEPTED and the retired wrapper as REJECTED — because the rule lives in dsh, not
  here, which is why 127 green unit tests could not see the bug.
- Upgrade before relying on a session that contains a trim and was written by 0.3.0 or any 0.2.x under
  0.1.7. Sessions still in format v3 are converted correctly by dsh itself.
- Verified per line, by running each line's own admission validator rather than reasoning about the
  formats: 0.1.2-rc.1 ships no row-admission validator and the only `kind !== "plugin"` checks in that
  closure belong to other plugins' markers, so both shapes are accepted; 0.1.5-rc.3's
  `assertV3RowAdmission` accepts both; 0.1.7-rc.2's `assertV4RowAdmission` accepts this version's kind and
  rejects the retired wrapper. 0.3.1 is therefore not restricted to 0.1.7 — 0.3.0 is the restricted one.
  `scripts/check-session-marker.mjs` now runs every validator a line ships and is wired into the CI legs.


## [0.3.0] - 2026-09-26

### Added

- **`/trim preset` — generate a compaction-tuned agent preset from the live routes.** Compaction reads its policy at
  composition time, inside an agent-preset isolate realm that a host-plane plugin cannot reach, so the honest way to move
  the threshold is to contribute a preset row (an ordinary patch row since 0.1.7). The command clones the preset the
  session is using, replaces only `compaction-basic`'s config, and reports what it did:
  - `/trim preset check` prints the generated row and writes nothing;
  - `/trim preset list` shows every routable provider/model with its window, output reserve and the trigger it would get;
  - `/trim preset <provider>:<model>` generates using that route as the summarizer for this run.
  The clone is taken at generation time through `agentPresets.readDocument()`, which is what keeps a generated preset
  current: a hand-copied preset rots the moment dsh changes its own composition (exactly how one production preset died
  on the 0.1.7 upgrade).
- **`compactionTargetRatio` (default 0.8)** — the fraction of each routed model's window at which the generated preset
  makes compaction fire. It writes `thresholdRatio` **and** a per-route `headroomTokens` computed so the ratio actually
  decides: dsh's own default headroom (65536) otherwise caps a 131072-token route at 37.5 %.
- **`compactionRoute` (optional `{provider, model}`)** — the route the generated preset's summarization call runs on;
  validated as an all-or-nothing pair, mirroring dsh's rule for `summarizationProvider`/`summarizationModel`.
- `scripts/verify-preset-artifact.mjs` — proves a generated row against a real installation: it clones the shipped
  `standard` preset's plugin list, generates the row, and parses the result with the harness's own YAML stack.

- **Emergency trim.** When the plugin cannot trim and compaction cannot recover either, the turn used to die with the
  original request error. The plugin now wraps compaction by calling `next()`, inspects whether anything downstream
  acted, and if not takes one last-resort trim (at most one per overflow episode) in which the head-protected nodes —
  the original task statement — may be elided. The newest human instruction is still never crossed. `emergencyTrim`
  (default true) restores the old behaviour when off.

- **Settings card.** The Plugins page gains a **Context trim** card for `compactionTargetRatio` and `compactionRoute`.
  The Host half marks exactly those two fields `.volatile()` (which is what makes the loader entry a settings namespace
  at all) and re-reads its configuration per invocation, because a volatile field arrives as a live handle. The client
  half is a classic-script bundle that registers into `plugins.item` behind `configForms.whileServed([entryId])`,
  renders only the shared `SettingsForm` body, and returns the row's one-line summary. A web host without `configForms`
  gets no registration instead of a broken page.
  **Found by the isolated real-boot check:** a client half must register itself through
  `window.__ModuleLoader__.load({ id, factory })`; a plain ES module is fetched and then rejected with "loaded without
  registering … via __ModuleLoader__.load", which took the whole plugin's entry down with it. The card now follows the
  in-box bundle format, and a test asserts it.

### Notes

- **Routes whose stock profile has no pressure trigger are now left that way by default.** Field data showed that
  enabling a trigger there does not move an existing compaction, it creates one on every crossing (15 → 24 events on
  a single task, against a local summarizer that blocks the turn for 209–372 s per call). The planner therefore
  writes such a route a policy with dsh's stock 65536 headroom — the pressure budget stays negative and the trigger
  stays disabled — and prints why, leaving dsh's overflow path and the model-free `/trim` to handle the wall.
  Enabling it is now explicit: `--include-stock-disabled-routes` on `scripts/make-preset-patch.mjs`, or
  `tuneStockDisabledRoutes: true` for `/trim tune` (the manual `/trim preset` path takes the same config key).
- **The tuning is a per-backend decision, and the docs now say when it does not pay.** Measured by the backend-test
  session on 2026-09-27, Bonsai 2 @ RTX 5060 8GB (40960 / 8192), same task and single route, tuning confirmed
  applied: compaction events went **15 → 24** with the 80 % trigger on, and each event is a model call that blocks
  the turn (209–372 s with a local summarizer). Where dsh's stock headroom already *disables* the trigger
  (`message budget ≤ 65536`) the tuning cannot move a compaction — it creates one, so the honest advice for those
  routes is to leave them alone and let the model-free `/trim` repair the wall. The README gains a *When it does not
  pay* section, the container guide and the threshold handbook carry the same warning, and
  `scripts/make-preset-patch.mjs` / `/trim preset` now print it as a caution for every route they plan in that group
  (the `Qwen3.8:27b @ Intel Arc B70` row is unaffected: there the stock headroom *caps* a viable trigger, so 37.5 %
  → 80 % is a reduction in compactions).
- **An inventory that is not ready yet is a deferral, not a failure.** A headless boot can fire the first trigger
  before the provider row has resolved, which printed `no routable provider/model pairs were found` immediately in
  front of the `Retuned` line in the same boot — real in the field and worth fixing rather than explaining. It is now
  reported as deferred: silent at debug level, never on stderr, and it does not poison the failure memory. The
  manual `/trim tune check` still reports it on demand.
- **A repeated refusal is reported once.** The guard against a plane it cannot reach (a web profile's preset
  realm, say) fails identically on every trigger, and the per-request trigger would have turned that into a
  stderr and logger line per request — which a stray `DSH_TRIM_AUTO_TUNE` in a service environment would have
  made very visible. An unchanged failure is now reported once and logged at debug; a later success clears the
  memory, so a recovery is reported too.
- **A retune is recorded in the session log for analysis.** Every applied retune appends one non-surface
  `context-trim/tuned` event carrying the settings written, the keys that changed, the capacity the adapter
  actually reported per route, and the per-route policies. It is not a surface message, so it never enters the
  model's context or the token bill, and it is not a known harness event type, so no client renders it — it is
  there for session analysis, next to the `request/context` and `compaction/*` records. `stderr` keeps its one
  line per retune for automated assertions. Verified live: a `DSH_TRIM_AUTO_TUNE=1` run wrote the record with
  `trigger: "auto"`, `contextWindow: 65536` and `headroomTokens: 9012` for its mock route, and answered `ok`.
- **Auto tune reports without touching the conversation.** A retune now prints exactly one line on stderr
  (`context-trim: auto compaction tune: Retuned compaction-basic (…)`) besides logging it, because the cordis
  logger only reaches a user where a profile wires an exporter and a headless profile does not — previously the
  report was written but visible nowhere, and the line it logged was the report's *heading* rather than its
  outcome. A re-check that finds nothing new stays silent, so the per-request trigger does not spam a container's
  logs, and nothing is ever added to the session: the model's context and the token bill are untouched.
  Verified live: a `DSH_TRIM_AUTO_TUNE=1` one-shot run printed the retune line and answered `ok`.
- **Trigger set reviewed, not accumulated.** Auto tune fires on `agent/created`, on every `agent/request`
  before it is sent, on a session's `model/selection`, and on an idle moment. The system-prompt insertion was
  dropped: it is committed even earlier in the same step (the surface is built before the request hook), so it
  added a second recompute for that step while still needing a guess at the agent. The write is immediate and not awaited, which is what a one-shot
  `dsh headless "task"` needs.
- **`DSH_TRIM_AUTO_TUNE` turns auto tuning on (or off) from the environment**, overriding the profile's own
  setting: `1/true/yes/on` and `0/false/no/off` are accepted, an empty value means unset, anything else fails
  loudly at load. This is an **automation/CI switch** — it exists so a container or a harness can enable the
  behaviour without editing a profile. Normal web and production profiles should configure `autoTuneCompaction`
  through the settings card or a patch layer instead: the variable overrides that setting, and in a web profile a
  runtime retune has nowhere to land in any case. Verified live with no switch in any patch at all — `DSH_TRIM_AUTO_TUNE=1` plus a task that
  used no tool and never went idle still landed the tuned `compaction-basic` row in the profile patch. The
  README's permission table now states this one environment read explicitly.
- **Auto tune now works in one-shot headless runs.** The triggers are `agent/created`, **every
  `agent/request` before it is sent**, the system-prompt insertion and (for long-lived profiles) an idle
  moment; the write happens immediately and is not awaited, because a `dsh headless "task"` process never
  reaches an idle moment. Verified live with a task that used no tool and never went idle at all
  (`step/start` → `system/message` → `turn/end`): the tuned `compaction-basic` row still landed in the
  profile patch. The request waterfall is handed on untouched, and an unchanged route writes nothing.
- **Auto tune re-checks per request.** `autoTuneCompaction` now recomputes the tuning whenever the surface's
  system prompt is inserted — the moment a session's route can have changed, such as a mid-conversation model
  switch — and performs the write at the next idle, because a restarted row cancels work in progress. It
  previously ran once per process, which missed exactly that case. An unchanged result writes nothing, so the
  re-check adds no restart churn. Re-verified live in a fresh headless home after the change: the session
  answered and the tuned `compaction-basic` row again landed in the profile patch.
- **Auto tune verified end to end.** In a fresh isolated `DSH_HOME` with the plugin installed as a bundle and
  `autoTuneCompaction: true`, a headless session discovered the route through the adapter, computed the per-route
  headroom and wrote the tuned `compaction-basic` row into the profile patch **while the session ran** (observed row:
  `thresholdRatio 0.8`, `headroomTokens 0`, `modelPolicies: [{mock/mock-model, headroomTokens 9012}]` for a backend
  declaring 65536/4096). The session exited 0, and the plugin activates in a headless profile.
- **`/trim tune` retunes a live process.** Compaction is an ordinary plugin row wherever the profile composes
  it on the profile plane (`dsh-base`: headless, tui), and cordis applies a config change by restarting the
  fiber — `Fiber.update()` resolves the new config and calls `restart()`, dispose plus a fresh apply, with no
  "hot-reloadable only" restriction (read from the loader source). The command therefore reads the routes from
  the adapter (`ctx.llm.resolveModelInfo`, the same source compaction uses), computes the tuning, and writes it
  onto the `compaction-basic` row; the write is skipped when nothing changes and refused with an explanation
  where it cannot reach — a web profile keeps compaction inside each session's agent-preset isolate realm, and a
  session's preset is locked once it starts. `autoTuneCompaction` (default `false`) does the same once per
  process, the first time the agent goes idle, so the restart cannot cancel an in-flight compaction.
- **The generator no longer guesses a window.** `scripts/make-preset-patch.mjs` resolves the route capacity
  from, in order: `--routes`, `--dump <file>` (a `dsh … --dump-config` output, parsed for `llm-pi-ai`'s
  provider table and `agent-default-model`; the script never spawns dsh), and the
  `--context-window`/`--max-tokens`/`--model` **override** for the numbers a backend really serves (a card
  that answers with 40k while the profile claims 128k, or a fresh instance that declares no backend yet):
  the named route — else the active one — takes exactly those numbers, a route the base does not declare is
  added, and only the numbers passed are replaced. With none of them it **errors** instead of emitting a threshold that silently depends on an assumed
  window; `--window-agnostic` is the explicit ratio-only overlay. `--summarizer-max-tokens` is now the
  compaction call's own cap, kept distinct from a route's output reserve. `lib/dump-routes.js` holds the
  parser and the resolution order, both covered by tests over a realistic dump fixture.
- **`docs/headless-compaction-tuning.md`** is the hand-off document for a fresh environment: prerequisites, the
  one-line overlay generation, the boot command, the assertions a test script can make, the optional per-route
  policy form, why a preset does not apply to a headless run, the four failure signatures hit while building it,
  and what remains unverified. The drill needs Node only (no python3, no iproute2).
- **Headless automation takes the profile plane, not a preset.** `scripts/make-preset-patch.mjs` turns a
  route inventory into either a preset row plus `agent-preset-registry` default (the web/session-API route) or,
  with `--mode host`, a row override for the profile's own `compaction-basic` — because a headless profile
  composes compaction itself and never resolves a session preset. Verified in a clean `DSH_HOME`: three
  headless runs (no overlay / generated preset / that preset with a tool row deleted) produced an identical
  24-tool request surface, while the host-plane overlay lands the tuned config on the composed
  `compaction-basic` row and a session under it exits 0.
  `fixtures/headless-tuned-preset/` carries the route inventory, a mock provider patch, the drill script and
  the notes on what cannot be asserted (the picker label is draft state; `agent-preset/selected` is absent
  when a session is created with the default).
- **The preset choice is per session, and locked once a session starts.** `agentPresets.select()` refuses with
  `agent-preset/locked` ("This session has already started") as soon as a turn is open or one has completed, because a
  switch recomposes the preset's isolate realm. The command's completion message now says so instead of pointing at the
  preset menu as if a running session could switch, and `/trim preset default` was added for the case it describes:
  it writes `agent-preset-registry.selectedDefault` through the same settings path the official picker uses — but only
  after the generated preset shows up as a healthy registration, since the new-session path resolves the default and an
  unknown id would break it (`agent-preset/not-found`).
- Store-facing metadata, added without changing the version: an explicit **Permissions and failure bounds** section in
  the README (the runtime's only file-system touch is the `/trim preset` patch write; no network, no command execution,
  no credential access), a `dsh.compatibility.dshReleases` map declaring exactly the harness lines this repository has
  evidence for, and the overflow-check server moved from `scripts/` to `fixtures/` so a scan of *runtime* source sees
  `lib/` only. That files capability is deliberate and cannot be removed: it *is* the preset generation. Under the
  catalog's own model a legitimate plugin with file capability belongs in `user-reviewed`, not `source-verified`.
- The generated row lands in the profile patch inside marker comments
  (`# >>> dsh-command-context-trim: preset-<id> … >>>`), so it is idempotent, reviewable and removable by deleting the
  block. One rolling backup (`cordis.patch.yml.bak-trim-preset`) is kept.
- Nothing here changes trimming: the trigger ratio only shapes the preset.
- Verified on 0.1.7-rc.2, in an isolated instance and never in production:
  - the artifact parses with the harness's YAML stack, and a profile that carries the generated row composes cleanly
    (1,447-line dump, `compaction` group with its isolate realm intact, threshold and policies present);
  - a generated row appended to a live profile patch appears in the preset menu as "Standard (tuned 75%)" after a client
    reload — no runtime registration and no dsh restart — and selecting it works;
  - the settings card renders in the Plugins page (summary line under Official, both fields, staged edit, Save), and the
    save lands as a `context-trim` row in the profile patch with the value typed in the GUI.
- Compatibility, caught by the matrix: `.volatile()` needs schemastery 3.18.4, and a harness that predates it (0.1.5 and
  earlier) failed to import the plugin at all until the field marking became a capability probe. On such a host the two
  fields stay plain — the plugin loads and works, it just shows no card, which is right because its web UI has no
  `configForms`. The client manifest likewise declares only `platform: web`: naming 0.1.7-only client packages in
  `dsh.client.inject` would have asked a 0.1.5 host for packages it does not have, and the real requirement (slots,
  locale, configForms) is gated by cordis in the browser plugin's own `inject` list.
- Not done, because the framework does not support it: a provider/model **dropdown**. dsh 0.1.7's shared settings form
  exports only `settingsNumberField` and `settingsTextField`, and a hand-drawn control would break the staged-form
  contract. `/trim preset list` covers the need by printing the live route inventory.


## [0.2.3] - 2026-09-22

### Fixed

- **Harness 0.1.7 compatibility.** 0.1.7 flattens tool-result messages: up to 0.1.5 the content was a single
  `tool-result` wrapper block, from 0.1.7 the blocks sit directly on the message (`{role:'tool', toolCallId,
  content:[…]}`), and sessions gained a `deriveEventMessage()` method that the official pruner now uses instead of
  reading `event.data.message`. The in-place slim read the wrapper unconditionally, so on 0.1.7 it threw
  `blocks is not iterable` inside the overflow handler — the automatic path then declined and handed every wall hit to
  compaction without trimming anything. It now reads and rebuilds both shapes and takes the message from
  `session.deriveEventMessage()` when the session offers it. An unrecognised shape is skipped rather than thrown: this
  path must never be the reason an overflow recovery is abandoned.
- Suite is green on the pinned floor (0.1.2-rc.1), 0.1.5-rc.3 and 0.1.7-rc.2 — 72 tests on each. CI gained a fixed
  0.1.5 leg so the middle line stays covered while `next` moves forward.


## [0.2.2] - 2026-09-22

### Added

- **Cheap reduction first: oversized tool results are slimmed in place before any span is elided.** On the wall the
  plugin now performs the same head/marker/tail transform DSH's own pruner performs — keeping the node, its tool call and
  the prefix up to it — and only elides a whole span when that is not enough. It delegates to the official
  `toolResultPruner` service when that service is reachable from the plugin's context (0.1.2; a 0.1.5 headless profile
  where compaction stays on the host plane) and performs the identical transform itself when it is not (a 0.1.5 web
  profile hides the pruner inside an agent-preset isolate realm). New configuration: `preferInPlacePrune` (default true)
  and `pruneThresholdChars` / `pruneHeadChars` / `pruneTailChars` (8192 / 4096 / 1024, mirroring DSH's defaults).
- The in-place marker is `[... tool result middle trimmed to fit the context window ...]`, deliberately distinct from
  DSH's `[... tool result middle pruned ...]`, so a session log shows which producer slimmed a node.

### Notes

- Verified end to end in the real `dsh-container` image (0.1.5-rc.2, isolated home, mock backend): a request of 23,429
  tokens was refused, the plugin delegated to the official pruner, the retry came back at 19,995 tokens, the turn
  completed, and the session log shows **no `compaction/start`** and **no span elided** — the pruner's `tool/result`
  replacement kept `callId` and the step. The earlier span path was verified the same way (33,373 → 18,431 tokens).
  The inline fallback (used only where the service is unreachable, i.e. a 0.1.5 web profile) is unit-tested against the
  same semantics but not yet exercised end to end.
- `scripts/mock-overflow-server.mjs` gained `TOOL_COMMAND` / `TOOL_DESCRIPTION`: a bash tool call without a `description`
  fails argument validation, which silently produced tiny error results instead of real tool output during testing.


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

- **Automatic-trim decisions now log at `warn`.** An unattended rewrite of the user's context has to be visible in the
  host log: a test run recorded the trim in the session log while the app log showed nothing, because `info` is filtered
  at the default level.
- The README now explains how to tell this plugin's `compaction/prune` from DSH's tool-result pruner in a session log
  (producer of the following event, and pre-step vs in-step position) and the two `usage` accounting traps.

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

[Unreleased]: https://github.com/snailium/dsh-command-context-trim/compare/v0.6.6...HEAD
[0.6.6]: https://github.com/snailium/dsh-command-context-trim/compare/v0.6.5...v0.6.6
[0.6.5]: https://github.com/snailium/dsh-command-context-trim/compare/v0.6.4...v0.6.5
[0.6.4]: https://github.com/snailium/dsh-command-context-trim/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/snailium/dsh-command-context-trim/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/snailium/dsh-command-context-trim/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/snailium/dsh-command-context-trim/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/snailium/dsh-command-context-trim/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/snailium/dsh-command-context-trim/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/snailium/dsh-command-context-trim/compare/v0.4.9...v0.5.0
[0.4.9]: https://github.com/snailium/dsh-command-context-trim/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/snailium/dsh-command-context-trim/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/snailium/dsh-command-context-trim/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/snailium/dsh-command-context-trim/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/snailium/dsh-command-context-trim/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/snailium/dsh-command-context-trim/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/snailium/dsh-command-context-trim/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/snailium/dsh-command-context-trim/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/snailium/dsh-command-context-trim/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/snailium/dsh-command-context-trim/compare/v0.3.12...v0.4.0
[0.3.12]: https://github.com/snailium/dsh-command-context-trim/compare/v0.3.11...v0.3.12
[0.3.11]: https://github.com/snailium/dsh-command-context-trim/compare/v0.3.10...v0.3.11
[0.3.10]: https://github.com/snailium/dsh-command-context-trim/compare/v0.3.9...v0.3.10
[0.3.9]: https://github.com/snailium/dsh-command-context-trim/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/snailium/dsh-command-context-trim/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/snailium/dsh-command-context-trim/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/snailium/dsh-command-context-trim/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/snailium/dsh-command-context-trim/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/snailium/dsh-command-context-trim/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/snailium/dsh-command-context-trim/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/snailium/dsh-command-context-trim/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/snailium/dsh-command-context-trim/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/snailium/dsh-command-context-trim/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/snailium/dsh-command-context-trim/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/snailium/dsh-command-context-trim/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/snailium/dsh-command-context-trim/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/snailium/dsh-command-context-trim/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/snailium/dsh-command-context-trim/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/snailium/dsh-command-context-trim/releases/tag/v0.1.0
