import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublisherAds } from "../dist/browser.js";

test("truthy wrong-type browser fields fail with named preflight categories", () => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  let appended = 0;
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, replaceChildren() {}, remove() {} }),
    querySelector: () => null,
  };
  globalThis.window = {
    location: { href: "https://publisher.example/web5/" },
    wavebird: { createChatSponsor: () => ({ prepare: async () => {}, dispose() {} }) },
    addEventListener() {}, removeEventListener() {},
  };
  const base = {
    target: { append() { appended++; } }, clientId: "wbproj_synthetic", surfaceId: "chat_assistant",
    jobType: "chat", userId: "user_synthetic", conversationId: "conversation_synthetic",
    sessionId: "trusted_session", turnBinding: true, timing: "after",
    consentMode: "wavebird_consent", rendererUrl: "https://api.wavebird.ai/v1/render.js",
    privacySettingsTarget: "#privacy-settings", getFormat: () => "banner",
    placementEndpoint: "/api/placement", consentEndpoint: "/api/consent",
  };
  const fields = [
    ["target", /Application container and session are required/],
    ["clientId", /publisher_project_invalid/],
    ["surfaceId", /publisher_placement_invalid/],
    ["jobType", /publisher_job_invalid/],
    ["userId", /Application container and session are required/],
    ["conversationId", /Application container and session are required/],
    ["sessionId", /publisher_trusted_session_required/],
    ["turnBinding", /publisher_turn_binding_invalid/],
    ["timing", /Invalid publisher configuration/],
    ["consentMode", /Invalid publisher configuration/],
    ["rendererUrl", /publisher_renderer_url_invalid/],
    ["privacySettingsTarget", /publisher_privacy_target_invalid/],
    ["getFormat", /publisher_format_hook_invalid/],
    ["placementEndpoint", /publisher_endpoint_invalid/],
    ["consentEndpoint", /publisher_endpoint_invalid/],
  ];
  try {
    for (const [field, category] of fields) {
      assert.throws(() => createPublisherAds({ ...base, [field]: {} }), category, field);
      assert.equal(appended, 0, field);
    }
    assert.equal(fields.length, 15);
  } finally {
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});
