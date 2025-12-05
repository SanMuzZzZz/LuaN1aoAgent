#!/usr/bin/env python3
"""
Tool Manager for LuaN1ao Agent
动态工具管理和文档生成模块
"""

import json
import time
import sys
import os
from typing import Dict, List, Any, Optional

# 添加项目根目录到Python路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.mcp_client import get_all_tools_detailed_async


class ToolManager:
    """
    工具管理器 - 负责动态发现、缓存和管理MCP工具.

    该类管理整个系统中可用的MCP工具，提供工具发现、缓存、启用/禁用和
    文档生成功能。支持按服务器分组管理工具，为执行器提供可用工具列表。

    主要功能：
    - 工具发现：自动从MCP服务器发现可用工具
    - 缓存管理：缓存工具信息，减少重复查询
    - 工具控制：支持启用/禁用特定工具
    - 文档生成：为LLM生成格式化的工具文档
    - 工具查询：根据名称或服务器查询工具信息

    Attributes:
        cache_timeout: 工具信息缓存超时时间（秒）
        _tools_cache: 缓存的工具信息字典
        _cache_timestamp: 缓存时间戳
        _enabled_tools: 启用的工具集合
        _disabled_tools: 禁用的工具集合

    Examples:
        >>> tm = ToolManager(cache_timeout=300)
        >>> all_tools = tm.get_all_tools()
        >>> enabled_tools = tm.get_enabled_tools()
        >>> tm.disable_tool("pentest", "sqlmap")
        >>> doc = tm.generate_tools_documentation()
    """

    def __init__(self, cache_timeout: int = 300):
        """
        初始化工具管理器

        Args:
            cache_timeout: 工具信息缓存超时时间（秒）
        """
        self.cache_timeout = cache_timeout
        self._tools_cache = {}
        self._cache_timestamp = 0
        self._enabled_tools = set()  # 启用的工具集合
        self._disabled_tools = set()  # 禁用的工具集合

    def _is_cache_valid(self) -> bool:
        """检查缓存是否有效"""
        return (time.time() - self._cache_timestamp) < self.cache_timeout

    async def refresh_tools_async(self) -> None:
        """异步刷新工具缓存"""
        try:
            self._tools_cache = await get_all_tools_detailed_async()
            self._cache_timestamp = time.time()
        except Exception as e:
            print(f"刷新工具缓存失败: {e}")
            # 如果刷新失败，保持旧缓存

    def get_all_tools(self) -> Dict[str, List[Dict]]:
        """
        获取所有工具信息 (同步方法，返回缓存)

        Returns:
            按服务器分组的工具信息字典
        """
        return self._tools_cache

    def get_enabled_tools(self) -> Dict[str, List[Dict]]:
        """
        获取启用的工具

        Returns:
            启用的工具信息字典
        """
        all_tools = self.get_all_tools()
        enabled_tools = {}

        for server_name, tools in all_tools.items():
            if isinstance(tools, list):
                server_enabled_tools = []
                for tool in tools:
                    tool_id = f"{server_name}.{tool.get('name', '')}"
                    # 如果没有明确禁用，则认为是启用的
                    if tool_id not in self._disabled_tools:
                        server_enabled_tools.append(tool)
                if server_enabled_tools:
                    enabled_tools[server_name] = server_enabled_tools

        return enabled_tools

    def get_enabled_tool_names(self) -> List[str]:
        """获取所有启用工具的名称列表"""
        enabled_tools = self.get_enabled_tools()
        tool_names = []
        for server_name, tools in enabled_tools.items():
            if isinstance(tools, list):
                for tool in tools:
                    if tool.get("name"):
                        tool_names.append(tool.get("name"))
        return sorted(list(set(tool_names)))

    def enable_tool(self, server_name: str, tool_name: str) -> None:
        """启用工具"""
        tool_id = f"{server_name}.{tool_name}"
        self._enabled_tools.add(tool_id)
        self._disabled_tools.discard(tool_id)

    def disable_tool(self, server_name: str, tool_name: str) -> None:
        """禁用工具"""
        tool_id = f"{server_name}.{tool_name}"
        self._disabled_tools.add(tool_id)
        self._enabled_tools.discard(tool_id)

    def is_tool_enabled(self, server_name: str, tool_name: str) -> bool:
        """检查工具是否启用"""
        tool_id = f"{server_name}.{tool_name}"
        return tool_id not in self._disabled_tools

    def format_tool_documentation(self, tool_info: Dict[str, Any], server_name: str = "") -> str:
        """
        格式化单个工具的文档

        Args:
            tool_info: 工具信息字典
            server_name: 服务器名称

        Returns:
            格式化的工具文档字符串
        """
        name = tool_info.get("name", "unknown")
        description = tool_info.get("description", "无描述")
        input_schema = tool_info.get("inputSchema", {})

        doc_lines = [f"- {name}: {description}"]

        if input_schema and "properties" in input_schema:
            properties = input_schema["properties"]
            required = input_schema.get("required", [])

            # 构建参数格式说明
            params_example = {}
            param_descriptions = []

            for param_name, param_info in properties.items():
                param_type = param_info.get("type", "any")
                param_desc = param_info.get("description", "")
                is_required = param_name in required

                if param_type == "string":
                    example_value = f"示例{param_name}"
                elif param_type == "integer":
                    example_value = 10
                elif param_type == "boolean":
                    example_value = True
                elif param_type == "object":
                    example_value = {"key": "value"}
                elif param_type == "array":
                    example_value = ["item1", "item2"]
                else:
                    example_value = f"<{param_type}>"

                params_example[param_name] = example_value

                req_marker = " (必需)" if is_required else " (可选)"
                param_descriptions.append(f"    - {param_name} ({param_type}){req_marker}: {param_desc}")

            if param_descriptions:
                doc_lines.extend(param_descriptions)
                doc_lines.append(f"  参数格式：{json.dumps(params_example, ensure_ascii=False)}")
                doc_lines.append(f"  示例：Action: {name}")
                doc_lines.append(f"        Action Input: {json.dumps(params_example, ensure_ascii=False)}")

        return "\n".join(doc_lines)

    def generate_tools_documentation(self) -> str:
        """
        生成所有启用工具的文档

        Returns:
            格式化的工具文档字符串
        """
        enabled_tools = self.get_enabled_tools()

        if not enabled_tools:
            return "当前没有可用的工具。"

        doc_lines = ["可用工具："]

        for server_name, tools in enabled_tools.items():
            if isinstance(tools, list):
                for tool in tools:
                    tool_doc = self.format_tool_documentation(tool, server_name)
                    doc_lines.append(tool_doc)
            else:
                doc_lines.append(f"- {server_name}: 工具加载错误 - {tools}")

        return "\n".join(doc_lines)

    def get_tool_info(self, tool_name: str, server_name: str = None) -> Optional[Dict[str, Any]]:
        """
        获取特定工具的详细信息

        Args:
            tool_name: 工具名称
            server_name: 服务器名称（可选）

        Returns:
            工具信息字典，如果找不到则返回None
        """
        all_tools = self.get_all_tools()

        for srv_name, tools in all_tools.items():
            if server_name and srv_name != server_name:
                continue

            if isinstance(tools, list):
                for tool in tools:
                    if tool.get("name") == tool_name:
                        return {"server": srv_name, "tool_info": tool}

        return None

    def get_tools_summary(self) -> Dict[str, Any]:
        """
        获取工具摘要信息

        Returns:
            包含工具统计和状态的摘要字典
        """
        all_tools = self.get_all_tools()
        enabled_tools = self.get_enabled_tools()

        total_tools = 0
        enabled_count = 0
        servers_count = len(all_tools)

        for server_name, tools in all_tools.items():
            if isinstance(tools, list):
                total_tools += len(tools)

        for server_name, tools in enabled_tools.items():
            if isinstance(tools, list):
                enabled_count += len(tools)

        return {
            "servers_count": servers_count,
            "total_tools": total_tools,
            "enabled_tools": enabled_count,
            "disabled_tools": total_tools - enabled_count,
            "cache_valid": self._is_cache_valid(),
            "last_refresh": self._cache_timestamp,
        }


