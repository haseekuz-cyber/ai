"""
Tests for Phase 4: Memory System

Tests all memory components:
- MemoryStore (SQLite persistence)
- WorkingMemory (ephemeral context)
- EpisodicMemory (task history)
- SemanticMemory (knowledge base)
- ToolMemory (usage statistics)
"""

import pytest
import os
import tempfile
from pathlib import Path

from worker.memory.store import MemoryStore, MemoryRecord
from worker.memory.working import WorkingMemory
from worker.memory.episodic import EpisodicMemory
from worker.memory.semantic import SemanticMemory
from worker.memory.tool_memory import ToolMemory


@pytest.fixture
def temp_db():
    """Create a temporary database for testing."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test_worker.db")
        yield db_path


@pytest.fixture
def memory_store(temp_db):
    """Create a MemoryStore instance."""
    return MemoryStore(db_path=temp_db)


@pytest.fixture
def working_memory():
    """Create a WorkingMemory instance."""
    return WorkingMemory(ttl_seconds=3600)


@pytest.fixture
def episodic_memory(memory_store):
    """Create an EpisodicMemory instance."""
    return EpisodicMemory(memory_store)


@pytest.fixture
def semantic_memory(memory_store):
    """Create a SemanticMemory instance."""
    return SemanticMemory(memory_store)


@pytest.fixture
def tool_memory(memory_store):
    """Create a ToolMemory instance."""
    return ToolMemory(memory_store)


# ==================== MemoryStore Tests ====================

class TestMemoryStore:
    """Tests for MemoryStore class."""

    def test_init_creates_database(self, temp_db):
        """Test that initialization creates the database file."""
        store = MemoryStore(db_path=temp_db)
        assert Path(temp_db).exists()

    def test_working_memory_set_get(self, memory_store):
        """Test working memory set and get operations."""
        memory_store.working_set("task1", "key1", "value1")
        assert memory_store.working_get("task1", "key1") == "value1"

    def test_working_memory_get_default(self, memory_store):
        """Test working memory get with default value."""
        result = memory_store.working_get("task1", "nonexistent", "default")
        assert result == "default"

    def test_working_memory_clear(self, memory_store):
        """Test clearing working memory for a task."""
        memory_store.working_set("task1", "key1", "value1")
        memory_store.working_clear("task1")
        assert memory_store.working_get("task1", "key1") is None

    def test_episodic_store_and_retrieve(self, memory_store):
        """Test storing and retrieving episodic memory."""
        record = {
            "task_id": "task123",
            "user_request": "Fix the bug",
            "objective": "Resolve import error",
            "success": True,
        }
        
        record_id = memory_store.episodic_store(record)
        assert record_id is not None
        
        retrieved = memory_store.episodic_find_by_task("task123")
        assert retrieved is not None
        assert retrieved["task_id"] == "task123"

    def test_semantic_store_and_retrieve(self, memory_store):
        """Test storing and retrieving semantic memory."""
        record_id = memory_store.semantic_store(
            category="project",
            key="my_project",
            value={"path": "/workspace/my_project", "type": "python"},
        )
        
        assert record_id is not None
        
        retrieved = memory_store.semantic_get("project", "my_project")
        assert retrieved is not None
        assert retrieved["path"] == "/workspace/my_project"

    def test_tool_record_usage(self, memory_store):
        """Test recording tool usage."""
        memory_store.tool_record_usage("files.read", True, 0.5)
        memory_store.tool_record_usage("files.read", False, 1.2, error="File not found")
        
        stats = memory_store.tool_get_stats("files.read")
        assert stats is not None
        assert stats["total_calls"] == 2
        assert stats["successful_calls"] == 1
        assert stats["failed_calls"] == 1

    def test_audit_log(self, memory_store):
        """Test audit logging."""
        log_id = memory_store.audit_log(
            action="tool.execute",
            task_id="task123",
            tool_name="files.read",
            success=True,
        )
        
        assert log_id is not None
        
        entries = memory_store.audit_get_entries(task_id="task123")
        assert len(entries) > 0
        assert entries[0]["tool_name"] == "files.read"


# ==================== WorkingMemory Tests ====================

class TestWorkingMemory:
    """Tests for WorkingMemory class."""

    def test_set_and_get_context(self, working_memory):
        """Test setting and getting context values."""
        working_memory.set_context("task1", "file", "main.py")
        assert working_memory.get_context("task1", "file") == "main.py"

    def test_get_all_context(self, working_memory):
        """Test getting all context for a task."""
        working_memory.set_context("task1", "key1", "value1")
        working_memory.set_context("task1", "key2", "value2")
        
        context = working_memory.get_all_context("task1")
        assert len(context) == 2
        assert context["key1"] == "value1"
        assert context["key2"] == "value2"

    def test_update_context(self, working_memory):
        """Test updating multiple context values."""
        working_memory.set_context("task1", "existing", "old_value")
        
        working_memory.update_context("task1", {
            "new_key": "new_value",
            "existing": "updated_value",
        })
        
        assert working_memory.get_context("task1", "new_key") == "new_value"
        assert working_memory.get_context("task1", "existing") == "updated_value"

    def test_clear_task(self, working_memory):
        """Test clearing all context for a task."""
        working_memory.set_context("task1", "key1", "value1")
        working_memory.clear_task("task1")
        
        assert working_memory.get_all_context("task1") == {}

    def test_observation_buffer(self, working_memory):
        """Test observation buffer functionality."""
        for i in range(15):
            working_memory.set_observation_buffer(
                "task1",
                {"step": i, "result": f"result_{i}"},
                max_size=10,
            )
        
        buffer = working_memory.get_observation_buffer("task1")
        assert len(buffer) == 10  # Should keep only last 10
        assert buffer[0]["step"] == 5  # First should be step 5

    def test_active_processes_tracking(self, working_memory):
        """Test tracking active processes."""
        working_memory.add_active_process("task1", {"pid": 1234, "name": "python"})
        working_memory.add_active_process("task1", {"pid": 5678, "name": "node"})
        
        processes = working_memory.get_active_processes("task1")
        assert len(processes) == 2
        
        working_memory.remove_active_process("task1", 1234)
        processes = working_memory.get_active_processes("task1")
        assert len(processes) == 1
        assert processes[0]["pid"] == 5678


# ==================== EpisodicMemory Tests ====================

class TestEpisodicMemory:
    """Tests for EpisodicMemory class."""

    def test_store_task_result(self, episodic_memory):
        """Test storing task result."""
        record_id = episodic_memory.store_task_result(
            task_id="task123",
            user_request="Fix import error",
            objective="Resolve missing module",
            plan_summary="Install missing package",
            result_summary="Package installed successfully",
            success=True,
        )
        
        assert record_id is not None

    def test_find_similar_tasks(self, episodic_memory):
        """Test finding similar tasks."""
        # Store some tasks
        episodic_memory.store_task_result(
            task_id="task1",
            user_request="Fix Python import error",
            objective="Install missing package",
            plan_summary="pip install package",
            result_summary="Success",
            success=True,
        )
        
        episodic_memory.store_task_result(
            task_id="task2",
            user_request="Fix Node.js require error",
            objective="Install missing module",
            plan_summary="npm install package",
            result_summary="Success",
            success=True,
        )
        
        # Search for similar tasks
        similar = episodic_memory.find_similar_tasks("Python import", limit=5)
        assert len(similar) > 0
        assert any("Python" in t.get("user_request", "") for t in similar)

    def test_get_lessons_for_task(self, episodic_memory):
        """Test extracting lessons from past tasks."""
        episodic_memory.store_task_result(
            task_id="task1",
            user_request="Fix syntax error",
            objective="Correct Python syntax",
            plan_summary="Review and fix code",
            result_summary="Fixed missing colon",
            success=True,
        )
        
        lessons = episodic_memory.get_lessons_for_task("syntax error", limit=3)
        assert len(lessons) > 0
        assert "recommendation" in lessons[0]

    def test_count_tasks(self, episodic_memory):
        """Test counting stored tasks."""
        episodic_memory.store_task_result(
            task_id="task1",
            user_request="Task 1",
            objective="Objective 1",
            plan_summary="Plan 1",
            result_summary="Result 1",
            success=True,
        )
        
        episodic_memory.store_task_result(
            task_id="task2",
            user_request="Task 2",
            objective="Objective 2",
            plan_summary="Plan 2",
            result_summary="Result 2",
            success=False,
        )
        
        counts = episodic_memory.count_tasks()
        assert counts["total"] >= 2
        assert counts["successful"] >= 1


# ==================== SemanticMemory Tests ====================

class TestSemanticMemory:
    """Tests for SemanticMemory class."""

    def test_store_project_info(self, semantic_memory):
        """Test storing project information."""
        record_id = semantic_memory.store_project_info(
            project_name="test_project",
            info={
                "path": "/workspace/test_project",
                "type": "python",
                "dependencies": ["pytest", "pydantic"],
            },
        )
        
        assert record_id is not None
        
        retrieved = semantic_memory.get_project_info("test_project")
        assert retrieved is not None
        assert retrieved["type"] == "python"

    def test_store_user_preference(self, semantic_memory):
        """Test storing user preferences."""
        semantic_memory.store_user_preference(
            key="default_editor",
            value="vscode",
        )
        
        pref = semantic_memory.get_user_preference("default_editor")
        assert pref == "vscode"

    def test_search_projects(self, semantic_memory):
        """Test searching projects."""
        semantic_memory.store_project_info(
            project_name="web_app",
            info={"type": "web", "framework": "react"},
        )
        
        semantic_memory.store_project_info(
            project_name="api_service",
            info={"type": "api", "framework": "fastapi"},
        )
        
        results = semantic_memory.search_projects("web", limit=5)
        assert len(results) > 0
        assert any("web_app" in r.get("key", "") for r in results)

    def test_store_and_get_workflow(self, semantic_memory):
        """Test storing and retrieving workflows."""
        workflow = {
            "steps": ["analyze", "plan", "execute", "verify"],
            "timeout": 300,
        }
        
        semantic_memory.store_workflow(
            workflow_name="standard_task",
            workflow=workflow,
        )
        
        retrieved = semantic_memory.get_workflow("standard_task")
        assert retrieved is not None
        assert len(retrieved["steps"]) == 4


# ==================== ToolMemory Tests ====================

class TestToolMemory:
    """Tests for ToolMemory class."""

    def test_record_usage(self, tool_memory):
        """Test recording tool usage."""
        tool_memory.record_usage("files.read", True, 0.5)
        tool_memory.record_usage("files.read", True, 0.3)
        tool_memory.record_usage("files.read", False, 1.0, error="Permission denied")
        
        stats = tool_memory.get_stats("files.read")
        assert stats["total_calls"] == 3
        assert stats["successful_calls"] == 2
        assert stats["failed_calls"] == 1

    def test_get_success_rate(self, tool_memory):
        """Test calculating success rate."""
        for _ in range(8):
            tool_memory.record_usage("test_tool", True, 0.5)
        for _ in range(2):
            tool_memory.record_usage("test_tool", False, 1.0)
        
        rate = tool_memory.get_success_rate("test_tool")
        assert abs(rate - 0.8) < 0.01

    def test_get_common_errors(self, tool_memory):
        """Test retrieving common errors."""
        errors = ["File not found", "Permission denied", "File not found"]
        
        for error in errors:
            tool_memory.record_usage("files.read", False, 1.0, error=error)
        
        common = tool_memory.get_common_errors("files.read", limit=5)
        assert "File not found" in common

    def test_is_tool_healthy(self, tool_memory):
        """Test tool health check."""
        # Record successful calls
        for _ in range(10):
            tool_memory.record_usage("healthy_tool", True, 0.5)
        
        assert tool_memory.is_tool_healthy("healthy_tool") is True
        
        # Record failing calls
        for _ in range(10):
            tool_memory.record_usage("unhealthy_tool", False, 1.0)
        
        assert tool_memory.is_tool_healthy("unhealthy_tool", min_success_rate=0.8) is False

    def test_get_tool_report(self, tool_memory):
        """Test generating tool report."""
        for _ in range(20):
            tool_memory.record_usage("report_tool", True, 0.5)
        
        report = tool_memory.get_tool_report("report_tool")
        
        assert report["tool_name"] == "report_tool"
        assert report["status"] == "active"
        assert "health" in report
        assert report["total_calls"] == 20


# ==================== Integration Tests ====================

class TestMemorySystemIntegration:
    """Integration tests for the complete memory system."""

    def test_full_task_lifecycle(self, memory_store, working_memory, episodic_memory):
        """Test complete task lifecycle with all memory types."""
        task_id = "integration_task_1"
        
        # Working memory: store current state
        working_memory.set_context(task_id, "current_step", "analyzing")
        working_memory.set_context(task_id, "active_file", "main.py")
        
        # Simulate task execution
        memory_store.tool_record_usage("files.read", True, 0.3)
        memory_store.tool_record_usage("terminal.run", True, 2.5)
        
        # Audit log actions
        memory_store.audit_log(
            action="task.started",
            task_id=task_id,
            actor="worker",
        )
        
        memory_store.audit_log(
            action="task.completed",
            task_id=task_id,
            actor="worker",
            success=True,
        )
        
        # Episodic memory: store result
        episodic_memory.store_task_result(
            task_id=task_id,
            user_request="Test integration",
            objective="Verify memory system works together",
            plan_summary="Use all memory types",
            result_summary="All components functioning",
            success=True,
            artifacts=["/tmp/result.txt"],
        )
        
        # Verify everything was stored
        assert working_memory.get_context(task_id, "current_step") == "analyzing"
        
        audit_entries = memory_store.audit_get_entries(task_id=task_id)
        assert len(audit_entries) >= 2
        
        retrieved = episodic_memory.find_by_task_id(task_id)
        assert retrieved is not None
        assert bool(retrieved["success"]) is True  # SQLite BOOLEAN returns 1/0

    def test_memory_persistence_across_instances(self, temp_db):
        """Test that memory persists across different instances."""
        # First instance: store data
        store1 = MemoryStore(db_path=temp_db)
        store1.semantic_store("test", "key1", {"value": "data1"})
        store1.episodic_store({
            "task_id": "persist_test",
            "user_request": "Test persistence",
            "success": True,
        })
        
        # Second instance: retrieve data
        store2 = MemoryStore(db_path=temp_db)
        
        semantic_data = store2.semantic_get("test", "key1")
        assert semantic_data is not None
        assert semantic_data["value"] == "data1"
        
        episodic_data = store2.episodic_find_by_task("persist_test")
        assert episodic_data is not None
        assert bool(episodic_data["success"]) is True  # SQLite BOOLEAN returns 1/0
