/**
 * `/context-tune tune` — retune the *live* compaction threshold from the routes this process can see.
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
import { tuneCompactionPreset } from './preset-tune.js';
import { PRUNER_MAX_CHARS, PRUNER_STOCK_CHARS, planCompactionTuning, prunerCharsForRoute } from './compaction-spec.js';
import { readConfig } from './config.js';
import { collectRoutes } from './preset-tune.js';
import { describeError } from './render.js';

/** Loader entry id of the compaction plugin whose threshold is being tuned. */
export const COMPACTION_ROW_ID = 'compaction-basic';

/** Loader entry id of the tool-result pruner, on the same profile plane as the compaction row. */
export const PRUNER_ROW_ID = 'tool-result-pruner';

/**
 * Session record appended for every applied retune.
 *
 * It is deliberately not a surface message: the model must not pay tokens for a settings change, and
 * nothing about the request should move. It is also not one of the harness's known event types, so no
 * client renders it — it exists so a retune is auditable in the session log itself, next to the
 * `request/context` and `compaction/*` records that an analysis pass already reads.
 */
export const TUNED_EVENT = 'context-trim/tuned';

/** Cordis fiber state meaning "loaded"; anything else is not actively applying. */
const FIBER_ACTIVE = 2;

/**
 * Keep a session's preset definition in sync with the configured routes — the web-plane half of auto-tuning.
 *
 * A web profile keeps compaction inside each session's preset isolate realm, so no host-plane write reaches a running
 * session. The *definition* can still be kept current, which is what makes the next fork, new session, or restart
 * already correct — the case that otherwise needs a manual re-run whenever a new model is added to the profile.
 *
 * Registered by the plugin entry only when `autoTuneCompaction` is on, fires on `agent/created` (the moment a preset id
 * is known), and does at most one write per preset id per process. Never throws, never blocks a turn.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 * @returns a disposer.
 */
/** Contexts that have already reported one skip; per-plugin-instance, so a test or a second profile starts clean. */
const SKIPS_REPORTED = new WeakSet();

export function registerPresetSync(ctx, config) {
	const disposers = [];
	const onCreated = (payload) => {
		const agent = payload?.agent;
		void syncPresetDefinition(ctx, config, { agent }).then((outcome) => {
			if (outcome.status === 'skipped') {
				// A skip is normal, but "nothing happened and nothing said why" is the least debuggable state there
				// is: the first skip of a process goes to stderr as well, the rest stay at info level.
				logLine(ctx, 'info', `auto preset sync: skipped (${outcome.text})`);
				if (!SKIPS_REPORTED.has(ctx)) {
					SKIPS_REPORTED.add(ctx);
					report(`auto preset sync: skipped (${outcome.text})`);
				}
				return;
			}
			// The report's first line is the heading; the outcome is the last non-empty one (same convention as the
			// auto-retune line above), and for a thrown reason the text is that reason alone.
			const tail = outcome.text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).pop() ?? '';
			if (outcome.status === 'synced') {
				logLine(ctx, 'info', `auto preset sync: preset "${outcome.presetId ?? 'this session'}" updated`);
				report(`auto preset sync: preset "${outcome.presetId ?? 'this session'}" updated`);
			} else {
				logLine(ctx, 'warn', `auto preset sync failed: ${tail}`);
				report(`auto preset sync failed: ${tail}`);
			}
		});
	};
	disposers.push(ctx.on('agent/created', onCreated));
	return () => {
		for (const dispose of disposers) dispose();
	};
}

/** Preset ids whose definition this context has already synced; per-plugin-instance, so a test or a second profile starts clean. */
const SYNCED_BY_CONTEXT = new WeakMap();

function getSyncedPresets(ctx) {
	if (ctx === null || (typeof ctx !== 'object' && typeof ctx !== 'function')) return null;
	let presets = SYNCED_BY_CONTEXT.get(ctx);
	if (!presets) {
		presets = new Set();
		SYNCED_BY_CONTEXT.set(ctx, presets);
	}
	return presets;
}

/**
 * Keep a session's preset definition in sync with the routes and settings, for the plane a web profile uses.
 *
 * Does nothing when the process composes no preset registry, and at most once per preset id per context — the write
 * is a profile-patch file, and the trigger fires on every request. Returns the tuning report so the auto path can
 * surface it on stderr, or undefined when there was nothing to do.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 * @param request - the automatic trigger's request.
 * @returns a command result, or undefined.
 */
