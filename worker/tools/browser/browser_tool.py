"""
Browser Tool - Playwright-based browser automation for WORKER.

This tool provides browser automation capabilities through Playwright,
following the WORKER Tool Interface specification.

Priority order (as per MASTER PROMPT):
1. DOM/Playwright API (primary)
2. Vision + Mouse control (fallback when direct control unavailable)

The Worker Core does NOT directly depend on Playwright - 
this tool is registered dynamically via Tool Registry.
"""

import asyncio
import base64
import logging
from pathlib import Path
from typing import Any, Optional
from datetime import datetime, timezone

try:
    from playwright.async_api import async_playwright, Browser, BrowserContext, Page
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False
    async_playwright = None
    Browser = None
    BrowserContext = None
    Page = None

from worker.core.tools import BaseTool, ToolResult, ToolSchema
from worker.core.models import RiskLevel

logger = logging.getLogger(__name__)


class BrowserManager:
    """
    Singleton-like manager for browser instances.
    
    Prevents unnecessary browser restarts and maintains context across tool calls.
    """
    
    _instance: Optional['BrowserManager'] = None
    _playwright = None
    _browser: Optional[Browser] = None
    _context: Optional[BrowserContext] = None
    _page: Optional[Page] = None
    _initialized = False
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    @classmethod
    async def initialize(cls):
        """Initialize Playwright and browser instance."""
        if not PLAYWRIGHT_AVAILABLE:
            raise RuntimeError("Playwright is not installed. Run: pip install playwright && playwright install")
        
        if cls._initialized and cls._playwright is not None:
            return
        
        cls._playwright = await async_playwright().start()
        cls._initialized = True
        logger.info("Playwright initialized")
    
    @classmethod
    async def get_browser(cls, headless: bool = True) -> Browser:
        """Get or create browser instance."""
        if not cls._initialized:
            await cls.initialize()
        
        if cls._browser is None or not cls._browser.is_connected():
            cls._browser = await cls._playwright.chromium.launch(
                headless=headless,
                args=[
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                ]
            )
            logger.info("Browser launched")
        
        return cls._browser
    
    @classmethod
    async def get_context(cls, headless: bool = True) -> BrowserContext:
        """Get or create browser context."""
        browser = await cls.get_browser(headless=headless)
        
        if cls._context is None:
            cls._context = await browser.new_context(
                viewport={'width': 1920, 'height': 1080},
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            )
            logger.info("Browser context created")
        
        return cls._context
    
    @classmethod
    async def get_page(cls, headless: bool = True) -> Page:
        """Get or create page instance."""
        context = await cls.get_context(headless=headless)
        
        if cls._page is None or cls._page.is_closed():
            cls._page = await context.new_page()
            logger.info("New page created")
        
        return cls._page
    
    @classmethod
    async def navigate(cls, url: str, timeout: int = 30000) -> Page:
        """Navigate to URL."""
        page = await cls.get_page()
        await page.goto(url, timeout=timeout, wait_until='domcontentloaded')
        logger.info(f"Navigated to: {url}")
        return page
    
    @classmethod
    async def close(cls):
        """Close all browser resources."""
        if cls._page and not cls._page.is_closed():
            await cls._page.close()
            cls._page = None
        
        if cls._context:
            await cls._context.close()
            cls._context = None
        
        if cls._browser and cls._browser.is_connected():
            await cls._browser.close()
            cls._browser = None
        
        if cls._playwright:
            await cls._playwright.stop()
            cls._playwright = None
            cls._initialized = False
        
        logger.info("Browser resources closed")
    
    @classmethod
    def is_available(cls) -> bool:
        """Check if browser is available."""
        return PLAYWRIGHT_AVAILABLE


