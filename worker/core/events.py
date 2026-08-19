"""
Event bus for inter-module communication.

Implements pub/sub pattern with typed events for:
- Task lifecycle events
- Tool execution events
- Permission requests
- Agent state changes
"""

from enum import Enum
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, TypeVar, Generic
from pydantic import BaseModel, Field, ConfigDict
import asyncio
import uuid


# ============================================================
# EVENT TYPES
# ============================================================

class EventType(str, Enum):
    """All event types in the system."""
    # Task lifecycle
    TASK_CREATED = "task_created"
    TASK_STARTED = "task_started"
    TASK_STATE_CHANGED = "task_state_changed"
    TASK_COMPLETED = "task_completed"
    TASK_FAILED = "task_failed"
    TASK_CANCELLED = "task_cancelled"
    
    # Planning
    PLAN_CREATED = "plan_created"
    PLAN_UPDATED = "plan_updated"
    STEP_STARTED = "step_started"
    STEP_COMPLETED = "step_completed"
    STEP_FAILED = "step_failed"
    
    # Tool execution
    TOOL_REQUESTED = "tool_requested"
    TOOL_STARTED = "tool_started"
    TOOL_FINISHED = "tool_finished"
    TOOL_ERROR = "tool_error"
    
    # Permissions
    PERMISSION_REQUESTED = "permission_requested"
    PERMISSION_GRANTED = "permission_granted"
    PERMISSION_DENIED = "permission_denied"
    
    # Observation & Verification
    OBSERVATION_CREATED = "observation_created"
    VERIFICATION_PASSED = "verification_passed"
    VERIFICATION_FAILED = "verification_failed"
    
    # Agent control
    AGENT_PAUSED = "agent_paused"
    AGENT_RESUMED = "agent_resumed"
    AGENT_STOPPED = "agent_stopped"
    EMERGENCY_STOP = "emergency_stop"
    
    # Memory
    MEMORY_WRITTEN = "memory_written"
    MEMORY_READ = "memory_read"


# ============================================================
# EVENT BASE CLASSES
# ============================================================

class Event(BaseModel):
    """Base event class."""
    event_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    event_type: EventType
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    source: Optional[str] = None  # module name
    
    model_config = ConfigDict(arbitrary_types_allowed=True)


T = TypeVar('T')


class DataEvent(Event, Generic[T]):
    """Event with payload data."""
    data: T


# ============================================================
# SPECIFIC EVENT MODELS
# ============================================================

class TaskEventData(BaseModel):
    """Task-related event data."""
    task_id: str
    user_request: str
    state: str
    previous_state: Optional[str] = None


class PlanEventData(BaseModel):
    """Plan-related event data."""
    task_id: str
    plan_id: str
    step_count: int
    strategy: Optional[str] = None


class StepEventData(BaseModel):
    """Step-related event data."""
    task_id: str
    step_id: str
    step_description: str
    status: str
    error: Optional[str] = None


class ToolEventData(BaseModel):
    """Tool-related event data."""
    task_id: str
    tool_name: str
    call_id: str
    step_id: Optional[str] = None
    success: bool = False
    duration_ms: Optional[int] = None
    error: Optional[str] = None


class PermissionEventData(BaseModel):
    """Permission-related event data."""
    request_id: str
    task_id: str
    tool_name: str
    action: str
    risk_level: str
    reason: str
    status: str = "pending"


class ObservationEventData(BaseModel):
    """Observation-related event data."""
    task_id: str
    observation_id: str
    what_changed: str
    confidence: float
    has_errors: bool = False


class VerificationEventData(BaseModel):
    """Verification-related event data."""
    task_id: str
    verification_id: str
    passed: bool
    goal_reached: bool
    message: Optional[str] = None


class AgentEventData(BaseModel):
    """Agent control event data."""
    reason: str
    task_id: Optional[str] = None


class MemoryEventData(BaseModel):
    """Memory-related event data."""
    record_id: str
    memory_type: str
    key: str
    task_id: Optional[str] = None


# ============================================================
# EVENT BUS IMPLEMENTATION
# ============================================================

