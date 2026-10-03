/**
 * Compaction threshold arithmetic for generated presets.
 *
 * Mirrors `@deepseek-ai/dsh-compaction-basic`'s `resolveCompactSpec` (read from
 * 0.1.7-rc.2):
 *
 *   reservedCompletion = the routed request's `maxTokens`
 *   messageBudget      = contextWindow − reservedCompletion
 *   pressureBudget     = messageBudget − headroomTokens
 *   thresholdTokens    = floor(min(contextWindow × thresholdRatio, pressureBudget))
 *   retainTokens       = retainTokens ?? floor(messageBudget × retainRatio)
 *
 * Two consequences drive this module:
 *
 * 1. `thresholdRatio` alone does not decide the trigger — the headroom term does
 *    whenever `headroomTokens > messageBudget − contextWindow × thresholdRatio`.
 *    With dsh's default 65536 a 131072-token route compacts at 37.5 %, not 80 %.
 *    So a generated preset must emit a **per-route headroom** that lets the ratio
 *    decide, which is what "trigger at N % of the window" actually means.
 * 2. `headroomTokens` doubles as the default `maxTokens` for compaction's own
 *    summarization call, so a generated preset must state `maxTokens` explicitly.
 *
 * Pure arithmetic: no dsh imports, no I/O — the caller supplies the route
 * inventory it read from the live profile.
 *
 * @module dsh-command-context-trim/compaction-spec
 */

/** dsh's own defaults, for reference and for the "did we change anything" notes. */
export const COMPACTION_DEFAULTS = Object.freeze({
	thresholdRatio: 0.8,
	retainRatio: 0.16,
	headroomTokens: 65536,
	compactionRetries: 1,
	maxOverflowRetries: 1
});

/** Fallback for the generated `maxTokens` when the summarization route is unknown. */
/** dsh's stock `headroomTokens`, i.e. the pressure budget every route starts with. */
export const STOCK_HEADROOM = 65536;

/** dsh's stock pruner clip threshold, in characters. Below this we would clip more aggressively than stock. */
export const PRUNER_STOCK_CHARS = 8192;

/** The largest clip threshold worth writing: beyond this the pruner stops protecting the budget. */
export const PRUNER_MAX_CHARS = 32768;

/** dsh prices a token at four characters (`@deepseek-ai/dsh-token-meter`'s CHARS_PER_TOKEN). */
const CHARS_PER_TOKEN = 4;

/**
 * The tool-result pruner threshold a route should use.
 *
 * dsh ships a fixed 8192 characters, which is safe on a large window and actively harmful on a small one: an agent
 * that reads a source file routinely gets 8.5–29.5 KB back, so stock clips exactly the unit it needs and the agent
 * re-reads it. The rule here keeps the pruner's job (no single result may dominate the budget) while never clipping
 * a whole-file read: one result may hold up to half of the route's message budget, capped at 32 KB and floored at
 * stock so it can never become more aggressive than what dsh ships.
 *
 * `max(8192, min(32768, 2 × messageBudgetTokens × 4 / 4))` — the two `4`s cancel, so the budget term is a plain
 * doubling: half the budget, expressed in characters.
 * @param route - `{contextWindow, maxTokens}` of the route being compacted.
 * @returns the clip threshold in characters.
 */
export function prunerCharsForRoute(route) {
	const window = Number(route?.contextWindow);
	const reserve = Number(route?.maxTokens ?? 0);
	if (!Number.isFinite(window) || window <= 0) return PRUNER_STOCK_CHARS;
	const budget = Math.max(0, window - (Number.isFinite(reserve) ? reserve : 0));
	const halfBudgetChars = budget * 2 * (CHARS_PER_TOKEN / CHARS_PER_TOKEN);
	return Math.max(PRUNER_STOCK_CHARS, Math.min(PRUNER_MAX_CHARS, Math.floor(halfBudgetChars)));
}


export const FALLBACK_SUMMARIZER_MAX_TOKENS = 8192;

/**
 * The largest `headroomTokens` at which the ratio term still decides the trigger.
 * @param request - context window, reserved completion tokens and the target ratio.
 * @returns a non-negative integer headroom.
 */
export function headroomForRatio(request) {
	const { contextWindow, reservedCompletionTokens, thresholdRatio } = request;
	assertCapacity(contextWindow, reservedCompletionTokens, `headroom for a ${thresholdRatio} trigger`);
	const messageBudget = contextWindow - reservedCompletionTokens;
	return Math.max(0, messageBudget - Math.floor(contextWindow * thresholdRatio));
}

/**
 * Apply dsh's own spec arithmetic to one route policy.
 * @param request - window, reserve, ratio/headroom/retention policy.
 * @returns the resolved thresholds plus the fraction they represent.
 * @throws when the route cannot support the requested policy at all.
 */
export function routedSpec(request) {
	const { contextWindow, reservedCompletionTokens, thresholdRatio, headroomTokens } = request;
	assertCapacity(contextWindow, reservedCompletionTokens, "spec arithmetic");
	const messageBudget = contextWindow - reservedCompletionTokens;
	const pressureBudget = messageBudget - headroomTokens;
	if (pressureBudget <= 0) {
		throw new Error(
			`compaction spec: contextWindow ${contextWindow} with ${reservedCompletionTokens} reserved output tokens leaves no pressure budget at headroom ${headroomTokens}`
		);
	}
	const thresholdTokens = Math.floor(Math.min(contextWindow * thresholdRatio, pressureBudget));
	const retainRatio = request.retainRatio ?? COMPACTION_DEFAULTS.retainRatio;
	const retainTokens = request.retainTokens ?? Math.floor(messageBudget * retainRatio);
	if (retainTokens >= thresholdTokens) {
		throw new Error(`compaction spec: retainTokens (${retainTokens}) must be less than threshold tokens (${thresholdTokens})`);
	}
	return Object.freeze({
		contextWindow,
		reservedCompletionTokens,
		messageBudget,
		pressureBudget,
		thresholdTokens,
		retainTokens,
		/** Actual trigger as a fraction of the window, after the headroom clamp. */
		achievedRatio: thresholdTokens / contextWindow
	});
}

