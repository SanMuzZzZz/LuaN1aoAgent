import asyncio
import json
import logging
import os
import time
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from fastapi.responses import Response

# 配置 SSE 日志
_sse_logger = logging.getLogger("web.sse")

try:
    from core.events import broker
    from core.graph_manager import GraphManager
    from core.intervention import intervention_manager
except ModuleNotFoundError:
    import sys as _sys
    import os as _os
    _sys.path.append(_os.path.dirname(_os.path.dirname(__file__)))
    from core.events import broker
    from core.graph_manager import GraphManager
    from core.intervention import intervention_manager


app = FastAPI(title="LuaN1ao Web")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)


REGISTRY: Dict[str, Dict[str, Any]] = {}
TASKS: Dict[str, asyncio.Task] = {}


def _get_entry(op_id: str) -> Dict[str, Any]:
    entry = REGISTRY.get(op_id)
    if not entry:
        raise HTTPException(status_code=404, detail="op_id not found")
    return entry


def get_graph(op_id: str) -> GraphManager:
    return _get_entry(op_id)["gm"]


@app.get("/api/graph/execution")
async def api_graph_execution(op_id: str):
    if op_id not in REGISTRY:
        return {"nodes": [], "edges": []}
    gm = get_graph(op_id)
    # 返回当前主执行图的完整节点/边（不包括暂存因果节点）
    nodes = []
    edges = []
    for nid, data in gm.graph.nodes(data=True):
        # 过滤掉暂存因果节点，这些节点应该只在因果图中显示
        if data.get("is_staged_causal") or data.get("type") == "staged_causal":
            continue

        label = data.get("description") or data.get("thought") or data.get("goal") or nid
        nodes.append({
            "id": nid,
            "type": data.get("type"),
            "status": data.get("status"),
            "description": data.get("description"),
            "thought": data.get("thought"),
            "goal": data.get("goal"),
        })

    # 只添加涉及执行节点的边
    node_ids = set(n["id"] for n in nodes)
    for u, v, ed in gm.graph.edges(data=True):
        # 只添加两端都是执行节点的边
        if u in node_ids and v in node_ids:
            edges.append({
                "source": u,
                "target": v,
                "type": ed.get("type")
            })
    return {"nodes": nodes, "edges": edges}


def build_causal_node_link(gm: GraphManager) -> Dict[str, Any]:
    nodes = []
    edges = []

    # 从因果图获取已确认的节点
    for nid, data in gm.causal_graph.nodes(data=True):
        # 优先使用 title 和 description，提供更详细的信息
        label = data.get("title") or data.get("description") or data.get("node_type") or data.get("type") or nid

        # 从主图中获取节点状态（如果存在）
        main_graph_data = gm.graph.nodes.get(nid, {})
        status = data.get("status") or main_graph_data.get("status")

        # 构建节点数据，包含所有可能的字段
        node = {
            "id": nid,
            "label": label,
            "node_type": data.get("node_type") or data.get("type"),
            "status": status,
            "is_staging": False,  # 已确认节点，非暂存
            "title": data.get("title"),
            "description": data.get("description"),
            "evidence": data.get("evidence"),
            "hypothesis": data.get("hypothesis"),
            "vulnerability": data.get("vulnerability"),
            "confidence": data.get("confidence"),
            "severity": data.get("severity"),
            # Evidence 节点的特有字段
            "tool_name": data.get("tool_name"),
            "source_step_id": data.get("source_step_id"),
            "extracted_findings": data.get("extracted_findings"),
            "raw_output": data.get("raw_output"),
            # 其他可能的字段
            "cvss_score": data.get("cvss_score"),
            "cve": data.get("cve"),
            "cwe": data.get("cwe"),
            "exploit_payload": data.get("exploit_payload"),
            "exploit_type": data.get("exploit_type"),
            "expected_outcome": data.get("expected_outcome"),
            "code_snippet_hypothesis": data.get("code_snippet_hypothesis"),
            "reason": data.get("reason"),
        }

        # 添加 data 字段中的内容（如果存在）
        if "data" in data and isinstance(data["data"], dict):
            for key, value in data["data"].items():
                if key not in node:  # 避免覆盖已有字段
                    node[key] = value

        nodes.append(node)

    # 添加主图中的暂存产出物节点（staged_causal_nodes）
    # 这些是 Executor 提出但 Reflector 尚未审核确认的节点
    confirmed_node_ids = set(gm.causal_graph.nodes())

    for nid, data in gm.graph.nodes(data=True):
        # 查找标记为暂存的因果节点
        if data.get("is_staged_causal") and nid not in confirmed_node_ids:
            node_type = data.get("node_type") or data.get("type")
            status = data.get("status")

            # 只添加有效的因果节点类型
            if node_type in ["Evidence", "Hypothesis", "ConfirmedVulnerability",
                           "Vulnerability", "Exploit", "TargetArtifact",
                           "SystemImplementation", "KeyFact"]:
                label = data.get("description") or data.get("title") or data.get("hypothesis") or nid
                nodes.append({
                    "id": nid,
                    "label": label,
                    "node_type": node_type,
                    "status": status,
                    "is_staging": True,  # 标记为暂存节点
                    "description": data.get("description"),
                    "title": data.get("title"),
                    "hypothesis": data.get("hypothesis"),
                    "evidence": data.get("evidence"),
                    "vulnerability": data.get("vulnerability"),
                    "confidence": data.get("confidence"),
                    "raw_output": data.get("raw_output"),
                    "extracted_findings": data.get("extracted_findings"),
                })

    # 添加因果图中的边
    for u, v, ed in gm.causal_graph.edges(data=True):
        edges.append({"source": u, "target": v, "label": ed.get("label")})

    # 添加主图中涉及暂存节点的边
    all_node_ids = set(n["id"] for n in nodes)
    for u, v, ed in gm.graph.edges(data=True):
        if u in all_node_ids and v in all_node_ids:
            # 避免重复添加
            if not any(e["source"] == u and e["target"] == v for e in edges):
                edge_type = ed.get("type", "")
                # 只添加因果关系边
                if edge_type in ["supports", "contradicts", "explains", "derives",
                               "falsifies", "caused_by", "informs", "describes", "leads_to"]:
                    edges.append({"source": u, "target": v, "label": edge_type})

    return {"nodes": nodes, "edges": edges}


@app.get("/api/graph/causal")
async def api_graph_causal(op_id: str):
    if op_id not in REGISTRY:
        return {"nodes": [], "edges": []}
    gm = get_graph(op_id)
    return build_causal_node_link(gm)


@app.get("/api/graph/success")
async def api_graph_success(op_id: str):
    gm = get_graph(op_id)
    return gm.get_simplified_graph()


def build_execution_tree(gm: GraphManager) -> Dict[str, Any]:
    G = gm.graph
    # 以任务根节点为真正的树根，确保包含所有子任务与执行步骤
    roots = [gm.task_id] if G.has_node(gm.task_id) else []

    def node_entry(n: str) -> Dict[str, Any]:
        d = G.nodes[n]
        # 过滤暂存因果节点
        if d.get("is_staged_causal") or d.get("type") == "staged_causal":
            return None
        return {"id": n, "type": d.get("type"), "label": d.get("description") or d.get("thought") or d.get("goal") or n, "status": d.get("status")}

    # 使用访问集合防止循环引用导致无限递归
    visited = set()

    def build(n: str) -> Dict[str, Any]:
        # 检查是否已访问，防止循环
        if n in visited:
            # 返回简化节点，不继续递归
            entry = node_entry(n)
            if entry:
                return {**entry, "children": [], "_circular_ref": True}
            return None
        
        entry = node_entry(n)
        if entry is None:
            return None

        # 标记为已访问
        visited.add(n)
        
        try:
            children = []
            for _, v, ed in G.out_edges(n, data=True):
                if ed.get("type") in {"execution", "decomposition", "dependency"}:
                    child = build(v)
                    if child is not None:  # 只添加非暂存节点
                        children.append(child)

            return {**entry, "children": children}
        finally:
            # 回溯时移除访问标记（允许在不同分支中再次访问）
            visited.discard(n)

    forest = []
    for r in roots:
        tree = build(r)
        if tree is not None:
            forest.append(tree)

    if not forest and G.has_node(gm.task_id):
        entry = node_entry(gm.task_id)
        if entry is not None:
            forest = [entry]

    return {"roots": forest}


@app.get("/api/tree/execution")
async def api_tree_execution(op_id: str):
    if op_id not in REGISTRY:
        return {"roots": []}
    gm = get_graph(op_id)
    return build_execution_tree(gm)


@app.get("/api/events")
async def api_events(request: Request, op_id: str):
    if not op_id:
        async def _empty_gen():
            try:
                while not await request.is_disconnected():
                    yield {"event": "ping", "id": str(time.time()), "data": "{}"}
                    await asyncio.sleep(10)  # 进一步增加间隔时间减少连接压力
            except asyncio.CancelledError:
                pass
            except Exception:
                pass  # 静默处理所有异常
        return EventSourceResponse(_empty_gen())

    async def event_generator():
        try:
            # 等待graph准备就绪，最多等待30秒
            wait_count = 0
            while op_id not in REGISTRY and wait_count < 60:
                if await request.is_disconnected():
                    return
                yield {"event": "ping", "id": str(time.time()), "data": "{}"}
                await asyncio.sleep(0.5)
                wait_count += 1

            if op_id in REGISTRY:
                yield {"event": "graph.ready", "id": str(time.time()), "data": json.dumps({"op_id": op_id})}

                # 使用 iterator 手动控制，以便加入超时心跳
                iterator = broker.subscribe(op_id).__aiter__()
                while True:
                    if await request.is_disconnected():
                        _sse_logger.debug(f"Client disconnected during event stream for op_id='{op_id}'")
                        break
                    
                    try:
                        # 设置超时，如果在指定时间内没有新事件，则发送 ping
                        item = await asyncio.wait_for(iterator.__anext__(), timeout=15.0)
                        
                        _sse_logger.debug(f"Sending event to client: event='{item['event']}' op_id='{op_id}'")
                        yield {
                            "event": item["event"],
                            "id": str(item.get("ts")),
                            "data": json.dumps(item)
                        }
                    except asyncio.TimeoutError:
                        # 发送心跳包保持连接
                        yield {"event": "ping", "id": str(time.time()), "data": "{}"}
                    except StopAsyncIteration:
                        break
            else:
                _sse_logger.warning(f"op_id='{op_id}' not found in REGISTRY after timeout")
        except asyncio.CancelledError:
            # 正常的任务取消，不需要记录错误
            # 静默处理，避免在stderr中显示
            return  # 直接退出生成器
        except Exception as e:
            # 只有非预期的异常才记录
            import logging
            logging.warning(f"Event stream error for op_id {op_id}: {e}")
            # 发送错误事件然后关闭连接
            try:
                yield {"event": "error", "id": str(time.time()), "data": json.dumps({"error": str(e)})}
            except (asyncio.CancelledError, Exception):
                pass
        finally:
            pass

    return EventSourceResponse(event_generator())


