/**
 * `/trim` — model-free context trimming for DeepSeek Harness.
 *
 * A session built against a large-window cloud model can exceed a smaller local
 * model's window the moment the model is switched. `/compact` cannot rescue that
 * situation reliably, because compaction *summarizes*: its summarizer call must
 * itself fit the (now smaller) window while holding the very region being
 * condensed, so it fails for the same reason the original request failed.
 *
 * `/trim` needs no model at all. It measures the current request under the
 * target route, picks the oldest tool-pairing-balanced span that frees exactly
 * enough tokens, and shadows that span with one short marker message — two
 * synchronous appends, zero LLM calls, so it works precisely when every request
 * is failing.
 *
 * The same execution also runs **automatically** on the context wall: a
 * prepended `agent/request-error` listener trims on `CONTEXT_WINDOW_EXCEEDED` and
 * retries, and only hands the problem to compaction (prune + summarize) when it
 * cannot free anything — see `./auto-trim.js`.
 *
 * @module dsh-command-context-trim
 */
import z from '@deepseek-ai/schemastery';
import { isTuneInvocation, parseTrimArguments, TUNE_USAGE, USAGE } from './args.js';
import { registerAutoTrim } from './auto-trim.js';
import { configValue, plainConfig, readConfig, resolveConfig } from './config.js';
import { describeError } from './render.js';
import { rescuePreset, resetPresets, tuneCompactionPreset } from './preset-tune.js';
import { registerPresetSync } from './tune-runtime.js';
import { registerAutoTune, tuneCompactionAtRuntime } from './tune-runtime.js';
import { executeTrim } from './trim-session.js';

/** Cordis plugin name. */
export const name = 'context-trim';

/**
 * The tuning row's live configuration, published for the trim row to read.
 *
 * The two rows are separate fibers: each gets its own `ctx`, and they cannot inject each other without making the
 * dependency mandatory — which would stop the trim row from starting whenever the tuning row is switched off, exactly
 * the independence this split is for. A module-level handle keeps the link optional: when the tuning row is absent
 * this stays `null`, and the `/trim` subcommands that need it say so instead of failing. (Two entries of one bundle
 * share this module instance; if a future loader ever gave each row its own, the only symptom would be that those
 * subcommands report "not enabled" while the tuning row is visibly on — a degraded answer, never a crash.)
 *
 * Only the keys the tuning row **explicitly sets** are published, never its defaulted ones. That is what keeps the
 * split additive: a profile that predates it still has its compaction knobs on the trim row, and the tuning row's
 * defaults (`autoTuneCompaction: false`, `prunerThresholdChars: 'auto'`) must not silently override them.
 * @type {object | null}
 */
let tuningOverrides = null;

/**
 * The compaction tuner's keys this entry explicitly sets, handles unwrapped.
 *
 * The point is to publish *overrides*, not the whole configuration: the bundle patch gives the tuning row the same
 * defaults a fresh install would have, and merging those in would silently undo whatever a pre-split profile has on
 * its trim row. Only what the deployment actually wrote travels.
 * @param raw - the tuning row's raw loader configuration.
 * @returns a plain object holding just the compaction keys that were set.
 */
const TUNING_KEYS = [
	'compactionTargetRatio',
	'compactionRoute',
	'autoTuneCompaction',
	'tuneStockDisabledRoutes',
	'prunerThresholdChars'
];

export function explicitOverridesFor(raw) {
	const plain = plainConfig(raw);
	const out = {};
	for (const key of TUNING_KEYS) {
		if (plain[key] !== undefined) out[key] = configValue(plain[key]);
	}
	return out;
}

/** Services required before the command can be registered. */
export const inject = ['commands', 'tokenMeter', 'llm'];

/**
 * Mark a field volatile when the host's schemastery understands it.
 *
 * `.volatile()` arrived in schemastery 3.18.4; a harness older than that (0.1.5 and
 * earlier) has no such method and would fail the whole import. Volatility only has to
 * do with the settings card, so an older host simply keeps a plain field: the plugin
 * loads and works, it just shows no card — which is correct, because its web host has
 * no `configForms` either.
 * @param schema - the field schema to mark.
 * @returns the same schema, volatile when supported.
 */
