"""
数据契约定义
定义 Planner、Executor、Reflector 之间的标准化数据结构
"""

from typing import List, Dict, Any, Optional, Literal, Union
from dataclasses import dataclass, field
import uuid
from xml.dom import Node
from conf.config import PLANNER_HISTORY_WINDOW, REFLECTOR_HISTORY_WINDOW

# ==================================================


@dataclass
class BaseCausalNode:
    """
    因果链图谱节点基类.

    所有因果链图谱节点的基础类，定义了节点的基本属性。
    子类包括 EvidenceNode（证据）、HypothesisNode（假设）、
    VulnerabilityNode（漏洞）、ExploitNode（利用）等。

    Attributes:
        id: 节点唯一标识符，如未提供则自动生成UUID
        source_step_id: 产生该节点的执行步骤ID（可选）
        traceability: 可追溯性信息，用于记录节点来源（可选）
        node_type: 节点类型，由子类自动设置
    """

    id: str
    source_step_id: Optional[str]
    traceability: Optional[str]
    node_type: str = field(init=False)

    def __post_init__(self):
        if not self.id:
            self.id = str(uuid.uuid4())
        if not hasattr(self, "node_type") or not self.node_type:
            self.node_type = "BaseCausalNode"  # Default for base class
        if self.source_step_id is None:
            self.source_step_id = ""
        if self.traceability is None:
            self.traceability = ""


class EvidenceNode(BaseCausalNode):
    """
    证据节点：来自工具的原始输出或观察到的事实.

    证据节点封装了渗透测试工具执行后的原始输出和提取的发现。
    作为因果链中的基础事实，为假设推理和漏洞确认提供支持。

    Attributes:
        tool_name: 生成该证据的工具名称
        raw_output: 工具输出的原始内容
        extracted_findings: 从原始输出中提取的结构化发现
        host: 目标主机地址（可选）
        port: 目标端口号（可选）
    """

    tool_name: str
    raw_output: str
    extracted_findings: Dict[str, Any] = field(default_factory=dict)
    host: Optional[str] = None
    port: Optional[int] = None

    def __post_init__(self):
        super().__post_init__()
        self.node_type = "Evidence"


@dataclass
class HypothesisNode(BaseCausalNode):
    """
    假设节点：基于证据提出的推论或攻击猜想.

    假设节点表示基于当前证据提出的政击猜想或漏洞推理，
    包含置信度跟踪和验证状态管理。随着新证据的收集，
    假设的状态和置信度会动态调整。

    Attributes:
        description: 假设的详细描述
        confidence: 置信度（0.0-1.0），表示对该假设的信心程度
        status: 假设状态，SUPPORTED(支持)/FALSIFIED(证伪)/PENDING(待验证)/CONTRADICTED(矛盾)
        preconditions: 假设成立的前置条件列表
        potential_impact: 假设成立后的潜在影响（可选）
        verification_steps: 验证该假设的步骤列表
    """

    description: str
    confidence: float  # 置信度 (0.0 - 1.0)
    status: Literal["SUPPORTED", "FALSIFIED", "PENDING", "CONTRADICTED"] = "PENDING"  # 新增状态字段
    preconditions: List[str] = field(default_factory=list)
    potential_impact: Optional[str] = None
    verification_steps: List[str] = field(default_factory=list)

    def __post_init__(self):
        super().__post_init__()
        self.node_type = "Hypothesis"


@dataclass
class VulnerabilityNode(BaseCausalNode):
    """
    漏洞节点：已确认的安全漏洞.

    漏洞节点表示已经通过验证确认的安全漏洞，包含漏洞的
    详细信息、严重程度评分、利用条件和已知利用方法。

    Attributes:
        description: 漏洞的详细描述
        cvss_score: CVSS评分，表示漏洞严重程度（可选）
        exploitation_conditions: 利用该漏洞需要满足的条件列表
        known_exploits: 已知的利用方法或POC列表
    """

    description: str
    cvss_score: Optional[float] = None
    exploitation_conditions: List[str] = field(default_factory=list)
    known_exploits: List[str] = field(default_factory=list)

    def __post_init__(self):
        super().__post_init__()
        self.node_type = "Vulnerability"


