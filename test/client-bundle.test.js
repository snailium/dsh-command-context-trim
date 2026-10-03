import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DEFAULTS } from '../lib/config.js';

/**
 * The client half is a classic script, so it cannot be imported like a module — it
 * registers itself through `window.__ModuleLoader__.load` and receives `require` from
 * the harness. This test plays the harness: it installs a fake loader, evaluates the
 * bundle, and then drives the registered component directly. That is how the form body
 * (which a browser would only render after an interaction) is verified at all.
 */
async function loadBundle() {
	const registrations = [];
	const previous = globalThis.window;
	globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
	try {
		await import(`../lib/client.js?test=${Date.now()}`);
	} finally {
		if (previous === undefined) delete globalThis.window;
		else globalThis.window = previous;
	}
	assert.equal(registrations.length, 1, 'the bundle must register exactly once');
	return registrations[0];
}

/** The narrowest `require` that lets the bundle factory load outside a browser. */
function require_stub() {
	const { primitives, react } = stubs();
	return (name) => {
		if (name === 'react') return react;
		if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
		throw new Error(`unexpected require(${name})`);
	};
}

/** Minimal stand-ins for the shared primitives and React. */
function stubs() {
	const calls = { form: [], fields: [], model: null, edits: [], switches: [] };
	const primitives = {
		SettingsForm: function SettingsForm(props, ...children) {
			return { type: 'SettingsForm', props, children };
		},
		SettingsValueField: function SettingsValueField(props) {
			calls.fields.push(props);
			return { type: 'SettingsValueField', props };
		},
		Switch: function Switch(props) {
			calls.switches.push(props);
			return { type: 'Switch', props };
		},
		settingsNumberField: (name) => ({ name, numeric: true }),
		settingsTextField: (name) => ({ name, numeric: false }),
		SettingsFormModel: class SettingsFormModel {
			constructor(scope, fields) {
				calls.model = { scope, fields };
				this.fields = fields;
			}
			bind(project) {
				this.project = project;
				return () => project();
			}
			shell() {
				return { status: 'ready', writable: true, revision: 7 };
			}
			field(name) {
				// Measured shape: `{text, overridden, invalid}` — and a boolean's `text` is always empty.
				if (name === 'compactionTargetRatio') return { text: '0.8', overridden: true, invalid: false };
				if (name === 'prunerThresholdChars') return { text: 'auto', overridden: true, invalid: false };
				if (name === 'compactionRoute') return { text: '', overridden: false, invalid: false };
				return { text: '', overridden: true, invalid: false };
			}
			actions() {
				return {
					save: () => 'saved',
					discard: () => 'discarded',
					edit: (f, v) => {
						calls.edits.push([f, v]);
						return [f, v];
					},
					resetField: (f) => f
				};
			}
			dispose() {
				this.disposed = true;
			}
		}
	};
	const react = {
		createElement: (type, props, ...children) => ({ type, props, children }),
		// The card uses these two: it keeps the pruner's selected mode locally (Custom can be picked before a number is
		// typed) and resyncs on the effective value.
		useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
		useEffect: () => {}
	};
	return { primitives, react, calls };
}

/** A browser plugin context that records what the bundle registers. */
/**
 * The registration for one row's card. Two rows means two keyed entries, and `registered[0]` is only the first of them,
 * so a test about the tuner's card has to name the row rather than take whatever came first.
 * @param {object[]} registered - what the stub recorded.
 * @param {string} rowId - `context-trim` or `context-tuning`.
 * @returns the registration whose key ends with that row id.
 */
function cardFor(registered, rowId) {
	const found = registered.find((entry) => entry.options.key.endsWith(`#${rowId}`));
	assert.ok(found !== undefined, `no card registered for ${rowId}; keys: ${registered.map((e) => e.options.key).join(', ')}`);
	return found;
}

