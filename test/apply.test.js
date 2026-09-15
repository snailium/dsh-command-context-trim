import assert from 'node:assert/strict';
import test from 'node:test';
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session } from '@deepseek-ai/dsh-session';
import { applyTrim, createMarkerMessage, isTrimMarkerSource } from '../lib/apply.js';

const taskMessage = (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });

const assistantWithToolCall = (callId) =>
	createAssistantMessage({
		content: [
			{ type: 'text', text: 'working' },
			{ type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"ls"}' }
		],
		source: { provider: 'p', model: 'm' }
	});

const toolResult = (callId) =>
	createToolResultMessage({ callId, content: [{ type: 'text', text: 'output' }], isError: false });

/** One task statement, then `turns` assistant(tool-call)/tool-result pairs. */
function buildSession(turns = 4) {
	const session = Session.create('trim-test');
	session.append('user/message', taskMessage('do the thing'), { surfaceOp: 'append' });
	for (let turn = 1; turn <= turns; turn += 1) {
		session.append('assistant/message', { turn, step: 1, message: assistantWithToolCall(`call-${turn}`) }, { surfaceOp: 'append' });
		session.append('tool/result', { turn, step: 1, message: toolResult(`call-${turn}`) }, { surfaceOp: 'append' });
	}
	return session;
}

/** A plan naming a real surface span of `session`, priced by the caller. */
function planFor(session, startIndex, endIndex, shadowedTokens) {
	const nodes = session.surface.nodes;
	return {
		startIndex,
		endIndex,
		startSeq: nodes[startIndex],
		endSeq: nodes[endIndex],
		shadowedSeqs: nodes.slice(startIndex, endIndex + 1),
		shadowedTokens,
		freedTokens: shadowedTokens - 10
	};
}

test('appends a prune claim then a replacement shadowing the span', () => {
	const session = buildSession();
	const before = [...session.surface.nodes];
	const plan = planFor(session, 1, 4, 4000);
	const replacement = applyTrim(session, plan, createMarkerMessage(plan, 'lc:m', 8192));
	const claim = session.eventAt(replacement.seq - 1);
	assert.equal(claim.type, 'compaction/prune');
	assert.deepEqual([...claim.data.shadowedSeqs], [...plan.shadowedSeqs]);
	assert.deepEqual(claim.data.shadowedRange, { start: plan.startSeq, end: plan.endSeq });
	assert.equal(claim.data.shadowedTokenCount, 4000);
	assert.equal(replacement.seq, claim.seq + 1);
	assert.equal(replacement.type, 'user/message');
	assert.deepEqual(replacement.surfaceOp, { op: 'replace', start: plan.startSeq, end: plan.endSeq });
	assert.deepEqual([...replacement.sourceEventSeqs].sort((a, b) => a - b), [...plan.shadowedSeqs]);
	assert.equal(isTrimMarkerSource(replacement.data.source), true);
	assert.match(replacement.data.content[0].text, /^\[context-trim\] 4 earlier messages/);
	assert.deepEqual(session.surface.nodes, [...before.slice(0, 1), replacement.seq, ...before.slice(5)]);
});

test('keeps every shadowed event in the durable log', () => {
	const session = buildSession();
	const plan = planFor(session, 1, 4, 4000);
	applyTrim(session, plan, createMarkerMessage(plan, 'lc:m', 8192));
	for (const seq of plan.shadowedSeqs) {
		const event = session.eventAt(seq);
		assert.ok(event !== undefined, `seq ${seq} disappeared from the log`);
		assert.equal(event.surfaceOp, 'append');
	}
	assert.equal(session.seq, session.snapshotEvents().length);
});

test('a trimmed log replays into the same surface', () => {
	const session = buildSession();
	const plan = planFor(session, 1, 4, 4000);
	const replacement = applyTrim(session, plan, createMarkerMessage(plan, 'lc:m', 8192));
	const replay = Session.create('trim-test', session.snapshotEvents(), session.header);
	assert.deepEqual(replay.surface.nodes, session.surface.nodes);
	const replayed = replay.eventAt(replacement.seq);
	assert.equal(replayed.type, 'user/message');
	assert.equal(isTrimMarkerSource(replayed.data.source), true);
	assert.equal(replayed.surfaceOp.op, 'replace');
	assert.deepEqual([...replay.eventAt(replacement.seq - 1).data.shadowedSeqs], [...plan.shadowedSeqs]);
});

test('tool-pairing balance rejects cut points inside a call/result pair', () => {
	const session = buildSession();
	const nodes = session.surface.nodes;
	assert.equal(toolPairingBalancedBefore(session, nodes[0]), true);
	assert.equal(toolPairingBalancedBefore(session, nodes[1]), true);
	assert.equal(toolPairingBalancedAfter(session, nodes[1]), false);
	assert.equal(toolPairingBalancedAfter(session, nodes[2]), true);
	assert.equal(toolPairingBalancedAfter(session, nodes[3]), false);
	assert.equal(toolPairingBalancedAfter(session, nodes[4]), true);
});

test('rejects a replacement range that is not on the current surface', () => {
	const session = buildSession();
	const plan = { startSeq: 1, endSeq: 999, shadowedSeqs: [1, 999], shadowedTokens: 1 };
	assert.throws(
		() => applyTrim(session, plan, createMarkerMessage(plan, 'lc:m', 8192)),
		/surface replace/
	);
});

test('rejects a replacement whose citations miss a shadowed node', () => {
	const session = buildSession();
	const nodes = session.surface.nodes;
	assert.throws(
		() =>
			session.append('user/message', taskMessage('marker'), {
				surfaceOp: { op: 'replace', start: nodes[1], end: nodes[4] },
				sourceEventSeqs: [nodes[1], nodes[4]]
			}),
		/missing/
	);
});
