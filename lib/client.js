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
		const {
			SettingsForm,
			SettingsFormModel,
			SettingsValueField,
			Switch,
			settingsNumberField,
			settingsTextField
		} = require('@deepseek-ai/dsh-client-ui-primitives');

		/** Dictionary namespace owned by this plugin (any string). */
		const NS = 'settings.context-trim';

		/** Loader entry id; MUST equal the row id our bundle patch declares — and our settings namespace. */
		const ENTRY_ID = 'context-trim';

		/** This package's name; the keyed slot is `<package>#<row id>`. */
		const PACKAGE = 'dsh-command-context-trim';

		/** The key `plugins.row.config` is matched by. Silent when wrong, so it is pinned in a test. */
		const ROW_CONFIG_KEY = `${PACKAGE}#${ENTRY_ID}`;

		/**
		 * The effective value of each card field when the deployment sets none.
		 *
		 * Mirrors `DEFAULTS` in `lib/config.js` (and the values the plugin resolves in code), so an unset field shows
		 * what will really be used instead of a blank. Kept honest by a test rather than by discipline.
		 */
		const FIELD_DEFAULTS = {
			compactionTargetRatio: 0.8,
			compactionRoute: '',
			autoTuneCompaction: false,
			tuneStockDisabledRoutes: false,
			prunerThresholdChars: 'auto'
		};

		/** Pruner modes: the select's three options and the value each one lands. */
		const PRUNER_MODES = [
			{ id: 'disabled', value: '0' },
			{ id: 'auto', value: 'auto' }
		];

		/** English copy. */
		const en = {
			sectionCompaction: 'Compaction',
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
		function TrimCard(props) {
			const { t } = props;
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
			const disabled = !state.writable;
			const valueField = (field, extra) =>
				h(SettingsValueField, {
					id: `plugin-config-context-trim-${field}`,
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
				sectionHeading(t('sectionCompaction')),
				valueField('compactionTargetRatio', { numeric: true }),
				valueField('compactionRoute'),
				switchField({
					id: 'plugin-config-context-trim-auto-tune',
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
					id: 'plugin-config-context-trim-stock-disabled',
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
					{ id: 'plugin-config-context-trim-pruner-threshold', style: { gridColumn: '1 / -1', marginBottom: '0.75rem' } },
					h(
						'div',
						{ style: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' } },
						h('span', { style: { fontWeight: 500 } }, t('prunerThresholdChars')),
						h(
							'select',
							{
								id: 'plugin-config-context-trim-pruner-mode',
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
									id: 'plugin-config-context-trim-pruner-custom',
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
		const CARD_FIELDS = [
			{ key: 'compactionTargetRatio', kind: 'number', default: FIELD_DEFAULTS.compactionTargetRatio },
			{ key: 'compactionRoute', kind: 'text', default: '' },
			{ key: 'autoTuneCompaction', kind: 'boolean', default: FIELD_DEFAULTS.autoTuneCompaction },
			{ key: 'tuneStockDisabledRoutes', kind: 'boolean', default: FIELD_DEFAULTS.tuneStockDisabledRoutes },
			{ key: 'prunerThresholdChars', kind: 'pruner', default: FIELD_DEFAULTS.prunerThresholdChars }
		];

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
			constructor(scope) {
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
				for (const field of CARD_FIELDS) {
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
				for (const field of CARD_FIELDS) {
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
			const controller = new TrimForm(ctx.configForms.get(ENTRY_ID));
			ctx.effect(() => () => controller.dispose(), 'context-trim: form subscription');
			ctx.effect(
				() =>
					ctx.configForms.whileServed([ENTRY_ID], () => {
						return ctx.slots.inject('plugins.row.config', () =>
							ctx.slots.register(
								{
									// A keyed slot, matched by `<package>#<row id>`: this is what gives the row on our bundle's
									// page its Configure button, and the page then renders us with `view: 'page'` **and** the form
									// for that row id. No `label` — a keyed slot takes its heading from the bundle patch.
									name: 'plugins.row.config',
									key: ROW_CONFIG_KEY,
									locale: NS,
									inject: () => controller.inject()
								},
								TrimCard
							)
						)
					})
					,
				'context-trim: settings page'
			);
		}

		exports.NS = NS;
		exports.ENTRY_ID = ENTRY_ID;
		exports.PACKAGE = PACKAGE;
		exports.ROW_CONFIG_KEY = ROW_CONFIG_KEY;
		exports.SLOT_NAME = 'plugins.row.config';
		exports.CARD_FIELDS = CARD_FIELDS;
		exports.FIELD_DEFAULTS = FIELD_DEFAULTS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
