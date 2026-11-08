import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublisherAds } from "../dist/browser.js";

test("nonboolean turn binding cannot silently disable trusted session binding", async () => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  let mounted = 0;
  const received = [];
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, replaceChildren() {}, remove() {} }),
    querySelector: () => null,
  };
  globalThis.window = {
    wavebird: { createChatSponsor: options => {
      received.push(options);
      return { prepare: async () => {}, dispose() {} };
    } },
    addEventListener() {}, removeEventListener() {},
  };
  const valid = { target: { append() { mounted++; } }, clientId: "wbproj_synthetic",
    surfaceId: "chat_assistant", jobType: "chat", userId: "user_synthetic",
    conversationId: "conversation_synthetic", consentMode: "own_cmp" };
  try {
    for (const turnBinding of [null, 0, "", "true", {}]) {
      assert.throws(() => createPublisherAds({ ...valid, turnBinding, sessionId: "trusted_session" }),
        /publisher_turn_binding_invalid/);
      assert.equal(mounted, 0);
    }
    const legacy = createPublisherAds({ ...valid, turnBinding: false });
    await legacy.ready;
    assert.equal(received[0].turnBinding, undefined);
    legacy.dispose();
    const bound = createPublisherAds({ ...valid, turnBinding: true, sessionId: "trusted_session" });
    await bound.ready;
    assert.equal(received[1].turnBinding, true);
    assert.equal(received[1].sessionId, "trusted_session");
    bound.dispose();
  } finally {
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});
