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
		assert.equal(resolveConfig({ tuneStockDisabledRoutes: text }).tuneStockDisabledRoutes, true, text);
	}
	for (const text of ['false', 'no', 'off', '0']) {
		assert.equal(resolveConfig({ autoTuneCompaction: text }).autoTuneCompaction, false, text);
	}
	// An empty draft means "no override": the default applies.
	assert.equal(resolveConfig({ autoTuneCompaction: '' }).autoTuneCompaction, false);
	assert.equal(resolveConfig({}).autoTuneCompaction, false);
	assert.throws(() => resolveConfig({ autoTuneCompaction: 'maybe' }), /must be a boolean/u);
	assert.throws(() => resolveConfig({ tuneStockDisabledRoutes: 'sure' }), /must be a boolean/u);
});

test('the pruner threshold accepts typed digits and still bounds them', () => {
	assert.equal(resolveConfig({ prunerThresholdChars: '32768' }).prunerThresholdChars, 32768);
	assert.equal(resolveConfig({ prunerThresholdChars: 8192 }).prunerThresholdChars, 8192);
	assert.equal(resolveConfig({}).prunerThresholdChars, 0);
	assert.throws(() => resolveConfig({ prunerThresholdChars: 'abc' }), /must be an integer/u);
	assert.throws(() => resolveConfig({ prunerThresholdChars: -1 }), /non-negative/u);
});
