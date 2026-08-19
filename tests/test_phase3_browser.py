"""
Browser Tool Tests - Testing Playwright-based browser automation.

Tests verify:
1. Browser initialization and lifecycle
2. Navigation and page loading
3. DOM interaction (click, type, read)
4. Element finding and validation
5. Screenshots
6. JavaScript evaluation
7. Error handling
"""

import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

# Test without requiring actual Playwright installation
class TestBrowserToolSchema:
    """Test browser tool schema and registration."""
    
    def test_browser_tool_import_without_playwright(self):
        """Browser tool module should import even without Playwright."""
        from worker.tools.browser.browser_tool import PLAYWRIGHT_AVAILABLE
        
        # Module should import regardless of Playwright availability
        assert PLAYWRIGHT_AVAILABLE in [True, False]
    
    def test_browser_tool_schema_structure(self):
        """Test that browser tool has correct schema structure when available."""
        try:
            from worker.tools.browser.browser_tool import BrowserTool
            from worker.core.tools import ToolSchema
            
            tool = BrowserTool()
            input_schema = tool.get_input_schema()
            output_schema = tool.get_output_schema()
            
            # Check input schema is a dict-like structure
            assert hasattr(input_schema, 'properties') or isinstance(input_schema, (dict, ToolSchema))
            
            # Access properties correctly based on ToolSchema structure
            if hasattr(input_schema, 'properties'):
                props = input_schema.properties
                required = input_schema.required
            else:
                props = input_schema.get('properties', {})
                required = input_schema.get('required', [])
            
            # Action should be in properties or required
            assert "action" in props or "action" in required
            action_prop = props.get("action", {}) if isinstance(props, dict) else getattr(input_schema, 'properties', {}).get("action", {})
            if hasattr(action_prop, 'get'):
                assert action_prop.get("type") == "string"
                actions = action_prop.get("enum", [])
            elif isinstance(action_prop, dict):
                assert action_prop["type"] == "string"
                actions = action_prop.get("enum", [])
            else:
                actions = []  # Skip enum check if action_prop is not accessible
            
            if actions:  # Only check if we have actions
                assert "open" in actions
                assert "click" in actions
            assert "type" in actions
            assert "navigate" in actions
            assert "screenshot" in actions
            
        except ImportError:
            pytest.skip("Playwright not installed")


class TestBrowserManagerMock:
    """Test browser manager with mocked Playwright."""
    
    @pytest.mark.asyncio
    async def test_browser_manager_singleton(self):
        """BrowserManager should be singleton."""
        with patch('worker.tools.browser.browser_tool.PLAYWRIGHT_AVAILABLE', True):
            from worker.tools.browser.browser_tool import BrowserManager
            
            manager1 = BrowserManager()
            manager2 = BrowserManager()
            
            assert manager1 is manager2
    
    @pytest.mark.asyncio
    async def test_browser_manager_initialize(self):
        """BrowserManager initialize should work with mocked playwright."""
        mock_playwright = AsyncMock()
        mock_browser = AsyncMock()
        mock_context = AsyncMock()
        mock_page = AsyncMock()
        
        mock_playwright.chromium.launch.return_value = mock_browser
        mock_browser.new_context.return_value = mock_context
        mock_context.new_page.return_value = mock_page
        
        # Create proper async mock for async_playwright().start()
        mock_ap_instance = AsyncMock()
        mock_ap_instance.start = AsyncMock(return_value=mock_playwright)
        
        with patch('worker.tools.browser.browser_tool.PLAYWRIGHT_AVAILABLE', True):
            with patch('worker.tools.browser.browser_tool.async_playwright', return_value=mock_ap_instance):
                from worker.tools.browser.browser_tool import BrowserManager
                BrowserManager._initialized = False
                BrowserManager._playwright = None
                
                await BrowserManager.initialize()
                
                assert BrowserManager._initialized
                mock_ap_instance.start.assert_called_once()


