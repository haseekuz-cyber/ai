"""
Filesystem tools for WORKER.

Provides file operations:
- read, write, create, delete
- move, copy, rename
- list, search
"""

import os
import shutil
import asyncio
from pathlib import Path
from typing import Any, Dict, List, Optional
from datetime import datetime

from worker.core.tools import BaseTool, ToolResult, register_tool
from worker.core.models import ToolCategory, ToolSchema, RiskLevel


class FileReadTool(BaseTool):
    """Read content of a file."""
    
    name = "files.read"
    description = "Read the content of a file from disk"
    category = ToolCategory.FILESYSTEM
    permission_level = RiskLevel.LOW
    timeout = 30
    
    def get_input_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "path": {"type": "string", "description": "Path to the file"},
                "encoding": {"type": "string", "default": "utf-8"}
            },
            required=["path"]
        )
    
    def get_output_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "content": {"type": "string"},
                "size_bytes": {"type": "integer"},
                "modified_at": {"type": "string"}
            }
        )
    
    async def execute(self, **kwargs) -> ToolResult:
        path = kwargs.get("path")
        encoding = kwargs.get("encoding", "utf-8")
        
        try:
            file_path = Path(path)
            
            if not file_path.exists():
                return ToolResult(
                    success=False,
                    error=f"File not found: {path}"
                )
            
            if not file_path.is_file():
                return ToolResult(
                    success=False,
                    error=f"Not a file: {path}"
                )
            
            # Read file
            loop = asyncio.get_event_loop()
            content = await loop.run_in_executor(
                None, 
                lambda: file_path.read_text(encoding=encoding)
            )
            
            stat = file_path.stat()
            
            return ToolResult(
                success=True,
                data={
                    "content": content,
                    "size_bytes": stat.st_size,
                    "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat()
                },
                metadata={"path": str(file_path.absolute())}
            )
            
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to read file: {str(e)}"
            )


class FileWriteTool(BaseTool):
    """Write content to a file."""
    
    name = "files.write"
    description = "Write content to a file (creates or overwrites)"
    category = ToolCategory.FILESYSTEM
    permission_level = RiskLevel.MEDIUM
    timeout = 30
    
    def get_input_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "path": {"type": "string", "description": "Path to the file"},
                "content": {"type": "string", "description": "Content to write"},
                "encoding": {"type": "string", "default": "utf-8"},
                "append": {"type": "boolean", "default": False}
            },
            required=["path", "content"]
        )
    
    def get_output_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "bytes_written": {"type": "integer"},
                "path": {"type": "string"}
            }
        )
    
    async def execute(self, **kwargs) -> ToolResult:
        path = kwargs.get("path")
        content = kwargs.get("content")
        encoding = kwargs.get("encoding", "utf-8")
        append = kwargs.get("append", False)
        
        try:
            file_path = Path(path)
            
            # Create parent directories if needed
            file_path.parent.mkdir(parents=True, exist_ok=True)
            
            loop = asyncio.get_event_loop()
            
            if append:
                await loop.run_in_executor(
                    None,
                    lambda: file_path.write_text(content, encoding=encoding)
                )
            else:
                await loop.run_in_executor(
                    None,
                    lambda: file_path.write_text(content, encoding=encoding)
                )
            
            stat = file_path.stat()
            
            return ToolResult(
                success=True,
                data={
                    "bytes_written": stat.st_size,
                    "path": str(file_path.absolute())
                },
                artifacts=[str(file_path.absolute())]
            )
            
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to write file: {str(e)}"
            )


