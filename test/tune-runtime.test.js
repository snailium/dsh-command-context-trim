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
						const next = change(entry.options.config ?? {}, {});
						// The real editor applies the change to the entry, so a later comparison sees
						// the new state; without that the stub would "write" the same thing forever.
						entry.options.config = next;
						edits.push({ id: entry.options.id, next });
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

function stubSession() {
	const appended = [];
	return { appended, seq: 0, eventAt: () => undefined, append: (type, data) => appended.push({ type, data }) };
}
const session = stubSession();
const agent = { session };
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

test('auto tune writes immediately, without waiting for an idle moment', async () => {
	const off = stubContext();
	registerAutoTune(off, { autoTuneCompaction: false });
	assert.equal(off.listeners.has('agent/created'), false, 'switched off means no listener at all');

	const on = stubContext();
	const auto = registerAutoTune(on, { autoTuneCompaction: true });
	assert.deepEqual([...on.listeners.keys()].sort(), ['agent/created', 'agent/request', 'agent/status', 'session/event']);
	assert.equal(typeof auto.pending, 'function', 'the write is not awaited on the request path, so it exposes a handle');

	// A one-shot headless run may never be idle: the agent's creation must already tune.
	await on.listeners.get('agent/created')({ agent });
	assert.equal(on.edits.length, 1, 'tuned at agent creation, no idle needed');
	assert.equal(on.edits[0].next.thresholdRatio, 0.8);

	// A second trigger with an unchanged route writes nothing (no restart churn).
	await on.listeners.get('agent/status')({ agent, status: 'idle' });
	assert.equal(on.edits.length, 1);

	// A mid-session model switch is caught before the request that would use it, and the
	// waterfall still hands the decision on.
	let continued = false;
	on.edits.length = 0;
	CATALOG.lc['/models/q.gguf'] = { contextWindow: 40960, defaultMaxTokens: 8192 };
	try {
		on.listeners.get('agent/request')({ agent }, () => {
			continued = true;
			return 'downstream';
		});
		await auto.pending();
		assert.equal(continued, true, 'a listener must never veto the request waterfall');
		assert.equal(on.edits.length, 1, 'the switch is picked up');
		assert.notEqual(on.edits[0].next.modelPolicies[0].headroomTokens, 9012, 'the headroom follows the new window');
	} finally {
		CATALOG.lc['/models/q.gguf'] = { contextWindow: 131072, defaultMaxTokens: 16384 };
	}

	// A model switch is announced on the session, which is resolved to its agent rather than guessed.
	on.edits.length = 0;
	CATALOG.lc['/models/q.gguf'] = { contextWindow: 8192, defaultMaxTokens: 1024 };
	try {
		await on.listeners.get('session/event')(agent.session, { type: 'model/selection' });
		assert.equal(on.edits.length, 1, 'a model switch is picked up without waiting for a request');
		await on.listeners.get('session/event')(agent.session, { type: 'system/message' });
		assert.equal(on.edits.length, 1, 'a signal with no route meaning does nothing');
	} finally {
		CATALOG.lc['/models/q.gguf'] = { contextWindow: 131072, defaultMaxTokens: 16384 };
	}
});

test('the shipped patch documents the switch as off', () => {
	const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
	assert.match(patch, /autoTuneCompaction: false/u);
});

test('a retune is reported on stderr, and a no-op check is not', async () => {
	const written = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk, ...rest) => {
		written.push(String(chunk));
		return original(chunk, ...rest);
	};
	try {
		const ctx = stubContext();
		registerAutoTune(ctx, { autoTuneCompaction: true });
		const auto = registerAutoTune(stubContext(), { autoTuneCompaction: true });

		const fresh = stubContext();
		const handle = registerAutoTune(fresh, { autoTuneCompaction: true });
		await handle.pending();
		// First flush happens through agent/created in the other stubs; here check the no-op path.
		await fresh.listeners.get('agent/created')({ agent });
		assert.equal(fresh.edits.length, 1, 'the first trigger writes');
		assert.equal(written.some((line) => line.includes('Retuned compaction-basic')), true, `expected a stderr line, got ${JSON.stringify(written)}`);

		written.length = 0;
		await fresh.listeners.get('agent/created')({ agent });
		assert.equal(fresh.edits.length, 1, 'nothing changed');
		assert.equal(written.length, 0, 'an unchanged per-request check must stay silent');
		void ctx;
		void auto;
	} finally {
		process.stderr.write = original;
	}
});

