/**
 * Tokenizer calibration: how far DSH's token estimate is from what the provider charges.
 *
 * `@deepseek-ai/dsh-token-meter` prices every block at a fixed `CHARS_PER_TOKEN = 4`
 * (`dsh-token-meter/lib/types/estimate.js`). That is a *density assumption*, and on a real
 * agent session it is wrong in one direction: a session's content is denser than four
 * characters per token, so the meter undercounts the request and the plugin's budget
 * arithmetic inherits the error.
 *
 * Measured over a production session (5 routes, 2 805 requests, replayed through the meter's
 * own surface fold): the real prompt was 1.013×-1.324× the meter's estimate, median
 * 1.175, p90 1.280. The factor is stable per route and comfortably above 1, i.e. DSH
 * *under*-estimates — the direction that makes a session overflow after the plugin already
 * decided it fit.
 *
 * Why this matters to the trimmer, concretely: the token meter already substitutes the
 * provider's real usage for its own estimate when the request envelope matches its anchor
 * (`baseline.kind === 'usage'`), so `measurement.totalTokens` can be in *real* tokens while
 * `measurement.nodes[].heuristicTokens` stay in *heuristic* tokens. The planner needs both
 * in one unit — `need` is compared against freed amounts — so one side has to be converted.
 * Converting the node prices with the route's factor does that, and it is the conversion
 * that survives a route switch, a header change, and a session with no completed request:
 * the factor is learned from real usage and kept, rather than borrowed from one request.
 *
 * The factor is **never below 1**: a factor under 1 would mean DSH over-estimates, and
 * trimming on that basis would discard context that fitted. Under-estimating is the only
 * dangerous direction, so the factor is clamped up, never down.
 *
 * Pure arithmetic and bookkeeping: no dsh imports, no I/O. The runtime half lives in
 * `./calibrate-runtime.js`.
 *
 * @module dsh-command-context-trim/calibration
 */

/** Observations a route needs before its factor is believed. */
export const CALIBRATION_MIN_SAMPLES = 3;

/** How many observations one route keeps; older ones fall out of the window. */
export const CALIBRATION_SAMPLE_WINDOW = 50;

/** The factor never drops below this: DSH over-estimating is not a reason to trim. */
export const CALIBRATION_MIN_FACTOR = 1;

/**
 * dsh's own fixed-density constants, mirrored from
 * `@deepseek-ai/dsh-token-meter/lib/types/estimate.js`.
 *
 * The token-meter service exposes `measure()` and `estimateMessage()` but not
 * `estimateToolsTokens()`, so the request envelope's price has to be recomputed here.
 * The coupling is deliberate and narrow: two constants, used only to price the *tool
 * schemas* of one request, and always in the same direction as the meter.
 */
const CHARS_PER_TOKEN = 4;
const TOOLS_OVERHEAD = 4;

/**
 * The heuristic price of a request envelope's tool schemas.
 *
 * Mirrors the token meter's `estimateToolsTokens(header)`: the JSON length of the tool
 * declarations at four characters per token, plus four tokens of framing.
 * @param header - canonical request header, or undefined before any request.
 * @returns heuristic tokens for the tool schemas; 0 when there are none.
 */
export function estimateEnvelopeTokens(header) {
	const tools = header?.tools;
	if (!Array.isArray(tools) || tools.length === 0) return 0;
	return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + TOOLS_OVERHEAD;
}

/**
 * Convert a heuristic price into a real-token price.
 * @param heuristicTokens - price under dsh's fixed-density assumption.
 * @param factor - the route's calibration factor; 1 leaves the price unchanged.
 * @returns the real-token price, rounded up.
 */
export function realTokens(heuristicTokens, factor) {
	if (!Number.isFinite(heuristicTokens) || heuristicTokens <= 0) return 0;
	if (!Number.isFinite(factor) || factor <= 1) return Math.ceil(heuristicTokens);
	return Math.ceil(heuristicTokens * factor);
}

/**
 * The quantile of a sorted sample, by the nearest-rank method.
 * @param sorted - ascending array of numbers.
 * @param q - quantile in (0, 1].
 * @returns the quantile value, or undefined for an empty sample.
 */
export function quantile(sorted, q) {
	if (!Array.isArray(sorted) || sorted.length === 0) return undefined;
	const rank = Math.ceil(q * sorted.length);
	const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
	return sorted[index];
}

