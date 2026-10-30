import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const browserAsset = process.env.WAVEBIRD_PYTHON_BROWSER_ASSET
  ? pathToFileURL(process.env.WAVEBIRD_PYTHON_BROWSER_ASSET).href
  : new URL("../src/wavebird_publisher/browser.js", import.meta.url).href;
const { mountWavebirdPython } = await import(browserAsset);

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const button = () => {
  const listeners = new Map();
  return { disabled: false, addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); }, click() { listeners.get("click")?.(); } };
};
async function eventually(check) {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail("expected local lifecycle state did not arrive");
}

async function fixture({ timing, jobType = "chat", format = "banner", latePlacement = false,
  apiBasePath = "" }) {
  const original = { fetch: globalThis.fetch, document: globalThis.document,
    window: globalThis.window, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
  const first = deferred(), finish = deferred(), placement = deferred();
  const result = { items: [], replaceChildren() { this.items = []; }, append(item) { this.items.push(item); } };
  const slot = { style: {}, dataset: {}, hidden: true,
    parentElement: { getBoundingClientRect: () => ({ width: 400, height: 300 }) },
    getBoundingClientRect: () => ({ width: 400, height: 300 }),
    setAttribute() {}, replaceChildren() {} };
  const runButton = button(), stopButton = button();
  let renderCount = 0, cleanupCount = 0, completion, consentReady = false;
  const routes = [];
  globalThis.document = { createTextNode: value => value };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, wavebird: {
    async renderPlacement(options) {
      renderCount++;
      completion = options.onClipCompleted;
      return () => { cleanupCount++; };
    },
  } };
  Object.defineProperty(globalThis, "navigator", { configurable: true,
    value: { globalPrivacyControl: false } });
  globalThis.fetch = async (route, init = {}) => {
    routes.push(route);
    if (route.endsWith("/consent") && init.method !== "POST")
      return Response.json({ preference: { state: "granted", expires_at: Date.now() + 60_000 } });
    if (route.endsWith("/consent")) {
      const request = JSON.parse(init.body);
      consentReady = true;
      return Response.json({ authoritative_consent: { lifecycle_state: "granted",
        revision: request.revision, expires_at_ms: Date.now() + 60_000 } });
    }
    if (route.endsWith("/placement")) {
      if (latePlacement) await placement.promise;
      return Response.json({ decision: { fill: true, format }, placement: { width: 320, height: 180 },
        authoritative_consent: { lifecycle_state: "granted", revision: 1,
          expires_at_ms: Date.now() + 60_000 } });
    }
    if (route.endsWith("/generate")) return new Response("model result");
    throw new Error("unexpected local route");
  };
  const dispose = mountWavebirdPython({ slot, result, runButton, stopButton,
    promptInput: { value: "local fixture" }, consentButton: button(), withdrawButton: button(),
    getSessionId: async () => "validated_session",
    consumeGeneration: async (_response, _signal, append) => {
      await first.promise;
      append("first");
      await finish.promise;
      append("last");
    }, timing, jobType, apiBasePath, consentMode: "wavebird_consent", maxHeight: 300,
    getFormat: () => format });
  return { slot, result, runButton, stopButton, first, finish, placement, routes,
    ready: () => eventually(() => consentReady),
    renderCount: () => renderCount, cleanupCount: () => cleanupCount,
    completion: () => completion,
    async close() {
      first.resolve(); finish.resolve(); placement.resolve(); dispose();
      globalThis.fetch = original.fetch;
      globalThis.document = original.document;
      globalThis.window = original.window;
      if (original.navigator) Object.defineProperty(globalThis, "navigator", original.navigator);
      else delete globalThis.navigator;
    } };
}

test("Python successor requires the saved workload type before mounting", () => {
  const options = { slot: {}, promptInput: {}, runButton: {}, stopButton: {}, result: {},
    consentButton: {}, withdrawButton: {}, getSessionId() {}, consumeGeneration() {},
    timing: "during", consentMode: "wavebird_consent", maxHeight: 250 };
  assert.throws(() => mountWavebirdPython(options), /Invalid saved project presentation settings/);
  assert.throws(() => mountWavebirdPython({ ...options, jobType: "unsupported" }),
    /Invalid saved project presentation settings/);
  assert.throws(() => mountWavebirdPython({ ...options, jobType: "chat", apiBasePath: "https://foreign.example" }),
    /Invalid saved project presentation settings/);
  assert.throws(() => mountWavebirdPython({ ...options, jobType: "chat", apiBasePath: "/python5/../other" }),
    /Invalid saved project presentation settings/);
});

