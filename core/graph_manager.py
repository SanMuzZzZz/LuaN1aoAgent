# core/graph_manager.py
import json
import logging
import time
import asyncio
import networkx as nx
from networkx.readwrite import json_graph
from rich.tree import Tree
from typing import Dict, List, Any, Optional
from dataclasses import is_dataclass, asdict

from core.events import broker
from core.console import console_proxy as console

try:
    # 使用数据契约中的新因果链结构
    from core.data_contracts import CausalNode, CausalEdge
except Exception:
    # 在缺失依赖或导入失败时保持兼容，不阻塞旧逻辑
    CausalNode = object  # type: ignore
    CausalEdge = object  # type: ignore


class GraphManagerError(Exception):
    """
    图谱管理器基础异常类.

    所有GraphManager相关异常的基类，用于统一异常处理。
    子类包括 NodeNotFoundError 等具体异常类型。

    Examples:
        >>> try:
        ...     graph_manager.get_node("invalid_id")
        ... except GraphManagerError as e:
        ...     print(f"图谱错误: {e}")
    """


class NodeNotFoundError(GraphManagerError):
    """
    当请求的节点不存在时投出此异常.

    在尝试访问或操作不存在的图谱节点时投出。

    Attributes:
        message: 异常信息，包含未找到的节点ID
    """


import uuid


