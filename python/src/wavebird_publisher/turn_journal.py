"""Single-host durable turn coordination for an opt-in FastAPI integration.

The publisher supplies an absolute path on storage shared by its local workers.
Only keyed turn state and fixed report phases are stored; model output and ad
payloads never enter this journal. A separate shared-store adapter is needed
when workers run on different hosts.
"""

import asyncio
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Callable

from asyncio import to_thread

_JOB = re.compile(r"^job_[A-Za-z0-9_-]{1,128}$")


class SqliteTurnJournal:
    def __init__(self, server, path: str | os.PathLike[str],
                 on_diagnostic: Callable[[str], None] | None = None) -> None:
        self.server = server
        self.on_diagnostic = on_diagnostic
        self.path = Path(path)
        if not self.path.is_absolute() or not self.path.parent.is_dir() or self.path.exists() and not self.path.is_file():
            raise ValueError("wavebird_turn_store_path_invalid")
        self._scope = (server.config.client_id + ":" + server.config.surface_id + ":").encode()
        self._scope_id = hashlib.sha256(self._scope).hexdigest()
        self._tasks: set[asyncio.Task[None]] = set()
        self._report_slots = asyncio.Semaphore(4)
        self._sweeper: asyncio.Task[None] | None = None
        self._init()

    def _key(self, identity: tuple[str, str]) -> str:
        return hmac.new(self._secret, self._scope + identity[0].encode() + b":" + identity[1].encode(), hashlib.sha256).hexdigest()

    def _db(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        db.execute("PRAGMA busy_timeout=5000")
        return db

    def _init(self) -> None:
        with closing(self._db()) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS wavebird_turn_scopes (
                scope_id TEXT PRIMARY KEY, hash_key BLOB NOT NULL
            )""")
            db.execute("INSERT OR IGNORE INTO wavebird_turn_scopes(scope_id,hash_key) VALUES (?,?)",
                       (self._scope_id, secrets.token_bytes(32)))
            self._secret = db.execute("SELECT hash_key FROM wavebird_turn_scopes WHERE scope_id=?",
                                      (self._scope_id,)).fetchone()[0]
            db.execute("""CREATE TABLE IF NOT EXISTS wavebird_turns (
                turn_key TEXT PRIMARY KEY, scope_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
                placement_claimed INTEGER NOT NULL DEFAULT 0,
                generation_claimed INTEGER NOT NULL DEFAULT 0,
                job_id TEXT, phase TEXT NOT NULL DEFAULT 'idle',
                started_reported INTEGER NOT NULL DEFAULT 0,
                terminal_reported INTEGER NOT NULL DEFAULT 0,
                lease_id TEXT, lease_until_ms INTEGER NOT NULL DEFAULT 0
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS wavebird_turns_scope_age ON wavebird_turns(scope_id,created_at_ms)")

    def _change(self, key: str, operation: str, value: str | None = None) -> bool:
        with closing(self._db()) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT OR IGNORE INTO wavebird_turns(turn_key,scope_id,created_at_ms) VALUES (?,?,?)", (key, self._scope_id, int(time.time() * 1000)))
            if operation == "claim_placement":
                result = db.execute("UPDATE wavebird_turns SET placement_claimed=1 WHERE turn_key=? AND placement_claimed=0", (key,))
            elif operation == "release_placement":
                result = db.execute("UPDATE wavebird_turns SET placement_claimed=0 WHERE turn_key=? AND job_id IS NULL", (key,))
            elif operation == "claim_generation":
                result = db.execute("UPDATE wavebird_turns SET generation_claimed=1 WHERE turn_key=? AND generation_claimed=0", (key,))
            elif operation == "bind":
                if not value or not _JOB.fullmatch(value):
                    raise ValueError("wavebird_job_id_invalid")
                result = db.execute("UPDATE wavebird_turns SET job_id=? WHERE turn_key=? AND placement_claimed=1 AND (job_id IS NULL OR job_id=?)", (value, key, value))
            elif operation == "phase":
                if value not in ("started", "finished", "failed"):
                    raise ValueError("wavebird_phase_invalid")
                expected = "idle" if value == "started" else "started"
                result = db.execute("UPDATE wavebird_turns SET phase=? WHERE turn_key=? AND generation_claimed=1 AND phase=?", (value, key, expected))
            else:
                raise ValueError("wavebird_turn_operation_invalid")
            db.commit()
            return result.rowcount == 1

    async def claim_placement(self, identity: tuple[str, str]) -> bool:
        return await to_thread(self._change, self._key(identity), "claim_placement")

    async def release_rejected_placement(self, identity: tuple[str, str]) -> None:
        await to_thread(self._change, self._key(identity), "release_placement")

    async def claim_generation(self, identity: tuple[str, str]) -> bool:
        return await to_thread(self._change, self._key(identity), "claim_generation")

    async def bind(self, identity: tuple[str, str], job_id: str) -> None:
        if not await to_thread(self._change, self._key(identity), "bind", job_id):
            raise ValueError("wavebird_turn_job_conflict")
        self._schedule(self._key(identity))

    async def phase(self, identity: tuple[str, str], event: str) -> None:
        if await to_thread(self._change, self._key(identity), "phase", event):
            self._schedule(self._key(identity))

    def _lease(self, key: str) -> tuple[str, str, str] | None:
        with closing(self._db()) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT job_id,phase,started_reported,terminal_reported,lease_until_ms FROM wavebird_turns WHERE turn_key=?", (key,)).fetchone()
            if not row or not row[0] or row[1] == "idle" or row[4] > int(time.time() * 1000):
                db.commit()
                return None
            event = "started" if not row[2] else row[1] if row[1] in ("finished", "failed") and not row[3] else None
            if event is None:
                db.commit()
                return None
            lease_id = secrets.token_hex(16)
            db.execute("UPDATE wavebird_turns SET lease_id=?,lease_until_ms=? WHERE turn_key=?", (lease_id, int(time.time() * 1000) + 10_000, key))
            db.commit()
            return row[0], event, lease_id

    def _ack(self, key: str, event: str, lease_id: str, accepted: bool) -> None:
        with closing(self._db()) as db:
            db.execute("BEGIN IMMEDIATE")
            if accepted:
                column = "started_reported" if event == "started" else "terminal_reported"
                db.execute(f"UPDATE wavebird_turns SET {column}=1,lease_id=NULL,lease_until_ms=0 WHERE turn_key=? AND lease_id=?", (key, lease_id))
            else:
                db.execute("UPDATE wavebird_turns SET lease_id=NULL,lease_until_ms=0 WHERE turn_key=? AND lease_id=?", (key, lease_id))
            db.commit()

    async def _drain(self, key: str) -> None:
        while True:
            lease = await to_thread(self._lease, key)
            if lease is None:
                return
            job_id, event, lease_id = lease
            accepted = False
            async with self._report_slots:
                try:
                    accepted = (await to_thread(self.server.report_generation, job_id, event)).status == 200
                except Exception:
                    pass
            await to_thread(self._ack, key, event, lease_id, accepted)
            if not accepted:
                self._diagnostic("generation_report_unavailable")
                return

    def _diagnostic(self, code: str) -> None:
        if self.on_diagnostic:
            try:
                self.on_diagnostic(code)
            except Exception:
                pass

    def _schedule(self, key: str) -> None:
        task = asyncio.create_task(self._drain(key))
        self._tasks.add(task)
        def completed(finished: asyncio.Task[None]) -> None:
            self._tasks.discard(finished)
            if not finished.cancelled() and finished.exception() is not None:
                self._diagnostic("turn_journal_unavailable")
        task.add_done_callback(completed)

    def _pending(self, after_key: str = "") -> list[str]:
        with closing(self._db()) as db:
            return [row[0] for row in db.execute("""SELECT turn_key FROM wavebird_turns
                WHERE scope_id=? AND turn_key>? AND job_id IS NOT NULL AND phase != 'idle'
                AND (started_reported=0 OR (phase IN ('finished','failed') AND terminal_reported=0))
                ORDER BY turn_key LIMIT 100""", (self._scope_id, after_key))]

    def _prune(self) -> None:
        now = int(time.time() * 1000)
        with closing(self._db()) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("""DELETE FROM wavebird_turns WHERE scope_id=? AND created_at_ms<?
                AND ((phase='idle' AND job_id IS NULL)
                OR (phase IN ('finished','failed') AND started_reported=1 AND terminal_reported=1))""",
                       (self._scope_id, now - 86_400_000))
            expired = db.execute("""DELETE FROM wavebird_turns WHERE scope_id=? AND created_at_ms<?
                AND (started_reported=0 OR (phase IN ('finished','failed') AND terminal_reported=0))""",
                                 (self._scope_id, now - 7 * 86_400_000)).rowcount
            db.commit()
        if expired:
            self._diagnostic("generation_report_retention_expired")

    async def reconcile_pending(self) -> None:
        if self._sweeper is not None and not self._sweeper.done():
            return
        async def sweep() -> None:
            await to_thread(self._prune)
            after_key = ""
            while True:
                keys = await to_thread(self._pending, after_key)
                if not keys:
                    return
                await asyncio.gather(*(self._drain(key) for key in keys))
                after_key = keys[-1]
        self._sweeper = asyncio.create_task(sweep())
        self._tasks.add(self._sweeper)
        def completed(finished: asyncio.Task[None]) -> None:
            self._tasks.discard(finished)
            if not finished.cancelled() and finished.exception() is not None:
                self._diagnostic("turn_journal_unavailable")
        self._sweeper.add_done_callback(completed)
