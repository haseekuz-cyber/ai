"""
Core data models for WORKER agent system.

Defines typed models for:
- Task: Main unit of work with state machine
- Plan: Ordered list of steps to achieve objective
- Step: Individual executable action
- Tool: Capability definition
- ToolCall: Execution request and result
- Observation: Result of an action
- Verification: Validation of task completion
- PermissionRequest: Risk-based permission flow
- Artifact: Output files/results
- MemoryRecord: Persistent memory entry
"""

from enum import Enum
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Literal
from pydantic import BaseModel, Field, ConfigDict
import uuid


# ============================================================
# TASK STATE MACHINE
# ============================================================

class TaskState(str, Enum):
    """Task lifecycle states."""
    CREATED = "created"
    ANALYZING = "analyzing"
    PLANNING = "planning"
    EXECUTING = "executing"
    OBSERVING = "observing"
    VERIFYING = "verifying"
    COMPLETED = "completed"
    
    # Additional states
    WAITING_FOR_PERMISSION = "waiting_for_permission"
    WAITING_FOR_USER = "waiting_for_user"
    RETRYING = "retrying"
    BLOCKED = "blocked"
    FAILED = "failed"
    CANCELLED = "cancelled"


class StepStatus(str, Enum):
    """Step execution status."""
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"


class RiskLevel(str, Enum):
    """Permission risk levels."""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


# ============================================================
# CORE MODELS
# ============================================================

class Task(BaseModel):
    """
    Main task representation with full state tracking.
    Serializable and recoverable after restart.
    """
    task_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_request: str
    objective: str
    
    # State
    current_state: TaskState = TaskState.CREATED
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: Optional[datetime] = None
    
    # Planning
    plan: Optional["Plan"] = None
    current_step_index: int = 0
    
    # Execution tracking
    completed_steps: List[str] = Field(default_factory=list)  # step_ids
    tool_calls: List["ToolCall"] = Field(default_factory=list)
    observations: List["Observation"] = Field(default_factory=list)
    errors: List[str] = Field(default_factory=list)
    
    # Retry control
    retries: int = 0
    max_retries: int = 5
    
    # Results
    artifacts: List["Artifact"] = Field(default_factory=list)
    final_result: Optional[str] = None
    
    # Context
    memory_context: Dict[str, Any] = Field(default_factory=dict)
    permissions: Dict[str, bool] = Field(default_factory=dict)  # tool_name -> granted
    
    # Control
    cancelled: bool = False
    paused: bool = False
    
    model_config = ConfigDict(
        json_encoders={
            datetime: lambda v: v.isoformat(),
        }
    )


class Step(BaseModel):
    """
    Individual step in a plan.
    """
    step_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    description: str
    action: str  # tool name or action type
    parameters: Dict[str, Any] = Field(default_factory=dict)
    dependencies: List[str] = Field(default_factory=list)  # step_ids
    
    # Status
    status: StepStatus = StepStatus.PENDING
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    
    # Result
    result: Optional[Any] = None
    error: Optional[str] = None
    
    # Retry
    retry_count: int = 0
    max_retries: int = 3


class Plan(BaseModel):
    """
    Ordered list of steps to achieve task objective.
    """
    plan_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    task_id: str
    objective: str
    steps: List[Step] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    
    # Planning metadata
    strategy: Optional[str] = None
    assumptions: List[str] = Field(default_factory=list)
    risks: List[str] = Field(default_factory=list)
    
    def get_next_step(self) -> Optional[Step]:
        """Get the next pending step."""
        for i, step in enumerate(self.steps):
            if step.status == StepStatus.PENDING:
                # Check dependencies
                deps_met = all(
                    any(s.step_id == dep and s.status == StepStatus.SUCCESS 
                        for s in self.steps)
                    for dep in step.dependencies
                )
                if deps_met:
                    return step
        return None
    
    def get_current_step(self, current_index: int) -> Optional[Step]:
        """Get step at current index."""
        if 0 <= current_index < len(self.steps):
            return self.steps[current_index]
        return None


# ============================================================
# TOOL MODELS
# ============================================================

