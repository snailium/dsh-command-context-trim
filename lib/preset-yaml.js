/**
 * Text surgery for agent-preset patch rows.
 *
 * Why text and not a YAML round-trip: the profile patch is user-owned and carries
 * comments, `!!js` expressions and key order that a parse/emit cycle would destroy.
 * The base preset's plugin list, on the other hand, reaches us as a YAML **dump**
 * produced from already-evaluated data (`agentPresets.readDocument`), so it has a
 * regular shape we can find and edit by indentation alone.
 *
 * Everything here is pure: no dsh imports, no I/O, no YAML dependency. The shapes
 * are small and fully controlled (numbers, plain strings, one list of flat maps),
 * so a deterministic emitter is safer than pulling a parser into the plugin.
 *
 * @module dsh-command-context-trim/preset-yaml
 */

/** Marker prefix for the generated block, so a user can find and delete it. */
export const MARKER_NAMESPACE = 'dsh-command-context-trim';

/**
 * Render a `compaction-basic` config as YAML lines, including its `config:` key.
 * @param config - `{thresholdRatio, headroomTokens, maxTokens, summarizationProvider?, summarizationModel?, modelPolicies?}`.
 * @param indent - column at which the `config:` key should sit.
 * @returns lines with no trailing newline.
 */
export function renderCompactionConfig(config, indent) {
	const pad = ' '.repeat(indent);
	const inner = ' '.repeat(indent + 2);
	const lines = [`${pad}config:`];
	lines.push(`${inner}thresholdRatio: ${renderScalar(config.thresholdRatio)}`);
	lines.push(`${inner}headroomTokens: ${renderScalar(config.headroomTokens)}`);
	lines.push(`${inner}maxTokens: ${renderScalar(config.maxTokens)}`);
	if (config.summarizationProvider !== undefined) {
		lines.push(`${inner}summarizationProvider: ${renderScalar(config.summarizationProvider)}`);
		lines.push(`${inner}summarizationModel: ${renderScalar(config.summarizationModel)}`);
	}
	if (Array.isArray(config.modelPolicies) && config.modelPolicies.length > 0) {
		lines.push(`${inner}modelPolicies:`);
		for (const policy of config.modelPolicies) {
			lines.push(`${inner}  - provider: ${renderScalar(policy.provider)}`);
			lines.push(`${inner}    model: ${renderScalar(policy.model)}`);
			lines.push(`${inner}    thresholdRatio: ${renderScalar(policy.thresholdRatio)}`);
			lines.push(`${inner}    headroomTokens: ${renderScalar(policy.headroomTokens)}`);
		}
	}
	return lines;
}

/**
 * Insert or replace the `config:` block of one entry inside a dumped plugin list.
 * @param content - the dumped plugin list (`- id: …` items at a regular indent).
 * @param entryId - entry id to edit, e.g. `compaction-basic`.
 * @param config - config to render, as accepted by {@link renderCompactionConfig}.
 * @returns the edited content, or `null` when no such entry exists.
 */
export function setEntryConfig(content, entryId, config) {
	const lines = content.split('\n');
	const pattern = new RegExp(`^(\\s*)- id:\\s*${escapeRegExp(entryId)}\\s*$`, 'u');
	const start = lines.findIndex((line) => pattern.test(line));
	if (start < 0) return null;
	const entryIndent = leadingSpaces(lines[start]);
	const keyIndent = entryIndent + 2;
	let end = start + 1;
	while (end < lines.length && (isBlank(lines[end]) || leadingSpaces(lines[end]) > entryIndent)) end += 1;
	const configIndex = findKeyLine(lines, start + 1, end, keyIndent, 'config');
	const block = renderCompactionConfig(config, keyIndent);
	if (configIndex < 0) {
		lines.splice(end, 0, ...block);
	} else {
		let blockEnd = configIndex + 1;
		while (blockEnd < end && (isBlank(lines[blockEnd]) || leadingSpaces(lines[blockEnd]) > keyIndent)) blockEnd += 1;
		lines.splice(configIndex, blockEnd - configIndex, ...block);
	}
	return lines.join('\n');
}

/**
 * Encode the `plugins:` list of a preset row for the profile patch.
 * @param pluginsYaml - the dumped plugin list, starting at column 0.
 * @returns lines indented to sit under a `plugins:` key at column 8.
 */
export function indentPlugins(pluginsYaml) {
	const pad = ' '.repeat(10);
	return pluginsYaml
		.replace(/\n+$/u, '')
		.split('\n')
		.map((line) => (line.length === 0 ? '' : pad + line));
}

/**
 * Build the profile-patch block that declares one generated preset.
 * @param request - row id, preset metadata and the (already spliced) plugin list.
 * @returns the block text, without the surrounding markers.
 */
export function renderPresetRow(request) {
	const { rowId, presetId, name, description, order, pluginsYaml } = request;
	const lines = [
		'- insert:',
		`    - id: ${renderScalar(rowId)}`,
		"      name: '@deepseek-ai/dsh-agent-preset'",
		'      config:',
		`        id: ${renderScalar(presetId)}`,
		`        name: ${renderScalar(name)}`,
		`        description: ${renderScalar(description)}`,
		`        order: ${renderScalar(order)}`,
		'        plugins:',
		...indentPlugins(pluginsYaml)
	];
	return lines.join('\n');
}