@app.get("/api/ops/{op_id}/llm-events")
async def api_llm_events(op_id: str) -> Dict[str, Any]:
    """
    获取指定操作的缓存 LLM 事件。
    
    这个 API 端点允许前端获取在 SSE 连接建立之前就已经发生的 LLM 事件。
    
    Args:
        op_id: 操作ID
        
    Returns:
        包含缓存事件列表的字典
    """
    events = broker.get_buffered_events(op_id)
    return {
        "op_id": op_id,
        "events": events,
        "count": len(events)
    }


@app.get("/api/ops")
async def api_ops():
    items = []
    for op_id, entry in REGISTRY.items():
        gm: GraphManager = entry["gm"]
        meta = entry.get("meta", {})
        status = {
            "achieved": gm.is_goal_achieved(),
        }
        items.append({
            "op_id": op_id,
            "task_id": gm.task_id,
            "goal": gm.graph.nodes.get(gm.task_id, {}).get("goal"),
            "created_at": meta.get("created_at"),
            "log_dir": meta.get("log_dir"),
            "status": status
        })
    return {"items": items}


@app.get("/api/ops/{op_id}")
async def api_ops_detail(op_id: str):
    entry = _get_entry(op_id)
    gm: GraphManager = entry["gm"]
    meta = entry.get("meta", {})
    return {
        "op_id": op_id,
        "task_id": gm.task_id,
        "goal": gm.graph.nodes.get(gm.task_id, {}).get("goal"),
        "created_at": meta.get("created_at"),
        "log_dir": meta.get("log_dir"),
        "summary": gm.get_full_graph_summary(detail_level=0),
    }


@app.post("/api/ops")
async def api_ops_create(payload: Dict[str, Any]):
    goal = (payload.get("goal") or "").strip()
    task = (payload.get("task_name") or "web_task").strip() or "web_task"
    verbose = bool(payload.get("verbose"))
    if not goal:
        raise HTTPException(status_code=400, detail="goal required")

    ts = time.strftime("%Y%m%d_%H%M%S")
    op_id = f"{ts}_{int(time.time())%10000}"
    log_dir = os.path.join("logs", task, op_id)
    os.makedirs(log_dir, exist_ok=True)

    async def runner():
        import sys
        import agent as _agent
        argv_bak = list(sys.argv)
        try:
            sys.argv = [
                "agent.py",
                "--goal", goal,
                "--task-name", task,
                "--log-dir", log_dir,
            ] + (["--verbose"] if verbose else [])
            await _agent.main()
        except Exception:
            try:
                REGISTRY.pop(op_id, None)
            except Exception:
                pass
            raise
        finally:
            sys.argv = argv_bak

    TASKS[op_id] = asyncio.create_task(runner())
    return {"ok": True, "op_id": op_id, "log_dir": log_dir}


@app.post("/api/ops/{op_id}/abort")
async def api_ops_abort(op_id: str):
    import tempfile
    entry = _get_entry(op_id)
    gm: GraphManager = entry["gm"]
    halt_file = os.path.join(tempfile.gettempdir(), f"{gm.task_id}.halt")
    try:
        with open(halt_file, "w", encoding="utf-8") as f:
            json.dump({"op": op_id, "ts": time.time()}, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True}


@app.get("/api/ops/{op_id}/run_log")
async def api_ops_run_log(op_id: str):
    entry = _get_entry(op_id)
    log_dir = entry.get("meta", {}).get("log_dir")
    if not log_dir:
        raise HTTPException(status_code=404, detail="log_dir not available")
    path = os.path.join(log_dir, "run_log.json")
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# HITL (Human-in-the-Loop) API Endpoints
# ============================================================================

@app.get("/api/ops/{op_id}/intervention/pending")
async def api_get_pending_intervention(op_id: str):
    """获取指定任务挂起的审批请求"""
    req = intervention_manager.get_pending_request(op_id)
    return {"pending": req is not None, "request": req}


@app.post("/api/ops/{op_id}/intervention/decision")
async def api_submit_intervention_decision(op_id: str, payload: Dict[str, Any]):
    """
    提交人工决策
    Payload: { "action": "APPROVE" | "REJECT" | "MODIFY", "modified_data": ... }
    """
    action = payload.get("action")
    if action not in ["APPROVE", "REJECT", "MODIFY"]:
        raise HTTPException(status_code=400, detail="Invalid action")
    
    modified_data = payload.get("modified_data")
    
    success = intervention_manager.submit_decision(op_id, action, modified_data)
    if not success:
        raise HTTPException(status_code=404, detail="No pending request found for this op_id")
    
    return {"ok": True}


@app.post("/api/ops/{op_id}/inject_task")
async def api_inject_task(op_id: str, payload: Dict[str, Any]):
    """
    主动干预：注入新的子任务节点
    Payload: { "id": "task_name", "description": "...", "dependencies": [] }
    """
    entry = _get_entry(op_id)
    gm: GraphManager = entry["gm"]
    
    node_id = payload.get("id") or f"user_task_{int(time.time())}"
    description = payload.get("description")
    if not description:
        raise HTTPException(status_code=400, detail="Description is required")
        
    dependencies = payload.get("dependencies", [])
    
    try:
        # 使用最高优先级 100 确保尽快执行
        gm.add_subtask_node(
            node_id=node_id,
            description=description,
            dependencies=dependencies,
            priority=100,
            reason="User injected task (Active Intervention)",
            status="pending"
        )
        
        # 通知前端图更新
        try:
            await broker.emit("graph.changed", {"reason": "user_injection"}, op_id=op_id)
        except Exception:
            pass
            
        return {"ok": True, "node_id": node_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))



