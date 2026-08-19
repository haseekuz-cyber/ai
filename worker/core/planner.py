"""
Planner module for WORKER.

Converts task objectives into executable plans with:
- Step decomposition
- Dependency tracking
- Dynamic replanning
- Retry limits
"""

import asyncio
from typing import Any, Dict, List, Optional
from datetime import datetime, timezone
import uuid

from worker.core.models import (
    Task, TaskState, Plan, Step, StepStatus,
    Tool, RiskLevel
)
from worker.core.events import event_bus, EventType, create_step_event
from worker.core.tools import tool_registry


class Planner:
    """
    Converts objectives into executable plans.
    
    Responsibilities:
    - Create initial plan from objective
    - Track step dependencies
    - Replan based on observations
    - Avoid infinite loops
    """
    
    def __init__(self, max_steps: int = 50, max_retries: int = 3):
        self.max_steps = max_steps
        self.max_retries = max_retries
        self._plans: Dict[str, Plan] = {}
    
    async def create_plan(
        self,
        task_id: str,
        objective: str,
        context: Optional[Dict[str, Any]] = None
    ) -> Plan:
        """
        Create an initial plan for the task.
        
        In a full implementation, this would use LLM to generate steps.
        For now, creates a basic template based on objective analysis.
        """
        plan_id = str(uuid.uuid4())
        
        # Basic heuristic plan generation
        # In production: call LLM to analyze objective and generate steps
        steps = await self._generate_steps(task_id, objective, context)
        
        plan = Plan(
            plan_id=plan_id,
            task_id=task_id,
            objective=objective,
            steps=steps,
            strategy="heuristic" if not context else "context_aware",
            assumptions=[],
            risks=[]
        )
        
        self._plans[task_id] = plan
        
        # Emit event
        await event_bus.publish(create_step_event(
            event_type=EventType.PLAN_CREATED,
            task_id=task_id,
            step_id=plan_id,
            description=f"Plan created with {len(steps)} steps",
            status="created"
        ))
        
        return plan
    
    async def _generate_steps(
        self,
        task_id: str,
        objective: str,
        context: Optional[Dict[str, Any]] = None
    ) -> List[Step]:
        """
        Generate steps based on objective keywords.
        
        This is a placeholder - in production, use LLM.
        """
        steps = []
        obj_lower = objective.lower()
        
        # Heuristic step generation
        if any(kw in obj_lower for kw in ["read", "open", "view", "show"]):
            if "file" in obj_lower or "." in obj_lower:
                steps.append(Step(
                    description="Identify the file path",
                    action="files.list",
                    parameters={"path": ".", "recursive": False}
                ))
                steps.append(Step(
                    description="Read the file content",
                    action="files.read",
                    parameters={}
                ))
        
        if any(kw in obj_lower for kw in ["write", "create", "save", "make"]):
            if "file" in obj_lower:
                steps.append(Step(
                    description="Create parent directories if needed",
                    action="files.write",
                    parameters={}
                ))
        
        if any(kw in obj_lower for kw in ["run", "execute", "start", "launch"]):
            if "python" in obj_lower or ".py" in obj_lower:
                steps.append(Step(
                    description="Run Python script",
                    action="terminal.run",
                    parameters={"command": "python script.py"}
                ))
            else:
                steps.append(Step(
                    description="Execute command",
                    action="terminal.run",
                    parameters={"command": ""}
                ))
        
        if any(kw in obj_lower for kw in ["test", "check", "verify"]):
            steps.append(Step(
                description="Run verification",
                action="terminal.run",
                parameters={"command": ""}
            ))
        
        if any(kw in obj_lower for kw in ["fix", "repair", "correct", "update"]):
            steps.insert(0, Step(
                description="Analyze current state",
                action="files.list",
                parameters={"path": "."}
            ))
        
        # Default: add exploration step
        if not steps:
            steps.append(Step(
                description="Explore environment",
                action="files.list",
                parameters={"path": ".", "recursive": True}
            ))
        
        # Add verification step at end
        steps.append(Step(
            description="Verify result",
            action="__verify__",
            parameters={}
        ))
        
        # Set dependencies (sequential by default)
        for i in range(1, len(steps)):
            steps[i].dependencies = [steps[i-1].step_id]
        
        return steps
    
    def get_plan(self, task_id: str) -> Optional[Plan]:
        """Get plan for a task."""
        return self._plans.get(task_id)
    
    def get_next_step(self, task: Task) -> Optional[Step]:
        """
        Get the next step to execute.
        
        Returns None if all steps are complete.
        """
        plan = self.get_plan(task.task_id)
        if not plan:
            return None
        
        # Find first pending step with met dependencies
        for step in plan.steps:
            if step.status == StepStatus.PENDING:
                # Check dependencies
                deps_met = all(
                    any(s.step_id == dep and s.status == StepStatus.SUCCESS 
                        for s in plan.steps)
                    for dep in step.dependencies
                )
                if deps_met:
                    return step
        
        return None
    
    async def update_step_status(
        self,
        task_id: str,
        step_id: str,
        status: StepStatus,
        result: Any = None,
        error: Optional[str] = None
    ) -> bool:
        """Update step status and emit event."""
        plan = self.get_plan(task_id)
        if not plan:
            return False
        
        for step in plan.steps:
            if step.step_id == step_id:
                step.status = status
                step.result = result
                step.error = error
                step.completed_at = datetime.now(timezone.utc)
                
                plan.updated_at = datetime.now(timezone.utc)
                
                # Emit event
                event_type = {
                    StepStatus.SUCCESS: EventType.STEP_COMPLETED,
                    StepStatus.FAILED: EventType.STEP_FAILED,
                    StepStatus.RUNNING: EventType.STEP_STARTED
                }.get(status, EventType.STEP_COMPLETED)
                
                await event_bus.publish(create_step_event(
                    event_type=event_type,
                    task_id=task_id,
                    step_id=step_id,
                    description=step.description,
                    status=status.value,
                    error=error
                ))
                
                return True
        
        return False
    
    async def replan(
        self,
        task_id: str,
        reason: str,
        observations: List[Any] = None
    ) -> Optional[Plan]:
        """
        Regenerate plan based on new information.
        
        Called when current plan fails or observations suggest different approach.
        """
        plan = self.get_plan(task_id)
        if not plan:
            return None
        
        # Increment retry counter on failed steps
        for step in plan.steps:
            if step.status == StepStatus.FAILED:
                step.retry_count += 1
                if step.retry_count >= self.max_retries:
                    step.status = StepStatus.SKIPPED
        
        # In production: call LLM to generate new plan based on observations
        # For now, just reset failed steps to pending
        for step in plan.steps:
            if step.status == StepStatus.FAILED and step.retry_count < self.max_retries:
                step.status = StepStatus.PENDING
                step.error = None
        
        plan.updated_at = datetime.now(timezone.utc)
        plan.risks.append(reason)
        
        return plan
    
    def is_plan_complete(self, task_id: str) -> bool:
        """Check if all steps in plan are complete."""
        plan = self.get_plan(task_id)
        if not plan:
            return False
        
        for step in plan.steps:
            if step.status in [StepStatus.PENDING, StepStatus.RUNNING]:
                return False
        
        return True
    
    def get_remaining_steps(self, task_id: str) -> List[Step]:
        """Get list of remaining steps."""
        plan = self.get_plan(task_id)
        if not plan:
            return []
        
        return [
            step for step in plan.steps
            if step.status in [StepStatus.PENDING, StepStatus.RUNNING]
        ]
    
    def has_failed_steps(self, task_id: str) -> bool:
        """Check if plan has failed steps."""
        plan = self.get_plan(task_id)
        if not plan:
            return False
        
        return any(step.status == StepStatus.FAILED for step in plan.steps)


# Global planner instance
planner = Planner()


# Singleton getter
def get_planner() -> Planner:
    """Get the global planner instance."""
    return planner

