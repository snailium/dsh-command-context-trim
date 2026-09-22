import assert from 'node:assert/strict';
import test from 'node:test';
import { toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session, deriveEventMessage } from '@deepseek-ai/dsh-session';
import { apply as applyPlugin } from '../lib/index.js';

/** Heuristic price of one surface node, standing in for the token meter's own /4 estimate. */
const priceMessage = (message) => Math.ceil(JSON.stringify(message.content).length / 4) + 4;

/** Minimal token meter that prices the real session surface. */
function stubMeter() {
	return {
		measure(session) {
			const nodes = session.surface.nodes.map((seq) => {
				const message = deriveEventMessage(session.eventAt(seq));
				return { seq, heuristicTokens: message === null ? 0 : priceMessage(message) };
			});
			const surfaceTokens = nodes.reduce((total, node) => total + node.heuristicTokens, 0);
			return { nodes, surfaceTokens, totalTokens: surfaceTokens };
		},
		estimateMessage: priceMessage
	};
}

/** Cordis-shaped context capturing the registrations this plugin makes. */
function stubContext(overrides = {}) {
	const commands = new Map();
	const listeners = new Map();
	const ctx = {
		effect(generator) {
			const iterator = generator();
			for (let step = iterator.next(); !step.done; step = iterator.next()) {
				// Drained for side effects: the generator yields one disposer then the registration.
			}
		},
		commands: {
			register(definition) {
				commands.set(definition.name, definition);
				return () => commands.delete(definition.name);
			}
		},
		get: () => undefined,
		// registerAutoTrim wires listeners through ctx.on; record them so a test can
		// assert what the plugin subscribes to.
		on(name, listener, options) {
			const entries = listeners.get(name) ?? [];
			entries.push({ listener, options });
			listeners.set(name, entries);
			return () => undefined;
		},
		logger: { info: () => undefined, warn: () => undefined },
		tokenMeter: stubMeter(),
		...overrides
	};
	applyPlugin(ctx, {});
	return { ctx, commands, listeners };
}

const taskMessage = (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });

/** A conversation whose surface is one task statement plus fat assistant/tool-result pairs. */
function buildSession(pairs = 8) {
	const session = Session.create('plugin-test');
	session.append('user/message', taskMessage('Build the thing and report back.'), { surfaceOp: 'append' });
	for (let turn = 1; turn <= pairs; turn += 1) {
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
				message: createToolResultMessage({
					callId: `call-${turn}`,
					content: [{ type: 'text', text: 'y'.repeat(4000) }],
					isError: false
				})
			},
			{ surfaceOp: 'append' }
		);
	}
	return session;
}

/** Agent stub running maintenance jobs immediately, like an idle agent would. */
const stubAgent = (session) => ({
	session,
	options: {},
	runMaintenance: (job) => job(new AbortController().signal)
});

const invoke = (handler, agent, rawInput) => handler({ agent, rawInput, signal: new AbortController().signal });

test('registers the trim command with a discoverable hint', () => {
	const { commands } = stubContext();
	const definition = commands.get('trim');
	assert.ok(definition !== undefined, 'trim was not registered');
	assert.match(definition.description, /no model call/);
	assert.equal(definition.input.hint, '[check] [tokens|k] [provider:model]');
});

test('rejects an unrecognized argument before touching the session', async () => {
	const { commands } = stubContext();
	const session = buildSession(1);
	const result = await invoke(commands.get('trim').handler, stubAgent(session), 'please');
	assert.equal(result.kind, 'error');
	assert.match(result.text, /unrecognized argument "please"/);
	assert.match(result.text, /Usage: \/trim/);
	assert.equal(session.seq, session.snapshotEvents().length);
});

test('reports a fit for an explicit budget that is already met', async () => {
	const { commands } = stubContext();
	const session = buildSession(1);
	const result = await invoke(commands.get('trim').handler, stubAgent(session), '32k');
	assert.equal(result.kind, 'success');
	assert.match(result.text, /Already within budget/);
	assert.equal(session.surface.nodes.length, 3);
});

