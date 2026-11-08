import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublisherAds } from "../dist/browser.js";

test("browser endpoint overrides stay on the publisher origin before renderer mount", async () => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  let mounted = 0;
  const received = [];
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, replaceChildren() {}, remove() {} }),
    querySelector: () => null,
  };
  globalThis.window = {
    location: { href: "https://publisher.example/web5/" },
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
    for (const field of ["placementEndpoint", "consentEndpoint"]) {
      for (const value of ["https://foreign.example/api", "//foreign.example/api", "javascript:alert(1)",
        "https://user:pass@publisher.example/api", "https://publisher.example/api#fragment", null, false, 0, ""]) {
        assert.throws(() => createPublisherAds({ ...valid, [field]: value }), /publisher_endpoint_invalid/, `${field}: ${value}`);
        assert.equal(mounted, 0);
      }
    }
    const ads = createPublisherAds({ ...valid,
      placementEndpoint: "./api/placement",
      consentEndpoint: "https://publisher.example/api/consent" });
    await ads.ready;
    assert.equal(received[0].placementEndpoint, "./api/placement");
    assert.equal(received[0].consentEndpoint, "https://publisher.example/api/consent");
    ads.dispose();
  } finally {
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});
