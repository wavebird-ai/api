import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const browserAsset = process.env.WAVEBIRD_PYTHON_BROWSER_ASSET
  ? pathToFileURL(process.env.WAVEBIRD_PYTHON_BROWSER_ASSET).href
  : new URL("../src/wavebird_publisher/browser.js", import.meta.url).href;
const { mountWavebirdPython } = await import(browserAsset);

function button() {
  const listeners = new Map();
  return {
    disabled: false,
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
    click() { listeners.get("click")?.(); },
  };
}

async function eventually(check) {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail("expected local browser state did not arrive");
}

test("Python renderer failure and publisher dispose preserve turn ownership", async () => {
  const original = { fetch: globalThis.fetch, document: globalThis.document,
    window: globalThis.window, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
  const runButton = button(), stopButton = button();
  const result = { items: [], textContent: "",
    replaceChildren() { this.items = []; }, append(value) { this.items.push(value); } };
  const slot = { style: {}, dataset: {}, hidden: true,
    parentElement: { getBoundingClientRect: () => ({ width: 400, height: 300 }) },
    getBoundingClientRect: () => ({ width: 400, height: 300 }),
    setAttribute() {}, replaceChildren() {} };
  let renders = 0, modelCalls = 0, placementCalls = 0, cleanupCalls = 0, consentReady = false;
  const failureCallbacks = [];
  globalThis.document = { createTextNode: value => value };
  globalThis.window = { addEventListener() {}, removeEventListener() {},
    wavebird: { renderPlacement: async ({ onRenderFailed }) => {
      renders++;
      failureCallbacks.push(onRenderFailed);
      if (renders === 1) return null;
      return () => { cleanupCalls++; };
    } } };
  Object.defineProperty(globalThis, "navigator", { configurable: true,
    value: { globalPrivacyControl: false } });
  globalThis.fetch = async (route, init = {}) => {
    if (route.endsWith("/consent") && init.method !== "POST")
      return Response.json({ preference: { state: "granted", expires_at: Date.now() + 60_000 } });
    if (route.endsWith("/consent")) {
      const request = JSON.parse(init.body);
      consentReady = true;
      return Response.json({ authoritative_consent: { lifecycle_state: "granted",
        revision: request.revision, expires_at_ms: Date.now() + 60_000 } });
    }
    if (route.endsWith("/generate")) { modelCalls++; return new Response("model result"); }
    if (route.endsWith("/placement")) {
      placementCalls++;
      return Response.json({ decision: { fill: true, format: "clip" },
        placement: { width: 320, height: 180 },
        authoritative_consent: { lifecycle_state: "granted", revision: 1,
          expires_at_ms: Date.now() + 60_000 } });
    }
    throw new Error("unexpected local route");
  };
  let dispose;
  try {
    dispose = mountWavebirdPython({ slot, promptInput: { value: "local fixture" }, runButton, stopButton,
      result, consentButton: button(), withdrawButton: button(),
      getSessionId: async () => "validated_session", consumeGeneration: async (response, _signal, append) => {
        append(await response.text());
      }, timing: "after", jobType: "chat", consentMode: "wavebird_consent", maxHeight: 300,
      getFormat: () => "clip" });
    await eventually(() => consentReady);
    runButton.click();
    await eventually(() => modelCalls === 1 && placementCalls === 1 && renders === 1);
    await eventually(() => slot.hidden === true);
    assert.deepEqual(result.items, ["model result"], "ad failure cannot erase the model answer");
    runButton.click();
    await eventually(() => modelCalls === 2 && placementCalls === 2 && renders === 2);
    assert.equal(slot.hidden, false, "a new turn can still show its placement");
    assert.deepEqual(result.items, ["model result"]);
    failureCallbacks[1]("media_error");
    assert.equal(slot.hidden, true, "late media failure clears only its own placement");
    assert.equal(cleanupCalls, 1);
    assert.deepEqual(result.items, ["model result"], "late ad failure cannot erase the model answer");
    runButton.click();
    await eventually(() => modelCalls === 3 && placementCalls === 3 && renders === 3);
    assert.equal(slot.hidden, false);
    failureCallbacks[1]("media_error");
    assert.equal(slot.hidden, false, "stale failure cannot clear the next turn");
    stopButton.click();
    assert.equal(slot.hidden, true);
    assert.equal(cleanupCalls, 2, "Stop owns only the current renderer cleanup");
    runButton.click();
    await eventually(() => modelCalls === 4 && placementCalls === 4 && renders === 4);
    assert.equal(slot.hidden, false);
    dispose(); // The publisher calls this from its sign-out or component teardown handler.
    assert.equal(slot.hidden, true);
    assert.equal(cleanupCalls, 3);
    failureCallbacks[3]("media_error");
    assert.equal(cleanupCalls, 3, "a signed-out placement cannot fail into another cleanup");
    runButton.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(modelCalls, 4, "the disposed host no longer starts generations");
  } finally {
    dispose?.();
    globalThis.fetch = original.fetch;
    globalThis.document = original.document;
    globalThis.window = original.window;
    if (original.navigator) Object.defineProperty(globalThis, "navigator", original.navigator);
    else delete globalThis.navigator;
  }
});
