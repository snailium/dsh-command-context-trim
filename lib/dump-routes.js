/**
 * Work out *which* route capacity to tune against, from the sources a test script actually
 * has in a fresh environment.
 *
 * The authoritative numbers live inside a running composition (`ctx.llm.resolveModelInfo`),
 * which is what the in-plugin `/trim preset` uses. Offline, the best equivalent is the
 * composed profile tree: `dsh --profile <name> --patch … --dump-config` prints every row
 * including `llm-pi-ai`'s provider table (declared `contextWindow` / `maxTokens` per model)
 * and `agent-default-model` (the route in use). This module parses that text — the script
 * never spawns anything — and resolves it against explicit overrides:
 *
 *   1. an explicit route list (`--routes`),
 *   2. the parsed profile dump (`--dump`),
 *   3. `--context-window` / `--max-tokens` / `--model` overrides, for an instance whose
 *      profile does not declare the backend yet (the fresh-container case),
 *   4. `--window-agnostic`, which deliberately tunes the ratio alone.
 *
 * Anything else is an error: a window that was guessed is worse than no overlay, because the
 * generated threshold silently depends on it.
 *
 * @module dsh-command-context-trim/dump-routes
 */

/**
 * Parse the provider table and active route out of a composed profile dump.
 * @param text - the whole `--dump-config` output.
 * @returns `{routes, active, catalogOnly, providers}`; `routes` is empty when nothing declares numbers.
 */
export function parseProfileDump(text) {
	const lines = text.split('\n');
	const routes = [];
	const catalogOnly = [];
	const providers = [];
	const registry = findRow(lines, 'llm-pi-ai');
	if (registry !== undefined) {
		// `providers:` sits under `config:`, i.e. one level deeper than the row's own keys,
		// so look for the shallowest match anywhere inside the row instead of fixing a depth.
		const providersIndent = findKeyAnywhere(lines, registry.start, registry.end, 'providers');
		if (providersIndent !== undefined) {
			const providerIndent = providersIndent.indent + 2;
			// Providers are MAP keys (`mock:`), not list items; models are list items.
			for (const provider of mapEntries(lines, providersIndent.line + 1, registry.end, providerIndent)) {
				const name = provider.name;
				providers.push(name);
				const keysIndent = providerIndent + 2;
				const defaults = {
					contextWindow: numberValue(lines, provider.start, provider.end, keysIndent, 'contextWindow'),
					maxTokens: numberValue(lines, provider.start, provider.end, keysIndent, 'maxTokens')
				};
				const modelsKey = findKey(lines, provider.start, provider.end, keysIndent, 'models');
				if (modelsKey === undefined) {
					catalogOnly.push(name);
					continue;
				}
				const itemIndent = modelsKey.indent + 2;
				for (const model of childEntries(lines, modelsKey.line + 1, provider.end, itemIndent)) {
					if (model.name === undefined) continue;
					const fieldIndent = itemIndent + 2;
					const contextWindow = numberValue(lines, model.start, model.end, fieldIndent, 'contextWindow') ?? defaults.contextWindow;
					const maxTokens = numberValue(lines, model.start, model.end, fieldIndent, 'maxTokens') ?? defaults.maxTokens;
					routes.push({
						provider: name,
						model: model.name,
						...(contextWindow === undefined ? {} : { contextWindow }),
						...(maxTokens === undefined ? {} : { maxTokens })
					});
				}
			}
		}
	}
	const defaultRow = findRow(lines, 'agent-default-model');
	let active;
	if (defaultRow !== undefined) {
		const provider = valueAnywhere(lines, defaultRow.start, defaultRow.end, 'provider');
		const model = valueAnywhere(lines, defaultRow.start, defaultRow.end, 'model');
		if (provider !== undefined && model !== undefined) active = { provider, model };
	}
	return { routes, active, catalogOnly, providers };
}

/**
 * Decide the inventory to tune against, in the documented order.
 * @param request - sources: `routes`, `dumpText`, `contextWindow`, `maxTokens`, `model`, `windowAgnostic`.
 * @returns `{routes, source, notes}`; `routes` may be empty only for the window-agnostic path.
 * @throws when no source can produce a window and the caller did not ask for a ratio-only overlay.
 */