async function syncPresetDefinition(ctx, config, request) {
	// Everything is guarded: an unguarded throw here rejects the caller's promise and the user sees a silent no-op —
	// the exact shape of "my new model is still untuned and nothing says why". Normal skips stay quiet; a failure
	// always carries its reason.
	try {
		const registry = ctx.get?.('agentPresets');
		if (registry === undefined) return { status: 'skipped', text: 'this profile composes no preset registry' };
		const agent = request.agent;
		const presetId = agent === undefined ? undefined : registry.composedPreset?.(agent.ctx);
		const synced = getSyncedPresets(ctx);
		if (typeof presetId === 'string' && synced?.has(presetId)) {
			return { status: 'skipped', text: `preset "${presetId}" was already synced in this process` };
		}
		const { result } = await tuneCompactionPreset(ctx, config, { agent, signal: request.signal, inplace: true });
		if (typeof presetId === 'string') synced?.add(presetId);
		const text = typeof result?.text === 'string' ? result.text : 'no report';
		return { status: result?.kind === 'success' ? 'synced' : 'failed', text, presetId };
	} catch (error) {
		return { status: 'failed', text: describeError(error) };
	}
}

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
				'realm, so a running session cannot be retuned — tune the preset instead (see `/context-tune preset`)'
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
		// Not a failure: the earliest trigger can fire before the route inventory exists (observed on
		// dsh 0.1.7 in a headless boot, where the provider row resolves a moment later). Reporting it
		// would put a misleading line in front of every successful retune.
		return { deferred: true, error: 'no routable provider/model pairs are visible yet' };
	}
	const summarizationRoute = request.requestedRoute ?? config.compactionRoute;
	let plan;
	try {
		plan = planCompactionTuning({
			routes,
			targetRatio: config.compactionTargetRatio,
			summarizationRoute,
			includeStockDisabled: config.tuneStockDisabledRoutes === true
		});
	} catch (error) {
		return { error: describeError(error) };
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
 * The pruner config this tuning implies.
 * @param current - the pruner row's current config.
 * @param thresholdChars - the requested threshold.
 * @returns the config to write.
 */
export function mergePrunerConfig(current, thresholdChars) {
	return { ...current, thresholdChars };
}

/**
 * Retune the pruner's `thresholdChars`, when the operator asked for one.
 *
 * Same plane and same mechanism as the compaction row, so the same guard applies: where a profile keeps
 * the pruner inside each session's preset realm (a web profile does), the service is absent and there is
 * nothing to write — that is a note on the result, not a failure of the tuning that already happened.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 * @param request - `{{check}}`.
 * @returns `{{text, changed, from, to}}`.
 */
async function tunePruner(ctx, config, request, routes = []) {
	const setting = config.prunerThresholdChars;
	// `0` is an explicit opt-out; `'auto'` derives the value from the routed windows (the smallest, so the strictest
	// route decides), which is what a small window needs — stock's fixed 8192 clips a whole-file read there.
	if (setting === 0 || setting === '0') return { text: '', changed: false };
	const auto = setting === 'auto';
	const wanted = auto
		? (routes.length === 0 ? PRUNER_STOCK_CHARS : Math.min(...routes.map((route) => prunerCharsForRoute(route))))
		: setting;
	const why = auto ? ` (auto: min over ${routes.length || 'no'} route(s), half the message budget capped at ${PRUNER_MAX_CHARS})` : '';
	if (ctx.get?.('toolResultPruner') === undefined) {
		return {
			text: `\nPruner: not reachable from this plane (a web profile keeps it inside each session's preset); \`${PRUNER_ROW_ID}\` left alone.`,
			changed: false
		};
	}
	const editor = ctx.get?.('configEditor');
	const entry = editor?.entries?.().find((candidate) => candidate?.options?.id === PRUNER_ROW_ID);
	if (entry === undefined) {
		return { text: `\nPruner: this profile declares no ${PRUNER_ROW_ID} row; nothing to change.`, changed: false };
	}
	const current = entry.options?.config ?? {};
	const from = Number.isInteger(current.thresholdChars) ? current.thresholdChars : undefined;
	if (from === wanted) return { text: `\nPruner: thresholdChars already ${wanted}.`, changed: false };
	if (request.check === true) {
		return { text: `\nPruner: thresholdChars ${from ?? '(unset)'} -> ${wanted}${why} would change (check: nothing written).`, changed: false, from, to: wanted };
	}
	await editor.edit(entry, () => mergePrunerConfig(current, wanted));
	return { text: `\nPruner: thresholdChars ${from ?? '(unset)'} -> ${wanted}${why}.`, changed: true, from, to: wanted };
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
	if (computed.deferred === true) {
		return { result: { kind: 'deferred', text: `${computed.error}; the next trigger will retry, and /context-tune tune check reports it on demand` } };
	}
	if (computed.error !== undefined) return failure(computed.error);
	const { plan } = computed;
	const current = found.entry.options?.config ?? {};
	const next = mergeTunedConfig(current, plan);
	const changes = changedKeys(current, next);
	const report = renderReport({ plan, changes, current, next, check: request.check === true });
	const pruner = await tunePruner(ctx, config, request, computed.routes ?? []);
	const combined = report + pruner.text;
	if (request.check === true) return { result: { kind: 'success', text: combined } };
	if (changes.length === 0 && pruner.changed === false) {
		return { result: { kind: 'success', text: `${combined}\nAlready tuned: nothing written.` } };
	}
	try {
		if (changes.length > 0) await found.editor.edit(found.entry, () => next);
	} catch (error) {
		return failure(`Writing the compaction config failed: ${describeError(error)}\n\n${report}`);
	}
	appendTunedRecord(request.agent, {
		trigger: request.trigger ?? 'auto',
		plan,
		routes: computed.routes,
		changes,
		...(pruner.changed === true ? { pruner: { thresholdChars: pruner.to } } : {})
	});
	const written = [];
	if (changes.length > 0) written.push(`${COMPACTION_ROW_ID} (${changes.join(', ')})`);
	if (pruner.changed === true) written.push(`${PRUNER_ROW_ID} (thresholdChars ${pruner.from ?? '(unset)'} -> ${pruner.to})`);
	return {
		result: {
			kind: 'success',
			text:
				`${combined}\nRetuned ${written.join('; ')}. Each row restarts on write, so an in-flight compaction ` +
				'is cancelled; the next request uses the new settings, and they are persisted in the profile patch for later boots.'
		}
	};
}

/**
 * Record the retune in the session log for later analysis.
 *
 * Best effort on purpose: a session that refuses the append must not fail the tuning that already
 * happened, so this never throws.
 * @param agent - the agent whose session should record it, when present.
 * @param record - what happened.
 */
function appendTunedRecord(agent, record) {
	const session = agent?.session;
	if (session?.append === undefined) return;
	const plan = record.plan;
	try {
		session.append(TUNED_EVENT, {
			mode: 'runtime',
			trigger: record.trigger,
			thresholdRatio: plan.config.thresholdRatio,
			headroomTokens: plan.config.headroomTokens,
			maxTokens: plan.config.maxTokens,
			changedKeys: record.changes,
			routes: record.routes.map((route) => ({
				provider: route.provider,
				model: route.model,
				contextWindow: route.contextWindow ?? null,
				maxTokens: route.maxTokens ?? null
			})),
			policies: (plan.config.modelPolicies ?? []).map((policy) => ({
				provider: policy.provider,
				model: policy.model,
				thresholdRatio: policy.thresholdRatio,
				headroomTokens: policy.headroomTokens
			})),
			// Present only when the pruner row was retuned in the same call, so an analysis pass can pair
			// the two settings that together decide when a tool result stops mattering.
			...(record.pruner === undefined ? {} : { pruner: record.pruner })
		});
	} catch {
		// A log record is diagnostics; never let it break a tuning that already succeeded.
	}
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
	let writing = false;
	/** The last failure text, so an identical one is not re-reported on every request. */
	let lastFailure;
	/** session -> agent, so session-scoped signals can be resolved without guessing. */
	const agents = new WeakMap();
	/** The most recent write attempt, so a caller (or a test) can await it without blocking a request. */
	let pending = Promise.resolve();
	/**
	 * Recompute and, when the result differs from what the row carries, write it.
	 *
	 * The write happens immediately rather than at some later quiet moment: a one-shot
	 * `dsh headless "task"` never reaches an idle moment, and that is where automated sessions
	 * live. It is safe early — the very first trigger fires before anything can be compacting —
	 * and `tuneCompactionAtRuntime` is idempotent, so an unchanged route writes nothing and a
	 * per-request re-check costs no restarts. What a write does cost is a restart of the
	 * compaction row, so a write that lands later may cancel a compaction in flight; the idle and
	 * model-selection triggers below exist to take that write at a quieter moment when one is
	 * available.
	 * @param agent - the agent to read routes for, when known.
	 * @returns the diagnostic line, or undefined when there was nothing to do.
	 */
	const attempt = async (agent) => {
		if (agent === undefined || writing) return undefined;
		writing = true;
		try {
			const { result } = await tuneCompactionAtRuntime(ctx, readConfig(rawConfig), {
				agent,
				signal: new AbortController().signal,
				check: false
			});
			// The report's first line is always its heading, so the *outcome* is the last one:
			// "Retuned …", "Already tuned: nothing written." or an error sentence.
			const outcome = outcomeLine(result.text);
			const wrote = outcome.startsWith('Retuned');
			const line = `auto compaction tune: ${outcome}`;
			if (result.kind === 'deferred') {
				// Expected on the earliest trigger; silent, and it must not poison the failure memory.
				logLine(ctx, 'debug', line);
				return line;
			}
			if (result.kind !== 'success') {
				// The guard fails identically on every trigger (a web profile, say), and a per-request
				// trigger must not turn that into a per-request line. Report it once, or again when the
				// reason changes; a recovery is reported too, because it clears the memory.
				if (outcome !== lastFailure) {
					lastFailure = outcome;
					logLine(ctx, 'warn', line);
					report(line);
				} else {
					logLine(ctx, 'debug', line);
				}
			} else if (wrote) {
				lastFailure = undefined;
				logLine(ctx, 'info', line);
				report(line);
			} else {
				lastFailure = undefined;
				// A per-request check that found nothing to do must not print anything.
				logLine(ctx, 'debug', line);
			}
			return line;
		} finally {
			writing = false;
		}
	};
	let lastSeenAgent;
	const track = (agent) => {
		if (agent !== undefined) lastSeenAgent = agent;
		if (agent === undefined) return pending;
		if (agent.session !== undefined) agents.set(agent.session, agent);
		pending = attempt(agent) ?? pending;
		return pending;
	};
	// The agent's own creation is the earliest point that carries it: nothing can be compacting yet.
	ctx.on('agent/created', ({ agent }) => track(agent));
	// Every request, before it is sent. This is the guarantee that a route change is applied
	// before the request that would use it; it must hand the decision on and never block on the write.
	ctx.on('agent/request', ({ agent }, next) => {
		void track(agent);
		return next();
	});
	// The session switched models: the route is known to have changed, and this moment is quieter
	// than the request that follows.
	ctx.on('session/event', (session, event) => {
		if (event?.type !== 'model/selection') return undefined;
		return track(agents.get(session));
	});
	// A long-lived profile offers an idle moment between steps; writing there avoids restarting the
	// compaction row in the middle of one.
	ctx.on('agent/status', ({ agent, status }) => (status === 'idle' ? track(agent) : undefined));
	// The write is intentionally not awaited on the request path; this handle is how a caller (or a
	// test) waits for the last one without changing that.
	return { pending: () => pending, flush: () => track(lastSeenAgent) };
}

/** Last non-empty line of a report — its outcome, not its heading. */
function outcomeLine(text) {
	const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
	return lines[lines.length - 1] ?? text.trim();
}

/** Log through the context logger when it is available. */
function logLine(ctx, level, message) {
	const logger = ctx.logger;
	if (logger?.[level] === undefined) return;
	logger[level](`context-trim: ${message}`);
}

/**
 * Also put a notable line on stderr.
 *
 * The cordis logger only reaches a user when the profile wires an exporter, and a headless
 * profile does not — it writes its own diagnostics to stderr and nothing else. A retune is
 * rare (once per route change) and it changes behaviour, so one line here is worth having:
 * `docker logs` shows it, and it costs nothing in the model's context.
 * @param message - the line to report.
 */
function report(message) {
	process.stderr?.write?.(`context-trim: ${message}\n`);
}