test('an applied retune is recorded as a non-surface session event', async () => {
	const ctx = stubContext();
	const own = stubSession();
	const ownAgent = { session: own };
	const applied = await tuneCompactionAtRuntime(ctx, CONFIG(), { agent: ownAgent, signal, trigger: 'command' });
	assert.equal(applied.result.kind, 'success');
	assert.equal(own.appended.length, 1, 'exactly one record per applied retune');
	const [record] = own.appended;
	assert.equal(record.type, 'context-trim/tuned');
	assert.equal(record.data.mode, 'runtime');
	assert.equal(record.data.trigger, 'command');
	assert.equal(record.data.thresholdRatio, 0.8);
	assert.equal(record.data.headroomTokens, 0);
	assert.deepEqual(record.data.changedKeys, ['headroomTokens', 'maxTokens', 'modelPolicies', 'thresholdRatio']);
	assert.equal(record.data.routes[0].provider, 'lc');
	assert.equal(record.data.routes[0].contextWindow, 131072);
	assert.equal(record.data.policies[0].headroomTokens, 9831, 'the per-route policy is legible for analysis');
	// It is not a surface event: nothing may join the request.
	assert.equal('surfaceOp' in record.data, false);

	// A no-op check records nothing, and a session that refuses the append cannot break the tuning.
	const quiet = stubSession();
	quiet.append = () => {
		throw new Error('session refused the record');
	};
	const noop = await tuneCompactionAtRuntime(stubContext({ rowConfig: { thresholdRatio: 0.8, headroomTokens: 0, maxTokens: 8192, modelPolicies: [{ provider: 'lc', model: '/models/q.gguf', thresholdRatio: 0.8, headroomTokens: 9831 }] } }), CONFIG(), { agent: { session: quiet }, signal });
	assert.equal(noop.result.kind, 'success', 'a refused record must not fail the tuning');
	assert.equal(quiet.appended.length, 0, 'the refused record never landed');

	const untouched = stubSession();
	const again = await tuneCompactionAtRuntime(stubContext({ rowConfig: { thresholdRatio: 0.8, headroomTokens: 0, maxTokens: 8192, modelPolicies: [{ provider: 'lc', model: '/models/q.gguf', thresholdRatio: 0.8, headroomTokens: 9831 }] } }), CONFIG(), { agent: { session: untouched }, signal });
	assert.equal(again.result.kind, 'success');
	assert.equal(untouched.appended.length, 0, 'an unchanged row writes no record');
});

test('a repeated identical failure is reported once, not once per request', async () => {
	const written = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk, ...rest) => {
		written.push(String(chunk));
		return original(chunk, ...rest);
	};
	try {
		// A web-like context: the guard refuses every time, and agent/request triggers every time.
		const ctx = stubContext({ plane: 'preset' });
		const auto = registerAutoTune(ctx, { autoTuneCompaction: true });
		const next = () => 'downstream';
		for (let i = 0; i < 4; i += 1) ctx.listeners.get('agent/request')({ agent }, next);
		await auto.pending();
		const lines = written.filter((line) => line.includes('agent-preset isolate realm'));
		assert.equal(lines.length, 1, `expected one report, got ${lines.length}`);

		// A later success clears the memory, so a subsequent failure would be reported again.
		const healthy = stubContext();
		registerAutoTune(healthy, { autoTuneCompaction: true });
		await healthy.listeners.get('agent/created')({ agent });
		assert.equal(healthy.edits.length, 1, 'a healthy context still tunes (and writes)');
	} finally {
		process.stderr.write = original;
	}
});
