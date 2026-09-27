#!/usr/bin/env node
/**
 * Check this plugin's session marker against every admission validator an installed dsh ships.
 *
 * Why this exists: the rule that broke us lives in dsh, not here. Session format v4 retired the generic
 * `{kind: 'plugin', plugin: …}` source wrapper and its admission path rejects it with
 * `format v4 message requires a producer-owned source kind`, so a marker that *writes* fine can make a
 * whole session unreadable. Unit tests cannot see that. Older lines (0.1.2 ships no admission validator,
 * 0.1.5 accepts both shapes) are checked the same way, so the answer is measured per line rather than
 * assumed.
 *
 * Usage: node scripts/check-session-marker.mjs --prefix <dir with node_modules/@deepseek-ai>
 * Exit code: 1 when a validator rejects the marker this version writes; 0 otherwise (including when the
 * line ships no validator at all, which is reported).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TRIM_PLUGIN, TRIM_SOURCE_KIND } from '../lib/apply.js';

const argv = process.argv.slice(2);
const prefixIndex = argv.indexOf('--prefix');
const prefix = prefixIndex === -1 ? undefined : argv[prefixIndex + 1];
if (prefix === undefined) {
	process.stderr.write('usage: node scripts/check-session-marker.mjs --prefix <dir with node_modules/@deepseek-ai>\n');
	process.exit(2);
}
const root = join(prefix, 'node_modules/@deepseek-ai');
if (!existsSync(root)) {
	process.stderr.write(`no @deepseek-ai packages under ${prefix}\n`);
	process.exit(2);
}

const text = [{ type: 'text', text: 'marker' }];
const rows = {
	[`marker with kind "${TRIM_SOURCE_KIND}" (this version)`]: { kind: TRIM_SOURCE_KIND, plugin: TRIM_PLUGIN },
	'retired wrapper {kind: "plugin"} (0.2.x/0.3.0)': { kind: 'plugin', plugin: TRIM_PLUGIN },
	'control: plain user message': { kind: 'user' }
};

let checked = 0;
const rejected = [];
for (const dir of readdirSync(root)) {
	for (const relative of ['lib/index.js', 'lib/invariant.js']) {
		const index = join(root, dir, relative);
		if (!existsSync(index)) continue;
		let module;
		try {
			module = await import(pathToFileURL(index).href);
		} catch {
			continue;
		}
		for (const [name, fn] of Object.entries(module)) {
			if (!/^assertV\d+RowAdmission$/u.test(name) || typeof fn !== 'function') continue;
			if (checked > 0 && name.endsWith('RowAdmission') && rejected.some((entry) => entry === name)) continue;
			checked += 1;
			process.stdout.write(`--- ${dir} ${name}\n`);
			for (const [label, source] of Object.entries(rows)) {
				const row = { type: 'user/message', seq: 1, time: 1, data: { role: 'user', content: text, source }, surfaceOp: 'append' };
				try {
					fn(row);
					process.stdout.write(`    ACCEPT  ${label}\n`);
				} catch (error) {
					process.stdout.write(`    REJECT  ${label} -> ${error.message}\n`);
					if (label.includes('this version')) rejected.push(`${dir} ${name}`);
				}
			}
		}
	}
}
if (checked === 0) {
	process.stdout.write('this line ships no row-admission validator, so there is nothing to check\n');
	process.exit(0);
}
if (rejected.length > 0) {
	process.stderr.write(`\nthis plugin would write a session that ${rejected.join(', ')} refuses\n`);
	process.exit(1);
}
process.stdout.write('\nOK: every admission validator this line ships accepts the marker this version writes\n');
