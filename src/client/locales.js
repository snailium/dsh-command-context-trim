/** English copy. */
export const en = {
	sectionCompaction: 'Compaction',
	// The two cards cannot be told apart by the row's heading: a row's heading comes from its module, and both
	// rows of one bundle share one module name. So each card opens by naming the component it configures.
	cardTrimIntro: 'This row owns the trims: the /trim command, and the automatic trim when a request hits the model\u2019s context wall.',
	cardTuneIntro: 'This row owns compaction tuning: when compaction fires, how hard the pruner clips, and the /context-tune command. Switching it off does not reset presets that were already tuned.',
	// The `trim` card's own sections and fields. None of these knobs was editable from the UI before: they were
	// not `.volatile()`, so no form carried them, and the one card that did exist showed the tuner's five
	// fields under a row named `/trim`.
	sectionTrims: 'Trims',
	sectionTrimsBehaviour: 'Behaviour',
	sectionInPlacePrune: 'In-place pruning',
	inPlacePruneNote:
		'Before eliding any span, oversized tool results are slimmed in place (head + marker + tail). These thresholds are character counts.',
	targetRatio: 'Target ratio',
	targetRatioHint: 'The share of the usable window a trim aims to leave.',
	retainRatio: 'Retained ratio',
	retainRatioHint: 'How much of the most recent context is kept verbatim, as a share of the model window.',
	minTailTokens: 'Retained floor',
	minTailTokensHint: 'Absolute floor for that retained tail, in tokens.',
	reserveOutputTokens: 'Output reserve',
	reserveOutputTokensHint: 'Tokens kept available for the model\u2019s own reply.',
	protectHeadNodes: 'Protected head nodes',
	protectHeadNodesHint: 'Leading nodes never trimmed (the task statement itself).',
	maxAutoTrimRetries: 'Max auto-trim retries',
	maxAutoTrimRetriesHint: 'Automatic trims allowed per overflow episode before handing recovery to compaction.',
	allowTailTrim: 'Allow tail trim',
	allowTailTrimHint: 'Let the elided span reach into the retained tail when the oldest span alone cannot free enough.',
	autoTrim: 'Auto-trim on overflow',
	autoTrimHint: 'Trim when a request hits the model\u2019s context wall instead of compacting. Ordinary threshold compaction is untouched.',
	emergencyTrim: 'Emergency trim',
	emergencyTrimHint: 'Take one last-resort trim when compaction cannot recover a wall hit either. The protected head may be elided; the newest human instruction is still never crossed.',
	preferInPlacePrune: 'Prefer in-place pruning',
	preferInPlacePruneHint: 'Slim oversized tool results in place before eliding anything.',
	pruneThresholdChars: 'Prune threshold (chars)',
	pruneThresholdCharsHint: 'A tool result is slimmed only when it exceeds this many characters.',
	pruneHeadChars: 'Pruned head (chars)',
	pruneHeadCharsHint: 'Head kept when a tool result is slimmed in place.',
	pruneTailChars: 'Pruned tail (chars)',
	pruneTailCharsHint: 'Tail kept when a tool result is slimmed in place.',
	sectionPrune: 'Prune',
	autoTuneCompaction: 'Auto tune compaction at runtime',
	autoTuneCompactionHint: 'Retunes the compaction trigger from each routed window as soon as the route is known.',
	autoTuneHeadlessOnly: 'Headless profile only. A web profile must use the /context-tune preset command.',
	tuneStockDisabledRoutes: 'Enable stock-disabled routes',
	tuneStockDisabledRoutesHint:
		'Only for windows at or below 64K, where dsh imposes no pressure trigger at all: on adds one (measured slower on one 40K task, 15 -> 24 compactions) and off keeps stock.',
	prunerThresholdChars: 'Tool-result pruner threshold',
	prunerThresholdCharsHint:
		'Disabled leaves the pruner alone (0). Auto derives the clip threshold from the routed window (half the message budget, capped at 32768). Custom overrides it with a character count.',
	prunerModeLabel: 'Threshold mode',
	prunerModeDisabled: 'Disabled',
	prunerModeAuto: 'Auto',
	prunerModeCustom: 'Custom',
	prunerCustom: 'Threshold (chars)',
	switchOn: 'On',
	switchOff: 'Off',

	title: 'Context trim',
	description: 'Trim the oldest, least valuable span of context when a request hits the model window — without any model call.',
	tuneDescription:
		'Decide when compaction fires and how hard the tool-result pruner clips: raise the trigger, derive the ' +
		'pruner threshold from each route, and write the result into a preset (/context-tune).',
	compactionTargetRatio: 'Compaction trigger',
	compactionTargetRatioHint:
		'Fraction of each routed window that a generated preset compacts at (0–1, e.g. 0.8 for 80 %). `/context-tune preset` writes it into the preset it generates; it does not change what /trim itself does.',
	compactionRoute: 'Summarization route',
	compactionRouteHint:
		'Optional provider:model used by a generated preset for compaction summarization. Leave empty to keep the route defaults.',
	unavailable: 'Configuration is unavailable in this deployment.',
	readOnly: 'This deployment does not accept edits here.',
	saveFailed: 'The deployment rejected these values; they are kept for you to edit.',
	save: 'Save',
	saving: 'Saving…',
	overridden: 'Overridden',
	reset: 'Reset',
	invalidNumber: 'Enter a number; leave empty for the default.'
};

