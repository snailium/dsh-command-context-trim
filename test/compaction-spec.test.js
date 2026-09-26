import assert from 'node:assert/strict';
import test from 'node:test';
import {
	COMPACTION_DEFAULTS,
	FALLBACK_SUMMARIZER_MAX_TOKENS,
	headroomForRatio,
	planCompactionTuning,
	routedSpec
} from '../lib/compaction-spec.js';

/** The routes this machine actually declares (settings.yaml), as the command reads them. */
const ROUTES = [
	{ provider: 'b70-sycl', model: '/models/Qwen3.8-27B-Q4_K_M.gguf', contextWindow: 131072, maxTokens: 16384 },
	{ provider: 'bonsai-8gb', model: '/home/gwang/bonsai2/models/mtp-lean.gguf', contextWindow: 40960, maxTokens: 8192 },
	{ provider: 'ovms', model: '/models/Qwen3.8-27B-Q4_K_M.gguf', contextWindow: 81920, maxTokens: 65536 },
	{ provider: 'opencode-go', model: 'deepseek-v4.1-flash', contextWindow: 1000000, maxTokens: 384000 }
];

test('routedSpec reproduces dsh own arithmetic, including the headroom clamp', () => {
	// dsh's defaults on a 131072 route: 65536 headroom caps the trigger at 37.5 %,
	// which is the measured production value this whole feature exists to fix.
	const withDefaults = routedSpec({
		contextWindow: 131072,
		reservedCompletionTokens: 16384,
		thresholdRatio: COMPACTION_DEFAULTS.thresholdRatio,
		headroomTokens: COMPACTION_DEFAULTS.headroomTokens
	});
	assert.equal(withDefaults.thresholdTokens, 49152);
	assert.equal(withDefaults.achievedRatio, 0.375);
	assert.equal(withDefaults.retainTokens, Math.floor(114688 * COMPACTION_DEFAULTS.retainRatio));

	// With the generated headroom the ratio decides.
	const tuned = routedSpec({ contextWindow: 131072, reservedCompletionTokens: 16384, thresholdRatio: 0.8, headroomTokens: headroomForRatio({ contextWindow: 131072, reservedCompletionTokens: 16384, thresholdRatio: 0.8 }) });
	assert.equal(tuned.thresholdTokens, Math.floor(131072 * 0.8));
	// Exact: the trigger is the floored ratio term, so the achieved fraction is
	// floor(W*f)/W, not f itself.
	assert.equal(tuned.achievedRatio, Math.floor(131072 * 0.8) / 131072);
	assert.ok(tuned.retainTokens < tuned.thresholdTokens);
});

test('routedSpec rejects the two cases dsh itself throws on', () => {
	assert.throws(
		() => routedSpec({ contextWindow: 40960, reservedCompletionTokens: 8192, thresholdRatio: 0.8, headroomTokens: COMPACTION_DEFAULTS.headroomTokens }),
		/leaves no pressure budget/
	);
	assert.throws(
		() => routedSpec({ contextWindow: 40960, reservedCompletionTokens: 8192, thresholdRatio: 0.8, headroomTokens: 0, retainTokens: 40000 }),
		/retainTokens \(40000\) must be less than threshold tokens/
	);
	assert.throws(() => routedSpec({ contextWindow: 0, reservedCompletionTokens: 0, thresholdRatio: 0.8, headroomTokens: 0 }), /contextWindow \(0\) must be a positive integer/);
});

test('headroomForRatio is the largest headroom that lets the ratio decide', () => {
	assert.equal(headroomForRatio({ contextWindow: 131072, reservedCompletionTokens: 16384, thresholdRatio: 0.8 }), 9831);
	assert.equal(headroomForRatio({ contextWindow: 40960, reservedCompletionTokens: 8192, thresholdRatio: 0.75 }), 2048);
	assert.equal(headroomForRatio({ contextWindow: 131072, reservedCompletionTokens: 16384, thresholdRatio: 0.9 }), 0, 'an impossible ratio floors at zero');
});

test('planCompactionTuning emits one policy per usable route and states the top level explicitly', () => {
	const plan = planCompactionTuning({ routes: ROUTES, targetRatio: 0.8 });
	assert.equal(plan.policies.length, 4);
	assert.equal(plan.config.thresholdRatio, 0.8);
	assert.equal(plan.config.headroomTokens, 0, 'a zero top-level headroom keeps unlisted routes on the ratio');
	assert.equal(plan.config.maxTokens, FALLBACK_SUMMARIZER_MAX_TOKENS, 'maxTokens must be explicit because headroom would otherwise supply it');
	assert.deepEqual(
		plan.policies.map((policy) => [policy.provider, policy.thresholdRatio, policy.headroomTokens]),
		[
			['b70-sycl', 0.8, 9831],
			['bonsai-8gb', 0.8, 0],
			['ovms', 0.8, 0],
			['opencode-go', 0.8, 0]
		]
	);
	// Their real windows: 128k routes become 80 %, while the output reserve caps the
	// 81920/65536 route at 20 % and the 1M/384k route at 61.6 %.
	const notes = plan.notes.join('\n');
	assert.match(notes, /b70-sycl\/.*triggers at 80\.0 %/);
	assert.match(notes, /ovms\/.*is unreachable inside this route .*caps the trigger at 20\.0 %/);
	assert.match(notes, /opencode-go\/.*caps the trigger at 61\.6 %/);
});

test('planCompactionTuning names the summarization route and sizes maxTokens from it', () => {
	const plan = planCompactionTuning({
		routes: ROUTES,
		targetRatio: 0.8,
		summarizationRoute: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
	});
	assert.equal(plan.config.summarizationProvider, 'opencode-go');
	assert.equal(plan.config.summarizationModel, 'deepseek-v4.1-flash');
	assert.equal(plan.config.maxTokens, 384000, 'the summarizer call is sized by its own route');
	assert.match(plan.notes.join('\n'), /summarization on opencode-go\/deepseek-v4\.1-flash/);

	const unknown = planCompactionTuning({ routes: ROUTES, targetRatio: 0.8, summarizationRoute: { provider: 'nope', model: 'nope' } });
	assert.equal(unknown.config.summarizationProvider, 'nope');
	assert.equal(unknown.config.maxTokens, FALLBACK_SUMMARIZER_MAX_TOKENS);
	assert.match(unknown.notes.join('\n'), /is not in the current route inventory/);
});

test('planCompactionTuning skips unusable routes with a reason and refuses an empty result', () => {
	const plan = planCompactionTuning({
		routes: [...ROUTES, { provider: 'broken', model: 'm', contextWindow: 8192, maxTokens: 8192 }, { provider: 'nowindow', model: 'm' }],
		targetRatio: 0.8
	});
	assert.equal(plan.policies.length, 4);
	assert.deepEqual(
		plan.skipped.map((entry) => entry.provider),
		['broken', 'nowindow']
	);
	assert.match(plan.notes.join('\n'), /broken\/m: skipped — maxTokens 8192 leaves no message budget inside 8192/);
	assert.match(plan.notes.join('\n'), /nowindow\/m: skipped — no declared contextWindow/);
	assert.throws(() => planCompactionTuning({ routes: [], targetRatio: 0.8 }), /no route in the inventory can carry a pressure threshold/);
	assert.throws(() => planCompactionTuning({ routes: ROUTES, targetRatio: 0 }), /compactionTargetRatio \(0\) must be a number in \(0, 1\]/);
});
