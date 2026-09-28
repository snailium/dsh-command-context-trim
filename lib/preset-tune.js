/**
 * `/trim preset` — generate a compaction-tuned agent preset from the live routes.
 *
 * Why a preset and not a runtime knob: compaction's policy is read at composition
 * time by a `compaction-basic` instance that lives inside an agent-preset isolate
 * realm. A host-plane plugin cannot see or reconfigure that instance, so the only
 * honest way to move the threshold is to contribute a preset row — which 0.1.7 made
 * an ordinary patch row (`@deepseek-ai/dsh-agent-preset`).
 *
 * The generated preset is a **clone of the preset in use**, read through
 * `agentPresets.readDocument()` (already-evaluated plugin list), with only the
 * `compaction-basic` entry's `config:` replaced. Cloning at generation time is what
 * keeps it current: a hand-copied preset rots the moment dsh changes its own
 * composition.
 *
 * Persistence is a marker-delimited block in the profile patch, so the result is
 * reviewable, idempotent, and removable by deleting the block.
 *
 * @module dsh-command-context-trim/preset-tune
 */
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { planCompactionTuning, prunerCharsForRoute } from './compaction-spec.js';
import { renderPlainConfig, renderPresetOverrideRow, renderPresetRow, setEntryConfig, upsertMarkerBlock } from './preset-yaml.js';
import { latestRoute } from './target.js';

/** Suffix appended to the base preset id for the generated one. */
export const TUNED_PRESET_SUFFIX = '-tuned';

/** Loader entry id (and settings namespace) that owns the default preset choice. */
export const AGENT_PRESET_SETTINGS_NS = 'agent-preset-registry';

/** How long to wait for a freshly written preset row to become a healthy registration. */
const REGISTRATION_ATTEMPTS = 6;
const REGISTRATION_DELAY_MS = 500;

/**
 * Generate (and optionally persist) a compaction-tuned preset.
 * @param ctx - plugin context carrying `agentPresets`, `configEditor`, `llm`.
 * @param config - resolved plugin configuration.
 * @param request - `{ agent, signal, requestedRoute?, check? }`.
 * @returns `{ result }` — a command result.
 */
/**
 * Splice the derived clip threshold into the preset's tool-result pruner row.
 *
 * The compaction row alone does not fix a small window: the pruner is what clips a whole-file read, and a preset
 * that carries the stock 8192 keeps doing it. The setting is the same one auto-tune uses — `'auto'` derives it from
 * the routed windows (smallest wins), `0` leaves the row alone, a number overrides.
 * @param content - the preset document after the compaction splice.
 * @param routes - routed `{provider, model, contextWindow, maxTokens}` entries.
 * @param config - resolved plugin configuration.
 * @returns `{content, note}` — the document and a line for the report.
 */
function applyPrunerThreshold(content, routes, config) {
	const setting = config.prunerThresholdChars;
	if (setting === 0 || setting === '0') return { content, note: '\nPruner: left alone (prunerThresholdChars = 0).' };
	const wanted = setting === 'auto'
		? Math.min(...routes.map((route) => prunerCharsForRoute(route)))
		: setting;
	const spliced = setEntryConfig(
		content,
		'tool-result-pruner',
		{ thresholdChars: wanted, headChars: config.pruneHeadChars, tailChars: config.pruneTailChars },
		renderPlainConfig
	);
	if (spliced === null) {
		return {
			content,
			note: '\nPruner: this preset declares no tool-result-pruner row, so its clip threshold is unchanged.'
		};
	}
	const how = setting === 'auto' ? `auto from the routed windows, smallest wins` : 'explicit';
	return { content: spliced, note: `\nPruner: tool-result-pruner thresholdChars -> ${wanted} (${how}).`, thresholdChars: wanted };
}

