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
	assert.match(parseTrimArguments('list').error, /only meaningful for \/trim preset/);
	assert.match(parseTrimArguments('preset list list').error, /duplicate "list"/);
	assert.match(parseTrimArguments('preset 32k').error, /"32k" has no meaning for \/trim preset/);
	assert.match(parseTrimArguments('preset check check').error, /duplicate "check"/);
});
