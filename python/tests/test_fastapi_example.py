"""The copied FastAPI adapter keeps project, session and Origin checks intact."""

import asyncio
import json
import unittest
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import Response

from examples.fastapi_app.app import create_app
from wavebird_publisher import PublisherConfig, PublisherResponse, PublisherServer


def candidate(origin: str, project: str, host_app: FastAPI | None = None):
    calls: list[dict] = []
    generations: list[str] = []

    def authorize(request):
        return request.header("x-publisher-session") == "real-session"

    def transport(url, body, key, timeout):
        assert url == "https://api.wavebird.ai/v1/placements?wait_ms=1500"
        assert key == "sk_test_synthetic_server_only" and timeout == 5
        calls.append(json.loads(body))
        return PublisherResponse(200, {"Content-Type": "application/json"}, b'{"decision":{"fill":false}}')

    config = PublisherConfig(
        client_id=project,
        server_test_key="sk_test_synthetic_server_only",
        preference_secret="synthetic-preference-secret-32-bytes",
        public_origins=(origin,),
        surface_id="assistant", placement_key="default", job_type="chat", locale="en-US",
        timing="during", consent_mode="wavebird_consent", publisher_name="Synthetic Publisher",
        publisher_domain=origin.split("://", 1)[1], allowed_formats=("banner",),
        allowed_sizes=((320, 50),), position_hint="between", max_width=320, max_height=50,
        authorize=authorize,
    )

    async def generate(request: Request) -> Response:
        generations.append(str(request.url))
        return Response("model result", media_type="text/plain")

    return create_app(PublisherServer(config, transport), generate,
                      lambda request: "own-session" if request.header("x-publisher-session") == "real-session" else None,
                      host_app=host_app), calls, generations


def call(app, origin: str, path: str, headers: dict[str, str], payload: dict | None = None):
    parsed = urlsplit(origin)
    body = json.dumps(payload).encode() if payload is not None else b""
    events: list[dict] = []
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
        "method": "POST", "scheme": parsed.scheme, "path": path, "raw_path": path.encode(),
        "query_string": b"", "root_path": "", "server": (parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)),
        "client": ("127.0.0.1", 1),
        "headers": [(b"host", parsed.netloc.encode()), *((name.lower().encode(), value.encode()) for name, value in headers.items())],
    }

    async def invoke():
        delivered = False

        async def receive():
            nonlocal delivered
            if delivered:
                return {"type": "http.disconnect"}
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}

        async def send(event):
            events.append(event)

        await app(scope, receive, send)

    asyncio.run(asyncio.wait_for(invoke(), timeout=3))
    status = next(event["status"] for event in events if event["type"] == "http.response.start")
    content = b"".join(event.get("body", b"") for event in events if event["type"] == "http.response.body")
    return status, content


class FastApiExampleTests(unittest.TestCase):
    def test_example_mount_preserves_existing_host_route(self):
        host = FastAPI()

        @host.post("/health")
        async def health():
            return Response("host ready")

        app, _, _ = candidate("https://publisher.example", "wbproj_secure", host)
        self.assertIs(app, host)
        self.assertEqual(call(app, "https://publisher.example", "/health", {})[1], b"host ready")

    def test_two_publishers_each_stay_in_their_own_project(self):
        for origin, project in (
            ("https://first.example", "wbproj_first"),
            ("http://localhost:4173", "wbproj_second"),
        ):
            with self.subTest(origin=origin):
                app, calls, generations = candidate(origin, project)
                headers = {"origin": origin, "x-publisher-session": "real-session"}
                identity = {"session_id": "own-session", "turn_id": "turn_one"}
                status, body = call(app, origin, "/api/wavebird/placement", headers, identity)
                self.assertEqual(status, 200)
                self.assertFalse(json.loads(body)["decision"]["fill"])
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0]["client_id"], project)
                self.assertEqual(call(app, origin, "/api/wavebird/generate", headers, identity)[1], b"model result")
                self.assertEqual(len(generations), 1)

    def test_auth_origin_and_gpc_fail_closed_without_upstream_or_model(self):
        app, calls, generations = candidate("https://publisher.example", "wbproj_secure")
        payload = {"session_id": "own-session", "turn_id": "turn_one"}
        base = {"origin": "https://publisher.example"}
        self.assertEqual(call(app, "https://publisher.example", "/api/wavebird/placement", base, payload)[0], 401)
        self.assertEqual(call(app, "https://publisher.example", "/api/wavebird/generate", base, payload)[0], 401)
        authorized = {**base, "x-publisher-session": "real-session"}
        self.assertEqual(call(app, "https://publisher.example", "/api/wavebird/placement", {**authorized, "origin": "https://foreign.example"}, payload)[0], 403)
        self.assertEqual(call(app, "https://publisher.example", "/api/wavebird/generate", {**authorized, "origin": "https://foreign.example"}, payload)[0], 403)
        self.assertEqual(call(app, "https://publisher.example", "/api/wavebird/placement", {**authorized, "sec-gpc": "1"}, payload)[0], 403)
        self.assertEqual(calls, [])
        self.assertEqual(generations, [])
        self.assertEqual(call(app, "https://publisher.example", "/api/wavebird/generate", {**authorized, "sec-gpc": "1"}, payload)[0], 200)
        self.assertEqual(len(generations), 1, "privacy denial must not block the publisher's own model")


if __name__ == "__main__":
    unittest.main()