# 全局工具管理器实例
tool_manager = ToolManager()


def get_dynamic_tools_documentation() -> str:
    """
    获取动态生成的工具文档（外部接口）

    Returns:
        工具文档字符串
    """
    documentation = tool_manager.generate_tools_documentation()
    return documentation


if __name__ == "__main__":
    # 测试工具管理器
    print("=== 工具管理器测试 ===")

    summary = tool_manager.get_tools_summary()
    print(f"工具摘要: {json.dumps(summary, ensure_ascii=False, indent=2)}")

    documentation = tool_manager.generate_tools_documentation()
    print(f"\n工具文档:\n{documentation}")

    # 测试特定工具查找
    tool_info = tool_manager.get_tool_info("python_exec")
    if tool_info:
        print(f"\nhttp_request工具信息: {json.dumps(tool_info, ensure_ascii=False, indent=2)}")
    else:
        print("\n未找到http_request工具")

if __name__ == "__main__":
    # 测试工具管理器
    print("=== 工具管理器测试 ===")

    summary = tool_manager.get_tools_summary()
    print(f"工具摘要: {json.dumps(summary, ensure_ascii=False, indent=2)}")

    documentation = tool_manager.generate_tools_documentation()
    print(f"\n工具文档:\n{documentation}")

    # 测试特定工具查找
    tool_info = tool_manager.get_tool_info("python_exec")
    if tool_info:
        print(f"\nhttp_request工具信息: {json.dumps(tool_info, ensure_ascii=False, indent=2)}")
    else:
        print("\n未找到http_request工具")
