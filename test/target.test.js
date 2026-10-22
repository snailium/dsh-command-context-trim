/**
 * Tests for the target resolution's output allowance.
 *
 * A request has to fit the window together with the output it is allowed to
 * produce: a provider rejects a request whose prompt plus its own output
 * allowance exceeds the window. The route's declared allowance is therefore
 * reserved in full, and the logged request header wins when it names the same
 * route — that is the allowance the request actually carried.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { outputAllowanceFor } from '../lib/target.js';

test('a route that declares no allowance reserves nothing', () => {
	assert.equal(outputAllowanceFor({ provider: 'p', model: 'm' }, undefined), 0);
	assert.equal(outputAllowanceFor({ provider: 'p', model: 'm' }, { config: { provider: 'p', model: 'm' } }), 0);
});

test('the route allowance is the answer for a route the session is not using', () => {
	const target = { provider: 'p', model: 'm', maxTokens: 32768 };
	assert.equal(outputAllowanceFor(target, undefined), 32768);
	// A header for another route says nothing about this one.
	assert.equal(outputAllowanceFor(target, { config: { provider: 'other', model: 'm', maxTokens: 131072 } }), 32768);
});

test('the header allowance counts when it names the same route', () => {
	const target = { provider: 'p', model: 'm', maxTokens: 32768 };
	assert.equal(outputAllowanceFor(target, { config: { provider: 'p', model: 'm', maxTokens: 131072 } }), 131072);
	// A session that lowered the allowance does not raise the route's own.
	assert.equal(outputAllowanceFor(target, { config: { provider: 'p', model: 'm', maxTokens: 4096 } }), 32768);
});
