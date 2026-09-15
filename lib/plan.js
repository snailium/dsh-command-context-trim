/**
 * Pure trim planning.
 *
 * The policy is *oldest-first, least-long-possible*: the elided span starts at
 * the oldest cut that keeps every tool-call/result pair intact, and grows only
 * until it frees exactly enough tokens. The task statement (leading nodes) and
 * the most recent messages are protected, because for a coding agent recency
 * and the original request are the two pieces of high-value context; everything
 * between them is what a smaller window can afford to lose.
 *
 * Nothing here touches a session: the planner receives measured node prices and
 * two balance predicates, so every branch is directly testable.
 *
 * @module dsh-command-context-trim/plan
 */

/**
 * @typedef {object} TrimNode
 * @property {number} seq - surface event sequence of the node.
 * @property {number} heuristicTokens - the token meter's heuristic price for it.
 */

/**
 * @typedef {object} TrimPlanInput
 * @property {readonly TrimNode[]} nodes - current surface nodes in model-visible order.
 * @property {number} envelopeTokens - non-surface request price (system prompt + tool schemas).
 * @property {number} budget - target total request size in tokens.
 * @property {number} markerCost - priced replacement marker, including configured slack.
 * @property {number} retainTokens - preferred verbatim recent-tail budget.
 * @property {number} minTailTokens - absolute floor for that retained tail.
 * @property {number} protectHeadNodes - leading nodes that must never be elided.
 * @property {boolean} allowTailTrim - whether the elided span may reach into the retained tail.
 * @property {(seq: number) => boolean} isBalancedBefore - tool-pairing balance before a node.
 * @property {(seq: number) => boolean} isBalancedAfter - tool-pairing balance after a node.
 */

/**
 * Plan one model-free trim.
 * @param input - measured surface, budgets, and balance predicates.
 * @returns a plan: `fits`, `envelope`, `no-span`, `insufficient`, or `span`.
 */
export function planTrim(input) {
	const surfaceTokens = input.nodes.reduce((total, node) => total + node.heuristicTokens, 0);
	const common = {
		totalTokens: input.envelopeTokens + surfaceTokens,
		surfaceTokens,
		envelopeTokens: input.envelopeTokens,
		budget: input.budget
	};
	if (common.totalTokens <= input.budget) return { kind: 'fits', ...common };
	if (input.envelopeTokens >= input.budget) return { kind: 'envelope', ...common };
	if (input.nodes.length < 2) {
		return { kind: 'no-span', ...common, reason: 'the conversation surface holds fewer than two messages' };
	}
	const need = common.totalTokens - input.budget;
	const configuredRetention = input.retainTokens;
	let weakest = null;
	for (const retainTokens of retentionLadder(configuredRetention, input.minTailTokens)) {
		const attempt = attemptSpan({ ...input, retainTokens, need });
		if (attempt.kind === 'span') {
			return {
				kind: 'span',
				...common,
				...attempt,
				need,
				retainTokens,
				relaxedRetention: retainTokens < configuredRetention,
				projectedTotal: common.totalTokens - attempt.freedTokens
			};
		}
		if (weakest === null || attempt.maxFreeable > weakest.maxFreeable) weakest = { ...attempt, retainTokens };
	}
	return {
		kind: 'insufficient',
		...common,
		need,
		maxFreeable: weakest?.maxFreeable ?? 0,
		protectedHeadTokens: headTokens(input.nodes, input.protectHeadNodes),
		protectedTailTokens: weakest?.protectedTailTokens ?? 0,
		retainTokens: configuredRetention
	};
}

/**
 * Try one retention budget, returning the smallest oldest-anchored balanced span
 * that frees at least `need` tokens.
 * @param input - planning input plus the retention budget under test.
 * @returns a `span` plan, or the `shortfall` diagnostics for this retention.
 */
function attemptSpan(input) {
	const nodes = input.nodes;
	const tailStart = tailStartIndex(nodes, input.retainTokens);
	const lastElidable = input.allowTailTrim ? nodes.length - 2 : Math.min(nodes.length - 2, tailStart - 1);
	const shortfall = (maxFreeable) => ({
		kind: 'shortfall',
		maxFreeable,
		protectedTailTokens: tailTokens(nodes, tailStart),
		protectedHeadTokens: headTokens(nodes, input.protectHeadNodes)
	});
	const from = Math.min(input.protectHeadNodes, nodes.length - 1);
	if (lastElidable < from) return shortfall(0);
	let start = -1;
	for (let index = from; index <= lastElidable; index += 1) {
		if (input.isBalancedBefore(nodes[index].seq)) {
			start = index;
			break;
		}
	}
	if (start === -1) return shortfall(0);
	let accumulated = 0;
	let best = null;
	for (let index = start; index <= lastElidable; index += 1) {
		accumulated += nodes[index].heuristicTokens;
		if (!input.isBalancedAfter(nodes[index].seq)) continue;
		const freedTokens = accumulated - input.markerCost;
		if (best === null || freedTokens > best.freedTokens) {
			best = {
				startIndex: start,
				endIndex: index,
				startSeq: nodes[start].seq,
				endSeq: nodes[index].seq,
				shadowedSeqs: nodes.slice(start, index + 1).map((node) => node.seq),
				shadowedTokens: accumulated,
				freedTokens
			};
		}
		if (freedTokens >= input.need) break;
	}
	return best === null ? shortfall(0) : best.freedTokens >= input.need
		? { kind: 'span', ...best }
		: shortfall(best.freedTokens);
}

/**
 * Descending retention budgets to try: the configured one first, then half of
 * it, then the configured floor. A trim exists to keep the session usable, so a
 * configured tail that makes the fit impossible is relaxed rather than obeyed —
 * and the result reports that it happened.
 * @param configured - preferred verbatim recent-tail budget.
 * @param floor - absolute minimum retained tail.
 * @returns distinct retention budgets, strongest first.
 */
function retentionLadder(configured, floor) {
	const candidates = [configured, Math.max(floor, Math.floor(configured / 2)), floor];
	return [...new Set(candidates.filter((value) => value >= 0 && value <= configured))];
}

/** Index of the first node retained verbatim for one tail budget. */
function tailStartIndex(nodes, retainTokens) {
	let accumulated = 0;
	for (let index = nodes.length - 1; index >= 0; index -= 1) {
		accumulated += nodes[index].heuristicTokens;
		if (accumulated >= retainTokens) return index;
	}
	return 0;
}

/** Tokens held by the nodes from `tailStart` to the end. */
function tailTokens(nodes, tailStart) {
	let total = 0;
	for (let index = tailStart; index < nodes.length; index += 1) total += nodes[index].heuristicTokens;
	return total;
}

/** Tokens held by the protected leading nodes. */
function headTokens(nodes, protectHeadNodes) {
	let total = 0;
	for (let index = 0; index < Math.min(protectHeadNodes, nodes.length); index += 1) total += nodes[index].heuristicTokens;
	return total;
}
