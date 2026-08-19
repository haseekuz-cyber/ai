"""
Keyboard Control Module - WORKER Phase 2

Provides keyboard input capabilities:
- Type text
- Press individual keys
- Hotkey combinations
- Special keys (Enter, Tab, Escape, etc.)
"""

import time
from typing import Optional, Dict, Any, List, Union
from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, Field

# Try to import platform-specific libraries
try:
    import pyautogui
    PYAUTOGUI_AVAILABLE = True
    pyautogui.FAILSAFE = True
    pyautogui.PAUSE = 0.1
except ImportError:
    PYAUTOGUI_AVAILABLE = False


class KeyboardResult(BaseModel):
    """Result of a keyboard operation"""
    success: bool = Field(..., description="Operation success")
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    action: str = Field(..., description="Action performed")
    text: Optional[str] = Field(None, description="Text typed if applicable")
    keys: Optional[List[str]] = Field(None, description="Keys pressed if applicable")
    error: Optional[str] = Field(None, description="Error message if failed")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional metadata")


class SpecialKey(str, Enum):
    """Special keyboard keys"""
    ENTER = "enter"
    RETURN = "return"
    TAB = "tab"
    SPACE = "space"
    ESCAPE = "esc"
    ESC = "esc"
    BACKSPACE = "backspace"
    DELETE = "delete"
    HOME = "home"
    END = "end"
    PAGEUP = "pageup"
    PAGEDOWN = "pagedown"
    UP = "up"
    DOWN = "down"
    LEFT = "left"
    RIGHT = "right"
    F1 = "f1"
    F2 = "f2"
    F3 = "f3"
    F4 = "f4"
    F5 = "f5"
    F6 = "f6"
    F7 = "f7"
    F8 = "f8"
    F9 = "f9"
    F10 = "f10"
    F11 = "f11"
    F12 = "f12"
    CTRL = "ctrl"
    CONTROL = "ctrl"
    ALT = "alt"
    SHIFT = "shift"
    WIN = "win"
    COMMAND = "command"
    CAPSLOCK = "capslock"
    NUMLOCK = "numlock"
    SCROLLLOCK = "scrolllock"
    PRINTSCREEN = "printscreen"
    INSERT = "insert"