function stubContext() {
	const registered = [];
	const scopes = [];
	const mutations = [];
	let revision = 7;
	// The Host's effective configuration, which a landed write really changes — without this, a second save of the
	// same value would look like "nothing to do" and the test would be measuring the stub, not the card.
	const values = {
		'context-tuning': { role: 'tuning', compactionTargetRatio: 0.8, autoTuneCompaction: false, prunerThresholdChars: 'auto' },
		'context-trim': { role: 'trim', targetRatio: 0.9, retainRatio: 0.16, minTailTokens: 2048, reserveOutputTokens: 8192, protectHeadNodes: 1, maxAutoTrimRetries: 3, allowTailTrim: true, autoTrim: true, emergencyTrim: true, preferInPlacePrune: true, pruneThresholdChars: 8192, pruneHeadChars: 4096, pruneTailChars: 1024 }
	};
	const context = {
		configForms: {
			get: (id) => {
				scopes.push(id);
				// Each row is its own entry with its own config namespace, so each gets its own scope. The key sets are
				// disjoint — the trims' thirteen and the tuner's five — exactly as in the loader schema. `values[id]` is
				// the object a landed write mutates, so the snapshot and the write path must read the same one.
				// The scope the Host hands out: a snapshot of the *typed* effective configuration, a subscription for
				// external changes, and the fenced write. Note the types — the deployment's configuration is booleans
				// and numbers, which is exactly what a save has to write back (a card that stages the string "true"
				// is refused on dsh 0.2.0).
				return {
					id,
					getSnapshot: () => ({
						status: 'ready',
						writable: true,
						revision,
						value: values[id],
						base: {}
					}),
					subscribe: () => () => undefined,
					mutate: async (ops, fence) => {
						mutations.push({ ops, fence });
						for (const op of ops) values[id][op.path[0]] = op.value;
						revision += 1;
						return true;
					}
				};
			},
			whileServed: (ids, register) => register(new Set(ids))
		},
		slots: {
			inject: (_name, register) => register(),
			register: (options, component) => registered.push({ options, component })
		},
		locale: { bind: () => (key) => key, register: () => undefined },
		effect: (run) => run()
	};
	return { context, registered, scopes, mutations };
	return { context, registered, scopes };
}

test('the bundle registers into the keyed row slot behind the served namespace only', async () => {
	const registration = await loadBundle();
	assert.equal(registration.id, 'dsh-command-context-trim', 'the loader id must be the package name');
	const { primitives, react, calls } = stubs();
	const exports = registration.factory((id) => (id === 'react' ? react : primitives));
	assert.equal(typeof exports.apply, 'function');
	assert.deepEqual(exports.inject, ['slots', 'locale', 'configForms']);
	assert.equal(exports.NS, 'settings.context-trim');

	const { context, registered, scopes } = stubContext();
	exports.apply(context);
			// One scope per row: each row is its own entry with its own config namespace, and a card that reached for the
		// wrong one would write the tuner's values into the trims' row.
		assert.deepEqual(scopes, ['context-trim', 'context-tuning'], 'each card binds its own row namespace');
	// The row slot, keyed `<package>#<row id>`. This is the whole reason a third-party bundle does NOT use
	// `plugins.item`: that slot belongs to the official settings pages, and a card parked there renders under
	// "Official" while its Save is refused (measured on 0.2.0).
	// One keyed entry per row, or a row simply has no Configure button and nothing is logged.
	assert.equal(registered.length, 2, 'each row registers its gated form');
	for (const row of ['context-trim', 'context-tuning']) {
		const { options } = cardFor(registered, row);
		assert.equal(options.name, 'plugins.row.config');
		assert.equal(options.key, `dsh-command-context-trim#${row}`);
		assert.equal(options.locale, 'settings.context-trim');
		assert.equal(options.label, undefined, 'a keyed slot takes its heading from the bundle patch');
	}
	// The card does NOT use the primitives' SettingsFormModel (it stages text and cannot write a typed value), so
	// what matters is that every field declares the type it has to be written as.
		const { CARD_FIELDS } = registration.factory(require_stub());
	assert.deepEqual(CARD_FIELDS.tuning.map((field) => [field.key, field.kind]), [
		['compactionTargetRatio', 'number'],
		['compactionRoute', 'text'],
		['autoTuneCompaction', 'boolean'],
		['prunerThresholdChars', 'pruner']
	]);
});

