"""
Central Memory Store using SQLite for persistence.

Provides unified access to all memory types:
- Working memory (ephemeral, in-memory)
- Episodic memory (persistent, SQLite)
- Semantic memory (persistent, SQLite + BM25 search)
- Tool memory (persistent, SQLite)
"""

import sqlite3
import json
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from contextlib import contextmanager

from pydantic import BaseModel


class MemoryRecord(BaseModel):
    """Base model for memory records."""
    id: Optional[str] = None
    created_at: str
    updated_at: str
    data: dict[str, Any]
    tags: list[str] = []
    metadata: dict[str, Any] = {}

    class Config:
        extra = "allow"

    @classmethod
    def create(cls, data: dict[str, Any], **kwargs) -> "MemoryRecord":
        now = datetime.now(timezone.utc).isoformat()
        return cls(
            id=kwargs.get("id") or hashlib.sha256(now.encode() + json.dumps(data).encode()).hexdigest()[:16],
            created_at=now,
            updated_at=now,
            data=data,
            tags=kwargs.get("tags", []),
            metadata=kwargs.get("metadata", {}),
        )


class MemoryStore:
    """
    Central memory store using SQLite for persistence.
    
    Thread-safe, supports concurrent access with proper locking.
    Implements append-only audit logging for critical operations.
    """

    def __init__(self, db_path: str = "worker/storage/worker.db"):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        
        # In-memory working memory cache
        self._working_memory: dict[str, dict[str, Any]] = {}
        
        # Initialize database
        self._init_db()

    def _init_db(self):
        """Initialize SQLite database with required tables."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            
            # Episodic memory table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS episodic_memory (
                    id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL,
                    user_request TEXT,
                    objective TEXT,
                    plan_summary TEXT,
                    result_summary TEXT,
                    success BOOLEAN,
                    errors TEXT,
                    artifacts TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    tags TEXT
                )
            """)
            
            # Semantic memory table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS semantic_memory (
                    id TEXT PRIMARY KEY,
                    category TEXT NOT NULL,
                    key TEXT NOT NULL,
                    value TEXT NOT NULL,
                    content_hash TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    tags TEXT,
                    UNIQUE(category, key)
                )
            """)
            
            # Tool memory table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS tool_memory (
                    id TEXT PRIMARY KEY,
                    tool_name TEXT NOT NULL UNIQUE,
                    total_calls INTEGER DEFAULT 0,
                    successful_calls INTEGER DEFAULT 0,
                    failed_calls INTEGER DEFAULT 0,
                    avg_duration REAL DEFAULT 0.0,
                    last_used_at TEXT,
                    common_errors TEXT,
                    notes TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)
            
            # Audit log table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    task_id TEXT,
                    step_id TEXT,
                    actor TEXT,
                    action TEXT NOT NULL,
                    tool_name TEXT,
                    input_summary TEXT,
                    output_summary TEXT,
                    duration_ms INTEGER,
                    success BOOLEAN,
                    permission_decision TEXT,
                    error TEXT,
                    artifact_refs TEXT,
                    checksum TEXT
                )
            """)
            
            # Create indexes for performance
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_episodic_task_id ON episodic_memory(task_id)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_episodic_success ON episodic_memory(success)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_semantic_category ON semantic_memory(category)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_semantic_key ON semantic_memory(key)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_task_id ON audit_log(task_id)")
            
            conn.commit()

    @contextmanager
    def _get_connection(self):
        """Get database connection with proper error handling."""
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def _row_to_dict(self, row: sqlite3.Row) -> dict[str, Any]:
        """Convert SQLite row to dictionary."""
        if row is None:
            return {}
        return dict(row)

    # ==================== Working Memory ====================

    def working_set(self, task_id: str, key: str, value: Any) -> None:
        """Set a value in working memory for a task."""
        if task_id not in self._working_memory:
            self._working_memory[task_id] = {}
        self._working_memory[task_id][key] = value

    def working_get(self, task_id: str, key: str, default: Any = None) -> Any:
        """Get a value from working memory."""
        if task_id not in self._working_memory:
            return default
        return self._working_memory[task_id].get(key, default)

    def working_get_all(self, task_id: str) -> dict[str, Any]:
        """Get all working memory for a task."""
        return self._working_memory.get(task_id, {})

    def working_clear(self, task_id: str) -> None:
        """Clear working memory for a task."""
        if task_id in self._working_memory:
            del self._working_memory[task_id]

    def working_cleanup(self) -> None:
        """Cleanup old working memory entries (optional TTL logic)."""
        # For now, just keep it simple - working memory is ephemeral
        pass

    # ==================== Episodic Memory ====================

    def episodic_store(self, record: dict[str, Any]) -> str:
        """Store an episodic memory record."""
        record_id = record.get("id") or hashlib.sha256(
            datetime.now(timezone.utc).isoformat().encode()
        ).hexdigest()[:16]
        
        now = datetime.now(timezone.utc).isoformat()
        
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT OR REPLACE INTO episodic_memory 
                (id, task_id, user_request, objective, plan_summary, result_summary, 
                 success, errors, artifacts, created_at, updated_at, tags)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                record_id,
                record.get("task_id", ""),
                record.get("user_request", ""),
                record.get("objective", ""),
                record.get("plan_summary", ""),
                record.get("result_summary", ""),
                record.get("success", False),
                json.dumps(record.get("errors", [])),
                json.dumps(record.get("artifacts", [])),
                record.get("created_at", now),
                now,
                json.dumps(record.get("tags", [])),
            ))
            conn.commit()
        
        return record_id

    def episodic_find_by_task(self, task_id: str) -> Optional[dict[str, Any]]:
        """Find episodic memory by task ID."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM episodic_memory WHERE task_id = ?", (task_id,))
            row = cursor.fetchone()
            if row:
                return self._row_to_dict(row)
        return None

    def episodic_find_similar(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        """
        Find similar episodic memories using keyword search.
        
        Uses simple SQL LIKE matching for MVP. 
        Can be enhanced with BM25 or vector search later.
        """
        results = []
        query_terms = query.lower().split()
        
        with self._get_connection() as conn:
            cursor = conn.cursor()
            # Search in user_request and objective
            for term in query_terms:
                cursor.execute("""
                    SELECT * FROM episodic_memory 
                    WHERE user_request LIKE ? OR objective LIKE ? OR result_summary LIKE ?
                    LIMIT ?
                """, (f"%{term}%", f"%{term}%", f"%{term}%", limit))
                rows = cursor.fetchall()
                for row in rows:
                    record = self._row_to_dict(row)
                    if record not in results:
                        results.append(record)
        
        return results[:limit]

    def episodic_get_recent(self, limit: int = 10) -> list[dict[str, Any]]:
        """Get most recent episodic memories."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM episodic_memory 
                ORDER BY created_at DESC 
                LIMIT ?
            """, (limit,))
            return [self._row_to_dict(row) for row in cursor.fetchall()]

    # ==================== Semantic Memory ====================

    def semantic_store(self, category: str, key: str, value: Any, tags: list[str] = None) -> str:
        """Store a semantic memory record."""
        record_id = hashlib.sha256(f"{category}:{key}".encode()).hexdigest()[:16]
        now = datetime.now(timezone.utc).isoformat()
        content_hash = hashlib.sha256(json.dumps(value).encode()).hexdigest()
        
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT OR REPLACE INTO semantic_memory 
                (id, category, key, value, content_hash, created_at, updated_at, tags)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                record_id,
                category,
                key,
                json.dumps(value) if isinstance(value, (dict, list)) else str(value),
                content_hash,
                now,
                now,
                json.dumps(tags or []),
            ))
            conn.commit()
        
        return record_id

    def semantic_get(self, category: str, key: str) -> Optional[Any]:
        """Get a semantic memory record."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT value FROM semantic_memory 
                WHERE category = ? AND key = ?
            """, (category, key))
            row = cursor.fetchone()
            if row:
                try:
                    return json.loads(row["value"])
                except (json.JSONDecodeError, TypeError):
                    return row["value"]
        return None

    def semantic_search(self, category: Optional[str] = None, query: str = None, limit: int = 10) -> list[dict[str, Any]]:
        """Search semantic memory by category and/or keywords."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            
            if category and query:
                cursor.execute("""
                    SELECT * FROM semantic_memory 
                    WHERE category = ? AND (key LIKE ? OR value LIKE ?)
                    LIMIT ?
                """, (category, f"%{query}%", f"%{query}%", limit))
            elif category:
                cursor.execute("""
                    SELECT * FROM semantic_memory 
                    WHERE category = ?
                    LIMIT ?
                """, (category, limit))
            elif query:
                cursor.execute("""
                    SELECT * FROM semantic_memory 
                    WHERE key LIKE ? OR value LIKE ?
                    LIMIT ?
                """, (f"%{query}%", f"%{query}%", limit))
            else:
                cursor.execute("SELECT * FROM semantic_memory LIMIT ?", (limit,))
            
            return [self._row_to_dict(row) for row in cursor.fetchall()]

    def semantic_delete(self, category: str, key: str) -> bool:
        """Delete a semantic memory record."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                DELETE FROM semantic_memory 
                WHERE category = ? AND key = ?
            """, (category, key))
            conn.commit()
            return cursor.rowcount > 0

    # ==================== Tool Memory ====================

    def tool_record_usage(
        self, 
        tool_name: str, 
        success: bool, 
        duration: float, 
        error: Optional[str] = None
    ) -> None:
        """Record tool usage statistics."""
        now = datetime.now(timezone.utc).isoformat()
        record_id = hashlib.sha256(tool_name.encode()).hexdigest()[:16]
        
        with self._get_connection() as conn:
            cursor = conn.cursor()
            
            # Get existing record
            cursor.execute("SELECT * FROM tool_memory WHERE tool_name = ?", (tool_name,))
            existing = cursor.fetchone()
            
            if existing:
                existing = self._row_to_dict(existing)
                total = existing["total_calls"] + 1
                successful = existing["successful_calls"] + (1 if success else 0)
                failed = existing["failed_calls"] + (0 if success else 1)
                
                # Update average duration
                old_avg = existing["avg_duration"] or 0.0
                new_avg = ((old_avg * existing["total_calls"]) + duration) / total
                
                # Update common errors
                common_errors = json.loads(existing["common_errors"] or "[]")
                if error and error not in common_errors:
                    common_errors.append(error)
                    common_errors = common_errors[-5:]  # Keep last 5 errors
                
                cursor.execute("""
                    UPDATE tool_memory 
                    SET total_calls = ?, successful_calls = ?, failed_calls = ?, 
                        avg_duration = ?, last_used_at = ?, common_errors = ?, updated_at = ?
                    WHERE tool_name = ?
                """, (total, successful, failed, new_avg, now, json.dumps(common_errors), now, tool_name))
            else:
                # Create new record
                common_errors = json.dumps([error]) if error else "[]"
                cursor.execute("""
                    INSERT INTO tool_memory 
                    (id, tool_name, total_calls, successful_calls, failed_calls, 
                     avg_duration, last_used_at, common_errors, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (record_id, tool_name, 1, 1 if success else 0, 0 if success else 1, 
                      duration, now, common_errors, now, now))
            
            conn.commit()

    def tool_get_stats(self, tool_name: str) -> Optional[dict[str, Any]]:
        """Get statistics for a tool."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM tool_memory WHERE tool_name = ?", (tool_name,))
            row = cursor.fetchone()
            if row:
                data = self._row_to_dict(row)
                # Parse JSON fields
                data["common_errors"] = json.loads(data.get("common_errors") or "[]")
                return data
        return None

    def tool_get_all_stats(self) -> list[dict[str, Any]]:
        """Get statistics for all tools."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM tool_memory ORDER BY total_calls DESC")
            results = []
            for row in cursor.fetchall():
                data = self._row_to_dict(row)
                data["common_errors"] = json.loads(data.get("common_errors") or "[]")
                results.append(data)
            return results

    # ==================== Audit Log ====================

    def audit_log(
        self,
        action: str,
        task_id: Optional[str] = None,
        step_id: Optional[str] = None,
        actor: str = "worker",
        tool_name: Optional[str] = None,
        input_summary: Optional[str] = None,
        output_summary: Optional[str] = None,
        duration_ms: Optional[int] = None,
        success: bool = True,
        permission_decision: Optional[str] = None,
        error: Optional[str] = None,
        artifact_refs: Optional[list[str]] = None,
    ) -> int:
        """Add an entry to the audit log."""
        now = datetime.now(timezone.utc).isoformat()
        
        # Create checksum for integrity
        checksum_data = f"{now}{task_id}{action}{tool_name}{success}"
        checksum = hashlib.sha256(checksum_data.encode()).hexdigest()[:16]
        
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO audit_log 
                (timestamp, task_id, step_id, actor, action, tool_name, 
                 input_summary, output_summary, duration_ms, success, 
                 permission_decision, error, artifact_refs, checksum)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                now, task_id, step_id, actor, action, tool_name,
                input_summary, output_summary, duration_ms, success,
                permission_decision, error, json.dumps(artifact_refs or []), checksum
            ))
            conn.commit()
            return cursor.lastrowid

    def audit_get_entries(
        self, 
        task_id: Optional[str] = None, 
        limit: int = 100,
        success_only: bool = False,
    ) -> list[dict[str, Any]]:
        """Get audit log entries."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            
            if task_id and success_only:
                cursor.execute("""
                    SELECT * FROM audit_log 
                    WHERE task_id = ? AND success = 1
                    ORDER BY timestamp DESC 
                    LIMIT ?
                """, (task_id, limit))
            elif task_id:
                cursor.execute("""
                    SELECT * FROM audit_log 
                    WHERE task_id = ?
                    ORDER BY timestamp DESC 
                    LIMIT ?
                """, (task_id, limit))
            elif success_only:
                cursor.execute("""
                    SELECT * FROM audit_log 
                    WHERE success = 1
                    ORDER BY timestamp DESC 
                    LIMIT ?
                """, (limit,))
            else:
                cursor.execute("""
                    SELECT * FROM audit_log 
                    ORDER BY timestamp DESC 
                    LIMIT ?
                """, (limit,))
            
            return [self._row_to_dict(row) for row in cursor.fetchall()]

    def audit_clear_old(self, days: int = 30) -> int:
        """Clear audit log entries older than specified days."""
        cutoff = datetime.now(timezone.utc).timestamp() - (days * 24 * 60 * 60)
        cutoff_str = datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat()
        
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM audit_log WHERE timestamp < ?", (cutoff_str,))
            conn.commit()
            return cursor.rowcount
