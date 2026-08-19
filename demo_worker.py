#!/usr/bin/env python3
"""
Demo script for WORKER - Phase 1 Core Agent.

This script demonstrates:
1. Creating a task
2. Planning execution
3. Executing filesystem and terminal operations
4. Observing results
5. Verifying completion

Scenario: Create a test file, read it, execute a command, verify results.
"""

import asyncio
import logging
from datetime import datetime

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


async def demo_worker_core():
    """Demonstrate WORKER core functionality."""
    
    print("=" * 60)
    print("WORKER CORE DEMO - Phase 1")
    print("=" * 60)
    
    # Import core components
    from worker.core import (
        Task, TaskState, TaskManager,
        Planner, Executor, Observer, Verifier,
        AgentLoop, event_bus, EventType
    )
    
    # Import tools to register them
    import worker.tools.filesystem
    import worker.tools.terminal
    import worker.tools.system
    
    from worker.core.tools import tool_registry
    
    print(f"\n✓ Loaded {len(tool_registry.list_tools())} registered tools")
    for tool in tool_registry.list_tools():
        print(f"  - {tool.name}: {tool.description}")
    
    # Create task manager
    task_manager = TaskManager()
    
    # Create task
    print("\n📝 Creating task...")
    task = await task_manager.create_task(
        user_request="Create a test file with 'Hello Worker!' content, read it back, then list directory contents",
        objective="Test filesystem operations and verify results"
    )
    print(f"✓ Task created: {task.task_id}")
    print(f"  Objective: {task.objective}")
    print(f"  State: {task.current_state}")
    
    # Subscribe to events
    received_events = []
    
    def on_event(event):
        received_events.append({
            'type': event.event_type.value,
            'timestamp': event.timestamp.isoformat(),
            'data': getattr(event, 'data', None)
        })
        logger.info(f"Event: {event.event_type.value}")
    
    event_bus.subscribe(EventType.TASK_STARTED, on_event)
    event_bus.subscribe(EventType.PLAN_CREATED, on_event)
    event_bus.subscribe(EventType.STEP_COMPLETED, on_event)
    event_bus.subscribe(EventType.TOOL_FINISHED, on_event)
    event_bus.subscribe(EventType.OBSERVATION_CREATED, on_event)
    event_bus.subscribe(EventType.VERIFICATION_PASSED, on_event)
    event_bus.subscribe(EventType.VERIFICATION_FAILED, on_event)
    event_bus.subscribe(EventType.TASK_COMPLETED, on_event)
    
    # Create core components
    planner = Planner()
    executor = Executor()
    observer = Observer()
    verifier = Verifier()
    
    # Create agent loop
    agent_loop = AgentLoop(
        task_manager=task_manager,
        planner=planner,
        executor=executor,
        observer=observer,
        verifier=verifier,
        max_iterations=20,
        step_timeout=60,
        global_timeout=300
    )
    
    print("\n🚀 Starting agent loop...")
    print("-" * 60)
    
    # Execute task
    success = await agent_loop.start_task(task.task_id)
    
    print("-" * 60)
    
    # Get final task state
    final_task = task_manager.get_task(task.task_id)
    
    print(f"\n✅ Task completed: {success}")
    print(f"  Final state: {final_task.current_state}")
    print(f"  Steps executed: {len(final_task.completed_steps)}")
    print(f"  Tool calls: {len(final_task.tool_calls)}")
    print(f"  Observations: {len(final_task.observations)}")
    
    if final_task.plan:
        print(f"\n📋 Plan summary:")
        for i, step in enumerate(final_task.plan.steps, 1):
            status_icon = "✓" if step.status.value == "success" else "✗" if step.status.value == "failed" else "○"
            print(f"  {i}. [{status_icon}] {step.description}")
            print(f"      Action: {step.action}")
            if step.result:
                result_preview = str(step.result)[:100] + "..." if len(str(step.result)) > 100 else str(step.result)
                print(f"      Result: {result_preview}")
    
    if final_task.errors:
        print(f"\n⚠️ Errors encountered: {len(final_task.errors)}")
        for error in final_task.errors:
            print(f"  - {error}")
    
    print(f"\n📊 Events captured: {len(received_events)}")
    event_types = {}
    for evt in received_events:
        event_types[evt['type']] = event_types.get(evt['type'], 0) + 1
    for evt_type, count in event_types.items():
        print(f"  - {evt_type}: {count}")
    
    print("\n" + "=" * 60)
    print("DEMO COMPLETED")
    print("=" * 60)
    
    return success