test('the component returns the summary one-liner and the four-field form body', async () => {
	const registration = await loadBundle();
	const { primitives, react, calls } = stubs();
	registration.factory((id) => (id === 'react' ? react : primitives));
	const { context, registered } = stubContext();
	registration.factory((id) => (id === 'react' ? react : primitives)).apply(context);
	const { options, component: wrapper } = cardFor(registered, 'context-tuning');
	// The wrapper builds a React element rather than returning the card, so unwrap it the way React would.
	const element = wrapper({ t: (key) => key, view: 'summary', useTrimCard: () => ({}) });
	const component = element.type;
	assert.equal(typeof component, 'function', 'the wrapper must render a component');
	assert.equal(typeof component, 'function', 'the wrapper must render a component');
	const injected = options.inject();
	// The slot renderer turns `hooks.<name>` into a `use<Name>` prop, so what goes in must be a store the shell can
	// subscribe to — an object with getSnapshot and subscribe, exactly like the in-box cards' own.
	const store = injected.hooks.trimCard;
	assert.equal(typeof store, 'object', 'the hook is a store, not a function');
	assert.equal(typeof store.getSnapshot, 'function');
	assert.equal(typeof store.subscribe, 'function');

	// The component reads its store hook before branching on the view, exactly like the
	// in-box cards, so the harness supplies it for the summary view too.
	// `row` is what the two registrations pass down; without it a card cannot tell which half it is.
	const props = {
		t: (key) => key,
		row: { rowId: 'context-tuning', role: 'tuning', module: 'tune' },
		useTrimCard: (select) => select(injected.hooks.trimCard.getSnapshot()),
		...injected
	};
	// These props are the TUNING row's, so the one-liner it shows is its own copy, not the trims': a row's
	// description falls back to whatever its own card returns for `view: 'summary'`, so sharing one string here
	// would make both rows read identically on the Plugins page.
	assert.equal(component({ ...props, view: 'summary' }), 'tuneDescription', 'the row shows OUR one-liner, and it is the half this row owns');

	const tree = component({ ...props, view: 'detail' });
	assert.equal(tree.type, primitives.SettingsForm, 'the platform supplies the frame; we render only its body');
	assert.equal(tree.props.state.writable, true);
	// Only the ordinary value fields carry labels now: the switches and the pruner select are their own controls.
	// React stores the component *function* as `type` (the stub never invokes it), so match on its name.
	const labels = tree.children
		.filter((child) => child.type?.name === 'SettingsValueField')
		.map((child) => child.props.label);
	// Ratio and route are always value fields; the pruner's number box exists only in Custom mode, so it is absent here.
	assert.deepEqual(labels, ['compactionTargetRatio', 'compactionRoute']);

	// Section headings are plain nodes inside the form body (SettingsForm renders props.children directly).
	// The stub keeps children on the node (`{type, props, children}`), not inside props.
	const headingText = (node) => JSON.stringify(node.children ?? '');
	// children[0] is now the card's one-line introduction, which is what tells the two cards apart in the UI.
	assert.ok(headingText(tree.children[0]).includes('cardTuneIntro'), 'the card says which component it configures');
	assert.ok(headingText(tree.children[1]).includes('sectionCompaction'), 'then the Compaction section');
	assert.ok(headingText(tree.children[5]).includes('sectionPrune'), 'then the Prune section, before the pruner control');

	// The two text controls stay ordinary value fields.
	const ratio = tree.children[2];
	const route = tree.children[3];
	assert.equal(ratio.props.numeric, true);
	assert.equal(ratio.props.hint, 'compactionTargetRatioHint');
	// `onEdit` is fire-and-forget now: it stages into the card's own draft, and what it stages is
	// asserted by the typed-operation tests below (the behaviour that actually matters).
	assert.equal(typeof ratio.props.onEdit, 'function');
	assert.equal(ratio.props.text, '0.8', 'the field shows the deployment\'s effective value');
	assert.equal(route.props.numeric, undefined, 'the route field is free text');
	assert.equal(typeof route.props.onReset, 'function', 'reset goes through the card\'s own action');

	// Auto tune is a switch, and its state comes from the effective value (FIELD_DEFAULTS), never from a blank field.
	const autoSwitch = tree.children[4];
	const autoControl = autoSwitch.children[0].children[1];
	assert.equal(autoControl.type?.name, 'Switch', 'the shell ships the switch control');
	const autoButton = autoControl;
	assert.equal(autoButton.props.checked, false, 'the deployment has auto-tune off, and that is what the switch shows');
	assert.equal(typeof autoButton.props.onChange, 'function', 'flipping stages through the card\'s own action');
	const autoHint = JSON.stringify(autoSwitch.children[1]);
	assert.ok(autoHint.includes('autoTuneHeadlessOnly'), 'the caveat rides the control');
	assert.ok(autoHint.includes('strong'), 'and it is bold');

	// The pruner: a mode select plus a number box that only exists for Custom.
	const pruner = tree.children[6];
	const select = pruner.children[0].children[1];
	assert.equal(select.props.value, 'auto', 'an unset threshold renders as Auto, not blank');
	assert.deepEqual(select.children.map((option) => option.props.value), ['disabled', 'auto', 'custom']);
	assert.equal(pruner.children[1], null, 'the number box is hidden while the mode is Auto');

	// The select is a real control, and what it stages is written as a typed value: Disabled is the number 0, not
	// the string "0" the schema would reject on 0.2.0.
	// Driven through the TUNING card: `prunerThresholdChars` is the tuner's field, and a card that reached the trim row
	// would write the tuner's value into the wrong namespace.
	const fresh = stubs();
	const harness = stubContext();
	const second = (await loadBundle()).factory((id) => (id === 'react' ? fresh.react : fresh.primitives));
	second.apply(harness.context);
	const live = cardFor(harness.registered, 'context-tuning').options.inject();
	live.edit('prunerThresholdChars', '0');
	await live.save();
	assert.deepEqual(harness.mutations[0].ops, [{ op: 'set', path: ['prunerThresholdChars'], value: 0 }]);

	assert.equal(typeof tree.props.onSave, 'function');
	assert.equal(typeof tree.props.onDiscard, 'function');
});