class GraphManager:
    """
    管理和维护任务知识图谱.

    实现Plan-on-Graph (PoG)架构的核心图谱管理功能，维护任务图和因果链图谱。
    任务图为宏观的有向图结构，表示子任务间的依赖关系；因果链图谱为微观的
    推理图，连接Evidence、Hypothesis、Vulnerability、Exploit等节点。

    支持功能:
    - 任务图管理：添加/更新/删除子任务节点，维护依赖关系
    - 因果链管理：添加Evidence、Hypothesis、Vulnerability、Exploit节点及因果边
    - 图摘要生成：为Planner和Reflector生成可读的图状态摘要
    - 节点查询：根据ID、类型或属性查询节点

    Attributes:
        task_id: 根任务ID
        graph: NetworkX有向图，表示宏观任务图
        causal_graph: NetworkX有向图，表示微观因果链图谱

    Examples:
        >>> gm = GraphManager(task_id="task_001", goal="渗透测试目标网站")
        >>> evidence_id = gm.add_evidence_node(tool_name="nmap", raw_output="...")
        >>> hypothesis_id = gm.add_hypothesis_node(hypothesis="目标可能存在SQL注入")
        >>> gm.add_causal_edge(evidence_id, hypothesis_id, relation="supports")
    """

    def __init__(self, task_id: str, goal: str):
        self.task_id = task_id
        self.graph = nx.DiGraph()
        self.causal_graph = nx.DiGraph()
        self._execution_counter = 0
        self.op_id = None
        self.initialize_graph(goal)

    def set_op_id(self, op_id: str):
        """Set the operation ID for event emission."""
        self.op_id = op_id

    def initialize_graph(self, goal: str):
        """初始化图，添加代表整体任务的根节点."""
        self.graph.add_node(self.task_id, type="task", goal=goal, status="in_progress")

    def add_key_fact(self, fact: str) -> str:
        """
        将一个关键事实作为节点添加到因果链图谱中，类型为 'key_fact'。
        如果事实已存在，则返回其节点ID。
        """
        if not fact or not isinstance(fact, str):
            return ""

        fact_content = fact.strip()
        # 使用事实内容的哈希作为节点ID，确保唯一性
        fact_id = f"key_fact_{hash(fact_content)}"

        if not self.causal_graph.has_node(fact_id):
            self.causal_graph.add_node(fact_id, type="key_fact", description=fact_content, created_at=time.time())
            logging.debug(f"GraphManager: Added new key_fact to causal graph: {fact_content}")
        else:
            logging.debug(f"GraphManager: Key_fact already exists: {fact_content}")
        return fact_id

    def add_causal_node(self, artifact: Dict) -> str:
        """
        将一个产出物添加到 causal_graph 中，并返回其唯一节点ID。
        如果节点已存在，则只返回现有ID。
        """
        # 统一 node_type：兼容 legacy 'type'，优先使用 node_type
        legacy_type = artifact.get("type")
        if not artifact.get("node_type"):
            if legacy_type:
                mapping = {
                    "Evidence": "Evidence",
                    "Hypothesis": "Hypothesis",
                    "Vulnerability": "Vulnerability",
                    "PossibleVulnerability": "PossibleVulnerability",
                    "ConfirmedVulnerability": "ConfirmedVulnerability",
                    "Exploit": "Exploit",
                    "Credential": "Credential",
                    "SystemProperty": "SystemProperty",
                    "TargetArtifact": "TargetArtifact",
                    "key_fact": "KeyFact",
                }
                artifact["node_type"] = mapping.get(legacy_type, legacy_type)
            else:
                artifact["node_type"] = "Unknown"
        try:
            # 如果提供了稳定的 id（例如来自数据契约对象），优先使用
            if artifact.get("id"):
                node_id = artifact["id"]
            source_step = artifact.get("source_step_id", "")
            raw_output = artifact.get("raw_output", "")
            # 创建 a representative string to hash
            unique_content = f"{source_step}-{raw_output}"

            # The original implementation used hash(), which is not stable across processes/restarts.
            # A cryptographic hash is better for persistence.
            import hashlib

            hasher = hashlib.sha256()
            hasher.update(unique_content.encode("utf-8", errors="replace"))
            digest = hasher.hexdigest()[:16]  # Truncate for readability
            # 如果未显式提供 id，则构造一个可读的稳定 id
            node_id = artifact.get("id", f"art_{digest}__{artifact.get('node_type', 'unknown')}")
        except Exception:  # Broader catch in case of unexpected data
            # Fallback to UUID is still a good idea
            node_id = f"art_{uuid.uuid4().hex}"

        if not self.causal_graph.has_node(node_id):
            # 将产出物本身的数据作为节点属性存储
            artifact["created_at"] = time.time()  # Ensure created_at is always set

            # For ConfirmedVulnerability, set a very high, sticky confidence
            if artifact.get("node_type") == "ConfirmedVulnerability":
                artifact["confidence"] = artifact.get("confidence", 0.99)  # Default to very high
                artifact["status"] = artifact.get("status", "CONFIRMED")  # Default to confirmed

            self.causal_graph.add_node(node_id, **artifact)

        return node_id

    def add_causal_edge(self, source_artifact_id: str, target_artifact_id: str, label: str, **attrs):
        """
        在两个产出物节点之间添加一条带标签的边。
        """
        if source_artifact_id == target_artifact_id:
            logging.warning(f"Attempted to create a self-loop on causal node {source_artifact_id}. Edge not added.")
            return

        if self.causal_graph.has_node(source_artifact_id) and self.causal_graph.has_node(target_artifact_id):
            standardized_label = self._standardize_edge_label(label)
            self.causal_graph.add_edge(source_artifact_id, target_artifact_id, label=standardized_label, **attrs)
        else:
            logging.warning(
                f"Cannot create causal edge: node {source_artifact_id} or {target_artifact_id} not found in causal graph."
            )

    # === 新增：基于数据契约的对象接口 ===
    def add_causal_node_obj(self, node: "CausalNode") -> str:
        """
        接受数据契约定义的 CausalNode 对象（Evidence/Hypothesis/Vulnerability/Exploit），
        将其序列化并添加到因果图中。返回节点 ID。
        """
        try:
            if is_dataclass(node):
                payload = asdict(node)
            elif hasattr(node, "__dict__"):
                # 兼容非 dataclass 的 EvidenceNode 定义
                payload = dict(node.__dict__)
            else:
                raise TypeError("Unsupported causal node type; expected dataclass or object with __dict__")
        except Exception as e:
            logging.error(f"add_causal_node_obj: failed to serialize node: {e}")
            raise

        if payload.get("type") and not payload.get("node_type"):
            payload["node_type"] = payload["type"]
        
        # 移除 dataclass 自动生成的随机 ID，以便 add_causal_node 可以基于内容生成稳定 ID 进行去重
        # 如果确实需要强制指定 ID，应在调用前确保该 ID 是稳定的
        if "id" in payload:
            del payload["id"]
        
        return self.add_causal_node(payload)

    def add_causal_edge_obj(self, edge: "CausalEdge") -> None:
        """
        接受数据契约定义的 CausalEdge 对象，添加标准化标签的边。
        """
        if not hasattr(edge, "source_id") or not hasattr(edge, "target_id"):
            raise ValueError("CausalEdge object missing source_id/target_id")
        label = getattr(edge, "label", "")
        description = getattr(edge, "description", None)
        attrs = {"description": description} if description else {}
        self.add_causal_edge(edge.source_id, edge.target_id, label, **attrs)

    def _standardize_edge_label(self, label: str) -> str:
        """
        标准化边标签，以兼容旧实现与数据契约：
        允许的标签：SUPPORTS, CONTRADICTS, REVEALS, EXPLOITS, MITIGATES
        """
        if not label:
            return "SUPPORTS"
        norm = str(label).strip().upper()
        mapping = {
            # 支持
            "SUPPORT": "SUPPORTS",
            "SUPPORTS": "SUPPORTS",
            "CONFIRMS": "SUPPORTS",
            "DEFINITIVE_CONFIRMATION": "SUPPORTS",
            "WEAK_SUPPORT": "SUPPORTS",
            # 矛盾/证伪
            "CONTRADICT": "CONTRADICTS",
            "CONTRADICTS": "CONTRADICTS",
            "DISPROVES": "CONTRADICTS",
            "FALSIFIES": "CONTRADICTS",
            "MINOR_CONTRADICTION": "CONTRADICTS",
            # 揭示、利用、缓解
            "REVEAL": "REVEALS",
            "REVEALS": "REVEALS",
            "EXPLOIT": "EXPLOITS",
            "EXPLOITS": "EXPLOITS",
            "MITIGATE": "MITIGATES",
            "MITIGATES": "MITIGATES",
        }
        return mapping.get(norm, norm)

    def update_hypothesis_confidence(self, hypothesis_id: str, label: str):
        """
        根据新的证据更新假设节点的置信度。
        """
        label = self._standardize_edge_label(label)
        if not self.causal_graph.has_node(hypothesis_id):
            logging.warning(f"Confidence update skipped: Hypothesis node {hypothesis_id} not found.")
            return

        node_data = self.causal_graph.nodes[hypothesis_id]
        node_type = node_data.get("node_type")

        # ConfirmedVulnerability nodes are highly resistant to confidence reduction
        if node_type == "ConfirmedVulnerability":
            if label == "CONTRADICTS":
                logging.warning(
                    f"Attempted to contradict ConfirmedVulnerability {hypothesis_id}. Setting 're_evaluation_needed' flag."
                )
                self.causal_graph.nodes[hypothesis_id]["re_evaluation_needed"] = True
                # Confidence remains high, but a flag is set for Planner to re-evaluate
                self.causal_graph.nodes[hypothesis_id]["status"] = "RE_EVALUATION_PENDING"
            # ConfirmedVulnerability confidence is generally fixed high, not dynamically adjusted by this function
            return

        # Only Hypothesis nodes are dynamically adjusted by this function
        if node_type != "Hypothesis":
            return

        # 定义置信度调整权重
        WEIGHTS = {
            # 支持类统一到 SUPPORTS
            "SUPPORTS": 0.25,
            # 矛盾类统一到 CONTRADICTS
            "CONTRADICTS": -0.35,
            # 非标准但历史存在的标签保持轻微影响
            "FAILED_EXTRACTION_ATTEMPT": -0.05,
        }

        adjustment = WEIGHTS.get(label, 0.0)  # 默认为0，即不影响置信度

        confidence_val = node_data.get("confidence", 0.5)
        try:
            current_confidence = float(confidence_val)
        except (ValueError, TypeError):
            current_confidence = 0.5  # Default to 0.5 if conversion fails
        new_confidence = current_confidence + adjustment

        if label in ["SUPPORTS"]:
            self.causal_graph.nodes[hypothesis_id]["status"] = "SUPPORTED"
        elif label in ["CONTRADICTS", "FAILED_EXTRACTION_ATTEMPT"]:
            self.causal_graph.nodes[hypothesis_id]["status"] = (
                "CONTRADICTED"  # Or a more specific status like 'PARTIALLY_CONTRADICTED'
            )

        # 限制置信度在 [0.0, 1.0] 范围内
        new_confidence = max(0.0, min(1.0, new_confidence))

        self.causal_graph.nodes[hypothesis_id]["confidence"] = new_confidence
        node_status = self.causal_graph.nodes[hypothesis_id].get("status")
        
        message = f"Confidence for hypothesis '{hypothesis_id}' updated from {current_confidence:.2f} to {new_confidence:.2f} due to '{label}' edge (adjustment: {adjustment}). Status set to {node_status}."
        logging.debug(message)
        
        # Console output
        try:
            console.print(f"[bold yellow]Confidence Update:[/bold yellow] {message}")
        except Exception:
            pass

        # Event emission
        if self.op_id:
            try:
                # Use create_task to run async emit in sync context if loop is running
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(broker.emit("graph.changed", {
                        "reason": "confidence_update", 
                        "message": message,
                        "node_id": hypothesis_id,
                        "new_confidence": new_confidence
                    }, op_id=self.op_id))
                except RuntimeError:
                    # No running loop
                    pass
            except Exception:
                pass
        
        logging.debug(
            f"Updated confidence for hypothesis {hypothesis_id} from {current_confidence:.2f} to {new_confidence:.2f} based on '{label}' edge (adjustment: {adjustment}). Status set to {node_status}."
        )

    def analyze_attack_paths(self) -> List[Dict[str, Any]]:
        """
        分析因果链图谱中的潜在攻击路径。

        该方法识别从证据节点到漏洞节点的所有有效路径，用于发现潜在的攻击链。
        一条攻击路径被定义为从一个 Evidence 节点到一个 Vulnerability 节点的路径。

        Returns:
            攻击路径列表，每条路径包含节点序列和相关信息
        """
        attack_paths = []

        # 1. 识别所有源节点（Evidence）和目标节点（Vulnerability）
        evidence_nodes = [
            n for n, d in self.causal_graph.nodes(data=True) if (d.get("node_type") or d.get("type")) == "Evidence"
        ]
        vulnerability_nodes = [
            n
            for n, d in self.causal_graph.nodes(data=True)
            if (
                d.get("node_type") in {"Vulnerability", "PossibleVulnerability", "ConfirmedVulnerability"}
                or d.get("type") in {"Vulnerability", "PossibleVulnerability", "ConfirmedVulnerability"}
            )
        ]

        if not evidence_nodes or not vulnerability_nodes:
            return []

        # 2. 寻找所有从 Evidence 到 Vulnerability 的简单路径
        for source in evidence_nodes:
            for target in vulnerability_nodes:
                try:
                    paths = list(nx.all_simple_paths(self.causal_graph, source=source, target=target))
                    for path in paths:
                        path_score = 1.0
                        path_details = []

                        # 3. 为每条路径计算分数并收集详细信息
                        for node_id in path:
                            node_data = self.causal_graph.nodes[node_id]
                            path_details.append(
                                {
                                    "id": node_id,
                                    "type": node_data.get("node_type", node_data.get("type")),
                                    "description": node_data.get("description", ""),
                                }
                            )

                            # 分数计算：乘以路径上每个假设的置信度
                            if node_data.get("node_type") == "Hypothesis":
                                path_score *= node_data.get(
                                    "confidence", 0.1
                                )  # Use 0.1 for hypotheses without confidence

                        # 最终分数也考虑漏洞的CVSS评分
                        vuln_data = self.causal_graph.nodes[target]
                        cvss_score = vuln_data.get("cvss_score", 0.0)
                        final_score = path_score * (cvss_score / 10.0)  # Normalize CVSS to 0-1

                        attack_paths.append({"path": path_details, "score": final_score})
                except nx.NetworkXNoPath:
                    continue

        # 4. 按分数降序排序
        sorted_paths = sorted(attack_paths, key=lambda x: x["score"], reverse=True)

        return sorted_paths

    def _find_contradiction_clusters(self) -> List[Dict[str, Any]]:
        """
        查找矛盾簇：假设被多个证据矛盾或证据矛盾多个假设.
        """
        clusters = []
        for node_id, data in self.causal_graph.nodes(data=True):
            if data.get("node_type") == "Hypothesis":
                evidences = self._get_contradicting_evidences_for_hypothesis(node_id)
                if len(evidences) > 1:
                    clusters.append(
                        {
                            "hypothesis_id": node_id,
                            "hypothesis_description": data.get("description"),
                            "contradicting_evidence_count": len(evidences),
                            "contradicting_evidences": evidences,
                        }
                    )
            elif data.get("node_type") == "Evidence":
                hypotheses = self._get_contradicted_hypotheses_for_evidence(node_id)
                if len(hypotheses) > 1:
                    clusters.append(
                        {
                            "evidence_id": node_id,
                            "evidence_description": data.get("description"),
                            "contradicted_hypothesis_count": len(hypotheses),
                            "contradicted_hypotheses": hypotheses,
                        }
                    )
        return clusters

    def _get_contradicting_evidences_for_hypothesis(self, hypo_id: str) -> List[Dict[str, Any]]:
        """
        获取矛盾某个假设的所有证据.
        """
        evidences = []
        for predecessor in self.causal_graph.predecessors(hypo_id):
            edge_data = self.causal_graph.get_edge_data(predecessor, hypo_id)
            if edge_data and edge_data.get("label") == "CONTRADICTS":
                pred_data = self.causal_graph.nodes[predecessor]
                if pred_data.get("node_type") == "Evidence":
                    evidences.append({"id": predecessor, "description": pred_data.get("description")})
        return evidences

    def _get_contradicted_hypotheses_for_evidence(self, evidence_id: str) -> List[Dict[str, Any]]:
        """
        获取某个证据矛盾的所有假设.
        """
        hypotheses = []
        for successor in self.causal_graph.successors(evidence_id):
            edge_data = self.causal_graph.get_edge_data(evidence_id, successor)
            if edge_data and edge_data.get("label") == "CONTRADICTS":
                succ_data = self.causal_graph.nodes[successor]
                if succ_data.get("node_type") == "Hypothesis":
                    hypotheses.append({"id": successor, "description": succ_data.get("description")})
        return hypotheses

    def _find_stalled_hypotheses(self, time_window_seconds: int = 3600) -> List[Dict[str, Any]]:
        """
        查找停滞的假设：被证伪或长时间未更新.
        """
        stalled = []
        now = time.time()
        hypothesis_nodes = {n: d for n, d in self.causal_graph.nodes(data=True) if d.get("node_type") == "Hypothesis"}

        for hypo_id, hypo_data in hypothesis_nodes.items():
            created_at = hypo_data.get("created_at", now)
            status = hypo_data.get("status", "PENDING")

            # 检查被证伪的假设
            if status == "FALSIFIED" and not self._has_supporting_evidence(hypo_id):
                stalled.append(
                    {
                        "id": hypo_id,
                        "description": hypo_data.get("description"),
                        "confidence": hypo_data.get("confidence"),
                        "status": status,
                        "reason": "FALSIFIED and no new supporting evidence.",
                        "age_seconds": now - created_at,
                    }
                )
                continue

            # 检查长时间未更新的假设
            if (now - created_at) > time_window_seconds and status in ["PENDING", "SUPPORTED"]:
                if not self._has_recent_activity(hypo_id, created_at):
                    stalled.append(
                        {
                            "id": hypo_id,
                            "description": hypo_data.get("description"),
                            "confidence": hypo_data.get("confidence"),
                            "status": status,
                            "reason": "No recent activity and older than time window.",
                            "age_seconds": now - created_at,
                        }
                    )
        return stalled

    def _has_supporting_evidence(self, hypo_id: str) -> bool:
        """
        检查假设是否有支持证据.
        """
        for successor in self.causal_graph.successors(hypo_id):
            edge_data = self.causal_graph.get_edge_data(hypo_id, successor)
            if edge_data and edge_data.get("label") == "SUPPORTS":
                return True
        return False

    def _has_recent_activity(self, node_id: str, created_at: float) -> bool:
        """
        检查节点是否有近期活动.
        """
        for neighbor in nx.all_neighbors(self.causal_graph, node_id):
            neighbor_data = self.causal_graph.nodes[neighbor]
            if neighbor_data.get("created_at", 0) > created_at:
                return True
        return False

    def analyze_failure_patterns(self, time_window_seconds: int = 3600) -> Dict[str, Any]:
        """
        分析因果链图谱中的失败模式。

        该方法识别和分析各种失败模式，包括矛盾簇、停滞假设等，
        帮助理解攻击过程中的问题和障碍。

        Args:
            time_window_seconds: 时间窗口（秒），用于过滤近期的失败模式

        Returns:
            失败模式字典，包含矛盾簇和停滞假设等信息
        """
        return {
            "contradiction_clusters": self._find_contradiction_clusters(),
            "stalled_hypotheses": self._find_stalled_hypotheses(time_window_seconds),
        }

    def get_failed_nodes(self) -> Dict[str, Any]:
        """
        获取所有状态为失败、停滞或错误的子任务节点。
        """
        failed_nodes = {}
        for node_id, data in self.graph.nodes(data=True):
            if data.get("type") == "subtask" and data.get("status") in ["failed", "stalled_orphan", "completed_error"]:
                failed_nodes[node_id] = data
        return failed_nodes

    def get_relevant_causal_context(
        self, subtask_id: str, top_n_hypotheses: int = 5, top_n_paths: int = 3
    ) -> Dict[str, Any]:
        """
        获取与当前子任务相关的因果图上下文信息。

        该方法为执行器或规划器提供相关的因果图上下文，包括：
        - 高置信度假设
        - 关键事实
        - 已确认漏洞
        - 热门攻击路径
        - 失败模式分析

        Args:
            subtask_id: 子任务ID
            top_n_hypotheses: 返回的高置信度假设数量（默认5）
            top_n_paths: 返回的热门攻击路径数量（默认3）

        Returns:
            因果图上下文字典，包含相关假设、事实、漏洞、攻击路径和失败模式
        """
        context = {
            "related_hypotheses": [],
            "key_facts": [],
            "confirmed_vulnerabilities": [],  # New
            "top_attack_paths": [],
            "failure_patterns": {},  # New
        }

        # 1. 提取高置信度假设
        for node_id, data in self.causal_graph.nodes(data=True):
            if data.get("node_type") == "Hypothesis":
                confidence_val = data.get("confidence", 0)
                try:
                    confidence_float = float(confidence_val)
                except (ValueError, TypeError):
                    confidence_float = 0.0  # Default to 0.0 if conversion fails

                if confidence_float > 0.7:
                    context["related_hypotheses"].append(
                        {
                            "id": node_id,
                            "description": data.get("description"),
                            "confidence": confidence_float,  # Use the converted float
                            "status": data.get("status"),
                        }
                    )
        context["related_hypotheses"] = sorted(
            context["related_hypotheses"], key=lambda x: x["confidence"], reverse=True
        )[:top_n_hypotheses]

        # 2. 提取关键事实 (兼容旧 'key_fact' 与新 'KeyFact')
        for node_id, data in self.causal_graph.nodes(data=True):
            nt = data.get("node_type", data.get("type"))
            if nt in {"key_fact", "KeyFact"}:
                context["key_facts"].append({"id": node_id, "description": data.get("description")})

        # 3. 提取已确认漏洞（兼容 ConfirmedVulnerability 与 Vulnerability）
        for node_id, data in self.causal_graph.nodes(data=True):
            nt = data.get("node_type", data.get("type"))
            if nt in {"ConfirmedVulnerability", "Vulnerability"}:
                context["confirmed_vulnerabilities"].append(
                    {"id": node_id, "description": data.get("description"), "cvss_score": data.get("cvss_score")}
                )

        # 4. 提取热门攻击路径
        attack_paths = self.analyze_attack_paths()
        for path_info in attack_paths[:top_n_paths]:
            path_str = " -> ".join([f"{p['type']}({p['description'][:30]}...)" for p in path_info["path"]])
            context["top_attack_paths"].append({"path_description": path_str, "score": path_info["score"]})

        # 5. 提取失败模式
        context["failure_patterns"] = self.analyze_failure_patterns()

        return context

    def add_subtask_node(
        self,
        subtask_id: str,
        description: str,
        dependencies: List[str],
        priority: int = 1,
        reason: str = "",
        completion_criteria: str = "",
        mission_briefing: Optional[Dict] = None,
    ):
        """
        添加一个子任务节点到宏观图中。

        该方法在宏观图中创建子任务节点，并建立与任务根节点和依赖节点的边关系。

        Args:
            subtask_id: 子任务唯一标识符
            description: 子任务描述
            dependencies: 依赖的子任务ID列表
            priority: 子任务优先级（默认1）
            reason: 子任务创建原因
            completion_criteria: 完成标准
            mission_briefing: 任务简报信息（可选）

        Returns:
            None
        """
        if self.graph.has_node(subtask_id):
            logging.warning("GraphManager.add_subtask_node: node %s already exists, skip.", subtask_id)
            return

        self.graph.add_node(
            subtask_id,
            **self._build_subtask_payload(description, priority, reason, completion_criteria, mission_briefing),
        )
        self._ensure_node_defaults(subtask_id)

        # Only connect to root task if there are no other dependencies
        # This prevents flattening the graph structure when dependencies exist
        if not dependencies:
            self.graph.add_edge(self.task_id, subtask_id, type="decomposition")

        for dep_id in dependencies:
            if self.graph.has_node(dep_id):
                self.graph.add_edge(dep_id, subtask_id, type="dependency")

    def add_execution_step(
        self,
        step_id: str,
        parent_id: str,
        thought: str,
        action: Dict,
        status: str = "pending",
        hypothesis_update: Optional[Dict] = None,
    ):
        """
        添加一个执行步骤节点（微观图），形成树状结构。
        status: 'pending' (备选), 'ready_to_execute', 'executed', 'failed'
        """
        if not self.graph.has_node(parent_id):
            raise NodeNotFoundError(f"父节点 {parent_id} 不存在于图中。")

        self._execution_counter += 1

        self.graph.add_node(
            step_id, **self._build_execution_payload(parent_id, thought, action, status, hypothesis_update)
        )
        self._ensure_node_defaults(step_id)
        self._invalidate_execution_cache(parent_id)

        self.graph.add_edge(parent_id, step_id, type="execution")
        return step_id

    def update_node(self, node_id: str, updates: Dict[str, Any]):
        """通用节点更新方法。"""
        if self.graph.has_node(node_id):
            for key, value in updates.items():
                self.graph.nodes[node_id][key] = value
            self._ensure_node_defaults(node_id)
            node_type = self.graph.nodes[node_id].get("type")
            if node_type == "execution_step":
                parent_id = self.graph.nodes[node_id].get("parent")
                if parent_id:
                    self._invalidate_execution_cache(parent_id)
        else:
            # 在动态规划中，节点可能已被删除，因此只打印警告
            logging.warning("GraphManager.update_node: node %s not found.", node_id)

    def delete_node(self, node_id: str):
        """从图中删除一个节点。"""
        if self.graph.has_node(node_id):
            node_data = dict(self.graph.nodes[node_id])
            self.graph.remove_node(node_id)
            logging.info("GraphManager.delete_node: removed node %s.", node_id)
            if node_data.get("type") == "execution_step":
                parent_id = node_data.get("parent")
                if parent_id:
                    self._invalidate_execution_cache(parent_id)
        else:
            logging.warning("GraphManager.delete_node: node %s not found.", node_id)

    def stage_proposed_changes(self, subtask_id: str, proposed_ops: List[Dict]):
        """暂存来自Executor的宏观计划修改建议。"""
        if self.graph.has_node(subtask_id):
            self._ensure_node_defaults(subtask_id)
            self.graph.nodes[subtask_id]["proposed_changes"].extend(proposed_ops)
        else:
            raise ValueError(f"子任务 {subtask_id} 不存在于图中。")

    def stage_proposed_causal_nodes(self, subtask_id: str, proposed_nodes: List[Dict]):
        """暂存来自 Executor 的因果链节点提议。

        这些节点会被添加到主图中并标记为 'is_staged_causal'，
        以便在因果图可视化中显示，直到 Reflector 审核确认。
        """
        if not self.graph.has_node(subtask_id):
            raise ValueError(f"子任务 {subtask_id} 不存在于图中。")

        self._ensure_node_defaults(subtask_id)

        # 将暂存节点添加到子任务的 staged_causal_nodes 列表
        self.graph.nodes[subtask_id]["staged_causal_nodes"].extend(proposed_nodes)

        # 同时将每个暂存节点添加到主图中，以便 Web 可视化显示
        for node_data in proposed_nodes:
            node_id = node_data.get("id")
            if not node_id:
                continue

            # 如果节点已经存在（在因果图或主图中），则跳过
            if self.causal_graph.has_node(node_id) or self.graph.has_node(node_id):
                continue

            # 添加到主图中，标记为暂存因果节点
            self.graph.add_node(
                node_id,
                type="staged_causal",  # 节点类型
                node_type=node_data.get("node_type"),  # 因果节点类型（Evidence, Hypothesis, etc.）
                is_staged_causal=True,  # 标记为暂存节点
                source_step_id=node_data.get("source_step_id"),
                description=node_data.get("description"),
                title=node_data.get("title"),
                hypothesis=node_data.get("hypothesis"),
                evidence=node_data.get("evidence"),
                vulnerability=node_data.get("vulnerability"),
                confidence=node_data.get("confidence"),
                status=node_data.get("status"),
                raw_output=node_data.get("raw_output"),
                extracted_findings=node_data.get("extracted_findings"),
                data=node_data.get("data", {}),
            )

            # 如果有 source_step_id，创建与执行步骤的边
            source_step_id = node_data.get("source_step_id")
            if source_step_id and self.graph.has_node(source_step_id):
                self.graph.add_edge(source_step_id, node_id, type="produces", label="生成")

    def clear_staged_causal_nodes(self, subtask_id: str):
        """清理子任务的暂存因果节点。

        当子任务完成或失败时调用，删除主图中所有标记为 'is_staged_causal' 的节点，
        并清空子任务的 staged_causal_nodes 列表。
        这确保了因果图谱的整洁性和准确性。

        Args:
            subtask_id: 子任务ID
        """
        if not self.graph.has_node(subtask_id):
            logging.warning(f"GraphManager.clear_staged_causal_nodes: 子任务 {subtask_id} 不存在")
            return

        # 1. 获取所有暂存节点的 ID
        staged_node_ids = [nid for nid, data in self.graph.nodes(data=True) if data.get("is_staged_causal") is True]

        # 2. 从主图中删除这些节点
        removed_count = 0
        for node_id in staged_node_ids:
            try:
                self.graph.remove_node(node_id)
                removed_count += 1
                logging.debug(f"已删除暂存节点: {node_id}")
            except Exception as e:
                logging.warning(f"删除暂存节点 {node_id} 失败: {e}")

        # 3. 清空子任务的 staged_causal_nodes 列表
        if "staged_causal_nodes" in self.graph.nodes[subtask_id]:
            self.graph.nodes[subtask_id]["staged_causal_nodes"] = []

        if removed_count > 0:
            logging.debug(f"子任务 {subtask_id} 共清理了 {removed_count} 个暂存因果节点")

    def get_subtask_execution_log(self, subtask_id: str) -> str:
        """获取子任务的完整执行日志（树状结构），用于反思。"""
        if not self.graph.has_node(subtask_id):
            return "错误：未找到指定的子任务。"

        summary = self._get_execution_summary(subtask_id)
        return summary if summary else "该子任务没有执行步骤。"

    def get_full_graph_summary(self, detail_level: int = 1) -> str:
        """
        返回完整PoG图结构摘要，供上下文注入。
        """
        summary_lines = [f"## 任务图谱: {self.task_id}"]

        subtask_nodes = [n for n, d in self.graph.nodes(data=True) if d.get("type") == "subtask"]

        for subtask_id in subtask_nodes:
            subtask_data = self.graph.nodes[subtask_id]
            status = subtask_data.get('status')
            priority = subtask_data.get('priority')
            desc = subtask_data.get('description')
            
            summary_lines.append(f"\\n- [子任务] {subtask_id}: {desc} (状态: {status}, 优先级: {priority})")

            dependencies = [
                u for u, v in self.graph.in_edges(subtask_id) 
                if self.graph.edges[u, v].get("type") == "dependency"
            ]
            if dependencies:
                summary_lines.append(f"  - 依赖: {', '.join(dependencies)}")

            if reflection := subtask_data.get("reflection"):
                summary_lines.append(f"  - [反思]: {reflection.get('总结', '')}")

            if detail_level >= 2:
                step_nodes = [
                    n for n in nx.dfs_preorder_nodes(self.graph, source=subtask_id)
                    if self.graph.nodes[n].get("type") == "execution_step"
                ]
                
                base_depth = len(nx.ancestors(self.graph, subtask_id))
                for step_id in step_nodes:
                    step_data = self.graph.nodes[step_id]
                    depth = len(nx.ancestors(self.graph, step_id)) - base_depth
                    indent = "    " * depth
                    tool = step_data.get('action', {}).get('tool', 'N/A')
                    summary_lines.append(
                        f"{indent}- [步骤] {step_id} (状态: {step_data.get('status')}) -> {tool}"
                    )

        return "\\n".join(summary_lines)

    def get_causal_graph_summary(self) -> str:
        """返回因果链图谱的文本摘要。"""
        if not self.causal_graph:
            return "因果链图谱为空。"

        summary_lines = ["## 因果链图谱摘要 (Causal Graph)", "\\n## 节点概览"]
        
        for node_id, data in self.causal_graph.nodes(data=True):
            node_type = data.get("node_type", data.get("type", "N/A"))
            desc = data.get("description", "")[:80]
            
            if node_type == "Evidence":
                tool = data.get("tool_name", "N/A")
                step = data.get("source_step_id", "N/A")
                findings = str(data.get("extracted_findings", {}))[:50]
                summary_lines.append(f"- [Evidence] {node_id} · tool={tool} · step={step} · desc={desc} · findings={findings}")
                
            elif node_type == "Hypothesis":
                conf = data.get("confidence", "N/A")
                status = data.get("status", "PENDING")
                summary_lines.append(f"- [Hypothesis] {node_id} · {desc} · conf={conf} · status={status}")
                
            elif node_type in {"Vulnerability", "ConfirmedVulnerability", "PossibleVulnerability"}:
                cvss = data.get("cvss_score", "N/A")
                status = data.get("status")
                summary_lines.append(f"- [Vuln:{node_type}] {node_id} · {desc} · CVSS={cvss} · status={status}")
                
            elif node_type == "Exploit":
                etype = data.get("exploit_type", "")
                payload = data.get("exploit_payload", "")[:50]
                expected = data.get("expected_outcome", "")[:40]
                summary_lines.append(f"- [Exploit] {node_id} · type={etype} · payload={payload} · expected={expected}")
                
            else:
                summary_lines.append(f"- [{node_type}] {node_id} · {str(data)[:80]}...")

        summary_lines.append("\\n## 推理关系")
        edges = [
            f"- ({u}) --[{self._standardize_edge_label(d.get('label', ''))}]--> ({v})"
            for u, v, d in self.causal_graph.edges(data=True)
        ]
        summary_lines.extend(edges)

        return "\\n".join(summary_lines)

    def get_attack_path_summary(self, top_n: int = 3) -> str:
        """获取顶部攻击路径的摘要。"""
        attack_paths = self.analyze_attack_paths()
        if not attack_paths:
            return "未发现潜在的攻击路径。"

        summary_lines = ["## 潜在攻击路径分析"]
        for i, path_info in enumerate(attack_paths[:top_n]):
            path_str = " -> ".join([f"{p['type']}({p['description'][:30]}...)" for p in path_info["path"]])
            summary_lines.append(f"### 路径 {i + 1} (分数: {path_info['score']:.2f})")
            summary_lines.append(path_str)

        return "\n".join(summary_lines)

    def get_guidance_for_subtask(self, subtask_id: str) -> str:
        """
        获取子任务的实时指导信息，包括反思、关键产出物和依赖状态，用于注入到 ReAct 循环。
        """
        if not self.graph.has_node(subtask_id):
            return "无指导信息。"

        guidance = []

        # 添加来自依赖任务的反思和关键产出物
        dependencies = [
            u for u, v in self.graph.in_edges(subtask_id) if self.graph.edges[u, v].get("type") == "dependency"
        ]
        for dep in dependencies:
            dep_data = self.graph.nodes[dep]
            dep_summary = dep_data.get("summary")  # 从 'updates' 中获取
            if dep_summary:
                guidance.append(f"### 来自依赖任务 '{dep}' 的反思摘要:\\n{dep_summary}")

            dep_artifacts = dep_data.get("artifacts")  # 从 'updates' 中获取
            if dep_artifacts:
                try:
                    artifacts_str = json.dumps(dep_artifacts, indent=2, ensure_ascii=False)
                    guidance.append(f"### 来自依赖任务 '{dep}' 的关键产出物:\\n```json\\n{artifacts_str}\\n```")
                except (TypeError, ValueError):
                    guidance.append(f"### 来自依赖任务 '{dep}' 的关键产出物 (格式错误):\\n{dep_artifacts}")

        # 添加当前子任务的执行摘要
        execution_summary = self._get_execution_summary(subtask_id)
        if execution_summary:
            guidance.append(f"### 当前执行摘要:\\n{execution_summary}")

        return "\\n\\n".join(guidance) if guidance else "无额外指导。"

    def print_graph_structure(self, console, highlight_nodes: Optional[List[str]] = None):
        """控制台输出PoG图的易读结构。"""

        if not console:
            raise ValueError("console 实例不能为空")

        highlight_nodes = highlight_nodes or [] # Ensure it's a list

        root_goal = self.graph.nodes[self.task_id].get("goal", "") if self.graph.has_node(self.task_id) else ""
        tree = Tree(f"[bold cyan]{self.task_id}[/] : {root_goal}", guide_style="cyan")

        subtasks = [(n, data) for n, data in self.graph.nodes(data=True) if data.get("type") == "subtask"]
        subtasks.sort(key=lambda item: item[1].get("priority", 0))

        for subtask_id, data in subtasks:
            status = data.get("status", "pending")
            priority = data.get("priority", 1)
            description = data.get("description", "")
            reason = data.get("reason", "")
            completion_criteria = data.get("completion_criteria", "")
            
            node_label_style = "bold"
            if subtask_id in highlight_nodes:
                node_label_style += " yellow reverse" # Highlight style
            
            node_label = f"[{node_label_style}]{subtask_id}[/] · 状态={status} · 优先级={priority}"
            sub_tree = tree.add(node_label, guide_style="green")
            sub_tree.add(f"描述: {description}")
            if reason:
                sub_tree.add(f"理由: {reason}")
            if completion_criteria:
                sub_tree.add(f"完成条件: {completion_criteria}")

            deps = [u for u, v in self.graph.in_edges(subtask_id) if self.graph.edges[u, v].get("type") == "dependency"]
            if deps:
                dep_branch = sub_tree.add("依赖:")
                for dep in deps:
                    dep_data = self.graph.nodes[dep]
                    dep_branch.add(
                        f"{dep} (状态={dep_data.get('status', 'unknown')}, 优先级={dep_data.get('priority', '?')})"
                    )

            reflection = data.get("reflection")
            if reflection:
                sub_tree.add(f"反思: {reflection}")

        console.print(tree)

    def _get_node_type(self, data: Dict[str, Any]) -> str:
        """获取节点类型。"""
        return data.get("node_type", data.get("type"))

    def _group_causal_nodes_by_type(self) -> Dict[str, list]:
        """
        按类型对因果图节点进行分组。

        Returns:
            包含各类型节点列表的字典
        """
        nodes = self.causal_graph.nodes(data=True)
        return {
            "evidence": [(n, d) for n, d in nodes if self._get_node_type(d) == "Evidence"],
            "hypothesis": [(n, d) for n, d in nodes if self._get_node_type(d) == "Hypothesis"],
            "vulnerability": [
                (n, d) for n, d in nodes if self._get_node_type(d) in ["PossibleVulnerability", "Vulnerability"]
            ],
            "confirmed_vuln": [(n, d) for n, d in nodes if self._get_node_type(d) == "ConfirmedVulnerability"],
            "credential": [(n, d) for n, d in nodes if self._get_node_type(d) == "Credential"],
            "system_property": [(n, d) for n, d in nodes if self._get_node_type(d) == "SystemProperty"],
            "target_artifact": [(n, d) for n, d in nodes if self._get_node_type(d) == "TargetArtifact"],
            "unknown": [
                (n, d)
                for n, d in nodes
                if self._get_node_type(d) is None
                or self._get_node_type(d)
                not in {
                    "Evidence",
                    "Hypothesis",
                    "PossibleVulnerability",
                    "Vulnerability",
                    "ConfirmedVulnerability",
                    "Credential",
                    "SystemProperty",
                    "TargetArtifact",
                }
            ],
        }

    def _get_node_style(self, node_type: str, node_status: str, node_confidence: Any) -> str:
        """
        根据节点类型和状态获取显示样式。

        Returns:
            Rich样式字符串
        """
        style = ""
        if node_type == "Hypothesis":
            if node_status == "SUPPORTED":
                style = "bold green"
            elif node_status == "CONTRADICTED":
                style = "bold red"
            elif node_status == "FALSIFIED":
                style = "bold yellow"
            elif node_status == "PENDING":
                style = "bold blue"

            if isinstance(node_confidence, (int, float)) and node_confidence < 0.5:
                style += " dim"
        elif node_type == "ConfirmedVulnerability":
            style = "bold magenta reverse"

        return style

    def _format_confidence(self, val: Any) -> str:
        """安全格式化置信度值。"""
        try:
            return f"{float(val):.2f}"
        except (TypeError, ValueError):
            return str(val) if val is not None else "N/A"

    def _add_credential_details(self, node_branch, data: Dict[str, Any]) -> None:
        """添加凭据节点详细信息。"""
        cred_data = data.get("data", {})
        node_branch.add(f"用户名: {cred_data.get('username', 'N/A')}")
        node_branch.add(f"密码: {cred_data.get('password', 'N/A')}")
        node_branch.add(f"来源: {cred_data.get('source', 'N/A')}")
        if not cred_data:
            node_branch.add(f"用户名: {data.get('username', 'N/A')}")
            node_branch.add(f"密码: {data.get('password', 'N/A')}")
            node_branch.add(f"来源: {data.get('source', 'N/A')}")

    def _add_system_property_details(self, node_branch, data: Dict[str, Any]) -> None:
        """添加系统属性节点详细信息。"""
        prop_data = data.get("data", {})
        node_branch.add(f"属性: {prop_data.get('property', 'N/A')}")
        node_branch.add(f"值: {prop_data.get('value', 'N/A')}")
        node_branch.add(f"来源: {prop_data.get('source', 'N/A')}")
        if not prop_data:
            node_branch.add(f"属性: {data.get('property', 'N/A')}")
            node_branch.add(f"值: {data.get('value', 'N/A')}")
            node_branch.add(f"来源: {data.get('source', 'N/A')}")

    def _add_target_artifact_details(self, node_branch, data: Dict[str, Any]) -> None:
        """添加目标产物节点详细信息。"""
        artifact_data = data.get("data", {})
        node_branch.add(f"产物: {artifact_data.get('value', 'N/A')}")
        node_branch.add(f"来源: {artifact_data.get('source', 'N/A')}")
        if not artifact_data:
            node_branch.add(f"产物: {data.get('value', 'N/A')}")
            node_branch.add(f"来源: {data.get('source', 'N/A')}")

    def _add_node_details(self, node_branch, node_type: str, data: Dict[str, Any]) -> None:
        """
        根据节点类型添加详细信息到树分支。

        Args:
            node_branch: Rich Tree分支
            node_type: 节点类型
            data: 节点数据
        """
        if node_type == "Evidence":
            node_branch.add(f"来源: {data.get('source_step_id', data.get('source', 'N/A'))}")
            findings = data.get("extracted_findings")
            if findings and isinstance(findings, dict):
                for key, value in findings.items():
                    node_branch.add(f"{key}: {str(value)}")
            else:
                evidence_data = data.get("data", {})
                if not evidence_data and "finding" in data:
                    evidence_data = data
                node_branch.add(f"发现: {evidence_data.get('finding', data.get('description', 'N/A'))}")

        elif node_type == "Hypothesis":
            node_branch.add(f"描述: {data.get('description', 'N/A')}")
            if "hypothesis" in data:
                node_branch.add(f"假设: {data.get('hypothesis', 'N/A')}")

        elif node_type == "Vulnerability":
            node_branch.add(f"描述: {data.get('description', 'N/A')}")
            node_branch.add(f"CVSS分数: {data.get('cvss_score', 'N/A')}")

        elif node_type == "Credential":
            self._add_credential_details(node_branch, data)

        elif node_type == "SystemProperty":
            self._add_system_property_details(node_branch, data)

        elif node_type == "TargetArtifact":
            self._add_target_artifact_details(node_branch, data)

        else:
            for key, value in data.items():
                if key not in ["node_type", "status", "confidence"]:
                    node_branch.add(f"{key}: {str(value)[:100]}...")

    def print_causal_graph(self, console, max_nodes: int = 50) -> None:
        """
        控制台输出因果链图谱 (Causal Graph) 的易读结构。

        Args:
            console: Rich Console 实例。
            max_nodes: 最大显示节点数，防止输出过长。
        """
        if not console:
            raise ValueError("console 实例不能为空")

        if not self.causal_graph or self.causal_graph.number_of_nodes() == 0:
            console.print("因果链图谱为空。", style="dim")
            return

        # 创建因果链图谱的根节点
        tree = Tree("[bold magenta]因果链图谱 (Causal Graph)[/]", guide_style="magenta")

        # 按类型分组节点
        grouped_nodes = self._group_causal_nodes_by_type()
        total_nodes = sum(len(nodes) for nodes in grouped_nodes.values())

        # 处理节点数量超限
        if total_nodes > max_nodes:
            console.print(
                f"[yellow]⚠️ 因果链图谱节点数 ({total_nodes}) 超过最大显示限制 ({max_nodes})，仅显示前 {max_nodes} 个节点。[/yellow]"
            )
            all_nodes_sorted = sorted(self.causal_graph.nodes(data=True), key=lambda item: item[0])
            displayed_nodes = dict(all_nodes_sorted[:max_nodes])
            temp_graph = self.causal_graph.subgraph(displayed_nodes.keys())
        else:
            temp_graph = self.causal_graph

        # 显示节点
        nodes_tree = tree.add("[bold blue] Nodes [/]")
        for node_id, data in temp_graph.nodes(data=True):
            node_type = data.get("node_type", data.get("type", "Unknown"))
            node_status = data.get("status", "N/A")
            node_confidence = data.get("confidence", "N/A")

            # 获取样式
            style = self._get_node_style(node_type, node_status, node_confidence)

            # 构建节点标签
            node_label = f"[{style}]{node_id}[/]" if style else node_id
            node_label += f" (类型: {node_type})"

            if node_type in ["Hypothesis", "ConfirmedVulnerability"]:
                node_label += f" (状态: {node_status}, 置信度: {self._format_confidence(node_confidence)})"

            node_branch = nodes_tree.add(node_label)

            # 添加节点详细信息
            self._add_node_details(node_branch, node_type, data)

        # 显示边 (关系)
        if temp_graph.number_of_edges() > 0:
            edges_tree = tree.add("[bold blue] Edges (Relationships) [/]")
            for u, v, data in temp_graph.edges(data=True):
                label = data.get("label", "leads_to")
                edge_style = "green"
                if label == "CONTRADICTS":
                    edge_style = "red"
                elif label == "EXPLOITS":
                    edge_style = "bold magenta"

                edge_label = f"[{edge_style}]{u}[/] --[{label}]--> [{edge_style}]{v}[/]"
                edges_tree.add(edge_label)

        console.print(tree)

    def _build_subtask_payload(
        self, description: str, priority: int, reason: str, completion_criteria: str, mission_briefing: Optional[Dict]
    ) -> Dict[str, Any]:
        """构建符合约定的子任务节点数据。"""

        return {
            "type": "subtask",
            "description": description,
            "status": "pending",
            "reflection": None,
            "priority": priority,
            "reason": reason,
            "completion_criteria": completion_criteria,
            "mission_briefing": mission_briefing,
            "proposed_changes": [],
            "staged_causal_nodes": [],
            "summary": None,
            "artifacts": [],
            "created_at": time.time(),
            "updated_at": time.time(),
            "execution_summary_cache": None,
            "execution_summary_last_sequence": 0,
            "execution_summary_updated_at": None,
            "conversation_history": [],  # New field to store persistent conversation history for the subtask
            "turn_counter": 0,  # New field to track turns for periodic summarization
        }

    def get_subtask_conversation_history(self, subtask_id: str) -> List[Dict[str, Any]]:
        """
        获取子任务的对话历史。
        """
        if not self.graph.has_node(subtask_id):
            raise NodeNotFoundError(f"子任务 {subtask_id} 不存在于图中。")
        self._ensure_node_defaults(subtask_id)
        return self.graph.nodes[subtask_id].get("conversation_history", [])

    def update_subtask_conversation_history(self, subtask_id: str, history: List[Dict[str, Any]]):
        """
        更新子任务的对话历史。
        """
        if not self.graph.has_node(subtask_id):
            raise NodeNotFoundError(f"子任务 {subtask_id} 不存在于图中。")
        self.graph.nodes[subtask_id]["conversation_history"] = history

    def get_subtask_turn_counter(self, subtask_id: str) -> int:
        """
        获取子任务的轮次计数器。
        """
        if not self.graph.has_node(subtask_id):
            raise NodeNotFoundError(f"子任务 {subtask_id} 不存在于图中。")
        self._ensure_node_defaults(subtask_id)
        return self.graph.nodes[subtask_id].get("turn_counter", 0)

    def update_subtask_turn_counter(self, subtask_id: str, counter: int):
        """
        更新子任务的轮次计数器。
        """
        if not self.graph.has_node(subtask_id):
            raise NodeNotFoundError(f"子任务 {subtask_id} 不存在于图中。")
        self.graph.nodes[subtask_id]["turn_counter"] = counter

    def _build_execution_payload(
        self, parent_id: str, thought: str, action: Dict, status: str, hypothesis_update: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """
        构建执行步骤节点数据，包含顺序信息。
        """

        return {
            "type": "execution_step",
            "parent": parent_id,
            "thought": thought,
            "action": action,
            "observation": None,
            "status": status,
            "sequence": self._execution_counter,
            "created_at": time.time(),
            "updated_at": time.time(),
            "hypothesis_update": hypothesis_update,  # Store hypothesis_update
        }

    def _ensure_node_defaults(self, node_id: str) -> None:
        """确保节点具备必要字段，缺失时自动填充。"""

        if not self.graph.has_node(node_id):
            return

        node_data = self.graph.nodes[node_id]
        node_type = node_data.get("type")

        node_data.setdefault("created_at", time.time())
        node_data["updated_at"] = time.time()

        if node_type == "subtask":
            node_data.setdefault("description", "")
            node_data.setdefault("status", "pending")
            node_data.setdefault("reflection", None)
            node_data.setdefault("priority", 1)
            node_data.setdefault("reason", "")
            node_data.setdefault("completion_criteria", "")
            node_data.setdefault("mission_briefing", None)
            node_data.setdefault("proposed_changes", [])
            node_data.setdefault("staged_causal_nodes", [])
            node_data.setdefault("summary", None)
            node_data.setdefault("artifacts", [])
            node_data.setdefault("execution_summary_cache", None)
            node_data.setdefault("execution_summary_last_sequence", 0)
            node_data.setdefault("execution_summary_updated_at", None)
        elif node_type == "execution_step":
            node_data.setdefault("thought", "")
            node_data.setdefault("action", {})
            node_data.setdefault("observation", None)
            node_data.setdefault("status", "pending")
            node_data.setdefault("parent", None)
            node_data.setdefault("sequence", 0)
            node_data.setdefault("hypothesis_update", {})  # Add default for hypothesis_update
        else:
            node_data.setdefault("metadata", {})

    def _is_valid_parent_for_subtask(self, parent_id: str, subtask_id: str) -> bool:
        """检查parent_id是否是subtask_id的有效父节点（即subtask本身或其后代）。"""

        if not self.graph.has_node(parent_id) or not self.graph.has_node(subtask_id):
            return False

        # parent_id就是subtask_id，有效
        if parent_id == subtask_id:
            return True

        # 检查parent_id是否是subtask_id的后代节点（通过execution边）
        visited = set()
        queue = [subtask_id]

        while queue:
            current = queue.pop(0)
            if current == parent_id:
                return True

            if current in visited:
                continue
            visited.add(current)

            for successor in self.graph.successors(current):
                edge_data = self.graph.edges[current, successor]
                # 只通过execution边遍历
                if edge_data.get("type") == "execution":
                    queue.append(successor)

        return False

    def _collect_execution_steps(self, subtask_id: str) -> List[str]:
        """按插入顺序收集子任务下的执行步骤。"""

        visited = set()
        queue = [subtask_id]

        collected: List[str] = []

        while queue:
            current = queue.pop()
            for successor in self.graph.successors(current):
                edge_data = self.graph.edges[current, successor]
                if edge_data.get("type") != "execution":
                    continue

                if successor in visited:
                    continue

                visited.add(successor)
                collected.append(successor)
                queue.append(successor)

        collected.sort(key=lambda node_id: self.graph.nodes[node_id].get("sequence", 0))
        return collected

    def _invalidate_execution_cache(self, subtask_id: str) -> None:
        """标记子任务的执行摘要缓存失效。"""

        if not self.graph.has_node(subtask_id):
            return

        node_data = self.graph.nodes[subtask_id]
        if node_data.get("type") != "subtask":
            return

        node_data["execution_summary_cache"] = None
        node_data["execution_summary_last_sequence"] = 0
        node_data["execution_summary_updated_at"] = None

    def _get_execution_summary(self, subtask_id: str, refresh: bool = False) -> str:
        """返回子任务的执行摘要，支持缓存。"""

        if not self.graph.has_node(subtask_id):
            return ""

        self._ensure_node_defaults(subtask_id)
        subtask_data = self.graph.nodes[subtask_id]
        step_ids = self._collect_execution_steps(subtask_id)

        if not step_ids:
            self._invalidate_execution_cache(subtask_id)
            return ""

        latest_sequence = max(self.graph.nodes[step_id].get("sequence", 0) for step_id in step_ids)
        cached_sequence = subtask_data.get("execution_summary_last_sequence", 0)
        cached_summary = subtask_data.get("execution_summary_cache")

        if not refresh and cached_summary and cached_sequence == latest_sequence:
            return cached_summary

        log_text = []
        for idx, step_id in enumerate(step_ids, start=1):
            if not self.graph.has_node(step_id):
                log_text.append(
                    f"### 步骤 {idx} (ID: {step_id})\n"
                    f"- **状态:** Missing\n"
                    f"- **思考:** Node no longer exists in graph\n"
                    f"- **行动:** N/A\n"
                    f"- **观察:** Node was removed from graph"
                )
                continue

            node_data = self.graph.nodes[step_id]
            action = node_data.get("action", {})
            observation = node_data.get("observation", {})

            observation_content = ""

            # 优先格式化元认知工具的输出
            tool_name = action.get("tool")
            if tool_name == "think" and isinstance(observation, dict) and "recorded_thought" in observation:
                thought_data = observation["recorded_thought"]
                formatted_thought = [
                    "上一步进行了结构化思考 (think):",
                    f"  - 分析 (Analysis): {thought_data.get('analysis', 'N/A')}",
                    f"  - 问题 (Problem): {thought_data.get('problem', 'N/A')}",
                    f"  - 结论 (Conclusion): {thought_data.get('conclusion', 'N/A')}",
                ]
                observation_content = "\n".join(formatted_thought)
            elif tool_name == "formulate_hypotheses" and isinstance(observation, dict) and "hypotheses" in observation:
                hypotheses = observation["hypotheses"]
                formatted_hypotheses = ["上一步提出了新的攻击假设 (formulate_hypotheses):"]
                for h in hypotheses:
                    formatted_hypotheses.append(
                        f"  - {h.get('description', 'N/A')} (置信度: {h.get('confidence', 'N/A')})"
                    )
                observation_content = "\n".join(formatted_hypotheses)
            elif (
                tool_name == "reflect_on_failure"
                and isinstance(observation, dict)
                and "failure_analysis" in observation
            ):
                analysis = observation["failure_analysis"]
                observation_content = (
                    f"上一步进行了失败反思 (reflect_on_failure):\n{json.dumps(analysis, indent=2, ensure_ascii=False)}"
                )
            elif tool_name == "expert_analysis" and isinstance(observation, dict) and "expert_opinion" in observation:
                opinion = observation["expert_opinion"]
                observation_content = (
                    f"上一步获得了专家分析意见 (expert_analysis):\n{json.dumps(opinion, indent=2, ensure_ascii=False)}"
                )
            else:
                # 其次，使用 hypothesis_update 中的 observation_summary
                hypothesis_update_data = node_data.get("hypothesis_update")
                if isinstance(hypothesis_update_data, dict):
                    summary = hypothesis_update_data.get("observation_summary")
                    if summary:
                        observation_content = summary

                # 如果以上都没有，则回退到原始 observation
                if not observation_content:
                    observation_content = json.dumps(observation, ensure_ascii=False)

            log_text.append(
                "\n".join(
                    [
                        f"### 步骤 {idx} (ID: {step_id})",
                        f"- **状态:** {node_data.get('status', 'N/A')}",
                        f"- **思考:** {node_data.get('thought', '')}",
                        f"- **行动:** {json.dumps(action, ensure_ascii=False)}",
                        f"- **观察:** {observation_content}",
                    ]
                )
            )

        summary = "\n".join(log_text)
        subtask_data["execution_summary_cache"] = summary
        subtask_data["execution_summary_last_sequence"] = latest_sequence
        subtask_data["execution_summary_updated_at"] = time.time()

        return summary

    def build_prompt_context(self, subtask_id: str) -> Dict[str, Any]:
        """为提示生成器构建结构化上下文片段。"""

        if not self.graph.has_node(subtask_id):
            raise NodeNotFoundError(f"子任务 {subtask_id} 不存在于图中。")

        self._ensure_node_defaults(subtask_id)
        subtask_data = self.graph.nodes[subtask_id]

        dependencies = []
        # Use nx.ancestors to get all predecessors in the graph
        # 使用 networkx.bfs_tree 来获取所有前驱节点，并反转以从根到当前节点排序
        # We use bfs_tree to get all predecessors and reverse it to get the order from root to current node
        ancestors_in_order = list(nx.bfs_tree(self.graph.reverse(copy=True), source=subtask_id))

        for dep_id in ancestors_in_order:
            if dep_id == subtask_id:  # Don't include the subtask itself
                continue

            if self.graph.nodes[dep_id].get("type") == "subtask":
                dep_data = self.graph.nodes[dep_id]
                # 兼容期望的依赖上下文字段结构（用于渲染），并保留旧字段以保证向后兼容
                artifacts = list(dep_data.get("artifacts", []))
                # 从产出工件中提取简要的节点产出描述
                nodes_produced: List[str] = []
                try:
                    for a in artifacts[:10]:  # 限制长度，避免过载
                        if isinstance(a, dict):
                            nodes_produced.append(a.get("id") or a.get("name") or a.get("type") or str(a))
                        else:
                            nodes_produced.append(str(a))
                except Exception:
                    pass

                # 将 summary 作为关键发现的回退；若已有 key_findings 则使用现有的
                summary_text = dep_data.get("summary")
                key_findings: List[str] = []
                try:
                    existing_kf = dep_data.get("key_findings")
                    if isinstance(existing_kf, list) and existing_kf:
                        key_findings = existing_kf
                    elif isinstance(summary_text, str) and summary_text.strip():
                        key_findings = [summary_text]
                except Exception:
                    pass

                failure_reason = dep_data.get("failure_reason")
                # 当任务失败但未显式给出失败原因时，回退使用 reflection 或 summary
                if not failure_reason:
                    status_val = str(dep_data.get("status", "")).lower()
                    if status_val.startswith("failed") or status_val == "failed":
                        failure_reason = dep_data.get("reflection") or summary_text

                # 注入该依赖子任务的执行摘要（父、祖父等祖先链都会包含）
                dep_execution_summary = self._get_execution_summary(dep_id)

                dependencies.append(
                    {
                        # 旧字段（兼容测试与历史使用）
                        "id": dep_id,
                        "status": dep_data.get("status"),
                        "summary": summary_text,
                        "artifacts": artifacts,
                        # 新增字段（满足 format_dependencies_summary 的期望）
                        "task_id": dep_id,
                        "description": dep_data.get("description"),
                        "key_findings": key_findings,
                        "failure_reason": failure_reason,
                        "nodes_produced": nodes_produced,
                        "execution_summary": dep_execution_summary,
                    }
                )

        execution_summary = self._get_execution_summary(subtask_id)

        # Executor 只需要相关的因果链上下文，而非完整的图谱摘要
        # 这样可以避免信息过载，让执行器专注于当前任务
        causal_context = self.get_relevant_causal_context(subtask_id)

        # Extract key_facts from the causal graph
        current_key_facts = []
        for node_id, data in self.causal_graph.nodes(data=True):
            if data.get("type") == "key_fact":
                current_key_facts.append(data.get("description", ""))

        return {
            "task_id": self.task_id,
            "key_facts": current_key_facts,  # Now populated from causal graph
            "causal_context": causal_context,  # 筛选ed relevant context for Executor
            # 为执行器提供完整全局因果链图谱摘要，便于全局视角下的战术决策
            "causal_graph_summary": self.get_causal_graph_summary(),
            "subtask": {
                "id": subtask_id,
                "description": subtask_data.get("description"),
                "reason": subtask_data.get("reason"),
                "completion_criteria": subtask_data.get("completion_criteria"),
                "status": subtask_data.get("status"),
                "priority": subtask_data.get("priority"),
                "reflection": subtask_data.get("reflection"),
            },
            "dependencies": dependencies,
            "execution_summary": execution_summary,
            "staged_causal_nodes": list(subtask_data.get("staged_causal_nodes", [])),
            "proposed_changes": list(subtask_data.get("proposed_changes", [])),
        }

    def _find_success_trigger_node(self) -> Optional[str]:
        success_trigger_node: Optional[str] = None
        confirmed_vulns = [
            n for n, d in self.causal_graph.nodes(data=True) if d.get("node_type") == "ConfirmedVulnerability"
        ]
        if confirmed_vulns:
            success_trigger_node_id = confirmed_vulns[0]
            success_trigger_node_data = self.causal_graph.nodes[success_trigger_node_id]
            trigger_step_id = success_trigger_node_data.get("source_step_id")
            if trigger_step_id and self.graph.has_node(trigger_step_id):
                success_trigger_node = trigger_step_id
            else:
                logging.warning(
                    f"Could not trace ConfirmedVulnerability {success_trigger_node_id} back to a step in the main graph."
                )
        if not success_trigger_node:
            artifact_node_id: Optional[str] = None
            for node, data in self.causal_graph.nodes(data=True):
                if (data.get("node_type") == "TargetArtifact") or (data.get("type") == "target_artifact"):
                    trigger_step_id = data.get("source_step_id")
                    if trigger_step_id and self.graph.has_node(trigger_step_id):
                        artifact_node_id = trigger_step_id
                        break
            if not artifact_node_id:
                for node, data in self.graph.nodes(data=True):
                    nodes_list = (
                        data.get("validated_nodes", [])
                        or data.get("validated_artifacts", [])
                        or data.get("artifacts", [])
                    )
                    if any(
                        (n.get("type") == "target_artifact") or (n.get("node_type") == "TargetArtifact") for n in nodes_list
                    ):
                        artifact_node_id = node
                        break
            success_trigger_node = artifact_node_id
        return success_trigger_node

    def _add_simplified_nodes(self, simplified_graph: nx.DiGraph, successful_path_nodes: set) -> None:
        for node_id in successful_path_nodes:
            if not self.graph.has_node(node_id):
                continue
            original_data = self.graph.nodes[node_id]
            node_type = original_data.get("type")
            simplified_data = {"id": node_id, "type": node_type, "status": original_data.get("status")}
            if node_type == "subtask":
                simplified_data["description"] = original_data.get("description")
            elif node_type == "execution_step":
                simplified_data["thought"] = original_data.get("thought")
                simplified_data["action"] = {"tool": original_data.get("action", {}).get("tool")}
            simplified_graph.add_node(node_id, **simplified_data)

    def _add_simplified_edges(self, simplified_graph: nx.DiGraph, successful_path_nodes: set) -> None:
        for u, v, data in self.graph.edges(data=True):
            if u in successful_path_nodes and v in successful_path_nodes:
                simplified_graph.add_edge(u, v, type=data.get("type"))

    def get_simplified_graph(self) -> Dict[str, Any]:
        """
        生成一个简化的、只包含成功路径的图，用于经验归档。
        新逻辑：优先从 Causal Graph 中的 ConfirmedVulnerability 或 Flag 回溯。
        """
        simplified_graph = nx.DiGraph()
        success_trigger_node = self._find_success_trigger_node()
        if not success_trigger_node:
            return {"nodes": [], "edges": []}
        successful_path_nodes = {success_trigger_node}.union(nx.ancestors(self.graph, success_trigger_node))
        self._add_simplified_nodes(simplified_graph, successful_path_nodes)
        self._add_simplified_edges(simplified_graph, successful_path_nodes)
        return json_graph.node_link_data(simplified_graph)

    def get_descendants(self, node_id: str) -> set:
        """返回给定节点的所有后代节点ID集合。"""
        if not self.graph.has_node(node_id):
            return set()
        return nx.descendants(self.graph, node_id)

    def is_goal_achieved(self) -> bool:
        """
        检查任务目标是否已达成。

        目标被视为达成，当且仅当图中有节点的 'status' 被 Planner/Reflector 明确标记为 'GOAL_ACHIEVED'。
        这确保了终止决策完全由 LLM 智能体自主做出，而不是依赖硬编码的检测规则。
        """
        # 检查主任务图中的节点状态
        for node_id, data in self.graph.nodes(data=True):
            if str(data.get("status", "")).upper() == "GOAL_ACHIEVED":
                logging.debug(f"Goal achieved: Node {node_id} has status GOAL_ACHIEVED.")
                return True
        
        # 检查因果图中的节点状态（作为备用检查）
        for node_id, data in self.causal_graph.nodes(data=True):
            if str(data.get("status", "")).upper() == "GOAL_ACHIEVED":
                logging.debug(f"Goal achieved: Causal node {node_id} has status GOAL_ACHIEVED.")
                return True

        return False