function volatile(schema) {
	return typeof schema.volatile === 'function' ? schema.volatile() : schema;
}

/** Loader-facing configuration shape; ranges are enforced by `resolveConfig`. */
export const Config = z.object({
	// Which half of the plugin this entry is. One bundle ships two rows, and a row is a loader entry with its own
	// config namespace and its own fiber, so each half can be switched off and tuned on its own. The host does NOT
	// hand the entry its own id (`ctx.fiber.name` is the module name for both rows), so this is how `apply` knows which
	// half it is running as. It defaults to the full trimmer, which is what every existing profile means today.
	role: z.union([z.const('trim'), z.const('tuning')]).default('trim'),
	targetRatio: z.number(),
	reserveOutputTokens: z.number(),
	retainRatio: z.number(),
	retainTokens: z.number(),
	minTailTokens: z.number(),
	protectHeadNodes: z.number(),
	allowTailTrim: z.boolean(),
	markerSlackTokens: z.number(),
	autoTrim: z.boolean(),
	maxAutoTrimRetries: z.number(),
	// The two knobs the GUI settings card exposes. `.volatile()` is what puts a
	// field on the card at all (0.1.7 keeps only volatile fields in a form), and it
	// is also why every read of the configuration goes through `readConfig`: a
	// volatile field arrives as a live handle.
	// The trims' own knobs, on the `trim` row's card. They are `.volatile()` because that is the only thing that puts
	// a field on a settings card: a 0.1.7 form carries volatile fields, and the Host only reports an entry as a
	// settings namespace at all when its schema has some. They were never volatile before, which is why the trims had
	// no card of their own and the one card that existed showed the tuner's fields.
	targetRatio: volatile(z.number().description('Share of the usable window a trim aims to leave')),
	retainRatio: volatile(z.number().description('How much of the most recent context is kept verbatim, as a share of the model window')),
	minTailTokens: volatile(z.number().description('Absolute floor for that retained tail, in tokens')),
	reserveOutputTokens: volatile(z.number().description('Tokens kept available for the model own reply')),
	protectHeadNodes: volatile(z.number().description('Leading nodes never trimmed (the task statement)')),
	maxAutoTrimRetries: volatile(z.number().description('Automatic trims allowed per overflow episode before compaction takes over')),
	allowTailTrim: volatile(z.boolean().description('Let the elided span reach the retained tail when the oldest span alone cannot free enough')),
	autoTrim: volatile(z.boolean().description('Trim when a request hits the context wall instead of compacting; ordinary threshold compaction is untouched')),
	emergencyTrim: volatile(z.boolean().description('Last-resort trim when compaction cannot recover a wall hit; the protected head may be elided, the newest human instruction never')),
	preferInPlacePrune: volatile(z.boolean().description('Slim oversized tool results in place before eliding any span')),
	pruneThresholdChars: volatile(z.number().description('A tool result is slimmed in place only when it exceeds this many characters')),
	pruneHeadChars: volatile(z.number().description('Head kept when a tool result is slimmed in place')),
	pruneTailChars: volatile(z.number().description('Tail kept when a tool result is slimmed in place')),
	compactionTargetRatio: volatile(z.number().description('Compaction trigger as a fraction of each routed window (used by /trim preset)')),
	compactionRoute: volatile(
		z.union([z.string(), z.object({ provider: z.string(), model: z.string() })]).description('Route the generated preset summarises on, as "provider:model"')
	),
	// The tuner's three switches, exposed on the card. They are text fields there (0.1.7's primitives ship no
	// switch control), which is why `resolveConfig` accepts "true"/"false" and digit strings as well.
	autoTuneCompaction: volatile(
		z.boolean().default(false).description('Retune the compaction trigger at runtime (true/false)')
	),
	tuneStockDisabledRoutes: volatile(
		z.boolean().default(false).description('Also enable the pressure trigger on routes whose stock headroom disables it (true/false)')
	),
	prunerThresholdChars: volatile(
		z.union([z.const('auto'), z.number()]).default('auto').description(
			"Tool-result pruner clip threshold in characters; 'auto' derives it from the routed window, 0 leaves the pruner alone"
		)
	)
});

