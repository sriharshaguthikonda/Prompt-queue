import json
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError

import native_host


class FakeResponse:
    def __init__(self, status, body, content_type="application/json"):
        self.status = status
        self._body = body
        self.headers = {"Content-Type": content_type}

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class FakeOpener:
    def __init__(self, response):
        self.response = response
        self.requests = []

    def __call__(self, request, timeout):
        self.requests.append((request, timeout))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class NativeHostMemoryTests(unittest.TestCase):
    def make_monitor(self, response):
        opener = FakeOpener(response)
        monitor = native_host.TranscriptionMonitor(
            memory_base_url="http://127.0.0.1:5599",
            http_open=opener,
        )
        return monitor, opener

    def make_token_file(self, token="test-token-value"):
        tmp = tempfile.TemporaryDirectory()
        path = Path(tmp.name) / "local_token"
        path.write_text(token, encoding="utf-8")
        return tmp, path

    def test_memory_pack_browser_posts_json_with_token_from_file(self):
        token_tmp, token_path = self.make_token_file()
        self.addCleanup(token_tmp.cleanup)
        monitor, opener = self.make_monitor(
            FakeResponse(200, b'{"markdown":"pack","items":[]}')
        )

        response = monitor.handle_message({
            "type": "memory_pack_browser",
            "token_path": str(token_path),
            "query": "private prompt text",
            "project": "global",
        })

        self.assertTrue(response["ok"])
        self.assertEqual(response["status"], 200)
        self.assertEqual(response["body"], {"markdown": "pack", "items": []})
        request, timeout = opener.requests[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:5599/pack/browser")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.headers["X-memory-token"], "test-token-value")
        self.assertEqual(timeout, 10)
        self.assertEqual(
            json.loads(request.data.decode("utf-8")),
            {"query": "private prompt text", "project": "global"},
        )

    def test_memory_get_uses_encoded_memory_id(self):
        token_tmp, token_path = self.make_token_file()
        self.addCleanup(token_tmp.cleanup)
        monitor, opener = self.make_monitor(FakeResponse(200, b'{"id":"mem/a b"}'))

        response = monitor.handle_message({
            "type": "memory_get",
            "token_path": str(token_path),
            "memory_id": "mem/a b",
        })

        self.assertTrue(response["ok"])
        request, _timeout = opener.requests[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:5599/memory/mem%2Fa%20b")
        self.assertEqual(request.get_method(), "GET")

    def test_rejects_write_like_memory_operation(self):
        monitor, opener = self.make_monitor(FakeResponse(200, b"{}"))

        response = monitor.handle_message({"type": "memory_remember", "content": "nope"})

        self.assertFalse(response["ok"])
        self.assertEqual(response["type"], "error")
        self.assertEqual(response["code"], "UNSUPPORTED_MEMORY_OPERATION")
        self.assertEqual(opener.requests, [])

    def test_http_error_is_sanitized(self):
        token_tmp, token_path = self.make_token_file()
        self.addCleanup(token_tmp.cleanup)
        error = HTTPError(
            "http://127.0.0.1:5599/pack/browser",
            401,
            "Unauthorized",
            {"Content-Type": "application/json"},
            None,
        )
        monitor, _opener = self.make_monitor(error)

        response = monitor.handle_message({
            "type": "memory_pack_browser",
            "token_path": str(token_path),
            "query": "private prompt text",
        })

        self.assertFalse(response["ok"])
        self.assertEqual(response["status"], 401)
        self.assertEqual(response["message"], "Memory bridge request failed")


if __name__ == "__main__":
    unittest.main()
