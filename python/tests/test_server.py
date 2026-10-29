import json
import unittest
from dataclasses import replace

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

    def test_live_key_and_wildcard_origin_rejected(self):
        with self.assertRaisesRegex(ValueError, "publisher_test_scope_invalid"):
            PublisherConfig(**{**config().__dict__, "server_test_key": "sk_live_bad"})
        with self.assertRaisesRegex(ValueError, "publisher_origins_invalid"):
            PublisherConfig(**{**config().__dict__, "public_origins": ("http://localhost:*",)})


if __name__ == "__main__":
    unittest.main()
