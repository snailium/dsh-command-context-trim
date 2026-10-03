import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTO_TUNE_ENV, DEFAULTS, budgetFor, envFlag, resolveConfig, retentionFor } from '../lib/config.js';

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

test('DSH_TRIM_AUTO_TUNE overrides the profile switch, and an unset variable means no opinion', () => {
	const previous = process.env[AUTO_TUNE_ENV];
	try {
		delete process.env[AUTO_TUNE_ENV];
		assert.equal(envFlag(AUTO_TUNE_ENV), undefined);
		assert.equal(resolveConfig({ autoTuneCompaction: true }).autoTuneCompaction, true, 'the profile decides');
		assert.equal(resolveConfig({}).autoTuneCompaction, false, 'off by default');

		for (const value of ['1', 'true', 'YES', 'on']) {
			process.env[AUTO_TUNE_ENV] = value;
			assert.equal(resolveConfig({ autoTuneCompaction: false }).autoTuneCompaction, true, `${value} turns it on`);
		}
		for (const value of ['0', 'false', 'No', 'off']) {
			process.env[AUTO_TUNE_ENV] = value;
			assert.equal(resolveConfig({ autoTuneCompaction: true }).autoTuneCompaction, false, `${value} turns it off`);
		}
		process.env[AUTO_TUNE_ENV] = '   ';
		assert.equal(resolveConfig({}).autoTuneCompaction, false, 'an empty variable is the same as unset');

		process.env[AUTO_TUNE_ENV] = 'maybe';
		assert.throws(() => resolveConfig({}), /DSH_TRIM_AUTO_TUNE must be one of 1\/true\/yes\/on or 0\/false\/no\/off/u);
	} finally {
		if (previous === undefined) delete process.env[AUTO_TUNE_ENV];
		else process.env[AUTO_TUNE_ENV] = previous;
	}
});

test('role says which half an entry is, and defaults to the full trimmer', async () => {
	// One bundle ships two rows, and an entry cannot see its own row id, so the role travels in its config. Absent
	// means the whole plugin, which is exactly what a single-row install was.
	const { resolveConfig } = await import('../lib/config.js');
	assert.equal(resolveConfig({}).role, 'trim');
	assert.equal(resolveConfig({ role: 'trim' }).role, 'trim');
	assert.equal(resolveConfig({ role: 'tuning' }).role, 'tuning');
	assert.throws(() => resolveConfig({ role: 'nope' }), /role must be "trim" or "tuning"/u);
	assert.throws(() => resolveConfig({ role: 1 }), /role must be "trim" or "tuning"/u);
});

test('the split is additive: a pre-split profile keeps its compaction knobs on the trim row', async () => {
	// The failure this guards against is silent and one-sided: the tuning row carries the bundle's defaults, so
	// merging its whole configuration over a pre-split trim row would turn a working `autoTuneCompaction: true`
	// back off. Only keys the deployment actually wrote may travel, so the tuning row contributes overrides only.
	const { readConfig } = await import('../lib/config.js');
	const { explicitOverridesFor } = await import('../lib/index.js');

	// A profile from before the split: everything on one row, auto-tune on.
	const legacyTrimRow = { role: 'trim', autoTuneCompaction: true, prunerThresholdChars: 32768, retainRatio: 0.16 };
	// What a fresh install's tuning row looks like: ONLY `role`. The bundle patch deliberately sets nothing else
	// there, because whatever a row writes is an override the trim row has to yield to, and writing the defaults
	// would undo a pre-split profile's own values. That is the whole reason the config block documents the knobs
	// as comments instead of values.
	const freshTuningRow = { role: 'tuning' };

	// With the tuning row switched off it publishes nothing, so the trim row is what a read sees.
	assert.deepEqual(readConfig(legacyTrimRow).autoTuneCompaction, true, 'a pre-split profile keeps auto-tune on');
	assert.equal(readConfig(legacyTrimRow).prunerThresholdChars, 32768);

	// With the tuning row on but untouched, it must not override what the trim row already says.
	const overrides = explicitOverridesFor(freshTuningRow);
	assert.deepEqual(overrides, {}, 'an untouched tuning row overrides nothing');
	assert.equal(readConfig({ ...legacyTrimRow, ...overrides }).autoTuneCompaction, true);

	// Once the tuning row IS edited, its own value is what the card and the tuner use.
	const edited = explicitOverridesFor({ ...freshTuningRow, autoTuneCompaction: false, prunerThresholdChars: 0 });
	assert.deepEqual(edited, { autoTuneCompaction: false, prunerThresholdChars: 0 });
	assert.equal(readConfig({ ...legacyTrimRow, ...edited }).prunerThresholdChars, 0, 'the tuning row wins once it is set');
});

test('a tuning row writes a real boolean, and only the keys it sets', async () => {
	// The card stages text, so a tuning row's config carries volatile handles rather than plain values. The
	// overrides must unwrap them, or the merged read would see an object where a boolean belongs.
	const { explicitOverridesFor } = await import('../lib/index.js');
	const handle = (value) => ({ get: () => value });
	const overrides = explicitOverridesFor({
		role: 'tuning',
		autoTuneCompaction: handle(true),
		prunerThresholdChars: handle(16384),
		retainRatio: 0.3,
		role2: 'ignored'
	});
	assert.deepEqual(overrides, { autoTuneCompaction: true, prunerThresholdChars: 16384 });
	assert.equal(typeof overrides.autoTuneCompaction, 'boolean', 'a handle unwraps to its value');
	assert.equal('retainRatio' in overrides, false, 'a trims knob never travels from the tuning row');
});
