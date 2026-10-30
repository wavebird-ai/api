import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const browserAsset = process.env.WAVEBIRD_PYTHON_BROWSER_ASSET
  ? pathToFileURL(process.env.WAVEBIRD_PYTHON_BROWSER_ASSET).href
  : new URL("../src/wavebird_publisher/browser.js", import.meta.url).href;
const { mountWavebirdPython } = await import(browserAsset);

test("Python browser sends one measured size and a saved-format preference without refresh", async () => {
  const original = { fetch: globalThis.fetch, document: globalThis.document,
    window: globalThis.window, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
  const calls = [];
  let width = 390, modelCalls = 0, format = "native", releasePlacement;
  const button = () => {
    const listeners = new Map();
    return { disabled: false,
      addEventListener(name, listener) { listeners.set(name, listener); },
      removeEventListener(name) { listeners.delete(name); },
      click() { listeners.get("click")?.(); } };
  };
  const slot = { style: {}, dataset: {}, hidden: true,
    parentElement: { getBoundingClientRect: () => ({ width, height: 300 }) },
    getBoundingClientRect: () => ({ width: 390, height: 250 }),
    setAttribute() {}, replaceChildren() {} };
  const runButton = button();
  const result = { replaceChildren() {}, append() {}, textContent: "" };
  globalThis.document = { createTextNode: value => value };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { globalPrivacyControl: false } });
  globalThis.fetch = async (route, init = {}) => {
    if (route.endsWith("/consent") && init.method !== "POST")
      return Response.json({ preference: { state: "granted", expires_at: Date.now() + 60_000 } });
    if (route.endsWith("/consent")) {
      const request = JSON.parse(init.body);
      return Response.json({ authoritative_consent: { lifecycle_state: "granted", revision: request.revision,
        expires_at_ms: Date.now() + 60_000 } });
    }
    if (route.endsWith("/placement")) {
      const request = JSON.parse(init.body);
      calls.push(request);
      if (request.format === "clip") return Response.json({
        decision: { fill: true }, placement: { width: 640, height: 360 },
      });
      if (request.format === "banner") return new Promise(resolve => { releasePlacement = resolve; });
      return Response.json({ decision: { fill: false, reason: "no_fit" }, placement: null });
    }
    if (route.endsWith("/generate")) { modelCalls++; return new Response("model result"); }
    throw new Error("unexpected route");
  };
  try {
    const cleanup = mountWavebirdPython({ slot, promptInput: { value: "local synthetic input" },
      runButton, stopButton: button(), result, consentButton: button(), withdrawButton: button(),
      getSessionId: async () => "validated_session", consumeGeneration: async response => { await response.text(); },
      timing: "during", jobType: "chat", consentMode: "wavebird_consent", maxHeight: 250, getFormat: () => format });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(slot.style.minHeight, "250px");
    runButton.click();
    for (let i = 0; i < 20 && calls.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls, [{ session_id: "validated_session", turn_id: calls[0]?.turn_id,
      format: "native", container_size: { width: 390, height: 250 } }]);
    assert.match(calls[0].turn_id, /^[a-f0-9-]{36}$/);
    assert.equal(slot.hidden, true);
    assert.equal(calls.length, 1);
    width = 0;
    runButton.click();
    for (let i = 0; i < 20 && modelCalls < 2; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(modelCalls, 2);
    assert.equal(calls.length, 1);
    assert.equal(slot.dataset.wavebirdStatus, "no_fit");
    assert.equal(slot.hidden, true);
    width = 390;
    format = "clip";
    runButton.click();
    for (let i = 0; i < 20 && (calls.length < 2 || modelCalls < 3); i++)
      await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls[1].format, "clip");
    assert.deepEqual(calls[1].container_size, { width: 390, height: 250 });
    assert.equal(slot.dataset.wavebirdStatus, "no_fit", "oversized Clip is not rendered");
    assert.equal(slot.hidden, true);
    format = "banner";
    runButton.click();
    for (let i = 0; i < 20 && (calls.length < 3 || modelCalls < 4); i++)
      await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(typeof releasePlacement, "function");
    width = 280;
    releasePlacement(Response.json({ decision: { fill: true }, placement: { width: 320, height: 50 } }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(slot.dataset.wavebirdStatus, "no_fit", "resized slot rejects late creative");
    assert.equal(slot.hidden, true);
    format = "native";
    width = 319.9;
    runButton.click();
    for (let i = 0; i < 20 && (calls.length < 4 || modelCalls < 5); i++)
      await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls[3].container_size, { width: 319, height: 250 },
      "fractional CSS pixels round down before placement");
    assert.equal(modelCalls, 5);
    assert.equal(calls.length, 4, "zero-width turn made no placement request");
    cleanup();
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.document = original.document;
    globalThis.window = original.window;
    if (original.navigator) Object.defineProperty(globalThis, "navigator", original.navigator);
    else delete globalThis.navigator;
  }
});

