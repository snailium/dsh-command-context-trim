import { formLabels } from './locales.js';
import { asBoolean, effective, prunerModeOf, sectionHeading } from './helpers.js';
import { PRUNER_MODES } from './constants.js';

/**
 * A switch, because the shipped primitives ship none.
 *
 * `button[role=switch]` keeps it keyboard-operable and announceable, and the click stages the same boolean text
 * the text field used to.
 * @param props - id, label, hint (React nodes), checked, disabled, read/write copy and handlers.
 * @returns the field markup.
 */
export function switchField(props) {
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
export function trimCardBody({ props, t, state, actions }) {
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

export function TrimCard(props) {
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
	// A row's description on the Plugins page falls back to THIS string when the row declares no `meta`
	// (`description ?? renderSlot("plugins.row.config", { view: "summary" }, …)`), so it is per-registration. The
	// trims and the tuner are different components and must not share one line here.
	if (props.view === 'summary') return t(role === 'tuning' ? 'tuneDescription' : 'description');
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
