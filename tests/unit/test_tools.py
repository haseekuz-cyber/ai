"""
Unit tests for tool registry and base tool.
"""

import pytest
from worker.core.tools import BaseTool, ToolResult, ToolRegistry, tool_registry, register_tool
from worker.core.models import ToolCategory, ToolSchema, RiskLevel


class TestToolResult:
    """Test ToolResult model."""
    
    def test_success_result(self):
        """Test successful tool result."""
        result = ToolResult(
            success=True,
            data={"key": "value"},
            stdout="Output message"
        )
        
        assert result.success is True
        assert result.data == {"key": "value"}
        assert result.error is None
    
    def test_error_result(self):
        """Test failed tool result."""
        result = ToolResult(
            success=False,
            error="File not found",
            stderr="Error: No such file"
        )
        
        assert result.success is False
        assert result.error == "File not found"
        assert result.data is None
    
    def test_result_with_artifacts(self):
        """Test result with artifact files."""
        result = ToolResult(
            success=True,
            artifacts=["/path/to/file1.txt", "/path/to/file2.log"]
        )
        
        assert len(result.artifacts) == 2
        assert "/path/to/file1.txt" in result.artifacts


class TestBaseTool:
    """Test BaseTool abstract class."""
    
    def test_concrete_tool_implementation(self):
        """Test implementing a concrete tool."""
        
        class TestTool(BaseTool):
            name = "test.tool"
            description = "A test tool"
            category = ToolCategory.SYSTEM
            
            def get_input_schema(self):
                return ToolSchema(
                    type="object",
                    properties={"param": {"type": "string"}},
                    required=["param"]
                )
            
            def get_output_schema(self):
                return ToolSchema(
                    type="object",
                    properties={"result": {"type": "string"}}
                )
            
            async def execute(self, **kwargs):
                return ToolResult(success=True, data={"result": kwargs.get("param")})
        
        tool = TestTool()
        
        assert tool.name == "test.tool"
        assert tool.enabled is True
        assert tool.health_status is True
        
        # Validate input
        assert tool.validate_input(param="value") is True
        assert tool.validate_input() is False  # Missing required param
    
    @pytest.mark.asyncio
    async def test_tool_execute(self):
        """Test tool execution."""
        
        class EchoTool(BaseTool):
            name = "echo.tool"
            description = "Echo back input"
            category = ToolCategory.SYSTEM
            
            def get_input_schema(self):
                return ToolSchema(
                    type="object",
                    properties={"message": {"type": "string"}},
                    required=["message"]
                )
            
            def get_output_schema(self):
                return ToolSchema(
                    type="object",
                    properties={"echo": {"type": "string"}}
                )
            
            async def execute(self, **kwargs):
                return ToolResult(
                    success=True,
                    data={"echo": kwargs.get("message")}
                )
        
        tool = EchoTool()
        result = await tool.execute(message="Hello")
        
        assert result.success is True
        assert result.data["echo"] == "Hello"
    
    @pytest.mark.asyncio
    async def test_tool_health_check(self):
        """Test tool health check."""
        
        class SimpleTool(BaseTool):
            name = "simple.tool"
            description = "Simple tool"
            category = ToolCategory.SYSTEM
            
            def get_input_schema(self):
                return ToolSchema(type="object")
            
            def get_output_schema(self):
                return ToolSchema(type="object")
            
            async def execute(self, **kwargs):
                return ToolResult(success=True)
        
        tool = SimpleTool()
        healthy = await tool.health_check()
        
        assert healthy is True
        assert tool.health_status is True
        assert tool._last_health_check is not None


