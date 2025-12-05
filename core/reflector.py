# core/reflector.py

from datetime import datetime
from typing import Any, List, Dict, Optional
import json
import re




def _get_console():
    """Lazy initialization of console to avoid circular imports."""
    from core.console import console_proxy
    return console_proxy
from llm.llm_client import LLMClient
from core.graph_manager import GraphManager
from rich.console import Console
from core.events import broker


class Reflector:
    """
    反思器：负责复盘已完成的子任务，审核来自执行器的规划建议，
    并生成最终的、经过验证的图操作指令。

    该类实现了P-E-R架构中的反思功能，支持：
    - 子任务复盘：分析执行结果，验证产出物的有效性
    - 全局反思：对整个任务执行过程进行高层次总结
    - 情报生成：提取攻击情报和可操作的洞察
    - 上下文感知：整合历史反思记录和LLM推理过程

    Attributes:
        llm_client: LLM客户端实例，用于生成反思决策
        console: Rich控制台实例，用于格式化输出
        _run_log_path: 运行日志文件路径
        _log_dir: 日志目录路径
        _console_output_path: 控制台输出日志路径
    """

    def __init__(self, llm_client: LLMClient, output_mode: str = "default"):
        self.llm_client = llm_client
        self.output_mode = output_mode # Store output_mode
        self.console = Console()  # 初始化控制台实例用于格式化输出
        self._run_log_path = None
        self._log_dir = None

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

    def _generate_reflector_prompt(
        self,
        subtask_goal: str,
        status: str,
        execution_log: str,
        staged_causal_nodes: List[Dict],
        full_graph_summary: str,
        completion_criteria: str,
        dependency_context: Optional[List[Dict]] = None,
        failure_patterns_summary: Dict[str, Any] = None,
        *,
        reflector_context=None,
    ) -> str:
        """
        使用PromptManager生成反思器提示词（已迁移到新模板系统）。

        Args:
            subtask_goal: 子任务目标描述
            status: 子任务执行状态
            execution_log: 执行日志
            staged_causal_nodes: 暂存的因果节点列表
            full_graph_summary: 完整图摘要
            completion_criteria: 完成标准
            dependency_context: 依赖上下文（可选）
            failure_patterns_summary: 失败模式摘要（可选）
            reflector_context: 反思上下文对象（可选）

        Returns:
            str: 格式化后的反思器提示词字符串
        """
        from core.prompts import PromptManager

        manager = PromptManager()

        # 构建subtask对象
        subtask = {"description": subtask_goal, "completion_criteria": completion_criteria}

        # 构建context
        context = {
            "causal_graph_summary": full_graph_summary or "因果链图谱为空。",
            "dependency_context": dependency_context or [],
            "failure_patterns": failure_patterns_summary,
        }

        # 使用PromptManager生成提示词
        prompt = manager.build_reflector_prompt(
            subtask=subtask,
            status=status,
            execution_log=execution_log,
            staged_causal_nodes=staged_causal_nodes,
            context=context,
            reflector_context=reflector_context,
        )

        return prompt

    def _generate_reflection_context_section(self, reflector_context) -> str:
        """
        生成反思上下文摘要部分。

        整合已验证模式、持久性洞察、相关反思历史和LLM反思记录，
        形成完整的反思上下文摘要。

        Args:
            reflector_context: 反思上下文对象，包含历史反思和LLM推理信息

        Returns:
            str: 格式化的反思上下文摘要字符串
        """

        # 生成已验证模式摘要
        validated_patterns_summary = self._generate_validated_patterns_summary(reflector_context)

        # 生成持久性洞察摘要
        persistent_insights_summary = self._generate_persistent_insights_summary(reflector_context)

        # 生成相关反思历史
        relevant_reflection_log = self._generate_relevant_reflection_history(reflector_context)

        # 生成完整LLM反思记录摘要
        llm_reflection_summary = self._generate_llm_reflection_summary(reflector_context)

        context_section = f"""
## 历史反思上下文（增强版）

### 已验证的有效模式
{validated_patterns_summary}

### 持久性技术洞察
{persistent_insights_summary}

### 相关历史反思
{relevant_reflection_log}

### 完整LLM反思记录
{llm_reflection_summary}
"""
        return context_section

    def _generate_validated_patterns_summary(self, reflector_context) -> str:
        """
        生成已验证模式摘要。

        Args:
            reflector_context: 反思上下文对象

        Returns:
            str: 已验证的有效模式列表的格式化字符串
        """
        if not reflector_context.validated_patterns:
            return "暂无已验证的有效模式"

        summary = []
        for pattern in reflector_context.validated_patterns[-5:]:  # 最近5个模式
            summary.append(
                f"- {pattern.get('pattern_type', '未知模式')}: {pattern.get('description', '无描述')} "
                f"(置信度: {pattern.get('confidence', 0.0):.1f})"
            )
        return "\n".join(summary)

    def _generate_persistent_insights_summary(self, reflector_context) -> str:
        """
        生成持久性技术洞察摘要。

        Args:
            reflector_context: 反思上下文对象

        Returns:
            str: 持久性技术洞察列表的格式化字符串
        """
        if not reflector_context.persistent_insights:
            return "暂无持久性技术洞察"

        return "\n".join(
            [
                f"- {insight.get('insight_type', '未知洞察')}: {insight.get('description', '无描述')}"
                for insight in reflector_context.persistent_insights[-3:]
            ]
        )

    def _generate_relevant_reflection_history(self, reflector_context) -> str:
        """
        生成相关历史反思记录。

        Args:
            reflector_context: 反思上下文对象

        Returns:
            str: 最近3次反思尝试的摘要字符串
        """
        if not reflector_context.reflection_log:
            return "无历史反思记录"

        summary = []
        for reflection in reflector_context.reflection_log:
            ts = getattr(reflection, "timestamp", 0) or 0
            sub_id = getattr(reflection, "subtask_id", "未知任务")
            key_insight = getattr(reflection, "key_insight", "")
            rep = getattr(reflection, "full_reflection_report", None)
            status = None
            finding = None
            action = None
            artifacts_count = None
            if isinstance(rep, dict):
                audit = rep.get("audit_result", {})
                status = audit.get("status")
                kfs = rep.get("key_findings")
                if isinstance(kfs, list) and kfs:
                    finding = kfs[0] if isinstance(kfs[0], str) else str(kfs[0])
                intel = rep.get("attack_intelligence", {})
                acts = intel.get("actionable_insights")
                if isinstance(acts, list) and acts:
                    action = acts[0]
                # 验证节点信息（替代旧的validated_artifacts）
                nodes = rep.get("validated_nodes")
                if isinstance(nodes, list):
                    artifacts_count = len(nodes)
            timestamp = datetime.fromtimestamp(float(ts)).strftime("%H:%M:%S")
            parts = [f"- {timestamp}: {sub_id}"]
            if status:
                parts.append(f"状态: {status}")
            if key_insight:
                parts.append(f"洞察: {key_insight}")
            if finding:
                parts.append(f"发现: {finding}")
            if action:
                parts.append(f"建议: {action}")
            if artifacts_count is not None:
                parts.append(f"产出物: {artifacts_count}")
            summary.append(" | ".join(parts))
        return "\n".join(summary)

    def _extract_audit_summary(self, audit_result: dict, summary: list) -> None:
        """
        从审计结果中提取关键信息到摘要。

        Args:
            audit_result: 审计结果字典
            summary: 摘要列表，用于附加提取的信息
        """
        if not audit_result:
            return

        status = audit_result.get("status", "unknown")
        completion = audit_result.get("completion_check", "")
        strategic_failure = audit_result.get("is_strategic_failure", False)

        summary.append(f"审计状态: {status}")
        if completion:
            completion_preview = completion[:100] + "..." if len(completion) > 100 else completion
            summary.append(f"完成度检查: {completion_preview}")
        if strategic_failure:
            summary.append("战略性失败: 是")

        methodology_issues = audit_result.get("methodology_issues", [])
        if methodology_issues:
            issues_summary = ", ".join(
                [f"{issue[:30]}..." if len(issue) > 30 else issue for issue in methodology_issues[:2]]
            )
            if len(methodology_issues) > 2:
                issues_summary += f" 等{len(methodology_issues)}个方法论问题"
            summary.append(f"方法论问题: {issues_summary}")

        logic_issues = audit_result.get("logic_issues", [])
        if logic_issues:
            logic_summary = ", ".join([f"{issue[:30]}..." if len(issue) > 30 else issue for issue in logic_issues[:2]])
            if len(logic_issues) > 2:
                logic_summary += f" 等{len(logic_issues)}个逻辑问题"
            summary.append(f"逻辑问题: {logic_summary}")

    def _extract_attack_intelligence(self, attack_intelligence: dict, summary: list) -> None:
        """
        从政击情报中提取可执行洞察。

        Args:
            attack_intelligence: 攻击情报字典
            summary: 摘要列表，用于附加提取的信息
        """
        if not attack_intelligence:
            return

        actionable_insights = attack_intelligence.get("actionable_insights", [])
        if actionable_insights:
            insights_summary = ", ".join(
                [f"{insight[:40]}..." if len(insight) > 40 else insight for insight in actionable_insights[:2]]
            )
            if len(actionable_insights) > 2:
                insights_summary += f" 等{len(actionable_insights)}个可执行洞察"
            summary.append(f"攻击情报: {insights_summary}")

    def _extract_key_facts(self, key_facts: list, summary: list) -> None:
        """
        从关键事实列表中提取摘要。

        Args:
            key_facts: 关键事实列表
            summary: 摘要列表，用于附加提取的信息
        """
        if not key_facts:
            return

        facts_summary = ", ".join([f"{fact[:50]}..." if len(fact) > 50 else fact for fact in key_facts[:3]])
        if len(key_facts) > 3:
            facts_summary += f" 等{len(key_facts)}个关键事实"
        summary.append(f"关键事实: {facts_summary}")

    def _extract_causal_updates(self, causal_updates: dict, summary: list) -> None:
        """
        提取因果图更新类型。

        Args:
            causal_updates: 因果图更新字典
            summary: 摘要列表，用于附加提取的信息
        """
        if not causal_updates:
            return

        update_types = list(causal_updates.keys())
        summary.append(f"因果图更新类型: {', '.join(update_types)}")

    def _extract_prompt_context(self, llm_reflection_prompt: str, summary: list) -> None:
        """
        从LLM反思提示词中提取角色和核心职责。

        Args:
            llm_reflection_prompt: LLM反思提示词字符串
            summary: 摘要列表，用于附加提取的信息
        """
        if not llm_reflection_prompt:
            return

        role_match = re.search(r"# 角色: ([^\n]+)", llm_reflection_prompt)
        if role_match:
            summary.append(f"反思角色: {role_match.group(1)}")

        duties_match = re.search(r"## 核心职责\\s+([^#]+)", llm_reflection_prompt, re.DOTALL)
        if duties_match:
            duties = duties_match.group(1).strip()
            duties_preview = duties[:100] + "..." if len(duties) > 100 else duties
            summary.append(f"核心职责: {duties_preview}")

    def _extract_response_content(self, resp_text: str, summary: list) -> None:
        """
        从LLM反思响应中提取结构化内容。

        Args:
            resp_text: LLM反思响应文本
            summary: 摘要列表，用于附加提取的信息
        """
        try:
            resp_data = json.loads(resp_text)
            if isinstance(resp_data, dict):
                audit_result = resp_data.get("audit_result", {})
                if audit_result:
                    status = audit_result.get("status", "unknown")
                    summary.append(f"响应状态: {status}")

                    recommendations = resp_data.get("recommendations", [])
                    if recommendations:
                        rec_summary = ", ".join(
                            [rec[:50] + "..." if len(rec) > 50 else rec for rec in recommendations[:2]]
                        )
                        summary.append(f"关键建议: {rec_summary}")
        except json.JSONDecodeError:
            # 如果不是JSON，提取文本中的关键信息
            lines = resp_text.split("\n")
            key_lines = [
                line
                for line in lines
                if any(
                    keyword in line
                    for keyword in [
                        "漏洞",
                        "漏洞",
                        "vulnerability",
                        "Vulnerability",
                        "建议",
                        "recommendation",
                        "Recommendation",
                    ]
                )
            ]
            if key_lines:
                key_info = "; ".join([line[:80] + "..." if len(line) > 80 else line for line in key_lines[:3]])
                summary.append(f"响应关键信息: {key_info}")

    def _generate_llm_reflection_summary(self, reflector_context) -> str:
        """
        生成完整LLM反思记录摘要。

        Args:
            reflector_context: 反思上下文对象，包含LLM推理历史

        Returns:
            LLM输入提示词、输出响应和推理过程的格式化摘要
        """
        if not reflector_context.reflection_log:
            return "暂无LLM反思记录"

        # 获取最近的反思记录
        latest_reflection = reflector_context.reflection_log[-1]
        summary = []

        # 提取关键信息：从完整反思报告中提取核心洞察
        if hasattr(latest_reflection, "full_reflection_report") and latest_reflection.full_reflection_report:
            rep = latest_reflection.full_reflection_report
            if isinstance(rep, dict):
                self._extract_audit_summary(rep.get("audit_result", {}), summary)
                self._extract_attack_intelligence(rep.get("attack_intelligence", {}), summary)
                self._extract_key_facts(rep.get("key_facts", []), summary)
                self._extract_causal_updates(rep.get("causal_graph_updates", {}), summary)

        # 优化LLM反思提示词摘要 - 提取角色和核心职责
        if hasattr(latest_reflection, "llm_reflection_prompt") and latest_reflection.llm_reflection_prompt:
            self._extract_prompt_context(latest_reflection.llm_reflection_prompt, summary)

        # 优化LLM反思响应摘要 - 提取结构化响应内容
        if hasattr(latest_reflection, "llm_reflection_response") and latest_reflection.llm_reflection_response:
            self._extract_response_content(latest_reflection.llm_reflection_response, summary)

        return " | ".join(summary) if summary else "LLM反思记录详情待完善"

    def _normalize_dependency_context(self, dependency_context: Optional[List[Dict]], subtask_data: Dict) -> Optional[List[Dict]]:
        termination_reason = subtask_data.get("termination_reason")
        executed_steps = subtask_data.get("executed_steps")
        if dependency_context and isinstance(dependency_context, list):
            dependency_context = [
                item for item in dependency_context if not (isinstance(item, dict) and "termination_reason" in item)
            ]
        if termination_reason:
            dependency_context = dependency_context or []
            dependency_context.append(
                {
                    "termination_reason": termination_reason,
                    "executed_steps": executed_steps,
                    "source": "normalized",
                }
            )
        return dependency_context

    async def _evaluate_success_with_llm(self, completion_criteria: str, execution_log: str) -> bool:
        """
        使用LLM来验证任务是否成功，取代固定的正则表达式。

        Args:
            completion_criteria: 任务的自然语言完成标准。
            execution_log: 执行器的输出日志。

        Returns:
            bool: 如果LLM判断任务已成功，则返回True，否则返回False。
        """
        if not completion_criteria or not execution_log:
            return False

        try:
            prompt = f"""你是一位严格的渗透测试结果审计员。
- 任务的完成标准是："{completion_criteria}"
- 执行日志和结果如下："{execution_log}"

基于上述日志，请判断完成标准是否已明确且无歧义地达成？
仅回答 "true" 或 "false"。
"""
            messages = [{"role": "user", "content": prompt}]
            
            # 使用一个专用的、轻量级的验证角色
            response, _ = await self.llm_client.send_message(messages, role="reflector_validator")
            
            # 解析LLM的布尔值响应
            result_str = str(response).strip().lower()
            _get_console().print(f"🕵️  基于LLM的验证返回: [cyan]'{result_str}'[/cyan]", style="dim")
            return result_str == "true"
            
        except Exception as e:
            _get_console().print(f"⚠️ 基于LLM的验证失败: {e}", style="yellow")
            return False


    async def reflect(
        self,
        subtask_id: str,  # Add subtask_id as a parameter
        subtask_data: Dict,
        status: str,
        execution_log: str,
        proposed_changes: List[Dict],
        staged_causal_nodes: List[Dict],
        full_graph_summary: str,
        dependency_context: Optional[List[Dict]] = None,
        graph_manager=None,  # Add graph_manager to access causal graph analysis
        reflector_context=None,  # 新增：Reflector上下文对象
    ) -> Dict:
        """
        执行反思与审核。

        该函数实现了反思器的核心功能，包括：
        - 分析子任务执行结果和状态
        - 验证产出物的有效性和完整性
        - 生成攻击情报和可操作的洞察
        - 提供因果图更新建议
        - 支持失败模式分析和上下文感知

        Args:
            subtask_id: 子任务ID
            subtask_data: 子任务数据字典
            status: 子任务执行状态
            execution_log: 执行日志
            proposed_changes: 提议的变更列表
            staged_causal_nodes: 暂存的因果节点列表
            full_graph_summary: 完整图摘要
            long_mem: 长期记忆对象（可选）
            dependency_context: 依赖上下文（可选）
            graph_manager: 图管理器实例（可选）
            reflector_context: 反思上下文对象（可选）

        Returns:
            反思结果字典，包含审核结果、情报摘要、指标等
        """
        subtask_goal = subtask_data.get("id", subtask_id)
        completion_criteria = subtask_data.get("completion_criteria", "No specific criteria defined.")

        failure_patterns_summary = {}
        if graph_manager:
            failure_patterns_summary = graph_manager.analyze_failure_patterns()

        dependency_context = self._normalize_dependency_context(dependency_context, subtask_data)
        prompt = self._generate_reflector_prompt(
            subtask_goal,
            status,
            execution_log,
            staged_causal_nodes,
            full_graph_summary,
            completion_criteria,
            dependency_context,
            failure_patterns_summary,
            reflector_context=reflector_context,
        )
        messages = [{"role": "user", "content": prompt}]

        try:
            reflection_data, call_metrics = await self.llm_client.send_message(messages, role="reflector")
            if not reflection_data:
                raise ValueError("LLM returned no data for reflection.")

            reflection_data["metrics"] = call_metrics
            reflection_data["llm_reflection_prompt"] = prompt

            audit_result = reflection_data.get("audit_result", {})

            # 直接采用LLM的判断结果，由Planner决定任务是否已完成
            llm_reported_status = audit_result.get("status", "").upper()
            _get_console().print(f"🤖 LLM reported status: [bold green]{llm_reported_status}[/bold green]. Directly adopting LLM judgment.", style="dim")

            # 保持对 validated_nodes 的引用，因为它们可能包含除目标产物之外的其他有用证据
            reflection_data.setdefault("causal_graph_updates", {})
            try:
                import os

                op_id = os.path.basename(self._log_dir) if self._log_dir else None
                await broker.emit("reflection.completed", {"subtask_id": subtask_id}, op_id=op_id)
            except Exception:
                pass
            return reflection_data

        except (json.JSONDecodeError, ValueError) as e:
            # 记录异常到 console_output.log
            if hasattr(self, "_console_output_path") and self._console_output_path:
                try:
                    with open(self._console_output_path, "a", encoding="utf-8") as f:
                        f.write(f"[ERROR] Reflector异常: {type(e).__name__}: {e}\n")
                except Exception:
                    pass
            print(f"解析Reflector输出失败: {e}")
            try:
                import os

                op_id = os.path.basename(self._log_dir) if self._log_dir else None
                await broker.emit("reflection.completed", {"subtask_id": subtask_id, "error": str(e)}, op_id=op_id)
            except Exception:
                pass
            return {
                "audit_result": {
                    "status": "FAILED",
                    "completion_check": "解析失败",
                    "logic_issues": [str(e)],
                    "methodology_issues": [],
                },
                "key_findings": [],
                "validated_nodes": [],
                "insight": None,
                "causal_graph_updates": {},
                "metrics": None,
            }

    def _generate_global_reflector_prompt(self, simplified_graph: Dict[str, Any]) -> str:
        """
        生成用于全局反思的提示词，以提炼可复用的STE经验。

        该方法分析简化的因果图，生成针对全局反思的提示词，用于：
        - 识别成功的攻击模式和策略
        - 提取可复用的战术知识
        - 分析失败原因和改进建议
        - 生成策略-战术-示例(STE)知识框架

        Args:
            simplified_graph: 简化的因果图字典，包含节点和边信息

        Returns:
            全局反思提示词字符串，包含STE经验提取指导
        """
        simplified_graph_json = json.dumps(simplified_graph, indent=2, ensure_ascii=False)

        return f"""# 角色：首席渗透测试战略家与知识工程师

## 核心目标：
从一个已完成的、成功的攻击任务中，提炼出一个结构化的、可复用的经验，格式为“战略-战术-案例”(STE)。

## 待分析的成功攻击案例 (简化轨迹)：

```json
{simplified_graph_json}
```

## 提炼指令：

你必须严格按照以下步骤，将上述成功案例提炼成一个STE经验对象：

### 1. 评估成功质量 (CRITICAL)
你必须首先检查 `simplified_graph_json` 中是否存在 `node_type` 为 `ConfirmedVulnerability` 的节点。
- **如果存在 `ConfirmedVulnerability`**：这代表了一次高质量的、已验证的成功攻击。你的分析**必须**围绕导致这个节点的攻击路径展开。在 `global_summary` 中明确指出这是一个已确认的漏洞。
- **如果不存在 `ConfirmedVulnerability`**：这可能是一次偶然的成功（例如，仅找到flag但未理解漏洞），或者是一次常规的信息收集。你的分析应侧重于其机会主义性质和潜在的改进空间。

### 2. 提炼战略原则 (Strategic Principle)
- 这是最高层次的、一句话的攻击原则。
- 它应该回答“为什么（Why）”可以这么做，揭示了哪一类根本性的安全弱点。
- **示例**：“当认证令牌使用无MAC的CBC模式加密时，可通过篡改IV或前置密文块来伪造身份。”

### 3. 提炼战术手册 (Tactical Playbook)
- 这是实现该战略的、有序的、抽象的步骤列表。
- 它应该回答“如何做（How）”的步骤。
- 每个步骤都应该是一个动词短语，描述一个战术目标，而不是具体的工具调用。
- **示例**：
  ```json
  [
    "信息收集：获取原始加密令牌",
    "结构分析：识别加密模式、块大小和明文格式",
    "载荷构造：计算并生成篡改后的加密令牌",
    "攻击执行：使用篡改后的令牌访问受保护资源"
  ]
  ```

### 4. 定义适用场景 (Applicability)
- 这是一个标签列表，定义了该STE经验最可能在哪些场景下被复用。
- **示例**：`["web_security", "session_hijacking", "cbc_bit_flipping", "ctf"]`

## 输出格式 (仅限JSON):

你**必须**输出一个结构合法的 JSON 对象，其中必须包含 `global_summary`, `strategic_analysis`, 和 `global_insight` 键。`global_insight` 必须严格遵循STE格式。

{{
  "global_summary": "用一句话总结整个任务的核心战役路径和最终结果。",
  "strategic_analysis": "对整体战略的详细分析，包括规划、执行和反思的亮点与不足。",
  "global_insight": {{
    "strategic_principle": "此处填写你提炼的战略原则。",
    "tactical_playbook": [
      "此处填写第一个战术步骤",
      "此处填写第二个战术步骤",
      "..."
    ],
    "applicability": ["tag1", "tag2", "..."]
  }}
}}
"""

    async def reflect_global(self, graph_manager: GraphManager) -> Dict:
        """
        执行全局反思，生成最高层次的战略洞见和经验总结。

        该函数实现了对整个任务图谱的全局反思功能，包括：
        - 检查任务目标是否达成
        - 简化因果图并生成全局反思提示词
        - 调用LLM生成战略分析和全局洞察
        - 提取可复用的STE（策略-战术-示例）经验

        Args:
            graph_manager: 图管理器实例，提供任务图谱和状态信息

        Returns:
            全局反思结果字典，包含战略分析、全局洞察、指标等
        """
        if not graph_manager.is_goal_achieved():
            return {
                "global_summary": "任务未成功，跳过全局经验归档。",
                "strategic_analysis": "",
                "global_insight": None,
                "metrics": None,
            }

        simplified_graph = graph_manager.get_simplified_graph()
        prompt = self._generate_global_reflector_prompt(simplified_graph)
        messages = [{"role": "user", "content": prompt}]

        try:
            response, call_metrics = await self.llm_client.send_message(messages, role="reflector")
            if not response:
                raise ValueError("LLM returned no data for global reflection.")

            # response is already a dictionary from llm_client, not a JSON string
            global_reflection_data = response
            global_reflection_data["metrics"] = call_metrics

            if global_reflection_data.get("global_insight"):
                global_reflection_data["global_insight"]["example_trajectory"] = simplified_graph

            return global_reflection_data

        except (json.JSONDecodeError, ValueError) as e:
            print(f"解析Global Reflector输出失败: {e}")
            return {
                "global_summary": "全局反思失败，无法解析LLM输出。",
                "strategic_analysis": "",
                "global_insight": None,
                "metrics": None,
            }
