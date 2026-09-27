/**
 * `/trim tune` — retune the *live* compaction threshold from the routes this process can see.
 *
 * Where this applies, and why it is not the same everywhere:
 *
 * - In a profile whose compaction lives on the **profile plane** (anything built on
 *   `dsh-base`: headless, tui), the threshold is a row's config. Editing that row with the
 *   configuration editor restarts the fiber — cordis's `Fiber.update()` resolves the new
 *   config and calls `restart()`, i.e. dispose plus a fresh apply — so the new threshold is
 *   in force for the next request. That is generic to every plugin entry; there is no
 *   "hot-reloadable only" restriction.
 * - In a **web** profile, `dsh-web-app` disables the host-plane compaction rows and each
 *   session's compaction lives inside its agent-preset isolate realm. Nothing a host-plane
 *   plugin writes can reach a *running* session there, and a session's preset cannot change
 *   once it has started. `ctx.get('compaction')` is empty from the host plane in that case,
 *   which is exactly how this module refuses instead of pretending.
 *
 * Why it is worth having anyway: a profile's declared `contextWindow` can be wrong (a card
 * that serves 40k while the settings claim 128k). `collectRoutes` asks the adapter
 * (`ctx.llm.resolveModelInfo`), so the numbers come from the same source compaction itself
 * uses. With a one-shot `dsh headless "task"` process the write lands in the profile patch
 * and every subsequent session starts tuned; in a long-lived process the restart makes it
 * immediate.
 *
 * @module dsh-command-context-trim/tune-runtime
 */
import { planCompactionTuning } from './compaction-spec.js';
import { readConfig } from './config.js';
import { collectRoutes } from './preset-tune.js';

/** Loader entry id of the compaction plugin whose threshold is being tuned. */
export const COMPACTION_ROW_ID = 'compaction-basic';

/** Cordis fiber state meaning "loaded"; anything else is not actively applying. */
const FIBER_ACTIVE = 2;

/**
 * Locate the live compaction row, or explain why it cannot be tuned here.
 * @param ctx - plugin context.
 * @returns `{editor, entry}`, or `{error}` with a reason a user can act on.
 */
export function findCompactionRow(ctx) {
	const editor = ctx.get?.('configEditor');
	if (editor === undefined || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
		return { error: 'this profile composes no configuration editor, so compaction cannot be retuned at runtime' };
	}
	if (ctx.get?.('compaction') === undefined) {
		return {
			error:
				'compaction is not reachable from this plane: in a web profile it lives inside each session\u2019s agent-preset isolate ' +
				'realm, so a running session cannot be retuned — tune the preset instead (see `/trim preset`)'
		};
	}
	const entry = editor.entries().find((candidate) => candidate?.options?.id === COMPACTION_ROW_ID);
	if (entry === undefined) return { error: `this profile declares no ${COMPACTION_ROW_ID} row to tune` };
	if (entry.fiber === undefined || entry.fiber.state !== FIBER_ACTIVE) {
		return { error: `the ${COMPACTION_ROW_ID} row is not active in this profile (state ${String(entry.fiber?.state)})` };
	}
	return { editor, entry };
}

/**
 * Compute the tuning this process should carry, without writing anything.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 * @param request - `{agent, signal, requestedRoute}`.
 * @returns `{plan, routes}` or `{error}`.
 */
