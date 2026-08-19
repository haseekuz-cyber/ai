"""Risk classification for tool actions."""

from enum import Enum
from dataclasses import dataclass
from typing import Optional, Set
import re


class RiskLevel(Enum):
    """Levels of risk for actions."""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class RiskRule:
    """Rule for classifying risk of an action."""
    pattern: str  # Regex pattern to match tool name or action
    risk_level: RiskLevel
    description: str
    contexts: Optional[Set[str]] = None  # Specific contexts where this rule applies


@dataclass
class RiskAssessment:
    """Result of risk assessment for an action."""
    risk_level: RiskLevel
    reason: str
    matched_rules: list[RiskRule]
    requires_approval: bool
    suggested_policy: Optional[str] = None


class RiskClassifier:
    """Classifies the risk level of tool actions based on rules and context."""
    
    def __init__(self):
        self._rules: list[RiskRule] = []
        self._default_risk = RiskLevel.MEDIUM
        self._initialize_default_rules()
    
    def _initialize_default_rules(self) -> None:
        """Initialize default risk classification rules based on TZ section 19."""
        
        # LOW RISK - Safe diagnostic and read operations
        self.add_rule(RiskRule(
            pattern=r"^files\.read$",
            risk_level=RiskLevel.LOW,
            description="Reading files is low risk"
        ))
        self.add_rule(RiskRule(
            pattern=r"^files\.list$",
            risk_level=RiskLevel.LOW,
            description="Listing directory contents is low risk"
        ))
        self.add_rule(RiskRule(
            pattern=r"^files\.copy$",
            risk_level=RiskLevel.LOW,
            description="Copying files is low risk"
        ))
        self.add_rule(RiskRule(
            pattern=r"^screen\.",
            risk_level=RiskLevel.LOW,
            description="Screen capture is low risk"
        ))
        self.add_rule(RiskRule(
            pattern=r"^system\.process_list$",
            risk_level=RiskLevel.LOW,
            description="Listing processes is low risk"
        ))
        self.add_rule(RiskRule(
            pattern=r"^system\.info$",
            risk_level=RiskLevel.LOW,
            description="Getting system info is low risk"
        ))
        self.add_rule(RiskRule(
            pattern=r"^system\.resources$",
            risk_level=RiskLevel.LOW,
            description="Getting resource usage is low risk"
        ))
        self.add_rule(RiskRule(
            pattern=r"^ui\.",
            risk_level=RiskLevel.LOW,
            description="UI automation (read-only) is low risk"
        ))
        self.add_rule(RiskRule(
            pattern=r"^browser\.(get_url|get_title|read|find_element|count_elements|element_exists)$",
            risk_level=RiskLevel.LOW,
            description="Browser read operations are low risk"
        ))
        
        # MEDIUM RISK - Modifications and executions
        self.add_rule(RiskRule(
            pattern=r"^files\.write$",
            risk_level=RiskLevel.MEDIUM,
            description="Writing files can modify project state"
        ))
        self.add_rule(RiskRule(
            pattern=r"^files\.delete$",
            risk_level=RiskLevel.MEDIUM,
            description="Deleting files can remove important data"
        ))
        self.add_rule(RiskRule(
            pattern=r"^terminal\.",
            risk_level=RiskLevel.MEDIUM,
            description="Terminal commands can modify system state"
        ))
        self.add_rule(RiskRule(
            pattern=r"^powershell\.",
            risk_level=RiskLevel.MEDIUM,
            description="PowerShell commands can modify system state"
        ))
        self.add_rule(RiskRule(
            pattern=r"^python\.",
            risk_level=RiskLevel.MEDIUM,
            description="Running Python code can execute arbitrary logic"
        ))
        self.add_rule(RiskRule(
            pattern=r"^git\.(status|diff|log|branch)$",
            risk_level=RiskLevel.LOW,
            description="Git read operations are low risk"
        ))
        self.add_rule(RiskRule(
            pattern=r"^git\.(add|commit|checkout|merge|rebase)$",
            risk_level=RiskLevel.MEDIUM,
            description="Git modifications can change project history"
        ))
        self.add_rule(RiskRule(
            pattern=r"^mouse\.",
            risk_level=RiskLevel.MEDIUM,
            description="Mouse control can interact with applications"
        ))
        self.add_rule(RiskRule(
            pattern=r"^keyboard\.",
            risk_level=RiskLevel.MEDIUM,
            description="Keyboard input can interact with applications"
        ))
        self.add_rule(RiskRule(
            pattern=r"^browser\.(open|close|navigate|click|type|press|hover|select|check|uncheck|go_back|go_forward|refresh|evaluate)$",
            risk_level=RiskLevel.MEDIUM,
            description="Browser interactions can change web application state"
        ))
        self.add_rule(RiskRule(
            pattern=r"^app\.",
            risk_level=RiskLevel.MEDIUM,
            description="Application control can modify app state"
        ))
        
        # HIGH RISK - Destructive or sensitive operations
        self.add_rule(RiskRule(
            pattern=r"^git\.(reset|clean)$",
            risk_level=RiskLevel.HIGH,
            description="Git reset/clean can destroy uncommitted changes"
        ))
        self.add_rule(RiskRule(
            pattern=r"^(rm|del|rmdir)",
            risk_level=RiskLevel.HIGH,
            description="Direct removal commands can delete critical files"
        ))
        self.add_rule(RiskRule(
            pattern=r"^(chmod|chown|icacls)",
            risk_level=RiskLevel.HIGH,
            description="Permission changes can affect system security"
        ))
        self.add_rule(RiskRule(
            pattern=r"^(netsh|iptables|firewall)",
            risk_level=RiskLevel.HIGH,
            description="Firewall changes can affect network security"
        ))
        self.add_rule(RiskRule(
            pattern=r"^(reg\s|regedit)",
            risk_level=RiskLevel.HIGH,
            description="Registry modifications can affect system stability"
        ))
        self.add_rule(RiskRule(
            pattern=r".*password.*",
            risk_level=RiskLevel.HIGH,
            description="Operations involving passwords are high risk",
            contexts={"credentials"}
        ))
        self.add_rule(RiskRule(
            pattern=r".*secret.*",
            risk_level=RiskLevel.HIGH,
            description="Operations involving secrets are high risk",
            contexts={"credentials"}
        ))
        self.add_rule(RiskRule(
            pattern=r".*api[_-]?key.*",
            risk_level=RiskLevel.HIGH,
            description="Operations involving API keys are high risk",
            contexts={"credentials"}
        ))
        self.add_rule(RiskRule(
            pattern=r"^(shutdown|restart|poweroff)",
            risk_level=RiskLevel.HIGH,
            description="System power commands are high risk"
        ))
        self.add_rule(RiskRule(
            pattern=r"^format",
            risk_level=RiskLevel.HIGH,
            description="Formatting drives is high risk"
        ))
        
        # CRITICAL RISK - Extremely dangerous operations
        self.add_rule(RiskRule(
            pattern=r"^(dd|mkfs|fdisk|parted)",
            risk_level=RiskLevel.CRITICAL,
            description="Disk operations can destroy data"
        ))
        self.add_rule(RiskRule(
            pattern=r"^sudo.*(rm|format|dd)",
            risk_level=RiskLevel.CRITICAL,
            description="Sudo destructive commands are critical risk"
        ))
    
    def add_rule(self, rule: RiskRule) -> None:
        """Add a risk classification rule."""
        self._rules.append(rule)
    
    def clear_rules(self) -> None:
        """Clear all rules (useful for testing)."""
        self._rules.clear()
    
    def assess_risk(
        self,
        tool_name: str,
        action: Optional[str] = None,
        context: Optional[dict] = None
    ) -> RiskAssessment:
        """
        Assess the risk level of a tool action.
        
        Args:
            tool_name: Name of the tool (e.g., "files.write")
            action: Specific action being performed
            context: Additional context about the operation
        
        Returns:
            RiskAssessment with risk level and reasoning
        """
        matched_rules: list[RiskRule] = []
        highest_risk = RiskLevel.LOW
        reasons: list[str] = []
        
        # Combine tool_name and action for matching
        target = f"{tool_name}.{action}" if action else tool_name
        
        for rule in self._rules:
            if re.match(rule.pattern, target, re.IGNORECASE):
                # Check context if specified
                if rule.contexts:
                    if not context:
                        continue
                    has_context = any(ctx in context for ctx in rule.contexts)
                    if not has_context:
                        continue
                
                matched_rules.append(rule)
                reasons.append(rule.description)
                
                # Track highest risk level
                if self._risk_level_value(rule.risk_level) > self._risk_level_value(highest_risk):
                    highest_risk = rule.risk_level
        
        # If no rules matched, use default
        if not matched_rules:
            highest_risk = self._default_risk
            reasons.append("No specific rule matched, using default risk level")
        
        # Determine if approval is required
        requires_approval = highest_risk in (RiskLevel.HIGH, RiskLevel.CRITICAL)
        
        # Suggest policy based on risk
        suggested_policy = None
        if highest_risk == RiskLevel.LOW:
            suggested_policy = "auto_approve"
        elif highest_risk == RiskLevel.MEDIUM:
            suggested_policy = "auto_approve_in_dev"
        elif highest_risk == RiskLevel.HIGH:
            suggested_policy = "require_user_approval"
        elif highest_risk == RiskLevel.CRITICAL:
            suggested_policy = "block_or_require_explicit_override"
        
        return RiskAssessment(
            risk_level=highest_risk,
            reason="; ".join(reasons),
            matched_rules=matched_rules,
            requires_approval=requires_approval,
            suggested_policy=suggested_policy
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
    
    def set_default_risk(self, level: RiskLevel) -> None:
        """Set the default risk level for unmatched actions."""
        self._default_risk = level
    
    def get_risk_summary(self) -> dict:
        """Get summary of all registered rules by risk level."""
        summary = {level.value: [] for level in RiskLevel}
        for rule in self._rules:
            summary[rule.risk_level.value].append({
                "pattern": rule.pattern,
                "description": rule.description
            })
        return summary
