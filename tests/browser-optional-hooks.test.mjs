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
    for (const consentLocale of [null, {}, "", "de;display:none", "en_US"]) {
      assert.throws(() => createPublisherAds({ ...valid, consentLocale }), /publisher_consent_locale_invalid/);
      assert.equal(appended, 0);
    }
    for (const consentTheme of [null, [], "dark", { html: "unsafe" }, { radius: -1 }, { spacing: 100 },
      { accentColor: "red;display:none" }, { fontFamily: "url(https://invalid)" }, { radius: NaN }]) {
      assert.throws(() => createPublisherAds({ ...valid, consentTheme }), /publisher_consent_theme_invalid/);
      assert.equal(appended, 0);
    }
    const getFormat = () => "banner";
    const consentTheme = { accentColor: "#123456", backgroundColor: "#ffffff", textColor: "#222222", radius: 0, spacing: 20, fontFamily: "Inter, sans-serif" };
    const ads = createPublisherAds({ ...valid, getFormat, privacySettingsTarget: "#privacy-settings", consentLocale: "de-CH", consentTheme });
    await ads.ready;
    assert.equal(received[0].getFormat, getFormat);
    assert.equal(received[0].consentLocale, "de-CH");
    assert.deepEqual(received[0].consentTheme, consentTheme);
    assert.notEqual(received[0].consentTheme, consentTheme, "renderer receives its own presentation object");
    ads.dispose();
  } finally {
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});
