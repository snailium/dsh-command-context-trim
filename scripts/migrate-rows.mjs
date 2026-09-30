#!/usr/bin/env node
/**
 * Move the compaction tuner's keys from the `context-trim` row onto a `context-trim-tuning` row.
 *
 * 0.6.0 split the bundle into two rows, and 0.6.1 gave the tuning half its own command. A profile that predates
 * the split still carries all five tuner keys on `context-trim`, and installing the new bundle **alone** would
 * silently switch the automatic tuning off: the new `context-trim-tuning` row declares only `role`, so the
 * `registerAutoTune` call it makes reads `autoTuneCompaction: false` and returns before doing anything. The values
 * survive (the `/trim-tune` command merges them back), but the *automatic* behaviour does not. This script is what
 * carries them across, so the behaviour survives too.
 *
 * It is a text edit on purpose. The patch is a hand-maintained YAML list whose rows are interleaved with long
 * comment blocks and a marker block this plugin also owns; a parse-and-re-emit would reflow all of that and make a
 * large, hard-to-review diff out of a small move. The edit is narrow instead: cut the five keys (and the comment
 * lines directly above them) out of the trim row, and add a tuning row that holds them.
 *
 * Usage:
 *   node scripts/migrate-rows.mjs <patch.yml>...        # rewrite in place, reporting every change
 *   node scripts/migrate-rows.mjs --check <patch.yml>  # report only, exit 1 if a migration is needed
 *   node scripts/migrate-rows.mjs --stdin              # read stdin, write the result to stdout
 *
 * It is idempotent: a patch that already has the keys on the tuning row is left byte-identical, and the
 * `context-trim-tuning` row is created only when it is missing.
 */
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const TRIM_ROW = 'context-trim';
const TUNING_ROW = 'context-trim-tuning';
/** The keys that moved to the tuning row in 0.6.0, with the value each takes when it is not written. */
const TUNING_KEYS = {
	compactionTargetRatio: '0.8',
	autoTuneCompaction: 'false',
	tuneStockDisabledRoutes: 'false',
	prunerThresholdChars: "'auto'"
};

/** The lines of one top-level `- id: <row>` block, or `null` when the row is not there. */
function rowBlock(lines, rowId) {
	const start = lines.findIndex((line) => line === `- id: ${rowId}`);
	if (start < 0) return null;
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		if (/^- id: \S/.test(lines[index]) || /^- insert:/.test(lines[index])) {
			end = index;
			break;
		}
	}
	return { start, end, lines: lines.slice(start, end) };
}

/** How deeply a row's `config:` keys sit, so they can be lifted out at the right level. */
function configIndent(blockLines) {
	// Measured from the first key *after* `config:`. Taking the first indented line instead would find `name:`
	// (two spaces) and lift every key at the wrong depth — which silently matches nothing.
	const configAt = blockLines.findIndex((line) => /^\s*config:\s*$/u.test(line));
	if (configAt >= 0) {
		for (let index = configAt + 1; index < blockLines.length; index += 1) {
			const match = /^(\s+)[A-Za-z]\w*:/u.exec(blockLines[index]);
			if (match !== null) return match[1];
		}
	}
	return '    ';
}

/**
 * Which tuner keys a row carries, with the comment block that introduces each one.
 * @param {string[]} block - the row's lines.
 * @param {string} indent - the indent its `config:` keys sit at.
 * @returns {{ key: string, text: string[], indent: string }[]} keys found, in document order.
 */
