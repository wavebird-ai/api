# FastAPI publisher example

This example connects the framework-neutral `wavebird-publisher-server` package to an existing FastAPI app. Install the wheel from the [versioned Python release](https://github.com/wavebird-ai/api/releases/tag/python-v0.1.0b1) after checking its SHA-256 against the release record, then set the saved project values as server-only environment variables. Keep the Server Test Key and Preference Secret out of Git, responses and browser code.

`run.py` reads `WAVEBIRD_CLIENT_ID`, `WAVEBIRD_SECRET_KEY`, `WAVEBIRD_PREFERENCE_SECRET`, `WAVEBIRD_PUBLIC_ORIGINS`, `WAVEBIRD_SURFACE_ID`, `WAVEBIRD_PLACEMENT_KEY`, `WAVEBIRD_JOB_TYPE`, `WAVEBIRD_LOCALE`, `WAVEBIRD_TIMING`, `WAVEBIRD_CONSENT_MODE`, `WAVEBIRD_APP_NAME`, `WAVEBIRD_APP_DOMAIN`, `WAVEBIRD_ALLOWED_FORMATS`, `WAVEBIRD_ALLOWED_SIZES` and `WAVEBIRD_POSITION_HINT`. Use the exact stored project values. `WAVEBIRD_PUBLIC_ORIGINS` is a comma-separated list of separately registered origins, including scheme and port. `WAVEBIRD_ALLOWED_SIZES` uses `320x50,300x250` syntax. Never infer these values from our QA wrapper.

Replace both functions in `publisher_hooks.py` before accepting publisher traffic:

1. `authorize_publisher_request` must validate the app's existing server-side session and return `True` only for an authenticated user. Its default is `False`.
2. `existing_generation` must call the app's existing model stream and preserve its response and cancellation. Its default raises an error. Generation must continue when consent is refused, an ad is unavailable or placement is slow.

Mount the browser's reserved ad container beside the AI result and connect its placement/consent routes to `/api/wavebird`. The browser component, real CMP or wavebird dialog, response consumer, abort signal and model stream are publisher app connections, not Python server defaults. Do not accept a browser-provided job ID for `report_generation`; obtain the Wavebird job ID from the trusted server-side placement lifecycle. Verify a visible Banner or Native creative, its `rendered` event and a durable nonpayable project fact. No-Fill correctly leaves the slot empty. Clip uses the separate REST path in this candidate.

The local adapter test uses two synthetic publishers and proves auth, exact Origin, GPC, No-Fill and generation routing. It does **not** prove a served ad or a real publisher session.
