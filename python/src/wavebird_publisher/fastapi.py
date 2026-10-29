"""Mount the public wheel in the publisher's existing FastAPI app."""
import asyncio
import json
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from fastapi import FastAPI, Request
from fastapi.responses import Response, StreamingResponse
from starlette.concurrency import run_in_threadpool
from wavebird_publisher import PublisherRequest, PublisherResponse, PublisherServer
from .assets import browser_module_bytes

_TURN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

def _publisher_request(request: Request, body: bytes = b"") -> PublisherRequest:
    return PublisherRequest(str(request.url), request.method, dict(request.headers), body)

def _response(result: PublisherResponse) -> Response:
    return Response(content=result.body, status_code=result.status, headers=dict(result.headers))

def _identity(request: Request, body: bytes, session_id_for_request: Callable[[PublisherRequest], str | None]) -> tuple[str, str] | None:
    try:
        payload = json.loads(body)
        session = session_id_for_request(_publisher_request(request, body))
        turn = payload.get("turn_id")
        if isinstance(session, str) and session and payload.get("session_id") == session and isinstance(turn, str) and _TURN.fullmatch(turn):
            return session, turn
    except (ValueError, TypeError):
        pass
    return None

class _Turn:
    def __init__(self) -> None:
        self.created_at = time.monotonic()
        self.placement_claimed = False
        self.generation_claimed = False
        self.job_id: str | None = None
        self.phase = "idle"
        self.reported: set[str] = set()

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
                if turn.job_id and event not in turn.reported:
                    result = await run_in_threadpool(self.server.report_generation, turn.job_id, event)
                    if result.status == 200:
                        turn.reported.add(event)

    async def bind(self, key: tuple[str, str], job_id: str) -> None:
        await self._advance(key, job_id=job_id)

    async def phase(self, key: tuple[str, str], event: str) -> None:
        await self._advance(key, phase=event)

def create_app(server: PublisherServer, session_id_for_request: Callable[[PublisherRequest], str | None],
               existing_generation: Callable[[Request], Awaitable[Response]]) -> FastAPI:
    app = FastAPI()
    coordinator = _GenerationCoordinator(server)

    @app.get("/api/wavebird/browser.js")
    async def browser_module() -> Response:
        return Response(content=browser_module_bytes(), media_type="application/javascript",
                        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    @app.post("/api/wavebird/placement")
    async def placement(request: Request) -> Response:
        body = await request.body()
        identity = _identity(request, body, session_id_for_request)
        if identity is None:
            return Response(status_code=401)
        denied = server.authorize_generation(_publisher_request(request, body))
        if denied is not None:
            return _response(denied)
        if not await coordinator.claim_placement(identity):
            return Response(status_code=409)
        result = await run_in_threadpool(server.placement_post, _publisher_request(request, body))
        if result.status in {400, 401, 403}:
            await coordinator.release_rejected_placement(identity)
        if result.status == 200:
            try:
                job_id = result.json().get("job_id")
                if isinstance(job_id, str) and re.fullmatch(r"job_[A-Za-z0-9_-]{1,128}", job_id):
                    await coordinator.bind(identity, job_id)
            except (ValueError, TypeError):
                pass
        return _response(result)

    @app.get("/api/wavebird/consent")
    async def read_consent(request: Request) -> Response:
        return _response(await run_in_threadpool(server.consent_get, _publisher_request(request)))

    @app.post("/api/wavebird/consent")
    async def write_consent(request: Request) -> Response:
        return _response(await run_in_threadpool(server.consent_post, _publisher_request(request, await request.body())))

    @app.post("/api/wavebird/generate")
    async def generate(request: Request) -> Response:
        body = await request.body()
        denied = server.authorize_generation(_publisher_request(request, body))
        if denied is not None:
            return _response(denied)
        identity = _identity(request, body, session_id_for_request)
        if identity is None:
            return Response(status_code=401)
        if not await coordinator.claim_generation(identity):
            return Response(status_code=409)
        await coordinator.phase(identity, "started")
        try:
            upstream = await existing_generation(request)
        except (Exception, asyncio.CancelledError):
            await coordinator.phase(identity, "failed")
            raise
        if upstream.status_code >= 400:
            await coordinator.phase(identity, "failed")
            return upstream
        if not isinstance(upstream, StreamingResponse):
            await coordinator.phase(identity, "finished")
            return upstream

        async def stream() -> AsyncIterator[bytes]:
            try:
                async for chunk in upstream.body_iterator:
                    if await request.is_disconnected():
                        raise asyncio.CancelledError()
                    yield chunk
                await coordinator.phase(identity, "finished")
            except (Exception, asyncio.CancelledError):
                await coordinator.phase(identity, "failed")
                raise

        headers = {key: value for key, value in upstream.headers.items()
                   if key.lower() not in {"content-length", "transfer-encoding"}}
        headers["Cache-Control"] = "no-store"
        return StreamingResponse(stream(), status_code=upstream.status_code,
                                 media_type=upstream.media_type, headers=headers)

    return app