test("visible creative cleans up after its host shrinks without restarting the model", async () => {
  const original = { fetch: globalThis.fetch, document: globalThis.document,
    window: globalThis.window, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    resizeObserver: Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver") };
  const listeners = new Map();
  let observerCallback, observerDisconnected = false;
  let width = 390, renderCount = 0, cleanupCount = 0, placementCalls = 0, modelCalls = 0;
  let answer = "";
  const button = () => {
    const events = new Map();
    return { disabled: false, addEventListener(name, listener) { events.set(name, listener); },
      removeEventListener(name) { events.delete(name); }, click() { events.get("click")?.(); } };
  };
  const slot = { style: {}, dataset: {}, hidden: true,
    parentElement: { getBoundingClientRect: () => ({ width, height: 250 }) },
    getBoundingClientRect: () => ({ width: 390, height: 250 }),
    setAttribute() {}, replaceChildren() {} };
  globalThis.document = { createTextNode: value => value };
  globalThis.window = {
    wavebird: { renderPlacement: async () => { renderCount++; return () => { cleanupCount++; }; } },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { globalPrivacyControl: false } });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect() { observerDisconnected = true; }
  } });
  globalThis.fetch = async (route, init = {}) => {
    if (route.endsWith("/consent") && init.method !== "POST")
      return Response.json({ preference: { state: "granted", expires_at: Date.now() + 60_000 } });
    if (route.endsWith("/consent")) {
      const request = JSON.parse(init.body);
      return Response.json({ authoritative_consent: { lifecycle_state: "granted", revision: request.revision,
        expires_at_ms: Date.now() + 60_000 } });
    }
    if (route.endsWith("/placement")) {
      placementCalls++;
      return Response.json({ decision: { fill: true }, placement: { width: 320, height: 50 },
        authoritative_consent: { lifecycle_state: "granted", revision: 1,
          expires_at_ms: Date.now() + 60_000 } });
    }
    if (route.endsWith("/generate")) { modelCalls++; return new Response("model result"); }
    throw new Error("unexpected route");
  };
  let dispose;
  try {
    const runButton = button();
    dispose = mountWavebirdPython({ slot, promptInput: { value: "synthetic input" }, runButton,
      stopButton: button(), result: { replaceChildren() {}, append() {}, textContent: "" },
      consentButton: button(), withdrawButton: button(), getSessionId: async () => "validated_session",
      consumeGeneration: async response => { answer = await response.text(); },
      timing: "after", jobType: "chat", consentMode: "wavebird_consent", maxHeight: 250, getFormat: () => "banner" });
    await new Promise(resolve => setTimeout(resolve, 0));
    runButton.click();
    for (let i = 0; i < 30 && renderCount === 0; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(renderCount, 1);
    assert.equal(slot.hidden, false);
    assert.equal(answer, "model result");
    width = 280;
    listeners.get("resize")?.();
    assert.equal(cleanupCount, 1, "active creative must release the renderer on shrink");
    assert.equal(slot.hidden, true);
    assert.equal(placementCalls, 1);
    assert.equal(modelCalls, 1);
    assert.equal(answer, "model result");
    width = 390;
    runButton.click();
    for (let i = 0; i < 30 && renderCount < 2; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(renderCount, 2);
    width = 279.9;
    observerCallback();
    assert.equal(cleanupCount, 2, "observer clears a creative after fractional zoom shrink");
    assert.equal(slot.hidden, true);
    assert.equal(placementCalls, 2);
    assert.equal(modelCalls, 2);
  } finally {
    dispose?.();
    assert.equal(observerDisconnected, true);
    globalThis.fetch = original.fetch;
    globalThis.document = original.document;
    globalThis.window = original.window;
    if (original.navigator) Object.defineProperty(globalThis, "navigator", original.navigator);
    else delete globalThis.navigator;
    if (original.resizeObserver) Object.defineProperty(globalThis, "ResizeObserver", original.resizeObserver);
    else delete globalThis.ResizeObserver;
  }
});

