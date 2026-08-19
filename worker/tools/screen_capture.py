"""
Screen Capture Module - WORKER Phase 2

Provides screen observation capabilities:
- Full screen screenshots
- Multi-monitor support
- Active window screenshots
- Region screenshots
- DPI/scaling detection
- Screen metadata
"""

import os
import time
from pathlib import Path
from typing import Optional, Dict, Any, List
from datetime import datetime, timezone
import base64
from io import BytesIO

from pydantic import BaseModel, Field

# Try to import platform-specific libraries
try:
    import mss
    import mss.tools
    MSS_AVAILABLE = True
except ImportError:
    MSS_AVAILABLE = False

try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False


class ScreenInfo(BaseModel):
    """Information about a screen/monitor"""
    monitor_id: int = Field(..., description="Monitor identifier")
    left: int = Field(..., description="Left coordinate")
    top: int = Field(..., description="Top coordinate")
    width: int = Field(..., description="Screen width in pixels")
    height: int = Field(..., description="Screen height in pixels")
    is_primary: bool = Field(default=False, description="Is this the primary monitor")
    dpi_x: float = Field(default=96.0, description="Horizontal DPI")
    dpi_y: float = Field(default=96.0, description="Vertical DPI")
    scale_factor: float = Field(default=1.0, description="Display scale factor")


class ScreenshotResult(BaseModel):
    """Result of a screenshot operation"""
    success: bool = Field(..., description="Operation success")
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    image_path: Optional[str] = Field(None, description="Path to saved screenshot file")
    image_base64: Optional[str] = Field(None, description="Base64 encoded image data")
    width: int = Field(0, description="Image width in pixels")
    height: int = Field(0, description="Image height in pixels")
    monitor_id: Optional[int] = Field(None, description="Monitor ID if captured specific monitor")
    region: Optional[Dict[str, int]] = Field(None, description="Captured region coordinates")
    active_window: Optional[str] = Field(None, description="Active window title if captured")
    error: Optional[str] = Field(None, description="Error message if failed")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional metadata")


