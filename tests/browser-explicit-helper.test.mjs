import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublisherAds, connectPublisherGeneration } from "../dist/browser.js";

test("generation helper selects the explicit mount while preserving the legacy global call", async () => {
  const priorWindow = globalThis.window, priorDocument = globalThis.document, priorFetch = globalThis.fetch;
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, replaceChildren() {}, remove() {} }),
    querySelector: () => null,
  };
  globalThis.window = {
    wavebird: { createChatSponsor: () => ({ prepare: async () => {}, dispose() {} }) },
    addEventListener() {}, removeEventListener() {},
  };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/generate");
    calls.push({ session: init.headers.get("x-wavebird-session-id"),
      marker: init.headers.get("x-test") });
    return new Response("synthetic model result", { status: 200 });
  };
  let adsA, adsB;
  try {
    const common = { target: { append() {} }, clientId: "wbproj_synthetic",
      surfaceId: "chat_assistant", jobType: "chat", timing: "after", consentMode: "own_cmp",
      turnBinding: true };
    adsA = createPublisherAds({ ...common, userId: "user_a", conversationId: "conversation_a",
      sessionId: "session_a" });
    adsB = createPublisherAds({ ...common, userId: "user_b", conversationId: "conversation_b",
      sessionId: "session_b" });
    await Promise.all([adsA.ready, adsB.ready]);
    globalThis.window.publisherAds = adsA;
    const init = { method: "POST", headers: { "x-test": "safe" } };
    const consume = async (response, lifecycle) => {
      assert.equal(typeof lifecycle.onDelta, "function");
      lifecycle.onDelta();
      return response.text();
    };
    assert.equal(await connectPublisherGeneration("/api/generate", init, consume, adsB),
      "synthetic model result");
    assert.equal(await connectPublisherGeneration("/api/generate", init, consume),
      "synthetic model result");
    assert.deepEqual(calls, [
      { session: "session_b", marker: "safe" },
      { session: "session_a", marker: "safe" },
    ]);
  } finally {
    adsA?.dispose(); adsB?.dispose();
    globalThis.fetch = priorFetch;
    globalThis.window = priorWindow; globalThis.document = priorDocument;
  }
});
