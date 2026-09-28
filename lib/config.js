/**
 * Configuration resolution for the model-free `/trim` command.
 *
 * Every field is validated and detached at plugin load, so a bad profile patch
 * fails loudly once at boot instead of silently distorting a trim later.
 *
 * Fields marked `.volatile()` in the loader schema arrive here as **live handles**
 * (read with `.get()`), not as values, so every read goes through `configValue`.
 * `readConfig` re-reads a raw configuration on demand, which is what makes a
 * settings-card edit take effect without reloading the plugin.
 *
 * @module dsh-command-context-trim/config
 */

import { TRIM_MARKER } from './prune-first.js';

/** Built-in defaults, mirrored by the bundle patch's commented config block. */
/**
 * Parse a boolean that the settings card edited as text.
 *
 * The card's only controls are text fields (0.1.7's primitives expose no switch), and a volatile field's
 * schema does not reject a string on the way in, so `"true"`/`"false"`/`"1"`/`"0"` all arrive here.
 * @param value - resolved value, from the loader or from a card edit.
 * @param name - field name for the error message.
 * @returns the boolean, or the value unchanged when it is already one.
 * @throws when the text is not a recognised boolean.
 */
function coerceCardFlag(value, name) {
	if (typeof value === 'boolean' || value === undefined) return value;
	if (typeof value === 'string') {
		const text = value.trim().toLowerCase();
		if (text === '') return undefined;
		if (['true', 'yes', 'on', '1'].includes(text)) return true;
		if (['false', 'no', 'off', '0'].includes(text)) return false;
	}
	throw new Error(`ContextTrimConfig: ${name} must be a boolean (the settings card accepts true/false)`);
}

/**
 * Parse an integer that the settings card edited as text.
 * @param value - resolved value.
 * @param name - field name for the error message.
 * @returns the integer, or the value unchanged when it is already one.
 * @throws when the text is not an integer.
 */
function coerceCardInteger(value, name) {
	if (typeof value === 'number' || value === undefined) return value;
	if (typeof value === 'string' && value.trim() !== '' && Number.isInteger(Number(value))) return Number(value);
	throw new Error(`ContextTrimConfig: ${name} must be an integer (the settings card accepts digits)`);
}

export const DEFAULTS = Object.freeze({
	targetRatio: 0.9,
	reserveOutputTokens: 8192,
	retainRatio: 0.16,
	minTailTokens: 2048,
	protectHeadNodes: 1,
	allowTailTrim: true,
	markerSlackTokens: 64,
	autoTrim: true,
	maxAutoTrimRetries: 3,
	autoTrimShrink: 0.5,
	preferInPlacePrune: true,
	pruneThresholdChars: 8192,
	pruneHeadChars: 4096,
	pruneTailChars: 1024,
	emergencyTrim: true,
	autoTuneCompaction: false,
	tuneStockDisabledRoutes: false,
	prunerThresholdChars: 'auto',
	compactionTargetRatio: 0.8
});

/** Every key this plugin accepts. */
const CONFIG_KEYS = new Set([
	'targetRatio',
	'reserveOutputTokens',
	'retainRatio',
	'retainTokens',
	'minTailTokens',
	'protectHeadNodes',
	'allowTailTrim',
	'markerSlackTokens',
	'autoTrim',
	'maxAutoTrimRetries',
	'autoTrimShrink',
	'preferInPlacePrune',
	'pruneThresholdChars',
	'pruneHeadChars',
	'pruneTailChars',
	'emergencyTrim',
	'autoTuneCompaction',
	'tuneStockDisabledRoutes',
	'prunerThresholdChars',
	'compactionTargetRatio',
	'compactionRoute'
]);

/**
 * Validate one untrusted configuration object and fill in defaults.
 * @param config - raw plugin configuration from the loader.
 * @returns a detached frozen configuration.
 * @throws when a key is unknown or a value is out of range.
 */
