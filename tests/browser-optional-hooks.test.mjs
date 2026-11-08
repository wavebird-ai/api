import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublisherAds } from "../dist/browser.js";

test("invalid optional browser hooks fail before appending a slot", async () => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  let appended = 0;
  const received = [];
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, replaceChildren() {}, remove() {} }),
    querySelector: selector => {
      if (selector === "[") throw new SyntaxError("invalid selector");
      return null;
    },
  };
  globalThis.window = {
    wavebird: { createChatSponsor: options => {
      received.push(options);
      return { prepare: async () => {}, dispose() {} };
    } },
    addEventListener() {}, removeEventListener() {},
  };
  const valid = { target: { append() { appended++; } }, clientId: "wbproj_synthetic",
    surfaceId: "chat_assistant", jobType: "chat", userId: "user_synthetic",
    conversationId: "conversation_synthetic", consentMode: "wavebird_consent" };
  try {
    for (const getFormat of [null, false, 0, "banner", {}]) {
      assert.throws(() => createPublisherAds({ ...valid, getFormat }), /publisher_format_hook_invalid/);
      assert.equal(appended, 0);
    }
    for (const privacySettingsTarget of [null, false, 0, "", "["]) {
      assert.throws(() => createPublisherAds({ ...valid, privacySettingsTarget }), /publisher_privacy_target_invalid/);
      assert.equal(appended, 0);
    }
    const getFormat = () => "banner";
    const ads = createPublisherAds({ ...valid, getFormat, privacySettingsTarget: "#privacy-settings" });
    await ads.ready;
    assert.equal(received[0].getFormat, getFormat);
    ads.dispose();
  } finally {
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});
