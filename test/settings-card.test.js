import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';
import { Config } from '../lib/index.js';
import { readConfig, resolveConfig } from '../lib/config.js';

const ROOT = new URL('..', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'));
const clientSource = readFileSync(new URL('lib/client.js', ROOT), 'utf8');
const patchSource = readFileSync(new URL('cordis.patch.yml', ROOT), 'utf8');

/** Field names the loader schema marks `.volatile()` — exactly what the card shows. */
function volatileFields(schema) {
	const json = schema.toJSON();
	const root = json.refs[json.uid];
	return Object.entries(root.dict ?? {})
		.filter(([, ref]) => json.refs[ref.uid ?? ref]?.meta?.volatile === true)
		.map(([name]) => name)
		.sort();
}

/** `.volatile()` needs schemastery 3.18.4; older harnesses (0.1.5 and earlier) lack it. */
const supportsVolatile = typeof z.number().volatile === 'function';

test('exactly the two tuning fields are volatile, so the card shows exactly those', () => {
	if (!supportsVolatile) {
		// The whole point of the probe: an older host keeps plain fields so the plugin
		// still imports, and its web host has no card services either.
		assert.deepEqual(volatileFields(Config), [], 'a harness without .volatile() must not break the import');
		return;
	}
	assert.deepEqual(volatileFields(Config), [
		'autoTuneCompaction',
		'compactionRoute',
		'compactionTargetRatio',
		'prunerThresholdChars',
		'tuneStockDisabledRoutes'
	]);
	const json = Config.toJSON();
	const route = json.refs[json.refs[json.uid].dict.compactionRoute.uid ?? json.refs[json.uid].dict.compactionRoute];
	assert.match(route.meta.description, /provider:model/, 'a volatile field needs a description for the form hint');
});

test('readConfig unwraps volatile live handles and is safe on already-resolved input', () => {
	const live = readConfig({
		compactionTargetRatio: { get: () => 0.7 },
		compactionRoute: { get: () => 'opencode-go:deepseek-v4.1-flash' },
		autoTrim: { get: () => true }
	});
	assert.equal(live.compactionTargetRatio, 0.7);
	assert.deepEqual({ ...live.compactionRoute }, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' });
	assert.equal(live.autoTrim, true);

	// A handle that returns an out-of-range value must fail exactly as a plain one does.
	assert.throws(() => readConfig({ compactionTargetRatio: { get: () => 2 } }), /compactionTargetRatio/);
	// Re-resolving a resolved configuration is a no-op (the plugin does this per event).
	assert.deepEqual({ ...readConfig(live) }, { ...live });
	assert.deepEqual({ ...resolveConfig({}) }, { ...readConfig({}) }, 'both entry points agree');
});

test('the client half is declared and points at a file that ships', () => {
	assert.equal(manifest.exports['./client'].default, './lib/client.js');
	assert.ok(manifest.files.includes('lib'), 'the client file must ship');
	assert.equal(manifest.dsh.client.platform, 'web');
	// No version-specific package names: a 0.1.5 web host has none of the 0.1.7 client
	// packages, and asking for them would fail that host's whole page. The real
	// requirement is the browser-side service list (`inject` in lib/client.js), which
	// cordis gates for us.
	assert.equal(manifest.dsh.client.inject, undefined);
	assert.match(clientSource, /const inject = \['slots', 'locale', 'configForms'\]/u);
});

test('the client entry id matches the loader row id, which is what the page keys on', () => {
	const entryId = /const ENTRY_ID = '([^']+)'/u.exec(clientSource)?.[1];
	assert.equal(entryId, 'context-trim');
	assert.match(patchSource, new RegExp(`- id: ${entryId}$`, 'mu'), 'the bundle patch must declare that row id');
	assert.match(clientSource, /whileServed\(\[ENTRY_ID\]/u, 'the card must be gated on the served namespace');
});

test('the card follows the 0.1.7 contract: summary one-liner, shared body, no own frame', () => {
	// The harness serves client halves as classic scripts that must register
	// themselves through the module loader; a plain ESM file is fetched and rejected.
	assert.match(clientSource, /window\.__ModuleLoader__\.load\(\{/u);
	assert.match(clientSource, /id: 'dsh-command-context-trim'/u, 'the registration id must be the package name');
	assert.match(clientSource, /factory: \(require\) => \{/u);
	assert.match(clientSource, /const inject = \['slots', 'locale', 'configForms'\]/u);
	assert.match(clientSource, /exports\.apply = apply/u);
	assert.equal(/^\s*(import|export)\s/mu.test(clientSource), false, 'no ES module syntax in a served client bundle');
	assert.match(clientSource, /if \(props\.view === 'summary'\) return t\('description'\)/u);
	// The row slot, keyed `<package>#<row id>` — the contract for a third-party bundle. `plugins.item` is the
	// official slot: a card parked there still renders, but mislabelled under "Official" and, measured on 0.2.0,
	// refused on save. The key fails silently if wrong, so all three pieces are asserted.
	assert.match(clientSource, /name: 'plugins\.row\.config'/u);
	assert.match(clientSource, /key: ROW_CONFIG_KEY/u);
	assert.match(clientSource, /\$\{PACKAGE\}#\$\{ENTRY_ID\}/u);
	// The card declares each field with the type it must be written as, and parses on save: a boolean staged as the
	// string "true" is refused in band on 0.2.0, which is why the primitives' text-staging model is not used here.
	assert.match(clientSource, /key: 'autoTuneCompaction', kind: 'boolean'/u);
	assert.match(clientSource, /key: 'compactionTargetRatio', kind: 'number'/u);
	assert.match(clientSource, /key: 'prunerThresholdChars', kind: 'pruner'/u);
	assert.doesNotMatch(clientSource, /new SettingsFormModel\(/u, 'the model stages text and cannot write a typed value');
	assert.match(clientSource, /h\(\s*SettingsForm,/u);
	assert.match(clientSource, /numeric: true/u, 'the ratio is a numeric field');
	assert.equal(/createElement\('li'/u.test(clientSource), false, 'the platform supplies the card frame');
	assert.equal(/slots\.register\([^)]*header/u.test(clientSource), false, 'no doubled card header');
	assert.match(clientSource, /if \(ctx\.configForms === undefined \|\| ctx\.slots === undefined/u, 'older web hosts get no registration at all');
});
