import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublisherServer, createPublisherTurnJournal } from "../dist/server.js";

const saved = {
  apiBaseUrl: "https://api.wavebird.ai",
  clientId: "wbproj_saved_test",
  secretKey: "sk_test_server_only",
  preferenceSecret: "0123456789abcdef0123456789abcdef",
  authorize: request => request.headers.get("authorization") === "Session publisher",
  publicOrigins: ["https://publisher.example"],
  surfaceId: "chat_assistant",
  placementKey: "default",
  jobType: "chat",
  locale: "de-DE",
  timing: "during",
  consentMode: "own_cmp",
  gdprApplies: true,
  publisher: { app_name: "Publisher Test", app_domain: "publisher.example", categories: ["IAB19"] },
  allowedFormats: ["banner"],
  positionHint: "between",
  maxWidth: 728,
  maxHeight: 90,
  allowedSizes: [{ width: 728, height: 90 }],
  responsiveSizeSelection: false,
  blockedCategories: ["IAB25"]
};

test("unknown server configuration fields fail closed", () => {
  assert.throws(() => createPublisherServer({ ...saved, unknownOption: true }), /publisher_option_unknown/);
  assert.throws(() => createPublisherServer({ ...saved, publisher: { ...saved.publisher, unknownOption: true } }), /publisher_identity_invalid/);
  assert.throws(() => createPublisherServer({ ...saved, allowedSizes: [{ width: 728, height: 90, unknownOption: true }] }), /publisher_sizes_invalid/);
});

