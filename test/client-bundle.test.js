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
	const context = {
		configForms: {
			get: (id) => {
					scopes.push(id);
					// The deployment's effective configuration lives on the scope, not in the per-field entries.
					return {
						id,
						getSnapshot: () => ({
							status: 'ready',
							writable: true,
							revision: 7,
							value: {
								compactionTargetRatio: '0.8',
								autoTuneCompaction: 'true',
								tuneStockDisabledRoutes: 'false',
								prunerThresholdChars: 'auto'
							},
							base: {}
						})
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
	return { context, registered, scopes };
}

test('the bundle registers into plugins.item behind the served namespace only', async () => {
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
	assert.equal(registered[0].options.name, 'plugins.item');
	assert.equal(registered[0].options.id, 'context-trim');
	assert.equal(registered[0].options.locale, 'settings.context-trim');
	assert.equal(registered[0].options.label(), 'title');
	assert.deepEqual(calls.model.fields.map((field) => [field.name, field.numeric]), [
		['compactionTargetRatio', true],
		['compactionRoute', false],
		['autoTuneCompaction', false],
		['tuneStockDisabledRoutes', false],
		['prunerThresholdChars', false]
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
	assert.ok(typeof injected.hooks.trimCard === 'function', 'the card needs its store hook');

	// The component reads its store hook before branching on the view, exactly like the
	// in-box cards, so the harness supplies it for the summary view too.
	const props = {
		t: (key) => key,
		useTrimCard: (select) => select(injected.hooks.trimCard()),
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
	assert.deepEqual(ratio.props.onEdit('0.75'), ['compactionTargetRatio', '0.75']);
	assert.equal(route.props.numeric, undefined, 'the route field is free text');
	assert.equal(route.props.onReset(), 'compactionRoute');

	// Auto tune is a switch, and its state comes from the effective value (FIELD_DEFAULTS), never from a blank field.
	const autoSwitch = tree.children[3];
	const autoControl = autoSwitch.children[0].children[1];
	assert.equal(autoControl.type?.name, 'Switch', 'the shell ships the switch control');
	const autoButton = autoControl;
	assert.equal(autoButton.props.checked, true, 'the deployment value on `base` wins over the empty staged value');
	autoButton.props.onChange(false);
	assert.deepEqual(calls.edits.at(-1), ['autoTuneCompaction', 'false'], 'flipping stages false');
	autoButton.props.onChange(true);
	const autoHint = JSON.stringify(autoSwitch.children[1]);
	assert.ok(autoHint.includes('autoTuneHeadlessOnly'), 'the caveat rides the control');
	assert.ok(autoHint.includes('strong'), 'and it is bold');

	// Enable stock-disabled routes is a switch too.
	const stockSwitch = tree.children[4];
	const stockButton = stockSwitch.children[0].children[1];
	assert.equal(stockButton.type?.name, 'Switch');
	assert.equal(stockButton.props.checked, false);
	stockButton.props.onChange(true);
	assert.deepEqual(calls.edits.at(-1), ['tuneStockDisabledRoutes', 'true']);

	// The pruner: a mode select plus a number box that only exists for Custom.
	const pruner = tree.children[6];
	const select = pruner.children[0].children[1];
	assert.equal(select.props.value, 'auto', 'an unset threshold renders as Auto, not blank');
	assert.deepEqual(select.children.map((option) => option.props.value), ['disabled', 'auto', 'custom']);
	assert.equal(pruner.children[1], null, 'the number box is hidden while the mode is Auto');
	select.props.onChange({ target: { value: 'disabled' } });
	assert.deepEqual(calls.edits.at(-1), ['prunerThresholdChars', '0'], 'Disabled lands 0');
	select.props.onChange({ target: { value: 'auto' } });
	assert.deepEqual(calls.edits.at(-1), ['prunerThresholdChars', 'auto'], 'Auto lands auto');
	select.props.onChange({ target: { value: 'custom' } });
	assert.deepEqual(calls.edits.at(-1), ['prunerThresholdChars', 'auto'], 'Custom alone stages nothing');

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
