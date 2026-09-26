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
	'  /trim lc:/models/qwen.gguf  fit that route\'s declared window',
	'  /trim preset                generate a compaction-tuned preset from the configured routes',
	'  /trim preset check          show the generated preset, write nothing',
	'  /trim preset list           list the routes a generated preset would cover',
	'  /trim preset p:m             generate, using p:m as the summarization route'
].join('\n');

/**
 * Parse one `/trim` invocation.
 * @param rawInput - text after the command name, verbatim.
 * @returns `{ check, budget?, route? }`, or `{ error }` for an unrecognized form.
 */
export function parseTrimArguments(rawInput) {
	const result = { check: false };
	const fields = rawInput.trim().split(/\s+/u).filter((field) => field.length > 0);
	const isPreset = fields[0] === 'preset';
	if (isPreset) result.preset = true;
	for (const field of isPreset ? fields.slice(1) : fields) {
		if (field === 'list' || field === '--list') {
			if (!isPreset) return { error: '"list" is only meaningful for /trim preset' };
			if (result.list === true) return { error: 'duplicate "list"' };
			result.list = true;
			continue;
		}
		if (field === 'check' || field === '--check' || field === '--dry-run') {
			if (result.check) return { error: 'duplicate "check"' };
			result.check = true;
			continue;
		}
		const numeric = /^(\d+(?:\.\d+)?)([kKmM])?$/u.exec(field);
		if (numeric !== null) {
			if (isPreset) {
				return { error: `"${field}" has no meaning for /trim preset: the generated trigger is compactionTargetRatio` } ;
			}
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
