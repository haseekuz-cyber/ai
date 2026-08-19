"""
Verifier module for WORKER.

Validates task/step completion:
- Goal achievement check
- Evidence collection
- Multi-criteria verification
"""

from typing import Any, Dict, List, Optional
from datetime import datetime
import uuid

from worker.core.models import (
    Task, TaskState, Step, Plan, Verification
)
from worker.core.events import event_bus, EventType


class Verifier:
    """
    Verifies that tasks and steps achieved their goals.
    
    Responsibilities:
    - Check if objective is met
    - Validate step results
    - Collect evidence
    - Report verification status
    """
    
    def __init__(self):
        self._verifications: Dict[str, List[Verification]] = {}
    
    async def verify_task(self, task: Task) -> Verification:
        """
        Verify if the task's overall objective is achieved.
        
        Checks:
        - All required steps completed successfully
        - No critical errors
        - Expected artifacts exist
        - User's goal is satisfied
        """
        verification_id = str(uuid.uuid4())
        
        checks_performed = []
        check_results = {}
        evidence = []
        
        # Check 1: Plan completion
        checks_performed.append("plan_completion")
        plan_complete = self._check_plan_completion(task)
        check_results["plan_completion"] = plan_complete
        if plan_complete:
            evidence.append("All plan steps executed")
        
        # Check 2: No critical errors
        checks_performed.append("error_check")
        has_critical_errors = len(task.errors) > 0
        check_results["no_critical_errors"] = not has_critical_errors
        if not has_critical_errors:
            evidence.append("No critical errors recorded")
        
        # Check 3: Tool calls succeeded
        checks_performed.append("tool_success_rate")
        success_rate = self._calculate_tool_success_rate(task)
        check_results["tool_success_rate"] = success_rate >= 0.8
        if success_rate >= 0.8:
            evidence.append(f"Tool success rate: {success_rate:.0%}")
        
        # Check 4: Artifacts produced (if expected)
        checks_performed.append("artifacts_check")
        has_artifacts = len(task.artifacts) > 0
        check_results["has_artifacts"] = has_artifacts
        if has_artifacts:
            evidence.append(f"{len(task.artifacts)} artifacts created")
        
        # Check 5: Observations confidence
        checks_performed.append("observation_confidence")
        avg_confidence = self._calculate_avg_confidence(task)
        check_results["sufficient_confidence"] = avg_confidence >= 0.7
        if avg_confidence >= 0.7:
            evidence.append(f"Average observation confidence: {avg_confidence:.0%}")
        
        # Determine if goal reached
        passed_checks = sum(1 for v in check_results.values() if v)
        total_checks = len(check_results)
        goal_reached = passed_checks >= (total_checks * 0.6)  # 60% threshold
        
        verification = Verification(
            verification_id=verification_id,
            task_id=task.task_id,
            passed=goal_reached,
            goal_reached=goal_reached,
            checks_performed=checks_performed,
            check_results=check_results,
            evidence=evidence,
            message=self._generate_message(goal_reached, check_results)
        )
        
        # Store verification
        if task.task_id not in self._verifications:
            self._verifications[task.task_id] = []
        self._verifications[task.task_id].append(verification)
        
        # Emit event
        from worker.core.events import EventType, DataEvent
        await event_bus.publish(DataEvent[Dict](
            event_type=EventType.VERIFICATION_PASSED if goal_reached else EventType.VERIFICATION_FAILED,
            data={
                "task_id": task.task_id,
                "verification_id": verification_id,
                "passed": goal_reached,
                "message": verification.message
            }
        ))
        
        return verification
    
    async def verify_step(self, task: Task, step: Step) -> Verification:
        """
        Verify if a specific step achieved its goal.
        """
        verification_id = str(uuid.uuid4())
        
        checks_performed = ["step_execution"]
        check_results = {}
        evidence = []
        
        # Check step status
        if step.status.value == "success":
            check_results["step_completed"] = True
            evidence.append(f"Step '{step.description}' completed successfully")
            
            # Check if result matches expectations
            if step.result:
                checks_performed.append("result_validation")
                check_results["has_result"] = True
                evidence.append("Result data present")
        else:
            check_results["step_completed"] = False
            if step.error:
                evidence.append(f"Step failed: {step.error}")
        
        passed = step.status.value == "success"
        
        verification = Verification(
            verification_id=verification_id,
            task_id=task.task_id,
            step_id=step.step_id,
            passed=passed,
            goal_reached=passed,
            checks_performed=checks_performed,
            check_results=check_results,
            evidence=evidence,
            message="Step verified" if passed else f"Step verification failed: {step.error or 'Unknown error'}"
        )
        
        return verification
    
    def _check_plan_completion(self, task: Task) -> bool:
        """Check if all required plan steps are complete."""
        # Get plan from task context or return True if no plan
        if not hasattr(task, 'plan') or not task.plan:
            return True
        
        plan = task.plan
        for step in plan.steps:
            # Skip verification steps
            if step.action.startswith("__"):
                continue
            
            if step.status.value in ["pending", "running"]:
                return False
        
        return True
    
    def _calculate_tool_success_rate(self, task: Task) -> float:
        """Calculate success rate of tool calls."""
        if not task.tool_calls:
            return 1.0  # No calls = no failures
        
        successful = sum(1 for tc in task.tool_calls if tc.success)
        return successful / len(task.tool_calls)
    
    def _calculate_avg_confidence(self, task: Task) -> float:
        """Calculate average confidence from observations."""
        if not task.observations:
            return 1.0  # No observations = assume confident
        
        confidences = [obs.confidence for obs in task.observations]
        return sum(confidences) / len(confidences)
    
    def _generate_message(self, goal_reached: bool, check_results: Dict[str, bool]) -> str:
        """Generate human-readable verification message."""
        if goal_reached:
            passed = sum(1 for v in check_results.values() if v)
            total = len(check_results)
            return f"Verification passed: {passed}/{total} checks successful"
        else:
            failed = [k for k, v in check_results.items() if not v]
            return f"Verification failed: {', '.join(failed)} did not pass"
    
    def get_verifications(self, task_id: str) -> List[Verification]:
        """Get all verifications for a task."""
        return self._verifications.get(task_id, [])
    
    def get_last_verification(self, task_id: str) -> Optional[Verification]:
        """Get the most recent verification for a task."""
        verifications = self.get_verifications(task_id)
        return verifications[-1] if verifications else None


# Global verifier instance
verifier = Verifier()


# Singleton getter
def get_verifier() -> Verifier:
    """Get the global verifier instance."""
    return verifier
