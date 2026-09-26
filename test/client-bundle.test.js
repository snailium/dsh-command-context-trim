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

/** Minimal stand-ins for the shared primitives and React. */
function stubs() {
	const calls = { form: [], fields: [], model: null };
	const primitives = {
		SettingsForm: function SettingsForm(props, ...children) {
			return { type: 'SettingsForm', props, children };
		},
		SettingsValueField: function SettingsValueField(props) {
			calls.fields.push(props);
			return { type: 'SettingsValueField', props };
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
				return { value: name === 'compactionTargetRatio' ? '0.8' : '', overridden: false, invalid: false };
			}
			actions() {
				return { save: () => 'saved', discard: () => 'discarded', edit: (f, v) => [f, v], resetField: (f) => f };
			}
			dispose() {
				this.disposed = true;
			}
		}
	};
	const react = { createElement: (type, props, ...children) => ({ type, props, children }) };
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
				return { id };
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
		['compactionRoute', false]
	]);
});

test('the component returns the summary one-liner and a two-field form body', async () => {
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
	const labels = tree.children.map((childSection) => childSection.props.label);
	assert.deepEqual(labels, ['compactionTargetRatio', 'compactionRoute']);
	assert.equal(tree.children[0].props.numeric, true);
	assert.equal(tree.children[1].props.numeric, undefined, 'the route field is free text');
	assert.equal(tree.children[0].props.hint, 'compactionTargetRatioHint');
	assert.deepEqual(tree.children[0].props.onEdit('0.75'), ['compactionTargetRatio', '0.75']);
	assert.equal(tree.children[1].props.onReset(), 'compactionRoute');
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