/** Chinese copy. */
export const zh = {
	sectionCompaction: '压缩',
	// The two cards cannot be told apart by the row's heading: a row's heading comes from its module, and both
	// rows of one bundle share one module name. So each card opens by naming the component it configures.
	cardTrimIntro: '这一行负责裁剪：/trim 命令，以及请求撞上模型上下文墙时的自动裁剪。',
	cardTuneIntro: '这一行负责 compaction 调优：什么时候触发压缩、pruner 裁多狠、以及 /context-tune 命令。关闭这一行不会重置已调优过的 preset。',
	// The `trim` card's own sections and fields. These knobs have never been editable from the UI before; the
	// trims being a row of their own is what puts them on a card.
	sectionTrims: '裁剪',
	sectionTrimsBehaviour: '行为',
	sectionInPlacePrune: '在位剪枝',
	inPlacePruneNote: '在裁掉任何内容之前，先就地削去过大的工具结果（头 + 标记 + 尾）。这些阈值是字符数。',
	targetRatio: '目标比例',
	targetRatioHint: '裁剪后保留的可用窗口比例。',
	retainRatio: '保留比例',
	retainRatioHint: '最近多少上下文按原样保留，取模型窗口的一个比例。',
	minTailTokens: '保留下限',
	minTailTokensHint: '保留尾部的绝对下限（token）。',
	reserveOutputTokens: '输出预留',
	reserveOutputTokensHint: '给模型自己回复留出的 token。',
	protectHeadNodes: '保护开头',
	protectHeadNodesHint: '开头永不裁剪的节点数（任务说明本身）。',
	maxAutoTrimRetries: '自动重试上限',
	maxAutoTrimRetriesHint: '一次溢出里允许的自动裁剪次数，之后交给压缩。',
	allowTailTrim: '允许裁进保留尾部',
	allowTailTrimHint: '最旧的那一段不够腾出空间时，允许裁到保留尾部里。',
	autoTrim: '溢出时自动裁剪',
	autoTrimHint: '请求撞上模型上下文墙时先裁剪，而不是直接压缩。常规阈值压缩不受影响。',
	emergencyTrim: '应急裁剪',
	emergencyTrimHint: '压缩也救不回来时做最后一次裁剪；此时开头的保护节点也可能被裁掉，最新的人工指令仍不会。',
	preferInPlacePrune: '优先在位剪枝',
	preferInPlacePruneHint: '裁掉任何内容之前，先就地削去过大的工具结果。',
	pruneThresholdChars: '剪枝阈值（字符）',
	pruneThresholdCharsHint: '单个工具结果超过这个字符数才被削。',
	pruneHeadChars: '剪枝保留头（字符）',
	pruneHeadCharsHint: '就地剪枝时保留的头部字符数。',
	pruneTailChars: '剪枝保留尾（字符）',
	pruneTailCharsHint: '就地剪枝时保留的尾部字符数。',
	sectionPrune: '裁剪',
	autoTuneCompaction: '运行时自动调优压缩阈值',
	autoTuneCompactionHint: '路由确定后立即按窗口重算压缩触发点。',
	autoTuneHeadlessOnly: '仅限 headless profile。web profile 需使用 /context-tune preset 命令来调优。',
	tuneStockDisabledRoutes: '也启用 stock 已禁用的路由',
	tuneStockDisabledRoutesHint:
		'只对 64K 及以下窗口有意义（那里 dsh 完全没有压力触发）：开会增加一个（我们在一台 40K 上实测更慢，压缩 15 → 24），关则保持 stock。',
	prunerThresholdChars: '工具结果裁剪阈值',
	prunerThresholdCharsHint:
		'Disabled = 不动 pruner（0）；Auto = 按路由窗口自动推导（半个消息预算，上限 32768）；Custom = 用你填的字符数覆盖。',
	prunerModeLabel: '阈值模式',
	prunerModeDisabled: 'Disabled',
	prunerModeAuto: 'Auto',
	prunerModeCustom: 'Custom',
	prunerCustom: '阈值（字符）',
	switchOn: '开',
	switchOff: '关',

	title: '上下文裁剪',
	description: '请求撞上模型上下文窗口时，剪掉最旧、最没价值的一段上下文——完全不调用模型。',
	tuneDescription:
		'决定压缩什么时候触发、工具结果剪枝裁多狠：抬高触发点、按路由派生剪枝阈值，并把结果写进 preset（/context-tune）。',
	compactionTargetRatio: '压缩触发阈值',
	compactionTargetRatioHint:
		'生成的预设按窗口的比例触发压缩（0–1，例如 0.8 表示 80%）。`/context-tune preset` 会把它写进生成的预设；它不改变 /trim 自身的裁剪行为。',
	compactionRoute: '摘要路由',
	compactionRouteHint: '可选，格式 provider:model，供生成的预设做压缩摘要；留空则沿用默认路由。',
	unavailable: '当前部署无法读取配置。',
	readOnly: '当前部署不接受在此修改。',
	saveFailed: '部署拒绝了这些取值，已为你保留以便修改。',
	save: '保存',
	saving: '保存中…',
	overridden: '已覆盖',
	reset: '重置',
	invalidNumber: '请填数字；留空表示使用默认值。'
};

/** The frame's copy, read from this plugin's dictionary. */
export function formLabels(t) {
	return {
		unavailable: t('unavailable'),
		readOnly: t('readOnly'),
		saveFailed: t('saveFailed'),
		save: t('save'),
		saving: t('saving')
	};
}
