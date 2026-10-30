// Attach to the publisher's existing signed-in page and real generation consumer.
// No Wavebird server credential belongs in this browser file.
export function mountWavebirdPython({
  slot, promptInput, runButton, stopButton, result, consentButton, withdrawButton,
  choiceDialog, getSessionId, consumeGeneration, chooseOwnCmp,
  timing, consentMode, maxHeight, getFormat, jobType, apiBasePath = "",
}) {
  if (!slot || !promptInput || !runButton || !stopButton || !result ||
      !consentButton || !withdrawButton || !getSessionId || !consumeGeneration) {
    throw new Error("Connect the existing app controls, session and model response consumer");
  }
  if (!["before", "during", "after"].includes(timing) ||
      !["wavebird_consent", "own_cmp"].includes(consentMode) ||
      !Number.isSafeInteger(maxHeight) || maxHeight < 1 || maxHeight > 2048 ||
      !["chat", "code", "image", "voice", "agent"].includes(jobType) ||
      (typeof apiBasePath !== "string" ||
        (apiBasePath !== "" && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(apiBasePath)))) {
    throw new Error("Invalid saved project presentation settings");
  }
  slot.style.minHeight = String(maxHeight) + "px";
  slot.setAttribute("aria-label", "Sponsored placement");
  let revision = 0, epoch = 0, consentGranted = false;
  let generationAbort = null, placementAbort = null, renderCleanup = null;
  let renderedSize = null;
  let authorityTimer = null, authorityExpiresAt = 0;
  let disposed = false;
  const apiRoute = route => apiBasePath + route;
  const post = (route, body, signal) => fetch(apiRoute(route), {
    method: "POST", credentials: "same-origin", signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const privacyBlocked = () => navigator.globalPrivacyControl === true;
  function clearSlot() {
    renderedSize = null;
    try { renderCleanup?.(); } catch { /* A renderer cleanup must not stop generation. */ }
    renderCleanup = null;
    slot.replaceChildren();
    slot.hidden = true;
  }
  function fits(width, height) {
    const measured = slot.getBoundingClientRect();
    const availableWidth = Math.min(slot.parentElement?.getBoundingClientRect().width ?? measured.width,
      measured.width);
    return width > 0 && height > 0 && availableWidth >= width && measured.height >= height;
  }
  function onSizeChange() {
    if (renderedSize && !fits(renderedSize.width, renderedSize.height)) {
      slot.dataset.wavebirdStatus = "no_fit";
      clearSlot();
    }
  }
  const sizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(onSizeChange) : null;
  sizeObserver?.observe(slot);
  if (slot.parentElement) sizeObserver?.observe(slot.parentElement);
  function invalidate() {
    ++epoch;
    placementAbort?.abort();
    placementAbort = null;
    clearSlot();
  }
  function armAuthority(expiresAt) {
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
    authorityExpiresAt = authorityExpiresAt ? Math.min(authorityExpiresAt, expiresAt) : expiresAt;
    if (authorityTimer !== null) clearTimeout(authorityTimer);
    const checkExpiry = () => {
      authorityTimer = null;
      const remaining = authorityExpiresAt - Date.now();
      if (remaining <= 0) {
        authorityExpiresAt = 0;
        consentGranted = false;
        invalidate();
      } else {
        authorityTimer = setTimeout(checkExpiry, Math.min(remaining, 2147483647));
      }
    };
    checkExpiry();
    return authorityExpiresAt > 0;
  }
  async function session() {
    const id = await getSessionId();
    if (typeof id !== "string" || !id.trim()) throw new Error("Real app session required");
    return id;
  }
  async function syncChoice(state, remember = true, restoredRevision = null) {
    invalidate();
    const token = epoch;
    if (authorityTimer !== null) clearTimeout(authorityTimer);
    authorityTimer = null;
    authorityExpiresAt = 0;
    consentGranted = false;
    if (disposed || privacyBlocked()) return false;
    if (!["granted", "denied", "withdrawn", "cmp_error"].includes(state)) return false;
    const sessionId = await session();
    if (!remember && (!Number.isSafeInteger(restoredRevision) || restoredRevision < 2)) return false;
    const response = await post("/api/wavebird/consent", {
      session_id: sessionId, lifecycle_state: state, remember_for_30_days: remember,
      ...(remember ? {} : { revision: restoredRevision }),
    });
    if (!response.ok || disposed || token !== epoch || privacyBlocked()) return false;
    const payload = await response.json();
    if (disposed || token !== epoch || privacyBlocked()) return false;
    const authority = payload.authoritative_consent;
    if (!Number.isSafeInteger(authority?.revision) || authority.revision < 1 ||
        (!remember && authority.revision !== restoredRevision)) return false;
    revision = authority.revision;
    consentGranted = state === "granted" &&
      authority?.lifecycle_state === "granted" &&
      armAuthority(authority?.expires_at_ms);
    return consentGranted;
  }
  async function restoreChoice() {
    if (disposed || privacyBlocked()) return false;
    try {
      const response = await fetch(apiRoute("/api/wavebird/consent"), {
        credentials: "same-origin", cache: "no-store",
      });
      if (!response.ok) return false;
      const preference = (await response.json()).preference;
      if (preference?.state !== "granted" || preference.expires_at <= Date.now() ||
          !Number.isSafeInteger(preference.revision) || preference.revision < 1) return false;
      return await syncChoice("granted", false, preference.revision + 1);
    } catch { return false; }
  }
  const readyChoice = restoreChoice();
  async function ensureRenderer() {
    if (window.wavebird?.renderPlacement) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://api.wavebird.ai/v1/render.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("renderer_unavailable"));
      document.head.append(script);
    });
    if (!window.wavebird?.renderPlacement) throw new Error("renderer_unavailable");
  }
  async function sponsor(turnId, sessionId, token, lifecycle) {
    await readyChoice;
    if (!consentGranted || privacyBlocked() || token !== epoch || lifecycle.sponsorEnded) return;
    slot.hidden = false;
    const parent = slot.parentElement?.getBoundingClientRect();
    const own = slot.getBoundingClientRect();
    const containerSize = {
      width: Math.floor(Math.min(parent?.width ?? own.width, own.width)),
      height: Math.floor(own.height),
    };
    if (containerSize.width < 1 || containerSize.height < 1) {
      slot.dataset.wavebirdStatus = "no_fit";
      clearSlot();
      return;
    }
    let format;
    try { format = typeof getFormat === "function" ? getFormat() : "auto"; }
    catch { clearSlot(); return; }
    if (!["auto", "banner", "native", "clip"].includes(format)) { clearSlot(); return; }
    const controller = new AbortController();
    placementAbort = controller;
    try {
      const response = await post("/api/wavebird/placement", {
        session_id: sessionId, turn_id: turnId, format, container_size: containerSize,
      }, controller.signal);
      if (token !== epoch || lifecycle.sponsorEnded) return;
      if (!response.ok || privacyBlocked()) { clearSlot(); return; }
      const payload = await response.json();
      if (payload.decision?.fill !== true || !payload.placement) { clearSlot(); return; } // No-Fill.
      lifecycle.format = payload.decision?.format;
      if (timing === "during" && lifecycle.modelFinished && lifecycle.format === "clip") {
        clearSlot();
        return;
      }
      const width = Number(payload.placement?.width ?? payload.decision?.dimensions?.width);
      const height = Number(payload.placement?.height ?? payload.decision?.dimensions?.height);
      if (!fits(width, height)) {
        slot.dataset.wavebirdStatus = "no_fit";
        clearSlot();
        return;
      }
      if (payload.authoritative_consent?.lifecycle_state !== "granted" ||
          payload.authoritative_consent?.revision !== revision ||
          !armAuthority(payload.authoritative_consent?.expires_at_ms)) { clearSlot(); return; }
      await ensureRenderer();
      if (token !== epoch || lifecycle.sponsorEnded || !consentGranted || privacyBlocked()) return;
      if (!fits(width, height)) {
        slot.dataset.wavebirdStatus = "no_fit";
        clearSlot();
        return;
      }
      slot.hidden = false;
      let clipCompleted = false;
      let renderFailed = false;
      const onRenderFailed = () => {
        if (renderFailed || token !== epoch || lifecycle.sponsorEnded || disposed) return;
        renderFailed = true;
        slot.dataset.wavebirdStatus = "frame_error";
        clearSlot();
      };
      const onClipCompleted = () => {
        if (clipCompleted || payload.decision?.format !== "clip" ||
            token !== epoch || lifecycle.sponsorEnded || !consentGranted || privacyBlocked() || disposed) return;
        clipCompleted = true;
        lifecycle.sponsorEnded = true;
        slot.dataset.wavebirdStatus = "completed";
        if (renderCleanup) clearSlot();
      };
      const cleanup = await window.wavebird.renderPlacement({
        target: slot, placement: payload.placement, decision: payload.decision,
        authoritative_consent: payload.authoritative_consent,
        onClipCompleted, onRenderFailed,
      });
      if (renderFailed) {
        if (typeof cleanup === "function") cleanup();
        return;
      }
      if (clipCompleted) {
        if (typeof cleanup === "function") cleanup();
        clearSlot();
        return;
      }
      if (token !== epoch || lifecycle.sponsorEnded || !consentGranted || privacyBlocked()) {
        if (typeof cleanup === "function") cleanup();
        return;
      }
      if (typeof cleanup !== "function") { clearSlot(); return; }
      renderCleanup = cleanup;
      renderedSize = { width, height };
      onSizeChange();
    } catch (error) {
      if (error?.name !== "AbortError" && token === epoch) clearSlot();
    } finally { if (placementAbort === controller) placementAbort = null; }
  }
  async function run() {
    const prompt = promptInput.value.trim();
    if (!prompt || disposed) return;
    generationAbort?.abort();
    invalidate();
    const token = epoch, turnId = crypto.randomUUID();
    const lifecycle = { format: null, modelFinished: false, sponsorEnded: false };
    const sessionId = await session();
    if (token !== epoch || disposed) return;
    generationAbort = new AbortController();
    stopButton.disabled = false;
    result.replaceChildren();
    if (timing !== "after") void sponsor(turnId, sessionId, token, lifecycle);
    try {
      const response = await post("/api/wavebird/generate", {
        session_id: sessionId, turn_id: turnId, prompt,
      }, generationAbort.signal);
      if (!response.ok) throw new Error("Generation failed");
      await consumeGeneration(response, generationAbort.signal, (item) => {
        if (token === epoch) {
          result.append(typeof Node !== "undefined" && item instanceof Node
            ? item : document.createTextNode(String(item)));
          if (timing === "before" && !lifecycle.sponsorEnded) {
            lifecycle.sponsorEnded = true;
            placementAbort?.abort();
            clearSlot();
          }
        }
      });
      lifecycle.modelFinished = true;
      if (timing === "after" && token === epoch) void sponsor(turnId, sessionId, token, lifecycle);
      if (token === epoch && (timing === "before" ||
          (timing === "during" && (jobType !== "chat" || lifecycle.format === "clip")))) {
        lifecycle.sponsorEnded = true;
        invalidate();
      }
    } catch (error) {
      if (token === epoch) {
        invalidate();
        result.textContent = error?.name === "AbortError" ? "Stopped" : "Generation unavailable";
      }
    } finally {
      if (token === epoch) {
        stopButton.disabled = true;
      }
    }
  }
  async function chooseBuiltIn() {
    if (consentMode === "own_cmp") {
      if (typeof chooseOwnCmp !== "function") throw new Error("Connect the real CMP");
      const choiceEpoch = epoch;
      try {
        const state = await chooseOwnCmp();
        if (disposed || choiceEpoch !== epoch) return false;
        return syncChoice(state);
      } catch {
        if (disposed || choiceEpoch !== epoch) return false;
        return syncChoice("cmp_error");
      }
    }
    if (!choiceDialog || typeof choiceDialog.showModal !== "function") throw new Error("Consent dialog required");
    const state = await new Promise((resolve) => {
      choiceDialog.addEventListener("close", () => resolve(choiceDialog.returnValue || "denied"), { once: true });
      choiceDialog.showModal();
    });
    return syncChoice(state);
  }
  const onRun = () => void run().catch(() => { result.textContent = "Sign in required"; });
  const onStop = () => { generationAbort?.abort(); invalidate(); stopButton.disabled = true; result.textContent = "Stopped"; };
  const onPrivacyChange = () => {
    if (privacyBlocked()) {
      if (authorityTimer !== null) clearTimeout(authorityTimer);
      authorityTimer = null;
      authorityExpiresAt = 0;
      consentGranted = false;
      invalidate();
    }
  };
  const onConsent = () => void readyChoice.then(chooseBuiltIn).catch(() => { clearSlot(); });
  const onWithdraw = () => void readyChoice.then(() => syncChoice("withdrawn")).catch(() => { clearSlot(); });
  runButton.addEventListener("click", onRun);
  stopButton.addEventListener("click", onStop);
  consentButton.addEventListener("click", onConsent);
  withdrawButton.addEventListener("click", onWithdraw);
  window.addEventListener?.("focus", onPrivacyChange);
  window.addEventListener?.("resize", onSizeChange);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    sizeObserver?.disconnect();
    window.removeEventListener?.("resize", onSizeChange);
    if (authorityTimer !== null) clearTimeout(authorityTimer);
    authorityExpiresAt = 0;
    generationAbort?.abort();
    invalidate();
    runButton.removeEventListener("click", onRun);
    stopButton.removeEventListener("click", onStop);
    consentButton.removeEventListener("click", onConsent);
    withdrawButton.removeEventListener("click", onWithdraw);
    window.removeEventListener?.("focus", onPrivacyChange);
    window.removeEventListener?.("pagehide", dispose);
  };
  window.addEventListener?.("pagehide", dispose);
  return dispose;
}
