import asyncio
import json
import logging
import os
import time
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request, Query
from fastapi.responses import StreamingResponse, JSONResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import uvicorn

from sse_starlette.sse import EventSourceResponse
from fastapi.responses import Response

# 配置 SSE 日志
_sse_logger = logging.getLogger("web.sse")

try:
    from core.events import broker
    from core.graph_manager import GraphManager
    from core.intervention import intervention_manager
    from tools.mcp_client import reload_sessions
except ModuleNotFoundError:
    import sys as _sys
    import os as _os
    _sys.path.append(_os.path.dirname(_os.path.dirname(__file__)))
    from core.events import broker
    from core.graph_manager import GraphManager
    from core.intervention import intervention_manager
    from tools.mcp_client import reload_sessions


app = FastAPI(title="鸾鸟Agent Web")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files and templates
# Ensure directories exist
os.makedirs("web/static", exist_ok=True)
os.makedirs("web/templates", exist_ok=True)

app.mount("/static", StaticFiles(directory="web/static"), name="static")
templates = Jinja2Templates(directory="web/templates")


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


@app.get("/api/mcp/config")
async def api_mcp_config():
    config_path = "mcp.json"
    if not os.path.exists(config_path):
        return {"mcpServers": {}}
    try:
        with open(config_path, "r") as f:
            return json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load mcp.json: {e}")


@app.post("/api/mcp/add")
async def api_mcp_add(payload: Dict[str, Any]):
    name = payload.get("name")
    command = payload.get("command")
    args = payload.get("args", [])
    env = payload.get("env", {})
    
    if not name or not command:
        raise HTTPException(status_code=400, detail="Name and command are required")
        
    config_path = "mcp.json"
    config = {"mcpServers": {}}
    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as f:
                config = json.load(f)
        except Exception:
            pass
            
    config.setdefault("mcpServers", {})[name] = {
        "type": "stdio",
        "command": command,
        "args": args,
        "env": env
    }
    
    try:
        with open(config_path, "w") as f:
            json.dump(config, f, indent=2)
        
        # Reload MCP sessions
        await reload_sessions()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save config or reload: {e}")


# INDEX_HTML has been moved to web/templates/index.html

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/favicon.ico")
async def favicon():
    return Response(status_code=204)


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