for (const [timing, expirySoon] of [["after", false], ["during", false], ["before", false], ["after", true]])
test(`${timing} Clip ${expirySoon ? "expires without a media event" : "clears only on the current natural completion callback"}`, async () => {
  const original = { fetch: globalThis.fetch, document: globalThis.document,
    window: globalThis.window, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
  const button = () => {
    const events = new Map();
    return { disabled: false, addEventListener(name, listener) { events.set(name, listener); },
      removeEventListener(name) { events.delete(name); }, click() { events.get("click")?.(); } };
  };
  const slot = { style: {}, dataset: {}, hidden: true,
    parentElement: { getBoundingClientRect: () => ({ width: 390, height: 250 }) },
    getBoundingClientRect: () => ({ width: 390, height: 250 }),
    setAttribute() {}, replaceChildren() {} };
  let renderOptions, cleanupCount = 0, modelCalls = 0, placementCalls = 0, releaseModel;
  const windowListeners = new Map();
  globalThis.document = { createTextNode: value => value };
  globalThis.window = { wavebird: { async renderPlacement(options) {
    renderOptions = options;
    return () => { cleanupCount++; };
  } }, addEventListener(name, listener) { windowListeners.set(name, listener); },
    removeEventListener(name) { windowListeners.delete(name); } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { globalPrivacyControl: false } });
  globalThis.fetch = async (route, init = {}) => {
    if (route.endsWith("/consent") && init.method !== "POST")
      return Response.json({ preference: { state: "granted", expires_at: Date.now() + 60_000 } });
    if (route.endsWith("/consent")) {
      const body = JSON.parse(init.body);
      return Response.json({ authoritative_consent: { lifecycle_state: "granted", revision: body.revision,
        expires_at_ms: Date.now() + 60_000 } });
    }
    if (route.endsWith("/placement")) {
      placementCalls++;
      return Response.json({ decision: { fill: true, format: "clip" }, placement: { width: 320, height: 180 },
        authoritative_consent: { lifecycle_state: "granted", revision: 1,
          expires_at_ms: Date.now() + (expirySoon ? 250 : 60_000) } });
    }
    if (route.endsWith("/generate")) { modelCalls++; return new Response("model result"); }
    throw new Error("unexpected route");
  };
  let dispose;
  try {
    const runButton = button(), stopButton = button();
    dispose = mountWavebirdPython({ slot, promptInput: { value: "synthetic input" }, runButton,
      stopButton, result: { replaceChildren() {}, append() {}, textContent: "" },
      consentButton: button(), withdrawButton: button(), getSessionId: async () => "validated_session",
      consumeGeneration: async response => {
        await response.text();
        if (timing !== "after") await new Promise(resolve => { releaseModel = resolve; });
      },
      timing, jobType: "chat", consentMode: "wavebird_consent", maxHeight: 250, getFormat: () => "clip" });
    await new Promise(resolve => setTimeout(resolve, 0));
    runButton.click();
    for (let i = 0; i < 30 && !renderOptions; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(slot.hidden, false);
    assert.equal(typeof renderOptions.onClipCompleted, "function");
    const firstCompletion = renderOptions.onClipCompleted;
    if (expirySoon) {
      await new Promise(resolve => setTimeout(resolve, 320));
      assert.equal(slot.hidden, true, "consent expiry removes a visible Clip without another media event");
      assert.equal(cleanupCount, 1);
      firstCompletion();
      assert.equal(cleanupCount, 1, "late completion after expiry does not repeat cleanup");
      return;
    }
    firstCompletion();
    assert.equal(slot.hidden, true, "natural end removes the final frame");
    assert.equal(cleanupCount, 1);
    firstCompletion();
    assert.equal(cleanupCount, 1, "duplicate completion does not repeat cleanup");
    assert.equal(modelCalls, 1);
    assert.equal(placementCalls, 1);
    releaseModel?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    runButton.click();
    for (let i = 0; i < 30 && placementCalls < 2; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(placementCalls, 2);
    assert.equal(slot.hidden, false);
    firstCompletion();
    assert.equal(cleanupCount, 1, "the old completion cannot clear a new turn");
    const interruptedCompletion = renderOptions.onClipCompleted;
    stopButton.click();
    assert.equal(slot.hidden, true, "Stop removes the current Clip immediately");
    assert.equal(cleanupCount, 2);
    interruptedCompletion();
    assert.equal(cleanupCount, 2, "a stopped Clip cannot complete visually afterward");
    releaseModel?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    runButton.click();
    for (let i = 0; i < 30 && placementCalls < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(slot.hidden, false);
    const pageExitCompletion = renderOptions.onClipCompleted;
    assert.equal(typeof windowListeners.get("pagehide"), "function");
    windowListeners.get("pagehide")();
    assert.equal(slot.hidden, true, "page exit removes the active Clip");
    assert.equal(cleanupCount, 3);
    pageExitCompletion();
    assert.equal(cleanupCount, 3, "page exit rejects late natural completion");
  } finally {
    releaseModel?.();
    dispose?.();
    globalThis.fetch = original.fetch;
    globalThis.document = original.document;
    globalThis.window = original.window;
    if (original.navigator) Object.defineProperty(globalThis, "navigator", original.navigator);
    else delete globalThis.navigator;
  }
});
