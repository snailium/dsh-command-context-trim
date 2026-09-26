/**
 * `/trim` settings card — browser half.
 *
 * The Plugins page renders the intersection of two ledgers: the settings namespaces
 * the Host reports, and the cards a browser bundle registers under the same key. The
 * key is the **loader entry id** (`context-trim`, the row id our bundle patch
 * declares), and the Host only reports an entry as a namespace when its schema
 * carries `.volatile()` fields — which is why exactly the two tuning fields are
 * marked volatile in `./index.js` and why this card shows exactly those two.
 *
 * This file is a **classic script**, not an ES module: the harness serves client
 * halves into a page that expects every bundle to register itself through
 * `window.__ModuleLoader__.load({ id, factory })`, with `id` equal to the package
 * name. A plain ESM file is fetched and then rejected with "loaded without
 * registering … via __ModuleLoader__.load", which is exactly how this card failed
 * the first time. Both `react` and `@deepseek-ai/dsh-client-ui-primitives` are module
 * table seeds, so `require` reaches them.
 *
 * The card renders only the form **body**: the platform supplies the frame (the title
 * from the slot's `label`, the disclosure, the artwork). Drawing our own card around
 * it produces a doubled, mis-styled card with a header button that swallows the
 * platform's clicks.
 *
 * Verified against dsh 0.1.7-rc.2. On 0.1.2/0.1.5 web hosts `configForms` does not
 * exist; the module detects that and registers nothing rather than breaking their
 * Plugins page.
 */
window.__ModuleLoader__.load({
	id: 'dsh-command-context-trim',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const { createElement: h } = require('react');
		const {
			SettingsForm,
			SettingsFormModel,
			SettingsValueField,
			settingsNumberField,
			settingsTextField
		} = require('@deepseek-ai/dsh-client-ui-primitives');

		/** Dictionary namespace owned by this plugin (any string). */
		const NS = 'settings.context-trim';

		/** Loader entry id; MUST equal the row id our bundle patch declares. */
		const ENTRY_ID = 'context-trim';

		/** English copy. */
		const en = {
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
		 * The card: the row's one-liner, or the shared settings form.
		 * @param props - view kind, locale reader, staged-form snapshot and its actions.
		 * @returns the one-liner for `view === 'summary'`, the form body otherwise.
		 */
		function TrimCard(props) {
			const { t } = props;
			const state = props.useTrimCard((snapshot) => snapshot);
			if (props.view === 'summary') return t('description');
			const disabled = !state.writable;
			return h(
				SettingsForm,
				{ labels: formLabels(t), state, onSave: props.save, onDiscard: props.discard },
				h(SettingsValueField, {
					id: 'plugin-config-context-trim-ratio',
					label: t('compactionTargetRatio'),
					hint: t('compactionTargetRatioHint'),
					overriddenLabel: t('overridden'),
					resetLabel: t('reset'),
					invalidLabel: t('invalidNumber'),
					numeric: true,
					disabled,
					...state.compactionTargetRatio,
					onEdit: (text) => props.edit('compactionTargetRatio', text),
					onReset: () => props.resetField('compactionTargetRatio')
				}),
				h(SettingsValueField, {
					id: 'plugin-config-context-trim-route',
					label: t('compactionRoute'),
					hint: t('compactionRouteHint'),
					overriddenLabel: t('overridden'),
					resetLabel: t('reset'),
					invalidLabel: t('invalidNumber'),
					disabled,
					...state.compactionRoute,
					onEdit: (text) => props.edit('compactionRoute', text),
					onReset: () => props.resetField('compactionRoute')
				})
			);
		}

		/** Bridges the entry's shared configuration form onto this card's staged form. */
		class TrimCardController {
			/**
			 * @param scope - the shared form of the composed `context-trim` entry.
			 */
			constructor(scope) {
				this.form = new SettingsFormModel(scope, [
					settingsNumberField('compactionTargetRatio'),
					settingsTextField('compactionRoute')
				]);
				this.store = this.form.bind(() => this.projection());
			}

			/** One staged-form snapshot for the component. */
			projection() {
				return {
					...this.form.shell(),
					compactionTargetRatio: this.form.field('compactionTargetRatio'),
					compactionRoute: this.form.field('compactionRoute')
				};
			}

			/** The face the slot registration injects (hooks plus form actions). */
			inject() {
				return { hooks: { trimCard: this.store }, ...this.form.actions() };
			}

			/** Release the form subscription. */
			dispose() {
				this.form.dispose();
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
			const controller = new TrimCardController(ctx.configForms.get(ENTRY_ID));
			ctx.effect(() => () => controller.dispose(), 'context-trim: form subscription');
			ctx.effect(
				() =>
					ctx.configForms.whileServed([ENTRY_ID], () =>
						ctx.slots.inject('plugins.item', () =>
							ctx.slots.register(
								{
									name: 'plugins.item',
									id: ENTRY_ID,
									order: 20,
									label: () => t('title'),
									locale: NS,
									inject: () => controller.inject()
								},
								TrimCard
							)
						)
					),
				'context-trim: settings page'
			);
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
