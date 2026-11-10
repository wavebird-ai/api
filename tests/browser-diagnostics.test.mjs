import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublisherAds } from "../dist/browser.js";

for (const failure of ["throw", "reject", "pending"]) test(`diagnostics contain ${failure} callbacks and report only observed CSP without URLs`, async () => {
  const listeners = new Map();
  const slotListeners = new Map();
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, append() {}, remove() {},
      addEventListener: (type, fn) => slotListeners.set(type, fn),
      removeEventListener: (type) => slotListeners.delete(type),
    }),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {},
    wavebird: { createChatSponsor: () => ({ prepare: async () => {}, dispose() {} }) } };
  const events = [];
  const ads = createPublisherAds({ target: { append() {} }, clientId: "wbproj_test", surfaceId: "chat", jobType: "chat",
    userId: "user", conversationId: "conversation", onDiagnostic: event => {
      events.push(event);
      if (failure === "throw") throw new Error("ignored sink failure");
      if (failure === "reject") return Promise.reject(new Error("ignored sink failure"));
      return new Promise(() => {});
    } });
  await ads.ready;
  const dispatch = listeners.get("securitypolicyviolation");
  const blocked = { disposition: "enforce", effectiveDirective: "frame-src", blockedURI: "https://api.wavebird.ai/v1/render/secret?token=never-print" };
  dispatch({ ...blocked, disposition: "report" });
  dispatch({ ...blocked, blockedURI: "https://unrelated.invalid/" });
  dispatch({ ...blocked, effectiveDirective: "img-src" });
  assert.deepEqual(events, []);
  dispatch(blocked);
  assert.deepEqual(events, [{ code: "renderer_csp_blocked" }]);
  slotListeners.get("ad:render_failed")({ detail: { reason: "untrusted-secret-value" } });
  assert.deepEqual(events[1], { code: "renderer_frame_unavailable" });
  ads.dispose();
  assert.equal(listeners.has("securitypolicyviolation"), false);
  dispatch(blocked);
  assert.equal(events.length, 2);
  assert.equal(slotListeners.size, 0);
  await new Promise(resolve => setImmediate(resolve));
});
