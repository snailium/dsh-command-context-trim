import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session, deriveEventMessage } from '@deepseek-ai/dsh-session';
import { registerAutoTrim } from '../lib/auto-trim.js';
import { resolveConfig } from '../lib/config.js';

/** Heuristic node price, matching the token meter's own /4 vocabulary. */
const priceMessage = (message) => Math.ceil(JSON.stringify(message.content).length / 4) + 4;

/** Minimal token meter pricing a real session surface. */
const stubMeter = () => ({
	measure(session) {
		const nodes = session.surface.nodes.map((seq) => {
			const message = deriveEventMessage(session.eventAt(seq));
			return { seq, heuristicTokens: message === null ? 0 : priceMessage(message) };
		});
		const surfaceTokens = nodes.reduce((total, node) => total + node.heuristicTokens, 0);
		return { nodes, surfaceTokens, totalTokens: surfaceTokens };
	},
	estimateMessage: priceMessage
});

const taskMessage = (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });

/** One task statement plus fat assistant/tool-result pairs on the surface. */
function buildSession(pairs = 8) {
	const session = Session.create('auto-trim-test');
	session.append('user/message', taskMessage('Build the thing.'), { surfaceOp: 'append' });
	for (let turn = 1; turn <= pairs; turn += 1) {
		session.append('turn/start', { turn });
		session.append('step/start', { turn, step: 1 });
		session.append(
			'assistant/message',
			{
				turn,
				step: 1,
				stream: [],
				message: createAssistantMessage({
					content: [
						{ type: 'text', text: 'x'.repeat(4000) },
						{ type: 'tool-call', id: `call-${turn}`, name: 'bash', arguments: '{"command":"ls"}' }
					],
					source: { provider: 'mock', model: 'mock-1' }
				})
			},
			{ surfaceOp: 'append' }
		);
		session.append(
			'tool/result',
			{
				turn,
				step: 1,
				message: createToolResultMessage({ callId: `call-${turn}`, content: [{ type: 'text', text: 'y'.repeat(4000) }], isError: false })
			},
			{ surfaceOp: 'append' }
		);
		session.append('step/end', { turn, step: 1 });
		session.append('turn/end', { turn, reason: 'completed' });
	}
	return session;
}

/** Agent stub: a session, a fallback route, and idle-maintenance passthrough. */
const stubAgent = (session) => ({
	session,
	options: { provider: 'mock', model: 'mock-1' },
	runMaintenance: (job) => job(new AbortController().signal)
});

/** Capture the listeners this plugin registers without a full cordis host. */
function captureContext(config) {
	const listeners = new Map();
	const logs = [];
	const ctx = {
		logger: {
			info: (message) => logs.push(String(message)),
			warn: (message) => logs.push(String(message))
		},
		on(name, listener, options) {
			const entries = listeners.get(name) ?? [];
			entries.push({ listener, options });
			listeners.set(name, entries);
			return () => undefined;
		},
		tokenMeter: stubMeter(),
		llm: { resolveModelInfo: async () => ({ context: { contextWindow: 16000 } }) },
		get: () => undefined
	};
	registerAutoTrim(ctx, resolveConfig(config));
	return {
		ctx,
		logs,
		listener: (name) => listeners.get(name)?.[0],
		entries: (name) => listeners.get(name) ?? []
	};
}

const overflow = { code: 'CONTEXT_WINDOW_EXCEEDED' };

// ── the mechanism the automatic path depends on ─────────────────────────────

test('cordis: a prepended listener runs first and can veto the rest of the waterfall', async () => {
	const ctx = new Context();
	const seen = [];
	ctx.on('agent/request-error', async (payload, next) => {
		seen.push('registered-first');
		return next();
	});
	ctx.on(
		'agent/request-error',
		async (payload, next) => {
			seen.push('prepended');
			return { kind: 'retry' };
		},
		{ prepend: true }
	);
	const action = await ctx.waterfall('agent/request-error', { failure: overflow }, () => {
		seen.push('inner');
		return undefined;
	});
	assert.deepEqual(seen, ['prepended'], 'a prepended listener that returns without next() must veto the chain');
	assert.deepEqual(action, { kind: 'retry' });
});

