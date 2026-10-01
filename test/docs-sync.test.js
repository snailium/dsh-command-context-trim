/**
 * The Chinese README is a maintained translation, and this file is what keeps it one.
 *
 * It drifted badly once — it was last in step with 0.3.8 while the plugin reached 0.4.5 — because nothing checked it.
 * A translation cannot be diffed against its source, so the check is on the parts that must be identical: the section
 * structure, every command and configuration key, the sync marker's version, and the defaults that are easy to get
 * wrong (the pruner threshold, which the English README itself once documented as the old opt-out).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('README.zh.md stays in step with README.md', async () => {
	const [en, zh, pkg] = await Promise.all([read('README.md'), read('README.zh.md'), read('package.json')]);
	const sections = (text) => [...text.matchAll(/^## .+$/gmu)].length;
	assert.equal(sections(zh), sections(en), 'the two files must keep the same section structure');

	// Language-neutral strings: commands, flags, keys, env vars. If one side gains a command, both must list it.
	const needles = [
		// 0.6.3 moved the tuning surface to /context-tune, so the needles carry the CURRENT spellings. The point of
		// this list is that both READMEs mention the same commands, not that they mention a particular one.
		'/context-tune preset inplace',
		'/context-tune preset check',
		'/context-tune preset list',
		'/context-tune preset default',
		'/context-tune reset',
		'/context-tune rescue',
		'--from',
		'--untuned',
		'DSH_TRIM_AUTO_TUNE',
		'DSH_TRIM_PRUNER',
		'DSH_TRIM_TUNE_STOCK_DISABLED',
		'prunerThresholdChars',
		'autoTuneCompaction',
		'tuneStockDisabledRoutes',
		'compactionTargetRatio',
		'compactionRoute',
		'thresholdRatio',
		'headroomTokens',
		'context-trim/tuned',
		'compaction/prune'
	];
	for (const needle of needles) {
		assert.ok(en.includes(needle), `README.md no longer mentions ${needle}`);
		assert.ok(zh.includes(needle), `README.zh.md no longer mentions ${needle}`);
	}

	// The marker names the version the translation was written against, so a release that skips the README fails here.
	const { version } = JSON.parse(pkg);
	assert.match(zh, new RegExp(`synced-with-readme: ${version}`), `README.zh.md must record synced-with-readme: ${version}`);

	// The defaults that have been wrong before.
	assert.match(en, /`prunerThresholdChars` \| `auto`/u, 'the English table must give the derived default');
	assert.match(zh, /`prunerThresholdChars` \| `auto`/u, 'the Chinese table must give the derived default');
	assert.ok(!/`prunerThresholdChars` \| `0`/u.test(zh), 'the old opt-out must not come back as the documented default');
});