test('an older web host gets no registration instead of a broken page', async () => {
	const registration = await loadBundle();
	const exports = registration.factory(() => ({}));
	let touched = 0;
	exports.apply({});
	exports.apply({ configForms: undefined, slots: { register: () => (touched += 1) }, locale: {} });
	assert.equal(touched, 0);
});

test('the card\'s default mirror matches the plugin\'s own defaults', async () => {
	// The card shows effective values, so its mirror is what a deployment with nothing set will display. If the two
	// drift, the page quietly lies about what the plugin will do.
	const { DEFAULTS } = await import('../lib/config.js');
	const exported = (await loadBundle()).factory(require_stub()).FIELD_DEFAULTS;
	for (const field of ['compactionTargetRatio', 'autoTuneCompaction']) {
		assert.equal(exported[field], DEFAULTS[field], `${field} mirror must match DEFAULTS`);
	}
	// `compactionRoute` has no default at all; the card shows an empty field for it.
	assert.equal(exported.compactionRoute, '');
	assert.equal(DEFAULTS.compactionRoute, undefined, 'the route is deliberately unset by default');
});

test('the row-slot key is pinned, because a wrong key fails silently', async () => {
	// `plugins.row.config` is a keyed slot: a mismatched key simply never matches a row, so the Configure button
	// never appears and the page renders nothing — no error, anywhere. Pin the key instead of trusting it.
	const registration = (await loadBundle()).factory(require_stub());
	assert.equal(registration.SLOT_NAME, 'plugins.row.config');
	assert.equal(registration.PACKAGE, 'dsh-command-context-trim', 'the key starts with the package name');
	assert.equal(registration.ENTRY_ID, 'context-trim', 'the key ends with the row id, which is the namespace');
	assert.equal(registration.ROW_CONFIG_KEY, `${registration.PACKAGE}#${registration.ENTRY_ID}`);
});

test('a staged switch is written as a boolean, not as the string "true"', async () => {
	// The 0.2.0 refusal, pinned: a card that stages the string "true" for a z.boolean() field is rejected in band
	// ("The deployment rejected these values"), while a number lands. So the operation must carry a real boolean.
	const registration = await loadBundle();
	const { primitives, react } = stubs();
	const factory = (id) => (id === 'react' ? react : primitives);
	const { context, registered, mutations } = stubContext();
	registration.factory(factory).apply(context);
	const { options } = cardFor(registered, 'context-tuning');
	const injected = options.inject();

	injected.edit('autoTuneCompaction', 'true');
	injected.edit('compactionTargetRatio', '0.7');
	await injected.save();

	assert.equal(mutations.length, 1, 'one fenced mutate per save');
	assert.deepEqual(mutations[0].ops, [
		{ op: 'set', path: ['compactionTargetRatio'], value: 0.7 },
		{ op: 'set', path: ['autoTuneCompaction'], value: true }
	], 'booleans and numbers are written as themselves, in the card\'s field order');
	assert.equal(mutations[0].fence, 7, 'the write is fenced on the revision captured at the first edit');
	const booleanOp = mutations[0].ops.find((op) => op.path[0] === 'autoTuneCompaction');
	assert.equal(typeof booleanOp.value, 'boolean', 'never a string for a boolean field');
	assert.equal(typeof mutations[0].ops.find((op) => op.path[0] === 'compactionTargetRatio').value, 'number');
});

