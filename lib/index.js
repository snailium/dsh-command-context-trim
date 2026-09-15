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
 * @module dsh-command-context-trim
 */
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import z from '@deepseek-ai/schemastery';
import { parseTrimArguments, USAGE } from './args.js';
import { applyTrim, createMarkerMessage, provisionalMarker } from './apply.js';
import { budgetFor, resolveConfig, retentionFor } from './config.js';
import { planTrim } from './plan.js';
import { resolveTarget, targetHeader } from './target.js';

/** Cordis plugin name. */
export const name = 'context-trim';

/** Services required before the command can be registered. */
export const inject = ['commands', 'tokenMeter', 'llm'];

/** Loader-facing configuration shape; ranges are enforced by {@link resolveConfig}. */
export const Config = z.object({
	targetRatio: z.number(),
	reserveOutputTokens: z.number(),
	retainRatio: z.number(),
	retainTokens: z.number(),
	minTailTokens: z.number(),
	protectHeadNodes: z.number(),
	allowTailTrim: z.boolean(),
	markerSlackTokens: z.number()
});

/**
 * Register `/trim` for every composed human-command adapter.
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
			input: { hint: '[check] [tokens|k] [provider:model]' },
			handler
		});
	}, 'context-trim lifecycle');
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
	let running;
	try {
		running = invocation.agent.runMaintenance((agentSignal) => trimOnce(ctx, config, invocation, parsed, agentSignal));
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

/**
 * Plan and apply one trim; the whole session-visible mutation happens here.
 * @param ctx - plugin context.
 * @param config - resolved configuration.
 * @param invocation - command invocation (agent, signal).
 * @param parsed - parsed command arguments.
 * @param agentSignal - cancellation owned by the maintenance reservation.
 * @returns a command result.
 */
async function trimOnce(ctx, config, invocation, parsed, agentSignal) {
	const signal = AbortSignal.any([invocation.signal, agentSignal]);
	signal.throwIfAborted();
	const session = invocation.agent.session;
	assertNoOpenCompaction(session);
	const target = parsed.budget === undefined ? await resolveTarget(ctx, invocation.agent, parsed.route, signal) : undefined;
	const budget = parsed.budget ?? budgetFor(target.contextWindow, config);
	const label = target === undefined ? `an explicit ${budget}-token budget` : `${target.label} (window ${target.contextWindow})`;
	const header = target === undefined ? undefined : targetHeader(session, target);
	const measurement = ctx.tokenMeter.measure(session, header);
	const nodes = measurement.nodes.map((node) => ({ seq: node.seq, heuristicTokens: node.heuristicTokens }));
	if (nodes.length === 0) {
		return { kind: 'success', text: `Nothing to trim: ${session.id} has no model-visible messages yet.` };
	}
	// The retained tail scales with the capacity being fitted: the target window
	// when one is known, otherwise the explicit budget itself.
	const retainTokens = retentionFor(target?.contextWindow ?? budget, config);
	const envelopeTokens = Math.max(0, measurement.totalTokens - measurement.surfaceTokens);
	const planFor = (markerTokens) =>
		planTrim({
			nodes,
			envelopeTokens,
			budget,
			markerCost: markerTokens + config.markerSlackTokens,
			retainTokens,
			minTailTokens: config.minTailTokens,
			protectHeadNodes: config.protectHeadNodes,
			allowTailTrim: config.allowTailTrim,
			isBalancedBefore: (seq) => toolPairingBalancedBefore(session, seq),
			isBalancedAfter: (seq) => toolPairingBalancedAfter(session, seq)
		});
	let markerTokens = ctx.tokenMeter.estimateMessage(provisionalMarker());
	let plan = planFor(markerTokens);
	if (plan.kind !== 'span') return describeNonSpan(plan, label);
	let marker = createMarkerMessage(plan, target?.label ?? `budget ${budget}`, budget);
	const finalMarkerTokens = ctx.tokenMeter.estimateMessage(marker);
	if (finalMarkerTokens > markerTokens) {
		// The marker now carries real numbers; re-plan once so its own price is exact.
		plan = planFor(finalMarkerTokens);
		if (plan.kind !== 'span') return describeNonSpan(plan, label);
		marker = createMarkerMessage(plan, target?.label ?? `budget ${budget}`, budget);
		markerTokens = finalMarkerTokens;
	}
	if (parsed.check) return { kind: 'success', text: preview(plan, label, markerTokens) };
	const replacement = applyTrim(session, plan, marker);
	const after = ctx.tokenMeter.measure(session, header);
	return { kind: 'success', text: report(plan, after, label, markerTokens), sourceEventSeq: replacement.seq };
}