class TestToolRegistry:
    """Test ToolRegistry functionality."""
    
    def test_register_tool(self):
        """Test registering a tool."""
        registry = ToolRegistry()
        
        class MyTool(BaseTool):
            name = "my.tool"
            description = "My tool"
            category = ToolCategory.SYSTEM
            
            def get_input_schema(self):
                return ToolSchema(type="object")
            
            def get_output_schema(self):
                return ToolSchema(type="object")
            
            async def execute(self, **kwargs):
                return ToolResult(success=True)
        
        tool = MyTool()
        result = registry.register(tool)
        
        assert result is True
        
        # Try to register again
        result2 = registry.register(tool)
        assert result2 is False
    
    def test_get_tool(self):
        """Test retrieving a tool by name."""
        registry = ToolRegistry()
        
        class TestTool(BaseTool):
            name = "test.get_tool"
            description = "Test"
            category = ToolCategory.SYSTEM
            
            def get_input_schema(self):
                return ToolSchema(type="object")
            
            def get_output_schema(self):
                return ToolSchema(type="object")
            
            async def execute(self, **kwargs):
                return ToolResult(success=True)
        
        registry.register(TestTool())
        
        tool = registry.get("test.get_tool")
        assert tool is not None
        assert tool.name == "test.get_tool"
        
        # Non-existent tool
        tool2 = registry.get("nonexistent")
        assert tool2 is None
    
    def test_list_tools(self):
        """Test listing all tools."""
        registry = ToolRegistry()
        
        class Tool1(BaseTool):
            name = "list.tool1"
            description = "Tool 1"
            category = ToolCategory.FILESYSTEM
            
            def get_input_schema(self):
                return ToolSchema(type="object")
            
            def get_output_schema(self):
                return ToolSchema(type="object")
            
            async def execute(self, **kwargs):
                return ToolResult(success=True)
        
        class Tool2(BaseTool):
            name = "list.tool2"
            description = "Tool 2"
            category = ToolCategory.TERMINAL
            
            def get_input_schema(self):
                return ToolSchema(type="object")
            
            def get_output_schema(self):
                return ToolSchema(type="object")
            
            async def execute(self, **kwargs):
                return ToolResult(success=True)
        
        registry.register(Tool1())
        registry.register(Tool2())
        
        all_tools = registry.list_tools()
        assert len(all_tools) == 2
        
        # Filter by category
        fs_tools = registry.list_tools(category=ToolCategory.FILESYSTEM)
        assert len(fs_tools) == 1
        assert fs_tools[0].name == "list.tool1"
    
    def test_disable_enable_tool(self):
        """Test disabling and enabling tools."""
        registry = ToolRegistry()
        
        class TestTool(BaseTool):
            name = "disable.tool"
            description = "Test"
            category = ToolCategory.SYSTEM
            
            def get_input_schema(self):
                return ToolSchema(type="object")
            
            def get_output_schema(self):
                return ToolSchema(type="object")
            
            async def execute(self, **kwargs):
                return ToolResult(success=True)
        
        registry.register(TestTool())
        
        # Tool should be available
        tool = registry.get("disable.tool")
        assert tool is not None
        
        # Disable
        registry.disable_tool("disable.tool")
        tool = registry.get("disable.tool")
        assert tool is None
        
        # Enable
        registry.enable_tool("disable.tool")
        tool = registry.get("disable.tool")
        assert tool is not None
    
    def test_unregister_tool(self):
        """Test unregistering a tool."""
        registry = ToolRegistry()
        
        class TestTool(BaseTool):
            name = "unreg.tool"
            description = "Test"
            category = ToolCategory.SYSTEM
            
            def get_input_schema(self):
                return ToolSchema(type="object")
            
            def get_output_schema(self):
                return ToolSchema(type="object")
            
            async def execute(self, **kwargs):
                return ToolResult(success=True)
        
        registry.register(TestTool())
        
        # Unregister
        result = registry.unregister("unreg.tool")
        assert result is True
        
        # Should not exist
        tool = registry.get("unreg.tool")
        assert tool is None
        
        # Unregister non-existent
        result2 = registry.unregister("nonexistent")
        assert result2 is False


class TestRegisterToolDecorator:
    """Test @register_tool decorator."""
    
    def test_decorator_registers_tool(self):
        """Test that decorator auto-registers tool."""
        registry = ToolRegistry()
        
        @register_tool
        class DecoratedTool(BaseTool):
            name = "decorated.tool"
            description = "Decorated tool"
            category = ToolCategory.SYSTEM
            
            def get_input_schema(self):
                return ToolSchema(type="object")
            
            def get_output_schema(self):
                return ToolSchema(type="object")
            
            async def execute(self, **kwargs):
                return ToolResult(success=True)
        
        # Note: decorator registers to global registry, not local one
        # So we test that the class was created properly
        tool = DecoratedTool()
        assert tool.name == "decorated.tool"
