# WORKER - Local Autonomous AI Computer Agent

## Phase 0: Foundation — Complete ✅

### Overview

WORKER is a local AI operator that can see, understand, plan, act, observe, verify, and correct actions on your computer. This is **not** a chatbot — it's an **agentic execution system**.

### Architecture

```
USER → ASSISTANT → WORKER CORE → TOOLS → COMPUTER
                          ↓
                    OBSERVER → VERIFIER
```

### Core Components (Phase 0)

| Component | Status | Description |
|-----------|--------|-------------|
| **Models** | ✅ | Typed data models for Task, Plan, Step, Tool, Observation, Verification |
| **Event Bus** | ✅ | Pub/sub system for inter-module communication |
| **Tool Interface** | ✅ | Abstract base class and registry for tools |
| **Filesystem Tools** | ✅ | Read, write, list, copy, delete files |

### Task State Machine

```
CREATED → ANALYZING → PLANNING → EXECUTING → OBSERVING → VERIFYING → COMPLETED
                               ↓                                    ↓
                         WAITING_FOR_PERMISSION                FAILED/CANCELLED
```

### Quick Start

```bash
# Install dependencies
pip install pydantic pydantic-settings pytest pytest-asyncio

# Run tests
pytest tests/ -v

# Import core components
from worker.core import Task, TaskState, ToolRegistry, event_bus
from worker.tools.filesystem import FileReadTool, FileWriteTool
```

### Project Structure

```
worker/
├── __init__.py          # Package metadata
├── core/
│   ├── __init__.py      # Core exports
│   ├── models.py        # Task, Plan, Step, Tool models
│   ├── events.py        # Event bus and event types
│   └── tools.py         # BaseTool, ToolResult, ToolRegistry
├── tools/
│   ├── filesystem/      # File operations
│   ├── terminal/        # Shell commands (TODO)
│   ├── system/          # Process management (TODO)
│   ├── screen/          # Screenshots (TODO)
│   └── ...
├── llm/                 # LLM providers (TODO)
├── memory/              # Persistent memory (TODO)
├── policies/            # Permissions (TODO)
└── self_extension/      # Tool generation (TODO)

tests/
├── unit/                # Unit tests
└── integration/         # Integration tests
```

### Key Models

#### Task
```python
task = Task(
    user_request="Fix the bug in app.py",
    objective="Identify and fix the error"
)
# States: CREATED, ANALYZING, PLANNING, EXECUTING, OBSERVING, VERIFYING, COMPLETED
```

#### Plan
```python
plan = Plan(
    task_id=task.task_id,
    objective="Fix application",
    steps=[
        Step(description="Read source", action="files.read"),
        Step(description="Run tests", action="terminal.run"),
    ]
)
```

#### Tool
```python
class MyTool(BaseTool):
    name = "my.tool"
    category = ToolCategory.FILESYSTEM
    permission_level = RiskLevel.LOW
    
    async def execute(self, **kwargs) -> ToolResult:
        return ToolResult(success=True, data={...})
```

### Events

Available event types:
- `TASK_CREATED`, `TASK_STARTED`, `TASK_COMPLETED`, `TASK_FAILED`
- `PLAN_CREATED`, `STEP_STARTED`, `STEP_COMPLETED`
- `TOOL_REQUESTED`, `TOOL_STARTED`, `TOOL_FINISHED`
- `PERMISSION_REQUESTED`, `PERMISSION_GRANTED`, `PERMISSION_DENIED`
- `OBSERVATION_CREATED`, `VERIFICATION_PASSED`, `VERIFICATION_FAILED`
- `EMERGENCY_STOP`

Subscribe to events:
```python
from worker.core import event_bus, EventType

def on_task_complete(event):
    print(f"Task {event.data.task_id} completed!")

event_bus.subscribe(EventType.TASK_COMPLETED, on_task_complete)
```

### Available Tools

| Tool | Category | Risk | Description |
|------|----------|------|-------------|
| `files.read` | FILESYSTEM | LOW | Read file content |
| `files.write` | FILESYSTEM | MEDIUM | Write/create file |
| `files.list` | FILESYSTEM | LOW | List directory |
| `files.copy` | FILESYSTEM | MEDIUM | Copy file/directory |
| `files.delete` | FILESYSTEM | HIGH | Delete file/directory |

### Next Phases

| Phase | Components | Status |
|-------|------------|--------|
| **Phase 1** | Terminal, System tools | 🔄 In Progress |
| **Phase 2** | Screen capture, Vision | ⏳ Pending |
| **Phase 3** | Browser automation | ⏳ Pending |
| **Phase 4** | Memory persistence | ⏳ Pending |
| **Phase 5** | Permission engine | ⏳ Pending |
| **Phase 6** | LLM providers | ⏳ Pending |
| **Phase 7** | Planner, Executor, Observer, Verifier | ⏳ Pending |
| **Phase 8** | Self-extension | ⏳ Pending |

### Testing

All tests pass:
```
======================= 51 passed =======================
```

Run tests:
```bash
pytest tests/unit/ -v       # Unit tests
pytest tests/integration/ -v  # Integration tests
```

### License

MIT

---

**WORKER is under active development.** This is Phase 0 foundation. Computer control, vision, and full agent loop coming in subsequent phases.