INDEX_HTML = """
<!doctype html>
<html>
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />
  <title>LuaN1ao Web</title>
  <style>
    :root{
      --bg-primary: #0a0e14;
      --bg-secondary: #121a25;
      --bg-tertiary: #1a2432;
      --bg-card: #0f1720;
      --text-primary: #e2e8f0;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --accent-primary: #3b82f6;
      --accent-secondary: #60a5fa;
      --accent-glow: rgba(59, 130, 246, 0.3);
      --success: #10b981;
      --warning: #f59e0b;
      --error: #ef4444;
      --pending: #6b7280;
      --border-primary: #1e293b;
      --border-secondary: #334155;
      --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
      --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
      --shadow-glow: 0 0 20px rgba(59, 130, 246, 0.15);
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 14px;
      --transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    * {
      box-sizing: border-box;
    }
    
    html,body,#app{
      height:100%;
      margin:0;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, var(--bg-primary) 0%, #0d1117 100%);
      color: var(--text-primary);
      overflow: hidden;
    }
    
    #layout{
      display: grid;
      grid-template-columns: 300px 1fr 400px;
      grid-template-rows: 64px 1fr;
      height: 100%;
      gap: 1px;
      background: var(--border-primary);
    }
    
    #topbar{
      grid-column: 1/4;
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 12px 20px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-primary);
      backdrop-filter: blur(10px);
      box-shadow: var(--shadow-md);
    }
    
    #sidebar{
      overflow: auto;
      background: var(--bg-secondary);
      border-right: 1px solid var(--border-primary);
      padding: 16px;
    }
    
    #main{
      position: relative;
      background: var(--bg-primary);
      overflow: hidden;
    }
    
    #ops{
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    
    #ops li{
      padding: 12px 16px;
      border-radius: var(--radius-md);
      background: var(--bg-card);
      cursor: pointer;
      border: 1px solid var(--border-primary);
      transition: var(--transition);
      position: relative;
      overflow: hidden;
    }
    
    #ops li::before{
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 3px;
      height: 100%;
      background: var(--accent-primary);
      transform: scaleY(0);
      transition: var(--transition);
    }
    
    #ops li:hover{
      background: var(--bg-tertiary);
      border-color: var(--border-secondary);
      transform: translateY(-1px);
      box-shadow: var(--shadow-lg);
    }
    
    #ops li.active{
      background: var(--bg-tertiary);
      border-color: var(--accent-primary);
      box-shadow: var(--shadow-glow);
    }
    
    #ops li.active::before{
      transform: scaleY(1);
    }
    
    #views{
      display: flex;
      gap: 8px;
    }
    
    .btn{
      padding: 8px 16px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-primary);
      background: var(--bg-card);
      color: var(--text-primary);
      cursor: pointer;
      transition: var(--transition);
      font-size: 14px;
      font-weight: 500;
      position: relative;
      overflow: hidden;
    }
    
    .btn:hover{
      background: var(--bg-tertiary);
      border-color: var(--accent-secondary);
      transform: translateY(-1px);
      box-shadow: var(--shadow-md);
    }
    
    .btn.active{
      background: var(--accent-primary);
      color: white;
      border-color: var(--accent-primary);
      box-shadow: var(--shadow-glow);
    }
    
    .btn:active{
      transform: translateY(0);
    }
    
    #toolbar{
      margin-left: auto;
      display: flex;
      gap: 8px;
    }
    
    #canvas{
      height: 100%;
      position: relative;
      background: radial-gradient(circle at 50% 50%, rgba(59, 130, 246, 0.02) 0%, transparent 50%);
    }
    
    #cy{
      width: 100%;
      height: 100%;
    }
    
    #legend{
      position: absolute;
      right: 20px;
      bottom: 20px;
      padding: 12px 16px;
      border-radius: var(--radius-lg);
      background: rgba(18, 25, 35, 0.95);
      border: 1px solid var(--border-primary);
      color: var(--text-secondary);
      font-size: 12px;
      backdrop-filter: blur(10px);
      box-shadow: var(--shadow-lg);
    }
    
    .dot{
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 8px;
      box-shadow: 0 0 4px currentColor;
    }
    
    #newtask{
      display: flex;
      gap: 12px;
      margin-left: 24px;
      align-items: center;
    }
    
    #newtask input{
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
      color: var(--text-primary);
      padding: 8px 12px;
      border-radius: var(--radius-md);
      font-size: 14px;
      transition: var(--transition);
      min-width: 240px;
    }
    
    #newtask input:focus{
      outline: none;
      border-color: var(--accent-primary);
      box-shadow: var(--shadow-glow);
    }
    
    #newtask input::placeholder{
      color: var(--text-muted);
    }
    
    .task-item{
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .task-title{
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 4px;
      color: var(--text-primary);
    }
    
    .task-goal{
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    
    .task-status{
      font-size: 12px;
      font-weight: 500;
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      background: var(--bg-tertiary);
    }
    
    .task-status.completed{
      background: rgba(16, 185, 129, 0.2);
      color: var(--success);
    }
    
    /* 右侧面板样式 */
    #right-panel{
      overflow: auto;
      background: var(--bg-secondary);
      border-left: 1px solid var(--border-primary);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    
    #node-detail{
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
      border-radius: var(--radius-md);
      padding: 16px;
      display: none;
    }
    
    #node-detail.show{
      display: block;
    }
    
    #node-detail h3{
      margin: 0 0 12px 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      border-bottom: 1px solid var(--border-primary);
      padding-bottom: 8px;
    }
    
    .detail-row{
      display: flex;
      margin-bottom: 12px;
      gap: 12px;
    }
    
    .detail-label{
      font-weight: 600;
      color: var(--text-secondary);
      min-width: 80px;
      font-size: 13px;
    }
    
    .detail-value{
      flex: 1;
      color: var(--text-primary);
      overflow-wrap: anywhere;
      font-size: 13px;
      line-height: 1.5;
    }
    
    #llm-output{
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
      border-radius: var(--radius-md);
      padding: 16px;
      flex: 1;
      overflow: auto;
    }
    
    #llm-output h3{
      margin: 0 0 12px 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      border-bottom: 1px solid var(--border-primary);
      padding-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .llm-stream{
      font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
      font-size: 12px;
      line-height: 1.6;
      color: var(--text-primary);
      white-space: pre-wrap;
      word-break: break-word;
    }
    
    .llm-message{
      margin-bottom: 16px;
      padding: 12px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      border-left: 3px solid var(--accent-primary);
      animation: slideIn 0.3s ease-out;
    }
    
    .llm-message.user{
      border-left-color: var(--success);
    }
    
    .llm-message.assistant{
      border-left-color: var(--accent-primary);
    }
    
    .llm-message .message-header{
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      font-size: 11px;
      color: var(--text-secondary);
    }
    
    .llm-message .message-role{
      font-weight: 600;
      text-transform: uppercase;
    }
    
    .llm-message .message-time{
      opacity: 0.7;
    }
    
    /* JSON Syntax Highlighting */
    .json-key { color: var(--accent-secondary); font-weight: 600; } /* Brighter blue for keys */
    .json-string { color: var(--success); } /* Green for strings */
    .json-number { color: var(--warning); } /* Yellow/Orange for numbers */
    .json-boolean { color: var(--error); } /* Red for booleans */
    .json-null { color: var(--text-muted); } /* Muted gray for null */
    
    .typing-indicator{
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
    }
    
    .typing-indicator span{
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent-primary);
      animation: typing 1.4s infinite;
    }
    
    .typing-indicator span:nth-child(2){
      animation-delay: 0.2s;
    }
    
    .typing-indicator span:nth-child(3){
      animation-delay: 0.4s;
    }
    
    @keyframes typing {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.7; }
      30% { transform: translateY(-10px); opacity: 1; }
    }
    
    @media (max-width: 768px) {
      #layout{
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
      }
      
      #sidebar, #right-panel{
        display: none;
      }
      
      #topbar{
        flex-wrap: wrap;
        gap: 12px;
        padding: 12px 16px;
        position: relative;
      }
      
      #views{
        order: 1;
        width: 100%;
        justify-content: center;
      }
      
      #views .btn{
        flex: 1;
        min-width: 0;
        padding: 8px 12px;
        font-size: 12px;
      }
      
      #newtask{
        margin-left: 0;
        width: 100%;
        order: 2;
        flex-direction: column;
        gap: 8px;
      }
      
      #newtask input{
        width: 100%;
        min-width: 0;
      }
      
      #toolbar{
        order: 3;
        width: 100%;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 6px;
      }
      
      #toolbar .btn{
        flex: 1;
        min-width: 0;
        padding: 6px 10px;
        font-size: 11px;
      }
      
      #toolbar > div{
        display: none;
      }
      
      #legend{
        right: 12px;
        bottom: 12px;
        padding: 8px 12px;
        font-size: 10px;
        max-width: 140px;
      }
      
      #legend > div{
        margin-bottom: 4px;
      }
      
      .dot{
        width: 8px;
        height: 8px;
        margin-right: 6px;
      }
    }
    
    @media (max-width: 480px) {
      #topbar{
        padding: 8px 12px;
      }
      
      #views .btn{
        padding: 6px 8px;
        font-size: 11px;
      }
      
      #toolbar .btn{
        padding: 5px 8px;
        font-size: 10px;
      }
      
      #newtask input{
        padding: 6px 10px;
        font-size: 12px;
      }
      
      #legend{
        right: 8px;
        bottom: 8px;
        padding: 6px 10px;
        font-size: 9px;
        max-width: 120px;
      }
    }
    
    /* 移动端侧边栏切换 */
    .sidebar-toggle {
      display: none;
      position: fixed;
      top: 50%;
      left: 0;
      transform: translateY(-50%);
      background: var(--accent-primary);
      color: white;
      border: none;
      border-radius: 0 var(--radius-md) var(--radius-md) 0;
      padding: 12px 8px;
      cursor: pointer;
      z-index: 1000;
      box-shadow: var(--shadow-lg);
      transition: var(--transition);
    }
    
    .sidebar-toggle:hover {
      background: var(--accent-secondary);
      transform: translateY(-50%) translateX(4px);
    }
    
    @media (max-width: 768px) {
      .sidebar-toggle {
        display: block;
      }
      
      #sidebar.mobile-show {
        display: block;
        position: fixed;
        top: 0;
        left: 0;
        width: 280px;
        height: 100vh;
        z-index: 999;
        box-shadow: var(--shadow-lg);
        animation: slideIn 0.3s ease-out;
      }
      
      #sidebar.mobile-show + #main::before {
        content: '';
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 998;
        animation: fadeIn 0.3s ease-out;
      }
    }
    
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    
    /* 横屏优化 */
    @media (max-height: 500px) and (orientation: landscape) {
      #topbar {
        padding: 6px 12px;
      }
      
      #views .btn, #toolbar .btn {
        padding: 4px 8px;
        font-size: 10px;
      }
      
      #legend {
        padding: 4px 8px;
        font-size: 9px;
      }
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    
    .pulse{
      animation: pulse 2s infinite;
    }
    
    @keyframes slideIn {
      from { transform: translateX(-100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    
    .slide-in{
      animation: slideIn 0.3s ease-out;
    }
    
    /* 通知样式 */
    .notification {
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 16px 20px;
      border-radius: var(--radius-md);
      color: white;
      font-weight: 500;
      z-index: 10000;
      transform: translateX(400px);
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: var(--shadow-lg);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    
    .notification.show {
      transform: translateX(0);
    }
    
    .notification.success {
      background: rgba(16, 185, 129, 0.9);
      border-color: rgba(16, 185, 129, 0.3);
    }
    
    .notification.error {
      background: rgba(239, 68, 68, 0.9);
      border-color: rgba(239, 68, 68, 0.3);
    }
    
    .notification.info {
      background: rgba(59, 130, 246, 0.9);
      border-color: rgba(59, 130, 246, 0.3);
    }
    
    .notification-icon {
      font-size: 16px;
      font-weight: bold;
    }
    
    /* 加载动画 */
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top-color: white;
      animation: spin 0.8s linear infinite;
    }
    
    /* 图表容器动画 */
    #cy {
      transition: opacity 0.3s ease;
    }
    
    #cy.loading {
      opacity: 0.6;
    }
    
    /* 按钮波纹效果 */
    .btn::after {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 0;
      height: 0;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.2);
      transform: translate(-50%, -50%);
      transition: width 0.3s, height 0.3s;
    }
    
    .btn:active::after {
      width: 300px;
      height: 300px;
    }
    
    /* HITL Intervention Modal */
    .modal-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 10000;
      backdrop-filter: blur(5px);
      opacity: 0;
      visibility: hidden;
      transition: all 0.3s ease;
    }
    
    .modal-overlay.show {
      opacity: 1;
      visibility: visible;
    }
    
    .modal-content {
      background: var(--bg-secondary);
      border: 1px solid var(--border-primary);
      border-radius: var(--radius-lg);
      width: 800px;
      max-width: 90vw;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
      box-shadow: var(--shadow-lg);
      transform: scale(0.9);
      transition: transform 0.3s ease;
    }
    
    .modal-overlay.show .modal-content {
      transform: scale(1);
    }
    
    .modal-header {
      padding: 16px 24px;
      border-bottom: 1px solid var(--border-primary);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(255, 255, 255, 0.02);
    }
    
    .modal-header h2 {
      margin: 0;
      font-size: 18px;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    
    .modal-body {
      padding: 24px;
      overflow-y: auto;
      flex: 1;
    }
    
    .modal-footer {
      padding: 16px 24px;
      border-top: 1px solid var(--border-primary);
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      background: rgba(255, 255, 255, 0.02);
    }
    
    .ops-list {
      background: var(--bg-primary);
      border: 1px solid var(--border-primary);
      border-radius: var(--radius-md);
      overflow: hidden;
    }
    
    .op-item {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-primary);
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    
    .op-item:last-child {
      border-bottom: none;
    }
    
    .op-type {
      font-weight: 600;
      font-size: 12px;
      padding: 4px 8px;
      border-radius: 4px;
      min-width: 80px;
      text-align: center;
    }
    
    .op-type.ADD_NODE { background: rgba(16, 185, 129, 0.2); color: #10b981; }
    .op-type.UPDATE_NODE { background: rgba(59, 130, 246, 0.2); color: #3b82f6; }
    .op-type.DELETE_NODE { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
    
    .op-details {
      flex: 1;
      font-size: 14px;
    }
    
    .op-node-id {
      font-family: monospace;
      color: var(--text-secondary);
      font-size: 12px;
      margin-bottom: 4px;
    }
    
    .op-desc {
      color: var(--text-primary);
    }
    
    #inject-modal .modal-content {
      width: 500px;
    }
    
    .form-group {
      margin-bottom: 16px;
    }
    
    .form-group label {
      display: block;
      margin-bottom: 8px;
      color: var(--text-secondary);
      font-size: 14px;
    }
    
    .form-group input, .form-group textarea {
      width: 100%;
      padding: 8px 12px;
      background: var(--bg-primary);
      border: 1px solid var(--border-primary);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-family: inherit;
    }
    
    .form-group textarea {
      min-height: 80px;
      resize: vertical;
    }
  </style>
  <link rel="stylesheet" href="https://unpkg.com/tippy.js@6/dist/tippy.css" />
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <!-- D3.js 核心库 -->
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <!-- D3.js 力导向图插件 -->
  <script src="https://unpkg.com/d3-force@3"></script>
  <script src="https://unpkg.com/d3-zoom@3"></script>
  <script src="https://unpkg.com/d3-drag@3"></script>
  <!-- 工具提示库 -->
  <script src="https://unpkg.com/@popperjs/core@2"></script>
  <script src="https://unpkg.com/tippy.js@6"></script>
  <!-- D3.js 样式 -->
  <style>
    .d3-graph {
      width: 100%;
      height: 100%;
      background: transparent;
    }
    
    .d3-node {
      cursor: pointer;
      transition: all 0.2s ease-out;
    }
    
    .d3-node:hover {
      filter: brightness(1.2);
    }
    
    .d3-node.highlighted {
      filter: brightness(1.3) drop-shadow(0 0 8px rgba(59, 130, 246, 0.6));
    }
    
    .d3-link {
      fill: none;
      stroke: #475569;
      stroke-width: 2;
      transition: all 0.2s ease-out;
    }
    
    .d3-link:hover {
      stroke: #60a5fa;
      stroke-width: 3;
    }
    
    .d3-node-text {
      font-size: 11px;
      fill: #e2e8f0;
      text-anchor: middle;
      dominant-baseline: middle;
      pointer-events: none;
      font-weight: 500;
    }
    
    .d3-link-text {
      font-size: 9px;
      fill: #94a3b8;
      text-anchor: middle;
      dominant-baseline: middle;
      pointer-events: none;
    }
    
    .d3-graph-controls {
      position: absolute;
      top: 20px;
      right: 20px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 1000;
    }
    
    .d3-control-btn {
      width: 36px;
      height: 36px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-primary);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      transition: var(--transition);
    }
    
    .d3-control-btn:hover {
      background: var(--bg-tertiary);
      border-color: var(--accent-secondary);
    }
  </style>
</head>
<body>
  <button class="sidebar-toggle" id="sidebar-toggle" title="切换任务列表">☰</button>
  <div id="app">
    <div id="layout">
      <div id="topbar">
        <div id="views">
          <button class="btn" data-view="exec">执行图</button>
          <button class="btn" data-view="causal">因果图</button>
          <button class="btn" data-view="tree">执行树</button>
        </div>
        <div id="newtask">
          <input id="in-goal" placeholder="目标：例如 获取 flag"/>
          <input id="in-task" placeholder="任务名：例如 web01"/>
          <button class="btn" id="btn-create">新建任务</button>
        </div>
        <div id="toolbar">
          <button class="btn" id="btn-refresh" title="刷新当前视图">
            <span style="display: inline-block; width: 16px; height: 16px;">↻</span>
            刷新
          </button>
          <button class="btn" id="btn-fit" title="适配视图到窗口">
            <span style="display: inline-block; width: 16px; height: 16px;">⤡</span>
            适配视图
          </button>
          <button class="btn" id="btn-layout" title="切换布局算法">
            <span style="display: inline-block; width: 16px; height: 16px;">⚡</span>
            布局: Dagre
          </button>
          <button class="btn" id="btn-reset-layout" title="重置所有节点到自动布局">
            <span style="display: inline-block; width: 16px; height: 16px;">↺</span>
            重置布局
          </button>
          <div style="width: 1px; height: 24px; background: var(--border-primary); margin: 0 8px;"></div>
          <button class="btn" id="btn-search" title="搜索节点">
            <span style="display: inline-block; width: 16px; height: 16px;">🔍</span>
            搜索
          </button>
          <button class="btn" id="btn-filter" title="筛选节点">
            <span style="display: inline-block; width: 16px; height: 16px;">⚙</span>
            筛选
          </button>
          <div style="width: 1px; height: 24px; background: var(--border-primary); margin: 0 8px;"></div>
          <button class="btn" id="btn-abort" title="终止当前任务" style="background: var(--error); color: white; border-color: var(--error);">
            <span style="display: inline-block; width: 16px; height: 16px;">⏹</span>
            终止执行
          </button>
          <button class="btn" id="btn-inject" title="人工添加任务" onclick="openInjectModal()" style="background: var(--accent-primary); color: white; border-color: var(--accent-primary);">
            <span style="display: inline-block; width: 16px; height: 16px;">➕</span>
            加任务
          </button>
        </div>
      </div>
      <div id="sidebar">
        <div style="margin-bottom: 16px; padding: 12px; background: var(--bg-card); border-radius: var(--radius-md); border: 1px solid var(--border-primary);">
          <h3 style="margin: 0 0 8px 0; font-size: 14px; font-weight: 600; color: var(--text-primary);">任务管理</h3>
          <div style="font-size: 12px; color: var(--text-secondary);">点击任务查看详情</div>
        </div>
        <ul id="ops"></ul>
      </div>
      <div id="main">
        <div id="canvas">
          <svg id="d3-graph" class="d3-graph"></svg>
          <div class="d3-graph-controls">
            <button class="d3-control-btn" id="btn-zoom-in" title="放大">+</button>
            <button class="d3-control-btn" id="btn-zoom-out" title="缩小">-</button>
            <button class="d3-control-btn" id="btn-zoom-reset" title="重置视图">⌂</button>
          </div>
        </div>
        <div id="legend">
          <div style="font-weight: 600; margin-bottom: 8px; color: var(--text-primary);">节点状态</div>
          <div><span class="dot" style="background:var(--success)"></span>完成</div>
          <div><span class="dot" style="background:var(--error)"></span>失败</div>
          <div><span class="dot" style="background:var(--pending)"></span>排队</div>
          <div><span class="dot" style="background:var(--accent-primary)"></span>进行中</div>
          <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-primary);">
            <div style="font-weight: 600; margin-bottom: 8px; color: var(--text-primary);">节点类型</div>
            <div><span class="dot" style="background:#f59e0b"></span>漏洞</div>
            <div><span class="dot" style="background:#8b5cf6"></span>证据</div>
            <div><span class="dot" style="background:#06b6d4"></span>假设</div>
            <div><span class="dot" style="background:#84cc16"></span>Flag</div>
          </div>
        </div>
      </div>
      <div id="right-panel">
        <div id="node-detail">
          <h3>📍 节点详情</h3>
          <div id="node-detail-content"></div>
        </div>
        <div id="llm-output">
          <h3>
            <span>🤖 LLM 输出</span>
            <div class="typing-indicator" style="display: none;">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </h3>
          <div id="llm-stream" class="llm-stream"></div>
        </div>
      </div>
    </div>
  </div>
    <!-- Approval Modal -->
    <div id="approval-modal" class="modal-overlay">
      <div class="modal-content">
        <div class="modal-header">
          <h2>
            <span style="background:var(--warning); color:black; padding:2px 8px; border-radius:4px; font-size:12px;">HITL</span>
            待审批计划
          </h2>
          <div style="font-size:12px; color:var(--text-secondary);">Agent 需要您的确认才能继续</div>
        </div>
        <div class="modal-body">
          <div style="margin-bottom: 16px; color: var(--text-secondary); font-size: 14px;">
            Planner 建议执行以下图谱操作：
          </div>
          <div id="approval-list" class="ops-list">
            <!-- Ops will be rendered here -->
          </div>
          <!-- Editable raw JSON area (hidden by default) -->
          <div id="approval-edit-area" style="display:none; margin-top:16px;">
             <div style="margin-bottom:8px; color:var(--text-secondary); font-size:14px;">直接编辑操作指令 (JSON):</div>
             <textarea id="approval-json-editor" style="width:100%; height:300px; font-family:monospace; background:var(--bg-primary); color:var(--text-primary); border:1px solid var(--border-primary); padding:8px;"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" style="background: var(--error); border-color: var(--error); color: white;" onclick="submitDecision('REJECT')">拒绝 (Reject)</button>
          <button class="btn" id="btn-modify-mode" onclick="toggleModifyMode()">修改 (Modify)</button>
          <button class="btn" style="background: var(--success); border-color: var(--success); color: white;" onclick="submitDecision('APPROVE')">批准 (Approve)</button>
        </div>
      </div>
    </div>

    <!-- Inject Task Modal -->
    <div id="inject-modal" class="modal-overlay">
      <div class="modal-content">
        <div class="modal-header">
          <h2>➕ 注入新任务 (Active Intervention)</h2>
          <button class="btn" style="padding:4px 8px;" onclick="closeInjectModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>任务ID (可选)</label>
            <input id="inject-id" placeholder="例如: scan_admin_panel">
          </div>
          <div class="form-group">
            <label>任务描述</label>
            <textarea id="inject-desc" placeholder="请详细描述要执行的任务，例如：使用 dirsearch 扫描 /admin 路径"></textarea>
          </div>
          <div class="form-group">
            <label>依赖任务ID (逗号分隔，可选)</label>
            <input id="inject-deps" placeholder="例如: web_probe_80, port_scan_443">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" onclick="closeInjectModal()">取消</button>
          <button class="btn" style="background: var(--accent-primary); color: white;" onclick="submitInjection()">提交任务</button>
        </div>
      </div>
    </div>

  <script>
    const params = new URLSearchParams(location.search)
    let op_id = params.get('op_id') || ''
    const api = (p, query)=>fetch(p+(query?('?'+new URLSearchParams(query)):'')).then(r=>r.json())
    let view = 'exec'
    let es
    let svg, simulation, g, zoom, link, node, nodeText, linkText
    
    // 定义节点颜色映射
    const nodeColors = {
      'default': '#3b82f6',
      'completed': '#10b981',
      'failed': '#ef4444',
      'pending': '#6b7280',
      'in_progress': '#3b82f6',
      'ConfirmedVulnerability': '#f59e0b',
      'Vulnerability': '#8b5cf6',
      'Evidence': '#06b6d4',
      'Hypothesis': '#84cc16',
      'KeyFact': '#fbbf24',  // 金色 - 关键事实
      'key_fact': '#fbbf24',  // 兼容旧格式
      'Flag': '#f59e0b'
    };
    
    function initD3Graph() {
      const container = document.getElementById('canvas');
      const width = container.clientWidth;
      const height = container.clientHeight;
      
      // 创建SVG
      svg = d3.select('#d3-graph')
        .attr('width', width)
        .attr('height', height);
      
      // 创建主组
      g = svg.append('g');
      
      // 设置缩放
      zoom = d3.zoom()
        .scaleExtent([0.1, 10])
        .on('zoom', (event) => {
          g.attr('transform', event.transform);
        });
      
      svg.call(zoom);
      
      // 创建力导向仿真
      simulation = d3.forceSimulation()
        .force('link', d3.forceLink().id(d => d.id).distance(150))
        .force('charge', d3.forceManyBody().strength(-800))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(35));
      
      // 缩放控制按钮
      document.getElementById('btn-zoom-in').addEventListener('click', () => {
        svg.transition().duration(300).call(zoom.scaleBy, 1.3);
      });
      
      document.getElementById('btn-zoom-out').addEventListener('click', () => {
        svg.transition().duration(300).call(zoom.scaleBy, 0.7);
      });
      
      document.getElementById('btn-zoom-reset').addEventListener('click', () => {
        svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
      });
    }
    
    function mount(){
      initD3Graph();
      
      // Load tasks and initialize view
      loadOps().then(()=>{
        if(!op_id){ 
            const first = document.querySelector('#ops li[data-op]'); 
            if(first){ 
                op_id = first.dataset.op; 
                updateQuery(); 
            }
        }
        render()
        subscribe()
      });

      // Start polling for pending interventions
      setInterval(checkPendingIntervention, 2000);
      
      // Bind other global events if needed
      document.getElementById('btn-refresh').onclick = ()=> render(true)
      
      // Keyboard shortcuts
      document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) {
          switch(e.key) {
            case 'r':
              e.preventDefault();
              render();
              showNotification('已刷新', 'success');
              break;
          }
        }
      });
    }
    
    // --- HITL Logic ---
    let currentPendingReq = null;
    let isModifyMode = false;

    async function checkPendingIntervention() {
      if (!op_id) return;
      try {
        const res = await api(`/api/ops/${op_id}/intervention/pending`);
        if (res.pending && res.request) {
           if (!currentPendingReq || currentPendingReq.id !== res.request.id) {
             currentPendingReq = res.request;
             isModifyMode = false; // Reset mode
             showApprovalModal(res.request);
           }
        } else {
           if (currentPendingReq) {
             closeApprovalModal();
             currentPendingReq = null;
           }
        }
      } catch (e) {
        console.error("Failed to check intervention", e);
      }
    }

    function showApprovalModal(req) {
      const modal = document.getElementById('approval-modal');
      const list = document.getElementById('approval-list');
      const editArea = document.getElementById('approval-edit-area');
      const jsonEditor = document.getElementById('approval-json-editor');
      const btnModify = document.getElementById('btn-modify-mode');
      
      // Reset view
      list.style.display = 'block';
      editArea.style.display = 'none';
      btnModify.innerText = '修改 (Modify)';
      btnModify.classList.remove('active');
      
      // Populate list view
      let html = '';
      if (req.type === 'plan_approval') {
        req.data.forEach(op => {
          html += `
            <div class="op-item">
              <div class="op-type ${op.command}">${op.command}</div>
              <div class="op-details">
                <div class="op-node-id">${op.node_id || (op.node_data ? op.node_data.id : '-')}</div>
                <div class="op-desc">
                  ${op.command === 'ADD_NODE' ? (op.node_data.description || '') : ''}
                  ${op.command === 'UPDATE_NODE' ? JSON.stringify(op.updates) : ''}
                  ${op.command === 'DELETE_NODE' ? (op.reason || '') : ''}
                </div>
              </div>
            </div>
          `;
        });
        // Populate JSON editor with raw data
        jsonEditor.value = JSON.stringify(req.data, null, 2);
      }
      list.innerHTML = html;
      modal.classList.add('show');
    }
    
    function toggleModifyMode() {
        isModifyMode = !isModifyMode;
        const list = document.getElementById('approval-list');
        const editArea = document.getElementById('approval-edit-area');
        const btnModify = document.getElementById('btn-modify-mode');
        
        if (isModifyMode) {
            list.style.display = 'none';
            editArea.style.display = 'block';
            btnModify.innerText = '取消修改';
            btnModify.classList.add('active');
        } else {
            list.style.display = 'block';
            editArea.style.display = 'none';
            btnModify.innerText = '修改 (Modify)';
            btnModify.classList.remove('active');
        }
    }

    function closeApprovalModal() {
      document.getElementById('approval-modal').classList.remove('show');
    }

    async function submitDecision(action) {
      if (!op_id) return;
      
      let payload = { action: action };
      
      // If action is APPROVE and we are in Modify Mode, change action to MODIFY and send new data
      if (action === 'APPROVE' && isModifyMode) {
          try {
              const modifiedJson = document.getElementById('approval-json-editor').value;
              const modifiedData = JSON.parse(modifiedJson);
              payload.action = 'MODIFY';
              payload.modified_data = modifiedData;
          } catch (e) {
              alert("JSON 格式错误，请检查输入！\\n" + e);
              return;
          }
      }
      
      try {
        await fetch(`/api/ops/${op_id}/intervention/decision`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(payload)
        });
        closeApprovalModal();
        currentPendingReq = null; // Assume processed
        showNotification(`已提交决策: ${payload.action}`, 'success');
      } catch (e) {
        showNotification(`提交失败: ${e}`, 'error');
      }
    }

    // --- Inject Task Logic ---
    function openInjectModal() {
      document.getElementById('inject-modal').classList.add('show');
    }
    
    function closeInjectModal() {
      document.getElementById('inject-modal').classList.remove('show');
      document.getElementById('inject-id').value = '';
      document.getElementById('inject-desc').value = '';
      document.getElementById('inject-deps').value = '';
    }

    async function submitInjection() {
      if (!op_id) return;
      const desc = document.getElementById('inject-desc').value.trim();
      if (!desc) {
        alert("请输入任务描述");
        return;
      }
      
      const payload = {
        id: document.getElementById('inject-id').value.trim() || null,
        description: desc,
        dependencies: document.getElementById('inject-deps').value.split(',').map(s=>s.trim()).filter(s=>s)
      };

      try {
        await fetch(`/api/ops/${op_id}/inject_task`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(payload)
        });
        closeInjectModal();
        showNotification('任务已注入', 'success');
        // Refresh graph logic usually handles via SSE, but we can force refresh if needed
      } catch (e) {
        showNotification(`注入失败: ${e}`, 'error');
      }
    }
    
    function getNodeShape(type) {
      switch(type) {
        case 'ConfirmedVulnerability': return 'diamond';
        case 'Vulnerability': return 'octagon';
        case 'Evidence': return 'rect';
        case 'Hypothesis': return 'circle';
        case 'KeyFact': return 'star';  // 星形 - 关键事实
        case 'key_fact': return 'star';  // 兼容旧格式
        case 'Flag': return 'hexagon';
        default: return 'circle';
      }
    }
    
    function getNodeColor(status, type, is_staging) {
      // 暂存节点使用较淡的颜色（透明度降低）
      if (is_staging) {
        if (status && nodeColors[status]) {
          // 为暂存节点添加半透明效果
          const baseColor = nodeColors[status];
          return baseColor + '99';  // 添加60%透明度
        }
        if (type && nodeColors[type]) {
          const baseColor = nodeColors[type];
          return baseColor + '99';
        }
        return nodeColors.default + '99';
      }
      
      // 普通节点
      if (status && nodeColors[status]) return nodeColors[status];
      if (type && nodeColors[type]) return nodeColors[type];
      return nodeColors.default;
    }
    
    function drawD3Graph(data) {
      console.log('drawD3Graph called with data:', data);
      if (!data || !data.nodes) {
        console.warn('drawD3Graph: Invalid data - nodes missing or data is null');
        return;
      }
      
      console.log('Nodes count:', data.nodes.length, 'Links count:', (data.links || data.edges || []).length);
      
      // 如果没有节点，显示一个测试节点
      if (data.nodes.length === 0) {
        console.log('No nodes found, creating test node');
        data.nodes = [{
          id: 'test-node',
          label: '测试节点',
          type: 'Hypothesis',
          status: 'completed'
        }];
      }
      
      const nodes = data.nodes.map(d => ({...d}));
      const links = (data.links || data.edges || []).map(d => ({...d}));
      
      // 计算每个节点的层级深度（用于从上到下布局）
      calculateNodeDepths(nodes, links);
      
      console.log('Checking SVG elements:');
      console.log('svg exists:', !!svg);
      console.log('g exists:', !!g);
      console.log('simulation exists:', !!simulation);
      
      if (!svg || !g || !simulation) {
        console.error('D3.js elements not properly initialized');
        return;
      }
      
      // 检查SVG尺寸
      const svgElement = document.getElementById('d3-graph');
      console.log('SVG element dimensions:', svgElement.clientWidth, 'x', svgElement.clientHeight);
      
      // 清除现有元素
      console.log('Clearing existing elements');
      g.selectAll('*').remove();
      
      // 创建箭头标记
      g.append('defs').selectAll('marker')
        .data(['end'])
        .enter().append('marker')
        .attr('id', 'arrow')
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 15)
        .attr('refY', 0)
        .attr('markerWidth', 6)
        .attr('markerHeight', 6)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-5L10,0L0,5')
        .attr('fill', '#475569');
      
      // 创建连接线
      link = g.append('g')
        .selectAll('line')
        .data(links)
        .enter().append('line')
        .attr('class', 'd3-link')
        .attr('marker-end', 'url(#arrow)');
      
      // 创建连接标签
      linkText = g.append('g')
        .selectAll('text')
        .data(links)
        .enter().append('text')
        .attr('class', 'd3-link-text')
        .text(d => d.label || '');
      
      // 创建节点组
      const nodeGroup = g.append('g')
        .selectAll('g')
        .data(nodes)
        .enter().append('g')
        .attr('class', 'd3-node')
        .call(d3.drag()
          .on('start', dragstarted)
          .on('drag', dragged)
          .on('end', dragended));
      
      // 添加节点形状
      nodeGroup.each(function(d) {
        const shape = getNodeShape(d.type || d.node_type);
        const color = getNodeColor(d.status, d.type || d.node_type, d.is_staging);
        const group = d3.select(this);
        
        switch(shape) {
          case 'diamond':
            group.append('rect')
              .attr('width', 40)
              .attr('height', 40)
              .attr('x', -20)
              .attr('y', -20)
              .attr('transform', 'rotate(45)')
              .attr('fill', color)
              .attr('stroke', d.is_staging ? '#f59e0b' : '#1e293b')  // 暂存节点使用橙色边框
              .attr('stroke-width', d.is_staging ? 3 : 2)  // 暂存节点边框更粗
              .attr('stroke-dasharray', d.is_staging ? '4,4' : 'none');  // 暂存节点使用虚线
            break;
          case 'octagon':
            group.append('polygon')
              .attr('points', '-20,-10 -10,-20 10,-20 20,-10 20,10 10,20 -10,20 -20,10')
              .attr('fill', color)
              .attr('stroke', d.is_staging ? '#f59e0b' : '#1e293b')
              .attr('stroke-width', d.is_staging ? 3 : 2)
              .attr('stroke-dasharray', d.is_staging ? '4,4' : 'none');
            break;
          case 'rect':
            group.append('rect')
              .attr('width', 50)
              .attr('height', 30)
              .attr('x', -25)
              .attr('y', -15)
              .attr('rx', 6)
              .attr('fill', color)
              .attr('stroke', d.is_staging ? '#f59e0b' : '#1e293b')
              .attr('stroke-width', d.is_staging ? 3 : 2)
              .attr('stroke-dasharray', d.is_staging ? '4,4' : 'none');
            break;
          case 'hexagon':
            group.append('polygon')
              .attr('points', '-15,-25 15,-25 25,0 15,25 -15,25 -25,0')
              .attr('fill', color)
              .attr('stroke', d.is_staging ? '#f59e0b' : '#1e293b')
              .attr('stroke-width', d.is_staging ? 3 : 2)
              .attr('stroke-dasharray', d.is_staging ? '4,4' : 'none');
            break;
          case 'star':  // 星形 - 用于 KeyFact
            // 创建五角星
            const starPoints = [];
            const outerRadius = 28;
            const innerRadius = 12;
            for (let i = 0; i < 10; i++) {
              const angle = (Math.PI * 2 * i) / 10 - Math.PI / 2;
              const radius = i % 2 === 0 ? outerRadius : innerRadius;
              const x = Math.cos(angle) * radius;
              const y = Math.sin(angle) * radius;
              starPoints.push(`${x},${y}`);
            }
            group.append('polygon')
              .attr('points', starPoints.join(' '))
              .attr('fill', color)
              .attr('stroke', d.is_staging ? '#f59e0b' : '#1e293b')
              .attr('stroke-width', d.is_staging ? 3 : 2)
              .attr('stroke-dasharray', d.is_staging ? '4,4' : 'none');
            break;
          default: // circle
            group.append('circle')
              .attr('r', 25)
              .attr('fill', color)
              .attr('stroke', d.is_staging ? '#f59e0b' : '#1e293b')  // 暂存节点使用橙色边框
              .attr('stroke-width', d.is_staging ? 3 : 2)  // 暂存节点边框更粗
              .attr('stroke-dasharray', d.is_staging ? '4,4' : 'none');  // 暂存节点使用虚线
        }
        
        // 添加状态指示器
        if (d.status === 'in_progress') {
          group.append('circle')
            .attr('r', 28)
            .attr('fill', 'none')
            .attr('stroke', '#2563eb')
            .attr('stroke-width', 2)
            .attr('stroke-dasharray', '5,5');
        }
        
        // 暂存节点添加特殊标记
        if (d.is_staging) {
          group.append('text')
            .attr('x', 20)
            .attr('y', -20)
            .attr('font-size', '16px')
            .attr('fill', '#f59e0b')
            .text('⏳');  // 沙漏图标
        }
      });
      
      // 添加节点文本（只显示简短名称）
      nodeText = nodeGroup.append('text')
        .attr('class', 'd3-node-text')
        .text(d => {
          // 优先显示简短的ID或类型，而不是完整描述
          const nodeId = d.id || '';
          const nodeType = d.type || d.node_type || '';
          
          // 如果ID较短（小于12个字符），直接显示
          if (nodeId.length > 0 && nodeId.length <= 12) {
            return nodeId;
          }
          // 如果ID太长，截取前8个字符
          if (nodeId.length > 12) {
            return nodeId.substring(0, 8) + '...';
          }
          // 如果没有ID，显示类型
          return nodeType.substring(0, 8) || 'Node';
        })
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle');
      
      // 节点事件
      nodeGroup
        .on('click', function(event, d) {
          event.stopPropagation();
          showNodeDetail(d);
          // 高亮选中节点
          g.selectAll('.d3-node').classed('highlighted', false);
          d3.select(this).classed('highlighted', true);
        })
        .on('dblclick', function(event, d) {
          // 双击节点释放固定，恢复自动布局
          event.stopPropagation();
          d.fx = null;
          d.fy = null;
          simulation.alpha(0.3).restart();
          showNotification('节点已释放，恢复自动布局', 'info');
        })
        .on('mouseover', function(event, d) {
          if (!d3.select(this).classed('highlighted')) {
            d3.select(this).style('filter', 'brightness(1.2)');
          }
          showTooltip(event, d);
        })
        .on('mouseout', function(event, d) {
          if (!d3.select(this).classed('highlighted')) {
            d3.select(this).style('filter', null);
          }
          hideTooltip();
        });
      
      // 更新力导向图
      console.log('Setting simulation nodes and links');
      simulation.nodes(nodes);
      simulation.force('link').links(links);
      simulation.alpha(1).restart();
      console.log('Simulation restarted');
      
      // 强制初始渲染
      simulation.tick(100);
      console.log('Forced initial tick');
      
      // 检查节点是否正确创建
      console.log('Node groups created:', nodeGroup.size());
      console.log('Link elements created:', link.size());
      
      // 立即更新位置以确保初始可见性
      simulation.on('tick', () => {
        console.log('Tick event fired');
        link
          .attr('x1', d => { console.log('Link x1:', d.source.x); return d.source.x; })
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);
        
        linkText
          .attr('x', d => (d.source.x + d.target.x) / 2)
          .attr('y', d => (d.source.y + d.target.y) / 2);
        
        nodeGroup.attr('transform', d => { 
          console.log('Node position:', d.id, 'x:', d.x, 'y:', d.y); 
          return `translate(${d.x},${d.y})`; 
        });
      });
      
      // 触发一次tick确保初始位置
      simulation.tick(1);
      
      console.log('Initial tick completed, elements should be visible');
    }
    
    function dragstarted(event, d) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }
    
    function dragged(event, d) {
      d.fx = event.x;
      d.fy = event.y;
    }
    
    function dragended(event, d) {
      if (!event.active) simulation.alphaTarget(0);
      // 保持节点在拖动位置，不再受力导向布局影响
      // d.fx = null;
      // d.fy = null;
      // 注释上面两行代码，使得拖动后节点固定在当前位置
    }
    
    function showTooltip(event, d) {
      const content = `
        <div style="padding: 8px; min-width: 200px;">
          <div style="font-weight: 600; color: #e2e8f0; margin-bottom: 8px; font-size: 13px;">节点详情</div>
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <div style="display: flex; justify-content: space-between;">
              <span style="color: #94a3b8;">ID:</span>
              <span style="color: #e2e8f0; font-family: monospace; font-size: 10px;">${d.id}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: #94a3b8;">类型:</span>
              <span style="color: #e2e8f0;">${d.type||d.node_type||'未知'}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: #94a3b8;">状态:</span>
              <span style="color: #e2e8f0;">${d.status||'未知'}</span>
            </div>
          </div>
        </div>
      `;
      
      // 使用Tippy.js显示工具提示
      tippy(event.target, {
        content: content,
        allowHTML: true,
        placement: 'top',
        theme: 'dark',
        arrow: true,
        interactive: true,
        showOnCreate: true,
        onHidden: instance => instance.destroy()
      });
    }
    
    function hideTooltip() {
      // Tippy.js会自动处理工具提示的隐藏
    }
    
    // 显示节点详情
    function showNodeDetail(nodeData) {
      const detailPanel = document.getElementById('node-detail');
      const detailContent = document.getElementById('node-detail-content');
      
      if (!nodeData) {
        detailPanel.classList.remove('show');
        return;
      }
      
      console.log('Showing node detail:', nodeData);  // 调试日志
      
      // 构建详情HTML - 显示所有可能的字段
      const fields = [
        { label: 'ID', value: nodeData.id },
        { label: '类型', value: nodeData.type || nodeData.node_type },
        { label: '状态', value: nodeData.status },
        { label: '标题', value: nodeData.title },
        { label: '描述', value: nodeData.description },
        { label: '思考', value: nodeData.thought },
        { label: '目标', value: nodeData.goal },
        // Evidence 节点特有字段
        { label: '工具名称', value: nodeData.tool_name },
        { label: '来源步骤', value: nodeData.source_step_id },
        { label: '提取发现', value: nodeData.extracted_findings },
        { label: '原始输出', value: nodeData.raw_output },
        // 其他字段
        { label: '证据', value: nodeData.evidence },
        { label: '假设', value: nodeData.hypothesis },
        { label: '漏洞', value: nodeData.vulnerability },
        { label: '原因', value: nodeData.reason },
        { label: '结果', value: nodeData.result },
        { label: '优先级', value: nodeData.priority },
        { label: '置信度', value: nodeData.confidence },
        { label: '严重性', value: nodeData.severity },
        { label: 'CVSS评分', value: nodeData.cvss_score },
        { label: 'CVE', value: nodeData.cve },
        { label: 'CWE', value: nodeData.cwe },
        { label: '代码片段', value: nodeData.code_snippet_hypothesis },
        { label: '漏洞利用类型', value: nodeData.exploit_type },
        { label: '漏洞利用载荷', value: nodeData.exploit_payload },
        { label: '预期结果', value: nodeData.expected_outcome },
        { label: 'URL', value: nodeData.url },
        { label: '方法', value: nodeData.method },
        { label: '参数', value: nodeData.params },
        { label: '载荷', value: nodeData.payload },
        { label: '响应', value: nodeData.response },
        { label: '创建时间', value: nodeData.created_at },
        { label: '更新时间', value: nodeData.updated_at }
      ];
      
      // 智能处理 '标签' 字段：如果它重复了其他字段的内容，则不显示
      const labelValue = nodeData.label;
      if (labelValue) {
        const duplicates = [nodeData.title, nodeData.description, nodeData.thought, nodeData.goal, nodeData.id, nodeData.type];
        // Check for duplicates with trimming and null/undefined handling
        if (!duplicates.some(val => val != null && String(val).trim() === String(labelValue).trim())) {
           // Insert '标签' field after '标题' if it exists, otherwise after 'ID', otherwise at the end
           const titleIndex = fields.findIndex(f => f.label === '标题');
           if (titleIndex !== -1) {
              fields.splice(titleIndex + 1, 0, { label: '标签', value: labelValue });
           } else {
              const idIndex = fields.findIndex(f => f.label === 'ID');
              if (idIndex !== -1) {
                 fields.splice(idIndex + 1, 0, { label: '标签', value: labelValue });
              } else {
                 fields.push({ label: '标签', value: labelValue }); // Fallback to end
              }
           }
        }
      }
      
      // 添加任何其他未列出的字段
      Object.keys(nodeData).forEach(key => {
        // 跳过已经处理的字段和内部字段
        const processedKeys = ['id', 'type', 'node_type', 'status', 'title', 'label', 'description', 
                               'thought', 'goal', 'evidence', 'hypothesis', 'vulnerability', 'reason', 
                               'result', 'priority', 'confidence', 'severity', 'cve', 'cwe', 'url', 
                               'method', 'params', 'payload', 'response', 'created_at', 'updated_at',
                               // Evidence 节点特有字段
                               'tool_name', 'source_step_id', 'extracted_findings', 'raw_output',
                               'cvss_score', 'code_snippet_hypothesis', 'exploit_type', 'exploit_payload', 'expected_outcome',
                               // D3内部字段
                               'x', 'y', 'fx', 'fy', 'vx', 'vy', 'index', 'depth'];
        
        if (!processedKeys.includes(key) && nodeData[key] != null) {
          const value = nodeData[key];
          // 跳过对象和数组（除非它们可以被字符串化）
          if (typeof value !== 'object' || value === null) {
            fields.push({ label: key, value: value });
          } else {
            try {
              fields.push({ label: key, value: JSON.stringify(value, null, 2) });
            } catch (e) {
              // 无法序列化的对象，跳过
            }
          }
        }
      });
      
      let html = '';
      let displayedCount = 0;
      
      fields.forEach(field => {
        // 只显示有值的字段（非null、非undefined、非空字符串）
        if (field.value != null && field.value !== '' && field.value !== '-') {
          const valueStr = String(field.value);
          html += `
            <div class="detail-row">
              <div class="detail-label">${escapeHtml(field.label)}:</div>
              <div class="detail-value">${escapeHtml(valueStr)}</div>
            </div>
          `;
          displayedCount++;
        }
      });
      
      if (displayedCount === 0) {
        html = '<div style="color: #94a3b8; padding: 8px;">暂无详细信息</div>';
      }
      
      detailContent.innerHTML = html;
      detailPanel.classList.add('show');
    }
    
    // HTML转义
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // JSON格式化并语法高亮函数
    function formatJsonWithSyntaxHighlighting(text) {
        try {
            const obj = JSON.parse(text);
            let jsonStr = JSON.stringify(obj, null, 2); // Pretty print and indent

            // Basic HTML escaping first to prevent XSS and ensure proper rendering
            jsonStr = jsonStr.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            // Apply syntax highlighting using a single regex to avoid nested replacements
            return '<pre><code>' + jsonStr.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
                var cls = 'json-number';
                if (/^"/.test(match)) {
                    if (/:$/.test(match)) {
                        cls = 'json-key';
                    } else {
                        cls = 'json-string';
                    }
                } else if (/true|false/.test(match)) {
                    cls = 'json-boolean';
                } else if (/null/.test(match)) {
                    cls = 'json-null';
                }
                return '<span class="' + cls + '">' + match + '</span>';
            }) + '</code></pre>';
        } catch (e) {
            // Not valid JSON, return as plain text (escaped)
            return escapeHtml(text);
        }
    }
    
    // LLM输出流式显示
    let llmMessages = [];
    
    function addLLMMessage(role, content, timestamp) {
      // Only add assistant messages for LLM output panel
      if (role !== 'assistant') {
        return;
      }
      
      const message = {
        role: role,
        content: content,
        timestamp: timestamp || new Date().toLocaleTimeString()
      };
      
      llmMessages.push(message);
      renderLLMOutput();
      
      // Auto-scroll to bottom
      const llmOutput = document.getElementById('llm-output');
      if (llmOutput) {
        setTimeout(() => {
          llmOutput.scrollTop = llmOutput.scrollHeight;
        }, 100);
      }
    }
    
    function renderLLMOutput() {
      const llmStream = document.getElementById('llm-stream');
      if (!llmStream) {
        return;
      }
      
      let html = '';
      llmMessages.forEach(msg => {
        // Only display assistant messages
        if (msg.role === 'assistant') {
          const formattedContent = formatJsonWithSyntaxHighlighting(msg.content); // Use the new formatter
          html += `
            <div class="llm-message assistant">
              <div class="message-header">
                <span class="message-role">🤖 LLM Output</span>
                <span class="message-time">${msg.timestamp}</span>
              </div>
              <div class="message-content">${formattedContent}</div>
            </div>
          `;
        }
      });
      
      llmStream.innerHTML = html;
    }
    
    function showTypingIndicator(show) {
      const indicator = document.querySelector('.typing-indicator');
      if (indicator) {
        indicator.style.display = show ? 'inline-flex' : 'none';
      }
    }
    
    // 计算节点层级深度（用于从上到下布局）
    function calculateNodeDepths(nodes, links) {
      // 初始化所有节点深度为0
      nodes.forEach(node => {
        node.depth = 0;
      });
      
      // 构建邻接表
      const adjacency = new Map();
      nodes.forEach(node => {
        adjacency.set(node.id, []);
      });
      
      links.forEach(link => {
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
        const targetId = typeof link.target === 'object' ? link.target.id : link.target;
        if (adjacency.has(sourceId)) {
          adjacency.get(sourceId).push(targetId);
        }
      });
      
      // 找到根节点（没有入边的节点）
      const hasIncoming = new Set();
      links.forEach(link => {
        const targetId = typeof link.target === 'object' ? link.target.id : link.target;
        hasIncoming.add(targetId);
      });
      
      const roots = nodes.filter(node => !hasIncoming.has(node.id));
      
      // BFS 计算每个节点的深度
      const visited = new Set();
      const queue = roots.map(node => ({ node, depth: 0 }));
      
      while (queue.length > 0) {
        const { node, depth } = queue.shift();
        
        if (visited.has(node.id)) continue;
        visited.add(node.id);
        
        node.depth = depth;
        
        const children = adjacency.get(node.id) || [];
        children.forEach(childId => {
          const childNode = nodes.find(n => n.id === childId);
          if (childNode && !visited.has(childId)) {
            queue.push({ node: childNode, depth: depth + 1 });
          }
        });
      }
      
      console.log('Node depths calculated:', nodes.map(n => ({ id: n.id, depth: n.depth })));
    }
    
    function render(){
      console.log('render() called, op_id:', op_id, 'view:', view);
      if(!op_id) {
        console.warn('No op_id found, skipping render');
        return;
      }
      
      // 添加加载状态
      const canvasElement = document.getElementById('canvas');
      if (!canvasElement) {
        console.warn('Canvas element not found');
        return;
      }
      canvasElement.classList.add('loading');
      
      console.log('Loading data for op_id:', op_id);
      
      const p1 = api('/api/graph/execution', {op_id})
        .then(data=>{ 
          console.log('Execution graph data:', data);
          if(view==='exec') {
            console.log('Drawing execution graph');
            drawExec(data); 
          }
          return data 
        })
        .catch(err => {
          console.error('执行图加载失败:', err);
          showNotification('执行图加载失败', 'error');
        })
      
      const p2 = api('/api/graph/causal', {op_id})
        .then(data=>{ 
          console.log('Causal graph data:', data);
          if(view==='causal') {
            console.log('Drawing causal graph');
            drawCausal(data); 
          }
          return data 
        })
        .catch(err => {
          console.error('因果图加载失败:', err);
          showNotification('因果图加载失败', 'error');
        })
      
      const p3 = api('/api/tree/execution', {op_id})
        .then(data=>{ 
          console.log('Execution tree data:', data);
          if(view==='tree') {
            console.log('Drawing execution tree');
            drawTree(data); 
          }
          return data 
        })
        .catch(err => {
          console.error('执行树加载失败:', err);
          showNotification('执行树加载失败', 'error');
        })
      
      Promise.all([p1,p2,p3])
        .finally(() => {
          // 移除加载状态
          if (canvasElement) {
            canvasElement.classList.remove('loading');
          }
        })
    }
    function layout(){
      if (!simulation) return;
      
      if(layoutAlgo==='dagre'){
        // D3.js 力导向布局，模拟 Dagre 的层次布局
        simulation
          .force('link', d3.forceLink().id(d => d.id).distance(120).strength(1))
          .force('charge', d3.forceManyBody().strength(-1000))
          .force('center', d3.forceCenter(svg.attr('width')/2, svg.attr('height')/2))
          .force('x', d3.forceX().x(d => {
            // 简单的层次布局模拟
            const depth = getNodeDepth(d);
            return 100 + depth * 200;
          }).strength(0.3))
          .force('y', d3.forceY().y(d => svg.attr('height')/2).strength(0.1))
          .alpha(1).restart();
      } else {
        // 标准力导向布局（类似 cose-bilkent）
        simulation
          .force('link', d3.forceLink().id(d => d.id).distance(150).strength(0.5))
          .force('charge', d3.forceManyBody().strength(-800))
          .force('center', d3.forceCenter(svg.attr('width')/2, svg.attr('height')/2))
          .force('collision', d3.forceCollide().radius(35))
          .alpha(1).restart();
      }
    }
    
    function getNodeDepth(node) {
      // 计算节点深度用于层次布局
      let depth = 0;
      let current = node;
      while (current && current.source) {
        depth++;
        current = simulation.nodes().find(n => n.id === current.source);
      }
      return depth;
    }
    function drawExec(data){
      console.log('drawExec called with data:', data);
      const nodes = (data.nodes||[]).map(n=> ({
        id: n.id,
        label: n.description||n.thought||n.goal||n.id,
        type: n.type,
        status: n.status,
        node_type: n.type,
        // 保存完整数据用于详情面板
        description: n.description,
        thought: n.thought,
        goal: n.goal
      }))
      const links = (data.links||data.edges||[]).map(e=> ({
        id: e.id||(e.source+'=>'+e.target),
        source: e.source,
        target: e.target,
        label: e.type||''
      }))
      console.log('drawExec: nodes count:', nodes.length, 'links count:', links.length);
      drawD3Graph({nodes, links});
    }
    function drawCausal(data){
      console.log('drawCausal called with data:', data);
      const nodes = (data.nodes||[]).map(n=> ({
        id: n.id,
        label: n.title||n.description||n.node_type||n.type||n.id,
        type: n.node_type||n.type,
        node_type: n.node_type||n.type,
        status: n.status,  // 添加状态
        is_staging: n.is_staging || false,  // 添加暂存标记
        // 保存完整数据用于详情面板
        title: n.title,
        description: n.description,
        evidence: n.evidence,
        hypothesis: n.hypothesis,
        vulnerability: n.vulnerability,
        thought: n.thought,
        goal: n.goal
      }))
      const links = (data.edges||[]).map(e=> ({
        id: e.id||(e.source+'=>'+e.target),
        source: e.source,
        target: e.target,
        label: e.label||''
      }))
      console.log('drawCausal: nodes count:', nodes.length, 'links count:', links.length);
      drawD3Graph({nodes, links});
    }
    function drawTree(data){
      console.log('drawTree called with data:', data);
      
      // 计算节点数量的辅助函数
      function countNodes(node) {
        if (!node) return 0;
        let count = 1;
        if (node.children && node.children.length > 0) {
          node.children.forEach(child => {
            count += countNodes(child);
          });
        }
        return count;
      }
      
      // 清空画布
      if (g) {
        g.selectAll('*').remove();
      }
      
      const roots = data.roots || [];
      if (roots.length === 0) {
        console.warn('No tree data available');
        return;
      }
      
      const container = document.getElementById('canvas');
      const width = container.clientWidth;
      const height = container.clientHeight;
      
      // 使用 D3 树形布局，紧凑的节点间距
      const treeLayout = d3.tree()
        .size([height - 80, width - 200])  // 减小边距
        .separation((a, b) => {
          // 更紧凑的同级节点间距
          return a.parent === b.parent ? 0.8 : 1.0;  // 进一步压缩
        });
      
      // 如果节点很多，动态调整树的大小
      const nodeCount = roots.reduce((sum, root) => sum + countNodes(root), 0);
      if (nodeCount > 10) {
        treeLayout.size([Math.max(height - 80, nodeCount * 25), width - 200]);  // 每节点25px
      }
      
      // 处理每个根节点
      roots.forEach((root, index) => {
        // 为每个根创建层级结构
        const hierarchy = d3.hierarchy(root, d => d.children);
        const treeData = treeLayout(hierarchy);
        
        // 计算垂直偏移（如果有多个根节点）
        const yOffset = index * (height / roots.length);
        
        // 创建连接线
        const links = g.append('g')
          .selectAll('path')
          .data(treeData.links())
          .enter().append('path')
          .attr('class', 'd3-link')
          .attr('d', d3.linkHorizontal()
            .x(d => d.y + 60)  // 减小左边距
            .y(d => d.x + 40 + yOffset))  // 减小上边距
          .attr('fill', 'none')
          .attr('stroke', '#475569')
          .attr('stroke-width', 1.5)
          .attr('stroke-opacity', 0.6);
        
        // 创建节点组
        const nodes = g.append('g')
          .selectAll('g')
          .data(treeData.descendants())
          .enter().append('g')
          .attr('class', 'd3-node')
          .attr('transform', d => 'translate(' + (d.y + 60) + ',' + (d.x + 40 + yOffset) + ')');  // 减小左边距
        
        // 添加节点圆形
        nodes.append('circle')
          .attr('r', 10)  // 进一步增大节点半径到10px
          .attr('fill', d => {
            const status = d.data.status;
            const type = d.data.type || d.data.node_type;
            if (status === 'completed') return '#10b981';
            if (status === 'failed') return '#ef4444';
            if (status === 'in_progress') return '#3b82f6';
            if (status === 'pending') return '#6b7280';
            if (type === 'ConfirmedVulnerability') return '#f59e0b';
            if (type === 'Vulnerability') return '#8b5cf6';
            if (type === 'Evidence') return '#06b6d4';
            if (type === 'Hypothesis') return '#84cc16';
            return '#3b82f6';
          })
          .attr('stroke', '#1e293b')
          .attr('stroke-width', 2.5)  // 进一步增大边框宽度
          .style('cursor', 'pointer')
          .on('click', function(event, d) {
            event.stopPropagation();
            showNodeDetail(d.data);
          });
        
        // 添加节点文本（只显示简短名称）
        nodes.append('text')
          .attr('dx', 14)  // 进一步向右偏移14px
          .attr('dy', 5)   // 进一步垂直居中微调
          .attr('text-anchor', 'start')  // 左对齐
          .attr('fill', 'var(--text-primary)')
          .attr('font-size', '12px')  // 进一步增大字体到12px
          .style('pointer-events', 'none')  // 文本不响应鼠标事件
          .text(d => {
            // 优先显示简短的ID或类型，而不是完整描述
            const nodeId = d.data.id || '';
            const nodeType = d.data.type || d.data.node_type || '';
            
            // 如果ID较短（小于15个字符），直接显示
            if (nodeId.length > 0 && nodeId.length <= 15) {
              return nodeId;
            }
            // 如果ID太长，截取前10个字符
            if (nodeId.length > 15) {
              return nodeId.substring(0, 10) + '...';
            }
            // 如果没有ID，显示类型
            return nodeType.substring(0, 10) || 'Node';
          });
      });
      
      // 调整视图以适应内容
      try {
        const bounds = g.node().getBBox();
        const scale = Math.min(
          (width - 40) / bounds.width, 
          (height - 40) / bounds.height, 
          1
        ) * 0.85;  // 留出更多边距
        const translateX = (width - bounds.width * scale) / 2 - bounds.x * scale + 20;
        const translateY = (height - bounds.height * scale) / 2 - bounds.y * scale + 20;
        
        g.attr('transform', 'translate(' + translateX + ',' + translateY + ') scale(' + scale + ')');
      } catch(e) {
        console.warn('Failed to auto-fit tree view:', e);
      }
      
      console.log('Tree layout completed');
    }
    
    // 处理单个 LLM 事件
    function handleLLMEvent(msg) {
      if (msg.event === 'llm.request' && msg.payload) {
        showTypingIndicator(true);
      }
      
      if (msg.event === 'llm.response' && msg.payload) {
        showTypingIndicator(false);
        if (msg.payload.content) {
          addLLMMessage('assistant', msg.payload.content, msg.payload.timestamp);
        }
      }
    }
    
    // 获取并显示缓存的 LLM 事件
    async function loadCachedLLMEvents() {
      try {
        const response = await fetch('/api/ops/' + encodeURIComponent(op_id) + '/llm-events');
        if (response.ok) {
          const data = await response.json();
          if (data.events && data.events.length > 0) {
            data.events.forEach(handleLLMEvent);
          }
        }
      } catch (e) {
        console.warn('Failed to load cached LLM events:', e);
      }
    }
    
    function subscribe(){
      if(es) es.close()
      es = new EventSource('/api/events?op_id='+encodeURIComponent(op_id))
      
      es.onopen = () => {
        loadCachedLLMEvents()
      }
      
      es.onmessage = (ev)=>{ 
        try{ 
          const msg = JSON.parse(ev.data); 
          
          // 处理图表更新事件
          if(['graph.changed','execution.step.completed','execution.step.started','planning.initial.completed','planning.dynamic.completed','graph.ready'].includes(msg.event)){ 
            render();
          }
          
          // 处理 LLM 输出事件
          if (msg.event === 'llm.request' || msg.event === 'llm.response') {
            handleLLMEvent(msg);
          }
          
        } catch(e) {
          console.error('Failed to parse SSE message:', e);
        } 
      }
      
      es.onerror = (err) => {
        console.warn('SSE connection error, will retry automatically')
        // 让浏览器自动重连，不要频繁重试
        if (es.readyState === EventSource.CLOSED) {
          console.log('SSE connection closed')
        }
      }
    }
    document.querySelectorAll('#views button').forEach(btn=>btn.onclick=()=>{document.querySelectorAll('#views button').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); view=btn.dataset.view; render()})
    function updateQuery(){ const u = new URL(location); u.searchParams.set('op_id', op_id); history.replaceState(null,'',u) }
    async function loadOps(){ 
      try {
        const data = await api('/api/ops'); 
        const ul = document.getElementById('ops'); 
        ul.innerHTML=''; 
        (data.items||[]).forEach(it=>{ 
          const li = document.createElement('li'); 
          li.dataset.op = it.op_id; 
          li.className = 'slide-in';
          
          const statusClass = it.status?.achieved ? 'completed' : '';
          const statusText = it.status?.achieved ? '已完成' : '进行中';
          
          li.innerHTML = `
            <div class="task-item">
              <div style="flex: 1; min-width: 0;">
                <div class="task-title">${it.op_id}</div>
                <div class="task-goal">${it.goal||'无描述'}</div>
              </div>
              <div class="task-status ${statusClass}">${statusText}</div>
            </div>
          `; 
          
          if(it.op_id===op_id) li.classList.add('active'); 
          li.onclick=()=>{ 
            document.querySelectorAll('#ops li').forEach(x=>x.classList.remove('active')); 
            li.classList.add('active'); 
            op_id = it.op_id; 
            updateQuery(); 
            subscribe(); 
            render(); 
          }; 
          ul.appendChild(li); 
        });
      } catch (err) {
        console.error('加载任务列表失败:', err);
        showNotification('加载任务列表失败', 'error');
      }
    }
    async function createTask(){ 
      const goal = document.getElementById('in-goal').value.trim(); 
      const task = document.getElementById('in-task').value.trim() || 'web_task'; 
      
      if(!goal){ 
        // 美化版提示
        showNotification('请输入目标', 'error');
        return; 
      } 
      
      // 添加加载动画
      const btn = document.getElementById('btn-create');
      const originalText = btn.textContent;
      btn.innerHTML = '<span class="pulse">创建中...</span>';
      btn.disabled = true;
      
      try {
        const r = await fetch('/api/ops', {
          method: 'POST', 
          headers: {'Content-Type': 'application/json'}, 
          body: JSON.stringify({goal, task_name: task})
        }); 
        
        const data = await r.json(); 
        
        if(!data.ok){ 
          showNotification('创建任务失败', 'error');
          return; 
        } 
        
        showNotification('任务创建成功', 'success');
        op_id = data.op_id; 
        updateQuery(); 
        await loadOps(); 
        subscribe(); 
        render(); 
        
        // 清空输入框
        document.getElementById('in-goal').value = '';
        document.getElementById('in-task').value = '';
        
      } finally {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    }
    
    function showNotification(message, type = 'info') {
      const notification = document.createElement('div');
      notification.className = `notification ${type}`;
      notification.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px;">
          <span class="notification-icon">${type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ'}</span>
          <span>${message}</span>
        </div>
      `;
      
      document.body.appendChild(notification);
      
      // 触发动画
      setTimeout(() => {
        notification.classList.add('show');
      }, 100);
      
      // 3秒后移除
      setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
          document.body.removeChild(notification);
        }, 300);
      }, 3000);
    }
    async function abortOp(){ if(!op_id) return; await fetch('/api/ops/'+encodeURIComponent(op_id)+'/abort', {method:'POST'}); }
    // 移除 initTooltips 函数 - D3.js 使用自己的工具提示系统
    mount()
  </script>
 </body>
 </html>
"""


@app.get("/", response_class=HTMLResponse)
async def index():
    return HTMLResponse(INDEX_HTML)


def register_graph(op_id: str, graph_manager: GraphManager, *, log_dir: Optional[str] = None):
    REGISTRY[op_id] = {"gm": graph_manager, "meta": {"created_at": time.time(), "log_dir": log_dir}}
    try:
        asyncio.get_running_loop().create_task(
            broker.emit("graph.ready", {"op_id": op_id}, op_id=op_id)
        )
    except RuntimeError:
        pass


def run(host: str = "127.0.0.1", port: int = 8082):
    import uvicorn
    uvicorn.run(app, host=host, port=port, access_log=False, log_level="info")


if __name__ == "__main__":
    run()



@app.get("/favicon.ico")
async def favicon():
    return Response(status_code=204)
