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
    WEB_PORT as DEFAULT_WEB_PORT,
    KNOWLEDGE_SERVICE_PORT,
    KNOWLEDGE_SERVICE_URL,
    KNOWLEDGE_SERVICE_HOST,
    OUTPUT_MODE,
    HUMAN_IN_THE_LOOP
)
from core.events import broker
try:
    from web.server import register_graph
except Exception:
    register_graph = None

from core.console import sanitize_for_rich

def generate_task_id() -> str:
    """
    生成唯一任务ID
    
    Returns:
        格式为 "task_{timestamp}_{uuid_prefix}" 的唯一任务标识符
    """
    return f"task_{int(time.time())}_{str(uuid.uuid4())[:8]}"

# 全局知识服务状态管理
_KNOWLEDGE_SERVICE_PID = None
_KNOWLEDGE_SERVICE_LOCK = asyncio.Lock()

async def check_knowledge_service_health(console: Console) -> bool:
    """检查知识服务是否运行并且健康。"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{KNOWLEDGE_SERVICE_URL}/health", timeout=2)
            if response.status_code == 200 and response.json().get("status") == "healthy":
                return True
            else:
                console.print(f"[bold yellow]⚠️ 知识服务响应不健康: {response.status_code} - {response.text}[/bold yellow]")
                return False
    except httpx.RequestError as e:
        console.print(f"[bold red]❌ 无法连接到知识服务: {e}[/bold red]")
        return False

async def ensure_knowledge_service(console: Console):
    """确保知识服务运行（全局单例模式）"""
    global _KNOWLEDGE_SERVICE_PID

    async with _KNOWLEDGE_SERVICE_LOCK:
        # 检查服务是否已经健康运行
        if await check_knowledge_service_health(console):
            console.print("[bold green]✅ 知识服务已运行并健康。[/bold green]")
            return True

        # 检查全局服务PID是否有效
        if _KNOWLEDGE_SERVICE_PID:
            if psutil.pid_exists(_KNOWLEDGE_SERVICE_PID):
                console.print(f"[dim]知识服务进程 {_KNOWLEDGE_SERVICE_PID} 存在但未响应，尝试重启...[/dim]")
            else:
                _KNOWLEDGE_SERVICE_PID = None

        console.print("[bold blue]🚀 启动知识服务...[/bold blue]")

        # 检查端口占用（只清理非当前进程组的进程）
        import socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        port_in_use = sock.connect_ex((KNOWLEDGE_SERVICE_HOST, KNOWLEDGE_SERVICE_PORT)) == 0
        sock.close()

        if port_in_use:
            console.print(f"[bold yellow]⚠️ 端口 {KNOWLEDGE_SERVICE_PORT} 已被占用，检查是否为持久化知识服务...[/bold yellow]")

            # 检查端口占用是否为知识服务进程
            try:
                for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
                    try:
                        for conn in proc.connections(kind='inet'):
                            if conn.laddr.port == KNOWLEDGE_SERVICE_PORT:
                                cmdline = proc.info['cmdline']
                                if cmdline and "uvicorn" in " ".join(cmdline) and "knowledge_service" in " ".join(cmdline):
                                    console.print(f"[bold green]✅ 检测到持久化知识服务正在运行 (PID: {proc.info['pid']})[/bold green]")
                                    return True
                                else:
                                    console.print(f"[dim]端口被非知识服务进程占用 PID: {proc.info['pid']}[/dim]")
                    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                        pass
            except Exception as e:
                console.print(f"[dim]检查端口占用进程时出错: {e}[/dim]")

        # 启动服务
        command = [
            sys.executable, "-m", "uvicorn", "rag.knowledge_service:app",
            "--host", "0.0.0.0", "--port", str(KNOWLEDGE_SERVICE_PORT)
        ]

        try:
            # 使用 start_new_session=True 替代 preexec_fn=os.setsid 以支持更多平台
            process = subprocess.Popen(command, start_new_session=True)
            _KNOWLEDGE_SERVICE_PID = process.pid
            console.print(f"[bold green]知识服务已在后台启动 (PID: {process.pid})。[/bold green]")

            # 等待服务健康检查（带超时）
            for i in range(15):  # 最多等待30秒
                console.print(f"[dim]等待知识服务启动 ({i+1}/15)...[/dim]")
                if await check_knowledge_service_health(console):
                    console.print("[bold green]✅ 知识服务已成功启动并健康。[/bold green]")
                    return True
                await asyncio.sleep(2)

            console.print("[bold red]❌ 知识服务启动超时。[/bold red]")
            return False

        except Exception as e:
            console.print(f"[bold red]❌ 知识服务启动失败: {e}[/bold red]")
            return False

def _aggregate_intelligence(completed_reflections: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """
    汇总多个反思器输出为情报摘要.
    
    将多个子任务的反思结果汇总为统一的情报摘要，优先处理已达成目标的状态
    和目标产物类型的artifacts。
    
    Args:
        completed_reflections: 已完成的反思结果字典，key为子任务ID，value为反思输出
        
    Returns:
        Dict[str, Any]: 汇总的情报摘要，包含findings、audit_result、artifacts等字段
    """
    all_findings = []
    all_artifacts = []
    all_insights = []

    # 检查是否有任何反思结果标记了 GOAL_ACHIEVED
    goal_achieved = False
    aggregated_completion_check = f'汇总了 {len(completed_reflections)} 个任务的审计结果'
    for subtask_id, reflection in completed_reflections.items():
        # 从 reflection 提取所需字段
        audit_result = reflection.get('audit_result', {})
        if audit_result.get('status') == 'GOAL_ACHIEVED':
            goal_achievement_reason = audit_result.get('completion_check', 'Unknown reason for GOAL_ACHIEVED')
            console.print(
                f"🔍 Aggregator: 检测到子任务 {subtask_id} 报告 GOAL_ACHIEVED: {goal_achievement_reason}",
                style="bold green"
            )
            goal_achieved = True
            aggregated_completion_check = goal_achievement_reason

        # 提取 key_findings
        findings = reflection.get('key_findings', [])
        all_findings.extend(findings)

        # 提取 validated_nodes
        nodes = reflection.get('validated_nodes', [])
        all_artifacts.extend(nodes)

        # 提取 insight
        insight = reflection.get('insight')
        if insight:
            all_insights.append(insight)

    # 构建汇总的情报摘要
    aggregated_status = 'GOAL_ACHIEVED' if goal_achieved else 'AGGREGATED'
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

    # 2. 然后执行所有 DELETE/DEPRECATE 操作，将其状态更新为 deprecated
    for op in delete_ops + deprecate_ops:
        node_id = op.get("node_id")
        if node_id:
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
    graph_manager: GraphManager
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
            graph_manager.add_causal_edge(source_perm_id, target_perm_id, label, **edge_data)
            # Trigger confidence propagation
            graph_manager.update_hypothesis_confidence(target_perm_id, edge_data.get("label"))
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

    try:
        metrics_path = os.path.join(log_dir, "metrics.json")
        with open(metrics_path, 'w', encoding='utf-8', errors='replace') as f:
            json.dump(metrics_copy, f, ensure_ascii=False, indent=4)

        with open(os.path.join(log_dir, "run_log.json"), 'w', encoding='utf-8', errors='replace') as f:
            json.dump(run_log, f, ensure_ascii=False, indent=4)
    except Exception as e:
        console.print(f"[bold red]Error saving logs: {e}[/bold red]")

    if final_save:
        console.print(Panel(f"Final logs and metrics saved to {log_dir}", title="[bold green]Run Finished[/bold green]"))

def update_global_metrics(metrics: Dict, update_dict: Dict):
    """Aggregates metrics from a component into the global metrics dictionary."""
    if not update_dict:
        return

    metrics["prompt_tokens"] += update_dict.get("prompt_tokens", 0)
    metrics["completion_tokens"] += update_dict.get("completion_tokens", 0)
    metrics["total_tokens"] += update_dict.get("prompt_tokens", 0) + update_dict.get("completion_tokens", 0)
    metrics["cost_cny"] += update_dict.get("cost_cny", 0)
    
    # 修复: execution_steps不用累加，直接使用executor返回的值
    # executor已经在内部实时维护了总执行步数
    if "execution_steps" in update_dict:
        # 直接覆盖，不紫加（executor返回的是累计值）
        metrics["execution_steps"] = update_dict["execution_steps"]
    
    # plan_steps和reflect_steps需要累加（因为每次调用都是+1）
    metrics["plan_steps"] += update_dict.get("plan_steps", 0)
    metrics["execute_steps"] += update_dict.get("execute_steps", 0)
    metrics["reflect_steps"] += update_dict.get("reflect_steps", 0)

    # 修复: tool_calls不用累加，executor已经在metrics.json中实时维护
    # 我们只需要从文件读取最新值，而不是再次累加
    if "tool_calls" in update_dict:
        # 合并tool_calls（使用更大的值，避免覆盖）
        for tool, count in update_dict["tool_calls"].items():
            current_count = metrics["tool_calls"].get(tool, 0)
            # 只在update_dict的值更大时更新（executor返回的是累计值）
            if count > current_count:
                metrics["tool_calls"][tool] = count

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

async def compress_planner_context_if_needed(planner_context, llm_client):
    """检查并执行PlannerContext的压缩（如果需要）。"""
    if hasattr(planner_context, '_needs_compression') and planner_context._needs_compression:
        try:
            # 获取需要压缩的历史记录
            if len(planner_context.planning_history) > PLANNER_HISTORY_WINDOW:
                history_to_compress = planner_context.planning_history[:-PLANNER_HISTORY_WINDOW]

                # 将PlanningAttempt转换为对话格式用于压缩
                messages_to_compress = []
                for attempt in history_to_compress:
                    if attempt.llm_input_prompt:
                        messages_to_compress.append({
                            'role': 'user',
                            'content': attempt.llm_input_prompt
                        })
                    if attempt.llm_output_response:
                        messages_to_compress.append({
                            'role': 'assistant',
                            'content': attempt.llm_output_response
                        })

                if messages_to_compress:
                    # 使用LLMClient的现有压缩功能
                    summary = await llm_client.summarize_conversation(messages_to_compress)
                    if summary:
                        # 更新压缩摘要
                        if planner_context.compressed_history_summary:
                            planner_context.compressed_history_summary += "\n\n" + summary
                        else:
                            planner_context.compressed_history_summary = summary

                        # 移除已压缩的历史记录，保留窗口内的记录
                        planner_context.planning_history = planner_context.planning_history[-PLANNER_HISTORY_WINDOW:]
                        planner_context.compression_count += 1
                        planner_context._needs_compression = False

                        console.print(f"[green]✓ Planner上下文已压缩，当前压缩次数: {planner_context.compression_count}[/green]")

        except Exception as e:
            console.print(f"[yellow]⚠️ Planner上下文压缩失败: {e}[/yellow]")
            planner_context._needs_compression = False

async def compress_reflector_context_if_needed(reflector_context, llm_client):
    """检查并执行ReflectorContext的压缩（如果需要）。"""
    if hasattr(reflector_context, '_needs_compression') and reflector_context._needs_compression:
        try:
            # 获取需要压缩的反思记录
            if len(reflector_context.reflection_log) > REFLECTOR_HISTORY_WINDOW:
                insights_to_compress = reflector_context.reflection_log[:-REFLECTOR_HISTORY_WINDOW]

                # 将ReflectionInsight转换为对话格式用于压缩
                messages_to_compress = []
                for insight in insights_to_compress:
                    if insight.llm_reflection_prompt:
                        messages_to_compress.append({
                            'role': 'user',
                            'content': insight.llm_reflection_prompt
                        })
                    if insight.llm_reflection_response:
                        messages_to_compress.append({
                            'role': 'assistant',
                            'content': insight.llm_reflection_response
                        })

                if messages_to_compress:
                    # 使用LLMClient的现有压缩功能
                    summary = await llm_client.summarize_conversation(messages_to_compress)
                    if summary:
                        # 更新压缩摘要
                        if reflector_context.compressed_reflection_summary:
                            reflector_context.compressed_reflection_summary += "\n\n" + summary
                        else:
                            reflector_context.compressed_reflection_summary = summary

                        # 移除已压缩的反思记录，保留窗口内的记录
                        reflector_context.reflection_log = reflector_context.reflection_log[-REFLECTOR_HISTORY_WINDOW:]
                        reflector_context.compression_count += 1
                        reflector_context._needs_compression = False

                        console.print(f"[green]✓ Reflector上下文已压缩，当前压缩次数: {reflector_context.compression_count}[/green]")

        except Exception as e:
            console.print(f"[yellow]⚠️ Reflector上下文压缩失败: {e}[/yellow]")
            reflector_context._needs_compression = False

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
    """获取下一个可并行执行的任务批次。"""
    pending_subtasks = [
        node for node, data in graph.graph.nodes(data=True)
        if data.get('type') == 'subtask' and data.get('status') in ['pending', 'ready', 'active', 'in_progress']
    ]

    non_terminal_subtasks = [
        node for node in pending_subtasks
        if graph.graph.nodes[node].get('status') not in ['completed', 'failed', 'deprecated', 'stalled_orphan', 'completed_error']
    ]

    executable_tasks = []
    for node in non_terminal_subtasks:
        dependencies = [u for u, v in graph.graph.in_edges(node) if graph.graph.edges[u, v].get('type') == 'dependency']
        if all(str(graph.graph.nodes[dep].get('status', '')).startswith(('completed', 'deprecated', 'failed')) for dep in dependencies):
            executable_tasks.append(node)

    if not executable_tasks:
        return []

    # 返回所有可执行的任务，以提高并发效率
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
                    intervention_manager.submit_decision(op_id, "APPROVE")
                    console.print("✅ CLI: 已批准计划。")
                    break
                elif choice == 'n':
                    intervention_manager.submit_decision(op_id, "REJECT")
                    console.print("❌ CLI: 已拒绝计划。")
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
                        
                        intervention_manager.submit_decision(op_id, "MODIFY", modified_data)
                        console.print("✏️ CLI: 已提交修改后的计划。")
                        os.unlink(tf_path)
                        break
                    except Exception as e:
                        console.print(f"[bold red]修改失败: {e}[/bold red]")
                        console.print("请重试或使用 y/n。")
                        console.print("HITL > ", end="")
                else:
                    console.print("无效输入。请输入 y, n 或 m。")
                    console.print("HITL > ", end="")
                
            except Exception as e:
                console.print(f"[dim]CLI 输入错误: {e}[/dim]")
                await asyncio.sleep(1) # 出错后避让
                
    except asyncio.CancelledError:
        # 任务被取消（说明 Web 端已处理）
        console.print("\n[dim]Web 端已提交决策，CLI 审批取消。[/dim]")


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
    parser.add_argument("--web", action="store_true", help="启动内置 Web 可视化服务")
    parser.add_argument("--web-port", type=int, default=DEFAULT_WEB_PORT, help="Web 服务端口")
    parser.add_argument(
        "--output-mode", 
        type=str, 
        choices=["simple", "default", "debug"], 
        default=OUTPUT_MODE, # Use OUTPUT_MODE from config as default
        help="控制台输出模式: simple, default, debug"
    )

    args = parser.parse_args()
    goal = args.goal
    task_name = args.task_name
    log_dir = args.log_dir  # 获取传递的 log_dir

    # 确定最终的输出模式
    effective_output_mode = args.output_mode

    console.print(Panel(f"LuaN1ao Agent 启动。Task: {task_name}", title="启动信息", style="bold blue"))

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

    llm = LLMClient()

    # 如果没有提供 log_dir，使用默认逻辑
    if not log_dir:
        log_dir = os.path.join("logs", task_name, datetime.now().strftime("%Y%m%d_%H%M%S"))

    os.makedirs(log_dir, exist_ok=True)  # 确保目录存在

    # 设置LLM的op_id用于事件发送
    llm.op_id = os.path.basename(log_dir)

    # 可视化 Web 服务（可选）
    if args.web:
        try:
            import uvicorn
            from web.server import app
            import socket

            def is_port_in_use(port: int) -> bool:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    return s.connect_ex(('127.0.0.1', port)) == 0

            # 自动寻找可用端口
            web_port = args.web_port
            while is_port_in_use(web_port):
                web_port += 1
            
            async def start_web():
                config = uvicorn.Config(app, host=KNOWLEDGE_SERVICE_HOST, port=web_port, log_level="critical")
                server = uvicorn.Server(config)
                await server.serve()
            
            asyncio.create_task(start_web())
            
            web_url = f"http://{KNOWLEDGE_SERVICE_HOST}:{web_port}/?op_id={os.path.basename(log_dir)}"
            console.print(Panel(
                f"可视化 Web 服务已启动: [link={web_url}]{web_url}[/link]\n"
                f"[dim]注意: 此Web服务仅用于当前任务的可视化，随任务结束而停止。[/dim]", 
                style="bold green",
                title="Web UI"
            ))
        except Exception as e:
            console.print(Panel(f"Web 服务启动失败: {e}", style="bold red"))

    # 安全警告横幅
    console.print(Panel(
        "[bold red]⚠️ 严重安全警告：此Agent包含执行任意代码的工具！[/bold red]\n\n"
        "工具 [bold yellow]python_exec[/bold yellow] 和 [bold yellow]shell_exec[/bold yellow] 允许Agent执行系统命令和Python代码。这赋予了Agent强大的能力，但也意味着：\n"
        "- [bold yellow]存在远程代码执行 (RCE) 风险[/bold yellow]：如果Agent被恶意指令控制或在不安全环境中运行，可能对您的系统造成损害。\n"
        "- [bold yellow]不提供严格沙箱隔离[/bold yellow]：当前 Agent 在同一进程中执行，没有严格的沙箱隔离。\n\n"
        "[bold red]强烈建议您在隔离的、受控的环境中运行本Agent (例如：Docker容器或虚拟机)，并且不要在包含敏感数据或关键服务的机器上运行。[/bold red]\n\n"
        "请谨慎使用，并确保您完全理解其安全含义。",
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
        "deployment_time": 0,  # 初始化部署时间
    }
    run_log = []

    # 初始化服务，在主循环外初始化MCP会话，实现真正的持久化连接
    await initialize_sessions()
    await tool_manager.refresh_tools_async()  # 初始化工具缓存

    # 确保知识服务运行
    await ensure_knowledge_service(console)

    task_id = None # 在循环外初始化

    try:
        # 1. 初始化
        task_id = generate_task_id()
        metrics["task_id"] = task_id
        mcp_service.CURRENT_TASK_ID = task_id # 设置全局任务ID供工具使用
        console.print(Panel(f"Task: {task_name}\nTask ID: {task_id}\nGoal: {goal}", title="任务初始化", style="bold green"))
        run_log.append({"event": "task_initialized", "task_id": task_id, "goal": goal, "timestamp": time.time()})

        graph_manager = GraphManager(task_id, goal)
        # Set op_id for event emission
        graph_manager.set_op_id(os.path.basename(log_dir))
        if register_graph:
            try:
                register_graph(os.path.basename(log_dir), graph_manager, log_dir=log_dir)
            except Exception:
                pass
        # 记录部署时间（graph_manager初始化完成即视为部署完成）
        metrics["deployment_time"] = time.time() - metrics["start_time"]
        planner = Planner(llm, output_mode=effective_output_mode)
        reflector = Reflector(llm, output_mode=effective_output_mode)

        # 设置目标URL（可选字段，可根据实际情况提供）
        target_url = ""  # 如果没有特定目标URL，保持为空

        # 初始化 Planner 和 Reflector 上下文
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
        global_mission_briefing = "任务的初始目标是：" + goal # 初始化全局任务简报

        # 1. 规划 (Plan)
        console.print(Panel("进入规划阶段...", title="Planner", style="bold blue"))

        causal_graph_summary = graph_manager.get_causal_graph_summary()
        initial_ops, call_metrics = await planner.plan(goal, causal_graph_summary)
        # 增加计划步数
        if call_metrics:
            call_metrics["plan_steps"] = call_metrics.get("plan_steps", 0) + 1
        else:
            call_metrics = {"plan_steps": 1}
        update_global_metrics(metrics, call_metrics)
        run_log.append({"event": "initial_plan", "data": initial_ops, "metrics": call_metrics, "timestamp": time.time()})
        try:
            await broker.emit("graph.changed", {"reason": "initial_plan_applied"}, op_id=os.path.basename(log_dir))
        except Exception:
            pass

        # HITL: 初始计划审批
        if HUMAN_IN_THE_LOOP:
            op_id = os.path.basename(log_dir)
            
            # 通知前端有待审批请求
            try:
                await broker.emit("intervention.required", {"op_id": op_id, "type": "plan_approval"}, op_id=op_id)
            except Exception:
                pass
            
            # 启动 CLI 交互任务 (与 Web 端竞态)
            cli_task = asyncio.create_task(handle_cli_approval(op_id, initial_ops))
                
            # 阻塞等待决策（任一端提交即可解除阻塞）
            decision = await intervention_manager.request_approval(op_id, initial_ops)
            
            # 清理 CLI 任务
            if not cli_task.done():
                cli_task.cancel()
                try:
                    await cli_task
                except asyncio.CancelledError:
                    pass
            
            action = decision.get("action")
            if action == "REJECT":
                console.print("[HITL] 用户拒绝了初始计划。任务终止。", style="bold red")
                return # 退出任务
            elif action == "MODIFY":
                initial_ops = decision.get("data", [])
                console.print("[HITL] 用户修改了初始计划，应用修改后的操作。", style="bold green")
            else:
                console.print("[HITL] 用户批准了初始计划。", style="bold green")

        verified_ops = verify_and_handle_orphans(initial_ops, graph_manager, console)
        process_graph_commands(verified_ops, graph_manager)

        # 获取接下来将执行的任务，用于高亮显示
        next_executable_tasks = get_next_executable_subtask_batch(graph_manager)

        if effective_output_mode in ["default", "debug"]:
            console.print("初始计划已生成:")
        if effective_output_mode in ["simple", "default", "debug"]:
            graph_manager.print_graph_structure(console, highlight_nodes=next_executable_tasks)
        if effective_output_mode in ["default", "debug"]:
            # 输出初始因果链图谱结构，辅助后续调试与可视化
            try:
                graph_manager.print_causal_graph(console, max_nodes=100)
            except Exception as e:
                console.print(Panel(f"打印因果图失败: {e}", title="因果图错误", style="red"))
        run_log.append({"event": "initial_plan_generated", "plan": initial_ops, "timestamp": time.time()})

        # 3. 执行-反思-规划 循环
        completed_reflections = {} # 收集完成的反思输出（包含 intelligence_summary）
        while True:
            # ==================================================
            # 1. 规划阶段 (PLAN)
            # ==================================================
            if completed_reflections:
                if effective_output_mode in ["default", "debug"]:
                    console.print(Panel("汇总情报，Planner 进行战略规划...", style="yellow"))

                intelligence_summary = _aggregate_intelligence(completed_reflections)

                refreshed_summary = graph_manager.get_full_graph_summary(detail_level=1)
                causal_graph_summary = graph_manager.get_causal_graph_summary()
                attack_path_summary = graph_manager.get_attack_path_summary()
                failure_patterns_summary = graph_manager.analyze_failure_patterns()

                plan_data, call_metrics = await planner.dynamic_plan(
                goal, refreshed_summary, intelligence_summary,
                causal_graph_summary, attack_path_summary, failure_patterns_summary, graph_manager,
                planner_context=planner_context
            )
                # 输出planner的动态计划结果
                if effective_output_mode in ["default", "debug"]:
                    console.print(Panel("Planner 生成的动态计划:", title="动态计划", style="cyan"))
                    # 清理JSON输出，防止包含特殊字符导致Rich解析错误
                    safe_plan_json = sanitize_for_rich(json.dumps(plan_data, indent=2, ensure_ascii=False))
                    console.print(Panel(safe_plan_json, style="cyan"))
                # 增加计划步数
                if call_metrics:
                    call_metrics["plan_steps"] = call_metrics.get("plan_steps", 0) + 1
                else:
                    call_metrics = {"plan_steps": 1}
                update_global_metrics(metrics, call_metrics)
                run_log.append({"event": "dynamic_plan", "data": plan_data, "metrics": call_metrics, "timestamp": time.time()})

                # 检查Planner是否已宣布任务完成
                if plan_data.get("global_mission_accomplished"):
                    console.print(Panel("🎉 Planner已宣布全局任务目标达成！任务结束。", title="[bold green]任务完成[/bold green]"))
                    metrics["success_info"] = {"found": True, "reason": "Global mission accomplished signal received from Planner."}
                    dynamic_ops = plan_data.get('graph_operations', [])
                    if dynamic_ops:
                        process_graph_commands(dynamic_ops, graph_manager)
                    break # 退出主循环

                # 更新Planner上下文状态（新增）并保存完整LLM提示与响应
                try:
                    # 动态规划的Prompt和Response不再通过Planner属性持久化，此处传递None
                    last_prompt, last_response_text = None, None
                except Exception:
                    last_prompt, last_response_text = None, None
                planner_context = planner.update_planner_context_after_planning(
                    planner_context, plan_data, graph_manager, llm_prompt=last_prompt, llm_response=last_response_text
                )

                # 检查并执行Planner上下文压缩（如果需要）
                await compress_planner_context_if_needed(planner_context, llm)

                dynamic_ops = plan_data.get('graph_operations', [])
                global_mission_briefing = plan_data.get('global_mission_briefing', global_mission_briefing)

                if dynamic_ops:
                    # HITL: 动态计划审批
                    if HUMAN_IN_THE_LOOP:
                        op_id = os.path.basename(log_dir)
                        
                        try:
                            await broker.emit("intervention.required", {"op_id": op_id, "type": "plan_approval"}, op_id=op_id)
                        except Exception:
                            pass
                            
                        # 启动 CLI 交互任务
                        cli_task = asyncio.create_task(handle_cli_approval(op_id, dynamic_ops))
                        
                        decision = await intervention_manager.request_approval(op_id, dynamic_ops)
                        
                        if not cli_task.done():
                            cli_task.cancel()
                            try:
                                await cli_task
                            except asyncio.CancelledError:
                                pass
                        
                        action = decision.get("action")
                        if action == "REJECT":
                            console.print("[HITL] 用户拒绝了动态计划。跳过本次更新（可能导致停滞）。", style="bold red")
                            dynamic_ops = [] # 清空操作，继续循环
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
                        await broker.emit("graph.changed", {"reason": "dynamic_plan_applied"}, op_id=os.path.basename(log_dir))
                    except Exception:
                        pass
                    if effective_output_mode in ["default", "debug"]:
                        console.print("主任务图更新完成:")
                    if effective_output_mode in ["simple", "default", "debug"]:
                        next_executable_tasks = get_next_executable_subtask_batch(graph_manager)
                        graph_manager.print_graph_structure(console, highlight_nodes=next_executable_tasks)
                    if effective_output_mode in ["default", "debug"]:
                        # 同步输出更新后的因果链图谱结构
                        try:
                            graph_manager.print_causal_graph(console, max_nodes=100)
                        except Exception as e:
                            console.print(Panel(f"打印因果图失败: {e}", title="因果图错误", style="red"))

                # Periodically save logs after each full P-E-R cycle
                if effective_output_mode in ["default", "debug"]:
                    console.print(Panel("Saving log snapshot...", style="dim"))
                metrics["artifacts_found"] = len(graph_manager.causal_graph.nodes)
                # 记录因果链图谱节点
                metrics["causal_graph_nodes"] = list(graph_manager.causal_graph.nodes(data=True))
                save_logs(log_dir, metrics, run_log)

                completed_reflections = {}

# ==================================================
            # 2. 执行阶段 (EXECUTE)
# ==================================================
            subtask_batch = get_next_executable_subtask_batch(graph_manager)

            if not subtask_batch and not completed_reflections:
                if not graph_manager.is_goal_achieved():
                    console.print(Panel("任务全局停滞，没有可执行的子任务，但目标未达成。强制启动最终规划...", title="全局停滞", style="bold red"))
                    # 强制启动一个最终的重新规划周期
                    completed_reflections['__FORCE_REPLAN__'] = {
                        "audit_result": {"status": "STALLED", "completion_check": "All tasks are blocked or completed, but the goal is not achieved."},
                        "key_findings": ["Global task execution has stalled."],
                        "validated_nodes": [],
                        "insight": {"type": "stall_analysis", "description": "The agent is stuck. A new high-level plan is required to find an alternative path."}
                    }
                    continue
                else:
                    # 如果目标已达成，则正常结束
                    console.print(Panel("所有子任务已完成且目标已达成，任务结束。", title="任务完成", style="bold green"))
                    break

            if not subtask_batch and not completed_reflections:
                 console.print(Panel("最终规划未能产生新的可执行任务，代理已尽力，任务结束。",
                                     title="最终决策", style="bold red"))
                 break

            # Mark subtasks as in_progress visually
            for subtask_id in subtask_batch:
                graph_manager.update_node(subtask_id, {"status": "in_progress"})

            tasks = [
                asyncio.create_task(run_executor_cycle(goal, subtask_id, llm, graph_manager,
                    global_mission_briefing, log_dir=log_dir,
                    save_callback=lambda: save_logs(log_dir, metrics, run_log),
                    output_mode=effective_output_mode)) # Added output_mode
                for subtask_id in subtask_batch
            ]
            completed_results = await asyncio.gather(*tasks, return_exceptions=True)

# ==================================================
            # 3. 反思与分支级重新规划 (REFLECT & BRANCH RE-PLAN)
# ==================================================
            branches_to_replan = [] # 用于存储需要立即重新规划的分支

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
                        full_graph_summary=graph_manager.get_full_graph_summary(detail_level=1),
                        dependency_context=graph_manager.build_prompt_context(subtask_id).get("dependencies", []),
                        graph_manager=graph_manager,
                        reflector_context=reflector_context
                    )

                    update_global_metrics(metrics, reflection_output.get('metrics'))
                    run_log.append({"event": "reflection_completed", "subtask_id": subtask_id, "data": reflection_output, "metrics": reflection_output.get('metrics'), "timestamp": time.time()})

                    # 更新Reflector上下文状态（新增）
                    reflector_context = update_reflector_context_after_reflection(
                        reflector_context, reflection_output, subtask_id, result_status, graph_manager
                    )

                    # 检查并执行Reflector上下文压缩（如果需要）
                    await compress_reflector_context_if_needed(reflector_context, llm)

                    # 输出reflection_output
                    if effective_output_mode in ["default", "debug"]:
                        console.print(Panel("Reflector 输出:", title=f"子任务 {subtask_id} 反思结果", style="cyan"))
                        # 创建一个用于显示的副本，移除不必要的巨大字段
                        display_output = {k: v for k, v in reflection_output.items() if k not in ['llm_reflection_prompt', 'llm_reflection_response']}
                        # 清理JSON输出，防止包含特殊字符导致Rich解析错误
                        safe_reflection_json = sanitize_for_rich(json.dumps(display_output, indent=2, ensure_ascii=False))
                        console.print(Panel(safe_reflection_json, style="cyan"))
                    # 检查是否触发分支级重新规划
                    audit_result = reflection_output.get("audit_result", {})
                    if audit_result.get("is_strategic_failure"):
                        console.print(Panel(f"检测到子任务 {subtask_id} 的战略性失败。触发该分支的即时重新规划...", title="🚨 分支重新规划", style="bold red"))
                        branches_to_replan.append((subtask_id, reflection_output))
                    else:
                        # 只有非战略性失败才进入正常的全局规划流程
                        completed_reflections[subtask_id] = reflection_output

                    causal_graph_updates = reflection_output.get("causal_graph_updates", {})
                    if causal_graph_updates:
                        validated_updates = validate_causal_graph_updates(causal_graph_updates,
                                                                          graph_manager, subtask_id=subtask_id)
                        process_causal_graph_commands(validated_updates, graph_manager)
                        # Added causal graph print for simple mode requirement
                        if effective_output_mode in ["simple", "default", "debug"]:
                            try:
                                console.print(Panel(f"子任务 {subtask_id} 因果图更新:", title="因果图更新", style="green"))
                                graph_manager.print_causal_graph(console, max_nodes=100)
                            except Exception as e:
                                console.print(Panel(f"打印因果图失败: {e}", title="因果图错误", style="red"))

                    # 处理关键事实 (key_facts)
                    key_facts = reflection_output.get("key_facts", [])
                    if key_facts: # Key facts should always be printed, even in simple mode
                        console.print(f"🔑 Reflector 提炼出 {len(key_facts)} 个关键事实", style="bold cyan")
                        for fact in key_facts:
                            if isinstance(fact, str) and fact.strip():
                                fact_id = graph_manager.add_key_fact(fact.strip())
                                console.print(f"  ✓ 关键事实已记录: {fact[:80]}{'...' if len(fact) > 80 else ''}", style="cyan")

                    subtask_audit_status = audit_result.get("status", "FAILED")
                    # 统一转换为小写进行比较
                    status_lower = str(subtask_audit_status).lower()
                    
                    # 判断状态：completed, incomplete, 或 failed
                    if status_lower in ["completed", "pass", "goal_achieved"]:
                        new_status = "completed"
                    elif status_lower == "incomplete":
                        new_status = "pending"
                    else:
                        new_status = "failed"

                    graph_manager.update_node(subtask_id, {"status": new_status,
                                                           "summary": reflection_output.get("audit_result", {}).get("completion_check")})

                    # 子任务结束后清理暂存节点（completed 或 failed 状态都需要清理）
                    if new_status in ["completed", "failed"]:
                        graph_manager.clear_staged_causal_nodes(subtask_id)
                    # 处理因果图谱节点（来自Reflector的验证节点）
                    # new_nodes_for_exploration = reflection_output.get("causal_graph_updates", {}).get("nodes", [])
                    # if new_nodes_for_exploration:
                    #     graph_manager.update_exploration_state(new_nodes_for_exploration)

                    # 也处理validated_nodes字段（新数据结构）
                    # validated_nodes = reflection_output.get('validated_nodes', [])
                    # if validated_nodes:
                    #     graph_manager.update_exploration_state(validated_nodes)

                    # 将反思报告保存到Planner上下文，用于下一次规划（新增）
                    planner_context.latest_reflection_report = reflection_output

                except Exception as e:
                    import traceback
                    error_message = str(e)
                    console.print(Panel(f"处理子任务 {subtask_id} 结果时发生严重错误: {error_message}\n{traceback.format_exc()}", title="错误", style="bold red"))
                    graph_manager.update_node(subtask_id, {'status': 'completed_error', 'summary': f"Critical error during reflection: {error_message}"})
                    # 即使出错也清理暂存节点
                    graph_manager.clear_staged_causal_nodes(subtask_id)

            # 如果有需要立即重新规划的分支，则执行
            if branches_to_replan:
                for subtask_id, reflection in branches_to_replan:
                    if effective_output_mode in ["default", "debug"]:
                        console.print(Panel(f"正在为失败的分支 {subtask_id} 生成新计划...", title="Planner - 分支再生", style="purple"))
                    failure_reason = reflection.get("audit_result", {}).get("completion_check", "未提供具体失败原因。")

                    # 调用新的分支重新规划方法 (下一步实现)
                    branch_replan_ops, branch_replan_metrics = await planner.regenerate_branch_plan(
                        goal=goal,
                        graph_manager=graph_manager,
                        failed_branch_root_id=subtask_id,
                        failure_reason=failure_reason
                    )

                    update_global_metrics(metrics, branch_replan_metrics)
                    run_log.append({"event": "branch_replan", "subtask_id": subtask_id, "data": branch_replan_ops, "metrics": branch_replan_metrics, "timestamp": time.time()})

                    if branch_replan_ops:
                        if effective_output_mode in ["default", "debug"]:
                            console.print(f"应用为分支 {subtask_id} 生成的新计划...")
                        verified_ops = verify_and_handle_orphans(branch_replan_ops, graph_manager, console)
                        process_graph_commands(verified_ops, graph_manager)
                        try:
                            await broker.emit("graph.changed", {"reason": "branch_replan_applied"}, op_id=os.path.basename(log_dir))
                        except Exception:
                            pass
                        if effective_output_mode in ["simple", "default", "debug"]:
                            next_executable_tasks = get_next_executable_subtask_batch(graph_manager)
                            graph_manager.print_graph_structure(console, highlight_nodes=next_executable_tasks)
                        if effective_output_mode in ["default", "debug"]:
                            # 输出分支再规划后因果链图谱结构
                            try:
                                graph_manager.print_causal_graph(console, max_nodes=100)
                            except Exception as e:
                                console.print(Panel(f"打印因果图失败: {e}", title="因果图错误", style="red"))

                # 清空 completed_reflections 以防止全局规划器与分支规划冲突
                completed_reflections = {}

            # Save logs after each batch of executor cycles and reflections
            if effective_output_mode in ["default", "debug"]:
                console.print(Panel("Saving log snapshot after batch processing...", style="dim"))
            metrics["artifacts_found"] = len(graph_manager.causal_graph.nodes)
            # 记录因果链图谱节点
            metrics["causal_graph_nodes"] = list(graph_manager.causal_graph.nodes(data=True))
            save_logs(log_dir, metrics, run_log)

        # 4. 最终归档 (在主循环结束后执行)
        console.print(Panel("任务完成，开始全局反思与归档...", title="全局反思", style="bold green"))
        global_reflection = await reflector.reflect_global(graph_manager)

        global_reflection_metrics = global_reflection.get('metrics')
        # 增加全局反思步数
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
        # Ensure final logs are saved no matter what
        metrics["artifacts_found"] = len(graph_manager.causal_graph.nodes)
        # 记录因果链图谱节点
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