/** Refuse to rewrite a surface while a compaction bracket is open. */
function assertNoOpenCompaction(session) {
	for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
		const event = session.eventAt(seq);
		if (event === undefined) continue;
		if (event.type === 'compaction/end') return;
		// A seed boundary proves any earlier unmatched start belongs to a previous lifecycle.
		if (event.type === 'session/end-seed') return;
		if (event.type === 'compaction/start') {
			throw new Error('a compaction is already in progress in this session; wait for it to finish, then retry');
		}
	}
}

/** Render every non-span outcome as a final command result. */
function describeNonSpan(plan, label) {
	switch (plan.kind) {
		case 'fits':
			return {
				kind: 'success',
				text: `Already within budget: ~${plan.totalTokens} / ${plan.budget} tokens for ${label}. Nothing to trim.`
			};
		case 'envelope':
			return {
				kind: 'error',
				text: [
					`Fixed request overhead alone (~${plan.envelopeTokens} tokens of system prompt and tool schemas) exceeds the ${plan.budget}-token budget for ${label}.`,
					'Trimming conversation history cannot help: raise the backend context size (the model\'s contextWindow in settings.yaml, or the server\'s context flag) or reduce mounted tools and skills, then retry.'
				].join('\n')
			};
		case 'no-span':
			return {
				kind: 'error',
				text: `Nothing safely trimmable for ${label}: ${plan.reason}, or no tool-pairing balanced cut exists.`
			};
		case 'insufficient':
			return {
				kind: 'error',
				text: [
					`Cannot free enough for ${label}: the largest balanced span frees ~${plan.maxFreeable} of the ~${plan.need} tokens needed.`,
					`Protected content: task statement ~${plan.protectedHeadTokens} tokens, recent tail ~${plan.protectedTailTokens} tokens (retain target ~${plan.retainTokens}).`,
					'Try /compact (it summarizes instead of dropping), a larger window, or /trim with an explicit budget after another reduction.'
				].join('\n')
			};
		default:
			return { kind: 'error', text: `Trim could not plan a reduction (${String(plan.kind)}).` };
	}
}

/** Render a dry run. */
function preview(plan, label, markerTokens) {
	return [
		`Would trim ${plan.shadowedSeqs.length} messages (seqs ${plan.startSeq}-${plan.endSeq}, ~${plan.shadowedTokens} tokens → ${markerTokens}-token marker) for ${label}.`,
		`Request size: ~${plan.totalTokens} → ~${plan.projectedTotal} tokens (target ${plan.budget}). Nothing was changed.`
	].join('\n');
}

/** Render a committed trim against the re-measured request. */
function report(plan, after, label, markerTokens) {
	const lines = [
		`Trimmed ${plan.shadowedSeqs.length} messages (seqs ${plan.startSeq}-${plan.endSeq}, ~${plan.shadowedTokens} tokens → ${markerTokens}-token marker) for ${label}.`,
		`Request size: ~${plan.totalTokens} → ~${after.totalTokens} tokens (target ${plan.budget}).`
	];
	if (plan.relaxedRetention) {
		lines.push(`Retention relaxed to ~${plan.retainTokens} tokens to reach the budget.`);
	}
	return lines.join('\n');
}

/** Render a thrown value without trusting its string coercion. */
function describeError(error) {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return '<unrenderable thrown value>';
	}
}
