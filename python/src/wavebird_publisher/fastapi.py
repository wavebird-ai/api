"""Mount the public wheel in the publisher's existing FastAPI app."""
import asyncio
import json
import re
import sqlite3
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from fastapi import FastAPI, Request
from fastapi.responses import Response, StreamingResponse
from starlette.concurrency import run_in_threadpool
from wavebird_publisher import PublisherRequest, PublisherResponse, PublisherServer
from .assets import browser_module_bytes
from .turn_journal import SqliteTurnJournal

_TURN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_MAX_BODY_BYTES = 16 * 1024


async def _bounded_body(request: Request) -> bytes | None:
    """Stop reading at the package's request limit before Starlette joins the body."""
    declared = request.headers.get("content-length")
    if declared:
        try:
            if int(declared) > _MAX_BODY_BYTES:
                return None
        except ValueError:
            pass  # The streamed byte count remains authoritative.
    chunks = bytearray()
    async for chunk in request.stream():
        if len(chunks) + len(chunk) > _MAX_BODY_BYTES:
            return None
        chunks.extend(chunk)
    body = bytes(chunks)
    # Existing publisher generation handlers may call request.body() again.
    request._body = body
    return body

def _publisher_request(request: Request, body: bytes = b"") -> PublisherRequest:
    return PublisherRequest(str(request.url), request.method, dict(request.headers), body)

def _response(result: PublisherResponse) -> Response:
    return Response(content=result.body, status_code=result.status, headers=dict(result.headers))

def _identity(request: Request, body: bytes, session_id_for_request: Callable[[PublisherRequest], str | None]) -> tuple[str, str] | None:
    try:
        if len(body) > 16 * 1024:
            return None
        payload = json.loads(body)
        session = session_id_for_request(_publisher_request(request, body))
        turn = payload.get("turn_id")
        if isinstance(session, str) and session and payload.get("session_id") == session and isinstance(turn, str) and _TURN.fullmatch(turn):
            return session, turn
    except (ValueError, TypeError):
        pass
    return None


def _consent_session_matches(request: Request, body: bytes,
                             session_id_for_request: Callable[[PublisherRequest], str | None]) -> bool:
    try:
        if len(body) > 16 * 1024:
            return False
        payload = json.loads(body)
        session = session_id_for_request(_publisher_request(request, body))
        return isinstance(session, str) and bool(session) and isinstance(payload, dict) and payload.get("session_id") == session
    except (ValueError, TypeError):
        return False

class _Turn:
    def __init__(self) -> None:
        self.created_at = time.monotonic()
        self.placement_claimed = False
        self.generation_claimed = False
        self.job_id: str | None = None
        self.phase = "idle"
        self.reported: set[str] = set()
        self.pending: list[str] = []
        self.report_task: asyncio.Task[None] | None = None

