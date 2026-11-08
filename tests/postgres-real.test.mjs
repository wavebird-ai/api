import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPostgresTurnStorage, createPublisherTurnJournal } from "../dist/server.js";

const run = promisify(execFile);

test("real PostgreSQL serializes two processes and reconciles ordered reports after restart", {
  skip: !process.env.WAVEBIRD_TEST_DATABASE_URL,
}, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.WAVEBIRD_TEST_DATABASE_URL, max: 4 });
  const storage = createPostgresTurnStorage(pool);
  const turn = {
    projectId: "wbproj_realtest",
    surfaceId: "assistant",
    sessionId: "session_" + randomUUID(),
    turnId: "turn_" + randomUUID(),
  };
  const attempts = [];
  const diagnostics = [];
  const makeJournal = available => createPublisherTurnJournal({
    storage, keySecret: "synthetic-stable-turn-key-secret-32-bytes",
    reportGeneration: async (jobId, event) => {
      attempts.push([jobId, event]);
      if (!available) throw new Error("synthetic_report_unavailable");
    },
    onDiagnostic: code => diagnostics.push(code),
  });
  try {
    await storage.install();
    const worker = fileURLToPath(new URL("./postgres-real-worker.mjs", import.meta.url));
    const result = await Promise.all([0, 1].map(() => run(process.execPath, [worker, JSON.stringify(turn)], {
      env: process.env, windowsHide: true,
    })));
    assert.deepEqual(result.map(item => item.stdout).sort(), ["claimed", "replayed"]);
    await assert.rejects(() => run(process.execPath,
      [worker, JSON.stringify(turn), "synthetic-rotated-turn-key-secret-32-bytes"],
      { env: process.env, windowsHide: true }), error =>
      error.stderr.includes("publisher_turn_key_version_conflict"));
    const first = makeJournal(false);
    assert.equal(await first.claimGeneration(turn), true);
    await first.phase(turn, "started");
    await first.bind(turn, "job_" + randomUUID());
    await first.phase(turn, "finished");
    for (let count = 0; count < 100 && !diagnostics.includes("generation_report_unavailable"); count++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(diagnostics.includes("generation_report_unavailable"));
    assert.ok(attempts.every(([, event]) => event === "started"));
    const restarted = makeJournal(true);
    await restarted.reconcilePending(turn.projectId, turn.surfaceId);
    assert.deepEqual(attempts.slice(-2).map(([, event]) => event), ["started", "finished"]);
    const state = await pool.query("SELECT state_json::text AS state FROM wavebird_publisher_turns");
    assert.equal(state.rows.some(row => row.state.includes(turn.sessionId) || row.state.includes(turn.turnId)), false);
    assert.equal(await restarted.claimPlacement(turn), false);
  } finally {
    await pool.end();
  }
});
