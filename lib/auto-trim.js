/**
 * Automatic trimming when a request hits the model's context wall.
 *
 * This is the unattended neighbour of `/trim`: a **prepended**
 * `agent/request-error` listener reacts to `CONTEXT_WINDOW_EXCEEDED`, frees space
 * with no model call, and asks the loop to retry. Only when it cannot help does
 * the waterfall continue into DSH's own recovery — which prunes oversized tool
 * results and then *summarizes*. That ordering is the whole point: dropping the
 * oldest span is cheap and works when every request is failing, whereas the
 * summarizer must itself fit the window while holding the region it is condensing,
 * so on a small local window it frequently fails for the same reason the original
 * request did.
 *
 * Why `prepend` matters: `agent/request-error` is a Cordis **waterfall**, and
 * `@deepseek-ai/dsh-compaction-basic` registers its summarization recovery on the
 * same event. Listeners are stored in registration order and `{ prepend: true }`
 * unshifts to the front, so this listener runs first regardless of which bundle
 * mounted compaction (in a web profile compaction lives inside an agent-preset
 * isolate realm, mounted later than any host-plane plugin). Returning
 * `{ kind: 'retry' }` without calling `next()` vetoes the rest of the chain for
 * that attempt; calling `next()` hands the problem to compaction.
 *
 * @module dsh-command-context-trim/auto-trim
 */
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import { logLine, describeError } from './render.js';
import { executeTrim } from './trim-session.js';

/**
 * Register automatic context-overflow trimming.
 * @param ctx - plugin context (token meter, LLM service, events, logger).
 * @param config - resolved configuration.
 * @returns nothing; listeners are owned by the plugin's fiber and disposed with it.
 */
export function registerAutoTrim(ctx, config) {
	if (config.autoTrim !== true) return;
	/** agent -> automatic trims already spent in the current overflow episode. */
	const spent = new WeakMap();
	/** session -> agent, so a successful assistant message can reset the budget. */
	const actors = new WeakMap();
	ctx.on(
		'agent/request-error',
		async ({ agent, failure, signal }, next) => {
			if (failure?.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();
			const used = spent.get(agent) ?? 0;
			if (used >= config.maxAutoTrimRetries) {
				log(ctx, 'info', `context-overflow auto-trim: retry budget spent (${used}); leaving recovery to compaction`);
				return next();
			}
			const generation = agent.session.surface.replaceGeneration;
			let outcome;
			try {
				outcome = await executeTrim(ctx, config, { agent, signal, routedOnly: true });
			} catch (error) {
				log(ctx, 'warn', `context-overflow auto-trim failed (${describeError(error)}); leaving recovery to compaction`);
				return next();
			}
			if (signal.aborted) return next();
			if (agent.session.surface.replaceGeneration <= generation) {
				log(ctx, 'info', `context-overflow auto-trim: nothing safely trimmable; leaving recovery to compaction`);
				return next();
			}
			spent.set(agent, used + 1);
			actors.set(agent.session, agent);
			log(ctx, 'info', `context-overflow auto-trim: ${logLine(outcome.plan, outcome.after, outcome.label)}`);
			return { kind: 'retry' };
		},
		{ prepend: true }
	);
	// Mirror compaction-basic's accounting: one overflow episode's budget resets
	// once the conversation advances or the agent goes idle.
	ctx.on('agent/status', ({ agent, status }) => {
		if (status === 'idle') spent.delete(agent);
	});
	ctx.on('session/event', (session, event) => {
		if (event.type !== 'assistant/message') return;
		const agent = actors.get(session);
		if (agent !== undefined) spent.delete(agent);
	});
}

/** Log through the context logger when it is available. */
function log(ctx, level, message) {
	const logger = ctx.logger;
	if (logger?.[level] === undefined) return;
	logger[level](`context-trim: ${message}`);
}
