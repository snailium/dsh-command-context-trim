/**
 * Tests for the truncation hint.
 *
 * A reply the provider cut short is not an error: the request succeeded, the
 * provider stopped generating. The automatic trim listens for
 * `CONTEXT_WINDOW_EXCEEDED`, so it never sees this case — and the user is left
 * with a turn that is silently missing its answer.
 *
 * The hint states the two numbers that tell the causes apart (how much the request
 * carried, and how much room the window had) and leaves the decision to the user.
 * It must never trim.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session, canonicalHeader } from '@deepseek-ai/dsh-session';
import { apply as applyPlugin } from '../lib/index.js';
import { stopReasonOf } from '../lib/truncation-hint.js';

/**
 * A stand-in for the token meter.
 *
 * The hint reads the request's size through the meter, and this test is about the
 * hint's logic, not the price. A stub also keeps the test independent of the
 * harness line: the meter folds every event's provider stream, and the finish
 * chunk this test needs (`max-tokens` / `length`) is a shape the older harness
 * lines do not know.
 *
 * @param surfaceTokens - the surface size the stub reports.
 * @returns a meter object with the meter's measure contract.
 */
function meterFor(surfaceTokens) {
	return {
		measure: () => ({
			logRevision: 0,
			baseline: { kind: 'estimated', tokens: 0 },
			surfaceDeltaTokens: 0,
			totalTokens: surfaceTokens,
			surfaceTokens,
			nodes: [{ seq: 1, heuristicTokens: surfaceTokens }]
		})
	};
}

/** A plugin context that keeps the listeners, so events can be delivered the way the harness delivers them. */
function pluginContextFor(meter, { contextWindow = 262144, maxTokens = 32768 } = {}) {
	const listeners = new Map();
	const warnings = [];
	const ctx = {
		effect(generator) {
			const iterator = generator();
			for (let step = iterator.next(); !step.done; step = iterator.next()) {
				// Drained for side effects.
			}
		},
		commands: { register: () => () => undefined },
		get: () => undefined,
		on(name, listener) {
			const entries = listeners.get(name) ?? [];
			entries.push(listener);
			listeners.set(name, entries);
			return () => undefined;
		},
		logger: {
			info: () => undefined,
			warn: (message) => warnings.push(message)
		},
		tokenMeter: meter,
		llm: {
			resolveModelInfo: async () => ({
				context: { contextWindow },
				defaultMaxTokens: maxTokens
			})
		}
	};
	applyPlugin(ctx, {});
	return { ctx, listeners, warnings };
}

/** Deliver one committed event to every `session/event` listener. */
function publish(listeners, session, event) {
	for (const listener of listeners.get('session/event') ?? []) listener(session, event);
}

/**
 * A session with one routed request: a header with an output allowance, the route's
 * context window, and a body of a known size.
 */
function buildSession({ provider = 'p', model = 'm', maxTokens = 32768, contextWindow = 262144, bodyChars = 40000 } = {}) {
	const session = Session.create('truncation-hint');
	session.append(
		'user/message',
		createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(bodyChars) }], source: { kind: 'user' } }),
		{ surfaceOp: 'append' }
	);
	session.append('request/context', { provider, model, contextWindow });
	session.append(
		'request/header',
		{ header: canonicalHeader({ config: { provider, model, maxTokens } }), reason: 'initial' },
		{ surfaceOp: undefined }
	);
	return session;
}

/** Append an assistant message that ends on the given stop reason. */
function reply(session, { reason = 'max-tokens', stopReason = 'length', text = 'partial answer' } = {}) {
	const turn = 1;
	session.append('turn/start', { turn });
	session.append('step/start', { turn, step: 1 });
	const event = session.append(
		'assistant/message',
		{
			turn,
			step: 1,
			stream: [
				{
					type: 'assistant',
					time: Date.now(),
					chunk: { type: 'finish', reason: { kind: reason }, replayState: { response: { stopReason } } }
				}
			],
			message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'p', model: 'm' } }),
			usage: { inputTokens: 1000, outputTokens: 1, totalTokens: 1001 }
		},
		{ surfaceOp: 'append' }
	);
	session.append('step/end', { turn, step: 1 });
	session.append('turn/end', { turn, reason: { kind: reason === 'max-tokens' ? 'max-tokens' : 'completed' } });
	return event;
}

