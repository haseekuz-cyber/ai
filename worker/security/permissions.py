"""Permission engine for controlling tool access based on risk and policies."""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional, Callable, Awaitable
import uuid

from worker.security.risk import RiskLevel, RiskClassifier, RiskAssessment


class PermissionStatus(Enum):
    """Status of a permission request."""
    PENDING = "pending"
    GRANTED = "granted"
    DENIED = "denied"
    EXPIRED = "expired"
    REVOKED = "revoked"


class SecurityMode(Enum):
    """Security modes for the permission engine."""
    STRICT = "strict"  # Require explicit approval for HIGH risk
    PERMISSIVE = "permissive"  # Auto-approve LOW/MEDIUM in dev
    SANDBOX = "sandbox"  # Block HIGH risk entirely
    CUSTOM = "custom"  # Use custom policy functions


@dataclass
class PermissionRequest:
    """Request for permission to perform an action."""
    request_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    task_id: Optional[str] = None
    tool_name: str = ""
    action: Optional[str] = None
    context: dict = field(default_factory=dict)
    risk_assessment: Optional[RiskAssessment] = None
    requested_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    expires_at: Optional[datetime] = None
    status: PermissionStatus = PermissionStatus.PENDING
    reason: Optional[str] = None
    
    def to_dict(self) -> dict:
        """Convert to dictionary for serialization."""
        return {
            "request_id": self.request_id,
            "task_id": self.task_id,
            "tool_name": self.tool_name,
            "action": self.action,
            "context": self.context,
            "risk_level": self.risk_assessment.risk_level.value if self.risk_assessment else None,
            "requested_at": self.requested_at.isoformat(),
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "status": self.status.value,
            "reason": self.reason
        }


@dataclass
class PermissionDecision:
    """Decision on a permission request."""
    request_id: str
    granted: bool
    decided_by: str  # "auto", "user", "policy"
    decision_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    reason: Optional[str] = None
    conditions: list[str] = field(default_factory=list)  # Conditions for the permission
    duration_seconds: Optional[int] = None  # How long the permission is valid
    
    def to_dict(self) -> dict:
        """Convert to dictionary for serialization."""
        return {
            "request_id": self.request_id,
            "granted": self.granted,
            "decided_by": self.decided_by,
            "decision_at": self.decision_at.isoformat(),
            "reason": self.reason,
            "conditions": self.conditions,
            "duration_seconds": self.duration_seconds
        }


@dataclass
class SecurityPolicy:
    """Security policy configuration."""
    mode: SecurityMode = SecurityMode.PERMISSIVE
    auto_approve_low: bool = True
    auto_approve_medium: bool = True  # In dev/permissive mode
    require_approval_high: bool = True
    block_critical: bool = True
    custom_checks: list[Callable[[PermissionRequest], bool]] = field(default_factory=list)
    allowed_tools: Optional[set[str]] = None  # Whitelist of allowed tools
    blocked_tools: Optional[set[str]] = None  # Blacklist of blocked tools
    max_risk_level: RiskLevel = RiskLevel.HIGH  # Maximum allowed risk level
    
    def to_dict(self) -> dict:
        """Convert to dictionary for serialization."""
        return {
            "mode": self.mode.value,
            "auto_approve_low": self.auto_approve_low,
            "auto_approve_medium": self.auto_approve_medium,
            "require_approval_high": self.require_approval_high,
            "block_critical": self.block_critical,
            "allowed_tools": list(self.allowed_tools) if self.allowed_tools else None,
            "blocked_tools": list(self.blocked_tools) if self.blocked_tools else None,
            "max_risk_level": self.max_risk_level.value
        }