@dataclass
class ExploitNode(BaseCausalNode):
    """
    利用节点：封装一个可直接执行的攻击向量.

    利用节点封装了针对特定漏洞的完整攻击向量，包括可执行的
    Payload、预期结果和利用类型。为自动化漏洞利用提供支持。

    Attributes:
        vulnerability_id: 关联的VulnerabilityNode的ID
        description: 利用方法的详细描述
        exploit_payload: 可直接使用的完整Payload
        expected_outcome: 预期的成功标志
        exploit_type: 漏洞利用类型，如 'rce', 'sqli', 'xss' 等
    """

    vulnerability_id: str  # 关联的VulnerabilityNode的ID
    description: str
    exploit_payload: str  # 核心：可直接使用的、完整的Payload
    expected_outcome: str  # 预期的成功标志
    # 漏洞利用的类型。如果适用，优先使用推荐列表中的标准类型:
    # 'data_extraction', 'auth_bypass', 'rce', 'dos', 'privilege_escalation',
    # 'xss', 'ssrf', 'file_inclusion', 'file_upload', 'insecure_deserialization', 'misconfiguration'
    # 如果无一适用，请使用一个简洁、精确、小写下划线格式的自定义类型 (例如 cbc_bit_flipping)。
    exploit_type: str

    def __post_init__(self):
        super().__post_init__()
        self.node_type = "Exploit"


CausalNode = Union[EvidenceNode, HypothesisNode, VulnerabilityNode, ExploitNode]


@dataclass
class CausalEdge:
    """
    因果链图谱的边.

    表示因果链图谱中两个节点之间的关系，如支持、矛盾、
    揭示、利用等。用于构建完整的攻击路径和推理链。

    Attributes:
        source_id: 源节点ID
        target_id: 目标节点ID
        label: 边标签，SUPPORTS/CONTRADICTS/REVEALS/EXPLOITS/MITIGATES
        description: 关系的详细描述（可选）
    """

    source_id: str
    target_id: str
    label: Literal["SUPPORTS", "CONTRADICTS", "REVEALS", "EXPLOITS", "MITIGATES"]
    description: Optional[str] = None


# ==================================================

# ==================================================


@dataclass
class IntelligenceSummary:
    """
    提供给 Planner 的情报摘要（由 Reflector 生成）.

    该类封装了Reflector向Planner报告的标准格式情报，包括已完成任务、
    已验证的节点、关键发现、被阻塞的任务和战略建议。

    Attributes:
        completed_tasks: 已完成任务的简要列表，包含 id, summary
        validated_nodes: 已验证的因果节点列表
        key_findings: 关键发现（自然语言，事实陈述）
        blocked_tasks: 被阻塞的任务及原因，包含 id, reason
        strategic_suggestions: 可选：战略层面的观察（非指令）

    Examples:
        >>> summary = IntelligenceSummary(
        ...     completed_tasks=[{"id": "task_001", "summary": "扫描完成"}],
        ...     validated_nodes=[evidence_node.to_dict()],
        ...     key_findings=["发现开放的SSH端口"]
        ... )
    """

    completed_tasks: List[Dict[str, Any]] = field(default_factory=list)
    """已完成任务的简要列表，包含 id, summary"""

    validated_nodes: List[Dict[str, Any]] = field(default_factory=list)
    """已验证的因果节点列表（取代旧的validated_artifacts）"""

    key_findings: List[str] = field(default_factory=list)
    """关键发现（自然语言，事实陈述）"""

    blocked_tasks: List[Dict[str, Any]] = field(default_factory=list)
    """被阻塞的任务及原因，包含 id, reason"""

    strategic_suggestions: Optional[str] = None
    """可选：战略层面的观察（非指令）"""

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典格式"""
        return {
            "completed_tasks": self.completed_tasks,
            "validated_nodes": self.validated_nodes,
            "key_findings": self.key_findings,
            "blocked_tasks": self.blocked_tasks,
            "strategic_suggestions": self.strategic_suggestions,
        }


@dataclass
class PlanningDecision:
    """
    Planner 的输出决策.

    封装了Planner的规划决策，包括图操作指令、全局任务简报和决策理由。
    图操作指令将被GraphManager执行，用于添加、更新或删除任务节点。

    Attributes:
        graph_operations: 图操作指令列表（ADD_NODE, UPDATE_NODE, DELETE_NODE等）
        global_mission_briefing: 更新后的全局任务简报
        reasoning: Planner 的决策理由（用于日志和调试）

    Examples:
        >>> decision = PlanningDecision(
        ...     graph_operations=[{"op": "ADD_NODE", "data": {...}}],
        ...     global_mission_briefing="目标：渗透测试[目标名称]",
        ...     reasoning="根据扫描结果，需要进一步漏洞利用"
        ... )
    """

    graph_operations: List[Dict[str, Any]]
    """图操作指令列表（ADD_NODE, UPDATE_NODE, DELETE_NODE等）"""

    global_mission_briefing: str
    """更新后的全局任务简报"""

    reasoning: str
    """Planner 的决策理由（用于日志和调试）"""

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典格式"""
        return {
            "graph_operations": self.graph_operations,
            "global_mission_briefing": self.global_mission_briefing,
            "reasoning": self.reasoning,
        }


