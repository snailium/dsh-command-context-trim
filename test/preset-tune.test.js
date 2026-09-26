import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderRouteList, tuneCompactionPreset } from '../lib/preset-tune.js';
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

/** Context stub: registry, configEditor row, profile patch path and llm catalogue. */
function stubContext(request = {}) {
	const presets = request.presets ?? [
		{ id: 'standard', name: 'Standard', order: 1, isDefault: true },
		{ id: 'ptc', name: 'PTC', order: 3 }
	];
	const documents = request.documents ?? { standard: BASE_PLUGINS, ptc: BASE_PLUGINS };
	const writes = [];
	return {
		writes,
		get(name) {
			if (name === 'agentPresets') {
				if (request.registryMissing === true) return undefined;
				return {
					async remoteExportList() {
						return { presets };
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