async def demo_manual_execution():
    """Demonstrate manual step-by-step execution."""
    
    print("\n" + "=" * 60)
    print("MANUAL EXECUTION DEMO")
    print("=" * 60)
    
    from worker.core import Task, TaskState, TaskManager, Planner, Executor, Observer, Verifier, StepStatus
    import worker.tools.filesystem
    import worker.tools.terminal
    
    # Setup
    task_manager = TaskManager()
    task = await task_manager.create_task(
        user_request="Manual test",
        objective="Test individual components"
    )
    
    planner = Planner()
    executor = Executor()
    observer = Observer()
    verifier = Verifier()
    
    # Step 1: Create a plan manually
    print("\n1. Creating plan...")
    from worker.core.models import Plan, Step
    plan = Plan(
        task_id=task.task_id,
        objective="Write and read a test file",
        steps=[
            Step(
                description="Write test content to file",
                action="files.write",
                parameters={
                    "path": "/tmp/worker_test.txt",
                    "content": "Hello from WORKER!"
                }
            ),
            Step(
                description="Read the file back",
                action="files.read",
                parameters={
                    "path": "/tmp/worker_test.txt"
                }
            ),
            Step(
                description="List /tmp directory",
                action="files.list",
                parameters={
                    "path": "/tmp"
                }
            )
        ]
    )
    task.plan = plan
    task.current_state = TaskState.PLANNING
    task_manager._tasks[task.task_id] = task
    
    print(f"   ✓ Plan created with {len(plan.steps)} steps")
    
    # Step 2: Execute each step
    print("\n2. Executing steps...")
    for step in plan.steps:
        print(f"\n   Executing: {step.description}")
        print(f"   Action: {step.action}")
        
        try:
            tool_call = await executor.execute_step(task, step, timeout=30)
            
            if tool_call.success:
                print(f"   ✓ Success")
                step.status = StepStatus.SUCCESS
                step.result = tool_call.data
                
                # Observe
                observation = await observer.observe_step(task, tool_call)
                task.observations.append(observation)
                print(f"   Observation: {observation.what_changed}")
            else:
                print(f"   ✗ Failed: {tool_call.error}")
                step.status = StepStatus.FAILED
                step.error = tool_call.error
            
            task.tool_calls.append(tool_call)
            
        except Exception as e:
            print(f"   ✗ Error: {e}")
            step.status = StepStatus.FAILED
            step.error = str(e)
    
    # Step 3: Verify
    print("\n3. Verifying results...")
    verification = await verifier.verify_task(task)
    print(f"   Verification passed: {verification.passed}")
    print(f"   Goal reached: {verification.goal_reached}")
    if verification.message:
        print(f"   Message: {verification.message}")
    
    # Summary
    print("\n4. Summary:")
    successful_steps = sum(1 for s in plan.steps if s.status.value == "success")
    print(f"   Steps: {successful_steps}/{len(plan.steps)} successful")
    print(f"   Tool calls: {len(task.tool_calls)}")
    print(f"   Observations: {len(task.observations)}")
    
    return successful_steps == len(plan.steps)


async def main():
    """Run all demos."""
    
    try:
        # Demo 1: Full agent loop
        result1 = await demo_worker_core()
        
        # Demo 2: Manual execution
        result2 = await demo_manual_execution()
        
        print("\n" + "=" * 60)
        print("FINAL RESULTS")
        print("=" * 60)
        print(f"Agent Loop Demo: {'✓ PASSED' if result1 else '✗ FAILED'}")
        print(f"Manual Demo: {'✓ PASSED' if result2 else '✗ FAILED'}")
        print("=" * 60)
        
    except Exception as e:
        logger.exception(f"Demo failed: {e}")
        raise


if __name__ == "__main__":
    asyncio.run(main())