test('trims the oldest balanced span, keeps the task and the newest message, and reports the drop', async () => {
	const { commands } = stubContext();
	const session = buildSession();
	const nodesBefore = [...session.surface.nodes];
	const tokensBefore = stubMeter().measure(session).totalTokens;
	const result = await invoke(commands.get('trim').handler, stubAgent(session), '8000');
	assert.equal(result.kind, 'success', result.text);
	assert.match(result.text, /^Trimmed \d+ messages \(seqs \d+-\d+/);
	assert.match(result.text, /target 8000/);
	assert.equal(typeof result.sourceEventSeq, 'number');
	const replacement = session.eventAt(result.sourceEventSeq);
	assert.equal(replacement.type, 'user/message');
	assert.match(replacement.data.content[0].text, /^\[context-trim\] \d+ earlier messages/);
	assert.equal(session.seq, replacement.seq + 1, 'the replacement is the last event');
	assert.equal(session.eventAt(replacement.seq - 1).type, 'compaction/prune');
	// The claim prices exactly the span the marker reports.
	const claim = session.eventAt(replacement.seq - 1);
	assert.equal(claim.data.shadowedTokenCount, Number(/~(\d+) tokens/.exec(replacement.data.content[0].text)[1]));
	assert.deepEqual([...claim.data.shadowedSeqs], [...replacement.sourceEventSeqs]);
	assert.equal(session.surface.nodes[0], nodesBefore[0], 'the task statement must survive');
	assert.ok(!replacement.sourceEventSeqs.includes(nodesBefore[nodesBefore.length - 1]), 'the newest node is never elided');
	// Both cut edges of the elided span stayed tool-pairing balanced.
	const replacementIndex = session.surface.nodes.indexOf(replacement.seq);
	assert.equal(toolPairingBalancedAfter(session, session.surface.nodes[replacementIndex - 1]), true);
	assert.equal(toolPairingBalancedAfter(session, replacement.seq), true);
	const tokensAfter = stubMeter().measure(session).totalTokens;
	assert.ok(tokensAfter < tokensBefore, `expected a reduction (${tokensBefore} -> ${tokensAfter})`);
});

test('check mode plans without mutating the session', async () => {
	const { commands } = stubContext();
	const session = buildSession();
	const seqBefore = session.seq;
	const result = await invoke(commands.get('trim').handler, stubAgent(session), 'check 8000');
	assert.equal(result.kind, 'success');
	assert.match(result.text, /Would trim \d+ messages/);
	assert.match(result.text, /Nothing was changed/);
	assert.equal(session.seq, seqBefore);
});

test('a second trim with the same budget reports a fit', async () => {
	const { commands } = stubContext();
	const session = buildSession();
	await invoke(commands.get('trim').handler, stubAgent(session), '8000');
	const result = await invoke(commands.get('trim').handler, stubAgent(session), '8000');
	assert.equal(result.kind, 'success');
	assert.match(result.text, /Already within budget/);
});

test('refuses when the fixed request envelope alone exceeds the budget', async () => {
	const envelope = 20000;
	const { commands } = stubContext({
		tokenMeter: {
			measure(session) {
				const priced = stubMeter().measure(session);
				return { ...priced, totalTokens: priced.surfaceTokens + envelope };
			},
			estimateMessage: priceMessage
		}
	});
	const session = buildSession(1);
	const result = await invoke(commands.get('trim').handler, stubAgent(session), '8000');
	assert.equal(result.kind, 'error');
	assert.match(result.text, /Fixed request overhead alone/);
	assert.equal(session.surface.nodes.length, 3);
});

test('surfaces a busy agent as a clear refusal', async () => {
	const { commands } = stubContext();
	const session = buildSession(1);
	const busyAgent = {
		session,
		options: {},
		runMaintenance: () => {
			throw new Error('agent "plugin-test" already has active work');
		}
	};
	const result = await invoke(commands.get('trim').handler, busyAgent, '8k');
	assert.equal(result.kind, 'error');
	assert.match(result.text, /Trim needs an idle agent/);
});
