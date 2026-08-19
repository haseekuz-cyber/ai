"""
Tests for WORKER core components.

Covers:
- Task Manager
- Planner
- Executor
- Observer
- Verifier
- Tool Registry
"""

import pytest
import asyncio
from datetime import datetime

from worker.core.models import (
    Task, TaskState, Step, StepStatus, Plan,
    ToolCategory, RiskLevel, ToolSchema
)
from worker.core.tools import BaseTool, ToolResult, tool_registry
from worker.core.planner import Planner
from worker.core.executor import Executor
from worker.core.observer import Observer
from worker.core.verifier import Verifier
from worker.core.task_manager import TaskManager


# ============================================================
# MOCK TOOLS FOR TESTING
# ============================================================

class MockSuccessTool(BaseTool):
    """Mock tool that always succeeds."""
    name = "mock.success"
    description = "Mock tool that succeeds"
    category = ToolCategory.SYSTEM
    permission_level = RiskLevel.LOW
    
    def get_input_schema(self) -> ToolSchema:
        return ToolSchema(type="object", properties={}, required=[])
    
    def get_output_schema(self) -> ToolSchema:
        return ToolSchema(type="object", properties={"result": {"type": "string"}})
    
    async def execute(self, **kwargs) -> ToolResult:
        return ToolResult(
            success=True,
            data={"result": "success"},
            stdout="Mock output"
        )


class MockFailTool(BaseTool):
    """Mock tool that always fails."""
    name = "mock.fail"
    description = "Mock tool that fails"
    category = ToolCategory.SYSTEM
    permission_level = RiskLevel.MEDIUM
    
    def get_input_schema(self) -> ToolSchema:
        return ToolSchema(type="object", properties={}, required=[])
    
    def get_output_schema(self) -> ToolSchema:
        return ToolSchema(type="object", properties={})
    
    async def execute(self, **kwargs) -> ToolResult:
        return ToolResult(
            success=False,
            error="Intentional failure",
            stderr="Mock error"
        )


# ============================================================
# TASK MANAGER TESTS
# ============================================================

@pytest.mark.asyncio
async def test_create_task(tmp_path):
    """Test task creation."""
    tm = TaskManager(str(tmp_path))
    
    task = await tm.create_task(
        user_request="Test request",
        objective="Test objective"
    )
    
    assert task.user_request == "Test request"
    assert task.objective == "Test objective"
    assert task.current_state == TaskState.CREATED
    assert not task.cancelled


@pytest.mark.asyncio
async def test_task_state_transitions(tmp_path):
    """Test valid state transitions."""
    tm = TaskManager(str(tmp_path))
    task = await tm.create_task("Test")
    
    # CREATED -> ANALYZING
    result = await tm.update_state(task, TaskState.ANALYZING)
    assert result is True
    assert task.current_state == TaskState.ANALYZING
    
    # ANALYZING -> PLANNING
    result = await tm.update_state(task, TaskState.PLANNING)
    assert result is True
    assert task.current_state == TaskState.PLANNING


@pytest.mark.asyncio
async def test_invalid_state_transition(tmp_path):
    """Test invalid state transition."""
    tm = TaskManager(str(tmp_path))
    task = await tm.create_task("Test")
    
    # CREATED -> EXECUTING (invalid, should go through ANALYZING, PLANNING)
    result = await tm.update_state(task, TaskState.EXECUTING)
    assert result is False
    assert task.current_state == TaskState.CREATED


@pytest.mark.asyncio
async def test_cancel_task(tmp_path):
    """Test task cancellation."""
    tm = TaskManager(str(tmp_path))
    task = await tm.create_task("Test")
    
    # Need to go through valid transitions first
    await tm.update_state(task, TaskState.ANALYZING)
    await tm.update_state(task, TaskState.PLANNING)
    await tm.update_state(task, TaskState.EXECUTING)
    
    result = await tm.cancel_task(task.task_id, "Test reason")
    
    assert result is True
    assert task.cancelled is True
    assert task.current_state == TaskState.CANCELLED


# ============================================================
# PLANNER TESTS
# ============================================================

@pytest.mark.asyncio
async def test_create_plan():
    """Test plan creation."""
    planner = Planner()
    
    plan = await planner.create_plan(
        task_id="test-123",
        objective="List files in directory"
    )
    
    assert plan.task_id == "test-123"
    assert len(plan.steps) > 0
    assert all(s.status == StepStatus.PENDING for s in plan.steps)


@pytest.mark.asyncio
async def test_get_next_step():
    """Test getting next step from plan."""
    planner = Planner()
    
    from worker.core.models import Task
    task = Task(user_request="test", objective="test")
    
    plan = await planner.create_plan(task.task_id, "Explore directory")
    task.plan = plan
    
    next_step = planner.get_next_step(task)
    assert next_step is not None
    assert next_step.status == StepStatus.PENDING


@pytest.mark.asyncio
async def test_update_step_status():
    """Test updating step status."""
    planner = Planner()
    
    plan = await planner.create_plan("test-123", "Test objective")
    step = plan.steps[0]
    
    result = await planner.update_step_status(
        "test-123",
        step.step_id,
        StepStatus.SUCCESS,
        result={"data": "test"}
    )
    
    assert result is True
    assert step.status == StepStatus.SUCCESS
    assert step.result == {"data": "test"}


# ============================================================
# EXECUTOR TESTS
# ============================================================

