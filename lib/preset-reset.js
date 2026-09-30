/**
 * `/context-tune reset` — undo the presets this plugin wrote.
 *
 * Every preset this plugin persists goes into the profile patch as a **marker block** written by
 * {@link module:lib/preset-yaml}'s `upsertMarkerBlock`:
 *
 *     # >>> dsh-command-context-trim: preset-standard (generated; delete this block to drop the preset) >>>
 *     - id: preset-standard
 *       …
 *     # <<< dsh-command-context-trim: preset-standard <<<
 *
 * The marker is the whole basis of this module. It means the set of rows **we** wrote is knowable
 * exactly — no guessing from a row's description text, and no risk of matching a preset the user
 * tuned by hand. It is also self-documenting: a person reading the patch can delete the block by hand
 * and get the same result.
 *
 * Removing a block is the correct undo for both shapes {@code /context-tune preset} produces. An
 * `inplace` override is a row that shadows the base preset's own row, so dropping it restores that
 * own definition; a generated `-tuned` preset is a row that only ever added a new id, so dropping it
 * returns the profile to the base preset. Either way the base preset comes back, because the shipped
 * definition is the one underneath.
 *
 * Sessions that already started keep the preset they locked in — dsh refuses a preset switch after
 * the first turn (`agent-preset/locked`) — so a reset affects **new** sessions, and the report says so.
 *
 * @module dsh-command-context-trim/preset-reset
 */

import { MARKER_NAMESPACE } from './preset-yaml.js';

// Any namespace is recognised, not just ours: a report that only ever listed our own blocks would be reassuring
// in exactly the situation where a neighbouring block is what the user is looking at. Ours is then singled out by
// comparing the namespace group, never by pattern-matching the name twice.
// `String.raw` keeps the backslashes literal: in a plain template literal they are eaten and the pattern silently
// degrades to `(?:#s*)`, which matches nothing at all.
const BEGIN = new RegExp(String.raw`^(?:#\s*)>>>\s*(?<namespace>\S+?)\s*:\s*(?<rowId>\S+)`, 'u');
const FINISH = new RegExp(String.raw`^(?:#\s*)<<<\s*(?<namespace>\S+?)\s*:\s*(?<rowId>\S+)\s*<<<`, 'u');

/**
 * One marker block found in a patch file.
 * @typedef {{ rowId: string, beginLine: number, endLine: number, text: string, ourNamespace: boolean }} PresetBlock
 */

/**
 * Find every marker block in a patch document, ours and anyone else's.
 *
 * Both namespaces are collected on purpose: a report that only shows this plugin's blocks would be
 * reassuring in exactly the situation where a neighbouring block is what the user is looking at.
 * @param {string} text - the patch document.
 * @returns {PresetBlock[]} blocks in document order.
 */
export function findMarkerBlocks(text) {
	const lines = String(text ?? '').split('\n');
	/** @type {PresetBlock[]} */
	const blocks = [];
	for (let index = 0; index < lines.length; index += 1) {
		// Named groups, because the two indices are easy to swap: group 1 is the namespace suffix, group 2 the row id.
		const open = BEGIN.exec(lines[index]);
		if (open === null) continue;
		const rowId = open.groups.rowId;
		const ourNamespace = open.groups.namespace === MARKER_NAMESPACE;
		for (let end = index + 1; end < lines.length; end += 1) {
			const close = FINISH.exec(lines[end]);
			if (close !== null && close.groups.rowId === rowId && close.groups.namespace === open.groups.namespace) {
				blocks.push({ rowId, beginLine: index, endLine: end, text: lines.slice(index, end + 1).join('\n'), ourNamespace });
				index = end;
				break;
			}
		}
	}
	return blocks;
}

/**
 * Our own preset blocks, optionally narrowed to one row.
 * @param {string} text - the patch document.
 * @param {string} [only] - keep only this row id.
 * @returns {PresetBlock[]}
 */
export function ourPresetBlocks(text, only) {
	return findMarkerBlocks(text).filter((block) => block.ourNamespace && (only === undefined || block.rowId === only));
}

/**
 * Remove the given line ranges from a document.
 * @param {string} text - the document.
 * @param {{ beginLine: number, endLine: number }[]} blocks - blocks to drop.
 * @returns {string} the document without them, trailing blank lines collapsed.
 */
export function withoutBlocks(text, blocks) {
	const drop = new Set();
	for (const block of blocks) {
		for (let line = block.beginLine; line <= block.endLine; line += 1) drop.add(line);
	}
	return String(text ?? '')
		.split('\n')
		.filter((_line, index) => !drop.has(index))
		.join('\n')
		.replace(/\n{3,}/gu, '\n\n')
		.replace(/\s*$/u, '');
}