test('cordis: without prepend the earlier registration wins (why prepend is required)', async () => {
	const ctx = new Context();
	const seen = [];
	ctx.on('agent/request-error', async (payload, next) => {
		seen.push('first');
		return { kind: 'retry' };
	});
	ctx.on('agent/request-error', async (payload, next) => {
		seen.push('second');
		return next();
	});
	await ctx.waterfall('agent/request-error', { failure: overflow }, () => undefined);
	assert.deepEqual(seen, ['first']);
});

test('the plugin registers its overflow listener prepended', () => {
	const { entries } = captureContext({});
	const entry = entries('agent/request-error')[0];
	assert.equal(entry.options?.prepend, true);
});

// ── the handler's behaviour ─────────────────────────────────────────────────

test('it trims on the context wall and asks for a retry without summarising', async () => {
	const { listener } = captureContext({ maxAutoTrimRetries: 1 });
	const session = buildSession();
	const agent = stubAgent(session);
	const generation = session.surface.replaceGeneration;
	let nexted = false;
	const action = await listener('agent/request-error').listener({ agent, failure: overflow, signal: new AbortController().signal }, () => {
		nexted = true;
		return undefined;
	});
	assert.deepEqual(action, { kind: 'retry' });
	assert.equal(nexted, false, 'the chain (compaction summarisation) must not run after a successful trim');
	assert.ok(session.surface.replaceGeneration > generation, 'the surface must actually shrink');
	assert.equal(session.eventAt(session.seq - 1).type, 'user/message');
	assert.equal(session.eventAt(session.seq - 2).type, 'compaction/prune');
});

test('it leaves unrelated failures and aborted turns to the rest of the chain', async () => {
	const { listener } = captureContext({});
	const session = buildSession();
	const agent = stubAgent(session);
	const seq = session.seq;
	let calls = 0;
	const next = () => {
		calls += 1;
		return undefined;
	};
	await listener('agent/request-error').listener({ agent, failure: { code: 'RATE_LIMIT' }, signal: new AbortController().signal }, next);
	const aborted = new AbortController();
	aborted.abort();
	await listener('agent/request-error').listener({ agent, failure: overflow, signal: aborted.signal }, next);
	assert.equal(calls, 2);
	assert.equal(session.seq, seq, 'nothing may be trimmed');
});

test('it exhausts its retry budget and then defers to compaction', async () => {
	const { listener } = captureContext({ maxAutoTrimRetries: 1 });
	const session = buildSession();
	const agent = stubAgent(session);
	const next = () => undefined;
	assert.deepEqual(await listener('agent/request-error').listener({ agent, failure: overflow, signal: new AbortController().signal }, next), {
		kind: 'retry'
	});
	const seq = session.seq;
	assert.equal(await listener('agent/request-error').listener({ agent, failure: overflow, signal: new AbortController().signal }, next), undefined);
	assert.equal(session.seq, seq, 'the second overflow must not trim again inside the same episode');
});

test('an assistant message resets the retry budget', async () => {
	const { listener, entries, logs } = captureContext({ maxAutoTrimRetries: 1 });
	const session = buildSession();
	const agent = stubAgent(session);
	const next = () => undefined;
	const first = await listener('agent/request-error').listener({ agent, failure: overflow, signal: new AbortController().signal }, next);
	assert.deepEqual(first, { kind: 'retry' }, 'the first overflow must trim');
	// The conversation advanced: the same session reports a completed assistant message.
	session.append(
		'assistant/message',
		{ turn: 99, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'mock', model: 'mock-1' } }) },
		{ surfaceOp: 'append' }
	);
	for (const entry of entries('session/event')) {
		entry.listener(session, { type: 'assistant/message' });
	}
	// The first trim brought the request under budget; grow the conversation again
	// so a second overflow is genuinely over the line.
	session.append('turn/start', { turn: 99 });
	session.append('step/start', { turn: 99, step: 1 });
	session.append(
		'assistant/message',
		{
			turn: 99,
			step: 1,
			stream: [],
			message: createAssistantMessage({
				content: [
					{ type: 'text', text: 'z'.repeat(4000) },
					{ type: 'tool-call', id: 'call-99', name: 'bash', arguments: '{"command":"ls"}' }
				],
				source: { provider: 'mock', model: 'mock-1' }
			})
		},
		{ surfaceOp: 'append' }
	);
	session.append(
		'tool/result',
		{ turn: 99, step: 1, message: createToolResultMessage({ callId: 'call-99', content: [{ type: 'text', text: 'w'.repeat(4000) }], isError: false }) },
		{ surfaceOp: 'append' }
	);
	session.append('step/end', { turn: 99, step: 1 });
	session.append('turn/end', { turn: 99, reason: 'completed' });
	// With the budget refreshed, the next overflow is handled again rather than
	// short-circuiting on "retry budget spent".
	logs.length = 0;
	await listener('agent/request-error').listener({ agent, failure: overflow, signal: new AbortController().signal }, next);
	assert.equal(
		logs.some((line) => line.includes('retry budget spent')),
		false,
		'the budget must be fresh after a completed assistant message'
	);
});