class KeyboardControlTool:
    """
    Keyboard control tool for WORKER
    
    Capabilities:
    - Type text strings
    - Press individual keys
    - Hotkey combinations
    - Special key support
    """
    
    def __init__(self):
        """Initialize keyboard control tool"""
        self._type_history: list = []
        self._key_history: list = []
        
    def type_text(
        self,
        text: str,
        interval: float = 0.05
    ) -> KeyboardResult:
        """
        Type a string of text
        
        Args:
            text: Text to type
            interval: Interval between keystrokes in seconds
            
        Returns:
            KeyboardResult with operation status
        """
        try:
            if not PYAUTOGUI_AVAILABLE:
                self._type_history.append({
                    "text": text,
                    "timestamp": datetime.now(timezone.utc).isoformat()
                })
                return KeyboardResult(
                    success=True,
                    action="type_text",
                    text=text,
                    metadata={"mock": True, "interval": interval, "length": len(text)}
                )
            
            pyautogui.write(text, interval=interval)
            
            self._type_history.append({
                "text": text,
                "timestamp": datetime.now(timezone.utc).isoformat()
            })
            
            return KeyboardResult(
                success=True,
                action="type_text",
                text=text,
                metadata={"interval": interval, "length": len(text)}
            )
            
        except Exception as e:
            return KeyboardResult(
                success=False,
                action="type_text",
                text=text,
                error=str(e)
            )
    
    def press_key(
        self,
        key: Union[str, SpecialKey],
        presses: int = 1,
        interval: float = 0.1
    ) -> KeyboardResult:
        """
        Press a single key
        
        Args:
            key: Key to press (string or SpecialKey enum)
            presses: Number of times to press
            interval: Interval between presses
            
        Returns:
            KeyboardResult with operation status
        """
        try:
            key_name = key.value if isinstance(key, SpecialKey) else key
            
            if not PYAUTOGUI_AVAILABLE:
                self._key_history.append({
                    "key": key_name,
                    "presses": presses,
                    "timestamp": datetime.now(timezone.utc).isoformat()
                })
                return KeyboardResult(
                    success=True,
                    action="press_key",
                    keys=[key_name],
                    metadata={"mock": True, "presses": presses}
                )
            
            pyautogui.press(key_name, presses=presses, interval=interval)
            
            self._key_history.append({
                "key": key_name,
                "presses": presses,
                "timestamp": datetime.now(timezone.utc).isoformat()
            })
            
            return KeyboardResult(
                success=True,
                action="press_key",
                keys=[key_name],
                metadata={"presses": presses}
            )
            
        except Exception as e:
            return KeyboardResult(
                success=False,
                action="press_key",
                keys=[key if isinstance(key, str) else key.value],
                error=str(e)
            )
    
    def hotkey(
        self,
        *keys: Union[str, SpecialKey],
        interval: float = 0.1
    ) -> KeyboardResult:
        """
        Press a combination of keys (hotkey)
        
        Args:
            *keys: Keys to press together (e.g., 'ctrl', 'c')
            interval: Interval between key presses
            
        Returns:
            KeyboardResult with operation status
            
        Examples:
            hotkey('ctrl', 'c')  # Copy
            hotkey('ctrl', 'v')  # Paste
            hotkey('alt', 'tab')  # Switch windows
            hotkey('ctrl', 'shift', 'esc')  # Task Manager
        """
        try:
            key_names = [
                k.value if isinstance(k, SpecialKey) else k
                for k in keys
            ]
            
            if not PYAUTOGUI_AVAILABLE:
                self._key_history.append({
                    "keys": key_names,
                    "type": "hotkey",
                    "timestamp": datetime.now(timezone.utc).isoformat()
                })
                return KeyboardResult(
                    success=True,
                    action="hotkey",
                    keys=key_names,
                    metadata={"mock": True}
                )
            
            pyautogui.hotkey(*key_names, interval=interval)
            
            self._key_history.append({
                "keys": key_names,
                "type": "hotkey",
                "timestamp": datetime.now(timezone.utc).isoformat()
            })
            
            return KeyboardResult(
                success=True,
                action="hotkey",
                keys=key_names,
                metadata={}
            )
            
        except Exception as e:
            return KeyboardResult(
                success=False,
                action="hotkey",
                keys=[k if isinstance(k, str) else k.value for k in keys],
                error=str(e)
            )
    
    def press_and_hold(self, key: Union[str, SpecialKey]) -> KeyboardResult:
        """
        Press and hold a key down
        
        Args:
            key: Key to hold
            
        Returns:
            KeyboardResult with operation status
        """
        try:
            key_name = key.value if isinstance(key, SpecialKey) else key
            
            if not PYAUTOGUI_AVAILABLE:
                self._key_history.append({
                    "key": key_name,
                    "action": "hold",
                    "timestamp": datetime.now(timezone.utc).isoformat()
                })
                return KeyboardResult(
                    success=True,
                    action="press_and_hold",
                    keys=[key_name],
                    metadata={"mock": True}
                )
            
            pyautogui.keyDown(key_name)
            
            self._key_history.append({
                "key": key_name,
                "action": "hold",
                "timestamp": datetime.now(timezone.utc).isoformat()
            })
            
            return KeyboardResult(
                success=True,
                action="press_and_hold",
                keys=[key_name]
            )
            
        except Exception as e:
            return KeyboardResult(
                success=False,
                action="press_and_hold",
                keys=[key_name],
                error=str(e)
            )
    
    def release_key(self, key: Union[str, SpecialKey]) -> KeyboardResult:
        """
        Release a held key
        
        Args:
            key: Key to release
            
        Returns:
            KeyboardResult with operation status
        """
        try:
            key_name = key.value if isinstance(key, SpecialKey) else key
            
            if not PYAUTOGUI_AVAILABLE:
                self._key_history.append({
                    "key": key_name,
                    "action": "release",
                    "timestamp": datetime.now(timezone.utc).isoformat()
                })
                return KeyboardResult(
                    success=True,
                    action="release_key",
                    keys=[key_name],
                    metadata={"mock": True}
                )
            
            pyautogui.keyUp(key_name)
            
            self._key_history.append({
                "key": key_name,
                "action": "release",
                "timestamp": datetime.now(timezone.utc).isoformat()
            })
            
            return KeyboardResult(
                success=True,
                action="release_key",
                keys=[key_name]
            )
            
        except Exception as e:
            return KeyboardResult(
                success=False,
                action="release_key",
                keys=[key_name],
                error=str(e)
            )
    
    def select_all(self) -> KeyboardResult:
        """
        Select all (Ctrl+A)
        
        Returns:
            KeyboardResult with operation status
        """
        return self.hotkey('ctrl', 'a')
    
    def copy(self) -> KeyboardResult:
        """
        Copy (Ctrl+C)
        
        Returns:
            KeyboardResult with operation status
        """
        return self.hotkey('ctrl', 'c')
    
    def paste(self) -> KeyboardResult:
        """
        Paste (Ctrl+V)
        
        Returns:
            KeyboardResult with operation status
        """
        return self.hotkey('ctrl', 'v')
    
    def cut(self) -> KeyboardResult:
        """
        Cut (Ctrl+X)
        
        Returns:
            KeyboardResult with operation status
        """
        return self.hotkey('ctrl', 'x')
    
    def undo(self) -> KeyboardResult:
        """
        Undo (Ctrl+Z)
        
        Returns:
            KeyboardResult with operation status
        """
        return self.hotkey('ctrl', 'z')
    
    def redo(self) -> KeyboardResult:
        """
        Redo (Ctrl+Y or Ctrl+Shift+Z)
        
        Returns:
            KeyboardResult with operation status
        """
        # Try Windows-style first
        try:
            return self.hotkey('ctrl', 'y')
        except Exception:
            # Some apps use Ctrl+Shift+Z
            return self.hotkey('ctrl', 'shift', 'z')
    
    def save(self) -> KeyboardResult:
        """
        Save (Ctrl+S)
        
        Returns:
            KeyboardResult with operation status
        """
        return self.hotkey('ctrl', 's')
    
    def open_find(self) -> KeyboardResult:
        """
        Open find dialog (Ctrl+F)
        
        Returns:
            KeyboardResult with operation status
        """
        return self.hotkey('ctrl', 'f')
    
    def get_type_history(self, count: int = 10) -> list:
        """Get recent typing history"""
        return self._type_history[-count:]
    
    def get_key_history(self, count: int = 20) -> list:
        """Get recent key press history"""
        return self._key_history[-count:]
    
    def clear_history(self):
        """Clear all history"""
        self._type_history.clear()
        self._key_history.clear()
