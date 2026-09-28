import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderRouteList, rescuePreset, tuneCompactionPreset } from '../lib/preset-tune.js';
import { resolveConfig } from '../lib/config.js';

/** The plugin list a base preset would dump, with the compaction group inside. */
const BASE_PLUGINS = `- id: persona
  name: '@deepseek-ai/dsh-persona'
- id: compaction
  name: cordis:group
  group: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
- id: delegation
  name: cordis:group
`;

/** Route metadata the adapter would report. */
const CATALOG = {
	'b70-sycl': { '/models/q.gguf': { contextWindow: 131072, defaultMaxTokens: 16384 } },
	'b70-smg': { '/models/q.gguf': { contextWindow: 131072, defaultMaxTokens: 16384 } },
	'bonsai-8gb': { '/models/mtp-lean.gguf': { contextWindow: 40960, defaultMaxTokens: 8192 } },
	'opencode-go': { 'deepseek-v4.1-flash': { contextWindow: 1000000, defaultMaxTokens: 384000 } }
};

/** Configured providers exactly as the llm-pi-ai row holds them. */
const PROVIDERS = {
	'b70-sycl': { models: [{ id: '/models/q.gguf' }] },
	'b70-smg': { models: [{ id: '/models/q.gguf' }] },
	'bonsai-8gb': { models: [{ id: '/models/mtp-lean.gguf' }] },
	'opencode-go': { models: [{ id: 'deepseek-v4.1-flash' }] }
};

/** Context stub: registry, configEditor row, profile patch path, settings and llm catalogue. */
function stubContext(request = {}) {
	const presets = request.presets ?? [
		{ id: 'standard', name: 'Standard', order: 1, isDefault: true },
		{ id: 'ptc', name: 'PTC', order: 3 }
	];
	const documents = request.documents ?? { standard: BASE_PLUGINS, ptc: BASE_PLUGINS };
	const writes = [];
	const settingsCalls = [];
	return {
		writes,
		settingsCalls,
		get(name) {
			if (name === 'agentPresets') {
				if (request.registryMissing === true) return undefined;
				return {
					async remoteExportList() {
						return { presets };
					},
					async resolve(id) {
						// Presets our stub "hot reloads" only after the first probe, plus
						// whatever the request declares as broken or absent.
						if (request.resolveAlwaysFails === true || (request.resolveFailsOnce !== true && request.resolveFails) || (request.resolveLatePreset === id && (request.resolveLateProbes ?? 1) > 1)) {
							throw new Error(`Unknown agent preset: ${id}`);
						}
						if (request.brokenPreset === id) return { id, broken: 'activation failed: boom' };
						return { id };
					},
					async readDocument(id) {
						const content = documents[id];
						if (content === undefined) throw new Error(`Unknown agent preset: ${id}`);
						return { agentPreset: id, content, name: id === 'standard' ? 'Standard' : id };
					}
				};
			}
			if (name === 'configEditor') {
				return { entries: () => [{ options: { id: 'llm-pi-ai', config: { providers: PROVIDERS } } }] };
			}
			if (name === 'settings') {
				if (request.settingsMissing === true) return undefined;
				return {
					async update(ns, patch) {
						if (request.settingsFails === true) throw new Error('settings: section was rejected');
						settingsCalls.push({ ns, patch });
					}
				};
			}
			if (name === 'profileContext') {
				return writes.length === 0 && request.patchPath === undefined ? undefined : { patchPath: request.patchPath, name: 'web' };
			}
			return undefined;
		},
		llm: {
			async listModels(provider) {
				return Object.keys(CATALOG[provider] ?? {});
			},
			async resolveModelInfo(provider, model) {
				const entry = CATALOG[provider]?.[model];
				if (entry === undefined) throw new Error(`no such model: ${provider}/${model}`);
				return { context: { contextWindow: entry.contextWindow }, defaultMaxTokens: entry.defaultMaxTokens };
			}
		}
	};
}

const stubAgent = (session = { seq: 0, eventAt: () => undefined }) => ({ session, options: { provider: 'b70-smg', model: '/models/q.gguf' } });

const CONFIG = () => resolveConfig({});

