"""Exercise the opt-in shared turn journal through real ASGI routes."""

import asyncio
import tempfile
import time
import unittest
from pathlib import Path

from fastapi import Request
from fastapi.responses import Response

from wavebird_publisher import PublisherConfig, PublisherResponse, PublisherServer
from wavebird_publisher.fastapi import create_app

from python.tests.test_coordinated_fastapi import ORIGIN, call


class DurableFastApiTests(unittest.TestCase):
    def test_durable_no_fit_returns_no_fill_without_fabricating_job(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            upstream_calls = []
            def transport(url, body, key, timeout):
                upstream_calls.append(url)
                raise AssertionError("no-fit must not call upstream")

            def session_id_for_request(request):
                return "server-session" if request.header("x-publisher-session") == "valid" else None

            async def existing_generation(_request: Request):
                return Response("model result", media_type="text/plain")

            config = PublisherConfig(
                client_id="wbproj_synthetic", server_test_key="sk_test_synthetic_server_only",
                preference_secret="synthetic-preference-secret-32-bytes", public_origins=(ORIGIN,),
                surface_id="assistant", placement_key="default", job_type="chat", locale="en-US",
                timing="during", consent_mode="wavebird_consent", publisher_name="Synthetic",
                publisher_domain="publisher.example", allowed_formats=("clip",),
                allowed_sizes=((300, 250),), size_formats=((300, 250, ("clip",)),),
                responsive_size_selection=True, position_hint="between",
                max_width=300, max_height=250,
                authorize=lambda request: session_id_for_request(request) is not None,
            )
            app = create_app(PublisherServer(config, transport), session_id_for_request,
                             existing_generation, turn_journal_path=str(Path(directory) / "turns.sqlite3"))
            identity = {"session_id": "server-session", "turn_id": "turn_no_fit",
                        "format": "clip", "container_size": {"width": 100, "height": 90}}

            async def scenario():
                status, body = await call(app, "/api/wavebird/placement", identity)
                self.assertEqual(status, 200)
                self.assertEqual(body, b'{"decision":{"fill":false,"reason":"no_fit"},"placement":null}')
                self.assertEqual((await call(app, "/api/wavebird/placement", identity))[0], 409)
                self.assertEqual((await call(app, "/api/wavebird/generate", identity)),
                                 (200, b"model result"))
            asyncio.run(scenario())
            self.assertEqual(upstream_calls, [])

    def test_two_app_instances_and_restart_reconcile_ordered_reports(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            path = str(Path(directory) / "turns.sqlite3")
            attempts = []
            generated = []
            allow_started_success = False
            bad_next_placement = True

            def transport(url, body, key, timeout):
                nonlocal bad_next_placement
                if "/placements" in url:
                    if bad_next_placement:
                        bad_next_placement = False
                        return PublisherResponse(200, {}, b'{"decision":{"fill":false}}')
                    return PublisherResponse(200, {}, b'{"job_id":"job_synthetic","decision":{"fill":false}}')
                event = url.rsplit("/", 1)[-1]
                attempts.append(event)
                if event == "started" and not allow_started_success:
                    return PublisherResponse(503, {}, b"{}")
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
            server = PublisherServer(config, transport)
            first = create_app(server, session_id_for_request, existing_generation, turn_journal_path=path)
            second = create_app(server, session_id_for_request, existing_generation, turn_journal_path=path)
            identity = {"session_id": "server-session", "turn_id": "turn_synthetic"}

            async def scenario():
                nonlocal allow_started_success
                self.assertEqual((await call(first, "/api/wavebird/placement", identity, session=""))[0], 401)
                self.assertEqual((await call(first, "/api/wavebird/placement", identity, origin="https://foreign.example"))[0], 403)
                bad_identity = {"session_id": "server-session", "turn_id": "turn_bad_job"}
                self.assertEqual((await call(first, "/api/wavebird/placement", bad_identity))[0], 502)
                self.assertEqual((await call(second, "/api/wavebird/placement", bad_identity))[0], 409)
                self.assertEqual((await call(first, "/api/wavebird/placement", identity))[0], 200)
                self.assertEqual((await call(second, "/api/wavebird/placement", identity))[0], 409)
                started_at = time.monotonic()
                self.assertEqual((await call(second, "/api/wavebird/generate", identity)), (200, b"model result"))
                self.assertLess(time.monotonic() - started_at, 0.8, "report delivery must not delay model output")
                self.assertEqual((await call(first, "/api/wavebird/generate", identity))[0], 409)
                for _ in range(100):
                    if attempts:
                        break
                    await asyncio.sleep(0.01)
                await asyncio.sleep(0.05)
                self.assertTrue(attempts)
                self.assertEqual(set(attempts), {"started"}, "terminal report waits for accepted start")
                allow_started_success = True
                restarted = create_app(server, session_id_for_request, existing_generation, turn_journal_path=path)
                if hasattr(restarted.router, "startup"):
                    await restarted.router.startup()
                else:
                    async with restarted.router.lifespan_context(restarted):
                        pass
                for _ in range(100):
                    if attempts[-2:] == ["started", "finished"]:
                        break
                    await asyncio.sleep(0.01)
                self.assertEqual(attempts[-2:], ["started", "finished"])
                self.assertEqual((await call(restarted, "/api/wavebird/generate", identity))[0], 409)
                await asyncio.sleep(0.05)

            asyncio.run(scenario())
            self.assertEqual(generated, ["POST"])


if __name__ == "__main__":
    unittest.main()