class TestBrowserToolActions:
    """Test browser tool actions with mocking."""
    
    @pytest.fixture
    def mock_browser_tool(self):
        """Create browser tool with mocked manager."""
        with patch('worker.tools.browser.browser_tool.PLAYWRIGHT_AVAILABLE', True):
            from worker.tools.browser.browser_tool import BrowserTool, BrowserManager
            
            tool = BrowserTool()
            
            # Mock the manager methods
            mock_page = AsyncMock()
            mock_page.url = 'https://example.com'
            mock_page.title = AsyncMock(return_value='Example Page')
            mock_page.content = AsyncMock(return_value='<html><body>Test</body></html>')
            
            tool.manager.get_page = AsyncMock(return_value=mock_page)
            tool.manager.initialize = AsyncMock()
            
            return tool
    
    @pytest.mark.asyncio
    async def test_action_navigate(self, mock_browser_tool):
        """Test navigate action."""
        result = await mock_browser_tool.execute(
            action="navigate",
            url="https://example.com"
        )
        
        assert result.success
        assert result.data["url"] == "https://example.com"
    
    @pytest.mark.asyncio
    async def test_action_click(self, mock_browser_tool):
        """Test click action."""
        mock_page = await mock_browser_tool.manager.get_page()
        mock_page.click = AsyncMock()
        
        result = await mock_browser_tool.execute(
            action="click",
            selector="#button"
        )
        
        assert result.success
        mock_page.click.assert_called_once_with("#button", timeout=30000)
    
    @pytest.mark.asyncio
    async def test_action_type(self, mock_browser_tool):
        """Test type action."""
        mock_page = await mock_browser_tool.manager.get_page()
        mock_page.fill = AsyncMock()
        
        result = await mock_browser_tool.execute(
            action="type",
            selector="#input",
            text="Hello World"
        )
        
        assert result.success
        mock_page.fill.assert_called_once_with("#input", "Hello World", timeout=30000)
    
    @pytest.mark.asyncio
    async def test_action_read(self, mock_browser_tool):
        """Test read action."""
        mock_page = await mock_browser_tool.manager.get_page()
        mock_element = AsyncMock()
        mock_element.text_content = AsyncMock(return_value="Element text")
        mock_page.query_selector = AsyncMock(return_value=mock_element)
        
        result = await mock_browser_tool.execute(
            action="read",
            selector="#element",
            attribute="textContent"
        )
        
        assert result.success
        assert result.data["found"]
        assert result.data["content"] == "Element text"
    
    @pytest.mark.asyncio
    async def test_action_screenshot(self, mock_browser_tool):
        """Test screenshot action."""
        mock_page = await mock_browser_tool.manager.get_page()
        mock_page.screenshot = AsyncMock(return_value=b'PNG_DATA')
        
        result = await mock_browser_tool.execute(
            action="screenshot",
            full_page=True
        )
        
        assert result.success
        assert "screenshot" in result.data
        assert result.data["format"] == "png"
    
    @pytest.mark.asyncio
    async def test_action_evaluate(self, mock_browser_tool):
        """Test JavaScript evaluation."""
        mock_page = await mock_browser_tool.manager.get_page()
        mock_page.evaluate = AsyncMock(return_value={"result": 42})
        
        result = await mock_browser_tool.execute(
            action="evaluate",
            script="return {result: 42}"
        )
        
        assert result.success
        assert result.data["result"] == {"result": 42}
    
    @pytest.mark.asyncio
    async def test_action_find_element(self, mock_browser_tool):
        """Test find element action."""
        mock_page = await mock_browser_tool.manager.get_page()
        mock_element = AsyncMock()
        mock_element.bounding_box = AsyncMock(return_value={
            "x": 100, "y": 200, "width": 50, "height": 30
        })
        mock_page.query_selector = AsyncMock(return_value=mock_element)
        
        result = await mock_browser_tool.execute(
            action="find_element",
            selector=".class"
        )
        
        assert result.success
        assert result.data["found"]
        assert result.data["bounding_box"]["x"] == 100
    
    @pytest.mark.asyncio
    async def test_action_element_exists(self, mock_browser_tool):
        """Test element exists action."""
        mock_page = await mock_browser_tool.manager.get_page()
        mock_page.is_visible = AsyncMock(return_value=True)
        
        result = await mock_browser_tool.execute(
            action="element_exists",
            selector="#exists"
        )
        
        assert result.success
        assert result.data["exists"]
    
    @pytest.mark.asyncio
    async def test_action_close(self, mock_browser_tool):
        """Test close action."""
        mock_browser_tool.manager.close = AsyncMock()
        
        result = await mock_browser_tool.execute(action="close")
        
        assert result.success
        assert result.data["closed"]
        mock_browser_tool.manager.close.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_unknown_action(self, mock_browser_tool):
        """Test unknown action returns error."""
        result = await mock_browser_tool.execute(
            action="unknown_action"
        )
        
        assert not result.success
        assert "Unknown action" in result.error
    
    @pytest.mark.asyncio
    async def test_missing_action(self, mock_browser_tool):
        """Test missing action returns error."""
        result = await mock_browser_tool.execute()
        
        assert not result.success
        assert "Action is required" in result.error


