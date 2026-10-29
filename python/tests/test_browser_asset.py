import unittest

from examples.fastapi_app.app import create_app
from wavebird_publisher import browser_module_bytes
from wavebird_publisher.fastapi import create_app as create_coordinated_app


class BrowserAssetTests(unittest.TestCase):
    def test_exact_wheel_browser_module_served_by_fastapi_example(self):
        asset = browser_module_bytes()
        self.assertIn(b"export function mountWavebirdPython", asset)
        self.assertIn(b"/v1/render.js", asset)
        self.assertIn(b"placementAbort?.abort()", asset)
        self.assertNotIn(b"__WAVEBIRD_", asset)
        self.assertNotIn(b"sk_test_", asset)

        for app in (create_app(None, None), create_coordinated_app(None, lambda request: None, lambda request: None)):
            route = next(item for item in app.routes if item.path == "/api/wavebird/browser.js")
            with self.assertRaises(StopIteration) as completed:
                route.endpoint().send(None)
            response = completed.exception.value
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.body, asset)
            self.assertEqual(response.headers["content-type"], "application/javascript")
            self.assertEqual(response.headers["x-content-type-options"], "nosniff")


if __name__ == "__main__":
    unittest.main()
