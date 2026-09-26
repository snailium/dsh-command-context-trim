#!/usr/bin/env python3
"""Minimal OpenAI-compatible mock for isolated dsh previews and drills.

Serves just enough for an instance to boot and answer: a model list, and chat
completions in both shapes a client may ask for — a single JSON body, or the SSE
stream the provider protocol actually expects (`data:` chunks ending in
`finish_reason` and `[DONE]`). Without the streaming shape a real run dies with
"TRANSPORT: Stream ended without finish_reason".

    python3 test/compat/mock-llm.py 8901
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "mock-model"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path.endswith("/models"):
            self._send({"object": "list", "data": [{"id": MODEL, "object": "model"}]})
        else:
            self._send({"error": {"message": f"no route {self.path}"}}, 404)

    def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler API
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length)
        try:
            request = json.loads(raw or b"{}")
        except ValueError:
            request = {}
        if request.get("stream") is True:
            return self._stream()
        self._send(
            {
                "id": "mock-completion",
                "object": "chat.completion",
                "model": MODEL,
                "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "ok"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }
        )

    def _stream(self):
        """Emit the SSE shape the provider protocol requires."""
        events = [
            {"id": "mock-chunk", "object": "chat.completion.chunk", "model": MODEL,
             "choices": [{"index": 0, "delta": {"role": "assistant", "content": "ok"}}]},
            {"id": "mock-chunk", "object": "chat.completion.chunk", "model": MODEL,
             "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
             "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
        ]
        body = "".join(f"data: {json.dumps(event)}\n\n" for event in events) + "data: [DONE]\n\n"
        payload = body.encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1] if len(sys.argv) > 1 else 8901)), Handler).serve_forever()
