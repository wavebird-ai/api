let rendererReady = null;
let rendererSource = null;

function loadRenderer(url) {
  if (window.wavebird?.createChatSponsor) return Promise.resolve();
  if (rendererReady && rendererSource !== url) return Promise.reject(new Error("renderer_source_mismatch"));
  if (!rendererReady) {
    rendererSource = url;
    rendererReady = new Promise((resolve, reject) => {
      const script = document.createElement("script"); script.src = url;
      const fail = () => { clearTimeout(timer); script.onload = null; script.onerror = null; script.remove(); reject(new Error("renderer_unavailable")); };
      const timer = setTimeout(fail, 8000);
      script.onerror = fail;
      script.onload = () => { clearTimeout(timer); if (!window.wavebird?.createChatSponsor) fail(); else resolve(); };
      document.head.append(script);
    }).catch(error => { rendererReady = null; rendererSource = null; throw error; });
  }
  return rendererReady;
}

export function createPublisherAds(options) {
  const target = options.target;
  if (!target || !options.userId || !options.conversationId) throw new Error("Application container and session are required");
  const timing = options.timing || "during", consentMode = options.consentMode || "wavebird_consent";
  if (!["before", "during", "after"].includes(timing) || !["wavebird_consent", "own_cmp"].includes(consentMode)) throw new Error("Invalid publisher configuration");
  let binding = { userId: options.userId, conversationId: options.conversationId, sessionId: crypto.randomUUID() };
  let sponsor = null, disposed = false, context = 0, active = null;
  const slot = document.createElement("section");
  slot.setAttribute("aria-label", "Sponsored placement");
  slot.style.cssText = "width:100%;height:100%;overflow:hidden;margin:0 auto";
  target.append(slot);
  const privacyTarget = consentMode === "wavebird_consent" && options.privacySettingsTarget
    ? document.querySelector(options.privacySettingsTarget) : null;
  const openPrivacySettings = () => { if (!disposed) sponsor?.openPrivacySettings(); };
  privacyTarget?.addEventListener("click", openPrivacySettings);
  const notify = (method, id) => {
    try { sponsor?.[method](id); }
    catch {
      try { sponsor?.dispose(); } catch {}
      sponsor = null; slot.hidden = true; slot.replaceChildren();
    }
  };
  const current = job => !disposed && !job.cancelled && job.context === context && active === job;
  const event = (job, type) => {
    if (!current(job)) return;
    if (type === "started") {
      if (job.state !== "pending") return;
      job.state = "started"; notify("onStarted", job.id);
    } else if (type === "progress") {
      if (job.state === "started") { job.progressed = true; notify("onDelta", job.id); }
    } else if (["done", "error", "abort"].includes(type)) {
      if (job.state !== "started") return;
      job.state = type;
      notify(type === "done" ? "onDone" : type === "abort" ? "onAbort" : "onError", job.id);
    }
  };
  const prepare = () => { if (!disposed && sponsor) void sponsor.prepare().catch(() => {}); };
  function setConversation(next) {
    if (disposed) return;
    if (!next.userId || !next.conversationId) throw new Error("Application session is required");
    if (next.userId === binding.userId && next.conversationId === binding.conversationId) return;
    if (active) event(active, "abort");
    context++; active = null;
    binding = { userId: next.userId, conversationId: next.conversationId, sessionId: crypto.randomUUID() };
    sponsor?.setConversation(binding); prepare();
  }
  function dispose() {
    if (disposed) return;
    if (active) event(active, "abort");
    disposed = true; context++; active = null;
    sponsor?.dispose(); sponsor = null; slot.remove();
    privacyTarget?.removeEventListener("click", openPrivacySettings);
    window.removeEventListener("pagehide", dispose);
  }
  window.addEventListener("pagehide", dispose);
  const ready = loadRenderer(options.rendererUrl || "https://api.wavebird.ai/v1/render.js").then(() => {
    if (disposed) return;
    sponsor = window.wavebird.createChatSponsor({ target: slot, ...binding,
      clientId: options.clientId, surfaceId: options.surfaceId, timing, consentMode,
      ...(options.getFormat === undefined ? {} : { getFormat: options.getFormat }),
      ...(options.placementEndpoint === undefined ? {} : { placementEndpoint: options.placementEndpoint }),
      ...(options.consentEndpoint === undefined ? {} : { consentEndpoint: options.consentEndpoint }) });
    prepare();
    if (active && current(active)) {
      if (active.state === "started") {
        notify("onStarted", active.id);
        if (active.progressed) notify("onDelta", active.id);
      } else if (timing === "after" && active.state === "done") {
        notify("onStarted", active.id); notify("onDone", active.id);
      }
    }
  }).catch(() => {});

  async function connectGeneration({ request, consume, signal }) {
    const job = { id: crypto.randomUUID(), sessionId: binding.sessionId, context, state: "pending", cancelled: false };
    if (active) event(active, "abort");
    active = job;
    let reader = null, ended = false, buffer = "";
    const decoder = new TextDecoder();
    const abort = () => { event(job, "abort"); job.cancelled = true; void reader?.cancel().catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const headers = { "x-wavebird-session-id": job.sessionId, "x-wavebird-generation-id": job.id };
    try {
      const response = await request(headers);
      if (response.headers.get("x-wavebird-generation-transport") !== "1") return await consume(response);
      if (!response.body) throw new Error("generation_transport_missing");
      reader = response.body.getReader();
      async function nextRecord() {
        while (true) {
          const boundary = buffer.indexOf("\n");
          if (boundary >= 0) {
            const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
            if (!line || line.length > 32768) throw new Error("generation_transport_invalid");
            const record = JSON.parse(line);
            if (record.session_id !== job.sessionId || record.generation_id !== job.id) throw new Error("generation_transport_context_mismatch");
            return record;
          }
          if (buffer.length > 32768) throw new Error("generation_transport_limit");
          const next = await reader.read();
          if (signal?.aborted) throw new Error("generation_aborted");
          if (next.done) throw new Error("generation_transport_truncated");
          buffer += decoder.decode(next.value, { stream: true });
        }
      }
      let metadata;
      while (!metadata) {
        const record = await nextRecord();
        if (record.type === "started") event(job, "started");
        else if (record.type === "response") metadata = record;
        else throw new Error("generation_failed_before_response");
      }
      if (!Number.isInteger(metadata.status) || metadata.status < 200 || metadata.status > 599 || !Array.isArray(metadata.headers)) throw new Error("generation_response_invalid");
      const output = new ReadableStream({
        async pull(controller) {
          try {
            while (true) {
              const record = await nextRecord();
              if (record.type === "bytes") {
                if (typeof record.data !== "string" || record.data.length > 21848 || !/^[A-Za-z0-9+/]*={0,2}$/.test(record.data)) throw new Error("generation_bytes_invalid");
                const raw = atob(record.data), bytes = Uint8Array.from(raw, value => value.charCodeAt(0));
                controller.enqueue(bytes);
                if (timing !== "before" && !["image", "image_generation"].includes(options.jobType)) event(job, "progress");
                return;
              }
              if (["done", "error", "abort"].includes(record.type)) {
                ended = true; event(job, record.type);
                if (record.type === "done" || !metadata.status.toString().startsWith("2")) controller.close();
                else controller.error(new Error("generation_" + record.type));
                return;
              }
              throw new Error("generation_transport_invalid");
            }
          } catch (error) { event(job, signal?.aborted ? "abort" : "error"); controller.error(error); }
        },
        cancel() { event(job, "abort"); void reader?.cancel().catch(() => {}); }
      }, { highWaterMark: 0 });
      if ([204, 205, 304].includes(metadata.status)) {
        const record = await nextRecord();
        if (!["done", "error", "abort"].includes(record.type)) throw new Error("generation_transport_invalid");
        ended = true; event(job, record.type);
      }
      const primary = new Response([204, 205, 304].includes(metadata.status) ? null : output, {
        status: metadata.status, statusText: metadata.status_text || "", headers: metadata.headers
      });
      return await consume(primary, { onDelta: () => event(job, "progress") });
    } catch (error) {
      event(job, signal?.aborted ? "abort" : "error");
      throw error;
    } finally {
      if (!ended && job.state === "started") event(job, "abort");
      signal?.removeEventListener("abort", abort);
      if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
    }
  }
  return { ready, connectGeneration, setConversation, dispose, openPrivacySettings,
    grant: choice => sponsor ? sponsor.grant(choice) : Promise.resolve({ status: "renderer_unavailable" }),
    deny: () => sponsor ? sponsor.deny() : Promise.resolve({ status: "renderer_unavailable" }),
    withdraw: () => sponsor ? sponsor.withdraw() : Promise.resolve({ status: "renderer_unavailable" }) };
}

export async function connectPublisherGeneration(url, init, consume) {
  const ads = window.publisherAds;
  if (!ads) return consume(await fetch(url, init), { onDelta() {} });
  return ads.connectGeneration({
    signal: init.signal ?? undefined,
    request: values => {
      const headers = new Headers(init.headers);
      for (const [name, value] of Object.entries(values)) headers.set(name, value);
      return fetch(url, { ...init, headers });
    },
    consume
  });
}
