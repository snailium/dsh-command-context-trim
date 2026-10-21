/**
 * Runtime half of the tokenizer calibration.
 *
 * Two jobs:
 *
 * 1. **Learn.** Every `assistant/message` that carries `usage` is one request the provider
 *    has already priced, so it is one observation of how far the meter's estimate was from
 *    the truth. The observation compares the provider's real prompt size against the
 *    meter's estimate of *the same request* — the surface as it stood immediately before
 *    that assistant message, plus the request envelope's tool schemas.
 * 2. **Remember.** A factor learned over a long session has to survive a restart; otherwise
 *    every restart re-runs the bootstrap in a session that is already large, which is
 *    exactly when the factor is needed. The table is stored next to the profile patch.
 *
 * The learned table is held per plugin context, not in a module-level variable: a
 * module-level handle would leak one profile's measurements into another profile in the
 * same process, and into the next test. The table is optional — with no table, every
 * factor is 1 and the trimmer behaves exactly as it did before.
 *
 * @module dsh-command-context-trim/calibrate-runtime
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	CALIBRATION_MIN_FACTOR,
	createCalibration,
	estimateEnvelopeTokens,
	factorFromSamples,
	routeKey
} from './calibration.js';

/** File name of the calibration table, inside the profile directory. */
const CALIBRATION_FILE = 'context-trim-calibration.json';

/** How long a pending write waits before it is flushed, in milliseconds. */
const SAVE_DEBOUNCE_MS = 2000;

/**
 * The live calibration table per plugin context.
 * @type {WeakMap<object, ReturnType<typeof createCalibration>>}
 */
const tables = new WeakMap();

/**
 * The calibration table in force for a context, or null.
 * @param ctx - plugin context.
 * @returns the table, or null when calibration is not registered for this context.
 */
export function currentCalibration(ctx) {
	return tables.get(ctx) ?? null;
}

/**
 * The factor to apply for a route.
 *
 * Returns 1 whenever the route is unknown, has too few observations, or no table is
 * registered — so a fresh profile and a fresh route behave exactly as they did before
 * calibration existed.
 * @param ctx - plugin context.
 * @param key - route key (`provider:model`), or undefined.
 * @returns the factor, never below 1.
 */
export function factorForRoute(ctx, key) {
	const table = tables.get(ctx);
	if (table === undefined) return CALIBRATION_MIN_FACTOR;
	return table.factorFor(key);
}

/**
 * The factor a trim against one route should use.
 *
 * The target route's own factor is preferred: the trim is fitting the content into *that*
 * model's window, so that model's tokenizer is what prices it. A target route nobody has
 * measured yet — a switch to a new model — falls back to the session's current route,
 * whose factor describes the content being trimmed, and to 1 when that is unknown too.
 * @param ctx - plugin context.
 * @param targetKey - route key of the trim's target, or undefined.
 * @param sessionKey - route key of the session's current request, or undefined.
 * @returns the factor, never below 1.
 */
export function factorForTrim(ctx, targetKey, sessionKey) {
	const target = factorForRoute(ctx, targetKey);
	if (target > CALIBRATION_MIN_FACTOR) return target;
	return factorForRoute(ctx, sessionKey);
}

/**
 * The route key of a request header.
 * @param header - canonical request header.
 * @returns the key, or undefined when the header carries no route.
 */
export function headerRouteKey(header) {
	const config = header?.config;
	if (config === undefined) return undefined;
	return routeKey(config.provider, config.model);
}

/**
 * Observe one completed request.
 *
 * The real prompt is the provider's own count of the tokens it was sent: `inputTokens`
 * plus the cache fields, which dsh keeps disjoint (`inputTokens` is the uncached part).
 * The estimate is the meter's price of the same request: the surface as it stood before
 * this assistant message — the message itself was the *answer*, not part of the request —
 * plus the envelope's tool schemas.
 *
 * @param ctx - plugin context (token meter).
 * @param session - session the request belonged to.
 * @param event - the `assistant/message` event carrying `usage`.
 * @returns the observed `{ key, factor }`, or undefined when the request cannot be priced.
 */
