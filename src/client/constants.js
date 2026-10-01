/** Dictionary namespace owned by this plugin (any string). */
export const NS = 'settings.context-trim';

/** Loader entry id; MUST equal the row id our bundle patch declares — and our settings namespace. */
export const ENTRY_ID = 'context-trim';

/** This package's name; the keyed slot is `<package>#<row id>`. */
export const PACKAGE = 'dsh-command-context-trim';

/**
 * The two rows this bundle declares, each with its own card.
 *
 * `plugins.row.config` is a KEYED slot: a registration only ever appears on the row whose key it matches, and a
 * key nobody matches is not an error — it is simply nothing. So one card per row means one keyed entry per
 * row, gated on that row's own namespace, showing only that row's own knobs. With a single card bound to the
 * first row, the second row shows no Configure button at all.
 *
 * The `module` is what the Plugins page shows as the heading. It comes from the row's module URL, which is why
 * the tuning row points at 'dsh-command-context-trim/tune' rather than the package root: two rows on one entry are both
 * called "dsh-command-context-trim", which tells a reader nothing.
 */
export const ROWS = [
	{ rowId: 'context-trim', role: 'trim', module: 'trim' },
	{ rowId: 'context-tuning', role: 'tuning', module: 'tune' }
];

/** The key one row's card registers under. */
export const rowConfigKey = (rowId) => `${PACKAGE}#${rowId}`;

/** The key `plugins.row.config` is matched by. Silent when wrong, so it is pinned in a test. */
export const ROW_CONFIG_KEY = rowConfigKey(ENTRY_ID);
export const TUNING_ENTRY_ID = 'context-tuning';
export const TUNING_ROW_CONFIG_KEY = rowConfigKey(TUNING_ENTRY_ID);

/**
 * The effective value of each card field when the deployment sets none.
 *
 * Mirrors `DEFAULTS` in `lib/config.js` (and the values the plugin resolves in code), so an unset field shows
 * what will really be used instead of a blank. Kept honest by a test rather than by discipline.
 */
export const FIELD_DEFAULTS = {
	// The trims' own knobs, shown on the `trim` card. A deployment that sets none of them displays these, so the
	// page can answer "what will the plugin actually do" rather than showing a blank.
	targetRatio: 0.9,
	retainRatio: 0.16,
	minTailTokens: 2048,
	reserveOutputTokens: 8192,
	protectHeadNodes: 1,
	maxAutoTrimRetries: 3,
	allowTailTrim: true,
	autoTrim: true,
	emergencyTrim: true,
	preferInPlacePrune: true,
	pruneThresholdChars: 8192,
	pruneHeadChars: 4096,
	pruneTailChars: 1024,
	// The compaction tuner's knobs, shown on the `tune` card.
	compactionTargetRatio: 0.8,
	compactionRoute: '',
	autoTuneCompaction: false,
	tuneStockDisabledRoutes: false
	// NOT `prunerThresholdChars` again: that name belongs to the trims' own in-place pruner (a character count
	// on a tool result). The tuner's is `prunerThresholdChars` on the OTHER row's schema, which is a separate
	// namespace with its own default of 'auto' — see TUNING_CARD_FIELDS, which carries its own default.
};

/** Pruner modes: the select's three options and the value each one lands. */
export const PRUNER_MODES = [
	{ id: 'disabled', value: '0' },
	{ id: 'auto', value: 'auto' }
];

/**
 * The five fields this card writes, with the type each one must land as.
 *
 * `kind` decides the parse: a boolean field may not be written as the string `"true"` on 0.2.0, and the pruner
 * takes `'auto'` or a number. `default` is what an unset field displays, so the page shows what the plugin will
 * really do instead of a blank.
 */
/** The compaction tuner's fields — what the `tune` row's card shows. */
export const TUNING_CARD_FIELDS = [
	{ key: 'compactionTargetRatio', kind: 'number', default: FIELD_DEFAULTS.compactionTargetRatio },
	{ key: 'compactionRoute', kind: 'text', default: '' },
	{ key: 'autoTuneCompaction', kind: 'boolean', default: FIELD_DEFAULTS.autoTuneCompaction },
	{ key: 'tuneStockDisabledRoutes', kind: 'boolean', default: FIELD_DEFAULTS.tuneStockDisabledRoutes },
	{ key: 'prunerThresholdChars', kind: 'pruner', default: FIELD_DEFAULTS.prunerThresholdChars }
];

/**
 * The trims' own fields — what the `trim` row's card shows.
 *
 * These have never been on a card: they are not marked `.volatile()` in the loader schema, and a 0.1.7 form only
 * carries volatile fields. The `trim` row is its own component now, so its card is the natural place for them;
 * marking them volatile is what puts them there. The kinds mirror `lib/config.js`: `retainRatio` and
 * `minTailTokens` are numbers, `targetRatio` a number, the rest flags.
 */
export const TRIM_CARD_FIELDS = [
	{ key: 'targetRatio', kind: 'number', default: FIELD_DEFAULTS.targetRatio },
	{ key: 'retainRatio', kind: 'number', default: FIELD_DEFAULTS.retainRatio },
	{ key: 'minTailTokens', kind: 'number', default: FIELD_DEFAULTS.minTailTokens },
	{ key: 'reserveOutputTokens', kind: 'number', default: FIELD_DEFAULTS.reserveOutputTokens },
	{ key: 'protectHeadNodes', kind: 'number', default: FIELD_DEFAULTS.protectHeadNodes },
	{ key: 'maxAutoTrimRetries', kind: 'number', default: FIELD_DEFAULTS.maxAutoTrimRetries },
	{ key: 'allowTailTrim', kind: 'boolean', default: FIELD_DEFAULTS.allowTailTrim },
	{ key: 'autoTrim', kind: 'boolean', default: FIELD_DEFAULTS.autoTrim },
	{ key: 'emergencyTrim', kind: 'boolean', default: FIELD_DEFAULTS.emergencyTrim },
	{ key: 'preferInPlacePrune', kind: 'boolean', default: FIELD_DEFAULTS.preferInPlacePrune },
	{ key: 'pruneThresholdChars', kind: 'number', default: FIELD_DEFAULTS.pruneThresholdChars },
	{ key: 'pruneHeadChars', kind: 'number', default: FIELD_DEFAULTS.pruneHeadChars },
	{ key: 'pruneTailChars', kind: 'number', default: FIELD_DEFAULTS.pruneTailChars }
];

/** The fields one role's card carries. */
export const CARD_FIELDS = { trim: TRIM_CARD_FIELDS, tuning: TUNING_CARD_FIELDS };
