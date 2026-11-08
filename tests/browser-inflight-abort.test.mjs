import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublisherAds } from "../dist/browser.js";

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test("late raw response after abort or turn change is not consumed", async () => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, replaceChildren() {}, remove() {} }),
    querySelector: () => null,
  };
  globalThis.window = {
    wavebird: { createChatSponsor: () => ({ prepare: async () => {}, dispose() {}, setConversation() {} }) },
    addEventListener() {}, removeEventListener() {},
  };
  let ads;
  try {
    ads = createPublisherAds({ target: { append() {} }, clientId: "wbproj_synthetic",
      surfaceId: "chat_assistant", jobType: "chat", userId: "user_synthetic",
      conversationId: "conversation_synthetic", timing: "after", consentMode: "own_cmp" });
    await ads.ready;
    for (const mode of ["abort", "turn_change"]) {
      const pending = deferred();
      const controller = new AbortController();
      let consumed = 0;
      const generation = ads.connectGeneration({ signal: controller.signal,
        request: () => pending.promise,
        consume: async response => { consumed++; return response.text(); },
      });
      if (mode === "abort") controller.abort();
      else ads.setConversation({ userId: "user_next", conversationId: "conversation_next" });
      pending.resolve(new Response("stale model result", { status: 200 }));
      await assert.rejects(generation, /generation_aborted/, mode);
      assert.equal(consumed, 0, mode);
    }
    const consumerEntered = deferred(), consumerRelease = deferred();
    const controller = new AbortController();
    const whileConsuming = ads.connectGeneration({ signal: controller.signal,
      request: async () => new Response("synthetic model result", { status: 200 }),
      consume: async response => {
        consumerEntered.resolve();
        await consumerRelease.promise;
        return response.text();
      },
    });
    await consumerEntered.promise;
    controller.abort();
    consumerRelease.resolve();
    await assert.rejects(whileConsuming, /generation_aborted/, "abort during raw consumption");
  } finally {
    ads?.dispose(); globalThis.window = oldWindow; globalThis.document = oldDocument;
  }
});