export function observeRequest(ctx, session, event) {
	const usage = event?.data?.usage;
	if (usage === null || typeof usage !== 'object') return undefined;
	const realPrompt = Number(usage.inputTokens ?? 0) + Number(usage.cacheReadTokens ?? 0) + Number(usage.cacheWriteTokens ?? 0);
	if (!Number.isFinite(realPrompt) || realPrompt <= 0) return undefined;
	const header = session.requestHeader();
	if (header === undefined) return undefined;
	const key = headerRouteKey(header);
	if (key === undefined) return undefined;
	const measurement = ctx.tokenMeter.measure(session);
	if (measurement === undefined) return undefined;
	// The assistant message is the response, not part of the request that produced it, so
	// its own node is removed from the surface price.
	const own = measurement.nodes.find((node) => node.seq === event.seq);
	const surfaceTokens = Math.max(0, measurement.surfaceTokens - (own?.heuristicTokens ?? 0));
	const estimatedPrompt = surfaceTokens + estimateEnvelopeTokens(header);
	if (!Number.isFinite(estimatedPrompt) || estimatedPrompt <= 0) return undefined;
	return { key, factor: realPrompt / estimatedPrompt };
}

/**
 * Register the calibration listener and load any persisted table.
 *
 * @param ctx - plugin context (token meter, logger, profile context).
 * @returns a disposer that stops listening and flushes the table.
 */
export function registerCalibration(ctx) {
	if (tables.has(ctx)) return () => undefined;
	const table = createCalibration();
	tables.set(ctx, table);
	void loadCalibration(ctx, table);
	let pending = null;
	const schedule = () => {
		if (pending !== null) return;
		pending = setTimeout(() => {
			pending = null;
			void saveCalibration(ctx, table);
		}, SAVE_DEBOUNCE_MS);
		pending.unref?.();
	};
	const listener = (session, event) => {
		if (event?.type !== 'assistant/message') return;
		const observation = observeRequest(ctx, session, event);
		if (observation === undefined) return;
		table.observe(observation.key, observation.factor, Date.now());
		schedule();
	};
	ctx.on('session/event', listener);
	return () => {
		if (tables.get(ctx) !== table) return;
		if (pending !== null) {
			clearTimeout(pending);
			pending = null;
		}
		void saveCalibration(ctx, table);
		tables.delete(ctx);
	};
}

/**
 * The profile directory the calibration table is stored in.
 * @param ctx - plugin context.
 * @returns the directory, or undefined when the profile cannot be located.
 */
function calibrationPath(ctx) {
	const profile = ctx.get?.('profileContext');
	const dir = profile?.dir;
	if (typeof dir !== 'string' || dir.length === 0) return undefined;
	return join(dir, CALIBRATION_FILE);
}

/**
 * Load a persisted calibration table, ignoring anything unreadable.
 * @param ctx - plugin context.
 * @param table - the table to fill.
 * @returns nothing; a missing or corrupt file leaves the table empty.
 */
async function loadCalibration(ctx, table) {
	const path = calibrationPath(ctx);
	if (path === undefined) return;
	try {
		const text = await readFile(path, 'utf8');
		table.restore(JSON.parse(text));
	} catch {
		// A missing file is the normal first-run case; a corrupt one is ignored on
		// purpose: a factor the plugin never measured must not be believed.
	}
}

/**
 * Persist the calibration table, atomically.
 * @param ctx - plugin context.
 * @param table - the table to write.
 * @returns nothing; a failed write is not fatal, the table simply starts over next boot.
 */
export async function saveCalibration(ctx, table) {
	const path = calibrationPath(ctx);
	if (path === undefined) return;
	const snapshot = table.snapshot();
	if (snapshot.routes.length === 0) return;
	try {
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.tmp-${process.pid}`;
		await writeFile(temporary, `${JSON.stringify(snapshot, undefined, '\t')}\n`, 'utf8');
		await rename(temporary, path);
	} catch {
		// Persistence is a convenience: a profile that cannot hold the file keeps
		// calibrating from scratch, which is the pre-calibration behaviour.
	}
}

/**
 * The routes a calibration table knows, with their factors and observation counts.
 * @param ctx - plugin context.
 * @returns an array of `{ key, factor, samples, lastSeen }`; empty when nothing is registered.
 */
export function knownRoutes(ctx) {
	const table = tables.get(ctx);
	if (table === undefined) return [];
	return table.list();
}

export { factorFromSamples };
