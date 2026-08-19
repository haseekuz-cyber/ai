"""
Episodic Memory - Long-term storage of completed task experiences.

Stores:
- Task outcomes (success/failure)
- Plans that were executed
- Errors encountered and resolutions
- Artifacts produced
- Patterns for future retrieval

Used for learning from past experiences and avoiding repeated mistakes.
"""

from typing import Any, Optional
from datetime import datetime, timezone

from .store import MemoryStore


class EpisodicMemory:
    """
    Episodic memory manager for storing and retrieving task experiences.
    
    Provides semantic search capabilities to find similar past tasks
    and their outcomes.
    """

    def __init__(self, memory_store: MemoryStore):
        """
        Initialize episodic memory.
        
        Args:
            memory_store: Central memory store instance
        """
        self._store = memory_store

    def store_task_result(
        self,
        task_id: str,
        user_request: str,
        objective: str,
        plan_summary: str,
        result_summary: str,
        success: bool,
        errors: list[str] = None,
        artifacts: list[str] = None,
        tags: list[str] = None,
    ) -> str:
        """
        Store the result of a completed task.
        
        Args:
            task_id: Unique task identifier
            user_request: Original user request
            objective: Task objective
            plan_summary: Summary of the executed plan
            result_summary: Summary of the result
            success: Whether the task succeeded
            errors: List of errors encountered
            artifacts: List of artifact file paths
            tags: Tags for categorization
            
        Returns:
            Record ID
        """
        record = {
            "task_id": task_id,
            "user_request": user_request,
            "objective": objective,
            "plan_summary": plan_summary,
            "result_summary": result_summary,
            "success": success,
            "errors": errors or [],
            "artifacts": artifacts or [],
            "tags": tags or [],
        }
        
        return self._store.episodic_store(record)

    def find_by_task_id(self, task_id: str) -> Optional[dict[str, Any]]:
        """
        Find episodic memory by task ID.
        
        Args:
            task_id: Task ID to search for
            
        Returns:
            Task record or None if not found
        """
        return self._store.episodic_find_by_task(task_id)

    def find_similar_tasks(
        self, 
        query: str, 
        limit: int = 5
    ) -> list[dict[str, Any]]:
        """
        Find similar past tasks based on keyword search.
        
        Searches in user requests, objectives, and result summaries.
        
        Args:
            query: Search query string
            limit: Maximum number of results
            
        Returns:
            List of similar task records
        """
        return self._store.episodic_find_similar(query, limit)

    def get_recent_tasks(self, limit: int = 10) -> list[dict[str, Any]]:
        """
        Get most recently completed tasks.
        
        Args:
            limit: Maximum number of tasks to return
            
        Returns:
            List of recent task records
        """
        return self._store.episodic_get_recent(limit)

    def get_successful_patterns(self, task_type: str) -> list[dict[str, Any]]:
        """
        Get successful task patterns for a specific type.
        
        Args:
            task_type: Type of task (e.g., "fix_bug", "create_file")
            
        Returns:
            List of successful task records
        """
        # Search for successful tasks matching the type
        results = self.find_similar_tasks(task_type, limit=20)
        return [r for r in results if r.get("success", False)]

    def get_common_errors(self, task_type: str) -> list[dict[str, Any]]:
        """
        Get common errors for a specific task type.
        
        Args:
            task_type: Type of task
            
        Returns:
            List of error records with frequency
        """
        results = self.find_similar_tasks(task_type, limit=50)
        error_counts: dict[str, int] = {}
        
        for record in results:
            errors = record.get("errors", [])
            for error in errors:
                error_counts[error] = error_counts.get(error, 0) + 1
        
        # Sort by frequency
        sorted_errors = sorted(
            error_counts.items(), 
            key=lambda x: x[1], 
            reverse=True
        )
        
        return [{"error": err, "count": cnt} for err, cnt in sorted_errors[:10]]

    def extract_lesson(self, task_record: dict[str, Any]) -> dict[str, Any]:
        """
        Extract a lesson learned from a task record.
        
        Args:
            task_record: Task record to analyze
            
        Returns:
            Lesson dictionary with pattern and recommendation
        """
        lesson = {
            "task_type": task_record.get("objective", "unknown"),
            "success": task_record.get("success", False),
            "pattern": task_record.get("plan_summary", ""),
            "outcome": task_record.get("result_summary", ""),
        }
        
        if not lesson["success"]:
            errors = task_record.get("errors", [])
            lesson["warnings"] = errors
            lesson["recommendation"] = "Avoid the approach that led to these errors"
        else:
            lesson["recommendation"] = "This approach worked well, consider reusing"
        
        return lesson

    def get_lessons_for_task(self, query: str, limit: int = 3) -> list[dict[str, Any]]:
        """
        Get lessons learned from similar past tasks.
        
        Args:
            query: Current task description
            limit: Maximum number of lessons to return
            
        Returns:
            List of lesson dictionaries
        """
        similar_tasks = self.find_similar_tasks(query, limit=limit * 2)
        lessons = []
        
        for task in similar_tasks:
            lesson = self.extract_lesson(task)
            lessons.append(lesson)
        
        return lessons[:limit]

    def count_tasks(self) -> dict[str, int]:
        """
        Get statistics about stored tasks.
        
        Returns:
            Dictionary with task counts
        """
        recent = self.get_recent_tasks(limit=1000)
        
        total = len(recent)
        successful = sum(1 for t in recent if t.get("success", False))
        failed = total - successful
        
        return {
            "total": total,
            "successful": successful,
            "failed": failed,
            "success_rate": successful / total if total > 0 else 0.0,
        }

    def export_task_history(self, task_ids: list[str] = None) -> list[dict[str, Any]]:
        """
        Export task history for backup or analysis.
        
        Args:
            task_ids: Optional list of specific task IDs to export
            
        Returns:
            List of task records
        """
        if task_ids:
            records = []
            for tid in task_ids:
                record = self.find_by_task_id(tid)
                if record:
                    records.append(record)
            return records
        else:
            return self.get_recent_tasks(limit=1000)

    def cleanup_old_tasks(self, days: int = 90) -> int:
        """
        Remove task records older than specified days.
        
        Note: This is a simple implementation. In production,
        you might want to archive instead of delete.
        
        Args:
            days: Age threshold in days
            
        Returns:
            Number of tasks removed (always 0 in current implementation
            as we don't have direct delete access through store)
        """
        # For now, just return 0 as we keep all history
        # Could be enhanced with actual cleanup logic
        return 0
