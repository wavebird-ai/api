"""Replace these two hooks with the publisher's existing server-side app logic."""

from fastapi import Request
from fastapi.responses import Response
from wavebird_publisher import PublisherRequest


def authorize_publisher_request(request: PublisherRequest) -> bool:
    """Validate the real server-side session here; the safe default denies access."""
    del request
    return False


async def existing_generation(request: Request) -> Response:
    """Connect the existing model stream, its response consumer and cancellation."""
    del request
    raise RuntimeError("Connect your existing authenticated generation stream")
