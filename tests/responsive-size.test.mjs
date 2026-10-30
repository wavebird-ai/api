import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const serverAsset = process.env.WAVEBIRD_JS_SERVER_ASSET
  ? pathToFileURL(process.env.WAVEBIRD_JS_SERVER_ASSET).href
  : new URL("../dist/server.js", import.meta.url).href;
const { createPublisherServer } = await import(serverAsset);

const saved = {
  clientId: "wbproj_responsive_test", secretKey: "sk_test_server_only",
  preferenceSecret: "0123456789abcdef0123456789abcdef",
  authorize: request => request.headers.get("authorization") === "Session publisher",
  publicOrigins: ["https://publisher.example"], surfaceId: "chat_assistant", placementKey: "default",
  jobType: "chat", locale: "de-DE", timing: "during", consentMode: "own_cmp", gdprApplies: false,
  publisher: { app_name: "Publisher Test", app_domain: "publisher.example", categories: [] },
  allowedFormats: ["banner"], positionHint: "between", maxWidth: 728, maxHeight: 250,
  allowedSizes: [{ width: 728, height: 90 }, { width: 320, height: 50 }, { width: 300, height: 250 }],
};
const request = (width, height = 250, headers = {}, format = "auto") => new Request("https://publisher.example/api/sponsor-slot", {
  method: "POST", headers: { host: "publisher.example", origin: "https://publisher.example", authorization: "Session publisher", "sec-fetch-site": "same-origin", ...headers },
  body: JSON.stringify({ session_id: "session_test", format, container_size: { width, height } }),
});

test("responsive selection binds one saved size to the measured container", async () => {
  const server = createPublisherServer(saved);
  const calls = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { calls.push(JSON.parse(init.body)); return Response.json({ decision: { fill: false }, placement: null }); };
  try {
    for (const [width, expected] of [[728, [728, 90]], [390, [320, 50]], [320, [320, 50]], [300, [300, 250]]]) {
      const result = await server.placementPOST(request(width));
      assert.equal(result.status, 200);
      const hint = calls.at(-1).slot_hint;
      assert.deepEqual(hint.allowed_sizes, [{ width: expected[0], height: expected[1] }]);
      assert.ok(hint.max_width <= width);
    }
    assert.equal(calls.length, 4);
  } finally { globalThis.fetch = old; }
});

test("responsive format binding uses saved sizes for Banner and Native without leaking annotations upstream", async () => {
  const server = createPublisherServer({ ...saved, allowedFormats: ["banner", "native"],
    allowedSizes: [
      { width: 728, height: 90, formats: ["banner"] },
      { width: 320, height: 50, formats: ["banner"] },
      { width: 300, height: 250, formats: ["native"] },
    ] });
  const calls = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { calls.push(JSON.parse(init.body)); return Response.json({ decision: { fill: false }, placement: null }); };
  try {
    await server.placementPOST(request(728, 250, {}, "banner"));
    await server.placementPOST(request(390, 250, {}, "native"));
    await server.placementPOST(request(390, 250));
    assert.deepEqual(calls.map(call => [call.slot_hint.allowed_sizes, call.overrides.allowed_formats]), [
      [[{ width: 728, height: 90 }], ["banner"]],
      [[{ width: 300, height: 250 }], ["native"]],
      [[{ width: 320, height: 50 }], ["banner"]],
    ]);
    assert.equal((await server.placementPOST(request(320, 90, {}, "native"))).status, 200);
    assert.equal(calls.length, 3);
    assert.equal((await server.placementPOST(request(390, 250, {}, "clip"))).status, 400);
    assert.equal(calls.length, 3);
  } finally { globalThis.fetch = old; }
});

test("too narrow, invalid, unauthorized, and foreign-origin requests never call Wavebird", async () => {
  const server = createPublisherServer(saved);
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected upstream call"); };
  try {
    const noFit = await server.placementPOST(request(290));
    assert.equal(noFit.status, 200);
    assert.deepEqual(await noFit.json(), { decision: { fill: false, reason: "no_fit" }, placement: null });
    assert.equal((await server.placementPOST(request(0))).status, 400);
    assert.equal((await server.placementPOST(request(728, 0))).status, 400);
    assert.equal((await server.placementPOST(request(728, 250, { authorization: "" }))).status, 401);
    assert.equal((await server.placementPOST(request(728, 250, { origin: "https://foreign.example" }))).status, 403);
    assert.equal((await server.placementPOST(request(728, 250, { "sec-gpc": "1" }))).status, 403);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = old; }
});
