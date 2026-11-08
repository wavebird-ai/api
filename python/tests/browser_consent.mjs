import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/wavebird_publisher/browser.js", import.meta.url), "utf8");
const { mountWavebirdPython } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

function element() {
  const handlers = new Map();
  return {
    style: {}, dataset: {}, hidden: true, disabled: false, value: "",
    parentElement: null,
    setAttribute() {},
    replaceChildren() { this.children = []; },
    append(value) { (this.children ??= []).push(value); },
    getBoundingClientRect() { return { width: 640, height: 360 }; },
    addEventListener(name, callback) { handlers.set(name, callback); },
    removeEventListener(name) { handlers.delete(name); },
    click() { handlers.get("click")?.(); },
  };
}

async function mounted(preference, consentStatus = 200) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true, value: { globalPrivacyControl: false },
  });
  globalThis.document = { createTextNode(value) { return value; } };
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (url.endsWith("/consent") && !options.method) {
      return { ok: true, json: async () => ({ preference }) };
    }
    if (url.endsWith("/consent")) {
      return { ok: consentStatus === 200, json: async () => ({
        authoritative_consent: {
          lifecycle_state: "granted", revision: options.body ? JSON.parse(options.body).revision : null,
          expires_at_ms: Date.now() + 60000,
        },
      }) };
    }
    if (url.endsWith("/generate")) return { ok: true };
    throw new Error("Unexpected request " + url);
  };
  const controls = Object.fromEntries(
    ["slot", "promptInput", "runButton", "stopButton", "result", "consentButton", "withdrawButton"]
      .map(name => [name, element()]),
  );
  const dispose = mountWavebirdPython({
    ...controls, choiceDialog: null, getSessionId: async () => "real-session",
    consumeGeneration: async (_response, _signal, add) => add("model answer"),
    timing: "after", consentMode: "wavebird_consent", maxHeight: 360,
    getFormat: () => "clip", jobType: "chat",
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  const restore = () => {
    dispose();
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
    globalThis.document = originalDocument;
  };
  return { requests, controls, restore };
}

test("reload submits the signed next revision", async () => {
  const state = await mounted({ state: "granted", revision: 5, expires_at: Date.now() + 60000 });
  try {
    const posts = state.requests.filter(item => item.body && item.url.endsWith("/consent"));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.revision, 6);
    assert.equal(posts[0].body.remember_for_30_days, false);
  } finally { state.restore(); }
});

test("missing revision and rejected restore never request placement", async () => {
  for (const [preference, status] of [
    [{ state: "granted", expires_at: Date.now() + 60000 }, 200],
    [{ state: "granted", revision: 5, expires_at: Date.now() + 60000 }, 409],
  ]) {
    const state = await mounted(preference, status);
    try {
      state.controls.promptInput.value = "harmless";
      state.controls.runButton.click();
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.deepEqual(state.controls.result.children, ["model answer"]);
      assert.equal(state.requests.filter(item => item.url.endsWith("/placement")).length, 0);
    } finally { state.restore(); }
  }
});