test('the pruner writes "auto" or a number, and a reset drops the edit instead of writing an unset', async () => {
	const registration = await loadBundle();
	const { primitives, react } = stubs();
	const factory = (id) => (id === 'react' ? react : primitives);
	const { context, registered, mutations } = stubContext();
	registration.factory(factory).apply(context);
	const injected = cardFor(registered, 'context-tuning').options.inject();

	injected.edit('prunerThresholdChars', '16384');
	await injected.save();
	assert.deepEqual(mutations[0].ops, [{ op: 'set', path: ['prunerThresholdChars'], value: 16384 }]);

	// "auto" is the schema's own union member, so it is written as the string it is.
	injected.edit('prunerThresholdChars', 'auto');
	await injected.save();
	assert.deepEqual(mutations[1].ops, [{ op: 'set', path: ['prunerThresholdChars'], value: 'auto' }]);

	// A reset is "drop my edit", not an unset: nothing is written, so no risky unset op is ever sent.
	injected.edit('prunerThresholdChars', '4096');
	injected.resetField('prunerThresholdChars');
	await injected.save();
	assert.equal(mutations.length, 2, 'a reset alone writes nothing');
});

test('each half owns its own fields, and the two similar names never cross over', async () => {
	// `pruneThresholdChars` is the trims' own in-place pruner (a character count on one tool result);
	// `prunerThresholdChars` is the tuner's threshold, on the other row, with its own default of 'auto'. They differ
	// by one letter, and a card that showed the wrong one would be worse than no card at all.
	const { TRIM_CARD_FIELDS, TUNING_CARD_FIELDS } = (await loadBundle()).factory(require_stub());
	const trims = TRIM_CARD_FIELDS.map((f) => f.key);
	const tuner = TUNING_CARD_FIELDS.map((f) => f.key);
	assert.ok(trims.includes('pruneThresholdChars') && !trims.includes('prunerThresholdChars'));
	assert.ok(tuner.includes('prunerThresholdChars') && !tuner.includes('pruneThresholdChars'));
	for (const key of trims) assert.equal(tuner.includes(key), false, `${key} must appear on exactly one card`);
	for (const key of tuner) assert.equal(trims.includes(key), false, `${key} must appear on exactly one card`);
	// And the card's own default mirrors the plugin's, so an unset field shows what will really happen.
	for (const field of [...TRIM_CARD_FIELDS, ...TUNING_CARD_FIELDS]) {
		// `prunerThresholdChars` is the tuner's own default and lives on the other row's schema; `compactionRoute` has
		// no default at all, by design — an unset route means "the session's own route".
		if (field.key === 'prunerThresholdChars' || field.key === 'compactionRoute') continue;
		assert.equal(field.default, DEFAULTS[field.key], `${field.key} default must match DEFAULTS`);
	}
	assert.equal(DEFAULTS.compactionRoute, undefined, 'the route is deliberately unset by default');
	// The two similar names BOTH exist in DEFAULTS, with different values — which is exactly why they are told apart
	// by key and never by value: the trims' is a character count, the tuner's is 'auto' or a number.
	assert.equal(DEFAULTS.pruneThresholdChars, 8192, "the trims' own in-place pruner threshold");
	assert.equal(DEFAULTS.prunerThresholdChars, 'auto', "the tuner's pruner threshold");
});