/**
 * Recreate a preset id that has gone missing, so sessions bound to it can load again.
 *
 * A session whose preset id no longer resolves cannot be resumed *or* forked (`resolve()` has no fallback), and the
 * lock plus `assertPresetUnchanged` mean it can never be re-pointed at a different id. The only repair is to make
 * the id resolvable again — which also lets this command decide what that id *is*, so it can revive the session and
 * give it tuned settings in the same step.
 *
 * The new definition is a clone of a donor preset (`--from`, default `standard`), because the original plugin list is
 * gone with the id. That is worth saying out loud in the report: the session's history does not depend on the list,
 * but its future turns do, so a preset that mounted extra tools will not get them back from a donor clone.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 * @param request - `{missingId, donorId?, untuned?, check?}`.
 * @returns `{result}` in the usual command shape.
 */
export async function rescuePreset(ctx, config, request) {
	const { missingId, donorId = 'standard', untuned = false, check = false } = request;
	if (typeof missingId !== 'string' || missingId.trim().length === 0) {
		return failure('Usage: /trim rescue <preset-id> [--from <donor-preset>] [--untuned]');
	}
	const wanted = missingId.trim();
	const registry = ctx.get?.('agentPresets');
	if (registry === undefined) {
		return failure('This profile composes no agent-preset registry, so there is nothing to recreate into.');
	}
	const roster = await registry.remoteExportList();
	const ids = new Set((roster.presets ?? []).map((preset) => preset.id));
	if (ids.has(wanted)) {
		return failure(
			`Preset "${wanted}" still exists, so there is nothing to rescue. Use /trim preset inplace to retune it, ` +
				'or pick a different id if your session needs one that disappeared.'
		);
	}
	if (!ids.has(donorId)) {
		return failure(`Donor preset "${donorId}" does not exist; pass --from <preset> with one of: ${[...ids].join(', ')}.`);
	}
	let document;
	try {
		document = await registry.readDocument(donorId);
	} catch (error) {
		return failure(`Cannot read donor preset "${donorId}": ${describe(error)}`);
	}
	const routes = await collectRoutes(ctx, request.agent, request.signal);
	let plan;
	let pluginsYaml = document.content;
	let prunerNote = '\nPruner: left alone (--untuned).';
	if (untuned !== true) {
		if (routes.length === 0) {
			return failure('No routable provider/model pairs were found, so there is nothing to size a threshold for.');
		}
		try {
			plan = planCompactionTuning({ routes, targetRatio: config.compactionTargetRatio, summarizationRoute: config.compactionRoute });
		} catch (error) {
			return failure(describe(error));
		}
		const spliced = setEntryConfig(pluginsYaml, 'compaction-basic', plan.config);
		if (spliced === null) {
			return failure(`Donor preset "${donorId}" declares no compaction-basic entry, so it cannot be used as a tuned donor.`);
		}
		const pruner = applyPrunerThreshold(spliced, routes, config);
		pluginsYaml = pruner.content;
		prunerNote = pruner.note;
	}
	const rowId = `preset-${wanted}`;
	const rowText = renderPresetOverrideRow({
		rowId,
		presetId: wanted,
		name: document.name ?? wanted,
		description:
			`Rescued by /trim rescue from donor "${donorId}"${untuned === true ? ' (untuned)' : `, compaction firing at ${(config.compactionTargetRatio * 100).toFixed(0)} % of each routed window`}.`,
		order: 1,
		pluginsYaml
	});
	const lines = [
		`Rescue row for preset "${wanted}" from donor "${donorId}"${check ? ' (check: nothing written)' : ''}`,
		'',
		`  The id did not resolve, which is why sessions bound to it could be neither resumed nor forked.`,
		untuned === true
			? '  --untuned: the donor plugin list is used as-is.'
			: `  ${plan.notes.length} route note(s): ${plan.notes.slice(0, 2).join(' | ') || '(none)'}`,
		prunerNote.trim().length > 0 ? `  ${prunerNote.trim()}` : '',
		'',
		`  Caveat: the original plugin list is gone, so this clone replaces it. The session's history is unaffected,`,
		'  but its future turns get the donor composition — a preset that mounted extra tools will not get them back.',
		'',
		`Patch row ${rowId} (${rowText.split('\n').length} lines):`,
		'',
		...rowText.split('\n').slice(0, 20).map((line) => `  ${line}`)
	].filter((line) => line !== '');
	const report = lines.join('\n');
	if (check) return { result: { kind: 'success', text: report } };
	const profile = ctx.get?.('profileContext');
	const patchPath = profile?.patchPath;
	if (typeof patchPath !== 'string' || patchPath.length === 0) {
		return failure(`Cannot locate the profile patch to write into.\n\n${report}`);
	}
	try {
		const landed = await persistBlock(patchPath, rowId, rowText);
		return {
			result: {
				kind: 'success',
				text:
					`${report}\n\n${landed.replaced ? 'Updated' : 'Wrote'} ${patchPath}` +
					`${landed.backedUp ? ` (backup: ${patchPath}.bak-trim-preset)` : ''}.\n` +
					`Restart dsh (or wait for the live patch reload) and then resume the session — or fork it, which composes ` +
					'the same new definition and carries the history forward.'
			}
		};
	} catch (error) {
		return failure(`Writing ${patchPath} failed: ${describe(error)}\n\n${report}`);
	}
}

