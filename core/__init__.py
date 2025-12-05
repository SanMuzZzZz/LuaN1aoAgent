#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LuaN1ao核心模块.

本包包含LuaN1ao系统的核心组件，实现P-E-R架构的主要功能。

主要模块:
    - planner: 规划器，负责任务分解和战略规划
    - executor: 执行器，负责具体操作的执行
    - reflector: 反思器，负责执行结果的审计和反思
    - graph_manager: 图谱管理器，管理任务图和因果图
    - tool_manager: 工具管理器，管理MCP工具的发现和调用
    - prompt_templates: 提示词模板库
    - data_contracts: 数据契约定义
    - events: 事件系统
    - console: 控制台工具
"""

from core.planner import Planner
from core.executor import run_executor_cycle
from core.reflector import Reflector
from core.graph_manager import GraphManager
from core.tool_manager import tool_manager, ToolManager
from core.events import broker

__all__ = [
    "Planner",
    "run_executor_cycle",
    "Reflector",
    "GraphManager",
    "tool_manager",
    "ToolManager",
    "broker",
]

__version__ = "1.0.0"