export function resolveConfig(config = {}) {
	config = plainConfig(config);
	for (const key of Object.keys(config)) {
		if (!CONFIG_KEYS.has(key)) {
			throw new Error(`ContextTrimConfig: unknown key "${key}" (allowed: ${[...CONFIG_KEYS].join(', ')})`);
		}
	}
	const targetRatio = config.targetRatio ?? DEFAULTS.targetRatio;
	const reserveOutputTokens = config.reserveOutputTokens ?? DEFAULTS.reserveOutputTokens;
	const minTailTokens = config.minTailTokens ?? DEFAULTS.minTailTokens;
	const protectHeadNodes = config.protectHeadNodes ?? DEFAULTS.protectHeadNodes;
	const allowTailTrim = config.allowTailTrim ?? DEFAULTS.allowTailTrim;
	const markerSlackTokens = config.markerSlackTokens ?? DEFAULTS.markerSlackTokens;
	const autoTrim = config.autoTrim ?? DEFAULTS.autoTrim;
	const maxAutoTrimRetries = config.maxAutoTrimRetries ?? DEFAULTS.maxAutoTrimRetries;
	const autoTrimShrink = config.autoTrimShrink ?? DEFAULTS.autoTrimShrink;
	const preferInPlacePrune = config.preferInPlacePrune ?? DEFAULTS.preferInPlacePrune;
	const pruneThresholdChars = config.pruneThresholdChars ?? DEFAULTS.pruneThresholdChars;
	const pruneHeadChars = config.pruneHeadChars ?? DEFAULTS.pruneHeadChars;
	const pruneTailChars = config.pruneTailChars ?? DEFAULTS.pruneTailChars;
	const emergencyTrim = config.emergencyTrim ?? DEFAULTS.emergencyTrim;
	// The environment wins over the profile: a container sets DSH_TRIM_AUTO_TUNE=1 once instead of
	// patching every profile it boots.
	const autoTuneCompaction = coerceCardFlag(envFlag(AUTO_TUNE_ENV) ?? config.autoTuneCompaction ?? DEFAULTS.autoTuneCompaction, 'autoTuneCompaction') ?? DEFAULTS.autoTuneCompaction;
	const tuneStockDisabledRoutes = coerceCardFlag(envFlag(STOCK_DISABLED_ENV) ?? config.tuneStockDisabledRoutes ?? DEFAULTS.tuneStockDisabledRoutes, 'tuneStockDisabledRoutes') ?? DEFAULTS.tuneStockDisabledRoutes;
	const prunerThresholdChars = coercePrunerSetting(envPruner() ?? config.prunerThresholdChars ?? DEFAULTS.prunerThresholdChars, 'prunerThresholdChars') ?? DEFAULTS.prunerThresholdChars;
	const compactionTargetRatio = config.compactionTargetRatio ?? DEFAULTS.compactionTargetRatio;
	const compactionRoute = resolveCompactionRoute(config.compactionRoute);
	assertRatio('targetRatio', targetRatio);
	assertNonNegativeInteger('reserveOutputTokens', reserveOutputTokens);
	assertNonNegativeInteger('minTailTokens', minTailTokens);
	assertNonNegativeInteger('protectHeadNodes', protectHeadNodes);
	assertNonNegativeInteger('markerSlackTokens', markerSlackTokens);
	assertNonNegativeInteger('maxAutoTrimRetries', maxAutoTrimRetries);
	assertRatio('autoTrimShrink', autoTrimShrink);
	// The generated-preset knobs: the ratio is a target for compaction's own
	// thresholdRatio, and the optional route must be a complete pair.
	assertRatio('compactionTargetRatio', compactionTargetRatio);
	if (typeof autoTrim !== 'boolean') throw new Error('ContextTrimConfig: autoTrim must be a boolean');
	if (typeof preferInPlacePrune !== 'boolean') throw new Error('ContextTrimConfig: preferInPlacePrune must be a boolean');
	if (typeof emergencyTrim !== 'boolean') throw new Error('ContextTrimConfig: emergencyTrim must be a boolean');
	if (typeof autoTuneCompaction !== 'boolean') throw new Error('ContextTrimConfig: autoTuneCompaction must be a boolean');
	if (typeof tuneStockDisabledRoutes !== 'boolean') throw new Error('ContextTrimConfig: tuneStockDisabledRoutes must be a boolean');
	if (prunerThresholdChars !== 'auto' && (!Number.isInteger(prunerThresholdChars) || prunerThresholdChars < 0)) {
		throw new Error("ContextTrimConfig: prunerThresholdChars must be 'auto', 0 (leave it alone), or a positive integer");
	}
	assertNonNegativeInteger('pruneHeadChars', pruneHeadChars);
	assertNonNegativeInteger('pruneTailChars', pruneTailChars);
	assertPositiveInteger('pruneThresholdChars', pruneThresholdChars);
	// Mirror the official pruner's load-time guard: the emitted head + marker + tail
	// must fit inside the threshold, or a rewrite could not both shrink and comply.
	const emitted = pruneHeadChars + TRIM_MARKER.length + pruneTailChars;
	if (emitted > pruneThresholdChars) {
		throw new Error(`ContextTrimConfig: pruneHeadChars + marker + pruneTailChars (${emitted}) must be at most pruneThresholdChars (${pruneThresholdChars})`);
	}
	if (typeof allowTailTrim !== 'boolean') throw new Error('ContextTrimConfig: allowTailTrim must be a boolean');
	const retention = resolveRetention(config);
	if (retention.retainRatio !== undefined && retention.retainRatio >= targetRatio) {
		throw new Error(`ContextTrimConfig: retainRatio (${retention.retainRatio}) must be less than targetRatio (${targetRatio})`);
	}
	return Object.freeze({
		targetRatio,
		reserveOutputTokens,
		...retention,
		minTailTokens,
		protectHeadNodes,
		allowTailTrim,
		markerSlackTokens,
		autoTrim,
		maxAutoTrimRetries,
		autoTrimShrink,
		preferInPlacePrune,
		pruneThresholdChars,
		pruneHeadChars,
		pruneTailChars,
		emergencyTrim,
		autoTuneCompaction,
		tuneStockDisabledRoutes,
		prunerThresholdChars,
		compactionTargetRatio,
		...(compactionRoute === undefined ? {} : { compactionRoute })
	});
}