test('each row renders its OWN card: the trims get their thirteen knobs, the tuner its four', async () => {
	// The whole point of the split. Before it, there was one card, bound to the trim row, showing the tuner's four
	// fields under a row named `/trim` — so the trims had no settings of their own and the visible knobs belonged to a
	// different component. Each card must now render only its own row's fields, from its own row's config namespace.
	const registration = await loadBundle();
	const { primitives, react } = stubs();
	const factory = (id) => (id === 'react' ? react : primitives);
	const { context, registered, mutations } = stubContext();
	registration.factory(factory).apply(context);

	const render = (rowId) => {
		const { options, component: wrapper } = cardFor(registered, rowId);
		const injected = options.inject();
		const element = wrapper({ t: (key) => key, view: 'page', useTrimCard: (select) => select(injected.hooks.trimCard.getSnapshot()), ...injected });
		return { injected, tree: element.type(element.props) };
	};

	// ── the trim card ──────────────────────────────────────────────────────────
	const trim = render('context-trim');
	assert.equal(trim.tree.type, primitives.SettingsForm, 'the platform still supplies the frame');
	const idsIn = (tree) => [...new Set((JSON.stringify(tree).match(/plugin-config-(?:trim|tune)-[A-Za-z-]+/gu) ?? []))];
	const trimIds = idsIn(trim.tree);
	for (const key of ['targetRatio', 'retainRatio', 'minTailTokens', 'autoTrim', 'emergencyTrim', 'pruneThresholdChars']) {
		assert.ok(trimIds.includes(`plugin-config-trim-${key}`), `the trim card shows ${key}`);
	}
	for (const key of ['compactionTargetRatio', 'auto-tune', 'pruner-threshold']) {
		assert.equal(trimIds.includes(`plugin-config-tune-${key}`), false, `the trim card must NOT show the tuner's ${key}`);
	}
	assert.ok(JSON.stringify(trim.tree).includes('sectionTrims'), 'and it has its own section heading');
	assert.ok(JSON.stringify(trim.tree).includes('cardTrimIntro'), 'each card says which component it configures');

	// A staged edit on the trim card writes to the TRIM row's namespace, typed.
	trim.injected.edit('autoTrim', 'false');
	trim.injected.edit('retainRatio', '0.2');
	await trim.injected.save();
	assert.deepEqual(mutations[0].ops, [
		{ op: 'set', path: ['retainRatio'], value: 0.2 },
		{ op: 'set', path: ['autoTrim'], value: false }
	], 'booleans and numbers, written from the trim row');

	// ── the tune card ──────────────────────────────────────────────────────────
	const tune = render('context-tuning');
	const tuneIds = idsIn(tune.tree);
	for (const key of ['compactionTargetRatio', 'compactionRoute', 'auto-tune', 'pruner-threshold', 'pruner-mode']) {
		assert.ok(tuneIds.includes(`plugin-config-tune-${key}`), `the tune card shows ${key}`);
	}
	for (const key of ['targetRatio', 'retainRatio', 'emergencyTrim', 'pruneThresholdChars']) {
		assert.equal(tuneIds.includes(`plugin-config-trim-${key}`), false, `the tune card must NOT show the trims' ${key}`);
	}
	// Every id is namespaced by its row, so the two cards can never be confused for each other in the DOM.
	assert.equal(trimIds.some((id) => id.startsWith('plugin-config-tune-')), false, 'the trim card owns only its prefix');
	assert.equal(tuneIds.some((id) => id.startsWith('plugin-config-trim-')), false, 'the tune card owns only its prefix');
});

test('the two rows are told apart: separate summary copy, and the tuning row has its own module', async () => {
	// The Plugins page shows a row's heading from its MODULE and resolves a row's `meta` by module name too, so two
	// rows on one module are both called "dsh-command-context-trim" and read as one component. The tuning row
	// therefore points at its own subpath entry, and each card returns its OWN one-liner: a row's description falls
	// back to what its own `view: 'summary'` returns, so sharing one string shares one description.
	const registration = await loadBundle();
	const { primitives, react } = stubs();
	const { context, registered } = stubContext();
	registration.factory((id) => (id === 'react' ? react : primitives)).apply(context);

	const summaryOf = (rowId) => {
		const { options, component: wrapper } = cardFor(registered, rowId);
		const injected = options.inject();
		const el = wrapper({ t: (key) => key, view: 'summary', useTrimCard: (sel) => sel(injected.hooks.trimCard.getSnapshot()), ...injected });
		return el.type(el.props);
	};
	const trims = summaryOf('context-trim');
	const tune = summaryOf('context-tuning');
	assert.notEqual(trims, tune, 'the two rows must not return the same one-liner');
	assert.equal(trims, 'description');
	assert.equal(tune, 'tuneDescription', "the tuning row's summary names its own copy");

	// And the row that must be identifiable declares its own module.
	const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
	const names = [...patch.matchAll(/^\s+- id: (context-[\w-]+)\n\s+name: (\S+)/gmu)].map((m) => [m[1], m[2]]);
	assert.equal(names.length, 2, 'both rows are declared with a module');
	assert.notEqual(names[0][1], names[1][1], 'and they must be DIFFERENT modules, or both headings read the same');
	assert.equal(names[1][1], 'dsh-command-context-trim/tune');
	// That module has to exist, or the row never starts.
	const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	assert.equal(manifest.exports['./tune'], './lib/tune.js', 'the subpath entry is exported');
	assert.ok(readFileSync(new URL('../lib/tune.js', import.meta.url), 'utf8').includes("from './index.js'"), 'and it re-exports the one implementation');
});

test('lib/client.js stays byte-identical to the assembly of src/client', async () => {
	const { buildClientBundle } = await import('../scripts/build-client.js');
	const assembled = await buildClientBundle();
	const onDisk = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
	assert.equal(onDisk, assembled, 'lib/client.js is out of sync with src/client/; run node scripts/build-client.js');
});

