import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session, canonicalHeader, deriveEventMessage } from '@deepseek-ai/dsh-session';
import {
	CALIBRATION_MIN_SAMPLES,
	createCalibration,
	estimateEnvelopeTokens,
	factorFromSamples,
	quantile,
	routeKey
} from '../lib/calibration.js';
import { factorForRoute, factorForTrim, headerRouteKey, observeRequest } from '../lib/calibrate-runtime.js';
import { planTrim } from '../lib/plan.js';

/** Heuristic price of one surface node, standing in for the token meter's own /4 estimate. */
const priceMessage = (message) => Math.ceil(JSON.stringify(message.content).length / 4) + 4;

test('the factor is the p90 of the observations, never the mean', () => {
	// A route whose density swings: prose-heavy requests near 1, log-heavy ones near 3.
	const samples = [1.0, 1.05, 1.1, 1.2, 1.3, 2.6, 2.9, 3.0, 3.05, 3.05];
	const factor = factorFromSamples(samples);
	assert.ok(factor !== undefined);
	assert.ok(factor > 2.8, `expected a conservative p90, got ${String(factor)}`);
});

test('a factor below 1 is never applied', () => {
	// DSH over-estimating is not a reason to discard context.
	const factor = factorFromSamples([0.4, 0.5, 0.6, 0.7]);
	assert.equal(factor, 1);
});

test('too few observations yield no factor at all', () => {
	assert.equal(factorFromSamples([]), undefined);
	assert.equal(factorFromSamples([1.2]), undefined);
	assert.equal(factorFromSamples([1.2, 1.3]), undefined);
	assert.ok(CALIBRATION_MIN_SAMPLES === 3);
});

test('the quantile of a sorted sample is the nearest-rank value', () => {
	assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
	assert.equal(quantile([1, 2, 3], 0.5), 2);
	assert.equal(quantile([], 0.9), undefined);
});

test('the envelope is priced as the tool schemas it carries', () => {
	const header = canonicalHeader({
		config: { provider: 'p', model: 'm' },
		tools: [{ name: 'bash', description: 'x'.repeat(400), parameters: { type: 'object', properties: {} } }]
	});
	const envelope = estimateEnvelopeTokens(header);
	assert.ok(envelope > 100, `expected the schema to be priced, got ${String(envelope)}`);
	assert.equal(estimateEnvelopeTokens(canonicalHeader({ config: { provider: 'p', model: 'm' } })), 0);
	assert.equal(estimateEnvelopeTokens(undefined), 0);
});

test('a route is keyed by provider and model', () => {
	assert.equal(routeKey('p', 'm'), 'p:m');
	assert.equal(routeKey('', 'm'), undefined);
	assert.equal(routeKey('p', undefined), undefined);
});

test('the table keeps one window of observations per route', () => {
	const table = createCalibration();
	for (let i = 0; i < 60; i += 1) table.observe('p:m', 1 + i / 100, i);
	const routes = table.list();
	assert.equal(routes.length, 1);
	assert.equal(routes[0].samples, 50);
	// The window dropped the oldest observations, so the factor is the recent one.
	assert.ok(routes[0].factor > 1.5);
});

test('a route with no observations is not calibrated', () => {
	const table = createCalibration();
	assert.equal(table.factorFor('p:unknown'), 1);
	table.observe('p:m', 2, 1);
	assert.equal(table.factorFor('p:m'), 1);
});

test('a snapshot round-trips and a corrupt one is ignored', () => {
	const table = createCalibration();
	for (let i = 0; i < 4; i += 1) table.observe('p:m', 1.5, i);
	const restored = createCalibration();
	restored.restore(table.snapshot());
	assert.equal(restored.factorFor('p:m'), 1.5);
	// A factor the plugin never measured must not be believed, so a snapshot whose
	// observations are not numbers restores nothing.
	const corrupt = createCalibration();
	corrupt.restore({ version: 1, routes: [{ key: 'p:m', samples: ['nonsense'] }] });
	assert.equal(corrupt.factorFor('p:m'), 1);
	corrupt.restore({ version: 1, routes: 'not an array' });
	corrupt.restore(null);
	corrupt.restore({ version: 1, routes: [{ key: '', samples: [1, 1, 1] }] });
	assert.equal(corrupt.factorFor('p:m'), 1);
	assert.equal(corrupt.factorFor(''), 1);
});

test('a trim against an unmeasured route falls back to the session route', () => {
	// The target route has no samples of its own; the session's route describes the
	// content being trimmed.
	const ctx = {};
	assert.equal(factorForTrim(ctx, 'p:new', 'p:known'), 1);
});

// --- the observation itself -------------------------------------------------

/** A session whose last request carried a header and one assistant message. */
function sessionWithRequest({ provider = 'p', model = 'm', tools = [] } = {}) {
	const session = Session.create('calibration-test');
	session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }), {
		surfaceOp: 'append'
	});
	session.append(
		'request/header',
		{ header: canonicalHeader({ config: { provider, model }, ...(tools.length === 0 ? {} : { tools }) }), reason: 'initial' }
	);
	return session;
}

