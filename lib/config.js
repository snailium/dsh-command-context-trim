/**
 * Configuration resolution for the model-free `/trim` command.
 *
 * Every field is validated and detached at plugin load, so a bad profile patch
 * fails loudly once at boot instead of silently distorting a trim later.
 *
 * @module dsh-command-context-trim/config
 */

import { TRIM_MARKER } from './prune-first.js';

/** Built-in defaults, mirrored by the bundle patch's commented config block. */
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
	pruneTailChars: 1024
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
	'pruneTailChars'
]);

/**
 * Validate one untrusted configuration object and fill in defaults.
 * @param config - raw plugin configuration from the loader.
 * @returns a detached frozen configuration.
 * @throws when a key is unknown or a value is out of range.
 */
export function resolveConfig(config = {}) {
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
	assertRatio('targetRatio', targetRatio);
	assertNonNegativeInteger('reserveOutputTokens', reserveOutputTokens);
	assertNonNegativeInteger('minTailTokens', minTailTokens);
	assertNonNegativeInteger('protectHeadNodes', protectHeadNodes);
	assertNonNegativeInteger('markerSlackTokens', markerSlackTokens);
	assertNonNegativeInteger('maxAutoTrimRetries', maxAutoTrimRetries);
	assertRatio('autoTrimShrink', autoTrimShrink);
	if (typeof autoTrim !== 'boolean') throw new Error('ContextTrimConfig: autoTrim must be a boolean');
	if (typeof preferInPlacePrune !== 'boolean') throw new Error('ContextTrimConfig: preferInPlacePrune must be a boolean');
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
		pruneTailChars
	});
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
