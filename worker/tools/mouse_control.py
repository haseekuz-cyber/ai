"""
Mouse Control Module - WORKER Phase 2

Provides mouse control capabilities:
- Mouse movement (absolute and relative)
- Click operations (left, right, middle, double-click)
- Drag and drop operations
- Scroll operations
- Position tracking
"""

import time
from pathlib import Path
from typing import Optional, Dict, Any, Tuple
from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, Field

# Try to import platform-specific libraries
try:
    import pyautogui
    PYAUTOGUI_AVAILABLE = True
    # Safety settings
    pyautogui.FAILSAFE = True  # Move mouse to corner to abort
    pyautogui.PAUSE = 0.1  # Small pause between actions
except ImportError:
    PYAUTOGUI_AVAILABLE = False


class MouseButton(Enum):
    """Mouse button types"""
    LEFT = "left"
    RIGHT = "right"
    MIDDLE = "middle"


class MouseResult(BaseModel):
    """Result of a mouse operation"""
    success: bool = Field(..., description="Operation success")
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    action: str = Field(..., description="Action performed")
    position: Optional[Tuple[int, int]] = Field(None, description="Mouse position after action")
    button: Optional[str] = Field(None, description="Button used if applicable")
    error: Optional[str] = Field(None, description="Error message if failed")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional metadata")


