# Connect an existing FastAPI app

Install the [Python 0.1.0b9 wheel](../../README.md#install), FastAPI and your ASGI server in the app's environment. The example uses the package's existing `/v1` contract and keeps credentials server-side.

## 1. Set server configuration

`run.py` reads the following values. Copy the saved project settings rather than choosing new formats or origins in the browser.

| Purpose | Environment variables |
| --- | --- |
| Project and secrets | `WAVEBIRD_CLIENT_ID`, `WAVEBIRD_SECRET_KEY`, `WAVEBIRD_PREFERENCE_SECRET` |
| Origins | `WAVEBIRD_PUBLIC_ORIGINS` |
| Placement | `WAVEBIRD_SURFACE_ID`, `WAVEBIRD_PLACEMENT_KEY`, `WAVEBIRD_JOB_TYPE`, `WAVEBIRD_POSITION_HINT` |
| Consent and timing | `WAVEBIRD_CONSENT_MODE`, `WAVEBIRD_GDPR_APPLIES`, `WAVEBIRD_TIMING` |
| Publisher | `WAVEBIRD_APP_NAME`, `WAVEBIRD_APP_DOMAIN`, `WAVEBIRD_LOCALE` |
| Formats and sizes | `WAVEBIRD_ALLOWED_FORMATS`, `WAVEBIRD_ALLOWED_SIZES`, `WAVEBIRD_SIZE_FORMATS_JSON` |
| Turn storage | `WAVEBIRD_TURN_JOURNAL_PATH` |

Origins are comma-separated exact origins, including scheme and port. `www` and the bare domain are separate entries. Sizes use `320x50,300x250` syntax. A format map such as `[[320,50,["banner"]],[300,250,["native","clip"]]]` must cover every saved size with its actual allowed formats. These are syntax examples, not replacement project values.

The journal path must be absolute and durable, shared by the app's workers on one host. Keep secrets out of Git, responses and browser bundles.

## 2. Connect session and generation

In `publisher_hooks.py`:

- `session_id_for_request` returns the server-validated app session ID. Authorization derives from that hook. Its default denies access.
- `existing_generation` calls your existing model stream and preserves response and cancellation. Its default raises an error.

The example's `create_app(..., host_app=your_existing_app, turn_journal_path=...)` mounts package routes without replacing your routes or middleware. It uses `mount_fastapi` from the installed package. Do not call the example factory as though it were a package export.

## 3. Connect the browser

Load the package's same-origin `/api/wavebird/browser.js` module beside your reserved slot. Supply real session and model-response hooks, saved timing, job type, slot settings and consent mode. Resolve the consumer only after presenting the result. Dispose the browser integration on sign-out and teardown.

For an app mounted at `/app`, load the module under that mount and pass `apiBasePath: "/app"`. This accepts local path segments, not another origin. The module loads the official `https://api.wavebird.ai/v1/render.js` renderer.

## 4. Verify

Check the visible creative, reporting and a durable nonpayable project fact. Clip additionally needs playback and completion. Check No-Fill, refusal, withdrawal and Stop while confirming the model still works.

Local adapter tests cover routing and security controls. They do not replace visible browser checks. This SQLite path does not qualify a multi-host or serverless deployment.
