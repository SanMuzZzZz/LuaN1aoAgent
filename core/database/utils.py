import os
import logging
import json
import asyncio
from datetime import datetime
from typing import Dict, Any, Optional

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy import select, update, delete
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .models import Base, SessionModel, GraphNodeModel, GraphEdgeModel, EventLogModel, InterventionModel

# Default to a local SQLite database file
DB_PATH = os.getenv("DATABASE_PATH", "luan1ao.db")
DB_URL = f"sqlite+aiosqlite:///{DB_PATH}"

engine = create_async_engine(
    DB_URL,
    echo=False,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    expire_on_commit=False,
    class_=AsyncSession
)

async def init_db():
    """Initialize the database by creating all tables."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

async def get_db_session() -> AsyncSession:
    """Dependency generator or context manager usage."""
    async with AsyncSessionLocal() as session:
        yield session

# --- CRUD Operations ---

async def create_session(session_id: str, name: str, goal: str, config: Dict[str, Any] = None):
    async with AsyncSessionLocal() as session:
        # 首先检查 session 是否已存在
        result = await session.execute(
            select(SessionModel).where(SessionModel.id == session_id)
        )
        existing = result.scalar_one_or_none()
        
        if existing:
            # Session 已存在（由 web server 创建），只更新必要字段，但不覆盖 name
            # 这样用户在 web 端输入的任务名称会被保留
            existing.goal = goal  # 更新 goal（可能同步）
            if config:
                existing.config = {**(existing.config or {}), **config}  # 合并 config
            existing.updated_at = datetime.now()
        else:
            # Session 不存在，创建新的
            session.add(SessionModel(
                id=session_id,
                name=name,
                goal=goal,
                status="pending",
                config=config or {},
                created_at=datetime.now(),
                updated_at=datetime.now()
            ))
        
        await session.commit()

async def update_session_status(session_id: str, status: str):
    async with AsyncSessionLocal() as session:
        await session.execute(
            update(SessionModel)
            .where(SessionModel.id == session_id)
            .values(status=status, updated_at=datetime.now())
        )
        await session.commit()

async def upsert_node(session_id: str, node_id: str, graph_type: str, node_data: Dict[str, Any]):
    """Insert or update a graph node."""
    # Extract known fields for columns, put rest in data
    n_type = node_data.get("type") or node_data.get("node_type")
    status = node_data.get("status")
    
    # We need to serialize data properly. 
    # SQLAlchemy's JSON type handles dicts, but let's ensure it's clean.
    
    async with AsyncSessionLocal() as session:
        # Check if exists to determine insert or update (or use upsert logic)
        # SQLite upsert
        stmt = sqlite_insert(GraphNodeModel).values(
            session_id=session_id,
            node_id=node_id,
            graph_type=graph_type,
            type=n_type,
            status=status,
            data=node_data,
            updated_at=datetime.now()
        )
        
        # We need a unique constraint on (session_id, node_id, graph_type) for true upsert
        # But for now, let's just do a select-then-update/insert pattern which is safer across DBs if constraints aren't perfect
        # Actually, let's rely on simple select check for now to avoid complex migration of unique constraints
        
        result = await session.execute(
            select(GraphNodeModel).where(
                GraphNodeModel.session_id == session_id,
                GraphNodeModel.node_id == node_id,
                GraphNodeModel.graph_type == graph_type
            )
        )
        existing_records = result.scalars().all()
        
        if existing_records:
            # Update the first record found
            target_record = existing_records[0]
            target_record.type = n_type
            target_record.status = status
            target_record.data = node_data
            target_record.updated_at = datetime.now()
            
            # If there are duplicates, delete them to clean up the DB
            if len(existing_records) > 1:
                for duplicate in existing_records[1:]:
                    await session.delete(duplicate)
        else:
            session.add(GraphNodeModel(
                session_id=session_id,
                node_id=node_id,
                graph_type=graph_type,
                type=n_type,
                status=status,
                data=node_data
            ))
        
        # Touch session updated_at to trigger SSE
        await session.execute(
            update(SessionModel)
            .where(SessionModel.id == session_id)
            .values(updated_at=datetime.now())
        )
        
        await session.commit()

async def delete_node(session_id: str, node_id: str, graph_type: str):
    async with AsyncSessionLocal() as session:
        await session.execute(
            delete(GraphNodeModel).where(
                GraphNodeModel.session_id == session_id,
                GraphNodeModel.node_id == node_id,
                GraphNodeModel.graph_type == graph_type
            )
        )
        
        # Touch session updated_at to trigger SSE
        await session.execute(
            update(SessionModel)
            .where(SessionModel.id == session_id)
            .values(updated_at=datetime.now())
        )
        
        await session.commit()

async def add_edge(session_id: str, source: str, target: str, graph_type: str, edge_data: Dict[str, Any]):
    relation = edge_data.get("type") or edge_data.get("label") or "unknown"
    
    async with AsyncSessionLocal() as session:
        # Check existence to avoid duplicates if needed, or just insert (assuming multigraph or simple check)
        result = await session.execute(
            select(GraphEdgeModel).where(
                GraphEdgeModel.session_id == session_id,
                GraphEdgeModel.source_node_id == source,
                GraphEdgeModel.target_node_id == target,
                GraphEdgeModel.graph_type == graph_type,
                GraphEdgeModel.relation_type == relation
            )
        )
        if not result.scalar_one_or_none():
            session.add(GraphEdgeModel(
                session_id=session_id,
                source_node_id=source,
                target_node_id=target,
                graph_type=graph_type,
                relation_type=relation,
                data=edge_data
            ))
            
            # Touch session updated_at to trigger SSE
            await session.execute(
                update(SessionModel)
                .where(SessionModel.id == session_id)
                .values(updated_at=datetime.now())
            )
            
            await session.commit()

async def atomic_upsert_graph_data(
    session_id: str,
    nodes: list[Dict[str, Any]] = None,
    edges: list[Dict[str, Any]] = None,
    graph_type: str = 'task'
):
    """
    原子写入多个节点和边，保证在同一个事务中完成。
    
    Args:
        session_id: 会话ID
        nodes: 节点列表，每个节点是包含 node_id 和其他属性的字典
        edges: 边列表，每个边是包含 source, target 和其他属性的字典
        graph_type: 图类型 ('task' 或 'causal')
    """
    nodes = nodes or []
    edges = edges or []
    
    if not nodes and not edges:
        return
    
    async with AsyncSessionLocal() as session:
        try:
            # 1. 处理所有节点的 upsert
            for node_data in nodes:
                node_id = node_data.get('node_id') or node_data.get('id')
                if not node_id:
                    continue
                    
                n_type = node_data.get("type") or node_data.get("node_type")
                status = node_data.get("status")
                
                result = await session.execute(
                    select(GraphNodeModel).where(
                        GraphNodeModel.session_id == session_id,
                        GraphNodeModel.node_id == node_id,
                        GraphNodeModel.graph_type == graph_type
                    )
                )
                existing_records = result.scalars().all()
                
                if existing_records:
                    # 更新第一条记录
                    target_record = existing_records[0]
                    target_record.type = n_type
                    target_record.status = status
                    target_record.data = node_data
                    target_record.updated_at = datetime.now()
                    
                    # 删除重复记录
                    if len(existing_records) > 1:
                        for duplicate in existing_records[1:]:
                            await session.delete(duplicate)
                else:
                    session.add(GraphNodeModel(
                        session_id=session_id,
                        node_id=node_id,
                        graph_type=graph_type,
                        type=n_type,
                        status=status,
                        data=node_data
                    ))
            
            # 2. 处理所有边的添加
            for edge_data in edges:
                source = edge_data.get('source') or edge_data.get('source_id')
                target = edge_data.get('target') or edge_data.get('target_id')
                if not source or not target:
                    continue
                    
                relation = edge_data.get("type") or edge_data.get("label") or "unknown"
                
                result = await session.execute(
                    select(GraphEdgeModel).where(
                        GraphEdgeModel.session_id == session_id,
                        GraphEdgeModel.source_node_id == source,
                        GraphEdgeModel.target_node_id == target,
                        GraphEdgeModel.graph_type == graph_type,
                        GraphEdgeModel.relation_type == relation
                    )
                )
                if not result.scalar_one_or_none():
                    session.add(GraphEdgeModel(
                        session_id=session_id,
                        source_node_id=source,
                        target_node_id=target,
                        graph_type=graph_type,
                        relation_type=relation,
                        data=edge_data
                    ))
            
            # 3. 更新 session 的 updated_at
            await session.execute(
                update(SessionModel)
                .where(SessionModel.id == session_id)
                .values(updated_at=datetime.now())
            )
            
            # 4. 统一提交事务
            await session.commit()
            
        except Exception as e:
            await session.rollback()
            logging.error(f"Atomic upsert failed, transaction rolled back: {e}")
            raise


async def add_log(session_id: str, event_type: str, content: Dict[str, Any]):
    try:
        async with AsyncSessionLocal() as session:
            session.add(EventLogModel(
                session_id=session_id,
                event_type=event_type,
                content=content,
                timestamp=datetime.now() # Using datetime object, model will convert
            ))
            await session.commit()
    except Exception as e:
        print(f"Error adding log to DB: {e}")
        import traceback
        traceback.print_exc()

# --- Intervention CRUD Operations ---
async def create_intervention_request(req_id: str, session_id: str, req_type: str, request_data: Dict[str, Any]):
    async with AsyncSessionLocal() as session:
        intervention = InterventionModel(
            id=req_id,
            session_id=session_id,
            type=req_type,
            status="pending",
            request_data=request_data,
            created_at=datetime.now(),
            updated_at=datetime.now()
        )
        session.add(intervention)
        await session.commit()
        await session.refresh(intervention)
        return intervention

async def get_intervention_request(req_id: str) -> Optional[InterventionModel]:
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(InterventionModel).where(InterventionModel.id == req_id)
        )
        return result.scalar_one_or_none()

async def get_pending_intervention_request(session_id: str) -> Optional[InterventionModel]:
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(InterventionModel)
            .where(InterventionModel.session_id == session_id, InterventionModel.status == "pending")
            .order_by(InterventionModel.created_at.desc()) # Get the latest pending request
        )
        return result.scalar_one_or_none()

async def update_intervention_response(req_id: str, status: str, response_data: Dict[str, Any] = None):
    async with AsyncSessionLocal() as session:
        await session.execute(
            update(InterventionModel)
            .where(InterventionModel.id == req_id)
            .values(status=status, response_data=response_data, updated_at=datetime.now())
        )
        await session.commit()

# --- Helper for background tasks ---

def schedule_coroutine(coro):
    """Schedule a coroutine to run in the background threadsafe."""
    try:
        loop = asyncio.get_running_loop()
        task = loop.create_task(coro)
        def handle_result(t):
            try:
                t.result()
            except Exception as e:
                print(f"Background task failed: {e}")
                import traceback
                traceback.print_exc()
        task.add_done_callback(handle_result)
    except RuntimeError:
        # No running loop (shouldn't happen in Agent execution, but safe fallback)
        pass