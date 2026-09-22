import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session } from '@deepseek-ai/dsh-session';
import { TRIM_MARKER, measureContent, pruneContent, shrinkOversizedToolResults } from '../lib/prune-first.js';
import { replaceKeys, replacementOp } from '../lib/session-compat.js';
import { resolveConfig } from '../lib/config.js';

const config = resolveConfig({});
/** Code-point length of our marker; budgets must leave room for it. */
const MARKER_CHARS = Array.from(TRIM_MARKER).length;

/** One open turn/step holding a task, an assistant tool call and one tool result. */
function buildSession(resultChars = 30_000) {
	const session = Session.create('prune-first-test');
	session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
	session.append('turn/start', { turn: 1 });
	session.append('step/start', { turn: 1, step: 1 });
	session.append(
		'assistant/message',
		{
			turn: 1,
			step: 1,
			stream: [],
			message: createAssistantMessage({
				content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' }],
				source: { provider: 'mock', model: 'mock-1' }
			})
		},
		{ surfaceOp: 'append' }
	);
	session.append(
		'tool/result',
		{
			turn: 1,
			step: 1,
			message: createToolResultMessage({
				callId: 'call-1',
				content: [{ type: 'text', text: 'h'.repeat(resultChars) }],
				isError: false
			})
		},
		{ surfaceOp: 'append' }
	);
	return session;
}

/** Plugin-context stub: no official pruner service, a meter pricing content by /4. */
const stubContext = () => ({
	get: () => undefined,
	tokenMeter: { estimateMessage: (message) => Math.ceil(JSON.stringify(message.content).length / 4) + 4 }
});

test('pruneContent keeps head, marker and tail within the budget', () => {
	const budget = { ...config, pruneThresholdChars: 100 + MARKER_CHARS + 40 + 20, pruneHeadChars: 100, pruneTailChars: 40 };
	assert.equal(pruneContent([{ type: 'text', text: 'a'.repeat(150) }], budget), null, 'within budget is untouched');
	const out = pruneContent([{ type: 'text', text: 'a'.repeat(400) }], budget);
	assert.ok(out !== null);
	const text = out[0].text;
	assert.ok(text.startsWith('a'.repeat(100)));
	assert.ok(text.endsWith('a'.repeat(40)));
	assert.ok(text.includes(TRIM_MARKER));
	assert.equal(measureContent(out), 100 + MARKER_CHARS + 40);
});

test('pruneContent refuses a rewrite that could not both shrink and comply', () => {
	// head + marker + tail would exceed the threshold: the guard must decline.
	const budget = { ...config, pruneThresholdChars: 100, pruneHeadChars: 90, pruneTailChars: 20 };  // 90 + marker + 20 > 100
	assert.equal(pruneContent([{ type: 'text', text: 'a'.repeat(400) }], budget), null);
});

test('pruneContent slices by code point, never splitting a surrogate pair', () => {
	const emoji = '😀'.repeat(100); // 100 code points, 200 UTF-16 units
	const out = pruneContent([{ type: 'text', text: emoji }], { ...config, pruneThresholdChars: 10 + MARKER_CHARS + 5 + 10, pruneHeadChars: 10, pruneTailChars: 5 });
	assert.ok(out !== null);
	const text = out[0].text;
	assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text), 'no lone surrogate survives');
	assert.ok(text.includes(TRIM_MARKER));
	assert.equal(measureContent(out), 10 + MARKER_CHARS + 5);
});

test('measureContent counts only text blocks', () => {
	assert.equal(measureContent([{ type: 'text', text: 'abcd' }, { type: 'image', attachment: 'x' }, { type: 'text', text: 'ef' }]), 6);
});

test('shrinks an oversized tool result in place, preserving the call pairing and the step', () => {
	const session = buildSession(30_000);
	const seq = session.surface.nodes.at(-1);
	const before = session.eventAt(seq);
	const outcome = shrinkOversizedToolResults(stubContext(), session, config);
	assert.equal(outcome.pruned, 1);
	assert.equal(outcome.via, 'inline');
	const claim = session.eventAt(session.seq - 2);
	const replacement = session.eventAt(session.seq - 1);
	assert.equal(claim.type, 'compaction/prune');
	assert.deepEqual([...claim.data.shadowedSeqs], [seq]);
	assert.equal(claim.data.shadowedTokenCount, stubContext().tokenMeter.estimateMessage(before.data.message));
	assert.equal(replacement.type, 'tool/result');
	assert.deepEqual(replacement.surfaceOp, replacementOp(replaceKeys(), seq, seq));
	assert.deepEqual([...replacement.sourceEventSeqs], [seq]);
	// Complete event data except content: the tool call keeps its result, same step.
	assert.equal(replacement.data.turn, before.data.turn);
	assert.equal(replacement.data.step, before.data.step);
	assert.equal(replacement.data.message.source.callId, 'call-1');
	assert.equal(replacement.data.message.content[0].toolCallId, 'call-1');
	const text = replacement.data.message.content[0].content[0].text;
	assert.ok(text.startsWith('h'.repeat(4096)));
	assert.ok(text.endsWith('h'.repeat(1024)));
	assert.ok(text.includes(TRIM_MARKER));
	assert.ok(text.length < 30_000);
	// The surface position is unchanged, so the assistant's tool call still has its result.
	assert.deepEqual([...session.surface.nodes].at(-1), replacement.seq);
});

test('leaves tool results within budget alone', () => {
	const session = buildSession(1_000);
	const seqBefore = session.seq;
	const outcome = shrinkOversizedToolResults(stubContext(), session, config);
	assert.equal(outcome.pruned, 0);
	assert.equal(session.seq, seqBefore);
});

test('delegates to the official pruner service when it is reachable', () => {
	const session = buildSession(30_000);
	const calls = [];
	const ctx = {
		...stubContext(),
		get: (name) => (name === 'toolResultPruner' ? { pruneSession: (target) => (calls.push(target), { pruned: [{ replacementSeq: 99 }] }) } : undefined)
	};
	const seqBefore = session.seq;
	const outcome = shrinkOversizedToolResults(ctx, session, config);
	assert.equal(outcome.via, 'service');
	assert.equal(outcome.pruned, 1);
	assert.equal(outcome.replacementSeq, 99);
	assert.equal(calls.length, 1);
	assert.equal(session.seq, seqBefore, 'the official pruner owns its own appends');
});

test('preferInPlacePrune: false disables the whole step', () => {
	const session = buildSession(30_000);
	const seqBefore = session.seq;
	const outcome = shrinkOversizedToolResults(stubContext(), session, resolveConfig({ preferInPlacePrune: false }));
	assert.deepEqual(outcome, { pruned: 0, via: 'disabled' });
	assert.equal(session.seq, seqBefore);
});

test('config validates the prune budgets', () => {
	assert.throws(() => resolveConfig({ pruneThresholdChars: 100, pruneHeadChars: 90, pruneTailChars: 20 }), /must be at most pruneThresholdChars/);
	assert.throws(() => resolveConfig({ pruneThresholdChars: 0 }), /must be a positive integer/);
	assert.throws(() => resolveConfig({ preferInPlacePrune: 'yes' }), /must be a boolean/);
	assert.equal(resolveConfig({}).preferInPlacePrune, true);
});
