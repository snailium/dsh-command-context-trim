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
import { CALIBRATION_MIN_FACTOR, estimateEnvelopeTokens, realTokens } from './calibration.js';
import { factorForTrim, headerRouteKey } from './calibrate-runtime.js';
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
	const pricer = requestPricer(ctx, session, header);
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
			if (pricer.view(afterPrune).totalTokens <= budget) {
				return {
					result: {
						kind: 'success',
						text: `Slimmed ${shrunk.pruned} oversized tool result(s) in place for ${label}: ~${pricer.view(measurement).totalTokens} → ~${pricer.view(afterPrune).totalTokens} tokens (target ${budget}).`,
						...(shrunk.replacementSeq === undefined ? {} : { sourceEventSeq: shrunk.replacementSeq })
					},
					label,
					before: measurement,
					after: afterPrune,
					totals: { before: pricer.view(measurement).totalTokens, after: pricer.view(afterPrune).totalTokens },
					pruned: shrunk
				};
			}
			measurement = afterPrune;
		}
	}
	const priced = pricer.view(measurement);
	const nodes = priced.nodes;
	const envelopeTokens = priced.envelopeTokens;
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
	if (plan.kind !== 'span') {
		return {
			result: notePrune(describeNonSpan(plan, label)),
			plan,
			label,
			before: measurement,
			totals: { before: pricer.view(measurement).totalTokens, after: pricer.view(measurement).totalTokens },
			...(pruned === undefined ? {} : { pruned })
		};
	}
	let marker = createMarkerMessage(plan, target?.label ?? `budget ${budget}`, budget);
	const finalMarkerTokens = ctx.tokenMeter.estimateMessage(marker);
	if (finalMarkerTokens > markerTokens) {
		// The marker now carries real numbers; re-plan once so its own price is exact.
		plan = planFor(finalMarkerTokens);
		if (plan.kind !== 'span') {
			return {
				result: notePrune(describeNonSpan(plan, label)),
				plan,
				label,
				before: measurement,
				totals: { before: pricer.view(measurement).totalTokens, after: pricer.view(measurement).totalTokens },
				...(pruned === undefined ? {} : { pruned })
			};
		}
		marker = createMarkerMessage(plan, target?.label ?? `budget ${budget}`, budget);
		markerTokens = finalMarkerTokens;
	}
	if (check) {
		return {
			result: { kind: 'success', text: preview(plan, label, markerTokens) },
			plan,
			label,
			before: measurement,
			totals: { before: pricer.view(measurement).totalTokens, after: pricer.view(measurement).totalTokens },
			...(pruned === undefined ? {} : { pruned })
		};
	}
	const replacement = applyTrim(session, plan, marker, replaceKeys());
	const after = ctx.tokenMeter.measure(session, header);
	return {
		result: { kind: 'success', text: report(plan, pricer.view(after).totalTokens, label, markerTokens), sourceEventSeq: replacement.seq },
		plan,
		label,
		before: measurement,
		after,
		totals: { before: pricer.view(measurement).totalTokens, after: pricer.view(after).totalTokens },
		markerTokens,
		replacement,
		...(pruned === undefined ? {} : { pruned })
	};
}

/**
 * Build the real-token pricing of a session's request.
 *
 * The token meter prices content at a fixed density of four characters per token. A real
 * session is denser than that, so the meter's estimate is smaller than what the provider
 * is actually sent — and the planner needs the two in one unit, because it compares the
 * tokens it *needs* to free against the tokens a span *would* free. This pricer converts
 * both sides at once, with the route's calibration factor.
 *
 * The request envelope is priced on its own terms — the tool schemas' own price — rather
 * than as the difference between the meter's total and its surface. That difference only
 * equals the envelope while the meter estimates everything; once the meter has adopted
 * the provider's real usage as its baseline, the difference is the gap between the real
 * and the estimated surface, and charging it as the envelope would inflate the very
 * request the trim is trying to fit.
 *
 * The density is the larger of two sources. The learned one is the route's calibration
 * factor, measured over recent requests. The implied one is the density the token meter
 * itself reports for this request, once it has adopted the provider's usage: its total is
 * then in real tokens while the node prices stay heuristic, and the ratio between the two
 * is a measurement of the same request. The implied one keeps an uncalibrated route from
 * being priced below what the provider already charged for it, which is the difference
 * between trimming a request that no longer fits and reporting that it fits.
 *
 * @param ctx - plugin context (token meter).
 * @param session - session to price.
 * @param header - the request header the price is computed against; the session's own
 *   logged header is used when absent.
 * @returns the pricer: `factor` (the learned one) and `view(measurement)`.
 */
