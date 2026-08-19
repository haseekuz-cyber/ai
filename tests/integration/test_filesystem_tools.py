"""
Integration tests for filesystem tools.
"""

import pytest
import tempfile
import os
from pathlib import Path

from worker.tools.filesystem import (
    FileReadTool, FileWriteTool, FileListTool, 
    FileDeleteTool, FileCopyTool
)


@pytest.fixture
def temp_dir():
    """Create a temporary directory for tests."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


class TestFileReadTool:
    """Test FileReadTool integration."""
    
    @pytest.mark.asyncio
    async def test_read_existing_file(self, temp_dir):
        """Test reading an existing file."""
        # Create test file
        test_file = Path(temp_dir) / "test.txt"
        test_file.write_text("Hello, World!")
        
        tool = FileReadTool()
        result = await tool.execute(path=str(test_file))
        
        assert result.success is True
        assert result.data["content"] == "Hello, World!"
        assert result.data["size_bytes"] == 13
    
    @pytest.mark.asyncio
    async def test_read_nonexistent_file(self, temp_dir):
        """Test reading a non-existent file."""
        tool = FileReadTool()
        result = await tool.execute(path=f"{temp_dir}/nonexistent.txt")
        
        assert result.success is False
        assert "not found" in result.error.lower()
    
    @pytest.mark.asyncio
    async def test_read_directory_fails(self, temp_dir):
        """Test that reading a directory fails."""
        tool = FileReadTool()
        result = await tool.execute(path=temp_dir)
        
        assert result.success is False
        assert "not a file" in result.error.lower()


class TestFileWriteTool:
    """Test FileWriteTool integration."""
    
    @pytest.mark.asyncio
    async def test_write_new_file(self, temp_dir):
        """Test writing a new file."""
        test_file = Path(temp_dir) / "new.txt"
        
        tool = FileWriteTool()
        result = await tool.execute(
            path=str(test_file),
            content="Test content"
        )
        
        assert result.success is True
        assert test_file.exists()
        assert test_file.read_text() == "Test content"
    
    @pytest.mark.asyncio
    async def test_write_creates_directories(self, temp_dir):
        """Test that write creates parent directories."""
        test_file = Path(temp_dir) / "subdir" / "nested" / "file.txt"
        
        tool = FileWriteTool()
        result = await tool.execute(
            path=str(test_file),
            content="Nested content"
        )
        
        assert result.success is True
        assert test_file.exists()
        assert test_file.parent.exists()
    
    @pytest.mark.asyncio
    async def test_overwrite_file(self, temp_dir):
        """Test overwriting existing file."""
        test_file = Path(temp_dir) / "overwrite.txt"
        test_file.write_text("Original")
        
        tool = FileWriteTool()
        result = await tool.execute(
            path=str(test_file),
            content="Replaced"
        )
        
        assert result.success is True
        assert test_file.read_text() == "Replaced"


class TestFileListTool:
    """Test FileListTool integration."""
    
    @pytest.mark.asyncio
    async def test_list_directory(self, temp_dir):
        """Test listing directory contents."""
        # Create test files
        (Path(temp_dir) / "file1.txt").write_text("a")
        (Path(temp_dir) / "file2.txt").write_text("b")
        (Path(temp_dir) / "subdir").mkdir()
        
        tool = FileListTool()
        result = await tool.execute(path=temp_dir)
        
        assert result.success is True
        assert result.data["count"] >= 2
        
        names = [e["name"] for e in result.data["entries"]]
        assert "file1.txt" in names
        assert "file2.txt" in names
        assert "subdir" in names
    
    @pytest.mark.asyncio
    async def test_list_with_pattern(self, temp_dir):
        """Test listing with glob pattern."""
        (Path(temp_dir) / "test.py").write_text("a")
        (Path(temp_dir) / "main.py").write_text("b")
        (Path(temp_dir) / "readme.md").write_text("c")
        
        tool = FileListTool()
        result = await tool.execute(path=temp_dir, pattern="*.py")
        
        assert result.success is True
        assert result.data["count"] == 2
        
        names = [e["name"] for e in result.data["entries"]]
        assert "test.py" in names
        assert "main.py" in names
        assert "readme.md" not in names
    
    @pytest.mark.asyncio
    async def test_list_nonexistent_path(self, temp_dir):
        """Test listing non-existent path."""
        tool = FileListTool()
        result = await tool.execute(path=f"{temp_dir}/nonexistent")
        
        assert result.success is False
        assert "not found" in result.error.lower()


class TestFileCopyTool:
    """Test FileCopyTool integration."""
    
    @pytest.mark.asyncio
    async def test_copy_file(self, temp_dir):
        """Test copying a file."""
        src = Path(temp_dir) / "source.txt"
        dst = Path(temp_dir) / "dest.txt"
        src.write_text("Copy me")
        
        tool = FileCopyTool()
        result = await tool.execute(
            source=str(src),
            destination=str(dst)
        )
        
        assert result.success is True
        assert dst.exists()
        assert dst.read_text() == "Copy me"
    
    @pytest.mark.asyncio
    async def test_copy_nonexistent_source(self, temp_dir):
        """Test copying non-existent source."""
        tool = FileCopyTool()
        result = await tool.execute(
            source=f"{temp_dir}/nonexistent.txt",
            destination=f"{temp_dir}/dest.txt"
        )
        
        assert result.success is False
        assert "not found" in result.error.lower()


class TestFileDeleteTool:
    """Test FileDeleteTool integration."""
    
    @pytest.mark.asyncio
    async def test_delete_file(self, temp_dir):
        """Test deleting a file."""
        test_file = Path(temp_dir) / "todelete.txt"
        test_file.write_text("Delete me")
        
        tool = FileDeleteTool()
        result = await tool.execute(path=str(test_file))
        
        assert result.success is True
        assert not test_file.exists()
    
    @pytest.mark.asyncio
    async def test_delete_empty_directory(self, temp_dir):
        """Test deleting empty directory."""
        test_dir = Path(temp_dir) / "emptydir"
        test_dir.mkdir()
        
        tool = FileDeleteTool()
        result = await tool.execute(path=str(test_dir))
        
        assert result.success is True
        assert not test_dir.exists()
    
    @pytest.mark.asyncio
    async def test_delete_nonexistent(self, temp_dir):
        """Test deleting non-existent file."""
        tool = FileDeleteTool()
        result = await tool.execute(path=f"{temp_dir}/nonexistent.txt")
        
        assert result.success is False
        assert "not found" in result.error.lower()
