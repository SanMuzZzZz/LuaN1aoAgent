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
from core.database.utils import (
    schedule_coroutine, 
    upsert_node, 
    delete_node, 
    add_edge, 
    update_session_status,
    create_session,
    atomic_upsert_graph_data
)

from core.data_contracts import CausalNode, CausalEdge


class GraphManagerError(Exception):
    pass


class NodeNotFoundError(GraphManagerError):
    pass


from enum import Enum
import math


class EvidenceStrength(Enum):
    """
    证据逻辑强度分类（溯因推理核心）
    
    用于区分决定性证据和累积性证据，实现非单调逻辑传播。
    - NECESSARY: 必然性证据，可一票否决或确认假设
    - CONTINGENT: 偶然性证据，通过 Sigmoid 函数非线性累积
    """
    NECESSARY = "necessary"
    CONTINGENT = "contingent"


import uuid


class GraphManager:
    """
    管理和维护任务知识图谱.
    (支持 SQLite 持久化)
    """

    def __init__(self, task_id: str, goal: str, op_id: Optional[str] = None):
        self.task_id = task_id
        self.graph = nx.DiGraph()
        self.causal_graph = nx.DiGraph()
        self._execution_counter = 0
        self.op_id = op_id  # This is the session_id in DB
        
        # Initialize session in DB if op_id is provided
        if self.op_id:
            schedule_coroutine(create_session(
                session_id=self.op_id,
                name=task_id,
                goal=goal,
                config={}
            ))
            
        self.initialize_graph(goal)

    def set_op_id(self, op_id: str):
        """Set the operation ID for event emission and DB persistence."""
        self.op_id = op_id
        # Note: We assume the session is created elsewhere if set late, 
        # or we could trigger a create_session here too if needed.

    def initialize_graph(self, goal: str) -> None:
        """初始化图，添加代表整体任务的根节点."""
        node_data = {"type": "task", "goal": goal, "status": "in_progress"}
        self.graph.add_node(self.task_id, **node_data)
        
        if self.op_id:
            schedule_coroutine(upsert_node(self.op_id, self.task_id, 'task', node_data))

    def _sync_node(self, node_id: str, graph_type: str = 'task') -> None:
        """Helper to sync a node to DB asynchronously."""
        if not self.op_id:
            return
            
        if graph_type == 'task':
            if self.graph.has_node(node_id):
                data = self.graph.nodes[node_id]
                schedule_coroutine(upsert_node(self.op_id, node_id, graph_type, dict(data)))
        elif graph_type == 'causal':
            if self.causal_graph.has_node(node_id):
                data = self.causal_graph.nodes[node_id]
                schedule_coroutine(upsert_node(self.op_id, node_id, graph_type, dict(data)))

    def _sync_edge(self, source: str, target: str, graph_type: str = 'task'):
        """Helper to sync an edge to DB asynchronously."""
        if not self.op_id:
            return

        if graph_type == 'task':
            if self.graph.has_edge(source, target):
                data = self.graph.edges[source, target]
                schedule_coroutine(add_edge(self.op_id, source, target, graph_type, dict(data)))
        elif graph_type == 'causal':
            if self.causal_graph.has_edge(source, target):
                data = self.causal_graph.edges[source, target]
                schedule_coroutine(add_edge(self.op_id, source, target, graph_type, dict(data)))

    def _sync_nodes_and_edges_atomic(
        self,
        node_ids: List[str],
        edges: List[tuple],
        graph_type: str = 'task'
    ):
        """
        原子同步多个节点和边到数据库。
        
        Args:
            node_ids: 需要同步的节点ID列表
            edges: 需要同步的边列表，每个元素是 (source, target) 元组
            graph_type: 图类型 ('task' 或 'causal')
        """
        if not self.op_id:
            return
        
        graph = self.graph if graph_type == 'task' else self.causal_graph
        
        # 收集节点数据
        nodes_data = []
        for node_id in node_ids:
            if graph.has_node(node_id):
                data = dict(graph.nodes[node_id])
                data['node_id'] = node_id
                nodes_data.append(data)
        
        # 收集边数据
        edges_data = []
        for source, target in edges:
            if graph.has_edge(source, target):
                data = dict(graph.edges[source, target])
                data['source'] = source
                data['target'] = target
                edges_data.append(data)
        
        # 原子写入
        if nodes_data or edges_data:
            schedule_coroutine(
                atomic_upsert_graph_data(
                    self.op_id,
                    nodes=nodes_data,
                    edges=edges_data,
                    graph_type=graph_type
                )
            )

    def add_key_fact(self, fact: str) -> str:
        if not fact or not isinstance(fact, str):
            return ""

        fact_content = fact.strip()
        fact_id = f"key_fact_{hash(fact_content)}"

        if not self.causal_graph.has_node(fact_id):
            self.causal_graph.add_node(fact_id, type="key_fact", description=fact_content, created_at=time.time())
            self._sync_node(fact_id, 'causal')
            logging.debug(f"GraphManager: Added new key_fact to causal graph: {fact_content}")
        return fact_id

    def add_causal_node(self, artifact: Dict) -> str:
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
            if artifact.get("id"):
                node_id = artifact["id"]
            source_step = artifact.get("source_step_id", "")
            raw_output = artifact.get("raw_output", "")
            unique_content = f"{source_step}-{raw_output}"

            import hashlib
            hasher = hashlib.sha256()
            hasher.update(unique_content.encode("utf-8", errors="replace"))
            digest = hasher.hexdigest()[:16]
            node_id = artifact.get("id", f"art_{digest}__{artifact.get('node_type', 'unknown')}")
        except Exception:
            node_id = f"art_{uuid.uuid4().hex}"

        if not self.causal_graph.has_node(node_id):
            artifact["created_at"] = time.time()
            if artifact.get("node_type") == "ConfirmedVulnerability":
                artifact["confidence"] = artifact.get("confidence", 0.99)
                artifact["status"] = artifact.get("status", "CONFIRMED")

            self.causal_graph.add_node(node_id, **artifact)
            self._sync_node(node_id, 'causal')

        return node_id

    def add_causal_edge(self, source_artifact_id: str, target_artifact_id: str, label: str, **attrs):
        if source_artifact_id == target_artifact_id:
            return

        if self.causal_graph.has_node(source_artifact_id) and self.causal_graph.has_node(target_artifact_id):
            standardized_label = self._standardize_edge_label(label)
            self.causal_graph.add_edge(source_artifact_id, target_artifact_id, label=standardized_label, **attrs)
            self._sync_edge(source_artifact_id, target_artifact_id, 'causal')
        else:
            logging.warning(
                f"Cannot create causal edge: node {source_artifact_id} or {target_artifact_id} not found."
            )

    def add_causal_node_obj(self, node: "CausalNode") -> str:
        try:
            if is_dataclass(node):
                payload = asdict(node)
            elif hasattr(node, "__dict__"):
                payload = dict(node.__dict__)
            else:
                raise TypeError("Unsupported causal node type")
        except Exception as e:
            logging.error(f"add_causal_node_obj: failed to serialize node: {e}")
            raise

        if payload.get("type") and not payload.get("node_type"):
            payload["node_type"] = payload["type"]
        
        if "id" in payload:
            del payload["id"]
        
        return self.add_causal_node(payload)

    def add_causal_edge_obj(self, edge: "CausalEdge") -> None:
        if not hasattr(edge, "source_id") or not hasattr(edge, "target_id"):
            raise ValueError("CausalEdge object missing source_id/target_id")
        label = getattr(edge, "label", "")
        description = getattr(edge, "description", None)
        attrs = {"description": description} if description else {}
        self.add_causal_edge(edge.source_id, edge.target_id, label, **attrs)

    def _standardize_edge_label(self, label: str) -> str:
        if not label:
            return "SUPPORTS"
        norm = str(label).strip().upper()
        mapping = {
            "SUPPORT": "SUPPORTS", "SUPPORTS": "SUPPORTS", "CONFIRMS": "SUPPORTS",
            "DEFINITIVE_CONFIRMATION": "SUPPORTS", "WEAK_SUPPORT": "SUPPORTS",
            "CONTRADICT": "CONTRADICTS", "CONTRADICTS": "CONTRADICTS",
            "DISPROVES": "CONTRADICTS", "FALSIFIES": "CONTRADICTS",
            "MINOR_CONTRADICTION": "CONTRADICTS",
            "REVEAL": "REVEALS", "REVEALS": "REVEALS",
            "EXPLOIT": "EXPLOITS", "EXPLOITS": "EXPLOITS",
            "MITIGATE": "MITIGATES", "MITIGATES": "MITIGATES",
        }
        return mapping.get(norm, norm)

    def update_hypothesis_confidence(self, hypothesis_id: str, label: str, evidence_strength: str = None, evidence_type: str = None):
        """
        非单调逻辑置信度传播 (Non-Monotonic Logic Propagation)
        
        区分必然性证据（可否决/确认）和偶然性证据（Sigmoid 累积）。
        这是溯因推理框架的核心机制，避免了贝叶斯方法对先验概率的依赖。
        
        Args:
            hypothesis_id: 假设节点ID
            label: 边标签（SUPPORTS/CONTRADICTS 等）
            evidence_strength: LLM 输出的证据强度（优先使用）
            evidence_type: 证据类型标识，用于回退判断（可选）
        """
        label = self._standardize_edge_label(label)
        if not self.causal_graph.has_node(hypothesis_id):
            return

        node_data = self.causal_graph.nodes[hypothesis_id]
        node_type = node_data.get("node_type")

        # ConfirmedVulnerability 特殊处理
        if node_type == "ConfirmedVulnerability":
            if label == "CONTRADICTS":
                self.causal_graph.nodes[hypothesis_id]["re_evaluation_needed"] = True
                self.causal_graph.nodes[hypothesis_id]["status"] = "RE_EVALUATION_PENDING"
                self._sync_node(hypothesis_id, 'causal')
            return

        if node_type != "Hypothesis":
            return

        # 获取当前置信度
        confidence_val = node_data.get("confidence", 0.5)
        try:
            current_confidence = float(confidence_val)
        except (ValueError, TypeError):
            current_confidence = 0.5
        
        # 分类证据强度（优先使用 LLM 输出的 evidence_strength）
        strength = self._classify_evidence_strength(label, evidence_strength=evidence_strength)
        
        if strength == EvidenceStrength.NECESSARY:
            # 必然性证据：一票否决或确认
            if label == "CONTRADICTS":
                new_confidence = 0.0
                new_status = "FALSIFIED"
                logging.info(f"[Abductive] NECESSARY CONTRADICTS: Hypothesis '{hypothesis_id}' vetoed (conf: 0.0)")
            else:  # SUPPORTS
                new_confidence = 1.0
                new_status = "CONFIRMED"
                logging.info(f"[Abductive] NECESSARY SUPPORTS: Hypothesis '{hypothesis_id}' confirmed (conf: 1.0)")
            self.causal_graph.nodes[hypothesis_id]["status"] = new_status
        else:
            # 偶然性证据：Sigmoid 非线性累积
            # 使用 logit 变换实现边缘收敛（避免置信度过快到达边界）
            delta = 0.4 if label == "SUPPORTS" else -0.5
            
            # Clamp to avoid math domain errors
            clamped_conf = max(0.01, min(0.99, current_confidence))
            logit = math.log(clamped_conf / (1 - clamped_conf))
            new_logit = logit + delta
            new_confidence = 1 / (1 + math.exp(-new_logit))
            
            # 防止极端值
            new_confidence = max(0.05, min(0.95, new_confidence))
            
            # 更新状态
            if label == "SUPPORTS":
                self.causal_graph.nodes[hypothesis_id]["status"] = "SUPPORTED"
            elif label in ["CONTRADICTS", "FAILED_EXTRACTION_ATTEMPT"]:
                self.causal_graph.nodes[hypothesis_id]["status"] = "CONTRADICTED"

        self.causal_graph.nodes[hypothesis_id]["confidence"] = new_confidence
        self._sync_node(hypothesis_id, 'causal')
        
        node_status = self.causal_graph.nodes[hypothesis_id].get("status")
        strength_label = strength.value if strength else "contingent"
        message = f"Confidence for hypothesis '{hypothesis_id}' updated from {current_confidence:.2f} to {new_confidence:.2f} via {strength_label} '{label}' edge. Status: {node_status}."
        logging.debug(message)
        
        try:
            console.print(f"[bold yellow]Confidence Update:[/bold yellow] {message}")
        except Exception:
            pass

        if self.op_id:
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(broker.emit("graph.changed", {
                    "reason": "confidence_update", 
                    "message": message,
                    "node_id": hypothesis_id,
                    "new_confidence": new_confidence,
                    "evidence_strength": strength_label
                }, op_id=self.op_id))
            except RuntimeError:
                pass

    def _classify_evidence_strength(self, label: str, evidence_strength: str = None, evidence_type: str = None) -> EvidenceStrength:
        """
        分类证据的逻辑强度（LLM 驱动优先）
        
        LLM 显式输出的 evidence_strength 参数（"necessary" / "contingent"）        
        这样保证了智能化自主化（LLM 可以根据具体场景判断），
        
        Args:
            label: 边标签（SUPPORTS/CONTRADICTS）
            evidence_strength: LLM 输出的证据强度（优先使用）
            evidence_type: 证据类型描述（回退匹配用）
            
        Returns:
            EvidenceStrength 枚举值
        """
        # 1. 优先使用 LLM 显式输出的 evidence_strength
        if evidence_strength:
            strength_lower = evidence_strength.lower().strip()
            if strength_lower in ("necessary", "decisive", "conclusive", "definitive"):
                return EvidenceStrength.NECESSARY
            elif strength_lower in ("contingent", "cumulative", "weak", "indicative"):
                return EvidenceStrength.CONTINGENT

        
        if evidence_type:
            logging.debug(f"Evidence type provided: {evidence_type}, but defaulting to CONTINGENT as no strength was specified.")
        
        # 2. 默认为偶然性证据 (Conservative Default)
        return EvidenceStrength.CONTINGENT

    def analyze_attack_paths(self) -> List[Dict[str, Any]]:
        attack_paths = []
        evidence_nodes = [n for n, d in self.causal_graph.nodes(data=True) if (d.get("node_type") or d.get("type")) == "Evidence"]
        vulnerability_nodes = [n for n, d in self.causal_graph.nodes(data=True) if (d.get("node_type") in {"Vulnerability", "PossibleVulnerability", "ConfirmedVulnerability"} or d.get("type") in {"Vulnerability", "PossibleVulnerability", "ConfirmedVulnerability"})]

        if not evidence_nodes or not vulnerability_nodes:
            return []

        for source in evidence_nodes:
            for target in vulnerability_nodes:
                try:
                    paths = list(nx.all_simple_paths(self.causal_graph, source=source, target=target))
                    for path in paths:
                        path_score = 1.0
                        path_details = []
                        for node_id in path:
                            node_data = self.causal_graph.nodes[node_id]
                            path_details.append({
                                "id": node_id,
                                "type": node_data.get("node_type", node_data.get("type")),
                                "description": node_data.get("description", ""),
                            })
                            if node_data.get("node_type") == "Hypothesis":
                                path_score *= node_data.get("confidence", 0.1)

                        vuln_data = self.causal_graph.nodes[target]
                        cvss_score = vuln_data.get("cvss_score", 0.0)
                        final_score = path_score * (cvss_score / 10.0)
                        attack_paths.append({"path": path_details, "score": final_score})
                except nx.NetworkXNoPath:
                    continue

        return sorted(attack_paths, key=lambda x: x["score"], reverse=True)

    def _find_contradiction_clusters(self) -> List[Dict[str, Any]]:
        clusters = []
        for node_id, data in self.causal_graph.nodes(data=True):
            if data.get("node_type") == "Hypothesis":
                evidences = self._get_contradicting_evidences_for_hypothesis(node_id)
                if len(evidences) > 1:
                    clusters.append({
                        "hypothesis_id": node_id,
                        "hypothesis_description": data.get("description"),
                        "contradicting_evidence_count": len(evidences),
                        "contradicting_evidences": evidences,
                    })
            elif data.get("node_type") == "Evidence":
                hypotheses = self._get_contradicted_hypotheses_for_evidence(node_id)
                if len(hypotheses) > 1:
                    clusters.append({
                        "evidence_id": node_id,
                        "evidence_description": data.get("description"),
                        "contradicted_hypothesis_count": len(hypotheses),
                        "contradicted_hypotheses": hypotheses,
                    })
        return clusters

    def _get_contradicting_evidences_for_hypothesis(self, hypo_id: str) -> List[Dict[str, Any]]:
        evidences = []
        for predecessor in self.causal_graph.predecessors(hypo_id):
            edge_data = self.causal_graph.get_edge_data(predecessor, hypo_id)
            if edge_data and edge_data.get("label") == "CONTRADICTS":
                pred_data = self.causal_graph.nodes[predecessor]
                if pred_data.get("node_type") == "Evidence":
                    evidences.append({"id": predecessor, "description": pred_data.get("description")})
        return evidences

    def _get_contradicted_hypotheses_for_evidence(self, evidence_id: str) -> List[Dict[str, Any]]:
        hypotheses = []
        for successor in self.causal_graph.successors(evidence_id):
            edge_data = self.causal_graph.get_edge_data(evidence_id, successor)
            if edge_data and edge_data.get("label") == "CONTRADICTS":
                succ_data = self.causal_graph.nodes[successor]
                if succ_data.get("node_type") == "Hypothesis":
                    hypotheses.append({"id": successor, "description": succ_data.get("description")})
        return hypotheses

    def _find_stalled_hypotheses(self, time_window_seconds: int = 3600) -> List[Dict[str, Any]]:
        stalled = []
        now = time.time()
        hypothesis_nodes = {n: d for n, d in self.causal_graph.nodes(data=True) if d.get("node_type") == "Hypothesis"}

        for hypo_id, hypo_data in hypothesis_nodes.items():
            created_at = hypo_data.get("created_at", now)
            status = hypo_data.get("status", "PENDING")

            if status == "FALSIFIED" and not self._has_supporting_evidence(hypo_id):
                stalled.append({
                    "id": hypo_id,
                    "description": hypo_data.get("description"),
                    "confidence": hypo_data.get("confidence"),
                    "status": status,
                    "reason": "FALSIFIED and no new supporting evidence.",
                    "age_seconds": now - created_at,
                })
                continue

            if (now - created_at) > time_window_seconds and status in ["PENDING", "SUPPORTED"]:
                if not self._has_recent_activity(hypo_id, created_at):
                    stalled.append({
                        "id": hypo_id,
                        "description": hypo_data.get("description"),
                        "confidence": hypo_data.get("confidence"),
                        "status": status,
                        "reason": "No recent activity and older than time window.",
                        "age_seconds": now - created_at,
                    })
        return stalled

    def _has_supporting_evidence(self, hypo_id: str) -> bool:
        for successor in self.causal_graph.successors(hypo_id):
            edge_data = self.causal_graph.get_edge_data(hypo_id, successor)
            if edge_data and edge_data.get("label") == "SUPPORTS":
                return True
        return False

    def _has_recent_activity(self, node_id: str, created_at: float) -> bool:
        for neighbor in nx.all_neighbors(self.causal_graph, node_id):
            neighbor_data = self.causal_graph.nodes[neighbor]
            if neighbor_data.get("created_at", 0) > created_at:
                return True
        return False

    def _find_competing_hypotheses(self) -> List[Dict[str, Any]]:
        """
        检测竞争假设（溯因推理核心）
        
        当同一证据支持多个假设时，存在解释歧义，需要 Planner 生成区分性探测任务。
        这是溯因推理框架中"推导至最佳解释"的关键步骤。
        
        Returns:
            竞争假设列表，每项包含证据ID和相关假设
        """
        competing = []
        
        for evidence_id, data in self.causal_graph.nodes(data=True):
            if data.get("node_type") != "Evidence":
                continue
            
            # 找出所有由此证据支持/反驳的假设
            related_hypotheses = []
            for _, target, edge_data in self.causal_graph.out_edges(evidence_id, data=True):
                target_data = self.causal_graph.nodes.get(target, {})
                if target_data.get("node_type") == "Hypothesis":
                    related_hypotheses.append({
                        "id": target,
                        "description": target_data.get("description", "")[:100],
                        "confidence": target_data.get("confidence"),
                        "status": target_data.get("status"),
                        "edge_label": edge_data.get("label"),
                    })
            
            # 如果同一证据关联多个假设，标记为竞争
            if len(related_hypotheses) > 1:
                competing.append({
                    "evidence_id": evidence_id,
                    "evidence_description": data.get("description", "")[:100],
                    "hypotheses_count": len(related_hypotheses),
                    "hypotheses": related_hypotheses,
                })
        
        return competing

    def analyze_failure_patterns(self, time_window_seconds: int = 3600) -> Dict[str, Any]:
        """
        分析因果图中的问题模式
        
        返回三类问题：
        - 矛盾簇：假设有相互矛盾的证据
        - 停滞假设：长时间无活动的假设
        - 竞争假设：同一证据支持多个假设（需消歧）
        """
        return {
            "contradiction_clusters": self._find_contradiction_clusters(),
            "stalled_hypotheses": self._find_stalled_hypotheses(time_window_seconds),
            "competing_hypotheses": self._find_competing_hypotheses(),
        }

    def get_failed_nodes(self) -> Dict[str, Any]:
        failed_nodes = {}
        for node_id, data in self.graph.nodes(data=True):
            if data.get("type") == "subtask" and data.get("status") in ["failed", "stalled_orphan", "completed_error"]:
                failed_nodes[node_id] = data
        return failed_nodes

    def get_relevant_causal_context(self, subtask_id: str, top_n_hypotheses: int = 5, top_n_paths: int = 3) -> Dict[str, Any]:
        context = {
            "related_hypotheses": [],
            "key_facts": [],
            "confirmed_vulnerabilities": [],
            "top_attack_paths": [],
            "failure_patterns": {},
        }

        for node_id, data in self.causal_graph.nodes(data=True):
            if data.get("node_type") == "Hypothesis":
                confidence_val = data.get("confidence", 0)
                try:
                    confidence_float = float(confidence_val)
                except (ValueError, TypeError):
                    confidence_float = 0.0

                if confidence_float > 0.7:
                    context["related_hypotheses"].append({
                        "id": node_id,
                        "description": data.get("description"),
                        "confidence": confidence_float,
                        "status": data.get("status"),
                    })
        context["related_hypotheses"] = sorted(context["related_hypotheses"], key=lambda x: x["confidence"], reverse=True)[:top_n_hypotheses]

        for node_id, data in self.causal_graph.nodes(data=True):
            nt = data.get("node_type", data.get("type"))
            if nt in {"key_fact", "KeyFact"}:
                context["key_facts"].append({"id": node_id, "description": data.get("description")})

        for node_id, data in self.causal_graph.nodes(data=True):
            nt = data.get("node_type", data.get("type"))
            if nt in {"ConfirmedVulnerability", "Vulnerability"}:
                context["confirmed_vulnerabilities"].append({"id": node_id, "description": data.get("description"), "cvss_score": data.get("cvss_score")})

        attack_paths = self.analyze_attack_paths()
        for path_info in attack_paths[:top_n_paths]:
            path_str = " -> ".join([f"{p['type']}({p['description'][:30]}...)" for p in path_info["path"]])
            context["top_attack_paths"].append({"path_description": path_str, "score": path_info["score"]})

        context["failure_patterns"] = self.analyze_failure_patterns()

        return context

    def add_subtask_node(self, subtask_id: str, description: str, dependencies: List[str], priority: int = 1, reason: str = "", completion_criteria: str = "", mission_briefing: Optional[Dict] = None):
        if self.graph.has_node(subtask_id):
            logging.warning("GraphManager.add_subtask_node: node %s already exists, skip.", subtask_id)
            return

        self.graph.add_node(
            subtask_id,
            **self._build_subtask_payload(description, priority, reason, completion_criteria, mission_briefing),
        )
        self._ensure_node_defaults(subtask_id)
        self._sync_node(subtask_id, 'task')

        if not dependencies:
            self.graph.add_edge(self.task_id, subtask_id, type="decomposition")
            self._sync_edge(self.task_id, subtask_id, 'task')

        for dep_id in dependencies:
            if self.graph.has_node(dep_id):
                self.graph.add_edge(dep_id, subtask_id, type="dependency")
                self._sync_edge(dep_id, subtask_id, 'task')

    def add_execution_step(self, step_id: str, parent_id: str, thought: str, action: Dict, status: str = "pending", hypothesis_update: Optional[Dict] = None):
        if not self.graph.has_node(parent_id):
            raise NodeNotFoundError(f"父节点 {parent_id} 不存在于图中。")

        self._execution_counter += 1

        self.graph.add_node(
            step_id, **self._build_execution_payload(parent_id, thought, action, status, hypothesis_update)
        )
        self._ensure_node_defaults(step_id)
        self._invalidate_execution_cache(parent_id)
        self._sync_node(step_id, 'task')

        self.graph.add_edge(parent_id, step_id, type="execution")
        self._sync_edge(parent_id, step_id, 'task')
        return step_id

    def update_node(self, node_id: str, updates: Dict[str, Any]):
        if self.graph.has_node(node_id):
            if "status" in updates and updates["status"] in ("completed", "failed"):
                import time
                updates["completed_at"] = time.time()
            
            for key, value in updates.items():
                self.graph.nodes[node_id][key] = value
            self._ensure_node_defaults(node_id)
            self._sync_node(node_id, 'task')
            
            node_type = self.graph.nodes[node_id].get("type")
            if node_type == "execution_step":
                parent_id = self.graph.nodes[node_id].get("parent")
                if parent_id:
                    self._invalidate_execution_cache(parent_id)
        else:
            logging.warning("GraphManager.update_node: node %s not found.", node_id)

    def delete_node(self, node_id: str):
        if self.graph.has_node(node_id):
            node_data = dict(self.graph.nodes[node_id])
            self.graph.remove_node(node_id)
            logging.info("GraphManager.delete_node: removed node %s.", node_id)
            schedule_coroutine(delete_node(self.op_id, node_id, 'task'))
            
            if node_data.get("type") == "execution_step":
                parent_id = node_data.get("parent")
                if parent_id:
                    self._invalidate_execution_cache(parent_id)
        else:
            logging.warning("GraphManager.delete_node: node %s not found.", node_id)

    def stage_proposed_changes(self, subtask_id: str, proposed_ops: List[Dict]):
        if self.graph.has_node(subtask_id):
            self._ensure_node_defaults(subtask_id)
            self.graph.nodes[subtask_id]["proposed_changes"].extend(proposed_ops)
            self._sync_node(subtask_id, 'task')
        else:
            raise ValueError(f"子任务 {subtask_id} 不存在于图中。")

    def stage_proposed_causal_nodes(self, subtask_id: str, proposed_nodes: List[Dict]):
        if not self.graph.has_node(subtask_id):
            raise ValueError(f"子任务 {subtask_id} 不存在于图中。")

        self._ensure_node_defaults(subtask_id)
        self.graph.nodes[subtask_id]["staged_causal_nodes"].extend(proposed_nodes)
        self._sync_node(subtask_id, 'task')

        for node_data in proposed_nodes:
            node_id = node_data.get("id")
            if not node_id:
                continue

            if self.causal_graph.has_node(node_id) or self.graph.has_node(node_id):
                continue

            self.graph.add_node(
                node_id,
                type="staged_causal",
                node_type=node_data.get("node_type"),
                is_staged_causal=True,
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
            self._sync_node(node_id, 'task')

            source_step_id = node_data.get("source_step_id")
            if source_step_id and self.graph.has_node(source_step_id):
                self.graph.add_edge(source_step_id, node_id, type="produces", label="生成")
                self._sync_edge(source_step_id, node_id, 'task')

    def clear_staged_causal_nodes(self, subtask_id: str):
        if not self.graph.has_node(subtask_id):
            logging.warning(f"GraphManager.clear_staged_causal_nodes: 子任务 {subtask_id} 不存在")
            return

        staged_node_ids = [nid for nid, data in self.graph.nodes(data=True) if data.get("is_staged_causal") is True]
        removed_count = 0
        for node_id in staged_node_ids:
            try:
                self.graph.remove_node(node_id)
                schedule_coroutine(delete_node(self.op_id, node_id, 'task'))
                removed_count += 1
            except Exception as e:
                logging.warning(f"删除暂存节点 {node_id} 失败: {e}")

        if "staged_causal_nodes" in self.graph.nodes[subtask_id]:
            self.graph.nodes[subtask_id]["staged_causal_nodes"] = []
            self._sync_node(subtask_id, 'task')

    def get_subtask_execution_log(self, subtask_id: str) -> str:
        if not self.graph.has_node(subtask_id):
            return "错误：未找到指定的子任务。"
        summary = self._get_execution_summary(subtask_id)
        return summary if summary else "该子任务没有执行步骤。"

    def get_full_graph_summary(self, detail_level: int = 1) -> str:
        summary_lines = [f"## 任务图谱: {self.task_id}"]
        subtask_nodes = [n for n, d in self.graph.nodes(data=True) if d.get("type") == "subtask"]

        for subtask_id in subtask_nodes:
            subtask_data = self.graph.nodes[subtask_id]
            status = subtask_data.get('status')
            priority = subtask_data.get('priority')
            desc = subtask_data.get('description')
            
            summary_lines.append(f"\n- [子任务] {subtask_id}: {desc} (状态: {status}, 优先级: {priority})")

            dependencies = [u for u, v in self.graph.in_edges(subtask_id) if self.graph.edges[u, v].get("type") == "dependency"]
            if dependencies:
                summary_lines.append(f"  - 依赖: {', '.join(dependencies)}")

            if reflection := subtask_data.get("reflection"):
                summary_lines.append(f"  - [反思]: {reflection.get('总结', '')}")

            if detail_level >= 2:
                step_nodes = [n for n in nx.dfs_preorder_nodes(self.graph, source=subtask_id) if self.graph.nodes[n].get("type") == "execution_step"]
                base_depth = len(nx.ancestors(self.graph, subtask_id))
                for step_id in step_nodes:
                    step_data = self.graph.nodes[step_id]
                    depth = len(nx.ancestors(self.graph, step_id)) - base_depth
                    indent = "    " * depth
                    tool = step_data.get('action', {}).get('tool', 'N/A')
                    summary_lines.append(f"{indent}- [步骤] {step_id} (状态: {step_data.get('status')}) -> {tool}")

        return "\n".join(summary_lines)

    def get_causal_graph_summary(self) -> str:
        if not self.causal_graph:
            return "因果链图谱为空。"
        summary_lines = ["## 因果链图谱摘要 (Causal Graph)", "\n## 节点概览"]
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

        summary_lines.append("\n## 推理关系")
        edges = [f"- ({u}) --[{self._standardize_edge_label(d.get('label', ''))}]--> ({v})" for u, v, d in self.causal_graph.edges(data=True)]
        summary_lines.extend(edges)
        return "\n".join(summary_lines)

    def get_attack_path_summary(self, top_n: int = 3) -> str:
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
        if not self.graph.has_node(subtask_id):
            return "无指导信息。"
        guidance = []
        dependencies = [u for u, v in self.graph.in_edges(subtask_id) if self.graph.edges[u, v].get("type") == "dependency"]
        for dep in dependencies:
            dep_data = self.graph.nodes[dep]
            dep_summary = dep_data.get("summary")
            if dep_summary:
                guidance.append(f"### 来自依赖任务 '{dep}' 的反思摘要:\n{dep_summary}")
            dep_artifacts = dep_data.get("artifacts")
            if dep_artifacts:
                try:
                    artifacts_str = json.dumps(dep_artifacts, indent=2, ensure_ascii=False)
                    guidance.append(f"### 来自依赖任务 '{dep}' 的关键产出物:\n```json\n{artifacts_str}\n```")
                except (TypeError, ValueError):
                    guidance.append(f"### 来自依赖任务 '{dep}' 的关键产出物 (格式错误):\n{dep_artifacts}")
        execution_summary = self._get_execution_summary(subtask_id)
        if execution_summary:
            guidance.append(f"### 当前执行摘要:\n{execution_summary}")
        return "\n\n".join(guidance) if guidance else "无额外指导。"

    def print_graph_structure(self, console, highlight_nodes: Optional[List[str]] = None):
        if not console:
            raise ValueError("console 实例不能为空")
        highlight_nodes = highlight_nodes or []
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
                node_label_style += " yellow reverse"
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
                    dep_branch.add(f"{dep} (状态={dep_data.get('status', 'unknown')}, 优先级={dep_data.get('priority', '?')})")
            reflection = data.get("reflection")
            if reflection:
                sub_tree.add(f"反思: {reflection}")
        console.print(tree)

    def _get_node_type(self, data: Dict[str, Any]) -> str:
        return data.get("node_type", data.get("type"))

    def _group_causal_nodes_by_type(self) -> Dict[str, list]:
        nodes = self.causal_graph.nodes(data=True)
        return {
            "evidence": [(n, d) for n, d in nodes if self._get_node_type(d) == "Evidence"],
            "hypothesis": [(n, d) for n, d in nodes if self._get_node_type(d) == "Hypothesis"],
            "vulnerability": [(n, d) for n, d in nodes if self._get_node_type(d) in ["PossibleVulnerability", "Vulnerability"]],
            "confirmed_vuln": [(n, d) for n, d in nodes if self._get_node_type(d) == "ConfirmedVulnerability"],
            "credential": [(n, d) for n, d in nodes if self._get_node_type(d) == "Credential"],
            "system_property": [(n, d) for n, d in nodes if self._get_node_type(d) == "SystemProperty"],
            "target_artifact": [(n, d) for n, d in nodes if self._get_node_type(d) == "TargetArtifact"],
            "unknown": [(n, d) for n, d in nodes if self._get_node_type(d) not in {"Evidence", "Hypothesis", "PossibleVulnerability", "Vulnerability", "ConfirmedVulnerability", "Credential", "SystemProperty", "TargetArtifact"}],
        }

    def _get_node_style(self, node_type: str, node_status: str, node_confidence: Any) -> str:
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
        try:
            return f"{float(val):.2f}"
        except (TypeError, ValueError):
            return str(val) if val is not None else "N/A"

    def _add_credential_details(self, node_branch, data: Dict[str, Any]) -> None:
        cred_data = data.get("data", {})
        node_branch.add(f"用户名: {cred_data.get('username', 'N/A')}")
        node_branch.add(f"密码: {cred_data.get('password', 'N/A')}")
        node_branch.add(f"来源: {cred_data.get('source', 'N/A')}")
        if not cred_data:
            node_branch.add(f"用户名: {data.get('username', 'N/A')}")
            node_branch.add(f"密码: {data.get('password', 'N/A')}")
            node_branch.add(f"来源: {data.get('source', 'N/A')}")

    def _add_system_property_details(self, node_branch, data: Dict[str, Any]) -> None:
        prop_data = data.get("data", {})
        node_branch.add(f"属性: {prop_data.get('property', 'N/A')}")
        node_branch.add(f"值: {prop_data.get('value', 'N/A')}")
        node_branch.add(f"来源: {prop_data.get('source', 'N/A')}")
        if not prop_data:
            node_branch.add(f"属性: {data.get('property', 'N/A')}")
            node_branch.add(f"值: {data.get('value', 'N/A')}")
            node_branch.add(f"来源: {data.get('source', 'N/A')}")

    def _add_target_artifact_details(self, node_branch, data: Dict[str, Any]) -> None:
        artifact_data = data.get("data", {})
        node_branch.add(f"产物: {artifact_data.get('value', 'N/A')}")
        node_branch.add(f"来源: {artifact_data.get('source', 'N/A')}")
        if not artifact_data:
            node_branch.add(f"产物: {data.get('value', 'N/A')}")
            node_branch.add(f"来源: {data.get('source', 'N/A')}")

    def _add_node_details(self, node_branch, node_type: str, data: Dict[str, Any]) -> None:
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
        if not console:
            raise ValueError("console 实例不能为空")
        if not self.causal_graph or self.causal_graph.number_of_nodes() == 0:
            console.print("因果链图谱为空。", style="dim")
            return
        tree = Tree("[bold magenta]因果链图谱 (Causal Graph)[/]", guide_style="magenta")
        grouped_nodes = self._group_causal_nodes_by_type()
        total_nodes = sum(len(nodes) for nodes in grouped_nodes.values())
        if total_nodes > max_nodes:
            console.print(f"[yellow]⚠️ 因果链图谱节点数 ({total_nodes}) 超过最大显示限制 ({max_nodes})，仅显示前 {max_nodes} 个节点。[/yellow]")
            all_nodes_sorted = sorted(self.causal_graph.nodes(data=True), key=lambda item: item[0])
            displayed_nodes = dict(all_nodes_sorted[:max_nodes])
            temp_graph = self.causal_graph.subgraph(displayed_nodes.keys())
        else:
            temp_graph = self.causal_graph
        nodes_tree = tree.add("[bold blue] Nodes [/]")
        for node_id, data in temp_graph.nodes(data=True):
            node_type = data.get("node_type", data.get("type", "Unknown"))
            node_status = data.get("status", "N/A")
            node_confidence = data.get("confidence", "N/A")
            style = self._get_node_style(node_type, node_status, node_confidence)
            node_label = f"[{style}]{node_id}[/]" if style else node_id
            node_label += f" (类型: {node_type})"
            if node_type in ["Hypothesis", "ConfirmedVulnerability"]:
                node_label += f" (状态: {node_status}, 置信度: {self._format_confidence(node_confidence)})"
            node_branch = nodes_tree.add(node_label)
            self._add_node_details(node_branch, node_type, data)
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

    def _build_subtask_payload(self, description: str, priority: int, reason: str, completion_criteria: str, mission_briefing: Optional[Dict]) -> Dict[str, Any]:
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
            "conversation_history": [],
            "turn_counter": 0,
        }

    def get_subtask_conversation_history(self, subtask_id: str) -> List[Dict[str, Any]]:
        if not self.graph.has_node(subtask_id):
            raise NodeNotFoundError(f"子任务 {subtask_id} 不存在于图中。")
        self._ensure_node_defaults(subtask_id)
        return self.graph.nodes[subtask_id].get("conversation_history", [])

    def update_subtask_conversation_history(self, subtask_id: str, history: List[Dict[str, Any]]):
        if not self.graph.has_node(subtask_id):
            raise NodeNotFoundError(f"子任务 {subtask_id} 不存在于图中。")
        self.graph.nodes[subtask_id]["conversation_history"] = history
        self._sync_node(subtask_id, 'task')

    def get_subtask_turn_counter(self, subtask_id: str) -> int:
        if not self.graph.has_node(subtask_id):
            raise NodeNotFoundError(f"子任务 {subtask_id} 不存在于图中。")
        self._ensure_node_defaults(subtask_id)
        return self.graph.nodes[subtask_id].get("turn_counter", 0)

    def update_subtask_turn_counter(self, subtask_id: str, counter: int):
        if not self.graph.has_node(subtask_id):
            raise NodeNotFoundError(f"子任务 {subtask_id} 不存在于图中。")
        self.graph.nodes[subtask_id]["turn_counter"] = counter
        self._sync_node(subtask_id, 'task')

    def get_subtask_last_step_ids(self, subtask_id: str) -> List[str]:
        """获取子任务的最后执行步骤ID列表，用于恢复执行时续接执行链。"""
        if not self.graph.has_node(subtask_id):
            raise NodeNotFoundError(f"子任务 {subtask_id} 不存在于图中。")
        self._ensure_node_defaults(subtask_id)
        return self.graph.nodes[subtask_id].get("last_step_ids", [])

    def update_subtask_last_step_ids(self, subtask_id: str, step_ids: List[str]):
        """更新子任务的最后执行步骤ID列表，用于下次恢复执行时续接执行链。"""
        if not self.graph.has_node(subtask_id):
            raise NodeNotFoundError(f"子任务 {subtask_id} 不存在于图中。")
        self.graph.nodes[subtask_id]["last_step_ids"] = step_ids
        self._sync_node(subtask_id, 'task')

    def _build_execution_payload(self, parent_id: str, thought: str, action: Dict, status: str, hypothesis_update: Optional[Dict] = None) -> Dict[str, Any]:
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
            "hypothesis_update": hypothesis_update,
        }

    def _ensure_node_defaults(self, node_id: str) -> None:
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
            node_data.setdefault("last_step_ids", [])  # 持久化执行链，用于子任务恢复执行时续接
        elif node_type == "execution_step":
            node_data.setdefault("thought", "")
            node_data.setdefault("action", {})
            node_data.setdefault("observation", None)
            node_data.setdefault("status", "pending")
            node_data.setdefault("parent", None)
            node_data.setdefault("sequence", 0)
            node_data.setdefault("hypothesis_update", {})
        else:
            node_data.setdefault("metadata", {})

    def _is_valid_parent_for_subtask(self, parent_id: str, subtask_id: str) -> bool:
        if not self.graph.has_node(parent_id) or not self.graph.has_node(subtask_id):
            return False
        if parent_id == subtask_id:
            return True
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
                if edge_data.get("type") == "execution":
                    queue.append(successor)
        return False

    def _collect_execution_steps(self, subtask_id: str) -> List[str]:
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
        if not self.graph.has_node(subtask_id):
            return
        node_data = self.graph.nodes[subtask_id]
        if node_data.get("type") != "subtask":
            return
        node_data["execution_summary_cache"] = None
        node_data["execution_summary_last_sequence"] = 0
        node_data["execution_summary_updated_at"] = None

    def _get_execution_summary(self, subtask_id: str, refresh: bool = False) -> str:
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
                log_text.append(f"### 步骤 {idx} (ID: {step_id})\n- **状态:** Missing\n- **思考:** Node no longer exists in graph\n- **行动:** N/A\n- **观察:** Node was removed from graph")
                continue
            node_data = self.graph.nodes[step_id]
            action = node_data.get("action", {})
            observation = node_data.get("observation", {})
            observation_content = ""
            tool_name = action.get("tool")
            if tool_name == "think" and isinstance(observation, dict) and "recorded_thought" in observation:
                thought_data = observation["recorded_thought"]
                formatted_thought = ["上一步进行了结构化思考 (think):", f"  -分析 (Analysis): {thought_data.get('analysis', 'N/A')}", f"  -问题 (Problem): {thought_data.get('problem', 'N/A')}", f"  -结论 (Conclusion): {thought_data.get('conclusion', 'N/A')}"]
                observation_content = "\n".join(formatted_thought)
            elif tool_name == "formulate_hypotheses" and isinstance(observation, dict) and "hypotheses" in observation:
                hypotheses = observation["hypotheses"]
                formatted_hypotheses = ["上一步提出了新的攻击假设 (formulate_hypotheses):"]
                for h in hypotheses:
                    formatted_hypotheses.append(f"  - {h.get('description', 'N/A')} (置信度: {h.get('confidence', 'N/A')})")
                observation_content = "\n".join(formatted_hypotheses)
            elif tool_name == "reflect_on_failure" and isinstance(observation, dict) and "failure_analysis" in observation:
                analysis = observation["failure_analysis"]
                observation_content = f"上一步进行了失败反思 (reflect_on_failure):\n{json.dumps(analysis, indent=2, ensure_ascii=False)}"
            elif tool_name == "expert_analysis" and isinstance(observation, dict) and "expert_opinion" in observation:
                opinion = observation["expert_opinion"]
                observation_content = f"上一步获得了专家分析意见 (expert_analysis):\n{json.dumps(opinion, indent=2, ensure_ascii=False)}"
            else:
                hypothesis_update_data = node_data.get("hypothesis_update")
                if isinstance(hypothesis_update_data, dict):
                    summary = hypothesis_update_data.get("observation_summary")
                    if summary:
                        observation_content = summary
                if not observation_content:
                    observation_content = json.dumps(observation, ensure_ascii=False)
            log_text.append("\n".join([f"### 步骤 {idx} (ID: {step_id})", f"- **状态:** {node_data.get('status', 'N/A')}", f"- **思考:** {node_data.get('thought', '')}", f"- **行动:** {json.dumps(action, ensure_ascii=False)}", f"- **观察:** {observation_content}"]))
        summary = "\n".join(log_text)
        subtask_data["execution_summary_cache"] = summary
        subtask_data["execution_summary_last_sequence"] = latest_sequence
        subtask_data["execution_summary_updated_at"] = time.time()
        return summary

    def build_prompt_context(self, subtask_id: str) -> Dict[str, Any]:
        if not self.graph.has_node(subtask_id):
            raise NodeNotFoundError(f"子任务 {subtask_id} 不存在于图中。")
        self._ensure_node_defaults(subtask_id)
        subtask_data = self.graph.nodes[subtask_id]
        dependencies = []
        ancestors_in_order = list(nx.bfs_tree(self.graph.reverse(copy=True), source=subtask_id))
        for dep_id in ancestors_in_order:
            if dep_id == subtask_id:
                continue
            if self.graph.nodes[dep_id].get("type") == "subtask":
                dep_data = self.graph.nodes[dep_id]
                artifacts = list(dep_data.get("artifacts", []))
                nodes_produced: List[str] = []
                try:
                    for a in artifacts[:10]:
                        if isinstance(a, dict):
                            nodes_produced.append(a.get("id") or a.get("name") or a.get("type") or str(a))
                        else:
                            nodes_produced.append(str(a))
                except Exception:
                    pass
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
                if not failure_reason:
                    status_val = str(dep_data.get("status", "")).lower()
                    if status_val.startswith("failed") or status_val == "failed":
                        failure_reason = dep_data.get("reflection") or summary_text
                dep_execution_summary = self._get_execution_summary(dep_id)
                dependencies.append({
                    "id": dep_id,
                    "status": dep_data.get("status"),
                    "summary": summary_text,
                    "artifacts": artifacts,
                    "task_id": dep_id,
                    "description": dep_data.get("description"),
                    "key_findings": key_findings,
                    "failure_reason": failure_reason,
                    "nodes_produced": nodes_produced,
                    "execution_summary": dep_execution_summary,
                })
        execution_summary = self._get_execution_summary(subtask_id)
        causal_context = self.get_relevant_causal_context(subtask_id)
        current_key_facts = []
        for node_id, data in self.causal_graph.nodes(data=True):
            if data.get("type") == "key_fact":
                current_key_facts.append(data.get("description", ""))
        return {
            "task_id": self.task_id,
            "key_facts": current_key_facts,
            "causal_context": causal_context,
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
        confirmed_vulns = [n for n, d in self.causal_graph.nodes(data=True) if d.get("node_type") == "ConfirmedVulnerability"]
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
        simplified_graph = nx.DiGraph()
        success_trigger_node = self._find_success_trigger_node()
        if not success_trigger_node:
            return {"nodes": [], "edges": []}
        successful_path_nodes = {success_trigger_node}.union(nx.ancestors(self.graph, success_trigger_node))
        self._add_simplified_nodes(simplified_graph, successful_path_nodes)
        self._add_simplified_edges(simplified_graph, successful_path_nodes)
        return json_graph.node_link_data(simplified_graph)

    def get_descendants(self, node_id: str) -> set:
        if not self.graph.has_node(node_id):
            return set()
        return nx.descendants(self.graph, node_id)

    def is_goal_achieved(self) -> bool:
        for node_id, data in self.graph.nodes(data=True):
            if str(data.get("status", "")).upper() == "GOAL_ACHIEVED":
                logging.debug(f"Goal achieved: Node {node_id} has status GOAL_ACHIEVED.")
                return True
        
        for node_id, data in self.causal_graph.nodes(data=True):
            if str(data.get("status", "")).upper() == "GOAL_ACHIEVED":
                logging.debug(f"Goal achieved: Causal node {node_id} has status GOAL_ACHIEVED.")
                return True

        return False