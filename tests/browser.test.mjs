import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublisherAds } from "../dist/browser.js";

test("After Banner forwards the saved format to the hosted renderer", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const slot = { style: {}, setAttribute() {}, replaceChildren() {}, remove() {} };
  let received;
  globalThis.document = {
    createElement: () => slot,
    querySelector: () => null,
  };
  globalThis.window = {
    wavebird: { createChatSponsor(options) { received = options; return { prepare: async () => {}, dispose() {} }; } },
    addEventListener() {}, removeEventListener() {},
  };
  try {
    const ads = createPublisherAds({
      target: { append() {} }, clientId: "wbproj_savedafter", surfaceId: "chat_assistant",
      jobType: "chat", userId: "user_test", conversationId: "chat_test", timing: "after",
      consentMode: "own_cmp", placementEndpoint: "/api/package-after-slot",
      consentEndpoint: "/api/package-after-consent", getFormat: () => "banner",
    });
    await ads.ready;
    assert.equal(received.timing, "after");
    assert.equal(received.placementEndpoint, "/api/package-after-slot");
    assert.equal(received.getFormat(), "banner");
    ads.dispose();
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

test("built browser export follows active generation and discards a late response", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const events = [];
  const children = [];
  const target = { append(node) { children.push(node); } };
  const sponsor = {
    prepare: async () => {},
    onStarted: id => events.push(["started", id]),
    onDelta: id => events.push(["progress", id]),
    onDone: id => events.push(["done", id]),
    onAbort: id => events.push(["abort", id]),
    onError: id => events.push(["error", id]),
    dispose: () => events.push(["dispose"]),
  };
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, replaceChildren() {}, remove() {} }),
    querySelector: () => null,
  };
  globalThis.window = {
    wavebird: { createChatSponsor: options => {
      assert.equal(options.target, children[0]);
      assert.equal(options.timing, "during");
      assert.equal(options.placementEndpoint, "/api/sponsor-slot");
      assert.equal(options.consentEndpoint, "/api/sponsor-consent");
      assert.equal(options.getFormat(), "banner");
      assert.equal(options.secretKey, undefined);
      return sponsor;
    } },
    addEventListener() {}, removeEventListener() {},
  };

  const record = (headers, item) => JSON.stringify({
    session_id: headers["x-wavebird-session-id"],
    generation_id: headers["x-wavebird-generation-id"], ...item,
  }) + "\n";
  const transport = (headers, items) => new Response(items.map(item => record(headers, item)).join(""), {
    headers: { "x-wavebird-generation-transport": "1" },
  });

  try {
    const ads = createPublisherAds({
      target, clientId: "wbproj_test", surfaceId: "chat_assistant", jobType: "chat",
      timing: "during", consentMode: "own_cmp", userId: "user_test", conversationId: "chat_test",
      placementEndpoint: "/api/sponsor-slot", consentEndpoint: "/api/sponsor-consent",
      getFormat: () => "banner",
    });
    await ads.ready;
    assert.deepEqual(events, []);
    assert.equal(children.length, 1);

    const answer = await ads.connectGeneration({
      request: headers => transport(headers, [
        { type: "started" },
        { type: "response", status: 200, headers: [["content-type", "text/plain"]] },
        { type: "bytes", data: Buffer.from("hello").toString("base64") },
        { type: "done" },
      ]),
      consume: async (response, lifecycle) => {
        const result = await response.text();
        lifecycle.onDelta();
        return result;
      },
    });
    assert.equal(answer, "hello");
    assert.deepEqual(events.map(([kind]) => kind), ["started", "progress", "done"]);

    let release;
    const delayed = new Promise(resolve => { release = resolve; });
    const abort = new AbortController();
    let lateHeaders;
    const pending = ads.connectGeneration({
      signal: abort.signal,
      request: headers => { lateHeaders = headers; return delayed; },
      consume: async response => response.text(),
    });
    abort.abort();
    release(transport(lateHeaders, [
      { type: "started" },
      { type: "response", status: 200, headers: [] },
      { type: "bytes", data: Buffer.from("late").toString("base64") },
      { type: "done" },
    ]));
    await assert.rejects(pending);
    assert.deepEqual(events.map(([kind]) => kind), ["started", "progress", "done"]);
    ads.dispose();
    assert.equal(events.at(-1)[0], "dispose");
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

test("late renderer load cannot start a completed during placement", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  let script;
  let started = 0;
  const slot = { style: {}, setAttribute() {}, replaceChildren() {}, remove() {} };
  globalThis.document = {
    createElement: kind => kind === "script" ? (script = { remove() {} }) : slot,
    head: { append() {} },
    querySelector: () => null,
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try {
    const ads = createPublisherAds({
      target: { append() {} }, clientId: "wbproj_test", surfaceId: "chat_assistant", jobType: "chat",
      timing: "during", consentMode: "own_cmp", userId: "user_test", conversationId: "chat_test",
    });
    const answer = await ads.connectGeneration({
      request: headers => new Response([
        { type: "started" },
        { type: "response", status: 200, headers: [] },
        { type: "bytes", data: Buffer.from("done").toString("base64") },
        { type: "done" },
      ].map(item => JSON.stringify({ session_id: headers["x-wavebird-session-id"], generation_id: headers["x-wavebird-generation-id"], ...item }) + "\n").join(""),
      { headers: { "x-wavebird-generation-transport": "1" } }),
      consume: response => response.text(),
    });
    assert.equal(answer, "done");
    globalThis.window.wavebird = { createChatSponsor: options => {
      assert.equal(Object.hasOwn(options, "placementEndpoint"), false);
      assert.equal(Object.hasOwn(options, "consentEndpoint"), false);
      assert.equal(Object.hasOwn(options, "getFormat"), false);
      return {
        prepare: async () => {},
        onStarted: () => { started++; },
        dispose() {},
      };
    } };
    script.onload();
    await ads.ready;
    assert.equal(started, 0);
    ads.dispose();
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
