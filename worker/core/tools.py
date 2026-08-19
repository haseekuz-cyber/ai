"""
Base Tool Interface and Registry.

Defines:
- BaseTool: Abstract base class for all tools
- ToolResult: Standardized tool execution result
- ToolRegistry: Dynamic registration and discovery of tools
"""

from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Type
import json
import uuid

from pydantic import BaseModel, Field

from .models import (
    Tool, ToolCategory, ToolSchema, RiskLevel,
    ToolCall, StepStatus
)


# ============================================================
# TOOL RESULT
# ============================================================

class ToolResult(BaseModel):
    """
    Standardized result from tool execution.
    
    All tools must return this structure.
    """
    success: bool
    data: Optional[Any] = None
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    error: Optional[str] = None
    artifacts: List[str] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    
    # Execution info
    duration_ms: Optional[int] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    
    def to_tool_call(self, task_id: str, tool_name: str, step_id: Optional[str] = None) -> ToolCall:
        """Convert to ToolCall for persistence."""
        return ToolCall(
            task_id=task_id,
            tool_name=tool_name,
            step_id=step_id,
            input_data={},  # Should be set by caller
            success=self.success,
            data=self.data,
            stdout=self.stdout,
            stderr=self.stderr,
            error=self.error,
            artifacts=self.artifacts,
            metadata=self.metadata,
            duration_ms=self.duration_ms
        )


# ============================================================
# BASE TOOL
# ============================================================

class BaseTool(ABC):
    """
    Abstract base class for all tools.
    
    Every tool must implement:
    - name, description, category
    - get_input_schema(), get_output_schema()
    - execute()
    - health_check()
    """
    
    # Class-level metadata (override in subclasses)
    name: str = "base_tool"
    description: str = "Base tool"
    category: ToolCategory = ToolCategory.SYSTEM
    permission_level: RiskLevel = RiskLevel.MEDIUM
    timeout: int = 60
    version: str = "1.0.0"
    
    def __init__(self):
        self._enabled = True
        self._health_status = True
        self._last_health_check: Optional[datetime] = None
    
    @property
    def enabled(self) -> bool:
        return self._enabled
    
    @enabled.setter
    def enabled(self, value: bool):
        self._enabled = value
    
    @property
    def health_status(self) -> bool:
        return self._health_status
    
    @abstractmethod
    def get_input_schema(self) -> ToolSchema:
        """Return JSON schema for tool input parameters."""
        pass
    
    @abstractmethod
    def get_output_schema(self) -> ToolSchema:
        """Return JSON schema for tool output."""
        pass
    
    @abstractmethod
    async def execute(self, **kwargs) -> ToolResult:
        """
        Execute the tool with given parameters.
        
        Args:
            **kwargs: Input parameters matching input_schema
            
        Returns:
            ToolResult with success status and data
        """
        pass
    
    async def health_check(self) -> bool:
        """
        Check if tool is healthy and available.
        
        Override for tools that need specific health checks.
        """
        self._last_health_check = datetime.now(timezone.utc)
        self._health_status = True
        return True
    
    def to_tool_definition(self) -> Tool:
        """Convert to Tool definition for registry."""
        return Tool(
            name=self.name,
            description=self.description,
            category=self.category,
            input_schema=self.get_input_schema(),
            output_schema=self.get_output_schema(),
            permission_level=self.permission_level,
            timeout=self.timeout,
            version=self.version,
            enabled=self.enabled,
            source=self.__class__.__module__,
            health_status=self.health_status,
            last_health_check=self._last_health_check
        )
    
    def validate_input(self, **kwargs) -> bool:
        """
        Validate input against schema.
        
        Basic validation - can be extended for complex schemas.
        """
        schema = self.get_input_schema()
        required = schema.required
        
        # Check required fields
        for field in required:
            if field not in kwargs:
                return False
        
        return True


# ============================================================
# TOOL REGISTRY
# ============================================================

class ToolRegistry:
    """
    Dynamic registry for tool discovery and management.
    
    Features:
    - Register/unregister tools
    - Get available tools by category
    - Schema validation
    - Health monitoring
    """
    
    def __init__(self):
        self._tools: Dict[str, BaseTool] = {}
        self._disabled_tools: set = set()
    
    def register(self, tool: BaseTool) -> bool:
        """
        Register a tool instance.
        
        Returns True if successful, False if tool already exists.
        """
        if tool.name in self._tools:
            return False
        
        self._tools[tool.name] = tool
        return True
    
    def unregister(self, tool_name: str) -> bool:
        """
        Unregister a tool by name.
        
        Returns True if tool was found and removed.
        """
        if tool_name in self._tools:
            del self._tools[tool_name]
            self._disabled_tools.discard(tool_name)
            return True
        return False
    
    def get(self, tool_name: str) -> Optional[BaseTool]:
        """Get a tool by name."""
        tool = self._tools.get(tool_name)
        if tool and tool_name in self._disabled_tools:
            return None
        return tool
    
    def list_tools(self, category: Optional[ToolCategory] = None) -> List[Tool]:
        """
        List all registered tools.
        
        Optionally filter by category.
        """
        tools = []
        for name, tool in self._tools.items():
            if name in self._disabled_tools:
                continue
            if category is None or tool.category == category:
                tools.append(tool.to_tool_definition())
        return tools
    
    def get_available_tools(self) -> Dict[str, Tool]:
        """Get dict of available tool definitions."""
        return {
            name: tool.to_tool_definition()
            for name, tool in self._tools.items()
            if name not in self._disabled_tools and tool.enabled
        }
    
    def disable_tool(self, tool_name: str) -> bool:
        """Temporarily disable a tool."""
        if tool_name in self._tools:
            self._disabled_tools.add(tool_name)
            return True
        return False
    
    def enable_tool(self, tool_name: str) -> bool:
        """Re-enable a disabled tool."""
        self._disabled_tools.discard(tool_name)
        if tool_name in self._tools:
            self._tools[tool_name].enabled = True
            return True
        return False
    
    async def health_check_all(self) -> Dict[str, bool]:
        """Run health checks on all tools."""
        results = {}
        for name, tool in self._tools.items():
            if name not in self._disabled_tools:
                results[name] = await tool.health_check()
        return results
    
    def validate_tool_input(self, tool_name: str, **kwargs) -> bool:
        """Validate input for a specific tool."""
        tool = self.get(tool_name)
        if not tool:
            return False
        return tool.validate_input(**kwargs)


# ============================================================
# GLOBAL REGISTRY INSTANCE
# ============================================================

tool_registry = ToolRegistry()


# ============================================================
# DECORATOR FOR TOOL REGISTRATION
# ============================================================

def register_tool(cls: Type[BaseTool]) -> Type[BaseTool]:
    """
    Decorator to automatically register a tool class.
    
    Usage:
        @register_tool
        class MyTool(BaseTool):
            name = "my_tool"
            ...
    """
    instance = cls()
    tool_registry.register(instance)
    return cls
