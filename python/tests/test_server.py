import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Event, Lock

from wavebird_publisher import PublisherConfig, PublisherRequest, PublisherResponse, PublisherServer


def config(origin="https://publisher-one.example", client="wbproj_one"):
    return PublisherConfig(
        client_id=client, server_test_key="sk_test_example_server_only", preference_secret="0123456789abcdef0123456789abcdef",
        public_origins=(origin,), surface_id="assistant", placement_key="default", job_type="chat", locale="en-US",
        timing="during", consent_mode="wavebird_consent", publisher_name="Example", publisher_domain=origin.split("//")[1],
        allowed_formats=("banner",), allowed_sizes=((320, 50),), position_hint="between", max_width=320, max_height=50,
        authorize=lambda req: req.header("x-publisher-session") == "valid", api_base_url="https://api.wavebird.ai",
    )


def request(origin, body=None, headers=None, method="POST"):
    return PublisherRequest(f"{origin}/api/sponsor-slot", method, {
        "Host": origin.split("//")[1], "Origin": origin, "Sec-Fetch-Site": "same-origin", "X-Publisher-Session": "valid", **(headers or {})
    }, json.dumps(body or {}).encode())


class ServerTests(unittest.TestCase):
    def test_saved_sizes_provide_responsive_envelope_without_numeric_caps(self):
        values = config().__dict__.copy()
        values.pop("max_width")
        values.pop("max_height")
        values["responsive_size_selection"] = True
        cfg = PublisherConfig(**values)
        calls = []

        def transport(url, body, key, timeout):
            calls.append(json.loads(body))
            return PublisherResponse(200, {}, b'{"decision":{"fill":false}}')

        response = PublisherServer(cfg, transport).placement_post(request(
            "https://publisher-one.example", {"session_id": "s", "container_size": {"width": 320, "height": 50}}))
        self.assertEqual(response.status, 200)
        self.assertEqual(calls[0]["slot_hint"]["max_width"], 320)
        self.assertEqual(calls[0]["slot_hint"]["max_height"], 50)

    def test_advanced_cap_below_saved_size_returns_no_fit(self):
        cfg = replace(config(), max_width=300, responsive_size_selection=True)
        response = PublisherServer(cfg, lambda *_: self.fail("no upstream on no-fit")).placement_post(request(
            "https://publisher-one.example", {"session_id": "s", "container_size": {"width": 320, "height": 50}}))
        self.assertEqual(response.json()["decision"]["reason"], "no_fit")
        invalid = PublisherServer(cfg, lambda *_: self.fail("no upstream on invalid size")).placement_post(request(
            "https://publisher-one.example", {"session_id": "s", "container_size": {"width": 0, "height": 50}}))
        self.assertEqual(invalid.status, 400)

    def test_invalid_advanced_caps_fail_closed(self):
        for width in (False, 0, -1, "320"):
            with self.subTest(width=width), self.assertRaisesRegex(ValueError, "publisher_envelope_invalid"):
                replace(config(), max_width=width)

    def test_opt_in_responsive_selection_uses_saved_format_sizes_and_no_fit_skips_upstream(self):
        calls = []
        cfg = replace(config(), allowed_formats=("banner", "native", "clip"),
                      allowed_sizes=((728, 90), (320, 50), (300, 250), (640, 360)),
                      size_formats=((728, 90, ("banner",)), (320, 50, ("banner",)),
                                    (300, 250, ("native",)), (640, 360, ("clip",))),
                      max_width=728, max_height=360, responsive_size_selection=True)

        def transport(url, body, key, timeout):
            calls.append(json.loads(body))
            return PublisherResponse(200, {}, b'{"decision":{"fill":false}}')

        server = PublisherServer(cfg, transport)
        origin = "https://publisher-one.example"
        for width, height, fmt, expected_size, expected_format in (
            (728, 360, "banner", (728, 90), "banner"),
            (390, 250, "auto", (320, 50), "banner"),
            (320, 250, "native", (300, 250), "native"),
            (640, 360, "clip", (640, 360), "clip"),
        ):
            response = server.placement_post(request(origin, {"session_id": "s", "format": fmt,
                                                     "container_size": {"width": width, "height": height}}))
            self.assertEqual(response.status, 200)
            self.assertEqual(calls[-1]["slot_hint"]["allowed_sizes"], [{"width": expected_size[0], "height": expected_size[1]}])
            self.assertEqual(calls[-1]["overrides"]["allowed_formats"], [expected_format])
            self.assertLessEqual(calls[-1]["slot_hint"]["max_width"], width)
            self.assertLessEqual(calls[-1]["slot_hint"]["max_height"], height)
        self.assertEqual(len(calls), 4)
        no_fit = server.placement_post(request(origin, {"session_id": "s", "container_size": {"width": 290, "height": 250}}))
        self.assertEqual(no_fit.json(), {"decision": {"fill": False, "reason": "no_fit"}, "placement": None})
        self.assertEqual(server.placement_post(request(origin, {"session_id": "s", "format": "native",
                                                       "container_size": {"width": 320, "height": 90}})).json()["decision"]["reason"], "no_fit")
        for bounds in ({"width": 0, "height": 250}, {"width": True, "height": 250}, None):
            self.assertEqual(server.placement_post(request(origin, {"session_id": "s", "container_size": bounds})).status, 400)
        self.assertEqual(server.placement_post(request(origin, {"session_id": "s", "format": "unknown",
                                                       "container_size": {"width": 728, "height": 360}})).status, 400)
        self.assertEqual(len(calls), 4)

    def test_three_formats_share_saved_scope_and_unknown_format_fails(self):
        calls = []
        cfg = replace(config(), allowed_formats=("banner", "native", "clip"), timing="after",
                      allowed_sizes=((320, 50), (300, 250), (640, 360)), max_width=640, max_height=360)

        def transport(url, body, key, timeout):
            calls.append(json.loads(body))
            return PublisherResponse(200, {}, b'{"decision":{"fill":false}}')

        response = PublisherServer(cfg, transport).placement_post(
            request("https://publisher-one.example", {"session_id": "s", "allowed_formats": ["native"]}))
        self.assertEqual(response.status, 200)
        self.assertEqual(calls[0]["overrides"]["allowed_formats"], ["banner", "native", "clip"])
        self.assertEqual(calls[0]["overrides"]["timing"], "after")
        self.assertEqual(calls[0]["slot_hint"]["allowed_sizes"], [
            {"width": 320, "height": 50}, {"width": 300, "height": 250}, {"width": 640, "height": 360}])
        with self.assertRaisesRegex(ValueError, "publisher_formats_invalid"):
            replace(cfg, allowed_formats=("unknown",))

    def test_two_publishers_use_only_their_saved_scope(self):
        for origin, client in (("https://publisher-one.example", "wbproj_one"), ("https://publisher-two.example", "wbproj_two")):
            calls = []
            def transport(url, body, key, timeout):
                calls.append((url, json.loads(body), key, timeout))
                return PublisherResponse(200, {"Content-Type": "application/json"}, b'{"decision":{"fill":false}}')
            server = PublisherServer(config(origin, client), transport)
            result = server.placement_post(request(origin, {"session_id": "own_session", "allowed_formats": ["native"], "client_id": "wbproj_foreign"}))
            self.assertEqual(result.status, 200)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][1]["client_id"], client)
            self.assertEqual(calls[0][1]["overrides"]["allowed_formats"], ["banner"])
            self.assertEqual(calls[0][1]["slot_hint"]["allowed_sizes"], [{"width": 320, "height": 50}])
            self.assertEqual(calls[0][2], "sk_test_example_server_only")
            self.assertEqual(calls[0][3], 5)

    def test_deny_by_default_origin_session_gpc_and_input(self):
        calls = []
        server = PublisherServer(config(), lambda *args: calls.append(args))
        origin = "https://publisher-one.example"
        self.assertEqual(server.placement_post(request(origin, {"session_id": "s"}, {"X-Publisher-Session": ""})).status, 401)
        self.assertEqual(server.placement_post(request(origin, {"session_id": "s"}, {"Origin": "https://foreign.example"})).status, 403)
        self.assertEqual(server.placement_post(request(origin, {"session_id": "s"}, {"Sec-GPC": "1"})).status, 403)
        self.assertEqual(server.placement_post(request(origin, {})).status, 400)
        self.assertEqual(calls, [])

    def test_consent_refusal_and_signed_preference(self):
        origin = "https://publisher-one.example"
        calls = []
        def transport(url, body, key, timeout):
            calls.append((url, json.loads(body)))
            if url.endswith("/consent"):
                state = calls[-1][1]["lifecycle_state"]
                return PublisherResponse(200, {"Content-Type": "application/json"}, json.dumps({"authoritative_consent": {"lifecycle_state": state, "revision": 1}}).encode())
            return PublisherResponse(200, {}, b"{}")
        server = PublisherServer(config(), transport)
        denied = server.consent_post(request(origin, {"session_id": "s", "lifecycle_state": "denied", "revision": 1, "remember_for_30_days": True}))
        self.assertEqual(denied.status, 200)
        self.assertEqual(calls[-1][1]["purposes"], {"semantic_targeting": False, "session_persistence": False, "cross_session_persistence": False, "prompt_shared": False})
        cookie = denied.headers["Set-Cookie"].split(";", 1)[0]
        restored = server.consent_get(request(origin, headers={"Cookie": cookie}, method="GET"))
        self.assertEqual(restored.json()["preference"]["state"], "denied")
        self.assertIsNone(server.consent_get(request(origin, headers={"Cookie": cookie + "tampered"}, method="GET")).json()["preference"])
        self.assertIsNone(server.consent_get(request(origin, headers={"Cookie": cookie, "Sec-GPC": "1"}, method="GET")).json()["preference"])
        self.assertEqual(server.consent_post(request(origin, {"session_id": "s", "lifecycle_state": "granted", "revision": 1, "tcf_string": "unsupported"})).status, 400)

    def test_no_fill_timeout_report_and_generation_guard(self):
        origin = "https://publisher-one.example"
        server = PublisherServer(config(), lambda *args: PublisherResponse(200, {}, b'{"decision":{"fill":false}}'))
        self.assertFalse(server.placement_post(request(origin, {"session_id": "s"})).json()["decision"]["fill"])
        self.assertIsNone(server.authorize_generation(request(origin)))
        self.assertIsNone(server.authorize_generation(request(origin, headers={"Sec-GPC": "1"})))
        self.assertEqual(server.authorize_generation(request(origin, headers={"X-Publisher-Session": ""})).status, 401)
        self.assertEqual(server.report_generation("job_test", "finished").status, 200)
        with self.assertRaises(ValueError):
            server.report_generation("foreign", "finished")
        timed = PublisherServer(config(), lambda *args: (_ for _ in ()).throw(TimeoutError()))
        self.assertEqual(timed.placement_post(request(origin, {"session_id": "s"})).status, 502)

    def test_upstream_capacity_fails_fast_and_recovers(self):
        origin = "https://publisher-one.example"
        release = Event()
        two_started = Event()
        lock = Lock()
        active = 0

        def transport(url, body, key, timeout):
            nonlocal active
            with lock:
                active += 1
                if active == 2:
                    two_started.set()
            release.wait(2)
            return PublisherResponse(200, {}, b'{"decision":{"fill":false}}')

        server = PublisherServer(config(), transport)
        with ThreadPoolExecutor(max_workers=2) as workers:
            first = workers.submit(server.placement_post, request(origin, {"session_id": "first"}))
            second = workers.submit(server.placement_post, request(origin, {"session_id": "second"}))
            try:
                self.assertTrue(two_started.wait(1))
                limited = server.placement_post(request(origin, {"session_id": "third"}))
                self.assertEqual(limited.status, 429)
                self.assertEqual(limited.json()["error"], "wavebird_capacity_exceeded")
            finally:
                release.set()
            self.assertEqual(first.result(1).status, 200)
            self.assertEqual(second.result(1).status, 200)
        self.assertEqual(server.placement_post(request(origin, {"session_id": "fourth"})).status, 200)
        self.assertEqual(active, 3)

    def test_test_and_live_server_keys_share_the_package_contract(self):
        origin = "https://publisher-one.example"
        calls = []
        for key in ("sk_test_synthetic", "sk_live_synthetic"):
            cfg = replace(config(), server_test_key="", server_key=key)
            server = PublisherServer(cfg, lambda url, body, sent_key, timeout: (
                calls.append((url, sent_key, timeout)) or PublisherResponse(200, {}, b'{"decision":{"fill":false}}')
            ))
            self.assertEqual(server.placement_post(request(origin, {"session_id": "s"})).status, 200)
            self.assertEqual(calls[-1][1], key)
        self.assertEqual(len(calls), 2)
        with self.assertRaisesRegex(ValueError, "publisher_server_key_invalid"):
            replace(config(), server_test_key="", server_key="pk_publishable_wrong_scope")
        with self.assertRaisesRegex(ValueError, "publisher_server_key_conflict"):
            replace(config(), server_key="sk_live_other")

    def test_wildcard_origin_rejected(self):
        with self.assertRaisesRegex(ValueError, "publisher_origins_invalid"):
            PublisherConfig(**{**config().__dict__, "public_origins": ("http://localhost:*",)})
        with self.assertRaisesRegex(ValueError, "publisher_origins_invalid"):
            replace(config(), server_test_key="", server_key="sk_live_synthetic",
                    public_origins=("http://localhost:4173",))
        self.assertEqual(replace(config(), public_origins=("http://localhost:4173",)).public_origins,
                         ("http://localhost:4173",))


if __name__ == "__main__":
    unittest.main()
