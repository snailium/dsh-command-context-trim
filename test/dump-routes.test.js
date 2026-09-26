import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseProfileDump, resolveRouteInventory } from '../lib/dump-routes.js';

const SAMPLE = readFileSync(new URL('../fixtures/sample-profile-dump.yml', import.meta.url), 'utf8');

test('parses the provider table, provider-level defaults and the active route', () => {
	const parsed = parseProfileDump(SAMPLE);
	assert.deepEqual(parsed.routes, [
		{ provider: 'b70-sycl', model: '/models/Qwen3.8-27B-Q4_K_M.gguf', contextWindow: 131072, maxTokens: 16384 },
		{ provider: 'bonsai-8gb', model: '/home/gwang/bonsai2/models/mtp-lean.gguf', contextWindow: 40960, maxTokens: 8192 }
	], 'the second model has no numbers of its own and inherits the provider level');
	assert.deepEqual(parsed.active, { provider: 'bonsai-8gb', model: '/home/gwang/bonsai2/models/mtp-lean.gguf' });
	assert.deepEqual(parsed.catalogOnly, ['catalog-only'], 'a provider without a model list has no offline window');
	assert.deepEqual(parsed.providers, ['b70-sycl', 'bonsai-8gb', 'catalog-only']);
	assert.deepEqual(parseProfileDump('- id: session\n  name: x\n'), { routes: [], active: undefined, catalogOnly: [], providers: [] });
});

test('resolveRouteInventory honours the documented source order', () => {
	const explicit = resolveRouteInventory({ routes: [{ provider: 'p', model: 'm', contextWindow: 8, maxTokens: 1 }], dumpText: SAMPLE });
	assert.equal(explicit.source, 'explicit route list');
	assert.deepEqual(explicit.routes, [{ provider: 'p', model: 'm', contextWindow: 8, maxTokens: 1 }]);

	const fromDump = resolveRouteInventory({ dumpText: SAMPLE });
	assert.equal(fromDump.source, 'composed profile dump');
	assert.equal(fromDump.routes.length, 2);
	assert.ok(fromDump.notes.some((note) => /catalog-only.*no model list/u.test(note)));

	// The override is a FALLBACK: when the profile declares the route, that wins.
	const dumpWins = resolveRouteInventory({ dumpText: SAMPLE, contextWindow: 999, model: 'lc:/models/q.gguf' });
	assert.equal(dumpWins.source, 'composed profile dump');
	assert.equal(dumpWins.routes.length, 2, 'an override never replaces numbers the profile already declares');

	// No numbers anywhere in the dump, but the caller knows the window: a fresh instance
	// whose profile does not declare the backend yet.
	const bare = '- id: session\n  name: x\n';
	const named = resolveRouteInventory({ dumpText: bare, contextWindow: 40960, model: 'lc:/models/q.gguf' });
	assert.deepEqual(named.routes, [{ provider: 'lc', model: '/models/q.gguf', contextWindow: 40960, maxTokens: 0 }], 'no reserve means no reserve');
	assert.ok(named.notes.some((note) => /override/u.test(note)));

	const unnamed = resolveRouteInventory({ dumpText: bare, contextWindow: 40960 });
	assert.deepEqual(unnamed.routes, [], 'without a route name there is nothing to attach a policy to');
	assert.equal(unnamed.windowOverride.contextWindow, 40960);
	assert.ok(unnamed.notes.some((note) => /top level only/u.test(note)));

	const agnostic = resolveRouteInventory({ windowAgnostic: true });
	assert.deepEqual(agnostic.routes, []);
	assert.equal(agnostic.source, 'window-agnostic ratio');
});

test('an undeterminable window is an error, never a guess', () => {
	assert.throws(() => resolveRouteInventory({}), /no route capacity to tune against.*--routes.*--dump.*--context-window/su);
	assert.throws(() => resolveRouteInventory({ model: 'p:m' }), /no context window could be determined for route "p" model "m"/u);
	assert.throws(() => resolveRouteInventory({ contextWindow: 0 }), /--context-window must be a positive integer/u);
	assert.throws(() => resolveRouteInventory({ contextWindow: 100, maxTokens: -1 }), /--max-tokens must be a non-negative integer/u);
	assert.throws(() => resolveRouteInventory({ routes: [{ provider: 'p' }] }), /need non-empty provider and model/u);
	assert.throws(() => resolveRouteInventory({ contextWindow: 100, model: 'nocolon' }), /--model must read provider:model/u);
	assert.throws(() => resolveRouteInventory({ routes: [{ provider: 'p', model: 'm', contextWindow: 1.5 }] }), /--routes contextWindow must be a positive integer/u);
});