export function resolveRouteInventory(request = {}) {
	const { routes, dumpText, contextWindow, maxTokens, model, windowAgnostic = false } = request;
	const notes = [];
	if (Array.isArray(routes) && routes.length > 0) {
		return { routes: routes.map(normalizeRoute), source: 'explicit route list', notes };
	}
	const fromDump = dumpText === undefined ? undefined : parseProfileDump(dumpText);
	if (fromDump !== undefined) {
		for (const provider of fromDump.catalogOnly) {
			notes.push(
				`provider "${provider}" declares no model list, so no window can be read for it offline — ` +
					'its routes fall back to the top-level ratio (or set --context-window explicitly)'
			);
		}
		if (fromDump.routes.length > 0) {
			notes.push(`read ${fromDump.routes.length} route(s) from the composed profile${fromDump.active === undefined ? '' : ` (active: ${fromDump.active.provider}/${fromDump.active.model})`}`);
			return { routes: fromDump.routes, source: 'composed profile dump', notes, active: fromDump.active };
		}
		notes.push('the composed profile declares no provider model with a context window');
	}
	const named = model === undefined ? undefined : normalizeRouteName(model);
	const known = named ?? (fromDump === undefined ? undefined : fromDump.active);
	if (contextWindow !== undefined) {
		const window = positiveInteger(contextWindow, '--context-window');
		const reserve = maxTokens === undefined ? 0 : nonNegativeInteger(maxTokens, '--max-tokens');
		if (known === undefined) {
			notes.push(
				'using --context-window without a route name: the overlay carries the ratio at the top level only ' +
					'(pass --model provider:model, or a --dump that names the active route, to also get a per-route policy)'
			);
			return { routes: [], source: 'window/max-tokens override (top level only)', notes, windowOverride: { contextWindow: window, maxTokens: reserve } };
		}
		notes.push(`using the --context-window override for route "${known.provider}" model "${known.model}"`);
		return {
			routes: [{ provider: known.provider, model: known.model, contextWindow: window, maxTokens: reserve }],
			source: 'window/max-tokens override',
			notes
		};
	}
	if (named !== undefined) {
		throw new Error(
			`no context window could be determined for route "${named.provider}" model "${named.model}": pass --context-window ` +
				'(with --max-tokens when the backend reserves output) or --dump of the composed profile'
		);
	}
	if (windowAgnostic === true) {
		notes.push('--window-agnostic: the overlay carries thresholdRatio at the top level with a zero headroom, which ' +
			'applies to every route and needs no window');
		return { routes: [], source: 'window-agnostic ratio', notes };
	}
	throw new Error(
		'no route capacity to tune against: pass --routes <json>, --dump <file> (the composed profile from ' +
			'`dsh --profile <name> --patch … --dump-config`), or --context-window <n> (optionally --max-tokens <n> and ' +
			'--model provider:model). Pass --window-agnostic for a deliberate ratio-only overlay.'
	);
}

/** Validate one route object from an explicit `--routes` file. */
function normalizeRoute(route) {
	if (route === null || typeof route !== 'object') throw new Error('tuned preset: --routes entries must be objects');
	if (typeof route.provider !== 'string' || typeof route.model !== 'string' || route.provider.length === 0 || route.model.length === 0) {
		throw new Error('tuned preset: --routes entries need non-empty provider and model');
	}
	return {
		provider: route.provider,
		model: route.model,
		...(route.contextWindow === undefined ? {} : { contextWindow: positiveInteger(route.contextWindow, '--routes contextWindow') }),
		...(route.maxTokens === undefined ? {} : { maxTokens: nonNegativeInteger(route.maxTokens, '--routes maxTokens') })
	};
}

/** Split `provider:model` (the model half may itself contain colons). */
function normalizeRouteName(text) {
	const colon = text.indexOf(':');
	if (colon <= 0 || colon === text.length - 1) throw new Error(`--model must read provider:model, got "${text}"`);
	return { provider: text.slice(0, colon).trim(), model: text.slice(colon + 1).trim() };
}

