"""
Executor module for WORKER.

Executes tools with:
- Permission validation
- Timeout handling
- Result capture
- Error propagation
"""

import asyncio
from typing import Any, Dict, List, Optional
from datetime import datetime, timezone

from worker.core.models import (
    Task, TaskState, Step, StepStatus, Plan,
    ToolCall, Observation, RiskLevel
)
from worker.core.events import (
    event_bus, EventType, create_tool_event,
    create_permission_event
)
from worker.core.tools import tool_registry, ToolResult


class Executor:
    """
    Executes tools on behalf of the agent.
    
    Responsibilities:
    - Validate tool availability
    - Check permissions
    - Execute with timeout
    - Capture results
    - Handle errors
    """
    
    def __init__(self, default_timeout: int = 60):
        self.default_timeout = default_timeout
        self._pending_permissions: Dict[str, bool] = {}
    
    async def execute_step(
        self,
        task: Task,
        step: Step
    ) -> ToolResult:
        """
        Execute a step's action.
        
        Returns ToolResult with success status and data.
        """
        tool_name = step.action
        
        # Skip special actions
        if tool_name.startswith("__"):
            return ToolResult(
                success=True,
                data={"special_action": tool_name},
                metadata={"note": "Special action handled by agent loop"}
            )
        
        # Get tool from registry
        tool = tool_registry.get(tool_name)
        if not tool:
            return ToolResult(
                success=False,
                error=f"Tool not found: {tool_name}"
            )
        
        # Check if tool is enabled
        if not tool.enabled:
            return ToolResult(
                success=False,
                error=f"Tool disabled: {tool_name}"
            )
        
        # Check permissions
        permission_granted = await self._check_permission(task, tool_name, step.parameters)
        if not permission_granted:
            return ToolResult(
                success=False,
                error=f"Permission denied for tool: {tool_name}"
            )
        
        # Validate input
        if not tool.validate_input(**step.parameters):
            return ToolResult(
                success=False,
                error=f"Invalid input for tool: {tool_name}"
            )
        
        # Create tool call record
        tool_call = ToolCall(
            task_id=task.task_id,
            tool_name=tool_name,
            step_id=step.step_id,
            input_data=step.parameters
        )
        
        # Emit tool started event
        await event_bus.publish(create_tool_event(
            event_type=EventType.TOOL_STARTED,
            task_id=task.task_id,
            tool_name=tool_name,
            call_id=tool_call.call_id,
            step_id=step.step_id
        ))
        
        # Execute tool with timeout
        timeout = step.parameters.get("timeout", tool.timeout or self.default_timeout)
        
        try:
            result = await asyncio.wait_for(
                tool.execute(**step.parameters),
                timeout=timeout
            )
            
            # Update tool call with result
            tool_call.completed_at = datetime.now(timezone.utc)
            tool_call.success = result.success
            tool_call.data = result.data
            tool_call.stdout = result.stdout
            tool_call.stderr = result.stderr
            tool_call.error = result.error
            tool_call.artifacts = result.artifacts
            tool_call.metadata = result.metadata
            tool_call.duration_ms = result.duration_ms
            
            # Add to task's tool calls
            task.tool_calls.append(tool_call)
            
            # Emit tool finished event
            await event_bus.publish(create_tool_event(
                event_type=EventType.TOOL_FINISHED,
                task_id=task.task_id,
                tool_name=tool_name,
                call_id=tool_call.call_id,
                step_id=step.step_id,
                success=result.success,
                duration_ms=result.duration_ms,
                error=result.error
            ))
            
            return result
            
        except asyncio.TimeoutError:
            error_msg = f"Tool execution timed out after {timeout}s"
            tool_call.completed_at = datetime.now(timezone.utc)
            tool_call.success = False
            tool_call.error = error_msg
            task.tool_calls.append(tool_call)
            
            await event_bus.publish(create_tool_event(
                event_type=EventType.TOOL_ERROR,
                task_id=task.task_id,
                tool_name=tool_name,
                call_id=tool_call.call_id,
                step_id=step.step_id,
                success=False,
                error=error_msg
            ))
            
            return ToolResult(
                success=False,
                error=error_msg
            )
            
        except Exception as e:
            error_msg = f"Tool execution failed: {str(e)}"
            tool_call.completed_at = datetime.now(timezone.utc)
            tool_call.success = False
            tool_call.error = error_msg
            task.tool_calls.append(tool_call)
            
            await event_bus.publish(create_tool_event(
                event_type=EventType.TOOL_ERROR,
                task_id=task.task_id,
                tool_name=tool_name,
                call_id=tool_call.call_id,
                step_id=step.step_id,
                success=False,
                error=error_msg
            ))
            
            return ToolResult(
                success=False,
                error=error_msg
            )
    
    async def _check_permission(
        self,
        task: Task,
        tool_name: str,
        parameters: Dict[str, Any]
    ) -> bool:
        """
        Check if tool execution is permitted.
        
        Returns True if allowed, False if denied.
        """
        tool = tool_registry.get(tool_name)
        if not tool:
            return False
        
        risk_level = tool.permission_level
        
        # Low risk tools are auto-approved
        if risk_level == RiskLevel.LOW:
            return True
        
        # Check if already granted for this task
        if task.permissions.get(tool_name):
            return True
        
        # Check pending permissions
        perm_key = f"{task.task_id}:{tool_name}"
        if perm_key in self._pending_permissions:
            return self._pending_permissions[perm_key]
        
        # For MEDIUM risk, auto-approve in MVP
        # For HIGH risk, would require user approval
        if risk_level == RiskLevel.MEDIUM:
            task.permissions[tool_name] = True
            return True
        
        # HIGH risk - emit permission request event
        # In full implementation, wait for user response
        await event_bus.publish(create_permission_event(
            request_id=str(hash(f"{task.task_id}:{tool_name}")),
            task_id=task.task_id,
            tool_name=tool_name,
            action=tool.description,
            risk_level=risk_level.value,
            reason=f"Tool {tool_name} requires {risk_level.value} permission",
            status="auto_approved_mvp"
        ))
        
        # Auto-approve for MVP
        task.permissions[tool_name] = True
        return True
    
    def grant_permission(self, task_id: str, tool_name: str, granted: bool):
        """Manually grant or deny permission."""
        perm_key = f"{task_id}:{tool_name}"
        self._pending_permissions[perm_key] = granted
    
    async def health_check_all(self) -> Dict[str, bool]:
        """Run health checks on all registered tools."""
        return await tool_registry.health_check_all()


# Global executor instance
executor = Executor()


# Singleton getter
def get_executor() -> Executor:
    """Get the global executor instance."""
    return executor
