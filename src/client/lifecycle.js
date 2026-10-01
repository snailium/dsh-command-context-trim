import { CARD_FIELDS, NS, ROWS, rowConfigKey } from './constants.js';
import { en, zh } from './locales.js';
import { TrimForm } from './form.js';
import { TrimCard } from './components.js';

/** Required browser services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms'];

/**
 * Mount the card while the Host serves our namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx) {
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
		// Matched by `<package>#<row id>`, and no `label` — a keyed slot takes its heading from the bundle patch,
		// so the two rows' module specifiers differ: a row's heading comes from its module, and one module for both
		// rows would name them identically on the Plugins page.
		ctx.effect(
			() =>
				ctx.configForms.whileServed([row.rowId], () =>
					ctx.slots.inject('plugins.row.config', () =>
						ctx.slots.register(
							{
								name: 'plugins.row.config',
								key: rowConfigKey(row.rowId),
								locale: NS,
								inject: () => controller.inject()
							},
							(props) => h(TrimCard, { ...props, row })
						)
					)
				),
			`${row.rowId}: form card`
		);
	}
}
