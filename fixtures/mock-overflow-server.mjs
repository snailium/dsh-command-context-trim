/**
 * A test fixture, not runtime code: it binds 127.0.0.1 and is never imported by the
 * plugin. It lives in `fixtures/` rather than under `test/` for two reasons: `node --test`
 * executes every JavaScript file under `test/` (a server there would hang the suite), and
 * a repository-wide scan of *runtime* source should see only `lib/`, where the plugin's
 * single file-system touch is the `/trim preset` patch write and nothing opens a socket,
 * spawns a process or reads a credential.
 * Stateful mock OpenAI endpoint for the automatic-trim end-to-end check.
 *
 * It enforces a REAL context limit that is LOWER than the contextWindow the
 * harness is told about, and answers the first TOOL_STEPS requests with a tool
 * call so one headless turn keeps looping steps and grows the conversation until
 * the real limit is hit — the "context wall" without needing a model switch.
 *
 *   request 1..N : assistant text + tool-call(bash)   → the turn continues
 *                  (TOOL_COMMAND picks what the tool runs; use `seq 1 40000` for a
 *                   single oversized tool result, which exercises in-place slimming)
 *   request >L   : 400 with llama.cpp-style overflow wording
 *   after trim   : the request fits again → final text, turn completes
 *
 * Env: PORT, TOKEN_LIMIT, TOOL_STEPS, FILLER_CHARS
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4185);
const TOKEN_LIMIT = Number(process.env.TOKEN_LIMIT ?? 12000);
const TOOL_STEPS = Number(process.env.TOOL_STEPS ?? 4);
const FILLER_CHARS = Number(process.env.FILLER_CHARS ?? 48000);
// Command the mock asks the agent's bash tool to run. Point it at something with a
// large output (e.g. `seq 1 40000`) to produce a single oversized TOOL RESULT
// instead of a large assistant message.
const TOOL_COMMAND = process.env.TOOL_COMMAND ?? 'echo filler';
// The harness bash tool requires a `description`; a call without one fails argument
// validation and returns a tiny error result instead of any output.
const TOOL_DESCRIPTION = process.env.TOOL_DESCRIPTION ?? 'run a command';


function estimateTokens(body) {
	let chars = typeof body.system === 'string' ? body.system.length : 0;
	chars += body.tools === undefined ? 0 : JSON.stringify(body.tools).length;
	for (const message of body.messages ?? []) {
		if (typeof message.content === 'string') chars += message.content.length;
		else chars += JSON.stringify(message.content ?? '').length;
	}
	return Math.ceil(chars / 4);
}

let accepted = 0;
const filler = (index) =>
	`Step ${index}. ` + 'Filler paragraph that makes the conversation grow past the endpoint limit. '.repeat(Math.ceil(FILLER_CHARS / 120));

const json = (res, status, payload) => {
	const body = JSON.stringify(payload);
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
	res.end(body);
};

const chunk = (body) => ({
	id: 'chatcmpl-mock',
	object: 'chat.completion.chunk',
	created: Math.floor(Date.now() / 1000),
	model: body.model ?? 'mock-1'
});

const server = createServer((req, res) => {
	let raw = '';
	req.on('data', (c) => {
		raw += c;
	});
	req.on('end', () => {
		if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
			json(res, 200, { object: 'list', data: [{ id: 'mock-1', object: 'model', created: 0, owned_by: 'mock' }] });
			return;
		}
		if (!req.url.startsWith('/v1/chat/completions')) {
			json(res, 404, { error: { message: `no route ${req.method} ${req.url}`, type: 'invalid_request_error', code: 404 } });
			return;
		}
		let body;
		try {
			body = JSON.parse(raw);
		} catch {
			json(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error', code: 400 } });
			return;
		}
		const tokens = estimateTokens(body);
		if (tokens > TOKEN_LIMIT) {
			process.stdout.write(`[mock] REFUSE ~${tokens} tokens > ${TOKEN_LIMIT} (messages=${body.messages?.length ?? 0})\n`);
			json(res, 400, {
				error: {
					code: 400,
					message: `request (${tokens} tokens) exceeds the available context size (${TOKEN_LIMIT} tokens), try increasing the context size`,
					type: 'invalid_request_error'
				}
			});
			return;
		}
		accepted += 1;
		const served = accepted;
		const useTool = accepted <= TOOL_STEPS;
		// Only the FIRST accepted call grows the conversation (a huge assistant
		// message); every later step stays small, so a single trim is enough and the
		// turn finishes without a second wall hit.
		const content = useTool ? (accepted === 1 ? filler(1) : `Step ${accepted} done.`) : 'All steps are done; the turn can finish.';
		process.stdout.write(
			`[mock] ACCEPT ~${tokens} tokens (call #${accepted}, ${useTool ? 'tool-call' : 'final text'}, messages=${body.messages?.length ?? 0})\n`
		);
		const message = useTool
			? {
					role: 'assistant',
					content,
					tool_calls: [
						{
							id: `call-${served}`,
							type: 'function',
							function: { name: 'bash', arguments: JSON.stringify({ command: TOOL_COMMAND, description: TOOL_DESCRIPTION }) }
						}
					]
				}
			: { role: 'assistant', content };
		if (body.stream !== true) {
			json(res, 200, {
				id: 'chatcmpl-mock',
				object: 'chat.completion',
				created: Math.floor(Date.now() / 1000),
				model: body.model ?? 'mock-1',
				choices: [{ index: 0, message, finish_reason: useTool ? 'tool_calls' : 'stop' }],
				usage: { prompt_tokens: tokens, completion_tokens: Math.ceil(content.length / 4), total_tokens: tokens + Math.ceil(content.length / 4) }
			});
			return;
		}
		res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
		const base = chunk(body);
		const first = useTool
			? { role: 'assistant', content, tool_calls: [{ index: 0, id: `call-${served}`, type: 'function', function: { name: 'bash', arguments: '' } }] }
			: { role: 'assistant', content };
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: first, finish_reason: null }] })}\n\n`);
		if (useTool) {
			res.write(
				`data: ${JSON.stringify({
					...base,
					choices: [
						{
							index: 0,
							delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: TOOL_COMMAND, description: TOOL_DESCRIPTION }) } }] },
							finish_reason: null
						}
					]
				})}\n\n`
			);
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
		} else {
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
		}
		res.write(
			`data: ${JSON.stringify({
				...base,
				choices: [],
				usage: { prompt_tokens: tokens, completion_tokens: Math.ceil(content.length / 4), total_tokens: tokens + Math.ceil(content.length / 4) }
			})}\n\n`
		);
		res.write('data: [DONE]\n\n');
		res.end();
	});
});

server.listen(PORT, '127.0.0.1', () => {
	process.stdout.write(`[mock] listening on http://127.0.0.1:${PORT}/v1 limit=${TOKEN_LIMIT} toolSteps=${TOOL_STEPS} filler=${FILLER_CHARS}\n`);
});
