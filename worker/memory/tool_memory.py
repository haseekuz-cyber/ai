"""
Tool Memory - Statistics and usage patterns for tools.

Tracks:
- Tool call frequency
- Success/failure rates
- Average execution duration
- Common errors
- Last used timestamp

Used for tool optimization and reliability monitoring.
"""

from typing import Any, Optional

from .store import MemoryStore


class ToolMemory:
    """
    Tool memory manager for tracking tool usage statistics.
    
    Provides insights into tool performance and reliability.
    """

    def __init__(self, memory_store: MemoryStore):
        """
        Initialize tool memory.
        
        Args:
            memory_store: Central memory store instance
        """
        self._store = memory_store

    def record_usage(
        self,
        tool_name: str,
        success: bool,
        duration_seconds: float,
        error: Optional[str] = None,
    ) -> None:
        """
        Record a tool usage event.
        
        Args:
            tool_name: Name of the tool
            success: Whether the tool call succeeded
            duration_seconds: Execution duration in seconds
            error: Error message if failed
        """
        self._store.tool_record_usage(tool_name, success, duration_seconds, error)

    def get_stats(self, tool_name: str) -> Optional[dict[str, Any]]:
        """
        Get statistics for a specific tool.
        
        Args:
            tool_name: Name of the tool
            
        Returns:
            Dictionary with tool statistics or None if not found
        """
        return self._store.tool_get_stats(tool_name)

    def get_all_stats(self) -> list[dict[str, Any]]:
        """
        Get statistics for all tools.
        
        Returns:
            List of tool statistics dictionaries
        """
        return self._store.tool_get_all_stats()

    def get_success_rate(self, tool_name: str) -> float:
        """
        Get success rate for a tool.
        
        Args:
            tool_name: Name of the tool
            
        Returns:
            Success rate as a float between 0.0 and 1.0
        """
        stats = self.get_stats(tool_name)
        if not stats or stats["total_calls"] == 0:
            return 0.0
        
        return stats["successful_calls"] / stats["total_calls"]

    def get_average_duration(self, tool_name: str) -> float:
        """
        Get average execution duration for a tool.
        
        Args:
            tool_name: Name of the tool
            
        Returns:
            Average duration in seconds
        """
        stats = self.get_stats(tool_name)
        if not stats:
            return 0.0
        
        return stats.get("avg_duration", 0.0)

    def get_common_errors(self, tool_name: str, limit: int = 5) -> list[str]:
        """
        Get common errors for a tool.
        
        Args:
            tool_name: Name of the tool
            limit: Maximum number of errors to return
            
        Returns:
            List of common error messages
        """
        stats = self.get_stats(tool_name)
        if not stats:
            return []
        
        return stats.get("common_errors", [])[:limit]

    def get_most_used_tools(self, limit: int = 10) -> list[dict[str, Any]]:
        """
        Get most frequently used tools.
        
        Args:
            limit: Maximum number of tools to return
            
        Returns:
            List of tool statistics sorted by usage
        """
        all_stats = self.get_all_stats()
        return sorted(
            all_stats,
            key=lambda x: x["total_calls"],
            reverse=True,
        )[:limit]

    def get_least_reliable_tools(
        self, 
        min_calls: int = 5,
        limit: int = 10
    ) -> list[dict[str, Any]]:
        """
        Get tools with lowest success rates.
        
        Args:
            min_calls: Minimum number of calls to consider
            limit: Maximum number of tools to return
            
        Returns:
            List of unreliable tools sorted by success rate
        """
        all_stats = self.get_all_stats()
        
        # Filter tools with enough calls
        qualified = [
            s for s in all_stats 
            if s["total_calls"] >= min_calls
        ]
        
        # Sort by success rate (ascending)
        sorted_tools = sorted(
            qualified,
            key=lambda x: x["successful_calls"] / max(x["total_calls"], 1),
        )
        
        return sorted_tools[:limit]

    def is_tool_healthy(
        self, 
        tool_name: str,
        min_success_rate: float = 0.8,
        min_calls: int = 3,
    ) -> bool:
        """
        Check if a tool is healthy based on its success rate.
        
        Args:
            tool_name: Name of the tool
            min_success_rate: Minimum acceptable success rate
            min_calls: Minimum number of calls to make assessment
            
        Returns:
            True if tool is healthy, False otherwise
        """
        stats = self.get_stats(tool_name)
        if not stats or stats["total_calls"] < min_calls:
            return True  # Not enough data to assess
        
        success_rate = self.get_success_rate(tool_name)
        return success_rate >= min_success_rate

    def get_tool_report(self, tool_name: str) -> dict[str, Any]:
        """
        Generate a comprehensive report for a tool.
        
        Args:
            tool_name: Name of the tool
            
        Returns:
            Dictionary with detailed tool report
        """
        stats = self.get_stats(tool_name)
        
        if not stats:
            return {
                "tool_name": tool_name,
                "status": "no_data",
                "message": "No usage data available",
            }
        
        success_rate = stats["successful_calls"] / max(stats["total_calls"], 1)
        
        if success_rate >= 0.95:
            health_status = "excellent"
        elif success_rate >= 0.8:
            health_status = "good"
        elif success_rate >= 0.6:
            health_status = "fair"
        else:
            health_status = "poor"
        
        return {
            "tool_name": tool_name,
            "status": "active",
            "health": health_status,
            "total_calls": stats["total_calls"],
            "successful_calls": stats["successful_calls"],
            "failed_calls": stats["failed_calls"],
            "success_rate": success_rate,
            "average_duration_seconds": stats.get("avg_duration", 0.0),
            "last_used_at": stats.get("last_used_at"),
            "common_errors": stats.get("common_errors", []),
            "recommendations": self._generate_recommendations(stats, success_rate),
        }

    def _generate_recommendations(
        self, 
        stats: dict[str, Any], 
        success_rate: float
    ) -> list[str]:
        """
        Generate recommendations for improving tool performance.
        
        Args:
            stats: Tool statistics
            success_rate: Current success rate
            
        Returns:
            List of recommendation strings
        """
        recommendations = []
        
        if success_rate < 0.6:
            recommendations.append(
                "Consider reviewing error handling and edge cases"
            )
        
        if stats["total_calls"] > 100 and success_rate < 0.9:
            recommendations.append(
                "High usage with moderate success rate - prioritize stability improvements"
            )
        
        if stats.get("common_errors"):
            recommendations.append(
                f"Address common errors: {', '.join(stats['common_errors'][:3])}"
            )
        
        if not recommendations:
            recommendations.append("Tool performance is satisfactory")
        
        return recommendations

    def reset_stats(self, tool_name: str) -> bool:
        """
        Reset statistics for a tool.
        
        Note: This is a destructive operation and should be used carefully.
        
        Args:
            tool_name: Name of the tool
            
        Returns:
            True if reset was successful (not implemented in store yet)
        """
        # For now, just return False as we don't have delete in store
        # Could be enhanced with actual reset logic
        return False

    def export_all_stats(self) -> list[dict[str, Any]]:
        """
        Export all tool statistics for analysis.
        
        Returns:
            List of all tool statistics
        """
        return self.get_all_stats()
