#!/usr/bin/env python3
"""Minimal OpenAI-compatible mock for isolated dsh previews.

Serves just enough for a preview instance to boot and answer: a model list and a
streaming-free chat completion. It exists so `start-isolated-dsh.sh serve` has a
provider to point at; a card render needs no model at all, so this mock only has to
keep the route healthy.

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
        self.rfile.read(length)
        self._send(
            {
                "id": "mock-completion",
                "object": "chat.completion",
                "model": MODEL,
                "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "ok"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }
        )

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1] if len(sys.argv) > 1 else 8901)), Handler).serve_forever()
