"""Emergency Stop mechanism for immediate Worker shutdown."""

import threading
import signal
import os
from typing import Optional, Callable
from datetime import datetime, timezone
import logging

logger = logging.getLogger(__name__)


class EmergencyStop:
    """
    Emergency Stop mechanism for immediate Worker shutdown.
    
    Implements TZ section 25 requirements:
    - User can stop agent loop at any moment
    - Stops mouse/keyboard automation
    - Terminates child processes
    - Stops current task
    - High priority, independent of LLM
    - Global singleton accessible from anywhere
    """
    
    _instance: Optional["EmergencyStop"] = None
    _lock = threading.Lock()
    
    def __new__(cls) -> "EmergencyStop":
        """Singleton pattern to ensure only one instance exists."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        
        self._triggered = False
        self._trigger_time: Optional[datetime] = None
        self._trigger_reason: Optional[str] = None
        self._callbacks: list[Callable[[], None]] = []
        self._stop_handlers: list[Callable[[], None]] = []
        self._original_sigint = None
        self._original_sigterm = None
        self._mouse_locked = False
        self._keyboard_locked = False
        self._child_processes: set[int] = set()
        self._lock = threading.Lock()
        self._initialized = True
        
        logger.info("EmergencyStop initialized")
    
    @classmethod
    def get_instance(cls) -> "EmergencyStop":
        """Get the singleton instance."""
        return cls()
    
    @classmethod
    def reset_instance(cls) -> None:
        """Reset the singleton (for testing)."""
        with cls._lock:
            if cls._instance:
                cls._instance._initialized = False
                cls._instance = None
    
    def trigger(self, reason: str = "User requested emergency stop") -> None:
        """
        Trigger emergency stop immediately.
        
        Args:
            reason: Reason for the emergency stop
        """
        with self._lock:
            if self._triggered:
                logger.warning("Emergency stop already triggered")
                return
            
            self._triggered = True
            self._trigger_time = datetime.now(timezone.utc)
            self._trigger_reason = reason
            
            logger.critical(f"EMERGENCY STOP TRIGGERED: {reason}")
            
            # Execute all stop handlers
            for handler in self._stop_handlers:
                try:
                    handler()
                except Exception as e:
                    logger.error(f"Error in stop handler: {e}")
            
            # Notify callbacks
            for callback in self._callbacks:
                try:
                    callback()
                except Exception as e:
                    logger.error(f"Error in emergency stop callback: {e}")
            
            # Kill child processes
            self._kill_child_processes()
            
            # Release input locks
            self.release_mouse_lock()
            self.release_keyboard_lock()
    
    def is_triggered(self) -> bool:
        """Check if emergency stop has been triggered."""
        return self._triggered
    
    def reset(self) -> None:
        """
        Reset emergency stop (allow normal operation again).
        
        Should only be called explicitly by user/system after reviewing the situation.
        """
        with self._lock:
            self._triggered = False
            self._trigger_time = None
            self._trigger_reason = None
            logger.info("Emergency stop reset")
    
    def get_status(self) -> dict:
        """Get current emergency stop status."""
        return {
            "triggered": self._triggered,
            "trigger_time": self._trigger_time.isoformat() if self._trigger_time else None,
            "reason": self._trigger_reason,
            "mouse_locked": self._mouse_locked,
            "keyboard_locked": self._keyboard_locked,
            "child_processes_count": len(self._child_processes)
        }
    
    def register_callback(self, callback: Callable[[], None]) -> None:
        """
        Register a callback to be called on emergency stop.
        
        Args:
            callback: Function to call when emergency stop is triggered
        """
        self._callbacks.append(callback)
    
    def register_stop_handler(self, handler: Callable[[], None]) -> None:
        """
        Register a stop handler for cleanup operations.
        
        Args:
            handler: Function to call for cleanup during emergency stop
        """
        self._stop_handlers.append(handler)
    
    def register_child_process(self, pid: int) -> None:
        """
        Register a child process to be killed on emergency stop.
        
        Args:
            pid: Process ID of the child process
        """
        with self._lock:
            self._child_processes.add(pid)
    
    def unregister_child_process(self, pid: int) -> None:
        """
        Unregister a child process.
        
        Args:
            pid: Process ID to remove
        """
        with self._lock:
            self._child_processes.discard(pid)
    
    def _kill_child_processes(self) -> None:
        """Kill all registered child processes."""
        with self._lock:
            pids_to_kill = list(self._child_processes)
            self._child_processes.clear()  # Clear immediately to prevent deadlock
        
        for pid in pids_to_kill:
            try:
                os.kill(pid, signal.SIGKILL)
                logger.info(f"Killed child process {pid}")
            except (ProcessLookupError, PermissionError, OSError) as e:
                logger.debug(f"Could not kill process {pid}: {e}")
    
    def lock_mouse(self) -> None:
        """Lock mouse input to prevent accidental interaction during automation."""
        self._mouse_locked = True
        logger.debug("Mouse locked")
    
    def unlock_mouse(self) -> None:
        """Unlock mouse input."""
        self._mouse_locked = False
        logger.debug("Mouse unlocked")
    
    def release_mouse_lock(self) -> None:
        """Release mouse lock (alias for unlock_mouse)."""
        self.unlock_mouse()
    
    def is_mouse_locked(self) -> bool:
        """Check if mouse is currently locked."""
        return self._mouse_locked
    
    def lock_keyboard(self) -> None:
        """Lock keyboard input to prevent accidental interaction during automation."""
        self._keyboard_locked = True
        logger.debug("Keyboard locked")
    
    def unlock_keyboard(self) -> None:
        """Unlock keyboard input."""
        self._keyboard_locked = False
        logger.debug("Keyboard unlocked")
    
    def release_keyboard_lock(self) -> None:
        """Release keyboard lock (alias for unlock_keyboard)."""
        self.unlock_keyboard()
    
    def is_keyboard_locked(self) -> bool:
        """Check if keyboard is currently locked."""
        return self._keyboard_locked
    
    def check_stop(self) -> None:
        """
        Check if emergency stop has been triggered and raise exception if so.
        
        Should be called at key points in the agent loop and tool execution.
        
        Raises:
            EmergencyStopException: If emergency stop has been triggered
        """
        if self.is_triggered():
            raise EmergencyStopException(self._trigger_reason or "Emergency stop triggered")
    
    def install_signal_handlers(self) -> None:
        """
        Install signal handlers for Ctrl+C and SIGTERM.
        
        This allows emergency stop to be triggered via keyboard interrupt.
        """
        def signal_handler(signum, frame):
            logger.info(f"Received signal {signum}, triggering emergency stop")
            self.trigger(reason=f"Signal {signum} received")
        
        # Store original handlers
        self._original_sigint = signal.signal(signal.SIGINT, signal_handler)
        self._original_sigterm = signal.signal(signal.SIGTERM, signal_handler)
        
        logger.info("Emergency stop signal handlers installed")
    
    def restore_signal_handlers(self) -> None:
        """Restore original signal handlers."""
        if self._original_sigint:
            signal.signal(signal.SIGINT, self._original_sigint)
        if self._original_sigterm:
            signal.signal(signal.SIGTERM, self._original_sigterm)
        
        logger.info("Emergency stop signal handlers restored")


class EmergencyStopException(Exception):
    """Exception raised when emergency stop is triggered."""
    
    def __init__(self, message: str = "Emergency stop triggered"):
        super().__init__(message)
        self.message = message


# Convenience functions for global access
def trigger_emergency_stop(reason: str = "User requested") -> None:
    """Trigger emergency stop globally."""
    EmergencyStop.get_instance().trigger(reason)


def is_emergency_stop_triggered() -> bool:
    """Check if emergency stop has been triggered."""
    return EmergencyStop.get_instance().is_triggered()


def check_emergency_stop() -> None:
    """Check and raise exception if emergency stop triggered."""
    EmergencyStop.get_instance().check_stop()


def reset_emergency_stop() -> None:
    """Reset emergency stop."""
    EmergencyStop.get_instance().reset()


def get_emergency_stop_status() -> dict:
    """Get emergency stop status."""
    return EmergencyStop.get_instance().get_status()
