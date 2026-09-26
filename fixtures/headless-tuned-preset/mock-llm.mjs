#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible mock model for the headless drill — Node only, so the drill
 * needs neither python3 nor any other runtime beyond the Node that already runs dsh.
 *
 * Serves a model list plus chat completions in both shapes: a single JSON body, and the
 * SSE stream the provider protocol expects (`data:` chunks ending in `finish_reason` and
 * `[DONE]`). Without the streaming shape a real run dies with
 * "TRANSPORT: Stream ended without finish_reason".
 *
 *   node mock-llm.mjs [port]      # default 8902
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8902);
const MODEL = 'mock-model';

function sendJson(response, payload) {
	const body = Buffer.from(JSON.stringify(payload));
	response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) });
	response.end(body);
}

const server = createServer((request, response) => {
	if (request.method === 'GET' && (request.url ?? '').endsWith('/models')) {
		sendJson(response, { object: 'list', data: [{ id: MODEL, object: 'model' }] });
		return;
	}
	let body = '';
	request.on('data', (chunk) => (body += chunk));
	request.on('end', () => {
		let parsed = {};
		try {
			parsed = JSON.parse(body.length === 0 ? '{}' : body);
		} catch {
			parsed = {};
		}
		if (parsed.stream === true) {
			response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
			response.write(
				`data: ${JSON.stringify({ id: 'mock-chunk', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] })}\n\n`
			);
			response.write(
				`data: ${JSON.stringify({
					id: 'mock-chunk',
					object: 'chat.completion.chunk',
					model: MODEL,
					choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
				})}\n\n`
			);
			response.end('data: [DONE]\n\n');
			return;
		}
		sendJson(response, {
			id: 'mock-completion',
			object: 'chat.completion',
			model: MODEL,
			choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
		});
	});
});
server.listen(port, '127.0.0.1', () => process.stderr.write(`mock-llm: listening on 127.0.0.1:${port}\n`));
