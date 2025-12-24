import asyncio
import json
import logging
import os
import sys
import subprocess
import uuid
import time
from typing import Any, Dict, List, Optional
from datetime import datetime

from fastapi import FastAPI, HTTPException, Request, Query
from fastapi.responses import StreamingResponse, JSONResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sse_starlette.sse import EventSourceResponse
from fastapi.responses import Response

from sqlalchemy import select, desc, update, delete
from sqlalchemy.ext.asyncio import AsyncSession
from core.database.utils import get_db_session, init_db, AsyncSessionLocal, get_pending_intervention_request
from core.database.models import SessionModel, GraphNodeModel, GraphEdgeModel, EventLogModel, InterventionModel
from core.intervention import intervention_manager # Added this line

# 配置 SSE 日志
_sse_logger = logging.getLogger("web.sse")

# 进程跟踪字典: {op_id -> subprocess.Popen}
# 用于在终止任务时直接kill进程
_running_processes: Dict[str, subprocess.Popen] = {}

app = FastAPI(title="鸾鸟Agent Web (DB Mode)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files and templates
os.makedirs("web/static", exist_ok=True)
os.makedirs("web/templates", exist_ok=True)

app.mount("/static", StaticFiles(directory="web/static"), name="static")
templates = Jinja2Templates(directory="web/templates")

@app.on_event("startup")
async def startup_event():
    await init_db()

# --- Helper Functions for Graph Reconstruction ---

def _reconstruct_graph_data(nodes: List[GraphNodeModel], edges: List[GraphEdgeModel], task_id: str) -> Dict[str, Any]:
    """Reconstruct graph data structure from DB models for frontend."""
    frontend_nodes = []
    node_map = {} # id -> data
    
    for n in nodes:
        data = n.data.copy() if n.data else {}
        # Merge top-level fields
        data['id'] = n.node_id
        data['type'] = n.type
        data['status'] = n.status
        # Handle created_at if not in data
        if 'created_at' not in data and n.created_at:
             data['created_at'] = n.created_at.timestamp()

        node_map[n.node_id] = data
        
        # Logic similar to original api_graph_execution
        if data.get("is_staged_causal") or data.get("type") == "staged_causal":
            continue
            
        is_root = (n.node_id == task_id)
        node_type = n.type or "unknown"
        is_subtask = node_type in ["task", "subtask"] or n.node_id.startswith("subtask_")
        is_action = node_type in ["execution_step", "action", "tool_use"]
        
        if is_root:
            unified_type = "root"
        elif is_subtask and not is_action:
            unified_type = "task"
        elif is_action:
            unified_type = "action"
        else:
            unified_type = node_type

        # Tool info extraction
        tool_info = {}
        if "tool_name" in data:
            tool_info["tool_name"] = data["tool_name"]
        if "action" in data and isinstance(data["action"], dict):
            tool_info["tool_name"] = data["action"].get("tool", data["action"].get("tool_name"))
            tool_info["tool_args"] = data["action"].get("params", data["action"].get("args"))
        if "result" in data:
            tool_info["result"] = data["result"]
        if "observation" in data:
            tool_info["observation"] = data["observation"]

        if is_root or is_subtask:
            label = data.get("description") or data.get("goal") or n.node_id
        else:
            label = n.node_id
            
        node_entry = {
            "id": n.node_id,
            "type": unified_type,
            "original_type": node_type,
            "status": n.status,
            "label": label,
            "description": data.get("description"),
            "thought": data.get("thought"),
            "goal": data.get("goal"),
            "completed_at": data.get("completed_at"),
            "is_goal_achieved": data.get("is_goal_achieved", False),  # 标记成功路径终点
        }
        node_entry.update(tool_info)
        frontend_nodes.append(node_entry)

    frontend_edges = []
    node_ids = set(n["id"] for n in frontend_nodes)
    
    for e in edges:
        if e.source_node_id in node_ids and e.target_node_id in node_ids:
            frontend_edges.append({
                "source": e.source_node_id,
                "target": e.target_node_id,
                "type": e.relation_type
            })
            
    return {"nodes": frontend_nodes, "edges": frontend_edges}

def _reconstruct_causal_data(nodes: List[GraphNodeModel], edges: List[GraphEdgeModel]) -> Dict[str, Any]:
    frontend_nodes = []
    for n in nodes:
        data = n.data.copy() if n.data else {}
        label = data.get("title") or data.get("description") or n.type or n.node_id
        
        node_entry = {
            "id": n.node_id,
            "label": label,
            "type": n.type,
            "node_type": n.type,
            "status": n.status,
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
                if key not in node_entry:
                    node_entry[key] = value
        frontend_nodes.append(node_entry)
        
    frontend_edges = []
    for e in edges:
        frontend_edges.append({
            "source": e.source_node_id, 
            "target": e.target_node_id, 
            "label": e.relation_type
        })
        
    return {"nodes": frontend_nodes, "edges": frontend_edges}


# --- API Endpoints ---

@app.get("/api/ops")
async def api_ops():
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(SessionModel).order_by(desc(SessionModel.updated_at))
        )
        sessions = result.scalars().all()
        
        items = []
        for s in sessions:
            items.append({
                "op_id": s.id,
                "task_id": s.name, # Using name as task_id roughly
                "goal": s.goal,
                "created_at": s.created_at.timestamp(),
                "log_dir": f"logs/{s.name}/{s.id}", # Approximation
                "status": {
                    "raw": s.status,
                    "achieved": s.status == "completed",
                    "failed": s.status in ["failed", "stalled_orphan", "completed_error"],
                    "aborted": s.status == "aborted"
                }
            })
        return {"items": items}

@app.get("/api/ops/{op_id}")
async def api_ops_detail(op_id: str):
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(SessionModel).where(SessionModel.id == op_id))
        s = result.scalar_one_or_none()
        if not s:
            raise HTTPException(status_code=404, detail="Session not found")
            
        return {
            "op_id": s.id,
            "task_id": s.name,
            "goal": s.goal,
            "created_at": s.created_at.timestamp(),
            "summary": "Full summary generation not implemented in DB mode yet."
        }