/**
 * Register `/trim` for every composed human-command adapter, and the automatic
 * context-overflow handler for every agent.
 * @param ctx - context carrying the command registry, token meter, and LLM service.
 * @param config - untrusted plugin configuration.
 */
export function apply(ctx, config) {
	// Kept raw (not resolved once) so a settings-card edit is honoured on the next
	// invocation without a reload; `readConfig` unwraps volatile handles.
	const raw = config ?? {};
	const role = readConfig(raw).role ?? 'trim';

	if (role === 'tuning') {
		// This half only decides *when compaction fires and how hard the pruner clips*. It owns no command, so it
		// can be switched off without `/trim` disappearing.
		tuningOverrides = explicitOverridesFor(raw);
		registerAutoTune(ctx, raw);
		if (readConfig(raw).autoTuneCompaction === true) registerPresetSync(ctx, raw);

		// The command belongs to this row, so switching the row off removes it. Its description states the one thing
		// a reader cannot guess: switching it off does NOT reset presets that were already tuned, and those keep the
		// values they were given until `/context-tune reset` removes our row.
		const tuneActive = new Set();
		const tuneHandler = (invocation) => {
			const operation = executeTune(ctx, raw, invocation);
			tuneActive.add(operation);
			const retire = () => {
				tuneActive.delete(operation);
			};
			operation.then(retire, retire);
			return operation;
		};
		ctx.effect(function* () {
			yield async () => {
				await Promise.allSettled(tuneActive);
			};
			yield ctx.commands.register({
				name: 'context-tune',
				description:
					'Tune when compaction fires and how hard the tool-result pruner clips ' +
					'(preset | tune | rescue | reset). Owned by the context-tuning row: switch that row off and this ' +
					'command goes away. Switching it off does NOT reset presets that were already tuned — they keep the ' +
					'values they were given, until /context-tune reset removes the row this plugin wrote.',
				input: {
					hint: 'preset [check|list|default|inplace] [provider:model] | tune [check] | rescue <preset-id> | reset [check] [preset-id]'
				},
				handler: tuneHandler
			});
		}, 'context-tuning: command lifecycle');
		return;
	}

	// The trims' half. The `/trim` subcommands that tune compaction need the tuning row's values, so they read the
	// merged view below; a profile that has not been split yet keeps working, because its tuning values are still in
	// this row's own config and win whenever no tuning row is published.
	const active = new Set();
	const handler = (invocation) => {
		const operation = execute(ctx, raw, invocation);
		active.add(operation);
		const retire = () => {
			active.delete(operation);
		};
		operation.then(retire, retire);
		return operation;
	};
	ctx.effect(function* () {
		yield async () => {
			await Promise.allSettled(active);
		};
		yield ctx.commands.register({
			name: 'trim',
			description: 'Drop the least valuable span of context to fit the active model window (no model call)',
			input: { hint: '[check] [tokens|k] [provider:model] | preset [check|list|default] [provider:model] | tune [check]' },
			handler
		});
	}, 'context-trim lifecycle');
	registerAutoTrim(ctx, raw);
}


/**
 * Execute one `/context-tune` invocation.
 *
 * The compaction-tuning surface, on its own command so the tuning row can own it: switch that row off and the
 * command is gone entirely, rather than remaining and quietly falling back to defaults. It resolves the merged view
 * (this row's own values, with the tuning row's explicit overrides on top) so a profile that has not been split
 * yet keeps tuning exactly as before.
 * @param ctx - plugin context.
 * @param rawConfig - the tuning row's own raw configuration.
 * @param invocation - command invocation from the UI adapter.
 * @returns a command result.
 */