class PermissionEngine:
    """
    Engine for managing permissions based on risk assessment and security policies.
    
    Implements TZ section 19 (Permission Engine) and section 20 (Secrets).
    """
    
    def __init__(self, policy: Optional[SecurityPolicy] = None):
        self._policy = policy or SecurityPolicy()
        self._risk_classifier = RiskClassifier()
        self._pending_requests: dict[str, PermissionRequest] = {}
        self._granted_permissions: dict[str, PermissionDecision] = {}
        self._approval_callback: Optional[Callable[[PermissionRequest], Awaitable[bool]]] = None
        self._audit_callback: Optional[Callable[[PermissionRequest, PermissionDecision], None]] = None
    
    def set_policy(self, policy: SecurityPolicy) -> None:
        """Update the security policy."""
        self._policy = policy
    
    def get_policy(self) -> SecurityPolicy:
        """Get the current security policy."""
        return self._policy
    
    def set_approval_callback(
        self,
        callback: Callable[[PermissionRequest], Awaitable[bool]]
    ) -> None:
        """
        Set a callback for user approval requests.
        
        Args:
            callback: Async function that takes PermissionRequest and returns bool
        """
        self._approval_callback = callback
    
    def set_audit_callback(
        self,
        callback: Callable[[PermissionRequest, PermissionDecision], None]
    ) -> None:
        """
        Set a callback for audit logging.
        
        Args:
            callback: Function that takes PermissionRequest and PermissionDecision
        """
        self._audit_callback = callback
    
    async def request_permission(
        self,
        tool_name: str,
        action: Optional[str] = None,
        context: Optional[dict] = None,
        task_id: Optional[str] = None
    ) -> PermissionDecision:
        """
        Request permission to perform an action.
        
        Args:
            tool_name: Name of the tool requesting permission
            action: Specific action being performed
            context: Additional context about the operation
            task_id: ID of the task making the request
        
        Returns:
            PermissionDecision with grant/deny status
        """
        context = context or {}
        
        # Assess risk
        risk_assessment = self._risk_classifier.assess_risk(
            tool_name=tool_name,
            action=action,
            context=context
        )
        
        # Create permission request
        request = PermissionRequest(
            task_id=task_id,
            tool_name=tool_name,
            action=action,
            context=context,
            risk_assessment=risk_assessment,
            expires_at=datetime.now(timezone.utc).replace(hour=23, minute=59, second=59)
        )
        
        self._pending_requests[request.request_id] = request
        
        # Make decision
        decision = self._make_decision(request)
        
        # Update request status
        request.status = PermissionStatus.GRANTED if decision.granted else PermissionStatus.DENIED
        request.reason = decision.reason
        
        # Audit logging
        if self._audit_callback:
            self._audit_callback(request, decision)
        
        return decision
    
    def _make_decision(self, request: PermissionRequest) -> PermissionDecision:
        """Make a permission decision based on policy and risk assessment."""
        risk = request.risk_assessment
        if not risk:
            return PermissionDecision(
                request_id=request.request_id,
                granted=False,
                decided_by="policy",
                reason="No risk assessment available"
            )
        
        # Check tool whitelist/blacklist
        if self._policy.allowed_tools and request.tool_name not in self._policy.allowed_tools:
            return PermissionDecision(
                request_id=request.request_id,
                granted=False,
                decided_by="policy",
                reason=f"Tool '{request.tool_name}' is not in the allowed list"
            )
        
        if self._policy.blocked_tools and request.tool_name in self._policy.blocked_tools:
            return PermissionDecision(
                request_id=request.request_id,
                granted=False,
                decided_by="policy",
                reason=f"Tool '{request.tool_name}' is blocked"
            )
        
        # Check maximum risk level
        if self._risk_level_value(risk.risk_level) > self._risk_level_value(self._policy.max_risk_level):
            return PermissionDecision(
                request_id=request.request_id,
                granted=False,
                decided_by="policy",
                reason=f"Risk level '{risk.risk_level.value}' exceeds maximum allowed '{self._policy.max_risk_level.value}'"
            )
        
        # Run custom checks
        for check in self._policy.custom_checks:
            try:
                if not check(request):
                    return PermissionDecision(
                        request_id=request.request_id,
                        granted=False,
                        decided_by="policy",
                        reason="Failed custom security check"
                    )
            except Exception as e:
                return PermissionDecision(
                    request_id=request.request_id,
                    granted=False,
                    decided_by="policy",
                    reason=f"Custom check error: {str(e)}"
                )
        
        # Apply policy based on mode
        if self._policy.mode == SecurityMode.SANDBOX:
            if risk.risk_level in (RiskLevel.HIGH, RiskLevel.CRITICAL):
                return PermissionDecision(
                    request_id=request.request_id,
                    granted=False,
                    decided_by="policy",
                    reason="Sandbox mode blocks HIGH and CRITICAL risk actions"
                )
        
        if self._policy.mode == SecurityMode.STRICT:
            if risk.requires_approval:
                # Would need user approval - return pending for now
                # In real implementation, this would wait for user input
                return PermissionDecision(
                    request_id=request.request_id,
                    granted=False,
                    decided_by="policy",
                    reason="Strict mode requires user approval for this action",
                    conditions=["user_approval_required"]
                )
        
        # Permissive mode or auto-approvable risks
        if risk.risk_level == RiskLevel.LOW and self._policy.auto_approve_low:
            return PermissionDecision(
                request_id=request.request_id,
                granted=True,
                decided_by="auto",
                reason="Low risk action auto-approved"
            )
        
        if risk.risk_level == RiskLevel.MEDIUM and self._policy.auto_approve_medium:
            return PermissionDecision(
                request_id=request.request_id,
                granted=True,
                decided_by="auto",
                reason="Medium risk action auto-approved in permissive mode"
            )
        
        if risk.risk_level == RiskLevel.HIGH:
            if self._policy.require_approval_high:
                return PermissionDecision(
                    request_id=request.request_id,
                    granted=False,
                    decided_by="policy",
                    reason="High risk action requires user approval",
                    conditions=["user_approval_required"]
                )
            else:
                return PermissionDecision(
                    request_id=request.request_id,
                    granted=True,
                    decided_by="policy",
                    reason="High risk action approved by policy override"
                )
        
        if risk.risk_level == RiskLevel.CRITICAL:
            if self._policy.block_critical:
                return PermissionDecision(
                    request_id=request.request_id,
                    granted=False,
                    decided_by="policy",
                    reason="Critical risk actions are blocked by default"
                )
        
        # Default deny
        return PermissionDecision(
            request_id=request.request_id,
            granted=False,
            decided_by="policy",
            reason="Default deny - no matching approval rule"
        )
    
    def _risk_level_value(self, level: RiskLevel) -> int:
        """Convert RiskLevel to numeric value for comparison."""
        values = {
            RiskLevel.LOW: 0,
            RiskLevel.MEDIUM: 1,
            RiskLevel.HIGH: 2,
            RiskLevel.CRITICAL: 3
        }
        return values.get(level, 0)
    
    def grant_permission(
        self,
        request_id: str,
        approver: str = "user",
        reason: Optional[str] = None,
        duration_seconds: Optional[int] = 3600
    ) -> PermissionDecision:
        """Manually grant a pending permission request."""
        if request_id not in self._pending_requests:
            return PermissionDecision(
                request_id=request_id,
                granted=False,
                decided_by=approver,
                reason="Request not found"
            )
        
        request = self._pending_requests[request_id]
        request.status = PermissionStatus.GRANTED
        
        decision = PermissionDecision(
            request_id=request_id,
            granted=True,
            decided_by=approver,
            reason=reason or "Manually approved",
            duration_seconds=duration_seconds
        )
        
        self._granted_permissions[request_id] = decision
        
        if self._audit_callback:
            self._audit_callback(request, decision)
        
        return decision
    
    def deny_permission(
        self,
        request_id: str,
        denier: str = "user",
        reason: Optional[str] = None
    ) -> PermissionDecision:
        """Manually deny a pending permission request."""
        if request_id not in self._pending_requests:
            return PermissionDecision(
                request_id=request_id,
                granted=False,
                decided_by=denier,
                reason="Request not found"
            )
        
        request = self._pending_requests[request_id]
        request.status = PermissionStatus.DENIED
        
        decision = PermissionDecision(
            request_id=request_id,
            granted=False,
            decided_by=denier,
            reason=reason or "Manually denied"
        )
        
        if self._audit_callback:
            self._audit_callback(request, decision)
        
        return decision
    
    def check_permission(self, request_id: str) -> bool:
        """Check if a permission is currently valid."""
        if request_id not in self._granted_permissions:
            return False
        
        decision = self._granted_permissions[request_id]
        
        # Check expiration
        if decision.duration_seconds:
            elapsed = (datetime.now(timezone.utc) - decision.decision_at).total_seconds()
            if elapsed > decision.duration_seconds:
                return False
        
        return decision.granted
    
    def revoke_permission(self, request_id: str) -> bool:
        """Revoke a previously granted permission."""
        if request_id not in self._granted_permissions:
            return False
        
        decision = self._granted_permissions[request_id]
        decision.granted = False
        
        if request_id in self._pending_requests:
            self._pending_requests[request_id].status = PermissionStatus.REVOKED
        
        return True
    
    def get_pending_requests(self, task_id: Optional[str] = None) -> list[PermissionRequest]:
        """Get all pending permission requests, optionally filtered by task_id."""
        requests = list(self._pending_requests.values())
        if task_id:
            requests = [r for r in requests if r.task_id == task_id]
        return requests
    
    def get_risk_classifier(self) -> RiskClassifier:
        """Get the risk classifier instance."""
        return self._risk_classifier
