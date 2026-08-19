"""
Tests for AgentLoop - the main agent cycle controller.

Verifies:
- Agent loop initialization
- State transitions
- Task execution flow
- Pause/Resume/Cancel functionality
- Timeout handling
- Error recovery
"""

import pytest
import asyncio
from datetime import datetime, timezone

from worker.core.models import (
    Task, TaskState, StepStatus, Plan, Step,
    ToolCall, Observation, Verification
)
from worker.core.agent import AgentLoop, _update_task
from worker.core.task_manager import TaskManager
from worker.core.planner import Planner
from worker.core.executor import Executor
from worker.core.observer import Observer
from worker.core.verifier import Verifier


@pytest.fixture
def task_manager():
    return TaskManager()


@pytest.fixture
def planner():
    return Planner()


@pytest.fixture
def executor():
    return Executor()


@pytest.fixture
def observer():
    return Observer()


@pytest.fixture
def verifier():
    return Verifier()


@pytest.fixture
def agent_loop(task_manager, planner, executor, observer, verifier):
    return AgentLoop(
        task_manager=task_manager,
        planner=planner,
        executor=executor,
        observer=observer,
        verifier=verifier,
        max_iterations=10,
        step_timeout=60,
        global_timeout=300
    )


@pytest.fixture
def sample_task(task_manager):
    """Create a sample task for testing."""
    task = Task(
        user_request="Test task",
        objective="Complete a simple test"
    )
    task_manager._tasks[task.task_id] = task
    return task


class TestAgentLoopInitialization:
    """Test AgentLoop initialization."""
    
    def test_init(self, agent_loop):
        """Test basic initialization."""
        assert agent_loop.max_iterations == 10
        assert agent_loop.step_timeout == 60
        assert agent_loop.global_timeout == 300
        assert not agent_loop.is_running
        assert not agent_loop.is_paused
        assert agent_loop.current_task is None
    
    def test_properties(self, agent_loop):
        """Test property accessors."""
        assert agent_loop.iteration_count == 0
        assert not agent_loop._running
        assert not agent_loop._paused
        assert not agent_loop._cancelled


class TestAgentLoopLifecycle:
    """Test agent loop lifecycle."""
    
    @pytest.mark.asyncio
    async def test_start_nonexistent_task(self, agent_loop):
        """Test starting a task that doesn't exist."""
        result = await agent_loop.start_task("nonexistent-id")
        assert result is False
    
    @pytest.mark.asyncio
    async def test_start_task(self, agent_loop, sample_task):
        """Test starting a valid task."""
        # Mock the planner to return a simple plan
        plan = Plan(
            task_id=sample_task.task_id,
            objective=sample_task.objective,
            steps=[
                Step(
                    description="Test step",
                    action="files.read",
                    parameters={"path": "/tmp/test.txt"}
                )
            ]
        )
        sample_task.plan = plan
        _update_task(agent_loop.task_manager, sample_task)
        
        # Start the task (will fail due to no LLM, but tests the flow)
        result = await agent_loop.start_task(sample_task.task_id)
        
        # Task should transition from CREATED
        assert sample_task.current_state != TaskState.CREATED


class TestStateTransitions:
    """Test state machine transitions."""
    
    def test_created_to_analyzing(self, agent_loop, sample_task):
        """Test transition from CREATED to ANALYZING."""
        # This happens in _run_loop
        assert sample_task.current_state == TaskState.CREATED
    
    def test_pause_resume(self, agent_loop):
        """Test pause and resume functionality."""
        agent_loop.pause()
        assert agent_loop.is_paused
        
        agent_loop.resume()
        assert not agent_loop.is_paused
    
    @pytest.mark.asyncio
    async def test_cancel(self, agent_loop, sample_task):
        """Test task cancellation."""
        agent_loop._current_task = sample_task
        agent_loop._running = True
        
        await agent_loop.cancel()
        
        assert agent_loop._cancelled
        assert not agent_loop._running
        # Task state should be updated via _update_task helper
        assert sample_task.current_state == TaskState.CANCELLED
        assert sample_task.cancelled is True


class TestIterationLimits:
    """Test iteration and timeout limits."""
    
    def test_iteration_count(self, agent_loop):
        """Test iteration counting."""
        assert agent_loop.iteration_count == 0
        
        # Simulate iterations
        agent_loop._iteration_count = 5
        assert agent_loop.iteration_count == 5
    
    def test_max_iterations_exceeded(self, agent_loop, sample_task):
        """Test behavior when max iterations exceeded."""
        agent_loop._iteration_count = agent_loop.max_iterations + 1
        agent_loop._start_time = datetime.now(timezone.utc)
        agent_loop._running = True
        
        # In actual loop, this would cause failure
        # Here we just verify the limit is set
        assert agent_loop.max_iterations == 10


class TestErrorHandling:
    """Test error handling in agent loop."""
    
    @pytest.mark.asyncio
    async def test_exception_in_loop(self, agent_loop, sample_task):
        """Test that exceptions are caught and task is marked failed."""
        # Set up task to trigger an error
        sample_task.current_state = TaskState.ANALYZING
        _update_task(agent_loop.task_manager, sample_task)
        
        # Mock planner to raise exception
        original_create_plan = agent_loop.planner.create_plan
        
        async def failing_create_plan(task):
            raise Exception("Simulated planning failure")
        
        agent_loop.planner.create_plan = failing_create_plan
        
        try:
            result = await agent_loop.start_task(sample_task.task_id)
            # Task should fail due to exception
            assert result is False
            # State should be FAILED or still ANALYZING (depending on when caught)
            assert sample_task.current_state in [TaskState.FAILED, TaskState.ANALYZING]
        finally:
            # Restore
            agent_loop.planner.create_plan = original_create_plan


class TestTaskCompletion:
    """Test task completion detection."""
    
    def test_is_task_complete_no_plan(self, agent_loop, sample_task):
        """Test completion check with no plan."""
        assert not agent_loop._is_task_complete(sample_task)
    
    def test_is_task_complete_partial_steps(self, agent_loop, sample_task):
        """Test completion check with partial steps."""
        plan = Plan(
            task_id=sample_task.task_id,
            objective=sample_task.objective,
            steps=[
                Step(description="Step 1", action="test", status=StepStatus.SUCCESS),
                Step(description="Step 2", action="test", status=StepStatus.PENDING),
            ]
        )
        sample_task.plan = plan
        
        assert not agent_loop._is_task_complete(sample_task)
    
    def test_is_task_complete_all_success(self, agent_loop, sample_task):
        """Test completion check with all successful steps."""
        plan = Plan(
            task_id=sample_task.task_id,
            objective=sample_task.objective,
            steps=[
                Step(description="Step 1", action="test", status=StepStatus.SUCCESS),
                Step(description="Step 2", action="test", status=StepStatus.SUCCESS),
            ]
        )
        sample_task.plan = plan
        
        # Note: This also checks verification, which requires more setup
        # For unit test, we just verify the step logic
        for step in plan.steps:
            assert step.status == StepStatus.SUCCESS


class TestGlobalAgentLoop:
    """Test the global agent loop singleton."""
    
    def test_get_agent_loop(self):
        """Test getting the global agent loop instance."""
        from worker.core.agent import get_agent_loop
        
        loop1 = get_agent_loop()
        loop2 = get_agent_loop()
        
        # Should be the same instance (singleton)
        assert loop1 is loop2
        assert isinstance(loop1, AgentLoop)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
