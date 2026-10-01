/**
 * `/context-tune preset` — generate a compaction-tuned agent preset from the live routes.
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
import { describeError as describe } from './render.js';
import { TUNE_USAGE } from './args.js';
import { findMarkerBlocks, ourPresetBlocks, withoutBlocks } from './preset-reset.js';
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
export function applyPrunerThreshold(content, routes, config) {
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

export { rescuePreset } from './preset-rescue.js';

/**
 * Read the `{provider, model}` pairs a preset document already carries in its `modelPolicies`.
 *
 * Text, not a parser: the document is YAML we only ever splice, and a tolerant scan is enough to answer the two
 * questions that matter — which routes a preset covers, and whether it predates the routes now configured.
 * @param content - preset document text.
 * @returns a `Set` of `provider\u0000model` keys.
 */
function policiesInDocument(content) {
	const covered = new Set();
	const lines = content.split('\n');
	const start = lines.findIndex((line) => /^\s*modelPolicies:\s*$/u.test(line));
	if (start < 0) return covered;
	const indent = (lines[start].match(/^\s*/u)?.[0] ?? '').length;
	let provider;
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim().length === 0) continue;
		if ((line.match(/^\s*/u)?.[0] ?? '').length <= indent) break;
		const p = /^\s*-?\s*provider:\s*'?([^'\s]+)'?\s*$/u.exec(line);
		if (p !== null) {
			provider = p[1];
			continue;
		}
		const m = /^\s*model:\s*'?([^'\s]+)'?\s*$/u.exec(line);
		if (m !== null && provider !== undefined) {
			covered.add(`${provider}\u0000${m[1]}`);
			provider = undefined;
		}
	}
	return covered;
}

/**
 * Report which configured routes a preset does not cover, and flag the dangerous half of that gap.
 *
 * An uncovered route is not fatal: it inherits the tuned top level, which is what you want for a large window. For a
 * route at or below 64K it is the opposite — the top level *enables* the pressure trigger, and that is the
 * configuration measured slower (15 -> 24 compactions on one task). Those routes need a policy explicitly keeping
 * them at stock.
 * @param routeList - routes visible to the planner.
 * @param existing - the `provider\u0000model` keys the preset already carries.
 * @returns report lines.
 */
function coverageLines(routeList, existing) {
	if (existing === null) return [];
	const missing = routeList.filter((route) => !existing.has(`${route.provider}\u0000${route.model}`));
	const out = [
		`  coverage: ${routeList.length} route(s) configured, ${routeList.length - missing.length} covered by this preset` +
			`${missing.length === 0 ? '' : `, ${missing.length} not covered`}.`
	];
	for (const route of missing) {
		const window = Number(route.contextWindow);
		const reserve = Number(route.maxTokens ?? 0);
		if (Number.isFinite(window) && Number.isFinite(reserve) && window - reserve <= 65536) {
			out.push(
				`  ⚠ uncovered SMALL route ${route.provider}/${route.model} (${window} − ${reserve} ≤ 65536): without a ` +
					'policy it inherits the tuned top level, which enables the pressure trigger on a route where that ' +
					'measured slower. Re-run /context-tune preset inplace to give it a stock policy.'
			);
		}
	}
	return out;
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
				: `Generated by /context-tune preset: compaction fires at ${(config.compactionTargetRatio * 100).toFixed(0)} % of each routed window`) +
			`${summarizationRoute === undefined ? '' : `, summarization on ${summarizationRoute.provider}/${summarizationRoute.model}`}` +
			`${pruner.thresholdChars === undefined ? '' : `, pruner clip ${pruner.thresholdChars}`}.`,
		order: (base.order ?? 1) + 0.5,
		pluginsYaml: pruner.content
	});
	const coverage = coverageLines(routes, policiesInDocument(document.content));
	const report = renderReport({ base, plan, presetId, rowId, rowText, check, coverage }) + pruner.note;
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
				'command (`/context-tune preset default`) to make every new session start with it. A profile whose `patchReload` ' +
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
			'`/context-tune preset default`.'
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
export async function persistBlock(patchPath, rowId, rowText) {
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
	// Nothing to do when our block already says exactly this: the auto-sync path re-runs on every boot, and a
	// byte-identical rewrite would churn the file (and the backup) for no reason.
	if (text === before) return { replaced, backedUp, unchanged: true };
	const temporary = `${patchPath}.tmp-trim-${process.pid}`;
	await writeFile(temporary, text, 'utf8');
	await rename(temporary, patchPath);
	return { replaced, backedUp };
}

