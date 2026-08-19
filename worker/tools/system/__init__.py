"""
System tools for WORKER.

Provides system-level operations:
- Process management (list, kill)
- System information
- Resource monitoring
"""

import asyncio
import platform
import psutil
from typing import Any, Dict, List, Optional
from datetime import datetime

from worker.core.tools import BaseTool, ToolResult, register_tool
from worker.core.models import ToolCategory, ToolSchema, RiskLevel


class ProcessListTool(BaseTool):
    """Get list of running processes."""
    
    name = "system.process_list"
    description = "List all running processes with basic info"
    category = ToolCategory.SYSTEM
    permission_level = RiskLevel.LOW
    timeout = 30
    
    def get_input_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "filter_by_name": {"type": "string", "description": "Filter by process name pattern", "default": None},
                "include_details": {"type": "boolean", "description": "Include full details", "default": False}
            }
        )
    
    def get_output_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "processes": {"type": "array", "items": {"type": "object"}},
                "count": {"type": "integer"}
            }
        )
    
    async def execute(self, **kwargs) -> ToolResult:
        filter_name = kwargs.get("filter_by_name")
        include_details = kwargs.get("include_details", False)
        
        try:
            processes = []
            
            for proc in psutil.process_iter(['pid', 'name', 'username', 'status']):
                try:
                    info = proc.info
                    
                    if filter_name and filter_name.lower() not in info['name'].lower():
                        continue
                    
                    process_data = {
                        "pid": info['pid'],
                        "name": info['name'],
                        "username": info.get('username'),
                        "status": info.get('status')
                    }
                    
                    if include_details:
                        try:
                            process_data["cpu_percent"] = proc.cpu_percent(interval=0.1)
                            process_data["memory_percent"] = proc.memory_percent()
                            process_data["num_threads"] = proc.num_threads()
                            process_data["create_time"] = datetime.fromtimestamp(proc.create_time()).isoformat()
                        except (psutil.NoSuchProcess, psutil.AccessDenied):
                            pass
                    
                    processes.append(process_data)
                    
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
            
            return ToolResult(
                success=True,
                data={
                    "processes": processes,
                    "count": len(processes)
                }
            )
            
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to list processes: {str(e)}"
            )


class ProcessKillTool(BaseTool):
    """Kill a process by PID."""
    
    name = "system.process_kill"
    description = "Terminate a running process"
    category = ToolCategory.SYSTEM
    permission_level = RiskLevel.HIGH
    timeout = 30
    
    def get_input_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "pid": {"type": "integer", "description": "Process ID to kill"},
                "force": {"type": "boolean", "description": "Force kill", "default": False}
            },
            required=["pid"]
        )
    
    def get_output_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "killed": {"type": "boolean"},
                "pid": {"type": "integer"}
            }
        )
    
    async def execute(self, **kwargs) -> ToolResult:
        pid = kwargs.get("pid")
        force = kwargs.get("force", False)
        
        try:
            proc = psutil.Process(pid)
            name = proc.name()
            
            if force:
                proc.kill()
            else:
                proc.terminate()
            
            # Wait for process to end
            gone, alive = psutil.wait_procs([proc], timeout=5)
            
            if pid in [p.pid for p in alive]:
                # Force kill if still alive
                proc.kill()
                psutil.wait_procs([proc], timeout=2)
            
            return ToolResult(
                success=True,
                data={
                    "killed": True,
                    "pid": pid,
                    "name": name
                }
            )
            
        except psutil.NoSuchProcess:
            return ToolResult(
                success=False,
                error=f"No process found with PID {pid}"
            )
        except psutil.AccessDenied:
            return ToolResult(
                success=False,
                error=f"Access denied to kill process {pid}"
            )
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to kill process: {str(e)}"
            )


class SystemInfoTool(BaseTool):
    """Get system information."""
    
    name = "system.info"
    description = "Get system hardware and OS information"
    category = ToolCategory.SYSTEM
    permission_level = RiskLevel.LOW
    timeout = 30
    
    def get_input_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={}
        )
    
    def get_output_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "os": {"type": "string"},
                "os_version": {"type": "string"},
                "architecture": {"type": "string"},
                "processor": {"type": "string"},
                "cpu_count": {"type": "integer"},
                "memory_total_gb": {"type": "number"},
                "memory_available_gb": {"type": "number"}
            }
        )
    
    async def execute(self, **kwargs) -> ToolResult:
        try:
            mem = psutil.virtual_memory()
            
            return ToolResult(
                success=True,
                data={
                    "os": platform.system(),
                    "os_version": platform.version(),
                    "architecture": platform.machine(),
                    "processor": platform.processor() or "Unknown",
                    "cpu_count": psutil.cpu_count(logical=True),
                    "cpu_physical_count": psutil.cpu_count(logical=False),
                    "memory_total_gb": round(mem.total / (1024**3), 2),
                    "memory_available_gb": round(mem.available / (1024**3), 2),
                    "memory_percent": mem.percent
                }
            )
            
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to get system info: {str(e)}"
            )


class SystemResourceTool(BaseTool):
    """Get current resource usage."""
    
    name = "system.resources"
    description = "Get current CPU, memory, and disk usage"
    category = ToolCategory.SYSTEM
    permission_level = RiskLevel.LOW
    timeout = 30
    
    def get_input_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "interval": {"type": "number", "description": "CPU measurement interval", "default": 0.5}
            }
        )
    
    def get_output_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "cpu_percent": {"type": "number"},
                "memory_percent": {"type": "number"},
                "disk_usage": {"type": "object"}
            }
        )
    
    async def execute(self, **kwargs) -> ToolResult:
        interval = kwargs.get("interval", 0.5)
        
        try:
            cpu_percent = psutil.cpu_percent(interval=interval)
            mem = psutil.virtual_memory()
            disk = psutil.disk_usage('/')
            
            return ToolResult(
                success=True,
                data={
                    "cpu_percent": cpu_percent,
                    "memory_percent": mem.percent,
                    "memory_available_gb": round(mem.available / (1024**3), 2),
                    "disk_total_gb": round(disk.total / (1024**3), 2),
                    "disk_used_gb": round(disk.used / (1024**3), 2),
                    "disk_percent": disk.percent
                }
            )
            
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to get resource usage: {str(e)}"
            )


# Register system tools
register_tool(ProcessListTool)
register_tool(ProcessKillTool)
register_tool(SystemInfoTool)
register_tool(SystemResourceTool)
