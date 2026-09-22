import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/**
 * Leak guard. A debug `process.stderr.write` added to an *installed* copy once
 * reached this repository: pnpm hard-links store files, so editing the file under
 * a profile's node_modules edited the checkout too, and the probe shipped in a
 * commit. Sources must use the plugin context logger instead.
 */
const LIB = new URL('../lib/', import.meta.url);

test('plugin sources carry no debug console/stderr writes', () => {
	const offenders = [];
	for (const name of readdirSync(LIB).filter((entry) => entry.endsWith('.js'))) {
		const text = readFileSync(join(LIB.pathname, name), 'utf8');
		for (const [index, line] of text.split('\n').entries()) {
			if (/process\.(stderr|stdout)\.write\s*\(/.test(line) || /console\.(log|error)\s*\(/.test(line)) {
				offenders.push(`${name}:${index + 1}: ${line.trim().slice(0, 80)}`);
			}
		}
	}
	assert.deepEqual(offenders, [], `debug writes found:\n${offenders.join('\n')}`);
});
