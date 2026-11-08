import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublisherServer, derivePublisherTurnKeySecret } from "../src/server.js";

const options = {
  clientId: "wbproj_synthetic_edge", secretKey: "sk_test_synthetic_only",
  preferenceSecret: "synthetic-only-preference-secret-123456",
  authorize: async () => true,
  publicOrigins: ["https://preview.example.test"],
  surfaceId: "chat", placementKey: "default", jobType: "chat",
  locale: "en-US", timing: "during", consentMode: "wavebird_consent",
  publisher: { app_name: "Synthetic", app_domain: "preview.example.test", categories: ["IAB2"] },
  allowedFormats: ["banner"], positionHint: "below", allowedSizes: [{ width: 320, height: 50 }]
};

function setTemporaryGlobal(name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name);
}

test("server-side window alias and journal key work without a global Buffer", () => {
  const restoreWindow = setTemporaryGlobal("window", globalThis);
  const restoreBuffer = setTemporaryGlobal("Buffer", undefined);
  try {
    const server = createPublisherServer(options);
    assert.equal(typeof server.withGeneration, "function");
    assert.equal(typeof derivePublisherTurnKeySecret(options.preferenceSecret), "string");
  } finally { restoreBuffer(); restoreWindow(); }
});

test("a DOM environment still rejects the server entry point", () => {
  const restoreWindow = setTemporaryGlobal("window", globalThis);
  const restoreDocument = setTemporaryGlobal("document", {});
  try { assert.throws(() => createPublisherServer(options), /publisher_server_only/); }
  finally { restoreDocument(); restoreWindow(); }
});
