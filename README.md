# @wavebirdai/api

Add Wavebird Banner, Native, and Clip placements to an authenticated chat app. The package provides server handlers for placement, consent, and generation reporting, plus a browser adapter for the hosted renderer. Your server keeps the Wavebird key; your app keeps control of its login, model stream, layout, and consent choice.

## Integrate with Next.js

You need a saved Wavebird Test project and placement in Dashboard, a Server Test Key, an existing authenticated Next.js App Router app, and a durable turn store. Start with the placement's saved formats, sizes, timing, and consent mode. Test traffic is nonpayable.

1. Install the package and generate the route files for your app directory:

   ```sh
   npm install @wavebirdai/api@0.1.0-beta.5
   ./node_modules/.bin/wavebird-next init --lang ts --root . --app-dir src/app
   ```

   Use `--lang js --app-dir app` for a JavaScript app with `app/` at the project root. The generator adds files without overwriting existing ones and writes `WAVEBIRD-SETUP.md` with the exact connection points.

2. Set the server-only values in your deployment environment:

   ```dotenv
   WAVEBIRD_CLIENT_ID=<saved-project-id>
   WAVEBIRD_SECRET_KEY=<server-test-key>
   WAVEBIRD_PREFERENCE_SECRET=<stable-random-value-at-least-32-bytes>
   WAVEBIRD_PUBLIC_ORIGINS=https://your-app.example
   ```

   `WAVEBIRD_PUBLIC_ORIGINS` must contain each exact app origin, including scheme and port. For local Server Test-key work, add the exact loopback origin to this list while keeping the Dashboard project domain at its real HTTPS host. Never expose the server key or preference secret through `NEXT_PUBLIC_`, client props, or source control.

3. Connect the generated files to your app: copy the **saved** placement settings into `lib/publisher`; have `lib/auth` validate the real logged-in request and return a stable, non-credential session ID; replace `lib/turn-store` with your persistent store; and connect `lib/model` to your existing generation stream. The supplied auth, store, and model hooks fail closed until you do this. If you use PostgreSQL, the provided adapter uses your existing pool and its `install()` belongs in your normal migration step.

   The generated server route keeps the Wavebird key on the server and wraps your existing stream:

   ```ts
   import { getPublisher } from "../../../lib/publisher";
   import { existingGeneration } from "../../../lib/model";

   export async function POST(request: Request): Promise<Response> {
     return getPublisher().withGeneration({ request, run: existingGeneration });
   }
   ```

4. Mount the generated `WavebirdPlacement` beside your app's result area using real authenticated user and conversation IDs, then wrap the existing generation request:

   ```tsx
   <WavebirdPlacement
     clientId={publicProjectId}
     userId={authenticatedUserId}
     conversationId={activeConversationId}
     onReady={setAds}
   />

   await ads.connectGeneration({
     signal,
     request: headers => fetch("/api/generate", { method: "POST", headers, signal }),
     consume: async (response, lifecycle) => {
       if (!response.ok || !response.body) throw new Error("generation_unavailable");
       const reader = response.body.getReader();
       while (true) {
         const next = await reader.read();
         if (next.done) break;
         // Forward next.value to your existing stream consumer.
         lifecycle.onDelta();
       }
     },
   });
   ```

   The generated `WAVEBIRD-SETUP.md` shows where the component and routes go. Use Wavebird's consent dialog only when that matches the saved project; for `own_cmp`, connect your actual CMP lifecycle.

5. Validate in Test: confirm the saved format and size, consent and GPC behavior, No-Fill, Stop/abort, and late responses. The generation result must continue independently of the ad path. Move to another package version or Live only through your normal project approval process.