class _GenerationCoordinator:
    """Single-process Test example; use the publisher's shared store for multiple workers."""
    def __init__(self, server: PublisherServer) -> None:
        self.server = server
        self.turns: dict[tuple[str, str], _Turn] = {}
        self.lock = asyncio.Lock()

    def _prune(self) -> None:
        now = time.monotonic()
        self.turns = {key: turn for key, turn in self.turns.items()
                      if now - turn.created_at < 3600}

    async def claim_placement(self, key: tuple[str, str]) -> bool:
        async with self.lock:
            self._prune()
            turn = self.turns.setdefault(key, _Turn())
            if turn.placement_claimed:
                return False
            turn.placement_claimed = True
            return True

    async def release_rejected_placement(self, key: tuple[str, str]) -> None:
        async with self.lock:
            turn = self.turns.get(key)
            if turn and turn.job_id is None:
                turn.placement_claimed = False

    async def claim_generation(self, key: tuple[str, str]) -> bool:
        async with self.lock:
            self._prune()
            turn = self.turns.setdefault(key, _Turn())
            if turn.generation_claimed:
                return False
            turn.generation_claimed = True
            return True

    async def _advance(self, key: tuple[str, str], *, job_id: str | None = None, phase: str | None = None) -> None:
        async with self.lock:
            self._prune()
            turn = self.turns.setdefault(key, _Turn())
            if job_id is not None:
                turn.job_id = job_id
            if phase is not None:
                turn.phase = phase
            events = (["started"] if turn.phase in {"started", "finished", "failed"} else []) + (
                [turn.phase] if turn.phase in {"finished", "failed"} else [])
            for event in events:
                if turn.job_id and event not in turn.reported and event not in turn.pending:
                    turn.pending.append(event)
            if turn.pending and (turn.report_task is None or turn.report_task.done()):
                turn.report_task = asyncio.create_task(self._flush(key))

    async def _flush(self, key: tuple[str, str]) -> None:
        """Report in turn order without delaying or failing the publisher's model."""
        while True:
            async with self.lock:
                turn = self.turns.get(key)
                if turn is None:
                    return
                if not turn.pending:
                    turn.report_task = None
                    return
                event = turn.pending[0]
                job_id = turn.job_id
            accepted = False
            if job_id is not None:
                try:
                    accepted = (await run_in_threadpool(self.server.report_generation, job_id, event)).status == 200
                except Exception:
                    pass
            async with self.lock:
                turn = self.turns.get(key)
                if turn is None:
                    return
                if turn.pending and turn.pending[0] == event:
                    turn.pending.pop(0)
                    if accepted:
                        turn.reported.add(event)

    async def bind(self, key: tuple[str, str], job_id: str) -> None:
        await self._advance(key, job_id=job_id)

    async def phase(self, key: tuple[str, str], event: str) -> None:
        await self._advance(key, phase=event)

def create_app(server: PublisherServer, session_id_for_request: Callable[[PublisherRequest], str | None],
               existing_generation: Callable[[Request], Awaitable[Response]], *,
               turn_journal_path: str | None = None,
               on_diagnostic: Callable[[str], None] | None = None) -> FastAPI:
    return mount_fastapi(FastAPI(), server, session_id_for_request, existing_generation,
                         turn_journal_path=turn_journal_path, on_diagnostic=on_diagnostic)


