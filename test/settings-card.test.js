import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
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

test('exactly the two tuning fields are volatile, so the card shows exactly those', () => {
	assert.deepEqual(volatileFields(Config), ['compactionRoute', 'compactionTargetRatio']);
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
	for (const service of ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-plugin-manager']) {
		assert.ok(manifest.dsh.client.inject.includes(service), `${service} must load before the card`);
	}
});

test('the client entry id matches the loader row id, which is what the page keys on', () => {
	const entryId = /const ENTRY_ID = '([^']+)'/u.exec(clientSource)?.[1];
	assert.equal(entryId, 'context-trim');
	assert.match(patchSource, new RegExp(`- id: ${entryId}$`, 'mu'), 'the bundle patch must declare that row id');
	assert.match(clientSource, /whileServed\(\[ENTRY_ID\]/u, 'the card must be gated on the served namespace');
});

test('the card follows the 0.1.7 contract: summary one-liner, shared body, no own frame', () => {
	assert.match(clientSource, /export const inject = \['slots', 'locale', 'configForms'\]/u);
	assert.match(clientSource, /if \(props\.view === 'summary'\) return t\('description'\)/u);
	assert.match(clientSource, /name: 'plugins\.item'/u);
	assert.match(clientSource, /h\(\s*SettingsForm,/u);
	assert.match(clientSource, /numeric: true/u, 'the ratio is a numeric field');
	assert.match(clientSource, /settingsTextField\('compactionRoute'\)/u);
	assert.equal(/createElement\('li'/u.test(clientSource), false, 'the platform supplies the card frame');
	assert.equal(/slots\.register\([^)]*header/u.test(clientSource), false, 'no doubled card header');
	assert.match(clientSource, /if \(ctx\.configForms === undefined \|\| ctx\.slots === undefined/u, 'older web hosts get no registration at all');
});
