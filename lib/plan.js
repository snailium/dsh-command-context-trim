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
 * Two node classes are never elidable:
 *
 * - **Barriers** (`barrier: true`) — the system prompt. Harness 0.1.5 moved it
 *   from the request header onto the surface as node 0, which makes it
 *   *trimmable* by position: dropping it would strip the model's instructions,
 *   and letting it consume the head-protection budget would expose the user's
 *   original request instead. Barriers are therefore untouchable and split the
 *   elidable space into regions, and `protectHeadNodes` counts only non-barrier
 *   nodes so it keeps protecting the task statement.
 * - **The newest `user/message`** — the live human instruction — plus the
 *   retained tail. An earlier rule protected the final surface node outright,
 *   which deadlocked exactly the common overflow shape: a large assistant
 *   tool-call whose tool result is the last node could not be removed as a pair,
 *   leaving only a few tokens freeable while the request stayed over the wall.
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
 * @property {boolean} [barrier] - true for a node that may never be elided and
 *   that no elided span may cross (the system prompt).
 * @property {boolean} [userMessage] - true for human prompts; the newest one is
 *   treated as a barrier so an ongoing instruction is never elided.
 */

/**
 * @typedef {object} TrimPlanInput
 * @property {readonly TrimNode[]} nodes - current surface nodes in model-visible order.
 * @property {number} envelopeTokens - non-surface request price (tool schemas and other fixed request data).
 * @property {number} budget - target total request size in tokens.
 * @property {number} markerCost - priced replacement marker, including configured slack.
 * @property {number} retainTokens - preferred verbatim recent-tail budget.
 * @property {number} minTailTokens - absolute floor for that retained tail.
 * @property {number} protectHeadNodes - leading non-barrier nodes that must never be elided.
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
		budget: input.budget,
		hasBarrier: input.nodes.some((node) => node.barrier === true)
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
		protectedHeadTokens: protectedHeadTokens(input.nodes, input.protectHeadNodes),
		protectedTailTokens: weakest?.protectedTailTokens ?? 0,
		protectedUserTokens: weakest?.protectedUserTokens ?? 0,
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
	// The newest human instruction is the anchor: it must never be elided, and no
	// span may cross it. Everything after it (typically the current step's
	// assistant/tool-result pair) stays eligible, including the final node.
	const newestUserIndex = newestUserMessageIndex(nodes);
	const lastElidable = input.allowTailTrim ? nodes.length - 1 : Math.min(nodes.length - 1, tailStart - 1);
	const shortfall = (maxFreeable) => ({
		kind: 'shortfall',
		maxFreeable,
		protectedTailTokens: tailTokens(nodes, tailStart),
		protectedHeadTokens: protectedHeadTokens(nodes, input.protectHeadNodes),
		protectedUserTokens: newestUserIndex === -1 ? 0 : nodes[newestUserIndex].heuristicTokens
	});
	const headEnd = protectedHeadEnd(nodes, input.protectHeadNodes);
	if (lastElidable < headEnd) return shortfall(0);
	let weakest = null;
	for (const region of elidableRegions(nodes, headEnd, lastElidable, newestUserIndex)) {
		const attempt = attemptRegion(nodes, region, input);
		if (attempt === null) continue;
		if (attempt.kind === 'span') return attempt;
		if (weakest === null || attempt.maxFreeable > weakest.maxFreeable) weakest = attempt;
	}
	return shortfall(weakest?.maxFreeable ?? 0);
}

/**
 * Grow the smallest balanced span from one region's oldest balanced cut.
 * @param nodes - full priced surface.
 * @param region - inclusive index range free of barriers.
 * @param input - planning input carrying `need`, `markerCost`, and the balance predicates.
 * @returns a `span` plan, or this region's best `shortfall`.
 */
function attemptRegion(nodes, region, input) {
	let start = -1;
	for (let index = region.start; index <= region.end; index += 1) {
		if (input.isBalancedBefore(nodes[index].seq)) {
			start = index;
			break;
		}
	}
	if (start === -1) return null;
	let accumulated = 0;
	let best = null;
	for (let index = start; index <= region.end; index += 1) {
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
	return best === null ? null : best.freedTokens >= input.need ? { kind: 'span', ...best } : { kind: 'shortfall', maxFreeable: best.freedTokens };
}

/** Index just past the `protectHeadNodes`-th non-barrier node. */
function protectedHeadEnd(nodes, protectHeadNodes) {
	let counted = 0;
	for (let index = 0; index < nodes.length; index += 1) {
		if (nodes[index].barrier === true) continue;
		counted += 1;
		if (counted >= protectHeadNodes) return index + 1;
	}
	return nodes.length;
}

/** Index of the newest human prompt on the surface, or -1 when there is none. */
function newestUserMessageIndex(nodes) {
	let found = -1;
	for (let index = 0; index < nodes.length; index += 1) if (nodes[index].userMessage === true) found = index;
	return found;
}

/**
 * Maximal runs of elidable indices inside `[from, to]`.
 * @param nodes - full priced surface.
 * @param from - inclusive first index to consider.
 * @param to - inclusive last index to consider.
 * @param extraBarrier - one additional index treated as a barrier (the newest user message).
 * @returns contiguous index runs a span may occupy.
 */
function elidableRegions(nodes, from, to, extraBarrier) {
	const regions = [];
	let start = null;
	for (let index = from; index <= to; index += 1) {
		if (nodes[index].barrier === true || index === extraBarrier) {
			if (start !== null) regions.push({ start, end: index - 1 });
			start = null;
			continue;
		}
		if (start === null) start = index;
	}
	if (start !== null) regions.push({ start, end: to });
	return regions;
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

/** Tokens held by the protected prefix, barriers included. */
function protectedHeadTokens(nodes, protectHeadNodes) {
	let total = 0;
	for (let index = 0; index < protectedHeadEnd(nodes, protectHeadNodes); index += 1) total += nodes[index].heuristicTokens;
	return total;
}