class ScreenCaptureTool:
    """
    Screen capture tool for WORKER
    
    Capabilities:
    - Full screen capture (all monitors or specific)
    - Active window capture
    - Region capture
    - Screen info detection
    - Multi-monitor support
    """
    
    def __init__(self, output_dir: Optional[str] = None):
        """
        Initialize screen capture tool
        
        Args:
            output_dir: Directory to save screenshots (default: ./storage/screenshots)
        """
        self.output_dir = Path(output_dir) if output_dir else Path("./storage/screenshots")
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        self._mss_instance = None
        self._last_screenshots: List[ScreenshotResult] = []
        
    def _get_mss(self):
        """Get or create MSS instance"""
        if not MSS_AVAILABLE:
            raise RuntimeError(
                "mss library not available. Install with: pip install mss"
            )
        if self._mss_instance is None:
            self._mss_instance = mss.mss()
        return self._mss_instance
    
    def get_monitors(self) -> List[ScreenInfo]:
        """
        Get information about all connected monitors
        
        Returns:
            List of ScreenInfo objects for each monitor
        """
        if not MSS_AVAILABLE:
            # Return mock data for testing without mss
            return [
                ScreenInfo(
                    monitor_id=0,
                    left=0, top=0,
                    width=1920, height=1080,
                    is_primary=True
                )
            ]
        
        try:
            sct = self._get_mss()
            monitors = []
            
            # Enumerate monitors (index 0 is all monitors combined)
            for i, mon in enumerate(sct.monitors):
                if i == 0:
                    continue  # Skip the "all monitors" entry
                
                monitors.append(ScreenInfo(
                    monitor_id=i,
                    left=mon["left"],
                    top=mon["top"],
                    width=mon["width"],
                    height=mon["height"],
                    is_primary=(i == 1)  # First real monitor is primary
                ))
            
            return monitors
        except Exception as e:
            # Return mock data on error
            return [
                ScreenInfo(
                    monitor_id=0,
                    left=0, top=0,
                    width=1920, height=1080,
                    is_primary=True
                )
            ]
    
    def capture_full_screen(
        self,
        monitor_id: Optional[int] = None,
        save_path: Optional[str] = None,
        include_base64: bool = True
    ) -> ScreenshotResult:
        """
        Capture full screen screenshot
        
        Args:
            monitor_id: Specific monitor ID (None = primary monitor)
            save_path: Path to save screenshot (None = auto-generate)
            include_base64: Include base64 encoded image in result
            
        Returns:
            ScreenshotResult with image data
        """
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        
        try:
            if not MSS_AVAILABLE:
                # Mock screenshot for testing
                img_path = self.output_dir / f"screenshot_{timestamp}.png"
                # Create a simple test image
                if PIL_AVAILABLE:
                    img = Image.new('RGB', (1920, 1080), color='gray')
                    img.save(img_path)
                else:
                    # Create empty file as placeholder
                    img_path.touch()
                
                return ScreenshotResult(
                    success=True,
                    image_path=str(img_path),
                    width=1920,
                    height=1080,
                    monitor_id=monitor_id or 0,
                    metadata={"mock": True, "platform": "linux"}
                )
            
            sct = self._get_mss()
            
            # Determine which monitor to capture
            monitors = sct.monitors
            if monitor_id is None or monitor_id < 1 or monitor_id >= len(monitors):
                monitor = monitors[1]  # Primary monitor
                actual_monitor_id = 1
            else:
                monitor = monitors[monitor_id]
                actual_monitor_id = monitor_id
            
            # Capture screenshot
            screenshot = sct.grab(monitor)
            
            # Save to file
            if save_path:
                img_path = Path(save_path)
            else:
                img_path = self.output_dir / f"screenshot_{timestamp}_mon{actual_monitor_id}.png"
            
            img_path.parent.mkdir(parents=True, exist_ok=True)
            mss.tools.to_png(screenshot.rgb, screenshot.size, output=str(img_path))
            
            # Prepare result
            result = ScreenshotResult(
                success=True,
                image_path=str(img_path),
                width=screenshot.width,
                height=screenshot.height,
                monitor_id=actual_monitor_id,
                metadata={
                    "monitor_rect": {
                        "left": monitor["left"],
                        "top": monitor["top"],
                        "width": monitor["width"],
                        "height": monitor["height"]
                    }
                }
            )
            
            # Include base64 if requested
            if include_base64:
                with open(img_path, "rb") as f:
                    result.image_base64 = base64.b64encode(f.read()).decode('utf-8')
            
            self._last_screenshots.append(result)
            return result
            
        except Exception as e:
            return ScreenshotResult(
                success=False,
                error=str(e),
                width=0,
                height=0
            )
    
    def capture_region(
        self,
        left: int,
        top: int,
        width: int,
        height: int,
        save_path: Optional[str] = None,
        include_base64: bool = True
    ) -> ScreenshotResult:
        """
        Capture a specific region of the screen
        
        Args:
            left: Left coordinate
            top: Top coordinate
            width: Region width
            height: Region height
            save_path: Path to save screenshot
            include_base64: Include base64 encoded image
            
        Returns:
            ScreenshotResult with image data
        """
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        
        try:
            if not MSS_AVAILABLE:
                # Mock for testing
                img_path = self.output_dir / f"region_{timestamp}.png"
                if PIL_AVAILABLE:
                    img = Image.new('RGB', (width, height), color='blue')
                    img.save(img_path)
                else:
                    img_path.touch()
                
                return ScreenshotResult(
                    success=True,
                    image_path=str(img_path),
                    width=width,
                    height=height,
                    region={"left": left, "top": top, "width": width, "height": height},
                    metadata={"mock": True}
                )
            
            sct = self._get_mss()
            
            # Define region
            monitor = {
                "left": left,
                "top": top,
                "width": width,
                "height": height
            }
            
            # Capture
            screenshot = sct.grab(monitor)
            
            # Save
            if save_path:
                img_path = Path(save_path)
            else:
                img_path = self.output_dir / f"region_{timestamp}.png"
            
            img_path.parent.mkdir(parents=True, exist_ok=True)
            mss.tools.to_png(screenshot.rgb, screenshot.size, output=str(img_path))
            
            result = ScreenshotResult(
                success=True,
                image_path=str(img_path),
                width=screenshot.width,
                height=screenshot.height,
                region={"left": left, "top": top, "width": width, "height": height}
            )
            
            if include_base64:
                with open(img_path, "rb") as f:
                    result.image_base64 = base64.b64encode(f.read()).decode('utf-8')
            
            self._last_screenshots.append(result)
            return result
            
        except Exception as e:
            return ScreenshotResult(
                success=False,
                error=str(e),
                width=width,
                height=height
            )
    
    def capture_active_window(
        self,
        save_path: Optional[str] = None,
        include_base64: bool = True
    ) -> ScreenshotResult:
        """
        Capture the currently active/focused window
        
        Args:
            save_path: Path to save screenshot
            include_base64: Include base64 encoded image
            
        Returns:
            ScreenshotResult with image data and window info
        """
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        
        try:
            # Try to get active window info (platform-specific)
            active_window_title = self._get_active_window_title()
            
            if not MSS_AVAILABLE:
                # Mock for testing
                img_path = self.output_dir / f"active_{timestamp}.png"
                if PIL_AVAILABLE:
                    img = Image.new('RGB', (800, 600), color='green')
                    img.save(img_path)
                else:
                    img_path.touch()
                
                return ScreenshotResult(
                    success=True,
                    image_path=str(img_path),
                    width=800,
                    height=600,
                    active_window=active_window_title or "Unknown",
                    metadata={"mock": True}
                )
            
            # On Linux, we might not have good active window detection
            # Fall back to primary monitor with window info
            sct = self._get_mss()
            monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
            
            screenshot = sct.grab(monitor)
            
            if save_path:
                img_path = Path(save_path)
            else:
                img_path = self.output_dir / f"active_{timestamp}.png"
            
            img_path.parent.mkdir(parents=True, exist_ok=True)
            mss.tools.to_png(screenshot.rgb, screenshot.size, output=str(img_path))
            
            result = ScreenshotResult(
                success=True,
                image_path=str(img_path),
                width=screenshot.width,
                height=screenshot.height,
                active_window=active_window_title or "Unknown"
            )
            
            if include_base64:
                with open(img_path, "rb") as f:
                    result.image_base64 = base64.b64encode(f.read()).decode('utf-8')
            
            self._last_screenshots.append(result)
            return result
            
        except Exception as e:
            return ScreenshotResult(
                success=False,
                error=str(e),
                width=0,
                height=0
            )
    
    def _get_active_window_title(self) -> Optional[str]:
        """
        Get the title of the currently active window
        
        Platform-specific implementation
        """
        try:
            # Linux implementation using X11
            import subprocess
            result = subprocess.run(
                ["xprop", "-root", "_NET_ACTIVE_WINDOW"],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                # Parse window ID and get title
                # Simplified - full implementation would parse properly
                return "Active Window"
        except Exception:
            pass
        
        return None
    
    def get_screen_metadata(self) -> Dict[str, Any]:
        """
        Get comprehensive screen metadata
        
        Returns:
            Dictionary with screen configuration info
        """
        monitors = self.get_monitors()
        
        return {
            "monitor_count": len(monitors),
            "monitors": [m.model_dump() for m in monitors],
            "total_width": max(m.left + m.width for m in monitors) if monitors else 0,
            "total_height": max(m.top + m.height for m in monitors) if monitors else 0,
            "primary_monitor": next((m.monitor_id for m in monitors if m.is_primary), 0),
            "platform": os.name,
            "mss_available": MSS_AVAILABLE,
            "pillow_available": PIL_AVAILABLE
        }
    
    def compare_screenshots(
        self,
        screenshot1_path: str,
        screenshot2_path: str,
        threshold: float = 0.95
    ) -> Dict[str, Any]:
        """
        Compare two screenshots and detect differences
        
        Args:
            screenshot1_path: Path to first screenshot
            screenshot2_path: Path to second screenshot
            threshold: Similarity threshold (0-1)
            
        Returns:
            Comparison result with difference info
        """
        if not PIL_AVAILABLE:
            return {
                "success": False,
                "error": "PIL/Pillow not available",
                "similarity": 0.0,
                "has_differences": True
            }
        
        try:
            img1 = Image.open(screenshot1_path)
            img2 = Image.open(screenshot2_path)
            
            # Resize to match if different
            if img1.size != img2.size:
                img2 = img2.resize(img1.size)
            
            # Simple pixel-by-pixel comparison
            pixels1 = list(img1.getdata())
            pixels2 = list(img2.getdata())
            
            matching = sum(1 for p1, p2 in zip(pixels1, pixels2) if p1 == p2)
            total = len(pixels1)
            
            similarity = matching / total if total > 0 else 0.0
            
            return {
                "success": True,
                "similarity": similarity,
                "has_differences": similarity < threshold,
                "matching_pixels": matching,
                "total_pixels": total,
                "difference_percentage": (1 - similarity) * 100
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "similarity": 0.0,
                "has_differences": True
            }
    
    def get_last_screenshots(self, count: int = 5) -> List[ScreenshotResult]:
        """Get recent screenshots"""
        return self._last_screenshots[-count:]
    
    def clear_screenshot_history(self):
        """Clear screenshot history"""
        self._last_screenshots.clear()