test('it defers when the fixed request envelope already exceeds the budget', async () => {
	const { ctx, listener } = captureContext({});
	// An envelope larger than any budget makes every span plan infeasible.
	ctx.tokenMeter = {
		measure(session) {
			const priced = stubMeter().measure(session);
			return { ...priced, totalTokens: priced.surfaceTokens + 50000 };
		},
		estimateMessage: priceMessage
	};
	const session = buildSession(1);
	const agent = stubAgent(session);
	const seq = session.seq;
	let nexted = false;
	const action = await listener('agent/request-error').listener({ agent, failure: overflow, signal: new AbortController().signal }, () => {
		nexted = true;
		return undefined;
	});
	assert.equal(action, undefined);
	assert.equal(nexted, true, 'compaction must get its chance when trimming cannot help');
	assert.equal(session.seq, seq);
});

test('it defers when the target route declares no window', async () => {
	const { ctx, listener } = captureContext({});
	ctx.llm = {
		resolveModelInfo: async () => {
			throw new Error('unknown model route mock:mock-1');
		}
	};
	const session = buildSession();
	const agent = stubAgent(session);
	const seq = session.seq;
	let nexted = false;
	await listener('agent/request-error').listener({ agent, failure: overflow, signal: new AbortController().signal }, () => {
		nexted = true;
		return undefined;
	});
	assert.equal(nexted, true);
	assert.equal(session.seq, seq);
});

test('autoTrim: false registers no overflow listener at all', () => {
	const { entries } = captureContext({ autoTrim: false });
	assert.equal(entries('agent/request-error').length, 0);
});

test('it never touches ordinary compaction: no pre-step/pressure hook is registered', () => {
	const { entries } = captureContext({});
	const names = [...new Set([...entries('agent/pre-step'), ...entries('agent/request-error')])].length;
	assert.equal(names > 0, true);
	assert.equal(entries('agent/pre-step').length, 0, 'pressure compaction must stay untouched');
	assert.equal(entries('session/event').length, 1, 'only the assistant-message budget reset');
	assert.equal(entries('agent/status').length, 1, 'only the idle budget reset');
	// and the overflow listener is gated on the context-wall code, nothing else
	const source = entries('agent/request-error')[0].listener.toString();
	assert.match(source, /CONTEXT_WINDOW_EXCEEDED/);
});

test('a repeat overflow retargets to a fraction of the request that just failed', async () => {
	const { listener } = captureContext({ maxAutoTrimRetries: 3, autoTrimShrink: 0.5 });
	const session = buildSession();
	const agent = stubAgent(session);
	const next = () => undefined;
	const overflowCall = () => listener('agent/request-error').listener({ agent, failure: overflow, signal: new AbortController().signal }, next);

	assert.deepEqual(await overflowCall(), { kind: 'retry' }, 'the first attempt trusts the declared window');
	const afterFirst = stubMeter().measure(session).totalTokens;
	// Simulate the retry being rejected again: the declared window lied.
	const action = await overflowCall();
	assert.deepEqual(action, { kind: 'retry' });
	const afterSecond = stubMeter().measure(session).totalTokens;
	assert.ok(
		afterSecond <= Math.floor(afterFirst * 0.5) + 64,
		`the repeat attempt must halve the failing request (${afterFirst} -> ${afterSecond})`
	);
});

test('a repeat overflow says the declared contextWindow does not match the backend', async () => {
	const { listener, logs } = captureContext({ maxAutoTrimRetries: 3, autoTrimShrink: 0.5 });
	const session = buildSession();
	const agent = stubAgent(session);
	const next = () => undefined;
	const overflowCall = () => listener('agent/request-error').listener({ agent, failure: overflow, signal: new AbortController().signal }, next);
	await overflowCall();
	logs.length = 0;
	await overflowCall();
	assert.equal(
		logs.some((line) => line.includes('contextWindow is larger than the backend actually serves')),
		true,
		'the second attempt must point at the misdeclared window'
	);
});
