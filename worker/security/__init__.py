"""Security module for WORKER - Permissions, Audit, and Emergency Stop."""

from worker.security.risk import RiskLevel, RiskClassifier
from worker.security.permissions import PermissionEngine, SecurityPolicy, PermissionRequest, PermissionDecision
from worker.security.audit_log import AuditLogger, AuditRecord
from worker.security.secrets import SecretsRedactor
from worker.security.emergency_stop import (
    EmergencyStop,
    EmergencyStopException,
    trigger_emergency_stop,
    is_emergency_stop_triggered,
    check_emergency_stop,
    reset_emergency_stop,
    get_emergency_stop_status,
)

__all__ = [
    "RiskLevel",
    "RiskClassifier",
    "PermissionEngine",
    "SecurityPolicy",
    "PermissionRequest",
    "PermissionDecision",
    "AuditLogger",
    "AuditRecord",
    "SecretsRedactor",
    "EmergencyStop",
    "EmergencyStopException",
    "trigger_emergency_stop",
    "is_emergency_stop_triggered",
    "check_emergency_stop",
    "reset_emergency_stop",
    "get_emergency_stop_status",
]
