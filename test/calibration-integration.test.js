/**
 * Integration test for the tokenizer calibration, against the REAL token meter.
 *
 * The stub-meter tests elsewhere prove the arithmetic; this one proves the *shape* of
 * the problem: a session whose real prompt is over the window has to be trimmed, where
 * the uncalibrated trimmer reports that it fits.
 *
 * The scenario is the one the design report describes. The token meter prices content at
 * four characters per token; a real session is denser, so the meter under-counts the
 * request. Once the meter has adopted the provider's own usage as its baseline, its
 * `totalTokens` is in real tokens while the per-node prices stay heuristic — and the
 * planner compares one against the other.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { Context } from '@deepseek-ai/cordis';
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session, canonicalHeader } from '@deepseek-ai/dsh-session';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { apply as applyPlugin } from '../lib/index.js';
import { currentCalibration, factorForRoute, knownRoutes, saveCalibration } from '../lib/calibrate-runtime.js';
import { factorFromSamples } from '../lib/calibration.js';
import { resolveConfig } from '../lib/config.js';
import { calibratedRequestTotal, executeTrim, requestPricer } from '../lib/trim-session.js';

/** A scratch directory under the repository, so nothing is written to /tmp. */
const tmpRoot = async () => {
	const dir = fileURLToPath(new URL('../.tmp/calibration-tests/', import.meta.url));
	await mkdir(dir, { recursive: true });
	return dir;
};

/** The real meter, on a context that swallows the session projections. */
function meterFor() {
	const ctx = new Context();
	ctx.sessionProjections = { register: () => () => undefined };
	return { ctx, meter: new TokenMeter(ctx, {}) };
}

/**
 * A plugin context that keeps the listeners, so the calibration can be driven the way
 * the harness drives it: one `session/event` per committed event.
 */
function pluginContextFor(meter, { profile, modelInfo } = {}) {
	const commands = new Map();
	const listeners = new Map();
	const ctx = {
		effect(generator) {
			const iterator = generator();
			for (let step = iterator.next(); !step.done; step = iterator.next()) {
				// Drained for side effects.
			}
		},
		commands: {
			register(definition) {
				commands.set(definition.name, definition);
				return () => commands.delete(definition.name);
			}
		},
		get: (name) => (name === 'profileContext' ? profile : undefined),
		on(name, listener) {
			const entries = listeners.get(name) ?? [];
			entries.push(listener);
			listeners.set(name, entries);
			return () => undefined;
		},
		logger: { info: () => undefined, warn: () => undefined },
		tokenMeter: meter,
		llm: {
			resolveModelInfo: async () => modelInfo ?? { context: { contextWindow: 16000 } }
		}
	};
	applyPlugin(ctx, {});
	return { ctx, commands, listeners };
}

/** Deliver one committed event to every `session/event` listener. */
function publish(listeners, session, event) {
	for (const listener of listeners.get('session/event') ?? []) listener(session, event);
}

/**
 * A session of tool-heavy turns, with `requests` completed requests on the route.
 *
 * Each completed request reports a provider count `density` times what the meter
 * estimated for the same surface — the real session being denser than four characters
 * per token.
 */
function buildSession({ pairs = 8, requests = 3, density = 2.4, provider = 'p', model = 'm' } = {}) {
	const session = Session.create('calibration-integration');
	session.append(
		'user/message',
		createUserMessage({ content: [{ type: 'text', text: 'Build the thing and report back.' }], source: { kind: 'user' } }),
		{ surfaceOp: 'append' }
	);
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
					source: { provider, model }
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
	session.append('request/header', {
		header: canonicalHeader({ config: { provider, model } }),
		reason: 'initial'
	});
	return session;
}

/**
 * Append one completed request whose provider count is `density` times the meter's own
 * estimate of the surface that request carried, and publish it.
 */
function completeRequest(session, listeners, meter, density) {
	const before = meter.measure(session);
	const realPrompt = Math.round(before.surfaceTokens * density);
	const turn = 100 + Math.round(density * 10) + session.seq;
	session.append('turn/start', { turn });
	session.append('step/start', { turn, step: 1 });
	const event = session.append(
		'assistant/message',
		{
			turn,
			step: 1,
			stream: [],
			message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'p', model: 'm' } }),
			usage: { inputTokens: realPrompt, outputTokens: 10, totalTokens: realPrompt + 10 }
		},
		{ surfaceOp: 'append' }
	);
	session.append('step/end', { turn, step: 1 });
	session.append('turn/end', { turn, reason: 'completed' });
	publish(listeners, session, event);
	return event;
}

/** Run one explicit-budget trim inside a stub idle reservation. */
async function trim(commands, session, rawInput) {
	const agent = { session, options: {}, runMaintenance: (job) => job(new AbortController().signal) };
	return commands.get('trim').handler({ agent, rawInput, signal: new AbortController().signal });
}

