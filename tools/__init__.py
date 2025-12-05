#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LuaN1ao工具集成模块.

本包提供MCP (Model Control Protocol) 工具集成功能，
封装各类安全测试工具，供上层Agent调用。

主要组件:
    - mcp_service: MCP服务框架，提供工具注册和调用接口
    - mcp_client: MCP客户端，管理与MCP服务器的连接

主要工具类型:
    - HTTP请求工具
    - Shell命令执行工具
    - 元认知工具（思考、假设、反思、专家分析）
    - 任务控制工具
"""

from tools.mcp_client import (
    call_mcp_tool_async,
    initialize_sessions,
    close_async_sessions,
    get_all_tools_detailed_async, # Changed to async version
)

__all__ = [
    "call_mcp_tool_async",
    "initialize_sessions",
    "close_async_sessions",
    "get_all_tools_detailed_async", # Changed to async version
]

__version__ = "1.0.0"