# ==================================================


@dataclass
class DependencySummary:
    """
    依赖任务的摘要信息.

    封装了依赖任务的执行结果，包括任务描述、状态、关键发现、
    失败原因和产生的节点。为后续任务提供上下文信息。

    Attributes:
        task_id: 任务ID
        description: 任务描述
        status: 任务状态
        key_findings: 关键发现列表
        failure_reason: 失败原因（可选）
        nodes_produced: 产生的节点ID列表

    Examples:
        >>> dep = DependencySummary(
        ...     task_id="scan_001",
        ...     description="端口扫描",
        ...     status="completed",
        ...     key_findings=["发现开放端口80,443"],
        ...     nodes_produced=["evidence_001", "evidence_002"]
        ... )
    """

    task_id: str
    description: str
    status: str
    key_findings: List[str] = field(default_factory=list)
    failure_reason: Optional[str] = None
    nodes_produced: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典格式"""
        return {
            "task_id": self.task_id,
            "description": self.description,
            "status": self.status,
            "key_findings": self.key_findings,
            "failure_reason": self.failure_reason,
            "nodes_produced": self.nodes_produced,
        }


@dataclass
class TaskBriefing:
    """
    提供给 Executor 的任务简报（增强版）.

    封装了Executor需要的完整任务信息，包括当前任务目标、全局战略上下文、
    因果图情报、依赖任务结果和历史经验。确保Executor具备充足的上下文进行执行。

    Attributes:
        subtask_id: 子任务ID
        description: 任务描述
        completion_criteria: 完成标准
        mission_briefing: 任务简报字典
        global_mission_briefing: 来自Planner的全局简报
        causal_graph_summary: 全局因果链情报图谱的文本摘要
        dependencies_summary: 依赖任务的完整摘要（目标+结果+发现）
        dependencies_nodes: 依赖任务产生的因果节点列表
        relevant_experience: 可选：RAG检索的相关经验

    Examples:
        >>> briefing = TaskBriefing(
        ...     subtask_id="task_001",
        ...     description="执行nmap扫描",
        ...     completion_criteria="获取开放端口列表",
        ...     mission_briefing={},
        ...     global_mission_briefing="整体目标...",
        ...     causal_graph_summary="已发现..."
        ... )
    """

    # === 当前任务信息 ===
    subtask_id: str
    description: str
    completion_criteria: str
    mission_briefing: Dict[str, Any]

    # === 全局战略上下文 ===
    global_mission_briefing: str
    """来自 Planner 的全局简报"""

    # === 情报支持 ===
    causal_graph_summary: str
    """全局因果链情报图谱的文本摘要"""

    dependencies_summary: List[DependencySummary] = field(default_factory=list)
    """依赖任务的完整摘要（目标+结果+发现）"""

    dependencies_nodes: List[Dict[str, Any]] = field(default_factory=list)
    """依赖任务产生的因果节点列表（取代旧的dependencies_artifacts）"""

    # === 历史参考（可选）===
    relevant_experience: Optional[str] = None
    """可选：RAG 检索的相关经验"""

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典格式"""
        return {
            "subtask_id": self.subtask_id,
            "description": self.description,
            "completion_criteria": self.completion_criteria,
            "mission_briefing": self.mission_briefing,
            "global_mission_briefing": self.global_mission_briefing,
            "causal_graph_summary": self.causal_graph_summary,
            "dependencies_summary": [d.to_dict() for d in self.dependencies_summary],
            "dependencies_nodes": self.dependencies_nodes,
            "relevant_experience": self.relevant_experience,
        }


