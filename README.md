# Wavebird publisher API

`@wavebirdai/api` is a private, unpublished Banner/Native integration for the existing Wavebird REST API and hosted renderer. The established [`wavebird`](https://www.npmjs.com/package/wavebird) SDK remains separate. This package is prepared for a standalone `wavebird-ai/api` GitHub repository and local tarball installation; it is not configured for npm publication.

## Local installation

```sh
npm run build
npm pack --pack-destination .
# In a publisher project, install the resulting wavebirdai-api-0.1.0-local.0.tgz
npm install /path/to/wavebirdai-api-0.1.0-local.0.tgz
```

The [full REST reference](https://wavebird.ai/api/reference/endpoints) remains available for integrations without this package.

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
