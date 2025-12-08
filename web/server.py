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


app = FastAPI(title="鸾鸟Agent Web")

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
    nodes = []
    edges = []
    for nid, data in gm.graph.nodes(data=True):
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
    node_ids = set(n["id"] for n in nodes)
    for u, v, ed in gm.graph.edges(data=True):
        if u in node_ids and v in node_ids:
            edges.append({"source": u, "target": v, "type": ed.get("type")})
    return {"nodes": nodes, "edges": edges}


def build_causal_node_link(gm: GraphManager) -> Dict[str, Any]:
    nodes = []
    edges = []
    for nid, data in gm.causal_graph.nodes(data=True):
        label = data.get("title") or data.get("description") or data.get("node_type") or data.get("type") or nid
        status = data.get("status") or gm.graph.nodes.get(nid, {}).get("status")
        node = {
            "id": nid,
            "label": label,
            "type": data.get("node_type") or data.get("type"),
            "node_type": data.get("node_type") or data.get("type"),
            "status": status,
            "is_staging": False,
            "title": data.get("title"),
            "description": data.get("description"),
            "evidence": data.get("evidence"),
            "hypothesis": data.get("hypothesis"),
            "vulnerability": data.get("vulnerability"),
            "confidence": data.get("confidence"),
            "severity": data.get("severity"),
        }
        if "data" in data and isinstance(data["data"], dict):
            for key, value in data["data"].items():
                if key not in node:
                    node[key] = value
        nodes.append(node)

    confirmed_node_ids = set(gm.causal_graph.nodes())
    for nid, data in gm.graph.nodes(data=True):
        if data.get("is_staged_causal") and nid not in confirmed_node_ids:
            node_type = data.get("node_type") or data.get("type")
            if node_type in ["Evidence", "Hypothesis", "ConfirmedVulnerability", "Vulnerability", "Exploit", "TargetArtifact", "SystemImplementation", "KeyFact"]:
                label = data.get("description") or data.get("title") or data.get("hypothesis") or nid
                nodes.append({
                    "id": nid,
                    "label": label,
                    "type": node_type,
                    "node_type": node_type,
                    "status": data.get("status"),
                    "is_staging": True,
                    "description": data.get("description"),
                    "title": data.get("title")
                })

    for u, v, ed in gm.causal_graph.edges(data=True):
        edges.append({"source": u, "target": v, "label": ed.get("label")})

    all_node_ids = set(n["id"] for n in nodes)
    for u, v, ed in gm.graph.edges(data=True):
        if u in all_node_ids and v in all_node_ids:
            if not any(e["source"] == u and e["target"] == v for e in edges):
                edge_type = ed.get("type", "")
                if edge_type in ["supports", "contradicts", "explains", "derives", "falsifies", "caused_by", "informs", "describes", "leads_to"]:
                    edges.append({"source": u, "target": v, "label": edge_type})
    return {"nodes": nodes, "edges": edges}


@app.get("/api/graph/causal")
async def api_graph_causal(op_id: str):
    if op_id not in REGISTRY:
        return {"nodes": [], "edges": []}
    gm = get_graph(op_id)
    return build_causal_node_link(gm)


def build_execution_tree(gm: GraphManager) -> Dict[str, Any]:
    G = gm.graph
    roots = [gm.task_id] if G.has_node(gm.task_id) else []
    def node_entry(n: str) -> Dict[str, Any]:
        d = G.nodes[n]
        if d.get("is_staged_causal") or d.get("type") == "staged_causal":
            return None
        return {"id": n, "type": d.get("type"), "label": d.get("description") or d.get("thought") or d.get("goal") or n, "status": d.get("status")}
    visited = set()
    def build(n: str) -> Dict[str, Any]:
        if n in visited:
            entry = node_entry(n)
            if entry:
                return {**entry, "children": [], "_circular_ref": True}
            return None
        entry = node_entry(n)
        if entry is None:
            return None
        visited.add(n)
        try:
            children = []
            for _, v, ed in G.out_edges(n, data=True):
                if ed.get("type") in {"execution", "decomposition", "dependency"}:
                    child = build(v)
                    if child is not None:
                        children.append(child)
            return {**entry, "children": children}
        finally:
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


# ============================================================================
# 恢复您提供的实时数据加载逻辑 (Event: message)
# ============================================================================
@app.get("/api/events")
async def api_events(request: Request, op_id: str):
    if not op_id:
        return EventSourceResponse(iter([]))

    async def event_generator():
        try:
            wait_count = 0
            while op_id not in REGISTRY and wait_count < 60:
                if await request.is_disconnected(): return
                yield {"event": "ping", "id": str(time.time()), "data": "{}"}
                await asyncio.sleep(0.5)
                wait_count += 1

            if op_id in REGISTRY:
                # 按照您的代码，统一使用 "message" 类型，载荷中包含真实 event
                yield {"event": "message", "id": str(time.time()), "data": json.dumps({"event": "graph.ready", "op_id": op_id})}
                
                iterator = broker.subscribe(op_id).__aiter__()
                while True:
                    if await request.is_disconnected(): break
                    try:
                        item = await asyncio.wait_for(iterator.__anext__(), timeout=15.0)
                        # 按照您的代码，统一使用 "message" 类型
                        yield {"event": "message", "id": str(item.get("ts")), "data": json.dumps(item)}
                    except asyncio.TimeoutError:
                        yield {"event": "message", "id": str(time.time()), "data": json.dumps({"event": "ping"})}
                    except StopAsyncIteration:
                        break
        except Exception:
            pass
    return EventSourceResponse(event_generator())


@app.get("/api/ops/{op_id}/llm-events")
async def api_llm_events(op_id: str) -> Dict[str, Any]:
    events = broker.get_buffered_events(op_id)
    return {"op_id": op_id, "events": events, "count": len(events)}


