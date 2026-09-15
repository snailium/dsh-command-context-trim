/**
 * Version tolerance for the harness's positional replacement marker.
 *
 * DeepSeek Harness renamed the surface-replacement keys in 0.1.5
 * (`{op:'replace', start, end}` → `{op:'replace', startSeq, endSeq}`), and the
 * session rejects any other shape at append time. Rather than parse a version
 * string, the accepted shape is probed once against the harness actually
 * installed: a throwaway detached session appends one replacement with each
 * candidate and reports the first accepted.
 *
 * @module dsh-command-context-trim/session-compat
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session } from '@deepseek-ai/dsh-session';

/** Candidate key sets, newest harness first. */
const CANDIDATES = Object.freeze([
	Object.freeze({ start: 'startSeq', end: 'endSeq' }),
	Object.freeze({ start: 'start', end: 'end' })
]);

/** Cached probe result for the installed harness. */
let cached;

/**
 * The replacement-marker keys this harness accepts.
 * @returns `{ start, end }` key names.
 * @throws when the harness accepts none of the known shapes.
 */
export function replaceKeys() {
	cached ??= detectReplaceKeys();
	return cached;
}

/**
 * Probe every known marker shape against a detached session.
 * @returns the first accepted key set.
 * @throws when no known shape is accepted.
 */
export function detectReplaceKeys() {
	for (const candidate of CANDIDATES) {
		if (acceptsReplacement(candidate)) return candidate;
	}
	throw new Error(
		'context-trim: this harness build accepts neither the 0.1.5+ nor the legacy positional replacement marker; ' +
			'report it with the installed @deepseek-ai/dsh-session version'
	);
}

/**
 * Build the positional replacement marker in the harness's own key spelling.
 * @param keys - key set returned by {@link replaceKeys}.
 * @param startSeq - inclusive first shadowed surface seq.
 * @param endSeq - inclusive last shadowed surface seq.
 * @returns the marker to pass as `surfaceOp`.
 */
export function replacementOp(keys, startSeq, endSeq) {
	return { op: 'replace', [keys.start]: startSeq, [keys.end]: endSeq };
}

/** Whether one detached session accepts a replacement written with these keys. */
function acceptsReplacement(keys) {
	try {
		const session = Session.create('context-trim-probe');
		session.append('user/message', probeMessage('probe first'), { surfaceOp: 'append' });
		session.append('user/message', probeMessage('probe second'), { surfaceOp: 'append' });
		session.append('user/message', probeMessage('probe marker'), {
			surfaceOp: replacementOp(keys, 1, 1),
			sourceEventSeqs: [1]
		});
		return true;
	} catch {
		return false;
	}
}

/** One frozen probe message; detached sessions never publish it. */
function probeMessage(text) {
	return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'context-trim-probe' } });
}
