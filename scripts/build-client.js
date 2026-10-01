/**
 * Build script for dsh-command-context-trim/client.
 *
 * Assembles modular source files in src/client/ into the single distribution file lib/client.js
 * required by the DeepSeek Harness client module loader (__ModuleLoader__.load).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC_DIR = join(ROOT, 'src', 'client');
const OUTPUT_FILE = join(ROOT, 'lib', 'client.js');

export async function buildClientBundle() {
	const [constants, locales, helpers, form, components, lifecycle] = await Promise.all([
		readFile(join(SRC_DIR, 'constants.js'), 'utf8'),
		readFile(join(SRC_DIR, 'locales.js'), 'utf8'),
		readFile(join(SRC_DIR, 'helpers.js'), 'utf8'),
		readFile(join(SRC_DIR, 'form.js'), 'utf8'),
		readFile(join(SRC_DIR, 'components.js'), 'utf8'),
		readFile(join(SRC_DIR, 'lifecycle.js'), 'utf8')
	]);

	const stripImportsExports = (code) =>
		code
			.replace(/^import\s+.*?;?\s*$/gmu, '')
			.replace(/^export\s+(const|function|class)\s+/gmu, '$1 ')
			.replace(/^export\s*\{[^}]*\};?\s*$/gmu, '')
			.trim();

	const header = `/**
 * \`/trim\` settings card — browser half.
 *
 * The Plugins page renders the intersection of two ledgers: the settings namespaces the Host reports, and the cards a
 * browser bundle registers under the same key. The key is the **loader entry id** (\`context-trim\`, the row id our bundle
 * patch declares), and the Host only reports an entry as a namespace when its schema carries \`.volatile()\` fields —
 * which is why the five tuning fields are marked volatile in \`./index.js\` and why this card shows exactly those five.
 *
 * This file is a **classic script**, not an ES module: the harness serves client halves into a page that expects every
 * bundle to register itself through \`window.__ModuleLoader__.load({ id, factory })\`, with \`id\` equal to the package
 * name. A plain ESM file is fetched and then rejected with "loaded without registering … via __ModuleLoader__.load",
 * which is exactly how this card failed the first time. Both \`react\` and \`@deepseek-ai/dsh-client-ui-primitives\` are
 * module table seeds, so \`require\` reaches them.
 *
 * The card registers into **\`plugins.row.config\`**, keyed \`<package>#<row id>\`, because our settings namespace is a row
 * **our own bundle declares**. That is what the slot contract requires for a third-party bundle (\`plugins.item\` is
 * OCCUPIED by the official settings pages, one companion package per host-plane namespace), and it is the only
 * non-official config slot the page hands a \`form\` to. Registering into \`plugins.item\` does not break: the card still
 * renders, under the **Official** heading, mislabelled as an official plugin.
 *
 * ## Why this card does not use \`SettingsFormModel\`
 *
 * The primitives' model stages every field as **text** and parses it on save. That is fine for strings and numbers,
 * and it is what dsh 0.1.7 accepted for booleans too — a \`.volatile()\` field relaxed the type check, so the string
 * \`"true"\` landed where a \`z.boolean()\` was declared. dsh 0.2.0 validates the operation against the schema, and a
 * string is not a boolean: the write is refused in band, the draft is kept, and the frame shows "The deployment
 * rejected these values". Measured, both ways: changing the numeric trigger saves and lands in the profile patch;
 * flipping a boolean switch is refused. So the two switches and the pruner select are written here with **correctly
 * typed values**, and the card keeps its own draft and issues one fenced \`scope.mutate(ops, baseline.revision)\`.
 * The presentational halves are still the shell's: \`SettingsForm\` for the frame and \`SettingsValueField\` for the text
 * controls, both of which only read \`{text, overridden, invalid}\` plus callbacks.
 *
 * Verified against dsh 0.1.7-rc.2 and 0.2.0-rc.2. On 0.1.2/0.1.5 web hosts \`configForms\` does not exist; the module
 * detects that and registers nothing rather than breaking their Plugins page.
 */
window.__ModuleLoader__.load({
	id: 'dsh-command-context-trim',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const { createElement: h, useState, useEffect } = require('react');
		// Only the presentational halves are imported. The staged form is this file's own (see the header note on why),
		// and \`SettingsValueField\` reads nothing but \`{text, overridden, invalid}\` plus callbacks.
		const { SettingsForm, SettingsValueField, Switch } = require('@deepseek-ai/dsh-client-ui-primitives');
`;

	const footer = `
		exports.NS = NS;
		exports.ENTRY_ID = ENTRY_ID;
		exports.PACKAGE = PACKAGE;
		exports.ROW_CONFIG_KEY = ROW_CONFIG_KEY;
		exports.SLOT_NAME = 'plugins.row.config';
		exports.ROWS = ROWS;
		exports.TUNING_ENTRY_ID = TUNING_ENTRY_ID;
		exports.TUNING_ROW_CONFIG_KEY = TUNING_ROW_CONFIG_KEY;
		exports.TRIM_CARD_FIELDS = TRIM_CARD_FIELDS;
		exports.TUNING_CARD_FIELDS = TUNING_CARD_FIELDS;
		exports.CARD_FIELDS = CARD_FIELDS;
		exports.FIELD_DEFAULTS = FIELD_DEFAULTS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
`;

	const indent = (code) =>
		code
			.split('\n')
			.map((line) => (line.length > 0 ? `\t\t${line}` : line))
			.join('\n');

	const bundleContent = [
		header,
		indent(stripImportsExports(constants)),
		'',
		indent(stripImportsExports(locales)),
		'',
		indent(stripImportsExports(helpers)),
		'',
		indent(stripImportsExports(components)),
		'',
		indent(stripImportsExports(form)),
		'',
		indent(stripImportsExports(lifecycle)),
		footer
	].join('\n');

	await writeFile(OUTPUT_FILE, bundleContent, 'utf8');
	return bundleContent;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	buildClientBundle().then(() => {
		console.log('Successfully built lib/client.js from src/client/');
	});
}
