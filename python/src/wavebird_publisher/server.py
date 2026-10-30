"""Framework-neutral, server-only Wavebird placement and consent bridge."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_PLACEMENT_KEY = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_STATES = frozenset(("granted", "denied", "withdrawn", "cmp_error"))
_TTL = 30 * 24 * 60 * 60


@dataclass(frozen=True)
class PublisherRequest:
    url: str
    method: str
    headers: Mapping[str, str]
    body: bytes = b""

    def header(self, key: str) -> str:
        return next((str(value) for name, value in self.headers.items() if name.lower() == key.lower()), "")


@dataclass(frozen=True)
class PublisherResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes

    def json(self) -> dict:
        return json.loads(self.body)


@dataclass(frozen=True)
class PublisherConfig:
    client_id: str
    server_test_key: str = field(default="", kw_only=True, repr=False)
    preference_secret: str
    public_origins: tuple[str, ...]
    surface_id: str
    placement_key: str
    job_type: str
    locale: str
    timing: str
    consent_mode: str
    publisher_name: str
    publisher_domain: str
    allowed_formats: tuple[str, ...]
    allowed_sizes: tuple[tuple[int, int], ...]
    position_hint: str
    max_width: int
    max_height: int
    authorize: Callable[[PublisherRequest], bool]
    api_base_url: str = "https://api.wavebird.ai"
    gdpr_applies: bool = False
    responsive_size_selection: bool = False
    size_formats: tuple[tuple[int, int, tuple[str, ...]], ...] = ()
    server_key: str = field(default="", kw_only=True, repr=False)

    @property
    def resolved_server_key(self) -> str:
        return self.server_key or self.server_test_key

    def __post_init__(self) -> None:
        if not self.client_id.startswith("wbproj_"):
            raise ValueError("publisher_project_invalid")
        if self.server_key and self.server_test_key and self.server_key != self.server_test_key:
            raise ValueError("publisher_server_key_conflict")
        if not self.resolved_server_key.startswith(("sk_test_", "sk_live_")):
            raise ValueError("publisher_server_key_invalid")
        if len(self.preference_secret.encode()) < 32 or not callable(self.authorize):
            raise ValueError("publisher_security_config_invalid")
        if not _ID.fullmatch(self.surface_id) or not _PLACEMENT_KEY.fullmatch(self.placement_key):
            raise ValueError("publisher_placement_invalid")
        if self.timing not in ("before", "during", "after") or self.consent_mode not in ("wavebird_consent", "own_cmp"):
            raise ValueError("publisher_lifecycle_invalid")
        if self.position_hint not in ("above", "below", "sidebar", "between"):
            raise ValueError("publisher_position_invalid")
        if not self.allowed_formats or any(value not in ("banner", "native", "clip") for value in self.allowed_formats):
            raise ValueError("publisher_formats_invalid")
        if not self.allowed_sizes or any(not (type(w) is int and type(h) is int and 0 < w <= self.max_width and 0 < h <= self.max_height) for w, h in self.allowed_sizes):
            raise ValueError("publisher_sizes_invalid")
        if not isinstance(self.responsive_size_selection, bool):
            raise ValueError("publisher_responsive_selection_invalid")
        if not isinstance(self.size_formats, tuple):
            raise ValueError("publisher_size_formats_invalid")
        seen_sizes = set()
        for entry in self.size_formats:
            if not isinstance(entry, tuple) or len(entry) != 3:
                raise ValueError("publisher_size_formats_invalid")
            width, height, formats = entry
            if (width, height) not in self.allowed_sizes or (width, height) in seen_sizes or not isinstance(formats, tuple) or not formats or any(not isinstance(fmt, str) for fmt in formats) or len(set(formats)) != len(formats) or any(fmt not in self.allowed_formats for fmt in formats):
                raise ValueError("publisher_size_formats_invalid")
            seen_sizes.add((width, height))
        if not self.public_origins or len(set(self.public_origins)) != len(self.public_origins):
            raise ValueError("publisher_origins_invalid")
        for origin in self.public_origins:
            parsed = urlsplit(origin)
            try:
                port = parsed.port
            except ValueError as error:
                raise ValueError("publisher_origins_invalid") from error
            loopback = parsed.hostname in ("localhost", "127.0.0.1")
            if parsed.geturl() != origin or not parsed.netloc or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or (parsed.scheme != "https" and not (loopback and parsed.scheme == "http" and self.resolved_server_key.startswith("sk_test_"))):
                raise ValueError("publisher_origins_invalid")
        base = urlsplit(self.api_base_url)
        if base.scheme != "https" or not base.netloc or base.query or base.fragment:
            raise ValueError("publisher_api_https_required")


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def default_transport(url: str, body: bytes, key: str, timeout: float) -> PublisherResponse:
    """POST JSON without redirects, with bounded response and deadline."""
    request = Request(url, data=body, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, method="POST")
    try:
        with build_opener(_NoRedirect).open(request, timeout=timeout) as result:
            data = result.read(256 * 1024 + 1)
            if len(data) > 256 * 1024:
                raise ValueError("wavebird_response_too_large")
            return PublisherResponse(result.status, {"Content-Type": result.headers.get("Content-Type", "application/json")}, data)
    except HTTPError as error:
        data = error.read(256 * 1024 + 1)
        if len(data) > 256 * 1024:
            raise ValueError("wavebird_response_too_large") from error
        return PublisherResponse(error.code, {"Content-Type": error.headers.get("Content-Type", "application/json")}, data)


class PublisherServer:
    def __init__(self, config: PublisherConfig, transport: Callable[[str, bytes, str, float], PublisherResponse] = default_transport):
        self.config = config
        self.transport = transport
        self._upstream_capacity = threading.BoundedSemaphore(2)

    @staticmethod
    def _reply(status: int, value: dict, headers: Mapping[str, str] | None = None) -> PublisherResponse:
        return PublisherResponse(status, {"Content-Type": "application/json", "Cache-Control": "no-store", **(headers or {})}, json.dumps(value, separators=(",", ":")).encode())

    def _origin(self, request: PublisherRequest, strict: bool = True) -> str | None:
        host = request.header("host").lower()
        origin = request.header("origin")
        matches = [item for item in self.config.public_origins if urlsplit(item).netloc.lower() == host]
        expected = origin if origin in matches else (matches[0] if not origin and len(matches) == 1 else None)
        if not expected or (strict and origin != expected) or request.header("sec-fetch-site") == "cross-site":
            return None
        return expected

    def _authorized(self, request: PublisherRequest) -> bool:
        try:
            return self.config.authorize(request) is True
        except Exception:
            return False

    @staticmethod
    def _gpc(request: PublisherRequest) -> bool:
        return "1" in (part.strip() for part in request.header("sec-gpc").split(","))

    @staticmethod
    def _input(request: PublisherRequest) -> dict | None:
        if len(request.body) > 16 * 1024:
            return None
        try:
            value = json.loads(request.body)
            return value if isinstance(value, dict) else None
        except (UnicodeError, ValueError):
            return None

    def _upstream(self, path: str, payload: dict) -> PublisherResponse:
        if not self._upstream_capacity.acquire(blocking=False):
            return self._reply(429, {"error": "wavebird_capacity_exceeded"})
        try:
            result = self.transport(self.config.api_base_url.rstrip("/").removesuffix("/v1") + "/v1" + path, json.dumps(payload, separators=(",", ":")).encode(), self.config.resolved_server_key, 5)
            if len(result.body) > 256 * 1024:
                raise ValueError("wavebird_response_too_large")
            return PublisherResponse(result.status, {"Content-Type": result.headers.get("Content-Type", "application/json"), "Cache-Control": "no-store"}, result.body)
        except (OSError, URLError, TimeoutError, ValueError):
            return self._reply(502, {"error": "wavebird_unavailable"})
        finally:
            self._upstream_capacity.release()

    def placement_post(self, request: PublisherRequest) -> PublisherResponse:
        if not self._authorized(request):
            return self._reply(401, {"error": "authentication_required"})
        if self._gpc(request):
            return self._reply(403, {"error": "privacy_signal_policy_required"})
        if self._origin(request) is None:
            return self._reply(403, {"error": "invalid_origin"})
        data = self._input(request)
        if data is None:
            return self._reply(400, {"error": "invalid_json"})
        session_id = data.get("session_id")
        if not isinstance(session_id, str) or not session_id.strip():
            return self._reply(400, {"error": "session_id_required"})
        config = self.config
        sizes = config.allowed_sizes
        formats = config.allowed_formats
        max_width, max_height = config.max_width, config.max_height
        if config.responsive_size_selection:
            bounds = data.get("container_size")
            if not isinstance(bounds, dict) or any(type(bounds.get(key)) is not int or not 0 < bounds[key] <= 8192 for key in ("width", "height")):
                return self._reply(400, {"error": "publisher_container_size_invalid"})
            requested = data.get("format", "auto")
            if requested != "auto" and requested not in formats:
                return self._reply(400, {"error": "publisher_format_invalid"})
            assigned = {(w, h): allowed for w, h, allowed in config.size_formats}
            fitting = [(w, h) for w, h in sizes if w <= bounds["width"] and h <= bounds["height"] and
                       (requested == "auto" or requested in assigned.get((w, h), formats))]
            if not fitting:
                return self._reply(200, {"decision": {"fill": False, "reason": "no_fit"}, "placement": None})
            chosen = max(fitting, key=lambda size: (size[0], size[1]))
            sizes = (chosen,)
            formats = tuple(fmt for fmt in formats if fmt in assigned.get(chosen, formats)) if requested == "auto" else (requested,)
            max_width, max_height = min(max_width, bounds["width"]), min(max_height, bounds["height"])
        return self._upstream("/placements?wait_ms=1500", {
            "client_id": config.client_id, "session_id": session_id, "job_type": config.job_type, "locale": config.locale,
            "slots_requested": 1, "placement_key": config.placement_key,
            "slot_hint": {"position": config.position_hint, "max_width": max_width, "max_height": max_height,
                          "allowed_sizes": [{"width": w, "height": h} for w, h in sizes], "presentation_version": "sponsored_moment_v2"},
            "overrides": {"allowed_formats": list(formats), "timing": config.timing,
                          "publisher": {"app_name": config.publisher_name, "app_domain": config.publisher_domain}},
            "consent": {"semantic_targeting": False, "prompt_shared": False, "gdpr_applies": config.gdpr_applies,
                        "consent_source": "wavebird_consent" if config.consent_mode == "wavebird_consent" else "wrapper_cmp"},
        })

    def _scope(self, origin: str) -> dict:
        return {"project": self.config.client_id, "surface": self.config.surface_id, "version": "contextual-choice/v2",
                "profile": "wavebird_dialog" if self.config.consent_mode == "wavebird_consent" else "publisher_custom", "origin": origin}

    @staticmethod
    def _b64(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    def _cookie_name(self) -> str:
        return "wb_choice_" + hashlib.sha256((self.config.client_id + ":" + self.config.surface_id).encode()).hexdigest()[:16]

    def _sign(self, origin: str, state: str) -> str:
        now = int(time.time() * 1000)
        payload = {**self._scope(origin), "state": state, "issued_at": now, "expires_at": now + _TTL * 1000}
        encoded = self._b64(json.dumps(payload, separators=(",", ":")).encode())
        signature = self._b64(hmac.new(self.config.preference_secret.encode(), encoded.encode(), hashlib.sha256).digest())
        return f"{self._cookie_name()}={encoded}.{signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age={_TTL}"

    def consent_get(self, request: PublisherRequest) -> PublisherResponse:
        headers = {"Vary": "Cookie, Sec-GPC"}
        if not self._authorized(request):
            return self._reply(401, {"error": "authentication_required"}, headers)
        origin = self._origin(request, strict=False)
        if origin is None:
            return self._reply(403, {"error": "invalid_origin"}, headers)
        if self._gpc(request):
            return self._reply(200, {"preference": None}, headers)
        name = self._cookie_name() + "="
        value = next((part.strip()[len(name):] for part in request.header("cookie").split(";") if part.strip().startswith(name)), "")
        try:
            if len(value) > 2048:
                raise ValueError()
            encoded, signature = value.split(".")
            expected = self._b64(hmac.new(self.config.preference_secret.encode(), encoded.encode(), hashlib.sha256).digest())
            if not hmac.compare_digest(signature, expected):
                raise ValueError()
            record = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
            now = int(time.time() * 1000)
            if any(record.get(key) != val for key, val in self._scope(origin).items()) or record.get("state") not in _STATES - {"cmp_error"} or not record.get("issued_at", 0) <= now < record.get("expires_at", 0) or record["expires_at"] - record["issued_at"] != _TTL * 1000:
                raise ValueError()
            return self._reply(200, {"preference": {"state": record["state"], "expires_at": record["expires_at"]}}, headers)
        except (ValueError, KeyError, TypeError):
            return self._reply(200, {"preference": None}, headers)

    def consent_post(self, request: PublisherRequest) -> PublisherResponse:
        if not self._authorized(request):
            return self._reply(401, {"error": "authentication_required"})
        origin = self._origin(request)
        if origin is None:
            return self._reply(403, {"error": "invalid_origin"})
        if self._gpc(request):
            return self._reply(403, {"error": "privacy_signal_policy_required"})
        data = self._input(request)
        if not data or not isinstance(data.get("session_id"), str) or not data["session_id"].strip() or data.get("lifecycle_state") not in _STATES or type(data.get("revision")) is not int or data["revision"] < 1:
            return self._reply(400, {"error": "consent_input_invalid"})
        if any(key in data for key in ("tcf_string", "gpp_string", "gpp_sections")):
            return self._reply(400, {"error": "external_consent_protocol_requires_policy"})
        config = self.config
        result = self._upstream("/consent", {"client_id": config.client_id, "session_id": data["session_id"].strip(),
            "decision": "custom" if config.consent_mode == "wavebird_consent" else "basic",
            "source": "wavebird_dialog" if config.consent_mode == "wavebird_consent" else "publisher_custom",
            "lifecycle_state": data["lifecycle_state"], "revision": data["revision"],
            "purposes": {"semantic_targeting": False, "session_persistence": False, "cross_session_persistence": False, "prompt_shared": False}})
        headers = dict(result.headers)
        if data.get("remember_for_30_days") is True:
            headers["Set-Cookie"] = f"{self._cookie_name()}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
            if result.status == 200 and data["lifecycle_state"] != "cmp_error":
                try:
                    snapshot = result.json()["authoritative_consent"]
                    if snapshot["lifecycle_state"] != data["lifecycle_state"] or snapshot["revision"] != data["revision"]:
                        return self._reply(502, {"error": "consent_snapshot_invalid"}, headers)
                    headers["Set-Cookie"] = self._sign(origin, data["lifecycle_state"])
                except (ValueError, KeyError, TypeError):
                    return self._reply(502, {"error": "consent_snapshot_invalid"}, headers)
        return PublisherResponse(result.status, headers, result.body)

    def authorize_generation(self, request: PublisherRequest) -> PublisherResponse | None:
        """Call before entering the publisher's own model stream; None means permitted."""
        if not self._authorized(request):
            return self._reply(401, {"error": "authentication_required"})
        if self._origin(request) is None:
            return self._reply(403, {"error": "invalid_origin"})
        return None

    def report_generation(self, job_id: str, event: str) -> PublisherResponse:
        """Server-only scoped lifecycle report; never expose the Test key to the browser."""
        if not isinstance(job_id, str) or not re.fullmatch(r"job_[A-Za-z0-9_-]{1,128}", job_id) or event not in ("started", "finished", "failed"):
            raise ValueError("invalid_generation_report")
        return self._upstream(f"/jobs/{job_id}/generation/{event}", {})