/**
 * The factor a route's observations imply.
 *
 * The factor is content-dependent — a prose-heavy session measures near 1, a log-heavy one
 * near 3 — so a single mean would over-trim prose and under-trim tools. The p90 is used
 * instead: a high quantile biases towards over-trimming, which costs some history but
 * never produces an overflow. That is the right trade for a tool whose whole job is to
 * prevent a deadlocked session.
 *
 * @param samples - observed factors, oldest first.
 * @returns the factor to apply, or undefined when there are too few observations to believe.
 */
export function factorFromSamples(samples) {
	if (!Array.isArray(samples) || samples.length < CALIBRATION_MIN_SAMPLES) return undefined;
	const sorted = samples.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
	if (sorted.length < CALIBRATION_MIN_SAMPLES) return undefined;
	const p90 = quantile(sorted, 0.9);
	if (p90 === undefined) return undefined;
	return Math.max(CALIBRATION_MIN_FACTOR, p90);
}

/**
 * The route key a sample belongs to.
 * @param provider - route provider.
 * @param model - route model.
 * @returns the key, or undefined when either half is missing.
 */
export function routeKey(provider, model) {
	if (typeof provider !== 'string' || provider.length === 0) return undefined;
	if (typeof model !== 'string' || model.length === 0) return undefined;
	return `${provider}:${model}`;
}

/**
 * Create the per-route calibration table.
 *
 * One entry per route, each holding the observations of the last
 * {@link CALIBRATION_SAMPLE_WINDOW} requests that ran on it. The table is the plugin's
 * only learned state, and it is deliberately small enough to serialise into the profile.
 *
 * @returns the table: `observe`, `factorFor`, `routes`, `snapshot`, `restore`.
 */
export function createCalibration() {
	/** route key -> { samples: number[], lastSeen: number } */
	const routes = new Map();
	return {
		/**
		 * Record one observation for a route.
		 * @param key - route key.
		 * @param factor - the observed factor (real prompt over heuristic prompt).
		 * @param at - timestamp of the observation, for freshness.
		 * @returns nothing.
		 */
		observe(key, factor, at) {
			if (typeof key !== 'string' || key.length === 0) return;
			if (!Number.isFinite(factor) || factor <= 0) return;
			const entry = routes.get(key) ?? { samples: [], lastSeen: 0 };
			entry.samples.push(factor);
			if (entry.samples.length > CALIBRATION_SAMPLE_WINDOW) entry.samples.shift();
			entry.lastSeen = Number.isFinite(at) ? at : Date.now();
			routes.set(key, entry);
		},
		/**
		 * The factor to apply for a route.
		 * @param key - route key.
		 * @returns the factor, or 1 when the route has too few observations to believe.
		 */
		factorFor(key) {
			if (typeof key !== 'string' || key.length === 0) return CALIBRATION_MIN_FACTOR;
			const entry = routes.get(key);
			if (entry === undefined) return CALIBRATION_MIN_FACTOR;
			return factorFromSamples(entry.samples) ?? CALIBRATION_MIN_FACTOR;
		},
		/**
		 * Every known route with its current factor and observation count.
		 * @returns an array of `{ key, factor, samples, lastSeen }`.
		 */
		list() {
			return [...routes.entries()].map(([key, entry]) => ({
				key,
				factor: factorFromSamples(entry.samples) ?? CALIBRATION_MIN_FACTOR,
				samples: entry.samples.length,
				lastSeen: entry.lastSeen
			}));
		},
		/**
		 * The serialisable form of the table.
		 * @returns `{ version, routes }` with the observation window per route.
		 */
		snapshot() {
			return {
				version: 1,
				routes: [...routes.entries()].map(([key, entry]) => ({
					key,
					samples: [...entry.samples],
					lastSeen: entry.lastSeen
				}))
			};
		},
		/**
		 * Restore a previously captured table.
		 *
		 * A malformed snapshot is ignored rather than trusted: a corrupt file must not be
		 * able to make the trimmer believe a factor it never measured.
		 * @param snapshot - the value produced by `snapshot()`.
		 * @returns nothing.
		 */
		restore(snapshot) {
			if (snapshot === null || typeof snapshot !== 'object') return;
			if (!Array.isArray(snapshot.routes)) return;
			for (const entry of snapshot.routes) {
				if (entry === null || typeof entry !== 'object') continue;
				if (typeof entry.key !== 'string' || entry.key.length === 0) continue;
				if (!Array.isArray(entry.samples)) continue;
				const samples = entry.samples.filter((value) => Number.isFinite(value) && value > 0);
				if (samples.length === 0) continue;
				routes.set(entry.key, {
					samples: samples.slice(-CALIBRATION_SAMPLE_WINDOW),
					lastSeen: Number.isFinite(entry.lastSeen) ? entry.lastSeen : 0
				});
			}
		}
	};
}
