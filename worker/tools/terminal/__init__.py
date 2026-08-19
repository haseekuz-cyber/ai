"""
Terminal tools for WORKER.

Provides terminal/command-line execution:
- Run shell commands
- PowerShell execution
- Command timeout handling
- Output capture
"""

import asyncio
import subprocess
import platform
from typing import Any, Dict, Optional
from datetime import datetime, timezone
from pathlib import Path

from worker.core.tools import BaseTool, ToolResult, register_tool
from worker.core.models import ToolCategory, ToolSchema, RiskLevel


class TerminalRunTool(BaseTool):
    """Run a command in the system shell."""
    
    name = "terminal.run"
    description = "Execute a shell command with timeout and output capture"
    category = ToolCategory.TERMINAL
    permission_level = RiskLevel.MEDIUM
    timeout = 60
    
    def get_input_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "command": {"type": "string", "description": "Command to execute"},
                "cwd": {"type": "string", "description": "Working directory", "default": None},
                "timeout": {"type": "integer", "description": "Timeout in seconds", "default": 60},
                "shell": {"type": "boolean", "description": "Run in shell", "default": True}
            },
            required=["command"]
        )
    
    def get_output_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "stdout": {"type": "string"},
                "stderr": {"type": "string"},
                "return_code": {"type": "integer"},
                "duration_ms": {"type": "integer"}
            }
        )
    
    async def execute(self, **kwargs) -> ToolResult:
        command = kwargs.get("command")
        cwd = kwargs.get("cwd")
        timeout = kwargs.get("timeout", self.timeout)
        shell = kwargs.get("shell", True)
        
        start_time = datetime.now(timezone.utc)
        
        try:
            working_dir = Path(cwd) if cwd else Path.cwd()
            
            # Create subprocess
            process = await asyncio.create_subprocess_shell(
                command if shell else command[0],
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(working_dir),
                shell=shell
            )
            
            # Wait for completion with timeout
            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    process.communicate(),
                    timeout=timeout
                )
                
                stdout = stdout_bytes.decode('utf-8', errors='replace')
                stderr = stderr_bytes.decode('utf-8', errors='replace')
                return_code = process.returncode
                
            except asyncio.TimeoutError:
                # Kill process on timeout
                process.kill()
                await process.wait()
                return ToolResult(
                    success=False,
                    error=f"Command timed out after {timeout} seconds",
                    metadata={"timeout": timeout}
                )
            
            end_time = datetime.now(timezone.utc)
            duration_ms = int((end_time - start_time).total_seconds() * 1000)
            
            success = return_code == 0
            
            return ToolResult(
                success=success,
                data={
                    "return_code": return_code,
                    "duration_ms": duration_ms
                },
                stdout=stdout,
                stderr=stderr,
                duration_ms=duration_ms,
                metadata={
                    "command": command,
                    "cwd": str(working_dir),
                    "pid": process.pid
                }
            )
            
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to execute command: {str(e)}"
            )


class PowerShellRunTool(BaseTool):
    """Run a PowerShell command or script."""
    
    name = "powershell.run"
    description = "Execute a PowerShell command or script block"
    category = ToolCategory.TERMINAL
    permission_level = RiskLevel.MEDIUM
    timeout = 60
    
    def get_input_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "command": {"type": "string", "description": "PowerShell command or script"},
                "cwd": {"type": "string", "description": "Working directory", "default": None},
                "timeout": {"type": "integer", "description": "Timeout in seconds", "default": 60},
                "encoded": {"type": "boolean", "description": "Use Base64 encoding", "default": False}
            },
            required=["command"]
        )
    
    def get_output_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "stdout": {"type": "string"},
                "stderr": {"type": "string"},
                "exit_code": {"type": "integer"}
            }
        )
    
    async def execute(self, **kwargs) -> ToolResult:
        command = kwargs.get("command")
        cwd = kwargs.get("cwd")
        timeout = kwargs.get("timeout", self.timeout)
        encoded = kwargs.get("encoded", False)
        
        start_time = datetime.now(timezone.utc)
        
        try:
            # Build PowerShell command
            if encoded:
                import base64
                encoded_cmd = base64.b64encode(command.encode('utf-16-le')).decode('ascii')
                ps_args = ["-EncodedCommand", encoded_cmd]
            else:
                ps_args = ["-Command", command]
            
            working_dir = Path(cwd) if cwd else Path.cwd()
            
            # Determine PowerShell executable
            if platform.system() == "Windows":
                ps_executable = "powershell.exe"
            else:
                # Try pwsh (PowerShell Core) on Linux/Mac
                ps_executable = "pwsh"
            
            process = await asyncio.create_subprocess_exec(
                ps_executable,
                "-NoProfile",
                "-NonInteractive",
                *ps_args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(working_dir)
            )
            
            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    process.communicate(),
                    timeout=timeout
                )
                
                stdout = stdout_bytes.decode('utf-8', errors='replace')
                stderr = stderr_bytes.decode('utf-8', errors='replace')
                return_code = process.returncode
                
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
                return ToolResult(
                    success=False,
                    error=f"PowerShell command timed out after {timeout} seconds",
                    metadata={"timeout": timeout}
                )
            
            end_time = datetime.now(timezone.utc)
            duration_ms = int((end_time - start_time).total_seconds() * 1000)
            
            success = return_code == 0
            
            return ToolResult(
                success=success,
                data={
                    "exit_code": return_code,
                    "duration_ms": duration_ms
                },
                stdout=stdout,
                stderr=stderr,
                duration_ms=duration_ms,
                metadata={
                    "command": command,
                    "cwd": str(working_dir),
                    "pid": process.pid
                }
            )
            
        except FileNotFoundError:
            return ToolResult(
                success=False,
                error="PowerShell not found. Install pwsh on non-Windows systems."
            )
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to execute PowerShell command: {str(e)}"
            )


# Register terminal tools
register_tool(TerminalRunTool)
register_tool(PowerShellRunTool)
