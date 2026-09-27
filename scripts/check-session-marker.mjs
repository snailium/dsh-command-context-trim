#!/usr/bin/env node
/**
 * Check this plugin's session marker against a real dsh install's format-v4 admission validator.
 *
 * The bug this exists for: session format v4 retired the generic `{kind: 'plugin', plugin: …}` source
 * wrapper, and its admission path rejects it with
 * `format v4 message requires a producer-owned source kind`. A marker that merely *writes* fine can
 * therefore make a whole session unreadable, which unit tests cannot see because the validator lives in
 * dsh, not in this repository.
 *
 * Usage: node scripts/check-session-marker.mjs --prefix <dir with node_modules/@deepseek-ai>
 */
import { createRequire } from 'node:module';
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
const modulePath = join(prefix, 'node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js');
let admission;
try {
	admission = await import(pathToFileURL(modulePath).href);
} catch (error) {
	process.stderr.write(`cannot load the v4 format module at ${modulePath}: ${error.message}\n`);
	process.exit(2);
}
const { assertV4RowAdmission } = admission;

const text = [{ type: 'text', text: 'marker' }];
const row = (source) => ({ type: 'user/message', seq: 1, time: 1, data: { role: 'user', content: text, source }, surfaceOp: 'append' });
const accepts = (candidate) => {
	try {
		assertV4RowAdmission(candidate);
		return true;
	} catch {
		return false;
	}
};

const mine = accepts(row({ kind: TRIM_SOURCE_KIND, plugin: TRIM_PLUGIN }));
const retired = accepts(row({ kind: 'plugin', plugin: TRIM_PLUGIN }));
process.stdout.write(`marker with kind "${TRIM_SOURCE_KIND}": ${mine ? 'ACCEPTED' : 'REJECTED'}\n`);
process.stdout.write(`retired wrapper {kind: "plugin"}: ${retired ? 'ACCEPTED' : 'REJECTED'}\n`);
if (!mine) {
	process.stderr.write('this plugin would write a session that dsh refuses to admit\n');
	process.exit(1);
}
if (retired) {
	process.stderr.write('note: this dsh still accepts the retired wrapper, so the rule may have relaxed\n');
}
process.stdout.write('OK: the marker uses the producer-owned kind v4 requires\n');