/** Human report: the route table, the planner's notes and the row preview. */
function renderReport({ base, plan, presetId, rowId, rowText, check, coverage = [] }) {
	const lines = [
		base.id === presetId
			? `Compaction tuning overriding preset "${base.id}" in place${check ? ' (check: nothing written)' : ''}`
			: `Compaction tuning from preset "${base.id}" → "${presetId}"${check ? ' (check: nothing written)' : ''}`,
		''
	];
	for (const note of plan.notes) lines.push(`  ${note}`);
	for (const line of coverage) lines.push(line);
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

/**
 * `/context-tune reset` — undo the presets this plugin wrote.
 *
 * The undo is a block deletion, and that is exact rather than heuristic because every preset this plugin persists
 * is written through {@link module:lib/preset-yaml}'s marker block: the patch carries a begin and an end line
 * naming the row, so "the rows we wrote" is knowable without matching on a description string and without any
 * risk of catching a preset someone tuned by hand. A block of another tool's is reported but never touched.
 *
 * Both shapes `/context-tune preset` produces undo the same way. An `inplace` override is a row that shadows the base
 * preset's own row, so dropping it restores that own definition; a generated `-tuned` preset only ever added a new
 * id, so dropping it returns the profile to the base preset.
 *
 * A session that has already started keeps the preset it locked in — dsh refuses a preset switch after the first
 * turn (`agent-preset/locked`) — so a reset takes effect for **new** sessions, and the report says so rather than
 * letting a person conclude their running session just changed.
 *
 * @param ctx - plugin context.
 * @param request - `{ presetId?, check? }`; without `presetId` the whole set is reported.
 * @returns a command result whose text is the report, or an error when a single reset was refused.
 */
export async function resetPresets(ctx, request) {
	const profile = ctx.get?.('profileContext');
	const patchPath = profile?.patchPath;
	if (typeof patchPath !== 'string' || patchPath.length === 0) {
		return { kind: 'error', text: 'Cannot locate the profile patch, so there is nothing to reset here.\n\n' + TUNE_USAGE };
	}
	const wanted = request.presetId;
	const rowIdOf = (presetId) => `preset-${presetId}`;

	let text;
	try {
		text = await readFile(patchPath, 'utf8');
	} catch (error) {
		if (error?.code === 'ENOENT') {
			return { kind: 'success', text: `${patchPath} does not exist, so no preset of ours is in it. Nothing to reset.` };
		}
		return { kind: 'error', text: `Reading ${patchPath} failed: ${describe(error)}` };
	}

	const ours = ourPresetBlocks(text, wanted === undefined ? undefined : rowIdOf(wanted));
	const others = findMarkerBlocks(text).filter((block) => !block.ourNamespace);

	if (ours.length === 0) {
		const lines = [`Nothing of ours to reset${wanted === undefined ? '' : ` for preset "${wanted}"`}.`];
		if (wanted !== undefined) {
			lines.push(
				`A reset names the preset as the tuning row does: "/context-tune preset ${wanted}" writes the row "${rowIdOf(wanted)}". ` +
					'Run "/context-tune reset" with no id to see every preset this plugin has written.'
			);
		}
		if (others.length > 0) {
			lines.push('', 'Other tools have written these rows; they are not ours and were left alone:');
			for (const block of others) lines.push(`  - ${block.rowId}`);
		}
		return { kind: 'success', text: lines.join('\n') };
	}

	const report = [
		wanted === undefined
			? `This plugin has written ${ours.length} preset row${ours.length === 1 ? '' : 's'} into ${patchPath}:`
			: `This plugin has written the row "${ours[0].rowId}" into ${patchPath}:`,
		...ours.map((block) => `  - ${block.rowId}  (lines ${block.beginLine + 1}–${block.endLine + 1})`)
	];

	if (request.check === true) {
		report.push(
			'',
			'Dry run: nothing was written. Re-run without "check" to remove the block(s) above, which restores each',
			"preset's own definition.",
			'',
			'Sessions that already started keep the preset they locked in (dsh refuses a switch after the first turn),',
			'so this takes effect for NEW sessions.'
		);
		return { kind: 'success', text: report.join('\n') };
	}

	// Back up before the first destructive write, the same way `persistBlock` does, so a mistake here is undoable
	// without reinstalling anything.
	const backup = `${patchPath}.bak-trim-reset`;
	try {
		await copyFile(patchPath, backup);
	} catch (error) {
		return { kind: 'error', text: `Backing up ${patchPath} to ${backup} failed, so nothing was changed: ${describe(error)}` };
	}

	const after = withoutBlocks(text, ours);
	const temporary = `${patchPath}.tmp-trim-reset-${process.pid}`;
	try {
		await writeFile(temporary, after, 'utf8');
		await rename(temporary, patchPath);
	} catch (error) {
		return {
			kind: 'error',
			text: `Writing ${patchPath} failed: ${describe(error)}\n\nThe original is intact at ${backup}.`
		};
	}

	report.push(
		'',
		`Removed ${ours.length} block${ours.length === 1 ? '' : 's'}. Each preset falls back to its own definition.`,
		`Backup: ${backup}`,
		'',
		'Sessions that already started keep the preset they locked in (dsh refuses a switch after the first turn),',
		'so this takes effect for NEW sessions. A profile whose `patchReload` is `startup` only re-reads the patch at',
		'boot, so restart dsh if a reset preset does not appear.'
	);
	if (others.length > 0) {
		report.push('', 'Left untouched (another tool wrote them):', ...others.map((block) => `  - ${block.rowId}`));
	}
	return { kind: 'success', text: report.join('\n') };
}
