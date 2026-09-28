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
import { parseTrimArguments, USAGE } from './args.js';
import { registerAutoTrim } from './auto-trim.js';
import { readConfig, resolveConfig } from './config.js';
import { describeError } from './render.js';
import { rescuePreset, tuneCompactionPreset } from './preset-tune.js';
import { registerAutoTune, tuneCompactionAtRuntime } from './tune-runtime.js';
import { executeTrim } from './trim-session.js';

/** Cordis plugin name. */
export const name = 'context-trim';

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
	const resolved = () => readConfig(raw);
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
	registerAutoTune(ctx, raw);
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