/**
 * Read a boolean from the environment, for settings a container wants to set once rather than
 * patch into a profile. Unset (or empty) means "no opinion"; anything unrecognized throws, because
 * a typo silently disabling a feature is worse than a loud failure at load.
 * @param name - environment variable name.
 * @returns the parsed boolean, or undefined when the variable carries no value.
 */
export function envFlag(name) {
	const raw = process.env?.[name];
	if (raw === undefined || raw.trim().length === 0) return undefined;
	const text = raw.trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(text)) return true;
	if (['0', 'false', 'no', 'off'].includes(text)) return false;
	throw new Error(`ContextTrimConfig: ${name} must be one of 1/true/yes/on or 0/false/no/off, got "${raw}"`);
}

/** Environment variable that overrides `autoTuneCompaction`. */
export const AUTO_TUNE_ENV = 'DSH_TRIM_AUTO_TUNE';

/**
 * Environment variable that overrides `prunerThresholdChars`.
 *
 * The one knob a small-window route needs: on a window at or below 64K, stock dsh has no pressure trigger, so
 * raising the tool-result pruner's clip threshold is what stops a whole-file read being cut to a head and a tail.
 * A container entrypoint can set this once instead of patching every profile it boots.
 */
export const PRUNER_ENV = 'DSH_TRIM_PRUNER';

/** Environment variable that overrides `tuneStockDisabledRoutes`. */
export const STOCK_DISABLED_ENV = 'DSH_TRIM_TUNE_STOCK_DISABLED';

/**
 * Coerce the pruner threshold setting.
 *
 * `'auto'` (the default) lets the tuner compute the value per route; `0` is an explicit opt-out that leaves the
 * pruner row alone; a positive integer is used as given. A settings card can only type text, so digits arrive as
 * strings and are accepted.
 * @param value - raw setting.
 * @param name - field name for the error message.
 * @returns `'auto'`, an integer, or undefined when unset.
 * @throws when the value is none of those.
 */
function coercePrunerSetting(value, name) {
	if (value === undefined) return undefined;
	if (typeof value === 'string' && value.trim().toLowerCase() === 'auto') return 'auto';
	const parsed = coerceCardInteger(value, name);
	if (parsed === undefined) return undefined;
	if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`ContextTrimConfig: ${name} must be 'auto', 0, or a positive integer`);
	return parsed;
}

/**
 * Read the pruner setting from the environment, treating blank as unset.
 * @returns the raw variable, or undefined.
 */
function envPruner() {
	const raw = process.env[PRUNER_ENV];
	return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

/**
 * Read an integer from the environment.
 * @param name - variable name.
 * @returns the integer, or undefined when the variable is unset or empty.
 * @throws when the value is not a non-negative integer.
 */
export function envInteger(name) {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === '') return undefined;
	if (!/^\d+$/u.test(raw.trim())) throw new Error(`ContextTrimConfig: ${name} must be a non-negative integer, got "${raw}"`);
	return Number(raw.trim());
}

/**
 * Read one configuration value, unwrapping a volatile live handle when present.
 * @param raw - a plain value or a schemastery volatile handle.
 * @returns the value.
 */
export function configValue(raw) {
	if (raw === null || raw === undefined) return raw;
	if (typeof raw === 'object' && typeof raw.get === 'function') return raw.get();
	return raw;
}