@app.get("/api/graph/execution")
async def api_graph_execution(op_id: str):
    async with AsyncSessionLocal() as session:
        # Fetch task nodes
        nodes_res = await session.execute(
            select(GraphNodeModel).where(
                GraphNodeModel.session_id == op_id, 
                GraphNodeModel.graph_type == 'task'
            )
        )
        nodes = nodes_res.scalars().all()
        
        edges_res = await session.execute(
            select(GraphEdgeModel).where(
                GraphEdgeModel.session_id == op_id, 
                GraphEdgeModel.graph_type == 'task'
            )
        )
        edges = edges_res.scalars().all()
        
        # Get session to find root task id (usually stored in name or logic)
        # But we can infer root from nodes (node with no incoming execution/dependency edges, or type='task')
        # For simplicity, we assume the session name might be the task_id, or we find the node with type='task'
        
        task_id = "unknown"
        for n in nodes:
            if n.type == 'task':
                task_id = n.node_id
                break
                
        return _reconstruct_graph_data(nodes, edges, task_id)

@app.get("/api/graph/causal")
async def api_graph_causal(op_id: str):
    async with AsyncSessionLocal() as session:
        nodes_res = await session.execute(
            select(GraphNodeModel).where(
                GraphNodeModel.session_id == op_id, 
                GraphNodeModel.graph_type == 'causal'
            )
        )
        nodes = nodes_res.scalars().all()
        
        edges_res = await session.execute(
            select(GraphEdgeModel).where(
                GraphEdgeModel.session_id == op_id, 
                GraphEdgeModel.graph_type == 'causal'
            )
        )
        edges = edges_res.scalars().all()
        
        return _reconstruct_causal_data(nodes, edges)

@app.get("/api/tree/execution")
async def api_tree_execution(op_id: str):
    # This requires reconstructing the hierarchy.
    # For now, return empty or implement basic logic if needed.
    # The frontend uses this for the tree view.
    return {"roots": []} # Simplified for now

@app.get("/api/ops/{op_id}/llm-events")
async def api_llm_events(op_id: str):
    """
    Fetch event history. 
    Note: Despite the name, this now returns ALL events, not just llm.*, 
    to ensure the frontend renders the full history (including system events) on load.
    """
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(EventLogModel)
            .where(EventLogModel.session_id == op_id)
            .order_by(EventLogModel.timestamp)
        )
        events = result.scalars().all()
        return {"op_id": op_id, "events": [{"event": e.event_type, "data": e.content, "timestamp": e.timestamp.timestamp()} for e in events], "count": len(events)}

@app.get("/api/ops/{op_id}/intervention/pending")
async def api_get_pending_intervention(op_id: str):
    req = await intervention_manager.get_pending_request(op_id)
    return {"pending": req is not None, "request": req}

@app.post("/api/ops/{op_id}/intervention/decision")
async def api_submit_intervention_decision(op_id: str, payload: Dict[str, Any]):
    req_id = payload.get("id") # The request ID comes from the frontend
    action = payload.get("action")
    modified_data = payload.get("modified_data")
    if not req_id or not action:
        raise HTTPException(status_code=400, detail="req_id and action are required")
    
    success = await intervention_manager.submit_decision(req_id, action, modified_data)
    if not success:
        raise HTTPException(status_code=404, detail="No pending request found for this ID")
    return {"ok": True}

