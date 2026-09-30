/**
 * `/trim` settings card — browser half.
 *
 * The Plugins page renders the intersection of two ledgers: the settings namespaces the Host reports, and the cards a
 * browser bundle registers under the same key. The key is the **loader entry id** (`context-trim`, the row id our bundle
 * patch declares), and the Host only reports an entry as a namespace when its schema carries `.volatile()` fields —
 * which is why the five tuning fields are marked volatile in `./index.js` and why this card shows exactly those five.
 *
 * This file is a **classic script**, not an ES module: the harness serves client halves into a page that expects every
 * bundle to register itself through `window.__ModuleLoader__.load({ id, factory })`, with `id` equal to the package
 * name. A plain ESM file is fetched and then rejected with "loaded without registering … via __ModuleLoader__.load",
 * which is exactly how this card failed the first time. Both `react` and `@deepseek-ai/dsh-client-ui-primitives` are
 * module table seeds, so `require` reaches them.
 *
 * The card registers into **`plugins.row.config`**, keyed `<package>#<row id>`, because our settings namespace is a row
 * **our own bundle declares**. That is what the slot contract requires for a third-party bundle (`plugins.item` is
 * OCCUPIED by the official settings pages, one companion package per host-plane namespace), and it is the only
 * non-official config slot the page hands a `form` to. Registering into `plugins.item` does not break: the card still
 * renders, under the **Official** heading, mislabelled as an official plugin.
 *
 * ## Why this card does not use `SettingsFormModel`
 *
 * The primitives' model stages every field as **text** and parses it on save. That is fine for strings and numbers,
 * and it is what dsh 0.1.7 accepted for booleans too — a `.volatile()` field relaxed the type check, so the string
 * `"true"` landed where a `z.boolean()` was declared. dsh 0.2.0 validates the operation against the schema, and a
 * string is not a boolean: the write is refused in band, the draft is kept, and the frame shows "The deployment
 * rejected these values". Measured, both ways: changing the numeric trigger saves and lands in the profile patch;
 * flipping a boolean switch is refused. So the two switches and the pruner select are written here with **correctly
 * typed values**, and the card keeps its own draft and issues one fenced `scope.mutate(ops, baseline.revision)`.
 * The presentational halves are still the shell's: `SettingsForm` for the frame and `SettingsValueField` for the text
 * controls, both of which only read `{text, overridden, invalid}` and callbacks.
 *
 * Verified against dsh 0.1.7-rc.2 and 0.2.0-rc.2. On 0.1.2/0.1.5 web hosts `configForms` does not exist; the module
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
		// and `SettingsValueField` reads nothing but `{text, overridden, invalid}` plus callbacks.
		const { SettingsForm, SettingsValueField, Switch } = require('@deepseek-ai/dsh-client-ui-primitives');

		/** Dictionary namespace owned by this plugin (any string). */
		const NS = 'settings.context-trim';

		/** Loader entry id; MUST equal the row id our bundle patch declares — and our settings namespace. */
		const ENTRY_ID = 'context-trim';

		/** This package's name; the keyed slot is `<package>#<row id>`. */
		const PACKAGE = 'dsh-command-context-trim';

		/**
		 * The two rows this bundle declares, each with its own card.
		 *
		 * `plugins.row.config` is a KEYED slot: a registration only ever appears on the row whose key it matches, and a
		 * key nobody matches is not an error — it is simply nothing. So one card per row means one keyed entry per
		 * row, gated on that row's own namespace, showing only that row's own knobs. With a single card bound to the
		 * first row, the second row shows no Configure button at all.
		 *
		 * The `module` is what the Plugins page shows as the heading. It comes from the row's module URL, which is why
		 * the tuning row points at `./cordis.tune.yml` rather than `./cordis.patch.yml`: two rows on one file are both
		 * called "dsh-command-context-trim", which tells a reader nothing.
		 */
		const ROWS = [
			{ rowId: 'context-trim', role: 'trim', module: 'trim' },
			{ rowId: 'context-trim-tuning', role: 'tuning', module: 'tune' }
		];

		/** The key one row's card registers under. */
		const rowConfigKey = (rowId) => `${PACKAGE}#${rowId}`;

		/** The key `plugins.row.config` is matched by. Silent when wrong, so it is pinned in a test. */
		const ROW_CONFIG_KEY = rowConfigKey(ENTRY_ID);
		const TUNING_ENTRY_ID = 'context-trim-tuning';
		const TUNING_ROW_CONFIG_KEY = rowConfigKey(TUNING_ENTRY_ID);

		/**
		 * The effective value of each card field when the deployment sets none.
		 *
		 * Mirrors `DEFAULTS` in `lib/config.js` (and the values the plugin resolves in code), so an unset field shows
		 * what will really be used instead of a blank. Kept honest by a test rather than by discipline.
		 */
		const FIELD_DEFAULTS = {
			// The trims' own knobs, shown on the `trim` card. A deployment that sets none of them displays these, so the
			// page can answer "what will the plugin actually do" rather than showing a blank.
			targetRatio: 0.9,
			retainRatio: 0.16,
			minTailTokens: 2048,
			reserveOutputTokens: 8192,
			protectHeadNodes: 1,
			maxAutoTrimRetries: 3,
			allowTailTrim: true,
			autoTrim: true,
			emergencyTrim: true,
			preferInPlacePrune: true,
			pruneThresholdChars: 8192,
			pruneHeadChars: 4096,
			pruneTailChars: 1024,
			// The compaction tuner's knobs, shown on the `tune` card.
			compactionTargetRatio: 0.8,
			compactionRoute: '',
			autoTuneCompaction: false,
			tuneStockDisabledRoutes: false,
			// NOT `prunerThresholdChars` again: that name belongs to the trims' own in-place pruner (a character count
			// on a tool result). The tuner's is `prunerThresholdChars` on the OTHER row's schema, which is a separate
			// namespace with its own default of 'auto' — see TUNING_CARD_FIELDS, which carries its own default.
		};

		/** Pruner modes: the select's three options and the value each one lands. */
		const PRUNER_MODES = [
			{ id: 'disabled', value: '0' },
			{ id: 'auto', value: 'auto' }
		];

		/** English copy. */
		const en = {
			sectionCompaction: 'Compaction',
			// The two cards cannot be told apart by the row's heading: a row's heading comes from its module, and both
			// rows of one bundle share one module name. So each card opens by naming the component it configures.
			cardTrimIntro: 'This row owns the trims: the /trim command, and the automatic trim when a request hits the model\u2019s context wall.',
			cardTuneIntro: 'This row owns compaction tuning: when compaction fires, how hard the pruner clips, and the /trim-tune command. Switching it off does not reset presets that were already tuned.',
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
			protectHeadNodes: 'Protected head',
			protectHeadNodesHint: 'Leading nodes never trimmed (the task statement).',
			maxAutoTrimRetries: 'Auto-trim retries',
			maxAutoTrimRetriesHint: 'Automatic trims allowed per overflow episode before compaction takes over.',
			allowTailTrim: 'Allow trimming into the tail',
			allowTailTrimHint: 'Let the elided span reach the retained tail when the oldest span alone cannot free enough.',
			autoTrim: 'Trim on overflow',
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
			autoTuneHeadlessOnly: 'Headless profile only. A web profile must use the /trim preset command.',
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
			compactionTargetRatio: 'Compaction trigger',
			compactionTargetRatioHint:
				'Fraction of each routed window that a generated preset compacts at (0–1, e.g. 0.8 for 80 %). `/trim preset` writes it into the preset it generates; it does not change what /trim itself does.',
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
		const zh = {
			sectionCompaction: '压缩',
			// The two cards cannot be told apart by the row's heading: a row's heading comes from its module, and both
			// rows of one bundle share one module name. So each card opens by naming the component it configures.
			cardTrimIntro: '这一行负责裁剪：/trim 命令，以及请求撞上模型上下文墙时的自动裁剪。',
			cardTuneIntro: '这一行负责 compaction 调优：什么时候触发压缩、pruner 裁多狠、以及 /trim-tune 命令。关闭这一行不会重置已调优过的 preset。',
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
			autoTuneHeadlessOnly: '仅限 headless profile。web profile 需使用 /trim preset 命令来调优。',
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
			compactionTargetRatio: '压缩触发阈值',
			compactionTargetRatioHint:
				'生成的预设按窗口的比例触发压缩（0–1，例如 0.8 表示 80%）。`/trim preset` 会把它写进生成的预设；它不改变 /trim 自身的裁剪行为。',
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
		function formLabels(t) {
			return {
				unavailable: t('unavailable'),
				readOnly: t('readOnly'),
				saveFailed: t('saveFailed'),
				save: t('save'),
				saving: t('saving')
			};
		}

		/**
		 * The effective value of one card field: staged/overridden value, else the deployment's, else our default.
		 * @param state - the projection snapshot.
		 * @param field - the configuration key.
		 * @returns the value the plugin will really use.
		 */
		function effective(state, field) {
			// Measured shapes: the per-field entry is `{text, overridden, invalid}` (and a boolean's `text` is always
			// empty, so the entry cannot answer "is it on"), while the controller projects the effective configuration
			// onto `values`. Precedence: what the user staged, then the deployment, then this file's default mirror.
			const entry = state?.[field];
			const staged = entry !== null && typeof entry === 'object' ? entry.text : entry;
			if (staged !== undefined && staged !== null && staged !== '') return staged;
			const configured = state?.values?.[field];
			if (configured !== undefined && configured !== null && configured !== '') return configured;
			return FIELD_DEFAULTS[field];
		}

		/** Coerce a configuration value to a boolean the way `resolveConfig` does. */
		function asBoolean(value) {
			if (typeof value === 'boolean') return value;
			return value === 'true' || value === 'yes' || value === 'on' || value === 1 || value === '1';
		}

		/** The pruner select's mode for a value: `0` is Disabled, `auto` is Auto, anything else is Custom. */
		function prunerModeOf(value) {
			if (value === 0 || value === '0' || value === false) return 'disabled';
			if (value === 'auto') return 'auto';
			return 'custom';
		}

		/** A section heading inside the form body. */
		function sectionHeading(title) {
			return h(
				'div',
				{
					style: {
						gridColumn: '1 / -1',
						marginTop: '0.5rem',
						paddingBottom: '0.25rem',
						borderBottom: '1px solid var(--dsh-border-subtle, rgba(128,128,128,0.25))',
						fontWeight: 600,
						opacity: 0.85
					}
				},
				title
			);
		}

		/**
		 * A switch, because the shipped primitives ship none.
		 *
		 * `button[role=switch]` keeps it keyboard-operable and announceable, and the click stages the same boolean text
		 * the text field used to.
		 * @param props - id, label, hint (React nodes), checked, disabled, read/write copy and handlers.
		 * @returns the field markup.
		 */
		function switchField(props) {
			const { id, label, hint, checked, disabled, t, onToggle, onReset, overridden } = props;
			// The shell ships the control (and its styling): `Switch({ checked, onChange, label, disabled })`, a
			// `button[role=switch]`. The official cards pair it with a row label and a hint paragraph, which is what
			// this reproduces — the reset affordance is ours, because the primitive has none.
			return h(
				'div',
				{ id, style: { gridColumn: '1 / -1', marginBottom: '0.75rem' } },
				h(
					'div',
					{ style: { display: 'flex', alignItems: 'center', gap: '0.5rem' } },
					h('span', { style: { fontWeight: 500 } }, label),
					h(Switch, {
						checked,
						label,
						disabled,
						onChange: (next) => onToggle(next)
					}),
					overridden
						? h(
								'button',
								{
									type: 'button',
									disabled,
									onClick: onReset,
									style: {
										marginLeft: 'auto',
										background: 'none',
										border: 'none',
										cursor: 'pointer',
										opacity: 0.7,
										fontSize: '0.85em',
										textDecoration: 'underline'
									}
								},
								t('reset')
							)
						: null
				),
				hint !== undefined && hint !== null ? h('p', { style: { margin: '0.25rem 0 0', opacity: 0.75, fontSize: '0.9em' } }, hint) : null
			);
		}

		/**
		 * The card: the row's one-liner, or the shared settings form.
		 * @param props - view kind, locale reader, staged-form snapshot and its actions.
		 * @returns the one-liner for `view === 'summary'`, the form body otherwise.
		 */
		/**
		 * The `trim` row's card body: the knobs a trim actually obeys.
		 *
		 * These have never been editable from the UI — they were not `.volatile()`, so no form carried them, and the one
		 * card that existed showed the tuner's five fields under a row named `/trim`. Now that the trims are a row of
		 * their own, this is where they belong. The order is the order a reader needs them in: what fraction of the
		 * window a trim aims for, what it keeps, what it protects, and then the flags that change its behaviour.
		 *
		 * Only the fields marked volatile in the loader schema reach a form, so this list and the schema must agree;
		 * a test pins both against `lib/config.js`.
		 * @param options - `{ props, t, state, actions }` from the card.
		 * @returns the nodes the platform's `SettingsForm` renders as the form body.
		 */
		function trimCardBody({ props, t, state, actions }) {
			const labels = formLabels(t);
			const disabled = !state.writable;
			// Namespaced by ROW, not only by field: `autoTrim` (trims) and `autoTuneCompaction` (tuner) are different
			// knobs on different rows, and two rows sharing one id prefix would make the DOM ambiguous.
			const controlId = (field) => `plugin-config-trim-${field}`;
			const valueField = (field, extra = {}) =>
				h(
					SettingsValueField,
					{
						id: controlId(field),
						label: t(field),
						hint: t(`${field}Hint`),
						resetLabel: t('reset'),
						overriddenLabel: t('overridden'),
						invalidLabel: t('invalidNumber'),
						disabled,
						...extra,
						...state[field],
						onEdit: (text) => actions.edit(field, text),
						onReset: () => actions.resetField(field)
					}
				);
			// `id` on the wrapper rather than on `Switch`: the shell's switch takes no id of its own, and without one
			// there is nothing in the DOM to point at, which also makes a card untestable.
			const switchField = ({ field, label, hint }) =>
				h(
					'div',
					{
						key: field,
						id: `${controlId(field)}`,
						style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', margin: '4px 0' }
					},
					h('div', null, h('div', null, label), hint ? h('div', { style: { opacity: 0.75, fontSize: '0.9em' } }, hint) : null),
					h(
						Switch,
						{
							checked: asBoolean(effective(state, field)),
							label,
							disabled,
							onChange: (next) => actions.edit(field, next ? 'true' : 'false')
						}
					)
				);
			const number = (field) => valueField(field, { numeric: true });
			const flag = (field, hint) =>
				switchField({ field, label: t(field), hint: hint ? t(`${field}Hint`) : undefined });

			return h(
				SettingsForm,
				{
					labels,
					state,
					onSave: actions.save,
					onDiscard: actions.discard
				},
				h('p', { style: { margin: '0 0 0.75rem', opacity: 0.8, fontSize: '0.9em' } }, t('cardTrimIntro')),
				sectionHeading(t('sectionTrims')),
				number('targetRatio'),
				number('retainRatio'),
				number('minTailTokens'),
				number('reserveOutputTokens'),
				number('protectHeadNodes'),
				sectionHeading(t('sectionTrimsBehaviour')),
				flag('autoTrim'),
				flag('emergencyTrim'),
				flag('allowTailTrim'),
				flag('preferInPlacePrune'),
				number('maxAutoTrimRetries'),
				sectionHeading(t('sectionInPlacePrune')),
				number('pruneThresholdChars'),
				number('pruneHeadChars'),
				number('pruneTailChars'),
				h(
					'p',
					{ style: { margin: '0.25rem 0 0', opacity: 0.75, fontSize: '0.9em' } },
					t('inPlacePruneNote')
				)
			);
		}

		function TrimCard(props) {
			const { t } = props;
			// The `trim` row and the `tune` row get one card each, and a card only ever shows its own row's knobs. The
			// role rides on the component so the two registrations can share it.
			const role = props.row?.role === 'trim' ? 'trim' : 'tuning';
			// The staged form is this card's own controller, over `configForms.get('context-trim')` — the same shared
			// form every settings card writes through, but driven with correctly typed values (see the file header).
			const state = props.useTrimCard((snapshot) => snapshot);
			const actions = props;
			// The pruner's select holds a mode that may not be staged yet (Custom before a number is typed), so it
			// keeps its own state and resyncs whenever the effective value moves.
			const effectivePruner = effective(state, 'prunerThresholdChars');
			const [prunerMode, setPrunerMode] = useState(() => prunerModeOf(effectivePruner));
			useEffect(() => {
				const settled = prunerModeOf(effective(state, 'prunerThresholdChars'));
				if (settled !== 'custom') setPrunerMode(settled);
			}, [effective(state, 'prunerThresholdChars')]);
			if (props.view === 'summary') return t('description');
			if (role === 'trim') return trimCardBody({ props, t, state, actions });
			const disabled = !state.writable;
			const valueField = (field, extra) =>
				h(SettingsValueField, {
					id: `plugin-config-tune-${field}`,
					label: t(field),
					hint: t(`${field}Hint`),
					overriddenLabel: t('overridden'),
					resetLabel: t('reset'),
					invalidLabel: t('invalidNumber'),
					disabled,
					...state[field],
					onEdit: (text) => actions.edit(field, text),
					onReset: () => actions.resetField(field),
					...extra
				});
			const switchToggle = (field) => (next) => actions.edit(field, next ? 'true' : 'false');
			const autoTuneOn = asBoolean(effective(state, 'autoTuneCompaction'));
			const stockDisabledOn = asBoolean(effective(state, 'tuneStockDisabledRoutes'));
			return h(
				SettingsForm,
				{ labels: formLabels(t), state, onSave: actions.save, onDiscard: actions.discard },
				h('p', { style: { margin: '0 0 0.75rem', opacity: 0.8, fontSize: '0.9em' } }, t('cardTuneIntro')),
				sectionHeading(t('sectionCompaction')),
				valueField('compactionTargetRatio', { numeric: true }),
				valueField('compactionRoute'),
				switchField({
					id: 'plugin-config-tune-auto-tune',
					label: t('autoTuneCompaction'),
					// The requirement is that this caveat is impossible to miss: bold, and on the control itself.
					hint: h('span', null, t('autoTuneCompactionHint'), ' ', h('strong', null, t('autoTuneHeadlessOnly'))),
					checked: autoTuneOn,
					disabled,
					t,
					overridden: state.autoTuneCompaction?.overridden === true,
					onToggle: switchToggle('autoTuneCompaction'),
					onReset: () => actions.resetField('autoTuneCompaction')
				}),
				switchField({
					id: 'plugin-config-tune-stock-disabled',
					label: t('tuneStockDisabledRoutes'),
					hint: t('tuneStockDisabledRoutesHint'),
					checked: stockDisabledOn,
					disabled,
					t,
					overridden: state.tuneStockDisabledRoutes?.overridden === true,
					onToggle: switchToggle('tuneStockDisabledRoutes'),
					onReset: () => actions.resetField('tuneStockDisabledRoutes')
				}),
				sectionHeading(t('sectionPrune')),
				h(
					'div',
					{ id: 'plugin-config-tune-pruner-threshold', style: { gridColumn: '1 / -1', marginBottom: '0.75rem' } },
					h(
						'div',
						{ style: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' } },
						h('span', { style: { fontWeight: 500 } }, t('prunerThresholdChars')),
						h(
							'select',
							{
								id: 'plugin-config-tune-pruner-mode',
								'aria-label': t('prunerModeLabel'),
								disabled,
								value: prunerMode,
								style: { padding: '0.15rem 0.35rem', borderRadius: '4px' },
								onChange: (event) => {
									const next = event.target.value;
									setPrunerMode(next);
									// Disabled and Auto land their value immediately; Custom waits for the number so the
									// deployment never receives a mode with no threshold behind it.
									const preset = PRUNER_MODES.find((mode) => mode.id === next);
									if (preset !== undefined) actions.edit('prunerThresholdChars', preset.value);
								}
							},
							h('option', { value: 'disabled' }, t('prunerModeDisabled')),
							h('option', { value: 'auto' }, t('prunerModeAuto')),
							h('option', { value: 'custom' }, t('prunerModeCustom'))
						),
						state.prunerThresholdChars?.overridden === true
							? h(
									'button',
									{
										type: 'button',
										disabled,
										onClick: () => actions.resetField('prunerThresholdChars'),
										style: {
											background: 'none',
											border: 'none',
											cursor: 'pointer',
											opacity: 0.7,
											fontSize: '0.85em',
											textDecoration: 'underline'
										}
									},
									t('reset')
								)
							: null
					),
					// The number box exists only for Custom, and its value is what reaches the setting.
					prunerMode === 'custom'
						? h(
								'div',
								{ style: { marginTop: '0.35rem' } },
								h(SettingsValueField, {
									id: 'plugin-config-tune-pruner-custom',
									label: t('prunerCustom'),
									overriddenLabel: t('overridden'),
									resetLabel: t('reset'),
									invalidLabel: t('invalidNumber'),
									numeric: true,
									disabled,
									...state.prunerThresholdChars,
									onEdit: (text) => actions.edit('prunerThresholdChars', text),
									onReset: () => actions.resetField('prunerThresholdChars')
								})
							)
						: null,
					h('p', { style: { margin: '0.25rem 0 0', opacity: 0.75, fontSize: '0.9em' } }, t('prunerThresholdCharsHint'))
				)
			);
		}

		/**
		 * The five fields this card writes, with the type each one must land as.
		 *
		 * `kind` decides the parse: a boolean field may not be written as the string `"true"` on 0.2.0, and the pruner
		 * takes `'auto'` or a number. `default` is what an unset field displays, so the page shows what the plugin will
		 * really do instead of a blank.
		 */
		/** The compaction tuner's fields — what the `tune` row's card shows. */
		const TUNING_CARD_FIELDS = [
			{ key: 'compactionTargetRatio', kind: 'number', default: FIELD_DEFAULTS.compactionTargetRatio },
			{ key: 'compactionRoute', kind: 'text', default: '' },
			{ key: 'autoTuneCompaction', kind: 'boolean', default: FIELD_DEFAULTS.autoTuneCompaction },
			{ key: 'tuneStockDisabledRoutes', kind: 'boolean', default: FIELD_DEFAULTS.tuneStockDisabledRoutes },
			{ key: 'prunerThresholdChars', kind: 'pruner', default: FIELD_DEFAULTS.prunerThresholdChars }
		];

		/**
		 * The trims' own fields — what the `trim` row's card shows.
		 *
		 * These have never been on a card: they are not marked `.volatile()` in the loader schema, and a 0.1.7 form only
		 * carries volatile fields. The `trim` row is its own component now, so its card is the natural place for them;
		 * marking them volatile is what puts them there. The kinds mirror `lib/config.js`: `retainRatio` and
		 * `minTailTokens` are numbers, `targetRatio` a number, the rest flags.
		 */
		const TRIM_CARD_FIELDS = [
			{ key: 'targetRatio', kind: 'number', default: FIELD_DEFAULTS.targetRatio },
			{ key: 'retainRatio', kind: 'number', default: FIELD_DEFAULTS.retainRatio },
			{ key: 'minTailTokens', kind: 'number', default: FIELD_DEFAULTS.minTailTokens },
			{ key: 'reserveOutputTokens', kind: 'number', default: FIELD_DEFAULTS.reserveOutputTokens },
			{ key: 'protectHeadNodes', kind: 'number', default: FIELD_DEFAULTS.protectHeadNodes },
			{ key: 'maxAutoTrimRetries', kind: 'number', default: FIELD_DEFAULTS.maxAutoTrimRetries },
			{ key: 'allowTailTrim', kind: 'boolean', default: FIELD_DEFAULTS.allowTailTrim },
			{ key: 'autoTrim', kind: 'boolean', default: FIELD_DEFAULTS.autoTrim },
			{ key: 'emergencyTrim', kind: 'boolean', default: FIELD_DEFAULTS.emergencyTrim },
			{ key: 'preferInPlacePrune', kind: 'boolean', default: FIELD_DEFAULTS.preferInPlacePrune },
			{ key: 'pruneThresholdChars', kind: 'number', default: FIELD_DEFAULTS.pruneThresholdChars },
			{ key: 'pruneHeadChars', kind: 'number', default: FIELD_DEFAULTS.pruneHeadChars },
			{ key: 'pruneTailChars', kind: 'number', default: FIELD_DEFAULTS.pruneTailChars }
		];

		/** The fields one role's card carries. */
		const CARD_FIELDS = { trim: TRIM_CARD_FIELDS, tuning: TUNING_CARD_FIELDS };

		/** The typed value one field currently holds on the Host, or `undefined` when it holds none. */
		function hostValue(snapshot, key) {
			const value = { ...(snapshot.base ?? {}), ...(snapshot.value ?? {}), ...(snapshot.user ?? {}) };
			return value[key];
		}

		/**
		 * Turn a staged text into the value the field must be written as, or say that nothing needs writing.
		 * @param field - the field descriptor.
		 * @param text - what the control staged.
		 * @param current - the typed value the Host holds.
		 * @returns `{kind: 'set'|'skip'|'invalid', value?}`.
		 */
		function parseEdit(field, text, current) {
			if (field.kind === 'boolean') {
				const on = text === 'true' || text === true;
				const off = text === 'false' || text === false;
				if (!on && !off) return { kind: 'invalid' };
				const value = on;
				return value === current ? { kind: 'skip' } : { kind: 'set', value };
			}
			if (field.kind === 'number') {
				const trimmed = text.trim();
				if (trimmed === '') return { kind: 'invalid' };
				const value = Number(trimmed);
				if (!Number.isFinite(value)) return { kind: 'invalid' };
				return value === current ? { kind: 'skip' } : { kind: 'set', value };
			}
			if (field.kind === 'pruner') {
				const trimmed = text.trim();
				if (trimmed === 'auto') return 'auto' === current ? { kind: 'skip' } : { kind: 'set', value: 'auto' };
				if (trimmed === '0' || trimmed === '') return 0 === current ? { kind: 'skip' } : { kind: 'set', value: 0 };
				const value = Number(trimmed);
				if (!Number.isFinite(value) || value < 0) return { kind: 'invalid' };
				return value === current ? { kind: 'skip' } : { kind: 'set', value };
			}
			return text === current ? { kind: 'skip' } : { kind: 'set', value: text };
		}

		/** The text one field displays: the staged edit, else the Host's value, else the declared default. */
		function displayText(field, staged, snapshot) {
			if (staged !== undefined) return staged;
			const current = hostValue(snapshot, field.key);
			if (current === undefined) return String(field.default);
			if (typeof current === 'object') return '';
			return String(current);
		}

		/**
		 * The staged form: local edits over the composed entry, re-seeded from the Host on every external change.
		 *
		 * A save plans one operation per changed field — a `set` with the **typed** value, nothing for an unchanged one
		 * — and writes them in a single revision-fenced `scope.mutate`. While a draft is open the Host is not allowed to
		 * re-seed over it; a landed write drops the draft explicitly so the next snapshot seeds cleanly.
		 */
		class TrimForm {
			/**
			 * @param scope - the shared form of one composed row.
			 * @param fields - the field descriptors that row's card carries.
			 */
			constructor(scope, fields) {
				this.fields = fields ?? TUNING_CARD_FIELDS;
				this.scope = scope;
				this.draft = null;
				this.baseline = null;
				this.saving = false;
				this.failed = false;
				this.listeners = new Set();
				this.unsubscribe = scope.subscribe(() => this.reseed());
			}

			dispose() {
				if (this.unsubscribe) this.unsubscribe();
				this.unsubscribe = null;
			}

			reseed() {
				// Never clobber an open draft: while the user is typing, an external change (including our own landed
				// write) must not overwrite the text in front of them.
				if (this.draft === null) this.publish();
			}

			publish() {
				for (const listener of this.listeners) listener();
			}

			/** The operations a save would issue, plus whether any field is currently invalid. */
			plan() {
				const snapshot = this.scope.getSnapshot();
				const ops = [];
				let invalid = false;
				for (const field of this.fields) {
					const staged = this.draft?.[field.key];
					if (staged === undefined) continue;
					const parsed = parseEdit(field, staged, hostValue(snapshot, field.key));
					if (parsed.kind === 'invalid') invalid = true;
					else if (parsed.kind === 'set') ops.push({ op: 'set', path: [field.key], value: parsed.value });
				}
				return { ops, invalid };
			}

			snapshot() {
				const snapshot = this.scope.getSnapshot();
				const { invalid } = this.plan();
				const state = {
					available: snapshot.status === 'ready',
					writable: Boolean(snapshot.writable),
					saving: this.saving,
					failed: this.failed,
					dirty: this.draft !== null,
					invalid,
					values: snapshot
				};
				for (const field of this.fields) {
					const text = displayText(field, this.draft?.[field.key], snapshot);
					const current = hostValue(snapshot, field.key);
					state[field.key] = {
						text,
						overridden: current !== undefined,
						invalid: parseEdit(field, text, current).kind === 'invalid'
					};
				}
				return state;
			}

			bind() {
				// The slot renderer reads the card through a `use<Name>` hook, so the store needs `getSnapshot` for the
				// value and `subscribe` for change notification (React consumes it via useSyncExternalStore).
				let current = this.snapshot();
				const listeners = new Set();
				this.listeners.add(() => {
					current = this.snapshot();
					for (const listener of [...listeners]) listener();
				});
				return {
					getSnapshot: () => current,
					subscribe: (listener) => {
						listeners.add(listener);
						return () => listeners.delete(listener);
					}
				};
			}

			edit(field, text) {
				this.baseline ??= this.scope.getSnapshot();
				this.draft ??= {};
				this.draft[field] = text;
				this.failed = false;
				this.publish();
			}

			/** Reset means "drop my edit for this field", not "write an unset": the frame has no use for an unset op. */
			resetField(field) {
				if (this.draft === null) return;
				delete this.draft[field];
				if (Object.keys(this.draft).length === 0) this.draft = null;
				this.failed = false;
				this.publish();
			}

			discard() {
				this.draft = null;
				this.baseline = null;
				this.failed = false;
				this.publish();
			}

			async save() {
				const { ops, invalid } = this.plan();
				if (invalid || ops.length === 0) {
					this.publish();
					return;
				}
				this.saving = true;
				this.publish();
				try {
					const landed = await this.scope.mutate(ops, this.baseline?.revision);
					if (landed) {
						this.draft = null;
						this.baseline = null;
					} else {
						this.failed = true;
					}
				} finally {
					this.saving = false;
					this.publish();
				}
			}

			/** The face the slot registration injects (hooks plus form actions). */
			inject() {
				return {
					hooks: { trimCard: this.bind() },
					edit: (field, text) => this.edit(field, text),
					resetField: (field) => this.resetField(field),
					save: () => this.save(),
					discard: () => this.discard()
				};
			}
		}

		/** Required browser services (cordis fiber inject). */
		const inject = ['slots', 'locale', 'configForms'];

		/**
		 * Mount the card while the Host serves our namespace.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			// Older web hosts (0.1.2/0.1.5) serve `settingsScope` instead of
			// `configForms`; registering nothing beats throwing inside their page.
			if (ctx.configForms === undefined || ctx.slots === undefined || ctx.locale === undefined) return;
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'context-trim: dictionaries');
			// One controller and one keyed entry PER ROW. A keyed slot only ever renders on the row whose key matches,
			// so a single registration bound to the trim row leaves the tune row with no Configure button at all — and
			// nothing is logged when that happens.
			for (const row of ROWS) {
				const controller = new TrimForm(ctx.configForms.get(row.rowId), CARD_FIELDS[row.role]);
				ctx.effect(() => () => controller.dispose(), `${row.rowId}: form subscription`);
				ctx.effect(
					() =>
						ctx.configForms.whileServed([row.rowId], () =>
							ctx.slots.inject('plugins.row.config', () =>
								ctx.slots.register(
									{
										// Matched by `<package>#<row id>`: this is what gives the row its Configure button, and
										// the page then renders us with `view: 'page'` AND the form for that row id. No
										// `label` — a keyed slot takes its heading from the bundle patch, which is why the
										// two rows' module URLs differ (`./cordis.patch.yml` vs `./cordis.tune.yml`): the
										// heading comes from the module, and one file would name both rows the same.
										name: 'plugins.row.config',
										key: rowConfigKey(row.rowId),
										locale: NS,
										inject: () => controller.inject()
									},
									(props) => h(TrimCard, { ...props, row })
								)
							)
						),
					`${row.rowId}: settings page`
				);
			}
		}

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