@dataclass
class ExecutionStep:
    """
    单个执行步骤的记录.

    封装了Executor执行过程中的单个步骤信息，包括思考过程、
    动作、观察结果和执行状态。用于构建完整的执行轨迹。

    Attributes:
        step_id: 步骤唯一标识符
        parent_id: 父节点ID（子任务或上一步骤）
        thought: LLM的思考过程
        action: 执行的动作，包含工具名称和参数
        observation: 动作执行后的观察结果（可选）
        status: 步骤状态，如 'pending', 'executed', 'failed'
    """

    step_id: str
    parent_id: str
    thought: str
    action: Dict[str, Any]
    observation: Optional[str] = None
    status: str = "pending"

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典格式"""
        return {
            "step_id": self.step_id,
            "parent_id": self.parent_id,
            "thought": self.thought,
            "action": self.action,
            "observation": self.observation,
            "status": self.status,
        }


@dataclass
class ExecutionLog:
    """
    Executor 的完整执行日志.

    记录整个子任务的完整执行过程，包括所有执行步骤、
    产生的因果节点和最终状态。用于反思和审计。

    Attributes:
        subtask_id: 子任务ID
        steps: 执行步骤列表，按时间顺序排列
        staged_causal_nodes: 待审计的产出物候选节点
        final_status: 最终状态，如 'completed_by_llm', 'stalled_no_plan' 等
    """

    subtask_id: str
    steps: List[ExecutionStep] = field(default_factory=list)
    """每个步骤的完整记录"""

    staged_causal_nodes: List[Node] = field(default_factory=list)
    """待审计的产出物候选"""

    final_status: str = "in_progress"
    """completed_by_llm / stalled_no_plan / completed_max_steps / etc."""

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典格式"""
        return {
            "subtask_id": self.subtask_id,
            "steps": [s.to_dict() for s in self.steps],
            "staged_causal_nodes": [n.to_dict() for n in self.staged_causal_nodes],
            "final_status": self.final_status,
        }


# ==================================================


@dataclass
class AuditResult:
    """
    审计结果.

    封装Reflector对子任务执行结果的审计结论，包括状态判定、
    完成情况检查、验证通过的节点和发现的问题。

    Attributes:
        status: 审计状态，pass(通过)/fail(失败)/incomplete(未完成)
        completion_check: 完成条件的检查结果，详细说明状态判定理由
        validated_nodes: 审计通过的因果节点列表
        methodology_issues: 发现的方法论问题列表
    """

    status: Literal["pass", "fail", "incomplete"]
    """审计状态：通过/失败/未完成"""

    completion_check: str
    """完成条件的检查结果（详细说明）"""

    validated_nodes: List[Dict[str, Any]] = field(default_factory=list)
    """审计通过的因果节点列表（取代旧的validated_artifacts）"""

    methodology_issues: List[str] = field(default_factory=list)
    """发现的方法论问题"""

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典格式"""
        return {
            "status": self.status,
            "completion_check": self.completion_check,
            "validated_nodes": self.validated_nodes,
            "methodology_issues": self.methodology_issues,
        }


@dataclass
class AuditReport:
    """
    Reflector 的审计报告.

    封装Reflector对子任务的完整审计报告，包括审计结果、
    情报摘要和经验洞见。为Planner提供决策支持。

    Attributes:
        subtask_id: 子任务ID
        audit_result: 审计结果对象
        key_findings: 关键发现列表，事实陈述
        failure_root_cause: 如果失败，失败的根本原因（可选）
        suggested_follow_up: 简短的后续建议，非详细规划（可选）
        experience_insight: 经验洞见，用于长期记忆（可选）
    """

    subtask_id: str

    audit_result: AuditResult
    """审计结果"""

    # === 情报摘要部分（供 Planner 使用）===
    key_findings: List[str] = field(default_factory=list)
    """关键发现（事实陈述）"""

    failure_root_cause: Optional[str] = None
    """如果失败，根本原因"""

    suggested_follow_up: Optional[str] = None
    """可选：简短的后续建议（不是详细规划）"""

    # === 经验提炼 ===
    experience_insight: Optional[Dict[str, Any]] = None
    """经验洞见（用于长期记忆）"""

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典格式"""
        return {
            "subtask_id": self.subtask_id,
            "audit_result": self.audit_result.to_dict(),
            "key_findings": self.key_findings,
            "failure_root_cause": self.failure_root_cause,
            "suggested_follow_up": self.suggested_follow_up,
            "experience_insight": self.experience_insight,
        }

    def to_intelligence_summary(self) -> IntelligenceSummary:
        """转换为情报摘要格式（供 Planner 使用）"""
        completed_tasks = []
        blocked_tasks = []

        if self.audit_result.status == "pass":
            completed_tasks.append(
                {"id": self.subtask_id, "summary": f"任务成功完成。关键发现：{'; '.join(self.key_findings[:2])}"}
            )
        elif self.audit_result.status == "fail":
            blocked_tasks.append({"id": self.subtask_id, "reason": self.failure_root_cause or "未知原因"})

        return IntelligenceSummary(
            completed_tasks=completed_tasks,
            validated_nodes=self.audit_result.validated_nodes,
            key_findings=self.key_findings,
            blocked_tasks=blocked_tasks,
            strategic_suggestions=self.suggested_follow_up,
        )