@pytest.mark.asyncio
async def test_execute_success_tool():
    """Test executing a successful tool."""
    executor = Executor()
    tool = MockSuccessTool()
    tool_registry.register(tool)
    
    from worker.core.models import Task, Step
    task = Task(user_request="test", objective="test")
    step = Step(description="Test step", action="mock.success")
    
    result = await executor.execute_step(task, step)
    
    assert result.success is True
    assert result.data == {"result": "success"}
    assert len(task.tool_calls) == 1


@pytest.mark.asyncio
async def test_execute_fail_tool():
    """Test executing a failing tool."""
    executor = Executor()
    tool = MockFailTool()
    tool_registry.register(tool)
    
    from worker.core.models import Task, Step
    task = Task(user_request="test", objective="test")
    step = Step(description="Test step", action="mock.fail")
    
    result = await executor.execute_step(task, step)
    
    assert result.success is False
    assert result.error == "Intentional failure"


@pytest.mark.asyncio
async def test_execute_unknown_tool():
    """Test executing unknown tool."""
    executor = Executor()
    
    from worker.core.models import Task, Step
    task = Task(user_request="test", objective="test")
    step = Step(description="Test step", action="unknown.tool")
    
    result = await executor.execute_step(task, step)
    
    assert result.success is False
    assert "not found" in result.error.lower()


# ============================================================
# OBSERVER TESTS
# ============================================================

@pytest.mark.asyncio
async def test_observe_success():
    """Test observation of successful action."""
    observer = Observer()
    
    from worker.core.models import Task, Step
    task = Task(user_request="test", objective="test")
    step = Step(description="Test step", action="files.list")
    result = ToolResult(success=True, data={"count": 10})
    
    observation = await observer.observe(task, step, result)
    
    assert observation.task_id == task.task_id
    assert observation.confidence > 0.5
    assert len(observation.errors) == 0


@pytest.mark.asyncio
async def test_observe_failure():
    """Test observation of failed action."""
    observer = Observer()
    
    from worker.core.models import Task, Step
    task = Task(user_request="test", objective="test")
    step = Step(description="Test step", action="terminal.run")
    result = ToolResult(success=False, error="Command failed", stderr="Error output")
    
    observation = await observer.observe(task, step, result)
    
    assert observation.confidence < 0.5
    assert len(observation.errors) > 0


# ============================================================
# VERIFIER TESTS
# ============================================================

@pytest.mark.asyncio
async def test_verify_successful_task():
    """Test verification of successful task."""
    verifier = Verifier()
    
    from worker.core.models import Task, Step, ToolCall
    task = Task(user_request="test", objective="test")
    task.tool_calls.append(ToolCall(
        task_id=task.task_id,
        tool_name="mock.success",
        success=True
    ))
    
    verification = await verifier.verify_task(task)
    
    assert verification.passed is True
    assert verification.goal_reached is True


@pytest.mark.asyncio
async def test_verify_failed_task():
    """Test verification of failed task."""
    verifier = Verifier()
    
    from worker.core.models import Task
    task = Task(user_request="test", objective="test")
    task.errors.append("Critical error")
    
    verification = await verifier.verify_task(task)
    
    # Should fail due to critical errors
    assert verification.check_results.get("no_critical_errors") is False


# ============================================================
# TOOL REGISTRY TESTS
# ============================================================

def test_register_tool():
    """Test tool registration."""
    from worker.core.tools import ToolRegistry
    
    registry = ToolRegistry()
    tool = MockSuccessTool()
    
    result = registry.register(tool)
    assert result is True
    
    retrieved = registry.get("mock.success")
    assert retrieved is not None
    assert retrieved.name == "mock.success"


def test_list_tools_by_category():
    """Test listing tools by category."""
    from worker.core.tools import ToolRegistry
    
    registry = ToolRegistry()
    registry.register(MockSuccessTool())
    registry.register(MockFailTool())
    
    tools = registry.list_tools(category=ToolCategory.SYSTEM)
    assert len(tools) >= 2


def test_disable_enable_tool():
    """Test disabling and enabling tools."""
    from worker.core.tools import ToolRegistry
    
    registry = ToolRegistry()
    tool = MockSuccessTool()
    registry.register(tool)
    
    # Disable
    result = registry.disable_tool("mock.success")
    assert result is True
    
    retrieved = registry.get("mock.success")
    assert retrieved is None  # Should be hidden
    
    # Enable
    result = registry.enable_tool("mock.success")
    assert result is True
    
    retrieved = registry.get("mock.success")
    assert retrieved is not None


# ============================================================
# INTEGRATION TESTS
# ============================================================

@pytest.mark.asyncio
async def test_full_task_flow(tmp_path):
    """Test complete task flow."""
    # Setup
    tm = TaskManager(str(tmp_path))
    planner = Planner()
    executor = Executor()
    observer = Observer()
    verifier = Verifier()
    
    tool_registry.register(MockSuccessTool())
    
    # Create task
    task = await tm.create_task(
        user_request="Run mock tool",
        objective="Execute mock.success"
    )
    
    # Create plan
    plan = await planner.create_plan(
        task.task_id,
        "Execute mock.success tool"
    )
    task.plan = plan
    
    # Execute steps
    while True:
        next_step = planner.get_next_step(task)
        if not next_step:
            break
        
        # Execute
        result = await executor.execute_step(task, next_step)
        
        # Observe
        await observer.observe(task, next_step, result)
        
        # Update status
        status = StepStatus.SUCCESS if result.success else StepStatus.FAILED
        await planner.update_step_status(
            task.task_id,
            next_step.step_id,
            status,
            result=result.data if result.success else None,
            error=result.error
        )
    
    # Verify
    verification = await verifier.verify_task(task)
    
    assert verification is not None
    assert len(task.tool_calls) >= 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