async function executeTune(ctx, rawConfig, invocation) {
	const config = readConfig({ ...rawConfig, ...(tuningOverrides ?? {}) });
	const parsed = parseTrimArguments(invocation.rawInput);
	if (parsed.error !== undefined) return { kind: 'error', text: `${parsed.error}\n${TUNE_USAGE}` };
	// A bare `/context-tune` is not a tuning invocation; it is somebody who wants the list.
	if (!isTuneInvocation(parsed)) return { kind: 'error', text: TUNE_USAGE };

	if (parsed.reset === true) {
		// A reset is pure file work on the profile patch: it reads it, and needs no session and no idle agent.
		try {
			return await resetPresets(ctx, { presetId: parsed.presetId, check: parsed.check });
		} catch (error) {
			return { kind: 'error', text: `Reset failed: ${describeError(error)}` };
		}
	}
	if (parsed.tune === true) {
		try {
			const running = invocation.agent.runMaintenance(async (agentSignal) => {
				const signal = AbortSignal.any([invocation.signal, agentSignal]);
				const { result } = await tuneCompactionAtRuntime(ctx, config, {
					agent: invocation.agent,
					signal,
					requestedRoute: parsed.route,
					check: parsed.check,
					trigger: 'command'
				});
				// A person asked: a deferred route inventory is something to report, not to hide.
				return result.kind === 'deferred' ? { kind: 'error', text: result.text } : result;
			});
			return await running;
		} catch (error) {
			return { kind: 'error', text: `Tuning needs an idle agent: ${describeError(error)}` };
		}
	}
	if (parsed.rescue === true) {
		// Config work touches no session surface, so it may run while a turn is live.
		try {
			const { result } = await rescuePreset(ctx, config, {
				agent: invocation.agent,
				signal: invocation.signal,
				missingId: parsed.missingId,
				donorId: parsed.donorId,
				untuned: parsed.untuned === true,
				check: parsed.check
			});
			return result;
		} catch (error) {
			return { kind: 'error', text: `Preset rescue failed: ${describeError(error)}` };
		}
	}
	if (parsed.preset === true) {
		// Config work touches no session surface, so it needs no idle-agent
		// reservation: it may run while a turn is live.
		try {
			const { result } = await tuneCompactionPreset(ctx, config, {
				agent: invocation.agent,
				signal: invocation.signal,
				requestedRoute: parsed.route,
				check: parsed.check,
				list: parsed.list === true,
				setDefault: parsed.default === true,
				inplace: parsed.inplace === true
			});
			return result;
		} catch (error) {
			return { kind: 'error', text: `Preset tuning failed: ${describeError(error)}` };
		}
	}
}

/**
 * Execute one `/trim` invocation inside an idle-agent reservation.
 * @param ctx - plugin context.
 * @param config - resolved configuration.
 * @param invocation - command invocation from the UI adapter.
 * @returns a command result.
 */
async function execute(ctx, rawConfig, invocation) {
	const config = readConfig(rawConfig);
	const parsed = parseTrimArguments(invocation.rawInput);
	if (parsed.error !== undefined) return { kind: 'error', text: `${parsed.error}\n${USAGE}` };
	// The tuning surface lives on `/context-tune`, owned by the tuning row, so switching that row off removes the
	// whole thing. Naming the new command is worth more than a usage dump: the old spelling is what people type.
	if (isTuneInvocation(parsed)) {
		const sub = invocation.rawInput.trim().split(/\s+/u)[0];
		return { kind: 'error', text: `"/trim ${sub}" moved to /context-tune.\n\n${TUNE_USAGE}` };
	}
	let running;
	try {
		running = invocation.agent.runMaintenance(async (agentSignal) => {
			const signal = AbortSignal.any([invocation.signal, agentSignal]);
			const { result } = await executeTrim(ctx, config, {
				agent: invocation.agent,
				signal,
				requestedRoute: parsed.route,
				explicitBudget: parsed.budget,
				check: parsed.check
			});
			return result;
		});
	} catch (error) {
		return { kind: 'error', text: `Trim needs an idle agent: ${describeError(error)}` };
	}
	try {
		return await running;
	} catch (error) {
		if (invocation.signal.aborted) return { kind: 'error', text: 'Trim cancelled.' };
		return { kind: 'error', text: `Trim failed: ${describeError(error)}` };
	}
}
