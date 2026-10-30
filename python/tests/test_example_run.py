"""The maintained FastAPI example consumes saved per-format size eligibility."""
import importlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from wavebird_publisher import PublisherServer


class ExampleSettingsTests(unittest.TestCase):
    def test_saved_size_formats_and_gdpr_reach_package_config(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            env = {
                "WAVEBIRD_CLIENT_ID": "wbproj_synthetic",
                "WAVEBIRD_SECRET_KEY": "sk_test_synthetic",
                "WAVEBIRD_PREFERENCE_SECRET": "synthetic-preference-secret-for-local-checks-only",
                "WAVEBIRD_PUBLIC_ORIGINS": "https://publisher.example",
                "WAVEBIRD_SURFACE_ID": "chat_assistant",
                "WAVEBIRD_PLACEMENT_KEY": "default",
                "WAVEBIRD_JOB_TYPE": "chat",
                "WAVEBIRD_LOCALE": "en",
                "WAVEBIRD_TIMING": "during",
                "WAVEBIRD_CONSENT_MODE": "wavebird_consent",
                "WAVEBIRD_APP_NAME": "Synthetic Publisher",
                "WAVEBIRD_APP_DOMAIN": "publisher.example",
                "WAVEBIRD_ALLOWED_FORMATS": "banner,native,clip",
                "WAVEBIRD_ALLOWED_SIZES": "320x50,300x250",
                "WAVEBIRD_SIZE_FORMATS_JSON": json.dumps([
                    [320, 50, ["banner"]], [300, 250, ["native", "clip"]],
                ]),
                "WAVEBIRD_GDPR_APPLIES": "true",
                "WAVEBIRD_POSITION_HINT": "between",
                "WAVEBIRD_TURN_JOURNAL_PATH": str(Path(directory) / "turns.sqlite3"),
            }
            with mock.patch.dict(os.environ, env), mock.patch(
                "wavebird_publisher.PublisherServer", wraps=PublisherServer
            ) as factory:
                run = importlib.import_module("examples.fastapi_app.run")
                config = factory.call_args.args[0]
                self.assertTrue(config.responsive_size_selection)
                self.assertTrue(config.gdpr_applies)
                self.assertEqual(config.size_formats, (
                    (320, 50, ("banner",)), (300, 250, ("native", "clip")),
                ))
                self.assertTrue(any(route.path == "/api/wavebird/placement" for route in run.app.routes))
                with mock.patch.dict(os.environ, {"WAVEBIRD_SIZE_FORMATS_JSON": "[[320,50,[\"banner\"]]]"}):
                    with self.assertRaisesRegex(ValueError, "cover each saved size"):
                        run.configured_app()
                with mock.patch.dict(os.environ, {"WAVEBIRD_GDPR_APPLIES": "maybe"}):
                    with self.assertRaisesRegex(ValueError, "must be true or false"):
                        run.configured_app()


if __name__ == "__main__":
    unittest.main()
