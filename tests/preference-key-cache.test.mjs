import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublisherServer } from "../dist/server.js";

const options = {
  clientId: "wbproj_synthetic", secretKey: "sk_test_synthetic", authorize: () => true,
  publicOrigins: ["https://publisher.example"], surfaceId: "assistant", placementKey: "default",
  jobType: "chat", locale: "en-US", timing: "after", consentMode: "wavebird_consent",
  allowedFormats: ["banner"], allowedSizes: [{ width: 300, height: 250 }],
  publisher: { app_name: "Synthetic", app_domain: "publisher.example", categories: [] },
};
const request = (body, cookie) => new Request("https://publisher.example/consent", {
  method: body ? "POST" : "GET", headers: { host: "publisher.example", origin: "https://publisher.example",
    "content-type": "application/json", ...(cookie ? { cookie } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test("preference signing imports one non-exportable key per server instance without sharing secrets", async () => {
  const oldFetch = globalThis.fetch, oldImport = crypto.subtle.importKey;
  let imports = 0;
  crypto.subtle.importKey = function (...args) {
    imports++; assert.equal(args[3], false); assert.deepEqual(args[4], ["sign", "verify"]);
    return Reflect.apply(oldImport, this, args);
  };
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(init.body);
    return Response.json({ authoritative_consent: { lifecycle_state: input.lifecycle_state, revision: input.revision } });
  };
  try {
    const first = createPublisherServer({ ...options, preferenceSecret: "synthetic-first-preference-secret-at-least32" });
    const second = createPublisherServer({ ...options, preferenceSecret: "synthetic-second-preference-secret-at-least32" });
    let cookie;
    for (let revision = 1; revision <= 3; revision++) {
      const result = await first.consentPOST(request({ session_id: "synthetic_session",
        lifecycle_state: "granted", revision, remember_for_30_days: true }));
      assert.equal(result.status, 200); cookie = result.headers.get("set-cookie").split(";")[0];
    }
    assert.equal(imports, 1);
    const valid = await first.consentGET(request(null, cookie));
    assert.equal((await valid.json()).preference.state, "granted"); assert.equal(imports, 1);
    const foreign = await second.consentGET(request(null, cookie));
    assert.equal((await foreign.json()).preference, null); assert.equal(imports, 2);
    assert.throws(() => createPublisherServer({ ...options, preferenceSecret: "short" }), /preference_secret_required/);
  } finally { crypto.subtle.importKey = oldImport; globalThis.fetch = oldFetch; }
});
