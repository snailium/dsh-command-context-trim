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
// The tuning half has its own patch file on purpose: a row's heading comes from its module URL, so two rows on one
// file are both called "dsh-command-context-trim" in the UI and a reader cannot tell the cards apart.

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
	// The trims' own thirteen plus the tuner's five, sorted as the helper returns them. They became volatile in 0.6.2
	// so that each row's card can carry its own half: a 0.1.7 form only holds volatile fields, so a field that is not
	// volatile is on no card at all — which is why the trims had no settings of their own until now, and why the one
	// card that existed showed the tuner's fields under a row named `/trim`.
	assert.deepEqual(volatileFields(Config), [
		'allowTailTrim',
		'autoTrim',
		'autoTuneCompaction',
		'compactionRoute',
		'compactionTargetRatio',
		'emergencyTrim',
		'maxAutoTrimRetries',
		'minTailTokens',
		'preferInPlacePrune',
		'protectHeadNodes',
		'pruneHeadChars',
		'pruneTailChars',
		'pruneThresholdChars',
		'prunerThresholdChars',
		'reserveOutputTokens',
		'retainRatio',
		'targetRatio',
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
	assert.match(patchSource, new RegExp(`- id: ${entryId}$`, 'mu'), 'cordis.patch.yml must declare the trim row');
	// Both rows DO share a module, and that is a property of dsh rather than a choice: a bundle mounts one patch and
	// has one module name, and dsh resolves a row's `meta` by module name too, so neither a per-row meta nor a second
	// patch file can separate the headings. The cards therefore name their own component — pinned below.
	// Both rows live in the one patch, and read the module off each row's own `name:` line.
	const rowModules = [...patchSource.matchAll(/^\s+- id: (context-trim[a-z-]*)\n\s+name: (\S+)/gmu)].map((m) => [m[1], m[2]]);
	assert.equal(rowModules.length, 2, 'both rows are declared, each with a name');
	assert.equal(rowModules[0][1], rowModules[1][1], `both rows are on ${rowModules[0][1]}; the heading cannot distinguish them`);
	assert.match(clientSource, /cardTrimIntro/u, 'so the trim card names itself');
	assert.match(clientSource, /cardTuneIntro/u, 'and so does the tune card');
	assert.match(patchSource, /- id: context-trim-tuning$/mu, 'the tuning row must be declared in the one patch a bundle mounts');
	assert.match(patchSource, /role: tuning/u, 'the tuning row must declare the role its module dispatches on');
	// The row must point at a DISTINCT MODULE, because a row's heading comes from its module and two rows on one entry
	// are both called "dsh-command-context-trim". A row's `name` is a JS module specifier, not a patch file.
	// Both files must ship, or the bundle declares a row whose module is not there.
	assert.ok(manifest.files.includes('cordis.tune.yml'), 'cordis.tune.yml must be in `files`');
	assert.ok(manifest.exports['./cordis.tune.yml'] === './cordis.tune.yml', 'and exported');
	assert.match(clientSource, /whileServed\(\[row\.rowId\]/u, 'each card must be gated on its own row namespace');
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
	assert.match(clientSource, /key: rowConfigKey\(row\.rowId\)/u);
	assert.match(clientSource, /const rowConfigKey = \(rowId\) =>/u);
	// The card declares each field with the type it must be written as, and parses on save: a boolean staged as the
	// string "true" is refused in band on 0.2.0, which is why the primitives' text-staging model is not used here.
	assert.match(clientSource, /key: 'autoTuneCompaction', kind: 'boolean'/u);
	assert.match(clientSource, /key: 'compactionTargetRatio', kind: 'number'/u);
	assert.match(clientSource, /key: 'prunerThresholdChars', kind: 'pruner'/u);
	assert.doesNotMatch(clientSource, /new SettingsFormModel\(/u, 'the model stages text and cannot write a typed value');
	assert.doesNotMatch(clientSource, /SettingsFormModel,|settingsTextField,|settingsNumberField,/u, 'and none of them is even imported');
	assert.match(clientSource, /h\(\s*SettingsForm,/u);
	assert.match(clientSource, /numeric: true/u, 'the ratio is a numeric field');
	assert.equal(/createElement\('li'/u.test(clientSource), false, 'the platform supplies the card frame');
	assert.equal(/slots\.register\([^)]*header/u.test(clientSource), false, 'no doubled card header');
	assert.match(clientSource, /if \(ctx\.configForms === undefined \|\| ctx\.slots === undefined/u, 'older web hosts get no registration at all');
});