const routeRequest = (path, body, headers = {}) => new Request(`https://publisher.example${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { host: "publisher.example", authorization: "Session publisher", origin: "https://publisher.example", "sec-fetch-site": "same-origin", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

test("opt-in server binds only a trusted session and exact turn before lifecycle reports", async () => {
  const calls = [];
  const journal = {
    placed: new Set(), generated: new Set(),
    async claimPlacement(turn) { calls.push(["claimPlacement", turn]); if (this.placed.has(turn.turnId)) return false; this.placed.add(turn.turnId); return true; },
    async releaseRejectedPlacement(turn) { calls.push(["releaseRejectedPlacement", turn]); this.placed.delete(turn.turnId); },
    async bind(turn, jobId) { calls.push(["bind", turn, jobId]); },
    async claimGeneration(turn) { calls.push(["claimGeneration", turn]); if (this.generated.has(turn.turnId)) return false; this.generated.add(turn.turnId); return true; },
    async phase(turn, event) { calls.push(["phase", turn, event]); },
  };
  const server = createPublisherServer({ ...saved, sessionIdForRequest: request =>
    request.headers.get("authorization") === "Session publisher" ? "trusted_session" : null,
    turnJournal: journal });
  const body = { session_id: "trusted_session", turn_id: "turn_one" };
  let upstream = 0;
  await withFetch(async () => { upstream++; return Response.json({ job_id: "job_synthetic", decision: { fill: false } }); }, async () => {
    assert.deepEqual(await (await server.sessionGET(routeRequest("/api/sponsor-session"))).json(), { session_id: "trusted_session" });
    assert.equal((await server.sessionGET(routeRequest("/api/sponsor-session", undefined, { authorization: "" }))).status, 401);
    assert.equal((await server.sessionGET(routeRequest("/api/sponsor-session", undefined, { origin: "https://foreign.example" }))).status, 403);
    assert.equal((await server.placementPOST(routeRequest("/api/sponsor-slot", { ...body, session_id: "forged" }))).status, 401);
    assert.equal((await server.placementPOST(routeRequest("/api/sponsor-slot", { ...body, turn_id: "bad turn" }))).status, 401);
    assert.equal((await server.placementPOST(routeRequest("/api/sponsor-slot", body, { origin: "https://foreign.example" }))).status, 403);
    assert.equal(upstream, 0);
    assert.equal((await server.placementPOST(routeRequest("/api/sponsor-slot", body))).status, 200);
    assert.equal((await server.placementPOST(routeRequest("/api/sponsor-slot", body))).status, 409);
  });
  assert.equal(upstream, 1);
  assert.equal(calls.find(([kind]) => kind === "bind")[2], "job_synthetic");
  assert.deepEqual(calls.find(([kind]) => kind === "bind")[1], {
    projectId: saved.clientId, surfaceId: saved.surfaceId, sessionId: "trusted_session", turnId: "turn_one",
  });
  const generation = () => routeRequest("/api/generate", {}, {
    "x-wavebird-session-id": "trusted_session", "x-wavebird-generation-id": "turn_one",
  });
  assert.equal((await server.withGeneration({ request: routeRequest("/api/generate", {}, {
    "x-wavebird-session-id": "forged", "x-wavebird-generation-id": "turn_one" }),
    run: () => { throw new Error("must_not_run"); } })).status, 401);
  const result = await server.withGeneration({ request: generation(), run: () => new Response("model result") });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("x-wavebird-generation-transport"), "1");
  assert.match(await result.text(), /model result|bW9kZWwgcmVzdWx0/);
  assert.deepEqual(calls.filter(([kind]) => kind === "phase").map(([, , phase]) => phase), ["started", "finished"]);
  assert.equal((await server.withGeneration({ request: generation(), run: () => { throw new Error("must_not_run"); } })).status, 409);
});

test("normal opt-in path automatically reports the bound job in order without model delay", async () => {
  const rows = new Map();
  const storage = {
    async atomic(scope, key, transition) {
      const id = `${scope}:${key}`;
      const { state, result } = transition(rows.get(id) ?? null);
      rows.set(id, state);
      return result;
    },
    async scan(scope, cursor, limit) {
      return [...rows.keys()].filter(id => id.startsWith(`${scope}:`)).map(id => id.slice(65))
        .filter(key => key > cursor).sort().slice(0, limit);
    },
  };
  let server;
  const journal = createPublisherTurnJournal({ storage,
    keySecret: "synthetic-stable-turn-key-secret-32-bytes",
    reportGeneration: (jobId, event) => server.reportGeneration(jobId, event),
  });
  server = createPublisherServer({ ...saved, sessionIdForRequest: () => "trusted_session", turnJournal: journal });
  const calls = [];
  await withFetch(async (url) => {
    calls.push(url);
    if (url.endsWith("/placements?wait_ms=1500"))
      return Response.json({ job_id: "job_synthetic", decision: { fill: false } });
    return Response.json({ accepted: true });
  }, async () => {
    const placement = await server.placementPOST(routeRequest("/api/sponsor-slot", {
      session_id: "trusted_session", turn_id: "turn_one",
    }));
    assert.equal(placement.status, 200);
    const result = await server.withGeneration({
      request: routeRequest("/api/generate", {}, {
        "x-wavebird-session-id": "trusted_session", "x-wavebird-generation-id": "turn_one",
      }),
      run: () => new Response("model result"),
    });
    assert.match(await result.text(), /bW9kZWwgcmVzdWx0/);
    for (let i = 0; i < 100 && calls.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(calls.map(url => new URL(url).pathname), [
      "/v1/placements", "/v1/jobs/job_synthetic/generation/started", "/v1/jobs/job_synthetic/generation/finished",
    ]);
  });
});

test("opt-in no-fill without a job remains empty and unbound", async () => {
  const calls = [];
  const journal = {
    async claimPlacement(turn) { calls.push(["claim", turn.turnId]); return true; },
    async releaseRejectedPlacement() { throw Error("unexpected release"); },
    async bind() { throw Error("no-fill must not bind"); },
    async claimGeneration() { return true; },
    async phase(_turn, event) { calls.push(["phase", event]); },
  };
  const server = createPublisherServer({ ...saved,
    sessionIdForRequest: () => "trusted_session", turnJournal: journal });
  let responseBody = { decision: { fill: false }, placement: null };
  await withFetch(async () => Response.json(responseBody), async () => {
    const placement = await server.placementPOST(routeRequest("/api/sponsor-slot", {
      session_id: "trusted_session", turn_id: "turn_no_fill",
    }));
    assert.equal(placement.status, 200);
    assert.deepEqual(await placement.json(), responseBody);
    const generated = await server.withGeneration({
      request: routeRequest("/api/generate", {}, {
        "x-wavebird-session-id": "trusted_session", "x-wavebird-generation-id": "turn_no_fill",
      }),
      run: () => new Response("model result"),
    });
    assert.equal(generated.status, 200);
    await generated.text();
    responseBody = { decision: { fill: true }, placement: {} };
    assert.equal((await server.placementPOST(routeRequest("/api/sponsor-slot", {
      session_id: "trusted_session", turn_id: "turn_bad_fill",
    }))).status, 502);
  });
  assert.deepEqual(calls.filter(([kind]) => kind === "phase").map(([, phase]) => phase), ["started", "finished"]);
  assert.equal(calls.filter(([kind]) => kind === "claim").length, 2);
});

async function withFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test("saved Banner configuration drives the existing REST placement payload", async () => {
  const calls = [];
  const server = createPublisherServer(saved);
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ fill: true, slot_id: "slot_test" }, { headers: { "x-request-id": "req_test" } });
  }, async () => {
    const result = await server.placementPOST(routeRequest("/api/sponsor-slot", { session_id: "session_test", allowed_formats: ["clip"] }));
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("x-request-id"), "req_test");
    assert.equal((await result.json()).fill, true);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.wavebird.ai/v1/placements?wait_ms=1500");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk_test_server_only");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.client_id, saved.clientId);
  assert.equal(body.job_type, "chat");
  assert.equal(body.locale, "de-DE");
  assert.equal(body.placement_key, "default");
  assert.deepEqual(body.slot_hint.allowed_sizes, [{ width: 728, height: 90 }]);
  assert.deepEqual(body.overrides.allowed_formats, ["banner"]);
  assert.equal(body.overrides.timing, "during");
  assert.equal(Object.hasOwn(body.overrides, "bidfloor"), false);
  assert.equal(Object.hasOwn(body.overrides, "bidfloor_currency"), false);
  assert.equal(body.overrides.publisher.app_domain, "publisher.example");
  assert.deepEqual(body.overrides.publisher.categories, ["IAB19"]);
  assert.deepEqual(body.overrides.blocked_categories, ["IAB25"]);
  assert.equal(body.consent.consent_source, "wrapper_cmp");
  assert.equal(calls[0].init.body.includes("sk_test_server_only"), false);
});

test("explicit zero floor is preserved while incomplete or malformed overrides fail", async () => {
  for (const options of [
    { bidfloor: 0 }, { bidfloorCurrency: "EUR" },
    { bidfloor: null, bidfloorCurrency: "EUR" },
    { bidfloor: -1, bidfloorCurrency: "EUR" },
    { bidfloor: 1, bidfloorCurrency: "EU" },
  ]) assert.throws(() => createPublisherServer({ ...saved, ...options }), /publisher_bidfloor_override_invalid/);
  const server = createPublisherServer({ ...saved, bidfloor: 0, bidfloorCurrency: "eur" });
  let payload;
  await withFetch(async (_url, init) => {
    payload = JSON.parse(init.body);
    return Response.json({ decision: { fill: false }, placement: null });
  }, async () => {
    assert.equal((await server.placementPOST(routeRequest("/api/sponsor-slot", { session_id: "session_zero_floor" }))).status, 200);
  });
  assert.equal(payload.overrides.bidfloor, 0);
  assert.equal(payload.overrides.bidfloor_currency, "EUR");
});

test("saved Clip configuration uses the package transport without broadening Banner or Native scope", async () => {
  const clip = createPublisherServer({ ...saved, timing: "after", jobType: "image_generation",
    allowedFormats: ["clip"], maxWidth: 640, maxHeight: 360,
    allowedSizes: [{ width: 640, height: 360, formats: ["clip"] }] });
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return Response.json({ decision: { fill: false, no_fill_reason: "no_fill" }, placement: null });
  }, async () => {
    const result = await clip.placementPOST(routeRequest("/api/sponsor-slot", { session_id: "session_clip" }));
    assert.equal(result.status, 200);
    assert.equal((await result.json()).decision.fill, false);
    assert.equal((await clip.placementPOST(routeRequest("/api/sponsor-slot", {}, { origin: "https://other.example" }))).status, 403);
    assert.equal((await clip.placementPOST(routeRequest("/api/sponsor-slot", {}, { authorization: "" }))).status, 401);
    assert.equal((await clip.placementPOST(routeRequest("/api/sponsor-slot", {}, { "sec-gpc": "1" }))).status, 403);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.wavebird.ai/v1/placements?wait_ms=1500");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk_test_server_only");
  assert.deepEqual(calls[0].body.overrides.allowed_formats, ["clip"]);
  assert.equal(calls[0].body.overrides.timing, "after");
  assert.deepEqual(calls[0].body.slot_hint.allowed_sizes, [{ width: 640, height: 360 }]);
  assert.equal(calls[0].init.body.includes("sk_test_server_only"), false);
});

test("empty optional category arrays are omitted from the existing REST payload", async () => {
  const server = createPublisherServer({ ...saved,
    publisher: { ...saved.publisher, categories: [] }, blockedCategories: [] });
  let payload;
  await withFetch(async (_url, init) => {
    payload = JSON.parse(init.body);
    return Response.json({ fill: false, reason: "no_fill" });
  }, async () => {
    const result = await server.placementPOST(routeRequest("/api/sponsor-slot", { session_id: "session_test" }));
    assert.equal(result.status, 200);
  });
  assert.equal(Object.hasOwn(payload.overrides.publisher, "categories"), false);
  assert.equal(Object.hasOwn(payload.overrides, "blocked_categories"), false);
});

test("No-Fill is relayed; missing auth, wrong origin, and GPC never reach Wavebird", async () => {
  let calls = 0;
  const server = createPublisherServer(saved);
  await withFetch(async () => { calls++; return Response.json({ fill: false, reason: "no_fill" }); }, async () => {
    const noFill = await server.placementPOST(routeRequest("/api/sponsor-slot", {}));
    assert.deepEqual(await noFill.json(), { fill: false, reason: "no_fill" });
    assert.equal((await server.placementPOST(routeRequest("/api/sponsor-slot", {}, { authorization: "" }))).status, 401);
    assert.equal((await server.placementPOST(routeRequest("/api/sponsor-slot", {}, { origin: "https://other.example" }))).status, 403);
    assert.equal((await server.placementPOST(routeRequest("/api/sponsor-slot", {}, { "sec-gpc": "1" }))).status, 403);
    assert.equal(calls, 1);
  });
});

test("configured public origins bind proxied and local routes to exact host, scheme, and port", async () => {
  const publicOrigins = ["http://localhost:4173", "http://127.0.0.1:4173", "https://another-publisher.example"];
  const server = createPublisherServer({ ...saved, publicOrigins });
  const proxied = (host, origin, headers = {}) => new Request("http://127.0.0.1:3000/api/sponsor-consent", {
    method: "POST",
    headers: { host, origin, authorization: "Session publisher", "sec-fetch-site": "same-origin", ...headers },
    body: JSON.stringify({ session_id: "session_test", lifecycle_state: "granted", revision: 1, remember_for_30_days: true })
  });
  let upstreamCalls = 0;
  await withFetch(async () => {
    upstreamCalls++;
    return Response.json({ authoritative_consent: { lifecycle_state: "granted", revision: 1 } });
  }, async () => {
    for (const origin of publicOrigins) {
      const host = new URL(origin).host;
      const granted = await server.consentPOST(proxied(host, origin));
      assert.equal(granted.status, 200, origin);
      const cookie = granted.headers.get("set-cookie");
      const signed = cookie.split(";")[0].split("=")[1];
      const scope = JSON.parse(Buffer.from(signed.split(".")[0], "base64url").toString("utf8"));
      assert.equal(scope.origin, origin);
      const recalled = await server.consentGET(new Request("http://127.0.0.1:3000/api/sponsor-consent", {
        headers: { host, authorization: "Session publisher", cookie: cookie.split(";")[0], "sec-fetch-site": "same-origin" }
      }));
      assert.equal(recalled.status, 200);
      assert.equal((await recalled.json()).preference.state, "granted");
    }
    assert.equal((await server.consentPOST(proxied("localhost:4173", "http://127.0.0.1:4173"))).status, 403);
    assert.equal((await server.consentPOST(proxied("localhost:4173", "https://localhost:4173"))).status, 403);
    assert.equal((await server.consentPOST(proxied("localhost:4174", "http://localhost:4174"))).status, 403);
    assert.equal((await server.consentPOST(proxied("another-publisher.example", "https://evil.example"))).status, 403);
    assert.equal((await server.consentPOST(proxied("another-publisher.example", "https://another-publisher.example", { "sec-fetch-site": "cross-site" }))).status, 403);
    assert.equal((await server.consentPOST(proxied("another-publisher.example", "https://another-publisher.example", { authorization: "" }))).status, 401);
    assert.equal(upstreamCalls, 3);
  });
  assert.throws(() => createPublisherServer({ ...saved, publicOrigins: ["http://another-publisher.example"] }), /publisher_public_origins_invalid/);
  assert.throws(() => createPublisherServer({ ...saved, publicOrigins: undefined }), /publisher_public_origins_invalid/);
  assert.throws(() => createPublisherServer({ ...saved, publicOrigins: ["http://localhost:4173/"] }), /publisher_public_origins_invalid/);
});

test("existing sandbox No-Fill control is forwarded only with a Test key", async () => {
  const calls = [];
  const server = createPublisherServer(saved);
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ decision: { fill: false, no_fill_reason: "test_controlled_no_fill" }, placement: null });
  }, async () => {
    const noFill = await server.placementPOST(routeRequest("/api/sponsor-slot?qa_test_outcome=no_fill", { session_id: "session_test" }));
    assert.equal(noFill.status, 200);
    assert.equal((await noFill.json()).decision.fill, false);
    assert.equal((await server.placementPOST(routeRequest("/api/sponsor-slot?qa_test_outcome=fill", {}))).status, 400);
    assert.equal((await server.placementPOST(routeRequest("/api/sponsor-slot?qa_test_outcome=no_fill&qa_test_outcome=no_fill", {}))).status, 400);
    assert.equal((await server.placementPOST(routeRequest("/api/sponsor-slot?qa_test_outcome=no_fill", {}, { authorization: "" }))).status, 401);
    assert.equal((await server.placementPOST(routeRequest("/api/sponsor-slot?qa_test_outcome=no_fill", {}, { origin: "https://other.example" }))).status, 403);
    assert.equal((await server.placementPOST(routeRequest("/api/sponsor-slot?qa_test_outcome=no_fill", {}, { "sec-gpc": "1" }))).status, 403);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.wavebird.ai/v1/placements?wait_ms=1500&test_outcome=no_fill");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk_test_server_only");
  const liveServer = createPublisherServer({ ...saved, secretKey: "sk_live_not_for_qa" });
  await withFetch(async () => { throw new Error("upstream_must_not_run"); }, async () => {
    assert.equal((await liveServer.placementPOST(routeRequest("/api/sponsor-slot?qa_test_outcome=no_fill", {}))).status, 403);
  });
});

test("Test and production server keys share the package path with Test-only loopback HTTP", async () => {
  assert.throws(() => createPublisherServer({ ...saved, secretKey: "pk_publishable_wrong_scope" }), /publisher_server_key_invalid/);
  assert.doesNotThrow(() => createPublisherServer({ ...saved, publicOrigins: ["http://localhost:4173"] }));
  assert.throws(() => createPublisherServer({ ...saved, secretKey: "sk_live_synthetic", publicOrigins: ["http://localhost:4173"] }), /publisher_public_origins_invalid/);
  const server = createPublisherServer({ ...saved, secretKey: "sk_live_synthetic" });
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ decision: { fill: false }, placement: null });
  }, async () => {
    assert.equal((await server.placementPOST(routeRequest("/api/sponsor-slot", { session_id: "session_live_synthetic" }))).status, 200);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk_live_synthetic");
});

test("consent rejects unauthenticated, cross-origin, GPC, malformed, and external-protocol input before sync", async () => {
  const server = createPublisherServer(saved);
  let calls = 0;
  const choice = { session_id: "session_test", lifecycle_state: "granted", revision: 1 };
  await withFetch(async () => { calls++; return Response.json({}); }, async () => {
    const cases = [
      [routeRequest("/api/sponsor-consent", choice, { authorization: "" }), 401],
      [routeRequest("/api/sponsor-consent", choice, { origin: "https://other.example" }), 403],
      [routeRequest("/api/sponsor-consent", choice, { "sec-fetch-site": "cross-site" }), 403],
      [routeRequest("/api/sponsor-consent", choice, { "sec-gpc": "1" }), 403],
      [routeRequest("/api/sponsor-consent", { ...choice, revision: 0 }), 400],
      [routeRequest("/api/sponsor-consent", { ...choice, tcf_string: "synthetic" }), 400],
    ];
    for (const [request, status] of cases) assert.equal((await server.consentPOST(request)).status, status);
    assert.equal(calls, 0);
  });
});

test("remembered consent fails closed when the upstream authoritative snapshot differs", async () => {
  const server = createPublisherServer(saved);
  await withFetch(async () => Response.json({ authoritative_consent: { lifecycle_state: "denied", revision: 1 } }), async () => {
    const result = await server.consentPOST(routeRequest("/api/sponsor-consent", {
      session_id: "session_test", lifecycle_state: "granted", revision: 1, remember_for_30_days: true,
    }));
    assert.equal(result.status, 502);
    assert.deepEqual(await result.json(), { error: "consent_snapshot_invalid" });
    assert.match(result.headers.get("set-cookie"), /Max-Age=0/);
  });
});

test("real CMP grant, remembered preference, withdrawal, tampering, expiry, and sync failure", async () => {
  const server = createPublisherServer(saved);
  let state = "granted";
  await withFetch(async (url, init) => {
    assert.equal(url, "https://api.wavebird.ai/v1/consent");
    assert.equal(init.headers.Authorization, "Bearer sk_test_server_only");
    const body = JSON.parse(init.body);
    assert.equal(body.source, "publisher_custom");
    assert.equal(body.decision, "basic");
    assert.deepEqual(body.purposes, { semantic_targeting: false, session_persistence: false, cross_session_persistence: false, prompt_shared: false });
    return Response.json({ authoritative_consent: { lifecycle_state: body.lifecycle_state, revision: body.revision } });
  }, async () => {
    const grant = await server.consentPOST(routeRequest("/api/sponsor-consent", { session_id: "s1", lifecycle_state: "granted", revision: 1, remember_for_30_days: true }));
    assert.equal(grant.status, 200);
    const grantCookie = grant.headers.get("set-cookie").split(";")[0];
    assert.equal((await (await server.consentGET(routeRequest("/api/sponsor-consent", undefined, { cookie: grantCookie }))).json()).preference.state, "granted");
    assert.equal((await (await server.consentGET(routeRequest("/api/sponsor-consent", undefined, { cookie: grantCookie + "bad" }))).json()).preference, null);
    const withdraw = await server.consentPOST(routeRequest("/api/sponsor-consent", { session_id: "s1", lifecycle_state: "withdrawn", revision: 2, remember_for_30_days: true }));
    assert.equal(withdraw.status, 200);
    const withdrawCookie = withdraw.headers.get("set-cookie").split(";")[0];
    assert.equal((await (await server.consentGET(routeRequest("/api/sponsor-consent", undefined, { cookie: withdrawCookie }))).json()).preference.state, "withdrawn");
    assert.equal((await (await server.consentGET(routeRequest("/api/sponsor-consent", undefined, { cookie: grantCookie, "sec-gpc": "1" }))).json()).preference, null);
    const [name, value] = grantCookie.split("=");
    const [payload] = value.split(".");
    const record = JSON.parse(Buffer.from(payload, "base64url").toString());
    record.issued_at -= 31 * 24 * 60 * 60 * 1000;
    record.expires_at -= 31 * 24 * 60 * 60 * 1000;
    const expiredPayload = Buffer.from(JSON.stringify(record)).toString("base64url");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(saved.preferenceSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(expiredPayload))).toString("base64url");
    assert.equal((await (await server.consentGET(routeRequest("/api/sponsor-consent", undefined, { cookie: `${name}=${expiredPayload}.${signature}` }))).json()).preference, null);
  });
  await withFetch(async () => { throw new Error("offline"); }, async () => {
    const failed = await server.consentPOST(routeRequest("/api/sponsor-consent", { session_id: "s1", lifecycle_state: state, revision: 3, remember_for_30_days: true }));
    assert.equal(failed.status, 502);
    assert.match(failed.headers.get("set-cookie"), /Max-Age=0/);
  });
});

test("generation wrapper preserves model bytes and requires publisher authentication", async () => {
  const server = createPublisherServer(saved);
  let called = 0;
  const unauthenticated = await server.withGeneration({ request: routeRequest("/api/chat", {}, { authorization: "" }), run: () => { called++; return new Response("hello"); } });
  assert.equal(unauthenticated.status, 401);
  assert.equal(called, 0);
  const crossOrigin = await server.withGeneration({ request: routeRequest("/api/chat", {}, { origin: "https://other.example" }), run: () => { called++; return new Response("hello"); } });
  assert.equal(crossOrigin.status, 403);
  assert.equal(called, 0);
  const request = routeRequest("/api/chat", {}, { "x-wavebird-session-id": "session_test", "x-wavebird-generation-id": "generation_test" });
  const stream = await server.withGeneration({ request, run: () => { called++; return new Response("hello"); } });
  assert.equal(stream.headers.get("x-wavebird-generation-transport"), "1");
  const records = (await stream.text()).trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map(record => record.type), ["started", "response", "bytes", "done"]);
  assert.equal(Buffer.from(records[2].data, "base64").toString(), "hello");
  assert.equal(called, 1);
});

test("generation lifecycle hook reports authorized terminal states without changing model output", async () => {
  const server = createPublisherServer(saved);
  const events = [];
  const onLifecycle = event => {
    events.push(event);
    if (event.type === "started") throw new Error("observer_unavailable");
    return Promise.reject(new Error("observer_unavailable"));
  };
  const headers = { "x-wavebird-session-id": "session_hook", "x-wavebird-generation-id": "generation_hook" };
  const unauthorized = await server.withGeneration({
    request: routeRequest("/api/chat", {}, { ...headers, authorization: "" }),
    run: () => new Response("not-called"), onLifecycle,
  });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(events, []);

  const raw = await server.withGeneration({
    request: routeRequest("/api/chat", {}), run: () => new Response("raw"), onLifecycle,
  });
  assert.equal(await raw.text(), "raw");
  assert.deepEqual(events, []);

  const success = await server.withGeneration({
    request: routeRequest("/api/chat", {}, headers), run: () => new Response("model bytes"), onLifecycle,
  });
  const records = (await success.text()).trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map(record => record.type), ["started", "response", "bytes", "done"]);
  assert.equal(Buffer.from(records[2].data, "base64").toString(), "model bytes");
  assert.deepEqual(events, [
    { type: "started", sessionId: "session_hook", generationId: "generation_hook" },
    { type: "done", sessionId: "session_hook", generationId: "generation_hook" },
  ]);

  events.length = 0;
  const failed = await server.withGeneration({
    request: routeRequest("/api/chat", {}, headers), run: () => new Response("unavailable", { status: 503 }), onLifecycle,
  });
  assert.deepEqual((await failed.text()).trim().split("\n").map(line => JSON.parse(line).type), ["started", "response", "bytes", "error"]);
  assert.deepEqual(events.map(event => event.type), ["started", "error"]);

  events.length = 0;
  const cancelled = await server.withGeneration({
    request: routeRequest("/api/chat", {}, headers),
    run: () => new Response(new ReadableStream({ pull() {} })), onLifecycle,
  });
  const cancelledReader = cancelled.body.getReader();
  assert.equal(JSON.parse(new TextDecoder().decode((await cancelledReader.read()).value)).type, "started");
  await cancelledReader.cancel();
  assert.deepEqual(events.map(event => event.type), ["started", "abort"]);
});

test("generation reports use the existing scoped REST endpoint and reject invalid input and upstream failure", async () => {
  const server = createPublisherServer(saved);
  const calls = [];
  let cancelled = 0;
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return new Response(new ReadableStream({ cancel() { cancelled++; } }));
  }, async () => {
    await assert.rejects(server.reportGeneration("other_project_job", "started"), /invalid_generation_report/);
    await assert.rejects(server.reportGeneration("job_valid", "done"), /invalid_generation_report/);
    assert.equal(calls.length, 0);
    await server.reportGeneration("job_valid", "started");
    await server.reportGeneration("job_valid", "finished");
    await server.reportGeneration("job_valid", "failed");
  });
  assert.deepEqual(calls.map(call => call.url), ["started", "finished", "failed"].map(event =>
    `https://api.wavebird.ai/v1/jobs/job_valid/generation/${event}`));
  assert.equal(cancelled, 3);
  for (const { init } of calls) {
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer sk_test_server_only");
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.equal(init.body, "{}");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.equal(init.signal instanceof AbortSignal, true);
  }
  await withFetch(async () => new Response(null, { status: 403 }), async () => {
    await assert.rejects(server.reportGeneration("job_valid", "failed"), /generation_report_http_403/);
  });
});

