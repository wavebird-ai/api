"""Mount the package-owned Wavebird lifecycle in an existing FastAPI app."""

from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import Response
from wavebird_publisher import PublisherRequest, PublisherServer
from wavebird_publisher.fastapi import mount_fastapi

from .publisher_hooks import session_id_for_request as default_session_id_for_request


def create_app(
    server: PublisherServer,
    existing_generation: Callable[[Request], Awaitable[Response]],
    session_id_for_request: Callable[[PublisherRequest], str | None] = default_session_id_for_request,
    *,
    host_app: FastAPI | None = None,
    turn_journal_path: str | None = None,
) -> FastAPI:
    return mount_fastapi(host_app or FastAPI(), server, session_id_for_request, existing_generation,
                         turn_journal_path=turn_journal_path)