export async function tuneCompactionPreset(ctx, config, request) {
	const { agent, signal, requestedRoute, check = false, list = false, setDefault = false, inplace = false } = request;
	if (list) return { result: { kind: 'success', text: await renderRouteList(ctx, agent, signal, config) } };
	const registry = ctx.get?.('agentPresets');
	if (registry === undefined) {
		return failure(
			'This profile composes no agent-preset registry, so there is nothing to generate into.\n' +
				'Presets come from the web app bundle (`dsh-web-app/presets/*.patch.yml`); a headless or minimal profile has none.'
		);
	}
	const roster = await registry.remoteExportList();
	const base = pickBasePreset(roster, agent);
	if (base === undefined) return failure('The preset registry has no presets to clone.');
	let document;
	try {
		document = await registry.readDocument(base.id);
	} catch (error) {
		return failure(`Cannot read preset "${base.id}": ${describe(error)}`);
	}
	const routes = await collectRoutes(ctx, agent, signal);
	if (routes.length === 0) {
		return failure('No routable provider/model pairs were found, so there is nothing to size a threshold for.');
	}
	const summarizationRoute = requestedRoute ?? config.compactionRoute;
	let plan;
	try {
		plan = planCompactionTuning({ routes, targetRatio: config.compactionTargetRatio, summarizationRoute });
	} catch (error) {
		return failure(describe(error));
	}
	const spliced = setEntryConfig(document.content, 'compaction-basic', plan.config);
	if (spliced === null) {
		return failure(`Preset "${base.id}" declares no compaction-basic entry, so its threshold cannot be tuned.`);
	}
	const pruner = applyPrunerThreshold(spliced, routes, config);
	// `inplace` overrides the base preset's own row instead of declaring a new one: new sessions keep using the
	// same preset id and pick the tuning up with no picker interaction. The cost is that the shipped preset's plugin
	// list is shadowed until this row is removed.
	const presetId = inplace ? base.id : `${base.id}${TUNED_PRESET_SUFFIX}`;
	// The display name comes from the registry's own metadata, never from the document we are editing: in `inplace`
	// mode that document *is* our previous row, so reading its name back would append the suffix again. Inplace also
	// keeps the original name — the user picks the same preset as before, so renaming it would be noise.
	const tunedPercent = (config.compactionTargetRatio * 100).toFixed(0);
	// Strip a suffix an earlier run may have left in the name the registry reports now: with 0.3.9 the name was
	// read back from the document, so one run could leave `Standard (tuned 80%) (tuned 80%)` behind, and the
	// registry happily reports that name as the base one.
	const baseName = (base.name ?? base.id).replace(/(?:\s*\(tuned \d+%\))+\s*$/u, '').trim() || base.id;
	const presetName = inplace ? baseName : `${baseName} (tuned ${tunedPercent}%)`;
	const rowId = `preset-${presetId}`;
	const rowText = (inplace ? renderPresetOverrideRow : renderPresetRow)({
		rowId,
		presetId,
		name: presetName,
		description:
			(inplace
				? `Overrides preset "${base.id}" in place: compaction fires at ${(config.compactionTargetRatio * 100).toFixed(0)} % of each routed window`
				: `Generated by /trim preset: compaction fires at ${(config.compactionTargetRatio * 100).toFixed(0)} % of each routed window`) +
			`${summarizationRoute === undefined ? '' : `, summarization on ${summarizationRoute.provider}/${summarizationRoute.model}`}` +
			`${pruner.thresholdChars === undefined ? '' : `, pruner clip ${pruner.thresholdChars}`}.`,
		order: (base.order ?? 1) + 0.5,
		pluginsYaml: pruner.content
	});
	const report = renderReport({ base, plan, presetId, rowId, rowText, check }) + pruner.note;
	if (check) return { result: { kind: 'success', text: report } };
	const profile = ctx.get?.('profileContext');
	const patchPath = profile?.patchPath;
	if (typeof patchPath !== 'string' || patchPath.length === 0) {
		return failure(`Cannot locate the profile patch to write into.\n\n${report}`);
	}
	let landed;
	try {
		landed = await persistBlock(patchPath, rowId, rowText);
	} catch (error) {
		return failure(`Writing ${patchPath} failed: ${describe(error)}\n\n${report}`);
	}
	const defaultNote = setDefault && !inplace ? await applyDefault(ctx, registry, presetId, signal) : undefined;
	return {
		result: {
			kind: 'success',
			text:
				`${report}\n\n${landed.replaced ? 'Updated' : 'Wrote'} ${patchPath}` +
				`${landed.backedUp ? ` (backup: ${patchPath}.bak-trim-preset)` : ''}.\n` +
				`Use it for a **new** session: pick "${presetId}" on the New Session screen (reload the page if the preset ` +
				'menu is already open). dsh locks a session\u2019s preset once its first turn starts ' +
				'(`agent-preset/locked`), so a session that is already running cannot switch \u2014 add `default` to this ' +
				'command (`/trim preset default`) to make every new session start with it. A profile whose `patchReload` ' +
				'is `startup` only picks the row up at boot, so restart dsh if it never appears.' +
				(defaultNote === undefined ? '' : `\n${defaultNote}`)
		}
	};
}

