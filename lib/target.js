/**
 * Resolve which model a trim is fitting, and price the request envelope under
 * that model's route.
 *
 * @module dsh-command-context-trim/target
 */
import { canonicalHeader } from '@deepseek-ai/dsh-session';
import { describeError } from './render.js';

/**
 * Latest durable model intent for a session: the newest `model/selection` (a
 * pending switch) or the newest `request/header` (the route actually used),
 * whichever the log records last. Scanning backwards and taking the first hit
 * is exactly the rule the harness's own model-selection projection applies:
 * a selection later consumed by a matching request is superseded by that
 * request's header, and a newer selection supersedes both.
 * @param session - session whose log is read.
 * @returns `{ provider, model, source }`, or undefined when nothing was routed yet.
 */
export function latestRoute(session) {
	for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
		const event = session.eventAt(seq);
		if (event === undefined) continue;
		if (event.type === 'model/selection') {
			return { provider: event.data.provider, model: event.data.model, source: 'selection' };
		}
		if (event.type === 'request/header') {
			const config = event.data.header.config;
			return { provider: config.provider, model: config.model, source: 'request' };
		}
	}
	return undefined;
}

/**
 * Resolve the target route and its declared context capacity.
 * @param ctx - context carrying the LLM service.
 * @param agent - agent whose session supplies the durable model intent.
 * @param requested - explicit `{ provider, model }` from the command line, if any.
 * @param signal - cancellation signal for model resolution.
 * @returns `{ provider, model, contextWindow, label }`.
 * @throws when no route can be determined, the route is unknown, or its adapter declares no window.
 */
export async function resolveTarget(ctx, agent, requested, signal, options = {}) {
	const primary =
		options.routedOnly === true ? routedTarget(agent.session) ?? latestRoute(agent.session) : latestRoute(agent.session);
	const route = requested ?? primary ?? agentRoute(agent);
	if (route === undefined) {
		throw new Error('cannot determine the target model: select a model in this session first, or pass an explicit budget (e.g. /trim 32k)');
	}
	let info;
	try {
		info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal);
	} catch (error) {
		throw new Error(
			`unknown model route ${route.provider}:${route.model} (${describeError(error)}); ` +
				'pass an explicit budget instead (e.g. /trim 32k)'
		);
	}
	const contextWindow = info?.context?.contextWindow;
	if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
		throw new Error(
			`the adapter for ${route.provider}:${route.model} declares no usable contextWindow ` +
				'(set it on that model entry in settings.yaml, or pass an explicit budget such as /trim 32k)'
		);
	}
	// The route's own output allowance. A request has to fit the window together
	// with the output it may produce, so the trim reserves this in full; dsh's own
	// compaction spec reserves the same number.
	const maxTokens =
		Number.isInteger(info?.defaultMaxTokens) && info.defaultMaxTokens > 0 ? info.defaultMaxTokens : undefined;
	return {
		provider: route.provider,
		model: route.model,
		contextWindow,
		maxTokens,
		label: `${route.provider}:${route.model}`
	};
}

/**
 * The output allowance a request under this target may produce.
 *
 * The route's declared allowance is the answer for a route the session is not
 * currently using. For the route the session is using, the logged request header
 * carries the allowance that was actually sent, which a session may have lowered.
 * The larger of the two is reserved, because a provider rejects a request whose
 * prompt plus its allowance exceeds the window.
 *
 * @param target - resolved target route.
 * @param header - the request header the request is priced against, if any.
 * @returns the allowance in tokens, or zero when the route declares none.
 */
export function outputAllowanceFor(target, header) {
	const config = header?.config;
	const sameRoute = config?.provider === target.provider && config?.model === target.model;
	const declared = sameRoute && Number.isInteger(config.maxTokens) && config.maxTokens > 0 ? config.maxTokens : 0;
	return Math.max(target.maxTokens ?? 0, declared);
}

/**
 * Re-price the session's current request envelope under another route by
 * overriding the logged header's model config. The token meter reuses provider
 * usage only when the header matches its anchor exactly, so overriding the
 * config forces a fresh heuristic estimate sized for the target model's route.
 * @param session - session whose envelope is repriced.
 * @param target - resolved target route.
 * @returns a canonical header for the target route, or undefined before any request.
 */
export function targetHeader(session, target) {
	const current = session.requestHeader();
	if (current === undefined) return undefined;
	return canonicalHeader({
		...current,
		config: { ...current.config, provider: target.provider, model: target.model }
	});
}

/**
 * The route the last durable request was actually built for: the one that just
 * overflowed during automatic recovery.
 * @param session - session whose log is read.
 * @returns `{ provider, model, source }`, or undefined when nothing was routed yet.
 */
export function routedTarget(session) {
	const config = session.requestHeader()?.config;
	if (config === undefined) return undefined;
	if (typeof config.provider !== 'string' || config.provider.length === 0) return undefined;
	if (typeof config.model !== 'string' || config.model.length === 0) return undefined;
	return { provider: config.provider, model: config.model, source: 'request' };
}

/** Per-agent configured route, used only before any request was routed. */
function agentRoute(agent) {
	const provider = agent.options?.provider;
	const model = agent.options?.model;
	if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) return undefined;
	return { provider, model, source: 'agent-options' };
}
