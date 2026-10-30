/** PostgreSQL adapter for an existing publisher database; no database client is bundled. */
const TABLE = "wavebird_publisher_turns";
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  scope_id text NOT NULL,
  turn_key text NOT NULL,
  state_json jsonb NOT NULL,
  pending boolean NOT NULL,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  PRIMARY KEY (scope_id, turn_key)
)`;
const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS wavebird_publisher_turns_pending
  ON ${TABLE} (scope_id, turn_key) WHERE pending = true`;

export function createPostgresTurnStorage(pool) {
  if (!pool || typeof pool.connect !== "function") throw new Error("publisher_postgres_pool_required");
  async function withClient(run) {
    const client = await pool.connect();
    try { return await run(client); } finally { client.release(); }
  }
  async function install() {
    await withClient(async client => {
      await client.query(CREATE_TABLE);
      await client.query(CREATE_INDEX);
    });
  }
  async function atomic(scope, key, transition) {
    return withClient(async client => {
      await client.query("BEGIN");
      try {
        const now = Date.now();
        await client.query(`INSERT INTO ${TABLE}(scope_id,turn_key,state_json,pending,created_at_ms,updated_at_ms)
          VALUES ($1,$2,'null'::jsonb,false,$3,$3) ON CONFLICT DO NOTHING`, [scope, key, now]);
        const row = await client.query(`SELECT state_json FROM ${TABLE} WHERE scope_id=$1 AND turn_key=$2 FOR UPDATE`, [scope, key]);
        if (row.rows.length !== 1) throw new Error("publisher_turn_storage_conflict");
        const value = row.rows[0].state_json;
        const previous = typeof value === "string" ? JSON.parse(value) : value;
        const { state, result } = transition(previous);
        if (state === null) {
          await client.query(`DELETE FROM ${TABLE} WHERE scope_id=$1 AND turn_key=$2`, [scope, key]);
        } else {
          const pending = Boolean(state.jobId && state.phase !== "idle" &&
            (!state.startedReported || (["finished", "failed"].includes(state.phase) && !state.terminalReported)));
          await client.query(`UPDATE ${TABLE} SET state_json=$3::jsonb,pending=$4,updated_at_ms=$5
            WHERE scope_id=$1 AND turn_key=$2`, [scope, key, JSON.stringify(state), pending, now]);
        }
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
      }
    });
  }
  async function scan(scope, cursor, limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("publisher_turn_scan_invalid");
    return withClient(async client => {
      const result = await client.query(`SELECT turn_key FROM ${TABLE}
        WHERE scope_id=$1 AND pending=true AND turn_key>$2 ORDER BY turn_key LIMIT $3`, [scope, cursor, limit]);
      return result.rows.map(row => row.turn_key);
    });
  }
  async function prune(scope) {
    return withClient(async client => {
      await client.query("BEGIN");
      try {
        const now = Date.now();
        await client.query(`DELETE FROM ${TABLE} WHERE scope_id=$1 AND pending=false AND updated_at_ms<$2`,
          [scope, now - 86_400_000]);
        const expired = await client.query(`DELETE FROM ${TABLE} WHERE scope_id=$1 AND pending=true AND created_at_ms<$2 RETURNING turn_key`,
          [scope, now - 7 * 86_400_000]);
        await client.query("COMMIT");
        return expired.rowCount;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
      }
    });
  }
  return { install, atomic, scan, prune };
}
