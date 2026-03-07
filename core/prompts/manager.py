#!/usr/bin/env python3
"""
统一提示词管理器 (Centralized Prompt Manager)
"""

import os
import json
from typing import Dict, Any, List, Optional
from jinja2 import Environment, FileSystemLoader, select_autoescape

from core.prompts.renderers import (
    render_causal_graph,
    render_failure_patterns,
    render_key_facts,
    render_dependencies_summary,
)


from conf.config import SCENARIO_MODE, PROMPT_LANGUAGE

class PromptManager:
    """
    统一的提示词管理器
    
    负责所有角色(Planner, Executor, Reflector)的Prompt生成与上下文渲染。
    使用Jinja2模板引擎确保提示词的一致性和可维护性。
    支持中英文切换（通过 PROMPT_LANGUAGE 配置）。
    """

    def __init__(self):
        """初始化提示词管理器,加载Jinja2模板"""
        # 获取模板目录路径（根据语言配置选择子目录）
        base_template_dir = os.path.join(os.path.dirname(__file__), "templates")
        template_dir = os.path.join(base_template_dir, PROMPT_LANGUAGE)

        # Fallback to zh if language directory doesn't exist
        if not os.path.isdir(template_dir):
            template_dir = os.path.join(base_template_dir, "zh")

        # 创建Jinja2环境
        self.env = Environment(
            loader=FileSystemLoader(template_dir),
            autoescape=select_autoescape(["html", "xml"]),
            trim_blocks=True,
            lstrip_blocks=True,
        )

        self.planner_template = self.env.get_template("planner_template.jinja2")
        self.executor_template = self.env.get_template("executor_template.jinja2")
        self.reflector_template = self.env.get_template("reflector_template.jinja2")
        self.branch_replan_template = self.env.get_template("branch_replan_template.jinja2")

    def build_planner_prompt(
        self, goal: str, context: Dict[str, Any], is_dynamic: bool = False, planner_context: Optional[Any] = None
    ) -> str:
        """
        构建 Planner 提示词

        Args:
            goal: 用户的高级目标
            context: 上下文数据字典
            is_dynamic: 是否为动态规划
            planner_context: 规划上下文对象

        Returns:
            格式化后的提示词字符串
        """
        # 1. 渲染通用组件
        failure_text = render_failure_patterns(context.get("failure_patterns"))

        # 2. 组装输入变量 - 直接传递数据给模板
        input_variables = {
            "goal": goal,
            "causal_graph_summary": context.get("causal_graph_summary", "因果链图谱为空。"),
            "failure_patterns": failure_text,
            "failed_tasks_summary": context.get("failed_tasks_summary", ""),
            "retrieved_experience": context.get("retrieved_experience", ""),
            # 控制 CTF 场景优化 - 基于全局配置
            "use_ctf_optimizations": SCENARIO_MODE == "ctf",
        }

        # 3. 动态规划特有部分
        if is_dynamic:
            input_variables["dynamic_context"] = {
                "graph_summary": context.get("graph_summary", ""),
                "intelligence_summary": json.dumps(
                    context.get("intelligence_summary", {}), indent=2, ensure_ascii=False
                ),
            }

        # 4. 规划上下文
        if planner_context:
            input_variables["planning_context"] = self._render_planning_context_section(planner_context)

        return self.planner_template.render(**input_variables)

    def build_executor_prompt(
        self, main_goal: str, subtask: Dict[str, Any], context: Dict[str, Any], global_mission_briefing: str = ""
    ) -> str:
        """
        构建 Executor 提示词

        Args:
            main_goal: 核心总目标
            subtask: 当前子任务数据
            context: 上下文数据字典
            global_mission_briefing: 全局任务简报

        Returns:
            格式化后的提示词字符串
        """
        # 1. 渲染关键事实
        key_facts_text = render_key_facts(context.get("key_facts", []))

        # 2. 渲染因果图(相关上下文模式)
        causal_graph_text = render_causal_graph(context.get("causal_context", {}), mode="relevant")

        # 3. 渲染依赖摘要
        dependency_text = render_dependencies_summary(context.get("dependencies", []))

        # 4. 全局因果链图谱摘要
        full_graph_section = ""
        global_causal_graph_summary = context.get("causal_graph_summary")
        if global_causal_graph_summary and global_causal_graph_summary != "因果链图谱为空。":
            full_graph_section = f"""
              ### 🗺️ 全局因果链图谱摘要 (Global Causal Graph Summary)
              {global_causal_graph_summary}
            """

        # 5. 生成工具部分
        tools_section = self._generate_tools_section()

        # 6. 渲染失败模式
        failure_patterns_data = context.get("causal_context", {}).get("failure_patterns", {})
        failure_patterns_text = render_failure_patterns(failure_patterns_data)

        # 7. 组装输入变量
        input_variables = {
            "main_goal": main_goal,
            "global_mission_briefing": global_mission_briefing,
            "subtask_id": subtask.get("id", "N/A"),
            "subtask_goal": subtask.get("description", "N/A"),
            "completion_criteria": subtask.get("completion_criteria", "N/A"),
            "key_facts": key_facts_text,
            "full_graph_section": full_graph_section,
            "causal_graph_summary": context.get("causal_graph_summary", "因果链图谱为空。"),
            "dependency_context": dependency_text,
            "tools_section": tools_section,
            "failure_patterns": failure_patterns_text,
            "active_constraints": context.get("active_constraints", []),
            "use_ctf_optimizations": SCENARIO_MODE == "ctf",
        }

        return self.executor_template.render(**input_variables)

    def build_reflector_prompt(
        self,
        subtask: Dict[str, Any],
        status: str,
        execution_log: str,
        staged_causal_nodes: List[Dict],
        context: Dict[str, Any],
        reflector_context: Optional[Any] = None,
    ) -> str:
        """
        构建 Reflector 提示词

        Args:
            subtask: 子任务数据
            status: 执行状态
            execution_log: 执行日志
            staged_causal_nodes: 暂存的因果节点
            context: 上下文数据字典
            reflector_context: 反思上下文对象

        Returns:
            格式化后的提示词字符串
        """
        # 1. 序列化节点数据
        staged_causal_nodes_json = json.dumps(staged_causal_nodes, indent=2, ensure_ascii=False)

        # 2. 渲染失败模式
        failure_patterns_text = render_failure_patterns(context.get("failure_patterns"))

        # 3. 获取因果图摘要数据
        causal_graph_summary = context.get("causal_graph_summary", "因果链图谱为空。")

        # 4. 处理终止信息
        termination_reason = "N/A"
        executed_steps = "N/A"

        dependency_context = context.get("dependency_context", [])
        if dependency_context and isinstance(dependency_context, list):
            # 查找归一化的终止信息
            normalized_items = [
                item for item in dependency_context if isinstance(item, dict) and item.get("source") == "normalized"
            ]
            if normalized_items:
                item = normalized_items[0]
                termination_reason = item.get("termination_reason", "N/A")
                executed_steps = str(item.get("executed_steps", "N/A"))

        # 5. 组装输入变量
        input_variables = {
            "subtask_goal": subtask.get("description", subtask.get("id", "N/A")),
            "status": status,
            "completion_criteria": subtask.get("completion_criteria", "N/A"),
            "execution_log": execution_log,
            "staged_causal_nodes_json": staged_causal_nodes_json,
            "termination_reason": termination_reason,
            "executed_steps": executed_steps,
            "causal_graph_summary": causal_graph_summary,
            "dependency_context": json.dumps(dependency_context, indent=2, ensure_ascii=False)
            if dependency_context
            else "[]",
            "failure_patterns": failure_patterns_text,
            "use_ctf_optimizations": SCENARIO_MODE == "ctf",
        }

        # 6. 反思上下文
        if reflector_context:
            input_variables["reflection_context"] = self._render_reflection_context_section(reflector_context)

        return self.reflector_template.render(**input_variables)

    def _generate_tools_section(self) -> str:
        """
        生成工具部分的提示词。
        列出所有可用工具，按名称排序。

        Returns:
            格式化的工具文档字符串
        """
        from core.tool_manager import get_dynamic_tools_documentation

        tools_documentation = get_dynamic_tools_documentation()
        
        tools_section = f"""
{tools_documentation}

**重要**:
- **优先使用专用工具**: 如果存在针对特定任务的专用工具(如 `dirsearch_scan` 用于目录扫描,`sqlmap_scan` 用于SQL注入),**必须**优先使用该工具,而不是通用的 `shell_exec`。
- **使用 `extra_args`**: 当专用工具缺少某个命令行参数时,应使用 `extra_args` 字段来传递这些额外参数。
- **工具调用语法**: 工具调用必须在 `execution_operations` 的 `action` 字段中定义,格式为 `{{"tool": "工具名称", "params": {{...}} }}`。
- **严格匹配**: 工具名称和参数必须完全匹配可用工具列表中的定义。
- **RAG失败升级**: 知识检索多次无效且陷入僵局时,**必须**调用 `expert_analysis`,并附上检索词、源类型、关键证据与错误摘要作为上下文。
"""

        return tools_section

    def _render_planning_context_section(self, planner_context) -> str:
        """
        生成规划上下文摘要部分

        Args:
            planner_context: 规划上下文对象

        Returns:
            格式化的上下文摘要字符串
        """
        from datetime import datetime

        # 这里可以复用 planner.py 中的逻辑
        # 为简化示例,这里只提供基本实现
        summary = []

        if hasattr(planner_context, "planning_history") and planner_context.planning_history:
            summary.append("## 历史规划上下文")
            summary.append("\n### 规划历史摘要")
            for attempt in planner_context.planning_history[-3:]:
                timestamp = datetime.fromtimestamp(attempt.timestamp).strftime("%H:%M:%S")
                summary.append(f"- {timestamp}: 策略「{attempt.strategy}」→ {attempt.outcome_summary}")

        return "\n".join(summary)

    def _render_reflection_context_section(self, reflector_context) -> str:
        """
        生成反思上下文摘要部分

        Args:
            reflector_context: 反思上下文对象

        Returns:
            格式化的反思上下文摘要字符串
        """
        # 为简化示例,这里只提供基本实现
        summary = []

        if hasattr(reflector_context, "reflection_log") and reflector_context.reflection_log:
            summary.append("## 历史反思上下文")
            summary.append("\n### 相关历史反思")
            for reflection in reflector_context.reflection_log[-3:]:
                summary.append(f"- {reflection.subtask_id}: {reflection.key_insight}")

        return "\n".join(summary)

    def build_branch_replan_prompt(self, original_branch_goal: str, failure_reason: str, dead_end_tasks: list) -> str:
        """
        构建分支重规划提示词

        Args:
            original_branch_goal: 失败的分支目标
            failure_reason: 失败原因描述
            dead_end_tasks: 需要废弃的任务ID列表

        Returns:
            格式化后的分支重规划提示词字符串
        """
        # 组装输入变量
        input_variables = {
            "original_branch_goal": original_branch_goal,
            "failure_reason": failure_reason,
            "dead_end_tasks": json.dumps(dead_end_tasks, indent=2, ensure_ascii=False),
        }

        return self.branch_replan_template.render(**input_variables)
