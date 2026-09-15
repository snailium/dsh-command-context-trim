import assert from 'node:assert/strict';
import test from 'node:test';
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { Context } from '@deepseek-ai/cordis';
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session } from '@deepseek-ai/dsh-session';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { applyTrim, createMarkerMessage, provisionalMarker } from '../lib/apply.js';
import { apply as applyPlugin } from '../lib/index.js';
import { planTrim } from '../lib/plan.js';

/**
 * Integration tests against the REAL token meter.
 *
 * The meter's service constructor needs a cordis Context (it registers session
 * projections), so a bare `new Context()` plus a stub projection registry is
 * enough to exercise the real fold — including the shadow-price contract our
 * `compaction/prune` claim participates in.
 */
function meterFor() {
	const ctx = new Context();
	ctx.sessionProjections = { register: () => () => undefined };
	return { ctx, meter: new TokenMeter(ctx, {}) };
}

const taskMessage = () =>
	createUserMessage({ content: [{ type: 'text', text: 'Build the thing and report back.' }], source: { kind: 'user' } });

/** Real turn/step brackets matter: the meter folds assistant messages by step. */
function buildSession(pairs = 8) {
	const session = Session.create('meter-test');
	session.append('user/message', taskMessage(), { surfaceOp: 'append' });
	for (let turn = 1; turn <= pairs; turn += 1) {
		session.append('turn/start', { turn });
		session.append('step/start', { turn, step: 1 });
		session.append(
			'assistant/message',
			{
				turn,
				step: 1,
				message: createAssistantMessage({
					content: [
						{ type: 'text', text: 'x'.repeat(4000) },
						{ type: 'tool-call', id: `call-${turn}`, name: 'bash', arguments: '{"command":"ls"}' }
					],
					source: { provider: 'p', model: 'm' }
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

/** Cordis-shaped plugin context capturing the `/trim` registration. */
function trimHandlerFor(meter) {
	const commands = new Map();
	applyPlugin(
		{
			effect(generator) {
				const iterator = generator();
				for (let step = iterator.next(); !step.done; step = iterator.next());
			},
			commands: { register: (definition) => (commands.set(definition.name, definition), () => undefined) },
			tokenMeter: meter,
			get: () => undefined
		},
		{}
	);
	return commands.get('trim').handler;
}

/** Run one explicit-budget trim (no LLM seam needed) inside a stub idle reservation. */
async function trim(session, meter, rawInput) {
	const agent = { session, options: {}, runMaintenance: (job) => job(new AbortController().signal) };
	return trimHandlerFor(meter)({ agent, rawInput, signal: new AbortController().signal });
}

test('the planner cuts the same span the meter prices', () => {
	const { meter } = meterFor();
	const session = buildSession();
	const measurement = meter.measure(session);
	const plan = planTrim({
		nodes: measurement.nodes.map((node) => ({ seq: node.seq, heuristicTokens: node.heuristicTokens })),
		envelopeTokens: 0,
		budget: 8000,
		markerCost: meter.estimateMessage(provisionalMarker()) + 64,
		retainTokens: 2048,
		minTailTokens: 2048,
		protectHeadNodes: 1,
		allowTailTrim: true,
		isBalancedBefore: (seq) => toolPairingBalancedBefore(session, seq),
		isBalancedAfter: (seq) => toolPairingBalancedAfter(session, seq)
	});
	assert.equal(plan.kind, 'span');
	assert.equal(plan.startSeq, measurement.nodes[plan.startIndex].seq);
	applyTrim(session, plan, createMarkerMessage(plan, 'x', 8000));
	assert.ok(meter.measure(session).totalTokens < measurement.totalTokens);
});

test('a trim shrinks the real meter by exactly the shadow price it claims', async () => {
	const { meter } = meterFor();
	const session = buildSession();
	const before = meter.measure(session);
	const result = await trim(session, meter, '8000');
	assert.equal(result.kind, 'success', result.text);

	const replacement = session.eventAt(result.sourceEventSeq);
	const claim = session.eventAt(replacement.seq - 1);
	assert.equal(claim.type, 'compaction/prune');

	const after = meter.measure(session);
	assert.deepEqual(after.nodes.map((node) => node.seq), [...session.surface.nodes]);
	const markerTokens = meter.estimateMessage(replacement.data);
	assert.equal(
		before.totalTokens - after.totalTokens,
		claim.data.shadowedTokenCount - markerTokens,
		'the measured drop must equal the claimed shadow price minus the marker that replaced it'
	);
	assert.ok(after.totalTokens < before.totalTokens);
});

test('a restarted process re-measures the trimmed conversation identically', async () => {
	const { meter } = meterFor();
	const session = buildSession();
	meter.measure(session);
	const result = await trim(session, meter, '8000');
	assert.equal(result.kind, 'success', result.text);
	const live = meter.measure(session).totalTokens;

	// A fresh meter folding the same — now replayed — log must reach the same
	// number. This is the property the shadow-price claim exists for.
	const replay = Session.create('meter-test', session.snapshotEvents(), session.header);
	assert.deepEqual([...replay.surface.nodes], [...session.surface.nodes]);
	const { meter: replayMeter } = meterFor();
	assert.equal(replayMeter.measure(replay).totalTokens, live, 'replay accounting drifted from the live meter');
});

test('a second trim leaves the meter consistent with the surface again', async () => {
	const { meter } = meterFor();
	const session = buildSession(12);
	meter.measure(session);
	assert.equal((await trim(session, meter, '12000')).kind, 'success');
	const midway = meter.measure(session).totalTokens;
	const second = await trim(session, meter, '6000');
	assert.equal(second.kind, 'success', second.text);
	const final = meter.measure(session);
	assert.ok(final.totalTokens < midway);
	assert.deepEqual(final.nodes.map((node) => node.seq), [...session.surface.nodes]);

	const replay = Session.create('meter-test', session.snapshotEvents(), session.header);
	const { meter: replayMeter } = meterFor();
	assert.equal(replayMeter.measure(replay).totalTokens, final.totalTokens);
});
