"""Load saved Dashboard settings from server-only ENV and start the FastAPI bridge."""

import os

from wavebird_publisher import PublisherConfig, PublisherServer

from .app import create_app
from .publisher_hooks import authorize_publisher_request, existing_generation


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"Missing server setting: {name}")
    return value


def _sizes(value: str) -> tuple[tuple[int, int], ...]:
    try:
        sizes = tuple(tuple(int(part) for part in item.split("x")) for item in value.split(","))
    except ValueError as error:
        raise ValueError("WAVEBIRD_ALLOWED_SIZES must contain widthxheight values") from error
    if not sizes or any(len(size) != 2 for size in sizes):
        raise ValueError("WAVEBIRD_ALLOWED_SIZES must contain widthxheight values")
    return sizes


def configured_app():
    sizes = _sizes(_required("WAVEBIRD_ALLOWED_SIZES"))
    config = PublisherConfig(
        client_id=_required("WAVEBIRD_CLIENT_ID"),
        server_test_key=_required("WAVEBIRD_SECRET_KEY"),
        preference_secret=_required("WAVEBIRD_PREFERENCE_SECRET"),
        public_origins=tuple(item.strip() for item in _required("WAVEBIRD_PUBLIC_ORIGINS").split(",")),
        surface_id=_required("WAVEBIRD_SURFACE_ID"),
        placement_key=_required("WAVEBIRD_PLACEMENT_KEY"),
        job_type=_required("WAVEBIRD_JOB_TYPE"),
        locale=_required("WAVEBIRD_LOCALE"),
        timing=_required("WAVEBIRD_TIMING"),
        consent_mode=_required("WAVEBIRD_CONSENT_MODE"),
        publisher_name=_required("WAVEBIRD_APP_NAME"),
        publisher_domain=_required("WAVEBIRD_APP_DOMAIN"),
        allowed_formats=tuple(item.strip() for item in _required("WAVEBIRD_ALLOWED_FORMATS").split(",")),
        allowed_sizes=sizes,
        position_hint=_required("WAVEBIRD_POSITION_HINT"),
        max_width=max(width for width, _ in sizes),
        max_height=max(height for _, height in sizes),
        authorize=authorize_publisher_request,
    )
    return create_app(PublisherServer(config), existing_generation)


app = configured_app()
