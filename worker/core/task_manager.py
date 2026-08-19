"""
Task Manager for WORKER.

Manages task lifecycle:
- Create tasks
- Track state transitions
- Persist/restore tasks
- Handle cancellation and pausing
"""

import asyncio
from typing import Any, Dict, List, Optional
from datetime import datetime, timezone
import json
import uuid
from pathlib import Path

from worker.core.models import Task, TaskState, Artifact
from worker.core.events import event_bus, EventType, create_task_event


class TaskManager:
    """
    Manages task lifecycle and persistence.
    
    Responsibilities:
    - Create and initialize tasks
    - Track state transitions
    - Persist task state to disk
    - Restore tasks after restart
    - Handle cancellation and pausing
    """
    
    def __init__(self, storage_path: str = "worker/storage/workspaces"):
        self.storage_path = Path(storage_path)
        self._tasks: Dict[str, Task] = {}
        self._ensure_storage_dirs()
    
    def _ensure_storage_dirs(self):
        """Create storage directories if they don't exist."""
        self.storage_path.mkdir(parents=True, exist_ok=True)
        (self.storage_path / "logs").mkdir(exist_ok=True)
        (self.storage_path / "artifacts").mkdir(exist_ok=True)
    
    async def create_task(
        self,
        user_request: str,
        objective: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None
    ) -> Task:
        """
        Create a new task.
        
        Args:
            user_request: Original user request text
            objective: Parsed objective (defaults to user_request)
            context: Additional context data
        
        Returns:
            New Task instance
        """
        task = Task(
            user_request=user_request,
            objective=objective or user_request,
            memory_context=context or {}
        )
        
        self._tasks[task.task_id] = task
        
        # Persist initial state
        await self._persist_task(task)
        
        # Emit event
        await event_bus.publish(create_task_event(
            event_type=EventType.TASK_CREATED,
            task_id=task.task_id,
            user_request=user_request,
            state=TaskState.CREATED.value,
            source="task_manager"
        ))
        
        return task
    
    def get_task(self, task_id: str) -> Optional[Task]:
        """Get a task by ID."""
        return self._tasks.get(task_id)
    
    def list_tasks(self, limit: int = 100) -> List[Task]:
        """List all tasks, most recent first."""
        tasks = sorted(
            self._tasks.values(),
            key=lambda t: t.created_at,
            reverse=True
        )
        return tasks[:limit]
    
    async def update_state(self, task: Task, new_state: TaskState) -> bool:
        """
        Update task state with validation.
        
        Returns True if transition is valid and successful.
        """
        # Validate state transition
        if not self._is_valid_transition(task.current_state, new_state):
            return False
        
        old_state = task.current_state
        task.current_state = new_state
        task.updated_at = datetime.now(timezone.utc)
        
        if new_state == TaskState.COMPLETED:
            task.completed_at = datetime.now(timezone.utc)
        
        # Persist updated state
        await self._persist_task(task)
        
        # Emit event
        await event_bus.publish(create_task_event(
            event_type=EventType.TASK_STATE_CHANGED,
            task_id=task.task_id,
            user_request=task.user_request,
            state=new_state.value,
            previous_state=old_state.value,
            source="task_manager"
        ))
        
        return True
    
    def _is_valid_transition(self, from_state: TaskState, to_state: TaskState) -> bool:
        """Check if state transition is valid."""
        valid_transitions = {
            TaskState.CREATED: [TaskState.ANALYZING, TaskState.CANCELLED],
            TaskState.ANALYZING: [TaskState.PLANNING, TaskState.FAILED, TaskState.CANCELLED],
            TaskState.PLANNING: [TaskState.EXECUTING, TaskState.FAILED, TaskState.CANCELLED],
            TaskState.EXECUTING: [TaskState.OBSERVING, TaskState.VERIFYING, TaskState.FAILED, TaskState.BLOCKED, TaskState.CANCELLED],
            TaskState.OBSERVING: [TaskState.EXECUTING, TaskState.VERIFYING, TaskState.FAILED, TaskState.CANCELLED],
            TaskState.VERIFYING: [TaskState.EXECUTING, TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED],
            TaskState.WAITING_FOR_PERMISSION: [TaskState.EXECUTING, TaskState.CANCELLED],
            TaskState.WAITING_FOR_USER: [TaskState.EXECUTING, TaskState.CANCELLED],
            TaskState.RETRYING: [TaskState.EXECUTING, TaskState.FAILED, TaskState.CANCELLED],
            TaskState.BLOCKED: [TaskState.EXECUTING, TaskState.CANCELLED, TaskState.FAILED],
            TaskState.COMPLETED: [],  # Terminal state
            TaskState.FAILED: [],  # Terminal state
            TaskState.CANCELLED: [],  # Terminal state
        }
        
        allowed = valid_transitions.get(from_state, [])
        return to_state in allowed
    
    async def cancel_task(self, task_id: str, reason: str = "") -> bool:
        """Cancel a running task."""
        task = self.get_task(task_id)
        if not task:
            return False
        
        if task.current_state in [TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED]:
            return False  # Already terminal
        
        task.cancelled = True
        task.errors.append(f"Cancelled: {reason}" if reason else "Cancelled")
        
        await self.update_state(task, TaskState.CANCELLED)
        
        return True
    
    async def pause_task(self, task_id: str) -> bool:
        """Pause a running task."""
        task = self.get_task(task_id)
        if not task:
            return False
        
        if task.current_state not in [TaskState.EXECUTING, TaskState.OBSERVING]:
            return False  # Can only pause during execution
        
        task.paused = True
        task.current_state = TaskState.WAITING_FOR_USER
        task.updated_at = datetime.now(timezone.utc)
        
        await self._persist_task(task)
        
        await event_bus.publish(create_task_event(
            event_type=EventType.AGENT_PAUSED,
            task_id=task_id,
            user_request=task.user_request,
            state=TaskState.WAITING_FOR_USER.value,
            source="task_manager"
        ))
        
        return True
    
    async def resume_task(self, task_id: str) -> bool:
        """Resume a paused task."""
        task = self.get_task(task_id)
        if not task:
            return False
        
        if task.current_state != TaskState.WAITING_FOR_USER:
            return False  # Can only resume waiting tasks
        
        task.paused = False
        task.current_state = TaskState.EXECUTING
        task.updated_at = datetime.now(timezone.utc)
        
        await self._persist_task(task)
        
        await event_bus.publish(create_task_event(
            event_type=EventType.AGENT_RESUMED,
            task_id=task_id,
            user_request=task.user_request,
            state=TaskState.EXECUTING.value,
            source="task_manager"
        ))
        
        return True
    
    async def add_artifact(self, task_id: str, artifact: Artifact) -> bool:
        """Add an artifact to a task."""
        task = self.get_task(task_id)
        if not task:
            return False
        
        task.artifacts.append(artifact)
        task.updated_at = datetime.now(timezone.utc)
        
        await self._persist_task(task)
        return True
    
    async def add_error(self, task_id: str, error: str) -> bool:
        """Add an error to a task."""
        task = self.get_task(task_id)
        if not task:
            return False
        
        task.errors.append(error)
        task.updated_at = datetime.now(timezone.utc)
        
        await self._persist_task(task)
        return True
    
    async def _persist_task(self, task: Task):
        """Persist task state to disk."""
        task_dir = self.storage_path / f"task_{task.task_id}"
        task_dir.mkdir(exist_ok=True)
        
        # Save state as JSON
        state_file = task_dir / "state.json"
        state_data = task.model_dump(mode='json')
        
        with open(state_file, 'w') as f:
            json.dump(state_data, f, indent=2, default=str)
    
    async def load_task(self, task_id: str) -> Optional[Task]:
        """Load a task from disk."""
        task_dir = self.storage_path / f"task_{task_id}"
        state_file = task_dir / "state.json"
        
        if not state_file.exists():
            return None
        
        with open(state_file, 'r') as f:
            state_data = json.load(f)
        
        # Reconstruct task from dict
        task = Task.model_validate(state_data)
        self._tasks[task_id] = task
        
        return task
    
    async def load_all_tasks(self) -> List[Task]:
        """Load all persisted tasks."""
        tasks = []
        for task_dir in self.storage_path.glob("task_*"):
            task_id = task_dir.name.replace("task_", "")
            task = await self.load_task(task_id)
            if task:
                tasks.append(task)
        return tasks
    
    def get_workspace_path(self, task_id: str) -> Path:
        """Get workspace directory path for a task."""
        workspace_dir = self.storage_path / f"task_{task_id}"
        workspace_dir.mkdir(exist_ok=True)
        return workspace_dir


# Global task manager instance
task_manager = TaskManager()