class ToolCategory(str, Enum):
    """Tool categories."""
    SYSTEM = "system"
    TERMINAL = "terminal"
    FILESYSTEM = "filesystem"
    CODE = "code"
    GIT = "git"
    BROWSER = "browser"
    COMPUTER = "computer"
    SCREEN = "screen"
    GENERATED = "generated"


class ToolSchema(BaseModel):
    """JSON schema for tool input/output."""
    type: str = "object"
    properties: Dict[str, Any] = Field(default_factory=dict)
    required: List[str] = Field(default_factory=list)
    additionalProperties: bool = False


class Tool(BaseModel):
    """
    Tool definition with interface contract.
    """
    name: str
    description: str
    category: ToolCategory
    input_schema: ToolSchema
    output_schema: ToolSchema
    permission_level: RiskLevel = RiskLevel.MEDIUM
    timeout: int = 60  # seconds
    version: str = "1.0.0"
    enabled: bool = True
    
    # Metadata
    source: Optional[str] = None  # file path or "generated"
    health_status: bool = True
    last_health_check: Optional[datetime] = None


class ToolCall(BaseModel):
    """
    Record of a tool execution.
    """
    call_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    task_id: str
    tool_name: str
    step_id: Optional[str] = None
    
    # Execution
    input_data: Dict[str, Any] = Field(default_factory=dict)
    started_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: Optional[datetime] = None
    
    # Result
    success: bool = False
    data: Optional[Any] = None
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    error: Optional[str] = None
    
    # Artifacts
    artifacts: List[str] = Field(default_factory=list)  # file paths
    metadata: Dict[str, Any] = Field(default_factory=dict)
    
    duration_ms: Optional[int] = None


# ============================================================
# OBSERVATION & VERIFICATION
# ============================================================

class Observation(BaseModel):
    """
    Structured observation after an action.
    """
    observation_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    task_id: str
    step_id: Optional[str] = None
    tool_call_id: Optional[str] = None
    
    # What changed
    what_changed: str
    visible_state: Optional[str] = None
    process_state: Optional[Dict[str, Any]] = None
    
    # Diagnostics
    errors: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    
    # Confidence
    confidence: float = 1.0  # 0.0 to 1.0
    
    # References
    screenshot_ref: Optional[str] = None  # file path
    raw_output: Optional[Any] = None
    
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class Verification(BaseModel):
    """
    Verification result for task/step completion.
    """
    verification_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    task_id: str
    step_id: Optional[str] = None
    
    # Result
    passed: bool
    goal_reached: bool = False
    
    # Details
    checks_performed: List[str] = Field(default_factory=list)
    check_results: Dict[str, bool] = Field(default_factory=dict)
    
    # Evidence
    evidence: List[str] = Field(default_factory=list)  # artifact refs
    
    message: Optional[str] = None
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# ============================================================
# PERMISSION & SECURITY
# ============================================================

class PermissionRequest(BaseModel):
    """
    Request for permission to execute high-risk action.
    """
    request_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    task_id: str
    tool_name: str
    action: str
    risk_level: RiskLevel
    
    # Context
    reason: str
    potential_impact: str
    
    # Status
    status: Literal["pending", "granted", "denied", "expired"] = "pending"
    requested_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    responded_at: Optional[datetime] = None
    response_by: Optional[str] = None  # "user" or "policy"


# ============================================================
# ARTIFACTS & MEMORY
# ============================================================

class Artifact(BaseModel):
    """
    Output artifact from task execution.
    """
    artifact_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    task_id: str
    name: str
    type: str  # "file", "screenshot", "log", "patch", etc.
    path: str  # file system path
    size_bytes: Optional[int] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    metadata: Dict[str, Any] = Field(default_factory=dict)


class MemoryType(str, Enum):
    """Memory types."""
    WORKING = "working"
    EPISODIC = "episodic"
    SEMANTIC = "semantic"
    TOOL = "tool"


class MemoryRecord(BaseModel):
    """
    Persistent memory record.
    """
    record_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    memory_type: MemoryType
    task_id: Optional[str] = None
    
    # Content
    key: str
    value: Any
    
    # Metadata
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    access_count: int = 0
    tags: List[str] = Field(default_factory=list)
    
    # Expiration (optional)
    expires_at: Optional[datetime] = None


# Update forward references
Task.model_rebuild()
Plan.model_rebuild()
