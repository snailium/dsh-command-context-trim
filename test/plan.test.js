import assert from 'node:assert/strict';
import test from 'node:test';
import { planTrim } from '../lib/plan.js';

/** Build priced surface nodes from a list of heuristic token counts. */
const nodes = (...counts) => counts.map((heuristicTokens, seq) => ({ seq, heuristicTokens }));

/** Planning input with everything neutral unless a case overrides it. */
const base = (overrides = {}) => ({
	nodes: nodes(1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000),
	envelopeTokens: 0,
	budget: 7500,
	markerCost: 100,
	retainTokens: 0,
	minTailTokens: 0,
	protectHeadNodes: 1,
	allowTailTrim: true,
	isBalancedBefore: () => true,
	isBalancedAfter: () => true,
	...overrides
});

test('reports a fit without planning any span', () => {
	const plan = planTrim(base({ budget: 10000 }));
	assert.equal(plan.kind, 'fits');
	assert.equal(plan.totalTokens, 10000);
});

test('refuses when the fixed request envelope alone exceeds the budget', () => {
	const plan = planTrim(base({ nodes: nodes(1000), envelopeTokens: 5000, budget: 4000 }));
	assert.equal(plan.kind, 'envelope');
	assert.equal(plan.envelopeTokens, 5000);
});

test('says nothing is trimmable when the surface holds one message', () => {
	const plan = planTrim(base({ nodes: nodes(1000), budget: 500 }));
	assert.equal(plan.kind, 'no-span');
});

test('elides the oldest minimal balanced span that frees enough', () => {
	const plan = planTrim(base());
	assert.equal(plan.kind, 'span');
	assert.deepEqual(plan.shadowedSeqs, [1, 2, 3]);
	assert.equal(plan.startSeq, 1);
	assert.equal(plan.endSeq, 3);
	assert.equal(plan.shadowedTokens, 3000);
	assert.equal(plan.freedTokens, 2900);
	assert.equal(plan.projectedTotal, 7100);
	assert.equal(plan.relaxedRetention, false);
});

test('never elides the protected task statement', () => {
	const plan = planTrim(base({ nodes: nodes(5000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000), budget: 9000 }));
	assert.equal(plan.kind, 'span');
	assert.equal(plan.startSeq, 1);
	assert.equal(plan.endSeq, 6);
});

test('keeps the final node whenever an older span can free enough', () => {
	const priced = [
		{ seq: 0, heuristicTokens: 1000 },
		{ seq: 1, heuristicTokens: 1000, userMessage: true },
		{ seq: 2, heuristicTokens: 1000 },
		{ seq: 3, heuristicTokens: 1000 },
		{ seq: 4, heuristicTokens: 1000 }
	];
	const plan = planTrim(base({ nodes: priced, budget: 4000, markerCost: 0 }));
	assert.equal(plan.kind, 'span');
	assert.equal(plan.endIndex, 2);
	assert.equal(plan.reachedFinalNode, false, 'the final node must not be touched when an older span suffices');
	assert.ok(!plan.shadowedSeqs.includes(4));
});

test('never elides the newest user message, and never spans across it', () => {
	const priced = [
		{ seq: 0, heuristicTokens: 1000 },
		{ seq: 1, heuristicTokens: 1000 },
		{ seq: 2, heuristicTokens: 1000, userMessage: true },
		{ seq: 3, heuristicTokens: 1000 }
	];
	const plan = planTrim(base({ nodes: priced, budget: 1000, markerCost: 0 }));
	assert.equal(plan.kind, 'insufficient');
	assert.equal(plan.protectedUserTokens, 1000);
	assert.equal(plan.maxFreeable, 1000, 'the regions on either side are one node each');
});

test('elides a tool-call/result pair that ends the surface (the shape that deadlocked overflow)', () => {
	const priced = [
		{ seq: 0, heuristicTokens: 1100, barrier: true },
		{ seq: 1, heuristicTokens: 100, userMessage: true },
		{ seq: 2, heuristicTokens: 1100 },
		{ seq: 3, heuristicTokens: 20 }
	];
	const plan = planTrim(
		base({
			nodes: priced,
			budget: 1500,
			markerCost: 0,
			// Only the tool result closes the pair; the tool-call node must not end a span.
			isBalancedAfter: (seq) => seq !== 2
		})
	);
	assert.equal(plan.kind, 'span');
	assert.deepEqual(plan.shadowedSeqs, [2, 3]);
	assert.equal(plan.reachedFinalNode, true, 'this shape has no other feasible span');
	assert.ok(!plan.shadowedSeqs.includes(0), 'the system prompt is never touched');
	assert.ok(!plan.shadowedSeqs.includes(1), 'the live instruction is never touched');
});