test("generation reporting limits parallel calls", async () => {
  const server = createPublisherServer(saved);
  const pending = [];
  await withFetch(async () => new Promise(resolve => pending.push(resolve)), async () => {
    const first = server.reportGeneration("job_first", "started");
    const second = server.reportGeneration("job_second", "started");
    assert.equal(pending.length, 2);
    await assert.rejects(server.reportGeneration("job_third", "started"), /wavebird_capacity_exceeded/);
    pending.forEach(resolve => resolve(new Response(null, { status: 204 })));
    await Promise.all([first, second]);
  });
});

test("generation wrapper reports model failure and propagates client abort", async () => {
  const server = createPublisherServer(saved);
  const headers = {
    authorization: "Session publisher",
    origin: "https://publisher.example",
    "sec-fetch-site": "same-origin",
    "x-wavebird-session-id": "session_abort",
    "x-wavebird-generation-id": "generation_abort",
  };
  const failed = await server.withGeneration({
    request: new Request("https://publisher.example/api/chat", { method: "POST", headers: { host: "publisher.example", ...headers } }),
    run: async () => { throw new Error("model_unavailable"); },
  });
  assert.deepEqual((await failed.text()).trim().split("\n").map(line => JSON.parse(line).type), ["started", "error"]);

  const controller = new AbortController();
  let modelSignal;
  const running = await server.withGeneration({
    request: new Request("https://publisher.example/api/chat", { method: "POST", headers: { host: "publisher.example", ...headers }, signal: controller.signal }),
    run: signal => {
      modelSignal = signal;
      return new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("first"));
          signal.addEventListener("abort", () => stream.error(new Error("model_aborted")), { once: true });
        },
      }));
    },
  });
  const reader = running.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"type":"started"/);
  controller.abort();
  assert.equal(modelSignal.aborted, true);
  const remaining = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    remaining.push(new TextDecoder().decode(next.value));
  }
  assert.match(remaining.join(""), /"type":"abort"/);
  assert.doesNotMatch(remaining.join(""), /"type":"done"/);
});

