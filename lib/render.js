/**
 * Command-result and log rendering, shared by the `/trim` command and the
 * automatic context-overflow path.
 *
 * @module dsh-command-context-trim/render
 */

/**
 * Render every non-span planning outcome as a final command result.
 * @param plan - the plan returned by `planTrim`.
 * @param label - human label of the target route.
 * @returns a command result.
 */
export function describeNonSpan(plan, label) {
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
					`Fixed request overhead alone (~${plan.envelopeTokens} tokens of tool schemas and other non-surface request data) exceeds the ${plan.budget}-token budget for ${label}.`,
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
					`Protected content: task statement ~${plan.protectedHeadTokens} tokens, recent tail ~${plan.protectedTailTokens} tokens (retain target ~${plan.retainTokens})${plan.hasBarrier ? ', plus the system prompt, which is never trimmed' : ''}.`,
					'Try /compact (it summarizes instead of dropping), a larger window, or /trim with an explicit budget after another reduction.'
				].join('\n')
			};
		default:
			return { kind: 'error', text: `Trim could not plan a reduction (${String(plan.kind)}).` };
	}
}

/**
 * Render a dry run.
 * @param plan - a committed span plan.
 * @param label - human label of the target route.
 * @param markerTokens - measured price of the replacement marker.
 * @returns the dry-run text.
 */
export function preview(plan, label, markerTokens) {
	return [
		`Would trim ${plan.shadowedSeqs.length} messages (seqs ${plan.startSeq}-${plan.endSeq}, ~${plan.shadowedTokens} tokens → ${markerTokens}-token marker) for ${label}.`,
		`Request size: ~${plan.totalTokens} → ~${plan.projectedTotal} tokens (target ${plan.budget}). Nothing was changed.`
	].join('\n');
}

/**
 * Render a committed trim against the re-measured request.
 * @param plan - the committed span plan.
 * @param after - post-trim measurement.
 * @param label - human label of the target route.
 * @param markerTokens - measured price of the replacement marker.
 * @returns the report text.
 */
export function report(plan, after, label, markerTokens) {
	const lines = [
		`Trimmed ${plan.shadowedSeqs.length} messages (seqs ${plan.startSeq}-${plan.endSeq}, ~${plan.shadowedTokens} tokens → ${markerTokens}-token marker) for ${label}.`,
		`Request size: ~${plan.totalTokens} → ~${after.totalTokens} tokens (target ${plan.budget}).`
	];
	if (plan.relaxedRetention) {
		lines.push(`Retention relaxed to ~${plan.retainTokens} tokens to reach the budget.`);
	}
	return lines.join('\n');
}

/**
 * Render a committed trim as one log line, for the automatic path.
 * @param plan - the committed span plan.
 * @param after - post-trim measurement.
 * @param label - human label of the target route.
 * @returns a single-line account.
 */
export function logLine(plan, after, label) {
	return (
		`freed ~${plan.freedTokens} tokens over ${plan.shadowedSeqs.length} messages (seqs ${plan.startSeq}-${plan.endSeq}) for ${label}; ` +
		`request ~${plan.totalTokens} → ~${after.totalTokens} tokens (budget ${plan.budget})`
	);
}

/**
 * Render a thrown value without trusting its string coercion.
 * @param error - the caught value (`unknown` in catch clauses).
 * @returns a printable message.
 */
export function describeError(error) {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return '<unrenderable thrown value>';
	}
}
