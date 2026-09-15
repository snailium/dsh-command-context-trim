/**
 * Surface mutation for one trim.
 *
 * Two synchronously adjacent appends do the whole job:
 *
 * 1. `compaction/prune` — the token meter's shadow-price claim. The meter's
 *    persisted projections are O(1) (they cannot re-price a replaced range), so
 *    a replacement must be preceded by an event stating the exact price of the
 *    range it shadows. Without it the fold records a zero delta and the reported
 *    context occupancy drifts from reality.
 * 2. `user/message` with a positional replace — the replacement itself. It is
 *    model-only: the human transcript reads append-origin events, so nothing the
 *    user already saw is rewritten, and the full original content stays in the
 *    durable session log.
 *
 * A `user/message` is the only surface-eligible event an idle command may
 * append: `assistant/message` requires an open step and a `tool/result`
 * replacement requires an open turn, so a trim performed between turns — which
 * is exactly when a user needs one — has no other legal node type.
 *
 * @module dsh-command-context-trim/apply
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** Plugin name written into every replacement message's source marker. */
export const TRIM_PLUGIN = 'dsh-command-context-trim';

/** Provenance frozen into every replacement message. */
const TRIM_SOURCE = Object.freeze({ kind: 'plugin', plugin: TRIM_PLUGIN });

/** Framing used to price a marker before the plan's exact numbers are known. */
const PROVISIONAL_MARKER =
	'[context-trim] an earlier span of this conversation was removed from this request to fit the model context window. ' +
	'The task statement and the most recent messages are unchanged: continue the current task directly.';

/**
 * Build the provisional marker, whose price seeds planning.
 * @returns a frozen user message used only for measurement.
 */
export function provisionalMarker() {
	return createUserMessage({
		content: [{ type: 'text', text: PROVISIONAL_MARKER }],
		source: TRIM_SOURCE
	});
}

/**
 * Build the replacement message describing one committed trim.
 * @param plan - the committed span plan.
 * @param label - human label of the target route.
 * @param budget - target request size in tokens.
 * @returns the frozen replacement user message.
 */
export function createMarkerMessage(plan, label, budget) {
	return createUserMessage({
		content: [
			{
				type: 'text',
				text:
					`[context-trim] ${plan.shadowedSeqs.length} earlier messages (~${plan.shadowedTokens} tokens) were removed ` +
					`from this request to fit the ${label} context window (target ${budget} tokens). ` +
					'The task statement and the most recent messages are unchanged: continue the current task directly, ' +
					'and ask the user or re-read a file when a removed detail is needed.'
			}
		],
		source: TRIM_SOURCE
	});
}

/**
 * Whether one message source identifies a context-trim replacement.
 * @param source - message source restored from a surface node.
 * @returns true when the source carries this plugin's marker.
 */
export function isTrimMarkerSource(source) {
	return source?.kind === 'plugin' && source.plugin === TRIM_PLUGIN;
}

/**
 * Apply one committed plan to a session surface.
 * @param session - session whose surface is rewritten.
 * @param plan - committed span plan naming the shadowed range.
 * @param marker - replacement message built for that plan.
 * @returns the appended replacement event.
 * @throws when the session rejects the append (surface contract violation).
 */
export function applyTrim(session, plan, marker) {
	session.append('compaction/prune', {
		shadowedRange: { start: plan.startSeq, end: plan.endSeq },
		shadowedSeqs: [...plan.shadowedSeqs],
		shadowedTokenCount: plan.shadowedTokens
	});
	return session.append('user/message', marker, {
		surfaceOp: { op: 'replace', start: plan.startSeq, end: plan.endSeq },
		sourceEventSeqs: [...plan.shadowedSeqs]
	});
}