export function requestPricer(ctx, session, header) {
	const learned = factorForTrim(ctx, headerRouteKey(header), headerRouteKey(session.requestHeader()));
	const envelopeHeuristic = estimateEnvelopeTokens(header ?? session.requestHeader());
	/**
	 * The density the token meter itself implies for this request.
	 *
	 * Once the meter has adopted the provider's own usage as its baseline, its total is
	 * in real tokens while the per-node prices stay heuristic. The ratio between the two
	 * is a density measured on a real request — at least as trustworthy as anything
	 * learned from earlier requests, and available on routes that have no samples yet.
	 *
	 * The ratio is taken at the anchor, not at the current surface: the anchor's request
	 * is the one the provider counted, and a trim changes the current surface without
	 * changing what the provider was sent. It is never below one, because the meter only
	 * adopts a usage that is at least its own estimate.
	 *
	 * @param measurement - a token-meter measurement.
	 * @returns the implied density, or one when the meter still estimates everything.
	 */
	const impliedFactor = (measurement) => {
		if (measurement.baseline?.kind !== 'usage') return 1;
		const anchorSurface = measurement.surfaceTokens - (measurement.surfaceDeltaTokens ?? 0);
		const heuristicTotal = anchorSurface + envelopeHeuristic;
		if (heuristicTotal <= 0) return 1;
		return Math.max(CALIBRATION_MIN_FACTOR, measurement.baseline.tokens / heuristicTotal);
	};
	/**
	 * Price one measurement in real tokens.
	 * @param measurement - a token-meter measurement.
	 * @returns the priced surface, the envelope, the request total, and the factor used.
	 */
	const view = (measurement) => {
		const factor = Math.max(learned, impliedFactor(measurement));
		const envelopeTokens = realTokens(envelopeHeuristic, factor);
		const nodes = measurement.nodes.map((node) => {
			const type = session.eventAt(node.seq)?.type;
			return {
				seq: node.seq,
				heuristicTokens: realTokens(node.heuristicTokens, factor),
				// Harness 0.1.5+ carries the system prompt as surface node 0. It is never
				// elidable, and no elided span may cross it: dropping it would strip the
				// model's instructions, and letting it consume head protection would expose
				// the user's original request instead.
				...(type === 'system/message' ? { barrier: true } : {}),
				// The newest human prompt is the anchor the planner must never elide.
				...(type === 'user/message' ? { userMessage: true } : {})
			};
		});
		const surfaceTokens = nodes.reduce((total, node) => total + node.heuristicTokens, 0);
		return { nodes, surfaceTokens, envelopeTokens, totalTokens: surfaceTokens + envelopeTokens, factor };
	};
	return { factor: learned, view };
}

/**
 * The size of a session's current request in real tokens.
 *
 * Used by the automatic overflow path, whose shrink ladder has to aim at a target the
 * backend will accept: a ceiling derived from the meter's estimate would be a ceiling on
 * a number the backend never saw.
 *
 * @param ctx - plugin context (token meter).
 * @param session - session to measure.
 * @returns the request size in real tokens.
 */
export function calibratedRequestTotal(ctx, session) {
	const pricer = requestPricer(ctx, session, session.requestHeader());
	return pricer.view(ctx.tokenMeter.measure(session)).totalTokens;
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