/** The text of the last message the session carries. */
function lastMessageText(session) {
	const events = session.log.filter((event) => event.type === 'user/message');
	const last = events[events.length - 1];
	return last?.data?.content?.[0]?.text ?? '';
}

test('the stop reason is read from the finish chunk, in both shapes', () => {
	assert.equal(stopReasonOf({ data: { stream: [{ chunk: { type: 'finish', reason: { kind: 'max-tokens' } } }] } }), 'max-tokens');
	assert.equal(
		stopReasonOf({ data: { stream: [{ chunk: { type: 'finish', replayState: { response: { stopReason: 'length' } } } }] } }),
		'max-tokens'
	);
	assert.equal(stopReasonOf({ data: { stream: [{ chunk: { type: 'finish', reason: { kind: 'stop' } } }] } }), undefined);
	assert.equal(stopReasonOf({ data: { stream: [] } }), undefined);
	assert.equal(stopReasonOf(undefined), undefined);
});

test('a cut reply over the budget is reported with the request size and the window, and nothing is trimmed', () => {
	const { listeners, warnings } = pluginContextFor(meterFor(225000));
	const session = buildSession({ bodyChars: 900000 });

	const event = reply(session);
	publish(listeners, session, event);

	const text = lastMessageText(session);
	assert.match(text, /the provider cut the previous reply short/);
	assert.match(text, /of a 262144-token window/);
	assert.match(text, /over the 206438-token budget/);
	assert.match(text, /Run \/trim/);
	assert.match(text, /allowed 32768 tokens of output and produced 1/);
	// The hint names the real request size, not a heuristic estimate.
	assert.match(text, /~\d+ tokens of a 262144-token window/);
	// Nothing was trimmed: no prune event, and the body is still there.
	assert.equal(session.log.some((entry) => entry.type === 'compaction/prune'), false);
	assert.equal(session.log.filter((entry) => entry.type === 'user/message').length, 2);
	assert.match(session.log[0].data.content[0].text, /x{100}/);
	assert.equal(warnings.some((line) => line.includes('cut a reply short')), true);
});

test('a cut reply within the budget says the context is not what stopped it', () => {
	const { listeners } = pluginContextFor(meterFor(10020));
	const session = buildSession({ bodyChars: 40000 });
	const event = reply(session);
	publish(listeners, session, event);

	const text = lastMessageText(session);
	assert.match(text, /within the 206438-token budget/);
	assert.match(text, /the context is not what stopped it/);
	assert.doesNotMatch(text, /Run \/trim/);
	assert.equal(session.log.some((entry) => entry.type === 'compaction/prune'), false);
});

test('a reply that ended normally produces no hint', () => {
	const { listeners } = pluginContextFor(meterFor(10020));
	const session = buildSession();
	const event = reply(session, { reason: 'stop', stopReason: 'stop' });
	publish(listeners, session, event);
	assert.equal(session.log.filter((entry) => entry.type === 'user/message').length, 1);
});

test('one hint per episode: a normal reply clears it', () => {
	const { listeners } = pluginContextFor(meterFor(10020));
	const session = buildSession();

	const first = reply(session);
	publish(listeners, session, first);
	assert.equal(session.log.filter((entry) => entry.type === 'user/message').length, 2);

	// A second cut reply in the same stretch adds nothing.
	const second = reply(session);
	publish(listeners, session, second);
	assert.equal(session.log.filter((entry) => entry.type === 'user/message').length, 2);

	// A reply that ends normally ends the episode, so the next cut is reported again.
	const normal = reply(session, { reason: 'stop', stopReason: 'stop' });
	publish(listeners, session, normal);
	const third = reply(session);
	publish(listeners, session, third);
	assert.equal(session.log.filter((entry) => entry.type === 'user/message').length, 3);
});