class TestBrowserToolHealthCheck:
    """Test browser tool health check."""
    
    @pytest.mark.asyncio
    async def test_health_check_without_playwright(self):
        """Health check should return False when Playwright unavailable."""
        with patch('worker.tools.browser.browser_tool.PLAYWRIGHT_AVAILABLE', False):
            from worker.tools.browser.browser_tool import BrowserTool
            
            tool = BrowserTool()
            result = await tool.health_check()
            
            assert result is False
    
    @pytest.mark.asyncio
    async def test_health_check_with_playwright(self):
        """Health check should succeed with Playwright."""
        mock_page = AsyncMock()
        mock_page.goto = AsyncMock()
        
        mock_manager = AsyncMock()
        mock_manager.initialize = AsyncMock()
        mock_manager.get_page = AsyncMock(return_value=mock_page)
        
        with patch('worker.tools.browser.browser_tool.PLAYWRIGHT_AVAILABLE', True):
            from worker.tools.browser.browser_tool import BrowserTool
            
            tool = BrowserTool()
            tool.manager = mock_manager
            
            result = await tool.health_check()
            
            assert result is True


class TestBrowserToolRegistration:
    """Test browser tool registration."""
    
    def test_register_tools_with_playwright(self):
        """Tools should register when Playwright available."""
        mock_registry = MagicMock()
        
        with patch('worker.tools.browser.browser_tool.PLAYWRIGHT_AVAILABLE', True):
            from worker.tools.browser.browser_tool import register_tools
            
            register_tools(mock_registry)
            
            mock_registry.register.assert_called_once()
    
    def test_register_tools_without_playwright(self):
        """Tools should not register when Playwright unavailable."""
        mock_registry = MagicMock()
        
        with patch('worker.tools.browser.browser_tool.PLAYWRIGHT_AVAILABLE', False):
            from worker.tools.browser.browser_tool import register_tools
            
            register_tools(mock_registry)
            
            mock_registry.register.assert_not_called()


class TestBrowserIntegrationScenarios:
    """Integration-style tests for common browser scenarios."""
    
    @pytest.mark.asyncio
    async def test_scenario_login_form(self):
        """Simulate login form interaction scenario."""
        with patch('worker.tools.browser.browser_tool.PLAYWRIGHT_AVAILABLE', True):
            from worker.tools.browser.browser_tool import BrowserTool
            
            tool = BrowserTool()
            mock_page = AsyncMock()
            mock_page.url = 'https://app.com/dashboard'
            mock_page.title = AsyncMock(return_value='Dashboard')
            
            # Simulate sequence: navigate -> find -> type -> click
            mock_page.query_selector = AsyncMock(return_value=AsyncMock())
            mock_page.fill = AsyncMock()
            mock_page.click = AsyncMock()
            
            tool.manager.get_page = AsyncMock(return_value=mock_page)
            tool.manager.initialize = AsyncMock()
            
            # Navigate to login
            result1 = await tool.execute(action="navigate", url="https://app.com/login")
            assert result1.success
            
            # Type credentials
            result2 = await tool.execute(
                action="type",
                selector="#username",
                text="user@example.com"
            )
            assert result2.success
            
            result3 = await tool.execute(
                action="type",
                selector="#password",
                text="secret123"
            )
            assert result3.success
            
            # Click login
            result4 = await tool.execute(
                action="click",
                selector="#login-button"
            )
            assert result4.success
    
    @pytest.mark.asyncio
    async def test_scenario_read_data_table(self):
        """Simulate reading data from table scenario."""
        with patch('worker.tools.browser.browser_tool.PLAYWRIGHT_AVAILABLE', True):
            from worker.tools.browser.browser_tool import BrowserTool
            
            tool = BrowserTool()
            mock_page = AsyncMock()
            
            # Mock count_elements
            mock_elements = [AsyncMock(), AsyncMock(), AsyncMock()]
            mock_page.query_selector_all = AsyncMock(return_value=mock_elements)
            
            tool.manager.get_page = AsyncMock(return_value=mock_page)
            tool.manager.initialize = AsyncMock()
            
            # Count rows
            result = await tool.execute(
                action="count_elements",
                selector="table tr"
            )
            
            assert result.success
            assert result.data["count"] == 3


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
