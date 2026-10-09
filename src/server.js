import { generationTransport } from "./generation.js";

const PREFERENCE_VERSION = "contextual-choice/v2";
const PREFERENCE_TTL = 30 * 24 * 60 * 60;
const MAX_PUBLISHER_BODY_BYTES = 16 * 1024;
const MAX_WAVEBIRD_RESPONSE_BYTES = 256 * 1024;
const MAX_PARALLEL_WAVEBIRD_REQUESTS = 2;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const JOB_ID = /^job_[A-Za-z0-9_-]{1,128}$/;
const PLACEMENT_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function response(error, status, headers = {}) {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function normalizeOptions(options) {
  if (typeof window !== "undefined") throw new Error("publisher_server_only");
  if (!options || typeof options.authorize !== "function") throw new Error("publisher_authorize_required");
  if (!String(options.clientId || "").startsWith("wbproj_")) throw new Error("publisher_project_invalid");
  if (!String(options.secretKey || "").trim()) throw new Error("publisher_server_key_required");
  if (!ID.test(options.surfaceId || "") || !PLACEMENT_KEY.test(options.placementKey || "")) throw new Error("publisher_placement_invalid");
  if (!["before", "during", "after"].includes(options.timing)) throw new Error("publisher_timing_invalid");
  if (!["wavebird_consent", "own_cmp"].includes(options.consentMode)) throw new Error("publisher_consent_mode_invalid");
  if (!Array.isArray(options.allowedFormats) || options.allowedFormats.length === 0 || options.allowedFormats.some(value => !["banner", "native"].includes(value))) throw new Error("publisher_formats_invalid");
  if (!["above", "below", "sidebar", "between"].includes(options.positionHint)) throw new Error("publisher_position_invalid");
  if (!Number.isSafeInteger(options.maxWidth) || options.maxWidth < 1 || !Number.isSafeInteger(options.maxHeight) || options.maxHeight < 1) throw new Error("publisher_envelope_invalid");
  if (!Array.isArray(options.allowedSizes) || options.allowedSizes.length === 0 || options.allowedSizes.some(size => !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1 || size.width > options.maxWidth || size.height > options.maxHeight)) throw new Error("publisher_sizes_invalid");
  if (!options.publisher || typeof options.publisher.app_name !== "string" || typeof options.publisher.app_domain !== "string" || !Array.isArray(options.publisher.categories)) throw new Error("publisher_identity_invalid");
  if (typeof options.jobType !== "string" || !options.jobType || typeof options.locale !== "string" || !options.locale) throw new Error("publisher_job_invalid");
  const base = String(options.apiBaseUrl || "https://api.wavebird.ai").trim().replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1";
  if (!/^https:\/\//.test(base)) throw new Error("publisher_api_https_required");
  return { ...options, base, consentSource: options.consentMode === "wavebird_consent" ? "wavebird_consent" : "wrapper_cmp" };
}

function validOrigin(request, strict = true) {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  return (strict ? origin === new URL(request.url).origin : !origin || origin === new URL(request.url).origin) &&
    (strict ? site !== "cross-site" : !site || site === "same-origin");
}

function gpc(request) {
  return (request.headers.get("sec-gpc") || "").split(",").some(value => value.trim() === "1");
}

function proxyResult(upstream, body, extra = {}) {
  return new Response(body || null, { status: upstream.status, headers: {
    "Content-Type": upstream.headers.get("content-type") || "application/json",
    "Cache-Control": "no-store",
    ...(upstream.headers.get("x-request-id") ? { "x-request-id": upstream.headers.get("x-request-id") } : {}),
    ...extra
  } });
}

async function readBoundedText(value, limit, signal) {
  if (!value.body) return "";
  const reader = value.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = "";
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error("body_timeout");
      const next = await reader.read();
      if (signal.aborted) throw new Error("body_timeout");
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) { cancel(); throw new Error("body_limit_exceeded"); }
      output += decoder.decode(next.value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

async function readPublisherJson(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try { return JSON.parse(await readBoundedText(request, MAX_PUBLISHER_BODY_BYTES, controller.signal)); }
  catch (error) {
    const reason = error instanceof Error ? error.message : "invalid_json";
    return response(reason, reason === "body_limit_exceeded" ? 413 : controller.signal.aborted ? 408 : 400);
  } finally { clearTimeout(timer); }
}

function boundedFetcher() {
  let active = 0;
  return async (url, init) => {
    if (active >= MAX_PARALLEL_WAVEBIRD_REQUESTS) return response("wavebird_capacity_exceeded", 429);
    active++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.signal?.aborted) abort();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { abort(); reject(new Error("upstream_timeout")); }, 5000);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const upstream = await fetch(url, { ...init, signal: controller.signal, redirect: "error", cache: "no-store" });
        const body = await readBoundedText(upstream, MAX_WAVEBIRD_RESPONSE_BYTES, controller.signal);
        return proxyResult(upstream, body);
      })()]);
    } finally {
      controller.abort();
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abort);
      active--;
    }
  };
}

