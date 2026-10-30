import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublisherTurnJournal, derivePublisherTurnKeySecret } from "../dist/server.js";

test("journal key is stable, domain separated, and requires a server preference secret", () => {
  const preference = "synthetic-server-preference-secret-32-bytes";
  const key = derivePublisherTurnKeySecret(preference);
  assert.equal(key, derivePublisherTurnKeySecret(preference));
  assert.notEqual(key, preference);
  assert.notEqual(key, derivePublisherTurnKeySecret("another-synthetic-server-preference-secret"));
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.throws(() => derivePublisherTurnKeySecret("short"), /publisher_preference_secret_invalid/);
});

test("a changed key cannot claim an existing turn as new across workers", async () => {
  const storage = new AtomicStore();
  const turn = { projectId: "wbproj_synthetic", surfaceId: "assistant", sessionId: "session", turnId: "turn" };
  const make = preference => createPublisherTurnJournal({ storage,
    keySecret: derivePublisherTurnKeySecret(preference), reportGeneration: async () => {} });
  const first = make("synthetic-preference-secret-before-rotation");
  assert.equal(await first.claimPlacement(turn), true);
  const turnRow = [...storage.rows.entries()].find(([, value]) => value?.placementClaimed)?.[0];
  assert.ok(turnRow);
  const rotated = make("synthetic-preference-secret-after-rotation");
  await assert.rejects(() => rotated.claimPlacement(turn), /publisher_turn_key_version_conflict/);
  assert.equal(await first.claimPlacement(turn), false);
  storage.rows.delete(turnRow);
  await assert.rejects(() => rotated.claimPlacement(turn), /publisher_turn_key_version_conflict/,
    "ordinary turn retention must not erase the version guard");
});

class AtomicStore {
  rows = new Map();
  tails = new Map();
  async atomic(scope, key, transition) {
    const id = `${scope}:${key}`;
    const previous = this.tails.get(id) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    this.tails.set(id, previous.then(() => gate));
    await previous;
    try {
      const { state, result } = transition(structuredClone(this.rows.get(id) ?? null));
      if (state === null) this.rows.delete(id);
      else this.rows.set(id, structuredClone(state));
      return result;
    } finally { release(); }
  }
  async scan(scope, cursor, limit) {
    return [...this.rows.keys()].filter(id => id.startsWith(`${scope}:`)).map(id => id.slice(65))
      .filter(key => key > cursor).sort().slice(0, limit);
  }
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for bounded local report state");
}

test("package journal owns exact turn, ordered report retry and restart reconciliation", async () => {
  const storage = new AtomicStore();
  const attempts = [];
  const diagnostics = [];
  let reportAvailable = false;
  const reportGeneration = async (jobId, event) => {
    attempts.push([jobId, event]);
    if (!reportAvailable) throw new Error("synthetic_report_unavailable");
  };
  const create = () => createPublisherTurnJournal({ storage, reportGeneration,
    keySecret: "synthetic-stable-turn-key-secret-32-bytes", onDiagnostic: code => diagnostics.push(code) });
  const first = create(), second = create();
  const turn = { projectId: "wbproj_synthetic", surfaceId: "assistant", sessionId: "synthetic_session", turnId: "turn_one" };
  assert.deepEqual((await Promise.all([first.claimPlacement(turn), second.claimPlacement(turn)])).sort(), [false, true]);
  assert.deepEqual((await Promise.all([first.claimGeneration(turn), second.claimGeneration(turn)])).sort(), [false, true]);
  await first.phase(turn, "started");
  await first.bind(turn, "job_synthetic");
  await first.phase(turn, "finished");
  await waitFor(() => attempts.length > 0);
  assert.ok(attempts.every(([, event]) => event === "started"), "terminal waits for accepted start");
  assert.ok(diagnostics.includes("generation_report_unavailable"));
  assert.equal(await first.claimGeneration(turn), false);
  await assert.rejects(() => second.bind(turn, "job_foreign"), /publisher_turn_job_conflict/);
  assert.equal([...storage.rows.keys()].some(key => key.includes("synthetic_session")), false);
  assert.equal(JSON.stringify([...storage.rows.values()]).includes("synthetic_session"), false);
  await new Promise(resolve => setTimeout(resolve, 20));
  reportAvailable = true;
  const restarted = create();
  await restarted.reconcilePending(turn.projectId, turn.surfaceId);
  assert.deepEqual(attempts.slice(-2), [["job_synthetic", "started"], ["job_synthetic", "finished"]]);
  await restarted.phase(turn, "failed");
  assert.equal(await restarted.claimPlacement(turn), false);
});

test("journal scan remains scoped to its project and rejects malformed identity", async () => {
  const storage = new AtomicStore();
  const reports = [];
  let available = false;
  const journal = createPublisherTurnJournal({ storage,
    keySecret: "synthetic-stable-turn-key-secret-32-bytes",
    reportGeneration: async (jobId, event) => {
      reports.push([jobId, event]);
      if (!available) throw new Error("synthetic_report_unavailable");
    } });
  const foreign = { projectId: "wbproj_foreign", surfaceId: "assistant", sessionId: "session", turnId: "turn" };
  await journal.claimPlacement(foreign);
  await journal.claimGeneration(foreign);
  await journal.phase(foreign, "started");
  await journal.bind(foreign, "job_foreign");
  await waitFor(() => reports.length > 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  const before = reports.length;
  await journal.reconcilePending("wbproj_other", "assistant");
  assert.equal(reports.length, before);
  available = true;
  await journal.reconcilePending("wbproj_foreign", "assistant");
  await waitFor(() => reports.length === before + 1);
  assert.deepEqual(reports.at(-1), ["job_foreign", "started"]);
  await assert.rejects(() => journal.claimPlacement({ ...foreign, turnId: "bad turn" }), /publisher_turn_context_invalid/);
});