# ==================================================


@dataclass
class PlanningAttempt:
    """
    记录单个规划周期的完整信息，包括LLM推理过程.

    封装了一次规划尝试的完整信息，包括目标、策略、假设、生成的计划、
    结果和LLM推理过程。用于推理连续性和经验积累。

    Attributes:
        timestamp: 规划时间戳
        goal: 规划目标
        strategy: 规划策略
        assumptions: 假设列表
        generated_plan_summary: 生成的计划摘要
        outcome_summary: 结果摘要，由Reflector或Agent主循环更新
        llm_input_prompt: 发送给LLM的完整提示词（可选）
        llm_output_response: LLM的完整响应输出（可选）
        chain_of_thought: LLM的推理过程（可选）

    Examples:
        >>> attempt = PlanningAttempt(
        ...     timestamp=time.time(),
        ...     goal="扫描目标网站",
        ...     strategy="从端口扫描开始",
        ...     assumptions=["目标可访问"],
        ...     generated_plan_summary={"steps": [...]}
        ... )
    """

    timestamp: float
    goal: str
    strategy: str
    assumptions: List[str]
    generated_plan_summary: Dict[str, Any]
    outcome_summary: str = "pending"  # 由 Reflector 或 Agent 主循环更新

    # 新增：完整的LLM输入输出记录，用于推理连续性
    llm_input_prompt: Optional[str] = None  # 发送给LLM的完整提示词
    llm_output_response: Optional[str] = None  # LLM的完整响应输出
    chain_of_thought: Optional[str] = None  # LLM的推理过程（如果单独提取）


@dataclass
class PlannerContext:
    """
    为 Planner 维护一个长期记忆，包含完整的推理上下文.

    维持Planner的完整上下文，包括规划历史、被拒策略、长期目标、
    最新反思报告和LLM推理记录。支持推理连续性和上下文压缩。

    Attributes:
        session_start_time: 会话开始时间
        initial_goal: 初始目标
        target_url: 目标URL
        planning_history: 规划历史列表
        rejected_strategies: 被拒绝的策略映射，策略 -> 拒绝原因
        long_term_objectives: 长期目标列表
        latest_reflection_report: 最新的完整反思报告（可选）
        previous_planning_session: 上一次规划的完整会话记录（可选）
        compressed_history_summary: 被压缩后的历史摘要
        compression_count: 压缩次数计数器
        _needs_compression: 标记是否需要压缩

    Examples:
        >>> context = PlannerContext(
        ...     session_start_time=time.time(),
        ...     initial_goal="渗透测试",
        ...     target_url="http://example.com"
        ... )
        >>> context.add_planning_attempt(attempt)
        >>> context.reject_strategy("直接SQL注入", "目标有WAF")
    """

    session_start_time: float
    initial_goal: str
    target_url: str

    planning_history: List[PlanningAttempt] = field(default_factory=list)
    rejected_strategies: Dict[str, str] = field(default_factory=dict)  # 映射：策略 -> 拒绝原因
    long_term_objectives: List[str] = field(default_factory=list)

    # 新增：最新的完整反思报告，用于推理连续性
    latest_reflection_report: Optional[Dict[str, Any]] = None  # 上一次Reflector的完整输出
    previous_planning_session: Optional[Dict[str, Any]] = None  # 上一次规划的完整会话记录

    # 新增：上下文管理策略相关字段
    compressed_history_summary: str = ""  # 存储被压缩后的历史摘要
    compression_count: int = 0  # 压缩次数计数器
    _needs_compression: bool = False  # 标记是否需要压缩

    def add_planning_attempt(self, attempt: PlanningAttempt):
        """添加一个新的规划尝试，并维护滑动窗口。"""
        self.planning_history.append(attempt)

        # 检查是否需要进行压缩（滑动窗口机制）
        if len(self.planning_history) > PLANNER_HISTORY_WINDOW:  # 窗口大小：基于配置的动态保留策略
            # 标记需要压缩，实际压缩在agent主循环中异步触发
            self._needs_compression = True

    def get_recent_history(self, window_size: int = 10) -> List[PlanningAttempt]:
        """获取最近的规划历史（滑动窗口）。"""
        return self.planning_history[-window_size:]

    def reject_strategy(self, strategy: str, reason: str):
        """将一个策略标记为无效，以避免重用。"""
        if strategy not in self.rejected_strategies:
            self.rejected_strategies[strategy] = reason


