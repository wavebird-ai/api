"""Connect these hooks to the publisher's existing server-side app logic."""

from fastapi import Request
from fastapi.responses import Response
from wavebird_publisher import PublisherRequest


def session_id_for_request(request: PublisherRequest) -> str | None:
    """Return the real server-validated session ID; the safe default denies access."""
    del request
    return None


def authorize_publisher_request(request: PublisherRequest) -> bool:
    return session_id_for_request(request) is not None


async def existing_generation(request: Request) -> Response:
    """Connect the existing model stream, its response consumer and cancellation."""
    del request
    raise RuntimeError("Connect your existing authenticated generation stream")