/**
 * Build the `compaction-basic` config a tuned preset should carry.
 * @param request - target ratio, optional summarization route and the route inventory.
 * @returns `{ config, policies, notes, skipped }` — config for the preset, notes for the operator.
 */
export function planCompactionTuning(request) {
	const { routes, targetRatio, summarizationRoute } = request;
	if (!(typeof targetRatio === 'number' && targetRatio > 0 && targetRatio <= 1)) {
		throw new Error(`compaction tuning: compactionTargetRatio (${String(targetRatio)}) must be a number in (0, 1]`);
	}
	const notes = [];
	const skipped = [];
	const policies = [];
	for (const route of routes) {
		const { provider, model, contextWindow, maxTokens } = route;
		const reservedCompletionTokens = Number.isInteger(maxTokens) ? maxTokens : 0;
		const label = `${provider}/${model}`;
		if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
			skipped.push({ provider, model, reason: 'no declared contextWindow' });
			notes.push(`${label}: skipped — no declared contextWindow, so dsh cannot size a pressure threshold for it`);
			continue;
		}
		if (contextWindow - reservedCompletionTokens <= 0) {
			skipped.push({ provider, model, reason: 'output reserve covers the whole window' });
			notes.push(`${label}: skipped — maxTokens ${reservedCompletionTokens} leaves no message budget inside ${contextWindow}`);
			continue;
		}
		const headroomTokens = headroomForRatio({ contextWindow, reservedCompletionTokens, thresholdRatio: targetRatio });
		let spec;
		try {
			spec = routedSpec({ contextWindow, reservedCompletionTokens, thresholdRatio: targetRatio, headroomTokens });
		} catch (error) {
			skipped.push({ provider, model, reason: error instanceof Error ? error.message : String(error) });
			notes.push(`${label}: skipped — ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		policies.push(Object.freeze({ provider, model, thresholdRatio: targetRatio, headroomTokens }));
		// Integer comparison, not ratios: flooring the ratio term is not a shortfall.
		const ratioTerm = Math.floor(contextWindow * targetRatio);
		if (spec.thresholdTokens < ratioTerm) {
			notes.push(
				`${label}: ${(targetRatio * 100).toFixed(1)} % is unreachable inside this route — the output reserve caps the trigger at ` +
					`${(spec.achievedRatio * 100).toFixed(1)} % (~${spec.thresholdTokens} tokens). Raise contextWindow or lower maxTokens to move it.`
			);
		} else {
			notes.push(
				`${label}: triggers at ${(spec.achievedRatio * 100).toFixed(1)} % (~${spec.thresholdTokens} tokens), retaining ~${spec.retainTokens}.`
			);
		}
	}
	if (policies.length === 0) {
		throw new Error('compaction tuning: no route in the inventory can carry a pressure threshold; nothing to generate');
	}
	const summarizerRoute = summarizationRoute === undefined ? undefined : findRoute(routes, summarizationRoute);
	const maxTokens = summarizerRoute?.maxTokens ?? FALLBACK_SUMMARIZER_MAX_TOKENS;
	if (summarizationRoute !== undefined && summarizerRoute === undefined) {
		notes.push(
			`summarization route ${summarizationRoute.provider}/${summarizationRoute.model} is not in the current route inventory — ` +
				'the generated preset still names it, but a typo would fail compaction at runtime'
		);
	}
	const config = {
		// The ratio the operator asked for. Headroom is zeroed at the top level so any
		// route NOT listed in modelPolicies also gets the ratio (not dsh's 65536 default);
		// maxTokens is therefore stated explicitly, because headroom would otherwise
		// supply it.
		thresholdRatio: targetRatio,
		headroomTokens: 0,
		maxTokens,
		...(summarizationRoute === undefined
			? {}
			: { summarizationProvider: summarizationRoute.provider, summarizationModel: summarizationRoute.model }),
		modelPolicies: policies
	};
	notes.push(
		`top level: thresholdRatio ${targetRatio}, headroomTokens 0, maxTokens ${maxTokens}` +
			`${summarizationRoute === undefined ? '' : `, summarization on ${summarizationRoute.provider}/${summarizationRoute.model}`}`
	);
	return Object.freeze({
		config: Object.freeze(config),
		policies: Object.freeze(policies),
		notes: Object.freeze(notes),
		skipped: Object.freeze(skipped)
	});
}

/** Find one route entry by provider+model, exactly as dsh matches policies. */
function findRoute(routes, wanted) {
	return routes.find((route) => route.provider === wanted.provider && route.model === wanted.model);
}

function assertCapacity(contextWindow, reservedCompletionTokens, what) {
	if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
		throw new Error(`compaction spec: contextWindow (${String(contextWindow)}) must be a positive integer (${what})`);
	}
	if (!Number.isInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) {
		throw new Error(`compaction spec: reservedCompletionTokens (${String(reservedCompletionTokens)}) must be a non-negative integer (${what})`);
	}
}
