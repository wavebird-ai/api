# wavebird Python integration

Connect a Python server to wavebird placement, consent and generation reporting. The browser uses the official wavebird renderer. Banner, Native and Clip follow the saved project's formats and timing.

This is a separate package from `@wavebirdai/api`. Python and Web have independent versions. Live ads require separate project approval.

## Install

Use Python 3.11 or later. Download the wheel from the [0.1.0b9 release](https://github.com/wavebird-ai/api/releases/tag/python-v0.1.0b9). Verify its SHA-256 before installing:

```text
wavebird_publisher_server-0.1.0b9-py3-none-any.whl
86949813a16d895d54958d042833836f02264c7665a884c39b2094ada2538f34
```

In your app's virtual environment, install the downloaded file:

```sh
python -m pip install ./wavebird_publisher_server-0.1.0b9-py3-none-any.whl
```

The server exports are:

```python
from wavebird_publisher import PublisherConfig, PublisherServer
```

This import is not a complete configuration. Use the [FastAPI connection guide](examples/fastapi_app/README.md) for session, generation and browser hooks. FastAPI and an ASGI server are separate application dependencies. The wheel is distributed through GitHub Releases, not through this npm package.

## Configure and connect

1. Save the project settings and exact approved origins in [Dashboard](https://dashboard.wavebird.ai/wavebird). Keep the Server Key and Preference Secret on the server.
2. Configure `PublisherConfig` from those saved values. Use `server_key`. The older `server_test_key` name remains compatible for existing Test integrations.
3. Mount the FastAPI routes in your app and connect its real session validation and abortable model response. Default example hooks deny access or raise until connected.
4. Load the same-origin `/api/wavebird/browser.js` module beside a reserved slot. Connect the real response consumer and consent flow. Python alone does not display an ad.
5. Check the visible creative, its reporting and Test Logs. Test activity is nonpayable. No-Fill, denied consent or ad failures must leave model generation usable.

## Deployment

Use `turn_journal_path` on durable storage shared by workers on one host. The SQLite journal preserves turn bindings and pending generation reports across restarts. The in-memory coordinator remains compatible with older integrations. Multi-host and serverless deployments require a separately verified shared-store path.

The supplied FastAPI example enables responsive selection using saved sizes and format mappings. The low-level Python configuration does not enable it by default. Optional width and height caps can only narrow the saved envelope.

Each enabled format needs a visible integration check. Clip also needs playback and natural-end cleanup checks.

[API docs](https://wavebird.ai/api/quickstart) | [Integration paths](https://wavebird.ai/api/integration-paths) | [Troubleshooting](https://wavebird.ai/api/troubleshooting)
