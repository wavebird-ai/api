import { Pool } from "pg";
import { createPostgresTurnStorage, createPublisherTurnJournal } from "../dist/server.js";

const pool = new Pool({ connectionString: process.env.WAVEBIRD_TEST_DATABASE_URL, max: 2 });
try {
  const journal = createPublisherTurnJournal({
    storage: createPostgresTurnStorage(pool),
    reportGeneration: async () => {},
    keySecret: process.argv[3] ?? "synthetic-stable-turn-key-secret-32-bytes",
  });
  const turn = JSON.parse(process.argv[2]);
  process.stdout.write((await journal.claimPlacement(turn)) ? "claimed" : "replayed");
} finally {
  await pool.end();
}