test('a session whose real prompt is over the window is trimmed, not reported as fitting', async () => {
	const { meter } = meterFor();
	const { commands, listeners } = pluginContextFor(meter);
	const session = buildSession({ pairs: 8, requests: 3, density: 2.4 });

	// Three completed requests on this route, each denser than dsh's assumption.
	for (let i = 0; i < 3; i += 1) completeRequest(session, listeners, meter, 2.4);

	// The meter now reports the real prompt size.
	const measurement = meter.measure(session);
	assert.equal(measurement.baseline.kind, 'usage', 'the meter must have adopted the provider real usage');

	// A budget that the *estimate* says fits, and the *real* prompt does not.
	const budget = Math.round(measurement.surfaceTokens * 1.1);
	assert.ok(measurement.totalTokens > budget, 'the real request must be over the budget');

	// Uncalibrated, the planner would have reported a fit: its total is the estimate.
	const { planTrim } = await import('../lib/plan.js');
	const uncalibrated = planTrim({
		nodes: measurement.nodes.map((node) => ({ seq: node.seq, heuristicTokens: node.heuristicTokens })),
		envelopeTokens: 0,
		budget,
		markerCost: 64,
		retainTokens: 2048,
		minTailTokens: 2048,
		protectHeadNodes: 1,
		allowTailTrim: true,
		isBalancedBefore: (seq) => toolPairingBalancedBefore(session, seq),
		isBalancedAfter: (seq) => toolPairingBalancedAfter(session, seq)
	});
	assert.equal(uncalibrated.kind, 'fits', 'the uncalibrated planner believes the session fits');

	// Calibrated, the same session is trimmed.
	const result = await trim(commands, session, String(budget));
	assert.equal(result.kind, 'success', result.text);
	assert.doesNotMatch(result.text, /Nothing to trim/);
	assert.match(result.text, /Trimmed/);
});

test('an anchored request is never priced below what the provider already charged', async () => {
	const { meter } = meterFor();
	const { ctx, listeners } = pluginContextFor(meter);
	const session = buildSession({ pairs: 8, requests: 0, density: 2.4 });
	// One completed request is enough for the meter to adopt the provider's own count.
	completeRequest(session, listeners, meter, 2.4);

	const measurement = meter.measure(session);
	assert.equal(measurement.baseline.kind, 'usage', 'the meter must have adopted the provider real usage');
	// One observation is not enough to learn a factor from, so this route is uncalibrated.
	assert.equal(factorForRoute(ctx, 'p:m'), 1, 'no factor may be learned from one observation');

	// The meter knows the real size of this request; the trim must not price it lower,
	// or the request that no longer fits the window would be reported as fitting it.
	const pricer = requestPricer(ctx, session, session.requestHeader());
	const view = pricer.view(measurement);
	assert.ok(
		view.totalTokens >= measurement.totalTokens,
		`the priced request must not fall below the meter's real total: ${String(view.totalTokens)} < ${String(measurement.totalTokens)}`
	);
	assert.ok(
		view.totalTokens >= measurement.surfaceTokens,
		'the priced request must include the envelope, not just the surface'
	);
});

test('a fresh route with no observations is trimmed exactly as it was before', async () => {
	const { meter } = meterFor();
	const { commands, listeners } = pluginContextFor(meter);
	const session = buildSession({ pairs: 8, requests: 0, density: 2.4 });
	const measurement = meter.measure(session);
	const budget = Math.round(measurement.surfaceTokens * 1.1);

	// No completed request on this route: nothing was learned, so the factor is 1.
	const result = await trim(commands, session, String(budget));
	assert.equal(result.kind, 'success', result.text);
	assert.match(result.text, /Already within budget|Trimmed/);

	// And the same session with the observations present is treated differently, which
	// is the whole point of learning the factor.
	const learned = buildSession({ pairs: 8, requests: 3, density: 2.4 });
	for (let i = 0; i < 3; i += 1) completeRequest(learned, listeners, meter, 2.4);
	const learnedResult = await trim(commands, learned, String(budget));
	assert.equal(learnedResult.kind, 'success', learnedResult.text);
	assert.match(learnedResult.text, /Trimmed/);
});

test('the observations recover the density the provider actually charged', async () => {
	const { meter } = meterFor();
	const { ctx, listeners } = pluginContextFor(meter);
	const session = buildSession({ pairs: 8, requests: 3, density: 2.4 });
	for (let i = 0; i < 3; i += 1) completeRequest(session, listeners, meter, 2.4);
	const routes = knownRoutes(ctx);
	assert.equal(routes.length, 1);
	assert.equal(routes[0].key, 'p:m');
	assert.ok(
		Math.abs(routes[0].factor - 2.4) < 0.05,
		`expected the learned factor near the density the provider charged, got ${String(routes[0].factor)}`
	);
});

