import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTrimArguments } from '../lib/args.js';

test('accepts the bare form', () => {
	assert.deepEqual(parseTrimArguments(''), { check: false });
	assert.deepEqual(parseTrimArguments('   '), { check: false });
});

test('accepts every check spelling', () => {
	for (const field of ['check', '--check', '--dry-run']) {
		assert.deepEqual(parseTrimArguments(field), { check: true });
	}
});

test('accepts token budgets with units', () => {
	assert.deepEqual(parseTrimArguments('32000'), { check: false, budget: 32000 });
	assert.deepEqual(parseTrimArguments('32k'), { check: false, budget: 32000 });
	assert.deepEqual(parseTrimArguments('1.5K'), { check: false, budget: 1500 });
	assert.deepEqual(parseTrimArguments('2m'), { check: false, budget: 2000000 });
});

test('accepts a provider:model route with slashes in the model id', () => {
	assert.deepEqual(parseTrimArguments('lc:/models/Qwen3.8-27B-Q4_K_M.gguf'), {
		check: false,
		route: { provider: 'lc', model: '/models/Qwen3.8-27B-Q4_K_M.gguf' }
	});
});

test('combines check, budget, and route in any order', () => {
	assert.deepEqual(parseTrimArguments('check 32k lc:m'), {
		check: true,
		budget: 32000,
		route: { provider: 'lc', model: 'm' }
	});
	assert.deepEqual(parseTrimArguments('lc:m --check'), {
		check: true,
		route: { provider: 'lc', model: 'm' }
	});
});

test('rejects unrecognized, duplicated, and empty-value arguments', () => {
	assert.deepEqual(parseTrimArguments('please'), { error: 'unrecognized argument "please"' });
	assert.deepEqual(parseTrimArguments('1k 2k'), { error: 'duplicate token budget "2k"' });
	assert.deepEqual(parseTrimArguments('check check'), { error: 'duplicate "check"' });
	assert.deepEqual(parseTrimArguments('a:b c:d'), { error: 'duplicate target route "c:d"' });
	assert.deepEqual(parseTrimArguments('0'), { error: 'invalid token budget "0"' });
});

test('parses the preset subcommand, its modifiers and its rejections', () => {
	assert.deepEqual(parseTrimArguments('preset'), { check: false, preset: true });
	assert.deepEqual(parseTrimArguments('preset check'), { check: true, preset: true });
	assert.deepEqual(parseTrimArguments('preset list'), { check: false, preset: true, list: true });
	assert.deepEqual(parseTrimArguments('preset list check'), { check: true, preset: true, list: true });
	assert.deepEqual(parseTrimArguments('preset opencode-go:deepseek-v4.1-flash'), {
		check: false,
		preset: true,
		route: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
	});
	assert.match(parseTrimArguments('list').error, /only meaningful for \/context-tune preset/);
	assert.match(parseTrimArguments('preset list list').error, /duplicate "list"/);
	assert.match(parseTrimArguments('preset 32k').error, /"32k" has no meaning for \/context-tune preset/);
	assert.match(parseTrimArguments('preset check check').error, /duplicate "check"/);
});

test('parses the "default" modifier for preset generation only', () => {
	assert.deepEqual(parseTrimArguments('preset default'), { check: false, preset: true, default: true });
	assert.deepEqual(parseTrimArguments('preset --default check'), { check: true, preset: true, default: true });
	assert.deepEqual(parseTrimArguments('preset default opencode-go:m'), {
		check: false,
		preset: true,
		default: true,
		route: { provider: 'opencode-go', model: 'm' }
	});
	assert.match(parseTrimArguments('default').error, /only meaningful for \/context-tune preset/);
	assert.match(parseTrimArguments('preset default default').error, /duplicate "default"/);
});

test('the tuning subcommands are recognised as tuning, and a bare /context-tune is not', async () => {
	// The split is only meaningful if each command can tell the surface is not its own: `/trim` must refuse the
	// tuning verbs, and `/context-tune` must not treat a bare invocation as a trim.
	const { isTuneInvocation, parseTrimArguments } = await import('../lib/args.js');
	for (const input of ['preset', 'preset inplace', 'preset list', 'tune', 'tune check', 'rescue standard', 'reset', 'reset check', 'reset standard']) {
		assert.equal(isTuneInvocation(parseTrimArguments(input)), true, `"${input}" is a tuning invocation`);
	}
	for (const input of ['check', '32k', 'lc:/models/q.gguf', '']) {
		assert.equal(isTuneInvocation(parseTrimArguments(input)), false, `"${input}" is a plain trim`);
	}
});

test('reset takes a preset id, and a flag is never mistaken for one', async () => {
	// `/context-tune reset check` must stay a dry run; `check` is the most likely thing a person types first, and
	// reading it as a preset name would reset nothing while claiming it would.
	const { parseTrimArguments } = await import('../lib/args.js');
	assert.deepEqual(parseTrimArguments('reset'), { check: false, reset: true });
	assert.deepEqual(parseTrimArguments('reset check'), { check: true, reset: true });
	assert.deepEqual(parseTrimArguments('reset standard'), { check: false, reset: true, presetId: 'standard' });
	assert.deepEqual(parseTrimArguments('reset check standard'), { check: true, reset: true, presetId: 'standard' });
	assert.equal(parseTrimArguments('reset a b').error !== undefined, true, 'two ids is a mistake, not a second argument');
});