/**
 * Print the routes a generated preset would cover — the poor man's dropdown.
 * @param ctx - plugin context.
 * @param agent - agent whose session supplies the active route.
 * @param signal - abort signal.
 * @param config - resolved plugin configuration (supplies the target ratio).
 * @returns a table of provider/model, window, output reserve and the reachable trigger.
 */
export async function renderRouteList(ctx, agent, signal, config = {}) {
	const routes = await collectRoutes(ctx, agent, signal);
	const targetRatio = config.compactionTargetRatio;
	const lines = [`Routes visible to the tuner (${routes.length}):`, ''];
	for (const route of routes) {
		const reserve = route.maxTokens ?? 0;
		// Floor like dsh does, so the printed trigger is the real one, not a rounded one.
		const reachable =
			route.contextWindow === undefined
				? 'no declared window'
				: `${Math.floor(Math.min(route.contextWindow * (targetRatio ?? 0.8), route.contextWindow - reserve))} tokens`;
		lines.push(`  ${route.provider}:${route.model}`);
		lines.push(`      contextWindow ${route.contextWindow ?? '?'} · maxTokens ${route.maxTokens ?? '?'} · trigger would be ~${reachable}`);
	}
	if (routes.length === 0) lines.push('  (none — is the llm-pi-ai row composed in this profile?)');
	return lines.join('\n');
}

