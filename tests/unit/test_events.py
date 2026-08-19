"""
Unit tests for event bus.
"""

import pytest
import asyncio
from worker.core.events import (
    EventType, Event, EventBus, event_bus,
    create_task_event, create_step_event, create_tool_event
)


class TestEventBus:
    """Test EventBus functionality."""
    
    def test_subscribe_and_publish(self):
        """Test basic subscribe and publish."""
        bus = EventBus()
        received_events = []
        
        def handler(event):
            received_events.append(event)
        
        bus.subscribe(EventType.TASK_CREATED, handler)
        
        event = create_task_event(
            event_type=EventType.TASK_CREATED,
            task_id="task-123",
            user_request="test",
            state="created"
        )
        
        bus.publish_sync(event)
        
        assert len(received_events) == 1
        assert received_events[0].event_type == EventType.TASK_CREATED
    
    def test_unsubscribe(self):
        """Test unsubscribing from events."""
        bus = EventBus()
        received_events = []
        
        def handler(event):
            received_events.append(event)
        
        bus.subscribe(EventType.TASK_CREATED, handler)
        bus.unsubscribe(EventType.TASK_CREATED, handler)
        
        event = create_task_event(
            event_type=EventType.TASK_CREATED,
            task_id="task-123",
            user_request="test",
            state="created"
        )
        
        bus.publish_sync(event)
        
        assert len(received_events) == 0
    
    def test_multiple_subscribers(self):
        """Test multiple subscribers to same event."""
        bus = EventBus()
        received_1 = []
        received_2 = []
        
        def handler1(event):
            received_1.append(event)
        
        def handler2(event):
            received_2.append(event)
        
        bus.subscribe(EventType.STEP_STARTED, handler1)
        bus.subscribe(EventType.STEP_STARTED, handler2)
        
        event = create_step_event(
            event_type=EventType.STEP_STARTED,
            task_id="task-123",
            step_id="step-1",
            description="Test step",
            status="running"
        )
        
        bus.publish_sync(event)
        
        assert len(received_1) == 1
        assert len(received_2) == 1
    
    @pytest.mark.asyncio
    async def test_async_publish(self):
        """Test async event publishing."""
        bus = EventBus()
        received_events = []
        
        async def async_handler(event):
            received_events.append(event)
        
        bus.subscribe(EventType.TASK_COMPLETED, async_handler)
        
        event = create_task_event(
            event_type=EventType.TASK_COMPLETED,
            task_id="task-123",
            user_request="test",
            state="completed"
        )
        
        await bus.publish(event)
        
        assert len(received_events) == 1
    
    def test_clear_subscriptions(self):
        """Test clearing all subscriptions."""
        bus = EventBus()
        
        def handler(event):
            pass
        
        bus.subscribe(EventType.TASK_CREATED, handler)
        bus.subscribe(EventType.TASK_COMPLETED, handler)
        
        assert bus.get_subscriber_count(EventType.TASK_CREATED) == 1
        assert bus.get_subscriber_count(EventType.TASK_COMPLETED) == 1
        
        bus.clear()
        
        assert bus.get_subscriber_count(EventType.TASK_CREATED) == 0
        assert bus.get_subscriber_count(EventType.TASK_COMPLETED) == 0


class TestEventFactories:
    """Test event factory functions."""
    
    def test_create_task_event(self):
        """Test task event creation."""
        event = create_task_event(
            event_type=EventType.TASK_STARTED,
            task_id="task-123",
            user_request="Fix bug",
            state="analyzing",
            previous_state="created",
            source="test"
        )
        
        assert event.event_type == EventType.TASK_STARTED
        assert event.data.task_id == "task-123"
        assert event.data.user_request == "Fix bug"
        assert event.data.state == "analyzing"
        assert event.data.previous_state == "created"
        assert event.source == "test"
    
    def test_create_step_event(self):
        """Test step event creation."""
        event = create_step_event(
            event_type=EventType.STEP_COMPLETED,
            task_id="task-123",
            step_id="step-1",
            description="Read file",
            status="success"
        )
        
        assert event.event_type == EventType.STEP_COMPLETED
        assert event.data.step_id == "step-1"
        assert event.data.status == "success"
        assert event.data.error is None
    
    def test_create_tool_event(self):
        """Test tool event creation."""
        event = create_tool_event(
            event_type=EventType.TOOL_FINISHED,
            task_id="task-123",
            tool_name="files.read",
            call_id="call-456",
            success=True,
            step_id="step-1",
            duration_ms=150
        )
        
        assert event.event_type == EventType.TOOL_FINISHED
        assert event.data.tool_name == "files.read"
        assert event.data.success is True
        assert event.data.duration_ms == 150


class TestGlobalEventBus:
    """Test global event_bus singleton."""
    
    def test_global_bus_exists(self):
        """Test that global event_bus exists."""
        assert event_bus is not None
        assert isinstance(event_bus, EventBus)
    
    def test_global_bus_subscription(self):
        """Test subscribing to global bus."""
        received = []
        
        def handler(event):
            received.append(event)
        
        initial_count = event_bus.get_subscriber_count(EventType.TASK_CREATED)
        event_bus.subscribe(EventType.TASK_CREATED, handler)
        new_count = event_bus.get_subscriber_count(EventType.TASK_CREATED)
        
        assert new_count == initial_count + 1
        
        # Cleanup
        event_bus.unsubscribe(EventType.TASK_CREATED, handler)
