import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublisherAds, connectPublisherGeneration } from "../dist/browser.js";
import { generationTransport } from "../dist/generation.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function withAds(run) {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  const events = [];
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, replaceChildren() {}, remove() {} }),
    querySelector: () => null,
  };
  globalThis.window = {
    wavebird: { createChatSponsor: () => ({
      prepare: async () => {}, dispose() {}, setConversation() {},
      onStarted: () => events.push("started"), onDone: () => events.push("done"),
      onAbort: () => events.push("abort"), onError: () => events.push("error"),
    }) },
    addEventListener() {}, removeEventListener() {},
  };
  const ads = createPublisherAds({ target: { append() {} }, clientId: "wbproj_synthetic",
    surfaceId: "chat_assistant", jobType: "chat", userId: "user", conversationId: "conversation",
    timing: "after", consentMode: "own_cmp" });
  try { await ads.ready; await run(ads, events); }
  finally { ads.dispose(); globalThis.window = oldWindow; globalThis.document = oldDocument; }
}
function interrupt(mode, ads, controller) {
  if (mode === "abort") controller.abort();
  else if (mode === "dispose") ads.dispose();
  else ads.setConversation({ userId: "next_user", conversationId: "next_conversation" });
}
function transport(headers) {
  return new Response([
    { type: "started" }, { type: "response", status: 200, headers: [] },
    { type: "bytes", data: btoa("synthetic result") }, { type: "done" },
  ].map(record => JSON.stringify({ ...record, session_id: headers["x-wavebird-session-id"],
    generation_id: headers["x-wavebird-generation-id"] }) + "\n").join(""), {
    headers: { "x-wavebird-generation-transport": "1" },
  });
}

for (const mode of ["abort", "dispose", "conversation_change"]) {
  test(`late browser response releases its body after ${mode}`, async () => withAds(async ads => {
    const response = deferred(), controller = new AbortController();
    let cancellations = 0, consumers = 0;
    const generation = ads.connectGeneration({ signal: controller.signal, request: () => response.promise,
      consume: async value => { consumers++; return value.text(); } });
    const rejected = assert.rejects(generation, /generation_aborted/);
    interrupt(mode, ads, controller);
    response.resolve(new Response(new ReadableStream({ cancel() { cancellations++; } })));
    await rejected; await tick();
    assert.equal(consumers, 0); assert.equal(cancellations, 1);
  }));

  test(`transport does not report success after ${mode} while presentation is pending`, async () => withAds(async (ads, events) => {
    const entered = deferred(), release = deferred(), controller = new AbortController();
    const generation = ads.connectGeneration({ signal: controller.signal, request: transport,
      consume: async response => { await response.text(); entered.resolve(); await release.promise; return "completed"; } });
    const rejected = assert.rejects(generation, /generation_aborted/);
    await entered.promise;
    interrupt(mode, ads, controller); release.resolve(); await rejected;
    assert.ok(!events.includes("done"));
  }));
}

test("a new submit invalidates a previous presentation without suppressing the new response", async () => withAds(async ads => {
  const entered = deferred(), release = deferred();
  const previous = ads.connectGeneration({ request: transport,
    consume: async response => { await response.text(); entered.resolve(); await release.promise; } });
  const rejected = assert.rejects(previous, /generation_aborted/);
  await entered.promise;
  assert.equal(await ads.connectGeneration({ request: async () => new Response("new response"),
    consume: response => response.text() }), "new response");
  release.resolve(); await rejected;
}));

test("a conversation change cancels an active transport reader", async () => withAds(async ads => {
  const entered = deferred(); let cancellations = 0;
  const generation = ads.connectGeneration({ request: headers => new Response(new ReadableStream({
    start(controller) {
      const records = [{ type: "started" }, { type: "response", status: 200, headers: [] }];
      controller.enqueue(new TextEncoder().encode(records.map(record => JSON.stringify({ ...record,
        session_id: headers["x-wavebird-session-id"], generation_id: headers["x-wavebird-generation-id"] }) + "\n").join("")));
    }, cancel() { cancellations++; },
  }), { headers: { "x-wavebird-generation-transport": "1" } }),
  consume: async response => { entered.resolve(); return response.text(); } });
  const rejected = assert.rejects(generation, /generation_aborted/);
  await entered.promise;
  ads.setConversation({ userId: "next_user", conversationId: "next_conversation" });
  await rejected; assert.equal(cancellations, 1);
}));

test("raw fallback supplies all declared callbacks without renderer events", async () => withAds(async (ads, events) => {
  const value = await ads.connectGeneration({ request: async () => new Response("raw result"),
    consume: (response, lifecycle) => { lifecycle.onDelta(); lifecycle.onPresented(); return response.text(); } });
  assert.equal(value, "raw result"); assert.deepEqual(events, []);
}));

test("the helper without an ads mount supplies all declared callbacks", async () => withAds(async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("raw result");
  try {
    assert.equal(await connectPublisherGeneration("https://publisher.example/generate", {}, (response, lifecycle) => {
      lifecycle.onDelta(); lifecycle.onPresented(); return response.text();
    }), "raw result");
  } finally { globalThis.fetch = oldFetch; }
}));

for (const cancellation of ["request_abort", "body_cancel", "abort_without_reading"]) {
  test(`late server response releases its body after ${cancellation}`, async () => {
    const controller = new AbortController(), pending = deferred(); let cancellations = 0;
    const response = generationTransport({ request: new Request("https://publisher.example/generate", {
      signal: controller.signal, headers: { "x-wavebird-session-id": "session", "x-wavebird-generation-id": "turn" },
    }), run: () => pending.promise });
    const reader = response.body.getReader();
    if (cancellation !== "abort_without_reading") await reader.read();
    if (cancellation === "body_cancel") await reader.cancel();
    else controller.abort();
    pending.resolve(new Response(new ReadableStream({ cancel() { cancellations++; } })));
    if (cancellation !== "body_cancel") {
      while (!(await reader.read()).done) {}
    }
    await tick(); assert.equal(cancellations, 1);
  });
}
