import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, budgetFor, resolveConfig, retentionFor } from '../lib/config.js';

test('defaults match the documented bundle patch', () => {
	const resolved = resolveConfig({});
	assert.equal(resolved.autoTrim, true);
	assert.equal(resolved.maxAutoTrimRetries, 3);
	assert.equal(resolved.autoTrimShrink, 0.5);
	assert.equal(resolved.targetRatio, DEFAULTS.targetRatio);
});

test('rejects unknown keys and out-of-range values', () => {
	assert.throws(() => resolveConfig({ nope: 1 }), /unknown key "nope"/);
	assert.throws(() => resolveConfig({ autoTrimShrink: 0 }), /autoTrimShrink \(0\) must be a number in \(0, 1\]/);
	assert.throws(() => resolveConfig({ autoTrimShrink: 1.5 }), /autoTrimShrink \(1\.5\) must be a number in \(0, 1\]/);
	assert.throws(() => resolveConfig({ maxAutoTrimRetries: -1 }), /maxAutoTrimRetries \(-1\) must be a non-negative integer/);
	assert.throws(() => resolveConfig({ autoTrim: 'yes' }), /autoTrim must be a boolean/);
});

test('budget and retention scale from the declared window', () => {
	assert.equal(budgetFor(32000, resolveConfig({})), Math.floor((32000 - 8192) * 0.9));
	assert.equal(retentionFor(32000, resolveConfig({})), 5120);
	assert.throws(() => budgetFor(8192, resolveConfig({})), /leaves no room inside the 8192-token window/);
});