test("Python successor routes package requests within a validated app mount", async () => {
  const f = await fixture({ timing: "during", format: "banner", apiBasePath: "/python5/package" });
  try {
    await f.ready();
    f.runButton.click();
    await eventually(() => f.renderCount() === 1);
    f.first.resolve(); f.finish.resolve();
    await eventually(() => f.result.items.length === 2);
    assert.ok(f.routes.length >= 3);
    assert.ok(f.routes.every(route => route.startsWith("/python5/package/api/wavebird/")));
  } finally { await f.close(); }
});

test("Python successor ends During Clip at model finish and rejects late completion", async () => {
  const f = await fixture({ timing: "during", format: "clip" });
  try {
    await f.ready();
    f.runButton.click();
    await eventually(() => f.renderCount() === 1);
    f.first.resolve(); f.finish.resolve();
    await eventually(() => f.cleanupCount() === 1);
    assert.equal(f.slot.hidden, true);
    f.completion()();
    assert.equal(f.cleanupCount(), 1);
    assert.deepEqual(f.result.items, ["first", "last"]);
  } finally { await f.close(); }
});

test("Python successor rejects a During Clip placement arriving after model finish", async () => {
  const f = await fixture({ timing: "during", format: "clip", latePlacement: true });
  try {
    await f.ready();
    f.runButton.click();
    f.first.resolve(); f.finish.resolve();
    await eventually(() => f.result.items.length === 2);
    f.placement.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.renderCount(), 0);
    assert.equal(f.slot.hidden, true);
  } finally { await f.close(); }
});

test("Python successor removes During Image Banner/Native on result and keeps During Chat Banner/Native", async () => {
  for (const jobType of ["image", "chat"]) for (const format of ["banner", "native"]) {
    const f = await fixture({ timing: "during", format, jobType });
    try {
      await f.ready();
      f.runButton.click();
      await eventually(() => f.renderCount() === 1);
      f.first.resolve(); f.finish.resolve();
      await eventually(() => f.result.items.length === 2);
      if (jobType === "image") {
        await eventually(() => f.cleanupCount() === 1);
        assert.equal(f.slot.hidden, true);
      } else {
        assert.equal(f.cleanupCount(), 0);
        assert.equal(f.slot.hidden, false);
        f.stopButton.click();
        assert.equal(f.cleanupCount(), 1);
      }
    } finally { await f.close(); }
  }
});

test("Python successor ends Before placement at first output without dropping later model output", async () => {
  const f = await fixture({ timing: "before", format: "banner" });
  try {
    await f.ready();
    f.runButton.click();
    await eventually(() => f.renderCount() === 1);
    f.first.resolve();
    await eventually(() => f.cleanupCount() === 1);
    assert.deepEqual(f.result.items, ["first"]);
    f.finish.resolve();
    await eventually(() => f.result.items.length === 2);
    assert.deepEqual(f.result.items, ["first", "last"]);
    assert.equal(f.cleanupCount(), 1);
  } finally { await f.close(); }
});

test("Python successor keeps After Banner/Native with the presented answer until the next run", async () => {
  for (const format of ["banner", "native"]) {
    const f = await fixture({ timing: "after", format });
    try {
      await f.ready();
      f.runButton.click();
      f.first.resolve(); f.finish.resolve();
      await eventually(() => f.result.items.length === 2 && f.renderCount() === 1);
      assert.equal(f.cleanupCount(), 0);
      assert.equal(f.slot.hidden, false);
      f.runButton.click();
      assert.equal(f.cleanupCount(), 1);
      assert.equal(f.slot.hidden, true);
      await eventually(() => f.renderCount() === 2);
      assert.equal(f.slot.hidden, false);
      f.stopButton.click();
      assert.equal(f.cleanupCount(), 2);
      assert.equal(f.slot.hidden, true);
    } finally { await f.close(); }
  }
});
