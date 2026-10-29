// Attach to the publisher's existing signed-in page and real generation consumer.
// No Wavebird server credential belongs in this browser file.
export function mountWavebirdPython({
  slot, promptInput, runButton, stopButton, result, consentButton, withdrawButton,
  choiceDialog, getSessionId, consumeGeneration, chooseOwnCmp,
  timing, consentMode, maxHeight,
}) {
  if (!slot || !promptInput || !runButton || !stopButton || !result ||
      !consentButton || !withdrawButton || !getSessionId || !consumeGeneration) {
    throw new Error("Connect the existing app controls, session and model response consumer");
  }
  if (!["before", "during", "after"].includes(timing) ||
      !["wavebird_consent", "own_cmp"].includes(consentMode) ||
      !Number.isSafeInteger(maxHeight) || maxHeight < 1 || maxHeight > 2048) {
    throw new Error("Invalid saved project presentation settings");
  }
  slot.style.minHeight = String(maxHeight + 256) + "px";
  slot.setAttribute("aria-label", "Sponsored placement");
  let revision = 0, epoch = 0, consentGranted = false;
  let generationAbort = null, placementAbort = null, renderCleanup = null;
  let authorityTimer = null, authorityExpiresAt = 0;
  let disposed = false;
  const post = (route, body, signal) => fetch(route, {
    method: "POST", credentials: "same-origin", signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const privacyBlocked = () => navigator.globalPrivacyControl === true;
  function clearSlot() {
    try { renderCleanup?.(); } catch { /* A renderer cleanup must not stop generation. */ }
    renderCleanup = null;
    slot.replaceChildren();
    slot.hidden = true;
  }
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
  async function syncChoice(state, remember = true) {
    invalidate();
    const token = epoch;
    if (authorityTimer !== null) clearTimeout(authorityTimer);
    authorityTimer = null;
    authorityExpiresAt = 0;
    consentGranted = false;
    if (disposed || privacyBlocked()) return false;
    if (!["granted", "denied", "withdrawn", "cmp_error"].includes(state)) return false;
    const sessionId = await session();
    const next = ++revision;
    const response = await post("/api/wavebird/consent", {
      session_id: sessionId, lifecycle_state: state, revision: next,
      remember_for_30_days: remember,
    });
    if (!response.ok || disposed || token !== epoch || privacyBlocked()) return false;
    const payload = await response.json();
    if (disposed || token !== epoch || privacyBlocked()) return false;
    const authority = payload.authoritative_consent;
    consentGranted = state === "granted" &&
      authority?.lifecycle_state === "granted" && authority?.revision === next &&
      armAuthority(authority?.expires_at_ms);
    return consentGranted;
  }
  async function restoreChoice() {
    if (disposed || privacyBlocked()) return false;
    try {
      const response = await fetch("/api/wavebird/consent", {
        credentials: "same-origin", cache: "no-store",
      });
      if (!response.ok) return false;
      const preference = (await response.json()).preference;
      if (preference?.state !== "granted" || preference.expires_at <= Date.now()) return false;
      return await syncChoice("granted", false);
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
  async function sponsor(turnId, sessionId, token) {
    await readyChoice;
    if (!consentGranted || privacyBlocked() || token !== epoch) return;
    const controller = new AbortController();
    placementAbort = controller;
    try {
      const response = await post("/api/wavebird/placement", {
        session_id: sessionId, turn_id: turnId,
      }, controller.signal);
      if (!response.ok || token !== epoch || privacyBlocked()) return;
      const payload = await response.json();
      if (payload.decision?.fill !== true || !payload.placement) return; // No-Fill.
      const width = Number(payload.placement?.width ?? payload.decision?.dimensions?.width);
      const height = Number(payload.placement?.height ?? payload.decision?.dimensions?.height);
      const availableWidth = slot.parentElement?.getBoundingClientRect().width ?? 0;
      if (!(width > 0 && height > 0 && availableWidth >= width)) {
        slot.dataset.wavebirdStatus = "no_fit";
        return;
      }
      if (payload.authoritative_consent?.lifecycle_state !== "granted" ||
          payload.authoritative_consent?.revision !== revision ||
          !armAuthority(payload.authoritative_consent?.expires_at_ms)) return;
      await ensureRenderer();
      if (token !== epoch || !consentGranted || privacyBlocked()) return;
      slot.hidden = false;
      const cleanup = await window.wavebird.renderPlacement({
        target: slot, placement: payload.placement, decision: payload.decision,
        authoritative_consent: payload.authoritative_consent,
      });
      if (token !== epoch || !consentGranted || privacyBlocked()) {
        if (typeof cleanup === "function") cleanup();
        return;
      }
      if (typeof cleanup !== "function") { clearSlot(); return; }
      renderCleanup = cleanup;
    } catch (error) {
      if (error?.name !== "AbortError") clearSlot();
    } finally { if (placementAbort === controller) placementAbort = null; }
  }
  async function run() {
    const prompt = promptInput.value.trim();
    if (!prompt || disposed) return;
    generationAbort?.abort();
    invalidate();
    const token = epoch, turnId = crypto.randomUUID();
    const sessionId = await session();
    if (token !== epoch || disposed) return;
    generationAbort = new AbortController();
    stopButton.disabled = false;
    result.replaceChildren();
    if (timing !== "after") void sponsor(turnId, sessionId, token);
    try {
      const response = await post("/api/wavebird/generate", {
        session_id: sessionId, turn_id: turnId, prompt,
      }, generationAbort.signal);
      if (!response.ok) throw new Error("Generation failed");
      await consumeGeneration(response, generationAbort.signal, (item) => {
        if (token === epoch) result.append(typeof Node !== "undefined" && item instanceof Node
          ? item : document.createTextNode(String(item)));
      });
      if (timing === "after" && token === epoch) void sponsor(turnId, sessionId, token);
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
  return () => {
    disposed = true;
    if (authorityTimer !== null) clearTimeout(authorityTimer);
    authorityExpiresAt = 0;
    generationAbort?.abort();
    invalidate();
    runButton.removeEventListener("click", onRun);
    stopButton.removeEventListener("click", onStop);
    consentButton.removeEventListener("click", onConsent);
    withdrawButton.removeEventListener("click", onWithdraw);
    window.removeEventListener?.("focus", onPrivacyChange);
  };
}
