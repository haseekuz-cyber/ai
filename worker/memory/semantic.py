"""
Semantic Memory - Long-term knowledge storage about projects and environment.

Stores:
- Project structures and configurations
- Application information and adapters
- User preferences and rules
- Environment details
- Tool capabilities and limitations

Uses keyword search (BM25-style) for retrieval without heavy vector databases.
"""

from typing import Any, Optional

from .store import MemoryStore


class SemanticMemory:
    """
    Semantic memory manager for storing structured knowledge.
    
    Organized by categories for efficient retrieval.
    Supports keyword search within categories.
    """

    # Predefined categories
    CATEGORY_PROJECT = "project"
    CATEGORY_APPLICATION = "application"
    CATEGORY_USER_PREFS = "user_preferences"
    CATEGORY_ENVIRONMENT = "environment"
    CATEGORY_TOOL_KNOWLEDGE = "tool_knowledge"
    CATEGORY_WORKFLOWS = "workflows"

    def __init__(self, memory_store: MemoryStore):
        """
        Initialize semantic memory.
        
        Args:
            memory_store: Central memory store instance
        """
        self._store = memory_store

    def store_project_info(
        self,
        project_name: str,
        info: dict[str, Any],
        tags: list[str] = None,
    ) -> str:
        """
        Store information about a project.
        
        Args:
            project_name: Name of the project
            info: Project information (structure, tech stack, etc.)
            tags: Optional tags for categorization
            
        Returns:
            Record ID
        """
        return self._store.semantic_store(
            category=self.CATEGORY_PROJECT,
            key=project_name,
            value=info,
            tags=tags,
        )

    def get_project_info(self, project_name: str) -> Optional[dict[str, Any]]:
        """
        Get information about a project.
        
        Args:
            project_name: Name of the project
            
        Returns:
            Project information or None if not found
        """
        return self._store.semantic_get(self.CATEGORY_PROJECT, project_name)

    def store_application_adapter(
        self,
        app_name: str,
        adapter_info: dict[str, Any],
        tags: list[str] = None,
    ) -> str:
        """
        Store application adapter information.
        
        Args:
            app_name: Application name
            adapter_info: Adapter configuration and capabilities
            tags: Optional tags
            
        Returns:
            Record ID
        """
        return self._store.semantic_store(
            category=self.CATEGORY_APPLICATION,
            key=app_name,
            value=adapter_info,
            tags=tags,
        )

    def get_application_adapter(self, app_name: str) -> Optional[dict[str, Any]]:
        """
        Get application adapter information.
        
        Args:
            app_name: Application name
            
        Returns:
            Adapter information or None if not found
        """
        return self._store.semantic_get(self.CATEGORY_APPLICATION, app_name)

    def store_user_preference(
        self,
        key: str,
        value: Any,
        tags: list[str] = None,
    ) -> str:
        """
        Store a user preference.
        
        Args:
            key: Preference key
            value: Preference value
            tags: Optional tags
            
        Returns:
            Record ID
        """
        return self._store.semantic_store(
            category=self.CATEGORY_USER_PREFS,
            key=key,
            value=value,
            tags=tags,
        )

    def get_user_preference(
        self, 
        key: str, 
        default: Any = None
    ) -> Any:
        """
        Get a user preference.
        
        Args:
            key: Preference key
            default: Default value if not found
            
        Returns:
            Preference value or default
        """
        result = self._store.semantic_get(self.CATEGORY_USER_PREFS, key)
        return result if result is not None else default

    def store_environment_info(
        self,
        key: str,
        info: dict[str, Any],
        tags: list[str] = None,
    ) -> str:
        """
        Store environment information.
        
        Args:
            key: Environment info key (e.g., "python_version", "os_info")
            info: Environment information
            tags: Optional tags
            
        Returns:
            Record ID
        """
        return self._store.semantic_store(
            category=self.CATEGORY_ENVIRONMENT,
            key=key,
            value=info,
            tags=tags,
        )

    def get_environment_info(self, key: str) -> Optional[dict[str, Any]]:
        """
        Get environment information.
        
        Args:
            key: Environment info key
            
        Returns:
            Environment information or None if not found
        """
        return self._store.semantic_get(self.CATEGORY_ENVIRONMENT, key)

    def store_tool_knowledge(
        self,
        tool_name: str,
        knowledge: dict[str, Any],
        tags: list[str] = None,
    ) -> str:
        """
        Store knowledge about a tool's capabilities and limitations.
        
        Args:
            tool_name: Tool name
            knowledge: Tool knowledge (capabilities, limitations, best practices)
            tags: Optional tags
            
        Returns:
            Record ID
        """
        return self._store.semantic_store(
            category=self.CATEGORY_TOOL_KNOWLEDGE,
            key=tool_name,
            value=knowledge,
            tags=tags,
        )

    def get_tool_knowledge(self, tool_name: str) -> Optional[dict[str, Any]]:
        """
        Get knowledge about a tool.
        
        Args:
            tool_name: Tool name
            
        Returns:
            Tool knowledge or None if not found
        """
        return self._store.semantic_get(self.CATEGORY_TOOL_KNOWLEDGE, tool_name)

    def store_workflow(
        self,
        workflow_name: str,
        workflow: dict[str, Any],
        tags: list[str] = None,
    ) -> str:
        """
        Store a workflow pattern.
        
        Args:
            workflow_name: Workflow name
            workflow: Workflow definition (steps, conditions, etc.)
            tags: Optional tags
            
        Returns:
            Record ID
        """
        return self._store.semantic_store(
            category=self.CATEGORY_WORKFLOWS,
            key=workflow_name,
            value=workflow,
            tags=tags,
        )

    def get_workflow(self, workflow_name: str) -> Optional[dict[str, Any]]:
        """
        Get a workflow pattern.
        
        Args:
            workflow_name: Workflow name
            
        Returns:
            Workflow definition or None if not found
        """
        return self._store.semantic_get(self.CATEGORY_WORKFLOWS, workflow_name)

    def search(
        self,
        category: Optional[str] = None,
        query: str = None,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        """
        Search semantic memory by category and/or keywords.
        
        Args:
            category: Category to search in (optional)
            query: Search query string
            limit: Maximum results to return
            
        Returns:
            List of matching records
        """
        results = self._store.semantic_search(category, query, limit)
        
        # Parse JSON values
        parsed_results = []
        for record in results:
            try:
                record["value"] = eval(record.get("value", "null"))
            except (SyntaxError, NameError):
                pass
            parsed_results.append(record)
        
        return parsed_results

    def search_projects(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        """
        Search projects by keyword.
        
        Args:
            query: Search query
            limit: Maximum results
            
        Returns:
            List of matching projects
        """
        return self.search(self.CATEGORY_PROJECT, query, limit)

    def search_applications(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        """
        Search applications by keyword.
        
        Args:
            query: Search query
            limit: Maximum results
            
        Returns:
            List of matching applications
        """
        return self.search(self.CATEGORY_APPLICATION, query, limit)

    def delete_category_key(self, category: str, key: str) -> bool:
        """
        Delete a specific key from a category.
        
        Args:
            category: Category name
            key: Key to delete
            
        Returns:
            True if deleted, False if not found
        """
        return self._store.semantic_delete(category, key)

    def get_all_categories(self) -> list[str]:
        """
        Get all unique categories in semantic memory.
        
        Returns:
            List of category names
        """
        all_records = self.search(limit=1000)
        categories = set()
        for record in all_records:
            cat = record.get("category")
            if cat:
                categories.add(cat)
        return sorted(list(categories))

    def count_by_category(self) -> dict[str, int]:
        """
        Get count of records per category.
        
        Returns:
            Dictionary mapping category to count
        """
        all_records = self.search(limit=1000)
        counts: dict[str, int] = {}
        
        for record in all_records:
            cat = record.get("category", "unknown")
            counts[cat] = counts.get(cat, 0) + 1
        
        return counts

    def export_category(self, category: str) -> list[dict[str, Any]]:
        """
        Export all records from a category.
        
        Args:
            category: Category to export
            
        Returns:
            List of records
        """
        return self.search(category, limit=1000)

    def import_records(
        self,
        records: list[dict[str, Any]],
        skip_existing: bool = True,
    ) -> int:
        """
        Import records into semantic memory.
        
        Args:
            records: List of records to import
            skip_existing: If True, skip existing keys
            
        Returns:
            Number of records imported
        """
        imported = 0
        
        for record in records:
            category = record.get("category")
            key = record.get("key")
            value = record.get("value")
            tags = record.get("tags", [])
            
            if not all([category, key, value is not None]):
                continue
            
            if skip_existing:
                existing = self._store.semantic_get(category, key)
                if existing is not None:
                    continue
            
            self._store.semantic_store(category, key, value, tags)
            imported += 1
        
        return imported
