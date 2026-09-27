import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerAutoTune, findCompactionRow, mergeTunedConfig, tuneCompactionAtRuntime } from '../lib/tune-runtime.js';
import { resolveConfig } from '../lib/config.js';

const CATALOG = { lc: { '/models/q.gguf': { contextWindow: 131072, defaultMaxTokens: 16384 } } };

/** Context stub with a profile-plane compaction row, an editor that records writes, and an llm catalogue. */
function stubContext(request = {}) {
	const edits = [];
	const listeners = new Map();
	const rowConfig = request.rowConfig ?? { auto: true, retainRatio: 0.16 };
	const row = { options: { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: rowConfig }, fiber: { state: request.rowState ?? 2 } };
	const ctx = {
		edits,
		listeners,
		get(name) {
			if (name === 'compaction') return request.plane === 'preset' ? undefined : {};
			if (name === 'configEditor') {
				if (request.editorMissing === true) return undefined;
				return {
					entries: () => [request.withoutRow === true ? undefined : row, { options: { id: 'llm-pi-ai', config: { providers: { lc: { models: [{ id: '/models/q.gguf' }] } } } } }].filter(Boolean),
					edit: async (entry, change) => {
						if (request.editFails === true) throw new Error('the document moved under the draft');
						edits.push({ id: entry.options.id, next: change(entry.options.config ?? {}, {}) });
					}
				};
			}
			return undefined;
		},
		llm: {
			async listModels(provider) {
				return Object.keys(CATALOG[provider] ?? {});
			},
			async resolveModelInfo(provider, model) {
				const entry = CATALOG[provider]?.[model];
				if (entry === undefined) throw new Error('no such model');
				return { context: { contextWindow: entry.contextWindow }, defaultMaxTokens: entry.defaultMaxTokens };
			}
		},
		on(name, listener) {
			listeners.set(name, listener);
		},
		logger: { info() {}, warn() {} }
	};
	return ctx;
}

const agent = { session: { seq: 0, eventAt: () => undefined } };
const signal = new AbortController().signal;
const CONFIG = () => resolveConfig({});

test('the row is only tunable where compaction is on this plane', () => {
	assert.match(findCompactionRow(stubContext({ editorMissing: true })).error, /no configuration editor/u);
	assert.match(findCompactionRow(stubContext({ plane: 'preset' })).error, /agent-preset isolate realm.*tune the preset/su);
	assert.match(findCompactionRow(stubContext({ withoutRow: true })).error, /declares no compaction-basic row/u);
	assert.match(findCompactionRow(stubContext({ rowState: 0 })).error, /is not active in this profile/u);
	assert.equal(findCompactionRow(stubContext()).entry.options.id, 'compaction-basic');
});

test('mergeTunedConfig writes the tuning and keeps every other key', () => {
	const next = mergeTunedConfig(
		{ auto: true, retainRatio: 0.16, summarizationProvider: 'stale', summarizationModel: 'stale' },
		{ config: { thresholdRatio: 0.8, headroomTokens: 0, maxTokens: 8192, modelPolicies: [{ provider: 'lc', model: 'm', thresholdRatio: 0.8, headroomTokens: 9831 }] } }
	);
	assert.equal(next.auto, true);
	assert.equal(next.retainRatio, 0.16);
	assert.equal(next.thresholdRatio, 0.8);
	assert.equal(next.headroomTokens, 0);
	assert.equal(next.maxTokens, 8192);
	assert.equal(next.modelPolicies.length, 1);
	assert.equal('summarizationProvider' in next, false, 'a stale route is removed rather than left behind');
});

test('check reports the diff without writing; apply writes once', async () => {
	const ctx = stubContext();
	const checked = await tuneCompactionAtRuntime(ctx, CONFIG(), { agent, signal, check: true });
	assert.equal(checked.result.kind, 'success');
	assert.equal(ctx.edits.length, 0, 'check never writes');
	assert.match(checked.result.text, /check: nothing written/u);
	assert.match(checked.result.text, /lc\/\/models\/q\.gguf: triggers at 80\.0 %/u);
	assert.match(checked.result.text, /thresholdRatio: undefined → 0\.8/u);

	const applied = await tuneCompactionAtRuntime(ctx, CONFIG(), { agent, signal });
	assert.equal(applied.result.kind, 'success');
	assert.equal(ctx.edits.length, 1);
	assert.equal(ctx.edits[0].id, 'compaction-basic');
	assert.equal(ctx.edits[0].next.thresholdRatio, 0.8);
	assert.equal(ctx.edits[0].next.headroomTokens, 0);
	assert.match(applied.result.text, /Retuned compaction-basic \(headroomTokens, maxTokens, modelPolicies, thresholdRatio\)/u);
	assert.match(applied.result.text, /restarts on write/u);
});

test('an already-tuned row is left alone, and failures stay actionable', async () => {
	const ctx = stubContext({
		rowConfig: { auto: true, thresholdRatio: 0.8, headroomTokens: 0, maxTokens: 8192, modelPolicies: [{ provider: 'lc', model: '/models/q.gguf', thresholdRatio: 0.8, headroomTokens: 9831 }] }
	});
	const already = await tuneCompactionAtRuntime(ctx, CONFIG(), { agent, signal });
	assert.equal(ctx.edits.length, 0);
	assert.match(already.result.text, /Already tuned: nothing written/u);

	const failing = stubContext({ editFails: true });
	const refused = await tuneCompactionAtRuntime(failing, CONFIG(), { agent, signal });
	assert.equal(refused.result.kind, 'error');
	assert.match(refused.result.text, /Writing the compaction config failed: the document moved under the draft/u);

	const presetPlane = await tuneCompactionAtRuntime(stubContext({ plane: 'preset' }), CONFIG(), { agent, signal });
	assert.equal(presetPlane.result.kind, 'error');
	assert.match(presetPlane.result.text, /tune the preset instead/u);
});

test('auto tune fires once per process, only when switched on', async () => {
	const off = stubContext();
	registerAutoTune(off, { autoTuneCompaction: false });
	assert.equal(off.listeners.has('agent/status'), false, 'switched off means no listener at all');

	const on = stubContext();
	registerAutoTune(on, { autoTuneCompaction: true });
	assert.equal(on.listeners.has('agent/status'), true);
	await on.listeners.get('agent/status')({ agent, status: 'working' });
	assert.equal(on.edits.length, 0, 'not while a turn is running');
	await on.listeners.get('agent/status')({ agent, status: 'idle' });
	assert.equal(on.edits.length, 1);
	await on.listeners.get('agent/status')({ agent, status: 'idle' });
	assert.equal(on.edits.length, 1, 'once per process: a restart storm would cancel in-flight work');
});

test('the shipped patch documents the switch as off', () => {
	const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
	assert.match(patch, /autoTuneCompaction: false/u);
});
