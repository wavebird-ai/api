import assert from "node:assert/strict";
import { test } from "node:test";
import { createPostgresTurnStorage } from "../dist/server.js";

function fakePool({ failUpdate = false } = {}) {
  const calls = [];
  let released = 0;
  const pool = { async connect() {
    return {
      async query(sql, params = []) {
        calls.push([sql, params]);
        if (failUpdate && sql.startsWith("UPDATE")) throw new Error("synthetic_update_failure");
        if (sql.startsWith("SELECT state_json")) return { rows: [{ state_json: null }] };
        if (sql.startsWith("SELECT turn_key")) return { rows: [{ turn_key: "a".repeat(64) }] };
        if (sql.includes("RETURNING turn_key")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      },
      release() { released++; },
    };
  } };
  return { pool, calls, releases: () => released };
}

test("Postgres storage uses one locked transaction and scoped pending scan", async () => {
  const fake = fakePool();
  const storage = createPostgresTurnStorage(fake.pool);
  await storage.install();
  assert.equal(fake.calls.filter(([sql]) => sql.startsWith("CREATE")).length, 2);
  const result = await storage.atomic("scope", "key", previous => {
    assert.equal(previous, null);
    return { state: { scope: "scope", jobId: "job_synthetic", phase: "started", startedReported: false }, result: "claimed" };
  });
  assert.equal(result, "claimed");
  assert.deepEqual(fake.calls.filter(([sql]) => sql === "BEGIN" || sql === "COMMIT").map(([sql]) => sql), ["BEGIN", "COMMIT"]);
  const update = fake.calls.find(([sql]) => sql.startsWith("UPDATE"));
  assert.equal(update[1][0], "scope");
  assert.equal(update[1][1], "key");
  assert.equal(update[1][3], true);
  assert.deepEqual(await storage.scan("scope", "", 100), ["a".repeat(64)]);
  const scan = fake.calls.find(([sql]) => sql.startsWith("SELECT turn_key"));
  assert.deepEqual(scan[1], ["scope", "", 100]);
  assert.equal(await storage.prune("scope"), 0);
  assert.equal(fake.releases(), 4);
});

test("Postgres storage rolls back a failed transition and releases its connection", async () => {
  const fake = fakePool({ failUpdate: true });
  const storage = createPostgresTurnStorage(fake.pool);
  await assert.rejects(() => storage.atomic("scope", "key", () => ({ state: { scope: "scope" }, result: null })),
    /synthetic_update_failure/);
  assert.equal(fake.calls.at(-1)[0], "ROLLBACK");
  assert.equal(fake.releases(), 1);
  await assert.rejects(() => storage.scan("scope", "", 101), /publisher_turn_scan_invalid/);
});
