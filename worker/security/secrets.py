"""Secrets redaction for secure logging and LLM context."""

import re
from typing import Optional
from dataclasses import dataclass


@dataclass
class RedactionRule:
    """Rule for redacting sensitive information."""
    pattern: str
    replacement: str = "[REDACTED]"
    description: str = ""
    flags: int = re.IGNORECASE


class SecretsRedactor:
    """
    Redacts secrets and sensitive information from logs and contexts.
    
    Implements TZ section 20 (Secrets & Credentials) requirements:
    - Never write API keys in source code
    - Never save passwords in logs
    - Auto-redaction of common secret patterns
    - Support for custom secret patterns
    """
    
    def __init__(self):
        self._rules: list[RedactionRule] = []
        self._custom_secrets: dict[str, str] = {}  # name -> value mapping
        self._initialize_default_rules()
    
    def _initialize_default_rules(self) -> None:
        """Initialize default redaction rules for common secrets."""
        
        # API Keys (OpenAI, Anthropic, etc.)
        self.add_rule(RedactionRule(
            pattern=r"sk-[a-zA-Z0-9]{20,}",
            replacement="[API_KEY_REDACTED]",
            description="OpenAI-style API key"
        ))
        self.add_rule(RedactionRule(
            pattern=r"anthropic-[a-zA-Z0-9]{20,}",
            replacement="[API_KEY_REDACTED]",
            description="Anthropic API key"
        ))
        self.add_rule(RedactionRule(
            pattern=r"api[_-]?key['\"]?\s*[:=]\s*['\"]?[a-zA-Z0-9]{16,}",
            replacement="api_key=[API_KEY_REDACTED]",
            description="Generic API key assignment"
        ))
        
        # AWS Credentials
        self.add_rule(RedactionRule(
            pattern=r"AKIA[0-9A-Z]{16}",
            replacement="[AWS_ACCESS_KEY_REDACTED]",
            description="AWS Access Key ID"
        ))
        self.add_rule(RedactionRule(
            pattern=r"aws[_-]?secret[_-]?access[_-]?key['\"]?\s*[:=]\s*['\"]?[a-zA-Z0-9/+=]{40}",
            replacement="aws_secret_access_key=[AWS_SECRET_REDACTED]",
            description="AWS Secret Access Key"
        ))
        
        # JWT Tokens
        self.add_rule(RedactionRule(
            pattern=r"eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*",
            replacement="[JWT_TOKEN_REDACTED]",
            description="JWT token"
        ))
        
        # Passwords in URLs
        self.add_rule(RedactionRule(
            pattern=r"://[^:]+:[^@]+@",
            replacement="://[CREDENTIALS_REDACTED]@",
            description="Password in URL"
        ))
        
        # Private Keys
        self.add_rule(RedactionRule(
            pattern=r"-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----",
            replacement="[PRIVATE_KEY_REDACTED]",
            description="Private key block",
            flags=re.DOTALL
        ))
        
        # GitHub Tokens
        self.add_rule(RedactionRule(
            pattern=r"gh[pousr]_[a-zA-Z0-9]{36}",
            replacement="[GITHUB_TOKEN_REDACTED]",
            description="GitHub personal access token"
        ))
        
        # Slack Tokens
        self.add_rule(RedactionRule(
            pattern=r"xox[baprs]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*",
            replacement="[SLACK_TOKEN_REDACTED]",
            description="Slack token"
        ))
        
        # Generic password patterns
        self.add_rule(RedactionRule(
            pattern=r"password['\"]?\s*[:=]\s*['\"]?[^'\",\s]+",
            replacement="password=[PASSWORD_REDACTED]",
            description="Password assignment"
        ))
        self.add_rule(RedactionRule(
            pattern=r"passwd['\"]?\s*[:=]\s*['\"]?[^'\",\s]+",
            replacement="passwd=[PASSWORD_REDACTED]",
            description="Passwd assignment"
        ))
        self.add_rule(RedactionRule(
            pattern=r"secret['\"]?\s*[:=]\s*['\"]?[^'\",\s]+",
            replacement="secret=[SECRET_REDACTED]",
            description="Secret assignment"
        ))
        
        # Connection strings
        self.add_rule(RedactionRule(
            pattern=r"(mongodb|postgres|mysql|redis)://[^\\s]+",
            replacement="[CONNECTION_STRING_REDACTED]",
            description="Database connection string"
        ))
        
        # Email addresses (optional, for privacy)
        # self.add_rule(RedactionRule(
        #     pattern=r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}",
        #     replacement="[EMAIL_REDACTED]",
        #     description="Email address"
        # ))
    
    def add_rule(self, rule: RedactionRule) -> None:
        """Add a custom redaction rule."""
        self._rules.append(rule)
    
    def clear_rules(self) -> None:
        """Clear all rules (useful for testing)."""
        self._rules.clear()
    
    def add_secret(self, name: str, value: str) -> None:
        """
        Add a custom secret to be redacted.
        
        Args:
            name: Identifier for the secret (e.g., "my_api_key")
            value: The actual secret value to redact
        """
        self._custom_secrets[name] = value
    
    def remove_secret(self, name: str) -> None:
        """Remove a custom secret."""
        self._custom_secrets.pop(name, None)
    
    def redact(self, text: str) -> str:
        """
        Redact all sensitive information from text.
        
        Args:
            text: Input text that may contain secrets
        
        Returns:
            Text with all secrets redacted
        """
        if not text:
            return text
        
        result = text
        
        # First, redact custom secrets (exact matches)
        for name, value in self._custom_secrets.items():
            if value and len(value) > 3:  # Don't redact very short values
                result = result.replace(value, f"[{name.upper()}_REDACTED]")
        
        # Then apply regex rules
        for rule in self._rules:
            try:
                result = re.sub(rule.pattern, rule.replacement, result, flags=rule.flags)
            except re.error:
                # Skip invalid patterns
                continue
        
        return result
    
    def redact_dict(self, data: dict, depth: int = 0, max_depth: int = 10) -> dict:
        """
        Recursively redact sensitive information from a dictionary.
        
        Args:
            data: Dictionary that may contain secrets
            depth: Current recursion depth
            max_depth: Maximum recursion depth
        
        Returns:
            Dictionary with all secrets redacted
        """
        if depth > max_depth:
            return data
        
        result = {}
        for key, value in data.items():
            if isinstance(value, str):
                result[key] = self.redact(value)
            elif isinstance(value, dict):
                result[key] = self.redact_dict(value, depth + 1, max_depth)
            elif isinstance(value, list):
                result[key] = self.redact_list(value, depth + 1, max_depth)
            else:
                result[key] = value
        
        return result
    
    def redact_list(self, data: list, depth: int = 0, max_depth: int = 10) -> list:
        """
        Recursively redact sensitive information from a list.
        
        Args:
            data: List that may contain secrets
            depth: Current recursion depth
            max_depth: Maximum recursion depth
        
        Returns:
            List with all secrets redacted
        """
        if depth > max_depth:
            return data
        
        result = []
        for item in data:
            if isinstance(item, str):
                result.append(self.redact(item))
            elif isinstance(item, dict):
                result.append(self.redact_dict(item, depth + 1, max_depth))
            elif isinstance(item, list):
                result.append(self.redact_list(item, depth + 1, max_depth))
            else:
                result.append(item)
        
        return result
    
    def redact_for_llm(self, prompt: str, context: Optional[dict] = None) -> str:
        """
        Redact secrets specifically for LLM prompts.
        
        Args:
            prompt: The prompt text
            context: Optional context dictionary
        
        Returns:
            Redacted prompt safe for LLM
        """
        result = self.redact(prompt)
        
        if context:
            # Redact context values but keep structure
            redacted_context = self.redact_dict(context)
            # Could append context info to prompt if needed
            # For now, just ensure it's redacted
        
        return result
    
    def get_redaction_summary(self) -> dict:
        """Get summary of active redaction rules."""
        return {
            "default_rules": len(self._rules),
            "custom_secrets": len(self._custom_secrets),
            "rule_descriptions": [
                {"pattern": r.pattern, "description": r.description}
                for r in self._rules
            ]
        }
    
    def is_potential_secret(self, text: str) -> bool:
        """
        Check if text potentially contains a secret.
        
        Args:
            text: Text to check
        
        Returns:
            True if text matches any secret pattern
        """
        for rule in self._rules:
            if re.search(rule.pattern, text, flags=rule.flags):
                return True
        
        # Check for custom secrets
        for value in self._custom_secrets.values():
            if value and value in text:
                return True
        
        return False