/**
 * Cut the `plugins:` sequence out of a shipped preset patch and dedent it to column 0.
 *
 * A shipped preset file looks like `- insert: [ - id: preset-x / name: … / config:
 * { id, order, plugins: [ … ] } ]`, so the plugin list sits under a `plugins:` key at
 * a fixed indent; this returns exactly what `agentPresets.readDocument()` would dump,
 * which is the input {@link setEntryConfig} expects.
 * @param text - the whole preset patch file.
 * @returns the plugin list at column 0, or `null` when the file has no plugin list.
 */
export function extractPluginsFromPatch(text) {
	const lines = text.split('\n');
	const index = lines.findIndex((line) => /^\s+plugins:\s*$/u.test(line));
	if (index < 0) return null;
	const indent = leadingSpaces(lines[index]) + 2;
	const body = [];
	for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
		const line = lines[cursor];
		if (line.trim().length === 0) {
			body.push('');
			continue;
		}
		if (leadingSpaces(line) < indent) break;
		body.push(line.slice(indent));
	}
	while (body.length > 0 && body[body.length - 1].trim().length === 0) body.pop();
	return body.length === 0 ? null : `${body.join('\n')}\n`;
}

/**
 * Build the profile-patch block that makes a preset the default for new sessions.
 *
 * The registry's config replaces wholesale, so both keys are written: `default` is
 * required by its schema, and `selectedDefault` is the volatile override the settings
 * layer merges into. Use `insert` for a profile that does not compose the registry at
 * all (headless/tui), and the row form for a profile that already declares it (web).
 * @param request - preset id, plus whether to `insert` or override the row.
 * @returns the block text.
 */
export function renderRegistryRow(request) {
	const { presetId, mode = 'insert', name = '@deepseek-ai/dsh-agent-preset-registry' } = request;
	const fields = [
		`id: agent-preset-registry`,
		`name: ${renderScalar(name)}`,
		'config:',
		`  default: ${renderScalar(presetId)}`,
		`  selectedDefault: ${renderScalar(presetId)}`
	];
	// Row form: `- id:` at column 0, its keys at 2, the config body at 4.
	if (mode === 'override') return ['- id: agent-preset-registry', ...fields.slice(1).map((line) => `  ${line}`)].join('\n');
	// Insert form: `insert` carries a LIST of rows, so the dash is required and the keys sit two deeper.
	return ['- insert:', '    - id: agent-preset-registry', ...fields.slice(1).map((line) => `      ${line}`)].join('\n');
}

/**
 * Replace one marker-delimited generated block, or append it when absent.
 * @param fileText - whole profile patch file.
 * @param markerId - stable id for this block (the generated preset row id).
 * @param block - block body, without markers.
 * @returns `{ text, replaced }` — the new file content and whether a block was replaced.
 */
export function upsertMarkerBlock(fileText, markerId, block) {
	const begin = `# >>> ${MARKER_NAMESPACE}: ${markerId} (generated; delete this block to drop the preset) >>>`;
	const finish = `# <<< ${MARKER_NAMESPACE}: ${markerId} <<<`;
	const wrapped = `${begin}\n${block.replace(/\n+$/u, '')}\n${finish}`;
	const beginIndex = fileText.indexOf(begin);
	if (beginIndex >= 0) {
		const finishIndex = fileText.indexOf(finish, beginIndex);
		if (finishIndex >= 0) {
			const after = finishIndex + finish.length;
			return { text: fileText.slice(0, beginIndex) + wrapped + fileText.slice(after), replaced: true };
		}
	}
	const base = fileText.replace(/\s*$/u, '');
	return { text: base.length === 0 ? `${wrapped}\n` : `${base}\n\n${wrapped}\n`, replaced: false };
}

/**
 * Render one scalar the way we want it read back (quoting only when needed).
 *
 * The safe pattern deliberately excludes a leading `@` or backtick: both are reserved
 * YAML indicators, so `name: @scope/pkg` is a parse error, which is exactly the shape a
 * package name takes.
 */
function renderScalar(value) {
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`preset row: ${String(value)} is not a finite number`);
		return String(value);
	}
	const text = String(value);
	const reserved = /^(?:true|false|null|yes|no|on|off|~)$/iu;
	const safe = /^[A-Za-z0-9._/+][A-Za-z0-9._/@+-]*$/u;
	if (text.length > 0 && safe.test(text) && !reserved.test(text)) return text;
	return `'${text.replace(/'/gu, "''")}'`;
}

function findKeyLine(lines, from, to, indent, key) {
	const pattern = new RegExp(`^ {${indent}}${key}:\\s*$`, 'u');
	for (let index = from; index < to; index += 1) {
		if (pattern.test(lines[index])) return index;
	}
	return -1;
}

function leadingSpaces(line) {
	return line.length - line.trimStart().length;
}

function isBlank(line) {
	return line.trim().length === 0;
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
