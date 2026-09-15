/**
 * `/trim` argument parsing: `[check] [<tokens>|k|m] [<provider>:<model>]`.
 *
 * Deliberately tiny and total: every rejection carries a human sentence, and
 * no argument form reaches the session mutator without being understood.
 *
 * @module dsh-command-context-trim/args
 */

/** Multipliers accepted after a numeric budget. */
const UNITS = Object.freeze({ k: 1_000, K: 1_000, m: 1_000_000, M: 1_000_000 });

/** Help text returned with every argument failure. */
export const USAGE = [
	'Usage: /trim [check] [<tokens>|k] [<provider>:<model>]',
	'  /trim                       fit the active model window',
	'  /trim check                 report the plan, change nothing',
	'  /trim 32k                   fit an explicit 32768-token budget',
	'  /trim lc:/models/qwen.gguf  fit that route\'s declared window'
].join('\n');

/**
 * Parse one `/trim` invocation.
 * @param rawInput - text after the command name, verbatim.
 * @returns `{ check, budget?, route? }`, or `{ error }` for an unrecognized form.
 */
export function parseTrimArguments(rawInput) {
	const result = { check: false };
	const fields = rawInput.trim().split(/\s+/u).filter((field) => field.length > 0);
	for (const field of fields) {
		if (field === 'check' || field === '--check' || field === '--dry-run') {
			if (result.check) return { error: 'duplicate "check"' };
			result.check = true;
			continue;
		}
		const numeric = /^(\d+(?:\.\d+)?)([kKmM])?$/u.exec(field);
		if (numeric !== null) {
			if (result.budget !== undefined) return { error: `duplicate token budget "${field}"` };
			const value = Math.floor(Number(numeric[1]) * (UNITS[numeric[2]] ?? 1));
			if (!Number.isSafeInteger(value) || value <= 0) return { error: `invalid token budget "${field}"` };
			result.budget = value;
			continue;
		}
		const route = /^([A-Za-z0-9._-]+):(.+)$/u.exec(field);
		if (route !== null) {
			if (result.route !== undefined) return { error: `duplicate target route "${field}"` };
			result.route = { provider: route[1], model: route[2] };
			continue;
		}
		return { error: `unrecognized argument "${field}"` };
	}
	return result;
}