JavaScript and TypeScript use this same package. Complete Next.js JavaScript and TypeScript examples are included in `node_modules/@wavebirdai/api/examples/next-js` and `node_modules/@wavebirdai/api/examples/next-ts`. For other frameworks, use the explicit `@wavebirdai/api/server` and `@wavebirdai/api/browser` exports described below. The [REST reference](https://wavebird.ai/api/reference/endpoints) covers integrations without this package. The established [`wavebird`](https://www.npmjs.com/package/wavebird) SDK is a separate package.

## Server and browser boundary

`@wavebirdai/api/server` exports `createPublisherServer`. Configure it with server-only Project ID, Server Test or production Key, preference signing secret, the publisher's real request authorization function, exact `publicOrigins`, and the saved project/placement values shown in the dashboard. The origin list is required. The package compares the browser Origin with a configured public origin whose host matches the route Host, even when Next.js or a proxy gives the route an internal URL. `localhost` and `127.0.0.1` are separate origins, and each port and scheme must match exactly; HTTP loopback is available only with a Server Test Key. A production key also requires its separately approved project and Wavebird server authority. Omit `bidfloor` and `bidfloorCurrency` to inherit saved pricing. An explicit override supplies both a nonnegative amount, including zero, and a three-letter currency; the API validates it against the saved project. It returns authenticated `placementPOST`, `consentGET`, `consentPOST`, and `withGeneration` handlers, plus the server-only `reportGeneration(jobId, event)` method. The helper constructs the existing `/v1/placements`, `/v1/consent`, and `/v1/jobs/{id}/generation/{event}` requests; it does not introduce a new Wavebird protocol. The Wavebird API remains authoritative for saved scope, creative formats, duration, fallback, and financial classification.

Responsive size selection is enabled by default in this version. The browser adapter sends the measured reserved container size. The server chooses one of the saved `allowedSizes` that fits, or returns `no_fit` without an upstream placement request. Numeric `maxWidth` and `maxHeight` are optional advanced caps: when omitted, the saved sizes define the envelope; when supplied, they can only narrow eligible sizes. A size can carry `formats: ["banner"]`, `formats: ["native"]`, `formats: ["clip"]`, or an approved combination; this annotation remains on the publisher server and is stripped from the wavebird request. A browser format preference is accepted only when it is among the saved `allowedFormats` and compatible with the selected size. Set `responsiveSizeSelection: false` only for a deliberate fixed-size compatibility integration. Reserve enough height for the selected creative and its controls; do not stretch the returned creative or place it over the model result.

Create the server helper when a request arrives, as the included Next.js examples do. This lets Next.js build a publisher app without loading its server key into the build process; the helper still validates configuration before handling traffic.

`withGeneration({ request, run, onLifecycle })` accepts an optional server-side observer. It receives `{ type, sessionId, generationId }` for `started` and one terminal state: `done`, `error`, or `abort`. Use it to forward lifecycle events to your own generation reporter; observer failures do not change the model response. It runs only for authenticated, same-origin requests with valid generation transport IDs. The callback is not awaited, and it receives no prompt or model bytes.

With `sessionIdForRequest` and `turnJournal` configured, the package validates the browser non-credential session ID against the publisher authenticated request, binds one turn to its authorized placement job, and automatically retries ordered generation reports. The PostgreSQL adapter uses the publisher existing pool; run its `install()` in the normal migration step. An unavailable journal suppresses ad placement while an authenticated model request can still run. The store and HMAC key must survive worker restarts. A durable per-project key-version guard rejects a changed preference secret before accepting another turn; pending reports can still reconcile. Coordinate key rotation after active turns are drained rather than clearing the guard while turns remain. This opt-in path requires a package version that includes these exports; earlier published versions retain their original behavior.

Call `reportGeneration` only from trusted server code with a job ID returned by an authorized placement. Its events are `started`, `finished`, and `failed`. The server key scopes the request at wavebird; invalid IDs or events are rejected locally, and each report has a five-second deadline and a parallel request limit. Reporting errors reject the returned promise so the caller can handle them outside the model response path.

`@wavebirdai/api/browser` exports the existing tested `createPublisherAds` and `connectPublisherGeneration` lifecycle helper. It loads the hosted renderer and attaches only to a reserved container selected by the publisher. Initialize it with the current app user and conversation IDs; pass optional same-origin `placementEndpoint` and `consentEndpoint` paths when using the server routes in this package. The helper forwards those paths to the hosted renderer. Keep the Server Key and preference signing secret in the server configuration; never pass them as browser options. Use the real wavebird consent dialog or the publisher's actual CMP. Consent on an idle page does not request an ad. For `during`, the helper displays only during an active generation. Its generation request and response stream run without waiting for consent synchronization, the ad response, or renderer readiness. It clears late responses on completion, error, abort, conversation change, GPC, or withdrawal.

For `after`, resolve the generation consumer only after your app presents the result. The browser helper waits for both the transport finish and that consumer before starting the placement. If presentation fails, reject the consumer so the placement does not start.

## Next.js

The package contains equivalent JavaScript and TypeScript Next.js example files in `examples/next-js` and `examples/next-ts`. Each shows a publisher-owned reserved slot outside the input and scrolling transcript, same-origin consent and placement routes, the server-only configuration, and an existing generation stream wrapped by `withGeneration`. Their authorization hook fails closed until connected to the publisher's actual session validation. The sample generation stream is a local demonstration and is meant to be replaced by the publisher's existing model call.

The required server-only values are `WAVEBIRD_CLIENT_ID`, `WAVEBIRD_SECRET_KEY`, `WAVEBIRD_PREFERENCE_SECRET`, and `WAVEBIRD_PUBLIC_ORIGINS`. Keep secrets outside browser bundles and source control. Set project surface, placement, job type, timing, formats, locale, consent profile, identity/domain, and ad-space dimensions from the saved dashboard configuration. Reserve space for the selected creative and controls without distorting it. The publisher positions the section in its own UI.

## Test scope

The browser and generation transport sources are included in the package. Before use in a publisher app, test the server routes, browser placement, consent, and generation lifecycle against its saved Test project and supported browser and host. Test traffic must remain nonpayable; installing this package does not activate Live ads.
