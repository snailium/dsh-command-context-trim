/**
 * Resolve which model a trim is fitting, and price the request envelope under
 * that model's route.
 *
 * @module dsh-command-context-trim/target
 */
import { canonicalHeader } from '@deepseek-ai/dsh-session';

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
export async function resolveTarget(ctx, agent, requested, signal) {
	const route = requested ?? latestRoute(agent.session) ?? agentRoute(agent);
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
	return { provider: route.provider, model: route.model, contextWindow, label: `${route.provider}:${route.model}` };
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

/** Per-agent configured route, used only before any request was routed. */
function agentRoute(agent) {
	const provider = agent.options?.provider;
	const model = agent.options?.model;
	if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) return undefined;
	return { provider, model, source: 'agent-options' };
}

/** Render a thrown value without trusting its string coercion. */
function describeError(error) {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return '<unrenderable thrown value>';
	}
}
