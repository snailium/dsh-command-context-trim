import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { findCompactionRow, mergeTunedConfig, registerAutoTune, registerPresetSync, tuneCompactionAtRuntime } from '../lib/tune-runtime.js';
import { resolveConfig } from '../lib/config.js';

const CATALOG = { lc: { '/models/q.gguf': { contextWindow: 131072, defaultMaxTokens: 16384 } } };

/** Context stub with a profile-plane compaction row, an editor that records writes, and an llm catalogue. */
function stubContext(request = {}) {
	const edits = [];
	const listeners = new Map();
	const rowConfig = request.rowConfig ?? { auto: true, retainRatio: 0.16 };
	const row = { options: { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: rowConfig }, fiber: { state: request.rowState ?? 2 } };
	const prunerRow = { options: { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: request.prunerConfig ?? { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } }, fiber: { state: 2 } };
	const ctx = {
		edits,
		listeners,
		get(name) {
			if (name === 'agentPresets') return request.presetRegistryMissing === true ? undefined : request.presetRegistry;
			if (name === 'compaction') return request.plane === 'preset' ? undefined : {};
			if (name === 'toolResultPruner') return request.prunerUnreachable === true ? undefined : {};
			if (name === 'configEditor') {
				if (request.editorMissing === true) return undefined;
				return {
					entries: () => [
						request.withoutRow === true ? undefined : row,
						request.withoutPrunerRow === true ? undefined : prunerRow,
						{ options: { id: 'llm-pi-ai', config: { providers: { lc: { models: [{ id: '/models/q.gguf' }] } } } } }
					].filter(Boolean),
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
const CONFIG = () => resolveConfig({ prunerThresholdChars: 0 });

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
	const auto = registerAutoTune(on, { autoTuneCompaction: true, prunerThresholdChars: 0 });
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
	CATALOG.lc['/models/q.gguf'] = { contextWindow: 200000, defaultMaxTokens: 8192 };
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
	CATALOG.lc['/models/q.gguf'] = { contextWindow: 300000, defaultMaxTokens: 8192 };
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
		registerAutoTune(ctx, { autoTuneCompaction: true, prunerThresholdChars: 0 });
		const auto = registerAutoTune(stubContext(), { autoTuneCompaction: true, prunerThresholdChars: 0 });

		const fresh = stubContext();
		const handle = registerAutoTune(fresh, { autoTuneCompaction: true, prunerThresholdChars: 0 });
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
		const ctx = /* No preset registry: this case is about the refusal path, so the auto-sync cannot take over. */
		stubContext({ plane: 'preset', presetRegistryMissing: true });
		const auto = registerAutoTune(ctx, { autoTuneCompaction: true, prunerThresholdChars: 0 });
		const next = () => 'downstream';
		for (let i = 0; i < 4; i += 1) ctx.listeners.get('agent/request')({ agent }, next);
		await auto.pending();
		const lines = written.filter((line) => line.includes('agent-preset isolate realm'));
		assert.equal(lines.length, 1, `expected one report, got ${lines.length}`);

		// A later success clears the memory, so a subsequent failure would be reported again.
		const healthy = stubContext();
		registerAutoTune(healthy, { autoTuneCompaction: true, prunerThresholdChars: 0 });
		await healthy.listeners.get('agent/created')({ agent });
		assert.equal(healthy.edits.length, 1, 'a healthy context still tunes (and writes)');
	} finally {
		process.stderr.write = original;
	}
});

test('an inventory that is not ready yet is a deferral, not a reported failure', async () => {
	// Reproduced from a real headless boot: the earliest trigger can fire before the route inventory
	// exists, and reporting it put a misleading line in front of a successful retune in the same boot.
	const bareListeners = new Map();
	const bare = {
		on: (name, listener) => bareListeners.set(name, listener),
		get: (name) => (name === 'compaction' ? {} : name === 'configEditor' ? {
			entries: () => [{ options: { id: 'compaction-basic', config: {} }, fiber: { state: 2 } }],
			edit: async () => {
				throw new Error('must not be called');
			}
		} : undefined),
		logger: { info() {}, warn() {}, debug() {} }
	};
	const deferred = await tuneCompactionAtRuntime(bare, CONFIG(), { agent, signal });
	assert.equal(deferred.result.kind, 'deferred', deferred.result.text);
	assert.match(deferred.result.text, /no routable provider\/model pairs are visible yet/);
	assert.match(deferred.result.text, /next trigger will retry/);
	assert.match(deferred.result.text, /\/trim tune check reports it on demand/);

	// The automatic path must stay silent about it: no stderr, no failure memory.
	const written = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk, ...rest) => {
		written.push(String(chunk));
		return original(chunk, ...rest);
	};
	try {
		const auto = registerAutoTune(bare, { autoTuneCompaction: true, prunerThresholdChars: 0 });
		void auto;
		await bareListeners.get('agent/created')({ agent });
		assert.equal(written.length, 0, `expected silence, got ${JSON.stringify(written)}`);
	} finally {
		process.stderr.write = original;
	}
});

test('prunerThresholdChars writes the pruner row alongside the compaction row', async () => {
	const ctx = stubContext();
	const applied = await tuneCompactionAtRuntime(ctx, resolveConfig({ prunerThresholdChars: 32768 }), { agent, signal });
	assert.equal(applied.result.kind, 'success', applied.result.text);
	// Both rows on the profile plane are retuned; the pruner is planned first only because its outcome
	// decides whether anything needs writing at all.
	assert.deepEqual([...ctx.edits.map((edit) => edit.id)].sort(), ['compaction-basic', 'tool-result-pruner']);
	const prunerEdit = ctx.edits.find((edit) => edit.id === 'tool-result-pruner');
	assert.equal(prunerEdit.next.thresholdChars, 32768);
	assert.equal(prunerEdit.next.headChars, 4096, 'the other pruner keys are preserved');
	assert.match(applied.result.text, /tool-result-pruner \(thresholdChars 8192 -> 32768\)/);
	assert.match(applied.result.text, /Retuned compaction-basic .*; tool-result-pruner/);

	// The session record carries both, so an analysis pass can see them together.
	assert.deepEqual(session.appended.at(-1)?.data.pruner, { thresholdChars: 32768 });
	assert.equal(session.appended.at(-1)?.type, 'context-trim/tuned');
});

test('the pruner is derived by default, 0 opts out, and unreachable is a note rather than a failure', async () => {
	// The default is `auto`: the tuner derives the pruner value from the routed window. The stub route is
	// 131072/16384, so the formula gives max(8192, min(32768, 2*(131072-16384))) = 32768.
	const derived = stubContext();
	const derivedRun = await tuneCompactionAtRuntime(derived, resolveConfig({}), { agent, signal });
	const derivedEdit = derived.edits.find((edit) => edit.id === 'tool-result-pruner');
	assert.ok(derivedEdit, 'auto writes the pruner row');
	assert.equal(derivedEdit.next.thresholdChars, 32768);
	assert.match(derivedRun.result.text, /Pruner: thresholdChars 8192 -> 32768 \(auto:/u);
	assert.deepEqual(session.appended.at(-1)?.data.pruner, { thresholdChars: 32768 });

	// `0` is the explicit opt-out.
	const untouched = stubContext();
	await tuneCompactionAtRuntime(untouched, resolveConfig({ prunerThresholdChars: 0 }), { agent, signal });
	assert.equal(untouched.edits.length, 1, 'an explicit 0 leaves the pruner alone');
	assert.doesNotMatch(untouched.edits[0].id, /pruner/);

	// A web profile keeps the pruner inside each session's preset: the grid is absent.
	const web = stubContext({ prunerUnreachable: true });
	const result = await tuneCompactionAtRuntime(web, resolveConfig({ prunerThresholdChars: 32768 }), { agent, signal });
	assert.equal(result.result.kind, 'success', 'the compaction half still succeeded');
	assert.deepEqual(web.edits.map((edit) => edit.id), ['compaction-basic']);
	assert.match(result.result.text, /Pruner: not reachable from this plane .*preset.*left alone/s);

	// A profile that declares no pruner row is also a note.
	const bare = stubContext({ withoutPrunerRow: true });
	const bareResult = await tuneCompactionAtRuntime(bare, resolveConfig({ prunerThresholdChars: 32768 }), { agent, signal });
	assert.deepEqual(bare.edits.map((edit) => edit.id), ['compaction-basic']);
	assert.match(bareResult.result.text, /declares no tool-result-pruner row/);

	// Already at the wanted value: nothing to do, and check mode never writes.
	const same = stubContext({ prunerConfig: { thresholdChars: 32768 } });
	await tuneCompactionAtRuntime(same, resolveConfig({ prunerThresholdChars: 32768 }), { agent, signal });
	assert.equal(same.edits.some((edit) => edit.id === 'tool-result-pruner'), false);
	const checked = stubContext();
	const checkRun = await tuneCompactionAtRuntime(checked, resolveConfig({ prunerThresholdChars: 32768 }), { agent, signal, check: true });
	assert.equal(checked.edits.length, 0, 'check never writes');
	assert.match(checkRun.result.text, /Pruner: thresholdChars 8192 -> 32768 would change \(check: nothing written\)/);
});

test('registerPresetSync registers one listener and never throws', async () => {
	// The behavioural half of this lives in an isolated web instance (it needs a real preset registry). Here we pin
	// the contract the plugin entry relies on: one listener, a disposer, and no escaping error on the first agent.
	const listeners = new Map();
	const ctx = stubContext({ plane: 'preset' });
	ctx.on = (event, handler) => {
		listeners.set(event, handler);
		return () => listeners.delete(event);
	};
	const dispose = registerPresetSync(ctx, CONFIG());
	assert.equal(typeof dispose, 'function');
	assert.deepEqual([...listeners.keys()], ['agent/created']);
	await listeners.get('agent/created')({ agent });
	await new Promise((resolve) => setTimeout(resolve, 20));
	dispose();
	assert.equal(listeners.size, 0, 'the disposer unhooks the listener');
});