class FileListTool(BaseTool):
    """List files in a directory."""
    
    name = "files.list"
    description = "List files and directories in a path"
    category = ToolCategory.FILESYSTEM
    permission_level = RiskLevel.LOW
    timeout = 30
    
    def get_input_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "path": {"type": "string", "description": "Directory path"},
                "pattern": {"type": "string", "default": "*", "description": "Glob pattern"},
                "recursive": {"type": "boolean", "default": False}
            },
            required=["path"]
        )
    
    def get_output_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "entries": {"type": "array", "items": {"type": "object"}},
                "count": {"type": "integer"}
            }
        )
    
    async def execute(self, **kwargs) -> ToolResult:
        path = kwargs.get("path")
        pattern = kwargs.get("pattern", "*")
        recursive = kwargs.get("recursive", False)
        
        try:
            dir_path = Path(path)
            
            if not dir_path.exists():
                return ToolResult(
                    success=False,
                    error=f"Path not found: {path}"
                )
            
            if not dir_path.is_dir():
                return ToolResult(
                    success=False,
                    error=f"Not a directory: {path}"
                )
            
            entries = []
            
            if recursive:
                items = dir_path.rglob(pattern)
            else:
                items = dir_path.glob(pattern)
            
            for item in items:
                try:
                    stat = item.stat()
                    entries.append({
                        "name": item.name,
                        "path": str(item.absolute()),
                        "is_file": item.is_file(),
                        "is_dir": item.is_dir(),
                        "size_bytes": stat.st_size if item.is_file() else 0,
                        "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat()
                    })
                except (PermissionError, OSError):
                    continue
            
            return ToolResult(
                success=True,
                data={
                    "entries": entries,
                    "count": len(entries)
                }
            )
            
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to list directory: {str(e)}"
            )


class FileDeleteTool(BaseTool):
    """Delete a file or directory."""
    
    name = "files.delete"
    description = "Delete a file or empty directory"
    category = ToolCategory.FILESYSTEM
    permission_level = RiskLevel.HIGH
    timeout = 30
    
    def get_input_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "path": {"type": "string", "description": "Path to delete"},
                "recursive": {"type": "boolean", "default": False, "description": "Delete non-empty directories"}
            },
            required=["path"]
        )
    
    def get_output_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "deleted": {"type": "boolean"},
                "path": {"type": "string"}
            }
        )
    
    async def execute(self, **kwargs) -> ToolResult:
        path = kwargs.get("path")
        recursive = kwargs.get("recursive", False)
        
        try:
            file_path = Path(path)
            
            if not file_path.exists():
                return ToolResult(
                    success=False,
                    error=f"Path not found: {path}"
                )
            
            loop = asyncio.get_event_loop()
            
            if file_path.is_dir():
                if recursive:
                    await loop.run_in_executor(
                        None,
                        lambda: shutil.rmtree(file_path)
                    )
                else:
                    await loop.run_in_executor(
                        None,
                        lambda: file_path.rmdir()
                    )
            else:
                await loop.run_in_executor(
                    None,
                    lambda: file_path.unlink()
                )
            
            return ToolResult(
                success=True,
                data={
                    "deleted": True,
                    "path": str(path)
                }
            )
            
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to delete: {str(e)}"
            )


class FileCopyTool(BaseTool):
    """Copy a file or directory."""
    
    name = "files.copy"
    description = "Copy a file or directory to a new location"
    category = ToolCategory.FILESYSTEM
    permission_level = RiskLevel.MEDIUM
    timeout = 60
    
    def get_input_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "source": {"type": "string", "description": "Source path"},
                "destination": {"type": "string", "description": "Destination path"},
                "recursive": {"type": "boolean", "default": False}
            },
            required=["source", "destination"]
        )
    
    def get_output_schema(self) -> ToolSchema:
        return ToolSchema(
            type="object",
            properties={
                "destination": {"type": "string"},
                "size_bytes": {"type": "integer"}
            }
        )
    
    async def execute(self, **kwargs) -> ToolResult:
        source = kwargs.get("source")
        destination = kwargs.get("destination")
        recursive = kwargs.get("recursive", False)
        
        try:
            src_path = Path(source)
            dst_path = Path(destination)
            
            if not src_path.exists():
                return ToolResult(
                    success=False,
                    error=f"Source not found: {source}"
                )
            
            loop = asyncio.get_event_loop()
            
            if src_path.is_dir():
                if recursive:
                    await loop.run_in_executor(
                        None,
                        lambda: shutil.copytree(src_path, dst_path)
                    )
                else:
                    return ToolResult(
                        success=False,
                        error="Use recursive=true to copy directories"
                    )
            else:
                await loop.run_in_executor(
                    None,
                    lambda: shutil.copy2(src_path, dst_path)
                )
            
            stat = dst_path.stat()
            
            return ToolResult(
                success=True,
                data={
                    "destination": str(dst_path.absolute()),
                    "size_bytes": stat.st_size
                },
                artifacts=[str(dst_path.absolute())]
            )
            
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to copy: {str(e)}"
            )


# Register all filesystem tools
register_tool(FileReadTool)
register_tool(FileWriteTool)
register_tool(FileListTool)
register_tool(FileDeleteTool)
register_tool(FileCopyTool)