/**
 * Read every configured route with the window and output reserve compaction uses.
 * @param ctx - plugin context.
 * @param agent - agent whose session is inspected for the active route.
 * @param signal - abort signal for model-info resolution.
 * @returns a de-duplicated `[{provider, model, contextWindow, maxTokens}]` list.
 */
export async function collectRoutes(ctx, agent, signal) {
	const routes = [];
	const seen = new Set();
	const push = (provider, model, contextWindow, maxTokens) => {
		if (typeof provider !== 'string' || typeof model !== 'string' || provider.length === 0 || model.length === 0) return;
		const key = `${provider}\u0000${model}`;
		if (seen.has(key)) return;
		seen.add(key);
		routes.push({ provider, model, contextWindow, maxTokens });
	};
	const active = latestRoute(agent.session);
	const configured = readConfiguredProviders(ctx);
	for (const [provider, profile] of configured) {
		const declared = Array.isArray(profile?.models) ? profile.models : [];
		if (declared.length > 0) {
			for (const model of declared) {
				const resolved = await resolveRoute(ctx, provider, model?.id, signal);
				push(provider, model?.id, resolved?.contextWindow ?? model?.contextWindow, resolved?.maxTokens ?? model?.maxTokens);
			}
			continue;
		}
		// Catalog-driven route: ask the adapter which models it serves.
		let ids = [];
		try {
			ids = (await ctx.llm.listModels(provider)) ?? [];
		} catch {
			ids = [];
		}
		for (const id of ids) {
			const resolved = await resolveRoute(ctx, provider, id, signal);
			push(provider, id, resolved?.contextWindow, resolved?.maxTokens);
		}
	}
	// The session's own route can be absent from the settings list (a model chosen
	// from the installed catalog); include it so the tuning covers what is in use.
	if (active !== undefined) {
		const resolved = await resolveRoute(ctx, active.provider, active.model, signal);
		push(active.provider, active.model, resolved?.contextWindow, resolved?.maxTokens);
	}
	return routes;
}

/** Resolve one route's adapter-owned window and default output cap, tolerating failure. */
async function resolveRoute(ctx, provider, model, signal) {
	if (typeof provider !== 'string' || typeof model !== 'string' || provider.length === 0 || model.length === 0) return undefined;
	try {
		const info = await ctx.llm.resolveModelInfo(provider, model, signal);
		return { contextWindow: info?.context?.contextWindow, maxTokens: info?.defaultMaxTokens };
	} catch {
		return undefined;
	}
}

/** Read the `llm-pi-ai` row's provider table from the composed configuration. */
function readConfiguredProviders(ctx) {
	const editor = ctx.get?.('configEditor');
	const entries = typeof editor?.entries === 'function' ? editor.entries() : [];
	const entry = entries.find((candidate) => candidate?.options?.id === 'llm-pi-ai');
	const providers = entry?.options?.config?.providers;
	return providers !== undefined && providers !== null && typeof providers === 'object' ? Object.entries(providers) : [];
}

/** Prefer the preset this session selected; fall back to the registry default. */
function pickBasePreset(roster, agent) {
	const presets = Array.isArray(roster?.presets) ? roster.presets : [];
	const selected = findSelectedPreset(agent);
	if (selected !== undefined) {
		const match = presets.find((preset) => preset.id === selected);
		if (match !== undefined) return match;
	}
	return presets.find((preset) => preset.isDefault === true) ?? presets[0];
}

/** The newest `agent-preset/selected` event, when the log carries one. */
function findSelectedPreset(agent) {
	const session = agent?.session;
	if (session === undefined || typeof session.eventAt !== 'function') return undefined;
	for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
		const event = session.eventAt(seq);
		if (event?.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') return event.data.agentPreset;
	}
	return undefined;
}

/**
 * Point new sessions at the generated preset, but only once it is really there.
 *
 * `resolve()` throws `agent-preset/not-found` for an id the registry does not know,
 * and the new-session path resolves the default — so writing a default too early
 * (before the patch hot-reloads, or for a preset whose activation failed) would break
 * new sessions. Hence the bounded wait and the health check.
 * @param ctx - plugin context.
 * @param registry - the agent-preset registry service.
 * @param presetId - the preset to become the default.
 * @param signal - abort signal.
 * @returns a sentence for the report.
 */
