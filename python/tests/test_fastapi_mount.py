"""The package adds routes to an existing publisher app without replacing its hooks."""

import asyncio
import unittest

from fastapi import FastAPI, Request

from wavebird_publisher.fastapi import _bounded_body, mount_fastapi


class FastApiMountTests(unittest.TestCase):
    def test_oversized_bodies_stop_before_auth_or_upstream_on_all_post_routes(self):
        app = mount_fastapi(FastAPI(), None, lambda request: None, lambda request: None)

        async def scenario(path: str, *, declared: bool):
            events = []
            reads = 0
            chunks = [b"x" * 8192, b"x" * 8193]

            async def receive():
                nonlocal reads
                reads += 1
                if reads > len(chunks):
                    raise AssertionError("oversized request continued reading")
                return {"type": "http.request", "body": chunks[reads - 1], "more_body": True}

            async def send(event):
                events.append(event)

            scope = {
                "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
                "http_version": "1.1", "method": "POST", "scheme": "https",
                "path": path, "raw_path": path.encode(), "query_string": b"", "root_path": "",
                "server": ("publisher.example", 443), "client": ("127.0.0.1", 1),
                "headers": [(b"host", b"publisher.example")] +
                           ([(b"content-length", b"16385")] if declared else []),
            }
            await asyncio.wait_for(app(scope, receive, send), timeout=3)
            self.assertEqual(next(event["status"] for event in events if event["type"] == "http.response.start"), 413)
            self.assertEqual(reads, 0 if declared else 2)

        async def all_routes():
            for path in ("/api/wavebird/placement", "/api/wavebird/consent", "/api/wavebird/generate"):
                await scenario(path, declared=False)
                await scenario(path, declared=True)

        asyncio.run(all_routes())

    def test_bounded_body_is_still_available_to_existing_generation_handler(self):
        raw = b'{"turn_id":"turn_one"}'

        async def scenario():
            delivered = False

            async def receive():
                nonlocal delivered
                if delivered:
                    raise AssertionError("body should be cached")
                delivered = True
                return {"type": "http.request", "body": raw, "more_body": False}

            request = Request({"type": "http", "headers": [], "method": "POST"}, receive)
            self.assertEqual(await _bounded_body(request), raw)
            self.assertEqual(await request.body(), raw)

        asyncio.run(scenario())

    def test_preserves_existing_app_routes_and_middleware(self):
        app = FastAPI()

        @app.get("/existing")
        def existing():
            return {"ok": True}

        @app.middleware("http")
        async def existing_middleware(request, call_next):
            return await call_next(request)

        original_route = next(route for route in app.routes if route.path == "/existing")
        original_middleware = tuple(app.user_middleware)

        result = mount_fastapi(app, None, lambda request: None, lambda request: None)

        self.assertIs(result, app)
        self.assertIs(next(route for route in app.routes if route.path == "/existing"), original_route)
        self.assertEqual(tuple(app.user_middleware), original_middleware)
        self.assertEqual(
            {route.path for route in app.routes if route.path.startswith("/api/wavebird/")},
            {"/api/wavebird/browser.js", "/api/wavebird/placement",
             "/api/wavebird/consent", "/api/wavebird/generate"},
        )

    def test_duplicate_mount_or_host_route_fails_before_modifying_app(self):
        app = FastAPI()

        @app.post("/api/wavebird/generate")
        def existing():
            return None

        original_routes = tuple(app.routes)
        with self.assertRaisesRegex(ValueError, "wavebird_route_conflict"):
            mount_fastapi(app, None, lambda request: None, lambda request: None)
        self.assertEqual(tuple(app.routes), original_routes)


if __name__ == "__main__":
    unittest.main()
