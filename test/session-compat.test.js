import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session } from '@deepseek-ai/dsh-session';
import { detectReplaceKeys, replaceKeys, replacementOp } from '../lib/session-compat.js';

const message = (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });

/** The candidate the installed harness is expected to reject. */
const otherKeys = (keys) => (keys.start === 'startSeq' ? { start: 'start', end: 'end' } : { start: 'startSeq', end: 'endSeq' });

test('the detected marker shape is the one this harness accepts', () => {
	const keys = replaceKeys();
	assert.ok(keys.start === 'startSeq' || keys.start === 'start', `unexpected key ${keys.start}`);
	const op = replacementOp(keys, 1, 1);
	assert.equal(op.op, 'replace');
	assert.deepEqual(Object.keys(op).sort(), ['op', keys.start, keys.end].sort());
	assert.equal(Object.keys(op).length, 3);

	const session = Session.create('compat-accept');
	session.append('user/message', message('first'), { surfaceOp: 'append' });
	session.append('user/message', message('second'), { surfaceOp: 'append' });
	const replacement = session.append('user/message', message('marker'), { surfaceOp: op, sourceEventSeqs: [1] });
	assert.deepEqual([...session.surface.nodes], [0, replacement.seq]);
});

test('the other known marker shape is rejected by this harness', () => {
	const keys = replaceKeys();
	const session = Session.create('compat-reject');
	session.append('user/message', message('first'), { surfaceOp: 'append' });
	session.append('user/message', message('second'), { surfaceOp: 'append' });
	assert.throws(
		() =>
			session.append('user/message', message('marker'), {
				surfaceOp: replacementOp(otherKeys(keys), 1, 1),
				sourceEventSeqs: [1]
			}),
		/invalid replace surfaceOp/
	);
});

test('detection is cached and stable', () => {
	assert.equal(replaceKeys(), replaceKeys());
	assert.deepEqual(detectReplaceKeys(), replaceKeys());
});
