"""
Working Memory - Short-term ephemeral memory for current task context.

Provides fast in-memory storage for:
- Current task state and plan
- Active processes and open files
- Recent observations buffer
- Temporary computation results

Cleared automatically when task completes.
"""

from typing import Any, Optional
from datetime import datetime, timezone


class WorkingMemory:
    """
    Working memory manager for active task context.
    
    Thread-safe, supports multiple concurrent tasks.
    Automatically cleans up old entries based on TTL.
    """

    def __init__(self, ttl_seconds: int = 3600):
        """
        Initialize working memory.
        
        Args:
            ttl_seconds: Time-to-live for task contexts (default 1 hour)
        """
        self._contexts: dict[str, dict[str, Any]] = {}
        self._timestamps: dict[str, float] = {}
        self._ttl_seconds = ttl_seconds

    def set_context(self, task_id: str, key: str, value: Any) -> None:
        """
        Set a value in the working memory context for a task.
        
        Args:
            task_id: Unique task identifier
            key: Key to store value under
            value: Value to store (must be JSON serializable)
        """
        if task_id not in self._contexts:
            self._contexts[task_id] = {}
            self._timestamps[task_id] = datetime.now(timezone.utc).timestamp()
        
        self._contexts[task_id][key] = value

    def get_context(self, task_id: str, key: str, default: Any = None) -> Any:
        """
        Get a value from working memory context.
        
        Args:
            task_id: Unique task identifier
            key: Key to retrieve
            default: Default value if key not found
            
        Returns:
            Stored value or default
        """
        self._check_ttl(task_id)
        
        if task_id not in self._contexts:
            return default
        
        return self._contexts[task_id].get(key, default)

    def get_all_context(self, task_id: str) -> dict[str, Any]:
        """
        Get all context values for a task.
        
        Args:
            task_id: Unique task identifier
            
        Returns:
            Dictionary of all context values
        """
        self._check_ttl(task_id)
        
        if task_id not in self._contexts:
            return {}
        
        return self._contexts[task_id].copy()

    def update_context(self, task_id: str, updates: dict[str, Any]) -> None:
        """
        Update multiple context values at once.
        
        Args:
            task_id: Unique task identifier
            updates: Dictionary of key-value pairs to update
        """
        if task_id not in self._contexts:
            self._contexts[task_id] = {}
            self._timestamps[task_id] = datetime.now(timezone.utc).timestamp()
        
        self._contexts[task_id].update(updates)

    def delete_context(self, task_id: str, key: str) -> bool:
        """
        Delete a specific key from task context.
        
        Args:
            task_id: Unique task identifier
            key: Key to delete
            
        Returns:
            True if key was deleted, False if not found
        """
        self._check_ttl(task_id)
        
        if task_id not in self._contexts:
            return False
        
        if key in self._contexts[task_id]:
            del self._contexts[task_id][key]
            return True
        
        return False

    def clear_task(self, task_id: str) -> None:
        """
        Clear all context for a specific task.
        
        Args:
            task_id: Unique task identifier
        """
        if task_id in self._contexts:
            del self._contexts[task_id]
        if task_id in self._timestamps:
            del self._timestamps[task_id]

    def clear_all(self) -> None:
        """Clear all working memory contexts."""
        self._contexts.clear()
        self._timestamps.clear()

    def _check_ttl(self, task_id: str) -> None:
        """
        Check if task context has expired based on TTL.
        
        Args:
            task_id: Unique task identifier
        """
        if task_id in self._timestamps:
            age = datetime.now(timezone.utc).timestamp() - self._timestamps[task_id]
            if age > self._ttl_seconds:
                self.clear_task(task_id)

    def cleanup_expired(self) -> int:
        """
        Clean up all expired task contexts.
        
        Returns:
            Number of contexts cleaned up
        """
        now = datetime.now(timezone.utc).timestamp()
        expired = [
            task_id for task_id, ts in self._timestamps.items()
            if (now - ts) > self._ttl_seconds
        ]
        
        for task_id in expired:
            self.clear_task(task_id)
        
        return len(expired)

    def get_active_tasks(self) -> list[str]:
        """
        Get list of currently active task IDs.
        
        Returns:
            List of task IDs with valid contexts
        """
        self.cleanup_expired()
        return list(self._contexts.keys())

    def set_observation_buffer(
        self, 
        task_id: str, 
        observation: dict[str, Any], 
        max_size: int = 10
    ) -> None:
        """
        Add observation to rolling buffer for a task.
        
        Args:
            task_id: Unique task identifier
            observation: Observation data to store
            max_size: Maximum buffer size (default 10)
        """
        buffer_key = "_observation_buffer"
        buffer = self.get_context(task_id, buffer_key, [])
        
        buffer.append(observation)
        
        # Keep only last N observations
        if len(buffer) > max_size:
            buffer = buffer[-max_size:]
        
        self.set_context(task_id, buffer_key, buffer)

    def get_observation_buffer(self, task_id: str) -> list[dict[str, Any]]:
        """
        Get observation buffer for a task.
        
        Args:
            task_id: Unique task identifier
            
        Returns:
            List of recent observations
        """
        return self.get_context(task_id, "_observation_buffer", [])

    def set_active_processes(self, task_id: str, processes: list[dict[str, Any]]) -> None:
        """
        Track active processes for a task.
        
        Args:
            task_id: Unique task identifier
            processes: List of process information dicts
        """
        self.set_context(task_id, "_active_processes", processes)

    def get_active_processes(self, task_id: str) -> list[dict[str, Any]]:
        """
        Get active processes for a task.
        
        Args:
            task_id: Unique task identifier
            
        Returns:
            List of process information dicts
        """
        return self.get_context(task_id, "_active_processes", [])

    def add_active_process(self, task_id: str, process_info: dict[str, Any]) -> None:
        """
        Add a process to the active processes list.
        
        Args:
            task_id: Unique task identifier
            process_info: Process information dict
        """
        processes = self.get_active_processes(task_id)
        processes.append(process_info)
        self.set_active_processes(task_id, processes)

    def remove_active_process(self, task_id: str, pid: int) -> bool:
        """
        Remove a process from active processes list.
        
        Args:
            task_id: Unique task identifier
            pid: Process ID to remove
            
        Returns:
            True if process was removed, False if not found
        """
        processes = self.get_active_processes(task_id)
        original_len = len(processes)
        
        processes = [p for p in processes if p.get("pid") != pid]
        
        if len(processes) < original_len:
            self.set_active_processes(task_id, processes)
            return True
        
        return False

    def set_open_files(self, task_id: str, files: list[str]) -> None:
        """
        Track open files for a task.
        
        Args:
            task_id: Unique task identifier
            files: List of file paths
        """
        self.set_context(task_id, "_open_files", files)

    def get_open_files(self, task_id: str) -> list[str]:
        """
        Get open files for a task.
        
        Args:
            task_id: Unique task identifier
            
        Returns:
            List of file paths
        """
        return self.get_context(task_id, "_open_files", [])

    def add_open_file(self, task_id: str, file_path: str) -> None:
        """
        Add a file to the open files list.
        
        Args:
            task_id: Unique task identifier
            file_path: File path to add
        """
        files = self.get_open_files(task_id)
        if file_path not in files:
            files.append(file_path)
            self.set_open_files(task_id, files)

    def remove_open_file(self, task_id: str, file_path: str) -> bool:
        """
        Remove a file from open files list.
        
        Args:
            task_id: Unique task identifier
            file_path: File path to remove
            
        Returns:
            True if file was removed, False if not found
        """
        files = self.get_open_files(task_id)
        
        if file_path in files:
            files.remove(file_path)
            self.set_open_files(task_id, files)
            return True
        
        return False
