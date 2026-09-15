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

test('never elides the final surface node', () => {
	const plan = planTrim(base({ nodes: nodes(1000, 1000, 1000, 1000), budget: 1000, markerCost: 0 }));
	assert.equal(plan.kind, 'insufficient');
	assert.equal(plan.maxFreeable, 2000);
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
