"""Mount the package-owned Wavebird lifecycle in an existing FastAPI app."""

from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import Response
from wavebird_publisher import PublisherRequest, PublisherServer
from wavebird_publisher.fastapi import create_app as create_wavebird_app

from .publisher_hooks import session_id_for_request as default_session_id_for_request


def create_app(
    server: PublisherServer,
    existing_generation: Callable[[Request], Awaitable[Response]],
    session_id_for_request: Callable[[PublisherRequest], str | None] = default_session_id_for_request,
) -> FastAPI:
    return create_wavebird_app(server, session_id_for_request, existing_generation)