test('with allowTailTrim false the retained tail is a hard boundary (no final-node tier)', () => {
	const priced = [
		{ seq: 0, heuristicTokens: 1100, barrier: true },
		{ seq: 1, heuristicTokens: 100, userMessage: true },
		{ seq: 2, heuristicTokens: 1100 },
		{ seq: 3, heuristicTokens: 20 }
	];
	const plan = planTrim(base({ nodes: priced, budget: 1500, markerCost: 0, retainTokens: 1200, minTailTokens: 1200, allowTailTrim: false }));
	assert.equal(plan.kind, 'insufficient');
	assert.equal(plan.maxFreeable, 0, 'the tail boundary protects the whole tool-call/result pair');
});

test('relaxes the retained tail before giving up', () => {
	const plan = planTrim(base({ retainTokens: 8000, allowTailTrim: false }));
	assert.equal(plan.kind, 'span');
	assert.equal(plan.relaxedRetention, true);
	assert.equal(plan.retainTokens, 4000);
	assert.deepEqual(plan.shadowedSeqs, [1, 2, 3]);
});

test('reports an honest shortfall when the protected tail cannot be relaxed', () => {
	const plan = planTrim(base({ retainTokens: 8000, minTailTokens: 8000, allowTailTrim: false }));
	assert.equal(plan.kind, 'insufficient');
	assert.equal(plan.maxFreeable, 900);
	assert.equal(plan.protectedTailTokens, 8000);
	assert.equal(plan.need, 2500);
});

test('honors tool-pairing balance on both cut edges', () => {
	const plan = planTrim(
		base({
			isBalancedAfter: (seq) => seq >= 5,
			isBalancedBefore: (seq) => seq >= 3
		})
	);
	assert.equal(plan.kind, 'span');
	assert.deepEqual(plan.shadowedSeqs, [3, 4, 5]);
});

test('frees exactly enough rather than dropping the whole middle', () => {
	const plan = planTrim(base({ nodes: nodes(4000, 4000, 4000, 4000, 4000), budget: 12000, markerCost: 0 }));
	assert.equal(plan.kind, 'span');
	assert.deepEqual(plan.shadowedSeqs, [1, 2]);
	assert.equal(plan.freedTokens, 8000);
});

test('never elides or crosses a barrier node (the 0.1.5+ system prompt)', () => {
	const priced = [
		{ seq: 0, heuristicTokens: 20000, barrier: true },
		{ seq: 1, heuristicTokens: 5000 },
		...Array.from({ length: 8 }, (_, index) => ({ seq: index + 2, heuristicTokens: 1000 }))
	];
	const plan = planTrim(base({ nodes: priced, budget: 12000 }));
	// 33000 total needs 21000 freed; only 7000 sits in the elidable region.
	assert.equal(plan.kind, 'insufficient');
	assert.equal(plan.hasBarrier, true);
	// Head protection counts non-barrier nodes, so the task statement (node 1) is protected.
	assert.equal(plan.protectedHeadTokens, 25000);
	assert.equal(plan.maxFreeable, 7900);
});

test('an elided span stops at the barrier before it', () => {
	const priced = [
		{ seq: 0, heuristicTokens: 1000 },
		{ seq: 1, heuristicTokens: 1000 },
		{ seq: 2, heuristicTokens: 1000, barrier: true },
		{ seq: 3, heuristicTokens: 1000 },
		{ seq: 4, heuristicTokens: 1000 },
		{ seq: 5, heuristicTokens: 1000 },
		{ seq: 6, heuristicTokens: 1000 }
	];
	const plan = planTrim(base({ nodes: priced, budget: 5500, markerCost: 0 }));
	assert.equal(plan.kind, 'span');
	assert.deepEqual(plan.shadowedSeqs, [3, 4]);
	assert.ok(!plan.shadowedSeqs.includes(2), 'the span must not swallow the barrier');
});

test('reports an insufficient fit when the barrier plus head protection is the blocker', () => {
	const priced = [
		{ seq: 0, heuristicTokens: 500, barrier: true },
		{ seq: 1, heuristicTokens: 5000 },
		{ seq: 2, heuristicTokens: 1000 },
		{ seq: 3, heuristicTokens: 1000 },
		{ seq: 4, heuristicTokens: 1000 },
		{ seq: 5, heuristicTokens: 1000 },
		{ seq: 6, heuristicTokens: 1000 }
	];
	const plan = planTrim(base({ nodes: priced, budget: 4000, markerCost: 0 }));
	assert.equal(plan.kind, 'insufficient');
	assert.equal(plan.maxFreeable, 5000);
	assert.equal(plan.protectedHeadTokens, 5500);
});
