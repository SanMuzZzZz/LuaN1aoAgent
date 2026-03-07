# core/planner.py

import json
from datetime import datetime
from typing import List, Dict, Any, Optional




def _get_console():
    """Lazy initialization of console to avoid circular imports."""
    from core.console import console_proxy
    return console_proxy
from core.events import broker
from llm.llm_client import LLMClient


class Planner:
    """
    规划器：负责将高级目标分解为可执行的子任务图，并生成图操作指令。

    该类实现了Plan-on-Graph (PoG)架构的核心规划功能，支持：
    - 初始规划：将高级目标分解为基本任务图
    - 动态规划：基于执行反馈和情报摘要进行自适应重规划
    - 分支再生：为失败的计划分支生成替代方案
    - 上下文感知：整合历史规划、反思报告和环境上下文

    Attributes:
        llm_client: LLM客户端实例，用于生成规划决策
        _run_log_path: 运行日志文件路径
        _log_dir: 日志目录路径
        _console_output_path: 控制台输出日志路径
    """

    def __init__(self, llm_client: LLMClient, output_mode: str = "default"):
        self.llm_client = llm_client
        self.output_mode = output_mode # Store output_mode
        self._run_log_path = None
        self._log_dir = None
        self._last_dynamic_prompt = None
        self._last_dynamic_response = None

    def set_log_dir(self, log_dir: Optional[str]) -> None:
        """
        设置日志目录路径。

        Args:
            log_dir: 日志目录路径，如果为None则禁用日志记录

        Returns:
            None
        """
        import os

        self._log_dir = log_dir
        self._run_log_path = os.path.join(log_dir, "run_log.json") if log_dir else None
        self._console_output_path = os.path.join(log_dir, "console_output.log") if log_dir else None

    def _generate_planner_prompt(self, goal: str, causal_graph_summary: str = "") -> str:
        """
        生成初始规划提示词。

        使用PromptManager生成格式化的规划提示词。

        Args:
            goal: 用户的高级目标描述
            causal_graph_summary: 因果图摘要信息（可选）

        Returns:
            str: 格式化后的规划提示词字符串
        """
        from core.prompts import PromptManager

        manager = PromptManager()
        context = {"causal_graph_summary": causal_graph_summary or "因果链图谱为空。"}

        return manager.build_planner_prompt(goal, context)

    def _generate_planning_context_section(self, planner_context) -> str:
        """
        生成规划上下文摘要部分。

        整合历史规划、被拒策略、长期目标、环境上下文、最新反思报告和LLM推理记录，
        形成完整的规划上下文摘要。

        Args:
            planner_context: 规划上下文对象，包含历史规划和反思信息

        Returns:
            str: 格式化的上下文摘要字符串
        """

        # 生成规划历史摘要
        planning_history_summary = self._generate_planning_history_summary(planner_context)

        # 生成被拒策略摘要
        rejected_strategies_summary = self._generate_rejected_strategies_summary(planner_context)

        # 生成长期目标摘要
        long_term_objectives_summary = self._generate_long_term_objectives_summary(planner_context)

        # 生成目标环境上下文
        target_environment_context = self._generate_target_environment_context(planner_context)

        # 生成最新反思报告摘要
        latest_reflection_summary = self._generate_latest_reflection_summary(planner_context)

        # 生成完整LLM推理记录摘要
        llm_reasoning_summary = self._generate_llm_reasoning_summary(planner_context)

        context_section = f"""
## 历史规划上下文（增强版）

### 规划历史摘要
{planning_history_summary}

### 避免的策略模式
{rejected_strategies_summary}

### 长期战略目标
{long_term_objectives_summary}

### 目标环境特征
{target_environment_context}

### 最新反思洞察
{latest_reflection_summary}

### 完整LLM推理记录
{llm_reasoning_summary}
"""
        return context_section

    def _generate_planning_history_summary(self, planner_context) -> str:
        """
        生成规划历史摘要。

        Args:
            planner_context: 规划上下文对象

        Returns:
            str: 最近3次规划尝试的摘要字符串
        """
        if not planner_context.planning_history:
            return "无历史规划记录"

        summary = []
        for attempt in planner_context.planning_history[-3:]:  # 最近3次尝试
            timestamp = datetime.fromtimestamp(attempt.timestamp).strftime("%H:%M:%S")
            summary.append(f"- {timestamp}: 策略「{attempt.strategy}」→ {attempt.outcome_summary}")
        return "\n".join(summary)

    def _generate_rejected_strategies_summary(self, planner_context) -> str:
        """
        生成被拒策略摘要。

        Args:
            planner_context: 规划上下文对象

        Returns:
            str: 被拒策略列表的格式化字符串
        """
        if not planner_context.rejected_strategies:
            return "无被明确拒绝的策略"

        return "\n".join(
            [f"- {strategy}: {reason}" for strategy, reason in planner_context.rejected_strategies.items()]
        )

    def _generate_long_term_objectives_summary(self, planner_context) -> str:
        """
        生成长期目标摘要。

        Args:
            planner_context: 规划上下文对象

        Returns:
            str: 长期目标列表的格式化字符串
        """
        if not planner_context.long_term_objectives:
            return "暂无长期战略目标"

        return "\n".join([f"- {objective}" for objective in planner_context.long_term_objectives])

    def _generate_target_environment_context(self, planner_context) -> str:
        """
        生成目标环境上下文。

        Args:
            planner_context: 规划上下文对象

        Returns:
            str: 目标URL信息的格式化字符串
        """
        if not planner_context.target_url:
            return "目标URL未指定"

        return f"目标URL: {planner_context.target_url}"

    def _format_issues_summary(self, issues: list, issue_type: str) -> str:
        """
        格式化问题摘要。

        Args:
            issues: 问题列表
            issue_type: 问题类型名称

        Returns:
            格式化的问题摘要
        """
        if not issues:
            return ""

        summary = ", ".join([f"{issue[:30]}..." if len(issue) > 30 else issue for issue in issues[:2]])
        if len(issues) > 2:
            summary += f" 等{len(issues)}个{issue_type}问题"
        return f"{issue_type}问题: {summary}"

    def _extract_audit_info(self, report: dict) -> list:
        """
        从报告中提取审计信息。

        Returns:
            审计信息列表
        """
        summary = []
        audit = report.get("audit_result", {})
        if not isinstance(audit, dict):
            return summary

        status = audit.get("status")
        check = audit.get("completion_check")
        if status:
            summary.append(f"审计状态: {status}")
        if check:
            summary.append(f"完成检查: {check}")

        # 处理方法论问题
        methodology_issues = audit.get("methodology_issues", [])
        if methodology_issues:
            issues_text = self._format_issues_summary(methodology_issues, "方法论")
            if issues_text:
                summary.append(issues_text)

        # 处理逻辑问题
        logic_issues = audit.get("logic_issues", [])
        if logic_issues:
            logic_text = self._format_issues_summary(logic_issues, "逻辑")
            if logic_text:
                summary.append(logic_text)

        return summary

    def _extract_findings_and_intelligence(self, report: dict) -> list:
        """
        从报告中提取关键发现和攻击情报。

        Returns:
            信息列表
        """
        summary = []

        # 关键发现
        findings = report.get("key_findings", [])
        if isinstance(findings, list) and findings:
            summary.append("关键发现:")
            for item in findings[:3]:
                summary.append(f"  - {item if isinstance(item, str) else str(item)}")

        # 攻击情报
        intel = report.get("attack_intelligence", {})
        if isinstance(intel, dict):
            actions = intel.get("actionable_insights", [])
            protections = intel.get("protection_mechanisms", [])
            if actions:
                summary.append("推荐行动:")
                for a in actions[:3]:
                    summary.append(f"  - {a}")
            if protections:
                summary.append("防护机制:")
                for p in protections[:3]:
                    summary.append(f"  - {p}")

        return summary

    def _generate_latest_reflection_summary(self, planner_context) -> str:
        """
        生成最新反思报告摘要。

        Args:
            planner_context: 规划上下文对象，包含最新的反思报告

        Returns:
            str: 反思报告关键信息的格式化摘要字符串
        """
        if not planner_context.latest_reflection_report:
            return "暂无最新反思报告"

        report = planner_context.latest_reflection_report
        summary = []

        if isinstance(report, dict):
            # 提取审计信息
            summary.extend(self._extract_audit_info(report))

            # 提取关键发现和攻击情报
            summary.extend(self._extract_findings_and_intelligence(report))

            # 验证节点信息
            nodes = report.get("validated_nodes", [])
            if isinstance(nodes, list) and nodes:
                summary.append(f"验证节点: {len(nodes)}项")

        return "\n".join(summary) if summary else "反思报告内容格式待解析"

    def _generate_llm_reasoning_summary(self, planner_context) -> str:
        """
        生成完整LLM推理记录摘要。

        Args:
            planner_context: 规划上下文对象，包含LLM推理历史

        Returns:
            LLM输入提示词、输出响应和推理过程的格式化摘要
        """
        if not planner_context.planning_history:
            return "暂无LLM推理记录"

        # 获取最近的规划尝试
        latest_attempt = planner_context.planning_history[-1]
        summary = []

        # 显示LLM输入提示词摘要
        if latest_attempt.llm_input_prompt:
            prompt_preview = latest_attempt.llm_input_prompt
            summary.append(f"LLM输入提示词: {prompt_preview}")

        # 显示LLM输出响应摘要
        if latest_attempt.llm_output_response:
            response_preview = latest_attempt.llm_output_response
            summary.append(f"LLM输出响应: {response_preview}")

        if latest_attempt.chain_of_thought:
            cot_preview = latest_attempt.chain_of_thought
            summary.append(f"推理过程: {cot_preview}")

        return "\n".join(summary) if summary else "LLM推理记录详情待完善"

    def _write_run_log(self, plan_data: Dict | None) -> None:
        if not getattr(self, "_run_log_path", None):
            return
        import time
        import os
        log_entry = {
            "event": "planner_completed",
            "plan": plan_data if isinstance(plan_data, dict) else {},
            "timestamp": float(time.time()),
        }
        try:
            if os.path.exists(self._run_log_path):
                with open(self._run_log_path, "r", encoding="utf-8") as f:
                    old_log = json.load(f)
            else:
                old_log = []
            old_log.append(log_entry)
            with open(self._run_log_path, "w", encoding="utf-8") as f:
                json.dump(old_log, f, ensure_ascii=False, indent=2)
        except Exception:
            pass


    async def _emit_planning_completed(self, plan_data: Dict | None) -> None:
        try:
            import os
            op_id = os.path.basename(self._log_dir) if getattr(self, "_log_dir", None) else None
            await broker.emit(
                "planning.initial.completed",
                {
                    "operations_count": len((plan_data or {}).get("graph_operations", []))
                    if isinstance(plan_data, dict)
                    else 0
                },
                op_id=op_id,
            )
        except Exception:
            pass


    def _sanitize_graph_operations(
        self, ops: List[Dict], completed_node_ids: set = None
    ) -> List[Dict]:
        """
        净化图操作指令：去重 ADD_NODE，代码层保护 completed 节点不被修改状态。
        违规的 UPDATE_NODE 操作不静默丢弃，而是记录警告并跳过，
        调用方可将警告注入下一轮 LLM 上下文实现可见反馈。
        """
        sanitized: List[Dict] = []
        seen_add_ids: set = set()
        protected_ids: set = completed_node_ids or set()
        self._last_sanitize_warnings: List[Dict] = []  # 供调用方读取，注入 LLM 反馈

        for op in ops:
            cmd = op.get("command")

            if cmd == "ADD_NODE":
                node_id = op.get("node_data", {}).get("id")
                if not node_id or node_id == "None":
                    continue
                if node_id in seen_add_ids:
                    continue
                seen_add_ids.add(node_id)
                sanitized.append(op)

            elif cmd in {"DELETE_NODE", "DEPRECATE_NODE", "UPDATE_NODE"}:
                node_id = op.get("node_id")
                if not node_id:
                    continue
                # 代码层强制保护：禁止对 completed 节点执行任何修改（包括废弃）
                if node_id in protected_ids:
                    if cmd in {"DELETE_NODE", "DEPRECATE_NODE"}:
                        warning = {
                            "error_code": "IMMUTABLE_STATUS_VIOLATION",
                            "rejected_operation": op,
                            "reason": (
                                f"节点 '{node_id}' 当前状态为 completed（不可变历史事实），"
                                f"禁止执行 {cmd} 操作。"
                            ),
                            "suggested_fix": (
                                f"已完成节点不可废弃。若需扩展其工作，使用 ADD_NODE 创建新任务"
                                f"并在 dependencies 中引用 '{node_id}'。"
                            ),
                        }
                        self._last_sanitize_warnings.append(warning)
                        _get_console().print(
                            f"[yellow]⚠ Sanitizer: 拦截对已完成节点 '{node_id}' 的 {cmd} 操作[/yellow]"
                        )
                        continue
                if cmd == "UPDATE_NODE":
                    if not op.get("updates"):
                        continue
                    # 代码层强制保护：禁止修改 completed 节点的状态
                    new_status = op.get("updates", {}).get("status")
                    if new_status and new_status != "completed" and node_id in protected_ids:
                        warning = {
                            "error_code": "IMMUTABLE_STATUS_VIOLATION",
                            "rejected_operation": op,
                            "reason": (
                                f"节点 '{node_id}' 当前状态为 completed（不可变历史事实），"
                                f"禁止修改为 '{new_status}'。"
                            ),
                            "suggested_fix": (
                                f"若需补充 '{node_id}' 的工作，请使用 ADD_NODE 创建新任务"
                                f"并在 dependencies 中引用 '{node_id}'。"
                            ),
                        }
                        self._last_sanitize_warnings.append(warning)
                        _get_console().print(
                            f"[yellow]⚠ Sanitizer: 拦截对已完成节点 '{node_id}' 的状态修改"
                            f"（尝试改为 '{new_status}'）[/yellow]"
                        )
                        continue
                sanitized.append(op)

            else:
                sanitized.append(op)

        return sanitized

    async def plan(self, goal: str, causal_graph_summary: str = "") -> tuple[List[Dict], Dict]:
        """
        执行规划，将目标分解为图操作指令。

        Args:
            goal: 用户输入的高级目标
            causal_graph_summary: 当前的产出物图谱摘要

        Returns:
            tuple: 包含以下元素
                - 图操作字典列表
                - LLM调用指标字典
        """

        prompt = self._generate_planner_prompt(goal, causal_graph_summary)
        messages = [{"role": "user", "content": prompt}]

        try:
            plan_data, call_metrics = await self.llm_client.send_message(messages, role="planner")
            self._write_run_log(plan_data)
            await self._emit_planning_completed(plan_data)
            if isinstance(plan_data, dict) and "graph_operations" in plan_data:
                sanitized_ops = self._sanitize_graph_operations(
                    plan_data["graph_operations"], completed_node_ids=set()
                )
                return sanitized_ops, call_metrics
            else:
                raise ValueError("Planner输出格式错误，缺少 `graph_operations` 键。")

        except (json.JSONDecodeError, ValueError, Exception) as e:
            # 记录异常到console_output.log
            if hasattr(self, "_console_output_path") and self._console_output_path:
                try:
                    with open(self._console_output_path, "a", encoding="utf-8") as f:
                        f.write(f"[ERROR] Planner异常: {type(e).__name__}: {e}\n")
                except Exception:
                    pass
            print(f"解析Planner输出失败: {e}")
            fallback_plan = [
                {
                    "command": "ADD_NODE",
                    "node_data": {
                        "id": "subtask_1",
                        "description": f"执行初步信息收集以理解目标: {goal}",
                        "dependencies": [],
                        "priority": 1,
                    },
                }
            ]
            return fallback_plan, None

    def _generate_dynamic_planner_prompt(
        self,
        goal: str,
        graph_summary: str,
        intelligence_summary: str,
        retrieved_experience: str,
        causal_graph_summary: str,
        attack_path_summary: str = "",
        failure_patterns_summary: Dict[str, Any] = None,
        failed_tasks_summary: str = "",
        planner_context=None,
    ) -> str:
        """
        生成动态规划提示词（使用 PromptManager）。

        Args:
            goal: 用户的高级目标
            graph_summary: 图状态摘要
            intelligence_summary: 情报摘要（JSON格式）
            retrieved_experience: 检索到的经验知识
            causal_graph_summary: 因果图摘要
            attack_path_summary: 攻击路径摘要（可选）
            failure_patterns_summary: 失败模式摘要（可选）
            failed_tasks_summary: 失败任务摘要（可选）
            planner_context: 规划上下文对象（可选）

        Returns:
            格式化后的动态规划提示词字符串
        """
        from core.prompts import PromptManager
        from core.prompts.renderers import render_failure_patterns

        manager = PromptManager()

        failure_patterns_text = render_failure_patterns(failure_patterns_summary)

        context = {
            "causal_graph_summary": causal_graph_summary or "因果链图谱为空。",
            "failure_patterns": failure_patterns_text,
            "failed_tasks_summary": failed_tasks_summary,
            "retrieved_experience": retrieved_experience or "",
            "graph_summary": graph_summary or "",
            "intelligence_summary": intelligence_summary or {},
        }

        # 使用 PromptManager 生成动态规划提示词（包含 Dynamic Context）
        return manager.build_planner_prompt(
            goal=goal, context=context, is_dynamic=True, planner_context=planner_context
        )

    async def dynamic_plan(
        self,
        goal: str,
        graph_summary: str,
        intelligence_summary: Optional[Dict[str, Any]],
        causal_graph_summary: str = "",
        attack_path_summary: str = "",
        failure_patterns_summary: Dict[str, Any] = None,  # New
        graph_manager=None,  # 新增参数用于访问探索状态
        planner_context=None,  # 新增：Planner上下文对象
    ) -> tuple[Dict[str, Any], Dict]:
        """
        基于情报摘要执行动态规划（重构版：主动决策而非审批）。

        Args:
            goal: 用户的高级目标
            graph_summary: 图状态摘要
            intelligence_summary: 情报摘要字典
            long_mem: 长期记忆对象
            causal_graph_summary: 因果图摘要（可选）
            attack_path_summary: 攻击路径摘要（可选）
            failure_patterns_summary: 失败模式摘要（可选）
            graph_manager: 图管理器，用于访问探索状态（可选）
            planner_context: 规划上下文对象（可选）

        Returns:
            元组包含：
            - 规划决策字典，包含图操作列表
            - LLM调用指标字典
        """
        if not intelligence_summary:
            return {}, None

        # --- Start of Optimization 2: Failure-Driven Replanning ---
        failed_tasks_summary = ""
        if graph_manager:
            failed_nodes = graph_manager.get_failed_nodes()
            if failed_nodes:
                failed_tasks_list = []
                for node_id, data in failed_nodes.items():
                    failed_tasks_list.append(
                        f"- Task ID: {node_id}, Status: {data.get('status')}, Description: {data.get('description')}"
                    )
                failed_tasks_summary = (
                    "\n### 高优先级：失败/阻塞的任务\n你必须优先处理以下失败或阻塞的任务。请为它们设计诊断或替代方案。\n"
                    + "\n".join(failed_tasks_list)
                )
        # --- End of Optimization 2 ---

        intelligence_str = json.dumps(intelligence_summary, indent=2, ensure_ascii=False)

        # RAG 检索集成预留位
        # retrieved_experience = await rag_client.query(...)
        retrieved_experience = ""  # 暂时为空，待后续集成 RAG

        # Inject the failed tasks summary into the prompt generation
        prompt = self._generate_dynamic_planner_prompt(
            goal,
            graph_summary,
            intelligence_str,
            retrieved_experience,
            causal_graph_summary,
            attack_path_summary,
            failure_patterns_summary,
            failed_tasks_summary,
            planner_context=planner_context,
        )
        self._last_dynamic_prompt = prompt
        self._last_dynamic_response = None
        messages = [{"role": "user", "content": prompt}]

        try:
            plan_data, call_metrics = await self.llm_client.send_message(messages, role="planner")
            if isinstance(plan_data, (dict, list)):
                self._last_dynamic_response = json.dumps(plan_data, ensure_ascii=False)
            elif plan_data is None:
                self._last_dynamic_response = None
            else:
                self._last_dynamic_response = str(plan_data)
            
            if isinstance(plan_data, dict) and "graph_operations" in plan_data:
                plan_data.setdefault("reasoning", {})
                plan_data.setdefault("global_mission_briefing", "")
                # 净化并保护 completed 节点
                completed_ids = graph_manager.get_completed_node_ids() if graph_manager else set()
                plan_data["graph_operations"] = self._sanitize_graph_operations(
                    plan_data["graph_operations"], completed_node_ids=completed_ids
                )
                try:
                    import os

                    await broker.emit(
                        "planning.dynamic.completed",
                        {"operations_count": len(plan_data.get("graph_operations", []))},
                        op_id=os.path.basename(self._log_dir) if getattr(self, "_log_dir", None) else None,
                    )
                except Exception:
                    pass
                return plan_data, call_metrics
            else:
                raise ValueError("Planner输出格式错误，缺少 `graph_operations` 键。")

        except (json.JSONDecodeError, ValueError, Exception) as e:
            print(f"解析Planner动态输出失败: {e}")
            return {}, None

    async def regenerate_branch_plan(
        self, goal: str, graph_manager, failed_branch_root_id: str, failure_reason: str
    ) -> tuple[List[Dict], Dict]:
        """
        为一个失败的计划分支生成替代方案（已迁移到新模板系统）。

        Args:
            goal: 用户的高级目标
            graph_manager: 图管理器实例
            failed_branch_root_id: 失败分支的根节点ID
            failure_reason: 失败原因描述

        Returns:
            元组包含：
            - 图操作列表（净化后的替代方案）
            - LLM调用指标字典
        """
        from core.prompts import PromptManager

        # 1. 收集上下文
        try:
            original_branch_goal = graph_manager.graph.nodes[failed_branch_root_id].get("description", "[目标描述丢失]")
            descendants = graph_manager.get_descendants(failed_branch_root_id)
            dead_end_tasks = list({failed_branch_root_id}.union(descendants))
        except Exception as e:
            _get_console().print(f"[bold red]在分支重新规划中收集上下文失败: {e}[/bold red]")
            return [], None

        # 2. 使用 PromptManager 构建提示词
        manager = PromptManager()
        prompt = manager.build_branch_replan_prompt(
            original_branch_goal=original_branch_goal, failure_reason=failure_reason, dead_end_tasks=dead_end_tasks
        )

        messages = [{"role": "user", "content": prompt}]

        # 3. 调用LLM并处理响应
        try:
            plan_data, call_metrics = await self.llm_client.send_message(messages, role="planner_crisis_expert")

            if isinstance(plan_data, dict) and "graph_operations" in plan_data:
                # 分支再生输出净化：剪枝失败分支、去重、过滤不存在/死枝目标
                ops = plan_data["graph_operations"]
                sanitized_ops = []
                seen_add_ids = set()

                # 获取失败分支的后代集合，用于过滤不必要更新
                try:
                    descendants = graph_manager.get_descendants(failed_branch_root_id)
                    dead_branch_ids = {failed_branch_root_id}.union(descendants)
                except Exception:
                    dead_branch_ids = {failed_branch_root_id}

                for op in ops:
                    cmd = op.get("command")
                    if cmd == "ADD_NODE":
                        node_data = op.get("node_data", {})
                        node_id = node_data.get("id")
                        if not node_id or node_id == "None":
                            continue
                        if node_id in seen_add_ids:
                            continue
                        
                        # 关键修复：清理新节点的依赖关系，移除对dead_branch的依赖
                        dependencies = node_data.get("dependencies", [])
                        if dependencies:
                            # 过滤掉指向dead_branch的依赖
                            clean_dependencies = [dep for dep in dependencies if dep not in dead_branch_ids]
                            
                            # 如果所有依赖都被移除了，需要找到一个合适的替代依赖
                            if not clean_dependencies and dependencies:
                                # 尝试找到dead_branch父节点的其他健康子节点
                                try:
                                    # 获取失败分支的父节点
                                    parents_of_failed = list(graph_manager.graph.predecessors(failed_branch_root_id))
                                    if parents_of_failed:
                                        parent = parents_of_failed[0]
                                        # 获取父节点的其他已完成的子节点
                                        siblings = [succ for succ in graph_manager.graph.successors(parent) 
                                                   if graph_manager.graph.nodes[succ].get('status') == 'completed'
                                                   and succ not in dead_branch_ids]
                                        if siblings:
                                            clean_dependencies = [siblings[-1]]  # 使用最后一个完成的兄弟节点
                                        else:
                                            # 如果没有兄弟节点，直接依赖父节点
                                            clean_dependencies = [parent]
                                except Exception as e:
                                    _get_console().print(f"[yellow]警告：无法自动修复节点 {node_id} 的依赖关系: {e}[/yellow]")
                                    # 如果无法找到替代依赖，将依赖设为空（成为根节点的直接子节点）
                                    clean_dependencies = []
                            
                            node_data["dependencies"] = clean_dependencies
                        
                        # 若要添加的节点已存在，则交由执行层处理为更新；此处仍保留，但避免重复
                        seen_add_ids.add(node_id)
                        sanitized_ops.append(op)
                    elif cmd in {"DELETE_NODE", "DEPRECATE_NODE", "UPDATE_NODE"}:
                        node_id = op.get("node_id")
                        if not node_id:
                            continue
                        # 跳过对失败分支及其后代的更新，改为 DEPRECATE
                        if node_id in dead_branch_ids and cmd == "UPDATE_NODE":
                            sanitized_ops.append(
                                {
                                    "command": "DEPRECATE_NODE",
                                    "node_id": node_id,
                                    "reason": f"Branch '{failed_branch_root_id}' failed: {failure_reason}",
                                }
                            )
                            continue
                        if cmd == "UPDATE_NODE":
                            if not op.get("updates"):
                                continue
                            # 保护 completed 节点（branch_replan 不应修改已完成任务状态）
                            new_status = op.get("updates", {}).get("status")
                            completed_ids = graph_manager.get_completed_node_ids()
                            if new_status and new_status != "completed" and node_id in completed_ids:
                                _get_console().print(
                                    f"[yellow]⚠ BranchReplan Sanitizer: 拦截对已完成节点 '{node_id}'"
                                    f" 的状态修改（尝试改为 '{new_status}'）[/yellow]"
                                )
                                continue
                        sanitized_ops.append(op)
                    else:
                        sanitized_ops.append(op)

                return sanitized_ops, call_metrics
            else:
                raise ValueError("分支重新规划的输出格式错误，缺少 `graph_operations` 键。")

        except (json.JSONDecodeError, ValueError, Exception) as e:
            _get_console().print(f"[bold red]解析分支重新规划输出失败: {e}[/bold red]")
            return [], None

    def update_planner_context_after_planning(
        self, planner_context, plan_data, graph_manager, llm_prompt=None, llm_response=None
    ):
        """
        在规划完成后更新PlannerContext状态，保存完整的LLM输入输出。

        Args:
            planner_context: 规划上下文对象
            plan_data: 规划决策数据
            graph_manager: 图管理器实例
            llm_prompt: LLM输入提示词（可选）
            llm_response: LLM输出响应（可选）

        Returns:
            更新后的规划上下文对象
        """
        from core.data_contracts import PlanningAttempt
        import time

        # 创建新的规划尝试记录（包含完整LLM输入输出）
        attempt = PlanningAttempt(
            timestamp=time.time(),
            goal=plan_data.get("goal", ""),
            strategy=plan_data.get("strategy", ""),
            assumptions=plan_data.get("assumptions", []),
            generated_plan_summary={
                "operations_count": len(plan_data.get("graph_operations", [])),
                "nodes_added": [op.get("node_id") for op in plan_data.get("graph_operations", []) if op.get("node_id")],
                "success": True,  # 假设规划总是成功执行
            },
            llm_input_prompt=llm_prompt,  # 保存完整的LLM提示词
            llm_output_response=llm_response,  # 保存完整的LLM响应
        )

        planner_context.add_planning_attempt(attempt)

        # 更新长期目标（如果有）
        global_briefing = plan_data.get("global_mission_briefing", "")
        if global_briefing and "长期目标" in global_briefing:
            # 从全局简报中提取长期目标
            planner_context.long_term_objectives.append(global_briefing)

        # 保存上一次规划的完整会话记录
        planner_context.previous_planning_session = {
            "timestamp": time.time(),
            "plan_data": plan_data,
            "llm_prompt": llm_prompt,
            "llm_response": llm_response,
        }

        return planner_context
