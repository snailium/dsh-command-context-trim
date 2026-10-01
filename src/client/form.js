import { TUNING_CARD_FIELDS } from './constants.js';
import { hostValue, parseEdit, displayText } from './helpers.js';

/**
 * The staged form: local edits over the composed entry, re-seeded from the Host on every external change.
 *
 * A save plans one operation per changed field — a `set` with the **typed** value, nothing for an unchanged one
 * — and writes them in a single revision-fenced `scope.mutate`. While a draft is open the Host is not allowed to
 * re-seed over it; a landed write drops the draft explicitly so the next snapshot seeds cleanly.
 */
export class TrimForm {
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
