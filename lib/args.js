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
	"  /trim lc:/models/qwen.gguf  fit that route's declared window",
	'',
	'Compaction tuning is a separate command, /context-tune, owned by the `context-tuning` row:',
	'switch that row off and the whole command goes away. Turning it off does NOT reset presets',
	'that were already tuned — they keep the values they were given.'
].join('\n');

/** The compaction-tuning surface, on its own command so its row can own it and switch it off. */
export const TUNE_USAGE = [
	'Usage: /context-tune <preset|tune|rescue|reset> [options]',
	'  /context-tune preset [check|list|default|inplace] [<provider>:<model>]',
	"  /context-tune preset             generate a compaction-tuned preset from the configured routes",
	'  /context-tune preset check       show the generated preset, write nothing',
	'  /context-tune preset list        list the routes a generated preset would cover',
	'  /context-tune preset p:m         generate, using p:m as the summarization route',
	'  /context-tune preset default     generate, then make it the default for NEW sessions',
	'  /context-tune preset inplace     override the base preset itself (no new id, nothing to pick)',
	"  /context-tune tune [check]       retune THIS process's compaction row from the live routes",
	'  /context-tune rescue <id> [--from <donor>] [--untuned]',
	'                                  rebuild a preset that lost its compaction row',
	'  /context-tune reset [check]      list the presets this plugin tuned, and how to undo each',
	'  /context-tune reset <preset-id>  remove this plugin\'s override row for that preset, which restores',
	"                                  the preset's own definition"
].join('\n');

/**
 * Whether a parsed invocation belongs to the compaction-tuning surface.
 *
 * Both commands share one parser; this is what tells them apart. A bare `/context-tune` (no subcommand) is NOT a
 * tuning invocation, so the command can answer with its own usage instead of falling through to a trim.
 * @param result - a `parseTrimArguments` result.
 * @returns true when the invocation wants `preset`, `tune`, `rescue` or `reset`.
 */
export function isTuneInvocation(result) {
	return result?.preset === true || result?.tune === true || result?.rescue === true || result?.reset === true;
}

/**
 * Parse one `/trim` invocation.
 * @param rawInput - text after the command name, verbatim.
 * @returns `{ check, budget?, route? }`, or `{ error }` for an unrecognized form.
 */
export function parseTrimArguments(rawInput) {
	const result = { check: false };
	const fields = rawInput.trim().split(/\s+/u).filter((field) => field.length > 0);
	const isRescue = fields[0] === 'rescue';
	if (isRescue) {
		result.rescue = true;
		const rest = fields.slice(1);
		for (let index = 0; index < rest.length; index += 1) {
			const field = rest[index];
			if (field === 'check' || field === '--check' || field === '--dry-run') {
				result.check = true;
				continue;
			}
			if (field === '--untuned' || field === 'untuned') {
				result.untuned = true;
				continue;
			}
			if (field === '--from' || field === 'from') {
				const donor = rest[index + 1];
				if (donor === undefined) return { error: '"--from" needs a preset id' };
				result.donorId = donor;
				index += 1;
				continue;
			}
			if (result.missingId !== undefined) return { error: `unexpected argument "${field}"` };
			result.missingId = field;
		}
		if (result.missingId === undefined) return { error: 'usage: /trim rescue <preset-id> [--from <donor>] [--untuned]' };
		return result;
	}
	const isPreset = fields[0] === 'preset';
	const isTune = fields[0] === 'tune';
	const isReset = fields[0] === 'reset';
	if (isPreset) result.preset = true;
	if (isTune) result.tune = true;
	if (isReset) result.reset = true;
	for (const field of fields.slice(isPreset || isTune || isReset ? 1 : 0)) {
		// `reset` takes a PRESET ID, not a route. It is matched after the flag loop above, so `/context-tune reset check`
		// stays a dry run instead of reading "check" as the name of a preset.
		if (isReset && /^[A-Za-z0-9._-]+$/u.test(field) && !['check', '--check', '--dry-run', 'list', '--list'].includes(field)) {
			if (result.presetId !== undefined) return { error: `duplicate preset id "${field}"` };
			result.presetId = field;
			continue;
		}
		if (isTune && ['list', 'default', '--list', '--default', 'inplace', '--inplace'].includes(field)) {
			return { error: `"${field}" is only meaningful for /context-tune preset` };
		}
		if (field === 'default' || field === '--default') {
			if (!isPreset) return { error: '"default" is only meaningful for /context-tune preset' };
			if (result.default === true) return { error: 'duplicate "default"' };
			result.default = true;
			continue;
		}
		if (field === 'inplace' || field === '--inplace') {
			if (!isPreset) return { error: '"inplace" is only meaningful for /context-tune preset' };
			if (result.inplace === true) return { error: 'duplicate "inplace"' };
			result.inplace = true;
			continue;
		}
		if (field === 'list' || field === '--list') {
			if (!isPreset) return { error: '"list" is only meaningful for /context-tune preset' };
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
				return { error: `"${field}" has no meaning for /context-tune preset: the generated trigger is compactionTargetRatio` };
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