def mount_fastapi(app: FastAPI, server: PublisherServer,
                  session_id_for_request: Callable[[PublisherRequest], str | None],
                  existing_generation: Callable[[Request], Awaitable[Response]], *,
                  turn_journal_path: str | None = None,
                  on_diagnostic: Callable[[str], None] | None = None) -> FastAPI:
    """Add Wavebird routes to an existing FastAPI app without replacing its routes or middleware.

    Mount before the app starts serving. The default coordinator remains single-process;
    a shared turn coordinator is required before multi-worker use is supported.
    """
    if any(getattr(route, "path", None) in {
        "/api/wavebird/browser.js", "/api/wavebird/placement",
        "/api/wavebird/consent", "/api/wavebird/generate",
    } for route in app.routes):
        raise ValueError("wavebird_route_conflict")
    coordinator = SqliteTurnJournal(server, turn_journal_path, on_diagnostic) if turn_journal_path else _GenerationCoordinator(server)
    def diagnostic(code: str) -> None:
        if on_diagnostic:
            try:
                on_diagnostic(code)
            except Exception:
                pass
    if turn_journal_path:
        app.router.add_event_handler("startup", coordinator.reconcile_pending)

    @app.get("/api/wavebird/browser.js")
    async def browser_module() -> Response:
        return Response(content=browser_module_bytes(), media_type="application/javascript",
                        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    @app.post("/api/wavebird/placement")
    async def placement(request: Request) -> Response:
        body = await _bounded_body(request)
        if body is None:
            return Response(status_code=413)
        identity = _identity(request, body, session_id_for_request)
        if identity is None:
            return Response(status_code=401)
        denied = server.authorize_generation(_publisher_request(request, body))
        if denied is not None:
            return _response(denied)
        try:
            claimed = await coordinator.claim_placement(identity)
        except sqlite3.Error:
            diagnostic("turn_journal_unavailable")
            return Response(status_code=503)
        if not claimed:
            return Response(status_code=409)
        result = await run_in_threadpool(server.placement_post, _publisher_request(request, body))
        if result.status in {400, 401, 403}:
            await coordinator.release_rejected_placement(identity)
        if result.status == 200:
            try:
                payload = result.json()
                if not isinstance(payload, dict):
                    raise ValueError("placement_response_invalid")
                job_id = payload.get("job_id")
                if isinstance(job_id, str) and re.fullmatch(r"job_[A-Za-z0-9_-]{1,128}", job_id):
                    try:
                        await coordinator.bind(identity, job_id)
                    except (sqlite3.Error, ValueError):
                        diagnostic("turn_binding_unavailable")
                        return Response(status_code=502)
                elif turn_journal_path and not (
                    isinstance(payload.get("decision"), dict) and
                    payload["decision"].get("fill") is False and
                    "placement" in payload and payload["placement"] is None
                ):
                    diagnostic("turn_binding_unavailable")
                    return Response(status_code=502)
            except (ValueError, TypeError):
                if turn_journal_path:
                    diagnostic("turn_binding_unavailable")
                    return Response(status_code=502)
        return _response(result)

    @app.get("/api/wavebird/consent")
    async def read_consent(request: Request) -> Response:
        return _response(await run_in_threadpool(server.consent_get, _publisher_request(request)))

    @app.post("/api/wavebird/consent")
    async def write_consent(request: Request) -> Response:
        body = await _bounded_body(request)
        if body is None:
            return Response(status_code=413)
        if not _consent_session_matches(request, body, session_id_for_request):
            return Response(status_code=401)
        return _response(await run_in_threadpool(server.consent_post, _publisher_request(request, body)))

    @app.post("/api/wavebird/generate")
    async def generate(request: Request) -> Response:
        body = await _bounded_body(request)
        if body is None:
            return Response(status_code=413)
        denied = server.authorize_generation(_publisher_request(request, body))
        if denied is not None:
            return _response(denied)
        identity = _identity(request, body, session_id_for_request)
        if identity is None:
            return Response(status_code=401)
        try:
            claimed = await coordinator.claim_generation(identity)
        except sqlite3.Error:
            diagnostic("turn_journal_unavailable")
            return await existing_generation(request)
        if not claimed:
            return Response(status_code=409)
        try:
            await coordinator.phase(identity, "started")
        except sqlite3.Error:
            diagnostic("turn_journal_unavailable")
            pass
        try:
            upstream = await existing_generation(request)
        except (Exception, asyncio.CancelledError):
            try:
                await coordinator.phase(identity, "failed")
            except sqlite3.Error:
                diagnostic("turn_journal_unavailable")
                pass
            raise
        if upstream.status_code >= 400:
            try:
                await coordinator.phase(identity, "failed")
            except sqlite3.Error:
                diagnostic("turn_journal_unavailable")
                pass
            return upstream
        if not isinstance(upstream, StreamingResponse):
            try:
                await coordinator.phase(identity, "finished")
            except sqlite3.Error:
                diagnostic("turn_journal_unavailable")
                pass
            return upstream

        async def stream() -> AsyncIterator[bytes]:
            try:
                async for chunk in upstream.body_iterator:
                    if await request.is_disconnected():
                        raise asyncio.CancelledError()
                    yield chunk
                try:
                    await coordinator.phase(identity, "finished")
                except sqlite3.Error:
                    diagnostic("turn_journal_unavailable")
                    pass
            except (Exception, asyncio.CancelledError):
                try:
                    await coordinator.phase(identity, "failed")
                except sqlite3.Error:
                    diagnostic("turn_journal_unavailable")
                    pass
                raise

        headers = {key: value for key, value in upstream.headers.items()
                   if key.lower() not in {"content-length", "transfer-encoding"}}
        headers["Cache-Control"] = "no-store"
        return StreamingResponse(stream(), status_code=upstream.status_code,
                                 media_type=upstream.media_type, headers=headers)

    return app
