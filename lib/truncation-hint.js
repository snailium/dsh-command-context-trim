/**
 * A hint when the provider cut a reply short.
 *
 * A reply that ends on a length stop is not an error: the request succeeded, the
 * provider simply stopped generating. The automatic trim listens for
 * `CONTEXT_WINDOW_EXCEEDED`, so it never sees this case — and the user gets a
 * turn that is silently missing its answer.
 *
 * The plugin does not trim here. A length stop has two very different causes, and
 * only one of them is the context: the provider may have cut the generation at its
 * own output allowance, or it may have cut it because the request no longer fit.
 * The hint states the two numbers that tell them apart — how much the request
 * carried, and how much room the window had — and lets the user decide. The hint
 * is written into the session, because that is where the user is looking.
 *
 * @module dsh-command-context-trim/truncation-hint
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { TRIM_SOURCE_KIND } from './apply.js';
import { budgetFor } from './config.js';
import { requestPricer } from './trim-session.js';

/** Plugin name written into the hint message's source marker. */
const HINT_PLUGIN = 'dsh-command-context-trim';

/** The source kind a v4 session requires from a third-party producer. */
const HINT_SOURCE = Object.freeze({ kind: TRIM_SOURCE_KIND, plugin: HINT_PLUGIN });

/**
 * Whether the provider ended this reply on its output limit.
 *
 * The stop reason travels in the finish chunk of the event's stream, in two
 * shapes depending on the adapter: the normalised `reason.kind`, and the raw
 * provider's `stopReason` inside the replay state.
 *
 * @param event - the `assistant/message` event.
 * @returns the stop reason, or undefined when the reply ended normally.
 */
export function stopReasonOf(event) {
	for (const entry of event?.data?.stream ?? []) {
		const chunk = entry?.chunk;
		if (chunk?.type !== 'finish') continue;
		const reason = chunk?.reason?.kind;
		if (reason === 'max-tokens') return 'max-tokens';
		const raw = chunk?.replayState?.response?.stopReason;
		if (raw === 'length') return 'max-tokens';
	}
	return undefined;
}

/**
 * The context window the last request under this route declared.
 * @param session - session whose log is read.
 * @returns the window in tokens, or undefined when the log records none.
 */
function declaredWindow(session) {
	const window = session.requestContext?.()?.contextWindow;
	return Number.isInteger(window) && window > 0 ? window : undefined;
}

/**
 * The output allowance the last request under this route declared.
 * @param session - session whose log is read.
 * @returns the allowance in tokens, or undefined when the header records none.
 */
function declaredAllowance(session) {
	const maxTokens = session.requestHeader()?.config?.maxTokens;
	return Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : undefined;
}

/**
 * Build the hint's text.
 *
 * The numbers are the whole point: the request's real size against the window,
 * and the room the window had left for the reply. A request that is far below
 * the window was not stopped by the context, and saying so is more useful than
 * suggesting a trim that would free nothing.
 *
 * @param params - the measured numbers.
 * @returns the message text.
 */
function hintText({ total, window, budget, allowance, produced }) {
	const allowanceText =
		allowance === undefined
			? ''
			: ` It was allowed ${allowance} tokens of output and produced${produced > 0 ? ` ${produced}` : ' none'}.`;
	if (window === undefined) {
		return (
			`[context-trim] the provider cut the previous reply short (a length stop). The request carried ` +
			`~${total} tokens.${allowanceText} Run /trim to shrink the context, or raise the model's output allowance.`
		);
	}
	if (total <= budget) {
		return (
			`[context-trim] the provider cut the previous reply short (a length stop). The request carried ` +
			`~${total} tokens of a ${window}-token window, within the ${budget}-token budget, so the context is not ` +
			`what stopped it.${allowanceText} The provider's own output limit is the likely cause.`
		);
	}
	return (
		`[context-trim] the provider cut the previous reply short (a length stop). The request carried ` +
		`~${total} tokens of a ${window}-token window, over the ${budget}-token budget.${allowanceText} ` +
		`Run /trim to shrink the context.`
	);
}

/**
 * Register the truncation hint.
 *
 * One hint per episode: once the provider has cut a reply, the next replies in
 * the same stretch are cut for the same reason, and a note per reply would bury
 * the conversation. A reply that ends normally clears the episode.
 *
 * @param ctx - plugin context (token meter, logger).
 * @param rawConfig - the row's raw configuration; re-read per event, like the automatic trim does.
 * @returns a disposer that stops listening.
 */
export function registerTruncationHint(ctx, rawConfig) {
	const hinted = new WeakSet();
	const listener = (session, event) => {
		if (event?.type !== 'assistant/message') return;
		if (stopReasonOf(event) === undefined) {
			hinted.delete(session);
			return;
		}
		if (hinted.has(session)) return;
		hinted.add(session);
		try {
			const config = typeof rawConfig === 'function' ? rawConfig() : rawConfig;
			appendHint(ctx, session, event, config);
		} catch (error) {
			log(ctx, 'warn', `could not write the truncation hint (${describe(error)}); the reply was still cut short`);
		}
	};
	ctx.on('session/event', listener);
	return () => {
		ctx.off('session/event', listener);
	};
}

/**
 * Write the hint into the session.
 * @param ctx - plugin context (token meter).
 * @param session - session the hint belongs to.
 * @param event - the truncated `assistant/message` event.
 * @param config - resolved configuration.
 */
function appendHint(ctx, session, event, config) {
	const header = session.requestHeader();
	if (header === undefined) return;
	const pricer = requestPricer(ctx, session, header);
	const measurement = ctx.tokenMeter.measure(session, header);
	const total = pricer.view(measurement).totalTokens;
	const window = declaredWindow(session);
	const allowance = declaredAllowance(session);
	const produced = Number(event?.data?.usage?.outputTokens ?? 0);
	let budget;
	try {
		budget = window === undefined ? undefined : budgetFor(window, config, allowance);
	} catch {
		budget = undefined;
	}
	const text = hintText({ total, window, budget, allowance, produced });
	session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: HINT_SOURCE }), {
		surfaceOp: 'append'
	});
	log(ctx, 'warn', `the provider cut a reply short: ${text}`);
}

/** Log through the context logger when it is available. */
function log(ctx, level, message) {
	const logger = ctx.logger;
	if (logger?.[level] === undefined) return;
	logger[level](`context-trim: ${message}`);
}

/** Describe an error without leaking a stack into the log. */
function describe(error) {
	return error instanceof Error ? error.message : String(error);
}
