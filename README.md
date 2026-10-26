# wavebird publisher API

`@wavebirdai/api` provides Banner/Native integration with the wavebird REST API and hosted renderer. Version `0.1.0-beta.1` is an opt-in prerelease. The pinned public GitHub `.4` and optional `.5` archives remain available; existing publishers keep their installed version unless they opt in. The established [`wavebird`](https://www.npmjs.com/package/wavebird) SDK remains separate.

## Installation

For the npm prerelease, run this in the existing Next.js app directory beside `package.json`:

```sh
npm install @wavebirdai/api@0.1.0-beta.1
```

The public `.4` GitHub asset uses fixed sizes. Public `.5` adds optional responsive selection. This prerelease corrects the responsive generator example and package guidance; neither public archive is overwritten. A version change does not migrate an existing integration automatically.

The [full REST reference](https://wavebird.ai/api/reference/endpoints) remains available for integrations without this package.

Both JavaScript and TypeScript use the same package and URL; there is no separate language package.

For a saved single-format placement such as Banner-only After, pass `getFormat: () => "banner"` to `createPublisherAds` along with the matching same-origin placement endpoint. The package forwards that choice to the hosted renderer; the server still enforces the saved project and format. Omit `getFormat` when the saved placement intentionally lets wavebird choose among supported formats.

## Next.js route generator

After installing the package, run one of these commands in an existing Next.js App Router project:

```sh
./node_modules/.bin/wavebird-next init --lang js --root . --app-dir app
./node_modules/.bin/wavebird-next init --lang ts --root . --app-dir src/app
```

Choose one language and the actual App Router directory. The command refuses to overwrite existing files. It installs `lib/publisher`, `lib/auth`, and a fail-closed `lib/model`; required `app/api/generate`, `app/api/sponsor-slot`, and `app/api/sponsor-consent` route files; `components/WavebirdPlacement`; and `WAVEBIRD-SETUP.md`. The `src/app` option puts `lib` and `components` under `src/`. These routes are application files produced by the generator, not implicit package exports. JS and TS Next.js example files are also included in the package's `examples/` directory; connect their authorization and generation hooks before use. The generated publisher lists two illustrative Banner sizes and enables responsive selection; replace both sizes with the exact saved project sizes before Test traffic.

Set the server-only environment variables, including `WAVEBIRD_PUBLIC_ORIGINS` with the exact scheme, host, and port where your app is opened. Keep the Dashboard project domain at its real HTTPS host; for local Server Test-key testing, add the exact loopback origin to this server-only list without changing that project domain. Browser Test Keys have a separate Allowed origins field in API Keys. Insert actual saved Dashboard settings in `lib/publisher`, connect your real session check in `lib/auth`, and connect your existing model stream in `lib/model`. The supplied auth hook fails closed without its publisher-owned check path, and the generated model hook throws until replaced. The generated client component requires authenticated user and conversation IDs from the publisher. Mount it by the existing result area and call its returned ads object's `connectGeneration` around the existing request/stream consumer. The generated setup file shows the short entry point. Use your real consent lifecycle: the template selects wavebird's consent dialog, while an `own_cmp` saved project must be wired to the publisher's actual CMP before any served test.

## Server and browser boundary

`@wavebirdai/api/server` exports `createPublisherServer`. Configure it with server-only Project ID, Server Test or Live Key, preference signing secret, the publisher's real request authorization function, exact `publicOrigins`, and the saved project/placement values shown in the dashboard. The origin list is required. The package compares the browser Origin with a configured public origin whose host matches the route Host, even when Next.js or a proxy gives the route an internal URL. `localhost` and `127.0.0.1` are separate origins, and each port and scheme must match exactly; HTTP is accepted only for loopback. It returns authenticated `placementPOST`, `consentGET`, `consentPOST`, and `withGeneration` handlers, plus the server-only `reportGeneration(jobId, event)` method. The helper constructs the existing `/v1/placements`, `/v1/consent`, and `/v1/jobs/{id}/generation/{event}` requests; it does not introduce a new wavebird protocol. The wavebird API remains authoritative for saved scope, creative formats, duration, fallback, and financial classification.

Responsive selection is opt-in with `responsiveSizeSelection: true`. The hosted browser adapter sends the measured reserved container size. The server chooses one of the saved `allowedSizes` that fits, or returns `no_fit` without an upstream placement request. A size can carry `formats: ["banner"]`, `formats: ["native"]`, or both; this annotation remains on the publisher server and is stripped from the wavebird request. A browser format preference is accepted only when it is among the saved `allowedFormats` and compatible with the selected size. Without opt-in, existing fixed-size requests retain their previous behavior. Reserve enough height for the selected creative and its controls; do not stretch the returned creative or place it over the model result.

Create the server helper when a request arrives, as the included Next.js examples do. This lets Next.js build a publisher app without loading its server-only Test key into the build process; the helper still validates configuration before handling traffic.

`withGeneration({ request, run, onLifecycle })` accepts an optional server-side observer. It receives `{ type, sessionId, generationId }` for `started` and one terminal state: `done`, `error`, or `abort`. Use it to forward lifecycle events to your own generation reporter; observer failures do not change the model response. It runs only for authenticated, same-origin requests with valid generation transport IDs. The callback is not awaited, and it receives no prompt or model bytes.

Call `reportGeneration` only from trusted server code with a job ID returned by an authorized placement. Its events are `started`, `finished`, and `failed`. The server key scopes the request at wavebird; invalid IDs or events are rejected locally, and each report has a five-second deadline and a parallel request limit. Reporting errors reject the returned promise so the caller can handle them outside the model response path.

`@wavebirdai/api/browser` exports the existing tested `createPublisherAds` and `connectPublisherGeneration` lifecycle helper. It loads the hosted renderer and attaches only to a reserved container selected by the publisher. Initialize it with the current app user and conversation IDs; pass optional same-origin `placementEndpoint` and `consentEndpoint` paths when using the server routes in this package. The helper forwards those paths to the hosted renderer. Keep the Server Key and preference signing secret in the server configuration; never pass them as browser options. Use the real wavebird consent dialog or the publisher's actual CMP. Consent on an idle page does not request an ad. For `during`, the helper displays only during an active generation. Its generation request and response stream run without waiting for consent synchronization, the ad response, or renderer readiness. It clears late responses on completion, error, abort, conversation change, GPC, or withdrawal.

## Next.js

The package contains equivalent JavaScript and TypeScript Next.js example files in `examples/next-js` and `examples/next-ts`. Each shows a publisher-owned reserved slot outside the input and scrolling transcript, same-origin consent and placement routes, the server-only configuration, and an existing generation stream wrapped by `withGeneration`. Their authorization hook fails closed until connected to the publisher's actual session validation. The sample generation stream is a local demonstration and is meant to be replaced by the publisher's existing model call.

The required server-only values are `WAVEBIRD_CLIENT_ID`, `WAVEBIRD_SECRET_KEY`, `WAVEBIRD_PREFERENCE_SECRET`, and `WAVEBIRD_PUBLIC_ORIGINS`. Keep secrets outside browser bundles and source control. Set project surface, placement, job type, timing, formats, locale, consent profile, identity/domain, and ad-space dimensions from the saved dashboard configuration. Do not shrink the reserve below the saved creative envelope plus the 256px Banner/Native control space. The publisher positions the section in its own UI.

## Test scope

The browser and generation transport sources are included in the package. Before use in a publisher app, test the server routes, browser placement, consent, and generation lifecycle against its saved Test project and supported browser and host. Test traffic must remain nonpayable; installing this package does not activate Live ads.