/** Unwrap every volatile field handle in one raw configuration object. */
function plainConfig(config) {
	if (config === null || typeof config !== 'object') return {};
	const out = {};
	for (const [key, value] of Object.entries(config)) out[key] = configValue(value);
	return out;
}

/**
 * Resolve a configuration that may still carry volatile handles.
 * Safe to call repeatedly: it is how a live settings edit is picked up.
 * @param config - raw loader configuration (handles or plain values).
 * @returns a detached frozen configuration.
 */
export function readConfig(config = {}) {
	return resolveConfig(plainConfig(config));
}

/**
 * Validate the optional summarization route used by generated presets.
 * Mirrors dsh's own rule: the pair is empty or complete, never half set.
 * @param configured - raw `compactionRoute` value from the loader.
 * @returns a detached frozen route, or `undefined` when the setting is absent.
 * @throws when the shape is wrong or only one half is given.
 */
function resolveCompactionRoute(configured) {
	if (configured === undefined) return undefined;
	// The settings card edits a single text field, so "provider:model" is accepted
	// beside the structured form the configuration file uses.
	if (typeof configured === 'string') {
		// A text field, so tolerate surrounding whitespace on both halves. The first
		// colon separates provider from model (model ids may themselves contain colons).
		const text = configured.trim();
		if (text.length === 0) return undefined;
		const colon = text.indexOf(':');
		const provider = colon < 0 ? '' : text.slice(0, colon).trim();
		const model = colon < 0 ? '' : text.slice(colon + 1).trim();
		if (provider.length === 0 || model.length === 0) {
			throw new Error('ContextTrimConfig: compactionRoute must read "provider:model" (or be { provider, model })');
		}
		return Object.freeze({ provider, model });
	}
	if (typeof configured !== 'object' || configured === null || Array.isArray(configured)) {
		throw new Error('ContextTrimConfig: compactionRoute must be an object with provider and model');
	}
	for (const key of Object.keys(configured)) {
		if (key !== 'provider' && key !== 'model') {
			throw new Error(`ContextTrimConfig: compactionRoute.${key} is not a supported key (allowed: provider, model)`);
		}
	}
	const { provider, model } = configured;
	if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
		throw new Error('ContextTrimConfig: compactionRoute.provider and compactionRoute.model must be set together as non-empty strings');
	}
	return Object.freeze({ provider, model });
}

/** Choose one explicit retention form, rejecting the ambiguous pair. */
function resolveRetention(config) {
	const retainRatio = config.retainRatio;
	const retainTokens = config.retainTokens;
	if (retainRatio !== undefined && retainTokens !== undefined) {
		throw new Error('ContextTrimConfig: retainRatio and retainTokens are mutually exclusive');
	}
	if (retainTokens !== undefined) {
		assertNonNegativeInteger('retainTokens', retainTokens);
		return { retainTokens };
	}
	const resolved = retainRatio ?? DEFAULTS.retainRatio;
	assertRatio('retainRatio', resolved);
	return { retainRatio: resolved };
}

/**
 * Request-token budget a trim aims for on one model capacity.
 * @param contextWindow - positive adapter-owned capacity of the target model.
 * @param config - resolved configuration.
 * @returns the target total request size in tokens.
 * @throws when the reserved output budget leaves no usable window.
 */
export function budgetFor(contextWindow, config) {
	if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
		throw new Error(`context trim: contextWindow (${String(contextWindow)}) must be a positive integer`);
	}
	const usable = contextWindow - config.reserveOutputTokens;
	if (usable <= 0) {
		throw new Error(`context trim: reserveOutputTokens (${config.reserveOutputTokens}) leaves no room inside the ${contextWindow}-token window`);
	}
	return Math.max(1, Math.floor(usable * config.targetRatio));
}

/**
 * Verbatim recent-tail budget resolved for one model capacity.
 * @param contextWindow - positive adapter-owned capacity of the target model.
 * @param config - resolved configuration.
 * @returns tokens kept verbatim at the end of the conversation.
 */
export function retentionFor(contextWindow, config) {
	const configured = config.retainTokens ?? Math.floor(contextWindow * config.retainRatio);
	return Math.max(config.minTailTokens, configured);
}

function assertRatio(name, value) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
		throw new Error(`ContextTrimConfig: ${name} (${String(value)}) must be a number in (0, 1]`);
	}
}

function assertPositiveInteger(name, value) {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`ContextTrimConfig: ${name} (${String(value)}) must be a positive integer`);
	}
}

function assertNonNegativeInteger(name, value) {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`ContextTrimConfig: ${name} (${String(value)}) must be a non-negative integer`);
	}
}
