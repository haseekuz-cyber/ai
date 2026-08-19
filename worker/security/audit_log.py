"""Audit logging for tracking all Worker actions."""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, Any
import json
import hashlib
import os
from pathlib import Path


@dataclass
class AuditRecord:
    """Single audit log entry."""
    record_id: str
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    task_id: Optional[str] = None
    step_id: Optional[str] = None
    actor: str = ""  # "agent", "user", "system"
    tool_name: Optional[str] = None
    action: Optional[str] = None
    input_summary: Optional[str] = None
    output_summary: Optional[str] = None
    duration_ms: Optional[float] = None
    success: bool = True
    error: Optional[str] = None
    permission_request_id: Optional[str] = None
    permission_decision: Optional[str] = None  # "auto", "user", "policy"
    risk_level: Optional[str] = None
    artifact_refs: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> dict:
        """Convert to dictionary for serialization."""
        return {
            "record_id": self.record_id,
            "timestamp": self.timestamp.isoformat(),
            "task_id": self.task_id,
            "step_id": self.step_id,
            "actor": self.actor,
            "tool_name": self.tool_name,
            "action": self.action,
            "input_summary": self.input_summary,
            "output_summary": self.output_summary,
            "duration_ms": self.duration_ms,
            "success": self.success,
            "error": self.error,
            "permission_request_id": self.permission_request_id,
            "permission_decision": self.permission_decision,
            "risk_level": self.risk_level,
            "artifact_refs": self.artifact_refs,
            "metadata": self.metadata
        }
    
    def to_json(self) -> str:
        """Convert to JSON string."""
        return json.dumps(self.to_dict(), default=str)
    
    def compute_hash(self) -> str:
        """Compute hash of the record for integrity verification."""
        data = self.to_json()
        return hashlib.sha256(data.encode()).hexdigest()