class MouseControlTool:
    """
    Mouse control tool for WORKER
    
    Capabilities:
    - Move mouse to absolute/relative positions
    - Click operations
    - Double-click
    - Drag and drop
    - Scroll
    - Get current position
    """
    
    def __init__(self):
        """Initialize mouse control tool"""
        self._last_positions: list = []
        self._operation_history: list = []
        
    def get_position(self) -> Tuple[int, int]:
        """
        Get current mouse cursor position
        
        Returns:
            Tuple of (x, y) coordinates
        """
        if not PYAUTOGUI_AVAILABLE:
            # Mock position for testing
            return (960, 540)  # Center of 1920x1080
        
        try:
            x, y = pyautogui.position()
            return (x, y)
        except Exception:
            return (960, 540)
    
    def move_to(
        self,
        x: int,
        y: int,
        duration: float = 0.5
    ) -> MouseResult:
        """
        Move mouse to absolute position
        
        Args:
            x: Target X coordinate
            y: Target Y coordinate
            duration: Movement duration in seconds (0 for instant)
            
        Returns:
            MouseResult with operation status
        """
        try:
            if not PYAUTOGUI_AVAILABLE:
                self._last_positions.append((x, y))
                return MouseResult(
                    success=True,
                    action="move_to",
                    position=(x, y),
                    metadata={"mock": True, "duration": duration}
                )
            
            pyautogui.moveTo(x, y, duration=duration)
            
            pos = self.get_position()
            self._last_positions.append(pos)
            
            return MouseResult(
                success=True,
                action="move_to",
                position=pos,
                metadata={"duration": duration}
            )
            
        except Exception as e:
            return MouseResult(
                success=False,
                action="move_to",
                error=str(e)
            )
    
    def move_relative(
        self,
        dx: int,
        dy: int,
        duration: float = 0.5
    ) -> MouseResult:
        """
        Move mouse relative to current position
        
        Args:
            dx: Horizontal offset
            dy: Vertical offset
            duration: Movement duration in seconds
            
        Returns:
            MouseResult with operation status
        """
        try:
            current_x, current_y = self.get_position()
            target_x = current_x + dx
            target_y = current_y + dy
            
            return self.move_to(target_x, target_y, duration)
            
        except Exception as e:
            return MouseResult(
                success=False,
                action="move_relative",
                error=str(e)
            )
    
    def click(
        self,
        x: Optional[int] = None,
        y: Optional[int] = None,
        button: MouseButton = MouseButton.LEFT,
        clicks: int = 1,
        interval: float = 0.1
    ) -> MouseResult:
        """
        Perform mouse click
        
        Args:
            x: X coordinate (None = current position)
            y: Y coordinate (None = current position)
            button: Mouse button to click
            clicks: Number of clicks
            interval: Interval between clicks (for multiple clicks)
            
        Returns:
            MouseResult with operation status
        """
        try:
            if not PYAUTOGUI_AVAILABLE:
                pos = (x, y) if x is not None and y is not None else self.get_position()
                self._last_positions.append(pos)
                return MouseResult(
                    success=True,
                    action=f"click_{button.value}",
                    position=pos,
                    button=button.value,
                    metadata={"mock": True, "clicks": clicks}
                )
            
            # Move to position if specified
            if x is not None and y is not None:
                pyautogui.moveTo(x, y, duration=0.1)
            
            # Perform click(s)
            pyautogui.click(
                clicks=clicks,
                interval=interval,
                button=button.value
            )
            
            pos = self.get_position()
            self._last_positions.append(pos)
            
            return MouseResult(
                success=True,
                action=f"click_{button.value}",
                position=pos,
                button=button.value,
                metadata={"clicks": clicks}
            )
            
        except Exception as e:
            return MouseResult(
                success=False,
                action=f"click_{button.value}",
                error=str(e)
            )
    
    def double_click(
        self,
        x: Optional[int] = None,
        y: Optional[int] = None
    ) -> MouseResult:
        """
        Perform double-click
        
        Args:
            x: X coordinate (None = current position)
            y: Y coordinate (None = current position)
            
        Returns:
            MouseResult with operation status
        """
        return self.click(x, y, MouseButton.LEFT, clicks=2)
    
    def right_click(
        self,
        x: Optional[int] = None,
        y: Optional[int] = None
    ) -> MouseResult:
        """
        Perform right-click
        
        Args:
            x: X coordinate (None = current position)
            y: Y coordinate (None = current position)
            
        Returns:
            MouseResult with operation status
        """
        return self.click(x, y, MouseButton.RIGHT, clicks=1)
    
    def drag_to(
        self,
        x: int,
        y: int,
        duration: float = 0.5,
        button: MouseButton = MouseButton.LEFT
    ) -> MouseResult:
        """
        Drag mouse to position (press and hold while moving)
        
        Args:
            x: Target X coordinate
            y: Target Y coordinate
            duration: Movement duration
            button: Button to hold during drag
            
        Returns:
            MouseResult with operation status
        """
        try:
            if not PYAUTOGUI_AVAILABLE:
                self._last_positions.append((x, y))
                return MouseResult(
                    success=True,
                    action=f"drag_to_{button.value}",
                    position=(x, y),
                    button=button.value,
                    metadata={"mock": True, "duration": duration}
                )
            
            current_x, current_y = self.get_position()
            
            pyautogui.dragTo(
                x, y,
                duration=duration,
                button=button.value
            )
            
            pos = self.get_position()
            self._last_positions.append(pos)
            
            return MouseResult(
                success=True,
                action=f"drag_to_{button.value}",
                position=pos,
                button=button.value,
                metadata={"duration": duration, "start": (current_x, current_y)}
            )
            
        except Exception as e:
            return MouseResult(
                success=False,
                action=f"drag_to_{button.value}",
                error=str(e)
            )
    
    def drag_relative(
        self,
        dx: int,
        dy: int,
        duration: float = 0.5,
        button: MouseButton = MouseButton.LEFT
    ) -> MouseResult:
        """
        Drag mouse relative to current position
        
        Args:
            dx: Horizontal offset
            dy: Vertical offset
            duration: Movement duration
            button: Button to hold during drag
            
        Returns:
            MouseResult with operation status
        """
        try:
            current_x, current_y = self.get_position()
            target_x = current_x + dx
            target_y = current_y + dy
            
            return self.drag_to(target_x, target_y, duration, button)
            
        except Exception as e:
            return MouseResult(
                success=False,
                action=f"drag_relative_{button.value}",
                error=str(e)
            )
    
    def scroll(
        self,
        amount: int,
        x: Optional[int] = None,
        y: Optional[int] = None
    ) -> MouseResult:
        """
        Scroll mouse wheel
        
        Args:
            amount: Scroll amount (positive = up, negative = down)
            x: X coordinate to scroll at (None = current position)
            y: Y coordinate to scroll at (None = current position)
            
        Returns:
            MouseResult with operation status
        """
        try:
            if not PYAUTOGUI_AVAILABLE:
                pos = (x, y) if x is not None and y is not None else self.get_position()
                return MouseResult(
                    success=True,
                    action="scroll",
                    position=pos,
                    metadata={"mock": True, "amount": amount}
                )
            
            # Move to position if specified
            if x is not None and y is not None:
                pyautogui.moveTo(x, y, duration=0.1)
            
            pyautogui.scroll(amount)
            
            pos = self.get_position()
            
            return MouseResult(
                success=True,
                action="scroll",
                position=pos,
                metadata={"amount": amount}
            )
            
        except Exception as e:
            return MouseResult(
                success=False,
                action="scroll",
                error=str(e)
            )
    
    def press_and_hold(self, button: MouseButton = MouseButton.LEFT) -> MouseResult:
        """
        Press and hold mouse button
        
        Args:
            button: Button to press
            
        Returns:
            MouseResult with operation status
        """
        try:
            if not PYAUTOGUI_AVAILABLE:
                pos = self.get_position()
                return MouseResult(
                    success=True,
                    action=f"press_{button.value}",
                    position=pos,
                    button=button.value,
                    metadata={"mock": True}
                )
            
            pyautogui.mouseDown(button=button.value)
            
            pos = self.get_position()
            return MouseResult(
                success=True,
                action=f"press_{button.value}",
                position=pos,
                button=button.value
            )
            
        except Exception as e:
            return MouseResult(
                success=False,
                action=f"press_{button.value}",
                error=str(e)
            )
    
    def release(self, button: MouseButton = MouseButton.LEFT) -> MouseResult:
        """
        Release pressed mouse button
        
        Args:
            button: Button to release
            
        Returns:
            MouseResult with operation status
        """
        try:
            if not PYAUTOGUI_AVAILABLE:
                pos = self.get_position()
                return MouseResult(
                    success=True,
                    action=f"release_{button.value}",
                    position=pos,
                    button=button.value,
                    metadata={"mock": True}
                )
            
            pyautogui.mouseUp(button=button.value)
            
            pos = self.get_position()
            return MouseResult(
                success=True,
                action=f"release_{button.value}",
                position=pos,
                button=button.value
            )
            
        except Exception as e:
            return MouseResult(
                success=False,
                action=f"release_{button.value}",
                error=str(e)
            )
    
    def get_last_positions(self, count: int = 10) -> list:
        """Get recent mouse positions"""
        return self._last_positions[-count:]
    
    def clear_history(self):
        """Clear position history"""
        self._last_positions.clear()
        self._operation_history.clear()
