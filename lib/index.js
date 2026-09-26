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
import { resolveConfig } from './config.js';
import { describeError } from './render.js';
import { tuneCompactionPreset } from './preset-tune.js';
import { executeTrim } from './trim-session.js';

/** Cordis plugin name. */
export const name = 'context-trim';

/** Services required before the command can be registered. */
export const inject = ['commands', 'tokenMeter', 'llm'];

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
	maxAutoTrimRetries: z.number()
});

/**
 * Register `/trim` for every composed human-command adapter, and the automatic
 * context-overflow handler for every agent.
 * @param ctx - context carrying the command registry, token meter, and LLM service.
 * @param config - untrusted plugin configuration.
 */
export function apply(ctx, config) {
	const resolved = resolveConfig(config ?? {});
	const active = new Set();
	const handler = (invocation) => {
		const operation = execute(ctx, resolved, invocation);
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
			input: { hint: '[check] [tokens|k] [provider:model] | preset [check|list] [provider:model]' },
			handler
		});
	}, 'context-trim lifecycle');
	registerAutoTrim(ctx, resolved);
}

/**
 * Execute one `/trim` invocation inside an idle-agent reservation.
 * @param ctx - plugin context.
 * @param config - resolved configuration.
 * @param invocation - command invocation from the UI adapter.
 * @returns a command result.
 */
async function execute(ctx, config, invocation) {
	const parsed = parseTrimArguments(invocation.rawInput);
	if (parsed.error !== undefined) return { kind: 'error', text: `${parsed.error}\n${USAGE}` };
	if (parsed.preset === true) {
		// Config work touches no session surface, so it needs no idle-agent
		// reservation: it may run while a turn is live.
		try {
			const { result } = await tuneCompactionPreset(ctx, config, {
				agent: invocation.agent,
				signal: invocation.signal,
				requestedRoute: parsed.route,
				check: parsed.check,
				list: parsed.list === true
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
