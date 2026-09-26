/**
 * One trim execution, shared by the `/trim` command and the automatic
 * context-overflow path.
 *
 * Everything session-visible happens here: measure the current request under the
 * target route, plan the oldest balanced span, and apply it as two synchronous
 * appends. The caller owns only *when* to invoke it (`/trim` inside an idle-agent
 * reservation, the automatic path inside a failing step) and how to render the
 * outcome.
 *
 * @module dsh-command-context-trim/trim-session
 */
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { applyTrim, createMarkerMessage, provisionalMarker } from './apply.js';
import { budgetFor, retentionFor } from './config.js';
import { planTrim } from './plan.js';
import { shrinkOversizedToolResults } from './prune-first.js';
import { describeNonSpan, preview, report } from './render.js';
import { replaceKeys } from './session-compat.js';
import { resolveTarget, targetHeader } from './target.js';

/**
 * @typedef {object} TrimRequest
 * @property {object} agent - agent owning the session to trim.
 * @property {AbortSignal} [signal] - cancellation for the whole execution.
 * @property {{ provider: string, model: string }} [requestedRoute] - explicit target route.
 * @property {number} [explicitBudget] - explicit token budget instead of a resolved window.
 * @property {boolean} [check] - plan only, mutate nothing.
 * @property {boolean} [routedOnly] - target the route the last durable request used.
 * @property {number} [budgetCeiling] - hard upper bound on the target budget, used when a
 *   request of a known size has just been rejected and the declared window cannot be trusted.
 * @property {boolean} [inPlaceFirst] - slim oversized tool results in place before planning a
 *   span. Only legal inside an open turn, so the automatic path sets it and `/trim` never does.
 * @property {boolean} [emergency] - allow the head-protected nodes to be elided as an absolute
 *   last resort. Used only after compaction has already failed to recover the turn.
 */

/**
 * Execute one trim.
 * @param ctx - plugin context (token meter, LLM service).
 * @param config - resolved configuration.
 * @param request - what to trim and how far.
 * @returns `{ result, plan?, label?, before?, after?, replacement?, markerTokens? }`;
 *   `result` is a command result, and `replacement` is present only when the
 *   surface was actually rewritten.
 */
export async function executeTrim(ctx, config, request) {
	const { agent, signal, requestedRoute, explicitBudget, check = false, routedOnly = false, budgetCeiling, inPlaceFirst = false, emergency = false } = request;
	signal?.throwIfAborted?.();
	const session = agent.session;
	assertNoOpenCompaction(session);
	const target =
		explicitBudget === undefined ? await resolveTarget(ctx, agent, requestedRoute, signal, { routedOnly }) : undefined;
	const windowBudget = explicitBudget ?? budgetFor(target.contextWindow, config);
	const budget = budgetCeiling === undefined ? windowBudget : Math.min(windowBudget, budgetCeiling);
	const baseLabel = target === undefined ? `an explicit ${budget}-token budget` : `${target.label} (window ${target.contextWindow})`;
	const label = budget === windowBudget ? baseLabel : `${baseLabel}, capped at ${budget}`;
	const header = target === undefined ? undefined : targetHeader(session, target);
	let measurement = ctx.tokenMeter.measure(session, header);
	// Cheap reduction first: a single oversized tool result is slimmed in place
	// (keeping the node, its tool call and the prefix up to it) and a span is only
	// elided when that is not enough.
	let pruned;
	if (inPlaceFirst) {
		const shrunk = shrinkOversizedToolResults(ctx, session, config);
		if (shrunk.pruned > 0) {
			const afterPrune = ctx.tokenMeter.measure(session, header);
			pruned = shrunk;
			if (afterPrune.totalTokens <= budget) {
				return {
					result: {
						kind: 'success',
						text: `Slimmed ${shrunk.pruned} oversized tool result(s) in place for ${label}: ~${measurement.totalTokens} → ~${afterPrune.totalTokens} tokens (target ${budget}).`,
						...(shrunk.replacementSeq === undefined ? {} : { sourceEventSeq: shrunk.replacementSeq })
					},
					label,
					before: measurement,
					after: afterPrune,
					pruned: shrunk
				};
			}
			measurement = afterPrune;
		}
	}
	const nodes = measurement.nodes.map((node) => {
		const type = session.eventAt(node.seq)?.type;
		return {
			seq: node.seq,
			heuristicTokens: node.heuristicTokens,
			// Harness 0.1.5+ carries the system prompt as surface node 0. It is never
			// elidable, and no elided span may cross it: dropping it would strip the
			// model's instructions, and letting it consume head protection would expose
			// the user's original request instead.
			...(type === 'system/message' ? { barrier: true } : {}),
			// The newest human prompt is the anchor the planner must never elide.
			...(type === 'user/message' ? { userMessage: true } : {})
		};
	});
	if (nodes.length === 0) {
		return { result: { kind: 'success', text: `Nothing to trim: ${session.id} has no model-visible messages yet.` } };
	}
	const notePrune = (result) =>
		pruned === undefined
			? result
			: { ...result, text: `${result.text}\n(Note: ${pruned.pruned} oversized tool result(s) were already slimmed in place.)` };
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
			emergency,
			isBalancedBefore: (seq) => toolPairingBalancedBefore(session, seq),
			isBalancedAfter: (seq) => toolPairingBalancedAfter(session, seq)
		});
	let markerTokens = ctx.tokenMeter.estimateMessage(provisionalMarker());
	let plan = planFor(markerTokens);
	if (plan.kind !== 'span') return { result: notePrune(describeNonSpan(plan, label)), plan, label, before: measurement, ...(pruned === undefined ? {} : { pruned }) };
	let marker = createMarkerMessage(plan, target?.label ?? `budget ${budget}`, budget);
	const finalMarkerTokens = ctx.tokenMeter.estimateMessage(marker);
	if (finalMarkerTokens > markerTokens) {
		// The marker now carries real numbers; re-plan once so its own price is exact.
		plan = planFor(finalMarkerTokens);
		if (plan.kind !== 'span') return { result: notePrune(describeNonSpan(plan, label)), plan, label, before: measurement, ...(pruned === undefined ? {} : { pruned }) };
		marker = createMarkerMessage(plan, target?.label ?? `budget ${budget}`, budget);
		markerTokens = finalMarkerTokens;
	}
	if (check) {
		return { result: { kind: 'success', text: preview(plan, label, markerTokens) }, plan, label, before: measurement, ...(pruned === undefined ? {} : { pruned }) };
	}
	const replacement = applyTrim(session, plan, marker, replaceKeys());
	const after = ctx.tokenMeter.measure(session, header);
	return {
		result: { kind: 'success', text: report(plan, after, label, markerTokens), sourceEventSeq: replacement.seq },
		plan,
		label,
		before: measurement,
		after,
		markerTokens,
		replacement,
		...(pruned === undefined ? {} : { pruned })
	};
}

/**
 * Refuse to rewrite a surface while a compaction bracket is open.
 * @param session - session whose log is inspected.
 * @throws when an unmatched `compaction/start` is open in the current lifecycle.
 */
export function assertNoOpenCompaction(session) {
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
