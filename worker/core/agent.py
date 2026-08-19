"""
Worker Core - Main Agent Loop.

Implements the core agent cycle:
SEE → UNDERSTAND → PLAN → ACT → OBSERVE → VERIFY → CORRECT → CONTINUE

This is the brain of WORKER that orchestrates all components.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List

from .models import (
    Task, TaskState, StepStatus, Plan, Step,
    ToolCall, Observation, Verification, Artifact
)
from .planner import Planner
from .executor import Executor
from .observer import Observer
from .verifier import Verifier
from .task_manager import TaskManager
from .events import Event, EventType, event_bus

logger = logging.getLogger(__name__)


def _update_task(task_manager: TaskManager, task: Task):
    """Helper to update task in manager (sync wrapper)."""
    # For sync contexts, we just update the in-memory reference
    # The async persist happens separately
    task_manager._tasks[task.task_id] = task


class AgentLoop:
    """
    Main agent loop controller.
    
    Orchestrates the full lifecycle of task execution:
    1. Analyze task
    2. Create plan
    3. Execute steps
    4. Observe results
    5. Verify completion
    6. Correct on failure
    7. Repeat until done
    """
    
    def __init__(
        self,
        task_manager: TaskManager,
        planner: Planner,
        executor: Executor,
        observer: Observer,
        verifier: Verifier,
        max_iterations: int = 50,
        step_timeout: int = 300,  # 5 minutes per step
        global_timeout: int = 3600,  # 1 hour total
    ):
        self.task_manager = task_manager
        self.planner = planner
        self.executor = executor
        self.observer = observer
        self.verifier = verifier
        
        # Control limits
        self.max_iterations = max_iterations
        self.step_timeout = step_timeout
        self.global_timeout = global_timeout
        
        # Runtime state
        self._running = False
        self._paused = False
        self._current_task: Optional[Task] = None
        self._iteration_count = 0
        self._start_time: Optional[datetime] = None
        
        # Cancellation
        self._cancelled = False
        self._cancel_event = asyncio.Event()
    
    async def start_task(self, task_id: str) -> bool:
        """
        Start executing a task.
        
        Returns True if task completed successfully, False otherwise.
        """
        task = self.task_manager.get_task(task_id)
        if not task:
            logger.error(f"Task {task_id} not found")
            return False
        
        if task.current_state != TaskState.CREATED:
            logger.warning(f"Task {task_id} is not in CREATED state: {task.current_state}")
            # Allow restarting from certain states
            if task.current_state not in [TaskState.FAILED, TaskState.CANCELLED]:
                return False
        
        self._current_task = task
        self._running = True
        self._paused = False
        self._cancelled = False
        self._iteration_count = 0
        self._start_time = datetime.now(timezone.utc)
        
        logger.info(f"Starting agent loop for task {task_id}")
        await event_bus.emit(Event(
            event_type=EventType.TASK_STARTED,
            task_id=task_id,
            data={"objective": task.objective}
        ))
        
        try:
            success = await self._run_loop(task)
            return success
        except asyncio.CancelledError:
            logger.info(f"Task {task_id} cancelled")
            task.current_state = TaskState.CANCELLED
            task.cancelled = True
            _update_task(self.task_manager, task)
            return False
        except Exception as e:
            logger.exception(f"Agent loop failed for task {task_id}: {e}")
            task.current_state = TaskState.FAILED
            task.errors.append(f"Agent loop error: {str(e)}")
            _update_task(self.task_manager, task)
            return False
        finally:
            self._running = False
            self._current_task = None
    
    async def _run_loop(self, task: Task) -> bool:
        """
        Main agent loop implementation.
        
        while task not finished:
            1. read current task state
            2. determine next objective
            3. select tool / execute step
            4. collect observation
            5. verify result
            6. update state
            7. if failed: analyze and retry
            8. if goal reached: complete
        """
        while self._running and not self._cancelled:
            # Check global timeout
            elapsed = (datetime.now(timezone.utc) - self._start_time).total_seconds()
            if elapsed > self.global_timeout:
                logger.error(f"Global timeout exceeded ({elapsed}s)")
                task.current_state = TaskState.FAILED
                task.errors.append(f"Global timeout: {elapsed}s > {self.global_timeout}s")
                _update_task(self.task_manager, task)
                return False
            
            # Check iteration limit
            if self._iteration_count >= self.max_iterations:
                logger.error(f"Max iterations exceeded ({self.max_iterations})")
                task.current_state = TaskState.FAILED
                task.errors.append(f"Max iterations: {self.max_iterations}")
                _update_task(self.task_manager, task)
                return False
            
            self._iteration_count += 1
            
            # Handle pause
            while self._paused and not self._cancelled:
                await asyncio.sleep(0.5)
            
            if self._cancelled:
                break
            
            # STEP 1: Read current state
            task = self.task_manager.get_task(task.task_id)
            if not task:
                logger.error("Task disappeared during execution")
                return False
            
            logger.debug(f"Iteration {self._iteration_count}, state: {task.current_state}")
            
            # State machine transitions
            if task.current_state == TaskState.CREATED:
                task.current_state = TaskState.ANALYZING
                _update_task(self.task_manager, task)
            
            elif task.current_state == TaskState.ANALYZING:
                # Analyze task and create plan
                success = await self._analyze_and_plan(task)
                if not success:
                    return False
                task = self.task_manager.get_task(task.task_id)
            
            elif task.current_state == TaskState.PLANNING:
                # Plan created, ready to execute
                task.current_state = TaskState.EXECUTING
                _update_task(self.task_manager, task)
            
            elif task.current_state == TaskState.EXECUTING:
                # Execute next step
                success = await self._execute_next_step(task)
                if not success:
                    # Check if we should retry or fail
                    if task.retries >= task.max_retries:
                        task.current_state = TaskState.FAILED
                        _update_task(self.task_manager, task)
                        return False
                    task.current_state = TaskState.RETRYING
                    task.retries += 1
                    _update_task(self.task_manager, task)
                    continue
                task = self.task_manager.get_task(task.task_id)
            
            elif task.current_state == TaskState.OBSERVING:
                # Collect observation after action
                success = await self._collect_observation(task)
                if not success:
                    task.errors.append("Observation collection failed")
                task = self.task_manager.get_task(task.task_id)
            
            elif task.current_state == TaskState.VERIFYING:
                # Verify if step/task is complete
                verification = await self._verify_completion(task)
                if verification.passed:
                    # Check if entire task is done
                    if self._is_task_complete(task):
                        task.current_state = TaskState.COMPLETED
                        task.completed_at = datetime.now(timezone.utc)
                        task.final_result = "Task completed successfully"
                        _update_task(self.task_manager, task)
                        logger.info(f"Task {task.task_id} completed")
                        return True
                    else:
                        # Continue to next step
                        task.current_state = TaskState.EXECUTING
                        _update_task(self.task_manager, task)
                else:
                    # Verification failed, need to correct
                    logger.warning(f"Verification failed: {verification.message}")
                    task.errors.append(f"Verification failed: {verification.message}")
                    if task.retries < task.max_retries:
                        task.current_state = TaskState.RETRYING
                        task.retries += 1
                        _update_task(self.task_manager, task)
                    else:
                        task.current_state = TaskState.FAILED
                        _update_task(self.task_manager, task)
                        return False
            
            elif task.current_state == TaskState.RETRYING:
                # Re-plan and retry
                logger.info(f"Retrying task {task.task_id} (attempt {task.retries})")
                task.current_state = TaskState.PLANNING
                _update_task(self.task_manager, task)
            
            elif task.current_state in [TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED]:
                # Terminal state
                self._running = False
                return task.current_state == TaskState.COMPLETED
            
            # Small delay to prevent tight loop
            await asyncio.sleep(0.1)
        
        return False
    
    async def _analyze_and_plan(self, task: Task) -> bool:
        """Analyze task and create execution plan."""
        logger.info(f"Creating plan for task: {task.objective}")
        
        try:
            plan = await self.planner.create_plan(
                task_id=task.task_id,
                objective=task.objective
            )
            if not plan:
                task.errors.append("Failed to create plan")
                task.current_state = TaskState.FAILED
                _update_task(self.task_manager, task)
                return False
            
            task.plan = plan
            task.current_state = TaskState.PLANNING
            _update_task(self.task_manager, task)
            
            await event_bus.emit(Event(
                event_type=EventType.PLAN_CREATED,
                task_id=task.task_id,
                data={
                    "plan_id": plan.plan_id,
                    "steps_count": len(plan.steps)
                }
            ))
            
            logger.info(f"Plan created with {len(plan.steps)} steps")
            return True
            
        except Exception as e:
            logger.exception(f"Planning failed: {e}")
            task.errors.append(f"Planning error: {str(e)}")
            return False
    
    async def _execute_next_step(self, task: Task) -> bool:
        """Execute the next pending step."""
        if not task.plan:
            logger.error("No plan available")
            return False
        
        step = task.plan.get_next_step()
        if not step:
            # No more pending steps
            logger.info("All steps executed")
            task.current_state = TaskState.VERIFYING
            _update_task(self.task_manager, task)
            return True
        
        logger.info(f"Executing step: {step.description}")
        
        try:
            # Execute via executor
            tool_call = await self.executor.execute_step(task, step)
            
            # Record tool call
            task.tool_calls.append(tool_call)
            
            if tool_call.success:
                step.status = StepStatus.SUCCESS
                step.result = tool_call.data
                task.completed_steps.append(step.step_id)
            else:
                step.status = StepStatus.FAILED
                step.error = tool_call.error
                task.errors.append(tool_call.error)
            
            step.completed_at = datetime.now(timezone.utc)
            task.current_state = TaskState.OBSERVING
            _update_task(self.task_manager, task)
            
            await event_bus.emit(Event(
                event_type=EventType.STEP_COMPLETED,
                task_id=task.task_id,
                data={
                    "step_id": step.step_id,
                    "success": tool_call.success
                }
            ))
            
            return tool_call.success
            
        except asyncio.TimeoutError:
            logger.error(f"Step {step.step_id} timed out")
            step.status = StepStatus.FAILED
            step.error = f"Timeout after {self.step_timeout}s"
            task.errors.append(step.error)
            _update_task(self.task_manager, task)
            return False
            
        except Exception as e:
            logger.exception(f"Step execution failed: {e}")
            step.status = StepStatus.FAILED
            step.error = str(e)
            task.errors.append(str(e))
            _update_task(self.task_manager, task)
            return False
    
    async def _collect_observation(self, task: Task) -> bool:
        """Collect observation after step execution."""
        last_tool_call = task.tool_calls[-1] if task.tool_calls else None
        
        try:
            observation = await self.observer.observe_step(
                task=task,
                tool_call=last_tool_call
            )
            
            task.observations.append(observation)
            _update_task(self.task_manager, task)
            
            await event_bus.emit(Event(
                event_type=EventType.OBSERVATION_CREATED,
                task_id=task.task_id,
                data={
                    "observation_id": observation.observation_id,
                    "what_changed": observation.what_changed
                }
            ))
            
            logger.debug(f"Observation collected: {observation.what_changed}")
            return True
            
        except Exception as e:
            logger.exception(f"Observation failed: {e}")
            return False
    
    async def _verify_completion(self, task: Task) -> Verification:
        """Verify if task/step objectives are met."""
        try:
            verification = await self.verifier.verify_task(task)
            
            await event_bus.emit(Event(
                event_type=EventType.VERIFICATION_COMPLETED,
                task_id=task.task_id,
                data={
                    "passed": verification.passed,
                    "goal_reached": verification.goal_reached
                }
            ))
            
            return verification
            
        except Exception as e:
            logger.exception(f"Verification failed: {e}")
            return Verification(
                task_id=task.task_id,
                passed=False,
                goal_reached=False,
                message=f"Verification error: {str(e)}"
            )
    
    def _is_task_complete(self, task: Task) -> bool:
        """Check if entire task is complete."""
        if not task.plan:
            return False
        
        # All steps should be completed successfully
        for step in task.plan.steps:
            if step.status != StepStatus.SUCCESS:
                return False
        
        # Objective should be verified
        return True
    
    def pause(self):
        """Pause the agent loop."""
        self._paused = True
        logger.info("Agent loop paused")
    
    def resume(self):
        """Resume the agent loop."""
        self._paused = False
        logger.info("Agent loop resumed")
    
    def stop(self):
        """Stop the agent loop gracefully."""
        self._running = False
        logger.info("Agent loop stopping")
    
    async def cancel(self):
        """Cancel the current task immediately."""
        self._cancelled = True
        self._cancel_event.set()
        self._running = False
        logger.info("Agent loop cancelled")
        
        if self._current_task:
            self._current_task.current_state = TaskState.CANCELLED
            self._current_task.cancelled = True
            _update_task(self.task_manager, self._current_task)
    
    @property
    def is_running(self) -> bool:
        return self._running
    
    @property
    def is_paused(self) -> bool:
        return self._paused
    
    @property
    def current_task(self) -> Optional[Task]:
        return self._current_task
    
    @property
    def iteration_count(self) -> int:
        return self._iteration_count


# Singleton instance
_agent_loop: Optional[AgentLoop] = None


def get_agent_loop() -> AgentLoop:
    """Get or create the global agent loop instance."""
    global _agent_loop
    if _agent_loop is None:
        from .task_manager import task_manager
        from .planner import get_planner
        from .executor import get_executor
        from .observer import get_observer
        from .verifier import get_verifier
        
        _agent_loop = AgentLoop(
            task_manager=task_manager,
            planner=get_planner(),
            executor=get_executor(),
            observer=get_observer(),
            verifier=get_verifier()
        )
    return _agent_loop