async function applyDefault(ctx, registry, presetId, signal) {
	const settings = ctx.get?.('settings');
	if (settings === undefined || typeof settings.update !== 'function') {
		return 'Left the default unchanged: this profile composes no settings service to record it in.';
	}
	let lastError;
	let registered = false;
	for (let attempt = 0; attempt < REGISTRATION_ATTEMPTS && registered === false; attempt += 1) {
		if (signal?.aborted) return 'Left the default unchanged: cancelled while waiting for the preset to register.';
		if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, REGISTRATION_DELAY_MS));
		try {
			const info = await registry.resolve(presetId);
			if (info?.broken !== undefined) {
				return `Left the default unchanged: preset "${presetId}" registered but failed to activate (${info.broken}).`;
			}
			registered = true;
		} catch (error) {
			lastError = error;
		}
	}
	if (registered === false) {
		return (
			`Left the default unchanged: preset "${presetId}" is not registered yet (${describe(lastError)}). ` +
			'A profile whose `patchReload` is `startup` only picks the row up at boot — restart dsh, then re-run ' +
			'`/trim preset default`.'
		);
	}
	try {
		await settings.update(AGENT_PRESET_SETTINGS_NS, { selectedDefault: presetId });
	} catch (error) {
		return `Could not set it as the default (${describe(error)}). The preset row is written; pick it on the New Session screen instead.`;
	}
	return `Set "${presetId}" as the default preset for new sessions (${AGENT_PRESET_SETTINGS_NS}.selectedDefault).`;
}

/** Write the marker-delimited block atomically, keeping one rolling backup. */
async function persistBlock(patchPath, rowId, rowText) {
	let before = '';
	try {
		before = await readFile(patchPath, 'utf8');
	} catch (error) {
		if (error?.code !== 'ENOENT') throw error;
	}
	let backedUp = false;
	if (before.length > 0) {
		try {
			await copyFile(patchPath, `${patchPath}.bak-trim-preset`);
			backedUp = true;
		} catch {
			backedUp = false;
		}
	}
	const { text, replaced } = upsertMarkerBlock(before, rowId, rowText);
	const temporary = `${patchPath}.tmp-trim-${process.pid}`;
	await writeFile(temporary, text, 'utf8');
	await rename(temporary, patchPath);
	return { replaced, backedUp };
}

/** Human report: the route table, the planner's notes and the row preview. */
function renderReport({ base, plan, presetId, rowId, rowText, check }) {
	const lines = [
		base.id === presetId
			? `Compaction tuning overriding preset "${base.id}" in place${check ? ' (check: nothing written)' : ''}`
			: `Compaction tuning from preset "${base.id}" → "${presetId}"${check ? ' (check: nothing written)' : ''}`,
		''
	];
	for (const note of plan.notes) lines.push(`  ${note}`);
	if (plan.skipped.length > 0) lines.push(`  skipped: ${plan.skipped.map((entry) => `${entry.provider}/${entry.model} (${entry.reason})`).join('; ')}`);
	lines.push('', `Generated patch row ${rowId} (${rowText.split('\n').length} lines):`, '');
	for (const line of rowText.split('\n').slice(0, 24)) lines.push(`  ${line}`);
	if (rowText.split('\n').length > 24) lines.push('  …');
	if (base.id === presetId) {
		lines.push(
			'',
			`New sessions keep using preset "${base.id}" and pick this up with no picker interaction. This row shadows`,
			"the shipped preset's own plugin list until it is removed — the shipped copy is overwritten on every dsh upgrade."
		);
	}
	return lines.join('\n');
}

function failure(text) {
	return { result: { kind: 'error', text } };
}

function describe(error) {
	return error instanceof Error ? error.message : String(error);
}
