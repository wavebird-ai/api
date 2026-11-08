import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublisherAds } from "../dist/browser.js";

test("raw generation preserves the declared consumer lifecycle argument and model output", async () => {
  const priorWindow = globalThis.window, priorDocument = globalThis.document;
  const events = [];
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, replaceChildren() {}, remove() {} }),
    querySelector: () => null,
  };
  globalThis.window = {
    wavebird: { createChatSponsor: () => ({
      prepare: async () => {}, onStarted: () => events.push("started"),
      onDelta: () => events.push("delta"), onDone: () => events.push("done"),
      onAbort: () => events.push("abort"), onError: () => events.push("error"), dispose() {},
    }) },
    addEventListener() {}, removeEventListener() {},
  };
  let ads;
  try {
    ads = createPublisherAds({ target: { append() {} }, clientId: "wbproj_synthetic",
      surfaceId: "chat_assistant", jobType: "chat", userId: "user_synthetic",
      conversationId: "conversation_synthetic", timing: "after", consentMode: "own_cmp" });
    await ads.ready;
    const answer = await ads.connectGeneration({
      request: async () => new Response("synthetic model result", { status: 200,
        headers: { "content-type": "text/plain" } }),
      consume: async (response, lifecycle) => {
        assert.equal(response.status, 200);
        assert.equal(typeof lifecycle.onDelta, "function");
        lifecycle.onDelta();
        return response.text();
      },
    });
    assert.equal(answer, "synthetic model result");
    assert.deepEqual(events, []);
  } finally {
    ads?.dispose();
    globalThis.window = priorWindow; globalThis.document = priorDocument;
  }
});