@app.get("/api/ops")
async def api_ops():
    items = []
    for op_id, entry in REGISTRY.items():
        gm: GraphManager = entry["gm"]
        meta = entry.get("meta", {})
        status = {"achieved": gm.is_goal_achieved()}
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
            sys.argv = ["agent.py", "--goal", goal, "--task-name", task, "--log-dir", log_dir] + (["--verbose"] if verbose else [])
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


@app.get("/api/ops/{op_id}/intervention/pending")
async def api_get_pending_intervention(op_id: str):
    req = intervention_manager.get_pending_request(op_id)
    return {"pending": req is not None, "request": req}


@app.post("/api/ops/{op_id}/intervention/decision")
async def api_submit_intervention_decision(op_id: str, payload: Dict[str, Any]):
    action = payload.get("action")
    modified_data = payload.get("modified_data")
    success = intervention_manager.submit_decision(op_id, action, modified_data)
    if not success:
        raise HTTPException(status_code=404, detail="No pending request found")
    return {"ok": True}


@app.post("/api/ops/{op_id}/inject_task")
async def api_inject_task(op_id: str, payload: Dict[str, Any]):
    entry = _get_entry(op_id)
    gm: GraphManager = entry["gm"]
    node_id = payload.get("id") or f"user_task_{int(time.time())}"
    description = payload.get("description")
    if not description:
        raise HTTPException(status_code=400, detail="Description is required")
    dependencies = payload.get("dependencies", [])
    try:
        gm.add_subtask_node(
            node_id=node_id,
            description=description,
            dependencies=dependencies,
            priority=100,
            reason="User injected task",
            status="pending"
        )
        try:
            await broker.emit("graph.changed", {"reason": "user_injection"}, op_id=op_id)
        except Exception:
            pass
        return {"ok": True, "node_id": node_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


INDEX_HTML = """
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>鸾鸟Agent Operation Center</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <script src="https://unpkg.com/@popperjs/core@2"></script>
  <script src="https://unpkg.com/tippy.js@6"></script>
  <link rel="stylesheet" href="https://unpkg.com/tippy.js@6/dist/tippy.css" />
  <link rel="stylesheet" href="https://unpkg.com/tippy.js@6/themes/light.css" />

  <style>
    :root {
      --bg-app: #0f172a; --bg-panel: #1e293b; --bg-card: #334155; --bg-input: #0f172a;
      --border-color: #334155; --border-highlight: #475569;
      --text-main: #f1f5f9; --text-muted: #94a3b8;
      --accent-primary: #3b82f6; --accent-glow: rgba(59, 130, 246, 0.4);
      --success: #10b981; --warning: #f59e0b; --error: #ef4444;
      --font-ui: 'Inter', system-ui, sans-serif; --font-code: 'JetBrains Mono', monospace;
    }
    * { box-sizing: border-box; outline: none; }
    html, body { height: 100%; margin: 0; font-family: var(--font-ui); background: var(--bg-app); color: var(--text-main); overflow: hidden; font-size: 13px; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #475569; border-radius: 3px; }

    #app { display: flex; flex-direction: column; height: 100vh; }
    #topbar { height: 56px; background: rgba(30, 41, 59, 0.9); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border-color); display: flex; align-items: center; padding: 0 20px; gap: 16px; flex-shrink: 0; z-index: 50; }
    .brand { font-weight: 700; font-size: 16px; color: var(--accent-primary); display: flex; align-items: center; gap: 8px; margin-right: 12px; }
    #layout { display: flex; flex: 1; overflow: hidden; }
    #sidebar { width: 280px; background: var(--bg-app); border-right: 1px solid var(--border-color); display: flex; flex-direction: column; flex-shrink: 0; }
    #main { flex: 1; position: relative; background-color: #0b1120; background-image: radial-gradient(#334155 1px, transparent 1px); background-size: 24px 24px; overflow: hidden; }
    #right-panel { width: 420px; background: var(--bg-panel); border-left: 1px solid var(--border-color); display: flex; flex-direction: column; flex-shrink: 0; }

    .btn { height: 32px; padding: 0 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-muted); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
    .btn:hover { background: #475569; color: white; }
    .btn.active { background: rgba(59, 130, 246, 0.15); border-color: var(--accent-primary); color: var(--accent-primary); }
    .btn-primary { background: var(--accent-primary); border-color: var(--accent-primary); color: white; }
    .btn-primary:hover { background: #2563eb; }
    .btn-danger { color: var(--error); border-color: rgba(239, 68, 68, 0.3); }
    
    input, textarea { background: var(--bg-input); border: 1px solid var(--border-color); color: var(--text-main); border-radius: 6px; padding: 6px 10px; transition: all 0.2s; }
    input:focus, textarea:focus { border-color: var(--accent-primary); }

    #ops { padding: 8px; margin: 0; list-style: none; overflow-y: auto; flex: 1; }
    .task-card { padding: 12px; margin-bottom: 8px; background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 8px; cursor: pointer; transition: all 0.2s; position: relative; }
    .task-card:hover { border-color: #64748b; }
    .task-card.active { border-color: var(--accent-primary); background: linear-gradient(90deg, rgba(59,130,246,0.1) 0%, rgba(30,41,59,0) 100%); }
    .task-card.active::before { content:''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--accent-primary); }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }

    .panel-header { padding: 0 16px; height: 40px; background: rgba(15, 23, 42, 0.5); border-bottom: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    .panel-content { flex: 1; overflow-y: auto; position: relative; }
    
    .detail-table td { padding: 6px 12px; border-bottom: 1px solid #334155; vertical-align: top; font-size: 12px; }
    .detail-key { width: 90px; color: var(--text-muted); text-align: right; }
    .detail-val { color: #e2e8f0; font-family: var(--font-code); word-break: break-all; white-space: pre-wrap; }

    #llm-output-container { background: #0d1117; flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .llm-msg { padding: 12px 16px; border-bottom: 1px solid #21262d; font-family: var(--font-ui); font-size: 13px; line-height: 1.5; }
    .llm-msg.user { background: rgba(59, 130, 246, 0.05); border-left: 3px solid var(--accent-primary); }
    .llm-msg.assistant { border-left: 3px solid var(--success); }
    .msg-meta { font-size: 10px; color: #6e7681; margin-bottom: 8px; display: flex; justify-content: space-between; font-family: var(--font-code); }
    
    .system-msg { padding: 10px 16px; border-bottom: 1px solid #334155; background: rgba(30, 41, 59, 0.3); font-size: 12px; }
    
    .thought-card, .op-card { background: rgba(51, 65, 85, 0.3); border-radius: 6px; padding: 10px; margin-bottom: 10px; border: 1px solid #334155; }
    .thought-header { color: var(--accent-primary); font-weight: 600; margin-bottom: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px; }
    .thought-item { margin-bottom: 6px; }
    .thought-key { color: var(--text-muted); font-size: 11px; display: block; margin-bottom: 2px; }
    .thought-val { color: #e2e8f0; white-space: pre-wrap; font-family: var(--font-ui); }

    .op-list { display: flex; flex-direction: column; gap: 6px; }
    .op-card-inner { background: rgba(15, 23, 42, 0.6); padding: 8px; border-radius: 4px; border: 1px solid #334155; display: flex; gap: 10px; align-items: flex-start; }
    .op-badge { font-size: 10px; font-family: var(--font-code); padding: 2px 6px; border-radius: 4px; background: rgba(16, 185, 129, 0.2); color: var(--success); white-space: nowrap; }
    .op-desc { font-size: 12px; color: #cbd5e1; }
    .op-id { font-family: var(--font-code); font-size: 10px; color: var(--text-muted); margin-bottom: 2px; }
    .op-details { margin-top: 4px; font-family: var(--font-code); font-size: 11px; color: #94a3b8; background: #0f172a; padding: 4px; border-radius: 4px; white-space: pre-wrap; }

    .audit-header { color: #ec4899; } /* Pink */
    .audit-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; background: #334155; color: white; margin-bottom: 8px; }
    .audit-issues { margin-top: 8px; border-left: 2px solid #ef4444; padding-left: 8px; }
    .audit-issue-item { font-size: 12px; color: #fca5a5; margin-bottom: 4px; }

    .raw-data-block { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #334155; }
    .raw-data-header { font-size: 10px; color: #64748b; margin-bottom: 4px; text-transform: uppercase; }
    .raw-data-content { font-family: var(--font-code); font-size: 11px; color: #94a3b8; white-space: pre-wrap; }
    
    .status-item { display: inline-flex; align-items: center; gap:6px; background:rgba(255,255,255,0.05); padding:4px 8px; border-radius:4px; font-size:11px; color:#cbd5e1; border:1px solid #334155; margin-right:6px; margin-bottom:6px; }
    .status-check { color: var(--success); } .status-cross { color: var(--error); }

    .tool-output { background: #0b1120; border: 1px solid #1e293b; padding: 8px; border-radius: 4px; font-family: var(--font-code); font-size: 11px; color: #a5d6ff; white-space: pre-wrap; max-height: 200px; overflow-y: auto; }

    .d3-node circle, .d3-node rect, .d3-node polygon { transition: all 0.3s; cursor: pointer; }
    .d3-node:hover { filter: drop-shadow(0 0 6px var(--accent-primary)); }
    .d3-link { stroke: #475569; stroke-width: 1.5; opacity: 0.6; fill: none; }

    @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7); } 70% { box-shadow: 0 0 0 10px rgba(59, 130, 246, 0); } 100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); } }
    .node-running circle { animation: pulse 2s infinite; stroke: var(--accent-primary); stroke-width: 2px; }

    .floating-panel { position: absolute; background: rgba(15, 23, 42, 0.9); border: 1px solid var(--border-color); border-radius: 8px; padding: 10px; backdrop-filter: blur(4px); }
    #legend { bottom: 20px; right: 20px; } #controls { top: 20px; right: 20px; display: flex; flex-direction: column; gap: 6px; }
    .legend-item { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 11px; color: var(--text-muted); }
    .legend-dot { width: 10px; height: 10px; border-radius: 2px; }

    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(2px); z-index: 100; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: 0.2s; visibility: hidden; }
    .modal-overlay.show { opacity: 1; pointer-events: auto; visibility: visible; }
    .modal-box { background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 12px; width: 600px; max-width: 90vw; max-height: 85vh; display: flex; flex-direction: column; transform: translateY(20px); transition: 0.2s; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); }
    .modal-overlay.show .modal-box { transform: translateY(0); }
    .modal-body { padding: 20px; overflow-y: auto; }
    .modal-footer { padding: 16px 20px; background: rgba(0,0,0,0.2); border-top: 1px solid var(--border-color); display: flex; justify-content: flex-end; gap: 10px; }
    
    .plan-item { background: var(--bg-app); border: 1px solid var(--border-color); padding: 10px; border-radius: 6px; margin-bottom: 8px; display: flex; gap: 10px; }
    .plan-tag { padding: 2px 6px; border-radius: 4px; font-family: var(--font-code); font-size: 10px; font-weight: bold; height: fit-content; }
    .plan-tag.ADD_NODE { background: rgba(16, 185, 129, 0.2); color: var(--success); }
    .plan-tag.UPDATE_NODE { background: rgba(59, 130, 246, 0.2); color: var(--accent-primary); }
    .toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%) translateY(-100%); background: var(--bg-card); border: 1px solid var(--border-highlight); padding: 8px 16px; border-radius: 50px; display: flex; align-items: center; gap: 8px; z-index: 200; transition: 0.3s; }
    .toast.show { transform: translateX(-50%) translateY(0); }
    .json-number { color: #79c0ff; } .json-key { color: #7ee787; } .json-string { color: #a5d6ff; } .json-boolean { color: #ff7b72; }
  </style>
</head>
<body>

<div id="app">
  <header id="topbar">
    <div class="brand">
      <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.384-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" /></svg>
      鸾鸟Agent
    </div>
    <div style="width:1px;height:24px;background:var(--border-color)"></div>
    <div class="flex gap-2">
      <button class="btn active" data-view="exec" onclick="switchView('exec')">执行图</button>
      <button class="btn" data-view="causal" onclick="switchView('causal')">因果图</button>
      <button class="btn" data-view="tree" onclick="switchView('tree')">执行树</button>
    </div>
    <div style="flex:1"></div>
    <div class="flex gap-2 items-center">
      <input id="in-goal" placeholder="输入目标..." style="width: 200px;">
      <input id="in-task" placeholder="任务ID" style="width: 80px;">
      <button class="btn btn-primary" onclick="createTask()">新建</button>
    </div>
    <div style="width:1px;height:24px;background:var(--border-color);margin:0 10px;"></div>
    <div class="flex gap-2">
      <button class="btn" onclick="openInjectModal()" title="注入任务">Inject</button>
      <button class="btn" onclick="render(true)" title="刷新">Refresh</button>
      <button class="btn btn-danger" onclick="abortOp()" title="终止">Stop</button>
    </div>
  </header>

  <div id="layout">
    <aside id="sidebar">
      <div class="panel-header">Operations</div>
      <ul id="ops"></ul>
    </aside>

    <main id="main">
      <svg id="d3-graph" width="100%" height="100%"></svg>
      <div id="controls" class="floating-panel">
        <button class="btn" onclick="zoomIn()">+</button>
        <button class="btn" onclick="zoomOut()">-</button>
        <button class="btn" onclick="zoomReset()">Fit</button>
      </div>
      <div id="legend" class="floating-panel">
        <div style="font-weight:600;margin-bottom:6px;font-size:10px;text-transform:uppercase">Legend</div>
        <div id="legend-content"></div>
      </div>
    </main>

    <aside id="right-panel">
      <div style="flex: 0 0 45%; display: flex; flex-direction: column; border-bottom: 1px solid var(--border-color);">
        <div class="panel-header">Node Details</div>
        <div id="node-detail-content" class="panel-content" style="padding:0;">
          <div style="padding:20px;color:var(--text-muted);text-align:center">Select a node</div>
        </div>
      </div>
      <div id="llm-output-container">
        <div class="panel-header">
          <span>Agent Logs (Output Only)</span>
          <span id="typing-indicator" style="display:none;color:var(--success)">● Live</span>
        </div>
        <div id="llm-stream" class="panel-content"></div>
      </div>
    </aside>
  </div>
</div>

<div id="inject-modal" class="modal-overlay">
  <div class="modal-box">
    <div class="panel-header" style="background:transparent;border:none;padding:24px 24px 0;">
      <h2 style="font-size:16px;">Inject Task</h2>
    </div>
    <div class="modal-body">
      <div class="mb-4"><label class="block text-xs text-gray-400 mb-1">Description</label><textarea id="inject-desc" class="w-full bg-slate-800 border border-slate-600 rounded p-2 text-white h-24"></textarea></div>
      <div class="mb-4"><label class="block text-xs text-gray-400 mb-1">Dependencies (IDs)</label><input id="inject-deps" class="w-full bg-slate-800 border border-slate-600 rounded p-2 text-white"></div>
    </div>
    <div class="modal-footer"><button class="btn" onclick="closeModals()">Cancel</button><button class="btn btn-primary" onclick="submitInjection()">Inject</button></div>
  </div>
</div>

<div id="approval-modal" class="modal-overlay">
  <div class="modal-box" style="width:700px;">
    <div class="panel-header" style="background:var(--warning);color:#000;border:none;">HITL Approval Required</div>
    <div class="modal-body">
      <div style="margin-bottom:12px;color:var(--text-muted)">Agent proposed plan:</div>
      <div id="approval-list" style="max-height:300px;overflow-y:auto;"></div>
      <div id="approval-edit-area" style="display:none;"><textarea id="approval-json-editor" style="width:100%;height:300px;font-family:var(--font-code);background:var(--bg-app);color:var(--text-main);border:1px solid var(--border-color);padding:10px;"></textarea></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-danger" onclick="submitDecision('REJECT')">Reject</button>
      <div style="flex:1"></div>
      <button class="btn" id="btn-modify-mode" onclick="toggleModifyMode()">Modify</button>
      <button class="btn btn-primary" onclick="submitDecision('APPROVE')">Approve</button>
    </div>
  </div>
</div>

<script>
  const nodeColors = { 'default': '#3b82f6', 'completed': '#10b981', 'failed': '#ef4444', 'pending': '#64748b', 'in_progress': '#3b82f6', 'ConfirmedVulnerability': '#f59e0b', 'Vulnerability': '#a855f7', 'Evidence': '#06b6d4', 'Hypothesis': '#84cc16', 'KeyFact': '#fbbf24', 'Flag': '#ef4444' };
  let state = { op_id: new URLSearchParams(location.search).get('op_id') || '', view: 'exec', simulation: null, svg: null, g: null, zoom: null, es: null, processedEvents: new Set(), pendingReq: null, isModifyMode: false };
  const api = (p, b) => fetch(p + (p.includes('?')?'&':'?') + `op_id=${state.op_id}`, b ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:{}).then(r=>r.json());

  document.addEventListener('DOMContentLoaded', () => {
    initD3();
    loadOps().then(() => { if(!state.op_id) { const f = document.querySelector('.task-card'); if(f) selectOp(f.dataset.op); } else selectOp(state.op_id, false); });
    setInterval(checkPendingIntervention, 2000);
  });

  async function loadOps() {
    try {
      const data = await fetch('/api/ops').then(r=>r.json());
      const list = document.getElementById('ops'); list.innerHTML = '';
      data.items.forEach(i => {
        const li = document.createElement('li'); li.className = `task-card ${i.op_id === state.op_id ? 'active' : ''}`; li.dataset.op = i.op_id; li.onclick = () => selectOp(i.op_id);
        const color = i.status.achieved ? 'var(--success)' : (i.status.failed ? 'var(--error)' : 'var(--accent-primary)');
        li.innerHTML = `<div class="flex justify-between mb-1"><span style="font-family:monospace;font-size:10px;opacity:0.7">#${i.op_id.slice(-4)}</span><span class="status-dot" style="background:${color}"></span></div><div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${i.goal}</div>`;
        list.appendChild(li);
      });
    } catch(e) {}
  }

  function selectOp(id, refresh=true) {
    if(!id) return; state.op_id = id;
    document.querySelectorAll('.task-card').forEach(el => el.classList.toggle('active', el.dataset.op === id));
    history.replaceState(null, '', `?op_id=${id}`);
    document.getElementById('llm-stream').innerHTML = '';
    document.getElementById('node-detail-content').innerHTML = '<div style="padding:20px;text-align:center;color:#64748b">Loading...</div>';
    if(state.es) state.es.close(); subscribe(); render(); if(refresh) loadOps();
  }

  async function render(force) {
    if(!state.op_id) return;
    try {
      let data;
      if(state.view === 'exec') data = await api('/api/graph/execution');
      else if(state.view === 'causal') data = await api('/api/graph/causal');
      else if(state.view === 'tree') data = await api('/api/tree/execution');
      if(state.view === 'tree') drawTree(data); else drawForceGraph(data);
      updateLegend();
    } catch(e) { console.error(e); }
  }

  function switchView(v) { state.view = v; document.querySelectorAll('#topbar .btn[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === v)); render(); }

  function initD3() {
    const c = document.getElementById('main');
    state.svg = d3.select('#d3-graph').attr('viewBox', [0, 0, c.clientWidth, c.clientHeight]);
    state.g = state.svg.append('g');
    state.zoom = d3.zoom().scaleExtent([0.1, 4]).on('zoom', e => state.g.attr('transform', e.transform));
    state.svg.call(state.zoom);
    state.svg.append("defs").append("marker").attr("id","arrow").attr("viewBox","0 -5 10 10").attr("refX",22).attr("refY",0).attr("markerWidth",6).attr("markerHeight",6).attr("orient","auto").append("path").attr("d","M0,-5L10,0L0,5").attr("fill","#475569");
  }

  function drawForceGraph(data) {
    if(!data || !data.nodes) return;
    state.g.selectAll("*").remove();
    const nodes = data.nodes.map(d => ({...d})), links = (data.edges||[]).map(d => ({...d}));
    const adj = {}, inDegree = {};
    nodes.forEach(n => { adj[n.id] = []; inDegree[n.id] = 0; n.level = 0; });
    links.forEach(l => { const s = l.source.id||l.source, t = l.target.id||l.target; if(adj[s]) adj[s].push(t); if(inDegree[t] !== undefined) inDegree[t]++; });
    const queue = nodes.filter(n => inDegree[n.id] === 0);
    if(queue.length === 0 && nodes.length > 0) queue.push(nodes[0]);
    const visited = new Set(queue.map(n => n.id));
    while(queue.length > 0) {
      const n = queue.shift(), children = adj[n.id] || [];
      children.forEach(childId => { const child = nodes.find(x => x.id === childId); if(child && !visited.has(child.id)) { child.level = (n.level||0) + 1; visited.add(child.id); queue.push(child); } });
    }
    state.simulation = d3.forceSimulation(nodes).force("link", d3.forceLink(links).id(d => d.id).distance(80)).force("charge", d3.forceManyBody().strength(-300)).force("y", d3.forceY(d => (d.level||0) * 80).strength(1)).force("x", d3.forceX(state.svg.node().clientWidth/2).strength(0.05)).force("collide", d3.forceCollide().radius(30));
    const link = state.g.append("g").selectAll("line").data(links).join("line").attr("class", "d3-link").attr("marker-end", "url(#arrow)");
    const node = state.g.append("g").selectAll("g").data(nodes).join("g").attr("class", "d3-node").call(d3.drag().on("start",dragstarted).on("drag",dragged).on("end",dragended)).on("click", (e,d)=>showDetails(d));
    node.each(function(d){
        const el = d3.select(this), c = nodeColors[d.status]||nodeColors[d.type]||'#64748b';
        if(['ConfirmedVulnerability','Flag'].includes(d.type)) el.append("polygon").attr("points","-14,0 0,-14 14,0 0,14").attr("fill",c);
        else if(['Evidence','Hypothesis'].includes(d.type)) el.append("rect").attr("x",-12).attr("y",-12).attr("width",24).attr("height",24).attr("rx",4).attr("fill",c);
        else el.append("circle").attr("r",10).attr("fill",c);
        let i=''; if(d.status==='completed') i='✓'; else if(d.status==='failed') i='✕';
        if(i) el.append("text").attr("dy",3).attr("text-anchor","middle").attr("fill","white").attr("font-size",9).text(i);
        tippy(this, { content: `<b>${d.type}</b><br>${d.label||d.id}`, allowHTML:true });
    });
    state.simulation.on("tick", () => { link.attr("x1",d=>d.source.x).attr("y1",d=>d.source.y).attr("x2",d=>d.target.x).attr("y2",d=>d.target.y); node.attr("transform",d=>`translate(${d.x},${d.y})`); });
  }
  
  function drawTree(data) {
    if(!data.roots || data.roots.length === 0) { state.g.selectAll("*").remove(); return; }
    state.g.selectAll("*").remove();
    
    // Horizontal Layout: Root on Left, Leaves on Right
    const rootData = data.roots[0]; 
    const root = d3.hierarchy(rootData);
    const width = state.svg.node().clientWidth;
    const height = state.svg.node().clientHeight;
    
    const dx = 50; 
    const dy = 120; 
    const treeLayout = d3.tree().nodeSize([dx, dy]);
    
    treeLayout(root);
    
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    root.each(d => { if (d.x < x0) x0 = d.x; if (d.x > x1) x1 = d.x; if (d.y < y0) y0 = d.y; if (d.y > y1) y1 = d.y; });
    
    state.g.append("g").attr("fill", "none").attr("stroke", "#334155").attr("stroke-width", 2).selectAll("path").data(root.links()).join("path").attr("d", d3.linkHorizontal().x(d => d.y).y(d => d.x));

    const node = state.g.append("g").selectAll("g").data(root.descendants()).join("g").attr("transform", d => `translate(${d.y},${d.x})`).attr("class", d => `d3-node ${d.data.status === 'in_progress' ? 'node-running' : ''}`).on("click", (e,d) => showDetails(d.data));

    node.each(function(d) {
        const el = d3.select(this), color = nodeColors[d.data.status] || '#64748b';
        let icon = '';
        if(d.data.status === 'completed') icon = '✓';
        else if(d.data.status === 'failed') icon = '✕';
        else if(d.data.status === 'in_progress') icon = '⚡';
        else icon = '•';

        if (!d.parent) el.append("polygon").attr("points", "-15,-26 15,-26 30,0 15,26 -15,26 -30,0").attr("fill", color).attr("stroke", "#f1f5f9").attr("stroke-width", 2);
        else if (d.children) el.append("circle").attr("r", 14).attr("fill", color).attr("stroke", "#1e293b").attr("stroke-width", 2);
        else el.append("rect").attr("x", -12).attr("y", -12).attr("width", 24).attr("height", 24).attr("rx", 6).attr("fill", color).attr("stroke", "#1e293b").attr("stroke-width", 2);
        
        el.append("text").attr("dy", 5).attr("text-anchor", "middle").attr("fill", "white").attr("font-size", 14).attr("font-weight", "bold").style("pointer-events", "none").text(icon);
        tippy(this, { content: `<b>${d.data.label}</b><br><span style='color:#ccc;font-size:10px'>${d.data.id}</span>`, allowHTML:true });
    });

    state.g.attr("transform", `translate(${100}, ${height/2})`);
  }

  function dragstarted(e,d) { if(!e.active) state.simulation.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; }
  function dragged(e,d) { d.fx=e.x; d.fy=e.y; }
  function dragended(e,d) { if(!e.active) state.simulation.alphaTarget(0); d.fx=null; d.fy=null; }
  function zoomIn() { state.svg.transition().call(state.zoom.scaleBy, 1.2); }
  function zoomOut() { state.svg.transition().call(state.zoom.scaleBy, 0.8); }
  function zoomReset() { state.svg.transition().call(state.zoom.transform, d3.zoomIdentity); }
  function updateLegend() { 
      const el=document.getElementById('legend-content'); let h='';
      Object.entries(nodeColors).forEach(([k,v])=>{if(k!=='default')h+=`<div class="legend-item"><div class="legend-dot" style="background:${v}"></div>${k}</div>`});
      el.innerHTML=h;
  }
  
  function showDetails(d) {
    const c=document.getElementById('node-detail-content'); let h='<table class="detail-table">';
    Object.entries(d).forEach(([k,v])=>{ if(!['x','y','fx','fy','vx','vy','index','children'].includes(k)) h+=`<tr><td class="detail-key">${k}</td><td class="detail-val">${typeof v==='object'?JSON.stringify(v,null,2):v}</td></tr>`; });
    c.innerHTML=h+'</table>';
  }

  function subscribe() {
    state.es = new EventSource(`/api/events?op_id=${state.op_id}`);
    state.es.onmessage = e => {
      try {
          const msg = JSON.parse(e.data);
          
          // 统一处理所有事件
          const eventType = msg.event || 'message';
          
          if(eventType === 'graph.changed' || eventType === 'execution.step.completed') render();
          if(eventType === 'ping' || eventType === 'graph.ready') return;
          
          // 分流渲染
          if(eventType.startsWith('llm.')) {
              renderLLMResponse(msg);
          } else {
              renderSystemEvent(msg);
          }
      } catch(x) { console.error('Parse error', x); }
    };
    fetch(`/api/ops/${state.op_id}/llm-events`).then(r=>r.json()).then(d=>(d.events||[]).forEach(e => {
        if(e.event && e.event.startsWith('llm.')) renderLLMResponse(e); else renderSystemEvent(e);
    }));
  }
  
  // 专门处理系统/执行事件 (execution.step.completed, graph.changed, etc)
  function renderSystemEvent(msg) {
      const container = document.getElementById('llm-stream');
      const div = document.createElement('div');
      div.className = 'system-msg';
      const time = new Date(msg.timestamp ? msg.timestamp * 1000 : Date.now()).toLocaleTimeString();
      let html = `<div class="msg-meta"><span>${msg.event}</span><span>${time}</span></div>`;
      
      const eventType = msg.event;
      const data = msg.data || msg.payload || {};

      // 针对 Tool Execution Completed 的特殊渲染
      if (eventType === 'execution.step.completed') {
          let result = data.result;
          // 尝试解析 result 字符串内部的 JSON
          if (typeof result === 'string') {
              try { result = JSON.parse(result); } catch(e) {}
          }
          
          html += `<div style="color:#a5d6ff;margin-bottom:4px;">Tool: <b>${data.tool_name}</b> (Step: ${data.step_id})</div>`;
          html += `<div class="tool-output">${hlJson(result)}</div>`;
      } 
      // 针对 Graph Changed
      else if (eventType === 'graph.changed') {
          html += `<div style="color:#94a3b8">Graph updated: ${data.reason || 'Unknown reason'}</div>`;
      }
      // 针对 Intervention
      else if (eventType === 'intervention.required') {
          html += `<div style="color:#f59e0b;font-weight:bold;">⚠ Intervention Required</div>`;
      }
      // 兜底通用渲染
      else {
          html += `<div class="raw-data-content">${hlJson(data)}</div>`;
      }
      
      div.innerHTML = html;
      container.appendChild(div); container.scrollTop = container.scrollHeight;
  }

  // 专门处理 LLM 响应
  function renderLLMResponse(msg) {
    const id = (msg.timestamp||Date.now()) + msg.event; 
    if(state.processedEvents.has(id)) return; 
    state.processedEvents.add(id);
    
    if (msg.event && msg.event.includes('request')) return;
    
    const container = document.getElementById('llm-stream');
    const div = document.createElement('div');
    div.className = `llm-msg assistant`;
    
    let content = msg.data || msg.payload;
    if (typeof content === 'string') { try { content = JSON.parse(content); } catch(e){} }
    if (content && content.content) content = content.content;
    if (typeof content === 'string' && (content.trim().startsWith('{') || content.trim().startsWith('['))) {
        try { content = JSON.parse(content); } catch(e){}
    }
    
    let htmlContent = '';
    
    if (typeof content === 'object' && content !== null) {
        let remaining = { ...content };
        
        // 1. Thought
        if (remaining.thought) {
            htmlContent += `<div class="thought-card"><div class="thought-header"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>Thinking Process</div>`;
            if (typeof remaining.thought === 'object') {
                for (const [key, val] of Object.entries(remaining.thought)) {
                     if (typeof val === 'string') htmlContent += `<div class="thought-item"><span class="thought-key">${key.replace(/_/g,' ')}</span><div class="thought-val">${val}</div></div>`;
                }
            } else {
                htmlContent += `<div class="thought-val">${remaining.thought}</div>`;
            }
            htmlContent += `</div>`;
            delete remaining.thought;
        }
        
        // 2. Reflector/Audit
        if (remaining.audit_result) {
            htmlContent += `<div class="thought-card" style="border-color:#ec4899;"><div class="thought-header audit-header"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>Reflector Audit</div>`;
            const audit = remaining.audit_result;
            htmlContent += `<div class="audit-badge" style="background:${audit.status==='passed'?'#10b981':'#f59e0b'}">Status: ${audit.status.toUpperCase()}</div>`;
            htmlContent += `<div style="font-size:12px;margin-bottom:8px;">${audit.completion_check}</div>`;
            if (audit.logic_issues && audit.logic_issues.length > 0) {
                htmlContent += `<div class="audit-issues">`;
                audit.logic_issues.forEach(issue => { htmlContent += `<div class="audit-issue-item">⚠ ${issue}</div>`; });
                htmlContent += `</div>`;
            }
            htmlContent += `</div>`;
            delete remaining.audit_result;
        }

        if (remaining.attack_intelligence) {
            const intel = remaining.attack_intelligence;
            if (intel.actionable_insights && intel.actionable_insights.length > 0) {
                htmlContent += `<div class="thought-card"><div class="thought-header" style="color:#a855f7">Actionable Insights</div><ul style="padding-left:16px;font-size:12px;color:#e2e8f0;list-style:disc">`;
                intel.actionable_insights.forEach(item => { htmlContent += `<li>${item}</li>`; });
                htmlContent += `</ul></div>`;
            }
            delete remaining.attack_intelligence;
        }

        if (remaining.key_findings) {
            htmlContent += `<div class="thought-card"><div class="thought-header" style="color:#f59e0b">Key Findings</div><div class="op-list">`;
            remaining.key_findings.forEach(f => {
                htmlContent += `<div class="op-card-inner"><div class="op-desc" style="color:#fbbf24">${f.title}</div><div style="font-size:11px;color:#94a3b8">${f.description}</div></div>`;
            });
            htmlContent += `</div></div>`;
            delete remaining.key_findings;
        }
        delete remaining.key_facts;
        delete remaining.causal_graph_updates;

        // 3. Graph Operations
        if (remaining.graph_operations && Array.isArray(remaining.graph_operations)) {
            htmlContent += `<div class="thought-header" style="margin-top:10px;"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>Graph Actions</div><div class="op-list">`;
            remaining.graph_operations.forEach(op => {
                const nodeData = op.node_data || {};
                htmlContent += `<div class="op-card-inner"><div class="op-badge">${op.command}</div><div style="flex:1"><div class="op-id">${nodeData.id || '-'}</div><div class="op-desc">${nodeData.description || (op.updates ? JSON.stringify(op.updates) : '')}</div></div></div>`;
            });
            htmlContent += `</div>`;
            delete remaining.graph_operations;
        }

        // 4. Execution Operations
        if (remaining.execution_operations && Array.isArray(remaining.execution_operations)) {
            htmlContent += `<div class="thought-header" style="margin-top:10px; color:#f59e0b;"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>Execution Actions</div><div class="op-list">`;
            remaining.execution_operations.forEach(op => {
                const params = op.action && op.action.params ? JSON.stringify(op.action.params, null, 1) : '';
                const toolName = op.action ? op.action.tool : 'Unknown Tool';
                htmlContent += `<div class="op-card-inner"><div class="op-badge" style="background:rgba(245, 158, 11, 0.2);color:#f59e0b;">${toolName}</div><div style="flex:1"><div class="op-id">${op.node_id}</div><div class="op-desc">${op.thought || ''}</div>${params ? `<div class="op-details">${params}</div>` : ''}</div></div>`;
            });
            htmlContent += `</div>`;
            delete remaining.execution_operations;
        }

        // 5. Hypothesis Update
        if (remaining.hypothesis_update && typeof remaining.hypothesis_update === 'object') {
            htmlContent += `<div class="thought-card" style="border-color:#8b5cf6;"><div class="thought-header" style="color:#8b5cf6;"><svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.384-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" /></svg>Hypothesis Update</div>`;
            for (const [key, val] of Object.entries(remaining.hypothesis_update)) {
                 if(val) htmlContent += `<div class="thought-item"><span class="thought-key">${key.replace(/_/g,' ')}</span><div class="thought-val">${val}</div></div>`;
            }
            htmlContent += `</div>`;
            delete remaining.hypothesis_update;
        }
        
        // 6. Staged Causal Nodes
        if (remaining.staged_causal_nodes && Array.isArray(remaining.staged_causal_nodes) && remaining.staged_causal_nodes.length > 0) {
             htmlContent += `<div class="thought-header" style="margin-top:10px; color:#06b6d4;">New Findings</div><div class="op-list">`;
             remaining.staged_causal_nodes.forEach(node => {
                 htmlContent += `<div class="op-card-inner"><div class="op-badge" style="background:rgba(6, 182, 212, 0.2);color:#06b6d4;">${node.type || 'Finding'}</div><div class="op-desc" style="flex:1">${node.description || node.title}</div></div>`;
             });
             htmlContent += `</div>`;
             delete remaining.staged_causal_nodes;
        } else {
             delete remaining.staged_causal_nodes;
        }

        // 7. Render Remaining Specific Keys nicely
        if (Object.keys(remaining).length > 0) {
            htmlContent += `<div class="raw-data-block"><div class="raw-data-header">Status & Other Data</div><div style="display:flex;flex-wrap:wrap;">`;
            
            // Render specific flags as badges
            const flags = ['global_mission_accomplished', 'is_subtask_complete', 'success'];
            flags.forEach(f => {
                if (remaining[f] !== undefined) {
                    const isTrue = remaining[f] === true;
                    htmlContent += `<div class="status-item"><span class="${isTrue?'status-check':'status-cross'}">${isTrue?'✓':'✕'}</span> ${f}</div>`;
                    delete remaining[f];
                }
            });
            htmlContent += `</div>`;
            
            // If anything is STILL left, dump as JSON
            if (Object.keys(remaining).length > 0) {
                htmlContent += `<div class="raw-data-content">${hlJson(JSON.stringify(remaining, null, 2))}</div>`;
            }
            htmlContent += `</div>`;
        }
        
    } else {
        htmlContent = `<div style="white-space:pre-wrap">${content}</div>`;
    }

    div.innerHTML = `<div class="msg-meta"><span>${msg.event}</span><span>${new Date().toLocaleTimeString()}</span></div>${htmlContent}`;
    container.appendChild(div); container.scrollTop = container.scrollHeight;
  }
  
  function hlJson(s) {
    if(typeof s !== 'string') {
        if(typeof s === 'object') s = JSON.stringify(s, null, 2);
        else s = String(s);
    }
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, m => {
      let c = 'json-number';
      if(/^"/.test(m)) c = /:$/.test(m) ? 'json-key' : 'json-string';
      else if(/true|false/.test(m)) c = 'json-boolean';
      return `<span class="${c}">${m}</span>`;
    });
  }

  async function createTask() { const g=document.getElementById('in-goal').value, t=document.getElementById('in-task').value; if(!g)return; await api('/api/ops',{goal:g,task_name:t}).then(r=>{if(r.ok){loadOps();selectOp(r.op_id)}}); }
  async function abortOp() { if(confirm('Stop?')) await api(`/api/ops/${state.op_id}/abort`,{}); }
  
  async function checkPendingIntervention() {
    if(!state.op_id) return;
    try {
        const r = await api(`/api/ops/${state.op_id}/intervention/pending`);
        const m = document.getElementById('approval-modal');
        if(r.pending && r.request) {
            if(!state.pendingReq || state.pendingReq.id !== r.request.id) {
                state.pendingReq = r.request; state.isModifyMode = false;
                renderApproval(r.request); m.classList.add('show');
            }
        } else if(state.pendingReq) { m.classList.remove('show'); state.pendingReq = null; }
    } catch(e){}
  }
  
  function renderApproval(r) {
    const l=document.getElementById('approval-list'), e=document.getElementById('approval-json-editor'), ea=document.getElementById('approval-edit-area'), b=document.getElementById('btn-modify-mode');
    l.style.display='block'; ea.style.display='none'; b.innerText='Modify'; b.classList.remove('active');
    let h=''; (r.data||[]).forEach(o=>{ h+=`<div class="plan-item"><div class="plan-tag ${o.command}">${o.command}</div><div style="flex:1;font-size:12px;color:#94a3b8"><div style="color:#e2e8f0;font-family:monospace">${o.node_id||(o.node_data?o.node_data.id:'-')}</div>${o.command==='ADD_NODE'?(o.node_data.description||''):''}</div></div>`; });
    l.innerHTML=h; e.value=JSON.stringify(r.data,null,2);
  }
  
  function toggleModifyMode() { state.isModifyMode=!state.isModifyMode; const l=document.getElementById('approval-list'), ea=document.getElementById('approval-edit-area'), b=document.getElementById('btn-modify-mode'); if(state.isModifyMode){l.style.display='none';ea.style.display='block';b.innerText='Cancel';b.classList.add('active')}else{l.style.display='block';ea.style.display='none';b.innerText='Modify';b.classList.remove('active')} }
  async function submitDecision(a) { let p={action:a}; if(a==='APPROVE'&&state.isModifyMode) { try{p.modified_data=JSON.parse(document.getElementById('approval-json-editor').value);p.action='MODIFY'}catch(e){return alert('Invalid JSON')} } await api(`/api/ops/${state.op_id}/intervention/decision`,p); document.getElementById('approval-modal').classList.remove('show'); state.pendingReq=null; }
  
  function openInjectModal(){document.getElementById('inject-modal').classList.add('show')}
  function closeModals(){document.querySelectorAll('.modal-overlay').forEach(e=>e.classList.remove('show'))}
  async function submitInjection(){const d=document.getElementById('inject-desc').value, dp=document.getElementById('inject-deps').value; if(d) await api(`/api/ops/${state.op_id}/inject_task`,{description:d,dependencies:dp?dp.split(','):[]}); closeModals();}
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