#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LuaN1ao Agent - 基于大模型的自主渗透测试系统主控入口.

本模块实现了P-E-R (Planner-Executor-Reflector) 架构的核心控制逻辑,
通过协调规划器、执行器和反思器三个组件,实现自动化的渗透测试任务执行。

主要功能:
    - 任务初始化与配置管理
    - P-E-R循环控制与协调
    - 图谱管理与状态追踪
    - 指标收集与日志记录
    - Web可视化服务(可选)

典型用法:
    python agent.py --goal "测试目标应用的安全性" --task-name "web_pentest"

作者: LuaN1ao Team
许可: MIT License
"""

# agent.py
# LuaN1ao Agent 主控入口 (P-E-R 架构)
import json
import os
import sys
import uuid
import time
import asyncio
import argparse
import tempfile
import copy
from collections import defaultdict
from datetime import datetime
from typing import List, Dict, Any, Optional
import httpx
import subprocess
import psutil

from rich.console import Console
from rich.panel import Panel

from core.console import set_console, init_console_with_file, console_proxy as console
from llm.llm_client import LLMClient
from tools.mcp_client import initialize_sessions, close_async_sessions
from core.graph_manager import GraphManager
from core.planner import Planner
from core.reflector import Reflector
from core.executor import run_executor_cycle
from core.data_contracts import PlannerContext, ReflectorContext
from tools import mcp_service
from core.tool_manager import tool_manager
from core.intervention import intervention_manager
from conf.config import (
    PLANNER_HISTORY_WINDOW,
    REFLECTOR_HISTORY_WINDOW,
    WEB_HOST as DEFAULT_WEB_HOST,
    WEB_PORT as DEFAULT_WEB_PORT,
    KNOWLEDGE_SERVICE_PORT,
    KNOWLEDGE_SERVICE_URL,
    KNOWLEDGE_SERVICE_HOST,
    OUTPUT_MODE,
    HUMAN_IN_THE_LOOP,
    GLOBAL_MAX_CYCLES,
    GLOBAL_MAX_TOKEN_USAGE
)
from core.events import broker
try:
    from web.server import register_graph
except Exception:
    register_graph = None

from core.console import sanitize_for_rich
import core.database.utils
import signal
from core.database.utils import add_log, schedule_coroutine

def signal_handler(sig, frame):
    """Handle termination signals to ensure logs are saved via finally block."""
    try:
        # Use direct console print as Rich might be interrupted/locked
        print(f"\n[Agent] Received signal {sig}, initiating graceful shutdown...")
    except Exception:
        pass
    sys.exit(0)

def generate_task_id() -> str:
    """
    生成唯一任务ID
    
    Returns:
        格式为 "task_{timestamp}_{uuid_prefix}" 的唯一任务标识符
    """
    return f"task_{int(time.time())}_{str(uuid.uuid4())[:8]}"

class KnowledgeServiceManager:
    """知识服务生命周期管理器 (Context Manager & Singleton pattern)"""
    
    def __init__(self, console: Console):
        self.console = console
        self.process: Optional[subprocess.Popen] = None
        self._lock = asyncio.Lock()
        
    async def _check_health(self) -> bool:
        """检查知识服务是否运行并且健康。"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(f"{KNOWLEDGE_SERVICE_URL}/health", timeout=2)
                if response.status_code == 200 and response.json().get("status") == "healthy":
                    return True
                else:
                    self.console.print(f"[bold yellow]⚠️ 知识服务响应不健康: {response.status_code} - {response.text}[/bold yellow]")
                    return False
        except httpx.RequestError:
            return False

    async def start(self) -> bool:
        """启动知识服务"""
        async with self._lock:
            # 1. 检查是否已健康运行
            if await self._check_health():
                self.console.print("[bold green]✅ 知识服务已运行并健康。[/bold green]")
                return True

            self.console.print("[bold blue]🚀 启动知识服务...[/bold blue]")

            # 2. 检查端口占用
            import socket
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            port_in_use = sock.connect_ex((KNOWLEDGE_SERVICE_HOST, KNOWLEDGE_SERVICE_PORT)) == 0
            sock.close()

            if port_in_use:
                self.console.print(f"[bold yellow]⚠️ 端口 {KNOWLEDGE_SERVICE_PORT} 已被占用，尝试清理...[/bold yellow]")
                # 简单尝试清理占用端口的进程 (仅限 uvicorn)
                try:
                    for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
                        try:
                            for conn in proc.connections(kind='inet'):
                                if conn.laddr.port == KNOWLEDGE_SERVICE_PORT:
                                    cmdline = proc.info['cmdline']
                                    if cmdline and "uvicorn" in " ".join(cmdline) and "knowledge_service" in " ".join(cmdline):
                                        self.console.print(f"[dim]终止旧的服务进程 PID: {proc.info['pid']}[/dim]")
                                        proc.terminate()
                                        proc.wait(timeout=3)
                        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                            pass
                except Exception as e:
                    self.console.print(f"[dim]清理端口失败: {e}[/dim]")

            # 3. 启动新进程
            command = [
                sys.executable, "-m", "uvicorn", "rag.knowledge_service:app",
                "--host", "0.0.0.0", "--port", str(KNOWLEDGE_SERVICE_PORT)
            ]
            
            try:
                log_pout = open(os.path.join(tempfile.gettempdir(), 'knowledge_service.log'), 'w')
                self.process = subprocess.Popen(
                    command,
                    stdout=log_pout,
                    stderr=subprocess.STDOUT,
                    start_new_session=True # 脱离当前进程组
                )
                self.console.print(f"[bold green]启动知识服务进程 (PID: {self.process.pid})[/bold green]")
                
                # 等待服务启动
                for _ in range(10):  # 最多等待 10*0.5 = 5秒
                    await asyncio.sleep(0.5)
                    if await self._check_health():
                        return True
                        
                self.console.print("[bold red]❌ 知识服务启动超时。[/bold red]")
                return False
            except Exception as e:
                self.console.print(f"[bold red]❌ 知识服务启动失败: {e}[/bold red]")
                return False

    def stop(self):
        """关闭知识服务"""
        if self.process:
            self.console.print(f"[dim]停止知识服务 (PID: {self.process.pid})...[/dim]")
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
            self.process = None

# 全局单例管理器
knowledge_manager: Optional[KnowledgeServiceManager] = None

async def ensure_knowledge_service(console: Console) -> bool:
    """外部调用的快捷方法"""
    global knowledge_manager
    if not knowledge_manager:
        knowledge_manager = KnowledgeServiceManager(console)
    return await knowledge_manager.start()

async def stop_knowledge_service():
    """外部调用的快捷逻辑"""
    global knowledge_manager
    if knowledge_manager:
        knowledge_manager.stop()