class AuditLogger:
    """
    Audit logger for tracking all Worker actions.
    
    Implements TZ section 21 (Audit Log) requirements:
    - Append-only logging
    - Hash verification for integrity
    - Structured records with all required fields
    - File-based storage for persistence
    """
    
    def __init__(self, log_dir: str = "worker/storage/audit_logs"):
        self._log_dir = Path(log_dir)
        self._log_dir.mkdir(parents=True, exist_ok=True)
        self._current_log_file: Optional[Path] = None
        self._buffer: list[AuditRecord] = []
        self._buffer_size = 100  # Flush after N records
        self._previous_hash: Optional[str] = None
        self._initialize_log_file()
    
    def _initialize_log_file(self) -> None:
        """Initialize or rotate the log file."""
        date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
        self._current_log_file = self._log_dir / f"audit_{date_str}.jsonl"
        
        # If file exists, read last hash for chain verification
        if self._current_log_file.exists():
            with open(self._current_log_file, 'r', encoding='utf-8') as f:
                lines = f.readlines()
                if lines:
                    try:
                        last_record = json.loads(lines[-1])
                        self._previous_hash = last_record.get("previous_hash")
                    except (json.JSONDecodeError, KeyError):
                        self._previous_hash = None
    
    def _get_current_log_file(self) -> Path:
        """Get current log file path, rotating if necessary."""
        date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
        expected_file = self._log_dir / f"audit_{date_str}.jsonl"
        
        if self._current_log_file != expected_file:
            self._current_log_file = expected_file
            self._previous_hash = None
        
        return self._current_log_file
    
    def log(
        self,
        task_id: Optional[str] = None,
        step_id: Optional[str] = None,
        actor: str = "agent",
        tool_name: Optional[str] = None,
        action: Optional[str] = None,
        input_summary: Optional[str] = None,
        output_summary: Optional[str] = None,
        duration_ms: Optional[float] = None,
        success: bool = True,
        error: Optional[str] = None,
        permission_request_id: Optional[str] = None,
        permission_decision: Optional[str] = None,
        risk_level: Optional[str] = None,
        artifact_refs: Optional[list[str]] = None,
        metadata: Optional[dict[str, Any]] = None
    ) -> AuditRecord:
        """
        Log an action to the audit trail.
        
        Args:
            task_id: ID of the task
            step_id: ID of the step within the task
            actor: Who performed the action ("agent", "user", "system")
            tool_name: Name of the tool used
            action: Specific action performed
            input_summary: Brief summary of inputs (redacted)
            output_summary: Brief summary of outputs
            duration_ms: Duration in milliseconds
            success: Whether the action succeeded
            error: Error message if failed
            permission_request_id: ID of associated permission request
            permission_decision: How permission was decided
            risk_level: Risk level of the action
            artifact_refs: References to generated artifacts
            metadata: Additional metadata
        
        Returns:
            The created AuditRecord
        """
        import uuid
        
        record = AuditRecord(
            record_id=str(uuid.uuid4()),
            task_id=task_id,
            step_id=step_id,
            actor=actor,
            tool_name=tool_name,
            action=action,
            input_summary=input_summary,
            output_summary=output_summary,
            duration_ms=duration_ms,
            success=success,
            error=error,
            permission_request_id=permission_request_id,
            permission_decision=permission_decision,
            risk_level=risk_level,
            artifact_refs=artifact_refs or [],
            metadata=metadata or {}
        )
        
        self._buffer.append(record)
        
        # Flush if buffer is full
        if len(self._buffer) >= self._buffer_size:
            self._flush()
        
        return record
    
    def _flush(self) -> None:
        """Flush buffered records to disk."""
        if not self._buffer:
            return
        
        log_file = self._get_current_log_file()
        
        with open(log_file, 'a', encoding='utf-8') as f:
            for record in self._buffer:
                record_dict = record.to_dict()
                record_dict["previous_hash"] = self._previous_hash
                record_dict["hash"] = record.compute_hash()
                
                # Compute new hash including previous hash for chain
                chain_data = json.dumps(record_dict)
                self._previous_hash = hashlib.sha256(chain_data.encode()).hexdigest()
                record_dict["chain_hash"] = self._previous_hash
                
                f.write(json.dumps(record_dict, default=str) + "\n")
        
        self._buffer.clear()
    
    def flush(self) -> None:
        """Public method to flush buffered records."""
        self._flush()
    
    def query(
        self,
        task_id: Optional[str] = None,
        tool_name: Optional[str] = None,
        actor: Optional[str] = None,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        success_only: bool = False,
        limit: int = 1000
    ) -> list[AuditRecord]:
        """
        Query audit logs with filters.
        
        Args:
            task_id: Filter by task ID
            tool_name: Filter by tool name
            actor: Filter by actor
            start_time: Start of time range
            end_time: End of time range
            success_only: Only return successful actions
            limit: Maximum number of records to return
        
        Returns:
            List of matching AuditRecord objects
        """
        results: list[AuditRecord] = []
        
        # Find relevant log files
        log_files = sorted(self._log_dir.glob("audit_*.jsonl"))
        
        for log_file in log_files:
            if len(results) >= limit:
                break
            
            with open(log_file, 'r', encoding='utf-8') as f:
                for line in f:
                    if len(results) >= limit:
                        break
                    
                    try:
                        data = json.loads(line.strip())
                        
                        # Apply filters
                        if task_id and data.get("task_id") != task_id:
                            continue
                        if tool_name and data.get("tool_name") != tool_name:
                            continue
                        if actor and data.get("actor") != actor:
                            continue
                        
                        timestamp = datetime.fromisoformat(data["timestamp"])
                        if start_time and timestamp < start_time:
                            continue
                        if end_time and timestamp > end_time:
                            continue
                        
                        if success_only and not data.get("success", True):
                            continue
                        
                        # Convert back to AuditRecord
                        record = AuditRecord(
                            record_id=data["record_id"],
                            timestamp=timestamp,
                            task_id=data.get("task_id"),
                            step_id=data.get("step_id"),
                            actor=data.get("actor", ""),
                            tool_name=data.get("tool_name"),
                            action=data.get("action"),
                            input_summary=data.get("input_summary"),
                            output_summary=data.get("output_summary"),
                            duration_ms=data.get("duration_ms"),
                            success=data.get("success", True),
                            error=data.get("error"),
                            permission_request_id=data.get("permission_request_id"),
                            permission_decision=data.get("permission_decision"),
                            risk_level=data.get("risk_level"),
                            artifact_refs=data.get("artifact_refs", []),
                            metadata=data.get("metadata", {})
                        )
                        results.append(record)
                    
                    except (json.JSONDecodeError, KeyError, ValueError):
                        continue
        
        return results
    
    def verify_integrity(self, log_file_path: Optional[Path] = None) -> tuple[bool, list[str]]:
        """
        Verify the integrity of audit logs using hash chain.
        
        Args:
            log_file_path: Path to specific log file, or None for latest
        
        Returns:
            Tuple of (is_valid, list_of_errors)
        """
        errors: list[str] = []
        
        if log_file_path is None:
            log_files = sorted(self._log_dir.glob("audit_*.jsonl"))
            if not log_files:
                return True, []
            log_file_path = log_files[-1]
        
        previous_hash: Optional[str] = None
        
        with open(log_file_path, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                try:
                    data = json.loads(line.strip())
                    
                    # Verify record hash
                    stored_hash = data.get("hash")
                    record_data = {k: v for k, v in data.items() if k not in ("hash", "chain_hash")}
                    computed_hash = hashlib.sha256(
                        json.dumps(record_data, default=str).encode()
                    ).hexdigest()
                    
                    if stored_hash != computed_hash:
                        errors.append(f"Line {line_num}: Record hash mismatch")
                    
                    # Verify chain hash
                    stored_chain = data.get("chain_hash")
                    chain_data = json.dumps(data, default=str)
                    computed_chain = hashlib.sha256(chain_data.encode()).hexdigest()
                    
                    if stored_chain != computed_chain:
                        errors.append(f"Line {line_num}: Chain hash mismatch")
                    
                    previous_hash = computed_chain
                
                except (json.JSONDecodeError, KeyError) as e:
                    errors.append(f"Line {line_num}: Parse error - {str(e)}")
        
        return len(errors) == 0, errors
    
    def get_statistics(
        self,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None
    ) -> dict[str, Any]:
        """
        Get statistics about audit logs.
        
        Returns:
            Dictionary with statistics
        """
        records = self.query(start_time=start_time, end_time=end_time, limit=100000)
        
        stats = {
            "total_records": len(records),
            "successful_actions": sum(1 for r in records if r.success),
            "failed_actions": sum(1 for r in records if not r.success),
            "unique_tasks": len(set(r.task_id for r in records if r.task_id)),
            "tools_used": {},
            "actors": {},
            "risk_levels": {}
        }
        
        for record in records:
            if record.tool_name:
                stats["tools_used"][record.tool_name] = stats["tools_used"].get(record.tool_name, 0) + 1
            if record.actor:
                stats["actors"][record.actor] = stats["actors"].get(record.actor, 0) + 1
            if record.risk_level:
                stats["risk_levels"][record.risk_level] = stats["risk_levels"].get(record.risk_level, 0) + 1
        
        return stats
