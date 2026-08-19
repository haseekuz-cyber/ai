"""
Unit tests for core models.
"""

import pytest
from datetime import datetime
from worker.core.models import (
    Task, TaskState, Step, StepStatus, Plan,
    Tool, ToolCategory, ToolSchema, RiskLevel,
    ToolCall, Observation, Verification,
    PermissionRequest, Artifact, MemoryType, MemoryRecord
)


class TestTask:
    """Test Task model."""
    
    def test_create_task(self):
        """Test basic task creation."""
        task = Task(
            user_request="Fix the bug in app.py",
            objective="Identify and fix the error in the application"
        )
        
        assert task.task_id is not None
        assert task.user_request == "Fix the bug in app.py"
        assert task.objective == "Identify and fix the error in the application"
        assert task.current_state == TaskState.CREATED
        assert task.retries == 0
        assert task.cancelled is False
    
    def test_task_state_transitions(self):
        """Test task state changes."""
        task = Task(user_request="test", objective="test obj")
        
        assert task.current_state == TaskState.CREATED
        
        task.current_state = TaskState.ANALYZING
        assert task.current_state == TaskState.ANALYZING
        
        task.current_state = TaskState.PLANNING
        assert task.current_state == TaskState.PLANNING
        
        task.current_state = TaskState.COMPLETED
        assert task.current_state == TaskState.COMPLETED
    
    def test_task_serialization(self):
        """Test task can be serialized to dict."""
        task = Task(user_request="test", objective="test obj")
        
        data = task.model_dump()
        
        assert 'task_id' in data
        assert 'user_request' in data
        assert 'current_state' in data
        assert data['user_request'] == "test"


class TestStep:
    """Test Step model."""
    
    def test_create_step(self):
        """Test basic step creation."""
        step = Step(
            description="Read package.json",
            action="files.read",
            parameters={"path": "package.json"}
        )
        
        assert step.step_id is not None
        assert step.status == StepStatus.PENDING
        assert step.action == "files.read"
        assert step.parameters["path"] == "package.json"
    
    def test_step_with_dependencies(self):
        """Test step with dependencies."""
        step1 = Step(description="Step 1", action="action1")
        step2 = Step(
            description="Step 2",
            action="action2",
            dependencies=[step1.step_id]
        )
        
        assert len(step2.dependencies) == 1
        assert step2.dependencies[0] == step1.step_id


class TestPlan:
    """Test Plan model."""
    
    def test_create_plan(self):
        """Test basic plan creation."""
        plan = Plan(
            task_id="task-123",
            objective="Fix the application",
            steps=[
                Step(description="Read files", action="files.read"),
                Step(description="Run tests", action="terminal.run"),
            ]
        )
        
        assert plan.plan_id is not None
        assert plan.task_id == "task-123"
        assert len(plan.steps) == 2
    
    def test_plan_get_next_step(self):
        """Test getting next pending step."""
        step1 = Step(description="Step 1", action="action1")
        step2 = Step(description="Step 2", action="action2")
        step3 = Step(description="Step 3", action="action3")
        
        plan = Plan(
            task_id="task-123",
            objective="Test",
            steps=[step1, step2, step3]
        )
        
        # First step should be next
        next_step = plan.get_next_step()
        assert next_step == step1
        
        # Mark first as success
        step1.status = StepStatus.SUCCESS
        next_step = plan.get_next_step()
        assert next_step == step2
    
    def test_plan_with_dependencies(self):
        """Test plan respects step dependencies."""
        step1 = Step(description="Step 1", action="action1")
        step2 = Step(
            description="Step 2",
            action="action2",
            dependencies=[step1.step_id]
        )
        
        plan = Plan(
            task_id="task-123",
            objective="Test",
            steps=[step1, step2]
        )
        
        # step2 depends on step1, so step1 should be next
        next_step = plan.get_next_step()
        assert next_step == step1


class TestTool:
    """Test Tool model."""
    
    def test_create_tool(self):
        """Test tool definition creation."""
        tool = Tool(
            name="files.read",
            description="Read a file from disk",
            category=ToolCategory.FILESYSTEM,
            input_schema=ToolSchema(
                type="object",
                properties={"path": {"type": "string"}},
                required=["path"]
            ),
            output_schema=ToolSchema(
                type="object",
                properties={"content": {"type": "string"}}
            ),
            permission_level=RiskLevel.LOW
        )
        
        assert tool.name == "files.read"
        assert tool.category == ToolCategory.FILESYSTEM
        assert tool.permission_level == RiskLevel.LOW
        assert tool.enabled is True


class TestObservation:
    """Test Observation model."""
    
    def test_create_observation(self):
        """Test observation creation."""
        obs = Observation(
            task_id="task-123",
            what_changed="File was modified",
            confidence=0.95
        )
        
        assert obs.observation_id is not None
        assert obs.what_changed == "File was modified"
        assert obs.confidence == 0.95


class TestVerification:
    """Test Verification model."""
    
    def test_verification_passed(self):
        """Test successful verification."""
        verif = Verification(
            task_id="task-123",
            passed=True,
            goal_reached=True,
            checks_performed=["file_exists", "content_valid"],
            check_results={
                "file_exists": True,
                "content_valid": True
            }
        )
        
        assert verif.passed is True
        assert verif.goal_reached is True
        assert len(verif.checks_performed) == 2
    
    def test_verification_failed(self):
        """Test failed verification."""
        verif = Verification(
            task_id="task-123",
            passed=False,
            goal_reached=False,
            message="File not found"
        )
        
        assert verif.passed is False
        assert verif.message == "File not found"


class TestPermissionRequest:
    """Test PermissionRequest model."""
    
    def test_permission_request_creation(self):
        """Test permission request creation."""
        req = PermissionRequest(
            task_id="task-123",
            tool_name="files.delete",
            action="Delete temporary files",
            risk_level=RiskLevel.HIGH,
            reason="Cleanup after build",
            potential_impact="Data loss if wrong files deleted"
        )
        
        assert req.risk_level == RiskLevel.HIGH
        assert req.status == "pending"
        assert req.responded_at is None


class TestMemoryRecord:
    """Test MemoryRecord model."""
    
    def test_memory_record_creation(self):
        """Test memory record creation."""
        record = MemoryRecord(
            memory_type=MemoryType.EPISODIC,
            task_id="task-123",
            key="previous_error",
            value="ModuleNotFoundError: No module named 'pydantic'",
            tags=["error", "dependency"]
        )
        
        assert record.memory_type == MemoryType.EPISODIC
        assert record.key == "previous_error"
        assert "error" in record.tags


class TestArtifact:
    """Test Artifact model."""
    
    def test_artifact_creation(self):
        """Test artifact creation."""
        artifact = Artifact(
            task_id="task-123",
            name="fixed_app.py",
            type="file",
            path="/workspace/src/app.py",
            size_bytes=1024
        )
        
        assert artifact.artifact_id is not None
        assert artifact.type == "file"
        assert artifact.size_bytes == 1024
