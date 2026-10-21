"""Complete same-origin FastAPI route wiring; publisher auth/model hooks stay explicit."""

from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from wavebird_publisher import PublisherRequest, PublisherResponse, PublisherServer


def _publisher_request(request: Request, body: bytes = b"") -> PublisherRequest:
    return PublisherRequest(str(request.url), request.method, dict(request.headers), body)


def _fastapi_response(result: PublisherResponse) -> Response:
    return Response(content=result.body, status_code=result.status, headers=dict(result.headers))


def create_app(
    server: PublisherServer,
    existing_generation: Callable[[Request], Awaitable[Response]],
) -> FastAPI:
    """Install the four publisher-owned routes without creating a second auth path."""
    app = FastAPI()

    @app.post("/api/wavebird/placement")
    async def placement(request: Request) -> Response:
        body = await request.body()
        result = await run_in_threadpool(server.placement_post, _publisher_request(request, body))
        return _fastapi_response(result)

    @app.get("/api/wavebird/consent")
    async def read_consent(request: Request) -> Response:
        result = await run_in_threadpool(server.consent_get, _publisher_request(request))
        return _fastapi_response(result)

    @app.post("/api/wavebird/consent")
    async def write_consent(request: Request) -> Response:
        body = await request.body()
        result = await run_in_threadpool(server.consent_post, _publisher_request(request, body))
        return _fastapi_response(result)

    @app.post("/api/wavebird/generate")
    async def generate(request: Request) -> Response:
        body = await request.body()
        denied = server.authorize_generation(_publisher_request(request, body))
        if denied is not None:
            return _fastapi_response(denied)
        return await existing_generation(request)

    return app