test("publisher body, upstream response, and parallel placement requests stay bounded", async () => {
  const server = createPublisherServer(saved);
  let calls = 0;
  await withFetch(async () => { calls++; return Response.json({ fill: false }); }, async () => {
    const oversized = await server.placementPOST(routeRequest("/api/sponsor-slot", { padding: "x".repeat(17 * 1024) }));
    assert.equal(oversized.status, 413);
    assert.equal(calls, 0);
  });
  await withFetch(async () => new Response("x".repeat(257 * 1024)), async () => {
    const oversized = await server.placementPOST(routeRequest("/api/sponsor-slot", {}));
    assert.equal(oversized.status, 502);
  });
  const pending = [];
  await withFetch(async () => new Promise(resolve => pending.push(resolve)), async () => {
    const first = server.placementPOST(routeRequest("/api/sponsor-slot", {}));
    const second = server.placementPOST(routeRequest("/api/sponsor-slot", {}));
    for (let index = 0; index < 10 && pending.length < 2; index++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending.length, 2);
    const third = await server.placementPOST(routeRequest("/api/sponsor-slot", {}));
    assert.equal(third.status, 429);
    pending.forEach(resolve => resolve(Response.json({ fill: false })));
    assert.deepEqual([(await first).status, (await second).status], [200, 200]);
  });
});