@app.post("/api/ops/{op_id}/abort")
async def api_ops_abort(op_id: str):
    import signal
    
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(SessionModel).where(SessionModel.id == op_id))
        s = result.scalar_one_or_none()
        if not s:
            raise HTTPException(status_code=404, detail="Session not found")
        
        # 1. 更新数据库状态
        await session.execute(
            update(SessionModel)
            .where(SessionModel.id == op_id)
            .values(status="aborted", updated_at=datetime.now())
        )
        await session.commit()
        
    # 2. 直接kill进程
    process_killed = False
    if op_id in _running_processes:
        proc = _running_processes[op_id]
        try:
            # 检查进程是否还在运行
            if proc.poll() is None:
                # 发送SIGTERM信号优雅终止
                proc.terminate()
                # 等待最多3秒让进程退出
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    # 如果还没退出，强制kill
                    proc.kill()
                    proc.wait()
                process_killed = True
                _sse_logger.info(f"Process for op_id '{op_id}' terminated (PID: {proc.pid})")
            else:
                _sse_logger.info(f"Process for op_id '{op_id}' already exited")
        except Exception as e:
            _sse_logger.error(f"Failed to kill process for op_id '{op_id}': {e}")
        finally:
            # 从跟踪字典中移除
            del _running_processes[op_id]
    else:
        _sse_logger.warning(f"No tracked process found for op_id '{op_id}'")
        
    return {
        "ok": True, 
        "message": "Task aborted successfully",
        "process_killed": process_killed
    }

@app.delete("/api/ops/{op_id}")
async def api_ops_delete(op_id: str):
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(SessionModel).where(SessionModel.id == op_id))
        s = result.scalar_one_or_none()
        if not s:
            raise HTTPException(status_code=404, detail="Session not found")
        
        await session.delete(s)
        await session.commit()
    return {"ok": True}

@app.get("/api/events")
async def api_events(request: Request, op_id: str):
    """
    SSE Endpoint: Polls DB for new events for the given op_id, including graph updates,
    event logs, and intervention requests.
    """
    async def event_generator():
        last_graph_update_time = time.time() - 60 # Look back 60s for initial graph status
        last_event_log_id = 0  # Use ID for incremental fetching
        last_intervention_check_time = time.time() - 60 # Look back 60s for initial interventions

        # Initial graph ready event
        yield {
            "event": "message",
            "id": str(time.time()),
            "data": json.dumps({"event": "graph.ready", "op_id": op_id})
        }
        
        # Initial events load
        async with AsyncSessionLocal() as session:
            # Send all historical events up to now, limited for performance
            events_res = await session.execute(
                select(EventLogModel)
                .where(EventLogModel.session_id == op_id)
                .order_by(EventLogModel.id) # Order by ID
            )
            initial_events = events_res.scalars().all()
            for e in initial_events:
                yield {
                    "event": "message",
                    "id": str(e.id), # Use event ID as SSE event ID
                    "data": json.dumps({"event": e.event_type, "data": e.content, "timestamp": e.timestamp.timestamp()})
                }
            if initial_events:
                last_event_log_id = initial_events[-1].id
            
            # Send initial pending intervention if any
            intervention_db_model = await get_pending_intervention_request(op_id)
            if intervention_db_model:
                yield {
                    "event": "message",
                    "id": str(intervention_db_model.id), # Use intervention ID as SSE event ID
                    "data": json.dumps({
                        "event": "intervention.required",
                        "op_id": op_id,
                        "type": intervention_db_model.type,
                        "id": intervention_db_model.id,
                        "request": {
                            "id": intervention_db_model.id,
                            "op_id": intervention_db_model.session_id,
                            "type": intervention_db_model.type,
                            "data": intervention_db_model.request_data,
                            "created_at": intervention_db_model.created_at.timestamp()
                        }
                    })
                }
                last_intervention_check_time = intervention_db_model.created_at.timestamp()

        while True:
            if await request.is_disconnected():
                _sse_logger.info(f"SSE client for {op_id} disconnected.")
                break
                
            try:
                current_time = time.time()
                
                async with AsyncSessionLocal() as session:
                    # 1. Check for Graph Updates
                    session_res = await session.execute(
                        select(SessionModel.updated_at).where(SessionModel.id == op_id)
                    )
                    session_updated_at = session_res.scalar_one_or_none()
                    
                    if session_updated_at and session_updated_at.timestamp() > last_graph_update_time:
                        yield {
                            "event": "message",
                            "id": str(current_time),
                            "data": json.dumps({"event": "graph.changed", "op_id": op_id})
                        }
                        last_graph_update_time = current_time

                    # 2. Check for new Event Logs by ID
                    new_events_res = await session.execute(
                        select(EventLogModel)
                        .where(EventLogModel.session_id == op_id, EventLogModel.id > last_event_log_id)
                        .order_by(EventLogModel.id)
                    )
                    new_events = new_events_res.scalars().all()
                    for e in new_events:
                        yield {
                            "event": "message",
                            "id": str(e.id),
                            "data": json.dumps({"event": e.event_type, "data": e.content, "timestamp": e.timestamp.timestamp()})
                        }
                        last_event_log_id = e.id # Update last_event_log_id
                    
                    # 3. Check for new pending Intervention Requests
                    intervention_db_model = await get_pending_intervention_request(op_id)
                    if intervention_db_model and intervention_db_model.created_at.timestamp() > last_intervention_check_time:
                        yield {
                            "event": "message",
                            "id": str(intervention_db_model.id),
                            "data": json.dumps({
                                "event": "intervention.required",
                                "op_id": op_id,
                                "type": intervention_db_model.type,
                                "id": intervention_db_model.id,
                                "request": {
                                    "id": intervention_db_model.id,
                                    "op_id": intervention_db_model.session_id,
                                    "type": intervention_db_model.type,
                                    "data": intervention_db_model.request_data,
                                    "created_at": intervention_db_model.created_at.timestamp()
                                }
                            })
                        }
                        last_intervention_check_time = intervention_db_model.created_at.timestamp()

                # Keep connection alive with a ping, even if no new data
                yield {"event": "ping", "id": str(current_time), "data": "{}"}
                await asyncio.sleep(1) # Poll every 1 second
                
            except Exception as e:
                _sse_logger.error(f"SSE Error for {op_id}: {e}", exc_info=True)
                yield {"event": "error", "id": str(time.time()), "data": json.dumps({"error": str(e)})}
                await asyncio.sleep(5) # Wait longer on error

    return EventSourceResponse(event_generator())

