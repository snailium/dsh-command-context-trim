/**
 * The settings card's controls are text fields, so the three tuner switches can arrive as strings.
 * These tests pin the contract: the forms the card can produce resolve, and nonsense still throws.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveConfig } from '../lib/config.js';

test('boolean switches accept the text a settings card types', () => {
	for (const text of ['true', 'TRUE', ' true ', 'yes', 'on', '1']) {
		assert.equal(resolveConfig({ autoTuneCompaction: text }).autoTuneCompaction, true, text);
	}
	for (const text of ['false', 'no', 'off', '0']) {
		assert.equal(resolveConfig({ autoTuneCompaction: text }).autoTuneCompaction, false, text);
	}
	// An empty draft means "no override": the default applies.
	assert.equal(resolveConfig({ autoTuneCompaction: '' }).autoTuneCompaction, false);
	assert.equal(resolveConfig({}).autoTuneCompaction, false);
	assert.throws(() => resolveConfig({ autoTuneCompaction: 'maybe' }), /must be a boolean/u);
});

test('the pruner threshold accepts typed digits and still bounds them', () => {
	assert.equal(resolveConfig({ prunerThresholdChars: '32768' }).prunerThresholdChars, 32768);
	assert.equal(resolveConfig({ prunerThresholdChars: 8192 }).prunerThresholdChars, 8192);
	assert.equal(resolveConfig({}).prunerThresholdChars, 'auto', 'the default derives the value per route');
	assert.equal(resolveConfig({ prunerThresholdChars: 0 }).prunerThresholdChars, 0, '0 is the explicit opt-out');
	assert.equal(resolveConfig({ prunerThresholdChars: 'auto' }).prunerThresholdChars, 'auto');
	assert.throws(() => resolveConfig({ prunerThresholdChars: 'abc' }), /must be an integer|must be 'auto'/u);
	assert.throws(() => resolveConfig({ prunerThresholdChars: -1 }), /positive integer|non-negative/u);
});

test('the container entrypoint can turn on the small-window lever with one variable', () => {
	const saved = { ...process.env };
	try {
		process.env.DSH_TRIM_PRUNER = '32768';
		assert.equal(resolveConfig({}).prunerThresholdChars, 32768, 'the environment turns the pruner lever on');
		// The environment wins over the profile, exactly like DSH_TRIM_AUTO_TUNE.
		assert.equal(resolveConfig({ prunerThresholdChars: 8192 }).prunerThresholdChars, 32768);
		delete process.env.DSH_TRIM_PRUNER;
		assert.equal(resolveConfig({ prunerThresholdChars: 8192 }).prunerThresholdChars, 8192, 'unset falls back to the profile');

		process.env.DSH_TRIM_PRUNER = 'abc';
		assert.throws(() => resolveConfig({}), /must be an integer|must be 'auto'/u, 'garbage in DSH_TRIM_PRUNER must still throw');
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
	}
});

test('the loader schema admits the auto pruner setting the card can now type', () => {
	// The resolver has accepted 'auto' since 0.3.5; the loader schema (and so the card) must express it too.
	assert.equal(resolveConfig({ prunerThresholdChars: 'auto' }).prunerThresholdChars, 'auto');
	assert.equal(resolveConfig({ prunerThresholdChars: '0' }).prunerThresholdChars, 0);
});

test('the reasoning budget accepts typed digits, honors environment, and rejects nonsense', () => {
	assert.equal(resolveConfig({ reasoningBudget: '4096' }).reasoningBudget, 4096);
	assert.equal(resolveConfig({ reasoningBudget: 2048 }).reasoningBudget, 2048);
	assert.equal(resolveConfig({}).reasoningBudget, 0, 'the default is 0');
	assert.equal(resolveConfig({ reasoningBudget: '' }).reasoningBudget, 0, 'empty field falls back to default');
	assert.throws(() => resolveConfig({ reasoningBudget: 'abc' }), /must be an integer/u);
	assert.throws(() => resolveConfig({ reasoningBudget: -1 }), /non-negative integer/u);

	const saved = { ...process.env };
	try {
		process.env.DSH_TRIM_REASONING_BUDGET = '8192';
		assert.equal(resolveConfig({}).reasoningBudget, 8192, 'environment variable overrides default');
		assert.equal(resolveConfig({ reasoningBudget: 4096 }).reasoningBudget, 8192, 'environment variable overrides profile');
		delete process.env.DSH_TRIM_REASONING_BUDGET;
		assert.equal(resolveConfig({ reasoningBudget: 4096 }).reasoningBudget, 4096);

		process.env.DSH_TRIM_REASONING_BUDGET = 'invalid';
		assert.throws(() => resolveConfig({}), /must be a non-negative integer/u);
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
	}
});
