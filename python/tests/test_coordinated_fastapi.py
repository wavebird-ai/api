"""Exercise the package-owned FastAPI lifecycle against a synthetic publisher."""

import asyncio
import json
import unittest

from fastapi import Request
from fastapi.responses import Response

from wavebird_publisher import PublisherConfig, PublisherResponse, PublisherServer
from wavebird_publisher.fastapi import create_app


ORIGIN = "https://publisher.example"


async def call(app, path: str, body: dict | None = None, *, session: str = "valid", origin: str = ORIGIN):
    raw = json.dumps(body).encode() if body is not None else b""
    events = []
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": raw, "more_body": False}

    async def send(event):
        events.append(event)

    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
        "method": "GET" if body is None else "POST", "scheme": "https", "path": path,
        "raw_path": path.encode(), "query_string": b"", "root_path": "",
        "server": ("publisher.example", 443), "client": ("127.0.0.1", 1),
        "headers": [(b"host", b"publisher.example"), (b"origin", origin.encode()),
                    (b"sec-fetch-site", b"same-origin"), (b"x-publisher-session", session.encode())],
    }
    await asyncio.wait_for(app(scope, receive, send), timeout=3)
    status = next(event["status"] for event in events if event["type"] == "http.response.start")
    content = b"".join(event.get("body", b"") for event in events if event["type"] == "http.response.body")
    return status, content


class CoordinatedFastApiTests(unittest.TestCase):
    def test_all_formats_one_turn_and_trusted_reports(self):
        calls = []
        generated = []

        def transport(url, body, key, timeout):
            calls.append((url, json.loads(body), key, timeout))
            if "/placements" in url:
                return PublisherResponse(200, {}, b'{"job_id":"job_synthetic","decision":{"fill":false}}')
            return PublisherResponse(200, {}, b"{}")

        def session_id_for_request(request):
            return "server-session" if request.header("x-publisher-session") == "valid" else None

        async def existing_generation(request: Request):
            generated.append(request.method)
            return Response("model result", media_type="text/plain")

        config = PublisherConfig(
            client_id="wbproj_synthetic", server_test_key="sk_test_synthetic_server_only",
            preference_secret="synthetic-preference-secret-32-bytes", public_origins=(ORIGIN,),
            surface_id="assistant", placement_key="default", job_type="chat", locale="en-US",
            timing="during", consent_mode="wavebird_consent", publisher_name="Synthetic",
            publisher_domain="publisher.example", allowed_formats=("banner", "native", "clip"),
            allowed_sizes=((320, 50), (300, 250), (640, 360)), position_hint="between",
            max_width=640, max_height=360,
            authorize=lambda request: session_id_for_request(request) is not None,
        )
        app = create_app(PublisherServer(config, transport), session_id_for_request, existing_generation)
        identity = {"session_id": "server-session", "turn_id": "turn_synthetic"}

        async def scenario():
            self.assertEqual((await call(app, "/api/wavebird/generate", identity, session=""))[0], 401)
            self.assertEqual((await call(app, "/api/wavebird/placement", identity, origin="https://foreign.example"))[0], 403)
            placement = await call(app, "/api/wavebird/placement", {**identity, "allowed_formats": ["native"]})
            self.assertEqual(placement[0], 200)
            self.assertEqual((await call(app, "/api/wavebird/placement", identity))[0], 409)
            self.assertEqual((await call(app, "/api/wavebird/generate", identity)), (200, b"model result"))
            self.assertEqual((await call(app, "/api/wavebird/generate", identity))[0], 409)
            self.assertEqual((await call(app, "/api/wavebird/browser.js"))[0], 200)

        asyncio.run(scenario())
        self.assertEqual(generated, ["POST"])
        placement_calls = [item for item in calls if "/placements" in item[0]]
        self.assertEqual(len(placement_calls), 1)
        self.assertEqual(placement_calls[0][1]["overrides"]["allowed_formats"], ["banner", "native", "clip"])
        self.assertEqual([url.rsplit("/", 1)[-1] for url, _, _, _ in calls if "/generation/" in url],
                         ["started", "finished"])


if __name__ == "__main__":
    unittest.main()
