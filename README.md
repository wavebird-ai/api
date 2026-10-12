# Wavebird publisher API

`@wavebirdai/api` is a GitHub pilot prerelease for Banner/Native integration with the existing Wavebird REST API and hosted renderer. It is not published to npm. The established [`wavebird`](https://www.npmjs.com/package/wavebird) SDK remains separate. Version `0.1.0-local.2` forwards the saved format selection to the hosted renderer for the After placement path. Earlier release assets remain unchanged.

## Installation

Install the versioned pilot asset directly from GitHub:

```sh
npm install https://github.com/wavebird-ai/api/releases/download/v0.1.0-local.2/wavebirdai-api-0.1.0-local.2.tgz
```

For local evaluation from a checkout, build and install the tarball instead:

```sh
npm run build
npm pack --pack-destination .
npm install /path/to/wavebirdai-api-0.1.0-local.2.tgz
```

The [full REST reference](https://wavebird.ai/api/reference/endpoints) remains available for integrations without this package.

Both JavaScript and TypeScript use the same package and URL; there is no separate language package.

For a saved single-format placement such as Banner-only After, pass `getFormat: () => "banner"` to `createPublisherAds` along with the matching same-origin placement endpoint. The package forwards that choice to the hosted renderer; the server still enforces the saved project and format. Omit `getFormat` when the saved placement intentionally lets Wavebird choose among supported formats.

## Next.js route generator

After installing the package, run one of these commands in an existing Next.js App Router project:

```sh
./node_modules/.bin/wavebird-next init --lang js --root . --app-dir app
./node_modules/.bin/wavebird-next init --lang ts --root . --app-dir src/app
```

Choose one language and the actual App Router directory. The command refuses to overwrite existing files. It installs `lib/publisher`, `lib/auth`, and a fail-closed `lib/model`; required `app/api/generate`, `app/api/sponsor-slot`, and `app/api/sponsor-consent` route files; `components/WavebirdPlacement`; and `WAVEBIRD-SETUP.md`. The `src/app` option puts `lib` and `components` under `src/`. These routes are application files produced by the generator, not implicit package exports. A complete standalone JS or TS Next.js example is also included in the package's `examples/` directory.

Set the server-only environment variables, insert actual saved Dashboard settings in `lib/publisher`, connect your real session check in `lib/auth`, and connect your existing model stream in `lib/model`. The supplied auth hook fails closed without its publisher-owned check path, and the generated model hook throws until replaced. The generated client component requires authenticated user and conversation IDs from the publisher. Mount it by the existing result area and call its returned ads object's `connectGeneration` around the existing request/stream consumer. The generated setup file shows the short entry point. Use your real consent lifecycle: the template selects Wavebird's consent dialog, while an `own_cmp` saved project must be wired to the publisher's actual CMP before any served test.

## Server and browser boundary

`@wavebirdai/api/server` exports `createPublisherServer`. Configure it with server-only Project ID, Server Test or Live Key, preference signing secret, the publisher's real request authorization function, and the saved project/placement values shown in the dashboard. It returns authenticated `placementPOST`, `consentGET`, `consentPOST`, and `withGeneration` handlers, plus the server-only `reportGeneration(jobId, event)` method. The helper constructs the existing `/v1/placements`, `/v1/consent`, and `/v1/jobs/{id}/generation/{event}` requests; it does not introduce a new Wavebird protocol or accept browser-supplied format or publisher overrides. The Wavebird API remains authoritative for saved scope, creative formats, duration, fallback, and financial classification.

`withGeneration({ request, run, onLifecycle })` accepts an optional server-side observer. It receives `{ type, sessionId, generationId }` for `started` and one terminal state: `done`, `error`, or `abort`. Use it to forward lifecycle events to your own generation reporter; observer failures do not change the model response. It runs only for authenticated, same-origin requests with valid generation transport IDs. The callback is not awaited, and it receives no prompt or model bytes.

Call `reportGeneration` only from trusted server code with a job ID returned by an authorized placement. Its events are `started`, `finished`, and `failed`. The server key scopes the request at Wavebird; invalid IDs or events are rejected locally, and each report has a five-second deadline and a parallel request limit. Reporting errors reject the returned promise so the caller can handle them outside the model response path.

`@wavebirdai/api/browser` exports the existing tested `createPublisherAds` and `connectPublisherGeneration` lifecycle helper. It loads the hosted renderer and attaches only to a reserved container selected by the publisher. Initialize it with the current app user and conversation IDs; pass optional same-origin `placementEndpoint` and `consentEndpoint` paths when using the server routes in this package. The helper forwards those paths to the hosted renderer. Keep the Server Key and preference signing secret in the server configuration; never pass them as browser options. Use the real Wavebird consent dialog or the publisher's actual CMP. Consent on an idle page does not request an ad. For `during`, the helper displays only during an active generation. Its generation request and response stream run without waiting for consent synchronization, the ad response, or renderer readiness. It clears late responses on completion, error, abort, conversation change, GPC, or withdrawal.

## Next.js

The package contains equivalent runnable JavaScript and TypeScript Next.js examples in `examples/next-js` and `examples/next-ts`. Each shows a publisher-owned reserved slot outside the input and scrolling transcript, same-origin consent and placement routes, the server-only configuration, and an existing generation stream wrapped by `withGeneration`. Their authorization hook fails closed until connected to the publisher's actual session validation. The sample generation stream is a local demonstration and is meant to be replaced by the publisher's existing model call.

The required server-only values are `WAVEBIRD_CLIENT_ID`, `WAVEBIRD_SECRET_KEY`, and `WAVEBIRD_PREFERENCE_SECRET`. Keep them outside browser bundles and source control. Set project surface, placement, job type, timing, formats, locale, consent profile, identity/domain, and ad-space dimensions from the saved dashboard configuration. Do not shrink the reserve below the saved creative envelope plus the 256px Banner/Native control space. The publisher positions the section in its own UI.

## Test scope

The browser and generation transport sources are included in this repository so the package builds without the dashboard repository. The server route wrapper is tested locally against the existing REST request shape and security boundaries. Browser and deployment acceptance still depend on normal QA and the final publisher onboarding gates. Test traffic must remain nonpayable; no npm publication or Live activation is part of this package preparation.
