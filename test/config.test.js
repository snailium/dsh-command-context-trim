import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, budgetFor, resolveConfig, retentionFor } from '../lib/config.js';

test('defaults match the documented bundle patch', () => {
	const resolved = resolveConfig({});
	assert.equal(resolved.autoTrim, true);
	assert.equal(resolved.maxAutoTrimRetries, 3);
	assert.equal(resolved.autoTrimShrink, 0.5);
	assert.equal(resolved.emergencyTrim, true);
	assert.equal(resolved.compactionTargetRatio, 0.8);
	assert.equal(resolved.compactionRoute, undefined);
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

test('compaction tuning: the ratio is bounded and the route is all-or-nothing', () => {
	const resolved = resolveConfig({ compactionRoute: { provider: 'opencode-go-v41', model: 'deepseek-v4.1-flash' } });
	assert.deepEqual({ ...resolved.compactionRoute }, { provider: 'opencode-go-v41', model: 'deepseek-v4.1-flash' });
	assert.equal(Object.isFrozen(resolved.compactionRoute), true, 'the route is detached and frozen');

	assert.throws(() => resolveConfig({ compactionTargetRatio: 0 }), /compactionTargetRatio \(0\) must be a number in \(0, 1\]/);
	assert.throws(() => resolveConfig({ compactionTargetRatio: 1.5 }), /must be a number in \(0, 1\]/);
	assert.throws(() => resolveConfig({ compactionRoute: { provider: 'p' } }), /must be set together as non-empty strings/);
	assert.throws(() => resolveConfig({ compactionRoute: { provider: '', model: 'm' } }), /must be set together as non-empty strings/);
	assert.throws(() => resolveConfig({ compactionRoute: { provider: 'p', model: 'm', extra: 1 } }), /compactionRoute.extra is not a supported key/);
	assert.throws(() => resolveConfig({ compactionRoute: 'p/m' }), /must read "provider:model"/);
	assert.deepEqual({ ...resolveConfig({ compactionRoute: 'opencode-go:deepseek-v4.1-flash' }).compactionRoute }, {
		provider: 'opencode-go',
		model: 'deepseek-v4.1-flash'
	}, 'the settings card edits one text field, so the string form is accepted');
	assert.deepEqual({ ...resolveConfig({ compactionRoute: ' lc : /models/q.gguf ' }).compactionRoute }, { provider: 'lc', model: '/models/q.gguf' });
	assert.equal(resolveConfig({ compactionRoute: '   ' }).compactionRoute, undefined, 'a blank field clears the route');
	assert.throws(() => resolveConfig({ compactionRoute: 'no-colon' }), /must read "provider:model"/);
	assert.throws(() => resolveConfig({ compactionRoute: null }), /compactionRoute must be an object with provider and model/);
});

test('emergencyTrim is a boolean switch', () => {
	assert.equal(resolveConfig({ emergencyTrim: false }).emergencyTrim, false);
	assert.throws(() => resolveConfig({ emergencyTrim: 'yes' }), /emergencyTrim must be a boolean/);
});
