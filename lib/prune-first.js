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
 * Tool-result messages changed shape in harness 0.1.7: up to 0.1.5 the content was a
 * single `tool-result` wrapper block, from 0.1.7 the blocks sit directly on the message
 * (`{role:'tool', toolCallId, content:[…]}`). Both branches are read and rebuilt here,
 * and the message is taken from `session.deriveEventMessage()` when the session offers
 * it (which is what the official pruner uses from 0.1.7 on).
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
		const original = surfaceMessage(session, event);
		const blocks = resultBlocks(original);
		// An unrecognised shape is skipped rather than thrown: this path must never be
		// the reason an overflow recovery is abandoned.
		if (!Array.isArray(blocks)) continue;
		const content = pruneContent(blocks, config);
		if (content === null) continue;
		const message = withResultBlocks(original, content);
		session.append('compaction/prune', {
			shadowedRange: { start: seq, end: seq },
			shadowedSeqs: [seq],
			shadowedTokenCount: ctx.tokenMeter.estimateMessage(original)
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
 * The message a surface node contributes, derived the way the harness exposes it.
 * Sessions grew a `deriveEventMessage` method in 0.1.7 (the official pruner uses it);
 * older versions expose the same message on the event payload.
 * @param session - session owning the event.
 * @param event - the surface event.
 * @returns the derived message.
 */
function surfaceMessage(session, event) {
	return typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : event.data.message;
}

/**
 * The tool-result content blocks, whichever message shape the harness uses.
 * @param message - derived tool-result message.
 * @returns the block array, or `undefined` for an unrecognised shape.
 */
function resultBlocks(message) {
	const first = message?.content?.[0];
	if (first?.type === 'tool-result') return first.content;
	return Array.isArray(message?.content) ? message.content : undefined;
}

/**
 * Rebuild a tool-result message around rewritten blocks, preserving its shape.
 * @param message - the derived message that was pruned.
 * @param blocks - rewritten content blocks.
 * @returns a frozen replacement message.
 */
function withResultBlocks(message, blocks) {
	const first = message.content[0];
	return first?.type === 'tool-result'
		? freezeMessage({ ...message, content: [{ ...first, content: blocks }] })
		: freezeMessage({ ...message, content: blocks });
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
