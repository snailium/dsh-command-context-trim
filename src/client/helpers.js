import { FIELD_DEFAULTS } from './constants.js';

/**
 * The effective value of one card field: staged/overridden value, else the deployment's, else our default.
 * @param state - the projection snapshot.
 * @param field - the configuration key.
 * @returns the value the plugin will really use.
 */
export function effective(state, field) {
	// Measured shapes: the per-field entry is `{text, overridden, invalid}` (and a boolean's `text` is always
	// empty, so the entry cannot answer "is it on"), while the controller projects the effective configuration
	// onto `values`. Precedence: what the user staged, then the deployment, then this file's default mirror.
	const entry = state?.[field];
	const staged = entry !== null && typeof entry === 'object' ? entry.text : entry;
	if (staged !== undefined && staged !== null && staged !== '') return staged;
	const configured = state?.values?.[field];
	if (configured !== undefined && configured !== null && configured !== '') return configured;
	return FIELD_DEFAULTS[field];
}

/** Coerce a configuration value to a boolean the way `resolveConfig` does. */
export function asBoolean(value) {
	if (typeof value === 'boolean') return value;
	return value === 'true' || value === 'yes' || value === 'on' || value === 1 || value === '1';
}

/** The pruner select's mode for a value: `0` is Disabled, `auto` is Auto, anything else is Custom. */
export function prunerModeOf(value) {
	if (value === 0 || value === '0' || value === false) return 'disabled';
	if (value === 'auto') return 'auto';
	return 'custom';
}

/** A section heading inside the form body. */
export function sectionHeading(title) {
	return h(
		'div',
		{
			style: {
				gridColumn: '1 / -1',
				marginTop: '0.5rem',
				paddingBottom: '0.25rem',
				borderBottom: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.25))',
				fontWeight: 600,
				opacity: 0.85
			}
		},
		title
	);
}

/** The typed value one field currently holds on the Host, or `undefined` when it holds none. */
export function hostValue(snapshot, key) {
	const value = { ...(snapshot.base ?? {}), ...(snapshot.value ?? {}), ...(snapshot.user ?? {}) };
	return value[key];
}

/**
 * Turn a staged text into the value the field must be written as, or say that nothing needs writing.
 * @param field - the field descriptor.
 * @param text - what the control staged.
 * @param current - the typed value the Host holds.
 * @returns `{kind: 'set'|'skip'|'invalid', value?}`.
 */
export function parseEdit(field, text, current) {
	if (field.kind === 'boolean') {
		const on = text === 'true' || text === true;
		const off = text === 'false' || text === false;
		if (!on && !off) return { kind: 'invalid' };
		const value = on;
		return value === current ? { kind: 'skip' } : { kind: 'set', value };
	}
	if (field.kind === 'number') {
		const trimmed = text.trim();
		if (trimmed === '') return { kind: 'invalid' };
		const value = Number(trimmed);
		if (!Number.isFinite(value)) return { kind: 'invalid' };
		return value === current ? { kind: 'skip' } : { kind: 'set', value };
	}
	if (field.kind === 'pruner') {
		const trimmed = text.trim();
		if (trimmed === 'auto') return 'auto' === current ? { kind: 'skip' } : { kind: 'set', value: 'auto' };
		if (trimmed === '0' || trimmed === '') return 0 === current ? { kind: 'skip' } : { kind: 'set', value: 0 };
		const value = Number(trimmed);
		if (!Number.isFinite(value) || value < 0) return { kind: 'invalid' };
		return value === current ? { kind: 'skip' } : { kind: 'set', value };
	}
	return text === current ? { kind: 'skip' } : { kind: 'set', value: text };
}

/** The text one field displays: the staged edit, else the Host's value, else the declared default. */
export function displayText(field, staged, snapshot) {
	if (staged !== undefined) return staged;
	const current = hostValue(snapshot, field.key);
	if (current === undefined) return String(field.default);
	if (typeof current === 'object') return '';
	return String(current);
}