function positiveInteger(value, label) {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer, got "${value}"`);
	return number;
}

function nonNegativeInteger(value, label) {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer, got "${value}"`);
	return number;
}

/** Locate `- id: <name>` and the extent of that row's keys. */
function findRow(lines, name) {
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^(\s*)- id:\s*(.*?)\s*$/u.exec(lines[index]);
		if (match === null || match[2] !== name) continue;
		const indent = match[1].length;
		let end = index + 1;
		while (end < lines.length && (lines[end].trim().length === 0 || leadingSpaces(lines[end]) > indent)) end += 1;
		return { start: index + 1, end, indent, keyIndent: indent + 2 };
	}
	return undefined;
}

/** Find the SHALLOWEST `key:` inside `[from, to)`, wherever it sits. */
function findKeyAnywhere(lines, from, to, key) {
	const pattern = new RegExp(`^( *)([^\\s:#][^:]*?):\\s*(.*?)\\s*$`, 'u');
	let best;
	for (let index = from; index < to; index += 1) {
		const match = pattern.exec(lines[index]);
		if (match === null || match[2].trim() !== key) continue;
		const indent = match[1].length;
		if (best === undefined || indent < best.indent) best = { line: index, indent, inline: match[3] };
	}
	return best;
}

/** Read a scalar for `key` wherever it sits inside `[from, to)`. */
function valueAnywhere(lines, from, to, key) {
	const found = findKeyAnywhere(lines, from, to, key);
	if (found === undefined || found.inline.length === 0) return undefined;
	return found.inline.replace(/^['"]|['"]$/gu, '');
}

/** Every `name:` MAP key at exactly `indent` inside `[from, to)`. */
function mapEntries(lines, from, to, indent) {
	const entries = [];
	const pattern = new RegExp(`^ {${indent}}([^\\s:#][^:]*?):\\s*(.*?)\\s*$`, 'u');
	for (let index = from; index < to; index += 1) {
		const match = pattern.exec(lines[index]);
		if (match === null) continue;
		let end = index + 1;
		while (end < to && (lines[end].trim().length === 0 || leadingSpaces(lines[end]) > indent)) end += 1;
		entries.push({ name: match[1].trim(), start: index + 1, end });
		index = end - 1;
	}
	return entries;
}

/** Find `key:` at exactly `indent` inside `[from, to)`. */
function findKey(lines, from, to, indent, key) {
	const pattern = new RegExp(`^ {${indent}}${key}:\\s*(.*?)\\s*$`, 'u');
	for (let index = from; index < to; index += 1) {
		const match = pattern.exec(lines[index]);
		if (match !== null) return { line: index, indent, inline: match[1] };
	}
	return undefined;
}

/** Read `key: <number>` at exactly `indent` inside `[from, to)`. */
function numberValue(lines, from, to, indent, key) {
	const found = findKey(lines, from, to, indent, key);
	if (found === undefined) return undefined;
	const value = Number(found.inline);
	return Number.isFinite(value) ? value : undefined;
}

/** Read `key: <scalar>` at exactly `indent` inside `[from, to)`. */
function stringValue(lines, from, to, indent, key) {
	const found = findKey(lines, from, to, indent, key);
	if (found === undefined || found.inline.length === 0) return undefined;
	return found.inline.replace(/^['"]|['"]$/gu, '');
}

/** Every `- name:` list item at exactly `indent` inside `[from, to)`. */
function childEntries(lines, from, to, indent) {
	const entries = [];
	const pattern = new RegExp(`^ {${indent}}-\\s*(?:id:\\s*)?(.*?)\\s*$`, 'u');
	for (let index = from; index < to; index += 1) {
		const match = pattern.exec(lines[index]);
		if (match === null) continue;
		let end = index + 1;
		while (end < to && (lines[end].trim().length === 0 || leadingSpaces(lines[end]) > indent)) end += 1;
		entries.push({ name: match[1].replace(/^['"]|['"]$/gu, ''), start: index + 1, end });
		index = end - 1;
	}
	return entries;
}

function leadingSpaces(line) {
	return line.length - line.trimStart().length;
}
