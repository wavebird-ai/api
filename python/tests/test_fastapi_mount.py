"""The package adds routes to an existing publisher app without replacing its hooks."""

import unittest

from fastapi import FastAPI

from wavebird_publisher.fastapi import mount_fastapi


class FastApiMountTests(unittest.TestCase):
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