class BrowserTool(BaseTool):
    """
    Browser automation tool using Playwright.
    
    Provides DOM-based interaction as primary method,
    with vision/mouse fallback capabilities.
    """
    
    name = "browser"
    description = "Browser automation using Playwright for web interaction"
    category = "browser"
    permission_level = RiskLevel.MEDIUM
    timeout = 60
    
    def __init__(self):
        super().__init__()
        self.manager = BrowserManager()
    
    def get_input_schema(self) -> ToolSchema:
        """Return JSON schema for tool input parameters."""
        return ToolSchema(
            type="object",
            properties={
                "action": {
                    "type": "string",
                    "enum": [
                        "open", "close", "navigate", "click", "type", "press",
                        "read", "screenshot", "wait", "evaluate", "hover",
                        "select", "check", "uncheck", "focus", "blur",
                        "go_back", "go_forward", "refresh", "get_url", "get_title",
                        "find_element", "count_elements", "element_exists"
                    ],
                    "description": "Action to perform"
                },
                "url": {
                    "type": "string",
                    "description": "URL to navigate to (for open/navigate actions)"
                },
                "selector": {
                    "type": "string",
                    "description": "CSS selector for element targeting"
                },
                "text": {
                    "type": "string",
                    "description": "Text to type or search for"
                },
                "key": {
                    "type": "string",
                    "description": "Key to press (e.g., 'Enter', 'Ctrl+S')"
                },
                "attribute": {
                    "type": "string",
                    "description": "Attribute to read (e.g., 'textContent', 'value', 'href')"
                },
                "timeout": {
                    "type": "integer",
                    "description": "Timeout in milliseconds",
                    "default": 30000
                },
                "headless": {
                    "type": "boolean",
                    "description": "Run browser in headless mode",
                    "default": True
                },
                "wait_for": {
                    "type": "string",
                    "description": "Selector or condition to wait for"
                },
                "value": {
                    "type": "string",
                    "description": "Value to set for select/checkbox"
                },
                "script": {
                    "type": "string",
                    "description": "JavaScript to evaluate"
                }
            },
            required=["action"],
            additionalProperties=False
        )
    
    def get_output_schema(self) -> ToolSchema:
        """Return JSON schema for tool output."""
        return ToolSchema(
            name=self.name,
            description=self.description,
            input_schema={},
            output_schema={
                "type": "object",
                "properties": {
                    "success": {"type": "boolean"},
                    "data": {"type": "object"},
                    "url": {"type": "string"},
                    "title": {"type": "string"},
                    "content": {"type": "string"},
                    "screenshot": {"type": "string", "format": "base64"},
                    "element_count": {"type": "integer"},
                    "exists": {"type": "boolean"},
                    "error": {"type": "string"}
                }
            },
            permission_level=self.permission_level,
            timeout=self.timeout
        )
    
    async def health_check(self) -> bool:
        """Check if browser tool is functional."""
        if not PLAYWRIGHT_AVAILABLE:
            logger.warning("Playwright not installed")
            return False
        
        try:
            await self.manager.initialize()
            page = await self.manager.get_page(headless=True)
            await page.goto('about:blank', timeout=5000)
            return True
        except Exception as e:
            logger.error(f"Browser health check failed: {e}")
            return False
    
    async def execute(self, **kwargs) -> ToolResult:
        """Execute browser action."""
        action = kwargs.get('action')
        
        if not action:
            return ToolResult(
                success=False,
                error="Action is required"
            )
        
        try:
            method_name = f"_action_{action}"
            method = getattr(self, method_name, None)
            
            if not method:
                return ToolResult(
                    success=False,
                    error=f"Unknown action: {action}"
                )
            
            result = await method(**kwargs)
            return ToolResult(
                success=True,
                data=result,
                metadata={
                    "action": action,
                    "timestamp": datetime.now(timezone.utc).isoformat()
                }
            )
        
        except Exception as e:
            logger.error(f"Browser action '{action}' failed: {e}", exc_info=True)
            return ToolResult(
                success=False,
                error=str(e),
                metadata={"action": action}
            )
    
    async def _action_open(self, **kwargs) -> dict:
        """Open browser and navigate to URL."""
        url = kwargs.get('url', 'about:blank')
        headless = kwargs.get('headless', True)
        timeout = kwargs.get('timeout', 30000)
        
        await self.manager.initialize()
        page = await self.manager.get_page(headless=headless)
        await page.goto(url, timeout=timeout, wait_until='domcontentloaded')
        
        return {
            "url": page.url,
            "title": await page.title()
        }
    
    async def _action_close(self, **kwargs) -> dict:
        """Close browser and cleanup resources."""
        await self.manager.close()
        return {"closed": True}
    
    async def _action_navigate(self, **kwargs) -> dict:
        """Navigate to URL."""
        url = kwargs.get('url')
        timeout = kwargs.get('timeout', 30000)
        wait_for = kwargs.get('wait_for')
        
        if not url:
            raise ValueError("URL is required for navigate action")
        
        page = await self.manager.get_page()
        await page.goto(url, timeout=timeout, wait_until='domcontentloaded')
        
        if wait_for:
            await page.wait_for_selector(wait_for, timeout=timeout)
        
        return {
            "url": page.url,
            "title": await page.title()
        }
    
    async def _action_click(self, **kwargs) -> dict:
        """Click element by selector."""
        selector = kwargs.get('selector')
        timeout = kwargs.get('timeout', 30000)
        
        if not selector:
            raise ValueError("Selector is required for click action")
        
        page = await self.manager.get_page()
        await page.click(selector, timeout=timeout)
        
        return {
            "clicked": selector,
            "url": page.url
        }
    
    async def _action_type(self, **kwargs) -> dict:
        """Type text into element."""
        selector = kwargs.get('selector')
        text = kwargs.get('text', '')
        timeout = kwargs.get('timeout', 30000)
        
        if not selector:
            raise ValueError("Selector is required for type action")
        
        page = await self.manager.get_page()
        await page.fill(selector, text, timeout=timeout)
        
        return {
            "typed": selector,
            "text_length": len(text)
        }
    
    async def _action_press(self, **kwargs) -> dict:
        """Press key."""
        key = kwargs.get('key')
        selector = kwargs.get('selector')
        timeout = kwargs.get('timeout', 30000)
        
        if not key:
            raise ValueError("Key is required for press action")
        
        page = await self.manager.get_page()
        
        if selector:
            await page.press(selector, key, timeout=timeout)
        else:
            await page.keyboard.press(key)
        
        return {
            "pressed": key,
            "selector": selector
        }
    
    async def _action_read(self, **kwargs) -> dict:
        """Read content from page or element."""
        selector = kwargs.get('selector')
        attribute = kwargs.get('attribute', 'textContent')
        timeout = kwargs.get('timeout', 30000)
        
        page = await self.manager.get_page()
        
        if selector:
            element = await page.query_selector(selector)
            if not element:
                return {
                    "found": False,
                    "selector": selector
                }
            
            if attribute == 'textContent':
                content = await element.text_content()
            elif attribute == 'innerHTML':
                content = await element.inner_html()
            elif attribute == 'value':
                content = await element.get_attribute('value')
            else:
                content = await element.get_attribute(attribute)
            
            return {
                "found": True,
                "selector": selector,
                "attribute": attribute,
                "content": content.strip() if content else None
            }
        else:
            # Read entire page content
            content = await page.content()
            title = await page.title()
            
            return {
                "url": page.url,
                "title": title,
                "content_length": len(content)
            }
    
    async def _action_screenshot(self, **kwargs) -> dict:
        """Take screenshot of page or element."""
        selector = kwargs.get('selector')
        full_page = kwargs.get('full_page', True)
        timeout = kwargs.get('timeout', 30000)
        
        page = await self.manager.get_page()
        
        if selector:
            element = await page.query_selector(selector)
            if element:
                screenshot = await element.screenshot(timeout=timeout)
            else:
                return {
                    "found": False,
                    "selector": selector
                }
        else:
            screenshot = await page.screenshot(full_page=full_page)
        
        # Encode as base64 for transport
        screenshot_b64 = base64.b64encode(screenshot).decode('utf-8')
        
        return {
            "screenshot": screenshot_b64,
            "format": "png",
            "size_bytes": len(screenshot)
        }
    
    async def _action_wait(self, **kwargs) -> dict:
        """Wait for selector or time."""
        selector = kwargs.get('selector')
        timeout = kwargs.get('timeout', 30000)
        time_ms = kwargs.get('time')
        
        page = await self.manager.get_page()
        
        if selector:
            await page.wait_for_selector(selector, timeout=timeout)
            return {
                "waited_for": selector,
                "found": True
            }
        elif time_ms:
            await asyncio.sleep(time_ms / 1000)
            return {
                "waited_ms": time_ms
            }
        
        return {"waited": True}
    
    async def _action_evaluate(self, **kwargs) -> dict:
        """Execute JavaScript in page context."""
        script = kwargs.get('script')
        
        if not script:
            raise ValueError("Script is required for evaluate action")
        
        page = await self.manager.get_page()
        result = await page.evaluate(script)
        
        return {
            "result": result
        }
    
    async def _action_hover(self, **kwargs) -> dict:
        """Hover over element."""
        selector = kwargs.get('selector')
        timeout = kwargs.get('timeout', 30000)
        
        if not selector:
            raise ValueError("Selector is required for hover action")
        
        page = await self.manager.get_page()
        await page.hover(selector, timeout=timeout)
        
        return {
            "hovered": selector
        }
    
    async def _action_select(self, **kwargs) -> dict:
        """Select option in dropdown."""
        selector = kwargs.get('selector')
        value = kwargs.get('value')
        timeout = kwargs.get('timeout', 30000)
        
        if not selector or not value:
            raise ValueError("Selector and value are required for select action")
        
        page = await self.manager.get_page()
        await page.select_option(selector, value, timeout=timeout)
        
        return {
            "selected": selector,
            "value": value
        }
    
    async def _action_check(self, **kwargs) -> dict:
        """Check checkbox."""
        selector = kwargs.get('selector')
        timeout = kwargs.get('timeout', 30000)
        
        if not selector:
            raise ValueError("Selector is required for check action")
        
        page = await self.manager.get_page()
        await page.check(selector, timeout=timeout)
        
        return {
            "checked": selector
        }
    
    async def _action_uncheck(self, **kwargs) -> dict:
        """Uncheck checkbox."""
        selector = kwargs.get('selector')
        timeout = kwargs.get('timeout', 30000)
        
        if not selector:
            raise ValueError("Selector is required for uncheck action")
        
        page = await self.manager.get_page()
        await page.uncheck(selector, timeout=timeout)
        
        return {
            "unchecked": selector
        }
    
    async def _action_focus(self, **kwargs) -> dict:
        """Focus element."""
        selector = kwargs.get('selector')
        timeout = kwargs.get('timeout', 30000)
        
        if not selector:
            raise ValueError("Selector is required for focus action")
        
        page = await self.manager.get_page()
        await page.focus(selector, timeout=timeout)
        
        return {
            "focused": selector
        }
    
    async def _action_blur(self, **kwargs) -> dict:
        """Blur focused element."""
        selector = kwargs.get('selector')
        timeout = kwargs.get('timeout', 30000)
        
        page = await self.manager.get_page()
        
        if selector:
            await page.blur(selector, timeout=timeout)
        else:
            # Blur currently focused element
            await page.evaluate('document.activeElement.blur()')
        
        return {
            "blurred": selector or "active_element"
        }
    
    async def _action_go_back(self, **kwargs) -> dict:
        """Go back in history."""
        timeout = kwargs.get('timeout', 30000)
        
        page = await self.manager.get_page()
        await page.go_back(timeout=timeout)
        
        return {
            "url": page.url,
            "title": await page.title()
        }
    
    async def _action_go_forward(self, **kwargs) -> dict:
        """Go forward in history."""
        timeout = kwargs.get('timeout', 30000)
        
        page = await self.manager.get_page()
        await page.go_forward(timeout=timeout)
        
        return {
            "url": page.url,
            "title": await page.title()
        }
    
    async def _action_refresh(self, **kwargs) -> dict:
        """Refresh page."""
        timeout = kwargs.get('timeout', 30000)
        wait_until = kwargs.get('wait_until', 'domcontentloaded')
        
        page = await self.manager.get_page()
        await page.reload(timeout=timeout, wait_until=wait_until)
        
        return {
            "url": page.url,
            "title": await page.title()
        }
    
    async def _action_get_url(self, **kwargs) -> dict:
        """Get current URL."""
        page = await self.manager.get_page()
        return {
            "url": page.url
        }
    
    async def _action_get_title(self, **kwargs) -> dict:
        """Get page title."""
        page = await self.manager.get_page()
        return {
            "title": await page.title()
        }
    
    async def _action_find_element(self, **kwargs) -> dict:
        """Find element by selector."""
        selector = kwargs.get('selector')
        timeout = kwargs.get('timeout', 30000)
        
        if not selector:
            raise ValueError("Selector is required for find_element action")
        
        page = await self.manager.get_page()
        element = await page.query_selector(selector, timeout=timeout)
        
        if element:
            bounding_box = await element.bounding_box()
            return {
                "found": True,
                "selector": selector,
                "bounding_box": bounding_box
            }
        else:
            return {
                "found": False,
                "selector": selector
            }
    
    async def _action_count_elements(self, **kwargs) -> dict:
        """Count elements matching selector."""
        selector = kwargs.get('selector')
        timeout = kwargs.get('timeout', 30000)
        
        if not selector:
            raise ValueError("Selector is required for count_elements action")
        
        page = await self.manager.get_page()
        elements = await page.query_selector_all(selector, timeout=timeout)
        
        return {
            "selector": selector,
            "count": len(elements)
        }
    
    async def _action_element_exists(self, **kwargs) -> dict:
        """Check if element exists."""
        selector = kwargs.get('selector')
        timeout = kwargs.get('timeout', 30000)
        
        if not selector:
            raise ValueError("Selector is required for element_exists action")
        
        page = await self.manager.get_page()
        exists = await page.is_visible(selector, timeout=timeout)
        
        return {
            "selector": selector,
            "exists": exists
        }


# Export for registration
def register_tools(registry):
    """Register browser tools with the registry."""
    if PLAYWRIGHT_AVAILABLE:
        registry.register(BrowserTool())
        logger.info("Browser tool registered")
    else:
        logger.warning("Browser tool skipped - Playwright not installed")


__all__ = ['BrowserTool', 'BrowserManager', 'register_tools', 'PLAYWRIGHT_AVAILABLE']
