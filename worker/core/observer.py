"""
Observer module for WORKER.

Captures observations after actions:
- What changed
- Current state
- Errors and warnings
- Confidence level
"""

from typing import Any, Dict, List, Optional
from datetime import datetime
import uuid

from worker.core.models import (
    Task, TaskState, Step, ToolCall, Observation
)
from worker.core.events import event_bus, EventType


class Observer:
    """
    Observes and records results of actions.
    
    Responsibilities:
    - Capture state changes
    - Identify errors and warnings
    - Calculate confidence
    - Create observation records
    """
    
    def __init__(self):
        self._observations: Dict[str, List[Observation]] = {}
    
    async def observe(
        self,
        task: Task,
        step: Step,
        tool_result: Any
    ) -> Observation:
        """
        Create an observation from a tool execution result.
        
        Analyzes what changed and captures the state.
        """
        observation_id = str(uuid.uuid4())
        
        # Extract information from tool result
        what_changed = await self._describe_change(step, tool_result)
        visible_state = await self._get_visible_state(tool_result)
        process_state = await self._get_process_state(tool_result)
        errors = self._extract_errors(tool_result)
        warnings = self._extract_warnings(tool_result)
        confidence = self._calculate_confidence(tool_result, errors, warnings)
        
        observation = Observation(
            observation_id=observation_id,
            task_id=task.task_id,
            step_id=step.step_id,
            tool_call_id=None,  # Will be set by caller if needed
            what_changed=what_changed,
            visible_state=visible_state,
            process_state=process_state,
            errors=errors,
            warnings=warnings,
            confidence=confidence,
            raw_output=tool_result.data if hasattr(tool_result, 'data') else None
        )
        
        # Store observation
        if task.task_id not in self._observations:
            self._observations[task.task_id] = []
        self._observations[task.task_id].append(observation)
        
        # Add to task's observations list
        task.observations.append(observation)
        
        # Emit event
        from worker.core.events import EventType, DataEvent
        await event_bus.publish(DataEvent[Dict](
            event_type=EventType.OBSERVATION_CREATED,
            data={
                "task_id": task.task_id,
                "observation_id": observation_id,
                "what_changed": what_changed,
                "has_errors": len(errors) > 0
            }
        ))
        
        return observation
    
    async def _describe_change(self, step: Step, tool_result: Any) -> str:
        """Describe what changed as a result of the action."""
        if not tool_result.success:
            return f"Action failed: {tool_result.error}"
        
        action = step.action
        params = step.parameters
        
        if action == "files.read":
            path = params.get("path", "unknown")
            content_len = len(tool_result.data.get("content", "")) if tool_result.data else 0
            return f"Read {content_len} bytes from {path}"
        
        elif action == "files.write":
            path = params.get("path", "unknown")
            return f"Wrote file at {path}"
        
        elif action == "files.list":
            path = params.get("path", ".")
            count = tool_result.data.get("count", 0) if tool_result.data else 0
            return f"Listed {count} items in {path}"
        
        elif action == "terminal.run":
            cmd = params.get("command", "unknown")
            return_code = tool_result.data.get("return_code", -1) if tool_result.data else -1
            return f"Executed '{cmd}' with exit code {return_code}"
        
        elif action == "system.process_list":
            count = tool_result.data.get("count", 0) if tool_result.data else 0
            return f"Found {count} running processes"
        
        elif action == "system.info":
            os_name = tool_result.data.get("os", "unknown") if tool_result.data else "unknown"
            return f"Retrieved system info: {os_name}"
        
        else:
            return f"Executed {action}"
    
    async def _get_visible_state(self, tool_result: Any) -> Optional[str]:
        """Get human-readable description of current visible state."""
        if not tool_result.success:
            return None
        
        data = tool_result.data
        if not data:
            return None
        
        # Try to extract meaningful state
        if "stdout" in tool_result.__dict__ and tool_result.stdout:
            return tool_result.stdout[:500]  # First 500 chars
        
        return str(data)[:200]  # Fallback
    
    async def _get_process_state(self, tool_result: Any) -> Optional[Dict[str, Any]]:
        """Extract process-related state."""
        if not tool_result.data:
            return None
        
        data = tool_result.data
        
        # Check for process-related info
        if "return_code" in data or "exit_code" in data:
            return {
                "return_code": data.get("return_code") or data.get("exit_code"),
                "has_output": bool(data.get("stdout")) or bool(data.get("stderr")),
                "duration_ms": data.get("duration_ms")
            }
        
        if "processes" in data:
            return {
                "process_count": len(data.get("processes", [])),
                "type": "process_list"
            }
        
        return None
    
    def _extract_errors(self, tool_result: Any) -> List[str]:
        """Extract error messages from result."""
        errors = []
        
        if tool_result.error:
            errors.append(tool_result.error)
        
        if tool_result.stderr:
            # Only include non-empty stderr
            stderr_stripped = tool_result.stderr.strip()
            if stderr_stripped:
                errors.append(f"stderr: {stderr_stripped[:200]}")
        
        return errors
    
    def _extract_warnings(self, tool_result: Any) -> List[str]:
        """Extract warning messages from result."""
        warnings = []
        
        # Check metadata for warnings
        if hasattr(tool_result, 'metadata') and tool_result.metadata:
            if 'warning' in tool_result.metadata:
                warnings.append(str(tool_result.metadata['warning']))
            if 'warnings' in tool_result.metadata:
                warnings.extend([str(w) for w in tool_result.metadata['warnings']])
        
        return warnings
    
    def _calculate_confidence(
        self,
        tool_result: Any,
        errors: List[str],
        warnings: List[str]
    ) -> float:
        """
        Calculate confidence score for the observation.
        
        Returns value between 0.0 and 1.0.
        """
        if not tool_result.success:
            return 0.2
        
        confidence = 1.0
        
        # Reduce confidence for errors
        confidence -= len(errors) * 0.3
        
        # Reduce confidence for warnings
        confidence -= len(warnings) * 0.1
        
        # Ensure bounds
        return max(0.0, min(1.0, confidence))
    
    def get_observations(self, task_id: str) -> List[Observation]:
        """Get all observations for a task."""
        return self._observations.get(task_id, [])
    
    def get_last_observation(self, task_id: str) -> Optional[Observation]:
        """Get the most recent observation for a task."""
        observations = self.get_observations(task_id)
        return observations[-1] if observations else None
    
    def clear_observations(self, task_id: str):
        """Clear observations for a task."""
        self._observations.pop(task_id, None)


# Global observer instance
observer = Observer()


# Singleton getter
def get_observer() -> Observer:
    """Get the global observer instance."""
    return observer