test('the calibrated trim frees what the real window needs', async () => {
	const { meter } = meterFor();
	const { ctx, listeners } = pluginContextFor(meter);
	const session = buildSession({ pairs: 8, requests: 3, density: 2.4 });
	for (let i = 0; i < 3; i += 1) completeRequest(session, listeners, meter, 2.4);
	const measurement = meter.measure(session);
	const budget = Math.round(measurement.surfaceTokens * 1.1);

	const outcome = await executeTrim(ctx, resolveConfig({}), {
		agent: { session, options: {}, runMaintenance: (job) => job(new AbortController().signal) },
		explicitBudget: budget
	});
	assert.equal(outcome.result.kind, 'success', outcome.result.text);
	assert.ok(
		outcome.totals.after <= budget,
		`the calibrated request must fit the budget: ${String(outcome.totals.after)} > ${String(budget)}`
	);
	// The real request, priced by the provider's own density, fits too.
	const after = meter.measure(session);
	assert.ok(after.surfaceTokens < measurement.surfaceTokens, 'the surface must have shrunk');
});

test('the learned table survives a restart', async (t) => {
	const dir = await mkdtemp(join(await tmpRoot(), 'context-trim-calibration-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const { meter } = meterFor();
	const { ctx, listeners } = pluginContextFor(meter, { profile: { dir } });

	const session = buildSession({ pairs: 8, requests: 3, density: 2.4 });
	for (let i = 0; i < 3; i += 1) completeRequest(session, listeners, meter, 2.4);
	assert.equal(knownRoutes(ctx).length, 1, 'the factor must have been learned');

	// The table is written beside the profile, and a fresh process reads it back.
	// The file keeps the raw observations, not a factor: the policy that turns samples
	// into a factor can change without invalidating what was measured.
	await saveCalibration(ctx, currentCalibration(ctx));
	const written = JSON.parse(await readFile(join(dir, 'context-trim-calibration.json'), 'utf8'));
	assert.equal(written.routes.length, 1);
	assert.equal(written.routes[0].key, 'p:m');
	assert.equal(written.routes[0].samples.length, 3);
	assert.ok(
		Math.abs(factorFromSamples(written.routes[0].samples) - 2.4) < 0.05,
		'the persisted observations must describe the density the provider charged'
	);

	// A second boot: a new context, a new table, and the factor is already known.
	const rebooted = pluginContextFor(meterFor().meter, { profile: { dir } });
	// The table is loaded in the background when the plugin registers.
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(knownRoutes(rebooted.ctx).length, 1, 'the factor must be restored from disk');
	assert.ok(
		Math.abs(knownRoutes(rebooted.ctx)[0].factor - 2.4) < 0.05,
		'the restored factor must be the one that was learned'
	);
});

test('the repeat overflow retargets to the real failing size, not the estimate', async () => {
	const { meter } = meterFor();
	const { ctx, listeners } = pluginContextFor(meter);
	const session = buildSession({ pairs: 8, requests: 3, density: 2.4 });
	for (let i = 0; i < 3; i += 1) completeRequest(session, listeners, meter, 2.4);

	const overflow = { code: 'CONTEXT_WINDOW_EXCEEDED' };
	const agent = { session, options: { provider: 'p', model: 'm' }, runMaintenance: (job) => job(new AbortController().signal) };
	const logs = [];
	ctx.logger = { info: () => undefined, warn: (message) => logs.push(String(message)) };
	const overflowListener = listeners.get('agent/request-error')[0];
	const call = () => overflowListener({ agent, failure: overflow, signal: new AbortController().signal }, () => undefined);

	await call();
	logs.length = 0;
	await call();
	const retarget = logs.find((line) => line.includes('retargeting to'));
	assert.ok(retarget !== undefined, `expected a retarget line, saw ${JSON.stringify(logs)}`);
	// The ceiling is a fraction of the REAL request size. The estimate is a fraction of
	// that, so a ceiling derived from the estimate would be recognisably smaller.
	const realTotal = calibratedRequestTotal(ctx, session);
	const ceiling = Number(/retargeting to ~(\d+) tokens/.exec(retarget)?.[1]);
	assert.ok(ceiling > 0, 'the retarget must name a ceiling');
	assert.ok(
		ceiling > realTotal * 0.2,
		`the ceiling must be a fraction of the real size (~${String(realTotal)}), got ${String(ceiling)}`
	);
});

test('the trim budget reserves the route output allowance', async () => {
	const { meter } = meterFor();
	const { commands } = pluginContextFor(meter, {
		modelInfo: { context: { contextWindow: 262144 }, defaultMaxTokens: 32768 }
	});
	const session = buildSession({ pairs: 2, requests: 0 });

	const result = await trim(commands, session, 'check');
	// The budget is 90% of the window minus the route's own output allowance, so the
	// request and the reply it may produce fit the window together.
	assert.match(result.text, /\/ 206438 tokens/);
	assert.match(result.text, /32768 reserved for output/);
});