class EventBus:
    """
    Central event bus for pub/sub communication.
    
    Thread-safe, async-compatible event dispatcher.
    """
    
    def __init__(self):
        self._subscribers: Dict[EventType, List[Callable]] = {}
        self._lock = asyncio.Lock()
    
    def subscribe(self, event_type: EventType, callback: Callable) -> None:
        """
        Subscribe to an event type.
        
        Args:
            event_type: Type of event to subscribe to
            callback: Async or sync function to call when event occurs
        """
        if event_type not in self._subscribers:
            self._subscribers[event_type] = []
        self._subscribers[event_type].append(callback)
    
    def unsubscribe(self, event_type: EventType, callback: Callable) -> bool:
        """
        Unsubscribe from an event type.
        
        Returns True if callback was found and removed.
        """
        if event_type in self._subscribers:
            try:
                self._subscribers[event_type].remove(callback)
                return True
            except ValueError:
                pass
        return False
    
    async def publish(self, event: Event) -> None:
        """
        Publish an event to all subscribers.
        
        Calls callbacks asynchronously if they are coroutines.
        """
        subscribers = self._subscribers.get(event.event_type, [])
        
        for callback in subscribers:
            try:
                if asyncio.iscoroutinefunction(callback):
                    await callback(event)
                else:
                    callback(event)
            except Exception as e:
                # Log error but don't stop other subscribers
                print(f"Error in event subscriber: {e}")
    
    def publish_sync(self, event: Event) -> None:
        """
        Publish an event synchronously.
        
        Use only for sync callbacks or in async contexts.
        """
        subscribers = self._subscribers.get(event.event_type, [])
        
        for callback in subscribers:
            try:
                if asyncio.iscoroutinefunction(callback):
                    # Can't await in sync context - schedule instead
                    asyncio.create_task(callback(event))
                else:
                    callback(event)
            except Exception as e:
                print(f"Error in event subscriber: {e}")
    
    def clear(self) -> None:
        """Clear all subscriptions."""
        self._subscribers.clear()
    
    def get_subscriber_count(self, event_type: EventType) -> int:
        """Get number of subscribers for an event type."""
        return len(self._subscribers.get(event_type, []))


# Alias methods for EventBus (defined after class)
EventBus.emit = EventBus.publish
EventBus.emit_sync = EventBus.publish_sync


# ============================================================
# GLOBAL EVENT BUS INSTANCE
# ============================================================

# Singleton instance for application-wide use
event_bus = EventBus()


# ============================================================
# EVENT FACTORY FUNCTIONS
# ============================================================

def create_task_event(
    event_type: EventType,
    task_id: str,
    user_request: str,
    state: str,
    previous_state: Optional[str] = None,
    source: Optional[str] = None
) -> DataEvent[TaskEventData]:
    """Create a task lifecycle event."""
    return DataEvent[TaskEventData](
        event_type=event_type,
        source=source,
        data=TaskEventData(
            task_id=task_id,
            user_request=user_request,
            state=state,
            previous_state=previous_state
        )
    )


def create_step_event(
    event_type: EventType,
    task_id: str,
    step_id: str,
    description: str,
    status: str,
    error: Optional[str] = None,
    source: Optional[str] = None
) -> DataEvent[StepEventData]:
    """Create a step execution event."""
    return DataEvent[StepEventData](
        event_type=event_type,
        source=source,
        data=StepEventData(
            task_id=task_id,
            step_id=step_id,
            step_description=description,
            status=status,
            error=error
        )
    )


def create_tool_event(
    event_type: EventType,
    task_id: str,
    tool_name: str,
    call_id: str,
    success: bool = False,
    step_id: Optional[str] = None,
    duration_ms: Optional[int] = None,
    error: Optional[str] = None,
    source: Optional[str] = None
) -> DataEvent[ToolEventData]:
    """Create a tool execution event."""
    return DataEvent[ToolEventData](
        event_type=event_type,
        source=source,
        data=ToolEventData(
            task_id=task_id,
            tool_name=tool_name,
            call_id=call_id,
            step_id=step_id,
            success=success,
            duration_ms=duration_ms,
            error=error
        )
    )


def create_permission_event(
    request_id: str,
    task_id: str,
    tool_name: str,
    action: str,
    risk_level: str,
    reason: str,
    status: str = "pending",
    source: Optional[str] = None
) -> DataEvent[PermissionEventData]:
    """Create a permission request event."""
    return DataEvent[PermissionEventData](
        event_type=EventType.PERMISSION_REQUESTED,
        source=source,
        data=PermissionEventData(
            request_id=request_id,
            task_id=task_id,
            tool_name=tool_name,
            action=action,
            risk_level=risk_level,
            reason=reason,
            status=status
        )
    )
