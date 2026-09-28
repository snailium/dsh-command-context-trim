/**
 * `/trim preset inplace`: the override-row shape, the flag, and what the command writes.
 *
 * The point of the mode is that nothing needs picking afterwards — new sessions keep using the same preset id —
 * so the row must address the shipped preset by id instead of declaring a new one, and it must carry every key
 * (patch layers replace a row's `config:` wholesale).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTrimArguments } from '../lib/args.js';
import { renderPresetOverrideRow, setEntryConfig, renderPlainConfig } from '../lib/preset-yaml.js';
import { tuneCompactionPreset } from '../lib/preset-tune.js';
import { resolveConfig } from '../lib/config.js';

test('the parser accepts inplace only for /trim preset', () => {
	// The parser takes the raw argument string, not a field list.
	assert.equal(parseTrimArguments('preset inplace').inplace, true);
	assert.equal(parseTrimArguments('preset --inplace check').inplace, true);
	assert.equal(parseTrimArguments('tune inplace').error !== undefined, true, 'inplace means nothing for /trim tune');
	assert.equal(parseTrimArguments('inplace').error !== undefined, true, 'inplace without preset is refused');
});

test('an override row addresses the preset by id and carries every config key', () => {
	const row = renderPresetOverrideRow({
		rowId: 'preset-standard',
		presetId: 'standard',
		name: 'Standard (tuned 80%)',
		description: 'overrides standard in place',
		order: 1,
		pluginsYaml: '- id: persona\n  name: \'@deepseek-ai/dsh-persona\''
	});
	assert.match(row, /^- id: preset-standard$/mu);
	assert.doesNotMatch(row, /insert:/u, 'an override must not declare a new row');
	assert.match(row, /^  name: '@deepseek-ai\/dsh-agent-preset'$/mu);
	for (const key of ['id: standard', 'name:', 'description:', 'order: 1', 'plugins:']) {
		assert.match(row, new RegExp(key.replace(/[:]/, ':'), 'u'), key);
	}
	// plugins sit one level deeper than the `plugins:` key itself
	assert.match(row, /^    plugins:$/mu);
	assert.match(row, /^      - id: persona$/mu);
});

test('the shipped bundle derives the pruner threshold instead of pinning the old opt-out', async () => {
	// Regression: 0.3.2's patch pinned `prunerThresholdChars: 0`, which is an explicit opt-out. It stayed behind
	// after 0.3.5 made the value derivable, so every install of our own bundle kept the pruner at stock 8192 —
	// found live, in an isolated instance whose preset row still said thresholdChars: 8192.
	const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
	assert.match(text, /prunerThresholdChars: auto/u, 'the bundle must not pin the old opt-out');
});