test('list mode reports every configured route with its reachable trigger', async () => {
	const ctx = stubContext();
	const text = await renderRouteList(ctx, stubAgent(), new AbortController().signal, CONFIG());
	assert.match(text, /Routes visible to the tuner \(4\)/);
	assert.match(text, /b70-sycl:\/models\/q\.gguf/);
	assert.match(text, /contextWindow 131072 · maxTokens 16384 · trigger would be ~104857 tokens/);
	assert.match(text, /bonsai-8gb:\/models\/mtp-lean\.gguf/);
	assert.match(text, /contextWindow 40960 · maxTokens 8192 · trigger would be ~32768 tokens/);
});

test('check mode generates the preset row and writes nothing', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'trim-preset-check-'));
	try {
		const patchPath = join(directory, 'cordis.patch.yml');
		const { result } = await tuneCompactionPreset(stubContext({ patchPath }), CONFIG(), {
			agent: stubAgent(),
			signal: new AbortController().signal,
			check: true
		});
		assert.equal(result.kind, 'success');
		assert.match(result.text, /check: nothing written/);
		assert.match(result.text, /tuning from preset "standard" → "standard-tuned"/);
		assert.match(result.text, /- id: preset-standard-tuned/);
		assert.match(result.text, /thresholdRatio: 0\.8/);
		assert.match(result.text, /modelPolicies:/);
		assert.match(result.text, /triggers at 80\.0 %/);
		await assert.rejects(stat(patchPath), /ENOENT/, 'check mode must not create the patch file');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('apply mode writes a marker-delimited row and regenerates in place', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'trim-preset-apply-'));
	try {
		const patchPath = join(directory, 'cordis.patch.yml');
		await readFile('/dev/null', 'utf8').catch(() => undefined);
		const ctx = stubContext({ patchPath });
		const request = { agent: stubAgent(), signal: new AbortController().signal };
		const first = await tuneCompactionPreset(ctx, CONFIG(), request);
		assert.equal(first.result.kind, 'success');
		assert.match(first.result.text, /Wrote .*cordis\.patch\.yml/);
		assert.match(first.result.text, /Use it for a \*\*new\*\* session/);
		assert.match(first.result.text, /cannot switch/);
		const written = await readFile(patchPath, 'utf8');
		assert.match(written, /# >>> dsh-command-context-trim: preset-standard-tuned/);
		assert.match(written, /- insert:/);
		assert.match(written, /      name: '@deepseek-ai\/dsh-agent-preset'/);
		assert.match(written, /        plugins:/);
		assert.match(written, /          - id: compaction-basic/);
		assert.equal(written.split('- id: preset-standard-tuned').length - 1, 1, 'exactly one generated row');

		const second = await tuneCompactionPreset(ctx, resolveConfig({ compactionTargetRatio: 0.7 }), request);
		assert.match(second.result.text, /Updated .*cordis\.patch\.yml/);
		const regenerated = await readFile(patchPath, 'utf8');
		assert.equal(regenerated.split('- id: preset-standard-tuned').length - 1, 1, 'regeneration replaces, never duplicates');
		assert.match(regenerated, /thresholdRatio: 0\.7/);
		assert.ok(!regenerated.includes('thresholdRatio: 0.8'), 'the previous policy is gone');
		assert.match(await readFile(`${patchPath}.bak-trim-preset`, 'utf8'), /thresholdRatio: 0\.8/, 'the first generation is backed up');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('the session\u2019s selected preset is cloned, and a summarization route can be overridden', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'trim-preset-base-'));
	try {
		const patchPath = join(directory, 'cordis.patch.yml');
		const session = {
			seq: 1,
			eventAt: (seq) => (seq === 0 ? { type: 'agent-preset/selected', data: { agentPreset: 'ptc' } } : undefined)
		};
		const { result } = await tuneCompactionPreset(stubContext({ patchPath }), CONFIG(), {
			agent: stubAgent(session),
			signal: new AbortController().signal,
			requestedRoute: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
		});
		assert.equal(result.kind, 'success');
		const written = await readFile(patchPath, 'utf8');
		assert.match(written, /id: ptc-tuned/);
		assert.match(written, /summarizationProvider: opencode-go/);
		assert.match(written, /summarizationModel: deepseek-v4\.1-flash/);
		assert.match(written, /maxTokens: 384000/, 'the summarizer call is sized from its own route');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('failures stay actionable: no registry, nothing to clone, no compaction row', async () => {
	const signal = new AbortController().signal;
	const missing = await tuneCompactionPreset(stubContext({ registryMissing: true }), CONFIG(), { agent: stubAgent(), signal });
	assert.equal(missing.result.kind, 'error');
	assert.match(missing.result.text, /composes no agent-preset registry/);

	const noCompaction = await tuneCompactionPreset(stubContext({ documents: { standard: '- id: persona\n  name: x\n' } }), CONFIG(), {
		agent: stubAgent(),
		signal
	});
	assert.equal(noCompaction.result.kind, 'error');
	assert.match(noCompaction.result.text, /declares no compaction-basic entry/);

	const noPatch = await tuneCompactionPreset(stubContext({ patchPath: undefined }), CONFIG(), { agent: stubAgent(), signal });
	assert.equal(noPatch.result.kind, 'error');
	assert.match(noPatch.result.text, /Cannot locate the profile patch/);
});

test('the default is set only after the preset is registered and healthy', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'trim-preset-default-'));
	try {
		const patchPath = join(directory, 'cordis.patch.yml');
		const ctx = stubContext({ patchPath });
		const { result } = await tuneCompactionPreset(ctx, CONFIG(), {
			agent: stubAgent(),
			signal: new AbortController().signal,
			setDefault: true
		});
		assert.equal(result.kind, 'success');
		assert.deepEqual(ctx.settingsCalls, [{ ns: 'agent-preset-registry', patch: { selectedDefault: 'standard-tuned' } }]);
		assert.match(result.text, /Set "standard-tuned" as the default preset for new sessions/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('an unregistered, broken or unwritable default is refused with a reason', async () => {
	const signal = new AbortController().signal;
	const cases = [
		{
			request: { resolveAlwaysFails: true },
			expect: /Left the default unchanged: preset "standard-tuned" is not registered yet/,
			settings: 0
		},
		{
			request: { brokenPreset: 'standard-tuned' },
			expect: /registered but failed to activate \(activation failed: boom\)/,
			settings: 0
		},
		{
			request: { settingsMissing: true },
			expect: /composes no settings service/,
			settings: 0
		},
		{
			request: { settingsFails: true },
			expect: /Could not set it as the default \(settings: section was rejected\)/,
			settings: 1
		}
	];
	for (const probe of cases) {
		const directory = await mkdtemp(join(tmpdir(), 'trim-preset-default-'));
		try {
			const ctx = stubContext({ ...probe.request, patchPath: join(directory, 'cordis.patch.yml') });
			const { result } = await tuneCompactionPreset(ctx, CONFIG(), {
				agent: stubAgent(),
				signal,
				setDefault: true
			});
			assert.equal(result.kind, 'success', 'the row is still written');
			assert.match(result.text, probe.expect);
			assert.equal(ctx.settingsCalls.length + (probe.request.settingsFails === true ? 1 : 0), probe.settings, probe.expect.source);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});

/** A preset document that already carries the pruner row a web preset has. */
const PRUNER_ROW = `
- id: tool-result-pruner
  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
  config:
    thresholdChars: 8192
    headChars: 4096
    tailChars: 1024
`;

const WITH_PRUNER = () => ({ standard: BASE_PLUGINS + PRUNER_ROW, ptc: BASE_PLUGINS + PRUNER_ROW });

test('the generated preset also carries a derived pruner threshold', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'trim-preset-pruner-'));
	try {
		const patchPath = join(directory, 'cordis.patch.yml');
		const { result } = await tuneCompactionPreset(stubContext({ patchPath, documents: WITH_PRUNER() }), CONFIG(), {
			agent: stubAgent(),
			signal: new AbortController().signal
		});
		assert.equal(result.kind, 'success', result.text);
		assert.match(result.text, /Pruner: tool-result-pruner thresholdChars -> 32768 \(auto from the routed windows/);
		// The report truncates the row; the patch on disk is the artefact that matters.
		const written = await readFile(patchPath, 'utf8');
		assert.match(written, /- id: tool-result-pruner/);
		assert.match(written, /thresholdChars: 32768/);
		assert.match(written, /headChars: 4096/);
		assert.doesNotMatch(written, /thresholdChars: 8192/, 'the stock clip threshold must be replaced');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('prunerThresholdChars = 0 generates the compaction row and leaves the pruner alone', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'trim-preset-pruner-off-'));
	try {
		const patchPath = join(directory, 'cordis.patch.yml');
		const { result } = await tuneCompactionPreset(
			stubContext({ patchPath, documents: WITH_PRUNER() }),
			resolveConfig({ prunerThresholdChars: 0 }),
			{ agent: stubAgent(), signal: new AbortController().signal }
		);
		assert.equal(result.kind, 'success', result.text);
		assert.match(result.text, /Pruner: left alone/);
		const written = await readFile(patchPath, 'utf8');
		assert.match(written, /thresholdChars: 8192/, 'the stock value stays untouched');
		assert.doesNotMatch(written, /thresholdChars: 32768/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('a preset that declares no pruner row is reported, not failed', async () => {
	const { result } = await tuneCompactionPreset(stubContext(), CONFIG(), {
		agent: stubAgent(),
		signal: new AbortController().signal,
		check: true
	});
	assert.equal(result.kind, 'success', result.text);
	assert.match(result.text, /declares no tool-result-pruner row/);
});

test('inplace mode writes an override for the base preset id, not a new preset', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'trim-preset-inplace-'));
	try {
		const patchPath = join(directory, 'cordis.patch.yml');
		const { result } = await tuneCompactionPreset(stubContext({ patchPath, documents: WITH_PRUNER() }), CONFIG(), {
			agent: stubAgent(),
			signal: new AbortController().signal,
			inplace: true
		});
		assert.equal(result.kind, 'success', result.text);
		assert.match(result.text, /overriding preset "standard" in place/u);
		const written = await readFile(patchPath, 'utf8');
		assert.match(written, /^- id: preset-standard$/mu, 'the shipped row is addressed by id');
		assert.doesNotMatch(written, /insert:/u, 'no new row is declared');
		assert.doesNotMatch(written, /standard-tuned/u, 'no new preset id appears');
		assert.match(written, /id: standard$/mu);
		assert.match(written, /thresholdChars: 32768/u, 'the derived pruner threshold rides along');
		assert.match(result.text, /New sessions keep using preset "standard"/u, 'the shadowing caveat is reported');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('the preset name comes from the registry, so re-running cannot stack the suffix', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'trim-preset-name-'));
	try {
		const patchPath = join(directory, 'cordis.patch.yml');
		const first = await tuneCompactionPreset(stubContext({ patchPath, documents: WITH_PRUNER() }), CONFIG(), {
			agent: stubAgent(),
			signal: new AbortController().signal,
			inplace: true
		});
		assert.equal(first.result.kind, 'success', first.result.text);
		// Inplace keeps the registry's name: the user picks the same preset as before.
		const written = await readFile(patchPath, 'utf8');
		assert.match(written, /^    name: '?Standard'?$/mu, 'inplace keeps the base name');
		assert.doesNotMatch(written, /\(tuned/u, 'no tuning suffix in inplace mode');

		// Insert mode adds exactly one suffix, even when the document itself was written by an earlier run.
		const second = await mkdtemp(join(tmpdir(), 'trim-preset-name2-'));
		const secondPath = join(second, 'cordis.patch.yml');
		await tuneCompactionPreset(stubContext({ patchPath: secondPath, documents: WITH_PRUNER() }), CONFIG(), {
			agent: stubAgent(),
			signal: new AbortController().signal
		});
		const inserted = await readFile(secondPath, 'utf8');
		// Insert mode nests the row inside `- insert:`, so assert on content and count, not on indentation.
		assert.match(inserted, /name: '?Standard \(tuned 80%\)'?/u);
		assert.equal((inserted.match(/\(tuned/gu) ?? []).length, 1, 'the suffix appears exactly once');
		await rm(second, { recursive: true, force: true });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('a legacy tuning suffix in the registry name is normalized away', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'trim-preset-legacy-'));
	try {
		const patchPath = join(directory, 'cordis.patch.yml');
		// 0.3.9 could leave this behind; the registry then reports it as the base name.
		const presets = [{ id: 'standard', name: 'Standard (tuned 80%) (tuned 80%)', order: 1, isDefault: true }];
		await tuneCompactionPreset(
			stubContext({ patchPath, presets, documents: WITH_PRUNER() }),
			CONFIG(),
			{ agent: stubAgent(), signal: new AbortController().signal, inplace: true }
		);
		const written = await readFile(patchPath, 'utf8');
		assert.match(written, /^    name: Standard$/mu, 'inplace lands on the clean base name');
		assert.equal((written.match(/\(tuned/gu) ?? []).length, 0, 'no suffix survives in inplace mode');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('rescue recreates a missing preset id and can tune it on the way in', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'trim-rescue-'));
	try {
		const patchPath = join(directory, 'cordis.patch.yml');
		const { result } = await rescuePreset(stubContext({ patchPath, documents: WITH_PRUNER() }), CONFIG(), {
			agent: stubAgent(),
			signal: new AbortController().signal,
			missingId: 'standard-lost'
		});
		assert.equal(result.kind, 'success', result.text);
		assert.match(result.text, /Rescue row for preset "standard-lost" from donor "standard"/u);
		assert.match(result.text, /history is unaffected/u, 'the donor-composition caveat is stated');
		const written = await readFile(patchPath, 'utf8');
		assert.match(written, /^- id: preset-standard-lost$/mu, 'the row addresses the missing id');
		assert.match(written, /^    id: standard-lost$/mu, 'and config.id matches it, which is what resolve() looks up');
		assert.doesNotMatch(written, /standard-tuned/u);
		assert.match(written, /thresholdChars: 32768/u, 'the tuned pruner threshold rides along by default');

		// --untuned keeps the donor's own plugin list untouched.
		const plainDir = await mkdtemp(join(tmpdir(), 'trim-rescue-plain-'));
		const plainPath = join(plainDir, 'cordis.patch.yml');
		const plain = await rescuePreset(stubContext({ patchPath: plainPath, documents: WITH_PRUNER() }), CONFIG(), {
			agent: stubAgent(),
			signal: new AbortController().signal,
			missingId: 'standard-gone',
			untuned: true
		});
		assert.equal(plain.result.kind, 'success', plain.result.text);
		assert.match(plain.result.text, /--untuned/u);
		const plainWritten = await readFile(plainPath, 'utf8');
		assert.doesNotMatch(plainWritten, /thresholdChars: 32768/u, 'untuned must not splice our pruner value');
		await rm(plainDir, { recursive: true, force: true });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('rescue refuses an id that still exists, and a donor that does not', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'trim-rescue-refuse-'));
	try {
		const patchPath = join(directory, 'cordis.patch.yml');
		const existing = await rescuePreset(stubContext({ patchPath }), CONFIG(), {
			agent: stubAgent(),
			signal: new AbortController().signal,
			missingId: 'standard'
		});
		assert.equal(existing.result.kind, 'error', existing.result.text);
		assert.match(existing.result.text, /still exists/u);
		await assert.rejects(stat(patchPath), /ENOENT/, 'a refusal must not write anything');

		const badDonor = await rescuePreset(stubContext({ patchPath }), CONFIG(), {
			agent: stubAgent(),
			signal: new AbortController().signal,
			missingId: 'standard-lost',
			donorId: 'nope'
		});
		assert.equal(badDonor.result.kind, 'error', badDonor.result.text);
		assert.match(badDonor.result.text, /Donor preset "nope" does not exist/u);
		assert.match(badDonor.result.text, /standard/u, 'the error names the available donors');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('check reports route coverage and flags an uncovered small window', async () => {
	const { result } = await tuneCompactionPreset(stubContext(), CONFIG(), {
		agent: stubAgent(),
		signal: new AbortController().signal,
		check: true
	});
	assert.match(result.text, /coverage: 4 route\(s\) configured, 0 covered by this preset, 4 not covered/u);
	// bonsai-8gb is 40960/8192 => message budget 32768 <= 65536, so an uncovered policy is the dangerous case.
	assert.match(result.text, /uncovered SMALL route bonsai-8gb\//u);
	assert.match(result.text, /enables the pressure trigger/u);

	// A preset that already carries every policy reports full coverage and no warning.
	const coveredDoc = WITH_PRUNER().standard.replace(
		'- id: tool-result-pruner',
		[
			'modelPolicies:',
			'  - provider: b70-sycl',
			'    model: /models/q.gguf',
			'  - provider: b70-smg',
			'    model: /models/q.gguf',
			'  - provider: bonsai-8gb',
			'    model: /models/mtp-lean.gguf',
			'  - provider: opencode-go',
			'    model: deepseek-v4.1-flash',
			'- id: tool-result-pruner'
		].join('\n')
	);
	const full = await tuneCompactionPreset(
		stubContext({ documents: { standard: coveredDoc, ptc: coveredDoc } }),
		CONFIG(),
		{ agent: stubAgent(), signal: new AbortController().signal, check: true }
	);
	assert.match(full.result.text, /coverage: 4 route\(s\) configured, 4 covered by this preset\./u);
	assert.doesNotMatch(full.result.text, /uncovered SMALL/u);
});