function boundedGenerationReporter() {
  let active = 0;
  return async (url, init) => {
    if (active >= MAX_PARALLEL_WAVEBIRD_REQUESTS) throw new Error("wavebird_capacity_exceeded");
    active++;
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("generation_report_timeout")); }, 5000);
    });
    try {
      await Promise.race([deadline, (async () => {
        const upstream = await fetch(url, { ...init, signal: controller.signal, redirect: "error", cache: "no-store" });
        await upstream.body?.cancel();
        if (!upstream.ok) throw new Error(`generation_report_http_${upstream.status}`);
      })()]);
    } finally {
      controller.abort();
      clearTimeout(timer);
      active--;
    }
  };
}

function observeGeneration(response, request, onLifecycle) {
  if (typeof onLifecycle !== "function" || response.headers.get("x-wavebird-generation-transport") !== "1" || !response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let terminal = false;
  const notify = event => {
    try { Promise.resolve(onLifecycle(event)).catch(() => {}); } catch {}
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { controller.close(); return; }
        // The canonical transport emits one complete JSONL record per chunk.
        try {
          const record = JSON.parse(decoder.decode(next.value));
          if (["started", "done", "error", "abort"].includes(record.type)) {
            if (record.type !== "started") terminal = true;
            notify({ type: record.type, sessionId: record.session_id, generationId: record.generation_id });
          }
        } catch {}
        controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel(reason) {
      if (!terminal) {
        terminal = true;
        notify({ type: "abort", sessionId: request.headers.get("x-wavebird-session-id"), generationId: request.headers.get("x-wavebird-generation-id") });
      }
      try { await reader.cancel(reason); } catch {}
    }
  }, { highWaterMark: 1 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function createPublisherServer(inputOptions) {
  const options = normalizeOptions(inputOptions);
  const placementFetch = boundedFetcher();
  const consentFetch = boundedFetcher();
  const generationReportFetch = boundedGenerationReporter();
  const cookieName = `__Host-wavebird-preference-${options.clientId}-${options.surfaceId}`;
  const cookie = (value, ttl = PREFERENCE_TTL) => `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttl}`;
  const scope = request => ({ project: options.clientId, surface: options.surfaceId, version: PREFERENCE_VERSION,
    profile: options.consentMode === "wavebird_consent" ? "wavebird_dialog" : "publisher_custom", origin: new URL(request.url).origin });
  async function preferenceKey() {
    if (!options.preferenceSecret || options.preferenceSecret.length < 32) throw new Error("preference_secret_required");
    return crypto.subtle.importKey("raw", new TextEncoder().encode(options.preferenceSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }
  async function signPreference(request, state) {
    const now = Date.now();
    const payload = Buffer.from(JSON.stringify({ ...scope(request), state, issued_at: now, expires_at: now + PREFERENCE_TTL * 1000 })).toString("base64url");
    const signature = await crypto.subtle.sign("HMAC", await preferenceKey(), new TextEncoder().encode(payload));
    return cookie(payload + "." + Buffer.from(signature).toString("base64url"));
  }
  async function authorized(request) {
    try { return await options.authorize(request) === true; } catch { return false; }
  }
  async function placementPOST(request) {
    if (!await authorized(request)) return response("authentication_required", 401);
    if (gpc(request)) return response("privacy_signal_policy_required", 403);
    if (!validOrigin(request)) return response("invalid_origin", 403);
    const qaOutcomes = new URL(request.url).searchParams.getAll("qa_test_outcome");
    if (qaOutcomes.length > 1 || (qaOutcomes.length === 1 && qaOutcomes[0] !== "no_fill")) return response("invalid_qa_test_outcome", 400);
    if (qaOutcomes.length && !options.secretKey.startsWith("sk_test_")) return response("qa_test_outcome_requires_test_key", 403);
    const input = await readPublisherJson(request);
    if (input instanceof Response) return input;
    const sessionId = typeof input?.session_id === "string" && input.session_id.trim() ? input.session_id.trim() : crypto.randomUUID();
    const body = {
      client_id: options.clientId, session_id: sessionId, job_type: options.jobType, locale: options.locale,
      slots_requested: 1, placement_key: options.placementKey,
      slot_hint: { position: options.positionHint, max_width: options.maxWidth, max_height: options.maxHeight,
        allowed_sizes: options.allowedSizes, presentation_version: "sponsored_moment_v2" },
      overrides: { allowed_formats: options.allowedFormats, timing: options.timing,
        bidfloor: options.bidfloor ?? 0.5, bidfloor_currency: options.bidfloorCurrency ?? "EUR",
        gdpr_applies: options.gdprApplies === true,
        publisher: { app_name: options.publisher.app_name, app_domain: options.publisher.app_domain,
          ...(options.publisher.categories.length ? { categories: options.publisher.categories } : {}) },
        ...(options.blockedCategories?.length ? { blocked_categories: options.blockedCategories } : {}) },
      consent: { semantic_targeting: false, prompt_shared: false, gdpr_applies: options.gdprApplies === true,
        consent_source: options.consentSource }
    };
    try {
      return await placementFetch(`${options.base}/placements?wait_ms=1500${qaOutcomes.length ? "&test_outcome=no_fill" : ""}`, { method: "POST", headers: {
        Authorization: `Bearer ${options.secretKey}`, "Content-Type": "application/json"
      }, body: JSON.stringify(body), cache: "no-store" });
    } catch { return response("wavebird_placement_unavailable", 502); }
  }
  async function consentGET(request) {
    if (!await authorized(request)) return response("authentication_required", 401);
    const headers = { "Cache-Control": "no-store", Vary: "Cookie, Sec-GPC" };
    if (!validOrigin(request, false)) return response("invalid_origin", 403, headers);
    if (gpc(request)) return Response.json({ preference: null }, { headers });
    try {
      const value = (request.headers.get("cookie") || "").split(";").map(value => value.trim())
        .find(value => value.startsWith(cookieName + "="))?.slice(cookieName.length + 1) || "";
      if (value.length > 2048) throw new Error("preference_invalid");
      const [payload, signature, extra] = value.split(".");
      if (!payload || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) return Response.json({ preference: null }, { headers });
      if (!await crypto.subtle.verify("HMAC", await preferenceKey(), Buffer.from(signature, "base64url"), new TextEncoder().encode(payload))) return Response.json({ preference: null }, { headers });
      const record = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      const now = Date.now();
      if (Object.entries(scope(request)).some(([key, value]) => record[key] !== value) ||
        !["granted", "denied", "withdrawn"].includes(record.state) || !Number.isSafeInteger(record.issued_at) ||
        !Number.isSafeInteger(record.expires_at) || record.issued_at > now || record.expires_at <= now ||
        record.expires_at - record.issued_at !== PREFERENCE_TTL * 1000) return Response.json({ preference: null }, { headers });
      return Response.json({ preference: { state: record.state, expires_at: record.expires_at } }, { headers });
    } catch { return Response.json({ preference: null, error: "preference_unavailable" }, { headers }); }
  }
  async function consentPOST(request) {
    if (!await authorized(request)) return response("authentication_required", 401);
    if (!validOrigin(request)) return response("invalid_origin", 403);
    if (gpc(request)) return response("privacy_signal_policy_required", 403);
    const input = await readPublisherJson(request);
    if (input instanceof Response) return input;
    if (!input || typeof input.session_id !== "string" || !input.session_id.trim() ||
      !["granted", "denied", "withdrawn", "cmp_error"].includes(input.lifecycle_state) ||
      !Number.isSafeInteger(input.revision) || input.revision < 1) return response("consent_input_invalid", 400);
    if (["tcf_string", "gpp_string", "gpp_sections"].some(field => Object.hasOwn(input, field))) return response("external_consent_protocol_requires_policy", 400);
    const clear = input.remember_for_30_days === true ? { "Set-Cookie": cookie("", 0) } : {};
    if (input.remember_for_30_days === true) {
      try { await preferenceKey(); } catch { return response("preference_unavailable", 503, clear); }
    }
    let upstream;
    let text;
    try {
      upstream = await consentFetch(options.base + "/consent", { method: "POST", headers: {
        Authorization: `Bearer ${options.secretKey}`, "Content-Type": "application/json"
      }, cache: "no-store", body: JSON.stringify({
        client_id: options.clientId, session_id: input.session_id.trim(),
        decision: options.consentMode === "wavebird_consent" ? "custom" : "basic",
        source: options.consentMode === "wavebird_consent" ? "wavebird_dialog" : "publisher_custom",
        lifecycle_state: input.lifecycle_state, revision: input.revision,
        purposes: { semantic_targeting: false, session_persistence: false, cross_session_persistence: false, prompt_shared: false }
      }) });
      text = await upstream.text();
    } catch { return response("consent_sync_unavailable", 502, clear); }
    let setCookie = clear;
    if (upstream.ok && input.remember_for_30_days === true && input.lifecycle_state !== "cmp_error") {
      let snapshot;
      try { snapshot = JSON.parse(text).authoritative_consent; } catch {}
      if (snapshot?.lifecycle_state !== input.lifecycle_state || snapshot.revision !== input.revision) return response("consent_snapshot_invalid", 502, clear);
      try { setCookie = { "Set-Cookie": await signPreference(request, input.lifecycle_state) }; }
      catch { return response("preference_unavailable", 503, clear); }
    }
    return proxyResult(upstream, text, setCookie);
  }
  async function withGeneration({ request, run, onLifecycle }) {
    if (!await authorized(request)) return response("authentication_required", 401);
    if (!validOrigin(request)) return response("invalid_origin", 403);
    const result = await generationTransport({ request, run });
    return observeGeneration(result, request, onLifecycle);
  }
  async function reportGeneration(jobId, event) {
    if (!JOB_ID.test(jobId) || !["started", "finished", "failed"].includes(event)) throw new Error("invalid_generation_report");
    await generationReportFetch(`${options.base}/jobs/${encodeURIComponent(jobId)}/generation/${event}`, {
      method: "POST", headers: { Authorization: `Bearer ${options.secretKey}`, "Content-Type": "application/json" }, body: "{}"
    });
  }
  return { placementPOST, consentGET, consentPOST, withGeneration, reportGeneration };
}
