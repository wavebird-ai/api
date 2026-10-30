import { createHash, createHmac, randomUUID } from "node:crypto";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const JOB_ID = /^job_[A-Za-z0-9_-]{1,128}$/;

/** Domain-separate the stable server preference secret for pseudonymous turn keys. */
export function derivePublisherTurnKeySecret(preferenceSecret) {
  if (typeof preferenceSecret !== "string" || Buffer.byteLength(preferenceSecret, "utf8") < 32)
    throw new Error("publisher_preference_secret_invalid");
  return createHmac("sha256", preferenceSecret).update("wavebird/turn-journal-key/v1").digest("hex");
}

/** Package-owned state machine over a publisher's existing atomic, durable store. */
export function createPublisherTurnJournal({ storage, reportGeneration, keySecret, onDiagnostic }) {
  if (typeof storage?.atomic !== "function" || typeof storage?.scan !== "function" ||
      typeof reportGeneration !== "function") throw new Error("publisher_turn_storage_invalid");
  if (typeof keySecret !== "string" || Buffer.byteLength(keySecret, "utf8") < 32)
    throw new Error("publisher_turn_key_secret_invalid");
  const tasks = new Set();
  let activeReports = 0;
  const reportWaiters = [];
  const diagnostic = code => { try { onDiagnostic?.(code); } catch {} };
  const verifiedScopes = new Set();
  const versionKey = createHash("sha256").update("wavebird/turn-journal-version-row/v1").digest("hex");
  const keyFingerprint = createHmac("sha256", keySecret).update("wavebird/turn-journal-key-version/v1").digest("hex");
  async function verifyKeyVersion(scope) {
    if (verifiedScopes.has(scope)) return;
    // A separate scope keeps this guard outside ordinary turn retention pruning.
    const versionScope = createHash("sha256").update(JSON.stringify(["wavebird/turn-journal-meta/v1", scope])).digest("hex");
    await storage.atomic(versionScope, versionKey, previous => {
      if (previous && previous.keyFingerprint !== keyFingerprint)
        throw new Error("publisher_turn_key_version_conflict");
      return { state: previous || { keyFingerprint }, result: null };
    });
    verifiedScopes.add(scope);
  }
  function identity(turn) {
    if (![turn?.projectId, turn?.surfaceId, turn?.sessionId, turn?.turnId].every(value => ID.test(value || "")))
      throw new Error("publisher_turn_context_invalid");
    const scope = createHash("sha256").update(JSON.stringify([turn.projectId, turn.surfaceId])).digest("hex");
    const key = createHmac("sha256", keySecret).update(JSON.stringify([turn.projectId, turn.surfaceId, turn.sessionId, turn.turnId])).digest("hex");
    return { scope, key };
  }
  function initial(scope) {
    return { scope, createdAtMs: Date.now(), placementClaimed: false, generationClaimed: false,
      jobId: null, phase: "idle", startedReported: false, terminalReported: false,
      leaseId: null, leaseUntilMs: 0 };
  }
  async function change(turn, update) {
    const { scope, key } = identity(turn);
    await verifyKeyVersion(scope);
    return storage.atomic(scope, key, previous => {
      if (previous && previous.scope !== scope) throw new Error("publisher_turn_scope_conflict");
      const state = { ...(previous || initial(scope)) };
      const result = update(state);
      return { state, result };
    });
  }
  async function claimPlacement(turn) {
    return change(turn, state => {
      if (state.placementClaimed) return false;
      state.placementClaimed = true;
      return true;
    });
  }
  async function releaseRejectedPlacement(turn) {
    await change(turn, state => { if (!state.jobId) state.placementClaimed = false; });
  }
  async function claimGeneration(turn) {
    return change(turn, state => {
      if (state.generationClaimed) return false;
      state.generationClaimed = true;
      return true;
    });
  }
  function schedule(scope, key) {
    const task = drain(scope, key).catch(() => diagnostic("turn_journal_unavailable"));
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  }
  async function bind(turn, jobId) {
    if (!JOB_ID.test(jobId || "")) throw new Error("publisher_job_id_invalid");
    const { scope, key } = identity(turn);
    const bound = await change(turn, state => {
      if (!state.placementClaimed || state.jobId && state.jobId !== jobId) return false;
      state.jobId = jobId;
      return true;
    });
    if (!bound) throw new Error("publisher_turn_job_conflict");
    schedule(scope, key);
  }
  async function phase(turn, event) {
    if (!["started", "finished", "failed"].includes(event)) throw new Error("publisher_phase_invalid");
    const { scope, key } = identity(turn);
    const changed = await change(turn, state => {
      if (!state.generationClaimed || state.phase !== (event === "started" ? "idle" : "started")) return false;
      state.phase = event;
      return true;
    });
    if (changed) schedule(scope, key);
  }
  async function lease(scope, key) {
    return storage.atomic(scope, key, previous => {
      if (!previous || previous.scope !== scope || !previous.jobId || previous.phase === "idle" ||
          previous.leaseUntilMs > Date.now()) return { state: previous, result: null };
      const event = !previous.startedReported ? "started" :
        ["finished", "failed"].includes(previous.phase) && !previous.terminalReported ? previous.phase : null;
      if (!event) return { state: previous, result: null };
      const leaseId = randomUUID();
      return { state: { ...previous, leaseId, leaseUntilMs: Date.now() + 10_000 },
        result: { jobId: previous.jobId, event, leaseId } };
    });
  }
  async function ack(scope, key, event, leaseId, accepted) {
    await storage.atomic(scope, key, previous => {
      if (!previous || previous.scope !== scope || previous.leaseId !== leaseId)
        return { state: previous, result: null };
      const state = { ...previous, leaseId: null, leaseUntilMs: 0 };
      if (accepted) state[event === "started" ? "startedReported" : "terminalReported"] = true;
      return { state, result: null };
    });
  }
  async function drain(scope, key) {
    while (true) {
      const next = await lease(scope, key);
      if (!next) return;
      if (activeReports >= 4) await new Promise(resolve => reportWaiters.push(resolve));
      activeReports++;
      let accepted = false;
      try { await reportGeneration(next.jobId, next.event); accepted = true; }
      catch { diagnostic("generation_report_unavailable"); }
      finally { activeReports--; reportWaiters.shift()?.(); }
      await ack(scope, key, next.event, next.leaseId, accepted);
      if (!accepted) return;
    }
  }
  async function reconcilePending(projectId, surfaceId) {
    if (!ID.test(projectId || "") || !ID.test(surfaceId || "")) throw new Error("publisher_turn_scope_invalid");
    const scope = createHash("sha256").update(JSON.stringify([projectId, surfaceId])).digest("hex");
    if (typeof storage.prune === "function" && await storage.prune(scope) > 0)
      diagnostic("generation_report_retention_expired");
    let cursor = "";
    while (true) {
      const keys = await storage.scan(scope, cursor, 100);
      if (!Array.isArray(keys) || keys.length > 100 || keys.some((key, index) => typeof key !== "string" ||
        !/^[a-f0-9]{64}$/.test(key) || key <= (index ? keys[index - 1] : cursor)))
        throw new Error("publisher_turn_scan_invalid");
      if (keys.length === 0) return;
      await Promise.all(keys.map(key => drain(scope, key)));
      cursor = keys.at(-1);
    }
  }
  return { claimPlacement, releaseRejectedPlacement, bind, claimGeneration, phase, reconcilePending };
}