def _aggregate_intelligence(completed_reflections: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """
    汇总多个反思器输出为情报摘要.

    将多个子任务的反思结果汇总为统一的情报摘要，优先处理已达成目标的状态
    和目标产物类型的artifacts。对 findings/artifacts/insights 进行去重，
    避免并行子任务发现相同信息时在 Planner 上下文中重复出现。

    Args:
        completed_reflections: 已完成的反思结果字典，key为子任务ID，value为反思输出

    Returns:
        Dict[str, Any]: 汇总的情报摘要，包含findings、audit_result、artifacts等字段
    """
    all_findings = []
    all_artifacts = []
    all_insights = []
    seen_finding_keys: set = set()
    seen_artifact_keys: set = set()
    seen_insight_keys: set = set()

    # 检查是否有任何反思结果标记了 goal_achieved
    goal_achieved = False
    aggregated_completion_check = f'汇总了 {len(completed_reflections)} 个任务的审计结果'
    for subtask_id, reflection in completed_reflections.items():
        # 从 reflection 提取所需字段
        audit_result = reflection.get('audit_result', {})
        if _is_goal_achieved_status(audit_result.get('status')):
            goal_achievement_reason = audit_result.get('completion_check', 'Unknown reason for goal_achieved')
            console.print(
                f"🔍 Aggregator: 检测到子任务 {subtask_id} 报告 goal_achieved: {goal_achievement_reason}",
                style="bold green"
            )
            goal_achieved = True
            aggregated_completion_check = goal_achievement_reason

        # 提取 key_findings（基于前80字符去重）
        for finding in reflection.get('key_findings', []):
            key = str(finding)[:80]
            if key not in seen_finding_keys:
                seen_finding_keys.add(key)
                all_findings.append(finding)

        # 提取 validated_nodes（基于节点 id 去重）
        for node in reflection.get('validated_nodes', []):
            node_key = node.get('id', str(node)[:80]) if isinstance(node, dict) else str(node)[:80]
            if node_key not in seen_artifact_keys:
                seen_artifact_keys.add(node_key)
                all_artifacts.append(node)

        # 提取 insight（基于内容前80字符去重）
        insight = reflection.get('insight')
        if insight:
            insight_key = str(insight)[:80]
            if insight_key not in seen_insight_keys:
                seen_insight_keys.add(insight_key)
                all_insights.append(insight)

    # 构建汇总的情报摘要
    aggregated_status = 'goal_achieved' if goal_achieved else 'AGGREGATED'
    intelligence_summary = {
        'findings': all_findings,
        'audit_result': {
            'status': aggregated_status,
            'completion_check': aggregated_completion_check
        },
        'artifacts': all_artifacts,
        'insight': {
            'type': 'aggregated',
            'insights': all_insights
        }
    }

    return intelligence_summary


def _is_goal_achieved_status(status: Any) -> bool:
    """兼容 legacy 状态值，统一识别 goal_achieved。"""
    return str(status or "").strip().lower() == "goal_achieved"

def process_graph_commands(operations: List[Dict], graph_manager: GraphManager) -> None:
    """
    处理图操作指令列表. 
    
    优化操作执行顺序，先添加节点，再删除/废弃节点，最后更新节点，
    避免对已删除节点进行操作，确保图谱状态的一致性。
    
    Args:
        operations: 图操作指令列表，每个操作包含command和相关参数
        graph_manager: 图谱管理器实例
    
    Returns:
        None
    """
    # 定义系统标准状态
    VALID_STATUSES = {'pending', 'in_progress', 'completed', 'failed', 'blocked', 'deprecated', 'stalled_orphan', 'completed_error'}

    # 预处理：去重 ADD_NODE（按 node_id）
    seen_add_ids = set()
    add_ops = []
    for op in operations:
        if op.get("command") == "ADD_NODE":
            node_data = op.get("node_data", {})
            node_id = node_data.get('id')
            if not node_id or node_id == "None":
                console.print(f"⚠️  跳过无效的 ADD_NODE 操作（缺少 node_id）: {node_data}", style="yellow")
                continue
            if node_id in seen_add_ids:
                console.print(f"⚠️  检测到重复的 ADD_NODE 操作，已去重: {node_id}", style="yellow")
                continue
            seen_add_ids.add(node_id)
            add_ops.append(op)

    delete_ops = [op for op in operations if op.get("command") == "DELETE_NODE"]
    deprecate_ops = [op for op in operations if op.get("command") == "DEPRECATE_NODE"]  # 处理废弃操作
    update_ops = [op for op in operations if op.get("command") == "UPDATE_NODE"]

    deleted_node_ids = set()

    # 1. 首先执行所有 ADD_NODE 操作（已去重）
    for op in add_ops:
        node_data = op.get("node_data", {})
        node_id = node_data.get('id')

        # 防御性检查：跳过没有有效 ID 的节点
        if not node_id or node_id == "None":
            console.print(f"⚠️  跳过无效的 ADD_NODE 操作（缺少 node_id）: {node_data}", style="yellow")
            continue
        # 如果节点已存在，避免重复添加，改为 UPDATE_NODE 合并属性
        if graph_manager.graph.has_node(node_id):
            updates = {k: v for k, v in node_data.items() if k not in {"id", "dependencies"}}
            if updates:
                graph_manager.update_node(node_id, updates)
            else:
                console.print(f"⚠️ 节点已存在且无可更新字段，跳过 ADD_NODE: {node_id}", style="yellow")
            continue

        graph_manager.add_subtask_node(
            node_id,
            node_data.get('description'),
            node_data.get('dependencies', []),
            node_data.get('priority', 1),
            reason=node_data.get('reason', ''),
            completion_criteria=node_data.get('completion_criteria', ''),
            mission_briefing=node_data.get('mission_briefing')
        )

    # ADD_NODE 完成后校验 DAG 完整性：检测环形依赖
    import networkx as nx
    subtask_subgraph_nodes = [
        n for n, d in graph_manager.graph.nodes(data=True)
        if d.get('type') in ('task', 'subtask')
    ]
    subgraph = graph_manager.graph.subgraph(subtask_subgraph_nodes)
    if not nx.is_directed_acyclic_graph(subgraph):
        try:
            cycles = list(nx.simple_cycles(subgraph))
        except Exception:
            cycles = ["（无法枚举）"]
        console.print(
            f"🚨 [DAG 校验] 检测到任务图中存在环形依赖，可能导致所有子任务永久阻塞！\n"
            f"   涉及环路: {cycles}",
            style="bold red"
        )

    # 2. 然后执行所有 DELETE/DEPRECATE 操作，将其状态更新为 deprecated
    for op in delete_ops + deprecate_ops:
        node_id = op.get("node_id")
        if node_id:
            # [CRITICAL] 保护已完成节点，禁止废弃
            if graph_manager.graph.has_node(node_id):
                current_status = graph_manager.graph.nodes[node_id].get('status')
                if current_status == 'completed':
                    console.print(
                        f"⚠️  [状态保护] 禁止废弃已完成节点 {node_id}（Reflector 判定已完成，状态不可逆）。",
                        style="bold yellow"
                    )
                    continue
            reason = op.get("reason", "未提供原因")
            graph_manager.update_node(node_id, {"status": "deprecated", "summary": f"任务已被规划器废弃。原因: {reason}"})
            deleted_node_ids.add(node_id)

    # 3. 最后执行所有 UPDATE_NODE 操作，但跳过已删除的节点
    for op in update_ops:
        node_id = op.get("node_id")
        if node_id and node_id not in deleted_node_ids:
            updates = op.get("updates", {})

            # 检查节点是否存在，避免KeyError
            if not graph_manager.graph.has_node(node_id):
                console.print(f"⚠️ 尝试更新不存在的节点 {node_id}，跳过操作。", style="yellow")
                continue

            # 状态验证：检查并修正非法状态值
            if 'status' in updates:
                status = updates['status']
                current_node_status = graph_manager.graph.nodes[node_id].get('status')

                # [CRITICAL] 严禁将 completed 状态改为 deprecated
                # 这会破坏因果链和Reflector的判断权威性
                if current_node_status == 'completed' and status == 'deprecated':
                    console.print(
                        f"⚠️  [状态保护] Planner 试图将已完成任务 {node_id} 标记为 'deprecated'。",
                        style="bold yellow"
                    )
                    console.print(
                        f"   📋 原因: Reflector已判定此任务目标达成，状态不可逆转。",
                        style="yellow"
                    )
                    console.print(
                        f"   💡 建议: 若需补充，请创建新任务并依赖于 {node_id}。",
                        style="cyan"
                    )
                    # 移除状态更新，保持 completed 状态
                    del updates['status']
                    # 记录到节点的警告信息中
                    node_warnings = graph_manager.graph.nodes[node_id].get('warnings', [])
                    node_warnings.append(
                        f"[时间戳 {time.time()}] Planner尝试将completed状态改为deprecated，已被拒绝"
                    )
                    graph_manager.graph.nodes[node_id]['warnings'] = node_warnings
                # 如果当前状态是终结状态，且Planner试图将其重置为非终结状态，则忽略并警告
                elif current_node_status in {'failed', 'deprecated', 'stalled_orphan', 'completed_error'} and status not in {'completed', 'failed', 'deprecated', 'stalled_orphan', 'completed_error'}:
                    console.print(
                        f"⚠️  Planner 试图将已处于终结状态 '{current_node_status}' 的节点 {node_id} 重置为 '{status}'。此操作已被忽略。",
                        style="yellow"
                    )
                    # 移除状态更新，保持原终结状态
                    del updates['status']
                elif status not in VALID_STATUSES:
                    # 记录错误日志到节点本身
                    original_status = status
                    updates['status'] = 'pending'
                    # 如果节点存在，尝试添加警告信息
                    if graph_manager.graph.has_node(node_id):
                        node_warnings = graph_manager.graph.nodes[node_id].get('warnings', [])
                        node_warnings.append(f"检测到非法状态 '{original_status}'，已在时间戳 {time.time()} 修正为 'pending'")
                        graph_manager.graph.nodes[node_id]['warnings'] = node_warnings
                    console.print(
                        f"⚠️  检测到非法状态值 '{original_status}' (节点 {node_id})，自动修正为 'pending'",
                        style="yellow"
                    )
                    console.print(
                        f"   合法状态值: {', '.join(sorted(VALID_STATUSES))}",
                        style="dim"
                    )

            graph_manager.update_node(node_id, updates)
        elif node_id in deleted_node_ids:
            console.print(f"⚠️ 尝试更新已删除的节点 {node_id}，操作已跳过。", style="yellow")

    # 处理 ADD_NODE 操作的状态检查
    for op in add_ops:
        node_data = op.get("node_data", {})
        node_id = node_data.get('id')
        if node_data.get('status') and node_data['status'] not in VALID_STATUSES:
            original_status = node_data['status']
            node_data['status'] = 'pending'  # 修正新节点的非法状态
            console.print(
                f"⚠️  ADD_NODE 操作中检测到非法初始状态值 '{original_status}' (节点 {node_id})，自动修正为 'pending'",
                style="yellow"
            )
            if graph_manager.graph.has_node(node_id):
                node_warnings = graph_manager.graph.nodes[node_id].get('warnings', [])
                node_warnings.append(f"检测到非法初始状态 '{original_status}'，已在时间戳 {time.time()} 修正为 'pending'")
                graph_manager.graph.nodes[node_id]['warnings'] = node_warnings

    # 处理未知指令
    for op in operations:
        command = op.get("command")
        if command not in ["ADD_NODE", "DELETE_NODE", "UPDATE_NODE", "DEPRECATE_NODE"]:
            console.print(f"❌ 未知的图指令: {command}", style="red")

def validate_causal_graph_updates(
    updates: Dict[str, List[Dict]],
    graph_manager: GraphManager,
    subtask_id: Optional[str] = None
) -> Dict[str, List[Dict]]:
    """
    校验因果图谱更新的完整性. 
    
    在应用更新前检查因果链图谱更新的合法性，确保所有边引用的节点都存在。
    如果边引用的是当前子任务的暂存节点，自动将该节点提升到本次更新中。
    
    Args:
        updates: 包含nodes和edges的因果图更新字典
        graph_manager: 图谱管理器实例
        subtask_id: 当前子任务ID（可选）
    
    Returns:
        Dict[str, List[Dict]]: 验证后的更新字典，包含有效的nodes和edges
    """
    if not updates or not isinstance(updates, dict):
        return {"nodes": [], "edges": []}

    nodes_to_add = list(updates.get("nodes", []) or [])
    edges_to_add = list(updates.get("edges", []) or [])

    # 1. 收集所有有效节点ID：已有因果图节点 + 本次新增节点
    existing_node_ids = set(graph_manager.causal_graph.nodes)
    nodes_to_add_ids = {n.get("id") for n in nodes_to_add if n.get("id")}

    # 2. 收集暂存节点（仅当前子任务，若提供）以支持自动提升
    staged_nodes_by_id: Dict[str, Dict] = {}
    if subtask_id and graph_manager.graph.has_node(subtask_id):
        try:
            staged_list = graph_manager.graph.nodes[subtask_id].get("staged_causal_nodes", []) or []
            for sn in staged_list:
                sid = sn.get("id")
                if isinstance(sid, str) and sid:
                    staged_nodes_by_id[sid] = sn
        except Exception:
            # 保守处理，不影响后续验证
            staged_nodes_by_id = {}

    # 3. 对边进行预检查；若缺失端点恰好存在于暂存节点，则将其自动加入 nodes_to_add
    auto_promoted_count = 0
    for edge in edges_to_add:
        for endpoint_key in ("source_id", "target_id"):
            endpoint_id = edge.get(endpoint_key)
            if not endpoint_id or not isinstance(endpoint_id, str):
                continue
            # 已存在或已在待新增集合中则跳过
            if endpoint_id in existing_node_ids or endpoint_id in nodes_to_add_ids:
                continue
            # 尝试从暂存节点中提升
            staged_node = staged_nodes_by_id.get(endpoint_id)
            if staged_node:
                nodes_to_add.append(staged_node)
                nodes_to_add_ids.add(endpoint_id)
                auto_promoted_count += 1

    if auto_promoted_count:
        console.print(f"🔧  自动提升 {auto_promoted_count} 个暂存节点以满足边引用（先建节点后建边）", style="cyan")

    # 4. 重新计算有效ID集合并过滤边
    valid_temp_node_ids = existing_node_ids.union(nodes_to_add_ids)
    validated_edges: List[Dict] = []
    for edge in edges_to_add:
        source_id = edge.get("source_id")
        target_id = edge.get("target_id")
        source_is_valid = source_id in valid_temp_node_ids
        target_is_valid = target_id in valid_temp_node_ids
        if source_is_valid and target_is_valid:
            validated_edges.append(edge)
        else:
            console.print(f"⚠️  [校验] 丢弃无效的因果链边，节点不存在: {source_id} -> {target_id}", style="yellow")

    return {"nodes": nodes_to_add, "edges": validated_edges}

def process_causal_graph_commands(
    updates: Dict[str, List[Dict]],
    graph_manager: GraphManager,
    subtask_id: Optional[str] = None,
) -> Dict[str, str]:
    """
    处理因果图谱的结构化更新. 
    
    先处理所有节点添加，再处理边的添加，并维护临时ID到永久ID的映射。
    
    Args:
        updates: 包含nodes和edges的更新字典
        graph_manager: 图谱管理器实例
    
    Returns:
        Dict[str, str]: 临时ID到永久ID的映射字典
    """
    node_id_map = {}  # Maps the Reflector's temporary ID to the GraphManager's permanent ID

    nodes_to_add = updates.get("nodes", [])
    edges_to_add = updates.get("edges", [])

    # 1. 首先处理所有节点添加
    for node_data in nodes_to_add:
        temp_id = node_data.get("id")
        if subtask_id and isinstance(node_data, dict):
            source_step_id = node_data.get("source_step_id")
            if isinstance(source_step_id, str) and source_step_id.strip():
                node_data = dict(node_data)
                node_data["source_step_id"] = graph_manager.resolve_source_step_id(
                    source_step_id, subtask_id=subtask_id
                )
        if temp_id:
            # The add_causal_node method creates a deterministic ID
            permanent_id = graph_manager.add_causal_node(node_data)
            node_id_map[temp_id] = permanent_id

    # 2. 然后处理所有边的添加
    for edge_data in edges_to_add:
        source_temp_id = edge_data.get("source_id")
        target_temp_id = edge_data.get("target_id")

        # Translate temporary IDs to permanent IDs
        source_perm_id = node_id_map.get(source_temp_id)
        target_perm_id = node_id_map.get(target_temp_id)

        # If an ID is not in the map, it might be an existing node's permanent ID
        if not source_perm_id:
            source_perm_id = source_temp_id
        if not target_perm_id:
            target_perm_id = target_temp_id

        if source_perm_id and target_perm_id:
            label = edge_data.pop("label", "SUPPORTS")
            evidence_strength = edge_data.pop("evidence_strength", None)  # LLM 输出的证据强度
            graph_manager.add_causal_edge(source_perm_id, target_perm_id, label, **edge_data)
            # Trigger confidence propagation with LLM-driven evidence strength
            graph_manager.update_hypothesis_confidence(
                target_perm_id, 
                label,
                evidence_strength=evidence_strength
            )
        else:
            console.print(f"⚠️  无法创建因果链关系边，源或目标ID未找到: {source_temp_id} -> {target_temp_id}", style="yellow")

    return node_id_map

def save_logs(
    log_dir: str,
    metrics: Dict,
    run_log: List,
    final_save: bool = False
) -> None:
    """
    保存指标和运行日志的快照.

    
    Args:
        log_dir: 日志目录路径
        metrics: 指标字典
        run_log: 运行日志列表
        final_save: 是否为最终保存，默认False
    
    Returns:
        None
    """
    # Always update total time
    metrics["total_time_seconds"] = time.time() - metrics["start_time"]

    if final_save:
        metrics["end_time"] = time.time()

    # Create a deep copy for serialization to avoid issues with defaultdict
    # Sanitize any problematic characters in metrics before JSON serialization
    metrics_copy = json.loads(json.dumps(metrics, ensure_ascii=False))
    if "tool_calls" in metrics_copy:
        metrics_copy["tool_calls"] = dict(metrics["tool_calls"])

    # Merge with existing metrics on disk to prevent overwriting with stale/lower values
    # This is critical because parallel threads (executor) might have written fresher data
    try:
        metrics_path = os.path.join(log_dir, "metrics.json")
        if os.path.exists(metrics_path):
            with open(metrics_path, 'r', encoding='utf-8') as f:
                existing_metrics = json.load(f)
            
            # Key metrics that must be monotonic
            monotonic_keys = ["cost_cny", "total_tokens", "prompt_tokens", "completion_tokens"]
            for key in monotonic_keys:
                existing_val = existing_metrics.get(key, 0)
                new_val = metrics_copy.get(key, 0)
                if isinstance(existing_val, (int, float)) and isinstance(new_val, (int, float)):
                    if existing_val > new_val:
                        metrics_copy[key] = existing_val
                        
            # Also restore success flags if they were present on disk but missing/false in memory
            # (e.g. if updated by a parallel monitor)
            if existing_metrics.get("success") and not metrics_copy.get("success"):
                metrics_copy["success"] = True
                metrics_copy["status"] = existing_metrics.get("status", metrics_copy.get("status"))
                if "flags" in existing_metrics:
                    metrics_copy["flags"] = existing_metrics["flags"]

        # Use atomic write via temp file
        metrics_tmp = metrics_path + ".tmp"
        with open(metrics_tmp, 'w', encoding='utf-8', errors='replace') as f:
            json.dump(metrics_copy, f, ensure_ascii=False, indent=4)
        os.replace(metrics_tmp, metrics_path)

        run_log_path = os.path.join(log_dir, "run_log.json")
        run_log_tmp = run_log_path + ".tmp"
        with open(run_log_tmp, 'w', encoding='utf-8', errors='replace') as f:
            json.dump(run_log, f, ensure_ascii=False, indent=4)
        os.replace(run_log_tmp, run_log_path)
    except Exception as e:
        console.print(f"[bold red]Error saving logs: {e}[/bold red]")

    if final_save:
        console.print(Panel(f"Final logs and metrics saved to {log_dir}", title="[bold green]Run Finished[/bold green]"))

def update_global_metrics(global_metrics: Dict, cycle_metrics: Dict):
    """
    更新全局指标。
    """
    # Fix: cycle_metrics might not have total_tokens, calculate from parts
    cycle_prompt = cycle_metrics.get("prompt_tokens", 0)
    cycle_completion = cycle_metrics.get("completion_tokens", 0)
    cycle_total = cycle_metrics.get("total_tokens", cycle_prompt + cycle_completion)
    
    global_metrics["total_tokens"] += cycle_total
    global_metrics["prompt_tokens"] += cycle_prompt
    global_metrics["completion_tokens"] += cycle_completion
    global_metrics["cost_cny"] += cycle_metrics.get("cost_cny", 0)
    
    # 累加步数（根据 cycle_metrics 中的类型）
    if "execution_steps" in cycle_metrics:
        global_metrics["execution_steps"] += cycle_metrics["execution_steps"]
    if "plan_steps" in cycle_metrics:
        global_metrics["plan_steps"] += cycle_metrics["plan_steps"]
    if "reflect_steps" in cycle_metrics:
        global_metrics["reflect_steps"] += cycle_metrics["reflect_steps"]
        
    # Fix: tool_calls is a dict, cannot use +=
    if "tool_calls" in cycle_metrics:
        if "tool_calls" not in global_metrics:
            global_metrics["tool_calls"] = defaultdict(int)
        for tool, count in cycle_metrics["tool_calls"].items():
            global_metrics["tool_calls"][tool] += count
    
    # 记录其他特定指标
    if "artifacts_found" in cycle_metrics:
        global_metrics["artifacts_found"] = cycle_metrics["artifacts_found"]
    if "causal_graph_nodes" in cycle_metrics:
        global_metrics["causal_graph_nodes"] = cycle_metrics["causal_graph_nodes"]

def update_reflector_context_after_reflection(reflector_context, reflection_output, subtask_id, status, graph_manager):
    """在反思完成后更新ReflectorContext状态"""
    from core.data_contracts import ReflectionInsight

    audit_result = reflection_output.get('audit_result', {})
    key_findings = reflection_output.get('key_findings', [])

    # 确保key_findings是字符串列表
    def _ensure_string_findings(findings):
        if not findings:
            return []

        string_findings = []
        for finding in findings:
            if isinstance(finding, str):
                string_findings.append(finding)
            elif isinstance(finding, dict):
                # 尝试从字典中提取文本内容
                if 'description' in finding:
                    string_findings.append(finding['description'])
                elif 'text' in finding:
                    string_findings.append(finding['text'])
                elif 'finding' in finding:
                    string_findings.append(finding['finding'])
                else:
                    # 作为最后手段，转换为字符串
                    string_findings.append(str(finding))
            else:
                string_findings.append(str(finding))
        return string_findings

    safe_key_findings = _ensure_string_findings(key_findings)

    # 创建反思洞察
    insight = ReflectionInsight(
        timestamp=time.time(),
        subtask_id=subtask_id,
        normalized_status=status,
        key_insight="; ".join(safe_key_findings) if safe_key_findings else "No key insights",
        failure_pattern=_extract_failure_pattern(audit_result, safe_key_findings),
        full_reflection_report=reflection_output,
        llm_reflection_prompt=reflection_output.get('llm_reflection_prompt'),
        llm_reflection_response=json.dumps(reflection_output, ensure_ascii=False, indent=2)
    )

    # 添加到反思日志
    reflector_context.add_insight(insight)

    return reflector_context

def _extract_failure_pattern(audit_result, key_findings):
    """从审计结果和关键发现中提取失败模式"""
    status = audit_result.get('status', '')

    if status in ['FAILED', 'PARTIAL_SUCCESS']:
        # 尝试从关键发现中提取模式
        for finding in key_findings:
            if any(pattern in finding for pattern in ['HTTP_', 'timeout', 'connection refused', 'permission denied']):
                return finding

    return None

async def compress_planner_context_if_needed(
    planner_context: "PlannerContext", 
    llm: "LLMClient", 
    metrics: Optional[Dict] = None
) -> None:
    """
    如果 Planner 历史过长，进行总结压缩。
    """
    if not getattr(planner_context, "_needs_compression", False):
        return

    console.print(f"🔄 Planner 对话历史过长，开始进行状态压缩总结...", style="dim")
    
    # 将 history 转换为文本列表供总结使用
    history_to_compress = []
    for attempt in planner_context.planning_history:
        record = f"Strategy: {attempt.strategy}\nGoal: {attempt.goal}\nOutcome: {attempt.outcome_summary}"
        history_to_compress.append({"role": "assistant", "content": record})
    
    summary, summarization_metrics = await llm.summarize_conversation(history_to_compress)
    
    # 累加指标
    if metrics is not None and summarization_metrics:
        update_global_metrics(metrics, summarization_metrics)

    planner_context.compressed_history_summary = summary
    planner_context.compression_count += 1
    
    # 保持窗口大小并重置标志
    planner_context.planning_history = planner_context.planning_history[-PLANNER_HISTORY_WINDOW:]
    planner_context._needs_compression = False
    
    console.print(f"✅ Planner 上下文压缩完成 (次数: {planner_context.compression_count})", style="dim")

async def compress_reflector_context_if_needed(
    reflector_context: "ReflectorContext", 
    llm: "LLMClient", 
    metrics: Optional[Dict] = None
) -> None:
    """
    如果 Reflector 历史过长，进行总结压缩。
    """
    if not getattr(reflector_context, "_needs_compression", False):
        return

    console.print(f"🔄 Reflector 对话历史过长，开始进行模式压缩总结...", style="dim")
    
    # 将 reflection_log 转换
    history_to_compress = []
    for insight in reflector_context.reflection_log:
        record = f"Subtask: {insight.subtask_id}\nStatus: {insight.normalized_status}\nInsight: {insight.key_insight}"
        history_to_compress.append({"role": "assistant", "content": record})
    
    summary, summarization_metrics = await llm.summarize_conversation(history_to_compress)
    
    # 累加指标
    if metrics is not None and summarization_metrics:
        update_global_metrics(metrics, summarization_metrics)

    reflector_context.compressed_reflection_summary = summary
    reflector_context.compression_count += 1
    
    # 保持窗口大小并重置标志
    reflector_context.reflection_log = reflector_context.reflection_log[-REFLECTOR_HISTORY_WINDOW:]
    reflector_context._needs_compression = False
    
    console.print(f"✅ Reflector 上下文压缩完成 (次数: {reflector_context.compression_count})", style="dim")

def verify_and_handle_orphans(operations: List[Dict], graph_manager: GraphManager, console: Console) -> List[Dict]:
    """
    在执行图操作前，验证Planner是否正确处理了孤儿节点。
    如果没有，则自动生成修复指令，作为代码级安全网。
    """
    # 找出所有将被废弃的节点ID
    deprecated_node_ids = set()
    for op in operations:
        if op.get("command") == "UPDATE_NODE" and op.get("updates", {}).get("status") == "deprecated":
            deprecated_node_ids.add(op.get("node_id"))
        elif op.get("command") == "DELETE_NODE": # 兼容旧的或直接的删除指令
            deprecated_node_ids.add(op.get("node_id"))

    if not deprecated_node_ids:
        return operations

    # 找出所有即将成为孤儿的节点
    potential_orphans = {}
    # 使用 list(graph_manager.graph.nodes(data=True)) 避免在遍历时修改图
    for node_id, data in list(graph_manager.graph.nodes(data=True)):
        if data.get('type') != 'subtask':
            continue

        dependencies = [u for u, v in graph_manager.graph.in_edges(node_id) if graph_manager.graph.edges[u, v].get('type') == 'dependency']
        # 如果一个节点的某个依赖在待废弃列表里
        orphaned_by_parents = [dep for dep in dependencies if dep in deprecated_node_ids]

        if orphaned_by_parents:
            potential_orphans[node_id] = orphaned_by_parents

    if not potential_orphans:
        return operations

    # 检查Planner是否已经处理了这些孤儿
    handled_orphans = set()
    for op in operations:
        if op.get('command') in ['UPDATE_NODE', 'DELETE_NODE']:
            if op.get('node_id') in potential_orphans:
                handled_orphans.add(op.get('node_id'))

    # 对未被处理的孤儿，生成修复指令
    fix_operations = []
    for orphan_id, deleted_parents in potential_orphans.items():
        if orphan_id not in handled_orphans:
            # 新的修复策略：将孤儿节点标记为停滞状态，而不是重新连接
            fix_op = {
                "command": "UPDATE_NODE",
                "node_id": orphan_id,
                "updates": {
                    "status": "stalled_orphan",
                    "summary": f"Dependency on {deleted_parents} was removed by the Planner without providing a new dependency."
                }
            }
            fix_operations.append(fix_op)
            console.print(Panel(f"检测到Planner未处理的孤儿节点 [bold yellow]{orphan_id}[/bold yellow]。自动生成修复指令，将其状态更新为 'stalled_orphan'。", title="⚠️ [bold red]代码级修复[/bold red]", style="purple"))

    return operations + fix_operations

def get_next_executable_subtask_batch(graph: GraphManager) -> List[str]:
    """获取下一个可并行执行的任务批次。

    注：`in_progress` 状态不纳入调度候选。正常执行流程中，asyncio.gather
    完成后所有子任务均会进入 Reflection 并更新状态；`in_progress` 仅在
    进程异常崩溃重启后可能残留，此时应在启动恢复逻辑中将其重置为 `pending`，
    而非在正常调度中重新入队（避免重复执行）。
    """
    executable_tasks = []
    for node, data in graph.graph.nodes(data=True):
        if data.get('type') != 'subtask':
            continue
        if data.get('status') not in ('pending', 'ready', 'active'):
            continue
        dependencies = [
            u for u, v in graph.graph.in_edges(node)
            if graph.graph.edges[u, v].get('type') == 'dependency'
        ]
        if all(
            str(graph.graph.nodes[dep].get('status', '')).startswith(('completed', 'deprecated', 'failed'))
            for dep in dependencies
        ):
            executable_tasks.append(node)

    return executable_tasks


async def handle_cli_approval(op_id: str, plan_data: List[Dict[str, Any]]):
    """
    处理 CLI 端的人工审批。
    与 Web 端审批并行运行，任何一方先提交决策即生效。
    """
    if not sys.stdin.isatty():
        console.print("[dim]非交互式环境，跳过 CLI 审批监听。[/dim]")
        return

    loop = asyncio.get_running_loop()
    
    # 1. 展示计划概要
    console.print(Panel(f"待审批计划 ({len(plan_data)} ops):", title="[bold yellow]HITL CLI[/bold yellow]", style="yellow"))
    for i, op in enumerate(plan_data):
        cmd = op.get('command')
        node_id = op.get('node_id') or op.get('node_data', {}).get('id')
        desc = op.get('node_data', {}).get('description') or op.get('updates') or op.get('reason')
        console.print(f"  {i+1}. [bold]{cmd}[/bold] {node_id}: {str(desc)[:100]}...")

    console.print("\n请选择操作: [bold green]y[/bold green] (批准), [bold red]n[/bold red] (拒绝), [bold blue]m[/bold blue] (修改)")
    console.print("HITL > ", end="")
    
    # 2. 阻塞等待输入 (运行在 executor 中以免阻塞主循环)
    try:
        while True:
            try:
                # 稍微让出控制权，确保 Web Server 任务有机会运行
                await asyncio.sleep(0.1)
                
                # 使用 sys.stdin.readline 替代 input，避免某些环境下的 GIL 或锁竞争问题
                # 注意：readline 会保留换行符，需要 strip
                line = await loop.run_in_executor(None, sys.stdin.readline)
                if not line: # EOF
                    break
                    
                choice = line.strip().lower()
                
                if choice == 'y':
                    await intervention_manager.submit_decision(op_id, "APPROVE")
                    console.print("✅ CLI: 已批准计划。", style="green")
                    break
                elif choice == 'n':
                    await intervention_manager.submit_decision(op_id, "REJECT")
                    console.print("❌ CLI: 已拒绝计划。", style="red")
                    break
                elif choice == 'm':
                    # 修改模式：调用系统编辑器
                    import tempfile
                    import os
                    import subprocess
                    
                    editor = os.getenv('EDITOR', 'vim')
                    with tempfile.NamedTemporaryFile(mode='w+', suffix='.json', delete=False) as tf:
                        json.dump(plan_data, tf, indent=2, ensure_ascii=False)
                        tf_path = tf.name
                    
                    try:
                        console.print(f"正在打开编辑器 ({editor})...")
                        subprocess.call([editor, tf_path])
                        
                        with open(tf_path, 'r') as tf:
                            modified_data = json.load(tf)
                        
                        await intervention_manager.submit_decision(op_id, "MODIFY", modified_data)
                        console.print("✏️ CLI: 已提交修改后的计划。", style="green")
                        os.unlink(tf_path)
                        break
                    except Exception as e:
                        console.print(f"[bold red]修改失败: {e}[/bold red]")
                        console.print("请重试或使用 y/n。", style="yellow")
                        console.print("HITL > ", end="")
                else:
                    console.print("无效输入。请输入 y, n 或 m。", style="yellow")
                    console.print("HITL > ", end="")
                
            except Exception as e:
                console.print(f"[dim]CLI 输入错误: {e}[/dim]")
                await asyncio.sleep(1) # 出错后避让
                
    except asyncio.CancelledError:
        # 任务被取消（说明 Web 端已处理）
        console.print("\n[dim]Web 端已提交决策，CLI 审批取消。[/dim]")


async def run_standalone_react(goal: str, task_name: str, log_dir: str, args: argparse.Namespace, llm: LLMClient, op_id: str):
    """
    运行纯 ReAct 模式 (消融实验 - Mode C)
    绕过 P-E-R 架构，直接使用 Executor 执行全局任务。
    """
    console.print(Panel("启动纯 ReAct 模式 (Ablation Mode C)...", style="bold magenta"))
    
    graph_manager = GraphManager(task_name, goal, op_id=op_id)
    
    # 将整个任务封装为一个可以直接执行的子任务
    subtask_id = "global_react_execution"
    graph_manager.graph.add_node(subtask_id, 
        type="subtask", 
        goal=goal, 
        status="ready", 
        description="Global Execution in ReAct Mode"
    )
    
    # 增加最大步数限制 (因为没有子任务拆分)
    # 不再修改全局配置，而是直接传递参数
    react_max_steps = 50 
    console.print(f"ReAct 模式：设置最大步数为 {react_max_steps}", style="dim")
    
    metrics = {
        "start_time": time.time(),
        "task_name": task_name,
        "total_tokens": 0,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "cost_cny": 0.0,
        "tool_calls": {},
        "execution_steps": 0,
        "plan_steps": 0,
        "reflect_steps": 0,
        "execute_steps": 1, # Single execution phase
        "ablation_mode": "react"
    }
    
    run_log = []
    effective_output_mode = args.output_mode

    try:
        # Save initial log
        save_logs(log_dir, metrics, run_log)
        
        # Run single executor cycle
        console.print(Panel(f"开始执行全局 ReAct 循环...", title="Executor", style="bold blue"))
        
        # Use graph_manager's root goal description as briefing
        global_mission_briefing = f"Mission Goal: {goal}"
        
        # Define real-time save callback to capture in-progress cost
        def realtime_save(current_cycle_metrics: Dict = None):
            # Create snapshot of global metrics
            # Use deepcopy to avoid polluting the main metrics accumulator with partial cycle data
            snapshot_metrics = copy.deepcopy(metrics) 
            if current_cycle_metrics:
                update_global_metrics(snapshot_metrics, current_cycle_metrics)
            save_logs(log_dir, snapshot_metrics, run_log)
        
        from core.executor import run_executor_cycle
        _, status, cycle_metrics = await run_executor_cycle(
            goal, 
            subtask_id, 
            llm, 
            graph_manager,
            global_mission_briefing, 
            log_dir=log_dir,
            save_callback=lambda: save_logs(log_dir, metrics, run_log),
            output_mode=effective_output_mode,
            max_steps=react_max_steps, # Explicitly pass max steps
            disable_artifact_check=True # React mode should not stop on no new artifacts
        )
        
        update_global_metrics(metrics, cycle_metrics)
        
        # Check if success_info was updated by a tool or monitor during execution
        # React mode only succeeds if the flag is actually found/submitted, not just by finishing steps
        if metrics.get("success_info", {}).get("found"):
            metrics["success"] = True
            console.print(Panel("ReAct 模式执行成功完成且Flag已找到！", style="bold green"))
        else:
            metrics["success"] = False
            if status == "completed":
                # Completed steps but no flag -> Fail
                 console.print(Panel("ReAct 模式执行结束，但未找到 Flag。", style="yellow"))
            else:
                console.print(Panel(f"ReAct 模式执行结束，状态: {status}", style="yellow"))
            
    except Exception as e:
        console.print(Panel(f"ReAct 模式执行发生错误: {e}", style="bold red"))
        metrics["error"] = str(e)
    finally:
        metrics["end_time"] = time.time()
        metrics["total_time_seconds"] = metrics["end_time"] - metrics["start_time"]
        save_logs(log_dir, metrics, run_log, final_save=True)

async def main():
    parser = argparse.ArgumentParser(description="LuaN1ao Agent")
    parser.add_argument("--goal", required=True, help="The penetration testing goal for the agent.")
    parser.add_argument("--task-name", default="default_task", help="The name of the task, used for logging.")
    parser.add_argument("--log-dir", help="The directory to save logs. If not provided, defaults to logs/task_name/timestamp.")

    # LLM Configuration arguments
    parser.add_argument("--llm-api-base-url", help="The base URL for the LLM API.")
    parser.add_argument("--llm-api-key", help="The API key for the LLM service.")
    parser.add_argument("--llm-planner-model", help="Model to use for the Planner role.")
    parser.add_argument("--llm-executor-model", help="Model to use for the Executor role.")
    parser.add_argument("--llm-reflector-model", help="Model to use for the Reflector role.")
    parser.add_argument("--llm-default-model", help="Default model to use for other roles.")
    parser.add_argument("--llm-expert-model", help="Model to use for the Expert Analysis role.")
    parser.add_argument("--web", action="store_true", help="Show Web visualization service info (Web service now runs independently)")
    parser.add_argument("--web-port", type=int, default=DEFAULT_WEB_PORT, help="Web service port (for display purposes only)")
    parser.add_argument("--op-id", type=str, help="Specify the operation ID for the current task (passed by Web UI)")
    parser.add_argument(
        "--output-mode", 
        type=str, 
        choices=["simple", "default", "debug"], 
        default=OUTPUT_MODE, # Use OUTPUT_MODE from config as default
        help="Console output mode: simple, default, debug"
    )
    # Ablation study arguments
    parser.add_argument("--mode", type=str, choices=["default", "linear", "react"], default="default", help="Execution mode: default (P-E-R), linear (linear task chain), react (single Executor loop)")
    parser.add_argument("--no-causal-graph", action="store_true", help="Disable causal graph reasoning (ablation study)")

    args = parser.parse_args()

    # Register signal handlers for graceful shutdown
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    goal = args.goal
    task_name = args.task_name
    log_dir = args.log_dir  # 获取传递的 log_dir

    # Determine op_id and task_id early, outside the try block
    op_id = args.op_id if args.op_id else generate_task_id()
    task_id = op_id # Unify task_id and op_id for consistency

    # Set LLM's op_id for event sending immediately after op_id is determined
    llm = LLMClient() # Initialize LLMClient before setting op_id
    llm.op_id = op_id # Use the unified op_id for LLMClient's event emission

    # 确定最终的输出模式
    effective_output_mode = args.output_mode

    console.print(Panel(f"LuaN1ao Agent 启动。Task: {task_name}", title="启动信息", style="bold blue"))

    # Initialize Database
    await core.database.utils.init_db()

    # Create custom models dict from command line args
    llm_models = {
        "default": args.llm_default_model or os.getenv("LLM_DEFAULT_MODEL", "qwen3-max"),
        "planner": args.llm_planner_model or os.getenv("LLM_PLANNER_MODEL", "qwen3-max"),
        "executor": args.llm_executor_model or os.getenv("LLM_EXECUTOR_MODEL", "qwen3-max"),
        "reflector": args.llm_reflector_model or os.getenv("LLM_REFLECTOR_MODEL", "qwen3-max"),
        "expert_analysis": args.llm_expert_model or os.getenv("LLM_EXPERT_MODEL", "qwen3-max"),
    }

    # Override configuration from command line if provided
    if args.llm_api_base_url or args.llm_api_key:
        # Temporarily update the configuration module to reflect the command-line arguments
        import conf.config
        if args.llm_api_base_url:
            conf.config.LLM_API_BASE_URL = args.llm_api_base_url
        if args.llm_api_key:
            conf.config.LLM_API_KEY = args.llm_api_key
        # Update models as well
        conf.config.LLM_MODELS = llm_models

    # 应用消融实验设置
    if args.mode:
        import conf.config
        conf.config.EXECUTION_MODE = args.mode
    if args.no_causal_graph:
        import conf.config
        conf.config.NO_CAUSAL_GRAPH = True

    # Note: LLMClient is already initialized above (with llm.op_id set).
    # Do NOT re-create it here, or op_id will be lost and Web UI logs will be empty.

    # If not provided log_dir, use default logic
    if not log_dir:
        log_dir = os.path.join("logs", task_name, datetime.now().strftime("%Y%m%d_%H%M%S"))

    os.makedirs(log_dir, exist_ok=True)  # Ensure directory exists

    # --- Setup Global Event Listener for DB Persistence ---
    # Define the functions here, but start the consumer AFTER op_id is set
    async def global_event_listener(msg, op_id):
        """Persist relevant events to database for Web UI visibility."""
        event_type = msg.get("event")
        if not event_type:
            return
            
        # Only persist events that are useful for the frontend log
        if event_type.startswith("llm.") or event_type.startswith("execution.") or event_type == "graph.changed":
            # Extract content - simplify complex objects if needed
            content = msg.get("data") or msg.get("payload") or msg
            
            # Use schedule_coroutine to run DB insert without blocking event loop
            schedule_coroutine(add_log(op_id, event_type, content))

    async def event_consumer(op_id):
        """Background task to consume events from the broker."""
        async for msg in broker.subscribe(op_id):
            await global_event_listener(msg, op_id)
    # ----------------------------------------------------

    # Security Warning Banner
    console.print(Panel(
        "[bold red]⚠️ 严重安全警告：此Agent包含执行任意代码的工具！[/bold red]\n\n"
        "工具 [bold yellow]python_exec[/bold yellow] 和 [bold yellow]shell_exec[/bold yellow] 允许Agent执行系统命令和Python代码。\n"
        "- [bold yellow]存在远程代码执行 (RCE) 风险[/bold yellow]\n"
        "- [bold yellow]不提供严格沙箱隔离[/bold yellow]\n\n"
        "[bold red]强烈建议您在隔离的、受控的环境中运行本Agent。[/bold red]",
        title="[bold red]!!! 安全警告 !!![/bold red]",
        title_align="center",
        border_style="red"
    ))

    # Set up file-based console logging
    text_log_path = os.path.join(log_dir, "console_output.log")
    try:
        log_file = open(text_log_path, "w", encoding="utf-8")
        # Use the new function to create a console that writes to both stdout and the file
        new_console = init_console_with_file(log_file)
        set_console(new_console)
    except Exception as e:
        console.print(f"[bold red]Error setting up file logging: {e}[/bold red]")

    # Initialize metrics and run log
    metrics = {
        "task_name": task_name,
        "start_time": time.time(),
        "end_time": None,
        "total_time_seconds": 0,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "cost_cny": 0,
        "tool_calls": defaultdict(int),
        "success_info": {"found": False, "reason": ""},
        "execution_steps": 0,
        "plan_steps": 0,
        "execute_steps": 0,
        "reflect_steps": 0,
        "artifacts_found": 0,
        "causal_graph_nodes": [],
        "deployment_time": 0,  # Initialize deployment time
    }
    run_log = []

    # Initialize services, MCP sessions outside the main loop for true persistence
    await initialize_sessions()
    await tool_manager.refresh_tools_async()  # Initialize tool cache

    # Ensure knowledge service is running
    await ensure_knowledge_service(console)

    try:
        # op_id already determined above

        
        # Start the event consumer NOW that op_id is properly set
        asyncio.create_task(event_consumer(op_id))

        # Web Server Decoupling Warning
        if args.web:
            web_url = f"http://{DEFAULT_WEB_HOST}:{args.web_port}/?op_id={op_id}"
            console.print(Panel(
                f"您启用了 --web 标志。\n"
                f"请确保独立的 Web 服务正在运行: `python web/server.py`\n"
                f"访问地址: [link={web_url}]{web_url}[/link]",
                style="bold green",
                title="Web Visualization"
            ))

        metrics["task_id"] = task_id
        console.print(Panel(f"Task: {task_name}\nTask ID: {task_id}\nGoal: {goal}", title="任务初始化", style="bold green"))
        run_log.append({"event": "task_initialized", "task_id": task_id, "goal": goal, "timestamp": time.time()})

        # 消融实验检查：Mode C (ReAct)
        if args.mode == "react":
            await run_standalone_react(goal, task_name, log_dir, args, llm, op_id)
            return

        # Initialize GraphManager
        graph_manager = GraphManager(task_name, goal, op_id=op_id)
        
        # Update session status to running immediately after GraphManager is ready
        try:
            from core.database.utils import update_session_status
            await update_session_status(op_id, "running")
            console.print(Panel(f"Session {op_id} 状态已更新到数据库: running", style="green"))
        except Exception as e:
            console.print(Panel(f"更新数据库状态失败: {e}", style="yellow"))
        
        # Record deployment time (considered complete upon GraphManager initialization)
        metrics["deployment_time"] = time.time() - metrics["start_time"]
        
        planner = Planner(llm, output_mode=effective_output_mode)
        reflector = Reflector(llm, output_mode=effective_output_mode)

        # Set target URL (optional field, can be provided as needed)
        target_url = ""

        # Initialize Planner and Reflector contexts
        planner_context = PlannerContext(
            session_start_time=time.time(),
            initial_goal=goal,
            target_url=target_url,
            planning_history=[],
            rejected_strategies={},
            long_term_objectives=[]
        )

        reflector_context = ReflectorContext(
            session_start_time=time.time(),
            reflection_log=[],
            failure_patterns={},
            success_patterns={},
            active_hypotheses={}
        )
        try:
            planner.set_log_dir(log_dir)
            reflector.set_log_dir(log_dir)
        except Exception:
            pass
        global_mission_briefing = "任务的初始目标是：" + goal # Initialize global mission briefing

        # 1. Planning (Plan)
        console.print(Panel("进入规划阶段...", title="Planner", style="bold blue"))

        try:
            causal_graph_summary = graph_manager.get_causal_graph_summary()
            initial_ops, call_metrics = await planner.plan(goal, causal_graph_summary)
        except Exception as e:
            console.print(Panel(f"规划阶段出现错误: {str(e)}", title="Planner Error", style="bold red"))
            import traceback
            console.print(traceback.format_exc())
            # Update session status to failed
            try:
                await update_session_status(op_id, "failed")
            except Exception:
                pass
            raise
        # Increment plan steps
        if call_metrics:
            call_metrics["plan_steps"] = call_metrics.get("plan_steps", 0) + 1
        else:
            call_metrics = {"plan_steps": 1}
        update_global_metrics(metrics, call_metrics)
        run_log.append({"event": "initial_plan", "data": initial_ops, "metrics": call_metrics, "timestamp": time.time()})
        try:
            await broker.emit("graph.changed", {"reason": "initial_plan_applied"}, op_id=llm.op_id)
        except Exception:
            pass

        # HITL: Initial plan approval
        if HUMAN_IN_THE_LOOP:
            op_id = llm.op_id
            
            # Notify frontend of pending approval request
            try:
                await broker.emit("intervention.required", {"op_id": op_id, "type": "plan_approval"}, op_id=op_id)
            except Exception:
                pass
            
            # Start CLI interaction task (competes with Web端)
            cli_task = asyncio.create_task(handle_cli_approval(op_id, initial_ops))
                
            # Block until decision is made (unblocks when either side submits)
            decision = await intervention_manager.request_approval(op_id, initial_ops)
            
            # Clean up CLI task
            if not cli_task.done():
                cli_task.cancel()
                try:
                    await cli_task
                except asyncio.CancelledError:
                    pass
            
            action = decision.get("action")
            if action == "REJECT":
                console.print("[HITL] 用户拒绝了初始计划。任务终止。", style="bold red")
                return # Exit task
            elif action == "MODIFY":
                initial_ops = decision.get("data", [])
                console.print("[HITL] 用户修改了初始计划，应用修改后的操作。", style="bold green")
            else:
                console.print("[HITL] 用户批准了初始计划。", style="bold green")

        verified_ops = verify_and_handle_orphans(initial_ops, graph_manager, console)
        process_graph_commands(verified_ops, graph_manager)

        # Get next tasks to execute for highlighting
        next_executable_tasks = get_next_executable_subtask_batch(graph_manager)

        if effective_output_mode in ["default", "debug"]:
            console.print("初始计划已生成:")
        if effective_output_mode in ["simple", "default", "debug"]:
            graph_manager.print_graph_structure(console, highlight_nodes=next_executable_tasks)
        if effective_output_mode in ["default", "debug"]:
            # Output initial causal graph structure for debugging and visualization
            try:
                graph_manager.print_causal_graph(console, max_nodes=100)
            except Exception as e:
                console.print(Panel(f"打印因果图失败: {e}", title="因果图错误", style="red"))
        run_log.append({"event": "initial_plan_generated", "plan": initial_ops, "timestamp": time.time()})

        # 3. Execute-Reflect-Plan Loop
        completed_reflections = {} # Collect completed reflection outputs (including intelligence_summary)
        global_cycle_count = 0
        while True:
            # --- Resource Governance Check ---
            global_cycle_count += 1
            if global_cycle_count > GLOBAL_MAX_CYCLES:
                console.print(Panel(f"达到全局最大循环次数限制 ({GLOBAL_MAX_CYCLES})。任务强制终止以防止死循环。", title="资源熔断", style="bold red"))
                metrics["success"] = False
                metrics["termination_reason"] = "global_max_cycles_exceeded"
                break
            
            if metrics.get("total_tokens", 0) > GLOBAL_MAX_TOKEN_USAGE:
                console.print(Panel(f"达到全局最大 Token 消耗限制 ({GLOBAL_MAX_TOKEN_USAGE})。任务强制终止。", title="资源熔断", style="bold red"))
                metrics["success"] = False
                metrics["termination_reason"] = "global_token_limit_exceeded"
                break
            # ---------------------------------

            # ==================================================
            # 1. Planning Phase (PLAN)
            # ==================================================
            if completed_reflections:
                if effective_output_mode in ["default", "debug"]:
                    console.print(Panel("汇总情报，Planner 进行战略规划...", style="yellow"))

                intelligence_summary = _aggregate_intelligence(completed_reflections)

                refreshed_summary = graph_manager.get_full_graph_summary(detail_level=1)
                causal_graph_summary = graph_manager.get_causal_graph_summary()
                failure_patterns_summary = graph_manager.analyze_failure_patterns()

                plan_data, call_metrics = await planner.dynamic_plan(
                    goal, refreshed_summary, intelligence_summary,
                    causal_graph_summary, "", failure_patterns_summary, graph_manager,
                    planner_context=planner_context
                )
                # Output planner's dynamic plan results
                if effective_output_mode in ["default", "debug"]:
                    console.print(Panel("Planner 生成的动态计划:", title="动态计划", style="cyan"))
                    # Sanitize JSON output to prevent issues with special characters in Rich parsing
                    safe_plan_json = sanitize_for_rich(json.dumps(plan_data, indent=2, ensure_ascii=False))
                    console.print(Panel(safe_plan_json, style="cyan"))
                # Increment plan steps
                if call_metrics:
                    call_metrics["plan_steps"] = call_metrics.get("plan_steps", 0) + 1
                else:
                    call_metrics = {"plan_steps": 1}
                update_global_metrics(metrics, call_metrics)
                run_log.append({"event": "dynamic_plan", "data": plan_data, "metrics": call_metrics, "timestamp": time.time()})

                # Check if Planner has declared the task accomplished
                if plan_data.get("global_mission_accomplished"):
                    console.print(Panel("🎉 Planner已宣布全局任务目标达成！任务结束。", title="[bold green]任务完成[/bold green]"))
                    metrics["success_info"] = {"found": True, "reason": "Global mission accomplished signal received from Planner."}
                    
                    # 标记导致成功的节点（分层策略）
                    # 1. 从 Planner 获取成功子任务 ID
                    # 2. 从子任务节点读取 Reflector 标记的 critical_success_step_id
                    # 3. 回退：如果没有标记，使用该子任务下最后完成的步骤
                    
                    goal_subtask_id = None
                    goal_step_id = None
                    
                    # Step 1: 获取成功子任务 ID
                    goal_achieved_by = plan_data.get("goal_achieved_by")
                    if goal_achieved_by and graph_manager.graph.has_node(goal_achieved_by):
                        goal_subtask_id = goal_achieved_by
                        console.print(Panel(f"Planner 指定成功子任务: {goal_subtask_id}", style="blue"))
                    elif completed_reflections:
                        # 回退：从最近完成的反思中找子任务
                        # 优先找 GOAL_ACHIEVED 状态的子任务
                        for subtask_id, reflection_data in completed_reflections.items():
                            audit = reflection_data.get("audit_result", {})
                            if _is_goal_achieved_status(audit.get("status")):
                                goal_subtask_id = subtask_id
                                console.print(Panel(f"找到 goal_achieved 子任务: {goal_subtask_id}", style="blue"))
                                break
                        
                        if not goal_subtask_id:
                            # 再回退：最近完成的子任务
                            sorted_reflections = sorted(
                                completed_reflections.items(),
                                key=lambda x: x[1].get('completed_at', 0) if isinstance(x[1], dict) else 0,
                                reverse=True
                            )
                            if sorted_reflections:
                                goal_subtask_id = sorted_reflections[0][0]
                    
                    if goal_subtask_id and graph_manager.graph.has_node(goal_subtask_id):
                        subtask_data = graph_manager.graph.nodes[goal_subtask_id]
                        
                        # Step 2: 从子任务节点读取 Reflector 标记的 critical_success_step_id
                        critical_step = subtask_data.get("critical_success_step_id")
                        if critical_step and graph_manager.graph.has_node(critical_step):
                            goal_step_id = critical_step
                            console.print(Panel(f"Reflector 标记的关键成功步骤: {goal_step_id}", style="green"))
                        else:
                            # Step 3 回退: 找该子任务下最后完成的 execution_step
                            last_step_id = None
                            last_step_time = 0
                            
                            for node_id in graph_manager.graph.nodes():
                                node_data = graph_manager.graph.nodes[node_id]
                                node_type = node_data.get("type", "")
                                parent = node_data.get("parent", "")
                                
                                if node_type == "execution_step" and parent == goal_subtask_id:
                                    if node_data.get("status") == "completed":
                                        completed_at = node_data.get("completed_at", 0)
                                        if completed_at and completed_at > last_step_time:
                                            last_step_time = completed_at
                                            last_step_id = node_id
                            
                            if last_step_id:
                                goal_step_id = last_step_id
                                console.print(Panel(f"回退：使用最后完成的步骤 {goal_step_id}", style="yellow"))
                        
                        # 标记成功节点
                        if goal_step_id:
                            graph_manager.update_node(goal_step_id, {"is_goal_achieved": True})
                            console.print(Panel(f"✨ 执行步骤 {goal_step_id} 被标记为目标达成节点", style="green"))
                        else:
                            # 没找到 execution_step，标记子任务本身
                            graph_manager.update_node(goal_subtask_id, {"is_goal_achieved": True})
                            console.print(Panel(f"✨ 子任务 {goal_subtask_id} 被标记为目标达成节点", style="yellow"))
                    
                    # Process final graph operations (if any)
                    dynamic_ops = plan_data.get('graph_operations', [])
                    if dynamic_ops:
                        process_graph_commands(dynamic_ops, graph_manager)
                    
                    # Critical fix: Update root node status to completed
                    graph_manager.update_node(graph_manager.task_id, {"status": "completed"})
                    console.print(Panel(f"根任务 {graph_manager.task_id} 状态已更新为 completed", style="green"))
                    
                    # Update session status to completed in database
                    try:
                        from core.database.utils import update_session_status
                        await update_session_status(llm.op_id, "completed")
                        console.print(Panel(f"Session {llm.op_id} 状态已更新到数据库: completed", style="green"))
                    except Exception as e:
                        console.print(Panel(f"更新数据库状态失败: {e}", style="red"))
                    
                    # Notify frontend of graph structure change
                    try:
                        await broker.emit("graph.changed", {"reason": "mission_accomplished"}, op_id=llm.op_id)
                    except Exception:
                        pass
                    
                    break # Exit main loop

                # Update Planner context status (new) and save full LLM prompt/response
                try:
                    last_prompt = getattr(planner, "_last_dynamic_prompt", None)
                    last_response_text = getattr(planner, "_last_dynamic_response", None)
                except Exception:
                    last_prompt, last_response_text = None, None
                planner_context = planner.update_planner_context_after_planning(
                    planner_context, plan_data, graph_manager, llm_prompt=last_prompt, llm_response=last_response_text
                )

                # Check and compress Planner context if needed
                await compress_planner_context_if_needed(planner_context, llm, metrics=metrics)

                dynamic_ops = plan_data.get('graph_operations', [])
                global_mission_briefing = plan_data.get('global_mission_briefing', global_mission_briefing)

                if dynamic_ops:
                    # HITL: Dynamic plan approval
                    if HUMAN_IN_THE_LOOP:
                        op_id = llm.op_id
                        
                        try:
                            await broker.emit("intervention.required", {"op_id": op_id, "type": "plan_approval"}, op_id=op_id)
                        except Exception:
                            pass
                            
                        # Start CLI interaction task
                        cli_task = asyncio.create_task(handle_cli_approval(op_id, dynamic_ops))
                        
                        # Block until decision is made
                        decision = await intervention_manager.request_approval(op_id, dynamic_ops)
                        
                        # Clean up CLI task
                        if not cli_task.done():
                            cli_task.cancel()
                            try:
                                await cli_task
                            except asyncio.CancelledError:
                                pass
                        
                        action = decision.get("action")
                        if action == "REJECT":
                            console.print("[HITL] 用户拒绝了动态计划。跳过本次更新（可能导致停滞）。", style="bold red")
                            dynamic_ops = [] # Clear operations, continue loop
                        elif action == "MODIFY":
                            dynamic_ops = decision.get("data", [])
                            console.print("[HITL] 用户修改了动态计划。", style="bold green")
                        else:
                            console.print("[HITL] 用户批准了动态计划。", style="bold green")

                    if effective_output_mode in ["default", "debug"]:
                        console.print(Panel("Planner 基于情报做出规划决策，开始更新...", style="yellow"))
                    verified_ops = verify_and_handle_orphans(dynamic_ops, graph_manager, console)
                    process_graph_commands(verified_ops, graph_manager)
                    try:
                        await broker.emit("graph.changed", {"reason": "dynamic_plan_applied"}, op_id=llm.op_id)
                    except Exception:
                        pass
                    if effective_output_mode in ["default", "debug"]:
                        console.print("主任务图更新完成:")
                    if effective_output_mode in ["simple", "default", "debug"]:
                        next_executable_tasks = get_next_executable_subtask_batch(graph_manager)
                        graph_manager.print_graph_structure(console, highlight_nodes=next_executable_tasks)
                    if effective_output_mode in ["default", "debug"]:
                        # Synchronously output updated causal graph structure
                        try:
                            graph_manager.print_causal_graph(console, max_nodes=100)
                        except Exception as e:
                            console.print(Panel(f"打印因果图失败: {e}", title="因果图错误", style="red"))

                # Periodically save logs after each full P-E-R cycle
                if effective_output_mode in ["default", "debug"]:
                    console.print(Panel("Saving log snapshot...", style="dim"))
                metrics["artifacts_found"] = len(graph_manager.causal_graph.nodes)
                # Record causal graph nodes
                metrics["causal_graph_nodes"] = list(graph_manager.causal_graph.nodes(data=True))
                save_logs(log_dir, metrics, run_log)

                completed_reflections = {}

# ==================================================
            # 2. Execution Phase (EXECUTE)
# ==================================================
            subtask_batch = get_next_executable_subtask_batch(graph_manager)

            if not subtask_batch and not completed_reflections:
                if not graph_manager.is_goal_achieved():
                    console.print(Panel("任务全局停滞，没有可执行的子任务，但目标未达成。强制启动最终规划...", title="全局停滞", style="bold red"))
                    # Force a final replan cycle
                    completed_reflections['__FORCE_REPLAN__'] = {
                        "audit_result": {"status": "STALLED", "completion_check": "All tasks are blocked or completed, but the goal is not achieved."},
                        "key_findings": ["Global task execution has stalled."],
                        "validated_nodes": [],
                        "insight": {"type": "stall_analysis", "description": "The agent is stuck. A new high-level plan is required to find an alternative path."}
                    }
                    continue
                else:
                    # If goal is achieved, exit normally
                    console.print(Panel("所有子任务已完成且目标已达成，任务结束。", title="任务完成", style="bold green"))
                    break

            if not subtask_batch and not completed_reflections:
                 console.print(Panel("最终规划未能产生新的可执行任务，代理已尽力，任务结束。",
                                     title="最终决策", style="bold red"))
                 break

            # Mark subtasks as in_progress visually
            for subtask_id in subtask_batch:
                graph_manager.update_node(subtask_id, {"status": "in_progress"})

            # Define real-time save callback shared by all parallel tasks
            # Note: In parallel execution, this may cause transient metric flip-flops in logs,
            # but ensures at least one active task's progress is visible.
            def per_realtime_save(cycle_metrics: Dict = None):
                snapshot = copy.deepcopy(metrics)
                if cycle_metrics:
                    update_global_metrics(snapshot, cycle_metrics)
                save_logs(log_dir, snapshot, run_log)

            tasks = [
                asyncio.create_task(run_executor_cycle(goal, subtask_id, llm, graph_manager,
                    global_mission_briefing, log_dir=log_dir, 
                    save_callback=per_realtime_save,
                    output_mode=effective_output_mode)) # Added output_mode
                for subtask_id in subtask_batch
            ]
            completed_results = await asyncio.gather(*tasks, return_exceptions=True)

# ==================================================
            # 3. Reflection (REFLECT)
# ==================================================
            for i, result_or_exc in enumerate(completed_results):
                subtask_id = subtask_batch[i]
                try:
                    if isinstance(result_or_exc, Exception):
                        raise result_or_exc

                    _, result_status, cycle_metrics = result_or_exc
                    update_global_metrics(metrics, cycle_metrics)
                    run_log.append({"event": "executor_cycle_completed", "subtask_id": subtask_id,
                                    "status": result_status, "metrics": cycle_metrics, "timestamp": time.time()})

                    console.print(Panel(f"子任务 {subtask_id} 执行完毕，状态: {result_status}。开始即时反思...",
                                        title="Executor", style="bold blue"))

                    if not graph_manager.graph.has_node(subtask_id):
                        console.print(Panel(f"跳过已废弃/删除的子任务 {subtask_id} 的反思阶段。",
                                            title="警告", style="yellow"))
                        continue

                    subtask_data = graph_manager.graph.nodes[subtask_id]
                    reflection_output = await reflector.reflect(
                        subtask_id=subtask_id,
                        subtask_data=subtask_data,
                        status=result_status,
                        execution_log=graph_manager.get_subtask_execution_log(subtask_id),
                        proposed_changes=subtask_data.get('proposed_changes', []),
                        staged_causal_nodes=subtask_data.get('staged_causal_nodes', []),
                        causal_graph_summary=graph_manager.get_causal_graph_summary(),
                        dependency_context=graph_manager.build_prompt_context(
                            subtask_id, include_relevant_causal_context=False
                        ).get("dependencies", []),
                        graph_manager=graph_manager,
                        reflector_context=reflector_context
                    )

                    update_global_metrics(metrics, reflection_output.get('metrics'))
                    run_log.append({"event": "reflection_completed", "subtask_id": subtask_id, "data": reflection_output, "metrics": reflection_output.get('metrics'), "timestamp": time.time()})

                    # Update Reflector context status (new)
                    reflector_context = update_reflector_context_after_reflection(
                        reflector_context, reflection_output, subtask_id, result_status, graph_manager
                    )

                    # Check and compress Reflector context if needed
                    await compress_reflector_context_if_needed(reflector_context, llm, metrics=metrics)

                    # Output reflection_output
                    if effective_output_mode in ["default", "debug"]:
                        console.print(Panel("Reflector 输出:", title=f"子任务 {subtask_id} 反思结果", style="cyan"))
                        # Create a copy for display, removing unnecessarily large fields
                        display_output = {k: v for k, v in reflection_output.items() if k not in ['llm_reflection_prompt', 'llm_reflection_response']}
                        # Sanitize JSON output to prevent issues with special characters in Rich parsing
                        safe_reflection_json = sanitize_for_rich(json.dumps(display_output, indent=2, ensure_ascii=False))
                        console.print(Panel(safe_reflection_json, style="cyan"))
                    audit_result = reflection_output.get("audit_result", {})

                    # 保存 Reflector 标记的关键成功步骤到子任务节点
                    critical_success_step = audit_result.get("critical_success_step_id")
                    if critical_success_step and graph_manager.graph.has_node(critical_success_step):
                        graph_manager.update_node(subtask_id, {"critical_success_step_id": critical_success_step})
                        console.print(Panel(f"子任务 {subtask_id} 的关键成功步骤: {critical_success_step}", style="green"))

                    if audit_result.get("is_strategic_failure"):
                        console.print(Panel(
                            f"检测到子任务 {subtask_id} 的战略性失败（L4/L5），将由 Planner 统一制定替代方案。",
                            title="⚠️ 战略失败", style="bold yellow"
                        ))

                    # 所有反思结果统一汇入 completed_reflections，由 Global Planner 裁决
                    completed_reflections[subtask_id] = reflection_output

                    causal_graph_updates = reflection_output.get("causal_graph_updates", {})
                    if causal_graph_updates:
                        validated_updates = validate_causal_graph_updates(causal_graph_updates,
                                                                          graph_manager, subtask_id=subtask_id)
                        process_causal_graph_commands(validated_updates, graph_manager, subtask_id=subtask_id)
                        # Added causal graph print for simple mode requirement
                        if effective_output_mode in ["simple", "default", "debug"]:
                            try:
                                console.print(Panel(f"子任务 {subtask_id} 因果图更新:", title="因果图更新", style="green"))
                                graph_manager.print_causal_graph(console, max_nodes=100)
                            except Exception as e:
                                console.print(Panel(f"打印因果图失败: {e}", title="因果图错误", style="red"))

                    # Process key facts
                    key_facts = reflection_output.get("key_facts", [])
                    if key_facts: # Key facts should always be printed, even in simple mode
                        console.print(f"🔑 Reflector 提炼出 {len(key_facts)} 个关键事实", style="bold cyan")
                        for fact in key_facts:
                            if isinstance(fact, str) and fact.strip():
                                fact_id = graph_manager.add_key_fact(fact.strip())
                                console.print(f"  ✓ 关键事实已记录: {fact[:80]}{'...' if len(fact) > 80 else ''}", style="cyan")

                    subtask_audit_status = audit_result.get("status", "FAILED")
                    # Convert to lowercase for consistent comparison
                    status_lower = str(subtask_audit_status).lower()
                    
                    # Determine status: completed, incomplete, or failed
                    if status_lower in ["completed", "pass", "goal_achieved"]:
                        new_status = "completed"
                    elif status_lower == "incomplete":
                        new_status = "pending"
                    else:
                        new_status = "failed"

                    graph_manager.update_node(subtask_id, {"status": new_status,
                                                           "summary": reflection_output.get("audit_result", {}).get("completion_check")})

                    # Clean up staged nodes after subtask completion (both completed and failed states require cleanup)
                    if new_status in ["completed", "failed"]:
                        graph_manager.clear_staged_causal_nodes(subtask_id)
                    # Process causal graph nodes (validated nodes from Reflector)
                    # new_nodes_for_exploration = reflection_output.get("causal_graph_updates", {}).get("nodes", [])
                    # if new_nodes_for_exploration:
                    #     graph_manager.update_exploration_state(new_nodes_for_exploration)

                    # Also process validated_nodes field (new data structure)
                    # validated_nodes = reflection_output.get('validated_nodes', [])
                    # if validated_nodes:
                    #     graph_manager.update_exploration_state(validated_nodes)

                    # Save reflection report to Planner context for next planning cycle (new)
                    planner_context.latest_reflection_report = reflection_output

                except Exception as e:
                    import traceback
                    error_message = str(e)
                    console.print(Panel(f"处理子任务 {subtask_id} 结果时发生严重错误: {error_message}\n{traceback.format_exc()}", title="错误", style="bold red"))
                    graph_manager.update_node(subtask_id, {'status': 'completed_error', 'summary': f"Critical error during reflection: {error_message}"})
                    # Clean up staged nodes even if an error occurred
                    graph_manager.clear_staged_causal_nodes(subtask_id)

            # Save logs after each batch of executor cycles and reflections
            if effective_output_mode in ["default", "debug"]:
                console.print(Panel("Saving log snapshot after batch processing...", style="dim"))
            metrics["artifacts_found"] = len(graph_manager.causal_graph.nodes)
            # Record causal graph nodes
            metrics["causal_graph_nodes"] = list(graph_manager.causal_graph.nodes(data=True))
            save_logs(log_dir, metrics, run_log)

        # 4. Final Archiving (executed after main loop)
        console.print(Panel("任务完成，开始全局反思与归档...", title="全局反思", style="bold green"))
        global_reflection = await reflector.reflect_global(graph_manager)

        global_reflection_metrics = global_reflection.get('metrics')
        # Increment global reflection steps
        if global_reflection_metrics:
            global_reflection_metrics["reflect_steps"] = global_reflection_metrics.get("reflect_steps", 0) + 1
        else:
            global_reflection_metrics = {"reflect_steps": 1}
        update_global_metrics(metrics, global_reflection_metrics)
        run_log.append({"event": "global_reflection_completed", "data": global_reflection, "metrics": global_reflection_metrics, "timestamp": time.time()})

        # If web server is running, keep the process alive to allow for inspection.
        if args.web:
            console.print(Panel("任务执行完成。Web服务仍在运行中，按 [Ctrl+C] 退出。", title="任务结束", style="bold green"))
            while True:
                await asyncio.sleep(3600) # Sleep for a long time

    finally:
        if 'ks_manager' in locals():
            ks_manager.stop()

        # Ensure final logs are saved no matter what
        if 'graph_manager' in locals() and graph_manager:
            metrics["artifacts_found"] = len(graph_manager.causal_graph.nodes)
            # Record causal graph nodes
            metrics["causal_graph_nodes"] = list(graph_manager.causal_graph.nodes(data=True))
        save_logs(log_dir, metrics, run_log, final_save=True)

        # Clean up any remaining halt signals
        if task_id:
            halt_file = os.path.join(tempfile.gettempdir(), f"{task_id}.halt")
            if os.path.exists(halt_file):
                try:
                    os.remove(halt_file)
                    console.print(f"清理残留的终止信号文件: {halt_file}", style="dim")
                except OSError as e:
                    console.print(f"清理终止信号文件失败: {e}", style="red")
        await close_async_sessions()

if __name__ == "__main__":
    asyncio.run(main())