/** A meter that prices the session surface the way the real one does. */
function stubMeter(session) {
	return {
		measure() {
			const nodes = session.surface.nodes.map((seq) => {
				const message = deriveEventMessage(session.eventAt(seq));
				return { seq, heuristicTokens: message === null ? 0 : priceMessage(message) };
			});
			const surfaceTokens = nodes.reduce((total, node) => total + node.heuristicTokens, 0);
			return { nodes, surfaceTokens, totalTokens: surfaceTokens, baseline: { kind: 'estimated', tokens: surfaceTokens } };
		},
		estimateMessage: priceMessage
	};
}

test('an observation compares the provider real prompt with the estimate of the same request', () => {
	const session = sessionWithRequest({ provider: 'p', model: 'm' });
	const ctx = { tokenMeter: stubMeter(session) };
	// The assistant message is the response, so it is not part of the request it priced.
	const assistant = session.append(
		'assistant/message',
		{
			turn: 1,
			step: 1,
			message: createAssistantMessage({
				content: [{ type: 'text', text: 'answer' }],
				source: { provider: 'p', model: 'm' }
			}),
			usage: { inputTokens: 1000, outputTokens: 20, totalTokens: 1020 }
		},
		{ surfaceOp: 'append' }
	);
	const observation = observeRequest(ctx, session, assistant);
	assert.ok(observation !== undefined);
	assert.equal(observation.key, 'p:m');
	// The surface before the assistant message is the task statement; the assistant's own
	// node must not be counted against the request that produced it.
	assert.ok(observation.factor > 1, `expected a factor above 1, got ${String(observation.factor)}`);
});

test('a request without usage is not observed', () => {
	const session = sessionWithRequest();
	const ctx = { tokenMeter: stubMeter(session) };
	const assistant = session.append(
		'assistant/message',
		{
			turn: 1,
			step: 1,
			message: createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: { provider: 'p', model: 'm' } })
		},
		{ surfaceOp: 'append' }
	);
	assert.equal(observeRequest(ctx, session, assistant), undefined);
});

test('the cache fields are part of the real prompt, because dsh keeps them disjoint', () => {
	const session = sessionWithRequest();
	const ctx = { tokenMeter: stubMeter(session) };
	const assistant = session.append(
		'assistant/message',
		{
			turn: 1,
			step: 1,
			message: createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: { provider: 'p', model: 'm' } }),
			usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 20, totalTokens: 1020 }
		},
		{ surfaceOp: 'append' }
	);
	const observation = observeRequest(ctx, session, assistant);
	assert.ok(observation !== undefined);
	const withoutCache = observeRequest(ctx, session, { ...assistant, data: { ...assistant.data, usage: { inputTokens: 100, outputTokens: 20 } } });
	assert.ok(observation.factor > withoutCache.factor);
});

// --- the effect on the plan --------------------------------------------------

/** One plan input over a known surface, priced in the given unit. */
function planInput(nodes, envelopeTokens, budget) {
	return {
		nodes,
		envelopeTokens,
		budget,
		markerCost: 64,
		retainTokens: 0,
		minTailTokens: 0,
		protectHeadNodes: 0,
		allowTailTrim: true,
		isBalancedBefore: () => true,
		isBalancedAfter: () => true
	};
}

test('a calibrated trim frees what the real window needs, not what the estimate said', () => {
	// The surface is 10 000 heuristic tokens, and the provider charges 2.4 for them.
	const nodes = [{ seq: 1, heuristicTokens: 4000 }, { seq: 2, heuristicTokens: 6000 }];
	const budget = 12_000;
	// Uncalibrated: the plan believes the request is 10 000 and leaves it alone.
	const naive = planTrim(planInput(nodes, 0, budget));
	assert.equal(naive.kind, 'fits');
	// Calibrated: the same surface is 24 000 real tokens, which does not fit.
	const calibrated = planTrim(
		planInput(
			nodes.map((node) => ({ ...node, heuristicTokens: Math.ceil(node.heuristicTokens * 2.4) })),
			0,
			budget
		)
	);
	assert.equal(calibrated.kind, 'span');
	assert.ok(calibrated.freedTokens >= calibrated.need);
});

test('a prose-only session is clamped to 1 and is not trimmed any earlier', () => {
	const nodes = [{ seq: 1, heuristicTokens: 4000 }, { seq: 2, heuristicTokens: 6000 }];
	const budget = 12_000;
	const naive = planTrim(planInput(nodes, 0, budget));
	const clamped = planTrim(
		planInput(
			nodes.map((node) => ({ ...node, heuristicTokens: Math.ceil(node.heuristicTokens * 1) })),
			0,
			budget
		)
	);
	assert.equal(naive.kind, 'fits');
	assert.equal(clamped.kind, 'fits');
	assert.equal(clamped.totalTokens, naive.totalTokens);
});

test('the route key of a header is its provider and model', () => {
	assert.equal(headerRouteKey(canonicalHeader({ config: { provider: 'p', model: 'm' } })), 'p:m');
	assert.equal(headerRouteKey(undefined), undefined);
});

test('the factor of an unregistered calibration is 1', () => {
	const ctx = {};
	assert.equal(factorForRoute(ctx, 'p:m'), 1);
	assert.equal(factorForTrim(ctx, 'p:m', 'p:m'), 1);
});
