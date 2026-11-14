# Connect generation to the displayed result

These are connection helpers, not complete apps. Use the same installed `@wavebirdai/api@0.1.0-beta.19` as your server routes.

- `ads` is the instance for this surface, returned by `createPublisherAds` or the generated component's `onReady` callback.
- `sendExistingRequest` sends your existing authenticated model request. Merge the provided headers into its headers and preserve its body and abort signal. Call the route wrapped by `withGeneration`.
- `consumeAndPresentResponse` is your existing response parser and UI consumer. Call `onDelta` as output becomes visible and `onPresented` when the result is presented. Resolve after presentation and reject on failure. Capture the same abort signal to stop your own UI updates after Stop or a new submit. For an image, do not report progress before the result is displayed.

## TypeScript

```ts
import type { PublisherAds, GenerationConsumer } from "@wavebirdai/api/browser";

export function runGeneration<T>(
  ads: PublisherAds,
  signal: AbortSignal,
  sendExistingRequest: (
    headers: Record<string, string>, signal: AbortSignal
  ) => Promise<Response>,
  consumeAndPresentResponse: GenerationConsumer<T>
): Promise<T> {
  return ads.connectGeneration({
    signal,
    request: headers => sendExistingRequest(headers, signal),
    consume: consumeAndPresentResponse,
  });
}
```

## JavaScript

```js
export function runGeneration(
  ads, signal, sendExistingRequest, consumeAndPresentResponse
) {
  return ads.connectGeneration({
    signal,
    request: headers => sendExistingRequest(headers, signal),
    consume: consumeAndPresentResponse,
  });
}
```

Both callbacks are available for every response in this version. For raw/model-only fallback responses they are no-ops; calling them does not start an ad or mark a failed ad as successful.

## Timing and cleanup

For `after`, the helper waits for the transport to finish and the consumer to resolve before requesting placement. Receiving the final byte is not the same as presenting the result.

For `during`, placement runs alongside generation. Retention depends on the format and surface. Do not add an unconditional stream-end hide action for all ads. The hosted renderer owns creative behavior, and the package enables Clip cleanup after playback. Follow the saved timing and the [format contract](https://wavebird.ai/api/concepts/ad-formats).

Pass the app's abort signal, update the conversation binding on conversation changes, and call `dispose()` on sign-out or surface teardown. Do not wait for renderer readiness before allowing model generation.