function tunerKeysIn(block, indent) {
	const found = [];
	for (let index = 0; index < block.length; index += 1) {
		const match = /^(\s*)([A-Za-z]\w*):/.exec(block[index]);
		if (match === null || match[1] !== indent || !(match[2] in TUNING_KEYS)) continue;
		// Take the comment lines directly above, so the value travels with its explanation.
		let from = index;
		while (from > 0 && /^\s*#/.test(block[from - 1])) from -= 1;
		found.push({ key: match[2], indent: match[1], text: block.slice(from, index + 1) });
	}
	return found;
}

/**
 * Migrate one patch document.
 * @param {string} text - the patch file.
 * @returns {{ text: string, moved: string[], created: boolean, notes: string[] }} the result and what changed.
 */
export function migratePatch(text) {
	const lines = text.split('\n');
	const notes = [];
	const trim = rowBlock(lines, TRIM_ROW);
	if (trim === null) return { text, moved: [], created: false, notes: ['no `context-trim` row here'] };

	const indent = configIndent(trim.lines);
	const found = tunerKeysIn(trim.lines, indent);
	if (found.length === 0) {
		return { text, moved: [], created: false, notes: ['nothing to move: the trim row carries no tuner keys'] };
	}

	// Cut the keys (with their comments) out of the trim row.
	const drop = new Set();
	for (const entry of found) entry.text.forEach((line) => drop.add(line));
	const kept = trim.lines.filter((line) => !drop.has(line));

	const out = [...lines.slice(0, trim.start), ...kept, ...lines.slice(trim.end)];

	// Put them on the tuning row, creating it when the profile has none.
	const tuningAt = rowBlock(out, TUNING_ROW);
	const movedLines = found.flatMap((entry) => entry.text);
	if (tuningAt === null) {
		// Directly after the trim row, at the trim row's own indent. Using the row's end rather than some later
		// boundary matters: the profile patch interleaves rows with comment blocks and with other `- insert:` blocks
		// (rows nested there are indented, so a "next top-level row" scan can run past them), and inserting inside
		// one of those produces a patch that no longer parses.
		const trimNow = rowBlock(out, TRIM_ROW);
		const rowIndent = trimNow.lines[0].match(/^\s*/u)[0];
		const row = [
			`${rowIndent}- id: ${TUNING_ROW}`,
			`${rowIndent}  name: dsh-command-context-trim`,
			`${rowIndent}  config:`,
			`${indent}# Which half of the plugin this row is. Without it the row runs as the trimmer, and the`,
			`${indent}# automatic compaction tuning these keys enable would never start.`,
			`${indent}role: tuning`,
			`${indent}# Moved here from the \`${TRIM_ROW}\` row by scripts/migrate-rows.mjs (dsh-command-context-trim 0.6.1).`,
			`${indent}# The bundle declares this row with only \`role\`, on purpose: a value written here overrides the`,
			`${indent}# trim row's, which is what makes the split independent. Before 0.6.1 these keys lived on`,
			`${indent}# \`${TRIM_ROW}\`, where they kept the manual path working; this row keeps the AUTOMATIC tuning on.`,
			...movedLines
		];
		out.splice(trimNow.end, 0, ...row);
		notes.push(`created the \`${TUNING_ROW}\` row`);
	} else {
		const existing = tunerKeysIn(tuningAt.lines, configIndent(tuningAt.lines));
		if (existing.length > 0) {
			// Already migrated by a hand edit: say so and change nothing, rather than duplicating keys.
			return {
				text,
				moved: [],
				created: false,
				notes: [`the \`${TUNING_ROW}\` row already carries ${existing.map((e) => e.key).join(', ')}; leaving it alone`]
			};
		}
		const at = tuningAt.lines.length;
		const patched = [...tuningAt.lines.slice(0, at), ...movedLines, ...tuningAt.lines.slice(at)];
		const shift = tuningAt.lines.length - patched.length;
		out.splice(tuningAt.start, tuningAt.lines.length, ...patched);
		notes.push(`added the keys to the existing \`${TUNING_ROW}\` row`);
		void shift;
	}

	return { text: out.join('\n'), moved: found.map((entry) => entry.key), created: true, notes };
}

async function main() {
	const argv = process.argv.slice(2);
	const check = argv.includes('--check');
	const stdin = argv.includes('--stdin');
	const paths = argv.filter((arg) => !arg.startsWith('--'));

	const apply = async (text, label) => {
		const result = migratePatch(text);
		if (result.moved.length === 0) {
			console.log(`${label}: nothing to do — ${result.notes.join('; ')}`);
			return result.moved.length > 0;
		}
		console.log(`${label}: moving ${result.moved.join(', ')} from \`${TRIM_ROW}\` to \`${TUNING_ROW}\` (${result.notes.join('; ')})`);
		if (check) return true;
		if (!stdin) await writeFile(paths[paths.indexOf(label) === -1 ? 0 : paths.indexOf(label)], result.text, 'utf8');
		else process.stdout.write(result.text);
		return result.moved.length > 0;
	};

	if (stdin) {
		await apply(await readFile(0, 'utf8'), '<stdin>');
		return;
	}
	if (paths.length === 0) {
		console.error('usage: node scripts/migrate-rows.mjs [--check] <patch.yml>...');
		process.exitCode = 2;
		return;
	}
	let changed = false;
	for (const path of paths) {
		const text = await readFile(path, 'utf8');
		const result = migratePatch(text);
		if (result.moved.length === 0) {
			console.log(`${path}: nothing to do — ${result.notes.join('; ')}`);
			continue;
		}
		changed = true;
		console.log(`${path}: moving ${result.moved.join(', ')} from \`${TRIM_ROW}\` to \`${TUNING_ROW}\` (${result.notes.join('; ')})`);
		if (!check) {
			await writeFile(path, result.text, 'utf8');
			console.log(`${path}: rewritten`);
		}
	}
	if (check && changed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
