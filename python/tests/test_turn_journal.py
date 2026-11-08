"""Durable, worker-shared turn ownership and ordered report leasing."""

import sqlite3
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from multiprocessing import get_context
from pathlib import Path
from types import SimpleNamespace

from wavebird_publisher.turn_journal import SqliteTurnJournal


def _claim_in_process(path, start, results):
    server = SimpleNamespace(config=SimpleNamespace(
        preference_secret="synthetic-preference-secret-32-bytes",
        client_id="wbproj_synthetic", surface_id="assistant"))
    journal = SqliteTurnJournal(server, path)
    start.wait(5)
    results.put(journal._change(journal._key(("session", "turn")), "claim_generation"))


class TurnJournalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "turns.sqlite3"
        self.server = SimpleNamespace(config=SimpleNamespace(
            preference_secret="synthetic-preference-secret-32-bytes",
            client_id="wbproj_synthetic", surface_id="assistant"))

    def journal(self):
        return SqliteTurnJournal(self.server, self.path)

    def test_two_workers_restart_and_ordered_reports(self):
        first, second = self.journal(), self.journal()
        identity = ("synthetic-session", "synthetic-turn")
        key = first._key(identity)
        self.assertEqual(key, second._key(identity))
        self.assertNotEqual(key, first._key(("synthetic-session", "other-turn")))
        with ThreadPoolExecutor(max_workers=2) as pool:
            claims = list(pool.map(lambda journal: journal._change(key, "claim_placement"), (first, second)))
        self.assertEqual(sorted(claims), [False, True])
        self.assertTrue(second._change(key, "claim_generation"))
        self.assertFalse(first._change(key, "claim_generation"))
        self.assertTrue(second._change(key, "phase", "started"))
        self.assertIsNone(first._lease(key), "reports wait for the exact placement job")
        self.assertTrue(first._change(key, "bind", "job_synthetic"))
        started = second._lease(key)
        self.assertEqual(started[:2], ("job_synthetic", "started"))
        self.assertIsNone(first._lease(key), "other worker cannot report under the active lease")
        second._ack(key, "started", started[2], True)
        self.assertTrue(second._change(key, "phase", "finished"))
        final = self.journal()._lease(key)
        self.assertEqual(final[:2], ("job_synthetic", "finished"))
        first._ack(key, "finished", final[2], True)
        self.assertIsNone(self.journal()._lease(key))
        self.assertEqual(self.journal()._pending(), [])
        self.assertFalse(first._change(key, "phase", "failed"), "late failure cannot replace completion")
        self.assertFalse(first._change(key, "bind", "job_foreign"), "a turn cannot be rebound to another job")

        raw = self.path.read_bytes()
        self.assertNotIn(b"synthetic-session", raw)
        self.assertNotIn(b"synthetic-turn", raw)

    def test_failed_delivery_is_retriable_after_restart_without_reordering(self):
        first = self.journal()
        key = first._key(("session", "turn"))
        first._change(key, "claim_placement")
        first._change(key, "claim_generation")
        first._change(key, "phase", "started")
        first._change(key, "phase", "failed")
        first._change(key, "bind", "job_synthetic")
        started = first._lease(key)
        first._ack(key, "started", started[2], False)
        restarted = self.journal()
        self.assertEqual(restarted._pending(), [key])
        retry = restarted._lease(key)
        self.assertEqual(retry[:2], ("job_synthetic", "started"))
        restarted._ack(key, "started", retry[2], True)
        terminal = restarted._lease(key)
        self.assertEqual(terminal[:2], ("job_synthetic", "failed"))
        restarted._ack(key, "failed", terminal[2], True)
        self.assertEqual(restarted._pending(), [])

    def test_invalid_path_or_job_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "wavebird_turn_store_path_invalid"):
            SqliteTurnJournal(self.server, "relative.sqlite3")
        journal = self.journal()
        key = journal._key(("session", "turn"))
        journal._change(key, "claim_placement")
        with self.assertRaisesRegex(ValueError, "wavebird_job_id_invalid"):
            journal._change(key, "bind", "not-a-job")
        with closing(sqlite3.connect(self.path)) as db:
            self.assertIsNone(db.execute("SELECT job_id FROM wavebird_turns WHERE turn_key=?", (key,)).fetchone()[0])

    def test_reconcile_only_returns_own_project_scope(self):
        first = self.journal()
        foreign_server = SimpleNamespace(config=SimpleNamespace(
            preference_secret="synthetic-preference-secret-32-bytes",
            client_id="wbproj_other", surface_id="assistant"))
        foreign = SqliteTurnJournal(foreign_server, self.path)
        for journal in (first, foreign):
            key = journal._key(("session", "turn"))
            journal._change(key, "claim_placement")
            journal._change(key, "claim_generation")
            journal._change(key, "phase", "started")
            journal._change(key, "bind", "job_synthetic")
        self.assertEqual(first._pending(), [first._key(("session", "turn"))])
        self.assertEqual(foreign._pending(), [foreign._key(("session", "turn"))])

    def test_preference_secret_rotation_does_not_reclaim_an_old_turn(self):
        first = self.journal()
        identity = ("session", "turn")
        self.assertTrue(first._change(first._key(identity), "claim_generation"))
        rotated_server = SimpleNamespace(config=SimpleNamespace(
            preference_secret="different-synthetic-preference-secret-32-bytes",
            client_id="wbproj_synthetic", surface_id="assistant"))
        rotated = SqliteTurnJournal(rotated_server, self.path)
        self.assertEqual(rotated._key(identity), first._key(identity))
        self.assertFalse(rotated._change(rotated._key(identity), "claim_generation"))

    def test_bounded_retention_reports_expired_pending_state(self):
        codes = []
        journal = SqliteTurnJournal(self.server, self.path, codes.append)
        old_pending = journal._key(("session", "old-pending"))
        old_done = journal._key(("session", "old-done"))
        recent_pending = journal._key(("session", "recent"))
        for key in (old_pending, old_done, recent_pending):
            journal._change(key, "claim_placement")
            journal._change(key, "claim_generation")
            journal._change(key, "phase", "started")
            journal._change(key, "bind", "job_synthetic")
        journal._change(old_done, "phase", "finished")
        start = journal._lease(old_done)
        journal._ack(old_done, "started", start[2], True)
        final = journal._lease(old_done)
        journal._ack(old_done, "finished", final[2], True)
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("UPDATE wavebird_turns SET created_at_ms=? WHERE turn_key IN (?,?)",
                       (int(time.time() * 1000) - 8 * 86_400_000, old_pending, old_done))
            db.commit()
        journal._prune()
        with closing(sqlite3.connect(self.path)) as db:
            remaining = {row[0] for row in db.execute("SELECT turn_key FROM wavebird_turns")}
        self.assertEqual(remaining, {recent_pending})
        self.assertEqual(codes, ["generation_report_retention_expired"])

    def test_two_processes_cannot_both_claim_generation(self):
        self.journal()
        context = get_context("spawn")
        start = context.Event()
        results = context.Queue()
        processes = [context.Process(target=_claim_in_process, args=(str(self.path), start, results)) for _ in range(2)]
        for process in processes:
            process.start()
        start.set()
        for process in processes:
            process.join(5)
            if process.is_alive():
                process.terminate()
                process.join(5)
            self.assertEqual(process.exitcode, 0)
        self.assertEqual(sorted([results.get(timeout=1) for _ in processes]), [False, True])
        results.close()
        results.join_thread()


if __name__ == "__main__":
    unittest.main()