@dataclass
class ReflectionInsight:
    """
    从单个反思周期中捕获的完整洞察.

    封装了一次反思周期产生的完整洞察，包括状态判定、
    关键洞见、失败模式和LLM推理过程。用于模式识别和经验积累。

    Attributes:
        timestamp: 反思时间戳
        subtask_id: 子任务ID
        normalized_status: 归一化状态，如 'True_Success', 'Soft_Fail'
        key_insight: 关键洞见摘要
        failure_pattern: 失败模式，如 'HTTP_403_ON_POST'（可选）
        full_reflection_report: 完整的反思报告（可选）
        llm_reflection_prompt: 发送给Reflector的完整提示词（可选）
        llm_reflection_response: Reflector的完整响应输出（可选）
    """

    timestamp: float
    subtask_id: str
    normalized_status: str  # 例如 "True_Success", "Soft_Fail", "Hard_Fail"
    key_insight: str
    failure_pattern: Optional[str] = None  # 例如 "HTTP_403_ON_POST"

    # 新增：完整的反思报告，用于推理连续性
    full_reflection_report: Optional[Dict[str, Any]] = None  # Reflector的完整JSON输出
    llm_reflection_prompt: Optional[str] = None  # 发送给Reflector的完整提示词
    llm_reflection_response: Optional[str] = None  # Reflector的完整响应输出


@dataclass
class ReflectorContext:
    """
    为 Reflector 维持一个长期记忆以识别模式.

    维持Reflector的完整上下文，包括反思日志、失败/成功模式、
    活跃假设和持久性洞见。支持模式识别和上下文压缩。

    Attributes:
        session_start_time: 会话开始时间
        reflection_log: 反思洞见列表
        failure_patterns: 失败模式映射，模式 -> 计数
        success_patterns: 成功模式映射，模式 -> 计数
        active_hypotheses: 活跃假设映射，假设ID -> 描述
        validated_patterns: 已验证的有效模式列表
        persistent_insights: 持久性洞见列表
        compressed_reflection_summary: 被压缩后的反思摘要
        compression_count: 压缩次数计数器
        _needs_compression: 标记是否需要压缩
    """

    session_start_time: float
    reflection_log: List[ReflectionInsight] = field(default_factory=list)
    failure_patterns: Dict[str, int] = field(default_factory=dict)  # 映射：模式 -> 计数
    success_patterns: Dict[str, int] = field(default_factory=dict)  # 映射：模式 -> 计数
    active_hypotheses: Dict[str, str] = field(default_factory=dict)  # 映射：假设ID -> 描述
    validated_patterns: List[Dict[str, Any]] = field(default_factory=list)  # 已验证的有效模式列表
    persistent_insights: List[Dict[str, Any]] = field(default_factory=list)  # 持久性洞察列表

    # 新增：上下文管理策略相关字段
    compressed_reflection_summary: str = ""  # 存储被压缩后的反思摘要
    compression_count: int = 0  # 压缩次数计数器
    _needs_compression: bool = False  # 标记是否需要压缩

    def add_insight(self, insight: ReflectionInsight):
        """添加一个新的反思洞察并更新模式计数器。"""
        self.reflection_log.append(insight)

        # 检查是否需要进行压缩（滑动窗口机制）
        if len(self.reflection_log) > REFLECTOR_HISTORY_WINDOW:  # 窗口大小：基于配置的动态保留策略
            # 标记需要压缩，实际压缩在agent主循环中异步触发
            self._needs_compression = True

        if insight.failure_pattern:
            self.failure_patterns[insight.failure_pattern] = self.failure_patterns.get(insight.failure_pattern, 0) + 1

    def get_recent_insights(self, window_size: int = 10) -> List[ReflectionInsight]:
        """获取最近的反思洞察（滑动窗口）。"""
        return self.reflection_log[-window_size:]