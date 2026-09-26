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
 *   1. a base inventory: an explicit route list (`--routes`), else the parsed profile dump
 *      (`--dump`);
 *   2. `--context-window` / `--max-tokens` / `--model`, which **override** it: the named route
 *      (or the active route, or every route when neither is known) gets exactly those numbers,
 *      because the operator who passes them knows the backend better than its declaration does
 *      — a card serving 40k while the profile claims 128k, or a fresh instance whose profile
 *      declares no backend at all;
 *   3. `--window-agnostic`, which deliberately tunes the ratio alone.
 *
 * With none of them the call is an error: a window that was guessed is worse than no overlay,
 * because the generated threshold silently depends on it.
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
	const explicit = Array.isArray(routes) && routes.length > 0;
	let base = [];
	let baseSource;
	let active;
	if (explicit) {
		base = routes.map(normalizeRoute);
		baseSource = 'explicit route list';
	} else if (dumpText !== undefined) {
		const parsed = parseProfileDump(dumpText);
		active = parsed.active;
		for (const provider of parsed.catalogOnly) {
			notes.push(
				`provider "${provider}" declares no model list, so no window can be read for it offline — ` +
					'name it with --model and pass --context-window, or let its routes fall back to the top-level ratio'
			);
		}
		base = parsed.routes;
		baseSource = 'composed profile dump';
		if (base.length === 0) notes.push('the composed profile declares no provider model with a context window');
	}
	if (base.length > 0) {
		notes.push(
			`read ${base.length} route(s) from the ${baseSource}` +
				(active === undefined ? '' : ` (active: ${active.provider}/${active.model})`)
		);
	}

	if (contextWindow !== undefined || maxTokens !== undefined) {
		const window = contextWindow === undefined ? undefined : positiveInteger(contextWindow, '--context-window');
		const reserve = maxTokens === undefined ? undefined : nonNegativeInteger(maxTokens, '--max-tokens');
		const named = model === undefined ? undefined : normalizeRouteName(model);
		const target = named ?? active;
		if (target === undefined) {
			// No route name anywhere: force the numbers onto every known route, or — when the
			// profile declares none either — emit a top-level-only overlay and report what the
			// numbers mean for the capacity the operator described.
			if (base.length === 0) {
				notes.push(
					'using --context-window without a route name: the overlay carries the ratio at the top level only ' +
						'(pass --model provider:model, or a --dump that names the active route, to also get a per-route policy)'
				);
				return {
					routes: [],
					source: 'window/max-tokens override (top level only)',
					notes,
					windowOverride: { contextWindow: window ?? 0, maxTokens: reserve ?? 0 }
				};
			}
			notes.push('--context-window without a route name: the override is applied to every route the base declares');
			return {
				routes: base.map((route) => ({
					...route,
					...(window === undefined ? {} : { contextWindow: window }),
					...(reserve === undefined ? {} : { maxTokens: reserve })
				})),
				source: 'window/max-tokens override (all routes)',
				notes,
				active
			};
		}
		const existing = base.find((route) => route.provider === target.provider && route.model === target.model);
		if (existing === undefined && window === undefined) {
			throw new Error(
				`route "${target.provider}" model "${target.model}" is not declared by the base, so --max-tokens alone ` +
					'cannot describe it: pass --context-window as well'
			);
		}
		const route = {
			provider: target.provider,
			model: target.model,
			contextWindow: window ?? existing?.contextWindow,
			// A route with no declared reserve reserves nothing, which is what the planner assumes too.
			maxTokens: reserve ?? existing?.maxTokens ?? 0
		};
		notes.push(
			`--context-window/--max-tokens override ${existing === undefined ? 'adds' : 'replaces'} route ` +
				`"${route.provider}" model "${route.model}"${existing === undefined ? ' (the base does not declare it)' : ' over what the base declares'}`
		);
		const others = base.filter((entry) => !(entry.provider === route.provider && entry.model === route.model));
		return { routes: [...others, route], source: `window/max-tokens override (${route.provider})`, notes, active };
	}

	if (base.length > 0) return { routes: base, source: baseSource, notes, active };
	if (model !== undefined) {
		const named = normalizeRouteName(model);
		throw new Error(
			`no context window could be determined for route "${named.provider}" model "${named.model}": pass --context-window ` +
				'(with --max-tokens when the backend reserves output) or --dump of the composed profile'
		);
	}
	if (windowAgnostic === true) {
		notes.push(
			'--window-agnostic: the overlay carries thresholdRatio at the top level with a zero headroom, which ' +
				'applies to every route and needs no window'
		);
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
