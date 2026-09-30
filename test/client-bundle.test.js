import assert from 'node:assert/strict';
import test from 'node:test';

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
function stubContext() {
	const registered = [];
	const scopes = [];
	const mutations = [];
	let revision = 7;
	// The Host's effective configuration, which a landed write really changes — without this, a second save of the
	// same value would look like "nothing to do" and the test would be measuring the stub, not the card.
	const value = {
		compactionTargetRatio: 0.8,
		autoTuneCompaction: false,
		tuneStockDisabledRoutes: false,
		prunerThresholdChars: 'auto'
	};
	const context = {
		configForms: {
			get: (id) => {
				scopes.push(id);
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
						value,
						base: {}
					}),
					subscribe: () => () => undefined,
					mutate: async (ops, fence) => {
						mutations.push({ ops, fence });
						for (const op of ops) value[op.path[0]] = op.value;
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
	assert.deepEqual(scopes, ['context-trim'], 'the card binds the loader entry id');
	assert.equal(registered.length, 1);
	// The row slot, keyed `<package>#<row id>`. This is the whole reason a third-party bundle does NOT use
	// `plugins.item`: that slot belongs to the official settings pages, and a card parked there renders under
	// "Official" while its Save is refused (measured on 0.2.0).
	assert.equal(registered[0].options.name, 'plugins.row.config');
	assert.equal(registered[0].options.key, 'dsh-command-context-trim#context-trim');
	assert.equal(registered[0].options.locale, 'settings.context-trim');
	assert.equal(registered[0].options.label, undefined, 'a keyed slot takes its heading from the bundle patch');
	// The card does NOT use the primitives' SettingsFormModel (it stages text and cannot write a typed value), so
	// what matters is that every field declares the type it has to be written as.
	assert.deepEqual(registration.factory(require_stub()).CARD_FIELDS.map((field) => [field.key, field.kind]), [
		['compactionTargetRatio', 'number'],
		['compactionRoute', 'text'],
		['autoTuneCompaction', 'boolean'],
		['tuneStockDisabledRoutes', 'boolean'],
		['prunerThresholdChars', 'pruner']
	]);
});

test('the component returns the summary one-liner and the five-field form body', async () => {
	const registration = await loadBundle();
	const { primitives, react, calls } = stubs();
	registration.factory((id) => (id === 'react' ? react : primitives));
	const { context, registered } = stubContext();
	registration.factory((id) => (id === 'react' ? react : primitives)).apply(context);
	const { options, component } = registered[0];
	const injected = options.inject();
	// The slot renderer turns `hooks.<name>` into a `use<Name>` prop, so what goes in must be a store the shell can
	// subscribe to — an object with getSnapshot and subscribe, exactly like the in-box cards' own.
	const store = injected.hooks.trimCard;
	assert.equal(typeof store, 'object', 'the hook is a store, not a function');
	assert.equal(typeof store.getSnapshot, 'function');
	assert.equal(typeof store.subscribe, 'function');

	// The component reads its store hook before branching on the view, exactly like the
	// in-box cards, so the harness supplies it for the summary view too.
	const props = {
		t: (key) => key,
		useTrimCard: (select) => select(injected.hooks.trimCard.getSnapshot()),
		...injected
	};
	assert.equal(component({ ...props, view: 'summary' }), 'description', 'the row shows our one-liner, not the npm description');

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
	assert.ok(headingText(tree.children[0]).includes('sectionCompaction'), 'the Compaction section comes first');
	assert.ok(headingText(tree.children[5]).includes('sectionPrune'), 'the Prune section comes before the pruner control');

	// The two text controls stay ordinary value fields.
	const ratio = tree.children[1];
	const route = tree.children[2];
	assert.equal(ratio.props.numeric, true);
	assert.equal(ratio.props.hint, 'compactionTargetRatioHint');
	// `onEdit` is fire-and-forget now: it stages into the card's own draft, and what it stages is
	// asserted by the typed-operation tests below (the behaviour that actually matters).
	assert.equal(typeof ratio.props.onEdit, 'function');
	assert.equal(ratio.props.text, '0.8', 'the field shows the deployment\'s effective value');
	assert.equal(route.props.numeric, undefined, 'the route field is free text');
	assert.equal(typeof route.props.onReset, 'function', 'reset goes through the card\'s own action');

	// Auto tune is a switch, and its state comes from the effective value (FIELD_DEFAULTS), never from a blank field.
	const autoSwitch = tree.children[3];
	const autoControl = autoSwitch.children[0].children[1];
	assert.equal(autoControl.type?.name, 'Switch', 'the shell ships the switch control');
	const autoButton = autoControl;
	assert.equal(autoButton.props.checked, false, 'the deployment has auto-tune off, and that is what the switch shows');
	assert.equal(typeof autoButton.props.onChange, 'function', 'flipping stages through the card\'s own action');
	const autoHint = JSON.stringify(autoSwitch.children[1]);
	assert.ok(autoHint.includes('autoTuneHeadlessOnly'), 'the caveat rides the control');
	assert.ok(autoHint.includes('strong'), 'and it is bold');

	// Enable stock-disabled routes is a switch too.
	const stockSwitch = tree.children[4];
	const stockButton = stockSwitch.children[0].children[1];
	assert.equal(stockButton.type?.name, 'Switch');
	assert.equal(stockButton.props.checked, false);

	// The pruner: a mode select plus a number box that only exists for Custom.
	const pruner = tree.children[6];
	const select = pruner.children[0].children[1];
	assert.equal(select.props.value, 'auto', 'an unset threshold renders as Auto, not blank');
	assert.deepEqual(select.children.map((option) => option.props.value), ['disabled', 'auto', 'custom']);
	assert.equal(pruner.children[1], null, 'the number box is hidden while the mode is Auto');

	// The select is a real control, and what it stages is written as a typed value: Disabled is the number 0, not
	// the string "0" the schema would reject on 0.2.0.
	const { mutations } = stubContext();
	const fresh = stubs();
	const harness = stubContext();
	const second = (await loadBundle()).factory((id) => (id === 'react' ? fresh.react : fresh.primitives));
	second.apply(harness.context);
	const live = harness.registered[0].options.inject();
	live.edit('prunerThresholdChars', '0');
	await live.save();
	assert.deepEqual(harness.mutations[0].ops, [{ op: 'set', path: ['prunerThresholdChars'], value: 0 }]);
	mutations.length = 0;

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
	for (const field of ['compactionTargetRatio', 'autoTuneCompaction', 'tuneStockDisabledRoutes', 'prunerThresholdChars']) {
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
	const { options } = registered[0];
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
	const injected = registered[0].options.inject();

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