# Legacy/Compatibility Routes
@app.post("/api/ops")
async def api_ops_create(payload: Dict[str, Any]):
    goal = (payload.get("goal") or "").strip()
    task_name = (payload.get("task_name") or f"web_task_{int(time.time())}").strip()
    
    # 新增配置选项
    human_in_the_loop = payload.get("human_in_the_loop", False)  # 人机协同模式
    output_mode = payload.get("output_mode", "default")  # 输出模式: simple, default, debug
    
    # LLM模型配置（可选）
    llm_planner_model = payload.get("llm_planner_model", "").strip()
    llm_executor_model = payload.get("llm_executor_model", "").strip()
    llm_reflector_model = payload.get("llm_reflector_model", "").strip()
    
    if not goal:
        raise HTTPException(status_code=400, detail="Goal is required to create a task.")

    # Generate a unique op_id for the new task
    op_id = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{str(uuid.uuid4())[:8]}"
    
    # Construct the command to run agent.py in the background
    # Ensure it runs within the same virtual environment as the web server
    command = [
        sys.executable,  # Path to the current python interpreter (inside venv)
        os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "agent.py")),
        "--goal", goal,
        "--task-name", task_name,
        "--op-id", op_id, # Pass the generated op_id to the agent
        "--web", # To ensure agent prints web URL for debug if needed, but no web server will be started.
        "--output-mode", output_mode,
    ]
    
    # 添加可选的LLM模型配置
    if llm_planner_model:
        command.extend(["--llm-planner-model", llm_planner_model])
    if llm_executor_model:
        command.extend(["--llm-executor-model", llm_executor_model])
    if llm_reflector_model:
        command.extend(["--llm-reflector-model", llm_reflector_model])

    # 设置环境变量传递人机协同配置
    env = os.environ.copy()
    if human_in_the_loop:
        env["HUMAN_IN_THE_LOOP"] = "true"
    else:
        env["HUMAN_IN_THE_LOOP"] = "false"

    # Use subprocess.Popen to start agent.py as a detached process
    # This prevents the web server from being blocked by the agent task
    try:
        # Use start_new_session=True to detach the child process from the current process group
        # This makes the child process independent of the web server's lifespan
        process = subprocess.Popen(command, start_new_session=True, 
                                   stdout=subprocess.DEVNULL, # Redirect stdout to /dev/null
                                   stderr=subprocess.DEVNULL, # Redirect stderr to /dev/null
                                   env=env)  # 传递环境变量
        
        # 保存进程引用到跟踪字典，以便后续可以直接kill
        _running_processes[op_id] = process
        
        _sse_logger.info(f"Agent task '{task_name}' (op_id: {op_id}) started with PID: {process.pid}, HITL: {human_in_the_loop}")

        # The agent itself will create the session in the DB
        return {
            "ok": True, 
            "op_id": op_id, 
            "pid": process.pid,
            "message": "Agent task started successfully.",
            "config": {
                "human_in_the_loop": human_in_the_loop,
                "output_mode": output_mode
            }
        }
    except Exception as e:
        _sse_logger.error(f"Failed to start agent task: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to start agent task: {e}")

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8088)