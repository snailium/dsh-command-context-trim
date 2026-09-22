/**
 * In-place tool-result slimming, run **before** any span elision.
 *
 * DSH already owns this idea (`@deepseek-ai/dsh-compaction-tool-result-pruner`),
 * but a host-plane plugin can only reach that service where compaction itself is
 * mounted on the host plane. In a 0.1.5 web profile the host row is disabled and
 * the pruner is re-mounted inside an agent-preset isolate realm, where
 * `ctx.get('toolResultPruner')` resolves nothing. So this module prefers the
 * official service when it is visible and otherwise performs the same transform
 * itself, which keeps the cheap reduction ahead of the expensive one:
 *
 *   slim oversized tool results in place  →  elide a whole span  →  compaction
 *
 * The transform mirrors the official one: text is measured and sliced in Unicode
 * code points (never splitting a surrogate pair), the head and tail are kept, one
 * marker replaces the removed middle, non-text blocks keep their order, and the
 * replacement carries the complete original event data except `content` — so the
 * tool call keeps its result and the step stays intact.
 *
 * A `tool/result` replacement is only legal inside an open turn, which is exactly
 * the state the automatic overflow path runs in; the idle `/trim` command never
 * uses this module.
 *
 * @module dsh-command-context-trim/prune-first
 */
import { freezeMessage } from '@deepseek-ai/dsh-llm';
import { replaceKeys, replacementOp } from './session-compat.js';

/**
 * Marker replacing the removed middle. Deliberately worded for the model and
 * distinct from DSH's own `[... tool result middle pruned ...]`, so a session log
 * shows which producer slimmed a node.
 */
export const TRIM_MARKER = '\n\n[... tool result middle trimmed to fit the context window ...]\n\n';

/**
 * Slim every over-budget tool result on the current surface.
 * @param ctx - plugin context; `ctx.get('toolResultPruner')` is used when present.
 * @param session - session whose surface is rewritten.
 * @param config - resolved configuration.
 * @returns `{ pruned, via, replacementSeq }`; `pruned` is the number of nodes rewritten.
 */
export function shrinkOversizedToolResults(ctx, session, config) {
	if (config.preferInPlacePrune !== true) return { pruned: 0, via: 'disabled' };
	const official = ctx.get?.('toolResultPruner');
	if (official !== undefined && typeof official.pruneSession === 'function') {
		const outcome = official.pruneSession(session);
		const pruned = Array.isArray(outcome?.pruned) ? outcome.pruned.length : 0;
		return { pruned, via: 'service', replacementSeq: outcome?.pruned?.at(-1)?.replacementSeq };
	}
	const keys = replaceKeys();
	let pruned = 0;
	let replacementSeq;
	// Snapshot first: replacements are appended while iterating.
	for (const seq of [...session.surface.nodes]) {
		const event = session.eventAt(seq);
		if (event?.type !== 'tool/result') continue;
		const result = event.data.message.content[0];
		const content = pruneContent(result.content, config);
		if (content === null) continue;
		const message = freezeMessage({
			...event.data.message,
			content: [{ ...result, content }]
		});
		session.append('compaction/prune', {
			shadowedRange: { start: seq, end: seq },
			shadowedSeqs: [seq],
			shadowedTokenCount: ctx.tokenMeter.estimateMessage(event.data.message)
		});
		const replacement = session.append('tool/result', { ...event.data, message }, {
			surfaceOp: replacementOp(keys, seq, seq),
			sourceEventSeqs: [seq]
		});
		pruned += 1;
		replacementSeq = replacement.seq;
	}
	return { pruned, via: 'inline', ...(replacementSeq === undefined ? {} : { replacementSeq }) };
}

/**
 * Measure tool-result text in Unicode code points; non-text blocks cost zero.
 * @param blocks - tool-result content blocks.
 * @returns total code points across text blocks.
 */
export function measureContent(blocks) {
	let chars = 0;
	for (const block of blocks) if (block.type === 'text') chars += codePointLength(block.text);
	return chars;
}

/**
 * Replace an over-budget text middle while retaining rich-block order.
 * @param blocks - original tool-result content.
 * @param config - resolved configuration with the character budgets.
 * @returns rewritten content, or `null` when the text is already within budget.
 */
export function pruneContent(blocks, config) {
	const totalChars = measureContent(blocks);
	if (totalChars <= config.pruneThresholdChars) return null;
	const removedStart = config.pruneHeadChars;
	const removedEnd = totalChars - config.pruneTailChars;
	const pruned = [];
	let consumed = 0;
	let markerInserted = false;
	for (const block of blocks) {
		if (block.type !== 'text') {
			pruned.push(block);
			continue;
		}
		const points = Array.from(block.text);
		const blockStart = consumed;
		const blockEnd = blockStart + points.length;
		const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart));
		const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart));
		const marker = blockStart < removedEnd && blockEnd > removedStart && !markerInserted ? TRIM_MARKER : '';
		if (marker.length > 0) markerInserted = true;
		const text = points.slice(0, headEnd).join('') + marker + points.slice(tailStart).join('');
		if (text.length > 0) pruned.push({ ...block, text });
		consumed = blockEnd;
	}
	if (!markerInserted) return null;
	const charsAfter = measureContent(pruned);
	// Refuse a rewrite that would not actually be smaller and within budget.
	if (charsAfter > config.pruneThresholdChars || charsAfter >= totalChars) return null;
	return pruned;
}

/** Count Unicode code points without splitting surrogate pairs. */
function codePointLength(text) {
	return Array.from(text).length;
}
