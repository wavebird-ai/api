# FastAPI publisher example

This example connects the versioned `wavebird-publisher-server` package to an existing FastAPI app. Install the exact wheel from its matching published release after checking its SHA-256, then set the saved project values as server-only environment variables. Keep the Server Test Key and Preference Secret out of Git, responses and browser code.

`run.py` reads `WAVEBIRD_CLIENT_ID`, `WAVEBIRD_SECRET_KEY`, `WAVEBIRD_PREFERENCE_SECRET`, `WAVEBIRD_PUBLIC_ORIGINS`, `WAVEBIRD_SURFACE_ID`, `WAVEBIRD_PLACEMENT_KEY`, `WAVEBIRD_JOB_TYPE`, `WAVEBIRD_LOCALE`, `WAVEBIRD_TIMING`, `WAVEBIRD_CONSENT_MODE`, `WAVEBIRD_APP_NAME`, `WAVEBIRD_APP_DOMAIN`, `WAVEBIRD_ALLOWED_FORMATS`, `WAVEBIRD_ALLOWED_SIZES` and `WAVEBIRD_POSITION_HINT`. Use the exact stored project values. `WAVEBIRD_PUBLIC_ORIGINS` is a comma-separated list of separately registered origins, including scheme and port. `WAVEBIRD_ALLOWED_SIZES` uses `320x50,300x250` syntax. Never infer these values from our QA wrapper.

Replace the session and generation hooks in `publisher_hooks.py` before accepting publisher traffic:

1. `session_id_for_request` must return the real server-validated app session ID. `authorize_publisher_request` derives its decision from that hook. The default denies access.
2. `existing_generation` must call the app's existing model stream and preserve its response and cancellation. Its default raises an error. Generation must continue when consent is refused, an ad is unavailable or placement is slow.

Mount a reserved ad container beside the AI result and load the package's same-origin `/api/wavebird/browser.js` module. Supply its real session and model response consumer hooks, the saved timing and slot size, and a real CMP or Wavebird dialog. The browser module loads the official `/v1/render.js` creative renderer. The package's single-process Test coordinator binds placement and generation by validated session and turn, with server-trusted job reporting. Use a shared turn store for multiple workers while retaining those guards. Verify a visible Banner, Native or Clip creative, its rendered event and a durable nonpayable project fact. No-Fill correctly leaves the slot empty; Clip also needs actual playback/completion evidence.

The local adapter test uses two synthetic publishers and proves auth, exact Origin, GPC, No-Fill and generation routing. It does **not** prove a served ad or a real publisher session.
