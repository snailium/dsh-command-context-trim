/**
 * `/context-tune rescue` — recreate a preset id that has gone missing, so sessions bound to it can load again.
 *
 * A session whose preset id no longer resolves cannot be resumed *or* forked (`resolve()` has no fallback), and the
 * lock plus `assertPresetUnchanged` mean it can never be re-pointed at a different id. The only repair is to make
 * the id resolvable again — which also lets this command decide what that id *is*, so it can revive the session and
 * give it tuned settings in the same step.
 *
 * The new definition is a clone of a donor preset (`--from`, default `standard`), because the original plugin list is
 * gone with the id. That is worth saying out loud in the report: the session's history does not depend on the list,
 * but its future turns do, so a preset that mounted extra tools will not get them back from a donor clone.
 *
 * @module dsh-command-context-trim/preset-rescue
 */

import { planCompactionTuning } from './compaction-spec.js';
import { renderPresetOverrideRow, setEntryConfig } from './preset-yaml.js';
import { describeError } from './render.js';
import { applyPrunerThreshold, collectRoutes, persistBlock } from './preset-tune.js';

function failure(text) {
	return { result: { kind: 'error', text } };
}

/**
 * Recreate a missing preset from a donor.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 * @param request - `{missingId, donorId?, untuned?, check?}`.
 * @returns `{result}` in the usual command shape.
 */
export async function rescuePreset(ctx, config, request) {
	const { missingId, donorId = 'standard', untuned = false, check = false } = request;
	if (typeof missingId !== 'string' || missingId.trim().length === 0) {
		return failure('Usage: /context-tune rescue <preset-id> [--from <donor-preset>] [--untuned]');
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
			`Preset "${wanted}" still exists, so there is nothing to rescue. Use /context-tune preset inplace to retune it, ` +
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
		return failure(`Cannot read donor preset "${donorId}": ${describeError(error)}`);
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
			return failure(describeError(error));
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
			`Rescued by /context-tune rescue from donor "${donorId}"${untuned === true ? ' (untuned)' : `, compaction firing at ${(config.compactionTargetRatio * 100).toFixed(0)} % of each routed window`}.`,
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
		return failure(`Writing ${patchPath} failed: ${describeError(error)}\n\n${report}`);
	}
}