export async function planRuntimeTuning(ctx, config, request) {
	const routes = await collectRoutes(ctx, request.agent, request.signal);
	if (routes.length === 0) {
		return { error: 'no routable provider/model pairs were found, so there is nothing to size a threshold for' };
	}
	const summarizationRoute = request.requestedRoute ?? config.compactionRoute;
	let plan;
	try {
		plan = planCompactionTuning({ routes, targetRatio: config.compactionTargetRatio, summarizationRoute });
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
	return { plan, routes, summarizationRoute };
}

/**
 * The row config this tuning implies, keeping every key the row already carries.
 * @param current - the row's current config.
 * @param plan - the computed plan.
 * @returns the config to write.
 */
export function mergeTunedConfig(current, plan) {
	const next = { ...current };
	next.thresholdRatio = plan.config.thresholdRatio;
	next.headroomTokens = plan.config.headroomTokens;
	next.maxTokens = plan.config.maxTokens;
	if (plan.config.summarizationProvider === undefined) {
		delete next.summarizationProvider;
		delete next.summarizationModel;
	} else {
		next.summarizationProvider = plan.config.summarizationProvider;
		next.summarizationModel = plan.config.summarizationModel;
	}
	if (plan.config.modelPolicies === undefined || plan.config.modelPolicies.length === 0) delete next.modelPolicies;
	else next.modelPolicies = plan.config.modelPolicies;
	return next;
}

/**
 * Retune the live compaction row (or report what would change).
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 * @param request - `{agent, signal, requestedRoute?, check?}`.
 * @returns `{result}` — a command result.
 */
export async function tuneCompactionAtRuntime(ctx, config, request) {
	const found = findCompactionRow(ctx);
	if (found.error !== undefined) return failure(found.error);
	const computed = await planRuntimeTuning(ctx, config, request);
	if (computed.error !== undefined) return failure(computed.error);
	const { plan } = computed;
	const current = found.entry.options?.config ?? {};
	const next = mergeTunedConfig(current, plan);
	const changes = changedKeys(current, next);
	const report = renderReport({ plan, changes, current, next, check: request.check === true });
	if (request.check === true) return { result: { kind: 'success', text: report } };
	if (changes.length === 0) {
		return { result: { kind: 'success', text: `${report}\nAlready tuned: nothing written.` } };
	}
	try {
		await found.editor.edit(found.entry, () => next);
	} catch (error) {
		return failure(`Writing the compaction config failed: ${error instanceof Error ? error.message : String(error)}\n\n${report}`);
	}
	return {
		result: {
			kind: 'success',
			text:
				`${report}\nRetuned ${COMPACTION_ROW_ID} (${changes.join(', ')}). The row restarts on write, so an in-flight compaction ` +
				'is cancelled; the next request uses the new threshold, and the value is persisted in the profile patch for later boots.'
		}
	};
}

/** Keys whose effective value differs between two configs. */
function changedKeys(current, next) {
	const keys = new Set([...Object.keys(current ?? {}), ...Object.keys(next ?? {})]);
	return [...keys].filter((key) => JSON.stringify(current?.[key]) !== JSON.stringify(next?.[key])).sort();
}

/** Human report: the routes, the planner's notes and the key diff. */
function renderReport({ plan, changes, current, next, check }) {
	const lines = [`Compaction tuning from this process's routes${check ? ' (check: nothing written)' : ''}`, ''];
	for (const note of plan.notes) lines.push(`  ${note}`);
	if (plan.skipped.length > 0) {
		lines.push(`  skipped: ${plan.skipped.map((entry) => `${entry.provider}/${entry.model} (${entry.reason})`).join('; ')}`);
	}
	lines.push('', changes.length === 0 ? '  no change to the compaction row' : `  ${changes.length} key(s) would change:`);
	for (const key of changes) {
		lines.push(`    ${key}: ${JSON.stringify(current?.[key])} → ${JSON.stringify(next?.[key])}`);
	}
	return lines.join('\n');
}

function failure(text) {
	return { result: { kind: 'error', text } };
}

/**
 * Optionally retune once per process, when the agent first goes idle.
 *
 * Off by default: writing a profile row at runtime is a side effect an operator opts into.
 * The idle trigger keeps the restart away from an in-flight turn (a restarted row cancels
 * work in progress), and a one-shot `dsh headless "task"` run may finish before it ever
 * fires — which is fine, because the value also lands in the profile patch for later boots.
 * @param ctx - plugin context.
 * @param rawConfig - raw configuration (volatile handles allowed).
 */
export function registerAutoTune(ctx, rawConfig) {
	if (readConfig(rawConfig).autoTuneCompaction !== true) return;
	/**
	 * Set when the surface's system prompt is (re)inserted: that is the moment the route can
	 * have changed (a session may switch models mid-conversation), so the tuning is recomputed
	 * against whatever the adapter reports then.
	 *
	 * The write itself waits for the agent to go idle. The system prompt is inserted while the
	 * request is being built, and a write restarts the compaction row — doing that inside a step
	 * would put a file write plus a loader reconciliation on the request path and could cancel a
	 * compaction in flight.
	 */
	let pending = true;
	ctx.on('session/event', (_session, event) => {
		if (event?.type === 'system/message') pending = true;
	});
	ctx.on('agent/status', async ({ agent, status }) => {
		if (status !== 'idle' || pending !== true) return;
		pending = false;
		const { result } = await tuneCompactionAtRuntime(ctx, readConfig(rawConfig), {
			agent,
			signal: new AbortController().signal,
			check: false
		});
		logLine(ctx, result.kind === 'success' ? 'info' : 'warn', `auto compaction tune: ${result.text.split('\n')[0]}`);
	});
}

/** Log through the context logger when it is available. */
function logLine(ctx, level, message) {
	const logger = ctx.logger;
	if (logger?.[level] === undefined) return;
	logger[level](`context-trim: ${message}`);
}
